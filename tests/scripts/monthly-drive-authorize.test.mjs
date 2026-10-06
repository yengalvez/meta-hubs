import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, writeFile, readFile, stat, chmod, symlink, link } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { extractDriveToken, authorizationLink, parseDedicatedDriveClient,
  dedicatedAuthorizationSpec, authorizeDrive } from "../../deployment/monthly-drive-authorize.mjs";

const installed = () => ({ installed: { project_id: "yenhubs-backups-20261006",
  client_id: "123456789-fake.apps.googleusercontent.com", client_secret: "fake-drive-app-key-12345",
  auth_uri: "https://accounts.google.com/o/oauth2/auth", token_uri: "https://oauth2.googleapis.com/token",
  redirect_uris: ["http://localhost"] } });
const tokenFixture = { access_token: "fixture-access", token_type: "Bearer",
  refresh_token: "fixture-refresh", expiry: "2026-10-06T14:00:00Z" };
const tokenOutput = () => "Go to http://127.0.0.1:53682/auth?state=a-b_c123\n" +
  "Paste the following into your remote machine --->\n" +
  Buffer.from(JSON.stringify({ token: JSON.stringify(tokenFixture) })).toString("base64").replace(/=+$/, "") +
  "\n<---End paste\n";

async function privateFixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "yenhubs-drive-auth-fixture-")));
  const clientJsonPath = join(directory, "client.json"), configPath = join(directory, "rclone.conf");
  await writeFile(clientJsonPath, JSON.stringify(installed()), { mode: 0o600 });
  return { directory, clientJsonPath, configPath };
}

function fakeProcess({ output = tokenOutput(), code = 0, observe = () => {} } = {}) {
  return (program, args, options) => {
    observe(program, args, options);
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    let terminated = false;
    child.kill = signal => { terminated = true; queueMicrotask(() => child.emit("close", null, signal)); return true; };
    queueMicrotask(() => {
      child.stdout.end(output); child.stderr.end();
      if (!terminated) child.emit("close", code, null);
    });
    return child;
  };
}

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

test("dedicated Google client must be installed-type in the exact isolated project", () => {
  const value = installed();
  assert.deepEqual(parseDedicatedDriveClient(value), { clientId: value.installed.client_id,
    clientSecret: value.installed.client_secret, projectId: value.installed.project_id });
});

test("rejects foreign projects, web clients, injected INI lines and foreign endpoints without echoing credentials", () => {
  const inputs = [{ web: installed().installed }, installed(), installed(), installed(), installed(), installed()];
  inputs[1].installed.project_id = "unrelated-project";
  inputs[2].installed.client_secret += "\nscope = drive";
  inputs[3].installed.token_uri = "https://provider.example/token";
  inputs[4].installed.redirect_uris = ["https://provider.example/callback"];
  inputs[5].installed.client_id = [installed().installed.client_id];
  for (const value of inputs) assert.throws(() => parseDedicatedDriveClient(value), error =>
    error.message === "authorization_client_json_invalid" && !error.message.includes("fake-drive-app-key"));
});

test("dedicated authorization has no credentials in argv and cannot inherit scope or global rclone settings", () => {
  const client = parseDedicatedDriveClient(installed());
  const spec = dedicatedAuthorizationSpec(client, { PATH: "/fixture/bin", LANG: "es_ES.UTF-8",
    RCLONE_DRIVE_SCOPE: "drive", RCLONE_DRIVE_TOKEN: "foreign-token", RCLONE_DRIVE_SERVICE_ACCOUNT_FILE: "/foreign.json",
    RCLONE_CONFIG: "/global.conf", RCLONE_DRIVE_ROOT_FOLDER_ID: "foreign-folder" });
  assert.deepEqual(JSON.parse(Buffer.from(spec.args[2], "base64").toString("utf8")), { scope: "drive.file" });
  assert.deepEqual(spec.args.slice(3), ["--auth-no-open-browser", "--config", "/dev/null"]);
  assert.ok(!spec.args.join(" ").includes(client.clientSecret));
  assert.ok(!spec.args.join(" ").includes(client.clientId));
  assert.equal(spec.env.RCLONE_DRIVE_CLIENT_ID, client.clientId);
  assert.equal(spec.env.RCLONE_DRIVE_CLIENT_SECRET, client.clientSecret);
  assert.equal(spec.env.RCLONE_DRIVE_SCOPE, "drive.file");
  assert.equal(spec.env.RCLONE_CONFIG, "/dev/null");
  for (const key of ["RCLONE_DRIVE_TOKEN", "RCLONE_DRIVE_SERVICE_ACCOUNT_FILE", "RCLONE_DRIVE_ROOT_FOLDER_ID"]) {
    assert.equal(spec.env[key], undefined);
  }
  assert.equal(spec.env.PATH, "/fixture/bin");
});

test("private JSON path and closed login fixture persist dedicated refresh credentials only in a new0600 config", async () => {
  const f = await privateFixture(), links = [];
  const result = await authorizeDrive({ ...f, onLink: url => links.push(url),
    startProcess: fakeProcess({ observe(program, args, options) {
      assert.equal(program, "rclone");
      assert.ok(!args.join(" ").includes(installed().installed.client_secret));
      assert.equal(options.env.RCLONE_DRIVE_SCOPE, "drive.file");
    } }) });
  assert.deepEqual(links, ["http://127.0.0.1:53682/auth?state=a-b_c123"]);
  assert.equal(result.status, "AUTHORIZED");
  assert.equal(result.clientType, "dedicated");
  assert.equal(result.unattendedAccessVerified, false);
  const stored = await readFile(f.configPath, "utf8");
  assert.ok(stored.includes("client_id = " + installed().installed.client_id + "\n"));
  assert.ok(stored.includes("client_secret = " + installed().installed.client_secret + "\n"));
  assert.ok(stored.includes("token = " + JSON.stringify(tokenFixture) + "\n"));
  assert.equal((await stat(f.configPath)).mode & 0o777, 0o600);
  assert.ok(!JSON.stringify(result).includes(installed().installed.client_secret));
  assert.ok(!JSON.stringify(result).includes(tokenFixture.refresh_token));
});

test("unsafe client files are rejected before a browser process or target config is created", async () => {
  const f = await privateFixture();
  const linked = join(f.directory, "linked.json"), hard = join(f.directory, "hard.json");
  await chmod(f.clientJsonPath, 0o644);
  let starts = 0;
  const attempt = path => authorizeDrive({ configPath: f.configPath, clientJsonPath: path,
    startProcess: () => { starts++; throw new Error("must_not_launch"); } });
  await assert.rejects(attempt(f.clientJsonPath), /authorization_client_file_not_private/);
  await chmod(f.clientJsonPath, 0o600);
  await symlink(f.clientJsonPath, linked);
  await assert.rejects(attempt(linked), /authorization_client_file_not_private/);
  await link(f.clientJsonPath, hard);
  await assert.rejects(attempt(hard), /authorization_client_file_not_private/);
  assert.equal(starts, 0);
  await assert.rejects(stat(f.configPath), { code: "ENOENT" });
});

test("a dedicated client is required and an existing credential is never overwritten", async () => {
  const f = await privateFixture();
  await assert.rejects(authorizeDrive({ configPath: f.configPath }), /authorization_client_json_required/);
  await writeFile(f.configPath, "keep-existing-config", { mode: 0o600 });
  let starts = 0;
  await assert.rejects(authorizeDrive({ ...f, startProcess: () => { starts++; } }), { code: "EEXIST" });
  assert.equal(starts, 0);
  assert.equal(await readFile(f.configPath, "utf8"), "keep-existing-config");
});

test("native login failure and oversized output cannot create an accepted config", async () => {
  for (const [output, code, reason] of [[tokenOutput(), 3, "authorization_not_completed"],
    ["x".repeat(131073), 0, "authorization_output_too_large"]]) {
    const f = await privateFixture();
    await assert.rejects(authorizeDrive({ ...f, startProcess: fakeProcess({ output, code }) }),
      error => error.message === reason);
    assert.equal(await readFile(f.configPath, "utf8"), "");
  }
});
