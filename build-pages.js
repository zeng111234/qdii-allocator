/**
 * 构建 GitHub Pages 页面
 * 公共页面默认只嵌入市场数据；显式开启 PUBLIC_PORTFOLIO_SNAPSHOT=1 时，
 * 将运行时私有账本派生为公开只读持仓快照。
 */

const fs = require("fs");
const path = require("path");
const https = require("https");
const { normalizeExternalSignalsForPage } = require("./lib/external-signal-display");
const { serializeForInlineScript } = require("./lib/inline-script-json");
const ledgerTools = require("./lib/portfolio-ledger");
const decisionStateTools = require("./lib/decision-state");
const personalizedDecision = require("./lib/personalized-decision");
const planWindowTools = require("./lib/personalized-plan");
const tradingCalendar = require("./lib/trading-calendar");
const { formatDateInTimeZone } = require("./scripts/update-nav-cache");

const TEMPLATE = path.join(__dirname, "docs", "index.html.template");
const OUTPUT = path.join(__dirname, "docs", "index.html");
const FUNDS = path.join(__dirname, "data", "funds.json");
const NAV_CACHE = path.join(__dirname, "data", "nav-cache.json");
const DAILY_BRIEF = path.join(__dirname, "data", "daily-brief.json");
const RECOMMENDATION_PLAN = path.join(__dirname, "data", "recommendation-plan.json");
const PERSONALIZED_DECISION = path.join(__dirname, "lib", "personalized-decision.js");
const CANONICAL_PLAN_SCHEMA_VERSION = "PersonalizedRecommendationPlanV2";

function decisionFingerprint(state) {
  const normalized = decisionStateTools.normalizeDecisionState(state);
  return JSON.stringify({
    schemaVersion: normalized.schemaVersion,
    revision: normalized.revision,
    updatedAt: normalized.updatedAt,
    riskProfile: normalized.riskProfile,
    cashBalance: normalized.cashBalance,
    riskAnchorValue: normalized.riskAnchorValue,
    riskAnchorAt: normalized.riskAnchorAt,
    riskAnchorLedgerRevision: normalized.riskAnchorLedgerRevision,
    riskAnchorTransactionIds: normalized.riskAnchorTransactionIds.slice().sort()
  });
}

// 加载 .env（不依赖 dotenv 包）+ 环境变量 fallback（CI 中 secrets 通过 env 传入）
function loadEnv() {
  const env = Object.assign({}, process.env);
  const envPath = path.join(__dirname, ".env");
  if (fs.existsSync(envPath)) {
    fs.readFileSync(envPath, "utf-8")
      .split("\n")
      .forEach(line => {
        const m = line.match(/^\s*([\w]+)\s*=\s*(.*?)\s*$/);
        if (m) env[m[1]] = m[2];
      });
  }
  return env;
}

function loadPublicLedger(env) {
  if (env.PUBLIC_PORTFOLIO_SNAPSHOT === "1") {
    const ledgerPath = env.PRIVATE_LEDGER_PATH;
    if (!ledgerPath || !fs.existsSync(ledgerPath)) {
      throw new Error("PUBLIC_PORTFOLIO_SNAPSHOT_REQUIRES_PRIVATE_LEDGER");
    }
    const source = JSON.parse(fs.readFileSync(ledgerPath, "utf-8"));
    const ledger = Number(source.schemaVersion) === 2 && Array.isArray(source.transactions)
      ? source
      : ledgerTools.migrateLegacyPortfolio(source, { revision: 1 });
    const validation = ledgerTools.validateLedger(ledger);
    if (!validation.valid) {
      throw new Error("INVALID_PUBLIC_PORTFOLIO_SNAPSHOT:" + validation.errors.join(","));
    }
    return ledger;
  }
  return null;
}

function loadPublicPortfolioSnapshot(publicLedger) {
  if (publicLedger) return ledgerTools.derivePortfolio(publicLedger);
  return { holdings: [], startDate: null };
}

function loadPrivateDecisionState(env) {
  const statePath = env.PRIVATE_DECISION_STATE_PATH;
  if (!statePath || !fs.existsSync(statePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(statePath, "utf-8"));
  } catch (error) {
    console.log("[构建] 私有 decisionState 无效，个性化计划将强制暂停: " + error.message);
    return {};
  }
}

function validateCanonicalRecommendationPlan(plan, publicLedger, publicDecisionState, fundsConfig, asOf, nowValue) {
  if (!plan || typeof plan !== "object") throw new Error("CANONICAL_PLAN_INVALID");
  if (plan.schemaVersion !== CANONICAL_PLAN_SCHEMA_VERSION) {
    throw new Error("CANONICAL_PLAN_SCHEMA_VERSION_MISMATCH");
  }
  if (plan.strategyVersion !== personalizedDecision.PERSONALIZED_STRATEGY_ID) {
    throw new Error("CANONICAL_PLAN_STRATEGY_VERSION_MISMATCH");
  }
  const planDate = String(plan.asOf || plan.date || "").slice(0, 10);
  if (planDate !== asOf) throw new Error("CANONICAL_PLAN_STALE");
  if (!Number.isInteger(plan.syncRevision) || plan.syncRevision !== publicLedger.revision) {
    throw new Error("CANONICAL_PLAN_LEDGER_REVISION_MISMATCH");
  }
  if (!Number.isInteger(plan.decisionRevision) || plan.decisionRevision !== publicDecisionState.revision) {
    throw new Error("CANONICAL_PLAN_DECISION_REVISION_MISMATCH");
  }
  if (typeof plan.ledgerChecksum !== "string" || plan.ledgerChecksum !== publicLedger.checksum) {
    throw new Error("CANONICAL_PLAN_LEDGER_CHECKSUM_MISMATCH");
  }
  if (typeof plan.decisionFingerprint !== "string" ||
      plan.decisionFingerprint !== decisionFingerprint(publicDecisionState)) {
    throw new Error("CANONICAL_PLAN_DECISION_FINGERPRINT_MISMATCH");
  }
  if (String(fundsConfig._lastUpdated || "").slice(0, 10) !== asOf) {
    throw new Error("PURCHASE_AVAILABILITY_STALE");
  }

  const fundMap = new Map((fundsConfig.funds || []).map(function (fund) {
    return [String(fund.code), fund];
  }));
  if (!Array.isArray(plan.executionRoutes) || !Array.isArray(plan.candidates)) {
    throw new Error("CANONICAL_PLAN_ROUTES_INVALID");
  }
  if (typeof plan.budget !== "number" || !Number.isFinite(plan.budget) || plan.budget < 0) {
    throw new Error("CANONICAL_PLAN_BUDGET_INVALID");
  }
  const allowedActions = new Set(["BUY", "STRATEGIC_DCA", "TACTICAL_PAUSE", "HOLD", "PAUSE", "HARD_PAUSE"]);
  const executableActions = new Set(["BUY", "STRATEGIC_DCA", "TACTICAL_PAUSE"]);
  if (!allowedActions.has(plan.action)) throw new Error("CANONICAL_PLAN_ACTION_INVALID");
  const routes = plan.executionRoutes;
  const candidates = plan.candidates;
  const routeCodes = new Set();
  const allocatedByCode = new Map();
  const routeTotal = routes.reduce(function (sum, route) {
    const code = String(route && route.code || "");
    if (routeCodes.has(code)) throw new Error("CANONICAL_PLAN_DUPLICATE_ROUTE:" + code);
    routeCodes.add(code);
    const fund = fundMap.get(code);
    const amount = route && route.amount;
    if (!fund || fund.status !== "active" || !(Number(fund.dailyLimit) > 0) ||
        typeof amount !== "number" || !Number.isFinite(amount) || !(amount > 0) ||
        amount < Number(fund.minPurchase || 10)) {
      throw new Error("CANONICAL_PLAN_LIMIT_MISMATCH:" + (code || "UNKNOWN"));
    }
    const allocated = (allocatedByCode.get(code) || 0) + amount;
    allocatedByCode.set(code, allocated);
    if (allocated > Number(fund.dailyLimit)) throw new Error("CANONICAL_PLAN_LIMIT_MISMATCH:" + code);
    return sum + amount;
  }, 0);
  if (Math.abs(routeTotal - plan.budget) > 0.001) {
    throw new Error("CANONICAL_PLAN_BUDGET_MISMATCH");
  }
  if (candidates.length !== routes.length || candidates.some(function (candidate, index) {
    return String(candidate.code) !== String(routes[index].code) ||
      typeof candidate.proposedAmount !== "number" ||
      Math.abs(candidate.proposedAmount - routes[index].amount) > 0.001;
  })) {
    throw new Error("CANONICAL_PLAN_CANDIDATE_MISMATCH");
  }
  const executable = executableActions.has(plan.action);
  if ((executable && !(plan.budget > 0 && routes.length > 0)) ||
      (!executable && (plan.budget !== 0 || routes.length > 0 || candidates.length > 0))) {
    throw new Error("CANONICAL_PLAN_ACTION_BUDGET_MISMATCH");
  }
  if (executable) {
    const windowStatus = planWindowTools.executionWindowStatus(
      plan,
      asOf,
      nowValue === undefined ? new Date(plan.generatedAt) : nowValue
    );
    if (!windowStatus.valid) throw new Error("CANONICAL_PLAN_EXECUTION_WINDOW_INVALID");
    if (windowStatus.reason === "PLAN_WINDOW_EXPIRED") throw new Error("CANONICAL_PLAN_EXPIRED");
  }
  return plan;
}

function loadCanonicalRecommendationPlan(env, publicLedger, publicDecisionState, fundsConfig, asOf) {
  if (!publicLedger || !publicDecisionState) return null;
  const planPath = env.CANONICAL_RECOMMENDATION_PLAN_PATH || RECOMMENDATION_PLAN;
  if (!fs.existsSync(planPath)) throw new Error("CANONICAL_RECOMMENDATION_PLAN_REQUIRED");
  const plan = JSON.parse(fs.readFileSync(planPath, "utf-8"));
  return validateCanonicalRecommendationPlan(plan, publicLedger, publicDecisionState, fundsConfig, asOf, new Date());
}

function marketOnlyPlan(asOf, reason) {
  const pauseReason = reason || "PRIVATE_RECOMMENDATION_STATE_UNAVAILABLE";
  return {
    schemaVersion: "RecommendationPlanV2",
    asOf: asOf,
    action: "HARD_PAUSE",
    decisionMode: "DATA_BLOCKED",
    blockedStage: pauseReason,
    pauseReasons: [pauseReason],
    budget: 0,
    candidates: [],
    ranked: [],
    executionRoutes: [],
    marketRanking: [],
    dataFreshness: { status: "MARKET_ONLY" },
    signalHealth: { status: "PAUSE" },
    personalized: false
  };
}

function copyRequiredPageAssets(newsData) {
  const docsDir = path.join(__dirname, "docs");
  const dataDir = path.join(docsDir, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.copyFileSync(NAV_CACHE, path.join(dataDir, "nav-cache.json"));
  fs.copyFileSync(PERSONALIZED_DECISION, path.join(docsDir, "personalized-decision.js"));
  fs.writeFileSync(path.join(dataDir, "news.json"), JSON.stringify(newsData), "utf8");
}

function validatePageArtifact(docsDir) {
  const root = docsDir || path.join(__dirname, "docs");
  const required = [
    path.join(root, "index.html"),
    path.join(root, "personalized-decision.js"),
    path.join(root, "data", "nav-cache.json"),
    path.join(root, "data", "news.json")
  ];
  required.forEach(function (file) {
    if (!fs.existsSync(file) || fs.statSync(file).size === 0) {
      throw new Error("PAGES_ARTIFACT_MISSING:" + path.relative(root, file));
    }
  });
  const indexHtml = fs.readFileSync(required[0], "utf8");
  if (/QDII_[A-Z_]+_PLACEHOLDER|PUBLIC_[A-Z_]+_PLACEHOLDER/.test(indexHtml)) {
    throw new Error("PAGES_ARTIFACT_PLACEHOLDER_REMAINS");
  }
  JSON.parse(fs.readFileSync(required[2], "utf8"));
  JSON.parse(fs.readFileSync(required[3], "utf8"));
  return true;
}

async function build() {
  console.log("[构建] 开始构建 GitHub Pages...");

  // 加载环境变量
  const env = loadEnv();

  // HTTP 工具函数（提取到顶层，供多处使用）
  const httpGetSync = url =>
    new Promise((resolve, reject) => {
      const req = https.get(url, { timeout: 8000 }, res => {
        let data = "";
        res.on("data", c => (data += c));
        res.on("end", () => resolve(data));
      });
      req.on("timeout", () => req.destroy(new Error("HTTP_TIMEOUT")));
      req.on("error", reject);
    });

  // 读取模板
  let template = fs.readFileSync(TEMPLATE, "utf-8");

  const asOf = formatDateInTimeZone(new Date(), "Asia/Shanghai");
  const publicLedger = loadPublicLedger(env);
  const privateDecisionState = loadPrivateDecisionState(env);
  const decisionStateValidation = decisionStateTools.validateDecisionState(privateDecisionState);
  const publicDecisionState = decisionStateValidation.valid
    ? decisionStateTools.normalizeDecisionState(privateDecisionState)
    : null;
  if (publicLedger && !publicDecisionState) {
    throw new Error("PUBLIC_PORTFOLIO_SNAPSHOT_REQUIRES_VALID_DECISION_STATE");
  }
  const portfolio = loadPublicPortfolioSnapshot(publicLedger);
  const publicPortfolioSnapshot = Boolean(publicLedger);
  console.log(publicPortfolioSnapshot
    ? "[构建] 已嵌入公开只读持仓快照：" + portfolio.holdings.length + "只基金"
    : "[构建] 未启用公开持仓快照，页面不嵌入个人持仓");
  const funds = JSON.parse(fs.readFileSync(FUNDS, "utf-8"));
  const canonicalRecommendationPlan = loadCanonicalRecommendationPlan(
    env,
    publicLedger,
    publicDecisionState,
    funds,
    asOf
  );
  if (env.NAV_REFRESH_FAILED === "1" && canonicalRecommendationPlan &&
      (canonicalRecommendationPlan.action !== "HARD_PAUSE" || canonicalRecommendationPlan.budget !== 0 ||
       !Array.isArray(canonicalRecommendationPlan.pauseReasons) ||
       !canonicalRecommendationPlan.pauseReasons.includes("NAV_REFRESH_FAILED"))) {
    throw new Error("NAV_REFRESH_FAILURE_NOT_FAIL_CLOSED");
  }
  const canonicalPublicPlan = Boolean(publicLedger && publicDecisionState && canonicalRecommendationPlan);

  // 读取净值缓存，提取每只基金的最新净值（文件可能不存在，由 daily-plan 生成）
  let navCache = {};
  if (fs.existsSync(NAV_CACHE)) {
    navCache = JSON.parse(fs.readFileSync(NAV_CACHE, "utf-8"));
  } else {
    console.log("[构建] ⚠️ nav-cache.json 不存在，净值数据将为空（由 daily-plan workflow 生成）");
  }
  const latestNavs = {};
  for (const code in navCache) {
    const navs = navCache[code];
    if (navs && navs.length > 0) {
      // 嵌入最近300条净值记录（用于盈亏计算+收益曲线图+1年收益因子）
      latestNavs[code] = navs.length >= 300 ? navs.slice(-300) : navs;
    }
  }

  // 读取每日早报
  let dailyBrief = null;
  try {
    if (fs.existsSync(DAILY_BRIEF)) {
      dailyBrief = JSON.parse(fs.readFileSync(DAILY_BRIEF, "utf-8"));
      if (!dailyBrief.date || dailyBrief.date !== asOf) dailyBrief = null;
    }
  } catch (e) {}

  // 嵌入数据
  // [fix] 用正则替换硬编码的数据变量（占位符已被替换为实际数据）
  template = template.replace(
    /var portfolioData = \{.*?\};/s,
    "var portfolioData = " + serializeForInlineScript(portfolio) + ";"
  );
  template = template.replace(
    "QDII_PUBLIC_PORTFOLIO_SNAPSHOT_PLACEHOLDER",
    publicPortfolioSnapshot ? "true" : "false"
  );
  template = template.replace(
    "PUBLIC_PORTFOLIO_LEDGER_PLACEHOLDER",
    serializeForInlineScript(publicLedger)
  );
  template = template.replace(
    "PUBLIC_DECISION_STATE_PLACEHOLDER",
    serializeForInlineScript(publicDecisionState)
  );
  template = template.replace(
    "PUBLIC_PLAN_CANONICAL_PLACEHOLDER",
    canonicalPublicPlan ? "true" : "false"
  );
  template = template.replace(/var fundsData = \{.*?\};/s, "var fundsData = " + serializeForInlineScript(funds) + ";");
  template = template.replace(/var navCacheData = \{.*?\};/s, "var navCacheData = " + serializeForInlineScript(latestNavs) + ";");
  template = template.replace(
    /var dailyBriefData = \{.*?\};/s,
    "var dailyBriefData = " + serializeForInlineScript(dailyBrief) + ";"
  );

  // Firebase Web 配置是公开的项目标识；数据库访问权限只由 Google Auth + Rules 决定。
  if (env.FIREBASE_URL && env.FIREBASE_WEB_API_KEY && env.FIREBASE_AUTH_DOMAIN && env.FIREBASE_PROJECT_ID && env.FIREBASE_APP_ID) {
    template = template
      .replace("FIREBASE_URL_PLACEHOLDER", env.FIREBASE_URL)
      .replace("FIREBASE_WEB_API_KEY_PLACEHOLDER", env.FIREBASE_WEB_API_KEY)
      .replace("FIREBASE_AUTH_DOMAIN_PLACEHOLDER", env.FIREBASE_AUTH_DOMAIN)
      .replace("FIREBASE_PROJECT_ID_PLACEHOLDER", env.FIREBASE_PROJECT_ID)
      .replace("FIREBASE_APP_ID_PLACEHOLDER", env.FIREBASE_APP_ID);
    console.log("[构建] Firebase Web SDK 配置已注入；未注入数据库长期密钥");
  } else {
    console.log("[构建] ⚠️ Firebase Web 配置不完整，页面将保持未同步/预算0");
  }

  // 抓取新闻数据嵌入（避免前端 CORS 问题）
  const newsData = { items: [], sentiment: null, fetchedAt: null };
  try {
    const [globalRaw, usRaw, hkRaw, futuresRaw, fundRaw] = await Promise.all([
      httpGetSync(
        "https://np-listapi.eastmoney.com/comm/web/getNewsByColumns?client=web&biz=web_news_col&column=350&order=1&needInteractData=0&page_index=1&page_size=10&req_trace=" +
          Date.now()
      ),
      httpGetSync(
        "https://np-listapi.eastmoney.com/comm/web/getNewsByColumns?client=web&biz=web_news_col&column=353&order=1&needInteractData=0&page_index=1&page_size=8&req_trace=" +
          Date.now()
      ),
      httpGetSync(
        "https://np-listapi.eastmoney.com/comm/web/getNewsByColumns?client=web&biz=web_news_col&column=351&order=1&needInteractData=0&page_index=1&page_size=8&req_trace=" +
          Date.now()
      ),
      httpGetSync(
        "https://np-listapi.eastmoney.com/comm/web/getNewsByColumns?client=web&biz=web_news_col&column=354&order=1&needInteractData=0&page_index=1&page_size=5&req_trace=" +
          Date.now()
      ),
      httpGetSync(
        "https://np-listapi.eastmoney.com/comm/web/getNewsByColumns?client=web&biz=web_news_col&column=356&order=1&needInteractData=0&page_index=1&page_size=5&req_trace=" +
          Date.now()
      )
    ]);

    const parseItems = (raw, source) => {
      try {
        const j = JSON.parse(raw);
        return j.data && j.data.list
          ? j.data.list.map(i => ({
              title: i.title || "",
              digest: i.digest || "",
              time: i.showTime || "",
              url: i.url || i.art_url || "",
              source: source || ""
            }))
          : [];
      } catch (e) {
        return [];
      }
    };

    const allItems = parseItems(globalRaw, "环球")
      .concat(parseItems(usRaw, "美股"))
      .concat(parseItems(hkRaw, "港股"))
      .concat(parseItems(futuresRaw, "期货"))
      .concat(parseItems(fundRaw, "基金"));
    newsData.items = allItems;
    newsData.fetchedAt = new Date().toISOString();

    // 情绪分析
    const posWords = [
      "利好",
      "上涨",
      "突破",
      "新高",
      "增长",
      "反弹",
      "降息",
      "宽松",
      "牛市",
      "大涨",
      "看涨",
      "bullish",
      "rally",
      "surge",
      "gain",
      "创新高",
      "连续上涨",
      "资金流入",
      "超预期",
      "盈利增长",
      "回购",
      "分红"
    ];
    const negWords = [
      "利空",
      "下跌",
      "暴跌",
      "新低",
      "衰退",
      "加息",
      "紧缩",
      "熊市",
      "大跌",
      "看跌",
      "bearish",
      "crash",
      "plunge",
      "sell-off",
      "risk",
      "关税",
      "制裁",
      "贸易战",
      "地缘",
      "冲突",
      "战争",
      "通胀",
      "违约",
      "爆雷",
      "清盘",
      "暂停申购"
    ];
    let pos = 0,
      neg = 0,
      neu = 0,
      overallScore = 0;
    const themeKeywords = {
      nasdaq: [
        "nasdaq",
        "ndx",
        "qqq",
        "nvda",
        "microsoft",
        "apple",
        "meta",
        "tesla",
        "nvidia",
        "ai",
        "semiconductor",
        "chip",
        "英伟达",
        "苹果",
        "微软",
        "谷歌",
        "人工智能",
        "半导体",
        "芯片",
        "算力"
      ],
      sp500: [
        "s&p",
        "sp500",
        "spy",
        "spx",
        "美股",
        "标普",
        "美联储",
        "fed",
        "利率",
        "道琼斯",
        "dow",
        "华尔街",
        "wall street",
        "通胀",
        "cpi",
        "pce",
        "非农"
      ],
      hongkong: ["港股", "恒生", "亚太", "中国", "亚洲", "hong kong", "恒指", "国企", "科技股", "南向资金", "北向资金"],
      oil: [
        "石油",
        "原油",
        "gold",
        "黄金",
        "能源",
        "oil",
        "commodity",
        "大宗商品",
        "opec",
        "天然气",
        "期货",
        "金价",
        "油价"
      ],
      europe: ["欧洲", "欧股", "dax", "德国", "英国", "ftse", "欧洲央行", "ecb", "欧元", "英镑"],
      japan: ["日本", "日经", "nikkei", "日元", "日银", "boj", "日本央行", "丰田", "索尼"],
      bonds: ["债券", "国债", "收益率", "yield", "降息", "加息", "美债", "treasury", "10年期"],
      qdii: ["qdii", "限购", "额度", "申购", "赎回", "净值", "基金", "定投", "份额"]
    };
    const byTheme = {};

    allItems.forEach(item => {
      const text = (item.title + " " + (item.digest || "")).toLowerCase();
      let score = 0;
      posWords.forEach(w => {
        if (text.indexOf(w) >= 0) score++;
      });
      negWords.forEach(w => {
        if (text.indexOf(w) >= 0) score--;
      });
      item._score = score;
      if (score > 0) pos++;
      else if (score < 0) neg++;
      else neu++;
      overallScore += score;
      Object.keys(themeKeywords).forEach(theme => {
        themeKeywords[theme].forEach(kw => {
          if (text.indexOf(kw) >= 0) {
            if (!byTheme[theme]) byTheme[theme] = { pos: 0, neg: 0, count: 0 };
            byTheme[theme].count++;
            if (score > 0) byTheme[theme].pos++;
            else if (score < 0) byTheme[theme].neg++;
          }
        });
      });
    });

    newsData.sentiment = {
      overall: allItems.length > 0 ? Math.round((overallScore / allItems.length) * 100) : 0,
      positive: pos,
      negative: neg,
      neutral: neu,
      byTheme: byTheme
    };

    console.log("[构建] 新闻: " + allItems.length + "条, 情绪=" + newsData.sentiment.overall);
  } catch (e) {
    console.log("[构建] 新闻获取失败: " + e.message + " (使用空数据)");
  }
  // [fix] 用正则替换硬编码数据（占位符已被替换为实际数据）
  template = template.replace(/var newsData = \{.*?\};/s, "var newsData = " + serializeForInlineScript(newsData) + ";");

  // [fix] 嵌入市场温度数据
  // 从已有历史推荐数据推算（避免CI环境API被封）
  let marketTemperature = {
    temperature: 50,
    level: "正常",
    multiplier: 1.0,
    reason: "基于历史推荐数据",
    vix: null,
    dailyChange: 0,
    peData: {}
  };
  try {
    const historyPath = path.join(__dirname, "data", "history.json");
    if (fs.existsSync(historyPath)) {
      const histData = JSON.parse(fs.readFileSync(historyPath, "utf-8"));
      const records = histData.records || [];
      if (records.length > 0) {
        const latest = records[records.length - 1];
        const ranked = latest.ranked || [];
        // 用推荐基金的平均得分推算市场温度
        // 得分高 = 市场好 = 温度高（但不极端）
        if (ranked.length > 0) {
          const avgScore =
            ranked.reduce(function (s, f) {
              return s + (f.score || 0);
            }, 0) / ranked.length;
          // 得分映射到温度：得分10→温度35，得分20→温度50，得分30→温度65
          const temp = Math.max(20, Math.min(80, Math.round(35 + (avgScore - 10) * 1.5)));
          let multiplier, level;
          if (temp <= 20) {
            multiplier = 1.3;
            level = "极冷";
          } else if (temp <= 35) {
            multiplier = 1.15;
            level = "偏冷";
          } else if (temp <= 65) {
            multiplier = 1.0;
            level = "正常";
          } else if (temp <= 80) {
            multiplier = 0.8;
            level = "偏热";
          } else {
            multiplier = 0.6;
            level = "极热";
          }
          marketTemperature = {
            temperature: temp,
            level: level,
            multiplier: multiplier,
            reason: "基于" + latest.date + "推荐数据(均分" + avgScore.toFixed(1) + ")",
            vix: null,
            dailyChange: 0,
            peData: {}
          };
          console.log(
            "[构建] 市场温度: " +
              temp +
              "/100 (" +
              level +
              ") 均分=" +
              avgScore.toFixed(1) +
              " 倍数=" +
              multiplier +
              "x"
          );
        }
      }
    }
  } catch (e) {
    console.log("[构建] 市场温度计算失败: " + e.message + " (使用默认值)");
  }
  template = template.replace("MARKET_TEMPERATURE_DATA", serializeForInlineScript(marketTemperature));

  // 页面只消费 index.js 在本次工作流中生成的唯一计划；私有状态缺失时严格降级为 market-only/预算0。
  const recommendationPlan = canonicalRecommendationPlan
    ? Object.assign({}, canonicalRecommendationPlan, {
        publicPortfolioSnapshot: portfolio,
        publicPortfolioSnapshotUpdatedAt: new Date().toISOString()
      })
    : marketOnlyPlan(asOf, env.NAV_REFRESH_FAILED === "1"
      ? "NAV_REFRESH_FAILED"
      : "PRIVATE_RECOMMENDATION_STATE_UNAVAILABLE");

  // 嵌入今日推荐（只读取 RecommendationPlan）
  const pageRanked = (recommendationPlan.candidates || []).map(function (candidate, index) {
    return Object.assign({ rank: index + 1 }, candidate, {
      score: candidate.marketScore,
      reason: candidate.reason || (candidate.reasons || []).join("；")
    });
  });
  const todayPicks = Object.assign({}, recommendationPlan, {
    date: recommendationPlan.asOf,
    strategy: "RecommendationPlan",
    candidates: recommendationPlan.candidates || [],
    executionRoutes: recommendationPlan.executionRoutes || [],
    ranked: pageRanked,
    allRanked: (recommendationPlan.marketRanking || []).map(function (candidate, index) {
      return Object.assign({ rank: index + 1, score: candidate.marketScore }, candidate);
    })
  });
  console.log("[构建] 推荐计划: " + recommendationPlan.action + "，候选" + todayPicks.ranked.length + "只");
  template = template.replace(/var todayPicks = \{.*?\};/s, "var todayPicks = " + serializeForInlineScript(todayPicks) + ";");

  // 嵌入限购额度：与生成邮件/唯一计划使用完全相同的 funds.json，不读取第二份缓存。
  const purchaseLimits = {};
  try {
    (funds.funds || []).forEach(function (f) {
      purchaseLimits[f.code] = {
        limit: Number(f.dailyLimit) > 0 ? Number(f.dailyLimit) : null,
        status: f.status === "active" ? "开放申购" : "暂停申购",
        premium: 0,
        minPurchase: f.minPurchase || 10,
        asOf: funds._lastUpdated || null
      };
    });
    console.log("[构建] 限购数据: " + Object.keys(purchaseLimits).length + "只基金");
  } catch (e) {
    console.log("[构建] 限购数据获取失败: " + e.message);
  }
  template = template.replace(
    /var purchaseLimits = \{.*?\};/s,
    "var purchaseLimits = " + serializeForInlineScript(purchaseLimits) + ";"
  );

  // 嵌入外部信号（X/Twitter 大V观点）
  let externalSignals = { items: [], tickerOpinions: [], themeScores: {}, cachedAt: null };
  try {
    const extPath = fs.existsSync(path.join(__dirname, "data", "external-signals-cache.json"))
      ? path.join(__dirname, "data", "external-signals-cache.json")
      : path.join(__dirname, "docs", "data", "external-signals-cache.json");
    if (fs.existsSync(extPath)) {
      const extRaw = JSON.parse(fs.readFileSync(extPath, "utf-8"));
      externalSignals = normalizeExternalSignalsForPage(extRaw);
    }
    console.log(
      "[构建] 外部信号: " +
        externalSignals.items.length +
        "条, " +
        (externalSignals.tickerOpinions || []).length +
        "个股票观点"
    );
  } catch (e) {
    console.log("[构建] 外部信号获取失败: " + e.message);
  }
  template = template.replace(
    /var externalSignalsData = \{.*?\};/s,
    "var externalSignalsData = " + serializeForInlineScript(externalSignals) + ";"
  );

  // 嵌入假设数据
  const hypotheses = { hypotheses: [], stats: { total: 0, validated: 0, invalidated: 0, expired: 0 } };
  template = template.replace(
    /var hypothesesData = \{.*?\};/s,
    "var hypothesesData = " + serializeForInlineScript(hypotheses) + ";"
  );

  // 页面与服务端共用同一份交易日历，避免第二套硬编码漂移。
  const tradingHolidays = Array.from(tradingCalendar.loadHolidays()).filter(function (date) {
    return String(date).slice(0, 4) === asOf.slice(0, 4);
  }).sort();
  template = template.replace(
    /var tradingHolidays = \[.*?\];/s,
    "var tradingHolidays = " + serializeForInlineScript(tradingHolidays) + ";"
  );

  // 写入输出
  fs.writeFileSync(OUTPUT, template, "utf-8");

  // 必需文件任一复制/写入失败都终止构建，禁止上传半成品。
  copyRequiredPageAssets(newsData);
  validatePageArtifact(path.join(__dirname, "docs"));
  console.log("[构建] 已复制并验证公开数据和个性化决策模块");

  // 保存统一排名视图（兼容旧消费者，但数据源只有 RecommendationPlan）
  try {
    const ranked = (recommendationPlan.marketRanking || []).map(function (r, i) {
        return {
          rank: i + 1,
          code: r.code,
          name: r.name,
          indexGroup: r.indexGroup,
          score: r.marketScore,
          blockedBy: r.blockedBy || [],
          deduped: (r.blockedBy || []).indexOf("INDEX_CORE_ONLY") >= 0
        };
      });

    fs.writeFileSync(
      path.join(__dirname, "data", "factor-rankings.json"),
      JSON.stringify(
        {
          date: asOf,
          action: recommendationPlan.action,
          ranked: ranked,
          generatedAt: new Date().toISOString()
        },
        null,
        2
      ),
      "utf-8"
    );

    console.log(
      "[构建] FactorEngine排名: " +
        ranked.filter(function (r) {
          return !r.deduped;
        }).length +
        "只推荐"
    );
  } catch (e) {
    console.log("[构建] FactorEngine排名计算失败: " + e.message);
  }

  console.log(
    "[构建] 完成！持仓: " + portfolio.holdings.length + "只基金, 最新净值: " + Object.keys(latestNavs).length + "只"
  );
}

if (require.main === module) {
  build().catch(e => {
    console.error("[构建] 失败:", e.message);
    process.exit(1);
  });
}

module.exports = {
  build: build,
  formatDateInTimeZone: formatDateInTimeZone,
  decisionFingerprint: decisionFingerprint,
  copyRequiredPageAssets: copyRequiredPageAssets,
  validatePageArtifact: validatePageArtifact,
  loadPublicLedger: loadPublicLedger,
  loadPublicPortfolioSnapshot: loadPublicPortfolioSnapshot,
  validateCanonicalRecommendationPlan: validateCanonicalRecommendationPlan,
  loadCanonicalRecommendationPlan: loadCanonicalRecommendationPlan,
  marketOnlyPlan: marketOnlyPlan
};
