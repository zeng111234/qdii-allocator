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

test("PAUSE keeps the real candidate Top average", function () {
  const ctx = loadHelpers(["getTodayPicksAverage"]);
  assert.equal(ctx.getTodayPicksAverage({ action: "PAUSE", ranked: [{ score: 75.25 }, { score: 64.83 }] }), 70.04);
  assert.equal(ctx.getTodayPicksAverage({ action: "HOLD", ranked: [] }), null);
  assert.match(extractFunction("renderBuySignal"), /getTodayPicksAverage\(todayPicks\)/);
  assert.doesNotMatch(extractFunction("renderBuySignal"), /avgScore\s*=\s*0/);
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
  const ctx = loadHelpers(["isMarketSentimentQuestion", "buildMarketSentimentDisclosure"]);
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
    decisionMode: "TACTICAL_DCA",
    routeDiagnostics: { requestedBudget: 10, allocatedBudget: 0, blockReasons: ["NO_ELIGIBLE_CORE_ROUTE"] },
    signalHealth: { status: "PAUSE", matured: {}, shadow: {} }
  });
  assert.match(details, /没有可执行的低配核心桶通道/);
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

test("stale external signals stay visible with a non-trading disclaimer", function () {
  assert.match(template, /非当日缓存/);
  assert.match(template, /不参与加仓或预算计算/);
});

test("cloud ledger holdings fall back to the public fund name when names are not stored", function () {
  const ctx = loadHelpers(["getHoldingDisplayName"]);
  assert.equal(ctx.getHoldingDisplayName({ code: "017641" }, { name: "摩根标普500指数(QDII)A" }), "摩根标普500指数(QDII)A");
  assert.equal(ctx.getHoldingDisplayName({ code: "017641", name: "已存名称" }, { name: "公共名称" }), "已存名称");
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

test("chat history is scoped to plan date and action", function () {
  const storage = new Map([
    ["qdii-ai-chat", JSON.stringify([{ role: "assistant", content: "old BUY answer" }])],
    ["qdii-ai-chat-plan", "2026-07-16|BUY"]
  ]);
  const localStorage = {
    getItem: function (key) { return storage.has(key) ? storage.get(key) : null; },
    setItem: function (key, value) { storage.set(key, String(value)); },
    removeItem: function (key) { storage.delete(key); }
  };
  const ctx = loadHelpers(["getPlanFingerprint", "syncChatPlanScope"], { localStorage });
  const changed = ctx.syncChatPlanScope({ date: "2026-07-17", action: "PAUSE" });
  assert.equal(changed, true);
  assert.equal(storage.has("qdii-ai-chat"), false);
  assert.equal(storage.get("qdii-ai-chat-plan"), "2026-07-17|PAUSE");
});
