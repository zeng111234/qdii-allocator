/**
 * 走步回测验证器 (Walk-Forward Backtester)
 * 受 Vibe-Trading 启发：用滚动窗口验证策略，防止过拟合
 *
 * 核心区别于普通回测：
 * - 普通回测：用全部历史数据训练参数，然后测同一段 → 过拟合
 * - 走步回测：用前N天训练，测后M天，然后滚动窗口 → 更接近真实
 *
 * 例如：用前90天数据评分，测接下来30天的收益，然后窗口向前滚动30天重复
 */

const { buildRecommendationPlan, CURRENT_STRATEGY_VERSION } = require("./recommendation-engine");
const { round2 } = require("./utils");
const allocationPolicy = require("./allocation-policy");
const totalReturn = require("./total-return");

function median(values) {
  if (!values.length) return 0;
  const sorted = values.slice().sort(function (a, b) { return a - b; });
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function nonNegativeNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function declaredNumberMatches(actual, expected) {
  const actualNumber = nonNegativeNumber(actual);
  const expectedNumber = nonNegativeNumber(expected);
  return actualNumber !== null && expectedNumber !== null && Math.abs(actualNumber - expectedNumber) < 1e-12;
}

function totalReturnRows(history) {
  return totalReturn.buildReinvestedTotalReturnIndex(history);
}

function purchaseAvailabilityAt(fund, date) {
  if (!fund || !Array.isArray(fund.purchaseAvailabilityHistory)) return null;
  return fund.purchaseAvailabilityHistory.find(function (period) {
    return period && String(period.startDate || "") <= date && String(period.endDate || "") >= date;
  }) || null;
}

function fundSnapshotAt(fund, date) {
  const availability = purchaseAvailabilityAt(fund, date);
  return Object.assign({}, fund, {
    status: availability ? availability.status : "tracking_only",
    dailyLimit: availability ? Math.max(0, Number(availability.dailyLimit) || 0) : 0
  });
}

function historicalAvailabilityCovers(fund, startDate, endDate) {
  return !!fund && Array.isArray(fund.purchaseAvailabilityHistory) &&
    fund.purchaseAvailabilityHistory.some(function (period) {
      return period && period.status === "active" && Number(period.dailyLimit) > 0 &&
        String(period.startDate || "") <= startDate && String(period.endDate || "") >= endDate;
    });
}

/**
 * 把走步回测结果映射为验收指标 (evaluateLiveAcceptance 的 9 个字段)
 * [fix] 原缺陷: index.js 从不传 acceptance, 导致 ACCEPTANCE_GATE 永远失败(没接线的闸门)。
 * 这里用真实回测数据判定, 阈值与 recommendation-engine 完全一致, 不放宽不缩紧。
 * @param {Object} wfResult - runWalkForwardBacktest 的返回值 { summary, windows }
 * @param {Array} shadowHistory - 影子历史记录 (用于计算 shadowWeeks)
 * @returns {Object|null} acceptance metrics; 回测不可用时返回 null
 */
function buildAcceptanceMetrics(wfResult, shadowHistory, declaredAssumptions) {
  if (!wfResult || !wfResult.summary) return null;
  const s = wfResult.summary;
  const assumptions = s.assumptions || {};
  const declared = declaredAssumptions || {};

  // shadowWeeks: 影子记录按 ISO 周去重计数
  const weeks = new Set();
  (shadowHistory || []).forEach(function (record) {
    const date = record && record.date;
    if (!date) return;
    const d = new Date(date + "T00:00:00Z");
    if (isNaN(d.getTime())) return;
    const day = d.getUTCDay() || 7; // 周日=7
    d.setUTCDate(d.getUTCDate() + 4 - day); // 移到本周四
    const isoWeek = d.getUTCFullYear() + "-W" + String(Math.ceil((d - new Date(Date.UTC(d.getUTCFullYear(), 0, 4)) / 86400000) / 7));
    weeks.add(isoWeek);
  });
  const hardRiskReasons = new Set([
    "DATA_ERROR", "DATA_STALE", "SYNC_REQUIRED", "EMPTY_PORTFOLIO",
    "RISK_ANCHOR_MISSING", "RISK_ANCHOR_LEDGER_MISMATCH",
    "RISK_ANCHOR_DRAWDOWN_10", "RISK_ANCHOR_DRAWDOWN_15", "UNKNOWN_HOLDINGS"
  ]);
  const hardRiskViolations = (shadowHistory || []).filter(function (record) {
    return ((record && record.pauseReasons) || []).some(function (reason) {
      return hardRiskReasons.has(reason);
    });
  }).length;

  const benchDD = parseFloat(String(s.benchmarkMaxDrawdown).replace("%", "")) || 0;
  const stratDD = parseFloat(String(s.strategyMaxDrawdown).replace("%", "")) || 0;
  function percentage(value) {
    const parsed = parseFloat(String(value).replace("%", ""));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return {
    rollingWindows: Number(s.windows) || 0,
    nonOverlappingWindows: Number(s.nonOverlappingWindows) || 0,
    winRate: percentage(s.winRate),
    benchmarkWinRate: percentage(s.benchmarkWinRate),
    outperformanceWinRate: percentage(s.outperformanceWinRate),
    averageExcessReturn: percentage(s.averageExcessReturn),
    avgWin: percentage(s.avgWin),
    avgLoss: percentage(s.avgLoss),
    profitFactor: Number.isFinite(Number(s.profitFactor)) ? Number(s.profitFactor) : null,
    baselineCode: s.baselineCode || null,
    holdingDays: Number(s.testDays) || null,
    medianExcess12Week: parseFloat(String(s.medianExcessReturn).replace("%", "")) || 0,
    drawdownGapPercentagePoints: round2(benchDD - stratDD),
    shadowWeeks: weeks.size,
    hardRiskViolations: hardRiskViolations,
    feesIncluded: assumptions.feesIncluded === true &&
      declaredNumberMatches(assumptions.buyFeeRate, declared.buyFeeRate) &&
      declaredNumberMatches(assumptions.sellFeeRate, declared.sellFeeRate),
    qdiiLagIncluded: assumptions.qdiiLagIncluded === true &&
      Number(assumptions.executionLagDays) > 0 &&
      declaredNumberMatches(assumptions.executionLagDays, declared.executionLagDays),
    optimizationTrialsReported: Number(assumptions.optimizationTrials) > 1 &&
      Number(assumptions.optimizationTrials) === Number(declared.optimizationTrials) &&
      Number(declared.optimizationTrials) > 1,
    historicalPurchaseAvailabilityProven: assumptions.historicalPurchaseAvailabilityProven === true,
    strategyId: String(s.strategyId || assumptions.strategyId || "") || null,
    strategyIdReported: !!declared.strategyId &&
      String(s.strategyId || assumptions.strategyId || "") === String(declared.strategyId)
  };
}

function buildLiveAcceptanceMetrics(input) {
  const settings = input || {};
  const config = settings.config || {};
  const runBacktest = settings.runBacktest || runWalkForwardBacktest;
  const monthly = settings.monthlyDcaEvidence || {};
  const strategyId = CURRENT_STRATEGY_VERSION;
  const testedConfigurations = Math.max(0, Number(monthly.testedConfigurations) || 0);
  const wfResult = runBacktest(settings.navCache || {}, settings.funds || [], {
    trainDays: 252,
    testDays: 126,
    topN: 2,
    stepDays: 126,
    buyFeeRate: config.buyFeeRate,
    sellFeeRate: config.sellFeeRate,
    executionLagDays: config.executionLagDays,
    benchmarkCode: config.baselineBacktestCode || "161125",
    qdiiLagIncluded: config.qdiiLagIncluded,
    optimizationTrials: testedConfigurations,
    strategyId: strategyId
  });
  const metrics = buildAcceptanceMetrics(wfResult, settings.shadowHistory || [], {
    buyFeeRate: config.buyFeeRate,
    sellFeeRate: config.sellFeeRate,
    executionLagDays: config.executionLagDays,
    optimizationTrials: testedConfigurations,
    strategyId: strategyId
  });
  if (!metrics) return null;
  const strategyEvidenceMatches = metrics.strategyIdReported === true &&
    !!monthly.strategyId && String(monthly.strategyId) === strategyId;
  const minimumIndependentHoldoutWindows = Math.max(
    6,
    Number(monthly.minimumIndependentHoldoutWindows) || 6
  );
  const monthlyDcaCostsMatch = declaredNumberMatches(monthly.buyFeeRate, config.buyFeeRate) &&
    declaredNumberMatches(monthly.sellFeeRate, config.sellFeeRate);
  const monthlyDcaLagMatches = Number(monthly.executionLagDays) > 0 &&
    declaredNumberMatches(monthly.executionLagDays, config.executionLagDays);
  const independentHoldoutVerified = Number(monthly.independentHoldoutWindows) >= minimumIndependentHoldoutWindows &&
    Number(monthly.holdoutOutperformanceRate) >= 55 &&
    Number(monthly.holdoutAverageExcessProfit) > 0 &&
    Number(monthly.holdoutMedianExcessReturn) > 0 &&
    monthly.executionAvailabilityProven === true && monthly.totalReturnBasisVerified === true;
  return Object.assign({}, metrics, {
    monthlyDcaWindows: Number(monthly.windows) || 0,
    monthlyDcaOutperformanceRate: Number(monthly.outperformanceRate) || 0,
    monthlyDcaAverageExcessProfit: Number(monthly.averageExcessProfit) || 0,
    monthlyDcaTotalExcessProfit: Number(monthly.totalExcessProfit) || 0,
    monthlyDcaSameCashFlow: monthly.sameCashFlow === true,
    monthlyDcaIndependentHoldoutWindows: Number(monthly.independentHoldoutWindows) || 0,
    monthlyDcaMinimumIndependentHoldoutWindows: minimumIndependentHoldoutWindows,
    monthlyDcaHoldoutOutperformanceRate: Number(monthly.holdoutOutperformanceRate) || 0,
    monthlyDcaHoldoutAverageExcessProfit: Number(monthly.holdoutAverageExcessProfit) || 0,
    monthlyDcaHoldoutMedianExcessReturn: Number(monthly.holdoutMedianExcessReturn) || 0,
    monthlyDcaExecutionAvailabilityProven: monthly.executionAvailabilityProven === true,
    monthlyDcaTotalReturnBasisVerified: monthly.totalReturnBasisVerified === true,
    monthlyDcaCostsMatch: monthlyDcaCostsMatch,
    monthlyDcaLagMatches: monthlyDcaLagMatches,
    monthlyDcaHoldoutPassed: monthly.holdoutPassed === true &&
      independentHoldoutVerified && monthlyDcaCostsMatch && monthlyDcaLagMatches &&
      strategyEvidenceMatches &&
      metrics.historicalPurchaseAvailabilityProven === true,
    monthlyDcaStrategyId: String(monthly.strategyId || "") || null,
    strategyEvidenceMatches: strategyEvidenceMatches
  });
}

function monthlyDcaEvidenceFromReport(report) {
  const source = report || {};
  const development = source.development || {};
  const rolling = development.rolling || {};
  const strategyId = String(source.strategyId || "") || null;
  const holdout = source.holdoutEvidence || {};
  const availability = source.dataAudit && source.dataAudit.executionAvailability || {};
  const independentHoldoutWindows = Math.max(0, Number(holdout.independentWindows) || 0);
  const minimumIndependentHoldoutWindows = Math.max(6, Number(holdout.minimumIndependentWindows) || 6);
  const executionAvailabilityProven = availability.executableEvidence === true;
  const totalReturnBasisVerified = !!(source.assumptions &&
    source.assumptions.totalReturnBasis === totalReturn.TOTAL_RETURN_BASIS);
  const buyFeeRate = nonNegativeNumber(source.assumptions && source.assumptions.buyFeeRate);
  const sellFeeRate = nonNegativeNumber(source.assumptions && source.assumptions.sellFeeRate);
  const executionLagDays = nonNegativeNumber(source.assumptions && source.assumptions.executionLagDays);
  const holdoutPassed = !!strategyId && source.assumptions && source.assumptions.sameCashFlow === true &&
    Number(source.testedConfigurations) > 1 &&
    holdout.passed === true &&
    independentHoldoutWindows >= minimumIndependentHoldoutWindows &&
    Number(holdout.outperformanceRate) >= 55 &&
    Number(holdout.averageExcessProfit) > 0 && Number(holdout.medianExcessReturn) > 0 &&
    executionAvailabilityProven && totalReturnBasisVerified &&
    buyFeeRate !== null && sellFeeRate !== null && executionLagDays > 0;
  return {
    windows: Number(rolling.windows) || 0,
    outperformanceRate: Number(rolling.outperformanceRate) || 0,
    averageExcessProfit: Number(rolling.averageExcessProfit) || 0,
    totalExcessProfit: Number(development.excessProfit) || 0,
    sameCashFlow: !!(source.assumptions && source.assumptions.sameCashFlow === true),
    holdoutPassed: holdoutPassed,
    testedConfigurations: Math.max(0, Number(source.testedConfigurations) || 0),
    strategyId: strategyId,
    independentHoldoutWindows: independentHoldoutWindows,
    minimumIndependentHoldoutWindows: minimumIndependentHoldoutWindows,
    holdoutOutperformanceRate: Number(holdout.outperformanceRate) || 0,
    holdoutAverageExcessProfit: Number(holdout.averageExcessProfit) || 0,
    holdoutMedianExcessReturn: Number(holdout.medianExcessReturn) || 0,
    executionAvailabilityProven: executionAvailabilityProven,
    totalReturnBasisVerified: totalReturnBasisVerified,
    buyFeeRate: buyFeeRate,
    sellFeeRate: sellFeeRate,
    executionLagDays: executionLagDays
  };
}

function simulateExecutionLagScenarios(history, decisionIndex, endIndex, lagDays, costs) {
  const rows = totalReturnRows(history);
  const settings = costs || {};
  const buyFeeRate = Math.max(0, Number(settings.buyFeeRate) || 0);
  const sellFeeRate = Math.max(0, Number(settings.sellFeeRate) || 0);
  return (lagDays || [0, 1, 2]).map(function (lag) {
    const buyIndex = Number(decisionIndex) + Number(lag);
    const buy = rows[buyIndex];
    const end = rows[endIndex];
    if (!buy || !end || Number(buy.nav) <= 0) {
      return { lagDays: Number(lag), available: false, netReturn: null, reason: "ACC_NAV_REQUIRED" };
    }
    const grossMultiple = Number(end.nav) / Number(buy.nav);
    const netMultiple = grossMultiple * (1 - buyFeeRate) * (1 - sellFeeRate);
    return {
      lagDays: Number(lag), available: true, buyDate: buy.date, endDate: end.date,
      buyNav: Number(buy.nav), endNav: Number(end.nav),
      grossReturn: round2((grossMultiple - 1) * 100),
      netReturn: round2((netMultiple - 1) * 100),
      feesIncluded: buyFeeRate > 0 || sellFeeRate > 0,
      totalReturnBasis: totalReturn.TOTAL_RETURN_BASIS
    };
  });
}

function executionWindow(history, startDate, endDate, lagDays) {
  const rows = totalReturnRows(history);
  const decisionIndex = rows.findIndex(function (row) { return row.date >= startDate; });
  if (decisionIndex < 0) return null;
  const buyIndex = decisionIndex + Math.max(0, Number(lagDays) || 0);
  let endIndex = -1;
  for (let index = rows.length - 1; index >= 0; index--) {
    if (rows[index].date <= endDate) {
      endIndex = index;
      break;
    }
  }
  if (!rows[buyIndex] || endIndex < buyIndex) return null;
  return { rows: rows, buyIndex: buyIndex, endIndex: endIndex };
}

function calculateWindowReturn(history, startDate, endDate, lagDays, costs) {
  const window = executionWindow(history, startDate, endDate, lagDays);
  if (!window) {
    return {
      available: false,
      netReturn: null,
      lagDays: Number(lagDays) || 0,
      reason: "ACC_NAV_REQUIRED",
      totalReturnBasis: totalReturn.TOTAL_RETURN_BASIS
    };
  }
  const settings = costs || {};
  const buyFeeRate = Math.max(0, Number(settings.buyFeeRate) || 0);
  const sellFeeRate = Math.max(0, Number(settings.sellFeeRate) || 0);
  const buy = window.rows[window.buyIndex];
  const end = window.rows[window.endIndex];
  const grossMultiple = Number(end.nav) / Number(buy.nav);
  const netMultiple = grossMultiple * (1 - buyFeeRate) * (1 - sellFeeRate);
  return {
    available: true,
    lagDays: Number(lagDays) || 0,
    buyDate: buy.date,
    endDate: end.date,
    buyNav: Number(buy.nav),
    endNav: Number(end.nav),
    grossReturn: round2((grossMultiple - 1) * 100),
    netReturn: round2((netMultiple - 1) * 100),
    feesIncluded: buyFeeRate > 0 || sellFeeRate > 0,
    totalReturnBasis: totalReturn.TOTAL_RETURN_BASIS
  };
}

function calcBasketDrawdown(codes, histories, startDate, endDate, lagDays) {
  if (!codes.length) return 0;
  const tracks = codes.map(function (code) {
    const window = executionWindow(histories[code], startDate, endDate, lagDays);
    if (!window) return null;
    return {
      rows: window.rows.slice(window.buyIndex, window.endIndex + 1),
      baseNav: Number(window.rows[window.buyIndex].nav),
      cursor: -1
    };
  }).filter(Boolean);
  if (!tracks.length) return 0;
  const dates = Array.from(new Set(tracks.flatMap(function (track) {
    return track.rows.map(function (row) { return row.date; });
  }))).sort();
  let peak = 1;
  let maxDrawdown = 0;
  dates.forEach(function (date) {
    let sum = 0;
    let count = 0;
    tracks.forEach(function (track) {
      while (track.rows[track.cursor + 1] && track.rows[track.cursor + 1].date <= date) track.cursor++;
      const current = track.rows[track.cursor];
      if (current && track.baseNav > 0) {
        sum += Number(current.nav) / track.baseNav;
        count++;
      }
    });
    if (!count) return;
    const value = sum / count;
    if (value > peak) peak = value;
    maxDrawdown = Math.min(maxDrawdown, (value - peak) / peak * 100);
  });
  return round2(maxDrawdown);
}

function buildInitialHoldings(funds) {
  const seenGroups = {};
  return (funds || []).filter(function (fund) {
    if (fund.status !== "active" || Number(fund.dailyLimit) <= 0) return false;
    if (!allocationPolicy.isCoreIndexGroup(fund.indexGroup)) return false;
    const group = fund.indexGroup || fund.code;
    if (seenGroups[group]) return false;
    seenGroups[group] = true;
    return true;
  }).slice(0, 10).map(function (fund) {
    return { code: fund.code, name: fund.name, currentValue: 100, buys: [{ amount: 100 }] };
  });
}

/**
 * 走步回测主函数
 * @param {Object} fundHistories - { code: [{ date, nav }] }
 * @param {Array} funds - 基金配置列表
 * @param {Object} config - { trainDays, testDays, topN, stepDays }
 */
function runWalkForwardBacktest(fundHistories, funds, config) {
  const trainDays = config.trainDays || 120;  // 观察窗口
  const testDays = config.testDays || 30;     // 测试窗口
  const topN = Math.min(config.topN || 2, 2);  // 正式引擎每日最多2只
  const stepDays = config.stepDays || 30;     // 窗口滚动步长
  const minDataPoints = config.minDataPoints || 60;

  const histories = {};
  Object.keys(fundHistories || {}).forEach(function (code) {
    histories[code] = totalReturnRows(fundHistories[code]);
  });
  let fundCodes = Object.keys(histories);
  if (fundCodes.length === 0) return null;

  const minRequired = trainDays + testDays;

  // 只保留数据充足的基金
  fundCodes = fundCodes.filter(function (code) {
    return histories[code] && histories[code].length >= minRequired;
  });
  if (fundCodes.length === 0) {
    console.log("[走步回测] 没有数据充足的基金（需要" + minRequired + "天）");
    return null;
  }

  // 找到所有基金共有的日期范围
  const baselineCode = String(config.benchmarkCode || "");
  const referenceHistory = baselineCode && Array.isArray(histories[baselineCode])
    ? histories[baselineCode]
    : histories[fundCodes[0]];
  const commonDates = [];
  for (let d = 0; d < referenceHistory.length; d++) {
    commonDates.push(referenceHistory[d].date);
  }

  const totalDays = commonDates.length;
  if (totalDays < minRequired) {
    console.log("[走步回测] 数据不足: 需要" + minRequired + "天, 只有" + totalDays + "天");
    return null;
  }

  const windows = [];
  let windowStart = 0;

  // 滚动窗口
  while (windowStart + trainDays + testDays <= totalDays) {
    const trainEnd = windowStart + trainDays;
    const testEnd = Math.min(trainEnd + testDays, totalDays);
    windows.push({
      trainStart: windowStart,
      trainEnd: trainEnd,
      testStart: trainEnd,
      testEnd: testEnd,
      trainStartDate: commonDates[windowStart],
      trainEndDate: commonDates[trainEnd - 1],
      testStartDate: commonDates[trainEnd],
      testEndDate: commonDates[testEnd - 1]
    });
    windowStart += stepDays;
  }

  console.log("[走步回测] " + windows.length + " 个滚动窗口");
  console.log("[走步回测] 训练=" + trainDays + "天, 测试=" + testDays + "天, 步长=" + stepDays + "天");
  console.log("");

  const windowResults = [];
  for (let w = 0; w < windows.length; w++) {
    const win = windows[w];
    const historicalFunds = (funds || []).map(function (fund) {
      return fundSnapshotAt(fund, win.trainEndDate);
    });
    const initialHoldings = buildInitialHoldings(historicalFunds);

    // Step 1: 用训练窗口的数据评分（模拟"历史信息做决策"）
    const historicalCache = {};
    for (let fi = 0; fi < fundCodes.length; fi++) {
      const code = fundCodes[fi];
      historicalCache[code] = (histories[code] || []).filter(function (row) {
        return row.date >= win.trainStartDate && row.date <= win.trainEndDate;
      });
    }
    const formalPlan = buildRecommendationPlan({
      funds: historicalFunds,
      navCache: historicalCache,
      portfolio: { holdings: initialHoldings },
      history: [],
      asOf: win.trainEndDate,
      budget: 50,
      liveEnabled: false,
      // Walk-forward measures the ranking signal, not the synthetic seed
      // portfolio's concentration. Keep all production data/freshness filters,
      // but remove portfolio-cap artefacts from the research harness.
      limits: {
        minNavPoints: Math.max(minDataPoints, trainDays),
        maxCandidates: 2,
        maxHoldings: 100,
        maxFundWeight: 1,
        maxIndexGroupWeight: 1
      }
    });
    // The production gate can legitimately turn every displayed candidate into
    // a zero-amount shadow row.  Walk-forward research must evaluate the same
    // market-ranking signal before that live-execution gate, otherwise a
    // disabled live switch produces an empty "strategy" and a false loss.
    const scored = (formalPlan.marketRanking || []).filter(function (row) {
      return !Array.isArray(row.blockedBy) || row.blockedBy.length === 0;
    }).map(function (row) {
      const rows = historicalCache[row.code];
      return { code: row.code, name: row.name, score: row.marketScore, trainEndNav: rows[rows.length - 1].nav };
    });

    // Step 2: 选TopN
    scored.sort(function (a, b) { return b.score - a.score; });
    const picked = scored.slice(0, topN);

    // Step 3: 用测试窗口的数据计算真实收益（模拟"按推荐买入后的实际收益"）
    const picks = [];
    let totalReturn = 0;
    let validPicks = 0;

    for (let pi = 0; pi < picked.length; pi++) {
      const pf = picked[pi];
      const selectedLag = Number(config.executionLagDays || 0);
      const lagScenarios = (config.executionLagScenarios || [0, 1, 2]).map(function (lag) {
        return calculateWindowReturn(
          histories[pf.code], win.testStartDate, win.testEndDate, lag,
          { buyFeeRate: config.buyFeeRate, sellFeeRate: config.sellFeeRate }
        );
      });
      const selectedScenario = lagScenarios.find(function (scenario) { return scenario.lagDays === selectedLag; }) || lagScenarios[0];
      if (!selectedScenario || !selectedScenario.available) continue;
      const ret = selectedScenario.netReturn;

      picks.push({
        code: pf.code,
        name: pf.name,
        score: pf.score,
        return: ret,
        executionLagScenarios: lagScenarios
      });
      totalReturn += ret;
      validPicks++;
    }

    const avgReturn = validPicks > 0 ? round2(totalReturn / validPicks) : 0;
    const benchmarkCodes = baselineCode
      ? [baselineCode]
      : historicalFunds.filter(function (fund) {
        return fund && fund.indexGroup === "SPX500" && fund.status === "active" && Number(fund.dailyLimit) > 0;
      }).map(function (fund) { return String(fund.code); });
    let benchmarkTotal = 0;
    let benchmarkCount = 0;
    benchmarkCodes.forEach(function (code) {
      const result = calculateWindowReturn(
        histories[code], win.testStartDate, win.testEndDate, Number(config.executionLagDays || 0),
        { buyFeeRate: config.buyFeeRate, sellFeeRate: config.sellFeeRate }
      );
      if (result.available) {
        benchmarkTotal += result.netReturn;
        benchmarkCount++;
      }
    });
    const benchmarkReturn = benchmarkCount ? round2(benchmarkTotal / benchmarkCount) : null;
    const excessReturn = benchmarkReturn === null ? null : round2(avgReturn - benchmarkReturn);
    const strategyDrawdown = calcBasketDrawdown(
      picked.map(function (pick) { return pick.code; }), histories,
      win.testStartDate, win.testEndDate, Number(config.executionLagDays || 0)
    );
    const benchmarkDrawdown = calcBasketDrawdown(
      benchmarkCodes, histories, win.testStartDate, win.testEndDate, Number(config.executionLagDays || 0)
    );
    const isWin = avgReturn > 0;

    windowResults.push({
      window: w + 1,
      trainPeriod: win.trainStartDate + " ~ " + win.trainEndDate,
      testPeriod: win.testStartDate + " ~ " + win.testEndDate,
      picks: picks,
      avgReturn: avgReturn,
      benchmarkReturn: benchmarkReturn,
      excessReturn: excessReturn,
      benchmarkCodes: benchmarkCodes,
      strategyMaxDrawdown: strategyDrawdown,
      benchmarkMaxDrawdown: benchmarkDrawdown,
      isWin: isWin
    });

    const emoji = isWin ? "🟢" : "🔴";
    console.log(
      "窗口" + (w + 1) + " | 测试: " + win.testStartDate + "~" + win.testEndDate +
      " | Top" + topN + "平均收益: " + (avgReturn >= 0 ? "+" : "") + avgReturn + "% " + emoji +
      " | " + picks.map(function (p) { return p.name.substring(0, 8); }).join(", ")
    );
  }

  // 汇总
  const totalWindows = windowResults.length;
  const winWindows = windowResults.filter(function (r) { return r.isWin; }).length;
  const winRate = totalWindows > 0 ? round2((winWindows / totalWindows) * 100) : 0;
  const allReturns = windowResults.map(function (r) { return r.avgReturn; });
  const comparableResults = windowResults.filter(function (result) {
    return Number.isFinite(Number(result.benchmarkReturn)) && Number.isFinite(Number(result.excessReturn));
  });
  const benchmarkReturns = comparableResults.map(function (result) { return result.benchmarkReturn; });
  const excessReturns = comparableResults.map(function (result) { return result.excessReturn; });
  const benchmarkWins = benchmarkReturns.filter(function (value) { return value > 0; }).length;
  const outperformanceWins = excessReturns.filter(function (value) { return value > 0; }).length;
  const benchmarkWinRate = benchmarkReturns.length ? round2(benchmarkWins / benchmarkReturns.length * 100) : 0;
  const outperformanceWinRate = excessReturns.length ? round2(outperformanceWins / excessReturns.length * 100) : 0;
  const averageExcessReturn = excessReturns.length
    ? round2(excessReturns.reduce(function (sum, value) { return sum + value; }, 0) / excessReturns.length)
    : 0;
  const winningReturns = allReturns.filter(function (value) { return value > 0; });
  const losingReturns = allReturns.filter(function (value) { return value <= 0; });
  const avgAllReturn = allReturns.length > 0 ? round2(allReturns.reduce(function (s, r) { return s + r; }, 0) / allReturns.length) : 0;
  const avgWin = winningReturns.length
    ? round2(winningReturns.reduce(function (sum, value) { return sum + value; }, 0) / winningReturns.length)
    : 0;
  const avgLoss = losingReturns.length
    ? round2(losingReturns.reduce(function (sum, value) { return sum + value; }, 0) / losingReturns.length)
    : 0;
  const grossProfit = winningReturns.reduce(function (sum, value) { return sum + value; }, 0);
  const grossLoss = Math.abs(losingReturns.reduce(function (sum, value) { return sum + value; }, 0));
  const profitFactor = grossLoss > 0 ? round2(grossProfit / grossLoss) : (grossProfit > 0 ? null : 0);
  const maxReturn = allReturns.length > 0 ? Math.max.apply(null, allReturns) : 0;
  const minReturn = allReturns.length > 0 ? Math.min.apply(null, allReturns) : 0;

  // 计算累计收益（假设每个窗口等权投入）
  let cumReturn = 1;
  for (let ci = 0; ci < windowResults.length; ci++) {
    cumReturn *= (1 + windowResults[ci].avgReturn / 100);
  }
  const cumReturnPct = round2((cumReturn - 1) * 100);
  const medianExcessReturn = round2(median(excessReturns));
  const strategyMaxDrawdown = windowResults.length ? Math.min.apply(null, windowResults.map(function (result) { return result.strategyMaxDrawdown; })) : 0;
  const benchmarkMaxDrawdown = windowResults.length ? Math.min.apply(null, windowResults.map(function (result) { return result.benchmarkMaxDrawdown; })) : 0;
  let nonOverlappingWindows = 0;
  let previousTestEnd = -1;
  windows.forEach(function (window) {
    if (window.testStart >= previousTestEnd) {
      nonOverlappingWindows++;
      previousTestEnd = window.testEnd;
    }
  });
  const buyFeeRate = nonNegativeNumber(config.buyFeeRate);
  const sellFeeRate = nonNegativeNumber(config.sellFeeRate);
  const executionLagDays = Math.max(0, Number(config.executionLagDays) || 0);
  const feesIncluded = buyFeeRate !== null && sellFeeRate !== null;
  const qdiiLagIncluded = config.qdiiLagIncluded === true && executionLagDays > 0;
  const strategyId = CURRENT_STRATEGY_VERSION;
  const availabilityByCode = {};
  (funds || []).forEach(function (fund) { availabilityByCode[String(fund.code)] = fund; });
  const historicalPurchaseAvailabilityProven = fundCodes.every(function (code) {
    if (baselineCode && code === baselineCode && !availabilityByCode[code]) return true;
    return historicalAvailabilityCovers(
      availabilityByCode[code],
      commonDates[0],
      commonDates[commonDates.length - 1]
    );
  });
  const accNavRowsExcluded = Object.keys(fundHistories || {}).reduce(function (total, code) {
    return total + Math.max(0, (fundHistories[code] || []).length - (histories[code] || []).length);
  }, 0);
  const approvedForLive = totalWindows >= 12 && comparableResults.length === totalWindows &&
    nonOverlappingWindows >= 6 && winRate >= 55 && winRate > benchmarkWinRate &&
    outperformanceWinRate >= 55 && averageExcessReturn > 0 &&
    profitFactor !== null && profitFactor >= 1.2 && medianExcessReturn > 0 &&
    strategyMaxDrawdown >= benchmarkMaxDrawdown - 2 && feesIncluded && qdiiLagIncluded &&
    historicalPurchaseAvailabilityProven;

  const summary = {
    windows: totalWindows,
    winRate: winRate + "%",
    benchmarkWinRate: benchmarkWinRate + "%",
    outperformanceWinRate: outperformanceWinRate + "%",
    averageExcessReturn: averageExcessReturn + "%",
    avgWin: avgWin + "%",
    avgLoss: avgLoss + "%",
    profitFactor: profitFactor,
    avgReturnPerWindow: avgAllReturn + "%",
    bestWindow: maxReturn + "%",
    worstWindow: minReturn + "%",
    cumulativeReturn: cumReturnPct + "%",
    medianExcessReturn: medianExcessReturn + "%",
    strategyMaxDrawdown: strategyMaxDrawdown + "%",
    benchmarkMaxDrawdown: benchmarkMaxDrawdown + "%",
    approvedForLive: approvedForLive,
    nonOverlappingWindows: nonOverlappingWindows,
    comparableWindows: comparableResults.length,
    baselineCode: baselineCode || null,
    strategyId: strategyId,
    assumptions: {
      executionLagDays: executionLagDays,
      executionLagScenarios: config.executionLagScenarios || [0, 1, 2],
      buyFeeRate: buyFeeRate === null ? 0 : buyFeeRate,
      sellFeeRate: sellFeeRate === null ? 0 : sellFeeRate,
      feesIncluded: feesIncluded,
      qdiiLagIncluded: qdiiLagIncluded,
      optimizationTrials: Math.max(0, Number(config.optimizationTrials) || 0),
      strategyId: strategyId,
      totalReturnBasis: totalReturn.TOTAL_RETURN_BASIS,
      totalReturnFormula: totalReturn.TOTAL_RETURN_FORMULA,
      accNavRowsExcluded: accNavRowsExcluded,
      historicalPurchaseAvailabilityProven: historicalPurchaseAvailabilityProven
    },
    trainDays: trainDays,
    testDays: testDays,
    topN: topN
  };

  console.log("");
  console.log("=== 走步回测汇总 ===");
  console.log("窗口数: " + summary.windows);
  console.log("胜率: " + summary.winRate);
  console.log("标普基准胜率: " + summary.benchmarkWinRate + " | 跑赢标普比例: " + summary.outperformanceWinRate);
  console.log("相对标普平均超额: " + summary.averageExcessReturn);
  console.log("每窗口平均收益: " + summary.avgReturnPerWindow);
  console.log("最佳窗口: " + summary.bestWindow);
  console.log("最差窗口: " + summary.worstWindow);
  console.log("累计收益: " + summary.cumulativeReturn);
  console.log("样本外中位超额: " + summary.medianExcessReturn);
  console.log("最大回撤: 策略" + summary.strategyMaxDrawdown + " / 基准" + summary.benchmarkMaxDrawdown);
  console.log("影子转实盘验收: " + (summary.approvedForLive ? "通过" : "未通过"));
  console.log("（训练" + trainDays + "天 → 测试" + testDays + "天, Top" + topN + "）");

  return { summary: summary, windows: windowResults };
}

module.exports = {
  runWalkForwardBacktest: runWalkForwardBacktest,
  buildInitialHoldings: buildInitialHoldings,
  simulateExecutionLagScenarios: simulateExecutionLagScenarios,
  calculateWindowReturn: calculateWindowReturn,
  buildAcceptanceMetrics: buildAcceptanceMetrics,
  buildLiveAcceptanceMetrics: buildLiveAcceptanceMetrics,
  monthlyDcaEvidenceFromReport: monthlyDcaEvidenceFromReport
};
