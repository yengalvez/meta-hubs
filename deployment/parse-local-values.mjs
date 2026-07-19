#!/usr/bin/env node

// Strict parser for the intentionally small top-level scalar subset used by
// deployment/input-values.local.yaml. It never evaluates YAML tags, anchors
// or nested structures. The sole block exception is the exact historical
// `PERMS_KEY: |` layout, normalized to escaped newlines. Diagnostics never
// include values.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const LEGACY_PERMS_BLOCK_HEADER = "PERMS_KEY: |";
const MAX_LEGACY_PERMS_BLOCK_LINES = 128;
const MAX_LEGACY_PERMS_LINE_LENGTH = 256;

export class LocalValuesParseError extends Error {
  constructor(lineNumber, reason) {
    super("invalid_local_values_yaml");
    this.name = "LocalValuesParseError";
    this.lineNumber = lineNumber;
    this.reason = reason;
  }
}

function fail(lineNumber, reason) {
  throw new LocalValuesParseError(lineNumber, reason);
}

function parseQuoted(raw, quote, lineNumber) {
  let value = "";
  let index = 1;
  for (; index < raw.length; index += 1) {
    const character = raw[index];
    if (quote === "'" && character === "'" && raw[index + 1] === "'") {
      value += "'";
      index += 1;
      continue;
    }
    if (character === quote) break;
    if (quote === '"' && character === "\\") {
      const start = index;
      index += 1;
      if (index >= raw.length) fail(lineNumber, "unterminated escape");
      const escaped = raw[index];
      const escapes = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
      if (Object.hasOwn(escapes, escaped)) {
        value += escapes[escaped];
        continue;
      }
      if (escaped === "u") {
        const code = raw.slice(index + 1, index + 5);
        if (!/^[0-9a-fA-F]{4}$/.test(code)) fail(lineNumber, "invalid unicode escape");
        value += String.fromCharCode(Number.parseInt(code, 16));
        index += 4;
        continue;
      }
      fail(lineNumber, `unsupported escape at column ${start + 1}`);
    }
    if (character === "\r" || character === "\n") fail(lineNumber, "multiline scalar");
    value += character;
  }
  if (index >= raw.length || raw[index] !== quote) fail(lineNumber, "unterminated quoted scalar");
  const remainder = raw.slice(index + 1);
  if (remainder !== "" && !/^[ \t]+(?:#.*)?$/.test(remainder)) {
    fail(lineNumber, "unexpected text after quoted scalar");
  }
  return value;
}

function parsePlain(raw, lineNumber) {
  let value = raw;
  if (value.startsWith("#")) return "";
  const comment = value.search(/[ \t]#/);
  if (comment >= 0) value = value.slice(0, comment);
  value = value.trim();
  if (value === "") return "";
  if (/^(?:[&*!|>{}\[\]`,]|---|\.\.\.)/.test(value)) {
    fail(lineNumber, "unsupported YAML construct");
  }
  if (/^(?:null|Null|NULL|~)$/.test(value)) fail(lineNumber, "null scalar is not allowed");
  if (/[:][ \t]/.test(value)) fail(lineNumber, "ambiguous plain scalar");
  return value;
}

function splitSourceLines(source) {
  const lines = [];
  let offset = 0;
  while (offset < source.length) {
    const newline = source.indexOf("\n", offset);
    const end = newline === -1 ? source.length : newline + 1;
    const raw = source.slice(offset, end);
    const ending = raw.endsWith("\r\n") ? "\r\n" : raw.endsWith("\n") ? "\n" : "";
    lines.push({
      body: ending ? raw.slice(0, -ending.length) : raw,
      ending
    });
    offset = end;
  }
  return lines;
}

export function parseLegacyPermsBlockLines(lines, headerIndex) {
  if (!Array.isArray(lines) || !Number.isInteger(headerIndex) || headerIndex < 0 ||
      lines[headerIndex]?.body !== LEGACY_PERMS_BLOCK_HEADER) {
    fail(headerIndex + 1, "legacy PERMS_KEY literal block header is invalid");
  }
  const content = [];
  const blockEnding = lines[headerIndex].ending;
  if (!blockEnding) {
    fail(headerIndex + 1, "legacy PERMS_KEY literal block header is unterminated");
  }
  let index = headerIndex + 1;
  while (index < lines.length && /^[ \t]/u.test(lines[index].body)) {
    const lineNumber = index + 1;
    const { body: line, ending } = lines[index];
    if (!/^  [\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/u.test(line) ||
        line.length - 2 > MAX_LEGACY_PERMS_LINE_LENGTH || ending !== blockEnding) {
      fail(lineNumber, "invalid legacy PERMS_KEY literal block line");
    }
    content.push(line.slice(2));
    if (content.length > MAX_LEGACY_PERMS_BLOCK_LINES) {
      fail(lineNumber, "legacy PERMS_KEY literal block is too large");
    }
    index += 1;
  }
  if (content.length === 0) {
    fail(headerIndex + 1, "legacy PERMS_KEY literal block is empty");
  }
  return {
    // The rest of the deployment pipeline already uses this single-line
    // representation and restores physical PEM newlines at the consumer.
    value: `${content.join("\\n")}\\n`,
    lastIndex: index - 1
  };
}

export function parseLocalValuesSource(source) {
  if (typeof source !== "string") fail(0, "file is unreadable");
  const values = new Map();
  const lines = splitSourceLines(source);
  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const line = lines[index].body;
    if (line === "---") {
      if (index !== 0 ||
          !(source.startsWith("---\n") || source.startsWith("---\r\n"))) {
        fail(lineNumber, "document start marker requires a first-line LF or CRLF ending");
      }
      continue;
    }
    if (/^[ \t]*(?:#.*)?$/.test(line)) continue;
    if (/^[ \t]/.test(line)) fail(lineNumber, "nested or indented content is not allowed");
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*):(?:[ \t]+(.*))?$/);
    if (!match) fail(lineNumber, "expected one top-level KEY: scalar entry");
    const [, key, rawValue = ""] = match;
    if (values.has(key)) fail(lineNumber, "duplicate key");
    if (line === LEGACY_PERMS_BLOCK_HEADER) {
      const block = parseLegacyPermsBlockLines(lines, index);
      values.set(key, block.value);
      index = block.lastIndex;
      continue;
    }
    const trimmed = rawValue.trimStart();
    let value;
    if (trimmed.startsWith("'")) value = parseQuoted(trimmed, "'", lineNumber);
    else if (trimmed.startsWith('"')) value = parseQuoted(trimmed, '"', lineNumber);
    else value = parsePlain(trimmed, lineNumber);
    if (/[\u0000-\u001f\u007f]/.test(value)) {
      fail(lineNumber, "control character is not allowed");
    }
    values.set(key, value);
  }
  return values;
}

export function parseLocalValuesFile(filePath) {
  let source;
  try {
    source = fs.readFileSync(filePath, "utf8");
  } catch {
    fail(0, "file is unreadable");
  }
  return parseLocalValuesSource(source);
}

function printParseError(error) {
  const lineNumber = error instanceof LocalValuesParseError ? error.lineNumber : 0;
  const reason = error instanceof LocalValuesParseError ? error.reason : "file is unreadable";
  const location = lineNumber ? ` at line ${lineNumber}` : "";
  process.stderr.write(`Invalid local values YAML${location}: ${reason}.\n`);
}

function main() {
  const [filePath, operation = "--validate", argument] = process.argv.slice(2);
  if (!filePath || !["--validate", "--get", "--keys"].includes(operation)) {
    process.stderr.write("Usage: parse-local-values.mjs FILE [--validate | --get KEY | --keys]\n");
    process.exitCode = 64;
    return;
  }
  if (operation === "--get" && !argument) {
    process.stderr.write("Usage: parse-local-values.mjs FILE --get KEY\n");
    process.exitCode = 64;
    return;
  }
  let values;
  try {
    values = parseLocalValuesFile(filePath);
  } catch (error) {
    printParseError(error);
    process.exitCode = 2;
    return;
  }
  if (operation === "--get") {
    process.stdout.write(values.get(argument) ?? "");
  } else if (operation === "--keys") {
    const result = [...values.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => `${key}=${value === "" ? "missing" : "configured"}`)
      .join("\n");
    if (result !== "") process.stdout.write(`${result}\n`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
