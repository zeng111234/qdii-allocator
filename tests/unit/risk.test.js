/**
 * Tests for lib/risk.js
 * Uses Node.js built-in test runner (node:test)
 */

const test = require('node:test');
const assert = require('node:assert');
const risk = require('../../lib/risk');

// ========== pearsonCorrelation ==========

test('pearsonCorrelation - perfect positive returns 1', function () {
  const x = [1,2,3,4,5,6,7,8,9,10];
  const y = [2,4,6,8,10,12,14,16,18,20];
  assert.strictEqual(risk.pearsonCorrelation(x, y), 1);
});

test('pearsonCorrelation - perfect negative returns -1', function () {
  const x = [1,2,3,4,5,6,7,8,9,10];
  const y = [20,18,16,14,12,10,8,6,4,2];
  assert.strictEqual(risk.pearsonCorrelation(x, y), -1);
});

test('pearsonCorrelation - less than 10 points returns null', function () {
  const x = [1,2,3,4,5,6,7,8,9];
  const y = [2,4,6,8,10,12,14,16,18];
  assert.strictEqual(risk.pearsonCorrelation(x, y), null);
});

test('pearsonCorrelation - no variance returns 0', function () {
  const x = [5,5,5,5,5,5,5,5,5,5];
  const y = [1,2,3,4,5,6,7,8,9,10];
  assert.strictEqual(risk.pearsonCorrelation(x, y), 0);
});

test('pearsonCorrelation - uncorrelated data returns near 0', function () {
  const x = [1,2,3,4,5,6,7,8,9,10];
  const y = [9,1,8,2,7,3,6,4,5,10];
  const result = risk.pearsonCorrelation(x, y);
  assert.ok(result > -0.3 && result < 0.3);
});

test('pearsonCorrelation - different length arrays uses shorter', function () {
  const x = [1,2,3,4,5,6,7,8,9,10,11,12];
  const y = [2,4,6,8,10,12,14,16,18,20];
  assert.strictEqual(risk.pearsonCorrelation(x, y), 1);
});

// ========== calcCorrelationMatrix ==========

test('calcCorrelationMatrix - single holding returns identity matrix', function () {
  const result = risk.calcCorrelationMatrix([{ code: '270042', name: 'Test Fund' }], 60);
  assert.ok(Array.isArray(result.codes));
  assert.ok(Array.isArray(result.matrix));
  assert.strictEqual(result.codes.length, 1);
  assert.strictEqual(result.matrix[0][0], 1);
});

test('calcCorrelationMatrix - empty holdings returns empty', function () {
  const result = risk.calcCorrelationMatrix([], 60);
  assert.deepStrictEqual(result.codes, []);
  assert.deepStrictEqual(result.matrix, []);
});

test('calcCorrelationMatrix - unknown fund returns null in matrix', function () {
  const result = risk.calcCorrelationMatrix([
    { code: 'FAKE001', name: 'A' },
    { code: 'FAKE002', name: 'B' }
  ], 60);
  assert.strictEqual(result.matrix[0][0], 1);
  assert.strictEqual(result.matrix[0][1], null);
  assert.strictEqual(result.matrix[1][1], 1);
});

test('alignReturnsByDate pairs returns by date and ignores missing dates', function () {
  const left = [
    { date: '2026-01-01', nav: 100 }, { date: '2026-01-02', nav: 110 },
    { date: '2026-01-03', nav: 121 }, { date: '2026-01-04', nav: 133.1 }
  ];
  const right = [
    { date: '2026-01-01', nav: 200 }, { date: '2026-01-03', nav: 220 },
    { date: '2026-01-04', nav: 242 }
  ];
  const aligned = risk.alignReturnsByDate(left, right);
  assert.deepEqual(aligned.dates, ['2026-01-04']);
  assert.equal(aligned.left.length, 1);
  assert.equal(aligned.right.length, 1);
});

test('calcCorrelationMatrix aligns identical date intervals with missing NAV rows', function () {
  const left = [];
  const right = [];
  let leftNav = 100;
  let rightNav = 200;
  for (let i = 0; i < 15; i++) {
    const date = '2026-01-' + String(i + 1).padStart(2, '0');
    const change = 1 + (i % 3) * 0.01;
    leftNav *= change;
    rightNav *= change;
    left.push({ date: date, nav: leftNav });
    if (i !== 2) right.push({ date: date, nav: rightNav });
  }
  const result = risk.calcCorrelationMatrix([{ code: 'A' }, { code: 'B' }], 60, { A: left, B: right });
  assert.ok(result.matrix[0][1] > 0.99);
});

test('TWR excludes external cash flows and XIRR uses actual dated cash flows', function () {
  const twr = risk.calculateTWR([
    { date: '2026-01-01', openingValue: 100, closingValue: 110, netCashFlow: 0 },
    { date: '2026-01-02', openingValue: 110, closingValue: 231, netCashFlow: 100 }
  ]);
  assert.ok(Math.abs(twr - 0.21) < 1e-10);
  const xirr = risk.calculateXIRR([
    { date: '2025-01-01', amount: -100 },
    { date: '2026-01-01', amount: 110 }
  ]);
  assert.ok(Math.abs(xirr - 0.10) < 0.001);
});

test('cluster concentration aggregates wrappers and holding count adds no health bonus', function () {
  const holdings = [
    { code: 'A', totalShares: 60, latestNav: 1, indexGroup: 'NDX100', riskBucket: 'GROWTH_TECH' },
    { code: 'B', totalShares: 40, latestNav: 1, indexGroup: 'NDX100', riskBucket: 'GROWTH_TECH' }
  ];
  const concentration = risk.calculateClusterConcentration(holdings);
  assert.equal(concentration.indexGroups.NDX100, 100);
  assert.equal(concentration.buckets.GROWTH_TECH, 100);
  assert.equal(concentration.effectiveExposureCount, 1);
  assert.equal(risk.diversificationScore([{ indexGroup: 'NDX100' }]), risk.diversificationScore(holdings));
});

// ========== calcPortfolioRisk ==========

test('calcPortfolioRisk - null/empty returns null', function () {
  assert.strictEqual(risk.calcPortfolioRisk(null), null);
  assert.strictEqual(risk.calcPortfolioRisk([]), null);
});

test('calcPortfolioRisk - zero value returns null', function () {
  const result = risk.calcPortfolioRisk([{ code: 'X', name: 'No Data', totalShares: 0, totalAmount: 0 }], {});
  assert.strictEqual(result, null);
});

test('calcPortfolioRisk - single holding with basic data', function () {
  const navs = [];
  for (let i = 0; i < 65; i++) {
    navs.push({ date: '2026-01-' + String(i+1).padStart(2,'0'), nav: 10 + Math.sin(i) });
  }
  const navCache = { '270042': navs };
  const holdings = [{ code: '270042', name: 'Test Fund', totalShares: 10, totalAmount: 100 }];
  const result = risk.calcPortfolioRisk(holdings, navCache);
  assert.ok(result !== null);
  assert.strictEqual(result.holdingCount, 1);
  assert.ok(typeof result.healthScore === 'number');
  assert.ok(result.healthScore >= 0 && result.healthScore <= 100);
});

// ========== formatRiskReport ==========

test('formatRiskReport - null returns placeholder', function () {
  const report = risk.formatRiskReport(null);
  assert.ok(report.includes('暂无'));
});

test('formatRiskReport - with risk result returns formatted text', function () {
  const riskResult = {
    holdingCount: 3, totalValue: 10000,
    portfolioSharpe: 1.2, portfolioMaxDrawdown: -8.5,
    portfolioAnnualReturn: 12.5, portfolioAnnualVol: 15.3,
    healthScore: 75,
    concentration: { dominantType: '纳指100', dominantWeight: 60, typeWeights: [{ type: '纳指100', weight: 60 }] },
    holdings: [{ code: '270042', name: 'Test', weight: 60 }]
  };
  const report = risk.formatRiskReport(riskResult, null);
  assert.ok(report.includes('75'));
  assert.ok(report.includes('夏普'));
});

test('formatRiskReport - warns when concentration > 70%', function () {
  const riskResult = {
    holdingCount: 2, totalValue: 10000,
    portfolioSharpe: 0.5, portfolioMaxDrawdown: -15,
    portfolioAnnualReturn: 5, portfolioAnnualVol: 20,
    healthScore: 45,
    concentration: { dominantType: '纳指100', dominantWeight: 85, typeWeights: [{ type: '纳指100', weight: 85 }] },
    holdings: [{ code: '270042', name: 'A', weight: 85 }]
  };
  const report = risk.formatRiskReport(riskResult, null);
  assert.ok(report.includes('警告'));
});

test('formatRiskReport - with high correlation matrix', function () {
  const riskResult = {
    holdingCount: 2, totalValue: 10000,
    portfolioSharpe: 0.5, portfolioMaxDrawdown: -15,
    portfolioAnnualReturn: 5, portfolioAnnualVol: 20,
    healthScore: 45,
    concentration: { dominantType: '纳指100', dominantWeight: 60, typeWeights: [{ type: '纳指100', weight: 60 }] },
    holdings: [{ code: '270042', name: 'A', weight: 60 }, { code: '096001', name: 'B', weight: 40 }]
  };
  const corrResult = { codes: ['270042','096001'], matrix: [[1,0.92],[0.92,1]] };
  const report = risk.formatRiskReport(riskResult, corrResult);
  assert.ok(report.includes('相关'));
  assert.ok(report.includes('0.92'));
});
