const test = require("node:test");
const assert = require("node:assert/strict");

const ledger = require("../../lib/portfolio-ledger");

test("legacy portfolio migration creates stable immutable transactions without changing totals", function () {
  const legacy = {
    holdings: [
      { code: "A", name: "Fund A", buys: [
        { date: "2026-01-02", settleDate: "2026-01-06", amount: 10, nav: 2, shares: 5 },
        { date: "2026-01-02", settleDate: "2026-01-06", amount: 10, nav: 2, shares: 5 }
      ] },
      { code: "B", name: "Fund B", buys: [
        { date: "2026-01-03", amount: 25, nav: 5, shares: 5 }
      ] }
    ]
  };

  const first = ledger.migrateLegacyPortfolio(legacy, { revision: 1, updatedAt: "2026-07-17T00:00:00.000Z" });
  const second = ledger.migrateLegacyPortfolio(legacy, { revision: 1, updatedAt: "2026-07-17T00:00:00.000Z" });
  assert.equal(first.schemaVersion, 2);
  assert.equal(first.transactions.length, 3);
  assert.equal(new Set(first.transactions.map(function (tx) { return tx.id; })).size, 3);
  assert.deepEqual(first.transactions, second.transactions);
  assert.equal(first.checksum, second.checksum);
  assert.equal(ledger.derivePortfolio(first).totalInvested, 45);
  assert.equal(ledger.validateLedger(first).valid, true);
});

test("ledger rejects duplicate ids and revision conflicts instead of silently merging", function () {
  const base = ledger.createLedger([{ id: "tx-1", type: "BUY", code: "A", tradeDate: "2026-01-02", amount: 10, nav: 2, shares: 5 }], {
    revision: 3,
    updatedAt: "2026-07-17T00:00:00.000Z"
  });
  assert.throws(function () { ledger.appendTransactions(base, [base.transactions[0]], 3); }, /DUPLICATE_TRANSACTION/);
  assert.throws(function () { ledger.appendTransactions(base, [], 2); }, /REVISION_CONFLICT/);
});

test("migration preview exposes fund count transaction count total and checksum", function () {
  const result = ledger.previewSources({
    chrome: { holdings: [{ code: "A", buys: [{ date: "2026-01-02", amount: 10, nav: 2, shares: 5 }] }] },
    firebase: { holdings: [] },
    repository: { holdings: [{ code: "B", buys: [{ date: "2026-01-02", amount: 20, nav: 4, shares: 5 }] }] }
  });
  assert.equal(result.chrome.fundCount, 1);
  assert.equal(result.chrome.transactionCount, 1);
  assert.equal(result.chrome.totalInvested, 10);
  assert.match(result.chrome.checksum, /^[a-f0-9]{64}$/);
  assert.equal(result.allEqual, false);
});

test("stable transaction ids do not depend on Chrome holding order", function () {
  const left = { holdings: [
    { code: "B", buys: [{ date: "2026-01-03", amount: 20, nav: 4, shares: 5 }] },
    { code: "A", buys: [{ date: "2026-01-02", amount: 10, nav: 2, shares: 5 }] }
  ] };
  const right = { holdings: left.holdings.slice().reverse() };
  const options = { revision: 1, updatedAt: "2026-07-17T00:00:00.000Z" };
  assert.equal(ledger.migrateLegacyPortfolio(left, options).checksum, ledger.migrateLegacyPortfolio(right, options).checksum);
});

test("zero-share buys stay visible as pending reconciliation instead of becoming fake holdings", function () {
  const source = ledger.createLedger([
    { id: "settled", type: "BUY", code: "A", tradeDate: "2026-07-01", amount: 100, nav: 10, shares: 10 },
    { id: "pending", type: "BUY", code: "B", tradeDate: "2026-07-16", amount: 50, nav: 0, shares: 0 }
  ], { revision: 2, updatedAt: "2026-07-17T00:00:00.000Z" });

  const portfolio = ledger.derivePortfolio(source);
  assert.deepEqual(portfolio.holdings.map(function (holding) { return holding.code; }), ["A"]);
  assert.equal(portfolio.pendingHoldings.length, 1);
  assert.equal(portfolio.pendingHoldings[0].code, "B");
  assert.equal(portfolio.pendingInvested, 50);
  assert.equal(portfolio.confirmedInvested, 100);
  assert.equal(portfolio.totalInvested, 150);
});
