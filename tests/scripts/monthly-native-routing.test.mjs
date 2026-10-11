import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const lib = readFileSync(new URL("../../deployment/lib/recovery-safety.sh", import.meta.url), "utf8");
const driver = readFileSync(new URL("../../deployment/create-checkpoint.sh", import.meta.url), "utf8");
const child = readFileSync(new URL("../../deployment/backup-retdb.sh", import.meta.url), "utf8");
const args = ' -- --monthly-native-pair /source /journal 2026-10 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa /contract';
const hash = "a".repeat(64);
const guards = ' --guard-process 11 identity /failure /progress 10' +
  ` --guard-process-capability checkpoint-writer-monitor 12 identity /failure /ready /progress /authority ${hash} 10` +
  ` --guard-process-capability durable-runner-quiescence-monitor 13 identity /failure /ready /progress /authority ${hash} 10`;
function run(command) {
  const result = spawnSync("bash", ["-uc", `source deployment/lib/recovery-safety.sh; EXPECTED_KUBE_CONTEXT=fixture; ${command}`],
    { cwd: root, encoding: "utf8", timeout: 5000 });
  assert.ifError(result.error); return result;
}

test("native command cannot enter the gate without Lease and all three distinct guard kinds", () => {
  for (const command of [`recovery_kubectl_stream_supervised 1 30${args}`,
    `recovery_kubectl_stream_supervised 0 30${guards}${args}`,
    `recovery_kubectl_stream_supervised 1 30 --guard-process 11 identity /f /p 10${args}`,
    `recovery_kubectl_stream_supervised 1 30${guards}${args.replace(" /contract", " relative")}`]) {
    const result = run(command); assert.equal(result.status, 2, result.stderr); assert.equal(result.stdout, "");
    assert.match(result.stderr, /recovery_stream_detail:monthly-native-authority/);
  }
});

test("valid native selection reaches ordinary guard validation, never a separate unsupervised launcher", () => {
  const result = run(`recovery_stream_poll_seconds(){ printf '.1\\n'; }; recovery_stream_guard_process_is_healthy(){ return 1; }; recovery_kubectl_stream_supervised 1 30${guards}${args}`);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /recovery_stream_stage:guard-baseline/);
  assert.doesNotMatch(result.stderr, /monthly-native-authority/);
});

test("the fixed worker stays behind the same Python session gate and original deadlines", () => {
  assert.match(lib, /supervised_command=\(env YENHUBS_MONTHLY_GUARDED_COMMAND=1 node/);
  assert.match(lib, /os\.execvp\(sys\.argv\[3\], sys\.argv\[3:\]\)\n'[^]*"\$\{supervised_command\[@\]\}" <&0 &/);
  assert.match(child, /recovery_kubectl_stream_guarded 3600[^]*"\$\{DUMP_STREAM_GUARD_ARGS\[@\]\}" -- --monthly-native-pair/);
  assert.match(child, /stop_db_source_monitor "\$source_monitor_stop_mode"/);
  assert.match(child, /recovery_database_contracts_match "\$CONTRACT_BEFORE" "\$CONTRACT_AFTER"/);
});

test("native pair success and failure both return without falling through to pg_dump", () => {
  const begin = child.indexOf("run_dump_stream() {\n");
  const end = child.indexOf('\nif [[ "$BACKUP_MODE" == native-monthly ]]; then\n  if run_dump_stream', begin);
  assert.ok(begin > 0 && end > begin);
  const nativeFunction = child.slice(begin, end);
  for (const status of [0, 23]) {
    const result = run(`BACKUP_MODE=native-monthly; RECOVERY_OPERATION_ID=${"a".repeat(32)};
      PGSQL_POD_UID=fixture-pod; CHECKPOINT_RUNNER_GENERATION=durable-v2; NAMESPACE=fixture;
      RECOVERY_NAMESPACE_UID=fixture-namespace; RECOVERY_PVC_UID=fixture-pvc;
      MONTHLY_NATIVE_SOURCE_PATH=/source; MONTHLY_NATIVE_JOURNAL_PATH=/journal;
      MONTHLY_NATIVE_MONTH=2026-10; CONTRACT_BEFORE=/contract; DUMP_STREAM_GUARD_ARGS=();
      recovery_kubectl_stream_guarded(){ printf '%s\\n' "$*"; return ${status}; };
      ${nativeFunction}
      run_dump_stream`);
    assert.equal(result.status, status, result.stderr);
    assert.equal(result.stdout.trim(), `3600 -- --monthly-native-pair /source /journal 2026-10 ${"a".repeat(32)} /contract`);
    assert.doesNotMatch(result.stdout + result.stderr, /pg_dump|gzip/);
  }
});

test("native backend selects its pair artifact and keeps the media stream exclusively legacy", () => {
  assert.match(driver, /if \[\[ "\$CHECKPOINT_BACKEND" == native-monthly \]\]; then\n\s+database_backup_mode=native-monthly\n\s+database_backup_path="\$OUTPUT_DIR\/native-pair\.json"\nfi/);
  const storageBranch = driver.match(/if \[\[ "\$CHECKPOINT_BACKEND" == legacy \]\]; then\nCHECKPOINT_RUNNER_GENERATION=[^]*?\nfi\ncheckpoint_set_failure_context storage-backup serialization/);
  assert.ok(storageBranch);
  assert.match(storageBranch[0], /"\$SCRIPT_DIR\/backup-ret-storage-quiesced\.sh"/);
  assert.doesNotMatch(storageBranch[0], /\n(?:else|elif)\b/);
  assert.equal(driver.match(/"\$SCRIPT_DIR\/backup-ret-storage-quiesced\.sh"/g)?.length, 1);
});

test("native backend preserves abort recovery, parent terminal joins, resume and last-marker publication", () => {
  const positions = ["persist_checkpoint_abort_receipt\n", "quiesce_writers\n", '"$SCRIPT_DIR/backup-retdb.sh"',
    "stop_checkpoint_durable_monitor_before_writer_monitor\n", "stop_checkpoint_writer_monitor_before_resume\n",
    "resume_writers\n", "commit_final_output_directory\n", "release_lock_if_safe\n", "release_serialization_if_owned\n"];
  let offset = driver.indexOf("# Bind the local authorization input once.");
  for (const text of positions) { const next = driver.indexOf(text, offset); assert.ok(next > offset, text); offset = next; }
  assert.match(driver, /if \[\[ "\$CHECKPOINT_BACKEND" == legacy \]\]; then\nCHECKPOINT_RUNNER_GENERATION=/);
  assert.match(driver, /MONTHLY_NATIVE_JOURNAL_PATH=.*RECOVERY_OPERATION_ID/);
  assert.match(driver, /export and isolated recovery NOT yet accepted/);
});
