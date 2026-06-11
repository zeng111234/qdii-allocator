/**
 * Tests for lib/allocator.js
 * Uses Node.js built-in test runner (node:test)
 */

var test = require('node:test');
var assert = require('node:assert');
var alloc = require('../../lib/allocator');

// ========== Strategy constants ==========

test('Strategy - has expected constants', function () {
  assert.strictEqual(alloc.Strategy.EQUAL, 'equal');
  assert.strictEqual(alloc.Strategy.LOW_FEE, 'low_fee');
  assert.strictEqual(alloc.Strategy.SCARCE_FIRST, 'scarce');
});

// ========== filterAvailable ==========

test('filterAvailable - returns only active funds with positive dailyLimit', function () {
  var funds = [
    { code: '270042', name: 'A', status: 'active', dailyLimit: 100 },
    { code: '040046', name: 'B', status: 'active', dailyLimit: 0 },
    { code: '050025', name: 'C', status: 'suspended', dailyLimit: 100 },
    { code: '096001', name: 'D', status: 'active', dailyLimit: 50 }
  ];
  var result = alloc.filterAvailable(funds);
  assert.strictEqual(result.length, 2);
  assert.strictEqual(result[0].code, '270042');
  assert.strictEqual(result[1].code, '096001');
});

test('filterAvailable - respects minPurchase threshold', function () {
  var funds = [
    { code: 'A', name: 'A', status: 'active', dailyLimit: 100 },
    { code: 'B', name: 'B', status: 'active', dailyLimit: 30 },
    { code: 'C', name: 'C', status: 'active', dailyLimit: 10 }
  ];
  assert.strictEqual(alloc.filterAvailable(funds, 50).length, 1);
  assert.strictEqual(alloc.filterAvailable(funds, 20).length, 2);
  assert.strictEqual(alloc.filterAvailable(funds, 10).length, 3);
});

test('filterAvailable - empty array returns empty', function () {
  assert.deepStrictEqual(alloc.filterAvailable([]), []);
});

// ========== allocate - scarce strategy ==========

test('allocate - scarce strategy fills smallest dailyLimit first', function () {
  var funds = [
    { code: 'A', name: 'Fund A', status: 'active', dailyLimit: 100, feeRate: 1.5 },
    { code: 'B', name: 'Fund B', status: 'active', dailyLimit: 200, feeRate: 0.8 },
    { code: 'C', name: 'Fund C', status: 'active', dailyLimit: 50, feeRate: 1.2 }
  ];
  var result = alloc.allocate(300, funds, 'scarce');
  assert.strictEqual(result.allocations.length, 3);
  assert.strictEqual(result.allocations[0].code, 'C');
  assert.strictEqual(result.allocations[0].allocated, 50);
  assert.strictEqual(result.allocations[1].code, 'A');
  assert.strictEqual(result.allocations[1].allocated, 100);
  assert.strictEqual(result.allocations[2].code, 'B');
  assert.strictEqual(result.allocations[2].allocated, 150);
  assert.strictEqual(result.totalAllocated, 300);
});

// ========== allocate - equal strategy ==========

test('allocate - equal strategy distributes budget evenly', function () {
  var funds = [
    { code: 'A', name: 'Fund A', status: 'active', dailyLimit: 1000, feeRate: 1.5 },
    { code: 'B', name: 'Fund B', status: 'active', dailyLimit: 1000, feeRate: 0.8 },
    { code: 'C', name: 'Fund C', status: 'active', dailyLimit: 1000, feeRate: 1.2 }
  ];
  var result = alloc.allocate(300, funds, 'equal');
  assert.strictEqual(result.allocations.length, 3);
  result.allocations.forEach(function (f) {
    assert.strictEqual(f.allocated, 100);
  });
});

test('allocate - equal strategy respects dailyLimit', function () {
  var funds = [
    { code: 'A', name: 'Fund A', status: 'active', dailyLimit: 50, feeRate: 1.5 },
    { code: 'B', name: 'Fund B', status: 'active', dailyLimit: 1000, feeRate: 0.8 }
  ];
  var result = alloc.allocate(300, funds, 'equal');
  var a = result.allocations.find(function (f) { return f.code === 'A'; });
  var b = result.allocations.find(function (f) { return f.code === 'B'; });
  assert.strictEqual(a.allocated, 50);
  assert.strictEqual(b.allocated, 250);
});

// ========== allocate - low_fee strategy ==========

test('allocate - low_fee strategy prioritizes lower fee funds', function () {
  var funds = [
    { code: 'A', name: 'Fund A', status: 'active', dailyLimit: 1000, feeRate: 1.5 },
    { code: 'B', name: 'Fund B', status: 'active', dailyLimit: 1000, feeRate: 0.5 },
    { code: 'C', name: 'Fund C', status: 'active', dailyLimit: 1000, feeRate: 1.0 }
  ];
  var result = alloc.allocate(1000, funds, 'low_fee');
  assert.strictEqual(result.allocations.length, 1);
  assert.strictEqual(result.allocations[0].code, 'B');
  assert.strictEqual(result.allocations[0].allocated, 1000);
});

// ========== allocate - default strategy ==========

test('allocate - default strategy is scarce when not specified', function () {
  var funds = [
    { code: 'A', name: 'Fund A', status: 'active', dailyLimit: 100, feeRate: 1.5 },
    { code: 'B', name: 'Fund B', status: 'active', dailyLimit: 50, feeRate: 0.8 }
  ];
  var explicit = alloc.allocate(100, funds, 'scarce');
  var implicit = alloc.allocate(100, funds);
  assert.strictEqual(explicit.allocations.length, implicit.allocations.length);
});

// ========== allocate - no funds ==========

test('allocate - no funds returns empty result', function () {
  var result = alloc.allocate(300, [], 'equal');
  assert.strictEqual(result.allocations.length, 0);
  assert.strictEqual(result.totalAllocated, 0);
  assert.strictEqual(result.leftover, 300);
});

// ========== allocate - suspended funds ==========

test('allocate - suspended funds excluded from allocations', function () {
  var funds = [
    { code: 'A', name: 'Active Fund', status: 'active', dailyLimit: 1000 },
    { code: 'B', name: 'Suspended Fund', status: 'suspended', dailyLimit: 0 }
  ];
  var result = alloc.allocate(100, funds, 'equal');
  assert.strictEqual(result.allocations.length, 1);
  assert.strictEqual(result.suspended.length, 1);
});

// ========== allocate - result structure ==========

test('allocate - result has expected structure', function () {
  var funds = [
    { code: 'A', name: 'Fund A', status: 'active', dailyLimit: 100 }
  ];
  var result = alloc.allocate(50, funds, 'equal');
  assert.ok(result.hasOwnProperty('budget'));
  assert.ok(result.hasOwnProperty('strategy'));
  assert.ok(result.hasOwnProperty('strategyName'));
  assert.ok(result.hasOwnProperty('date'));
  assert.ok(result.hasOwnProperty('allocations'));
  assert.ok(result.hasOwnProperty('suspended'));
  assert.ok(result.hasOwnProperty('totalAllocated'));
  assert.ok(result.hasOwnProperty('leftover'));
});

test('allocate - strategy names are correct', function () {
  var funds = [{ code: 'A', name: 'Fund A', status: 'active', dailyLimit: 100 }];
  var eq = alloc.allocate(50, funds, 'equal');
  assert.strictEqual(eq.strategyName, '平均主义');
  var low = alloc.allocate(50, funds, 'low_fee');
  assert.strictEqual(low.strategyName, '低费率优先');
  var scarce = alloc.allocate(50, funds, 'scarce');
  assert.strictEqual(scarce.strategyName, '稀缺额度优先');
});

// ========== formatResult ==========

test('formatResult - includes budget and strategy info', function () {
  var funds = [{ code: 'A', name: 'Fund A', status: 'active', dailyLimit: 100 }];
  var result = alloc.allocate(50, funds, 'equal');
  var text = alloc.formatResult(result);
  assert.ok(text.includes('总预算'));
  assert.ok(text.includes('50'));
  assert.ok(text.includes('平均主义'));
  assert.ok(text.includes('合计买入'));
});

test('formatResult - no available funds shows no-purchase message', function () {
  var funds = [{ code: 'A', name: 'Fund A', status: 'suspended', dailyLimit: 0 }];
  var result = alloc.allocate(100, funds, 'equal');
  var text = alloc.formatResult(result);
  assert.ok(text.includes('无可申购'));
});

test('formatResult - shows suspended fund reasons', function () {
  var funds = [
    { code: 'A', name: 'SuspendedFund', status: 'suspended', dailyLimit: 0 },
    { code: 'B', name: 'ZeroLimitFund', status: 'active', dailyLimit: 0 }
  ];
  var result = alloc.allocate(100, funds, 'equal');
  var text = alloc.formatResult(result);
  assert.ok(text.includes('跳过'));
});
