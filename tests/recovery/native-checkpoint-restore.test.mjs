import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { validateLocalDump, logicalDump, localPgEnvironment, verifyMedia, copyRows, verifyCopyRows } from "./native-checkpoint-restore.mjs";

function shellBindingFixture(t, version = "5.2") {
  const parent = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "yenhubs-native-bash-test-"));
  fs.chmodSync(parent, 0o700); t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const pgBin = path.join(parent, "pg-bin"), customBin = path.join(parent, "custom-bin");
  for (const directory of [pgBin, customBin]) fs.mkdirSync(directory, { mode: 0o700 });
  const trace = path.join(parent, "trace.jsonl"), executable = path.join(customBin, "bash");
  fs.writeFileSync(executable, `#!${process.execPath}\n` +
    `const fs = require("node:fs"); const args = process.argv.slice(2);\n` +
    `const probe = args.some(arg => arg.includes("BASH_VERSINFO"));\n` +
    `fs.appendFileSync(${JSON.stringify(trace)}, JSON.stringify({ phase: probe ? "version" : "source", executable: process.argv[1], inherited: Object.keys(process.env).filter(key => /^(?:PG|BASH_ENV$|ENV$|SHELLOPTS$)/.test(key)) }) + "\\n");\n` +
    `if (probe) { process.stdout.write(${JSON.stringify(version + "\n")}); } else { process.stderr.write("fixture_source_error\\n"); process.exitCode = 23; }\n`, { mode: 0o700 });
  for (const name of ["initdb", "pg_ctl", "psql", "pg_dump"]) fs.writeFileSync(path.join(pgBin, name),
    `#!${process.execPath}\nrequire("node:fs").appendFileSync(${JSON.stringify(trace)}, JSON.stringify({ phase: "pg", tool: ${JSON.stringify(name)} }) + "\\n"); process.exitCode = 97;\n`, { mode: 0o700 });
  const checkpoint = path.join(parent, "20261001-130000"); fs.mkdirSync(checkpoint, { mode: 0o700 });
  const files = {
    "database-contract.json": Buffer.from("{}"),
    "retdb-20261001-130000.sql.gz": zlib.gzipSync("-- incomplete dump\n"),
    "ret-storage-20261001-130000.tar.gz": Buffer.from("incomplete media")
  };
  for (let index = 0; index < 10; index++) files[`inventory-${index}.json`] = Buffer.from("{}");
  for (const [name, bytes] of Object.entries(files)) fs.writeFileSync(path.join(checkpoint, name), bytes, { mode: 0o600 });
  fs.writeFileSync(path.join(checkpoint, "SHA256SUMS"), Object.entries(files).map(([name, bytes]) =>
    `${crypto.createHash("sha256").update(bytes).digest("hex")}  ${name}\n`).join(""), { mode: 0o600 });
  const invoke = () => {
    const script = fileURLToPath(new URL("./native-checkpoint-restore.mjs", import.meta.url));
    const result = spawnSync(process.execPath, [script, "--checkpoint", checkpoint, "--pg-bin", pgBin], {
      env: { PATH: `${customBin}:/usr/bin:/bin`, PGSERVICE: "outside", PGPASSWORD: "fixture",
        BASH_ENV: "/fixture/startup", ENV: "/fixture/startup", SHELLOPTS: "xtrace" }, encoding: "utf8", timeout: 10000
    });
    const report = JSON.parse(result.stdout.trim().split("\n").at(-1));
    if (report.privateWork) t.after(() => fs.rmSync(report.privateWork, { recursive: true, force: true }));
    const calls = fs.existsSync(trace) ? fs.readFileSync(trace, "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];
    return { result, report, calls };
  };
  return { executable, invoke };
}

test("native preflight binds caller-selected custom-PATH Bash before sanitizing PATH", t => {
  const f = shellBindingFixture(t), { result, report, calls } = f.invoke();
  assert.equal(result.status, 1);
  assert.equal(report.failure, "source_preflight_command_failed");
  assert.equal(report.outcome, "FAIL");
  assert.equal(calls.filter(call => call.phase === "source").length, 1);
  assert.equal(calls.find(call => call.phase === "source").executable, f.executable);
  assert.equal(calls.filter(call => call.phase === "version").length, 2);
  for (const call of calls) assert.deepEqual(call.inherited, []);
  assert.equal(calls.some(call => call.phase === "pg"), false);
  assert.equal(Object.hasOwn(report.metrics, "private_source_snapshot"), false);
});

test("unsupported native Bash fails before source preflight or any PostgreSQL command", t => {
  const f = shellBindingFixture(t, "3.2"), { result, report, calls } = f.invoke();
  assert.equal(result.status, 1);
  assert.equal(report.failure, "native_bash_requires_4_1");
  assert.equal(report.outcome, "FAIL");
  assert.deepEqual(calls.map(call => call.phase), ["version"]);
  assert.deepEqual(calls[0].inherited, []);
  assert.equal(Object.hasOwn(report, "privateWork"), false);
  assert.equal(Object.hasOwn(report.metrics, "source_preflight"), false);
});

test("native DB canary never inherits a connection/service/password environment", () => {
  const env = localPgEnvironment("/explicit/tools", "/private/home", "/private/socket");
  assert.equal(env.PGHOST, "/private/socket");
  assert.equal(env.HOME, "/private/home");
  for (const name of ["PGSERVICE", "PGSERVICEFILE", "PGPASSFILE", "PGPASSWORD", "PGHOSTADDR", "PGDATA", "BASH_ENV", "ENV", "SHELLOPTS"]) assert.equal(Object.hasOwn(env, name), false);
});
test("checkpoint client commands cannot connect, read local files or start subprocesses", () => {
  for (const command of ["\\connect other", "\\! id", "\\i /outside", "\\copy t from '/outside'"]) {
    assert.throws(() => validateLocalDump(command), /unexpected_psql_command/);
  }
});
test("COPY data is not mistaken for psql commands and all rows survive comparison", () => {
  const sql = "-- Dumped by pg_dump version 14.1\n\\restrict abc\nCOPY ret0.fixture FROM stdin;\n\\N\n--actual-data\n\n\\.\n\\unrestrict abc";
  validateLocalDump(sql);
  assert.equal(logicalDump(sql), "COPY ret0.fixture FROM stdin;\n\\N\n--actual-data\n\n\\.");
  assert.notEqual(logicalDump(sql), logicalDump(sql.replace("--actual-data", "--changed")));
});
test("native restore rejects unfinished COPY, foreign execution and unknown owners", () => {
  for (const sql of ["COPY t FROM stdin;\n1", "COPY t FROM PROGRAM 'anything';", "CREATE SERVER outside;", "CREATE FOREIGN TABLE t();", "LANGUAGE plpython3u", "ALTER TABLE t OWNER TO outside;"]) assert.throws(() => validateLocalDump(sql));
});
test("logical DB equality excludes only pg_dump version headers and randomized restrict tokens", () => {
  assert.equal(logicalDump("-- Dumped by pg_dump version 14.1\n\\restrict abc\nCREATE TABLE t(a int);\n\\unrestrict abc\n"), logicalDump("-- Dumped by pg_dump version 14.2\n\\restrict xyz\nCREATE TABLE t(a int);\n\\unrestrict xyz\n"));
  assert.notEqual(logicalDump("CREATE TABLE t(a int);"), logicalDump("CREATE TABLE t(a text);"));
});
test("same-major logical comparison preserves function body comments and blank lines", () => {
  const sql = "CREATE FUNCTION f() RETURNS text AS $$\n--body text\n\nSELECT text;\n$$ LANGUAGE sql;";
  assert.notEqual(logicalDump(sql), logicalDump(sql.replace("--body text", "--changed body")));
  assert.notEqual(logicalDump(sql), logicalDump(sql.replace("\n\n", "\n")));
});
test("a pg_dump-looking header inside a function body is still data", () => {
  const sql = "CREATE FUNCTION f() RETURNS text AS $$\n-- Dumped by pg_dump version 14.1\nSELECT text;\n$$ LANGUAGE sql;";
  assert.notEqual(logicalDump(sql), logicalDump(sql.replace("14.1", "14.2")));
});
test("source COPY comparison allows heap order, not missing/changed/duplicate rows or tables", () => {
  const sql = "COPY t (a) FROM stdin;\none\ntwo\none\n\\.\nCOPY u (a) FROM stdin;\n\\.\n";
  const expected = copyRows(sql);
  verifyCopyRows(expected, copyRows(sql.replace("one\ntwo\none", "two\none\none")));
  for (const changed of [sql.replace("two", "changed"), sql.replace("one\ntwo\none", "one\ntwo"), sql.replace("COPY u (a) FROM stdin;\n\\.\n", "")]) assert.throws(() => verifyCopyRows(expected, copyRows(changed)));
  assert.throws(() => copyRows("COPY t (a) FROM stdin;\nunfinished"));
  assert.throws(() => copyRows(sql + sql), /duplicate_copy_header/);
});
test("media completeness includes every DB UUID, both file types and exact bytes", () => {
  const uuid = "abcdef00-1111-2222-3333-444455556666", base = `owned/ab/cd/${uuid}`;
  const expected = new Map([[base + ".blob", "blob-hash"], [base + ".meta.json", "metadata-hash"]]);
  verifyMedia(expected, [uuid]);
  const missing = new Map(expected); missing.delete(base + ".blob");
  assert.throws(() => verifyMedia(missing, [uuid], expected), /restored_media_inventory_mismatch/);
  const changed = new Map(expected); changed.set(base + ".meta.json", "changed");
  assert.throws(() => verifyMedia(changed, [uuid], expected), /restored_media_bytes_mismatch/);
  assert.throws(() => verifyMedia(expected, [uuid.replace("ab", "cd")], expected));
});
