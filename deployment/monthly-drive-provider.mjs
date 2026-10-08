/** Dedicated drive.file adapter. Create-only uploads; no secret-bearing logs. */
import { readPrivateBytes, readPrivateSource } from "./monthly-snapshot-worker.mjs";

const id = /^[a-zA-Z0-9_-]{1,200}$/;
const fields = "id,name,mimeType,size,version,md5Checksum,parents,appProperties,ownedByMe,trashed,permissions(type,role)";
const requireValue = (condition, reason) => { if (!condition) throw new Error(reason); };
function requireId(value) { requireValue(id.test(value ?? ""), "drive_provider_id_invalid"); return value; }
function readIni(bytes, installed) {
  const text = bytes.toString("utf8");
  requireValue((text.match(/^\[/gm) ?? []).length === 1 && text.startsWith("[yenhubs-monthly]\n"),
    "drive_provider_config_invalid");
  const entries = text.trimEnd().split("\n").slice(1).map(line => /^(\w+) = (.*)$/.exec(line));
  requireValue(entries.every(Boolean) && new Set(entries.map(item => item[1])).size === entries.length,
    "drive_provider_config_invalid");
  const values = Object.fromEntries(entries.map(([,key,value]) => [key,value]));
  requireValue(Object.keys(values).sort().join() === "client_id,client_secret,scope,token,type" &&
    values.type === "drive" && values.scope === "drive.file" && values.client_id === installed.client_id &&
    values.client_secret === installed.client_secret, "drive_provider_scope_or_client_changed");
  let token;
  try { token = JSON.parse(values.token); } catch { throw new Error("drive_provider_token_invalid"); }
  requireValue(typeof token.refresh_token === "string" && token.refresh_token.length > 0,
    "drive_provider_token_invalid");
  return {clientId:values.client_id,clientSecret:values.client_secret,refreshToken:token.refresh_token};
}

export async function dedicatedDriveProvider({configPath, installedClientPath, expectedOwnerEmail,
  projectId = "yenhubs-backups-20261006", transferTimeoutMilliseconds = 3600000,
  fetchImpl = fetch}) {
  requireValue(typeof expectedOwnerEmail === "string" && /^[^\s@]+@[^\s@]+$/.test(expectedOwnerEmail) &&
    projectId === "yenhubs-backups-20261006" && Number.isSafeInteger(transferTimeoutMilliseconds) &&
    transferTimeoutMilliseconds >= 60000 && transferTimeoutMilliseconds <= 3600000,
    "drive_provider_options_invalid");
  let client;
  try { client = await readPrivateSource(installedClientPath,16384); }
  catch { throw new Error("drive_provider_client_unreadable"); }
  const installed = client.installed;
  requireValue(installed && !client.web && installed.project_id === projectId &&
    typeof installed.client_id === "string" && /^[a-zA-Z0-9_-]+\.apps\.googleusercontent\.com$/.test(installed.client_id) &&
    typeof installed.client_secret === "string" && installed.client_secret.length > 0 && !/[\r\n\0]/.test(installed.client_secret) &&
    installed.token_uri === "https://oauth2.googleapis.com/token", "drive_provider_client_invalid");
  let access = null, expiry = 0;
  async function request(url, options = {}) {
    let response;
    try { response = await fetchImpl(url,{...options,redirect:"error",signal:options.signal ?? AbortSignal.timeout(30000)}); }
    catch { throw new Error("drive_provider_request_failed_or_ambiguous"); }
    requireValue(response.ok, `drive_provider_http_${response.status}`);
    return response;
  }
  async function readJson(response) {
    const parts = []; let size = 0;
    requireValue(response.body, "drive_provider_response_invalid");
    try {
      for await(const part of response.body) {
        size += part.length; requireValue(size <= 1024*1024, "drive_provider_response_oversized"); parts.push(Buffer.from(part));
      }
    } catch(error) {
      if(error.message === "drive_provider_response_oversized") throw error;
      throw new Error("drive_provider_response_read_failed");
    }
    try { return JSON.parse(Buffer.concat(parts).toString("utf8")); }
    catch { throw new Error("drive_provider_response_invalid"); }
  }
  async function json(url, options = {}) { return readJson(await request(url,options)); }
  async function configuration() {
    let bytes;
    try { bytes = await readPrivateBytes(configPath,16384); return readIni(bytes,installed); }
    catch(error) {
      if(/^drive_provider_[a-z_]+$/.test(error.message)) throw error;
      throw new Error("drive_provider_config_unreadable");
    } finally { bytes?.fill(0); }
  }
  async function headers() {
    if(Date.now()+60000 >= expiry) {
      const credential = await configuration();
      const refreshed = await json(installed.token_uri,{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},
        body:new URLSearchParams({client_id:credential.clientId,client_secret:credential.clientSecret,
          refresh_token:credential.refreshToken,grant_type:"refresh_token"})});
      requireValue(refreshed.scope === "https://www.googleapis.com/auth/drive.file" && refreshed.token_type === "Bearer" &&
        typeof refreshed.access_token === "string" && refreshed.access_token.length > 0 &&
        !/[\r\n\0]/.test(refreshed.access_token) && Number.isSafeInteger(refreshed.expires_in) &&
        refreshed.expires_in > 60 && refreshed.expires_in <= 86400,
        "drive_provider_refresh_scope_invalid");
      access = refreshed.access_token; expiry = Date.now()+refreshed.expires_in*1000;
    }
    return {authorization:`Bearer ${access}`};
  }
  async function stat(fileId) {
    const value = await json(`https://www.googleapis.com/drive/v3/files/${requireId(fileId)}?fields=${fields}`,{headers:await headers()});
    requireValue(value?.id === fileId, "drive_provider_id_changed");
    return value;
  }
  async function list(parentId, name = null) {
    const url = new URL("https://www.googleapis.com/drive/v3/files");
    requireId(parentId);
    requireValue(name === null || /^[a-z0-9-]{1,80}$/.test(name), "drive_provider_name_invalid");
    url.searchParams.set("q",`'${parentId}' in parents and trashed = false${name === null ? "" : ` and name = '${name}'`}`);
    url.searchParams.set("fields",`nextPageToken,files(${fields})`); url.searchParams.set("pageSize","1000");
    const result = await json(url,{headers:await headers()});
    requireValue(!result.nextPageToken && Array.isArray(result.files), "drive_provider_listing_ambiguous");
    return result.files;
  }
  const owner = await json("https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)",{headers:await headers()});
  requireValue(owner.user?.emailAddress === expectedOwnerEmail, "drive_provider_owner_mismatch");
  return {
    stat,
    children:parentId => list(parentId),
    namedChildren:(parentId,name) => list(parentId,name),
    async createFolder({parentId,name,properties}) {
      requireId(parentId);
      requireValue(/^[a-z0-9-]{1,80}$/.test(name), "drive_provider_name_invalid");
      requireValue(properties?.kind === "yenhubs-monthly-portable-v1" &&
        /^[a-z0-9][a-z0-9-]{0,62}$/.test(properties.instanceId ?? "") &&
        /^\d{4}-(0[1-9]|1[0-2])$/.test(properties.month ?? "") &&
        /^[a-f0-9]{32}$/.test(properties.operationId ?? "") &&
        Object.keys(properties).sort().join() === "instanceId,kind,month,operationId" &&
        name === `${properties.instanceId}-${properties.month}`, "drive_provider_properties_invalid");
      // One POST only. Its caller fsyncs intent before invoking this method.
      return json(`https://www.googleapis.com/drive/v3/files?fields=${fields}`,{method:"POST",
        headers:{...await headers(),"content-type":"application/json"},
        body:JSON.stringify({name,mimeType:"application/vnd.google-apps.folder",parents:[parentId],appProperties:properties})});
    },
    async put({folderId,name,source,bytes}) {
      requireId(folderId);
      requireValue(["database.dump.age","media.tar.gz.age","runtime.tar.gz.age","manifest.json.age","portable-point.json"].includes(name) &&
        Number.isSafeInteger(bytes) && bytes > 0 && bytes <= 32*1024**3 && source?.file &&
        typeof source.file.read === "function", "drive_provider_upload_invalid");
      const before = await source.file.stat({bigint:true});
      requireValue(before.isFile() && before.size === BigInt(bytes) && before.nlink === 1n &&
        before.uid === BigInt(process.getuid()) && (before.mode & 0o777n) === 0o600n,
        "drive_provider_upload_source_changed");
      await configuration();
      // files.create POST + PUT to its NEW resumable session, never files.update
      // or rcat's overwrite-by-name path. One request each; no blind retries.
      const uploadHeaders = await headers();
      const session = await request(`https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=${fields}`,{
        method:"POST",headers:{...uploadHeaders,"content-type":"application/json; charset=UTF-8",
          "x-upload-content-type":"application/octet-stream","x-upload-content-length":String(bytes)},
        body:JSON.stringify({name,mimeType:"application/octet-stream",parents:[folderId]})});
      let location;
      try { location = new URL(session.headers.get("location")); }
      catch { throw new Error("drive_provider_upload_location_invalid"); }
      requireValue(location.origin === "https://www.googleapis.com" && location.pathname === "/upload/drive/v3/files" &&
        !location.username && !location.password && !location.hash && location.searchParams.get("upload_id") &&
        (!location.searchParams.has("uploadType") || location.searchParams.get("uploadType") === "resumable"),
        "drive_provider_upload_location_invalid");
      let sent=0;
      const payload = (async function*() {
        // Positioned reads keep the caller's pinned descriptor alive on EOF,
        // abort and HTTP failure; destroying a Node ReadStream closes its fd.
        while(sent < bytes) {
          const part = Buffer.alloc(Math.min(1024*1024,bytes-sent));
          const value = await source.file.read(part,0,part.length,sent);
          requireValue(value.bytesRead > 0, "drive_provider_upload_size_changed");
          sent += value.bytesRead; yield part.subarray(0,value.bytesRead);
        }
        requireValue(sent === bytes, "drive_provider_upload_size_changed");
      })();
      const result = await json(location.href,{method:"PUT",duplex:"half",headers:{...uploadHeaders,
        "content-type":"application/octet-stream","content-length":String(bytes)},body:payload,
        signal:AbortSignal.timeout(transferTimeoutMilliseconds)});
      const after = await source.file.stat({bigint:true});
      requireValue(["dev","ino","size","uid","mode","nlink","mtimeNs","ctimeNs"].every(key=>before[key]===after[key]),
        "drive_provider_upload_source_changed");
      requireValue(sent === bytes && id.test(result?.id ?? "") && result.name === name &&
        result.mimeType === "application/octet-stream" && result.parents?.length === 1 &&
        result.parents[0] === folderId && Number(result.size) === bytes, "drive_provider_upload_binding_changed");
      return {id:result.id,httpStatus:200,bytes:sent};
    },
    async content(fileId) {
      let response;
      try { response = await fetchImpl(`https://www.googleapis.com/drive/v3/files/${requireId(fileId)}?alt=media`,{
        headers:await headers(),redirect:"error",signal:AbortSignal.timeout(transferTimeoutMilliseconds)}); }
      catch { throw new Error("drive_provider_download_failed"); }
      requireValue(response.ok && response.body, "drive_provider_download_failed");
      return response.body;
    }
  };
}
