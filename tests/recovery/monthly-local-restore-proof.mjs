/** Native fixture of the new canary engine. PG14 format only, NOT PG12/metaverse acceptance. */
import assert from "node:assert/strict";
import { open, realpath, mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { runExportNative } from "../../deployment/monthly-snapshot-export-provider.mjs";
import { localPgEnvironment } from "./native-checkpoint-restore.mjs";
import { restoreLocalMonthlyData,requireLocalRestoreMajor } from "./monthly-portable-restore.mjs";
import { resolveNativeBash,nativeBashArguments } from "./native-bash.mjs";

const began=performance.now(),root=await realpath(await mkdtemp("/private/tmp/yenhubs-ms-"));
const pgBin=await realpath("/opt/homebrew/opt/postgresql@14/bin"),socket=join(root,"socket"),data=join(root,"data");
await mkdir(socket,{mode:0o700});
const env=localPgEnvironment(pgBin,root,socket),run=(program,args,extra={})=>runExportNative(program,args,{env,timeout:120000,...extra});
const pg=(name,args,extra={})=>run(join(pgBin,name),args,extra);
const sql=(database,input)=>pg("psql",["-X","-q","-A","-t","-v","ON_ERROR_STOP=1","-h",socket,"-p",env.PGPORT,
  "-U","postgres","-d",database],{input});
let started=false,report;
try {
  await pg("initdb",["-D",data,"-U","postgres","--encoding=UTF8","--locale=en_US.UTF-8","--auth-local=trust","--auth-host=reject"]);
  await pg("pg_ctl",["-D",data,"-w","-t","30","-l",join(root,"source.log"),"-o",`-k ${socket} -p ${env.PGPORT} -c listen_addresses=''`,"start"]);started=true;
  await sql("postgres","CREATE DATABASE fixture_source;");
  const uuid="abcd-fixture",statements=["CREATE SCHEMA coturn; CREATE SCHEMA ret0; CREATE SCHEMA ret0_admin;",
    "CREATE TABLE ret0.schema_migrations(version bigint); CREATE TABLE ret0.hubs(hub_sid text);",
    "CREATE TABLE ret0.owned_files(owned_file_uuid text,state text);",
    "CREATE TABLE ret0.avatars(avatar_sid text); CREATE TABLE ret0.avatar_listings(avatar_listing_sid text);",
    ...Array.from({length:351},(_,i)=>`CREATE TABLE ret0.fixture_table_${i}(id bigint);`),
    ...Array.from({length:94},(_,i)=>`INSERT INTO ret0.schema_migrations VALUES (${1000+i});`),
    ...Array.from({length:17},(_,i)=>`INSERT INTO ret0.hubs VALUES ('Fixture${i}');`),
    `INSERT INTO ret0.owned_files VALUES ('${uuid}','active');`,
    ...Array.from({length:33},(_,i)=>`INSERT INTO ret0.avatars VALUES ('Avatar${i}'); INSERT INTO ret0.avatar_listings VALUES ('Listing${i}');`)].join("\n");
  await sql("fixture_source",statements);
  const query=(await run(resolveNativeBash(),nativeBashArguments(
    fileURLToPath(new URL("../../deployment/lib/recovery-safety.sh",import.meta.url)),"recovery_database_contract_sql"))).stdout;
  const contract=JSON.parse((await sql("fixture_source",query)).stdout);
  assert.equal(contract.critical_counts.relations,356);assert.equal(contract.critical_counts.migrations,94);
  const dump=join(root,"database.dump"),output=await open(dump,"wx",0o600);
  try{await pg("pg_dump",["-h",socket,"-p",env.PGPORT,"-U","postgres","-Fc","fixture_source"],{outputFile:output});}
  finally{await output.close();}
  const mediaRoot=join(root,"media-source"),base=join(mediaRoot,"owned/ab/cd");await mkdir(base,{mode:0o700,recursive:true});
  await writeFile(join(base,uuid+".blob"),"ONLY FIXTURE: synthetic ciphertext",{mode:0o600});
  await writeFile(join(base,uuid+".meta.json"),'{"fixtureOnly":true}',{mode:0o600});
  const media=join(root,"media.tar.gz"),archive=await open(media,"wx",0o600);
  try{await run("/usr/bin/tar",["--format=ustar","-czf","-","-C",mediaRoot,"."],{outputFile:archive});}finally{await archive.close();}
  const runtime=join(root,"runtime.tar.gz");await writeFile(runtime,"ONLY ENGINE FIXTURE: NOT A RUNTIME BUNDLE",{mode:0o600});
  const result=await restoreLocalMonthlyData({inputs:{database:dump,media,runtime},expectedContract:contract,postgresMajor:"14",pgBin});
  assert.equal(result.nativeExitCode,0);assert.equal(result.ownedServerStopped,true);assert.equal(result.copyTables,356);
  assert.equal(result.copyRows,178);assert.equal(result.completeMediaPairs,1);assert.equal(result.activeMediaPairs,1);
  assert.throws(()=>requireLocalRestoreMajor("pg_ctl (PostgreSQL) 14.23","12"),/major_mismatch/);
  report={status:"PASS",scope:"native-PG14-engine-fixture-not-PG12-or-metaverse-or-Drive-restore",productionData:false,
    installationAccepted:false,result,totalMilliseconds:Math.round(performance.now()-began),fixtureRoot:root};
} finally {
  if(started)await pg("pg_ctl",["-D",data,"-w","-t","30","-m","fast","stop"]);
}
await assert.rejects(readFile(join(data,"postmaster.pid")),{code:"ENOENT"});
report.sourceServerStopped=true;report.totalMilliseconds=Math.round(performance.now()-began);
await writeFile(join(root,"proof-result.json"),JSON.stringify(report)+"\n",{mode:0o600});
console.log(JSON.stringify(report));
