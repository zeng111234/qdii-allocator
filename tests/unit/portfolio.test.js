/**
 * Tests for lib/portfolio.js
 * Uses Node.js built-in test runner (node:test)
 */

var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var path = require('path');

var PORTFOLIO_FILE = path.join(__dirname, '..', '..', 'data', 'portfolio.json');
var BACKUP_FILE = PORTFOLIO_FILE + '.test-backup';

function backupPortfolio() {
  if (fs.existsSync(PORTFOLIO_FILE)) {
    fs.copyFileSync(PORTFOLIO_FILE, BACKUP_FILE);
  }
}
function restorePortfolio() {
  for (var attempt = 0; attempt < 5; attempt++) {
    try {
      if (fs.existsSync(BACKUP_FILE)) {
        fs.copyFileSync(BACKUP_FILE, PORTFOLIO_FILE);
        fs.unlinkSync(BACKUP_FILE);
      }
      return;
    } catch (e) {
      if (attempt < 4) {
        var start = Date.now(); while (Date.now() - start < 300) {}
      }
    }
  }
}
function resetPortfolio() {
  for (var attempt = 0; attempt < 5; attempt++) {
    try {
      fs.writeFileSync(PORTFOLIO_FILE, JSON.stringify({ holdings: [], startDate: null }), 'utf-8');
      return;
    } catch (e) {
      if (attempt < 4) {
        var start = Date.now(); while (Date.now() - start < 300) {}
      }
    }
  }
}

// ========== calcPortfolioSummary ==========

test('calcPortfolioSummary - empty portfolio returns empty flag', function () {
  var portfolio = require('../../lib/portfolio');
  var result = portfolio.calcPortfolioSummary();
  assert.ok(typeof result.empty === 'boolean');
});

// ========== recordBuy ==========

test('recordBuy - basic buy creates holding', function () {
  var portfolio = require('../../lib/portfolio');
  backupPortfolio();
  try {
    resetPortfolio();
    var result = portfolio.recordBuy('270042', 'Test Fund', 100, 10.0, '2026-05-20', 2);
    assert.ok(result !== null);
    assert.strictEqual(result.code, '270042');
    assert.strictEqual(result.buys.length, 1);
    assert.strictEqual(result.buys[0].amount, 100);
    assert.strictEqual(result.buys[0].nav, 10.0);
    assert.strictEqual(result.buys[0].shares, 10);
  } finally {
    restorePortfolio();
  }
});

test('recordBuy - multiple buys accumulate', function () {
  var portfolio = require('../../lib/portfolio');
  backupPortfolio();
  try {
    resetPortfolio();
    portfolio.recordBuy('270042', 'Test Fund', 100, 10.0, '2026-05-20', 2);
    portfolio.recordBuy('270042', 'Test Fund', 50, 5.0, '2026-05-21', 2);
    var summary = portfolio.calcPortfolioSummary();
    assert.ok(!summary.empty);
    var holding = summary.holdings.find(function(h) { return h.code === '270042'; });
    assert.ok(holding !== undefined);
    assert.strictEqual(holding.buyCount, 2);
  } finally {
    restorePortfolio();
  }
});

test('recordBuy - future date is rejected', function () {
  var portfolio = require('../../lib/portfolio');
  backupPortfolio();
  try {
    resetPortfolio();
    var result = portfolio.recordBuy('270042', 'Test Fund', 100, 10.0, '2099-01-01', 2);
    assert.strictEqual(result, null);
  } finally {
    restorePortfolio();
  }
});

test('recordBuy - invalid date format is rejected', function () {
  var portfolio = require('../../lib/portfolio');
  backupPortfolio();
  try {
    resetPortfolio();
    var result = portfolio.recordBuy('270042', 'Test Fund', 100, 10.0, 'invalid-date', 2);
    assert.strictEqual(result, null);
  } finally {
    restorePortfolio();
  }
});

test('recordBuy - settleDate crosses weekend', function () {
  var portfolio = require('../../lib/portfolio');
  backupPortfolio();
  try {
    resetPortfolio();
    // Thursday 2026-05-21 + 2 = Monday 2026-05-25
    var result = portfolio.recordBuy('270042', 'Test Fund', 100, 10.0, '2026-05-21', 2);
    assert.strictEqual(result.buys[0].settleDate, '2026-05-25');
  } finally {
    restorePortfolio();
  }
});

test('recordBuy - different funds create separate holdings', function () {
  var portfolio = require('../../lib/portfolio');
  backupPortfolio();
  try {
    resetPortfolio();
    portfolio.recordBuy('270042', 'Fund A', 100, 10.0, '2026-05-20', 2);
    portfolio.recordBuy('040046', 'Fund B', 200, 20.0, '2026-05-20', 2);
    var summary = portfolio.calcPortfolioSummary();
    assert.strictEqual(summary.holdings.length, 2);
    assert.strictEqual(summary.summary.holdingCount, 2);
  } finally {
    restorePortfolio();
  }
});

test('recordBuy - duplicate same day same amount same nav merged', function () {
  var portfolio = require('../../lib/portfolio');
  backupPortfolio();
  try {
    resetPortfolio();
    portfolio.recordBuy('270042', 'Test Fund', 10, 8.5, '2026-05-20', 2);
    portfolio.recordBuy('270042', 'Test Fund', 10, 8.5, '2026-05-20', 2);
    var data = JSON.parse(fs.readFileSync(PORTFOLIO_FILE, 'utf-8'));
    assert.strictEqual(data.holdings[0].buys.length, 1);
    assert.strictEqual(data.holdings[0].buys[0].amount, 20);
  } finally {
    restorePortfolio();
  }
});

// ========== calcSettleDate ==========

test('calcSettleDate - T+2 default', function () {
  var portfolio = require('../../lib/portfolio');
  var result = portfolio.calcSettleDate('2026-06-10', 2);
  assert.ok(result.hasOwnProperty('date'));
  assert.ok(result.hasOwnProperty('skipped'));
});

// ========== findNavOnOrAfter ==========

test('findNavOnOrAfter - null navs returns null', function () {
  var portfolio = require('../../lib/portfolio');
  assert.strictEqual(portfolio.findNavOnOrAfter(null, '2026-06-10'), null);
});

test('findNavOnOrAfter - exact match found', function () {
  var portfolio = require('../../lib/portfolio');
  var navs = [
    { date: '2026-06-08', nav: 10.0 },
    { date: '2026-06-09', nav: 10.5 },
    { date: '2026-06-10', nav: 11.0 }
  ];
  var result = portfolio.findNavOnOrAfter(navs, '2026-06-09');
  assert.strictEqual(result.date, '2026-06-09');
  assert.strictEqual(result.nav, 10.5);
});

test('findNavOnOrAfter - no exact match finds next', function () {
  var portfolio = require('../../lib/portfolio');
  var navs = [
    { date: '2026-06-08', nav: 10.0 },
    { date: '2026-06-10', nav: 11.0 }
  ];
  var result = portfolio.findNavOnOrAfter(navs, '2026-06-09');
  assert.strictEqual(result.date, '2026-06-10');
});

// ========== calcHoldingDetail ==========

test('calcHoldingDetail - calculates settled buys correctly', function () {
  var portfolio = require('../../lib/portfolio');
  var holding = {
    code: '270042', name: 'Test Fund',
    buys: [
      { date: '2026-05-20', settleDate: '2026-05-22', amount: 100, nav: 10.0, shares: 10 },
      { date: '2026-05-25', settleDate: '2026-05-27', amount: 200, nav: 20.0, shares: 10 }
    ]
  };
  var navCache = { '270042': [{ date: '2026-06-02', nav: 11.5 }] };
  var detail = portfolio.calcHoldingDetail(holding, navCache);
  assert.strictEqual(detail.totalAmount, 300);
  assert.strictEqual(detail.totalShares, 20);
  assert.ok(detail.currentValue > 0);
  assert.ok(detail.pnl !== null);
});

test('calcHoldingDetail - unsettled buy excluded from totals', function () {
  var portfolio = require('../../lib/portfolio');
  var holding = {
    code: '270042', name: 'Test Fund',
    buys: [
      { date: '2026-05-20', settleDate: '2026-05-22', amount: 100, nav: 10.0, shares: 10 },
      { date: '2026-06-05', settleDate: '2026-06-09', amount: 50, nav: null, shares: null }
    ]
  };
  var detail = portfolio.calcHoldingDetail(holding, {});
  assert.strictEqual(detail.totalAmount, 100);
  assert.strictEqual(detail.totalShares, 10);
});

// ========== formatPortfolioReport ==========

test('formatPortfolioReport - empty returns empty message', function () {
  var portfolio = require('../../lib/portfolio');
  var report = portfolio.formatPortfolioReport({ empty: true });
  assert.ok(report.includes('暂无'));
});

test('formatPortfolioReport - with holdings shows report', function () {
  var portfolio = require('../../lib/portfolio');
  var calcResult = {
    empty: false,
    holdings: [{
      code: '270042', name: '广发纳斯达克100',
      totalAmount: 100, totalShares: 10, avgCost: 10,
      latestNav: 11, latestDate: '2026-06-09',
      currentValue: 110, pnl: 10, pnlRate: 10,
      buyCount: 1,
      buyDetails: [{ date: '2026-05-20', settleDate: '2026-05-22', amount: 100, nav: 10, shares: 10, settled: true }]
    }],
    summary: {
      totalInvested: 100, totalValue: 110, totalPnl: 10, totalPnlRate: 10,
      holdingCount: 1, daysSinceStart: 20, startDate: '2026-05-20'
    }
  };
  var report = portfolio.formatPortfolioReport(calcResult);
  assert.ok(report.includes('持仓'));
  assert.ok(report.includes('广发纳斯达克100'));
  assert.ok(report.includes('组合汇总'));
});
