#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  ProcessLocalBaselineCaptureError,
  captureProcessLocalBaseline,
  collectProcessLocalResources
} from "../../deployment/capture-process-local-baseline.mjs";
import { loadProcessLocalRotationProfile } from "../../deployment/process-local-rotation.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SOURCE = fs.readFileSync(
  path.join(ROOT, "deployment/capture-process-local-baseline.mjs"),
  "utf8"
);
const CLI = path.join(ROOT, "deployment/capture-process-local-baseline.mjs");
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

function expectedOperationalIdentities(namespace = "hcce") {
  return [
    ...profile.baseline_resource_identities.map(identity =>
      expectedIdentity(identity, namespace)
    ),
    {
      apiVersion: profile.legacy_image_pull.secret.apiVersion,
      kind: profile.legacy_image_pull.secret.kind,
      namespace,
      name: profile.legacy_image_pull.secret.name
    },
    {
      apiVersion: profile.legacy_image_pull.service_account.apiVersion,
      kind: profile.legacy_image_pull.service_account.kind,
      namespace,
      name: profile.legacy_image_pull.service_account.name
    }
  ];
}

function expectCode(callback, code) {
  assert.throws(
    callback,
    error => error instanceof ProcessLocalBaselineCaptureError && error.code === code
  );
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

test("captures the ordered 42-resource profile plus legacy GHCR Secret and ServiceAccount", () => {
  const directory = temporaryDirectory();
  try {
    assert.equal(profile.baseline_resource_identities.length, 42);
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
    assert.equal(list.items.length, 44);
    assert.deepEqual(
      requests.map(({ resourceType: _type, ...identity }) => identity),
      expectedOperationalIdentities()
    );
    assert.deepEqual(requests.slice(-2), [
      {
        ...expectedOperationalIdentities().at(-2),
        resourceType: "secret"
      },
      {
        ...expectedOperationalIdentities().at(-1),
        resourceType: "serviceaccount"
      }
    ]);
    assert.equal(requests.some(request => request.name === "bot-images-pull"), false);
    assert.ok(requests.every(request => typeof request.resourceType === "string"));
    const stat = fs.lstatSync(output);
    assert.equal(stat.mode & 0o7777, 0o600);
    assert.equal(stat.nlink, 1);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("collects the exact 44 operational identities in memory without an output artifact", () => {
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
    assert.equal(resources.length, 44);
    assert.deepEqual(
      requests.map(({ resourceType: _type, ...identity }) => identity),
      expectedOperationalIdentities()
    );
    assert.deepEqual(fs.readdirSync(directory), before);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects missing/extra identity, type, UID, resourceVersion and deletion drift", () => {
  for (const mutate of [
    resource => { resource.metadata.name = "wrong"; },
    resource => { resource.apiVersion = "fixture.invalid/v1"; },
    resource => { resource.kind = "ConfigMap"; },
    resource => { resource.metadata.namespace = "wrong"; },
    resource => { delete resource.metadata.uid; },
    resource => { resource.metadata.uid = ""; },
    resource => { delete resource.metadata.resourceVersion; },
    resource => { resource.metadata.resourceVersion = ""; },
    resource => { resource.metadata.deletionTimestamp = "2026-07-18T00:00:00Z"; }
  ]) {
    for (const target of [7, 43, 44]) {
      const directory = temporaryDirectory();
      try {
        const output = path.join(directory, "baseline.json");
        let count = 0;
        expectCode(() => captureProcessLocalBaseline({
          namespace: "hcce",
          outputPath: output,
          fetchResource(request) {
            count += 1;
            const resource = resourceFor(request, count);
            if (count === target) mutate(resource);
            return resource;
          }
        }), "captured_resource_invalid");
        assert.equal(fs.existsSync(output), false);
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    }
  }
});

test("fails closed when either appended GHCR binding cannot be fetched", () => {
  for (const missingName of ["ghcr-pull", "default"]) {
    let calls = 0;
    expectCode(() => collectProcessLocalResources({
      namespace: "hcce",
      fetchResource(request) {
        calls += 1;
        if (request.name === missingName) throw new Error("fixture missing");
        return resourceFor(request, calls);
      }
    }), "resource_capture_failed");
    assert.equal(calls, missingName === "ghcr-pull" ? 43 : 44);
  }
});

test("captures auxiliary bodies verbatim while deferring their detailed semantics", () => {
  const resources = collectProcessLocalResources({
    namespace: "hcce",
    fetchResource(request) {
      const resource = resourceFor(request, request.name);
      if (request.kind === "Secret" && request.name === "ghcr-pull") {
        resource.type = "fixture-type-deferred-to-core";
        resource.data = { ".dockerconfigjson": "fixture-private-body" };
      }
      if (request.kind === "ServiceAccount" && request.name === "default") {
        resource.imagePullSecrets = [{ name: "fixture-deferred-to-core" }];
      }
      return resource;
    }
  });
  assert.equal(resources.length, 44);
  assert.equal(resources.at(-2).data[".dockerconfigjson"], "fixture-private-body");
  assert.deepEqual(resources.at(-1).imagePullSecrets, [
    { name: "fixture-deferred-to-core" }
  ]);
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

test("CLI captures secret-bearing resources privately with zero stdout", () => {
  const directory = temporaryDirectory();
  try {
    const bin = path.join(directory, "bin");
    const output = path.join(directory, "baseline.json");
    const fixturePath = path.join(directory, "kubectl-fixtures.json");
    const fakeKubectl = path.join(bin, "kubectl");
    const requests = [];
    collectProcessLocalResources({
      namespace: "hcce",
      fetchResource(request) {
        requests.push(request);
        return resourceFor(request, requests.length);
      }
    });
    const fixtures = requests.map((request, index) => {
      const resource = resourceFor(request, index + 1);
      if (request.kind === "Secret" && request.name === "ghcr-pull") {
        resource.type = "kubernetes.io/dockerconfigjson";
        resource.data = {
          ".dockerconfigjson": "fixture-private-ghcr-material"
        };
      }
      if (request.kind === "ServiceAccount" && request.name === "default") {
        resource.imagePullSecrets = [{ name: "ghcr-pull" }];
      }
      return { request, resource };
    });
    fs.mkdirSync(bin, { mode: 0o700 });
    fs.writeFileSync(fixturePath, JSON.stringify(fixtures), { mode: 0o600 });
    fs.writeFileSync(fakeKubectl, String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const getIndex = args.indexOf("get");
const namespaceIndex = args.indexOf("-n");
const request = {
  resourceType: args[getIndex + 1],
  name: args[getIndex + 2],
  namespace: namespaceIndex === -1 ? null : args[namespaceIndex + 1]
};
const fixtures = JSON.parse(fs.readFileSync(process.env.KUBECTL_FIXTURES, "utf8"));
const match = fixtures.find(item =>
  item.request.resourceType === request.resourceType &&
  item.request.name === request.name &&
  item.request.namespace === request.namespace
);
if (!match) process.exit(42);
process.stdout.write(JSON.stringify(match.resource));
`, { mode: 0o700 });

    const result = spawnSync(process.execPath, [
      CLI,
      "--context", "fixture-context",
      "--namespace", "hcce",
      "--output", output
    ], {
      encoding: "utf8",
      env: {
        ...process.env,
        KUBECTL_FIXTURES: fixturePath,
        PATH: `${bin}:${process.env.PATH || ""}`
      }
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
    const list = JSON.parse(fs.readFileSync(output, "utf8"));
    assert.equal(list.items.length, 44);
    assert.equal(
      list.items.at(-2).data[".dockerconfigjson"],
      "fixture-private-ghcr-material"
    );
    assert.deepEqual(list.items.at(-1).imagePullSecrets, [{ name: "ghcr-pull" }]);
    assert.equal(fs.lstatSync(output).mode & 0o7777, 0o600);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("source contains only exact GET capture and no generated/apply surfaces", () => {
  assert.match(SOURCE, /"--context", context/u);
  assert.match(SOURCE, /"get", request\.resourceType, request\.name/u);
  assert.doesNotMatch(SOURCE, /process\.stdout/u);
  assert.doesNotMatch(SOURCE, /kubectl\s+get\s+all|gen-hcce|hcce\.yaml|\bapply\b|\bpatch\b/u);
});
