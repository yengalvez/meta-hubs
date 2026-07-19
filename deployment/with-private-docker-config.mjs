// Materialize a Docker config only for the lifetime of one callback. The
// credential bytes never enter argv, environment variables or module output.

import { randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const MAX_CONFIG_BYTES = 8 * 1024 * 1024;
const MAX_DIRECTORY_ATTEMPTS = 16;
const CONFIG_NAME = "config.json";
const DIRECTORY_PREFIX = ".yenhubs-docker-config-";
const PARENT_IDENTITY_KEYS = Object.freeze([
  "dev", "gid", "ino", "mode", "uid"
]);
const HOOK_NAMES = new Set([
  "afterDirectoryCreated",
  "afterConfigCreated",
  "afterConfigFsync",
  "afterCallback"
]);

export class PrivateDockerConfigError extends Error {
  constructor(code) {
    super(code);
    this.name = "PrivateDockerConfigError";
    this.code = code;
  }
}

function fail(code) {
  throw new PrivateDockerConfigError(code);
}

function privateError(error, code) {
  return error instanceof PrivateDockerConfigError
    ? error
    : new PrivateDockerConfigError(code);
}

function currentUid() {
  if (typeof process.getuid !== "function") fail("filesystem_contract_unsupported");
  return BigInt(process.getuid());
}

function requireFilesystemSupport() {
  if (typeof fs.constants.O_NOFOLLOW !== "number" ||
      typeof fs.constants.O_DIRECTORY !== "number" ||
      typeof fs.constants.O_EXCL !== "number") {
    fail("filesystem_contract_unsupported");
  }
}

function checkedParentPath(value) {
  if (typeof value !== "string" || !path.isAbsolute(value) ||
      path.resolve(value) !== value || /[\u0000\r\n]/u.test(value)) {
    fail("private_parent_invalid");
  }
  return value;
}

function pathComponents(absolute, code) {
  const parsed = path.parse(absolute);
  const names = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean);
  if (names.length === 0) fail(code);
  let current = parsed.root;
  return names.map(name => {
    current = path.join(current, name);
    let stat;
    try {
      stat = fs.lstatSync(current, { bigint: true });
    } catch {
      fail(code);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail(code);
    return { path: current, stat };
  });
}

function sameDirectoryIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino &&
    left.uid === right.uid && left.gid === right.gid &&
    left.mode === right.mode && left.isDirectory() === right.isDirectory() &&
    left.isSymbolicLink() === right.isSymbolicLink();
}

function directoryIdentity(stat) {
  return Object.freeze(Object.fromEntries(PARENT_IDENTITY_KEYS.map(key => [
    key,
    stat[key].toString(10)
  ])));
}

function checkedParentIdentity(value) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(PARENT_IDENTITY_KEYS) ||
      PARENT_IDENTITY_KEYS.some(key =>
        typeof value[key] !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(value[key])
      )) {
    fail("private_parent_identity_invalid");
  }
  return value;
}

function matchesParentIdentity(stat, expected) {
  if (expected === undefined) return true;
  const actual = directoryIdentity(stat);
  return PARENT_IDENTITY_KEYS.every(key => actual[key] === expected[key]);
}

function sameComponents(left, right) {
  return left.length === right.length && left.every((entry, index) =>
    entry.path === right[index].path &&
    sameDirectoryIdentity(entry.stat, right[index].stat)
  );
}

function sameFileStat(left, right) {
  return left.dev === right.dev && left.ino === right.ino &&
    left.uid === right.uid && left.gid === right.gid &&
    left.mode === right.mode && left.nlink === right.nlink &&
    left.size === right.size && left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    left.isFile() === right.isFile() &&
    left.isSymbolicLink() === right.isSymbolicLink();
}

function sameInode(left, right) {
  return Boolean(left && right) && left.dev === right.dev && left.ino === right.ino;
}

function ownerPrivateDirectory(stat) {
  return stat?.isDirectory() && !stat.isSymbolicLink() &&
    stat.uid === currentUid() && Number(stat.mode & 0o7777n) === DIRECTORY_MODE;
}

function ownerPrivateFile(stat, exactSize) {
  return stat?.isFile() && !stat.isSymbolicLink() &&
    stat.uid === currentUid() && stat.nlink === 1n &&
    Number(stat.mode & 0o7777n) === FILE_MODE &&
    stat.size === BigInt(exactSize);
}

function openPrivateParent(privateParentDirectory, expectedIdentity) {
  const components = pathComponents(privateParentDirectory, "private_parent_invalid");
  const leaf = components.at(-1).stat;
  let descriptor;
  try {
    if (!ownerPrivateDirectory(leaf)) fail("private_parent_invalid");
    descriptor = fs.openSync(
      privateParentDirectory,
      fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW
    );
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (!ownerPrivateDirectory(opened) || !sameDirectoryIdentity(leaf, opened) ||
        !matchesParentIdentity(opened, expectedIdentity)) {
      fail("private_parent_invalid");
    }
    return { absolute: privateParentDirectory, components, stat: opened, descriptor };
  } catch (error) {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch { /* Preserve the value-free error. */ }
    }
    throw privateError(error, "private_parent_invalid");
  }
}

function assertParentStable(parent) {
  try {
    const pathState = pathComponents(parent.absolute, "private_parent_changed");
    const opened = fs.fstatSync(parent.descriptor, { bigint: true });
    if (!ownerPrivateDirectory(opened) ||
        !sameDirectoryIdentity(parent.stat, opened) ||
        !sameComponents(parent.components, pathState)) {
      fail("private_parent_changed");
    }
  } catch (error) {
    throw privateError(error, "private_parent_changed");
  }
}

function createPrivateDirectory(parent, directory) {
  for (let attempt = 0; attempt < MAX_DIRECTORY_ATTEMPTS; attempt += 1) {
    let suffix;
    try {
      suffix = randomBytes(16).toString("hex");
    } catch {
      fail("random_source_failed");
    }
    const directoryPath = path.join(parent.absolute, `${DIRECTORY_PREFIX}${suffix}`);
    try {
      fs.mkdirSync(directoryPath, { mode: DIRECTORY_MODE });
      directory.stat = fs.lstatSync(directoryPath, { bigint: true });
      return directoryPath;
    } catch (error) {
      if (error?.code !== "EEXIST") fail("private_directory_create_failed");
    }
  }
  fail("private_directory_create_failed");
}

function openCreatedDirectory(directoryPath, directory) {
  try {
    const before = directory.stat || fs.lstatSync(directoryPath, { bigint: true });
    directory.stat = before;
    directory.descriptor = fs.openSync(
      directoryPath,
      fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW
    );
    const initiallyOpened = fs.fstatSync(directory.descriptor, { bigint: true });
    if (!before.isDirectory() || before.isSymbolicLink() ||
        !sameInode(before, initiallyOpened) || initiallyOpened.uid !== currentUid()) {
      fail("private_directory_invalid");
    }
    fs.fchmodSync(directory.descriptor, DIRECTORY_MODE);
    const opened = fs.fstatSync(directory.descriptor, { bigint: true });
    const after = fs.lstatSync(directoryPath, { bigint: true });
    if (!ownerPrivateDirectory(opened) ||
        !sameInode(before, opened) ||
        !sameDirectoryIdentity(opened, after)) {
      fail("private_directory_invalid");
    }
    directory.stat = opened;
    return directory;
  } catch (error) {
    throw privateError(error, "private_directory_invalid");
  }
}

function assertDirectoryStable(parent, directoryPath, directory) {
  assertParentStable(parent);
  try {
    const opened = fs.fstatSync(directory.descriptor, { bigint: true });
    const named = fs.lstatSync(directoryPath, { bigint: true });
    if (!ownerPrivateDirectory(opened) ||
        !sameDirectoryIdentity(directory.stat, opened) ||
        !sameDirectoryIdentity(directory.stat, named)) {
      fail("private_docker_config_changed");
    }
  } catch (error) {
    throw privateError(error, "private_docker_config_changed");
  }
}

function checkedHooks(hooks) {
  if (hooks === undefined) return undefined;
  if (!hooks || typeof hooks !== "object" || Array.isArray(hooks) ||
      Object.keys(hooks).some(name => !HOOK_NAMES.has(name) ||
        typeof hooks[name] !== "function")) {
    fail("private_docker_config_hooks_invalid");
  }
  return hooks;
}

async function runHook(hooks, name, context) {
  if (hooks?.[name]) await hooks[name](Object.freeze({ ...context }));
}

function decodeCanonicalConfig(encodedDockerConfig) {
  let bytes;
  try {
    if (typeof encodedDockerConfig !== "string" || !encodedDockerConfig ||
        encodedDockerConfig.length > Math.ceil(MAX_CONFIG_BYTES / 3) * 4) {
      fail("docker_config_invalid");
    }
    bytes = Buffer.from(encodedDockerConfig, "base64");
    if (bytes.length < 1 || bytes.length > MAX_CONFIG_BYTES ||
        bytes.toString("base64") !== encodedDockerConfig) {
      fail("docker_config_invalid");
    }
    return bytes;
  } catch (error) {
    if (bytes) bytes.fill(0);
    throw privateError(error, "docker_config_invalid");
  }
}

function writeAll(descriptor, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const count = fs.writeSync(descriptor, bytes, offset, bytes.length - offset, offset);
    if (count <= 0) fail("docker_config_write_failed");
    offset += count;
  }
}

function readExact(descriptor, size, code) {
  const bytes = Buffer.alloc(size);
  const extra = Buffer.alloc(1);
  let offset = 0;
  try {
    while (offset < size) {
      const count = fs.readSync(descriptor, bytes, offset, size - offset, offset);
      if (count <= 0) fail(code);
      offset += count;
    }
    if (fs.readSync(descriptor, extra, 0, 1, size) !== 0) fail(code);
    return bytes;
  } catch (error) {
    bytes.fill(0);
    throw error;
  } finally {
    extra.fill(0);
  }
}

function createEmptyConfig(parent, directoryPath, directory, configPath, config) {
  try {
    assertDirectoryStable(parent, directoryPath, directory);
    config.descriptor = fs.openSync(
      configPath,
      fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL |
        fs.constants.O_NOFOLLOW,
      FILE_MODE
    );
    config.stat = fs.fstatSync(config.descriptor, { bigint: true });
    fs.fchmodSync(config.descriptor, FILE_MODE);
    const opened = fs.fstatSync(config.descriptor, { bigint: true });
    const named = fs.lstatSync(configPath, { bigint: true });
    if (!ownerPrivateFile(opened, 0) || !sameFileStat(opened, named)) {
      fail("docker_config_file_invalid");
    }
    config.stat = opened;
    assertDirectoryStable(parent, directoryPath, directory);
    return config;
  } catch (error) {
    throw privateError(error, "docker_config_file_invalid");
  }
}

function assertEmptyConfigStable(parent, directoryPath, directory, configPath, config) {
  assertDirectoryStable(parent, directoryPath, directory);
  try {
    const opened = fs.fstatSync(config.descriptor, { bigint: true });
    const named = fs.lstatSync(configPath, { bigint: true });
    if (!ownerPrivateFile(opened, 0) ||
        !sameFileStat(config.stat, opened) || !sameFileStat(opened, named)) {
      fail("private_docker_config_changed");
    }
  } catch (error) {
    throw privateError(error, "private_docker_config_changed");
  }
}

function writeAndSyncConfig(parent, directoryPath, directory, configPath, config, bytes) {
  let readBack;
  try {
    assertEmptyConfigStable(parent, directoryPath, directory, configPath, config);
    writeAll(config.descriptor, bytes);
    fs.fsyncSync(config.descriptor);
    const written = fs.fstatSync(config.descriptor, { bigint: true });
    const named = fs.lstatSync(configPath, { bigint: true });
    readBack = readExact(config.descriptor, bytes.length, "docker_config_write_failed");
    const afterRead = fs.fstatSync(config.descriptor, { bigint: true });
    if (!ownerPrivateFile(written, bytes.length) || !sameFileStat(written, named) ||
        !sameFileStat(written, afterRead) || !timingSafeEqual(bytes, readBack)) {
      fail("docker_config_write_failed");
    }
    fs.fsyncSync(directory.descriptor);
    assertDirectoryStable(parent, directoryPath, directory);
    config.stat = written;
  } catch (error) {
    throw privateError(error, "docker_config_write_failed");
  } finally {
    readBack?.fill(0);
  }
}

function assertReadyConfig(parent, directoryPath, directory, configPath, config, bytes) {
  assertDirectoryStable(parent, directoryPath, directory);
  let readBack;
  try {
    const before = fs.fstatSync(config.descriptor, { bigint: true });
    const namedBefore = fs.lstatSync(configPath, { bigint: true });
    readBack = readExact(
      config.descriptor,
      bytes.length,
      "private_docker_config_changed"
    );
    const after = fs.fstatSync(config.descriptor, { bigint: true });
    const namedAfter = fs.lstatSync(configPath, { bigint: true });
    if (!ownerPrivateFile(before, bytes.length) ||
        !sameFileStat(config.stat, before) ||
        !sameFileStat(before, namedBefore) ||
        !sameFileStat(before, after) ||
        !sameFileStat(before, namedAfter) ||
        !timingSafeEqual(bytes, readBack)) {
      fail("private_docker_config_changed");
    }
  } catch (error) {
    throw privateError(error, "private_docker_config_changed");
  } finally {
    readBack?.fill(0);
  }
}

function wipeOpenConfig(config, expectedBytes) {
  if (config?.descriptor === undefined) return false;
  const zeros = Buffer.alloc(Math.min(expectedBytes, 64 * 1024));
  try {
    const opened = fs.fstatSync(config.descriptor, { bigint: true });
    if (!opened.isFile() || opened.isSymbolicLink() || opened.uid !== currentUid() ||
        (config.stat && !sameInode(opened, config.stat))) {
      return false;
    }
    config.stat = opened;
    try { fs.fchmodSync(config.descriptor, FILE_MODE); } catch { /* Keep wiping. */ }
    let offset = 0;
    while (offset < expectedBytes) {
      const length = Math.min(zeros.length, expectedBytes - offset);
      const count = fs.writeSync(config.descriptor, zeros, 0, length, offset);
      if (count <= 0) return false;
      offset += count;
    }
    fs.fsyncSync(config.descriptor);
    fs.ftruncateSync(config.descriptor, 0);
    fs.fsyncSync(config.descriptor);
    return fs.fstatSync(config.descriptor, { bigint: true }).size === 0n;
  } catch {
    return false;
  } finally {
    zeros.fill(0);
  }
}

function pathNamesDirectory(directoryPath, directory) {
  try {
    return sameDirectoryIdentity(
      directory.stat,
      fs.lstatSync(directoryPath, { bigint: true })
    );
  } catch {
    return false;
  }
}

function cleanupArtifacts({
  parent,
  directoryPath,
  directory,
  configPath,
  config,
  configBytes
}) {
  let clean = true;
  if (config?.descriptor !== undefined) {
    if (!wipeOpenConfig(config, configBytes?.length || 0)) clean = false;
    try { fs.closeSync(config.descriptor); } catch { clean = false; }
    config.descriptor = undefined;
  }

  if (configPath && directory?.stat) {
    try {
      const named = fs.lstatSync(configPath, { bigint: true });
      if (sameInode(named, config?.stat) ||
          (named.isSymbolicLink() && pathNamesDirectory(directoryPath, directory))) {
        fs.unlinkSync(configPath);
      } else {
        clean = false;
      }
    } catch (error) {
      if (error?.code !== "ENOENT") clean = false;
    }
    if (directory.descriptor !== undefined) {
      try { fs.fsyncSync(directory.descriptor); } catch { clean = false; }
    }
  }

  if (directoryPath && directory?.stat) {
    if (pathNamesDirectory(directoryPath, directory)) {
      try {
        if (fs.readdirSync(directoryPath).length !== 0) {
          clean = false;
        } else {
          fs.rmdirSync(directoryPath);
        }
      } catch {
        clean = false;
      }
    } else {
      clean = false;
    }
  }

  if (directory?.descriptor !== undefined) {
    try { fs.closeSync(directory.descriptor); } catch { clean = false; }
    directory.descriptor = undefined;
  }
  if (parent?.descriptor !== undefined) {
    try { fs.fsyncSync(parent.descriptor); } catch { clean = false; }
    try { fs.closeSync(parent.descriptor); } catch { clean = false; }
    parent.descriptor = undefined;
  }
  configBytes?.fill(0);
  return clean;
}

export async function withPrivateDockerConfig({
  encodedDockerConfig,
  privateParentDirectory,
  expectedPrivateParentIdentity,
  callback,
  hooks
}) {
  requireFilesystemSupport();
  if (typeof callback !== "function") fail("callback_invalid");
  const parentPath = checkedParentPath(privateParentDirectory);
  const parentIdentity = checkedParentIdentity(expectedPrivateParentIdentity);
  const checkedTestHooks = checkedHooks(hooks);
  let parent;
  let directoryPath;
  let directory;
  let configPath;
  let config;
  let configBytes;
  let result;
  let operationFailure;
  let callbackFailed = false;
  let callbackFailure;

  try {
    parent = openPrivateParent(parentPath, parentIdentity);
    configBytes = decodeCanonicalConfig(encodedDockerConfig);
    assertParentStable(parent);
    directory = {};
    directoryPath = createPrivateDirectory(parent, directory);
    openCreatedDirectory(directoryPath, directory);
    fs.fsyncSync(parent.descriptor);
    fs.fsyncSync(directory.descriptor);
    assertDirectoryStable(parent, directoryPath, directory);
    configPath = path.join(directoryPath, CONFIG_NAME);
    await runHook(checkedTestHooks, "afterDirectoryCreated", {
      directoryPath,
      configPath
    });
    assertDirectoryStable(parent, directoryPath, directory);

    config = {};
    createEmptyConfig(parent, directoryPath, directory, configPath, config);
    await runHook(checkedTestHooks, "afterConfigCreated", {
      directoryPath,
      configPath
    });
    assertEmptyConfigStable(parent, directoryPath, directory, configPath, config);
    writeAndSyncConfig(
      parent,
      directoryPath,
      directory,
      configPath,
      config,
      configBytes
    );
    await runHook(checkedTestHooks, "afterConfigFsync", {
      directoryPath,
      configPath
    });
    assertReadyConfig(
      parent,
      directoryPath,
      directory,
      configPath,
      config,
      configBytes
    );

    try {
      result = await callback(directoryPath);
    } catch (error) {
      callbackFailed = true;
      callbackFailure = error;
    }
    if (!callbackFailed) {
      await runHook(checkedTestHooks, "afterCallback", { directoryPath, configPath });
      assertReadyConfig(
        parent,
        directoryPath,
        directory,
        configPath,
        config,
        configBytes
      );
    }
  } catch (error) {
    operationFailure = privateError(error, "private_docker_config_failed");
  }

  const cleaned = cleanupArtifacts({
    parent,
    directoryPath,
    directory,
    configPath,
    config,
    configBytes
  });
  if (!cleaned) fail("private_docker_config_cleanup_failed");
  if (operationFailure) throw operationFailure;
  if (callbackFailed) throw callbackFailure;
  return result;
}
