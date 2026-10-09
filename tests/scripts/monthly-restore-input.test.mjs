import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, mkdir, writeFile, readFile, symlink, link, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync } from "node:fs";
import { extractMonthlyMediaArchive,closedMonthlyRuntimeEntries,hashMonthlyRestoreFile } from "../../deployment/monthly-restore-input.mjs";
import { nativeMonthlyArtifacts } from "../../deployment/monthly-native-bundle.mjs";

const sha=bytes=>createHash("sha256").update(bytes).digest("hex");
async function root(){return realpath(await mkdtemp(join(tmpdir(),"yenhubs-monthly-restore-fixture-")));}
async function media() {
  const directory=await root(),source=join(directory,"source"),base="owned/ab/cd/abcd-fixture";
  await mkdir(join(source,"owned/ab/cd"),{mode:0o700,recursive:true});
  await writeFile(join(source,base+".blob"),"ONLY FIXTURE: owned ciphertext bytes",{mode:0o600});
  await writeFile(join(source,base+".meta.json"),'{"fixtureOnly":true}',{mode:0o600});
  const archive=join(directory,"media.tar.gz"),outputDirectory=join(directory,"restored");
  const archiveSource=()=>{execFileSync("tar",["--format=ustar","-czf",archive,"-C",source,"."],{stdio:"pipe",timeout:5000});
    chmodSync(archive,0o600);};
  archiveSource();return {directory,source,base,archive,outputDirectory,archiveSource,
    run:options=>extractMonthlyMediaArchive({archive,outputDirectory,...options})};
}
function headerChecksum(header) {
  header.fill(32,148,156);header.write(header.reduce((sum,v)=>sum+v,0).toString(8).padStart(6,"0")+"\0 ",148,8,"ascii");
}
async function mutateFirstArchive(f,change) {
  const bytes=gunzipSync(await readFile(f.archive));change(bytes.subarray(0,512));headerChecksum(bytes.subarray(0,512));
  await writeFile(f.archive,gzipSync(bytes),{mode:0o600});
}
test("native USTAR media restore streams every complete pair into fresh private paths",async()=>{
  const f=await media(),r=await f.run();assert.equal(r.completePairs,1);
  for(const suffix of [".blob",".meta.json"]){const bytes=await readFile(join(f.source,f.base+suffix));
    assert.deepEqual(await readFile(join(f.outputDirectory,f.base+suffix)),bytes);assert.equal(r.files[f.base+suffix].sha256,sha(bytes));}
  assert.ok(r.bytes>0);await assert.rejects(f.run(),{code:"EEXIST"});
});
test("stream extraction refuses symlinks and hardlinks without following their targets",async()=>{
  for(const hard of [false,true]) {
    const f=await media(),file=join(f.source,f.base+".blob");
    if(hard)await link(file,join(f.source,"owned/ab/cd/abcd-other.blob"));
    // USTAR's linkname is100 bytes: a long absolute macOS tmp path would be
    // omitted by BSD tar rather than testing the decoder's link rejection.
    else await symlink("abcd-fixture.blob",join(f.source,"owned/ab/cd/abcd-other.blob"));
    f.archiveSource();
    const listing=execFileSync("tar",["-tvzf",f.archive],{encoding:"utf8",stdio:"pipe"});
    assert.match(listing,/abcd-other.blob/,`fixture archive missing link: hard=${hard}`);
    await assert.rejects(f.run(),/tar_header_invalid|media_entry_invalid/,`hard=${hard}; ${listing}`);
  }
});
test("parent traversal, another filename and link type cannot escape the new root",async()=>{
  for(const name of ["../escaped/","owned/../","owned/aa/../","absolute/","/outside/"]) {
    const f=await media();await mutateFirstArchive(f,header=>{header.fill(0,0,100);header.write(name);});
    await assert.rejects(f.run(),/media_entry_invalid/);
    assert.deepEqual((await readdir(f.directory)).sort(),["media.tar.gz","restored","source"]);
  }
});
test("expanded-byte ceiling fails closed before an oversized file is written",async()=>{
  const f=await media();await assert.rejects(f.run({maximumUnpackedBytes:1}),/media_size_excessive/);
});
test("truncation and nonzero trailing bytes never yield complete media",async()=>{
  const f=await media(),bytes=await readFile(f.archive);await writeFile(f.archive,bytes.subarray(0,bytes.length-12),{mode:0o600});
  await assert.rejects(f.run());
  const other=await media();await writeFile(other.archive,gzipSync(Buffer.concat([gunzipSync(await readFile(other.archive)),Buffer.from("not padding")])),{mode:0o600});
  await assert.rejects(other.run(),/tar_trailing_bytes/);
});
test("a missing metadata peer or a foreign shard fails the restore",async()=>{
  const f=await media();execFileSync("tar",["--format=ustar","-czf",f.archive,"-C",f.source,f.base+".blob"],{stdio:"pipe"});
  await assert.rejects(f.run(),/media_pair_missing/);
  const other=await media();await mutateFirstArchive(other,header=>{header.fill(0,0,100);header.write("owned/zz/xx/abcd-fixture.blob");header[156]=48;});
  await assert.rejects(other.run(),/media_entry_invalid/);
});
test("closed runtime parser accepts exactly fourteen artifacts and their checksum file",async()=>{
  const directory=await root();for(const name of [...nativeMonthlyArtifacts,"SHA256SUMS"])
    await writeFile(join(directory,name),"ONLY FIXTURE: "+name,{mode:0o600});
  const bytes=execFileSync("tar",["--format=ustar","-czf","-","-C",directory,...nativeMonthlyArtifacts,"SHA256SUMS"],{stdio:"pipe"});
  const entries=closedMonthlyRuntimeEntries(bytes);assert.equal(entries.size,15);
  for(const [name,value] of entries){assert.equal(value.toString(),"ONLY FIXTURE: "+name);value.fill(0);}
  const incomplete=execFileSync("tar",["--format=ustar","-czf","-","-C",directory,...nativeMonthlyArtifacts],{stdio:"pipe"});
  assert.throws(()=>closedMonthlyRuntimeEntries(incomplete),/runtime_set_invalid/);
});
test("closed runtime rejects duplicate, traversal, extended and symlink headers",async()=>{
  const directory=await root();for(const name of [...nativeMonthlyArtifacts,"SHA256SUMS"])
    await writeFile(join(directory,name),"ONLY FIXTURE",{mode:0o600});
  const compressed=execFileSync("tar",["--format=ustar","-czf","-","-C",directory,...nativeMonthlyArtifacts,"SHA256SUMS"],{stdio:"pipe"});
  for(const type of ["x","g","2","1"]){const bytes=gunzipSync(compressed);bytes[156]=type.charCodeAt(0);headerChecksum(bytes.subarray(0,512));
    assert.throws(()=>closedMonthlyRuntimeEntries(gzipSync(bytes)),/runtime_set_invalid/);}
  const bytes=gunzipSync(compressed);bytes.fill(0,0,100);bytes.write("../escape");headerChecksum(bytes.subarray(0,512));
  assert.throws(()=>closedMonthlyRuntimeEntries(gzipSync(bytes)),/runtime_set_invalid/);
});
test("pinned plaintext hashes reject public files and symlink paths",async()=>{
  const directory=await root(),file=join(directory,"private.bin");await writeFile(file,"FIXTURE",{mode:0o600});
  assert.deepEqual(await hashMonthlyRestoreFile(file),{bytes:7,sha256:sha("FIXTURE")});
  const publicFile=join(directory,"public.bin");await writeFile(publicFile,"FIXTURE",{mode:0o600});
  // A restrictive inherited umask must not turn this negative fixture private.
  chmodSync(publicFile,0o644);
  await assert.rejects(hashMonthlyRestoreFile(publicFile),/file_not_private/);
  const linked=join(directory,"linked.bin");await symlink(file,linked);await assert.rejects(hashMonthlyRestoreFile(linked),/not_canonical/);
});
