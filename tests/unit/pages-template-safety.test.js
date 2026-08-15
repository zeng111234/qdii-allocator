const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const templatePath = path.join(__dirname, "..", "..", "docs", "index.html.template");
const template = fs.readFileSync(templatePath, "utf8");

function extractFunction(name) {
  const marker = "function " + name + "(";
  const start = template.indexOf(marker);
  assert.notEqual(start, -1, "missing template helper " + name);
  const braceStart = template.indexOf("{", start);
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let i = braceStart; i < template.length; i++) {
    const ch = template[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "{") depth++;
    if (ch === "}") {
      depth--;
      if (depth === 0) return template.slice(start, i + 1);
    }
  }
  throw new Error("unterminated template helper " + name);
}

function loadHelpers(names, globals) {
  const context = Object.assign({}, globals || {});
  vm.createContext(context);
  names.forEach(function (name) {
    vm.runInContext(extractFunction(name), context);
  });
  return context;
}

function extractBetweenFunctions(name, nextName) {
  const start = template.indexOf("function " + name + "(");
  const end = template.indexOf("function " + nextName + "(", start + 1);
  assert.notEqual(start, -1, "missing template function " + name);
  assert.notEqual(end, -1, "missing following template function " + nextName);
  return template.slice(start, end);
}

function decisionFingerprint(state) {
  return JSON.stringify({
    schemaVersion: state.schemaVersion,
    revision: state.revision,
    updatedAt: state.updatedAt,
    riskProfile: state.riskProfile,
    cashBalance: state.cashBalance,
    riskAnchorValue: state.riskAnchorValue,
    riskAnchorAt: state.riskAnchorAt,
    riskAnchorLedgerRevision: state.riskAnchorLedgerRevision,
    riskAnchorTransactionIds: (state.riskAnchorTransactionIds || []).slice().sort()
  });
}

test("dynamic website values are HTML-escaped at critical render boundaries", function () {
  const ctx = loadHelpers(["escapeHtml"]);
  assert.equal(
    ctx.escapeHtml('测试</span><img src="data:x" onerror="alert(1)">'),
    "测试&lt;/span&gt;&lt;img src=&quot;data:x&quot; onerror=&quot;alert(1)&quot;&gt;"
  );

  const holdingsSource = extractFunction("updateHoldings");
  assert.match(holdingsSource, /escapeHtml\(pendingText\)/);
  assert.match(holdingsSource, /escapeHtml\(getHoldingDisplayName\(h, fund\)\)/);
  assert.match(holdingsSource, /escapeHtml\(h\.code\)/);
  assert.match(holdingsSource, /escapeHtml\(b\.date\)/);

  assert.match(extractFunction("updateApiStatus"), /escapeHtml\(config\.model/);
  assert.match(extractFunction("renderDailyBrief"), /renderMarkdown\(String\(briefText/);

  const newsSource = extractFunction("loadNewsSentiment");
  assert.match(newsSource, /safeExternalUrl\(n\.url\)/);
  assert.match(newsSource, /escapeHtml\(n\.title\)/);
  assert.match(newsSource, /rel="noopener noreferrer"/);

  const sendSource = extractBetweenFunctions("sendAiMessage", "askQuick");
  assert.match(sendSource, /renderRetryMessage\(bubble,/);
  assert.doesNotMatch(sendSource, /text\.replace\(\/\'\/g/);
});

test("public snapshot mode disables cloud writes and impossible sync actions", function () {
  assert.match(template, /id="cloud-migrate-btn"/);
  assert.match(template, /id="cloud-refresh-btn"/);
  assert.match(template, /id="portfolio-import-btn"/);
  assert.match(template, /id="buy-submit-btn"/);
  assert.match(template, /id="batch-submit-btn"/);

  const availabilitySource = extractFunction("updateCloudActionAvailability");
  assert.match(availabilitySource, /status\.status === 'PUBLIC_SNAPSHOT'/);
  assert.match(availabilitySource, /cloudWriteReady/);
  assert.match(availabilitySource, /公开只读快照/);

  const importSource = extractFunction("importData");
  assert.match(importSource, /window\.QDII_PUBLIC_PORTFOLIO_SNAPSHOT === true/);
  assert.match(importSource, /公开只读模式不能导入/);
});

test("mobile viewport stays zoomable and tabs are keyboard-accessible controls", function () {
  assert.match(template, /<meta name="viewport" content="width=device-width, initial-scale=1\.0">/);
  assert.doesNotMatch(template, /user-scalable=no|maximum-scale=1/);
  assert.match(template, /<div class="tabs" role="tablist"/);
  assert.equal((template.match(/<button type="button" id="tab-control-/g) || []).length, 9);
  assert.match(template, /\.tab \{[\s\S]*min-height:\s*44px/);
  assert.match(template, /#buy-submit-btn\s*,\s*#batch-submit-btn\s*\{[^}]*min-height:\s*44px/);
  assert.match(extractFunction("switchTab"), /aria-selected/);
});

test("static website has a session-scoped visual access gate", function () {
  assert.match(template, /id="site-access-gate"/);
  assert.match(template, /id="site-access-form"/);
  assert.match(template, /id="site-access-code"[^>]*type="password"[^>]*inputmode="numeric"[^>]*maxlength="4"/);
  assert.match(template, /id="site-app"/);
  assert.match(template, /site-access-locked/);
  assert.match(template, /site-access-unlocked/);
  assert.doesNotMatch(template, /['"]0315['"]/);

  const submitSource = extractFunction("handleSiteAccessSubmit");
  assert.match(submitSource, /crypto\.subtle\.digest/);
  assert.match(submitSource, /sessionStorage\.setItem/);
  assert.match(submitSource, /setSiteAccessState\(true\)/);
});

test("PAUSE keeps the real candidate Top average", function () {
  const ctx = loadHelpers(["getTodayPicksAverage"]);
  assert.equal(ctx.getTodayPicksAverage({ action: "PAUSE", ranked: [{ score: 75.25 }, { score: 64.83 }] }), 70.04);
  assert.equal(ctx.getTodayPicksAverage({ action: "HOLD", ranked: [] }), null);
  assert.match(extractFunction("renderBuySignal"), /getTodayPicksAverage\(todayPicks\)/);
  assert.doesNotMatch(extractFunction("renderBuySignal"), /avgScore\s*=\s*0/);
});

test("summary distinguishes confirmed holdings from pending record groups", function () {
  assert.match(template, /recordCount:\s*portfolioData\.holdings\.length \+ pendingHoldings\.length/);
  assert.match(template, /持仓记录/);
  assert.match(template, /已确认.*待核验/);
});

test("closed positions remain visible in website totals after every share is sold", function () {
  assert.match(template, /var closedPositions = Array\.isArray\(portfolioData\.closedPositions\)/);
  assert.match(template, /var closedRealizedPnl = Number\(portfolioData\.closedRealizedPnl\) \|\| 0/);
  assert.match(template, /valuation\.pnl \+ closedRealizedPnl/);
  assert.match(template, /recordCount: portfolioData\.holdings\.length \+ pendingHoldings\.length \+ closedPositions\.length/);
  assert.match(template, /已清仓/);
  assert.match(template, /累计已实现盈亏/);
});

test("one confirmed-only valuation helper excludes pending buys and fails closed on missing NAV", function () {
  const ctx = loadHelpers([
    "shanghaiDateString", "isStrictIsoDate", "valuationTradingDayLag", "assessValuationNav",
    "calcConfirmedHoldingValuation", "calcConfirmedPortfolioValuation"
  ], { tradingHolidays: [] });
  const holding = {
    code: "A",
    buys: [
      { date: "2026-08-01", amount: 100, shares: 10, nav: 10 },
      { date: "2026-08-12", amount: 50, shares: 0, nav: 0 }
    ]
  };
  const valued = ctx.calcConfirmedHoldingValuation(
    holding,
    { date: "2026-08-14", nav: 11 },
    null,
    { asOf: "2026-08-17", maxFreshnessLag: 2 }
  );
  assert.equal(valued.invested, 100);
  assert.equal(valued.pending, 50);
  assert.equal(valued.value, 110);
  assert.equal(valued.pnl, 10);
  assert.equal(valued.complete, true);

  const incomplete = ctx.calcConfirmedPortfolioValuation([
    holding,
    { code: "B", buys: [{ date: "2026-08-01", amount: 200, shares: 20, nav: 10 }] }
  ], function (item) {
    return item.code === "A" ? { date: "2026-08-14", nav: 11 } : null;
  }, null, { asOf: "2026-08-17", maxFreshnessLag: 2 });
  assert.equal(incomplete.invested, 300);
  assert.equal(incomplete.value, null);
  assert.equal(incomplete.pnl, null);
  assert.equal(incomplete.complete, false);
  assert.deepEqual(Array.from(incomplete.missingNavCodes), ["B"]);
});

test("browser valuation accepts normal QDII lag but rejects stale and future NAV dates", function () {
  const ctx = loadHelpers([
    "shanghaiDateString", "isStrictIsoDate", "valuationTradingDayLag", "assessValuationNav",
    "calcConfirmedHoldingValuation"
  ], { tradingHolidays: [] });
  const holding = {
    code: "QDII",
    buys: [{ date: "2026-08-01", amount: 100, shares: 10, nav: 10 }]
  };

  const normalLag = ctx.calcConfirmedHoldingValuation(
    holding, { date: "2026-08-13", nav: 11 }, null,
    { asOf: "2026-08-17", maxFreshnessLag: 2 }
  );
  assert.equal(normalLag.complete, true);
  assert.equal(normalLag.value, 110);
  assert.equal(normalLag.navTradingDayLag, 2);

  const stale = ctx.calcConfirmedHoldingValuation(
    holding, { date: "2026-08-12", nav: 11 }, null,
    { asOf: "2026-08-17", maxFreshnessLag: 2 }
  );
  assert.equal(stale.complete, false);
  assert.equal(stale.value, null);
  assert.equal(stale.pnl, null);
  assert.equal(stale.valuationIssue, "NAV_STALE");

  const future = ctx.calcConfirmedHoldingValuation(
    holding, { date: "2026-08-18", nav: 11 }, null,
    { asOf: "2026-08-17", maxFreshnessLag: 2 }
  );
  assert.equal(future.complete, false);
  assert.equal(future.value, null);
  assert.equal(future.pnl, null);
  assert.equal(future.valuationIssue, "NAV_FUTURE");
});

test("all portfolio consumers use confirmed-only valuation and disclose incomplete valuation", function () {
  ["calcSummary", "renderPortfolioChart", "updateHoldings", "renderInsights", "simulateDebate", "runAttribution", "buildSystemPrompt"]
    .forEach(function (name) {
      assert.match(extractFunction(name), /calcConfirmed(?:Holding|Portfolio)Valuation/, name + " must use confirmed valuation");
    });
  assert.match(extractFunction("updateSummary"), /估值不完整/);
  assert.match(extractFunction("updateHoldings"), /估值待补齐/);
  assert.match(extractFunction("buildSystemPrompt"), /总盈亏: 估值不完整/);
  assert.match(extractFunction("getNavSeries"), /Math\.abs\(Number\(b\.shares\)/);
  assert.doesNotMatch(extractFunction("getNavSeries"), /b\.amount\s*\/\s*b\.nav/);
});

test("non-trading-day banner never says a paused plan can be bought", function () {
  const source = extractFunction("renderTradeBanner");
  assert.doesNotMatch(source, /非交易日[^']*可以买入/);
  assert.match(source, /不可按今日计划买入/);
});

test("site passcode is only the visual gate and confirmed buys still require Google", function () {
  assert.match(template, /id="buy-write-hint"/);
  assert.match(template, /0315 仅用于进入网站/);
  assert.match(template, /Google 登录和云端账本校验/);
  assert.match(extractFunction("updateCloudActionAvailability"), /buy-write-hint/);
});

test("pause banner explains supplied reasons, breaker metrics, thresholds and recovery", function () {
  const ctx = loadHelpers(["formatMetric", "formatPauseReason", "buildPauseDetails"]);
  const text = ctx.buildPauseDetails({
    action: "PAUSE",
    pauseReasons: ["RECENT_WIN_RATE_LOW", "LIVE_DISABLED"],
    signalHealth: {
      status: "PAUSE",
      matured: { count: 30, winRate: 16.67, averageReturn: -2.44 },
      shadow: { count: 4, winRate: 50, averageReturn: 0.2 },
      breakerTriggered: true,
      recovered: false
    }
  });
  assert.match(text, /最近30个成熟5日结果/);
  assert.match(text, /16\.67%/);
  assert.match(text, /-2\.44%/);
  assert.match(text, /胜率40%/);
  assert.match(text, /平均收益-1%/);
  assert.match(text, /至少20个影子5日结果/);
  assert.match(text, /胜率达到50%/);
  assert.match(text, /平均收益大于0%/);
  assert.match(text, /RECENT_WIN_RATE_LOW/);
});

test("pause banner explains live acceptance failures with actual metrics", function () {
  const ctx = loadHelpers(["formatMetric", "formatPauseReason", "buildPauseDetails"]);
  const text = ctx.buildPauseDetails({
    action: "PAUSE",
    pauseReasons: ["ACCEPTANCE_GATE"],
    signalHealth: { status: "HEALTHY", matured: {}, shadow: {} },
    liveAcceptance: {
      passed: false,
      failures: ["WIN_RATE_BELOW_55", "PROFIT_WIN_RATE_NOT_ABOVE_BASELINE", "OUTPERFORMANCE_WIN_RATE_BELOW_55", "AVERAGE_EXCESS_NOT_POSITIVE", "PROFIT_FACTOR_BELOW_1_2", "MEDIAN_EXCESS_NOT_POSITIVE", "DRAWDOWN_WORSE_THAN_LIMIT", "INSUFFICIENT_SHADOW_WEEKS"],
      metrics: {
        rollingWindows: 22,
        winRate: 50,
        benchmarkWinRate: 62.5,
        outperformanceWinRate: 12.5,
        averageExcessReturn: -5.69,
        profitFactor: 1.1,
        medianExcess12Week: -1.93,
        drawdownGapPercentagePoints: 2.9,
        shadowWeeks: 4
      }
    }
  });
  assert.match(text, /回测与影子观察尚未全部通过/);
  assert.match(text, /中位超额收益不大于0/);
  assert.match(text, /盈利概率未超过标普500基准/);
  assert.match(text, /跑赢标普500的窗口不足55%/);
  assert.match(text, /相对标普500的平均超额不大于0/);
  assert.match(text, /策略回撤比基准多2个百分点以上/);
  assert.match(text, /影子观察不足8周/);
  assert.match(text, /历史滚动胜率不足55%/);
  assert.match(text, /盈亏因子不足1\.2/);
  assert.match(text, /22个滚动窗口/);
  assert.match(text, /滚动胜率50%/);
  assert.match(text, /标普基准胜率62\.5%/);
  assert.match(text, /跑赢标普比例12\.5%/);
  assert.match(text, /平均超额-5\.69%/);
  assert.match(text, /盈亏因子1\.1/);
  assert.match(text, /中位超额-1\.93%/);
  assert.match(text, /回撤差2\.9个百分点/);
  assert.match(text, /影子观察4\/8周/);
});

test("hypothesis outcome rate excludes active and expired records", function () {
  const ctx = loadHelpers(["getHypothesisOutcomeStats"]);
  const result = ctx.getHypothesisOutcomeStats([
    { status: "validated" },
    { status: "invalidated" },
    { status: "invalidated" },
    { status: "expired" },
    { status: "active" }
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    validated: 1,
    invalidated: 2,
    sampleCount: 3,
    winRate: 33
  });
  assert.match(template, /止盈\/止损命中率/);
  assert.match(template, /1胜.*2负|validated.*invalidated/);
});

test("shadow observation copy says amount zero, tracking only and no real purchase", function () {
  assert.match(template, /影子观察[^\n]{0,120}金额\s*0/);
  assert.match(template, /只记录/);
  assert.match(template, /不实买/);
});

test("cloud write controls are fail-closed until Firebase ledger readiness is confirmed", function () {
  ["cloud-migrate-btn", "cloud-refresh-btn", "portfolio-import-btn", "buy-submit-btn", "batch-submit-btn"].forEach(function (id) {
    const pattern = new RegExp('<button[^>]*id="' + id + '"[^>]*disabled[^>]*>');
    assert.match(template, pattern, id + " should be disabled in initial HTML");
  });
  assert.match(template, /var writeReady = cloudWriteReady && status\.status === 'READY'/);
});

test("tactical contribution is labeled as baseline allocation without an alpha claim", function () {
  assert.match(template, /标普500基准定投/);
  assert.match(template, /尚未证明跑赢标普/);
});

test("non-BUY buy question has a deterministic zero-budget answer", function () {
  const ctx = loadHelpers(["formatMetric", "formatPauseReason", "buildPauseDetails", "isTodayBuyQuestion", "buildNoBuyAnswer"]);
  assert.equal(ctx.isTodayBuyQuestion("今天该买什么基金？为什么？"), true);
  const answer = ctx.buildNoBuyAnswer({
    date: "2026-07-17",
    action: "PAUSE",
    budget: 0,
    pauseReasons: ["SIGNAL_CIRCUIT_BREAKER"],
    signalHealth: { status: "PAUSE", matured: { count: 30, winRate: 16.67, averageReturn: -2.44 } }
  });
  assert.match(answer, /今天不买/);
  assert.match(answer, /预算.*0元/);
  assert.match(answer, /16\.67%/);
  const sendSource = extractBetweenFunctions("sendAiMessage", "askQuick");
  assert.match(sendSource, /isTodayBuyQuestion\(text\)/);
  assert.ok(sendSource.indexOf("isTodayBuyQuestion(text)") < sendSource.indexOf("getAiConfig()"), "local PAUSE response must happen before API configuration/fetch");
});

test("tactical core DCA question is answered locally from exact routes", function () {
  const ctx = loadHelpers(["buildDeterministicBuyAnswer"]);
  const answer = ctx.buildDeterministicBuyAnswer({
    date: "2026-07-18",
    action: "TACTICAL_PAUSE",
    budget: 20,
    syncRevision: 3,
    executionRoutes: [{ code: "SPX", name: "标普通道", amount: 20, bucket: "US_BROAD" }]
  });
  assert.match(answer, /标普通道\(SPX\)/);
  assert.match(answer, /20元/);
  assert.match(answer, /US_BROAD/);
  assert.match(answer, /revision 3/);
  const sendSource = extractBetweenFunctions("sendAiMessage", "askQuick");
  assert.match(sendSource, /buildDeterministicBuyAnswer/);
  assert.ok(sendSource.indexOf("buildDeterministicBuyAnswer") < sendSource.indexOf("getAiConfig()"));
});

test("AI prompt treats RecommendationPlan as immutable and removes browser ranking advice", function () {
  const source = extractFunction("buildSystemPrompt");
  assert.match(source, /todayPicks/);
  assert.match(source, /不得覆盖|不可更改/);
  assert.match(source, /proposedAmount|建议金额/);
  assert.match(source, /数据时效/);
  assert.match(source, /覆盖不足/);
  assert.doesNotMatch(source, /computeRankings/);
  assert.doesNotMatch(source, /30-100元/);
  assert.doesNotMatch(source, /大胆买/);
});

test("market sentiment reply always discloses freshness, coverage and cannot override PAUSE", function () {
  const ctx = loadHelpers(["isMarketSentimentQuestion", "buildMarketSentimentDisclosure", "buildMarketSentimentAnswer"]);
  assert.equal(ctx.isMarketSentimentQuestion("根据今天的新闻和外部信号，市场情绪如何？"), true);
  const disclosure = ctx.buildMarketSentimentDisclosure(
    { action: "PAUSE" },
    { fetchedAt: "2026-07-16T15:51:08Z", items: [{ title: "one" }] },
    { status: "stale", cachedAt: "2026-07-15T00:00:00Z", tickerOpinions: [] }
  );
  assert.match(disclosure, /2026-07-16/);
  assert.match(disclosure, /覆盖1条/);
  assert.match(disclosure, /覆盖不足/);
  assert.match(disclosure, /不得改变.*PAUSE/);
  const sendSource = extractBetweenFunctions("sendAiMessage", "askQuick");
  assert.match(sendSource, /buildMarketSentimentDisclosure/);
  assert.match(ctx.buildMarketSentimentAnswer(
    { action: "HARD_PAUSE" },
    { fetchedAt: "2026-07-30T00:00:00Z", items: [{ title: "one" }], sentiment: { overall: 12, positive: 3, negative: 1 } },
    { status: "current", cachedAt: "2026-07-30T00:00:00Z", tickerOpinions: [{ ticker: "SPX" }] }
  ), /偏乐观/);
  assert.ok(sendSource.indexOf("isMarketSentimentQuestion(text)") < sendSource.indexOf("getAiConfig()"), "market sentiment must have a local fallback before any AI network call");
});

test("risk-anchor setup is explicit and zero-budget route failures are explained", function () {
  assert.match(template, /id="decision-anchor-card"/);
  assert.match(template, /需要完成一次风险锚点初始化/);
  assert.match(template, /不会买卖基金/);
  const ctx = loadHelpers(["formatMetric", "formatPauseReason", "buildPauseDetails"]);
  const details = ctx.buildPauseDetails({
    action: "TACTICAL_PAUSE",
    budget: 0,
    personalized: true,
    decisionMode: "BASELINE_DCA",
    routeDiagnostics: { requestedBudget: 10, allocatedBudget: 0, blockReasons: ["NO_ELIGIBLE_CORE_ROUTE"] },
    signalHealth: { status: "PAUSE", matured: {}, shadow: {} }
  });
  assert.match(details, /没有可执行的核心指数通道/);
});

test("aggressive strategic DCA is presented as higher beta rather than proven alpha", function () {
  assert.match(template, /AGGRESSIVE_BETA_NOT_ALPHA/);
  assert.match(template, /RISK_ANCHOR_DRAWDOWN_15/);
  const ctx = loadHelpers(["buildDeterministicBuyAnswer"]);
  const answer = ctx.buildDeterministicBuyAnswer({
    action: "STRATEGIC_DCA",
    budget: 20,
    syncRevision: 3,
    executionRoutes: [{ code: "NDX", name: "纳指通道", amount: 20, bucket: "GROWTH_TECH" }]
  });
  assert.match(answer, /进取型战略配置/);
  assert.match(answer, /不代表择时模型已证明超额/);
});

test("signal confirmation requires fresh news and external coverage before calling consensus bullish", function () {
  const ctx = loadHelpers(["buildSignalConfirmation"]);
  const now = Date.parse("2026-07-24T12:00:00Z");
  const confirmed = ctx.buildSignalConfirmation(
    { fetchedAt: "2026-07-24T11:00:00Z", items: [{}, {}, {}, {}, {}], sentiment: { overall: 20, positive: 4, negative: 1 } },
    { cachedAt: Date.parse("2026-07-24T11:30:00Z"), status: "ok", tickerOpinions: [{ sentiment: "bullish" }, { sentiment: "bullish" }] }, now
  );
  assert.equal(confirmed.status, "CONFIRMED");
  const stale = ctx.buildSignalConfirmation(
    { fetchedAt: "2026-07-22T11:00:00Z", items: [{}, {}, {}, {}, {}], sentiment: { overall: 20, positive: 4, negative: 1 } },
    { cachedAt: "2026-07-24T11:30:00Z", status: "ok", tickerOpinions: [{ sentiment: "bullish" }, { sentiment: "bullish" }] }, now
  );
  assert.equal(stale.status, "INSUFFICIENT");
  assert.match(template, /if \(currentCloudDetail\) refreshPersonalizedPlan\(currentCloudDetail\)/);
});

test("canonical public snapshots never recalculate the build-time plan in the browser", function () {
  let personalizeCalls = 0;
  const decisionState = {
    schemaVersion: 2, revision: 3, updatedAt: "2026-08-15T00:00:00.000Z",
    riskProfile: "AGGRESSIVE", cashBalance: 0, riskAnchorValue: 1000,
    riskAnchorAt: "2026-08-15T00:00:00.000Z", riskAnchorLedgerRevision: 5,
    riskAnchorTransactionIds: ["b", "a"]
  };
  const canonicalPlan = {
    asOf: "2026-08-15", action: "STRATEGIC_DCA", budget: 20,
    generatedAt: "2026-08-15T01:30:00.000Z",
    validFrom: "2026-08-15T01:00:00.000Z", validUntil: "2026-08-15T06:00:00.000Z",
    syncRevision: 5, decisionRevision: 3, ledgerChecksum: "ledger-5",
    decisionFingerprint: decisionFingerprint(decisionState),
    candidates: [{ code: "096001", amount: 10 }]
  };
  const ctx = loadHelpers([
    "isCanonicalPublicSnapshot", "hasCanonicalBuildPlan", "isMarketOnlyBuildPlan", "buildMarketOnlyLockedPlan",
    "shanghaiDateString", "isStrictIsoDate", "isStrictUtcTimestamp", "planDateStatus", "planExecutionWindowStatus",
    "buildPlanDateMismatchPlan", "enforceActionablePlanDate",
    "refreshCanonicalPlanDateGuard",
    "canonicalDecisionFingerprint", "canonicalPlanInputsMatch", "buildCanonicalRevisionMismatchPlan", "refreshPersonalizedPlan"
  ], {
    window: {
      QDII_PUBLIC_PORTFOLIO_SNAPSHOT: true,
      QDII_PUBLIC_PLAN_CANONICAL: true,
      QDII_PUBLIC_DECISION_STATE: decisionState,
      QdiiPersonalizedDecision: { personalizePlan: function () { personalizeCalls++; return { action: "WRONG" }; } }
    },
    currentCloudDetail: null,
    canonicalPlanInputMismatch: false,
    publicTodayPicks: canonicalPlan,
    todayPicks: null,
    updateAnchorButton: function () {},
    renderAnchorSetupCard: function () {},
    renderTradeBanner: function () {},
    renderTemperature: function () {},
    renderBuySignal: function () {},
    renderPicks: function () {}
    ,updateCloudActionAvailability: function () {}
  });
  ctx.refreshPersonalizedPlan({
    readOnly: true,
    ledger: { revision: 5, checksum: "ledger-5", transactions: [] },
    decisionState: decisionState
  }, "2026-08-15T02:00:00.000Z");
  assert.equal(personalizeCalls, 0);
  assert.deepEqual(ctx.todayPicks, canonicalPlan);
  assert.equal(ctx.canonicalPlanInputMismatch, false);
});

test("canonical input validation does not depend on the personalized browser module loading", function () {
  const state = {
    schemaVersion: 2, revision: 3, updatedAt: "2026-08-15T00:00:00.000Z",
    riskProfile: "AGGRESSIVE", cashBalance: 0, riskAnchorValue: 1000,
    riskAnchorAt: "2026-08-15T00:00:00.000Z", riskAnchorLedgerRevision: 5,
    riskAnchorTransactionIds: []
  };
  const canonicalPlan = {
    asOf: "2026-08-15", action: "HARD_PAUSE", budget: 0,
    syncRevision: 5, decisionRevision: 3, ledgerChecksum: "ledger-5",
    decisionFingerprint: decisionFingerprint(state), candidates: [], ranked: [], executionRoutes: []
  };
  const ctx = loadHelpers([
    "hasCanonicalBuildPlan", "isMarketOnlyBuildPlan", "buildMarketOnlyLockedPlan",
    "shanghaiDateString", "isStrictIsoDate", "planDateStatus", "buildPlanDateMismatchPlan", "enforceActionablePlanDate",
    "canonicalDecisionFingerprint", "canonicalPlanInputsMatch", "buildCanonicalRevisionMismatchPlan", "refreshPersonalizedPlan"
  ], {
    window: { QDII_PUBLIC_PLAN_CANONICAL: true, QDII_PUBLIC_PORTFOLIO_SNAPSHOT: true },
    currentCloudDetail: null, canonicalPlanInputMismatch: false, canonicalPlanDateMismatch: false,
    publicTodayPicks: canonicalPlan, todayPicks: null,
    updateAnchorButton: function () {}, renderAnchorSetupCard: function () {},
    renderTradeBanner: function () {}, renderTemperature: function () {}, renderBuySignal: function () {},
    renderPicks: function () {}, updateCloudActionAvailability: function () {}
  });
  ctx.refreshPersonalizedPlan({
    readOnly: true,
    ledger: { revision: 6, checksum: "ledger-6", transactions: [] },
    decisionState: Object.assign({}, state, { revision: 4 })
  }, "2026-08-15T02:00:00.000Z");
  assert.equal(ctx.todayPicks.action, "HARD_PAUSE");
  assert.ok(Array.from(ctx.todayPicks.pauseReasons).includes("PLAN_INPUT_REVISION_MISMATCH"));
  assert.equal(ctx.canonicalPlanInputMismatch, true);
  const source = extractFunction("refreshPersonalizedPlan");
  assert.ok(source.indexOf("if (hasCanonicalBuildPlan())") < source.indexOf("!window.QdiiPersonalizedDecision"));
});

test("new cloud input revisions hard-pause the canonical plan instead of using strategyState", function () {
  let personalizeCalls = 0;
  const builtDecisionState = {
    schemaVersion: 2, revision: 3, updatedAt: "2026-08-13T00:00:00.000Z",
    riskProfile: "AGGRESSIVE", cashBalance: 0, riskAnchorValue: 1000,
    riskAnchorAt: "2026-08-13T00:00:00.000Z", riskAnchorLedgerRevision: 5,
    riskAnchorTransactionIds: []
  };
  const canonicalPlan = {
    asOf: "2026-08-13", action: "STRATEGIC_DCA", budget: 20,
    syncRevision: 5, decisionRevision: 3, ledgerChecksum: "ledger-5",
    decisionFingerprint: decisionFingerprint(builtDecisionState),
    candidates: [{ code: "096001", proposedAmount: 20 }],
    ranked: [{ code: "096001", proposedAmount: 20 }],
    executionRoutes: [{ code: "096001", amount: 20 }]
  };
  let availabilityCalls = 0;
  const ctx = loadHelpers([
    "hasCanonicalBuildPlan", "isMarketOnlyBuildPlan", "buildMarketOnlyLockedPlan",
    "shanghaiDateString", "isStrictIsoDate", "planDateStatus", "buildPlanDateMismatchPlan", "enforceActionablePlanDate",
    "canonicalDecisionFingerprint", "canonicalPlanInputsMatch", "buildCanonicalRevisionMismatchPlan", "refreshPersonalizedPlan"
  ], {
    window: {
      QDII_PUBLIC_PLAN_CANONICAL: true,
      QdiiPersonalizedDecision: { personalizePlan: function () { personalizeCalls++; return { action: "WRONG" }; } }
    },
    currentCloudDetail: null,
    canonicalPlanInputMismatch: false,
    publicTodayPicks: canonicalPlan,
    todayPicks: null,
    updateAnchorButton: function () {},
    renderAnchorSetupCard: function () {},
    renderTradeBanner: function () {},
    renderTemperature: function () {},
    renderBuySignal: function () {},
    renderPicks: function () {},
    updateCloudActionAvailability: function () { availabilityCalls++; }
  });
  ctx.refreshPersonalizedPlan({
    readOnly: false,
    ledger: { revision: 9, checksum: "ledger-9", transactions: [] },
    decisionState: Object.assign({}, builtDecisionState, { revision: 8, riskAnchorValue: 999 }),
    strategyState: { latestPlan: { asOf: "2026-08-14", action: "BUY", budget: 999 } }
  });
  assert.equal(personalizeCalls, 0);
  assert.equal(ctx.todayPicks.action, "HARD_PAUSE");
  assert.equal(ctx.todayPicks.budget, 0);
  assert.deepEqual(Array.from(ctx.todayPicks.candidates), []);
  assert.deepEqual(Array.from(ctx.todayPicks.ranked), []);
  assert.deepEqual(Array.from(ctx.todayPicks.executionRoutes), []);
  assert.ok(Array.from(ctx.todayPicks.pauseReasons).includes("PLAN_INPUT_REVISION_MISMATCH"));
  assert.equal(ctx.canonicalPlanInputMismatch, true);
  assert.ok(availabilityCalls > 0);
  assert.match(extractFunction("addBuy"), /canonicalPlanInputMismatch/);
  assert.match(extractFunction("submitBatch"), /canonicalPlanInputMismatch/);
  assert.match(extractFunction("updateCloudActionAvailability"), /!canonicalPlanInputMismatch/);
});

test("actionable plans are executable only for the current Asia/Shanghai date", function () {
  const ctx = loadHelpers([
    "shanghaiDateString", "isStrictIsoDate", "isStrictUtcTimestamp", "planDateStatus", "planExecutionWindowStatus", "buildPlanDateMismatchPlan",
    "enforceActionablePlanDate", "actionAllowsPurchase"
  ], { canonicalPlanInputMismatch: false, canonicalPlanDateMismatch: false });
  const now = "2026-08-15T02:00:00.000Z"; // 2026-08-15 10:00 in Asia/Shanghai
  const base = {
    action: "STRATEGIC_DCA", budget: 20,
    generatedAt: "2026-08-15T01:30:00.000Z",
    validFrom: "2026-08-15T01:00:00.000Z",
    validUntil: "2026-08-15T06:00:00.000Z",
    candidates: [{ code: "096001" }], ranked: [{ code: "096001" }],
    executionRoutes: [{ code: "096001", amount: 20 }]
  };
  const current = Object.assign({}, base, { asOf: "2026-08-15", date: "2026-08-15" });
  assert.equal(ctx.actionAllowsPurchase(current, now), true);

  [
    { plan: Object.assign({}, base), reason: "PLAN_DATE_MISSING" },
    { plan: Object.assign({}, base, { asOf: "2026-08-14" }), reason: "PLAN_DATE_STALE" },
    { plan: Object.assign({}, base, { asOf: "2026-08-16" }), reason: "PLAN_DATE_FUTURE" }
  ].forEach(function (item) {
    const guarded = ctx.enforceActionablePlanDate(item.plan, now);
    assert.equal(guarded.action, "HARD_PAUSE");
    assert.equal(guarded.budget, 0);
    assert.deepEqual(Array.from(guarded.candidates), []);
    assert.deepEqual(Array.from(guarded.ranked), []);
    assert.deepEqual(Array.from(guarded.executionRoutes), []);
    assert.ok(Array.from(guarded.pauseReasons).includes(item.reason));
    assert.equal(ctx.actionAllowsPurchase(item.plan, now), false);
  });
  assert.equal(ctx.planExecutionWindowStatus(current, "2026-08-15T06:30:00.000Z").reason, "PLAN_WINDOW_EXPIRED");
  assert.equal(ctx.actionAllowsPurchase(current, "2026-08-15T06:30:00.000Z"), false);
  assert.equal(ctx.planExecutionWindowStatus(
    Object.assign({}, current, { validUntil: "2026-08-15T07:00:00.000Z" }), now
  ).reason, "PLAN_EXECUTION_WINDOW_INVALID");
  const missingWindow = Object.assign({}, current);
  delete missingWindow.validUntil;
  assert.equal(ctx.actionAllowsPurchase(missingWindow, now), false);
});

test("performance attribution includes fully closed realized profit in its total", function () {
  const element = { innerHTML: "" };
  const ctx = loadHelpers(["escapeHtml", "runAttribution"], {
    document: { getElementById: function () { return element; } },
    fundsData: { funds: [{ code: "A", name: "Active A", type: "宽基" }] },
    portfolioData: {
      holdings: [{ code: "A", buys: [{ amount: 100, shares: 10 }] }],
      closedPositions: [{ code: "B", name: "Closed B", investedAmount: 100, realizedPnl: 20 }],
      closedRealizedPnl: 20
    },
    calcConfirmedHoldingValuation: function () {
      return { invested: 100, value: 110, pnl: 10, complete: true };
    }
  });
  ctx.runAttribution({ A: { "2026-08-01": 10, "2026-08-15": 11 } }, ["A"], ["2026-08-01", "2026-08-15"]);
  assert.match(element.innerHTML, /Closed B.*已清仓/s);
  assert.match(element.innerHTML, /Closed B[\s\S]*\+20/);
  assert.match(element.innerHTML, /合计[\s\S]*\+30/);
});

test("performance attribution still runs when backtest history is unavailable or too short", function () {
  const source = extractBetweenFunctions("runBacktest", "runAttribution");
  assert.match(source, /if \(!fullNav\) \{[\s\S]*?runAttribution\(\{\},[\s\S]*?return;/);
  assert.ok(source.indexOf("runAttribution(navMatrix, codes, dates)") < source.indexOf("if (dates.length < 60)"));
  assert.equal((source.match(/runAttribution\(navMatrix, codes, dates\)/g) || []).length, 1);
});

test("canonical write controls re-check the execution window while the page remains open", function () {
  const plan = {
    asOf: "2026-08-15", date: "2026-08-15", action: "STRATEGIC_DCA", budget: 10,
    generatedAt: "2026-08-15T01:30:00.000Z",
    validFrom: "2026-08-15T01:00:00.000Z", validUntil: "2026-08-15T06:00:00.000Z",
    candidates: [{ code: "A" }], ranked: [{ code: "A" }], executionRoutes: [{ code: "A", amount: 10 }]
  };
  const ctx = loadHelpers([
    "hasCanonicalBuildPlan", "shanghaiDateString", "isStrictIsoDate", "isStrictUtcTimestamp", "planDateStatus",
    "planExecutionWindowStatus",
    "buildPlanDateMismatchPlan", "refreshCanonicalPlanDateGuard"
  ], {
    window: { QDII_PUBLIC_PLAN_CANONICAL: true },
    publicTodayPicks: plan, todayPicks: plan, canonicalPlanDateMismatch: false
  });
  assert.equal(ctx.refreshCanonicalPlanDateGuard("2026-08-15T05:59:00.000Z"), true);
  assert.equal(ctx.refreshCanonicalPlanDateGuard("2026-08-15T06:01:00.000Z"), false);
  assert.equal(ctx.canonicalPlanDateMismatch, true);
  assert.equal(ctx.todayPicks.action, "HARD_PAUSE");
  assert.ok(Array.from(ctx.todayPicks.pauseReasons).includes("PLAN_WINDOW_EXPIRED"));
  assert.match(extractFunction("addBuy"), /refreshCanonicalPlanDateGuard/);
  assert.match(extractFunction("submitBatch"), /refreshCanonicalPlanDateGuard/);
  assert.match(extractFunction("updateCloudActionAvailability"), /refreshCanonicalPlanDateGuard/);
  assert.match(template, /setInterval\([\s\S]*refreshCanonicalPlanDateGuard/);
});

test("canonical input matching binds checksums and the exact decision fingerprint", function () {
  const state = {
    schemaVersion: 2, revision: 7, updatedAt: "2026-08-15T00:00:00.000Z",
    riskProfile: "AGGRESSIVE", cashBalance: 10, riskAnchorValue: 1000,
    riskAnchorAt: "2026-08-15T00:00:00.000Z", riskAnchorLedgerRevision: 4,
    riskAnchorTransactionIds: ["b", "a"]
  };
  const ctx = loadHelpers(["canonicalDecisionFingerprint", "canonicalPlanInputsMatch"]);
  const plan = {
    syncRevision: 4, decisionRevision: 7, ledgerChecksum: "checksum-4",
    decisionFingerprint: decisionFingerprint(state)
  };
  const detail = { ledger: { revision: 4, checksum: "checksum-4" }, decisionState: state };
  assert.equal(ctx.canonicalPlanInputsMatch(plan, detail), true);
  assert.equal(ctx.canonicalPlanInputsMatch(Object.assign({}, plan, { syncRevision: "4" }), detail), false);
  assert.equal(ctx.canonicalPlanInputsMatch(Object.assign({}, plan, { ledgerChecksum: undefined }), detail), false);
  assert.equal(ctx.canonicalPlanInputsMatch(plan, Object.assign({}, detail, {
    decisionState: Object.assign({}, state, { cashBalance: 11 })
  })), false);
});

test("market-only build remains hard-paused after login and ignores strategyState", function () {
  let personalizeCalls = 0;
  const marketOnlyPlan = {
    asOf: "2026-08-15", action: "HARD_PAUSE", budget: 0,
    blockedStage: "PRIVATE_STATE_VALIDATION",
    pauseReasons: ["PRIVATE_RECOMMENDATION_STATE_UNAVAILABLE"],
    candidates: [], ranked: [], executionRoutes: [],
    dataFreshness: { status: "MARKET_ONLY" }
  };
  const ctx = loadHelpers([
    "isMarketOnlyBuildPlan", "buildMarketOnlyLockedPlan", "hasCanonicalBuildPlan",
    "shanghaiDateString", "isStrictIsoDate", "planDateStatus", "buildPlanDateMismatchPlan",
    "enforceActionablePlanDate", "refreshPersonalizedPlan"
  ], {
    window: {
      QDII_PUBLIC_PLAN_CANONICAL: false,
      QdiiPersonalizedDecision: { personalizePlan: function () { personalizeCalls++; return { action: "BUY", budget: 999 }; } }
    },
    currentCloudDetail: null,
    canonicalPlanInputMismatch: false,
    canonicalPlanDateMismatch: false,
    publicTodayPicks: marketOnlyPlan,
    todayPicks: null,
    updateAnchorButton: function () {}, renderAnchorSetupCard: function () {},
    renderTradeBanner: function () {}, renderTemperature: function () {},
    renderBuySignal: function () {}, renderPicks: function () {},
    updateCloudActionAvailability: function () {}
  });
  ctx.refreshPersonalizedPlan({
    readOnly: false,
    ledger: { revision: 99, checksum: "new" },
    decisionState: { revision: 99, riskAnchorValue: 999 },
    strategyState: { latestPlan: { asOf: "2026-08-15", action: "BUY", budget: 999 } }
  }, "2026-08-14T16:30:00.000Z");
  assert.equal(personalizeCalls, 0);
  assert.equal(ctx.todayPicks.action, "HARD_PAUSE");
  assert.equal(ctx.todayPicks.budget, 0);
  assert.ok(Array.from(ctx.todayPicks.pauseReasons).includes("PRIVATE_RECOMMENDATION_STATE_UNAVAILABLE"));
  assert.ok(Array.from(ctx.todayPicks.pauseReasons).includes("MARKET_ONLY_BUILD_LOCKED"));
  assert.match(extractFunction("updateCloudActionAvailability"), /isMarketOnlyBuildPlan\(publicTodayPicks\)/);
  assert.match(extractFunction("addBuy"), /isMarketOnlyBuildPlan\(publicTodayPicks\)/);
  assert.match(extractFunction("submitBatch"), /isMarketOnlyBuildPlan\(publicTodayPicks\)/);
});

test("shadow comparison never turns incomplete real valuation into a fake minus 100 percent", function () {
  const source = extractFunction("renderShadow");
  assert.match(source, /realS\.valuationComplete/);
  assert.match(source, /realRate === null/);
  assert.doesNotMatch(source, /realS\.invested > 0 \? Math\.round\(\(\(realS\.value - realS\.invested\)/);
});

test("stale external signals stay visible with a non-trading disclaimer", function () {
  assert.match(template, /非当日缓存/);
  assert.match(template, /不参与加仓或预算计算/);
});

test("canonical catalog names override stale cloud ledger labels", function () {
  const ctx = loadHelpers(["getHoldingDisplayName"]);
  assert.equal(ctx.getHoldingDisplayName({ code: "017641" }, { name: "摩根标普500指数(QDII)A" }), "摩根标普500指数(QDII)A");
  assert.equal(ctx.getHoldingDisplayName({ code: "015558", name: "大成标普500ETF联接A(QDII)" }, { name: "万家中证红利ETF联接C" }), "万家中证红利ETF联接C");
  assert.equal(ctx.getHoldingDisplayName({ code: "017641", name: "已存名称" }, null), "已存名称");
  assert.equal(ctx.getHoldingDisplayName({ code: "017641" }, null), "017641");
  assert.match(extractFunction("updateHoldings"), /getHoldingDisplayName\(h, fund\)/);
});

test("migration preview requires a valid active Chrome portfolio and shows the verified revision", function () {
  const source = extractFunction("firebaseMigrateChrome");
  assert.match(source, /preview\.rawFundCount/);
  assert.match(source, /preview\.activeFundCount/);
  assert.match(source, /preview\.nextRevision/);
  assert.match(source, /下载迁移备份/);
  assert.match(source, /overwriteWithLegacy\(legacy, preview\)/);
  assert.match(source, /云端 revision=' \+ result\.revision/);
  assert.match(source, /formatMigrationError\(error\)/);
  const errorSource = extractFunction("formatMigrationError");
  assert.match(errorSource, /ETAG_CONFLICT/);
  assert.match(errorSource, /PERMISSION_DENIED/);
});

test("AI connection test and chat use the same normalized chat-completions URL", function () {
  const ctx = loadHelpers(["getAiChatCompletionsUrl"]);
  assert.equal(ctx.getAiChatCompletionsUrl("https://api.example.com/v1"), "https://api.example.com/v1/chat/completions");
  assert.equal(ctx.getAiChatCompletionsUrl("https://api.example.com/v1/chat/completions/"), "https://api.example.com/v1/chat/completions");
  assert.match(extractFunction("testAiConnection"), /fetch\(getAiChatCompletionsUrl\(config\.baseUrl\), \{/);
  assert.match(extractBetweenFunctions("sendAiMessage", "askQuick"), /var apiUrl = getAiChatCompletionsUrl\(config\.baseUrl\);/);
});

test("chat history is scoped to the complete decision, not merely date and action", function () {
  const storage = new Map([
    ["qdii-ai-chat", JSON.stringify([{ role: "assistant", content: "old BUY answer" }])],
    ["qdii-ai-chat-plan", "2026-07-16|BUY|1|1|100|100|0||000001:100"]
  ]);
  const localStorage = {
    getItem: function (key) { return storage.has(key) ? storage.get(key) : null; },
    setItem: function (key, value) { storage.set(key, String(value)); },
    removeItem: function (key) { storage.delete(key); }
  };
  const ctx = loadHelpers(["getPlanFingerprint", "syncChatPlanScope"], { localStorage });
  const changed = ctx.syncChatPlanScope({
    date: "2026-07-17", action: "PAUSE", syncRevision: 2, decisionRevision: 1,
    riskAnchorValue: 1627.35, adjustedRiskAnchorValue: 1627.35, budget: 10,
    blockedStage: null, executionRoutes: [{ code: "017641", amount: 10 }]
  });
  assert.equal(changed, true);
  assert.equal(storage.has("qdii-ai-chat"), false);
  assert.equal(storage.get("qdii-ai-chat-plan"), "2026-07-17|PAUSE|2|1|1627.35|1627.35|10||017641:10");

  storage.set("qdii-ai-chat", JSON.stringify([{ role: "assistant", content: "old anchor-missing answer" }]));
  const anchorChanged = ctx.syncChatPlanScope({
    date: "2026-07-17", action: "PAUSE", syncRevision: 2, decisionRevision: 2,
    riskAnchorValue: 1627.35, adjustedRiskAnchorValue: 1627.35, budget: 10,
    blockedStage: null, executionRoutes: [{ code: "017641", amount: 10 }]
  });
  assert.equal(anchorChanged, true);
  assert.equal(storage.has("qdii-ai-chat"), false);
});

test("anchor status makes an existing public anchor visible without offering setup again", function () {
  const button = { style: {} };
  const status = { textContent: "" };
  const profileSelect = { value: "", disabled: false, title: "" };
  const profileHelp = { textContent: "" };
  const ctx = loadHelpers(["isCanonicalPublicSnapshot", "updateAnchorButton"], {
    window: {
      QDII_PUBLIC_PORTFOLIO_SNAPSHOT: true,
      QDII_PUBLIC_PLAN_CANONICAL: true,
      QDII_PUBLIC_DECISION_STATE: { schemaVersion: 2, revision: 1, riskAnchorValue: 1627.35 }
    },
    document: { getElementById: function (id) {
      if (id === "decision-anchor-btn") return button;
      if (id === "decision-anchor-status") return status;
      if (id === "risk-profile-select") return profileSelect;
      if (id === "risk-profile-help") return profileHelp;
      return null;
    } }
  });
  ctx.updateAnchorButton({
    ledger: { revision: 2 }, decisionState: { revision: 1, riskAnchorValue: 1627.35 }, readOnly: true
  });
  assert.equal(button.style.display, "none");
  assert.match(status.textContent, /已设置/);
  assert.match(status.textContent, /账本 r2/);
  assert.equal(profileSelect.value, "AGGRESSIVE");
  assert.equal(profileSelect.disabled, true);
  assert.match(profileSelect.title, /登录/);
  assert.match(profileHelp.textContent, /不代表择时模型已证明超额/);
});
