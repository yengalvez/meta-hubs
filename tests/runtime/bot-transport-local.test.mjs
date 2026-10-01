import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { outboundProfile, transportCases } from "./bot-transport-local.mjs";

test("native transport canary selects exactly two distinct cases, never old suites", () => {
  assert.deepEqual(transportCases("--canary"), [
    { name: "positive-model", phase: 2, transition: "positive" },
    { name: "ai-off-model", phase: 2, transition: "ai-off" }
  ]);
  assert.deepEqual(transportCases("--boundaries"), [
    { name: "ai-off-input", phase: 1, transition: "ai-off" },
    { name: "ai-off-output", phase: 3, transition: "ai-off" },
    { name: "off-on-model", phase: 2, transition: "off-on" },
    { name: "disconnect-model", phase: 2, transition: "disconnect" }
  ]);
  for (const mode of [undefined, "", "--run", "--all", "--profiles", "--chat-concurrent"]) {
    assert.throws(() => transportCases(mode), /explicit_transport_target_required/);
  }
});

test("owned HTTP confinement permits one literal outbound port only", () => {
  const profile = outboundProfile(55482);
  assert.match(profile, /\(deny network\*\)/);
  assert.equal((profile.match(/network-outbound/g) || []).length, 1);
  assert.match(profile, /network-outbound\(remote ip "localhost:55482"\)/);
  assert.doesNotMatch(profile, /remote ip "localhost:\*"|allow network\*/);
  for (const port of [0, 1023, 65536, "55482", 55482.5, undefined, NaN]) {
    assert.throws(() => outboundProfile(port), /invalid_owned_port/);
  }
});

test("CLI without the explicit native target creates no scratch, server or child", () => {
  const r = spawnSync(process.execPath, [new URL("./bot-transport-local.mjs", import.meta.url).pathname], {
    env: { PATH: "/usr/bin:/bin" }, encoding: "utf8", timeout: 5000
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /BOT_HTTP_FAIL:arguments:explicit_transport_target_required/);
  assert.equal(r.stdout, "");
});
