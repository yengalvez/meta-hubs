# Exactly two new cases in the verified private PG cluster. Product admission,
# SQL Store, supervised dispatcher, HTTPoison and Node HTTP stay real. Only the
# owned local runner/readiness is synthetic; there is no Kubernetes absence ACK.
defmodule Ret.LocalStopDrainTest do
  use ExUnit.Case, async: false
  import Ret.TestHelpers
  import Ecto.Query
  alias Ecto.Adapters.SQL.Sandbox

  alias Ret.{
    AppConfig,
    BotConfigAdmission,
    BotConfigApproval,
    BotRuntimeOutbox,
    BotRuntimeOutboxDispatcher,
    Hub,
    Repo
  }

  alias Ret.BotRuntimeOutbox.Store

  setup do
    assert System.fetch_env!("RET_LOCAL_PROFILE") == "sql-http-stop-drain"
    :ok = Sandbox.checkout(Repo, sandbox: false)
    config = Application.fetch_env!(:ret, AppConfig)
    Application.put_env(:ret, AppConfig, Keyword.put(config, :caching?, true))
    AppConfig.set_config_value("features|enable_room_bots", true)
    AppConfig.set_config_value("features|enable_bot_chat", true)
    {:commit, warm} = AppConfig.fetch_config("")
    assert {:ok, true} = Cachex.put(:app_config, "", warm)
    assert warm["features"]["enable_room_bots"] === true
    refute Keyword.has_key?(Application.fetch_env!(:ret, Ret.BotOrchestrator), :http_client)
    assert Ret.ProductModules.installed?(:bots)
    assert BotRuntimeOutboxDispatcher in Ret.ProductModules.bot_children()
    assert_dispatcher(Process.whereis(BotRuntimeOutboxDispatcher))
    denied_port = System.fetch_env!("RET_LOCAL_DENIED_PORT") |> String.to_integer()

    assert {:error, _} =
             :gen_tcp.connect({127, 0, 0, 1}, denied_port, [:binary, active: false], 300)

    on_exit(fn ->
      Cachex.del(:app_config, "")
      Application.put_env(:ret, AppConfig, config)
    end)

    {:ok, warm: warm}
  end

  test "committed bots OFF drains a real owned child through authenticated sync", %{warm: warm} do
    {admin, hub, bots, config_event} = admitted_room()
    owner_sql = sql_pid()

    signal("bots-off-child", "setup", %{
      hub_sid: hub.hub_sid,
      bots: bots,
      real_http_client: true,
      denied: true,
      real_admission: true,
      config_delivered: true
    })

    handshake("ready")
    event_count = Repo.aggregate(BotRuntimeOutbox, :count, :id)

    transition =
      own_sql_task(fn ->
        AppConfig.set_config_value("features|enable_room_bots", false)
        {sql_pid(), Repo.get_by!(AppConfig, key: "features|enable_room_bots").value}
      end)

    try do
      {off_sql, value} = Task.await(transition, 2000)
      assert off_sql != owner_sql
      assert value == %{"value" => false}
      assert Repo.get_by!(AppConfig, key: "features|enable_room_bots").value == value
      refute Ret.ProductModules.bots_enabled?()
      refute Ret.ProductModules.ai_enabled?()
      assert {:ok, ^warm} = Cachex.get(:app_config, "")
      # Runtime OFF suspends admission but does not manufacture a SQL STOP.
      assert Repo.aggregate(BotRuntimeOutbox, :count, :id) == event_count
      assert Repo.get!(BotConfigApproval, hub.hub_id).state == "approved"
      assert Repo.get!(BotRuntimeOutbox, config_event.id).delivered_at
      assert_dispatcher(Process.whereis(BotRuntimeOutboxDispatcher))

      signal("bots-off-child", "off-committed", %{
        sql_committed_off: true,
        distinct_sql_owners: true,
        raw_cache_still_on: true,
        no_sql_stop_from_global_off: true
      })

      handshake("off-synced-and-exited")
      assert Repo.get!(Hub, hub.hub_id).user_data["bots"] == bots
      assert Repo.get!(BotConfigApproval, hub.hub_id).approved_by_account_id == admin.account_id
      signal("bots-off-child", "verified", %{no_sql_stop_from_global_off: true})
      handshake("verified")
    after
      stop_task(transition)
    end
  end

  test "product room close remains pending and retries across a real dispatcher restart" do
    {admin, hub, bots, config_event} = admitted_room()

    signal("durable-stop-pending", "setup", %{
      hub_sid: hub.hub_sid,
      bots: bots,
      real_http_client: true,
      denied: true,
      real_admission: true,
      config_delivered: true
    })

    handshake("producer-ready")
    dispatcher = Process.whereis(BotRuntimeOutboxDispatcher)
    old_state = assert_dispatcher(dispatcher)
    AppConfig.set_config_value("features|enable_room_bots", false)
    refute Ret.ProductModules.bots_enabled?()
    assert Process.whereis(BotRuntimeOutboxDispatcher) == dispatcher
    assert Process.alive?(dispatcher)

    # Actual product close transaction: approval revision, revoke epoch and
    # immutable STOP commit together. No direct enqueue or row mutation.
    assert {:ok, closed} =
             hub |> Ecto.Changeset.change(entry_mode: :deny) |> BotConfigAdmission.update(admin)

    assert closed.entry_mode == :deny
    approval = Repo.get!(BotConfigApproval, hub.hub_id)
    assert approval.state == "quarantined"
    assert approval.last_quarantine_reason == "room_closed"
    assert approval.runtime_revision == config_event.runtime_revision + 1

    event =
      Repo.one!(
        from(o in BotRuntimeOutbox,
          where: o.hub_id == ^hub.hub_id and o.event_kind == "stop"
        )
      )

    assert event.hub_sid == hub.hub_sid
    assert event.runtime_revision == approval.runtime_revision
    assert event.revoke_epoch > 0
    assert event.bots == nil and event.runtime_chat_enabled == nil
    identity = immutable_identity(event)
    first = await_retry(event.id, 1)
    assert first.attempt_count == 1
    assert_pending(first, identity)
    assert future_retry?(first.id)
    # Real SQL cannot claim while the product's first 1s backoff is pending.
    assert :empty = Store.claim_next(Ecto.UUID.generate())

    monitor = Process.monitor(dispatcher)
    assert :ok = Supervisor.terminate_child(Ret.Supervisor, BotRuntimeOutboxDispatcher)
    assert_receive {:DOWN, ^monitor, :process, ^dispatcher, :shutdown}, 2000
    refute Process.alive?(dispatcher)
    preserved = Repo.get!(BotRuntimeOutbox, event.id)
    assert preserved == first
    assert {:ok, restarted} = Supervisor.restart_child(Ret.Supervisor, BotRuntimeOutboxDispatcher)
    assert restarted != dispatcher
    new_state = assert_dispatcher(restarted)
    assert new_state.claim_owner != old_state.claim_owner
    assert Repo.get!(BotRuntimeOutbox, event.id) == preserved
    second = await_retry(event.id, 2)
    assert second.attempt_count == 2
    assert_pending(second, identity)
    assert DateTime.compare(second.next_attempt_at, first.next_attempt_at) == :gt
    assert future_retry?(second.id)
    assert Process.whereis(BotRuntimeOutboxDispatcher) == restarted
    assert Process.alive?(restarted)

    signal(
      "durable-stop-pending",
      "verified",
      Map.merge(identity, %{
        status: 202,
        delivered_at_null: true,
        attempts: second.attempt_count,
        actual_dispatcher_restart: true,
        distinct_claim_owners: true,
        backoff_preserved: true,
        dispatcher_installed_while_off: true
      })
    )

    handshake("verified")
    # The event deliberately stays pending for an authorized absence proof.
    pending = Repo.get!(BotRuntimeOutbox, event.id)
    assert immutable_identity(pending) == identity
    assert pending.delivered_at == nil
  end

  defp admitted_room do
    admin = create_account("owned-stop-drain-#{System.unique_integer([:positive])}", true)
    scene = create_scene(admin)

    bots = %{
      "enabled" => true,
      "chat_enabled" => true,
      "count" => 1,
      "mobility" => "static",
      "prompt" => ""
    }

    assert {:ok, hub} =
             %Hub{}
             |> Hub.changeset(scene, %{
               name: "Owned native STOP room",
               user_data: %{"bots" => bots}
             })
             |> Hub.add_account_to_changeset(admin)
             |> BotConfigAdmission.insert(admin)

    approval = Repo.get!(BotConfigApproval, hub.hub_id)
    assert approval.state == "approved"
    assert approval.approved_bots == bots
    assert approval.runtime_revision == 1

    event =
      Repo.one!(
        from(o in BotRuntimeOutbox,
          where: o.hub_id == ^hub.hub_id and o.event_kind == "config"
        )
      )

    assert event.runtime_revision == 1

    delivered =
      eventually(fn ->
        row = Repo.get!(BotRuntimeOutbox, event.id)
        if row.delivered_at, do: row
      end)

    assert immutable_identity(delivered) == immutable_identity(event)
    assert delivered.attempt_count >= 1
    {admin, hub, bots, delivered}
  end

  defp assert_dispatcher(pid) do
    assert is_pid(pid) and Process.alive?(pid)
    state = :sys.get_state(pid)
    assert state.enabled === true
    assert state.store_module == Store
    assert state.delivery_module == Ret.BotOrchestrator
    assert state.claim_ttl_seconds == 30
    assert state.retry_base_seconds == 1 and state.retry_max_seconds == 60
    state
  end

  defp immutable_identity(event),
    do:
      Map.take(
        event,
        [
          :operation_id,
          :hub_id,
          :hub_sid,
          :runtime_revision,
          :event_kind,
          :bots,
          :runtime_chat_enabled,
          :revoke_epoch
        ]
      )

  defp assert_pending(event, identity) do
    assert immutable_identity(event) == identity
    assert event.delivered_at == nil
    assert event.last_failure_code == "accepted_pending"
    assert event.claim_owner == nil and event.claim_token == nil and event.claim_expires_at == nil
  end

  defp future_retry?(id) do
    [[future]] =
      Ecto.Adapters.SQL.query!(
        Repo,
        "SELECT next_attempt_at > timezone('UTC', clock_timestamp()) FROM ret0.bot_runtime_outbox WHERE id = $1",
        [id]
      ).rows

    future
  end

  defp await_retry(id, count),
    do:
      eventually(fn ->
        event = Repo.get!(BotRuntimeOutbox, id)

        if event.attempt_count >= count and event.claim_token == nil and
             event.last_failure_code == "accepted_pending",
           do: event
      end)

  defp eventually(fun), do: eventually(fun, System.monotonic_time(:millisecond) + 5000)

  defp eventually(fun, deadline) do
    case fun.() do
      value when value not in [false, nil] ->
        value

      _ ->
        assert System.monotonic_time(:millisecond) < deadline
        Process.sleep(10)
        eventually(fun, deadline)
    end
  end

  defp signal(kind, stage, data),
    do:
      IO.puts(
        "\nSQL_HTTP_SIGNAL:" <>
          Poison.encode!(Map.merge(data, %{kind: stage, test_case: kind}))
      )

  defp handshake(stage) do
    task = Task.async(fn -> IO.gets("") end)

    try do
      assert Task.await(task, 5000) == "OWNED_SQL_HTTP:#{stage}\n"
    after
      stop_task(task)
    end
  end

  defp own_sql_task(fun),
    do:
      Task.async(fn ->
        :ok = Sandbox.checkout(Repo, sandbox: false)

        try do
          fun.()
        after
          Sandbox.checkin(Repo)
        end
      end)

  defp sql_pid,
    do: Ecto.Adapters.SQL.query!(Repo, "SELECT pg_backend_pid()", []).rows |> hd() |> hd()

  defp stop_task(task), do: if(Process.alive?(task.pid), do: Task.shutdown(task, :brutal_kill))
end
