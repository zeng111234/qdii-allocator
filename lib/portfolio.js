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

// ========== 批量导入 ==========

/**
 * 从文本解析并导入交易记录
 * 支持格式:
 *   基金代码 买入金额 [确认净值]
 *   买入 基金名称 10元 确认净值8.5243
 *   广发纳斯达克100 10
 * @param {string} text - 交易记录文本
 * @param {Array} fundsList - 基金池列表（用于匹配名称）
 * @returns {Object} { total, imported, errors }
 */
function importFromText(text, fundsList) {
  var lines = text.split("\n").map(function(s) { return s.trim(); }).filter(Boolean);
  var total = lines.length;
  var imported = 0;
  var errors = [];

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    // 跳过注释行
    if (line.startsWith("#") || line.startsWith("//")) continue;

    var code = null, amount = null, nav = null, name = null;

    // 格式1: "代码 金额 [净值]" (如 "270042 10 8.5243")
    var simpleMatch = line.match(/^(\d{6})\s+(\d+\.?\d*)\s*(\d+\.?\d*)?/);
    if (simpleMatch) {
      code = simpleMatch[1];
      amount = parseFloat(simpleMatch[2]);
      nav = simpleMatch[3] ? parseFloat(simpleMatch[3]) : null;
    }

    // 格式2: "买入 基金名称 10元 确认净值8.5243"
    if (!code) {
      var buyMatch = line.match(/买入\s+(.+?)\s+(\d+\.?\d*)\s*元/);
      if (buyMatch) {
        name = buyMatch[1].trim();
        amount = parseFloat(buyMatch[2]);
        var navMatch = line.match(/确认净值\s*(\d+\.?\d*)/);
        nav = navMatch ? parseFloat(navMatch[1]) : null;
        // 通过名称匹配基金代码
        var matchedFund = fundsList.find(function(f) {
          return f.name.indexOf(name) >= 0 || name.indexOf(f.name) >= 0;
        });
        if (matchedFund) {
          code = matchedFund.code;
          name = matchedFund.name;
        }
      }
    }

    // 格式3: "基金名称 金额" (如 "广发纳斯达克100 10")
    if (!code) {
      var nameMatch = line.match(/^(.+?)\s+(\d+\.?\d*)$/);
      if (nameMatch) {
        var searchName = nameMatch[1].trim();
        amount = parseFloat(nameMatch[2]);
        var matchedFund2 = fundsList.find(function(f) {
          return f.name.indexOf(searchName) >= 0 || searchName.indexOf(f.name) >= 0;
        });
        if (matchedFund2) {
          code = matchedFund2.code;
          name = matchedFund2.name;
        }
      }
    }

    if (!code && !name) {
      errors.push("第" + (i + 1) + "行无法解析: " + line);
      continue;
    }
    if (!amount || amount <= 0) {
      errors.push("第" + (i + 1) + "行金额无效: " + line);
      continue;
    }

    // 如果没有代码，用名称查找
    if (!code && name) {
      var fundByName = fundsList.find(function(f) {
        return f.name.indexOf(name) >= 0 || name.indexOf(f.name) >= 0;
      });
      if (fundByName) {
        code = fundByName.code;
        name = fundByName.name;
      } else {
        errors.push("第" + (i + 1) + "行找不到基金: " + name);
        continue;
      }
    }

    var fundInfo = fundsList.find(function(f) { return f.code === code; });
    if (!name && fundInfo) name = fundInfo.name;
    if (!name) name = code;

    recordBuy(code, name, amount, nav);
    imported++;
  }

  return { total: total, imported: imported, errors: errors };
}

/**
 * 校验持仓中的净值和份额是否与缓存数据匹配
 * @param {Array} holdings - 持仓列表
 * @param {Object} navCache - 净值缓存
 * @returns {Array} 校验结果列表
 */
function validateHoldings(holdings, navCache) {
  var results = [];
  for (var i = 0; i < holdings.length; i++) {
    var h = holdings[i];
    var navs = navCache[h.code];
    if (!navs || navs.length === 0) {
      results.push({ code: h.code, name: h.name, status: "no_cache", message: "无净值缓存数据" });
      continue;
    }
    for (var j = 0; j < h.buys.length; j++) {
      var buy = h.buys[j];
      if (!buy.nav || !buy.date) continue;
      var cachedNav = navs.find(function(n) { return n.date === buy.date; });
      if (cachedNav) {
        var diff = Math.abs(buy.nav - cachedNav.nav);
        if (diff > 0.01) {
          results.push({
            code: h.code, name: h.name, date: buy.date,
            status: "mismatch",
            inputNav: buy.nav,
            cachedNav: cachedNav.nav,
            message: buy.date + " 净值不匹配: 输入" + buy.nav + " vs 缓存" + cachedNav.nav
          });
        } else {
          results.push({ code: h.code, name: h.name, date: buy.date, status: "ok" });
        }
      } else {
        results.push({ code: h.code, name: h.name, date: buy.date, status: "no_date", message: buy.date + " 无缓存数据" });
      }
    }
  }
  return results;
}

// ========== 今日买入指令 ==========

/**
 * 显示今日推荐基金和对应的快捷买入指令
 */
function showTodayBuyCommands(fundsList, portfolioResult) {
  var lines = [];
  lines.push("=== 今日买入指南 ===");
  lines.push("");

  // 显示基金池中的活跃基金
  var activeFunds = fundsList.filter(function(f) { return f.status === "active"; });

  // 按类型分组
  var groups = {};
  for (var i = 0; i < activeFunds.length; i++) {
    var f = activeFunds[i];
    var type = f.type || "其他";
    if (!groups[type]) groups[type] = [];
    groups[type].push(f);
  }

  var types = Object.keys(groups);
  for (var t = 0; t < types.length; t++) {
    lines.push("【" + types[t] + "】");
    var group = groups[types[t]];
    for (var g = 0; g < group.length; g++) {
      var fund = group[g];
      var limitStr = fund.dailyLimit ? " (限购" + fund.dailyLimit + "元)" : "";
      lines.push("  " + fund.code + " " + fund.name + limitStr);
    }
    lines.push("");
  }

  lines.push("--- 快捷买入指令 ---");
  lines.push("");
  lines.push("单笔买入:");
  lines.push("  node index.js --buy <代码> <金额>");
  lines.push("");
  lines.push("批量买入（逗号分隔）:");
  lines.push("  node index.js --quick-add \"270042 10, 040046 20, 161130 15\"");
  lines.push("");
  lines.push("从文件导入（每行: 代码 金额 [净值]）:");
  lines.push("  node index.js --import-file data/buys.txt");
  lines.push("");

  // 如果有持仓，显示当前持仓
  if (portfolioResult && !portfolioResult.empty) {
    lines.push("--- 当前持仓 ---");
    for (var p = 0; p < portfolioResult.holdings.length; p++) {
      var h = portfolioResult.holdings[p];
      var pnlStr = h.pnl !== null ? (h.pnl >= 0 ? "+" : "") + h.pnlRate + "%" : "待更新";
      lines.push("  " + h.name + ": " + h.totalAmount + "元 (" + pnlStr + ")");
    }
  }

  console.log(lines.join("\n"));
}

// ========== 导出 ==========

module.exports = {
  loadPortfolio: loadPortfolio,
  savePortfolio: savePortfolio,
  recordBuy: recordBuy,
  calcHoldingDetail: calcHoldingDetail,
  calcPortfolioSummary: calcPortfolioSummary,
  formatPortfolioReport: formatPortfolioReport,
  importFromText: importFromText,
  validateHoldings: validateHoldings,
  showTodayBuyCommands: showTodayBuyCommands
};
