/**
 * daily-brief.js 核心测试 — cleanLLMOutput + buildPrompt 数据一致性
 */
const test = require('node:test');
const assert = require('node:assert');
const { buildPrompt, cleanLLMOutput } = require('../../lib/daily-brief');

// ─── cleanLLMOutput: 基础清理 ───

test('cleanLLMOutput: 移除 thinking 标签', () => {
  const input = '<thinking>思考过程</thinking>今天市场不错，建议定投。';
  const result = cleanLLMOutput(input);
  assert.ok(!result.includes('<thinking>'));
  assert.ok(result.includes('今天市场不错'));
});

test('cleanLLMOutput: 移除 <think> 标签', () => {
  const input = '<think>分析...</think>建议继续持有。';
  const result = cleanLLMOutput(input);
  assert.ok(!result.includes('<think>'));
  assert.ok(result.includes('建议继续持有'));
});

test('cleanLLMOutput: null 输入返回空字符串', () => {
  assert.strictEqual(cleanLLMOutput(null), '');
  assert.strictEqual(cleanLLMOutput(''), '');
});

// ─── buildPrompt: 数据一致性（用户投诉过 AI 助手回答和排行榜不一致） ───

test('buildPrompt: Top5 分数和输入一致', () => {
  const result = {
    marketTemperature: { temperature: 50, level: '正常' },
    budgetInfo: { adjustedBudget: 50 },
    ranked: [
      { name: '基金A', score: 28.5, yearReturn: 20, indicators: {} },
      { name: '基金B', score: 25.3, yearReturn: 15, indicators: {} },
    ],
    marketSnapshot: [], marketNews: []
  };
  const prompt = buildPrompt(result, null);
  assert.ok(prompt.includes('28.5'), '应包含精确分数 28.5');
  assert.ok(prompt.includes('25.3'), '应包含精确分数 25.3');
});

test('buildPrompt: 使用 adjustedBudget 而不是默认值', () => {
  const result = {
    marketTemperature: { temperature: 50, level: '正常' },
    budgetInfo: { adjustedBudget: 35 }, budget: 50,
    ranked: [], marketSnapshot: [], marketNews: []
  };
  const prompt = buildPrompt(result, null);
  assert.ok(prompt.includes('35'), '应使用调整后预算 35');
});

test('buildPrompt: 包含市场温度', () => {
  const result = {
    marketTemperature: { temperature: 65, level: '偏热' },
    ranked: [], marketSnapshot: [], marketNews: []
  };
  const prompt = buildPrompt(result, null);
  assert.ok(prompt.includes('65'));
  assert.ok(prompt.includes('偏热'));
});
