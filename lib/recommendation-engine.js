/**
 * Deterministic recommendation engine.
 * This is the only module allowed to turn rankings into an actionable plan.
 */

const factorEngine = require("./factor-engine");
const { isTradingDay } = require("./trading-calendar");
const { pearsonCorrelation } = require("./risk");
const { round2 } = require("./utils");

const MARKET_WEIGHTS = factorEngine.DEFAULT_WEIGHTS;
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
    result[current.date] = current.nav / previous.nav - 1;
  }
  return result;
}

function alignReturnsByDate(leftHistory, rightHistory, limit) {
  const leftMap = returnsByDate(leftHistory);
  const rightMap = returnsByDate(rightHistory);
  let dates = Object.keys(leftMap).filter(function (date) {
    return Object.prototype.hasOwnProperty.call(rightMap, date);
  }).sort();
  if (limit && dates.length > limit) dates = dates.slice(-limit);
  return {
    dates: dates,
    left: dates.map(function (date) { return leftMap[date]; }),
    right: dates.map(function (date) { return rightMap[date]; })
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
  uniqueRecommendationHistory(history).forEach(function (record) {
    if (record.action === "PAUSE") {
      shadowHistory.push(record);
    } else if (record.action === "BUY" || !record.action) {
      liveHistory.push(record);
    }
  });
  return { liveHistory: liveHistory, shadowHistory: shadowHistory };
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
  const breakerTriggered = matureStats.count >= 15 &&
    (matureStats.winRate < 40 || matureStats.averageReturn <= -1);
  const recovered = breakerTriggered && shadowStats.count >= 20 &&
    shadowStats.winRate >= 50 && shadowStats.averageReturn > 0;
  return {
    status: breakerTriggered && !recovered ? "PAUSE" : (matureStats.count < 15 ? "WARMING_UP" : "HEALTHY"),
    matured: matureStats,
    shadow: shadowStats,
    breakerTriggered: breakerTriggered,
    recovered: recovered
  };
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
  const pauseReasons = [];
  if (!liveEnabled) pauseReasons.push("LIVE_DISABLED");
  if (signalHealth.status === "PAUSE") pauseReasons.push("SIGNAL_BREAKER");
  else if (signalHealth.status !== "HEALTHY") pauseReasons.push("SIGNAL_WARMING_UP");
  if (unknownHoldings.length > 0) pauseReasons.push("UNKNOWN_HOLDINGS");
  let ranking;
  try {
    ranking = buildMarketRanking(options.funds || [], options.navCache || {}, options.marketTemperature, asOf, limits);
  } catch (error) {
    return {
      asOf: asOf, action: "PAUSE", pauseReasons: pauseReasons.concat("DATA_ERROR"),
      dataFreshness: { status: "ERROR", error: error.message }, budget: 0,
      candidates: [], portfolioRisk: { calculationAvailable: false, unknownHoldings: unknownHoldings }, signalHealth: signalHealth
    };
  }

  const groupAmounts = {};
  holdings.forEach(function (holding) {
    const meta = fundMap[holding.code];
    if (!meta) return;
    const group = meta.indexGroup || meta.code;
    groupAmounts[group] = (groupAmounts[group] || 0) + amounts[holding.code];
  });
  const coreByGroup = Object.assign({ NDX100: "270042" }, options.coreByIndexGroup || {});
  const assessed = ranking.eligible.map(function (row) {
    const blockedBy = row.blockedBy.slice();
    const isHeld = Object.prototype.hasOwnProperty.call(amounts, row.code);
    if (holdings.length >= limits.maxHoldings && !isHeld) blockedBy.push("PORTFOLIO_FULL");
    if (coreByGroup[row.indexGroup] && coreByGroup[row.indexGroup] !== row.code) blockedBy.push("INDEX_CORE_ONLY");
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
  assessed.forEach(function (row) {
    if (displayed.length < limits.maxCandidates && !selectedCodes.has(row.code)) displayed.push(row);
  });
  const allocation = selected.length ? budget / selected.length : 0;
  const candidates = displayed.slice(0, limits.maxCandidates).map(function (row) {
    const canBuy = action === "BUY" && selectedCodes.has(row.code) && row.blockedBy.length === 0;
    return {
      code: row.code,
      name: row.name,
      indexGroup: row.indexGroup,
      marketScore: row.marketScore,
      suitabilityScore: row.suitabilityScore,
      proposedAmount: canBuy ? round2(Math.min(allocation, Number(row.fund.dailyLimit) || allocation)) : 0,
      reasons: ["市场评分 " + row.marketScore, canBuy ? "通过全部硬风控" : "影子候选，不执行真实买入"],
      blockedBy: row.blockedBy
    };
  });
  const latestDates = ranking.eligible.map(function (row) { return row.latestNavDate; }).filter(Boolean).sort();
  return {
    asOf: asOf,
    action: action,
    pauseReasons: pauseReasons,
    dataFreshness: {
      status: ranking.eligible.length > 0 ? "FRESH" : "UNAVAILABLE",
      latestNavDate: latestDates.length ? latestDates[latestDates.length - 1] : null,
      maxTradingDayLag: ranking.eligible.reduce(function (max, row) { return Math.max(max, row.freshnessLag); }, 0),
      observationCount: ranking.observationPool.length
    },
    budget: action === "BUY" ? budget : 0,
    candidates: candidates,
    portfolioRisk: {
      holdingCount: holdings.length,
      totalAmount: round2(totalAmount),
      unknownHoldings: unknownHoldings,
      maxFundWeight: limits.maxFundWeight,
      maxIndexGroupWeight: limits.maxIndexGroupWeight
    },
    signalHealth: signalHealth,
    marketRanking: assessed.map(function (row) {
      return { code: row.code, name: row.name, indexGroup: row.indexGroup, marketScore: row.marketScore, blockedBy: row.blockedBy };
    }),
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
  DEFAULT_LIMITS: DEFAULT_LIMITS,
  percentileRanks: percentileRanks,
  tradingDayLag: tradingDayLag,
  alignReturnsByDate: alignReturnsByDate,
  alignedCorrelation: alignedCorrelation,
  partitionRecommendationHistory: partitionRecommendationHistory,
  evaluateSignalHealth: evaluateSignalHealth,
  buildMarketRanking: buildMarketRanking,
  buildRecommendationPlan: buildRecommendationPlan,
  validateAIOutput: validateAIOutput,
  formatRecommendationPlan: formatRecommendationPlan
};
