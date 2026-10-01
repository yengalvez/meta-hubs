import assert from "node:assert/strict";
import test from "node:test";
import { validateLocalDump, logicalDump, localPgEnvironment, verifyMedia, copyRows, verifyCopyRows } from "./native-checkpoint-restore.mjs";

test("native DB canary never inherits a connection/service/password environment", () => {
  const env = localPgEnvironment("/explicit/tools", "/private/home", "/private/socket");
  assert.equal(env.PGHOST, "/private/socket");
  assert.equal(env.HOME, "/private/home");
  for (const name of ["PGSERVICE", "PGSERVICEFILE", "PGPASSFILE", "PGPASSWORD", "PGHOSTADDR", "PGDATA"]) assert.equal(Object.hasOwn(env, name), false);
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
