/**
 * Tests for lib/fund-data.js
 * Uses Node.js built-in test runner (node:test)
 */

var test = require('node:test');
var assert = require('node:assert');
var fd = require('../../lib/fund-data');

// ========== calcIndicators ==========

test('calcIndicators - null returns error', function () {
  var result = fd.calcIndicators(null);
  assert.strictEqual(result.error, 'insufficient data');
});

test('calcIndicators - empty array returns error', function () {
  var result = fd.calcIndicators([]);
  assert.strictEqual(result.error, 'insufficient data');
});

test('calcIndicators - less than 5 entries returns error', function () {
  var result = fd.calcIndicators([{ date: '2025-01-01', nav: 10 }, { date: '2025-01-02', nav: 11 }]);
  assert.strictEqual(result.error, 'insufficient data');
});

test('calcIndicators - returns all expected fields', function () {
  var navs = [];
  for (var i = 0; i < 300; i++) {
    navs.push({ date: '2025-01-' + String((i%365)+1).padStart(2,'0'), nav: 10 + Math.sin(i/10)*2 });
  }
  var result = fd.calcIndicators(navs);
  assert.ok(result.hasOwnProperty('latest'));
  assert.ok(result.hasOwnProperty('ma5'));
  assert.ok(result.hasOwnProperty('ma10'));
  assert.ok(result.hasOwnProperty('ma20'));
  assert.ok(result.hasOwnProperty('volatility'));
  assert.ok(result.hasOwnProperty('maxDrawdown'));
  assert.ok(result.hasOwnProperty('longTermTrend'));
  assert.ok(result.hasOwnProperty('dataPoints'));
  assert.strictEqual(result.dataPoints, 300);
});

test('calcIndicators - constant nav has zero volatility and drawdown', function () {
  var navs = [];
  for (var i = 0; i < 100; i++) {
    navs.push({ date: '2025-01-' + String(i+1).padStart(2,'0'), nav: 10 });
  }
  var result = fd.calcIndicators(navs);
  assert.strictEqual(result.volatility, 0);
  assert.strictEqual(result.maxDrawdown, 0);
});

test('calcIndicators - maxDrawdown is non-positive', function () {
  var navs = [];
  for (var i = 0; i < 300; i++) {
    navs.push({ date: '2025-01-' + String((i%365)+1).padStart(2,'0'), nav: 10 + Math.sin(i/10)*2 });
  }
  var result = fd.calcIndicators(navs);
  assert.ok(result.maxDrawdown <= 0);
});

test('calcIndicators - volatility is non-negative', function () {
  var navs = [];
  for (var i = 0; i < 200; i++) {
    navs.push({ date: '2025-01-' + String((i%365)+1).padStart(2,'0'), nav: 10 + Math.sin(i/10)*2 });
  }
  var result = fd.calcIndicators(navs);
  assert.ok(result.volatility >= 0);
});

test('calcIndicators - less than 250 points shows unknown trend', function () {
  var navs = [];
  for (var i = 0; i < 100; i++) {
    navs.push({ date: '2025-01-' + String((i%365)+1).padStart(2,'0'), nav: 10 + i*0.05 });
  }
  var result = fd.calcIndicators(navs);
  assert.strictEqual(result.longTermTrend, 'unknown');
});

test('calcIndicators - with 250 points has yearReturn', function () {
  var navs = [];
  for (var i = 0; i < 250; i++) {
    navs.push({ date: '2025-01-' + String((i%365)+1).padStart(2,'0'), nav: 10 + i*0.05 });
  }
  var result = fd.calcIndicators(navs);
  assert.ok(typeof result.yearReturn === 'number');
  assert.ok(result.yearReturn > 0);
});

test('calcIndicators - with 750 points has annualizedReturn', function () {
  var navs = [];
  for (var i = 0; i < 750; i++) {
    navs.push({ date: '2023-01-' + String((i%365)+1).padStart(2,'0'), nav: 10 + i*0.01 });
  }
  var result = fd.calcIndicators(navs);
  assert.ok(result.annualizedReturn !== null);
  assert.ok(result.threeYearReturn !== null);
});

// ========== loadNavCache ==========

test('loadNavCache - returns an object', function () {
  var cache = fd.loadNavCache();
  assert.ok(typeof cache === 'object');
  assert.ok(!Array.isArray(cache));
});

test('loadNavCache - contains fund records with date/nav (if cache exists)', function () {
  var cache = fd.loadNavCache();
  var keys = Object.keys(cache);
  // [fix] nav-cache.json may not exist in CI (removed from git tracking)
  if (keys.length === 0) return; // skip if no cache file
  var first = cache[keys[0]];
  assert.ok(Array.isArray(first));
  assert.ok(first[0].hasOwnProperty('date'));
  assert.ok(first[0].hasOwnProperty('nav'));
});
