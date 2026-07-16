#!/usr/bin/env node
import { resolve } from "node:path";
import { CapacityError, invalid } from "../lib/errors.mjs";
import { loadCatalogue, loadThresholds, readJsonFile } from "../lib/io.mjs";
import { buildCapacityModel } from "../lib/model.mjs";
import { buildPlan } from "../lib/plan.mjs";
import { buildReport } from "../lib/report.mjs";
import { sanitize } from "../lib/sanitize.mjs";
import { getScenario, validateCatalogue, validateThresholds } from "../lib/schema.mjs";

const HELP = `YenHubs capacity harness (Node 22)

Commands:
  validate
  plan   --scenario ID --target URL --bots 0|5|10
  model  --scenario total-10000-model --bots 0|5|10 --input FILE
  report --scenario ID --target URL --bots 0|5|10 --run-id UUID \
         --issued-at ISO_TIMESTAMP --evidence FILE
  run    --scenario ID --target URL --bots 0|5|10

run is always a dry run. Physical execution is disabled until a reviewed driver,
sandbox and destination enforcement exist. There is no default target.`;

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

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (!command || command === "help" || options.help) {
    process.stdout.write(`${HELP}\n`);
    return;
  }
  if (!["validate", "plan", "model", "report", "run"].includes(command)) {
    throw invalid("Unknown command", "COMMAND_INVALID");
  }
  const scenarios = validateCatalogue(await loadCatalogue());
  const thresholds = validateThresholds(await loadThresholds());

  if (command === "validate") {
    if (Object.keys(options).length) throw invalid("validate does not accept options", "ARGUMENT_INVALID");
    print({
      schemaVersion: 1,
      state: "VALID",
      runtime: process.version,
      scenarios: [...scenarios.keys()],
      physicalParticipantLimit: 300,
      botLimitPerRoom: 10,
      physicalExecutionEnabled: false,
      thresholds: { provisional: thresholds.provisional, metrics: Object.keys(thresholds.metrics).length },
      defaultTarget: null
    });
    return;
  }

  const scenario = getScenario(scenarios, options.scenario);
  if (command === "plan") {
    assertAllowedOptions(options, ["scenario", "target", "bots"]);
    print(buildPlan({ scenario, target: options.target, botsPerRoom: parseBots(options.bots) }));
    return;
  }
  if (command === "model") {
    assertAllowedOptions(options, ["scenario", "bots", "input"]);
    if (!options.input) throw invalid("model requires --input", "MODEL_INPUT_REQUIRED");
    const input = await readJsonFile(resolve(options.input), "model input");
    print(buildCapacityModel({ scenario, input, botsPerRoom: parseBots(options.bots) }));
    return;
  }
  if (command === "report") {
    assertAllowedOptions(options, ["scenario", "target", "bots", "run-id", "issued-at", "evidence"]);
    if (!options.evidence) throw invalid("report requires --evidence", "EVIDENCE_REQUIRED");
    if (!options["run-id"] || !options["issued-at"]) {
      throw invalid("report requires the run id and issuedAt from the saved plan", "RUN_ID_INVALID");
    }
    const plan = buildPlan({
      scenario,
      target: options.target,
      botsPerRoom: parseBots(options.bots),
      runId: options["run-id"],
      issuedAt: options["issued-at"]
    });
    const evidence = await readJsonFile(resolve(options.evidence), "capacity evidence");
    print(buildReport({ plan, evidence, thresholds }));
    return;
  }
  if (command === "run") {
    assertAllowedOptions(options, ["scenario", "target", "bots", "execute", "ack-staging", "driver"]);
    if (options.execute || options["ack-staging"] || options.driver) {
      throw invalid(
        "Physical execution is disabled until a reviewed driver and sandbox exist",
        "PHYSICAL_EXECUTION_DISABLED"
      );
    }
    const plan = buildPlan({ scenario, target: options.target, botsPerRoom: parseBots(options.bots) });
    print({
      schemaVersion: 1,
      state: "DRY_RUN",
      execution: false,
      plan,
      requiredCollectors: thresholds.requiredCollectors,
      note: "No load was generated. This repository does not expose physical execution."
    });
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
