#!/usr/bin/env node

// Replace the two AUD-065 GitHub Actions registry secrets from one fully read
// macOS Keychain item. The credential is held only in a mutable Buffer and is
// delivered to `gh secret set` through stdin after all read-only preflights.

import { randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  runMacOsSecurity
} from "./prepare-process-local-new-values-from-keychain.mjs";

const SECURITY = "/usr/bin/security";
const LOCKF = "/usr/bin/lockf";
const GH_CANDIDATES = Object.freeze([
  "/opt/homebrew/bin/gh",
  "/usr/local/bin/gh",
  "/usr/bin/gh"
]);
const REPOSITORIES = Object.freeze([
  "yengalvez/hubs",
  "yengalvez/hubs-cloud"
]);
const SECRET_NAME = "REGISTRY_PASSWORD";
const GHCR_KEYCHAIN_NAME = "GHCR_TOKEN";
const GH_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_SECRET_BYTES = 16 * 1024;
const LABEL = /^[A-Za-z0-9][A-Za-z0-9._@+-]{0,127}$/u;
const RFC3339_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u;
const SUCCESS_TOKEN = "aud065_actions_secrets_updated";
const SUCCESS_TOKEN_BYTES = Buffer.from(`${SUCCESS_TOKEN}\n`, "utf8");
const GENERIC_ERROR = "AUD-065 Actions secret update failed closed\n";
const LOCKED_CHILD_FLAG = "--aud065-locked-child";
const LOCK_MARKER_ENV = "AUD065_ACTIONS_LOCK_MARKER";

export class Aud065ActionsSecretUpdateError extends Error {
  constructor(code) {
    super(code);
    this.name = "Aud065ActionsSecretUpdateError";
    this.code = code;
  }
}

function fail(code) {
  throw new Aud065ActionsSecretUpdateError(code);
}

function checkedLabel(value, code) {
  if (typeof value !== "string" || !LABEL.test(value)) fail(code);
  return value;
}

function safeStringEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  try {
    return leftBytes.length === rightBytes.length &&
      timingSafeEqual(leftBytes, rightBytes);
  } finally {
    leftBytes.fill(0);
    rightBytes.fill(0);
  }
}

function minimalEnvironment() {
  const environment = {
    PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
    LANG: "C",
    LC_ALL: "C",
    GH_PROMPT_DISABLED: "1",
    NO_COLOR: "1"
  };
  if (typeof process.env.HOME === "string" && process.env.HOME) {
    environment.HOME = process.env.HOME;
  }
  return environment;
}

function trustedExecutable(stat) {
  const uid = typeof process.getuid === "function" ? BigInt(process.getuid()) : null;
  return stat.isFile() && Number(stat.mode & 0o022n) === 0 &&
    (uid === null || stat.uid === 0n || stat.uid === uid);
}

export function resolveGhExecutable() {
  for (const candidate of GH_CANDIDATES) {
    try {
      const resolved = fs.realpathSync(candidate);
      const stat = fs.statSync(resolved, { bigint: true });
      if (path.isAbsolute(resolved) && trustedExecutable(stat)) return resolved;
    } catch {
      // Try the next fixed installation location.
    }
  }
  fail("gh_executable_invalid");
}

export function runGhCli(invocation) {
  return spawnSync(invocation.executable, invocation.args, {
    input: invocation.input,
    env: invocation.env,
    encoding: null,
    timeout: GH_TIMEOUT_MS,
    killSignal: "SIGKILL",
    maxBuffer: MAX_OUTPUT_BYTES,
    stdio: ["pipe", "pipe", "pipe"]
  });
}

function aud065WriterLockPath() {
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  const parent = path.join("/tmp", `yenhubs-aud065-${uid}`);
  try {
    fs.mkdirSync(parent, { mode: 0o700 });
  } catch (error) {
    if (error?.code !== "EEXIST") fail("writer_lock_parent_invalid");
  }
  let stat;
  try {
    stat = fs.lstatSync(parent, { bigint: true });
  } catch {
    fail("writer_lock_parent_invalid");
  }
  const currentUid = typeof process.getuid === "function"
    ? BigInt(process.getuid())
    : null;
  if (!stat.isDirectory() || stat.isSymbolicLink() ||
      (currentUid !== null && stat.uid !== currentUid) ||
      Number(stat.mode & 0o7777n) !== 0o700) {
    fail("writer_lock_parent_invalid");
  }
  return path.join(parent, "actions-secrets.lock");
}

function runCliUnderWriterLock(cliArguments) {
  const lockPath = aud065WriterLockPath();
  let markerBytes;
  let stdout;
  let stderr;
  try {
    markerBytes = randomBytes(32);
    const marker = markerBytes.toString("hex");
    const result = spawnSync(LOCKF, [
      "-s", "-t", "0", lockPath,
      process.execPath,
      fileURLToPath(import.meta.url),
      LOCKED_CHILD_FLAG,
      marker,
      ...cliArguments
    ], {
      env: { ...minimalEnvironment(), [LOCK_MARKER_ENV]: marker },
      encoding: null,
      maxBuffer: MAX_OUTPUT_BYTES,
      stdio: ["ignore", "pipe", "pipe"]
    });
    stdout = result?.stdout;
    stderr = result?.stderr;
    if (!result?.error && !result?.signal && result?.status === 75) {
      fail("writer_lock_busy");
    }
    if (result?.error || result?.signal || result?.status !== 0 ||
        !Buffer.isBuffer(stdout) || !Buffer.isBuffer(stderr) ||
        stderr.length !== 0 || stdout.length !== SUCCESS_TOKEN_BYTES.length ||
        !timingSafeEqual(stdout, SUCCESS_TOKEN_BYTES)) {
      fail("writer_lock_execution_failed");
    }
    return SUCCESS_TOKEN;
  } catch (error) {
    if (error instanceof Aud065ActionsSecretUpdateError) throw error;
    fail("writer_lock_execution_failed");
  } finally {
    if (markerBytes) markerBytes.fill(0);
    if (stdout) stdout.fill(0);
    if (stderr) stderr.fill(0);
  }
}

function trimSecurityTerminator(stdout) {
  let end = stdout.length;
  if (end >= 2 && stdout[end - 2] === 0x0d && stdout[end - 1] === 0x0a) {
    end -= 2;
  } else if (end >= 1 && stdout[end - 1] === 0x0a) {
    end -= 1;
  }
  if (end < 32 || end > MAX_SECRET_BYTES) fail("keychain_secret_invalid");
  const secret = Buffer.from(stdout.subarray(0, end));
  if ([...secret].some(byte => byte < 0x21 || byte > 0x7e)) {
    secret.fill(0);
    fail("keychain_secret_invalid");
  }
  return secret;
}

function readGhcrToken({ account, prefix, securityRunner }) {
  const service = `${prefix}-${GHCR_KEYCHAIN_NAME}`;
  if (!LABEL.test(service) || service.length > 255) fail("keychain_service_invalid");
  let result;
  let stdout;
  let stderr;
  try {
    result = securityRunner({
      executable: SECURITY,
      args: ["find-generic-password", "-w", "-s", service, "-a", account],
      env: minimalEnvironment()
    });
    stdout = result?.stdout;
    stderr = result?.stderr;
    if (result?.error || result?.signal || result?.status !== 0 ||
        !Buffer.isBuffer(stdout) || !Buffer.isBuffer(stderr) ||
        stdout.length < 1 || stdout.length > MAX_SECRET_BYTES + 2 ||
        stderr.length !== 0) {
      fail("keychain_lookup_failed");
    }
    return trimSecurityTerminator(stdout);
  } catch (error) {
    if (error instanceof Aud065ActionsSecretUpdateError) throw error;
    fail("keychain_lookup_failed");
  } finally {
    if (stdout) stdout.fill(0);
    if (stderr) stderr.fill(0);
  }
}

function invokeGh({ ghExecutable, ghRunner, args, input, outputCode }) {
  let result;
  let stdout;
  let stderr;
  try {
    result = ghRunner({
      executable: ghExecutable,
      args,
      env: minimalEnvironment(),
      input
    });
    stdout = result?.stdout;
    stderr = result?.stderr;
    if (result?.error || result?.signal || result?.status !== 0 ||
        !Buffer.isBuffer(stdout) || !Buffer.isBuffer(stderr) ||
        stdout.length > MAX_OUTPUT_BYTES || stderr.length > MAX_OUTPUT_BYTES ||
        (Buffer.isBuffer(input) &&
          (stdout.indexOf(input) !== -1 || stderr.indexOf(input) !== -1))) {
      fail(outputCode);
    }
    return Buffer.from(stdout);
  } catch (error) {
    if (error instanceof Aud065ActionsSecretUpdateError) throw error;
    fail(outputCode);
  } finally {
    if (stdout) stdout.fill(0);
    if (stderr) stderr.fill(0);
  }
}

function parseRegistrySecretState(bytes) {
  let text;
  let parsed;
  try {
    text = bytes.toString("utf8");
    const roundTrip = Buffer.from(text, "utf8");
    try {
      if (!roundTrip.equals(bytes)) fail("gh_list_invalid");
    } finally {
      roundTrip.fill(0);
    }
    parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) fail("gh_list_invalid");
    const matches = parsed.filter(entry => entry && typeof entry === "object" &&
      !Array.isArray(entry) && entry.name === SECRET_NAME);
    if (matches.length > 1) fail("gh_list_invalid");
    if (matches.length === 0) return undefined;
    const updatedAt = matches[0].updatedAt;
    if (typeof updatedAt !== "string" || !RFC3339_UTC.test(updatedAt) ||
        !Number.isFinite(Date.parse(updatedAt))) {
      fail("gh_list_invalid");
    }
    return updatedAt;
  } catch (error) {
    if (error instanceof Aud065ActionsSecretUpdateError) throw error;
    fail("gh_list_invalid");
  }
}

function listRegistrySecret(options, repository) {
  const output = invokeGh({
    ...options,
    args: [
      "secret", "list", "--app", "actions", "--repo", repository,
      "--json", "name,updatedAt"
    ],
    input: undefined,
    outputCode: "gh_list_failed"
  });
  try {
    return parseRegistrySecretState(output);
  } finally {
    output.fill(0);
  }
}

function setRegistrySecret(options, repository, secret) {
  const output = invokeGh({
    ...options,
    args: [
      "secret", "set", SECRET_NAME, "--app", "actions", "--repo", repository
    ],
    input: secret,
    outputCode: "gh_set_failed"
  });
  output.fill(0);
}

export function updateAud065ActionsSecretsFromKeychain({
  keychainAccount,
  keychainPrefix,
  securityRunner = runMacOsSecurity,
  ghRunner = runGhCli,
  ghExecutable
}) {
  const account = checkedLabel(keychainAccount, "keychain_account_invalid");
  const prefix = checkedLabel(keychainPrefix, "keychain_prefix_invalid");
  if (typeof securityRunner !== "function" || typeof ghRunner !== "function") {
    fail("runner_invalid");
  }
  const executable = ghExecutable === undefined
    ? resolveGhExecutable()
    : ghExecutable;
  if (typeof executable !== "string" || !path.isAbsolute(executable) ||
      /[\u0000\r\n]/u.test(executable)) {
    fail("gh_executable_invalid");
  }
  let secret;
  try {
    secret = readGhcrToken({ account, prefix, securityRunner });
    const ghOptions = { ghExecutable: executable, ghRunner };
    const before = new Map();
    for (const repository of REPOSITORIES) {
      const state = listRegistrySecret(ghOptions, repository);
      if (state === undefined) fail("gh_secret_preflight_missing");
      before.set(repository, state);
    }
    for (const repository of REPOSITORIES) {
      setRegistrySecret(ghOptions, repository, secret);
      const after = listRegistrySecret(ghOptions, repository);
      if (after === undefined ||
          Date.parse(after) <= Date.parse(before.get(repository))) {
        fail("gh_secret_update_not_observed");
      }
    }
    return SUCCESS_TOKEN;
  } finally {
    if (secret) secret.fill(0);
  }
}

function parseCli(argv) {
  if (argv.length !== 4 || argv[0] !== "--keychain-account" ||
      argv[2] !== "--keychain-prefix") {
    fail("arguments_invalid");
  }
  return { keychainAccount: argv[1], keychainPrefix: argv[3] };
}

function main() {
  try {
    const argv = process.argv.slice(2);
    let token;
    if (argv[0] === LOCKED_CHILD_FLAG) {
      if (argv.length !== 6 ||
          !safeStringEqual(argv[1], process.env[LOCK_MARKER_ENV])) {
        fail("writer_lock_assertion_invalid");
      }
      token = updateAud065ActionsSecretsFromKeychain(parseCli(argv.slice(2)));
    } else {
      parseCli(argv);
      token = runCliUnderWriterLock(argv);
    }
    process.stdout.write(`${token}\n`);
  } catch (error) {
    process.stderr.write(GENERIC_ERROR);
    process.exitCode = error?.code === "writer_lock_busy" ? 75 : 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
