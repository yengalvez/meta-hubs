import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, mkdir, writeFile, readFile, access, chmod, rename, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { publishSealedDrivePoint, portableDriveNames, inspectSealedDrivePoint } from "../../deployment/monthly-drive-store.mjs";

const hash=(bytes,kind="sha256")=>createHash(kind).update(bytes).digest("hex");
const bound={instanceId:"fixture-monthly",month:"2026-10",operationId:"a".repeat(32)};
async function fixture() {
  const root=await realpath(await mkdtemp(join(tmpdir(),"yenhubs-drive-store-"))), sealed=join(root,"sealed");
  await mkdir(sealed,{mode:0o700});
  const ciphertexts={};
  for(const name of portableDriveNames.filter(n=>n.endsWith(".age"))) {
    const bytes=Buffer.from(`age-encryption.org/v1\nFIXTURE-TRANSPORT-ONLY:${name}`);
    await writeFile(join(sealed,name),bytes,{mode:0o600});ciphertexts[name]={bytes:bytes.length,sha256:hash(bytes)};
  }
  await writeFile(join(sealed,"portable-point.json"),JSON.stringify({schema:"yenhubs-portable-transport-v1",
    state:"sealed-not-restore-accepted",...bound,ciphertexts}),{mode:0o600});
  const entries=new Map(),objects=new Map(),calls=[];
  const owned=(id,name,mimeType,parent=null)=>({id,name,mimeType,ownedByMe:true,trashed:false,
    permissions:[{type:"user",role:"owner"}],parents:parent?[parent]:[],version:"1"});
  entries.set("root",owned("root","approved-fixture-target","application/vnd.google-apps.folder"));
  let sequence=0;
  const provider={
    stat:async id=>structuredClone(entries.get(id)),
    children:async parent=>[...entries.values()].filter(item=>item.parents.includes(parent)).map(v=>structuredClone(v)),
    namedChildren:async(parent,name)=>[...entries.values()].filter(item=>item.parents.includes(parent)&&item.name===name).map(v=>structuredClone(v)),
    createFolder:async({parentId,name,properties})=>{
      calls.push("create");const result={...owned(`folder-${++sequence}`,name,"application/vnd.google-apps.folder",parentId),appProperties:properties};
      entries.set(result.id,result);return structuredClone(result);
    },
    put:async({folderId,name,source})=>{
      calls.push(`put:${name}`);const chunks=[];
      for await(const bytes of source.file.createReadStream({start:0,autoClose:false})) chunks.push(bytes);
      const actual=Buffer.concat(chunks),fileId=`file-${++sequence}`;
      entries.set(fileId,{...owned(fileId,name,"application/octet-stream",folderId),size:String(actual.length),md5Checksum:hash(actual,"md5")});
      objects.set(fileId,actual);return {nativeExit:0};
    },
    content:async id=>(async function*(){const data=objects.get(id);yield data.subarray(0,7);yield data.subarray(7);})()
  };
  return {root,sealed,provider,entries,objects,calls,options:{packageDirectory:sealed,expectedBinding:bound,
    rootFolderId:"root",provider,journalDirectory:join(root,"journal")}};
}
test("complete closed set publishes and reads every exact file without claiming restore",async()=>{
  const f=await fixture(),result=await publishSealedDrivePoint(f.options);
  assert.equal(result.state,"transport-verified-not-restore-accepted");
  assert.deepEqual(f.calls,["create",...portableDriveNames.map(n=>`put:${n}`)]);
  assert.equal(Object.keys(result.handles).length,5);
  for(const name of portableDriveNames) assert.deepEqual(await readFile(join(f.sealed,name)),await readFile(join(f.options.journalDirectory,"readback",name)));
});
test("a complete existing operation is reconciled by reads, never uploaded again",async()=>{
  const f=await fixture();await publishSealedDrivePoint(f.options);f.calls.length=0;
  const result=await publishSealedDrivePoint({...f.options,journalDirectory:join(f.root,"journal-reconcile")});
  assert.equal(result.reconciledExisting,true);assert.deepEqual(f.calls,[]);
});
test("ambiguous folder creation does not retry or start uploads",async()=>{
  const f=await fixture(),create=f.provider.createFolder;
  f.provider.createFolder=async args=>{await create(args);throw new Error("drive_provider_request_failed_or_ambiguous");};
  await assert.rejects(publishSealedDrivePoint(f.options),/ambiguous/);assert.deepEqual(f.calls,["create"]);
  f.calls.length=0;
  await assert.rejects(publishSealedDrivePoint({...f.options,journalDirectory:join(f.root,"reconcile")}),/set_incomplete/);
  assert.deepEqual(f.calls,[]);
});
test("failed second upload preserves the partial and does not upload other files",async()=>{
  const f=await fixture(),put=f.provider.put;
  f.provider.put=async args=>{if(args.name==="manifest.json.age"){f.calls.push("failed-manifest");throw new Error("drive_provider_upload_failed_or_ambiguous");}return put(args);};
  await assert.rejects(publishSealedDrivePoint(f.options),/ambiguous/);
  assert.deepEqual(f.calls,["create","put:database.dump.age","failed-manifest"]);
  assert.equal(f.objects.size,1);assert.ok((await readFile(join(f.root,"journal/events.jsonl"),"utf8")).includes("not-accepted"));
});
test("plaintext extras are rejected before any remote call",async()=>{
  const f=await fixture();await writeFile(join(f.sealed,"private.key"),"FIXTURE ONLY",{mode:0o600});
  await assert.rejects(publishSealedDrivePoint(f.options),/set_invalid/);assert.deepEqual(f.calls,[]);
  await assert.rejects(access(f.options.journalDirectory));
});
test("changed ciphertext is rejected locally before creating the cloud folder",async()=>{
  const f=await fixture();await writeFile(join(f.sealed,"database.dump.age"),"age-encryption.org/v1\nCORRUPT");
  await assert.rejects(publishSealedDrivePoint(f.options),/ciphertext_mismatch/);assert.deepEqual(f.calls,[]);
});
test("wrong binding is refused before any remote mutation",async()=>{
  const f=await fixture();await assert.rejects(publishSealedDrivePoint({...f.options,expectedBinding:{...bound,operationId:"b".repeat(32)}}),/receipt_invalid/);
  assert.deepEqual(f.calls,[]);
});
test("shared root is refused before folder creation",async()=>{
  const f=await fixture();f.entries.get("root").permissions.push({type:"anyone",role:"reader"});
  await assert.rejects(publishSealedDrivePoint(f.options),/owner_only/);assert.deepEqual(f.calls,[]);
});
test("another operation in the same civil month is not overwritten",async()=>{
  const f=await fixture();await publishSealedDrivePoint(f.options);f.calls.length=0;
  const folder=[...f.entries.values()].find(v=>v.appProperties);folder.appProperties.operationId="b".repeat(32);
  await assert.rejects(publishSealedDrivePoint({...f.options,journalDirectory:join(f.root,"new-journal")}),/binding_changed/);
  assert.deepEqual(f.calls,[]);
});
test("duplicate remote monthly names fail closed without retrying uploads",async()=>{
  const f=await fixture();await publishSealedDrivePoint(f.options);f.calls.length=0;
  const original=[...f.entries.values()].find(v=>v.appProperties);f.entries.set("duplicate",{...structuredClone(original),id:"duplicate"});
  await assert.rejects(publishSealedDrivePoint({...f.options,journalDirectory:join(f.root,"dup-journal")}),/month_ambiguous/);assert.deepEqual(f.calls,[]);
});
test("corrupted downloaded bytes cannot produce a verified result",async()=>{
  const f=await fixture(),content=f.provider.content;
  f.provider.content=async id=>{const stream=await content(id);return(async function*(){for await(const value of stream){const bytes=Buffer.from(value);if(bytes.length)bytes[0]^=1;yield bytes;}})();};
  await assert.rejects(publishSealedDrivePoint(f.options),/bytes_mismatch/);
  assert.ok(!(await readFile(join(f.root,"journal/events.jsonl"),"utf8")).includes('"event":"transport-verified"'));
});
test("reused journal does not cause another native cloud attempt",async()=>{
  const f=await fixture();await publishSealedDrivePoint(f.options);f.calls.length=0;
  await assert.rejects(publishSealedDrivePoint(f.options),{code:"EEXIST"});assert.deepEqual(f.calls,[]);
});
test("inspection reports all five hashes, not just a manifest proxy",async()=>{
  const f=await fixture(),point=await inspectSealedDrivePoint(f.sealed,bound);
  try {assert.equal(Object.keys(point.files).length,5);assert.match(point.sha256,/^[a-f0-9]{64}$/);}
  finally {await point.close();}
});
test("a journal cannot contaminate the closed transport directory",async()=>{
  const f=await fixture();
  await assert.rejects(publishSealedDrivePoint({...f.options,journalDirectory:join(f.sealed,"journal")}),/journal_inside_transport/);
  assert.deepEqual(f.calls,[]);await assert.rejects(access(join(f.sealed,"journal")));
});
test("the requested root ID cannot be substituted by another owned folder",async()=>{
  const f=await fixture();f.entries.get("root").id="other-owned-folder";
  await assert.rejects(publishSealedDrivePoint(f.options),/root_invalid/);assert.deepEqual(f.calls,[]);
});
test("a folder stat cannot substitute a different matching folder ID",async()=>{
  const f=await fixture(),stat=f.provider.stat;
  f.provider.stat=async id=>{const value=await stat(id);if(id!=="root")value.id="substituted-folder";return value;};
  await assert.rejects(publishSealedDrivePoint(f.options),/binding_changed/);assert.deepEqual(f.calls,["create"]);
});
test("extra plaintext appearing during upload prevents transport acceptance",async()=>{
  const f=await fixture(),put=f.provider.put;
  f.provider.put=async args=>{const value=await put(args);if(args.name==="portable-point.json")
    await writeFile(join(f.sealed,"accidental-plaintext.txt"),"ONLY A FIXTURE",{mode:0o600});return value;};
  await assert.rejects(publishSealedDrivePoint(f.options),/set_invalid/);
  assert.ok(!(await readFile(join(f.root,"journal/events.jsonl"),"utf8")).includes('"event":"transport-verified"'));
});
test("permission changes on a pinned source stop the upload chain",async()=>{
  const f=await fixture(),put=f.provider.put;
  f.provider.put=async args=>{const value=await put(args);await chmod(args.source.path,0o644);return value;};
  await assert.rejects(publishSealedDrivePoint(f.options),/payload_changed/);
  assert.deepEqual(f.calls,["create","put:database.dump.age"]);
});
test("a path replacement cannot cause different bytes to be read or accepted",async()=>{
  const f=await fixture(),put=f.provider.put;
  f.provider.put=async args=>{await rename(args.source.path,args.source.path+".original");
    await writeFile(args.source.path,"REPLACEMENT FIXTURE",{mode:0o600});return put(args);};
  await assert.rejects(publishSealedDrivePoint(f.options),/payload_changed/);
  const uploaded=[...f.objects.values()][0];assert.match(uploaded.toString(),/FIXTURE-TRANSPORT-ONLY/);
  assert.deepEqual(f.calls,["create","put:database.dump.age"]);
});
test("a source modified after its own download is still refused at final join",async()=>{
  const f=await fixture(),content=f.provider.content;
  f.provider.content=async id=>{if(f.entries.get(id).name==="portable-point.json")
    await writeFile(join(f.sealed,"database.dump.age"),"CHANGED AFTER ITS DOWNLOAD");return content(id);};
  await assert.rejects(publishSealedDrivePoint(f.options),/payload_changed/);
});
test("a linked public receipt is refused before a remote call",async()=>{
  const f=await fixture(),receipt=join(f.sealed,"portable-point.json");
  await rename(receipt,join(f.root,"saved-receipt.json"));await symlink(join(f.root,"saved-receipt.json"),receipt);
  await assert.rejects(publishSealedDrivePoint(f.options));assert.deepEqual(f.calls,[]);
});
test("invalid receipt JSON never echoes the input bytes",async()=>{
  const f=await fixture();await writeFile(join(f.sealed,"portable-point.json"),"FIXTURE-PRIVATE-NOT-FOR-OUTPUT");
  await assert.rejects(publishSealedDrivePoint(f.options),error=>error.message==="drive_transport_receipt_invalid" &&
    !String(error).includes("FIXTURE-PRIVATE-NOT-FOR-OUTPUT"));assert.deepEqual(f.calls,[]);
});
test("a remote file revision changed during download is refused",async()=>{
  const f=await fixture(),content=f.provider.content;
  f.provider.content=async id=>{f.entries.get(id).version="2";return content(id);};
  await assert.rejects(publishSealedDrivePoint(f.options),/remote_file_changed/);
});
test("the public receipt cannot carry unapproved plaintext fields",async()=>{
  const f=await fixture(),path=join(f.sealed,"portable-point.json"),receipt=JSON.parse(await readFile(path));
  receipt.privateValue="ONLY-A-NEGATIVE-FIXTURE";await writeFile(path,JSON.stringify(receipt));
  await assert.rejects(publishSealedDrivePoint(f.options),/receipt_invalid/);assert.deepEqual(f.calls,[]);
});
test("ciphertext receipt entries cannot carry plaintext side channels",async()=>{
  const f=await fixture(),path=join(f.sealed,"portable-point.json"),receipt=JSON.parse(await readFile(path));
  receipt.ciphertexts["database.dump.age"].privateValue="ONLY-A-NEGATIVE-FIXTURE";await writeFile(path,JSON.stringify(receipt));
  await assert.rejects(publishSealedDrivePoint(f.options),/ciphertext_mismatch/);assert.deepEqual(f.calls,[]);
});
