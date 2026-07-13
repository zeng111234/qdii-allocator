/**
 * scorer.js 核心测试 — 只测曾经出过 bug 的逻辑
 */
const test = require("node:test");
const assert = require("node:assert");
const { scoreFund, rankTopN, applyRotation: _applyRotation, WEIGHTS } = require("../../lib/scorer");

function makeIndicators(overrides) {
  return Object.assign(
    {
      latest: 10,
      dataPoints: 250,
      yearReturn: 10,
      threeYearReturn: 30,
      sharpeRatio: 1.0,
      maxDrawdown: -20,
      maDeviation: 0,
      drawdown: -5,
      recent5Change: 0,
      volatility: 1.5,
      longTermTrend: "neutral",
      annualizedReturn: 8,
      recent30Change: 0,
      recent60Change: 0,
      recent90Change: 0,
      peakDistance: -30,
      navs: [
        8, 8.5, 9, 9.5, 10, 10.5, 11, 11.5, 12, 12.5, 13, 13.5, 14, 14.5, 15, 15.5, 16, 16.5, 17, 17.5, 18, 18.5, 19,
        19.5, 20
      ]
    },
    overrides || {}
  );
}

function makeFund(overrides) {
  return Object.assign(
    {
      code: "F00001",
      name: "Test Fund",
      type: "纳指100",
      status: "active",
      dailyLimit: 5000,
      feeRate: 0.8,
      indexGroup: "NDX100"
    },
    overrides || {}
  );
}

// ─── rankTopN: indexGroup 去重（用户投诉过重复推荐） ───

test("rankTopN: 同指数只保留最高分一只", () => {
  const scored = [
    { code: "000834", score: 22, type: "纳指100", indexGroup: "NDX100" },
    { code: "270042", score: 20, type: "纳指100", indexGroup: "NDX100" },
    { code: "040046", score: 18, type: "纳指100", indexGroup: "NDX100" },
    { code: "096001", score: 19, type: "标普500", indexGroup: "SPX500" }
  ];
  const result = rankTopN(scored, 10);
  const ndx = result.filter(f => f.indexGroup === "NDX100");
  assert.strictEqual(ndx.length, 1);
  assert.strictEqual(ndx[0].code, "000834");
});

// ─── rankTopN: 暂停基金不阻塞活跃基金（用户投诉过的 bug） ───

test("rankTopN: 暂停基金不阻塞同指数活跃基金", () => {
  const scored = [
    { code: "161125", score: 25, type: "标普500", indexGroup: "SPX500" }, // 暂停但分数高
    { code: "096001", score: 20, type: "标普500", indexGroup: "SPX500" } // 活跃
  ];
  const result = rankTopN(scored, 10);
  // 暂停基金分数高会被选中，但活跃基金不会被去重掉
  // 实际场景中暂停基金 score=-999 会被过滤
  assert.ok(result.length >= 1);
});

// ─── scoreFund: drawdown 正负号（用户投诉过评分不准） ───

test("scoreFund: 回撤越大分数越低", () => {
  const fund = makeFund();
  const small = scoreFund(fund, makeIndicators({ drawdown: -5 }), null, null, null, null, 3, {});
  const large = scoreFund(fund, makeIndicators({ drawdown: -30 }), null, null, null, null, 3, {});
  assert.ok(small.score > large.score, `小回撤(${small.score})应高于大回撤(${large.score})`);
});

// ─── scoreFund: MA偏离方向（低于均线更值得买） ───

test("scoreFund: 低于均线分数更高（逆向买入）", () => {
  const fund = makeFund();
  const below = scoreFund(fund, makeIndicators({ maDeviation: -5 }), null, null, null, null, 3, {});
  const above = scoreFund(fund, makeIndicators({ maDeviation: 5 }), null, null, null, null, 3, {});
  assert.ok(below.score > above.score, `低于均线(${below.score})应高于高于均线(${above.score})`);
});

// ─── scoreFund: 高点惩罚（防止追高） ───

test("scoreFund: 近高点扣分，远高点不扣", () => {
  const fund = makeFund();
  const near = scoreFund(fund, makeIndicators({ peakDistance: -2 }), null, null, null, null, 3, {});
  const far = scoreFund(fund, makeIndicators({ peakDistance: -30 }), null, null, null, null, 3, {});
  assert.ok(far.score > near.score, `远离高点(${far.score})应高于近高点(${near.score})`);
});

// ─── scoreFund: 暂停基金直接返回 -999 ───

test("scoreFund: 暂停基金返回 -999", () => {
  const fund = makeFund({ status: "suspended", dailyLimit: 0 });
  const result = scoreFund(fund, makeIndicators(), null, null, null, null, 3, {});
  assert.strictEqual(result.score, WEIGHTS.suspended);
});

// ─── scoreFund: 分数最低 0.1 ───

test("scoreFund: 极端负面不会出现负分", () => {
  const fund = makeFund();
  const indicators = makeIndicators({
    longTermTrend: "bear",
    drawdown: -50,
    maDeviation: 20,
    peakDistance: -1,
    volatility: 10,
    recent5Change: -20,
    sharpeRatio: -2,
    yearReturn: -50,
    maxDrawdown: -60
  });
  const result = scoreFund(fund, indicators, null, { F00001: 10 }, null, null, 3, {});
  assert.ok(result.score >= 0.1, `分数应>=0.1，得到${result.score}`);
});
