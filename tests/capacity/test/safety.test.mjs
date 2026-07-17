import test from "node:test";
import assert from "node:assert/strict";
import { loadCatalogue } from "../lib/io.mjs";
import { buildPlan } from "../lib/plan.mjs";
import { validateCatalogue } from "../lib/schema.mjs";
import { assertExecutionSafety, executionAcknowledgement, validateCollectorEndpoint, validateTarget } from "../lib/safety.mjs";
import { makeTestAttestation, makeTestEnvironment } from "../test-support/fixtures.mjs";
import { assertAllowedBrowserUrl } from "../lib/security.mjs";
import { signTestDocument } from "../test-support/trust.mjs";
import { trackedTrustSummary } from "../lib/trust.mjs";

const scenarios = validateCatalogue(await loadCatalogue());
const smoke = scenarios.get("local-smoke");

test("production starts with no fabricated owner trust anchor", () => {
  assert.deepEqual(trackedTrustSummary(), { schemaVersion: 1, anchors: [] });
});

test("there is no implicit capacity target", () => {
  assert.throws(() => validateTarget(undefined), error => error.code === "TARGET_REQUIRED");
});

test("known production host and every subdomain are hard denied", () => {
  for (const target of [
    "https://meta-hubs.org/room",
    "https://staging.meta-hubs.org/room",
    "https://dev.meta-hubs.org.evil.example/room",
    "https://capacity-prod.example.org/room",
    "https://capacity-production.example.org/room",
    "https://capacity-live.example.org/room"
  ]) {
    assert.throws(() => validateTarget(target), error => error.code === "PRODUCTION_TARGET_DENIED");
  }
});

test("signed remote allowlists reject non-staging service and Coturn hosts", () => {
  const environment = makeTestEnvironment();
  for (const mutate of [
    attestation => { attestation.serviceOrigins.assets = ["https://assets-live.example.org"]; },
    attestation => { attestation.serviceOrigins.dialog = ["wss://dialog.example.org"]; },
    attestation => { attestation.coturnUrls = ["turns:coturn-prod.example.org:5349"]; },
    attestation => { attestation.coturnUrls = ["turns:coturn-capacity-staging.example.org:5349?username=secret"]; }
  ]) {
    const signed = makeTestAttestation("https://capacity-staging.example.org/room", { environment });
    const unsigned = structuredClone(signed);
    delete unsigned.signature;
    mutate(unsigned);
    assert.throws(
      () => buildPlan({
        scenario: smoke,
        target: "https://capacity-staging.example.org/room",
        botsPerRoom: 0,
        environment,
        attestation: signTestDocument(unsigned, "remote-attestation"),
        issuedAt: "2026-07-17T09:55:00.000Z"
      }),
      error => ["ATTESTATION_INVALID", "PRODUCTION_TARGET_DENIED"].includes(error.code)
    );
  }
});

test("unsigned or environment-rebound remote approvals fail closed", () => {
  const environment = makeTestEnvironment();
  const unsignedAttestation = makeTestAttestation("https://capacity-staging.example.org/room", { environment });
  delete unsignedAttestation.signature;
  assert.throws(
    () => buildPlan({
      scenario: smoke,
      target: "https://capacity-staging.example.org/room",
      botsPerRoom: 0,
      environment,
      attestation: unsignedAttestation,
      issuedAt: "2026-07-17T09:55:00.000Z"
    }),
    error => error.code === "SIGNATURE_INVALID"
  );

  const reboundEnvironment = makeTestEnvironment(undefined, { region: "test-region-2" });
  assert.throws(
    () => buildPlan({
      scenario: smoke,
      target: "https://capacity-staging.example.org/room",
      botsPerRoom: 0,
      environment: reboundEnvironment,
      attestation: makeTestAttestation("https://capacity-staging.example.org/room", { environment }),
      issuedAt: "2026-07-17T09:55:00.000Z"
    }),
    error => error.code === "ATTESTATION_INVALID"
  );
});

test("browser requests use the exact attested scheme, origin and port", () => {
  const environment = makeTestEnvironment();
  const remotePlan = buildPlan({
    scenario: smoke,
    target: "https://capacity-staging.example.org/room",
    botsPerRoom: 0,
    environment,
    attestation: makeTestAttestation("https://capacity-staging.example.org/room", { environment }),
    issuedAt: "2026-07-17T09:55:00.000Z"
  });
  assert.doesNotThrow(() => assertAllowedBrowserUrl(
    "wss://reticulum-capacity-staging.example.org/socket",
    remotePlan.security
  ));
  for (const url of [
    "https://reticulum-capacity-staging.example.org/socket",
    "wss://reticulum-capacity-staging.example.org:444/socket",
    "https://unreviewed-staging.example.org/asset"
  ]) {
    assert.throws(() => assertAllowedBrowserUrl(url, remotePlan.security), error => error.code === "BROWSER_ORIGIN_DENIED");
  }
});

test("remote host must be provably staging and HTTPS", () => {
  assert.throws(
    () => validateTarget("https://example.org/room"),
    error => error.code === "TARGET_NOT_PROVABLY_STAGING"
  );
  assert.throws(
    () => validateTarget("http://staging.example.org/room"),
    error => error.code === "TARGET_PROTOCOL_DENIED"
  );
  assert.equal(validateTarget("https://capacity-staging.example.org/room").classification, "attested-staging");
});

test("IPv4 and bracketed IPv6 loopback targets are classified as local", () => {
  assert.equal(validateTarget("http://127.0.0.1:4000/room").classification, "local");
  assert.equal(validateTarget("http://[::1]:4000/room").classification, "local");
});

test("target rejects URL credential channels", () => {
  assert.throws(
    () => validateTarget("https://user:pass@staging.example.org/room"),
    error => error.code === "TARGET_CREDENTIALS_DENIED"
  );
  assert.throws(
    () => validateTarget("https://staging.example.org/room?token=secret"),
    error => error.code === "TARGET_SECRET_CHANNEL_DENIED"
  );
  assert.throws(
    () => validateTarget("https://staging.example.org/room#secret"),
    error => error.code === "TARGET_SECRET_CHANNEL_DENIED"
  );
});

test("multi-room target requires a literal room placeholder", () => {
  assert.throws(
    () => validateTarget("https://staging.example.org/room", { roomCount: 12 }),
    error => error.code === "ROOM_TEMPLATE_REQUIRED"
  );
  const result = validateTarget("https://staging.example.org/{room}", { roomCount: 12 });
  assert.match(result.canonical, /\{room\}/);
});

test("physical execution remains disabled unless the plan, exact ACK and collector are explicit", () => {
  const disabled = buildPlan({
    scenario: smoke,
    target: "http://localhost:4000/test-room",
    botsPerRoom: 0
  });
  assert.throws(
    () => assertExecutionSafety({ plan: disabled }),
    error => error.code === "PHYSICAL_EXECUTION_DISABLED"
  );

  const enabled = buildPlan({
    scenario: smoke,
    target: "http://localhost:4000/test-room",
    botsPerRoom: 5,
    executionEnabled: true,
    environment: makeTestEnvironment()
  });
  assert.throws(
    () => assertExecutionSafety({
      plan: enabled,
      acknowledgement: executionAcknowledgement(enabled),
      collectorEndpoint: "http://localhost:4318/v1/capacity-sample"
    }),
    error => error.code === "SIGNATURE_UNTRUSTED"
  );
  assert.throws(
    () => assertExecutionSafety({
      plan: enabled,
      acknowledgement: "anything",
      collectorEndpoint: "http://localhost:4318/v1/capacity-sample",
      allowTestTrust: true
    }),
    error => error.code === "EXECUTION_ACK_INVALID"
  );
  assert.throws(
    () => assertExecutionSafety({
      plan: enabled,
      acknowledgement: executionAcknowledgement(enabled),
      allowTestTrust: true
    }),
    error => error.code === "COLLECTOR_ENDPOINT_REQUIRED"
  );
  const result = assertExecutionSafety({
    plan: enabled,
    acknowledgement: executionAcknowledgement(enabled),
    collectorEndpoint: "http://localhost:4318/v1/capacity-sample",
    allowTestTrust: true
  });
  assert.equal(result.targetClassification, "local");
  assert.match(result.collectorEndpoint, /127\.0\.0\.1|localhost/);
  assert.throws(
    () => validateCollectorEndpoint("http://localhost:4318/admin", enabled),
    error => error.code === "COLLECTOR_CLASSIFICATION_MISMATCH"
  );
});

test("collector endpoint is independently non-production and classification-bound", () => {
  const environment = makeTestEnvironment();
  const remotePlan = buildPlan({
    scenario: smoke,
    target: "https://capacity-staging.example.org/room",
    botsPerRoom: 0,
    environment,
    attestation: makeTestAttestation("https://capacity-staging.example.org/room", { environment }),
    issuedAt: "2026-07-17T09:55:00.000Z"
  });
  assert.throws(
    () => validateCollectorEndpoint("https://meta-hubs.org/metrics", remotePlan),
    error => error.code === "PRODUCTION_TARGET_DENIED"
  );
  assert.throws(
    () => validateCollectorEndpoint("http://localhost:4318/v1/capacity-sample", remotePlan),
    error => error.code === "COLLECTOR_ATTESTATION_MISMATCH"
  );
  assert.equal(
    validateCollectorEndpoint("https://collector-capacity-staging.example.org/v1/capacity-sample", remotePlan).classification,
    "attested-staging"
  );
});
