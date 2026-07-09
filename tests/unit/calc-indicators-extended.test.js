/**
 * calcIndicators 扩展测试 — 只测新增的 peakDistance 和关键边界
 */
const test = require('node:test');
const assert = require('node:assert');
const { calcIndicators } = require('../../lib/fund-data');

function makeNavs(days, startNav, dailyReturn) {
  const navs = [];
  let nav = startNav || 1.0;
  for (let i = 0; i < days; i++) {
    navs.push({ date: `2025-${String(Math.floor(i/30)+1).padStart(2,'0')}-${String((i%30)+1).padStart(2,'0')}`, nav: Math.round(nav * 10000) / 10000 });
    nav *= (1 + (dailyReturn || 0.001));
  }
  return navs;
}

// ─── peakDistance（新增指标，必须验证） ───

test('peakDistance: 持续上涨时接近 0', () => {
  const navs = makeNavs(300, 1.0, 0.001);
  const result = calcIndicators(navs);
  assert.ok(result.peakDistance >= -0.5, `持续上涨 peakDistance 应>=-0.5，得到${result.peakDistance}`);
});

test('peakDistance: 下跌后为负值', () => {
  const navs = [];
  for (let i = 0; i < 100; i++) navs.push({ date: `2025-01-${String(i+1).padStart(2,'0')}`, nav: 1.0 + i * 0.01 });
  for (let i = 0; i < 50; i++) navs.push({ date: `2025-05-${String(i+1).padStart(2,'0')}`, nav: navs[navs.length-1].nav * 0.99 });
  const result = calcIndicators(navs);
  assert.ok(result.peakDistance < 0, `下跌后 peakDistance 应<0，得到${result.peakDistance}`);
});

// ─── drawdown 正负号（曾出过 bug） ───

test('drawdown: 持续上涨时为 0', () => {
  const navs = makeNavs(300, 1.0, 0.002);
  const result = calcIndicators(navs);
  assert.strictEqual(result.drawdown, 0);
});

// ─── 零值输入不崩溃 ───

test('calcIndicators: 含 0 净值不崩溃', () => {
  const navs = [];
  for (let i = 0; i < 100; i++) {
    navs.push({ date: `2025-01-${String(i+1).padStart(2,'0')}`, nav: i === 50 ? 0 : 10 + i * 0.01 });
  }
  const result = calcIndicators(navs);
  assert.ok(result, '不应崩溃');
});
