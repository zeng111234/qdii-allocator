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
