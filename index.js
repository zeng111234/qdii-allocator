require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

// 修复Windows终端中文乱码
try {
  if (process.platform === "win32") {
    execSync("chcp 65001", { stdio: "ignore" });
    process.stdout.setDefaultEncoding("utf8");
    process.stderr.setDefaultEncoding("utf8");
  }
} catch(e) {}
const alloc = require("./lib/allocator");
const dyn = require("./lib/dynamic-strategy");
const ai = require("./lib/ai-analyst");
const mail = require("./lib/mailer");
const backtest = require("./lib/backtest");
const fundData = require("./lib/fund-data");
const externalSignalData = require("./lib/external-signals");
const portfolio = require("./lib/portfolio");
const risk = require("./lib/risk");
const alternatives = require("./lib/alternatives");
const webServer = require("./lib/web-server");
const { normalizeDate, archiveOldHistory } = require("./lib/utils");
const { backfillFollowUp: backfillHistoryFollowUp } = require("./lib/history-tracker");
const { validateConfig } = require("./lib/config");
const { runMultiAgentDebate, formatDebateReport } = require("./lib/multi-agent-debate");
const riskAlert = require("./lib/risk-alert");

const FUNDS_FILE = path.join(__dirname, "data", "funds.json");
const STRATEGY_MAP = {
  "equal": alloc.Strategy.EQUAL,
  "low_fee": alloc.Strategy.LOW_FEE,
  "scarce": alloc.Strategy.SCARCE_FIRST,
  "dynamic": "dynamic"
};

function loadFunds() {
  if (!fs.existsSync(FUNDS_FILE)) { console.error("[error] funds.json not found"); process.exit(1); }
  const data = JSON.parse(fs.readFileSync(FUNDS_FILE, "utf-8"));
  if (!data.funds || data.funds.length === 0) { console.error("[error] funds pool empty"); process.exit(1); }
  return data;
}

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { dryRun: false, strategy: null, budget: null, backtest: false, backtestDays: 60, walkForward: false, walkForwardTrain: 90, walkForwardTest: 30, hypothesisReport: false, portfolio: false, buy: null, optimizeWeights: false, quickAdd: null, importFile: null, today: false, web: false, webPort: 3000, multiAgent: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--dry-run") opts.dryRun = true;
    else if (args[i] === "--strategy") opts.strategy = args[++i];
    else if (args[i] === "--budget") opts.budget = parseFloat(args[++i]);
    else if (args[i] === "--backtest") opts.backtest = true;
    else if (args[i] === "--backtest-days") opts.backtestDays = parseInt(args[++i]) || 60;
    else if (args[i] === "--portfolio") opts.portfolio = true;
    else if (args[i] === "--web") { opts.web = true; if (args[i + 1] && /^\d+$/.test(args[i + 1])) { opts.webPort = parseInt(args[++i]); } }
    else if (args[i] === "--buy") {
      const buyCode = args[++i];
      const buyAmount = parseFloat(args[++i]);
      let buyNav = null;
      let buyDate = null;
      if (args[i + 1] && /^\d{4}[-/]\d{1,2}[-/]\d{1,2}$/.test(args[i + 1])) {
        buyDate = normalizeDate(args[++i]);
      } else if (args[i + 1] && !isNaN(parseFloat(args[i + 1])) && !/^\d{4}[-/]/.test(args[i + 1])) {
        buyNav = parseFloat(args[++i]);
        if (args[i + 1] && /^\d{4}[-/]\d{1,2}[-/]\d{1,2}$/.test(args[i + 1])) {
          buyDate = normalizeDate(args[++i]);
        }
      }
      opts.buy = { code: buyCode, amount: buyAmount, nav: buyNav, date: buyDate };
    }
    else if (args[i] === "--optimize-weights") opts.optimizeWeights = true;
    else if (args[i] === "--walk-forward") opts.walkForward = true;
    else if (args[i] === "--walk-forward-train") opts.walkForwardTrain = parseInt(args[++i]) || 90;
    else if (args[i] === "--walk-forward-test") opts.walkForwardTest = parseInt(args[++i]) || 30;
    else if (args[i] === "--hypotheses") opts.hypothesisReport = true;
    else if (args[i] === "--goals") opts.goalReport = true;
    else if (args[i] === "--backfill") opts.backfill = true;
    else if (args[i] === "--quick-add") opts.quickAdd = args[++i];
    else if (args[i] === "--import-file") opts.importFile = args[++i] || "data/buys.txt";
    else if (args[i] === "--today") opts.today = true;
    else if (args[i] === "--sell") {
      const sellCode = args[++i];
      const sellAmount = parseFloat(args[++i]);
      let sellNav = null;
      let sellDate = null;
      if (args[i + 1] && /^\d{4}[-/]\d{1,2}[-/]\d{1,2}$/.test(args[i + 1])) {
        sellDate = normalizeDate(args[++i]);
      } else if (args[i + 1] && !isNaN(parseFloat(args[i + 1])) && !/^\d{4}[-/]/.test(args[i + 1])) {
        sellNav = parseFloat(args[++i]);
        if (args[i + 1] && /^\d{4}[-/]\d{1,2}[-/]\d{1,2}$/.test(args[i + 1])) {
          sellDate = normalizeDate(args[++i]);
        }
      }
      opts.sell = { code: sellCode, amount: sellAmount, nav: sellNav, date: sellDate };
    }
    else if (args[i] === "--delete") opts.delete = args[++i];
    else if (args[i] === "--delete-all") opts.deleteAll = true;
    else if (args[i] === "--multi-agent") opts.multiAgent = true;
    else if (args[i] === "--help") {
      console.log("QDII Fund Allocator");
      console.log("  --dry-run              dry run mode");
      console.log("  --strategy <s>         equal|low_fee|scarce|dynamic");
      console.log("  --budget <n>           daily budget");
      console.log("  --backtest             run backtest mode");
      console.log("  --backtest-days <n>    backtest period (default 60)");
      console.log("  --portfolio            view current holdings");
      console.log("  --buy <code> <amount> [nav] [date]  record a buy (date: YYYY-MM-DD, auto-calculates T+2 trading days)");
      console.log("  --sell <code> <amount> [nav] [date]  record a sell/redemption (realized P&L)");
      console.log("  --quick-add \"code amt [nav] [date], ...\"  batch record buys (auto-settlement T+2 trading days)");
      console.log("  --import-file [path]   import buys from text file (default data/buys.txt, auto-settlement T+2 trading days)");
      console.log("  --today                show today's recommended funds with buy commands");
      console.log("  --optimize-weights     run weight optimization");
      console.log("  --walk-forward         run walk-forward backtest (Vibe-Trading style)");
      console.log("  --walk-forward-train <n>  training window days (default 90)");
      console.log("  --walk-forward-test <n>   test window days (default 30)");
      console.log("  --hypotheses           show hypothesis tracking report");
      console.log("  --goals                show investment goal tracking report");
      console.log("  --backfill             backfill full historical NAV data for all funds");
      console.log("  --multi-agent          enable multi-agent debate (TradingAgents style)");
      console.log("  --web [port]           start web UI (default port 3000)");
      console.log("  --delete <code>        delete all buys for a fund code");
      console.log("  --delete-all           delete all holdings (reset portfolio)");
      process.exit(0);
    }
  }
  return opts;
}

// [修复] 原问题：快捷命令处理逻辑从main()中拆分为独立函数，提高可读性

/**
 * 处理快捷命令（持仓查看、买卖、导入等）
 * @returns {boolean} 如果处理了快捷命令返回true，需要继续主流程返回false
 */
function handleQuickCommands(opts) {
  if (opts.portfolio) {
    const calcResult = portfolio.calcPortfolioSummary();
    console.log(portfolio.formatPortfolioReport(calcResult));
    return true;
  }

  if (opts.buy) {
    const buyData = loadFunds();
    const fund = buyData.funds.find(function(f) { return f.code === opts.buy.code; });
    const fundName = fund ? fund.name : opts.buy.code;
    const settleDays = fund ? fund.settleDays : 2;
    portfolio.recordBuy(opts.buy.code, fundName, opts.buy.amount, opts.buy.nav, opts.buy.date, settleDays);
    console.log("");
    const buyCalcResult = portfolio.calcPortfolioSummary();
    console.log(portfolio.formatPortfolioReport(buyCalcResult));
    return true;
  }

  if (opts.sell) {
    const sellData = loadFunds();
    const sellFund = sellData.funds.find(function(f) { return f.code === opts.sell.code; });
    const sellFundName = sellFund ? sellFund.name : opts.sell.code;
    portfolio.recordSell(opts.sell.code, sellFundName, opts.sell.amount, opts.sell.nav, opts.sell.date);
    console.log("");
    const sellCalcResult = portfolio.calcPortfolioSummary();
    console.log(portfolio.formatPortfolioReport(sellCalcResult));
    return true;
  }

  if (opts.quickAdd) {
    const qaData = loadFunds();
    const entries = opts.quickAdd.split(",").map(function(s) { return s.trim(); }).filter(Boolean);
    let qaCount = 0;
    for (let qi = 0; qi < entries.length; qi++) {
      const parts = entries[qi].split(/\s+/);
      if (parts.length < 2) { console.log("[跳过] 格式错误: " + entries[qi]); continue; }
      const qaCode = parts[0];
      const qaAmount = parseFloat(parts[1]);
      let qaNav = null;
      let qaDate = null;
      if (parts[2] && !isNaN(parseFloat(parts[2]))) {
        qaNav = parseFloat(parts[2]);
      }
      if (parts[3] && /^\d{4}[-/]\d{1,2}[-/]\d{1,2}$/.test(parts[3])) {
        qaDate = normalizeDate(parts[3]);
      } else if (parts[2] && /^\d{4}[-/]\d{1,2}[-/]\d{1,2}$/.test(parts[2]) && isNaN(parseFloat(parts[2]))) {
        qaDate = normalizeDate(parts[2]);
      }
      if (isNaN(qaAmount) || qaAmount <= 0) { console.log("[跳过] 金额错误: " + entries[qi]); continue; }
      const qaFund = qaData.funds.find(function(f) { return f.code === qaCode; });
      const qaName = qaFund ? qaFund.name : qaCode;
      const qaSettleDays = qaFund ? qaFund.settleDays : 2;
      portfolio.recordBuy(qaCode, qaName, qaAmount, qaNav, qaDate, qaSettleDays);
      qaCount++;
    }
    console.log("");
    console.log("[批量录入] 成功录入 " + qaCount + " 笔");
    const qaCalcResult = portfolio.calcPortfolioSummary();
    console.log(portfolio.formatPortfolioReport(qaCalcResult));
    return true;
  }

  if (opts.importFile) {
    const importPath = path.resolve(opts.importFile);
    if (!fs.existsSync(importPath)) {
      console.error("[导入] 文件不存在: " + importPath);
      console.log("请创建文件，每行格式: 基金代码 买入金额 [确认净值]");
      process.exit(1);
    }
    const fileContent = fs.readFileSync(importPath, "utf-8");
    const importData = loadFunds();
    const importResult = portfolio.importFromText(fileContent, importData.funds);
    console.log("");
    console.log("[导入] 解析 " + importResult.total + " 行, 成功导入 " + importResult.imported + " 笔");
    if (importResult.errors.length > 0) {
      console.log("[导入] 跳过 " + importResult.errors.length + " 行:");
      for (let ei = 0; ei < importResult.errors.length; ei++) {
        console.log("  " + importResult.errors[ei]);
      }
    }
    if (importResult.imported > 0) {
      const importCalcResult = portfolio.calcPortfolioSummary();
      console.log("");
      console.log(portfolio.formatPortfolioReport(importCalcResult));
    }
    return true;
  }

  if (opts.today) {
    const todayData = loadFunds();
    const todayCalcResult = portfolio.calcPortfolioSummary();
    portfolio.showTodayBuyCommands(todayData.funds, todayCalcResult);
    return true;
  }

  if (opts.delete) {
    const p = portfolio.loadPortfolio();
    const targetCode = opts.delete;
    const target = p.holdings.find(function(h) { return h.code === targetCode; });
    if (!target) {
      console.log("[删除] 未找到基金 " + targetCode + " 的持仓记录");
    } else {
      const buyCount = target.buys.length;
      p.holdings = p.holdings.filter(function(h) { return h.code !== targetCode; });
      const allDates = [];
      p.holdings.forEach(function(h) { h.buys.forEach(function(b) { allDates.push(b.date); }); });
      p.startDate = allDates.length > 0 ? allDates.sort()[0] : null;
      portfolio.savePortfolio(p);
      console.log("[删除] 已删除 " + target.name + "(" + targetCode + ") 的 " + buyCount + " 笔买入记录");
    }
    const delResult = portfolio.calcPortfolioSummary();
    console.log(portfolio.formatPortfolioReport(delResult));
    return true;
  }

  if (opts.deleteAll) {
    portfolio.savePortfolio({ holdings: [], startDate: null });
    console.log("[删除] 已清空所有持仓记录");
    return true;
  }

  if (opts.web) {
    webServer.startWebServer(opts.webPort);
    return true;
  }

  if (opts.optimizeWeights) {
    const optData = loadFunds();
    const optConfig = optData.config || {};
    const btConfig = {
      lookbackDays: optConfig.lookbackDays || 30,
      topN: optConfig.topN || 3,
      minPurchase: optConfig.minPurchase || 10,
      backtestDays: 90
    };
    backtest.runWeightOptimization(optData.funds, btConfig);
    return true;
  }

  return false;
}

// [修复] 原问题：回测/走步回测/假设/目标/回填命令从main()中拆分

/**
 * 处理回测和报告类命令
 * @returns {boolean} 如果处理了命令返回true
 */
async function handleAnalysisCommands(opts, funds, config) {
  const topN = config.topN || 3;
  const minPurchase = config.minPurchase || 10;

  if (opts.backtest) {
    console.log("[回测模式] 启动策略回测...\n");
    await backtest.runBacktest(funds, {
      lookbackDays: 30, topN: topN, minPurchase: minPurchase, backtestDays: opts.backtestDays
    });
    console.log("\n回测完成!");
    return true;
  }

  if (opts.walkForward) {
    console.log("[走步回测] 滚动窗口验证策略...\n");
    const walkForward = require("./lib/walk-forward");
    const navCache = require("./lib/utils").loadNavCache();
    const wfResult = walkForward.runWalkForwardBacktest(navCache, funds, {
      trainDays: opts.walkForwardTrain, testDays: opts.walkForwardTest,
      topN: topN, stepDays: opts.walkForwardTest
    });
    if (wfResult) {
      console.log("\n走步回测完成! 胜率: " + wfResult.summary.winRate + ", 累计收益: " + wfResult.summary.cumulativeReturn);
    }
    return true;
  }

  if (opts.hypothesisReport) {
    const hypothesisEngine = require("./lib/hypothesis-engine");
    const navCache = require("./lib/utils").loadNavCache();
    hypothesisEngine.updateHypothesisReturns(navCache);
    console.log(hypothesisEngine.formatHypothesisReport());
    return true;
  }

  if (opts.goalReport) {
    const goalPlanner = require("./lib/goal-planner");
    const hypothesisEngine = require("./lib/hypothesis-engine");
    const navCache = require("./lib/utils").loadNavCache();
    let portfolioData = null;
    try { portfolioData = require("./data/portfolio.json"); } catch (e) {}
    const hStats = hypothesisEngine.getHypothesisStats();
    goalPlanner.updateGoals(portfolioData, hStats, navCache);
    console.log(goalPlanner.formatGoalReport());
    return true;
  }

  if (opts.backfill) {
    console.log("[回填] 开始回填所有基金的全量历史净值数据...");
    console.log("[回填] 共 " + funds.length + " 只基金，每只需约1-2分钟\n");
    let backfilled = 0, failed = 0;
    for (let bi = 0; bi < funds.length; bi++) {
      const bfund = funds[bi];
      console.log("[" + (bi + 1) + "/" + funds.length + "] " + bfund.name + "(" + bfund.code + ")...");
      try {
        const bhistory = await fundData.getFundNavHistory(bfund.code, 5000);
        console.log("  → " + bhistory.length + "条记录");
        if (bhistory.length > 0) console.log("  → " + bhistory[0].date + " ~ " + bhistory[bhistory.length - 1].date);
        backfilled++;
      } catch (e) {
        console.warn("  → 失败:", e.message);
        failed++;
      }
      if (bi < funds.length - 1) await new Promise(function(r) { setTimeout(r, 1000); });
    }
    console.log("\n[回填] 完成! 成功:" + backfilled + ", 失败:" + failed);
    return true;
  }

  return false;
}

// [修复] 原问题：市场数据获取逻辑拆分为独立函数

/**
 * 获取市场快照和新闻（非dynamic策略时使用）
 */
async function fetchMarketData() {
  let marketSnapshot = [];
  let marketNews = [];
  try {
    marketSnapshot = await fundData.getMarketSnapshot();
    marketNews = await fundData.getMarketSentiment(5);
    if (marketSnapshot.length > 0) console.log("[market] fetched " + marketSnapshot.length + " realtime indices");
    if (marketNews.length > 0) console.log("[news] fetched " + marketNews.length + " market items");
  } catch(e) {
    console.warn("[market] fetch failed:", e.message);
  }
  return { marketSnapshot, marketNews };
}

/**
 * 获取外部信号（X/Twitter大V观点）
 */
async function fetchExternalSignals(config, funds) {
  let externalSignals = null;
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
      const directions = externalSignalData.analyzeNewDirections(externalSignals.tickerOpinions || [], funds);
      externalSignals.newDirections = directions;
      if (directions.gapSummary) console.log("[X] 新投资方向缺口: " + directions.gapSummary);
    } else {
      console.warn("[X] " + externalSignals.error);
      if (externalSignals.attempts && externalSignals.attempts.length > 0) {
        for (let si = 0; si < externalSignals.attempts.length; si++) {
          const sa = externalSignals.attempts[si];
          if (sa.status !== "ok") console.warn("[X]   " + sa.status + ": " + sa.url.substring(0, 60) + " (" + (sa.error || "unknown") + ")");
        }
      }
    }
  }
  return externalSignals;
}

// [修复] 原问题：AI分析逻辑拆分为独立函数

/**
 * 运行AI分析（标准模式或多智能体辩论模式）
 */
async function runAIAnalysis(result, opts, llmConfig) {
  if (opts.multiAgent) {
    console.log("[Multi-Agent] 启用多智能体辩论模式...");
    const rankedFunds = result.ranked ? result.ranked.slice(0, 10) : []; // [修复] 原问题：变量名冲突 fundData
    const portfolioData = result.portfolio;
    const marketContext = {
      marketSnapshot: result.marketSnapshot,
      marketNews: result.marketNews,
      externalSignals: result.externalSignals
    };
    try {
      const debateResult = await runMultiAgentDebate(rankedFunds, portfolioData, marketContext, llmConfig);
      return formatDebateReport(debateResult);
    } catch (err) {
      console.error("[Multi-Agent] 辩论失败，回退到标准模式:", err.message);
      return await ai.generateCommentary(result, llmConfig);
    }
  } else {
    return await ai.generateCommentary(result, llmConfig);
  }
}

/**
 * 发送邮件报告
 */
async function sendReport(result, textContent, aiCommentary, topN, dailyBrief) {
  const smtpHost = process.env.SMTP_HOST;
  const smtpPort = parseInt(process.env.SMTP_PORT || "465");
  const smtpUser = process.env.SMTP_USER;
  const smtpPass = process.env.SMTP_PASS;
  const mailTo = process.env.MAIL_TO;
  if (!smtpHost || !smtpUser || !smtpPass || !mailTo) {
    console.log("[5/5] email skipped (SMTP not configured)");
  } else {
    console.log("[5/5] Sending email...");

    // 加载 FactorEngine 排名（与页面一致）
    const fs = require('fs');
    const path = require('path');
    const factorRankingsPath = path.join(__dirname, 'data', 'factor-rankings.json');
    let factorRankings = null;
    try {
      if (fs.existsSync(factorRankingsPath)) {
        factorRankings = JSON.parse(fs.readFileSync(factorRankingsPath, 'utf-8'));
        console.log("[邮件] 使用FactorEngine排名 (" + factorRankings.ranked.filter(function(r) { return !r.deduped; }).length + "只推荐)");
      }
    } catch(e) {
      console.warn("[邮件] 加载FactorEngine排名失败:", e.message);
    }

    // 如果有FactorEngine排名，替换result.ranked
    if (factorRankings && factorRankings.ranked) {
      result.ranked = factorRankings.ranked.filter(function(r) { return !r.deduped; }).slice(0, topN);
    }

    const smtpConfig = { host: smtpHost, port: smtpPort, user: smtpUser, pass: smtpPass };
    const success = await mail.sendEmail({ to: mailTo, subject: "QDII Top" + topN + " " + result.date, textContent: textContent, aiCommentary: aiCommentary, result: result, dailyBrief: dailyBrief }, smtpConfig);
    if (!success) { console.warn("[warn] email failed, continuing..."); }
  }
}

async function main() {
  console.log("========================================");
  console.log("  QDII Fund Daily Allocator");
  console.log("========================================");
  console.log("");

  validateConfig();
  archiveOldHistory(180);
  await fundData.initNavDb();
  console.log("");

  const opts = parseArgs();

  // 处理快捷命令
  if (handleQuickCommands(opts)) return;

  console.log("[1/5] Loading funds...");
  const data = loadFunds();
  const funds = data.funds;
  const config = data.config || {};

  // [修复] 原问题：cleanStaleCache 错误被静默吞掉
  try { fundData.cleanStaleCache(); } catch(e) { console.warn("[data] 清理缓存失败:", e.message); }

  const budget = opts.budget || config.defaultBudget || 20;
  const strategyKey = opts.strategy || config.defaultStrategy || "scarce";
  const strategy = STRATEGY_MAP[strategyKey] || alloc.Strategy.SCARCE_FIRST;
  console.log("  " + funds.length + " funds, budget=" + budget + ", strategy=" + strategyKey);
  console.log("");

  const minPurchase = config.minPurchase || 10;
  const topN = config.topN || 3;

  // 处理回测和报告类命令
  if (await handleAnalysisCommands(opts, funds, config)) return;

  // [修复] 原问题：llmApiKey 在第505行使用但第548行才声明，导致风险预警永远不执行
  const llmApiKey = process.env.LLM_API_KEY;
  const llmBaseUrl = process.env.LLM_BASE_URL;
  const llmModel = process.env.LLM_MODEL;

  let marketSnapshot = [];
  let marketNews = [];
  let externalSignals = null;

  // 动态策略：先获取市场信号
  if (strategy === "dynamic") {
    console.log("[2/5] Fetching market/X signals...");
    const marketData = await fetchMarketData();
    marketSnapshot = marketData.marketSnapshot;
    marketNews = marketData.marketNews;
    externalSignals = await fetchExternalSignals(config, funds);
    console.log("");
  }

  // 执行策略排名
  console.log("[2/5] Ranking...");
  const lookbackDays = config.lookbackDays || 750;
  let result, textContent;
  try {
    if (strategy === "dynamic") {
      result = await dyn.allocateDynamic(budget, funds, {
        lookbackDays: lookbackDays, topN: topN, minPurchase: minPurchase,
        enableHistory: true, externalSignals: externalSignals,
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
  console.log("[3/5] Fetching market data & backfilling history...");
  backfillHistoryFollowUp(fundData.loadNavCache());

  // 非动态策略时获取市场数据
  if (strategy !== "dynamic") {
    const marketData = await fetchMarketData();
    marketSnapshot = marketData.marketSnapshot;
    marketNews = marketData.marketNews;
  }

  result.marketSnapshot = marketSnapshot;
  result.marketNews = marketNews;
  result.externalSignals = externalSignals;

  // [修复] 原问题：风险预警检查（现在 llmApiKey 已正确声明在上方）
  if (marketSnapshot.length > 0 && llmApiKey && llmBaseUrl && llmModel) {
    try {
      const riskAlertResult = await riskAlert.checkAndAlert(marketSnapshot, { apiKey: llmApiKey, baseUrl: llmBaseUrl, model: llmModel });
      if (riskAlertResult) {
        console.log("[预警] 风险预警已触发");
        result.riskAlert = riskAlertResult;
      }
    } catch (err) { console.warn("[预警] 检查失败:", err.message); }
  }

  // 计算持仓盈亏
  const portfolioResult = portfolio.calcPortfolioSummary();
  result.portfolio = portfolioResult;
  if (!portfolioResult.empty) {
    console.log("[持仓] " + portfolioResult.summary.holdingCount + "只基金, 总投入" + portfolioResult.summary.totalInvested + "元, 盈亏" + (portfolioResult.summary.totalPnl >= 0 ? "+" : "") + portfolioResult.summary.totalPnl + "元");
    try {
      const riskResult = risk.calcPortfolioRisk(portfolioResult.holdings);
      const corrResult = risk.calcCorrelationMatrix(portfolioResult.holdings, 60);
      result.risk = riskResult;
      result.correlation = corrResult;
      if (riskResult) {
        console.log("[风控] 健康度" + riskResult.healthScore + "/100, 夏普" + riskResult.portfolioSharpe + ", 回撤" + riskResult.portfolioMaxDrawdown + "%");
        if (riskResult.concentration.dominantWeight > 70) {
          console.log("[风控] ⚠️ " + riskResult.concentration.dominantType + "占比" + riskResult.concentration.dominantWeight + "%，过于集中");
        }
      }
    } catch(e) { console.warn("[风控] 计算失败:", e.message); }
  }

  // [fix] 定投建议（基于市场温度）
  if (result.marketTemperature && result.budget) {
    const mt = result.marketTemperature;
    const adjustedBudget = Math.round(result.budget * mt.multiplier);
    if (mt.multiplier > 1) {
      console.log("[定投建议] 市场偏冷(" + mt.level + ")，建议今日投入" + adjustedBudget + "元（正常" + result.budget + "元的" + mt.multiplier + "倍）");
    } else if (mt.multiplier < 1) {
      console.log("[定投建议] 市场偏热(" + mt.level + ")，建议今日投入" + adjustedBudget + "元（正常" + result.budget + "元的" + mt.multiplier + "倍），或暂停一天");
    } else {
      console.log("[定投建议] 市场正常，建议今日投入" + result.budget + "元");
    }
  }

  // 替代方案分析
  if (result.suspended && result.suspended.length > 0) {
    const altSuggestions = alternatives.analyzeAlternatives(result.suspended);
    result.alternatives = altSuggestions;
    if (altSuggestions.length > 0) console.log("[替代] " + altSuggestions.length + "只不可买基金有替代方案");
  }

  // AI 分析
  let aiCommentary = "";
  if (llmApiKey && llmBaseUrl && llmModel) {
    console.log("[4/5] AI decision analysis...");
    aiCommentary = await runAIAnalysis(result, opts, { apiKey: llmApiKey, baseUrl: llmBaseUrl, model: llmModel });
    if (aiCommentary && aiCommentary.length > 10) {
      console.log("[AI决策报告] " + aiCommentary.substring(0, 200) + "...");
    } else {
      console.log("[AI] " + aiCommentary);
    }
  } else {
    console.log("[4/5] AI skipped (no LLM_API_KEY)");
  }

  // 生成早报
  let dailyBrief = null;
  if (llmApiKey && llmBaseUrl && llmModel) {
    try {
      const dailyBriefModule = require("./lib/daily-brief");
      const portfolioModule = require("./lib/portfolio");
      let portfolioData = null;
      try { portfolioData = portfolioModule.loadPortfolio(); } catch(e) {}
      dailyBrief = await dailyBriefModule.generateDailyBrief(
        { apiKey: llmApiKey, baseUrl: llmBaseUrl, model: llmModel },
        result,
        portfolioData
      );
      if (dailyBrief && dailyBrief.content) {
        console.log("[早报] " + dailyBrief.content.substring(0, 100) + "...");
      }
    } catch(e) {
      console.warn("[早报] 生成失败:", e.message);
    }
  }
  console.log("");

  // 输出或发送报告
  if (opts.dryRun) {
    console.log("[5/5] dry-run, skip email\n");
    console.log("--- preview ---");
    console.log(textContent);
    if (dailyBrief && dailyBrief.content) {
      console.log("\n=== 今日早报 ===");
      console.log(dailyBrief.content);
      console.log("=== End 早报 ===");
    }
    if (aiCommentary && aiCommentary.length > 10) {
      console.log("\n=== AI Decision Report ===");
      console.log(aiCommentary);
      console.log("=== End AI Report ===");
    }
    console.log("--- end ---");
  } else {
    await sendReport(result, textContent, aiCommentary, topN, dailyBrief);
  }
  console.log("");
  console.log("Done!");
}

main().catch(function(err) { console.error("[fatal]", err); process.exit(1); });
