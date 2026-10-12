/** Retain POST's native snapshot ID. No catalogue discovery, credential output or retry. */
import {homedir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {readPrivateBytes} from './monthly-snapshot-worker.mjs';
import {runExportNative} from './monthly-snapshot-export-provider.mjs';
const require=createRequire(new URL('../hubs-cloud/community-edition/package.json',import.meta.url));
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const need=(ok,reason)=>{if(!ok)throw new Error(reason);};
export function selectDoctlCredential(config,env={}){
  need(!config['api-url']||config['api-url']==='https://api.digitalocean.com'||config['api-url']==='https://api.digitalocean.com/', 'monthly_api_origin_invalid');
  const context=env.DIGITALOCEAN_CONTEXT||(config.context??'default');
  need(typeof context==='string'&&context.length>0,'monthly_api_credential_unavailable');
  const token=context==='default' ? (env.DIGITALOCEAN_ACCESS_TOKEN||config['access-token']) : config['auth-contexts']?.[context];
  need(typeof token==='string'&&token.length>0&&token.length<4096&&!/[\s"\\]/.test(token),'monthly_api_credential_unavailable');
  return token;
}
async function credential(){
  const bytes=await readPrivateBytes(join(homedir(),'Library/Application Support/doctl/config.yaml'),65536);
  try{return selectDoctlCredential(require('yaml').parse(bytes.toString('utf8')),process.env);}
  finally{bytes.fill(0);}
}
export function nativeVolumeSnapshotAPI({run=runExportNative,authorize=credential,now=Date.now}={}){
  async function request(method,path,body,timeout){
    need(Number.isInteger(timeout)&&timeout>0&&timeout<=30000,'monthly_api_deadline_invalid');
    const deadline=now()+timeout;
    need((method==='POST'&&/^\/v2\/volumes\/[a-f0-9-]{36}\/snapshots$/.test(path))||
      (method==='GET'&&/^\/v2\/volumes\/snapshots\/[a-f0-9-]{36}$/.test(path)), 'monthly_api_path_invalid');
    const token=await authorize();need(typeof token==='string'&&token.length>0&&token.length<4096&&!/[\s"\\]/.test(token),'monthly_api_credential_unavailable');
    const remaining=deadline-now();need(Number.isInteger(remaining)&&remaining>0&&remaining<=timeout,'monthly_api_deadline_expired');
    // Secrets go only through stdin to the existing HTTPS client, never argv.
    const config=`header = "Authorization: Bearer ${token}"\nheader = "Content-Type: application/json"\n`+
      (body?`data = ${JSON.stringify(JSON.stringify(body))}\n`:'');
    let result;try{result=await run('curl',['--disable','--silent','--show-error','--proto','=https',
      '--max-time',String(remaining/1000),'--request',method,'--url','https://api.digitalocean.com'+path,
      '--config','-','--write-out','\n__YENHUBS_HTTP__%{http_code}'],{input:config,timeout:remaining});}
    catch{throw new Error('monthly_api_request_failed_or_ambiguous');}
    const match=/\n__YENHUBS_HTTP__([0-9]{3})$/.exec(result.stdout);
    need(result.nativeExitCode===0&&match&&Number(match[1])===(method==='POST'?201:200),'monthly_api_http_failed_or_ambiguous');
    let value;try{value=JSON.parse(result.stdout.slice(0,match.index));}catch{throw new Error('monthly_api_response_invalid');}
    need(value?.snapshot&&uuid.test(value.snapshot.id??''),'monthly_api_snapshot_id_unproven');
    return value.snapshot;
  }
  return {
    async create({volumeId,name,tags},timeout){need(uuid.test(volumeId)&&typeof name==='string'&&/^[a-z0-9-]{1,100}$/.test(name)&&
      Array.isArray(tags)&&tags.length===4&&tags.every(t=>/^[a-z0-9-]{1,64}$/.test(t)), 'monthly_api_create_invalid');
      return request('POST',`/v2/volumes/${volumeId}/snapshots`,{name,tags},timeout);},
    async get(id,timeout){need(uuid.test(id),'monthly_api_snapshot_id_unproven');return request('GET',`/v2/volumes/snapshots/${id}`,null,timeout);}
  };
}
