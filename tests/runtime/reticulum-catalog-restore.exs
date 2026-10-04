defmodule Ret.LocalCatalogRestore do
  use ExUnit.Case, async: false
  alias Ret.{Account, Avatar, AvatarListing, Hub, OwnedFile, Project, Repo, Storage}

  @scope "native-PG14-existing-synthetic-seed-restore-not-kubernetes-production-browser-or-cycles"
  @seed_sql_sha256 "fa47f64379c63ec6eba056dfaf93faea2b94eaf3465750568695b9e982ab8cdc"
  @tables %{
    "accounts" => ["account_id"],
    "owned_files" => ["owned_file_id", "owned_file_uuid", "account_id", "content_type", "content_length", "state"],
    "avatars" => ["avatar_id", "avatar_sid", "account_id", "gltf_owned_file_id", "bin_owned_file_id", "thumbnail_owned_file_id", "state"],
    "avatar_listings" => ["avatar_listing_id", "avatar_listing_sid", "avatar_id", "account_id", "gltf_owned_file_id", "bin_owned_file_id", "thumbnail_owned_file_id", "state"],
    "hubs" => ["hub_id", "hub_sid", "created_by_account_id", "scene_listing_id", "creator_assignment_token"],
    "scenes" => ["scene_id", "scene_sid", "account_id", "model_owned_file_id", "screenshot_owned_file_id", "scene_owned_file_id", "state"],
    "scene_listings" => ["scene_listing_id", "scene_listing_sid", "scene_id", "model_owned_file_id", "screenshot_owned_file_id", "scene_owned_file_id", "state"],
    "projects" => ["project_id", "project_sid", "created_by_account_id", "scene_id", "project_owned_file_id", "thumbnail_owned_file_id"],
    "hub_role_memberships" => ["hub_id", "account_id"]
  }

  defp hash(bytes), do: :crypto.hash(:sha256, bytes) |> Base.encode16(case: :lower)

  defp read_binding! do
    work = System.fetch_env!("RET_LOCAL_DATA") |> Path.dirname()
    path = System.fetch_env!("RET_LOCAL_CATALOG_RESTORE_BINDING")
    assert path == Path.join(work, "catalog-restore/binding.json")
    assert %File.Stat{type: :regular, mode: mode} = File.lstat!(path)
    assert Bitwise.band(mode, 0o777) == 0o600
    binding = Poison.decode!(File.read!(path))
    assert binding["schema"] == 1 and binding["scope"] == @scope
    assert binding["crypto_domain"] == "unchanged-tracked-MIX_ENV-test-RetWeb.Endpoint-secret_key_base"
    assert binding["fixture_kind"] == "Reticulum-MIX_ENV-test-public-fixture"
    assert hash(File.read!("config/test.exs")) == binding["fixture_config_sha256"]
    assert binding["sql_reference"] == %{"captured_on" => "2026-10-04", "capture_kind" => "primary-source-only", "sha256" => @seed_sql_sha256}
    assert hash(File.read!(Path.join(work, "catalog-restore/catalog-native.sql"))) == @seed_sql_sha256
    assert binding["sequence"] == %{"name" => "ret0.table_id_seq", "last_value" => "180", "is_called" => true, "captured_on" => "2026-10-04"}
    assert length(binding["files"]) == 103 and length(binding["entries"]) == 33
    assert Application.fetch_env!(:ret, Ret.Storage)[:storage_path] == Path.join(work, "reticulum/storage/test")
    assert Application.fetch_env!(:ret, RetWeb.Endpoint)[:server] == false
    {binding, work}
  end

  defp sql_reload!(binding) do
    options = Application.fetch_env!(:ret, Ret.Repo)
    {:ok, peer} = Postgrex.start_link(Keyword.take(options, [:hostname, :port, :username, :password, :database, :parameters]))

    try do
      data = System.fetch_env!("RET_LOCAL_DATA")
      port = System.fetch_env!("RET_LOCAL_PORT") |> String.to_integer()

      %Postgrex.Result{rows: [[^data, ^port, "profile_test", "ret_test", "on"]]} =
        Postgrex.query!(peer, "SELECT current_setting('data_directory'), inet_server_port(), current_user, current_database(), current_setting('default_transaction_read_only')", [])

      # Literal independent read; never advance, repair or recreate the sequence.
      %Postgrex.Result{rows: [["180", true]]} =
        Postgrex.query!(peer, "SELECT last_value::text,is_called FROM ret0.table_id_seq", [])

      assert Enum.sort(Map.keys(binding["tables"])) == Enum.sort(Map.keys(@tables))

      for {table, columns} <- @tables do
        expected = binding["tables"][table]
        assert expected["columns"] == columns
        # Identifiers are literal, never interpolated from an input object.
        selection = Enum.map_join(columns, ",", &(&1 <> "::text"))
        %Postgrex.Result{rows: rows} = Postgrex.query!(peer, "SELECT #{selection} FROM ret0.#{table}", [])
        assert Enum.sort_by(rows, &Poison.encode!/1) == expected["rows"]
      end

      # Independent SQL also proves all per-file keys came from the reload;
      # only their hashes enter the binding, never key/config values or logs.
      %Postgrex.Result{rows: key_rows} = Postgrex.query!(peer, "SELECT owned_file_id::text, key FROM ret0.owned_files", [])
      assert length(key_rows) == 103
      expected_keys = Map.new(binding["files"], &{&1["owned_file_id"], &1["key_sha256"]})
      assert Map.new(key_rows, fn [id, key] -> {id, hash(key)} end) == expected_keys
    after
      GenServer.stop(peer)
    end
  end

  defp owned_and_fetch!(expected) do
    owned = Repo.get!(OwnedFile, String.to_integer(expected["owned_file_id"]))
    assert owned.owned_file_uuid == expected["owned_file_uuid"]
    assert Integer.to_string(owned.account_id) == expected["account_id"]
    assert owned.state == :active
    assert hash(owned.key) == expected["key_sha256"]
    [_, meta_file, blob_file] = Storage.paths_for_owned_file(owned)

    for {path, digest, bytes} <- [
          {meta_file, expected["meta_sha256"], expected["meta_bytes"]},
          {blob_file, expected["blob_sha256"], expected["blob_bytes"]}
        ] do
      assert %File.Stat{type: :regular, mode: mode, size: ^bytes} = File.lstat!(path)
      assert Bitwise.band(mode, 0o777) == 0o600
      assert hash(File.read!(path)) == digest
    end

    {:ok, metadata, stream} = Storage.fetch(owned)
    assert metadata["content_type"] == expected["content_type"]
    assert metadata["content_length"] == String.to_integer(expected["content_length"])
    plaintext = Enum.to_list(stream) |> IO.iodata_to_binary()
    assert byte_size(plaintext) == String.to_integer(expected["content_length"])
    assert hash(plaintext) == expected["plaintext_sha256"]
    owned
  end

  defp catalog_and_graph!(binding) do
    for expected <- binding["entries"] do
      listing = Repo.get!(AvatarListing, String.to_integer(expected["listing_id"]))
        |> Avatar.load_parents(Avatar.file_columns()) |> Repo.preload(:avatar)
      assert listing.avatar_listing_sid == expected["listing_sid"]
      assert Integer.to_string(listing.avatar.avatar_id) == expected["avatar_id"]
      assert listing.avatar.avatar_sid == expected["avatar_sid"]
      %{avatars: [view]} = RetWeb.Api.V1.AvatarView.render("show.json", %{avatar: listing, account: nil})
      assert view.avatar_id == expected["listing_sid"] and view.name == expected["name"]
      assert view.allow_remixing and view.allow_promotion
      for kind <- ["gltf", "bin", "thumbnail"], do: assert(URI.parse(view.files[kind]).host == "127.0.0.1")
    end

    graph = binding["graph"]
    hub = Repo.get!(Hub, String.to_integer(graph["room_id"])) |> Repo.preload(:hub_role_memberships)
    room_owner = Repo.get!(Account, String.to_integer(graph["room_owner_id"]))
    co_owner = Repo.get!(Account, String.to_integer(graph["co_owner_id"]))
    project_owner = Repo.get!(Account, String.to_integer(graph["project_owner_id"]))
    assert hub.hub_sid == graph["room_sid"] and hub.creator_assignment_token == nil
    assert length(Enum.uniq([room_owner.account_id, co_owner.account_id, project_owner.account_id])) == 3
    assert Hub.is_owner?(hub, room_owner.account_id)
    assert Hub.is_owner?(hub, co_owner.account_id)
    refute Hub.is_owner?(hub, project_owner.account_id)
    assert Project.project_by_sid_for_account(graph["project_sid"], room_owner) == nil
    assert Project.project_by_sid_for_account(graph["project_sid"], co_owner) == nil
    project = Project.project_by_sid_for_account(graph["project_sid"], project_owner)
    assert Integer.to_string(project.project_id) == graph["project_id"]
    assert Integer.to_string(project.scene.scene_id) == graph["scene_id"]
    assert project.scene.scene_sid == graph["scene_sid"]
    view = RetWeb.Api.V1.ProjectView.render("show.json", %{project: project})
    assert view.project_id == graph["project_sid"] and view.scene.scene_id == graph["scene_sid"]
    assert view.scene.project_id == graph["project_sid"]
    for url <- [view.project_url, view.thumbnail_url, view.scene.model_url, view.scene.screenshot_url, view.scene.scene_project_url, view.scene.url],
      do: assert(URI.parse(url).host == "127.0.0.1")
  end

  test "existing seed is actually SQL-reloaded and all paired media decrypt only in its original fixture domain" do
    {binding, work} = read_binding!()
    sql_reload!(binding)
    originals = Enum.map(binding["files"], &owned_and_fetch!/1)
    catalog_and_graph!(binding)
    config = Application.fetch_env!(:ret, RetWeb.Endpoint)
    original_domain = Keyword.fetch!(config, :secret_key_base)

    # Change this ONE public synthetic fixture input. Neither SQL keys nor
    # storage/DB/file/host inputs change. Invalid-key rejection is real product
    # Ret.Storage -> Ret.Crypto, not a mocked hash/count or arbitrary exception.
    try do
      Application.put_env(:ret, RetWeb.Endpoint, Keyword.put(config, :secret_key_base, original_domain <> "-catalog-restore-negative-v1"))
      for owned <- originals, do: assert(Storage.fetch(owned) == {:error, :not_allowed})
    after
      Application.put_env(:ret, RetWeb.Endpoint, config)
    end

    unless Application.fetch_env!(:ret, RetWeb.Endpoint) == config, do: raise("original fixture domain not restored")
    for expected <- binding["files"], do: owned_and_fetch!(expected)
    sql_reload!(binding)
    catalog_and_graph!(binding)

    readback = %{schema: 1, scope: @scope, pair_binding_sha256: binding["pair_binding_sha256"],
      sql_reload_verified: true, sequence_verified: true, owned_pairs: 103, plaintext_verified: 103,
      negative_secret_rejected: 103, original_domain_reverified: 103,
      listings: 33, preserved: 7, graph_ownership_verified: true,
      browser_acceptance: "NOT_RECORDED", kubernetes_acceptance: "NOT_RECORDED", cycles_acceptance: "NOT_RECORDED"}
    path = Path.join(work, "catalog-restore/readback.json")
    File.write!(path, Poison.encode!(readback), [:exclusive])
    File.chmod!(path, 0o600)
  end
end
