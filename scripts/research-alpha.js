"use strict";

const fs = require("fs");
const path = require("path");
const navCache = require("../data/nav-cache.json");
const fundsConfig = require("../data/funds.json");
const {
  compareWithBaseline,
  createRelativeMomentumAllocator,
  runRollingMonthlyComparisons
} = require("../lib/alpha-research");

const BASELINE_CODE = "161125";
const CANDIDATE_CODES = ["539001", "000369", "160216", "040018", "000179"];
const COMMON = {
  baselineCode: BASELINE_CODE,
  monthlyContribution: 100,
  buyFeeRate: Number(fundsConfig.config.buyFeeRate) || 0.008,
  executionLagDays: Number(fundsConfig.config.executionLagDays) || 2
};

function asTotalReturnRows(rows) {
  return (rows || []).map(function (row) {
    return Object.assign({}, row, {
      // 累计净值用于跨基金总收益比较，等价于假设现金分红再投资。
      nav: Number(row.accNav) > 0 ? Number(row.accNav) : Number(row.nav)
    });
  });
}

const histories = Object.fromEntries(
  [BASELINE_CODE].concat(CANDIDATE_CODES).map(function (code) {
    return [code, asTotalReturnRows(navCache[code])];
  })
);

function candidateGrid() {
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
  CANDIDATE_CODES.forEach(function (code) {
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

function assess(config, startDate, endDate, windowMonths, stepMonths) {
  const allocate = createRelativeMomentumAllocator(Object.assign({}, config, {
    baselineCode: BASELINE_CODE,
    candidateCodes: config.candidateCodes || CANDIDATE_CODES
  }));
  const full = compareWithBaseline(histories, Object.assign({}, COMMON, {
    startDate: startDate,
    endDate: endDate,
    allocate: allocate
  }));
  const rolling = runRollingMonthlyComparisons(histories, Object.assign({}, COMMON, {
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
    rolling: rolling.summary
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

const researched = candidateGrid().map(function (config) {
  return {
    config: config,
    development: assess(config, "2017-01-01", "2021-12-31", 24, 6)
  };
}).sort(compareCandidates);

const selected = researched.find(function (row) { return passesDevelopment(row.development); }) || null;
let validation = null;
let audit = null;
let accepted = false;

if (selected) {
  validation = assess(selected.config, "2022-01-01", "2023-12-31", 24, 6);
  const validationPassed = validation.excessProfit > 0 && validation.excessReturn > 0;
  if (validationPassed) {
    audit = assess(selected.config, "2024-01-01", "2026-08-07", 12, 6);
    accepted = audit.excessProfit > 0 &&
      audit.excessReturn > 0 &&
      audit.rolling.outperformanceRate >= 50;
  }
}

const report = {
  schemaVersion: "AlphaResearchV1",
  strategyVersion: "allocation-v2.4-monthly-alpha-gate",
  asOf: "2026-08-07",
  generatedAt: new Date().toISOString(),
  objective: "在相同月度现金流、申购费和QDII执行延迟下，提高相对161125定投的净利润",
  assumptions: Object.assign({}, COMMON, {
    sameCashFlow: true,
    totalReturnBasis: "累计净值，现金分红再投资",
    developmentPeriod: "2017-01-01/2021-12-31",
    validationPeriod: "2022-01-01/2023-12-31",
    auditPeriod: "2024-01-01/2026-08-07"
  }),
  testedConfigurations: researched.length,
  developmentPassCount: researched.filter(function (row) {
    return passesDevelopment(row.development);
  }).length,
  topDevelopment: researched.slice(0, 5),
  selected: selected ? selected.config : null,
  development: selected ? selected.development : null,
  validation: validation,
  audit: audit,
  accepted: accepted,
  decision: accepted
    ? "历史三阶段门槛通过，可进入前向影子观察；尚不代表未来盈利保证"
    : "未通过三阶段门槛，不接入真实推荐，继续以161125为基准"
};

if (process.argv.includes("--write")) {
  const outputPath = path.join(__dirname, "..", "data", "alpha-research.json");
  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2) + "\n", "utf8");
}
process.stdout.write(JSON.stringify(report, null, 2) + "\n");
