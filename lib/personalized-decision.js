(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.QdiiPersonalizedDecision = api;
}(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const serverTradingCalendar = typeof module === "object" && module.exports && typeof require === "function"
    ? require("./trading-calendar")
    : null;

  // This allocator executes target-gap routes from the user's real holdings.
  // It is intentionally a different strategy from the market-ranking research
  // engine; evidence for one must never unlock the other.
  const PERSONALIZED_STRATEGY_ID = "personalized-target-allocation-v2.1";

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
      maxIndexGroupWeight: 0.35,
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
      maxIndexGroupWeight: 0.45,
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
    JAPAN: "NON_US", EUROPE: "NON_US", APAC: "NON_US", EMERGING: "NON_US", VIETNAM: "NON_US",
    HK: "NON_US", GLOBAL: "NON_US",
    GOLD: "DEFENSIVE", HEALTHCARE: "DEFENSIVE", GLOBAL_MEDICAL: "DEFENSIVE", US_REIT: "DEFENSIVE",
    REIT: "DEFENSIVE", GLOBAL_REIT: "DEFENSIVE", OIL: "DEFENSIVE", COMMODITY: "DEFENSIVE"
  });

  const CORE_INDEX_GROUPS = Object.freeze([
    "SPX500", "NDX100", "DOW30", "RUSSELL2000",
    "EUROPE", "JAPAN", "GOLD", "HEALTHCARE", "GLOBAL_MEDICAL",
    "US_REIT", "REIT", "GLOBAL_REIT"
  ]);
  const CORE_INDEX_GROUP_SET = new Set(CORE_INDEX_GROUPS);

  function isCoreIndexGroup(indexGroup) {
    return CORE_INDEX_GROUP_SET.has(indexGroup);
  }

  const DEFAULT_POLICY = Object.freeze({
    maxFundWeight: 0.20,
    maxIndexGroupWeight: 0.35,
    maxDailyBudget: 50,
    maxWeeklyBudget: 250,
    tacticalDailyBudget: 20,
    tacticalBaselineDailyBudget: 10,
    tacticalWeeklyBudget: 50,
    tacticalHotDailyBudget: 10,
    strategicDailyBudget: 20,
    strategicWeeklyBudget: 100,
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
      if (!holdings[code]) holdings[code] = {
        code: code, buys: [], totalAmount: 0, totalShares: 0, pendingBuys: [], pendingAmount: 0
      };
      const row = holdings[code];
      const amount = sign * (Number(transaction.amount) || 0);
      const shares = sign * (Number(transaction.shares) || 0);
      row.totalAmount = round(row.totalAmount + amount, 8);
      row.totalShares = round(row.totalShares + shares, 8);
      const buy = {
        id: transaction.id,
        type: type,
        date: transaction.tradeDate || transaction.date,
        settleDate: transaction.settleDate || null,
        amount: amount,
        nav: Number(transaction.nav) || 0,
        shares: shares
      };
      row.buys.push(buy);
      if (type === "BUY" && amount > 0 && shares === 0) {
        row.pendingBuys.push(buy);
        row.pendingAmount = round(row.pendingAmount + amount, 8);
      }
    });
    const allHoldings = Object.values(holdings);
    const pendingHoldings = allHoldings.filter(function (holding) {
      return holding.pendingAmount > 0;
    }).map(function (holding) {
      return { code: holding.code, totalAmount: holding.pendingAmount, buys: holding.pendingBuys };
    });
    return {
      holdings: allHoldings.filter(function (holding) {
        return holding.totalShares > 0 || holding.totalAmount > 0;
      }),
      pendingHoldings: pendingHoldings,
      pendingInvested: round(pendingHoldings.reduce(function (sum, holding) {
        return sum + holding.totalAmount;
      }, 0), 8)
    };
  }

  function latestNav(navCache, code) {
    const rows = (navCache && navCache[code]) || [];
    if (!Array.isArray(rows) || rows.length === 0) return null;
    return rows[rows.length - 1];
  }

  function isIsoDate(value) {
    const date = String(value || "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
    const parsed = new Date(date + "T00:00:00Z");
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
  }

  function tradingDayLag(latestDate, asOf) {
    if (!isIsoDate(latestDate) || !isIsoDate(asOf) || latestDate > asOf) return Infinity;
    const cursor = new Date(latestDate + "T00:00:00Z");
    const end = new Date(asOf + "T00:00:00Z");
    let lag = 0;
    while (cursor < end) {
      cursor.setUTCDate(cursor.getUTCDate() + 1);
      const date = cursor.toISOString().slice(0, 10);
      if (serverTradingCalendar ? serverTradingCalendar.isTradingDay(date) : browserTradingDay(date)) lag++;
    }
    return lag;
  }

  function browserTradingDay(date) {
    const parsed = new Date(date + "T00:00:00Z");
    const day = parsed.getUTCDay();
    if (day === 0 || day === 6) return false;
    const holidays = typeof globalThis !== "undefined" && Array.isArray(globalThis.tradingHolidays)
      ? globalThis.tradingHolidays
      : [];
    return holidays.indexOf(date) < 0;
  }

  function navStatus(navCache, code, asOf, maxFreshnessLag) {
    const row = latestNav(navCache, code);
    if (!row) return { row: null, usable: false, fresh: false, lag: Infinity, reason: "MISSING" };
    if (!(Number.isFinite(Number(row.nav)) && Number(row.nav) > 0) || !isIsoDate(row.date)) {
      return { row: row, usable: false, fresh: false, lag: Infinity, reason: "INVALID" };
    }
    if (asOf && String(row.date) > String(asOf)) {
      return { row: row, usable: false, fresh: false, lag: Infinity, reason: "FUTURE" };
    }
    const lag = asOf ? tradingDayLag(String(row.date), String(asOf)) : 0;
    if (!Number.isFinite(lag)) return { row: row, usable: false, fresh: false, lag: lag, reason: "INVALID" };
    if (Number.isFinite(Number(maxFreshnessLag)) && lag > Number(maxFreshnessLag)) {
      return { row: row, usable: true, fresh: false, lag: lag, reason: "STALE" };
    }
    return { row: row, usable: true, fresh: true, lag: lag, reason: null };
  }

  function confirmedShares(holding) {
    if (holding && holding.totalShares !== null && holding.totalShares !== undefined && holding.totalShares !== "" &&
        Number.isFinite(Number(holding.totalShares))) return Math.max(0, Number(holding.totalShares));
    return Math.max(0, ((holding && holding.buys) || []).reduce(function (sum, buy) {
      return sum + (Number(buy.shares) || 0);
    }, 0));
  }

  function hasConfirmedPosition(holding) {
    if (confirmedShares(holding) > 0) return true;
    return holding && holding.currentValue !== null && holding.currentValue !== undefined &&
      Number.isFinite(Number(holding.currentValue)) && Number(holding.currentValue) > 0;
  }

  function holdingValue(holding, navRow) {
    if (holding.currentValue !== null && holding.currentValue !== undefined && holding.currentValue !== "" &&
        Number.isFinite(Number(holding.currentValue))) return Math.max(0, Number(holding.currentValue));
    const shares = confirmedShares(holding);
    if (!(shares > 0)) return 0;
    if (!navRow || !(Number(navRow.nav) > 0)) return null;
    return Math.max(0, shares * Number(navRow.nav));
  }

  function portfolioMetrics(portfolio, funds, navCache, cashBalance, asOf, maxFreshnessLag) {
    const fundMap = {};
    (funds || []).forEach(function (fund) { fundMap[fund.code] = fund; });
    const values = { US_BROAD: 0, GROWTH_TECH: 0, NON_US: 0, DEFENSIVE: 0, CASH: Math.max(0, Number(cashBalance) || 0), UNKNOWN: 0 };
    const holdingValues = {};
    const groupValues = {};
    const unknownHoldings = [];
    const unvaluedHoldings = [];
    const navIssues = [];
    ((portfolio && portfolio.holdings) || []).forEach(function (holding) {
      const fund = fundMap[holding.code];
      const confirmed = hasConfirmedPosition(holding);
      const status = confirmed ? navStatus(navCache, holding.code, asOf, maxFreshnessLag) : null;
      const value = holdingValue(holding, status && status.usable ? status.row : null);
      const bucket = bucketForFund(fund);
      holdingValues[holding.code] = value;
      if (confirmed && !status.fresh) {
        navIssues.push({ code: holding.code, reason: status.reason, lag: status.lag });
      }
      if (value === null) unvaluedHoldings.push(holding.code);
      if (!fund || !bucket) unknownHoldings.push(holding.code);
      const numericValue = value === null ? 0 : value;
      values[bucket || "UNKNOWN"] += numericValue;
      if (fund) groupValues[fund.indexGroup || fund.code] = (groupValues[fund.indexGroup || fund.code] || 0) + numericValue;
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
      unknownHoldings: Array.from(new Set(unknownHoldings)),
      unvaluedHoldings: Array.from(new Set(unvaluedHoldings)),
      navIssues: navIssues,
      valuationComplete: unvaluedHoldings.length === 0
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

  function netCashFlowSinceAnchor(ledger, decisionState) {
    const state = decisionState || {};
    const anchorIds = new Set(Array.isArray(state.riskAnchorTransactionIds) ? state.riskAnchorTransactionIds.map(String) : []);
    const anchorDate = String(state.riskAnchorAt || "").slice(0, 10);
    return round(((ledger && ledger.transactions) || []).reduce(function (sum, transaction) {
      const isPostAnchor = anchorIds.size > 0
        ? !anchorIds.has(String(transaction.id || ""))
        : (!!anchorDate && String(transaction.tradeDate || transaction.date || "") > anchorDate);
      if (!isPostAnchor) return sum;
      const amount = Number(transaction.amount) || 0;
      return sum + (String(transaction.type || "BUY").toUpperCase() === "SELL" ? -amount : amount);
    }, 0), 2);
  }

  function getRiskAnchorMetrics(ledger, decisionState, currentValue) {
    const anchor = Number(decisionState && decisionState.riskAnchorValue);
    if (!(anchor > 0)) return { value: null, netCashFlow: 0, adjustedValue: null, drawdown: null };
    const netCashFlow = netCashFlowSinceAnchor(ledger, decisionState);
    const adjustedValue = round(Math.max(0.01, anchor + netCashFlow), 2);
    const hasCurrentValue = currentValue !== null && currentValue !== undefined && currentValue !== "" && Number.isFinite(Number(currentValue));
    return {
      value: round(anchor, 2),
      netCashFlow: netCashFlow,
      adjustedValue: adjustedValue,
      drawdown: hasCurrentValue ? round(Number(currentValue) / adjustedValue - 1, 4) : null
    };
  }

  function dailyBuySpend(ledger, asOf) {
    const byFund = {};
    const total = ((ledger && ledger.transactions) || []).reduce(function (sum, transaction) {
      const date = String(transaction.tradeDate || transaction.date || "");
      if (String(transaction.type || "BUY").toUpperCase() !== "BUY" || date !== asOf) return sum;
      const amount = Number(transaction.amount) || 0;
      const code = String(transaction.code || "");
      if (code) byFund[code] = round((byFund[code] || 0) + amount, 2);
      return sum + amount;
    }, 0);
    return { total: round(total, 2), byFund: byFund };
  }

  function overduePendingCodes(portfolio, funds, asOf) {
    const fundMap = {};
    (funds || []).forEach(function (fund) { fundMap[fund.code] = fund; });
    return Array.from(new Set(((portfolio && portfolio.pendingHoldings) || []).filter(function (holding) {
      const settleDays = Math.max(1, Number(fundMap[holding.code] && fundMap[holding.code].settleDays) || 2);
      return (holding.buys || []).some(function (buy) {
        const tradeDate = String(buy.tradeDate || buy.date || "");
        return tradingDayLag(tradeDate, asOf) > settleDays;
      });
    }).map(function (holding) { return holding.code; })));
  }

  function targetGaps(exposure, targets) {
    const desired = targets || TARGET_BUCKETS;
    const result = {};
    Object.keys(desired).forEach(function (bucket) {
      result[bucket] = round(desired[bucket] - Number(exposure[bucket] || 0), 4);
    });
    return result;
  }

  function capacityForWeight(current, total, limit) {
    if (!(limit > 0 && limit < 1)) return Infinity;
    return Math.max(0, (limit * total - current) / (1 - limit));
  }

  function buildRouteDecision(input) {
    const settings = input || {};
    const policy = settings.policy;
    const tactical = settings.mode === "TACTICAL_PAUSE";
    const strategic = settings.mode === "STRATEGIC_DCA";
    const tacticalBuckets = ["US_BROAD"];
    const allowedBuckets = new Set(tactical ? tacticalBuckets : ["US_BROAD", "GROWTH_TECH", "NON_US", "DEFENSIVE"]);
    const heldCodes = new Set(((settings.portfolio && settings.portfolio.holdings) || []).filter(hasConfirmedPosition)
      .map(function (holding) { return holding.code; }));
    const fundMap = {};
    (settings.funds || []).forEach(function (fund) { fundMap[fund.code] = fund; });
    let remaining = Number(settings.budget) || 0;
    const routes = [];
    const plannedByBucket = {};
    const plannedByGroup = {};
    const plannedByFund = {};
    let plannedTotal = 0;
    const bucketOrder = Object.keys(settings.targetGap).filter(function (bucket) {
      if (bucket === "GROWTH_TECH" && settings.growthBlocked) return false;
      if (!allowedBuckets.has(bucket)) return false;
      return Number(settings.targetGap[bucket]) > 0;
    }).sort(function (left, right) { return Number(settings.targetGap[right]) - Number(settings.targetGap[left]); });
    const diagnostics = {
      requestedBudget: round(remaining, 2),
      allocatedBudget: 0,
      eligibleBuckets: bucketOrder.slice(),
      eligibleHeldChannelCount: 0,
      eligibleNewChannelCount: 0,
      blockReasons: []
    };

    bucketOrder.forEach(function (bucket) {
      if (remaining <= 0) return;
      const wrapperSource = Array.from(heldCodes).map(function (code) { return fundMap[code]; });
      const wrappers = wrapperSource.filter(function (fund) {
        if (!fund || bucketForFund(fund) !== bucket || fund.status !== "active") return false;
        if (tactical && fund.indexGroup !== "SPX500") return false;
        if (!isCoreIndexGroup(fund.indexGroup)) return false;
        if (!(Number(fund.dailyLimit) > 0)) return false;
        return navStatus(settings.navCache, fund.code, settings.asOf, policy.maxFreshnessLag).fresh;
      }).sort(function (left, right) {
        return ((Number(left.feeRate) || 0) + (Number(left.custodyFee) || 0)) -
          ((Number(right.feeRate) || 0) + (Number(right.custodyFee) || 0)) ||
          Number(right.dailyLimit) - Number(left.dailyLimit) || String(left.code).localeCompare(String(right.code));
      });
      diagnostics.eligibleHeldChannelCount += wrappers.filter(function (fund) { return heldCodes.has(fund.code); }).length;
      diagnostics.eligibleNewChannelCount += wrappers.filter(function (fund) { return !heldCodes.has(fund.code); }).length;
      wrappers.forEach(function (fund) {
        if (remaining <= 0) return;
        const group = fund.indexGroup || fund.code;
        const currentFund = Number(settings.metrics.holdingValues[fund.code]) || 0;
        const currentGroup = Number(settings.metrics.groupValues[group]) || 0;
        const fundPlanned = Number(plannedByFund[fund.code]) || 0;
        const groupPlanned = Number(plannedByGroup[group]) || 0;
        const bucketPlanned = Number(plannedByBucket[bucket]) || 0;
        const totalBeforeRoute = settings.metrics.totalValue + plannedTotal;
        const fundCapacity = capacityForWeight(currentFund + fundPlanned, totalBeforeRoute, policy.maxFundWeight);
        const groupCapacity = capacityForWeight(currentGroup + groupPlanned, totalBeforeRoute, policy.maxIndexGroupWeight);
        const targetWeight = Number(settings.targetBuckets && settings.targetBuckets[bucket]);
        const currentBucket = Number(settings.metrics.values[bucket]) || 0;
        const bucketCapacity = capacityForWeight(
          currentBucket + bucketPlanned,
          totalBeforeRoute,
          targetWeight
        );
        const alreadyBoughtToday = Number(settings.dailySpentByFund && settings.dailySpentByFund[fund.code]) || 0;
        const dailyCapacity = Math.max(0, (Number(fund.dailyLimit) || 0) - alreadyBoughtToday - fundPlanned);
        const amount = Math.min(remaining, dailyCapacity, fundCapacity, groupCapacity, bucketCapacity);
        const minimum = Number(fund.minPurchase) || 10;
        const roundedAmount = Math.floor((amount + 1e-9) * 100) / 100;
        if (roundedAmount < minimum) return;
        routes.push({
          bucket: bucket,
          indexGroup: fund.indexGroup,
          exposureKey: bucket + ":" + fund.indexGroup,
          code: fund.code,
          name: fund.name || fund.code,
          amount: roundedAmount,
          reason: tactical
            ? "标普500基准定投：主动策略未证明超额时回到低费率标普通道"
            : (strategic
              ? "进取型战略配置：只补核心指数低配；承担更高市场风险，不是择时超额"
              : "通过验收：按目标缺口和费率路由")
        });
        plannedByBucket[bucket] = round(bucketPlanned + roundedAmount, 2);
        plannedByGroup[group] = round(groupPlanned + roundedAmount, 2);
        plannedByFund[fund.code] = round(fundPlanned + roundedAmount, 2);
        plannedTotal = round(plannedTotal + roundedAmount, 2);
        remaining = round(remaining - roundedAmount, 2);
      });
    });
    diagnostics.allocatedBudget = round(routes.reduce(function (sum, route) { return sum + route.amount; }, 0), 2);
    if (diagnostics.requestedBudget > 0 && routes.length === 0) {
      diagnostics.blockReasons.push("NO_ELIGIBLE_CORE_ROUTE");
      if (bucketOrder.length === 0) diagnostics.blockReasons.push("NO_UNDERWEIGHT_CORE_BUCKET");
      else if (diagnostics.eligibleHeldChannelCount + diagnostics.eligibleNewChannelCount === 0) {
        diagnostics.blockReasons.push(tactical ? "NO_ELIGIBLE_BASELINE_CHANNEL" : "NO_ELIGIBLE_EXISTING_CHANNEL");
      }
      else diagnostics.blockReasons.push("CONCENTRATION_OR_MIN_PURCHASE_BLOCK");
    } else if (remaining > 0 && routes.length > 0) {
      diagnostics.blockReasons.push("PARTIAL_ROUTE_CAPACITY");
    }
    return { routes: routes, diagnostics: diagnostics };
  }

  function hardPausePlan(base, details, reasons) {
    const hasAnchorSetup = reasons.indexOf("RISK_ANCHOR_MISSING") >= 0;
    const hasRiskStop = reasons.some(function (reason) { return String(reason).indexOf("RISK_ANCHOR_DRAWDOWN_") === 0; });
    const decisionMode = hasRiskStop ? "RISK_STOP" : (hasAnchorSetup ? "ACTION_REQUIRED" : "DATA_BLOCKED");
    const blockedStage = hasRiskStop ? "RISK_DRAWDOWN_STOP" : (hasAnchorSetup ? "RISK_ANCHOR_SETUP" : "DATA_VALIDATION");
    return Object.assign({}, base, details, {
      action: "HARD_PAUSE",
      pauseReasons: Array.from(new Set(reasons)),
      budget: 0,
      decisionMode: decisionMode,
      blockedStage: blockedStage,
      routeDiagnostics: { requestedBudget: 0, allocatedBudget: 0, eligibleBuckets: [], eligibleHeldChannelCount: 0, eligibleNewChannelCount: 0, blockReasons: Array.from(new Set(reasons)) },
      executionRoutes: [],
      candidates: [],
      ranked: [],
      confidence: "LOW",
      personalized: true
    });
  }

  function personalizePlan(input) {
    const settings = input || {};
    const base = settings.basePlan || {};
    const ledger = settings.ledger;
    const portfolio = settings.portfolio || (ledger ? derivePortfolio(ledger) : { holdings: [] });
    const decisionState = settings.decisionState || {};
    const savedProfile = decisionState.riskProfile;
    const riskProfile = normalizeRiskProfile(savedProfile || settings.defaultRiskProfile);
    const profile = RISK_PROFILES[riskProfile];
    const policy = Object.assign({}, DEFAULT_POLICY, {
      maxFundWeight: profile.maxFundWeight,
      maxIndexGroupWeight: profile.maxIndexGroupWeight,
      growthStopDrawdown: profile.growthStopDrawdown,
      allStopDrawdown: profile.allStopDrawdown
    }, settings.policy || {});
    const targets = Object.assign({}, profile.targetBuckets, (settings.policy && settings.policy.targetBuckets) || {});
    const asOf = settings.asOf || base.date || new Date().toISOString().slice(0, 10);
    const metrics = portfolioMetrics(portfolio, settings.funds || [], settings.navCache || {}, decisionState.cashBalance, asOf, policy.maxFreshnessLag);
    const gaps = targetGaps(metrics.exposure, targets);
    const spent = weeklySpent(ledger, asOf);
    const dailySpend = dailyBuySpend(ledger, asOf);
    const overduePending = overduePendingCodes(portfolio, settings.funds || [], asOf);
    const anchorMetrics = getRiskAnchorMetrics(ledger, decisionState, metrics.valuationComplete ? metrics.investedValue : null);
    const anchor = anchorMetrics.value;
    const anchorDrawdown = anchorMetrics.drawdown;
    const marketTemperature = settings.marketTemperature || base.marketTemperature || {};
    const signalConfirmation = Object.assign({
      status: "INSUFFICIENT",
      fresh: false,
      reason: "新闻或外部信号覆盖不足"
    }, settings.signalConfirmation || {});
    const tacticalOverheat = Number(marketTemperature.temperature) >= Number(policy.tacticalOverheatThreshold);
    const details = {
      date: asOf,
      schemaVersion: "PersonalizedRecommendationPlanV2",
      strategyVersion: PERSONALIZED_STRATEGY_ID,
      syncRevision: ledger ? Number(ledger.revision || 0) : 0,
      decisionRevision: Number(decisionState.revision || 0),
      riskProfile: riskProfile,
      targetBuckets: targets,
      riskLimits: {
        maxFundWeight: policy.maxFundWeight,
        maxIndexGroupWeight: policy.maxIndexGroupWeight,
        growthStopDrawdown: policy.growthStopDrawdown,
        allStopDrawdown: policy.allStopDrawdown
      },
      riskAnchorValue: anchor,
      adjustedRiskAnchorValue: anchorMetrics.adjustedValue,
      riskAnchorNetCashFlow: anchorMetrics.netCashFlow,
      riskAnchorDrawdown: anchorDrawdown,
      weeklySpent: spent,
      dailySpent: dailySpend.total,
      dailySpentByFund: dailySpend.byFund,
      readOnly: settings.readOnly === true,
      bucketExposure: metrics.exposure,
      targetGap: gaps,
      portfolioRisk: {
        holdingCount: ((portfolio && portfolio.holdings) || []).length,
        currentValue: metrics.valuationComplete ? metrics.investedValue : null,
        valuedSubtotal: metrics.investedValue,
        totalWithCash: metrics.valuationComplete ? metrics.totalValue : null,
        unknownHoldings: metrics.unknownHoldings,
        unvaluedHoldings: metrics.unvaluedHoldings,
        navIssues: metrics.navIssues,
        pendingInvested: Number(portfolio && portfolio.pendingInvested) || 0,
        overduePendingCodes: overduePending,
        valuationComplete: metrics.valuationComplete
      },
      budgetPolicy: {
        maxDailyBudget: policy.maxDailyBudget,
        maxWeeklyBudget: policy.maxWeeklyBudget,
        tacticalDailyBudget: policy.tacticalDailyBudget,
        tacticalBaselineDailyBudget: policy.tacticalBaselineDailyBudget,
        tacticalHotDailyBudget: policy.tacticalHotDailyBudget,
        tacticalWeeklyBudget: policy.tacticalWeeklyBudget,
        signalConfirmation: signalConfirmation,
        weeklySpent: spent,
        dailySpent: dailySpend.total,
        weeklyManualBuysIncluded: true,
        marketTemperature: Number.isFinite(Number(marketTemperature.temperature)) ? Number(marketTemperature.temperature) : null,
        overheatReduced: false
      }
    };
    const hardReasons = [];
    if (!ledger || Number(ledger.revision) < 1) hardReasons.push("SYNC_REQUIRED");
    if (((portfolio && portfolio.holdings) || []).length === 0) hardReasons.push("EMPTY_PORTFOLIO");
    if (!(anchor > 0)) hardReasons.push("RISK_ANCHOR_MISSING");
    if (ledger && Number(decisionState.riskAnchorLedgerRevision || 0) > Number(ledger.revision || 0)) hardReasons.push("RISK_ANCHOR_LEDGER_MISMATCH");
    if (metrics.unknownHoldings.length > 0) hardReasons.push("UNKNOWN_HOLDINGS");
    metrics.navIssues.forEach(function (issue) {
      hardReasons.push("HOLDING_NAV_" + issue.reason + ":" + issue.code);
    });
    overduePending.forEach(function (code) {
      hardReasons.push("PENDING_RECONCILIATION_OVERDUE:" + code);
    });
    if (!base.dataFreshness || base.dataFreshness.status !== "FRESH" || Number(base.dataFreshness.maxTradingDayLag) > policy.maxFreshnessLag) {
      hardReasons.push("DATA_STALE");
    }
    if (anchorDrawdown !== null && anchorDrawdown <= policy.allStopDrawdown) {
      hardReasons.push(riskProfile === "AGGRESSIVE" ? "RISK_ANCHOR_DRAWDOWN_15" : "RISK_ANCHOR_DRAWDOWN_10");
    }
    if (hardReasons.length > 0) return hardPausePlan(base, details, hardReasons);

    const acceptancePassed = !!(base.liveAcceptance && base.liveAcceptance.passed);
    const acceptanceStrategyId = String(base.liveAcceptance && base.liveAcceptance.metrics &&
      base.liveAcceptance.metrics.strategyId || "");
    const executionEvidenceMatches = acceptanceStrategyId === PERSONALIZED_STRATEGY_ID;
    const signalHealthy = base.signalHealth && base.signalHealth.status === "HEALTHY";
    const activePassed = base.action === "BUY" && acceptancePassed && executionEvidenceMatches && signalHealthy;
    const mode = activePassed ? "BUY" : (riskProfile === "AGGRESSIVE" ? "STRATEGIC_DCA" : "TACTICAL_PAUSE");
    const weeklyLimit = mode === "BUY" ? policy.maxWeeklyBudget :
      (mode === "STRATEGIC_DCA" ? policy.strategicWeeklyBudget : policy.tacticalWeeklyBudget);
    const tacticalConfirmed = signalConfirmation.status === "CONFIRMED" && signalConfirmation.fresh === true;
    const dailyLimit = mode === "BUY" ? policy.maxDailyBudget :
      (mode === "STRATEGIC_DCA" ? policy.strategicDailyBudget : (tacticalOverheat ? policy.tacticalHotDailyBudget :
        (tacticalConfirmed ? policy.tacticalDailyBudget : policy.tacticalBaselineDailyBudget)));
    const dailyRemaining = Math.max(0, dailyLimit - dailySpend.total);
    const requestedBudget = Math.max(0, Math.min(dailyRemaining, weeklyLimit - spent));
    const growthBlocked = anchorDrawdown !== null && anchorDrawdown <= policy.growthStopDrawdown;
    const routeDecision = buildRouteDecision({
      mode: mode,
      budget: requestedBudget,
      policy: policy,
      portfolio: portfolio,
      funds: settings.funds || [],
      navCache: settings.navCache || {},
      metrics: metrics,
      targetGap: gaps,
      targetBuckets: targets,
      growthBlocked: growthBlocked,
      dailySpentByFund: dailySpend.byFund,
      asOf: asOf
    });
    const routes = routeDecision.routes;
    const budget = round(routes.reduce(function (sum, route) { return sum + route.amount; }, 0), 2);
    const routeDiagnostics = Object.assign({}, routeDecision.diagnostics, {
      requestedBudget: round(requestedBudget, 2),
      allocatedBudget: budget,
      remainingBudget: round(Math.max(0, requestedBudget - budget), 2)
    });
    if (requestedBudget <= 0) {
      const exhaustedReasons = [];
      if (dailyRemaining <= 0) exhaustedReasons.push("DAILY_BUDGET_EXHAUSTED");
      if (weeklyLimit - spent <= 0) exhaustedReasons.push("WEEKLY_BUDGET_EXHAUSTED");
      routeDiagnostics.blockReasons = exhaustedReasons.length > 0 ? exhaustedReasons : ["BUDGET_EXHAUSTED"];
    }
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
    if (acceptancePassed && !executionEvidenceMatches) tacticalReasons.push("EXECUTION_STRATEGY_EVIDENCE_MISMATCH");
    const strategicReasons = tacticalReasons.concat("ALPHA_GATE_NOT_PASSED", "AGGRESSIVE_BETA_NOT_ALPHA");
    return Object.assign({}, base, details, {
      action: mode,
      decisionMode: mode === "BUY" ? "NORMAL_BUY" : (mode === "STRATEGIC_DCA" ? "AGGRESSIVE_BETA_DCA" : "BASELINE_DCA"),
      recommendationBasis: mode === "BUY" ? "LIVE_ACCEPTANCE_AND_TARGET_ALLOCATION" :
        (mode === "STRATEGIC_DCA" ? "AGGRESSIVE_TARGET_ALLOCATION" : "SP500_BASELINE_FALLBACK"),
      expectedEdge: mode === "BUY" ? "ACCEPTANCE_PASSED" : profile.expectedEdge,
      blockedStage: budget > 0 ? null : (requestedBudget <= 0 ? "BUDGET_CAP" : "ROUTE_BLOCKED"),
      pauseReasons: mode === "TACTICAL_PAUSE"
        ? Array.from(new Set(tacticalReasons.concat("SP500_BASELINE_ONLY")))
        : (mode === "STRATEGIC_DCA" ? Array.from(new Set(strategicReasons)) : []),
      budget: budget,
      budgetPolicy: Object.assign({}, details.budgetPolicy, {
        dailyLimit: dailyLimit,
        dailyRemaining: round(dailyRemaining, 2),
        weeklyLimit: weeklyLimit,
        weeklyRemaining: round(Math.max(0, weeklyLimit - spent), 2),
        requestedBudget: round(requestedBudget, 2),
        overheatReduced: mode === "TACTICAL_PAUSE" && tacticalOverheat,
        signalConfirmed: mode === "TACTICAL_PAUSE" && tacticalConfirmed
      }),
      routeDiagnostics: routeDiagnostics,
      executionRoutes: routes,
      candidates: routeCandidates,
      ranked: routeCandidates,
      confidence: mode === "BUY" ? "MEDIUM" : "LOW",
      personalized: true
    });
  }

  return {
    PERSONALIZED_STRATEGY_ID: PERSONALIZED_STRATEGY_ID,
    TARGET_BUCKETS: TARGET_BUCKETS,
    RISK_PROFILES: RISK_PROFILES,
    normalizeRiskProfile: normalizeRiskProfile,
    INDEX_GROUP_BUCKETS: INDEX_GROUP_BUCKETS,
    CORE_INDEX_GROUPS: CORE_INDEX_GROUPS,
    isCoreIndexGroup: isCoreIndexGroup,
    DEFAULT_POLICY: DEFAULT_POLICY,
    bucketForFund: bucketForFund,
    derivePortfolio: derivePortfolio,
    portfolioMetrics: portfolioMetrics,
    weeklySpent: weeklySpent,
    dailyBuySpend: dailyBuySpend,
    netCashFlowSinceAnchor: netCashFlowSinceAnchor,
    getRiskAnchorMetrics: getRiskAnchorMetrics,
    personalizePlan: personalizePlan
  };
}));
