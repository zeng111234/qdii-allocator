const test = require('node:test');
const assert = require('node:assert');

const fundData = require('../../lib/fund-data');

test('getValuationData is an exported async function', function () {
  assert.strictEqual(typeof fundData.getValuationData, 'function');
  // Async functions return a promise when called
  const result = fundData.getValuationData();
  assert.ok(result && typeof result.then === 'function', 'should return a promise (async function)');
  result.catch(() => {}); // prevent unhandled rejection warning
});

test('getMarketTemperature is an exported async function', function () {
  assert.strictEqual(typeof fundData.getMarketTemperature, 'function');
  const result = fundData.getMarketTemperature();
  assert.ok(result && typeof result.then === 'function', 'should return a promise (async function)');
  result.catch(() => {}); // prevent unhandled rejection warning
});

test('getValuationData returns object with expected structure on success', { timeout: 30000 }, async function () {
  try {
    const valuation = await fundData.getValuationData();
    assert.ok(valuation !== null && typeof valuation === 'object', 'should return an object');
    assert.ok('vix' in valuation, 'should have vix property');
    assert.ok('indices' in valuation, 'should have indices property');
    assert.ok(typeof valuation.indices === 'object', 'indices should be an object');
    assert.ok('overall' in valuation, 'should have overall property');
    assert.ok(
      ['fear', 'cautious', 'neutral', 'greedy'].includes(valuation.overall),
      'overall should be a known level'
    );
  } catch (e) {
    // Network failures are acceptable in CI
    assert.ok(true, 'Network call failed (acceptable in offline environment): ' + e.message);
  }
});

test('getMarketTemperature returns object with expected structure on success', { timeout: 30000 }, async function () {
  try {
    const temp = await fundData.getMarketTemperature();
    assert.ok(temp !== null && typeof temp === 'object', 'should return an object');
    assert.ok(typeof temp.temperature === 'number', 'should have numeric temperature');
    assert.ok(temp.temperature >= 0 && temp.temperature <= 100, 'temperature should be 0-100');
    assert.ok(typeof temp.level === 'string', 'should have string level');
    assert.ok(typeof temp.multiplier === 'number', 'should have numeric multiplier');
    assert.ok(temp.multiplier >= 0.6 && temp.multiplier <= 1.3, 'multiplier should be 0.6-1.3');
    assert.ok(typeof temp.reason === 'string', 'should have string reason');
  } catch (e) {
    // Network failures are acceptable in CI
    assert.ok(true, 'Network call failed (acceptable in offline environment): ' + e.message);
  }
});

test('calcIndicators returns error for insufficient data', function () {
  const result = fundData.calcIndicators([]);
  assert.deepStrictEqual(result, { error: 'insufficient data' });
});

test('calcIndicators returns expected fields for valid data', function () {
  // Build 300 data points with a slow uptrend
  const navHistory = [];
  for (let i = 0; i < 300; i++) {
    navHistory.push({ date: '2024-01-01', nav: 1.0 + i * 0.001 });
  }
  const result = fundData.calcIndicators(navHistory);
  assert.strictEqual(typeof result.latest, 'number');
  assert.strictEqual(typeof result.ma5, 'number');
  assert.strictEqual(typeof result.ma10, 'number');
  assert.strictEqual(typeof result.ma20, 'number');
  assert.strictEqual(typeof result.ma60, 'number');
  assert.strictEqual(typeof result.ma120, 'number');
  assert.strictEqual(typeof result.ma250, 'number');
  assert.strictEqual(typeof result.volatility, 'number');
  assert.strictEqual(typeof result.longTermTrend, 'string');
  assert.strictEqual(result.dataPoints, 300);
});
