/**
 * AI 基金深度分析模块
 * 对每只持仓基金单独调用 LLM，生成深度分析报告
 */

const fs = require("fs");
const path = require("path");
const { callLLM } = require("./llm-client"); // [修复] 原问题：通过daily-brief间接引用，统一使用llm-client

const REPORTS_FILE = path.join(__dirname, "..", "data", "fund-reports.json");
function loadPortfolio() {
  return require("./portfolio").loadPortfolio();
}

function loadReports() {
  try {
    if (fs.existsSync(REPORTS_FILE)) {
      return JSON.parse(fs.readFileSync(REPORTS_FILE, "utf-8"));
    }
  } catch(e) {}
  return {};
}

function saveReports(reports) {
  try {
    fs.writeFileSync(REPORTS_FILE, JSON.stringify(reports, null, 2), "utf-8");
  } catch(e) {
    console.error("[深度分析] 保存失败:", e.message);
  }
}

function buildPrompt(fund) {
  const lines = [];
  lines.push("请对以下基金进行深度分析：");
  lines.push("");
  lines.push("基金名称: " + fund.name);
  lines.push("基金代码: " + fund.code);
  lines.push("基金类型: " + (fund.type || "未知"));
  lines.push("");

  // 买入记录
  if (fund.buys && fund.buys.length > 0) {
    lines.push("=== 买入记录 ===");
    let totalAmount = 0;
    for (let i = 0; i < fund.buys.length; i++) {
      const b = fund.buys[i];
      totalAmount += b.amount || 0;
      lines.push("- " + b.date + " 买入" + b.amount + "元 净值:" + (b.nav || "待更新"));
    }
    lines.push("总投入: " + totalAmount + "元");
    lines.push("");
  }

  lines.push("请从以下角度分析：");
  lines.push("1. 投资逻辑（为什么值得持有）");
  lines.push("2. 产业链分析（重仓哪些行业/公司）");
  lines.push("3. 风险因素（可能的风险点）");
  lines.push("4. 操作建议（继续持有/加仓/减仓/卖出）");
  lines.push("");
  lines.push("用口语化中文回答，控制在200字以内。");

  return lines.join("\n");
}

async function analyzeFund(fund, config) {
  const prompt = buildPrompt(fund);
  const text = await callLLM(prompt, config);
  return {
    code: fund.code,
    name: fund.name,
    analysis: text,
    analyzedAt: new Date().toISOString()
  };
}

async function analyzeAllHoldings(config, maxFunds) {
  console.log("[深度分析] 开始分析持仓基金...");

  const portfolio = loadPortfolio();
  if (!portfolio.holdings || portfolio.holdings.length === 0) {
    console.log("[深度分析] 暂无持仓");
    return {};
  }

  const reports = loadReports();
  const today = new Date().toISOString().slice(0, 10);
  let analyzed = 0;
  const limit = maxFunds || 5; // 每次最多分析5只，避免消耗过多token

  for (let i = 0; i < Math.min(portfolio.holdings.length, limit); i++) {
    const fund = portfolio.holdings[i];

    // 检查是否今天已经分析过
    if (reports[fund.code] && reports[fund.code].analyzedAt && reports[fund.code].analyzedAt.slice(0, 10) === today) {
      console.log("[深度分析] 跳过 " + fund.name + "（今天已分析）");
      continue;
    }

    try {
      console.log("[深度分析] 分析 " + fund.name + "...");
      const report = await analyzeFund(fund, config);
      reports[fund.code] = report;
      analyzed++;

      // 保存进度
      saveReports(reports);

      // 延迟避免API限流
      await new Promise(function(r) { setTimeout(r, 1000); });
    } catch(e) {
      console.warn("[深度分析] " + fund.name + " 失败:", e.message);
    }
  }

  console.log("[深度分析] 完成，分析了 " + analyzed + " 只基金");
  return reports;
}

function formatReportsForDisplay(reports) {
  const lines = [];
  lines.push("=== 基金深度分析报告 ===");
  lines.push("");

  const codes = Object.keys(reports);
  for (let i = 0; i < codes.length; i++) {
    const r = reports[codes[i]];
    lines.push("【" + r.name + "】(" + r.code + ")");
    lines.push(r.analysis);
    lines.push("分析时间: " + r.analyzedAt);
    lines.push("");
  }

  return lines.join("\n");
}

module.exports = { analyzeFund, analyzeAllHoldings, loadReports, saveReports, formatReportsForDisplay };
