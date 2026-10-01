# Executed in a fresh, confined OS/BEAM process for EACH installed profile.
# This is real native Reticulum/SQL/HubChannel, not a public browser, provider,
# bot navigation, complete isolated deployment or rollback acceptance.
defmodule Ret.LocalProfileRuntimeTest do
  use ExUnit.Case, async: false
  import Phoenix.ChannelTest
  import Phoenix.ConnTest, only: [build_conn: 0, post: 3, response: 2]
  import Ret.TestHelpers

  alias Ret.{AppConfig, BotChatPresence, ProductModules, Repo}
  alias RetWeb.SessionSocket
  @endpoint RetWeb.Endpoint

  setup do
    :ok = Ecto.Adapters.SQL.Sandbox.checkout(Repo)
    Ecto.Adapters.SQL.Sandbox.mode(Repo, {:shared, self()})
    :ok
  end

  test "installed profile bounds real startup, SQL configuration, channel and runtime OFF" do
    modules = Application.fetch_env!(:ret, ProductModules)
    bots = Keyword.fetch!(modules, :bots)
    ai = Keyword.fetch!(modules, :ai)
    avaturn = Keyword.fetch!(modules, :avaturn)

    expected = [RetWeb.Endpoint, RetWeb.Presence]
    expected = if bots, do: [Ret.BotRunnerLease | expected], else: expected
    expected = if ai, do: [BotChatPresence | expected], else: expected
    children = Supervisor.which_children(Ret.BotRuntimeSupervisor)
    assert Enum.sort(Enum.map(children, &elem(&1, 0))) == Enum.sort(expected)
    assert Enum.all?(children, &(is_pid(elem(&1, 1)) and Process.alive?(elem(&1, 1))))
    dispatcher = Process.whereis(Ret.BotRuntimeOutboxDispatcher)
    assert is_pid(dispatcher) == bots
    assert is_pid(Process.whereis(BotChatPresence)) == ai

    # Even persisted administrator ON flags cannot install a missing module.
    for key <- ["enable_room_bots", "enable_bot_chat", "enable_avaturn_creator"] do
      AppConfig.set_config_value("features|#{key}", true)
      assert Repo.get_by!(AppConfig, key: "features|#{key}").value == %{"value" => true}
    end

    AppConfig.set_config_value("links|avaturn_creator", "https://forged.invalid")
    projected = AppConfig.get_config(true)
    assert projected["features"]["enable_room_bots"] == bots
    assert projected["features"]["enable_bot_chat"] == ai
    assert projected["features"]["enable_avaturn_creator"] == avaturn

    assert projected["links"]["avaturn_creator"] ==
             if(avaturn, do: "https://virtualmente.avaturn.dev", else: "")

    assert ProductModules.require_bots() == if(bots, do: :ok, else: {:error, :bots_disabled})

    # A real SQL-backed room/account and authenticated Phoenix channel.
    account = create_account("private-profile-" <> System.fetch_env!("RET_LOCAL_PROFILE"))
    scene = create_scene(account)
    {:ok, hub: hub} = create_hub(%{scene: scene})
    {:ok, socket} = connect(SessionSocket, %{})

    {:ok, joined, socket} =
      subscribe_and_join(socket, "hub:#{hub.hub_sid}", join_params_for_account(account))

    assert_push("product_modules_changed", %{bots_enabled: ^bots, ai_enabled: ^ai})
    push(socket, "events:entered", %{})
    :sys.get_state(socket.channel_pid)

    assert BotChatPresence.present?(hub.hub_sid, account.account_id, joined.bot_chat_capability) ==
             ai

    revision = BotChatPresence.revision()
    AppConfig.set_config_value("features|enable_bot_chat", false)
    assert_push("product_modules_changed", %{bots_enabled: ^bots, ai_enabled: false})
    refute ProductModules.ai_enabled?()
    if ai, do: assert(BotChatPresence.revision() > revision)
    assert_chat_not_found(account, hub)

    AppConfig.set_config_value("features|enable_room_bots", false)
    assert_push("product_modules_changed", %{bots_enabled: false, ai_enabled: false})
    assert {:error, :bots_disabled} = ProductModules.require_bots()
    assert_chat_not_found(account, hub)

    # ON for chat cannot bypass bots OFF; restoring bots restores ONLY what
    # the installed profile permits. Runtime OFF must not kill the STOP drain.
    AppConfig.set_config_value("features|enable_bot_chat", true)
    assert_push("product_modules_changed", %{bots_enabled: false, ai_enabled: false})
    assert_chat_not_found(account, hub)
    AppConfig.set_config_value("features|enable_room_bots", true)
    assert_push("product_modules_changed", %{bots_enabled: ^bots, ai_enabled: ^ai})
    assert ProductModules.bots_enabled?() == bots
    assert ProductModules.ai_enabled?() == ai
    assert Process.whereis(Ret.BotRuntimeOutboxDispatcher) == dispatcher
    if bots, do: assert(Process.alive?(dispatcher))

    AppConfig.set_config_value("features|enable_avaturn_creator", false)
    refute AppConfig.get_config(true)["features"]["enable_avaturn_creator"]
    AppConfig.set_config_value("features|enable_avaturn_creator", true)
    assert AppConfig.get_config(true)["features"]["enable_avaturn_creator"] == avaturn
  end

  defp assert_chat_not_found(account, hub) do
    conn =
      build_conn()
      |> auth_with_account(account)
      |> post("/api/v1/hubs/#{hub.hub_sid}/bots/0/chat", %{"message" => "private test"})

    assert response(conn, 404) == "not found"
  end

  defp join_params_for_account(account) do
    {:ok, token, _claims} = Ret.Guardian.encode_and_sign(account)
    %{"profile" => %{}, "context" => %{}, "auth_token" => token}
  end
end
