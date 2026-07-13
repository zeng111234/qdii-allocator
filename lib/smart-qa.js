/**
 * AI 智能问答模块
 * 用户输入问题，调用 LLM 回答
 */

const fs = require("fs");
const path = require("path");
const { callLLM } = require("./llm-client"); // [修复] 原问题：通过daily-brief间接引用，统一使用llm-client

const PORTFOLIO_FILE = path.join(__dirname, "..", "data", "portfolio.json");
const HISTORY_FILE = path.join(__dirname, "..", "data", "history.json");
const DAILY_BRIEF_FILE = path.join(__dirname, "..", "data", "daily-brief.json");
const FACTOR_RANKINGS_FILE = path.join(__dirname, "..", "data", "factor-rankings.json");
const FUNDS_FILE = path.join(__dirname, "..", "data", "funds.json");
const HYPOTHESES_FILE = path.join(__dirname, "..", "data", "hypotheses.json");
const EXTERNAL_SIGNALS_FILE = path.join(__dirname, "..", "data", "external-signals-cache.json");

function loadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch (e) {
    return null;
  }
}

function loadPortfolio() {
  return loadJson(PORTFOLIO_FILE) || { holdings: [] };
}

function loadHistory() {
  const data = loadJson(HISTORY_FILE);
  return data ? data.records || [] : [];
}

function loadFunds() {
  return loadJson(FUNDS_FILE) || {};
}

function loadHypotheses() {
  return loadJson(HYPOTHESES_FILE) || { hypotheses: [], stats: {} };
}

function loadExternalSignals() {
  const data = loadJson(EXTERNAL_SIGNALS_FILE);
  if (!data) return [];
  // 支持数组格式或{data: [...]}格式
  if (Array.isArray(data)) return data;
  if (data.data && Array.isArray(data.data)) return data.data;
  return [];
}

/**
 * 场景识别：根据问题关键词判断场景
 */
function detectScenario(question) {
  const q = question.toLowerCase();

  // 今日买什么场景
  if (q.includes("买什么") || q.includes("买入") || q.includes("推荐") || q.includes("今天该") || q.includes("今日")) {
    return "buy_recommendation";
  }

  // 市场情绪场景
  if (q.includes("情绪") || q.includes("市场") || q.includes("大盘") || q.includes("走势") || q.includes("趋势")) {
    return "market_sentiment";
  }

  // 持仓分析场景
  if (q.includes("持仓") || q.includes("组合") || q.includes("风险") || q.includes("分散")) {
    return "portfolio_analysis";
  }

  // 默认通用场景
  return "general";
}

/**
 * 计算市场温度（简化版）
 */
function calculateMarketTemperature(factorRankings) {
  if (!factorRankings || !factorRankings.ranked) {
    return { temperature: 50, level: "中性", description: "数据不足" };
  }

  const ranked = factorRankings.ranked.filter(r => !r.deduped);
  if (ranked.length === 0) {
    return { temperature: 50, level: "中性", description: "数据不足" };
  }

  // 计算平均评分
  const avgScore = ranked.reduce((sum, r) => sum + r.score, 0) / ranked.length;

  // 评分映射到温度（0-100）
  // 假设评分范围是0-100，平均50为中性
  const temperature = Math.min(100, Math.max(0, avgScore));

  let level, description;
  if (temperature >= 80) {
    level = "过热";
    description = "市场情绪高涨，建议谨慎追高";
  } else if (temperature >= 60) {
    level = "偏热";
    description = "市场情绪偏乐观，可正常买入优质标的";
  } else if (temperature >= 40) {
    level = "中性";
    description = "市场情绪平稳，可正常配置";
  } else if (temperature >= 20) {
    level = "偏冷";
    description = "市场情绪偏悲观，可逢低布局";
  } else {
    level = "极冷";
    description = "市场情绪低迷，可能是抄底机会";
  }

  return { temperature: Math.round(temperature), level, description };
}

/**
 * 计算假设追踪胜率
 */
function calculateHypothesisWinRate(hypothesesData) {
  if (!hypothesesData || !hypothesesData.hypotheses || hypothesesData.hypotheses.length === 0) {
    return { winRate: null, total: 0, validated: 0, invalidated: 0 };
  }

  const validated = hypothesesData.hypotheses.filter(h => h.status === "validated").length;
  const invalidated = hypothesesData.hypotheses.filter(h => h.status === "invalidated").length;
  const meaningful = validated + invalidated;

  return {
    winRate: meaningful > 0 ? ((validated / meaningful) * 100).toFixed(1) : null,
    total: hypothesesData.hypotheses.length,
    validated,
    invalidated
  };
}

/**
 * 解析外部信号情绪
 */
function parseExternalSignalsSentiment(signals) {
  if (!signals || !Array.isArray(signals) || signals.length === 0) {
    return { bullish: 0, bearish: 0, neutral: 0, summary: "无外部信号数据" };
  }

  let bullish = 0,
    bearish = 0,
    neutral = 0;

  signals.forEach(signal => {
    if (signal.sentiment === "bullish" || signal.sentiment === "positive") {
      bullish++;
    } else if (signal.sentiment === "bearish" || signal.sentiment === "negative") {
      bearish++;
    } else {
      neutral++;
    }
  });

  let summary;
  if (bullish > bearish * 2) {
    summary = "外部信号明显偏多，市场情绪乐观";
  } else if (bearish > bullish * 2) {
    summary = "外部信号明显偏空，市场情绪悲观";
  } else if (bullish > bearish) {
    summary = "外部信号略偏多，市场情绪温和乐观";
  } else if (bearish > bullish) {
    summary = "外部信号略偏空，市场情绪温和悲观";
  } else {
    summary = "外部信号多空平衡，市场情绪中性";
  }

  return { bullish, bearish, neutral, summary };
}

/**
 * 构建Prompt（带场景识别）
 */
function buildPrompt(question) {
  const portfolio = loadPortfolio();
  const records = loadHistory();
  const dailyBrief = loadJson(DAILY_BRIEF_FILE);
  const factorRankings = loadJson(FACTOR_RANKINGS_FILE);
  const funds = loadFunds();
  const hypotheses = loadHypotheses();
  const externalSignals = loadExternalSignals();

  // 场景识别
  const scenario = detectScenario(question);

  // 计算市场温度
  const marketTemp = calculateMarketTemperature(factorRankings);

  // 计算假设胜率
  const hypothesisStats = calculateHypothesisWinRate(hypotheses);

  // 解析外部信号
  const signalsSentiment = parseExternalSignalsSentiment(externalSignals);

  const lines = [];
  lines.push("你是QDII基金投资助手，风格轻松口语化，像朋友聊天。回答控制在500字以内。");
  lines.push("核心原则：评分高≠推荐买，要看持仓分散、回撤、估值；同指数基金底层重叠要指出。");
  lines.push("数据使用原则：只使用下方提供的数据，禁止编造或推测未提供的数据。");
  lines.push("");

  // 根据场景添加专用指令
  if (scenario === "buy_recommendation") {
    lines.push("=== 场景：今日买什么 ===");
    lines.push("当用户问'今天该买什么'时，按以下步骤回答：");
    lines.push("1. 先看市场温度：如果≥80，建议'今天偏热，建议少买或等回调'");
    lines.push("2. 从持仓集中度出发：如果用户已持有3+只纳指基金，优先推荐非纳指类");
    lines.push("3. 结合评分+限购：评分≥25且限购≤100元的基金优先（稀缺+高分）");
    lines.push("4. 给出具体建议：推荐2-3只，每只说明理由和建议金额（30-100元）");
    lines.push("5. 给出风险提醒：当前组合最大回撤、行业集中度");
    lines.push("");
  } else if (scenario === "market_sentiment") {
    lines.push("=== 场景：市场情绪分析 ===");
    lines.push("当用户问'市场情绪'时，按以下步骤回答：");
    lines.push("1. 情绪分数解读：>20极度乐观(警惕追高), 10-20偏乐观, -10~10中性, <-10偏悲观(可关注抄底)");
    lines.push("2. 结合新闻逐条分析：列出利好新闻和利空新闻的具体内容");
    lines.push("3. 结合外部信号：大V观点是看涨还是看跌");
    lines.push("4. 给出操作建议：情绪偏乐观→正常买，情绪偏悲观→可逢低加仓");
    lines.push("");
  }

  lines.push("用户提问: " + question);
  lines.push("");

  // 市场温度数据
  lines.push("=== 市场温度 ===");
  lines.push("温度: " + marketTemp.temperature + " (" + marketTemp.level + ")");
  lines.push("解读: " + marketTemp.description);
  lines.push("");

  // 持仓信息
  if (portfolio.holdings && portfolio.holdings.length > 0) {
    lines.push("=== 用户持仓 ===");
    let totalAmount = 0;
    for (let i = 0; i < portfolio.holdings.length; i++) {
      const h = portfolio.holdings[i];
      let amount = 0;
      for (let j = 0; j < h.buys.length; j++) {
        amount += h.buys[j].amount || 0;
      }
      totalAmount += amount;

      // 获取基金详情（限购信息）
      const fundDetail = funds[h.code] || {};
      const limitInfo = fundDetail.purchaseLimit ? " 限购:" + fundDetail.purchaseLimit + "元" : "";

      lines.push("- " + h.name + " (" + h.code + ") 投入:" + amount + "元" + limitInfo);
    }
    lines.push("总投入: " + totalAmount + "元");
    lines.push("");
  }

  // FactorEngine 排名（与页面一致）
  if (factorRankings && factorRankings.ranked) {
    const buyable = factorRankings.ranked.filter(function (r) {
      return !r.deduped;
    });
    lines.push("=== 最新排名 Top10 (FactorEngine评分, 日期:" + (factorRankings.date || "未知") + ") ===");
    buyable.slice(0, 10).forEach(function (f, k) {
      // 获取基金详情（限购信息）
      const fundDetail = funds[f.code] || {};
      const limitInfo = fundDetail.purchaseLimit ? " 限购:" + fundDetail.purchaseLimit + "元" : "";

      lines.push(k + 1 + ". " + f.name + " (" + f.code + ") 评分:" + f.score + " 类型:" + f.type + limitInfo);
    });
    lines.push("");
  }

  // 假设追踪胜率
  if (hypothesisStats.winRate !== null) {
    lines.push("=== 假设追踪胜率 ===");
    lines.push(
      "胜率: " +
        hypothesisStats.winRate +
        "% (验证通过:" +
        hypothesisStats.validated +
        " 否定:" +
        hypothesisStats.invalidated +
        ")"
    );
    lines.push("总计: " + hypothesisStats.total + " 个假设");
    lines.push("");
  }

  // 外部信号情绪
  if (externalSignals && externalSignals.length > 0) {
    lines.push("=== 外部信号情绪 ===");
    lines.push("多头信号: " + signalsSentiment.bullish + "个");
    lines.push("空头信号: " + signalsSentiment.bearish + "个");
    lines.push("中性信号: " + signalsSentiment.neutral + "个");
    lines.push("总结: " + signalsSentiment.summary);
    lines.push("");
  }

  // 历史推荐胜率
  if (records.length > 0) {
    let wins = 0,
      total = 0,
      totalRet = 0;
    records.slice(-10).forEach(function (r) {
      (r.ranked || []).forEach(function (f) {
        if (f.followUp5dReturn !== null && f.followUp5dReturn !== undefined) {
          total++;
          totalRet += f.followUp5dReturn;
          if (f.followUp5dReturn > 0) wins++;
        }
      });
    });
    if (total > 0) {
      lines.push("=== 近期推荐表现 (最近10次) ===");
      lines.push("5日胜率: " + wins + "/" + total + " (" + ((wins / total) * 100).toFixed(0) + "%)");
      lines.push("5日平均收益: " + (totalRet / total).toFixed(2) + "%");
      lines.push("");
    }
  }

  // 今日早报（清理思维链）
  if (dailyBrief && dailyBrief.content && dailyBrief.content.length > 10) {
    lines.push("=== 今日早报 ===");
    // 清理LLM思维链标签
    let briefContent = dailyBrief.content;
    briefContent = briefContent.replace(/<think>[\s\S]*?<\/think>/g, "");
    briefContent = briefContent.replace(/<ANALYSIS_BLOCK>[\s\S]*?<\/ANALYSIS_BLOCK>/g, "");
    briefContent = briefContent.replace(/<ORDERS_JSON>[\s\S]*?<\/ORDERS_JSON>/g, "");
    briefContent = briefContent.replace(/\[思考过程\][\s\S]*?\[\/思考过程\]/g, "");
    briefContent = briefContent.replace(/\[分析\][\s\S]*?\[\/分析\]/g, "");
    // 清理未闭合的标签
    briefContent = briefContent.replace(/<ANALYSIS_BLOCK>/g, "");
    briefContent = briefContent.replace(/<\/ANALYSIS_BLOCK>/g, "");
    briefContent = briefContent.replace(/<ORDERS_JSON>/g, "");
    briefContent = briefContent.replace(/<\/ORDERS_JSON>/g, "");
    briefContent = briefContent.replace(/MORNING_SUMMARY>/g, "");
    lines.push(briefContent.slice(0, 800));
    lines.push("");
  }

  // 场景化输出格式要求
  if (scenario === "buy_recommendation") {
    lines.push("=== 输出格式要求 ===");
    lines.push("请按以下结构回答：");
    lines.push("1. 今日推荐（2-3只，含代码和建议金额）");
    lines.push("2. 推荐理由（结合评分、技术指标、限购稀缺度）");
    lines.push("3. 风险提示（回撤、相关性、底层重叠）");
    lines.push("4. 操作建议（具体买入金额和时机）");
    lines.push("");
  } else if (scenario === "market_sentiment") {
    lines.push("=== 输出格式要求 ===");
    lines.push("请按以下结构回答：");
    lines.push("1. 当前情绪判断（乐观/中性/悲观 + 温度数值）");
    lines.push("2. 支撑证据（新闻、外部信号、市场数据）");
    lines.push("3. 历史类比（类似市场环境下的表现）");
    lines.push("4. 操作建议（具体买入/卖出/观望建议）");
    lines.push("");
  }

  lines.push("请用口语化中文回答，像朋友聊天一样。控制在500字以内。");

  return lines.join("\n");
}

async function askQuestion(question, config) {
  console.log("[问答] 处理问题: " + question);

  const prompt = buildPrompt(question);
  const answer = await callLLM(prompt, config);

  return {
    question: question,
    answer: answer,
    timestamp: new Date().toISOString()
  };
}

module.exports = { askQuestion, buildPrompt };
