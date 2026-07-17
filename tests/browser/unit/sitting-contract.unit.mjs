import assert from "node:assert/strict";
import test from "node:test";

import {
  intersectSittingIntervals,
  sittingIntervals,
  summarizeContentionSamples,
  summarizeReservationPair,
  summarizeSittingTransitions,
} from "../sitting-contract-utils.mjs";

test("summarizes bounded synchronized observations without claiming frame coverage", () => {
  const summary = summarizeContentionSamples(
    [
      {
        observedAt: 100,
        clients: [
          { observedAt: 98, localSitting: false, reservationState: null },
          { observedAt: 101, localSitting: false, reservationState: null },
        ],
      },
      {
        observedAt: 125,
        clients: [
          {
            observedAt: 122,
            localSitting: true,
            reservationState: {
              current: { waypointId: "seat-a", reservationId: "first" },
            },
          },
          { observedAt: 126, localSitting: false, reservationState: null },
        ],
      },
      {
        observedAt: 151,
        clients: [
          {
            observedAt: 148,
            localSitting: true,
            reservationState: {
              current: { waypointId: "seat-a", reservationId: "first" },
            },
          },
          {
            observedAt: 151,
            localSitting: true,
            reservationState: {
              current: { waypointId: "seat-a", reservationId: "second" },
            },
          },
        ],
      },
    ],
    "seat-a",
  );

  assert.equal(summary.sampleCount, 3);
  assert.equal(summary.overlapCount, 1);
  assert.equal(summary.maxPrivateHolderCount, 2);
  assert.equal(summary.maxClientSkewMs, 4);
  assert.equal(summary.maxSampleGapMs, 26);
});

test("summarizes one private concession and coherent public snapshots", () => {
  const summary = summarizeReservationPair(
    [
      {
        protocol: 1,
        supported: true,
        activeWaypointIds: ["seat-b", "seat-a"],
        current: { waypointId: "seat-a", reservationId: "reservation-a" },
      },
      {
        protocol: 1,
        supported: true,
        activeWaypointIds: ["seat-a", "seat-b"],
        current: null,
      },
    ],
    "seat-a",
  );

  assert.deepEqual(summary.protocol1Supported, [true, true]);
  assert.deepEqual(summary.targetActive, [true, true]);
  assert.equal(summary.publicSnapshotsCoherent, true);
  assert.deepEqual(summary.holders, [
    { clientIndex: 0, reservationId: "reservation-a" },
  ]);
});

test("does not mistake a public occupied marker for a private concession", () => {
  const summary = summarizeReservationPair(
    [
      {
        protocol: 1,
        supported: true,
        activeWaypointIds: ["seat-a"],
        current: null,
      },
      {
        protocol: 1,
        supported: true,
        activeWaypointIds: ["seat-a"],
        current: null,
      },
    ],
    "seat-a",
  );

  assert.deepEqual(summary.targetActive, [true, true]);
  assert.deepEqual(summary.holders, []);
});

test("transition intervals expose a short overlap that bounded samples miss", () => {
  const recorders = [0, 1].map(() => ({
    transitions: [
      { at: 90, sitting: false },
      { at: 101, sitting: true },
      { at: 118, sitting: false },
    ],
    recordedSitting: false,
    componentSitting: false,
    eventMismatchCount: 0,
    componentChanges: [{ at: 120, sitting: false }],
  }));
  const transitionSummary = summarizeSittingTransitions(recorders, 100, 125);
  const sampledSummary = summarizeContentionSamples([
    {
      observedAt: 100,
      clients: [
        { observedAt: 100, localSitting: false },
        { observedAt: 100, localSitting: false },
      ],
    },
    {
      observedAt: 125,
      clients: [
        { observedAt: 125, localSitting: false },
        { observedAt: 125, localSitting: false },
      ],
    },
  ]);

  assert.equal(sampledSummary.overlapCount, 0);
  assert.deepEqual(transitionSummary.overlaps, [
    { startAt: 101, endAt: 118, durationMs: 17 },
  ]);
  assert.deepEqual(transitionSummary.coherentFinalStates, [true, true]);
  assert.deepEqual(transitionSummary.eventMismatchCounts, [0, 0]);
  assert.deepEqual(transitionSummary.componentChangedFinalCoherence, [
    true,
    true,
  ]);
});

test("interval construction clips to the window and treats a handoff boundary as non-overlap", () => {
  const first = sittingIntervals(
    [
      { at: 80, sitting: true },
      { at: 115, sitting: false },
    ],
    100,
    130,
  );
  const second = sittingIntervals(
    [
      { at: 90, sitting: false },
      { at: 115, sitting: true },
      { at: 150, sitting: false },
    ],
    100,
    130,
  );

  assert.deepEqual(first, [{ startAt: 100, endAt: 115, durationMs: 15 }]);
  assert.deepEqual(second, [{ startAt: 115, endAt: 130, durationMs: 15 }]);
  assert.deepEqual(intersectSittingIntervals(first, second), []);
});

test("transition summary reports recorder/component divergence", () => {
  const summary = summarizeSittingTransitions(
    [
      {
        transitions: [{ at: 90, sitting: false }],
        recordedSitting: true,
        componentSitting: false,
        eventMismatchCount: 1,
        componentChanges: [],
      },
      {
        transitions: [{ at: 90, sitting: false }],
        recordedSitting: false,
        componentSitting: false,
        eventMismatchCount: 0,
        componentChanges: [],
      },
    ],
    100,
    125,
  );

  assert.deepEqual(summary.coherentFinalStates, [false, true]);
  assert.deepEqual(summary.eventMismatchCounts, [1, 0]);
  assert.deepEqual(summary.componentChangedFinalCoherence, [true, true]);
});
