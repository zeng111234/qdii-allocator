/**
 * AI 智能问答模块
 * 用户输入问题，调用 LLM 回答
 */

const fs = require("fs");
const path = require("path");
const { callLLM } = require("./llm-client"); // [修复] 原问题：通过daily-brief间接引用，统一使用llm-client

const PORTFOLIO_FILE = path.join(__dirname, "..", "data", "portfolio.json");
const HISTORY_FILE = path.join(__dirname, "..", "data", "history.json");

function loadPortfolio() {
  try {
    return JSON.parse(fs.readFileSync(PORTFOLIO_FILE, "utf-8"));
  } catch(e) { return { holdings: [] }; }
}

function loadHistory() {
  try {
    const data = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf-8"));
    return data.records || [];
  } catch(e) { return []; }
}

function buildPrompt(question) {
  const portfolio = loadPortfolio();
  const records = loadHistory();
  const latest = records[records.length - 1];

  const lines = [];
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

  // 今日排名
  if (latest && latest.ranked) {
    lines.push("=== 今日排名 Top5 ===");
    const top5 = latest.ranked.slice(0, 5);
    for (let k = 0; k < top5.length; k++) {
      const f = top5[k];
      lines.push((k+1) + ". " + f.name + " 得分:" + f.score + " 类型:" + f.type);
    }
    lines.push("");
  }

  lines.push("请用口语化中文回答，像朋友聊天一样。控制在200字以内。");

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
