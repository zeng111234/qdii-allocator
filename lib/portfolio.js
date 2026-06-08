/**
 * 持仓追踪模块
 * 管理基金买入记录，计算盈亏、组合指标
 */

var fs = require("fs");
var path = require("path");

var PORTFOLIO_FILE = path.join(__dirname, "..", "data", "portfolio.json");
var NAV_CACHE_FILE = path.join(__dirname, "..", "data", "nav-cache.json");

// ========== 数据加载 ==========

function loadPortfolio() {
  try {
    if (fs.existsSync(PORTFOLIO_FILE)) {
      return JSON.parse(fs.readFileSync(PORTFOLIO_FILE, "utf-8"));
    }
  } catch(e) { console.warn("[持仓] 加载失败:", e.message); }
  return { holdings: [], startDate: null };
}

function savePortfolio(portfolio) {
  try {
    fs.writeFileSync(PORTFOLIO_FILE, JSON.stringify(portfolio, null, 2), "utf-8");
  } catch(e) { console.error("[持仓] 保存失败:", e.message); }
}

function loadNavCache() {
  try {
    if (fs.existsSync(NAV_CACHE_FILE)) {
      return JSON.parse(fs.readFileSync(NAV_CACHE_FILE, "utf-8"));
    }
  } catch(e) {}
  return {};
}

// ========== 买入记录 ==========

/**
 * 记录一笔买入
 * @param {string} code - 基金代码
 * @param {string} name - 基金名称
 * @param {number} amount - 买入金额（元）
 * @param {number|null} nav - 买入净值（可选，不填则用最新净值）
 */
function recordBuy(code, name, amount, nav) {
  var portfolio = loadPortfolio();
  var today = new Date().toISOString().substring(0, 10);

  // 查找已有持仓
  var holding = portfolio.holdings.find(function(h) { return h.code === code; });

  if (!holding) {
    holding = { code: code, name: name, buys: [] };
    portfolio.holdings.push(holding);
  }

  // 更新名称（可能更名）
  if (name) holding.name = name;

  // 如果没传净值，尝试从缓存获取
  if (!nav) {
    var cache = loadNavCache();
    var navs = cache[code];
    if (navs && navs.length > 0) {
      nav = navs[navs.length - 1].nav;
    }
  }

  var shares = nav ? Math.round(amount / nav * 10000) / 10000 : null;

  holding.buys.push({
    date: today,
    amount: amount,
    nav: nav || null,
    shares: shares
  });

  if (!portfolio.startDate) portfolio.startDate = today;

  savePortfolio(portfolio);
  console.log("[持仓] 已记录: " + (name || code) + " 买入 " + amount + "元" + (nav ? " (净值" + nav + ", 份额" + shares + ")" : ""));
  return holding;
}

// ========== 盈亏计算 ==========

/**
 * 计算单只基金的持仓详情
 */
function calcHoldingDetail(holding, navCache) {
  var totalAmount = 0;
  var totalShares = 0;

  for (var i = 0; i < holding.buys.length; i++) {
    var buy = holding.buys[i];
    totalAmount += buy.amount;
    if (buy.shares) totalShares += buy.shares;
    else if (buy.nav) totalShares += buy.amount / buy.nav;
  }

  // 获取最新净值
  var navs = navCache[holding.code];
  var latestNav = null;
  var latestDate = null;
  if (navs && navs.length > 0) {
    var last = navs[navs.length - 1];
    latestNav = last.nav;
    latestDate = last.date;
  }

  // 计算当前市值
  var currentValue = totalShares > 0 && latestNav ? Math.round(totalShares * latestNav * 100) / 100 : null;
  var pnl = currentValue !== null ? Math.round((currentValue - totalAmount) * 100) / 100 : null;
  var pnlRate = currentValue !== null && totalAmount > 0 ? Math.round((currentValue - totalAmount) / totalAmount * 10000) / 100 : null;

  // 计算平均成本
  var avgCost = totalShares > 0 ? Math.round(totalAmount / totalShares * 10000) / 10000 : null;

  return {
    code: holding.code,
    name: holding.name,
    buyCount: holding.buys.length,
    totalAmount: totalAmount,
    totalShares: Math.round(totalShares * 10000) / 10000,
    avgCost: avgCost,
    latestNav: latestNav,
    latestDate: latestDate,
    currentValue: currentValue,
    pnl: pnl,
    pnlRate: pnlRate
  };
}

/**
 * 计算整个组合的汇总指标
 */
function calcPortfolioSummary() {
  var portfolio = loadPortfolio();
  var navCache = loadNavCache();

  if (!portfolio.holdings || portfolio.holdings.length === 0) {
    return { empty: true, holdings: [], summary: null };
  }

  var details = [];
  var totalInvested = 0;
  var totalValue = 0;
  var hasValue = false;

  for (var i = 0; i < portfolio.holdings.length; i++) {
    var detail = calcHoldingDetail(portfolio.holdings[i], navCache);
    details.push(detail);
    totalInvested += detail.totalAmount;
    if (detail.currentValue !== null) {
      totalValue += detail.currentValue;
      hasValue = true;
    }
  }

  var summary = null;
  if (hasValue) {
    var totalPnl = Math.round((totalValue - totalInvested) * 100) / 100;
    var totalPnlRate = totalInvested > 0 ? Math.round(totalPnl / totalInvested * 10000) / 100 : 0;

    // 计算收益率（简单版：用首次买入日期到现在）
    var startDate = portfolio.startDate;
    var daysSinceStart = 0;
    if (startDate) {
      daysSinceStart = Math.floor((Date.now() - new Date(startDate).getTime()) / 86400000);
    }

    summary = {
      totalInvested: totalInvested,
      totalValue: Math.round(totalValue * 100) / 100,
      totalPnl: totalPnl,
      totalPnlRate: totalPnlRate,
      holdingCount: details.length,
      daysSinceStart: daysSinceStart,
      startDate: startDate
    };
  }

  return { empty: false, holdings: details, summary: summary };
}

/**
 * 格式化持仓报告（文本）
 */
function formatPortfolioReport(calcResult) {
  if (calcResult.empty) {
    return "[持仓] 暂无持仓记录。使用 node index.js --buy <代码> <金额> 记录买入。";
  }

  var lines = [];
  lines.push("=== 我的持仓 ===");
  lines.push("");

  var holdings = calcResult.holdings;
  for (var i = 0; i < holdings.length; i++) {
    var h = holdings[i];
    var pnlStr = h.pnl !== null ? (h.pnl >= 0 ? "+" : "") + h.pnl + "元 (" + (h.pnlRate >= 0 ? "+" : "") + h.pnlRate + "%)" : "待更新";
    lines.push((i + 1) + ". " + h.name + "(" + h.code + ")");
    lines.push("   投入: " + h.totalAmount + "元 | 市值: " + (h.currentValue !== null ? h.currentValue + "元" : "待更新") + " | 盈亏: " + pnlStr);
    lines.push("   持有: " + h.totalShares + "份 | 均价: " + (h.avgCost || "-") + " | 最新净值: " + (h.latestNav || "-") + " (" + (h.latestDate || "-") + ")");
    lines.push("   买入" + h.buyCount + "次");
    lines.push("");
  }

  if (calcResult.summary) {
    var s = calcResult.summary;
    var totalPnlStr = (s.totalPnl >= 0 ? "+" : "") + s.totalPnl + "元 (" + (s.totalPnlRate >= 0 ? "+" : "") + s.totalPnlRate + "%)";
    lines.push("--- 组合汇总 ---");
    lines.push("总投入: " + s.totalInvested + "元 | 总市值: " + s.totalValue + "元");
    lines.push("总盈亏: " + totalPnlStr);
    lines.push("持有" + s.holdingCount + "只基金 | 已投" + s.daysSinceStart + "天 (自" + (s.startDate || "-") + ")");
  }

  return lines.join("\n");
}

// ========== 导出 ==========

module.exports = {
  loadPortfolio: loadPortfolio,
  savePortfolio: savePortfolio,
  recordBuy: recordBuy,
  calcHoldingDetail: calcHoldingDetail,
  calcPortfolioSummary: calcPortfolioSummary,
  formatPortfolioReport: formatPortfolioReport
};
