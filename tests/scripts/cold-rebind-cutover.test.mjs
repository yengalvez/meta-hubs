import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { assertFreshCheckpoint } from "../../deployment/write-cold-rebind-cutover-attestation.mjs";

test("cutover accepts only finite fresh checkpoint dates with explicit clock skew", () => {
  const now = 1789547400000;
  for (const created of [now / 1000, (now - 3600000) / 1000, (now + 30000) / 1000]) {
    assert.doesNotThrow(() => assertFreshCheckpoint({ created_at_epoch: created }, now));
  }
  for (const created of [undefined, null, "1789547400", NaN, Infinity, (now + 31000) / 1000, (now - 86400001) / 1000]) {
    assert.throws(() => assertFreshCheckpoint({ created_at_epoch: created }, now), /checkpoint_date_invalid/);
  }
});

test("cutover uses the existing complete checkpoint layout and generation verifier before signing", () => {
  const source = fs.readFileSync(new URL("../../deployment/write-cold-rebind-cutover-attestation.mjs", import.meta.url), "utf8");
  assert.ok(source.includes('recovery_verify_checkpoint_directory "$1" "$2"'));
  assert.ok(source.indexOf("recovery_verify_checkpoint_directory") < source.indexOf("attestation.hmacSha256"));
});
