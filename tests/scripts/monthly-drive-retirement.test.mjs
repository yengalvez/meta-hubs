import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dedicatedDriveProvider } from "../../deployment/monthly-drive-provider.mjs";

async function fixture(allowRetentionTrash=true) {
  const root=await realpath(await mkdtemp(join(tmpdir(),"yenhubs-trash-fixture-")));
  const installed={project_id:"yenhubs-backups-20261006",client_id:"fixture.apps.googleusercontent.com",
    client_secret:"only-fixture-client",token_uri:"https://oauth2.googleapis.com/token"};
  const installedClientPath=join(root,"client.json"),configPath=join(root,"config.conf");
  await writeFile(installedClientPath,JSON.stringify({installed}),{mode:0o600});
  await writeFile(configPath,`[yenhubs-monthly]\ntype = drive\nscope = drive.file\nclient_id = ${installed.client_id}\nclient_secret = ${installed.client_secret}\ntoken = {"refresh_token":"only-fixture-refresh"}\n`,{mode:0o600});
  const expected={id:"fixture-file",folderId:"fixture-folder",name:"database.dump.age",version:"7",bytes:42,md5:"a".repeat(32)};
  const file={id:expected.id,name:expected.name,parents:[expected.folderId],mimeType:"application/octet-stream",version:"7",
    size:"42",md5Checksum:expected.md5,ownedByMe:true,trashed:false,permissions:[{type:"user",role:"owner"}],capabilities:{canTrash:true}};
  const calls=[],controls={};
  const json=value=>new Response(JSON.stringify(value),{status:200,headers:{"content-type":"application/json"}});
  const provider=await dedicatedDriveProvider({configPath,installedClientPath,expectedOwnerEmail:"fixture@example.invalid",allowRetentionTrash,
    fetchImpl:async(input,options={})=>{
      const url=new URL(input);calls.push({url,options});
      if(url.origin==="https://oauth2.googleapis.com")return json({access_token:"only-fixture-access",token_type:"Bearer",expires_in:3600,
        scope:"https://www.googleapis.com/auth/drive.file"});
      if(url.pathname==="/drive/v3/about")return json({user:{emailAddress:"fixture@example.invalid"}});
      assert.equal(url.pathname,"/drive/v3/files/"+expected.id);
      if(options.method==="PATCH") {
        assert.deepEqual(JSON.parse(options.body),{trashed:true});
        if(controls.failPatch)throw Error("only-fixture-secret-DO-NOT-PRINT");
        file.trashed=true;file.version="8";
        if(controls.malformedVersion)return json({...file,version:"only-fixture-secret-DO-NOT-PRINT"});
        if(controls.alterResponse)return json({...file,name:"owner-unrelated.txt"});
      }
      return json(file);
    }});
  return {provider,expected,file,calls,controls};
}
test("retention uses one recoverable exact-file PATCH and original response/readback",async()=>{
  const f=await fixture(), result=await f.provider.trashVerifiedFile(f.expected);
  assert.equal(result.trashed,true);assert.equal(result.nativeHttpStatus,200);
  assert.equal(f.calls.filter(c=>c.options.method==="PATCH").length,1);
  assert.ok(!f.calls.some(c=>c.options.method==="DELETE" || c.url.pathname.endsWith("/trash")));
});
test("default upload provider has no retirement authority",async()=>{
  const f=await fixture(false), before=f.calls.length;
  await assert.rejects(f.provider.trashVerifiedFile(f.expected),/retention_arguments_invalid/);assert.equal(f.calls.length,before);
});
test("changed remote version never reaches PATCH",async()=>{
  const f=await fixture();f.file.version="8";
  await assert.rejects(f.provider.trashVerifiedFile(f.expected),/retirement_file_changed/);
  assert.equal(f.calls.filter(c=>c.options.method==="PATCH").length,0);
});
test("folder and non-backup filename cannot be trashed",async()=>{
  const f=await fixture();await assert.rejects(f.provider.trashVerifiedFile({...f.expected,name:"owner-file.txt"}),/arguments_invalid/);
  f.file.mimeType="application/vnd.google-apps.folder";
  await assert.rejects(f.provider.trashVerifiedFile(f.expected),/retirement_file_changed/);
  assert.equal(f.calls.filter(c=>c.options.method==="PATCH").length,0);
});
test("ambiguous trash error preserves its single attempt and never prints credentials",async()=>{
  const f=await fixture();f.controls.failPatch=true;
  await assert.rejects(f.provider.trashVerifiedFile(f.expected),e=>e.message==="drive_provider_request_failed_or_ambiguous"&&!String(e).includes("only-fixture"));
  assert.equal(f.calls.filter(c=>c.options.method==="PATCH").length,1);
});
test("changed trash response is not accepted as retirement",async()=>{
  const f=await fixture();f.controls.alterResponse=true;
  await assert.rejects(f.provider.trashVerifiedFile(f.expected),/retirement_response_changed/);
  assert.equal(f.calls.filter(c=>c.options.method==="PATCH").length,1);
});
test("malformed provider version cannot leak response bytes through BigInt errors",async()=>{
  const f=await fixture();f.controls.malformedVersion=true;
  await assert.rejects(f.provider.trashVerifiedFile(f.expected),e=>e.message==="drive_provider_retirement_response_changed"&&!String(e).includes("only-fixture"));
  assert.equal(f.calls.filter(c=>c.options.method==="PATCH").length,1);
});
