// Pure Node decoder/harness contracts only; no BEAM dependency.
// No Phoenix, backend, HTTP, DB or browser runtime is started.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { avaturnResponseEvent, creatorSocketCommand } from "./reticulum-local.mjs";

const fixture = fs.readFileSync(new URL("./reticulum-ui-socket.exs", import.meta.url), "utf8");
const runner = fs.readFileSync(new URL("./reticulum-local.mjs", import.meta.url), "utf8");
const terminal = () => ({ phase: "AVATAR_RESPONSE_STOP", count: 1, status: 200,
  controller: "RetWeb.Api.V1.AvatarController", action: "create", owned_account_equal: true });

test("closed reader preserves zero snapshots and accepts exactly one owned controller terminal", () => {
  assert.equal(avaturnResponseEvent({ phase: "AVATAR_RESPONSE_STATE", count: 0 }), 0);
  assert.equal(avaturnResponseEvent({ phase: "AVATAR_RESPONSE_STATE", count: 0 }, 0), 0);
  assert.equal(avaturnResponseEvent(terminal()), 1);
  assert.equal(avaturnResponseEvent({ phase: "AVATAR_RESPONSE_STATE", count: 1 }, 1), 1);
  assert.throws(() => avaturnResponseEvent(terminal(), 1), /invalid_avaturn_response_marker/);
  assert.throws(() => avaturnResponseEvent({ ...terminal(), count: 2 }, 1), /invalid_avaturn_response_marker/);
  for (const patch of [{ status: 201 }, { status: 422 }, { status: "200" }, { count: 0 }, { count: "1" },
    { controller: "OtherController" }, { action: "update" }, { owned_account_equal: false },
    { phase: "STOPPED" }, { conn: {} }, { owner: "secret" }, { token: "secret" }, { path: "/api/v1/avatars" }])
    assert.throws(() => avaturnResponseEvent({ ...terminal(), ...patch }));
  for (const value of [null, [], {}, { phase: "AVATAR_RESPONSE_STATE", count: 1 },
    { phase: "AVATAR_RESPONSE_STATE", count: 0, status: 200 }]) assert.throws(() => avaturnResponseEvent(value));
});

test("fixture hook is Avaturn-only, single-attempt, detachable and reports real zero after committed OFF", () => {
  assert.match(fixture, /response_observer = if avaturn_save, do: attach_avatar_response_observer!\(account\.account_id\)/);
  assert.ok(fixture.indexOf("attach_avatar_response_observer!(account.account_id)") > fixture.indexOf("account = Account.find_or_create_account_for_email(email)"));
  assert.ok(fixture.indexOf("attach_avatar_response_observer!(account.account_id)") < fixture.indexOf('emit(%{phase: "READY"'));
  assert.match(fixture, /:telemetry\.attach\(observer\.handler_id, \[:phoenix, :router_dispatch, :stop\],\s*&__MODULE__\.avatar_response_stop\/4, observer\)/);
  assert.match(fixture, /:atomics\.add_get\(counter, 1, 1\)/);
  assert.match(fixture, /phase: "AVATAR_RESPONSE_STATE", count: :atomics\.get\(observer\.counter, 1\)/);
  assert.doesNotMatch(fixture, /:atomics\.put|\[:phoenix, :endpoint, :stop\]/);
  assert.match(fixture, /apply_creator!\(profile\)\s*emit\(%\{phase: "SQL_APPLIED", profile: profile\}\)\s*emit_avatar_response_state\(response_observer\)/);
  assert.ok(fixture.indexOf(":telemetry.detach(response_observer.handler_id)") < fixture.indexOf("Application.stop(:ret)"));
  const observer = fixture.slice(fixture.indexOf("# BEGIN PURE AVATAR RESPONSE OBSERVER"), fixture.indexOf("# END PURE AVATAR RESPONSE OBSERVER"));
  assert.doesNotMatch(observer, /inspect\(|conn\.(params|resp_body|req_headers)|emit\([^\n]*(metadata|conn)|\.auth_token|\.token/);
});

test("native reader guards actual event branch and keeps commands/deadlines/STOP unchanged", () => {
  assert.match(runner, /\["AVATAR_RESPONSE_STATE", "AVATAR_RESPONSE_STOP"\]\.includes\(event\.phase\) && avaturnSave && ready && !stopRequested/);
  assert.match(runner, /avatarResponseCount = avaturnResponseEvent\(event, avatarResponseCount\)/);
  for (const [name, ms] of [["startup", 120000], ["observation_deadline", 300000], ["stop", 15000]]) {
    const code = name === "observation_deadline" ? `ui_socket_${name}` : `ui_socket_${name}_timeout`;
    assert.ok(runner.includes(`setTimeout(() => fail("${code}"), ${ms})`));
  }
  for (const command of ["CREATOR_OFF", "CREATOR_ON", "STOP"]) assert.equal(creatorSocketCommand(JSON.stringify({ command })), command);
  for (const command of ["RESET", "ARM", "READ_RESPONSE", "GET_COUNT"]) assert.throws(() => creatorSocketCommand(JSON.stringify({ command })));
});
