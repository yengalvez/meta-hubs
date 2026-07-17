import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import { invalid } from "./errors.mjs";
import { canonicalJson } from "./io.mjs";

const TRACKED_TRUST = JSON.parse(readFileSync(new URL("../trust-anchors.json", import.meta.url), "utf8"));
const EPHEMERAL_TEST_ANCHORS = new Map();
const SIGNATURE_KEYS = ["schemaVersion", "algorithm", "keyId", "value"];

function exactKeys(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function validateAnchor(anchor, testOnly = false) {
  if (!exactKeys(anchor, ["keyId", "algorithm", "publicKeyJwk", "status"]) ||
      anchor.algorithm !== "Ed25519" || anchor.status !== "active" ||
      !/^[a-z0-9][a-z0-9-]{2,63}$/.test(anchor.keyId) ||
      (testOnly && !anchor.keyId.startsWith("test-")) ||
      !exactKeys(anchor.publicKeyJwk, ["kty", "crv", "x"]) ||
      anchor.publicKeyJwk.kty !== "OKP" || anchor.publicKeyJwk.crv !== "Ed25519" ||
      typeof anchor.publicKeyJwk.x !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(anchor.publicKeyJwk.x)) {
    throw invalid("Capacity trust anchor schema is invalid", "TRUST_ANCHOR_INVALID");
  }
  try {
    createPublicKey({ key: anchor.publicKeyJwk, format: "jwk" });
  } catch {
    throw invalid("Capacity trust anchor public key is invalid", "TRUST_ANCHOR_INVALID");
  }
  return Object.freeze(structuredClone(anchor));
}

if (!exactKeys(TRACKED_TRUST, ["schemaVersion", "anchors"]) || TRACKED_TRUST.schemaVersion !== 1 ||
    !Array.isArray(TRACKED_TRUST.anchors)) {
  throw invalid("Tracked capacity trust store is invalid", "TRUST_ANCHOR_INVALID");
}
const TRACKED_ANCHORS = new Map(TRACKED_TRUST.anchors.map(anchor => {
  const checked = validateAnchor(anchor);
  return [checked.keyId, checked];
}));
if (TRACKED_ANCHORS.size !== TRACKED_TRUST.anchors.length) {
  throw invalid("Tracked capacity trust anchors must be unique", "TRUST_ANCHOR_INVALID");
}

export function registerEphemeralTestTrustAnchor(anchor) {
  const checked = validateAnchor(anchor, true);
  EPHEMERAL_TEST_ANCHORS.set(checked.keyId, checked);
  return checked;
}

export function signaturePayload(purpose, unsignedDocument) {
  if (typeof purpose !== "string" || !/^[a-z][a-z0-9-]{2,63}$/.test(purpose)) {
    throw invalid("Signed document purpose is invalid", "SIGNATURE_INVALID");
  }
  return Buffer.from(`yenhubs-capacity-signature-v1\n${purpose}\n${canonicalJson(unsignedDocument)}`, "utf8");
}

export function signDocument(unsignedDocument, { purpose, keyId, privateKeyJwk }) {
  if (!unsignedDocument || typeof unsignedDocument !== "object" || Array.isArray(unsignedDocument) ||
      Object.hasOwn(unsignedDocument, "signature")) {
    throw invalid("Only an unsigned closed document can be signed", "SIGNATURE_INVALID");
  }
  let privateKey;
  try {
    privateKey = createPrivateKey({ key: privateKeyJwk, format: "jwk" });
  } catch {
    throw invalid("Signing private key is invalid", "SIGNATURE_INVALID");
  }
  return {
    ...structuredClone(unsignedDocument),
    signature: {
      schemaVersion: 1,
      algorithm: "Ed25519",
      keyId,
      value: sign(null, signaturePayload(purpose, unsignedDocument), privateKey).toString("base64url")
    }
  };
}

export function signAndVerifyDocument(unsignedDocument, { purpose, signer, productionOnly = true }) {
  if (!signer || !exactKeys(signer, ["keyId", "privateKeyJwk"]) || signer.keyId.startsWith("test-") && productionOnly) {
    throw invalid("A trusted capacity signing key is required", "SIGNING_KEY_REQUIRED");
  }
  const document = signDocument(unsignedDocument, {
    purpose,
    keyId: signer.keyId,
    privateKeyJwk: signer.privateKeyJwk
  });
  verifySignedDocument(document, { purpose, productionOnly });
  return document;
}

export async function loadProductionSignerFromEnvironment(environment = process.env) {
  const keyId = environment.YENHUBS_CAPACITY_SIGNING_KEY_ID;
  const path = environment.YENHUBS_CAPACITY_SIGNING_PRIVATE_KEY_FILE;
  if (!keyId || !path) {
    throw invalid(
      "Physical capacity evidence requires an offline Ed25519 signing key file and key id environment variables",
      "SIGNING_KEY_REQUIRED"
    );
  }
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    throw invalid("Capacity signing key file could not be inspected", "SIGNING_KEY_REQUIRED", { reason: error.code ?? "unknown" });
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 1 || metadata.size > 16 * 1024 ||
      (metadata.mode & 0o077) !== 0) {
    throw invalid("Capacity signing key file must be a bounded 0600 regular file", "SIGNING_KEY_REQUIRED");
  }
  let privateKeyJwk;
  try {
    privateKeyJwk = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw invalid("Capacity signing key file must contain strict JWK JSON", "SIGNING_KEY_REQUIRED");
  }
  const signer = { keyId, privateKeyJwk };
  signAndVerifyDocument({ schemaVersion: 1, keyId }, {
    purpose: "signing-key-preflight",
    signer,
    productionOnly: true
  });
  return signer;
}

export function verifySignedDocument(document, { purpose, productionOnly = false } = {}) {
  if (!document || typeof document !== "object" || Array.isArray(document) ||
      !exactKeys(document.signature, SIGNATURE_KEYS) || document.signature.schemaVersion !== 1 ||
      document.signature.algorithm !== "Ed25519" ||
      !/^[a-z0-9][a-z0-9-]{2,63}$/.test(document.signature.keyId) ||
      !/^[A-Za-z0-9_-]{86}$/.test(document.signature.value)) {
    throw invalid("Signed capacity document signature schema is invalid", "SIGNATURE_INVALID");
  }
  const tracked = TRACKED_ANCHORS.get(document.signature.keyId);
  const test = productionOnly ? null : EPHEMERAL_TEST_ANCHORS.get(document.signature.keyId);
  const anchor = tracked ?? test;
  if (!anchor) throw invalid("Signed capacity document uses an untrusted key", "SIGNATURE_UNTRUSTED");
  const unsigned = structuredClone(document);
  delete unsigned.signature;
  const valid = verify(
    null,
    signaturePayload(purpose, unsigned),
    createPublicKey({ key: anchor.publicKeyJwk, format: "jwk" }),
    Buffer.from(document.signature.value, "base64url")
  );
  if (!valid) throw invalid("Signed capacity document signature is invalid", "SIGNATURE_INVALID");
  return {
    value: structuredClone(document),
    unsigned,
    sha256: createHash("sha256").update(canonicalJson(document)).digest("hex"),
    signerKeyId: anchor.keyId,
    trustDomain: tracked ? "production" : "test"
  };
}

export function signedDocumentBinding(document, purpose, options) {
  const checked = verifySignedDocument(document, { purpose, ...options });
  return {
    sha256: checked.sha256,
    capturedAt: document.capturedAt,
    signerKeyId: checked.signerKeyId
  };
}

export function trackedTrustSummary() {
  return {
    schemaVersion: TRACKED_TRUST.schemaVersion,
    anchors: [...TRACKED_ANCHORS.values()].map(({ keyId, algorithm, status }) => ({ keyId, algorithm, status }))
  };
}
