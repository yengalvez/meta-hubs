import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { runMonthlyBackup, validateMonthlyRuntimeConfiguration, verifyMonthlyLocalDependencies,
  runMonthlyLiveVerification, MONTHLY_LIVE_OBSERVATION_TIMEOUT_MS } from "../../deployment/monthly-backup-runtime.mjs";
import { portableDriveNames } from "../../deployment/monthly-drive-store.mjs";
import { monthlyVerificationInputs, runMonthlyVerification } from "../../deployment/monthly-verification.mjs";

const hash=(value,algorithm="sha256")=>createHash(algorithm).update(value).digest("hex");
const uid=n=>`00000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const instanceId="fixture-monthly",month="2026-10",operationId="a".repeat(32),recipient="age1"+"a".repeat(58),manifestSha256="b".repeat(64);
async function fixture() {
  const root=await realpath(await mkdtemp(join(tmpdir(),"yenhubs-monthly-runtime-fixture-"))),configPath=join(root,"config.json");
  const code={root:"c".repeat(40),hubs:"d".repeat(40),cloud:"e".repeat(40)},paths={};
  const candidate={schema:"yenhubs-monthly-candidate-v1",clean:true,code,
    inputs:Object.fromEntries(monthlyVerificationInputs.map(path=>[path,hash("ONLY FIXTURE: "+path)]))};
  for(const name of ["values","manifest","cutoverKey","recipient","keyCustody","driveClient","driveConfig","driveRuntime","acceptance"]) {
    paths[name]=join(root,name+".fixture");await writeFile(paths[name],name==="recipient"?recipient+"\n":"ONLY FIXTURE: "+name,{mode:0o600});
  }
  const custody={schema:"yenhubs-recovery-key-custody-v1",recipient,state:"independent-copy-decryption-verified",locationKind:"usb",
    nativeExitCode:0,challengeSha256:"f".repeat(64),verifiedAt:"2026-10-08T00:00:00Z"};
  const evidenceDirectory=join(root,"verification");await mkdir(evidenceDirectory,{mode:0o700});
  // Deliberately simulated local receipts. Native admission recomputes actual
  // HEAD blobs and cannot accept these fixture commits/content hashes.
  const monthly=await runMonthlyVerification({evidenceDirectory,inspect:async()=>candidate,run:async check=>{
    const count=check.expectedTests??3;
    return {nativeExitCode:0,signal:null,nativeCloseObserved:true,processRetirement:{
      schema:"yenhubs-monthly-test-process-retirement-v1",coverage:"observed-lineage",absenceVerified:true,
      observationUnproven:false,registered:1,termSent:0,killSent:0,remaining:[]},
      timedOut:false,interrupted:false,outputLimitExceeded:false,launchFailed:false,
      durationMilliseconds:1,stderr:"",stdout:"TAP version 13\n"+
      (check.requiredDiagnostics??[]).map(value=>"# "+JSON.stringify({...value,actualCaptureAccepted:false})+"\n").join("")+
      `# tests ${count}\n# pass ${count}\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n`};
  }});
  const acceptance={schema:"yenhubs-monthly-runtime-acceptance-v2",instanceId,recipient,code,monthly,restores:{}};
  const driveRuntime={ownerOnlyVerified:true,folderId:"fixture-root",expectedOwnerEmail:"fixture@example.invalid"};
  const config={schema:"yenhubs-monthly-runtime-v1",instanceId,timezone:"Europe/Madrid",context:"do-ams3-hubs-ce",region:"ams3",namespace:"hcce",
    namespaceUid:uid(1),retPvcUid:uid(2),databasePvcUid:uid(3),code,paths,stateRoot:root,
    schedule:{enabled:false,frequency:"monthly"},budgets:{temporaryUSD:1,monthlyEUR:5},maximumSourceGiB:20};
  const json=async(path,value)=>writeFile(path,JSON.stringify(value),{mode:0o600});
  await json(configPath,config);await json(paths.keyCustody,custody);await json(paths.acceptance,acceptance);await json(paths.driveRuntime,driveRuntime);
  const source={context:config.context,instanceId,namespace:{uid:uid(1)},volumes:{
    database:{pvcUid:uid(3),pvUid:uid(4),volumeId:uid(5),sizeGiB:10},media:{pvcUid:uid(2),pvUid:uid(6),volumeId:uid(7),sizeGiB:10}}};
  const pair={schema:"yenhubs-native-monthly-pair-v1",state:"captured-not-restore-accepted",context:config.context,
    namespace:{uid:uid(1)},instanceId,month,operationId,startedAt:"2026-10-08T00:00:00Z",capturedAt:"2026-10-08T00:00:05Z",snapshots:{}};
  for(const role of ["database","media"])pair.snapshots[role]={id:uid(role==="database"?8:9),name:`${instanceId}-${month}-${role}`,
    volumeId:source.volumes[role].volumeId,region:"ams3",createdAt:"2026-10-08T00:00:02Z",minimumDiskGiB:10,billableGiB:1};
  const point={source,pair,manifestSha256},files={},handles={},versions={};
  for(const name of portableDriveNames){const data="ONLY FIXTURE: "+name;files[name]={bytes:Buffer.byteLength(data),sha256:hash(data),md5:hash(data,"md5")};
    handles[name]=name.replaceAll(".","-");versions[name]="1";}
  const driveReceipt={schema:"yenhubs-drive-point-readback-v1",state:"transport-verified-not-restore-accepted",instanceId,month,operationId,
    folderId:"fixture-point-folder",files,handles,versions,sha256:hash(JSON.stringify(files))};
  const calls=[],controls={},drive={async stat(id){return {id,mimeType:"application/vnd.google-apps.folder",ownedByMe:true,
    trashed:false,permissions:controls.sharedRoot?[{type:"user",role:"owner"},{type:"anyone",role:"reader"}]:[{type:"user",role:"owner"}]};}};
  const operations={
    async code(){calls.push("code");return controls.changedCode?{...candidate,code:{...code,root:"9".repeat(40)}}:candidate;},
    async drive(){calls.push("drive");return drive;},
    async live(){calls.push("live");return {nativeExitCode:controls.liveExit??0,failures:0,warnings:0,stdoutSha256:manifestSha256};},
    async source(){calls.push("source");return controls.oversize?{...source,volumes:{...source.volumes,database:{...source.volumes.database,sizeGiB:11}}}:source;},
    async capture(args){calls.push("capture");assert.equal(args.environment.CHECKPOINT_BACKEND,"native-monthly");
      assert.equal(args.environment.CHECKPOINT_FORMAT,"native-monthly-v1");assert.equal(args.environment.VALUES_FILE,paths.values);
      if(controls.captureNativeError)throw controls.captureNativeError;
      if(controls.failCapture)throw Error("export_capture_failed_or_ambiguous");
      return {schema:"yenhubs-monthly-capture-completion-v1",state:"native-command-complete-not-restore-accepted",nativeExitCode:controls.captureExit??0,
        instanceId,month,directory:args.checkpointDirectory};},
    async inspect(){calls.push("inspect");return point;},
    async export(args){calls.push("export");if(controls.failExport)throw Error("export_remote_payload_changed");
      return {schema:"yenhubs-monthly-snapshot-export-v1",state:"sealed-not-restore-accepted",binding:{instanceId,month,operationId},
        nativeExportExitCode:0,cloneCleanupVerified:true,nativeManifestSha256:manifestSha256,packageDirectory:join(args.outputDirectory,"sealed"),
        ciphertexts:Object.fromEntries(portableDriveNames.filter(name=>name.endsWith(".age")).map(name=>[name,
          {bytes:files[name].bytes,sha256:controls.wrongExportHash?"0".repeat(64):files[name].sha256}]))};},
    async publish(){calls.push("publish");if(controls.failPublish)throw Error("drive_transfer_failed_or_ambiguous");
      if(controls.mutateInput)await writeFile(paths.values,"ONLY CHANGED FIXTURE",{mode:0o600});return driveReceipt;},
    async rotate(args){calls.push("rotate");assert.equal(args.points.length,1);return {schema:"yenhubs-monthly-retention-result-v1",
      state:"rotation-complete",instanceId,month:controls.wrongRotationMonth?"2026-09":month,operationId,retired:{digitalOcean:[],googleDrive:[]}};},
    async reconcile(){calls.push("reconcile");if(controls.failReconcile)throw Error("retention_drive_file_changed");return {state:"existing-point-identities-verified"};}
  };
  const enable=async()=>{config.schedule.enabled=true;for(const route of ["digitalOcean","googleDrive"])acceptance.restores[route]={nativeExitCode:0,
    state:"isolated-restore-accepted",evidenceSha256:"2".repeat(64)};await json(configPath,config);await json(paths.acceptance,acceptance);};
  return {root,configPath,config,paths,custody,acceptance,driveRuntime,code,candidate,calls,controls,operations,source,json,enable,
    run:mode=>runMonthlyBackup({configPath,mode:mode??"validation",operations,now:()=>new Date("2026-10-08T03:00:00Z")})};
}
test("validation joins every component once, measures phases and does not rotate or claim real restore",async()=>{
  const f=await fixture(),r=await f.run();assert.equal(r.state,"captured-exported-not-restore-accepted");assert.equal(r.nativeExitCode,0);
  assert.deepEqual(f.calls,["code","drive","live","source","capture","inspect","export","publish","live"]);
  assert.equal((await readdir(join(f.root,"points"))).length,1);assert.deepEqual(await readdir(join(f.root,"rotations")),[]);
  assert.ok(Object.keys(r.timings).includes("capture"));assert.ok(r.timings.totalMilliseconds>=0);
  const completed=JSON.parse(await readFile(join(f.root,"attempts",month,"completed.json")));assert.equal(completed.nativeExitCode,0);
});
test("monthly runtime format passes only the fixed monthly entrypoint selection gates",async()=>{
  const f=await fixture(),source=await readFile(new URL("../../deployment/create-monthly-snapshot.sh",import.meta.url),"utf8");
  const begin=source.indexOf('[[ "${CHECKPOINT_BACKEND-native-monthly}"');
  const end=source.indexOf('\n[[ "$#"',begin);
  assert.ok(begin>=0 && end>begin);
  const selection=source.slice(begin,end);
  // Execute only the original two local selection guards: no inventory, Lease,
  // directories, provider command, pause or snapshot can run in this test.
  assert.doesNotMatch(selection,/\b(?:kubectl|doctl|mkdir|source|node|eval)\b/);
  const capture=f.operations.capture;
  f.operations.capture=async args=>{
    const selected=Object.fromEntries(["CHECKPOINT_FORMAT","CHECKPOINT_BACKEND","MONTHLY_INSTANCE_ID",
      "MONTHLY_REGION","MONTHLY_JOURNAL_ROOT"].map(name=>[name,args.environment[name]]));
    const original=spawnSync("/bin/bash",["-c",selection],{env:selected,encoding:"utf8",timeout:5000});
    assert.equal(original.error,undefined);
    assert.equal(original.signal,null);
    if(original.status!==0)throw Error("checkpoint_startup_selection_native_exit_"+original.status);
    return capture(args);
  };
  const result=await f.run();
  assert.equal(result.nativeExitCode,0);
  assert.equal(f.calls.filter(name=>name==="capture").length,1);
});
test("enabled scheduled mode requires both restore proofs before any provider effect",async()=>{
  const f=await fixture();f.config.schedule.enabled=true;await f.json(f.configPath,f.config);
  await assert.rejects(f.run("scheduled"),/monthly_runtime_schedule_not_accepted/);assert.deepEqual(f.calls,["code"]);
});
test("accepted scheduled mode runs the protected rotation after successful capture/readback/live",async()=>{
  const f=await fixture();await f.enable();const r=await f.run("scheduled");assert.equal(r.state,"monthly-point-complete");
  assert.equal(f.calls.at(-1),"rotate");assert.equal((await readdir(join(f.root,"rotations"))).length,1);
});
test("the local recovery key alone is not custody proof and cannot trigger a capture",async()=>{
  const f=await fixture();f.custody.state="local-key-only";await f.json(f.paths.keyCustody,f.custody);
  await assert.rejects(f.run(),/monthly_runtime_key_custody_unproven/);assert.deepEqual(f.calls,["code"]);
});
test("changed root/subrepo bytes cannot borrow earlier final acceptance",async()=>{
  const f=await fixture();f.controls.changedCode=true;
  await assert.rejects(f.run(),/monthly_runtime_code_changed/);assert.deepEqual(f.calls,["code"]);
});
test("an old fifteen-section full receipt cannot substitute for exact monthly proof",async()=>{
  const f=await fixture();delete f.acceptance.monthly;
  f.acceptance.full={nativeExitCode:0,validReceipts:15,evidenceSha256:"1".repeat(64)};
  await f.json(f.paths.acceptance,f.acceptance);
  await assert.rejects(f.run(),/monthly_runtime_monthly_code_gate_unproven/);assert.deepEqual(f.calls,["code"]);
});
test("changed monthly proof or source bytes stop before credentials or pause",async()=>{
  for(const change of ["proof","input"]) {
    const f=await fixture();
    if(change==="proof")await f.json(f.acceptance.monthly.evidencePath,{schema:"tampered"});
    else f.candidate.inputs[monthlyVerificationInputs[0]]="0".repeat(64);
    await assert.rejects(f.run(),/monthly_verification_(evidence_changed|proof_stale_or_invalid)/);
    assert.deepEqual(f.calls,["code"]);
  }
});
test("missing monthly proof stops before any provider effect",async()=>{
  const f=await fixture();f.acceptance.monthly.evidencePath=join(f.root,"missing-proof.json");
  await f.json(f.paths.acceptance,f.acceptance);
  await assert.rejects(f.run(),{code:"ENOENT"});assert.deepEqual(f.calls,["code"]);
});
test("larger/new source exceeds the approved preparation before a real snapshot command",async()=>{
  const f=await fixture();f.controls.oversize=true;
  await assert.rejects(f.run(),/monthly_runtime_source_identity_or_budget_changed/);assert.ok(!f.calls.includes("capture"));
  await assert.rejects(f.run(),/monthly_runtime_previous_attempt_unresolved/);assert.ok(!f.calls.includes("capture"));
});
test("capture failure is not hidden, retried or converted into export/rotation",async()=>{
  const f=await fixture();f.controls.failCapture=true;
  await assert.rejects(f.run(),/export_capture_failed_or_ambiguous/);assert.equal(f.calls.filter(c=>c==="capture").length,1);
  assert.ok(!f.calls.includes("export"));assert.deepEqual(await readdir(join(f.root,"points")),[]);
  await assert.rejects(f.run(),/monthly_runtime_previous_attempt_unresolved/);assert.equal(f.calls.filter(c=>c==="capture").length,1);
});
test("original bounded native capture failure survives the failed-attempt journal and thrown error",async()=>{
  const f=await fixture();f.controls.captureNativeError=Object.assign(Error("export_capture_failed_or_ambiguous"),
    {nativeExitCode:23,nativeSignal:null,nativeKilled:false,stderr:"NOT SAFE TO LOG"});
  await assert.rejects(f.run(),error=>error.nativeExitCode===23 && error.nativeSignal===null && error.nativeKilled===false);
  const log=await readFile(join(f.root,"attempts",month,"events.jsonl"),"utf8");
  const terminal=log.trim().split("\n").map(JSON.parse).at(-1);
  assert.equal(terminal.nativeExitCode,23);assert.equal(terminal.nativeSignal,null);assert.equal(terminal.nativeKilled,false);
  assert.doesNotMatch(log,/NOT SAFE TO LOG/);
  await assert.rejects(f.run(),/monthly_runtime_previous_attempt_unresolved/);
  assert.equal(f.calls.filter(c=>c==="capture").length,1);
});
test("unknown native failure fields are never invented or copied from untrusted output",async()=>{
  const f=await fixture();f.controls.captureNativeError=Object.assign(Error("export_capture_failed_or_ambiguous"),
    {nativeExitCode:"1",nativeSignal:"private payload",nativeKilled:"true"});
  await assert.rejects(f.run(),error=>!("nativeExitCode" in error) && !("nativeSignal" in error) && !("nativeKilled" in error));
  const terminal=JSON.parse((await readFile(join(f.root,"attempts",month,"events.jsonl"),"utf8")).trim().split("\n").at(-1));
  assert.ok(!("nativeExitCode" in terminal) && !("nativeSignal" in terminal) && !("nativeKilled" in terminal));
});
test("a nonzero original capture exit cannot borrow a published bundle",async()=>{
  const f=await fixture();f.controls.captureExit=1;
  await assert.rejects(f.run(),/monthly_runtime_capture_exit_unproven/);assert.ok(!f.calls.includes("inspect"));
});
test("failed multimedia clone export stops before Drive and preserves the first cause",async()=>{
  const f=await fixture();f.controls.failExport=true;
  await assert.rejects(f.run(),/export_remote_payload_changed/);assert.ok(!f.calls.includes("publish"));
  assert.match(await readFile(join(f.root,"attempts",month,"events.jsonl"),"utf8"),/export_remote_payload_changed/);
});
test("Drive failure never retires an old point or records a completed month",async()=>{
  const f=await fixture();await f.enable();f.controls.failPublish=true;
  await assert.rejects(f.run("scheduled"),/drive_transfer_failed_or_ambiguous/);assert.ok(!f.calls.includes("rotate"));
  assert.deepEqual(await readdir(join(f.root,"points")),[]);
});
test("changed protected input during transport prevents a complete point and rotation",async()=>{
  const f=await fixture();await f.enable();f.controls.mutateInput=true;
  await assert.rejects(f.run("scheduled"),/monthly_runtime_input_changed/);assert.ok(!f.calls.includes("rotate"));
  assert.deepEqual(await readdir(join(f.root,"points")),[]);
});
test("existing successful month is freshly reconciled, never captured twice",async()=>{
  const f=await fixture();await f.run();const r=await f.run();assert.equal(r.state,"existing-month-identities-verified");
  assert.equal(r.backupCreated,false);assert.equal(f.calls.filter(c=>c==="capture").length,1);assert.equal(f.calls.at(-1),"reconcile");
});
test("missing existing month bytes cannot be accepted by a completion file",async()=>{
  const f=await fixture();await f.run();f.controls.failReconcile=true;
  await assert.rejects(f.run(),/retention_drive_file_changed/);assert.equal(f.calls.filter(c=>c==="capture").length,1);
});
test("a warning/failure from original live verifier stops before any pause",async()=>{
  const f=await fixture();f.controls.liveExit=1;
  await assert.rejects(f.run(),/monthly_runtime_live_not_accepted/);assert.ok(!f.calls.includes("source"));assert.ok(!f.calls.includes("capture"));
});
test("configuration refuses another cluster, expanded costs and foreign locations",()=>{
  const config={schema:"invalid"};assert.throws(()=>validateMonthlyRuntimeConfiguration(config),/configuration_invalid/);
});
test("changed destination sharing is detected before a snapshot/pause",async()=>{
  const f=await fixture();f.controls.sharedRoot=true;
  await assert.rejects(f.run(),/monthly_runtime_drive_root_changed/);assert.deepEqual(f.calls,["code","drive"]);
});
test("Drive readback of another encrypted export cannot become a retained point",async()=>{
  const f=await fixture();f.controls.wrongExportHash=true;
  await assert.rejects(f.run(),/retention_export_receipt_invalid/);assert.deepEqual(await readdir(join(f.root,"points")),[]);
});
test("a rotation receipt for another month cannot complete the scheduled attempt",async()=>{
  const f=await fixture();await f.enable();f.controls.wrongRotationMonth=true;
  await assert.rejects(f.run("scheduled"),/monthly_runtime_rotation_unproven/);
  assert.deepEqual(await readdir(join(f.root,"rotations")),[]);
  await assert.rejects(f.run("scheduled"),/monthly_runtime_previous_attempt_unresolved/);
  assert.equal(f.calls.filter(c=>c==="capture").length,1);
});

test("the permanent operator rejects missing or malformed yaml before native monthly work",()=>{
  assert.throws(()=>verifyMonthlyLocalDependencies(()=>{throw Error("MODULE_NOT_FOUND");}),/local_dependency_missing/);
  for(const yaml of [null,{}, {parse(){}}, {stringify(){}}])
    assert.throws(()=>verifyMonthlyLocalDependencies(()=>yaml),/local_dependency_invalid/);
  const required=[];
  assert.equal(verifyMonthlyLocalDependencies(name=>{required.push(name);return {parse(){},stringify(){}};}).state,
    "required-local-dependencies-present");
  assert.deepEqual(required,["yaml"]);
});
test("the read-only acceptance scan has a finite budget covering the observed 132310ms and keeps exact inputs",async()=>{
  const f=await fixture();let calls=0;
  const result=await runMonthlyLiveVerification(f.config,{async run(program,args,options){
    calls++;assert.match(program,/\/deployment\/verify-live-reactivation\.sh$/);assert.deepEqual(args,[]);
    assert.equal(options.timeout,MONTHLY_LIVE_OBSERVATION_TIMEOUT_MS);assert.equal(options.timeout,300000);
    assert.ok(options.timeout>132310);
    assert.equal(options.env.EXPECTED_KUBE_CONTEXT,f.config.context);
    assert.equal(options.env.NAMESPACE,f.config.namespace);
    assert.equal(options.env.EXPECTED_NAMESPACE_UID,f.config.namespaceUid);
    assert.equal(options.env.EXPECTED_RET_PVC_UID,f.config.retPvcUid);
    assert.equal(options.env.VALUES_FILE,f.paths.values);
    assert.equal(options.env.HCCE_MANIFEST_PATH,f.paths.manifest);
    assert.equal(options.env.PROCESS_LOCAL_CUTOVER_KEY_PATH,f.paths.cutoverKey);
    return {nativeExitCode:0,stdout:"Summary: 0 failure(s), 0 warning(s)\n"};
  }});
  assert.equal(calls,1);assert.equal(result.nativeExitCode,0);assert.equal(result.failures,0);assert.equal(result.warnings,0);
  assert.match(result.stdoutSha256,/^[a-f0-9]{64}$/);
});
test("the read-only observer never accepts nonzero exits, warnings or absent summaries",async()=>{
  const f=await fixture();
  for(const result of [
    {nativeExitCode:1,stdout:"Summary: 0 failure(s), 0 warning(s)\n"},
    {nativeExitCode:0,stdout:"Summary: 1 failure(s), 0 warning(s)\n"},
    {nativeExitCode:0,stdout:"Summary: 0 failure(s), 1 warning(s)\n"},
    {nativeExitCode:0,stdout:""}, {nativeExitCode:0,stdout:null}
  ]) await assert.rejects(runMonthlyLiveVerification(f.config,{async run(){return result;}}),/live_not_accepted/);
});
test("an ambiguous or timed-out read-only native observation is not retried or accepted",async()=>{
  const f=await fixture();let calls=0;
  await assert.rejects(runMonthlyLiveVerification(f.config,{async run(){calls++;throw Error("export_native_command_failed_or_ambiguous");}}),
    /export_native_command_failed_or_ambiguous/);
  assert.equal(calls,1);
});
