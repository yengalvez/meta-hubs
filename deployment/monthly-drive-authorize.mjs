/** Owner-operated, least-scope Drive authorization. Never prints OAuth tokens. */
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { open, lstat, realpath } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { pathToFileURL } from "node:url";

export function extractDriveToken(output) {
  if (Buffer.byteLength(output) > 131072) throw new Error("authorization_output_too_large");
  const start = output.indexOf("Paste the following into your remote machine");
  const end = output.indexOf("<---End paste", start);
  if (start < 0 || end < start) throw new Error("authorization_token_missing");
  const body = output.slice(start, end);
  const marker = body.indexOf("--->");
  const payload = body.slice(marker + 4).trim();
  let token;
  try {
    if (payload.startsWith("{")) token = JSON.parse(payload);
    else {
      // A supplied rclone config blob also produces a raw-standard-base64
      // config map, not a literal token JSON. Match the installed CLI format.
      if (!/^[A-Za-z0-9+/]+$/.test(payload)) throw new Error("invalid_blob");
      const decoded = Buffer.from(payload, "base64");
      if (decoded.toString("base64").replace(/=+$/, "") !== payload) throw new Error("invalid_blob");
      const map = JSON.parse(decoded.toString("utf8"));
      token = JSON.parse(map.token);
    }
  }
  catch { throw new Error("authorization_token_invalid"); }
  if (!token || typeof token.access_token !== "string" || !token.access_token ||
      typeof token.refresh_token !== "string" || !token.refresh_token ||
      token.token_type !== "Bearer" || !Number.isFinite(Date.parse(token.expiry))) {
    throw new Error("authorization_token_invalid");
  }
  return { access_token: token.access_token, token_type: token.token_type,
    refresh_token: token.refresh_token, expiry: token.expiry };
}

export function authorizationLink(output) {
  return output.match(/http:\/\/127\.0\.0\.1:\d+\/auth\?state=[A-Za-z0-9_-]+/)?.[0] ?? null;
}

export function parseDedicatedDriveClient(value) {
  const client = value?.installed;
  if (!client || value.web || client.project_id !== "yenhubs-backups-20261006" ||
      typeof client.client_id !== "string" || typeof client.client_secret !== "string" ||
      !/^[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/.test(client.client_id ?? "") ||
      !/^[A-Za-z0-9_-]{8,4096}$/.test(client.client_secret ?? "") ||
      !["https://accounts.google.com/o/oauth2/auth", "https://accounts.google.com/o/oauth2/v2/auth"].includes(client.auth_uri) ||
      client.token_uri !== "https://oauth2.googleapis.com/token" ||
      !Array.isArray(client.redirect_uris) || !client.redirect_uris.includes("http://localhost")) {
    throw new Error("authorization_client_json_invalid");
  }
  return { clientId: client.client_id, clientSecret: client.client_secret, projectId: client.project_id };
}

async function readDedicatedDriveClient(clientJsonPath) {
  const path = resolve(clientJsonPath);
  if (await realpath(path) !== path) throw new Error("authorization_client_file_not_private");
  const before = await lstat(path);
  if (!before.isFile() || before.uid !== process.getuid() || before.nlink !== 1 ||
      (before.mode & 0o777) !== 0o600 || before.size < 1 || before.size > 16384) {
    throw new Error("authorization_client_file_not_private");
  }
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes;
  try {
    const opened = await file.stat();
    if (opened.dev !== before.dev || opened.ino !== before.ino) throw new Error("authorization_client_file_changed");
    bytes = await file.readFile();
    const after = await file.stat(), named = await lstat(path);
    if (bytes.length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs ||
        after.ctimeMs !== before.ctimeMs || named.dev !== before.dev || named.ino !== before.ino) {
      throw new Error("authorization_client_file_changed");
    }
    let value;
    try { value = JSON.parse(bytes.toString("utf8")); }
    catch { throw new Error("authorization_client_json_invalid"); }
    return parseDedicatedDriveClient(value);
  } finally { bytes?.fill(0); await file.close(); }
}

export function dedicatedAuthorizationSpec(client, inherited = process.env) {
  // Remove every inherited rclone override, including scope/token/service-account
  // settings. Real credentials travel only through the private child environment,
  // never the config blob/argv, shell or public result. Do not read global config.
  const env = Object.fromEntries(Object.entries(inherited).filter(([key, value]) =>
    !key.startsWith("RCLONE_") && typeof value === "string"));
  Object.assign(env, { RCLONE_CONFIG: "/dev/null", RCLONE_DRIVE_SCOPE: "drive.file",
    RCLONE_DRIVE_CLIENT_ID: client.clientId, RCLONE_DRIVE_CLIENT_SECRET: client.clientSecret });
  const options = Buffer.from(JSON.stringify({ scope: "drive.file" })).toString("base64").replace(/=+$/, "");
  return { args: ["authorize", "drive", options, "--auth-no-open-browser", "--config", "/dev/null"], env };
}

export async function authorizeDrive({ configPath, clientJsonPath, onLink = () => {}, startProcess = spawn }) {
  if (typeof clientJsonPath !== "string" || !clientJsonPath) throw new Error("authorization_client_json_required");
  const client = await readDedicatedDriveClient(clientJsonPath);
  const destination = resolve(configPath);
  const parent = dirname(destination);
  if (await realpath(parent) !== parent) throw new Error("authorization_parent_linked");
  const stat = await lstat(parent);
  if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o077)) {
    throw new Error("authorization_parent_not_private");
  }
  // Claim a dedicated configuration before the browser flow; never overwrite
  // the owner's global rclone configuration or an earlier authorization.
  const target = await open(destination, "wx", 0o600);
  let output = "";
  let reported = false;
  let exceeded = false;
  let timeout;
  try {
    const spec = dedicatedAuthorizationSpec(client);
    const child = startProcess("rclone", spec.args, { env: spec.env, stdio: ["ignore", "pipe", "pipe"] });
    const capture = bytes => {
      if (exceeded) return;
      output += bytes.toString("utf8");
      if (Buffer.byteLength(output) > 131072) {
        exceeded = true; output = ""; child.kill("SIGTERM"); return;
      }
      const link = authorizationLink(output);
      if (!reported && link) { reported = true; onLink(link); }
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    // Deadline for this owner-login process only, never production monitors.
    timeout = setTimeout(() => child.kill("SIGTERM"), 15 * 60 * 1000);
    const code = await new Promise((accept, reject) => {
      child.once("error", () => reject(new Error("authorization_process_failed")));
      child.once("close", accept);
    });
    if (exceeded) throw new Error("authorization_output_too_large");
    if (code !== 0) throw new Error("authorization_not_completed");
    const token = extractDriveToken(output);
    await target.writeFile(`[yenhubs-monthly]\ntype = drive\nscope = drive.file\n` +
      `client_id = ${client.clientId}\nclient_secret = ${client.clientSecret}\ntoken = ${JSON.stringify(token)}\n`);
    await target.sync();
    return { status: "AUTHORIZED", scope: "drive.file", configPath: destination,
      clientType: "dedicated", projectId: client.projectId, unattendedAccessVerified: false };
  } finally {
    clearTimeout(timeout);
    output = "";
    await target.close();
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv.length !== 6 || process.argv[2] !== "--config" || process.argv[4] !== "--client-json") {
    console.error("Usage: node monthly-drive-authorize.mjs --config NEW_PRIVATE_CONFIG_PATH --client-json PRIVATE_INSTALLED_CLIENT_JSON");
    process.exitCode = 2;
  } else {
    try {
      const result = await authorizeDrive({ configPath: process.argv[3], clientJsonPath: process.argv[5],
        onLink: url => console.log(JSON.stringify({ status: "OWNER_LOGIN_REQUIRED", url,
          scope: "drive.file", note: "Only files created or selected for this app; no all-Drive scope." })) });
      console.log(JSON.stringify(result));
    } catch (error) {
      const allowed = ["authorization_parent_linked", "authorization_parent_not_private",
        "authorization_output_too_large", "authorization_token_missing", "authorization_token_invalid",
        "authorization_process_failed", "authorization_not_completed", "authorization_client_json_required",
        "authorization_client_json_invalid", "authorization_client_file_not_private", "authorization_client_file_changed"];
      console.error(JSON.stringify({ status: "NOT_AUTHORIZED",
        reason: allowed.includes(error.message) ? error.message : "authorization_local_io_failed" }));
      process.exitCode = 1;
    }
  }
}
