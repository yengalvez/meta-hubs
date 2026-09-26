import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { sha } from "../../deployment/rpm-catalog-safety.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const exec = promisify(execFile);

// Artificial SQL inventory mirrors the canonical validator's existing fixture
// contract. No database connection, credentials or original media are involved.
async function pair(mode) {
  await mkdir(path.join(root, "output"), { recursive: true });
  const dir = await mkdtemp(path.join(root, "output/rpm-checkpoint-test-"));
  const relations = [
    { schema: "coturn", name: "turnusers_lt", type: "BASE TABLE" },
    ...["schema_migrations", "hubs", "owned_files"].map(name => ({ schema: "ret0", name, type: "BASE TABLE" })),
    ...Array.from({ length: 351 }, (_, i) => ({ schema: "ret0", name: `table_${String(i + 1).padStart(3, "0")}`, type: "BASE TABLE" })),
    { schema: "ret0_admin", name: "admin_view", type: "VIEW" }
  ];
  const versions = Array.from({ length: 94 }, (_, i) => `2019000000${String(i + 1).padStart(4, "0")}`);
  const hubs = Array.from({ length: 17 }, (_, i) => `room-${String(i + 1).padStart(2, "0")}`);
  const sql = ["CREATE SCHEMA coturn;", "CREATE SCHEMA ret0;", "CREATE SCHEMA ret0_admin;",
    ...relations.map(r => r.type === "VIEW" ? `CREATE VIEW ${r.schema}.${r.name} AS\nSELECT 1;` : `CREATE TABLE ${r.schema}.${r.name} (\n);`),
    "COPY ret0.schema_migrations (version) FROM stdin;", ...versions, "\\.",
    "COPY ret0.hubs (hub_sid) FROM stdin;", ...hubs, "\\.",
    "COPY ret0.owned_files (owned_file_uuid, state) FROM stdin;", "active-one\tactive", "deferred-one\texpiring", "\\.",
    "-- PostgreSQL database dump complete", ""].join("\n");
  const contract = { schema_version: 2, sql_dump_sha256: sha(sql),
    provenance: { baseline: "yenhubs-reticulum-pre-sitting-2026-07", compatible_with: ["pre-sitting-2026-07", "sitting-candidate-2026-07"], minimum_relation_count: 356, minimum_migration_count: 94, minimum_hubs_count: 17 },
    schemas: ["coturn", "ret0", "ret0_admin"], relations, migration_versions: versions,
    critical_inventory: { hub_sids: hubs, owned_files: [{ uuid: "active-one", state: "active" }, { uuid: "deferred-one", state: "expiring" }], active_owned_file_uuids: ["active-one"] },
    critical_counts: { relations: 356, migrations: 94, hubs: 17, owned_files: 2, active_owned_files: 1 }
  };
  if (mode === "wrong-contract") contract.sql_dump_sha256 = "0".repeat(64);
  const tree = path.join(dir, "tree");
  for (const [uuid, dirs] of [["active-one", "ac/ti"], ["deferred-one", "de/fe"]]) {
    await mkdir(path.join(tree, "owned", dirs), { recursive: true });
    if (mode === "missing-active" && uuid === "active-one") continue;
    await writeFile(path.join(tree, "owned", dirs, uuid + ".blob"), "fixture");
    if (mode !== "partial-media" || uuid !== "active-one") await writeFile(path.join(tree, "owned", dirs, uuid + ".meta.json"), "{}");
  }
  const dump = path.join(dir, "retdb-20260926-090000.sql.gz"), storage = path.join(dir, "ret-storage-20260926-090000.tar.gz");
  await writeFile(dump, gzipSync(sql)); await writeFile(path.join(dir, "database-contract.json"), JSON.stringify(contract));
  await exec("tar", ["-czf", storage, "-C", tree, "owned"], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
  return { dir, dump, storage };
}

for (const mode of ["valid", "missing-active", "partial-media", "wrong-contract"]) {
  test(`canonical DB/media validation: ${mode}`, async () => {
    const f = await pair(mode);
    const run = exec("bash", [path.join(root, "deployment/validate-checkpoint.sh"), f.dump, f.storage], {
      env: { ...process.env, TMPDIR: f.dir }, maxBuffer: 1024 * 1024
    });
    if (mode === "valid") assert.match((await run).stdout, /Checkpoint content validation passed/);
    else await assert.rejects(run, error => /Checkpoint mismatch|critical Reticulum SQL contract/.test(error.stderr));
  });
}
