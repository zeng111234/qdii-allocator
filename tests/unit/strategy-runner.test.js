const test = require("node:test");
const assert = require("node:assert/strict");
const runner = require("../../functions/strategy-runner");
const ledgerTools = require("../../lib/portfolio-ledger");

function createLedger() {
  return ledgerTools.createLedger([{
    id: "tx_1", type: "BUY", code: "A", tradeDate: "2026-06-01", settleDate: "2026-06-03",
    amount: 100, nav: 10, shares: 10, createdAt: "2026-06-01T00:00:00.000Z"
  }], { revision: 1, updatedAt: "2026-06-01T00:00:00.000Z" });
}

function market() {
  const rows = [];
  for (let i = 1; i <= 260; i++) rows.push({ date: "2026-" + String(Math.floor((i - 1) / 28) + 1).padStart(2, "0") + "-" + String((i - 1) % 28 + 1).padStart(2, "0"), nav: 10 + i / 100 });
  return {
    funds: [{ code: "A", name: "Fund A", type: "标普500", indexGroup: "SPX", status: "active", dailyLimit: 100, minPurchase: 10 }],
    navCache: { A: rows },
    asOf: rows[rows.length - 1].date
  };
}

test("backend plan is shadow-only and persists a user-scoped observation", function () {
  const next = runner.advanceUserState({
    ledger: createLedger(), decisionState: { riskAnchorValue: 100, cashBalance: 0 },
    strategyState: {}, market: market(), generatedAt: "2026-07-24T10:15:00.000Z"
  });
  assert.equal(next.schemaVersion, 1);
  assert.equal(next.latestPlan.action, "PAUSE");
  assert.equal(next.latestPlan.budget, 0);
  assert.equal(next.observations.length, 1);
  assert.equal(next.observations[0].date, next.latestPlan.asOf);
});

test("backend market loading rejects incomplete public datasets", async function () {
  await assert.rejects(function() {
    return runner.loadMarketData(async function() {
      return { ok: true, json: async function() { return {}; } };
    });
  }, /INVALID_MARKET_DATA/);
});
