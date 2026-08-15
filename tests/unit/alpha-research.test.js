const test = require("node:test");
const assert = require("node:assert/strict");

const alpha = require("../../lib/alpha-research");
const totalReturn = require("../../lib/total-return");
const alphaReport = require("../../lib/alpha-research-report");
const fundConfig = require("../../data/funds.json");

function monthlySeries(values) {
  return values.map(function (nav, index) {
    return {
      date: "2026-" + String(index + 1).padStart(2, "0") + "-02",
      nav: nav,
      accNav: nav
    };
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

test("strategy signal receives only data published strictly before the decision date", function () {
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
  assert.deepEqual(visibleLastDates, [null, "2026-01-02", "2026-02-02"]);
  assert.equal(visibleLastDates[2] < "2026-03-02", true, "3月决策不得读取同日尚未公布的净值");
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
    sellFeeRate: 0.02,
    executionLagDays: 0,
    allocate: function () { return { ASSET: 1 }; }
  });
  assert.equal(comparison.strategy.totalContributed, comparison.baseline.totalContributed);
  assert.equal(comparison.strategy.assumptions.buyFeeRate, comparison.baseline.assumptions.buyFeeRate);
  assert.equal(comparison.strategy.assumptions.sellFeeRate, comparison.baseline.assumptions.sellFeeRate);
  assert.equal(comparison.strategy.assumptions.sellFeeRate, 0.02);
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

test("monthly contribution simulation deducts the configured redemption fee", function () {
  const histories = { BASE: monthlySeries([1, 1, 1]) };
  const withoutSellFee = alpha.simulateMonthlyContributions(histories, {
    baselineCode: "BASE",
    startDate: "2026-01-01",
    endDate: "2026-03-31",
    monthlyContribution: 100,
    buyFeeRate: 0,
    sellFeeRate: 0,
    executionLagDays: 0
  });
  const withSellFee = alpha.simulateMonthlyContributions(histories, {
    baselineCode: "BASE",
    startDate: "2026-01-01",
    endDate: "2026-03-31",
    monthlyContribution: 100,
    buyFeeRate: 0,
    sellFeeRate: 0.01,
    executionLagDays: 0
  });

  assert.equal(withSellFee.assumptions.sellFeeRate, 0.01);
  assert.equal(withSellFee.endValue, 297);
  assert.ok(withSellFee.endValue < withoutSellFee.endValue);
});

test("research histories exclude observations before the configured strategy start date", function () {
  const prepared = alpha.prepareResearchHistories({
    FUND: [
      { date: "2021-09-21", nav: 2, accNav: 2 },
      { date: "2021-09-22", nav: 1, accNav: 1 },
      { date: "2021-09-23", nav: 1.1, accNav: 1.1 }
    ]
  }, ["FUND"], { FUND: "2021-09-22" });

  assert.deepEqual(prepared.histories.FUND.map(function (row) { return row.date; }), [
    "2021-09-22",
    "2021-09-23"
  ]);
  assert.deepEqual(prepared.coverage.FUND, {
    rawStartDate: "2021-09-21",
    strategyStartDate: "2021-09-22",
    effectiveStartDate: "2021-09-22",
    latestDate: "2021-09-23",
    rawRows: 3,
    usableRows: 2,
    excludedPreStrategyRows: 1,
    missingAccNavRows: 0,
    totalReturnBasis: totalReturn.TOTAL_RETURN_BASIS,
    totalReturnFormula: totalReturn.TOTAL_RETURN_FORMULA
  });
});

test("research histories exclude missing accumulated NAV instead of falling back to unit NAV", function () {
  const prepared = alpha.prepareResearchHistories({
    FUND: [
      { date: "2026-01-01", nav: 1, accNav: 1 },
      { date: "2026-01-02", nav: 9, accNav: null },
      { date: "2026-01-03", nav: 1.2, accNav: 1.5 }
    ]
  }, ["FUND"], {});

  assert.deepEqual(prepared.histories.FUND.map(function (row) {
    return { date: row.date, nav: row.nav };
  }), [
    { date: "2026-01-01", nav: 1 },
    { date: "2026-01-03", nav: 1.5 }
  ]);
  assert.equal(prepared.coverage.FUND.missingAccNavRows, 1);
  assert.equal(prepared.coverage.FUND.totalReturnBasis, totalReturn.TOTAL_RETURN_BASIS);
});

test("alpha research uses the audited long-history Nasdaq 100 channel", function () {
  assert.ok(fundConfig.config.alphaResearchCodes.includes("160213"));
  assert.equal(fundConfig.config.alphaResearchCodes.includes("539001"), false);
  const navCache = require("../../data/nav-cache.json");
  assert.ok(navCache["160213"].length > 3000);
  assert.equal(navCache["160213"][0].date, "2010-04-29");
});

test("alpha research report declares its strategy, both costs and actual tested configurations", function () {
  const candidateCodes = ["A", "B", "C", "D", "E", "F"];
  const navCache = { BASE: monthlySeries([1, 1, 1]) };
  candidateCodes.forEach(function (code, index) {
    navCache[code] = monthlySeries([1, 1 + index / 100, 1.1 + index / 100]);
  });
  const report = alphaReport.buildAlphaResearchReport({
    asOf: "2026-03-31",
    navCache: navCache,
    fundsConfig: {
      config: {
        baselineBacktestCode: "BASE",
        alphaResearchCodes: candidateCodes,
        buyFeeRate: 0.01,
        sellFeeRate: 0.02,
        executionLagDays: 2
      }
    }
  });

  assert.equal(report.strategyId, "monthly-relative-momentum-dca-v1");
  assert.equal(report.assumptions.buyFeeRate, 0.01);
  assert.equal(report.assumptions.sellFeeRate, 0.02);
  assert.equal(report.testedConfigurations, 54);
});

test("alpha report keeps research-only results fail closed without historical purchase availability", function () {
  const report = alphaReport.buildAlphaResearchReport({
    asOf: "2026-03-31",
    navCache: {
      BASE: monthlySeries([1, 1, 1]),
      ASSET: monthlySeries([1, 1.1, 1.2])
    },
    fundsConfig: {
      config: {
        baselineBacktestCode: "BASE",
        alphaResearchCodes: ["ASSET"]
      },
      funds: [
        { code: "BASE", status: "suspended", dailyLimit: 0 },
        { code: "ASSET", status: "active", dailyLimit: 100 }
      ]
    }
  });

  assert.equal(report.dataAudit.executionAvailability.historicalAvailabilityProven, false);
  assert.deepEqual(report.dataAudit.executionAvailability.currentUnavailableCodes, ["BASE"]);
  assert.equal(report.dataAudit.executionAvailability.executableEvidence, false);
  assert.equal(report.accepted, false);
});

test("alpha report records non-overlapping holdout metrics and rejects a single holdout", function () {
  const report = alphaReport.buildAlphaResearchReport({
    asOf: "2026-03-31",
    navCache: {
      BASE: monthlySeries([1, 1, 1]),
      ASSET: monthlySeries([1, 1.1, 1.2])
    },
    fundsConfig: {
      config: {
        baselineBacktestCode: "BASE",
        alphaResearchCodes: ["ASSET"]
      },
      funds: []
    }
  });

  assert.equal(report.holdoutEvidence.minimumIndependentWindows, 6);
  assert.ok(Number.isInteger(report.holdoutEvidence.independentWindows));
  assert.equal(report.holdoutEvidence.passed, false);
});
