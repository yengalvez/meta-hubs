import { expect, test } from "@playwright/test";
import {
  collectBrowserDiagnostics,
  enterRoom,
  releaseBrowserWaypoint,
  requireSafeBrowserTarget,
} from "./browser-contract-utils.mjs";
import {
  summarizeContentionSamples,
  summarizeReservationPair,
  summarizeSittingTransitions,
} from "./sitting-contract-utils.mjs";

const SITTING_TEST_URL = process.env.SITTING_TEST_URL;
const CONTENTION_SAMPLE_INTERVAL_MS = 25;
const CONTENTION_MAX_CLICK_SKEW_MS = 100;
const CONTENTION_MAX_CLIENT_SKEW_MS = 100;
const CONTENTION_MAX_SAMPLE_GAP_MS = 250;
const CONTENTION_MIN_SAMPLE_COUNT = 20;
const REMOTE_POSITION_TOLERANCE_METERS = 0.75;

async function seatInventory(page) {
  return page.evaluate(() => {
    const getDiagnostics = window.APP?.getSittingWaypointDiagnosticsForTests;
    if (typeof getDiagnostics !== "function") {
      throw new Error("Loader-neutral waypoint diagnostics are unavailable.");
    }
    const diagnostics = getDiagnostics.call(window.APP);
    return {
      loader: diagnostics.loader,
      seats: diagnostics.waypoints
        .filter((waypoint) => waypoint.flags.willDisableMotion)
        .map((waypoint) => ({
          name: waypoint.name,
          position: waypoint.position,
          canBeOccupied: waypoint.flags.canBeOccupied,
          canBeClicked: waypoint.flags.canBeClicked,
          disableMotion: waypoint.flags.willDisableMotion,
          isOccupied: waypoint.occupied,
          waypointId: waypoint.reservationId,
          owner: waypoint.owner,
        })),
    };
  });
}

async function teleportNear(page, position) {
  await page.evaluate((target) => {
    const controller =
      AFRAME.scenes[0].systems["hubs-systems"].characterController;
    controller.teleportTo(
      new THREE.Vector3(target[0] + 0.25, target[1], target[2] + 0.25),
    );
  }, position);
  await page.waitForTimeout(300);
}

async function scheduleSynchronizedSit(page, startAt) {
  await page.evaluate((scheduledAt) => {
    window.__yenhubsSittingAttempt = {
      scheduledAt,
      status: "scheduled",
      clickedAt: null,
    };
    window.setTimeout(
      () => {
        const button = [...document.querySelectorAll("button")].find(
          (candidate) => candidate.textContent?.includes("Sentarse"),
        );
        if (!button) {
          window.__yenhubsSittingAttempt.status = "missing-button";
          return;
        }
        button.click();
        window.__yenhubsSittingAttempt.status = "clicked";
        window.__yenhubsSittingAttempt.clickedAt = Date.now();
      },
      Math.max(0, scheduledAt - Date.now()),
    );
  }, startAt);
}

async function installSittingTransitionRecorder(page) {
  await page.evaluate(() => {
    const rig = document.querySelector("#avatar-rig");
    const scene = window.AFRAME?.scenes?.[0];
    const playerInfo = rig?.components?.["player-info"];
    if (!rig || !scene || !playerInfo) {
      throw new Error(
        "Local sitting transition instrumentation is unavailable.",
      );
    }

    const epochNow = () => performance.timeOrigin + performance.now();
    const initialSitting = !!playerInfo.data.isSitting;
    const recorder = {
      installedAt: epochNow(),
      currentSitting: initialSitting,
      transitions: [],
      componentChanges: [],
      eventMismatchCount: 0,
    };
    recorder.transitions.push({
      at: recorder.installedAt,
      sitting: initialSitting,
      source: "initial",
    });

    // A-Frame throttles componentchanged to 200 ms, so the explicit scene event
    // is the lossless transition source. componentchanged remains a secondary
    // signal and final component state is checked when the recorder is closed.
    const onSittingStateChanged = (event) => {
      const sitting = event?.detail?.isSitting === true;
      const componentSitting =
        !!rig.components?.["player-info"]?.data?.isSitting;
      if (sitting !== componentSitting) recorder.eventMismatchCount += 1;
      if (sitting === recorder.currentSitting) return;
      recorder.currentSitting = sitting;
      recorder.transitions.push({
        at: epochNow(),
        sitting,
        source: "sitting-state-changed",
      });
    };
    const onComponentChanged = (event) => {
      if (event?.detail?.name !== "player-info") return;
      recorder.componentChanges.push({
        at: epochNow(),
        sitting: !!rig.components?.["player-info"]?.data?.isSitting,
      });
    };

    scene.addEventListener("sitting-state-changed", onSittingStateChanged);
    rig.addEventListener("componentchanged", onComponentChanged);
    recorder.dispose = () => {
      scene.removeEventListener("sitting-state-changed", onSittingStateChanged);
      rig.removeEventListener("componentchanged", onComponentChanged);
    };
    window.__yenhubsSittingTransitions = recorder;
  });
}

async function closeSittingTransitionRecorder(page) {
  return page.evaluate(() => {
    const recorder = window.__yenhubsSittingTransitions;
    const rig = document.querySelector("#avatar-rig");
    if (!recorder || !rig?.components?.["player-info"]) {
      throw new Error("Local sitting transition recorder disappeared.");
    }
    recorder.dispose();
    const result = {
      installedAt: recorder.installedAt,
      capturedAt: performance.timeOrigin + performance.now(),
      transitions: [...recorder.transitions],
      componentChanges: [...recorder.componentChanges],
      eventMismatchCount: recorder.eventMismatchCount,
      recordedSitting: recorder.currentSitting,
      componentSitting: !!rig.components["player-info"].data.isSitting,
    };
    delete window.__yenhubsSittingTransitions;
    return result;
  });
}

async function collectSynchronizedContentionSamples(pages, startAt, stopAt) {
  await Promise.all(pages.map(installSittingTransitionRecorder));
  await Promise.all(
    pages.map((page) => scheduleSynchronizedSit(page, startAt)),
  );
  const samples = [];
  const maxSamples =
    Math.ceil((stopAt - Date.now()) / CONTENTION_SAMPLE_INTERVAL_MS) + 10;

  while (Date.now() <= stopAt && samples.length < maxSamples) {
    const cycleStartedAt = Date.now();
    const clients = await Promise.all(
      pages.map((page) =>
        page.evaluate(() => {
          const hubChannel = window.APP?.hubChannel;
          const getReservationState =
            hubChannel?.getWaypointReservationDiagnosticStateForTests;
          if (typeof getReservationState !== "function") {
            throw new Error(
              "Authoritative waypoint-reservation diagnostics are unavailable.",
            );
          }
          return {
            observedAt: Date.now(),
            localSitting:
              !!document.querySelector("#avatar-rig")?.components?.[
                "player-info"
              ]?.data?.isSitting,
            attempt: window.__yenhubsSittingAttempt || null,
            reservationState: getReservationState.call(hubChannel),
          };
        }),
      ),
    );
    samples.push({ observedAt: Date.now(), clients });
    const delay = CONTENTION_SAMPLE_INTERVAL_MS - (Date.now() - cycleStartedAt);
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
  }

  const transitionRecorders = await Promise.all(
    pages.map(closeSittingTransitionRecorder),
  );
  return { samples, transitionRecorders };
}

async function reservationState(page) {
  return page.evaluate(() => {
    const hubChannel = window.APP?.hubChannel;
    const getState = hubChannel?.getWaypointReservationDiagnosticStateForTests;
    if (typeof getState !== "function") {
      throw new Error(
        "Authoritative waypoint-reservation diagnostics are unavailable.",
      );
    }
    return getState.call(hubChannel);
  });
}

async function runtimeState(page, waypointId) {
  return page.evaluate((targetWaypointId) => {
    const getDiagnostics = window.APP?.getSittingWaypointDiagnosticsForTests;
    if (typeof getDiagnostics !== "function") {
      throw new Error("Loader-neutral waypoint diagnostics are unavailable.");
    }
    const seat = getDiagnostics
      .call(window.APP)
      .waypoints.find(
        (waypoint) => waypoint.reservationId === targetWaypointId,
      );
    const rig = document.querySelector("#avatar-rig");
    const worldPosition = new THREE.Vector3();
    rig.object3D.getWorldPosition(worldPosition);
    return {
      clientId: NAF.clientId,
      localSitting: !!rig.components["player-info"].data.isSitting,
      localPosition: worldPosition.toArray(),
      seat: seat
        ? {
            isOccupied: seat.occupied,
            owner: seat.owner,
          }
        : null,
      players: [...document.querySelectorAll("[player-info]")].map((el) => {
        const playerWorldPosition = new THREE.Vector3();
        el.object3D.getWorldPosition(playerWorldPosition);
        return {
          owner: NAF.utils.getNetworkOwner(el),
          isSitting: !!el.components["player-info"].data.isSitting,
          worldPosition: playerWorldPosition.toArray(),
        };
      }),
    };
  }, waypointId);
}

async function nearestStandingWaypoint(page) {
  return page.evaluate(() => {
    const getDiagnostics = window.APP?.getSittingWaypointDiagnosticsForTests;
    if (typeof getDiagnostics !== "function") {
      throw new Error("Loader-neutral waypoint diagnostics are unavailable.");
    }
    const rig = document.querySelector("#avatar-rig");
    const rigPosition = new THREE.Vector3();
    const waypointPosition = new THREE.Vector3();
    rig.object3D.getWorldPosition(rigPosition);

    return getDiagnostics
      .call(window.APP)
      .waypoints.filter(
        (waypoint) =>
          !waypoint.flags.willDisableMotion && !waypoint.flags.canBeOccupied,
      )
      .map((waypoint) => {
        waypointPosition.fromArray(waypoint.position);
        return {
          name: waypoint.name,
          position: waypoint.position,
          distanceSquared: rigPosition.distanceToSquared(waypointPosition),
        };
      })
      .sort((a, b) => a.distanceSquared - b.distanceSquared)[0];
  });
}

function distance(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

test("same-seat contention, remote pose, stand, reclaim and disconnect cleanup", async ({
  browser,
}, testInfo) => {
  const roomUrl = requireSafeBrowserTarget(SITTING_TEST_URL);
  const contexts = [await browser.newContext(), await browser.newContext()];
  const pages = [await contexts[0].newPage(), await contexts[1].newPage()];
  const diagnostics = pages.map(collectBrowserDiagnostics);
  const suffix = String(Date.now()).slice(-7);

  try {
    await Promise.all([
      enterRoom(pages[0], `Seat-A-${suffix}`, roomUrl),
      enterRoom(pages[1], `Seat-B-${suffix}`, roomUrl),
    ]);

    await expect
      .poll(async () => (await runtimeState(pages[0], "")).players.length, {
        timeout: 20_000,
      })
      .toBe(2);

    const inventorySnapshots = await Promise.all(pages.map(seatInventory));
    expect(
      inventorySnapshots.map((inventory) => inventory.loader),
      "both clients exercise the same explicit scene loader",
    ).toEqual([inventorySnapshots[0].loader, inventorySnapshots[0].loader]);
    expect(["classic", "bitecs"]).toContain(inventorySnapshots[0].loader);
    const inventories = inventorySnapshots.map((inventory) => inventory.seats);
    expect(inventories[0].length).toBeGreaterThan(0);
    expect(inventories[0].map((seat) => seat.name)).toEqual(
      inventories[1].map((seat) => seat.name),
    );
    expect(
      inventories[0].map((seat) => seat.waypointId),
      "both clients load the same stable waypoint identities",
    ).toEqual(inventories[1].map((seat) => seat.waypointId));
    for (const seat of inventories[0]) {
      expect(seat.disableMotion, `${seat.name}: Disable motion`).toBe(true);
      expect(
        seat.canBeOccupied,
        `${seat.name}: Can be occupied is required for exclusion`,
      ).toBe(true);
      expect(seat.canBeClicked, `${seat.name}: Clickable contract`).toBe(true);
      expect(
        seat.isOccupied,
        `${seat.name}: test requires an unoccupied room`,
      ).toBe(false);
      expect(
        seat.waypointId,
        `${seat.name}: a stable published network identity is required`,
      ).toEqual(expect.any(String));
      expect(seat.waypointId?.length || 0).toBeGreaterThan(0);
    }
    const waypointIds = inventories[0].map((seat) => seat.waypointId);
    expect(
      new Set(waypointIds).size,
      "every occupiable seat has a unique published waypoint identity",
    ).toBe(waypointIds.length);

    const targetSeat = inventories[0][0];
    const initialReservations = await Promise.all(pages.map(reservationState));
    const initialReservationSummary = summarizeReservationPair(
      initialReservations,
      targetSeat.waypointId,
    );
    expect(
      initialReservationSummary.protocol2Supported,
      "both clients require the authoritative reservation-v2 capability",
    ).toEqual([true, true]);
    expect(initialReservationSummary.targetActive).toEqual([false, false]);
    expect(initialReservationSummary.holders).toEqual([]);
    expect(initialReservations.map((state) => state?.current)).toEqual([
      null,
      null,
    ]);

    await Promise.all(
      pages.map((page) => teleportNear(page, targetSeat.position)),
    );

    const startAt = Date.now() + 1_000;
    const stopAt = startAt + 2_500;
    const { samples: contentionSamples, transitionRecorders } =
      await collectSynchronizedContentionSamples(pages, startAt, stopAt);
    const contentionSummary = summarizeContentionSamples(
      contentionSamples,
      targetSeat.waypointId,
    );
    const transitionSummary = summarizeSittingTransitions(
      transitionRecorders,
      startAt,
      stopAt,
    );

    expect(
      contentionSamples.at(-1)?.clients.map((client) => client.attempt?.status),
      "both scheduled clicks execute during the bounded observation window",
    ).toEqual(["clicked", "clicked"]);
    const clickTimes = contentionSamples
      .at(-1)
      ?.clients.map((client) => client.attempt?.clickedAt);
    const clickSkew = Math.abs(
      (clickTimes?.[0] ?? Number.NaN) - (clickTimes?.[1] ?? Number.NaN),
    );
    expect(
      clickSkew,
      "the two scheduled clicks remain synchronized",
    ).toBeLessThanOrEqual(CONTENTION_MAX_CLICK_SKEW_MS);
    expect(contentionSummary.sampleCount).toBeGreaterThanOrEqual(
      CONTENTION_MIN_SAMPLE_COUNT,
    );
    expect(contentionSummary.maxClientSkewMs).toBeLessThanOrEqual(
      CONTENTION_MAX_CLIENT_SKEW_MS,
    );
    expect(contentionSummary.maxSampleGapMs).toBeLessThanOrEqual(
      CONTENTION_MAX_SAMPLE_GAP_MS,
    );
    expect(
      contentionSummary.overlapCount,
      "bounded synchronized samples corroborate the transition log",
    ).toBe(0);
    expect(
      contentionSummary.maxPrivateHolderCount,
      "no bounded sample contains two private concessions for the same waypoint",
    ).toBeLessThanOrEqual(1);
    expect(
      transitionSummary.coherentFinalStates,
      "each lossless transition recorder agrees with final player-info state",
    ).toEqual([true, true]);
    expect(
      transitionSummary.eventMismatchCounts,
      "every explicit sitting transition agrees with player-info",
    ).toEqual([0, 0]);
    expect(
      transitionSummary.componentChangedFinalCoherence,
      "throttled componentchanged still agrees with final player-info state",
    ).toEqual([true, true]);
    expect(
      transitionSummary.overlaps,
      "epoch-timestamped local sitting intervals never overlap",
    ).toEqual([]);

    const settled = await Promise.all(
      pages.map((page) => runtimeState(page, targetSeat.waypointId)),
    );
    const winnerIndex = settled.findIndex((state) => state.localSitting);
    expect(winnerIndex, "exactly one client wins").toBeGreaterThanOrEqual(0);
    expect(settled.filter((state) => state.localSitting)).toHaveLength(1);
    const loserIndex = 1 - winnerIndex;
    const winnerId = settled[winnerIndex].clientId;
    const reclaimerId = settled[loserIndex].clientId;
    expect(
      transitionSummary.intervals[winnerIndex].length,
      "the winner has a recorded seated interval",
    ).toBeGreaterThan(0);
    expect(
      transitionSummary.intervals[loserIndex],
      "the denied client never enters the seated state",
    ).toEqual([]);

    await expect
      .poll(async () => {
        const states = await Promise.all(pages.map(reservationState));
        const summary = summarizeReservationPair(states, targetSeat.waypointId);
        return {
          protocol2Supported: summary.protocol2Supported,
          targetActive: summary.targetActive,
          publicSnapshotsCoherent: summary.publicSnapshotsCoherent,
          holderIndexes: summary.holders.map((holder) => holder.clientIndex),
        };
      })
      .toEqual({
        protocol2Supported: [true, true],
        targetActive: [true, true],
        publicSnapshotsCoherent: true,
        holderIndexes: [winnerIndex],
      });

    const authoritativeSettled = await Promise.all(pages.map(reservationState));
    const authoritativeSummary = summarizeReservationPair(
      authoritativeSettled,
      targetSeat.waypointId,
    );
    expect(authoritativeSummary.publicSnapshots).toEqual([
      [targetSeat.waypointId],
      [targetSeat.waypointId],
    ]);
    expect(authoritativeSummary.holders).toHaveLength(1);
    expect(
      authoritativeSummary.holders[0].reservationId,
      "the winner has one non-empty private reservation id",
    ).toEqual(expect.any(String));
    expect(
      authoritativeSummary.holders[0].reservationId.length,
    ).toBeGreaterThan(0);
    expect(
      authoritativeSettled[loserIndex].current,
      "the loser receives public occupancy but no private concession",
    ).toBeNull();

    for (const state of settled) {
      expect(state.seat.isOccupied).toBe(true);
      expect(state.seat.owner).toBe(winnerId);
      expect(
        state.players.find((player) => player.owner === winnerId)?.isSitting,
      ).toBe(true);
    }
    expect(
      distance(settled[winnerIndex].localPosition, targetSeat.position),
    ).toBeLessThanOrEqual(0.35);
    const remoteWinner = settled[loserIndex].players.find(
      (player) => player.owner === winnerId,
    );
    expect(
      remoteWinner,
      "the observer has the winner's remote avatar",
    ).toBeTruthy();
    expect(
      distance(remoteWinner.worldPosition, targetSeat.position),
      "the observer sees the remote winner at the seat waypoint",
    ).toBeLessThanOrEqual(REMOTE_POSITION_TOLERANCE_METERS);

    const seatedScreenshot = await pages[loserIndex].screenshot();
    await testInfo.attach("remote-seated-pose.png", {
      body: seatedScreenshot,
      contentType: "image/png",
    });

    const expectedStandingWaypoint = await nearestStandingWaypoint(
      pages[winnerIndex],
    );
    expect(
      expectedStandingWaypoint,
      "a non-seat fallback waypoint exists",
    ).toBeTruthy();
    await pages[winnerIndex]
      .getByRole("button", { name: "Levantarse" })
      .click();
    await expect
      .poll(
        async () =>
          (await runtimeState(pages[loserIndex], targetSeat.waypointId)).seat
            .isOccupied,
      )
      .toBe(false);
    await expect
      .poll(async () => {
        const states = await Promise.all(pages.map(reservationState));
        const summary = summarizeReservationPair(states, targetSeat.waypointId);
        return {
          targetActive: summary.targetActive,
          publicSnapshotsCoherent: summary.publicSnapshotsCoherent,
          holderCount: summary.holders.length,
        };
      })
      .toEqual({
        targetActive: [false, false],
        publicSnapshotsCoherent: true,
        holderCount: 0,
      });

    const standing = await runtimeState(
      pages[winnerIndex],
      targetSeat.waypointId,
    );
    expect(standing.localSitting).toBe(false);
    expect(
      distance(standing.localPosition, expectedStandingWaypoint.position),
    ).toBeLessThanOrEqual(0.75);

    await teleportNear(pages[loserIndex], targetSeat.position);
    await pages[loserIndex].getByRole("button", { name: "Sentarse" }).click();
    await expect
      .poll(
        async () =>
          (await runtimeState(pages[loserIndex], targetSeat.waypointId))
            .localSitting,
      )
      .toBe(true);
    await expect
      .poll(async () => {
        const states = await Promise.all(pages.map(reservationState));
        const summary = summarizeReservationPair(states, targetSeat.waypointId);
        return {
          targetActive: summary.targetActive,
          publicSnapshotsCoherent: summary.publicSnapshotsCoherent,
          holderIndexes: summary.holders.map((holder) => holder.clientIndex),
          previousWinnerCurrent: states[winnerIndex]?.current || null,
        };
      })
      .toEqual({
        targetActive: [true, true],
        publicSnapshotsCoherent: true,
        holderIndexes: [loserIndex],
        previousWinnerCurrent: null,
      });

    await expect
      .poll(async () => {
        const visualStates = await Promise.all(
          pages.map((page) => runtimeState(page, targetSeat.waypointId)),
        );
        return visualStates.map((state) => ({
          seatOccupied: state.seat?.isOccupied === true,
          seatOwner: state.seat?.owner || null,
          reclaimerSitting:
            state.players.find((player) => player.owner === reclaimerId)
              ?.isSitting === true,
        }));
      })
      .toEqual([
        {
          seatOccupied: true,
          seatOwner: reclaimerId,
          reclaimerSitting: true,
        },
        {
          seatOccupied: true,
          seatOwner: reclaimerId,
          reclaimerSitting: true,
        },
      ]);

    const reclaimedVisualStates = await Promise.all(
      pages.map((page) => runtimeState(page, targetSeat.waypointId)),
    );
    const remoteReclaimer = reclaimedVisualStates[winnerIndex].players.find(
      (player) => player.owner === reclaimerId,
    );
    expect(
      remoteReclaimer,
      "the surviving observer sees the reclaimer before disconnect",
    ).toBeTruthy();
    expect(
      distance(remoteReclaimer.worldPosition, targetSeat.position),
      "the surviving observer sees the reclaimer at the seat waypoint",
    ).toBeLessThanOrEqual(REMOTE_POSITION_TOLERANCE_METERS);

    await contexts[loserIndex].close();
    await expect
      .poll(
        async () =>
          (await runtimeState(pages[winnerIndex], targetSeat.waypointId)).seat
            .isOccupied,
        {
          timeout: 2_500,
        },
      )
      .toBe(false);
    await expect
      .poll(async () => {
        const state = await reservationState(pages[winnerIndex]);
        return {
          protocol: state?.protocol,
          supported: state?.supported,
          targetActive: state?.activeWaypointIds?.includes(
            targetSeat.waypointId,
          ),
          current: state?.current || null,
        };
      })
      .toEqual({
        protocol: 2,
        supported: true,
        targetActive: false,
        current: null,
      });
    expect(
      diagnostics.flat(),
      "zero browser warnings, errors and failed requests",
    ).toEqual([]);
  } finally {
    await Promise.all(pages.map(releaseBrowserWaypoint));
    await Promise.all(
      contexts.map((context) => context.close().catch(() => {})),
    );
  }
});
