const test = require("node:test");
const assert = require("node:assert/strict");

const factorEngine = require("../../lib/factor-engine");
const engine = require("../../lib/recommendation-engine");
const aiAnalyst = require("../../lib/ai-analyst");

function executableEvidence() {
  return {
    strategyId: engine.CURRENT_STRATEGY_VERSION,
    strategyIdReported: true,
    historicalPurchaseAvailabilityProven: true
  };
}

function navSeries(start, count, step) {
  const rows = [];
  const startDate = new Date(start + "T00:00:00Z");
  let nav = 1;
  for (let i = 0; i < count; i++) {
    const date = new Date(startDate);
    date.setUTCDate(date.getUTCDate() + i);
    nav += step;
    rows.push({ date: date.toISOString().slice(0, 10), nav: Number(nav.toFixed(6)) });
  }
  return rows;
}

test("weightedSum keeps zero-weight factors disabled", function () {
  assert.equal(factorEngine.weightedSum({ enabled: 100, disabled: 0 }, { enabled: 1, disabled: 0 }), 100);
});

test("fee efficiency rewards lower fees", function () {
  assert.ok(factorEngine.computeFeeEfficiency({ feeRate: 0.5, custodyFee: 0.1 }) >
    factorEngine.computeFeeEfficiency({ feeRate: 1.5, custodyFee: 0.3 }));
});

test("cross-sectional percentile is robust and stays within 0-100", function () {
  assert.deepEqual(engine.percentileRanks([1, 2, 1000]), [0, 50, 100]);
  assert.deepEqual(engine.percentileRanks([5, 5]), [50, 50]);
});

test("freshness uses trading days and blocks data older than two sessions", function () {
  assert.equal(engine.tradingDayLag("2026-07-10", "2026-07-14"), 2);
  assert.equal(engine.tradingDayLag("2026-07-09", "2026-07-14"), 3);
});

test("correlation aligns returns by common dates", function () {
  const left = [
    { date: "2026-01-01", nav: 100 }, { date: "2026-01-02", nav: 101 },
    { date: "2026-01-03", nav: 103 }, { date: "2026-01-04", nav: 106 }
  ];
  const right = [
    { date: "2026-01-01", nav: 200 }, { date: "2026-01-03", nav: 204 },
    { date: "2026-01-04", nav: 210 }, { date: "2026-01-05", nav: 220 }
  ];
  const aligned = engine.alignReturnsByDate(left, right);
  assert.deepEqual(aligned.dates, ["2026-01-04"]);
  assert.equal(aligned.left.length, 1);
  assert.equal(aligned.right.length, 1);
});

test("signal circuit breaker pauses and shadow recovery requires 20 results", function () {
  const weak = Array.from({ length: 15 }, function (_, i) { return { strategyVersion: engine.CURRENT_STRATEGY_VERSION, followUp5dReturn: i < 3 ? 1 : -2 }; });
  const paused = engine.evaluateSignalHealth(weak, []);
  assert.equal(paused.status, "PAUSE");

  const recovered = engine.evaluateSignalHealth(weak, Array.from({ length: 20 }, function (_, i) {
    return { strategyVersion: engine.CURRENT_STRATEGY_VERSION, followUp5dReturn: i < 11 ? 1 : -0.5 };
  }));
  assert.equal(recovered.status, "HEALTHY");
});

test("plan exposes every deterministic pause reason without weakening the live gate", function () {
  const weakHistory = Array.from({ length: 15 }, function (_, i) {
    return {
      date: "2026-06-" + String(i + 1).padStart(2, "0"),
      strategyVersion: engine.CURRENT_STRATEGY_VERSION,
      action: "BUY",
      ranked: [{ code: "A", followUp5dReturn: i < 3 ? 1 : -2 }]
    };
  });
  const plan = engine.buildRecommendationPlan({
    funds: [{ code: "A", name: "A", type: "标普500", indexGroup: "SPX500", status: "active", dailyLimit: 100, feeRate: 0.5 }],
    navCache: { A: navSeries("2025-10-01", 288, 0.001) },
    portfolio: { holdings: [] },
    history: { records: weakHistory },
    asOf: "2026-07-15",
    budget: 50,
    liveEnabled: false
  });

  assert.equal(plan.action, "PAUSE");
  assert.deepEqual(plan.pauseReasons, ["LIVE_DISABLED", "SIGNAL_BREAKER"]);
});

test("base recommendation exposure excludes pending buys without confirmed shares", function () {
  const plan = engine.buildRecommendationPlan({
    funds: [{ code: "A", name: "A", type: "标普500", indexGroup: "SPX500", status: "active", dailyLimit: 100, feeRate: 0.5 }],
    navCache: { A: navSeries("2025-10-01", 288, 0.001) },
    portfolio: { holdings: [{ code: "A", totalAmount: 50, buys: [{ amount: 50, nav: 0, shares: 0 }] }] },
    history: { records: [] },
    asOf: "2026-07-15",
    budget: 50,
    liveEnabled: false
  });
  assert.equal(plan.portfolioRisk.totalAmount, 0);
  assert.equal(plan.bucketExposure.US_BROAD, 0);
  assert.equal(plan.portfolioRisk.valuationComplete, true);
});

test("base recommendation pauses with zero budget when a confirmed holding has no current NAV", function () {
  const plan = engine.buildRecommendationPlan({
    funds: [
      { code: "A", name: "A", type: "标普500", indexGroup: "SPX500", status: "active", dailyLimit: 100, feeRate: 0.5 },
      { code: "H", name: "H", type: "纳指100", indexGroup: "NDX100", status: "suspended", dailyLimit: 0, feeRate: 0.5 }
    ],
    navCache: { A: navSeries("2025-10-01", 288, 0.001) },
    portfolio: { holdings: [{ code: "H", totalShares: 10, confirmedAmount: 100, currentValue: 100 }] },
    history: { records: [] },
    asOf: "2026-07-15",
    budget: 50,
    liveEnabled: false,
    riskAnchorValue: 1000,
    currentValue: 950
  });

  assert.equal(plan.action, "PAUSE");
  assert.equal(plan.budget, 0);
  assert.ok(plan.pauseReasons.includes("PORTFOLIO_VALUATION_INCOMPLETE"));
  assert.equal(plan.portfolioRisk.valuationComplete, false);
  assert.deepEqual(plan.portfolioRisk.missingValuationCodes, ["H"]);
  assert.equal(plan.portfolioRisk.totalAmount, null);
  assert.deepEqual(plan.bucketExposure, {});
  assert.equal(plan.riskAnchorDrawdown, null);
});

test("base recommendation also rejects stale NAV for a confirmed holding", function () {
  const plan = engine.buildRecommendationPlan({
    funds: [
      { code: "A", name: "A", type: "标普500", indexGroup: "SPX500", status: "active", dailyLimit: 100, feeRate: 0.5 },
      { code: "H", name: "H", type: "纳指100", indexGroup: "NDX100", status: "suspended", dailyLimit: 0, feeRate: 0.5 }
    ],
    navCache: {
      A: navSeries("2025-10-01", 288, 0.001),
      H: [{ date: "2026-07-01", nav: 1.2 }]
    },
    portfolio: { holdings: [{ code: "H", totalShares: 10, confirmedAmount: 100 }] },
    asOf: "2026-07-15",
    liveEnabled: false
  });

  assert.equal(plan.action, "PAUSE");
  assert.equal(plan.budget, 0);
  assert.ok(plan.pauseReasons.includes("PORTFOLIO_VALUATION_INCOMPLETE"));
  assert.equal(plan.portfolioRisk.valuationComplete, false);
  assert.deepEqual(plan.portfolioRisk.missingValuationCodes, []);
  assert.deepEqual(plan.portfolioRisk.staleValuationCodes, ["H"]);
  assert.deepEqual(plan.bucketExposure, {});
});

test("plan partitions BUY and PAUSE history into disjoint live and shadow samples", function () {
  const liveRecords = Array.from({ length: 15 }, function (_, i) {
    return {
      date: "2026-05-" + String(i + 1).padStart(2, "0"),
      strategyVersion: engine.CURRENT_STRATEGY_VERSION,
      action: "BUY",
      ranked: [{ code: "A", followUp5dReturn: i < 3 ? 1 : -2 }]
    };
  });
  const shadowRecords = Array.from({ length: 20 }, function (_, i) {
    return {
      date: "2026-06-" + String(i + 1).padStart(2, "0"),
      strategyVersion: engine.CURRENT_STRATEGY_VERSION,
      action: "PAUSE",
      ranked: [{ code: "A", followUp5dReturn: i < 11 ? 1 : -0.5 }]
    };
  });
  const duplicatedShadowRecord = Object.assign({}, shadowRecords[19], {
    ranked: [{ code: "A", followUp5dReturn: 1 }]
  });
  const plan = engine.buildRecommendationPlan({
    funds: [{ code: "A", name: "A", type: "标普500", indexGroup: "SPX500", status: "active", dailyLimit: 100, feeRate: 0.5 }],
    navCache: { A: navSeries("2025-10-01", 288, 0.001) },
    portfolio: { holdings: [] },
    history: { records: liveRecords.concat(shadowRecords, duplicatedShadowRecord) },
    asOf: "2026-07-15",
    budget: 50,
    liveEnabled: true,
    acceptance: {
      rollingWindows: 12, nonOverlappingWindows: 6, winRate: 58.33, benchmarkWinRate: 50,
      outperformanceWinRate: 58.33, averageExcessReturn: 0.5, profitFactor: 1.3,
      medianExcess12Week: 0.01,
      drawdownGapPercentagePoints: 1.5, shadowWeeks: 8, hardRiskViolations: 0,
      feesIncluded: true, qdiiLagIncluded: true, optimizationTrialsReported: true,
      strategyId: engine.CURRENT_STRATEGY_VERSION, strategyIdReported: true,
      historicalPurchaseAvailabilityProven: true,
      monthlyDcaWindows: 7, monthlyDcaOutperformanceRate: 57.14,
      monthlyDcaAverageExcessProfit: 1, monthlyDcaTotalExcessProfit: 10,
      monthlyDcaSameCashFlow: true, monthlyDcaHoldoutPassed: true
    },
    limits: { maxFundWeight: 1, maxIndexGroupWeight: 1 }
  });

  assert.equal(plan.signalHealth.matured.count, 15);
  assert.equal(plan.signalHealth.shadow.count, 20);
  assert.equal(plan.signalHealth.recovered, true);
  assert.equal(plan.action, "BUY");
  assert.deepEqual(plan.pauseReasons, []);
});

test("personalized plans can never enter live or shadow alpha evidence", function () {
  const version = engine.CURRENT_STRATEGY_VERSION;
  const partitioned = engine.partitionRecommendationHistory({ records: [
    { date: "2026-08-10", strategy: "RecommendationPlan", planKind: "BASE_RESEARCH", strategyVersion: version, action: "PAUSE" },
    { date: "2026-08-10", strategy: "PersonalizedPlan", planKind: "FINAL_PERSONALIZED", strategyVersion: version, action: "STRATEGIC_DCA" },
    { date: "2026-08-11", strategy: "RecommendationPlan", strategyVersion: version, action: "BUY" }
  ] });
  assert.equal(partitioned.shadowHistory.length, 1);
  assert.equal(partitioned.liveHistory.length, 1);
  assert.equal(partitioned.legacyHistory.length, 1);
  assert.equal(partitioned.legacyHistory[0].planKind, "FINAL_PERSONALIZED");
});

test("legacy recommendation history is preserved but isolated from the v2.1 signal breaker", function () {
  const weakLegacy = Array.from({ length: 15 }, function (_, i) {
    return {
      date: "2026-04-" + String(i + 1).padStart(2, "0"),
      action: "BUY",
      ranked: [{ code: "A", followUp5dReturn: i < 3 ? 1 : -2 }]
    };
  });
  const partitioned = engine.partitionRecommendationHistory({ records: weakLegacy });
  assert.equal(partitioned.liveHistory.length, 0);
  assert.equal(partitioned.legacyHistory.length, 15);
  const plan = engine.buildRecommendationPlan({
    funds: [{ code: "A", name: "A", type: "标普500", indexGroup: "SPX500", status: "active", dailyLimit: 100, feeRate: 0.5 }],
    navCache: { A: navSeries("2025-10-01", 288, 0.001) },
    portfolio: { holdings: [] },
    history: { records: weakLegacy },
    asOf: "2026-07-15",
    budget: 50,
    liveEnabled: false
  });
  assert.equal(plan.signalHealth.status, "WARMING_UP");
  assert.equal(plan.pauseReasons.includes("SIGNAL_BREAKER"), false);
});

test("plan treats same-index funds as routing wrappers rather than fake diversification", function () {
  const funds = [
    { code: "A", name: "A", type: "纳指100", indexGroup: "NDX100", status: "active", dailyLimit: 100, feeRate: 0.5 },
    { code: "B", name: "B", type: "纳指100", indexGroup: "NDX100", status: "active", dailyLimit: 100, feeRate: 1 },
    { code: "C", name: "C", type: "标普500", indexGroup: "SPX500", status: "active", dailyLimit: 100, feeRate: 0.6 }
  ];
  const navCache = { A: navSeries("2025-10-01", 288, 0.002), B: navSeries("2025-10-01", 288, 0.0015), C: navSeries("2025-10-01", 288, 0.001) };
  const plan = engine.buildRecommendationPlan({
    funds, navCache, portfolio: { holdings: [
      { code: "A", buys: [{ amount: 30, nav: 1, shares: 30 }] },
      { code: "B", buys: [{ amount: 30, nav: 1, shares: 30 }] }
    ] },
    asOf: "2026-07-15", budget: 50, liveEnabled: false
  });
  assert.equal(plan.action, "PAUSE");
  assert.ok(plan.candidates.length <= 2);
  assert.equal(plan.marketRanking.find(function (c) { return c.code === "B"; }).blockedBy.includes("INDEX_CORE_ONLY"), false);
  assert.equal(plan.bucketExposure.GROWTH_TECH > 0, true);
  assert.ok(plan.candidates.every(function (c) { return c.proposedAmount === 0; }));
});

test("market ranking exposes one entry per index group while retaining routing alternatives", function () {
  const funds = [
    { code: "A", name: "纳指A", type: "纳指100", indexGroup: "NDX100", status: "active", dailyLimit: 100, feeRate: 0.5 },
    { code: "B", name: "纳指B", type: "纳指100", indexGroup: "NDX100", status: "active", dailyLimit: 100, feeRate: 0.8 },
    { code: "C", name: "标普", type: "标普500", indexGroup: "SPX500", status: "active", dailyLimit: 100, feeRate: 0.6 }
  ];
  const navCache = { A: navSeries("2025-10-01", 288, 0.002), B: navSeries("2025-10-01", 288, 0.001), C: navSeries("2025-10-01", 288, 0.0015) };
  const plan = engine.buildRecommendationPlan({ funds: funds, navCache: navCache, portfolio: { holdings: [] }, asOf: "2026-07-15", budget: 50, liveEnabled: false });
  assert.equal(plan.marketRanking.filter(function (row) { return row.indexGroup === "NDX100"; }).length, 1);
  assert.equal(plan.marketRanking.find(function (row) { return row.indexGroup === "NDX100"; }).channelCount, 2);
});

test("satellite themes stay in observation only and cannot become buy candidates", function () {
  const funds = [
    { code: "CORE", name: "标普", type: "标普500", indexGroup: "SPX500", status: "active", dailyLimit: 100, feeRate: 0.6 },
    { code: "THEME", name: "全球制造", type: "全球制造", indexGroup: "GLOBAL_MFG", status: "active", dailyLimit: 100, feeRate: 0.1 }
  ];
  const navCache = {
    CORE: navSeries("2025-10-01", 288, 0.001),
    THEME: navSeries("2025-10-01", 288, 0.01)
  };
  const plan = engine.buildRecommendationPlan({
    funds: funds,
    navCache: navCache,
    portfolio: { holdings: [] },
    asOf: "2026-07-15",
    liveEnabled: false
  });
  assert.equal(plan.marketRanking.some(function (row) { return row.code === "THEME"; }), false);
  assert.equal(plan.observationPool.some(function (row) {
    return row.code === "THEME" && row.blockedBy.includes("SATELLITE_ONLY");
  }), true);
});

test("RecommendationPlanV2 exposes allocation, sync, anchor, routes and benchmark acceptance", function () {
  const plan = engine.buildRecommendationPlan({
    funds: [{ code: "A", name: "A", type: "标普500", indexGroup: "SPX500", status: "active", dailyLimit: 50, minPurchase: 10, feeRate: 0.5 }],
    navCache: { A: navSeries("2025-10-01", 288, 0.001) },
    portfolio: { holdings: [{ code: "A", totalAmount: 100, totalShares: 100 }] },
    history: { records: [] },
    asOf: "2026-07-17",
    syncRevision: 7,
    riskAnchorValue: 1000,
    currentValue: 950,
    liveEnabled: false,
    benchmarkComparison: { medianExcess12Week: -1.17, drawdownGapPercentagePoints: 0.86 }
  });
  assert.equal(plan.schemaVersion, "RecommendationPlanV2");
  assert.equal(plan.allocationWeek, "2026-07-13");
  assert.equal(plan.syncRevision, 7);
  assert.equal(plan.riskAnchorValue, 1000);
  assert.ok(Object.prototype.hasOwnProperty.call(plan.bucketExposure, "US_BROAD"));
  assert.ok(Object.prototype.hasOwnProperty.call(plan.targetGap, "US_BROAD"));
  assert.deepEqual(plan.executionRoutes, []);
  assert.equal(plan.confidence, "LOW");
  assert.equal(plan.benchmarkComparison.medianExcess12Week, -1.17);
});

test("live acceptance requires every sample, excess, drawdown, cost and shadow gate", function () {
  const failed = engine.evaluateLiveAcceptance({
    rollingWindows: 21, nonOverlappingWindows: 7, winRate: 58.33, benchmarkWinRate: 50,
    outperformanceWinRate: 58.33, averageExcessReturn: 0.5, profitFactor: 1.3,
    medianExcess12Week: -1.17,
    drawdownGapPercentagePoints: 0.86, shadowWeeks: 8, hardRiskViolations: 0,
    feesIncluded: true, qdiiLagIncluded: true, optimizationTrialsReported: true
  });
  assert.equal(failed.passed, false);
  assert.ok(failed.failures.includes("MEDIAN_EXCESS_NOT_POSITIVE"));
  const passed = engine.evaluateLiveAcceptance(Object.assign({
    rollingWindows: 12, nonOverlappingWindows: 6, winRate: 55, benchmarkWinRate: 50,
    outperformanceWinRate: 55, averageExcessReturn: 0.01, profitFactor: 1.2,
    medianExcess12Week: 0.01,
    drawdownGapPercentagePoints: 2, shadowWeeks: 8, hardRiskViolations: 0,
    feesIncluded: true, qdiiLagIncluded: true, optimizationTrialsReported: true,
    monthlyDcaWindows: 7, monthlyDcaOutperformanceRate: 57.14,
    monthlyDcaAverageExcessProfit: 1, monthlyDcaTotalExcessProfit: 10,
    monthlyDcaSameCashFlow: true, monthlyDcaHoldoutPassed: true
  }, executableEvidence()));
  assert.equal(passed.passed, true);
});

test("live acceptance rejects a sub-55% win rate or weak payoff quality", function () {
  const base = Object.assign({
    rollingWindows: 22, nonOverlappingWindows: 22, medianExcess12Week: 0.65,
    drawdownGapPercentagePoints: 0.84, shadowWeeks: 8, hardRiskViolations: 0,
    feesIncluded: true, qdiiLagIncluded: true, optimizationTrialsReported: true,
    winRate: 55, benchmarkWinRate: 50, outperformanceWinRate: 55,
    averageExcessReturn: 0.01, profitFactor: 1.2,
    monthlyDcaWindows: 7, monthlyDcaOutperformanceRate: 57.14,
    monthlyDcaAverageExcessProfit: 1, monthlyDcaTotalExcessProfit: 10,
    monthlyDcaSameCashFlow: true, monthlyDcaHoldoutPassed: true
  }, executableEvidence());
  assert.equal(engine.evaluateLiveAcceptance(base).passed, true);
  assert.ok(engine.evaluateLiveAcceptance({ ...base, winRate: 50 }).failures.includes("WIN_RATE_BELOW_55"));
  assert.ok(engine.evaluateLiveAcceptance({ ...base, profitFactor: 1.19 }).failures.includes("PROFIT_FACTOR_BELOW_1_2"));
});

test("live acceptance requires a measurable advantage over S&P 500 baseline", function () {
  const base = Object.assign({
    rollingWindows: 22, nonOverlappingWindows: 8, medianExcess12Week: 0.65,
    drawdownGapPercentagePoints: 0.84, shadowWeeks: 8, hardRiskViolations: 0,
    feesIncluded: true, qdiiLagIncluded: true, optimizationTrialsReported: true,
    winRate: 60, benchmarkWinRate: 55, outperformanceWinRate: 60,
    averageExcessReturn: 0.5, profitFactor: 1.3,
    monthlyDcaWindows: 7, monthlyDcaOutperformanceRate: 57.14,
    monthlyDcaAverageExcessProfit: 1, monthlyDcaTotalExcessProfit: 10,
    monthlyDcaSameCashFlow: true, monthlyDcaHoldoutPassed: true
  }, executableEvidence());
  assert.equal(engine.evaluateLiveAcceptance(base).passed, true);
  assert.ok(engine.evaluateLiveAcceptance({ ...base, winRate: 50 }).failures.includes("PROFIT_WIN_RATE_NOT_ABOVE_BASELINE"));
  assert.ok(engine.evaluateLiveAcceptance({ ...base, outperformanceWinRate: 50 }).failures.includes("OUTPERFORMANCE_WIN_RATE_BELOW_55"));
  assert.ok(engine.evaluateLiveAcceptance({ ...base, averageExcessReturn: 0 }).failures.includes("AVERAGE_EXCESS_NOT_POSITIVE"));
});

test("live acceptance requires real monthly DCA profit evidence under identical cash flows", function () {
  const base = Object.assign({
    rollingWindows: 22, nonOverlappingWindows: 8, medianExcess12Week: 0.65,
    drawdownGapPercentagePoints: 0.84, shadowWeeks: 8, hardRiskViolations: 0,
    feesIncluded: true, qdiiLagIncluded: true, optimizationTrialsReported: true,
    winRate: 60, benchmarkWinRate: 55, outperformanceWinRate: 60,
    averageExcessReturn: 0.5, profitFactor: 1.3,
    monthlyDcaWindows: 7, monthlyDcaOutperformanceRate: 57.14,
    monthlyDcaAverageExcessProfit: 1, monthlyDcaTotalExcessProfit: 10,
    monthlyDcaSameCashFlow: true, monthlyDcaHoldoutPassed: true
  }, executableEvidence());
  assert.equal(engine.evaluateLiveAcceptance(base).passed, true);
  assert.ok(engine.evaluateLiveAcceptance({ ...base, monthlyDcaWindows: 0 }).failures.includes("INSUFFICIENT_MONTHLY_DCA_WINDOWS"));
  assert.ok(engine.evaluateLiveAcceptance({ ...base, monthlyDcaOutperformanceRate: 50 }).failures.includes("MONTHLY_DCA_OUTPERFORMANCE_BELOW_55"));
  assert.ok(engine.evaluateLiveAcceptance({ ...base, monthlyDcaAverageExcessProfit: 0 }).failures.includes("MONTHLY_DCA_AVERAGE_EXCESS_NOT_POSITIVE"));
  assert.ok(engine.evaluateLiveAcceptance({ ...base, monthlyDcaTotalExcessProfit: 0 }).failures.includes("MONTHLY_DCA_TOTAL_EXCESS_NOT_POSITIVE"));
  assert.ok(engine.evaluateLiveAcceptance({ ...base, monthlyDcaSameCashFlow: false }).failures.includes("MONTHLY_DCA_CASH_FLOW_MISMATCH"));
  assert.ok(engine.evaluateLiveAcceptance({ ...base, monthlyDcaHoldoutPassed: false }).failures.includes("MONTHLY_DCA_HOLDOUT_FAILED"));
});

test("live acceptance is bound to the tested strategy and executable purchase history", function () {
  const base = Object.assign({
    rollingWindows: 22, nonOverlappingWindows: 8, medianExcess12Week: 0.65,
    drawdownGapPercentagePoints: 0.84, shadowWeeks: 8, hardRiskViolations: 0,
    feesIncluded: true, qdiiLagIncluded: true, optimizationTrialsReported: true,
    winRate: 60, benchmarkWinRate: 55, outperformanceWinRate: 60,
    averageExcessReturn: 0.5, profitFactor: 1.3,
    monthlyDcaWindows: 7, monthlyDcaOutperformanceRate: 57.14,
    monthlyDcaAverageExcessProfit: 1, monthlyDcaTotalExcessProfit: 10,
    monthlyDcaSameCashFlow: true, monthlyDcaHoldoutPassed: true
  }, executableEvidence());

  assert.equal(engine.evaluateLiveAcceptance(base).passed, true);
  assert.ok(engine.evaluateLiveAcceptance({ ...base, strategyId: "different-strategy" })
    .failures.includes("STRATEGY_EVIDENCE_MISMATCH"));
  assert.ok(engine.evaluateLiveAcceptance({ ...base, strategyIdReported: false })
    .failures.includes("STRATEGY_EVIDENCE_MISMATCH"));
  assert.ok(engine.evaluateLiveAcceptance({ ...base, historicalPurchaseAvailabilityProven: false })
    .failures.includes("HISTORICAL_PURCHASE_AVAILABILITY_UNPROVEN"));
});

test("live acceptance treats missing numeric evidence as insufficient", function () {
  const verdict = engine.evaluateLiveAcceptance({});
  assert.equal(verdict.passed, false);
  assert.ok(verdict.failures.includes("INSUFFICIENT_ROLLING_WINDOWS"));
  assert.ok(verdict.failures.includes("INSUFFICIENT_NON_OVERLAPPING_WINDOWS"));
  assert.ok(verdict.failures.includes("INSUFFICIENT_SHADOW_WEEKS"));
});

test("AI output validator rejects codes, amounts and actions outside the plan", function () {
  const plan = { action: "PAUSE", candidates: [{ code: "A", proposedAmount: 0 }] };
  assert.equal(engine.validateAIOutput(plan, { action: "BUY", candidates: [{ code: "X", proposedAmount: 50 }] }).valid, false);
  assert.equal(engine.validateAIOutput(plan, { action: "PAUSE", candidates: [{ code: "A", proposedAmount: 0 }] }).valid, true);
});

test("AI prompt makes the deterministic plan immutable", function () {
  const plan = { action: "PAUSE", candidates: [{ code: "A", proposedAmount: 0 }] };
  const prompt = aiAnalyst.buildDecisionPrompt({ recommendationPlan: plan });
  assert.match(prompt, /禁止新增基金/);
  assert.match(prompt, /PAUSE\/HOLD 不得解释为可以买入/);
  assert.match(prompt, /"action":"PAUSE"/);
});

test("synthetic portfolio regression stays paused and has complete metadata", function () {
  const funds = require("../../data/funds.json").funds;
  const plan = engine.buildRecommendationPlan({
    funds: funds,
    navCache: require("../../data/nav-cache.json"),
    portfolio: { holdings: [
      { code: "270042", totalAmount: 70, totalShares: 70 },
      { code: "040046", totalAmount: 30, totalShares: 30 },
      { code: "096001", totalAmount: 20, totalShares: 20 }
    ] },
    history: require("../../data/history.json"),
    asOf: "2026-07-16",
    budget: 50,
    liveEnabled: false
  });
  assert.equal(plan.action, "PAUSE");
  assert.equal(plan.signalHealth.status, plan.signalHealth.shadow.count < 15 ? "WARMING_UP" : "HEALTHY");
  assert.equal(plan.pauseReasons.includes("SIGNAL_BREAKER"), false);
  assert.equal(plan.portfolioRisk.unknownHoldings.length, 0);
  assert.equal(plan.portfolioRisk.valuationComplete, true);
  assert.ok(plan.candidates.filter(function (candidate) { return candidate.indexGroup === "NDX100"; }).length <= 1);
});
