const recommendationEngine = require("../lib/recommendation-engine");
const portfolioLedger = require("../lib/portfolio-ledger");
const strategyState = require("../lib/strategy-state");

const DEFAULT_MARKET_URLS = {
  funds: "https://raw.githubusercontent.com/zeng111234/qdii-allocator/main/data/funds.json",
  navCache: "https://zeng111234.github.io/qdii-allocator/data/nav-cache.json"
};

function latestNavDate(navCache) {
  let latest = null;
  Object.keys(navCache || {}).forEach(function(code) {
    (navCache[code] || []).forEach(function(row) {
      if (row && /^\d{4}-\d{2}-\d{2}$/.test(String(row.date)) && (!latest || row.date > latest)) latest = row.date;
    });
  });
  return latest;
}

async function fetchJson(fetchFn, url) {
  const response = await fetchFn(url, { headers: { "Cache-Control": "no-cache" } });
  if (!response || !response.ok) throw new Error("MARKET_FETCH_FAILED:" + url);
  return await response.json();
}

async function loadMarketData(fetchFn, urls) {
  const source = Object.assign({}, DEFAULT_MARKET_URLS, urls || {});
  const results = await Promise.all([
    fetchJson(fetchFn, source.funds),
    fetchJson(fetchFn, source.navCache)
  ]);
  const fundsData = results[0];
  const navCache = results[1];
  if (!fundsData || !Array.isArray(fundsData.funds) || !navCache || typeof navCache !== "object") {
    throw new Error("INVALID_MARKET_DATA");
  }
  const asOf = latestNavDate(navCache);
  if (!asOf) throw new Error("MARKET_NAV_UNAVAILABLE");
  return { funds: fundsData.funds, navCache: navCache, asOf: asOf };
}

function buildPlanForUser(input) {
  const settings = input || {};
  const ledger = settings.ledger;
  const validation = portfolioLedger.validateLedger(ledger);
  if (!validation.valid) throw new Error("INVALID_LEDGER:" + validation.errors.join(","));
  const portfolio = portfolioLedger.derivePortfolio(ledger);
  const decisionState = settings.decisionState || {};
  const state = settings.strategyState || {};
  const market = settings.market || {};
  return recommendationEngine.buildRecommendationPlan({
    funds: market.funds || [],
    navCache: market.navCache || {},
    portfolio: portfolio,
    shadowHistory: state.observations || [],
    marketTemperature: {},
    asOf: market.asOf,
    budget: 50,
    syncRevision: ledger.revision,
    cashBalance: decisionState.cashBalance,
    policy: { riskAnchorValue: decisionState.riskAnchorValue || null },
    liveEnabled: false
  });
}

function advanceUserState(input) {
  const settings = input || {};
  const firstPlan = buildPlanForUser(settings);
  const advanced = strategyState.advanceState(
    settings.strategyState || {}, firstPlan, settings.market.navCache, settings.generatedAt
  );
  const finalPlan = buildPlanForUser(Object.assign({}, settings, { strategyState: advanced }));
  return strategyState.advanceState(advanced, finalPlan, settings.market.navCache, settings.generatedAt);
}

async function refreshAllStrategyStates(database, fetchFn, options) {
  const settings = options || {};
  const market = await loadMarketData(fetchFn, settings.marketUrls);
  const usersSnapshot = await database.ref("users").once("value");
  const users = usersSnapshot.val() || {};
  const generatedAt = settings.generatedAt || new Date().toISOString();
  const result = { processed: 0, skipped: 0, asOf: market.asOf };

  for (const uid of Object.keys(users)) {
    const user = users[uid] || {};
    if (!user.portfolioLedger) {
      result.skipped++;
      continue;
    }
    const stateRef = database.ref("users/" + uid + "/strategyState");
    try {
      await stateRef.transaction(function(existing) {
        return advanceUserState({
          ledger: user.portfolioLedger,
          decisionState: user.decisionState || {},
          strategyState: existing || {},
          market: market,
          generatedAt: generatedAt
        });
      });
      result.processed++;
    } catch (error) {
      result.skipped++;
    }
  }
  return result;
}

module.exports = {
  DEFAULT_MARKET_URLS: DEFAULT_MARKET_URLS,
  latestNavDate: latestNavDate,
  loadMarketData: loadMarketData,
  buildPlanForUser: buildPlanForUser,
  advanceUserState: advanceUserState,
  refreshAllStrategyStates: refreshAllStrategyStates
};
