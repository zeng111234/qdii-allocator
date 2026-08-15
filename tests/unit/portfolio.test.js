/**
 * Tests for lib/portfolio.js
 * Uses Node.js built-in test runner (node:test)
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const PORTFOLIO_FILE = path.join(os.tmpdir(), "trade-portfolio-" + process.pid + ".json");
process.env.PORTFOLIO_FILE = PORTFOLIO_FILE;
const BACKUP_FILE = PORTFOLIO_FILE + ".test-backup";

test.after(function () {
  if (fs.existsSync(PORTFOLIO_FILE)) fs.unlinkSync(PORTFOLIO_FILE);
  if (fs.existsSync(BACKUP_FILE)) fs.unlinkSync(BACKUP_FILE);
});

function backupPortfolio() {
  if (fs.existsSync(PORTFOLIO_FILE)) {
    fs.copyFileSync(PORTFOLIO_FILE, BACKUP_FILE);
  }
}
function restorePortfolio() {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      if (fs.existsSync(BACKUP_FILE)) {
        fs.copyFileSync(BACKUP_FILE, PORTFOLIO_FILE);
        fs.unlinkSync(BACKUP_FILE);
      }
      return;
    } catch (e) {
      if (attempt < 4) {
        const start = Date.now();
        while (Date.now() - start < 300) {
          /* retry delay */
        }
      }
    }
  }
}
function resetPortfolio() {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      fs.writeFileSync(PORTFOLIO_FILE, JSON.stringify({ holdings: [], startDate: null }), "utf-8");
      return;
    } catch (e) {
      if (attempt < 4) {
        const start = Date.now();
        while (Date.now() - start < 300) {
          /* retry delay */
        }
      }
    }
  }
}

// ========== calcPortfolioSummary ==========

test("calcPortfolioSummary - empty portfolio returns empty flag", function () {
  const portfolio = require("../../lib/portfolio");
  const result = portfolio.calcPortfolioSummary();
  assert.ok(typeof result.empty === "boolean");
});

// ========== recordBuy ==========

test("recordBuy - basic buy creates holding", function () {
  const portfolio = require("../../lib/portfolio");
  backupPortfolio();
  try {
    resetPortfolio();
    const result = portfolio.recordBuy("270042", "Test Fund", 100, 10.0, "2026-05-20", 2);
    assert.ok(result !== null);
    assert.strictEqual(result.code, "270042");
    assert.strictEqual(result.buys.length, 1);
    assert.strictEqual(result.buys[0].amount, 100);
    assert.strictEqual(result.buys[0].nav, 10.0);
    assert.strictEqual(result.buys[0].shares, 10);
  } finally {
    restorePortfolio();
  }
});

test("recordBuy - multiple buys accumulate", function () {
  const portfolio = require("../../lib/portfolio");
  backupPortfolio();
  try {
    resetPortfolio();
    portfolio.recordBuy("270042", "Test Fund", 100, 10.0, "2026-05-20", 2);
    portfolio.recordBuy("270042", "Test Fund", 50, 5.0, "2026-05-21", 2);
    const summary = portfolio.calcPortfolioSummary();
    assert.ok(!summary.empty);
    const holding = summary.holdings.find(function (h) {
      return h.code === "270042";
    });
    assert.ok(holding !== undefined);
    assert.strictEqual(holding.buyCount, 2);
  } finally {
    restorePortfolio();
  }
});

test("recordBuy - future date is rejected", function () {
  const portfolio = require("../../lib/portfolio");
  backupPortfolio();
  try {
    resetPortfolio();
    const result = portfolio.recordBuy("270042", "Test Fund", 100, 10.0, "2099-01-01", 2);
    assert.strictEqual(result, null);
  } finally {
    restorePortfolio();
  }
});

test("recordBuy - invalid date format is rejected", function () {
  const portfolio = require("../../lib/portfolio");
  backupPortfolio();
  try {
    resetPortfolio();
    const result = portfolio.recordBuy("270042", "Test Fund", 100, 10.0, "invalid-date", 2);
    assert.strictEqual(result, null);
  } finally {
    restorePortfolio();
  }
});

test("recordBuy - settleDate crosses weekend", function () {
  const portfolio = require("../../lib/portfolio");
  backupPortfolio();
  try {
    resetPortfolio();
    // Thursday 2026-05-21 + 2 = Monday 2026-05-25
    const result = portfolio.recordBuy("270042", "Test Fund", 100, 10.0, "2026-05-21", 2);
    assert.strictEqual(result.buys[0].settleDate, "2026-05-25");
  } finally {
    restorePortfolio();
  }
});

test("recordBuy - different funds create separate holdings", function () {
  const portfolio = require("../../lib/portfolio");
  backupPortfolio();
  try {
    resetPortfolio();
    portfolio.recordBuy("270042", "Fund A", 100, 10.0, "2026-05-20", 2);
    portfolio.recordBuy("040046", "Fund B", 200, 20.0, "2026-05-20", 2);
    const summary = portfolio.calcPortfolioSummary();
    assert.strictEqual(summary.holdings.length, 2);
    assert.strictEqual(summary.summary.holdingCount, 2);
  } finally {
    restorePortfolio();
  }
});

test("recordBuy - duplicate same day same amount same nav merged", function () {
  const portfolio = require("../../lib/portfolio");
  backupPortfolio();
  try {
    resetPortfolio();
    portfolio.recordBuy("270042", "Test Fund", 10, 8.5, "2026-05-20", 2);
    portfolio.recordBuy("270042", "Test Fund", 10, 8.5, "2026-05-20", 2);
    const data = JSON.parse(fs.readFileSync(PORTFOLIO_FILE, "utf-8"));
    assert.strictEqual(data.holdings[0].buys.length, 1);
    assert.strictEqual(data.holdings[0].buys[0].amount, 20);
  } finally {
    restorePortfolio();
  }
});

// ========== calcSettleDate ==========

test("calcSettleDate - T+2 default", function () {
  const portfolio = require("../../lib/portfolio");
  const result = portfolio.calcSettleDate("2026-06-10", 2);
  assert.ok(result.hasOwnProperty("date"));
  assert.ok(result.hasOwnProperty("skipped"));
});

test("QDII T+2 confirms later but uses the trade-date NAV", function () {
  const portfolio = require("../../lib/portfolio");
  const navs = [
    { date: "2026-06-10", nav: 1.00 },
    { date: "2026-06-11", nav: 1.05 },
    { date: "2026-06-12", nav: 1.10 }
  ];
  const resolved = portfolio.resolveTradeNav(navs, "2026-06-10");
  assert.deepEqual(resolved, { date: "2026-06-10", nav: 1.00 });
  assert.equal(portfolio.calcSettleDate("2026-06-10", 2).date, "2026-06-12");
});

// ========== findNavOnOrAfter ==========

test("findNavOnOrAfter - null navs returns null", function () {
  const portfolio = require("../../lib/portfolio");
  assert.strictEqual(portfolio.findNavOnOrAfter(null, "2026-06-10"), null);
});

test("findNavOnOrAfter - exact match found", function () {
  const portfolio = require("../../lib/portfolio");
  const navs = [
    { date: "2026-06-08", nav: 10.0 },
    { date: "2026-06-09", nav: 10.5 },
    { date: "2026-06-10", nav: 11.0 }
  ];
  const result = portfolio.findNavOnOrAfter(navs, "2026-06-09");
  assert.strictEqual(result.date, "2026-06-09");
  assert.strictEqual(result.nav, 10.5);
});

test("findNavOnOrAfter - no exact match finds next", function () {
  const portfolio = require("../../lib/portfolio");
  const navs = [
    { date: "2026-06-08", nav: 10.0 },
    { date: "2026-06-10", nav: 11.0 }
  ];
  const result = portfolio.findNavOnOrAfter(navs, "2026-06-09");
  assert.strictEqual(result.date, "2026-06-10");
});

// ========== calcHoldingDetail ==========

test("calcHoldingDetail - calculates settled buys correctly", function () {
  const portfolio = require("../../lib/portfolio");
  const holding = {
    code: "270042",
    name: "Test Fund",
    buys: [
      { date: "2026-05-20", settleDate: "2026-05-22", amount: 100, nav: 10.0, shares: 10 },
      { date: "2026-05-25", settleDate: "2026-05-27", amount: 200, nav: 20.0, shares: 10 }
    ]
  };
  const navCache = { 270042: [{ date: "2026-06-02", nav: 11.5 }] };
  const detail = portfolio.calcHoldingDetail(holding, navCache, { asOf: "2026-06-02", maxFreshnessLag: 2 });
  assert.strictEqual(detail.totalAmount, 300);
  assert.strictEqual(detail.totalShares, 20);
  assert.ok(detail.currentValue > 0);
  assert.ok(detail.pnl !== null);
});

test("calcHoldingDetail - unsettled buy is excluded from valuation and profit", function () {
  const portfolio = require("../../lib/portfolio");
  const holding = {
    code: "270042",
    name: "Test Fund",
    buys: [
      { date: "2026-05-20", settleDate: "2026-05-22", amount: 100, nav: 10.0, shares: 10 },
      { date: "2026-06-05", settleDate: "2026-06-09", amount: 50, nav: null, shares: null }
    ]
  };
  const detail = portfolio.calcHoldingDetail(holding, {
    270042: [{ date: "2026-06-10", nav: 11 }]
  }, { asOf: "2026-06-10", maxFreshnessLag: 2 });
  assert.strictEqual(detail.totalAmount, 150); // 100(已结算) + 50(待结算) = 150
  assert.strictEqual(detail.totalShares, 10); // 待结算的没有shares
  assert.strictEqual(detail.confirmedAmount, 100);
  assert.strictEqual(detail.pendingAmount, 50);
  assert.strictEqual(detail.currentValue, 110);
  assert.strictEqual(detail.pnl, 10);
  assert.strictEqual(detail.pnlRate, 10);
});

test("calcHoldingDetail - signed sells reduce remaining cost and shares", function () {
  const portfolio = require("../../lib/portfolio");
  const detail = portfolio.calcHoldingDetail({
    code: "A",
    name: "Test Fund",
    buys: [
      { date: "2026-07-01", type: "BUY", amount: 100, nav: 1, shares: 100 },
      { date: "2026-07-10", type: "SELL", amount: -50, nav: 1.25, shares: -40 }
    ]
  }, { A: [{ date: "2026-07-11", nav: 1 }] }, { asOf: "2026-07-11", maxFreshnessLag: 2 });
  assert.strictEqual(detail.confirmedAmount, 50);
  assert.strictEqual(detail.totalShares, 60);
  assert.strictEqual(detail.currentValue, 60);
  assert.strictEqual(detail.pnl, 10);
  assert.strictEqual(detail.buyDetails[1].type, "SELL");
});

test("calcHoldingDetail - invalid latest NAV makes valuation incomplete", function () {
  const portfolio = require("../../lib/portfolio");
  [0, -1, NaN, "11"].forEach(function (invalidNav) {
    const detail = portfolio.calcHoldingDetail({
      code: "A",
      name: "Test Fund",
      buys: [{ date: "2026-07-01", type: "BUY", amount: 100, nav: 10, shares: 10 }]
    }, { A: [{ date: "2026-07-11", nav: invalidNav }] });
    assert.strictEqual(detail.latestNav, null);
    assert.strictEqual(detail.currentValue, null);
    assert.strictEqual(detail.pnl, null);
  });
});

test("calcHoldingDetail - accepts normal QDII reporting lag but rejects stale and future NAV", function () {
  const portfolio = require("../../lib/portfolio");
  const holding = {
    code: "QDII",
    name: "Test QDII",
    buys: [{ date: "2026-08-01", type: "BUY", amount: 100, nav: 10, shares: 10 }]
  };

  const normalLag = portfolio.calcHoldingDetail(holding, {
    QDII: [{ date: "2026-08-13", nav: 11 }]
  }, { asOf: "2026-08-17", maxFreshnessLag: 2 });
  assert.strictEqual(normalLag.currentValue, 110);
  assert.strictEqual(normalLag.pnl, 10);
  assert.strictEqual(normalLag.navTradingDayLag, 2);
  assert.strictEqual(normalLag.valuationIssue, null);

  const stale = portfolio.calcHoldingDetail(holding, {
    QDII: [{ date: "2026-08-12", nav: 11 }]
  }, { asOf: "2026-08-17", maxFreshnessLag: 2 });
  assert.strictEqual(stale.currentValue, null);
  assert.strictEqual(stale.pnl, null);
  assert.strictEqual(stale.pnlRate, null);
  assert.strictEqual(stale.valuationIssue, "NAV_STALE");

  const future = portfolio.calcHoldingDetail(holding, {
    QDII: [{ date: "2026-08-18", nav: 11 }]
  }, { asOf: "2026-08-17", maxFreshnessLag: 2 });
  assert.strictEqual(future.currentValue, null);
  assert.strictEqual(future.pnl, null);
  assert.strictEqual(future.pnlRate, null);
  assert.strictEqual(future.valuationIssue, "NAV_FUTURE");
});

test("calcPortfolioSummary - missing NAV never turns confirmed cost into a fake loss", function () {
  const portfolio = require("../../lib/portfolio");
  const ledgerTools = require("../../lib/portfolio-ledger");
  backupPortfolio();
  try {
    const source = ledgerTools.createLedger([
      { id: "missing-nav", type: "BUY", code: "NO_NAV", tradeDate: "2026-07-01", amount: 100, nav: 1, shares: 100 }
    ], { revision: 1, updatedAt: "2026-07-01T00:00:00.000Z" });
    fs.writeFileSync(PORTFOLIO_FILE, JSON.stringify(source), "utf8");
    const result = portfolio.calcPortfolioSummary();
    assert.strictEqual(result.summary.valuationComplete, false);
    assert.deepEqual(result.summary.missingValuationCodes, ["NO_NAV"]);
    assert.strictEqual(result.summary.totalValue, null);
    assert.strictEqual(result.summary.totalPnl, null);
    assert.strictEqual(result.summary.totalPnlRate, null);
  } finally {
    restorePortfolio();
  }
});

test("calcPortfolioSummary - pending-only ledger remains visible without fake valuation", function () {
  const portfolio = require("../../lib/portfolio");
  const ledgerTools = require("../../lib/portfolio-ledger");
  backupPortfolio();
  try {
    const source = ledgerTools.createLedger([
      { id: "pending-only", type: "BUY", code: "PENDING_ONLY", tradeDate: "2026-07-01", amount: 50, nav: 0, shares: 0 }
    ], { revision: 1, updatedAt: "2026-07-01T00:00:00.000Z" });
    fs.writeFileSync(PORTFOLIO_FILE, JSON.stringify(source), "utf8");
    const result = portfolio.calcPortfolioSummary();
    assert.strictEqual(result.empty, false);
    assert.strictEqual(result.summary.pendingInvested, 50);
    assert.strictEqual(result.summary.totalInvested, 0);
    assert.strictEqual(result.summary.totalPnl, 0);
  } finally {
    restorePortfolio();
  }
});

test("calcPortfolioSummary - fully sold ledger retains realized profit", function () {
  const portfolio = require("../../lib/portfolio");
  const portfolioLedger = require("../../lib/portfolio-ledger");
  backupPortfolio();
  try {
    const closedLedger = portfolioLedger.createLedger([
      { id: "buy", type: "BUY", code: "A", tradeDate: "2026-01-01", amount: 100, nav: 10, shares: 10 },
      { id: "sell", type: "SELL", code: "A", tradeDate: "2026-02-01", amount: 120, nav: 12, shares: 10 }
    ], { revision: 1, updatedAt: "2026-02-01T00:00:00.000Z" });
    fs.writeFileSync(PORTFOLIO_FILE, JSON.stringify(closedLedger), "utf-8");

    const result = portfolio.calcPortfolioSummary({ asOf: "2026-02-02" });
    assert.equal(result.empty, false);
    assert.deepEqual(result.holdings, []);
    assert.equal(result.summary.totalRealizedPnl, 20);
    assert.equal(result.summary.totalPnl, 20);
    assert.equal(result.summary.closedPositionCount, 1);
  } finally {
    restorePortfolio();
  }
});

test("calcHoldingDetail - preserves risk classification metadata", function () {
  const portfolio = require("../../lib/portfolio");
  const detail = portfolio.calcHoldingDetail({
    code: "270042",
    name: "Test Fund",
    type: "纳指100",
    indexGroup: "NDX100",
    riskBucket: "GROWTH_TECH",
    buys: [{ date: "2026-05-20", amount: 100, nav: 10, shares: 10 }]
  }, {});

  assert.strictEqual(detail.type, "纳指100");
  assert.strictEqual(detail.indexGroup, "NDX100");
  assert.strictEqual(detail.riskBucket, "GROWTH_TECH");
});

test("calcPortfolioSummary - enriches legacy holdings from the fund catalog", function () {
  const portfolio = require("../../lib/portfolio");
  fs.writeFileSync(PORTFOLIO_FILE, JSON.stringify({
    holdings: [{
      code: "270042",
      name: "广发纳斯达克100ETF联接",
      buys: [{ date: "2026-05-20", amount: 100, nav: 1, shares: 100 }]
    }],
    startDate: "2026-05-20"
  }), "utf8");

  const summary = portfolio.calcPortfolioSummary();
  assert.strictEqual(summary.holdings[0].indexGroup, "NDX100");
  assert.ok(summary.holdings[0].type);
  assert.ok(summary.holdings[0].riskBucket);
});

// ========== formatPortfolioReport ==========

test("formatPortfolioReport - empty returns empty message", function () {
  const portfolio = require("../../lib/portfolio");
  const report = portfolio.formatPortfolioReport({ empty: true });
  assert.ok(report.includes("暂无"));
});

test("formatPortfolioReport - with holdings shows report", function () {
  const portfolio = require("../../lib/portfolio");
  const calcResult = {
    empty: false,
    holdings: [
      {
        code: "270042",
        name: "广发纳斯达克100",
        totalAmount: 100,
        totalShares: 10,
        avgCost: 10,
        latestNav: 11,
        latestDate: "2026-06-09",
        currentValue: 110,
        pnl: 10,
        pnlRate: 10,
        buyCount: 1,
        buyDetails: [{ date: "2026-05-20", settleDate: "2026-05-22", amount: 100, nav: 10, shares: 10, settled: true }]
      }
    ],
    summary: {
      totalInvested: 100,
      totalValue: 110,
      totalPnl: 10,
      totalPnlRate: 10,
      holdingCount: 1,
      daysSinceStart: 20,
      startDate: "2026-05-20"
    }
  };
  const report = portfolio.formatPortfolioReport(calcResult);
  assert.ok(report.includes("持仓"));
  assert.ok(report.includes("广发纳斯达克100"));
  assert.ok(report.includes("组合汇总"));
});

test("formatPortfolioReport - labels signed ledger redemptions as sells", function () {
  const portfolio = require("../../lib/portfolio");
  const detail = portfolio.calcHoldingDetail({
    code: "A",
    name: "Test Fund",
    buys: [
      { date: "2026-07-01", type: "BUY", amount: 100, nav: 1, shares: 100 },
      { date: "2026-07-10", type: "SELL", amount: -50, nav: 1.25, shares: -40 }
    ]
  }, { A: [{ date: "2026-07-11", nav: 1 }] });
  const report = portfolio.formatPortfolioReport({
    empty: false,
    holdings: [detail],
    summary: {
      totalInvested: 50, pendingInvested: 0, totalValue: 60, totalPnl: 10, totalPnlRate: 20,
      valuationComplete: true, totalRealizedPnl: 0, holdingCount: 1, daysSinceStart: 10, startDate: "2026-07-01"
    }
  });
  assert.match(report, /2026-07-10 卖出50元/);
});
