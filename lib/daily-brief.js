/**
 * AI 每日早报模块
 * 每天早上调用 LLM 生成口语化投资早报
 */

const fs = require("fs");
const path = require("path");

const BRIEF_FILE = path.join(__dirname, "..", "data", "daily-brief.json");
const HISTORY_FILE = path.join(__dirname, "..", "data", "history.json");
const PORTFOLIO_FILE = path.join(__dirname, "..", "data", "portfolio.json");

function callLLM(prompt, config) {
  const https = require("https");
  const http = require("http");
  const url = new URL(config.baseUrl);
  const lib = url.protocol === "https:" ? https : http;
  const body = JSON.stringify({
    model: config.model,
    messages: [
      {
        role: "system",
        content: "你是投资者的私人理财助手，风格像朋友聊天一样轻松自然。" +
          "用口语化中文写早报，不要太正式。" +
          "要点：1) 市场情绪一句话总结 2) 持仓盈亏点评 3) 今日操作建议 4) 风险提醒。" +
          "如果市场大跌，安慰投资者'定投本来就是越跌越买'；" +
          "如果连涨几天，提醒'可以稍微等等再加仓'。" +
          "控制在300字以内。"
      },
      { role: "user", content: prompt }
    ],
    temperature: 0.3,
    max_tokens: 1500
  });

  return new Promise(function(resolve, reject) {
    const req = lib.request({
      hostname: url.hostname, port: url.port || (url.protocol === "https:" ? 443 : 80),
      path: url.pathname, method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + config.apiKey, "Content-Length": Buffer.byteLength(body) },
      timeout: 60000
    }, function(res) {
      let data = "";
      res.on("data", function(chunk) { data += chunk; });
      res.on("end", function() {
        try {
          const json = JSON.parse(data);
          if (json.choices && json.choices[0]) {
            const msg = json.choices[0].message;
            const text = msg.content || msg.reasoning_content || "";
            resolve(text.trim());
          } else {
            reject(new Error("LLM error: " + (json.error ? json.error.message : "unknown")));
          }
        } catch(e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.on("timeout", function() { req.destroy(); reject(new Error("timeout")); });
    req.write(body);
    req.end();
  });
}

function loadHistory() {
  try {
    const data = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf-8"));
    return data.records || [];
  } catch(e) { return []; }
}

function loadPortfolio() {
  try {
    return JSON.parse(fs.readFileSync(PORTFOLIO_FILE, "utf-8"));
  } catch(e) { return { holdings: [] }; }
}

function buildPrompt() {
  const records = loadHistory();
  const portfolio = loadPortfolio();
  const latest = records[records.length - 1];
  const today = new Date().toISOString().slice(0, 10);

  const lines = [];
  lines.push("今天是 " + today + "，请生成今日投资早报。");
  lines.push("");

  // 排名信息
  if (latest && latest.ranked) {
    lines.push("=== 今日排名 Top5 ===");
    const top5 = latest.ranked.slice(0, 5);
    for (let i = 0; i < top5.length; i++) {
      const f = top5[i];
      lines.push((i+1) + ". " + f.name + " (" + f.code + ") 得分:" + f.score + " 类型:" + f.type);
      if (f.indicators) {
        lines.push("   1年:" + (f.yearReturn || "N/A") + "% 夏普:" + (f.indicators.sharpeRatio || "N/A") + " 回撤:" + (f.indicators.maxDrawdown || "N/A") + "%");
      }
    }
    lines.push("");
  }

  // 持仓信息
  if (portfolio.holdings && portfolio.holdings.length > 0) {
    lines.push("=== 我的持仓 ===");
    let totalInvested = 0;
    for (let j = 0; j < portfolio.holdings.length; j++) {
      const h = portfolio.holdings[j];
      let amount = 0;
      for (let k = 0; k < h.buys.length; k++) {
        amount += h.buys[k].amount || 0;
      }
      totalInvested += amount;
      lines.push("- " + h.name + " (" + h.code + ") 投入:" + amount + "元");
    }
    lines.push("总投入: " + totalInvested + "元");
    lines.push("");
  }

  lines.push("");
  lines.push("═══ 数据真实性约束 ═══");
  lines.push("- 你只能使用上方提供的数据，禁止编造");
  lines.push("- 数据缺失时标注'无数据'而非猜测");
  lines.push("");
  lines.push("═══ 输出格式 ═══");
  lines.push("请输出以下两个标签块：");
  lines.push("");
  lines.push("<MORNING_SUMMARY>");
  lines.push("口语化早报正文（500字以内），覆盖：");
  lines.push("1. 市场情绪（一句话 + 核心驱动）");
  lines.push("2. 持仓点评（表现好和需要关注的各1只）");
  lines.push("3. 今日操作建议（买什么、停什么、为什么）");
  lines.push("4. 风险提醒（如有）");
  lines.push("</MORNING_SUMMARY>");
  lines.push("");
  lines.push("<MARKET_SENTIMENT>");
  lines.push('{"overall":"bullish/neutral/bearish","key_driver":"一句话","confidence":0.0到1.0}');
  lines.push("</MARKET_SENTIMENT>");

  return lines.join("\n");
}

async function generateDailyBrief(config) {
  console.log("[早报] 生成今日早报...");

  const prompt = buildPrompt();
  const text = await callLLM(prompt, config);

  const brief = {
    date: new Date().toISOString().slice(0, 10),
    content: text,
    generatedAt: new Date().toISOString()
  };

  // 尝试解析结构化输出
  const summaryMatch = text.match(/<MORNING_SUMMARY>([\s\S]*?)<\/MORNING_SUMMARY>/);
  const sentimentMatch = text.match(/<MARKET_SENTIMENT>([\s\S]*?)<\/MARKET_SENTIMENT>/);
  if (summaryMatch) brief.summary = summaryMatch[1].trim();
  if (sentimentMatch) {
    try { brief.sentiment = JSON.parse(sentimentMatch[1].trim()); } catch(e) {}
  }
  // 如果有结构化摘要，用它替换 content
  if (brief.summary) brief.content = brief.summary;

  // 保存到文件
  try {
    fs.writeFileSync(BRIEF_FILE, JSON.stringify(brief, null, 2), "utf-8");
    console.log("[早报] 已保存到 data/daily-brief.json");
  } catch(e) {
    console.warn("[早报] 保存失败:", e.message);
  }

  return brief;
}

function loadBrief() {
  try {
    if (fs.existsSync(BRIEF_FILE)) {
      return JSON.parse(fs.readFileSync(BRIEF_FILE, "utf-8"));
    }
  } catch(e) {}
  return null;
}

module.exports = { generateDailyBrief, loadBrief, callLLM, buildPrompt };
