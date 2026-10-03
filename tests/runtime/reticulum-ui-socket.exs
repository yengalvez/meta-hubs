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
    normal_glb = System.get_env("RET_LOCAL_CONSUMER_ENTRY") == "normal-glb"
    avaturn_save = System.get_env("RET_LOCAL_CONSUMER_ENTRY") == "avaturn-save"
    bootstrap_name = cond do
      avaturn_save -> "avaturn-save-socket-bootstrap.json"
      normal_glb -> "normal-glb-socket-bootstrap.json"
      creator_mode -> "creator-socket-bootstrap.json"
      true -> "ui-socket-bootstrap.json"
    end

    unless profile in ["profile-ui-socket", "profile-creator-socket"] and
             System.fetch_env!("MIX_ENV") == "test" and
             bootstrap == Path.join(work, bootstrap_name) and
             String.starts_with?(work, "/private/tmp/ynret-local-") and
             stat.type == :directory and rem(stat.mode, 0o1000) == 0o700,
           do: raise("private UI bootstrap target required")
    if normal_glb and not creator_mode, do: raise("normal GLB requires creator-only native ceiling")
    if avaturn_save and not creator_mode, do: raise("Avaturn save requires creator-only native ceiling")

    if normal_glb, do: bind_normal_glb_storage!(work, http_port)
    if avaturn_save, do: bind_normal_glb_storage!(work, http_port)

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
    email = "ui-socket-#{System.unique_integer([:positive])}@example.invalid"
    account = Account.find_or_create_account_for_email(email)
    # One owned save attempt per Avaturn fixture, never a product-wide observer.
    response_observer = if avaturn_save, do: attach_avatar_response_observer!(account.account_id)

    hub =
      %Hub{}
      |> Hub.changeset(nil, %{name: "Canary local", room_size: 24})
      |> Hub.add_account_to_changeset(account)
      |> Repo.insert!()

    {:ok, token, _claims} = Ret.Guardian.encode_and_sign(account)
    request_observer = if avaturn_save, do: attach_avatar_request_observer!(token)
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

    context = if normal_glb do
      native_origin = "http://127.0.0.1:#{http_port}"
      Map.merge(context, %{
        kind: "reticulum-profile-normal-glb", mode: "normal-glb",
        auth_bootstrap: "local-native-guardian", auth_email: email,
        # Preserve the native PostgreSQL int64, like AvatarView's owner field.
        account_id: Integer.to_string(account.account_id),
        reticulum_origin: native_origin, storage_origin: native_origin
      })
    else
      context
    end

    context = if avaturn_save do
      native_origin = "http://127.0.0.1:#{http_port}"
      Map.merge(context, %{
        kind: "reticulum-profile-avaturn-save", mode: "avaturn-save",
        auth_bootstrap: "local-native-guardian", auth_email: email,
        account_id: Integer.to_string(account.account_id),
        reticulum_origin: native_origin, storage_origin: native_origin
      })
    else
      context
    end

    File.write!(bootstrap, Jason.encode!(context) <> "\n", [:exclusive])
    File.chmod!(bootstrap, 0o600)
    emit(%{phase: "READY", bootstrap: bootstrap, pid: pid})
    emit_avatar_response_state(response_observer)
    commands!(creator_mode, response_observer, request_observer)
  end

  # BEGIN PURE AVATAR RESPONSE OBSERVER
  # Router stop runs after the controller returns. :sent proves adapter handoff,
  # never browser receipt. Inspect the real Conn only here; never retain/log it.
  def avatar_response_projection(%{
        route: "/api/v1/avatars", plug: RetWeb.Api.V1.AvatarController, plug_opts: :create,
        conn: %Plug.Conn{method: "POST", request_path: "/api/v1/avatars", state: :sent, status: status,
          private: %{phoenix_endpoint: RetWeb.Endpoint, phoenix_router: RetWeb.Router,
            phoenix_controller: RetWeb.Api.V1.AvatarController, phoenix_action: :create}} = conn
      }, expected_account_id) when is_integer(expected_account_id) and expected_account_id > 0 and
        is_integer(status) and status >= 100 and status <= 599 do
    owned = case Guardian.Plug.current_resource(conn) do
      %Account{account_id: ^expected_account_id} -> true
      _ -> false
    end
    projection = %{status: status, controller: "RetWeb.Api.V1.AvatarController", action: "create", owned_account_equal: owned}
    if status == 200 and owned, do: projection, else: {:reject, projection}
  end
  def avatar_response_projection(_, _), do: :ignore

  def avatar_response_stop([:phoenix, :router_dispatch, :stop], _measurements, metadata,
        %{counter: counter, account_id: account_id}) do
    case avatar_response_projection(metadata, account_id) do
      :ignore -> :ok
      # Never disguise a failed/unowned terminal as a request still in flight.
      {:reject, projection} -> emit_avatar_response_projection(counter, projection)
      projection -> emit_avatar_response_projection(counter, projection)
    end
  end

  defp emit_avatar_response_projection(counter, projection) do
    count = :atomics.add_get(counter, 1, 1)
    emit(Map.merge(projection, %{phase: "AVATAR_RESPONSE_STOP", count: count}))
  end
  # END PURE AVATAR RESPONSE OBSERVER

  defp attach_avatar_response_observer!(account_id) do
    observer = %{handler_id: {:local_avaturn_response, self(), make_ref()},
      counter: :atomics.new(1, signed: false), account_id: account_id}
    :ok = :telemetry.attach(observer.handler_id, [:phoenix, :router_dispatch, :stop],
      &__MODULE__.avatar_response_stop/4, observer)
    observer
  end

  defp emit_avatar_response_state(nil), do: :ok
  defp emit_avatar_response_state(observer) do
    emit(%{phase: "AVATAR_RESPONSE_STATE", count: :atomics.get(observer.counter, 1)})
  end

  # BEGIN PURE AVATAR REQUEST LIFECYCLE
  # Phoenix start/exception Conn is PRE-pipeline: never infer Guardian ownership
  # there. Match the one existing fixture Bearer privately, not a new token.
  def avatar_request_projection(%{route: "/api/v1/avatars",
        plug: RetWeb.Api.V1.AvatarController, plug_opts: :create,
        conn: %Plug.Conn{method: "POST", request_path: "/api/v1/avatars",
          private: %{phoenix_endpoint: RetWeb.Endpoint, phoenix_router: RetWeb.Router},
          req_headers: headers}}, token) when is_binary(token) and byte_size(token) > 0 do
    %{own_token_equal: Enum.filter(headers, fn {name, _} -> name == "authorization" end) ==
      [{"authorization", "Bearer " <> token}]}
  end
  def avatar_request_projection(_, _), do: :ignore

  def avatar_request_event([:phoenix, :router_dispatch, kind], _measurements, metadata,
        %{owner: owner, token: token}) when kind in [:start, :stop, :exception] do
    case avatar_request_projection(metadata, token) do
      :ignore -> :ok
      projection ->
        # Do not send Conn, exception, reason, stacktrace, headers or credentials.
        terminal = case kind do
          :stop -> if match?(%{conn: %Plug.Conn{state: :sent, status: 200}}, metadata),
            do: :router_stop_200, else: :error_terminal
          :exception -> :router_exception
          :start -> :pending
        end
        send(owner, {:avatar_request_event, self(), kind, projection.own_token_equal, terminal})
    end
  end

  def avatar_request_initial, do: %{count: 0, pid: nil, monitor: nil,
    terminal: :pending, down: false, down_reason: :not_observed, failed: false}

  def avatar_request_reduce(state, {:avatar_request_event, pid, :start, owned, :pending}, monitor)
        when is_pid(pid) and is_function(monitor, 1) do
    count = state.count + 1
    if count == 1 and owned == true and not state.failed do
      %{state | count: count, pid: pid, monitor: monitor.(pid)}
    else
      {%{state | count: count, failed: true}, :invalid_start}
    end
  end
  def avatar_request_reduce(state, {:avatar_request_event, pid, kind, owned, terminal}, _monitor)
        when kind in [:stop, :exception] do
    if state.count == 1 and pid == state.pid and owned == true and
         state.terminal == :pending and not state.down and not state.failed and
         terminal in [:router_stop_200, :router_exception] do
      %{state | terminal: terminal}
    else
      {%{state | failed: true}, :invalid_terminal}
    end
  end
  def avatar_request_reduce(state, {:DOWN, ref, :process, pid, reason}, _monitor) do
    if state.count == 1 and ref == state.monitor and pid == state.pid and not state.down and not state.failed do
      %{state | down: true, down_reason: if(reason == :normal, do: :normal, else: :abnormal)}
    else
      {%{state | failed: true}, :invalid_down}
    end
  end
  def avatar_request_reduce(state, _, _), do: {%{state | failed: true}, :invalid_event}

  def avatar_request_public(state) do
    %{phase: "AVATAR_REQUEST_LIFECYCLE", attempt_count: state.count,
      start_seen: state.count == 1 and is_pid(state.pid), own_token_equal: state.count == 1 and is_pid(state.pid),
      terminal: Atom.to_string(state.terminal), request_down: state.down,
      down_reason: Atom.to_string(state.down_reason), failed: state.failed}
  end
  # END PURE AVATAR REQUEST LIFECYCLE

  defp attach_avatar_request_observer!(token) do
    parent = self()
    owner = spawn_link(fn -> avatar_request_loop(parent, avatar_request_initial()) end)
    handler_id = {:local_avaturn_request, self(), make_ref()}
    :ok = :telemetry.attach_many(handler_id,
      for(kind <- [:start, :stop, :exception], do: [:phoenix, :router_dispatch, kind]),
      &__MODULE__.avatar_request_event/4, %{owner: owner, token: token})
    %{handler_id: handler_id, owner: owner}
  end

  defp avatar_request_loop(parent, state) do
    receive do
      {:close, ^parent} -> :ok
      event ->
        case avatar_request_reduce(state, event, &Process.monitor/1) do
          {failed, _reason} ->
            emit(avatar_request_public(failed))
            # Fail closed in the fixture; do not log the rejected event.
            exit(:invalid_avatar_request_lifecycle)
          next ->
            emit(avatar_request_public(next))
            avatar_request_loop(parent, next)
        end
    end
  end

  defp bind_normal_glb_storage!(work, http_port) do
    native_origin = "http://127.0.0.1:#{http_port}"
    endpoint = Application.fetch_env!(:ret, RetWeb.Endpoint)
    unless endpoint[:http][:ip] == {127, 0, 0, 1} and endpoint[:http][:port] == http_port and
             RetWeb.Endpoint.url() == native_origin and Process.whereis(RetWeb.Endpoint),
           do: raise("normal GLB owned Endpoint mismatch")
    storage = Application.fetch_env!(:ret, Ret.Storage)
    storage_path = Path.expand(Keyword.fetch!(storage, :storage_path))
    unless storage_path == Path.join(work, "reticulum/storage/test") and
             File.dir?(storage_path), do: raise("normal GLB owned storage required")
    Application.put_env(:ret, Ret.Storage, storage |> Keyword.put(:host, native_origin) |> Keyword.put(:storage_path, storage_path))
    # The real connection initializer reads the real local /api/v1/meta response.
    Application.put_env(:ret, Ret.Meta, Keyword.put(Application.get_env(:ret, Ret.Meta, []), :phx_host, "127.0.0.1"))
    uri = Ret.Storage.uri_for("binding-check", "model/gltf")
    unless uri.scheme == "http" and uri.host == "127.0.0.1" and uri.port == http_port,
      do: raise("normal GLB Storage host mismatch")
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

  defp commands!(creator_mode, response_observer, request_observer) do
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
            if response_observer, do: :telemetry.detach(response_observer.handler_id)
            if request_observer do
              :telemetry.detach(request_observer.handler_id)
              send(request_observer.owner, {:close, self()})
            end
            :ok = Application.stop(:ret)
            if Process.whereis(RetWeb.Endpoint), do: raise("owned Endpoint still alive")
            emit(%{phase: "STOPPED"})
            System.halt(0)

          %{"command" => profile} when not creator_mode and profile in ["BASE", "BOTS_AI"] ->
            apply_profile!(profile)
            emit(%{phase: "SQL_APPLIED", profile: profile})
            commands!(creator_mode, response_observer, request_observer)

          %{"command" => profile} when creator_mode and profile in ["CREATOR_OFF", "CREATOR_ON"] ->
            apply_creator!(profile)
            emit(%{phase: "SQL_APPLIED", profile: profile})
            emit_avatar_response_state(response_observer)
            commands!(creator_mode, response_observer, request_observer)
        end
    end
  end

  defp emit(event), do: IO.puts("RET_UI_SOCKET:" <> Jason.encode!(event))
end

Ret.LocalUiSocket.run!()
