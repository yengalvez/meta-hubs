/**
 * Read-only retention planning. Observations must come from the future capture
 * and export verifiers; this module does not authenticate a backup or delete it.
 */
export function civilMonth(instant, timezone = "Europe/Madrid") {
  const date = new Date(instant);
  if (!Number.isFinite(date.getTime())) throw new Error("invalid_instant");
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: timezone, year: "numeric", month: "2-digit"
  }).formatToParts(date);
  return `${parts.find(p => p.type === "year").value}-${parts.find(p => p.type === "month").value}`;
}

function requireMonth(value) {
  if (typeof value !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) {
    throw new Error("invalid_month");
  }
  return value;
}

function validSnapshotPair(point) {
  const pair = point.digitalOcean;
  return pair?.status === "complete" && typeof pair.databaseId === "string" &&
    pair.databaseId.length > 0 && typeof pair.mediaId === "string" &&
    pair.mediaId.length > 0 && pair.databaseId !== pair.mediaId;
}

function validDriveExport(point) {
  const exported = point.googleDrive;
  return exported?.status === "verified" && typeof exported.fileId === "string" &&
    exported.fileId.length > 0 && /^[a-f0-9]{64}$/.test(exported.sha256 ?? "");
}

export function planMonthlyRetention({ instanceId, month, points }) {
  if (typeof instanceId !== "string" || instanceId.length === 0 || !Array.isArray(points)) {
    throw new Error("invalid_inventory");
  }
  requireMonth(month);
  const own = points.filter(point => point?.instanceId === instanceId);
  const seen = new Set();
  for (const point of own) {
    requireMonth(point.month);
    if (seen.has(point.month)) throw new Error("duplicate_month");
    if (point.month > month) throw new Error("future_month");
    seen.add(point.month);
  }
  const ordered = own.toSorted((a, b) => b.month.localeCompare(a.month));
  const current = ordered.find(point => point.month === month);
  const doPoints = ordered.filter(validSnapshotPair);
  const drivePoints = ordered.filter(validDriveExport);
  const keepDigitalOcean = doPoints.slice(0, 2).map(point => point.month);
  const keepGoogleDrive = drivePoints.slice(0, 10).map(point => point.month);
  // Wait for the new monthly point in BOTH destinations before proposing any
  // rotation. A failed export must not quietly erase the last offsite history.
  if (!current || !validSnapshotPair(current) || !validDriveExport(current)) {
    return { readyToRotate: false, keepDigitalOcean, keepGoogleDrive,
      retireDigitalOcean: [], retireGoogleDrive: [], reason: "current_month_incomplete" };
  }
  const olderDigitalOcean = doPoints.slice(2);
  // Each retired DO point must already have an independently verified export.
  if (olderDigitalOcean.some(point => !validDriveExport(point))) {
    return { readyToRotate: false, keepDigitalOcean, keepGoogleDrive,
      retireDigitalOcean: [], retireGoogleDrive: [], reason: "history_not_exported" };
  }
  return { readyToRotate: true, keepDigitalOcean, keepGoogleDrive,
    retireDigitalOcean: olderDigitalOcean.map(point => point.month),
    retireGoogleDrive: drivePoints.slice(10).map(point => point.month), reason: null };
}
