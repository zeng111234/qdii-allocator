/**
 * AI 每日早报模块（v2）
 * 用丰富数据生成口语化投资早报，像朋友发的消息
 */

const fs = require("fs");
const path = require("path");
const { callLLM } = require("./llm-client");

const BRIEF_FILE = path.join(__dirname, "..", "data", "daily-brief.json");

function round2(n) { return Math.round(n * 100) / 100; }

/**
 * 构建早报提示词 — 数据丰富，格式简单
 * @param {Object} result - 来自 dynamic-strategy 的完整结果
 * @param {Object} portfolioData - 持仓数据（含盈亏）
 */
function buildPrompt(result, portfolioData) {
  const lines = [];
  const today = new Date().toISOString().slice(0, 10);

  lines.push("你是投资者的朋友，每天早上给他发一条轻松的投资早报。");
  lines.push("风格：口语化、简洁、有温度。像微信消息，不像报告。");
  lines.push("长度：200-300字。直接输出早报内容，不要输出思考过程。");
  lines.push("");

  // 市场温度
  if (result && result.marketTemperature) {
    const mt = result.marketTemperature;
    lines.push("🌡️ 市场温度: " + mt.temperature + "/100 (" + mt.level + ")");
    lines.push("建议投入: " + (result.budgetInfo ? result.budgetInfo.adjustedBudget || result.budget : 50) + "元");
    lines.push("");
  }

  // 实时市场数据
  if (result && result.marketSnapshot && result.marketSnapshot.length > 0) {
    lines.push("📈 主要指数:");
    const keyIndices = result.marketSnapshot.filter(function(m) {
      return ["NDX", "SPX", "DJIA", "HSI", "VIX"].indexOf(m.code) >= 0;
    });
    for (let i = 0; i < keyIndices.length; i++) {
      const m = keyIndices[i];
      lines.push("  " + m.name + ": " + m.price + " (" + (m.change >= 0 ? "+" : "") + round2(m.change) + "%)");
    }
    lines.push("");
  }

  // Top5 推荐
  if (result && result.ranked && result.ranked.length > 0) {
    lines.push("🏆 今日推荐 Top5:");
    const top5 = result.ranked.slice(0, 5);
    for (let i = 0; i < top5.length; i++) {
      const f = top5[i];
      const ind = f.indicators || {};
      const yr = f.yearReturn !== null && f.yearReturn !== undefined ? f.yearReturn : "N/A";
      lines.push("  " + (i + 1) + ". " + f.name + " (" + f.score + "分) 1年" + yr + "%");
    }
    lines.push("");
  }

  // 持仓盈亏
  if (portfolioData && portfolioData.holdings && portfolioData.holdings.length > 0) {
    lines.push("💰 我的持仓:");
    let totalInvested = 0;
    let totalValue = 0;
    for (let j = 0; j < portfolioData.holdings.length; j++) {
      const h = portfolioData.holdings[j];
      let invested = 0;
      for (let k = 0; k < h.buys.length; k++) {
        invested += h.buys[k].amount || 0;
      }
      const shares = h.buys.reduce(function(s, b) { return s + (b.shares || 0); }, 0);
      const latestNav = h.latestNav || h.buys[h.buys.length - 1].nav || 0;
      const value = round2(shares * latestNav);
      const pnl = round2(value - invested);
      totalInvested += invested;
      totalValue += value;
      if (Math.abs(pnl) > 0.5) {
        lines.push("  " + h.name + ": 投" + invested + "元, 市值" + value + "元, " + (pnl >= 0 ? "赚" : "亏") + Math.abs(pnl) + "元");
      }
    }
    const totalPnl = round2(totalValue - totalInvested);
    lines.push("  总计: 投" + round2(totalInvested) + "元, 市值" + round2(totalValue) + "元, " + (totalPnl >= 0 ? "赚" : "亏") + Math.abs(totalPnl) + "元");
    lines.push("");
  }

  // 最新新闻（最多3条）
  if (result && result.marketNews && result.marketNews.length > 0) {
    lines.push("📰 最新快讯:");
    const news = result.marketNews.slice(0, 3);
    for (let n = 0; n < news.length; n++) {
      lines.push("  • " + news[n].title);
    }
    lines.push("");
  }

  lines.push("═══");
  lines.push("直接输出早报内容（200-300字），覆盖以下要点：");
  lines.push("1. 市场一句话总结（涨了还是跌了，为什么）");
  lines.push("2. 持仓点评（赚了还是亏了，哪只表现好/差）");
  lines.push("3. 今日建议（买什么、投多少、为什么）");
  lines.push("4. 风险提醒（如有）");
  lines.push("");
  lines.push("注意：不要输出思考过程，不要输出XML标签，直接输出早报正文。");

  return lines.join("\n");
}

/**
 * 清理 LLM 输出：移除思维链、XML标签等
 */
function cleanLLMOutput(text) {
  if (!text) return "";

  // 移除 <thinking>...</thinking> 块
  text = text.replace(/<thinking>[\s\S]*?<\/thinking>/gi, "");
  // 移除 <think>...</think> 块（某些模型格式）
  text = text.replace(/<think>[\s\S]*?<\/think>/gi, "");
  // 移除 XML 标签
  text = text.replace(/<\/?(?:MORNING_SUMMARY|ANALYSIS_BLOCK|ORDERS_JSON|CONFIDENCE_ASSESSMENT|MARKET_SENTIMENT)[^>]*>/gi, "");
  // 移除开头的"好的""以下是"等过渡语
  text = text.replace(/^(好的[，,]?|以下是.*?早报[：:]?|早报内容[：:]?)\s*/i, "");
  // 清理多余空行
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

/**
 * 生成每日早报
 * @param {Object} config - LLM 配置 { apiKey, baseUrl, model }
 * @param {Object} result - 来自 dynamic-strategy 的完整结果（可选）
 * @param {Object} portfolioData - 持仓数据（可选）
 */
async function generateDailyBrief(config, result, portfolioData) {
  console.log("[早报] 生成今日早报...");

  const prompt = buildPrompt(result, portfolioData);

  let text;
  try {
    text = await callLLM(prompt, config);
  } catch (e) {
    console.warn("[早报] LLM 调用失败:", e.message);
    return { date: new Date().toISOString().slice(0, 10), content: "早报生成失败：" + e.message, generatedAt: new Date().toISOString() };
  }

  // 清理输出
  text = cleanLLMOutput(text);

  if (!text || text.length < 20) {
    console.warn("[早报] LLM 输出过短或为空，使用 fallback");
    text = generateFallbackBrief(result, portfolioData);
  }

  const brief = {
    date: new Date().toISOString().slice(0, 10),
    content: text,
    generatedAt: new Date().toISOString()
  };

  // 保存
  try {
    fs.writeFileSync(BRIEF_FILE, JSON.stringify(brief, null, 2), "utf-8");
    console.log("[早报] 已保存 (" + text.length + "字)");
  } catch (e) {
    console.warn("[早报] 保存失败:", e.message);
  }

  return brief;
}

/**
 * Fallback：LLM 失败时用数据直接生成简报
 */
function generateFallbackBrief(result, portfolioData) {
  const parts = [];
  const today = new Date().toISOString().slice(0, 10);
  parts.push("📊 " + today + " 早报\n");

  if (result && result.marketTemperature) {
    const mt = result.marketTemperature;
    parts.push("🌡️ 市场温度 " + mt.temperature + "/100 (" + mt.level + ")，建议投入" + (result.budgetInfo ? result.budgetInfo.adjustedBudget || result.budget : 50) + "元。");
  }

  if (result && result.ranked && result.ranked.length > 0) {
    const top3 = result.ranked.slice(0, 3);
    parts.push("\n🏆 今日Top3:");
    for (let i = 0; i < top3.length; i++) {
      parts.push((i + 1) + ". " + top3[i].name + " (" + top3[i].score + "分)");
    }
  }

  if (portfolioData && portfolioData.holdings) {
    let total = 0;
    for (let j = 0; j < portfolioData.holdings.length; j++) {
      const h = portfolioData.holdings[j];
      for (let k = 0; k < h.buys.length; k++) total += h.buys[k].amount || 0;
    }
    parts.push("\n💰 持仓 " + portfolioData.holdings.length + "只，总投入" + round2(total) + "元");
  }

  parts.push("\n💡 建议按系统推荐定投，长期持有。");
  return parts.join("\n");
}

function loadBrief() {
  try {
    if (fs.existsSync(BRIEF_FILE)) {
      return JSON.parse(fs.readFileSync(BRIEF_FILE, "utf-8"));
    }
  } catch (e) {}
  return null;
}

module.exports = { generateDailyBrief, loadBrief, buildPrompt, cleanLLMOutput };
