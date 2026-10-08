/** Closed five-file Drive transport. Never claims snapshot/restore acceptance. */
import { constants } from "node:fs";
import { open, lstat, realpath, readdir, mkdir } from "node:fs/promises";
import { join, resolve, dirname, sep } from "node:path";
import { createHash } from "node:crypto";

export const portableDriveNames = Object.freeze([
  "database.dump.age", "manifest.json.age", "media.tar.gz.age", "runtime.tar.gz.age", "portable-point.json"
]);
export const portableDriveMime = name => name === "portable-point.json" ? "application/json" : "application/octet-stream";
const ciphertextNames = portableDriveNames.filter(name => name.endsWith(".age"));
const checksum = bytes => createHash("sha256").update(bytes).digest("hex");
const identifier = /^[a-zA-Z0-9_-]{1,200}$/;
const requireValue = (condition, reason) => { if (!condition) throw new Error(reason); };
function binding(value) {
  requireValue(/^[a-z0-9][a-z0-9-]{0,62}$/.test(value?.instanceId ?? "") &&
    /^\d{4}-(0[1-9]|1[0-2])$/.test(value.month ?? "") &&
    /^[a-f0-9]{32}$/.test(value.operationId ?? ""), "drive_point_binding_invalid");
  return { instanceId: value.instanceId, month: value.month, operationId: value.operationId };
}
async function privateDirectory(path) {
  const absolute = resolve(path), stat = await lstat(absolute);
  requireValue(await realpath(absolute) === absolute && stat.isDirectory() && stat.uid === process.getuid() &&
    (stat.mode & 0o777) === 0o700, "drive_directory_not_private");
  return absolute;
}
async function openPinned(path) {
  const absolute = resolve(path), file = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat({bigint:true});
    requireValue(stat.isFile() && stat.nlink === 1n && stat.uid === BigInt(process.getuid()) &&
      (stat.mode & 0o777n) === 0o600n && stat.size > 0n && stat.size <= 32n * 1024n ** 3n,
      "drive_payload_not_private");
    const named = await lstat(absolute, {bigint:true});
    requireValue(await realpath(absolute) === absolute && named.dev === stat.dev && named.ino === stat.ino,
      "drive_payload_replaced");
    return {file, stat, path:absolute};
  } catch(error) { await file.close(); throw error; }
}
async function unchanged(pinned) {
  const after = await pinned.file.stat({bigint:true}), named = await lstat(pinned.path, {bigint:true});
  requireValue(["dev", "ino", "size", "mtimeNs", "ctimeNs", "mode", "uid", "nlink"].every(key =>
    after[key] === pinned.stat[key] && named[key] === after[key]), "drive_payload_changed");
}
async function closedSet(directory) {
  await privateDirectory(directory);
  requireValue(JSON.stringify((await readdir(directory)).sort()) === JSON.stringify([...portableDriveNames].sort()),
    "drive_transport_set_invalid");
}
async function pinnedReceipt(pinned) {
  requireValue(pinned.stat.size <= 65536n, "drive_transport_receipt_oversized");
  const bytes = Buffer.alloc(Number(pinned.stat.size));
  const read = await pinned.file.read(bytes,0,bytes.length,0);
  requireValue(read.bytesRead === bytes.length, "drive_transport_receipt_changed");
  await unchanged(pinned);
  try { return JSON.parse(bytes.toString("utf8")); }
  catch { throw new Error("drive_transport_receipt_invalid"); }
}
async function hashes(pinned) {
  const sha = createHash("sha256"), md5 = createHash("md5");
  for await(const bytes of pinned.file.createReadStream({start:0, autoClose:false})) { sha.update(bytes); md5.update(bytes); }
  await unchanged(pinned);
  return {bytes:Number(pinned.stat.size), sha256:sha.digest("hex"), md5:md5.digest("hex")};
}

export async function inspectSealedDrivePoint(packageDirectory, expectedBinding) {
  const directory = await privateDirectory(packageDirectory), expected = binding(expectedBinding);
  await closedSet(directory);
  const files = {}, pinned = {};
  try {
    pinned["portable-point.json"] = await openPinned(join(directory,"portable-point.json"));
    const receipt = await pinnedReceipt(pinned["portable-point.json"]);
    requireValue(receipt?.schema === "yenhubs-portable-transport-v1" && receipt.state === "sealed-not-restore-accepted" &&
      Object.keys(receipt).sort().join() === "ciphertexts,instanceId,month,operationId,schema,state" &&
      Object.keys(expected).every(key => receipt[key] === expected[key]) &&
      JSON.stringify(Object.keys(receipt.ciphertexts ?? {}).sort()) === JSON.stringify([...ciphertextNames].sort()),
      "drive_transport_receipt_invalid");
    for(const name of portableDriveNames) {
      pinned[name] ??= await openPinned(join(directory, name));
      if(name.endsWith(".age")) {
        const header = Buffer.alloc(22); await pinned[name].file.read(header,0,header.length,0);
        requireValue(header.toString("ascii") === "age-encryption.org/v1\n", "drive_ciphertext_header_invalid");
      }
      files[name] = await hashes(pinned[name]);
      if(name.endsWith(".age")) requireValue(Object.keys(receipt.ciphertexts[name] ?? {}).sort().join() === "bytes,sha256" &&
        receipt.ciphertexts[name]?.sha256 === files[name].sha256 &&
        receipt.ciphertexts[name]?.bytes === files[name].bytes, "drive_ciphertext_mismatch");
    }
    await closedSet(directory);
    return {directory, binding:expected, files, pinned,
      sha256:checksum(JSON.stringify(Object.fromEntries(portableDriveNames.map(name => [name, files[name]])))),
      close:async () => { for(const value of Object.values(pinned)) await value.file.close(); }};
  } catch(error) { for(const value of Object.values(pinned)) await value.file.close(); throw error; }
}

function ownerOnly(value) {
  requireValue(value?.ownedByMe === true && value.trashed === false && value.permissions?.length === 1 &&
    value.permissions[0].type === "user" && value.permissions[0].role === "owner" && identifier.test(value.id ?? ""),
    "drive_remote_not_owner_only");
}
function pointProperties(expected) { return {kind:"yenhubs-monthly-portable-v1", ...expected}; }
function requirePointFolder(folder, rootId, expected, expectedId = folder?.id) {
  ownerOnly(folder);
  requireValue(folder.id === expectedId && folder.mimeType === "application/vnd.google-apps.folder" && folder.parents?.length === 1 &&
    folder.parents[0] === rootId && folder.name === `${expected.instanceId}-${expected.month}` &&
    Object.entries(pointProperties(expected)).every(([key,value]) => folder.appProperties?.[key] === value),
    "drive_remote_point_binding_changed");
}
async function journal(directory, expected) {
  const parent = await privateDirectory(dirname(resolve(directory)));
  requireValue(resolve(directory) !== parent, "drive_journal_invalid");
  await mkdir(resolve(directory),{mode:0o700});
  await privateDirectory(directory);
  const parentHandle = await open(parent,constants.O_RDONLY);
  try { await parentHandle.sync(); } finally { await parentHandle.close(); }
  const handle = await open(join(directory,"events.jsonl"),"wx",0o600);
  const dir = await open(directory,constants.O_RDONLY); let sequence=0;
  return {
    append:async value => { await handle.writeFile(JSON.stringify({...value,binding:expected,sequence:++sequence})+"\n"); await handle.sync(); await dir.sync(); },
    close:async () => { await handle.close(); await dir.close(); }
  };
}

async function verifyReadback({provider, folder, rootId, point, downloadDirectory}) {
  requirePointFolder(await provider.stat(folder.id),rootId,point.binding,folder.id);
  const list = await provider.children(folder.id);
  requireValue(Array.isArray(list) && list.length === portableDriveNames.length &&
    JSON.stringify(list.map(value => value.name).sort()) === JSON.stringify([...portableDriveNames].sort()) &&
    new Set(list.map(value => value.id)).size === list.length, "drive_remote_set_incomplete");
  await mkdir(downloadDirectory,{mode:0o700}); const handles = {}, versions = {};
  for(const name of portableDriveNames) {
    const item = list.find(value => value.name === name), expected = point.files[name];
    ownerOnly(item);
    requireValue(item.mimeType === portableDriveMime(name) && /^[1-9][0-9]*$/.test(String(item.version ?? "")) &&
      item.parents?.length === 1 && item.parents[0] === folder.id &&
      Number(item.size) === expected.bytes && item.md5Checksum === expected.md5,
      "drive_remote_file_binding_changed");
    const output = await open(join(downloadDirectory,name),"wx",0o600);
    const hash = createHash("sha256"); let size=0;
    try {
      // Provider returns a stream bound to the exact file ID, not a mutable name.
      for await(const bytes of await provider.content(item.id)) {
        size += bytes.length; requireValue(size <= expected.bytes, "drive_remote_payload_oversized");
        hash.update(bytes); await output.writeFile(bytes);
      }
      await output.sync();
    } finally { await output.close(); }
    requireValue(size === expected.bytes && hash.digest("hex") === expected.sha256, "drive_remote_bytes_mismatch");
    const after = await provider.stat(item.id); ownerOnly(after);
    requireValue(after.id === item.id && after.mimeType === item.mimeType && after.name === item.name && String(after.size) === String(item.size) &&
      after.md5Checksum === item.md5Checksum && JSON.stringify(after.parents) === JSON.stringify(item.parents) &&
      String(after.version) === String(item.version), "drive_remote_file_changed");
    await unchanged(point.pinned[name]); handles[name] = item.id; versions[name] = String(item.version);
  }
  const after = await provider.children(folder.id);
  requireValue(JSON.stringify(after.map(value => [value.id,value.name]).sort()) ===
    JSON.stringify(list.map(value => [value.id,value.name]).sort()), "drive_remote_set_changed");
  requirePointFolder(await provider.stat(folder.id),rootId,point.binding,folder.id);
  const sameMonth = await provider.namedChildren(rootId,folder.name);
  requireValue(sameMonth.length === 1 && sameMonth[0].id === folder.id, "drive_remote_month_ambiguous");
  await closedSet(point.directory);
  for(const file of Object.values(point.pinned)) await unchanged(file);
  return {handles, versions};
}

export async function publishSealedDrivePoint({packageDirectory, expectedBinding, rootFolderId, provider, journalDirectory}) {
  requireValue(identifier.test(rootFolderId ?? ""), "drive_root_invalid");
  const point = await inspectSealedDrivePoint(packageDirectory,expectedBinding);
  let events, failure;
  try {
    const journalPath = resolve(journalDirectory);
    requireValue(journalPath !== point.directory && !journalPath.startsWith(point.directory+sep),
      "drive_journal_inside_transport");
    events = await journal(journalDirectory,point.binding);
    const root = await provider.stat(rootFolderId); ownerOnly(root);
    requireValue(root.id === rootFolderId && root.mimeType === "application/vnd.google-apps.folder", "drive_root_invalid");
    const name = `${point.binding.instanceId}-${point.binding.month}`;
    const existing = await provider.namedChildren(rootFolderId,name);
    requireValue(Array.isArray(existing) && existing.length <= 1, "drive_remote_month_ambiguous");
    let folder;
    if(existing.length) {
      folder = existing[0]; requirePointFolder(folder,rootFolderId,point.binding);
      // Existing operation is reconciled ONLY by byte readback. Never retry
      // missing uploads, overwrite a file, or create a duplicate after a failure.
      await events.append({event:"existing-point-reconcile-only",folderId:folder.id});
    } else {
      await events.append({event:"folder-create-intent",rootFolderId,name,properties:pointProperties(point.binding)});
      folder = await provider.createFolder({parentId:rootFolderId,name,properties:pointProperties(point.binding)});
      requirePointFolder(folder,rootFolderId,point.binding);
      await events.append({event:"folder-create-returned",folderId:folder.id});
      requirePointFolder(await provider.stat(folder.id),rootFolderId,point.binding,folder.id);
      const uniqueness = await provider.namedChildren(rootFolderId,name);
      requireValue(uniqueness.length === 1 && uniqueness[0].id === folder.id, "drive_remote_month_ambiguous");
      requireValue((await provider.children(folder.id)).length === 0, "drive_new_folder_not_empty");
      for(const filename of portableDriveNames) {
        await unchanged(point.pinned[filename]);
        await events.append({event:"file-upload-intent",folderId:folder.id,filename,...point.files[filename]});
        await provider.put({folderId:folder.id,name:filename,source:point.pinned[filename],bytes:point.files[filename].bytes});
        await unchanged(point.pinned[filename]);
        await events.append({event:"file-upload-returned",filename});
      }
    }
    const {handles, versions} = await verifyReadback({provider,folder,rootId:rootFolderId,point,
      downloadDirectory:join(journalDirectory,"readback")});
    const rootAfter = await provider.stat(rootFolderId); ownerOnly(rootAfter);
    requireValue(rootAfter.id === rootFolderId && rootAfter.mimeType === root.mimeType, "drive_root_invalid");
    const result = {schema:"yenhubs-drive-point-readback-v1",state:"transport-verified-not-restore-accepted",
      ...point.binding,folderId:folder.id,sha256:point.sha256,files:point.files,handles,versions,reconciledExisting:existing.length===1};
    await events.append({event:"transport-verified",result});
    return result;
  } catch(error) {
    failure = error;
    if(events) {
      try { await events.append({event:"not-accepted",reason:/^drive_[a-z_]+$/.test(error.message)?error.message:"drive_transfer_failed_or_ambiguous"}); }
      catch { /* Keep the first failure even if recording the rejection fails. */ }
    }
    throw error;
  } finally {
    const cleanup = await Promise.allSettled([events?.close(),point.close()]);
    if(!failure) { const rejected = cleanup.find(value => value.status === "rejected"); if(rejected) throw rejected.reason; }
  }
}
