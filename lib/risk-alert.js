/**
 * AI 风险预警模块
 * 当市场出现异常波动时，调用 LLM 分析风险
 */

const fs = require("fs");
const path = require("path");
const { callLLM } = require("./daily-brief");

const ALERTS_FILE = path.join(__dirname, "..", "data", "risk-alerts.json");

function loadAlerts() {
  try {
    if (fs.existsSync(ALERTS_FILE)) {
      return JSON.parse(fs.readFileSync(ALERTS_FILE, "utf-8"));
    }
  } catch(e) {}
  return { alerts: [] };
}

function saveAlerts(alerts) {
  try {
    fs.writeFileSync(ALERTS_FILE, JSON.stringify(alerts, null, 2), "utf-8");
  } catch(e) {
    console.error("[预警] 保存失败:", e.message);
  }
}

function buildPrompt(alertType, marketData) {
  const lines = [];
  lines.push("市场出现异常波动，请分析风险并给出建议。");
  lines.push("");
  lines.push("=== 预警类型 ===");
  lines.push(alertType);
  lines.push("");

  if (marketData) {
    lines.push("=== 市场数据 ===");
    lines.push(marketData);
    lines.push("");
  }

  lines.push("请分析：");
  lines.push("1. 风险等级（低/中/高/极高）");
  lines.push("2. 影响范围（哪些基金可能受影响）");
  lines.push("3. 应对建议（继续持有/减仓/观望）");
  lines.push("");
  lines.push("用口语化中文回答，控制在150字以内。");

  return lines.join("\n");
}

async function checkAndAlert(marketSnapshot, config) {
  if (!marketSnapshot || marketSnapshot.length === 0) {
    return null;
  }

  // 检查是否有异常波动
  const alerts = [];

  for (let i = 0; i < marketSnapshot.length; i++) {
    const m = marketSnapshot[i];

    // 单日跌幅>3%
    if (m.change && m.change < -3) {
      alerts.push({ type: "大跌预警", market: m.name, change: m.change });
    }

    // 单日涨幅>3%
    if (m.change && m.change > 3) {
      alerts.push({ type: "大涨预警", market: m.name, change: m.change });
    }
  }

  if (alerts.length === 0) {
    return null;
  }

  console.log("[预警] 检测到 " + alerts.length + " 个异常波动");

  // 构建市场数据
  const marketData = marketSnapshot.map(function(m) {
    return m.name + ": " + (m.change >= 0 ? "+" : "") + m.change + "%";
  }).join("\n");

  const alertType = alerts.map(function(a) {
    return a.type + " (" + a.market + " " + a.change + "%)";
  }).join(", ");

  // 调用 LLM 分析
  const prompt = buildPrompt(alertType, marketData);
  const analysis = await callLLM(prompt, config);

  const alertEntry = {
    id: Date.now().toString(36),
    date: new Date().toISOString().slice(0, 10),
    time: new Date().toISOString().slice(11, 19),
    alerts: alerts,
    analysis: analysis,
    createdAt: new Date().toISOString()
  };

  // 保存预警
  const allAlerts = loadAlerts();
  allAlerts.alerts.push(alertEntry);
  saveAlerts(allAlerts);

  console.log("[预警] 已生成风险分析");
  return alertEntry;
}

function getRecentAlerts(count) {
  const allAlerts = loadAlerts();
  return (allAlerts.alerts || []).slice(-(count || 5));
}

function formatAlertForDisplay(alert) {
  const lines = [];
  lines.push("⚠️ 风险预警 " + alert.date + " " + alert.time);
  lines.push("");
  lines.push("预警类型: " + alert.alerts.map(function(a) { return a.type; }).join(", "));
  lines.push("");
  lines.push(alert.analysis);
  return lines.join("\n");
}

module.exports = { checkAndAlert, loadAlerts, getRecentAlerts, formatAlertForDisplay };
