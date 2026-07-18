import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { invalid } from "./errors.mjs";
import { CAPACITY_ROOT, canonicalJson } from "./io.mjs";

const TRACKED_ROOT_FILES = new Set([
  "costs.json",
  "package-lock.json",
  "package.json",
  "physical-readiness.json",
  "scenarios.yaml",
  "thresholds.json",
  "trust-anchors.json"
]);

async function productionPaths() {
  const paths = [...TRACKED_ROOT_FILES];
  for (const directory of ["bin", "lib"]) {
    for (const entry of await readdir(resolve(CAPACITY_ROOT, directory), { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".mjs")) paths.push(`${directory}/${entry.name}`);
    }
  }
  return paths.sort();
}

export async function computeTrackedTreeIdentity() {
  const files = [];
  for (const path of await productionPaths()) {
    const absolute = resolve(CAPACITY_ROOT, path);
    const metadata = await lstat(absolute);
    if (!metadata.isFile() || metadata.isSymbolicLink() || relative(CAPACITY_ROOT, absolute).startsWith("..")) {
      throw invalid("Tracked harness tree contains an unsafe entry", "HARNESS_TREE_INVALID", { path });
    }
    const bytes = await readFile(absolute);
    files.push({
      path,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex")
    });
  }
  const core = { schemaVersion: 1, algorithm: "sha256-tree-v1", files };
  return {
    ...core,
    sha256: createHash("sha256").update(canonicalJson(core)).digest("hex")
  };
}
