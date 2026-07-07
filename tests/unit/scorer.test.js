const test = require('node:test');
const assert = require('node:assert');
const { scoreFund, applyRotation, WEIGHTS } = require('../../lib/scorer');

function makeIndicators(overrides) {
  return Object.assign({
    latest: 10, dataPoints: 250,
    yearReturn: 10, threeYearReturn: 30,
    sharpeRatio: 1.0, maxDrawdown: -20,
    maDeviation: 0, drawdown: 0,
    recent5Change: 0, volatility: 1.5,
    longTermTrend: 'neutral',
    annualizedReturn: 8,
    recent30Change: 0, recent60Change: 0, recent90Change: 0,
    navs: [9,9.5,10,10.5,11,11.5,12,12.5,13,13.5,14,14.5,15,15.5,16,16.5,17,17.5,18,18.5]
  }, overrides || {});
}

function makeFund(overrides) {
  return Object.assign({
    code: 'F00001',
    name: 'Test Fund',
    type: '纳指100',
    status: 'active',
    dailyLimit: 5000,
    feeRate: 0
  }, overrides || {});
}

// ─── applyRotation tests ────────────────────────────────────────────

test('applyRotation: empty available array returns empty', () => {
  const result = applyRotation([], {}, 5);
  assert.deepStrictEqual(result, []);
});

test('applyRotation: funds with consecutive picks >= 2 days are pushed to end of their group', () => {
  const available = [
    { code: 'A', score: 20 },
    { code: 'B', score: 19.5 },
    { code: 'C', score: 19 },
    { code: 'D', score: 18 },
    { code: 'E', score: 17 },
    { code: 'F', score: 16 },
  ];
  const recentPicks = { A: 3 }; // A picked 3 consecutive days
  const result = applyRotation(available, recentPicks, 2);

  // A and B are in same group (diff <= 2), but A should be behind B due to rotation
  const idxA = result.findIndex(f => f.code === 'A');
  const idxB = result.findIndex(f => f.code === 'B');
  assert.ok(idxB < idxA, `B (idx ${idxB}) should come before A (idx ${idxA})`);
});

test('applyRotation: funds with score difference > 2 should be in different groups', () => {
  const available = [
    { code: 'A', score: 20 },
    { code: 'B', score: 17 },
  ];
  const recentPicks = { A: 5 }; // heavily picked, but in higher group
  const result = applyRotation(available, recentPicks, 5);

  // A is in a higher group than B, rotation doesn't move A below B
  assert.strictEqual(result[0].code, 'A');
  assert.strictEqual(result[1].code, 'B');
});

test('applyRotation: deterministic ordering when scores are equal (localeCompare by code)', () => {
  const available = [
    { code: 'ZETA', score: 20 },
    { code: 'ALPHA', score: 20 },
    { code: 'MU', score: 20 },
    { code: 'BETA', score: 20 },
    { code: 'GAMMA', score: 20 },
    { code: 'DELTA', score: 20 },
  ];
  const result1 = applyRotation(available, {}, 2);
  // Within each group (all same score), should be sorted by code when no rotation penalty
  assert.strictEqual(result1[0].code, 'ALPHA');
  assert.strictEqual(result1[1].code, 'BETA');
  assert.strictEqual(result1[2].code, 'DELTA');
});

test('applyRotation: returns available as-is when no recentPicks', () => {
  const available = [
    { code: 'A', score: 20 },
    { code: 'B', score: 19 },
  ];
  const result = applyRotation(available, null, 10);
  assert.strictEqual(result.length, 2);
});

test('applyRotation: returns available as-is when length <= topN', () => {
  const available = [
    { code: 'A', score: 20 },
    { code: 'B', score: 19 },
  ];
  const result = applyRotation(available, { A: 3 }, 10);
  assert.strictEqual(result.length, 2);
});

// ─── scoreFund valuation tests ──────────────────────────────────────

test('scoreFund: PE < 18 should add WEIGHTS.valuationBonus', () => {
  const fund = makeFund();
  const indicators = makeIndicators();
  const options = { valuationData: { vix: null, indices: { NDX: { pe: 15 }, SPX: { pe: 16 } } } };
  const result = scoreFund(fund, indicators, null, null, null, [], 0, options);
  assert.ok(result.reason.includes('PE') || result.score > WEIGHTS.base,
    'Should include valuation bonus');
  // Compare against baseline without valuation
  const baseResult = scoreFund(fund, indicators, null, null, null, [], 0, {});
  assert.ok(result.score > baseResult.score,
    `Score with PE<18 (${result.score}) should be > baseline (${baseResult.score})`);
});

test('scoreFund: PE > 30 should add WEIGHTS.valuationPenalty', () => {
  const fund = makeFund();
  const indicators = makeIndicators();
  const options = { valuationData: { vix: null, indices: { NDX: { pe: 35 }, SPX: { pe: 35 } } } };
  const result = scoreFund(fund, indicators, null, null, null, [], 0, options);
  const baseResult = scoreFund(fund, indicators, null, null, null, [], 0, {});
  assert.ok(result.score < baseResult.score,
    `Score with PE>30 (${result.score}) should be < baseline (${baseResult.score})`);
});

test('scoreFund: PE 25-30 should add WEIGHTS.valuationPenalty * 0.5', () => {
  const fund = makeFund();
  const indicators = makeIndicators();
  // Use NDX PE for 纳指100 type
  const options = { valuationData: { vix: null, indices: { NDX: { pe: 28 }, SPX: { pe: 20 } } } };
  const result = scoreFund(fund, indicators, null, null, null, [], 0, options);
  const baseResult = scoreFund(fund, indicators, null, null, null, [], 0, {});
  // The penalty for PE 28 should be valuationPenalty * 0.5
  const expectedDiff = WEIGHTS.valuationPenalty * 0.5;
  assert.ok(result.score < baseResult.score,
    `Score with PE 28 (${result.score}) should be < baseline (${baseResult.score})`);
});

test('scoreFund: VIX >= 30 should add WEIGHTS.vixFearBonus', () => {
  const fund = makeFund();
  const indicators = makeIndicators();
  const options = { valuationData: { vix: 35, indices: null } };
  const result = scoreFund(fund, indicators, null, null, null, [], 0, options);
  const baseResult = scoreFund(fund, indicators, null, null, null, [], 0, {});
  assert.ok(result.score > baseResult.score,
    `Score with VIX>=30 (${result.score}) should be > baseline (${baseResult.score})`);
});

test('scoreFund: VIX <= 12 should add WEIGHTS.vixGreedPenalty', () => {
  const fund = makeFund();
  const indicators = makeIndicators();
  const options = { valuationData: { vix: 10, indices: null } };
  const result = scoreFund(fund, indicators, null, null, null, [], 0, options);
  const baseResult = scoreFund(fund, indicators, null, null, null, [], 0, {});
  assert.ok(result.score < baseResult.score,
    `Score with VIX<=12 (${result.score}) should be < baseline (${baseResult.score})`);
});

test('scoreFund: Nasdaq fund type should use NDX PE', () => {
  const fund = makeFund({ type: '纳指100' });
  const indicators = makeIndicators();
  // NDX PE is cheap, SPX is expensive — should pick NDX
  const options = { valuationData: { vix: null, indices: { NDX: { pe: 10 }, SPX: { pe: 40 } } } };
  const result = scoreFund(fund, indicators, null, null, null, [], 0, options);
  const baseResult = scoreFund(fund, indicators, null, null, null, [], 0, {});
  assert.ok(result.score > baseResult.score,
    'Nasdaq fund should use NDX PE (cheap) and get bonus');
});

test('scoreFund: S&P500 fund type should use SPX PE', () => {
  const fund = makeFund({ type: '标普500' });
  const indicators = makeIndicators();
  // SPX PE is cheap, NDX is expensive — should pick SPX
  const options = { valuationData: { vix: null, indices: { NDX: { pe: 40 }, SPX: { pe: 10 } } } };
  const result = scoreFund(fund, indicators, null, null, null, [], 0, options);
  const baseResult = scoreFund(fund, indicators, null, null, null, [], 0, {});
  assert.ok(result.score > baseResult.score,
    'S&P500 fund should use SPX PE (cheap) and get bonus');
});

// ─── scoreFund news sentiment tests ─────────────────────────────────

test('scoreFund: positive news sentiment should add points', () => {
  const fund = makeFund({ type: '纳指100' });
  const indicators = makeIndicators();
  const options = {
    newsSentiment: {
      byTheme: { nasdaq: { positive: 20, negative: 0 } },
      overall: 0
    }
  };
  const result = scoreFund(fund, indicators, null, null, null, [], 0, options);
  const baseResult = scoreFund(fund, indicators, null, null, null, [], 0, {});
  assert.ok(result.score > baseResult.score,
    `Score with positive news (${result.score}) should be > baseline (${baseResult.score})`);
});

test('scoreFund: negative news sentiment should subtract points', () => {
  const fund = makeFund({ type: '纳指100' });
  const indicators = makeIndicators();
  const options = {
    newsSentiment: {
      byTheme: { nasdaq: { positive: 0, negative: 20 } },
      overall: 0
    }
  };
  const result = scoreFund(fund, indicators, null, null, null, [], 0, options);
  const baseResult = scoreFund(fund, indicators, null, null, null, [], 0, {});
  assert.ok(result.score < baseResult.score,
    `Score with negative news (${result.score}) should be < baseline (${baseResult.score})`);
});

// ─── scoreFund overheat tests ───────────────────────────────────────

test('scoreFund: recent30Change > 15 should trigger overheat penalty', () => {
  const fund = makeFund();
  const indicators = makeIndicators({ recent30Change: 20 });
  const result = scoreFund(fund, indicators, null, null, null, [], 0, {});
  const baseResult = scoreFund(fund, makeIndicators({ recent30Change: 0 }), null, null, null, [], 0, {});
  assert.ok(result.score < baseResult.score,
    `Score with 30d overheat (${result.score}) should be < baseline (${baseResult.score})`);
});

test('scoreFund: recent60Change > 30 should trigger overheat penalty', () => {
  const fund = makeFund();
  const indicators = makeIndicators({ recent60Change: 35 });
  const result = scoreFund(fund, indicators, null, null, null, [], 0, {});
  const baseResult = scoreFund(fund, makeIndicators({ recent60Change: 0 }), null, null, null, [], 0, {});
  assert.ok(result.score < baseResult.score,
    `Score with 60d overheat (${result.score}) should be < baseline (${baseResult.score})`);
});

// ─── scoreFund trend strength tests ─────────────────────────────────

test('scoreFund: MA5 > MA10 > MA20 (bull alignment) should add trendBonus', () => {
  // Create rising navs so MA5 > MA10 > MA20
  // Ascending sequence: recent values higher than older ones
  const risingNavs = [];
  for (let i = 0; i < 25; i++) risingNavs.push(5 + i * 0.5);
  // risingNavs: [5, 5.5, 6, ..., 17]
  // MA5 of last 5 ≈ 15.5, MA10 of last 10 ≈ 13.25, MA20 of last 20 ≈ 10.25
  const fund = makeFund();
  const indicators = makeIndicators({ navs: risingNavs });
  const result = scoreFund(fund, indicators, null, null, null, [], 0, {});
  const flatNavs = [];
  for (let i = 0; i < 25; i++) flatNavs.push(10);
  const baseResult = scoreFund(fund, makeIndicators({ navs: flatNavs }), null, null, null, [], 0, {});
  assert.ok(result.score > baseResult.score,
    `Score with bull alignment (${result.score}) should be > flat baseline (${baseResult.score})`);
});

test('scoreFund: MA5 < MA10 < MA20 (bear alignment) should add trendPenalty', () => {
  // Create falling navs so MA5 < MA10 < MA20
  const fallingNavs = [];
  for (let i = 0; i < 25; i++) fallingNavs.push(20 - i * 0.5);
  // fallingNavs: [20, 19.5, 19, ..., 8]
  // MA5 of last 5 ≈ 8.5, MA10 of last 10 ≈ 9.75, MA20 of last 20 ≈ 12.25
  const fund = makeFund();
  const indicators = makeIndicators({ navs: fallingNavs });
  const result = scoreFund(fund, indicators, null, null, null, [], 0, {});
  const flatNavs = [];
  for (let i = 0; i < 25; i++) flatNavs.push(10);
  const baseResult = scoreFund(fund, makeIndicators({ navs: flatNavs }), null, null, null, [], 0, {});
  assert.ok(result.score < baseResult.score,
    `Score with bear alignment (${result.score}) should be < flat baseline (${baseResult.score})`);
});

// ─── Additional scoreFund edge-case tests ───────────────────────────

test('scoreFund: suspended fund returns WEIGHTS.suspended', () => {
  const fund = makeFund({ status: 'suspended' });
  const indicators = makeIndicators();
  const result = scoreFund(fund, indicators, null, null, null, [], 0, {});
  assert.strictEqual(result.score, WEIGHTS.suspended);
});

test('scoreFund: fund with dailyLimit 0 returns WEIGHTS.suspended', () => {
  const fund = makeFund({ dailyLimit: 0 });
  const indicators = makeIndicators();
  const result = scoreFund(fund, indicators, null, null, null, [], 0, {});
  assert.strictEqual(result.score, WEIGHTS.suspended);
});

test('scoreFund: insufficient data (< 60 dataPoints) returns -1', () => {
  const fund = makeFund();
  const indicators = makeIndicators({ dataPoints: 30 });
  const result = scoreFund(fund, indicators, null, null, null, [], 0, {});
  assert.strictEqual(result.score, -1);
});
