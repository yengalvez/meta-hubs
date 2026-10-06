import test from "node:test";
import assert from "node:assert/strict";
import { civilMonth, planMonthlyRetention } from "../../deployment/monthly-backup-retention.mjs";

const point = (month, extra = {}) => ({
  instanceId: "yenhubs-main", month,
  digitalOcean: { status: "complete", databaseId: `db-${month}`, mediaId: `media-${month}` },
  googleDrive: { status: "verified", fileId: `drive-${month}`, sha256: "a".repeat(64) },
  ...extra
});
const plan = (month, points) => planMonthlyRetention({ instanceId: "yenhubs-main", month, points });

test("Madrid decides the civil month at the UTC boundary", () => {
  assert.equal(civilMonth("2026-10-31T23:30:00Z"), "2026-11");
  assert.equal(civilMonth("2026-10-31T22:30:00Z"), "2026-10");
});
test("November keeps October/November; December keeps November/December", () => {
  assert.deepEqual(plan("2026-11", [point("2026-09"), point("2026-10"), point("2026-11")]).keepDigitalOcean,
    ["2026-11", "2026-10"]);
  const next = plan("2026-12", [point("2026-10"), point("2026-11"), point("2026-12")]);
  assert.deepEqual(next.keepDigitalOcean, ["2026-12", "2026-11"]);
  assert.deepEqual(next.retireDigitalOcean, ["2026-10"]);
});
test("Drive retains ten different complete months", () => {
  const points = Array.from({ length: 12 }, (_, i) => point(`2026-${String(i + 1).padStart(2, "0")}`));
  const result = plan("2026-12", points);
  assert.equal(result.keepGoogleDrive.length, 10);
  assert.deepEqual(result.retireGoogleDrive, ["2026-02", "2026-01"]);
});
test("partial DB/media capture never retires previous months", () => {
  const current = point("2026-12", { digitalOcean: { status: "complete", databaseId: "db-12" } });
  const result = plan("2026-12", [point("2026-10"), point("2026-11"), current]);
  assert.equal(result.readyToRotate, false);
  assert.deepEqual(result.retireDigitalOcean, []);
  assert.deepEqual(result.retireGoogleDrive, []);
});
test("interrupted Drive upload cannot cause rotation", () => {
  const current = point("2026-12", { googleDrive: { status: "uploading" } });
  assert.equal(plan("2026-12", [point("2026-10"), point("2026-11"), current]).reason,
    "current_month_incomplete");
});
test("a DO month is not retired until its Drive export was verified", () => {
  const previous = point("2026-10", { googleDrive: { status: "missing" } });
  const result = plan("2026-12", [previous, point("2026-11"), point("2026-12")]);
  assert.equal(result.reason, "history_not_exported");
  assert.deepEqual(result.retireDigitalOcean, []);
});
test("first month invents no historical copies", () => {
  const result = plan("2026-10", [point("2026-10")]);
  assert.deepEqual(result.keepDigitalOcean, ["2026-10"]);
  assert.deepEqual(result.keepGoogleDrive, ["2026-10"]);
});
test("foreign clients are never selected for retirement", () => {
  const result = plan("2026-12", [point("2026-12"), point("2026-01", { instanceId: "other-client" })]);
  assert.deepEqual(result.retireDigitalOcean, []);
  assert.deepEqual(result.retireGoogleDrive, []);
});
test("duplicate monthly points are refused rather than silently chosen", () => {
  assert.throws(() => plan("2026-12", [point("2026-12"), point("2026-12")]), /duplicate_month/);
});
test("future and malformed month observations are refused", () => {
  assert.throws(() => plan("2026-11", [point("2026-12")]), /future_month/);
  assert.throws(() => plan("2026-13", []), /invalid_month/);
});
