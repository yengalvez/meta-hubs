// Pure actual Elixir observer functions with inert Conn/Guardian stubs only.
// Requires the launcher's Elixir/OTP PATH; no Phoenix/backend/HTTP/DB runtime.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";

const fixture = fs.readFileSync(new URL("./reticulum-ui-socket.exs", import.meta.url), "utf8");

test("real Elixir projection filters endpoint/router/method/path/controller/action/state/status/account", () => {
  const start = fixture.indexOf("  # BEGIN PURE AVATAR RESPONSE OBSERVER");
  const end = fixture.indexOf("  # END PURE AVATAR RESPONSE OBSERVER", start);
  assert.ok(start >= 0 && end > start);
  const actualFunctions = fixture.slice(start, end);
  const script = `
defmodule Plug.Conn do
  defstruct [:method, :request_path, :state, :status, :private, :assigns, :resp_body, :req_headers, :params]
end
defmodule Ret.Account do
  defstruct [:account_id]
end
defmodule Guardian.Plug do
  def current_resource(conn), do: conn.assigns.account
end
defmodule PureObserver do
  alias Ret.Account
${actualFunctions}
  defp emit(event), do: send(self(), {:closed_event, event})
end

conn = struct(Plug.Conn, method: "POST", request_path: "/api/v1/avatars", state: :sent, status: 200,
  private: %{phoenix_endpoint: RetWeb.Endpoint, phoenix_router: RetWeb.Router,
    phoenix_controller: RetWeb.Api.V1.AvatarController, phoenix_action: :create,
    private_secret: "MUST_NOT_ESCAPE"},
  assigns: %{account: struct(Ret.Account, account_id: 42)},
  resp_body: "MUST_NOT_ESCAPE", req_headers: [{"authorization", "MUST_NOT_ESCAPE"}], params: %{secret: "MUST_NOT_ESCAPE"})
valid = %{route: "/api/v1/avatars", plug: RetWeb.Api.V1.AvatarController, plug_opts: :create, conn: conn,
  path_params: %{}, pipe_through: [], extra_secret: "MUST_NOT_ESCAPE"}
expected = %{status: 200, controller: "RetWeb.Api.V1.AvatarController", action: "create", owned_account_equal: true}
unless PureObserver.avatar_response_projection(valid, 42) == expected, do: raise("valid_projection_failed")
invalid = [
  Map.put(valid, :route, "/api/v1/avatars/"), Map.put(valid, :plug, Other.Controller), Map.put(valid, :plug_opts, :update),
  put_in(valid.conn.method, "GET"), put_in(valid.conn.request_path, "/api/v1/avatars/"),
  put_in(valid.conn.state, :set), put_in(valid.conn.state, :unset), put_in(valid.conn.status, nil),
  put_in(valid.conn.private.phoenix_endpoint, Other.Endpoint),
  put_in(valid.conn.private.phoenix_router, Other.Router), put_in(valid.conn.private.phoenix_controller, Other.Controller),
  put_in(valid.conn.private.phoenix_action, :update), %{}
]
for metadata <- invalid do
  unless PureObserver.avatar_response_projection(metadata, 42) == :ignore, do: raise("invalid_projection_accepted")
end
for owner <- [0, "42", nil] do
  unless PureObserver.avatar_response_projection(valid, owner) == :ignore, do: raise("invalid_expected_owner_accepted")
end
rejected = [put_in(valid.conn.status, 422), put_in(valid.conn.status, 201),
  put_in(valid.conn.assigns.account, struct(Ret.Account, account_id: 43)), put_in(valid.conn.assigns.account, nil)]
for metadata <- rejected do
  case PureObserver.avatar_response_projection(metadata, 42) do
    {:reject, projection} ->
      unless Enum.sort(Map.keys(projection)) == [:action, :controller, :owned_account_equal, :status], do: raise("rejection_not_closed")
      if projection.status == 200 and projection.owned_account_equal, do: raise("bad_terminal_accepted")
    _ -> raise("bad_terminal_disguised_as_pending")
  end
end
counter = :atomics.new(1, signed: false)
config = %{counter: counter, account_id: 42}
for metadata <- invalid, do: PureObserver.avatar_response_stop([:phoenix, :router_dispatch, :stop], %{}, metadata, config)
unless :atomics.get(counter, 1) == 0, do: raise("rejected_events_changed_counter")
PureObserver.avatar_response_stop([:phoenix, :router_dispatch, :stop], %{}, valid, config)
first = receive do {:closed_event, event} -> event after 0 -> raise("missing_terminal") end
unless first == Map.merge(expected, %{phase: "AVATAR_RESPONSE_STOP", count: 1}), do: raise("first_terminal_not_closed")
PureObserver.avatar_response_stop([:phoenix, :router_dispatch, :stop], %{}, valid, config)
second = receive do {:closed_event, event} -> event after 0 -> raise("missing_duplicate_counter") end
unless second == Map.merge(expected, %{phase: "AVATAR_RESPONSE_STOP", count: 2}), do: raise("duplicate_hidden")
bad_config = %{counter: :atomics.new(1, signed: false), account_id: 42}
PureObserver.avatar_response_stop([:phoenix, :router_dispatch, :stop], %{}, hd(rejected), bad_config)
bad = receive do {:closed_event, event} -> event after 0 -> raise("bad_terminal_not_reported") end
unless bad == Map.merge(expected, %{phase: "AVATAR_RESPONSE_STOP", count: 1, status: 422}), do: raise("bad_terminal_not_closed")
IO.puts("PURE_OBSERVER_PASS")
`;
  assert.ok(typeof process.env.PATH === "string" && process.env.PATH.length > 0, "launcher PATH is required");
  const result = spawnSync("elixir", ["-e", script], { encoding: "utf8", timeout: 10000, maxBuffer: 65536,
    env: { PATH: process.env.PATH, LANG: "C" } });
  assert.equal(result.error, undefined, "pure Elixir interpreter must complete");
  assert.equal(result.signal, null); assert.equal(result.status, 0, "actual extracted observer filters must pass");
  assert.equal(result.stdout.trim(), "PURE_OBSERVER_PASS");
  assert.doesNotMatch(result.stdout + result.stderr, /MUST_NOT_ESCAPE/);
});
