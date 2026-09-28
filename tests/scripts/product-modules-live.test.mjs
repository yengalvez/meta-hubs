import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("../../", import.meta.url));
const script = fs.readFileSync(`${root}deployment/verify-live-reactivation.sh`,"utf8");
const functions = script.slice(script.indexOf("verify_product_modules_snapshot()"),script.indexOf("printf 'YenHubs live reactivation"));
const { guardPodDocumentForIdentity, runnerPodName } = require(`${root}hubs-cloud/community-edition/services/bot-orchestrator/kubernetes-runner-manager.js`);
const annotations = {"yenhubs.com/product-modules-schema":"1","yenhubs.com/product-bots":"false","yenhubs.com/product-ai":"false","yenhubs.com/product-avaturn":"false"};
const modules = {schema_version:1,bots:false,ai:false,avaturn:false,avaturn_creator_url:""};
const list = (kind, items=[]) => ({apiVersion:kind==="ReplicaSetList"?"apps/v1":"v1",kind,metadata:{resourceVersion:"1"},items});
function deployments() {
  return {items:["reticulum","bot-orchestrator"].map(name => ({metadata:{name,uid:name,annotations:{...annotations}},spec:{replicas:name==="reticulum"?1:0,template:{metadata:{annotations:{...annotations}},spec:{containers:[{name,env:[...Object.keys(modules).filter(k=>["bots","ai","avaturn"].includes(k)).map(k=>({name:`YENHUBS_${k.toUpperCase()}_ENABLED`,value:"false"})),...(name==="reticulum"?[{name:"YENHUBS_AVATURN_CREATOR_URL",value:""}]:[])]}]}}}}))};
}
function run(name,args) {
  return spawnSync("bash",["-c",`${functions}\n"$@"`,"test",name,...args.map(v=>JSON.stringify(v))],{encoding:"utf8",env:{...process.env,SCRIPT_DIR:`${root}deployment`,NAMESPACE:"hcce"}});
}
test("BASE module snapshot matches exact input/metadata/env without secret or provider access",()=>{
  const ns={metadata:{annotations}};
  const good=deployments();
  assert.equal(run("verify_product_modules_snapshot",[ns,good,modules]).status,0);
  const kubernetesDefaulted = structuredClone(good);
  delete kubernetesDefaulted.items[0].spec.template.spec.containers[0].env.find(
    item=>item.name==="YENHUBS_AVATURN_CREATOR_URL").value;
  assert.equal(run("verify_product_modules_snapshot",[ns,kubernetesDefaulted,modules]).status,0);
  for(const mutate of [
    d=>d.items[0].spec.template.spec.containers[0].env.push({name:"OPENAI_API_KEY",valueFrom:{secretKeyRef:{name:"configs",key:"OPENAI_API_KEY"}}}),
    d=>d.items[0].spec.template.spec.containers[0].env[0].value=true,
    d=>d.items[0].spec.template.spec.containers[0].env.push(d.items[0].spec.template.spec.containers[0].env[0]),
    d=>d.items[1].metadata.annotations["yenhubs.com/product-bots"]="true",
    d=>d.items[0].spec.template.spec.containers[0].envFrom=[{secretRef:{name:"configs"}}]
  ]){const d=structuredClone(good);mutate(d);assert.notEqual(run("verify_product_modules_snapshot",[ns,d,modules]).status,0);}
});
test("all six product combinations bind independently across Namespace, Reticulum and parent",()=>{
  for(const [bots,ai,avaturn] of [[false,false,false],[false,false,true],[true,false,false],[true,false,true],[true,true,false],[true,true,true]]){
    const profile={schema_version:1,bots,ai,avaturn,avaturn_creator_url:avaturn?"https://client.avaturn.dev":""};
    const ann={"yenhubs.com/product-modules-schema":"1",...Object.fromEntries(["bots","ai","avaturn"].map(k=>[`yenhubs.com/product-${k}`,String(profile[k])]))};
    const deps=deployments();
    for(const dep of deps.items){
      dep.metadata.annotations={...ann};dep.spec.template.metadata.annotations={...ann};
      for(const env of dep.spec.template.spec.containers[0].env){
        if(env.name==="YENHUBS_AVATURN_CREATOR_URL")env.value=profile.avaturn_creator_url;
        else env.value=String(profile[env.name.slice(8,-8).toLowerCase()]);
      }
    }
    assert.equal(run("verify_product_modules_snapshot",[{metadata:{annotations:ann}},deps,profile]).status,0,JSON.stringify(profile));
  }
});
test("BASE runner snapshot accepts exact durable fences but rejects executable, unknown and incomplete state",()=>{
  const dep=deployments(), parents=list("PodList"), runners=list("PodList"), replicas=list("ReplicaSetList");
  assert.equal(run("verify_base_runtime_snapshot",[dep,parents,runners,replicas]).status,0);
  const identity={roomKey:"abcabcabcabcabcabcab",processGeneration:"11111111-1111-4111-8111-111111111111"}; identity.name=runnerPodName(identity.roomKey,identity.processGeneration);
  const fence=guardPodDocumentForIdentity(identity,"fence","hcce-bot-runners");Object.assign(fence.metadata,{uid:"fence",resourceVersion:"1"});fence.status={phase:"Pending"};
  runners.items=[fence];assert.equal(run("verify_base_runtime_snapshot",[dep,parents,runners,replicas]).status,0);
  parents.items=[{metadata:{labels:{app:"bot-orchestrator"}},status:{phase:"Pending"}}];assert.notEqual(run("verify_base_runtime_snapshot",[dep,parents,runners,replicas]).status,0);
  parents.items=[];runners.metadata.continue="more";assert.notEqual(run("verify_base_runtime_snapshot",[dep,parents,runners,replicas]).status,0);
  delete runners.metadata.continue;runners.items=[{metadata:{name:"unknown"}}];assert.notEqual(run("verify_base_runtime_snapshot",[dep,parents,runners,replicas]).status,0);
});
test("BASE branch never calls runner HTTP health, readiness, chat or provider",()=>{
  const start=script.indexOf('if [[ "$bots_enabled" == false ]]; then',script.indexOf("printf '\\nGhost runner"));
  const end=script.indexOf("elif printf",start);
  assert.ok(start>0 && end>start);
  const result=spawnSync("bash",["-c",`bots_enabled=false\nverify_base_runtime_live(){ return 0; }\npass(){ :; }\nfail(){ exit 9; }\ncurl(){ exit 19; }\nrecovery_kubectl(){ exit 20; }\n${script.slice(start,end)}fi`],{encoding:"utf8"});
  assert.equal(result.status,0,result.stderr);
});

test("BASE snapshot refuses active old/current ReplicaSets and ambiguous controller ancestry",()=>{
  const dep=deployments(), parents=list("PodList"), runners=list("PodList");
  const stopped=uid=>({apiVersion:"apps/v1",kind:"ReplicaSet",metadata:{name:"bot-orchestrator-old",namespace:"hcce",uid:"old-rs",ownerReferences:[{apiVersion:"apps/v1",kind:"Deployment",name:"bot-orchestrator",uid,controller:true}]},spec:{replicas:0},status:{replicas:0,readyReplicas:0,availableReplicas:0}});
  for(const uid of ["bot-orchestrator","previous-parent"]){
    assert.equal(run("verify_base_runtime_snapshot",[dep,parents,runners,list("ReplicaSetList",[stopped(uid)])]).status,0);
    for(const mutate of [
      rs=>{rs.spec.replicas=1;},rs=>{rs.status.replicas=1;},rs=>{rs.status.readyReplicas=1;},rs=>{rs.status.availableReplicas=1;},
      rs=>{delete rs.metadata.ownerReferences;},rs=>{rs.metadata.ownerReferences[0].name="unknown";},
      rs=>{rs.metadata.ownerReferences[0].uid="";},rs=>{rs.metadata.ownerReferences.push({...rs.metadata.ownerReferences[0]});}
    ]){const rs=stopped(uid);mutate(rs);assert.notEqual(run("verify_base_runtime_snapshot",[dep,parents,runners,list("ReplicaSetList",[rs])]).status,0);}
  }
  assert.notEqual(run("verify_base_runtime_snapshot",[dep,parents,runners,list("ReplicaSetList",[{metadata:{name:"unknown"},spec:{replicas:0}}])]).status,0);
  const ordinary=stopped("reticulum-uid");ordinary.metadata.name="reticulum-old";ordinary.metadata.ownerReferences[0].name="reticulum";ordinary.spec.replicas=1;
  assert.equal(run("verify_base_runtime_snapshot",[dep,parents,runners,list("ReplicaSetList",[ordinary])]).status,0);
  ordinary.spec.template={spec:{serviceAccountName:"bot-orchestrator"}};
  assert.notEqual(run("verify_base_runtime_snapshot",[dep,parents,runners,list("ReplicaSetList",[ordinary])]).status,0);
});

test("deployment readiness distinguishes annotated BASE0 from an unhealthy or historical parent",()=>{
  const security=fs.readFileSync(`${root}tests/scripts/security-gates.test.sh`,"utf8");
  const fixture=security.slice(security.indexOf('deployments_good="$(jq'),security.indexOf('deployments_evil_core='));
  const command=`source "$1/deployment/lib/reactivation-gate-functions.sh"
digest=$(printf '%064d' 0)
bot_runner_image="ghcr.io/yengalvez/bot-runner@sha256:$digest"
${fixture}
images=$(jq -c '[.items[] as $d | $d.spec.template.spec.containers[] | {key:($d.metadata.name+"/"+.name),value:.image}]|from_entries' <<<"$deployments_good")
check(){ reactivation_deployments_are_acceptable "$1" "ghcr.io/yengalvez/hubs@sha256:$digest" "ghcr.io/yengalvez/reticulum@sha256:$digest" "ghcr.io/yengalvez/bot-orchestrator@sha256:$digest" "$images" "$bot_runner_image" durable-active "$2"; }
check "$deployments_good" true || exit 11
base=$(jq -c '(.items[]|select(.metadata.name=="bot-orchestrator")) |= (.spec.replicas=0|.status.readyReplicas=0|.metadata.annotations={"yenhubs.com/product-modules-schema":"1","yenhubs.com/product-bots":"false"}|.spec.template.metadata.annotations={"yenhubs.com/product-bots":"false"})' <<<"$deployments_good")
check "$base" false || exit 12
check "$base" true && exit 13
check "$deployments_good" false && exit 14
residual=$(jq -c '(.items[]|select(.metadata.name=="bot-orchestrator")|.status.replicas)=1' <<<"$base")
check "$residual" false && exit 15
exit 0`;
  const result=spawnSync("bash",["-c",command,"test",root],{encoding:"utf8"});
  assert.equal(result.status,0,result.stderr);
});

test("modern bot health binds AI OFF/ON, Luna High and unprobed provider status",()=>{
  const health={ok:true,runner_backend_default:"ghost",runner_backend_canary_room_count:0,ghost_navigation_mode:"navmesh_preferred",ghost_navigation_require_navmesh:true,llm_enabled:true,llm_status:"configured_not_probed",model:"gpt-6-luna",reasoning_effort:"high",max_bots_per_room:10,max_active_rooms:5};
  const check=(payload,ai)=>spawnSync("bash",["-c",'source "$1/deployment/lib/reactivation-gate-functions.sh"; reactivation_bot_health_matches_profile "$2" durable-active "$3" modules-v1',"test",root,JSON.stringify(payload),String(ai)],{encoding:"utf8"}).status;
  assert.equal(check(health,true),0);
  assert.equal(check({...health,llm_enabled:false,llm_status:"disabled"},false),0);
  for(const payload of [{...health,model:"gpt-5-nano"},{...health,reasoning_effort:"low"},{...health,llm_status:"ready"},{...health,llm_enabled:false},{...health,llm_status:"unconfigured"}])assert.notEqual(check(payload,true),0);
  assert.notEqual(check(health,false),0);
});
