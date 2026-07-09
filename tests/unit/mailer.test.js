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
