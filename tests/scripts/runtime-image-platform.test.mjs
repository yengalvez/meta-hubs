import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import {
  PROCESS_LOCAL_IMAGE_PULL_CONTRACTS,
  verifyGhcrPullAccess,
  verifyProcessLocalValuesRuntimeImages
} from "../../deployment/verify-bot-image-pull-config.mjs";

const OCI_INDEX = "application/vnd.oci.image.index.v1+json";
const OCI_MANIFEST = "application/vnd.oci.image.manifest.v1+json";
const OCI_CONFIG = "application/vnd.oci.image.config.v1+json";
const DOCKER_INDEX = "application/vnd.docker.distribution.manifest.list.v2+json";
const DOCKER_MANIFEST = "application/vnd.docker.distribution.manifest.v2+json";
const DOCKER_CONFIG = "application/vnd.docker.container.image.v1+json";
const fakeBasic = Buffer.from("fixture-principal:fixture-private-token").toString("base64");
const fakeEncoded = Buffer.from(JSON.stringify({ auths: { "ghcr.io": { auth: fakeBasic } } })).toString("base64");
const digestOf = bytes => `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
const layerBytes = Buffer.from("fixture-layer-not-downloaded");
const layerDigest = digestOf(layerBytes);

function document(payload, mediaType) {
  // Hash these actual, non-canonical bytes, never a reserialized parsed value.
  const bytes = Buffer.from(` ${JSON.stringify(payload, null, 2)}\n`);
  return { payload, bytes, digest: digestOf(bytes), mediaType };
}

function descriptor(doc, extra = {}) {
  return { mediaType: doc.mediaType, digest: doc.digest, size: doc.bytes.length, ...extra };
}

function fixture({ docker = false, indexed = true, config = {}, manifest = {}, index = {}, entries,
  configDescriptor = {}, childDescriptor = {}, nesting = 0 } = {}) {
  const configDoc = document({
    os: "linux", architecture: "amd64", rootfs: { type: "layers", diff_ids: [layerDigest] }, ...config
  }, docker ? DOCKER_CONFIG : OCI_CONFIG);
  const manifestDoc = document({
    schemaVersion: 2,
    mediaType: docker ? DOCKER_MANIFEST : OCI_MANIFEST,
    config: descriptor(configDoc, configDescriptor),
    layers: [{
      mediaType: docker ? "application/vnd.docker.image.rootfs.diff.tar.gzip"
        : "application/vnd.oci.image.layer.v1.tar+gzip",
      digest: layerDigest, size: layerBytes.length,
      urls: ["https://untrusted.invalid/never-download-layer"]
    }],
    ...manifest
  }, docker ? DOCKER_MANIFEST : OCI_MANIFEST);
  const docs = new Map([configDoc, manifestDoc].map(doc => [doc.digest, doc]));
  let root = manifestDoc;
  if (indexed) {
    const attestation = {
      mediaType: OCI_MANIFEST, digest: digestOf(Buffer.from("unfetched-attestation")), size: 321,
      platform: { os: "unknown", architecture: "unknown" },
      annotations: { "vnd.docker.reference.type": "attestation-manifest" },
      urls: ["https://untrusted.invalid/never-download-attestation"]
    };
    root = document({
      schemaVersion: 2, mediaType: docker ? DOCKER_INDEX : OCI_INDEX,
      manifests: entries ?? [attestation, descriptor(manifestDoc, {
        platform: { os: "linux", architecture: "amd64" },
        urls: ["https://untrusted.invalid/never-follow-descriptor"], ...childDescriptor
      })], ...index
    }, docker ? DOCKER_INDEX : OCI_INDEX);
    docs.set(root.digest, root);
    for (let level = 0; level < nesting; level += 1) {
      root = document({
        schemaVersion: 2, mediaType: docker ? DOCKER_INDEX : OCI_INDEX,
        manifests: [descriptor(root, { platform: { os: "linux", architecture: "amd64" } })]
      }, docker ? DOCKER_INDEX : OCI_INDEX);
      docs.set(root.digest, root);
    }
  }
  return { root, configDoc, manifestDoc, docs };
}

function snapshotFor(f, aliasRound = null) {
  return Object.fromEntries([
    ["BOT_IMAGE_PULL_CONFIG_JSON_BASE64", fakeEncoded],
    ...PROCESS_LOCAL_IMAGE_PULL_CONTRACTS.map(contract => {
      const alternatives = contract.repositories.filter(repository => !repository.startsWith("ghcr.io/"));
      const repository = aliasRound !== null && alternatives.length
        ? alternatives[aliasRound % alternatives.length] : contract.repositories[0];
      return [contract.valueKey, `${repository}@${f.root.digest}`];
    })
  ]);
}

function registry(f, hook = null) {
  const calls = [];
  const fetchImpl = async (input, init) => {
    const url = new URL(input);
    assert.ok(init.signal instanceof AbortSignal);
    assert.equal(url.protocol, "https:");
    assert.equal(url.username, "");
    assert.equal(url.password, "");
    assert.ok(!url.href.includes(fakeBasic) && !url.href.includes("fixture-private-token"));
    const token = url.pathname === "/token";
    const ghcr = url.origin === "https://ghcr.io";
    const cdn = ["https://production.cloudfront.docker.com", "https://pkg-containers.githubusercontent.com"]
      .includes(url.origin);
    let repository;
    let kind;
    let requestedDigest;
    if (cdn) {
      const match = url.pathname.match(/^\/fixture-cdn\/([a-z0-9/-]+)\/config\/(sha256:[a-f0-9]{64})$/u);
      assert.ok(match);
      [, repository, requestedDigest] = match;
      kind = "cdn";
      assert.deepEqual(Object.keys(init.headers), ["Accept"]);
      assert.equal(init.method, "GET");
      assert.equal(init.credentials, "omit");
      assert.equal(init.referrerPolicy, "no-referrer");
      assert.equal(url.searchParams.get("fixture-signature"), "opaque");
    } else if (token) {
      assert.ok(ghcr || url.origin === "https://auth.docker.io");
      assert.equal(url.searchParams.get("service"), ghcr ? "ghcr.io" : "registry.docker.io");
      const match = url.searchParams.get("scope")?.match(/^repository:([a-z0-9/-]+):pull$/u);
      assert.ok(match);
      repository = match[1];
      kind = "token";
      assert.equal(init.headers.Authorization, ghcr ? `Basic ${fakeBasic}` : undefined);
    } else {
      assert.ok(ghcr || url.origin === "https://registry-1.docker.io");
      assert.equal(url.search, "");
      const match = url.pathname.match(/^\/v2\/([a-z0-9/-]+)\/(manifests|blobs)\/(sha256:[a-f0-9]{64})$/u);
      assert.ok(match);
      [, repository, kind, requestedDigest] = match;
      assert.equal(init.headers.Authorization, `Bearer fixture-bearer-${repository}`);
      assert.ok(!init.headers.Authorization.includes(fakeBasic));
    }
    assert.equal(init.redirect, ["blobs", "cdn"].includes(kind) ? "manual" : "error");
    const doc = f.docs.get(requestedDigest);
    const call = { url, init, kind, repository, digest: requestedDigest, doc };
    calls.push(call);
    if (hook) {
      const overridden = await hook(call);
      if (overridden !== undefined) return overridden;
    }
    if (token) return new Response(JSON.stringify(
      ghcr ? { token: `fixture-bearer-${repository}` } : { access_token: `fixture-bearer-${repository}` }
    ));
    assert.ok(doc, `fixture document must exist for ${kind}`);
    return responseFor(doc, requestedDigest);
  };
  return { fetchImpl, calls };
}

function responseFor(doc, requestedDigest = doc.digest, { bytes = doc.bytes, headers = {} } = {}) {
  return new Response(bytes, { headers: {
    "content-type": doc.mediaType,
    "content-length": String(bytes.length),
    "docker-content-digest": requestedDigest,
    ...headers
  } });
}

function configCdnUrl(call) {
  const origin = call.url.origin === "https://ghcr.io" ? "https://pkg-containers.githubusercontent.com"
    : "https://production.cloudfront.docker.com";
  return `${origin}/fixture-cdn/${call.repository}/config/${call.digest}?fixture-signature=opaque`;
}

function redirectedRegistry(f, cdnHook = null) {
  return registry(f, call => {
    if (call.kind === "blobs") return new Response(null, { status: 307, headers: {
      Location: configCdnUrl(call), "Set-Cookie": "fixture-cookie=never-forward",
      "WWW-Authenticate": 'Bearer realm="https://untrusted.invalid/never-follow"'
    } });
    if (call.kind === "cdn" && cdnHook) return cdnHook(call);
    return undefined;
  });
}

function valueFree(code) {
  return error => error.code === code && error.message === code &&
    !String(error).includes("fixture-private-token") && !String(error).includes(fakeBasic);
}

async function rejectsFixture(f, code, hook = null) {
  const r = registry(f, hook);
  await assert.rejects(verifyProcessLocalValuesRuntimeImages({
    snapshot: snapshotFor(f), fetchImpl: r.fetchImpl
  }), valueFree(code));
  return r;
}

test("all 13 GHCR roles verify raw OCI index, AMD64 child and config, without fetching attestations/layers/URLs", async () => {
  const f = fixture();
  const r = registry(f);
  assert.equal(PROCESS_LOCAL_IMAGE_PULL_CONTRACTS.length, 13);
  assert.equal(await verifyProcessLocalValuesRuntimeImages({ snapshot: snapshotFor(f), fetchImpl: r.fetchImpl }), true);
  assert.equal(r.calls.length, 13 * 4);
  assert.equal(r.calls.filter(call => call.kind === "blobs").length, 13);
  for (const contract of PROCESS_LOCAL_IMAGE_PULL_CONTRACTS) {
    const repository = contract.repositories[0].slice("ghcr.io/".length);
    const calls = r.calls.filter(call => call.repository === repository);
    assert.equal(calls.length, 4);
    assert.equal(new Set(calls.map(call => call.init.signal)).size, 1);
    assert.deepEqual(calls.filter(call => call.digest).map(call => call.digest),
      [f.root.digest, f.manifestDoc.digest, f.configDoc.digest]);
  }
});

test("Docker schema2 manifests verify for all allowed Docker Hub aliases, using only anonymous scoped public tokens", async () => {
  const f = fixture({ docker: true, indexed: false });
  const acceptedAliases = new Set();
  for (let round = 0; round < 3; round += 1) {
    const snapshot = snapshotFor(f, round);
    const r = registry(f);
    assert.equal(await verifyProcessLocalValuesRuntimeImages({ snapshot, fetchImpl: r.fetchImpl }), true);
    assert.equal(r.calls.length, 13 * 3);
    const dockerTokens = r.calls.filter(call => call.url.origin === "https://auth.docker.io");
    assert.equal(dockerTokens.length, 5);
    for (const call of dockerTokens) assert.equal(call.init.headers.Authorization, undefined);
    assert.ok(dockerTokens.some(call => call.repository === "library/postgres"));
    for (const value of Object.values(snapshot)) {
      const repository = value.split("@")[0];
      if (!repository.startsWith("ghcr.io/") && value.includes("@")) acceptedAliases.add(repository);
    }
  }
  assert.deepEqual([...acceptedAliases].sort(), PROCESS_LOCAL_IMAGE_PULL_CONTRACTS
    .flatMap(contract => contract.repositories.filter(repo => !repo.startsWith("ghcr.io/"))).sort());
});

test("Docker manifest lists and bounded nested OCI indexes are supported", async () => {
  for (const f of [fixture({ docker: true }), fixture({ nesting: 2 })]) {
    const r = registry(f);
    assert.equal(await verifyProcessLocalValuesRuntimeImages({ snapshot: snapshotFor(f), fetchImpl: r.fetchImpl }), true);
  }
});

test("each role must have its exact allowlisted lowercase digest ref before any fetch, including runner", async () => {
  const f = fixture();
  for (const contract of PROCESS_LOCAL_IMAGE_PULL_CONTRACTS) {
    for (const badValue of [undefined, `${contract.repositories[0]}:latest`,
      `ghcr.io/yengalvez/foreign@${f.root.digest}`, `${contract.repositories[0]}@${f.root.digest.toUpperCase()}`]) {
      const snapshot = snapshotFor(f);
      if (badValue === undefined) delete snapshot[contract.valueKey];
      else snapshot[contract.valueKey] = badValue;
      let calls = 0;
      await assert.rejects(verifyProcessLocalValuesRuntimeImages({
        snapshot, fetchImpl: () => { calls += 1; }
      }), valueFree("process_local_image_contract"));
      assert.equal(calls, 0);
    }
  }
  const snapshot = snapshotFor(f);
  snapshot.OVERRIDE_BOT_RUNNER_IMAGE = snapshot.OVERRIDE_BOT_ORCHESTRATOR_IMAGE;
  await assert.rejects(verifyProcessLocalValuesRuntimeImages({ snapshot, fetchImpl: () => assert.fail("no fetch") }),
    valueFree("process_local_image_contract"));
});

test("invalid API inputs or credential are rejected without network", async () => {
  const f = fixture();
  for (const requestTimeoutMs of [0, 15_001, 1.5, Infinity]) {
    await assert.rejects(verifyProcessLocalValuesRuntimeImages({
      snapshot: snapshotFor(f), requestTimeoutMs, fetchImpl: () => assert.fail("no fetch")
    }), valueFree("registry_input"));
  }
  await assert.rejects(verifyProcessLocalValuesRuntimeImages({ snapshot: null }), valueFree("process_local_snapshot_invalid"));
  await assert.rejects(verifyProcessLocalValuesRuntimeImages({ snapshot: snapshotFor(f), fetchImpl: null }), valueFree("registry_input"));
  await assert.rejects(verifyProcessLocalValuesRuntimeImages({
    snapshot: { ...snapshotFor(f), BOT_IMAGE_PULL_CONFIG_JSON_BASE64: "not-canonical" },
    fetchImpl: () => assert.fail("no fetch")
  }), valueFree("credential_contract"));
});

test("correct digest headers cannot bless wrong raw root, child or config bytes", async () => {
  const f = fixture();
  for (const [digest, code] of [[f.root.digest, "registry_manifest_digest"],
    [f.manifestDoc.digest, "registry_manifest_digest"], [f.configDoc.digest, "registry_config_digest"]]) {
    await rejectsFixture(f, code, call => call.digest === digest
      ? responseFor(call.doc, digest, { bytes: Buffer.concat([call.doc.bytes, Buffer.from(" ")]) }) : undefined);
  }
  await rejectsFixture(f, "registry_manifest_digest", call => call.digest === f.root.digest
    ? responseFor(call.doc, call.digest, { headers: { "docker-content-digest": layerDigest } }) : undefined);
});

test("child/config descriptor sizes, digests and media types must match raw documents", async () => {
  const base = fixture();
  await rejectsFixture(fixture({ childDescriptor: { size: base.manifestDoc.bytes.length + 1 } }), "registry_runtime_size");
  await rejectsFixture(fixture({ configDescriptor: { size: base.configDoc.bytes.length + 1 } }), "registry_runtime_size");
  await rejectsFixture(fixture({ childDescriptor: { mediaType: DOCKER_MANIFEST } }), "registry_runtime_media_type");
  const wrongChild = fixture({ childDescriptor: { digest: layerDigest } });
  await rejectsFixture(wrongChild, "registry_manifest_digest", call => call.digest === layerDigest
    ? responseFor(wrongChild.manifestDoc, layerDigest) : undefined);
  const wrongConfig = fixture({ indexed: false, configDescriptor: { digest: layerDigest } });
  await rejectsFixture(wrongConfig, "registry_config_digest", call => call.digest === layerDigest
    ? responseFor(wrongConfig.configDoc, layerDigest) : undefined);
  await rejectsFixture(fixture({ configDescriptor: { size: 0 } }), "registry_runtime_descriptor");
  await rejectsFixture(fixture({ configDescriptor: { digest: layerDigest.toUpperCase() } }), "registry_runtime_descriptor");
  await rejectsFixture(fixture({ configDescriptor: { mediaType: DOCKER_CONFIG } }), "registry_runtime_media_type");
});

test("root response type is known and consistent with payload and selected descriptor", async () => {
  const f = fixture();
  for (const type of ["application/json", "application/octet-stream", "", DOCKER_MANIFEST]) {
    await rejectsFixture(f, "registry_runtime_media_type", call => call.digest === f.root.digest
      ? responseFor(call.doc, call.digest, { headers: { "content-type": type } }) : undefined);
  }
  await rejectsFixture(fixture({ index: { mediaType: DOCKER_INDEX } }), "registry_runtime_media_type");
  // Registry blob endpoints commonly serve config bytes as octet-stream.
  const r = registry(f, call => call.kind === "blobs" ? responseFor(call.doc, call.digest, {
    headers: { "content-type": "application/octet-stream" }
  }) : undefined);
  assert.equal(await verifyProcessLocalValuesRuntimeImages({ snapshot: snapshotFor(f), fetchImpl: r.fetchImpl }), true);
});

test("ARM-only, missing platform, mismatching config and ambiguous AMD64 entries fail closed", async () => {
  for (const platform of [{ os: "linux", architecture: "arm64" }, undefined, { os: "linux" }]) {
    const f = fixture({ childDescriptor: { platform } });
    const r = await rejectsFixture(f, "registry_runtime_platform");
    assert.equal(r.calls.filter(call => call.kind === "blobs").length, 0);
  }
  for (const config of [{ os: "windows" }, { architecture: "arm64" }, { architecture: undefined }, { os: undefined }]) {
    await rejectsFixture(fixture({ config }), "registry_runtime_platform");
    await rejectsFixture(fixture({ indexed: false, config }), "registry_runtime_platform");
  }
  const base = fixture();
  await rejectsFixture(fixture({ entries: [1, 2].map(() => descriptor(base.manifestDoc, {
    platform: { os: "linux", architecture: "amd64" }
  })) }), "registry_runtime_platform");
});

test("unknown/unknown attestations or unknown media types never supply runtime evidence", async () => {
  const base = fixture();
  await rejectsFixture(fixture({ entries: [base.root.payload.manifests[0]] }), "registry_runtime_platform");
  const unknown = { ...base.root.payload.manifests[1], mediaType: "application/vnd.example.artifact.v1+json" };
  await rejectsFixture(fixture({ entries: [unknown] }), "registry_runtime_platform");
  const f = fixture({ entries: [unknown, base.root.payload.manifests[1]] });
  const r = registry(f);
  assert.equal(await verifyProcessLocalValuesRuntimeImages({ snapshot: snapshotFor(f), fetchImpl: r.fetchImpl }), true);
});

test("artifact-marked AMD64 descriptors never count as runtime even with valid child/config hashes and sizes", async () => {
  for (const docker of [false, true]) {
    for (const marker of [{ artifactType: "application/vnd.example.artifact.v1+json" },
      { annotations: { "vnd.docker.reference.type": "attestation-manifest" } }]) {
      const f = fixture({ docker, childDescriptor: marker });
      const rejected = await rejectsFixture(f, "registry_runtime_platform");
      assert.equal(rejected.calls.filter(call => call.kind === "blobs").length, 0);
      assert.ok(rejected.calls.filter(call => call.kind === "manifests")
        .every(call => call.digest === f.root.digest));
      // Marked sidecars may coexist with a genuine candidate, including when
      // they incorrectly claim AMD64 instead of the conventional unknown pair.
      const base = fixture({ docker });
      const sidecar = { ...base.root.payload.manifests[0], artifactType: "application/example" };
      const genuine = base.root.payload.manifests[1];
      const mixed = fixture({ docker, entries: [sidecar, { ...genuine, ...marker }, genuine] });
      const accepted = registry(mixed);
      assert.equal(await verifyProcessLocalValuesRuntimeImages({
        snapshot: snapshotFor(mixed), fetchImpl: accepted.fetchImpl
      }), true);
    }
  }
});

test("non-runtime artifacts, malformed schemas/config/layers and excessive recursion/tree size are rejected", async () => {
  for (const manifest of [{ artifactType: "application/example" }, { subject: {} }, { schemaVersion: 1 }, { layers: [{}] }]) {
    await rejectsFixture(fixture({ manifest }), manifest.layers ? "registry_runtime_descriptor" : "registry_runtime_manifest");
  }
  await rejectsFixture(fixture({ configDescriptor: { mediaType: "application/vnd.example.config" } }), "registry_runtime_descriptor");
  await rejectsFixture(fixture({ manifest: { layers: [{ mediaType: "application/example", digest: layerDigest, size: 1 }] } }),
    "registry_runtime_descriptor");
  for (const config of [{ artifactType: "application/example" }, { subject: {} }, { rootfs: {} },
    { rootfs: { type: "layers", diff_ids: [] } }]) {
    await rejectsFixture(fixture({ config }), "registry_runtime_config");
  }
  for (const index of [{ artifactType: "application/example" }, { subject: {} }, { schemaVersion: 1 }, { manifests: [] }]) {
    await rejectsFixture(fixture({ index }), "registry_runtime_index");
  }
  await rejectsFixture(fixture({ nesting: 3 }), "registry_runtime_index");
  const base = fixture();
  await rejectsFixture(fixture({ entries: Array.from({ length: 129 }, () => base.root.payload.manifests[0]) }),
    "registry_runtime_index");
  await rejectsFixture(fixture({ config: { extra: Array(4097).fill(1) } }), "registry_runtime_response");
  let deeplyNested = {};
  for (let level = 0; level < 34; level += 1) deeplyNested = { child: deeplyNested };
  await rejectsFixture(fixture({ config: { extra: deeplyNested } }), "registry_runtime_response");
});

test("fixed auth origins ignore WWW-Authenticate and redirects, never exposing GHCR credentials", async () => {
  const f = fixture();
  const r = registry(f, call => call.kind === "token" ? new Response("redirect", { status: 302, headers: {
    Location: "https://untrusted.invalid/secret-sink",
    "www-authenticate": 'Bearer realm="https://untrusted.invalid/token",service="untrusted"'
  } }) : undefined);
  await assert.rejects(verifyProcessLocalValuesRuntimeImages({ snapshot: snapshotFor(f, 1), fetchImpl: r.fetchImpl }),
    valueFree("registry_token_denied"));
  assert.ok(r.calls.every(call => ["https://ghcr.io", "https://auth.docker.io"].includes(call.url.origin)));
  await rejectsFixture(f, "registry_manifest_denied", call => call.kind === "manifests"
    ? new Response("redirect", { status: 302, headers: { Location: "https://untrusted.invalid/secret-sink" } }) : undefined);
  await rejectsFixture(f, "registry_token_request", () => { throw new Error("fixture-private-token redirect blocked"); });
});

test("one config 307 to the exact provider CDN passes without forwarding auth/cookies or renewing the signal", async () => {
  for (const [f, aliasRound] of [[fixture(), null], [fixture({ docker: true, indexed: false }), 1]]) {
    const r = redirectedRegistry(f, call => new Response(call.doc.bytes, {
      headers: { "content-type": "application/octet-stream" }
    }));
    assert.equal(await verifyProcessLocalValuesRuntimeImages({
      snapshot: snapshotFor(f, aliasRound), fetchImpl: r.fetchImpl
    }), true);
    const cdnCalls = r.calls.filter(call => call.kind === "cdn");
    assert.equal(cdnCalls.length, 13);
    for (const call of cdnCalls) {
      const configCall = r.calls.find(prior => prior.kind === "blobs" && prior.repository === call.repository);
      assert.equal(call.init.signal, configCall.init.signal);
      assert.equal(call.url.origin, configCall.url.origin === "https://ghcr.io"
        ? "https://pkg-containers.githubusercontent.com" : "https://production.cloudfront.docker.com");
      assert.deepEqual(call.init.headers, { Accept: f.configDoc.mediaType });
    }
    if (aliasRound !== null) assert.equal(cdnCalls.filter(call =>
      call.url.origin === "https://production.cloudfront.docker.com").length, 5);
  }
});

test("config redirects reject unsafe, cross-provider, internal, relative, oversized or credential-bearing locations", async () => {
  const f = fixture();
  for (const [repository, origin, crossProvider] of [
    ["yengalvez/bot-orchestrator", "https://pkg-containers.githubusercontent.com", "https://production.cloudfront.docker.com"],
    ["library/postgres", "https://production.cloudfront.docker.com", "https://pkg-containers.githubusercontent.com"]
  ]) {
    for (const location of [null, "", "/relative", `//${new URL(origin).host}/config`,
      "https://untrusted.invalid/config", "https://127.0.0.1/config", "https://169.254.169.254/config",
      "https://localhost/config", `${origin}.untrusted.invalid/config`, `${crossProvider}/config`,
      origin.replace("https:", "http:"), origin.replace("https://", "https://user:password@"),
      `${origin}:8443/config`, `${origin}/config#fragment`, `${origin}/config#`, `${origin}/back\\slash`,
      `${origin}/raw space`, `${origin}/control\ncharacter`, `${origin}/config?${"q".repeat(8192)}`]) {
      const r = registry(f, call => call.kind === "blobs" && call.repository === repository
        ? { status: 307, headers: { get: name => name === "location" ? location : null } } : undefined);
      await assert.rejects(verifyProcessLocalValuesRuntimeImages({
        snapshot: snapshotFor(f, 1), fetchImpl: r.fetchImpl
      }), valueFree("registry_config_redirect"));
      assert.equal(r.calls.filter(call => call.kind === "cdn").length, 0);
    }
  }
});

test("config redirects permit only one 307 hop and reject unexpected response URL/automatic redirects", async () => {
  const f = fixture();
  for (const status of [301, 302, 303, 308]) {
    await rejectsFixture(f, "registry_config_denied", call => call.kind === "blobs"
      ? new Response(null, { status, headers: { Location: configCdnUrl(call) } }) : undefined);
  }
  const chain = redirectedRegistry(f, call => new Response(null, { status: 307, headers: {
    Location: `${call.url.origin}/second-hop`
  } }));
  await assert.rejects(verifyProcessLocalValuesRuntimeImages({ snapshot: snapshotFor(f, 1), fetchImpl: chain.fetchImpl }),
    valueFree("registry_config_redirect"));
  assert.equal(chain.calls.filter(call => call.kind === "cdn").length, 13);
  for (const surprise of [{ redirected: true }, { url: "https://untrusted.invalid/config" }]) {
    const r = redirectedRegistry(f, call => {
      const response = responseFor(call.doc, call.digest);
      for (const [key, value] of Object.entries(surprise)) Object.defineProperty(response, key, { value });
      return response;
    });
    await assert.rejects(verifyProcessLocalValuesRuntimeImages({ snapshot: snapshotFor(f), fetchImpl: r.fetchImpl }),
      valueFree("registry_config_redirect"));
  }
});

test("token/manifest and legacy access requests still reject redirects and never contact a CDN", async () => {
  const f = fixture();
  for (const kind of ["token", "manifests"]) {
    const r = registry(f, call => call.kind === kind ? new Response(null, { status: 307, headers: {
      Location: "https://pkg-containers.githubusercontent.com/never-follow"
    } }) : undefined);
    await assert.rejects(verifyProcessLocalValuesRuntimeImages({ snapshot: snapshotFor(f), fetchImpl: r.fetchImpl }),
      valueFree(kind === "token" ? "registry_token_denied" : "registry_manifest_denied"));
    assert.equal(r.calls.filter(call => call.kind === "cdn").length, 0);
  }
  let legacyCalls = 0;
  await assert.rejects(verifyGhcrPullAccess({
    encoded: fakeEncoded,
    images: ["bot-orchestrator", "bot-runner"].map(repository => `ghcr.io/yengalvez/${repository}@${f.root.digest}`),
    fetchImpl: async (input, init) => {
      const url = new URL(input);
      legacyCalls += 1;
      assert.equal(url.origin, "https://ghcr.io");
      assert.equal(init.redirect, "error");
      return url.pathname === "/token" ? new Response(JSON.stringify({ token: "fixture-legacy-bearer" }))
        : new Response(null, { status: 307, headers: { Location: "https://pkg-containers.githubusercontent.com/never-follow" } });
    }
  }), valueFree("registry_manifest_denied"));
  assert.equal(legacyCalls, 4);
});

test("CDN config responses still enforce byte limits, raw digest, descriptor size and media type", async () => {
  const f = fixture();
  for (const [code, options] of [
    ["registry_config_digest", { bytes: Buffer.concat([f.configDoc.bytes, Buffer.from(" ")]) }],
    ["registry_config_digest", { headers: { "docker-content-digest": layerDigest } }],
    ["registry_runtime_response", { headers: { "content-length": String(2 * 1024 * 1024 + 1) } }],
    ["registry_runtime_media_type", { headers: { "content-type": "application/json" } }]
  ]) {
    const r = redirectedRegistry(f, call => responseFor(call.doc, call.digest, options));
    await assert.rejects(verifyProcessLocalValuesRuntimeImages({ snapshot: snapshotFor(f, 1), fetchImpl: r.fetchImpl }),
      valueFree(code));
  }
  const wrongSize = fixture({ configDescriptor: { size: f.configDoc.bytes.length + 1 } });
  const r = redirectedRegistry(wrongSize);
  await assert.rejects(verifyProcessLocalValuesRuntimeImages({ snapshot: snapshotFor(wrongSize, 1), fetchImpl: r.fetchImpl }),
    valueFree("registry_runtime_size"));
  let cancelled = 0;
  const oversized = redirectedRegistry(f, call => ({
    status: 200, headers: new Headers({ "content-type": OCI_CONFIG, "docker-content-digest": call.digest }),
    body: { getReader: () => ({
      read: async () => ({ done: false, value: new Uint8Array(2 * 1024 * 1024 + 1) }),
      cancel: () => { cancelled += 1; }, releaseLock() {}
    }) }
  }));
  await assert.rejects(verifyProcessLocalValuesRuntimeImages({ snapshot: snapshotFor(f, 1), fetchImpl: oversized.fetchImpl }),
    valueFree("registry_runtime_response"));
  assert.equal(cancelled, 13);
});

test("config handoff and CDN body reads share the original image deadline", async () => {
  const f = fixture();
  const keepAlive = setTimeout(() => {}, 400);
  try {
    const r = registry(f, async call => {
      if (call.kind === "blobs" || call.kind === "cdn") await new Promise(resolve => setTimeout(resolve, 35));
      return call.kind === "blobs" ? new Response(null, { status: 307, headers: { Location: configCdnUrl(call) } }) : undefined;
    });
    await assert.rejects(verifyProcessLocalValuesRuntimeImages({
      snapshot: snapshotFor(f, 1), fetchImpl: r.fetchImpl, requestTimeoutMs: 60
    }), valueFree("registry_config_request"));
    assert.ok(r.calls.some(call => call.kind === "cdn"));
    const stalled = redirectedRegistry(f, call => ({
      status: 200, headers: new Headers({ "content-type": OCI_CONFIG, "docker-content-digest": call.digest }),
      body: { getReader: () => ({ read: () => new Promise(() => {}), cancel() {}, releaseLock() {} }) }
    }));
    await assert.rejects(verifyProcessLocalValuesRuntimeImages({
      snapshot: snapshotFor(f, 1), fetchImpl: stalled.fetchImpl, requestTimeoutMs: 30
    }), valueFree("registry_runtime_response"));
  } finally { clearTimeout(keepAlive); }
});

test("token and raw body limits apply both to declared and streamed content; stalled bodies abort", async () => {
  const f = fixture();
  await rejectsFixture(f, "registry_token_response", call => call.kind === "token"
    ? new Response("{}", { headers: { "content-length": String(64 * 1024 + 1) } }) : undefined);
  await rejectsFixture(f, "registry_runtime_response", call => call.digest === f.root.digest
    ? responseFor(call.doc, call.digest, { headers: { "content-length": String(2 * 1024 * 1024 + 1) } }) : undefined);
  let cancelled = 0;
  await rejectsFixture(f, "registry_runtime_response", call => call.digest === f.root.digest ? {
    status: 200, headers: new Headers({ "content-type": OCI_INDEX, "docker-content-digest": call.digest }),
    body: { getReader: () => ({
      read: async () => ({ done: false, value: new Uint8Array(2 * 1024 * 1024 + 1) }),
      cancel: () => { cancelled += 1; }, releaseLock() {}
    }) }
  } : undefined);
  assert.equal(cancelled, 13);
  const keepAlive = setTimeout(() => {}, 200);
  try {
    const r = registry(f, call => call.digest === f.root.digest ? {
      status: 200, headers: new Headers({ "content-type": OCI_INDEX, "docker-content-digest": call.digest }),
      body: { getReader: () => ({ read: () => new Promise(() => {}), cancel() {}, releaseLock() {} }) }
    } : undefined);
    await assert.rejects(verifyProcessLocalValuesRuntimeImages({
      snapshot: snapshotFor(f), fetchImpl: r.fetchImpl, requestTimeoutMs: 10
    }), valueFree("registry_runtime_response"));
  } finally { clearTimeout(keepAlive); }
});

test("fetch abort is value-free, and the same total budget covers token plus all descendants", async () => {
  const f = fixture();
  const keepAlive = setTimeout(() => {}, 400);
  try {
    const receivedSignals = [];
    await assert.rejects(verifyProcessLocalValuesRuntimeImages({
      snapshot: snapshotFor(f), requestTimeoutMs: 5,
      fetchImpl: (_url, init) => { receivedSignals.push(init.signal); return new Promise(() => {}); }
    }), valueFree("registry_token_request"));
    assert.ok(receivedSignals.some(signal => signal.aborted));
    const r = registry(f, async () => {
      await new Promise(resolve => setTimeout(resolve, 25));
      return undefined;
    });
    await assert.rejects(verifyProcessLocalValuesRuntimeImages({
      snapshot: snapshotFor(f), fetchImpl: r.fetchImpl, requestTimeoutMs: 60
    }), valueFree("registry_manifest_request"));
    assert.ok(r.calls.some(call => call.digest === f.manifestDoc.digest));
    assert.equal(r.calls.filter(call => call.kind === "blobs").length, 0);
    for (const repository of new Set(r.calls.map(call => call.repository))) {
      assert.equal(new Set(r.calls.filter(call => call.repository === repository).map(call => call.init.signal)).size, 1);
    }
  } finally { clearTimeout(keepAlive); }
});

test("malformed untrusted body machinery is translated into a safe error", async () => {
  const f = fixture();
  await rejectsFixture(f, "registry_runtime_response", call => call.digest === f.root.digest ? {
    status: 200, headers: new Headers({ "content-type": OCI_INDEX, "docker-content-digest": call.digest }),
    body: { getReader() { throw new Error("fixture-private-token"); } }
  } : undefined);
});
