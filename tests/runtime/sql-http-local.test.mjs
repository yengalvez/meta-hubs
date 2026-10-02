import test from "node:test";
import assert from "node:assert/strict";
import { runtimeCases } from "./reticulum-local.mjs";
import { integrationNetworkProfile } from "./sql-http-local.mjs";
import { spawnSync } from "node:child_process";

test("SQL HTTP canary selects only two new integrated cases", () => {
  assert.deepEqual(runtimeCases("--sql-http-canary"), [{ profile: "sql-http-canary", count: 2 }]);
  assert.throws(() => runtimeCases("--sql-http-all"), /explicit_native_target_required/);
});

test("integrated confinement permits exactly two owned ports and no wildcard destination", () => {
  const profile = integrationNetworkProfile([55321, 55322]);
  assert.match(profile, /\(deny network\*\)/);
  assert.equal((profile.match(/network-outbound/g) || []).length, 2);
  for (const port of [55321, 55322]) assert.ok(profile.includes(`remote ip "localhost:${port}"`));
  assert.doesNotMatch(profile, /remote ip "localhost:\*"|allow network\*/);
});

test("invalid, duplicate, missing or additional destinations fail closed", () => {
  for (const ports of [undefined, [], [55321], [55321, 55321], [55321, 55322, 55323],
    [55321, 1023], [55321, 65536], [55321, "55322"], [55321, 55322.5], [55321, NaN]]) {
    assert.throws(() => integrationNetworkProfile(ports), /two_distinct_owned_ports_required/);
  }
});

test("integrated CLI cannot default either dependency cache or start an ambiguous target", () => {
  for (const args of [["--sql-http-canary"],
    ["--sql-http-canary", "--pg-bin", "/missing", "--cache-reticulum", "/missing"],
    ["--sql-http-all", "--pg-bin", "/missing", "--cache-reticulum", "/missing", "--cache-bot-orchestrator", "/missing"]]) {
    const result = spawnSync(process.execPath, [new URL("./reticulum-local.mjs", import.meta.url).pathname, ...args], {
      env: { PATH: "/usr/bin:/bin" }, encoding: "utf8", timeout: 5000
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /RET_LOCAL_FAIL:arguments:explicit_native_target_required/);
    assert.equal(result.stdout, "");
  }
});
