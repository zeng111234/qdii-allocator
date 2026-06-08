require("dotenv").config();
var fs = require("fs");
var path = require("path");
var { execSync } = require("child_process");

// 修复Windows终端中文乱码
try {
  if (process.platform === "win32") {
    execSync("chcp 65001", { stdio: "ignore" });
    process.stdout.setDefaultEncoding("utf8");
    process.stderr.setDefaultEncoding("utf8");
  }
} catch(e) {}
var alloc = require("./lib/allocator");
var dyn = require("./lib/dynamic-strategy");
var ai = require("./lib/ai-analyst");
var mail = require("./lib/mailer");
var backtest = require("./lib/backtest");
var fundData = require("./lib/fund-data");
var externalSignalData = require("./lib/external-signals");

var FUNDS_FILE = path.join(__dirname, "data", "funds.json");
var STRATEGY_MAP = {
  "equal": alloc.Strategy.EQUAL,
  "low_fee": alloc.Strategy.LOW_FEE,
  "scarce": alloc.Strategy.SCARCE_FIRST,
  "dynamic": "dynamic"
};

function loadFunds() {
  if (!fs.existsSync(FUNDS_FILE)) { console.error("[error] funds.json not found"); process.exit(1); }
  var data = JSON.parse(fs.readFileSync(FUNDS_FILE, "utf-8"));
  if (!data.funds || data.funds.length === 0) { console.error("[error] funds pool empty"); process.exit(1); }
  return data;
}

function parseArgs() {
  var args = process.argv.slice(2);
  var opts = { dryRun: false, strategy: null, budget: null, backtest: false, backtestDays: 60 };
  for (var i = 0; i < args.length; i++) {
    if (args[i] === "--dry-run") opts.dryRun = true;
    else if (args[i] === "--strategy") opts.strategy = args[++i];
    else if (args[i] === "--budget") opts.budget = parseFloat(args[++i]);
    else if (args[i] === "--backtest") opts.backtest = true;
    else if (args[i] === "--backtest-days") opts.backtestDays = parseInt(args[++i]) || 60;
    else if (args[i] === "--help") {
      console.log("QDII Fund Allocator");
      console.log("  --dry-run            dry run mode");
      console.log("  --strategy <s>       equal|low_fee|scarce|dynamic");
      console.log("  --budget <n>         daily budget");
      console.log("  --backtest           run backtest mode");
      console.log("  --backtest-days <n>  backtest period (default 60)");
      process.exit(0);
    }
  }
  return opts;
}

function normalizeDate(dateStr) {
  // Convert "2026/6/3" or "2026/06/03" to "2026-06-03"
  if (!dateStr) return "";
  var parts = dateStr.replace(/\//g, "-").split("-");
  if (parts.length === 3) {
    return parts[0] + "-" + ("0" + parts[1]).slice(-2) + "-" + ("0" + parts[2]).slice(-2);
  }
  return dateStr.replace(/\//g, "-");
}

function backfillFollowUp() {
  var HISTORY_FILE = path.join(__dirname, "data", "history.json");
  var NAV_CACHE_FILE = path.join(__dirname, "data", "nav-cache.json");
  try {
    if (!fs.existsSync(HISTORY_FILE) || !fs.existsSync(NAV_CACHE_FILE)) return;
    var hist = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf-8"));
    var cache = JSON.parse(fs.readFileSync(NAV_CACHE_FILE, "utf-8"));
    if (!hist.records || hist.records.length === 0) return;
    var changed = false;
    for (var i = 0; i < hist.records.length; i++) {
      var rec = hist.records[i];
      var allocs = rec.allocations || rec.ranked || [];
      for (var j = 0; j < allocs.length; j++) {
        var a = allocs[j];
        if (a.followUp5dReturn !== null && a.followUp10dReturn !== null) continue;
        var navs = cache[a.code];
        if (!navs || navs.length === 0) continue;
        var recDate = normalizeDate(rec.date);
        var recIdx = -1;
        for (var k = 0; k < navs.length; k++) {
          if (navs[k].date === recDate) { recIdx = k; break; }
        }
        if (recIdx < 0) continue;
        // 5d return
        if (a.followUp5dReturn === null && recIdx + 5 < navs.length) {
          a.followUp5dReturn = Math.round((navs[recIdx + 5].nav - navs[recIdx].nav) / navs[recIdx].nav * 10000) / 100;
          changed = true;
        }
        // 10d return
        if (a.followUp10dReturn === null && recIdx + 10 < navs.length) {
          a.followUp10dReturn = Math.round((navs[recIdx + 10].nav - navs[recIdx].nav) / navs[recIdx].nav * 10000) / 100;
          changed = true;
        }
      }
    }
    if (changed) {
      fs.writeFileSync(HISTORY_FILE, JSON.stringify(hist, null, 2), "utf-8");
      console.log("[\u5386\u53f2] \u56de\u586b\u4e86\u5386\u53f2\u63a8\u8350\u7684\u5b9e\u9645\u6536\u76ca");
    }
  } catch(e) {
    console.warn("[\u5386\u53f2] \u56de\u586b\u5931\u8d25:", e.message);
  }
}

async function main() {
  console.log("========================================");
  console.log("  QDII Fund Daily Allocator");
  console.log("========================================");
  console.log("");

  var opts = parseArgs();
  console.log("[1/4] Loading funds...");
  var data = loadFunds();
  var funds = data.funds;
  var config = data.config || {};

  var budget = opts.budget || config.defaultBudget || 20;
  var strategyKey = opts.strategy || config.defaultStrategy || "scarce";
  var strategy = STRATEGY_MAP[strategyKey] || alloc.Strategy.SCARCE_FIRST;

  console.log("  " + funds.length + " funds, budget=" + budget + ", strategy=" + strategyKey);
  console.log("");

  var minPurchase = config.minPurchase || 10;
  var topN = config.topN || 3;

  if (opts.backtest) {
    console.log("[回测模式] 启动策略回测...");
    console.log("");
    await backtest.runBacktest(funds, {
      lookbackDays: 30,
      topN: topN,
      minPurchase: minPurchase,
      backtestDays: opts.backtestDays
    });
    console.log("");
    console.log("回测完成!");
    return;
  }

  var marketSnapshot = [];
  var marketNews = [];
  var externalSignals = null;

  if (strategy === "dynamic") {
    console.log("[2/4] Fetching market/X signals...");
    try {
      marketSnapshot = await fundData.getMarketSnapshot();
      marketNews = await fundData.getMarketSentiment(5);
      if (marketSnapshot.length > 0) {
        console.log("[market] fetched " + marketSnapshot.length + " realtime indices");
      }
      if (marketNews.length > 0) {
        console.log("[news] fetched " + marketNews.length + " market items");
      }
    } catch(e) {
      console.warn("[market] fetch failed:", e.message);
    }
    if (config.enableExternalSignals !== false) {
      externalSignals = await externalSignalData.fetchExternalSignals({
        sourceUrl: config.xSourceUrl || "https://x.com/aleabitoreddit",
        maxScore: config.externalSignalMaxScore || 3,
        xMirrorWhitelist: config.xMirrorWhitelist || [],
        rsshubUrl: config.rsshubUrl || "",
        cacheFile: path.join(__dirname, "data", "external-signals-cache.json")
      });
      if (externalSignals.status === "ok" || externalSignals.status === "cached") {
        console.log("[X] fetched " + externalSignals.items.length + " external posts for scoring (" + (externalSignals.fetchUrl || "cache") + ")");
        // 分析新投资方向
        var directions = externalSignalData.analyzeNewDirections(externalSignals.tickerOpinions || [], funds);
        externalSignals.newDirections = directions;
        if (directions.gapSummary) {
          console.log("[X] 新投资方向缺口: " + directions.gapSummary);
        }
      } else {
        console.warn("[X] " + externalSignals.error);
        if (externalSignals.attempts && externalSignals.attempts.length > 0) {
          for (var si = 0; si < externalSignals.attempts.length; si++) {
            var sa = externalSignals.attempts[si];
            if (sa.status !== "ok") {
              console.warn("[X]   " + sa.status + ": " + sa.url.substring(0, 60) + " (" + (sa.error || "unknown") + ")");
            }
          }
        }
      }
    }
    console.log("");
  }

  console.log("[2/4] Ranking...");
  var lookbackDays = config.lookbackDays || 750;
  var result, textContent;
  if (strategy === "dynamic") {
    result = await dyn.allocateDynamic(budget, funds, {
      lookbackDays: lookbackDays,
      topN: topN,
      minPurchase: minPurchase,
      enableHistory: true,
      externalSignals: externalSignals,
      externalSignalMaxScore: config.externalSignalMaxScore || 3
    });
    textContent = dyn.formatDynamicResult(result);
  } else {
    result = alloc.allocate(budget, funds, strategy, minPurchase);
    textContent = alloc.formatResult(result);
  }
  console.log(textContent);
  console.log("");

  // 回填历史推荐的实际收益
  console.log("[3/4] Fetching market data & backfilling history...");
  backfillFollowUp();

  // 获取实时市场快照和新闻
  var marketSnapshot = [];
  if (strategy !== "dynamic") {
    try {
      marketSnapshot = await fundData.getMarketSnapshot();
      marketNews = await fundData.getMarketSentiment(5);
      if (marketSnapshot.length > 0) {
        console.log("[market] fetched " + marketSnapshot.length + " realtime indices");
      }
      if (marketNews.length > 0) {
        console.log("[news] fetched " + marketNews.length + " market items");
      }
    } catch(e) {
      console.warn("[market] fetch failed:", e.message);
    }
  }

  result.marketSnapshot = marketSnapshot;
  result.marketNews = marketNews;
  result.externalSignals = externalSignals;

  var aiCommentary = "";
  var llmApiKey = process.env.LLM_API_KEY;
  var llmBaseUrl = process.env.LLM_BASE_URL;
  var llmModel = process.env.LLM_MODEL;

  if (llmApiKey && llmBaseUrl && llmModel) {
    console.log("[3/4] AI decision analysis...");
    aiCommentary = await ai.generateCommentary(result, { apiKey: llmApiKey, baseUrl: llmBaseUrl, model: llmModel });
    if (aiCommentary && aiCommentary.length > 10) {
      console.log("[AI\u51b3\u7b56\u62a5\u544a] " + aiCommentary.substring(0, 200) + "...");
    } else {
      console.log("[AI] " + aiCommentary);
    }
  } else {
    console.log("[3/4] AI skipped (no LLM_API_KEY)");
  }
  console.log("");

  if (opts.dryRun) {
    console.log("[4/4] dry-run, skip email");
    console.log("");
    console.log("--- preview ---");
    console.log(textContent);
    if (aiCommentary && aiCommentary.length > 10) {
      console.log("");
      console.log("=== AI Decision Report ===");
      console.log(aiCommentary);
      console.log("=== End AI Report ===");
    }
    console.log("--- end ---");
  } else {
    var smtpHost = process.env.SMTP_HOST;
    var smtpPort = parseInt(process.env.SMTP_PORT || "465");
    var smtpUser = process.env.SMTP_USER;
    var smtpPass = process.env.SMTP_PASS;
    var mailTo = process.env.MAIL_TO;
    if (!smtpHost || !smtpUser || !smtpPass || !mailTo) {
      console.log("[4/4] email skipped (SMTP not configured)");
    } else {
      console.log("[4/4] Sending email...");
      var smtpConfig = { host: smtpHost, port: smtpPort, user: smtpUser, pass: smtpPass };
      var success = await mail.sendEmail({ to: mailTo, subject: "QDII Top" + topN + " " + result.date, textContent: textContent, aiCommentary: aiCommentary, result: result }, smtpConfig);
      if (!success) { console.error("[error] email failed"); process.exit(1); }
    }
  }
  console.log("");
  console.log("Done!");
}

main().catch(function(err) { console.error("[fatal]", err); process.exit(1); });