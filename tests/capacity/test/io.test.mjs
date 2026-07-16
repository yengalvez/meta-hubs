import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readJsonFile } from "../lib/io.mjs";

test("JSON input size is rejected from metadata before parsing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "yenhubs-capacity-io-"));
  const path = join(directory, "oversized.json");
  try {
    await writeFile(path, Buffer.alloc(2 * 1024 * 1024 + 1, 0x20));
    await assert.rejects(
      () => readJsonFile(path),
      error => error.code === "FILE_TOO_LARGE" && !JSON.stringify(error).includes(path)
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
