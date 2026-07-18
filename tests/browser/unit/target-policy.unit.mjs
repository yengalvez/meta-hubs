import assert from "node:assert/strict";
import test from "node:test";

import {
  assertFinalBrowserTarget,
  requireSafeBrowserTarget,
} from "../browser-contract-utils.mjs";

test.afterEach(() => {
  delete process.env.BROWSER_ALLOW_PRODUCTION;
});

test("requires an explicit target", () => {
  assert.throws(() => requireSafeBrowserTarget(), /required/);
});

test("allows loopback HTTP and marked remote HTTPS", () => {
  assert.equal(
    requireSafeBrowserTarget("http://127.0.0.1:4000/room").origin,
    "http://127.0.0.1:4000",
  );
  assert.equal(
    requireSafeBrowserTarget("https://qa.example.org/room").origin,
    "https://qa.example.org",
  );
});

test("rejects credentials and unmarked or plaintext remote targets", () => {
  assert.throws(
    () => requireSafeBrowserTarget("https://user:pass@qa.example.org/room"),
    /Credentials/,
  );
  assert.throws(
    () => requireSafeBrowserTarget("https://example.org/room"),
    /explicit/,
  );
  assert.throws(
    () => requireSafeBrowserTarget("http://staging.example.org/room"),
    /HTTPS/,
  );
});

test("denies the production domain family unless explicitly enabled", () => {
  assert.throws(
    () => requireSafeBrowserTarget("https://meta-hubs.org/room"),
    /production/,
  );
  assert.throws(
    () => requireSafeBrowserTarget("https://preview.meta-hubs.org/room"),
    /production/,
  );
  process.env.BROWSER_ALLOW_PRODUCTION = "1";
  assert.equal(
    requireSafeBrowserTarget("https://meta-hubs.org/room").hostname,
    "meta-hubs.org",
  );
});

test("rejects cross-origin redirects", () => {
  const planned = requireSafeBrowserTarget("https://staging.example.org/room");
  assert.doesNotThrow(() =>
    assertFinalBrowserTarget("https://staging.example.org/other", planned),
  );
  assert.throws(
    () => assertFinalBrowserTarget("https://evil.example.org/room", planned),
    /different origin/,
  );
});
