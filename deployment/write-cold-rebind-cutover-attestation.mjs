#!/usr/bin/env node
// A current cold-rebind baseline is not the historical AUD-065 rotation.
// Bind a separately verified, credential-preserving transition to live state.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cloud = path.join(root, "hubs-cloud/community-edition");
const YAML = require(path.join(cloud, "node_modules/yaml"));
const { canonicalJson, readPrivateCutoverBaseline, readPrivateCutoverKey } = require(path.join(cloud, "apply/process-local-cutover"));
const { COLD_REBIND_CUTOVER_PROFILE, coldRebindResourceDigest } = require(path.join(cloud, "apply/cold-rebind-cutover"));
const { applyLegacyActiveColdRebindProfile } = require(path.join(cloud, "generate_script/legacy-absent-cold-rebind-profile"));
const { writeAtomicPrivateFile } = require(path.join(cloud, "utils"));
const [directory, context] = process.argv.slice(2);
const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 180000, ...options });
  if (result.status !== 0) throw new Error("cutover_verification_command_failed");
  return result.stdout;
}
function kubectl(args, input) { return run("kubectl", ["--context", context, "--request-timeout=45s", ...args], { input }); }
const docs = bytes => YAML.parseAllDocuments(String(bytes)).map(d => { if (d.errors.length) throw new Error("manifest_parse_failed"); return d.toJS(); }).filter(Boolean);
const identity = r => `${r.apiVersion}/${r.kind}/${r.metadata.namespace || ""}/${r.metadata.name}`;
function sorted(resources) { return resources.sort((a, b) => identity(a).localeCompare(identity(b))); }
let stage = "inputs";

export function assertFreshCheckpoint(metadata, now = Date.now()) {
  const created = metadata?.created_at_epoch;
  if (typeof created !== "number" || !Number.isFinite(created) || created * 1000 > now + 30000 ||
      now - created * 1000 > 24 * 3600 * 1000) throw new Error("checkpoint_date_invalid");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
try {
  if (!directory || !context) throw new Error("directory_and_context_required");
  const baselinePath = path.join(directory, "baseline.yaml");
  const targetPath = path.join(directory, "bootstrap.yaml");
  const baselineBytes = readPrivateCutoverBaseline(baselinePath);
  const targetBytes = readPrivateCutoverBaseline(targetPath);
  const baseline = docs(baselineBytes);
  const target = docs(targetBytes);
  const values = YAML.parse(readPrivateCutoverBaseline(path.join(directory, "bootstrap-values.yaml")).toString());
  stage = "manifest-contracts";
  for (const [profile, bytes] of [["cold-rebind-legacy-active-v1", baselineBytes], [null, targetBytes]]) {
    const env = { ...process.env }; delete env.HCCE_TARGET_PROFILE;
    if (profile) env.HCCE_TARGET_PROFILE = profile;
    run(process.execPath, [path.join(cloud, "generate_script/verify-generated-manifest.js"), "--stdin"], { cwd: cloud, input: bytes, env });
  }
  if (values.BOT_RUNNER_ACTIVATION_PHASE !== "bootstrap") throw new Error("bootstrap_candidate_required");
  // Reverse only the already audited runner transformation. Any unrelated
  // resource, credential, storage, endpoint or feature change must still match.
  const reversed = docs(applyLegacyActiveColdRebindProfile({ ...values, OVERRIDE_BOT_RUNNER_IMAGE: "No" }, targetBytes.toString()));
  const baselineById = new Map(baseline.map(r => [identity(r), r]));
  for (const resource of reversed) {
    const original = baselineById.get(identity(resource));
    if (!original) throw new Error("unrelated_resource_change");
    if (resource.kind === "Namespace") {
      resource.metadata.annotations["yenhubs.org/target-image-map-sha256"] = original.metadata.annotations["yenhubs.org/target-image-map-sha256"];
    }
    if (resource.kind === "Deployment" && ["bot-orchestrator", "hubs"].includes(resource.metadata.name)) {
      resource.spec.template.spec.containers[0].image = original.spec.template.spec.containers[0].image;
    }
  }
  if (canonicalJson(sorted(reversed)) !== canonicalJson(sorted(baseline))) throw new Error("unrelated_candidate_change");
  stage = "live-baseline";
  // Capture no diff output: it can contain credentials. A nonzero result blocks.
  kubectl(["diff", "-f", "-"], baselineBytes);
  const live = JSON.parse(kubectl(["get", "-f", "-", "-o", "json"], baselineBytes));
  const namespace = live.items.find(r => r.kind === "Namespace" && r.metadata.name === values.Namespace);
  const parent = live.items.find(r => r.kind === "Deployment" && r.metadata.name === "bot-orchestrator");
  if (!namespace || !parent) throw new Error("baseline_identity_missing");
  const env = { ...process.env, EXPECTED_KUBE_CONTEXT: context, EXPECTED_NAMESPACE_UID: namespace.metadata.uid,
    NAMESPACE: values.Namespace, VALUES_FILE: path.join(directory, "baseline-values.yaml") };
  run("bash", ["-c", 'source deployment/lib/recovery-safety.sh; recovery_require_cluster_identity && recovery_require_live_process_local_cold_rebind_target_exact "$VALUES_FILE"'], { cwd: root, env });
  stage = "checkpoint";
  const checkpoint = path.join(directory, "checkpoint-before-cutover");
  if (fs.existsSync(path.join(checkpoint, ".yenhubs-incomplete"))) throw new Error("checkpoint_incomplete");
  const metadata = JSON.parse(fs.readFileSync(path.join(checkpoint, "checkpoint-metadata.json"), "utf8"));
  assertFreshCheckpoint(metadata);
  run("bash", ["-c", 'source deployment/lib/recovery-safety.sh; recovery_verify_checkpoint_directory "$1" "$2"',
    "cold-rebind-checkpoint", checkpoint, metadata.stamp], { cwd: root, env });
  const sums = fs.readFileSync(path.join(checkpoint, "SHA256SUMS"), "utf8");
  const pvc = JSON.parse(kubectl(["get", "pvc", "ret-pvc", "-n", values.Namespace, "-o", "json"]));
  if (metadata.schema_version !== 3 || metadata.provenance?.generator !== "yenhubs-local-coordinated-checkpoint-v3" ||
      metadata.provenance?.external_import !== false || metadata.kube_context !== context ||
      metadata.namespace !== values.Namespace || metadata.namespace_uid !== namespace.metadata.uid ||
      metadata.ret_pvc_uid !== pvc.metadata.uid || metadata.runtime_generation !== "legacy-absent" ||
      !Number.isFinite(Date.parse(metadata.writer_quiescence?.completed_at_utc))) {
    throw new Error("checkpoint_binding_invalid");
  }
  stage = "publication";
  const keyPath = path.join(directory, "cutover.key");
  if (!fs.existsSync(keyPath)) fs.writeFileSync(keyPath, crypto.randomBytes(32), { flag: "wx", mode: 0o600 });
  const key = readPrivateCutoverKey(keyPath);
  const attestation = {
    schemaVersion: 1, profileId: COLD_REBIND_CUTOVER_PROFILE, expectedKubeContext: context,
    namespace: values.Namespace, namespaceUid: namespace.metadata.uid, capturedAt: new Date().toISOString(),
    checkpointManifestSha256: digest(sums), targetManifestSha256: digest(targetBytes), baselineManifestSha256: digest(baselineBytes),
    baselineResourceSha256: coldRebindResourceDigest(live),
    botOrchestratorDeployment: { name: "bot-orchestrator", uid: parent.metadata.uid, resourceVersion: parent.metadata.resourceVersion }
  };
  attestation.hmacSha256 = crypto.createHmac("sha256", key).update(canonicalJson(attestation)).digest("hex");
  writeAtomicPrivateFile(path.join(directory, "cutover-attestation.json"), canonicalJson(attestation) + "\n");
  console.log(JSON.stringify({ status: "verified", profile: COLD_REBIND_CUTOVER_PROFILE, resources: live.items.length,
    credentials: "unchanged", checkpoint: "joint-and-rehashed", targetManifestSha256: attestation.targetManifestSha256 }));
} catch (error) {
  console.error(`${stage}: ${/^[a-z_]+$/.test(error.message) ? error.message : "cold_rebind_attestation_failed"}`);
  process.exitCode = 1;
}
}
