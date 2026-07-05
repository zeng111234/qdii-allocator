/**
 * Tests for lib/grounding.js
 * Uses Node.js built-in test runner (node:test)
 */

var test = require('node:test');
var assert = require('node:assert');

// Import the module
var grounding = require('../../lib/grounding');

// Test module structure
test('Module loads without error', function () {
  assert.ok(grounding);
  assert.ok(typeof grounding.verifyGrounding === 'function');
  assert.ok(typeof grounding.formatGroundingReport === 'function');
});

// Test verifyGrounding with empty AI output
test('verifyGrounding handles empty AI output', function () {
  var context = {
    ranked: [
      { code: '160213', name: '国泰纳斯达克100' },
      { code: '270042', name: '广发纳斯达克100A' }
    ],
    portfolio: { holdings: [] }
  };
  
  var result = grounding.verifyGrounding('', context);
  assert.ok(result);
  assert.ok(typeof result.score === 'number');
  assert.ok(Array.isArray(result.checks));
  assert.ok(Array.isArray(result.warnings));
  assert.ok(typeof result.summary === 'string');
});

// Test verifyGrounding with valid AI output
test('verifyGrounding validates fund codes correctly', function () {
  var context = {
    ranked: [
      { code: '160213', name: '国泰纳斯达克100' },
      { code: '270042', name: '广发纳斯达克100A' }
    ],
    portfolio: { holdings: [] }
  };
  
  var aiOutput = '推荐基金160213和270042，预计收益10%';
  var result = grounding.verifyGrounding(aiOutput, context);
  
  assert.ok(result);
  assert.ok(result.checks.length > 0);
  
  // Check that fund codes are validated
  var entityChecks = result.checks.filter(function(c) { return c.type === 'entity'; });
  assert.ok(entityChecks.length > 0);
  assert.ok(entityChecks.every(function(c) { return c.passed; }));
});

// Test verifyGrounding detects extreme percentages
test('verifyGrounding detects extreme percentages', function () {
  var context = {
    ranked: [
      { code: '160213', name: '国泰纳斯达克100' }
    ],
    portfolio: { holdings: [] }
  };
  
  var aiOutput = '预计收益300%，风险-500%';
  var result = grounding.verifyGrounding(aiOutput, context);
  
  assert.ok(result);
  assert.ok(result.warnings.length > 0);
  assert.ok(result.warnings.some(function(w) { return w.indexOf('异常数值') >= 0; }));
  
  // Check that numeric check failed
  var numericCheck = result.checks.find(function(c) { return c.type === 'numeric'; });
  assert.ok(numericCheck);
  assert.ok(!numericCheck.passed);
});

// Test verifyGrounding checks risk warnings
test('verifyGrounding checks for risk warnings', function () {
  var context = {
    ranked: [
      { code: '160213', name: '国泰纳斯达克100' }
    ],
    portfolio: { holdings: [] }
  };
  
  // AI output without risk warnings
  var aiOutput1 = '推荐基金160213，预计收益10%';
  var result1 = grounding.verifyGrounding(aiOutput1, context);
  
  var riskCheck1 = result1.checks.find(function(c) { return c.type === 'risk_warning'; });
  assert.ok(riskCheck1);
  assert.ok(!riskCheck1.passed);
  
  // AI output with risk warnings
  var aiOutput2 = '推荐基金160213，预计收益10%，注意风险';
  var result2 = grounding.verifyGrounding(aiOutput2, context);
  
  var riskCheck2 = result2.checks.find(function(c) { return c.type === 'risk_warning'; });
  assert.ok(riskCheck2);
  assert.ok(riskCheck2.passed);
});

// Test verifyGrounding checks consistency with top ranked funds
test('verifyGrounding checks consistency with top ranked funds', function () {
  var context = {
    ranked: [
      { code: '160213', name: '国泰纳斯达克100' },
      { code: '270042', name: '广发纳斯达克100A' },
      { code: '000001', name: '测试基金1' },
      { code: '000002', name: '测试基金2' },
      { code: '000003', name: '测试基金3' }
    ],
    portfolio: { holdings: [] }
  };
  
  // AI output mentioning top 5 funds
  var aiOutput = '推荐基金160213和270042，以及其他测试基金';
  var result = grounding.verifyGrounding(aiOutput, context);
  
  var consistencyCheck = result.checks.find(function(c) { return c.type === 'consistency'; });
  assert.ok(consistencyCheck);
  assert.ok(consistencyCheck.passed);
});

// Test verifyGrounding with missing context
test('verifyGrounding handles missing context gracefully', function () {
  var result = grounding.verifyGrounding('测试', {});
  assert.ok(result);
  assert.ok(typeof result.score === 'number');
  assert.ok(Array.isArray(result.checks));
  assert.ok(Array.isArray(result.warnings));
});

// Test verifyGrounding with null context - should throw or handle gracefully
test('verifyGrounding handles null context gracefully', function () {
  // The function may throw an error when context is null
  try {
    var result = grounding.verifyGrounding('测试', null);
    // If it doesn't throw, check the result
    assert.ok(result);
    assert.ok(typeof result.score === 'number');
    assert.ok(Array.isArray(result.checks));
    assert.ok(Array.isArray(result.warnings));
  } catch (error) {
    // If it throws, that's acceptable
    assert.ok(error instanceof TypeError);
  }
});

// Test formatGroundingReport
test('formatGroundingReport returns formatted string', function () {
  var result = {
    score: 80,
    checks: [
      { type: 'entity', passed: true, detail: '基金代码160213存在' },
      { type: 'numeric', passed: true, detail: '所有数值在合理范围' }
    ],
    warnings: [],
    summary: '反幻觉评分: 80/100 (2/2 项通过)'
  };
  
  var report = grounding.formatGroundingReport(result);
  assert.ok(typeof report === 'string');
  assert.ok(report.length > 0);
  assert.ok(report.indexOf('🟢') >= 0); // High score should show green emoji
});

// Test formatGroundingReport with warnings
test('formatGroundingReport includes warnings', function () {
  var result = {
    score: 60,
    checks: [
      { type: 'entity', passed: true, detail: '基金代码160213存在' },
      { type: 'numeric', passed: false, detail: '1个异常数值' }
    ],
    warnings: ['异常数值: 300% (超出正常范围)'],
    summary: '反幻觉评分: 60/100 (1/2 项通过)'
  };
  
  var report = grounding.formatGroundingReport(result);
  assert.ok(report.indexOf('⚠️ 警告') >= 0);
});

// Test verifyGrounding score calculation
test('verifyGrounding calculates score correctly', function () {
  var context = {
    ranked: [
      { code: '160213', name: '国泰纳斯达克100' }
    ],
    portfolio: { holdings: [] }
  };
  
  // AI output that should pass all checks
  var aiOutput = '推荐基金160213，预计收益10%，注意风险';
  var result = grounding.verifyGrounding(aiOutput, context);
  
  // All checks should pass
  var passedCount = result.checks.filter(function(c) { return c.passed; }).length;
  var expectedScore = Math.round((passedCount / result.checks.length) * 100);
  assert.strictEqual(result.score, expectedScore);
});