import test from "node:test";
import assert from "node:assert/strict";
import { sanitize, sanitizeText } from "../lib/sanitize.mjs";

test("sanitizer redacts secret-shaped keys recursively", () => {
  const value = sanitize({
    token: "top-secret",
    nested: {
      apiKey: "also-secret",
      Authorization: "Bearer abc.def",
      safe: "visible"
    }
  });
  assert.equal(value.token, "[REDACTED]");
  assert.equal(value.nested.apiKey, "[REDACTED]");
  assert.equal(value.nested.Authorization, "[REDACTED]");
  assert.equal(value.nested.safe, "visible");
});

test("sanitizer removes URL userinfo, query values and fragments", () => {
  const value = sanitize("https://user:pass@staging.example.org/room?token=abc&x=123#private");
  assert.doesNotMatch(value, /user|pass|abc|123|private/);
  assert.match(value, /REDACTED/);
});

test("sanitizer removes bearer values from free text and bounds stderr", () => {
  const value = sanitizeText(`failure Authorization: Bearer abc.def ${"x".repeat(9000)}`);
  assert.doesNotMatch(value, /abc\.def/);
  assert.ok(value.length <= 8192);
});

test("sanitizer handles circular evidence without throwing", () => {
  const value = { safe: "yes" };
  value.self = value;
  assert.deepEqual(sanitize(value), { safe: "yes", self: "[CIRCULAR]" });
});
