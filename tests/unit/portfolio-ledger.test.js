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

test("sell transactions reduce derived cost and shares instead of becoming buys", function () {
  const source = ledger.createLedger([
    { id: "buy", type: "BUY", code: "A", tradeDate: "2026-07-01", amount: 100, nav: 10, shares: 10 },
    { id: "sell", type: "SELL", code: "A", tradeDate: "2026-07-10", amount: 60, nav: 12, shares: 5 }
  ], { revision: 2, updatedAt: "2026-07-10T00:00:00.000Z" });

  const portfolio = ledger.derivePortfolio(source);
  assert.equal(portfolio.holdings[0].totalAmount, 40);
  assert.equal(portfolio.holdings[0].totalShares, 5);
  assert.equal(portfolio.holdings[0].buys[1].amount, -60);
  assert.equal(portfolio.holdings[0].buys[1].shares, -5);
  assert.equal(portfolio.confirmedInvested, 40);
});

test("ledger validation rejects semantic corruption and overselling", function () {
  const valid = ledger.createLedger([
    { id: "buy", type: "BUY", code: "A", tradeDate: "2026-07-01", amount: 100, nav: 10, shares: 10 }
  ], { revision: 1, updatedAt: "2026-07-01T00:00:00.000Z" });
  const invalidType = Object.assign({}, valid, {
    transactions: [Object.assign({}, valid.transactions[0], { type: "TRANSFER" })]
  });
  invalidType.checksum = ledger.checksumTransactions(invalidType.transactions);
  assert.equal(ledger.validateLedger(invalidType).valid, false);

  assert.throws(function () {
    ledger.createLedger([
      { id: "buy", type: "BUY", code: "A", tradeDate: "2026-07-01", amount: 100, nav: 10, shares: 10 },
      { id: "sell", type: "SELL", code: "A", tradeDate: "2026-07-02", amount: 120, nav: 10, shares: 12 }
    ], { revision: 2, updatedAt: "2026-07-02T00:00:00.000Z" });
  }, /NEGATIVE_HOLDING:A/);
});

test("sell transactions require positive amount, nav, and shares while pending buys remain valid", function () {
  const options = { revision: 1, updatedAt: "2026-07-01T00:00:00.000Z" };
  const pending = ledger.createLedger([
    { id: "pending", type: "BUY", code: "A", tradeDate: "2026-07-01", amount: 10, nav: 0, shares: 0 }
  ], options);
  assert.equal(ledger.validateLedger(pending).valid, true);

  [
    { amount: 10, nav: 2, shares: 0 },
    { amount: 0, nav: 2, shares: 5 },
    { amount: 10, nav: 0, shares: 5 }
  ].forEach(function (fields) {
    assert.throws(function () {
      ledger.createLedger([
        { id: "buy", type: "BUY", code: "A", tradeDate: "2026-06-01", amount: 100, nav: 10, shares: 10 },
        Object.assign({ id: "sell", type: "SELL", code: "A", tradeDate: "2026-07-01" }, fields)
      ], options);
    }, /INVALID_TRANSACTION/);
  });

  const valid = ledger.createLedger([
    { id: "buy", type: "BUY", code: "A", tradeDate: "2026-06-01", amount: 100, nav: 10, shares: 10 },
    { id: "sell", type: "SELL", code: "A", tradeDate: "2026-07-01", amount: 10, nav: 10, shares: 1 }
  ], options);
  const corrupted = Object.assign({}, valid, {
    transactions: valid.transactions.map(function (transaction) {
      return transaction.type === "SELL" ? Object.assign({}, transaction, { shares: 0 }) : transaction;
    })
  });
  corrupted.checksum = ledger.checksumTransactions(corrupted.transactions);
  assert.equal(ledger.validateLedger(corrupted).valid, false);
});

test("ledger creation rejects malformed values before canonicalization can turn them into zero", function () {
  const options = { revision: 1, updatedAt: "2026-07-01T00:00:00.000Z" };
  assert.throws(function () {
    ledger.createLedger([
      { id: "bad-type", type: "TRANSFER", code: "A", tradeDate: "2026-07-01", amount: 10, nav: 2, shares: 5 }
    ], options);
  }, /INVALID_TRANSACTION/);
  assert.throws(function () {
    ledger.createLedger([
      { id: "bad-date", type: "BUY", code: "A", tradeDate: "07/01/2026", amount: 10, nav: 2, shares: 5 }
    ], options);
  }, /INVALID_TRANSACTION/);
  assert.throws(function () {
    ledger.createLedger([
      { id: "bad-number", type: "BUY", code: "A", tradeDate: "2026-07-01", amount: "not-a-number", nav: 2, shares: 5 }
    ], options);
  }, /INVALID_TRANSACTION/);
  assert.throws(function () {
    ledger.createLedger([
      { id: "numeric-string", type: "BUY", code: "A", tradeDate: "2026-07-01", amount: "10", nav: 2, shares: 5 }
    ], options);
  }, /INVALID_TRANSACTION/);
  assert.throws(function () {
    ledger.createLedger([
      { id: "lowercase-type", type: "buy", code: "A", tradeDate: "2026-07-01", amount: 10, nav: 2, shares: 5 }
    ], options);
  }, /INVALID_TRANSACTION/);
});

test("ledger validation rejects numeric strings in schema, revision, and transaction fields", function () {
  const valid = ledger.createLedger([
    { id: "buy", type: "BUY", code: "A", tradeDate: "2026-07-01", amount: 10, nav: 2, shares: 5 }
  ], { revision: 1, updatedAt: "2026-07-01T00:00:00.000Z" });
  assert.equal(ledger.validateLedger(Object.assign({}, valid, { schemaVersion: "2" })).valid, false);
  assert.equal(ledger.validateLedger(Object.assign({}, valid, { revision: "1" })).valid, false);
  const stringAmount = Object.assign({}, valid, {
    transactions: [Object.assign({}, valid.transactions[0], { amount: "10" })]
  });
  stringAmount.checksum = ledger.checksumTransactions(stringAmount.transactions);
  assert.equal(ledger.validateLedger(stringAmount).valid, false);
});

test("pending buys reconcile from trade-date NAV without changing transaction identity", function () {
  const source = ledger.createLedger([
    { id: "settled", type: "BUY", code: "A", tradeDate: "2026-07-01", amount: 100, nav: 10, shares: 10 },
    { id: "pending", type: "BUY", code: "008253", tradeDate: "2026-07-16", amount: 50, nav: 0, shares: 0 }
  ], { revision: 2, updatedAt: "2026-07-17T00:00:00.000Z" });

  const result = ledger.reconcilePendingTransactions(source, {
    "008253": [
      { date: "2026-07-15", nav: 1.8931 },
      { date: "2026-07-16", nav: 1.8139 },
      { date: "2026-07-17", nav: 1.782 }
    ]
  }, "2026-08-11T00:00:00.000Z");

  assert.equal(result.reconciled.length, 1);
  assert.deepEqual(result.reconciled[0], {
    id: "pending", code: "008253", tradeDate: "2026-07-16", nav: 1.8139, shares: 27.5649,
    source: "NAV_CACHE"
  });
  assert.equal(result.ledger.revision, 3);
  assert.equal(result.ledger.transactions.find(function (tx) { return tx.id === "pending"; }).id, "pending");
  assert.equal(ledger.validateLedger(result.ledger).valid, true);
  assert.equal(ledger.derivePortfolio(result.ledger).pendingHoldings.length, 0);
});

test("pending reconciliation prefers an existing confirmed NAV before cache lookup", function () {
  const source = ledger.createLedger([
    { id: "pending-shares", type: "BUY", code: "A", tradeDate: "2026-07-01", amount: 100, nav: 10, shares: 0 }
  ], { revision: 1, updatedAt: "2026-07-01T00:00:00.000Z" });
  const result = ledger.reconcilePendingTransactions(source, {
    A: [{ date: "2026-07-02", nav: 20 }]
  }, "2026-07-03T00:00:00.000Z");
  const transaction = result.ledger.transactions[0];
  assert.equal(transaction.nav, 10);
  assert.equal(transaction.shares, 10);
});

test("pending reconciliation is idempotent when NAV is unavailable or already filled", function () {
  const source = ledger.createLedger([
    { id: "settled", type: "BUY", code: "A", tradeDate: "2026-07-01", amount: 100, nav: 10, shares: 10 },
    { id: "pending", type: "BUY", code: "B", tradeDate: "2026-07-16", amount: 50, nav: 0, shares: 0 }
  ], { revision: 2, updatedAt: "2026-07-17T00:00:00.000Z" });

  const result = ledger.reconcilePendingTransactions(source, { B: [] }, "2026-08-11T00:00:00.000Z");
  assert.equal(result.reconciled.length, 0);
  assert.equal(result.ledger, source);
});

test("pending reconciliation never substitutes an unrelated later NAV", function () {
  const source = ledger.createLedger([
    { id: "pending", type: "BUY", code: "A", tradeDate: "2026-07-01", amount: 100, nav: 0, shares: 0 }
  ], { revision: 1, updatedAt: "2026-07-01T00:00:00.000Z" });

  const result = ledger.reconcilePendingTransactions(source, {
    A: [{ date: "2026-07-17", nav: 2 }]
  }, "2026-07-18T00:00:00.000Z");

  assert.equal(result.reconciled.length, 0);
  assert.equal(result.ledger, source);
  assert.equal(result.ledger.transactions[0].shares, 0);
});

test("pending reconciliation uses the next effective application day after a market holiday", function () {
  const source = ledger.createLedger([
    { id: "pending", type: "BUY", code: "A", tradeDate: "2026-02-20", amount: 100, nav: 0, shares: 0 }
  ], { revision: 1, updatedAt: "2026-02-20T00:00:00.000Z" });

  const result = ledger.reconcilePendingTransactions(source, {
    A: [
      { date: "2026-02-23", nav: 9 },
      { date: "2026-02-24", nav: 10 }
    ]
  }, "2026-02-25T00:00:00.000Z");

  assert.equal(result.reconciled.length, 1);
  assert.equal(result.reconciled[0].nav, 10);
  assert.equal(result.ledger.transactions[0].shares, 10);
});

test("a fully sold position preserves its realized profit outside active holdings", function () {
  const source = ledger.createLedger([
    { id: "buy", type: "BUY", code: "A", tradeDate: "2026-01-01", amount: 100, nav: 10, shares: 10 },
    { id: "sell", type: "SELL", code: "A", tradeDate: "2026-02-01", amount: 120, nav: 12, shares: 10 }
  ], { revision: 1, updatedAt: "2026-02-01T00:00:00.000Z" });

  const portfolio = ledger.derivePortfolio(source);
  assert.deepEqual(portfolio.holdings, []);
  assert.equal(portfolio.closedPositions.length, 1);
  assert.equal(portfolio.closedPositions[0].code, "A");
  assert.equal(portfolio.closedPositions[0].realizedPnl, 20);
  assert.equal(portfolio.closedRealizedPnl, 20);
});
