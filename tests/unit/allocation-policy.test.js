const test = require("node:test");
const assert = require("node:assert/strict");

const allocation = require("../../lib/allocation-policy");

test("AllocationPolicyV1 has fixed targets and deterministic budget limits", function () {
  const policy = allocation.createAllocationPolicy();
  assert.equal(policy.schemaVersion, "AllocationPolicyV1");
  assert.deepEqual(policy.targetBuckets, {
    US_BROAD: 0.30,
    GROWTH_TECH: 0.25,
    NON_US: 0.25,
    DEFENSIVE: 0.10,
    CASH: 0.10
  });
  assert.equal(policy.maxDailyBudget, 50);
  assert.equal(policy.maxWeeklyBudget, 250);
  assert.equal(policy.allowAutomaticSell, false);
  assert.equal(allocation.isCoreIndexGroup("SPX500"), true);
  assert.equal(allocation.bucketForIndexGroup("SPX500_EQUAL_WEIGHT"), "US_BROAD");
  assert.equal(allocation.isCoreIndexGroup("SPX500_EQUAL_WEIGHT"), false);
  assert.equal(allocation.isCoreIndexGroup("GLOBAL_MFG"), false);
});

test("aggressive profile raises core equity exposure without claiming automatic alpha", function () {
  const policy = allocation.createAllocationPolicy({ riskProfile: "AGGRESSIVE" });
  assert.equal(policy.riskProfile, "AGGRESSIVE");
  assert.deepEqual(policy.targetBuckets, {
    US_BROAD: 0.50,
    GROWTH_TECH: 0.35,
    NON_US: 0.05,
    DEFENSIVE: 0.10,
    CASH: 0
  });
  assert.equal(Object.values(policy.targetBuckets).reduce(function (sum, value) { return sum + value; }, 0), 1);
  assert.equal(policy.maxFundWeight, 0.30);
  assert.equal(policy.growthStopDrawdown, -0.12);
  assert.equal(policy.allStopDrawdown, -0.15);
  assert.equal(policy.expectedEdge, "HIGHER_EXPECTED_BETA_NOT_PROVEN_ALPHA");
});

test("execution routes exclude satellite themes even when they are cheaper", function () {
  const result = allocation.buildExecutionRoutes({
    policy: allocation.createAllocationPolicy(),
    funds: [
      { code: "THEME", indexGroup: "GLOBAL_MFG", status: "active", dailyLimit: 50, minPurchase: 10, feeRate: 0.1 },
      { code: "CORE", indexGroup: "SPX500", status: "active", dailyLimit: 50, minPurchase: 10, feeRate: 0.6 }
    ],
    holdings: [{ code: "THEME", totalAmount: 10 }, { code: "CORE", totalAmount: 10 }],
    bucketExposure: { US_BROAD: 0.1, GROWTH_TECH: 0.1, NON_US: 0.3, DEFENSIVE: 0.1, CASH: 0.4 },
    targetGap: { US_BROAD: 0.2, GROWTH_TECH: 0.3, NON_US: -0.05, DEFENSIVE: 0, CASH: -0.45 },
    dailyBudget: 50,
    freshnessByCode: { THEME: 0, CORE: 0 },
    trackingStabilityByCode: { THEME: 0.01, CORE: 0.02 }
  });
  assert.deepEqual(result.map(function (route) { return route.code; }), ["CORE"]);
});

test("same-index wrappers are one exposure and route across purchase limits", function () {
  const funds = [
    { code: "A", indexGroup: "SPX500", status: "active", dailyLimit: 10, minPurchase: 10, feeRate: 0.5, custodyFee: 0.1 },
    { code: "B", indexGroup: "SPX500", status: "active", dailyLimit: 50, minPurchase: 10, feeRate: 0.6, custodyFee: 0.1 }
  ];
  const result = allocation.buildExecutionRoutes({
    policy: allocation.createAllocationPolicy(),
    funds: funds,
    holdings: [{ code: "A", totalAmount: 10 }, { code: "B", totalAmount: 10 }],
    bucketExposure: { US_BROAD: 0.10, GROWTH_TECH: 0.25, NON_US: 0.25, DEFENSIVE: 0.10, CASH: 0.30 },
    targetGap: { US_BROAD: 0.20, GROWTH_TECH: 0, NON_US: 0, DEFENSIVE: 0, CASH: -0.20 },
    dailyBudget: 50,
    asOf: "2026-07-17",
    freshnessByCode: { A: 0, B: 0 },
    trackingStabilityByCode: { A: 0.01, B: 0.02 }
  });
  assert.equal(result.length, 2);
  assert.deepEqual(result.map(function (route) { return [route.code, route.amount, route.indexGroup]; }), [
    ["A", 10, "SPX500"],
    ["B", 40, "SPX500"]
  ]);
  assert.equal(new Set(result.map(function (route) { return route.exposureKey; })).size, 1);
});

test("bucket exposure uses latest market value when shares and NAV are available", function () {
  const result = allocation.calculateBucketExposure(
    [{ code: "SPX", totalAmount: 100, totalShares: 10 }],
    [{ code: "SPX", indexGroup: "SPX500" }],
    0,
    { SPX: [{ date: "2026-07-01", nav: 8 }] }
  );
  assert.equal(result.values.US_BROAD, 80);
  assert.equal(result.totalValue, 80);
});

test("bucket exposure excludes a pending buy with no confirmed shares", function () {
  const result = allocation.calculateBucketExposure(
    [{ code: "SPX", totalAmount: 50, buys: [{ amount: 50, nav: 1, shares: 0 }] }],
    [{ code: "SPX", indexGroup: "SPX500" }],
    0,
    { SPX: [{ date: "2026-07-01", nav: 1.2 }] }
  );
  assert.equal(result.values.US_BROAD, 0);
  assert.equal(result.totalValue, 0);
  assert.equal(result.valuationComplete, true);
});

test("bucket exposure values signed sells at the current NAV", function () {
  const result = allocation.calculateBucketExposure(
    [{ code: "SPX", buys: [
      { type: "BUY", amount: 100, nav: 1, shares: 100 },
      { type: "SELL", amount: 60, nav: 1.2, shares: 50 }
    ] }],
    [{ code: "SPX", indexGroup: "SPX500" }],
    0,
    { SPX: [{ date: "2026-07-01", nav: 2 }] }
  );
  assert.equal(result.values.US_BROAD, 100);
  assert.equal(result.totalValue, 100);
  assert.equal(result.valuationComplete, true);
});

test("bucket exposure fails closed instead of treating cost as market value", function () {
  const result = allocation.calculateBucketExposure(
    [{ code: "SPX", totalShares: 10, confirmedAmount: 100, currentValue: 999 }],
    [{ code: "SPX", indexGroup: "SPX500" }],
    0,
    {}
  );
  assert.equal(result.valuationComplete, false);
  assert.deepEqual(result.missingValuationCodes, ["SPX"]);
  assert.equal(result.totalValue, null);
  assert.deepEqual(result.exposure, {});
});

test("execution routes cannot spend beyond the remaining bucket gap", function () {
  const result = allocation.buildExecutionRoutes({
    policy: allocation.createAllocationPolicy(),
    funds: [
      { code: "A", indexGroup: "SPX500", status: "active", dailyLimit: 10, minPurchase: 10, feeRate: 0.5 },
      { code: "B", indexGroup: "SPX500", status: "active", dailyLimit: 50, minPurchase: 10, feeRate: 0.6 }
    ],
    holdings: [{ code: "A", totalShares: 10 }],
    bucketExposure: { US_BROAD: 0.10, GROWTH_TECH: 0.25, NON_US: 0.25, DEFENSIVE: 0.10, CASH: 0.30 },
    targetGap: { US_BROAD: 0.20, GROWTH_TECH: 0, NON_US: 0, DEFENSIVE: 0, CASH: -0.20 },
    dailyBudget: 50,
    currentValue: 100,
    freshnessByCode: { A: 0, B: 0 },
    trackingStabilityByCode: { A: 0.01, B: 0.02 }
  });
  assert.deepEqual(result.map(function (route) { return [route.code, route.amount]; }), [
    ["A", 10],
    ["B", 18.57]
  ]);
});

test("PAUSE, stale data, growth overweight and risk anchor stop deterministic spending", function () {
  const policy = allocation.createAllocationPolicy({ riskAnchorValue: 1000 });
  assert.equal(allocation.allowedBudget({ policy: policy, action: "PAUSE", currentValue: 1000 }), 0);
  assert.equal(allocation.allowedBudget({ policy: policy, action: "BUY", currentValue: 899 }), 0);
  assert.equal(allocation.bucketCanReceive("GROWTH_TECH", { GROWTH_TECH: 0.40 }, policy), false);
  const routes = allocation.buildExecutionRoutes({
    policy: policy,
    funds: [{ code: "A", indexGroup: "SPX500", status: "active", dailyLimit: 50 }],
    holdings: [{ code: "A", totalAmount: 10 }],
    bucketExposure: { US_BROAD: 0.10, GROWTH_TECH: 0.40, NON_US: 0.20, DEFENSIVE: 0.10, CASH: 0.20 },
    targetGap: { US_BROAD: 0.20 },
    dailyBudget: 50,
    freshnessByCode: { A: 3 }
  });
  assert.deepEqual(routes, []);
});
