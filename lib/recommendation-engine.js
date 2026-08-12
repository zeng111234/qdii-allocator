/**
 * Deterministic recommendation engine.
 * This is the only module allowed to turn rankings into an actionable plan.
 */

const factorEngine = require("./factor-engine");
const { isTradingDay } = require("./trading-calendar");
const { pearsonCorrelation } = require("./risk");
const { round2 } = require("./utils");
const allocationPolicy = require("./allocation-policy");

const MARKET_WEIGHTS = factorEngine.DEFAULT_WEIGHTS;
const CURRENT_STRATEGY_VERSION = "allocation-v2.4-monthly-alpha-gate";
const DEFAULT_LIMITS = {
  maxFundWeight: 0.2,
  maxIndexGroupWeight: 0.35,
  maxHoldings: 10,
  maxCandidates: 2,
  maxDailyBudget: 50,
  minNavPoints: 252,
  maxFreshnessLag: 2,
  highCorrelation: 0.85
};

function weekStart(dateString) {
  const date = new Date(dateString + "T00:00:00Z");
  const day = date.getUTCDay();
  date.setUTCDate(date.getUTCDate() - (day === 0 ? 6 : day - 1));
  return date.toISOString().slice(0, 10);
}

function evaluateLiveAcceptance(input) {
  const metrics = input || {};
  const failures = [];
  function numeric(value) {
    if (value === null || value === undefined || value === "") return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  const rollingWindows = numeric(metrics.rollingWindows);
  const nonOverlappingWindows = numeric(metrics.nonOverlappingWindows);
  const winRate = numeric(metrics.winRate);
  const benchmarkWinRate = numeric(metrics.benchmarkWinRate);
  const outperformanceWinRate = numeric(metrics.outperformanceWinRate);
  const averageExcessReturn = numeric(metrics.averageExcessReturn);
  const profitFactor = numeric(metrics.profitFactor);
  const medianExcess = numeric(metrics.medianExcess12Week);
  const drawdownGap = numeric(metrics.drawdownGapPercentagePoints);
  const shadowWeeks = numeric(metrics.shadowWeeks);
  const hardRiskViolations = numeric(metrics.hardRiskViolations);
  const monthlyDcaWindows = numeric(metrics.monthlyDcaWindows);
  const monthlyDcaOutperformanceRate = numeric(metrics.monthlyDcaOutperformanceRate);
  const monthlyDcaAverageExcessProfit = numeric(metrics.monthlyDcaAverageExcessProfit);
  const monthlyDcaTotalExcessProfit = numeric(metrics.monthlyDcaTotalExcessProfit);
  if (rollingWindows === null || rollingWindows < 12) failures.push("INSUFFICIENT_ROLLING_WINDOWS");
  if (nonOverlappingWindows === null || nonOverlappingWindows < 6) failures.push("INSUFFICIENT_NON_OVERLAPPING_WINDOWS");
  if (winRate === null || winRate < 55) failures.push("WIN_RATE_BELOW_55");
  if (benchmarkWinRate === null || winRate === null || winRate <= benchmarkWinRate) failures.push("PROFIT_WIN_RATE_NOT_ABOVE_BASELINE");
  if (outperformanceWinRate === null || outperformanceWinRate < 55) failures.push("OUTPERFORMANCE_WIN_RATE_BELOW_55");
  if (averageExcessReturn === null || averageExcessReturn <= 0) failures.push("AVERAGE_EXCESS_NOT_POSITIVE");
  if (profitFactor === null || profitFactor < 1.2) failures.push("PROFIT_FACTOR_BELOW_1_2");
  if (medianExcess === null || medianExcess <= 0) failures.push("MEDIAN_EXCESS_NOT_POSITIVE");
  if (drawdownGap === null || drawdownGap > 2) failures.push("DRAWDOWN_WORSE_THAN_LIMIT");
  if (shadowWeeks === null || shadowWeeks < 8) failures.push("INSUFFICIENT_SHADOW_WEEKS");
  if (hardRiskViolations === null || hardRiskViolations !== 0) failures.push("HARD_RISK_VIOLATION");
  if (metrics.feesIncluded !== true) failures.push("FEES_NOT_INCLUDED");
  if (metrics.qdiiLagIncluded !== true) failures.push("QDII_LAG_NOT_INCLUDED");
  if (metrics.optimizationTrialsReported !== true) failures.push("MULTIPLE_TRIALS_NOT_REPORTED");
  if (monthlyDcaWindows === null || monthlyDcaWindows < 7) failures.push("INSUFFICIENT_MONTHLY_DCA_WINDOWS");
  if (monthlyDcaOutperformanceRate === null || monthlyDcaOutperformanceRate < 55) failures.push("MONTHLY_DCA_OUTPERFORMANCE_BELOW_55");
  if (monthlyDcaAverageExcessProfit === null || monthlyDcaAverageExcessProfit <= 0) failures.push("MONTHLY_DCA_AVERAGE_EXCESS_NOT_POSITIVE");
  if (monthlyDcaTotalExcessProfit === null || monthlyDcaTotalExcessProfit <= 0) failures.push("MONTHLY_DCA_TOTAL_EXCESS_NOT_POSITIVE");
  if (metrics.monthlyDcaSameCashFlow !== true) failures.push("MONTHLY_DCA_CASH_FLOW_MISMATCH");
  if (metrics.monthlyDcaHoldoutPassed !== true) failures.push("MONTHLY_DCA_HOLDOUT_FAILED");
  return { passed: failures.length === 0, failures: failures, metrics: metrics };
}

function trackingStabilityByCode(funds, navCache, asOf) {
  const grouped = {};
  (funds || []).forEach(function (fund) {
    const group = fund.indexGroup || fund.code;
    if (!grouped[group]) grouped[group] = [];
    grouped[group].push(fund);
  });
  const result = {};
  Object.values(grouped).forEach(function (groupFunds) {
    const maps = {};
    groupFunds.forEach(function (fund) {
      const rows = ((navCache && navCache[fund.code]) || []).filter(function (row) { return row.date <= asOf; }).slice(-121);
      maps[fund.code] = returnsByDate(rows);
    });
    groupFunds.forEach(function (fund) {
      const deviations = [];
      Object.keys(maps[fund.code]).forEach(function (date) {
        const interval = maps[fund.code][date];
        const peers = groupFunds.map(function (peer) { return maps[peer.code][date]; }).filter(function (value) {
          return value && value.previousDate === interval.previousDate;
        }).map(function (value) { return value.value; }).sort(function (a, b) { return a - b; });
        if (peers.length < 2) return;
        const middle = Math.floor(peers.length / 2);
        const median = peers.length % 2 ? peers[middle] : (peers[middle - 1] + peers[middle]) / 2;
        deviations.push(Math.pow(interval.value - median, 2));
      });
      result[fund.code] = deviations.length
        ? Math.sqrt(deviations.reduce(function (sum, value) { return sum + value; }, 0) / deviations.length)
        : 0;
    });
  });
  return result;
}

function percentileRanks(values) {
  if (!Array.isArray(values) || values.length === 0) return [];
  if (values.length === 1) return [50];
  const numeric = values.map(function (value, index) { return { value: Number(value), index: index }; });
  numeric.sort(function (a, b) { return a.value - b.value; });
  const result = new Array(values.length);
  let i = 0;
  while (i < numeric.length) {
    let end = i;
    while (end + 1 < numeric.length && numeric[end + 1].value === numeric[i].value) end++;
    const averageRank = (i + end) / 2;
    const percentile = numeric.length === 1 ? 50 : (averageRank / (numeric.length - 1)) * 100;
    for (let j = i; j <= end; j++) result[numeric[j].index] = round2(percentile);
    i = end + 1;
  }
  return result;
}

function tradingDayLag(latestDate, asOf) {
  if (!latestDate || !asOf || latestDate > asOf) return Infinity;
  const cursor = new Date(latestDate + "T00:00:00Z");
  const end = new Date(asOf + "T00:00:00Z");
  let lag = 0;
  while (cursor < end) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    const date = cursor.toISOString().slice(0, 10);
    if (isTradingDay(date)) lag++;
  }
  return lag;
}

function returnsByDate(history) {
  const sorted = (history || []).filter(function (row) {
    return row && row.date && Number(row.nav) > 0;
  }).slice().sort(function (a, b) { return a.date.localeCompare(b.date); });
  const result = {};
  for (let i = 1; i < sorted.length; i++) {
    const previous = sorted[i - 1];
    const current = sorted[i];
    result[current.date] = { previousDate: previous.date, value: current.nav / previous.nav - 1 };
  }
  return result;
}

function alignReturnsByDate(leftHistory, rightHistory, limit) {
  const leftMap = returnsByDate(leftHistory);
  const rightMap = returnsByDate(rightHistory);
  let dates = Object.keys(leftMap).filter(function (date) {
    return Object.prototype.hasOwnProperty.call(rightMap, date) &&
      leftMap[date].previousDate === rightMap[date].previousDate;
  }).sort();
  if (limit && dates.length > limit) dates = dates.slice(-limit);
  return {
    dates: dates,
    left: dates.map(function (date) { return leftMap[date].value; }),
    right: dates.map(function (date) { return rightMap[date].value; })
  };
}

function alignedCorrelation(leftHistory, rightHistory, days) {
  const aligned = alignReturnsByDate(leftHistory, rightHistory, days || 60);
  if (aligned.left.length < 10) return null;
  return pearsonCorrelation(aligned.left, aligned.right);
}

function flattenReturns(records) {
  const source = Array.isArray(records) ? records : (records && records.records) || [];
  const returns = [];
  source.forEach(function (record) {
    if (record && record.followUp5dReturn !== null && record.followUp5dReturn !== undefined) {
      returns.push(Number(record.followUp5dReturn));
      return;
    }
    const ranked = (record && (record.ranked || record.allocations)) || [];
    ranked.forEach(function (candidate) {
      if (candidate.followUp5dReturn !== null && candidate.followUp5dReturn !== undefined) {
        returns.push(Number(candidate.followUp5dReturn));
      }
    });
  });
  return returns.filter(Number.isFinite);
}

function uniqueRecommendationHistory(history) {
  const source = Array.isArray(history) ? history : (history && history.records) || [];
  const unique = new Map();
  source.forEach(function (record, index) {
    if (!record) return;
    const key = record.date ? "date:" + record.date : "undated:" + index;
    unique.set(key, record);
  });
  return Array.from(unique.values());
}

function partitionRecommendationHistory(history) {
  const liveHistory = [];
  const shadowHistory = [];
  const legacyHistory = [];
  uniqueRecommendationHistory(history).forEach(function (record) {
    if (record.strategyVersion !== CURRENT_STRATEGY_VERSION) {
      legacyHistory.push(record);
      return;
    }
    if (record.action === "PAUSE") {
      shadowHistory.push(record);
    } else if (record.action === "BUY" || !record.action) {
      liveHistory.push(record);
    }
  });
  return { liveHistory: liveHistory, shadowHistory: shadowHistory, legacyHistory: legacyHistory };
}

function statsFor(values) {
  if (values.length === 0) return { count: 0, winRate: null, averageReturn: null };
  return {
    count: values.length,
    winRate: round2(values.filter(function (value) { return value > 0; }).length / values.length * 100),
    averageReturn: round2(values.reduce(function (sum, value) { return sum + value; }, 0) / values.length)
  };
}

function evaluateSignalHealth(maturedRecords, shadowRecords) {
  const matured = flattenReturns(maturedRecords).slice(-30);
  const shadow = flattenReturns(shadowRecords).slice(-20);
  const matureStats = statsFor(matured);
  const shadowStats = statsFor(shadow);
  const evidence = matureStats.count >= 15 ? matureStats : shadowStats;
  const evidenceSource = matureStats.count >= 15 ? "LIVE" : "SHADOW";
  const breakerTriggered = evidence.count >= 15 &&
    (evidence.winRate < 40 || evidence.averageReturn <= -1);
  const recovered = breakerTriggered && shadowStats.count >= 20 &&
    shadowStats.winRate >= 50 && shadowStats.averageReturn > 0;
  return {
    status: breakerTriggered && !recovered ? "PAUSE" : (evidence.count < 15 ? "WARMING_UP" : "HEALTHY"),
    matured: matureStats,
    shadow: shadowStats,
    evidenceSource: evidenceSource,
    breakerTriggered: breakerTriggered,
    recovered: recovered
  };
}

function collapseMarketRanking(rows) {
  const groups = new Map();
  (rows || []).forEach(function (row) {
    const key = row.indexGroup || row.code;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  });
  return Array.from(groups.values()).map(function (groupRows) {
    const sorted = groupRows.slice().sort(function (left, right) {
      return (right.marketScore || 0) - (left.marketScore || 0) || String(left.code).localeCompare(String(right.code));
    });
    const primary = sorted[0];
    return {
      code: primary.code,
      name: primary.name,
      indexGroup: primary.indexGroup,
      marketScore: primary.marketScore,
      blockedBy: primary.blockedBy,
      channelCount: sorted.length,
      routingAlternatives: sorted.slice(1).map(function (row) { return row.code; })
    };
  }).sort(function (left, right) { return (right.marketScore || 0) - (left.marketScore || 0); });
}

function holdingAmount(holding) {
  if (Number.isFinite(Number(holding.totalAmount))) return Number(holding.totalAmount);
  return (holding.buys || []).reduce(function (sum, buy) { return sum + (Number(buy.amount) || 0); }, 0);
}

function recentReturn(navRows, periods) {
  if (!navRows || navRows.length <= periods) return null;
  const latest = navRows[navRows.length - 1].nav;
  const base = navRows[navRows.length - 1 - periods].nav;
  return base > 0 ? round2((latest / base - 1) * 100) : null;
}

function buildMarketRanking(funds, navCache, marketTemperature, asOf, limits) {
  const eligible = [];
  const observationPool = [];
  (funds || []).forEach(function (fund) {
    const navRows = ((navCache && navCache[fund.code]) || []).filter(function (row) {
      return row && row.date <= asOf && Number(row.nav) > 0;
    }).slice().sort(function (a, b) { return a.date.localeCompare(b.date); });
    const latestDate = navRows.length ? navRows[navRows.length - 1].date : null;
    const freshnessLag = tradingDayLag(latestDate, asOf);
    const blockedBy = [];
    if (fund.status !== "active" || Number(fund.dailyLimit) <= 0) blockedBy.push("NOT_BUYABLE");
    if (!allocationPolicy.isCoreIndexGroup(fund.indexGroup)) blockedBy.push("SATELLITE_ONLY");
    if (navRows.length < limits.minNavPoints) blockedBy.push("INSUFFICIENT_HISTORY");
    if (freshnessLag > limits.maxFreshnessLag) blockedBy.push("STALE_DATA");
    const rawScores = navRows.length >= 20 ? factorEngine.computeAll(
      navRows.map(function (row) { return row.nav; }), fund, marketTemperature
    ) : {};
    const row = {
      code: fund.code,
      name: fund.name,
      type: fund.type,
      indexGroup: fund.indexGroup || fund.code,
      fund: fund,
      navRows: navRows,
      latestNavDate: latestDate,
      freshnessLag: freshnessLag,
      rawScores: rawScores,
      recent5Return: recentReturn(navRows, 5),
      blockedBy: blockedBy
    };
    if (blockedBy.length === 0) eligible.push(row);
    else observationPool.push(row);
  });

  Object.keys(MARKET_WEIGHTS).forEach(function (factor) {
    if (MARKET_WEIGHTS[factor] === 0) return;
    const indexes = [];
    const values = [];
    eligible.forEach(function (row, index) {
      const value = row.rawScores[factor];
      if (value !== null && value !== undefined && Number.isFinite(Number(value))) {
        indexes.push(index);
        values.push(Number(value));
      }
    });
    const ranks = percentileRanks(values);
    indexes.forEach(function (rowIndex, rankIndex) {
      if (!eligible[rowIndex].percentiles) eligible[rowIndex].percentiles = {};
      eligible[rowIndex].percentiles[factor] = ranks[rankIndex];
    });
  });

  eligible.forEach(function (row) {
    let sum = 0;
    let total = 0;
    Object.keys(MARKET_WEIGHTS).forEach(function (factor) {
      const weight = MARKET_WEIGHTS[factor];
      const value = row.percentiles && row.percentiles[factor];
      if (weight === 0 || value === undefined) return;
      sum += (weight < 0 ? 100 - value : value) * Math.abs(weight);
      total += Math.abs(weight);
    });
    row.marketScore = total ? round2(sum / total) : null;
    const drawdown = row.rawScores.drawdown_depth;
    if (drawdown !== null && drawdown !== undefined && drawdown <= -20) row.blockedBy.push("DRAWDOWN_OVER_20");
    if (row.recent5Return !== null && row.recent5Return <= -8) row.blockedBy.push("FIVE_DAY_DROP_OVER_8");
    if (row.rawScores.trend_alignment < 0 && row.recent5Return < 0) row.blockedBy.push("TREND_DETERIORATING");
  });
  eligible.sort(function (a, b) { return (b.marketScore || 0) - (a.marketScore || 0); });
  return { eligible: eligible, observationPool: observationPool };
}

function buildRecommendationPlan(input) {
  const options = input || {};
  const limits = Object.assign({}, DEFAULT_LIMITS, options.limits || {});
  const asOf = options.asOf || new Date().toISOString().slice(0, 10);
  const budget = Math.min(Number(options.budget) || limits.maxDailyBudget, limits.maxDailyBudget);
  const policy = allocationPolicy.createAllocationPolicy(Object.assign({}, options.policy || {}, {
    riskAnchorValue: options.riskAnchorValue ?? (options.policy && options.policy.riskAnchorValue) ?? null
  }));
  const holdings = (options.portfolio && options.portfolio.holdings) || [];
  const fundMap = {};
  (options.funds || []).forEach(function (fund) { fundMap[fund.code] = fund; });
  const amounts = {};
  let totalAmount = 0;
  holdings.forEach(function (holding) {
    amounts[holding.code] = holdingAmount(holding);
    totalAmount += amounts[holding.code];
  });
  const unknownHoldings = holdings.filter(function (holding) { return !fundMap[holding.code]; }).map(function (holding) { return holding.code; });
  const partitionedHistory = partitionRecommendationHistory(options.history || []);
  const explicitShadowHistory = uniqueRecommendationHistory(options.shadowHistory || []);
  const shadowHistory = uniqueRecommendationHistory(partitionedHistory.shadowHistory.concat(explicitShadowHistory));
  const signalHealth = evaluateSignalHealth(partitionedHistory.liveHistory, shadowHistory);
  const liveEnabled = options.liveEnabled === true;
  const liveAcceptance = evaluateLiveAcceptance(options.acceptance);
  const pauseReasons = [];
  if (!liveEnabled) pauseReasons.push("LIVE_DISABLED");
  else if (!liveAcceptance.passed) pauseReasons.push("ACCEPTANCE_GATE");
  if (signalHealth.status === "PAUSE") pauseReasons.push("SIGNAL_BREAKER");
  else if (signalHealth.status !== "HEALTHY") pauseReasons.push("SIGNAL_WARMING_UP");
  if (unknownHoldings.length > 0) pauseReasons.push("UNKNOWN_HOLDINGS");
  let ranking;
  try {
    ranking = buildMarketRanking(options.funds || [], options.navCache || {}, options.marketTemperature, asOf, limits);
  } catch (error) {
    return {
      schemaVersion: "RecommendationPlanV2", allocationWeek: weekStart(asOf),
      strategyVersion: CURRENT_STRATEGY_VERSION,
      syncRevision: Number(options.syncRevision || 0), riskAnchorValue: policy.riskAnchorValue,
      asOf: asOf, action: "PAUSE", pauseReasons: pauseReasons.concat("DATA_ERROR"),
      dataFreshness: { status: "ERROR", error: error.message }, budget: 0,
      candidates: [], portfolioRisk: { calculationAvailable: false, unknownHoldings: unknownHoldings }, signalHealth: signalHealth,
      bucketExposure: {}, targetGap: {}, executionRoutes: [], confidence: "LOW",
      benchmarkComparison: options.benchmarkComparison || {}, liveAcceptance: liveAcceptance
    };
  }

  const groupAmounts = {};
  holdings.forEach(function (holding) {
    const meta = fundMap[holding.code];
    if (!meta) return;
    const group = meta.indexGroup || meta.code;
    groupAmounts[group] = (groupAmounts[group] || 0) + amounts[holding.code];
  });
  const assessed = ranking.eligible.map(function (row) {
    const blockedBy = row.blockedBy.slice();
    const isHeld = Object.prototype.hasOwnProperty.call(amounts, row.code);
    if (holdings.length >= limits.maxHoldings && !isHeld) blockedBy.push("PORTFOLIO_FULL");
    if (!allocationPolicy.bucketForIndexGroup(row.indexGroup) && !row.fund.riskBucket) blockedBy.push("UNKNOWN_RISK_BUCKET");
    const shadowAmount = Math.min(Math.max(Number(row.fund.minPurchase) || 10, budget / limits.maxCandidates), Number(row.fund.dailyLimit) || budget);
    const postTotal = totalAmount + shadowAmount;
    if (postTotal > 0 && ((amounts[row.code] || 0) + shadowAmount) / postTotal > limits.maxFundWeight) blockedBy.push("FUND_WEIGHT_LIMIT");
    if (postTotal > 0 && ((groupAmounts[row.indexGroup] || 0) + shadowAmount) / postTotal > limits.maxIndexGroupWeight) blockedBy.push("INDEX_GROUP_LIMIT");
    return Object.assign({}, row, {
      suitabilityScore: round2(Math.max(0, (row.marketScore || 0) - blockedBy.length * 15)),
      blockedBy: Array.from(new Set(blockedBy)),
      shadowAmount: round2(shadowAmount)
    });
  });

  const exposureResult = allocationPolicy.calculateBucketExposure(holdings, options.funds || [], Number(options.cashBalance) || 0, options.navCache || {});
  const targetGap = allocationPolicy.calculateTargetGap(exposureResult.exposure, policy);
  const currentValue = Number(options.currentValue ?? options.portfolio?.currentValue ?? exposureResult.totalValue);
  const anchorDrawdown = allocationPolicy.drawdownFromAnchor(policy, currentValue);
  if (anchorDrawdown !== null && anchorDrawdown <= policy.allStopDrawdown) pauseReasons.push("RISK_ANCHOR_DRAWDOWN_10");

  const selected = [];
  assessed.forEach(function (row) {
    if (selected.length >= limits.maxCandidates || row.blockedBy.length > 0) return;
    const correlated = selected.some(function (other) {
      const correlation = alignedCorrelation(row.navRows, other.navRows, 60);
      return correlation !== null && correlation >= limits.highCorrelation;
    });
    if (correlated) {
      row.blockedBy.push("HIGH_CORRELATION");
      return;
    }
    selected.push(row);
  });

  let action = "BUY";
  if (pauseReasons.length > 0) action = "PAUSE";
  if (ranking.eligible.length === 0 || selected.length === 0) action = action === "PAUSE" ? "PAUSE" : "HOLD";
  const selectedCodes = new Set(selected.map(function (row) { return row.code; }));
  const displayed = assessed.filter(function (row) { return selectedCodes.has(row.code); });
  const displayedGroups = new Set(displayed.map(function (row) { return row.indexGroup; }));
  assessed.forEach(function (row) {
    if (displayed.length < limits.maxCandidates && !selectedCodes.has(row.code) && !displayedGroups.has(row.indexGroup)) {
      displayed.push(row);
      displayedGroups.add(row.indexGroup);
    }
  });
  const deterministicBudget = allocationPolicy.allowedBudget({
    policy: policy, action: action, currentValue: currentValue,
    weeklySpent: options.weeklySpent, requestedBudget: budget
  });
  const freshnessByCode = {};
  assessed.forEach(function (row) { freshnessByCode[row.code] = row.freshnessLag; });
  const routeFunds = assessed.filter(function (row) { return row.blockedBy.length === 0; }).map(function (row) { return row.fund; });
  const executionRoutes = action === "BUY" ? allocationPolicy.buildExecutionRoutes({
    policy: policy,
    funds: routeFunds,
    holdings: holdings,
    bucketExposure: exposureResult.exposure,
    targetGap: targetGap,
    dailyBudget: deterministicBudget,
    currentValue: currentValue,
    asOf: asOf,
    freshnessByCode: freshnessByCode,
    trackingStabilityByCode: trackingStabilityByCode(options.funds || [], options.navCache || {}, asOf),
    approvedNewFundCodes: options.approvedNewFundCodes || []
  }) : [];
  if (action === "BUY" && executionRoutes.length === 0) action = "HOLD";
  const routedAmounts = {};
  executionRoutes.forEach(function (route) { routedAmounts[route.code] = (routedAmounts[route.code] || 0) + route.amount; });
  const allocation = selected.length ? deterministicBudget / selected.length : 0;
  const candidates = displayed.slice(0, limits.maxCandidates).map(function (row) {
    const canBuy = action === "BUY" && Number(routedAmounts[row.code]) > 0;
    return {
      code: row.code,
      name: row.name,
      indexGroup: row.indexGroup,
      marketScore: row.marketScore,
      suitabilityScore: row.suitabilityScore,
      proposedAmount: canBuy ? round2(routedAmounts[row.code] || Math.min(allocation, Number(row.fund.dailyLimit) || allocation)) : 0,
      reasons: ["市场评分 " + row.marketScore, canBuy ? "通过全部硬风控" : "影子候选，不执行真实买入"],
      blockedBy: row.blockedBy
    };
  });
  const latestDates = ranking.eligible.map(function (row) { return row.latestNavDate; }).filter(Boolean).sort();
  return {
    schemaVersion: "RecommendationPlanV2",
    strategyVersion: CURRENT_STRATEGY_VERSION,
    allocationWeek: weekStart(asOf),
    syncRevision: Number(options.syncRevision || 0),
    riskAnchorValue: policy.riskAnchorValue,
    asOf: asOf,
    action: action,
    pauseReasons: pauseReasons,
    dataFreshness: {
      status: ranking.eligible.length > 0 ? "FRESH" : "UNAVAILABLE",
      latestNavDate: latestDates.length ? latestDates[latestDates.length - 1] : null,
      maxTradingDayLag: ranking.eligible.reduce(function (max, row) { return Math.max(max, row.freshnessLag); }, 0),
      observationCount: ranking.observationPool.length
    },
    budget: action === "BUY" ? deterministicBudget : 0,
    candidates: candidates,
    portfolioRisk: {
      holdingCount: holdings.length,
      totalAmount: round2(totalAmount),
      unknownHoldings: unknownHoldings,
      maxFundWeight: limits.maxFundWeight,
      maxIndexGroupWeight: limits.maxIndexGroupWeight
    },
    signalHealth: signalHealth,
    allocationPolicy: policy,
    bucketExposure: exposureResult.exposure,
    targetGap: targetGap,
    executionRoutes: action === "BUY" ? executionRoutes : [],
    confidence: action === "BUY" && liveAcceptance.passed ? "MEDIUM" : "LOW",
    benchmarkComparison: options.benchmarkComparison || {},
    liveAcceptance: liveAcceptance,
    riskAnchorDrawdown: anchorDrawdown,
    marketRanking: collapseMarketRanking(assessed),
    observationPool: ranking.observationPool.map(function (row) {
      return { code: row.code, name: row.name, blockedBy: row.blockedBy, latestNavDate: row.latestNavDate };
    })
  };
}

function validateAIOutput(plan, output) {
  let parsed = output;
  if (typeof output === "string") {
    try { parsed = JSON.parse(output); } catch (error) { return { valid: false, errors: ["INVALID_JSON"] }; }
  }
  const errors = [];
  if (!parsed || parsed.action !== plan.action) errors.push("ACTION_MISMATCH");
  const allowed = {};
  (plan.candidates || []).forEach(function (candidate) { allowed[candidate.code] = candidate.proposedAmount; });
  ((parsed && parsed.candidates) || []).forEach(function (candidate) {
    if (!Object.prototype.hasOwnProperty.call(allowed, candidate.code)) errors.push("UNKNOWN_FUND:" + candidate.code);
    else if (Number(candidate.proposedAmount) !== Number(allowed[candidate.code])) errors.push("AMOUNT_MISMATCH:" + candidate.code);
  });
  return { valid: errors.length === 0, errors: errors, value: parsed };
}

function formatRecommendationPlan(plan) {
  const lines = ["=== 统一推荐计划 ===", "日期: " + plan.asOf, "操作: " + plan.action];
  lines.push("数据: " + plan.dataFreshness.status + (plan.dataFreshness.latestNavDate ? "（最新净值 " + plan.dataFreshness.latestNavDate + "）" : ""));
  lines.push("信号: " + plan.signalHealth.status);
  if (plan.action !== "BUY") lines.push("今日不买；候选仅用于影子跟踪，不执行真实投入。");
  (plan.candidates || []).forEach(function (candidate, index) {
    lines.push((index + 1) + ". " + candidate.name + "(" + candidate.code + ") 市场分=" + candidate.marketScore +
      " 适配分=" + candidate.suitabilityScore + " 金额=" + candidate.proposedAmount + "元");
    if (candidate.blockedBy.length) lines.push("   阻止原因: " + candidate.blockedBy.join(", "));
  });
  return lines.join("\n");
}

module.exports = {
  CURRENT_STRATEGY_VERSION: CURRENT_STRATEGY_VERSION,
  DEFAULT_LIMITS: DEFAULT_LIMITS,
  percentileRanks: percentileRanks,
  tradingDayLag: tradingDayLag,
  alignReturnsByDate: alignReturnsByDate,
  alignedCorrelation: alignedCorrelation,
  collapseMarketRanking: collapseMarketRanking,
  partitionRecommendationHistory: partitionRecommendationHistory,
  evaluateSignalHealth: evaluateSignalHealth,
  evaluateLiveAcceptance: evaluateLiveAcceptance,
  trackingStabilityByCode: trackingStabilityByCode,
  buildMarketRanking: buildMarketRanking,
  buildRecommendationPlan: buildRecommendationPlan,
  validateAIOutput: validateAIOutput,
  formatRecommendationPlan: formatRecommendationPlan
};
