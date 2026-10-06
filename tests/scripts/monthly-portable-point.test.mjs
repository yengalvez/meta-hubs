import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, readdir, access, chmod, symlink, realpath, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { sealPortablePoint, openPortablePoint } from "../../deployment/monthly-portable-point.mjs";

const binding = { instanceId: "local-fixture", month: "2026-10", operationId: "format-proof" };
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "yenhubs-portable-format-")));
  await chmod(root, 0o700);
  const identity = join(root, "fixture.key");
  execFileSync("age-keygen", ["-o", identity], { stdio: ["ignore", "ignore", "pipe"] });
  await chmod(identity, 0o600);
  const recipient = execFileSync("age-keygen", ["-y", identity], { encoding: "utf8" }).trim();
  const inputs = {};
  for (const kind of ["database", "media", "runtime"]) {
    inputs[kind] = join(root, kind);
    await writeFile(inputs[kind], Buffer.concat([Buffer.from(kind + "\n"), Buffer.alloc(128 * 1024, 17)]), { mode: 0o600 });
  }
  return { root, identity, recipient, inputs, outputDirectory: join(root, "sealed"), binding };
}

test("age roundtrip binds and preserves all three payloads without plaintext in transport", async () => {
  const f = await fixture();
  const receipt = await sealPortablePoint(f);
  assert.equal(receipt.state, "sealed-not-restore-accepted");
  assert.deepEqual((await readdir(f.outputDirectory)).sort(),
    ["database.dump.age", "manifest.json.age", "media.tar.gz.age", "portable-point.json", "runtime.tar.gz.age"]);
  const outputDirectory = join(f.root, "opened");
  const manifest = await openPortablePoint({ packageDirectory: f.outputDirectory, outputDirectory, identityPath: f.identity });
  for (const [kind, expected] of Object.entries(manifest.payloads)) {
    assert.deepEqual(await readFile(join(outputDirectory, expected.filename)), await readFile(f.inputs[kind]));
  }
  assert.equal(JSON.parse(await readFile(join(outputDirectory, "transport-verified.json"))).state,
    "verified-not-restore-accepted");
});

test("a corrupt ciphertext is refused before any output claim", async () => {
  const f = await fixture();
  await sealPortablePoint(f);
  const path = join(f.outputDirectory, "database.dump.age");
  const corrupt = await readFile(path);
  corrupt[corrupt.length - 1] ^= 1;
  await writeFile(path, corrupt);
  const outputDirectory = join(f.root, "opened");
  await assert.rejects(openPortablePoint({ packageDirectory: f.outputDirectory, outputDirectory, identityPath: f.identity }), /ciphertext_mismatch/);
  await assert.rejects(access(outputDirectory));
});

test("wrong recovery identity cannot publish a verified receipt", async () => {
  const f = await fixture();
  await sealPortablePoint(f);
  const wrong = await fixture();
  const outputDirectory = join(f.root, "opened");
  await assert.rejects(openPortablePoint({ packageDirectory: f.outputDirectory, outputDirectory, identityPath: wrong.identity }), /age_failed/);
  await assert.rejects(access(join(outputDirectory, "transport-verified.json")));
});

test("neither sealing nor opening overwrites an existing attempt", async () => {
  const f = await fixture();
  await sealPortablePoint(f);
  const saved = await readFile(join(f.outputDirectory, "portable-point.json"));
  await assert.rejects(sealPortablePoint(f), { code: "EEXIST" });
  assert.deepEqual(await readFile(join(f.outputDirectory, "portable-point.json")), saved);
  const outputDirectory = join(f.root, "opened");
  await openPortablePoint({ packageDirectory: f.outputDirectory, outputDirectory, identityPath: f.identity });
  await assert.rejects(openPortablePoint({ packageDirectory: f.outputDirectory, outputDirectory, identityPath: f.identity }), { code: "EEXIST" });
});

test("missing multimedia is rejected before claiming the destination", async () => {
  const f = await fixture();
  await assert.rejects(sealPortablePoint({ ...f, inputs: { database: f.inputs.database, runtime: f.inputs.runtime } }), /incomplete_payload_set/);
  await assert.rejects(access(f.outputDirectory));
});

test("symlinked input and unexpected plaintext transport files are refused", async () => {
  const f = await fixture();
  const linked = join(f.root, "linked-media");
  await symlink(f.inputs.media, linked);
  await assert.rejects(sealPortablePoint({ ...f, inputs: { ...f.inputs, media: linked } }), /linked_file/);
  const good = await fixture();
  await sealPortablePoint(good);
  await writeFile(join(good.outputDirectory, "accidental-private.txt"), "fixture-only", { mode: 0o600 });
  await assert.rejects(openPortablePoint({ packageDirectory: good.outputDirectory,
    outputDirectory: join(good.root, "opened"), identityPath: good.identity }), /unexpected_transport_file/);
});

test("a linked receipt cannot cause a private file outside the package to be read", async () => {
  const f = await fixture();
  await sealPortablePoint(f);
  const path = join(f.outputDirectory, "portable-point.json");
  await rename(path, join(f.root, "original-receipt.json"));
  await symlink(f.identity, path);
  await assert.rejects(openPortablePoint({ packageDirectory: f.outputDirectory,
    outputDirectory: join(f.root, "opened"), identityPath: f.identity }), /linked_file/);
});

test("invalid receipt JSON is reported without echoing any input bytes", async () => {
  const f = await fixture();
  await sealPortablePoint(f);
  await writeFile(join(f.outputDirectory, "portable-point.json"), "invalid-fixture-DO-NOT-ECHO");
  await assert.rejects(openPortablePoint({ packageDirectory: f.outputDirectory,
    outputDirectory: join(f.root, "opened"), identityPath: f.identity }), error =>
    error.message === "invalid_json" && !String(error).includes("DO-NOT-ECHO"));
});
