import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
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

export async function loadCatalogue() {
  // JSON is a strict YAML 1.2 subset. Keeping this file JSON-shaped avoids a
  // runtime parser dependency and rejects ambiguous YAML scalar coercions.
  return readJsonFile(resolve(CAPACITY_ROOT, "scenarios.yaml"), "scenario catalogue");
}

export async function loadThresholds() {
  return readJsonFile(resolve(CAPACITY_ROOT, "thresholds.json"), "threshold catalogue");
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
  return `${prefix}-${createHash("sha256").update(canonicalJson(value)).digest("hex").slice(0, 12)}`;
}
