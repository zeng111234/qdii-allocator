/**
 * factor-engine.js 核心测试 — 只测排名去重和数据不足处理
 */
const test = require('node:test');
const assert = require('node:assert');
const { computeAll, weightedSum, computeRankings, DEFAULT_WEIGHTS } = require('../../lib/factor-engine');

function makeNavArray(days, startNav, dailyReturn) {
  const navs = [];
  let nav = startNav || 1.0;
  for (let i = 0; i < days; i++) {
    navs.push(nav);
    nav *= (1 + (dailyReturn || 0.001));
  }
  return navs;
}

function makeFundMeta(overrides) {
  return Object.assign({
    code: 'F00001', name: 'Test Fund', type: '纳指100',
    feeRate: 0.8, custodyFee: 0.2, status: 'active',
    dailyLimit: 100, indexGroup: 'NDX100'
  }, overrides || {});
}

// ─── 数据不足时返回 null，不崩溃 ───

test('computeAll: 数据不足返回 null 而不是崩溃', () => {
  const scores = computeAll(null, makeFundMeta(), null);
  assert.strictEqual(scores.volatility_hist, null);
  assert.strictEqual(scores.drawdown_depth, null);
});

test('computeRankings: 缓存为空时返回 insufficient', () => {
  const funds = [makeFundMeta()];
  const results = computeRankings(funds, {}, null);
  assert.strictEqual(results[0].composite, null);
  assert.strictEqual(results[0].insufficient, true);
});

// ─── 排名去重（核心逻辑） ───

test('computeRankings: 同 indexGroup 去重，保留最高分', () => {
  const funds = [
    makeFundMeta({ code: 'A', name: '高分基金', indexGroup: 'NDX100' }),
    makeFundMeta({ code: 'B', name: '低分基金', indexGroup: 'NDX100' }),
    makeFundMeta({ code: 'C', name: '标普基金', indexGroup: 'SPX500' }),
  ];
  const navCache = {
    'A': makeNavArray(300, 1.0, 0.003).map((nav, i) => ({ date: `2025-01-${String(i+1).padStart(2,'0')}`, nav })),
    'B': makeNavArray(300, 1.0, 0.001).map((nav, i) => ({ date: `2025-01-${String(i+1).padStart(2,'0')}`, nav })),
    'C': makeNavArray(300, 1.0, 0.002).map((nav, i) => ({ date: `2025-01-${String(i+1).padStart(2,'0')}`, nav })),
  };
  const results = computeRankings(funds, navCache, null);
  const fundB = results.find(r => r.code === 'B');
  assert.strictEqual(fundB.deduped, true, '低分基金应被去重');
});

// ─── 暂停基金不阻塞活跃基金（用户投诉过的 bug） ───

test('computeRankings: 暂停基金不阻塞同指数活跃基金', () => {
  const funds = [
    makeFundMeta({ code: 'A', name: '暂停基金', indexGroup: 'NDX100', status: 'suspended', dailyLimit: 0 }),
    makeFundMeta({ code: 'B', name: '活跃基金', indexGroup: 'NDX100', status: 'active', dailyLimit: 10 }),
  ];
  const navCache = {
    'A': makeNavArray(300, 1.0, 0.003).map((nav, i) => ({ date: `2025-01-${String(i+1).padStart(2,'0')}`, nav })),
    'B': makeNavArray(300, 1.0, 0.001).map((nav, i) => ({ date: `2025-01-${String(i+1).padStart(2,'0')}`, nav })),
  };
  const results = computeRankings(funds, navCache, null);
  const fundB = results.find(r => r.code === 'B');
  assert.strictEqual(fundB.deduped, false, '活跃基金不应被暂停基金去重');
});

// ─── 加权求和忽略 null 因子 ───

test('weightedSum: 忽略 null 因子', () => {
  const full = weightedSum({ volatility_hist: 10, trend_alignment: 20 }, DEFAULT_WEIGHTS);
  const partial = weightedSum({ volatility_hist: 10, trend_alignment: null }, DEFAULT_WEIGHTS);
  assert.notStrictEqual(full, partial);
});
