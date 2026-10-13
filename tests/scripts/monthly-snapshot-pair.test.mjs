import { test } from "node:test";
import assert from "node:assert/strict";
import { captureMonthlyPair, nativeSnapshotProvider, validateNativeSnapshot, claimPairJournal } from "../../deployment/monthly-snapshot-pair.mjs";
import { mkdtemp, readFile, stat, realpath, symlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const instant = Date.parse("2026-10-06T12:00:00Z");
const nativeArgs = { volumeId: id(2), name: "fixture-2026-10-database", operationId: "a".repeat(32),
  instanceId: "fixture", month: "2026-10" };
const nativeTags = ["yenhubs-monthly", nativeArgs.instanceId, `month-${nativeArgs.month}`, `operation-${nativeArgs.operationId}`];
const nativeSnapshot = { id: id(10), name: nativeArgs.name, resource_id: nativeArgs.volumeId,
  resource_type: "volume", regions: ["ams3"], min_disk_size: 10, size_gigabytes: 1,
  created_at: new Date(instant).toISOString(), tags: nativeTags };
function fixture() {
  const source = { schema: "yenhubs-monthly-source-v1", state: "inventory-not-captured",
    context: "fixture-context", instanceId: "local-fixture", region: "ams3",
    namespace: { name: "fixture", uid: id(1) },
    volumes: { database: { volumeId: id(2), mountPath: "/var/lib/postgresql/data" }, media: { volumeId: id(3) } },
    postgres: { major: "12", dataPath: "/var/lib/postgresql/data/pgdata",
      walPath: "/var/lib/postgresql/data/pgdata/pg_wal", tablespaceEntries: 0,
      sameWalFilesystem: true, fsync: "on", fullPageWrites: "on", syncAvailable: true } };
  const entries = []; const calls = []; const created = [];
  const provider = {
    async list() { calls.push("list"); return []; },
    async create({ volumeId, name }) {
      calls.push(`create:${volumeId}`);
      const snapshot = { id: id(10 + created.length), name, resource_type: "volume",
        resource_id: volumeId, regions: ["ams3"], min_disk_size: 10, size_gigabytes: 1,
        created_at: new Date(instant).toISOString() };
      created.push(snapshot); return snapshot;
    },
    async get(snapshotId) { calls.push(`get:${snapshotId}`); return created.find(s => s.id === snapshotId); }
  };
  return { args: { source, month: "2026-10", operationId: "a".repeat(32), provider,
    journal: { append: async e => { entries.push(e); calls.push(`journal:${e.event}`); } },
    checkBoundary: async stage => { calls.push(`guard:${stage}`); },
    flush: async () => { calls.push("flush"); }, now: () => instant }, entries, calls, created };
}

test("captures two native points after flush, intent-before-POST and exact readback", async () => {
  const f = fixture(); const result = await captureMonthlyPair(f.args);
  assert.equal(f.created.length, 2);
  assert.equal(result.state, "captured-not-restore-accepted");
  assert.equal(result.acceptance.writersResumed, false);
  assert.equal(result.acceptance.isolatedDigitalOceanRestore, false);
  assert.ok(f.calls.indexOf("flush") < f.calls.indexOf(`create:${id(2)}`));
  for (const role of ["database", "media"]) {
    const intent = f.entries.find(e => e.event === "create-intent" && e.role === role);
    assert.equal(intent.volumeId, role === "database" ? id(2) : id(3));
  }
  assert.equal(f.entries.at(-1).event, "pair-captured");
});

test("existing current-month name prevents a new POST and is reconciliation-only", async () => {
  const f = fixture(); f.args.provider.list = async () => [{ name: "local-fixture-2026-10-media" }];
  await assert.rejects(captureMonthlyPair(f.args), /monthly_point_exists_reconcile_only/);
  assert.equal(f.created.length, 0);
  assert.ok(!f.calls.includes("flush"));
});

test("failed guard before the second snapshot preserves the first and emits no complete pair", async () => {
  const f = fixture(); f.args.checkBoundary = async stage => { if (stage === "media-before-create") throw new Error("guard_failed"); };
  await assert.rejects(captureMonthlyPair(f.args), /monthly_boundary_or_capture_failed/);
  assert.equal(f.created.length, 1);
  assert.equal(f.entries.at(-1).event, "incomplete");
  assert.equal(f.entries.at(-1).observedSnapshots.database.id, id(10));
  assert.ok(!f.entries.some(e => e.event === "pair-captured"));
});

test("an ambiguous POST is never retried and remains durably marked incomplete", async () => {
  const f = fixture(); let posts = 0;
  f.args.provider.create = async () => { posts++; throw new Error("monthly_provider_command_failed_or_ambiguous"); };
  await assert.rejects(captureMonthlyPair(f.args), /monthly_provider_command_failed_or_ambiguous/);
  assert.equal(posts, 1);
  assert.equal(f.entries[1].event, "create-intent");
  assert.equal(f.entries.at(-1).event, "incomplete");
});

test("failure of the media POST preserves the database snapshot without cleanup or retry", async () => {
  const f = fixture(); const original = f.args.provider.create;
  f.args.provider.create = async args => { if (args.volumeId === id(3)) throw new Error("native_failure"); return original(args); };
  await assert.rejects(captureMonthlyPair(f.args), /monthly_boundary_or_capture_failed/);
  assert.equal(f.created.length, 1);
  assert.ok(!f.entries.some(e => e.event === "pair-captured"));
});

test("foreign source/region/type, old timestamp and altered readback are rejected", async () => {
  const f = fixture(); const value = await f.args.provider.create({ volumeId: id(2), name: "expected" });
  const expected = { volumeId: id(2), name: "expected", region: "ams3", since: instant, until: instant };
  for (const delta of [{ resource_id: id(99) }, { regions: ["nyc3"] }, { resource_type: "droplet" }, { id: "" }]) {
    assert.throws(() => validateNativeSnapshot({ ...value, ...delta }, expected), /monthly_snapshot_identity_mismatch/);
  }
  assert.throws(() => validateNativeSnapshot({ ...value, created_at: "2026-09-01T00:00:00Z" }, expected), /monthly_snapshot_time_mismatch/);
  const f2 = fixture(); const get = f2.args.provider.get;
  f2.args.provider.get = async snapshotId => ({ ...await get(snapshotId), min_disk_size: 11 });
  await assert.rejects(captureMonthlyPair(f2.args), /monthly_snapshot_readback_changed/);
});

test("delayed billing statistics during capture do not replace or invalidate snapshot identity", async () => {
  const f = fixture(), get = f.args.provider.get;
  f.args.provider.get = async snapshotId => ({ ...await get(snapshotId), size_gigabytes: 2 });
  const result = await captureMonthlyPair(f.args);
  assert.equal(result.state, "captured-not-restore-accepted");
  assert.equal(f.created.length, 2);
  assert.notEqual(result.snapshots.database.billableGiB, 2);
  assert.equal(f.entries.filter(e => e.event === "readback-verified").length, 2);
});

test("flush failure and final guard failure cannot produce a complete receipt", async () => {
  const f = fixture(); f.args.flush = async () => { throw new Error("flush_failed"); };
  await assert.rejects(captureMonthlyPair(f.args)); assert.equal(f.created.length, 0);
  const f2 = fixture(); f2.args.checkBoundary = async stage => { if (stage === "final-boundary") throw new Error("late_guard_failure"); };
  await assert.rejects(captureMonthlyPair(f2.args)); assert.equal(f2.created.length, 2);
  assert.equal(f2.entries.at(-1).event, "incomplete");
});

test("invalid layout and a foreign month cannot start provider calls", async () => {
  for (const delta of [f => { f.args.source.postgres.fsync = "off"; }, f => { f.args.month = "2026-09"; }]) {
    const f = fixture(); delta(f); await assert.rejects(captureMonthlyPair(f.args)); assert.equal(f.calls.length, 0);
  }
});

test("native adapter uses empty POST output, exact list/GET identity, no retry and bounded output", async () => {
  const calls = []; let posted = false;
  const provider = nativeSnapshotProvider(async (program, args, options) => {
    calls.push({ program, args, options });
    if (args[1] === "volume") { posted = true; return { stdout: "" }; }
    return { stdout: JSON.stringify(posted ? [nativeSnapshot] : []) };
  });
  assert.deepEqual(await provider.list(), []);
  assert.deepEqual(await provider.create(nativeArgs), nativeSnapshot);
  assert.deepEqual(await provider.get(id(10)), nativeSnapshot);
  assert.deepEqual(calls.map(call => call.args.slice(0, 3).join(" ")), ["compute snapshot list", "compute volume snapshot",
    "compute snapshot list", "compute snapshot get", "compute snapshot get"]);
  assert.deepEqual(calls[1].args.slice(0, -4), ["compute", "volume", "snapshot", id(2),
    "--snapshot-name", nativeArgs.name, "--tag", nativeTags.join(",")]);
  for (const call of calls) {
    assert.equal(call.program, "doctl");
    assert.deepEqual(call.args.slice(-4), ["--output", "json", "--http-retry-max", "0"]);
    assert.ok(call.options.timeout > 0 && call.options.timeout <= 30000);
    assert.equal(call.options.maxBuffer, 8 * 1024 * 1024);
  }
  assert.equal(calls[1].options.timeout, 30000);
});

test("native discovery rejects absent, ambiguous, foreign or untagged identities after exactly one POST", async () => {
  for (const values of [[], [nativeSnapshot, { ...nativeSnapshot, id: id(11) }],
    [{ ...nativeSnapshot, name: "other-name" }], [{ ...nativeSnapshot, id: "invalid" }],
    [{ ...nativeSnapshot, resource_id: id(99) }], [{ ...nativeSnapshot, resource_type: "droplet" }],
    ...[undefined, [], nativeTags.slice(1), [...nativeTags, "operation-foreign"], [nativeTags[0], ...nativeTags.slice(0, 3)]]
      .map(tags => [{ ...nativeSnapshot, tags }])]) {
    const calls = [];
    const provider = nativeSnapshotProvider(async (_, args) => {
      calls.push(args.slice(0, 3).join(" "));
      return { stdout: args[1] === "volume" ? "" : JSON.stringify(values) };
    });
    await assert.rejects(provider.create(nativeArgs), /monthly_snapshot_identity_(?:unresolved|mismatch)/);
    assert.deepEqual(calls, ["compute volume snapshot", "compute snapshot list",
      ...(values.length === 1 && values[0].name === nativeArgs.name && /^([a-f0-9-]{36}|[1-9][0-9]*)$/.test(values[0].id) ? ["compute snapshot get"] : [])]);
  }
});

test("native guarded GET preserves the created identity and all exact tags, independent of tag order", async () => {
  for (const delta of [{ id: id(99) }, { name: "other" }, { resource_id: id(99) }, { resource_type: "droplet" },
    { tags: undefined }, { tags: nativeTags.slice(1) }, { tags: [...nativeTags, "operation-foreign"] }]) {
    let gets = 0;
    const provider = nativeSnapshotProvider(async (_, args) => ({ stdout: args[1] === "volume" ? "" :
      JSON.stringify([{ ...nativeSnapshot, ...(args[2] === "get" && ++gets > 1 ? delta : {}) }]) }));
    await provider.create(nativeArgs);
    await assert.rejects(provider.get(id(10)), /monthly_snapshot_identity_mismatch/);
  }
  const provider = nativeSnapshotProvider(async (_, args) => ({ stdout: args[1] === "volume" ? "" :
    JSON.stringify([{ ...nativeSnapshot, tags: [...nativeTags].reverse() }]) }));
  await provider.create(nativeArgs);
  assert.deepEqual((await provider.get(id(10))).tags, [...nativeTags].reverse());
});

test("native nonempty POST output and failed/timeout POST cannot be treated as successful discovery", async () => {
  for (const result of ["[]", JSON.stringify([nativeSnapshot]), " \n",
    Object.assign(new Error("fixture_private_detail"), { code: 1 }),
    Object.assign(new Error("fixture_private_detail"), { killed: true, signal: "SIGTERM" })]) {
    const calls = [];
    const provider = nativeSnapshotProvider(async (_, args) => {
      calls.push(args.slice(0, 3).join(" "));
      if (result instanceof Error) throw result;
      return { stdout: result };
    });
    await assert.rejects(provider.create(nativeArgs), { message: result instanceof Error ?
      "monthly_provider_command_failed_or_ambiguous" : "monthly_provider_response_invalid" });
    assert.deepEqual(calls, ["compute volume snapshot"]);
  }
});

test("failed or malformed native list cannot cause another POST or a fabricated snapshot", async () => {
  for (const result of ["", "{}", "null", new Error("fixture_private_detail")]) {
    const calls = [];
    const provider = nativeSnapshotProvider(async (_, args) => {
      calls.push(args.slice(0, 3).join(" "));
      if (args[1] === "volume") return { stdout: "" };
      if (result instanceof Error) throw result;
      return { stdout: result };
    });
    await assert.rejects(provider.create(nativeArgs), { message: result instanceof Error ?
      "monthly_provider_command_failed_or_ambiguous" : "monthly_provider_response_invalid" });
    assert.deepEqual(calls, ["compute volume snapshot", "compute snapshot list"]);
  }
});

test("native creation and immediate identity discovery share the original total 30-second budget", async t => {
  let clock = 0;
  t.mock.method(performance, "now", () => clock);
  for (const [postMilliseconds, readMilliseconds, accepted] of [[12000, 100, true], [30001, 0, false], [12000, 18001, false]]) {
    clock = 0; const calls = [];
    const provider = nativeSnapshotProvider(async (_, args, options) => {
      calls.push({ args, timeout: options.timeout });
      clock += args[1] === "volume" ? postMilliseconds : readMilliseconds;
      return { stdout: args[1] === "volume" ? "" : JSON.stringify([nativeSnapshot]) };
    });
    if (accepted) assert.deepEqual(await provider.create(nativeArgs), nativeSnapshot);
    else await assert.rejects(provider.create(nativeArgs), /monthly_provider_command_failed_or_ambiguous/);
    assert.equal(calls[0].timeout, 30000);
    assert.equal(calls.filter(call => call.args[1] === "volume").length, 1);
    if (postMilliseconds > 30000) assert.equal(calls.length, 1);
    else { assert.equal(calls.length, accepted ? 3 : 2); assert.equal(calls[1].timeout, 30000 - postMilliseconds);
      if(accepted)assert.equal(calls[2].timeout,30000-postMilliseconds-readMilliseconds); }
  }
});

test("LIST needs only a unique name and ID; canonical GET supplies metadata before acceptance", async()=>{
  const calls=[],observed=[];
  const provider=nativeSnapshotProvider(async(_,args)=>{calls.push(args.slice(0,3).join(" "));
    return {stdout:args[1]==="volume"?"":JSON.stringify(args[2]==="list"?[{id:nativeSnapshot.id,name:nativeSnapshot.name}]:[nativeSnapshot])};});
  assert.deepEqual(await provider.create({...nativeArgs,region:"ams3",observe:async e=>observed.push(e)}),nativeSnapshot);
  assert.deepEqual(calls,["compute volume snapshot","compute snapshot list","compute snapshot get"]);
  assert.equal(observed[0].candidates[0].checks.tags,false);assert.equal(observed[1].candidates[0].checks.tags,true);
});
test("canonical GET uses and cannot exceed the remaining original deadline",async t=>{
  let clock=0;t.mock.method(performance,"now",()=>clock);const calls=[],observed=[];
  const provider=nativeSnapshotProvider(async(_,args,options)=>{
    calls.push({kind:args[2],timeout:options.timeout});clock+=args[1]==="volume"?12000:args[2]==="get"?18001:100;
    return {stdout:args[1]==="volume"?"":JSON.stringify([nativeSnapshot])};
  });
  await assert.rejects(provider.create({...nativeArgs,observe:async e=>observed.push(e)}),/monthly_provider_command_failed_or_ambiguous/);
  assert.equal(calls.length,3);assert.equal(calls[2].timeout,17900);assert.equal(observed.at(-1).view,"canonical");
});
test("malformed region types are recorded, never thrown away by the diagnostic",async()=>{
  for(const regions of ["ams3",{}]){
    const observed=[],value={...nativeSnapshot,regions};
    const provider=nativeSnapshotProvider(async(_,args)=>({stdout:args[1]==="volume"?"":JSON.stringify([value])}));
    const canonical=await provider.create({...nativeArgs,region:"ams3",observe:async e=>observed.push(e)});
    assert.throws(()=>validateNativeSnapshot(canonical,{name:nativeArgs.name,volumeId:nativeArgs.volumeId,region:"ams3",since:instant,until:instant}),/monthly_snapshot_identity_mismatch/);
    assert.equal(observed.at(-1).candidates[0].checks.region,false);
    assert.equal(observed.at(-1).candidates[0].types.regions,typeof regions);
  }
});
test("canonical GET cannot change the discovered ID or lose tags; diagnostic is recorded before rejecting",async()=>{
  for(const change of [{id:id(99)},{tags:[]},{resource_id:id(99)}]){
    const calls=[],observed=[];const provider=nativeSnapshotProvider(async(_,args)=>{
      calls.push(args.slice(0,3).join(" "));return {stdout:args[1]==="volume"?"":JSON.stringify([{...nativeSnapshot,...(args[2]==="get"?change:{})}])};});
    await assert.rejects(provider.create({...nativeArgs,observe:async e=>observed.push(e)}),/monthly_snapshot_identity_mismatch/);
    assert.equal(calls.filter(c=>c==="compute volume snapshot").length,1);
    assert.equal(observed.at(-1).view,"canonical");assert.equal(observed.at(-1).requestedId,nativeSnapshot.id);
    assert.equal(observed.at(-1).candidates[0].id,change.id??nativeSnapshot.id);
  }
});
test("decimal stored size is valid but wrong types are diagnosed before the engine rejects them",async()=>{
  const f=fixture(),observations=[];let created;
  f.args.provider=nativeSnapshotProvider(async(_,args)=>{
    if(args[1]==="volume"){created={...nativeSnapshot,name:args[args.indexOf("--snapshot-name")+1],
      tags:args[args.indexOf("--tag")+1].split(","),size_gigabytes:"0.2888"};return {stdout:""};}
    return {stdout:JSON.stringify(created?[created]:[])};
  });
  const append=f.args.journal.append;f.args.journal.append=async e=>{observations.push(e);await append(e);};
  await assert.rejects(captureMonthlyPair(f.args),/monthly_snapshot_identity_mismatch/);
  const reading=observations.find(e=>e.event==="snapshot-observed"&&e.view==="canonical");
  assert.equal(reading.candidates[0].checks.storedSize,false);assert.equal(reading.candidates[0].types.size_gigabytes,"string");
  assert.equal(reading.role,"database");
  const correct={...nativeSnapshot,size_gigabytes:0.2888};assert.equal(validateNativeSnapshot(correct,
    {name:nativeArgs.name,volumeId:nativeArgs.volumeId,region:"ams3",since:instant,until:instant}).billableGiB,0.2888);
});

test("coordinator fixture persists list/get snapshots and tags while native create stdout stays empty", async () => {
  const execute = promisify(execFile);
  for (const failMedia of [false, true]) {
    const state = await realpath(await mkdtemp(join(tmpdir(), "yenhubs-monthly-provider-")));
    const script = join(state, "doctl");
    await symlink(fileURLToPath(new URL("../recovery/lib/monthly-provider-fixture.cjs", import.meta.url)), script);
    await Promise.all([
      ...["reticulum", "pgbouncer", "pgbouncer-t", "bot-orchestrator", "coturn"].map(writer => ["replicas-" + writer, "0"]),
      ["serialization-lease.json", JSON.stringify({ spec: { holderIdentity: "fixture" } })],
      ["restore-lock.yaml", "{}\n"], ["recovery-operation-fence-binding-state", "active"]
    ].map(([file, bytes]) => writeFile(join(state, file), bytes, { mode: 0o600, flag: "wx" })));
    const native = [];
    const provider = nativeSnapshotProvider(async (program, args, options) => {
      assert.equal(program, "doctl");
      try {
        const result = await execute(process.execPath, [script, ...args], { ...options,
          env: { STUB_STATE_DIR: state, MONTHLY_FIXTURE_CASE: failMedia ? "fail-media" : "success" } });
        native.push({ command: args.slice(0, 3).join(" "), code: 0, stdout: result.stdout }); return result;
      } catch (error) { native.push({ command: args.slice(0, 3).join(" "), code: error.code }); throw error; }
    });
    assert.deepEqual(await provider.list(), []);
    const database = await provider.create({ ...nativeArgs, volumeId: id(4) });
    assert.equal(database.id, "101"); assert.deepEqual(database.tags, nativeTags);
    assert.deepEqual(await provider.get("101"), database);
    const mediaArgs = { ...nativeArgs, volumeId: id(8), name: "fixture-2026-10-media" };
    if (failMedia) await assert.rejects(provider.create(mediaArgs), /monthly_provider_command_failed_or_ambiguous/);
    else assert.equal((await provider.create(mediaArgs)).id, "102");
    assert.deepEqual((await provider.list()).map(value => value.id), failMedia ? ["101"] : ["101", "102"]);
    const posts = native.filter(value => value.command === "compute volume snapshot");
    assert.equal(posts.length, 2);
    assert.equal(posts[0].code, 0); assert.equal(posts[0].stdout, "");
    assert.equal(posts[1].code, failMedia ? 33 : 0);
    if (!failMedia) assert.equal(posts[1].stdout, "");
    const recorded = (await readFile(join(state, "monthly-provider-calls.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
    assert.deepEqual(recorded, [{ event: "snapshot-post", role: "database" }, { event: "snapshot-post", role: "media" }]);
  }
});

test("a real private journal persists ordered intent and cannot overwrite an existing attempt", async () => {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "yenhubs-monthly-journal-")));
  const path = join(parent, "attempt");
  const binding = { instanceId: "fixture", month: "2026-10", operationId: "a".repeat(32) };
  const journal = await claimPairJournal(path, binding);
  try {
    await journal.append({ event: "create-intent", role: "database", volumeId: id(2), month: "override-rejected" });
  } finally { await journal.close(); }
  const values = (await readFile(join(path, "events.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(values.map(v => v.sequence), [1, 2]);
  assert.ok(values.every(v => v.month === "2026-10" && v.operationId === binding.operationId));
  assert.equal((await stat(join(path, "events.jsonl"))).mode & 0o777, 0o600);
  await assert.rejects(claimPairJournal(path, binding), { code: "EEXIST" });
  assert.equal((await readFile(join(path, "events.jsonl"), "utf8")).trim().split("\n").length, 2);
});

test("a failed intent journal prevents POST and a failed failure-record preserves the first reason", async () => {
  const f = fixture(); f.args.journal.append = async e => { if (e.event === "create-intent") throw new Error("disk_full"); };
  await assert.rejects(captureMonthlyPair(f.args)); assert.equal(f.created.length, 0);
  const f2 = fixture(); f2.args.provider.create = async () => { throw new Error("monthly_provider_command_failed_or_ambiguous"); };
  f2.args.journal.append = async e => { if (e.event === "incomplete") throw new Error("second_disk_error"); };
  await assert.rejects(captureMonthlyPair(f2.args), /monthly_provider_command_failed_or_ambiguous/);
});
