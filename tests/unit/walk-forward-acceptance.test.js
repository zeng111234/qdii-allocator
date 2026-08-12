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
      winRate: '50%',
      benchmarkWinRate: '45%',
      outperformanceWinRate: '60%',
      averageExcessReturn: '0.8%',
      baselineCode: '161125',
      holdingDays: 126,
      testDays: 126,
      avgWin: '3.57%',
      avgLoss: '-2.44%',
      profitFactor: 1.46,
      medianExcessReturn: '0.66%',
      strategyMaxDrawdown: '-14.79%',
      benchmarkMaxDrawdown: '-11.89%',
      assumptions: { feesIncluded: true, qdiiLagIncluded: true, optimizationTrials: 2 }
    }
  };
  const metrics = walkForward.buildAcceptanceMetrics(wfResult, []);
  assert.strictEqual(metrics.rollingWindows, 22);
  assert.strictEqual(metrics.winRate, 50);
  assert.strictEqual(metrics.benchmarkWinRate, 45);
  assert.strictEqual(metrics.outperformanceWinRate, 60);
  assert.strictEqual(metrics.averageExcessReturn, 0.8);
  assert.strictEqual(metrics.baselineCode, '161125');
  assert.strictEqual(metrics.holdingDays, 126);
  assert.strictEqual(metrics.avgWin, 3.57);
  assert.strictEqual(metrics.avgLoss, -2.44);
  assert.strictEqual(metrics.profitFactor, 1.46);
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

test('buildAcceptanceMetrics: 影子记录中的硬风控违规不能被默认为零', () => {
  const wfResult = {
    summary: {
      windows: 12, nonOverlappingWindows: 6, medianExcessReturn: 1,
      strategyMaxDrawdown: '-5%', benchmarkMaxDrawdown: '-6%',
      assumptions: { feesIncluded: true, qdiiLagIncluded: true, optimizationTrials: 4 }
    }
  };
  const metrics = walkForward.buildAcceptanceMetrics(wfResult, [
    { date: '2026-07-06', pauseReasons: ['SIGNAL_WARMING_UP'] },
    { date: '2026-07-13', pauseReasons: ['DATA_STALE'] }
  ]);
  assert.strictEqual(metrics.hardRiskViolations, 1);
});

test('buildAcceptanceMetrics: 胜率和盈亏质量字段齐全且可被 evaluateLiveAcceptance 消费', () => {
  const wfResult = {
    summary: {
      windows: 12, nonOverlappingWindows: 6, winRate: '58.33%', benchmarkWinRate: '50%',
      outperformanceWinRate: '58.33%', averageExcessReturn: '0.5%', profitFactor: 1.3,
      medianExcessReturn: '0.5%',
      strategyMaxDrawdown: '-10%', benchmarkMaxDrawdown: '-9%',
      assumptions: { feesIncluded: true, qdiiLagIncluded: true, optimizationTrials: 2 }
    }
  };
  const metrics = walkForward.buildAcceptanceMetrics(wfResult, [{ date: '2026-07-06' }]);
  const need = ['rollingWindows', 'nonOverlappingWindows', 'medianExcess12Week', 'drawdownGapPercentagePoints',
    'winRate', 'benchmarkWinRate', 'outperformanceWinRate', 'averageExcessReturn', 'profitFactor',
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
      baselineBacktestCode: 'BASE',
      executionLagDays: 2,
      qdiiLagIncluded: true,
      optimizationTrials: 3
    },
    monthlyDcaEvidence: {
      windows: 7,
      outperformanceRate: 57.14,
      averageExcessProfit: 1.25,
      totalExcessProfit: 12.5,
      sameCashFlow: true,
      holdoutPassed: true
    },
    shadowHistory: [{ date: '2026-08-10' }],
    runBacktest: function(navCache, funds, options) {
      received = { navCache: navCache, funds: funds, options: options };
      return {
        summary: {
          windows: 12,
          nonOverlappingWindows: 6,
          winRate: '58.33%',
          benchmarkWinRate: '50%',
          outperformanceWinRate: '58.33%',
          averageExcessReturn: '0.5%',
          profitFactor: 1.3,
          medianExcessReturn: '0.5%',
          strategyMaxDrawdown: '-5%',
          benchmarkMaxDrawdown: '-6%',
          assumptions: { feesIncluded: true, qdiiLagIncluded: true, optimizationTrials: 3 }
        }
      };
    }
  });

  assert.deepStrictEqual(received.options, {
    trainDays: 252,
    testDays: 126,
    topN: 2,
    stepDays: 126,
    buyFeeRate: 0.1,
    sellFeeRate: 0,
    executionLagDays: 2,
    benchmarkCode: 'BASE',
    qdiiLagIncluded: true,
    optimizationTrials: 3
  });
  assert.strictEqual(metrics.rollingWindows, 12);
  assert.strictEqual(metrics.shadowWeeks, 1);
  assert.strictEqual(metrics.monthlyDcaWindows, 7);
  assert.strictEqual(metrics.monthlyDcaOutperformanceRate, 57.14);
  assert.strictEqual(metrics.monthlyDcaAverageExcessProfit, 1.25);
  assert.strictEqual(metrics.monthlyDcaTotalExcessProfit, 12.5);
  assert.strictEqual(metrics.monthlyDcaSameCashFlow, true);
  assert.strictEqual(metrics.monthlyDcaHoldoutPassed, true);
});

test('monthlyDcaEvidenceFromReport: only an accepted three-stage report can open the live gate', () => {
  const rejected = walkForward.monthlyDcaEvidenceFromReport({
    accepted: false,
    assumptions: { sameCashFlow: true },
    development: null
  });
  assert.strictEqual(rejected.windows, 0);
  assert.strictEqual(rejected.holdoutPassed, false);

  const accepted = walkForward.monthlyDcaEvidenceFromReport({
    accepted: true,
    assumptions: { sameCashFlow: true },
    development: {
      excessProfit: 12.5,
      rolling: { windows: 7, outperformanceRate: 57.14, averageExcessProfit: 1.25 }
    },
    validation: { excessProfit: 1 },
    audit: { excessProfit: 2 }
  });
  assert.deepStrictEqual(accepted, {
    windows: 7,
    outperformanceRate: 57.14,
    averageExcessProfit: 1.25,
    totalExcessProfit: 12.5,
    sameCashFlow: true,
    holdoutPassed: true
  });
});
