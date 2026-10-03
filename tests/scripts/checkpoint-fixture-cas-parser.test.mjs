import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import test from "node:test";

const source = fs.readFileSync(new URL("../recovery/test-recovery-safety.sh", import.meta.url), "utf8");
const invocation = '  patch_contract="$(jq -er --arg uid "$expected_patch_uid"';
const opening = '--argjson current_spec "$current_spec" \'';
const closing = '\n  \' <<<"$patch_json")" || exit 1';
const invocationStart = source.indexOf(invocation);
assert.ok(invocationStart >= 0, "real fixture PATCH parser invocation");
assert.equal(source.indexOf(invocation, invocationStart + 1), -1, "one real fixture PATCH parser");
const programStart = source.indexOf(opening, invocationStart);
assert.ok(programStart > invocationStart, "real parser opening delimiter");
const programEnd = source.indexOf(closing, programStart + opening.length);
assert.ok(programEnd > programStart, "real parser closing delimiter");
const program = source.slice(programStart + opening.length, programEnd);

const uid = "fixture-deployment-uid", rv = "rv-reticulum-1", generation = 11;
const operationId = "0123456789abcdef0123456789abcdef";
const receiptPath = "/metadata/annotations/yenhubs.org~1checkpoint-resume-operation";
const guard = (path, value) => ({ op: "test", path, value });
const replace = value => ({ op: "replace", path: "/spec/replicas", value });
const identity = () => [guard("/metadata/uid", uid), guard("/metadata/resourceVersion", rv)];
const oldScalar = (current = 1, desired = 0) => [
  ...identity(), guard("/spec/replicas", current), replace(desired)
];
const scalar = (current = 1, desired = 0) => [
  ...identity(), guard("/metadata/generation", generation),
  guard("/spec/replicas", current), replace(desired)
];
const receipt = (wholeAnnotations = false) => wholeAnnotations
  ? { op: "add", path: "/metadata/annotations", value: { "yenhubs.org/checkpoint-resume-operation": operationId } }
  : { op: "add", path: receiptPath, value: operationId };
function scalarWithReceipt(wholeAnnotations = false) {
  const patch = scalar(0, 1);
  patch.splice(4, 0, receipt(wholeAnnotations));
  return patch;
}
function spec(current = 1) {
  return { replicas: current, revisionHistoryLimit: 8,
    selector: { matchLabels: { app: "reticulum" } }, strategy: { type: "Recreate" },
    template: { metadata: { labels: { app: "reticulum" } },
      spec: { containers: [{ name: "reticulum", image: "synthetic-fixture-image" }] } } };
}

// Execute only the jq program extracted above, with synthetic inputs. This
// does not run the shell harness, product scaler, kubectl, DB or any server.
// Parser classifications do not prove generation mutation/readback semantics.
function parse(patch, current = 1) {
  const result = spawnSync("jq", ["-er", "--arg", "uid", uid, "--arg", "rv", rv,
    "--argjson", "current", String(current), "--argjson", "generation", String(generation),
    "--argjson", "current_spec", JSON.stringify(spec(current)), program], {
    input: JSON.stringify(patch), encoding: "utf8", timeout: 5000,
    env: { PATH: process.env.PATH, LC_ALL: "C" }
  });
  assert.equal(result.error, undefined, "the local jq peer must start and finish");
  assert.equal(result.signal, null, "the local jq peer must finish without a signal");
  return result;
}
function accepted(patch, expected, current = 1) {
  const result = parse(patch, current);
  assert.equal(result.status, 0, `fixture parser must admit this exact shape: ${result.stderr}`);
  assert.equal(result.stdout, `${expected.join("\t")}\n`, "real parser classification/replica/receipt tuple");
}
function rejected(patch, current = 1) {
  // Always establish a real positive before interpreting a rejection: a broken
  // delimiter/program/runtime cannot masquerade as a fail-closed predicate.
  accepted(oldScalar(current, 0), ["scale", "0", ""], current);
  const result = parse(patch, current);
  assert.notEqual(result.status, 0, "invalid request must not receive a parser classification");
  assert.equal(result.stdout, "", "rejection must not emit a partial accepted tuple");
}

test("fixture CAS parser retains legacy scalar4 and complete-spec rolling5", () => {
  accepted(oldScalar(), ["scale", "0", ""]);
  accepted([...identity(), guard("/metadata/generation", generation),
    guard("/spec", spec()), replace(0)], ["rolling-scale", "0", ""]);
});

test("fixture CAS parser retains historical receipt, resume and cleanup shapes", () => {
  const stopped = [...identity(), guard("/spec/replicas", 0)];
  accepted([...stopped, receipt()], ["receipt", "0", operationId], 0);
  accepted([...stopped, receipt(), replace(1)], ["resume", "1", operationId], 0);
  accepted([...stopped, guard(receiptPath, operationId), replace(1)], ["resume-existing", "1", operationId], 0);
  accepted([...stopped, guard(receiptPath, operationId), { op: "remove", path: receiptPath }],
    ["cleanup", "0", operationId], 0);
});

test("fixture CAS parser accepts exact generation-and-replicas scalar5", () => {
  accepted(oldScalar(), ["scale", "0", ""]);
  accepted(scalar(), ["scale", "0", ""]);
});

test("fixture CAS parser accepts scalar5 original-zero without changing requested count", () => {
  accepted(oldScalar(0, 0), ["scale", "0", ""], 0);
  accepted(scalar(0, 0), ["scale", "0", ""], 0);
});

for (const wholeAnnotations of [false, true]) {
  test(`fixture CAS parser accepts receipt-plus-scalar6 with ${wholeAnnotations ? "annotations object" : "receipt leaf"}`, () => {
    accepted([...identity(), guard("/spec/replicas", 0), receipt(wholeAnnotations), replace(1)],
      ["resume", "1", operationId], 0);
    accepted(scalarWithReceipt(wholeAnnotations), ["resume", "1", operationId], 0);
  });
}

for (const withReceipt of [false, true]) {
  for (const field of ["generation", "replicas"]) {
    test(`fixture CAS parser rejects wrong ${field} precondition in ${withReceipt ? "receipt-plus-scalar6" : "scalar5"}`, () => {
      const patch = withReceipt ? scalarWithReceipt() : scalar();
      patch[field === "generation" ? 2 : 3].value += 1;
      rejected(patch, withReceipt ? 0 : 1);
    });
  }
  test(`fixture CAS parser rejects extra operation in ${withReceipt ? "receipt-plus-scalar6" : "scalar5"}`, () => {
    const patch = withReceipt ? scalarWithReceipt() : scalar();
    patch.push(guard("/spec/revisionHistoryLimit", 8));
    rejected(patch, withReceipt ? 0 : 1);
  });
  test(`fixture CAS parser rejects malformed replica guard in ${withReceipt ? "receipt-plus-scalar6" : "scalar5"}`, () => {
    const patch = withReceipt ? scalarWithReceipt() : scalar();
    patch[3].op = "replace";
    rejected(patch, withReceipt ? 0 : 1);
  });
}

test("fixture CAS parser rejects stale UID/RV and malformed top-level requests", () => {
  for (const index of [0, 1]) {
    const patch = scalar();
    patch[index].value = "foreign-fixture-identity";
    rejected(patch);
  }
  for (const patch of [null, {}, { items: scalar() }, "not-a-patch", []]) rejected(patch);
});

test("fixture CAS parser rejects malformed receipt object and replacement", () => {
  const extraReceiptKey = scalarWithReceipt(true);
  extraReceiptKey[4].value.extra = "synthetic-unexpected-key";
  rejected(extraReceiptKey, 0);
  for (const withReceipt of [false, true]) {
    for (const desired of [-1, 0.5]) {
      const patch = withReceipt ? scalarWithReceipt() : scalar();
      patch[withReceipt ? 5 : 4].value = desired;
      rejected(patch, withReceipt ? 0 : 1);
    }
  }
  const wrongPath = scalar();
  wrongPath[4].path = "/spec/revisionHistoryLimit";
  rejected(wrongPath);
});
