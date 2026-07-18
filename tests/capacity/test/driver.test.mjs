import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { buildPlan } from "../lib/plan.mjs";
import {
  aggregateCapacityShards,
  collectProcessTreeMetrics,
  collectServerSamples,
  driverContractSummary,
  extendAggregateRawEnvelope,
  installInstrumentation,
  parseCgroupProcessSnapshot,
  parseProcessTreeSnapshot,
  runCapacityDriver,
  validateSharedStopDocument,
  validateHostPreflight,
  writeFailureBundle,
  writeShardBundle,
  writeStoppedBundle
} from "../lib/driver.mjs";
import { BOT_STATE_METRICS, METRIC_CONTRACTS, MODEL_OBSERVATION_METRICS } from "../lib/metric-contracts.mjs";
import { canonicalJson, loadCatalogue, loadThresholds } from "../lib/io.mjs";
import { executionAcknowledgement } from "../lib/safety.mjs";
import { validateCatalogue, validateThresholds } from "../lib/schema.mjs";
import {
  buildTestPlan,
  makePhysicalGeneratorInventory,
  makePassingEvidence,
  makeTestEnvironment,
  promoteFixtureEvidenceToPhysical
} from "../test-support/fixtures.mjs";
import { makeRawSample, rawArtifact } from "../lib/provenance.mjs";
import { trackedCollectorMappingIdentity } from "../lib/collector-contract.mjs";
import { OBSERVABILITY_METRIC_CONTRACTS } from "../lib/observability-contract.mjs";
import { TEST_SIGNER } from "../test-support/trust.mjs";

const scenarios = validateCatalogue(await loadCatalogue());
const thresholds = validateThresholds(await loadThresholds());

function plan(scenarioId = "local-smoke", enabled = false) {
  const scenario = scenarios.get(scenarioId);
  return buildTestPlan({
    scenarios,
    scenarioId,
    target: scenario.roomCount > 1
      ? "https://capacity-staging.example.org/{room}"
      : "http://localhost:4000/test-room",
    botsPerRoom: 0,
    executionEnabled: enabled,
    runId: "11111111-1111-4111-8111-111111111111",
    issuedAt: "2026-07-17T09:55:00.000Z"
  });
}

test("physical driver contract preserves 30/100/300 limits and ten clients per shard", () => {
  const summary = driverContractSummary(plan("total-300"), thresholds);
  assert.equal(summary.implementation, "playwright");
  assert.equal(summary.browserShards, 36);
  assert.equal(summary.maximumClientsPerShard, 10);
  assert.equal(summary.maximumContextsPerHost, 30);
  assert.equal(summary.maximumBrowserProcessesPerHost, 4);
  assert.equal(summary.distributedAggregationRequired, true);
  assert.equal(summary.arbitraryDriverAllowed, false);
  assert.equal(summary.productionAllowed, false);
  assert.equal(summary.movementProof, "bounded-keyboard-input-plus-avatar-rig-displacement");
  assert.ok(summary.requiredServerCollectors.includes("dialog"));
  assert.ok(summary.requiredServerCollectors.includes("coturn"));
  assert.ok(summary.requiredServerMetrics.includes("reticulum.websocketDisconnectRate"));
  assert.ok(summary.requiredServerMetrics.includes("model.usedMemoryMiB"));
  assert.equal(summary.requiredServerMetrics.some(name => name.startsWith("bots.")), true);
});

test("distributed plans require an explicit bounded host and real generator capacity", () => {
  const distributed = plan("total-300");
  const healthy = {
    cpuCount: 8,
    totalMemoryBytes: 16 * 1024 ** 3,
    freeMemoryBytes: 8 * 1024 ** 3
  };
  assert.throws(
    () => validateHostPreflight(distributed, undefined, healthy),
    error => error.code === "DISTRIBUTED_HOST_REQUIRED"
  );
  const host = validateHostPreflight(distributed, "host-001", healthy);
  assert.ok(host.plannedBrowserProcesses <= distributed.executionTopology.maxBrowserProcessesPerHost);
  assert.ok(host.plannedContexts <= distributed.executionTopology.maxContextsPerHost);
  assert.throws(
    () => validateHostPreflight(distributed, "host-001", { ...healthy, freeMemoryBytes: 512 * 1024 ** 2 }),
    error => error.code === "HOST_PREFLIGHT_INSUFFICIENT"
  );
});

test("generator measurements come from the real Node and Chromium process tree", () => {
  const snapshot = parseProcessTreeSnapshot([
    "100 1 5.0 102400 node",
    "101 100 20.0 204800 /Applications/Chromium",
    "102 101 10.0 51200 /Applications/Chromium Helper",
    "999 1 99.0 999999 unrelated"
  ].join("\n"), 100);
  assert.deepEqual(snapshot, {
    source: "ps-process-tree-v1",
    rootPid: 100,
    processCount: 3,
    browserRootProcessCount: 1,
    cpuPercent: 35,
    rssBytes: (102400 + 204800 + 51200) * 1024
  });
});

test("post-STOP proof enumerates the dedicated cgroup instead of trusting process ancestry", () => {
  assert.deepEqual(parseCgroupProcessSnapshot("100\n", 100), {
    liveDescendantCountAfterStop: 0,
    liveBrowserCountAfterStop: 0
  });
  assert.deepEqual(parseCgroupProcessSnapshot("100\n101\n999\n", 100, {
    101: "chromium",
    999: "node-helper"
  }), {
    liveDescendantCountAfterStop: 2,
    liveBrowserCountAfterStop: 1
  });
  assert.throws(
    () => parseCgroupProcessSnapshot("101\n", 100),
    error => error.code === "PHYSICAL_HOST_IDENTITY_INVALID"
  );
});

test("driver source blocks service workers and every effective ICE reconfiguration", async () => {
  const source = await readFile(new URL("../lib/driver.mjs", import.meta.url), "utf8");
  assert.match(source, /serviceWorkers:\s*"block"/);
  assert.match(source, /context\.routeWebSocket/);
  assert.match(source, /BROWSER_HOOK_UNAVAILABLE/);
  assert.match(source, /observedIceServerUrls/);
  assert.match(source, /NativePeerConnection\.prototype\.setConfiguration/);
  assert.match(source, /window\.webkitRTCPeerConnection\s*=\s*GuardedPeerConnection/);
  assert.match(source, /pc\.getConfiguration\(\)/);
  assert.match(source, /effectiveIceServersValid/);
  assert.ok(
    source.indexOf("const effectiveStartAt") < source.indexOf("await import(\"playwright\")"),
    "environment freshness must fail before the browser process starts"
  );
  assert.match(source, /Networked\?\.timestamp|Networked\.timestamp/);
  assert.match(source, /_lastReceivedAt/);
  assert.doesNotMatch(source, /lastOwnerTime/);
});

test("pinned Chromium denies unattested ICE through constructor aliases and setConfiguration", {
  skip: !existsSync(chromium.executablePath())
}, async () => {
  const allowed = "turns:coturn-capacity-staging.example.org:5349";
  const browser = await chromium.launch({ headless: true });
  try {
    const processTree = await collectProcessTreeMetrics();
    assert.equal(processTree.browserRootProcessCount, 1);
    assert.ok(processTree.processCount >= 2);
    assert.ok(processTree.rssBytes > 0);
    const context = await browser.newContext({ serviceWorkers: "block" });
    await installInstrumentation(context, true, [allowed]);
    const page = await context.newPage();
    const proof = await page.evaluate(allowedUrl => {
      const attempt = operation => {
        try {
          operation();
          return "accepted";
        } catch (error) {
          return error.name;
        }
      };
      const constructor = attempt(() => new RTCPeerConnection({
        iceServers: [{ urls: "turns:unattested-staging.example.org:5349" }]
      }));
      const alias = attempt(() => new webkitRTCPeerConnection({
        iceServers: [{ urls: "turns:unattested-staging.example.org:5349" }]
      }));
      const peer = new RTCPeerConnection({
        iceServers: [{ urls: allowedUrl, username: "capacity-test", credential: "capacity-test" }]
      });
      const reconfiguration = attempt(() => peer.setConfiguration({
        iceServers: [{ urls: "turns:unattested-staging.example.org:5349" }]
      }));
      const effective = peer.getConfiguration();
      peer.close();
      return {
        constructor,
        alias,
        reconfiguration,
        aliasesGuarded: webkitRTCPeerConnection === RTCPeerConnection,
        policy: effective.iceTransportPolicy,
        urls: effective.iceServers.flatMap(server =>
          Array.isArray(server.urls) ? server.urls : [server.urls]
        )
      };
    }, allowed);
    assert.deepEqual(proof, {
      constructor: "SecurityError",
      alias: "SecurityError",
      reconfiguration: "SecurityError",
      aliasesGuarded: true,
      policy: "relay",
      urls: [allowed]
    });
    await context.close();
  } finally {
    await browser.close();
  }
});

test("distributed raw retention has one global byte envelope", () => {
  const artifact = bytes => ({ path: "raw.ndjson", sha256: "a".repeat(64), bytes });
  let envelope = { samples: 0, bytes: 0 };
  envelope = extendAggregateRawEnvelope(envelope, artifact(128 * 1024 * 1024));
  envelope = extendAggregateRawEnvelope(envelope, artifact(128 * 1024 * 1024));
  assert.equal(envelope.bytes, 256 * 1024 * 1024);
  assert.throws(
    () => extendAggregateRawEnvelope(envelope, artifact(1)),
    error => error.code === "RAW_ARTIFACT_TOO_LARGE"
  );
});

test("shared terminal stop is exactly plan-bound", () => {
  const distributed = plan("total-300", true);
  const valid = {
    schemaVersion: 1,
    state: "STOPPED",
    planId: distributed.planId,
    runId: distributed.run.id,
    observedAt: "2026-07-17T10:00:00.000Z",
    code: "generator.cpuUtilization",
    hostId: "host-001"
  };
  assert.equal(validateSharedStopDocument(valid, distributed), valid);
  assert.throws(
    () => validateSharedStopDocument({ ...valid, planId: "plan-forged" }, distributed),
    error => error.code === "DISTRIBUTED_STOP_INVALID"
  );
});

test("driver refuses disabled plans before Playwright import, output creation or target access", async () => {
  await assert.rejects(
    () => runCapacityDriver({ plan: plan(), thresholds, collectorEndpoint: "http://localhost:1/never" }),
    error => error.code === "PHYSICAL_EXECUTION_DISABLED"
  );
});

test("direct driver invocation independently requires the exact plan-bound acknowledgement", async () => {
  const enabled = plan("local-smoke", true);
  await assert.rejects(
    () => runCapacityDriver({
      plan: enabled,
      thresholds,
      collectorEndpoint: "http://127.0.0.1:1/never",
      acknowledgement: "not-the-plan-ack",
      allowTestTrust: true
    }),
    error => error.code === "EXECUTION_ACK_INVALID"
  );
  assert.match(executionAcknowledgement(enabled), new RegExp(enabled.planId));
});

test("driver independently hard-denies a forged production room before Playwright import", async () => {
  const unsafe = structuredClone(plan("local-smoke", true));
  unsafe.rooms[0].target = "https://meta-hubs.org/forbidden";
  await assert.rejects(
    () => runCapacityDriver({
      plan: unsafe,
      thresholds,
      collectorEndpoint: "http://127.0.0.1:1/never",
      acknowledgement: "forged",
      allowTestTrust: true
    }),
    error => ["PLAN_INTEGRITY_INVALID", "PLAN_SECURITY_INVALID"].includes(error.code)
  );
});

function collectorForMetric(metric) {
  return (METRIC_CONTRACTS[metric] ?? MODEL_OBSERVATION_METRICS[metric] ?? BOT_STATE_METRICS[metric]).collector;
}

function collectorSemanticProof(metric, value, body, mapping) {
  const metricType = OBSERVABILITY_METRIC_CONTRACTS[metric].metricType;
  const labels = mapping.configuration.seriesInventory[metric][0];
  const common = {
    metricType,
    windowStartedAt: body.observedAt,
    windowEndedAt: body.observedAt,
    resetObserved: false,
    certified: false
  };
  if (["counter", "throughput"].includes(metricType)) {
    assert.equal(value, 0);
    return {
      ...common,
      series: [{
        labels,
        previousObservedAt: body.observedAt,
        currentObservedAt: body.observedAt,
        previous: 0,
        current: 0,
        resets: 0
      }]
    };
  }
  if (metricType === "histogram") {
    assert.equal(value, 0);
    return {
      ...common,
      series: [{
        labels,
        previousObservedAt: body.observedAt,
        currentObservedAt: body.observedAt,
        buckets: [
          { le: 1, previous: 0, current: 0, resets: 0 },
          { le: "+Inf", previous: 0, current: 0, resets: 0 }
        ]
      }]
    };
  }
  if (metricType === "ratio") {
    assert.equal(value, 0);
    return {
      ...common,
      series: [{
        labels,
        previousObservedAt: body.observedAt,
        currentObservedAt: body.observedAt,
        previousNumerator: 0,
        currentNumerator: 0,
        numeratorResets: 0,
        previousDenominator: 0,
        currentDenominator: 0,
        denominatorResets: 0
      }]
    };
  }
  if (metricType === "utilization") {
    return {
      ...common,
      series: [{ labels, currentObservedAt: body.observedAt, numerator: value, denominator: 1 }]
    };
  }
  if (metricType === "authoritativeState") {
    return {
      ...common,
      series: mapping.configuration.seriesInventory[metric].map((identity, index) => ({
        labels: identity,
        currentObservedAt: body.observedAt,
        value: index < value ? 1 : 0
      }))
    };
  }
  return {
    ...common,
    series: [{ labels, currentObservedAt: body.observedAt, value }]
  };
}

async function withCollectorResponse(responseFactory, callback) {
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", chunk => chunks.push(chunk));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const payload = responseFactory(body);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(`${JSON.stringify(payload)}\n`);
    });
  });
  await new Promise(resolveListen => server.listen(0, "127.0.0.1", resolveListen));
  try {
    await callback(`http://127.0.0.1:${server.address().port}/v1/capacity-sample`);
  } finally {
    await new Promise(resolveClose => server.close(resolveClose));
  }
}

test("driver accepts a complete real endpoint response and rejects one missing server metrics", async () => {
  const enabledPlan = plan("local-smoke", true);
  const observedAt = "2026-07-17T10:00:00.000Z";
  const summary = driverContractSummary(enabledPlan, thresholds);
  await withCollectorResponse(body => {
    const mapping = trackedCollectorMappingIdentity();
    const inventorySha256 = createHash("sha256")
      .update(canonicalJson(mapping.configuration.seriesInventory))
      .digest("hex");
    return {
      schemaVersion: 2,
      runId: body.runId,
      observedAt: body.observedAt,
      phase: body.phase,
      mapping,
      samples: summary.requiredServerMetrics.flatMap(metric => {
      const rooms = metric.startsWith("bots.") ? enabledPlan.rooms.map(room => room.id) : ["all"];
        return rooms.map(roomId => {
          const value = metric === "model.nodeCpuMillicores" ? 4000
            : metric === "model.nodeMemoryMiB" ? 8192
              : metric === "model.usedCpuMillicores" ? 1000
                : metric === "model.usedMemoryMiB" ? 2048
                  : 0;
          return {
            collector: collectorForMetric(metric),
            metric,
            value,
            roomId,
            service: collectorForMetric(metric),
            instance: `${collectorForMetric(metric)}-aggregate`,
            sourceMetric: `yenhubs_${metric.replaceAll(".", "_")}`,
            sourceQuerySha256: mapping.configuration.metrics[metric].querySha256,
            sourceObservedAt: body.observedAt,
            inventorySha256,
            semanticProof: collectorSemanticProof(metric, value, body, mapping)
          };
        });
      })
    };
  }, async endpoint => {
    const result = await collectServerSamples({
      endpoint,
      plan: enabledPlan,
      thresholds,
      observedAt,
      phase: "ramp-up",
      runStartedAt: observedAt,
      signal: AbortSignal.timeout(5_000)
    });
    assert.equal(result.samples.length, summary.requiredServerMetrics.length);
    assert.equal(result.mapping.sha256, trackedCollectorMappingIdentity().sha256);
  });

  await withCollectorResponse(body => ({
    schemaVersion: 2,
    runId: body.runId,
    observedAt: body.observedAt,
    phase: body.phase,
    mapping: trackedCollectorMappingIdentity(),
    samples: []
  }), async endpoint => {
    await assert.rejects(
      () => collectServerSamples({
        endpoint,
        plan: enabledPlan,
        thresholds,
        observedAt,
        phase: "ramp-up",
        runStartedAt: observedAt,
        signal: AbortSignal.timeout(5_000)
      }),
      error => error.code === "SERVER_COLLECTOR_MISSING"
    );
  });

  await withCollectorResponse(body => {
    const mapping = trackedCollectorMappingIdentity();
    const changed = mapping.configuration.metrics["dialog.eventLoopLagP95Ms"];
    changed.query = `${changed.query} + 1`;
    changed.querySha256 = createHash("sha256").update(changed.query).digest("hex");
    mapping.sha256 = createHash("sha256").update(canonicalJson(mapping.configuration)).digest("hex");
    return {
      schemaVersion: 2,
      runId: body.runId,
      observedAt: body.observedAt,
      phase: body.phase,
      mapping,
      samples: []
    };
  }, async endpoint => {
    await assert.rejects(
      () => collectServerSamples({
        endpoint,
        plan: enabledPlan,
        thresholds,
        observedAt,
        phase: "ramp-up",
        runStartedAt: observedAt,
        signal: AbortSignal.timeout(5_000)
      }),
      error => error.code === "SERVER_COLLECTOR_INVALID"
    );
  });
});

test("STOP persistence keeps plan, partial raw evidence and a hash manifest", async () => {
  const outputDirectory = await mkdtemp(join(tmpdir(), "capacity-stop-artifacts-"));
  const stoppedPlan = plan("local-smoke", true);
  const observedAt = "2026-07-17T10:00:00.000Z";
  const sample = makeRawSample({
    runId: stoppedPlan.run.id,
    collector: "client",
    metric: "join.failureRate",
    value: 0.02,
    observedAt,
    dimensions: {
      roomId: "room-001", workerId: "worker-001", participantId: "participant-000001",
      service: "hubs-client", instance: "worker-001", clientProfile: "desktop",
      audioMode: "muted", transportMode: "direct", phase: "ramp-up"
    }
  });
  try {
    const manifest = await writeStoppedBundle({
      outputDirectory,
      plan: stoppedPlan,
      rawSamples: [sample],
      stopped: {
        breach: { metric: "join.failureRate", value: 0.02, observedAt }
      },
      collectorMapping: null,
      environment: makeTestEnvironment(),
      signer: TEST_SIGNER
    });
    assert.equal(manifest.state, "STOPPED");
    assert.deepEqual((await readdir(outputDirectory)).sort(), [
      "environment.json", "evidence.json", "harness-tree.json", "manifest.json", "plan.json", "raw.ndjson"
    ]);
    const raw = await readFile(join(outputDirectory, "raw.ndjson"));
    assert.equal(createHash("sha256").update(raw).digest("hex"), manifest.artifacts.raw.sha256);
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
});

test("unexpected failures preserve a signed partial forensic bundle", async () => {
  const outputDirectory = await mkdtemp(join(tmpdir(), "capacity-failed-artifacts-"));
  const failedPlan = plan("local-smoke", true);
  try {
    const manifest = await writeFailureBundle({
      outputDirectory,
      plan: failedPlan,
      rawSamples: [],
      error: Object.assign(new Error("collector failed"), { code: "SERVER_COLLECTOR_FAILED" }),
      collectorMapping: null,
      environment: makeTestEnvironment(),
      signer: TEST_SIGNER
    });
    assert.equal(manifest.state, "FAILED");
    assert.equal(manifest.rawIntegrity.artifact.bytes, 0);
    assert.equal(manifest.signature.keyId, TEST_SIGNER.keyId);
    assert.ok((await readdir(outputDirectory)).includes("manifest.json"));
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
});

test("distributed aggregator requires every planned host and reconstructs one global report", async () => {
  const environment = makeTestEnvironment();
  const distributedPlan = buildTestPlan({
    scenarios,
    scenarioId: "room-100-experimental",
    target: "https://capacity-staging.example.org/room",
    runId: "55555555-5555-4555-8555-555555555555",
    executionEnabled: true,
    environment
  });
  const passing = promoteFixtureEvidenceToPhysical(
    distributedPlan,
    makePassingEvidence(distributedPlan, thresholds)
  );
  const root = await mkdtemp(join(tmpdir(), "capacity-shards-"));
  try {
    const shardManifestPaths = [];
    const allSamples = passing.raw.samples;
    const completeGeneratorInventory = makePhysicalGeneratorInventory(distributedPlan, passing.run);
    for (const [index, host] of distributedPlan.executionTopology.hosts.entries()) {
      const workerIds = new Set(host.workerIds);
      const participantIds = distributedPlan.rooms.flatMap(room => room.workers)
        .filter(worker => workerIds.has(worker.id))
        .flatMap(worker => Array.from({ length: worker.participantCount }, (_, offset) =>
          `participant-${String(worker.participantStart + offset).padStart(6, "0")}`
        ));
      const rawSamples = allSamples.filter(sample =>
        ["client", "webrtc"].includes(sample.collector)
          ? workerIds.has(sample.dimensions.workerId)
          : sample.collector === "generator"
            ? sample.dimensions.instance === host.id
          : index === 0
      );
      const shard = {
        schemaVersion: 1,
        state: "SHARD_COMPLETE",
        certified: false,
        planId: distributedPlan.planId,
        runId: distributedPlan.run.id,
        hostId: host.id,
        workerIds: host.workerIds,
        participantIds,
        collectorLeader: index === 0,
        collectorMapping: index === 0 ? passing.collectorMapping : null,
        generatorPreflight: validateHostPreflight(distributedPlan, host.id, {
          cpuCount: 8,
          totalMemoryBytes: 16 * 1024 ** 3,
          freeMemoryBytes: 8 * 1024 ** 3,
          processTree: {
            source: "ps-process-tree-v1",
            rootPid: 4242 + index,
            processCount: 20,
            browserRootProcessCount: 0,
            cpuPercent: 10,
            rssBytes: 512 * 1024 ** 2
          }
        }, { requireProcessTree: true }),
        run: passing.run,
        rawArtifact: rawArtifact(rawSamples)
      };
      const directory = join(root, host.id);
      await mkdir(directory);
      await writeShardBundle({
        outputDirectory: directory,
        plan: distributedPlan,
        rawSamples,
        shard,
        environment,
        generatorInventory: {
          ...completeGeneratorInventory,
          hosts: [completeGeneratorInventory.hosts[index]]
        },
        signer: TEST_SIGNER
      });
      shardManifestPaths.push(join(directory, "manifest.json"));
    }
    await assert.rejects(
      () => aggregateCapacityShards({
        plan: distributedPlan,
        thresholds,
        shardManifestPaths: shardManifestPaths.slice(1),
        shardRootDirectory: root,
        collectorEndpoint: distributedPlan.security.collectorEndpoints[0],
        acknowledgement: executionAcknowledgement(distributedPlan),
        environment,
        outputDirectory: join(root, "incomplete"),
        signer: TEST_SIGNER,
        allowTestTrust: true
      }),
      error => error.code === "SHARD_SET_INCOMPLETE"
    );
    await assert.rejects(
      () => aggregateCapacityShards({
        plan: distributedPlan,
        thresholds,
        shardManifestPaths,
        shardRootDirectory: root,
        collectorEndpoint: distributedPlan.security.collectorEndpoints[0],
        acknowledgement: executionAcknowledgement(distributedPlan),
        environment,
        outputDirectory: join(root, "untrusted"),
        signer: TEST_SIGNER
      }),
      error => error.code === "SIGNATURE_UNTRUSTED"
    );
    const report = await aggregateCapacityShards({
      plan: distributedPlan,
      thresholds,
      shardManifestPaths,
      shardRootDirectory: root,
      collectorEndpoint: distributedPlan.security.collectorEndpoints[0],
      acknowledgement: executionAcknowledgement(distributedPlan),
      environment,
      outputDirectory: join(root, "aggregate"),
      signer: TEST_SIGNER,
      allowTestTrust: true
    });
    assert.equal(report.state, "PASSED");
    assert.equal(report.totals.participants, 100);
    assert.equal(report.artifactManifest.schemaVersion, 4);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
