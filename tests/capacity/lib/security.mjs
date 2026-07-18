import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { invalid } from "./errors.mjs";
import { canonicalJson } from "./io.mjs";
import { verifySignedDocument } from "./trust.mjs";

const PRODUCTION_DOMAIN = "meta-hubs.org";
const STAGING_HOST_MARKER = /(^|[.-])(staging|stage|test|testing|qa|preview|sandbox|dev)([.-]|$)/i;
const FORBIDDEN_ENVIRONMENT_MARKER = /(^|[.-])(prod|production|live)([.-]|$)/i;
const ATTESTATION_KEYS = [
  "schemaVersion",
  "id",
  "environment",
  "approvedAt",
  "expiresAt",
  "reviewerId",
  "targetOrigins",
  "collectorEndpoints",
  "serviceOrigins",
  "coturnUrls",
  "planBinding",
  "signature"
];
const SERVICE_KEYS = ["hubs", "reticulum", "dialog", "assets"];
const PLAN_BINDING_KEYS = ["scenarioId", "targetTemplate", "executionEnabled", "environmentSha256"];

function exactKeys(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function canonicalIso(value) {
  if (typeof value !== "string") return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value ? milliseconds : null;
}

function normalizedHostname(value) {
  return value.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

export function isLoopbackHostname(hostname) {
  const normalized = normalizedHostname(hostname);
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

function isProductionFamilyOrDeception(hostname) {
  const normalized = normalizedHostname(hostname);
  return normalized === PRODUCTION_DOMAIN || normalized.endsWith(`.${PRODUCTION_DOMAIN}`) ||
    normalized.includes(`${PRODUCTION_DOMAIN}.`) || FORBIDDEN_ENVIRONMENT_MARKER.test(normalized);
}

function assertExplicitStagingHostname(hostname, code = "TARGET_NOT_PROVABLY_STAGING") {
  const normalized = normalizedHostname(hostname);
  if (isLoopbackHostname(normalized) || isIP(normalized) !== 0 || !STAGING_HOST_MARKER.test(normalized) ||
      isProductionFamilyOrDeception(normalized)) {
    throw invalid("Every remote capacity endpoint requires one explicit staging hostname", code);
  }
  return normalized;
}

function parseAbsoluteUrl(value, code = "TARGET_INVALID") {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    throw invalid("URL must be a non-empty absolute value without surrounding whitespace", code);
  }
  let url;
  try {
    url = new URL(value.replaceAll("{room}", "capacity-room-placeholder"));
  } catch {
    throw invalid("URL must be absolute", code);
  }
  if (url.username || url.password) throw invalid("URL credentials are forbidden", "TARGET_CREDENTIALS_DENIED");
  if (url.search || url.hash) throw invalid("URL query strings and fragments are forbidden", "TARGET_SECRET_CHANNEL_DENIED");
  const hostname = normalizedHostname(url.hostname);
  if (isProductionFamilyOrDeception(hostname)) {
    throw invalid("Production-family and deceptive production-like hosts are denied", "PRODUCTION_TARGET_DENIED");
  }
  return { url, hostname };
}

export function validateTarget(target, { roomCount = 1 } = {}) {
  if (typeof target !== "string" || target.trim() === "") {
    throw invalid("No capacity target is configured by default; pass --target explicitly", "TARGET_REQUIRED");
  }
  if (roomCount > 1 && !target.includes("{room}")) {
    throw invalid("Multi-room scenarios require a literal {room} target placeholder", "ROOM_TEMPLATE_REQUIRED", { roomCount });
  }
  const { url, hostname } = parseAbsoluteUrl(target);
  const loopback = isLoopbackHostname(hostname);
  if (!loopback && url.protocol !== "https:") {
    throw invalid("Remote capacity targets must use HTTPS", "TARGET_PROTOCOL_DENIED");
  }
  if (loopback && !["http:", "https:"].includes(url.protocol)) {
    throw invalid("Loopback capacity targets must use HTTP or HTTPS", "TARGET_PROTOCOL_DENIED");
  }
  if (!loopback) assertExplicitStagingHostname(hostname);
  const canonical = target.includes("{room}")
    ? url.toString().replace("capacity-room-placeholder", "{room}")
    : url.toString();
  return {
    canonical,
    hostname,
    origin: url.origin,
    classification: loopback ? "local" : "attested-staging"
  };
}

function canonicalOrigin(value, label) {
  const { url, hostname } = parseAbsoluteUrl(value, "ATTESTATION_INVALID");
  if (!["https:", "wss:"].includes(url.protocol) || value !== url.origin) {
    throw invalid(`${label} must be one exact HTTPS or WSS origin`, "ATTESTATION_INVALID");
  }
  assertExplicitStagingHostname(hostname, "ATTESTATION_INVALID");
  return url.origin;
}

function canonicalEndpoint(value, label) {
  const { url, hostname } = parseAbsoluteUrl(value, "ATTESTATION_INVALID");
  if (url.protocol !== "https:" || value !== url.toString()) {
    throw invalid(`${label} must be one exact canonical HTTPS endpoint`, "ATTESTATION_INVALID");
  }
  assertExplicitStagingHostname(hostname, "ATTESTATION_INVALID");
  return url.toString();
}

function canonicalCoturnUrl(value) {
  if (typeof value !== "string" || !/^(?:stuns?|turns?):[^\s#]+$/i.test(value) || /@/.test(value)) {
    throw invalid("Coturn attestation entries must be credential-free ICE URLs", "ATTESTATION_INVALID");
  }
  const scheme = value.slice(0, value.indexOf(":")).toLowerCase();
  let parsed;
  try {
    parsed = new URL(value
      .replace(/^(?:stun|turn):/i, "http:")
      .replace(/^(?:stuns|turns):/i, "https:"));
  } catch {
    throw invalid("Coturn attestation URL is invalid", "ATTESTATION_INVALID");
  }
  if (!parsed.hostname || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.hash) {
    throw invalid("Coturn attestation URL is invalid", "ATTESTATION_INVALID");
  }
  const query = [...parsed.searchParams.entries()];
  if ((scheme.startsWith("stun") && query.length > 0) || query.length > 1 || (query.length === 1 &&
      (query[0][0] !== "transport" || !["udp", "tcp"].includes(query[0][1])))) {
    throw invalid("Coturn attestation URL may contain only a public transport selector", "ATTESTATION_INVALID");
  }
  assertExplicitStagingHostname(parsed.hostname, "ATTESTATION_INVALID");
  return value.toLowerCase();
}

function closedUniqueArray(values, mapper, label) {
  if (!Array.isArray(values) || values.length === 0 || values.length > 16) {
    throw invalid(`${label} must be a non-empty bounded allowlist`, "ATTESTATION_INVALID");
  }
  const normalized = values.map(value => mapper(value, label));
  if (new Set(normalized).size !== normalized.length || canonicalJson(normalized) !== canonicalJson([...normalized].sort())) {
    throw invalid(`${label} must be sorted and unique`, "ATTESTATION_INVALID");
  }
  return normalized;
}

export function validateAttestation(attestation, { target, issuedAt, planBinding, productionOnly = false }) {
  const signed = verifySignedDocument(attestation, { purpose: "remote-attestation", productionOnly });
  if (!exactKeys(attestation, ATTESTATION_KEYS) || attestation.schemaVersion !== 1 ||
      !/^[a-z0-9][a-z0-9-]{2,63}$/.test(attestation.id) || attestation.environment !== "staging" ||
      !/^[a-z0-9][a-z0-9-]{2,63}$/.test(attestation.reviewerId) ||
      !exactKeys(attestation.serviceOrigins, SERVICE_KEYS) ||
      !exactKeys(attestation.planBinding, PLAN_BINDING_KEYS) ||
      canonicalJson(attestation.planBinding) !== canonicalJson(planBinding)) {
    throw invalid("Remote execution attestation schema is closed", "ATTESTATION_INVALID");
  }
  const approvedAtMs = canonicalIso(attestation.approvedAt);
  const expiresAtMs = canonicalIso(attestation.expiresAt);
  const issuedAtMs = canonicalIso(issuedAt);
  if (approvedAtMs === null || expiresAtMs === null || issuedAtMs === null ||
      approvedAtMs > issuedAtMs || expiresAtMs <= issuedAtMs || expiresAtMs - approvedAtMs > 31 * 24 * 60 * 60 * 1000) {
    throw invalid("Attestation approval/expiry window is invalid", "ATTESTATION_INVALID");
  }
  const normalized = {
    ...attestation,
    targetOrigins: closedUniqueArray(attestation.targetOrigins, canonicalOrigin, "targetOrigins"),
    collectorEndpoints: closedUniqueArray(attestation.collectorEndpoints, canonicalEndpoint, "collectorEndpoints"),
    serviceOrigins: Object.fromEntries(SERVICE_KEYS.map(key => [
      key,
      closedUniqueArray(attestation.serviceOrigins[key], canonicalOrigin, `serviceOrigins.${key}`)
    ])),
    coturnUrls: closedUniqueArray(attestation.coturnUrls, canonicalCoturnUrl, "coturnUrls")
  };
  if (canonicalJson(normalized) !== canonicalJson(attestation)) {
    throw invalid("Remote attestation allowlists must already be canonical", "ATTESTATION_INVALID");
  }
  const targetInfo = validateTarget(target);
  if (!normalized.targetOrigins.includes(targetInfo.origin) || !normalized.serviceOrigins.hubs.includes(targetInfo.origin)) {
    throw invalid("Attestation does not bind the exact Hubs target origin", "ATTESTATION_TARGET_MISMATCH");
  }
  return {
    value: normalized,
    sha256: createHash("sha256").update(canonicalJson(normalized)).digest("hex"),
    signerKeyId: signed.signerKeyId,
    trustDomain: signed.trustDomain
  };
}

export function buildSecurityBinding({ targetInfo, attestation, issuedAt, planBinding, productionOnly = false }) {
  if (targetInfo.classification === "local") {
    if (attestation !== undefined && attestation !== null) {
      throw invalid("Loopback plans do not accept remote attestations", "ATTESTATION_INVALID");
    }
    return {
      mode: "loopback",
      attestation: null,
      attestationSha256: null,
      attestationSignerKeyId: null,
      allowedBrowserOrigins: [targetInfo.origin],
      collectorEndpoints: [],
      coturnUrls: []
    };
  }
  if (!attestation) throw invalid("Remote plans require an explicit reviewed attestation", "ATTESTATION_REQUIRED");
  const checked = validateAttestation(attestation, {
    target: targetInfo.canonical,
    issuedAt,
    planBinding,
    productionOnly
  });
  const allowedBrowserOrigins = [...new Set([
    ...checked.value.targetOrigins,
    ...Object.values(checked.value.serviceOrigins).flat()
  ])].sort();
  return {
    mode: "attested-remote",
    attestation: checked.value,
    attestationSha256: checked.sha256,
    attestationSignerKeyId: checked.signerKeyId,
    allowedBrowserOrigins,
    collectorEndpoints: checked.value.collectorEndpoints,
    coturnUrls: checked.value.coturnUrls
  };
}

export function validateSecurityBinding(binding, { target, issuedAt, planBinding, productionOnly = false }) {
  const targetInfo = validateTarget(target);
  const expected = buildSecurityBinding({
    targetInfo,
    attestation: binding?.mode === "attested-remote" ? binding.attestation : null,
    issuedAt,
    planBinding,
    productionOnly
  });
  if (canonicalJson(binding) !== canonicalJson(expected)) {
    throw invalid("Plan security binding is not canonical", "PLAN_SECURITY_INVALID");
  }
  return { targetInfo, binding: expected };
}

export function validateCollectorEndpoint(endpoint, securityBinding) {
  const { url, hostname } = parseAbsoluteUrl(endpoint, "COLLECTOR_ENDPOINT_INVALID");
  if (securityBinding.mode === "loopback") {
    if (!isLoopbackHostname(hostname) || !["http:", "https:"].includes(url.protocol) ||
        url.pathname !== "/v1/capacity-sample") {
      throw invalid("Loopback plans require a loopback collector", "COLLECTOR_CLASSIFICATION_MISMATCH");
    }
    return url.toString();
  }
  if (!securityBinding.collectorEndpoints.includes(url.toString())) {
    throw invalid("Collector endpoint is not exactly attested", "COLLECTOR_ATTESTATION_MISMATCH");
  }
  return url.toString();
}

export function assertAllowedBrowserUrl(value, securityBinding) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw invalid("Browser attempted an invalid network URL", "BROWSER_ORIGIN_DENIED");
  }
  const hostname = normalizedHostname(url.hostname);
  if (isProductionFamilyOrDeception(hostname)) throw invalid("Browser attempted a production-family origin", "PRODUCTION_TARGET_DENIED");
  if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) {
    throw invalid("Browser attempted a non-network or unsupported scheme", "BROWSER_ORIGIN_DENIED");
  }
  if (securityBinding.mode === "loopback") {
    const allowed = new Set(securityBinding.allowedBrowserOrigins.flatMap(origin => {
      const parsed = new URL(origin);
      const webSocket = `${parsed.protocol === "https:" ? "wss:" : "ws:"}//${parsed.host}`;
      return [origin, webSocket];
    }));
    if (!isLoopbackHostname(hostname) || !allowed.has(url.origin)) {
      throw invalid("Loopback run attempted an unplanned origin or port", "BROWSER_ORIGIN_DENIED");
    }
    return;
  }
  const allowed = new Set(securityBinding.allowedBrowserOrigins);
  if (!allowed.has(url.origin)) throw invalid("Browser attempted an unattested origin", "BROWSER_ORIGIN_DENIED");
}
