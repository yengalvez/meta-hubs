#!/usr/bin/env node

// Capture the exact operational AUD-065 baseline: the 42 identities in the
// accepted historical process-local profile followed by its legacy
// Secret/ghcr-pull and ServiceAccount/default image-pull bindings. The Secret
// bodies are written directly to a new owner-private file; they are never
// emitted as terminal output or routed through the AUD-075 generator/manifest.

import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  canonicalJson,
  loadProcessLocalRotationProfile
} from "./process-local-rotation.mjs";
import { publishPrivateArtifact } from "./private-artifact-publication.mjs";

const MAX_RESOURCE_BYTES = 32 * 1024 * 1024;
const DNS_LABEL = /^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/u;
const CONTEXT = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,252}$/u;

const KUBECTL_RESOURCES = Object.freeze({
  "v1\u0000Namespace": "namespace",
  "v1\u0000Secret": "secret",
  "networking.k8s.io/v1\u0000Ingress": "ingress.networking.k8s.io",
  "v1\u0000ConfigMap": "configmap",
  "apps/v1\u0000Deployment": "deployment.apps",
  "v1\u0000Service": "service",
  "v1\u0000ServiceAccount": "serviceaccount",
  "rbac.authorization.k8s.io/v1\u0000ClusterRole":
    "clusterrole.rbac.authorization.k8s.io",
  "rbac.authorization.k8s.io/v1\u0000ClusterRoleBinding":
    "clusterrolebinding.rbac.authorization.k8s.io",
  "networking.k8s.io/v1\u0000NetworkPolicy": "networkpolicy.networking.k8s.io"
});

export class ProcessLocalBaselineCaptureError extends Error {
  constructor(code) {
    super(code);
    this.name = "ProcessLocalBaselineCaptureError";
    this.code = code;
  }
}

function fail(code) {
  throw new ProcessLocalBaselineCaptureError(code);
}

function writePrivateList(outputPath, resources) {
  const body = Buffer.from(`${canonicalJson({
    apiVersion: "v1",
    kind: "List",
    items: resources
  })}\n`, "utf8");
  try {
    publishPrivateArtifact({
      outputPath,
      bytes: body,
      maximumBytes: MAX_RESOURCE_BYTES
    });
  } catch {
    fail("private_output_invalid");
  }
}

function assertResourceListSize(resources) {
  const bytes = Buffer.byteLength(canonicalJson({
    apiVersion: "v1",
    kind: "List",
    items: resources
  }), "utf8");
  if (bytes < 1 || bytes + 1 > MAX_RESOURCE_BYTES) {
    fail("captured_resource_inventory_invalid");
  }
}

function renderedIdentity(identity, namespace) {
  return {
    apiVersion: identity.apiVersion,
    kind: identity.kind,
    namespace: identity.namespace === "$Namespace" ? namespace : null,
    name: identity.name === "$Namespace" ? namespace : identity.name
  };
}

function operationalProfileIdentities(profile) {
  const imagePull = profile.legacy_image_pull;
  if (!Array.isArray(profile.baseline_resource_identities) ||
      profile.baseline_resource_identities.length !== 42 || !imagePull ||
      typeof imagePull !== "object" || Array.isArray(imagePull) ||
      !imagePull.secret || typeof imagePull.secret !== "object" ||
      Array.isArray(imagePull.secret) || !imagePull.service_account ||
      typeof imagePull.service_account !== "object" ||
      Array.isArray(imagePull.service_account)) {
    fail("capture_input_invalid");
  }
  const auxiliary = [
    {
      apiVersion: imagePull.secret.apiVersion,
      kind: imagePull.secret.kind,
      namespace: "$Namespace",
      name: imagePull.secret.name
    },
    {
      apiVersion: imagePull.service_account.apiVersion,
      kind: imagePull.service_account.kind,
      namespace: "$Namespace",
      name: imagePull.service_account.name
    }
  ];
  if (auxiliary[0].apiVersion !== "v1" || auxiliary[0].kind !== "Secret" ||
      auxiliary[0].name !== "ghcr-pull" ||
      auxiliary[1].apiVersion !== "v1" ||
      auxiliary[1].kind !== "ServiceAccount" ||
      auxiliary[1].name !== "default") {
    fail("profile_resource_inventory_invalid");
  }
  return [...profile.baseline_resource_identities, ...auxiliary];
}

function resourceType(identity) {
  const type = KUBECTL_RESOURCES[`${identity.apiVersion}\u0000${identity.kind}`];
  if (!type) fail("profile_resource_type_invalid");
  return type;
}

function validateCapturedResource(resource, expected) {
  if (!resource || typeof resource !== "object" || Array.isArray(resource) ||
      resource.apiVersion !== expected.apiVersion || resource.kind !== expected.kind ||
      !resource.metadata || resource.metadata.name !== expected.name ||
      (expected.namespace === null
        ? resource.metadata.namespace !== undefined
        : resource.metadata.namespace !== expected.namespace) ||
      typeof resource.metadata.uid !== "string" || !resource.metadata.uid ||
      typeof resource.metadata.resourceVersion !== "string" ||
      !resource.metadata.resourceVersion || resource.metadata.deletionTimestamp != null) {
    fail("captured_resource_invalid");
  }
}

export function collectProcessLocalResources({
  namespace,
  fetchResource
}) {
  const profile = loadProcessLocalRotationProfile();
  if (!DNS_LABEL.test(namespace || "") || typeof fetchResource !== "function") {
    fail("capture_input_invalid");
  }
  const profileIdentities = operationalProfileIdentities(profile);
  const resources = [];
  const identities = new Set();
  for (const profileIdentity of profileIdentities) {
    const expected = renderedIdentity(profileIdentity, namespace);
    const key = canonicalJson(expected);
    if (identities.has(key) || expected.name === "bot-images-pull") {
      fail("profile_resource_inventory_invalid");
    }
    identities.add(key);
    let resource;
    try {
      resource = fetchResource({ ...expected, resourceType: resourceType(expected) });
    } catch {
      fail("resource_capture_failed");
    }
    validateCapturedResource(resource, expected);
    resources.push(structuredClone(resource));
  }
  if (resources.length !== 44 || identities.size !== 44) {
    fail("captured_resource_inventory_invalid");
  }
  assertResourceListSize(resources);
  return resources;
}

export function captureProcessLocalBaseline({
  namespace,
  outputPath,
  fetchResource
}) {
  const resources = collectProcessLocalResources({ namespace, fetchResource });
  writePrivateList(outputPath, resources);
  return true;
}

function kubectlFetch(context, request) {
  const args = [
    "--context", context,
    "--request-timeout=45s",
    "get", request.resourceType, request.name
  ];
  if (request.namespace !== null) args.push("-n", request.namespace);
  args.push("-o", "json");
  const result = spawnSync("kubectl", args, {
    encoding: "utf8",
    maxBuffer: MAX_RESOURCE_BYTES,
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (result.status !== 0 || typeof result.stdout !== "string" || !result.stdout) {
    fail("kubectl_capture_failed");
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    fail("kubectl_capture_invalid_json");
  }
}

export function captureLiveProcessLocalResources({ context, namespace }) {
  if (!CONTEXT.test(context || "") || !DNS_LABEL.test(namespace || "")) {
    fail("capture_input_invalid");
  }
  return collectProcessLocalResources({
    namespace,
    fetchResource: request => kubectlFetch(context, request)
  });
}

function parseArguments(argv) {
  const allowed = new Set(["--context", "--namespace", "--output"]);
  if (argv.length !== 6) fail("arguments_invalid");
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    if (!allowed.has(argv[index]) || values.has(argv[index]) ||
        typeof argv[index + 1] !== "string" || !argv[index + 1]) {
      fail("arguments_invalid");
    }
    values.set(argv[index], argv[index + 1]);
  }
  if (values.size !== allowed.size || !CONTEXT.test(values.get("--context")) ||
      !DNS_LABEL.test(values.get("--namespace"))) fail("arguments_invalid");
  return values;
}

function main() {
  try {
    const args = parseArguments(process.argv.slice(2));
    captureProcessLocalBaseline({
      namespace: args.get("--namespace"),
      outputPath: args.get("--output"),
      fetchResource: request => kubectlFetch(args.get("--context"), request)
    });
    // Success is intentionally silent: the captured List contains credentials.
  } catch {
    process.stderr.write("process-local baseline capture failed closed\n");
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
