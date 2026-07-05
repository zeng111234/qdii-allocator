/**
 * AI 投资日记模块
 * 每次买入/卖出时自动调用 LLM 记录投资决策
 */

const fs = require("fs");
const path = require("path");
const { callLLM } = require("./llm-client"); // [修复] 原问题：通过daily-brief间接引用，统一使用llm-client

const DIARY_FILE = path.join(__dirname, "..", "data", "diary.json");

function loadDiary() {
  try {
    if (fs.existsSync(DIARY_FILE)) {
      return JSON.parse(fs.readFileSync(DIARY_FILE, "utf-8"));
    }
  } catch(e) {}
  return { entries: [] };
}

function saveDiary(diary) {
  try {
    fs.writeFileSync(DIARY_FILE, JSON.stringify(diary, null, 2), "utf-8");
  } catch(e) {
    console.error("[日记] 保存失败:", e.message);
  }
}

function buildPrompt(buyInfo, marketContext) {
  const lines = [];
  lines.push("我刚刚买入了一只基金，请帮我记录这笔投资决策。");
  lines.push("");
  lines.push("=== 买入信息 ===");
  lines.push("基金名称: " + buyInfo.name);
  lines.push("基金代码: " + buyInfo.code);
  lines.push("买入金额: " + buyInfo.amount + "元");
  if (buyInfo.nav) lines.push("买入净值: " + buyInfo.nav);
  lines.push("买入日期: " + buyInfo.date);
  lines.push("");

  if (marketContext) {
    lines.push("=== 市场背景 ===");
    lines.push(marketContext);
    lines.push("");
  }

  lines.push("请帮我写一段投资日记，包含：");
  lines.push("1. 买入理由（为什么选这只基金）");
  lines.push("2. 市场背景（当前市场环境）");
  lines.push("3. 预期（期望的收益和时间）");
  lines.push("4. 风险提示（可能的风险）");
  lines.push("");
  lines.push("用第一人称口语化中文写，像写日记一样，控制在150字以内。");

  return lines.join("\n");
}

async function recordBuyDiary(buyInfo, config, marketContext) {
  console.log("[日记] 记录买入决策...");

  const prompt = buildPrompt(buyInfo, marketContext);
  const text = await callLLM(prompt, config);

  const diary = loadDiary();
  const entry = {
    id: Date.now().toString(36),
    type: "buy",
    date: buyInfo.date || new Date().toISOString().slice(0, 10),
    fund: {
      code: buyInfo.code,
      name: buyInfo.name,
      amount: buyInfo.amount,
      nav: buyInfo.nav
    },
    content: text,
    createdAt: new Date().toISOString()
  };

  diary.entries.push(entry);
  saveDiary(diary);

  console.log("[日记] 已记录买入决策");
  return entry;
}

function getRecentEntries(count) {
  const diary = loadDiary();
  const entries = diary.entries || [];
  return entries.slice(-(count || 10));
}

function formatDiaryForDisplay(entries) {
  const lines = [];
  lines.push("=== 投资日记 ===");
  lines.push("");

  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    const emoji = e.type === "buy" ? "💰" : "📤";
    lines.push(emoji + " " + e.date + " " + e.fund.name);
    lines.push(e.content);
    lines.push("");
  }

  return lines.join("\n");
}

module.exports = { recordBuyDiary, loadDiary, saveDiary, getRecentEntries, formatDiaryForDisplay };
