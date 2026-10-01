# ONLY the existing runner's owned synthetic database, never normal mix test.
# Real SQL, Cachex, authenticated API router and page-config serialization;
# no TCP/browser/provider, complete profile or Kubernetes acceptance implied.
defmodule Ret.LocalConfigCacheTest do
  use ExUnit.Case, async: false
  import Phoenix.ConnTest, only: [build_conn: 0, get: 2, json_response: 2]
  import Ret.TestHelpers, only: [create_account: 2, auth_with_account: 2]

  alias Ret.{AppConfig, ProductModules, Repo}
  @endpoint RetWeb.Endpoint

  setup do
    assert System.fetch_env!("RET_LOCAL_PROFILE") == "config-cache-canary"
    :ok = Ecto.Adapters.SQL.Sandbox.checkout(Repo, sandbox: false)
    # Fixtures commit in the disposable cluster; Cachex is process-wide, not
    # tied to a test's rollback transaction or stale rows from another suite.
    previous_cache = Application.fetch_env!(:ret, AppConfig)
    previous_page = Application.get_env(:ret, RetWeb.PageController, [])
    Application.put_env(:ret, AppConfig, Keyword.put(previous_cache, :caching?, true))

    Application.put_env(
      :ret,
      RetWeb.PageController,
      Keyword.put(previous_page, :skip_cache, false)
    )

    on_exit(fn ->
      Cachex.del(:app_config, "")
      Application.put_env(:ret, AppConfig, previous_cache)
      Application.put_env(:ret, RetWeb.PageController, previous_page)
    end)

    for feature <- ["enable_room_bots", "enable_bot_chat", "enable_avaturn_creator"] do
      AppConfig.set_config_value("features|#{feature}", true)
    end

    AppConfig.set_config_value("features|max_room_size", 50)
    {:commit, warm} = AppConfig.fetch_config("")
    assert {:ok, true} = Cachex.put(:app_config, "", warm)
    assert {:ok, ^warm} = Cachex.get(:app_config, "")
    assert warm["features"]["enable_bot_chat"] === true
    admin = create_account("owned-cache-#{System.unique_integer([:positive])}", true)
    {:ok, admin: admin, warm: warm}
  end

  test "warm API and page config preserve ON and the unrelated cached value", %{
    admin: admin,
    warm: warm
  } do
    assert ProductModules.ai_enabled?()
    # A fix must not disable the entire cache to refresh three runtime flags.
    AppConfig.set_config_value("features|max_room_size", 99)
    assert AppConfig.get_config_value("features|max_room_size") == 99
    assert {:ok, ^warm} = Cachex.get(:app_config, "")

    for config <- client_configs(admin) do
      assert config["features"]["enable_room_bots"] === true
      assert config["features"]["enable_bot_chat"] === true
      assert config["features"]["enable_avaturn_creator"] === true
      assert config["features"]["max_room_size"] == 50
    end
  end

  test "warm API and page config cannot advertise ON after committed AI OFF", %{
    admin: admin,
    warm: warm
  } do
    :ok = RetWeb.Endpoint.subscribe("ret:product_modules")
    AppConfig.set_config_value("features|enable_bot_chat", false)
    assert Repo.get_by!(AppConfig, key: "features|enable_bot_chat").value == %{"value" => false}
    refute ProductModules.ai_enabled?()

    assert_receive %Phoenix.Socket.Broadcast{
      event: "product_modules_changed",
      payload: %{bots_enabled: true, ai_enabled: false}
    }

    # Prove the old raw ON entry is still warm. No TTL sleep/cache clear is an
    # acceptance shortcut, and no simulated invalidation supplies this oracle.
    assert {:ok, ^warm} = Cachex.get(:app_config, "")

    for config <- client_configs(admin) do
      assert config["features"]["enable_room_bots"] === true
      assert config["features"]["enable_bot_chat"] === false
      assert config["features"]["enable_avaturn_creator"] === true
    end
  end

  defp client_configs(admin) do
    api =
      build_conn() |> auth_with_account(admin) |> get("/api/v1/app_configs") |> json_response(200)

    {page, script} = RetWeb.PageController.generate_app_config()
    assert String.starts_with?(script, "window.APP_CONFIG = JSON.parse('")
    [api, page]
  end
end
