/** One monthly attempt: minimal snapshots -> resume -> frozen export -> Drive. */
import { lstat, realpath, mkdir, readdir, open } from "node:fs/promises";
import { resolve, join, dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { createRequire } from "node:module";
import { civilMonth } from "./monthly-backup-retention.mjs";
import { captureMonthlyForExport, inspectPublishedMonthlyPoint, exportMonthlySnapshotPoint } from "./monthly-snapshot-export.mjs";
import { nativeSnapshotExportProvider, runExportNative } from "./monthly-snapshot-export-provider.mjs";
import { dedicatedDriveProvider } from "./monthly-drive-provider.mjs";
import { publishSealedDrivePoint } from "./monthly-drive-store.mjs";
import { monthlyRetentionRecord, executeMonthlyRetention, nativeRetentionSnapshots,
  verifyRetentionPair, verifyRetentionDriveMetadata } from "./monthly-retention-executor.mjs";
import { readPrivateBytes, readPrivateSource } from "./monthly-snapshot-worker.mjs";
import { inspectMonthlyCandidate, readMonthlyVerification } from "./monthly-verification.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const requireValue = (value, reason) => { if (!value) throw new Error(reason); };
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const shaPattern = /^[a-f0-9]{40}$/;
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const monthPattern = /^\d{4}-(0[1-9]|1[0-2])$/;
const pathNames = ["values","manifest","cutoverKey","recipient","keyCustody","driveClient","driveConfig","driveRuntime","acceptance"];
// This bounds a read-only acceptance scan BEFORE quiescence or AFTER resume.
// It does not change checkpoint watches, PGSQL guards or their 30/10s deadlines.
export const MONTHLY_LIVE_OBSERVATION_TIMEOUT_MS = 300000;
export function verifyMonthlyLocalDependencies(load = createRequire(join(root,"hubs-cloud/community-edition/package.json"))) {
  let yaml;
  try { yaml = load("yaml"); }
  catch { throw new Error("monthly_runtime_local_dependency_missing"); }
  requireValue(typeof yaml?.parse === "function" && typeof yaml?.stringify === "function",
    "monthly_runtime_local_dependency_invalid");
  return {state:"required-local-dependencies-present",dependencies:["yaml"]};
}
export async function runMonthlyLiveVerification(config, {run=runExportNative}={}) {
  const result=await run(join(root,"deployment/verify-live-reactivation.sh"),[],{
    timeout:MONTHLY_LIVE_OBSERVATION_TIMEOUT_MS,
    env:{...process.env,EXPECTED_KUBE_CONTEXT:config.context,NAMESPACE:config.namespace,
      EXPECTED_NAMESPACE_UID:config.namespaceUid,EXPECTED_RET_PVC_UID:config.retPvcUid,
      VALUES_FILE:config.paths.values,HCCE_MANIFEST_PATH:config.paths.manifest,
      PROCESS_LOCAL_CUTOVER_KEY_PATH:config.paths.cutoverKey}
  });
  requireValue(result.nativeExitCode===0 && typeof result.stdout === "string" &&
    /Summary:\s*0 failure\(s\),\s*0 warning\(s\)/.test(result.stdout), "monthly_runtime_live_not_accepted");
  return {nativeExitCode:result.nativeExitCode,failures:0,warnings:0,stdoutSha256:digest(result.stdout)};
}
/** Monthly health is two Kubernetes reads and an HTTP check, not a product audit. */
export async function runMonthlyServiceHealth(config, { run = runExportNative, request = fetch } = {}) {
  const kube = ["--context", config.context, "--request-timeout=20s"];
  const [ns, deployments] = await Promise.all([
    run("kubectl", [...kube, "get", "namespace", config.namespace, "-o", "json"]),
    run("kubectl", [...kube, "-n", config.namespace, "get", "deployments", "-o", "json"])
  ]);
  const namespace = JSON.parse(ns.stdout), list = JSON.parse(deployments.stdout);
  requireValue(namespace.metadata?.uid === config.namespaceUid && Array.isArray(list.items) && list.items.length > 0 &&
    list.items.every(item => Number(item.status?.readyReplicas || 0) === Number(item.spec?.replicas || 0) &&
      item.status?.observedGeneration >= item.metadata.generation), "monthly_runtime_service_not_ready");
  const response = await request("https://meta-hubs.org/VJopCY3", { signal: AbortSignal.timeout(10000) });
  await response.body?.cancel();
  requireValue(response.status === 200, "monthly_runtime_room_unavailable");
  return { state: "monthly-service-ready", nativeExitCode: 0, failures: 0, warnings: 0,
    stdoutSha256: digest(JSON.stringify({ namespaceUid: config.namespaceUid, deployments: list.items.length, status: response.status })) };
}
async function privateDirectory(path) {
  requireValue(isAbsolute(path) && resolve(path) === path && await realpath(path) === path, "monthly_runtime_directory_not_canonical");
  const stat = await lstat(path);
  requireValue(stat.isDirectory() && stat.uid === process.getuid() && (stat.mode & 0o777) === 0o700,
    "monthly_runtime_directory_not_private");
}
async function writeJson(path, value) {
  const handle = await open(path,"wx",0o600);
  try { await handle.writeFile(JSON.stringify(value)+"\n");await handle.sync(); } finally {await handle.close();}
  const parent = await open(dirname(path),"r");try {await parent.sync();}finally{await parent.close();}
}
async function ensureDirectory(path) {
  try {await mkdir(path,{mode:0o700});}catch(error){if(error.code!=="EEXIST")throw error;}
  await privateDirectory(path);
  const parent=await open(dirname(path),"r");try{await parent.sync();}finally{await parent.close();}
}
export function validateMonthlyRuntimeConfiguration(config) {
  requireValue(config?.schema === "yenhubs-monthly-runtime-v1" && /^[a-z0-9][a-z0-9-]{0,62}$/.test(config.instanceId ?? "") &&
    config.timezone === "Europe/Madrid" && config.context === "do-ams3-hubs-ce" && config.region === "ams3" &&
    config.namespace === "hcce" && [config.namespaceUid,config.retPvcUid,config.databasePvcUid].every(value=>uuidPattern.test(value ?? "")) &&
    ["root","hubs","cloud"].every(name=>shaPattern.test(config.code?.[name] ?? "")) &&
    typeof config.schedule?.enabled === "boolean" && config.schedule.frequency === "monthly" &&
    config.budgets?.temporaryUSD === 1 && config.budgets.monthlyEUR === 5 && config.maximumSourceGiB === 20 &&
    isAbsolute(config.stateRoot ?? "") && pathNames.every(name=>isAbsolute(config.paths?.[name] ?? "")),
    "monthly_runtime_configuration_invalid");
  return config;
}
async function nativeCode() {
  // Fail before claiming a month or contacting a provider when the copied operator lacks dependencies.
  verifyMonthlyLocalDependencies();
  return inspectMonthlyCandidate(root);
}
function nativeOperations() {
  return {
    code:nativeCode,capture:captureMonthlyForExport,inspect:inspectPublishedMonthlyPoint,
    export:options=>exportMonthlySnapshotPoint({...options,provider:nativeSnapshotExportProvider()}),
    drive:options=>dedicatedDriveProvider(options),publish:publishSealedDrivePoint,
    rotate:options=>executeMonthlyRetention({...options,snapshots:nativeRetentionSnapshots()}),
    async reconcile(point,config,drive) {
      await verifyRetentionPair(point,nativeRetentionSnapshots());
      await verifyRetentionDriveMetadata(point,config.rootFolderId,drive);
      return {state:"existing-point-identities-verified"};
    },
    async source(config,path) {
      await runExportNative(process.execPath,[join(root,"deployment/monthly-snapshot-source.mjs"),
        "--context",config.context,"--instance",config.instanceId,"--namespace",config.namespace,"--region",config.region,"--output",path]);
      return readPrivateSource(path,1024*1024);
    },
    live:config=>runMonthlyServiceHealth(config)
  };
}
async function readReadiness(config, candidate, mode) {
  const code=candidate?.code ?? {};
  requireValue(["root","hubs","cloud"].every(name=>code[name]===config.code[name]), "monthly_runtime_code_changed");
  const bytes=await readPrivateBytes(config.paths.recipient,256);
  let recipient;try{recipient=bytes.toString("utf8").trim();}finally{bytes.fill(0);}
  requireValue(/^age1[0-9a-z]{58}$/.test(recipient), "monthly_runtime_recipient_invalid");
  const custody=await readPrivateSource(config.paths.keyCustody);
  requireValue(custody.schema === "yenhubs-recovery-key-custody-v1" && custody.recipient===recipient &&
    custody.state === "independent-copy-decryption-verified" && ["usb","password-manager"].includes(custody.locationKind) &&
    custody.nativeExitCode===0 && /^[a-f0-9]{64}$/.test(custody.challengeSha256 ?? "") &&
    Number.isFinite(Date.parse(custody.verifiedAt)), "monthly_runtime_key_custody_unproven");
  const acceptance=await readPrivateSource(config.paths.acceptance);
  requireValue(acceptance.schema==="yenhubs-monthly-runtime-acceptance-v2" && acceptance.recipient===recipient &&
    acceptance.instanceId===config.instanceId && ["root","hubs","cloud"].every(name=>acceptance.code?.[name]===code[name]) &&
    acceptance.monthly && !Object.hasOwn(acceptance,"full"), "monthly_runtime_monthly_code_gate_unproven");
  await readMonthlyVerification(acceptance.monthly,candidate);
  if(mode==="scheduled") requireValue(config.schedule.enabled &&
    ["digitalOcean","googleDrive"].every(route=>acceptance.restores?.[route]?.nativeExitCode===0 &&
      acceptance.restores[route].state==="isolated-restore-accepted" &&
      /^[a-f0-9]{64}$/.test(acceptance.restores[route].evidenceSha256 ?? "")), "monthly_runtime_schedule_not_accepted");
  const driveRuntime=await readPrivateSource(config.paths.driveRuntime);
  requireValue(driveRuntime.ownerOnlyVerified===true && /^[a-zA-Z0-9_-]{1,200}$/.test(driveRuntime.folderId ?? "") &&
    typeof driveRuntime.expectedOwnerEmail==="string" && /^[^\s@]+@[^\s@]+$/.test(driveRuntime.expectedOwnerEmail),
    "monthly_runtime_drive_destination_unproven");
  const pinned={};
  for(const name of ["values","manifest","cutoverKey","driveClient","driveConfig"]) {
    const content=await readPrivateBytes(config.paths[name],32*1024*1024);
    try{pinned[name]=digest(content);}finally{content.fill(0);}
  }
  return {recipient,driveRuntime,pinned,acceptance};
}
async function history(config) {
  const directory=join(config.stateRoot,"points"),points=[];
  for(const name of await readdir(directory)) {
    requireValue(/^\d{4}-(0[1-9]|1[0-2])\.json$/.test(name), "monthly_runtime_history_entry_invalid");
    const point=await readPrivateSource(join(directory,name),1024*1024);
    requireValue(point.month===name.slice(0,-5) && point.instanceId===config.instanceId, "monthly_runtime_history_binding_changed");
    points.push(point);
  }
  for(const name of (await readdir(join(config.stateRoot,"rotations"))).sort()) {
    requireValue(/^\d{4}-(0[1-9]|1[0-2])\.json$/.test(name), "monthly_runtime_rotation_entry_invalid");
    const result=await readPrivateSource(join(config.stateRoot,"rotations",name),1024*1024);
    requireValue(result.schema==="yenhubs-monthly-retention-result-v1" && result.state==="rotation-complete" &&
      result.instanceId===config.instanceId && result.month===name.slice(0,-5) &&
      Array.isArray(result.retired?.digitalOcean) && Array.isArray(result.retired.googleDrive), "monthly_runtime_rotation_unproven");
    for(const point of points) {
      if(result.retired.digitalOcean.includes(point.month))point.digitalOcean.status="retired";
      if(result.retired.googleDrive.includes(point.month))point.googleDrive.status="retired";
    }
  }
  return points;
}
function requireLive(result) {
  requireValue(result?.nativeExitCode===0 && result.failures===0 && result.warnings===0 &&
    /^[a-f0-9]{64}$/.test(result.stdoutSha256 ?? ""), "monthly_runtime_live_not_accepted");
}
async function requireDriveRoot(drive,folderId) {
  const folder=await drive.stat(folderId);
  requireValue(folder.id===folderId && folder.mimeType==="application/vnd.google-apps.folder" && folder.ownedByMe===true &&
    folder.trashed===false && folder.permissions?.length===1 && folder.permissions[0].type==="user" &&
    folder.permissions[0].role==="owner", "monthly_runtime_drive_root_changed");
}

export async function runMonthlyBackup({configPath,mode="validation",operations=nativeOperations(),now=()=>new Date()}) {
  requireValue(["validation","scheduled"].includes(mode), "monthly_runtime_mode_invalid");
  const config=validateMonthlyRuntimeConfiguration(await readPrivateSource(configPath));
  await privateDirectory(config.stateRoot);
  const readiness=await readReadiness(config,await operations.code(),mode),month=civilMonth(now(),config.timezone);
  // No cloud command or pause occurs before final-code and custody gates.
  for(const name of ["attempts","points","rotations","native-journals"])await ensureDirectory(join(config.stateRoot,name));
  const attempt=join(config.stateRoot,"attempts",month),previous=await history(config);
  const priorAttemptNames=await readdir(join(config.stateRoot,"attempts"));
  for(const name of priorAttemptNames) {
    requireValue(monthPattern.test(name),"monthly_runtime_attempt_entry_invalid");
    let completed;try{completed=await readPrivateSource(join(config.stateRoot,"attempts",name,"completed.json"));}
    catch{throw new Error("monthly_runtime_previous_attempt_unresolved");}
    requireValue(completed.month===name && completed.instanceId===config.instanceId && completed.nativeExitCode===0 &&
      ["captured-exported-not-restore-accepted","monthly-point-complete"].includes(completed.state),
      "monthly_runtime_previous_attempt_unresolved");
  }
  const current=previous.find(point=>point.month===month);
  if(current) {
    requireValue(priorAttemptNames.includes(month),"monthly_runtime_current_attempt_missing");
    const drive=await operations.drive({configPath:config.paths.driveConfig,installedClientPath:config.paths.driveClient,
      expectedOwnerEmail:readiness.driveRuntime.expectedOwnerEmail,allowRetentionTrash:mode==="scheduled"});
    await requireDriveRoot(drive,readiness.driveRuntime.folderId);
    const observed=await operations.reconcile(current,{rootFolderId:readiness.driveRuntime.folderId},drive);
    requireValue(observed?.state==="existing-point-identities-verified", "monthly_runtime_current_month_unproven");
    return {schema:"yenhubs-monthly-runtime-result-v1",state:"existing-month-identities-verified",instanceId:config.instanceId,month,
      backupCreated:false,restoreAcceptanceRequired:mode!=="scheduled"};
  }
  requireValue(!priorAttemptNames.includes(month),"monthly_runtime_attempt_exists_reconcile_only");
  await mkdir(attempt,{mode:0o700});
  const attemptsParent=await open(dirname(attempt),"r");try{await attemptsParent.sync();}finally{await attemptsParent.close();}
  const started=performance.now(),events=await open(join(attempt,"events.jsonl"),"wx",0o600),timings={};let stage="preflight";
  const record=async event=>{await events.writeFile(JSON.stringify({...event,stage,instanceId:config.instanceId,month})+"\n");await events.sync();
    const directory=await open(attempt,"r");try{await directory.sync();}finally{await directory.close();}};
  async function phase(name,operation) {
    stage=name;await record({event:"phase-intent"});const began=performance.now();const result=await operation();
    timings[name]=Math.round(performance.now()-began);await record({event:"phase-returned",durationMilliseconds:timings[name]});return result;
  }
  try {
    const drive=await phase("drive-preflight",()=>operations.drive({configPath:config.paths.driveConfig,
      installedClientPath:config.paths.driveClient,expectedOwnerEmail:readiness.driveRuntime.expectedOwnerEmail,
      allowRetentionTrash:mode==="scheduled"}));
    await requireDriveRoot(drive,readiness.driveRuntime.folderId);
    const live=await phase("live-preflight",()=>operations.live(config));requireLive(live);
    const source=await phase("source-preflight",()=>operations.source(config,join(attempt,"source-before.json")));
    requireValue(source.context===config.context && source.instanceId===config.instanceId && source.namespace?.uid===config.namespaceUid &&
      source.volumes?.database?.pvcUid===config.databasePvcUid && source.volumes?.media?.pvcUid===config.retPvcUid &&
      Object.keys(source.volumes).sort().join() === "database,media" &&
      Object.values(source.volumes).every(v=>Number.isSafeInteger(v.sizeGiB) && v.sizeGiB>0) &&
      Object.values(source.volumes).reduce((sum,v)=>sum+v.sizeGiB,0)<=config.maximumSourceGiB,
      "monthly_runtime_source_identity_or_budget_changed");
    // The fixed monthly entrypoint invokes only the minimal snapshot executor.
    const environment={...process.env,CHECKPOINT_BACKEND:"native-monthly",CHECKPOINT_FORMAT:"native-monthly-v1",
      ALLOW_CHECKPOINT_DOWNTIME:"1",MONTHLY_INSTANCE_ID:config.instanceId,MONTHLY_REGION:config.region,
      MONTHLY_JOURNAL_ROOT:join(config.stateRoot,"native-journals"),EXPECTED_KUBE_CONTEXT:config.context,
      NAMESPACE:config.namespace,EXPECTED_NAMESPACE_UID:config.namespaceUid,EXPECTED_RET_PVC_UID:config.retPvcUid,
      EXPECTED_DB_PVC_UID:config.databasePvcUid,
      VALUES_FILE:config.paths.values,HCCE_MANIFEST_PATH:config.paths.manifest,PROCESS_LOCAL_CUTOVER_KEY_PATH:config.paths.cutoverKey};
    const checkpointDirectory=join(attempt,"checkpoint"),captureCompletionPath=join(attempt,"capture-completion.json");
    const captured=await phase("capture",()=>operations.capture({checkpointDirectory,completionPath:captureCompletionPath,environment}));
    requireValue(captured?.schema==="yenhubs-monthly-capture-completion-v1" && captured.nativeExitCode===0 &&
      captured.state==="native-command-complete-not-restore-accepted" && captured.instanceId===config.instanceId &&
      captured.month===month && captured.directory===checkpointDirectory, "monthly_runtime_capture_exit_unproven");
    const point=await operations.inspect(checkpointDirectory,captureCompletionPath);
    requireValue(point.pair.instanceId===config.instanceId && point.pair.month===month && point.pair.context===config.context &&
      point.pair.namespace.uid===config.namespaceUid && point.source.volumes.media.pvcUid===config.retPvcUid &&
      point.source.volumes.database.pvcUid===config.databasePvcUid &&
      ["database","media"].every(role=>["pvcUid","pvUid","volumeId","sizeGiB"].every(key=>
        point.source.volumes[role][key]===source.volumes[role][key])),
      "monthly_runtime_capture_identity_changed");
    const after=await phase("live-after",()=>operations.live(config));requireLive(after);
    const exported=await phase("export",()=>operations.export({checkpointDirectory,captureCompletionPath,
      outputDirectory:join(attempt,"export"),journalDirectory:join(attempt,"export-journal"),recipient:readiness.recipient,
      maximumTemporaryUSD:config.budgets.temporaryUSD}));
    const uploaded=await phase("drive-readback",()=>operations.publish({packageDirectory:exported.packageDirectory,
      expectedBinding:exported.binding,rootFolderId:readiness.driveRuntime.folderId,provider:drive,journalDirectory:join(attempt,"drive-journal")}));
    const retained=monthlyRetentionRecord({point,exportReceipt:exported,driveReceipt:uploaded});
    for(const name of Object.keys(readiness.pinned)) {
      const bytes=await readPrivateBytes(config.paths[name],32*1024*1024);
      try{requireValue(digest(bytes)===readiness.pinned[name],"monthly_runtime_input_changed");}finally{bytes.fill(0);}
    }
    await writeJson(join(config.stateRoot,"points",month+".json"),retained);
    if(mode==="scheduled") {
      const rotation=await phase("rotation",()=>operations.rotate({instanceId:config.instanceId,month,operationId:point.pair.operationId,
        points:[...previous,retained],rootFolderId:readiness.driveRuntime.folderId,drive,journalDirectory:join(attempt,"rotation-journal")}));
      requireValue(rotation.schema==="yenhubs-monthly-retention-result-v1" && rotation.state==="rotation-complete" &&
        rotation.instanceId===config.instanceId && rotation.month===month && rotation.operationId===point.pair.operationId &&
        Array.isArray(rotation.retired?.digitalOcean) && Array.isArray(rotation.retired.googleDrive),
        "monthly_runtime_rotation_unproven");
      await writeJson(join(config.stateRoot,"rotations",month+".json"),rotation);
    }
    const result={schema:"yenhubs-monthly-runtime-result-v1",state:mode==="scheduled"?"monthly-point-complete":"captured-exported-not-restore-accepted",
      instanceId:config.instanceId,month,operationId:point.pair.operationId,nativeExitCode:0,mode,backupCreated:true,
      timings:{...timings,totalMilliseconds:Math.round(performance.now()-started)}};
    await writeJson(join(attempt,"completed.json"),result);await record({event:"attempt-complete",state:result.state});return result;
  } catch(error) {
    const reason=/^[a-z][a-z0-9_]+$/.test(error.message)?error.message:"monthly_runtime_failed_or_ambiguous";
    const native={};
    if(Number.isInteger(error.nativeExitCode) && error.nativeExitCode>=0 && error.nativeExitCode<=255)native.nativeExitCode=error.nativeExitCode;
    if(error.nativeSignal===null || /^SIG[A-Z0-9]{1,12}$/.test(error.nativeSignal ?? ""))native.nativeSignal=error.nativeSignal;
    if(typeof error.nativeKilled==="boolean")native.nativeKilled=error.nativeKilled;
    try{await record({event:"attempt-incomplete",reason,...native});}catch{}
    // Do NOT restart capture, retry cloud writes, accept partials or hide pause recovery failures.
    throw Object.assign(new Error(reason),native);
  } finally {await events.close();}
}

if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    requireValue(process.argv.length===6 && process.argv[2]==="--config" && process.argv[4]==="--mode", "monthly_runtime_usage");
    const result=await runMonthlyBackup({configPath:process.argv[3],mode:process.argv[5]});
    console.log(JSON.stringify(result));
  } catch(error) {
    console.error(/^[a-z][a-z0-9_]+$/.test(error.message)?error.message:"monthly_runtime_failed_or_ambiguous");process.exitCode=1;
  }
}
