/** Opt-in LOCAL data recovery canary. No Kubernetes, cloud writes or live restore. */
import { open, realpath, mkdir, mkdtemp, lstat, readFile } from "node:fs/promises";
import { join, resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { runExportNative } from "../../deployment/monthly-snapshot-export-provider.mjs";
import { inspectMonthlyRestoreInput,extractMonthlyMediaArchive,hashMonthlyRestoreFile } from "../../deployment/monthly-restore-input.mjs";
import { readPrivateBytes,readPrivateSource } from "../../deployment/monthly-snapshot-worker.mjs";
import { copyRows,verifyCopyRows,validateLocalDump,localPgEnvironment,logicalDump } from "./native-checkpoint-restore.mjs";
import { resolveNativeBash,nativeBashArguments } from "./native-bash.mjs";

const requireValue=(v,code)=>{if(!v)throw new Error(code);};
const sha=bytes=>createHash("sha256").update(bytes).digest("hex");
const canonical=value=>JSON.stringify(value,(_,v)=>v && !Array.isArray(v) && typeof v==="object"?
  Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))):v);
const library=fileURLToPath(new URL("../../deployment/lib/recovery-safety.sh",import.meta.url));
function canonicalDump(sql) {
  const lines=logicalDump(sql).split("\n"),result=[];let rows=null;
  for(const line of lines) {
    if(rows){if(line==="\\."){result.push(...rows.sort(),line);rows=null;}else rows.push(line);}
    else{result.push(line);if(/^COPY .* FROM stdin;$/.test(line))rows=[];}
  }
  requireValue(rows===null,"monthly_local_restore_copy_truncated");return result.join("\n");
}
export function canonicalMonthlyDataDump(sql) {
  const lines=canonicalDump(sql).split("\n"),markers=[];let copy=false;
  for(let i=0;i<lines.length;i++) {
    if(copy){if(lines[i]==="\\.")copy=false;continue;}
    if(/^COPY .* FROM stdin;$/.test(lines[i])){copy=true;continue;}
    if(/^-- (?:Data for )?Name: .+; Type: (?:TABLE DATA|SEQUENCE SET|BLOB|BLOBS); Schema: /.test(lines[i])) {
      requireValue(lines[i-1]==="--","monthly_local_restore_data_section_invalid");markers.push(i-1);
    }
  }
  if(!markers.length)return lines.join("\n");
  const complete=lines.lastIndexOf("-- PostgreSQL database dump complete");
  requireValue(complete>markers.at(-1)&&lines[complete-1]==="--","monthly_local_restore_data_section_invalid");
  const end=complete-1,sections=markers.map((start,i)=>lines.slice(start,markers[i+1]??end).join("\n"));
  requireValue(new Set(markers.map(i=>lines[i+1])).size===markers.length,"monthly_local_restore_duplicate_data_section");
  // Physical OIDs and restore creation order change TOC section order, not data.
  // Keep every whole section, sequence statement, row value and duplicate.
  return [...lines.slice(0,markers[0]),...sections.sort(),...lines.slice(end)].join("\n");
}
export function verifyMonthlyRestoreComparisons({sourceData,restoredData,referenceSchema,restoredSchema}) {
  requireValue(canonicalMonthlyDataDump(sourceData)===canonicalMonthlyDataDump(restoredData),"monthly_local_restore_data_dump_changed");
  requireValue(logicalDump(referenceSchema)===logicalDump(restoredSchema),"monthly_local_restore_schema_changed");
  return {dataSha256:sha(canonicalMonthlyDataDump(restoredData)),schemaSha256:sha(logicalDump(restoredSchema))};
}
export function requireLocalRestoreMajor(version,expectedMajor) {
  requireValue(/^[1-9][0-9]?$/.test(expectedMajor) &&
    new RegExp(`^pg_ctl \\(PostgreSQL\\) ${expectedMajor}\\.`).test(version),"monthly_local_restore_major_mismatch");
}
async function json(path,value) {
  const file=await open(path,"wx",0o600);try{await file.writeFile(JSON.stringify(value)+"\n");await file.sync();}finally{await file.close();}
}

export async function restoreLocalMonthlyData({inputs,expectedContract,postgresMajor,pgBin}) {
  requireValue(isAbsolute(pgBin) && await realpath(pgBin)===pgBin,"monthly_local_restore_pg_path_invalid");
  const before={};for(const name of ["database","media","runtime"])before[name]=await hashMonthlyRestoreFile(inputs[name]);
  const work=await realpath(await mkdtemp("/private/tmp/yenhubs-mr-")),socket=join(work,"socket"),data=join(work,"database");
  await mkdir(socket,{mode:0o700});
  const env=localPgEnvironment(pgBin,work,socket),began=performance.now(),timings={};let serverAttempted=false,serverIdentity,failure,result;
  const run=(program,args,options={})=>runExportNative(program,args,{timeout:120000,env,...options});
  const pg=(name,args,options={})=>run(join(pgBin,name),args,options);
  const psql=(database,sql)=>pg("psql",["-X","-q","-A","-t","-v","ON_ERROR_STOP=1","-h",socket,"-p",env.PGPORT,
    "-U","postgres","-d",database],{input:sql});
  const phase=async(name,operation)=>{const started=performance.now();const value=await operation();timings[name]=Math.round(performance.now()-started);return value;};
  async function identity() {
    const path=join(data,"postmaster.pid"),stat=await lstat(path),lines=(await readFile(path,"utf8")).split("\n");
    requireValue(stat.isFile() && !stat.isSymbolicLink() && stat.uid===process.getuid() && /^[1-9][0-9]*$/.test(lines[0]) &&
      lines[1]===data && Number(lines[2])*1000>=Date.now()-(performance.now()-began)-1000 &&
      lines[3]===env.PGPORT && lines[4]===socket,"monthly_local_restore_server_owner_changed");
    return lines.slice(0,5).join("\n");
  }
  try {
    requireLocalRestoreMajor((await pg("pg_ctl",["--version"])).stdout.trim(),postgresMajor);
    await phase("initdb",()=>pg("initdb",["-D",data,"-U","postgres","--encoding=UTF8","--locale=en_US.UTF-8",
      "--auth-local=trust","--auth-host=reject"]));
    await phase("start",async()=>{
      serverAttempted=true;
      await pg("pg_ctl",["-D",data,"-w","-t","30","-l",join(work,"postgres.log"),"-o",
        `-k ${socket} -p ${env.PGPORT} -c listen_addresses='' -c unix_socket_permissions=0700 -c log_statement=none -c log_min_error_statement=panic`,"start"]);
      serverIdentity=await identity();
      requireValue((await psql("postgres","SHOW listen_addresses;")).stdout.trim()==="" &&
        (await psql("postgres","SHOW data_directory;")).stdout.trim()===data &&
        (await psql("postgres","SELECT inet_server_addr() IS NULL;")).stdout.trim()==="t","monthly_local_restore_not_unix_only");
    });
    await phase("restore",async()=>{
      await pg("pg_restore",["--list",inputs.database]);
      const source=await open(join(work,"source.sql"),"wx",0o600);
      try{await pg("pg_restore",["--file","-",inputs.database],{outputFile:source});}finally{await source.close();}
      const bytes=await readPrivateBytes(join(work,"source.sql"),64*1024*1024);
      try{validateLocalDump(bytes.toString("utf8"));}finally{bytes.fill(0);}
      await psql("postgres","CREATE ROLE ret_admin NOLOGIN; CREATE DATABASE monthly_verify OWNER postgres TEMPLATE template0;");
      await pg("pg_restore",["--exit-on-error","--host",socket,"--port",env.PGPORT,"--username","postgres",
        "--dbname","monthly_verify",inputs.database]);
    });
    const contract=await phase("complete-database-contract",async()=>{
      const query=(await run(resolveNativeBash(),nativeBashArguments(library,"recovery_database_contract_sql"))).stdout;
      const actual=JSON.parse((await psql("monthly_verify",query)).stdout);
      requireValue(canonical(actual)===canonical(expectedContract),"monthly_local_restore_contract_changed");return actual;
    });
    const rows=await phase("all-rows-and-schemas",async()=>{
      const output=await open(join(work,"restored.sql"),"wx",0o600);
      try{await pg("pg_dump",["--host",socket,"--port",env.PGPORT,"--username","postgres","--format=plain","monthly_verify"],{outputFile:output});}
      finally{await output.close();}
      const original=await readPrivateBytes(join(work,"source.sql"),64*1024*1024),restored=await readPrivateBytes(join(work,"restored.sql"),64*1024*1024);
      try {
        const sourceRows=copyRows(original.toString("utf8"));verifyCopyRows(sourceRows,copyRows(restored.toString("utf8")));
        // pg_restore retains source-minor DDL text, whereas pg_dump deparses on
        // the target minor. Canonicalize ALL source DDL using the same native
        // PG12 engine; do not erase constraints or whitelist particular names.
        await psql("postgres","CREATE DATABASE monthly_reference OWNER postgres TEMPLATE template0;");
        await pg("pg_restore",["--exit-on-error","--schema-only","--host",socket,"--port",env.PGPORT,
          "--username","postgres","--dbname","monthly_reference",inputs.database]);
        const schema=async database=>(await pg("pg_dump",["--host",socket,"--port",env.PGPORT,"--username","postgres",
          "--schema-only","--format=plain",database])).stdout;
        const compared=verifyMonthlyRestoreComparisons({
          sourceData:(await pg("pg_restore",["--data-only","--file","-",inputs.database])).stdout,
          restoredData:(await pg("pg_dump",["--host",socket,"--port",env.PGPORT,"--username","postgres",
            "--data-only","--format=plain","monthly_verify"])).stdout,
          referenceSchema:await schema("monthly_reference"),restoredSchema:await schema("monthly_verify")});
        return {tables:sourceRows.size,rows:[...sourceRows.values()].reduce((sum,values)=>sum+values.length,0),
          canonicalDumpSha256:sha(canonicalDump(restored.toString("utf8"))),...compared,schemaCanonicalizedOnTarget:true};
      }finally{original.fill(0);restored.fill(0);}
    });
    const media=await phase("media",()=>extractMonthlyMediaArchive({archive:inputs.media,outputDirectory:join(work,"media")}));
    for(const uuid of contract.critical_inventory.active_owned_file_uuids) {
      requireValue(typeof uuid==="string" && /^[A-Za-z0-9._-]{4,}$/.test(uuid),"monthly_local_restore_active_uuid_invalid");
      const base=`owned/${uuid.slice(0,2)}/${uuid.slice(2,4)}/${uuid}`;
      requireValue(media.files[base+".blob"] && media.files[base+".meta.json"],"monthly_local_restore_active_media_missing");
    }
    for(const name of Object.keys(before))requireValue(canonical(before[name])===canonical(await hashMonthlyRestoreFile(inputs[name])),
      "monthly_local_restore_source_changed");
    result={schema:"yenhubs-monthly-local-data-restore-v1",state:"native-local-data-verified-not-installation-accepted",
      nativeExitCode:0,postgresMajor,completeDatabaseContract:true,copyTables:rows.tables,copyRows:rows.rows,
      logicalDumpSha256:rows.canonicalDumpSha256,completeMediaPairs:media.completePairs,mediaInventorySha256:media.sha256,
      dataDumpSha256:rows.dataSha256,schemaDumpSha256:rows.schemaSha256,schemaCanonicalizedOnTarget:rows.schemaCanonicalizedOnTarget,
      activeMediaPairs:contract.critical_inventory.active_owned_file_uuids.length,sourceUnchanged:true,productionRestored:false};
  }catch(error){failure=/^[a-z][a-z0-9_]+$/.test(error.message)?error.message:"monthly_local_restore_failed_or_ambiguous";}
  finally {
    if(serverAttempted)try{
      await phase("stop",async()=>{
        const current=await identity();requireValue(!serverIdentity || current===serverIdentity,"monthly_local_restore_server_owner_changed");
        await pg("pg_ctl",["-D",data,"-w","-t","30","-m","fast","stop"]);
        let present=false;try{await lstat(join(data,"postmaster.pid"));present=true;}catch(error){requireValue(error.code==="ENOENT","monthly_local_restore_cleanup_unproven");}
        requireValue(!present,"monthly_local_restore_cleanup_unproven");
        try{process.kill(Number(current.split("\n")[0]),0);throw Error("monthly_local_restore_cleanup_unproven");}
        catch(error){requireValue(error.code==="ESRCH","monthly_local_restore_cleanup_unproven");}
      });
    }catch{failure="monthly_local_restore_cleanup_unproven";}
  }
  const final=failure?{schema:"yenhubs-monthly-local-data-restore-v1",state:"incomplete-not-accepted",failure}:
    {...result,ownedServerStopped:true,timings:{...timings,totalMilliseconds:Math.round(performance.now()-began)}};
  await json(join(work,"proof-result.json"),final);
  if(failure)throw new Error(failure);
  return {...final,proofDirectory:work};
}

if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    requireValue(process.argv.length===8 && process.argv[2]==="--opened" && process.argv[4]==="--record" && process.argv[6]==="--pg-bin",
      "monthly_local_restore_explicit_private_inputs_required");
    const record=await readPrivateSource(process.argv[5]),verified=await inspectMonthlyRestoreInput({openedDirectory:process.argv[3],record});
    const result=await restoreLocalMonthlyData({inputs:verified.inputs,expectedContract:verified.point.contract,
      postgresMajor:verified.point.source.postgres.major,pgBin:process.argv[7]});
    console.log(JSON.stringify(result));
  }catch(error){console.error(/^[a-z][a-z0-9_]+$/.test(error.message)?error.message:"monthly_local_restore_failed_or_ambiguous");process.exitCode=1;}
}
