#!/usr/bin/env node

import assert from "node:assert/strict";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync
} from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parseLocalValuesSource } from "../../deployment/parse-local-values.mjs";
import {
  encodeProcessLocalSecretInputFrame,
  parseProcessLocalSecretInputFrame
} from "../../deployment/prepare-process-local-new-values.mjs";
import {
  prepareProcessLocalNewValuesFromKeychain,
  runRealProcessLocalPreparer
} from "../../deployment/prepare-process-local-new-values-from-keychain.mjs";
import {
  updateAud065ActionsSecretsFromKeychain
} from "../../deployment/update-aud065-actions-secrets-from-keychain.mjs";
import { loadProcessLocalRotationProfile } from "../../deployment/process-local-rotation.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CLI = path.join(
  ROOT,
  "deployment/prepare-process-local-new-values-from-keychain.mjs"
);
const ACTIONS_CLI = path.join(
  ROOT,
  "deployment/update-aud065-actions-secrets-from-keychain.mjs"
);
const profile = loadProcessLocalRotationProfile();
const PREFIX = "YenHubsAUD065";
const ACCOUNT = "fixture@example.invalid";
const EXTERNAL_KEYS = Object.freeze([
  "OPENAI_API_KEY",
  "SMTP_PASS",
  "GHCR_TOKEN",
  "SKETCHFAB_API_KEY",
  "TENOR_API_KEY"
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

function sourceValues({ optionalConfigured = true, includeJwt = false } = {}) {
  const password = `Old_Db_Password_${"a".repeat(48)}`;
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
    SKETCHFAB_API_KEY: optionalConfigured ? `old-sketch-${"i".repeat(40)}` : "",
    SMTP_PASS: `old-smtp-${"j".repeat(48)}`,
    SMTP_PORT: "2525",
    SMTP_SERVER: "smtp.example.invalid",
    SMTP_USER: "mailer@example.invalid",
    TENOR_API_KEY: optionalConfigured ? `old-tenor-${"k".repeat(40)}` : "",
    UNRELATED_VALUE: "preserve-this-line"
  };
  if (includeJwt) values.PGRST_JWT_SECRET = jwtForPrivateKey(OLD_PERMS_KEY);
  const imageKeys = new Set([
    ...profile.image_pairs.map(pair => pair.value_key),
    ...profile.legacy_image_pull.verified_image_value_keys
  ]);
  for (const valueKey of imageKeys) values[valueKey] = pinnedImage(valueKey);
  return values;
}

function sourceBytes(values) {
  const lines = Object.entries(values)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `${name}: ${JSON.stringify(value)}`);
  return Buffer.from(`# keychain fixture\n${lines.join("\n")}\n`, "utf8");
}

function fixture(options = {}) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "aud065-keychain-"));
  fs.chmodSync(root, 0o700);
  const oldValuesSource = path.join(root, "old-values.yaml");
  const newValuesSource = path.join(root, "new-values.yaml");
  const values = sourceValues(options);
  fs.writeFileSync(oldValuesSource, sourceBytes(values), { mode: 0o600, flag: "wx" });
  fs.chmodSync(oldValuesSource, 0o600);
  return { root, oldValuesSource, newValuesSource, values };
}

function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

function providerSecrets({ optionalConfigured = true } = {}) {
  return {
    OPENAI_API_KEY: `keychain-openai-sentinel-${"Q".repeat(32)}`,
    SMTP_PASS: `keychain-smtp-sentinel-${"R".repeat(32)}`,
    GHCR_TOKEN: `keychain-ghcr-sentinel-${"S".repeat(32)}`,
    SKETCHFAB_API_KEY: optionalConfigured
      ? `keychain-sketch-sentinel-${"T".repeat(32)}`
      : "",
    TENOR_API_KEY: optionalConfigured
      ? `keychain-tenor-sentinel-${"U".repeat(32)}`
      : ""
  };
}

function fakeSecurityRunner(values, calls, { failName } = {}) {
  return invocation => {
    const args = [...invocation.args];
    calls.push({ executable: invocation.executable, args, env: { ...invocation.env } });
    const service = args[args.indexOf("-s") + 1];
    const name = EXTERNAL_KEYS.find(key => service === `${PREFIX}-${key}`);
    if (!name || name === failName) {
      const stdout = Buffer.alloc(0);
      const stderr = Buffer.from(`${values[name] || "fixed"} keychain failure\n`, "utf8");
      calls.at(-1).stdout = stdout;
      calls.at(-1).stderr = stderr;
      return {
        status: 1,
        signal: null,
        stdout,
        stderr
      };
    }
    const ending = name === "SMTP_PASS" ? "\r\n" : "\n";
    const stdout = Buffer.from(`${values[name]}${ending}`, "utf8");
    const stderr = Buffer.alloc(0);
    calls.at(-1).stdout = stdout;
    calls.at(-1).stderr = stderr;
    return {
      status: 0,
      signal: null,
      stdout,
      stderr
    };
  };
}

function fakeGhRunner({
  calls,
  failListRepo,
  failSetRepo,
  failSetRepoOnce,
  unchangedRepo,
  missingRepo,
  duplicateRepo,
  malformedTimestampRepo,
  echoOutputRepo
}) {
  const states = new Map([
    ["yengalvez/hubs", "2026-07-18T01:00:00Z"],
    ["yengalvez/hubs-cloud", "2026-07-18T01:00:00Z"]
  ]);
  let revision = 0;
  let oneShotSetFailureUsed = false;
  return invocation => {
    const args = [...invocation.args];
    const repository = args[args.indexOf("--repo") + 1];
    const action = args[1];
    calls.push({
      executable: invocation.executable,
      args,
      env: { ...invocation.env },
      input: Buffer.isBuffer(invocation.input)
        ? Buffer.from(invocation.input)
        : undefined,
      inputReference: invocation.input
    });
    if (action === "list") {
      if (repository === failListRepo) {
        return {
          status: 1,
          signal: null,
          stdout: Buffer.alloc(0),
          stderr: Buffer.from("fixed list failure\n", "utf8")
        };
      }
      const updatedAt = repository === malformedTimestampRepo
        ? "not-a-timestamp"
        : states.get(repository);
      const entries = repository === missingRepo
        ? []
        : [{ name: "REGISTRY_PASSWORD", updatedAt }];
      if (repository === duplicateRepo) entries.push({ ...entries[0] });
      return {
        status: 0,
        signal: null,
        stdout: Buffer.from(JSON.stringify(entries), "utf8"),
        stderr: Buffer.alloc(0)
      };
    }
    if (action === "set") {
      if (repository === failSetRepo ||
          (repository === failSetRepoOnce && !oneShotSetFailureUsed)) {
        if (repository === failSetRepoOnce) oneShotSetFailureUsed = true;
        return {
          status: 1,
          signal: null,
          stdout: Buffer.alloc(0),
          stderr: Buffer.from("fixed set failure\n", "utf8")
        };
      }
      if (repository !== unchangedRepo) {
        revision += 1;
        states.set(repository, `2026-07-19T05:00:0${revision}Z`);
      }
      return {
        status: 0,
        signal: null,
        stdout: repository === echoOutputRepo
          ? Buffer.from(invocation.input)
          : Buffer.from("fixed set confirmation\n", "utf8"),
        stderr: Buffer.alloc(0)
      };
    }
    return {
      status: 1,
      signal: null,
      stdout: Buffer.alloc(0),
      stderr: Buffer.from("fixed unexpected command\n", "utf8")
    };
  };
}

function parsedFile(filePath) {
  return parseLocalValuesSource(fs.readFileSync(filePath, "utf8"));
}

test("pure V1 encoder is ordered, parseable and does not mutate its input", () => {
  const input = fixture();
  const values = providerSecrets();
  const source = new Map(Object.entries(values));
  const before = new Map(source);
  let frame;
  try {
    frame = encodeProcessLocalSecretInputFrame(source);
    const parsed = parseProcessLocalSecretInputFrame(
      frame,
      new Map(Object.entries(input.values))
    );
    assert.deepEqual([...parsed.entries()], EXTERNAL_KEYS.map(name => [name, values[name]]));
    assert.deepEqual(source, before);
  } finally {
    if (frame) frame.fill(0);
    cleanup(input.root);
  }
});

test("Keychain labels are fixed and no secret enters runner argv or env", async () => {
  const input = fixture();
  const values = providerSecrets();
  const securityCalls = [];
  let preparerInvocation;
  try {
    const token = await prepareProcessLocalNewValuesFromKeychain({
      oldValuesSource: input.oldValuesSource,
      newValuesSource: input.newValuesSource,
      keychainAccount: ACCOUNT,
      keychainPrefix: PREFIX,
      securityRunner: fakeSecurityRunner(values, securityCalls),
      preparerRunner: async invocation => {
        preparerInvocation = {
          args: [...invocation.args],
          env: { ...invocation.env },
          frame: Buffer.from(invocation.frame)
        };
        return true;
      }
    });
    assert.equal(token, "aud065_new_values_prepared_from_keychain");
    assert.equal(securityCalls.length, EXTERNAL_KEYS.length);
    for (let index = 0; index < securityCalls.length; index += 1) {
      const call = securityCalls[index];
      assert.equal(call.executable, "/usr/bin/security");
      assert.deepEqual(call.args, [
        "find-generic-password",
        "-w",
        "-s",
        `${PREFIX}-${EXTERNAL_KEYS[index]}`,
        "-a",
        ACCOUNT
      ]);
      assert.equal(call.args.includes("-g"), false);
      assert.equal(call.args.includes("-A"), false);
    }
    const allInvocations = [
      ...securityCalls.map(call => `${call.args.join("\0")}\0${Object.values(call.env).join("\0")}`),
      `${preparerInvocation.args.join("\0")}\0${Object.values(preparerInvocation.env).join("\0")}`
    ].join("\0");
    for (const sentinel of Object.values(values)) {
      assert.equal(allInvocations.includes(sentinel), false);
    }
    const parsedFrame = parseProcessLocalSecretInputFrame(
      preparerInvocation.frame,
      new Map(Object.entries(input.values))
    );
    assert.deepEqual([...parsedFrame.entries()], EXTERNAL_KEYS.map(name => [name, values[name]]));
  } finally {
    if (preparerInvocation?.frame) preparerInvocation.frame.fill(0);
    cleanup(input.root);
  }
});

test("unconfigured optional providers are not queried", async () => {
  const input = fixture({ optionalConfigured: false });
  const values = providerSecrets({ optionalConfigured: false });
  const calls = [];
  let capturedFrame;
  try {
    const token = await prepareProcessLocalNewValuesFromKeychain({
      oldValuesSource: input.oldValuesSource,
      newValuesSource: input.newValuesSource,
      keychainAccount: ACCOUNT,
      keychainPrefix: PREFIX,
      securityRunner: fakeSecurityRunner(values, calls),
      preparerRunner: async invocation => {
        capturedFrame = Buffer.from(invocation.frame);
        return true;
      }
    });
    assert.equal(token, "aud065_new_values_prepared_from_keychain");
    assert.deepEqual(
      calls.map(call => call.args[call.args.indexOf("-s") + 1]),
      EXTERNAL_KEYS.slice(0, 3).map(name => `${PREFIX}-${name}`)
    );
    const parsed = parseProcessLocalSecretInputFrame(
      capturedFrame,
      new Map(Object.entries(input.values))
    );
    assert.equal(parsed.get("SKETCHFAB_API_KEY"), "");
    assert.equal(parsed.get("TENOR_API_KEY"), "");
  } finally {
    if (capturedFrame) capturedFrame.fill(0);
    cleanup(input.root);
  }
});

test("injected Keychain reads integrate with the real preparer through FD3", async () => {
  const input = fixture({ optionalConfigured: true, includeJwt: true });
  const values = providerSecrets();
  const calls = [];
  try {
    const token = await prepareProcessLocalNewValuesFromKeychain({
      oldValuesSource: input.oldValuesSource,
      newValuesSource: input.newValuesSource,
      keychainAccount: ACCOUNT,
      keychainPrefix: PREFIX,
      securityRunner: fakeSecurityRunner(values, calls)
    });
    assert.equal(token, "aud065_new_values_prepared_from_keychain");
    const prepared = parsedFile(input.newValuesSource);
    assert.equal(prepared.get("OPENAI_API_KEY"), values.OPENAI_API_KEY);
    assert.equal(prepared.get("SMTP_PASS"), values.SMTP_PASS);
    assert.equal(prepared.get("SKETCHFAB_API_KEY"), values.SKETCHFAB_API_KEY);
    assert.equal(prepared.get("TENOR_API_KEY"), values.TENOR_API_KEY);
    const dockerConfig = JSON.parse(Buffer.from(
      prepared.get("BOT_IMAGE_PULL_CONFIG_JSON_BASE64"),
      "base64"
    ).toString("utf8"));
    const basic = Buffer.from(
      dockerConfig.auths["ghcr.io"].auth,
      "base64"
    ).toString("utf8");
    assert.equal(basic, `fixture-user:${values.GHCR_TOKEN}`);
    const stat = fs.lstatSync(input.newValuesSource);
    assert.equal(stat.mode & 0o7777, 0o600);
    assert.equal(stat.nlink, 1);
  } finally {
    cleanup(input.root);
  }
});

test("Keychain failure does not publish and CLI diagnostics stay generic", async () => {
  const input = fixture();
  const values = providerSecrets();
  const calls = [];
  try {
    await assert.rejects(
      prepareProcessLocalNewValuesFromKeychain({
        oldValuesSource: input.oldValuesSource,
        newValuesSource: input.newValuesSource,
        keychainAccount: ACCOUNT,
        keychainPrefix: PREFIX,
        securityRunner: fakeSecurityRunner(values, calls, { failName: "SMTP_PASS" })
      }),
      error => error?.code === "keychain_lookup_failed"
    );
    assert.equal(fs.existsSync(input.newValuesSource), false);
    const cli = spawnSync(process.execPath, [CLI, "--invalid"], {
      cwd: ROOT,
      encoding: "utf8",
      env: { PATH: process.env.PATH, LANG: "C" }
    });
    assert.equal(cli.status, 1);
    assert.equal(cli.stdout, "");
    assert.equal(cli.stderr, "AUD-065 keychain preparation failed closed\n");
    for (const sentinel of Object.values(values)) {
      assert.equal(cli.stdout.includes(sentinel), false);
      assert.equal(cli.stderr.includes(sentinel), false);
    }
  } finally {
    cleanup(input.root);
  }
});

test("timeout-like Keychain runner errors fail closed without disclosure", async () => {
  const input = fixture();
  const sentinel = "timeout-keychain-secret-sentinel";
  let caught;
  try {
    try {
      await prepareProcessLocalNewValuesFromKeychain({
        oldValuesSource: input.oldValuesSource,
        newValuesSource: input.newValuesSource,
        keychainAccount: ACCOUNT,
        keychainPrefix: PREFIX,
        securityRunner: () => ({
          status: null,
          signal: "SIGKILL",
          error: Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }),
          stdout: Buffer.from(`${sentinel}\n`, "utf8"),
          stderr: Buffer.from(`${sentinel}\n`, "utf8")
        })
      });
    } catch (error) {
      caught = error;
    }
    assert.equal(caught?.code, "keychain_lookup_failed");
    assert.equal(String(caught).includes(sentinel), false);
    assert.equal(fs.existsSync(input.newValuesSource), false);
  } finally {
    cleanup(input.root);
  }
});

test("real child runner rejects an incorrect token and any stderr", async t => {
  const cases = [
    ["wrong token", "process.stdout.write('wrong-fixed-token\\n')"],
    ["stderr", "process.stderr.write('fixed-child-error\\n');process.exit(1)"]
  ];
  for (const [name, program] of cases) {
    await t.test(name, async () => {
      const frame = Buffer.from("public-fixture-frame", "utf8");
      try {
        await assert.rejects(
          runRealProcessLocalPreparer({
            executable: process.execPath,
            args: ["-e", program],
            env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
            cwd: ROOT,
            frame
          }),
          error => error?.code === "preparer_failed"
        );
      } finally {
        frame.fill(0);
      }
    });
  }
});

test("Actions supervisor preflights both repositories and sends only validated Keychain bytes", () => {
  const token = `actions-ghcr-sentinel-${"V".repeat(40)}`;
  const securityCalls = [];
  const ghCalls = [];
  try {
    const result = updateAud065ActionsSecretsFromKeychain({
      keychainAccount: ACCOUNT,
      keychainPrefix: PREFIX,
      securityRunner: fakeSecurityRunner({ GHCR_TOKEN: token }, securityCalls),
      ghRunner: fakeGhRunner({ calls: ghCalls }),
      ghExecutable: "/fixture/bin/gh"
    });
    assert.equal(result, "aud065_actions_secrets_updated");
    assert.equal(securityCalls.length, 1);
    assert.deepEqual(securityCalls[0].args, [
      "find-generic-password", "-w", "-s", `${PREFIX}-GHCR_TOKEN`,
      "-a", ACCOUNT
    ]);
    assert.deepEqual(ghCalls.map(call => [
      call.args[1],
      call.args[call.args.indexOf("--repo") + 1]
    ]), [
      ["list", "yengalvez/hubs"],
      ["list", "yengalvez/hubs-cloud"],
      ["set", "yengalvez/hubs"],
      ["list", "yengalvez/hubs"],
      ["set", "yengalvez/hubs-cloud"],
      ["list", "yengalvez/hubs-cloud"]
    ]);
    const setCalls = ghCalls.filter(call => call.args[1] === "set");
    assert.equal(setCalls.length, 2);
    for (const call of setCalls) {
      assert.deepEqual(call.input, Buffer.from(token, "utf8"));
      assert.deepEqual(call.args.slice(0, 5), [
        "secret", "set", "REGISTRY_PASSWORD", "--app", "actions"
      ]);
      assert.equal(call.inputReference.every(byte => byte === 0), true);
    }
    assert.equal(securityCalls[0].stdout.every(byte => byte === 0), true);
    const invocationText = ghCalls.map(call =>
      `${call.executable}\0${call.args.join("\0")}\0${Object.values(call.env).join("\0")}`
    ).join("\0");
    assert.equal(invocationText.includes(token), false);
  } finally {
    for (const call of ghCalls) if (call.input) call.input.fill(0);
  }
});

test("Actions supervisor completes every read-only preflight before mutation", async t => {
  const token = `actions-ghcr-sentinel-${"W".repeat(40)}`;
  await t.test("Keychain failure performs no GitHub call", () => {
    const ghCalls = [];
    assert.throws(() => updateAud065ActionsSecretsFromKeychain({
      keychainAccount: ACCOUNT,
      keychainPrefix: PREFIX,
      securityRunner: () => ({
        status: 1,
        signal: null,
        stdout: Buffer.alloc(0),
        stderr: Buffer.from("fixed keychain failure\n", "utf8")
      }),
      ghRunner: fakeGhRunner({ calls: ghCalls }),
      ghExecutable: "/fixture/bin/gh"
    }), error => error?.code === "keychain_lookup_failed");
    assert.equal(ghCalls.length, 0);
  });
  await t.test("second repository list failure performs no set", () => {
    const ghCalls = [];
    assert.throws(() => updateAud065ActionsSecretsFromKeychain({
      keychainAccount: ACCOUNT,
      keychainPrefix: PREFIX,
      securityRunner: fakeSecurityRunner({ GHCR_TOKEN: token }, []),
      ghRunner: fakeGhRunner({
        calls: ghCalls,
        failListRepo: "yengalvez/hubs-cloud"
      }),
      ghExecutable: "/fixture/bin/gh"
    }), error => error?.code === "gh_list_failed");
    assert.equal(ghCalls.some(call => call.args[1] === "set"), false);
  });
});

test("Actions supervisor rejects invalid Keychain bytes and list metadata before mutation", async t => {
  const token = `actions-ghcr-sentinel-${"Y".repeat(40)}`;
  const invalidKeychainCases = [
    ["double newline", Buffer.from(`${token}\n\n`, "utf8")],
    ["control byte", Buffer.from(`${token}\u0007\n`, "utf8")],
    ["oversize", Buffer.concat([Buffer.alloc(16 * 1024 + 1, 0x41), Buffer.from("\n")])]
  ];
  for (const [name, stdout] of invalidKeychainCases) {
    await t.test(`Keychain ${name}`, () => {
      const ghCalls = [];
      assert.throws(() => updateAud065ActionsSecretsFromKeychain({
        keychainAccount: ACCOUNT,
        keychainPrefix: PREFIX,
        securityRunner: () => ({
          status: 0,
          signal: null,
          stdout,
          stderr: Buffer.alloc(0)
        }),
        ghRunner: fakeGhRunner({ calls: ghCalls }),
        ghExecutable: "/fixture/bin/gh"
      }), error => error?.code === "keychain_secret_invalid" ||
        error?.code === "keychain_lookup_failed");
      assert.equal(ghCalls.length, 0);
    });
  }
  const inventoryCases = [
    ["missing", { missingRepo: "yengalvez/hubs-cloud" }, "gh_secret_preflight_missing"],
    ["duplicate", { duplicateRepo: "yengalvez/hubs-cloud" }, "gh_list_invalid"],
    ["malformed timestamp", {
      malformedTimestampRepo: "yengalvez/hubs-cloud"
    }, "gh_list_invalid"]
  ];
  for (const [name, options, code] of inventoryCases) {
    await t.test(`Actions list ${name}`, () => {
      const ghCalls = [];
      assert.throws(() => updateAud065ActionsSecretsFromKeychain({
        keychainAccount: ACCOUNT,
        keychainPrefix: PREFIX,
        securityRunner: fakeSecurityRunner({ GHCR_TOKEN: token }, []),
        ghRunner: fakeGhRunner({ calls: ghCalls, ...options }),
        ghExecutable: "/fixture/bin/gh"
      }), error => error?.code === code);
      assert.equal(ghCalls.some(call => call.args[1] === "set"), false);
    });
  }
});

test("Actions supervisor rejects set failure and unchanged updatedAt without continuing", async t => {
  const token = `actions-ghcr-sentinel-${"X".repeat(40)}`;
  await t.test("first set failure stops before the second repository", () => {
    const ghCalls = [];
    assert.throws(() => updateAud065ActionsSecretsFromKeychain({
      keychainAccount: ACCOUNT,
      keychainPrefix: PREFIX,
      securityRunner: fakeSecurityRunner({ GHCR_TOKEN: token }, []),
      ghRunner: fakeGhRunner({
        calls: ghCalls,
        failSetRepo: "yengalvez/hubs"
      }),
      ghExecutable: "/fixture/bin/gh"
    }), error => error?.code === "gh_set_failed");
    assert.equal(ghCalls.some(call => call.args[1] === "set" &&
      call.args.includes("yengalvez/hubs-cloud")), false);
  });
  await t.test("unchanged timestamp cannot reuse the existing secret as evidence", () => {
    const ghCalls = [];
    assert.throws(() => updateAud065ActionsSecretsFromKeychain({
      keychainAccount: ACCOUNT,
      keychainPrefix: PREFIX,
      securityRunner: fakeSecurityRunner({ GHCR_TOKEN: token }, []),
      ghRunner: fakeGhRunner({
        calls: ghCalls,
        unchangedRepo: "yengalvez/hubs"
      }),
      ghExecutable: "/fixture/bin/gh"
    }), error => error?.code === "gh_secret_update_not_observed");
    assert.equal(ghCalls.some(call => call.args[1] === "set" &&
      call.args.includes("yengalvez/hubs-cloud")), false);
  });
  await t.test("child output containing the credential fails without a second set", () => {
    const ghCalls = [];
    assert.throws(() => updateAud065ActionsSecretsFromKeychain({
      keychainAccount: ACCOUNT,
      keychainPrefix: PREFIX,
      securityRunner: fakeSecurityRunner({ GHCR_TOKEN: token }, []),
      ghRunner: fakeGhRunner({
        calls: ghCalls,
        echoOutputRepo: "yengalvez/hubs"
      }),
      ghExecutable: "/fixture/bin/gh"
    }), error => error?.code === "gh_set_failed" &&
      !String(error).includes(token));
    assert.equal(ghCalls.some(call => call.args[1] === "set" &&
      call.args.includes("yengalvez/hubs-cloud")), false);
  });
});

test("Actions supervisor converges after a second-repository partial update", () => {
  const token = `actions-ghcr-sentinel-${"Z".repeat(40)}`;
  const ghCalls = [];
  const securityRunner = fakeSecurityRunner({ GHCR_TOKEN: token }, []);
  const ghRunner = fakeGhRunner({
    calls: ghCalls,
    failSetRepoOnce: "yengalvez/hubs-cloud"
  });
  try {
    assert.throws(() => updateAud065ActionsSecretsFromKeychain({
      keychainAccount: ACCOUNT,
      keychainPrefix: PREFIX,
      securityRunner,
      ghRunner,
      ghExecutable: "/fixture/bin/gh"
    }), error => error?.code === "gh_set_failed");
    assert.deepEqual(
      ghCalls.filter(call => call.args[1] === "set").map(call =>
        call.args[call.args.indexOf("--repo") + 1]
      ),
      ["yengalvez/hubs", "yengalvez/hubs-cloud"]
    );

    assert.equal(updateAud065ActionsSecretsFromKeychain({
      keychainAccount: ACCOUNT,
      keychainPrefix: PREFIX,
      securityRunner,
      ghRunner,
      ghExecutable: "/fixture/bin/gh"
    }), "aud065_actions_secrets_updated");
    const setCalls = ghCalls.filter(call => call.args[1] === "set");
    assert.deepEqual(setCalls.map(call =>
      call.args[call.args.indexOf("--repo") + 1]
    ), [
      "yengalvez/hubs",
      "yengalvez/hubs-cloud",
      "yengalvez/hubs",
      "yengalvez/hubs-cloud"
    ]);
    for (const call of setCalls) {
      assert.deepEqual(call.input, Buffer.from(token, "utf8"));
      assert.equal(call.inputReference.every(byte => byte === 0), true);
    }
  } finally {
    for (const call of ghCalls) if (call.input) call.input.fill(0);
  }
});

test("Actions supervisor CLI rejects a concurrent writer before Keychain", async t => {
  if (!fs.existsSync("/usr/bin/lockf")) {
    t.skip("macOS lockf is required only by the macOS Keychain CLI");
    return;
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  const lockParent = path.join("/tmp", `yenhubs-aud065-${uid}`);
  try {
    fs.mkdirSync(lockParent, { mode: 0o700 });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  const lockParentStat = fs.lstatSync(lockParent, { bigint: true });
  assert.equal(lockParentStat.isDirectory(), true);
  assert.equal(lockParentStat.isSymbolicLink(), false);
  if (typeof process.getuid === "function") {
    assert.equal(lockParentStat.uid, BigInt(process.getuid()));
  }
  assert.equal(Number(lockParentStat.mode & 0o7777n), 0o700);
  const lockPath = path.join(lockParent, "actions-secrets.lock");
  const holder = spawn("/usr/bin/lockf", [
    "-s", "-t", "0", lockPath,
    process.execPath,
    "-e",
    "process.stdout.write('aud065-lock-ready\\n');process.stdin.resume()"
  ], { stdio: ["pipe", "pipe", "pipe"] });
  try {
    const ready = await new Promise((resolve, reject) => {
      let timeout;
      const cleanup = () => {
        clearTimeout(timeout);
        holder.stdout.off("data", onData);
        holder.off("close", onClose);
        holder.off("error", onError);
      };
      const onData = data => {
        cleanup();
        resolve(data);
      };
      const onClose = (code, signal) => {
        cleanup();
        reject(new Error(`lock holder closed before ready: ${code}/${signal}`));
      };
      const onError = error => {
        cleanup();
        reject(error);
      };
      holder.stdout.on("data", onData);
      holder.once("close", onClose);
      holder.once("error", onError);
      timeout = setTimeout(() => {
        cleanup();
        holder.kill("SIGKILL");
        reject(new Error("lock holder readiness timed out"));
      }, 5_000);
    });
    assert.equal(ready.toString("utf8"), "aud065-lock-ready\n");
    const result = spawnSync(process.execPath, [
      ACTIONS_CLI,
      "--keychain-account", ACCOUNT,
      "--keychain-prefix", PREFIX
    ], {
      cwd: ROOT,
      encoding: "utf8",
      env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: "C" },
      timeout: 5_000
    });
    assert.equal(result.status, 75);
    assert.equal(result.signal, null);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "AUD-065 Actions secret update failed closed\n");
  } finally {
    if (!holder.stdin.destroyed) holder.stdin.end();
    if (holder.exitCode === null && holder.signalCode === null) {
      await new Promise(resolve => {
        const closeTimeout = setTimeout(() => holder.kill("SIGKILL"), 5_000);
        holder.once("close", () => {
          clearTimeout(closeTimeout);
          resolve();
        });
      });
    }
  }
});

test("Actions supervisor CLI exposes one generic failure only", () => {
  const result = spawnSync(process.execPath, [ACTIONS_CLI, "--invalid"], {
    cwd: ROOT,
    encoding: "utf8",
    env: { PATH: process.env.PATH, LANG: "C" }
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "AUD-065 Actions secret update failed closed\n");
});
