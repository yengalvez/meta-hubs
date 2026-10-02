import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("./native-checkpoint-source.mjs", import.meta.url));
const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
function fixture(t) {
  const parent = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "yenhubs-native-source-test-"));
  fs.chmodSync(parent, 0o700); t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const directory = path.join(parent, "20261001-130000"); fs.mkdirSync(directory, { mode: 0o700 });
  const files = {
    "database-contract.json": Buffer.from("{}"),
    "retdb-20261001-130000.sql.gz": zlib.gzipSync(Buffer.from("-- incomplete dump\n")),
    "ret-storage-20261001-130000.tar.gz": Buffer.from("incomplete media")
  };
  for (let i = 0; i < 10; i++) files[`inventory-${i}.json`] = Buffer.from("{}");
  const manifest = () => fs.writeFileSync(path.join(directory, "SHA256SUMS"),
    Object.entries(files).map(([name, bytes]) => `${digest(bytes)}  ${name}\n`).join(""), { mode: 0o600 });
  for (const [name, bytes] of Object.entries(files)) fs.writeFileSync(path.join(directory, name), bytes, { mode: 0o600 });
  manifest();
  function writeArtifact(name, bytes) {
    files[name] = bytes; fs.writeFileSync(path.join(directory, name), bytes, { mode: 0o600 }); manifest();
  }
  const invoke = (options = {}) => spawnSync(process.execPath, [script, "--checkpoint", directory], { encoding: "utf8", timeout: 10000, ...options });
  function rejected(code) {
    const result = invoke(); assert.equal(result.status, 1); assert.equal(result.stdout, "");
    assert.equal(result.stderr, `native_preflight_failed:${code}\n`);
    assert.equal(fs.readdirSync(directory).some(name => /native|restore|postgres|data/.test(name) && name !== "database-contract.json"), false);
  }
  return { parent, directory, invoke, rejected, writeArtifact };
}
test("native source preparation never defaults to a production/private input", () => {
  const result = spawnSync(process.execPath, [script], { encoding: "utf8", timeout: 5000 });
  assert.equal(result.status, 1); assert.equal(result.stdout, "");
  assert.equal(result.stderr, "native_preflight_failed:usage_requires_absolute_checkpoint\n");
});
test("incomplete marker is rejected before any source validation", t => {
  const f = fixture(t); fs.writeFileSync(path.join(f.directory, ".incomplete"), "fixture", { mode: 0o600 });
  f.rejected("incomplete_source");
});
test("mismatched artifact bytes cannot reach SQL/archive preparation", t => {
  const f = fixture(t); fs.appendFileSync(path.join(f.directory, "inventory-0.json"), "changed");
  f.rejected("source_checksum_mismatch");
});
test("symlink artifact cannot be read even when its checksum matches", t => {
  const f = fixture(t), original = path.join(f.directory, "inventory-0.json"), target = path.join(f.directory, "outside.json");
  fs.renameSync(original, target); fs.symlinkSync(target, original); f.rejected("unsafe_source_file");
});
test("checksum traversal cannot select an outside file", t => {
  const f = fixture(t), file = path.join(f.directory, "SHA256SUMS");
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("inventory-0.json", "../outside.json"));
  f.rejected("unsafe_checksum_inventory");
});
test("complete hashes alone cannot bless an incomplete SQL/media pair", t => {
  const f = fixture(t); f.rejected("bounded_validation_failed");
});

test("standalone source binds both source calls to custom-PATH Bash with no inherited startup or PG environment", t => {
  const f = fixture(t), customBin = path.join(f.parent, "custom-bin"), trace = path.join(f.parent, "shell-calls.jsonl");
  fs.mkdirSync(customBin, { mode: 0o700 });
  const executable = path.join(customBin, "bash");
  // Stub only shell validation for this binding test; it is not evidence
  // that this intentionally incomplete SQL fixture satisfies the contract.
  fs.writeFileSync(executable, `#!${process.execPath}\n` +
    `const fs = require("node:fs"), args = process.argv.slice(2), probe = args.some(arg => arg.includes("BASH_VERSINFO"));\n` +
    `fs.appendFileSync(${JSON.stringify(trace)}, JSON.stringify({ executable: process.argv[1], phase: probe ? "version" : "source", inherited: Object.keys(process.env).filter(key => /^(?:PG|BASH_ENV$|ENV$|SHELLOPTS$)/.test(key)) }) + "\\n");\n` +
    `if (probe) process.stdout.write("5.2\\n");\n`, { mode: 0o700 });
  const media = path.join(f.parent, "media"), uuid = "abcdef00-1111-2222-3333-444455556666";
  const shard = path.join(media, "owned/ab/cd"); fs.mkdirSync(shard, { recursive: true, mode: 0o700 });
  for (const suffix of [".blob", ".meta.json"]) fs.writeFileSync(path.join(shard, uuid + suffix), "fixture", { mode: 0o600 });
  const archive = path.join(f.parent, "fixture.tar.gz");
  const tar = spawnSync("/usr/bin/tar", ["-czf", archive, "-C", media, "owned/"], {
    env: { PATH: "/usr/bin:/bin", COPYFILE_DISABLE: "1" }, encoding: "utf8", timeout: 5000
  });
  assert.equal(tar.status, 0, tar.stderr);
  f.writeArtifact("ret-storage-20261001-130000.tar.gz", fs.readFileSync(archive));
  const result = f.invoke({ env: { PATH: customBin, PGSERVICE: "outside", PGPASSWORD: "fixture",
    BASH_ENV: "/fixture/startup", ENV: "/fixture/startup", SHELLOPTS: "xtrace" } });
  assert.equal(result.status, 0, result.stderr);
  const calls = fs.readFileSync(trace, "utf8").trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(calls.map(call => call.phase), ["version", "source", "source"]);
  for (const call of calls) {
    assert.equal(call.executable, executable);
    assert.deepEqual(call.inherited, []);
  }
});
