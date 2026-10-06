/** Owner-operated, least-scope Drive authorization. Never prints OAuth tokens. */
import { spawn } from "node:child_process";
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

export async function authorizeDrive({ configPath, onLink }) {
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
  const options = Buffer.from(JSON.stringify({ scope: "drive.file" })).toString("base64").replace(/=+$/, "");
  const child = spawn("rclone", ["authorize", "drive", options, "--auth-no-open-browser"],
    { stdio: ["ignore", "pipe", "pipe"] });
  const capture = bytes => {
    output += bytes.toString("utf8");
    if (Buffer.byteLength(output) > 131072) {
      exceeded = true;
      output = "";
      child.kill("SIGTERM");
      return;
    }
    const link = authorizationLink(output);
    if (!reported && link) { reported = true; onLink(link); }
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  // This deadline applies only to this owner-login process, never production
  // monitors or backup capture. A timeout does not count as authorization.
  const timeout = setTimeout(() => child.kill("SIGTERM"), 15 * 60 * 1000);
  try {
    const code = await new Promise((accept, reject) => {
      child.once("error", () => reject(new Error("authorization_process_failed")));
      child.once("close", accept);
    });
    if (exceeded) throw new Error("authorization_output_too_large");
    if (code !== 0) throw new Error("authorization_not_completed");
    const token = extractDriveToken(output);
    await target.writeFile(`[yenhubs-monthly]\ntype = drive\nscope = drive.file\ntoken = ${JSON.stringify(token)}\n`);
    await target.sync();
    return { status: "AUTHORIZED", scope: "drive.file", configPath: destination,
      unattendedAccessVerified: false };
  } finally {
    clearTimeout(timeout);
    output = "";
    await target.close();
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv.length !== 4 || process.argv[2] !== "--config") {
    console.error("Usage: node monthly-drive-authorize.mjs --config NEW_PRIVATE_CONFIG_PATH");
    process.exitCode = 2;
  } else {
    try {
      const result = await authorizeDrive({ configPath: process.argv[3],
        onLink: url => console.log(JSON.stringify({ status: "OWNER_LOGIN_REQUIRED", url,
          scope: "drive.file", note: "Only files created or selected for this app; no all-Drive scope." })) });
      console.log(JSON.stringify(result));
    } catch (error) {
      const allowed = ["authorization_parent_linked", "authorization_parent_not_private",
        "authorization_output_too_large", "authorization_token_missing", "authorization_token_invalid",
        "authorization_process_failed", "authorization_not_completed"];
      console.error(JSON.stringify({ status: "NOT_AUTHORIZED",
        reason: allowed.includes(error.message) ? error.message : "authorization_local_io_failed" }));
      process.exitCode = 1;
    }
  }
}
