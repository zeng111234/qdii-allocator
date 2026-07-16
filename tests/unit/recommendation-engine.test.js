const test = require("node:test");
const assert = require("node:assert/strict");

const factorEngine = require("../../lib/factor-engine");
const engine = require("../../lib/recommendation-engine");
const aiAnalyst = require("../../lib/ai-analyst");

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
  assert.deepEqual(aligned.dates, ["2026-01-03", "2026-01-04"]);
  assert.equal(aligned.left.length, 2);
  assert.equal(aligned.right.length, 2);
});

test("signal circuit breaker pauses and shadow recovery requires 20 results", function () {
  const weak = Array.from({ length: 15 }, function (_, i) { return { followUp5dReturn: i < 3 ? 1 : -2 }; });
  const paused = engine.evaluateSignalHealth(weak, []);
  assert.equal(paused.status, "PAUSE");

  const recovered = engine.evaluateSignalHealth(weak, Array.from({ length: 20 }, function (_, i) {
    return { followUp5dReturn: i < 11 ? 1 : -0.5 };
  }));
  assert.equal(recovered.status, "HEALTHY");
});

test("plan enforces concentration, max two candidates and shadow PAUSE", function () {
  const funds = [
    { code: "A", name: "A", type: "纳指100", indexGroup: "NDX100", status: "active", dailyLimit: 100, feeRate: 0.5 },
    { code: "B", name: "B", type: "纳指100", indexGroup: "NDX100", status: "active", dailyLimit: 100, feeRate: 1 },
    { code: "C", name: "C", type: "标普500", indexGroup: "SPX500", status: "active", dailyLimit: 100, feeRate: 0.6 }
  ];
  const navCache = { A: navSeries("2025-10-01", 288, 0.002), B: navSeries("2025-10-01", 288, 0.0015), C: navSeries("2025-10-01", 288, 0.001) };
  const plan = engine.buildRecommendationPlan({
    funds, navCache, portfolio: { holdings: [{ code: "A", buys: [{ amount: 30 }] }, { code: "B", buys: [{ amount: 30 }] }] },
    asOf: "2026-07-15", budget: 50, liveEnabled: false, coreByIndexGroup: { NDX100: "A" }
  });
  assert.equal(plan.action, "PAUSE");
  assert.ok(plan.candidates.length <= 2);
  assert.equal(plan.candidates.find(function (c) { return c.code === "B"; }).blockedBy.includes("INDEX_CORE_ONLY"), true);
  assert.ok(plan.candidates.every(function (c) { return c.proposedAmount === 0; }));
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

test("current portfolio regression stays paused and has complete metadata", function () {
  const funds = require("../../data/funds.json").funds;
  const plan = engine.buildRecommendationPlan({
    funds: funds,
    navCache: require("../../data/nav-cache.json"),
    portfolio: require("../../data/portfolio.json"),
    history: require("../../data/history.json"),
    asOf: "2026-07-16",
    budget: 50,
    liveEnabled: false
  });
  assert.equal(plan.action, "PAUSE");
  assert.equal(plan.signalHealth.status, "PAUSE");
  assert.equal(plan.portfolioRisk.unknownHoldings.length, 0);
  assert.ok(plan.candidates.filter(function (candidate) { return candidate.indexGroup === "NDX100"; }).length <= 1);
});
