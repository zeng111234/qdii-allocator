/**
 * Tests for lib/trading-calendar.js
 * Uses Node.js built-in test runner (node:test)
 */

var test = require('node:test');
var assert = require('node:assert');
var tradingCal = require('../../lib/trading-calendar');

test('isWeekday - Monday is weekday', function() {
  assert.strictEqual(tradingCal.isWeekday('2026-06-08'), true);
});

test('isWeekday - Friday is weekday', function() {
  assert.strictEqual(tradingCal.isWeekday('2026-06-12'), true);
});

test('isWeekday - Saturday is not weekday', function() {
  assert.strictEqual(tradingCal.isWeekday('2026-06-13'), false);
});

test('isWeekday - Sunday is not weekday', function() {
  assert.strictEqual(tradingCal.isWeekday('2026-06-14'), false);
});

test('isHoliday - New Year 2026 is holiday', function() {
  assert.strictEqual(tradingCal.isHoliday('2026-01-01'), true);
});

test('isHoliday - Spring Festival 2026 is holiday', function() {
  assert.strictEqual(tradingCal.isHoliday('2026-02-17'), true);
});

test('isHoliday - regular day is not holiday', function() {
  assert.strictEqual(tradingCal.isHoliday('2026-06-10'), false);
});

test('isTradingDay - regular weekday is trading day', function() {
  assert.strictEqual(tradingCal.isTradingDay('2026-06-10'), true);
});

test('isTradingDay - weekend is not trading day', function() {
  assert.strictEqual(tradingCal.isTradingDay('2026-06-13'), false);
});

test('isTradingDay - holiday is not trading day', function() {
  assert.strictEqual(tradingCal.isTradingDay('2026-01-01'), false);
});

test('addTradingDays - Wednesday + 2 = Friday (no skip)', function() {
  var result = tradingCal.addTradingDays('2026-06-10', 2);
  assert.strictEqual(result.date, '2026-06-12');
  assert.strictEqual(result.skipped, 0);
});

test('addTradingDays - Thursday + 2 = Monday (crosses weekend)', function() {
  var result = tradingCal.addTradingDays('2026-06-11', 2);
  assert.strictEqual(result.date, '2026-06-15');
  assert.strictEqual(result.skipped, 2);
});

test('addTradingDays - Friday + 2 = Tuesday (crosses weekend)', function() {
  var result = tradingCal.addTradingDays('2026-06-12', 2);
  assert.strictEqual(result.date, '2026-06-16');
  assert.strictEqual(result.skipped, 2);
});

test('addTradingDays - 0 days returns same date', function() {
  var result = tradingCal.addTradingDays('2026-06-10', 0);
  assert.strictEqual(result.date, '2026-06-10');
  assert.strictEqual(result.skipped, 0);
});

test('addTradingDays - across Spring Festival', function() {
  var result = tradingCal.addTradingDays('2026-02-13', 2);
  assert.strictEqual(result.date, '2026-02-24');
  assert.ok(result.skipped > 7);
});

test('addTradingDays - across Labor Day', function() {
  var result = tradingCal.addTradingDays('2026-04-30', 2);
  assert.strictEqual(result.date, '2026-05-07');
});

test('getWeekdayName - returns Chinese weekday', function() {
  assert.strictEqual(tradingCal.getWeekdayName('2026-06-08'), '周一');
  assert.strictEqual(tradingCal.getWeekdayName('2026-06-09'), '周二');
  assert.strictEqual(tradingCal.getWeekdayName('2026-06-13'), '周六');
});
