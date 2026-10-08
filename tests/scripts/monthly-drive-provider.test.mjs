import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, writeFile, readFile, open, chmod } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { dedicatedDriveProvider } from "../../deployment/monthly-drive-provider.mjs";

const owner="fixture@example.invalid",scope="https://www.googleapis.com/auth/drive.file";
const properties={kind:"yenhubs-monthly-portable-v1",instanceId:"fixture-monthly",month:"2026-10",operationId:"a".repeat(32)};
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{"content-type":"application/json"}});
const owned=(id,name,mimeType,parent)=>({id,name,mimeType,parents:parent?[parent]:[],ownedByMe:true,trashed:false,
  permissions:[{type:"user",role:"owner"}],version:"1"});
async function fixture() {
  const root=await realpath(await mkdtemp(join(tmpdir(),"yenhubs-drive-provider-")));
  const configPath=join(root,"config.conf"),installedClientPath=join(root,"client.json"),sourcePath=join(root,"ciphertext.age");
  const installed={project_id:"yenhubs-backups-20261006",client_id:"fixture.apps.googleusercontent.com",
    client_secret:"only-fixture-client-value",token_uri:"https://oauth2.googleapis.com/token"};
  const iniScope="drive.file",token={refresh_token:"only-fixture-refresh-value",access_token:"only-fixture-old-access"};
  await writeFile(installedClientPath,JSON.stringify({installed}),{mode:0o600});
  const configure=async(overrides={})=>{
    const values={type:"drive",scope:iniScope,client_id:installed.client_id,client_secret:installed.client_secret,
      token:JSON.stringify(token),...overrides};
    await writeFile(configPath,"[yenhubs-monthly]\n"+Object.entries(values).map(([key,value])=>`${key} = ${value}\n`).join(""),{mode:0o600});
  };
  await configure();const original=Buffer.from("age-encryption.org/v1\nONLY A TRANSPORT FIXTURE");
  await writeFile(sourcePath,original,{mode:0o600});
  const calls=[],controls={},files=new Map();let sequence=0;
  const fetchImpl=async(input,options={})=>{
    const url=new URL(input);calls.push({url,options});assert.equal(options.redirect,"error");assert.ok(options.signal);
    if(url.origin==="https://oauth2.googleapis.com") {
      if(controls.refreshError)throw new Error("only-fixture-refresh-value-DO-NOT-ECHO");
      if(controls.refreshStatus)return json({error:"only-fixture-client-value-DO-NOT-ECHO"},controls.refreshStatus);
      return json({access_token:"only-fixture-new-access",token_type:"Bearer",expires_in:3600,scope:controls.refreshScope??scope});
    }
    assert.equal(url.origin,"https://www.googleapis.com");
    assert.equal(options.headers.authorization,"Bearer only-fixture-new-access");
    if(url.pathname==="/drive/v3/about")return json({user:{emailAddress:controls.owner??owner}});
    if(url.pathname==="/drive/v3/files" && options.method==="POST") {
      if(controls.createError)throw new Error("only-fixture-client-value-DO-NOT-ECHO");
      return json({...owned("folder",properties.instanceId+"-"+properties.month,"application/vnd.google-apps.folder","root"),appProperties:properties});
    }
    if(url.pathname==="/drive/v3/files")return json({files:[],...(controls.pagination?{nextPageToken:"fixture-next-page"}:{})});
    if(url.pathname==="/upload/drive/v3/files" && options.method==="POST") {
      if(controls.initError)throw new Error("only-fixture-refresh-value-DO-NOT-ECHO");
      if(controls.onInitiate)await controls.onInitiate();
      controls.uploadRequestMetadata=JSON.parse(options.body);
      return new Response(null,{status:200,headers:{location:controls.location??
        "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=fixture-session"}});
    }
    if(url.pathname==="/upload/drive/v3/files" && options.method==="PUT") {
      if(controls.uploadError)throw new Error("only-fixture-new-access-DO-NOT-ECHO");
      const chunks=[];if(!controls.skipBody)for await(const bytes of options.body)chunks.push(bytes);
      const data=Buffer.concat(chunks),metadata={...owned(`upload-${++sequence}`,controls.uploadRequestMetadata.name,
        controls.uploadRequestMetadata.mimeType,"folder"),
        size:String(data.length),md5Checksum:createHash("md5").update(data).digest("hex"),...controls.uploadMetadata};
      files.set(metadata.id,{metadata,data});return json(metadata);
    }
    const fileId=url.pathname.split("/").at(-1);
    if(url.searchParams.get("alt")==="media")return new Response(original);
    if(controls.invalidJson)return new Response("only-fixture-client-value-DO-NOT-ECHO");
    if(controls.largeResponse)return new Response("x".repeat(1024*1024+1));
    return json({...owned(fileId,"fixture-file","application/octet-stream","folder"),...controls.statMetadata});
  };
  const options={configPath,installedClientPath,expectedOwnerEmail:owner,fetchImpl};
  const withSource=async action=>{const file=await open(sourcePath,"r");try{return await action({file,path:sourcePath});}finally{await file.close();}};
  return {root,configPath,installedClientPath,sourcePath,original,calls,controls,files,options,configure,withSource,
    make:()=>dedicatedDriveProvider(options)};
}
test("dedicated owner and limited scope are checked before cached metadata reads",async()=>{
  const f=await fixture(),provider=await f.make();await provider.stat("first");await provider.stat("second");
  assert.equal(f.calls.filter(c=>c.url.pathname==="/token").length,1);
  const request=f.calls[0];assert.equal(request.url.href,"https://oauth2.googleapis.com/token");
  assert.equal(request.options.body.get("grant_type"),"refresh_token");
  assert.equal(request.options.body.get("client_id"),"fixture.apps.googleusercontent.com");
  assert.equal(f.calls[1].url.pathname,"/drive/v3/about");
});
test("broader configured scope is refused before any external request",async()=>{
  const f=await fixture();await f.configure({scope:"drive"});
  await assert.rejects(f.make(),/scope_or_client_changed/);assert.equal(f.calls.length,0);
});
test("a different OAuth client cannot be substituted",async()=>{
  const f=await fixture();await f.configure({client_id:"other.apps.googleusercontent.com"});
  await assert.rejects(f.make(),/scope_or_client_changed/);assert.equal(f.calls.length,0);
});
test("a client from another project is refused",async()=>{
  const f=await fixture(),client=JSON.parse(await readFile(f.installedClientPath));client.installed.project_id="another-project";
  await writeFile(f.installedClientPath,JSON.stringify(client));await assert.rejects(f.make(),/client_invalid/);
  assert.equal(f.calls.length,0);
});
test("a web OAuth credential cannot replace the installed credential",async()=>{
  const f=await fixture(),client=JSON.parse(await readFile(f.installedClientPath));client.web={};
  await writeFile(f.installedClientPath,JSON.stringify(client));await assert.rejects(f.make(),/client_invalid/);
  assert.equal(f.calls.length,0);
});
test("private credential permissions are enforced without echoing their contents",async()=>{
  const f=await fixture();await chmod(f.configPath,0o644);
  await assert.rejects(f.make(),error=>error.message==="drive_provider_config_unreadable");assert.equal(f.calls.length,0);
});
test("owner mismatch stops before any file mutation",async()=>{
  const f=await fixture();f.controls.owner="other@example.invalid";
  await assert.rejects(f.make(),/owner_mismatch/);assert.equal(f.calls.length,2);
});
test("the token server cannot silently widen drive.file",async()=>{
  const f=await fixture();f.controls.refreshScope="https://www.googleapis.com/auth/drive";
  await assert.rejects(f.make(),/refresh_scope_invalid/);assert.equal(f.calls.length,1);
});
test("refresh HTTP failure is bounded, redacted and never retried",async()=>{
  const f=await fixture();f.controls.refreshStatus=403;
  await assert.rejects(f.make(),error=>error.message==="drive_provider_http_403" && !String(error).includes("only-fixture"));
  assert.equal(f.calls.length,1);
});
test("ambiguous folder POST is never repeated or converted into success",async()=>{
  const f=await fixture(),provider=await f.make();f.controls.createError=true;
  await assert.rejects(provider.createFolder({parentId:"root",name:"fixture-monthly-2026-10",properties}),/failed_or_ambiguous/);
  assert.equal(f.calls.filter(c=>c.url.pathname==="/drive/v3/files" && c.options.method==="POST").length,1);
});
test("a paginated listing cannot pass as a closed complete listing",async()=>{
  const f=await fixture(),provider=await f.make();f.controls.pagination=true;
  await assert.rejects(provider.children("folder"),/listing_ambiguous/);
  assert.equal(f.calls.filter(c=>c.url.pathname==="/drive/v3/files").length,1);
});
test("a GET must return the requested ID, not another owned object",async()=>{
  const f=await fixture(),provider=await f.make();f.controls.statMetadata={id:"substituted"};
  await assert.rejects(provider.stat("requested"),/id_changed/);
});
test("invalid IDs and names never enter a Drive query",async()=>{
  const f=await fixture(),provider=await f.make(),before=f.calls.length;
  await assert.rejects(provider.stat("folder' or true"),/id_invalid/);
  await assert.rejects(provider.namedChildren("root","name' or true"),/name_invalid/);
  await assert.rejects(provider.createFolder({parentId:"root",name:"fixture-monthly-2026-10",properties:{...properties,secret:"fixture"}}),/properties_invalid/);
  assert.equal(f.calls.length,before);
});
test("upload only creates a new session and preserves exact pinned bytes",async()=>{
  const f=await fixture(),provider=await f.make();
  const result=await f.withSource(async source=>{
    const value=await provider.put({folderId:"folder",name:"database.dump.age",source,bytes:f.original.length});
    assert.equal((await source.file.stat()).size,f.original.length);return value;
  });
  assert.equal(result.id,"upload-1");assert.deepEqual(f.files.get(result.id).data,f.original);
  const upload=f.calls.filter(c=>c.url.pathname.startsWith("/upload/"));assert.deepEqual(upload.map(c=>c.options.method),["POST","PUT"]);
  assert.equal(upload[0].url.pathname,"/upload/drive/v3/files");
  assert.equal(upload[1].options.duplex,"half");assert.equal(upload[1].options.headers["content-length"],String(f.original.length));
  assert.ok(!f.calls.some(c=>["PATCH","DELETE"].includes(c.options.method)));
});
test("foreign upload session URL cannot receive credentials or content",async()=>{
  const f=await fixture(),provider=await f.make();f.controls.location="https://example.invalid/upload?upload_id=fixture";
  await f.withSource(source=>assert.rejects(provider.put({folderId:"folder",name:"database.dump.age",source,bytes:f.original.length}),/location_invalid/));
  assert.equal(f.calls.filter(c=>c.options.method==="PUT").length,0);
});
test("a wrong source size is refused before creating the upload session",async()=>{
  const f=await fixture(),provider=await f.make(),before=f.calls.length;
  await f.withSource(source=>assert.rejects(provider.put({folderId:"folder",name:"database.dump.age",source,bytes:f.original.length+1}),/source_changed/));
  assert.equal(f.calls.length,before);
});
test("a source truncated after session creation fails without retrying",async()=>{
  const f=await fixture(),provider=await f.make();f.controls.onInitiate=()=>writeFile(f.sourcePath,"SHORT FIXTURE");
  await f.withSource(source=>assert.rejects(provider.put({folderId:"folder",name:"database.dump.age",source,bytes:f.original.length}),/failed_or_ambiguous/));
  assert.equal(f.calls.filter(c=>c.options.method==="PUT").length,1);
});
test("an early HTTP success without reading the file is not upload acceptance",async()=>{
  const f=await fixture(),provider=await f.make();f.controls.skipBody=true;f.controls.uploadMetadata={size:String(f.original.length)};
  await f.withSource(source=>assert.rejects(provider.put({folderId:"folder",name:"database.dump.age",source,bytes:f.original.length}),/binding_changed/));
});
test("changed upload response binding is not accepted",async()=>{
  const f=await fixture(),provider=await f.make();f.controls.uploadMetadata={parents:["different-parent"]};
  await f.withSource(source=>assert.rejects(provider.put({folderId:"folder",name:"database.dump.age",source,bytes:f.original.length}),/binding_changed/));
});
test("an ambiguous upload failure exposes no token and causes no second PUT",async()=>{
  const f=await fixture(),provider=await f.make();f.controls.uploadError=true;
  await f.withSource(source=>assert.rejects(provider.put({folderId:"folder",name:"database.dump.age",source,bytes:f.original.length}),
    error=>error.message==="drive_provider_request_failed_or_ambiguous" && !String(error).includes("only-fixture")));
  assert.equal(f.calls.filter(c=>c.options.method==="PUT").length,1);
});
test("changed local credential scope is rechecked even with a cached access token",async()=>{
  const f=await fixture(),provider=await f.make(),before=f.calls.length;await f.configure({scope:"drive"});
  await f.withSource(source=>assert.rejects(provider.put({folderId:"folder",name:"database.dump.age",source,bytes:f.original.length}),/scope_or_client_changed/));
  assert.equal(f.calls.length,before);
});
test("malformed and oversized metadata are rejected without echoing body bytes",async()=>{
  const f=await fixture(),provider=await f.make();f.controls.invalidJson=true;
  await assert.rejects(provider.stat("file"),error=>error.message==="drive_provider_response_invalid");
  f.controls.invalidJson=false;f.controls.largeResponse=true;await assert.rejects(provider.stat("file"),/response_oversized/);
});
test("binary downloads use exact IDs and the dedicated bearer",async()=>{
  const f=await fixture(),provider=await f.make(),parts=[];
  for await(const bytes of await provider.content("requested-file"))parts.push(bytes);
  assert.deepEqual(Buffer.concat(parts),f.original);
  const request=f.calls.at(-1);assert.equal(request.url.pathname,"/drive/v3/files/requested-file");
  assert.equal(request.url.searchParams.get("alt"),"media");
});
test("the public receipt is sent and validated as JSON, not opaque binary",async()=>{
  const f=await fixture(),provider=await f.make();
  await f.withSource(source=>provider.put({folderId:"folder",name:"portable-point.json",source,bytes:f.original.length}));
  const upload=f.calls.filter(c=>c.url.pathname.startsWith("/upload/"));
  assert.equal(upload[0].options.headers["x-upload-content-type"],"application/json");
  assert.equal(upload[1].options.headers["content-type"],"application/json");
  assert.equal(f.files.get("upload-1").metadata.mimeType,"application/json");
});
