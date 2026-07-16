import { expect, test } from "@playwright/test";
import {
  collectBrowserDiagnostics,
  enterRoom,
  releaseBrowserWaypoint,
  requireSafeBrowserTarget,
} from "./browser-contract-utils.mjs";

const SITTING_TEST_URL = process.env.SITTING_TEST_URL;

async function seatInventory(page) {
  return page.evaluate(() => {
    const vector = new THREE.Vector3();
    return [...document.querySelectorAll("[waypoint]")]
      .filter((el) => el.components?.waypoint?.data?.willDisableMotion)
      .map((el) => {
        el.object3D.updateMatrices();
        el.object3D.getWorldPosition(vector);
        return {
          name: el.object3D.name,
          position: vector.toArray(),
          canBeOccupied: el.components.waypoint.data.canBeOccupied,
          canBeClicked: el.components.waypoint.data.canBeClicked,
          disableMotion: el.components.waypoint.data.willDisableMotion,
          isOccupied: el.components.waypoint.data.isOccupied,
          owner: NAF.utils.getNetworkOwner(el),
        };
      });
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

async function runSynchronizedSit(page, startAt, stopAt) {
  return page.evaluate(
    ({ startAt, stopAt }) =>
      new Promise((resolve) => {
        const samples = [];
        let clicked = false;

        const sample = () => {
          const now = Date.now();
          if (!clicked && now >= startAt) {
            const button = [...document.querySelectorAll("button")].find(
              (candidate) => candidate.textContent?.includes("Sentarse"),
            );
            if (!button)
              throw new Error(
                "Sit button disappeared before the synchronized click.",
              );
            button.click();
            clicked = true;
          }

          const rig = document.querySelector("#avatar-rig");
          samples.push({
            at: now,
            sitting: !!rig?.components?.["player-info"]?.data?.isSitting,
            position: rig?.object3D?.position?.toArray() || null,
          });

          if (now < stopAt) requestAnimationFrame(sample);
          else resolve({ clientId: NAF.clientId, samples });
        };

        requestAnimationFrame(sample);
      }),
    { startAt, stopAt },
  );
}

function simultaneousSittingSamples(first, second) {
  const secondSitting = second.samples.filter((sample) => sample.sitting);
  return first.samples
    .filter((sample) => sample.sitting)
    .filter((sample) =>
      secondSitting.some((other) => Math.abs(other.at - sample.at) <= 12),
    );
}

async function runtimeState(page, seatName) {
  return page.evaluate((name) => {
    const seat = [...document.querySelectorAll("[waypoint]")].find(
      (el) => el.object3D.name === name,
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
            isOccupied: seat.components.waypoint.data.isOccupied,
            owner: NAF.utils.getNetworkOwner(seat),
          }
        : null,
      players: [...document.querySelectorAll("[player-info]")].map((el) => ({
        owner: NAF.utils.getNetworkOwner(el),
        isSitting: !!el.components["player-info"].data.isSitting,
        position: el.object3D.position.toArray(),
      })),
    };
  }, seatName);
}

async function nearestStandingWaypoint(page) {
  return page.evaluate(() => {
    const rig = document.querySelector("#avatar-rig");
    const rigPosition = new THREE.Vector3();
    const waypointPosition = new THREE.Vector3();
    rig.object3D.getWorldPosition(rigPosition);

    return [...document.querySelectorAll("[waypoint]")]
      .filter(
        (el) =>
          !el.components.waypoint.data.willDisableMotion &&
          !el.components.waypoint.data.canBeOccupied,
      )
      .map((el) => {
        el.object3D.updateMatrices();
        el.object3D.getWorldPosition(waypointPosition);
        return {
          name: el.object3D.name,
          position: waypointPosition.toArray(),
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

    const inventories = await Promise.all(pages.map(seatInventory));
    expect(inventories[0].length).toBeGreaterThan(0);
    expect(inventories[0].map((seat) => seat.name)).toEqual(
      inventories[1].map((seat) => seat.name),
    );
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
    }

    const targetSeat = inventories[0][0];
    await Promise.all(
      pages.map((page) => teleportNear(page, targetSeat.position)),
    );

    const startAt = Date.now() + 1_000;
    const stopAt = startAt + 2_500;
    const attempts = await Promise.all(
      pages.map((page) => runSynchronizedSit(page, startAt, stopAt)),
    );

    expect(
      simultaneousSittingSamples(attempts[0], attempts[1]),
      "no overlapping seated frame",
    ).toHaveLength(0);

    const settled = await Promise.all(
      pages.map((page) => runtimeState(page, targetSeat.name)),
    );
    const winnerIndex = settled.findIndex((state) => state.localSitting);
    expect(winnerIndex, "exactly one client wins").toBeGreaterThanOrEqual(0);
    expect(settled.filter((state) => state.localSitting)).toHaveLength(1);
    const loserIndex = 1 - winnerIndex;
    const winnerId = settled[winnerIndex].clientId;

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
          (await runtimeState(pages[loserIndex], targetSeat.name)).seat
            .isOccupied,
      )
      .toBe(false);

    const standing = await runtimeState(pages[winnerIndex], targetSeat.name);
    expect(standing.localSitting).toBe(false);
    expect(
      distance(standing.localPosition, expectedStandingWaypoint.position),
    ).toBeLessThanOrEqual(0.75);

    await teleportNear(pages[loserIndex], targetSeat.position);
    await pages[loserIndex].getByRole("button", { name: "Sentarse" }).click();
    await expect
      .poll(
        async () =>
          (await runtimeState(pages[loserIndex], targetSeat.name)).localSitting,
      )
      .toBe(true);

    await contexts[loserIndex].close();
    await expect
      .poll(
        async () =>
          (await runtimeState(pages[winnerIndex], targetSeat.name)).seat
            .isOccupied,
        {
          timeout: 2_500,
        },
      )
      .toBe(false);
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
