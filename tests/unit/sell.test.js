/**
 * Tests for sell functionality in lib/portfolio.js
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const PORTFOLIO_FILE = path.join(os.tmpdir(), "trade-sell-portfolio-" + process.pid + ".json");
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

test("recordSell - basic sell with nav", function () {
  const portfolio = require("../../lib/portfolio");
  backupPortfolio();
  try {
    resetPortfolio();
    // 先买入
    portfolio.recordBuy("270042", "Test Fund", 100, 10.0, "2026-05-20", 2);
    // 再卖出
    const result = portfolio.recordSell("270042", "Test Fund", 50, 12.0, "2026-06-01");
    assert.ok(result !== null);
    assert.strictEqual(result.code, "270042");
    assert.strictEqual(result.nav, 12.0);
    assert.ok(result.amount > 0);
    assert.ok(result.realizedPnl > 0); // 低买高卖应盈利
    assert.ok(result.realizedPnlRate > 0);
  } finally {
    restorePortfolio();
  }
});

test("recordSell - sell with loss", function () {
  const portfolio = require("../../lib/portfolio");
  backupPortfolio();
  try {
    resetPortfolio();
    portfolio.recordBuy("270042", "Test Fund", 100, 10.0, "2026-05-20", 2);
    const result = portfolio.recordSell("270042", "Test Fund", 50, 8.0, "2026-06-01");
    assert.ok(result !== null);
    assert.ok(result.realizedPnl < 0); // 高买低卖应亏损
    assert.ok(result.realizedPnlRate < 0);
  } finally {
    restorePortfolio();
  }
});

test("recordSell - sell nonexistent fund returns null", function () {
  const portfolio = require("../../lib/portfolio");
  backupPortfolio();
  try {
    resetPortfolio();
    const result = portfolio.recordSell("999999", "No Fund", 100, 10.0, "2026-06-01");
    assert.strictEqual(result, null);
  } finally {
    restorePortfolio();
  }
});

test("recordSell - partial sell keeps remaining holdings", function () {
  const portfolio = require("../../lib/portfolio");
  backupPortfolio();
  try {
    resetPortfolio();
    portfolio.recordBuy("270042", "Test Fund", 100, 10.0, "2026-05-20", 2);
    const result = portfolio.recordSell("270042", "Test Fund", 50, 12.0, "2026-06-01");
    assert.ok(result.remainingHoldings === true);

    const summary = portfolio.calcPortfolioSummary();
    assert.ok(!summary.empty);
    const holding = summary.holdings.find(h => h.code === "270042");
    assert.ok(holding !== undefined);
    assert.ok(holding.totalAmount < 100); // 部分卖出后金额减少
    assert.ok(holding.sellCount === 1);
    assert.ok(holding.realizedPnl > 0);
  } finally {
    restorePortfolio();
  }
});

test("recordSell - full sell removes holding", function () {
  const portfolio = require("../../lib/portfolio");
  backupPortfolio();
  try {
    resetPortfolio();
    portfolio.recordBuy("270042", "Test Fund", 100, 10.0, "2026-05-20", 2);
    const result = portfolio.recordSell("270042", "Test Fund", 200, 12.0, "2026-06-01");
    assert.ok(result !== null);
    assert.ok(result.remainingHoldings === false);

    const summary = portfolio.calcPortfolioSummary();
    // 应该没有持仓了（或为空）
    if (!summary.empty) {
      const holding = summary.holdings.find(h => h.code === "270042");
      assert.strictEqual(holding, undefined);
    }
  } finally {
    restorePortfolio();
  }
});

test("calcPortfolioSummary - includes realizedPnl", function () {
  const portfolio = require("../../lib/portfolio");
  backupPortfolio();
  try {
    resetPortfolio();
    portfolio.recordBuy("270042", "Test Fund", 100, 10.0, "2026-05-20", 2);
    portfolio.recordSell("270042", "Test Fund", 50, 12.0, "2026-06-01");

    const summary = portfolio.calcPortfolioSummary();
    assert.ok(summary.summary !== null);
    assert.ok(typeof summary.summary.totalRealizedPnl === "number");
    assert.ok(summary.summary.totalRealizedPnl > 0);
  } finally {
    restorePortfolio();
  }
});
