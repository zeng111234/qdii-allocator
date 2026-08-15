"use strict";

const fs = require("fs");
const path = require("path");
const {
  compareWithBaseline,
  createRelativeMomentumAllocator,
  prepareResearchHistories,
  runRollingMonthlyComparisons
} = require("./alpha-research");
const totalReturn = require("./total-return");

const DEFAULT_BASELINE_CODE = "161125";
const DEFAULT_CANDIDATE_CODES = ["160213", "000369", "160216", "040018", "000179", "320013"];
const ALPHA_STRATEGY_ID = "monthly-relative-momentum-dca-v1";
const MIN_INDEPENDENT_HOLDOUT_WINDOWS = 6;

function nonNegativeOrDefault(value, fallback) {
  if (value === null || value === undefined || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function median(values) {
  if (!values.length) return 0;
  const ordered = values.slice().sort(function (left, right) { return left - right; });
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
}

function selectIndependentWindows(windows) {
  const selected = [];
  let previousEnd = null;
  (windows || []).slice().sort(function (left, right) {
    return left.startDate.localeCompare(right.startDate);
  }).forEach(function (window) {
    if (previousEnd && window.startDate <= previousEnd) return;
    selected.push(window);
    previousEnd = window.endDate;
  });
  return selected;
}

function summarizeHoldout(validation, audit) {
  const validationWindows = validation ? validation.rollingWindows || [] : [];
  const auditWindows = audit ? audit.rollingWindows || [] : [];
  const independent = selectIndependentWindows(validationWindows.concat(auditWindows));
  const wins = independent.filter(function (window) { return Number(window.excessProfit) > 0; }).length;
  const excessProfits = independent.map(function (window) { return Number(window.excessProfit) || 0; });
  const excessReturns = independent.map(function (window) { return Number(window.excessReturn) || 0; });
  const totalExcessProfit = excessProfits.reduce(function (sum, value) { return sum + value; }, 0);
  const outperformanceRate = independent.length ? Math.round(wins / independent.length * 10000) / 100 : 0;
  const averageExcessProfit = independent.length
    ? Math.round(totalExcessProfit / independent.length * 100) / 100
    : 0;
  const medianExcessReturn = Math.round(median(excessReturns) * 100) / 100;
  const passed = independent.length >= MIN_INDEPENDENT_HOLDOUT_WINDOWS &&
    outperformanceRate >= 55 && averageExcessProfit > 0 && medianExcessReturn > 0 &&
    Number(validation && validation.excessProfit) > 0 && Number(audit && audit.excessProfit) > 0;
  return {
    validationWindows: validationWindows.length,
    auditWindows: auditWindows.length,
    totalWindows: validationWindows.length + auditWindows.length,
    independentWindows: independent.length,
    minimumIndependentWindows: MIN_INDEPENDENT_HOLDOUT_WINDOWS,
    independentWindowPeriods: independent.map(function (window) {
      return { startDate: window.startDate, endDate: window.endDate };
    }),
    outperformanceRate: outperformanceRate,
    averageExcessProfit: averageExcessProfit,
    medianExcessReturn: medianExcessReturn,
    totalExcessProfit: Math.round(totalExcessProfit * 100) / 100,
    passed: passed
  };
}

function historicalAvailabilityCovers(fund, startDate, endDate) {
  return !!fund && Array.isArray(fund.purchaseAvailabilityHistory) &&
    fund.purchaseAvailabilityHistory.some(function (period) {
      return period && period.status === "active" && Number(period.dailyLimit) > 0 &&
        String(period.startDate || "") <= startDate && String(period.endDate || "") >= endDate;
    });
}

function auditExecutionAvailability(funds, codes, startDate, endDate) {
  const byCode = {};
  (funds || []).forEach(function (fund) { byCode[String(fund.code)] = fund; });
  const requiredCodes = uniqueCodes(codes);
  const historicalUnprovenCodes = requiredCodes.filter(function (code) {
    return !historicalAvailabilityCovers(byCode[code], startDate, endDate);
  });
  const currentUnavailableCodes = requiredCodes.filter(function (code) {
    const fund = byCode[code];
    return !fund || fund.status !== "active" || !(Number(fund.dailyLimit) > 0);
  });
  const executableEvidence = historicalUnprovenCodes.length === 0 && currentUnavailableCodes.length === 0;
  return {
    researchOnly: !executableEvidence,
    requiredCodes: requiredCodes,
    historicalAvailabilityProven: historicalUnprovenCodes.length === 0,
    historicalUnprovenCodes: historicalUnprovenCodes,
    currentUnavailableCodes: currentUnavailableCodes,
    executableEvidence: executableEvidence
  };
}

function uniqueCodes(values) {
  return Array.from(new Set((values || []).map(String).filter(Boolean)));
}

function candidateGrid(candidateCodes) {
  const rows = [];
  [63, 126, 189, 252].forEach(function (lookbackDays) {
    [0, 21].forEach(function (skipDays) {
      [0.1, 0.2, 0.3].forEach(function (sleeveWeight) {
        [1, 2].forEach(function (topN) {
          rows.push({
            lookbackDays: lookbackDays,
            skipDays: skipDays,
            sleeveWeight: sleeveWeight,
            topN: topN,
            requirePositiveTrend: true
          });
        });
      });
    });
  });
  candidateCodes.forEach(function (code) {
    rows.push({
      candidateCodes: [code],
      lookbackDays: 126,
      skipDays: 0,
      sleeveWeight: 0.2,
      topN: 1,
      requirePositiveTrend: true
    });
  });
  return rows;
}

function assess(histories, common, baselineCode, candidateCodes, config, startDate, endDate, windowMonths, stepMonths) {
  const allocate = createRelativeMomentumAllocator(Object.assign({}, config, {
    baselineCode: baselineCode,
    candidateCodes: config.candidateCodes || candidateCodes
  }));
  const full = compareWithBaseline(histories, Object.assign({}, common, {
    startDate: startDate,
    endDate: endDate,
    allocate: allocate
  }));
  const rolling = runRollingMonthlyComparisons(histories, Object.assign({}, common, {
    startDate: startDate,
    endDate: endDate,
    windowMonths: windowMonths,
    stepMonths: stepMonths,
    allocate: allocate
  }));
  return {
    excessProfit: full.excessProfit,
    excessReturn: full.excessReturn,
    strategyProfit: full.strategy.netProfit,
    baselineProfit: full.baseline.netProfit,
    rolling: rolling.summary,
    rollingWindows: rolling.windows
  };
}

function assessmentForReport(result) {
  if (!result) return null;
  return {
    excessProfit: result.excessProfit,
    excessReturn: result.excessReturn,
    strategyProfit: result.strategyProfit,
    baselineProfit: result.baselineProfit,
    rolling: result.rolling
  };
}

function passesDevelopment(result) {
  return result.excessProfit > 0 &&
    result.excessReturn > 0 &&
    result.rolling.outperformanceRate >= 55 &&
    result.rolling.averageExcessProfit > 0 &&
    result.rolling.medianExcessReturn > 0;
}

function compareCandidates(left, right) {
  return right.development.rolling.outperformanceRate - left.development.rolling.outperformanceRate ||
    right.development.rolling.medianExcessReturn - left.development.rolling.medianExcessReturn ||
    right.development.excessProfit - left.development.excessProfit ||
    left.config.sleeveWeight - right.config.sleeveWeight;
}

function buildAlphaResearchReport(options) {
  const settings = options || {};
  const fundsConfig = settings.fundsConfig || {};
  const config = fundsConfig.config || fundsConfig;
  const funds = Array.isArray(fundsConfig.funds) ? fundsConfig.funds : [];
  const baselineCode = String(config.baselineBacktestCode || DEFAULT_BASELINE_CODE);
  const candidateCodes = uniqueCodes(config.alphaResearchCodes || DEFAULT_CANDIDATE_CODES)
    .filter(function (code) { return code !== baselineCode; });
  const strategyStartDates = config.alphaStrategyStartDates || {};
  const allCodes = uniqueCodes([baselineCode].concat(candidateCodes));
  const prepared = prepareResearchHistories(settings.navCache || {}, allCodes, strategyStartDates);
  const baselineRows = prepared.histories[baselineCode] || [];
  const asOf = String(settings.asOf || (baselineRows.length ? baselineRows[baselineRows.length - 1].date : new Date().toISOString().slice(0, 10)));
  const developmentStart = String(config.alphaResearchStartDate || "2017-01-01");
  const developmentEnd = "2021-12-31";
  const validationStart = "2022-01-01";
  const validationEnd = "2023-12-31";
  const auditStart = "2024-01-01";
  const common = {
    baselineCode: baselineCode,
    monthlyContribution: 100,
    buyFeeRate: nonNegativeOrDefault(config.buyFeeRate, 0.008),
    sellFeeRate: nonNegativeOrDefault(config.sellFeeRate, 0.005),
    executionLagDays: nonNegativeOrDefault(config.executionLagDays, 2)
  };

  const researched = candidateGrid(candidateCodes).map(function (candidate) {
    return {
      config: candidate,
      development: assess(prepared.histories, common, baselineCode, candidateCodes, candidate,
        developmentStart, developmentEnd, 24, 6)
    };
  }).sort(compareCandidates);
  const selected = researched.find(function (row) { return passesDevelopment(row.development); }) || null;
  let validation = null;
  let audit = null;
  let performanceAccepted = false;

  if (selected) {
    validation = assess(prepared.histories, common, baselineCode, candidateCodes, selected.config,
      validationStart, validationEnd, 24, 6);
    if (validation.excessProfit > 0 && validation.excessReturn > 0) {
      audit = assess(prepared.histories, common, baselineCode, candidateCodes, selected.config,
        auditStart, asOf, 12, 6);
      performanceAccepted = audit.excessProfit > 0 && audit.excessReturn > 0 && audit.rolling.outperformanceRate >= 50;
    }
  }

  const holdoutEvidence = summarizeHoldout(validation, audit);
  const executionAvailability = auditExecutionAvailability(
    funds,
    [baselineCode].concat(candidateCodes),
    developmentStart,
    asOf
  );
  const accepted = performanceAccepted && holdoutEvidence.passed && executionAvailability.executableEvidence;

  return {
    schemaVersion: "AlphaResearchV2",
    strategyId: ALPHA_STRATEGY_ID,
    strategyVersion: "allocation-v2.4-monthly-alpha-gate",
    asOf: asOf,
    generatedAt: new Date().toISOString(),
    objective: "在相同月度现金流、申购和赎回成本及QDII执行延迟下，提高相对" + baselineCode + "定投的净利润",
    assumptions: Object.assign({}, common, {
      sameCashFlow: true,
      totalReturnBasis: totalReturn.TOTAL_RETURN_BASIS,
      totalReturnFormula: totalReturn.TOTAL_RETURN_FORMULA,
      totalReturnDescription: "以单位净值和累计净值增量构造现金分红再投资指数；缺失任一净值的观测不回退",
      developmentPeriod: developmentStart + "/" + developmentEnd,
      validationPeriod: validationStart + "/" + validationEnd,
      auditPeriod: auditStart + "/" + asOf,
      strategyStartDates: strategyStartDates
    }),
    dataAudit: {
      baselineCode: baselineCode,
      candidateCodes: candidateCodes,
      totalReturnBasis: totalReturn.TOTAL_RETURN_BASIS,
      coverage: prepared.coverage,
      executionAvailability: executionAvailability
    },
    testedConfigurations: researched.length,
    developmentPassCount: researched.filter(function (row) { return passesDevelopment(row.development); }).length,
    topDevelopment: researched.slice(0, 5).map(function (row) {
      return { config: row.config, development: assessmentForReport(row.development) };
    }),
    selected: selected ? selected.config : null,
    development: selected ? assessmentForReport(selected.development) : null,
    validation: assessmentForReport(validation),
    audit: assessmentForReport(audit),
    holdoutEvidence: holdoutEvidence,
    performanceAccepted: performanceAccepted,
    accepted: accepted,
    decision: accepted
      ? "历史三阶段门槛通过，可进入前向影子观察；尚不代表未来盈利保证"
      : "独立样本或历史可申购性证据不足，不接入真实推荐；研究结果仅作只读观察"
  };
}

function writeAlphaResearchReport(report, outputPath) {
  const target = outputPath || path.join(__dirname, "..", "data", "alpha-research.json");
  fs.writeFileSync(target, JSON.stringify(report, null, 2) + "\n", "utf8");
  return target;
}

module.exports = {
  buildAlphaResearchReport: buildAlphaResearchReport,
  writeAlphaResearchReport: writeAlphaResearchReport
};
