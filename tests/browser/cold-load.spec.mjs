import { expect, test } from "@playwright/test";
import {
  collectBrowserDiagnostics,
  enterRoom,
  releaseBrowserWaypoint,
  requireSafeBrowserTarget,
} from "./browser-contract-utils.mjs";

const COLD_LOAD_TEST_URL = process.env.COLD_LOAD_TEST_URL;

function expectedBotCount() {
  const raw = process.env.BROWSER_EXPECTED_BOTS;
  if (!/^(0|[1-9][0-9]*)$/.test(raw || "")) {
    throw new Error(
      "BROWSER_EXPECTED_BOTS is required and must be a non-negative integer.",
    );
  }
  return Number(raw);
}

test("cold browser initializes APP, AFRAME, scene, reservation protocol and expected bots", async ({
  page,
}, testInfo) => {
  const target = requireSafeBrowserTarget(COLD_LOAD_TEST_URL);
  const bots = expectedBotCount();
  const diagnostics = collectBrowserDiagnostics(page);
  const suffix = String(Date.now()).slice(-7);

  try {
    await enterRoom(page, `Cold-${testInfo.project.name}-${suffix}`, target);
    await expect
      .poll(
        () =>
          page.evaluate(
            () =>
              [...document.querySelectorAll(".hubs-room-bot")].filter(
                (bot) =>
                  bot.components?.["bot-info"] &&
                  bot.components?.["bot-path"] &&
                  bot.object3D.visible,
              ).length,
          ),
        { timeout: 60_000 },
      )
      .toBe(bots);

    const runtime = await page.evaluate(() => ({
      app: !!window.APP,
      aframe: !!window.AFRAME,
      entered: !!window.AFRAME?.scenes?.[0]?.is("entered"),
      reservationProtocol:
        window.APP?.hubChannel?.waypointReservations?.supported === true,
      botCount: document.querySelectorAll(".hubs-room-bot").length,
    }));
    expect(runtime).toEqual({
      app: true,
      aframe: true,
      entered: true,
      reservationProtocol: true,
      botCount: bots,
    });

    await testInfo.attach(`cold-${testInfo.project.name}.png`, {
      body: await page.screenshot(),
      contentType: "image/png",
    });
    expect(
      diagnostics,
      "zero browser warnings, errors and failed requests",
    ).toEqual([]);
  } finally {
    await releaseBrowserWaypoint(page);
  }
});
