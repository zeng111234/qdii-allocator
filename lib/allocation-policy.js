const { round2 } = require("./utils");

const TARGET_BUCKETS = Object.freeze({
  US_BROAD: 0.30,
  GROWTH_TECH: 0.25,
  NON_US: 0.25,
  DEFENSIVE: 0.10,
  CASH: 0.10
});

const INDEX_GROUP_BUCKETS = Object.freeze({
  SPX500: "US_BROAD", US_BROAD: "US_BROAD", DOW30: "US_BROAD", RUSSELL2000: "US_BROAD",
  NDX100: "GROWTH_TECH", GLOBAL_GROWTH: "GROWTH_TECH", GLOBAL_TECH: "GROWTH_TECH",
  GLOBAL_MFG: "GROWTH_TECH", NASDAQ_BIO: "GROWTH_TECH", EV: "GROWTH_TECH", GLOBAL_UPGRADE: "GROWTH_TECH",
  JAPAN: "NON_US", EUROPE: "NON_US", APAC: "NON_US", EMERGING: "NON_US", VIETNAM: "NON_US", HK: "NON_US", GLOBAL: "NON_US",
  GOLD: "DEFENSIVE", HEALTHCARE: "DEFENSIVE", GLOBAL_MEDICAL: "DEFENSIVE", US_REIT: "DEFENSIVE", REIT: "DEFENSIVE",
  GLOBAL_REIT: "DEFENSIVE", OIL: "DEFENSIVE", COMMODITY: "DEFENSIVE"
});

function createAllocationPolicy(overrides) {
  const policy = Object.assign({
    schemaVersion: "AllocationPolicyV1",
    targetBuckets: Object.assign({}, TARGET_BUCKETS),
    maxFundWeight: 0.20,
    maxDailyBudget: 50,
    maxWeeklyBudget: 250,
    maxHoldingsBeforeApproval: 21,
    riskAnchorValue: null,
    growthStopDrawdown: -0.075,
    allStopDrawdown: -0.10,
    maxFreshnessLag: 2,
    allowAutomaticSell: false
  }, overrides || {});
  policy.targetBuckets = Object.assign({}, TARGET_BUCKETS, (overrides && overrides.targetBuckets) || {});
  return policy;
}

function bucketForIndexGroup(indexGroup) {
  return INDEX_GROUP_BUCKETS[indexGroup] || null;
}

function holdingAmount(holding) {
  if (Number.isFinite(Number(holding.currentValue))) return Number(holding.currentValue);
  if (Number.isFinite(Number(holding.totalAmount))) return Number(holding.totalAmount);
  return (holding.buys || []).reduce(function (sum, buy) { return sum + (Number(buy.amount) || 0); }, 0);
}

function calculateBucketExposure(holdings, funds, cash) {
  const fundMap = {};
  (funds || []).forEach(function (fund) { fundMap[fund.code] = fund; });
  const values = { US_BROAD: 0, GROWTH_TECH: 0, NON_US: 0, DEFENSIVE: 0, CASH: Number(cash) || 0, UNKNOWN: 0 };
  (holdings || []).forEach(function (holding) {
    const fund = fundMap[holding.code] || holding;
    const bucket = fund.riskBucket || bucketForIndexGroup(fund.indexGroup);
    values[bucket || "UNKNOWN"] += holdingAmount(holding);
  });
  const total = Object.values(values).reduce(function (sum, value) { return sum + value; }, 0);
  const exposure = {};
  Object.keys(values).forEach(function (bucket) { exposure[bucket] = total > 0 ? values[bucket] / total : 0; });
  return { values: values, exposure: exposure, totalValue: total };
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
  if (!(anchor > 0) || !Number.isFinite(Number(currentValue))) return null;
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
    const wrappers = (settings.funds || []).filter(function (fund) {
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
      if (remaining <= 0) return;
      const minimum = Number(fund.minPurchase) || 10;
      const amount = Math.min(remaining, Number(fund.dailyLimit) || 0);
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
    });
  });
  return routes;
}

module.exports = {
  TARGET_BUCKETS: TARGET_BUCKETS,
  INDEX_GROUP_BUCKETS: INDEX_GROUP_BUCKETS,
  createAllocationPolicy: createAllocationPolicy,
  bucketForIndexGroup: bucketForIndexGroup,
  calculateBucketExposure: calculateBucketExposure,
  calculateTargetGap: calculateTargetGap,
  drawdownFromAnchor: drawdownFromAnchor,
  allowedBudget: allowedBudget,
  bucketCanReceive: bucketCanReceive,
  buildExecutionRoutes: buildExecutionRoutes
};
