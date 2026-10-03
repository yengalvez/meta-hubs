# Private local SQL -> PubSub -> Phoenix observation, never a browser PASS.
defmodule Ret.LocalUiSocket do
  alias Ret.{Account, AppConfig, Hub, Repo}

  def run! do
    bootstrap = System.fetch_env!("RET_LOCAL_UI_BOOTSTRAP")
    data = System.fetch_env!("RET_LOCAL_DATA")
    work = Path.dirname(data)
    origin = System.fetch_env!("RET_LOCAL_BROWSER_ORIGIN")
    http_port = System.fetch_env!("RET_LOCAL_UI_HTTP_PORT") |> String.to_integer()
    stat = File.stat!(work)
    profile = System.fetch_env!("RET_LOCAL_PROFILE")
    creator_mode = profile == "profile-creator-socket"
    bootstrap_name = if creator_mode, do: "creator-socket-bootstrap.json", else: "ui-socket-bootstrap.json"

    unless profile in ["profile-ui-socket", "profile-creator-socket"] and
             System.fetch_env!("MIX_ENV") == "test" and
             bootstrap == Path.join(work, bootstrap_name) and
             String.starts_with?(work, "/private/tmp/ynret-local-") and
             stat.type == :directory and rem(stat.mode, 0o1000) == 0o700,
           do: raise("private UI bootstrap target required")

    source = %{
      root: System.fetch_env!("RET_LOCAL_SOURCE_ROOT"),
      hubs: System.fetch_env!("RET_LOCAL_SOURCE_HUBS"),
      cloud: System.fetch_env!("RET_LOCAL_SOURCE_CLOUD")
    }

    unless Enum.all?(Map.values(source), &Regex.match?(~r/^[a-f0-9]{40}$/, &1)),
      do: raise("frozen source identities required")

    AppConfig.set_config_value("features|require_account_for_join", true)
    AppConfig.set_config_value("features|enable_avaturn_creator", false)
    apply_profile!("BASE")
    if creator_mode, do: apply_creator!("CREATOR_ON")
    account = Account.find_or_create_account_for_email("ui-socket-#{System.unique_integer([:positive])}@example.invalid")

    hub =
      %Hub{}
      |> Hub.changeset(nil, %{name: "Canary local", room_size: 24})
      |> Hub.add_account_to_changeset(account)
      |> Repo.insert!()

    {:ok, token, _claims} = Ret.Guardian.encode_and_sign(account)
    pid = System.pid() |> String.to_integer()

    context = %{
      schema: 1,
      kind: if(creator_mode, do: "reticulum-profile-creator-socket", else: "reticulum-profile-ui-socket"),
      ws_url: "ws://127.0.0.1:#{http_port}/socket",
      browser_origin: origin,
      hub_sid: hub.hub_sid,
      auth_token: token,
      backend_pid: pid,
      source: source
    }

    context =
      if creator_mode do
        Map.merge(context, %{
          mode: "creator-only",
          app_config: public_creator_config!(),
          app_config_provenance: "Ret.ProductModules.project_config/committed-SQL"
        })
      else
        context
      end

    File.write!(bootstrap, Jason.encode!(context) <> "\n", [:exclusive])
    File.chmod!(bootstrap, 0o600)
    emit(%{phase: "READY", bootstrap: bootstrap, pid: pid})
    commands!(creator_mode)
  end

  defp apply_profile!(profile) do
    enabled = profile == "BOTS_AI"
    # Use the real mutation fence, persisted JSON wrappers and its publication.
    # Disable AI first / enable bots first; no manufactured Endpoint broadcast.
    writes =
      if enabled,
        do: [{"features|enable_room_bots", true}, {"features|enable_bot_chat", true}],
        else: [{"features|enable_bot_chat", false}, {"features|enable_room_bots", false}]

    for {key, value} <- writes, do: AppConfig.set_config_value(key, value)

    for key <- ["features|enable_room_bots", "features|enable_bot_chat"] do
      %AppConfig{value: %{"value" => ^enabled}} = Repo.get_by!(AppConfig, key: key)
    end

    %AppConfig{value: %{"value" => true}} = Repo.get_by!(AppConfig, key: "features|require_account_for_join")
    %AppConfig{value: %{"value" => false}} = Repo.get_by!(AppConfig, key: "features|enable_avaturn_creator")
  end

  defp apply_creator!(profile) do
    enabled = profile == "CREATOR_ON"
    AppConfig.set_config_value("features|enable_avaturn_creator", enabled)
    %AppConfig{value: %{"value" => ^enabled}} = Repo.get_by!(AppConfig, key: "features|enable_avaturn_creator")
    for key <- ["features|enable_room_bots", "features|enable_bot_chat"] do
      %AppConfig{value: %{"value" => false}} = Repo.get_by!(AppConfig, key: key)
    end

    unless Ret.ProductModules.installed?(:avaturn) and not Ret.ProductModules.installed?(:bots) and
             not Ret.ProductModules.installed?(:ai), do: raise("creator-only installed ceiling required")

    for actor <- [Ret.BotRunnerLease, Ret.BotChatPresence, Ret.BotRuntimeOutboxDispatcher] do
      if Process.whereis(actor), do: raise("bot actor present in creator-only installation")
    end
  end

  defp public_creator_config! do
    features =
      for key <- ["enable_room_bots", "enable_bot_chat", "enable_avaturn_creator"], into: %{} do
        %AppConfig{value: %{"value" => value}} = Repo.get_by!(AppConfig, key: "features|" <> key)
        {key, value}
      end

    # Source is committed local SQL + the product installation projection,
    # never a client updater or an origin carried by PubSub.
    projected = Ret.ProductModules.project_config(%{"features" => features, "links" => %{}})
    %{
      "features" => %{"enable_room_bots" => false, "enable_bot_chat" => false, "enable_avaturn_creator" => true},
      "links" => %{"avaturn_creator" => "https://virtualmente.avaturn.dev"}
    } = projected
    projected
  end

  defp commands!(creator_mode) do
    case IO.gets(:stdio, "") do
      :eof -> raise "UI observation EOF without STOP"
      {:error, _} -> raise "UI observation input failed"
      line ->
        pattern = if creator_mode,
          do: ~r/^\s*\{\s*"command"\s*:\s*"(CREATOR_OFF|CREATOR_ON|STOP)"\s*\}\s*$/,
          else: ~r/^\s*\{\s*"command"\s*:\s*"(BASE|BOTS_AI|STOP)"\s*\}\s*$/
        unless byte_size(line) <= 128 and Regex.match?(pattern, line),
               do: raise("invalid UI observation command")

        case Jason.decode!(line) do
          %{"command" => "STOP"} ->
            :ok = Application.stop(:ret)
            if Process.whereis(RetWeb.Endpoint), do: raise("owned Endpoint still alive")
            emit(%{phase: "STOPPED"})
            System.halt(0)

          %{"command" => profile} when not creator_mode and profile in ["BASE", "BOTS_AI"] ->
            apply_profile!(profile)
            emit(%{phase: "SQL_APPLIED", profile: profile})
            commands!(creator_mode)

          %{"command" => profile} when creator_mode and profile in ["CREATOR_OFF", "CREATOR_ON"] ->
            apply_creator!(profile)
            emit(%{phase: "SQL_APPLIED", profile: profile})
            commands!(creator_mode)
        end
    end
  end

  defp emit(event), do: IO.puts("RET_UI_SOCKET:" <> Jason.encode!(event))
end

Ret.LocalUiSocket.run!()
