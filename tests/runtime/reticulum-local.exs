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
chat_focus = profile in ["chat-canary", "chat-boundaries"]
chat_concurrent = profile in ["chat-concurrent", "chat-concurrent-boundaries"]

profiles = %{
  "base" => [bots: false, ai: false, avaturn: false],
  "base-avaturn" => [bots: false, ai: false, avaturn: true],
  "bots" => [bots: true, ai: false, avaturn: false],
  "bots-avaturn" => [bots: true, ai: false, avaturn: true],
  "bots-ai" => [bots: true, ai: true, avaturn: false],
  "bots-ai-avaturn" => [bots: true, ai: true, avaturn: true]
}

unless profile == "existing-tests" or chat_focus or chat_concurrent do
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
Code.require_file("test/test_helper.exs")
ExUnit.configure(autorun: false)

{count, total, excluded} =
  cond do
    profile == "existing-tests" ->
      Code.require_file("test/ret/product_modules_test.exs")
      Code.require_file("test/ret/bot_chat_presence_test.exs")
      {5, 5, 0}

    chat_focus ->
      Code.require_file(Path.join(__DIR__, "reticulum-chat-focus.exs"))
      Ret.LocalChatFocus.configure!(profile)

    chat_concurrent ->
      Code.require_file(Path.join(__DIR__, "reticulum-chat-concurrent.exs"))
      count = if profile == "chat-concurrent", do: 2, else: 4
      {count, count, 0}

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
