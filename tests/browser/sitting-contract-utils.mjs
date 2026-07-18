export function summarizeContentionSamples(samples, waypointId = null) {
  const overlapCount = samples.filter(
    (sample) =>
      sample.clients.length === 2 &&
      sample.clients.every((client) => client.localSitting),
  ).length;
  const privateHolderCounts = waypointId
    ? samples.map(
        (sample) =>
          sample.clients.filter(
            (client) =>
              client.reservationState?.current?.waypointId === waypointId,
          ).length,
      )
    : [];
  const clientSkews = samples
    .filter((sample) => sample.clients.length === 2)
    .map((sample) =>
      Math.abs(sample.clients[0].observedAt - sample.clients[1].observedAt),
    );
  const sampleGaps = samples
    .slice(1)
    .map((sample, index) => sample.observedAt - samples[index].observedAt);

  return {
    sampleCount: samples.length,
    overlapCount,
    maxPrivateHolderCount: privateHolderCounts.length
      ? Math.max(...privateHolderCounts)
      : 0,
    maxClientSkewMs: clientSkews.length ? Math.max(...clientSkews) : Infinity,
    maxSampleGapMs: sampleGaps.length ? Math.max(...sampleGaps) : Infinity,
  };
}

export function sittingIntervals(transitions, startAt, stopAt) {
  if (
    !Number.isFinite(startAt) ||
    !Number.isFinite(stopAt) ||
    stopAt < startAt
  ) {
    throw new TypeError("A finite, ordered observation window is required.");
  }

  const ordered = [...(transitions || [])]
    .filter(
      (transition) =>
        Number.isFinite(transition?.at) &&
        typeof transition?.sitting === "boolean",
    )
    .sort((first, second) => first.at - second.at);
  const intervals = [];
  let sitting = false;
  let intervalStart = null;

  for (const transition of ordered) {
    if (transition.at <= startAt) {
      sitting = transition.sitting;
      intervalStart = sitting ? startAt : null;
      continue;
    }
    if (transition.at > stopAt) break;
    if (transition.sitting === sitting) continue;

    if (transition.sitting) {
      sitting = true;
      intervalStart = transition.at;
      continue;
    }

    if (intervalStart !== null && transition.at > intervalStart) {
      intervals.push({
        startAt: intervalStart,
        endAt: transition.at,
        durationMs: transition.at - intervalStart,
      });
    }
    sitting = false;
    intervalStart = null;
  }

  if (sitting && intervalStart !== null && stopAt > intervalStart) {
    intervals.push({
      startAt: intervalStart,
      endAt: stopAt,
      durationMs: stopAt - intervalStart,
    });
  }

  return intervals;
}

export function intersectSittingIntervals(firstIntervals, secondIntervals) {
  const overlaps = [];
  let firstIndex = 0;
  let secondIndex = 0;

  while (
    firstIndex < firstIntervals.length &&
    secondIndex < secondIntervals.length
  ) {
    const first = firstIntervals[firstIndex];
    const second = secondIntervals[secondIndex];
    const startAt = Math.max(first.startAt, second.startAt);
    const endAt = Math.min(first.endAt, second.endAt);
    if (endAt > startAt) {
      overlaps.push({ startAt, endAt, durationMs: endAt - startAt });
    }

    if (first.endAt <= second.endAt) firstIndex += 1;
    if (second.endAt <= first.endAt) secondIndex += 1;
  }

  return overlaps;
}

export function summarizeSittingTransitions(recorders, startAt, stopAt) {
  const intervals = recorders.map((recorder) =>
    sittingIntervals(recorder?.transitions, startAt, stopAt),
  );
  const overlaps =
    intervals.length === 2
      ? intersectSittingIntervals(intervals[0], intervals[1])
      : [];

  return {
    intervals,
    overlaps,
    coherentFinalStates: recorders.map(
      (recorder) =>
        typeof recorder?.recordedSitting === "boolean" &&
        recorder.recordedSitting === recorder.componentSitting,
    ),
    eventMismatchCounts: recorders.map(
      (recorder) => recorder?.eventMismatchCount ?? Number.POSITIVE_INFINITY,
    ),
    componentChangedFinalCoherence: recorders.map((recorder) => {
      const componentChanges = recorder?.componentChanges || [];
      const lastChange = componentChanges.at(-1);
      if (lastChange) return lastChange.sitting === recorder.componentSitting;
      return (recorder?.transitions?.length || 0) <= 1;
    }),
  };
}

export function summarizeReservationPair(states, waypointId) {
  const publicSnapshots = states.map((state) =>
    [...(state?.activeWaypointIds || [])].sort(),
  );
  const holders = states.flatMap((state, clientIndex) =>
    state?.current?.waypointId === waypointId
      ? [{ clientIndex, reservationId: state.current.reservationId }]
      : [],
  );

  return {
    protocol2Supported: states.map(
      (state) => state?.protocol === 2 && state?.supported === true,
    ),
    targetActive: publicSnapshots.map((active) => active.includes(waypointId)),
    publicSnapshots,
    publicSnapshotsCoherent:
      publicSnapshots.length === 2 &&
      JSON.stringify(publicSnapshots[0]) === JSON.stringify(publicSnapshots[1]),
    holders,
  };
}
