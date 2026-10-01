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
  for (const [name, bytes] of Object.entries(files)) fs.writeFileSync(path.join(directory, name), bytes, { mode: 0o600 });
  fs.writeFileSync(path.join(directory, "SHA256SUMS"), Object.entries(files).map(([name, bytes]) => `${digest(bytes)}  ${name}\n`).join(""), { mode: 0o600 });
  const invoke = () => spawnSync(process.execPath, [script, "--checkpoint", directory], { encoding: "utf8", timeout: 10000 });
  function rejected(code) {
    const result = invoke(); assert.equal(result.status, 1); assert.equal(result.stdout, "");
    assert.equal(result.stderr, `native_preflight_failed:${code}\n`);
    assert.equal(fs.readdirSync(directory).some(name => /native|restore|postgres|data/.test(name) && name !== "database-contract.json"), false);
  }
  return { directory, rejected };
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
