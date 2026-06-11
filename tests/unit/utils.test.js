/**
 * Tests for lib/utils.js
 */

const test = require('node:test');
const assert = require('node:assert');

const utils = require('../../lib/utils');

// ========== formatLocalDate ==========

test('formatLocalDate - formats Date object', function() {
  const result = utils.formatLocalDate(new Date('2026-06-03'));
  assert.strictEqual(result, '2026-06-03');
});

test('formatLocalDate - formats date string', function() {
  const result = utils.formatLocalDate('2026-06-03');
  assert.strictEqual(result, '2026-06-03');
});

test('formatLocalDate - pads single digit month/day', function() {
  const result = utils.formatLocalDate(new Date('2026-01-05'));
  assert.strictEqual(result, '2026-01-05');
});

// ========== normalizeDate ==========

test('normalizeDate - converts slashes to dashes', function() {
  assert.strictEqual(utils.normalizeDate('2026/6/3'), '2026-06-03');
  assert.strictEqual(utils.normalizeDate('2026/06/03'), '2026-06-03');
});

test('normalizeDate - handles already normalized date', function() {
  assert.strictEqual(utils.normalizeDate('2026-06-03'), '2026-06-03');
});

test('normalizeDate - handles empty/null', function() {
  assert.strictEqual(utils.normalizeDate(''), '');
  assert.strictEqual(utils.normalizeDate(null), '');
  assert.strictEqual(utils.normalizeDate(undefined), '');
});

// ========== round1 / round2 ==========

test('round1 - rounds to 1 decimal', function() {
  assert.strictEqual(utils.round1(3.456), 3.5);
  assert.strictEqual(utils.round1(3.44), 3.4);
  assert.strictEqual(utils.round1(3.0), 3);
});

test('round2 - rounds to 2 decimals', function() {
  assert.strictEqual(utils.round2(3.456), 3.46);
  assert.strictEqual(utils.round2(3.454), 3.45);
  assert.strictEqual(utils.round2(3.0), 3);
});

// ========== daysBetween ==========

test('daysBetween - calculates correct difference', function() {
  assert.strictEqual(utils.daysBetween('2026-06-01', '2026-06-05'), 4);
  assert.strictEqual(utils.daysBetween('2026-06-05', '2026-06-01'), -4);
  assert.strictEqual(utils.daysBetween('2026-06-01', '2026-06-01'), 0);
});

// ========== addDaysToDate ==========

test('addDaysToDate - adds days correctly', function() {
  assert.strictEqual(utils.addDaysToDate('2026-06-01', 5), '2026-06-06');
  assert.strictEqual(utils.addDaysToDate('2026-06-01', 0), '2026-06-01');
});

test('addDaysToDate - handles month boundary', function() {
  assert.strictEqual(utils.addDaysToDate('2026-06-28', 5), '2026-07-03');
});

// ========== loadNavCache ==========

test('loadNavCache - returns object', function() {
  const cache = utils.loadNavCache();
  assert.strictEqual(typeof cache, 'object');
  assert.ok(cache !== null);
});
