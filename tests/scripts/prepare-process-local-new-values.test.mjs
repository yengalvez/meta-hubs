#!/usr/bin/env node

import assert from "node:assert/strict";
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  createHash
} from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parseLocalValuesSource } from "../../deployment/parse-local-values.mjs";
import { loadProcessLocalRotationProfile } from "../../deployment/process-local-rotation.mjs";
import {
  prepareProcessLocalNewValues,
  verifyProcessLocalNewValues
} from "../../deployment/prepare-process-local-new-values.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CLI = path.join(ROOT, "deployment/prepare-process-local-new-values.mjs");
const profile = loadProcessLocalRotationProfile();
const MAGIC = Buffer.from("YENHUBS-AUD065-SECRETS-V1\0", "ascii");
const EXTERNAL_KEYS = Object.freeze([
  "OPENAI_API_KEY",
  "SMTP_PASS",
  "GHCR_TOKEN",
  "SKETCHFAB_API_KEY",
  "TENOR_API_KEY"
]);
const INTERNAL_KEYS = Object.freeze([
  "BOT_ACCESS_KEY",
  "DB_PASS",
  "GUARDIAN_KEY",
  "NODE_COOKIE",
  "PHX_KEY",
  "BOT_RUNNER_ACCESS_KEY",
  "BOT_ORCHESTRATOR_ACCESS_KEY",
  "DASHBOARD_ACCESS_KEY"
]);
const AUTHORIZED_KEYS = new Set([
  ...INTERNAL_KEYS,
  "OPENAI_API_KEY",
  "SMTP_PASS",
  "SKETCHFAB_API_KEY",
  "TENOR_API_KEY",
  "PERMS_KEY",
  "PGRST_DB_URI",
  "PGRST_JWT_SECRET",
  "PSQL",
  "BOT_IMAGE_PULL_CONFIG_JSON_BASE64"
]);

function encodedPrivateKey() {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" }
  });
  return privateKey.replace(/\r?\n/gu, "\\n");
}

function jwtForPrivateKey(encoded) {
  const privateKey = createPrivateKey(encoded.replace(/\\n/gu, "\n"));
  const jwk = createPublicKey(privateKey).export({ format: "jwk" });
  return JSON.stringify({ kty: jwk.kty, n: jwk.n, e: jwk.e });
}

const OLD_PERMS_KEY = encodedPrivateKey();
const OLD_JWT = jwtForPrivateKey(OLD_PERMS_KEY);
const PRIVATE_KEY_HEADER = ["-----BEGIN", " PRIVATE KEY-----"].join("");

function pullConfig(username, token) {
  return Buffer.from(JSON.stringify({
    auths: {
      "ghcr.io": {
        auth: Buffer.from(`${username}:${token}`, "utf8").toString("base64")
      }
    }
  }), "utf8").toString("base64");
}

function pinnedImage(valueKey) {
  const repository = valueKey === "OVERRIDE_BOT_RUNNER_IMAGE"
    ? "ghcr.io/yengalvez/bot-runner"
    : profile.image_pairs.find(pair => pair.value_key === valueKey).repositories[0];
  return `${repository}@sha256:` + createHash("sha256").update(valueKey).digest("hex");
}

function oldSourceValues({ optionalConfigured = true, includeJwt = true } = {}) {
  const password = "Old_Db_Password_" + "a".repeat(48);
  const values = {
    Namespace: "hcce",
    ADM_EMAIL: "admin@example.invalid",
    BOT_ACCESS_KEY: `old-bot-${"a".repeat(48)}`,
    BOT_RUNNER_ACCESS_KEY: `old-runner-${"b".repeat(48)}`,
    BOT_ORCHESTRATOR_ACCESS_KEY: `old-orchestrator-${"c".repeat(48)}`,
    DASHBOARD_ACCESS_KEY: `old-dashboard-${"d".repeat(48)}`,
    BOT_IMAGE_PULL_CONFIG_JSON_BASE64: pullConfig("fixture-user", "old-ghcr-token"),
    DB_HOST: "pgbouncer",
    DB_HOST_T: "pgbouncer-t",
    DB_NAME: "retdb",
    DB_PASS: password,
    DB_USER: "postgres",
    GUARDIAN_KEY: `old-guardian-${"e".repeat(48)}`,
    HUB_DOMAIN: "example.invalid",
    NODE_COOKIE: `old-cookie-${"f".repeat(48)}`,
    OPENAI_API_KEY: `old-openai-${"g".repeat(48)}`,
    PERMS_KEY: OLD_PERMS_KEY,
    PGRST_DB_URI: `postgres://postgres:${password}@pgbouncer:5432/retdb`,
    PHX_KEY: `old-phx-${"h".repeat(48)}`,
    PSQL: `postgres://postgres:${password}@pgsql:5432/retdb`,
    SKETCHFAB_API_KEY: optionalConfigured ? `old-sketchfab-${"i".repeat(40)}` : "",
    SMTP_PASS: `old-smtp-${"j".repeat(48)}`,
    SMTP_PORT: "2525",
    SMTP_SERVER: "smtp.example.invalid",
    SMTP_USER: "mailer@example.invalid",
    TENOR_API_KEY: optionalConfigured ? `old-tenor-${"k".repeat(40)}` : "",
    UNRELATED_AUD075_VALUE: "must-remain-byte-identical"
  };
  if (includeJwt) values.PGRST_JWT_SECRET = OLD_JWT;
  const imageKeys = new Set([
    ...profile.image_pairs.map(pair => pair.value_key),
    ...profile.legacy_image_pull.verified_image_value_keys
  ]);
  for (const valueKey of imageKeys) values[valueKey] = pinnedImage(valueKey);
  return values;
}

function sourceBytes(values, { permsLiteralBlock = false } = {}) {
  const entries = Object.entries(values).sort(([left], [right]) => left.localeCompare(right));
  const lines = ["---", "# exact header comment", ""];
  for (const [name, value] of entries) {
    if (name === "PERMS_KEY" && permsLiteralBlock) {
      const pemLines = value.replace(/\\n/gu, "\n").trimEnd().split("\n");
      lines.push("PERMS_KEY: |", ...pemLines.map(line => `  ${line}`));
    } else if (name === "SKETCHFAB_API_KEY" && value === "") {
      lines.push("SKETCHFAB_API_KEY: # preserve-sketchfab_api_key");
    } else if (AUTHORIZED_KEYS.has(name)) {
      lines.push(`${name}:   ${JSON.stringify(value)}  # preserve-${name.toLowerCase()}`);
    } else {
      lines.push(`${name}: ${JSON.stringify(value)}`);
    }
    if (name === "HUB_DOMAIN") lines.push("", "# middle comment");
  }
  return Buffer.from(`${lines.join("\r\n")}\r\n`, "utf8");
}

function writePrivate(filePath, bytes) {
  fs.writeFileSync(filePath, bytes, { mode: 0o600, flag: "wx" });
  fs.chmodSync(filePath, 0o600);
}

function fixture(options = {}) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "aud065-new-values-"));
  fs.chmodSync(root, 0o700);
  const oldValuesSource = path.join(root, "old-values.yaml");
  const newValuesSource = path.join(root, "new-values.yaml");
  const values = oldSourceValues(options);
  const bytes = sourceBytes(values, options);
  writePrivate(oldValuesSource, bytes);
  return { root, oldValuesSource, newValuesSource, values, bytes };
}

function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

function externalSecrets({ optionalConfigured = true } = {}) {
  return {
    OPENAI_API_KEY: `new-openai-sentinel-${"Q".repeat(36)}`,
    SMTP_PASS: `new-smtp-sentinel-${"R".repeat(36)}`,
    GHCR_TOKEN: `new-ghcr-sentinel-${"S".repeat(36)}`,
    SKETCHFAB_API_KEY: optionalConfigured ? `new-sketch-sentinel-${"T".repeat(36)}` : "",
    TENOR_API_KEY: optionalConfigured ? `new-tenor-sentinel-${"U".repeat(36)}` : ""
  };
}

function secretFrame(values, keys = EXTERNAL_KEYS, { count = keys.length } = {}) {
  const chunks = [MAGIC, Buffer.from([count])];
  for (const name of keys) {
    const key = Buffer.from(name, "ascii");
    const value = Buffer.from(values[name] ?? "", "utf8");
    const length = Buffer.alloc(4);
    length.writeUInt32BE(value.length);
    chunks.push(Buffer.from([key.length]), key, length, value);
  }
  return Buffer.concat(chunks);
}

async function runPrepare(input, frame, extra = {}) {
  const args = [
    CLI,
    "prepare",
    "--old-values-source",
    input.oldValuesSource,
    "--new-values-source",
    input.newValuesSource,
    "--secret-input-fd",
    "3"
  ];
  const env = {
    PATH: process.env.PATH,
    LANG: "C",
    LC_ALL: "C",
    TEST_PUBLIC_MARKER: extra.publicMarker || "public-test-marker"
  };
  const child = spawn(process.execPath, args, {
    cwd: ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe", "pipe"]
  });
  const exited = once(child, "exit");
  const stdoutEnded = once(child.stdout, "end");
  const stderrEnded = once(child.stderr, "end");
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", chunk => stdout.push(chunk));
  child.stderr.on("data", chunk => stderr.push(chunk));
  child.stdio[3].on("error", () => {});
  child.stdio[3].end(frame);
  const [status, signal] = await exited;
  child.stdio[3].destroy();
  await Promise.all([stdoutEnded, stderrEnded]);
  return {
    status,
    signal,
    stdout: Buffer.concat(stdout).toString("utf8"),
    stderr: Buffer.concat(stderr).toString("utf8"),
    args,
    env
  };
}

function runVerify(input) {
  return spawnSync(process.execPath, [
    CLI,
    "verify",
    "--old-values-source",
    input.oldValuesSource,
    "--new-values-source",
    input.newValuesSource
  ], { cwd: ROOT, encoding: "utf8", env: { PATH: process.env.PATH, LANG: "C" } });
}

async function withSecretFrameDescriptor(input, frame, callback) {
  const fifoPath = path.join(input.root, "secret-input.fifo");
  const mkfifo = spawnSync("/usr/bin/mkfifo", [fifoPath], { encoding: "utf8" });
  assert.equal(mkfifo.status, 0, mkfifo.stderr);
  const writer = spawn(process.execPath, [
    "-e",
    "const fs=require('fs');const bytes=fs.readFileSync(0);" +
      "const fd=fs.openSync(process.argv[1],'w');" +
      "try{fs.writeFileSync(fd,bytes)}finally{fs.closeSync(fd);bytes.fill(0)}",
    fifoPath
  ], { stdio: ["pipe", "ignore", "pipe"] });
  const writerClosed = once(writer, "close");
  const inputFinished = once(writer.stdin, "finish");
  writer.stdin.on("error", () => {});
  writer.stdin.end(frame);
  await inputFinished;
  const descriptor = fs.openSync(fifoPath, fs.constants.O_RDONLY);
  try {
    return await callback(descriptor);
  } finally {
    try { fs.closeSync(descriptor); } catch { /* The preparer owns the descriptor. */ }
    const [status] = await writerClosed;
    assert.equal(status, 0);
  }
}

function mutateOldInvariant(input) {
  const changed = input.bytes.toString("utf8").replace(
    "must-remain-byte-identical",
    "must-remain-byte-different"
  );
  fs.writeFileSync(input.oldValuesSource, changed, { mode: 0o600 });
  fs.chmodSync(input.oldValuesSource, 0o600);
}

function parsedFile(filePath) {
  return parseLocalValuesSource(fs.readFileSync(filePath, "utf8"));
}

function decodedPullCredential(encoded) {
  const config = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  const basic = Buffer.from(config.auths["ghcr.io"].auth, "base64").toString("utf8");
  const separator = basic.indexOf(":");
  return {
    registry: Object.keys(config.auths)[0],
    username: basic.slice(0, separator),
    token: basic.slice(separator + 1)
  };
}

function lineKey(line) {
  return /^([A-Za-z_][A-Za-z0-9_]*):/u.exec(line)?.[1];
}

test("prepare creates a strongly valid NEW source while leaving OLD and invariant lines exact", async () => {
  const input = fixture({ optionalConfigured: true, includeJwt: true });
  const secrets = externalSecrets({ optionalConfigured: true });
  const frame = secretFrame(secrets);
  try {
    const result = await runPrepare(input, frame);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.signal, null);
    assert.equal(result.stdout, "aud065_new_values_prepared\n");
    assert.equal(result.stderr, "");
    assert.deepEqual(fs.readFileSync(input.oldValuesSource), input.bytes);

    const stat = fs.lstatSync(input.newValuesSource);
    assert.equal(stat.mode & 0o7777, 0o600);
    assert.equal(stat.nlink, 1);
    const verify = runVerify(input);
    assert.equal(verify.status, 0, verify.stderr);
    assert.equal(verify.stdout, "aud065_new_values_verified\n");
    assert.equal(verify.stderr, "");

    const oldValues = parsedFile(input.oldValuesSource);
    const newValues = parsedFile(input.newValuesSource);
    assert.deepEqual([...newValues.keys()].sort(), [...oldValues.keys()].sort());
    assert.equal(newValues.get("OPENAI_API_KEY"), secrets.OPENAI_API_KEY);
    assert.equal(newValues.get("SMTP_PASS"), secrets.SMTP_PASS);
    assert.equal(newValues.get("SKETCHFAB_API_KEY"), secrets.SKETCHFAB_API_KEY);
    assert.equal(newValues.get("TENOR_API_KEY"), secrets.TENOR_API_KEY);

    const domains = INTERNAL_KEYS.map(name => newValues.get(name));
    assert.equal(new Set(domains).size, INTERNAL_KEYS.length);
    for (const name of INTERNAL_KEYS) {
      assert.notEqual(newValues.get(name), oldValues.get(name));
      assert.match(newValues.get(name), /^[A-Za-z0-9_-]{32,128}$/u);
    }

    const newPassword = newValues.get("DB_PASS");
    const pgrst = new URL(newValues.get("PGRST_DB_URI"));
    const psql = new URL(newValues.get("PSQL"));
    assert.equal(decodeURIComponent(pgrst.password), newPassword);
    assert.equal(pgrst.hostname, oldValues.get("DB_HOST"));
    assert.equal(psql.hostname, "pgsql");
    assert.equal(decodeURIComponent(psql.password), newPassword);

    const encodedPerms = newValues.get("PERMS_KEY");
    assert.equal(encodedPerms.startsWith(`${PRIVATE_KEY_HEADER}\\n`), true);
    assert.equal(encodedPerms.includes("\n"), false);
    const privateKey = createPrivateKey(encodedPerms.replace(/\\n/gu, "\n"));
    assert.equal(privateKey.asymmetricKeyType, "rsa");
    assert.ok(Number(privateKey.asymmetricKeyDetails.modulusLength) >= 2048);
    assert.equal(newValues.get("PGRST_JWT_SECRET"), jwtForPrivateKey(encodedPerms));

    const pull = decodedPullCredential(newValues.get("BOT_IMAGE_PULL_CONFIG_JSON_BASE64"));
    assert.equal(pull.registry, "ghcr.io");
    assert.equal(pull.username, "fixture-user");
    assert.equal(pull.token, secrets.GHCR_TOKEN);

    const oldLines = input.bytes.toString("utf8").split("\r\n");
    const newSource = fs.readFileSync(input.newValuesSource, "utf8");
    const newLines = newSource.split("\r\n");
    assert.equal(newSource.replace(/\r\n/gu, "").includes("\n"), false);
    assert.equal(newLines.length, oldLines.length);
    for (let index = 0; index < oldLines.length; index += 1) {
      const key = lineKey(oldLines[index]);
      if (!AUTHORIZED_KEYS.has(key)) assert.equal(newLines[index], oldLines[index]);
      if (AUTHORIZED_KEYS.has(key) && oldLines[index].includes("# preserve-")) {
        assert.equal(
          newLines[index].slice(newLines[index].indexOf("# preserve-")),
          oldLines[index].slice(oldLines[index].indexOf("# preserve-"))
        );
      }
    }

    const sentinels = Object.values(secrets).filter(Boolean);
    for (const sentinel of sentinels) {
      assert.equal(result.stdout.includes(sentinel), false);
      assert.equal(result.stderr.includes(sentinel), false);
      assert.equal(result.args.join("\0").includes(sentinel), false);
      assert.equal(Object.values(result.env).join("\0").includes(sentinel), false);
    }
  } finally {
    frame.fill(0);
    cleanup(input.root);
  }
});

test("prepare consumes the exact legacy PERMS_KEY literal block and preserves OLD", async () => {
  const input = fixture({
    optionalConfigured: true,
    includeJwt: true,
    permsLiteralBlock: true
  });
  const secrets = externalSecrets({ optionalConfigured: true });
  const frame = secretFrame(secrets);
  try {
    const oldSource = input.bytes.toString("utf8");
    assert.equal(oldSource.includes(
      `\r\nPERMS_KEY: |\r\n  ${PRIVATE_KEY_HEADER}\r\n`
    ), true);
    assert.equal(parsedFile(input.oldValuesSource).get("PERMS_KEY"), OLD_PERMS_KEY);

    const result = await runPrepare(input, frame);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "aud065_new_values_prepared\n");
    assert.deepEqual(fs.readFileSync(input.oldValuesSource), input.bytes);
    assert.equal(runVerify(input).status, 0);

    const newSource = fs.readFileSync(input.newValuesSource, "utf8");
    assert.doesNotMatch(newSource, /\r\nPERMS_KEY: \|\r\n/u);
    assert.equal(newSource.includes(`\r\n  ${PRIVATE_KEY_HEADER}\r\n`), false);
    const oldPemBodyLine = OLD_PERMS_KEY.split("\\n")[1];
    assert.equal(newSource.includes(oldPemBodyLine), false);
    assert.equal(
      newSource.split("\r\n").filter(line => line.startsWith("PERMS_KEY:")).length,
      1
    );
    assert.equal(newSource.replace(/\r\n/gu, "").includes("\n"), false);
    const newValues = parsedFile(input.newValuesSource);
    assert.notEqual(newValues.get("PERMS_KEY"), OLD_PERMS_KEY);
    assert.equal(newValues.get("PERMS_KEY").startsWith(
      `${PRIVATE_KEY_HEADER}\\n`
    ), true);
    assert.equal(newValues.get("PGRST_JWT_SECRET"), jwtForPrivateKey(
      newValues.get("PERMS_KEY")
    ));
  } finally {
    frame.fill(0);
    cleanup(input.root);
  }
});

test("an invalid legacy PERMS_KEY block fails before NEW publication", async () => {
  const input = fixture({ permsLiteralBlock: true });
  const secrets = externalSecrets();
  const frame = secretFrame(secrets);
  try {
    const invalidBytes = Buffer.from(input.bytes.toString("utf8").replace(
      `  ${PRIVATE_KEY_HEADER}\r\n`,
      `  ${PRIVATE_KEY_HEADER} \r\n`
    ), "utf8");
    fs.writeFileSync(input.oldValuesSource, invalidBytes, { mode: 0o600 });
    fs.chmodSync(input.oldValuesSource, 0o600);
    const result = await runPrepare(input, frame);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "AUD-065 local values preparation failed closed\n");
    assert.equal(fs.existsSync(input.newValuesSource), false);
    assert.deepEqual(fs.readFileSync(input.oldValuesSource), invalidBytes);
  } finally {
    frame.fill(0);
    cleanup(input.root);
  }
});

test("optional empty secrets remain empty and an absent derived JWT remains absent", async () => {
  const input = fixture({ optionalConfigured: false, includeJwt: false });
  const secrets = externalSecrets({ optionalConfigured: false });
  const frame = secretFrame(secrets);
  try {
    const result = await runPrepare(input, frame);
    assert.equal(result.status, 0, result.stderr);
    const values = parsedFile(input.newValuesSource);
    assert.equal(values.get("SKETCHFAB_API_KEY"), "");
    assert.equal(values.get("TENOR_API_KEY"), "");
    assert.equal(values.has("PGRST_JWT_SECRET"), false);
    assert.equal(runVerify(input).status, 0);
  } finally {
    frame.fill(0);
    cleanup(input.root);
  }
});

test("configured optional secrets cannot be omitted from the input frame", async () => {
  const input = fixture({ optionalConfigured: true });
  const secrets = externalSecrets({ optionalConfigured: false });
  const frame = secretFrame(secrets);
  try {
    const result = await runPrepare(input, frame);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "AUD-065 local values preparation failed closed\n");
    assert.equal(fs.existsSync(input.newValuesSource), false);
  } finally {
    frame.fill(0);
    cleanup(input.root);
  }
});

test("binary framing rejects truncation, extra bytes, wrong order and control values", async t => {
  const secrets = externalSecrets();
  const valid = secretFrame(secrets);
  const wrongOrder = secretFrame(secrets, [
    EXTERNAL_KEYS[1],
    EXTERNAL_KEYS[0],
    ...EXTERNAL_KEYS.slice(2)
  ]);
  const withControl = secretFrame({ ...secrets, OPENAI_API_KEY: "bad\nvalue" });
  const wrongCount = secretFrame(secrets, EXTERNAL_KEYS, { count: 4 });
  const invalidUtf8 = Buffer.from(valid);
  const sentinelOffset = invalidUtf8.indexOf(Buffer.from(secrets.OPENAI_API_KEY, "utf8"));
  assert.notEqual(sentinelOffset, -1);
  invalidUtf8[sentinelOffset] = 0xff;
  const cases = [
    ["truncated", valid.subarray(0, valid.length - 1)],
    ["extra byte", Buffer.concat([valid, Buffer.from([0])])],
    ["wrong order", wrongOrder],
    ["wrong count", wrongCount],
    ["control value", withControl],
    ["noncanonical UTF-8", invalidUtf8],
    ["larger than the frame limit", Buffer.alloc(128 * 1024 + 1, 0x41)]
  ];
  for (const [name, frame] of cases) {
    await t.test(name, async () => {
      const input = fixture();
      try {
        const result = await runPrepare(input, frame);
        assert.equal(result.status, 1);
        assert.equal(result.stdout, "");
        assert.equal(result.stderr, "AUD-065 local values preparation failed closed\n");
        assert.equal(fs.existsSync(input.newValuesSource), false);
        for (const sentinel of Object.values(secrets)) {
          assert.equal(result.stderr.includes(sentinel), false);
        }
      } finally {
        cleanup(input.root);
      }
    });
  }
  valid.fill(0);
  wrongOrder.fill(0);
  withControl.fill(0);
  wrongCount.fill(0);
  invalidUtf8.fill(0);
});

test("existing, symlinked, hardlinked and unsafe destinations fail without overwrite", async t => {
  const secrets = externalSecrets();
  const frame = secretFrame(secrets);
  const cases = ["existing", "symlink", "hardlink", "unsafe-parent"];
  for (const name of cases) {
    await t.test(name, async () => {
      const input = fixture();
      let preserved;
      try {
        if (name === "existing") {
          preserved = Buffer.from("preserve-existing\n", "utf8");
          writePrivate(input.newValuesSource, preserved);
        } else if (name === "symlink") {
          const target = path.join(input.root, "symlink-target");
          writePrivate(target, Buffer.from("preserve-target\n", "utf8"));
          fs.symlinkSync(target, input.newValuesSource);
        } else if (name === "hardlink") {
          const target = path.join(input.root, "hardlink-target");
          writePrivate(target, Buffer.from("preserve-hardlink\n", "utf8"));
          fs.linkSync(target, input.newValuesSource);
        } else {
          fs.chmodSync(input.root, 0o755);
        }
        const result = await runPrepare(input, frame);
        assert.equal(result.status, 1);
        assert.equal(result.stdout, "");
        assert.equal(result.stderr, "AUD-065 local values preparation failed closed\n");
        if (name === "existing") {
          assert.deepEqual(fs.readFileSync(input.newValuesSource), preserved);
        }
        if (name === "hardlink") assert.equal(fs.lstatSync(input.newValuesSource).nlink, 2);
        if (name === "symlink") assert.equal(fs.lstatSync(input.newValuesSource).isSymbolicLink(), true);
      } finally {
        cleanup(input.root);
      }
    });
  }
  frame.fill(0);
});

test("a regular file descriptor is rejected as a secret input channel", () => {
  const input = fixture();
  const frame = secretFrame(externalSecrets());
  const framePath = path.join(input.root, "frame.bin");
  writePrivate(framePath, frame);
  const descriptor = fs.openSync(framePath, "r");
  try {
    const result = spawnSync(process.execPath, [
      CLI,
      "prepare",
      "--old-values-source",
      input.oldValuesSource,
      "--new-values-source",
      input.newValuesSource,
      "--secret-input-fd",
      "3"
    ], {
      cwd: ROOT,
      encoding: "utf8",
      env: { PATH: process.env.PATH, LANG: "C" },
      stdio: ["ignore", "pipe", "pipe", descriptor]
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "AUD-065 local values preparation failed closed\n");
    assert.equal(fs.existsSync(input.newValuesSource), false);
  } finally {
    fs.closeSync(descriptor);
    frame.fill(0);
    cleanup(input.root);
  }
});

test("OLD changing after validation is detected before NEW publication", async () => {
  const input = fixture();
  const frame = secretFrame(externalSecrets());
  try {
    await withSecretFrameDescriptor(input, frame, descriptor => {
      assert.throws(() => prepareProcessLocalNewValues({
        oldValuesSource: input.oldValuesSource,
        newValuesSource: input.newValuesSource,
        secretInputFd: descriptor,
        hooks: {
          beforeOldRecheck() {
            mutateOldInvariant(input);
          }
        }
      }), error => error?.code === "old_source_changed");
    });
    assert.equal(fs.existsSync(input.newValuesSource), false);
  } finally {
    frame.fill(0);
    cleanup(input.root);
  }
});

test("OLD changing after NEW publication prevents prepare success", async () => {
  const input = fixture();
  const frame = secretFrame(externalSecrets());
  try {
    await withSecretFrameDescriptor(input, frame, descriptor => {
      assert.throws(() => prepareProcessLocalNewValues({
        oldValuesSource: input.oldValuesSource,
        newValuesSource: input.newValuesSource,
        secretInputFd: descriptor,
        hooks: {
          afterNewRead() {
            assert.equal(fs.existsSync(input.newValuesSource), true);
            mutateOldInvariant(input);
          }
        }
      }), error => error?.code === "old_source_changed");
    });
    const stat = fs.lstatSync(input.newValuesSource);
    assert.equal(stat.isFile(), true);
    assert.equal(stat.mode & 0o7777, 0o600);
  } finally {
    frame.fill(0);
    cleanup(input.root);
  }
});

test("verify rejects OLD changing after its NEW read", async () => {
  const input = fixture();
  const frame = secretFrame(externalSecrets());
  try {
    assert.equal((await runPrepare(input, frame)).status, 0);
    assert.throws(() => verifyProcessLocalNewValues({
      oldValuesSource: input.oldValuesSource,
      newValuesSource: input.newValuesSource,
      hooks: {
        afterNewRead() {
          mutateOldInvariant(input);
        }
      }
    }), error => error?.code === "old_source_changed");
  } finally {
    frame.fill(0);
    cleanup(input.root);
  }
});

test("verify rejects semantic-equivalent formatting drift and invariant line changes", async () => {
  const input = fixture();
  const frame = secretFrame(externalSecrets());
  try {
    assert.equal((await runPrepare(input, frame)).status, 0);
    const canonical = fs.readFileSync(input.newValuesSource, "utf8");
    fs.unlinkSync(input.newValuesSource);
    writePrivate(
      input.newValuesSource,
      Buffer.from(canonical.replace("DB_HOST: \"pgbouncer\"", "DB_HOST: 'pgbouncer'"), "utf8")
    );
    const invariant = runVerify(input);
    assert.equal(invariant.status, 1);
    assert.equal(invariant.stderr, "AUD-065 local values preparation failed closed\n");

    fs.unlinkSync(input.newValuesSource);
    writePrivate(
      input.newValuesSource,
      Buffer.from(canonical.replace("BOT_ACCESS_KEY: ", "BOT_ACCESS_KEY:   "), "utf8")
    );
    const authorizedFormatting = runVerify(input);
    assert.equal(authorizedFormatting.status, 1);
    assert.equal(authorizedFormatting.stderr,
      "AUD-065 local values preparation failed closed\n");
  } finally {
    frame.fill(0);
    cleanup(input.root);
  }
});
