const SECRET_KEY = /(authorization|api[-_]?key|cookie|credential|password|secret|token)/i;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi;

function sanitizeUrlString(value) {
  if (!/^https?:\/\//i.test(value)) return value.replace(BEARER, "Bearer [REDACTED]");
  try {
    const url = new URL(value);
    if (url.username) url.username = "[REDACTED]";
    if (url.password) url.password = "[REDACTED]";
    for (const key of [...url.searchParams.keys()]) url.searchParams.set(key, "[REDACTED]");
    if (url.hash) url.hash = "#[REDACTED]";
    return url.toString().replace(BEARER, "Bearer [REDACTED]");
  } catch {
    return value.replace(BEARER, "Bearer [REDACTED]");
  }
}

export function sanitize(value, seen = new WeakSet()) {
  if (typeof value === "string") return sanitizeUrlString(value);
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);
  if (Array.isArray(value)) return value.map(item => sanitize(item, seen));
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    output[key] = SECRET_KEY.test(key) ? "[REDACTED]" : sanitize(item, seen);
  }
  return output;
}

export function sanitizeText(value, maxLength = 8192) {
  return sanitizeUrlString(String(value)).slice(0, maxLength);
}
