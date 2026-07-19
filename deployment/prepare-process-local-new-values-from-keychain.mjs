#!/usr/bin/env node

// macOS Keychain producer for the AUD-065 V1 secret frame. Provider values are
// captured without output/argv/env exposure, mutable Buffers are wiped on a
// best-effort basis, and the real preparer receives the frame only through FD3.

import { timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { parseLocalValuesSource } from "./parse-local-values.mjs";
import {
  encodeProcessLocalSecretInputFrame
} from "./prepare-process-local-new-values.mjs";
import {
  projectProcessLocalValuesMap,
  readPrivateProcessLocalValuesSource
} from "./project-process-local-values.mjs";
import {
  validateProcessLocalValuesSnapshot
} from "./process-local-rotation.mjs";

const SECURITY = "/usr/bin/security";
const PREPARER = fileURLToPath(
  new URL("./prepare-process-local-new-values.mjs", import.meta.url)
);
const SECURITY_TIMEOUT_MS = 60_000;
const SECURITY_MAX_BUFFER = 128 * 1024;
const PREPARER_MAX_OUTPUT = 64 * 1024;
const PREPARER_TIMEOUT_MS = 120_000;
const GENERIC_ERROR = "AUD-065 keychain preparation failed closed\n";
const SUCCESS_TOKEN = "aud065_new_values_prepared_from_keychain";
const PREPARER_TOKEN = Buffer.from("aud065_new_values_prepared\n", "utf8");
const EXTERNAL_SECRET_KEYS = Object.freeze([
  "OPENAI_API_KEY",
  "SMTP_PASS",
  "GHCR_TOKEN",
  "SKETCHFAB_API_KEY",
  "TENOR_API_KEY"
]);
const OPTIONAL_SECRET_KEYS = new Set([
  "SKETCHFAB_API_KEY",
  "TENOR_API_KEY"
]);
const LABEL = /^[A-Za-z0-9][A-Za-z0-9._@+-]{0,127}$/u;

export class ProcessLocalKeychainPreparationError extends Error {
  constructor(code) {
    super(code);
    this.name = "ProcessLocalKeychainPreparationError";
    this.code = code;
  }
}

function fail(code) {
  throw new ProcessLocalKeychainPreparationError(code);
}

function checkedPath(value, code) {
  if (typeof value !== "string" || !path.isAbsolute(value) ||
      /[\u0000\r\n]/u.test(value)) {
    fail(code);
  }
  return path.resolve(value);
}

function checkedLabel(value, code) {
  if (typeof value !== "string" || !LABEL.test(value)) fail(code);
  return value;
}

function minimalEnvironment({ includeHome = false } = {}) {
  const environment = { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" };
  if (includeHome && typeof process.env.HOME === "string" && process.env.HOME) {
    environment.HOME = process.env.HOME;
  }
  return environment;
}

function wipeMap(values) {
  if (!(values instanceof Map)) return;
  for (const name of values.keys()) values.set(name, "");
  values.clear();
}

function canonicalUtf8(bytes, code) {
  let roundTrip;
  try {
    const value = bytes.toString("utf8");
    roundTrip = Buffer.from(value, "utf8");
    if (!roundTrip.equals(bytes)) fail(code);
    return value;
  } finally {
    if (roundTrip) roundTrip.fill(0);
  }
}

function parseOldValues(bytes) {
  try {
    return parseLocalValuesSource(canonicalUtf8(bytes, "old_source_invalid"));
  } catch (error) {
    if (error instanceof ProcessLocalKeychainPreparationError) throw error;
    fail("old_source_invalid");
  }
}

export function runMacOsSecurity(invocation) {
  return spawnSync(invocation.executable, invocation.args, {
    env: invocation.env,
    encoding: null,
    timeout: SECURITY_TIMEOUT_MS,
    killSignal: "SIGKILL",
    maxBuffer: SECURITY_MAX_BUFFER,
    stdio: ["ignore", "pipe", "pipe"]
  });
}

function keychainSecret({ account, prefix, name, securityRunner }) {
  const service = `${prefix}-${name}`;
  if (!LABEL.test(service) || service.length > 255) fail("keychain_service_invalid");
  const args = [
    "find-generic-password",
    "-w",
    "-s",
    service,
    "-a",
    account
  ];
  const env = minimalEnvironment({ includeHome: true });
  let result;
  let stdout;
  let stderr;
  let secretBytes;
  try {
    result = securityRunner({ executable: SECURITY, args, env });
    stdout = result?.stdout;
    stderr = result?.stderr;
    if (result?.error || result?.signal || result?.status !== 0 ||
        !Buffer.isBuffer(stdout) || !Buffer.isBuffer(stderr) ||
        stdout.length < 1 || stdout.length > SECURITY_MAX_BUFFER) {
      fail("keychain_lookup_failed");
    }
    let end = stdout.length;
    if (end >= 2 && stdout[end - 2] === 0x0d && stdout[end - 1] === 0x0a) {
      end -= 2;
    } else if (stdout[end - 1] === 0x0a) {
      end -= 1;
    }
    if (end < 1) fail("keychain_secret_empty");
    secretBytes = Buffer.from(stdout.subarray(0, end));
    const value = canonicalUtf8(secretBytes, "keychain_secret_invalid");
    if (!value || /[\u0000-\u001f\u007f]/u.test(value) || value !== value.trim()) {
      fail("keychain_secret_invalid");
    }
    return value;
  } catch (error) {
    if (error instanceof ProcessLocalKeychainPreparationError) throw error;
    fail("keychain_lookup_failed");
  } finally {
    if (stdout) stdout.fill(0);
    if (stderr) stderr.fill(0);
    if (secretBytes) secretBytes.fill(0);
  }
}

function boundedCollector(stream, child, chunks) {
  let total = 0;
  let overflow = false;
  stream.on("data", chunk => {
    if (!Buffer.isBuffer(chunk)) return;
    const remaining = Math.max(0, PREPARER_MAX_OUTPUT - total);
    if (remaining > 0) chunks.push(Buffer.from(chunk.subarray(0, remaining)));
    total += chunk.length;
    chunk.fill(0);
    if (total > PREPARER_MAX_OUTPUT && !overflow) {
      overflow = true;
      child.kill("SIGKILL");
    }
  });
  return () => overflow;
}

export async function runRealProcessLocalPreparer(invocation) {
  if (!Buffer.isBuffer(invocation.frame)) fail("preparer_frame_invalid");
  const child = spawn(invocation.executable, invocation.args, {
    env: invocation.env,
    cwd: invocation.cwd,
    stdio: ["ignore", "pipe", "pipe", "pipe"]
  });
  const exited = once(child, "exit");
  const stdoutEnded = once(child.stdout, "end");
  const stderrEnded = once(child.stderr, "end");
  const stdoutChunks = [];
  const stderrChunks = [];
  const stdoutOverflow = boundedCollector(child.stdout, child, stdoutChunks);
  const stderrOverflow = boundedCollector(child.stderr, child, stderrChunks);
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, PREPARER_TIMEOUT_MS);
  timeout.unref();
  child.stdio[3].on("error", () => {});
  child.stdio[3].end(invocation.frame);
  let stdout;
  let stderr;
  try {
    const [status, signal] = await exited;
    child.stdio[3].destroy();
    await Promise.all([stdoutEnded, stderrEnded]);
    stdout = Buffer.concat(stdoutChunks);
    stderr = Buffer.concat(stderrChunks);
    if (timedOut || stdoutOverflow() || stderrOverflow() || status !== 0 || signal !== null ||
        stderr.length !== 0 || stdout.length !== PREPARER_TOKEN.length ||
        !timingSafeEqual(stdout, PREPARER_TOKEN)) {
      fail("preparer_failed");
    }
    return true;
  } catch (error) {
    if (error instanceof ProcessLocalKeychainPreparationError) throw error;
    fail("preparer_failed");
  } finally {
    clearTimeout(timeout);
    child.stdio[3].destroy();
    for (const chunk of stdoutChunks) chunk.fill(0);
    for (const chunk of stderrChunks) chunk.fill(0);
    if (stdout) stdout.fill(0);
    if (stderr) stderr.fill(0);
  }
}

export async function prepareProcessLocalNewValuesFromKeychain({
  oldValuesSource,
  newValuesSource,
  keychainAccount,
  keychainPrefix,
  securityRunner = runMacOsSecurity,
  preparerRunner = runRealProcessLocalPreparer
}) {
  const oldPath = checkedPath(oldValuesSource, "old_source_path_invalid");
  const newPath = checkedPath(newValuesSource, "new_source_path_invalid");
  if (oldPath === newPath) fail("source_paths_not_distinct");
  const account = checkedLabel(keychainAccount, "keychain_account_invalid");
  const prefix = checkedLabel(keychainPrefix, "keychain_prefix_invalid");
  if (typeof securityRunner !== "function" || typeof preparerRunner !== "function") {
    fail("runner_invalid");
  }
  let oldBytes;
  let oldValues;
  let oldSnapshot;
  let secrets;
  let frame;
  try {
    oldBytes = readPrivateProcessLocalValuesSource(oldPath);
    oldValues = parseOldValues(oldBytes);
    oldSnapshot = projectProcessLocalValuesMap(oldValues);
    validateProcessLocalValuesSnapshot(oldSnapshot, { codePrefix: "old_source" });
    secrets = new Map();
    for (const name of EXTERNAL_SECRET_KEYS) {
      if (OPTIONAL_SECRET_KEYS.has(name) && !oldValues.get(name)) {
        secrets.set(name, "");
        continue;
      }
      secrets.set(name, keychainSecret({
        account,
        prefix,
        name,
        securityRunner
      }));
    }
    frame = encodeProcessLocalSecretInputFrame(secrets);
    const args = [
      PREPARER,
      "prepare",
      "--old-values-source",
      oldPath,
      "--new-values-source",
      newPath,
      "--secret-input-fd",
      "3"
    ];
    const accepted = await preparerRunner({
      executable: process.execPath,
      args,
      env: minimalEnvironment(),
      cwd: path.dirname(PREPARER),
      frame
    });
    if (accepted !== true) fail("preparer_failed");
    return SUCCESS_TOKEN;
  } finally {
    if (oldBytes) oldBytes.fill(0);
    wipeMap(oldValues);
    if (oldSnapshot && typeof oldSnapshot === "object") {
      for (const name of Object.keys(oldSnapshot)) oldSnapshot[name] = "";
    }
    wipeMap(secrets);
    if (frame) frame.fill(0);
  }
}

function parseCli(argv) {
  if (argv.length !== 8 || argv[0] !== "--old-values-source" ||
      argv[2] !== "--new-values-source" || argv[4] !== "--keychain-account" ||
      argv[6] !== "--keychain-prefix") {
    fail("arguments_invalid");
  }
  return {
    oldValuesSource: argv[1],
    newValuesSource: argv[3],
    keychainAccount: argv[5],
    keychainPrefix: argv[7]
  };
}

async function main() {
  try {
    const token = await prepareProcessLocalNewValuesFromKeychain(
      parseCli(process.argv.slice(2))
    );
    process.stdout.write(`${token}\n`);
  } catch {
    process.stderr.write(GENERIC_ERROR);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
