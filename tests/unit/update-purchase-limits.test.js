const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const updater = require("../../scripts/update-purchase-limits");

function makeTempFunds() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "qdii-limits-"));
  const file = path.join(directory, "funds.json");
  const value = {
    _lastUpdated: "2026-08-12",
    funds: [
      { code: "A", name: "A", status: "active", dailyLimit: 100, minPurchase: 10 },
      { code: "B", name: "B", status: "active", dailyLimit: 100, minPurchase: 10 }
    ]
  };
  fs.writeFileSync(file, JSON.stringify(value));
  return { directory: directory, file: file, original: fs.readFileSync(file, "utf8") };
}

test("purchase availability writes one complete fresh snapshot", async function (t) {
  const fixture = makeTempFunds();
  t.after(function () { fs.rmSync(fixture.directory, { recursive: true, force: true }); });
  const now = Date.parse("2026-08-13T01:00:00.000Z");
  const calls = {};
  await updater.updatePurchaseLimits({
    fundsFile: fixture.file,
    now: now,
    fetchInfo: async function (code) {
      calls[code] = (calls[code] || 0) + 1;
      return { code: code, name: code, status: code === "B" ? "suspended" : "limited", limit: code === "A" ? 20 : 0, _cachedAt: now };
    }
  });
  const saved = JSON.parse(fs.readFileSync(fixture.file, "utf8"));
  assert.equal(saved._lastUpdated, "2026-08-13");
  assert.equal(saved._purchaseAvailabilityUpdatedAt, "2026-08-13T01:00:00.000Z");
  assert.deepEqual(calls, { A: 1, B: 1 });
  assert.equal(saved.funds[0].dailyLimit, 20);
  assert.equal(saved.funds[1].status, "suspended");
});

test("purchase availability stamps the Shanghai calendar date across the UTC midnight boundary", async function (t) {
  const fixture = makeTempFunds();
  t.after(function () { fs.rmSync(fixture.directory, { recursive: true, force: true }); });
  const now = Date.parse("2026-08-14T18:00:00.000Z");
  await updater.updatePurchaseLimits({
    fundsFile: fixture.file,
    now: now,
    fetchInfo: async function (code) {
      return { code: code, name: code, status: "active", limit: 100, _cachedAt: now };
    }
  });
  const saved = JSON.parse(fs.readFileSync(fixture.file, "utf8"));
  assert.equal(saved._lastUpdated, "2026-08-15");
  assert.equal(saved._purchaseAvailabilityUpdatedAt, "2026-08-14T18:00:00.000Z");
});

test("one stale or unknown availability result rejects the whole batch without touching funds.json", async function (t) {
  const fixture = makeTempFunds();
  t.after(function () { fs.rmSync(fixture.directory, { recursive: true, force: true }); });
  const now = Date.parse("2026-08-13T01:00:00.000Z");
  await assert.rejects(updater.updatePurchaseLimits({
    fundsFile: fixture.file,
    now: now,
    fetchInfo: async function (code) {
      if (code === "B") return { status: "unknown", limit: 100 };
      return { code: code, name: code, status: "active", limit: 20, _cachedAt: now };
    }
  }), /PURCHASE_AVAILABILITY_INCOMPLETE/);
  assert.equal(fs.readFileSync(fixture.file, "utf8"), fixture.original);
});

test("a rejected availability fetch is not retried again by the batch script", async function (t) {
  const fixture = makeTempFunds();
  t.after(function () { fs.rmSync(fixture.directory, { recursive: true, force: true }); });
  let calls = 0;
  await assert.rejects(updater.updatePurchaseLimits({
    fundsFile: fixture.file,
    now: Date.parse("2026-08-13T01:00:00.000Z"),
    fetchInfo: async function () {
      calls++;
      throw new Error("connection failed after fund-data retry");
    }
  }), /PURCHASE_AVAILABILITY_INCOMPLETE/);
  assert.equal(calls, 1, "the batch fails fast; the network layer owns the single retry");
  assert.equal(fs.readFileSync(fixture.file, "utf8"), fixture.original);
});

test("official availability never promotes catalog tracking-only funds into recommendation routes", function () {
  const fund = { code: "A", name: "A", status: "tracking_only", dailyLimit: 0, minPurchase: 10 };
  updater.applyAvailability(fund, {
    code: "A",
    name: "A",
    status: "active",
    limit: 100,
    _cachedAt: Date.now()
  }, new Date().toISOString());
  assert.equal(fund.status, "tracking_only");
  assert.equal(fund.dailyLimit, 100, "the display limit may refresh without widening catalog eligibility");
});
