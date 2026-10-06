import { test } from "node:test";
import assert from "node:assert/strict";
import { captureMonthlyPair, nativeSnapshotProvider, validateNativeSnapshot, claimPairJournal } from "../../deployment/monthly-snapshot-pair.mjs";
import { mkdtemp, readFile, stat, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const instant = Date.parse("2026-10-06T12:00:00Z");
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
  f2.args.provider.get = async snapshotId => ({ ...await get(snapshotId), size_gigabytes: 2 });
  await assert.rejects(captureMonthlyPair(f2.args), /monthly_snapshot_readback_changed/);
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

test("native adapter uses exact GET/POST arguments, no automatic retry and bounded output", async () => {
  const calls = [];
  const provider = nativeSnapshotProvider(async (program, args, options) => {
    calls.push({ program, args, options }); return { stdout: JSON.stringify([{ id: id(10) }]) };
  });
  await provider.create({ volumeId: id(2), name: "fixture-2026-10-database", operationId: "a".repeat(32), instanceId: "fixture", month: "2026-10" });
  await provider.get(id(10));
  assert.deepEqual(calls[0].args.slice(0, 4), ["compute", "volume", "snapshot", id(2)]);
  for (const call of calls) {
    assert.equal(call.program, "doctl");
    assert.deepEqual(call.args.slice(-4), ["--output", "json", "--http-retry-max", "0"]);
    assert.equal(call.options.timeout, 30000);
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
