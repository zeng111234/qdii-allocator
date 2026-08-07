/**
 * mailer.js 核心测试 — 只测输出正确性
 */
const test = require('node:test');
const assert = require('node:assert');
const { buildEmailHtml } = require('../../lib/mailer');

function makeResult(overrides) {
  return Object.assign({
    budget: 50, budgetInfo: { adjustedBudget: 50 },
    ranked: [
      { rank: 1, code: '000834', name: '大成纳斯达克100', score: 25.3, type: '纳指100', reason: '正常', indicators: {} },
    ],
    marketTemperature: { temperature: 55, level: '正常' },
    suspended: [], alternatives: []
  }, overrides || {});
}

// ─── 基本输出 ───

test('buildEmailHtml: 生成有效 HTML', () => {
  const html = buildEmailHtml('推荐内容', 'AI分析', makeResult(), {});
  assert.ok(html.length > 100);
  assert.ok(html.includes('<html') || html.includes('<!DOCTYPE'));
});

// ─── 排名数据正确 ───

test('buildEmailHtml: 包含正确的基金名和分数', () => {
  const html = buildEmailHtml('', '', makeResult(), {});
  assert.ok(html.includes('大成纳斯达克100'));
  assert.ok(html.includes('25.3'));
});

// ─── XSS 防护 ───

test('buildEmailHtml: 转义 HTML 标签防 XSS', () => {
  const result = makeResult({
    ranked: [{ rank: 1, code: 'X', name: '<script>alert(1)</script>', score: 10, type: 'test', reason: '', indicators: {} }]
  });
  const html = buildEmailHtml('', '', result, {});
  assert.ok(!html.includes('<script>alert'), '应转义 script 标签');
});

// ─── 暂停基金显示 ───

test('buildEmailHtml: 包含暂停基金信息', () => {
  const result = makeResult({
    suspended: [{ code: '161125', name: '易方达标普500A', status: 'suspended' }]
  });
  const html = buildEmailHtml('', '', result, {});
  assert.ok(html.includes('易方达') || html.includes('跳过'));
});

// ─── 早报整合 ───

test('buildEmailHtml: 包含早报内容', () => {
  const html = buildEmailHtml('', '', makeResult(), {
    dailyBrief: { content: '今天市场表现不错，建议继续定投。' }
  });
  assert.ok(html.includes('今天市场表现不错'));
});

// ─── [fix] AI 提示不再被丢弃 ───

test('buildEmailHtml: [AI 开头的提示(解读被拒/不可用)不再被丢弃', () => {
  const html = buildEmailHtml('', '[AI 解读已拒绝：输出与 RecommendationPlan 不一致]', makeResult(), {});
  assert.ok(html.includes('AI决策报告'), '应显示 AI 区块标题');
  assert.ok(html.includes('解读已拒绝'), '应显示拒绝原因文本');
});

// ─── [fix] 暂停原因透明化 ───

test('buildEmailHtml: PAUSE 时展示暂停原因与信号进度', () => {
  const plan = {
    action: 'PAUSE',
    pauseReasons: ['LIVE_DISABLED', 'SIGNAL_WARMING_UP'],
    signalHealth: {
      status: 'WARMING_UP',
      matured: { count: 0 },
      shadow: { count: 4 },
      evidenceSource: 'SHADOW'
    }
  };
  const result = makeResult({ recommendationPlan: plan, budget: 0 });
  const html = buildEmailHtml('', '', result, {});
  assert.ok(html.includes('今日暂停买入'), '应显示暂停区块');
  assert.ok(html.includes('真实买入开关未开启'), 'LIVE_DISABLED 应有中文解释');
  assert.ok(html.includes('信号验证中'), '应显示信号验证中');
  assert.ok(html.includes('4/15'), '应显示信号进度 4/15');
});

test('buildEmailHtml: BUY 时不显示暂停原因区块', () => {
  const plan = { action: 'BUY', pauseReasons: [], signalHealth: { status: 'HEALTHY' } };
  const html = buildEmailHtml('', '', makeResult({ recommendationPlan: plan }), {});
  assert.ok(!html.includes('今日暂停买入'), 'BUY 时不应显示暂停区块');
});

// ─── [fix] 卡片指标渲染 ───

test('buildEmailHtml: 卡片显示年化/夏普/回撤等指标', () => {
  const result = makeResult({
    ranked: [{
      rank: 1, code: '000834', name: '大成纳斯达克100', score: 25.3, type: '纳指100',
      indicators: {
        annualizedReturn: 12.5, threeYearReturn: 30.1, sharpeRatio: 1.8,
        maxDrawdown: -15.2, recent5Change: 2.4, maDeviation: 1.1, volatility: 18.6,
        longTermTrend: 'bull'
      }
    }]
  });
  const html = buildEmailHtml('', '', result, {});
  assert.ok(html.includes('年化 12.5%'), '应显示年化收益');
  assert.ok(html.includes('夏普 1.8'), '应显示夏普');
  assert.ok(html.includes('回撤 -15.2%'), '应显示回撤');
  assert.ok(html.includes('5日 +2.4%'), '应显示 5 日涨跌');
  assert.ok(html.includes('趋势:↑牛'), '应显示趋势');
});
