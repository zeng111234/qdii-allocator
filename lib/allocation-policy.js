const { round2 } = require("./utils");

const TARGET_BUCKETS = Object.freeze({
  US_BROAD: 0.30,
  GROWTH_TECH: 0.25,
  NON_US: 0.25,
  DEFENSIVE: 0.10,
  CASH: 0.10
});

const RISK_PROFILES = Object.freeze({
  BALANCED: Object.freeze({
    targetBuckets: TARGET_BUCKETS,
    maxFundWeight: 0.20,
    growthStopDrawdown: -0.075,
    allStopDrawdown: -0.10,
    expectedEdge: "MATCH_BASELINE_NOT_ALPHA"
  }),
  AGGRESSIVE: Object.freeze({
    targetBuckets: Object.freeze({
      US_BROAD: 0.50,
      GROWTH_TECH: 0.35,
      NON_US: 0.05,
      DEFENSIVE: 0.10,
      CASH: 0
    }),
    maxFundWeight: 0.30,
    growthStopDrawdown: -0.12,
    allStopDrawdown: -0.15,
    expectedEdge: "HIGHER_EXPECTED_BETA_NOT_PROVEN_ALPHA"
  })
});

function normalizeRiskProfile(value) {
  return String(value || "").toUpperCase() === "AGGRESSIVE" ? "AGGRESSIVE" : "BALANCED";
}

const INDEX_GROUP_BUCKETS = Object.freeze({
  SPX500: "US_BROAD", SPX500_EQUAL_WEIGHT: "US_BROAD", US_BROAD: "US_BROAD", DOW30: "US_BROAD", RUSSELL2000: "US_BROAD",
  NDX100: "GROWTH_TECH", GLOBAL_GROWTH: "GROWTH_TECH", GLOBAL_TECH: "GROWTH_TECH",
  GLOBAL_MFG: "GROWTH_TECH", NASDAQ_BIO: "GROWTH_TECH", EV: "GROWTH_TECH", GLOBAL_UPGRADE: "GROWTH_TECH",
  JAPAN: "NON_US", EUROPE: "NON_US", APAC: "NON_US", EMERGING: "NON_US", VIETNAM: "NON_US", HK: "NON_US", GLOBAL: "NON_US",
  GOLD: "DEFENSIVE", HEALTHCARE: "DEFENSIVE", GLOBAL_MEDICAL: "DEFENSIVE", US_REIT: "DEFENSIVE", REIT: "DEFENSIVE",
  GLOBAL_REIT: "DEFENSIVE", OIL: "DEFENSIVE", COMMODITY: "DEFENSIVE"
});

// v2.2 只允许结构清晰、可作为长期配置通道的核心指数组进入新增买入。
// 主题、行业轮动和主动精选仍保留观察与持仓统计，但不再由系统自动加仓。
const CORE_INDEX_GROUPS = Object.freeze([
  "SPX500", "NDX100", "DOW30", "RUSSELL2000",
  "EUROPE", "JAPAN", "GOLD", "HEALTHCARE", "GLOBAL_MEDICAL",
  "US_REIT", "REIT", "GLOBAL_REIT"
]);
const CORE_INDEX_GROUP_SET = new Set(CORE_INDEX_GROUPS);

function isCoreIndexGroup(indexGroup) {
  return CORE_INDEX_GROUP_SET.has(indexGroup);
}

function createAllocationPolicy(overrides) {
  const settings = overrides || {};
  const riskProfile = normalizeRiskProfile(settings.riskProfile);
  const profile = RISK_PROFILES[riskProfile];
  const policy = Object.assign({
    schemaVersion: "AllocationPolicyV1",
    riskProfile: riskProfile,
    targetBuckets: Object.assign({}, profile.targetBuckets),
    maxFundWeight: profile.maxFundWeight,
    maxDailyBudget: 50,
    maxWeeklyBudget: 250,
    maxHoldingsBeforeApproval: 21,
    riskAnchorValue: null,
    growthStopDrawdown: profile.growthStopDrawdown,
    allStopDrawdown: profile.allStopDrawdown,
    expectedEdge: profile.expectedEdge,
    maxFreshnessLag: 2,
    allowAutomaticSell: false
  }, settings);
  policy.riskProfile = riskProfile;
  policy.targetBuckets = Object.assign({}, profile.targetBuckets, settings.targetBuckets || {});
  return policy;
}

function bucketForIndexGroup(indexGroup) {
  return INDEX_GROUP_BUCKETS[indexGroup] || null;
}

function latestNav(navCache, code, asOf) {
  const rows = ((navCache && navCache[code]) || []).filter(function (row) {
    return row && row.date && (!asOf || row.date <= asOf) && Number(row.nav) > 0;
  }).slice().sort(function (left, right) {
    return String(left.date).localeCompare(String(right.date));
  });
  return rows.length ? rows[rows.length - 1] : null;
}

function signedTransactionValue(transaction, key) {
  const value = Number(transaction && transaction[key]);
  if (!Number.isFinite(value)) return null;
  return transaction.type === "SELL" && value > 0 ? -value : value;
}

function calculateHoldingValuation(holding, navCache, asOf) {
  const buys = Array.isArray(holding && holding.buys) ? holding.buys : [];
  let shares = null;
  if (holding && holding.totalShares !== null && holding.totalShares !== undefined &&
      Number.isFinite(Number(holding.totalShares))) {
    shares = Number(holding.totalShares);
  } else if (buys.length > 0) {
    shares = buys.reduce(function (sum, transaction) {
      if (Object.prototype.hasOwnProperty.call(transaction, "shares")) {
        const transactionShares = signedTransactionValue(transaction, "shares");
        return transactionShares === null ? sum : sum + transactionShares;
      }
      const amount = signedTransactionValue(transaction, "amount");
      const nav = Number(transaction.nav);
      return amount !== null && nav > 0 ? sum + amount / nav : sum;
    }, 0);
  }

  if (shares === null) {
    const impliedConfirmed = Number(holding && holding.confirmedAmount) > 0 ||
      Number(holding && holding.currentValue) > 0 || Number(holding && holding.totalAmount) > 0;
    return {
      code: holding && holding.code,
      hasConfirmedPosition: impliedConfirmed,
      totalShares: null,
      value: impliedConfirmed ? null : 0,
      latestNav: null,
      latestNavDate: null,
      valuationComplete: !impliedConfirmed
    };
  }

  if (shares === 0) {
    return {
      code: holding && holding.code,
      hasConfirmedPosition: false,
      totalShares: 0,
      value: 0,
      latestNav: null,
      latestNavDate: null,
      valuationComplete: true
    };
  }

  const latest = latestNav(navCache, holding && holding.code, asOf);
  const valuationComplete = shares > 0 && Boolean(latest);
  return {
    code: holding && holding.code,
    hasConfirmedPosition: shares > 0,
    totalShares: shares,
    value: valuationComplete ? shares * Number(latest.nav) : null,
    latestNav: latest ? Number(latest.nav) : null,
    latestNavDate: latest ? latest.date : null,
    valuationComplete: valuationComplete
  };
}

function emptyExposureValues(cash) {
  return {
    US_BROAD: 0,
    GROWTH_TECH: 0,
    NON_US: 0,
    DEFENSIVE: 0,
    CASH: Number(cash) || 0,
    UNKNOWN: 0
  };
}

function calculateBucketExposure(holdings, funds, cash, navCache, asOf) {
  const fundMap = {};
  (funds || []).forEach(function (fund) { fundMap[fund.code] = fund; });
  const values = emptyExposureValues(cash);
  const valuationByCode = {};
  const missingValuationCodes = [];
  (holdings || []).forEach(function (holding) {
    const valuation = calculateHoldingValuation(holding, navCache, asOf);
    valuationByCode[holding.code] = valuation;
    if (!valuation.valuationComplete) {
      missingValuationCodes.push(holding.code);
      return;
    }
    const fund = fundMap[holding.code] || holding;
    const bucket = fund.riskBucket || bucketForIndexGroup(fund.indexGroup);
    values[bucket || "UNKNOWN"] += valuation.value;
  });
  const valuationComplete = missingValuationCodes.length === 0;
  if (!valuationComplete) {
    return {
      values: values,
      exposure: {},
      totalValue: null,
      valuationComplete: false,
      missingValuationCodes: Array.from(new Set(missingValuationCodes)),
      valuationByCode: valuationByCode
    };
  }
  const total = Object.values(values).reduce(function (sum, value) { return sum + value; }, 0);
  const exposure = {};
  Object.keys(values).forEach(function (bucket) { exposure[bucket] = total > 0 ? values[bucket] / total : 0; });
  return {
    values: values,
    exposure: exposure,
    totalValue: total,
    valuationComplete: true,
    missingValuationCodes: [],
    valuationByCode: valuationByCode
  };
}

function calculateTargetGap(exposure, policy) {
  const result = {};
  Object.keys(policy.targetBuckets).forEach(function (bucket) {
    result[bucket] = round2(policy.targetBuckets[bucket] - Number(exposure[bucket] || 0));
  });
  return result;
}

function drawdownFromAnchor(policy, currentValue) {
  const anchor = Number(policy.riskAnchorValue);
  if (!(anchor > 0) || currentValue === null || currentValue === undefined || currentValue === "" ||
      !Number.isFinite(Number(currentValue))) return null;
  return Number(currentValue) / anchor - 1;
}

function allowedBudget(options) {
  const settings = options || {};
  const policy = settings.policy || createAllocationPolicy();
  if (settings.action !== "BUY") return 0;
  const drawdown = drawdownFromAnchor(policy, settings.currentValue);
  if (drawdown !== null && drawdown <= policy.allStopDrawdown) return 0;
  const weeklyRemaining = Math.max(0, policy.maxWeeklyBudget - (Number(settings.weeklySpent) || 0));
  return round2(Math.min(policy.maxDailyBudget, weeklyRemaining, Number(settings.requestedBudget) || policy.maxDailyBudget));
}

function bucketCanReceive(bucket, exposure, policy, currentValue) {
  if (!bucket || bucket === "CASH") return false;
  const drawdown = drawdownFromAnchor(policy, currentValue);
  if (drawdown !== null && drawdown <= policy.allStopDrawdown) return false;
  if (bucket === "GROWTH_TECH" && drawdown !== null && drawdown <= policy.growthStopDrawdown) return false;
  return Number(exposure[bucket] || 0) < Number(policy.targetBuckets[bucket] || 0);
}

function buildExecutionRoutes(options) {
  const settings = options || {};
  const policy = settings.policy || createAllocationPolicy();
  const exposure = settings.bucketExposure || {};
  const gaps = settings.targetGap || calculateTargetGap(exposure, policy);
  let remaining = Math.min(Number(settings.dailyBudget) || 0, policy.maxDailyBudget);
  if (remaining <= 0) return [];
  const heldCodes = new Set((settings.holdings || []).map(function (holding) { return holding.code; }));
  const portfolioFull = heldCodes.size >= policy.maxHoldingsBeforeApproval;
  const freshness = settings.freshnessByCode || {};
  const stability = settings.trackingStabilityByCode || {};
  const bucketOrder = Object.keys(gaps).filter(function (bucket) {
    return Number(gaps[bucket]) > 0 && bucketCanReceive(bucket, exposure, policy, settings.currentValue);
  }).sort(function (left, right) { return Number(gaps[right]) - Number(gaps[left]); });
  const routes = [];

  bucketOrder.forEach(function (bucket) {
    if (remaining <= 0) return;
    const currentValue = Number(settings.currentValue);
    const targetWeight = Number(policy.targetBuckets[bucket]);
    const currentWeight = Number(exposure[bucket] || 0);
    let bucketRemaining = Infinity;
    if (currentValue > 0 && targetWeight > 0 && targetWeight < 1) {
      bucketRemaining = Math.max(0, (targetWeight - currentWeight) * currentValue / (1 - targetWeight));
    }
    const wrappers = (settings.funds || []).filter(function (fund) {
      if (!isCoreIndexGroup(fund.indexGroup)) return false;
      if ((fund.riskBucket || bucketForIndexGroup(fund.indexGroup)) !== bucket) return false;
      if (fund.status !== "active" || Number(fund.dailyLimit) <= 0) return false;
      if (Number(freshness[fund.code]) > policy.maxFreshnessLag) return false;
      if (portfolioFull && !heldCodes.has(fund.code) && !settings.approvedNewFundCodes?.includes(fund.code)) return false;
      return true;
    }).sort(function (left, right) {
      return (Number(freshness[left.code]) - Number(freshness[right.code])) ||
        (Number(stability[left.code] ?? Infinity) - Number(stability[right.code] ?? Infinity)) ||
        ((Number(left.feeRate) + Number(left.custodyFee || 0)) - (Number(right.feeRate) + Number(right.custodyFee || 0))) ||
        (Number(right.dailyLimit) - Number(left.dailyLimit)) || left.code.localeCompare(right.code);
    });
    wrappers.forEach(function (fund) {
      if (remaining <= 0 || bucketRemaining <= 0) return;
      const minimum = Number(fund.minPurchase) || 10;
      const amount = Math.min(remaining, bucketRemaining, Number(fund.dailyLimit) || 0);
      if (amount < minimum) return;
      routes.push({
        bucket: bucket,
        indexGroup: fund.indexGroup,
        exposureKey: bucket + ":" + fund.indexGroup,
        code: fund.code,
        amount: round2(amount),
        reason: "目标桶低配；按数据新鲜度、同组跟踪稳定度、费率和限购额度路由"
      });
      remaining = round2(remaining - amount);
      bucketRemaining = round2(bucketRemaining - amount);
    });
  });
  return routes;
}

module.exports = {
  TARGET_BUCKETS: TARGET_BUCKETS,
  RISK_PROFILES: RISK_PROFILES,
  normalizeRiskProfile: normalizeRiskProfile,
  INDEX_GROUP_BUCKETS: INDEX_GROUP_BUCKETS,
  CORE_INDEX_GROUPS: CORE_INDEX_GROUPS,
  isCoreIndexGroup: isCoreIndexGroup,
  createAllocationPolicy: createAllocationPolicy,
  bucketForIndexGroup: bucketForIndexGroup,
  calculateHoldingValuation: calculateHoldingValuation,
  calculateBucketExposure: calculateBucketExposure,
  calculateTargetGap: calculateTargetGap,
  drawdownFromAnchor: drawdownFromAnchor,
  allowedBudget: allowedBudget,
  bucketCanReceive: bucketCanReceive,
  buildExecutionRoutes: buildExecutionRoutes
};
