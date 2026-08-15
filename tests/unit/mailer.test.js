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

test('buildEmailHtml: 待确认金额不伪装成市值或持仓收益', () => {
  const result = makeResult({
    portfolio: {
      empty: false,
      summary: {
        totalInvested: 100,
        grossInvested: 150,
        pendingInvested: 50,
        totalValue: 110,
        totalPnl: 10,
        totalPnlRate: 10
      },
      holdings: [{
        code: 'A', name: '测试基金', totalAmount: 150, confirmedAmount: 100,
        pendingAmount: 50, pnl: 10, pnlRate: 10
      }]
    }
  });
  const html = buildEmailHtml('', '', result, {});
  assert.ok(html.includes('已确认投入'));
  assert.ok(html.includes('待确认 50元未计入市值和盈亏'));
  assert.ok(html.includes('测试基金 100元'));
  assert.ok(!html.includes('测试基金 150元'));
});

test('buildEmailHtml: 缺净值时明确估值不完整且不生成虚假盈亏', () => {
  const result = makeResult({
    portfolio: {
      empty: false,
      summary: {
        totalInvested: 100,
        pendingInvested: 0,
        totalValue: null,
        totalPnl: null,
        totalPnlRate: null,
        valuationComplete: false,
        missingValuationCodes: ['NO_NAV']
      },
      holdings: [{ code: 'NO_NAV', name: '无净值基金', confirmedAmount: 100, currentValue: null, pnl: null, pnlRate: null }]
    }
  });
  const html = buildEmailHtml('', '', result, {});
  assert.ok(html.includes('估值不完整'));
  assert.ok(html.includes('NO_NAV'));
  assert.ok(!html.includes('盈亏</div><div style="font-size:16px;font-weight:bold;color:#e74c3c">-'));
});

test('buildEmailHtml: 陈旧或未来净值显示原因代码而不是伪造盈亏', () => {
  const result = makeResult({
    portfolio: {
      empty: false,
      summary: {
        totalInvested: 200, pendingInvested: 0, totalValue: null,
        totalPnl: null, totalPnlRate: null, valuationComplete: false,
        missingValuationCodes: ['STALE', 'FUTURE'],
        valuationIssues: [
          { code: 'STALE', reason: 'NAV_STALE', latestDate: '2026-08-10', tradingDayLag: 4 },
          { code: 'FUTURE', reason: 'NAV_FUTURE', latestDate: '2026-08-18', tradingDayLag: null }
        ]
      },
      holdings: [
        { code: 'STALE', name: '陈旧基金', confirmedAmount: 100, currentValue: null, pnl: null, pnlRate: null, valuationIssue: 'NAV_STALE' },
        { code: 'FUTURE', name: '未来基金', confirmedAmount: 100, currentValue: null, pnl: null, pnlRate: null, valuationIssue: 'NAV_FUTURE' }
      ]
    }
  });
  const html = buildEmailHtml('', '', result, {});
  assert.ok(html.includes('NAV_STALE'));
  assert.ok(html.includes('NAV_FUTURE'));
  assert.ok(html.includes('陈旧基金'));
  assert.ok(!html.includes('陈旧基金 100元 <span style="color:#e74c3c">-100'));
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

test('buildEmailHtml: 战略定投只输出最终路线和精确金额', () => {
  const plan = {
    action: 'STRATEGIC_DCA', budget: 30, pauseReasons: ['ALPHA_GATE_NOT_PASSED'],
    executionRoutes: [
      { code: '096001', name: '标普通道', amount: 10 },
      { code: '270042', name: '纳指通道', amount: 20 }
    ]
  };
  const html = buildEmailHtml('', '', makeResult({
    recommendationPlan: plan,
    budget: 30,
    ranked: [
      { rank: 1, code: '096001', name: '标普通道', proposedAmount: 10, indicators: {} },
      { rank: 2, code: '270042', name: '纳指通道', proposedAmount: 20, indicators: {} }
    ]
  }), {});
  assert.ok(html.includes('进取型核心定投'));
  assert.ok(html.includes('096001 10元'));
  assert.ok(html.includes('270042 20元'));
  assert.ok(html.includes('096001 10, 270042 20'));
  assert.ok(!html.includes('金额自行确定'));
});

test('buildEmailHtml: HARD_PAUSE 不生成任何购买命令', () => {
  const plan = { action: 'HARD_PAUSE', budget: 0, pauseReasons: ['DECISION_STATE_MISSING'], executionRoutes: [] };
  const html = buildEmailHtml('', '', makeResult({ recommendationPlan: plan, budget: 0, ranked: [] }), {});
  assert.ok(html.includes('今日硬暂停'));
  assert.ok(!html.includes('--quick-add'));
  assert.ok(!html.includes('今日买入指南'));
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
