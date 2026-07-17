const contract = (collector, aggregation, sampling = "interval") =>
  Object.freeze({ collector, aggregation, sampling });

export const PARTICIPANT_JOIN_METRICS = Object.freeze([
  "join.failureRate",
  "join.lobbyP95Ms",
  "join.sceneP95Ms"
]);

// These Prometheus sources are cumulative counters. The tracked collector
// converts them into conservative per-interval increases before they enter raw
// evidence. Reports retain every interval snapshot and take the maximum: every
// threshold is zero, so one non-zero interval is sufficient to stop without
// summing overlapping or cumulative snapshots.
export const PROMETHEUS_COUNTER_METRICS = Object.freeze([
  "reticulum.errorCount",
  "runtime.oomCount",
  "runtime.evictionCount",
  "runtime.workerDeathCount",
  "runtime.restartCount",
  "network.loadBalancerDropCount",
  "database.deadlockCount",
  "dialog.errorCount",
  "bots.navmeshFailureCount",
  "bots.errorCount"
]);

// Every threshold aggregate has one authoritative raw collector and one
// deterministic aggregation. The report builder refuses catalogues that drift
// from this closed map.
export const METRIC_CONTRACTS = Object.freeze({
  "join.failureRate": contract("client", "mean", "event"),
  "join.lobbyP95Ms": contract("client", "p95", "event"),
  "join.sceneP95Ms": contract("client", "p95", "event"),
  "client.consoleErrorCount": contract("client", "sum"),
  "client.consoleWarningCount": contract("client", "sum"),
  "client.fpsP10": contract("client", "p10"),
  "client.disconnectRate": contract("client", "mean"),
  "client.httpRequestFailureCount": contract("client", "sum"),
  "client.httpStatusErrorCount": contract("client", "sum"),
  "client.websocketConcurrentCount": contract("client", "max"),
  "network.clientReceiveBytesPerSecond": contract("client", "max"),
  "network.clientSendBytesPerSecond": contract("webrtc", "max"),
  "webrtc.packetLossP95": contract("webrtc", "p95"),
  "webrtc.rttP95Ms": contract("webrtc", "p95"),
  "webrtc.audioFailureRate": contract("webrtc", "mean"),
  "avatar.networkUpdateGapP95Ms": contract("client", "p95"),
  "reticulum.websocketDisconnectRate": contract("reticulum", "max"),
  "reticulum.channelJoinP95Ms": contract("reticulum", "p95"),
  "reticulum.errorCount": contract("reticulum", "max"),
  "kubernetes.cpuUtilization": contract("kubernetes", "max"),
  "kubernetes.memoryUtilization": contract("kubernetes", "max"),
  "kubernetes.podMemoryLimitUtilization": contract("kubernetes", "max"),
  "runtime.oomCount": contract("kubernetes", "max"),
  "runtime.evictionCount": contract("kubernetes", "max"),
  "runtime.workerDeathCount": contract("kubernetes", "max"),
  "runtime.restartCount": contract("kubernetes", "max"),
  "runtime.notReadySeconds": contract("kubernetes", "max"),
  "network.loadBalancer5xxRate": contract("load-balancer", "max"),
  "network.loadBalancerDropCount": contract("load-balancer", "max"),
  "network.loadBalancerP95Ms": contract("load-balancer", "p95"),
  "network.loadBalancerRequestRate": contract("load-balancer", "max"),
  "database.connectionUtilizationP95": contract("database", "p95"),
  "database.poolUtilizationP95": contract("database", "p95"),
  "database.queryP95Ms": contract("database", "p95"),
  "database.poolWaitP95Ms": contract("database", "p95"),
  "database.deadlockCount": contract("database", "max"),
  "coturn.allocationFailureRate": contract("coturn", "max"),
  "coturn.relayFailureRate": contract("coturn", "max"),
  "coturn.trafficBytesPerSecond": contract("coturn", "max"),
  "dialog.workerSaturationP95": contract("dialog", "p95"),
  "dialog.eventLoopLagP95Ms": contract("dialog", "p95"),
  "dialog.errorCount": contract("dialog", "max"),
  "dialog.trafficMessagesPerSecond": contract("dialog", "max"),
  "generator.cpuUtilization": contract("generator", "max"),
  "generator.memoryUtilization": contract("generator", "max"),
  "generator.rssMiB": contract("generator", "max"),
  "generator.eventLoopLagP95Ms": contract("generator", "p95"),
  "generator.browserProcessCount": contract("generator", "max"),
  "generator.processCount": contract("generator", "max"),
  "bots.appearanceP95Ms": contract("bots", "p95"),
  "bots.navmeshFailureCount": contract("bots", "max"),
  "bots.errorCount": contract("bots", "max")
});

export const PROFILE_METRICS = Object.freeze({
  "client.profileMobile": contract("client", "latest", "event"),
  "client.audioTrackActive": contract("client", "latest", "event"),
  "webrtc.selectedCandidateRelay": contract("webrtc", "latest", "event"),
  "webrtc.iceServerAttestationValid": contract("webrtc", "latest", "event")
});

export const PARTICIPANT_EVIDENCE_METRICS = Object.freeze({
  "client.lobbyJoined": contract("client", "latest", "event"),
  "client.roomJoined": contract("client", "latest", "event"),
  "client.lobbyPresenceSeconds": contract("client", "latest", "event"),
  "client.plateauPresenceSeconds": contract("client", "latest", "event"),
  "client.plateauSampleCount": contract("client", "latest", "event"),
  "client.finalUrlMatched": contract("client", "latest", "event"),
  "client.movementActionCount": contract("client", "latest", "event")
});

export const PHASE_EVENT_METRICS = Object.freeze({
  "phase.lobby.join": contract("client", "sum", "event"),
  "phase.lobby.leave": contract("client", "sum", "event"),
  "phase.room.join": contract("client", "sum", "event"),
  "phase.room.leave": contract("client", "sum", "event")
});

export const BOT_STATE_METRICS = Object.freeze({
  "bots.state.desired": contract("bots", "latest"),
  "bots.state.active": contract("bots", "latest"),
  "bots.state.authenticated": contract("bots", "latest"),
  "bots.state.spawnAck": contract("bots", "latest"),
  "bots.state.navmeshReady": contract("bots", "latest")
});

export const MODEL_OBSERVATION_METRICS = Object.freeze({
  "model.nodeCpuMillicores": contract("kubernetes", "p95"),
  "model.nodeMemoryMiB": contract("kubernetes", "p95"),
  "model.usedCpuMillicores": contract("kubernetes", "p95"),
  "model.usedMemoryMiB": contract("kubernetes", "p95")
});

export function expectedThresholdMetrics(plan, thresholds) {
  return Object.keys(thresholds.metrics);
}

export function expectedCollectors(plan, thresholds) {
  return [...thresholds.requiredCollectors];
}

export function requiredRawContracts(plan, thresholds) {
  const result = {};
  for (const name of expectedThresholdMetrics(plan, thresholds)) result[name] = METRIC_CONTRACTS[name];
  Object.assign(result, PROFILE_METRICS, MODEL_OBSERVATION_METRICS);
  Object.assign(result, PARTICIPANT_EVIDENCE_METRICS, PHASE_EVENT_METRICS, BOT_STATE_METRICS);
  return result;
}
