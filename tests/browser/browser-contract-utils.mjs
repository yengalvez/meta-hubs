import { expect } from "@playwright/test";

const PRODUCTION_ROOT = "meta-hubs.org";
const SAFE_REMOTE_MARKER =
  /(^|[.-])(staging|test|qa|preview|sandbox|dev)([.-]|$)/i;

function isLoopback(hostname) {
  return (
    hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1"
  );
}

function isProductionFamily(hostname) {
  return (
    hostname === PRODUCTION_ROOT || hostname.endsWith(`.${PRODUCTION_ROOT}`)
  );
}

export function requireSafeBrowserTarget(rawTarget) {
  if (!rawTarget)
    throw new Error(
      "A browser test URL is required; there is no default target.",
    );

  const target = new URL(rawTarget);
  if (target.username || target.password)
    throw new Error("Credentials are forbidden in browser test URLs.");

  if (isProductionFamily(target.hostname)) {
    if (
      target.protocol !== "https:" ||
      process.env.BROWSER_ALLOW_PRODUCTION !== "1"
    ) {
      throw new Error(
        "Refusing the production domain family without HTTPS and BROWSER_ALLOW_PRODUCTION=1.",
      );
    }
  } else if (isLoopback(target.hostname)) {
    if (target.protocol !== "http:" && target.protocol !== "https:") {
      throw new Error("Loopback browser targets must use HTTP or HTTPS.");
    }
  } else if (
    target.protocol !== "https:" ||
    !SAFE_REMOTE_MARKER.test(target.hostname)
  ) {
    throw new Error(
      "Remote browser targets require HTTPS and an explicit staging/test/qa/preview/sandbox/dev host.",
    );
  }

  return target;
}

export function assertFinalBrowserTarget(pageUrl, plannedTarget) {
  const finalTarget = new URL(pageUrl);
  if (finalTarget.origin !== plannedTarget.origin) {
    throw new Error("Browser target redirected to a different origin.");
  }
}

export function collectBrowserDiagnostics(page) {
  const issues = [];
  page.on("console", (message) => {
    if (message.type() === "warning" || message.type() === "error") {
      issues.push({ kind: `console-${message.type()}` });
    }
  });
  page.on("pageerror", () => issues.push({ kind: "page-error" }));
  page.on("requestfailed", () => issues.push({ kind: "request-failed" }));
  page.on("response", (response) => {
    if (response.status() >= 400)
      issues.push({ kind: "http-error", status: response.status() });
  });
  return issues;
}

export async function enterRoom(page, displayName, plannedTarget) {
  await page.goto(plannedTarget.toString(), { waitUntil: "domcontentloaded" });
  assertFinalBrowserTarget(page.url(), plannedTarget);
  await page
    .getByRole("button", { name: "Entrar a la sala" })
    .click({ timeout: 60_000 });

  const nameInput = page.getByRole("textbox", { name: "Nombre para mostrar" });
  await expect(nameInput).toBeVisible();
  await nameInput.fill(displayName);
  await page.getByRole("button", { name: "Aceptar" }).click();

  await page.getByRole("button", { name: "Entrar a la sala" }).click();
  const skipTour = page.getByRole("button", { name: "Saltar recorrido" });
  if (await skipTour.isVisible().catch(() => false)) await skipTour.click();

  await expect(page.getByRole("button", { name: "Sentarse" })).toBeVisible({
    timeout: 60_000,
  });
  await page.waitForFunction(
    () =>
      window.APP &&
      window.NAF?.clientId &&
      window.AFRAME?.scenes?.[0]?.is("entered") &&
      window.AFRAME.scenes[0].systems?.["hubs-systems"]?.characterController &&
      document.querySelector("#avatar-rig")?.components?.["player-info"],
  );
}

export async function releaseBrowserWaypoint(page) {
  if (!page || page.isClosed()) return;
  await page
    .evaluate(async () => {
      await window.APP?.hubChannel?.releaseWaypointReservation?.();
      for (const waypoint of document.querySelectorAll("[waypoint]")) {
        if (
          waypoint.components?.waypoint?.data?.canBeOccupied &&
          waypoint.components.waypoint.data.isOccupied &&
          window.NAF?.utils?.isMine(waypoint)
        ) {
          waypoint.setAttribute("waypoint", { isOccupied: false });
        }
      }
    })
    .catch(() => {});
}
