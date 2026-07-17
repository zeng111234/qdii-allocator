/**
 * AI 智能问答模块
 * 用户输入问题，调用 LLM 回答
 */

const fs = require("fs");
const path = require("path");
const { callLLM } = require("./llm-client"); // [修复] 原问题：通过daily-brief间接引用，统一使用llm-client
const recommendationEngine = require("./recommendation-engine");

const PORTFOLIO_FILE = path.join(__dirname, "..", "data", "portfolio.json");
const HISTORY_FILE = path.join(__dirname, "..", "data", "history.json");
const DAILY_BRIEF_FILE = path.join(__dirname, "..", "data", "daily-brief.json");
const FACTOR_RANKINGS_FILE = path.join(__dirname, "..", "data", "factor-rankings.json");
const FUNDS_FILE = path.join(__dirname, "..", "data", "funds.json");
const HYPOTHESES_FILE = path.join(__dirname, "..", "data", "hypotheses.json");
const EXTERNAL_SIGNALS_FILE = path.join(__dirname, "..", "data", "external-signals-cache.json");
const RECOMMENDATION_PLAN_FILE = path.join(__dirname, "..", "data", "recommendation-plan.json");

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

function loadRecommendationPlan(options) {
  if (options && options.recommendationPlan) return options.recommendationPlan;
  return loadJson(RECOMMENDATION_PLAN_FILE) || {
    asOf: new Date().toISOString().slice(0, 10),
    action: "PAUSE",
    budget: 0,
    candidates: [],
    dataFreshness: { status: "UNAVAILABLE" },
    signalHealth: { status: "PAUSE" }
  };
}

function formatRecommendationPlanContext(plan) {
  const lines = [];
  const signalHealth = plan.signalHealth || {};
  const dataFreshness = plan.dataFreshness || {};
  lines.push("=== 确定性 RecommendationPlan（不可修改） ===");
  lines.push("日期: " + (plan.asOf || "未知"));
  lines.push("action: " + (plan.action || "PAUSE"));
  lines.push("预算: " + Number(plan.budget || 0) + "元");
  lines.push("信号健康度: " + (signalHealth.status || "未知"));
  lines.push("数据新鲜度: " + (dataFreshness.status || "未知"));
  if (dataFreshness.latestNavDate) lines.push("最新净值日期: " + dataFreshness.latestNavDate);
  if (plan.action === "BUY") {
    lines.push("仅允许解释以下候选及其精确金额：");
    (plan.candidates || []).forEach(function (candidate) {
      lines.push(
        "- " + candidate.name + " (" + candidate.code + "): " + Number(candidate.proposedAmount || 0) + "元"
      );
    });
  } else {
    lines.push("PAUSE/HOLD 的含义是今天不买，预算为0元；禁止推荐任何基金或金额。");
  }
  lines.push("AI 只能解释该计划，不得改变 action、候选基金或 proposedAmount。");
  return lines;
}

function formatPausedAnswer(plan) {
  const signalHealth = plan.signalHealth || {};
  const matured = signalHealth.matured || {};
  const reasons = [];
  if (signalHealth.status) reasons.push("信号健康度为" + signalHealth.status);
  if (matured.count !== undefined) reasons.push("已有" + matured.count + "个成熟样本");
  if (matured.winRate !== null && matured.winRate !== undefined) reasons.push("胜率" + matured.winRate + "%");
  if (matured.averageReturn !== null && matured.averageReturn !== undefined) {
    reasons.push("平均收益" + matured.averageReturn + "%");
  }
  if (signalHealth.breakerTriggered) reasons.push("信号熔断已触发");
  const reasonText = reasons.length > 0 ? " 原因：" + reasons.join("，") + "。" : "";
  return "确定性计划为" + (plan.action || "PAUSE") + "：今天不买，预算为0元。" + reasonText;
}

function extractJson(output) {
  if (output && typeof output === "object") return output;
  if (typeof output !== "string") return null;
  let text = output.trim();
  text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  try {
    return JSON.parse(text);
  } catch (error) {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch (nestedError) {
      return null;
    }
  }
}

function validateBuyAnswer(plan, output) {
  const parsed = extractJson(output);
  if (!parsed) return { valid: false, errors: ["INVALID_JSON"] };
  const base = recommendationEngine.validateAIOutput(plan, parsed);
  const errors = base.errors.slice();
  const expected = plan.candidates || [];
  const actual = Array.isArray(parsed.candidates) ? parsed.candidates : [];
  if (actual.length !== expected.length) errors.push("CANDIDATE_COUNT_MISMATCH");
  expected.forEach(function (candidate) {
    const match = actual.find(function (item) { return item.code === candidate.code; });
    if (!match) errors.push("MISSING_FUND:" + candidate.code);
    else if (Number(match.proposedAmount) !== Number(candidate.proposedAmount)) {
      errors.push("AMOUNT_MISMATCH:" + candidate.code);
    }
  });

  const allowedCodes = new Set(expected.map(function (candidate) { return candidate.code; }));
  const allowedAmounts = new Set(expected.map(function (candidate) { return Number(candidate.proposedAmount); }));
  const narrative = [parsed.summary || ""]
    .concat(actual.map(function (candidate) { return candidate.explanation || ""; }))
    .join(" ");
  const mentionedCodes = narrative.match(/\b\d{6}\b/g) || [];
  mentionedCodes.forEach(function (code) {
    if (!allowedCodes.has(code)) errors.push("UNKNOWN_FUND_IN_TEXT:" + code);
  });
  const amountPattern = /(\d+(?:\.\d+)?)\s*元/g;
  let amountMatch;
  while ((amountMatch = amountPattern.exec(narrative)) !== null) {
    if (!allowedAmounts.has(Number(amountMatch[1]))) errors.push("UNKNOWN_AMOUNT_IN_TEXT:" + amountMatch[1]);
  }
  if (/另(?:外)?(?:推荐|买入|加仓)|新增基金|改为|调整(?:金额|预算)/.test(narrative)) {
    errors.push("PLAN_OVERRIDE_IN_TEXT");
  }
  return { valid: errors.length === 0, errors: Array.from(new Set(errors)), value: parsed };
}

function formatBuyAnswer(plan, parsed) {
  const explanations = {};
  (parsed.candidates || []).forEach(function (candidate) {
    explanations[candidate.code] = candidate.explanation || "按确定性计划执行";
  });
  const lines = ["确定性计划：BUY；今日预算" + Number(plan.budget || 0) + "元。"];
  (plan.candidates || []).forEach(function (candidate) {
    lines.push(
      "- " + candidate.name + " (" + candidate.code + ")：" +
        Number(candidate.proposedAmount || 0) + "元。" + explanations[candidate.code]
    );
  });
  return lines.join("\n");
}

function validateMarketSentimentAnswer(answer) {
  const text = typeof answer === "string" ? answer : "";
  const tradingInstruction = /(?:建议|可以|适合|应当|应该|值得)?\s*(?:买入|加仓|减仓|卖出|抄底|赎回)|逢低(?:布局|买入)|正常买/;
  return { valid: text.length > 0 && !tradingInstruction.test(text), errors: tradingInstruction.test(text) ? ["TRADING_FROM_SENTIMENT"] : [] };
}

function formatMarketSentimentFallback(plan) {
  return "市场情绪仅作说明，不能据此触发买入或加仓。当前确定性计划为" +
    (plan.action || "PAUSE") + "，预算" + Number(plan.budget || 0) + "元。";
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
function buildPrompt(question, options) {
  const portfolio = loadPortfolio();
  const records = loadHistory();
  const dailyBrief = loadJson(DAILY_BRIEF_FILE);
  const factorRankings = loadJson(FACTOR_RANKINGS_FILE);
  const funds = loadFunds();
  const hypotheses = loadHypotheses();
  const externalSignals = loadExternalSignals();
  const recommendationPlan = loadRecommendationPlan(options);

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
  formatRecommendationPlanContext(recommendationPlan).forEach(function (line) { lines.push(line); });
  lines.push("");

  // 根据场景添加专用指令
  if (scenario === "buy_recommendation") {
    lines.push("=== 场景：今日买什么 ===");
    if (recommendationPlan.action === "BUY") {
      lines.push("只解释 RecommendationPlan 中已有候选及其 proposedAmount，不得新增基金或修改金额。");
      lines.push("评分、市场温度和限购信息只能解释原因，不能改写计划。");
    } else {
      lines.push("当前计划不是 BUY。必须明确回答今天不买、预算为0元；禁止推荐任何基金或金额。");
      lines.push("只解释信号健康度、数据新鲜度或风控熔断原因。");
    }
    lines.push("");
  } else if (scenario === "market_sentiment") {
    lines.push("=== 场景：市场情绪分析 ===");
    lines.push("当用户问'市场情绪'时，按以下步骤回答：");
    lines.push("1. 情绪分数解读：>20极度乐观, 10-20偏乐观, -10~10中性, <-10偏悲观；仅描述情绪，不推导交易动作");
    lines.push("2. 结合新闻逐条分析：列出利好新闻和利空新闻的具体内容");
    lines.push("3. 结合外部信号：大V观点是看涨还是看跌");
    lines.push("4. 市场情绪只作说明，不构成交易信号；不得据此触发买入、加仓、减仓或卖出");
    lines.push("5. 交易动作只能引用确定性 RecommendationPlan，情绪不能覆盖 PAUSE/HOLD");
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
    const holdingsSummary = portfolio.holdings || [];
    const typeCountMap = {};
    holdingsSummary.forEach(function (h) {
      const type = (h.type || "未知").toString();
      typeCountMap[type] = (typeCountMap[type] || 0) + 1;
    });
    const typeCountEntries = Object.entries(typeCountMap).sort(function (a, b) {
      return b[1] - a[1];
    });
    if (typeCountEntries.length > 0) {
      lines.push(
        "持仓类型分布: " +
          typeCountEntries
            .map(function (pair) {
              return pair[0] + "(" + pair[1] + "只)";
            })
            .join("、")
      );
    }
    if (totalAmount > 0) {
      lines.push("风控提示: 同类型基金>=3只时，应优先分散到不同指数或不同区域资产");
    }
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
    if (recommendationPlan.action === "BUY") {
      const outputShape = {
        action: "BUY",
        candidates: (recommendationPlan.candidates || []).map(function (candidate) {
          return {
            code: candidate.code,
            proposedAmount: Number(candidate.proposedAmount || 0),
            explanation: "仅解释该计划候选"
          };
        }),
        summary: "仅解释确定性计划"
      };
      lines.push("只输出以下 JSON 结构，不要使用 Markdown 代码块：");
      lines.push(JSON.stringify(outputShape));
      lines.push("不得新增基金或修改金额。");
    } else {
      lines.push("只回答 PAUSE/HOLD 原因、今天不买和预算0元，不得列出基金或金额。");
    }
    lines.push("");
  } else if (scenario === "market_sentiment") {
    lines.push("=== 输出格式要求 ===");
    lines.push("请按以下结构回答：");
    lines.push("1. 当前情绪判断（乐观/中性/悲观 + 温度数值）");
    lines.push("2. 支撑证据（新闻、外部信号、市场数据）");
    lines.push("3. 历史类比（类似市场环境下的表现）");
    lines.push("4. 与交易计划的关系（只能说明 RecommendationPlan 状态，不能生成操作建议）");
    lines.push("");
  }

  lines.push("请用口语化中文回答，像朋友聊天一样。控制在500字以内。");

  return lines.join("\n");
}

async function askQuestion(question, config, options) {
  console.log("[问答] 处理问题: " + question);

  const runtimeOptions = options || {};
  const recommendationPlan = loadRecommendationPlan(runtimeOptions);
  const scenario = detectScenario(question);
  if (scenario === "buy_recommendation" && recommendationPlan.action !== "BUY") {
    return {
      question: question,
      answer: formatPausedAnswer(recommendationPlan),
      timestamp: new Date().toISOString()
    };
  }

  const prompt = buildPrompt(question, { recommendationPlan: recommendationPlan });
  const llm = runtimeOptions.callLLM || callLLM;
  const rawAnswer = await llm(prompt, config);
  let answer = rawAnswer;
  if (scenario === "buy_recommendation") {
    const validation = validateBuyAnswer(recommendationPlan, rawAnswer);
    answer = validation.valid
      ? formatBuyAnswer(recommendationPlan, validation.value)
      : "[AI 解读已拒绝：输出与 RecommendationPlan 不一致]";
  } else if (scenario === "market_sentiment") {
    const validation = validateMarketSentimentAnswer(rawAnswer);
    if (!validation.valid) answer = formatMarketSentimentFallback(recommendationPlan);
  }

  return {
    question: question,
    answer: answer,
    timestamp: new Date().toISOString()
  };
}

module.exports = {
  askQuestion,
  buildPrompt,
  validateBuyAnswer,
  validateMarketSentimentAnswer
};
