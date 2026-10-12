import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:https';
import {mkdtemp,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {nativeVolumeSnapshotAPI,selectDoctlCredential} from '../../deployment/monthly-snapshot-api.mjs';
import {nativeSnapshotProvider} from '../../deployment/monthly-snapshot-pair.mjs';
import {runExportNative} from '../../deployment/monthly-snapshot-export-provider.mjs';
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const args={volumeId:id(1),name:'fixture-2026-10-database',operationId:'a'.repeat(32),instanceId:'fixture',month:'2026-10',region:'ams3'};
const tags=['yenhubs-monthly','fixture','month-2026-10','operation-'+args.operationId];
const snapshot={id:id(2),name:args.name,resource_id:args.volumeId,resource_type:'volume',regions:['ams3'],min_disk_size:10,
  size_gigabytes:0.2888,created_at:'2026-10-13T00:00:00Z',tags};
test('credential selects the existing active context, not a different root token',()=>{
  const c={context:'active','access-token':'OTHER-FICTITIOUS','auth-contexts':{active:'ACTIVE-FICTITIOUS'}};
  assert.equal(selectDoctlCredential(c),'ACTIVE-FICTITIOUS');
  assert.equal(selectDoctlCredential(c,{DIGITALOCEAN_ACCESS_TOKEN:'ENV-FICTITIOUS'}),'ACTIVE-FICTITIOUS');
  assert.equal(selectDoctlCredential({...c,context:'default'},{DIGITALOCEAN_ACCESS_TOKEN:'ENV-FICTITIOUS'}),'ENV-FICTITIOUS');
  assert.throws(()=>selectDoctlCredential({...c,context:''},{DIGITALOCEAN_ACCESS_TOKEN:'ENV-FICTITIOUS'}));
  assert.throws(()=>selectDoctlCredential({...c,context:'missing'}));
  assert.throws(()=>selectDoctlCredential({...c,'api-url':'https://foreign.invalid/'}));
});
test('API retains POST ID and GETs that exact volume snapshot without asking a stale catalogue',async()=>{
  const calls=[],observed=[];const token='FICTITIOUS-ONLY-API-TOKEN';
  const api=nativeVolumeSnapshotAPI({authorize:async()=>token,run:async(program,argv,options)=>{
    calls.push(argv);assert.equal(program,'curl');assert.ok(!argv.some(v=>v.includes(token)));
    assert.match(options.input,/Authorization: Bearer FICTITIOUS-ONLY-API-TOKEN/);
    return {nativeExitCode:0,stdout:JSON.stringify({snapshot})+'\n__YENHUBS_HTTP__'+(argv.includes('POST')?'201':'200')};
  }});
  const provider=nativeSnapshotProvider(async()=>{throw Error('stale catalogue must not be queried by create');},{api});
  assert.deepEqual(await provider.create({...args,observe:async e=>observed.push(e)}),snapshot);
  assert.equal(calls.length,2);assert.ok(calls[1].includes('https://api.digitalocean.com/v2/volumes/snapshots/'+id(2)));
  assert.deepEqual(observed.map(e=>e.view),['post','canonical']);
});
test('ambiguous or failed POST never causes GET or another POST',async()=>{
  for(const failure of ['http','native','json','id']){
    let calls=0;const api=nativeVolumeSnapshotAPI({authorize:async()=> 'FIXTURE',run:async()=>{
      calls++;if(failure==='native')throw Error('PRIVATE DETAIL MUST NOT ESCAPE');
      return {nativeExitCode:0,stdout:(failure==='json'?'wrong JSON':JSON.stringify({snapshot:{...snapshot,id:failure==='id'?'bad':snapshot.id}}))+'\n__YENHUBS_HTTP__'+(failure==='http'?'500':'201')};
    }});
    const p=nativeSnapshotProvider(undefined,{api});await assert.rejects(p.create(args),e=>e.message.startsWith('monthly_api_'));
    assert.equal(calls,1);
  }
});
test('canonical GET cannot substitute the POST ID even if its other fields match',async()=>{
  let posts=0;const api={create:async()=>{posts++;return snapshot;},get:async()=>({...snapshot,id:id(9)})};
  await assert.rejects(nativeSnapshotProvider(undefined,{api}).create(args),/monthly_snapshot_identity_mismatch/);assert.equal(posts,1);
});
test('credential header injection and unexpected API paths fail before network',async()=>{
  let calls=0;const api=nativeVolumeSnapshotAPI({authorize:async()=> 'bad\nheader',run:async()=>{calls++;}});
  await assert.rejects(api.create({...args,tags},30000),/monthly_api_credential_unavailable/);
  await assert.rejects(api.get('foreign/id',30000),/monthly_api_snapshot_id_unproven/);assert.equal(calls,0);
});
test('credential resolution consumes the original budget and cannot start a late POST',async()=>{
  for(const elapsed of [8000,30000,30001]){
    let clock=0,calls=0;const api=nativeVolumeSnapshotAPI({now:()=>clock,authorize:async()=>{clock=elapsed;return 'FICTITIOUS';},
      run:async(program,argv,options)=>{calls++;assert.equal(options.timeout,30000-elapsed);
        assert.equal(argv[argv.indexOf('--max-time')+1],String((30000-elapsed)/1000));
        return {nativeExitCode:0,stdout:JSON.stringify({snapshot})+'\n__YENHUBS_HTTP__201'};}});
    if(elapsed>=30000){await assert.rejects(api.create({...args,tags},30000),/monthly_api_deadline_expired/);assert.equal(calls,0);}
    else{assert.deepEqual(await api.create({...args,tags},30000),snapshot);assert.equal(calls,1);}
  }
});
test('installed curl sends POST JSON and retains the exact ID over verified loopback TLS', {timeout:15000},async t=>{
  const home=await mkdtemp(join(tmpdir(),'yenhubs-api-wire-')),key=join(home,'key.pem'),cert=join(home,'cert.pem');
  await runExportNative('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,
    '-days','1','-subj','/CN=api.digitalocean.com','-addext','subjectAltName=DNS:api.digitalocean.com']);
  const calls=[],sockets=new Set();let fixtureError;
  const server=createServer({key:await readFile(key),cert:await readFile(cert)},async(request,reply)=>{
    try{
      assert.equal(request.socket.remoteAddress,'127.0.0.1');assert.equal(request.headers.authorization,'Bearer FICTITIOUS-WIRE-TOKEN');
      const body=[];for await(const chunk of request)body.push(chunk);
      calls.push({method:request.method,path:request.url});
      if(request.method==='POST'){
        assert.equal(request.url,'/v2/volumes/'+args.volumeId+'/snapshots');
        assert.deepEqual(JSON.parse(Buffer.concat(body)),{name:args.name,tags});reply.writeHead(201);
      }else{
        assert.equal(request.method,'GET');assert.equal(request.url,'/v2/volumes/snapshots/'+snapshot.id);
        assert.equal(Buffer.concat(body).length,0);reply.writeHead(200);
      }
      reply.end(JSON.stringify({snapshot}));
    }catch(error){fixtureError=error;reply.writeHead(400);reply.end('{}');}
  });
  server.on('connection',socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  try{
    const api=nativeVolumeSnapshotAPI({authorize:async()=> 'FICTITIOUS-WIRE-TOKEN',run:async(program,argv,options)=>{
      assert.equal(program,'curl');assert.ok(!argv.some(v=>v.includes('FICTITIOUS-WIRE-TOKEN')));
      return runExportNative('/usr/bin/curl',[...argv,'--connect-to',`api.digitalocean.com:443:127.0.0.1:${server.address().port}`,
        '--cacert',cert,'--noproxy','*'],{...options,env:{PATH:'/usr/bin:/bin',HOME:home}});
    }});
    const provider=nativeSnapshotProvider(async()=>{throw Error('catalogue must not be used');},{api});
    assert.deepEqual(await provider.create(args),snapshot);if(fixtureError)throw fixtureError;
    assert.deepEqual(calls.map(c=>c.method),['POST','GET']);
  }finally{
    const closed=new Promise(resolve=>server.close(resolve));server.closeAllConnections();for(const socket of sockets)socket.destroy();await closed;
    t.diagnostic(JSON.stringify({transport:'installed-curl',nativeExit:0,posts:calls.filter(c=>c.method==='POST').length,
      verifiedTLS:true,serverClosed:!server.listening,ownedSocketsClosed:[...sockets].every(s=>s.destroyed)}));
  }
});
