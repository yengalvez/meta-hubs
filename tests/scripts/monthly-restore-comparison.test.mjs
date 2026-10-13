import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyMonthlyRestoreComparisons,requireLocalRestoreMajor,canonicalMonthlyDataDump} from '../recovery/monthly-portable-restore.mjs';
const schema="CREATE TABLE proof (id integer, state varchar(12), CHECK ((state)::text = ANY (ARRAY[('a'::varchar)::text, ('b'::varchar)::text])));\n";
const data="COPY proof (id, state) FROM stdin;\n1\ta\n2\tb\n\\.\nSELECT pg_catalog.setval('proof_seq', 2, true);\n";
const input=()=>({sourceData:data,restoredData:data,referenceSchema:schema,restoredSchema:schema});
test('all DDL canonicalized by the native target engine; row order only may differ',()=>{
  const v=input();v.restoredData=data.replace('1\ta\n2\tb','2\tb\n1\ta');
  assert.match(verifyMonthlyRestoreComparisons(v).schemaSha256,/^[a-f0-9]{64}$/);
});
for(const [name,change]of [
  ['row value',v=>v.restoredData=data.replace('1\ta','1\tb')],
  ['row duplicate',v=>v.restoredData=data.replace('2\tb','1\ta')],
  ['sequence state',v=>v.restoredData=data.replace("2, true","1, true")],
  ['constraint',v=>v.restoredSchema=schema.replace("'a'","'c'")],
  ['function or grant',v=>v.restoredSchema=schema+'GRANT SELECT ON proof TO ret_admin;\n'],
  ['NULL value',v=>v.restoredData=data.replace('1\ta','1\t\\N')]
])test(`reject changed ${name}`,()=>{const v=input();change(v);assert.throws(()=>verifyMonthlyRestoreComparisons(v),/monthly_local_restore_(?:data_dump_changed|schema_changed)/);});
test('the restore engine keeps its exact same-major gate',()=>{
  assert.doesNotThrow(()=>requireLocalRestoreMajor('pg_ctl (PostgreSQL) 12.22','12'));
  assert.throws(()=>requireLocalRestoreMajor('pg_ctl (PostgreSQL) 14.20','12'),/major_mismatch/);
});
const section=(table,row)=>`--\n-- Data for Name: ${table}; Type: TABLE DATA; Schema: public; Owner: postgres\n--\n\nCOPY public.${table} (id) FROM stdin;\n${row}\n\\.\n\n`;
const ending='--\n-- PostgreSQL database dump complete\n--\n';
test('same tables and rows compare identically across native TOC section order',()=>{
  const a='SET row_security = off;\n'+section('a',1)+section('b',2)+ending;
  const b='SET row_security = off;\n'+section('b',2)+section('a',1)+ending;
  assert.equal(canonicalMonthlyDataDump(a),canonicalMonthlyDataDump(b));
  assert.notEqual(canonicalMonthlyDataDump(a),canonicalMonthlyDataDump(b.replace('SET row_security = off','SET row_security = on')));
});
test('a duplicate data section is rejected instead of collapsed',()=>{
  assert.throws(()=>canonicalMonthlyDataDump(section('a',1)+section('a',1)+ending),/duplicate_data_section/);
});
