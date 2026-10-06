/**
 * Portable transport format, not snapshot/restore acceptance.
 * Standard age encryption; no production commands, credentials or cloud writes.
 * A producer must establish a consistent snapshot pair before using this module.
 */
import { constants } from "node:fs";
import { open, lstat, mkdir, realpath, readdir, rename } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { resolve, join } from "node:path";

const payloads = { database: "database.dump", media: "media.tar.gz", runtime: "runtime.tar.gz" };
const digestPattern = /^[a-f0-9]{64}$/;
const bindingPattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

function requireBinding(binding) {
  if (!binding || !bindingPattern.test(binding.instanceId ?? "") ||
      !/^\d{4}-(0[1-9]|1[0-2])$/.test(binding.month ?? "") ||
      !bindingPattern.test(binding.operationId ?? "")) throw new Error("invalid_point_binding");
  // Actual snapshot handles and their evidence stay in the encrypted manifest.
  return structuredClone(binding);
}

async function directDirectory(path) {
  const absolute = resolve(path);
  if (await realpath(absolute) !== absolute) throw new Error("linked_directory");
  const stat = await lstat(absolute);
  if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o077)) {
    throw new Error("unsafe_directory");
  }
  return absolute;
}

async function directFile(path) {
  const absolute = resolve(path);
  if (await realpath(absolute) !== absolute) throw new Error("linked_file");
  const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
  const stat = await handle.stat({ bigint: true });
  if (!stat.isFile() || stat.uid !== BigInt(process.getuid()) || stat.nlink !== 1n ||
      (stat.mode & 0o077n) || stat.size <= 0n || stat.size > BigInt(Number.MAX_SAFE_INTEGER)) {
    await handle.close();
    throw new Error("unsafe_file");
  }
  return { handle, stat, path: absolute };
}

async function hashFile(path) {
  const source = await directFile(path);
  try {
    const hash = createHash("sha256");
    for await (const chunk of source.handle.createReadStream({ start: 0, autoClose: false })) hash.update(chunk);
    const after = await source.handle.stat({ bigint: true });
    for (const key of ["dev", "ino", "size", "mtimeNs", "ctimeNs"]) {
      if (source.stat[key] !== after[key]) throw new Error("file_changed");
    }
    const named = await lstat(source.path, { bigint: true });
    if (named.dev !== after.dev || named.ino !== after.ino) throw new Error("file_replaced");
    return { sha256: hash.digest("hex"), bytes: Number(after.size) };
  } finally { await source.handle.close(); }
}

async function privateJson(path, value) {
  const file = await open(path, "wx", 0o600);
  try { await file.writeFile(JSON.stringify(value, null, 2) + "\n"); await file.sync(); }
  finally { await file.close(); }
}

async function readPrivateJson(path) {
  const source = await directFile(path);
  try {
    if (source.stat.size > 1048576n) throw new Error("oversized_manifest");
    const bytes = await source.handle.readFile();
    const after = await source.handle.stat({ bigint: true });
    if (source.stat.size !== after.size || source.stat.ctimeNs !== after.ctimeNs) throw new Error("file_changed");
    try { return JSON.parse(bytes.toString("utf8")); }
    catch { throw new Error("invalid_json"); }
  } finally { await source.handle.close(); }
}

async function ageFile(args, input, output, identityBytes = null) {
  const source = Buffer.isBuffer(input) ? null : await directFile(input);
  let target;
  let child;
  try {
    target = await open(output, "wx", 0o600);
    // Inherited file descriptors bind the exact opened inodes. No plaintext,
    // identity key or stderr is printed to the caller's terminal.
    child = spawn("age", args, { stdio: [source ? source.handle.fd : "pipe", target.fd, "pipe",
      identityBytes ? "pipe" : "ignore"] });
    child.stderr.resume();
    if (!source) { child.stdin.on("error", () => {}); child.stdin.end(input); }
    if (identityBytes) { child.stdio[3].on("error", () => {}); child.stdio[3].end(identityBytes); }
    const exitCode = await new Promise((accept, reject) => {
      child.once("error", reject);
      child.once("close", accept);
    });
    if (exitCode !== 0) throw new Error("age_failed");
    if (source) {
      const after = await source.handle.stat({ bigint: true });
      for (const key of ["dev", "ino", "size", "mtimeNs", "ctimeNs"]) {
        if (source.stat[key] !== after[key]) throw new Error("source_changed");
      }
    }
    await target.sync();
  } finally {
    if (source) await source.handle.close();
    if (target) await target.close();
  }
}

async function claimDirectory(path) {
  // Validate the existing parent; mkdir is the exclusive attempt claim.
  const absolute = resolve(path);
  const parent = resolve(absolute, "..");
  if (await realpath(parent) !== parent) throw new Error("linked_parent");
  await mkdir(absolute, { mode: 0o700 });
  return directDirectory(absolute);
}

async function commit(directory, name, value) {
  const pending = join(directory, `.${name}.pending`);
  await privateJson(pending, value);
  await rename(pending, join(directory, name));
  const dir = await open(directory, constants.O_RDONLY);
  try { await dir.sync(); } finally { await dir.close(); }
}

export async function sealPortablePoint({ inputs, outputDirectory, recipient, binding }) {
  requireBinding(binding);
  if (typeof recipient !== "string" || !recipient.startsWith("age1")) throw new Error("invalid_recipient");
  if (!inputs || Object.keys(inputs).sort().join() !== Object.keys(payloads).sort().join()) {
    throw new Error("incomplete_payload_set");
  }
  const output = await claimDirectory(outputDirectory);
  const plain = {};
  const ciphertexts = {};
  for (const [kind, filename] of Object.entries(payloads)) {
    const before = await hashFile(inputs[kind]);
    await ageFile(["--encrypt", "--recipient", recipient], inputs[kind], join(output, filename + ".age"));
    const after = await hashFile(inputs[kind]);
    if (before.sha256 !== after.sha256 || before.bytes !== after.bytes) throw new Error("source_changed");
    plain[kind] = { filename, ...before };
    ciphertexts[filename + ".age"] = await hashFile(join(output, filename + ".age"));
  }
  const manifest = { schema: "yenhubs-portable-point-v1", binding, payloads: plain };
  // Manifest plaintext goes directly through stdin, never into the transport
  // directory. Only its ciphertext may be uploaded with the other four files.
  await ageFile(["--encrypt", "--recipient", recipient], Buffer.from(JSON.stringify(manifest)),
    join(output, "manifest.json.age"));
  ciphertexts["manifest.json.age"] = await hashFile(join(output, "manifest.json.age"));
  const receipt = { schema: "yenhubs-portable-transport-v1", state: "sealed-not-restore-accepted",
    instanceId: binding.instanceId, month: binding.month, operationId: binding.operationId, ciphertexts };
  await commit(output, "portable-point.json", receipt);
  return receipt;
}

export async function openPortablePoint({ packageDirectory, outputDirectory, identityPath }) {
  const input = await directDirectory(packageDirectory);
  const expectedNames = [...Object.values(payloads).map(p => p + ".age"), "manifest.json.age", "portable-point.json"];
  if ((await readdir(input)).sort().join() !== expectedNames.sort().join()) throw new Error("unexpected_transport_file");
  const receipt = await readPrivateJson(join(input, "portable-point.json"));
  requireBinding(receipt);
  if (receipt.schema !== "yenhubs-portable-transport-v1" || receipt.state !== "sealed-not-restore-accepted" ||
      Object.keys(receipt.ciphertexts ?? {}).sort().join() !==
      [...Object.values(payloads).map(p => p + ".age"), "manifest.json.age"].sort().join()) {
    throw new Error("invalid_transport_receipt");
  }
  for (const [name, expected] of Object.entries(receipt.ciphertexts)) {
    if (!digestPattern.test(expected.sha256 ?? "") || !Number.isSafeInteger(expected.bytes) || expected.bytes <= 0) {
      throw new Error("invalid_ciphertext_digest");
    }
    const observed = await hashFile(join(input, name));
    if (observed.sha256 !== expected.sha256 || observed.bytes !== expected.bytes) throw new Error("ciphertext_mismatch");
  }
  const identity = await directFile(identityPath);
  if (identity.stat.size > 16384n) { await identity.handle.close(); throw new Error("oversized_identity"); }
  const identityBytes = await identity.handle.readFile();
  await identity.handle.close();
  try {
  const output = await claimDirectory(outputDirectory);
  await ageFile(["--decrypt", "--identity", "/dev/fd/3"], join(input, "manifest.json.age"),
    join(output, "manifest.json"), identityBytes);
  const manifest = await readPrivateJson(join(output, "manifest.json"));
  requireBinding(manifest.binding);
  if (manifest.schema !== "yenhubs-portable-point-v1" ||
      ["instanceId", "month", "operationId"].some(key => receipt[key] !== manifest.binding[key]) ||
      Object.keys(manifest.payloads ?? {}).sort().join() !== Object.keys(payloads).sort().join()) {
    throw new Error("manifest_binding_mismatch");
  }
  for (const [kind, filename] of Object.entries(payloads)) {
    const expected = manifest.payloads[kind];
    if (expected.filename !== filename || !digestPattern.test(expected.sha256 ?? "") ||
        !Number.isSafeInteger(expected.bytes) || expected.bytes <= 0) throw new Error("invalid_payload_manifest");
    await ageFile(["--decrypt", "--identity", "/dev/fd/3"], join(input, filename + ".age"),
      join(output, filename), identityBytes);
    const observed = await hashFile(join(output, filename));
    if (observed.sha256 !== expected.sha256 || observed.bytes !== expected.bytes) throw new Error("plaintext_mismatch");
  }
  await commit(output, "transport-verified.json", {
    schema: "yenhubs-portable-readback-v1", state: "verified-not-restore-accepted", binding: manifest.binding
  });
  return manifest;
  } finally { identityBytes.fill(0); }
}
