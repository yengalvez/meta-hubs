/** Local native PostgreSQL format proof. Never connects to Kubernetes or production. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, realpath, mkdir, writeFile, readFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir, userInfo } from "node:os";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { sealPortablePoint, openPortablePoint } from "../../deployment/monthly-portable-point.mjs";

process.umask(0o077);
const started = performance.now();
// macOS's default TMPDIR exceeds the Unix socket path limit.
const scratchParent = process.platform === "darwin" ? "/private/tmp" : tmpdir();
const root = await realpath(await mkdtemp(join(scratchParent, "yenhubs-mp-")));
const data = join(root, "postgres-data");
const socket = join(root, "socket");
await mkdir(socket, { mode: 0o700 });
const user = userInfo().username;
const common = ["-h", socket, "-p", "49643", "-U", user];
const run = (program, args, extra = {}) => execFileSync(program, args, {
  encoding: "utf8", timeout: 60000, stdio: ["ignore", "pipe", "pipe"], ...extra
});
const mediaSource = join(root, "media-source");
const runtimeSource = join(root, "runtime-source");
await mkdir(mediaSource, { mode: 0o700 });
await mkdir(runtimeSource, { mode: 0o700 });
const samples = [
  { id: "fixture-avatar", name: "avatar.glb", bytes: Buffer.from("glTF-fixture-not-a-production-avatar") },
  { id: "fixture-thumbnail", name: "thumbnail.bin", bytes: Buffer.from([0, 1, 2, 3, 128, 255]) }
];
for (const item of samples) {
  item.sha256 = createHash("sha256").update(item.bytes).digest("hex");
  await writeFile(join(mediaSource, item.name), item.bytes, { mode: 0o600 });
}
await writeFile(join(runtimeSource, "fixture-settings.json"),
  JSON.stringify({ fixtureOnly: true, bots: false, ai: false, avaturn: false }), { mode: 0o600 });
const identity = join(root, "fixture-only-recovery.key");
run("age-keygen", ["-o", identity]);
await chmod(identity, 0o600);
const recipient = run("age-keygen", ["-y", identity]).trim();
let serverStarted = false;
const timings = {};
try {
  run("initdb", ["-D", data, "--auth=trust", "--encoding=UTF8", "--no-locale"]);
  // Private Unix socket only: no TCP listener and no production credentials.
  run("pg_ctl", ["-D", data, "-l", join(root, "postgres.log"), "-o",
    `-c listen_addresses='' -k ${socket} -p 49643`, "-w", "-t", "30", "start"]);
  serverStarted = true;
  run("createdb", [...common, "proof_source"]);
  const statements = "CREATE TABLE media(id text PRIMARY KEY, filename text, sha256 text);" +
    samples.map(p => `INSERT INTO media VALUES ('${p.id}','${p.name}','${p.sha256}');`).join("");
  run("psql", [...common, "-d", "proof_source", "-v", "ON_ERROR_STOP=1", "-c", statements]);
  const inputs = {
    database: join(root, "database.dump"), media: join(root, "media.tar.gz"), runtime: join(root, "runtime.tar.gz")
  };
  const exportStarted = performance.now();
  run("pg_dump", [...common, "-Fc", "-f", inputs.database, "proof_source"]);
  run("tar", ["-czf", inputs.media, "-C", mediaSource, "."]);
  run("tar", ["-czf", inputs.runtime, "-C", runtimeSource, "."]);
  timings.exportMs = Math.round(performance.now() - exportStarted);
  const sealStarted = performance.now();
  const outputDirectory = join(root, "sealed");
  const receipt = await sealPortablePoint({ inputs, outputDirectory, recipient,
    binding: { instanceId: "local-fixture", month: "2026-10", operationId: "native-postgres-format-proof" } });
  timings.sealMs = Math.round(performance.now() - sealStarted);
  const openStarted = performance.now();
  const opened = join(root, "opened");
  await openPortablePoint({ packageDirectory: outputDirectory, outputDirectory: opened, identityPath: identity });
  timings.openMs = Math.round(performance.now() - openStarted);
  const restoreStarted = performance.now();
  run("createdb", [...common, "proof_restored"]);
  run("pg_restore", [...common, "--exit-on-error", "-d", "proof_restored", join(opened, "database.dump")]);
  const restoredMedia = join(root, "restored-media");
  const restoredRuntime = join(root, "restored-runtime");
  await mkdir(restoredMedia, { mode: 0o700 });
  await mkdir(restoredRuntime, { mode: 0o700 });
  // The archives below are this script's own fixtures, not unknown restore inputs.
  run("tar", ["-xzf", join(opened, "media.tar.gz"), "-C", restoredMedia]);
  run("tar", ["-xzf", join(opened, "runtime.tar.gz"), "-C", restoredRuntime]);
  const query = run("psql", [...common, "-d", "proof_restored", "-At", "-F", "|", "-c",
    "SELECT id,filename,sha256 FROM media ORDER BY id"]);
  const rows = query.trim().split("\n");
  assert.equal(rows.length, samples.length);
  for (const row of rows) {
    const [id, filename, digest] = row.split("|");
    const original = samples.find(p => p.id === id);
    assert.equal(filename, original.name);
    assert.equal(digest, original.sha256);
    const restored = await readFile(join(restoredMedia, filename));
    assert.equal(createHash("sha256").update(restored).digest("hex"), digest);
    assert.deepEqual(restored, original.bytes);
  }
  assert.deepEqual(JSON.parse(await readFile(join(restoredRuntime, "fixture-settings.json"))),
    { fixtureOnly: true, bots: false, ai: false, avaturn: false });
  timings.restoreMs = Math.round(performance.now() - restoreStarted);
  const evidence = { status: "PASS", scope: "local-native-format-only", productionData: false,
    postgresVersion: run("pg_ctl", ["--version"]).trim(), rowCount: rows.length,
    encryptedFiles: Object.keys(receipt.ciphertexts).length, timings,
    totalMs: Math.round(performance.now() - started), fixtureRoot: root };
  await writeFile(join(root, "proof-result.json"), JSON.stringify(evidence, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(evidence));
} finally {
  if (serverStarted) run("pg_ctl", ["-D", data, "-m", "fast", "-w", "-t", "30", "stop"]);
}
