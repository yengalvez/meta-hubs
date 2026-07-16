import { isIP } from "node:net";
import { invalid } from "./errors.mjs";

const PRODUCTION_HOST_SUFFIXES = ["meta-hubs.org"];
const STAGING_HOST_MARKER = /(^|[.-])(staging|stage|test|testing|qa|preview|sandbox|dev)([.-]|$)/i;

function replaceRoomToken(target) {
  return target.replaceAll("{room}", "capacity-room-placeholder");
}

export function validateTarget(target, { roomCount = 1 } = {}) {
  if (typeof target !== "string" || target.trim() === "") {
    throw invalid("No capacity target is configured by default; pass --target explicitly", "TARGET_REQUIRED");
  }
  if (target !== target.trim()) throw invalid("Target must not contain surrounding whitespace", "TARGET_INVALID");
  if (roomCount > 1 && !target.includes("{room}")) {
    throw invalid("Multi-room scenarios require a literal {room} target placeholder", "ROOM_TEMPLATE_REQUIRED", { roomCount });
  }

  let url;
  try {
    url = new URL(replaceRoomToken(target));
  } catch {
    throw invalid("Target must be an absolute URL", "TARGET_INVALID");
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  const isLocal = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  const isProduction = PRODUCTION_HOST_SUFFIXES.some(suffix => hostname === suffix || hostname.endsWith(`.${suffix}`));

  if (isProduction) throw invalid("Production targets are always denied", "PRODUCTION_TARGET_DENIED", { hostname });
  if (url.username || url.password) throw invalid("Credentials are forbidden in capacity target URLs", "TARGET_CREDENTIALS_DENIED");
  if (url.search || url.hash) throw invalid("Query strings and fragments are forbidden in capacity target URLs", "TARGET_SECRET_CHANNEL_DENIED");
  if (isLocal && url.protocol !== "http:" && url.protocol !== "https:") {
    throw invalid("Local targets must use HTTP or HTTPS", "TARGET_PROTOCOL_DENIED");
  }
  if (!isLocal && url.protocol !== "https:") {
    throw invalid("Remote staging targets must use HTTPS", "TARGET_PROTOCOL_DENIED");
  }
  if (!isLocal && (isIP(hostname) !== 0 || !STAGING_HOST_MARKER.test(hostname))) {
    throw invalid("Remote targets must have an explicit staging/test/qa/preview/sandbox/dev hostname", "TARGET_NOT_PROVABLY_STAGING", { hostname });
  }

  const canonical = target.includes("{room}")
    ? url.toString().replace("capacity-room-placeholder", "{room}")
    : url.toString();
  return { canonical, hostname, classification: isLocal ? "local" : "staging" };
}

export function assertExecutionSafety() {
  throw invalid(
    "Physical execution is disabled until a reviewed driver, sandbox and destination enforcement exist",
    "PHYSICAL_EXECUTION_DISABLED"
  );
}
