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

const { buildRecommendationPlan } = require("./recommendation-engine");
const { round2 } = require("./utils");
const allocationPolicy = require("./allocation-policy");

function median(values) {
  if (!values.length) return 0;
  const sorted = values.slice().sort(function (a, b) { return a - b; });
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * 把走步回测结果映射为验收指标 (evaluateLiveAcceptance 的 9 个字段)
 * [fix] 原缺陷: index.js 从不传 acceptance, 导致 ACCEPTANCE_GATE 永远失败(没接线的闸门)。
 * 这里用真实回测数据判定, 阈值与 recommendation-engine 完全一致, 不放宽不缩紧。
 * @param {Object} wfResult - runWalkForwardBacktest 的返回值 { summary, windows }
 * @param {Array} shadowHistory - 影子历史记录 (用于计算 shadowWeeks)
 * @returns {Object|null} acceptance metrics; 回测不可用时返回 null
 */
function buildAcceptanceMetrics(wfResult, shadowHistory) {
  if (!wfResult || !wfResult.summary) return null;
  const s = wfResult.summary;

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
    "RISK_ANCHOR_DRAWDOWN_10", "UNKNOWN_HOLDINGS"
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
    feesIncluded: s.assumptions ? s.assumptions.feesIncluded === true : false,
    qdiiLagIncluded: s.assumptions ? s.assumptions.qdiiLagIncluded === true : false,
    optimizationTrialsReported: s.assumptions ? Number(s.assumptions.optimizationTrials || 1) > 1 : false
  };
}

function buildLiveAcceptanceMetrics(input) {
  const settings = input || {};
  const config = settings.config || {};
  const runBacktest = settings.runBacktest || runWalkForwardBacktest;
  const wfResult = runBacktest(settings.navCache || {}, settings.funds || [], {
    trainDays: 252,
    testDays: 126,
    topN: 2,
    stepDays: 126,
    buyFeeRate: config.buyFeeRate,
    sellFeeRate: 0,
    executionLagDays: config.executionLagDays,
    benchmarkCode: config.baselineBacktestCode || "161125",
    qdiiLagIncluded: config.qdiiLagIncluded,
    optimizationTrials: config.optimizationTrials
  });
  const metrics = buildAcceptanceMetrics(wfResult, settings.shadowHistory || []);
  if (!metrics) return null;
  const monthly = settings.monthlyDcaEvidence || {};
  return Object.assign({}, metrics, {
    monthlyDcaWindows: Number(monthly.windows) || 0,
    monthlyDcaOutperformanceRate: Number(monthly.outperformanceRate) || 0,
    monthlyDcaAverageExcessProfit: Number(monthly.averageExcessProfit) || 0,
    monthlyDcaTotalExcessProfit: Number(monthly.totalExcessProfit) || 0,
    monthlyDcaSameCashFlow: monthly.sameCashFlow === true,
    monthlyDcaHoldoutPassed: monthly.holdoutPassed === true
  });
}

function monthlyDcaEvidenceFromReport(report) {
  const source = report || {};
  const development = source.development || {};
  const rolling = development.rolling || {};
  const holdoutPassed = source.accepted === true &&
    Number(source.validation && source.validation.excessProfit) > 0 &&
    Number(source.audit && source.audit.excessProfit) > 0;
  return {
    windows: Number(rolling.windows) || 0,
    outperformanceRate: Number(rolling.outperformanceRate) || 0,
    averageExcessProfit: Number(rolling.averageExcessProfit) || 0,
    totalExcessProfit: Number(development.excessProfit) || 0,
    sameCashFlow: !!(source.assumptions && source.assumptions.sameCashFlow === true),
    holdoutPassed: holdoutPassed
  };
}

function simulateExecutionLagScenarios(history, decisionIndex, endIndex, lagDays, costs) {
  const rows = history || [];
  const settings = costs || {};
  const buyFeeRate = Math.max(0, Number(settings.buyFeeRate) || 0);
  const sellFeeRate = Math.max(0, Number(settings.sellFeeRate) || 0);
  return (lagDays || [0, 1, 2]).map(function (lag) {
    const buyIndex = Number(decisionIndex) + Number(lag);
    const buy = rows[buyIndex];
    const end = rows[endIndex];
    if (!buy || !end || Number(buy.nav) <= 0) {
      return { lagDays: Number(lag), available: false, netReturn: null };
    }
    const grossMultiple = Number(end.nav) / Number(buy.nav);
    const netMultiple = grossMultiple * (1 - buyFeeRate) * (1 - sellFeeRate);
    return {
      lagDays: Number(lag), available: true, buyDate: buy.date, endDate: end.date,
      buyNav: Number(buy.nav), endNav: Number(end.nav),
      grossReturn: round2((grossMultiple - 1) * 100),
      netReturn: round2((netMultiple - 1) * 100),
      feesIncluded: buyFeeRate > 0 || sellFeeRate > 0
    };
  });
}

function executionWindow(history, startDate, endDate, lagDays) {
  const rows = (history || []).filter(function (row) {
    return row && row.date && Number(row.nav) > 0;
  }).slice().sort(function (left, right) { return left.date.localeCompare(right.date); });
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
  if (!window) return { available: false, netReturn: null, lagDays: Number(lagDays) || 0 };
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
    feesIncluded: buyFeeRate > 0 || sellFeeRate > 0
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
    return { code: fund.code, name: fund.name, buys: [{ amount: 100 }] };
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

  let fundCodes = Object.keys(fundHistories);
  if (fundCodes.length === 0) return null;

  const minRequired = trainDays + testDays;

  // 只保留数据充足的基金
  fundCodes = fundCodes.filter(function (code) {
    return fundHistories[code] && fundHistories[code].length >= minRequired;
  });
  if (fundCodes.length === 0) {
    console.log("[走步回测] 没有数据充足的基金（需要" + minRequired + "天）");
    return null;
  }

  // 找到所有基金共有的日期范围
  const baselineCode = String(config.benchmarkCode || "");
  const referenceHistory = baselineCode && Array.isArray(fundHistories[baselineCode])
    ? fundHistories[baselineCode]
    : fundHistories[fundCodes[0]];
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
  const initialHoldings = buildInitialHoldings(funds);

  for (let w = 0; w < windows.length; w++) {
    const win = windows[w];

    // Step 1: 用训练窗口的数据评分（模拟"历史信息做决策"）
    const historicalCache = {};
    for (let fi = 0; fi < fundCodes.length; fi++) {
      const code = fundCodes[fi];
      historicalCache[code] = (fundHistories[code] || []).filter(function (row) {
        return row.date >= win.trainStartDate && row.date <= win.trainEndDate;
      });
    }
    const formalPlan = buildRecommendationPlan({
      funds: funds,
      navCache: historicalCache,
      portfolio: { holdings: initialHoldings },
      history: [],
      asOf: win.trainEndDate,
      budget: 50,
      liveEnabled: false,
      limits: { minNavPoints: Math.max(minDataPoints, trainDays), maxCandidates: 2 }
    });
    const scored = formalPlan.candidates.filter(function (row) { return row.blockedBy.length === 0; }).map(function (row) {
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
          fundHistories[pf.code], win.testStartDate, win.testEndDate, lag,
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
      : formalPlan.marketRanking.map(function (row) { return row.code; });
    let benchmarkTotal = 0;
    let benchmarkCount = 0;
    benchmarkCodes.forEach(function (code) {
      const result = calculateWindowReturn(
        fundHistories[code], win.testStartDate, win.testEndDate, Number(config.executionLagDays || 0),
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
      picked.map(function (pick) { return pick.code; }), fundHistories,
      win.testStartDate, win.testEndDate, Number(config.executionLagDays || 0)
    );
    const benchmarkDrawdown = calcBasketDrawdown(
      benchmarkCodes, fundHistories, win.testStartDate, win.testEndDate, Number(config.executionLagDays || 0)
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
  const feesIncluded = Number(config.buyFeeRate) > 0 || Number(config.sellFeeRate) > 0;
  const qdiiLagIncluded = config.qdiiLagIncluded === true;
  const approvedForLive = totalWindows >= 12 && comparableResults.length === totalWindows &&
    nonOverlappingWindows >= 6 && winRate >= 55 && winRate > benchmarkWinRate &&
    outperformanceWinRate >= 55 && averageExcessReturn > 0 &&
    profitFactor !== null && profitFactor >= 1.2 && medianExcessReturn > 0 &&
    strategyMaxDrawdown >= benchmarkMaxDrawdown - 2 && feesIncluded && qdiiLagIncluded;

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
    assumptions: {
      executionLagDays: Number(config.executionLagDays || 0),
      executionLagScenarios: config.executionLagScenarios || [0, 1, 2],
      buyFeeRate: Number(config.buyFeeRate) || 0,
      sellFeeRate: Number(config.sellFeeRate) || 0,
      feesIncluded: feesIncluded,
      qdiiLagIncluded: qdiiLagIncluded,
      optimizationTrials: Number(config.optimizationTrials || 1)
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
