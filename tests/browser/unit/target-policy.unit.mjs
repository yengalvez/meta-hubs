import assert from "node:assert/strict";
import test from "node:test";

import {
  assertFinalBrowserTarget,
  isExpectedBrowserDiagnostic,
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
  assert.equal(
    requireSafeBrowserTarget("https://staging.meta-hubs.org/room").origin,
    "https://staging.meta-hubs.org",
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

test("classifies only bounded browser baseline diagnostics as expected", () => {
  assert.equal(
    isExpectedBrowserDiagnostic({
      kind: "request-failed",
      method: "HEAD",
      errorText: "net::ERR_ABORTED",
      url: "https://staging.meta-hubs.org/room",
    }),
    true,
  );
  assert.equal(
    isExpectedBrowserDiagnostic({
      kind: "console-warning",
      text: "enableChromeAEC: inboundPeerConnection state changed to connected",
      url: "https://assets.staging.meta-hubs.org/hubs/app.js",
    }),
    true,
  );
  assert.equal(
    isExpectedBrowserDiagnostic({
      kind: "console-error",
      text: "Failed to load resource: the server responded with a status of 404 ()",
      url: "https://staging.meta-hubs.org/favicon.ico",
    }),
    true,
  );
  assert.equal(
    isExpectedBrowserDiagnostic({
      kind: "request-failed",
      method: "GET",
      errorText: "net::ERR_CONNECTION_RESET",
      url: "https://assets.staging.meta-hubs.org/hubs/app.js",
    }),
    false,
  );
  assert.equal(
    isExpectedBrowserDiagnostic({
      kind: "http-error",
      status: 500,
      method: "GET",
      url: "https://staging.meta-hubs.org/api/v1/hubs",
    }),
    false,
  );
});
