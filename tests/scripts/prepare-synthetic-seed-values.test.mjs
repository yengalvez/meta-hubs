import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { parseLocalValuesSource } from "../../deployment/parse-local-values.mjs";
import { prepareSyntheticSeedValues, publishGreenfieldValues } from "../../deployment/prepare-staging-values.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const preparer = path.join(root, "deployment/prepare-staging-values.mjs");
const ciPath = path.join(root, "hubs-cloud/community-edition/input-values.ci.yaml");
const configPath = path.join(root, "hubs-cloud/community-edition/services/reticulum/config/test.exs");
const ciBytes = fs.readFileSync(ciPath);
const configBytes = fs.readFileSync(configPath);
const ci = parseLocalValuesSource(ciBytes.toString());
const configSha = "1bda7179b048bbf80e4d95a8e228810a7578f96ffebdf1c7557a78ab1253e4b7";
const sqlSha = "fa47f64379c63ec6eba056dfaf93faea2b94eaf3465750568695b9e982ab8cdc";
const datasetSha = "0c20c58c231996f43fe30a19ee9b8fac67ba583d710cb0dfa4ea7183c3641443";
const scope = "native-PG14-existing-synthetic-seed-restore-not-kubernetes-production-browser-or-cycles";
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const sharedKeys = ["ADM_EMAIL", "SMTP_SERVER", "SMTP_PORT", "SMTP_USER", "SMTP_PASS"];
const secretKeys = ["DB_PASS", "NODE_COOKIE", "GUARDIAN_KEY", "PHX_KEY", "BOT_ACCESS_KEY", "BOT_RUNNER_ACCESS_KEY", "BOT_ORCHESTRATOR_ACCESS_KEY", "DASHBOARD_ACCESS_KEY"];
const imageFields = { reticulum: "RETICULUM", postgrest: "POSTGREST", postgres: "POSTGRES", pgbouncer: "PGBOUNCER", botOrchestrator: "BOT_ORCHESTRATOR", botRunner: "BOT_RUNNER", spoke: "SPOKE", nearspark: "NEARSPARK", photomnemonic: "PHOTOMNEMONIC", dialog: "DIALOG", coturn: "COTURN", haproxy: "HAPROXY" };
const images = { ...Object.fromEntries(Object.entries(imageFields).map(([name, value]) => [name, ci.get(`OVERRIDE_${value}_IMAGE`)])), hubsLegacy: ci.get("OVERRIDE_HUBS_IMAGE"), hubsCandidate: ci.get("OVERRIDE_HUBS_IMAGE") };
const modules = (bots, ai, avaturn) => ({ schema_version: 1, bots, ai, avaturn, avaturn_creator_url: avaturn ? "https://virtualmente.avaturn.dev" : "" });
const profiles = [modules(false, false, false), modules(false, false, true), modules(true, false, false), modules(true, false, true), modules(true, true, false), modules(true, true, true)];
const fixtureDomain = () => {
  const matches = [...configBytes.toString().matchAll(/secret_key_base: String\.duplicate\("([^"\\\n]+)", ([1-9][0-9]*)\)/gu)];
  assert.equal(matches.length, 1);
  return matches[0][1].repeat(Number(matches[0][2]));
};

function valuesYaml(values) {
  return [...values].flatMap(([key, value]) => key === "PRODUCT_MODULES" ? ["PRODUCT_MODULES:", ...Object.entries(value).map(([name, entry]) => `  ${name}: ${typeof entry === "string" ? JSON.stringify(entry) : entry}`)] : [`${key}: ${JSON.stringify(String(value))}`]).join("\n") + "\n";
}

function memoryFs() {
  let inode = 0n;
  const nodes = new Map(), descriptors = new Map();
  const error = code => Object.assign(new Error(code), { code });
  const node = filename => { if (!nodes.has(filename)) throw error("ENOENT"); return nodes.get(filename); };
  const add = (filename, bytes, mode = 0o600, kind = "file") => {
    if (!nodes.has(path.dirname(filename)) && filename !== "/") add(path.dirname(filename), undefined, 0o700, "directory");
    nodes.set(filename, { kind, bytes: bytes === undefined ? undefined : Buffer.from(bytes), mode: BigInt(mode), uid: BigInt(process.getuid()), dev: 1n, ino: ++inode, nlink: 1n, mtimeNs: 1n, ctimeNs: 1n });
  };
  add("/", undefined, 0o755, "directory");
  const stat = filename => {
    const value = node(filename);
    return { ...value, size: BigInt(value.bytes?.length ?? 0), isFile: () => value.kind === "file", isDirectory: () => value.kind === "directory", isSymbolicLink: () => value.kind === "symlink" };
  };
  const io = {
    nodes, add, lstatSync: stat, realpathSync: filename => filename,
    openSync(filename) { const descriptor = descriptors.size + 1; descriptors.set(descriptor, filename); return descriptor; },
    fstatSync: descriptor => stat(descriptors.get(descriptor)),
    closeSync: descriptor => descriptors.delete(descriptor),
    readFileSync: filename => Buffer.from(node(typeof filename === "number" ? descriptors.get(filename) : filename).bytes),
    readdirSync: filename => [...nodes.keys()].filter(child => child !== filename && path.dirname(child) === filename).map(child => path.basename(child))
  };
  return io;
}

function falseSeed(profile = profiles[0]) {
  // No real native seed/cache is read. The single hash seam recognizes only
  // this conspicuous false SQL marker; CLI has no way to select this seam.
  const base = path.join(root, "output/pure-synthetic-seed-values");
  const io = memoryFs();
  const templatePath = path.join(base, "template.yaml"), sharedPath = path.join(base, "shared.yaml"), bindingPath = path.join(base, "binding.json"), source = path.join(base, "source"), outputs = [path.join(base, "destination/bootstrap.yaml"), path.join(base, "destination/final.yaml")];
  const values = new Map(ci); values.set("PRODUCT_MODULES", profile);
  io.add(ciPath, ciBytes, 0o644); io.add(configPath, configBytes, 0o644);
  io.add(templatePath, valuesYaml(values), 0o644);
  io.add(sharedPath, valuesYaml(new Map(sharedKeys.map(key => [key, ci.get(key)]))));
  io.add(path.dirname(outputs[0]), undefined, 0o700, "directory");
  const binding = { schema: 1, scope, crypto_domain: "unchanged-tracked-MIX_ENV-test-RetWeb.Endpoint-secret_key_base", fixture_kind: "Reticulum-MIX_ENV-test-public-fixture", dataset_binding_sha256: datasetSha, source_identity: { ".": "d52e25f9bf4f787de6190f26a0260ce5deaf94f9", hubs: "2a3d7ab406466d6d69c6e0b8776df42fb7c1931e", "hubs-cloud": "cb15414037754a2dc4f08a1b375519bad7478958" }, sql_reference: { captured_on: "2026-10-04", capture_kind: "primary-source-only", sha256: sqlSha }, sequence: { name: "ret0.table_id_seq", last_value: "180", is_called: true, captured_on: "2026-10-04" }, tables: {}, files: [], entries: Array.from({ length: 33 }, () => ({})), graph: { scope: "native-synthetic-room-project-graph-not-current-metaverse" }, fixture_config_sha256: configSha, source_files: [], pair_binding_sha256: "" };
  const sql = Buffer.alloc(375445, 32); Buffer.from("FALSE UNIT-ONLY SQL; NEVER EXECUTE\n").copy(sql);
  const fakeHash = bytes => Buffer.isBuffer(bytes) && bytes.equals(sql) ? sqlSha : hash(bytes);
  const addSource = (relative, bytes, mode = 0o600) => {
    const content = Buffer.from(bytes);
    io.add(path.join(source, relative), content, mode);
    binding.source_files.push({ path: relative, sha256: fakeHash(content), bytes: content.length });
  };
  addSource("database/PG_VERSION", "14\n"); addSource("reticulum/config/test.exs", configBytes, 0o644);
  addSource("catalog-native.sql", sql); addSource("summary.json", "{}"); addSource("catalog-readback.json", "{}"); addSource("catalog-input/input.json", "{}");
  for (let index = 0; index < 103; index++) {
    const uuid = `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
    const blob = Buffer.from(`FALSE CIPHERTEXT ${index}`), meta = Buffer.from(`{"false":${index}}`);
    const prefix = `reticulum/storage/test/owned/00/00/${uuid}`;
    addSource(`${prefix}.blob`, blob); addSource(`${prefix}.meta.json`, meta);
    binding.files.push({ owned_file_uuid: uuid, blob_sha256: hash(blob), blob_bytes: blob.length, meta_sha256: hash(meta), meta_bytes: meta.length });
  }
  binding.source_files.sort((a, b) => a.path.localeCompare(b.path, "en"));
  const updateBinding = () => {
    binding.pair_binding_sha256 = hash(JSON.stringify(binding.source_files));
    io.add(bindingPath, `${JSON.stringify(binding, null, 2)}\n`);
  };
  updateBinding();
  const args = [templatePath, sharedPath, bindingPath, source, ...outputs, "synthetic-destination.invalid", JSON.stringify(images)];
  return { io, args, hash: fakeHash, binding, updateBinding, source, templatePath, sharedPath, bindingPath, outputs, values };
}

const prepare = fixture => prepareSyntheticSeedValues(fixture.args, { io: fixture.io, hash: fixture.hash, env: {} });
const parsed = bytes => parseLocalValuesSource(bytes.toString());
const clear = result => { result.bootstrapBytes.fill(0); result.finalBytes.fill(0); };

test("six closed schema-1 profiles preserve only the exact public fixture PHX domain", () => {
  assert.equal(hash(configBytes), configSha);
  let previous;
  for (const profile of profiles) {
    const fixture = falseSeed(profile), result = prepare(fixture);
    const bootstrap = parsed(result.bootstrapBytes), final = parsed(result.finalBytes);
    assert.equal(bootstrap.get("PHX_KEY") === fixtureDomain(), true, "PHX must match only the tracked public fixture");
    assert.equal(final.get("PHX_KEY") === bootstrap.get("PHX_KEY"), true);
    assert.deepEqual(bootstrap.get("PRODUCT_MODULES"), profile);
    assert.deepEqual(final.get("PRODUCT_MODULES"), profile);
    assert.equal(bootstrap.get("BOT_RUNNER_ACTIVATION_PHASE"), "bootstrap");
    assert.equal(final.get("BOT_RUNNER_ACTIVATION_PHASE"), "bootstrap");
    assert.equal(bootstrap.get("HUB_DOMAIN"), "synthetic-destination.invalid");
    for (const key of secretKeys.filter(key => key !== "PHX_KEY")) {
      assert.equal(bootstrap.get(key) !== ci.get(key), true, `${key} must be fresh, not inherited`);
      assert.equal(bootstrap.get(key) === final.get(key), true, `${key} must be shared by the two generations`);
      if (previous) assert.equal(bootstrap.get(key) !== previous.get(key), true, `${key} must be fresh across preparations`);
    }
    assert.equal(bootstrap.get("OPENAI_API_KEY") !== ci.get("OPENAI_API_KEY"), true);
    assert.match(bootstrap.get("OPENAI_API_KEY"), /^staging-disabled-/u);
    assert.equal(bootstrap.get("PERMS_KEY") === final.get("PERMS_KEY"), true);
    assert.equal(bootstrap.get("PERMS_KEY").startsWith("-----BEGIN PRIVATE KEY-----\\n"), true);
    if (previous) assert.equal(bootstrap.get("PERMS_KEY") !== previous.get("PERMS_KEY"), true);
    assert.equal(new Set(secretKeys.map(key => bootstrap.get(key))).size, secretKeys.length);
    const uri = `postgres://${encodeURIComponent(bootstrap.get("DB_USER"))}:${encodeURIComponent(bootstrap.get("DB_PASS"))}@pgbouncer/${encodeURIComponent(bootstrap.get("DB_NAME"))}`;
    assert.equal(bootstrap.get("PGRST_DB_URI") === uri && bootstrap.get("PSQL") === uri, true);
    previous = bootstrap;
    clear(result);
    const literal = falseSeed(profile);
    const block = valuesYaml(new Map([["PRODUCT_MODULES", profile]]));
    literal.io.add(literal.templatePath, ciBytes.toString().replace(/^PRODUCT_MODULES:\n(?:  [^\n]*\n)+/mu, block), 0o644);
    const literalResult = prepare(literal);
    assert.deepEqual(parsed(literalResult.finalBytes).get("PRODUCT_MODULES"), profile);
    assert.equal(parsed(literalResult.finalBytes).get("PHX_KEY") === fixtureDomain(), true);
    clear(literalResult);
  }
});

test("synthetic binding, authority, domain, profile and override negatives never produce prepared bytes", () => {
  const cases = [
    ["extra argument", f => f.args.push("--phx-key=FALSE")],
    ["missing argument", f => f.args.pop()],
    ["real domain", f => f.args[6] = "meta-hubs.org"],
    ["invalid domain alias", f => f.args[6] = "invalid"],
    ["active template delta", f => { f.values.set("HUB_DOMAIN", "meta-hubs.org"); f.io.add(f.templatePath, valuesYaml(f.values), 0o644); }],
    ["arbitrary template key", f => { f.values.set("PHX_KEY", "FALSE ARBITRARY KEY PAYLOAD"); f.io.add(f.templatePath, valuesYaml(f.values), 0o644); }],
    ["extra template key", f => { f.values.set("UNAPPROVED", "FALSE"); f.io.add(f.templatePath, valuesYaml(f.values), 0o644); }],
    ["hidden template comment payload", f => f.io.add(f.templatePath, `${valuesYaml(f.values)}# FALSE KEY PAYLOAD\n`, 0o644)],
    ["unapproved creator", f => { f.values.set("PRODUCT_MODULES", { ...profiles[1], avaturn_creator_url: "https://invented.avaturn.dev" }); f.io.add(f.templatePath, valuesYaml(f.values), 0o644); }],
    ["ai without bots", f => { f.values.set("PRODUCT_MODULES", { ...profiles[0], ai: true }); f.io.add(f.templatePath, valuesYaml(f.values), 0o644); }],
    ["other schema", f => { f.values.set("PRODUCT_MODULES", { ...profiles[0], schema_version: 2 }); f.io.add(f.templatePath, valuesYaml(f.values), 0o644); }],
    ["live shared", f => f.io.add(f.sharedPath, valuesYaml(new Map(sharedKeys.map(key => [key, key === "ADM_EMAIL" ? "owner@meta-hubs.org" : ci.get(key)]))))],
    ["arbitrary SMTP password", f => f.io.add(f.sharedPath, valuesYaml(new Map(sharedKeys.map(key => [key, key === "SMTP_PASS" ? "FALSE PASSWORD PAYLOAD" : ci.get(key)]))))],
    ["shared extra secret", f => f.io.add(f.sharedPath, valuesYaml(new Map([...sharedKeys.map(key => [key, ci.get(key)]), ["DB_PASS", "FALSE PRIVATE PAYLOAD"]])))],
    ["real image", f => f.args[7] = JSON.stringify({ ...images, reticulum: `ghcr.io/yengalvez/reticulum@sha256:${"1".repeat(64)}` })],
    ["extra image key", f => f.args[7] = JSON.stringify({ ...images, PHX_KEY: "FALSE" })],
    ["duplicate JSON key", f => f.args[7] = f.args[7].replace("{", '{"reticulum":"FALSE",')],
    ["binding scope", f => { f.binding.scope = "production"; f.updateBinding(); }],
    ["binding crypto", f => { f.binding.crypto_domain = "caller-key"; f.updateBinding(); }],
    ["binding fixture kind", f => { f.binding.fixture_kind = "production"; f.updateBinding(); }],
    ["binding config hash", f => { f.binding.fixture_config_sha256 = "f".repeat(64); f.updateBinding(); }],
    ["binding source identity", f => { f.binding.source_identity.hubs = "f".repeat(40); f.updateBinding(); }],
    ["binding dataset", f => { f.binding.dataset_binding_sha256 = "f".repeat(64); f.updateBinding(); }],
    ["binding SQL reference", f => { f.binding.sql_reference.sha256 = "f".repeat(64); f.updateBinding(); }],
    ["binding sequence", f => { f.binding.sequence.last_value = "181"; f.updateBinding(); }],
    ["binding graph", f => { f.binding.graph.scope = "current-metaverse"; f.updateBinding(); }],
    ["binding file count", f => { f.binding.files.pop(); f.updateBinding(); }],
    ["binding missing blob hash", f => { delete f.binding.files[0].blob_sha256; f.updateBinding(); }],
    ["binding media size mismatch", f => { f.binding.files[0].blob_bytes += 1; f.updateBinding(); }],
    ["binding listing count", f => { f.binding.entries.pop(); f.updateBinding(); }],
    ["binding secret payload", f => { f.binding.PHX_KEY = "FALSE KEY PAYLOAD"; f.updateBinding(); }],
    ["binding prototype payload", f => { f.io.add(f.bindingPath, f.io.readFileSync(f.bindingPath).toString().replace('{\n', '{\n  "__proto__": {},\n')); }],
    ["binding pair digest", f => { f.binding.pair_binding_sha256 = "f".repeat(64); f.io.add(f.bindingPath, JSON.stringify(f.binding)); }],
    ["binding source path escape", f => { f.binding.source_files[0].path = "../escape"; f.updateBinding(); }],
    ["binding missing media", f => { f.binding.source_files.pop(); f.updateBinding(); }],
    ["source running", f => f.io.add(path.join(f.source, "database/postmaster.pid"), "FALSE PID")],
    ["source SQL mismatch", f => f.io.add(path.join(f.source, "catalog-native.sql"), "FALSE CORRUPT SQL")],
    ["source fixture mismatch", f => f.io.add(path.join(f.source, "reticulum/config/test.exs"), "FALSE CONFIG", 0o644)],
    ["source media mismatch", f => { const row = f.binding.source_files.find(row => row.path.endsWith(".blob")); f.io.add(path.join(f.source, row.path), "FALSE CHANGED BLOB"); }],
    ["source extra media", f => f.io.add(path.join(f.source, "reticulum/storage/test/owned/unbound.blob"), "FALSE EXTRA")],
    ["public fixture altered", f => f.io.add(configPath, "FALSE PUBLIC CONFIG", 0o644)],
    ["public CI altered", f => f.io.add(ciPath, `${ciBytes.toString()}EXTRA: false\n`, 0o644)]
  ];
  for (const [label, mutate] of cases) {
    const fixture = falseSeed(); mutate(fixture);
    assert.throws(() => prepare(fixture), undefined, label);
    for (const output of fixture.outputs) assert.equal(fixture.io.nodes.has(output), false, `${label}: no output`);
  }
  for (const key of ["PHX_KEY", "SECRET_KEY_BASE", "RET_SECRET_KEY_BASE", "SYNTHETIC_SEED_PHX_KEY"]) {
    const fixture = falseSeed();
    assert.throws(() => prepareSyntheticSeedValues(fixture.args, { io: fixture.io, hash: fixture.hash, env: { [key]: "FALSE ENV KEY PAYLOAD" } }));
  }
});

test("owner-private, no-alias, symlink, hardlink and no-clobber inputs fail before publication", () => {
  const cases = [
    ["shared public permissions", f => f.io.nodes.get(f.sharedPath).mode = 0o644n],
    ["binding public permissions", f => f.io.nodes.get(f.bindingPath).mode = 0o644n],
    ["binding wrong owner", f => f.io.nodes.get(f.bindingPath).uid += 1n],
    ["source public directory", f => f.io.nodes.get(f.source).mode = 0o755n],
    ["source writable parent", f => f.io.nodes.get(path.join(f.source, "reticulum/storage")).mode = 0o777n],
    ["destination public parent", f => f.io.nodes.get(path.dirname(f.outputs[0])).mode = 0o755n],
    ["binding symlink", f => f.io.nodes.get(f.bindingPath).kind = "symlink"],
    ["shared symlink parent", f => f.io.nodes.get(path.dirname(f.sharedPath)).kind = "symlink"],
    ["media symlink", f => { const row = f.binding.source_files.find(row => row.path.endsWith(".blob")); f.io.nodes.get(path.join(f.source, row.path)).kind = "symlink"; }],
    ["binding hardlink", f => f.io.nodes.get(f.bindingPath).nlink = 2n],
    ["source media hardlink", f => { const row = f.binding.source_files.find(row => row.path.endsWith(".blob")); f.io.nodes.get(path.join(f.source, row.path)).nlink = 2n; }],
    ["source lexical alias", f => f.args[3] += "/../source"],
    ["output lexical alias", f => f.args[4] = path.dirname(f.outputs[0]) + "/../destination/bootstrap.yaml"],
    ["output input alias", f => f.args[4] = f.bindingPath],
    ["outputs alias", f => f.args[4] = f.args[5]],
    ["input aliases", f => f.args[1] = f.args[0]],
    ["output inside seed", f => f.args[4] = path.join(f.source, "prepared.yaml")],
    ["bootstrap exists", f => f.io.add(f.outputs[0], "FALSE RETAINED BYTES")],
    ["final exists", f => f.io.add(f.outputs[1], "FALSE RETAINED BYTES")],
    ["source read changed", f => { const original = f.io.fstatSync; let reads = 0; f.io.fstatSync = descriptor => { const stat = original(descriptor); return ++reads === 2 ? { ...stat, mtimeNs: 2n } : stat; }; }]
  ];
  for (const [label, mutate] of cases) {
    const fixture = falseSeed(); mutate(fixture);
    const before = fixture.outputs.map(output => fixture.io.nodes.has(output) ? fixture.io.readFileSync(output) : undefined);
    assert.throws(() => prepare(fixture), undefined, label);
    fixture.outputs.forEach((output, index) => {
      assert.equal(fixture.io.nodes.has(output), before[index] !== undefined, `${label}: no new output`);
      if (before[index]) assert.equal(fixture.io.readFileSync(output).equals(before[index]), true, `${label}: retained bytes`);
    });
  }
});

test("bounded second-publication I/O failure retains the first no-clobber artifact, wipes buffers and throws", () => {
  const fixture = falseSeed(), result = prepare(fixture), published = new Map();
  let calls = 0;
  assert.throws(() => publishGreenfieldValues(result, ...fixture.outputs, ({ outputPath, bytes }) => {
    if (++calls === 2) throw new Error("FALSE IO FAILURE");
    assert.equal(published.has(outputPath), false);
    published.set(outputPath, Buffer.from(bytes));
  }), /FALSE IO FAILURE/u);
  assert.equal(published.size, 1);
  assert.equal(published.has(fixture.outputs[1]), true);
  assert.equal(published.has(fixture.outputs[0]), false);
  assert.equal([...result.bootstrapBytes, ...result.finalBytes].every(value => value === 0), true);
  published.get(fixture.outputs[1]).fill(0);
});

function diskDirectory() {
  const output = path.join(root, "output"); fs.mkdirSync(output, { recursive: true });
  return fs.mkdtempSync(path.join(output, "pure-synthetic-values-"));
}
const run = (args, options = {}) => spawnSync(process.execPath, [preparer, ...args], { cwd: root, encoding: "utf8", ...options });

test("normal mode remains fresh-random and bootstrap→admission→active preserves synthetic PHX/modules", () => {
  const directory = diskDirectory(), fixture = falseSeed(profiles[5]), result = prepare(fixture);
  const templatePath = path.join(directory, "normal-template.yaml"), sharedPath = path.join(directory, "shared.yaml");
  const normalValues = new Map(ci); normalValues.set("PERMS_KEY", "FALSE PUBLIC PLACEHOLDER");
  fs.writeFileSync(templatePath, valuesYaml(normalValues), { mode: 0o600 });
  fs.writeFileSync(sharedPath, valuesYaml(new Map(sharedKeys.map(key => [key, ci.get(key)]))), { mode: 0o600 });
  let previous;
  for (let index = 0; index < 2; index++) {
    const bootstrap = path.join(directory, `normal-${index}-bootstrap.yaml`), final = path.join(directory, `normal-${index}-final.yaml`);
    const normal = run([templatePath, sharedPath, bootstrap, final, "normal-destination.invalid", JSON.stringify(images)]);
    assert.equal(normal.status, 0, "normal preparation must pass");
    assert.equal(normal.stderr, ""); assert.equal(normal.stdout, "staging_values_prepared\n");
    const values = parseLocalValuesSource(fs.readFileSync(final, "utf8"));
    assert.equal(values.get("PHX_KEY") !== fixtureDomain(), true);
    assert.equal(values.get("PHX_KEY") !== ci.get("PHX_KEY"), true);
    if (previous) assert.equal(values.get("PHX_KEY") !== previous.get("PHX_KEY"), true);
    previous = values;
  }
  const bootstrap = path.join(directory, "synthetic-bootstrap.yaml"), final = path.join(directory, "synthetic-final.yaml"), admission = path.join(directory, "admission.yaml"), active = path.join(directory, "active.yaml");
  publishGreenfieldValues(result, bootstrap, final);
  assert.equal(fs.statSync(bootstrap).mode & 0o777, 0o600); assert.equal(fs.statSync(final).mode & 0o777, 0o600);
  const admit = run(["--transition-activation-phase", final, admission, "bootstrap", "admission"]);
  const activate = run(["--transition-activation-phase", admission, active, "admission", "active"]);
  assert.equal(admit.status, 0, "admission preparation must pass"); assert.equal(activate.status, 0, "active preparation must pass");
  for (const [filename, phase] of [[bootstrap, "bootstrap"], [final, "bootstrap"], [admission, "admission"], [active, "active"]]) {
    const values = parseLocalValuesSource(fs.readFileSync(filename, "utf8"));
    assert.equal(values.get("PHX_KEY") === fixtureDomain(), true);
    assert.deepEqual(values.get("PRODUCT_MODULES"), profiles[5]);
    assert.equal(values.get("BOT_RUNNER_ACTIVATION_PHASE"), phase);
  }
  for (const [from, to, input] of [["bootstrap", "active", final], ["admission", "bootstrap", admission], ["active", "admission", active], ["bootstrap", "admission", active]]) {
    const rejected = path.join(directory, `reject-${from}-${to}-${path.basename(input)}`);
    const transition = run(["--transition-activation-phase", input, rejected, from, to]);
    assert.notEqual(transition.status, 0); assert.equal(transition.stdout, ""); assert.equal(fs.existsSync(rejected), false);
    assert.equal(transition.stderr.includes(fixtureDomain()), false);
  }
  const extraPath = path.join(directory, "extra-phase.yaml");
  const extra = run(["--transition-activation-phase", final, extraPath, "bootstrap", "admission", "--key=FALSE"]);
  assert.notEqual(extra.status, 0); assert.equal(fs.existsSync(extraPath), false);
});

test("real CLI has exact arguments, no injectable hash/key and sanitized no-output failures", () => {
  const directory = diskDirectory(), fixture = falseSeed();
  const args = fixture.args.map((value, index) => index < 6 ? path.join(directory, path.basename(value)) : value);
  fs.writeFileSync(args[0], ciBytes, { mode: 0o600 });
  fs.writeFileSync(args[1], valuesYaml(new Map(sharedKeys.map(key => [key, ci.get(key)]))), { mode: 0o600 });
  fs.writeFileSync(args[2], JSON.stringify({ ...fixture.binding, PHX_KEY: "FALSE KEY PAYLOAD NEVER PRINT" }), { mode: 0o600 });
  fs.mkdirSync(args[3], { mode: 0o700 });
  const attempts = [
    { args }, { args: [...args, "--hash=FALSE"] }, { args: args.slice(0, 7) },
    { args: [...args.slice(0, 6), "meta-hubs.org", args[7]] },
    { args, env: { ...process.env, PHX_KEY: "FALSE ENV PAYLOAD NEVER PRINT" } },
    { args: [...args.slice(0, 7), JSON.stringify({ ...images, PHX_KEY: "FALSE JSON PAYLOAD NEVER PRINT" })] }
  ];
  for (const attempt of attempts) {
    const outcome = run(["--prepare-synthetic-seed-values", ...attempt.args], attempt.env ? { env: attempt.env } : {});
    assert.equal(outcome.status, 1); assert.equal(outcome.stdout, "");
    assert.equal(outcome.stderr, "staging values preparation failed closed\n");
    assert.equal(outcome.stderr.includes("PAYLOAD"), false);
    assert.equal(fs.existsSync(args[4]), false); assert.equal(fs.existsSync(args[5]), false);
  }
});
