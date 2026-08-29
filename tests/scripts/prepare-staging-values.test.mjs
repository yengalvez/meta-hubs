import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import YAML from "../../hubs-cloud/community-edition/node_modules/yaml/dist/index.js";

import { parseLocalValuesSource } from "../../deployment/parse-local-values.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const preparer = path.join(root, "deployment/prepare-staging-values.mjs");
const sourceTemplatePath = path.join(root, "hubs-cloud/community-edition/input-values.ci.yaml");

test("staging values materialize one concrete percent-encoded database URI", () => {
  const directory = fs.mkdtempSync("/private/tmp/yenhubs-staging-values-");
  const sharedPath = path.join(directory, "shared.yaml");
  const templatePath = path.join(directory, "template.yaml");
  const bootstrapPath = path.join(directory, "bootstrap.yaml");
  const finalPath = path.join(directory, "final.yaml");
  const repairedPath = path.join(directory, "repaired.yaml");
  const admissionPath = path.join(directory, "admission.yaml");
  const activePath = path.join(directory, "active.yaml");
  const legacyCompatiblePath = path.join(directory, "legacy-compatible.yaml");
  fs.writeFileSync(sharedPath, [
    "ADM_EMAIL: owner@example.invalid",
    "SMTP_SERVER: smtp.example.invalid",
    "SMTP_PORT: 2525",
    "SMTP_USER: staging-user",
    "SMTP_PASS: staging-pass",
    ""
  ].join("\n"), { mode: 0o600 });

  const template = YAML.parse(fs.readFileSync(sourceTemplatePath, "utf8"));
  template.PERMS_KEY = "test-placeholder";
  fs.writeFileSync(
    templatePath,
    Object.entries(template).map(([key, value]) => `${key}: ${JSON.stringify(String(value))}`).join("\n") + "\n"
  );
  const images = {
    reticulum: template.OVERRIDE_RETICULUM_IMAGE,
    postgrest: template.OVERRIDE_POSTGREST_IMAGE,
    postgres: template.OVERRIDE_POSTGRES_IMAGE,
    pgbouncer: template.OVERRIDE_PGBOUNCER_IMAGE,
    botOrchestrator: template.OVERRIDE_BOT_ORCHESTRATOR_IMAGE,
    botRunner: template.OVERRIDE_BOT_RUNNER_IMAGE,
    spoke: template.OVERRIDE_SPOKE_IMAGE,
    nearspark: template.OVERRIDE_NEARSPARK_IMAGE,
    photomnemonic: template.OVERRIDE_PHOTOMNEMONIC_IMAGE,
    dialog: template.OVERRIDE_DIALOG_IMAGE,
    coturn: template.OVERRIDE_COTURN_IMAGE,
    haproxy: template.OVERRIDE_HAPROXY_IMAGE,
    hubsLegacy: template.OVERRIDE_HUBS_IMAGE,
    hubsCandidate: template.OVERRIDE_HUBS_IMAGE
  };
  const result = spawnSync(process.execPath, [
    preparer,
    templatePath,
    sharedPath,
    bootstrapPath,
    finalPath,
    "staging.example.invalid",
    JSON.stringify(images)
  ], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);

  const bootstrap = parseLocalValuesSource(fs.readFileSync(bootstrapPath, "utf8"));
  const final = parseLocalValuesSource(fs.readFileSync(finalPath, "utf8"));
  const expected = `postgres://${encodeURIComponent(bootstrap.get("DB_USER"))}:` +
    `${encodeURIComponent(bootstrap.get("DB_PASS"))}@pgbouncer/` +
    `${encodeURIComponent(bootstrap.get("DB_NAME"))}`;
  assert.equal(bootstrap.get("PGRST_DB_URI"), expected);
  assert.equal(bootstrap.get("PSQL"), expected);
  assert.equal(final.get("PGRST_DB_URI"), expected);
  assert.equal(final.get("PSQL"), expected);
  assert.equal(expected.includes("$DB_"), false);

  const materialized = spawnSync(process.execPath, [
    preparer,
    "--materialize-database-uri",
    bootstrapPath,
    repairedPath
  ], { cwd: root, encoding: "utf8" });
  assert.equal(materialized.status, 0, materialized.stderr);
  const repaired = parseLocalValuesSource(fs.readFileSync(repairedPath, "utf8"));
  assert.equal(repaired.get("DB_PASS"), bootstrap.get("DB_PASS"));
  assert.equal(repaired.get("PGRST_DB_URI"), expected);
  assert.equal(repaired.get("PSQL"), expected);

  const admission = spawnSync(process.execPath, [
    preparer,
    "--transition-activation-phase",
    finalPath,
    admissionPath,
    "bootstrap",
    "admission"
  ], { cwd: root, encoding: "utf8" });
  assert.equal(admission.status, 0, admission.stderr);
  assert.equal(admission.stdout, "staging_activation_phase_admission_prepared\n");

  const active = spawnSync(process.execPath, [
    preparer,
    "--transition-activation-phase",
    admissionPath,
    activePath,
    "admission",
    "active"
  ], { cwd: root, encoding: "utf8" });
  assert.equal(active.status, 0, active.stderr);
  assert.equal(active.stdout, "staging_activation_phase_active_prepared\n");

  const admissionValues = parseLocalValuesSource(fs.readFileSync(admissionPath, "utf8"));
  const activeValues = parseLocalValuesSource(fs.readFileSync(activePath, "utf8"));
  assert.equal(admissionValues.get("BOT_RUNNER_ACTIVATION_PHASE"), "admission");
  assert.equal(activeValues.get("BOT_RUNNER_ACTIVATION_PHASE"), "active");
  const withoutPhase = values => new Map(
    [...values].filter(([key]) => key !== "BOT_RUNNER_ACTIVATION_PHASE")
  );
  assert.deepEqual(withoutPhase(admissionValues), withoutPhase(final));
  assert.deepEqual(withoutPhase(activeValues), withoutPhase(final));

  const legacyCompatible = spawnSync(process.execPath, [
    preparer,
    "--prepare-legacy-compatible",
    activePath,
    legacyCompatiblePath
  ], { cwd: root, encoding: "utf8" });
  assert.equal(legacyCompatible.status, 0, legacyCompatible.stderr);
  assert.equal(
    legacyCompatible.stdout,
    "staging_legacy_compatible_values_prepared\n"
  );
  const legacyCompatibleValues = parseLocalValuesSource(
    fs.readFileSync(legacyCompatiblePath, "utf8")
  );
  assert.equal(legacyCompatibleValues.get("OVERRIDE_BOT_RUNNER_IMAGE"), "No");
  const withoutRunnerImage = values => new Map(
    [...values].filter(([key]) => key !== "OVERRIDE_BOT_RUNNER_IMAGE")
  );
  assert.deepEqual(withoutRunnerImage(legacyCompatibleValues), withoutRunnerImage(activeValues));
  assert.equal(fs.statSync(legacyCompatiblePath).mode & 0o777, 0o600);
});
