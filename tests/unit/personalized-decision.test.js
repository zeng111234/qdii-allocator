const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

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

function acceptedPersonalizedBase() {
  return Object.assign({}, pausedBasePlan, {
    action: "BUY",
    pauseReasons: [],
    signalHealth: { status: "HEALTHY" },
    liveAcceptance: {
      passed: true,
      metrics: { strategyId: decision.PERSONALIZED_STRATEGY_ID }
    }
  });
}

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
  assert.equal(plan.recommendationBasis, "SP500_BASELINE_FALLBACK");
  assert.equal(plan.expectedEdge, "MATCH_BASELINE_NOT_ALPHA");
  assert.equal(plan.syncRevision, 3);
  assert.equal(plan.portfolioRisk.holdingCount, 4);
  assert.equal(plan.bucketExposure.GROWTH_TECH, 0.7);
  assert.equal(plan.budget, 10);
  assert.deepEqual(plan.executionRoutes.map(function (route) { return [route.code, route.amount, route.bucket]; }), [
    ["SPX", 10, "US_BROAD"]
  ]);
  assert.equal(plan.executionRoutes.some(function (route) { return route.bucket === "GROWTH_TECH"; }), false);
  assert.equal(plan.budgetPolicy.tacticalWeeklyBudget, 50);
  assert.equal(decision.isCoreIndexGroup("SPX500"), true);
  assert.equal(decision.isCoreIndexGroup("GLOBAL_MFG"), false);
});

test("aggressive profile uses strategic beta DCA for an underweight held Nasdaq core", function () {
  const sourceLedger = ledger([
    buy("1", "SPX", "2026-07-01", 700, 700),
    buy("2", "NDX", "2026-07-01", 100, 100),
    buy("3", "JP", "2026-07-01", 100, 100),
    buy("4", "MED", "2026-07-01", 100, 100)
  ]);
  const plan = decision.personalizePlan(baseInput({
    ledger: sourceLedger,
    portfolio: decision.derivePortfolio(sourceLedger),
    decisionState: { schemaVersion: 2, revision: 2, riskAnchorValue: 1000, cashBalance: 0, riskProfile: "AGGRESSIVE" }
  }));
  assert.equal(plan.action, "STRATEGIC_DCA");
  assert.equal(plan.decisionMode, "AGGRESSIVE_BETA_DCA");
  assert.equal(plan.riskProfile, "AGGRESSIVE");
  assert.equal(plan.recommendationBasis, "AGGRESSIVE_TARGET_ALLOCATION");
  assert.equal(plan.expectedEdge, "HIGHER_EXPECTED_BETA_NOT_PROVEN_ALPHA");
  assert.equal(plan.budget, 20);
  assert.deepEqual(plan.targetBuckets, {
    US_BROAD: 0.50,
    GROWTH_TECH: 0.35,
    NON_US: 0.05,
    DEFENSIVE: 0.10,
    CASH: 0
  });
  assert.deepEqual(plan.executionRoutes.map(function (route) { return [route.code, route.amount, route.bucket]; }), [
    ["NDX", 20, "GROWTH_TECH"]
  ]);
  assert.match(plan.executionRoutes[0].reason, /不是择时超额/);
  assert.ok(plan.pauseReasons.includes("ALPHA_GATE_NOT_PASSED"));
  assert.ok(plan.pauseReasons.includes("AGGRESSIVE_BETA_NOT_ALPHA"));
});

test("configured aggressive default applies without silently overwriting saved balanced preference", function () {
  const configured = decision.personalizePlan(baseInput({
    defaultRiskProfile: "AGGRESSIVE"
  }));
  assert.equal(configured.riskProfile, "AGGRESSIVE");
  assert.equal(configured.action, "STRATEGIC_DCA");

  const savedBalanced = decision.personalizePlan(baseInput({
    defaultRiskProfile: "AGGRESSIVE",
    decisionState: { schemaVersion: 2, revision: 2, riskAnchorValue: 1000, cashBalance: 0, riskProfile: "BALANCED" }
  }));
  assert.equal(savedBalanced.riskProfile, "BALANCED");
  assert.equal(savedBalanced.action, "TACTICAL_PAUSE");
});

test("aggressive profile still blocks growth at its declared drawdown stop", function () {
  const sourceLedger = ledger([
    buy("1", "SPX", "2026-07-01", 700, 700),
    buy("2", "NDX", "2026-07-01", 100, 100),
    buy("3", "JP", "2026-07-01", 100, 100),
    buy("4", "MED", "2026-07-01", 100, 100)
  ]);
  const plan = decision.personalizePlan(baseInput({
    ledger: sourceLedger,
    portfolio: decision.derivePortfolio(sourceLedger),
    decisionState: { schemaVersion: 2, revision: 2, riskAnchorValue: 1140, cashBalance: 0, riskProfile: "AGGRESSIVE" }
  }));
  assert.equal(plan.action, "STRATEGIC_DCA");
  assert.equal(plan.riskLimits.growthStopDrawdown, -0.12);
  assert.equal(plan.executionRoutes.some(function (route) { return route.bucket === "GROWTH_TECH"; }), false);
  assert.equal(plan.budget, 0);
});

test("aggressive all-stop reports its own minus 15 percent threshold", function () {
  const sourceLedger = ledger([
    buy("1", "SPX", "2026-07-01", 700, 700),
    buy("2", "NDX", "2026-07-01", 100, 100),
    buy("3", "JP", "2026-07-01", 100, 100),
    buy("4", "MED", "2026-07-01", 100, 100)
  ]);
  const plan = decision.personalizePlan(baseInput({
    ledger: sourceLedger,
    portfolio: decision.derivePortfolio(sourceLedger),
    decisionState: { schemaVersion: 2, revision: 2, riskAnchorValue: 1180, cashBalance: 0, riskProfile: "AGGRESSIVE" }
  }));
  assert.equal(plan.action, "HARD_PAUSE");
  assert.equal(plan.decisionMode, "RISK_STOP");
  assert.ok(plan.pauseReasons.includes("RISK_ANCHOR_DRAWDOWN_15"));
  assert.equal(plan.pauseReasons.includes("RISK_ANCHOR_DRAWDOWN_10"), false);
});

test("unproven active selection falls back only to an existing S&P 500 channel", function () {
  const sourceLedger = ledger([
    buy("1", "SPX", "2026-07-01", 100, 100),
    buy("2", "JP", "2026-07-01", 600, 600),
    buy("3", "MED", "2026-07-01", 300, 300)
  ]);
  const plan = decision.personalizePlan(baseInput({
    ledger: sourceLedger,
    portfolio: decision.derivePortfolio(sourceLedger)
  }));
  assert.equal(plan.decisionMode, "BASELINE_DCA");
  assert.deepEqual(plan.executionRoutes.map(function (route) { return route.indexGroup; }), ["SPX500"]);
  assert.match(plan.executionRoutes[0].reason, /标普500基准/);
});

test("baseline fallback never treats S&P 500 equal weight as the market-cap benchmark", function () {
  const mixedFunds = funds.concat([
    { code: "SPX_EQ", name: "标普500等权通道", indexGroup: "SPX500_EQUAL_WEIGHT", status: "active", dailyLimit: 20, minPurchase: 10, feeRate: 0.1 }
  ]);
  const mixedNavCache = Object.assign({}, navCache, {
    SPX_EQ: [{ date: "2026-07-17", nav: 1 }]
  });
  const sourceLedger = ledger([
    buy("1", "SPX", "2026-07-01", 100, 100),
    buy("2", "SPX_EQ", "2026-07-01", 100, 100),
    buy("3", "JP", "2026-07-01", 500, 500),
    buy("4", "MED", "2026-07-01", 300, 300)
  ]);
  const plan = decision.personalizePlan(baseInput({
    ledger: sourceLedger,
    portfolio: decision.derivePortfolio(sourceLedger),
    funds: mixedFunds,
    navCache: mixedNavCache
  }));
  assert.equal(decision.bucketForFund(mixedFunds[mixedFunds.length - 1]), "US_BROAD");
  assert.equal(decision.isCoreIndexGroup("SPX500_EQUAL_WEIGHT"), false);
  assert.deepEqual(plan.executionRoutes.map(function (route) { return route.code; }), ["SPX"]);
});

test("baseline fallback never opens a new market-cap S&P channel", function () {
  const mixedFunds = funds.concat([
    { code: "SPX_EQ", name: "标普500等权通道", indexGroup: "SPX500_EQUAL_WEIGHT", status: "active", dailyLimit: 20, minPurchase: 10, feeRate: 0.1 }
  ]);
  const mixedNavCache = Object.assign({}, navCache, {
    SPX_EQ: [{ date: "2026-07-17", nav: 1 }]
  });
  const sourceLedger = ledger([
    buy("1", "SPX_EQ", "2026-07-01", 100, 100),
    buy("2", "JP", "2026-07-01", 600, 600),
    buy("3", "MED", "2026-07-01", 300, 300)
  ]);
  const plan = decision.personalizePlan(baseInput({
    ledger: sourceLedger,
    portfolio: decision.derivePortfolio(sourceLedger),
    funds: mixedFunds,
    navCache: mixedNavCache
  }));
  assert.equal(plan.decisionMode, "BASELINE_DCA");
  assert.deepEqual(plan.executionRoutes, []);
  assert.equal(plan.budget, 0);
  assert.equal(plan.routeDiagnostics.eligibleHeldChannelCount, 0);
  assert.equal(plan.routeDiagnostics.eligibleNewChannelCount, 0);
});

test("strategic fallback never opens an unheld growth channel", function () {
  const sourceLedger = ledger([
    buy("1", "SPX", "2026-07-01", 700, 700),
    buy("2", "JP", "2026-07-01", 200, 200),
    buy("3", "MED", "2026-07-01", 100, 100)
  ]);
  const plan = decision.personalizePlan(baseInput({
    ledger: sourceLedger,
    portfolio: decision.derivePortfolio(sourceLedger),
    decisionState: { schemaVersion: 2, revision: 2, riskAnchorValue: 1000, cashBalance: 0, riskProfile: "AGGRESSIVE" }
  }));
  assert.equal(plan.decisionMode, "AGGRESSIVE_BETA_DCA");
  assert.deepEqual(plan.executionRoutes, []);
  assert.equal(plan.budget, 0);
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

test("same-day pending buy consumes both the mode daily budget and weekly budget", function () {
  const sourceLedger = ledger([
    buy("1", "SPX", "2026-07-01", 100, 100),
    buy("2", "NDX", "2026-07-01", 700, 700),
    buy("3", "JP", "2026-07-01", 100, 100),
    buy("4", "MED", "2026-07-01", 100, 100),
    buy("5", "SPX", "2026-07-18", 40, 0)
  ]);
  const portfolio = decision.derivePortfolio(sourceLedger);
  const metrics = decision.portfolioMetrics(portfolio, funds, navCache, 0);
  const plan = decision.personalizePlan(baseInput({
    ledger: sourceLedger,
    portfolio: portfolio
  }));

  assert.equal(plan.weeklySpent, 40);
  assert.equal(plan.dailySpent, 40);
  assert.equal(plan.budget, 0);
  assert.equal(plan.budgetPolicy.dailyRemaining, 0);
  assert.deepEqual(plan.routeDiagnostics.blockReasons, ["DAILY_BUDGET_EXHAUSTED"]);
  assert.equal(plan.portfolioRisk.currentValue, 1000);
  assert.equal(plan.bucketExposure.US_BROAD, 0.1);
  assert.equal(metrics.holdingValues.SPX, 100);
  assert.equal(metrics.holdingValues.SPX / metrics.totalValue, 0.1);
  assert.equal(metrics.groupValues.SPX500 / metrics.totalValue, 0.1);
  assert.equal(plan.riskAnchorDrawdown, 0);
});

test("an overdue unresolved pending buy hard-pauses personalized execution", function () {
  const sourceLedger = ledger([
    buy("1", "SPX", "2026-07-01", 100, 100),
    buy("2", "NDX", "2026-07-01", 700, 700),
    buy("3", "JP", "2026-07-01", 100, 100),
    buy("4", "MED", "2026-07-01", 100, 100),
    buy("5", "SPX", "2026-07-14", 50, 0)
  ]);
  const portfolio = decision.derivePortfolio(sourceLedger);
  const plan = decision.personalizePlan(baseInput({
    ledger: sourceLedger,
    portfolio: portfolio
  }));

  assert.equal(plan.action, "HARD_PAUSE");
  assert.equal(plan.budget, 0);
  assert.ok(plan.pauseReasons.includes("PENDING_RECONCILIATION_OVERDUE:SPX"));
});

test("same-day confirmed and pending buys both reduce the remaining daily recommendation", function () {
  const sourceLedger = ledger([
    buy("1", "SPX", "2026-07-01", 100, 100),
    buy("2", "NDX", "2026-07-01", 700, 700),
    buy("3", "JP", "2026-07-01", 100, 100),
    buy("4", "MED", "2026-07-01", 100, 100),
    buy("5", "SPX", "2026-07-18", 6, 6),
    buy("6", "SPX", "2026-07-18", 4, 0)
  ]);
  const plan = decision.personalizePlan(baseInput({
    ledger: sourceLedger,
    portfolio: decision.derivePortfolio(sourceLedger),
    signalConfirmation: { status: "CONFIRMED", fresh: true, reason: "fresh" }
  }));

  assert.equal(plan.dailySpent, 10);
  assert.equal(plan.budgetPolicy.dailyLimit, 20);
  assert.equal(plan.budgetPolicy.dailyRemaining, 10);
  assert.equal(plan.budget, 10);
  assert.deepEqual(plan.executionRoutes.map(function (route) { return [route.code, route.amount]; }), [["SPX", 10]]);
});

test("a fund already at its purchase limit today is not recommended again", function () {
  const liveBase = acceptedPersonalizedBase();
  const sourceLedger = ledger([
    buy("1", "SPX", "2026-07-01", 100, 100),
    buy("2", "NDX", "2026-07-01", 700, 700),
    buy("3", "JP", "2026-07-01", 100, 100),
    buy("4", "MED", "2026-07-01", 100, 100),
    buy("5", "SPX", "2026-07-18", 20, 0)
  ]);
  const plan = decision.personalizePlan(baseInput({
    basePlan: liveBase,
    ledger: sourceLedger,
    portfolio: decision.derivePortfolio(sourceLedger),
    policy: {
      targetBuckets: { US_BROAD: 0.5, GROWTH_TECH: 0.7, NON_US: 0.1, DEFENSIVE: 0.1, CASH: 0 }
    }
  }));

  assert.equal(plan.dailySpentByFund.SPX, 20);
  assert.equal(plan.executionRoutes.some(function (route) { return route.code === "SPX"; }), false);
  assert.equal(plan.budget, 0);
});

test("confirmed holdings without a usable NAV hard-pause instead of using cost as market value", function () {
  const missingNavCache = Object.assign({}, navCache);
  delete missingNavCache.NDX;
  const input = baseInput({ navCache: missingNavCache });
  const metrics = decision.portfolioMetrics(input.portfolio, funds, missingNavCache, 0, input.asOf, 2);
  const plan = decision.personalizePlan(input);

  assert.equal(metrics.holdingValues.NDX, null);
  assert.equal(metrics.investedValue, 300);
  assert.equal(plan.portfolioRisk.currentValue, null);
  assert.equal(plan.portfolioRisk.valuedSubtotal, 300);
  assert.equal(plan.riskAnchorDrawdown, null);
  assert.equal(plan.action, "HARD_PAUSE");
  assert.ok(plan.pauseReasons.includes("HOLDING_NAV_MISSING:NDX"));
});

test("confirmed holdings with stale or invalid NAV data hard-pause", function () {
  const freshDate = "2026-07-20";
  const freshRows = {
    SPX: [{ date: "2026-07-14", nav: 1 }],
    NDX: [{ date: freshDate, nav: 1 }],
    JP: [{ date: freshDate, nav: 1 }],
    MED: [{ date: freshDate, nav: 1 }],
    GLOBAL: [{ date: freshDate, nav: 1 }]
  };
  const freshBase = Object.assign({}, pausedBasePlan, {
    date: freshDate,
    dataFreshness: { status: "FRESH", latestNavDate: freshDate, maxTradingDayLag: 0 }
  });
  const stale = decision.personalizePlan(baseInput({
    basePlan: freshBase,
    navCache: freshRows,
    asOf: freshDate
  }));
  assert.equal(stale.action, "HARD_PAUSE");
  assert.ok(stale.pauseReasons.includes("HOLDING_NAV_STALE:SPX"));

  const invalid = decision.personalizePlan(baseInput({
    basePlan: freshBase,
    navCache: Object.assign({}, freshRows, { SPX: [{ date: freshDate, nav: 0 }] }),
    asOf: freshDate
  }));
  assert.equal(invalid.action, "HARD_PAUSE");
  assert.ok(invalid.pauseReasons.includes("HOLDING_NAV_INVALID:SPX"));

  const future = decision.personalizePlan(baseInput({
    basePlan: freshBase,
    navCache: Object.assign({}, freshRows, { SPX: [{ date: "2026-07-21", nav: 1 }] }),
    asOf: freshDate
  }));
  assert.equal(future.action, "HARD_PAUSE");
  assert.ok(future.pauseReasons.includes("HOLDING_NAV_FUTURE:SPX"));
});

test("multi-wrapper routes share bucket, group, and fund capacity already planned today", function () {
  const liveBase = acceptedPersonalizedBase();
  const secondWrapper = { code: "SPX2", name: "备用标普通道", indexGroup: "SPX500", status: "active", dailyLimit: 50, minPurchase: 1, feeRate: 0.7 };
  const expandedFunds = funds.map(function (fund) {
    return Object.assign({}, fund, { dailyLimit: 50, minPurchase: 1 });
  }).concat(secondWrapper);
  const expandedNav = Object.assign({}, navCache, { SPX2: [{ date: "2026-07-17", nav: 1 }] });

  const bucketLedger = ledger([
    buy("1", "SPX", "2026-07-01", 145, 145),
    buy("2", "SPX2", "2026-07-01", 145, 145),
    buy("3", "NDX", "2026-07-01", 250, 250),
    buy("4", "JP", "2026-07-01", 260, 260),
    buy("5", "MED", "2026-07-01", 200, 200)
  ]);
  const bucketPlan = decision.personalizePlan(baseInput({
    basePlan: liveBase,
    ledger: bucketLedger,
    portfolio: decision.derivePortfolio(bucketLedger),
    funds: expandedFunds,
    navCache: expandedNav
  }));
  const bucketAmount = bucketPlan.executionRoutes.filter(function (route) { return route.bucket === "US_BROAD"; })
    .reduce(function (sum, route) { return sum + route.amount; }, 0);
  assert.ok(bucketAmount > 10);
  assert.ok((290 + bucketAmount) / (1000 + bucketAmount) <= 0.300001);

  const groupLedger = ledger([
    buy("1", "SPX", "2026-07-01", 170, 170),
    buy("2", "SPX2", "2026-07-01", 170, 170),
    buy("3", "NDX", "2026-07-01", 200, 200),
    buy("4", "JP", "2026-07-01", 260, 260),
    buy("5", "MED", "2026-07-01", 200, 200)
  ]);
  const groupPlan = decision.personalizePlan(baseInput({
    basePlan: liveBase,
    ledger: groupLedger,
    portfolio: decision.derivePortfolio(groupLedger),
    funds: expandedFunds,
    navCache: expandedNav,
    policy: {
      targetBuckets: { US_BROAD: 0.5, GROWTH_TECH: 0.2, NON_US: 0.2, DEFENSIVE: 0.1, CASH: 0 }
    }
  }));
  const groupAmount = groupPlan.executionRoutes.filter(function (route) { return route.indexGroup === "SPX500"; })
    .reduce(function (sum, route) { return sum + route.amount; }, 0);
  assert.ok((340 + groupAmount) / (1000 + groupAmount) <= 0.350001);

  const duplicateFundLedger = ledger([
    buy("1", "SPX", "2026-07-01", 190, 190),
    buy("2", "NDX", "2026-07-01", 200, 200),
    buy("3", "JP", "2026-07-01", 310, 310),
    buy("4", "MED", "2026-07-01", 300, 300)
  ]);
  const duplicateFund = Object.assign({}, expandedFunds[0], { dailyLimit: 50, minPurchase: 1 });
  const fundPlan = decision.personalizePlan(baseInput({
    basePlan: liveBase,
    ledger: duplicateFundLedger,
    portfolio: decision.derivePortfolio(duplicateFundLedger),
    funds: [duplicateFund, duplicateFund].concat(expandedFunds.slice(1, 5)),
    navCache: expandedNav,
    policy: {
      maxIndexGroupWeight: 0.8,
      targetBuckets: { US_BROAD: 0.5, GROWTH_TECH: 0.2, NON_US: 0.2, DEFENSIVE: 0.1, CASH: 0 }
    }
  }));
  const fundAmount = fundPlan.executionRoutes.filter(function (route) { return route.code === "SPX"; })
    .reduce(function (sum, route) { return sum + route.amount; }, 0);
  assert.ok((190 + fundAmount) / (1000 + fundAmount) <= 0.200001);
});

test("bucket capacity solves the post-purchase target weight exactly", function () {
  const sourceLedger = ledger([buy("1", "SPX", "2026-07-01", 10, 10)]);
  const oneFund = [{
    code: "SPX", name: "标普通道", indexGroup: "SPX500", status: "active",
    dailyLimit: 100, minPurchase: 1, feeRate: 0.1
  }];
  const plan = decision.personalizePlan(baseInput({
    basePlan: acceptedPersonalizedBase(),
    ledger: sourceLedger,
    portfolio: decision.derivePortfolio(sourceLedger),
    decisionState: { schemaVersion: 1, revision: 1, riskAnchorValue: 10, cashBalance: 90 },
    funds: oneFund,
    navCache: { SPX: [{ date: "2026-07-17", nav: 1 }] },
    policy: {
      maxDailyBudget: 100,
      maxWeeklyBudget: 250,
      maxFundWeight: 0.9,
      maxIndexGroupWeight: 0.9,
      targetBuckets: { US_BROAD: 0.5, GROWTH_TECH: 0, NON_US: 0, DEFENSIVE: 0, CASH: 0.5 }
    }
  }));

  assert.equal(plan.budget, 80);
  assert.equal((10 + plan.budget) / (100 + plan.budget), 0.5);
});

test("personalized NAV freshness uses the shared China trading calendar", function () {
  const metrics = decision.portfolioMetrics({
    holdings: [{ code: "SPX", totalShares: 10, buys: [{ amount: 10, nav: 1, shares: 10 }] }]
  }, [{ code: "SPX", indexGroup: "SPX500" }], {
    SPX: [{ date: "2026-02-13", nav: 1 }]
  }, 0, "2026-02-23", 2);

  assert.deepEqual(metrics.navIssues, []);
  assert.equal(metrics.holdingValues.SPX, 10);
});

test("browser personalized module consumes the generated holiday calendar without require", function () {
  const source = fs.readFileSync(path.join(__dirname, "..", "..", "lib", "personalized-decision.js"), "utf8");
  const browser = {
    tradingHolidays: [
      "2026-02-15", "2026-02-16", "2026-02-17", "2026-02-18", "2026-02-19",
      "2026-02-20", "2026-02-21", "2026-02-22", "2026-02-23"
    ]
  };
  vm.runInNewContext(source, browser);
  const metrics = browser.QdiiPersonalizedDecision.portfolioMetrics({
    holdings: [{ code: "SPX", totalShares: 10, buys: [{ amount: 10, nav: 1, shares: 10 }] }]
  }, [{ code: "SPX", indexGroup: "SPX500" }], {
    SPX: [{ date: "2026-02-13", nav: 1 }]
  }, 0, "2026-02-23", 2);

  assert.deepEqual(Array.from(metrics.navIssues), []);
  assert.equal(metrics.holdingValues.SPX, 10);
});

test("personalized plan candidates always match executable routes", function () {
  const plan = decision.personalizePlan(baseInput());
  assert.deepEqual(plan.candidates.map(function (candidate) {
    return [candidate.code, candidate.proposedAmount];
  }), plan.executionRoutes.map(function (route) {
    return [route.code, route.amount];
  }));

  const paused = decision.personalizePlan(baseInput({ decisionState: {} }));
  assert.equal(paused.action, "HARD_PAUSE");
  assert.deepEqual(paused.executionRoutes, []);
  assert.deepEqual(paused.candidates, []);
  assert.deepEqual(paused.ranked, []);
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
  assert.equal(plan.decisionMode, "BASELINE_DCA");
  assert.ok(plan.routeDiagnostics.blockReasons.includes("NO_ELIGIBLE_CORE_ROUTE"));
});

test("baseline DCA does not add market-cap S&P after the target bucket is full", function () {
  const expandedFunds = funds.concat([
    { code: "SPX2", name: "备用标普通道", indexGroup: "SPX500", status: "active", dailyLimit: 20, minPurchase: 10, feeRate: 0.7 }
  ]);
  const expandedNav = Object.assign({}, navCache, {
    SPX2: [{ date: "2026-07-17", nav: 1 }]
  });
  const sourceLedger = ledger([
    buy("1", "SPX", "2026-07-01", 300, 300),
    buy("2", "NDX", "2026-07-01", 250, 250),
    buy("3", "JP", "2026-07-01", 250, 250),
    buy("4", "MED", "2026-07-01", 200, 200)
  ]);
  const plan = decision.personalizePlan(baseInput({
    ledger: sourceLedger,
    portfolio: decision.derivePortfolio(sourceLedger),
    funds: expandedFunds,
    navCache: expandedNav
  }));
  assert.equal(plan.bucketExposure.US_BROAD, 0.3);
  assert.equal(plan.decisionMode, "BASELINE_DCA");
  assert.deepEqual(plan.executionRoutes, []);
  assert.equal(plan.budget, 0);
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
    SPX: [{ date: "2026-07-20", nav: 0.9 }],
    NDX: [{ date: "2026-07-20", nav: 0.9 }],
    JP: [{ date: "2026-07-20", nav: 0.9 }],
    MED: [{ date: "2026-07-20", nav: 0.9 }]
  });
  const plan = decision.personalizePlan(baseInput({
    ledger: sourceLedger,
    portfolio: decision.derivePortfolio(sourceLedger),
    navCache: lowerNav,
    asOf: "2026-07-20",
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
    basePlan: acceptedPersonalizedBase(),
    ledger: sourceLedger,
    portfolio: decision.derivePortfolio(sourceLedger),
    decisionState: { schemaVersion: 1, revision: 1, riskAnchorValue: 1100, cashBalance: 0 }
  }));
  assert.equal(plan.action, "BUY");
  assert.equal(plan.executionRoutes.some(function (route) { return route.bucket === "GROWTH_TECH"; }), false);
  assert.equal(plan.executionRoutes[0].bucket, "NON_US");
});

test("ranking evidence cannot unlock the different personalized execution strategy", function () {
  const plan = decision.personalizePlan(baseInput({
    basePlan: Object.assign({}, acceptedPersonalizedBase(), {
      liveAcceptance: {
        passed: true,
        metrics: { strategyId: "allocation-v2.4-monthly-alpha-gate" }
      }
    })
  }));

  assert.notEqual(plan.action, "BUY");
  assert.ok(plan.pauseReasons.includes("EXECUTION_STRATEGY_EVIDENCE_MISMATCH"));
  assert.equal(plan.strategyVersion, decision.PERSONALIZED_STRATEGY_ID);
});
