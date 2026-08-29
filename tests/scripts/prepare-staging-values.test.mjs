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
});
