import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCatalog } from "../../deployment/sync-rpm-catalog.mjs";
import { splitGlb } from "../../deployment/import-local-avatars.mjs";
import { sha, bindCheckpoint, validateTarget, validateCatalogCheckpoint, mutation, checkpointBindingForJournal, hasMutationIntent } from "../../deployment/rpm-catalog-safety.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const target = { schema_version: 1, base: "https://catalog.invalid", kube_context: "fixture", namespace: "hcce", namespace_uid: "ns-1", ret_pvc_uid: "pvc-1" };
const now = Date.parse("2026-09-26T10:00:00Z");
const metadata = { ...target, created_at_utc: "2026-09-26T09:00:00Z", writer_quiescence: { completed_at_utc: "2026-09-26T09:05:00Z" } };
const binding = overrides => bindCheckpoint({ metadata, target, manifestHash: "manifest", checkpointHash: "checkpoint", now, ...overrides });

test("backup target is independent, closed-schema, origin-bound; pre-state survives same-journal resume", () => {
  const receipt = binding();
  assert.deepEqual(binding({ previous: receipt, now: now + 72 * 3600000 }), receipt);
  for (const changed of [ { ...target, base: "https://other.invalid" }, { ...target, extra: true }, { ...target, namespace_uid: "" } ]) {
    assert.throws(() => validateTarget(changed, target.base));
  }
  assert.throws(() => binding({ metadata: { ...metadata, namespace_uid: "foreign" } }), /another destination/);
  assert.throws(() => binding({ metadata: { ...metadata, ret_pvc_uid: "foreign" } }), /another destination/);
  assert.throws(() => binding({ now: now + 25 * 3600000 }), /stale/);
  assert.throws(() => binding({ now: now - 2 * 3600000 }), /future/);
  assert.throws(() => binding({ metadata: { ...metadata, writer_quiescence: { completed_at_utc: "2026-09-26T10:01:00Z" } } }), /pre-mutation/);
  assert.throws(() => binding({ previous: receipt, checkpointHash: "new backup" }), /binding changed/);
  assert.throws(() => binding({ previous: receipt, manifestHash: "new catalogue" }), /binding changed/);
  assert.throws(() => binding({ maxAgeHours: 25 }), /at most 24/);
});

test("freeze bundle destination checks include stable instance and cluster IDs", () => {
  const freeze = { schema: "freeze-bundle-v1", client_instance_id: "client-001", created_at_utc: metadata.created_at_utc,
    source: { kube_context: target.kube_context, namespace: { name: target.namespace, uid: target.namespace_uid }, pvc: { uid: target.ret_pvc_uid }, cluster: { uid: "cluster-1" } },
    operation: { quiescence: { completed_at_utc: metadata.writer_quiescence.completed_at_utc } } };
  const destination = { ...target, client_instance_id: "client-001", cluster_uid: "cluster-1" };
  binding({ metadata: freeze, target: destination });
  assert.throws(() => binding({ metadata: freeze, target: { ...destination, client_instance_id: "client-002" } }), /another destination/);
});

test("write-ahead intent recovers response loss and post-response journal failure without a second send", async () => {
  for (const loss of ["response", "journal"]) {
    let persisted = {}, remote = null, sends = 0, saves = 0;
    let item = {};
    const intent = { id: "exact", hash: "hash" };
    const invoke = () => mutation({ item, key: "create", intent,
      save: async () => { saves++; if (loss === "journal" && saves === 2) throw new Error("disk interrupted"); persisted = structuredClone(item); },
      send: async body => { sends++; remote = structuredClone(body); if (loss === "response") throw new Error("response lost"); },
      inspect: async body => assert.deepEqual(remote, body) || remote });
    await assert.rejects(invoke());
    item = structuredClone(persisted);
    assert.deepEqual(await invoke(), intent);
    assert.equal(sends, 1);
  }
});

async function privateFixture() {
  await mkdir(path.join(root, "output"), { recursive: true });
  return mkdtemp(path.join(root, "output/rpm-catalog-test-"));
}

test("canonical offline adapter rejects incomplete/partial checkpoint before any remote operation", async () => {
  const dir = await privateFixture();
  await writeFile(path.join(dir, "checkpoint-metadata.json"), JSON.stringify({ stamp: "20260926-090000", ...metadata }));
  await writeFile(path.join(dir, "SHA256SUMS"), "0".repeat(64) + "  missing.sql.gz\n");
  await writeFile(path.join(dir, ".yenhubs-incomplete"), "fixture");
  await assert.rejects(validateCatalogCheckpoint({ checkpoint: dir, scriptDir: path.join(root, "deployment"), target, base: target.base, manifestHash: "manifest" }));
});

function glb(index) {
  let json = JSON.stringify({ asset: { version: "2.0" }, buffers: [{ byteLength: 4 }], extras: { fixture: index } });
  json += " ".repeat((4 - Buffer.byteLength(json) % 4) % 4);
  const bin = Buffer.alloc(4); bin.writeUInt32LE(index);
  const bytes = Buffer.alloc(12 + 8 + Buffer.byteLength(json) + 8 + bin.length);
  bytes.writeUInt32LE(0x46546c67); bytes.writeUInt32LE(2, 4); bytes.writeUInt32LE(bytes.length, 8);
  bytes.writeUInt32LE(Buffer.byteLength(json), 12); bytes.writeUInt32LE(0x4e4f534a, 16); bytes.write(json, 20);
  const offset = 20 + Buffer.byteLength(json); bytes.writeUInt32LE(4, offset); bytes.writeUInt32LE(0x004e4942, offset + 4); bin.copy(bytes, offset + 8);
  return bytes;
}

// This fixed catalogue uses Spanish/ASCII names. Ret.AvatarSlug always builds
// from avatar_sid + name, via Slugger.slugify_downcase, on POST and PUT.
const avatarSlug = (sid, name) => `${sid}-${name}`.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

async function fixture() {
  const dir = await privateFixture();
  const manifest = JSON.parse(await readFile(path.join(root, "features/avatar-creator/rpm-catalog.json"), "utf8"));
  const assets = new Map(), receipts = [], avatars = [], listings = [], owned = new Map(), files = new Map();
  let sequence = 1000, writes = [], fail = null, race = null, capable = true;
  const revision = () => new Date(Date.now() + ++sequence).toISOString();
  function addFile(bytes) {
    const id = String(++sequence), uuid = `file-${id}`;
    files.set(uuid, bytes); owned.set(id, { id, owned_file_uuid: uuid }); return id;
  }
  for (const [i, e] of manifest.entries.entries()) {
    const bytes = glb(i + 1), thumbnail = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.from(String(i))]);
    const file = path.join(dir, e.stem + ".glb"), image = path.join(dir, e.stem + ".png");
    await writeFile(file, bytes); await writeFile(image, thumbnail);
    receipts.push({ file, thumbnail: image, sha256: sha(bytes) });
    const a = { ...splitGlb(bytes), thumbnail }; assets.set(e.stem, a);
    if (e.existing_listing) {
      const avatar = { id: String(++sequence), avatar_sid: `avatar-${i}`, name: `Old ${i}`, description: "Old", updated_at: revision(), state: "active", allow_promotion: true,
        account_id: "account-1", slug: `slug-${i}`, attributions: {}, parent_avatar_listing_id: null, reviewed_at: null,
        gltf_owned_file_id: addFile(a.gltf), bin_owned_file_id: addFile(a.binary), thumbnail_owned_file_id: addFile(Buffer.from("old image")),
        base_map_owned_file_id: null, emissive_map_owned_file_id: null, normal_map_owned_file_id: null, orm_map_owned_file_id: null };
      avatars.push(avatar);
      const { avatar_sid: unused, id: unusedId, ...listing } = avatar;
      listings.push({ ...listing, id: String(++sequence), avatar_id: avatar.id, avatar_listing_sid: e.existing_listing, tags: { tags: ["original"] }, order: 0 });
    }
  }
  const manifestPath = path.join(dir, "manifest.json"), receiptsPath = path.join(dir, "receipts.json"), targetPath = path.join(dir, "target.json");
  await writeFile(manifestPath, JSON.stringify(manifest)); await writeFile(receiptsPath, JSON.stringify(receipts)); await writeFile(targetPath, JSON.stringify(target));
  const json = value => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
  const findAvatar = sid => avatars.find(a => a.avatar_sid === sid) || avatars.find(a => a.id === listings.find(l => l.avatar_listing_sid === sid)?.avatar_id);
  const transport = async (url, options = {}) => {
    const u = new URL(url), route = u.pathname, method = options.method || "GET";
    if (race && race(route, method, avatars, listings)) race = null;
    if (method !== "GET") writes.push({ route, method });
    const body = typeof options.body === "string" ? JSON.parse(options.body) : options.body;
    let result;
    if (route === "/api-internal/v1/make_auth_token_for_email") result = json("fixture-token");
    else if (route === "/api/v1/media") {
      const blob = body.get("media"), id = addFile(Buffer.from(await blob.arrayBuffer())), file = owned.get(id);
      result = json({ file_id: file.owned_file_uuid, meta: { access_token: "fixture", promotion_token: "fixture" } });
    } else if (route.startsWith("/files/")) result = new Response(files.get(route.split("/").at(-1)));
    else if (route.startsWith("/api/postgrest/")) {
      const table = route.split("/").at(-1), data = table === "avatars" ? avatars : table === "avatar_listings" ? listings : [...owned.values()];
      const found = data.filter(row => [...u.searchParams].every(([key, value]) => value === "is.null" ? row[key] === null : !value.startsWith("eq.") ||
        (typeof row[key] === "object" ? JSON.stringify(row[key]) : String(row[key])) === value.slice(3)));
      if (method === "PATCH") { for (const row of found) Object.assign(row, body); }
      else if (method === "POST") { const row = { id: String(++sequence), ...body }; data.push(row); result = json(row); }
      result ||= json(found);
    } else if (route === "/api/v1/avatars" || /^\/api\/v1\/avatars\/[^/]+$/.test(route)) {
      let avatar = findAvatar(route.split("/").at(-1));
      if (method === "POST") {
        avatar = { id: String(++sequence), avatar_sid: `new-${sequence}`, state: "active", account_id: "account-1", slug: "new", attributions: {}, parent_avatar_listing_id: null,
          base_map_owned_file_id: null, emissive_map_owned_file_id: null, normal_map_owned_file_id: null, orm_map_owned_file_id: null, reviewed_at: null };
        avatars.push(avatar);
      }
      if (method === "PUT" && (body.avatar.expected_updated_at !== avatar.updated_at ||
          Object.entries(body.avatar.expected_fields).some(([k, v]) => avatar[k] !== v))) return new Response("", { status: 412 });
      if (method !== "GET") {
        for (const key of ["name", "description", "allow_promotion"]) if (key in body.avatar) avatar[key] = body.avatar[key];
        for (const [key, value] of Object.entries(body.avatar.files)) avatar[`${key}_owned_file_id`] = [...owned.values()].find(f => f.owned_file_uuid === value[0]).id;
        avatar.slug = avatarSlug(avatar.avatar_sid, avatar.name);
        avatar.updated_at = revision();
      }
      result = json({ capabilities: { conditional_update: capable, conditional_update_fields: capable }, avatars: [{ avatar_id: avatar.avatar_sid,
        files: Object.fromEntries(["gltf", "bin", "thumbnail"].map(key => [key, `${target.base}/files/${owned.get(avatar[`${key}_owned_file_id`]).owned_file_uuid}`])) }] });
    } else if (route.endsWith("/avatar.gltf")) {
      const avatar = findAvatar(route.split("/").at(-2));
      result = json({ buffers: [{ uri: `${target.base}/files/${owned.get(avatar.bin_owned_file_id).owned_file_uuid}` }] });
    } else throw new Error(`Unexpected fixture route ${method} ${route}`);
    if (fail && fail(route, method)) { fail = null; throw new Error("Simulated lost response"); }
    return result;
  };
  const args = ["--values", "unused", "--journal-dir", path.join(dir, "journal"), "--admin-origin", "http://127.0.0.1:9999", "--apply", "--checkpoint", "fixture", "--target-identity", targetPath,
    "--base", target.base, "--manifest", manifestPath, "--receipts", receiptsPath];
  let clock = now;
  let gate = options => binding({ previous: options.previous, now: clock });
  return { dir, manifest, avatars, listings, writes,
    lose: fn => { fail = fn; }, race: fn => { race = fn; }, gate: fn => { gate = fn; }, capabilities: value => { capable = value; }, clock: value => { clock = value; },
    run: stems => runCatalog([...args, "--only", stems.join(",")], { fetch: transport, readValues: () => new Map(), pause: async () => {}, validateCheckpoint: options => gate(options) }) };
}

test("backup rejection yields zero authentication, upload or API writes", async () => {
  const f = await fixture();
  f.gate(() => { throw new Error("foreign/stale/partial checkpoint"); });
  await assert.rejects(f.run(["Bata"]), /checkpoint/); assert.equal(f.writes.length, 0);
});

test("happy path keeps seven original IDs and publishes exactly 26 new identities", async () => {
  const f = await fixture(), originals = f.avatars.map(a => ({ id: a.id, gltf: a.gltf_owned_file_id, bin: a.bin_owned_file_id }));
  await f.run(f.manifest.entries.map(e => e.stem));
  assert.equal(f.avatars.length, 33); assert.equal(f.listings.length, 33);
  for (const original of originals) {
    const current = f.avatars.find(a => a.id === original.id);
    assert.equal(current.gltf_owned_file_id, original.gltf); assert.equal(current.bin_owned_file_id, original.bin);
  }
  assert.equal(f.writes.filter(w => w.route === "/api/v1/avatars" && w.method === "POST").length, 26);
});

for (const [label, stem, predicate] of [
  ["PUT avatar", "Bata", (route, method) => method === "PUT"],
  ["POST avatar", "Camiseta2", (route, method) => route === "/api/v1/avatars" && method === "POST"],
  ["POST listing", "Camiseta2", (route, method) => route === "/api/postgrest/avatar_listings" && method === "POST"],
  ["PATCH listing", "Bata", (route, method) => route === "/api/postgrest/avatar_listings" && method === "PATCH"],
  ["PATCH promotion", "Camiseta2", (route, method) => route === "/api/postgrest/avatars" && method === "PATCH"]
]) test(`lost ${label} response resumes by exact readback without duplicate write`, async () => {
  const f = await fixture(); f.lose(predicate);
  await assert.rejects(f.run([stem]), /lost response/);
  await f.run([stem]);
  assert.equal(f.writes.filter(w => predicate(w.route, w.method)).length, 1);
});

test("uncertain create with a mismatched model/identity is not adopted or reposted", async () => {
  const f = await fixture(); f.lose((route, method) => route === "/api/v1/avatars" && method === "POST");
  await assert.rejects(f.run(["Camiseta2"]));
  f.avatars.at(-1).thumbnail_owned_file_id = f.avatars[0].thumbnail_owned_file_id;
  await assert.rejects(f.run(["Camiseta2"]), /file identity mismatch/);
  assert.equal(f.writes.filter(w => w.route === "/api/v1/avatars" && w.method === "POST").length, 1);
});

test("concurrent avatar update cannot be overwritten between read and conditional PUT", async () => {
  const f = await fixture();
  f.race((route, method, avatars) => { if (method !== "PUT") return false; avatars[0].name = "Someone else's edit"; avatars[0].updated_at = "2026-09-27T00:00:00Z"; return true; });
  await assert.rejects(f.run(["Bata"]), /412/);
  assert.equal(f.avatars[0].name, "Someone else's edit");
  await assert.rejects(f.run(["Bata"]), /Uncertain avatar/);
  assert.equal(f.writes.filter(w => w.method === "PUT").length, 1);
});

test("lost upload response fails closed without upload retry", async () => {
  const f = await fixture(); f.lose(route => route === "/api/v1/media");
  await assert.rejects(f.run(["Bata"]), /lost response/);
  await assert.rejects(f.run(["Bata"]), /Uncertain upload/);
  assert.equal(f.writes.filter(w => w.route === "/api/v1/media").length, 1);
});

test("unversioned concurrent metadata edit is protected by expected_fields", async () => {
  const f = await fixture();
  f.race((route, method, avatars) => { if (method !== "PUT") return false; avatars[0].name = "Unversioned external edit"; return true; });
  await assert.rejects(f.run(["Bata"]), /412/);
  assert.equal(f.avatars[0].name, "Unversioned external edit");
});

test("old backend capability fails before uploading or updating", async () => {
  const f = await fixture(); f.capabilities(false);
  await assert.rejects(f.run(["Bata"]), /capability required/);
  assert.deepEqual(f.writes.map(w => w.route), ["/api-internal/v1/make_auth_token_for_email"]);
});

test("conditional listing PATCH protects concurrent edits even without a new timestamp", async () => {
  const f = await fixture();
  f.race((route, method, avatars, listings) => {
    if (route !== "/api/postgrest/avatar_listings" || method !== "PATCH") return false;
    listings[0].description = "Concurrent listing edit"; return true;
  });
  await assert.rejects(f.run(["Bata"]), /Concurrent modification/);
  assert.equal(f.listings[0].description, "Concurrent listing edit");
  await assert.rejects(f.run(["Bata"]), /Concurrent modification/);
  assert.equal(f.writes.filter(w => w.route === "/api/postgrest/avatar_listings" && w.method === "PATCH").length, 1);
});

test("realistic generated slugs survive multiple renames and a lost PUT response", async () => {
  const f = await fixture(); f.lose((route, method) => method === "PUT");
  await assert.rejects(f.run(["Bata", "Bata2"]), /lost response/);
  assert.equal(f.avatars[0].slug, "avatar-0-bata-blanca-gafas");
  await f.run(["Bata", "Bata2"]);
  assert.equal(f.avatars[1].slug, "avatar-1-bata-blanca-pelo-rubio");
  assert.equal(f.writes.filter(w => w.method === "PUT").length, 2);
});

test("slug exception is not a wildcard: wrong generated slug fails reconciliation", async () => {
  const f = await fixture(); f.lose((route, method) => method === "PUT");
  await assert.rejects(f.run(["Bata"]), /lost response/);
  f.avatars[0].slug = "concurrent-wrong-slug";
  await assert.rejects(f.run(["Bata"]), /slug readback mismatch/);
  assert.equal(f.writes.filter(w => w.method === "PUT").length, 1);
});

test("slug remains part of the full saved snapshot on later resume", async () => {
  const f = await fixture(); f.lose((route, method) => route === "/api/postgrest/avatar_listings" && method === "PATCH");
  await assert.rejects(f.run(["Bata"]), /lost response/);
  f.avatars[0].slug = "later-external-change";
  await assert.rejects(f.run(["Bata"]), /Concurrent modification/);
});

test("preflight-only receipt cannot authorize first upload after 72 hours", async () => {
  const f = await fixture(); f.capabilities(false);
  await assert.rejects(f.run(["Bata"]), /capability required/);
  const file = path.join(f.dir, "journal/journal.json");
  const journal = JSON.parse(await readFile(file, "utf8"));
  assert.equal(journal.checkpointReceipt, undefined);
  journal.checkpointReceipt = binding(); // Simulate old pre-intent crash window.
  assert.equal(checkpointBindingForJournal(journal), undefined);
  await writeFile(file, JSON.stringify(journal));
  f.capabilities(true); f.clock(now + 72 * 3600000);
  const before = f.writes.length;
  await assert.rejects(f.run(["Bata"]), /stale/);
  assert.equal(f.writes.length, before);
});

test("checkpoint age is checked again at first durable intent, not just preflight", async () => {
  const f = await fixture(); let calls = 0;
  f.gate(options => binding({ previous: options.previous, now: ++calls === 1 ? now : now + 72 * 3600000 }));
  await assert.rejects(f.run(["Bata"]), /stale/);
  assert.equal(calls, 2);
  assert.equal(f.writes.filter(w => w.route === "/api/v1/media").length, 0);
  const journal = JSON.parse(await readFile(path.join(f.dir, "journal/journal.json"), "utf8"));
  assert.equal(hasMutationIntent(journal), false); assert.equal(journal.checkpointReceipt, undefined);
});

test("receipt and first intent persist together and preserve valid prestate after 72 hours", async () => {
  const f = await fixture(); f.lose((route, method) => method === "PUT");
  await assert.rejects(f.run(["Bata"]), /lost response/);
  const journal = JSON.parse(await readFile(path.join(f.dir, "journal/journal.json"), "utf8"));
  assert.equal(hasMutationIntent(journal), true); assert.ok(checkpointBindingForJournal(journal));
  f.clock(now + 72 * 3600000);
  await f.run(["Bata"]);
  assert.equal(f.writes.filter(w => w.method === "PUT").length, 1);
  const damaged = { ...journal, checkpointReceipt: undefined };
  assert.throws(() => checkpointBindingForJournal(damaged), /no durable checkpoint binding/);
});
