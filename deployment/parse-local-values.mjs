#!/usr/bin/env node

// Strict parser for the intentionally small top-level scalar subset used by
// deployment/input-values.local.yaml. It never evaluates YAML tags, anchors,
// block scalars or nested structures, and diagnostics never include values.

import fs from "node:fs";

function fail(lineNumber, reason) {
  const location = lineNumber ? ` at line ${lineNumber}` : "";
  process.stderr.write(`Invalid local values YAML${location}: ${reason}.\n`);
  process.exit(2);
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

function parseFile(path) {
  let source;
  try {
    source = fs.readFileSync(path, "utf8");
  } catch {
    fail(0, "file is unreadable");
  }
  const values = new Map();
  const lines = source.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const line = lines[index];
    if (/^[ \t]*(?:#.*)?$/.test(line)) continue;
    if (/^[ \t]/.test(line)) fail(lineNumber, "nested or indented content is not allowed");
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*):(?:[ \t]+(.*))?$/);
    if (!match) fail(lineNumber, "expected one top-level KEY: scalar entry");
    const [, key, rawValue = ""] = match;
    if (values.has(key)) fail(lineNumber, "duplicate key");
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

const [path, operation = "--validate", argument] = process.argv.slice(2);
if (!path || !["--validate", "--get", "--keys"].includes(operation)) {
  process.stderr.write("Usage: parse-local-values.mjs FILE [--validate | --get KEY | --keys]\n");
  process.exit(64);
}
if (operation === "--get" && !argument) {
  process.stderr.write("Usage: parse-local-values.mjs FILE --get KEY\n");
  process.exit(64);
}

const values = parseFile(path);
if (operation === "--get") {
  process.stdout.write(values.get(argument) ?? "");
} else if (operation === "--keys") {
  const result = [...values.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value === "" ? "missing" : "configured"}`)
    .join("\n");
  if (result !== "") process.stdout.write(`${result}\n`);
}
