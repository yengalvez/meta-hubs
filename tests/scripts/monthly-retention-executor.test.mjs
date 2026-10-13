import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { portableDriveNames, portableDriveMime } from "../../deployment/monthly-drive-store.mjs";
import { executeMonthlyRetention, monthlyRetentionRecord, nativeRetentionSnapshots } from "../../deployment/monthly-retention-executor.mjs";

const instanceId="fixture-monthly", operationId="a".repeat(32), digest="b".repeat(64), region="ams3";
const hash=(value,algorithm="sha256")=>createHash(algorithm).update(value).digest("hex");
const owner=(id,name,mimeType,parent)=>({id,name,mimeType,parents:parent?[parent]:[],ownedByMe:true,trashed:false,
  permissions:[{type:"user",role:"owner"}],version:"1"});
function record(month) {
  const pair={schema:"yenhubs-native-monthly-pair-v1",state:"captured-not-restore-accepted",instanceId,month,operationId,
    startedAt:month+"-01T00:00:00Z",capturedAt:month+"-01T00:00:05Z",snapshots:{}};
  for (const role of ["database","media"]) pair.snapshots[role]={id:`${role==="database"?1:2}${month.replace("-","")}`,
    name:`${instanceId}-${month}-${role}`,volumeId:role+"-volume-fixture",region,
    createdAt:month+"-01T00:00:02.000Z",minimumDiskGiB:10,billableGiB:1};
  const files={},handles={},versions={};
  for (const name of portableDriveNames) {
    const data=`fixture-${month}-${name}`;
    files[name]={bytes:Buffer.byteLength(data),sha256:hash(data),md5:hash(data,"md5")};
    handles[name]=`${month.replace("-","")}-${name.replaceAll(".","-")}`;versions[name]="1";
  }
  const driveReceipt={schema:"yenhubs-drive-point-readback-v1",state:"transport-verified-not-restore-accepted",instanceId,month,operationId,
    folderId:`folder-${month}`,files,handles,versions,sha256:hash(JSON.stringify(files))};
  return monthlyRetentionRecord({point:{pair,manifestSha256:digest},exportReceipt:{state:"sealed-not-restore-accepted",
    nativeExportExitCode:0,cloneCleanupVerified:true,nativeManifestSha256:digest,binding:{instanceId,month,operationId},
    ciphertexts:Object.fromEntries(portableDriveNames.filter(name=>name.endsWith(".age")).map(name=>[name,
      {bytes:files[name].bytes,sha256:files[name].sha256}]))},driveReceipt});
}
async function fixture(months) {
  const root=await realpath(await mkdtemp(join(tmpdir(),"yenhubs-retention-fixture-"))),points=months.map(record);
  const snapshotMap=new Map(),fileMap=new Map(),folders=new Map(),calls=[],controls={};
  for (const point of points) {
    for (const s of Object.values(point.digitalOcean.pair.snapshots)) snapshotMap.set(s.id,{id:s.id,name:s.name,
      resource_type:"volume",resource_id:s.volumeId,regions:[s.region],created_at:s.createdAt,min_disk_size:s.minimumDiskGiB,
      size_gigabytes:s.billableGiB});
    const r=point.googleDrive.receipt;
    folders.set(r.folderId,{...owner(r.folderId,`${instanceId}-${point.month}`,"application/vnd.google-apps.folder","root"),
      appProperties:{kind:"yenhubs-monthly-portable-v1",instanceId,month:point.month,operationId}});
    for (const name of portableDriveNames) fileMap.set(r.handles[name],{...owner(r.handles[name],name,portableDriveMime(name),r.folderId),
      size:String(r.files[name].bytes),md5Checksum:r.files[name].md5,capabilities:{canTrash:true}});
  }
  const drive={
    async stat(id) {const value=id==="root"?owner("root","only-fixture-root","application/vnd.google-apps.folder"):folders.get(id)||fileMap.get(id);
      if (!value) throw Error("fixture_not_found");return structuredClone(value);},
    async namedChildren(parent,name) {return [...folders.values()].filter(f=>f.parents[0]===parent && f.name===name).map(f=>structuredClone(f));},
    async children(parent) {return [...fileMap.values()].filter(f=>f.parents[0]===parent && !f.trashed).map(f=>structuredClone(f));},
    async trashVerifiedFile(expected) {
      calls.push({kind:"trash",id:expected.id});if(controls.failTrash)throw Error("fixture_ambiguous_trash");
      const value=fileMap.get(expected.id);assert.equal(value.version,expected.version);
      value.trashed=true;value.version="2";controls.onTrash?.(value);
      return {nativeHttpStatus:200,fileId:value.id,trashed:true,version:"2"};
    }
  };
  const snapshots={
    async get(id) {if(!snapshotMap.has(id))throw Error("fixture_snapshot_absent");return structuredClone(snapshotMap.get(id));},
    async list() {return [...snapshotMap.values()].map(s=>structuredClone(s));},
    async remove(snapshot) {calls.push({kind:"delete-snapshot",id:snapshot.id});if(controls.failRemove)throw Error("fixture_ambiguous_delete");
      assert.ok(snapshotMap.delete(snapshot.id));controls.onRemove?.(snapshot);
      return {nativeExitCode:0,id:snapshot.id,absenceVerified:true};}
  };
  const argumentsForRun=()=>({instanceId,month:months.at(-1),operationId,points,rootFolderId:"root",drive,snapshots,journalDirectory:join(root,"journal")});
  return {root,points,drive,snapshots,calls,controls,fileMap,folders,snapshotMap,argumentsForRun,
    run:()=>executeMonthlyRetention(argumentsForRun())};
}
test("twelve complete months preserve two native points and ten Drive points",async()=>{
  const f=await fixture(Array.from({length:12},(_,i)=>`2026-${String(i+1).padStart(2,"0")}`)), result=await f.run();
  assert.equal(result.state,"rotation-complete");assert.equal(f.snapshotMap.size,4);
  assert.equal(result.instanceId,instanceId);assert.equal(result.month,"2026-12");assert.equal(result.operationId,operationId);
  assert.equal([...f.fileMap.values()].filter(f=>!f.trashed).length,50);
  assert.equal(result.retired.digitalOcean.length,10);assert.deepEqual(result.retired.googleDrive,["2026-02","2026-01"]);
  assert.equal(f.folders.size,12);assert.ok(f.calls.every(c=>!c.kind.includes("folder")));
  const journal=await readFile(join(f.root,"journal/events.jsonl"),"utf8");
  assert.ok(journal.indexOf("snapshot-retirement-intent")<journal.indexOf("snapshot-retirement-returned"));
  assert.match(journal,/rotation-complete/);
  const retirement=journal.trim().split("\n").map(line=>JSON.parse(line)).find(event=>event.event==="snapshot-retirement-intent");
  assert.equal(retirement.month,"2026-12");assert.equal(retirement.targetMonth,"2026-10");
});
test("first complete month creates no imaginary history or deletion",async()=>{
  const f=await fixture(["2026-10"]),r=await f.run();assert.equal(r.state,"rotation-complete");assert.deepEqual(f.calls,[]);
});
test("delayed billing updates do not block keepers or rewrite captured monthly records",async()=>{
  const f=await fixture(["2026-08","2026-09","2026-10"]),original=structuredClone(f.points);
  for(const value of f.snapshotMap.values())value.size_gigabytes=0.3328;
  const result=await f.run();
  assert.equal(result.state,"rotation-complete");assert.equal(f.snapshotMap.size,4);
  assert.deepEqual(f.points,original);
});
test("failed upload preserves every older native/Drive point without a mutation",async()=>{
  const f=await fixture(["2026-08","2026-09","2026-10"]);f.points.at(-1).googleDrive={status:"uploading"};
  assert.equal((await f.run()).state,"blocked-no-retirements");assert.deepEqual(f.calls,[]);assert.equal(f.snapshotMap.size,6);
});
test("unexported native history blocks the whole rotation",async()=>{
  const f=await fixture(["2026-08","2026-09","2026-10"]);f.points[0].googleDrive={status:"missing"};
  assert.equal((await f.run()).plan.reason,"history_not_exported");assert.deepEqual(f.calls,[]);
});
test("replacement metadata changed since exact byte verification stops before retirement",async()=>{
  const f=await fixture(["2026-08","2026-09","2026-10"]);
  f.fileMap.get(f.points.at(-1).googleDrive.receipt.handles[portableDriveNames[0]]).version="2";
  await assert.rejects(f.run(),/retention_drive_file_changed/);assert.deepEqual(f.calls,[]);
});
test("replacement snapshot lost after first old deletion stops without deleting its peer",async()=>{
  const f=await fixture(["2026-08","2026-09","2026-10"]);
  f.controls.onRemove=()=>f.snapshotMap.delete(f.points.at(-1).digitalOcean.databaseId);
  await assert.rejects(f.run(),/retention_failed_or_ambiguous/);assert.equal(f.calls.length,1);
  assert.ok(f.snapshotMap.has(f.points[0].digitalOcean.mediaId));
});
test("ambiguous native deletion is attempted only once and never causes Drive retirement",async()=>{
  const f=await fixture(["2026-08","2026-09","2026-10"]);f.controls.failRemove=true;
  await assert.rejects(f.run(),/retention_failed_or_ambiguous/);assert.equal(f.calls.length,1);assert.equal(f.snapshotMap.size,6);
});
test("new non-backup child in an old Drive folder stops before trashing any files",async()=>{
  const f=await fixture(Array.from({length:11},(_,i)=>`2026-${String(i+1).padStart(2,"0")}`));
  f.fileMap.set("unrelated-owner-file",owner("unrelated-owner-file","owner-added.txt","text/plain",f.points[0].googleDrive.fileId));
  await assert.rejects(f.run(),/retention_drive_set_changed/);assert.ok(!f.calls.some(c=>c.kind==="trash"));
});
test("ambiguous Drive trash is attempted only once; all ten kept months remain intact",async()=>{
  const f=await fixture(Array.from({length:11},(_,i)=>`2026-${String(i+1).padStart(2,"0")}`));f.controls.failTrash=true;
  await assert.rejects(f.run(),/retention_failed_or_ambiguous/);assert.equal(f.calls.filter(c=>c.kind==="trash").length,1);
  assert.equal([...f.fileMap.values()].filter(f=>!f.trashed).length,55);
});
test("cross-month reused remote IDs are refused before any effects",async()=>{
  const f=await fixture(["2026-08","2026-09","2026-10"]);
  const old=f.points[0],newest=f.points.at(-1);old.digitalOcean.databaseId=newest.digitalOcean.databaseId;
  old.digitalOcean.pair.snapshots.database.id=newest.digitalOcean.databaseId;
  await assert.rejects(f.run(),/retention_remote_id_reused/);assert.deepEqual(f.calls,[]);
});
test("a prior claimed rotation is reconciled rather than executed again",async()=>{
  const f=await fixture(["2026-10"]);await f.run();await assert.rejects(f.run(),/EEXIST/);assert.deepEqual(f.calls,[]);
});
test("a different current operation cannot authorize retention",async()=>{
  const f=await fixture(["2026-10"]);
  await assert.rejects(executeMonthlyRetention({...f.argumentsForRun(),operationId:"c".repeat(32)}),/current_operation_changed/);
  assert.deepEqual(f.calls,[]);
});
test("producer receipt without verified clone cleanup cannot become a retention record",()=>{
  assert.throws(()=>monthlyRetentionRecord({point:{},exportReceipt:{state:"sealed-not-restore-accepted",nativeExportExitCode:0,
    cloneCleanupVerified:false},driveReceipt:{}}),/retention_export_receipt_invalid/);
});
test("native adapter requires exact immutable identity before its one snapshot DELETE",async()=>{
  const f=await fixture(["2026-10"]), s=f.points[0].digitalOcean.pair.snapshots.database,calls=[];
  const adapter=nativeRetentionSnapshots({snapshots:f.snapshots,run:async(program,args)=>{
    calls.push([program,args]);f.snapshotMap.delete(s.id);return {nativeExitCode:0};}});
  const r=await adapter.remove(s);assert.equal(r.nativeExitCode,0);assert.equal(calls.length,1);
  assert.deepEqual(calls[0],["doctl",["compute","snapshot","delete",s.id,"--force","--http-retry-max","0"]]);
});
test("native DELETE exit0 is not absence proof",async()=>{
  const f=await fixture(["2026-10"]),calls=[];
  const adapter=nativeRetentionSnapshots({snapshots:f.snapshots,run:async(...args)=>{calls.push(args);return {nativeExitCode:0};}});
  await assert.rejects(adapter.remove(f.points[0].digitalOcean.pair.snapshots.database),/snapshot_still_present/);assert.equal(calls.length,1);
});
test("native retirement tolerates only updated billing, retains exact identity and issues one DELETE",async()=>{
  const f=await fixture(["2026-10"]),s=f.points[0].digitalOcean.pair.snapshots.database,calls=[];
  f.snapshotMap.get(s.id).size_gigabytes=0.2927;
  const adapter=nativeRetentionSnapshots({snapshots:f.snapshots,run:async(program,args)=>{
    calls.push([program,args]);f.snapshotMap.delete(s.id);return {nativeExitCode:0};}});
  assert.equal((await adapter.remove(s)).absenceVerified,true);assert.equal(calls.length,1);
  assert.equal(s.billableGiB,1);
});
for(const [field,value] of Object.entries({id:"987654321",name:"foreign",resource_id:"another-volume",
  resource_type:"droplet",created_at:"2026-10-01T00:00:03Z",min_disk_size:11,regions:["nyc3"]})) {
  test(`updated billing cannot excuse native retirement identity change ${field}`,async()=>{
    const f=await fixture(["2026-10"]),s=f.points[0].digitalOcean.pair.snapshots.database;
    Object.assign(f.snapshotMap.get(s.id),{size_gigabytes:0.2927,[field]:value});let writes=0;
    const adapter=nativeRetentionSnapshots({snapshots:f.snapshots,run:async()=>{writes++;return {nativeExitCode:0};}});
    await assert.rejects(adapter.remove(s),/retention_snapshot_changed/);assert.equal(writes,0);
  });
}
for(const value of [-1,NaN,Infinity,"0.2927",null]) {
  test(`invalid retirement billing ${String(value)} blocks DELETE`,async()=>{
    const f=await fixture(["2026-10"]),s=f.points[0].digitalOcean.pair.snapshots.database;
    f.snapshotMap.get(s.id).size_gigabytes=value;let writes=0;
    const adapter=nativeRetentionSnapshots({snapshots:f.snapshots,run:async()=>{writes++;return {nativeExitCode:0};}});
    await assert.rejects(adapter.remove(s),/retention_snapshot_changed/);assert.equal(writes,0);
  });
}
test("foreign native volume/name is refused before DELETE",async()=>{
  const f=await fixture(["2026-10"]),s=f.points[0].digitalOcean.pair.snapshots.database;
  f.snapshotMap.get(s.id).resource_id="another-volume";let writes=0;
  const adapter=nativeRetentionSnapshots({snapshots:f.snapshots,run:async()=>{writes++;return {nativeExitCode:0};}});
  await assert.rejects(adapter.remove(s),/retention_snapshot_changed/);assert.equal(writes,0);
});
