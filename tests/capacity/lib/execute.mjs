import { invalid } from "./errors.mjs";
import { buildReport } from "./report.mjs";
import { StopMonitor } from "./stop-monitor.mjs";

const MAX_PROTOCOL_LINE_BYTES = 128 * 1024;

function exactKeys(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === [...expected].sort()[index]);
}

function safeBreach(breach) {
  return {
    metric: breach.metric,
    value: breach.value,
    observedAt: breach.observedAt,
    ...(breach.violationStartedAt ? { violationStartedAt: breach.violationStartedAt } : {}),
    rule: { ...breach.rule }
  };
}

// This class validates the future NDJSON contract without launching a process,
// opening a browser or connecting to a target. Physical execution deliberately
// remains absent until a reviewed driver and OS/network sandbox exist.
export class CapacityProtocolSession {
  constructor({ plan, thresholds }) {
    if (!plan || plan.state !== "PLANNED" || plan.run?.executionEnabled !== false) {
      throw invalid("Protocol self-test requires a disabled physical plan", "PLAN_REQUIRED");
    }
    this.plan = plan;
    this.thresholds = thresholds;
    this.monitor = new StopMonitor(thresholds, {
      runId: plan.run.id,
      earliestObservedAt: plan.run.issuedAt,
      latestObservedAt: new Date(
        Date.parse(plan.run.startDeadlineAt) + plan.scenario.durationSeconds * 1000
      ).toISOString()
    });
    this.result = null;
    this.stopped = null;
    this.finished = false;
  }

  ingest(line) {
    if (this.finished || this.result || this.stopped) {
      throw invalid("Capacity protocol result or stop must be the final event", "DRIVER_PROTOCOL_INVALID");
    }
    if (typeof line !== "string" || Buffer.byteLength(line, "utf8") > MAX_PROTOCOL_LINE_BYTES) {
      throw invalid("Capacity protocol line is invalid or oversized", "DRIVER_PROTOCOL_INVALID");
    }
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      throw invalid("Capacity protocol requires strict NDJSON", "DRIVER_PROTOCOL_INVALID");
    }

    if (event?.type === "sample") {
      const breach = this.monitor.observe(event);
      if (breach) {
        this.stopped = {
          schemaVersion: 1,
          state: "STOPPED",
          planId: this.plan.planId,
          runId: this.plan.run.id,
          certified: false,
          breach: safeBreach(breach),
          note: "A live stop criterion was satisfied; no physical driver was launched by this harness."
        };
      }
      return this.stopped;
    }
    if (event?.type === "result") {
      if (!exactKeys(event, ["type", "evidence"])) {
        throw invalid("Capacity result event schema is closed", "DRIVER_PROTOCOL_INVALID");
      }
      const result = buildReport({ plan: this.plan, evidence: event.evidence, thresholds: this.thresholds });
      if (result.run) {
        const resultStartedAtMs = Date.parse(result.run.startedAt);
        const resultEndedAtMs = Date.parse(result.run.endedAt);
        if (
          (this.monitor.firstObservedAtMs !== null && this.monitor.firstObservedAtMs < resultStartedAtMs) ||
          (this.monitor.lastObservedAtMs !== null && this.monitor.lastObservedAtMs > resultEndedAtMs)
        ) {
          throw invalid("Live samples must fall inside the completed run window", "DRIVER_PROTOCOL_INVALID");
        }
      } else if (this.monitor.firstObservedAtMs !== null) {
        throw invalid("Failed protocol results cannot follow live samples", "DRIVER_PROTOCOL_INVALID");
      }
      this.result = result;
      return this.result;
    }
    throw invalid("Capacity protocol event type is unsupported", "DRIVER_PROTOCOL_INVALID");
  }

  finish() {
    this.finished = true;
    if (this.stopped) return this.stopped;
    if (this.result) return this.result;
    throw invalid("Capacity protocol ended without a result", "DRIVER_RESULT_MISSING");
  }
}
