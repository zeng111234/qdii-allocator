/**
 * fund-data.js 核心测试 — 只测计算正确性和边界
 */
const test = require('node:test');
const assert = require('node:assert');
const fd = require('../../lib/fund-data');

// ─── 数据不足返回错误 ───

test('calcIndicators: null 返回 insufficient data', function () {
  const result = fd.calcIndicators(null);
  assert.strictEqual(result.error, 'insufficient data');
});

test('calcIndicators: 空数组返回 insufficient data', function () {
  const result = fd.calcIndicators([]);
  assert.strictEqual(result.error, 'insufficient data');
});

test('calcIndicators: 少于5条返回 insufficient data', function () {
  const result = fd.calcIndicators([{ date: '2025-01-01', nav: 10 }, { date: '2025-01-02', nav: 11 }]);
  assert.strictEqual(result.error, 'insufficient data');
});

// ─── 常数净值的数学性质 ───

test('calcIndicators: 常数净值的波动率为0、回撤为0', function () {
  const navs = [];
  for (let i = 0; i < 100; i++) {
    navs.push({ date: '2025-01-' + String(i+1).padStart(2,'0'), nav: 10 });
  }
  const result = fd.calcIndicators(navs);
  assert.strictEqual(result.volatility, 0);
  assert.strictEqual(result.maxDrawdown, 0);
});

// ─── 回撤数学性质 ───

test('calcIndicators: 回撤永远非正（最大回撤 <= 0）', function () {
  const navs = [];
  for (let i = 0; i < 300; i++) {
    navs.push({ date: '2025-01-' + String((i%365)+1).padStart(2,'0'), nav: 10 + Math.sin(i/10)*2 });
  }
  const result = fd.calcIndicators(navs);
  assert.ok(result.maxDrawdown <= 0, '最大回撤应<=0，得到' + result.maxDrawdown);
});

// ─── 波动率数学性质 ───

test('calcIndicators: 波动率永远非负', function () {
  const navs = [];
  for (let i = 0; i < 200; i++) {
    navs.push({ date: '2025-01-' + String((i%365)+1).padStart(2,'0'), nav: 10 + Math.sin(i/10)*2 });
  }
  const result = fd.calcIndicators(navs);
  assert.ok(result.volatility >= 0, '波动率应>=0，得到' + result.volatility);
});

// ─── 长期趋势判断 ───

test('calcIndicators: 数据不足250天时趋势为 unknown', function () {
  const navs = [];
  for (let i = 0; i < 100; i++) {
    navs.push({ date: '2025-01-' + String((i%365)+1).padStart(2,'0'), nav: 10 + i*0.05 });
  }
  const result = fd.calcIndicators(navs);
  assert.strictEqual(result.longTermTrend, 'unknown');
});

test('calcIndicators: 持续上涨3年趋势为 bull', function () {
  const navs = [];
  for (let i = 0; i < 750; i++) {
    navs.push({ date: '2023-01-' + String((i%365)+1).padStart(2,'0'), nav: 10 + i*0.01 });
  }
  const result = fd.calcIndicators(navs);
  assert.strictEqual(result.longTermTrend, 'bull');
});

// ─── 年化收益率计算 ───

test('calcIndicators: 有250天数据时有 yearReturn', function () {
  const navs = [];
  for (let i = 0; i < 250; i++) {
    navs.push({ date: '2025-01-' + String((i%365)+1).padStart(2,'0'), nav: 10 + i*0.05 });
  }
  const result = fd.calcIndicators(navs);
  assert.strictEqual(typeof result.yearReturn, 'number');
  assert.ok(result.yearReturn > 0, '上涨市场的 yearReturn 应>0');
});

test('calcIndicators: 有750天数据时有 annualizedReturn 和 threeYearReturn', function () {
  const navs = [];
  for (let i = 0; i < 750; i++) {
    navs.push({ date: '2023-01-' + String((i%365)+1).padStart(2,'0'), nav: 10 + i*0.01 });
  }
  const result = fd.calcIndicators(navs);
  assert.ok(result.annualizedReturn !== null);
  assert.ok(result.threeYearReturn !== null);
});

// ─── loadNavCache ───

test('loadNavCache: 返回对象', function () {
  const cache = fd.loadNavCache();
  assert.ok(typeof cache === 'object');
  assert.ok(!Array.isArray(cache));
});
