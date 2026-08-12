"use strict";

const { round2 } = require("./utils");

const VALID_ROWS_CACHE = new WeakMap();

function validRows(rows) {
  if (Array.isArray(rows) && VALID_ROWS_CACHE.has(rows)) return VALID_ROWS_CACHE.get(rows);
  const ordered = (rows || []).filter(function (row) {
    return row && row.date && Number(row.nav) > 0;
  }).slice().sort(function (left, right) { return left.date.localeCompare(right.date); });
  if (Array.isArray(rows)) VALID_ROWS_CACHE.set(rows, ordered);
  VALID_ROWS_CACHE.set(ordered, ordered);
  return ordered;
}

function rowsThrough(rows, date) {
  const ordered = validRows(rows);
  let low = 0;
  let high = ordered.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (ordered[middle].date <= date) low = middle + 1;
    else high = middle;
  }
  const sliced = ordered.slice(0, low);
  VALID_ROWS_CACHE.set(sliced, sliced);
  return sliced;
}

function executionRow(rows, decisionDate, lagDays) {
  const ordered = validRows(rows);
  const decisionIndex = ordered.findIndex(function (row) { return row.date >= decisionDate; });
  if (decisionIndex < 0) return null;
  return ordered[decisionIndex + Math.max(0, Number(lagDays) || 0)] || null;
}

function endRow(rows, endDate) {
  const ordered = validRows(rows).filter(function (row) { return row.date <= endDate; });
  return ordered.length ? ordered[ordered.length - 1] : null;
}

function monthlyDecisionDates(baselineRows, startDate, endDate) {
  const seen = new Set();
  return validRows(baselineRows).filter(function (row) {
    if (row.date < startDate || row.date > endDate) return false;
    const month = row.date.slice(0, 7);
    if (seen.has(month)) return false;
    seen.add(month);
    return true;
  }).map(function (row) { return row.date; });
}

function normalizedWeights(rawWeights, histories, baselineCode, decisionDate, lagDays) {
  const requested = rawWeights && typeof rawWeights === "object" ? rawWeights : {};
  const available = {};
  Object.keys(requested).forEach(function (code) {
    const weight = Math.max(0, Number(requested[code]) || 0);
    if (!(weight > 0) || !executionRow(histories[code], decisionDate, lagDays)) return;
    available[code] = (available[code] || 0) + weight;
  });
  let total = Object.values(available).reduce(function (sum, weight) { return sum + weight; }, 0);
  if (total > 1) {
    Object.keys(available).forEach(function (code) { available[code] /= total; });
    total = 1;
  }
  const remainder = Math.max(0, 1 - total);
  if (remainder > 0 && executionRow(histories[baselineCode], decisionDate, lagDays)) {
    available[baselineCode] = (available[baselineCode] || 0) + remainder;
  }
  return available;
}

function simulateMonthlyContributions(histories, options) {
  const settings = options || {};
  const baselineCode = String(settings.baselineCode || "");
  if (!baselineCode || !Array.isArray(histories && histories[baselineCode])) {
    throw new Error("baseline history is required");
  }
  const startDate = String(settings.startDate || "0000-00-00");
  const endDate = String(settings.endDate || "9999-12-31");
  const monthlyContribution = Math.max(0, Number(settings.monthlyContribution) || 0);
  const buyFeeRate = Math.max(0, Number(settings.buyFeeRate) || 0);
  const executionLagDays = Math.max(0, Number(settings.executionLagDays) || 0);
  const allocate = typeof settings.allocate === "function"
    ? settings.allocate
    : function () { return { [baselineCode]: 1 }; };
  const dates = monthlyDecisionDates(histories[baselineCode], startDate, endDate);
  const shares = {};
  const allocations = {};
  let totalContributed = 0;
  let investedAmount = 0;

  dates.forEach(function (decisionDate) {
    const context = {
      date: decisionDate,
      baselineCode: baselineCode,
      history: function (code) { return rowsThrough(histories[code], decisionDate); }
    };
    const weights = normalizedWeights(allocate(context), histories, baselineCode, decisionDate, executionLagDays);
    Object.keys(weights).forEach(function (code) {
      const amount = monthlyContribution * weights[code];
      const row = executionRow(histories[code], decisionDate, executionLagDays);
      if (!(amount > 0) || !row) return;
      shares[code] = (shares[code] || 0) + amount * (1 - buyFeeRate) / Number(row.nav);
      allocations[code] = (allocations[code] || 0) + amount;
      investedAmount += amount;
    });
    totalContributed += monthlyContribution;
  });

  let endValue = 0;
  Object.keys(shares).forEach(function (code) {
    const row = endRow(histories[code], endDate);
    if (row) endValue += shares[code] * Number(row.nav);
  });
  const unallocatedCash = Math.max(0, totalContributed - investedAmount);
  endValue += unallocatedCash;
  const netProfit = endValue - totalContributed;
  return {
    startDate: startDate,
    endDate: endDate,
    contributionCount: dates.length,
    totalContributed: round2(totalContributed),
    endValue: round2(endValue),
    netProfit: round2(netProfit),
    netReturn: totalContributed > 0 ? round2(netProfit / totalContributed * 100) : 0,
    unallocatedCash: round2(unallocatedCash),
    allocations: Object.fromEntries(Object.entries(allocations).map(function (entry) {
      return [entry[0], round2(entry[1])];
    })),
    assumptions: {
      monthlyContribution: monthlyContribution,
      buyFeeRate: buyFeeRate,
      executionLagDays: executionLagDays
    }
  };
}

function compareWithBaseline(histories, options) {
  const settings = Object.assign({}, options || {});
  const baselineCode = String(settings.baselineCode || "");
  const strategy = simulateMonthlyContributions(histories, settings);
  const baseline = simulateMonthlyContributions(histories, Object.assign({}, settings, {
    allocate: function () { return { [baselineCode]: 1 }; }
  }));
  return {
    strategy: strategy,
    baseline: baseline,
    excessProfit: round2(strategy.netProfit - baseline.netProfit),
    excessReturn: round2(strategy.netReturn - baseline.netReturn)
  };
}

function trailingReturn(rows, lookbackDays, skipDays) {
  const ordered = validRows(rows);
  const skip = Math.max(0, Number(skipDays) || 0);
  const lookback = Math.max(1, Number(lookbackDays) || 1);
  const endIndex = ordered.length - 1 - skip;
  const startIndex = endIndex - lookback;
  if (startIndex < 0 || !ordered[startIndex] || !ordered[endIndex]) return null;
  return Number(ordered[endIndex].nav) / Number(ordered[startIndex].nav) - 1;
}

function createRelativeMomentumAllocator(options) {
  const settings = options || {};
  const baselineCode = String(settings.baselineCode || "");
  const candidateCodes = Array.isArray(settings.candidateCodes) ? settings.candidateCodes.slice() : [];
  const sleeveWeight = Math.min(1, Math.max(0, Number(settings.sleeveWeight) || 0));
  const topN = Math.max(1, Number(settings.topN) || 1);
  const minRelativeExcess = Number(settings.minRelativeExcess) || 0;
  const requirePositiveTrend = settings.requirePositiveTrend !== false;
  return function (context) {
    const baselineReturn = trailingReturn(context.history(baselineCode), settings.lookbackDays, settings.skipDays);
    if (!Number.isFinite(baselineReturn) || !(sleeveWeight > 0)) return { [baselineCode]: 1 };
    const ranked = candidateCodes.map(function (code) {
      const value = trailingReturn(context.history(code), settings.lookbackDays, settings.skipDays);
      return { code: code, value: value, excess: Number.isFinite(value) ? value - baselineReturn : null };
    }).filter(function (row) {
      if (!Number.isFinite(row.excess) || row.excess <= minRelativeExcess) return false;
      return !requirePositiveTrend || row.value > 0;
    }).sort(function (left, right) {
      return right.excess - left.excess || left.code.localeCompare(right.code);
    }).slice(0, topN);
    if (!ranked.length) return { [baselineCode]: 1 };
    const weights = { [baselineCode]: 1 - sleeveWeight };
    ranked.forEach(function (row) { weights[row.code] = sleeveWeight / ranked.length; });
    return weights;
  };
}

function addMonths(dateString, months) {
  const date = new Date(String(dateString).slice(0, 7) + "-01T00:00:00Z");
  date.setUTCMonth(date.getUTCMonth() + Number(months));
  return date.toISOString().slice(0, 10);
}

function previousDate(dateString) {
  const date = new Date(String(dateString) + "T00:00:00Z");
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

function median(values) {
  if (!values.length) return 0;
  const ordered = values.slice().sort(function (left, right) { return left - right; });
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
}

function runRollingMonthlyComparisons(histories, options) {
  const settings = options || {};
  const windowMonths = Math.max(1, Number(settings.windowMonths) || 12);
  const stepMonths = Math.max(1, Number(settings.stepMonths) || 1);
  const windows = [];
  let windowStart = String(settings.startDate || "").slice(0, 7) + "-01";
  const finalEnd = String(settings.endDate || "9999-12-31");
  while (windowStart <= finalEnd) {
    const windowEnd = previousDate(addMonths(windowStart, windowMonths));
    if (windowEnd > finalEnd) break;
    const comparison = compareWithBaseline(histories, Object.assign({}, settings, {
      startDate: windowStart,
      endDate: windowEnd
    }));
    windows.push({
      startDate: windowStart,
      endDate: windowEnd,
      strategyProfit: comparison.strategy.netProfit,
      baselineProfit: comparison.baseline.netProfit,
      strategyReturn: comparison.strategy.netReturn,
      baselineReturn: comparison.baseline.netReturn,
      excessProfit: comparison.excessProfit,
      excessReturn: comparison.excessReturn
    });
    windowStart = addMonths(windowStart, stepMonths);
  }
  const comparable = windows.filter(function (window) { return Number.isFinite(window.excessProfit); });
  const wins = comparable.filter(function (window) { return window.excessProfit > 0; }).length;
  const excessProfits = comparable.map(function (window) { return window.excessProfit; });
  const excessReturns = comparable.map(function (window) { return window.excessReturn; });
  return {
    windows: windows,
    summary: {
      windows: comparable.length,
      outperformanceRate: comparable.length ? round2(wins / comparable.length * 100) : 0,
      averageExcessProfit: comparable.length
        ? round2(excessProfits.reduce(function (sum, value) { return sum + value; }, 0) / comparable.length)
        : 0,
      medianExcessReturn: round2(median(excessReturns)),
      worstExcessProfit: excessProfits.length ? round2(Math.min.apply(null, excessProfits)) : 0
    }
  };
}

module.exports = {
  simulateMonthlyContributions: simulateMonthlyContributions,
  compareWithBaseline: compareWithBaseline,
  monthlyDecisionDates: monthlyDecisionDates,
  trailingReturn: trailingReturn,
  createRelativeMomentumAllocator: createRelativeMomentumAllocator,
  runRollingMonthlyComparisons: runRollingMonthlyComparisons
};
