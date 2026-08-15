const test = require("node:test");
const assert = require("node:assert/strict");

const walkForward = require("../../lib/walk-forward");
const totalReturnTools = require("../../lib/total-return");

function provenAvailability() {
  return [{
    startDate: "2025-01-01",
    endDate: "2027-12-31",
    status: "active",
    dailyLimit: 100
  }];
}

test("execution lag scenarios show the high-entry risk explicitly", function () {
  const history = [
    { date: "2026-01-01", nav: 1.00, accNav: 1.00 },
    { date: "2026-01-02", nav: 1.10, accNav: 1.10 },
    { date: "2026-01-03", nav: 1.20, accNav: 1.20 },
    { date: "2026-01-04", nav: 1.10, accNav: 1.10 }
  ];
  const scenarios = walkForward.simulateExecutionLagScenarios(history, 0, 3, [0, 1, 2], { buyFeeRate: 0, sellFeeRate: 0 });
  assert.deepEqual(scenarios.map(function (row) { return row.buyDate; }), ["2026-01-01", "2026-01-02", "2026-01-03"]);
  assert.ok(scenarios[0].netReturn > scenarios[1].netReturn);
  assert.ok(scenarios[1].netReturn > scenarios[2].netReturn);
});

test("execution lag scenarios deduct buy and redemption fees", function () {
  const history = [
    { date: "2026-01-01", nav: 1, accNav: 1 },
    { date: "2026-01-02", nav: 1.1, accNav: 1.1 }
  ];
  const withoutFees = walkForward.simulateExecutionLagScenarios(history, 0, 1, [0], { buyFeeRate: 0, sellFeeRate: 0 })[0];
  const withFees = walkForward.simulateExecutionLagScenarios(history, 0, 1, [0], { buyFeeRate: 0.01, sellFeeRate: 0.01 })[0];
  assert.ok(withFees.netReturn < withoutFees.netReturn);
  assert.equal(withFees.feesIncluded, true);
});

test("window return aligns funds by date instead of array position", function () {
  const rows = [
    { date: "2025-12-30", nav: 50, accNav: 50 },
    { date: "2025-12-31", nav: 60, accNav: 60 },
    { date: "2026-01-01", nav: 1, accNav: 1 },
    { date: "2026-01-02", nav: 1.1, accNav: 1.1 },
    { date: "2026-01-03", nav: 1.21, accNav: 1.21 },
    { date: "2026-01-04", nav: 1.331, accNav: 1.331 }
  ];
  const result = walkForward.calculateWindowReturn(rows, "2026-01-01", "2026-01-04", 1, {
    buyFeeRate: 0,
    sellFeeRate: 0
  });
  assert.equal(result.buyDate, "2026-01-02");
  assert.equal(result.endDate, "2026-01-04");
  assert.equal(result.netReturn, 21);
});

test("window return uses accumulated NAV and rejects histories without it", function () {
  const totalReturn = walkForward.calculateWindowReturn([
    { date: "2026-01-01", nav: 1, accNav: 1 },
    { date: "2026-01-02", nav: 1.1, accNav: 2 }
  ], "2026-01-01", "2026-01-02", 0, { buyFeeRate: 0, sellFeeRate: 0 });
  const unavailable = walkForward.calculateWindowReturn([
    { date: "2026-01-01", nav: 1 },
    { date: "2026-01-02", nav: 2 }
  ], "2026-01-01", "2026-01-02", 0, { buyFeeRate: 0, sellFeeRate: 0 });

  assert.equal(totalReturn.netReturn, 100);
  assert.equal(totalReturn.totalReturnBasis, totalReturnTools.TOTAL_RETURN_BASIS);
  assert.equal(unavailable.available, false);
});

test("window return is not diluted by accumulated distributions before the test window", function () {
  const result = walkForward.calculateWindowReturn([
    { date: "2026-01-01", nav: 1, accNav: 2 },
    { date: "2026-01-02", nav: 1.1, accNav: 2.1 }
  ], "2026-01-01", "2026-01-02", 0, { buyFeeRate: 0, sellFeeRate: 0 });
  assert.equal(result.netReturn, 10);
});

test("walk-forward compares strategy and benchmark with identical lag and fees", function () {
  const start = new Date("2026-01-01T00:00:00Z");
  function series(extraRows) {
    const rows = (extraRows || []).slice();
    for (let i = 0; i < 70; i++) {
      const date = new Date(start);
      date.setUTCDate(date.getUTCDate() + i);
      rows.push({
        date: date.toISOString().slice(0, 10),
        nav: i < 50 ? 1 : Number((1 + (i - 49) * 0.01).toFixed(4)),
        accNav: i < 50 ? 1 : Number((1 + (i - 49) * 0.01).toFixed(4))
      });
    }
    return rows;
  }
  const groups = ["SPX500", "NDX100", "JAPAN", "EUROPE", "GOLD", "HEALTHCARE", "DOW30", "RUSSELL2000", "GLOBAL", "APAC"];
  const funds = groups.map(function (indexGroup, index) {
    return {
      code: String.fromCharCode(65 + index), name: "Fund " + index, type: indexGroup,
      indexGroup: indexGroup, status: "active", dailyLimit: 100, minPurchase: 10, feeRate: 0.5,
      purchaseAvailabilityHistory: provenAvailability()
    };
  });
  const histories = {};
  funds.forEach(function (fund, index) {
    histories[fund.code] = index === 1
      ? series([
        { date: "2025-12-30", nav: 50, accNav: 50 },
        { date: "2025-12-31", nav: 60, accNav: 60 }
      ])
      : series();
  });

  const result = walkForward.runWalkForwardBacktest(histories, funds, {
    trainDays: 60,
    testDays: 10,
    stepDays: 10,
    topN: 2,
    minDataPoints: 60,
    executionLagDays: 2,
    buyFeeRate: 0.008,
    sellFeeRate: 0.005,
    qdiiLagIncluded: true,
    optimizationTrials: 2
  });

  assert.equal(result.windows.length, 1);
  assert.equal(result.windows[0].excessReturn, 0);
  assert.equal(result.windows[0].avgReturn, result.windows[0].benchmarkReturn);
});

test("walk-forward uses the configured S&P baseline instead of the changing candidate average", function () {
  const start = new Date("2026-01-01T00:00:00Z");
  function series(step) {
    return Array.from({ length: 70 }, function (_, index) {
      const date = new Date(start);
      date.setUTCDate(date.getUTCDate() + index);
      const nav = index < 60 ? 1 : 1 + (index - 59) * step;
      return { date: date.toISOString().slice(0, 10), nav: nav, accNav: nav };
    });
  }
  const groups = ["SPX500", "NDX100", "JAPAN", "EUROPE", "GOLD", "HEALTHCARE", "DOW30", "RUSSELL2000", "US_REIT", "GLOBAL_REIT"];
  const funds = groups.map(function (indexGroup, index) {
    return {
      code: String.fromCharCode(65 + index), name: index === 0 ? "主动候选" : "候选" + index,
      type: indexGroup, indexGroup: indexGroup, status: "active", dailyLimit: 100, minPurchase: 10, feeRate: 0.5,
      purchaseAvailabilityHistory: provenAvailability()
    };
  });
  const histories = { BASE: series(0.005) };
  funds.forEach(function (fund, index) { histories[fund.code] = series(index === 0 ? 0.02 : 0.001); });
  const result = walkForward.runWalkForwardBacktest(histories, funds, {
    trainDays: 60, testDays: 10, stepDays: 10, topN: 1, minDataPoints: 60,
    executionLagDays: 0, buyFeeRate: 0, sellFeeRate: 0,
    benchmarkCode: "BASE", qdiiLagIncluded: true, optimizationTrials: 2
  });

  assert.equal(result.summary.baselineCode, "BASE");
  assert.equal(result.summary.assumptions.totalReturnBasis, totalReturnTools.TOTAL_RETURN_BASIS);
  assert.equal(result.summary.assumptions.qdiiLagIncluded, false);
  assert.equal(result.summary.outperformanceWinRate, "100%");
  assert.ok(result.windows[0].avgReturn > result.windows[0].benchmarkReturn);
  assert.equal(result.windows[0].benchmarkCodes[0], "BASE");
});

test("walk-forward does not backfill current fund availability into historical windows", function () {
  const start = new Date("2026-01-01T00:00:00Z");
  const history = Array.from({ length: 70 }, function (_, index) {
    const date = new Date(start);
    date.setUTCDate(date.getUTCDate() + index);
    return { date: date.toISOString().slice(0, 10), nav: 1 + index / 100, accNav: 1 + index / 100 };
  });
  const result = walkForward.runWalkForwardBacktest({ A: history }, [{
    code: "A",
    name: "Current active only",
    type: "SPX500",
    indexGroup: "SPX500",
    status: "active",
    dailyLimit: 100,
    minPurchase: 10,
    feeRate: 0.5
  }], {
    trainDays: 60,
    testDays: 10,
    stepDays: 10,
    topN: 1,
    minDataPoints: 60,
    executionLagDays: 2,
    buyFeeRate: 0.008,
    sellFeeRate: 0.005,
    qdiiLagIncluded: true,
    optimizationTrials: 2
  });

  assert.equal(result.windows[0].picks.length, 0);
  assert.equal(result.summary.assumptions.historicalPurchaseAvailabilityProven, false);
  assert.equal(result.summary.approvedForLive, false);
});

test("walk-forward seed portfolio excludes satellite themes", function () {
  const holdings = walkForward.buildInitialHoldings([
    { code: "THEME", name: "主题", indexGroup: "GLOBAL_MFG", status: "active", dailyLimit: 100 },
    { code: "CORE", name: "标普", indexGroup: "SPX500", status: "active", dailyLimit: 100 }
  ]);
  assert.deepEqual(holdings.map(function (holding) { return holding.code; }), ["CORE"]);
});
