#!/usr/bin/env node
import { dirname, isAbsolute, posix, resolve } from "node:path";
import { CapacityError, invalid } from "../lib/errors.mjs";
import {
  loadCatalogue,
  loadCosts,
  loadThresholds,
  readJsonFile,
  readNdjsonFile,
  resolveContainedPath
} from "../lib/io.mjs";
import { buildCapacityModel, loadModelManifest } from "../lib/model.mjs";
import { buildPlan } from "../lib/plan.mjs";
import { buildReport } from "../lib/report.mjs";
import { sanitize } from "../lib/sanitize.mjs";
import { assertExecutionSafety, executionAcknowledgement } from "../lib/safety.mjs";
import { aggregateCapacityShards, driverContractSummary, runCapacityDriver } from "../lib/driver.mjs";
import { validatePlan } from "../lib/plan-contract.mjs";
import { getScenario, validateCatalogue, validateThresholds } from "../lib/schema.mjs";
import { trackedTrustSummary } from "../lib/trust.mjs";
import { trackedPhysicalReadinessSummary } from "../lib/physical-readiness.mjs";

const HELP = `YenHubs capacity harness (Node 22)

Commands:
  validate
  plan   --scenario ID --target URL --bots 0|5|10 [profile options]
         [--environment FILE --attestation FILE --execution-enabled true]
  ack    --plan FILE
  worker --plan FILE --worker-host HOST --start-at ISO_TIMESTAMP
         --ack-staging EXACT_TEXT --collector-endpoint URL --environment FILE
         --stop-control SHARED_FILE
  aggregate --plan FILE --shards FILE --ack-staging EXACT_TEXT
            --collector-endpoint URL --environment FILE --output DIRECTORY
  model  --scenario total-10000-model --bots 0|5|10 --input FILE
  report --plan FILE --evidence FILE --raw RAW_NDJSON_FILE
  run    --scenario ID --target URL --bots 0|5|10 [profile options]
  run    --plan FILE --execute --ack-staging EXACT_TEXT
         --collector-endpoint URL --environment FILE

Profile options: --client desktop|mobile --audio muted|active
                 --transport direct|forced-turn

run defaults to dry/fail-closed. Execution consumes one previously saved,
execution-enabled plan and uses only the checked-in Playwright driver. It
requires an exact plan-bound acknowledgement and complete server collector.
Production targets remain hard-denied. There is no default target.`;

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith("--")) throw invalid("Unexpected positional argument", "ARGUMENT_INVALID");
    const key = token.slice(2);
    if (key === "execute" || key === "help") {
      options[key] = true;
      continue;
    }
    if (index + 1 >= rest.length || rest[index + 1].startsWith("--")) {
      throw invalid(`--${key} requires a value`, "ARGUMENT_INVALID");
    }
    if (Object.hasOwn(options, key)) throw invalid(`--${key} was supplied more than once`, "ARGUMENT_INVALID");
    options[key] = rest[++index];
  }
  return { command, options };
}

function parseBots(value) {
  if (value === undefined || !/^\d+$/.test(value)) {
    throw invalid("--bots is required and must be 0, 5 or 10", "BOT_COUNT_INVALID");
  }
  return Number(value);
}

function print(value) {
  process.stdout.write(`${JSON.stringify(sanitize(value), null, 2)}\n`);
}

function assertAllowedOptions(options, allowed) {
  if (Object.keys(options).some(key => !allowed.includes(key))) {
    throw invalid("Command received unsupported options", "ARGUMENT_INVALID");
  }
}

function planProfiles(options) {
  return {
    clientProfile: options.client ?? "desktop",
    audioMode: options.audio ?? "muted",
    transportMode: options.transport ?? "direct"
  };
}

async function planAttestation(options) {
  return options.attestation
    ? await readJsonFile(resolve(options.attestation), "capacity remote attestation")
    : undefined;
}

async function planEnvironment(options) {
  return options.environment
    ? await readJsonFile(resolve(options.environment), "signed capacity environment snapshot")
    : undefined;
}

function strictRelativeManifestPath(path) {
  return typeof path === "string" && path.length > 0 && path.length <= 256 && !isAbsolute(path) &&
    !path.includes("\\") && posix.normalize(path) === path &&
    path.split("/").every(segment => /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(segment));
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (!command || command === "help" || options.help) {
    process.stdout.write(`${HELP}\n`);
    return;
  }
  if (!["validate", "plan", "ack", "worker", "aggregate", "model", "report", "run"].includes(command)) {
    throw invalid("Unknown command", "COMMAND_INVALID");
  }
  const scenarios = validateCatalogue(await loadCatalogue());
  const thresholds = validateThresholds(await loadThresholds());

  if (command === "ack") {
    assertAllowedOptions(options, ["plan"]);
    if (!options.plan) throw invalid("ack requires --plan", "PLAN_REQUIRED");
    const plan = validatePlan(await readJsonFile(resolve(options.plan), "capacity plan"), {
      requireExecutionEnabled: true,
      productionOnly: true
    });
    print({ schemaVersion: 1, planId: plan.planId, acknowledgement: executionAcknowledgement(plan) });
    return;
  }

  if (command === "worker") {
    assertAllowedOptions(options, ["plan", "worker-host", "start-at", "ack-staging", "collector-endpoint", "environment", "stop-control"]);
    for (const required of ["plan", "worker-host", "start-at", "collector-endpoint", "environment", "stop-control"]) {
      if (!options[required]) throw invalid(`worker requires --${required}`, "ARGUMENT_INVALID");
    }
    const plan = validatePlan(await readJsonFile(resolve(options.plan), "capacity plan"), {
      requireExecutionEnabled: true,
      productionOnly: true
    });
    const result = await runCapacityDriver({
      plan,
      thresholds,
      collectorEndpoint: options["collector-endpoint"],
      acknowledgement: options["ack-staging"],
      workerHostId: options["worker-host"],
      startAt: options["start-at"],
      environment: await readJsonFile(resolve(options.environment), "capacity environment snapshot"),
      sharedStopFile: resolve(options["stop-control"])
    });
    print(result);
    if (result.state === "STOPPED") process.exitCode = 3;
    return;
  }

  if (command === "aggregate") {
    assertAllowedOptions(options, ["plan", "shards", "ack-staging", "collector-endpoint", "environment", "output"]);
    for (const required of ["plan", "shards", "collector-endpoint", "environment", "output"]) {
      if (!options[required]) throw invalid(`aggregate requires --${required}`, "ARGUMENT_INVALID");
    }
    const plan = validatePlan(await readJsonFile(resolve(options.plan), "capacity plan"), {
      requireExecutionEnabled: true,
      productionOnly: true
    });
    const shardListPath = resolve(options.shards);
    const shardList = await readJsonFile(shardListPath, "capacity shard list");
    if (!shardList || Object.keys(shardList).sort().join(",") !== "planId,schemaVersion,shards" ||
        shardList.schemaVersion !== 1 || shardList.planId !== plan.planId || !Array.isArray(shardList.shards) ||
        shardList.shards.some(path => !strictRelativeManifestPath(path))) {
      throw invalid("Shard list schema is closed and plan-bound", "SHARD_SET_INCOMPLETE");
    }
    const shardRootDirectory = dirname(shardListPath);
    const shardManifestPaths = [];
    for (const path of shardList.shards) {
      shardManifestPaths.push(await resolveContainedPath(shardRootDirectory, path, "shard manifest"));
    }
    const result = await aggregateCapacityShards({
      plan,
      thresholds,
      shardManifestPaths,
      shardRootDirectory,
      collectorEndpoint: options["collector-endpoint"],
      acknowledgement: options["ack-staging"],
      environment: await readJsonFile(resolve(options.environment), "capacity environment snapshot"),
      outputDirectory: resolve(options.output)
    });
    print(result);
    if (result.state === "STOPPED") process.exitCode = 3;
    return;
  }

  if (command === "validate") {
    if (Object.keys(options).length) throw invalid("validate does not accept options", "ARGUMENT_INVALID");
    const trust = trackedTrustSummary();
    const readiness = trackedPhysicalReadinessSummary();
    print({
      schemaVersion: 1,
      state: "VALID",
      runtime: process.version,
      scenarios: [...scenarios.keys()],
      harnessSafetyCeilings: {
        note: "These are fail-safe test bounds, not measured capacity.",
        physicalParticipants: 300,
        botsPerRoom: 10,
        generatorContexts: 30,
        generatorBrowserProcesses: 4
      },
      physicalExecutionDefault: false,
      physicalExecutionTrustReady: trust.anchors.length > 0 && readiness.state === "READY" &&
        readiness.observabilityContract.state === "READY",
      physicalExecutionAllowed: false,
      certified: false,
      physicalReadiness: readiness,
      productionTrust: trust,
      checkedInPlaywrightDriver: true,
      thresholds: { provisional: thresholds.provisional, metrics: Object.keys(thresholds.metrics).length },
      defaultTarget: null
    });
    return;
  }

  if (command === "report") {
    assertAllowedOptions(options, ["plan", "evidence", "raw"]);
    for (const required of ["plan", "evidence", "raw"]) {
      if (!options[required]) throw invalid(`report requires --${required}`, "ARGUMENT_INVALID");
    }
    const plan = validatePlan(await readJsonFile(resolve(options.plan), "capacity plan"), { productionOnly: true });
    const evidence = await readJsonFile(resolve(options.evidence), "capacity evidence");
    const rawSamples = await readNdjsonFile(resolve(options.raw), "capacity raw evidence");
    const result = buildReport({ plan, evidence, thresholds, rawSamples });
    print(result);
    if (result.state === "STOPPED") process.exitCode = 3;
    return;
  }

  if (command === "plan") {
    assertAllowedOptions(options, [
      "scenario", "target", "bots", "client", "audio", "transport", "attestation", "execution-enabled",
      "environment"
    ]);
    if (options["execution-enabled"] !== undefined && options["execution-enabled"] !== "true") {
      throw invalid("--execution-enabled, when present, must equal true", "ARGUMENT_INVALID");
    }
    const scenario = getScenario(scenarios, options.scenario);
    print(buildPlan({
      scenario,
      target: options.target,
      botsPerRoom: parseBots(options.bots),
      ...planProfiles(options),
      attestation: await planAttestation(options),
      environment: await planEnvironment(options),
      executionEnabled: options["execution-enabled"] === "true"
    }));
    return;
  }
  if (command === "model") {
    assertAllowedOptions(options, ["scenario", "bots", "input"]);
    if (!options.input) throw invalid("model requires --input", "MODEL_INPUT_REQUIRED");
    const scenario = getScenario(scenarios, options.scenario);
    const input = await loadModelManifest(resolve(options.input));
    print(buildCapacityModel({
      scenario,
      input,
      botsPerRoom: parseBots(options.bots),
      costs: await loadCosts(),
      thresholds
    }));
    return;
  }
  if (command === "run") {
    assertAllowedOptions(options, [
      "scenario", "target", "bots", "client", "audio", "transport", "attestation",
      "plan", "execute", "ack-staging", "collector-endpoint", "worker-host", "environment", "start-at", "stop-control"
    ]);
    const executionEnabled = options.execute === true;
    if (!executionEnabled) {
      if (options.plan || options["ack-staging"] || options["collector-endpoint"] ||
          options["worker-host"] || options["start-at"] || options["stop-control"]) {
        throw invalid("Saved plans and execution inputs require --execute", "ARGUMENT_INVALID");
      }
      const scenario = getScenario(scenarios, options.scenario);
      const plan = buildPlan({
        scenario,
        target: options.target,
        botsPerRoom: parseBots(options.bots),
        ...planProfiles(options),
        attestation: await planAttestation(options),
        environment: await planEnvironment(options),
        executionEnabled: false
      });
      print({
        schemaVersion: 1,
        state: "DRY_RUN",
        execution: false,
        plan,
        acknowledgementRequiredForExecution: null,
        driver: driverContractSummary(plan, thresholds),
        note: "No load was generated. Execution requires --execute and all closed safety inputs."
      });
      return;
    }
    if (!options.plan) throw invalid("Execution requires one saved --plan", "PLAN_REQUIRED");
    if (["scenario", "target", "bots", "client", "audio", "transport", "attestation"]
      .some(key => options[key] !== undefined)) {
      throw invalid("Execution identity comes only from the saved plan", "ARGUMENT_INVALID");
    }
    const plan = validatePlan(await readJsonFile(resolve(options.plan), "capacity plan"), {
      requireExecutionEnabled: true,
      productionOnly: true
    });
    if (plan.executionTopology.mode === "distributed-workers") {
      throw invalid("Distributed plans must use one saved plan with worker and aggregate", "DISTRIBUTED_WORKER_COMMAND_REQUIRED");
    }
    const safety = assertExecutionSafety({
      plan,
      acknowledgement: options["ack-staging"],
      collectorEndpoint: options["collector-endpoint"]
    });
    if (!options.environment) {
      throw invalid("Physical execution requires a reviewed environment snapshot", "ENVIRONMENT_EVIDENCE_REQUIRED");
    }
    const result = await runCapacityDriver({
      plan,
      thresholds,
      collectorEndpoint: safety.collectorEndpoint,
      acknowledgement: safety.acknowledgement,
      workerHostId: options["worker-host"],
      startAt: options["start-at"],
      environment: await readJsonFile(resolve(options.environment), "capacity environment snapshot"),
      sharedStopFile: options["stop-control"] ? resolve(options["stop-control"]) : undefined
    });
    print(result);
    if (result.state === "STOPPED") process.exitCode = 3;
  }
}

main().catch(error => {
  const known = error instanceof CapacityError;
  const state = known ? error.state : "FAILED";
  print({
    schemaVersion: 1,
    state,
    error: {
      code: known ? error.code : "UNEXPECTED_ERROR",
      message: known ? error.message : "Unexpected harness failure"
    }
  });
  process.exitCode = state === "STOPPED" ? 3 : state === "INVALID" ? 2 : 1;
});
