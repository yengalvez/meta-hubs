import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  canonicalJsonV1,
  createCheckpointAbortJournalSeal,
  createCheckpointBackupAuthorityV2,
  createKeyRecord,
  validateCheckpointAbortJournalSeal
} from "../../deployment/recovery-checkpoint-authority.mjs";

const cliPath = fileURLToPath(new URL("../../hubs-cloud/community-edition/apply/recover-avatar-checkpoint.js", import.meta.url));
const require = createRequire(cliPath);
const { ORDER, hash, normalizedSpec, privateFile } = require(cliPath);
const { leaseDocument } = require("./operation-lease");
const { createCutoverJournal, cutoverJournalConfigMap, sha256Canonical } = require("./cutover-journal");
const {
  BASE_NON_RESOURCE_URLS, BASE_RESOURCE_TUPLES, RUNNER_POD_TUPLES, effectiveRbacReviewSpecs
} = require("./effective-rbac");
const {
  RUNNER_NAMESPACE, RECOVERY_OPERATION_FENCE_POLICY_NAME: FENCE,
  CUTOVER_JOURNAL_POLICY_NAME, PARENT_FENCE_POLICY_NAME,
  readActivationPlan, recoveryOperationFenceNamespaceSelector
} = require("./runner-activation");
const YAML = require("yaml");
const ceDir = path.dirname(path.dirname(cliPath));
const generatorPath = path.join(ceDir, "generate_script/index.js");
const keyId = "44444444-4444-4444-8444-444444444444";
const otherKeyId = "66666666-6666-4666-8666-666666666666";
const resumeAnnotation = "yenhubs.org/checkpoint-resume-operation";
const clone = structuredClone;

// Contract under test (exact positional counts, no flags or environment selection):
//   plan-authority receiptPath packetPath existingKeyringPath keyId       [5]
//   execute-authority receiptPath packetPath expectedSha256 keyring keyId [6]
// Historical execute remains disabled before private reads/API access.
// Only the primary runs this RED suite. All fixtures are private, synthetic and
// retained; there is no network/DB, inherited credential, cleanup or real kubectl.
function writeFixture(file, value, mode = 0o600) {
  fs.writeFileSync(file, Buffer.isBuffer(value) || typeof value === "string" ? value : JSON.stringify(value), { mode });
  fs.chmodSync(file, mode);
}

const setupErrorCodes = new Set([
  "synthetic_receipt_capture_failed", "receipt_api_failed", "receipt_capture_profile",
  "receipt_capture_lease_stale", "receipt_capture_deployment_changed", "receipt_capture_fence_active",
  "authority_lock_bytes_missing", "authority_receipt_identity_changed", "authority_receipt_consumer_changed",
  "authority_receipt_fence_changed", "authority_namespace_changed", "authority_policy_changed",
  "receipt_lock_changed", "authority_key_selection_required", "authority_hmac",
  "authority_deployment_contract_schema", "private_file_permissions", "private_directory_permissions",
  "recovery_requires_bash_4_1_or_newer", "helper_contract_changed",
  "receipt_directory_exists", "receipt_parent_symlink", "authority_receipt_capture_profile",
  "unsupported_recovery_receipt", "receipt_identity_invalid", "receipt_inputs_invalid", "receipt_deployments_invalid",
  "authority_receipt_deployments_invalid", "authority_receipt_digest_invalid", "receipt_lease_invalid", "receipt_runtime_invalid",
  "private_path_not_absolute", "private_path_traversal", "private_path_symlink", "fence_identity_invalid",
  "backup_lock_contract", "wrong_incident_lock", "authority_lock_bytes_changed", "authority_inventory_binding_changed",
  "cluster_identity_changed", "lease_lineage_invalid", "lease_identity_changed", "foreign_lease_lineage",
  "checkpoint_backup_authority_string", "checkpoint_backup_authority_version", "checkpoint_backup_inventory_operation_fence",
  "checkpoint_backup_inventory_runtime", "checkpoint_backup_inventory_schema", "checkpoint_backup_inventory_namespace_binding",
  "checkpoint_backup_inventory_deployments", "checkpoint_backup_inventory_consumer_binding", "checkpoint_backup_inventory_bot_replicas",
  "canonical_json_depth", "canonical_json_number", "canonical_json_cycle", "canonical_json_type", "canonical_json_parse",
  "canonical_json_duplicate_key", "canonical_json_bytes", "canonical_json_limit", "canonical_json_utf8", "canonical_json_not_canonical",
  "authority_consumer_schema", "authority_fence_namespace_schema", "authority_legacy_fence", "authority_fence_schema",
  "authority_fence_policy_schema", "authority_fence_binding_schema", "authority_schema", "authority_namespace",
  "authority_hmac_schema", "authority_size", "authority_lock_binding", "authority_deployment_contracts", "authority_key",
  "authority_request_schema", "authority_key_id", "authority_consumer_contract_schema", "authority_consumer_contract_binding",
  "key_record_key_base64", "key_record_vector_input", "key_record_schema", "key_record_vector", "key_record_file",
  "key_record_file_changed", "key_record_path", "key_record_id", "keyring_directory", "keyring_inventory", "keyring_path"
]);
const captureSourceLocations = [
  ["recovery-cli", cliPath],
  ["authority-helper", fileURLToPath(new URL("../../deployment/recovery-checkpoint-authority.mjs", import.meta.url))],
  ["backup-formats", fileURLToPath(new URL("../../deployment/checkpoint-backup-formats.mjs", import.meta.url))],
  ["operation-lease", path.join(ceDir, "apply/operation-lease.js")],
  ["runner-activation", path.join(ceDir, "apply/runner-activation.js")]
].map(([component, file]) => ({ component, file, url: pathToFileURL(file).href }));

function closedCaptureDiagnostic(error, allowedCodes, locations) {
  let code = "synthetic_receipt_capture_failed", frames;
  try {
    if (allowedCodes.includes(error?.message)) code = error.message;
    if (!require("node:util").types.isNativeError(error)) return { code, frame: null };
    const stack = error.stack, prefix = `${Error.prototype.toString.call(error)}\n`;
    // A native message can itself contain newlines and frame-looking text.
    // Remove its COMPLETE exact name/message prefix before parsing any frame;
    // a non-native or ambiguous stack provides no frame evidence.
    if (typeof stack !== "string" || !stack.startsWith(prefix)) return { code, frame: null };
    frames = stack.slice(prefix.length).split("\n").slice(0, 32);
  } catch { return { code, frame: null }; }
  // Emit only a fixed component alias and bounded numeric line/column from the
  // first actual frame that exactly names one of the authorized modules.
  for (const frame of frames) {
    if (!/^\s+at /u.test(frame)) continue;
    for (const location of locations) for (const file of [location.file, location.url]) {
      const marker = `${file}:`, offset = frame.indexOf(marker);
      if (offset < 0 || !/[ (]$/u.test(frame.slice(0, offset))) continue;
      const position = /^([1-9][0-9]{0,8}):([1-9][0-9]{0,8})\)?$/u.exec(frame.slice(offset + marker.length));
      if (position) return { code, frame: { component: location.component, line: Number(position[1]), column: Number(position[2]) } };
    }
  }
  return { code, frame: null };
}

test("closed capture diagnostic excludes multiline message fake frames and preserves native evidence without API", () => {
  const forged = new Error(`unknown\n    at ${cliPath}:123:456`);
  const rejected = closedCaptureDiagnostic(forged, [...setupErrorCodes], captureSourceLocations);
  assert.equal(rejected.code, "synthetic_receipt_capture_failed");
  assert.equal(rejected.frame, null, "frame-looking unknown message text is not stack evidence");
  const ambiguous = new Error("unknown");
  ambiguous.stack = `Error: different\n    at ${cliPath}:123:456`;
  assert.equal(closedCaptureDiagnostic(ambiguous, [...setupErrorCodes], captureSourceLocations).frame, null);
  let genuine;
  // This production guard throws on the relative path before any fs/API read.
  try { privateFile("relative-diagnostic-probe"); } catch (error) { genuine = error; }
  assert.ok(genuine, "the pure path guard must provide native evidence");
  const preserved = closedCaptureDiagnostic(genuine, [...setupErrorCodes], captureSourceLocations);
  assert.equal(preserved.code, "private_path_not_absolute");
  assert.ok(preserved.frame?.component === "recovery-cli", "an authentic authorized frame must remain available");
  assert.ok([preserved.frame.line, preserved.frame.column].every(value => Number.isInteger(value) && value > 0));
});

function setupDiagnostic(stage, result) {
  const spawnCodes = new Set(["ENOENT", "EACCES", "ETIMEDOUT", "ENOBUFS", "E2BIG"]);
  if (spawnCodes.has(result.error?.code)) return `${stage}:${result.error.code}`;
  const stderr = String(result.stderr || "");
  for (const module of ["yaml", "pem-jwk"]) {
    if (stderr.includes(`Cannot find module '${module}'`)) return `${stage}:MODULE_NOT_FOUND:${module}`;
  }
  if (stderr.includes("MODULE_NOT_FOUND")) return `${stage}:MODULE_NOT_FOUND:other`;
  if (stage === "capture") {
    try {
      const diagnostic = JSON.parse(stderr);
      assert.deepEqual(Object.keys(diagnostic).sort(), ["code", "frame"]);
      assert.ok(setupErrorCodes.has(diagnostic.code));
      if (diagnostic.frame === null) return `${stage}:${diagnostic.code}`;
      assert.deepEqual(Object.keys(diagnostic.frame).sort(), ["column", "component", "line"]);
      assert.ok(captureSourceLocations.some(location => location.component === diagnostic.frame.component));
      assert.ok([diagnostic.frame.line, diagnostic.frame.column].every(value => Number.isInteger(value) && value >= 1 && value <= 999_999_999));
      return `${stage}:${diagnostic.code}:${diagnostic.frame.component}:${diagnostic.frame.line}:${diagnostic.frame.column}`;
    } catch { /* Unknown shapes and diagnostics never pass through. */ }
  }
  if (setupErrorCodes.has(stderr.trim())) return `${stage}:${stderr.trim()}`;
  return `${stage}:synthetic_child_failed`;
}

function custodyExecutableDirectories() {
  // validateHelper invokes bash; sourcing recovery-safety.sh invokes dirname,
  // and its exact Pod/NetworkPolicy custody predicates invoke jq. The library
  // itself rejects Bash <4.1. Select only those existing executable directories,
  // not the entire inherited PATH, and never create/install an executable.
  const search = (process.env.PATH || "").split(path.delimiter).filter(value => path.isAbsolute(value));
  return [...new Set(["bash", "dirname", "jq"].map(name => {
    const directory = search.find(value => {
      const executable = path.join(value, name);
      try { fs.accessSync(executable, fs.constants.X_OK); return fs.statSync(executable).isFile(); }
      catch { return false; }
    });
    assert.ok(directory, `fixture_runtime_executable_missing:${name}`);
    return directory;
  }))];
}

// Transport emulator only: no product verifier/coordinator code is copied here.
// Every command must have the synthetic context and select a JSON-owned object.
// Unknown verbs/resources fail closed instead of reaching another executable.
function kubectlStub() {
  const fs = require("node:fs");
  const assert = require("node:assert/strict");
  const { isDeepStrictEqual: equal } = require("node:util");
  const statePath = process.env.CHECKPOINT_CLI_FIXTURE_STATE;
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  let args = process.argv.slice(2);
  assert.equal(args[0], "--context");
  assert.equal(args[1], state.context);
  assert.equal(args[2], "--request-timeout=20s");
  args = args.slice(3);
  let namespace = "";
  if (args[0] === "-n") { namespace = args[1]; args = args.slice(2); }
  const [verb, kind, name] = args;
  state.calls.push({ args, namespace, callerPid: process.ppid });
  const persist = () => fs.writeFileSync(statePath, JSON.stringify(state), { mode: 0o600 });
  const finish = (document, status = 0, diagnostic = "") => {
    persist();
    // Pipes may write asynchronously. Exit only after both write callbacks,
    // while every caller returns immediately to preserve terminal control flow.
    const exit = () => process.exit(status);
    const writeDiagnostic = () => {
      if (diagnostic) process.stderr.write(diagnostic + "\n", exit);
      else exit();
    };
    if (document !== undefined) process.stdout.write(JSON.stringify(document), writeDiagnostic);
    else writeDiagnostic();
  };
  const aliases = {
    namespace: "Namespace", pvc: "PersistentVolumeClaim", cm: "ConfigMap",
    lease: "Lease", deployment: "Deployment", replicaset: "ReplicaSet", pod: "Pod", networkpolicy: "NetworkPolicy",
    secret: "Secret", serviceaccount: "ServiceAccount", role: "Role", rolebinding: "RoleBinding",
    resourcequota: "ResourceQuota", validatingadmissionpolicy: "ValidatingAdmissionPolicy",
    validatingadmissionpolicybinding: "ValidatingAdmissionPolicyBinding"
  };
  const find = (resourceKind, resourceName, ns = namespace) => state.resources.find(resource =>
    resource.kind === resourceKind && resource.metadata.name === resourceName &&
    (resource.metadata.namespace || "") === ns);
  const list = (apiVersion, resourceKind, ns) => ({
    apiVersion, kind: `${resourceKind}List`,
    // The emulator returns the full current namespaced snapshot, not a page.
    metadata: { resourceVersion: String(state.rv), continue: "", remainingItemCount: 0 },
    items: state.resources.filter(resource => resource.kind === resourceKind &&
      (resource.metadata.namespace || "") === ns)
  });
  const input = () => JSON.parse(fs.readFileSync(0, "utf8"));
  const committed = (label, resource) => {
    state.writes.push(label);
    if (state.failNext === label) {
      state.failNext = null;
      return finish(undefined, 1, "synthetic committed response lost");
    }
    return finish(resource);
  };
  try {
    if (verb === "get") {
      if (kind === "--raw") {
        assert.equal(name, `/api/v1/namespaces/${state.runnerNamespace}/pods`);
        return finish(list("v1", "Pod", state.runnerNamespace));
      }
      const listKinds = {
        pods: ["v1", "Pod"], deployments: ["apps/v1", "Deployment"], replicasets: ["apps/v1", "ReplicaSet"],
        roles: ["rbac.authorization.k8s.io/v1", "Role"], rolebindings: ["rbac.authorization.k8s.io/v1", "RoleBinding"],
        networkpolicies: ["networking.k8s.io/v1", "NetworkPolicy"]
      };
      if (listKinds[kind]) {
        assert.ok(namespace && !args.some(value => ["--all-namespaces", "-A", "--all-namespaces=true"].includes(value)),
          "unsupported synthetic List scope");
        return finish(list(...listKinds[kind], namespace));
      }
      assert.ok(aliases[kind], "unexpected synthetic resource kind");
      const resource = find(aliases[kind], name);
      if (!resource && args.includes("--ignore-not-found")) return finish();
      if (!resource) return finish(undefined, 1, "NotFound synthetic object");
      return finish(resource);
    }
    if (verb === "create" && kind === "--raw") {
      assert.equal(name, "/apis/authorization.k8s.io/v1/selfsubjectrulesreviews");
      const request = input(), username = args.find(value => value.startsWith("--as="))?.slice(5);
      const review = state.reviews.find(value => value.namespace === request.spec.namespace && value.username === username);
      assert.ok(review, "unexpected synthetic RBAC review");
      return finish(review.document);
    }
    if (["create", "replace"].includes(verb)) {
      const document = input();
      if (args.includes("--dry-run=server")) {
        if (document.kind === "Pod") {
          const binding = find("ValidatingAdmissionPolicyBinding", state.fenceName, "");
          const active = equal(binding.spec.matchResources.namespaceSelector, state.activeSelector);
          const message = document.metadata.namespace === state.runnerNamespace
            ? "denies runner Pod mutation" : "denies database-writer Pod creation";
          return finish(active ? undefined : document, active ? 1 : 0, active ? message : "");
        }
        assert.equal(verb, "replace");
        assert.equal(document.kind, "Deployment");
        return finish(document);
      }
      assert.equal(verb, "replace", "unexpected synthetic creation");
      assert.ok(["Lease", "ValidatingAdmissionPolicyBinding"].includes(document.kind));
      const current = find(document.kind, document.metadata.name, document.metadata.namespace || "");
      assert.ok(current);
      assert.equal(document.metadata.resourceVersion, current.metadata.resourceVersion, "Conflict");
      if (document.metadata.uid) assert.equal(document.metadata.uid, current.metadata.uid, "Conflict");
      const holder = current.spec.holderIdentity;
      current.spec = document.spec;
      current.metadata.resourceVersion = String(++state.rv);
      const label = document.kind === "Lease"
        ? !document.spec.holderIdentity ? "lease:release" : holder !== document.spec.holderIdentity ? "lease:acquire" : "lease:renew"
        : "fence";
      return committed(label, current);
    }
    if (verb === "patch") {
      assert.equal(kind, "deployment");
      assert.ok(args.includes("--type=json") && args.includes("--patch-file=/dev/stdin"));
      const current = find("Deployment", name), previous = JSON.stringify({ spec: current.spec, annotations: current.metadata.annotations });
      for (const operation of input()) {
        const parts = operation.path.slice(1).split("/").map(value => value.replace(/~1/g, "/").replace(/~0/g, "~"));
        let object = current;
        for (const part of parts.slice(0, -1)) object = object[part];
        const key = parts.at(-1);
        if (operation.op === "test") assert.deepEqual(object[key], operation.value, "Conflict");
        else if (operation.op === "remove") { assert.ok(Object.hasOwn(object, key)); delete object[key]; }
        else { assert.ok(["add", "replace"].includes(operation.op)); object[key] = operation.value; }
      }
      if (previous !== JSON.stringify({ spec: current.spec, annotations: current.metadata.annotations })) current.metadata.generation++;
      current.metadata.resourceVersion = String(++state.rv);
      current.status = { observedGeneration: current.metadata.generation, readyReplicas: current.spec.replicas,
        availableReplicas: current.spec.replicas, updatedReplicas: current.spec.replicas };
      return committed(`${current.metadata.annotations?.[state.resumeAnnotation] ? "resume" : "clear"}:${name}`, current);
    }
    if (verb === "delete") {
      assert.equal(kind, `--raw=/api/v1/namespaces/${state.namespace}/configmaps/yenhubs-recovery-operation-lock`);
      const document = input(), current = find("ConfigMap", "yenhubs-recovery-operation-lock", state.namespace);
      assert.equal(document.preconditions.uid, current.metadata.uid, "Conflict");
      assert.equal(document.preconditions.resourceVersion, current.metadata.resourceVersion, "Conflict");
      state.resources.splice(state.resources.indexOf(current), 1);
      return committed("lock:delete", { status: "Success" });
    }
    throw new Error("unexpected synthetic API command");
  } catch (_) { return finish(undefined, 1, "synthetic transport contract failed closed"); }
}

function transportFixture(t) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "checkpoint-authority-recovery-cli-"));
  fs.chmodSync(dir, 0o700);
  t.diagnostic(`Retained synthetic fixture: ${dir}`);
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin, { mode: 0o700 });
  assert.doesNotMatch(process.execPath, /\s/, "stub shebang requires an unambiguous Node path");
  writeFixture(path.join(bin, "kubectl"), `#!${process.execPath}\n(${kubectlStub.toString()})();\n`, 0o700);
  const statePath = path.join(dir, "state.json");
  writeFixture(statePath, { context: "synthetic-authority-cli-only", calls: [], writes: [], resources: [], rv: 100 });
  const env = { PATH: [...new Set([bin, path.dirname(process.execPath), ...custodyExecutableDirectories()])].join(path.delimiter), HOME: dir, TMPDIR: dir,
    LANG: "C", TZ: "UTC", CHECKPOINT_CLI_FIXTURE_STATE: statePath };
  // yaml and pem-jwk are existing generator dependencies. Inherit only the
  // explicitly supplied module search path, never the parent's credentials or
  // full environment. There is no module-path creation or alternative fallback.
  if (process.env.NODE_PATH !== undefined) env.NODE_PATH = process.env.NODE_PATH;
  return { dir, statePath, env, state: () => JSON.parse(privateFile(statePath)),
    update(mutator) { const state = this.state(); mutator(state); writeFixture(statePath, state); } };
}

function runNode(f, args, extraEnv = {}) {
  const before = f.state().calls.length;
  const result = spawnSync(process.execPath, args, { cwd: ceDir, env: { ...f.env, ...extraEnv },
    encoding: "utf8", timeout: 90_000, maxBuffer: 1024 * 1024 });
  assert.ok(result.error === undefined, setupDiagnostic("subprocess", result));
  assert.ok(result.signal === null, setupDiagnostic("subprocess", result));
  return { ...result, callerPids: [...new Set(f.state().calls.slice(before).map(call => call.callerPid))] };
}
function runCli(f, argv, extraEnv) { return runNode(f, [cliPath, ...argv], extraEnv); }
function assertClosed(result) {
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /^[a-z0-9_:-]+\n$/i, "CLI diagnostics must stay redacted");
  assert.equal(result.stdout, "");
}
function selections(f) { return [f.keyringPath, keyId]; }
function planArgs(f) { return ["plan-authority", f.receiptPath, f.packetPath, ...selections(f)]; }
function executeArgs(f, sha) { return ["execute-authority", f.receiptPath, f.packetPath, sha, ...selections(f)]; }
function resource(f, kind, name, namespace = "") {
  return f.state().resources.find(value => value.kind === kind && value.metadata.name === name &&
    (value.metadata.namespace || "") === namespace);
}

function runSyntheticTransport(f, args, document) {
  const result = spawnSync(path.join(f.dir, "bin/kubectl"), [
    "--context", "synthetic-authority-cli-only", "--request-timeout=20s", ...args
  ], { env: f.env, input: document === undefined ? undefined : JSON.stringify(document),
    encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024 });
  assert.ok(result.error === undefined, setupDiagnostic("transport", result));
  assert.equal(result.signal, null, "synthetic transport must terminate with its real status");
  return result;
}

test("synthetic transport flushes large JSON completely before successful exit", t => {
  const f = transportFixture(t);
  const policy = { apiVersion: "admissionregistration.k8s.io/v1", kind: "ValidatingAdmissionPolicy",
    metadata: { name: "synthetic-large-policy" }, spec: { syntheticPayload: "á".repeat(65_536) } };
  f.update(state => { state.resources.push(policy); });
  const expected = JSON.stringify(policy), expectedBytes = Buffer.byteLength(expected, "utf8");
  assert.ok(expectedBytes > 64 * 1024, "response must exceed the previously truncated pipe write");
  const result = runSyntheticTransport(f, ["get", "validatingadmissionpolicy", policy.metadata.name, "-o", "json"]);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.equal(Buffer.byteLength(result.stdout, "utf8"), expectedBytes);
  assert.equal(result.stdout, expected);
  assert.deepEqual(JSON.parse(result.stdout), policy);
  assert.equal(f.state().calls.length, 1, "successful finish must not fall through to another branch");
  assert.deepEqual(f.state().writes, []);
});

test("synthetic transport preserves rejected and committed-response-lost exits", t => {
  const f = transportFixture(t);
  const rejected = runSyntheticTransport(f, ["get", "validatingadmissionpolicy", "missing", "-o", "json"]);
  assert.equal(rejected.status, 1);
  assert.equal(rejected.stdout, "");
  assert.equal(rejected.stderr, "NotFound synthetic object\n");
  assert.deepEqual(f.state().writes, []);
  const unsupported = runSyntheticTransport(f, ["unsupported-synthetic-verb"]);
  assert.equal(unsupported.status, 1);
  assert.equal(unsupported.stdout, "");
  assert.equal(unsupported.stderr, "synthetic transport contract failed closed\n");
  assert.deepEqual(f.state().writes, []);
  const lease = { apiVersion: "coordination.k8s.io/v1", kind: "Lease",
    metadata: { name: "synthetic-lease", namespace: "synthetic-parent", uid: "synthetic-uid", resourceVersion: "100" },
    spec: { holderIdentity: "synthetic-before" } };
  f.update(state => { state.resources.push(lease); state.failNext = "lease:acquire"; });
  const replacement = clone(lease); replacement.spec.holderIdentity = "synthetic-after";
  const lost = runSyntheticTransport(f, ["-n", lease.metadata.namespace, "replace", "-f", "-", "-o", "json"], replacement);
  assert.equal(lost.status, 1);
  assert.equal(lost.stdout, "", "a committed response loss must not fall through to the success response");
  assert.equal(lost.stderr, "synthetic committed response lost\n");
  assert.deepEqual(f.state().writes, ["lease:acquire"]);
  assert.equal(f.state().failNext, null);
  const committed = resource(f, "Lease", lease.metadata.name, lease.metadata.namespace);
  assert.equal(committed.spec.holderIdentity, replacement.spec.holderIdentity);
  assert.equal(committed.metadata.resourceVersion, "101");
  assert.equal(f.state().calls.length, 3);
});

test("synthetic transport returns complete typed Lists bound to namespaced state and current revision", t => {
  const f = transportFixture(t), parentNamespace = "synthetic-parent", runnerNamespace = "synthetic-runners";
  const cases = [
    ["pods", "v1", "Pod"], ["deployments", "apps/v1", "Deployment"], ["replicasets", "apps/v1", "ReplicaSet"],
    ["roles", "rbac.authorization.k8s.io/v1", "Role"], ["rolebindings", "rbac.authorization.k8s.io/v1", "RoleBinding"],
    ["networkpolicies", "networking.k8s.io/v1", "NetworkPolicy"]
  ];
  const parentResources = cases.map(([, apiVersion, kind]) => ({ apiVersion, kind,
    metadata: { name: `synthetic-${kind.toLowerCase()}`, namespace: parentNamespace } }));
  const runnerPod = { apiVersion: "v1", kind: "Pod", metadata: { name: "synthetic-runner-pod", namespace: runnerNamespace } };
  const foreignPod = { apiVersion: "v1", kind: "Pod", metadata: { name: "synthetic-foreign-pod", namespace: "synthetic-other" } };
  const lease = { apiVersion: "coordination.k8s.io/v1", kind: "Lease",
    metadata: { name: "synthetic-list-lease", namespace: parentNamespace, uid: "synthetic-list-uid", resourceVersion: "100" },
    spec: { holderIdentity: "synthetic-before" } };
  f.update(state => { state.runnerNamespace = runnerNamespace; state.resources = [...parentResources, runnerPod, foreignPod, lease]; });
  const readList = args => {
    const result = runSyntheticTransport(f, args);
    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    return JSON.parse(result.stdout);
  };
  const expectedMetadata = () => ({ resourceVersion: String(f.state().rv), continue: "", remainingItemCount: 0 });
  for (const [index, [plural, apiVersion, kind]] of cases.entries()) {
    const listed = readList(["-n", parentNamespace, "get", plural, "-o", "json"]);
    assert.deepEqual(listed, { apiVersion, kind: `${kind}List`, metadata: expectedMetadata(), items: [parentResources[index]] });
  }
  const rawArgs = ["get", "--raw", `/api/v1/namespaces/${runnerNamespace}/pods`];
  const before = readList(rawArgs);
  assert.deepEqual(before, { apiVersion: "v1", kind: "PodList", metadata: expectedMetadata(), items: [runnerPod] });
  const replacement = clone(lease); replacement.spec.holderIdentity = "synthetic-after";
  const changed = runSyntheticTransport(f, ["-n", parentNamespace, "replace", "-f", "-", "-o", "json"], replacement);
  assert.equal(changed.status, 0);
  assert.equal(changed.stderr, "");
  const after = readList(rawArgs);
  assert.notEqual(after.metadata.resourceVersion, before.metadata.resourceVersion);
  assert.deepEqual(after, { apiVersion: "v1", kind: "PodList", metadata: expectedMetadata(), items: [runnerPod] });
  assert.deepEqual(f.state().writes, ["lease:acquire"]);
});

for (const [scope, queries] of [
  ["all-namespace", [
    ["get", "pods", "--all-namespaces", "-o", "json"],
    ["-n", "synthetic-parent", "get", "pods", "--all-namespaces", "-o", "json"],
    ["-n", "synthetic-parent", "get", "pods", "-A", "-o", "json"],
    ["-n", "synthetic-parent", "get", "pods", "--all-namespaces=true", "-o", "json"]
  ]],
  ["missing-namespace", [["get", "pods", "-o", "json"]]]
]) {
  test(`synthetic transport rejects ${scope} Lists without fabricated empty absence`, t => {
    const f = transportFixture(t);
    const pods = [
      { apiVersion: "v1", kind: "Pod", metadata: { name: "synthetic-pod", namespace: "synthetic-parent" } },
      { apiVersion: "v1", kind: "Pod", metadata: { name: "synthetic-runner-pod", namespace: "synthetic-runners" } },
      { apiVersion: "v1", kind: "Pod", metadata: { name: "synthetic-foreign-pod", namespace: "synthetic-other" } }
    ];
    f.update(state => { state.runnerNamespace = "synthetic-runners"; state.resources = clone(pods); });
    for (const args of queries) {
      const calls = f.state().calls.length;
      const result = runSyntheticTransport(f, args);
      assert.deepEqual(f.state().writes, []);
      assert.deepEqual(f.state().resources, pods, "unsupported scope cannot change namespaced evidence");
      assert.equal(f.state().calls.length, calls + 1);
      assert.equal(result.status, 1, "unsupported List scope must fail closed instead of claiming complete absence");
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, "synthetic transport contract failed closed\n");
    }
  });
}

async function authorityFixture(t) {
  const f = transportFixture(t);
  f.keyringPath = path.join(f.dir, "keyring");
  fs.mkdirSync(f.keyringPath, { mode: 0o700 });
  writeFixture(path.join(f.keyringPath, `${keyId}.json`), canonicalJsonV1(createKeyRecord({ keyId, keyBytes: Buffer.alloc(32, 42) })));
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
  const values = { ...YAML.parse(fs.readFileSync(path.join(ceDir, "input-values.ci.yaml"), "utf8")), PERMS_KEY: privateKey };
  const sources = Object.fromEntries(["values", "manifest", "inventory", "key"].map(name => [name, path.join(f.dir, `${name}.private`)]));
  writeFixture(sources.values, YAML.stringify(values));
  const generated = runNode(f, [generatorPath], { HCCE_INPUT_VALUES_PATH: sources.values, HCCE_OUTPUT_PATH: sources.manifest });
  assert.equal(generated.status, 0, setupDiagnostic("generator", generated));
  const plan = readActivationPlan(sources.manifest);
  assert.equal(plan.activationPhase, "active");
  assert.equal(plan.recoveryPhase, "active");
  f.namespace = values.Namespace;
  const resources = clone(plan.resources).map((value, index) => {
    value.metadata.uid = `synthetic-${value.kind}-${value.metadata.name}`;
    value.metadata.resourceVersion = `initial-${index}`;
    value.metadata.generation = 7;
    if (value.kind === "Namespace") {
      value.metadata.labels = { ...value.metadata.labels, "kubernetes.io/metadata.name": value.metadata.name };
      value.spec = { finalizers: ["kubernetes"] }; value.status = { phase: "Active" };
    }
    if (value.kind === "ValidatingAdmissionPolicy") value.status = { observedGeneration: 7, typeChecking: { expressionWarnings: [] } };
    if (value.kind === "Deployment") {
      if (value.metadata.name === "bot-orchestrator") value.spec.replicas = 0;
      value.status = { observedGeneration: 7, readyReplicas: value.spec.replicas,
        availableReplicas: value.spec.replicas, updatedReplicas: value.spec.replicas };
    }
    return value;
  });
  const find = (kind, name, namespace = "") => {
    const matches = resources.filter(value => value.kind === kind && value.metadata.name === name &&
      (value.metadata.namespace || "") === namespace);
    assert.ok(matches.length === 1, "fixture_resource_identity_not_unique");
    return matches[0];
  };
  const parent = find("Namespace", f.namespace), runner = find("Namespace", RUNNER_NAMESPACE);
  const pvc = find("PersistentVolumeClaim", "ret-pvc", f.namespace);
  pvc.status = { phase: "Bound" };
  const policy = find("ValidatingAdmissionPolicy", FENCE), binding = find("ValidatingAdmissionPolicyBinding", FENCE);
  const activeSpec = clone(binding.spec);
  activeSpec.matchResources.namespaceSelector = recoveryOperationFenceNamespaceSelector(f.namespace, { active: true });
  const initial = ORDER.map(name => clone(find("Deployment", name, f.namespace)));
  assert.ok(initial.some(value => value.spec.replicas > 0));
  const incident = { context: f.state().context,
    namespace: parent.metadata.name, namespaceUid: parent.metadata.uid, pvcUid: pvc.metadata.uid,
    lockUid: "synthetic-lock-uid", lockRv: "lock-rv", operation: "1".repeat(32), stamp: "20261003-120000" };
  const consumers = initial.map(value => ({ name: value.metadata.name, uid: value.metadata.uid,
    initial_resource_version: value.metadata.resourceVersion, initial_generation: value.metadata.generation,
    original_replicas: value.spec.replicas, selector: value.metadata.name })).sort((a, b) => a.name.localeCompare(b.name));
  const publicAuthority = { schema_version: 2, operation_id: incident.operation,
    namespace: { name: parent.metadata.name, uid: incident.namespaceUid }, pvc: { name: pvc.metadata.name, uid: incident.pvcUid },
    hmac_profile: "yenhubs-checkpoint-backup-authority-hmac-v2", hmac_key_id: keyId, runner_generation: "durable-v2",
    operation_fence: { state: "dormant", namespaces: Object.fromEntries([["parent", parent], ["runner", runner]].map(([role, value]) =>
      [role, { name: value.metadata.name, uid: value.metadata.uid, initial_resource_version: value.metadata.resourceVersion,
        phase: "Active", metadata_name_label: value.metadata.name }])),
    policy: { uid: policy.metadata.uid, initial_resource_version: policy.metadata.resourceVersion, initial_generation: 7,
      spec_sha256: hash(canonicalJsonV1(policy.spec)) },
    binding: { uid: binding.metadata.uid, initial_resource_version: binding.metadata.resourceVersion,
      dormant_spec_sha256: hash(canonicalJsonV1(binding.spec)), active_spec_sha256: hash(canonicalJsonV1(activeSpec)) } }, consumers };
  const lockBinding = { name: "yenhubs-recovery-operation-lock", namespace: f.namespace, owner: "checkpoint-backup",
    operation_id: incident.operation, recovery_token: "a".repeat(32), namespace_uid: incident.namespaceUid,
    pvc_uid: incident.pvcUid, checkpoint_stamp: incident.stamp, dump_sha256: "0".repeat(64), storage_sha256: "0".repeat(64) };
  const authority = createCheckpointBackupAuthorityV2({ keyringPath: f.keyringPath, keyId, lockBinding, publicAuthority,
    deploymentContracts: [...initial].sort((a, b) => a.metadata.name.localeCompare(b.metadata.name)).map(value => ({ api_version: "apps/v1", kind: "Deployment", namespace: f.namespace,
      name: value.metadata.name, uid: value.metadata.uid, spec_without_replicas: normalizedSpec(value) })) });
  const canonical = canonicalJsonV1(authority);
  const lock = { apiVersion: "v1", kind: "ConfigMap", immutable: true,
    metadata: { name: lockBinding.name, namespace: f.namespace, uid: incident.lockUid, resourceVersion: incident.lockRv,
      labels: { "yenhubs.org/recovery-owner": "checkpoint-backup" }, annotations: Object.fromEntries([
        ["operation-id", incident.operation], ["recovery-token", lockBinding.recovery_token], ["namespace-uid", incident.namespaceUid],
        ["pvc-uid", incident.pvcUid], ["checkpoint-stamp", incident.stamp], ["dump-sha256", lockBinding.dump_sha256],
        ["storage-sha256", lockBinding.storage_sha256]].map(([name, value]) => [`yenhubs.org/${name}`, value])) },
    data: { "checkpoint-backup-authority.json": canonical } };
  const lease = leaseDocument({ namespace: f.namespace, holder: "root-recovery:11111111-1111-4111-8111-111111111111", now: Date.now() });
  Object.assign(lease.metadata, { uid: "synthetic-lease-uid", resourceVersion: "lease-rv" });
  const target = (kind, name) => plan.resources.find(value => value.kind === kind && value.metadata.name === name);
  const cutover = cutoverJournalConfigMap(createCutoverJournal({ mode: "clean-install",
    operationId: "12345678-1234-4234-8234-123456789abc", authorization: null, expectedKubeContext: incident.context,
    namespace: f.namespace, namespaceUid: incident.namespaceUid, baselineDeployment: null,
    manifestSha256: hash(privateFile(sources.manifest)), targetHashes: {
      journalPolicy: sha256Canonical(target("ValidatingAdmissionPolicy", CUTOVER_JOURNAL_POLICY_NAME)),
      journalBinding: sha256Canonical(target("ValidatingAdmissionPolicyBinding", CUTOVER_JOURNAL_POLICY_NAME)),
      parentPolicy: sha256Canonical(target("ValidatingAdmissionPolicy", PARENT_FENCE_POLICY_NAME)),
      parentBinding: sha256Canonical(target("ValidatingAdmissionPolicyBinding", PARENT_FENCE_POLICY_NAME)),
      parentDeployment: sha256Canonical(target("Deployment", "bot-orchestrator")) }, issuedAt: new Date().toISOString()
  }, Buffer.alloc(32, 9)));
  Object.assign(cutover.metadata, { uid: "synthetic-cutover-uid", resourceVersion: "cutover-rv" });
  resources.push(lock, lease, cutover);
  assert.ok(new Set(resources.map(value => JSON.stringify([value.apiVersion, value.kind,
    value.metadata.namespace || "", value.metadata.name]))).size === resources.length, "fixture_transport_identity_not_unique");
  const reviews = effectiveRbacReviewSpecs(f.namespace, true).map(spec => ({ ...spec, document: {
    apiVersion: "authorization.k8s.io/v1", kind: "SelfSubjectRulesReview", status: { incomplete: false,
      resourceRules: [...BASE_RESOURCE_TUPLES, ...(spec.runnerPodAuthority ? RUNNER_POD_TUPLES : [])].map(([group, resource, verb]) =>
        ({ apiGroups: [group], resources: [resource], verbs: [verb] })),
      nonResourceRules: [{ nonResourceURLs: BASE_NON_RESOURCE_URLS, verbs: ["get"] }] } } }));
  f.update(state => Object.assign(state, { resources, reviews, namespace: f.namespace, runnerNamespace: RUNNER_NAMESPACE,
    fenceName: FENCE, activeSelector: activeSpec.matchResources.namespaceSelector, resumeAnnotation }));
  const identity = value => ({ api_version: value.apiVersion, kind: value.kind, name: value.metadata.name,
    uid: value.metadata.uid, resource_version: value.metadata.resourceVersion });
  writeFixture(sources.inventory, { schema_version: 5, namespace: f.namespace, namespace_uid: incident.namespaceUid,
    backup_authority: canonical, deployments: initial.map(value => ({ name: value.metadata.name, uid: value.metadata.uid,
      replicas: value.spec.replicas, containers: value.spec.template.spec.containers.map(({ name, image }) => ({ name, image })).sort((a, b) => a.name.localeCompare(b.name)),
      init_containers: (value.spec.template.spec.initContainers || []).map(({ name, image }) => ({ name, image })) })),
    bot_runner_runtime: { mode: "kubernetes-pod", generation: "durable-v2", image: values.OVERRIDE_BOT_RUNNER_IMAGE,
      recovery_epoch: { state: "bound", value: values.BOT_RUNNER_RECOVERY_EPOCH }, control_plane: { state: "kubernetes-active",
        namespaces: [parent, runner].map(identity), namespaced_resources: [], cluster_resources: [policy, binding].map(identity) } } });
  writeFixture(sources.key, Buffer.alloc(32, 9));
  const receiptDirectory = path.join(f.dir, "receipt");
  const captureRequest = path.join(f.dir, "capture-request.json");
  writeFixture(captureRequest, [receiptDirectory, incident, { schema_version: 3, operation_id: incident.operation,
    authority_sha256: hash(canonical), consumers }, sources, { keyringPath: f.keyringPath, keyId }]);
  // Real capture, no authority callback and no test adapters. Only PATH transport
  // is replaced; the child loads the actual producer and fixed HMAC helper.
  const captured = runNode(f, ["-e", `const fs=require('node:fs');const m=require(process.argv[1]);
    m.captureAuthorityReceipt(...JSON.parse(fs.readFileSync(process.argv[2],'utf8')))
      .then(()=>process.stdout.write('captured\\n')).catch(e=>{const diagnostic=(${closedCaptureDiagnostic.toString()})(
        e,${JSON.stringify([...setupErrorCodes])},${JSON.stringify(captureSourceLocations)});
        process.stderr.write(JSON.stringify(diagnostic)+'\\n');process.exitCode=1;});`, cliPath, captureRequest]);
  assert.equal(captured.status, 0, setupDiagnostic("capture", captured));
  assert.equal(captured.stdout, "captured\n");
  f.receiptPath = path.join(receiptDirectory, "receipt.json");
  f.receipt = JSON.parse(privateFile(f.receiptPath));
  assert.equal(f.receipt.schema, 2);
  assert.deepEqual(f.state().writes, []);
  f.initial = initial;
  f.packetPath = path.join(f.dir, "packet.json");
  f.update(state => {
    const active = state.resources.find(value => value.kind === "ValidatingAdmissionPolicyBinding" && value.metadata.name === FENCE);
    active.spec = activeSpec; active.metadata.resourceVersion = "paused-binding-rv";
    for (const name of ORDER) {
      const value = state.resources.find(value => value.kind === "Deployment" && value.metadata.name === name);
      if (value.spec.replicas > 0) { value.spec.replicas = 0; value.metadata.generation++; value.metadata.resourceVersion = `paused-${name}`; }
      value.status = { observedGeneration: value.metadata.generation, readyReplicas: 0, availableReplicas: 0, updatedReplicas: 0 };
    }
    state.calls = [];
  });
  return f;
}

function verifiedPlan(f) {
  const result = runCli(f, planArgs(f));
  assert.equal(result.status, 0, result.stderr); // RED today: manual_execute_disabled_plan_only.
  assert.equal(result.stderr, "");
  const output = JSON.parse(result.stdout);
  const packet = JSON.parse(privateFile(f.packetPath));
  assert.equal(output.plan, "verified");
  assert.equal(output.packetSha256, hash(privateFile(f.packetPath)));
  assert.equal(packet.schema, 3, "legacy packet2 is not an authority CLI success");
  assert.equal(packet.authoritySha256, f.receipt.backup_authority.sha256);
  assert.equal(packet.receiptHash, hash(JSON.stringify(f.receipt)));
  assert.deepEqual(f.state().writes, [], "plan may dry-run but must not mutate the synthetic API");
  assert.equal(result.callerPids.length, 1);
  return { sha: output.packetSha256, packet, result };
}
function expireSyntheticLease(f) {
  f.update(state => {
    const lease = state.resources.find(value => value.kind === "Lease");
    lease.spec.renewTime = new Date(Date.now() - 121_000).toISOString().replace(/(\.\d{3})Z$/, "$1000Z");
  });
}
function verifyJournal(f) {
  const journal = JSON.parse(privateFile(`${f.packetPath}.journal.json`));
  const unsigned = clone(journal); delete unsigned.authentication;
  assert.equal(journal.schema, 3);
  assert.equal(journal.authoritySha256, f.receipt.backup_authority.sha256);
  validateCheckpointAbortJournalSeal({ keyringPath: f.keyringPath, keyId,
    receiptSha256: hash(canonicalJsonV1(f.receipt)), journal: unsigned, seal: journal.authentication });
  return journal;
}

test("plan-authority uses receipt2, real offline manifest checks and packet3 from the real CLI", async t => {
  const f = await authorityFixture(t);
  const { packet } = verifiedPlan(f);
  assert.equal(fs.existsSync(`${f.packetPath}.journal.json`), false);
  assert.deepEqual(packet.deployments.map(value => value.name), ORDER);
  for (const value of packet.deployments) {
    const original = f.initial.find(initial => initial.metadata.name === value.name);
    assert.equal(value.generation, original.metadata.generation + (original.spec.replicas > 0 ? 1 : 0));
    assert.equal(value.replicas, original.spec.replicas);
  }
});

test("execute-authority reenters in a fresh real CLI process after a committed response is lost", async t => {
  const f = await authorityFixture(t), { sha, result: planned } = verifiedPlan(f);
  expireSyntheticLease(f);
  f.update(state => { state.failNext = "resume:pgbouncer"; });
  const interrupted = runCli(f, executeArgs(f, sha));
  assert.equal(interrupted.status, 1, interrupted.stderr);
  assert.match(interrupted.stderr, /api_failed:-n/);
  assert.ok(resource(f, "ConfigMap", "yenhubs-recovery-operation-lock", f.namespace));
  assert.equal(verifyJournal(f).steps["resume:pgbouncer"].state, "intent");
  assert.equal(f.state().writes.filter(value => value === "resume:pgbouncer").length, 1);
  assert.equal(f.state().failNext, null, "the intended committed-response cut must actually have occurred");
  expireSyntheticLease(f);
  const resumed = runCli(f, executeArgs(f, sha));
  assert.equal(resumed.status, 0, resumed.stderr); // RED until the authority CLI entrypoint exists.
  assert.equal(resumed.stderr, "");
  const journal = verifyJournal(f);
  assert.equal(journal.stage, "recovered-abort-only");
  assert.equal(journal.planHash, sha);
  assert.equal(resource(f, "ConfigMap", "yenhubs-recovery-operation-lock", f.namespace), undefined);
  for (const original of f.initial) {
    const name = original.metadata.name, live = resource(f, "Deployment", name, f.namespace), positive = original.spec.replicas > 0;
    assert.equal(live.spec.replicas, original.spec.replicas);
    assert.deepEqual(normalizedSpec(live), normalizedSpec(original));
    assert.equal(live.metadata.generation, original.metadata.generation + (positive ? 3 : 0));
    assert.equal(live.metadata.annotations?.[resumeAnnotation], undefined);
    for (const action of ["resume", "clear"]) assert.equal(f.state().writes.filter(value => value === `${action}:${name}`).length, positive ? 1 : 0);
    if (!positive) assert.equal(live.metadata.resourceVersion, original.metadata.resourceVersion);
  }
  const beforeReplay = clone(f.state().writes), replayed = runCli(f, executeArgs(f, sha));
  assert.equal(replayed.status, 0, replayed.stderr);
  assert.deepEqual(f.state().writes, beforeReplay, "a terminal replay cannot repeat any API mutation");
  verifyJournal(f);
  assert.deepEqual([planned, interrupted, resumed, replayed].map(value => value.callerPids.length), [1, 1, 1, 1]);
  assert.equal(new Set([planned, interrupted, resumed, replayed].flatMap(value => value.callerPids)).size, 4,
    "planning, interrupted execution, recovery and terminal replay must be distinct CLI processes");
});

test("CLI modes reject flags and non-exact counts before private reads or API calls; historical execute stays disabled", t => {
  const f = transportFixture(t), missing = path.join(f.dir, "not-readable"), packet = path.join(f.dir, "packet.json"), sha = "0".repeat(64);
  const plan = ["plan-authority", missing, packet, f.dir, keyId];
  const execute = ["execute-authority", missing, packet, sha, f.dir, keyId];
  for (const argv of [
    [], ["--plan-authority", missing, packet, f.dir, keyId], ["--execute-authority", missing, packet, sha, f.dir, keyId],
    ...[plan, execute].flatMap(argv => Array.from({ length: argv.length - 1 }, (_, index) => argv.slice(0, index + 1))),
    [...plan, "extra"], [...execute, "extra"],
    ["plan-authority", "--receipt", packet, f.dir, keyId],
    ["execute-authority", "--receipt", packet, sha, f.dir, keyId]
  ]) {
    const result = runCli(f, argv); assertClosed(result);
    assert.doesNotMatch(result.stderr, /ENOENT|private_path|recovery_failed_redacted/, "syntax must fail before reading private paths");
  }
  for (const argv of [
    ["execute", missing, packet, sha],
    ["execute", missing, packet, sha, f.dir, keyId]
  ]) {
    const historic = runCli(f, argv);
    assertClosed(historic); assert.equal(historic.stderr, "manual_execute_disabled_plan_only\n");
    assert.deepEqual(f.state().calls, []);
    assert.deepEqual(f.state().writes, []);
    assert.equal(fs.existsSync(packet), false);
  }
});

test("authority CLI requires explicit existing keyring/ID and cannot use environment/create/import fallback", async t => {
  const f = await authorityFixture(t), before = fs.readFileSync(path.join(f.keyringPath, `${keyId}.json`));
  const missing = path.join(f.dir, "missing-keyring"), empty = path.join(f.dir, "empty-keyring");
  fs.mkdirSync(empty, { mode: 0o700 });
  const environment = { RECOVERY_BACKUP_AUTHORITY_KEYRING: f.keyringPath, RECOVERY_BACKUP_AUTHORITY_KEY_ID: keyId };
  for (const selected of [[], [f.keyringPath], [missing, keyId], [empty, keyId], [f.keyringPath, otherKeyId],
    ["relative-keyring", keyId], [f.keyringPath, "--create"], [f.keyringPath, keyId, "--import"]]) {
    const result = runCli(f, ["plan-authority", f.receiptPath, f.packetPath, ...selected], environment);
    assertClosed(result);
    assert.deepEqual(f.state().writes, []);
    assert.equal(fs.existsSync(f.packetPath), false);
  }
  assert.equal(fs.existsSync(missing), false);
  assert.deepEqual(fs.readdirSync(empty), []);
  assert.deepEqual(fs.readdirSync(f.keyringPath), [`${keyId}.json`]);
  assert.deepEqual(fs.readFileSync(path.join(f.keyringPath, `${keyId}.json`)), before);
});

test("authority modes reject receipt1 before API access instead of falling back to the legacy coordinator", async t => {
  const f = await authorityFixture(t), receipt1 = clone(f.receipt);
  receipt1.schema = 1; delete receipt1.backup_authority;
  for (const deployment of receipt1.deployments) delete deployment.generation;
  const receipt1Path = path.join(f.dir, "receipt1.json"); writeFixture(receipt1Path, receipt1);
  for (const argv of [
    ["plan-authority", receipt1Path, f.packetPath, ...selections(f)],
    ["execute-authority", receipt1Path, f.packetPath, "0".repeat(64), ...selections(f)]
  ]) {
    const rejected = runCli(f, argv);
    assertClosed(rejected);
    assert.equal(rejected.stderr, "unsupported_recovery_receipt\n");
    assert.deepEqual(f.state().calls, []);
    assert.deepEqual(f.state().writes, []);
    assert.equal(fs.existsSync(f.packetPath), false);
  }
});

test("execute-authority rejects a wrong operator packet hash before journal publication or API mutation", async t => {
  const f = await authorityFixture(t), { sha } = verifiedPlan(f), packetBefore = privateFile(f.packetPath);
  const result = runCli(f, executeArgs(f, sha === "0".repeat(64) ? "f".repeat(64) : "0".repeat(64)));
  assertClosed(result);
  assert.deepEqual(f.state().writes, []);
  assert.deepEqual(privateFile(f.packetPath), packetBefore);
  assert.equal(fs.existsSync(`${f.packetPath}.journal.json`), false);
});

test("execute-authority rejects foreign journal3 operation, packet, authority and receipt seal before any CAS", async t => {
  const f = await authorityFixture(t), { sha, packet } = verifiedPlan(f);
  const baseline = { schema: 3, planHash: sha, operation: f.receipt.incident.operation, stage: "prepared", steps: {}, events: [],
    authoritySha256: packet.authoritySha256, deploymentGenerations: packet.deployments.map(value => ({ name: value.name, uid: value.uid,
      pausedGeneration: value.generation, resumedGeneration: value.generation + (value.replicas > 0 ? 1 : 0),
      clearedGeneration: value.generation + (value.replicas > 0 ? 2 : 0) })) };
  for (const foreign of ["operation", "planHash", "authoritySha256", "receiptSeal"]) {
    const journal = clone(baseline);
    if (foreign !== "receiptSeal") journal[foreign] = foreign === "operation" ? "2".repeat(32) : "f".repeat(64);
    journal.authentication = createCheckpointAbortJournalSeal({ keyringPath: f.keyringPath, keyId,
      receiptSha256: foreign === "receiptSeal" ? "f".repeat(64) : hash(canonicalJsonV1(f.receipt)), journal });
    const journalPath = `${f.packetPath}.journal.json`; writeFixture(journalPath, journal);
    const before = privateFile(journalPath), result = runCli(f, executeArgs(f, sha));
    assertClosed(result);
    assert.deepEqual(f.state().writes, [], `${foreign} must fail before the serialization Lease CAS`);
    assert.deepEqual(privateFile(journalPath), before, "a rejected foreign journal must not be resealed or adopted");
  }
});
