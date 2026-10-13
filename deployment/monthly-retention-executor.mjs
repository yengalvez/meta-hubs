/** Execute the owner's two/ten retention policy, never accept a caller's deletion list. */
import { createHash } from "node:crypto";
import { planMonthlyRetention } from "./monthly-backup-retention.mjs";
import { claimPairJournal, nativeSnapshotProvider, validateNativeSnapshot, nativeSnapshotIdentity } from "./monthly-snapshot-pair.mjs";
import { portableDriveNames, portableDriveMime } from "./monthly-drive-store.mjs";
import { runExportNative } from "./monthly-snapshot-export-provider.mjs";

const requireValue = (value, reason) => { if (!value) throw new Error(reason); };
const canonical = value => JSON.stringify(value, (_, item) => item && !Array.isArray(item) && typeof item === "object" ?
  Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const id = /^[a-zA-Z0-9_-]{1,200}$/;
const snapshotId = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$|^[1-9][0-9]*$/;
const roles = ["database", "media"];

function requireRecord(point) {
  requireValue(point?.schema === "yenhubs-monthly-retention-record-v1" &&
    /^[a-z0-9][a-z0-9-]{0,62}$/.test(point.instanceId ?? "") && /^\d{4}-(0[1-9]|1[0-2])$/.test(point.month ?? "") &&
    /^[a-f0-9]{32}$/.test(point.operationId ?? ""), "retention_record_invalid");
  const receipt = point.googleDrive?.receipt;
  if (point.googleDrive?.status === "verified") {
    requireValue(receipt?.schema === "yenhubs-drive-point-readback-v1" && receipt.state === "transport-verified-not-restore-accepted" &&
      ["instanceId", "month", "operationId"].every(key => receipt[key] === point[key]) &&
      id.test(receipt.folderId ?? "") && point.googleDrive.fileId === receipt.folderId &&
      /^[a-f0-9]{64}$/.test(receipt.sha256 ?? "") && point.googleDrive.sha256 === receipt.sha256 &&
      [receipt.files,receipt.handles,receipt.versions].every(value => value &&
        Object.keys(value).sort().join() === [...portableDriveNames].sort().join()) &&
      new Set(Object.values(receipt.handles)).size === portableDriveNames.length &&
      portableDriveNames.every(name => id.test(receipt.handles[name] ?? "") &&
        /^[1-9][0-9]*$/.test(receipt.versions[name] ?? "") &&
        Number.isSafeInteger(receipt.files[name]?.bytes) && receipt.files[name].bytes > 0 &&
        /^[a-f0-9]{64}$/.test(receipt.files[name].sha256 ?? "") && /^[a-f0-9]{32}$/.test(receipt.files[name].md5 ?? "")) &&
      receipt.sha256 === sha(JSON.stringify(Object.fromEntries(portableDriveNames.map(name => [name,receipt.files[name]])))),
      "retention_drive_receipt_invalid");
  }
  if (point.digitalOcean?.status === "complete") {
    const pair = point.digitalOcean.pair;
    requireValue(pair?.schema === "yenhubs-native-monthly-pair-v1" && pair.state === "captured-not-restore-accepted" &&
      ["instanceId", "month", "operationId"].every(key => pair[key] === point[key]) &&
      /^[a-f0-9]{64}$/.test(point.nativeManifestSha256 ?? "") &&
      roles.every(role => snapshotId.test(pair.snapshots?.[role]?.id ?? "") &&
        pair.snapshots[role].name === `${point.instanceId}-${point.month}-${role}` &&
        point.digitalOcean[role+"Id"] === pair.snapshots[role].id) &&
      pair.snapshots.database.id !== pair.snapshots.media.id, "retention_pair_record_invalid");
  }
  return point;
}

/** Derive this record only from the producer/readback receipts, not UI labels. */
export function monthlyRetentionRecord({point,exportReceipt,driveReceipt}) {
  requireValue(exportReceipt?.state === "sealed-not-restore-accepted" && exportReceipt.nativeExportExitCode === 0 &&
    exportReceipt.cloneCleanupVerified === true && exportReceipt.nativeManifestSha256 === point.manifestSha256 &&
    ["instanceId", "month", "operationId"].every(key => exportReceipt.binding?.[key] === point.pair[key]) &&
    exportReceipt.ciphertexts && Object.keys(exportReceipt.ciphertexts).sort().join() ===
      portableDriveNames.filter(name=>name.endsWith(".age")).sort().join() &&
    portableDriveNames.filter(name=>name.endsWith(".age")).every(name=>
      exportReceipt.ciphertexts[name]?.sha256 === driveReceipt?.files?.[name]?.sha256 &&
      exportReceipt.ciphertexts[name]?.bytes === driveReceipt?.files?.[name]?.bytes),
    "retention_export_receipt_invalid");
  return requireRecord({schema:"yenhubs-monthly-retention-record-v1",instanceId:point.pair.instanceId,
    month:point.pair.month,operationId:point.pair.operationId,nativeManifestSha256:point.manifestSha256,
    digitalOcean:{status:"complete",databaseId:point.pair.snapshots.database.id,mediaId:point.pair.snapshots.media.id,
      pair:structuredClone(point.pair)},
    googleDrive:{status:"verified",fileId:driveReceipt.folderId,sha256:driveReceipt.sha256,receipt:structuredClone(driveReceipt)}});
}

function ownerOnly(item) {
  requireValue(item?.ownedByMe === true && item.trashed === false && item.permissions?.length === 1 &&
    item.permissions[0].type === "user" && item.permissions[0].role === "owner", "retention_drive_owner_changed");
}
export async function verifyRetentionDriveMetadata(point, rootId, provider, allowedNames = portableDriveNames) {
  requireRecord(point); requireValue(point.googleDrive.status === "verified" && id.test(rootId), "retention_drive_not_verified");
  const receipt = point.googleDrive.receipt, folder = await provider.stat(receipt.folderId);
  ownerOnly(folder);
  requireValue(folder.id === receipt.folderId && folder.name === `${point.instanceId}-${point.month}` &&
    folder.mimeType === "application/vnd.google-apps.folder" && folder.parents?.length === 1 && folder.parents[0] === rootId &&
    folder.appProperties?.kind === "yenhubs-monthly-portable-v1" &&
    ["instanceId", "month", "operationId"].every(key => folder.appProperties[key] === point[key]), "retention_drive_folder_changed");
  const unique = await provider.namedChildren(rootId,folder.name);
  requireValue(unique.length === 1 && unique[0].id === folder.id, "retention_drive_month_ambiguous");
  const files = await provider.children(folder.id);
  requireValue(Array.isArray(files) && files.length === allowedNames.length && new Set(files.map(f=>f.id)).size === files.length &&
    files.map(f=>f.name).sort().join() === [...allowedNames].sort().join(), "retention_drive_set_changed");
  for (const file of files) {
    const expected = receipt.files[file.name]; ownerOnly(file);
    requireValue(file.id === receipt.handles[file.name] && file.parents?.length === 1 && file.parents[0] === folder.id &&
      file.mimeType === portableDriveMime(file.name) && String(file.version) === receipt.versions[file.name] &&
      Number(file.size) === expected.bytes && file.md5Checksum === expected.md5, "retention_drive_file_changed");
  }
}

export async function verifyRetentionPair(point, snapshots) {
  requireRecord(point); requireValue(point.digitalOcean.status === "complete", "retention_pair_not_complete");
  const pair = point.digitalOcean.pair;
  for (const role of roles) {
    const expected = pair.snapshots[role];
    const observed = validateNativeSnapshot(await snapshots.get(expected.id), {name:expected.name,volumeId:expected.volumeId,
      region:expected.region,since:Date.parse(pair.startedAt),until:Date.parse(pair.capturedAt)});
    requireValue(canonical(nativeSnapshotIdentity(observed)) === canonical(nativeSnapshotIdentity({...expected,
      createdAt:new Date(expected.createdAt).toISOString()})),
      "retention_snapshot_changed");
  }
}

export function nativeRetentionSnapshots({snapshots = nativeSnapshotProvider(),run = runExportNative} = {}) {
  return {...snapshots, async remove(snapshot) {
    requireValue(snapshotId.test(snapshot?.id ?? ""), "retention_snapshot_id_invalid");
    const observed = await snapshots.get(snapshot.id);
    requireValue(observed.id === snapshot.id && observed.resource_type === "volume" && observed.resource_id === snapshot.volumeId &&
      observed.name === snapshot.name && new Date(observed.created_at).toISOString() === new Date(snapshot.createdAt).toISOString() &&
      observed.min_disk_size === snapshot.minimumDiskGiB && typeof observed.size_gigabytes === "number" &&
      Number.isFinite(observed.size_gigabytes) && observed.size_gigabytes >= 0 &&
      observed.regions?.includes(snapshot.region), "retention_snapshot_changed");
    // Native UUID deletion only, one request, no retry and no arbitrary volume deletion.
    const result = await run("doctl",["compute","snapshot","delete",snapshot.id,"--force","--http-retry-max","0"]);
    requireValue(result.nativeExitCode === 0, "retention_snapshot_delete_failed_or_ambiguous");
    const after = await snapshots.list();
    requireValue(Array.isArray(after) && !after.some(item => item.id === snapshot.id), "retention_snapshot_still_present");
    return {nativeExitCode:0,id:snapshot.id,absenceVerified:true};
  }};
}

export async function executeMonthlyRetention({instanceId,month,operationId,points,rootFolderId,drive,snapshots,journalDirectory}) {
  requireValue(Array.isArray(points) && typeof drive?.trashVerifiedFile === "function" && typeof snapshots?.remove === "function",
    "retention_arguments_invalid");
  const own = points.filter(point=>point?.instanceId===instanceId).map(requireRecord);
  requireValue(!own.some(point=>point.month===month && point.operationId!==operationId), "retention_current_operation_changed");
  // A cross-month reused ID must never let a retirement delete a retained point.
  const remoteIds = own.flatMap(point=>[
    ...(point.digitalOcean?.status==="complete" ? roles.map(role=>point.digitalOcean.pair.snapshots[role].id) : []),
    ...(point.googleDrive?.status==="verified" ? [point.googleDrive.fileId,...Object.values(point.googleDrive.receipt.handles)] : [])
  ]);
  requireValue(new Set(remoteIds).size === remoteIds.length, "retention_remote_id_reused");
  const plan = planMonthlyRetention({instanceId,month,points:own});
  if (!plan.readyToRotate) return {schema:"yenhubs-monthly-retention-result-v1",state:"blocked-no-retirements",instanceId,month,operationId,plan};
  const byMonth = value=>own.find(point=>point.month===value);
  const journal = await claimPairJournal(journalDirectory,{instanceId,month,operationId});
  const retired = {digitalOcean:[],googleDrive:[]};
  async function keepers() {
    const root = await drive.stat(rootFolderId); ownerOnly(root);
    requireValue(root.id===rootFolderId && root.mimeType==="application/vnd.google-apps.folder", "retention_drive_root_changed");
    for (const value of plan.keepDigitalOcean) await verifyRetentionPair(byMonth(value),snapshots);
    for (const value of plan.keepGoogleDrive) await verifyRetentionDriveMetadata(byMonth(value),rootFolderId,drive);
  }
  try {
    await keepers();
    await journal.append({event:"rotation-preflight-complete",plan});
    for (const value of plan.retireDigitalOcean) {
      const point = byMonth(value); await verifyRetentionDriveMetadata(point,rootFolderId,drive);
      await verifyRetentionPair(point,snapshots);
      for (const role of roles) {
        await keepers(); await verifyRetentionDriveMetadata(point,rootFolderId,drive);
        const snapshot = point.digitalOcean.pair.snapshots[role];
        await journal.append({event:"snapshot-retirement-intent",targetMonth:value,role,id:snapshot.id});
        const result = await snapshots.remove(snapshot);
        requireValue(result.nativeExitCode===0 && result.id===snapshot.id && result.absenceVerified===true,
          "retention_snapshot_delete_failed_or_ambiguous");
        await journal.append({event:"snapshot-retirement-returned",targetMonth:value,role,result});
      }
      retired.digitalOcean.push(value);
    }
    for (const value of plan.retireGoogleDrive) {
      const point = byMonth(value), receipt=point.googleDrive.receipt;
      const remaining=[...portableDriveNames];
      await verifyRetentionDriveMetadata(point,rootFolderId,drive);
      for (const name of portableDriveNames) {
        await keepers(); await verifyRetentionDriveMetadata(point,rootFolderId,drive,remaining);
        const expected={id:receipt.handles[name],folderId:receipt.folderId,name,version:receipt.versions[name],...receipt.files[name]};
        await journal.append({event:"drive-retirement-intent",targetMonth:value,name,fileId:expected.id});
        const result=await drive.trashVerifiedFile(expected);
        requireValue(result.nativeHttpStatus===200 && result.fileId===expected.id && result.trashed===true,
          "retention_drive_trash_failed_or_ambiguous");
        remaining.splice(remaining.indexOf(name),1);
        await journal.append({event:"drive-retirement-returned",targetMonth:value,name,result});
      }
      // Leave the empty folder: never cascade-trash a folder which an owner might reuse.
      await verifyRetentionDriveMetadata(point,rootFolderId,drive,[]);
      retired.googleDrive.push(value);
    }
    await keepers();
    const result={schema:"yenhubs-monthly-retention-result-v1",state:"rotation-complete",instanceId,month,operationId,plan,retired};
    await journal.append({event:"rotation-complete",result}); return result;
  } catch(error) {
    const reason=/^retention_[a-z_]+$/.test(error.message) ? error.message : "retention_failed_or_ambiguous";
    try { await journal.append({event:"rotation-incomplete",reason,retired}); } catch {}
    throw new Error(reason);
  } finally { await journal.close(); }
}
