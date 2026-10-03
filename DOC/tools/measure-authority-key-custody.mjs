import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { canonicalJsonV1, createKeyRecord, inspectKeyRecord }
  from "../../deployment/recovery-checkpoint-authority.mjs";

// One-shot cost attribution, not a functional suite, cold-process measurement,
// real-key operation or end-to-end backup/deploy SLO. Keep synthetic artifacts.
assert.equal(process.argv.length, 2, "no input paths, keys or options are accepted");
const sources = ["recovery-checkpoint-authority.mjs", "private-artifact-publication.mjs"]
  .map(name => fileURLToPath(new URL(`../../deployment/${name}`, import.meta.url)));
const sourceHashes = () => sources.map(file => ({ file,
  sha256: createHash("sha256").update(fs.readFileSync(file)).digest("hex") }));
const before = sourceHashes();
const started = performance.now();
const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "authority-key-custody-cost-"));
fs.chmodSync(directory, 0o700);
const keyringPath = path.join(directory, "synthetic-keyring");
fs.mkdirSync(keyringPath, { mode: 0o700 });
const keyId = "44444444-4444-4444-8444-444444444444";
const keyBytes = Buffer.alloc(32, 41);
const record = createKeyRecord({ keyId, keyBytes });
keyBytes.fill(0);
fs.writeFileSync(path.join(keyringPath, `${keyId}.json`), canonicalJsonV1(record), { mode: 0o600, flag: "wx" });
const preparationMs = performance.now() - started;
const samples = [];
for (let invocation = 1; invocation <= 3; invocation++) {
  const callStarted = performance.now();
  const result = inspectKeyRecord({ keyringPath, keyId });
  assert.equal(result.key_id, keyId);
  samples.push({ invocation, elapsed_ms: performance.now() - callStarted, status: result.status });
}
const after = sourceHashes();
assert.deepEqual(after, before, "measurement must not alter custody sources");
process.stdout.write(JSON.stringify({ status: "MEASURED", synthetic_only: true,
  directory, preparation_ms: preparationMs, samples, total_ms: performance.now() - started,
  source_hashes: before, sources_unchanged: true, python_spawn_count_not_measured: true,
  process_startup_not_included: true, end_to_end_acceptance: false }) + "\n");
