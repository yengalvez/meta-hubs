#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadProcessLocalRotationProfile } from "../../deployment/process-local-rotation.mjs";
import {
  ProcessLocalValuesProjectionError,
  projectProcessLocalValues,
  projectProcessLocalValuesMap
} from "../../deployment/project-process-local-values.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CLI = path.join(ROOT, "deployment/project-process-local-values.mjs");
const profile = loadProcessLocalRotationProfile();

function fixture() {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "aud065-values-"));
  fs.chmodSync(root, 0o700);
  const required = new Set([
    profile.namespace_value_key,
    ...profile.secret_keys.filter(name => !profile.derived_secret_keys.includes(name)),
    ...profile.image_pairs.map(pair => pair.value_key),
    profile.legacy_image_pull.snapshot_value_key,
    ...profile.legacy_image_pull.verified_image_value_keys
  ]);
  const values = Object.fromEntries([...required].sort().map(name => [
    name,
    name === "Namespace" ? "hcce" : `fixture-${name.toLowerCase()}`
  ]));
  values.UNRELATED_AUD075_VALUE = "ignored-fixture";
  values.PGRST_JWT_SECRET = "";
  const literalPermsLine = values.PERMS_KEY;
  values.PERMS_KEY = `${literalPermsLine}\\n`;
  const source = path.join(root, "values.yaml");
  const sourceLines = Object.entries(values).map(([key, value]) => {
    if (key === "PERMS_KEY") return `PERMS_KEY: |\n  ${literalPermsLine}`;
    return `${key}: "${value}"`;
  });
  fs.writeFileSync(
    source,
    `---\n${sourceLines.join("\n")}\n`,
    { mode: 0o600 }
  );
  fs.chmodSync(source, 0o600);
  return { root, source, values, required };
}

function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

function directValuesMap() {
  const required = new Set([
    profile.namespace_value_key,
    ...profile.secret_keys.filter(name => !profile.derived_secret_keys.includes(name)),
    ...profile.image_pairs.map(pair => pair.value_key),
    profile.legacy_image_pull.snapshot_value_key,
    ...profile.legacy_image_pull.verified_image_value_keys
  ]);
  return new Map([...required].sort().map(name => [
    name,
    name === "Namespace" ? "hcce" : `fixture-${name.toLowerCase()}`
  ]));
}

test("pure Map projection returns the exact keyset and configured optional values", () => {
  const values = directValuesMap();
  values.set("UNRELATED_AUD075_VALUE", "ignored-fixture");
  values.set("PGRST_JWT_SECRET", "fixture-derived");

  const projected = projectProcessLocalValuesMap(values);
  const expectedKeys = [...values.keys()]
    .filter(name => name !== "UNRELATED_AUD075_VALUE")
    .sort();

  assert.deepEqual(Object.keys(projected).sort(), expectedKeys);
  assert.equal(projected.PGRST_JWT_SECRET, "fixture-derived");
  assert.equal(projected.UNRELATED_AUD075_VALUE, undefined);
  assert.equal(values.get("UNRELATED_AUD075_VALUE"), "ignored-fixture");
});

test("pure Map projection omits empty optionals and rejects a missing required value", () => {
  const values = directValuesMap();
  values.set("PGRST_JWT_SECRET", "");
  assert.equal(projectProcessLocalValuesMap(values).PGRST_JWT_SECRET, undefined);

  values.delete("DB_PASS");
  assert.throws(
    () => projectProcessLocalValuesMap(values),
    error => error instanceof ProcessLocalValuesProjectionError &&
      error.code === "required_value_missing"
  );
});

test("projects only the exact historical direct keys into one private JSON file", () => {
  const input = fixture();
  try {
    const output = path.join(input.root, "snapshot.json");
    assert.equal(projectProcessLocalValues({ sourcePath: input.source, outputPath: output }), true);
    assert.equal(projectProcessLocalValues({ sourcePath: input.source, outputPath: output }), true);
    const projected = JSON.parse(fs.readFileSync(output, "utf8"));
    assert.deepEqual(Object.keys(projected).sort(), [...input.required].sort());
    assert.equal(projected.UNRELATED_AUD075_VALUE, undefined);
    assert.equal(projected.PGRST_JWT_SECRET, undefined);
    const stat = fs.lstatSync(output);
    assert.equal(stat.mode & 0o7777, 0o600);
    assert.equal(stat.nlink, 1);
  } finally {
    cleanup(input.root);
  }
});

test("CLI is silent on success and includes a configured optional derived key", () => {
  const input = fixture();
  try {
    fs.appendFileSync(input.source, "# fixture comment\n");
    const source = fs.readFileSync(input.source, "utf8")
      .replace('PGRST_JWT_SECRET: ""', 'PGRST_JWT_SECRET: "fixture-derived"');
    fs.writeFileSync(input.source, source, { mode: 0o600 });
    const output = path.join(input.root, "snapshot.json");
    const result = spawnSync(process.execPath, [CLI, input.source, output], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
    assert.equal(JSON.parse(fs.readFileSync(output, "utf8")).PGRST_JWT_SECRET,
      "fixture-derived");
  } finally {
    cleanup(input.root);
  }
});

test("allows an ancestor directory link count to change during the source read", () => {
  const input = fixture();
  const originalReadSync = fs.readSync;
  try {
    const nonPrivateAncestor = path.join(input.root, "non-private-ancestor");
    const privateParent = path.join(nonPrivateAncestor, "private-source");
    fs.mkdirSync(nonPrivateAncestor, { mode: 0o755 });
    fs.chmodSync(nonPrivateAncestor, 0o755);
    fs.mkdirSync(privateParent, { mode: 0o700 });
    fs.chmodSync(privateParent, 0o700);
    const source = path.join(privateParent, "values.yaml");
    fs.renameSync(input.source, source);
    const output = path.join(privateParent, "snapshot.json");
    const linkCountBefore = fs.lstatSync(nonPrivateAncestor).nlink;
    let mutationApplied = false;
    fs.readSync = (...args) => {
      if (!mutationApplied) {
        fs.mkdirSync(path.join(nonPrivateAncestor, "sibling-directory"), { mode: 0o700 });
        mutationApplied = true;
      }
      return originalReadSync(...args);
    };

    assert.equal(projectProcessLocalValues({ sourcePath: source, outputPath: output }), true);
    assert.equal(mutationApplied, true);
    assert.notEqual(fs.lstatSync(nonPrivateAncestor).nlink, linkCountBefore);
    const projected = JSON.parse(fs.readFileSync(output, "utf8"));
    assert.deepEqual(Object.keys(projected).sort(), [...input.required].sort());
    for (const key of input.required) assert.equal(projected[key], input.values[key]);
  } finally {
    fs.readSync = originalReadSync;
    cleanup(input.root);
  }
});

test("missing required values and an existing output fail without disclosure or overwrite", () => {
  const input = fixture();
  try {
    const source = fs.readFileSync(input.source, "utf8")
      .split("\n").filter(line => !line.startsWith("DB_PASS:")).join("\n");
    fs.writeFileSync(input.source, source, { mode: 0o600 });
    const missingOutput = path.join(input.root, "missing.json");
    const missing = spawnSync(process.execPath, [CLI, input.source, missingOutput], {
      encoding: "utf8"
    });
    assert.equal(missing.status, 1);
    assert.equal(missing.stdout, "");
    assert.equal(missing.stderr, "process-local values projection failed closed\n");
    assert.equal(fs.existsSync(missingOutput), false);

    const valid = fixture();
    try {
      const existing = path.join(valid.root, "existing.json");
      fs.writeFileSync(existing, "preserve\n", { mode: 0o600 });
      assert.throws(() => projectProcessLocalValues({
        sourcePath: valid.source,
        outputPath: existing
      }));
      assert.equal(fs.readFileSync(existing, "utf8"), "preserve\n");
    } finally {
      cleanup(valid.root);
    }
  } finally {
    cleanup(input.root);
  }
});

test("rejects loose, hardlinked and symlink-component inputs", () => {
  const loose = fixture();
  try {
    fs.chmodSync(loose.source, 0o640);
    assert.throws(() => projectProcessLocalValues({
      sourcePath: loose.source,
      outputPath: path.join(loose.root, "loose.json")
    }));
  } finally {
    cleanup(loose.root);
  }

  const special = fixture();
  try {
    fs.chmodSync(special.source, 0o4600);
    assert.throws(() => projectProcessLocalValues({
      sourcePath: special.source,
      outputPath: path.join(special.root, "special.json")
    }));
  } finally {
    cleanup(special.root);
  }

  const linked = fixture();
  try {
    const alias = path.join(linked.root, "values-hardlink.yaml");
    fs.linkSync(linked.source, alias);
    assert.throws(() => projectProcessLocalValues({
      sourcePath: alias,
      outputPath: path.join(linked.root, "linked.json")
    }));
  } finally {
    cleanup(linked.root);
  }

  const symlinked = fixture();
  try {
    const parent = path.dirname(symlinked.root);
    const aliasDirectory = path.join(parent, `${path.basename(symlinked.root)}-alias`);
    fs.symlinkSync(symlinked.root, aliasDirectory);
    assert.throws(() => projectProcessLocalValues({
      sourcePath: path.join(aliasDirectory, "values.yaml"),
      outputPath: path.join(symlinked.root, "symlink.json")
    }));
    fs.unlinkSync(aliasDirectory);
  } finally {
    cleanup(symlinked.root);
  }
});

test("requires an owner-private output parent", () => {
  const input = fixture();
  try {
    fs.chmodSync(input.root, 0o755);
    assert.throws(() => projectProcessLocalValues({
      sourcePath: input.source,
      outputPath: path.join(input.root, "snapshot.json")
    }));
  } finally {
    fs.chmodSync(input.root, 0o700);
    cleanup(input.root);
  }


  const special = fixture();
  try {
    fs.chmodSync(special.root, 0o1700);
    assert.throws(() => projectProcessLocalValues({
      sourcePath: special.source,
      outputPath: path.join(special.root, "snapshot.json")
    }));
  } finally {
    fs.chmodSync(special.root, 0o700);
    cleanup(special.root);
  }
});
