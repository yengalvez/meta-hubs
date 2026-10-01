# Only the owned synthetic cluster created by reticulum-local.mjs is a target.
# Separate BEAM tasks own separate, UNSANDBOXED SQL transactions: fixtures
# commit here, not on a shared ExUnit connection. The entire DB is disposable.
# The HTTP reply gate is synthetic; this does not prove a network abort.
defmodule Ret.LocalConcurrentChatTest do
  use ExUnit.Case, async: false
  import Phoenix.ConnTest, only: [build_conn: 0, post: 3, response: 2, json_response: 2]
  import Ret.TestHelpers

  alias Ret.{AppConfig, BotChatPresence, BotConfigApproval, BotRunnerLease, Repo}
  alias Ecto.Adapters.SQL.Sandbox
  @endpoint RetWeb.Endpoint

  defmodule HeldHttpClient do
    def request(
          :post,
          "http://bot-orchestrator.test/internal/bots/chat",
          _body,
          _headers,
          options
        ) do
      %{owner: owner, gate: gate} = Application.fetch_env!(:ret, __MODULE__)
      %{rows: [[sql_pid]]} = Ecto.Adapters.SQL.query!(Repo, "SELECT pg_backend_pid()", [])
      send(owner, {:owned_chat_held, gate, self(), sql_pid, options})

      receive do
        {:release_owned_chat, ^gate} ->
          {:ok,
           %HTTPoison.Response{
             status_code: 200,
             body:
               Poison.encode!(%{
                 reply: "held synthetic reply",
                 action: %{type: "go_to_waypoint", waypoint: "spawbot-stage"}
               })
           }}
      after
        10_000 -> raise "owned synthetic reply gate timed out"
      end
    end
  end

  setup do
    :ok = Sandbox.checkout(Repo, sandbox: false)
    # No shared mode: both request and OFF tasks check out distinct SQL owners.
    AppConfig.set_config_value("features|enable_room_bots", true)
    AppConfig.set_config_value("features|enable_bot_chat", true)
    :ok
  end

  cases =
    case System.fetch_env!("RET_LOCAL_PROFILE") do
      "chat-concurrent" -> [:none, :chat_off]
      "chat-concurrent-boundaries" -> [:bots_off, :off_on, :quarantine, :presence]
      _ -> raise "explicit concurrent profile required"
    end

  for interruption <- cases do
    test "separate SQL owners complete #{interruption} before releasing a held reply" do
      run_held_reply(unquote(interruption))
    end
  end

  defp run_held_reply(interruption) do
    owner = self()
    gate = make_ref()
    capability = Ecto.UUID.generate()
    account = create_account("owned-concurrent-#{System.unique_integer([:positive])}")
    {:ok, hub: hub} = create_hub(%{scene: create_scene(account)})

    hub =
      hub
      |> Ecto.Changeset.change(
        user_data: %{
          "bots" => %{
            "enabled" => true,
            "chat_enabled" => true,
            "count" => 1,
            "mobility" => "static",
            "prompt" => ""
          }
        }
      )
      |> Repo.update!()

    bots = hub.user_data["bots"]

    Repo.insert!(%BotConfigApproval{
      hub_id: hub.hub_id,
      state: "approved",
      candidate_bots: bots,
      approved_bots: bots,
      runtime_revision: 1,
      approved_by_account_id: account.account_id,
      approved_at: DateTime.utc_now()
    })

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

    {:ok, lease} =
      BotRunnerLease.register_for_session(hub.hub_sid, Ecto.UUID.generate(), claims)

    previous_orchestrator = Application.get_env(:ret, Ret.BotOrchestrator)
    previous_client = Application.get_env(:ret, HeldHttpClient)

    Application.put_env(:ret, Ret.BotOrchestrator,
      endpoint: "http://bot-orchestrator.test",
      access_key: String.duplicate("k", 32),
      http_client: HeldHttpClient
    )

    Application.put_env(:ret, HeldHttpClient, %{owner: owner, gate: gate})

    on_exit(fn ->
      restore_env(Ret.BotOrchestrator, previous_orchestrator)
      restore_env(HeldHttpClient, previous_client)
      BotChatPresence.untrack(owner)
    end)

    :ok = RetWeb.Endpoint.subscribe("hub:#{hub.hub_sid}")
    :ok = RetWeb.Endpoint.subscribe("ret:product_modules")
    owner_sql_pid = sql_pid()
    initial_revision = BotChatPresence.revision()

    request =
      own_sql_task(fn ->
        build_conn()
        |> auth_with_account(account)
        |> post("/api/v1/hubs/#{hub.hub_sid}/bots/bot-1/chat", %{
          message: "ve al escenario",
          bot_chat_capability: capability
        })
      end)

    try do
      assert_receive {:owned_chat_held, ^gate, request_pid, request_sql_pid, options}, 3_000
      assert request_pid == request.pid
      assert request_sql_pid != owner_sql_pid
      assert options[:timeout] == 18_000
      assert options[:recv_timeout] == 18_000
      assert Task.yield(request, 0) == nil

      # A third committed SQL connection may take/release the product admission
      # lock WHILE the provider callback is held. A shared sandbox transaction
      # would hide real lock ownership; this probe rejects that false positive.
      <<lock_key::little-signed-integer-size(64), _::binary>> =
        :crypto.hash(:sha256, BotConfigApproval.admission_lock())

      assert {:ok, true} =
               Repo.transaction(fn ->
                 %{rows: [[available]]} =
                   Ecto.Adapters.SQL.query!(Repo, "SELECT pg_try_advisory_xact_lock($1)", [
                     lock_key
                   ])

                 available
               end)

      if interruption == :chat_off do
        off =
          own_sql_task(fn ->
            pid = sql_pid()
            AppConfig.set_config_value("features|enable_bot_chat", false)
            value = Repo.get_by!(AppConfig, key: "features|enable_bot_chat").value
            {pid, value}
          end)

        try do
          # The reply cannot be released until OFF's transaction has returned.
          {off_sql_pid, value} = Task.await(off, 2_000)
          assert length(Enum.uniq([owner_sql_pid, request_sql_pid, off_sql_pid])) == 3
          assert value == %{"value" => false}
          assert Repo.get_by!(AppConfig, key: "features|enable_bot_chat").value == value
          refute Ret.ProductModules.ai_enabled?()
          assert BotChatPresence.revision() > initial_revision

          assert_receive %Phoenix.Socket.Broadcast{
            event: "product_modules_changed",
            payload: %{bots_enabled: true, ai_enabled: false}
          }
        after
          stop_owned_task(off)
        end
      end

      if interruption in [:bots_off, :off_on, :quarantine, :presence] do
        transition =
          own_sql_task(fn ->
            pid = sql_pid()
            perform_boundary!(interruption, hub, owner)
            pid
          end)

        try do
          transition_sql_pid = Task.await(transition, 2_000)
          assert length(Enum.uniq([owner_sql_pid, request_sql_pid, transition_sql_pid])) == 3
          assert_boundary!(interruption, hub, account, capability, initial_revision)
        after
          stop_owned_task(transition)
        end
      end

      assert Task.yield(request, 0) == nil
      refute_receive %Phoenix.Socket.Broadcast{event: "message"}, 50
      send(request.pid, {:release_owned_chat, gate})
      conn = Task.await(request, 3_000)

      if interruption == :none do
        assert json_response(conn, 200) == %{
                 "reply" => "held synthetic reply",
                 "action" => %{"type" => "go_to_waypoint", "waypoint" => "spawbot-stage"}
               }

        assert_receive %Phoenix.Socket.Broadcast{
          event: "message",
          payload: %{
            type: "bot_command",
            body: %{
              "bot_id" => "bot-1",
              "type" => "go_to_waypoint",
              "waypoint" => "spawbot-stage"
            },
            bot_runner_lease_id: lease_id,
            bot_runner_authority_epoch: authority_epoch
          }
        }

        assert lease_id == lease.lease_id
        assert authority_epoch == lease.authority_epoch
      else
        if interruption == :chat_off do
          assert response(conn, 403) == "bot chat is disabled for this room"
        else
          expected =
            case interruption do
              :off_on -> "bot chat is disabled for this room"
              :presence -> "not present in room"
              kind when kind in [:bots_off, :quarantine] -> "bot configuration is not approved"
            end

          assert response(conn, 403) == expected
        end

        refute_receive %Phoenix.Socket.Broadcast{event: "message"}, 100
      end

      assert :ok = BotRunnerLease.unregister(hub.hub_sid, lease.lease_id)
      assert :ok = BotChatPresence.untrack(owner)
    after
      stop_owned_task(request)
    end
  end

  defp perform_boundary!(:bots_off, _hub, _owner) do
    AppConfig.set_config_value("features|enable_room_bots", false)
    assert Repo.get_by!(AppConfig, key: "features|enable_room_bots").value == %{"value" => false}
  end

  defp perform_boundary!(:off_on, _hub, _owner) do
    AppConfig.set_config_value("features|enable_bot_chat", false)
    assert Repo.get_by!(AppConfig, key: "features|enable_bot_chat").value == %{"value" => false}
    AppConfig.set_config_value("features|enable_bot_chat", true)
    assert Repo.get_by!(AppConfig, key: "features|enable_bot_chat").value == %{"value" => true}
  end

  defp perform_boundary!(:quarantine, hub, _owner) do
    admin = create_account("owned-quarantine-#{System.unique_integer([:positive])}", true)
    assert {:ok, _hub} = BotConfigApproval.quarantine(hub.hub_sid, admin)
    assert Repo.get!(BotConfigApproval, hub.hub_id).state == "quarantined"
  end

  defp perform_boundary!(:presence, _hub, owner), do: BotChatPresence.untrack(owner)

  defp assert_boundary!(:bots_off, _hub, _account, _capability, revision) do
    assert Repo.get_by!(AppConfig, key: "features|enable_room_bots").value == %{"value" => false}
    refute Ret.ProductModules.bots_enabled?()
    refute Ret.ProductModules.ai_enabled?()
    assert BotChatPresence.revision() > revision

    assert_receive %Phoenix.Socket.Broadcast{
      event: "product_modules_changed",
      payload: %{bots_enabled: false, ai_enabled: false}
    }
  end

  defp assert_boundary!(:off_on, _hub, _account, _capability, revision) do
    assert Repo.get_by!(AppConfig, key: "features|enable_bot_chat").value == %{"value" => true}
    assert Ret.ProductModules.ai_enabled?()
    assert BotChatPresence.revision() >= revision + 2

    assert_receive %Phoenix.Socket.Broadcast{
      event: "product_modules_changed",
      payload: %{bots_enabled: true, ai_enabled: false}
    }

    assert_receive %Phoenix.Socket.Broadcast{
      event: "product_modules_changed",
      payload: %{bots_enabled: true, ai_enabled: true}
    }
  end

  defp assert_boundary!(:quarantine, hub, _account, _capability, _revision) do
    assert Repo.get!(BotConfigApproval, hub.hub_id).state == "quarantined"
  end

  defp assert_boundary!(:presence, hub, account, capability, revision) do
    refute BotChatPresence.present?(hub.hub_sid, account.account_id, capability)
    assert BotChatPresence.revision() == revision
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

  defp sql_pid do
    %{rows: [[pid]]} = Ecto.Adapters.SQL.query!(Repo, "SELECT pg_backend_pid()", [])
    pid
  end

  defp stop_owned_task(task) do
    if Process.alive?(task.pid), do: Task.shutdown(task, :brutal_kill)
  end

  defp restore_env(key, nil), do: Application.delete_env(:ret, key)
  defp restore_env(key, value), do: Application.put_env(:ret, key, value)
end
