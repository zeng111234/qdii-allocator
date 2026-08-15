"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { chromium } = require("playwright-core");

function findBrowserExecutable() {
  const candidates = [
    process.env["ProgramFiles(x86)"] && path.join(process.env["ProgramFiles(x86)"], "Microsoft", "Edge", "Application", "msedge.exe"),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, "Google", "Chrome", "Application", "chrome.exe"),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe")
  ].filter(Boolean);
  return candidates.find(function (candidate) { return fs.existsSync(candidate); }) || null;
}

function contentType(filePath) {
  return {
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml"
  }[path.extname(filePath).toLowerCase()] || "application/octet-stream";
}

function createStaticServer(rootDirectory) {
  const root = path.resolve(rootDirectory);
  return http.createServer(function (request, response) {
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(request.url, "http://127.0.0.1").pathname);
    } catch (error) {
      response.writeHead(400).end("Bad Request");
      return;
    }
    if (pathname === "/") pathname = "/index.html";
    const target = path.resolve(root, "." + pathname.replace(/\//g, path.sep));
    if (target !== root && !target.startsWith(root + path.sep)) {
      response.writeHead(403).end("Forbidden");
      return;
    }
    fs.stat(target, function (error, stat) {
      if (error || !stat.isFile()) {
        response.writeHead(404).end("Not Found");
        return;
      }
      response.writeHead(200, {
        "Cache-Control": "no-store",
        "Content-Type": contentType(target)
      });
      fs.createReadStream(target).pipe(response);
    });
  });
}

async function listen(server) {
  return new Promise(function (resolve, reject) {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", function () { resolve(server); });
  });
}

async function closeServer(server) {
  if (!server) return;
  await new Promise(function (resolve) { server.close(resolve); });
}

async function unlockSite(page) {
  const gate = page.locator("#site-access-gate");
  const app = page.locator("#site-app");
  const input = page.locator("#site-access-code");
  const error = page.locator("#site-access-error");
  assert.equal(await gate.isVisible(), true, "首次打开应显示访问口令页");
  assert.equal(await app.getAttribute("aria-hidden"), "true");

  const accessCode = String(process.env.SITE_ACCESS_CODE || "0315");
  const wrongCode = accessCode === "0000" ? "9999" : "0000";
  await input.fill(wrongCode);
  await page.locator("#site-access-form button[type=submit]").click();
  await page.waitForFunction(function () {
    return document.getElementById("site-access-error").textContent.includes("不正确");
  });
  assert.match(await error.textContent(), /不正确/);
  assert.equal(await gate.isVisible(), true, "错误口令后应继续显示入口页");

  await input.fill(accessCode);
  await page.locator("#site-access-form button[type=submit]").click();
  await page.waitForFunction(function () {
    return document.documentElement.classList.contains("site-access-unlocked");
  });
  assert.equal(await gate.isVisible(), false, "正确口令后应进入网站");
  assert.equal(await app.getAttribute("aria-hidden"), "false");

  await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(250);
  assert.equal(await gate.isVisible(), false, "同一标签页刷新后应保持已进入状态");
  return { wrongCodeRejected: true, correctCodeAccepted: true, reloadRemembered: true };
}

async function runXssProbes(page) {
  const result = await page.evaluate(async function () {
    const wait = function () { return new Promise(function (resolve) { setTimeout(resolve, 150); }); };
    window.__qdiiXssProbe = 0;

    const originalPortfolio = portfolioData;
    portfolioData = {
      holdings: [{
        code: "019067",
        name: "测试</span><img src=\"data:invalid\" onerror=\"window.__qdiiXssProbe=1\"><span>",
        buys: [{ date: "2026-08-10", amount: 1, nav: 1, shares: 1 }]
      }]
    };
    updateHoldings();
    await wait();
    const holdingsSafe = window.__qdiiXssProbe === 0 && document.querySelectorAll("#holdings img").length === 0;
    portfolioData = originalPortfolio;
    updateHoldings();

    switchTab("insights");
    const originalNews = newsData;
    newsData = {
      fetchedAt: "2026-08-10T00:00:00Z",
      sentiment: { overall: 1, byTheme: {} },
      items: [{
        title: "新闻<img src=\"data:invalid\" onerror=\"window.__qdiiXssProbe=2\">",
        source: "测试</span><img src=\"data:invalid\" onerror=\"window.__qdiiXssProbe=3\">",
        url: "javascript:window.__qdiiXssProbe=4",
        time: "2026-08-10T00:00:00Z",
        _score: 1
      }]
    };
    loadNewsSentiment();
    await wait();
    const newsContainer = document.getElementById("news-sentiment-content");
    const newsSafe = window.__qdiiXssProbe === 0 && newsContainer.querySelectorAll("img").length === 0 &&
      Array.from(newsContainer.querySelectorAll("a")).every(function (link) { return !link.href.startsWith("javascript:"); });
    newsData = originalNews;
    loadNewsSentiment();

    const originalConfig = localStorage.getItem(AI_CONFIG_KEY);
    localStorage.setItem(AI_CONFIG_KEY, JSON.stringify({
      apiKey: "browser-smoke-placeholder",
      model: "模型<img src=\"data:invalid\" onerror=\"window.__qdiiXssProbe=5\">"
    }));
    updateApiStatus();
    await wait();
    const aiStatusSafe = window.__qdiiXssProbe === 0 && document.querySelectorAll("#ai-api-status img").length === 0;
    if (originalConfig === null) localStorage.removeItem(AI_CONFIG_KEY);
    else localStorage.setItem(AI_CONFIG_KEY, originalConfig);
    updateApiStatus();

    renderDailyBrief("早报<img src=\"data:invalid\" onerror=\"window.__qdiiXssProbe=6\">");
    await wait();
    const briefSafe = window.__qdiiXssProbe === 0 && document.querySelectorAll("#daily-brief img").length === 0;

    switchTab("portfolio");
    return { holdingsSafe: holdingsSafe, newsSafe: newsSafe, aiStatusSafe: aiStatusSafe, briefSafe: briefSafe };
  });
  assert.deepStrictEqual(result, {
    holdingsSafe: true,
    newsSafe: true,
    aiStatusSafe: true,
    briefSafe: true
  });
  return result;
}

async function runPendingValuationProbe(page) {
  const result = await page.evaluate(function () {
    const originalPortfolio = portfolioData;
    const originalNav = navCacheData.PENDING_VALUATION_PROBE;
    const originalMissingNav = navCacheData.MISSING_NAV_PROBE;
    const originalSummaryHtml = document.getElementById("summary").innerHTML;
    const originalHoldingsHtml = document.getElementById("holdings").innerHTML;
    portfolioData = {
      holdings: [{
        code: "PENDING_VALUATION_PROBE",
        name: "待确认估值探针",
        buys: [
          { amount: 100, nav: 10, shares: 10 },
          { amount: 50, nav: 0, shares: 0 }
        ]
      }],
      pendingHoldings: [{ code: "PENDING_VALUATION_PROBE", name: "待确认估值探针", totalAmount: 50 }]
    };
    const previousTradingDate = function (fromDate, offset) {
      const cursor = new Date(fromDate + "T00:00:00Z");
      let remaining = offset;
      while (true) {
        const currentDate = cursor.toISOString().slice(0, 10);
        const currentDay = cursor.getUTCDay();
        const isTradingDate = currentDay !== 0 && currentDay !== 6 && tradingHolidays.indexOf(currentDate) < 0;
        if (isTradingDate && remaining === 0) return currentDate;
        if (isTradingDate) remaining--;
        cursor.setUTCDate(cursor.getUTCDate() - 1);
      }
    };
    const today = shanghaiDateString();
    navCacheData.PENDING_VALUATION_PROBE = [
      { date: previousTradingDate(today, 1), nav: 10 },
      { date: previousTradingDate(today, 0), nav: 11 }
    ];
    const summary = calcSummary();

    portfolioData.holdings.push({
      code: "MISSING_NAV_PROBE",
      name: "缺净值探针",
      buys: [{ amount: 200, nav: 10, shares: 20, date: "2026-08-01" }]
    });
    delete navCacheData.MISSING_NAV_PROBE;
    const incomplete = calcSummary();
    updateSummary();
    const summaryText = document.getElementById("summary").textContent;
    updateHoldings();
    const holdingsText = document.getElementById("holdings").textContent;
    const aiContext = buildSystemPrompt("我的持仓风险怎么样？");

    portfolioData = originalPortfolio;
    if (originalNav === undefined) delete navCacheData.PENDING_VALUATION_PROBE;
    else navCacheData.PENDING_VALUATION_PROBE = originalNav;
    if (originalMissingNav === undefined) delete navCacheData.MISSING_NAV_PROBE;
    else navCacheData.MISSING_NAV_PROBE = originalMissingNav;
    document.getElementById("summary").innerHTML = originalSummaryHtml;
    document.getElementById("holdings").innerHTML = originalHoldingsHtml;
    return { summary: summary, incomplete: incomplete, summaryText: summaryText, holdingsText: holdingsText, aiContext: aiContext };
  });
  assert.equal(result.summary.invested, 100, "待确认金额不得计入已确认投入");
  assert.equal(result.summary.value, 110, "待确认金额不得计入当前市值");
  assert.equal(result.summary.pnl, 10, "待确认金额不得扭曲盈亏");
  assert.equal(result.summary.pending, 50, "待确认金额必须单独展示");
  assert.equal(result.incomplete.value, null, "任一确认持仓缺净值时总市值必须不可用");
  assert.equal(result.incomplete.pnl, null, "任一确认持仓缺净值时总盈亏必须不可用");
  assert.match(result.summaryText, /估值不完整/);
  assert.match(result.holdingsText, /估值待补齐/);
  assert.match(result.aiContext, /总盈亏: 估值不完整/);
  return result;
}

async function runClosedPositionProbe(page) {
  const result = await page.evaluate(function () {
    const originalPortfolio = portfolioData;
    const originalSummaryHtml = document.getElementById("summary").innerHTML;
    const originalHoldingsHtml = document.getElementById("holdings").innerHTML;
    const originalAttributionHtml = document.getElementById("attribution-content").innerHTML;
    portfolioData = {
      holdings: [],
      pendingHoldings: [],
      closedPositions: [{ code: "CLOSED_POSITION_PROBE", investedAmount: 100, realizedPnl: 20 }],
      closedRealizedPnl: 20
    };
    const summary = calcSummary();
    updateSummary();
    updateHoldings();
    const summaryText = document.getElementById("summary").textContent;
    const holdingsText = document.getElementById("holdings").textContent;
    const aiContext = buildSystemPrompt("我的总收益是多少？");

    const today = shanghaiDateString();
    const previous = new Date(today + "T00:00:00Z");
    previous.setUTCDate(previous.getUTCDate() - 1);
    const previousDate = previous.toISOString().slice(0, 10);
    portfolioData = {
      holdings: [{ code: "ACTIVE_ATTRIBUTION_PROBE", buys: [{ amount: 100, shares: 10 }] }],
      pendingHoldings: [],
      closedPositions: [{ code: "CLOSED_POSITION_PROBE", name: "Closed Probe", investedAmount: 100, realizedPnl: 20 }],
      closedRealizedPnl: 20
    };
    runAttribution({ ACTIVE_ATTRIBUTION_PROBE: { [previousDate]: 10, [today]: 11 } },
      ["ACTIVE_ATTRIBUTION_PROBE"], [previousDate, today]);
    const attributionText = document.getElementById("attribution-content").textContent;

    portfolioData = originalPortfolio;
    document.getElementById("summary").innerHTML = originalSummaryHtml;
    document.getElementById("holdings").innerHTML = originalHoldingsHtml;
    document.getElementById("attribution-content").innerHTML = originalAttributionHtml;
    return {
      summary: summary, summaryText: summaryText, holdingsText: holdingsText,
      aiContext: aiContext, attributionText: attributionText
    };
  });
  assert.equal(result.summary.value, 0, "完全清仓后的当前市值应为 0");
  assert.equal(result.summary.pnl, 20, "完全清仓后的总盈亏必须保留已实现收益");
  assert.equal(result.summary.realizedPnl, 20, "完全清仓后的已实现盈亏必须保留");
  assert.equal(result.summary.closedCount, 1, "完全清仓头寸应保留记录计数");
  assert.match(result.summaryText, /总盈亏\+20/);
  assert.match(result.holdingsText, /已清仓 1 只/);
  assert.match(result.holdingsText, /累计已实现盈亏 \+20 元/);
  assert.match(result.aiContext, /总盈亏: 20\.00元/);
  assert.match(result.aiContext, /已清仓头寸: 1只, 累计已实现盈亏: \+20\.00元/);
  assert.match(result.attributionText, /Closed Probe.*已清仓/s);
  assert.match(result.attributionText, /合计.*\+30/s);
  return result;
}

async function runRiskAnchorProbe(page) {
  const button = page.locator("#decision-anchor-btn");
  if (!(await button.isVisible())) return { applicable: false };

  const readState = function () {
    return page.evaluate(function () {
      return {
        action: todayPicks.action,
        budget: Number(todayPicks.budget || 0),
        blockedStage: todayPicks.blockedStage || null,
        riskAnchorValue: Number(todayPicks.riskAnchorValue || 0),
        anchorStatus: document.getElementById("decision-anchor-status").textContent
      };
    });
  };

  const before = await readState();
  assert.equal(before.blockedStage, "RISK_ANCHOR_SETUP");
  page.once("dialog", function (dialog) { dialog.accept(); });
  await button.click();
  await page.waitForFunction(function () { return todayPicks.blockedStage !== "RISK_ANCHOR_SETUP"; }, null, { timeout: 10000 });
  const after = await readState();
  assert.ok(after.riskAnchorValue > 0);
  assert.equal(after.blockedStage, null);

  await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(2500);
  const afterReload = await readState();
  assert.equal(afterReload.riskAnchorValue, after.riskAnchorValue);
  assert.equal(afterReload.action, after.action);
  assert.equal(afterReload.budget, after.budget);
  assert.equal(afterReload.blockedStage, null);
  return { applicable: true, before: before, after: after, afterReload: afterReload };
}

function createSmokeLedger(sourcePortfolio) {
  const { migrateLegacyPortfolio } = require("../lib/portfolio-ledger");
  return migrateLegacyPortfolio(sourcePortfolio, {
    revision: 1,
    updatedAt: "2026-08-12T00:00:00.000Z"
  });
}

async function runRiskProfileProbe(page) {
  const select = page.locator("#risk-profile-select");
  assert.equal(await select.count(), 1, "风险档位选择器应存在且唯一");
  assert.equal(await select.isEnabled(), true, "设置风险锚点后风险档位应可切换");

  const readState = function () {
    return page.evaluate(function () {
      return {
        selected: document.getElementById("risk-profile-select").value,
        saved: currentCloudDetail && currentCloudDetail.decisionState && currentCloudDetail.decisionState.riskProfile,
        plan: todayPicks && todayPicks.riskProfile,
        action: todayPicks && todayPicks.action,
        expectedEdge: todayPicks && todayPicks.expectedEdge,
        help: document.getElementById("risk-profile-help").textContent
      };
    });
  };

  const initial = await readState();
  assert.equal(initial.selected, "AGGRESSIVE");
  assert.equal(initial.saved, "AGGRESSIVE");
  assert.equal(initial.plan, "AGGRESSIVE");
  assert.equal(initial.action, "STRATEGIC_DCA");
  assert.equal(initial.expectedEdge, "HIGHER_EXPECTED_BETA_NOT_PROVEN_ALPHA");
  assert.match(initial.help, /不代表择时模型已证明超额/);

  page.once("dialog", function (dialog) { dialog.accept(); });
  await select.selectOption("BALANCED");
  await page.waitForFunction(function () {
    return todayPicks && todayPicks.riskProfile === "BALANCED";
  }, null, { timeout: 10000 });
  const balanced = await readState();
  assert.equal(balanced.selected, "BALANCED");
  assert.equal(balanced.saved, "BALANCED");
  assert.equal(balanced.action, "TACTICAL_PAUSE");
  assert.match(balanced.help, /均衡型降低单一市场集中度/);

  page.once("dialog", function (dialog) { dialog.accept(); });
  await select.selectOption("AGGRESSIVE");
  await page.waitForFunction(function () {
    return todayPicks && todayPicks.riskProfile === "AGGRESSIVE";
  }, null, { timeout: 10000 });
  const restored = await readState();
  assert.equal(restored.selected, "AGGRESSIVE");
  assert.equal(restored.saved, "AGGRESSIVE");
  assert.equal(restored.action, "STRATEGIC_DCA");

  await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(2500);
  const afterReload = await readState();
  assert.equal(afterReload.selected, "AGGRESSIVE");
  assert.equal(afterReload.saved, "AGGRESSIVE");
  assert.equal(afterReload.plan, "AGGRESSIVE");
  assert.equal(afterReload.action, "STRATEGIC_DCA");
  return { initial: initial, balanced: balanced, restored: restored, afterReload: afterReload };
}

async function runCloudWriteReadinessProbe(page) {
  const result = await page.evaluate(function () {
    cloudWriteReady = true;
    renderCloudState({ status: "READY", source: "browser-smoke-ready", revision: 1 });
    const ready = ["cloud-migrate-btn", "cloud-refresh-btn", "portfolio-import-btn", "buy-submit-btn", "batch-submit-btn"]
      .every(function (id) { return document.getElementById(id).disabled === false; });
    cloudWriteReady = false;
    renderCloudState({ status: "PUBLIC_SNAPSHOT", source: "公开账本快照", canSignIn: false });
    const restored = ["cloud-migrate-btn", "cloud-refresh-btn", "portfolio-import-btn", "buy-submit-btn", "batch-submit-btn"]
      .every(function (id) { return document.getElementById(id).disabled === true; });
    return { readyControlsEnabled: ready, publicSnapshotRestored: restored };
  });
  assert.deepStrictEqual(result, { readyControlsEnabled: true, publicSnapshotRestored: true });
  return result;
}

async function main() {
  const executablePath = findBrowserExecutable();
  if (!executablePath) throw new Error("未找到本机 Edge 或 Chrome，无法执行真实浏览器验收");

  const remoteUrl = String(process.env.WEBSITE_URL || "").trim();
  const useGeneratedState = process.env.BROWSER_SMOKE_USE_GENERATED_STATE === "1" || Boolean(remoteUrl);
  const docsDirectory = path.resolve(__dirname, "..", "docs");
  let server = null;
  let browser = null;
  let smokeDirectory = null;

  try {
    let baseUrl = remoteUrl;
    if (!baseUrl) {
      const indexPath = path.join(docsDirectory, "index.html");
      if (!fs.existsSync(indexPath)) throw new Error("docs/index.html 不存在；请先执行 npm run build");
      smokeDirectory = fs.mkdtempSync(path.join(__dirname, "..", "tmp-browser-smoke-"));
      fs.cpSync(docsDirectory, smokeDirectory, { recursive: true });
      const smokeIndexPath = path.join(smokeDirectory, "index.html");
      let smokeHtml = fs.readFileSync(smokeIndexPath, "utf8");
      if (!useGeneratedState) {
        const sourcePortfolio = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "portfolio.json"), "utf8"));
        smokeHtml = smokeHtml
          .replace(
            /window\.QDII_PUBLIC_PORTFOLIO_LEDGER = .*?;/,
            "window.QDII_PUBLIC_PORTFOLIO_LEDGER = " + JSON.stringify(createSmokeLedger(sourcePortfolio)) + ";"
          )
          .replace(/window\.QDII_PUBLIC_DECISION_STATE = .*?;/, "window.QDII_PUBLIC_DECISION_STATE = null;")
          .replace(/window\.QDII_PUBLIC_PLAN_CANONICAL = .*?;/, "window.QDII_PUBLIC_PLAN_CANONICAL = false;");
      }
      fs.writeFileSync(smokeIndexPath, smokeHtml, "utf8");
      server = await listen(createStaticServer(smokeDirectory));
      baseUrl = "http://127.0.0.1:" + server.address().port + "/";
    }

    browser = await chromium.launch({ executablePath: executablePath, headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: "zh-CN" });
    const page = await context.newPage();
    if (!remoteUrl) {
      await page.route("https://unpkg.com/lightweight-charts@4/**", function (route) {
        return route.fulfill({
          status: 200,
          contentType: "text/javascript; charset=utf-8",
          body: "/* Offline smoke: chart CDN is optional and the page must degrade cleanly. */"
        });
      });
    }
    const consoleErrors = [];
    const failedRequests = [];
    page.on("console", function (message) {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("pageerror", function (error) { consoleErrors.push("pageerror: " + error.message); });
    page.on("requestfailed", function (request) {
      failedRequests.push({ url: request.url(), error: request.failure() && request.failure().errorText });
    });

    const response = await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    assert.ok(response && response.ok(), "网站首页应返回 2xx");
    await page.evaluate(function () { sessionStorage.removeItem("qdii-site-access-v1"); });
    const resetResponse = await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 });
    assert.ok(resetResponse && resetResponse.ok(), "重置入口会话后网站首页应返回 2xx");
    await page.waitForTimeout(remoteUrl ? 4500 : 2500);
    assert.equal(await page.title(), "QDII Fund Allocator");
    const gateScreenshotPath = String(process.env.BROWSER_SMOKE_GATE_SCREENSHOT || "").trim();
    let gateScreenshot = null;
    if (gateScreenshotPath) {
      await page.setViewportSize({ width: 390, height: 844 });
      fs.mkdirSync(path.dirname(gateScreenshotPath), { recursive: true });
      await page.screenshot({ path: gateScreenshotPath, fullPage: false });
      gateScreenshot = gateScreenshotPath;
      await page.setViewportSize({ width: 1440, height: 1000 });
    }
    const accessGate = await unlockSite(page);
    await page.waitForTimeout(remoteUrl ? 2500 : 500);

    const tabs = page.locator(".tab");
    assert.equal(await tabs.count(), 9, "网站应有 9 个主功能页签");
    assert.deepStrictEqual(await tabs.evaluateAll(function (nodes) {
      return nodes.map(function (node) { return node.tagName; });
    }), Array(9).fill("BUTTON"));

    const tabIds = ["portfolio", "buy", "batch", "insights", "risk", "ranking", "debate", "shadow", "ai"];
    for (let index = 0; index < tabIds.length; index++) {
      await tabs.nth(index).click();
      await page.waitForTimeout(index >= 3 && index <= 5 ? 700 : 80);
      assert.equal(await page.locator(".tab.active").count(), 1);
      assert.equal(await page.locator(".tab-content.active").getAttribute("id"), "tab-" + tabIds[index]);
      assert.ok((await page.locator(".tab-content.active").innerText()).trim().length > 0);
    }

    await tabs.nth(0).focus();
    await page.keyboard.press("ArrowRight");
    assert.equal(await page.evaluate(function () { return document.activeElement && document.activeElement.id; }), "tab-control-buy");
    assert.equal(await tabs.nth(1).getAttribute("aria-selected"), "true");

    const xss = await runXssProbes(page);
    const pendingValuation = await runPendingValuationProbe(page);
    const closedPosition = await runClosedPositionProbe(page);
    const catalogIntegrity = await page.evaluate(function () {
      const byCode = Object.fromEntries(fundsData.funds.map(function (fund) { return [fund.code, fund]; }));
      return {
        domesticDividend: {
          name: byCode["015558"].name,
          indexGroup: byCode["015558"].indexGroup,
          status: byCode["015558"].status
        },
        sp500EqualWeight: {
          name: byCode["096001"].name,
          indexGroup: byCode["096001"].indexGroup
        },
        domesticBond: {
          name: byCode["019067"].name,
          indexGroup: byCode["019067"].indexGroup,
          status: byCode["019067"].status
        },
        oilFund: {
          name: byCode["163208"].name,
          indexGroup: byCode["163208"].indexGroup
        },
        blockedRecommendationCodes: (todayPicks.ranked || []).filter(function (fund) {
          return ["015558", "019067", "096001"].includes(fund.code);
        }).map(function (fund) { return fund.code; })
      };
    });
    assert.match(catalogIntegrity.domesticDividend.name, /万家中证红利/);
    assert.deepStrictEqual(catalogIntegrity.domesticDividend, {
      name: catalogIntegrity.domesticDividend.name,
      indexGroup: "CN_DIVIDEND",
      status: "tracking_only"
    });
    assert.match(catalogIntegrity.sp500EqualWeight.name, /标普500等权重/);
    assert.equal(catalogIntegrity.sp500EqualWeight.indexGroup, "SPX500_EQUAL_WEIGHT");
    assert.match(catalogIntegrity.domesticBond.name, /博时安盈债券E/);
    assert.equal(catalogIntegrity.domesticBond.indexGroup, "CN_SHORT_BOND");
    assert.equal(catalogIntegrity.domesticBond.status, "tracking_only");
    assert.match(catalogIntegrity.oilFund.name, /诺安油气能源/);
    assert.equal(catalogIntegrity.oilFund.indexGroup, "OIL");
    assert.deepStrictEqual(catalogIntegrity.blockedRecommendationCodes, []);
    const pageState = await page.evaluate(function () {
      const publicSnapshot = window.QDII_PUBLIC_PORTFOLIO_SNAPSHOT === true;
      const candidates = (todayPicks && todayPicks.candidates) || [];
      const routes = (todayPicks && todayPicks.executionRoutes) || [];
      return {
        publicSnapshot: publicSnapshot,
        canonical: window.QDII_PUBLIC_PLAN_CANONICAL === true,
        embeddedDecisionStateValid: !!(window.QDII_PUBLIC_DECISION_STATE &&
          Number(window.QDII_PUBLIC_DECISION_STATE.riskAnchorValue) > 0 &&
          Number(window.QDII_PUBLIC_DECISION_STATE.riskAnchorLedgerRevision) > 0),
        personalized: todayPicks && todayPicks.personalized === true,
        routeParity: JSON.stringify(candidates.map(function (item) {
          return [item.code, Number(item.proposedAmount || item.amount || 0)];
        })) === JSON.stringify(routes.map(function (item) {
          return [item.code, Number(item.proposedAmount || item.amount || 0)];
        })),
        action: todayPicks && todayPicks.action,
        budget: todayPicks && Number(todayPicks.budget || 0),
        cloudState: document.getElementById("cloud-sync-state").textContent,
        buyHint: document.getElementById("buy-write-hint").textContent,
        riskProfileDisabled: document.getElementById("risk-profile-select").disabled,
        anchorVisible: document.getElementById("decision-anchor-btn").offsetParent !== null,
        disabled: {
          migrate: document.getElementById("cloud-migrate-btn").disabled,
          refresh: document.getElementById("cloud-refresh-btn").disabled,
          importPortfolio: document.getElementById("portfolio-import-btn").disabled,
          buy: document.getElementById("buy-submit-btn").disabled,
          batch: document.getElementById("batch-submit-btn").disabled
        }
      };
    });
    if (pageState.publicSnapshot) {
      assert.deepStrictEqual(pageState.disabled, {
        migrate: true,
        refresh: true,
        importPortfolio: true,
        buy: true,
        batch: true
      });
    }
    if (pageState.publicSnapshot) {
      assert.match(pageState.buyHint, /0315 仅用于进入网站/);
      assert.match(pageState.buyHint, /Google 登录和云端账本校验/);
    } else {
      assert.match(pageState.buyHint, /仅含行情数据/);
      assert.match(pageState.buyHint, /登录不会恢复买入计划/);
      assert.equal(pageState.disabled.buy, true, "market-only 页面必须禁用确认买入");
      assert.equal(pageState.disabled.batch, true, "market-only 页面必须禁用批量确认");
    }

    const nonTradingBanner = await page.evaluate(function () {
      const today = shanghaiDateString();
      const existingIndex = tradingHolidays.indexOf(today);
      if (existingIndex < 0) tradingHolidays.push(today);
      renderTradeBanner();
      const text = document.getElementById("trade-banner").textContent;
      if (existingIndex < 0) tradingHolidays.splice(tradingHolidays.indexOf(today), 1);
      renderTradeBanner();
      return text;
    });
    assert.match(nonTradingBanner, /不可按今日计划买入/);
    assert.doesNotMatch(nonTradingBanner, /可以买入/);

    let riskAnchor;
    let riskProfile;
    let cloudWriteReadiness;
    let failClosedPlanProbes = { applicable: false };
    if (useGeneratedState) {
      assert.equal(pageState.publicSnapshot, true, "成品验收必须嵌入公开账本快照");
      assert.equal(pageState.canonical, true, "成品验收必须使用构建时唯一计划");
      assert.equal(pageState.embeddedDecisionStateValid, true, "成品验收必须嵌入有效风险锚点");
      assert.equal(pageState.personalized, true, "成品验收必须展示个性化计划");
      assert.equal(pageState.routeParity, true, "候选基金与实际执行路线必须完全一致");
      assert.equal(pageState.riskProfileDisabled, true, "公开只读成品不得在本地改写风险档位");
      assert.equal(pageState.anchorVisible, false, "公开只读成品不得显示本地风险锚点按钮");
      const canonicalPlanStable = await page.evaluate(function () {
        const before = JSON.stringify(todayPicks);
        refreshPersonalizedPlan(currentCloudDetail);
        return before === JSON.stringify(todayPicks) && todayPicks === publicTodayPicks;
      });
      assert.equal(canonicalPlanStable, true, "浏览器不得重新计算或覆盖构建时计划");
      failClosedPlanProbes = await page.evaluate(function () {
        const originalDetail = currentCloudDetail;
        const originalPlan = publicTodayPicks;
        const originalCanonicalFlag = window.QDII_PUBLIC_PLAN_CANONICAL;
        const originalCloudWriteReady = cloudWriteReady;
        const today = shanghaiDateString();
        const shiftDate = function (days) {
          const date = new Date(today + "T00:00:00Z");
          date.setUTCDate(date.getUTCDate() + days);
          return date.toISOString().slice(0, 10);
        };
        const actionableProbePlan = function (date) {
          const candidate = {
            code: "000834", name: "日期保护探针", proposedAmount: 10,
            marketScore: 50, reasons: ["browser-smoke"]
          };
          return Object.assign({}, originalPlan, {
            asOf: date, date: date, action: "STRATEGIC_DCA", budget: 10,
            generatedAt: new Date(date + "T10:00:00+08:00").toISOString(),
            validFrom: new Date(date + "T09:00:00+08:00").toISOString(),
            validUntil: new Date(date + "T14:00:00+08:00").toISOString(),
            candidates: [candidate], ranked: [candidate],
            executionRoutes: [{ code: candidate.code, name: candidate.name, amount: 10 }]
          });
        };
        cloudWriteReady = true;

        refreshPersonalizedPlan({
          readOnly: false,
          ledger: Object.assign({}, originalDetail.ledger, { revision: Number(originalDetail.ledger.revision) + 1, checksum: "revision-mismatch" }),
          decisionState: Object.assign({}, originalDetail.decisionState, { revision: Number(originalDetail.decisionState.revision) + 1 }),
          strategyState: { latestPlan: { asOf: "2099-01-01", action: "BUY", budget: 999999 } }
        });
        const revisionMismatch = todayPicks.action === "HARD_PAUSE" && Number(todayPicks.budget) === 0 &&
          todayPicks.pauseReasons.includes("PLAN_INPUT_REVISION_MISMATCH") &&
          document.getElementById("buy-submit-btn").disabled && document.getElementById("batch-submit-btn").disabled;

        publicTodayPicks = actionableProbePlan(shiftDate(-1));
        refreshPersonalizedPlan(originalDetail);
        const stalePlan = todayPicks.action === "HARD_PAUSE" && Number(todayPicks.budget) === 0 &&
          todayPicks.pauseReasons.includes("PLAN_DATE_STALE") && canonicalPlanDateMismatch === true &&
          document.getElementById("buy-submit-btn").disabled;

        publicTodayPicks = actionableProbePlan(shiftDate(1));
        refreshPersonalizedPlan(originalDetail);
        const futurePlan = todayPicks.action === "HARD_PAUSE" && Number(todayPicks.budget) === 0 &&
          todayPicks.pauseReasons.includes("PLAN_DATE_FUTURE") && canonicalPlanDateMismatch === true &&
          document.getElementById("buy-submit-btn").disabled;

        const currentProbe = actionableProbePlan(today);
        const afterClose = new Date(currentProbe.validUntil);
        afterClose.setUTCMinutes(afterClose.getUTCMinutes() + 1);
        const expiredWindow = planExecutionWindowStatus(currentProbe, afterClose).reason === "PLAN_WINDOW_EXPIRED" &&
          actionAllowsPurchase(currentProbe, afterClose) === false;

        window.QDII_PUBLIC_PLAN_CANONICAL = false;
        publicTodayPicks = {
          asOf: today, date: today, action: "HARD_PAUSE", budget: 0,
          blockedStage: "PRIVATE_STATE_VALIDATION",
          pauseReasons: ["PRIVATE_RECOMMENDATION_STATE_UNAVAILABLE"],
          candidates: [], ranked: [], executionRoutes: [],
          dataFreshness: { status: "MARKET_ONLY" }
        };
        refreshPersonalizedPlan(Object.assign({}, originalDetail, {
          readOnly: false,
          strategyState: { latestPlan: { asOf: today, action: "BUY", budget: 999999 } }
        }));
        const marketOnlyLocked = todayPicks.action === "HARD_PAUSE" && Number(todayPicks.budget) === 0 &&
          todayPicks.pauseReasons.includes("MARKET_ONLY_BUILD_LOCKED") && todayPicks.personalized === false &&
          document.getElementById("buy-submit-btn").disabled && document.getElementById("batch-submit-btn").disabled;

        window.QDII_PUBLIC_PLAN_CANONICAL = originalCanonicalFlag;
        publicTodayPicks = originalPlan;
        cloudWriteReady = originalCloudWriteReady;
        refreshPersonalizedPlan(originalDetail);
        const restored = todayPicks === publicTodayPicks && canonicalPlanInputMismatch === false && canonicalPlanDateMismatch === false;
        return {
          revisionMismatch: revisionMismatch,
          stalePlan: stalePlan,
          futurePlan: futurePlan,
          expiredWindow: expiredWindow,
          marketOnlyLocked: marketOnlyLocked,
          restored: restored
        };
      });
      assert.deepStrictEqual(failClosedPlanProbes, {
        revisionMismatch: true,
        stalePlan: true,
        futurePlan: true,
        expiredWindow: true,
        marketOnlyLocked: true,
        restored: true
      }, "登录后的修订变化、旧/未来计划及 market-only 构建都必须硬暂停，且不得被 strategyState 复活");
      riskAnchor = { applicable: false, reason: "canonical-public-plan" };
      riskProfile = { applicable: false, reason: "canonical-public-plan" };
      cloudWriteReadiness = { applicable: false, reason: "canonical-public-plan" };
    } else if (!pageState.publicSnapshot) {
      assert.equal(pageState.action, "HARD_PAUSE", "market-only 页面必须硬暂停");
      assert.equal(pageState.budget, 0, "market-only 页面预算必须为 0");
      assert.equal(pageState.riskProfileDisabled, true, "market-only 页面不得修改风险档位");
      assert.equal(pageState.anchorVisible, false, "market-only 页面不得设置无账本风险锚点");
      assert.equal(pageState.disabled.buy, true, "market-only 页面必须禁用确认买入");
      assert.equal(pageState.disabled.batch, true, "market-only 页面必须禁用批量确认");
      riskAnchor = { applicable: false, reason: "market-only-build" };
      riskProfile = { applicable: false, reason: "market-only-build" };
      cloudWriteReadiness = { applicable: false, reason: "market-only-build" };
    } else {
      await page.locator("#tab-control-portfolio").click();
      riskAnchor = await runRiskAnchorProbe(page);
      await page.locator("#tab-control-risk").click();
      riskProfile = await runRiskProfileProbe(page);
      cloudWriteReadiness = await runCloudWriteReadinessProbe(page);
    }

    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(150);
    const mobileLayout = await page.evaluate(function () {
      return {
        viewportWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
        overflowElements: Array.from(document.querySelectorAll("body *")).map(function (element) {
          const box = element.getBoundingClientRect();
          return {
            tag: element.tagName, id: element.id, className: String(element.className || ""),
            parentId: element.parentElement && element.parentElement.id,
            parentClass: String(element.parentElement && element.parentElement.className || ""),
            text: String(element.textContent || "").trim().slice(0, 40),
            left: box.left, right: box.right, width: box.width
          };
        }).filter(function (element) {
          return element.right > document.documentElement.clientWidth + 1 || element.left < -1;
        }).slice(0, 20),
        minimumTabHeight: Math.min.apply(null, Array.from(document.querySelectorAll(".tab")).map(function (tab) {
          return tab.getBoundingClientRect().height;
        }))
      };
    });
    assert.ok(mobileLayout.scrollWidth <= mobileLayout.viewportWidth,
      "390px 视口不应出现横向溢出: " + JSON.stringify(mobileLayout.overflowElements));
    assert.ok(mobileLayout.minimumTabHeight >= 44, "页签触控高度应至少为 44px");

    await page.locator("#tab-control-buy").click();
    const mobileInteraction = await page.evaluate(function () {
      const submit = document.getElementById("buy-submit-btn");
      const select = document.getElementById("fundSelect");
      const submitBox = submit.getBoundingClientRect();
      const selectBox = select.getBoundingClientRect();
      return {
        activeTab: document.querySelector(".tab-content.active").id,
        submitHeight: submitBox.height,
        submitWithinViewport: submitBox.left >= 0 && submitBox.right <= document.documentElement.clientWidth + 1,
        selectWithinViewport: selectBox.left >= 0 && selectBox.right <= document.documentElement.clientWidth + 1,
        submitAriaDisabled: submit.getAttribute("aria-disabled")
      };
    });
    assert.equal(mobileInteraction.activeTab, "tab-buy", "390px 下买入页签必须可点击切换");
    assert.ok(mobileInteraction.submitHeight >= 44, "390px 下确认按钮触控高度应至少为 44px");
    assert.equal(mobileInteraction.submitWithinViewport, true, "390px 下确认按钮必须完整可见");
    assert.equal(mobileInteraction.selectWithinViewport, true, "390px 下基金选择器必须完整可见");

    await page.locator("#tab-control-portfolio").click();
    const screenshotPath = String(process.env.BROWSER_SMOKE_SCREENSHOT || "").trim();
    let mobileScreenshot = null;
    if (screenshotPath) {
      fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
      await page.screenshot({ path: screenshotPath, fullPage: true });
      mobileScreenshot = screenshotPath;
    }

    assert.deepStrictEqual(consoleErrors, [], "浏览器控制台不应出现错误；失败请求=" + JSON.stringify(failedRequests));
    assert.deepStrictEqual(failedRequests, [], "浏览器不应出现失败请求");
    console.log(JSON.stringify({
      status: "ok",
      target: remoteUrl ? "remote" : "local-build",
      url: baseUrl,
      browser: path.basename(executablePath),
      tabs: tabIds.length,
      keyboardTabs: true,
      accessGate: accessGate,
      mobileLayout: mobileLayout,
      mobileInteraction: mobileInteraction,
      pageState: pageState,
      failClosedPlanProbes: failClosedPlanProbes,
      catalogIntegrity: catalogIntegrity,
      riskAnchor: riskAnchor,
      riskProfile: riskProfile,
      cloudWriteReadiness: cloudWriteReadiness,
      xss: xss,
      pendingValuation: pendingValuation,
      closedPosition: closedPosition,
      consoleErrors: 0,
      failedRequests: 0,
      gateScreenshot: gateScreenshot,
      screenshot: mobileScreenshot
    }));
  } finally {
    if (browser) await browser.close();
    await closeServer(server);
    if (smokeDirectory) fs.rmSync(smokeDirectory, { recursive: true, force: true });
  }
}

main().catch(function (error) {
  console.error("[browser-smoke] " + error.stack);
  process.exit(1);
});
