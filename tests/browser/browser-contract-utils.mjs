import { expect } from "@playwright/test";

const PRODUCTION_ROOT = "meta-hubs.org";
const SAFE_PRODUCTION_FAMILY_HOSTS = new Set(["staging.meta-hubs.org"]);
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

  if (
    isProductionFamily(target.hostname) &&
    !SAFE_PRODUCTION_FAMILY_HOSTS.has(target.hostname)
  ) {
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

function isFaviconUrl(rawUrl) {
  try {
    return new URL(rawUrl).pathname === "/favicon.ico";
  } catch {
    return false;
  }
}

export function isExpectedBrowserDiagnostic(issue) {
  if (
    issue.kind === "request-failed" &&
    issue.method === "HEAD" &&
    issue.errorText === "net::ERR_ABORTED"
  ) {
    return true;
  }

  if (isFaviconUrl(issue.url)) {
    if (issue.kind === "http-error" && issue.status === 404) return true;
    if (
      issue.kind === "console-error" &&
      /^Failed to load resource: the server responded with a status of 404/.test(
        issue.text,
      )
    ) {
      return true;
    }
  }

  if (issue.kind !== "console-warning") return false;
  return (
    /^enableChromeAEC: (inbound|outbound)PeerConnection state changed to (checking|connected)$/.test(
      issue.text,
    ) ||
    issue.text ===
      "Avatar does not an 'allOpen' animation, disabling hand animations" ||
    issue.text ===
      "The `background` component is deprecated, use `backgroundColor` on the `environment-settings` component instead."
  );
}

export function collectBrowserDiagnostics(page) {
  const issues = [];
  page.on("console", (message) => {
    if (message.type() === "warning" || message.type() === "error") {
      const issue = {
        kind: `console-${message.type()}`,
        text: message.text(),
        url: message.location().url,
      };
      if (!isExpectedBrowserDiagnostic(issue)) issues.push(issue);
    }
  });
  page.on("pageerror", (error) =>
    issues.push({ kind: "page-error", message: error.message }),
  );
  page.on("requestfailed", (request) => {
    const issue = {
      kind: "request-failed",
      method: request.method(),
      resourceType: request.resourceType(),
      url: request.url(),
      errorText: request.failure()?.errorText || "unknown",
    };
    if (!isExpectedBrowserDiagnostic(issue)) issues.push(issue);
  });
  page.on("response", (response) => {
    if (response.status() < 400) return;
    const issue = {
      kind: "http-error",
      status: response.status(),
      method: response.request().method(),
      url: response.url(),
    };
    if (!isExpectedBrowserDiagnostic(issue)) issues.push(issue);
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
