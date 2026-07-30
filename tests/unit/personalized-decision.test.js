const test = require("node:test");
const assert = require("node:assert/strict");

const decision = require("../../lib/personalized-decision");

function ledger(transactions, revision) {
  return {
    schemaVersion: 2,
    revision: revision || 3,
    updatedAt: "2026-07-18T00:00:00.000Z",
    transactions: transactions || []
  };
}

function buy(id, code, date, amount, shares) {
  return {
    id: id,
    type: "BUY",
    code: code,
    tradeDate: date,
    settleDate: date,
    amount: amount,
    nav: shares ? amount / shares : 0,
    shares: shares || 0,
    createdAt: date + "T00:00:00.000Z"
  };
}

function sell(id, code, date, amount, shares) {
  return {
    id: id,
    type: "SELL",
    code: code,
    tradeDate: date,
    settleDate: date,
    amount: amount,
    nav: shares ? amount / shares : 0,
    shares: shares || 0,
    createdAt: date + "T00:00:00.000Z"
  };
}

const funds = [
  { code: "SPX", name: "标普通道", indexGroup: "SPX500", status: "active", dailyLimit: 20, minPurchase: 10, feeRate: 0.6 },
  { code: "NDX", name: "纳指通道", indexGroup: "NDX100", status: "active", dailyLimit: 20, minPurchase: 10, feeRate: 0.8 },
  { code: "JP", name: "日本通道", indexGroup: "JAPAN", status: "active", dailyLimit: 20, minPurchase: 10, feeRate: 0.9 },
  { code: "MED", name: "医疗通道", indexGroup: "GLOBAL_MEDICAL", status: "active", dailyLimit: 20, minPurchase: 10, feeRate: 0.8 },
  { code: "GLOBAL", name: "全球通道", indexGroup: "GLOBAL", status: "active", dailyLimit: 20, minPurchase: 10, feeRate: 1.2 }
];

const navCache = {
  SPX: [{ date: "2026-07-17", nav: 1 }],
  NDX: [{ date: "2026-07-17", nav: 1 }],
  JP: [{ date: "2026-07-17", nav: 1 }],
  MED: [{ date: "2026-07-17", nav: 1 }],
  GLOBAL: [{ date: "2026-07-17", nav: 1 }]
};

const pausedBasePlan = {
  date: "2026-07-18",
  action: "PAUSE",
  pauseReasons: ["LIVE_DISABLED", "SIGNAL_BREAKER"],
  dataFreshness: { status: "FRESH", latestNavDate: "2026-07-17", maxTradingDayLag: 1 },
  signalHealth: { status: "PAUSE", breakerTriggered: true },
  ranked: [],
  allRanked: []
};

function baseInput(overrides) {
  const sourceLedger = ledger([
    buy("1", "SPX", "2026-07-01", 100, 100),
    buy("2", "NDX", "2026-07-01", 700, 700),
    buy("3", "JP", "2026-07-01", 100, 100),
    buy("4", "MED", "2026-07-01", 100, 100)
  ]);
  return Object.assign({
    basePlan: pausedBasePlan,
    ledger: sourceLedger,
    portfolio: decision.derivePortfolio(sourceLedger),
    decisionState: { schemaVersion: 1, revision: 1, riskAnchorValue: 1000, cashBalance: 0 },
    funds: funds,
    navCache: navCache,
    asOf: "2026-07-18",
    readOnly: false
  }, overrides || {});
}

test("missing sync or risk anchor is a hard pause", function () {
  const noLedger = decision.personalizePlan(baseInput({ ledger: null }));
  assert.equal(noLedger.action, "HARD_PAUSE");
  assert.equal(noLedger.budget, 0);
  assert.ok(noLedger.pauseReasons.includes("SYNC_REQUIRED"));

  const noAnchor = decision.personalizePlan(baseInput({ decisionState: null }));
  assert.equal(noAnchor.action, "HARD_PAUSE");
  assert.equal(noAnchor.decisionMode, "ACTION_REQUIRED");
  assert.equal(noAnchor.blockedStage, "RISK_ANCHOR_SETUP");
  assert.ok(noAnchor.pauseReasons.includes("RISK_ANCHOR_MISSING"));
});

test("signal breaker becomes capped tactical core DCA using the cloud ledger exposure", function () {
  const plan = decision.personalizePlan(baseInput());
  assert.equal(plan.action, "TACTICAL_PAUSE");
  assert.equal(plan.syncRevision, 3);
  assert.equal(plan.portfolioRisk.holdingCount, 4);
  assert.equal(plan.bucketExposure.GROWTH_TECH, 0.7);
  assert.equal(plan.budget, 10);
  assert.deepEqual(plan.executionRoutes.map(function (route) { return [route.code, route.amount, route.bucket]; }), [
    ["SPX", 10, "US_BROAD"]
  ]);
  assert.equal(plan.executionRoutes.some(function (route) { return route.bucket === "GROWTH_TECH"; }), false);
  assert.equal(plan.budgetPolicy.tacticalWeeklyBudget, 50);
});

test("read-only snapshots can calculate a plan but cannot make cloud writes", function () {
  const plan = decision.personalizePlan(baseInput({ readOnly: true }));
  assert.equal(plan.action, "TACTICAL_PAUSE");
  assert.equal(plan.budget, 10);
  assert.equal(plan.readOnly, true);
});

test("fresh cross-source positive confirmation can raise tactical core DCA to 20 yuan", function () {
  const plan = decision.personalizePlan(baseInput({
    signalConfirmation: { status: "CONFIRMED", fresh: true, reason: "新闻与外部主题均偏多" }
  }));
  assert.equal(plan.action, "TACTICAL_PAUSE");
  assert.equal(plan.budget, 20);
  assert.equal(plan.budgetPolicy.signalConfirmation.status, "CONFIRMED");
  assert.deepEqual(plan.executionRoutes.map(function (route) { return route.bucket; }), ["US_BROAD"]);
});

test("weekly tactical cap and risk anchor remain deterministic hard limits", function () {
  const sourceLedger = ledger([
    buy("1", "SPX", "2026-07-01", 100, 100),
    buy("2", "NDX", "2026-07-01", 700, 700),
    buy("3", "JP", "2026-07-01", 100, 100),
    buy("4", "MED", "2026-07-01", 100, 100),
    buy("5", "SPX", "2026-07-14", 40, 40)
  ]);
  const capped = decision.personalizePlan(baseInput({
    ledger: sourceLedger,
    portfolio: decision.derivePortfolio(sourceLedger)
  }));
  assert.equal(capped.weeklySpent, 40);
  assert.equal(capped.budget, 10);
  assert.equal(capped.budgetPolicy.tacticalWeeklyBudget, 50);

  const stopped = decision.personalizePlan(baseInput({
    decisionState: { schemaVersion: 1, revision: 2, riskAnchorValue: 1200, cashBalance: 0 }
  }));
  assert.equal(stopped.action, "HARD_PAUSE");
  assert.equal(stopped.budget, 0);
  assert.ok(stopped.pauseReasons.includes("RISK_ANCHOR_DRAWDOWN_10"));
});

test("tactical mode cuts daily amount to 10 yuan when market is overheated", function () {
  const plan = decision.personalizePlan(baseInput({
    marketTemperature: { temperature: 80, level: "偏热" }
  }));
  assert.equal(plan.action, "TACTICAL_PAUSE");
  assert.equal(plan.budget, 10);
  assert.equal(plan.budgetPolicy.overheatReduced, true);
});

test("tactical mode never adds to growth technology even when it is underweight", function () {
  const sourceLedger = ledger([
    buy("1", "SPX", "2026-07-01", 500, 500),
    buy("2", "NDX", "2026-07-01", 100, 100),
    buy("3", "JP", "2026-07-01", 300, 300),
    buy("4", "MED", "2026-07-01", 100, 100)
  ]);
  const plan = decision.personalizePlan(baseInput({
    ledger: sourceLedger,
    portfolio: decision.derivePortfolio(sourceLedger)
  }));
  assert.equal(plan.action, "TACTICAL_PAUSE");
  assert.equal(plan.budget, 0);
  assert.equal(plan.executionRoutes.length, 0);
  assert.equal(plan.decisionMode, "TACTICAL_DCA");
  assert.ok(plan.routeDiagnostics.blockReasons.includes("NO_ELIGIBLE_CORE_ROUTE"));
});

test("risk anchor drawdown removes post-anchor cash flows before applying a hard stop", function () {
  const sourceLedger = ledger([
    buy("1", "SPX", "2026-07-01", 100, 100),
    buy("2", "NDX", "2026-07-01", 700, 700),
    buy("3", "JP", "2026-07-01", 100, 100),
    buy("4", "MED", "2026-07-01", 100, 100),
    buy("5", "SPX", "2026-07-19", 100, 100)
  ]);
  const lowerNav = Object.assign({}, navCache, {
    SPX: [{ date: "2026-07-19", nav: 0.9 }],
    NDX: [{ date: "2026-07-19", nav: 0.9 }],
    JP: [{ date: "2026-07-19", nav: 0.9 }],
    MED: [{ date: "2026-07-19", nav: 0.9 }]
  });
  const plan = decision.personalizePlan(baseInput({
    ledger: sourceLedger,
    portfolio: decision.derivePortfolio(sourceLedger),
    navCache: lowerNav,
    decisionState: {
      schemaVersion: 2,
      revision: 1,
      riskAnchorValue: 1000,
      riskAnchorAt: "2026-07-18T00:00:00.000Z",
      riskAnchorLedgerRevision: 3,
      riskAnchorTransactionIds: ["1", "2", "3", "4"],
      cashBalance: 0
    }
  }));
  assert.equal(plan.adjustedRiskAnchorValue, 1100);
  assert.equal(plan.riskAnchorNetCashFlow, 100);
  assert.equal(plan.riskAnchorDrawdown, -0.1);
  assert.equal(plan.action, "HARD_PAUSE");
  assert.equal(plan.decisionMode, "RISK_STOP");
  assert.ok(plan.pauseReasons.includes("RISK_ANCHOR_DRAWDOWN_10"));
});

test("risk anchor treats post-anchor redemptions as negative net cash flow", function () {
  const sourceLedger = ledger([
    buy("1", "SPX", "2026-07-01", 1000, 1000),
    sell("2", "SPX", "2026-07-19", 100, 100)
  ]);
  const plan = decision.personalizePlan(baseInput({
    ledger: sourceLedger,
    portfolio: decision.derivePortfolio(sourceLedger),
    decisionState: {
      schemaVersion: 2,
      revision: 1,
      riskAnchorValue: 1000,
      riskAnchorAt: "2026-07-18T00:00:00.000Z",
      riskAnchorLedgerRevision: 3,
      riskAnchorTransactionIds: ["1"],
      cashBalance: 0
    }
  }));
  assert.equal(plan.riskAnchorNetCashFlow, -100);
  assert.equal(plan.adjustedRiskAnchorValue, 900);
  assert.equal(plan.riskAnchorDrawdown, 0);
});

test("global and global medical holdings map to explicit buckets", function () {
  const sourceLedger = ledger([
    buy("1", "GLOBAL", "2026-07-01", 100, 100),
    buy("2", "MED", "2026-07-01", 100, 100)
  ]);
  const plan = decision.personalizePlan(baseInput({
    ledger: sourceLedger,
    portfolio: decision.derivePortfolio(sourceLedger),
    decisionState: { schemaVersion: 1, revision: 1, riskAnchorValue: 200, cashBalance: 0 }
  }));
  assert.deepEqual(plan.portfolioRisk.unknownHoldings, []);
  assert.equal(plan.bucketExposure.NON_US, 0.5);
  assert.equal(plan.bucketExposure.DEFENSIVE, 0.5);
});

test("minus 7.5 percent anchor drawdown blocks growth even after live acceptance", function () {
  const sourceLedger = ledger([
    buy("1", "SPX", "2026-07-01", 700, 700),
    buy("2", "NDX", "2026-07-01", 100, 100),
    buy("3", "JP", "2026-07-01", 100, 100),
    buy("4", "MED", "2026-07-01", 100, 100)
  ]);
  const plan = decision.personalizePlan(baseInput({
    basePlan: Object.assign({}, pausedBasePlan, {
      action: "BUY",
      pauseReasons: [],
      signalHealth: { status: "HEALTHY" },
      liveAcceptance: { passed: true }
    }),
    ledger: sourceLedger,
    portfolio: decision.derivePortfolio(sourceLedger),
    decisionState: { schemaVersion: 1, revision: 1, riskAnchorValue: 1100, cashBalance: 0 }
  }));
  assert.equal(plan.action, "BUY");
  assert.equal(plan.executionRoutes.some(function (route) { return route.bucket === "GROWTH_TECH"; }), false);
  assert.equal(plan.executionRoutes[0].bucket, "NON_US");
});
