"use strict";

// Opt-in observational preload for ONE synthetic primary-run CLI case.
// No argv, stdin, output, paths, keys, API objects or environment values are
// recorded. The actual commands, return objects, errors and deadlines remain
// unchanged. Nested spawn durations are not additive elapsed phase durations.
const fs = require("node:fs");
const path = require("node:path");
const cp = require("node:child_process");
const { performance } = require("node:perf_hooks");
const { syncBuiltinESMExports } = require("node:module");

const log = process.env.YENHUBS_SPAWN_COST_LOG;
if (!log || !path.isAbsolute(log)) throw new Error("spawn_cost_private_log_required");
const ownPhase = ["plan-authority", "execute-authority"].includes(process.env.YENHUBS_SPAWN_COST_PHASE)
  ? process.env.YENHUBS_SPAWN_COST_PHASE : "harness";
const fd = fs.openSync(log, fs.constants.O_WRONLY | fs.constants.O_APPEND |
  fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
const stat = fs.fstatSync(fd);
if (!stat.isFile() || stat.uid !== process.getuid() || stat.nlink !== 1 ||
    (stat.mode & 0o777) !== 0o600) throw new Error("spawn_cost_private_log_invalid");
let attemptedRecords = 0, failedRecords = 0;
function writeMetric(record) {
  attemptedRecords++;
  try {
    const line = JSON.stringify(record) + "\n";
    if (fs.writeSync(fd, line) !== Buffer.byteLength(line)) failedRecords++;
  } catch (_) {
    // An observer failure invalidates its evidence, not the native command.
    // Never replace the command's result/error or emit payload diagnostics.
    failedRecords++;
  }
}
module.exports.metricStatus = () => ({ attemptedRecords, failedRecords });
process.on("exit", () => writeMetric({ pid: process.pid, phase: ownPhase,
  observer_terminal: true, attempted_records: attemptedRecords,
  failed_records: failedRecords }));

function executableKind(command) {
  const name = typeof command === "string" ? path.basename(command) : "";
  if (name === "kubectl") return "transport";
  if (/^python(?:3(?:\.\d+)?)?$/.test(name)) return "private-artifact-helper";
  if (/^(?:node|nodejs)$/.test(name)) return "node";
  if (name === "bash") return "bash";
  return "other";
}
const nativeSpawnSync = cp.spawnSync;
cp.spawnSync = function observedSpawn(command, args, options) {
  let phase = ownPhase;
  // The test's deliberately closed env excludes the parent's NODE_OPTIONS.
  // Propagate ONLY this observational preload into the selected real CLI;
  // never forward the parent's full environment or introduce an adapter.
  if (command === process.execPath && Array.isArray(args) &&
      args[0]?.endsWith("/apply/recover-avatar-checkpoint.js") &&
      ["plan-authority", "execute-authority"].includes(args[1])) {
    phase = args[1];
    if (!options?.env || options.env.NODE_OPTIONS !== undefined) {
      throw new Error("spawn_cost_cli_env_not_closed");
    }
    options = { ...options, env: { ...options.env,
      NODE_OPTIONS: `--require=${__filename}`,
      YENHUBS_SPAWN_COST_LOG: log,
      YENHUBS_SPAWN_COST_PHASE: phase } };
  }
  const started = performance.now();
  let result;
  try {
    result = nativeSpawnSync.call(this, command, args, options);
    return result;
  } finally {
    writeMetric({ pid: process.pid, phase,
      kind: executableKind(command), elapsed_ms: performance.now() - started,
      status: Number.isInteger(result?.status) ? result.status : null,
      timed_out: result?.error?.code === "ETIMEDOUT" });
  }
};
syncBuiltinESMExports();
