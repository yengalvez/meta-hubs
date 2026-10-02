// Owned synthetic runner only: real process, IPC, SIGTERM and exit. It cannot
// authenticate a ghost, contact a provider or prove Kubernetes Pod absence.
const assert = require("node:assert/strict");
assert.ok(process.send);
assert.equal(process.argv[2], "owned-stop-drain");
let signals = 0;
process.on("SIGTERM", () => {
  signals++;
  process.send({ type: "sigterm", pid: process.pid, signals });
  // Hold graceful exit until the parent has observed stopping/readiness503.
});
process.on("message", message => {
  assert.equal(message.type, "release-exit");
  assert.equal(signals, 1);
  process.exit(0);
});
process.on("disconnect", () => process.exit(1));
process.send({ type: "spawned", pid: process.pid });
