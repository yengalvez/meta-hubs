# Bootstrap ONLY for reticulum-local.mjs's owned, synthetic PostgreSQL target.
# No normal mix-test alias/default DB or provider connection is used here.
port = System.fetch_env!("RET_LOCAL_PORT") |> String.to_integer()
data = System.fetch_env!("RET_LOCAL_DATA")
credential = System.fetch_env!("RET_LOCAL_CREDENTIAL")

unless String.starts_with?(data, "/private/tmp/ynret-local-") and
         String.ends_with?(data, "/database") and port >= 1024 and port <= 65535 do
  raise "explicit private local target required"
end

db = [hostname: "127.0.0.1", port: port, username: "profile_test", password: credential]

for repo <- [Ret.Repo, Ret.SessionLockRepo] do
  Application.put_env(:ret, repo, Keyword.merge(Application.fetch_env!(:ret, repo), db))
end

Application.put_env(
  :ret,
  Ret.Locking,
  Keyword.put(
    Application.fetch_env!(:ret, Ret.Locking),
    :session_lock_db,
    Keyword.put(db, :database, "ret_test")
  )
)

Application.put_env(:ret, Ret.PageOriginWarmer, [])
Application.put_env(:ret, Ret.JanusLoadStatus, default_janus_host: "private-test.invalid")
# The inert, non-networked Dialog host needs the same explicit selector config
# as tracked dev/prod; config/test.exs normally leaves host discovery empty.
Application.put_env(:ret, Ret.RoomAssigner, balancer_weights: [{600, 1}, {300, 50}, {0, 500}])
Application.put_env(:ret, Ret.MediaResolver, [])

profile = System.fetch_env!("RET_LOCAL_PROFILE")
avaturn_runtime = profile == "avaturn-runtime"
chat_focus = profile in ["chat-canary", "chat-boundaries"]
chat_concurrent = profile in ["chat-concurrent", "chat-concurrent-boundaries"]
config_cache = profile in ["config-cache-canary", "config-cache-boundaries", "config-cache-types"]

sql_http =
  profile in ["sql-http-canary", "sql-http-reentry", "sql-http-stop-drain", "sql-http-periodic"]

stop_drain = profile == "sql-http-stop-drain"
catalog = profile in ["catalog-dataset", "catalog-graph-dataset"]
ui_socket = profile in ["profile-ui-socket", "profile-creator-socket"]

if ui_socket do
  origin = System.fetch_env!("RET_LOCAL_BROWSER_ORIGIN")
  http_port = System.fetch_env!("RET_LOCAL_UI_HTTP_PORT") |> String.to_integer()
  browser_port = URI.parse(origin).port

  unless Regex.match?(~r/^http:\/\/127\.0\.0\.1:[1-9][0-9]{3,4}$/, origin) and
           browser_port in 1024..65535 and http_port in 1024..65535 and
           length(Enum.uniq([port, http_port, browser_port])) == 3,
         do: raise("exact distinct owned loopback origins required")

  if profile == "profile-creator-socket" and
       System.get_env("RET_LOCAL_CONSUMER_ENTRY") in ["normal-glb", "avaturn-save"] do
    # :auto retains committed SQL across independent HTTP/peer connections.
    # Configure its owner lifetime BEFORE Repo starts; do not add a sandbox
    # checkout/transaction or extend any native observation/STOP deadline.
    Application.put_env(
      :ret,
      Ret.Repo,
      Application.fetch_env!(:ret, Ret.Repo)
      |> Keyword.put(:ownership_timeout, 120_000 + 300_000 + 15_000)
    )
  end

  if profile == "profile-creator-socket" do
    Application.put_env(:ret, Ret.ProductModules,
      bots: false,
      ai: false,
      avaturn: true,
      avaturn_creator_url: "https://virtualmente.avaturn.dev"
    )
  else
    Application.put_env(:ret, Ret.ProductModules, bots: true, ai: true, avaturn: false)
  end

  Application.put_env(
    :ret,
    RetWeb.Endpoint,
    Application.fetch_env!(:ret, RetWeb.Endpoint)
    |> Keyword.put(:server, true)
    |> Keyword.put(:load_from_system_env, false)
    |> Keyword.put(:http, ip: {127, 0, 0, 1}, port: http_port)
    |> Keyword.put(:url, host: "127.0.0.1", port: http_port, scheme: "http")
    |> Keyword.put(:allowed_origins, origin)
  )

  # Never emit Phoenix join payloads containing the synthetic account JWT.
  Logger.configure(level: :warning)
  Application.put_env(:phoenix, :filter_parameters, ["auth_token", "session_token", "perms_token", "token"])
end

if catalog do
  Application.put_env(:ret, Ret.ProductModules, bots: false, ai: false, avaturn: false)

  Application.put_env(
    :ret,
    RetWeb.Endpoint,
    Keyword.put(Application.fetch_env!(:ret, RetWeb.Endpoint), :url,
      host: "127.0.0.1",
      port: 4000,
      scheme: "http"
    )
  )

  Application.put_env(
    :ret,
    Ret.Storage,
    Keyword.put(Application.fetch_env!(:ret, Ret.Storage), :host, "http://127.0.0.1:4000")
  )
end

if sql_http do
  http_port = System.fetch_env!("RET_LOCAL_HTTP_PORT") |> String.to_integer()
  bot_port = System.fetch_env!("RET_LOCAL_BOT_PORT") |> String.to_integer()

  unless http_port in 1024..65535 and bot_port in 1024..65535 and
           length(Enum.uniq([port, http_port, bot_port])) == 3,
         do: raise("distinct owned loopback ports required")

  Application.put_env(
    :ret,
    RetWeb.Endpoint,
    Application.fetch_env!(:ret, RetWeb.Endpoint)
    |> Keyword.put(:server, true)
    |> Keyword.put(:http, ip: {127, 0, 0, 1}, port: http_port)
  )

  key = System.fetch_env!("RET_LOCAL_BOT_KEY")
  unless byte_size(key) == 64, do: raise("owned synthetic key required")
  Application.put_env(:ret, :bot_orchestrator_access_key, key)
  # No test HTTP client: Ret.BotOrchestrator must select actual HTTPoison.
  Application.put_env(:ret, Ret.BotOrchestrator,
    endpoint: "http://127.0.0.1:#{bot_port}",
    access_key: key
  )

  if stop_drain do
    # Run the installed product dispatcher, with its default SQL store,
    # HTTPoison delivery, 30s claim TTL and real retry clock. Other modes keep
    # the existing disabled dispatcher and their original test selection.
    Application.put_env(:ret, Ret.BotRuntimeOutboxDispatcher, enabled: true)
  end
end

profiles = %{
  "base" => [bots: false, ai: false, avaturn: false],
  "base-avaturn" => [bots: false, ai: false, avaturn: true],
  "bots" => [bots: true, ai: false, avaturn: false],
  "bots-avaturn" => [bots: true, ai: false, avaturn: true],
  "bots-ai" => [bots: true, ai: true, avaturn: false],
  "bots-ai-avaturn" => [bots: true, ai: true, avaturn: true]
}

unless profile == "existing-tests" or avaturn_runtime or chat_focus or chat_concurrent or
         config_cache or sql_http or
         catalog or ui_socket do
  modules = Map.fetch!(profiles, profile)

  Application.put_env(
    :ret,
    Ret.ProductModules,
    Keyword.put(modules, :avaturn_creator_url, "https://virtualmente.avaturn.dev")
  )
end

# Confirm the owned target inside the SAME sandboxed VM before create/migrate.
{:ok, _} = Application.ensure_all_started(:postgrex)
{:ok, connection} = Postgrex.start_link(Keyword.put(db, :database, "postgres"))

%Postgrex.Result{rows: [[^data, ^port, "profile_test"]]} =
  Postgrex.query!(
    connection,
    "SELECT current_setting('data_directory'), inet_server_port(), current_user",
    []
  )

GenServer.stop(connection)
Mix.Task.run("ecto.create", ["--quiet"])
Mix.Task.run("ecto.migrate", [])
File.mkdir_p!("storage/test")
{:ok, _} = Application.ensure_all_started(:ret)

if ui_socket do
  Ecto.Adapters.SQL.Sandbox.mode(Ret.Repo, :auto)
  Code.require_file(Path.join(__DIR__, "reticulum-ui-socket.exs"))
  # The fixture halts only after explicit STOP and Endpoint shutdown; no ExUnit PASS.
  raise "UI observation returned without explicit shutdown"
end

Code.require_file("test/test_helper.exs")
ExUnit.configure(autorun: false)

{count, total, excluded} =
  cond do
    profile == "existing-tests" ->
      Code.require_file("test/ret/product_modules_test.exs")
      Code.require_file("test/ret/bot_chat_presence_test.exs")
      ExUnit.configure(exclude: [:avaturn_runtime_capabilities])
      {5, 7, 2}

    avaturn_runtime ->
      Code.require_file("test/ret/product_modules_test.exs")
      Code.require_file("test/ret/app_config_test.exs")
      Code.require_file("test/ret_web/channels/hub_channel_test.exs")

      tests =
        Enum.flat_map(
          [Ret.ProductModulesTest, Ret.AppConfigTest, RetWeb.HubChannelTest],
          fn module ->
            module.__ex_unit__().tests
          end
        )

      selected = Enum.filter(tests, &(Map.get(&1.tags, :avaturn_runtime_capabilities) == true))
      if length(selected) != 5, do: raise("exact five avaturn runtime cases required")
      ExUnit.configure(exclude: [:test], include: [:avaturn_runtime_capabilities])
      {5, length(tests), length(tests) - 5}

    chat_focus ->
      Code.require_file(Path.join(__DIR__, "reticulum-chat-focus.exs"))
      Ret.LocalChatFocus.configure!(profile)

    chat_concurrent ->
      Code.require_file(Path.join(__DIR__, "reticulum-chat-concurrent.exs"))
      count = if profile == "chat-concurrent", do: 2, else: 4
      {count, count, 0}

    sql_http ->
      # HTTP handlers own automatic independent connections, only in this
      # newly created disposable cluster, never on the default database.
      Ecto.Adapters.SQL.Sandbox.mode(Ret.Repo, :auto)

      Code.require_file(
        Path.join(
          __DIR__,
          if(stop_drain, do: "reticulum-stop-drain.exs", else: "reticulum-sql-http.exs")
        )
      )

      count = if profile in ["sql-http-reentry", "sql-http-periodic"], do: 1, else: 2
      {count, count, 0}

    catalog ->
      # Commit only to the independently verified disposable database. Normal
      # DataCase rollback would erase the dataset before its private dump.
      Ecto.Adapters.SQL.Sandbox.mode(Ret.Repo, :auto)

      if profile == "catalog-graph-dataset",
        do: Code.require_file(Path.join(__DIR__, "reticulum-catalog-graph.exs"))

      Code.require_file(Path.join(__DIR__, "reticulum-catalog-dataset.exs"))
      {1, 1, 0}

    profile == "config-cache-canary" ->
      Code.require_file(Path.join(__DIR__, "reticulum-config-cache.exs"))
      {2, 2, 0}

    profile in ["config-cache-boundaries", "config-cache-types"] ->
      Code.require_file("test/ret/app_config_test.exs")

      names = [
        "cached projection uses current bots and creator OFF with one fresh query",
        "cached projection restores ON while the raw cache stays OFF",
        "cached projection rejects absent and malformed flags",
        "cached projection cannot install extras in BASE"
      ]

      names =
        if profile == "config-cache-types",
          do: ["cached projection rejects absent and malformed flags"],
          else: names

      tests = Ret.AppConfigTest.__ex_unit__().tests

      selected =
        Enum.filter(tests, fn test ->
          Atom.to_string(test.name) in Enum.map(names, &("test " <> &1))
        end)

      unless length(selected) == length(names) and
               Enum.all?(names, fn name ->
                 Enum.count(selected, &(Atom.to_string(&1.name) == "test " <> name)) == 1
               end) do
        raise "exact config cache cases missing or duplicated"
      end

      ExUnit.configure(exclude: [:test], include: Enum.map(selected, &{:test, &1.name}))
      {length(names), length(tests), length(tests) - length(names)}

    true ->
      Code.require_file(Path.join(__DIR__, "reticulum-profiles.exs"))
      {1, 1, 0}
  end

result = ExUnit.run()

unless result.total == total and result.failures == 0 and result.excluded == excluded and
         result.skipped == 0 do
  System.halt(1)
end

File.write!("local-result-#{profile}.txt", "#{count}/#{count}\n")
Application.stop(:ret)
