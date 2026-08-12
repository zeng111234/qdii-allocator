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
  const docsDirectory = path.resolve(__dirname, "..", "docs");
  let server = null;
  let browser = null;

  try {
    let baseUrl = remoteUrl;
    if (!baseUrl) {
      const indexPath = path.join(docsDirectory, "index.html");
      if (!fs.existsSync(indexPath)) throw new Error("docs/index.html 不存在；请先执行 npm run build");
      server = await listen(createStaticServer(docsDirectory));
      baseUrl = "http://127.0.0.1:" + server.address().port + "/";
    }

    browser = await chromium.launch({ executablePath: executablePath, headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: "zh-CN" });
    const page = await context.newPage();
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
      return {
        publicSnapshot: publicSnapshot,
        action: todayPicks && todayPicks.action,
        budget: todayPicks && Number(todayPicks.budget || 0),
        cloudState: document.getElementById("cloud-sync-state").textContent,
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

    const riskAnchor = await runRiskAnchorProbe(page);
    const cloudWriteReadiness = await runCloudWriteReadinessProbe(page);

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
      pageState: pageState,
      catalogIntegrity: catalogIntegrity,
      riskAnchor: riskAnchor,
      cloudWriteReadiness: cloudWriteReadiness,
      xss: xss,
      consoleErrors: 0,
      failedRequests: 0,
      gateScreenshot: gateScreenshot,
      screenshot: mobileScreenshot
    }));
  } finally {
    if (browser) await browser.close();
    await closeServer(server);
  }
}

main().catch(function (error) {
  console.error("[browser-smoke] " + error.stack);
  process.exit(1);
});
