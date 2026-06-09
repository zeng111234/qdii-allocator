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
var portfolio = require("./lib/portfolio");
var risk = require("./lib/risk");
var alternatives = require("./lib/alternatives");
var webServer = require("./lib/web-server");

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
  var opts = { dryRun: false, strategy: null, budget: null, backtest: false, backtestDays: 60, portfolio: false, buy: null, optimizeWeights: false, quickAdd: null, importFile: null, today: false, web: false, webPort: 3000 };
  for (var i = 0; i < args.length; i++) {
    if (args[i] === "--dry-run") opts.dryRun = true;
    else if (args[i] === "--strategy") opts.strategy = args[++i];
    else if (args[i] === "--budget") opts.budget = parseFloat(args[++i]);
    else if (args[i] === "--backtest") opts.backtest = true;
    else if (args[i] === "--backtest-days") opts.backtestDays = parseInt(args[++i]) || 60;
    else if (args[i] === "--portfolio") opts.portfolio = true;
    else if (args[i] === "--web") { opts.web = true; if (args[i + 1] && /^\d+$/.test(args[i + 1])) { opts.webPort = parseInt(args[++i]); } }
    else if (args[i] === "--buy") {
      var buyCode = args[++i];
      var buyAmount = parseFloat(args[++i]);
      var buyNav = null;
      var buyDate = null;
      // 解析可选的 nav 和 date 参数（先检查日期格式，因为 parseFloat 会把日期解析为数字）
      if (args[i + 1] && /^\d{4}[-\/]\d{1,2}[-\/]\d{1,2}$/.test(args[i + 1])) {
        buyDate = normalizeDate(args[++i]);
      } else if (args[i + 1] && !isNaN(parseFloat(args[i + 1])) && !/^\d{4}[-\/]/.test(args[i + 1])) {
        buyNav = parseFloat(args[++i]);
        // nav 之后可能还有日期
        if (args[i + 1] && /^\d{4}[-\/]\d{1,2}[-\/]\d{1,2}$/.test(args[i + 1])) {
          buyDate = normalizeDate(args[++i]);
        }
      }
      opts.buy = { code: buyCode, amount: buyAmount, nav: buyNav, date: buyDate };
    }
    else if (args[i] === "--optimize-weights") opts.optimizeWeights = true;
    else if (args[i] === "--quick-add") opts.quickAdd = args[++i];
    else if (args[i] === "--import-file") opts.importFile = args[++i] || "data/buys.txt";
    else if (args[i] === "--today") opts.today = true;
    else if (args[i] === "--delete") opts.delete = args[++i];
    else if (args[i] === "--delete-all") opts.deleteAll = true;
    else if (args[i] === "--help") {
      console.log("QDII Fund Allocator");
      console.log("  --dry-run              dry run mode");
      console.log("  --strategy <s>         equal|low_fee|scarce|dynamic");
      console.log("  --budget <n>           daily budget");
      console.log("  --backtest             run backtest mode");
      console.log("  --backtest-days <n>    backtest period (default 60)");
      console.log("  --portfolio            view current holdings");
      console.log("  --buy <code> <amount> [nav] [date]  record a buy (date: YYYY-MM-DD, auto-calculates T+2 trading days)");
      console.log("  --quick-add \"code amt [nav] [date], ...\"  batch record buys (auto-settlement T+2 trading days)");
      console.log("  --import-file [path]   import buys from text file (default data/buys.txt, auto-settlement T+2 trading days)");
      console.log("  --today                show today's recommended funds with buy commands");
      console.log("  --optimize-weights     run weight optimization");
      console.log("  --web [port]           start web UI (default port 3000)");
      console.log("  --delete <code>        delete all buys for a fund code");
      console.log("  --delete-all           delete all holdings (reset portfolio)");
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

  // 快捷命令：查看持仓
  if (opts.portfolio) {
    var calcResult = portfolio.calcPortfolioSummary();
    console.log(portfolio.formatPortfolioReport(calcResult));
    return;
  }

  // 快捷命令：记录买入
  if (opts.buy) {
    var buyData = loadFunds();
    var fund = buyData.funds.find(function(f) { return f.code === opts.buy.code; });
    var fundName = fund ? fund.name : opts.buy.code;
    var settleDays = fund ? fund.settleDays : 2;
    portfolio.recordBuy(opts.buy.code, fundName, opts.buy.amount, opts.buy.nav, opts.buy.date, settleDays);
    console.log("");
    var buyCalcResult = portfolio.calcPortfolioSummary();
    console.log(portfolio.formatPortfolioReport(buyCalcResult));
    return;
  }

  // 快捷命令：批量快速录入
  if (opts.quickAdd) {
    var qaData = loadFunds();
    var entries = opts.quickAdd.split(",").map(function(s) { return s.trim(); }).filter(Boolean);
    var qaCount = 0;
    for (var qi = 0; qi < entries.length; qi++) {
      var parts = entries[qi].split(/\s+/);
      if (parts.length < 2) { console.log("[跳过] 格式错误: " + entries[qi]); continue; }
      var qaCode = parts[0];
      var qaAmount = parseFloat(parts[1]);
      var qaNav = null;
      var qaDate = null;
      // 解析可选的 nav 和 date 参数
      if (parts[2] && !isNaN(parseFloat(parts[2]))) {
        qaNav = parseFloat(parts[2]);
      }
      if (parts[3] && /^\d{4}[-\/]\d{1,2}[-\/]\d{1,2}$/.test(parts[3])) {
        qaDate = normalizeDate(parts[3]);
      } else if (parts[2] && /^\d{4}[-\/]\d{1,2}[-\/]\d{1,2}$/.test(parts[2]) && isNaN(parseFloat(parts[2]))) {
        // 如果第三个参数是日期格式而不是数字
        qaDate = normalizeDate(parts[2]);
      }
      if (isNaN(qaAmount) || qaAmount <= 0) { console.log("[跳过] 金额错误: " + entries[qi]); continue; }
      var qaFund = qaData.funds.find(function(f) { return f.code === qaCode; });
      var qaName = qaFund ? qaFund.name : qaCode;
      var qaSettleDays = qaFund ? qaFund.settleDays : 2;
      portfolio.recordBuy(qaCode, qaName, qaAmount, qaNav, qaDate, qaSettleDays);
      qaCount++;
    }
    console.log("");
    console.log("[批量录入] 成功录入 " + qaCount + " 笔");
    var qaCalcResult = portfolio.calcPortfolioSummary();
    console.log(portfolio.formatPortfolioReport(qaCalcResult));
    return;
  }

  // 快捷命令：从文件导入交易记录
  if (opts.importFile) {
    var importPath = path.resolve(opts.importFile);
    if (!fs.existsSync(importPath)) {
      console.error("[导入] 文件不存在: " + importPath);
      console.log("请创建文件，每行格式: 基金代码 买入金额 [确认净值]");
      console.log("示例:");
      console.log("  270042 10 8.5243");
      console.log("  040046 20");
      console.log("  161130 15 1.2345");
      process.exit(1);
    }
    var fileContent = fs.readFileSync(importPath, "utf-8");
    var importData = loadFunds();
    var importResult = portfolio.importFromText(fileContent, importData.funds);
    console.log("");
    console.log("[导入] 解析 " + importResult.total + " 行, 成功导入 " + importResult.imported + " 笔");
    if (importResult.errors.length > 0) {
      console.log("[导入] 跳过 " + importResult.errors.length + " 行:");
      for (var ei = 0; ei < importResult.errors.length; ei++) {
        console.log("  " + importResult.errors[ei]);
      }
    }
    if (importResult.imported > 0) {
      var importCalcResult = portfolio.calcPortfolioSummary();
      console.log("");
      console.log(portfolio.formatPortfolioReport(importCalcResult));
    }
    return;
  }

  // 快捷命令：显示今日推荐和买入指令
  if (opts.today) {
    var todayData = loadFunds();
    var todayCalcResult = portfolio.calcPortfolioSummary();
    portfolio.showTodayBuyCommands(todayData.funds, todayCalcResult);
    return;
  }

  // 快捷命令：删除某只基金的所有买入记录
  if (opts.delete) {
    var p = portfolio.loadPortfolio();
    var targetCode = opts.delete;
    var target = p.holdings.find(function(h) { return h.code === targetCode; });
    if (!target) {
      console.log("[删除] 未找到基金 " + targetCode + " 的持仓记录");
    } else {
      var buyCount = target.buys.length;
      p.holdings = p.holdings.filter(function(h) { return h.code !== targetCode; });
      // 更新 startDate
      var allDates = [];
      p.holdings.forEach(function(h) { h.buys.forEach(function(b) { allDates.push(b.date); }); });
      p.startDate = allDates.length > 0 ? allDates.sort()[0] : null;
      portfolio.savePortfolio(p);
      console.log("[删除] 已删除 " + target.name + "(" + targetCode + ") 的 " + buyCount + " 笔买入记录");
    }
    var delResult = portfolio.calcPortfolioSummary();
    console.log(portfolio.formatPortfolioReport(delResult));
    return;
  }

  // 快捷命令：清空所有持仓
  if (opts.deleteAll) {
    portfolio.savePortfolio({ holdings: [], startDate: null });
    console.log("[删除] 已清空所有持仓记录");
    return;
  }

  // 快捷命令：启动 Web UI
  if (opts.web) {
    webServer.startWebServer(opts.webPort);
    return;
  }

  // 快捷命令：权重优化
  if (opts.optimizeWeights) {
    var optData = loadFunds();
    var optConfig = optData.config || {};
    var btConfig = {
      lookbackDays: optConfig.lookbackDays || 30,
      topN: optConfig.topN || 3,
      minPurchase: optConfig.minPurchase || 10,
      backtestDays: 90
    };
    await backtest.runWeightOptimization(optData.funds, btConfig);
    return;
  }

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
  var lookbackDays = config.lookbackDays || 250; // 默认1年，回测时可设750
  var result, textContent;
  try {
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
  } catch(err) {
    console.error("[策略执行失败]", err.message);
    result = { budget: budget, strategy: strategy, date: new Date().toISOString().slice(0,10), ranked: [], error: err.message };
    textContent = "策略执行失败: " + err.message + "\n\n请检查网络连接或减少基金数量。";
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

  // 计算持仓盈亏
  var portfolioResult = portfolio.calcPortfolioSummary();
  result.portfolio = portfolioResult;
  if (!portfolioResult.empty) {
    console.log("[持仓] " + portfolioResult.summary.holdingCount + "只基金, 总投入" + portfolioResult.summary.totalInvested + "元, 盈亏" + (portfolioResult.summary.totalPnl >= 0 ? "+" : "") + portfolioResult.summary.totalPnl + "元");

    // 计算组合风险
    try {
      var riskResult = risk.calcPortfolioRisk(portfolioResult.holdings);
      var corrResult = risk.calcCorrelationMatrix(portfolioResult.holdings, 60);
      result.risk = riskResult;
      result.correlation = corrResult;
      if (riskResult) {
        console.log("[风控] 健康度" + riskResult.healthScore + "/100, 夏普" + riskResult.portfolioSharpe + ", 回撤" + riskResult.portfolioMaxDrawdown + "%");
        if (riskResult.concentration.dominantWeight > 70) {
          console.log("[风控] ⚠️ " + riskResult.concentration.dominantType + "占比" + riskResult.concentration.dominantWeight + "%，过于集中");
        }
      }
    } catch(e) {
      console.warn("[风控] 计算失败:", e.message);
    }
  }

  // 替代方案分析（针对不可买的基金）
  if (result.suspended && result.suspended.length > 0) {
    var altSuggestions = alternatives.analyzeAlternatives(result.suspended);
    result.alternatives = altSuggestions;
    if (altSuggestions.length > 0) {
      console.log("[替代] " + altSuggestions.length + "只不可买基金有替代方案");
    }
  }

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