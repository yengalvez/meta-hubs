import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { buildMonthlyLaunchAgent } from "../../deployment/monthly-backup-calendar.mjs";

const uid="00000000-0000-4000-8000-000000000001";
function fixture() {
  const names=["values","manifest","cutoverKey","recipient","keyCustody","driveClient","driveConfig","driveRuntime","acceptance"];
  const config={schema:"yenhubs-monthly-runtime-v1",instanceId:"fixture-monthly",timezone:"Europe/Madrid",context:"do-ams3-hubs-ce",region:"ams3",namespace:"hcce",
    namespaceUid:uid,retPvcUid:uid,databasePvcUid:uid,code:{root:"a".repeat(40),hubs:"b".repeat(40),cloud:"c".repeat(40)},
    stateRoot:"/private/tmp/only-calendar-fixture",paths:Object.fromEntries(names.map(name=>[name,`/private/tmp/fixture-${name}`])),
    schedule:{enabled:false,frequency:"monthly"},budgets:{temporaryUSD:1,monthlyEUR:5},maximumSourceGiB:20};
  const options={nodePath:"/private/tmp/fixture-node",runtimePath:"/private/tmp/fixture-runtime.mjs",configPath:"/private/tmp/fixture-config.json",
    home:"/private/tmp/fixture-owner",hostTimezone:"Europe/Madrid"};
  return {config,options,plan:()=>buildMonthlyLaunchAgent(config,options)};
}
test("one monthly calendar plus login catch-up invokes the guarded driver without any model",()=>{
  const p=fixture().plan();assert.equal(p.state,"prepared-not-installed");assert.equal(p.configurationEnabled,false);
  assert.deepEqual(p.schedule,{day:1,hour:3,minute:0,timezone:"Europe/Madrid"});assert.equal(p.modelCallsPerRun,0);
  assert.equal(p.backupAutoretry,false);assert.match(p.xml,/<key>RunAtLoad<\/key><true\/>/);
  assert.match(p.xml,/<key>KeepAlive<\/key><false\/>/);assert.ok(!p.xml.includes("StartInterval"));
});
test("the generated plist parses with native macOS tools but is never installed or launched",async()=>{
  const f=fixture(),root=await realpath(await mkdtemp(join(tmpdir(),"yenhubs-calendar-plist-fixture-"))),path=join(root,"fixture.plist");
  await writeFile(path,f.plan().xml,{mode:0o600});
  const value=execFileSync("/usr/bin/plutil",["-lint",path],{encoding:"utf8"});assert.match(value,/: OK/);
  const parsed=JSON.parse(execFileSync("/usr/bin/plutil",["-convert","json","-o","-",path],{encoding:"utf8"}));
  assert.deepEqual(parsed.ProgramArguments,[f.options.nodePath,f.options.runtimePath,"--config",f.options.configPath,"--mode","scheduled"]);
  assert.equal(parsed.Umask,63);assert.equal(parsed.EnvironmentVariables.TZ,"Europe/Madrid");
});
test("a different host timezone cannot silently change the agreed calendar",()=>{
  const f=fixture();assert.throws(()=>buildMonthlyLaunchAgent(f.config,{...f.options,hostTimezone:"UTC"}),/host_or_path_invalid/);
});
test("credentials never appear in arguments, values or generated XML",()=>{
  const p=fixture().plan();assert.ok(!/client_secret|refresh_token|AGE-SECRET-KEY|Bearer/.test(p.xml));
  assert.ok(!p.xml.includes("fixture-cutoverKey"));assert.ok(!p.xml.includes("fixture-driveConfig"));
});
test("paths containing XML metacharacters remain single arguments",()=>{
  const f=fixture();const p=buildMonthlyLaunchAgent(f.config,{...f.options,configPath:"/private/tmp/a&b<fixture>.json"});
  assert.match(p.xml,/a&amp;b&lt;fixture&gt;\.json/);
});
test("relative paths and environment/path injection cannot generate a timer",()=>{
  const f=fixture();assert.throws(()=>buildMonthlyLaunchAgent(f.config,{...f.options,nodePath:"node"}),/host_or_path_invalid/);
  assert.throws(()=>buildMonthlyLaunchAgent(f.config,{...f.options,home:"/tmp/fixture:injection"}),/path_invalid/);
  assert.throws(()=>buildMonthlyLaunchAgent(f.config,{...f.options,runtimePath:"/tmp/fixture\nmalformed"}),/host_or_path_invalid/);
});
