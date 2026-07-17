import { invalid } from "./errors.mjs";

export function valueMatchesUnit(value, unit) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return false;
  if (unit === "ratio") return value <= 1;
  if (unit === "count") return Number.isInteger(value);
  return [
    "ms",
    "fps",
    "s",
    "MiB",
    "bytes_per_second",
    "messages_per_second",
    "requests_per_second"
  ].includes(unit);
}

export function violates(value, rule) {
  if (Object.hasOwn(rule, "max")) return value > rule.max;
  return value < rule.min;
}

export class StopMonitor {
  constructor(thresholds, { runId, earliestObservedAt, latestObservedAt } = {}) {
    this.thresholds = thresholds;
    this.runId = runId;
    this.earliestObservedAtMs = earliestObservedAt ? Date.parse(earliestObservedAt) : null;
    this.latestObservedAtMs = latestObservedAt ? Date.parse(latestObservedAt) : null;
    this.firstObservedAtMs = null;
    this.lastObservedAtMs = null;
    this.activeViolations = new Map();
  }

  observe(event) {
    const keys = event && typeof event === "object" && !Array.isArray(event) ? Object.keys(event).sort() : [];
    if (
      !event ||
      event.type !== "sample" ||
      typeof event.metric !== "string" ||
      keys.join(",") !== "metric,observedAt,runId,type,value"
    ) {
      throw invalid("Driver sample event is malformed", "DRIVER_PROTOCOL_INVALID");
    }
    if (typeof event.runId !== "string" || (this.runId && event.runId !== this.runId)) {
      throw invalid("Driver sample run id does not match the plan", "DRIVER_PROTOCOL_INVALID");
    }
    if (typeof event.value !== "number" || !Number.isFinite(event.value)) {
      throw invalid("Driver sample value must be finite", "DRIVER_PROTOCOL_INVALID");
    }
    const observedAtMs = Date.parse(event.observedAt);
    if (!Number.isFinite(observedAtMs) || new Date(observedAtMs).toISOString() !== event.observedAt) {
      throw invalid("Driver sample requires an ISO observedAt timestamp", "DRIVER_PROTOCOL_INVALID");
    }
    const rule = this.thresholds.metrics[event.metric];
    if (!rule || !rule.stop) {
      throw invalid("Driver sample metric is not in the stop catalogue", "DRIVER_PROTOCOL_INVALID");
    }
    if (
      (this.lastObservedAtMs !== null && observedAtMs < this.lastObservedAtMs) ||
      (this.earliestObservedAtMs !== null && observedAtMs < this.earliestObservedAtMs) ||
      (this.latestObservedAtMs !== null && observedAtMs > this.latestObservedAtMs)
    ) {
      throw invalid("Driver sample timestamps must be monotonic and inside the planned run window", "DRIVER_PROTOCOL_INVALID");
    }
    this.firstObservedAtMs ??= observedAtMs;
    this.lastObservedAtMs = observedAtMs;
    if (!valueMatchesUnit(event.value, rule.unit)) {
      throw invalid("Driver sample value is outside the metric domain", "DRIVER_PROTOCOL_INVALID");
    }
    if (!violates(event.value, rule)) {
      this.activeViolations.delete(event.metric);
      return null;
    }

    if (!rule.sustainedMs) {
      return { metric: event.metric, value: event.value, observedAt: event.observedAt, rule };
    }
    const startedAt = this.activeViolations.get(event.metric) ?? observedAtMs;
    this.activeViolations.set(event.metric, startedAt);
    if (observedAtMs - startedAt >= rule.sustainedMs) {
      return {
        metric: event.metric,
        value: event.value,
        observedAt: event.observedAt,
        violationStartedAt: new Date(startedAt).toISOString(),
        rule
      };
    }
    return null;
  }
}
