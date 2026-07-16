import { invalid } from "./errors.mjs";

const EXPECTED_SCENARIOS = new Set([
  "local-smoke",
  "room-30",
  "room-100-experimental",
  "total-300",
  "total-10000-model"
]);
const MODES = new Set(["physical", "model-only"]);
const AUDIO_PROFILES = new Set(["muted-synthetic", "not-applicable"]);
const MOVEMENT_PROFILES = new Set(["bounded-waypoint-patrol-v1", "not-applicable"]);
const METRIC_UNITS = new Set(["ratio", "count", "ms", "fps", "s"]);

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

function push(errors, condition, path, message) {
  if (!condition) errors.push({ path, message });
}

export function validateCatalogue(catalogue) {
  const errors = [];
  push(errors, catalogue && typeof catalogue === "object", "$", "must be an object");
  if (!catalogue || typeof catalogue !== "object") {
    throw invalid("Scenario catalogue is invalid", "SCHEMA_INVALID", errors);
  }
  push(errors, catalogue.schemaVersion === 1, "$.schemaVersion", "must equal 1");
  push(errors, Array.isArray(catalogue.scenarios), "$.scenarios", "must be an array");

  const seen = new Set();
  for (const [index, scenario] of (catalogue.scenarios ?? []).entries()) {
    const path = `$.scenarios[${index}]`;
    push(errors, scenario && typeof scenario === "object" && !Array.isArray(scenario), path, "must be an object");
    if (!scenario || typeof scenario !== "object" || Array.isArray(scenario)) continue;
    push(errors, typeof scenario.id === "string" && EXPECTED_SCENARIOS.has(scenario.id), `${path}.id`, "is not a required scenario id");
    push(errors, !seen.has(scenario.id), `${path}.id`, "must be unique");
    seen.add(scenario.id);
    push(errors, MODES.has(scenario.mode), `${path}.mode`, "must be physical or model-only");
    push(errors, typeof scenario.classification === "string" && scenario.classification.length > 0, `${path}.classification`, "must be non-empty");
    push(errors, typeof scenario.description === "string" && scenario.description.length >= 20, `${path}.description`, "must describe the scenario");
    push(errors, isPositiveInteger(scenario.totalParticipants), `${path}.totalParticipants`, "must be a positive integer");
    push(errors, isPositiveInteger(scenario.roomCount), `${path}.roomCount`, "must be a positive integer");
    push(errors, isPositiveInteger(scenario.participantsPerRoom), `${path}.participantsPerRoom`, "must be a positive integer");
    push(errors, isPositiveInteger(scenario.participantsPerWorker), `${path}.participantsPerWorker`, "must be a positive integer");
    push(errors, scenario.participantsPerWorker <= scenario.participantsPerRoom, `${path}.participantsPerWorker`, "cannot exceed room size");
    push(
      errors,
      scenario.totalParticipants === scenario.roomCount * scenario.participantsPerRoom,
      `${path}.totalParticipants`,
      "must equal roomCount * participantsPerRoom"
    );
    push(
      errors,
      Array.isArray(scenario.botVariants) &&
        scenario.botVariants.length === 3 &&
        scenario.botVariants.every((value, botIndex) => [0, 5, 10][botIndex] === value),
      `${path}.botVariants`,
      "must be exactly [0, 5, 10]"
    );
    push(errors, (scenario.botVariants ?? []).every(value => Number.isInteger(value) && value >= 0 && value <= 10), `${path}.botVariants`, "bots per room must be within 0..10");
    push(errors, Number.isInteger(scenario.durationSeconds) && scenario.durationSeconds >= 0, `${path}.durationSeconds`, "must be a non-negative integer");
    push(errors, Number.isInteger(scenario.rampUpSeconds) && scenario.rampUpSeconds >= 0, `${path}.rampUpSeconds`, "must be a non-negative integer");
    push(errors, Number.isInteger(scenario.plateauSeconds) && scenario.plateauSeconds >= 0, `${path}.plateauSeconds`, "must be a non-negative integer");
    push(errors, Number.isInteger(scenario.rampDownSeconds) && scenario.rampDownSeconds >= 0, `${path}.rampDownSeconds`, "must be a non-negative integer");
    push(
      errors,
      scenario.durationSeconds === scenario.rampUpSeconds + scenario.plateauSeconds + scenario.rampDownSeconds,
      `${path}.durationSeconds`,
      "must equal rampUpSeconds + plateauSeconds + rampDownSeconds"
    );
    push(errors, MOVEMENT_PROFILES.has(scenario.movementProfile), `${path}.movementProfile`, "is unsupported");
    push(errors, AUDIO_PROFILES.has(scenario.audioProfile), `${path}.audioProfile`, "is unsupported");

    if (scenario.mode === "physical") {
      push(errors, scenario.totalParticipants <= 300, `${path}.totalParticipants`, "physical scenarios are capped at 300");
      push(errors, scenario.durationSeconds > 0, `${path}.durationSeconds`, "physical scenarios require a duration");
      push(errors, scenario.rampUpSeconds > 0, `${path}.rampUpSeconds`, "physical scenarios require a ramp-up");
      push(errors, scenario.plateauSeconds > 0, `${path}.plateauSeconds`, "physical scenarios require a plateau");
      push(errors, scenario.rampDownSeconds > 0, `${path}.rampDownSeconds`, "physical scenarios require a ramp-down");
      push(errors, scenario.movementProfile !== "not-applicable", `${path}.movementProfile`, "physical scenarios require movement");
      push(errors, scenario.audioProfile !== "not-applicable", `${path}.audioProfile`, "physical scenarios require an audio profile");
    } else {
      push(errors, scenario.id === "total-10000-model", `${path}.id`, "only the 10,000 scenario may be model-only");
      push(errors, scenario.durationSeconds === 0, `${path}.durationSeconds`, "model-only duration must be zero");
      push(errors, scenario.rampUpSeconds === 0, `${path}.rampUpSeconds`, "model-only ramp-up must be zero");
      push(errors, scenario.plateauSeconds === 0, `${path}.plateauSeconds`, "model-only plateau must be zero");
      push(errors, scenario.rampDownSeconds === 0, `${path}.rampDownSeconds`, "model-only ramp-down must be zero");
      push(errors, scenario.movementProfile === "not-applicable", `${path}.movementProfile`, "model-only movement must be not-applicable");
      push(errors, scenario.audioProfile === "not-applicable", `${path}.audioProfile`, "model-only audio must be not-applicable");
    }
  }

  for (const id of EXPECTED_SCENARIOS) {
    push(errors, seen.has(id), "$.scenarios", `is missing ${id}`);
  }
  push(errors, seen.size === EXPECTED_SCENARIOS.size, "$.scenarios", "must contain only the five required scenarios");

  if (errors.length) throw invalid("Scenario catalogue is invalid", "SCHEMA_INVALID", errors);
  return new Map(catalogue.scenarios.map(scenario => [scenario.id, Object.freeze({ ...scenario })]));
}

export function validateThresholds(thresholds) {
  const errors = [];
  push(errors, thresholds && typeof thresholds === "object", "$", "must be an object");
  if (!thresholds || typeof thresholds !== "object") {
    throw invalid("Threshold catalogue is invalid", "THRESHOLD_SCHEMA_INVALID", errors);
  }
  push(errors, thresholds.schemaVersion === 1, "$.schemaVersion", "must equal 1");
  push(errors, thresholds.provisional === true, "$.provisional", "must remain true until staging evidence certifies replacements");
  push(
    errors,
    isPositiveInteger(thresholds.maxCollectorIntervalSeconds) && thresholds.maxCollectorIntervalSeconds <= 60,
    "$.maxCollectorIntervalSeconds",
    "must be an integer within 1..60 seconds"
  );
  push(errors, Array.isArray(thresholds.requiredCollectors) && thresholds.requiredCollectors.length > 0, "$.requiredCollectors", "must be non-empty");
  push(errors, new Set(thresholds.requiredCollectors ?? []).size === (thresholds.requiredCollectors ?? []).length, "$.requiredCollectors", "must not contain duplicates");
  push(errors, thresholds.metrics && typeof thresholds.metrics === "object" && !Array.isArray(thresholds.metrics), "$.metrics", "must be an object");

  for (const [metric, rule] of Object.entries(thresholds.metrics ?? {})) {
    const path = `$.metrics.${metric}`;
    push(errors, rule && typeof rule === "object" && !Array.isArray(rule), path, "must be an object");
    if (!rule || typeof rule !== "object") continue;
    const bounds = [Object.hasOwn(rule, "min"), Object.hasOwn(rule, "max")].filter(Boolean).length;
    push(errors, bounds === 1, path, "must contain exactly one min or max bound");
    const bound = rule.min ?? rule.max;
    push(errors, typeof bound === "number" && Number.isFinite(bound), path, "bound must be finite");
    push(errors, METRIC_UNITS.has(rule.unit), `${path}.unit`, "must be a supported physical unit");
    push(errors, typeof bound === "number" && bound >= 0, path, "bound must be non-negative");
    if (rule.unit === "ratio") push(errors, bound <= 1, path, "ratio bound must be within 0..1");
    if (rule.unit === "count") push(errors, Number.isInteger(bound), path, "count bound must be an integer");
    push(errors, rule.stop === true, `${path}.stop`, "must be true for a stop criterion");
    if (Object.hasOwn(rule, "sustainedMs")) {
      push(errors, isPositiveInteger(rule.sustainedMs), `${path}.sustainedMs`, "must be a positive integer");
    }
  }
  push(errors, Object.keys(thresholds.metrics ?? {}).length >= 10, "$.metrics", "must define the complete provisional stop set");

  if (errors.length) throw invalid("Threshold catalogue is invalid", "THRESHOLD_SCHEMA_INVALID", errors);
  return thresholds;
}

export function getScenario(scenarios, id) {
  if (!id || !scenarios.has(id)) {
    throw invalid("A known --scenario is required", "SCENARIO_REQUIRED", { available: [...scenarios.keys()] });
  }
  return scenarios.get(id);
}
