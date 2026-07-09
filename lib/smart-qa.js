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

function loadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch(e) { return null; }
}

function loadPortfolio() {
  return loadJson(PORTFOLIO_FILE) || { holdings: [] };
}

function loadHistory() {
  const data = loadJson(HISTORY_FILE);
  return data ? (data.records || []) : [];
}

function buildPrompt(question) {
  const portfolio = loadPortfolio();
  const records = loadHistory();
  const dailyBrief = loadJson(DAILY_BRIEF_FILE);
  const factorRankings = loadJson(FACTOR_RANKINGS_FILE);

  const lines = [];
  lines.push("你是QDII基金投资助手，风格轻松口语化，像朋友聊天。回答控制在500字以内。");
  lines.push("核心原则：评分高≠推荐买，要看持仓分散、回撤、估值；同指数基金底层重叠要指出。");
  lines.push("");
  lines.push("用户提问: " + question);
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
      lines.push("- " + h.name + " (" + h.code + ") 投入:" + amount + "元");
    }
    lines.push("总投入: " + totalAmount + "元");
    lines.push("");
  }

  // FactorEngine 排名（与页面一致）
  if (factorRankings && factorRankings.ranked) {
    const buyable = factorRankings.ranked.filter(function(r) { return !r.deduped; });
    lines.push("=== 最新排名 Top10 (FactorEngine评分, 日期:" + (factorRankings.date || '未知') + ") ===");
    buyable.slice(0, 10).forEach(function(f, k) {
      lines.push((k+1) + ". " + f.name + " (" + f.code + ") 评分:" + f.score + " 类型:" + f.type);
    });
    lines.push("");
  }

  // 历史推荐胜率
  if (records.length > 0) {
    let wins = 0, total = 0, totalRet = 0;
    records.slice(-10).forEach(function(r) {
      (r.ranked || []).forEach(function(f) {
        if (f.followUp5dReturn !== null && f.followUp5dReturn !== undefined) {
          total++;
          totalRet += f.followUp5dReturn;
          if (f.followUp5dReturn > 0) wins++;
        }
      });
    });
    if (total > 0) {
      lines.push("=== 近期推荐表现 (最近10次) ===");
      lines.push("5日胜率: " + wins + "/" + total + " (" + (wins/total*100).toFixed(0) + "%)");
      lines.push("5日平均收益: " + (totalRet/total).toFixed(2) + "%");
      lines.push("");
    }
  }

  // 今日早报
  if (dailyBrief && dailyBrief.content && dailyBrief.content.length > 10) {
    lines.push("=== 今日早报 ===");
    lines.push(dailyBrief.content.slice(0, 500));
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
