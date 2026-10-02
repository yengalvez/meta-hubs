// Read-only preparation for a NATIVE LOCAL restoration test, not a checkpoint
// creator, Kubernetes restore command or new production acceptance mechanism.
// Invoke only on an already accepted complete source. Never use failed parts.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { nativeBashArguments, nativeShellEnvironment, resolveNativeBash } from "./native-bash.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const library = path.join(root, "deployment/lib/recovery-safety.sh");
const args = process.argv.slice(2);
let temporary;
function reject(code) { throw new Error(code); }
function privateRegular(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077)) reject("unsafe_source_file");
  return stat;
}
try {
  if (![2, 4].includes(args.length) || args[0] !== "--checkpoint" || !path.isAbsolute(args[1]) ||
      (args.length === 4 && args[2] !== "--native-bash")) reject("usage_requires_absolute_checkpoint");
  const source = fs.realpathSync(args[1]);
  if (source !== args[1]) reject("source_path_not_canonical");
  const stamp = path.basename(source);
  if (!/^\d{8}-\d{6}$/.test(stamp)) reject("source_stamp_invalid");
  const directory = fs.lstatSync(source);
  if (!directory.isDirectory() || directory.uid !== process.getuid() || (directory.mode & 0o077)) reject("unsafe_source_directory");
  if (fs.readdirSync(source).some(name => /partial|incomplete|staging/i.test(name))) reject("incomplete_source");
  privateRegular(path.join(source, "SHA256SUMS"));
  const lines = fs.readFileSync(path.join(source, "SHA256SUMS"), "utf8").trim().split("\n");
  const seen = new Set();
  if (lines.length !== 13) reject("unexpected_artifact_count");
  for (const line of lines) {
    const match = line.match(/^([a-f0-9]{64})  ([A-Za-z0-9._-]+)$/);
    if (!match || match[2].includes("..") || seen.has(match[2])) reject("unsafe_checksum_inventory");
    seen.add(match[2]);
    const file = path.join(source, match[2]); privateRegular(file);
    if (crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex") !== match[1]) reject("source_checksum_mismatch");
  }
  const dumpName = `retdb-${stamp}.sql.gz`, archiveName = `ret-storage-${stamp}.tar.gz`;
  if (![dumpName, archiveName, "database-contract.json"].every(name => seen.has(name))) reject("missing_bound_half");
  const sql = zlib.gunzipSync(fs.readFileSync(path.join(source, dumpName)), { maxOutputLength: 64 * 1024 * 1024 });
  // Restore passes its already selected executable; standalone preparation
  // resolves the caller's PATH once. Never reselect from the sanitized PATH.
  const bashExecutable = resolveNativeBash(process.env.PATH, args[3]);
  const env = nativeShellEnvironment();
  temporary = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "yenhubs-native-preflight-")); fs.chmodSync(temporary, 0o700);
  const sqlPath = path.join(temporary, "dump.sql"); fs.writeFileSync(sqlPath, sql, { mode: 0o600 });
  execFileSync(bashExecutable, nativeBashArguments(library, 'recovery_validate_database_contract_against_dump "$2" "$3"',
    [path.join(source, "database-contract.json"), sqlPath]),
  { env, stdio: ["ignore", "pipe", "pipe"], timeout: 30000 });
  const archive = path.join(source, archiveName);
  const listing = execFileSync("tar", ["-tzf", archive], { env, encoding: "utf8", maxBuffer: 4 * 1024 * 1024, timeout: 30000 });
  execFileSync(bashExecutable, nativeBashArguments(library, "recovery_storage_path_stream_is_exact"),
    { env, input: listing, stdio: ["pipe", "pipe", "pipe"], timeout: 30000 });
  const verbose = execFileSync("tar", ["-tvzf", archive], { env, encoding: "utf8", maxBuffer: 4 * 1024 * 1024, timeout: 30000 });
  if (verbose.trim().split("\n").some(line => !/^[-d]/.test(line))) reject("unsafe_archive_entry_type");
  const names = listing.trim().split("\n"), blobs = names.filter(name => name.endsWith(".blob"));
  const metadata = new Set(names.filter(name => name.endsWith(".meta.json")));
  if (new Set(names).size !== names.length || blobs.length !== metadata.size ||
      blobs.some(name => !metadata.has(name.replace(/\.blob$/, ".meta.json")))) reject("incomplete_media_pairs");
  const extensions = [...sql.toString().matchAll(/^CREATE EXTENSION IF NOT EXISTS "?([a-z0-9_-]+)"? /gm)].map(match => match[1]);
  process.stdout.write(JSON.stringify({ sourceStamp: stamp, verifiedArtifacts: seen.size,
    sqlBytes: sql.length, databaseContract: "PASS", archivePaths: "PASS", archiveEntryTypes: "PASS",
    completeMediaPairs: blobs.length, archiveBytes: fs.statSync(archive).size, extensions,
    scope: "read-only-artifact-preparation-not-native-restore-or-production-acceptance" }) + "\n");
} catch (error) {
  const code = /^[a-z_]{1,60}$/.test(error.message) ? error.message : "bounded_validation_failed";
  process.stderr.write(`native_preflight_failed:${code}\n`); process.exitCode = 1;
} finally {
  if (temporary) fs.rmSync(temporary, { recursive: true, force: true });
}
