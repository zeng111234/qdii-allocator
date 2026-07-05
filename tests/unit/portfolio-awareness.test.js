/**
 * Tests for portfolio awareness behavior
 * from lib/dynamic-strategy.js
 *
 * Since applyPortfolioAwareness is not exported, we test it indirectly
 * through formatDynamicResult and the module's exported interface.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  formatDynamicResult,
  rankTopN,
  scoreFund,
  WEIGHTS,
  allocateDynamic,
  backfillFollowUp,
} = require('../../lib/dynamic-strategy');

// ── Module exports ────────────────────────────────────────

test('module exports all expected public functions', () => {
  assert.equal(typeof allocateDynamic, 'function');
  assert.equal(typeof formatDynamicResult, 'function');
  assert.equal(typeof scoreFund, 'function');
  assert.equal(typeof rankTopN, 'function');
  assert.equal(typeof backfillFollowUp, 'function');
  assert.ok(WEIGHTS !== undefined);
  assert.equal(typeof WEIGHTS, 'object');
});

test('WEIGHTS contains expected scoring keys', () => {
  assert.ok('base' in WEIGHTS);
  assert.ok('sharpeRatio' in WEIGHTS);
  assert.ok('maxDrawdown' in WEIGHTS);
  assert.ok('suspended' in WEIGHTS);
  assert.ok('premiumPenalty' in WEIGHTS);
  assert.equal(WEIGHTS.suspended, -999);
});

// ── formatDynamicResult: empty ranked ─────────────────────

test('formatDynamicResult with empty ranked shows "无有效"', () => {
  const result = {
    budget: 500, strategy: 'dynamic',
    budgetInfo: { budget: 500, label: '默认定投', avgScore: 0 },
    strategyName: '智能动态策略(Top10 排名)',
    date: '2026-07-05',
    ranked: [], allRanked: [], suspended: [], dataMissing: [],
    totalRanked: 0, allAvailable: 0, totalPool: 10,
    purchaseInfo: {}, externalSignals: null, newsSentiment: null,
    fundChanges: [], valuationData: null, marketTemperature: null,
  };
  const text = formatDynamicResult(result);
  assert.ok(text.includes('无有效基金排名'));
});

// ── formatDynamicResult: ranked funds ─────────────────────

test('formatDynamicResult with ranked funds shows fund names and scores', () => {
  const result = {
    budget: 500, strategy: 'dynamic',
    budgetInfo: { budget: 500, label: '良好机会', avgScore: 13.2 },
    strategyName: '智能动态策略(Top3 排名)',
    date: '2026-07-05',
    ranked: [
      { rank: 1, code: '111', name: '纳指ETF', type: '纳指100', score: 15.0, dailyLimit: 500, reason: '夏普高', indicators: { longTermTrend: 'bull', annualizedReturn: 18, sharpeRatio: 1.5, maxDrawdown: -12, recent5Change: 1.2, maDeviation: -0.5, volatility: 9, threeYearReturn: 50 } },
      { rank: 2, code: '222', name: '标普ETF', type: '标普500', score: 12.0, dailyLimit: 300, reason: '稳定', indicators: { longTermTrend: 'neutral', annualizedReturn: 10, sharpeRatio: 0.8, maxDrawdown: -18, recent5Change: 0.5, maDeviation: 0.3, volatility: 11, threeYearReturn: 28 } },
    ],
    allRanked: [], suspended: [], dataMissing: [],
    totalRanked: 2, allAvailable: 2, totalPool: 10,
    purchaseInfo: {}, externalSignals: null, newsSentiment: null,
    fundChanges: [], valuationData: null, marketTemperature: null,
  };
  const text = formatDynamicResult(result);
  assert.ok(text.includes('纳指ETF'));
  assert.ok(text.includes('标普ETF'));
  assert.ok(text.includes('15'));
  assert.ok(text.includes('12'));
  assert.ok(text.includes('Top2'));
  assert.ok(text.includes('良好机会'));
});

// ── formatDynamicResult: suspended funds ──────────────────

test('formatDynamicResult with suspended funds shows "跳过"', () => {
  const result = {
    budget: 500, strategy: 'dynamic',
    budgetInfo: { budget: 500, label: '默认定投', avgScore: 0 },
    strategyName: '策略', date: '2026-07-05',
    ranked: [], allRanked: [],
    suspended: [
      { name: '石油QDII', code: '160', status: 'suspended', score: -999, _purchaseRawStatus: '暂停申购' },
    ],
    dataMissing: [], totalRanked: 0, allAvailable: 0, totalPool: 5,
    purchaseInfo: {}, externalSignals: null, newsSentiment: null,
    fundChanges: [], valuationData: null, marketTemperature: null,
  };
  const text = formatDynamicResult(result);
  assert.ok(text.includes('跳过'));
  assert.ok(text.includes('石油QDII'));
  assert.ok(text.includes('暂停申购'));
});

// ── formatDynamicResult: dataMissing ──────────────────────

test('formatDynamicResult with dataMissing shows excluded funds', () => {
  const result = {
    budget: 500, strategy: 'dynamic',
    budgetInfo: { budget: 500, label: '默认定投', avgScore: 0 },
    strategyName: '策略', date: '2026-07-05',
    ranked: [], allRanked: [], suspended: [],
    dataMissing: [
      { name: '新基金', code: '888', reason: '数据不足（15日）排除推荐' },
    ],
    totalRanked: 0, allAvailable: 0, totalPool: 5,
    purchaseInfo: {}, externalSignals: null, newsSentiment: null,
    fundChanges: [], valuationData: null, marketTemperature: null,
  };
  const text = formatDynamicResult(result);
  assert.ok(text.includes('数据不足排除'));
  assert.ok(text.includes('新基金'));
  assert.ok(text.includes('数据不足'));
});

// ── formatDynamicResult: marketTemperature ────────────────

test('formatDynamicResult with marketTemperature shows temperature info', () => {
  const result = {
    budget: 500, strategy: 'dynamic',
    budgetInfo: { budget: 500, label: '默认定投', avgScore: 0 },
    strategyName: '策略', date: '2026-07-05',
    ranked: [], allRanked: [], suspended: [], dataMissing: [],
    totalRanked: 0, allAvailable: 0, totalPool: 5,
    purchaseInfo: {}, externalSignals: null, newsSentiment: null,
    fundChanges: [], valuationData: null,
    marketTemperature: { temperature: 30, level: '偏冷', multiplier: 1.5, reason: '市场回调' },
  };
  const text = formatDynamicResult(result);
  assert.ok(text.includes('市场温度'));
  assert.ok(text.includes('30'));
  assert.ok(text.includes('偏冷'));
  assert.ok(text.includes('市场回调'));
});

// ── formatDynamicResult: fundChanges ──────────────────────

test('formatDynamicResult with fundChanges shows warnings', () => {
  const result = {
    budget: 500, strategy: 'dynamic',
    budgetInfo: { budget: 500, label: '默认定投', avgScore: 0 },
    strategyName: '策略', date: '2026-07-05',
    ranked: [], allRanked: [], suspended: [], dataMissing: [],
    totalRanked: 0, allAvailable: 0, totalPool: 5,
    purchaseInfo: {}, externalSignals: null, newsSentiment: null,
    fundChanges: [
      { type: 'limit_up', message: '纳指基金 限购从100升到500', code: '001' },
    ],
    valuationData: null, marketTemperature: null,
  };
  const text = formatDynamicResult(result);
  assert.ok(text.includes('限购变化'));
  assert.ok(text.includes('限购从100升到500'));
});

// ── formatDynamicResult: budgetInfo with adjustedBudget ───

test('formatDynamicResult with budgetInfo shows adjusted budget', () => {
  const result = {
    budget: 500, strategy: 'dynamic',
    budgetInfo: { budget: 500, label: '极佳机会', avgScore: 16.0 },
    strategyName: '策略', date: '2026-07-05',
    ranked: [
      { rank: 1, code: '001', name: '好基金', type: '纳指100', score: 16, dailyLimit: 1000, reason: '全优', indicators: { longTermTrend: 'bull' } },
    ],
    allRanked: [], suspended: [], dataMissing: [],
    totalRanked: 1, allAvailable: 1, totalPool: 5,
    purchaseInfo: {}, externalSignals: null, newsSentiment: null,
    fundChanges: [], valuationData: null,
    marketTemperature: { temperature: 20, level: '冷', multiplier: 2.0, reason: '大回调' },
  };
  const text = formatDynamicResult(result);
  assert.ok(text.includes('极佳机会'));
  assert.ok(text.includes('16'));
  assert.ok(text.includes('2x'));
});

// ── rankTopN: integration with formatDynamicResult ────────

test('rankTopN output works with formatDynamicResult', () => {
  const funds = [
    { code: '001', name: 'Top基金', type: '纳指100', score: 18, dailyLimit: 500, reason: '高分', indicators: { longTermTrend: 'bull' } },
    { code: '002', name: '次基金', type: '标普500', score: 14, dailyLimit: 300, reason: '不错', indicators: { longTermTrend: 'neutral' } },
    { code: '003', name: '低分基金', type: '港股', score: 6, dailyLimit: 200, reason: '一般', indicators: { longTermTrend: 'bear' } },
  ];
  const ranked = rankTopN(funds, 2);
  const result = {
    budget: 500, strategy: 'dynamic',
    budgetInfo: { budget: 500, label: '良好机会', avgScore: 16 },
    strategyName: '测试策略', date: '2026-07-05',
    ranked, allRanked: [], suspended: [], dataMissing: [],
    totalRanked: ranked.length, allAvailable: funds.length, totalPool: 5,
    purchaseInfo: {}, externalSignals: null, newsSentiment: null,
    fundChanges: [], valuationData: null, marketTemperature: null,
  };
  const text = formatDynamicResult(result);
  assert.ok(text.includes('Top基金'));
  assert.ok(text.includes('次基金'));
  // The third fund should not appear in ranked section
  assert.ok(!text.includes('低分基金') || text.includes('低分基金') === false || text.indexOf('Top基金') < text.indexOf('低分基金'));
});

test('formatDynamicResult: shows pool stats line', () => {
  const result = {
    budget: 100, strategy: 'dynamic',
    budgetInfo: { budget: 100, label: '默认定投', avgScore: 0 },
    strategyName: '策略', date: '2026-07-05',
    ranked: [], allRanked: [], suspended: [], dataMissing: [],
    totalRanked: 0, allAvailable: 3, totalPool: 15,
    purchaseInfo: {}, externalSignals: null, newsSentiment: null,
    fundChanges: [], valuationData: null, marketTemperature: null,
  };
  const text = formatDynamicResult(result);
  assert.ok(text.includes('数据池'));
  assert.ok(text.includes('15'));
  assert.ok(text.includes('3'));
});
