#!/usr/bin/env node
// Prepare private generator inputs from the current production identities.
// Never emit credential values or raw Kubernetes errors.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";

const require = createRequire(import.meta.url);
const YAML = require("../hubs-cloud/community-edition/node_modules/yaml");
const { writeAtomicPrivateFile } = require("../hubs-cloud/community-edition/utils");
const [source, outputDirectory, context] = process.argv.slice(2);
function serialize(values) {
  return Object.entries(values).map(([key, value]) =>
    `${key}: ${JSON.stringify(key === "PERMS_KEY" ? value.replace(/\n/g, "\\n") : value)}`
  ).join("\n") + "\n";
}
if (source === "--normalize") {
  for (const file of process.argv.slice(3)) {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600) process.exit(2);
    writeAtomicPrivateFile(file, serialize(YAML.parse(fs.readFileSync(file, "utf8"))));
  }
  console.log("Private values normalized; values unchanged.");
  process.exit(0);
}
if (source === "--set") {
  const [file, name, value] = process.argv.slice(3);
  const allowed = name === "OVERRIDE_HUBS_IMAGE"
    ? /^ghcr\.io\/yengalvez\/hubs@sha256:[a-f0-9]{64}$/.test(value)
    : name === "BOT_RUNNER_ACTIVATION_PHASE" && ["bootstrap", "admission", "active"].includes(value);
  const stat = fs.lstatSync(file);
  if (!allowed || !stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600) process.exit(2);
  const values = YAML.parse(fs.readFileSync(file, "utf8"));
  values[name] = value;
  writeAtomicPrivateFile(file, serialize(values));
  console.log(`Updated ${name}; private values retained.`);
  process.exit(0);
}
const images = {
  reticulum: "RETICULUM", postgrest: "POSTGREST", postgresql: "POSTGRES",
  pgbouncer: "PGBOUNCER", "pgbouncer-t": "PGBOUNCER", hubs: "HUBS", spoke: "SPOKE",
  nearspark: "NEARSPARK", photomnemonic: "PHOTOMNEMONIC", dialog: "DIALOG",
  coturn: "COTURN", haproxy: "HAPROXY", "bot-orchestrator": "BOT_ORCHESTRATOR"
};
function get(...args) {
  const result = spawnSync("kubectl", ["--context", context, "--request-timeout=45s", ...args, "-o", "json"], {
    encoding: "utf8", maxBuffer: 32 * 1024 * 1024
  });
  if (result.status !== 0) throw new Error("production_read_failed");
  return JSON.parse(result.stdout);
}
try {
  if (!source || !outputDirectory || !context) throw new Error("source_output_context_required");
  const sourceStat = fs.lstatSync(source);
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink() || (sourceStat.mode & 0o777) !== 0o600) {
    throw new Error("private_source_required");
  }
  const values = YAML.parse(fs.readFileSync(source, "utf8"));
  const namespace = values.Namespace;
  const liveNamespace = get("get", "namespace", namespace);
  if (liveNamespace.metadata.annotations?.["yenhubs.org/target-profile"] !== "cold-rebind-legacy-active-v1") {
    throw new Error("current_cold_rebind_profile_required");
  }
  const deployments = get("get", "deployment", "-n", namespace).items;
  if (deployments.length !== 12) throw new Error("deployment_inventory_changed");
  for (const deployment of deployments) {
    for (const container of deployment.spec.template.spec.containers) {
      if (!images[container.name] || !/@sha256:[a-f0-9]{64}$/.test(container.image)) {
        throw new Error("unexpected_live_image");
      }
      values[`OVERRIDE_${images[container.name]}_IMAGE`] = container.image;
    }
  }
  // Use the live values, not a historical credential snapshot. The generator
  // will independently derive the public JWT key from the retained PERMS_KEY.
  const secret = get("get", "secret", "configs", "-n", namespace);
  for (const [name, encoded] of Object.entries(secret.data)) {
    if (name !== "PGRST_JWT_SECRET") values[name] = Buffer.from(encoded, "base64").toString("utf8");
  }
  values.PERMS_KEY = values.PERMS_KEY.replace(/\\+n/g, "\n");
  const pull = get("get", "secret", "bot-images-pull", "-n", namespace);
  values.BOT_IMAGE_PULL_CONFIG_JSON_BASE64 = pull.data[".dockerconfigjson"];
  values.BOT_RUNNER_ACTIVATION_PHASE = "bootstrap";
  values.BOT_RUNNER_RECOVERY_PHASE = "active";
  values.BOT_RUNNER_RECOVERY_EPOCH = crypto.randomUUID();
  for (const name of ["BOT_RUNNER_ACCESS_KEY", "BOT_ORCHESTRATOR_ACCESS_KEY", "DASHBOARD_ACCESS_KEY"]) {
    values[name] = crypto.randomBytes(48).toString("hex");
  }
  fs.mkdirSync(outputDirectory, { mode: 0o700 });
  writeAtomicPrivateFile(path.join(outputDirectory, "baseline-values.yaml"), serialize(values));
  const candidate = { ...values,
    OVERRIDE_BOT_ORCHESTRATOR_IMAGE: "ghcr.io/yengalvez/bot-orchestrator@sha256:03aa3dc507de613ca14f9996851a386d5c7e65595be9ad71ad0a797acf2d2d95",
    OVERRIDE_BOT_RUNNER_IMAGE: "ghcr.io/yengalvez/bot-runner@sha256:3bba970e5a1fa5e82b234d8818b05ed3cdf4282621ed8a4e72be20d9c06355d6"
  };
  writeAtomicPrivateFile(path.join(outputDirectory, "bootstrap-values.yaml"), serialize(candidate));
  console.log(JSON.stringify({ status: "prepared", namespace, namespaceUid: liveNamespace.metadata.uid,
    deployments: deployments.length, existingCredentials: "retained", outputDirectory }));
} catch (error) {
  console.error(/^[a-z_]+$/.test(error.message) ? error.message : "private_candidate_preparation_failed");
  process.exitCode = 1;
}
