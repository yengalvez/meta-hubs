import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readJsonFile, readNdjsonFile, resolveContainedPath } from "../lib/io.mjs";

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

test("raw NDJSON reader is bounded, line-oriented and requires a terminal newline", async () => {
  const directory = await mkdtemp(join(tmpdir(), "yenhubs-capacity-ndjson-"));
  try {
    const valid = join(directory, "raw.ndjson");
    await writeFile(valid, '{"id":1}\n{"id":2}\n');
    assert.deepEqual(await readNdjsonFile(valid), [{ id: 1 }, { id: 2 }]);

    const truncated = join(directory, "truncated.ndjson");
    await writeFile(truncated, '{"id":1}');
    await assert.rejects(() => readNdjsonFile(truncated), error => error.code === "NDJSON_PARSE_FAILED");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("contained paths reject traversal, absolute paths and every in-root ancestor symlink", async () => {
  const root = await mkdtemp(join(tmpdir(), "yenhubs-capacity-contained-"));
  try {
    const directory = join(root, "shards", "host-001");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "manifest.json"), "{}\n");
    assert.equal(
      await resolveContainedPath(root, "shards/host-001/manifest.json"),
      join(directory, "manifest.json")
    );
    await assert.rejects(
      () => resolveContainedPath(root, "../manifest.json"),
      error => error.code === "PATH_CONTAINMENT_INVALID"
    );
    await assert.rejects(
      () => resolveContainedPath(root, join(root, "shards/host-001/manifest.json")),
      error => error.code === "PATH_CONTAINMENT_INVALID"
    );
    await symlink(join(root, "shards"), join(root, "linked-shards"), "dir");
    await assert.rejects(
      () => resolveContainedPath(root, "linked-shards/host-001/manifest.json"),
      error => error.code === "PATH_CONTAINMENT_INVALID"
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
