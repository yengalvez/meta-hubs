import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, open, readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { invalid } from "./errors.mjs";

export const CAPACITY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export async function readJsonFile(path, label = "JSON file") {
  let metadata;
  try {
    metadata = await stat(path);
  } catch (error) {
    throw invalid(`${label} could not be inspected`, "FILE_READ_FAILED", { reason: error.code ?? "unknown" });
  }
  if (!metadata.isFile()) {
    throw invalid(`${label} must be a regular file`, "FILE_READ_FAILED");
  }
  if (metadata.size > 2 * 1024 * 1024) {
    throw invalid(`${label} exceeds the 2 MiB limit`, "FILE_TOO_LARGE");
  }

  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    throw invalid(`${label} could not be read`, "FILE_READ_FAILED", { reason: error.code ?? "unknown" });
  }
  if (Buffer.byteLength(text, "utf8") > 2 * 1024 * 1024) {
    throw invalid(`${label} exceeds the 2 MiB limit`, "FILE_TOO_LARGE");
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw invalid(`${label} is not strict JSON`, "JSON_PARSE_FAILED");
  }
}

export async function readNdjsonFile(
  path,
  label = "NDJSON file",
  { maximumBytes = 256 * 1024 * 1024, maximumLines = 500_000 } = {}
) {
  let metadata;
  try {
    metadata = await stat(path);
  } catch (error) {
    throw invalid(`${label} could not be inspected`, "FILE_READ_FAILED", { reason: error.code ?? "unknown" });
  }
  if (!metadata.isFile() || metadata.size === 0 || metadata.size > maximumBytes) {
    throw invalid(`${label} must be a non-empty bounded regular file`, "FILE_TOO_LARGE");
  }
  const handle = await open(path, "r");
  const tail = Buffer.alloc(1);
  try {
    await handle.read(tail, 0, 1, metadata.size - 1);
  } finally {
    await handle.close();
  }
  if (tail[0] !== 0x0a) throw invalid(`${label} must end with one NDJSON newline`, "NDJSON_PARSE_FAILED");
  const samples = [];
  const input = createReadStream(path, { encoding: "utf8", highWaterMark: 64 * 1024 });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (line.length === 0 || Buffer.byteLength(line, "utf8") > 128 * 1024 || samples.length >= maximumLines) {
        throw invalid(`${label} has an invalid line count or line size`, "NDJSON_PARSE_FAILED");
      }
      try {
        samples.push(JSON.parse(line));
      } catch {
        throw invalid(`${label} is not strict NDJSON`, "NDJSON_PARSE_FAILED");
      }
    }
  } finally {
    lines.close();
    input.destroy();
  }
  return samples;
}

export async function loadCatalogue() {
  // JSON is a strict YAML 1.2 subset. Keeping this file JSON-shaped avoids a
  // runtime parser dependency and rejects ambiguous YAML scalar coercions.
  return readJsonFile(resolve(CAPACITY_ROOT, "scenarios.yaml"), "scenario catalogue");
}

export async function loadThresholds() {
  return readJsonFile(resolve(CAPACITY_ROOT, "thresholds.json"), "threshold catalogue");
}

export async function loadCosts() {
  return readJsonFile(resolve(CAPACITY_ROOT, "costs.json"), "cost catalogue");
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function stableId(prefix, value) {
  // 128 bits keeps canonical ids compact while making collisions negligible
  // even at the 500,000-sample evidence envelope. The former 48-bit prefix
  // had a measurable birthday-collision probability at that cardinality.
  return `${prefix}-${createHash("sha256").update(canonicalJson(value)).digest("hex").slice(0, 32)}`;
}

export async function resolveContainedPath(parent, relativePath, label = "contained path") {
  if (typeof relativePath !== "string" || relativePath.length === 0 || relativePath.length > 256 ||
      relativePath.includes("\0") || isAbsolute(relativePath) ||
      relativePath.split(/[\\/]+/).some(segment => segment === "" || segment === "." || segment === "..")) {
    throw invalid(`${label} must be a strict relative path`, "PATH_CONTAINMENT_INVALID");
  }
  const root = resolve(parent);
  let current = root;
  for (const segment of relativePath.split(/[\\/]+/)) {
    current = resolve(current, segment);
    let metadata;
    try {
      metadata = await lstat(current);
    } catch (error) {
      throw invalid(`${label} could not be inspected`, "PATH_CONTAINMENT_INVALID", { reason: error.code ?? "unknown" });
    }
    if (metadata.isSymbolicLink()) throw invalid(`${label} cannot traverse a symbolic link`, "PATH_CONTAINMENT_INVALID");
  }
  const [rootReal, currentReal] = await Promise.all([realpath(root), realpath(current)]);
  const local = relative(rootReal, currentReal);
  if (local === "" || local === ".." || local.startsWith(`..${sep}`) || isAbsolute(local)) {
    throw invalid(`${label} escaped its containing directory`, "PATH_CONTAINMENT_INVALID");
  }
  return current;
}
