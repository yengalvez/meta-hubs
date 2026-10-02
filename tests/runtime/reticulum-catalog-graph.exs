defmodule Ret.LocalCatalogGraph do
  import ExUnit.Assertions
  alias Ret.{Account, Hub, OwnedFile, Project, Repo, Scene, SceneListing, Storage}

  # Called only inside the existing owned native dataset case. No API,
  # production import, changes to grants, publication or restore authority.
  def create_and_verify!(input, room_owner, store) do
    work = System.fetch_env!("RET_LOCAL_DATA") |> Path.dirname()
    project_owner = Account.find_or_create_account_for_email("project@yenhubs-isolated.invalid")
    co_owner = Account.find_or_create_account_for_email("coowner@yenhubs-isolated.invalid")

    assert length(
             Enum.uniq([room_owner.account_id, project_owner.account_id, co_owner.account_id])
           ) == 3

    files =
      Map.new(input["files"], fn {kind, file} -> {kind, store.(project_owner, file, work)} end)

    owned = fn kind -> elem(files[kind], 0) end

    scene =
      Scene.changeset(
        %Scene{scene_sid: "ynCgScn"},
        project_owner,
        owned.("model"),
        owned.("thumbnail"),
        owned.("scene"),
        %{name: "Isolated Reference Scene", allow_remixing: true, allow_promotion: true}
      )
      |> Repo.insert!()

    scene = Repo.get!(Scene, scene.scene_id) |> Repo.preload(Scene.scene_preloads())

    listing =
      SceneListing.changeset_for_listing_for_scene(
        %SceneListing{scene_listing_sid: "ynCgLst"},
        scene,
        %{name: "Isolated Reference Scene", tags: %{"tags" => ["default"]}}
      )
      |> Ecto.Changeset.change(state: :active)
      |> Repo.insert!()

    project =
      Project.changeset(
        %Project{project_sid: "ynCgPrj"},
        project_owner,
        owned.("project"),
        owned.("thumbnail"),
        %{name: "Isolated Reference Project"}
      )
      |> Repo.insert!()

    project = Repo.preload(project, :scene)
    {:ok, project} = Project.add_scene_to_project(project, scene)

    hub =
      Hub.changeset(%Hub{hub_sid: "ynCgHub"}, listing, %{
        name: "Isolated Reference Room",
        room_size: 10
      })
      |> Repo.insert!()

    hub =
      Hub.changeset_for_creator_assignment(hub, room_owner, hub.creator_assignment_token)
      |> Repo.update!()

    hub = Hub.add_owner!(hub, co_owner)

    # Separate SQL peer verifies committed identity/FKs, not cached structs.
    {:ok, peer} =
      Postgrex.start_link(
        Application.fetch_env!(:ret, Ret.Repo)
        |> Keyword.take([:hostname, :port, :username, :password, :database])
      )

    try do
      %Postgrex.Result{rows: [[103, 1, 1, 1, 1, 1]]} =
        Postgrex.query!(
          peer,
          "SELECT (SELECT count(*) FROM ret0.owned_files), (SELECT count(*) FROM ret0.scenes), (SELECT count(*) FROM ret0.scene_listings), (SELECT count(*) FROM ret0.projects), (SELECT count(*) FROM ret0.hubs), (SELECT count(*) FROM ret0.hub_role_memberships)",
          []
        )

      %Postgrex.Result{
        rows: [
          [
            room_id,
            owner_id,
            listing_id,
            scene_id,
            scene_owner_id,
            project_id,
            project_owner_id,
            model_id,
            screenshot_id,
            scene_file_id,
            project_file_id,
            project_thumbnail_id
          ]
        ]
      } =
        Postgrex.query!(
          peer,
          "SELECT h.hub_id,h.created_by_account_id,h.scene_listing_id,s.scene_id,s.account_id,p.project_id,p.created_by_account_id,s.model_owned_file_id,s.screenshot_owned_file_id,s.scene_owned_file_id,p.project_owned_file_id,p.thumbnail_owned_file_id FROM ret0.hubs h JOIN ret0.scene_listings l ON l.scene_listing_id=h.scene_listing_id JOIN ret0.scenes s ON s.scene_id=l.scene_id JOIN ret0.projects p ON p.scene_id=s.scene_id WHERE h.hub_sid=$1",
          [hub.hub_sid]
        )

      assert [
               room_id,
               owner_id,
               listing_id,
               scene_id,
               scene_owner_id,
               project_id,
               project_owner_id
             ] ==
               [
                 hub.hub_id,
                 room_owner.account_id,
                 listing.scene_listing_id,
                 scene.scene_id,
                 project_owner.account_id,
                 project.project_id,
                 project_owner.account_id
               ]

      assert [model_id, screenshot_id, scene_file_id, project_file_id, project_thumbnail_id] ==
               Enum.map(
                 ["model", "thumbnail", "scene", "project", "thumbnail"],
                 &owned.(&1).owned_file_id
               )

      %Postgrex.Result{rows: [[co_owner_id]]} =
        Postgrex.query!(
          peer,
          "SELECT account_id FROM ret0.hub_role_memberships WHERE hub_id=$1",
          [hub.hub_id]
        )

      assert co_owner_id == co_owner.account_id
    after
      GenServer.stop(peer)
    end

    fresh_hub = Repo.get!(Hub, hub.hub_id) |> Repo.preload(:hub_role_memberships)
    assert fresh_hub.creator_assignment_token == nil
    assert Hub.is_owner?(fresh_hub, room_owner.account_id)
    assert Hub.is_owner?(fresh_hub, co_owner.account_id)
    refute Hub.is_owner?(fresh_hub, project_owner.account_id)
    assert Project.project_by_sid_for_account(project.project_sid, room_owner) == nil
    assert Project.project_by_sid_for_account(project.project_sid, co_owner) == nil
    fresh_project = Project.project_by_sid_for_account(project.project_sid, project_owner)

    assert fresh_project.project_id == project.project_id and
             fresh_project.scene.scene_id == scene.scene_id

    view = RetWeb.Api.V1.ProjectView.render("show.json", %{project: fresh_project})
    assert view.project_id == project.project_sid and view.scene.scene_id == scene.scene_sid
    assert view.scene.project_id == project.project_sid

    for url <- [
          view.project_url,
          view.thumbnail_url,
          view.scene.model_url,
          view.scene.screenshot_url,
          view.scene.scene_project_url,
          view.scene.url
        ],
        do: assert(URI.parse(url).host == "127.0.0.1")

    bindings =
      Map.new(files, fn {kind, {file, expected_hash}} ->
        current = Repo.get!(OwnedFile, file.owned_file_id)
        assert current.account_id == project_owner.account_id and current.state == :active
        {:ok, _, stream} = Storage.fetch(current)

        assert :crypto.hash(:sha256, Enum.to_list(stream) |> IO.iodata_to_binary())
               |> Base.encode16(case: :lower) == expected_hash

        for path <- Storage.paths_for_owned_file(current) |> Enum.drop(1),
            do: File.chmod!(path, 0o600)

        {kind, %{uuid: current.owned_file_uuid, plaintext_sha256: expected_hash}}
      end)

    %{
      scope: "native-synthetic-room-project-graph-not-current-metaverse",
      rooms: 1,
      scenes: 1,
      scene_listings: 1,
      projects: 1,
      co_owner_roles: 1,
      distinct_room_project_owners: true,
      room_sid: hub.hub_sid,
      scene_sid: scene.scene_sid,
      scene_listing_sid: listing.scene_listing_sid,
      project_sid: project.project_sid,
      files: bindings
    }
  end
end
