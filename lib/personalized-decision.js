(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.QdiiPersonalizedDecision = api;
}(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

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
    JAPAN: "NON_US", EUROPE: "NON_US", APAC: "NON_US", EMERGING: "NON_US", VIETNAM: "NON_US",
    HK: "NON_US", GLOBAL: "NON_US",
    GOLD: "DEFENSIVE", HEALTHCARE: "DEFENSIVE", GLOBAL_MEDICAL: "DEFENSIVE", US_REIT: "DEFENSIVE",
    REIT: "DEFENSIVE", GLOBAL_REIT: "DEFENSIVE", OIL: "DEFENSIVE", COMMODITY: "DEFENSIVE"
  });

  const DEFAULT_POLICY = Object.freeze({
    maxFundWeight: 0.20,
    maxIndexGroupWeight: 0.35,
    maxDailyBudget: 50,
    maxWeeklyBudget: 250,
    tacticalDailyBudget: 20,
    tacticalWeeklyBudget: 100,
    tacticalHotDailyBudget: 10,
    tacticalOverheatThreshold: 75,
    allStopDrawdown: -0.10,
    growthStopDrawdown: -0.075,
    maxFreshnessLag: 2
  });

  function round(value, digits) {
    const factor = Math.pow(10, digits === undefined ? 4 : digits);
    return Math.round((Number(value) || 0) * factor) / factor;
  }

  function weekStart(dateString) {
    const date = new Date(String(dateString) + "T00:00:00Z");
    const day = date.getUTCDay();
    date.setUTCDate(date.getUTCDate() - (day === 0 ? 6 : day - 1));
    return date.toISOString().slice(0, 10);
  }

  function bucketForFund(fund) {
    if (!fund) return null;
    return fund.riskBucket || INDEX_GROUP_BUCKETS[fund.indexGroup] || null;
  }

  function derivePortfolio(ledger) {
    const holdings = {};
    ((ledger && ledger.transactions) || []).forEach(function (transaction) {
      const code = String(transaction.code || "");
      if (!code) return;
      const type = String(transaction.type || "BUY").toUpperCase();
      const sign = type === "SELL" ? -1 : 1;
      if (!holdings[code]) holdings[code] = { code: code, buys: [], totalAmount: 0, totalShares: 0 };
      const row = holdings[code];
      const amount = sign * (Number(transaction.amount) || 0);
      const shares = sign * (Number(transaction.shares) || 0);
      row.totalAmount = round(row.totalAmount + amount, 8);
      row.totalShares = round(row.totalShares + shares, 8);
      row.buys.push({
        id: transaction.id,
        type: type,
        date: transaction.tradeDate || transaction.date,
        settleDate: transaction.settleDate || null,
        amount: amount,
        nav: Number(transaction.nav) || 0,
        shares: shares
      });
    });
    return {
      holdings: Object.values(holdings).filter(function (holding) {
        return holding.totalShares > 0 || holding.totalAmount > 0;
      })
    };
  }

  function latestNav(navCache, code) {
    const rows = (navCache && navCache[code]) || [];
    if (!Array.isArray(rows) || rows.length === 0) return null;
    return rows[rows.length - 1];
  }

  function holdingValue(holding, navCache) {
    if (Number.isFinite(Number(holding.currentValue))) return Math.max(0, Number(holding.currentValue));
    const latest = latestNav(navCache, holding.code);
    if (Number.isFinite(Number(holding.totalShares)) && Number(holding.totalShares) > 0 && latest && Number(latest.nav) > 0) {
      const pending = (holding.buys || []).reduce(function (sum, buy) {
        return sum + (!(Math.abs(Number(buy.shares)) > 0) ? Number(buy.amount) || 0 : 0);
      }, 0);
      return Math.max(0, Number(holding.totalShares) * Number(latest.nav) + pending);
    }
    return Math.max(0, (holding.buys || []).reduce(function (sum, buy) {
      const shares = Number(buy.shares) || 0;
      if (latest && Number(latest.nav) > 0 && shares !== 0) return sum + shares * Number(latest.nav);
      if (latest && Number(latest.nav) > 0 && Number(buy.nav) > 0) {
        return sum + (Number(buy.amount) || 0) * Number(latest.nav) / Number(buy.nav);
      }
      return sum + (Number(buy.amount) || 0);
    }, 0));
  }

  function portfolioMetrics(portfolio, funds, navCache, cashBalance) {
    const fundMap = {};
    (funds || []).forEach(function (fund) { fundMap[fund.code] = fund; });
    const values = { US_BROAD: 0, GROWTH_TECH: 0, NON_US: 0, DEFENSIVE: 0, CASH: Math.max(0, Number(cashBalance) || 0), UNKNOWN: 0 };
    const holdingValues = {};
    const groupValues = {};
    const unknownHoldings = [];
    ((portfolio && portfolio.holdings) || []).forEach(function (holding) {
      const fund = fundMap[holding.code];
      const value = holdingValue(holding, navCache);
      const bucket = bucketForFund(fund);
      holdingValues[holding.code] = value;
      if (!fund || !bucket) unknownHoldings.push(holding.code);
      values[bucket || "UNKNOWN"] += value;
      if (fund) groupValues[fund.indexGroup || fund.code] = (groupValues[fund.indexGroup || fund.code] || 0) + value;
    });
    const investedValue = Object.keys(values).filter(function (key) { return key !== "CASH"; })
      .reduce(function (sum, key) { return sum + values[key]; }, 0);
    const totalValue = investedValue + values.CASH;
    const exposure = {};
    Object.keys(values).forEach(function (key) { exposure[key] = totalValue > 0 ? round(values[key] / totalValue, 4) : 0; });
    return {
      values: values,
      exposure: exposure,
      holdingValues: holdingValues,
      groupValues: groupValues,
      investedValue: round(investedValue, 2),
      totalValue: round(totalValue, 2),
      unknownHoldings: Array.from(new Set(unknownHoldings))
    };
  }

  function weeklySpent(ledger, asOf) {
    const start = weekStart(asOf);
    return round(((ledger && ledger.transactions) || []).reduce(function (sum, transaction) {
      const date = String(transaction.tradeDate || transaction.date || "");
      if (String(transaction.type || "BUY").toUpperCase() !== "BUY" || date < start || date > asOf) return sum;
      return sum + (Number(transaction.amount) || 0);
    }, 0), 2);
  }

  function targetGaps(exposure) {
    const result = {};
    Object.keys(TARGET_BUCKETS).forEach(function (bucket) {
      result[bucket] = round(TARGET_BUCKETS[bucket] - Number(exposure[bucket] || 0), 4);
    });
    return result;
  }

  function capacityForWeight(current, total, limit) {
    if (!(limit > 0 && limit < 1)) return Infinity;
    return Math.max(0, (limit * total - current) / (1 - limit));
  }

  function buildRoutes(input) {
    const settings = input || {};
    const policy = settings.policy;
    const tactical = settings.mode === "TACTICAL_PAUSE";
    const tacticalBuckets = settings.allowTacticalGrowth === true
      ? ["US_BROAD", "GROWTH_TECH", "NON_US", "DEFENSIVE"]
      : ["US_BROAD", "NON_US", "DEFENSIVE"];
    const allowedBuckets = new Set(tactical ? tacticalBuckets : ["US_BROAD", "GROWTH_TECH", "NON_US", "DEFENSIVE"]);
    const heldCodes = new Set(((settings.portfolio && settings.portfolio.holdings) || []).map(function (holding) { return holding.code; }));
    const fundMap = {};
    (settings.funds || []).forEach(function (fund) { fundMap[fund.code] = fund; });
    let remaining = Number(settings.budget) || 0;
    const routes = [];
    const bucketOrder = Object.keys(settings.targetGap).filter(function (bucket) {
      if (bucket === "GROWTH_TECH" && settings.growthBlocked) return false;
      return allowedBuckets.has(bucket) && Number(settings.targetGap[bucket]) > 0;
    }).sort(function (left, right) { return Number(settings.targetGap[right]) - Number(settings.targetGap[left]); });

    bucketOrder.forEach(function (bucket) {
      if (remaining <= 0) return;
      const wrappers = Array.from(heldCodes).map(function (code) { return fundMap[code]; }).filter(function (fund) {
        if (!fund || bucketForFund(fund) !== bucket || fund.status !== "active") return false;
        if (!(Number(fund.dailyLimit) > 0)) return false;
        return !!latestNav(settings.navCache, fund.code);
      }).sort(function (left, right) {
        return ((Number(left.feeRate) || 0) + (Number(left.custodyFee) || 0)) -
          ((Number(right.feeRate) || 0) + (Number(right.custodyFee) || 0)) ||
          Number(right.dailyLimit) - Number(left.dailyLimit) || String(left.code).localeCompare(String(right.code));
      });
      wrappers.forEach(function (fund) {
        if (remaining <= 0) return;
        const currentFund = Number(settings.metrics.holdingValues[fund.code]) || 0;
        const currentGroup = Number(settings.metrics.groupValues[fund.indexGroup || fund.code]) || 0;
        const fundCapacity = capacityForWeight(currentFund, settings.metrics.totalValue, policy.maxFundWeight);
        const groupCapacity = capacityForWeight(currentGroup, settings.metrics.totalValue, policy.maxIndexGroupWeight);
        const bucketCapacity = Math.max(0, Number(settings.targetGap[bucket]) * settings.metrics.totalValue);
        const amount = Math.min(remaining, Number(fund.dailyLimit) || 0, fundCapacity, groupCapacity, bucketCapacity);
        const minimum = Number(fund.minPurchase) || 10;
        if (amount < minimum) return;
        const roundedAmount = round(amount, 2);
        routes.push({
          bucket: bucket,
          indexGroup: fund.indexGroup,
          exposureKey: bucket + ":" + fund.indexGroup,
          code: fund.code,
          name: fund.name || fund.code,
          amount: roundedAmount,
          reason: tactical ? "战术暂停：仅向低配核心桶做小额定投" : "通过验收：按目标缺口和费率路由"
        });
        remaining = round(remaining - roundedAmount, 2);
      });
    });
    return routes;
  }

  function hardPausePlan(base, details, reasons) {
    return Object.assign({}, base, details, {
      action: "HARD_PAUSE",
      pauseReasons: Array.from(new Set(reasons)),
      budget: 0,
      executionRoutes: [],
      ranked: (base.ranked || []).map(function (candidate) { return Object.assign({}, candidate, { proposedAmount: 0 }); }),
      confidence: "LOW",
      personalized: true
    });
  }

  function personalizePlan(input) {
    const settings = input || {};
    const base = settings.basePlan || {};
    const policy = Object.assign({}, DEFAULT_POLICY, settings.policy || {});
    const ledger = settings.ledger;
    const portfolio = settings.portfolio || (ledger ? derivePortfolio(ledger) : { holdings: [] });
    const decisionState = settings.decisionState || {};
    const asOf = settings.asOf || base.date || new Date().toISOString().slice(0, 10);
    const metrics = portfolioMetrics(portfolio, settings.funds || [], settings.navCache || {}, decisionState.cashBalance);
    const gaps = targetGaps(metrics.exposure);
    const spent = weeklySpent(ledger, asOf);
    const anchor = Number(decisionState.riskAnchorValue);
    const anchorDrawdown = anchor > 0 ? metrics.investedValue / anchor - 1 : null;
    const marketTemperature = settings.marketTemperature || base.marketTemperature || {};
    const tacticalOverheat = Number(marketTemperature.temperature) >= Number(policy.tacticalOverheatThreshold);
    const details = {
      date: asOf,
      schemaVersion: "PersonalizedRecommendationPlanV1",
      strategyVersion: base.strategyVersion || "allocation-v2.1-balanced",
      syncRevision: ledger ? Number(ledger.revision || 0) : 0,
      decisionRevision: Number(decisionState.revision || 0),
      riskAnchorValue: anchor > 0 ? round(anchor, 2) : null,
      riskAnchorDrawdown: anchorDrawdown === null ? null : round(anchorDrawdown, 4),
      weeklySpent: spent,
      bucketExposure: metrics.exposure,
      targetGap: gaps,
      portfolioRisk: {
        holdingCount: ((portfolio && portfolio.holdings) || []).length,
        currentValue: metrics.investedValue,
        totalWithCash: metrics.totalValue,
        unknownHoldings: metrics.unknownHoldings
      },
      budgetPolicy: {
        maxDailyBudget: policy.maxDailyBudget,
        maxWeeklyBudget: policy.maxWeeklyBudget,
        tacticalDailyBudget: policy.tacticalDailyBudget,
        tacticalHotDailyBudget: policy.tacticalHotDailyBudget,
        tacticalWeeklyBudget: policy.tacticalWeeklyBudget,
        weeklySpent: spent,
        weeklyManualBuysIncluded: true,
        marketTemperature: Number.isFinite(Number(marketTemperature.temperature)) ? Number(marketTemperature.temperature) : null,
        overheatReduced: false
      }
    };
    const hardReasons = [];
    if (!ledger || Number(ledger.revision) < 1) hardReasons.push("SYNC_REQUIRED");
    if (settings.readOnly === true) hardReasons.push("OFFLINE_READ_ONLY");
    if (((portfolio && portfolio.holdings) || []).length === 0) hardReasons.push("EMPTY_PORTFOLIO");
    if (!(anchor > 0)) hardReasons.push("RISK_ANCHOR_MISSING");
    if (ledger && Number(decisionState.riskAnchorLedgerRevision || 0) > Number(ledger.revision || 0)) hardReasons.push("RISK_ANCHOR_LEDGER_MISMATCH");
    if (metrics.unknownHoldings.length > 0) hardReasons.push("UNKNOWN_HOLDINGS");
    if (!base.dataFreshness || base.dataFreshness.status !== "FRESH" || Number(base.dataFreshness.maxTradingDayLag) > policy.maxFreshnessLag) {
      hardReasons.push("DATA_STALE");
    }
    if (anchorDrawdown !== null && anchorDrawdown <= policy.allStopDrawdown) hardReasons.push("RISK_ANCHOR_DRAWDOWN_10");
    if (hardReasons.length > 0) return hardPausePlan(base, details, hardReasons);

    const acceptancePassed = !!(base.liveAcceptance && base.liveAcceptance.passed);
    const signalHealthy = base.signalHealth && base.signalHealth.status === "HEALTHY";
    const mode = base.action === "BUY" && acceptancePassed && signalHealthy ? "BUY" : "TACTICAL_PAUSE";
    const weeklyLimit = mode === "BUY" ? policy.maxWeeklyBudget : policy.tacticalWeeklyBudget;
    const dailyLimit = mode === "BUY" ? policy.maxDailyBudget : (tacticalOverheat ? policy.tacticalHotDailyBudget : policy.tacticalDailyBudget);
    const requestedBudget = Math.max(0, Math.min(dailyLimit, weeklyLimit - spent));
    const growthBlocked = anchorDrawdown !== null && anchorDrawdown <= policy.growthStopDrawdown;
    const allowTacticalGrowth = mode === "TACTICAL_PAUSE" && !growthBlocked && Number(gaps.GROWTH_TECH) > 0;
    const routes = buildRoutes({
      mode: mode,
      budget: requestedBudget,
      policy: policy,
      portfolio: portfolio,
      funds: settings.funds || [],
      navCache: settings.navCache || {},
      metrics: metrics,
      targetGap: gaps,
      growthBlocked: growthBlocked,
      allowTacticalGrowth: allowTacticalGrowth
    });
    const budget = round(routes.reduce(function (sum, route) { return sum + route.amount; }, 0), 2);
    const routeCandidates = routes.map(function (route) {
      return {
        code: route.code,
        name: route.name,
        indexGroup: route.indexGroup,
        score: null,
        marketScore: null,
        proposedAmount: route.amount,
        reason: route.reason,
        reasons: [route.reason],
        blockedBy: []
      };
    });
    const tacticalReasons = (base.pauseReasons || []).filter(function (reason) { return reason !== "LIVE_DISABLED"; });
    return Object.assign({}, base, details, {
      action: mode,
      pauseReasons: mode === "TACTICAL_PAUSE" ? Array.from(new Set(tacticalReasons.concat("TACTICAL_CORE_ONLY"))) : [],
      budget: budget,
      budgetPolicy: Object.assign({}, details.budgetPolicy, {
        dailyLimit: dailyLimit,
        weeklyLimit: weeklyLimit,
        weeklyRemaining: round(Math.max(0, weeklyLimit - spent), 2),
        requestedBudget: round(requestedBudget, 2),
        overheatReduced: mode === "TACTICAL_PAUSE" && tacticalOverheat
      }),
      executionRoutes: routes,
      ranked: routeCandidates.length ? routeCandidates : (base.ranked || []).map(function (candidate) {
        return Object.assign({}, candidate, { proposedAmount: 0 });
      }),
      confidence: mode === "BUY" ? "MEDIUM" : "LOW",
      personalized: true
    });
  }

  return {
    TARGET_BUCKETS: TARGET_BUCKETS,
    INDEX_GROUP_BUCKETS: INDEX_GROUP_BUCKETS,
    DEFAULT_POLICY: DEFAULT_POLICY,
    bucketForFund: bucketForFund,
    derivePortfolio: derivePortfolio,
    portfolioMetrics: portfolioMetrics,
    weeklySpent: weeklySpent,
    personalizePlan: personalizePlan
  };
}));
