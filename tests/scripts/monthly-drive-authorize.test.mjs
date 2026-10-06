import { test } from "node:test";
import assert from "node:assert/strict";
import { extractDriveToken, authorizationLink } from "../../deployment/monthly-drive-authorize.mjs";

test("parses only the explicitly delimited authorization token", () => {
  const token = { access_token: "fixture-access", token_type: "Bearer",
    refresh_token: "fixture-refresh", expiry: "2026-10-06T14:00:00Z", discarded: "not-in-config" };
  const observed = extractDriveToken("irrelevant output\nPaste the following into your remote machine --->\n" +
    JSON.stringify(token) + "\n<---End paste\n");
  assert.deepEqual(observed, { access_token: token.access_token, token_type: "Bearer",
    refresh_token: token.refresh_token, expiry: token.expiry });
});

test("rejects missing refresh capability without echoing captured output", () => {
  const input = 'Paste the following into your remote machine --->\n{"access_token":"sensitive-fixture"}\n<---End paste';
  assert.throws(() => extractDriveToken(input), error =>
    error.message === "authorization_token_invalid" && !error.message.includes("sensitive-fixture"));
});

test("accepts the installed CLI's raw-standard-base64 config-map result", () => {
  const token = { access_token: "fixture-access", token_type: "Bearer",
    refresh_token: "fixture-refresh", expiry: "2026-10-06T14:00:00Z" };
  const encoded = Buffer.from(JSON.stringify({ token: JSON.stringify(token) })).toString("base64").replace(/=+$/, "");
  assert.deepEqual(extractDriveToken("Paste the following into your remote machine --->\n" +
    encoded + "\n<---End paste"), token);
});

test("only exposes a loopback login link, never a token or remote authorization URL", () => {
  assert.equal(authorizationLink("https://provider.example/auth?token=fixture"), null);
  assert.equal(authorizationLink("Go to http://127.0.0.1:53682/auth?state=a-b_c123"),
    "http://127.0.0.1:53682/auth?state=a-b_c123");
});

test("caps captured authorization output and requires terminal delimiters", () => {
  assert.throws(() => extractDriveToken("x".repeat(131073)), /authorization_output_too_large/);
  assert.throws(() => extractDriveToken('{"access_token":"fixture"}'), /authorization_token_missing/);
});
