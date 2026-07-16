import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { CAPACITY_ROOT } from "../lib/io.mjs";

const execFileAsync = promisify(execFile);
const cli = resolve(CAPACITY_ROOT, "bin/capacity.mjs");

test("CLI rejects every physical execution request before invoking external tools", async () => {
  await assert.rejects(
    () => execFileAsync(process.execPath, [
      cli,
      "run",
      "--scenario",
      "local-smoke",
      "--target",
      "http://localhost:4000/test-room",
      "--bots",
      "0",
      "--execute",
      "--ack-staging",
      "anything",
      "--driver",
      "/tmp/anything"
    ], { env: { PATH: process.env.PATH ?? "" } }),
    error => {
      const result = JSON.parse(error.stdout);
      return error.code === 2 && result.error.code === "PHYSICAL_EXECUTION_DISABLED";
    }
  );
});
