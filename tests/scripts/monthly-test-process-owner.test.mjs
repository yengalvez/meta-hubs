import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createMonthlyTestProcessOwner } from "../../deployment/monthly-test-process-owner.mjs";

const settings = { pollMilliseconds: 30, probeTimeoutMilliseconds: 1500,
  parentGraceMilliseconds: 200, descendantGraceMilliseconds: 200, killGraceMilliseconds: 1500 };
async function until(check, milliseconds = 2500) {
  const deadline = performance.now() + milliseconds;
  do { if (await check()) return; await delay(25); } while (performance.now() < deadline);
  throw Error("fixture_deadline");
}
const closeOf = child => once(child, "close").then(([code, signal]) => ({ code, signal }));
const alive = child => child.exitCode === null && child.signalCode === null;

test("real detached descendant survives parent close, then is retired without touching an unrelated process", { timeout: 15000 }, async () => {
  const unrelated = spawn(process.execPath, ["-e", "setTimeout(() => process.exit(93), 10000)"], { stdio: "ignore" });
  const unrelatedClose = closeOf(unrelated);
  const child = spawn(process.execPath, ["-e", `
    const { spawn } = require("node:child_process");
    setTimeout(() => process.exit(94), 10000);
    process.on("message", message => {
      if (message === "spawn") {
        const descendant = spawn(process.execPath, ["-e",
          'process.title="monthly-fixture-renamed";process.on("SIGTERM",()=>{});setTimeout(()=>process.exit(95),10000)'],
          { detached: true, stdio: "ignore" });
        descendant.unref(); process.send({ pid: descendant.pid });
      } else if (message === "close") process.exit(7);
    });
  `], { detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"] });
  const childClose = closeOf(child), owner = createMonthlyTestProcessOwner(child, settings);
  let receipt;
  try {
    await owner.ready;
    const announced = once(child, "message"); child.send("spawn");
    const [{ pid }] = await announced;
    let original;
    await until(async () => {
      original = (await owner.observe()).members.find(row => row.pid === pid);
      return Boolean(original);
    });
    assert.equal(original.pgid, pid); assert.notEqual(original.pgid, child.pid);
    child.send("close");
    assert.deepEqual(await childClose, { code: 7, signal: null });
    assert.doesNotThrow(() => process.kill(pid, 0));
    receipt = await owner.retire();
    assert.equal(receipt.absenceVerified, true, JSON.stringify(receipt));
    assert.equal(receipt.observationUnproven, false);
    assert.equal(receipt.coverage, "observed-lineage");
    assert.ok(receipt.registered >= 2); assert.ok(receipt.termSent >= 1); assert.equal(receipt.killSent, 1);
    assert.deepEqual(receipt.remaining, []);
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    assert.equal(alive(unrelated), true); assert.doesNotThrow(() => process.kill(unrelated.pid, 0));
    assert.equal(await owner.retire(), receipt, "retirement is joined, never duplicated");
  } finally {
    await owner.retire(); owner.close();
    if (alive(child)) child.kill("SIGTERM");
    if (alive(unrelated)) unrelated.kill("SIGTERM");
    await Promise.all([childClose, unrelatedClose]);
  }
  assert.deepEqual(await unrelatedClose, { code: null, signal: "SIGTERM" });
});

test("cooperative TERM runs the original parent's trap and retains its real native exit", { timeout: 10000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "yenhubs-monthly-owner-")), marker = join(directory, "term-observed");
  const child = spawn(process.execPath, ["-e", `
    const fs = require("node:fs");
    process.on("SIGTERM", () => { fs.writeFileSync(process.argv[1], "cooperative"); process.exit(42); });
    setTimeout(() => process.exit(96), 8000);
    process.send("ready");
  `, marker], { detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"] });
  const closed = closeOf(child), childReady = once(child, "message"), owner = createMonthlyTestProcessOwner(child, settings);
  try {
    await owner.ready; await childReady;
    const receipt = await owner.retire();
    assert.equal(receipt.absenceVerified, true, JSON.stringify(receipt));
    assert.equal(receipt.termSent, 1); assert.equal(receipt.killSent, 0);
    assert.deepEqual(await closed, { code: 42, signal: null });
    assert.equal(await readFile(marker, "utf8"), "cooperative");
  } finally { await owner.retire(); owner.close(); if (alive(child)) child.kill("SIGTERM"); await closed; }
});

function fakeRow(pid, parent = process.pid) {
  return { pid, ppid: parent, pgid: pid, uid: process.getuid(), birth: `darwin:100:${pid}`, zombie: false };
}
function frame(request, members, unresolved = []) {
  return { members, unresolved, absent: request.known.filter(original =>
    ![...members, ...unresolved].some(row => row.pid === original.pid && row.birth === original.birth)) };
}

test("command-name changes keep the same birth identity; cleanup never targets an unrelated PID or PGID", async () => {
  const root = fakeRow(10001), descendant = fakeRow(10002, root.pid), signals = [];
  let rows = [root, descendant], calls = 0;
  const native = async request => {
    if (request.action === "observe") {
      calls++;
      return frame(request, rows.map(row => ({ ...row, comm: calls === 1 ? "node" : "renamed-after-exec" })));
    }
    signals.push(request);
    rows = rows.filter(row => !request.members.some(member => member.pid === row.pid));
    return { outcomes: request.members.map(() => "sent") };
  };
  const owner = createMonthlyTestProcessOwner({ pid: root.pid }, { ...settings, native });
  await owner.ready; await owner.observe();
  const result = await owner.retire();
  assert.equal(result.absenceVerified, true); assert.equal(result.registered, 2);
  assert.deepEqual(signals.map(call => call.members.map(row => row.pid)), [[root.pid], [descendant.pid]]);
  assert.ok(signals.every(call => call.signal === "SIGTERM" && call.members.every(row => row.pid > 0 && !Object.hasOwn(row, "comm"))));
});

test("PID reuse is never adopted, and unproved observation remains fail-closed after apparent disappearance", async () => {
  const original = fakeRow(10001); let rows = [original], phase = 0, signals = 0;
  const native = async request => {
    if (request.action === "signal") { signals++; return { outcomes: request.members.map(() => "changed_or_absent") }; }
    if (phase === 1) return { members: [{ ...original, birth: "darwin:101:1", pgid: 20001 }], absent: [], unresolved: [] };
    return frame(request, rows);
  };
  const owner = createMonthlyTestProcessOwner({ pid: original.pid }, { ...settings, native });
  await owner.ready; phase = 1;
  await assert.rejects(owner.observe(), /ownership_unproven/);
  phase = 2; rows = [];
  const result = await owner.retire();
  assert.equal(result.absenceVerified, false); assert.equal(result.observationUnproven, true);
  assert.equal(signals, 0); assert.deepEqual(result.remaining, []);
});

test("missing first identity, observation failure and surviving originals produce bounded failure", async () => {
  for (const mode of ["missing-first", "failed-observation", "survives"]) {
    const original = fakeRow(10001); let calls = 0;
    const native = async request => {
      if (request.action === "signal") return { outcomes: request.members.map(() => "changed_or_absent") };
      calls++;
      if (mode === "failed-observation" && calls > 1) throw Error("PRIVATE-ERROR-MUST-NOT-ESCAPE");
      return frame(request, mode === "missing-first" ? [] : [original]);
    };
    const owner = createMonthlyTestProcessOwner({ pid: original.pid }, {
      pollMilliseconds: 10, probeTimeoutMilliseconds: 10, parentGraceMilliseconds: 10,
      descendantGraceMilliseconds: 10, killGraceMilliseconds: 10, native
    });
    if (mode === "missing-first") await assert.rejects(owner.ready, /ownership_unproven/); else await owner.ready;
    const began = performance.now(), result = await owner.retire();
    assert.equal(result.absenceVerified, false); assert.ok(performance.now() - began < 1000);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE-ERROR/);
    if (mode === "survives") assert.deepEqual(result.remaining.map(row => row.pid), [original.pid]);
  }
});

test("more than 512 confirmed retired identities do not exhaust the live tracking bound", async () => {
  const root = fakeRow(10001); let rows = [root];
  const native = async request => {
    if (request.action === "observe") return frame(request, rows);
    rows = rows.filter(row => !request.members.some(member => member.pid === row.pid));
    return { outcomes: request.members.map(() => "sent") };
  };
  const owner = createMonthlyTestProcessOwner({ pid: root.pid }, { ...settings, native });
  await owner.ready;
  for (let index = 0; index < 600; index++) {
    rows = [root, fakeRow(11000 + index, root.pid)];
    const observation = await owner.observe();
    assert.equal(observation.tracking, 2); assert.equal(observation.unproven, false);
  }
  const result = await owner.retire();
  assert.equal(result.registered, 601); assert.equal(result.absenceVerified, true);
});

test("brief real process churn retires ephemeral ancestors without permanently poisoning ownership", { timeout: 15000 }, async () => {
  const intermediate = `const {spawn}=require("node:child_process");
    const child=spawn(process.execPath,["-e","setTimeout(()=>process.exit(0),200)"],{detached:true,stdio:"ignore"});
    child.unref(); setTimeout(()=>process.exit(0),120);`;
  const child = spawn(process.execPath, ["-e", `
    const {spawn}=require("node:child_process");
    setTimeout(()=>process.exit(97),10000);
    process.on("message",()=>{
      let launched=0, closed=0; const exits=[];
      function next(){
        if(launched===32)return;
        launched++;
        const child=spawn(process.execPath,["-e",${JSON.stringify(intermediate)}],{stdio:"ignore"});
        child.once("close",(code,signal)=>{
          exits.push({code,signal}); closed++;
          if(closed===32)process.send(exits);else next();
        });
      }
      for(let i=0;i<4;i++)next();
    });
  `], { detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"] });
  const closed = closeOf(child), owner = createMonthlyTestProcessOwner(child, settings);
  try {
    await owner.ready;
    const done = once(child, "message"); child.send("churn");
    const [exits] = await done;
    assert.equal(exits.length, 32); assert.ok(exits.every(result => result.code === 0 && result.signal === null));
    await until(async () => {
      const result = await owner.observe();
      assert.equal(result.unproven, result.unattributed.length > 0);
      return result.members.length === 1 && result.unattributed.length === 0;
    });
    const receipt = await owner.retire();
    assert.equal(receipt.absenceVerified, true, JSON.stringify(receipt));
    assert.equal(receipt.observationUnproven, false); assert.ok(receipt.registered > 2);
    assert.deepEqual(await closed, { code: null, signal: "SIGTERM" });
  } finally { await owner.retire(); owner.close(); if (alive(child)) child.kill("SIGTERM"); await closed; }
});
