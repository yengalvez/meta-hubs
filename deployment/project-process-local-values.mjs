#!/usr/bin/env node

// Project the large local deployment-values file into the exact private JSON
// keyset accepted by the historical process-local rotation profile. Values are
// never written to stdout/stderr and the destination must be new and private.

import { createHash, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseLocalValuesSource } from "./parse-local-values.mjs";
import {
  canonicalJson,
  loadProcessLocalRotationProfile
} from "./process-local-rotation.mjs";
import { publishPrivateArtifact } from "./private-artifact-publication.mjs";

const MAX_SOURCE_BYTES = 8 * 1024 * 1024;
const FILE_MODE = 0o600;

export class ProcessLocalValuesProjectionError extends Error {
  constructor(code) {
    super(code);
    this.name = "ProcessLocalValuesProjectionError";
    this.code = code;
  }
}

function fail(code) {
  throw new ProcessLocalValuesProjectionError(code);
}

function currentUid() {
  return typeof process.getuid === "function" ? BigInt(process.getuid()) : null;
}

function uidMatches(stat) {
  const uid = currentUid();
  return uid === null || stat.uid === uid;
}

function components(target) {
  const absolute = path.resolve(target);
  const parsed = path.parse(absolute);
  const names = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let current = parsed.root;
  return names.map((name, index) => {
    if (name === "." || name === "..") fail("private_path_invalid");
    current = path.join(current, name);
    let stat;
    try {
      stat = fs.lstatSync(current, { bigint: true });
    } catch {
      fail("private_path_invalid");
    }
    if (stat.isSymbolicLink() || (index < names.length - 1 && !stat.isDirectory())) {
      fail("private_path_invalid");
    }
    return {
      path: current,
      dev: stat.dev,
      ino: stat.ino,
      uid: stat.uid,
      nlink: stat.nlink,
      mode: stat.mode,
      size: stat.size,
      mtimeNs: stat.mtimeNs,
      ctimeNs: stat.ctimeNs,
      file: stat.isFile(),
      directory: stat.isDirectory()
    };
  });
}

function sameComponents(before, after, { leafContent = true } = {}) {
  return before.length === after.length && before.every((entry, index) => {
    const current = after[index];
    const regularLeaf = index === before.length - 1 && entry.file;
    return entry.path === current.path && entry.dev === current.dev &&
      entry.ino === current.ino && entry.uid === current.uid &&
      (!regularLeaf || entry.nlink === current.nlink) && entry.mode === current.mode &&
      entry.file === current.file && entry.directory === current.directory &&
      (!leafContent || index !== before.length - 1 ||
        (entry.size === current.size && entry.mtimeNs === current.mtimeNs &&
         entry.ctimeNs === current.ctimeNs));
  });
}

function sameFileStat(left, right) {
  return left.dev === right.dev && left.ino === right.ino &&
    left.uid === right.uid && left.nlink === right.nlink &&
    left.mode === right.mode && left.size === right.size &&
    left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs &&
    left.isFile() === right.isFile();
}

function readExact(descriptor, size) {
  const bytes = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const count = fs.readSync(descriptor, bytes, offset, size - offset, offset);
    if (count === 0) fail("private_source_changed");
    offset += count;
  }
  const extra = Buffer.alloc(1);
  if (fs.readSync(descriptor, extra, 0, 1, size) !== 0) {
    fail("private_source_changed");
  }
  return bytes;
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest();
}

export function readPrivateProcessLocalValuesSource(sourcePath) {
  if (typeof fs.constants.O_NOFOLLOW !== "number") fail("filesystem_contract_unsupported");
  const absolute = path.resolve(sourcePath);
  let descriptor;
  try {
    const beforeComponents = components(absolute);
    const before = beforeComponents.at(-1)?.file
      ? fs.lstatSync(absolute, { bigint: true })
      : null;
    if (!before?.isFile() || before.isSymbolicLink() || before.nlink !== 1n ||
        !uidMatches(before) || Number(before.mode & 0o7777n) !== FILE_MODE ||
        before.size < 1n || before.size > BigInt(MAX_SOURCE_BYTES)) {
      fail("private_source_invalid");
    }
    descriptor = fs.openSync(absolute, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (!sameFileStat(before, opened)) fail("private_source_invalid");
    const first = readExact(descriptor, Number(opened.size));
    const middle = fs.fstatSync(descriptor, { bigint: true });
    const second = readExact(descriptor, Number(opened.size));
    const after = fs.fstatSync(descriptor, { bigint: true });
    const afterComponents = components(absolute);
    const firstDigest = digest(first);
    const secondDigest = digest(second);
    if (!sameFileStat(opened, middle) || !sameFileStat(opened, after) ||
        !sameComponents(beforeComponents, afterComponents) ||
        !timingSafeEqual(firstDigest, secondDigest)) {
      fail("private_source_changed");
    }
    const text = first.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(first)) fail("private_source_invalid");
    second.fill(0);
    return first;
  } catch (error) {
    if (error instanceof ProcessLocalValuesProjectionError) throw error;
    fail("private_source_invalid");
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch { /* Preserve the primary error. */ }
    }
  }
}

function projectionKeys(profile) {
  const required = [
    profile.namespace_value_key,
    ...profile.secret_keys.filter(name => !profile.derived_secret_keys.includes(name)),
    ...new Set(profile.image_pairs.map(pair => pair.value_key)),
    profile.legacy_image_pull.snapshot_value_key,
    ...profile.legacy_image_pull.verified_image_value_keys
  ];
  return {
    required: [...new Set(required)].sort(),
    optional: [...profile.derived_secret_keys].sort()
  };
}

export function projectProcessLocalValuesMap(
  values,
  profile = loadProcessLocalRotationProfile()
) {
  const { required, optional } = projectionKeys(profile);
  if (required.some(name => !values.has(name))) fail("required_value_missing");
  const projected = {};
  for (const name of required) projected[name] = values.get(name);
  for (const name of optional) {
    if (values.has(name) && values.get(name) !== "") projected[name] = values.get(name);
  }
  return projected;
}

export function projectProcessLocalValues({ sourcePath, outputPath }) {
  let source;
  try {
    source = readPrivateProcessLocalValuesSource(sourcePath);
    let values;
    try {
      values = parseLocalValuesSource(source.toString("utf8"));
    } catch {
      fail("local_values_invalid");
    }
    const projected = projectProcessLocalValuesMap(values);
    publishPrivateArtifact({
      outputPath,
      bytes: Buffer.from(`${canonicalJson(projected)}\n`, "utf8"),
      maximumBytes: MAX_SOURCE_BYTES
    });
    return true;
  } catch (error) {
    if (error instanceof ProcessLocalValuesProjectionError) throw error;
    fail("private_output_invalid");
  } finally {
    if (source) source.fill(0);
  }
}

function main() {
  if (process.argv.length !== 4) {
    process.stderr.write("process-local values projection failed closed\n");
    process.exitCode = 1;
    return;
  }
  try {
    projectProcessLocalValues({
      sourcePath: process.argv[2],
      outputPath: process.argv[3]
    });
  } catch {
    process.stderr.write("process-local values projection failed closed\n");
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
