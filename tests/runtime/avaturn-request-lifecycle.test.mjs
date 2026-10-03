// Pure Node contract and real extracted Elixir only; no runtime/DB/provider.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { avaturnRequestEvent } from "./reticulum-local.mjs";

const fixture = fs.readFileSync(new URL("./reticulum-ui-socket.exs", import.meta.url), "utf8");
const startEvent = () => ({ phase: "AVATAR_REQUEST_LIFECYCLE", attempt_count: 1, start_seen: true,
  own_token_equal: true, terminal: "pending", request_down: false, down_reason: "not_observed", failed: false });

test("decoder requires exact one owned start, terminal monotonicity and exact correlated DOWN projection", () => {
  const start = avaturnRequestEvent(startEvent());
  const exception = avaturnRequestEvent({ ...start, terminal: "router_exception" }, start);
  const down = avaturnRequestEvent({ ...exception, request_down: true, down_reason: "abnormal" }, exception);
  assert.equal(down.request_down, true); assert.ok(Object.isFrozen(down));
  const stop = avaturnRequestEvent({ ...start, terminal: "router_stop_200" }, start);
  assert.equal(avaturnRequestEvent({ ...stop, request_down: true, down_reason: "normal" }, stop).terminal, "router_stop_200");
  // Exact DOWN without router evidence is representable diagnostic, not PASS.
  assert.equal(avaturnRequestEvent({ ...start, request_down: true, down_reason: "abnormal" }, start).terminal, "pending");
  for (const patch of [{ attempt_count: 0 }, { attempt_count: 2 }, { own_token_equal: false }, { start_seen: false },
    { failed: true }, { terminal: "error_terminal" }, { terminal: "timeout" }, { down_reason: "killed" },
    { request_down: true }, { pid: 123 }, { token: "MUST_NOT_ESCAPE" }, { conn: {} }, { stacktrace: [] }])
    assert.throws(() => avaturnRequestEvent({ ...start, ...patch }));
  for (const value of [start, exception, down]) assert.throws(() => avaturnRequestEvent(value, value));
  assert.throws(() => avaturnRequestEvent(exception));
  assert.throws(() => avaturnRequestEvent({ ...exception, terminal: "router_stop_200" }, exception));
  assert.throws(() => avaturnRequestEvent(start, exception));
  assert.throws(() => avaturnRequestEvent(down, down));
  assert.throws(() => avaturnRequestEvent(start, {}));
});

test("actual Elixir projection/reducer keeps token, PID, Conn and exceptions private, including monitor race", () => {
  const begin = fixture.indexOf("  # BEGIN PURE AVATAR REQUEST LIFECYCLE");
  const end = fixture.indexOf("  # END PURE AVATAR REQUEST LIFECYCLE", begin);
  assert.ok(begin >= 0 && end > begin);
  const actual = fixture.slice(begin, end);
  const script = `
defmodule Plug.Conn do
  defstruct [:method, :request_path, :state, :status, :private, :req_headers, :assigns, :params, :resp_body]
end
defmodule PureLifecycle do
${actual}
end
token = "MUST_NOT_ESCAPE"
conn = struct(Plug.Conn, method: "POST", request_path: "/api/v1/avatars", state: :unset,
  private: %{phoenix_endpoint: RetWeb.Endpoint, phoenix_router: RetWeb.Router},
  req_headers: [{"authorization", "Bearer " <> token}], assigns: %{}, params: %{secret: token})
meta = %{route: "/api/v1/avatars", plug: RetWeb.Api.V1.AvatarController, plug_opts: :create, conn: conn,
  reason: token, stacktrace: [token], kind: :error}
unless PureLifecycle.avatar_request_projection(meta, token) == %{own_token_equal: true}, do: raise("own_start_not_bound")
for bad <- [put_in(meta.conn.req_headers, []), put_in(meta.conn.req_headers, [{"authorization", "Bearer other"}]),
  put_in(meta.conn.req_headers, [{"authorization", "Bearer " <> token}, {"authorization", "Bearer " <> token}])] do
  unless PureLifecycle.avatar_request_projection(bad, token) == %{own_token_equal: false}, do: raise("unowned_accepted")
end
for bad <- [put_in(meta.route, "/api/v1/avatars/"), put_in(meta.plug, Other.Controller), put_in(meta.plug_opts, :update),
  put_in(meta.conn.method, "GET"), put_in(meta.conn.request_path, "/api/v1/avatars/"),
  put_in(meta.conn.private.phoenix_endpoint, Other.Endpoint), put_in(meta.conn.private.phoenix_router, Other.Router), %{}] do
  unless PureLifecycle.avatar_request_projection(bad, token) == :ignore, do: raise("wrong_source_accepted")
end
config = %{owner: self(), token: token}
PureLifecycle.avatar_request_event([:phoenix, :router_dispatch, :start], %{}, meta, config)
event = receive do value -> value after 0 -> raise("missing_start") end
unless event == {:avatar_request_event, self(), :start, true, :pending}, do: raise("start_not_opaque")
PureLifecycle.avatar_request_event([:phoenix, :router_dispatch, :exception], %{}, meta, config)
exception = receive do value -> value after 0 -> raise("missing_exception") end
unless exception == {:avatar_request_event, self(), :exception, true, :router_exception}, do: raise("exception_not_opaque")
initial = PureLifecycle.avatar_request_initial()
pid = spawn(fn -> receive do :exit -> :ok end end)
state = PureLifecycle.avatar_request_reduce(initial, {:avatar_request_event, pid, :start, true, :pending}, &Process.monitor/1)
unless is_reference(state.monitor) and state.pid == pid and state.count == 1, do: raise("monitor_not_owned")
state = PureLifecycle.avatar_request_reduce(state, {:avatar_request_event, pid, :exception, true, :router_exception}, &Process.monitor/1)
send(pid, :exit)
down = receive do {:DOWN, _, :process, ^pid, _} = value -> value after 1000 -> raise("missing_exact_down") end
state = PureLifecycle.avatar_request_reduce(state, down, &Process.monitor/1)
public = PureLifecycle.avatar_request_public(state)
unless public == %{phase: "AVATAR_REQUEST_LIFECYCLE", attempt_count: 1, start_seen: true, own_token_equal: true,
  terminal: "router_exception", request_down: true, down_reason: "normal", failed: false}, do: raise("down_not_closed")
for bad <- [{:avatar_request_event, self(), :exception, true, :router_exception},
  {:avatar_request_event, pid, :stop, true, :error_terminal}, {:avatar_request_event, pid, :stop, false, :router_stop_200},
  {:DOWN, make_ref(), :process, pid, :normal}, {:DOWN, state.monitor, :process, self(), :normal},
  {:avatar_request_event, pid, :start, true, :pending}] do
  case PureLifecycle.avatar_request_reduce(state, bad, &Process.monitor/1) do
    {%{failed: true}, _} -> :ok
    _ -> raise("bad_event_not_failed")
  end
end
{duplicate, :invalid_start} = PureLifecycle.avatar_request_reduce(state, {:avatar_request_event, pid, :start, true, :pending}, &Process.monitor/1)
unless duplicate.count == 2, do: raise("duplicate_count_hidden")
{unowned, :invalid_start} = PureLifecycle.avatar_request_reduce(initial, {:avatar_request_event, pid, :start, false, :pending}, fn _ -> raise("unowned_monitored") end)
unless unowned.count == 1 and unowned.pid == nil, do: raise("unowned_state_hidden")
# Real process already exited BEFORE manager registers its monitor.
dead = spawn(fn -> :ok end)
ref = Process.monitor(dead)
receive do {:DOWN, ^ref, :process, ^dead, _} -> :ok after 1000 -> raise("dead_fixture_failed") end
race = PureLifecycle.avatar_request_reduce(initial, {:avatar_request_event, dead, :start, true, :pending}, &Process.monitor/1)
race_down = receive do {:DOWN, _, :process, ^dead, _} = value -> value after 1000 -> raise("monitor_race_lost") end
race = PureLifecycle.avatar_request_reduce(race, race_down, &Process.monitor/1)
unless race.down and race.down_reason == :abnormal and race.terminal == :pending, do: raise("race_not_diagnostic")
IO.puts("PURE_LIFECYCLE_PASS")
`;
  const result = spawnSync("elixir", ["-e", script], { encoding: "utf8", timeout: 10000, maxBuffer: 65536,
    env: { PATH: process.env.PATH, LANG: "C" } });
  assert.equal(result.error, undefined); assert.equal(result.signal, null); assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), "PURE_LIFECYCLE_PASS");
  assert.doesNotMatch(result.stdout + result.stderr, /MUST_NOT_ESCAPE/);
});

test("actual manager owns monitor and attaches only native router events with existing generated token", () => {
  assert.ok(fixture.indexOf("attach_avatar_request_observer!(token)") > fixture.indexOf("Ret.Guardian.encode_and_sign(account)"));
  assert.match(fixture, /avatar_request_reduce\(state, event, &Process\.monitor\/1\)/);
  assert.match(fixture, /owner = spawn_link\(fn -> avatar_request_loop/);
  assert.match(fixture, /:telemetry\.attach_many\(handler_id/);
  const pure = fixture.slice(fixture.indexOf("# BEGIN PURE AVATAR REQUEST LIFECYCLE"), fixture.indexOf("# END PURE AVATAR REQUEST LIFECYCLE"));
  assert.doesNotMatch(pure, /Guardian\.Plug|inspect\(|emit\(|metadata\.(reason|stacktrace|kind)|Process\.monitor/);
  assert.ok(fixture.indexOf(":telemetry.detach(request_observer.handler_id)") < fixture.indexOf("Application.stop(:ret)"));
});
