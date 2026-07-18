#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  captureProcessLocalBaseline,
  collectProcessLocalResources
} from "../../deployment/capture-process-local-baseline.mjs";
import { loadProcessLocalRotationProfile } from "../../deployment/process-local-rotation.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SOURCE = fs.readFileSync(
  path.join(ROOT, "deployment/capture-process-local-baseline.mjs"),
  "utf8"
);
const profile = loadProcessLocalRotationProfile();

function temporaryDirectory() {
  const directory = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), "aud065-capture-")
  );
  fs.chmodSync(directory, 0o700);
  return directory;
}

function expectedIdentity(identity, namespace = "hcce") {
  return {
    apiVersion: identity.apiVersion,
    kind: identity.kind,
    namespace: identity.namespace === "$Namespace" ? namespace : null,
    name: identity.name === "$Namespace" ? namespace : identity.name
  };
}

function resourceFor(request, index) {
  return {
    apiVersion: request.apiVersion,
    kind: request.kind,
    metadata: {
      name: request.name,
      ...(request.namespace === null ? {} : { namespace: request.namespace }),
      uid: `fixture-uid-${index}`,
      resourceVersion: `fixture-rv-${index}`
    }
  };
}

test("captures the exact 42 profile identities into one private List", () => {
  const directory = temporaryDirectory();
  try {
    const requests = [];
    const output = path.join(directory, "baseline.json");
    assert.equal(captureProcessLocalBaseline({
      namespace: "hcce",
      outputPath: output,
      fetchResource(request) {
        requests.push(request);
        return resourceFor(request, requests.length);
      }
    }), true);
    const list = JSON.parse(fs.readFileSync(output, "utf8"));
    assert.equal(list.apiVersion, "v1");
    assert.equal(list.kind, "List");
    assert.equal(list.items.length, 42);
    assert.deepEqual(
      requests.map(({ resourceType: _type, ...identity }) => identity),
      profile.baseline_resource_identities.map(identity => expectedIdentity(identity))
    );
    assert.ok(requests.every(request => typeof request.resourceType === "string"));
    const stat = fs.lstatSync(output);
    assert.equal(stat.mode & 0o7777, 0o600);
    assert.equal(stat.nlink, 1);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("collects the exact 42 profile identities in memory without an output artifact", () => {
  const directory = temporaryDirectory();
  try {
    const requests = [];
    const before = fs.readdirSync(directory);
    const resources = collectProcessLocalResources({
      namespace: "hcce",
      fetchResource(request) {
        requests.push(request);
        return resourceFor(request, requests.length);
      }
    });
    assert.equal(resources.length, 42);
    assert.deepEqual(
      requests.map(({ resourceType: _type, ...identity }) => identity),
      profile.baseline_resource_identities.map(identity => expectedIdentity(identity))
    );
    assert.deepEqual(fs.readdirSync(directory), before);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects identity, UID, resourceVersion and deletion drift without output", () => {
  for (const mutate of [
    resource => { resource.metadata.name = "wrong"; },
    resource => { delete resource.metadata.uid; },
    resource => { delete resource.metadata.resourceVersion; },
    resource => { resource.metadata.deletionTimestamp = "2026-07-18T00:00:00Z"; }
  ]) {
    const directory = temporaryDirectory();
    try {
      const output = path.join(directory, "baseline.json");
      let count = 0;
      assert.throws(() => captureProcessLocalBaseline({
        namespace: "hcce",
        outputPath: output,
        fetchResource(request) {
          count += 1;
          const resource = resourceFor(request, count);
          if (count === 7) mutate(resource);
          return resource;
        }
      }));
      assert.equal(fs.existsSync(output), false);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("does not overwrite an existing path and requires a 0700 parent", () => {
  const existingDirectory = temporaryDirectory();
  try {
    const output = path.join(existingDirectory, "baseline.json");
    fs.writeFileSync(output, "preserve\n", { mode: 0o600 });
    assert.throws(() => captureProcessLocalBaseline({
      namespace: "hcce",
      outputPath: output,
      fetchResource: resourceFor
    }));
    assert.equal(fs.readFileSync(output, "utf8"), "preserve\n");
  } finally {
    fs.rmSync(existingDirectory, { recursive: true, force: true });
  }

  const looseDirectory = temporaryDirectory();
  try {
    fs.chmodSync(looseDirectory, 0o755);
    assert.throws(() => captureProcessLocalBaseline({
      namespace: "hcce",
      outputPath: path.join(looseDirectory, "baseline.json"),
      fetchResource: resourceFor
    }));
  } finally {
    fs.chmodSync(looseDirectory, 0o700);
    fs.rmSync(looseDirectory, { recursive: true, force: true });
  }
});

test("rejects setuid, setgid and sticky bits in the private publication contract", () => {
  for (const mode of [0o4600, 0o2600]) {
    const directory = temporaryDirectory();
    try {
      const output = path.join(directory, "baseline.json");
      assert.equal(captureProcessLocalBaseline({
        namespace: "hcce",
        outputPath: output,
        fetchResource: resourceFor
      }), true);
      fs.chmodSync(output, mode);
      assert.equal(fs.lstatSync(output).mode & 0o7777, mode);
      assert.throws(() => captureProcessLocalBaseline({
        namespace: "hcce",
        outputPath: output,
        fetchResource: resourceFor
      }));
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }

  const stickyDirectory = temporaryDirectory();
  try {
    fs.chmodSync(stickyDirectory, 0o1700);
    assert.equal(fs.lstatSync(stickyDirectory).mode & 0o7777, 0o1700);
    assert.throws(() => captureProcessLocalBaseline({
      namespace: "hcce",
      outputPath: path.join(stickyDirectory, "baseline.json"),
      fetchResource: resourceFor
    }));
  } finally {
    fs.chmodSync(stickyDirectory, 0o700);
    fs.rmSync(stickyDirectory, { recursive: true, force: true });
  }
});

test("source contains only exact GET capture and no generated/apply surfaces", () => {
  assert.match(SOURCE, /"--context", context/u);
  assert.match(SOURCE, /"get", request\.resourceType, request\.name/u);
  assert.doesNotMatch(SOURCE, /kubectl\s+get\s+all|gen-hcce|hcce\.yaml|\bapply\b|\bpatch\b/u);
});
