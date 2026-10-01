import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";

import { parseLocalValuesSource } from "../../deployment/parse-local-values.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const preparer = path.join(root, "deployment/prepare-staging-values.mjs");
const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const sourceEpoch = "44444444-4444-4444-8444-444444444444";

// Synthetic values only. These image digests are not build provenance and
// these bytes must never be treated as an applicable cluster configuration.
function sourceText(overrides = {}, { modules = true } = {}) {
  const values = {
    HUB_DOMAIN: "recovery.example.invalid",
    Namespace: "hcce",
    OVERRIDE_RETICULUM_IMAGE: `ghcr.io/yengalvez/reticulum@sha256:${"1".repeat(64)}`,
    OVERRIDE_HUBS_IMAGE: `ghcr.io/yengalvez/hubs@sha256:${"2".repeat(64)}`,
    OVERRIDE_BOT_ORCHESTRATOR_IMAGE: `ghcr.io/yengalvez/bot-orchestrator@sha256:${"3".repeat(64)}`,
    OVERRIDE_BOT_RUNNER_IMAGE: `ghcr.io/yengalvez/bot-runner@sha256:${"4".repeat(64)}`,
    BOT_RUNNER_ACTIVATION_PHASE: "active",
    BOT_RUNNER_RECOVERY_PHASE: "active",
    BOT_RUNNER_RECOVERY_EPOCH: sourceEpoch,
    DB_PASS: "synthetic-only-$UNCHANGED-\"-ñ",
    OPENAI_API_KEY: "synthetic-disabled-provider-key",
    ...overrides
  };
  return [
    "# Preserve comments, the module block and legacy literal PEM layout.",
    ...(modules ? [
      "PRODUCT_MODULES:",
      "  schema_version: 1",
      "  bots: true",
      "  ai: true",
      "  avaturn: true",
      '  avaturn_creator_url: "https://virtualmente.avaturn.dev"'
    ] : []),
    ...Object.entries(values).filter(([, value]) => value !== undefined)
      .map(([key, value]) => `${key}: ${JSON.stringify(String(value))}`),
    "PERMS_KEY: |",
    "  PUBLIC-TEST-PLACEHOLDER",
    "# No generated manifest, credentials or remote service is exercised here.",
    ""
  ].join("\r\n");
}

function fixture(t) {
  const directory = fs.mkdtempSync("/private/tmp/yn-recovery-values-");
  fs.chmodSync(directory, 0o700);
  // Only this test's own flat synthetic directory is removed.
  t.after(() => fs.rmSync(directory, { recursive: true }));
  return directory;
}

function writeSource(directory, bytes) {
  const source = path.join(directory, "source.yaml");
  fs.writeFileSync(source, bytes, { mode: 0o600 });
  return source;
}

function transition(source, output, from, to, extra = []) {
  return spawnSync(process.execPath, [
    preparer, "--transition-recovery-phase", source, output, from, to, ...extra
  ], {
    cwd: root,
    env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
    encoding: "utf8",
    timeout: 10000
  });
}

function withoutRecovery(bytes) {
  return bytes.split(/(?<=\n)/u).filter(line =>
    !/^BOT_RUNNER_RECOVERY_(?:PHASE|EPOCH):/u.test(line)
  ).join("");
}

test("recovery values prepare a new fence epoch and keep that exact epoch for reactivation", t => {
  const directory = fixture(t);
  const sourceBytes = sourceText();
  const source = writeSource(directory, sourceBytes);
  const fence = path.join(directory, "fence.yaml");
  const active = path.join(directory, "active.yaml");
  const prepare = transition(source, fence, "active", "restore-fence");
  assert.equal(prepare.status, 0, "the preparer must provide the required recovery transition");
  assert.equal(prepare.stdout, "staging_recovery_phase_restore-fence_prepared\n");
  assert.equal(prepare.stderr, "");
  const fenceBytes = fs.readFileSync(fence, "utf8");
  const fenceValues = parseLocalValuesSource(fenceBytes);
  assert.equal(fenceValues.get("BOT_RUNNER_RECOVERY_PHASE"), "restore-fence");
  assert.match(fenceValues.get("BOT_RUNNER_RECOVERY_EPOCH"), uuidV4);
  assert.notEqual(fenceValues.get("BOT_RUNNER_RECOVERY_EPOCH"), sourceEpoch);
  assert.equal(withoutRecovery(fenceBytes), withoutRecovery(sourceBytes));
  const reactivate = transition(fence, active, "restore-fence", "active");
  assert.equal(reactivate.status, 0, "reactivation values must derive from the same fenced values");
  assert.equal(reactivate.stdout, "staging_recovery_phase_active_prepared\n");
  assert.equal(reactivate.stderr, "");
  const activeBytes = fs.readFileSync(active, "utf8");
  const activeValues = parseLocalValuesSource(activeBytes);
  assert.equal(activeValues.get("BOT_RUNNER_RECOVERY_PHASE"), "active");
  assert.equal(activeValues.get("BOT_RUNNER_RECOVERY_EPOCH"), fenceValues.get("BOT_RUNNER_RECOVERY_EPOCH"));
  assert.equal(withoutRecovery(activeBytes), withoutRecovery(sourceBytes));
  assert.equal(fs.readFileSync(source, "utf8"), sourceBytes);
  for (const output of [fence, active]) assert.equal(fs.statSync(output).mode & 0o7777, 0o600);
  assert.equal(fs.statSync(directory).mode & 0o7777, 0o700);
});

test("recovery values reject wrong phase, non-durable source and malformed epoch before publication", t => {
  const cases = [
    [{}, "active", "active"],
    [{}, "bootstrap", "restore-fence"],
    [{}, "restore-fence", "active"],
    [{ BOT_RUNNER_ACTIVATION_PHASE: "bootstrap" }, "active", "restore-fence"],
    [{ BOT_RUNNER_RECOVERY_PHASE: undefined }, "active", "restore-fence"],
    [{ BOT_RUNNER_RECOVERY_PHASE: "restore-fence" }, "active", "restore-fence"],
    [{ BOT_RUNNER_RECOVERY_EPOCH: undefined }, "active", "restore-fence"],
    [{ BOT_RUNNER_RECOVERY_EPOCH: "not-an-epoch" }, "active", "restore-fence"],
    [{ BOT_RUNNER_RECOVERY_EPOCH: sourceEpoch.replace("-8444-", "-B444-") }, "active", "restore-fence"],
    [{ BOT_RUNNER_RECOVERY_EPOCH: sourceEpoch.replace("-4444-8444-", "-3444-8444-") }, "active", "restore-fence"],
    [{ OVERRIDE_BOT_RUNNER_IMAGE: "No" }, "active", "restore-fence"],
    [{ OVERRIDE_BOT_RUNNER_IMAGE: `registry.invalid/pause@sha256:${"4".repeat(64)}` }, "active", "restore-fence"],
    [{ OVERRIDE_BOT_RUNNER_IMAGE: "ghcr.io/yengalvez/bot-runner:latest" }, "active", "restore-fence"]
  ];
  const directory = fixture(t);
  for (const [index, [overrides, from, to]] of cases.entries()) {
    const source = path.join(directory, `source-${index}.yaml`);
    fs.writeFileSync(source, sourceText(overrides), { mode: 0o600 });
    const output = path.join(directory, `output-${index}.yaml`);
    const result = transition(source, output, from, to);
    assert.equal(result.status, 1, `rejection ${index}`);
    assert.equal(result.stdout, "", `no partial result ${index}`);
    assert.equal(fs.existsSync(output), false, `no output ${index}`);
    assert.equal(fs.readFileSync(source, "utf8"), sourceText(overrides));
  }
});

test("recovery values require installed bots and preserve private publication guards", t => {
  const directory = fixture(t);
  for (const [index, bytes] of [
    sourceText({}, { modules: false }),
    sourceText().replace("  bots: true\r\n  ai: true", "  bots: false\r\n  ai: false")
  ].entries()) {
    const source = path.join(directory, `modules-${index}.yaml`);
    fs.writeFileSync(source, bytes, { mode: 0o600 });
    const output = path.join(directory, `modules-${index}-out.yaml`);
    const result = transition(source, output, "active", "restore-fence");
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(fs.existsSync(output), false);
  }
  const source = writeSource(directory, sourceText());
  const existing = path.join(directory, "existing.yaml");
  fs.writeFileSync(existing, "preserve this synthetic sentinel\n", { mode: 0o600 });
  const alias = path.join(directory, "alias.yaml");
  fs.symlinkSync(source, alias);
  for (const [input, output, extra] of [
    [source, source, []],
    [source, existing, []],
    [alias, path.join(directory, "linked-out.yaml"), []],
    [source, path.join(directory, "extra-out.yaml"), ["unexpected"]]
  ]) {
    const result = transition(input, output, "active", "restore-fence", extra);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
  }
  fs.chmodSync(source, 0o644);
  const publicOutput = path.join(directory, "public-out.yaml");
  assert.equal(transition(source, publicOutput, "active", "restore-fence").status, 1);
  assert.equal(fs.existsSync(publicOutput), false);
  assert.equal(fs.readFileSync(source, "utf8"), sourceText());
  assert.equal(fs.readFileSync(existing, "utf8"), "preserve this synthetic sentinel\n");
});

test("recovery values do not require an AI key or enable extras in a bots-only source", t => {
  const directory = fixture(t);
  const bytes = sourceText({ OPENAI_API_KEY: undefined })
    .replace("  ai: true", "  ai: false")
    .replace("  avaturn: true", "  avaturn: false")
    .replace('  avaturn_creator_url: "https://virtualmente.avaturn.dev"', '  avaturn_creator_url: ""');
  const source = writeSource(directory, bytes);
  const output = path.join(directory, "fence.yaml");
  const result = transition(source, output, "active", "restore-fence");
  assert.equal(result.status, 0);
  const prepared = fs.readFileSync(output, "utf8");
  const values = parseLocalValuesSource(prepared);
  assert.equal(values.has("OPENAI_API_KEY"), false);
  assert.deepEqual(values.get("PRODUCT_MODULES"), {
    schema_version: 1, bots: true, ai: false, avaturn: false, avaturn_creator_url: ""
  });
  assert.equal(withoutRecovery(prepared), withoutRecovery(bytes));
  assert.equal(fs.readFileSync(source, "utf8"), bytes);
});

test("recovery values feed the real Cloud generator and verifier without changing image locks", t => {
  const directory = fixture(t);
  const cloud = path.join(root, "hubs-cloud/community-edition");
  const require = createRequire(path.join(cloud, "package.json"));
  const YAML = require("yaml");
  const values = YAML.parse(fs.readFileSync(path.join(cloud, "input-values.ci.yaml"), "utf8"));
  values.OVERRIDE_BOT_RUNNER_IMAGE = `ghcr.io/yengalvez/bot-runner@sha256:${"4".repeat(64)}`;
  // Public fixture authorizations, never real registry credentials/pulls.
  const pull = JSON.parse(Buffer.from(values.BOT_IMAGE_PULL_CONFIG_JSON_BASE64, "base64"));
  pull.auths["ghcr.io"] = { auth: Buffer.from("synthetic-user:synthetic-token").toString("base64") };
  values.BOT_IMAGE_PULL_CONFIG_JSON_BASE64 = Buffer.from(JSON.stringify(pull)).toString("base64");
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" }
  });
  // Force the same quoted escaped-PEM scalar emitted by the existing preparer;
  // a YAML serializer's plain -----BEGIN prefix is outside the strict parser.
  const permsScalar = privateKey.replace(/\n/gu, "\\n");
  delete values.PERMS_KEY;
  const sourceBytes = YAML.stringify(values, { lineWidth: 0 }) +
    `PERMS_KEY: ${JSON.stringify(permsScalar)}\n`;
  const source = writeSource(directory, sourceBytes);
  const fence = path.join(directory, "fence.yaml");
  const active = path.join(directory, "active.yaml");
  assert.equal(transition(source, fence, "active", "restore-fence").status, 0);
  assert.equal(transition(fence, active, "restore-fence", "active").status, 0);
  const targetEpoch = parseLocalValuesSource(fs.readFileSync(fence, "utf8")).get("BOT_RUNNER_RECOVERY_EPOCH");
  const manifests = [];
  for (const [index, input] of [fence, active].entries()) {
    const output = path.join(directory, `manifest-${index}.yaml`);
    const environment = {
      PATH: "/usr/bin:/bin",
      LANG: "C.UTF-8",
      ...(process.env.NODE_PATH ? { NODE_PATH: process.env.NODE_PATH } : {}),
      HCCE_INPUT_VALUES_PATH: input,
      HCCE_OUTPUT_PATH: output
    };
    const generated = spawnSync(process.execPath, ["generate_script/index.js"], {
      cwd: cloud, env: environment, encoding: "utf8", timeout: 30000
    });
    assert.equal(generated.status, 0, `offline generator ${index} must succeed`);
    const verified = spawnSync(process.execPath, ["generate_script/verify-generated-manifest.js"], {
      cwd: cloud,
      env: { ...environment, HCCE_MANIFEST_PATH: output },
      encoding: "utf8",
      timeout: 30000
    });
    assert.equal(verified.status, 0, `unchanged generated-manifest verifier ${index} must succeed`);
    assert.equal(fs.statSync(output).mode & 0o7777, 0o600);
    const resources = YAML.parseAllDocuments(fs.readFileSync(output, "utf8")).map(doc => {
      assert.equal(doc.errors.length, 0);
      return doc.toJS();
    });
    for (const name of ["reticulum", "pgbouncer", "pgbouncer-t", "bot-orchestrator", "coturn"]) {
      const matches = resources.filter(resource => resource.kind === "Deployment" && resource.metadata.name === name);
      assert.equal(matches.length, 1);
      assert.equal(matches[0].spec.replicas, index);
      assert.equal(matches[0].metadata.annotations["yenhubs.org/bot-runner-recovery-phase"], index ? "active" : "restore-fence");
    }
    for (const name of ["reticulum", "bot-orchestrator"]) {
      const deployment = resources.find(resource => resource.kind === "Deployment" && resource.metadata.name === name);
      assert.equal(deployment.spec.template.metadata.annotations["yenhubs.org/bot-runner-recovery-epoch"], targetEpoch);
    }
    assert.equal(resources.find(resource => resource.kind === "Deployment" && resource.metadata.name === "pgsql").spec.replicas, 1);
    manifests.push(resources);
  }
  const imageLock = resources => resources.filter(resource => resource.kind === "Deployment")
    .flatMap(resource => (resource.spec.template.spec.containers || []).map(container =>
      `${resource.metadata.name}/${container.name}=${container.image}`
    )).sort();
  assert.deepEqual(imageLock(manifests[0]), imageLock(manifests[1]));
  assert.equal(fs.readFileSync(source, "utf8"), sourceBytes);
});
