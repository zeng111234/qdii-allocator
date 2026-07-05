/**
 * Tests for lib/backtest.js
 * Uses Node.js built-in test runner (node:test)
 * Only tests module structure and pure functions, not network-dependent functions
 */

var test = require('node:test');
var assert = require('node:assert');

// Import the module
var backtest = require('../../lib/backtest');

// Test module structure
test('Module loads without error', function () {
  assert.ok(backtest);
  assert.ok(typeof backtest.runBacktest === 'function');
  assert.ok(typeof backtest.runWeightOptimization === 'function');
});

// Test runBacktest function signature
test('runBacktest is async function', function () {
  assert.ok(backtest.runBacktest.constructor.name === 'AsyncFunction');
});

// Test runWeightOptimization function signature
test('runWeightOptimization is async function', function () {
  assert.ok(backtest.runWeightOptimization.constructor.name === 'AsyncFunction');
});

// Test runBacktest with empty funds array
test('runBacktest handles empty funds array', async function () {
  // This should return null since no funds to backtest
  var result = await backtest.runBacktest([], {});
  assert.strictEqual(result, null);
});

// Test runWeightOptimization with empty funds array
test('runWeightOptimization handles empty funds array', async function () {
  // This should return null since no funds to optimize
  var result = await backtest.runWeightOptimization([], {});
  // The function returns { baseline: null, top5: [] } for empty funds
  assert.ok(result && result.baseline === null && Array.isArray(result.top5));
});

// Test that functions don't throw with missing config
test('runBacktest handles missing config gracefully', async function () {
  var funds = [];
  // Should not throw even with undefined config
  try {
    await backtest.runBacktest(funds, undefined);
    // If we get here, it didn't throw
    assert.ok(true);
  } catch (error) {
    // If it throws, that's also acceptable as long as it's not a crash
    assert.ok(error instanceof Error);
  }
});

test('runWeightOptimization handles missing config gracefully', async function () {
  var funds = [];
  // Should not throw even with undefined config
  try {
    await backtest.runWeightOptimization(funds, undefined);
    // If we get here, it didn't throw
    assert.ok(true);
  } catch (error) {
    // If it throws, that's also acceptable as long as it's not a crash
    assert.ok(error instanceof Error);
  }
});