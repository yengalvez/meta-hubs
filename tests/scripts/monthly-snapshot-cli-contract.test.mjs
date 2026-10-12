/** Installed CLI contract only: fictitious credentials and a non-forwarding loopback server. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { access, mkdtemp, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { nativeSnapshotProvider } from "../../deployment/monthly-snapshot-pair.mjs";
import { selectDoctlCredential } from "../../deployment/monthly-snapshot-api.mjs";

const token = "FICTIONAL-LOOPBACK-FIXTURE-NOT-A-REAL-DIGITALOCEAN-TOKEN";
const volumeId = "00000000-0000-4000-8000-000000000001";
const snapshotId = "00000000-0000-4000-8000-000000000002";
const operationId = "a".repeat(32), instanceId = "fixture-instance", month = "2026-10";
const name = `${instanceId}-${month}-database`;
const tags = ["yenhubs-monthly", instanceId, `month-${month}`, `operation-${operationId}`];
const createArgs = { volumeId, name, operationId, instanceId, month };
const snapshot = { id: snapshotId, name, resource_id: volumeId, resource_type: "volume",
  regions: ["ams3"], min_disk_size: 10, size_gigabytes: 1,
  created_at: "2026-10-12T00:00:00Z", tags };
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
let binary;
for (const directory of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
  const candidate = join(directory, "doctl");
  try { await access(candidate, constants.X_OK); binary = candidate; break; } catch { /* next PATH entry */ }
}
const cliTest = { timeout: 30000 };

async function withLoopback(t, { list = values => values, get = value => value, httpFailure = false,
  credentialConfig = {}, credentialEnv = {}, explicitToken = token, expectedToken = token } = {}, check) {
  assert.ok(binary, "installed doctl is required; the real CLI contract cannot be skipped");
  const home = await mkdtemp(join(tmpdir(), "yenhubs-monthly-cli-"));
  const config = join(home, "doctl.yaml");
  await writeFile(config, JSON.stringify(credentialConfig)+"\n", { flag: "wx", mode: 0o600 });
  const requests = [], sockets = new Set(), nativeCloses = [], rejectedProxyRequests = [];
  const stored = []; let fixtureError;
  const server = createServer(async (request, reply) => {
    const item = { method: request.method, path: request.url };
    requests.push(item);
    try {
      assert.equal(request.socket.remoteAddress, "127.0.0.1");
      assert.equal(request.headers.authorization, `Bearer ${expectedToken}`);
      const url = new URL(request.url, "http://127.0.0.1");
      const chunks = []; let length = 0;
      for await (const bytes of request) { length += bytes.length; assert.ok(length <= 8192); chunks.push(bytes); }
      let value, status = 200;
      if (request.method === "POST" && url.pathname === `/v2/volumes/${volumeId}/snapshots`) {
        assert.equal(requests.filter(value => value.method === "POST").length, 1, "No second POST is permitted");
        assert.equal(url.search, "");
        assert.deepEqual(JSON.parse(Buffer.concat(chunks)), { name, volume_id: volumeId, description: "", tags });
        if (httpFailure) { status = 500; value = { id: "internal_server_error", message: "FICTIONAL loopback failure" }; }
        else { status = 201; stored.push(structuredClone(snapshot)); value = { snapshot: stored[0] }; }
      } else if (request.method === "GET" && url.pathname === "/v2/snapshots") {
        assert.equal(length, 0);
        assert.equal(url.searchParams.get("resource_type"), "volume");
        assert.ok([...url.searchParams.keys()].every(key => ["resource_type", "page", "per_page"].includes(key)));
        const values = list(structuredClone(stored));
        value = { snapshots: values, links: {}, meta: { total: values.length } };
      } else if (request.method === "GET" && url.pathname === `/v2/snapshots/${snapshotId}`) {
        assert.equal(length, 0); assert.equal(url.search, "");
        assert.equal(stored.length, 1);
        value = { snapshot: get(structuredClone(stored[0])) };
      } else throw new Error("fixture_unexpected_request");
      reply.writeHead(status, { "Content-Type": "application/json", Connection: "close" });
      reply.end(JSON.stringify(value));
    } catch (error) {
      fixtureError ??= error;
      reply.writeHead(400, { "Content-Type": "application/json", Connection: "close" });
      reply.end(JSON.stringify({ id: "bad_request", message: "fixture contract rejected" }));
    }
  });
  server.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  // Even doctl's version checker cannot reach the network: this proxy never forwards.
  server.on("connect", (request, socket) => { rejectedProxyRequests.push(request.url); socket.destroy(); });
  server.maxRequestsPerSocket = 1;
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  assert.equal(server.address().address, "127.0.0.1");
  const apiUrl = `http://127.0.0.1:${server.address().port}/`;
  const env = { HOME: home, XDG_CONFIG_HOME: join(home, ".config"), PATH: "/usr/bin:/bin",
    LANG: "C", LC_ALL: "C", TZ: "UTC", NO_COLOR: "1", HTTP_PROXY: apiUrl, HTTPS_PROXY: apiUrl,
    ALL_PROXY: apiUrl, NO_PROXY: "127.0.0.1,localhost", ...credentialEnv };
  const globals = ["--config", config, ...(explicitToken ? ["--access-token", explicitToken] : []), "--api-url", apiUrl];
  async function native(args, options = { timeout: 30000 }) {
    assert.ok(options.timeout > 0 && options.timeout <= 30000);
    const result = await new Promise(resolve => {
      const child = spawn(binary, [...globals, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
      const stdout = [], stderr = []; let length = 0, timedOut = false, overflow = false, launchFailed = false, force;
      const terminate = () => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
        force ??= setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        }, 1000);
      };
      // The fixture is fast; this stricter local watchdog does not extend the provider deadline.
      const timer = setTimeout(() => { timedOut = true; terminate(); }, Math.min(options.timeout, 5000));
      child.once("error", () => { launchFailed = true; });
      for (const [stream, chunks] of [[child.stdout, stdout], [child.stderr, stderr]]) stream.on("data", chunk => {
        length += chunk.length;
        if (length > 65536) { overflow = true; terminate(); } else chunks.push(Buffer.from(chunk));
      });
      child.once("close", (nativeExitCode, signal) => {
        clearTimeout(timer); clearTimeout(force);
        const out = Buffer.concat(stdout), err = Buffer.concat(stderr);
        const evidence = { command: args.slice(0, 3), nativeExitCode, signal, nativeCloseObserved: true,
          timedOut, overflow, launchFailed, stdoutLength: out.length, stdoutSha256: sha(out),
          stderrLength: err.length, stderrSha256: sha(err) };
        nativeCloses.push(evidence);
        resolve({ stdout: out.toString("utf8"), stderr: err.toString("utf8"), evidence });
      });
    });
    assert.equal(result.evidence.timedOut, false); assert.equal(result.evidence.overflow, false);
    assert.equal(result.evidence.launchFailed, false);
    return result;
  }
  const provider = nativeSnapshotProvider(async (program, args, options) => {
    assert.equal(program, "doctl");
    assert.deepEqual(args.slice(-4), ["--output", "json", "--http-retry-max", "0"]);
    assert.equal(options.maxBuffer, 8 * 1024 * 1024);
    const result = await native(args, options);
    if (result.evidence.nativeExitCode !== 0 || result.evidence.signal !== null) throw new Error("fixture_native_nonzero");
    return result;
  });
  try {
    await check({ provider, native, requests, nativeCloses });
    if (fixtureError) throw fixtureError;
    assert.ok(rejectedProxyRequests.every(value => value === "api.github.com:443"));
  } finally {
    const closed = new Promise(resolve => server.close(resolve));
    server.closeAllConnections();
    for (const socket of sockets) socket.destroy();
    await closed;
    assert.equal(server.listening, false);
    assert.ok([...sockets].every(socket => socket.destroyed));
    assert.ok(nativeCloses.every(value => value.nativeCloseObserved));
    t.diagnostic(JSON.stringify({ nativeCloses, postCount: requests.filter(value => value.method === "POST").length,
      readCount: requests.filter(value => value.method === "GET").length,
      rejectedProxyRequests: rejectedProxyRequests.length, serverClosed: true, ownedSocketsClosed: true }));
  }
}

test("installed doctl 1.163.0 emits empty create stdout and preserves tags in list/get JSON", cliTest, async t => {
  await withLoopback(t, {}, async ({ native }) => {
    const version = await native(["version"]);
    assert.equal(version.evidence.nativeExitCode, 0);
    assert.match(version.stdout, /^doctl version 1\.163\.0(?:\b|-)/);
    const post = await native(["compute", "volume", "snapshot", volumeId, "--snapshot-name", name,
      "--tag", tags.join(","), "--output", "json", "--http-retry-max", "0"]);
    assert.equal(post.evidence.nativeExitCode, 0); assert.equal(post.evidence.signal, null);
    assert.equal(post.stdout, ""); assert.equal(post.stderr, "");
    for (const command of [["compute", "snapshot", "list", "--resource", "volume"], ["compute", "snapshot", "get", snapshotId]]) {
      const result = await native([...command, "--output", "json", "--http-retry-max", "0"]);
      assert.equal(result.evidence.nativeExitCode, 0); assert.equal(result.evidence.signal, null);
      assert.deepEqual(JSON.parse(result.stdout), [snapshot]);
    }
  });
});

test("native adapter accepts one real CLI POST only after unique list and exact GET", cliTest, async t => {
  await withLoopback(t, {}, async ({ provider, requests, nativeCloses }) => {
    assert.deepEqual(await provider.list(), []);
    assert.deepEqual(await provider.create(createArgs), snapshot);
    assert.deepEqual(await provider.get(snapshotId), snapshot);
    assert.deepEqual(requests.map(value => value.method), ["GET", "POST", "GET", "GET", "GET"]);
    assert.ok(nativeCloses.every(value => value.nativeExitCode === 0 && value.signal === null));
    assert.equal(nativeCloses[1].stdoutLength, 0);
  });
});

test("native adapter preserves real CLI HTTP failure and never repeats its POST", cliTest, async t => {
  await withLoopback(t, { httpFailure: true }, async ({ provider, requests, nativeCloses }) => {
    await assert.rejects(provider.create(createArgs), /monthly_provider_command_failed_or_ambiguous/);
    assert.deepEqual(requests.map(value => value.method), ["POST"]);
    assert.equal(nativeCloses[0].nativeExitCode, 1); assert.equal(nativeCloses[0].signal, null);
  });
});

for (const [label, list] of [
  ["absent", () => []],
  ["duplicate", values => [...values, { ...values[0], id: "00000000-0000-4000-8000-000000000003" }]]
]) test(`native adapter rejects ${label} real CLI list readback without another POST`, cliTest, async t => {
  await withLoopback(t, { list }, async ({ provider, requests }) => {
    await assert.rejects(provider.create(createArgs), /monthly_snapshot_identity_(?:unresolved|mismatch)/);
    assert.deepEqual(requests.map(value => value.method), ["POST", "GET"]);
  });
});

for(const [label,change] of [["wrong-volume",{resource_id:"00000000-0000-4000-8000-000000000004"}],["wrong-tag",{tags:tags.filter(t=>!t.startsWith("operation-"))}]])
test(`native adapter rejects ${label} canonical real CLI GET without another POST`,cliTest,async t=>{
  await withLoopback(t,{get:value=>({...value,...change})},async({provider,requests})=>{
    await assert.rejects(provider.create(createArgs),/monthly_snapshot_identity_mismatch/);
    assert.deepEqual(requests.map(v=>v.method),["POST","GET","GET"]);
  });
});
test("installed CLI accepts an incomplete LIST only after a complete GET of the same ID",cliTest,async t=>{
  const observed=[];
  await withLoopback(t,{list:values=>values.map(v=>({id:v.id,name:v.name}))},async({provider,requests})=>{
    assert.deepEqual(await provider.create({...createArgs,observe:async e=>observed.push(e)}),snapshot);
    assert.deepEqual(requests.map(v=>v.method),["POST","GET","GET"]);
    assert.equal(observed[0].candidates[0].checks.tags,false);assert.equal(observed[1].candidates[0].checks.tags,true);
  });
});

test("native adapter rechecks operation tags on the guarded real CLI GET", cliTest, async t => {
  let gets=0;
  await withLoopback(t, { get: value => ++gets>1 ? ({ ...value, tags: ["wrong-operation"] }) : value }, async ({ provider, requests }) => {
    await provider.create(createArgs);
    await assert.rejects(provider.get(snapshotId), /monthly_snapshot_identity_mismatch/);
    assert.deepEqual(requests.map(value => value.method), ["POST", "GET", "GET", "GET"]);
  });
});

test("installed doctl and the API adapter select the same fictitious context/environment credential",cliTest,async t=>{
  const config={context:'active','access-token':'FICTITIOUS-ROOT','auth-contexts':{active:'FICTITIOUS-ACTIVE',alternate:'FICTITIOUS-ALTERNATE'}};
  for(const [source,env] of [[config,{}],[config,{DIGITALOCEAN_CONTEXT:'alternate'}],
    [config,{DIGITALOCEAN_ACCESS_TOKEN:'FICTITIOUS-ENV'}],
    [config,{DIGITALOCEAN_CONTEXT:'alternate',DIGITALOCEAN_ACCESS_TOKEN:'FICTITIOUS-ENV'}],
    [{...config,context:'default'},{DIGITALOCEAN_ACCESS_TOKEN:'FICTITIOUS-ENV'}],[{...config,context:'default'},{}],
    [{...config,context:undefined},{DIGITALOCEAN_ACCESS_TOKEN:'FICTITIOUS-ENV'}]]){
    const expected=selectDoctlCredential(source,env);
    await withLoopback(t,{credentialConfig:source,credentialEnv:env,explicitToken:null,expectedToken:expected},async({native,requests})=>{
      const result=await native(['compute','snapshot','list','--resource','volume','--output','json','--http-retry-max','0']);
      assert.equal(result.evidence.nativeExitCode,0);assert.equal(result.evidence.signal,null);
      assert.deepEqual(JSON.parse(result.stdout),[]);assert.equal(requests.length,1);
    });
  }
});
