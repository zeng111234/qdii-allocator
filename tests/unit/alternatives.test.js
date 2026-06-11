/**
 * Tests for lib/alternatives.js
 * Uses Node.js built-in test runner (node:test)
 */

var test = require('node:test');
var assert = require('node:assert');
var alt = require('../../lib/alternatives');

// ========== ALTERNATIVES_MAP ==========

test('ALTERNATIVES_MAP - has expected category keys', function () {
  var expected = ['纳指100', '标普500', '港股', '全球精选', '亚太', '德国DAX', '石油', '生物科技', 'REITs'];
  for (var i = 0; i < expected.length; i++) {
    assert.ok(alt.ALTERNATIVES_MAP.hasOwnProperty(expected[i]), 'Missing: ' + expected[i]);
  }
});

test('ALTERNATIVES_MAP - each entry has required fields', function () {
  var types = Object.keys(alt.ALTERNATIVES_MAP);
  assert.ok(types.length >= 9);
  for (var i = 0; i < types.length; i++) {
    var alts = alt.ALTERNATIVES_MAP[types[i]];
    assert.ok(Array.isArray(alts));
    assert.ok(alts.length > 0);
    for (var j = 0; j < alts.length; j++) {
      assert.ok(typeof alts[j].code === 'string');
      assert.ok(typeof alts[j].name === 'string');
      assert.ok(typeof alts[j].note === 'string');
    }
  }
});

// ========== POLICY_RISK_LEVELS ==========

test('POLICY_RISK_LEVELS - each entry has risk/reason/advice', function () {
  var types = Object.keys(alt.POLICY_RISK_LEVELS);
  assert.ok(types.length >= 8);
  for (var i = 0; i < types.length; i++) {
    var level = alt.POLICY_RISK_LEVELS[types[i]];
    assert.ok(level.hasOwnProperty('risk'));
    assert.ok(level.hasOwnProperty('reason'));
    assert.ok(level.hasOwnProperty('advice'));
    assert.ok(['高', '中', '低'].indexOf(level.risk) !== -1);
  }
});

// ========== getAlternatives ==========

test('getAlternatives - returns alternatives for known type', function () {
  var result = alt.getAlternatives('纳指100');
  assert.ok(Array.isArray(result));
  assert.ok(result.length > 0);
  assert.strictEqual(result[0].code, '270042');
});

test('getAlternatives - unknown type returns empty', function () {
  var result = alt.getAlternatives('非典型类型');
  assert.strictEqual(result.length, 0);
});

test('getAlternatives - excludes specified fund code', function () {
  var result = alt.getAlternatives('纳指100', '270042');
  var found = result.some(function (a) { return a.code === '270042'; });
  assert.strictEqual(found, false);
});

// ========== getPolicyRisk ==========

test('getPolicyRisk - returns risk level for known type', function () {
  var result = alt.getPolicyRisk('纳指100');
  assert.strictEqual(result.risk, '高');
});

test('getPolicyRisk - returns unknown for unregistered type', function () {
  var result = alt.getPolicyRisk('未知类型');
  assert.strictEqual(result.risk, '未知');
});

// ========== analyzeAlternatives ==========

test('analyzeAlternatives - null/empty input returns empty', function () {
  assert.deepStrictEqual(alt.analyzeAlternatives(null), []);
  assert.deepStrictEqual(alt.analyzeAlternatives([]), []);
});

test('analyzeAlternatives - fund with known type returns suggestions', function () {
  var result = alt.analyzeAlternatives([{ code: '270042', name: '广发纳斯达克100A', type: '纳指100' }]);
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].fund.code, '270042');
  assert.ok(result[0].alternatives.length > 0);
});

test('analyzeAlternatives - excludes suspended fund from own alternatives', function () {
  var result = alt.analyzeAlternatives([{ code: '040046', name: '华安纳斯达克100A', type: '纳指100' }]);
  var found = result[0].alternatives.some(function (a) { return a.code === '040046'; });
  assert.strictEqual(found, false);
});

// ========== formatAlternativesReport ==========

test('formatAlternativesReport - empty returns empty string', function () {
  assert.strictEqual(alt.formatAlternativesReport(null), '');
  assert.strictEqual(alt.formatAlternativesReport([]), '');
});

test('formatAlternativesReport - with suggestions returns formatted report', function () {
  var report = alt.formatAlternativesReport([{ code: '270042', name: '广发纳斯达克100A', type: '纳指100' }]);
  assert.ok(report.includes('QDII'));
  assert.ok(report.includes('广发纳斯达克100A'));
});

// ========== generatePolicyRiskOverview ==========

test('generatePolicyRiskOverview - empty funds returns header only', function () {
  var result = alt.generatePolicyRiskOverview([]);
  assert.ok(result.includes('QDII'));
});

test('generatePolicyRiskOverview - with active funds shows status', function () {
  var funds = [
    { code: '270042', name: '广发纳斯达克100A', type: '纳指100', status: 'active', dailyLimit: 10 }
  ];
  var result = alt.generatePolicyRiskOverview(funds);
  assert.ok(result.includes('纳指100'));
  assert.ok(result.includes('正常'));
});

test('generatePolicyRiskOverview - with suspended funds shows warning', function () {
  var funds = [
    { code: '270042', name: '广发纳斯达克100A', type: '纳指100', status: 'suspended' }
  ];
  var result = alt.generatePolicyRiskOverview(funds);
  assert.ok(result.includes('停购'));
});
