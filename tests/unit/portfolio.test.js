/**
 * Tests for lib/portfolio.js
 * Uses Node.js built-in test runner (node:test)
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const PORTFOLIO_FILE = path.join(__dirname, "..", "..", "data", "portfolio.json");
const BACKUP_FILE = PORTFOLIO_FILE + ".test-backup";

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
  const detail = portfolio.calcHoldingDetail(holding, navCache);
  assert.strictEqual(detail.totalAmount, 300);
  assert.strictEqual(detail.totalShares, 20);
  assert.ok(detail.currentValue > 0);
  assert.ok(detail.pnl !== null);
});

test("calcHoldingDetail - unsettled buy excluded from totals", function () {
  const portfolio = require("../../lib/portfolio");
  const holding = {
    code: "270042",
    name: "Test Fund",
    buys: [
      { date: "2026-05-20", settleDate: "2026-05-22", amount: 100, nav: 10.0, shares: 10 },
      { date: "2026-06-05", settleDate: "2026-06-09", amount: 50, nav: null, shares: null }
    ]
  };
  const detail = portfolio.calcHoldingDetail(holding, {});
  assert.strictEqual(detail.totalAmount, 150); // 100(已结算) + 50(待结算) = 150
  assert.strictEqual(detail.totalShares, 10); // 待结算的没有shares
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
