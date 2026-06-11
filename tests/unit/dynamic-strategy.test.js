/**
 * Tests for lib/dynamic-strategy.js
 * Uses Node.js built-in test runner (node:test)
 */

var test = require('node:test');
var assert = require('node:assert');
var ds = require('../../lib/dynamic-strategy');

// ========== WEIGHTS ==========

test('WEIGHTS - has all expected keys', function () {
  var keys = Object.keys(ds.WEIGHTS);
  assert.ok(keys.includes('base'));
  assert.ok(keys.includes('suspended'));
  assert.ok(keys.includes('yearReturn'));
  assert.ok(keys.includes('sharpeRatio'));
  assert.ok(keys.includes('maxDrawdown'));
  assert.ok(keys.includes('longTermBull'));
  assert.ok(keys.includes('longTermBear'));
  assert.ok(keys.includes('premiumPenalty'));
  assert.ok(keys.includes('scarcityBonus'));
});

test('WEIGHTS - base and suspended have expected values', function () {
  assert.strictEqual(ds.WEIGHTS.base, 10);
  assert.strictEqual(ds.WEIGHTS.suspended, -999);
});

// ========== scoreFund ==========

test('scoreFund - suspended fund returns -999', function () {
  var result = ds.scoreFund(
    { code: 'A', name: 'Test', status: 'suspended', dailyLimit: 0 },
    {}, null, null, null, null
  );
  assert.strictEqual(result.score, -999);
  assert.ok(result.reason.includes('暂停申购'));
});

test('scoreFund - zero dailyLimit returns -999', function () {
  var result = ds.scoreFund(
    { code: 'A', name: 'Test', status: 'active', dailyLimit: 0 },
    {}, null, null, null, null
  );
  assert.strictEqual(result.score, -999);
});

test('scoreFund - insufficient data returns -1', function () {
  var result = ds.scoreFund(
    { code: 'A', name: 'Test', status: 'active', dailyLimit: 1000 },
    { error: 'insufficient data', dataPoints: 10 },
    null, null, null, null
  );
  assert.strictEqual(result.score, -1);
  assert.ok(result.reason.includes('数据不足'));
});

function makeIndicators(overrides) {
  return Object.assign({
    latest: 10, dataPoints: 250,
    yearReturn: 10, threeYearReturn: 30,
    sharpeRatio: 1.0, maxDrawdown: -20,
    maDeviation: 0, drawdown: 0,
    recent5Change: 0, volatility: 1.5,
    longTermTrend: 'neutral',
    annualizedReturn: 8,
    navs: [9,9.5,10,10.5,11,11.5,12,12.5,13,13.5,14,14.5,15,15.5,16,16.5,17,17.5,18,18.5]
  }, overrides || {});
}

test('scoreFund - bull trend adds score', function () {
  var bull = ds.scoreFund({ code: 'A', name: 'T', status: 'active', dailyLimit: 1000 },
    makeIndicators({ longTermTrend: 'bull' }), null, null, null, null);
  var neutral = ds.scoreFund({ code: 'A', name: 'T', status: 'active', dailyLimit: 1000 },
    makeIndicators({ longTermTrend: 'neutral' }), null, null, null, null);
  assert.ok(bull.score > neutral.score);
  assert.ok(bull.reason.includes('长期牛市'));
});

test('scoreFund - bear trend subtracts score', function () {
  var bear = ds.scoreFund({ code: 'A', name: 'T', status: 'active', dailyLimit: 1000 },
    makeIndicators({ longTermTrend: 'bear' }), null, null, null, null);
  var neutral = ds.scoreFund({ code: 'A', name: 'T', status: 'active', dailyLimit: 1000 },
    makeIndicators({ longTermTrend: 'neutral' }), null, null, null, null);
  assert.ok(bear.score < neutral.score);
  assert.ok(bear.reason.includes('长期熊市'));
});

test('scoreFund - sharpe ratio affects score', function () {
  var high = ds.scoreFund({ code: 'A', name: 'T', status: 'active', dailyLimit: 1000 },
    makeIndicators({ sharpeRatio: 2.0 }), null, null, null, null);
  var low = ds.scoreFund({ code: 'A', name: 'T', status: 'active', dailyLimit: 1000 },
    makeIndicators({ sharpeRatio: 0.1 }), null, null, null, null);
  assert.ok(high.score > low.score);
});

test('scoreFund - maxDrawdown penalty applied', function () {
  var high = ds.scoreFund({ code: 'A', name: 'T', status: 'active', dailyLimit: 1000 },
    makeIndicators({ maxDrawdown: -50 }), null, null, null, null);
  var low = ds.scoreFund({ code: 'A', name: 'T', status: 'active', dailyLimit: 1000 },
    makeIndicators({ maxDrawdown: -10 }), null, null, null, null);
  assert.ok(high.score < low.score);
});

test('scoreFund - premium rate > 3% triggers penalty', function () {
  var result = ds.scoreFund({ code: 'A', name: 'T', status: 'active', dailyLimit: 1000 },
    makeIndicators(), null, null, { premiumRate: 5 }, null);
  assert.ok(result.reason.includes('溢价'));
});

test('scoreFund - premium rate <= 3% no penalty', function () {
  var result = ds.scoreFund({ code: 'A', name: 'T', status: 'active', dailyLimit: 1000 },
    makeIndicators(), null, null, { premiumRate: 2 }, null);
  assert.ok(!result.reason.includes('溢价'));
});

test('scoreFund - consecutive picks trigger rotation penalty', function () {
  var result = ds.scoreFund({ code: 'A', name: 'T', status: 'active', dailyLimit: 1000 },
    makeIndicators(), null, { A: 3 }, null, null);
  assert.ok(result.reason.includes('连续推荐'));
});

test('scoreFund - fee rate penalty applied', function () {
  var result = ds.scoreFund({ code: 'A', name: 'T', status: 'active', dailyLimit: 1000, feeRate: 1.5 },
    makeIndicators(), null, null, null, null);
  assert.ok(result.reason.includes('费率'));
});

test('scoreFund - scarce dailyLimit gets bonus', function () {
  var result = ds.scoreFund({ code: 'A', name: 'T', status: 'active', dailyLimit: 10, _purchaseStatus: 'limited' },
    makeIndicators(), null, null, null, null);
  assert.ok(result.reason.includes('稀缺'));
});

test('scoreFund - historical success rate adds bonus', function () {
  var withH = ds.scoreFund({ code: 'A', name: 'T', status: 'active', dailyLimit: 1000 },
    makeIndicators(), { successRate: 0.8 }, null, null, null);
  var noH = ds.scoreFund({ code: 'A', name: 'T', status: 'active', dailyLimit: 1000 },
    makeIndicators(), null, null, null, null);
  assert.ok(withH.score >= noH.score);
});

// ========== rankTopN ==========

test('rankTopN - returns top N by score descending', function () {
  var scored = [
    { code: 'A', name: 'A', score: 15 },
    { code: 'B', name: 'B', score: 12 },
    { code: 'C', name: 'C', score: 8 },
    { code: 'D', name: 'D', score: 5 }
  ];
  var ranked = ds.rankTopN(scored, 2);
  assert.strictEqual(ranked.length, 2);
  assert.strictEqual(ranked[0].code, 'A');
  assert.strictEqual(ranked[0].rank, 1);
});

test('rankTopN - excludes non-positive scores', function () {
  var scored = [
    { code: 'A', name: 'A', score: 15 },
    { code: 'B', name: 'B', score: 0 },
    { code: 'C', name: 'C', score: -1 },
    { code: 'D', name: 'D', score: 5 }
  ];
  var ranked = ds.rankTopN(scored, 10);
  assert.strictEqual(ranked.length, 2);
});

test('rankTopN - empty returns empty', function () {
  assert.deepStrictEqual(ds.rankTopN([], 5), []);
});

test('rankTopN - defaults to top 10', function () {
  var scored = [];
  for (var i = 0; i < 15; i++) scored.push({ code: 'F'+i, name: 'F'+i, score: 20-i });
  var ranked = ds.rankTopN(scored);
  assert.strictEqual(ranked.length, 10);
});

// ========== formatDynamicResult ==========

test('formatDynamicResult - includes header and budget', function () {
  var result = {
    date: '2026/06/09', budget: 1000, strategyName: '动态评分',
    totalPool: 5, allAvailable: 3, ranked: [], suspended: [], dataMissing: []
  };
  var text = ds.formatDynamicResult(result);
  assert.ok(text.includes('投资排名'));
  assert.ok(text.includes('1000'));
});

test('formatDynamicResult - with ranked funds shows details', function () {
  var result = {
    date: '2026/06/09', budget: 500, strategyName: '动态评分',
    totalPool: 3, allAvailable: 2,
    ranked: [{
      rank: 1, code: '270042', name: 'Test Fund', score: 18.5,
      type: '纳指100', dailyLimit: 100,
      indicators: { longTermTrend: 'bull', annualizedReturn: 12, threeYearReturn: 40, sharpeRatio: 1.5, maxDrawdown: -20, recent5Change: 2, maDeviation: -3, volatility: 1.2 },
      reason: '夏普加分'
    }],
    suspended: [], dataMissing: []
  };
  var text = ds.formatDynamicResult(result);
  assert.ok(text.includes('Test Fund'));
  assert.ok(text.includes('18.5'));
  assert.ok(text.includes('🟢'));
});

test('formatDynamicResult - no ranked shows empty message', function () {
  var result = {
    date: '2026/06/09', budget: 500, strategyName: '动态评分',
    totalPool: 3, allAvailable: 0, ranked: [], suspended: [], dataMissing: []
  };
  var text = ds.formatDynamicResult(result);
  assert.ok(text.includes('无有效'));
});

test('formatDynamicResult - shows suspended funds', function () {
  var result = {
    date: '2026/06/09', budget: 500, strategyName: '动态评分',
    totalPool: 3, allAvailable: 1, ranked: [],
    suspended: [{ code: 'C', name: 'Suspended', status: 'suspended' }],
    dataMissing: []
  };
  var text = ds.formatDynamicResult(result);
  assert.ok(text.includes('跳过'));
});
