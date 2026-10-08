/** Directed fixtures: no cloud connection, real key, live data or server start. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp,realpath,mkdir,writeFile,readFile,lstat,readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { nativeMonthlyArtifacts,writeMonthlyRuntimeArchive } from "../../deployment/monthly-native-bundle.mjs";
import { portableDriveNames,portableDriveMime } from "../../deployment/monthly-drive-store.mjs";
import { monthlyRetentionRecord } from "../../deployment/monthly-retention-executor.mjs";
import { inspectMonthlyRestoreInput,downloadMonthlyRestorePoint } from "../../deployment/monthly-restore-input.mjs";
import { requireLocalRestoreMajor } from "../recovery/monthly-portable-restore.mjs";

const hash=(value,algorithm="sha256")=>createHash(algorithm).update(value).digest("hex");
const uuid=n=>`00000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const binding={instanceId:"fixture-monthly",month:"2026-10",operationId:"a".repeat(32)};
const owner=(id,name,mimeType,parent)=>({id,name,mimeType,parents:parent?[parent]:[],ownedByMe:true,trashed:false,
  permissions:[{type:"user",role:"owner"}],version:"1"});
async function privateRoot(){return realpath(await mkdtemp(join(tmpdir(),"yenhubs-restore-join-fixture-")));}

function remoteFixture() {
  const contents={},files={},handles={},versions={};
  for(const name of portableDriveNames) {
    contents[name]=Buffer.from("ONLY REMOTE FIXTURE: "+name);
    files[name]={bytes:contents[name].length,sha256:hash(contents[name]),md5:hash(contents[name],"md5")};
    handles[name]="fixture-"+name.replaceAll(".","-");versions[name]="1";
  }
  const receipt={schema:"yenhubs-drive-point-readback-v1",state:"transport-verified-not-restore-accepted",...binding,
    folderId:"month-folder",files,handles,versions,sha256:hash(JSON.stringify(files))};
  const pair={schema:"yenhubs-native-monthly-pair-v1",state:"captured-not-restore-accepted",...binding,snapshots:{}};
  for(const [i,role] of ["database","media"].entries())pair.snapshots[role]={id:uuid(10+i),name:`${binding.instanceId}-${binding.month}-${role}`};
  const record=monthlyRetentionRecord({point:{pair,manifestSha256:"b".repeat(64)},exportReceipt:{state:"sealed-not-restore-accepted",
    nativeExportExitCode:0,cloneCleanupVerified:true,nativeManifestSha256:"b".repeat(64),binding,
    ciphertexts:Object.fromEntries(portableDriveNames.filter(n=>n.endsWith(".age")).map(n=>[n,files[n]]))},driveReceipt:receipt});
  const items=new Map([["root",owner("root","private-fixture-root","application/vnd.google-apps.folder")],
    ["month-folder",{...owner("month-folder",`${binding.instanceId}-${binding.month}`,"application/vnd.google-apps.folder","root"),
      appProperties:{kind:"yenhubs-monthly-portable-v1",...binding}}]]);
  for(const name of portableDriveNames)items.set(handles[name],{...owner(handles[name],name,portableDriveMime(name),"month-folder"),
    size:String(files[name].bytes),md5Checksum:files[name].md5});
  const calls=[],controls={};
  const provider={
    async stat(id){calls.push({method:"stat",id});return structuredClone(items.get(id));},
    async namedChildren(parent,name){calls.push({method:"namedChildren",parent});return [...items.values()]
      .filter(v=>v.parents[0]===parent && v.name===name).map(v=>structuredClone(v));},
    async children(parent){calls.push({method:"children",parent});return [...items.values()]
      .filter(v=>v.parents[0]===parent).map(v=>structuredClone(v));},
    async *content(id){calls.push({method:"content",id});const name=portableDriveNames.find(n=>handles[n]===id);
      const bytes=controls.content?.(name,contents[name])??contents[name];
      yield bytes.subarray(0,3);yield bytes.subarray(3);controls.afterContent?.(name);}
  };
  return {record,items,calls,controls,provider,contents,run:outputDirectory=>downloadMonthlyRestorePoint({record,
    rootFolderId:"root",provider,outputDirectory})};
}

test("restore download reads exactly five pinned IDs, not a path search, into private files",async()=>{
  const f=remoteFixture(),root=await privateRoot(),output=join(root,"download"),result=await f.run(output);
  assert.equal(result.state,"remote-bytes-verified-not-restore-accepted");assert.deepEqual(result.binding,binding);
  assert.equal(f.calls.filter(v=>v.method==="content").length,5);
  assert.ok(f.calls.every(v=>["stat","namedChildren","children","content"].includes(v.method)));
  for(const name of portableDriveNames){assert.deepEqual(await readFile(join(output,name)),f.contents[name]);
    assert.equal((await lstat(join(output,name))).mode&0o777,0o600);}
  await assert.rejects(f.run(output),{code:"EEXIST"});assert.equal(f.calls.filter(v=>v.method==="content").length,5);
});
test("shared root or a duplicated month blocks before downloading or claiming local output",async()=>{
  for(const duplicate of [false,true]) {
    const f=remoteFixture(),root=await privateRoot(),output=join(root,"download");
    if(duplicate)f.items.set("duplicate",{...structuredClone(f.items.get("month-folder")),id:"duplicate"});
    else f.items.get("root").permissions.push({type:"anyone",role:"reader"});
    await assert.rejects(f.run(output),/root_changed|month_ambiguous/);
    await assert.rejects(lstat(output),{code:"ENOENT"});assert.equal(f.calls.filter(v=>v.method==="content").length,0);
  }
});
test("changed remote bytes, length or native read failure preserve a partial attempt without retry",async()=>{
  for(const fault of ["hash","oversized","short","read-failure"]) {
    const f=remoteFixture(),root=await privateRoot();
    f.controls.content=(_name,bytes)=>{if(fault==="read-failure")throw Error("fixture-native-read-failed");
      return fault==="hash"?Buffer.alloc(bytes.length,35):fault==="oversized"?Buffer.concat([bytes,Buffer.from("extra")]):bytes.subarray(1);};
    await assert.rejects(f.run(join(root,"download")),/download_changed|download_oversized|fixture-native-read-failed/);
    assert.equal(f.calls.filter(v=>v.method==="content").length,1);assert.ok((await readdir(join(root,"download"))).length<=1);
  }
});
test("file version or new sharing during download stops before reading the next ID",async()=>{
  for(const shared of [false,true]) {
    const f=remoteFixture(),root=await privateRoot();f.controls.afterContent=name=>{
      const item=f.items.get(f.record.googleDrive.receipt.handles[name]);
      if(shared)item.permissions.push({type:"anyone",role:"reader"});else item.version="2";};
    await assert.rejects(f.run(join(root,"download")),/owner_changed|file_changed/);
    assert.equal(f.calls.filter(v=>v.method==="content").length,1);
  }
});
test("root sharing introduced after the final bytes is not accepted",async()=>{
  const f=remoteFixture(),root=await privateRoot();f.controls.afterContent=name=>{
    if(name===portableDriveNames.at(-1))f.items.get("root").permissions.push({type:"anyone",role:"reader"});};
  await assert.rejects(f.run(join(root,"download")),/root_changed/);
});

async function openedFixture() {
  const root=await privateRoot(),native=join(root,"native"),opened=join(root,"opened");
  await mkdir(native,{mode:0o700});await mkdir(opened,{mode:0o700});
  const source={schema:"yenhubs-monthly-source-v1",state:"inventory-not-captured",context:"fixture",...binding,
    region:"ams3",namespace:{name:"fixture",uid:uuid(1)},volumes:{
      database:{volumeId:uuid(2),pvcUid:uuid(3),pvUid:uuid(4),sizeGiB:10,mountPath:"/var/lib/postgresql/data"},
      media:{volumeId:uuid(5),pvcUid:uuid(6),pvUid:uuid(7),sizeGiB:10}},
    postgres:{major:"12",dataPath:"/var/lib/postgresql/data",walPath:"/var/lib/postgresql/data/pg_wal",tablespaceEntries:0,
      sameWalFilesystem:true,fsync:"on",fullPageWrites:"on",syncAvailable:true}};
  const contract={schema_version:2,sql_dump_sha256:null,fixtureNotProduction:true};
  const pair={schema:"yenhubs-native-monthly-pair-v1",state:"captured-not-restore-accepted",...binding,context:source.context,
    region:source.region,namespace:source.namespace,postgres:source.postgres,startedAt:"2026-10-06T12:00:01.500Z",
    capturedAt:"2026-10-06T12:00:03.100Z",durationMilliseconds:1600,databaseContractSha256:hash(JSON.stringify(contract)),
    acceptance:{parentTerminalJoin:false,writersResumed:false,portableExport:false,isolatedDigitalOceanRestore:false,isolatedDriveRestore:false},snapshots:{}};
  for(const [i,role] of ["database","media"].entries())pair.snapshots[role]={id:uuid(10+i),
    name:`${binding.instanceId}-${binding.month}-${role}`,volumeId:source.volumes[role].volumeId,region:"ams3",
    minimumDiskGiB:10,billableGiB:1,createdAt:"2026-10-06T12:00:02Z"};
  const metadata={schema_version:3,runtime_generation:"durable-v2",operation_id:binding.operationId,kube_context:source.context,
    namespace:source.namespace.name,namespace_uid:source.namespace.uid,ret_pvc_uid:source.volumes.media.pvcUid,
    stamp:"20261006-120000",writer_quiescence:{required:true,started_at_utc:"2026-10-06T12:00:00Z",completed_at_utc:"2026-10-06T12:00:04Z"}};
  const values=["values","manifest","key"].map(n=>join(root,n));
  for(const path of values)await writeFile(path,"ONLY PUBLIC FIXTURE: NOT A REAL KEY OR CONFIGURATION",{mode:0o600});
  await writeMonthlyRuntimeArchive({output:join(native,"runtime.tar.gz"),valuesPath:values[0],manifestPath:values[1],keyPath:values[2],journalRoot:root});
  const documents={"monthly-source.json":source,"native-pair.json":pair,"database-contract.json":contract,
    "checkpoint-metadata.json":metadata,"deployment-images.json":{deployments:[]}},sums=[];
  for(const name of nativeMonthlyArtifacts){if(name!=="runtime.tar.gz")await writeFile(join(native,name),JSON.stringify(documents[name]??{}),{mode:0o600});
    sums.push(`${hash(await readFile(join(native,name)))}  ${name}`);}
  const nativeManifest=Buffer.from(sums.join("\n")+"\n");await writeFile(join(native,"SHA256SUMS"),nativeManifest,{mode:0o600});
  const runtime=execFileSync("tar",["--format=ustar","-czf","-","-C",native,...nativeMonthlyArtifacts,"SHA256SUMS"],{stdio:"pipe",timeout:5000});
  const input={database:Buffer.from("PGDMP-ONLY-FIXTURE"),media:Buffer.from("ONLY-FIXTURE-MEDIA"),runtime};
  const manifest={schema:"yenhubs-portable-point-v1",binding:{...binding,nativeManifestSha256:hash(nativeManifest),
    postgresMajor:"12",sourceSnapshots:pair.snapshots},payloads:{}};
  for(const [kind,bytes] of Object.entries(input)){const name={database:"database.dump",media:"media.tar.gz",runtime:"runtime.tar.gz"}[kind];
    await writeFile(join(opened,name),bytes,{mode:0o600});manifest.payloads[kind]={filename:name,bytes:bytes.length,sha256:hash(bytes)};}
  const readback={schema:"yenhubs-portable-readback-v1",state:"verified-not-restore-accepted",binding:structuredClone(manifest.binding)};
  const save=async()=>{await writeFile(join(opened,"manifest.json"),JSON.stringify(manifest),{mode:0o600});
    await writeFile(join(opened,"transport-verified.json"),JSON.stringify(readback),{mode:0o600});};
  await save();const record={...binding,nativeManifestSha256:manifest.binding.nativeManifestSha256};
  return {root,opened,native,record,manifest,readback,save,run:()=>inspectMonthlyRestoreInput({openedDirectory:opened,record})};
}
test("opened point joins all three payloads to the closed original native bundle and can be reconciled read-only",async()=>{
  const f=await openedFixture(),r=await f.run();assert.equal(r.state,"restore-input-verified-not-restored");
  assert.equal(r.point.manifestSha256,f.record.nativeManifestSha256);assert.equal(r.point.source.postgres.major,"12");
  const extracted=join(f.opened,"native-runtime"),before=await lstat(join(extracted,"native-pair.json"));
  assert.equal((await readdir(extracted)).length,15);await f.run();
  const after=await lstat(join(extracted,"native-pair.json"));assert.equal(before.ino,after.ino);assert.equal(before.mtimeMs,after.mtimeMs);
});
for(const mismatch of ["month","operation","native-hash","snapshot","postgres-major","readback-binding"])
test(`opened point rejects ${mismatch} instead of accepting a different source`,async()=>{
  const f=await openedFixture();
  if(mismatch==="month")f.record.month="2026-09";
  if(mismatch==="operation")f.record.operationId="c".repeat(32);
  if(mismatch==="native-hash")f.record.nativeManifestSha256="c".repeat(64);
  if(mismatch==="snapshot")f.manifest.binding.sourceSnapshots.database.id=uuid(99);
  if(mismatch==="postgres-major")f.manifest.binding.postgresMajor="14";
  if(mismatch==="readback-binding")f.readback.binding.month="2026-09";
  else f.readback.binding=structuredClone(f.manifest.binding);
  await f.save();await assert.rejects(f.run(),/binding_changed/);
});
test("incomplete previous materialization is not filled in or accepted",async()=>{
  const f=await openedFixture(),extracted=join(f.opened,"native-runtime");await mkdir(extracted,{mode:0o700});
  await writeFile(join(extracted,"native-pair.json"),"ONLY PARTIAL FIXTURE",{mode:0o600});
  await assert.rejects(f.run(),/incomplete_or_extra/);assert.deepEqual(await readdir(extracted),["native-pair.json"]);
});
test("payload alteration and unknown plaintext entries fail before native materialization",async()=>{
  for(const extra of [false,true]){const f=await openedFixture();
    await writeFile(join(f.opened,extra?"unrelated.txt":"database.dump"),"CHANGED ONLY FIXTURE",{mode:0o600});
    await assert.rejects(f.run(),/plaintext_changed|plaintext_set_invalid/);
    await assert.rejects(lstat(join(f.opened,"native-runtime")),{code:"ENOENT"});}
});
test("PostgreSQL14 format proof cannot accept a PostgreSQL12 source or malformed version",()=>{
  requireLocalRestoreMajor("pg_ctl (PostgreSQL) 12.22","12");
  for(const observed of ["pg_ctl (PostgreSQL) 14.23","unrecognized","pg_ctl (PostgreSQL) 112.2"])
    assert.throws(()=>requireLocalRestoreMajor(observed,"12"),/major_mismatch/);
});
