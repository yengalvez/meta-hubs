#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const [sourceArgument, destinationArgument, modeArgument] = process.argv.slice(2);
if (!sourceArgument || !destinationArgument) {
  process.stderr.write("private snapshot requires source and destination\n");
  process.exit(2);
}
const allowPublicSource = modeArgument === "--allow-public-source";
if (modeArgument && !allowPublicSource) {
  process.stderr.write("private snapshot received an unsupported mode\n");
  process.exit(2);
}

const source = path.resolve(sourceArgument);
const destination = path.resolve(destinationArgument);

function componentContract(target) {
  const parsed = path.parse(target);
  const components = target.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let current = parsed.root;
  return components.map(component => {
    if (component === "." || component === "..") {
      throw new Error("unsafe path component");
    }
    current = path.join(current, component);
    const stat = fs.lstatSync(current, { bigint: true });
    if (stat.isSymbolicLink()) throw new Error("linked path component");
    return {
      path: current,
      dev: stat.dev,
      ino: stat.ino,
      mode: stat.mode,
      size: stat.size,
      mtimeNs: stat.mtimeNs,
      ctimeNs: stat.ctimeNs,
      directory: stat.isDirectory(),
      file: stat.isFile()
    };
  });
}

function sameContract(before, after) {
  return before.length === after.length && before.every((entry, index) => {
    const current = after[index];
    return entry.path === current.path && entry.dev === current.dev &&
      entry.ino === current.ino && entry.mode === current.mode &&
      entry.directory === current.directory && entry.file === current.file &&
      (index !== before.length - 1 ||
        (entry.size === current.size && entry.mtimeNs === current.mtimeNs &&
         entry.ctimeNs === current.ctimeNs));
  });
}

let sourceHandle;
let destinationHandle;
try {
  const beforeComponents = componentContract(source);
  const beforeLeaf = beforeComponents.at(-1);
  if (!beforeLeaf?.file ||
      (!allowPublicSource && Number(beforeLeaf.mode & 0o777n) !== 0o600)) {
    throw new Error("source is not a private regular file");
  }

  sourceHandle = fs.openSync(source, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  const sourceBefore = fs.fstatSync(sourceHandle, { bigint: true });
  if (!sourceBefore.isFile() ||
      (!allowPublicSource && Number(sourceBefore.mode & 0o777n) !== 0o600) ||
      sourceBefore.dev !== beforeLeaf.dev || sourceBefore.ino !== beforeLeaf.ino) {
    throw new Error("source identity changed before open");
  }

  destinationHandle = fs.openSync(
    destination,
    fs.constants.O_WRONLY | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW
  );
  const destinationStat = fs.fstatSync(destinationHandle, { bigint: true });
  if (!destinationStat.isFile()) throw new Error("destination is not regular");

  const hash = crypto.createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let offset = 0;
  while (true) {
    const bytesRead = fs.readSync(sourceHandle, buffer, 0, buffer.length, offset);
    if (bytesRead === 0) break;
    const chunk = buffer.subarray(0, bytesRead);
    hash.update(chunk);
    let written = 0;
    while (written < bytesRead) {
      written += fs.writeSync(destinationHandle, chunk, written, bytesRead - written);
    }
    offset += bytesRead;
  }
  fs.fsyncSync(destinationHandle);
  fs.fchmodSync(destinationHandle, 0o600);

  const sourceAfter = fs.fstatSync(sourceHandle, { bigint: true });
  const afterComponents = componentContract(source);
  if (!sameContract(beforeComponents, afterComponents) ||
      sourceBefore.dev !== sourceAfter.dev || sourceBefore.ino !== sourceAfter.ino ||
      sourceBefore.size !== sourceAfter.size || sourceBefore.mtimeNs !== sourceAfter.mtimeNs ||
      sourceBefore.ctimeNs !== sourceAfter.ctimeNs || BigInt(offset) !== sourceAfter.size) {
    throw new Error("source changed during snapshot");
  }

  fs.closeSync(destinationHandle);
  destinationHandle = undefined;
  fs.closeSync(sourceHandle);
  sourceHandle = undefined;

  const snapshotHash = crypto.createHash("sha256")
    .update(fs.readFileSync(destination)).digest("hex");
  if (snapshotHash !== hash.digest("hex")) throw new Error("snapshot digest mismatch");
} catch {
  if (destinationHandle !== undefined) fs.closeSync(destinationHandle);
  if (sourceHandle !== undefined) fs.closeSync(sourceHandle);
  try { fs.unlinkSync(destination); } catch {}
  process.stderr.write("private file snapshot failed closed\n");
  process.exit(1);
}
