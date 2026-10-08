/** Native kubectl protocol proof against loopback ONLY; no real Kubernetes writes. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { runExportNative } from "../../deployment/monthly-snapshot-export-provider.mjs";

process.umask(0o077);
const began = performance.now();
const root = await realpath(await mkdtemp(join(tmpdir(), "yenhubs-kubectl-wire-fixture-")));
const uid = "00000000-0000-4000-8000-000000000001", name = "monthly-export-wire-fixture";
const requests = [];
let namespace;
const server = createServer(async (request, response) => {
  try {
    let raw = "";
    for await (const bytes of request) { raw += bytes; assert.ok(raw.length < 65536); }
    const body = raw ? JSON.parse(raw) : null;
    requests.push({ method: request.method, path: request.url, body });
    const url = new URL("http://127.0.0.1" + request.url);
    assert.equal(url.searchParams.get("timeout"), "10s");
    response.setHeader("Content-Type", "application/json");
    if (request.method === "POST" && url.pathname === "/api/v1/namespaces") {
      assert.equal(body.kind, "Namespace"); assert.equal(body.metadata.name, name); assert.ok(!namespace);
      namespace = { ...body, metadata: { ...body.metadata, uid, resourceVersion: "7" } };
      response.statusCode = 201; response.end(JSON.stringify(namespace)); return;
    }
    if (request.method === "GET" && url.pathname === "/api/v1/namespaces") {
      assert.equal(url.searchParams.get("fieldSelector"), `metadata.name=${name}`);
      response.end(JSON.stringify({ apiVersion: "v1", kind: "NamespaceList", items: namespace ? [namespace] : [] })); return;
    }
    if (request.method === "DELETE" && url.pathname === `/api/v1/namespaces/${name}`) {
      assert.deepEqual(body.preconditions, { uid, resourceVersion: "7" });
      assert.equal(body.kind, "DeleteOptions"); assert.equal(body.propagationPolicy, "Foreground");
      assert.ok(namespace); namespace = undefined;
      response.end(JSON.stringify({ apiVersion: "v1", kind: "Status", status: "Success" })); return;
    }
    throw new Error("unexpected_fixture_request");
  } catch {
    response.statusCode = 400; response.end(JSON.stringify({ apiVersion: "v1", kind: "Status", status: "Failure" }));
  }
});
server.listen(0, "127.0.0.1");
await new Promise(resolve => server.once("listening", resolve));
const config = join(root, "fixture-kubeconfig.json");
await writeFile(config, JSON.stringify({ apiVersion: "v1", kind: "Config",
  clusters: [{ name: "loopback-only", cluster: { server: `http://127.0.0.1:${server.address().port}` } }],
  users: [{ name: "no-real-credential", user: {} }], contexts: [{ name, context: { cluster: "loopback-only", user: "no-real-credential" } }],
  "current-context": name }), { mode: 0o600 });
const call = async (verb, path, body = null) => {
  try {
    return await runExportNative("kubectl", ["--kubeconfig", config, "--context", name,
      "--request-timeout=10s", verb, "--raw", path, ...(body ? ["-f", "-"] : [])],
    { input: body ? JSON.stringify(body) : null });
  } catch {
    throw new Error(`loopback_native_${verb}_failed: ${JSON.stringify(requests.map(request =>
      ({ method: request.method, path: request.path, kind: request.body?.kind })))}`);
  }
};
try {
  const result = await call("create", "/api/v1/namespaces", { apiVersion: "v1", kind: "Namespace", metadata: { name } });
  assert.equal(result.nativeExitCode, 0); assert.equal(JSON.parse(result.stdout).metadata.uid, uid);
  const path = "/api/v1/namespaces?fieldSelector=" + encodeURIComponent(`metadata.name=${name}`);
  assert.equal(JSON.parse((await call("get", path)).stdout).items.length, 1);
  await call("delete", `/api/v1/namespaces/${name}`, { apiVersion: "v1", kind: "DeleteOptions",
    propagationPolicy: "Foreground", preconditions: { uid, resourceVersion: "7" } });
  assert.equal(JSON.parse((await call("get", path)).stdout).items.length, 0);
  assert.deepEqual(requests.map(r => r.method), ["POST", "GET", "DELETE", "GET"]);
  const evidence = { status: "PASS", scope: "native-kubectl-loopback-protocol-only", realClusterWrites: 0,
    originalExitCodes: [0, 0, 0, 0], requests: 4, uidAndResourceVersionPreconditions: true,
    totalMilliseconds: Math.round(performance.now() - began), fixtureRoot: root };
  await writeFile(join(root, "proof-result.json"), JSON.stringify(evidence, null, 2) + "\n", { mode: 0o600 });
  console.log(JSON.stringify(evidence));
} finally {
  await new Promise(resolve => server.close(resolve));
}
