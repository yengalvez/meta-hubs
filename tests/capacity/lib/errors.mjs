export class CapacityError extends Error {
  constructor(message, { code = "CAPACITY_ERROR", state = "INVALID", details = undefined } = {}) {
    super(message);
    this.name = "CapacityError";
    this.code = code;
    this.state = state;
    this.details = details;
  }
}

export function invalid(message, code, details) {
  return new CapacityError(message, { code, state: "INVALID", details });
}

export function failed(message, code, details) {
  return new CapacityError(message, { code, state: "FAILED", details });
}
