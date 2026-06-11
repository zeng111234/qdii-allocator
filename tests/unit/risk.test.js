/**
 * Tests for lib/risk.js
 * Uses Node.js built-in test runner (node:test)
 */

var test = require('node:test');
var assert = require('node:assert');
var risk = require('../../lib/risk');

// ========== pearsonCorrelation ==========

test('pearsonCorrelation - perfect positive returns 1', function () {
  var x = [1,2,3,4,5,6,7,8,9,10];
  var y = [2,4,6,8,10,12,14,16,18,20];
  assert.strictEqual(risk.pearsonCorrelation(x, y), 1);
});

test('pearsonCorrelation - perfect negative returns -1', function () {
  var x = [1,2,3,4,5,6,7,8,9,10];
  var y = [20,18,16,14,12,10,8,6,4,2];
  assert.strictEqual(risk.pearsonCorrelation(x, y), -1);
});

test('pearsonCorrelation - less than 10 points returns null', function () {
  var x = [1,2,3,4,5,6,7,8,9];
  var y = [2,4,6,8,10,12,14,16,18];
  assert.strictEqual(risk.pearsonCorrelation(x, y), null);
});

test('pearsonCorrelation - no variance returns 0', function () {
  var x = [5,5,5,5,5,5,5,5,5,5];
  var y = [1,2,3,4,5,6,7,8,9,10];
  assert.strictEqual(risk.pearsonCorrelation(x, y), 0);
});

test('pearsonCorrelation - uncorrelated data returns near 0', function () {
  var x = [1,2,3,4,5,6,7,8,9,10];
  var y = [9,1,8,2,7,3,6,4,5,10];
  var result = risk.pearsonCorrelation(x, y);
  assert.ok(result > -0.3 && result < 0.3);
});

test('pearsonCorrelation - different length arrays uses shorter', function () {
  var x = [1,2,3,4,5,6,7,8,9,10,11,12];
  var y = [2,4,6,8,10,12,14,16,18,20];
  assert.strictEqual(risk.pearsonCorrelation(x, y), 1);
});

// ========== calcCorrelationMatrix ==========

test('calcCorrelationMatrix - single holding returns identity matrix', function () {
  var result = risk.calcCorrelationMatrix([{ code: '270042', name: 'Test Fund' }], 60);
  assert.ok(Array.isArray(result.codes));
  assert.ok(Array.isArray(result.matrix));
  assert.strictEqual(result.codes.length, 1);
  assert.strictEqual(result.matrix[0][0], 1);
});

test('calcCorrelationMatrix - empty holdings returns empty', function () {
  var result = risk.calcCorrelationMatrix([], 60);
  assert.deepStrictEqual(result.codes, []);
  assert.deepStrictEqual(result.matrix, []);
});

test('calcCorrelationMatrix - unknown fund returns null in matrix', function () {
  var result = risk.calcCorrelationMatrix([
    { code: 'FAKE001', name: 'A' },
    { code: 'FAKE002', name: 'B' }
  ], 60);
  assert.strictEqual(result.matrix[0][0], 1);
  assert.strictEqual(result.matrix[0][1], null);
  assert.strictEqual(result.matrix[1][1], 1);
});

// ========== calcPortfolioRisk ==========

test('calcPortfolioRisk - null/empty returns null', function () {
  assert.strictEqual(risk.calcPortfolioRisk(null), null);
  assert.strictEqual(risk.calcPortfolioRisk([]), null);
});

test('calcPortfolioRisk - zero value returns null', function () {
  var result = risk.calcPortfolioRisk([{ code: 'X', name: 'No Data', totalShares: 0, totalAmount: 0 }], {});
  assert.strictEqual(result, null);
});

test('calcPortfolioRisk - single holding with basic data', function () {
  var navs = [];
  for (var i = 0; i < 65; i++) {
    navs.push({ date: '2026-01-' + String(i+1).padStart(2,'0'), nav: 10 + Math.sin(i) });
  }
  var navCache = { '270042': navs };
  var holdings = [{ code: '270042', name: 'Test Fund', totalShares: 10, totalAmount: 100 }];
  var result = risk.calcPortfolioRisk(holdings, navCache);
  assert.ok(result !== null);
  assert.strictEqual(result.holdingCount, 1);
  assert.ok(typeof result.healthScore === 'number');
  assert.ok(result.healthScore >= 0 && result.healthScore <= 100);
});

// ========== formatRiskReport ==========

test('formatRiskReport - null returns placeholder', function () {
  var report = risk.formatRiskReport(null);
  assert.ok(report.includes('暂无'));
});

test('formatRiskReport - with risk result returns formatted text', function () {
  var riskResult = {
    holdingCount: 3, totalValue: 10000,
    portfolioSharpe: 1.2, portfolioMaxDrawdown: -8.5,
    portfolioAnnualReturn: 12.5, portfolioAnnualVol: 15.3,
    healthScore: 75,
    concentration: { dominantType: '纳指100', dominantWeight: 60, typeWeights: [{ type: '纳指100', weight: 60 }] },
    holdings: [{ code: '270042', name: 'Test', weight: 60 }]
  };
  var report = risk.formatRiskReport(riskResult, null);
  assert.ok(report.includes('75'));
  assert.ok(report.includes('夏普'));
});

test('formatRiskReport - warns when concentration > 70%', function () {
  var riskResult = {
    holdingCount: 2, totalValue: 10000,
    portfolioSharpe: 0.5, portfolioMaxDrawdown: -15,
    portfolioAnnualReturn: 5, portfolioAnnualVol: 20,
    healthScore: 45,
    concentration: { dominantType: '纳指100', dominantWeight: 85, typeWeights: [{ type: '纳指100', weight: 85 }] },
    holdings: [{ code: '270042', name: 'A', weight: 85 }]
  };
  var report = risk.formatRiskReport(riskResult, null);
  assert.ok(report.includes('警告'));
});

test('formatRiskReport - with high correlation matrix', function () {
  var riskResult = {
    holdingCount: 2, totalValue: 10000,
    portfolioSharpe: 0.5, portfolioMaxDrawdown: -15,
    portfolioAnnualReturn: 5, portfolioAnnualVol: 20,
    healthScore: 45,
    concentration: { dominantType: '纳指100', dominantWeight: 60, typeWeights: [{ type: '纳指100', weight: 60 }] },
    holdings: [{ code: '270042', name: 'A', weight: 60 }, { code: '096001', name: 'B', weight: 40 }]
  };
  var corrResult = { codes: ['270042','096001'], matrix: [[1,0.92],[0.92,1]] };
  var report = risk.formatRiskReport(riskResult, corrResult);
  assert.ok(report.includes('相关'));
  assert.ok(report.includes('0.92'));
});
