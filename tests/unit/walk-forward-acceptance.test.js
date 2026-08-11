/**
 * buildAcceptanceMetrics 测试 — 验收数据映射正确性
 * 覆盖: % 解析、shadowWeeks 去重、9 字段齐全、阈值判定委托
 */
const test = require('node:test');
const assert = require('node:assert');
const walkForward = require('../../lib/walk-forward');
const recommendationEngine = require('../../lib/recommendation-engine');

test('buildAcceptanceMetrics: 正确解析带 % 的字符串字段', () => {
  const wfResult = {
    summary: {
      windows: 22,
      nonOverlappingWindows: 22,
      medianExcessReturn: '0.66%',
      strategyMaxDrawdown: '-14.79%',
      benchmarkMaxDrawdown: '-11.89%',
      assumptions: { feesIncluded: true, qdiiLagIncluded: true, optimizationTrials: 2 }
    }
  };
  const metrics = walkForward.buildAcceptanceMetrics(wfResult, []);
  assert.strictEqual(metrics.rollingWindows, 22);
  assert.strictEqual(metrics.medianExcess12Week, 0.66);
  assert.strictEqual(metrics.drawdownGapPercentagePoints, 2.9, '回撤差应为基准-策略, 且不能被 % 解析 bug 归零');
  assert.strictEqual(metrics.feesIncluded, true);
  assert.strictEqual(metrics.qdiiLagIncluded, true);
  assert.strictEqual(metrics.optimizationTrialsReported, true);
});

test('buildAcceptanceMetrics: shadowWeeks 按 ISO 周去重计数', () => {
  const wfResult = {
    summary: {
      windows: 12, nonOverlappingWindows: 6, medianExcessReturn: 1,
      strategyMaxDrawdown: '-5%', benchmarkMaxDrawdown: '-6%',
      assumptions: { feesIncluded: true, qdiiLagIncluded: true, optimizationTrials: 2 }
    }
  };
  const shadow = [
    { date: '2026-07-06' }, { date: '2026-07-07' }, // 同一周
    { date: '2026-07-14' }, { date: '2026-07-21' }  // 另外两周
  ];
  const metrics = walkForward.buildAcceptanceMetrics(wfResult, shadow);
  assert.strictEqual(metrics.shadowWeeks, 3);
});

test('buildAcceptanceMetrics: 9 个字段齐全且可被 evaluateLiveAcceptance 消费', () => {
  const wfResult = {
    summary: {
      windows: 12, nonOverlappingWindows: 6, medianExcessReturn: '0.5%',
      strategyMaxDrawdown: '-10%', benchmarkMaxDrawdown: '-9%',
      assumptions: { feesIncluded: true, qdiiLagIncluded: true, optimizationTrials: 2 }
    }
  };
  const metrics = walkForward.buildAcceptanceMetrics(wfResult, [{ date: '2026-07-06' }]);
  const need = ['rollingWindows', 'nonOverlappingWindows', 'medianExcess12Week', 'drawdownGapPercentagePoints',
    'shadowWeeks', 'hardRiskViolations', 'feesIncluded', 'qdiiLagIncluded', 'optimizationTrialsReported'];
  need.forEach(function (k) { assert.ok(k in metrics, '缺少字段: ' + k); });
  const verdict = recommendationEngine.evaluateLiveAcceptance(metrics);
  assert.strictEqual(verdict.passed, false, '回撤差 1pp 应通过, 但 shadowWeeks=1<8 应失败');
  assert.ok(verdict.failures.includes('INSUFFICIENT_SHADOW_WEEKS'));
});

test('buildAcceptanceMetrics: 回测不可用时返回 null', () => {
  assert.strictEqual(walkForward.buildAcceptanceMetrics(null, []), null);
  assert.strictEqual(walkForward.buildAcceptanceMetrics({ summary: null }, []), null);
});

test('buildLiveAcceptanceMetrics: 页面和邮件共用相同的回测参数与验收映射', () => {
  let received = null;
  const metrics = walkForward.buildLiveAcceptanceMetrics({
    navCache: { A: [{ date: '2026-08-10', nav: 1 }] },
    funds: [{ code: 'A' }],
    config: {
      buyFeeRate: 0.1,
      sellFeeRate: 0.2,
      executionLagDays: 2,
      qdiiLagIncluded: true,
      optimizationTrials: 3
    },
    shadowHistory: [{ date: '2026-08-10' }],
    runBacktest: function(navCache, funds, options) {
      received = { navCache: navCache, funds: funds, options: options };
      return {
        summary: {
          windows: 12,
          nonOverlappingWindows: 6,
          medianExcessReturn: '0.5%',
          strategyMaxDrawdown: '-5%',
          benchmarkMaxDrawdown: '-6%',
          assumptions: { feesIncluded: true, qdiiLagIncluded: true, optimizationTrials: 3 }
        }
      };
    }
  });

  assert.deepStrictEqual(received.options, {
    trainDays: 120,
    testDays: 30,
    topN: 2,
    stepDays: 30,
    buyFeeRate: 0.1,
    sellFeeRate: 0.2,
    executionLagDays: 2,
    qdiiLagIncluded: true,
    optimizationTrials: 3
  });
  assert.strictEqual(metrics.rollingWindows, 12);
  assert.strictEqual(metrics.shadowWeeks, 1);
});
