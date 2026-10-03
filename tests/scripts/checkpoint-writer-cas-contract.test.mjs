import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const library = fs.readFileSync(path.join(root, "deployment/lib/recovery-safety.sh"), "utf8");
const shell = process.env.YENHUBS_TEST_BASH || "bash";
const operationId = "0123456789abcdef0123456789abcdef";
const receiptKey = "yenhubs.org/checkpoint-resume-operation";
const privateCanary = "synthetic-full-spec-private-canary";
const closedPeers = new Set([
  "recovery_kubectl", "recovery_kubectl_mutate",
  "recovery_require_operation_serialization", "recovery_require_operation_lock"
]);
const safeForbiddenCommands = new Set([
  "kubectl", "curl", "wget", "ssh", "kill", "trap",
  "unexpected-get", "unexpected-patch", "invalid-patch",
  "private-json-argv", "private-json-export"
]);

// Load the real scaler and its real parsing predicates, never a historical copy
// or the library's top-level capability initialization. Resolve local helper
// dependencies from the current source so a later repair is exercised as well.
const definitions = new Map([...library.matchAll(/^([A-Za-z_]\w*)\(\) \{\n[\s\S]*?^\}/gm)]
  .map(match => [match[1], match[0]]));
function realFunctions(entry) {
  const selected = new Map();
  function visit(name) {
    if (closedPeers.has(name) || selected.has(name)) return;
    const source = definitions.get(name);
    assert.ok(source, `production function ${name}`);
    selected.set(name, source);
    for (const [dependency] of source.matchAll(/\brecovery_[a-z0-9_]+\b/g)) {
      if (definitions.has(dependency)) visit(dependency);
    }
  }
  visit(entry);
  visit("recovery_capture_deployment_contract");
  return [...selected.values()].join("\n");
}
const functions = realFunctions("recovery_scale_deployment_exact");

function deployment(replicas) {
  return {
    apiVersion: "apps/v1", kind: "Deployment",
    metadata: { name: "reticulum", namespace: "hcce", uid: "uid-reticulum",
      resourceVersion: "rv-before", generation: 11, annotations: {} },
    spec: {
      replicas, revisionHistoryLimit: 8, progressDeadlineSeconds: 120, paused: false,
      selector: { matchLabels: { app: "reticulum" } }, strategy: { type: "Recreate" },
      template: { metadata: { labels: { app: "reticulum" } },
        spec: { containers: [{ name: "reticulum", image: "fixture@sha256:unchanged" }] } }
    }
  };
}
function transitioned(before, desiredReplicas, receipt) {
  const value = structuredClone(before);
  value.metadata.resourceVersion = "rv-after";
  value.metadata.generation += desiredReplicas === before.spec.replicas ? 0 : 1;
  value.spec.replicas = desiredReplicas;
  if (receipt) value.metadata.annotations[receiptKey] = receipt;
  return value;
}
function fingerprint(value) {
  return Buffer.from(JSON.stringify({ selector: value.spec.selector,
    strategy: value.spec.strategy || {}, template: value.spec.template })).toString("base64");
}

// Model only the scaler's local decision boundary. Guards are closed stubs;
// the API peer applies/validates JSON Patch tests against a captured fixture.
// The stream/resume sentinels are synthetic callers, not real backup streams,
// Kubernetes, HMAC authority, monitor continuity or five-writer acceptance.
function run({ originalReplicas = 1, desiredReplicas = 0, receipt = "",
  driftAt, driftField, probePrivacy = false } = {}) {
  const before = deployment(originalReplicas);
  if (probePrivacy) before.spec.template.spec.containers[0].env = [
    { name: "SYNTHETIC_PRIVATE_VALUE", value: privateCanary }
  ];
  const exact = transitioned(before, desiredReplicas, receipt);
  const response = structuredClone(exact), readback = structuredClone(exact);
  const drifted = driftAt === "response" ? response : readback;
  if (driftField === "spec") drifted.spec.revisionHistoryLimit += 1;
  if (driftField === "generation") drifted.metadata.generation += 1;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "yenhubs-writer-cas-"));
  fs.chmodSync(directory, 0o700);
  const marker = path.join(directory, "patched");
  const script = `set -euo pipefail
exec 3>&1
NAMESPACE=hcce
${functions}
fixture_event() {
  local event="$1"; shift
  jq -cn --arg event "$event" "$@" '{event:$event} + $ARGS.named' >&3
}
fixture_forbidden() {
  fixture_event forbidden --arg command "$1"
  return 97
}
jq() {
  local argument name declaration slots=""
  if [[ "$TEST_PROBE_PRIVACY" == 1 && "\${FUNCNAME[1]:-}" == recovery_* ]]; then
    for argument in "$@"; do
      [[ "$argument" != *"$TEST_PRIVATE_CANARY"* ]] || {
        fixture_forbidden private-json-argv; return 97;
      }
    done
    case "\${FUNCNAME[*]}" in
      *recovery_scale_deployment_exact*) slots="before_json after_json patched_json" ;;
      *recovery_capture_deployment_contract*) slots="deployment_json" ;;
    esac
    for name in $slots; do
      declaration="$(declare -p "$name" 2>/dev/null)" || continue
      [[ ! "$declaration" =~ ^declare[[:space:]]+-[^[:space:]]*x ]] || {
        fixture_forbidden private-json-export; return 97;
      }
    done
  fi
  command jq "$@"
}
kubectl() { fixture_forbidden kubectl; }
curl() { fixture_forbidden curl; }
wget() { fixture_forbidden wget; }
ssh() { fixture_forbidden ssh; }
kill() { fixture_forbidden kill; }
trap() { fixture_forbidden trap; }
recovery_require_operation_serialization() {
  fixture_event serialization-guard
}
recovery_require_operation_lock() {
  fixture_event operation-lock-guard
}
recovery_kubectl() {
  [[ "$#" == 7 && "$1:$2:$3:$4:$5:$6:$7" == \\
    get:deployment:reticulum:-n:hcce:-o:json ]] || {
    fixture_forbidden unexpected-get; return 97;
  }
  if [[ -f "$TEST_MARKER" ]]; then
    fixture_event get-readback --argjson object "$TEST_READBACK"
    printf '%s\\n' "$TEST_READBACK"
  else
    fixture_event get-capture --argjson object "$TEST_BEFORE"
    printf '%s\\n' "$TEST_BEFORE"
  fi
}
recovery_kubectl_mutate() {
  [[ "$#" == 9 && "$1:$2:$3:$4:$5:$6:$8:$9" == \\
    patch:deployment:reticulum:-n:hcce:--type=json:-o:json && \\
    "$7" == --patch=* && ! -e "$TEST_MARKER" ]] || {
    fixture_forbidden unexpected-patch; return 97;
  }
  local patch="\${7#--patch=}"
  fixture_event patch-request --argjson patch "$patch"
  # Every supplied test must evaluate against the complete pre-write object;
  # extra generation/full-spec tests added by the repair are not forbidden.
  command jq -e --argjson before "$TEST_BEFORE" --argjson desired "$TEST_DESIRED" \\
    --arg receipt "$TEST_RECEIPT" '
    def pointer: split("/")[1:] | map(gsub("~1";"/") | gsub("~0";"~"));
    type == "array" and
    ([.[] | select(.op == "test" and .path == "/metadata/uid" and
      .value == $before.metadata.uid)] | length) == 1 and
    ([.[] | select(.op == "test" and .path == "/metadata/resourceVersion" and
      .value == $before.metadata.resourceVersion)] | length) == 1 and
    ([.[] | select(.op == "test" and .path == "/spec/replicas" and
      .value == $before.spec.replicas)] | length) == 1 and
    ([.[] | select(.op == "replace" and .path == "/spec/replicas" and
      .value == $desired)] | length) == 1 and
    ([.[] | select(.op == "add")] | length) ==
      (if $receipt == "" then 0 else 1 end) and
    all(.[]; . as $op |
      if $op.op == "test" then
        ($before | getpath($op.path | pointer)) == $op.value
      elif $op.op == "replace" then
        $op.path == "/spec/replicas" and $op.value == $desired
      elif $op.op == "add" then
        $receipt != "" and
        $op.path == "/metadata/annotations/yenhubs.org~1checkpoint-resume-operation" and
        $op.value == $receipt
      else false end)
  ' >/dev/null <<<"$patch" || {
    fixture_forbidden invalid-patch; return 97;
  }
  : >"$TEST_MARKER"
  fixture_event patch-response --argjson object "$TEST_RESPONSE"
  printf '%s\\n' "$TEST_RESPONSE"
}
captured="$(recovery_capture_deployment_contract reticulum)"
fixture_event captured-contract --arg contract "$captured"
IFS=$'\\t' read -r uid rv replicas selector captured_fingerprint <<<"$captured"
status=0
result_rv=""
if result_rv="$(recovery_scale_deployment_exact reticulum "$uid" "$rv" \\
  "$replicas" "$TEST_DESIRED" "$selector" "$captured_fingerprint" "$TEST_RECEIPT")"; then
  fixture_event stream-sentinel
  fixture_event resume-sentinel
else
  status=$?
fi
fixture_event result --argjson status "$status" --arg resource_version "$result_rv" \\
  --argjson original_replicas "$replicas"
`;
  try {
    const result = spawnSync(shell, ["-c", script], {
      cwd: root, encoding: "utf8", timeout: 15000,
      // Do not inherit startup hooks, API credentials or runtime capabilities.
      env: { PATH: process.env.PATH, LC_ALL: "C", TEST_MARKER: marker,
        TEST_BEFORE: JSON.stringify(before), TEST_RESPONSE: JSON.stringify(response),
        TEST_READBACK: JSON.stringify(readback), TEST_DESIRED: String(desiredReplicas),
        TEST_RECEIPT: receipt, TEST_PROBE_PRIVACY: probePrivacy ? "1" : "0",
        TEST_PRIVATE_CANARY: privateCanary,
        // Probe inherited export attributes, not real runtime credentials.
        ...(probePrivacy ? { before_json: "inherited-slot", after_json: "inherited-slot",
          patched_json: "inherited-slot", deployment_json: "inherited-slot" } : {}) }
    });
    assert.equal(result.error, undefined, "local fixture process must start and finish");
    assert.equal(result.status, 0, `fixture/setup failure, not CAS rejection: ${result.stderr}`);
    const events = result.stdout.trim().split("\n").map(line => JSON.parse(line));
    const forbiddenCommands = events.filter(event => event.event === "forbidden")
      .map(event => safeForbiddenCommands.has(event.command) ? event.command : "unknown-command");
    assert.equal(forbiddenCommands.length, 0,
      "no unexpected API/guard/signal boundary or malformed PATCH may explain RED; " +
      `safe forbidden commands: ${forbiddenCommands.join(", ") || "none"}`);
    const outcomes = events.filter(event => event.event === "result");
    assert.equal(outcomes.length, 1, "fixture must produce one local outcome");
    return { before, exact, response, readback, desiredReplicas, receipt, events,
      outcome: outcomes[0], diagnostic: result.stderr };
  } finally {
    // Only this invocation's one synthetic marker and empty private directory.
    // No recursive cleanup, repository path or production artifact is removed.
    if (fs.existsSync(marker)) fs.unlinkSync(marker);
    fs.rmdirSync(directory);
  }
}

function eventObjects(result, name) {
  return result.events.filter(event => event.event === name);
}
function assertExercised(result, { needsReadback = false } = {}) {
  const { before, desiredReplicas, events } = result;
  const captures = eventObjects(result, "get-capture");
  assert.ok(captures.length >= 2, "both the initial real capture and pre-CAS capture must run");
  for (const capture of captures) assert.deepEqual(capture.object, before);
  const contracts = eventObjects(result, "captured-contract");
  assert.equal(contracts.length, 1);
  assert.deepEqual(contracts[0].contract.split("\t"), [before.metadata.uid,
    before.metadata.resourceVersion, String(before.spec.replicas),
    before.spec.selector.matchLabels.app, fingerprint(before)], "real capture admits the complete positive fixture");
  const requests = eventObjects(result, "patch-request");
  const responses = eventObjects(result, "patch-response");
  assert.equal(requests.length, 1, "one bounded CAS request must be exercised");
  assert.equal(responses.length, 1, "the injected PATCH response must actually be consumed");
  assert.deepEqual(responses[0].object, result.response);
  const required = [
    { op: "test", path: "/metadata/uid", value: before.metadata.uid },
    { op: "test", path: "/metadata/resourceVersion", value: before.metadata.resourceVersion },
    { op: "test", path: "/metadata/generation", value: before.metadata.generation },
    { op: "test", path: "/spec/replicas", value: before.spec.replicas },
    { op: "replace", path: "/spec/replicas", value: desiredReplicas }
  ];
  for (const operation of required) {
    assert.ok(requests[0].patch.some(value => value.op === operation.op &&
      value.path === operation.path && value.value === operation.value),
      `executable CAS precondition/replica mutation ${operation.path}`);
  }
  const requestIndex = events.indexOf(requests[0]);
  const responseIndex = events.indexOf(responses[0]);
  assert.ok(events.indexOf(captures.at(-1)) < requestIndex && requestIndex < responseIndex,
    "real capture precedes PATCH, which precedes its response");
  assert.ok(events.slice(0, requestIndex).some(event => event.event === "serialization-guard"));
  assert.ok(events.slice(0, requestIndex).some(event => event.event === "operation-lock-guard"));
  const readbacks = eventObjects(result, "get-readback");
  if (needsReadback) assert.ok(readbacks.length >= 1, "the separate post-PATCH GET must run");
  for (const readback of readbacks) {
    assert.ok(events.indexOf(readback) > responseIndex, "readback cannot contaminate pre-write capture");
    assert.deepEqual(readback.object, result.readback);
  }
}
function assertAccepted(result) {
  assertExercised(result, { needsReadback: true });
  assert.equal(result.outcome.status, 0, `positive must succeed before testing drift: ${result.diagnostic}`);
  assert.equal(result.outcome.resource_version, "rv-after");
  assert.equal(result.outcome.original_replicas, result.before.spec.replicas);
  assert.deepEqual(result.response, result.exact);
  assert.deepEqual(result.readback, result.exact);
  assert.equal(eventObjects(result, "stream-sentinel").length, 1);
  assert.equal(eventObjects(result, "resume-sentinel").length, 1);
  const finalReadback = result.events.indexOf(eventObjects(result, "get-readback").at(-1));
  assert.ok(result.events.indexOf(eventObjects(result, "stream-sentinel")[0]) > finalReadback);
}
function assertInjectedOnly(result, where, field) {
  const changed = where === "response" ? result.response : result.readback;
  const unchanged = where === "response" ? result.readback : result.response;
  assert.deepEqual(unchanged, result.exact, "the other API stage remains an exact positive contract");
  assert.equal(changed.metadata.uid, result.before.metadata.uid);
  assert.equal(changed.metadata.resourceVersion, "rv-after");
  assert.equal(changed.spec.replicas, result.desiredReplicas);
  assert.equal(fingerprint(changed), fingerprint(result.before), "drift is outside the old fingerprint");
  const normalized = structuredClone(changed);
  if (field === "spec") {
    assert.notEqual(normalized.spec.revisionHistoryLimit, result.exact.spec.revisionHistoryLimit);
    normalized.spec.revisionHistoryLimit = result.exact.spec.revisionHistoryLimit;
  } else {
    assert.notEqual(normalized.metadata.generation, result.exact.metadata.generation);
    normalized.metadata.generation = result.exact.metadata.generation;
  }
  assert.deepEqual(normalized, result.exact, "only the named response/readback field is injected");
}

test("writer CAS accepts complete exact stop and receipt-bearing resume contracts", () => {
  assertAccepted(run());
  assertAccepted(run({ originalReplicas: 0, desiredReplicas: 1, receipt: operationId }));
});

test("writer CAS original zero accepts stable generation despite metadata/RV advance", () => {
  const result = run({ originalReplicas: 0, desiredReplicas: 0 });
  assertAccepted(result);
  assert.equal(result.exact.metadata.generation, result.before.metadata.generation);
  assert.equal(result.outcome.original_replicas, 0);
  const receiptResult = run({ originalReplicas: 0, desiredReplicas: 0, receipt: operationId });
  assertAccepted(receiptResult);
  assert.equal(receiptResult.exact.metadata.generation, receiptResult.before.metadata.generation);
  // The helper still PATCHes. This does NOT test the BASE caller's separate
  // skip path, absence of a mutation, or real Kubernetes no-op RV semantics.
  assert.equal(eventObjects(result, "patch-request").length, 1);
});

test("writer CAS full-spec capture is not passed through argv or inherited export slots", () => {
  assertAccepted(run({ probePrivacy: true }));
});

for (const [where, field] of [
  ["response", "spec"], ["readback", "spec"],
  ["response", "generation"], ["readback", "generation"]
]) {
  test(`writer CAS rejects ${where}-only ${field} drift before stream/resume continuation`, () => {
    assertAccepted(run());
    const result = run({ driftAt: where, driftField: field });
    assertInjectedOnly(result, where, field);
    assertExercised(result, { needsReadback: where === "readback" });
    assert.notEqual(result.outcome.status, 0,
      `real scaler accepted ${where}-only ${field} drift with unchanged UID/fingerprint and desired replicas`);
    assert.equal(eventObjects(result, "stream-sentinel").length, 0, "rejection must not continue to backup stream");
    assert.equal(eventObjects(result, "resume-sentinel").length, 0, "rejection must not continue to resume boundary");
  });
}

for (const where of ["response", "readback"]) {
  test(`writer CAS original zero rejects ${where}-only false generation increment`, () => {
    const options = { originalReplicas: 0, desiredReplicas: 0 };
    assertAccepted(run(options));
    const result = run({ ...options, driftAt: where, driftField: "generation" });
    assertInjectedOnly(result, where, "generation");
    assertExercised(result, { needsReadback: where === "readback" });
    assert.equal(result.outcome.original_replicas, 0);
    assert.notEqual(result.outcome.status, 0, "same replicas must not authorize a fabricated G+1");
    assert.equal(eventObjects(result, "stream-sentinel").length, 0);
    assert.equal(eventObjects(result, "resume-sentinel").length, 0);
  });
}
