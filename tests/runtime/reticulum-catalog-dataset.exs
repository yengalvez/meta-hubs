defmodule Ret.LocalCatalogDataset do
  use ExUnit.Case, async: false
  import Ecto.Query
  alias Ret.{Account, Avatar, AvatarListing, OwnedFile, Repo, Storage}

  defp hash(bytes), do: :crypto.hash(:sha256, bytes) |> Base.encode16(case: :lower)

  defp input! do
    input = System.fetch_env!("RET_LOCAL_CATALOG_INPUT")
    work = System.fetch_env!("RET_LOCAL_DATA") |> Path.dirname()
    expected = Path.join(work, "catalog-input/input.json")
    assert input == expected
    assert %File.Stat{type: :regular, mode: mode} = File.lstat!(input)
    assert Bitwise.band(mode, 0o777) == 0o600
    dataset = Poison.decode!(File.read!(input))
    assert dataset["schema"] == 1
    assert dataset["scope"] == "owned-synthetic-catalog-not-production-or-cycles"
    assert length(dataset["entries"]) == 33
    {dataset, work}
  end

  defp stored!(account, file, work) do
    assert String.starts_with?(file["path"], Path.join(work, "catalog-input") <> "/")
    assert %File.Stat{type: :regular, mode: mode} = File.lstat!(file["path"])
    assert Bitwise.band(mode, 0o777) == 0o600
    bytes = File.read!(file["path"])
    assert byte_size(bytes) == file["size"]
    assert hash(bytes) == file["sha256"]
    key = SecureRandom.hex()
    {:ok, uuid} = Storage.store(%Plug.Upload{path: file["path"]}, file["content_type"], key)
    {:ok, promoted} = Storage.promote(uuid, key, nil, account)
    # Repo.insert returns the struct's nil state; the active default belongs
    # to SQL. Require the persisted row, not an assumption about that struct.
    owned = Repo.get!(OwnedFile, promoted.owned_file_id)
    assert owned.account_id == account.account_id
    assert owned.state == :active
    {:ok, meta, stream} = Storage.fetch(owned)
    assert meta["content_type"] == file["content_type"]
    assert meta["content_length"] == file["size"]
    assert hash(Enum.to_list(stream) |> IO.iodata_to_binary()) == file["sha256"]
    {owned, file["sha256"]}
  end

  test "native #{System.fetch_env!("RET_LOCAL_PROFILE")}: approved catalog and selected SQL graph" do
    {dataset, work} = input!()
    assert Repo.aggregate(Avatar, :count, :avatar_id) == 0
    assert Repo.aggregate(AvatarListing, :count, :avatar_listing_id) == 0
    assert Repo.aggregate(OwnedFile, :count, :owned_file_id) == 0
    account = Account.find_or_create_account_for_email("catalog@yenhubs-isolated.invalid")

    expected =
      Enum.map(dataset["entries"], fn entry ->
        files =
          Map.new(entry["files"], fn {kind, file} -> {kind, stored!(account, file, work)} end)

        avatar =
          Avatar.changeset(
            %Avatar{},
            account,
            %{
              gltf_owned_file: elem(files["gltf"], 0),
              bin_owned_file: elem(files["bin"], 0),
              thumbnail_owned_file: elem(files["thumbnail"], 0)
            },
            nil,
            nil,
            %{
              name: entry["name"],
              description: "Isolated reference catalog",
              allow_remixing: true,
              allow_promotion: true
            }
          )
          |> Repo.insert!()

        listing =
          AvatarListing.changeset_for_listing_for_avatar(
            %AvatarListing{avatar_listing_sid: entry["listing_sid"]},
            avatar,
            %{name: entry["name"], order: 10000, tags: %{"tags" => entry["tags"]}}
          )
          |> Ecto.Changeset.change(state: :active)
          |> Repo.insert!()

        %{entry: entry, avatar: avatar, listing: listing, files: files}
      end)

    # Independent automatic SQL connection, not the writer's cached Ecto structs.
    options = Application.fetch_env!(:ret, Ret.Repo)

    {:ok, peer} =
      Postgrex.start_link(
        Keyword.take(
          options,
          [:hostname, :port, :username, :password, :database]
        )
      )

    try do
      %Postgrex.Result{rows: [[33, 33, 99]]} =
        Postgrex.query!(
          peer,
          "SELECT (SELECT count(*) FROM ret0.avatars), (SELECT count(*) FROM ret0.avatar_listings), (SELECT count(*) FROM ret0.owned_files)",
          []
        )

      Enum.each(expected, fn item ->
        %Postgrex.Result{rows: [[owner, avatar_id, gltf_id, bin_id, thumbnail_id]]} =
          Postgrex.query!(
            peer,
            "SELECT l.account_id,l.avatar_id,l.gltf_owned_file_id,l.bin_owned_file_id,l.thumbnail_owned_file_id FROM ret0.avatar_listings l WHERE l.avatar_listing_sid=$1",
            [item.entry["listing_sid"]]
          )

        assert owner == account.account_id
        assert avatar_id == item.avatar.avatar_id

        assert [gltf_id, bin_id, thumbnail_id] ==
                 Enum.map(["gltf", "bin", "thumbnail"], &elem(item.files[&1], 0).owned_file_id)
      end)
    after
      GenServer.stop(peer)
    end

    preserved = ["84PKFaQ", "y_GoczU", "x0h-wd0", "f8zTm-g", "mKOnfC8", "t_zomhE", "3LVfOJj"]

    actual_preserved =
      Repo.all(
        from(l in AvatarListing,
          where: l.avatar_listing_sid in ^preserved,
          select: l.avatar_listing_sid
        )
      )

    assert Enum.sort(actual_preserved) == Enum.sort(preserved)

    binding =
      Enum.map(expected, fn item ->
        listing =
          Repo.get!(AvatarListing, item.listing.avatar_listing_id)
          |> Avatar.load_parents(Avatar.file_columns())
          |> Repo.preload(:avatar)

        %{avatars: [view]} =
          RetWeb.Api.V1.AvatarView.render("show.json", %{avatar: listing, account: nil})

        assert view.avatar_id == item.entry["listing_sid"]
        assert view.name == item.entry["name"]
        assert view.allow_remixing and view.allow_promotion

        for kind <- ["gltf", "bin", "thumbnail"] do
          assert URI.parse(view.files[kind]).host == "127.0.0.1"
          {owned, expected_hash} = item.files[kind]
          current = Repo.get!(OwnedFile, owned.owned_file_id)
          assert current.account_id == account.account_id and current.state == :active
          {:ok, _meta, stream} = Storage.fetch(current)
          assert hash(Enum.to_list(stream) |> IO.iodata_to_binary()) == expected_hash

          for path <- Storage.paths_for_owned_file(current) |> Enum.drop(1),
              do: File.chmod!(path, 0o600)
        end

        %{
          listing_sid: listing.avatar_listing_sid,
          avatar_sid: item.avatar.avatar_sid,
          avatar_id: Integer.to_string(item.avatar.avatar_id),
          listing_id: Integer.to_string(listing.avatar_listing_id),
          source_sha256: item.entry["glb_sha256"],
          png_sha256: item.entry["png_sha256"],
          files:
            Map.new(item.files, fn {kind, {owned, bytes_hash}} ->
              {kind,
               %{
                 owned_file_id: Integer.to_string(owned.owned_file_id),
                 uuid: owned.owned_file_uuid,
                 plaintext_sha256: bytes_hash
               }}
            end)
        }
      end)

    graph =
      if System.fetch_env!("RET_LOCAL_PROFILE") == "catalog-graph-dataset" do
        assert dataset["graph"]["scope"] ==
                 "native-synthetic-room-project-graph-not-current-metaverse"

        Ret.LocalCatalogGraph.create_and_verify!(dataset["graph"], account, &stored!/3)
      end

    file = Path.join(work, "catalog-readback.json")

    File.write!(
      file,
      Poison.encode!(
        Map.merge(
          %{
            scope: "native-synthetic-catalog-not-restore-or-browser-or-cycles",
            binding: dataset["binding"],
            models: 33,
            listings: 33,
            owned_pairs: if(graph, do: 103, else: 99),
            preserved: 7,
            entries: binding
          },
          if(graph, do: %{graph: graph}, else: %{})
        )
      )
    )

    File.chmod!(file, 0o600)
  end
end
