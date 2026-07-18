#!/usr/bin/env node

// Owner-private, crash-reconcilable publication for durable AUD-065 artifacts.
// A final pathname is never opened for writing: complete fsync'd bytes are
// linked into place with no-clobber semantics, then the directory is fsync'd.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;
const MAX_CLI_BYTES = 64 * 1024 * 1024;
const PYTHON = "python3";
const HELPER_MISSING = 44;
const PENDING_DOMAIN = Buffer.from("yenhubs-private-artifact-pending-v1\0", "utf8");
const DIRFD_HELPER = fileURLToPath(new URL("./private-dirfd-ops.py", import.meta.url));

export class PrivateArtifactPublicationError extends Error {
  constructor(code) {
    super(code);
    this.name = "PrivateArtifactPublicationError";
    this.code = code;
  }
}

function reject(code) {
  throw new PrivateArtifactPublicationError(code);
}

function currentUidMatches(stat) {
  return typeof process.getuid !== "function" || stat.uid === BigInt(process.getuid());
}

function resolvedTarget(target) {
  if (typeof target !== "string" || target.length === 0 || target.includes("\0")) {
    reject("private_artifact_path_invalid");
  }
  return path.resolve(target);
}

function sameNode(left, right) {
  return left.dev === right.dev && left.ino === right.ino &&
    left.uid === right.uid && left.mode === right.mode &&
    left.isFile() === right.isFile() && left.isDirectory() === right.isDirectory();
}

function privateDirectory(stat) {
  return stat?.isDirectory() && !stat.isSymbolicLink() && currentUidMatches(stat) &&
    Number(stat.mode & 0o7777n) === DIRECTORY_MODE;
}

function privateFile(stat, maximumBytes, expectedLinks = 1n, { allowEmpty = false } = {}) {
  return stat?.isFile() && !stat.isSymbolicLink() && currentUidMatches(stat) &&
    Number(stat.mode & 0o7777n) === FILE_MODE && stat.nlink === expectedLinks &&
    (allowEmpty ? stat.size >= 0n : stat.size >= 1n) &&
    stat.size <= BigInt(maximumBytes);
}

function pathComponents(target) {
  const absolute = resolvedTarget(target);
  const parsed = path.parse(absolute);
  const names = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let current = parsed.root;
  return names.map(name => {
    current = path.join(current, name);
    let stat;
    try {
      stat = fs.lstatSync(current, { bigint: true });
    } catch {
      reject("private_artifact_path_invalid");
    }
    if (stat.isSymbolicLink()) reject("private_artifact_path_invalid");
    return { path: current, stat };
  });
}

function openParent(outputPath) {
  if (typeof fs.constants.O_NOFOLLOW !== "number" ||
      typeof fs.constants.O_DIRECTORY !== "number" ||
      typeof fs.constants.O_EXCL !== "number") {
    reject("private_artifact_filesystem_unsupported");
  }
  const absolute = resolvedTarget(outputPath);
  const parentPath = path.dirname(absolute);
  const basename = path.basename(absolute);
  if (!basename || basename === "." || basename === "..") {
    reject("private_artifact_path_invalid");
  }
  const components = pathComponents(parentPath);
  const leaf = components.at(-1)?.stat;
  if (!privateDirectory(leaf)) reject("private_artifact_parent_invalid");
  let descriptor;
  try {
    descriptor = fs.openSync(
      parentPath,
      fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW
    );
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (!privateDirectory(opened) || !sameNode(leaf, opened)) {
      reject("private_artifact_parent_invalid");
    }
    return { absolute, parentPath, basename, components, descriptor, stat: opened };
  } catch (error) {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch { /* Preserve primary error. */ }
    }
    if (error instanceof PrivateArtifactPublicationError) throw error;
    reject("private_artifact_parent_invalid");
  }
}

function closeParent(parent) {
  if (parent?.descriptor !== undefined) {
    try { fs.closeSync(parent.descriptor); } catch { /* Preserve primary result. */ }
  }
}

function helperDirectoryIdentity(parent) {
  return {
    dev: String(parent.stat.dev),
    ino: String(parent.stat.ino),
    uid: String(parent.stat.uid)
  };
}

function helperStatIdentity(stat, { complete = false } = {}) {
  const identity = { dev: String(stat.dev), ino: String(stat.ino) };
  if (!complete) return identity;
  return {
    ...identity,
    uid: String(stat.uid),
    mode: String(stat.mode),
    nlink: String(stat.nlink),
    size: String(stat.size),
    mtimeNs: String(stat.mtimeNs),
    ctimeNs: String(stat.ctimeNs)
  };
}

function decodedHelperStat(value) {
  if (!value || typeof value !== "object") reject("private_artifact_changed");
  const kind = value.kind;
  const result = {
    dev: BigInt(value.dev),
    ino: BigInt(value.ino),
    uid: BigInt(value.uid),
    mode: BigInt(value.mode),
    nlink: BigInt(value.nlink),
    size: BigInt(value.size),
    mtimeNs: BigInt(value.mtimeNs),
    ctimeNs: BigInt(value.ctimeNs),
    isFile: () => kind === "file",
    isDirectory: () => kind === "directory",
    isSymbolicLink: () => kind === "symlink"
  };
  return result;
}

function runDirfdHelper(parent, staging, action, args = {}, {
  input = Buffer.alloc(0),
  maximumOutput = 1024 * 1024,
  allowMissing = false
} = {}) {
  if (!fs.existsSync(DIRFD_HELPER)) {
    reject("private_artifact_filesystem_unsupported");
  }
  const request = JSON.stringify({
    action,
    args,
    target: helperDirectoryIdentity(parent),
    staging: helperDirectoryIdentity(staging)
  });
  const helperInput = Buffer.concat([Buffer.from(`${request}\n`, "utf8"), input]);
  let result;
  try {
    result = spawnSync(PYTHON, ["-I", DIRFD_HELPER], {
      input: helperInput,
      encoding: null,
      maxBuffer: maximumOutput,
      env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
      stdio: ["pipe", "pipe", "pipe", parent.descriptor, staging.descriptor]
    });
  } finally {
    helperInput.fill(0);
  }
  if (allowMissing && result.status === HELPER_MISSING) return undefined;
  if (result.error?.code === "ENOENT") reject("private_artifact_filesystem_unsupported");
  if (result.error || result.signal || result.status !== 0 || !Buffer.isBuffer(result.stdout)) {
    reject("private_artifact_changed");
  }
  return result.stdout;
}

function anchoredStat(parent, staging, directory, name, { allowMissing = false } = {}) {
  const output = runDirfdHelper(parent, staging, "stat", { directory, name }, {
    maximumOutput: 64 * 1024,
    allowMissing
  });
  if (output === undefined) return undefined;
  try {
    return decodedHelperStat(JSON.parse(output.toString("utf8")));
  } catch (error) {
    if (error instanceof PrivateArtifactPublicationError) throw error;
    reject("private_artifact_changed");
  }
}

function anchoredList(parent, staging, directory) {
  try {
    return JSON.parse(runDirfdHelper(parent, staging, "list", { directory }, {
      maximumOutput: 4 * 1024 * 1024
    }).toString("utf8"));
  } catch (error) {
    if (error instanceof PrivateArtifactPublicationError) throw error;
    reject("private_artifact_changed");
  }
}

function anchoredCreate(parent, staging, directory, name, maximumBytes) {
  try {
    return decodedHelperStat(JSON.parse(runDirfdHelper(parent, staging, "create", {
      directory,
      name,
      maximum: maximumBytes
    }, { maximumOutput: 64 * 1024 }).toString("utf8")));
  } catch (error) {
    if (error instanceof PrivateArtifactPublicationError) throw error;
    reject("private_artifact_write_failed");
  }
}

function anchoredWrite(parent, staging, directory, name, created, bytes, maximumBytes) {
  try {
    return decodedHelperStat(JSON.parse(runDirfdHelper(parent, staging, "write", {
      directory,
      name,
      expected: helperStatIdentity(created),
      length: bytes.length,
      maximum: maximumBytes
    }, { input: bytes, maximumOutput: 64 * 1024 }).toString("utf8")));
  } catch (error) {
    if (error instanceof PrivateArtifactPublicationError) throw error;
    reject("private_artifact_write_failed");
  }
}

function anchoredRead(parent, staging, directory, name, maximumBytes, links,
  { allowEmpty = false } = {}) {
  return runDirfdHelper(parent, staging, "read", {
    directory,
    name,
    maximum: maximumBytes,
    links: links.map(String),
    allowEmpty
  }, { maximumOutput: maximumBytes + 64 * 1024 });
}

function anchoredLink(parent, staging, source, destination, expected, maximumBytes) {
  runDirfdHelper(parent, staging, "link", {
    source,
    destination,
    expected: helperStatIdentity(expected, { complete: true }),
    maximum: maximumBytes
  }, {
    maximumOutput: 64 * 1024
  });
}

function anchoredUnlink(parent, staging, directory, name, stat, maximumBytes,
  { allowEmpty = false } = {}) {
  runDirfdHelper(parent, staging, "unlink", {
    directory,
    name,
    expected: helperStatIdentity(stat),
    links: String(stat.nlink),
    maximum: maximumBytes,
    allowEmpty
  }, { maximumOutput: 64 * 1024 });
}

function assertParentStable(parent) {
  let current;
  let opened;
  try {
    current = pathComponents(parent.parentPath);
    opened = fs.fstatSync(parent.descriptor, { bigint: true });
  } catch {
    reject("private_artifact_parent_changed");
  }
  if (current.length !== parent.components.length ||
      current.some((entry, index) => entry.path !== parent.components[index].path ||
        !sameNode(entry.stat, parent.components[index].stat)) ||
      !privateDirectory(opened) || !sameNode(opened, parent.stat)) {
    reject("private_artifact_parent_changed");
  }
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest();
}

function stableRead(parent, maximumBytes, staging = parent) {
  reconcilePublishedArtifact(parent, maximumBytes, staging);
  try {
    assertParentStable(parent);
    const first = anchoredRead(
      parent, staging, "target", parent.basename, maximumBytes, [1]
    );
    assertParentStable(parent);
    return first;
  } catch (error) {
    if (error instanceof PrivateArtifactPublicationError) throw error;
    reject("private_artifact_invalid");
  }
}

function pendingPrefix(parent) {
  return `.${parent.basename}.pending-v1-`;
}

function legacyPendingPrefix(parent) {
  return `.${parent.basename}.pending-`;
}

function pendingAuthenticationTag(nonce, bytes) {
  return createHash("sha256")
    .update(PENDING_DOMAIN)
    .update(Buffer.from(nonce, "hex"))
    .update(bytes)
    .digest();
}

function pendingName(parent, bytes) {
  const nonce = randomBytes(16).toString("hex");
  const tag = pendingAuthenticationTag(nonce, bytes).toString("hex");
  return `${pendingPrefix(parent)}${nonce}-${tag}`;
}

function pendingIdentity(parent, name) {
  const suffix = name.startsWith(pendingPrefix(parent))
    ? name.slice(pendingPrefix(parent).length)
    : "";
  const match = /^([a-f0-9]{32})-([a-f0-9]{64})$/u.exec(suffix);
  if (!match) return undefined;
  return { nonce: match[1], tag: Buffer.from(match[2], "hex") };
}

function openStagingParent(parent, stagingDirectoryPath) {
  if (stagingDirectoryPath === undefined || stagingDirectoryPath === null) return parent;
  const stagingDirectory = resolvedTarget(stagingDirectoryPath);
  if (stagingDirectory === parent.parentPath) return parent;
  return openParent(path.join(stagingDirectory, parent.basename));
}

function assertBothParentsStable(parent, staging) {
  assertParentStable(parent);
  if (staging !== parent) assertParentStable(staging);
}

function authenticatedPendingArtifacts(parent, staging, maximumBytes, requestedBytes) {
  const artifacts = [];
  for (const name of anchoredList(parent, staging, "staging")) {
    const identity = pendingIdentity(parent, name);
    if (!identity) continue;
    const stat = anchoredStat(parent, staging, "staging", name);
    if ((!privateFile(stat, maximumBytes, 1n, { allowEmpty: true }) &&
         !privateFile(stat, maximumBytes, 2n, { allowEmpty: true }))) {
      reject("private_artifact_invalid");
    }
    const bytes = anchoredRead(
      parent,
      staging,
      "staging",
      name,
      maximumBytes,
      [Number(stat.nlink)],
      { allowEmpty: true }
    );
    const expectedTag = pendingAuthenticationTag(identity.nonce, bytes);
    if (!timingSafeEqual(identity.tag, expectedTag)) {
      const attributable = requestedBytes !== undefined &&
        bytes.length < requestedBytes.length &&
        timingSafeEqual(identity.tag, pendingAuthenticationTag(identity.nonce, requestedBytes)) &&
        timingSafeEqual(digest(bytes), digest(requestedBytes.subarray(0, bytes.length)));
      if (!attributable || stat.nlink !== 1n) reject("private_artifact_invalid");
      anchoredUnlink(parent, staging, "staging", name, stat, maximumBytes, {
        allowEmpty: true
      });
      continue;
    }
    artifacts.push({ name, stat, bytes });
  }
  return artifacts;
}

function exactBytes(left, right) {
  return left.length === right.length && timingSafeEqual(digest(left), digest(right));
}

function deletePending(parent, staging, artifact, maximumBytes) {
  const current = anchoredStat(parent, staging, "staging", artifact.name);
  if (!sameNode(artifact.stat, current) || artifact.stat.size !== current.size ||
      artifact.stat.mtimeNs !== current.mtimeNs) {
    reject("private_artifact_changed");
  }
  anchoredUnlink(parent, staging, "staging", artifact.name, current, maximumBytes, {
    allowEmpty: true
  });
}

function legacyLinkedPending(parent, staging, final, maximumBytes) {
  const prefix = legacyPendingPrefix(parent);
  const linked = [];
  for (const name of anchoredList(parent, staging, "staging")) {
    if (!name.startsWith(prefix) ||
        !/^[a-f0-9]{32}$/u.test(name.slice(prefix.length))) {
      continue;
    }
    const stat = anchoredStat(parent, staging, "staging", name);
    if (stat.dev === final.dev && stat.ino === final.ino) {
      if (!privateFile(stat, maximumBytes, 2n) || !sameNode(final, stat) ||
          final.size !== stat.size || final.mtimeNs !== stat.mtimeNs) {
        reject("private_artifact_invalid");
      }
      linked.push({ name, stat });
    }
  }
  return linked;
}

function reconcilePublishedArtifact(parent, maximumBytes, staging = parent, requestedBytes) {
  assertBothParentsStable(parent, staging);
  let final = anchoredStat(
    parent, staging, "target", parent.basename, { allowMissing: true }
  );
  const pending = authenticatedPendingArtifacts(
    parent, staging, maximumBytes, requestedBytes
  );

  if (final === undefined) {
    if (pending.length === 0) return false;
    if (pending.some(artifact => artifact.stat.nlink !== 1n)) {
      reject("private_artifact_invalid");
    }
    let eligible = pending;
    if (requestedBytes !== undefined) {
      eligible = pending.filter(artifact => exactBytes(artifact.bytes, requestedBytes));
      if (eligible.length !== pending.length) reject("private_artifact_exists_mismatch");
      if (eligible.length === 0) return false;
    } else {
      const first = pending[0].bytes;
      if (pending.some(artifact => !exactBytes(artifact.bytes, first))) {
        reject("private_artifact_invalid");
      }
    }
    const selected = eligible[0];
    anchoredLink(
      parent, staging, selected.name, parent.basename, selected.stat, maximumBytes
    );
    final = anchoredStat(parent, staging, "target", parent.basename);
    if (!privateFile(final, maximumBytes, 2n) || !sameNode(selected.stat, final) ||
        final.size !== selected.stat.size || final.mtimeNs !== selected.stat.mtimeNs) {
      reject("private_artifact_changed");
    }
    for (const artifact of pending) {
      const current = anchoredStat(parent, staging, "staging", artifact.name);
      const expectedLinks = artifact === selected ? 2n : 1n;
      if (current.nlink !== expectedLinks) reject("private_artifact_changed");
      deletePending(parent, staging, { ...artifact, stat: current }, maximumBytes);
    }
    const reconciled = anchoredStat(parent, staging, "target", parent.basename);
    if (!privateFile(reconciled, maximumBytes) || !sameNode(final, reconciled) ||
        final.size !== reconciled.size || final.mtimeNs !== reconciled.mtimeNs) {
      reject("private_artifact_changed");
    }
    assertBothParentsStable(parent, staging);
    return true;
  }

  if (!privateFile(final, maximumBytes) && !privateFile(final, maximumBytes, 2n)) {
    reject("private_artifact_invalid");
  }
  const finalBytes = anchoredRead(
    parent, staging, "target", parent.basename, maximumBytes, [Number(final.nlink)]
  );
  const linked = pending.filter(artifact =>
    artifact.stat.dev === final.dev && artifact.stat.ino === final.ino
  );
  const legacy = final.nlink === 2n
    ? legacyLinkedPending(parent, staging, final, maximumBytes)
    : [];
  if (final.nlink === 2n && linked.length + legacy.length !== 1) {
    reject("private_artifact_invalid");
  }
  if (pending.some(artifact => !exactBytes(artifact.bytes, finalBytes))) {
    reject("private_artifact_invalid");
  }
  for (const artifact of pending) {
    if (artifact.stat.dev === final.dev && artifact.stat.ino === final.ino) {
      if (artifact.stat.nlink !== 2n) reject("private_artifact_invalid");
    } else if (artifact.stat.nlink !== 1n) {
      reject("private_artifact_invalid");
    }
    deletePending(parent, staging, artifact, maximumBytes);
  }
  for (const artifact of legacy) {
    deletePending(parent, staging, artifact, maximumBytes);
  }
  const reconciled = anchoredStat(parent, staging, "target", parent.basename);
  if (!privateFile(reconciled, maximumBytes) || !sameNode(final, reconciled) ||
      final.size !== reconciled.size || final.mtimeNs !== reconciled.mtimeNs) {
    reject("private_artifact_changed");
  }
  assertBothParentsStable(parent, staging);
  return pending.length > 0 || legacy.length > 0;
}

function runHook(hooks, name, context) {
  if (hooks?.[name] === undefined) return;
  if (typeof hooks[name] !== "function") reject("private_artifact_hook_invalid");
  hooks[name](Object.freeze({ ...context }));
}

export function publishPrivateArtifact({
  outputPath,
  bytes,
  maximumBytes,
  stagingDirectoryPath,
  hooks
}) {
  if (!Buffer.isBuffer(bytes) || !Number.isSafeInteger(maximumBytes) ||
      maximumBytes < 1 || maximumBytes > MAX_CLI_BYTES ||
      bytes.length < 1 || bytes.length > maximumBytes) {
    reject("private_artifact_input_invalid");
  }
  const parent = openParent(outputPath);
  let staging;
  let created;
  let pendingPath;
  let pendingLeaf;
  let published = false;
  try {
    staging = openStagingParent(parent, stagingDirectoryPath);
    assertBothParentsStable(parent, staging);
    reconcilePublishedArtifact(parent, maximumBytes, staging, bytes);
    const existingStat = anchoredStat(
      parent, staging, "target", parent.basename, { allowMissing: true }
    );
    if (existingStat !== undefined) {
      const existing = stableRead(parent, maximumBytes, staging);
      if (existing.length !== bytes.length ||
          !timingSafeEqual(digest(existing), digest(bytes))) {
        reject("private_artifact_exists_mismatch");
      }
      return false;
    }

    pendingLeaf = pendingName(parent, bytes);
    pendingPath = path.join(staging.parentPath, pendingLeaf);
    created = anchoredCreate(parent, staging, "staging", pendingLeaf, maximumBytes);
    if (!privateFile(created, maximumBytes, 1n, { allowEmpty: true }) ||
        created.size !== 0n) {
      reject("private_artifact_write_failed");
    }
    runHook(hooks, "afterCreate", { outputPath: parent.absolute, pendingPath });
    const written = anchoredWrite(
      parent, staging, "staging", pendingLeaf, created, bytes, maximumBytes
    );
    const readBack = anchoredRead(
      parent, staging, "staging", pendingLeaf, maximumBytes, [1]
    );
    if (!privateFile(written, maximumBytes) || written.size !== BigInt(bytes.length) ||
        !sameNode(created, written) ||
        !timingSafeEqual(digest(bytes), digest(readBack))) {
      reject("private_artifact_write_failed");
    }
    runHook(hooks, "afterFileFsync", { outputPath: parent.absolute, pendingPath });
    assertBothParentsStable(parent, staging);
    const beforeLinkPath = anchoredStat(parent, staging, "staging", pendingLeaf);
    if (!privateFile(beforeLinkPath, maximumBytes) ||
        !sameNode(created, beforeLinkPath) ||
        beforeLinkPath.size !== BigInt(bytes.length) ||
        written.mtimeNs !== beforeLinkPath.mtimeNs) {
      reject("private_artifact_changed");
    }
    runHook(hooks, "beforeLink", { outputPath: parent.absolute, pendingPath });
    anchoredLink(
      parent, staging, pendingLeaf, parent.basename, beforeLinkPath, maximumBytes
    );
    published = true;
    const linkedPending = anchoredStat(parent, staging, "staging", pendingLeaf);
    const linkedFinal = anchoredStat(parent, staging, "target", parent.basename);
    if (!privateFile(linkedPending, maximumBytes, 2n) ||
        !sameNode(created, linkedPending) ||
        !sameNode(created, linkedFinal) ||
        !sameNode(linkedPending, linkedFinal) ||
        linkedPending.size !== linkedFinal.size ||
        linkedPending.mtimeNs !== linkedFinal.mtimeNs) {
      reject("private_artifact_publish_failed");
    }
    runHook(hooks, "afterLink", { outputPath: parent.absolute, pendingPath });
    fs.fsyncSync(parent.descriptor);
    const currentPending = anchoredStat(parent, staging, "staging", pendingLeaf);
    if (!privateFile(currentPending, maximumBytes, 2n) ||
        !sameNode(linkedPending, currentPending) ||
        linkedPending.size !== currentPending.size ||
        linkedPending.mtimeNs !== currentPending.mtimeNs) {
      reject("private_artifact_changed");
    }
    anchoredUnlink(
      parent, staging, "staging", pendingLeaf, currentPending, maximumBytes
    );
    const finalBytes = stableRead(parent, maximumBytes, staging);
    if (finalBytes.length !== bytes.length ||
        !timingSafeEqual(digest(finalBytes), digest(bytes))) {
      reject("private_artifact_publish_failed");
    }
    return true;
  } catch (error) {
    if (pendingLeaf && created && staging) {
      try {
        if (published) fs.fsyncSync(parent.descriptor);
        const leaf = anchoredStat(
          parent, staging, "staging", pendingLeaf, { allowMissing: true }
        );
        if (leaf && leaf.dev === created.dev && leaf.ino === created.ino &&
            leaf.nlink === (published ? 2n : 1n)) {
          anchoredUnlink(parent, staging, "staging", pendingLeaf, leaf, maximumBytes, {
            allowEmpty: true
          });
        }
      } catch { /* Preserve unknown or already-unlinked entries. */ }
    }
    if (published && staging) {
      try {
        const final = anchoredStat(
          parent, staging, "target", parent.basename, { allowMissing: true }
        );
        if (final && final.dev === created.dev && final.ino === created.ino) {
          reconcilePublishedArtifact(parent, maximumBytes, staging);
        }
      } catch { /* Recover later. */ }
    }
    try { fs.fsyncSync(parent.descriptor); } catch { /* Best effort cleanup durability. */ }
    if (staging && staging !== parent) {
      try { fs.fsyncSync(staging.descriptor); } catch { /* Best effort cleanup durability. */ }
    }
    if (error instanceof PrivateArtifactPublicationError) throw error;
    reject("private_artifact_publish_failed");
  } finally {
    if (staging && staging !== parent) closeParent(staging);
    closeParent(parent);
  }
}

export function readPublishedPrivateArtifact({
  outputPath,
  maximumBytes,
  stagingDirectoryPath
}) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 ||
      maximumBytes > MAX_CLI_BYTES) {
    reject("private_artifact_input_invalid");
  }
  const parent = openParent(outputPath);
  let staging;
  try {
    staging = openStagingParent(parent, stagingDirectoryPath);
    return stableRead(parent, maximumBytes, staging);
  } finally {
    if (staging && staging !== parent) closeParent(staging);
    closeParent(parent);
  }
}

function cliMain(argv) {
  if (argv.length !== 2) reject("arguments_invalid");
  const maximumBytes = Number(argv[1]);
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 ||
      maximumBytes > MAX_CLI_BYTES) {
    reject("arguments_invalid");
  }
  const bytes = fs.readFileSync(0);
  publishPrivateArtifact({ outputPath: argv[0], bytes, maximumBytes });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    cliMain(process.argv.slice(2));
  } catch {
    process.stderr.write("private artifact publication failed closed\n");
    process.exitCode = 1;
  }
}
