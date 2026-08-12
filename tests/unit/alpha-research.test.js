const test = require("node:test");
const assert = require("node:assert/strict");

const alpha = require("../../lib/alpha-research");

function monthlySeries(values) {
  return values.map(function (nav, index) {
    return { date: "2026-" + String(index + 1).padStart(2, "0") + "-02", nav: nav };
  });
}

test("monthly contribution simulation uses equal cash flows and reports money-weighted profit", function () {
  const histories = { BASE: monthlySeries([1, 1, 1]) };
  const result = alpha.simulateMonthlyContributions(histories, {
    baselineCode: "BASE",
    startDate: "2026-01-01",
    endDate: "2026-03-31",
    monthlyContribution: 100,
    buyFeeRate: 0,
    executionLagDays: 0,
    allocate: function () { return { BASE: 1 }; }
  });
  assert.equal(result.contributionCount, 3);
  assert.equal(result.totalContributed, 300);
  assert.equal(result.endValue, 300);
  assert.equal(result.netProfit, 0);
  assert.equal(result.netReturn, 0);
});

test("strategy signal receives only data available on the decision date", function () {
  const histories = {
    BASE: monthlySeries([1, 1, 1]),
    ASSET: monthlySeries([1, 1, 10])
  };
  const visibleLastDates = [];
  alpha.simulateMonthlyContributions(histories, {
    baselineCode: "BASE",
    startDate: "2026-01-01",
    endDate: "2026-03-31",
    monthlyContribution: 100,
    buyFeeRate: 0,
    executionLagDays: 0,
    allocate: function (context) {
      const rows = context.history("ASSET");
      visibleLastDates.push(rows.length ? rows[rows.length - 1].date : null);
      return { BASE: 1 };
    }
  });
  assert.deepEqual(visibleLastDates, ["2026-01-02", "2026-02-02", "2026-03-02"]);
  assert.equal(visibleLastDates[1] < "2026-03-02", true, "2月决策不得看到3月暴涨");
});

test("comparison applies identical contributions, fees and lag to strategy and baseline", function () {
  const histories = {
    BASE: monthlySeries([1, 1.1, 1.2]),
    ASSET: monthlySeries([1, 1.2, 1.5])
  };
  const comparison = alpha.compareWithBaseline(histories, {
    baselineCode: "BASE",
    startDate: "2026-01-01",
    endDate: "2026-03-31",
    monthlyContribution: 100,
    buyFeeRate: 0.01,
    executionLagDays: 0,
    allocate: function () { return { ASSET: 1 }; }
  });
  assert.equal(comparison.strategy.totalContributed, comparison.baseline.totalContributed);
  assert.equal(comparison.strategy.assumptions.buyFeeRate, comparison.baseline.assumptions.buyFeeRate);
  assert.equal(comparison.strategy.assumptions.executionLagDays, comparison.baseline.assumptions.executionLagDays);
  assert.ok(comparison.excessProfit > 0);
  assert.ok(comparison.excessReturn > 0);
});

test("invalid or unavailable satellite weights fall back to the S&P baseline", function () {
  const histories = { BASE: monthlySeries([1, 1, 1]) };
  const result = alpha.simulateMonthlyContributions(histories, {
    baselineCode: "BASE",
    startDate: "2026-01-01",
    endDate: "2026-03-31",
    monthlyContribution: 100,
    allocate: function () { return { MISSING: 0.2, BASE: 0.8 }; }
  });
  assert.equal(result.totalContributed, 300);
  assert.equal(result.unallocatedCash, 0);
  assert.equal(result.allocations.BASE, 300);
});

test("relative momentum sleeve activates only when a satellite beats a rising baseline", function () {
  const allocator = alpha.createRelativeMomentumAllocator({
    baselineCode: "BASE",
    candidateCodes: ["FAST", "SLOW"],
    lookbackDays: 2,
    skipDays: 0,
    sleeveWeight: 0.2,
    topN: 1,
    requirePositiveTrend: true
  });
  const histories = {
    BASE: monthlySeries([1, 1.1, 1.2]),
    FAST: monthlySeries([1, 1.2, 1.5]),
    SLOW: monthlySeries([1, 1.05, 1.1])
  };
  const weights = allocator({
    date: "2026-03-02",
    history: function (code) { return histories[code]; }
  });
  assert.deepEqual(weights, { BASE: 0.8, FAST: 0.2 });
});

test("relative momentum sleeve stays in baseline when no candidate has positive excess momentum", function () {
  const allocator = alpha.createRelativeMomentumAllocator({
    baselineCode: "BASE",
    candidateCodes: ["SLOW"],
    lookbackDays: 2,
    sleeveWeight: 0.2,
    topN: 1
  });
  const histories = {
    BASE: monthlySeries([1, 1.1, 1.2]),
    SLOW: monthlySeries([1, 1.05, 1.1])
  };
  assert.deepEqual(allocator({ history: function (code) { return histories[code]; } }), { BASE: 1 });
});

test("rolling comparisons report how often monthly DCA beats the baseline", function () {
  const histories = {
    BASE: monthlySeries([1, 1, 1, 1, 1, 1]),
    ASSET: monthlySeries([1, 1.1, 1.2, 1.3, 1.4, 1.5])
  };
  const result = alpha.runRollingMonthlyComparisons(histories, {
    baselineCode: "BASE",
    startDate: "2026-01-01",
    endDate: "2026-06-30",
    windowMonths: 3,
    stepMonths: 1,
    monthlyContribution: 100,
    allocate: function () { return { ASSET: 1 }; }
  });
  assert.equal(result.windows.length, 4);
  assert.equal(result.summary.outperformanceRate, 100);
  assert.ok(result.summary.averageExcessProfit > 0);
  assert.ok(result.summary.medianExcessReturn > 0);
});
