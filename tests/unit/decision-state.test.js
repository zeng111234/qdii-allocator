const test = require("node:test");
const assert = require("node:assert/strict");

const decisionState = require("../../lib/decision-state");
const personalizedPlan = require("../../lib/personalized-plan");
const ledgerTools = require("../../lib/portfolio-ledger");

function buy(id, code, amount) {
  return {
    id: id,
    type: "BUY",
    code: code,
    tradeDate: "2026-07-01",
    amount: amount,
    nav: 1,
    shares: amount
  };
}

test("decision state normalization rejects missing or incomplete risk anchors", function () {
  assert.equal(decisionState.validateDecisionState(null).valid, false);
  assert.equal(decisionState.validateDecisionState({ schemaVersion: 2, revision: 1 }).valid, false);
  assert.throws(function () {
    decisionState.normalizeDecisionState({ schemaVersion: 2, revision: 1 });
  }, /INVALID_DECISION_STATE/);

  const complete = {
    schemaVersion: 2,
    revision: 1,
    updatedAt: "2026-08-12T00:00:00.000Z",
    riskAnchorValue: 1000,
    riskAnchorAt: "2026-08-01T00:00:00.000Z",
    riskAnchorLedgerRevision: 1,
    riskAnchorTransactionIds: [],
    cashBalance: 0
  };
  assert.equal(decisionState.validateDecisionState(Object.assign({}, complete, { updatedAt: "" })).valid, false);
  assert.equal(decisionState.validateDecisionState(Object.assign({}, complete, { riskAnchorAt: "" })).valid, false);
  assert.equal(decisionState.validateDecisionState(Object.assign({}, complete, { updatedAt: "not-a-date" })).valid, false);
  assert.equal(decisionState.validateDecisionState(Object.assign({}, complete, { riskAnchorAt: "2026-02-30" })).valid, false);
});

test("decision state normalization preserves the fields used by personalization", function () {
  const normalized = decisionState.normalizeDecisionState({
    schemaVersion: 2,
    revision: 3,
    updatedAt: "2026-08-12T00:00:00.000Z",
    riskAnchorValue: 1000,
    riskAnchorAt: "2026-08-01T00:00:00.000Z",
    riskAnchorLedgerRevision: 4,
    riskAnchorTransactionIds: ["b", "a", "a"],
    riskProfile: "aggressive",
    cashBalance: 20
  });

  assert.deepEqual(normalized.riskAnchorTransactionIds, ["a", "b"]);
  assert.equal(normalized.riskProfile, "AGGRESSIVE");
  assert.equal(normalized.cashBalance, 20);
  assert.equal(normalized.riskAnchorLedgerRevision, 4);
});

test("missing decision state fails closed and removes base shadow candidates", function () {
  const plan = personalizedPlan.buildPersonalizedPlan({
    basePlan: {
      asOf: "2026-08-12",
      action: "PAUSE",
      candidates: [{ code: "SHADOW", proposedAmount: 0 }],
      dataFreshness: { status: "FRESH", maxTradingDayLag: 0 }
    },
    ledger: null,
    decisionState: null
  });

  assert.equal(plan.action, "HARD_PAUSE");
  assert.equal(plan.budget, 0);
  assert.deepEqual(plan.candidates, []);
  assert.deepEqual(plan.executionRoutes, []);
  assert.ok(plan.pauseReasons.includes("PRIVATE_LEDGER_MISSING"));
  assert.ok(plan.pauseReasons.includes("DECISION_STATE_MISSING"));

  const validLedger = ledgerTools.createLedger([buy("a", "SPX", 100)], {
    revision: 1,
    updatedAt: "2026-08-12T00:00:00.000Z"
  });
  const invalidStatePlan = personalizedPlan.buildPersonalizedPlan({
    basePlan: plan,
    ledger: validLedger,
    decisionState: { schemaVersion: 2, revision: 1 }
  });
  assert.equal(invalidStatePlan.action, "HARD_PAUSE");
  assert.deepEqual(invalidStatePlan.candidates, []);
  assert.ok(invalidStatePlan.pauseReasons.includes("DECISION_STATE_INVALID"));
});

test("personalized execution routes replace base shadow candidates", function () {
  const ledger = ledgerTools.createLedger([
    buy("spx", "SPX", 700),
    buy("ndx", "NDX", 100),
    buy("jp", "JP", 100),
    buy("med", "MED", 100)
  ], { revision: 4, updatedAt: "2026-08-12T00:00:00.000Z" });
  const funds = [
    { code: "SPX", name: "标普通道", indexGroup: "SPX500", status: "active", dailyLimit: 20, minPurchase: 10, feeRate: 0.6 },
    { code: "NDX", name: "纳指通道", indexGroup: "NDX100", status: "active", dailyLimit: 20, minPurchase: 10, feeRate: 0.8 },
    { code: "JP", name: "日本通道", indexGroup: "JAPAN", status: "active", dailyLimit: 20, minPurchase: 10, feeRate: 0.9 },
    { code: "MED", name: "医疗通道", indexGroup: "GLOBAL_MEDICAL", status: "active", dailyLimit: 20, minPurchase: 10, feeRate: 0.8 }
  ];
  const navCache = Object.fromEntries(funds.map(function (fund) {
    return [fund.code, [{ date: "2026-08-12", nav: 1 }]];
  }));
  const plan = personalizedPlan.buildPersonalizedPlan({
    basePlan: {
      asOf: "2026-08-12",
      date: "2026-08-12",
      action: "PAUSE",
      pauseReasons: ["ACCEPTANCE_GATE"],
      candidates: [{ code: "SHADOW", proposedAmount: 0 }],
      ranked: [{ code: "SHADOW", proposedAmount: 0 }],
      dataFreshness: { status: "FRESH", maxTradingDayLag: 0 },
      signalHealth: { status: "WARMING_UP" },
      liveAcceptance: { passed: false }
    },
    ledger: ledger,
    decisionState: {
      schemaVersion: 2,
      revision: 1,
      updatedAt: "2026-08-12T00:00:00.000Z",
      riskAnchorValue: 1000,
      riskAnchorAt: "2026-08-12T00:00:00.000Z",
      riskAnchorLedgerRevision: 4,
      riskAnchorTransactionIds: ledger.transactions.map(function (transaction) { return transaction.id; }),
      riskProfile: "AGGRESSIVE",
      cashBalance: 0
    },
    funds: funds,
    navCache: navCache,
    asOf: "2026-08-12"
  });

  assert.equal(plan.personalized, true);
  assert.ok(plan.executionRoutes.length > 0);
  assert.deepEqual(
    plan.candidates.map(function (candidate) { return candidate.code; }),
    plan.executionRoutes.map(function (route) { return route.code; })
  );
  assert.equal(plan.candidates.some(function (candidate) { return candidate.code === "SHADOW"; }), false);
  assert.equal(plan.candidates.every(function (candidate) { return candidate.proposedAmount > 0; }), true);
  const text = personalizedPlan.formatPersonalizedPlan(plan);
  assert.match(text, /NDX/);
  assert.match(text, /20元/);
  assert.doesNotMatch(text, /影子候选/);
});

test("personalized plan wrapper forwards the configured NAV freshness limit", function () {
  const ledger = ledgerTools.createLedger([
    buy("spx", "SPX", 700),
    buy("ndx", "NDX", 100),
    buy("jp", "JP", 100),
    buy("med", "MED", 100)
  ], { revision: 4, updatedAt: "2026-08-12T00:00:00.000Z" });
  const funds = [
    { code: "SPX", name: "标普通道", indexGroup: "SPX500", status: "active", dailyLimit: 20, minPurchase: 10 },
    { code: "NDX", name: "纳指通道", indexGroup: "NDX100", status: "active", dailyLimit: 20, minPurchase: 10 },
    { code: "JP", name: "日本通道", indexGroup: "JAPAN", status: "active", dailyLimit: 20, minPurchase: 10 },
    { code: "MED", name: "医疗通道", indexGroup: "GLOBAL_MEDICAL", status: "active", dailyLimit: 20, minPurchase: 10 }
  ];
  const navCache = Object.fromEntries(funds.map(function (fund) {
    return [fund.code, [{ date: "2026-08-11", nav: 1 }]];
  }));
  const plan = personalizedPlan.buildPersonalizedPlan({
    basePlan: {
      date: "2026-08-12",
      action: "PAUSE",
      dataFreshness: { status: "FRESH", maxTradingDayLag: 1 },
      signalHealth: { status: "WARMING_UP" },
      liveAcceptance: { passed: false }
    },
    ledger: ledger,
    decisionState: {
      schemaVersion: 2,
      revision: 1,
      updatedAt: "2026-08-12T00:00:00.000Z",
      riskAnchorValue: 1000,
      riskAnchorAt: "2026-08-12T00:00:00.000Z",
      riskAnchorLedgerRevision: 4,
      riskAnchorTransactionIds: ledger.transactions.map(function (transaction) { return transaction.id; }),
      cashBalance: 0
    },
    funds: funds,
    navCache: navCache,
    policy: { maxFreshnessLag: 0 },
    asOf: "2026-08-12"
  });

  assert.equal(plan.action, "HARD_PAUSE");
  assert.ok(plan.pauseReasons.includes("HOLDING_NAV_STALE:SPX"));
});
