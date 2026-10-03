# Only the existing runner's owned PG cluster. Real HTTPoison + Node HTTP;
# provider/readiness and authenticated ConnTest entry remain explicit seams.
defmodule Ret.LocalSqlHttpTest do
  use ExUnit.Case, async: false
  import Phoenix.ConnTest, only: [build_conn: 0, post: 3, response: 2, json_response: 2]
  import Ret.TestHelpers
  alias Ret.{AppConfig, BotChatPresence, BotConfigApproval, BotRunnerLease, Repo}
  alias Ecto.Adapters.SQL.Sandbox
  @endpoint RetWeb.Endpoint

  setup do
    assert System.fetch_env!("RET_LOCAL_PROFILE") in [
             "sql-http-canary",
             "sql-http-reentry",
             "sql-http-periodic"
           ]

    :ok = Sandbox.checkout(Repo, sandbox: false)
    config = Application.fetch_env!(:ret, AppConfig)
    Application.put_env(:ret, AppConfig, Keyword.put(config, :caching?, true))

    for key <- ["features|enable_room_bots", "features|enable_bot_chat"],
        do: AppConfig.set_config_value(key, true)

    {:commit, warm} = AppConfig.fetch_config("")
    assert {:ok, true} = Cachex.put(:app_config, "", warm)
    assert warm["features"]["enable_bot_chat"] === true

    on_exit(fn ->
      Cachex.del(:app_config, "")
      Application.put_env(:ret, AppConfig, config)
    end)

    {:ok, warm: warm}
  end

  case System.fetch_env!("RET_LOCAL_PROFILE") do
    "sql-http-periodic" ->
      @tag timeout: 90_000
      test(
        "committed bots OFF reaches Node only through its real periodic HTTP sync",
        %{warm: warm},
        do: run_case("bots-off-periodic", warm)
      )

    "sql-http-reentry" ->
      test("unobserved committed SQL OFF ON rejects an old real HTTP reply", %{warm: warm},
        do: run_case("chat-off-on", warm)
      )

    _ ->
      test("real SQL HTTP control completes a held provider reply", %{warm: warm},
        do: run_case("positive", warm)
      )

      test("committed SQL OFF cancels real held provider HTTP before cleanup", %{warm: warm},
        do: run_case("chat-off", warm)
      )
  end

  defp run_case(kind, warm) do
    owner = self()
    owner_sql = sql_pid()
    account = create_account("owned-sql-http-#{System.unique_integer([:positive])}")
    {:ok, hub: hub} = create_hub(%{scene: create_scene(account)})

    bots = %{
      "enabled" => true,
      "chat_enabled" => true,
      "count" => 1,
      "mobility" => "static",
      "prompt" => ""
    }

    hub = hub |> Ecto.Changeset.change(user_data: %{"bots" => bots}) |> Repo.update!()

    Repo.insert!(%BotConfigApproval{
      hub_id: hub.hub_id,
      state: "approved",
      candidate_bots: bots,
      approved_bots: bots,
      runtime_revision: 1,
      approved_by_account_id: account.account_id,
      approved_at: DateTime.utc_now()
    })

    capability = Ecto.UUID.generate()

    claims = %{
      "v" => 1,
      "aud" => "yenhubs-bot-runner",
      "hub_sid" => hub.hub_sid,
      "process_generation" => Ecto.UUID.generate(),
      "holder_id" => Ecto.UUID.generate(),
      "recovery_epoch" => "44444444-4444-4444-8444-444444444444",
      "exp" => System.system_time(:second) + 300
    }

    assert :ok = BotChatPresence.track(owner, hub.hub_sid, account.account_id, capability)
    {:ok, lease} = BotRunnerLease.register_for_session(hub.hub_sid, Ecto.UUID.generate(), claims)
    :ok = RetWeb.Endpoint.subscribe("hub:#{hub.hub_sid}")
    :ok = RetWeb.Endpoint.subscribe("ret:product_modules")
    revision = BotChatPresence.revision()
    real_http = Application.fetch_env!(:ret, Ret.BotOrchestrator)
    refute Keyword.has_key?(real_http, :http_client)
    denied_port = System.fetch_env!("RET_LOCAL_DENIED_PORT") |> String.to_integer()

    assert {:error, _} =
             :gen_tcp.connect({127, 0, 0, 1}, denied_port, [:binary, active: false], 300)

    signal(kind, "setup", %{
      hub_sid: hub.hub_sid,
      bots: bots,
      real_http_client: true,
      denied: true
    })

    # Only this new case waits for two real 30s timer phases. Existing native
    # handshakes and the product's 15s/18s chat deadlines remain unchanged.
    if kind == "bots-off-periodic", do: handshake("ready", 60_000), else: handshake("ready")

    request =
      own_sql_task(fn ->
        send(owner, {:owned_request_started, self(), sql_pid()})

        build_conn()
        |> auth_with_account(account)
        |> post("/api/v1/hubs/#{hub.hub_sid}/bots/bot-1/chat", %{
          message: "hola",
          bot_chat_capability: capability
        })
      end)

    try do
      assert_receive {:owned_request_started, pid, request_sql}, 2000
      assert pid == request.pid and request_sql != owner_sql
      signal(kind, "request-started", %{distinct_sql_owners: true})
      handshake("model-held")
      assert Task.yield(request, 0) == nil

      if kind in ["chat-off", "bots-off-periodic"] do
        key =
          if kind == "bots-off-periodic",
            do: "features|enable_room_bots",
            else: "features|enable_bot_chat"

        transition =
          own_sql_task(fn ->
            pid = sql_pid()

            if kind == "bots-off-periodic" do
              # The earlier entry expired normally while waiting for ticks.
              # Model a late ON fill BEFORE COMMIT with the unchanged 10s TTL.
              assert warm["features"]["enable_room_bots"] === true
              assert warm["features"]["enable_bot_chat"] === true
              assert {:ok, true} = Cachex.put(:app_config, "", warm)
              assert {:ok, ^warm} = Cachex.get(:app_config, "")
            end

            AppConfig.set_config_value(key, false)
            {pid, Repo.get_by!(AppConfig, key: key).value}
          end)

        try do
          {off_sql, value} = Task.await(transition, 2000)
          assert value == %{"value" => false}
          assert length(Enum.uniq([owner_sql, request_sql, off_sql])) == 3
          assert Repo.get_by!(AppConfig, key: key).value == value
          refute Ret.ProductModules.ai_enabled?()
          if kind == "bots-off-periodic", do: refute(Ret.ProductModules.bots_enabled?())
          assert BotChatPresence.revision() > revision
          assert {:ok, ^warm} = Cachex.get(:app_config, "")

          bots_enabled = kind != "bots-off-periodic"

          assert_receive %Phoenix.Socket.Broadcast{
            event: "product_modules_changed",
            payload: %{bots_enabled: ^bots_enabled, ai_enabled: false}
          }

          assert Task.yield(request, 0) == nil

          data = %{
            sql_committed_off: true,
            three_distinct_sql_owners: true,
            raw_cache_still_on: true,
            request_pending: true
          }

          data =
            if kind == "bots-off-periodic",
              do: Map.put(data, :sql_committed_bots_off, true),
              else: data

          signal(kind, "transition", data)

          if kind == "bots-off-periodic",
            do: handshake("off-periodic-observed", 15_000),
            else: handshake("off-synced")

          if kind == "bots-off-periodic" do
            assert {:ok, ^warm} = Cachex.get(:app_config, "")
          end
        after
          stop_task(transition)
        end
      else
        if kind == "chat-off-on" do
          transition =
            own_sql_task(fn ->
              pid = sql_pid()
              AppConfig.set_config_value("features|enable_bot_chat", false)

              assert Repo.get_by!(AppConfig, key: "features|enable_bot_chat").value == %{
                       "value" => false
                     }

              refute Ret.ProductModules.ai_enabled?()
              AppConfig.set_config_value("features|enable_bot_chat", true)
              {pid, Repo.get_by!(AppConfig, key: "features|enable_bot_chat").value}
            end)

          try do
            {transition_sql, value} = Task.await(transition, 2000)
            assert value == %{"value" => true}
            assert length(Enum.uniq([owner_sql, request_sql, transition_sql])) == 3
            assert Repo.get_by!(AppConfig, key: "features|enable_bot_chat").value == value
            assert Ret.ProductModules.ai_enabled?()
            assert BotChatPresence.revision() >= revision + 2
            assert {:ok, ^warm} = Cachex.get(:app_config, "")

            assert_receive %Phoenix.Socket.Broadcast{
              event: "product_modules_changed",
              payload: %{bots_enabled: true, ai_enabled: false}
            }

            assert_receive %Phoenix.Socket.Broadcast{
              event: "product_modules_changed",
              payload: %{bots_enabled: true, ai_enabled: true}
            }

            assert Task.yield(request, 0) == nil

            signal(kind, "transition", %{
              sql_committed_off_then_on: true,
              three_distinct_sql_owners: true,
              raw_cache_still_on: true,
              old_policy_revision_invalid: true,
              request_pending: true
            })
          after
            stop_task(transition)
          end
        else
          signal(kind, "transition", %{request_pending: true})
        end

        handshake("released")
      end

      conn = Task.await(request, 5000)

      if kind == "positive" do
        assert json_response(conn, 200) == %{"reply" => "owned integrated reply", "action" => nil}
      else
        if kind == "chat-off-on" do
          assert response(conn, 403) == "bot chat is disabled for this room"
          assert Ret.ProductModules.ai_enabled?()
          assert BotChatPresence.revision() >= revision + 2
        else
          assert response(conn, 502) == "bot service unavailable"
        end

        refute String.contains?(conn.resp_body, "owned integrated reply")
      end

      refute_receive %Phoenix.Socket.Broadcast{event: "message"}, 100

      data = %{
        status: conn.status,
        no_command: true,
        no_old_reply: kind != "positive"
      }

      data =
        if kind == "bots-off-periodic",
          do: Map.put(data, :raw_cache_still_on_after_periodic_get, true),
          else: data

      signal(kind, "verified", data)

      handshake("verified")
    after
      stop_task(request)
      assert :ok = BotRunnerLease.unregister(hub.hub_sid, lease.lease_id)
      assert :ok = BotChatPresence.untrack(owner)

      hub
      |> Ecto.Changeset.change(user_data: %{"bots" => Map.put(bots, "enabled", false)})
      |> Repo.update!()
    end
  end

  defp signal(kind, stage, data) do
    IO.puts(
      "\nSQL_HTTP_SIGNAL:" <> Poison.encode!(Map.merge(data, %{kind: stage, test_case: kind}))
    )
  end

  defp handshake(stage, timeout \\ 5000) do
    task = Task.async(fn -> IO.gets("") end)

    try do
      assert Task.await(task, timeout) == "OWNED_SQL_HTTP:#{stage}\n"
    after
      stop_task(task)
    end
  end

  defp own_sql_task(fun) do
    Task.async(fn ->
      :ok = Sandbox.checkout(Repo, sandbox: false)

      try do
        fun.()
      after
        Sandbox.checkin(Repo)
      end
    end)
  end

  defp sql_pid,
    do: Ecto.Adapters.SQL.query!(Repo, "SELECT pg_backend_pid()", []).rows |> hd() |> hd()

  defp stop_task(task) do
    if Process.alive?(task.pid), do: Task.shutdown(task, :brutal_kill)
  end
end
