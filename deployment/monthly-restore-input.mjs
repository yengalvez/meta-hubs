/** Read-only remote download and local materialization. Never restore production. */
import { constants } from "node:fs";
import { open, lstat, realpath, mkdir, readdir } from "node:fs/promises";
import { dirname, resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { gunzipSync, createGunzip } from "node:zlib";
import { portableDriveNames } from "./monthly-drive-store.mjs";
import { verifyRetentionDriveMetadata } from "./monthly-retention-executor.mjs";
import { inspectPublishedMonthlyPoint } from "./monthly-snapshot-export.mjs";
import { nativeMonthlyArtifacts } from "./monthly-native-bundle.mjs";
import { readPrivateBytes, readPrivateSource } from "./monthly-snapshot-worker.mjs";

const requireValue=(value,reason)=>{if(!value)throw new Error(reason);};
const sha=value=>createHash("sha256").update(value).digest("hex");
const canonical=value=>JSON.stringify(value,(_,v)=>v && !Array.isArray(v) && typeof v==="object"?
  Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))):v);
async function privateDirectory(path) {
  const stat=await lstat(path);
  requireValue(resolve(path)===path && await realpath(path)===path && stat.isDirectory() &&
    stat.uid===process.getuid() && (stat.mode&0o777)===0o700,"monthly_restore_directory_not_private");
}
async function claimDirectory(path) {
  await privateDirectory(dirname(path));await mkdir(path,{mode:0o700});
  const parent=await open(dirname(path),"r");try{await parent.sync();}finally{await parent.close();}
}
async function writePrivate(path,bytes) {
  const file=await open(path,"wx",0o600);try{await file.writeFile(bytes);await file.sync();}finally{await file.close();}
}
async function pinnedFile(path) {
  requireValue(resolve(path)===path && await realpath(path)===path,"monthly_restore_file_not_canonical");
  const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try {
    const before=await file.stat({bigint:true});
    requireValue(before.isFile() && before.uid===BigInt(process.getuid()) && before.nlink===1n &&
      (before.mode&0o777n)===0o600n && before.size>0n && before.size<=32n*1024n**3n,"monthly_restore_file_not_private");
    return {file,before,path};
  }catch(error){await file.close();throw error;}
}
async function unchanged(pinned) {
  const after=await pinned.file.stat({bigint:true}),named=await lstat(pinned.path,{bigint:true});
  requireValue(["dev","ino","uid","mode","nlink","size","mtimeNs","ctimeNs"].every(key=>
    pinned.before[key]===after[key] && named[key]===after[key]),"monthly_restore_source_changed");
}
export async function hashMonthlyRestoreFile(path) {
  const pinned=await pinnedFile(path),hash=createHash("sha256");
  try {
    for await(const bytes of pinned.file.createReadStream({start:0,autoClose:false}))hash.update(bytes);
    await unchanged(pinned);return {sha256:hash.digest("hex"),bytes:Number(pinned.before.size)};
  }finally{await pinned.file.close();}
}

export async function downloadMonthlyRestorePoint({record,rootFolderId,provider,outputDirectory}) {
  async function requireRoot() {
    const root=await provider.stat(rootFolderId);
    requireValue(root.id===rootFolderId && root.ownedByMe===true && root.trashed===false &&
      root.mimeType==="application/vnd.google-apps.folder" && root.permissions?.length===1 &&
      root.permissions[0].type==="user" && root.permissions[0].role==="owner","monthly_restore_drive_root_changed");
  }
  await requireRoot();
  await verifyRetentionDriveMetadata(record,rootFolderId,provider);
  await claimDirectory(outputDirectory);
  for(const name of portableDriveNames) {
    const expected=record.googleDrive.receipt.files[name],hash=createHash("sha256"),md5=createHash("md5");let bytes=0;
    const output=await open(join(outputDirectory,name),"wx",0o600);
    try {
      for await(const part of await provider.content(record.googleDrive.receipt.handles[name])) {
        bytes+=part.length;requireValue(bytes<=expected.bytes,"monthly_restore_download_oversized");
        hash.update(part);md5.update(part);await output.writeFile(part);
      }
      await output.sync();
    }finally{await output.close();}
    requireValue(bytes===expected.bytes && hash.digest("hex")===expected.sha256 && md5.digest("hex")===expected.md5,
      "monthly_restore_download_changed");
    await verifyRetentionDriveMetadata(record,rootFolderId,provider);
  }
  await requireRoot();
  return {state:"remote-bytes-verified-not-restore-accepted",binding:{instanceId:record.instanceId,month:record.month,
    operationId:record.operationId},packageDirectory:outputDirectory};
}

function tarHeader(header) {
  requireValue(header.length===512,"monthly_restore_tar_truncated");
  const text=(start,length)=>header.subarray(start,start+length).toString("utf8").replace(/\0.*$/s,"");
  const octal=(start,length)=>{const value=text(start,length).trim();requireValue(/^[0-7]+$/.test(value),"monthly_restore_tar_number_invalid");
    const number=Number.parseInt(value,8);requireValue(Number.isSafeInteger(number),"monthly_restore_tar_number_invalid");return number;};
  const expected=header.reduce((sum,value,index)=>sum+(index>=148 && index<156?32:value),0);
  requireValue(octal(148,8)===expected && /^ustar/.test(text(257,6)) && text(157,100)==="" &&
    text(345,155)==="","monthly_restore_tar_header_invalid");
  let name=text(0,100);if(name.startsWith("./"))name=name.slice(2);
  return {name,type:header[156]===0?"0":String.fromCharCode(header[156]),size:octal(124,12)};
}

/** Closed, small runtime archive. No tar extraction, links, PAX or arbitrary paths. */
export function closedMonthlyRuntimeEntries(compressed) {
  const bytes=gunzipSync(compressed,{maxOutputLength:64*1024*1024}),entries=new Map();let position=0,ended=false;
  try {
    while(position+512<=bytes.length) {
      const header=bytes.subarray(position,position+512);
      if(header.every(value=>value===0)) {requireValue(bytes.length-position>=1024 && bytes.subarray(position).every(value=>value===0),
        "monthly_restore_tar_trailing_bytes");ended=true;break;}
      const entry=tarHeader(header);position+=512;
      requireValue(entry.type==="0" && [...nativeMonthlyArtifacts,"SHA256SUMS"].includes(entry.name) &&
        !entries.has(entry.name) && entry.size>0 && entry.size<=50*1024*1024 && position+entry.size<=bytes.length,
        "monthly_restore_runtime_set_invalid");
      entries.set(entry.name,Buffer.from(bytes.subarray(position,position+entry.size)));
      position+=Math.ceil(entry.size/512)*512;
    }
    requireValue(ended && [...entries.keys()].sort().join()===[...nativeMonthlyArtifacts,"SHA256SUMS"].sort().join(),
      "monthly_restore_runtime_set_invalid");
    return entries;
  }catch(error){for(const value of entries.values())value.fill(0);throw error;}
  finally{bytes.fill(0);}
}

export async function inspectMonthlyRestoreInput({openedDirectory,record}) {
  await privateDirectory(openedDirectory);
  const present=await readdir(openedDirectory),extracted=present.includes("native-runtime");
  requireValue(present.sort().join()===
    ["database.dump","manifest.json","media.tar.gz","runtime.tar.gz","transport-verified.json",...(extracted?["native-runtime"]:[])].sort().join(),
    "monthly_restore_plaintext_set_invalid");
  const manifest=await readPrivateSource(join(openedDirectory,"manifest.json")),readback=await readPrivateSource(join(openedDirectory,"transport-verified.json"));
  requireValue(manifest.schema==="yenhubs-portable-point-v1" && readback.schema==="yenhubs-portable-readback-v1" &&
    readback.state==="verified-not-restore-accepted" && canonical(readback.binding)===canonical(manifest.binding) &&
    ["instanceId","month","operationId"].every(key=>manifest.binding?.[key]===record[key]) &&
    manifest.binding.nativeManifestSha256===record.nativeManifestSha256,"monthly_restore_binding_changed");
  for(const [kind,name] of Object.entries({database:"database.dump",media:"media.tar.gz",runtime:"runtime.tar.gz"})) {
    const observed=await hashMonthlyRestoreFile(join(openedDirectory,name));
    requireValue(manifest.payloads?.[kind]?.filename===name && observed.sha256===manifest.payloads[kind].sha256 &&
      observed.bytes===manifest.payloads[kind].bytes,"monthly_restore_plaintext_changed");
  }
  const nativeDirectory=join(openedDirectory,"native-runtime");
  const compressed=await readPrivateBytes(join(openedDirectory,"runtime.tar.gz"),64*1024*1024);let entries;
  try {entries=closedMonthlyRuntimeEntries(compressed);
    if(!extracted){await claimDirectory(nativeDirectory);for(const [name,bytes] of entries)await writePrivate(join(nativeDirectory,name),bytes);}
  }finally{compressed.fill(0);if(entries)for(const bytes of entries.values())bytes.fill(0);}
  const point=await inspectPublishedMonthlyPoint(nativeDirectory);
  requireValue(point.manifestSha256===record.nativeManifestSha256 &&
    ["instanceId","month","operationId"].every(key=>point.pair[key]===record[key]) &&
    canonical(point.pair.snapshots)===canonical(manifest.binding.sourceSnapshots) &&
    point.source.postgres.major===manifest.binding.postgresMajor,"monthly_restore_native_binding_changed");
  return {state:"restore-input-verified-not-restored",point,inputs:{database:join(openedDirectory,"database.dump"),
    media:join(openedDirectory,"media.tar.gz"),runtime:join(openedDirectory,"runtime.tar.gz")}};
}

/** Streaming media extraction only to NEW owned paths; never pass an unknown tar to tar -x. */
export async function extractMonthlyMediaArchive({archive,outputDirectory,maximumUnpackedBytes=40*1024**3}) {
  requireValue(Number.isSafeInteger(maximumUnpackedBytes) && maximumUnpackedBytes>0 && maximumUnpackedBytes<=40*1024**3,
    "monthly_restore_media_limit_invalid");
  const pinned=await pinnedFile(archive);
  try{await claimDirectory(outputDirectory);}catch(error){await pinned.file.close();throw error;}
  let pending=Buffer.alloc(0),entry=null,body=0,padding=0,output,hasEnded=false,zeroBlocks=0,total=0,count=0;
  const inventory={},seen=new Set(),hashes={};
  const source=pinned.file.createReadStream({start:0,autoClose:false}),unpacked=createGunzip();
  source.on("error",error=>unpacked.destroy(error));source.pipe(unpacked);
  try {
    for await(const part of unpacked) {
      pending=Buffer.concat([pending,part]);
      while(pending.length) {
        if(hasEnded) {requireValue(pending.every(value=>value===0),"monthly_restore_tar_trailing_bytes");
          zeroBlocks+=pending.length;pending=Buffer.alloc(0);break;}
        if(body) {
          const size=Math.min(body,pending.length),bytes=pending.subarray(0,size);await output.writeFile(bytes);hashes[entry.name].update(bytes);
          body-=size;pending=pending.subarray(size);
          if(!body){await output.sync();await output.close();output=null;inventory[entry.name]={bytes:entry.size,sha256:hashes[entry.name].digest("hex")};}
          continue;
        }
        if(padding){const size=Math.min(padding,pending.length);requireValue(pending.subarray(0,size).every(v=>v===0),"monthly_restore_tar_padding_invalid");
          padding-=size;pending=pending.subarray(size);continue;}
        if(pending.length<512)break;
        const header=pending.subarray(0,512);pending=pending.subarray(512);
        if(header.every(v=>v===0)){hasEnded=true;zeroBlocks=512;continue;}
        entry=tarHeader(header);count++;requireValue(count<=1000000,"monthly_restore_media_entries_excessive");
        const name=entry.name.replace(/\/$/,"");
        requireValue(!seen.has(name),"monthly_restore_media_duplicate");seen.add(name);
        const directory=name==="" || name==="." || /^owned(?:\/[A-Za-z0-9._-]{2}){0,2}$/.test(name);
        if(directory){requireValue(entry.type==="5" && entry.size===0 &&
          (name==="." || !name.split("/").includes("..")),"monthly_restore_media_entry_invalid");
          if(name && name!==".")await mkdir(join(outputDirectory,name),{mode:0o700,recursive:true});continue;}
        const match=/^owned\/([A-Za-z0-9._-]{2})\/([A-Za-z0-9._-]{2})\/([A-Za-z0-9._-]{4,})\.(blob|meta\.json)$/.exec(name);
        requireValue(match && match[1]!==".." && match[2]!==".." && match[3].slice(0,2)===match[1] &&
          match[3].slice(2,4)===match[2] && entry.type==="0" && entry.size>0,"monthly_restore_media_entry_invalid");
        total+=entry.size;requireValue(total<=maximumUnpackedBytes,"monthly_restore_media_size_excessive");
        entry.name=name;await mkdir(dirname(join(outputDirectory,name)),{mode:0o700,recursive:true});
        output=await open(join(outputDirectory,name),"wx",0o600);hashes[name]=createHash("sha256");
        body=entry.size;padding=(512-entry.size%512)%512;
      }
    }
    requireValue(hasEnded && zeroBlocks>=1024 && !body && !padding && Object.keys(inventory).length>0,"monthly_restore_media_incomplete");
    const names=Object.keys(inventory),blobs=names.filter(name=>name.endsWith(".blob"));
    requireValue(names.length===blobs.length*2 && blobs.every(name=>inventory[name.replace(/\.blob$/,".meta.json")]),
      "monthly_restore_media_pair_missing");
    await unchanged(pinned);return {files:inventory,completePairs:blobs.length,bytes:total,sha256:sha(canonical(inventory))};
  }finally{source.destroy();unpacked.destroy();if(output)await output.close();await pinned.file.close();}
}
