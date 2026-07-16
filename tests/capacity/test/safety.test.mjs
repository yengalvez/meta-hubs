import test from "node:test";
import assert from "node:assert/strict";
import { loadCatalogue } from "../lib/io.mjs";
import { validateCatalogue } from "../lib/schema.mjs";
import { assertExecutionSafety, validateTarget } from "../lib/safety.mjs";

const scenarios = validateCatalogue(await loadCatalogue());
const smoke = scenarios.get("local-smoke");

test("there is no implicit capacity target", () => {
  assert.throws(() => validateTarget(undefined), error => error.code === "TARGET_REQUIRED");
});

test("known production host and every subdomain are hard denied", () => {
  for (const target of ["https://meta-hubs.org/room", "https://staging.meta-hubs.org/room"]) {
    assert.throws(() => validateTarget(target), error => error.code === "PRODUCTION_TARGET_DENIED");
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
  assert.equal(validateTarget("https://capacity-staging.example.org/room").classification, "staging");
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

test("physical execution is unconditionally disabled", () => {
  assert.throws(
    () => assertExecutionSafety({
      scenario: smoke,
      target: "http://localhost:4000/test-room"
    }),
    error => error.code === "PHYSICAL_EXECUTION_DISABLED"
  );
  assert.throws(
    () => assertExecutionSafety({
      scenario: scenarios.get("total-10000-model"),
      target: "https://staging.example.org/room",
    }),
    error => error.code === "PHYSICAL_EXECUTION_DISABLED"
  );
});
