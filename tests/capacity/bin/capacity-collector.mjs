#!/usr/bin/env node
import { resolve } from "node:path";
import { CapacityError, invalid } from "../lib/errors.mjs";
import { loadThresholds, readJsonFile } from "../lib/io.mjs";
import { sanitize } from "../lib/sanitize.mjs";
import { validateThresholds } from "../lib/schema.mjs";
import { startPrometheusCollector } from "../lib/server-collector.mjs";

function print(value) {
  process.stdout.write(`${JSON.stringify(sanitize(value))}\n`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--config") throw invalid("collector requires --config FILE", "ARGUMENT_INVALID");
  const config = await readJsonFile(resolve(args[1]), "collector config");
  const thresholds = validateThresholds(await loadThresholds());
  const server = await startPrometheusCollector({ config, thresholds });
  const address = server.address();
  print({
    schemaVersion: 1,
    state: "LISTENING",
    endpoint: `http://127.0.0.1:${address.port}/v1/capacity-sample`,
    prometheusMapping: "validated",
    note: "Loopback adapter is active; it does not generate synthetic samples."
  });
}

main().catch(error => {
  const known = error instanceof CapacityError;
  print({ schemaVersion: 1, state: "INVALID", error: { code: known ? error.code : "COLLECTOR_FAILED" } });
  process.exitCode = 2;
});
