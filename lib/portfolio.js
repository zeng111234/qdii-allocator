/**
 * 持仓追踪模块
 * 管理基金买入记录，计算盈亏、组合指标
 */

var fs = require("fs");
var path = require("path");
var tradingCal = require("./trading-calendar");

var PORTFOLIO_FILE = path.join(__dirname, "..", "data", "portfolio.json");
var NAV_CACHE_FILE = path.join(__dirname, "..", "data", "nav-cache.json");

function normalizeDate(dateStr) {
  // Convert "2026/6/3" or "2026-06-03" to "2026-06-03"
  if (!dateStr) return "";
  var parts = dateStr.replace(/\//g, "-").split("-");
  if (parts.length === 3) {
    return parts[0] + "-" + ("0" + parts[1]).slice(-2) + "-" + ("0" + parts[2]).slice(-2);
  }
  return dateStr.replace(/\//g, "-");
}

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
 * 计算结算日期（确认日）
 * QDII基金通常是T+2交易日，国内基金T+1交易日
 * 自动跳过周末和法定节假日
 * 
 * @param {string} buyDate - 买入日期 YYYY-MM-DD
 * @param {number} settleDays - 结算交易日数（默认2）
 * @returns {Object} { date: "YYYY-MM-DD", weekday: "周X", skipped: number }
 */
function calcSettleDate(buyDate, settleDays) {
  if (!settleDays) settleDays = 2;
  return tradingCal.addTradingDays(buyDate, settleDays);
}

/**
 * 从净值缓存中查找指定日期或之后最近的交易日净值
 * @param {Array} navs - 净值数组 [{date, nav, ...}]
 * @param {string} targetDate - 目标日期 YYYY-MM-DD
 * @param {number} maxDays - 最大向前查找天数（默认7）
 * @returns {Object|null} {date, nav} 或 null
 */
function findNavOnOrAfter(navs, targetDate, maxDays) {
  if (!navs || navs.length === 0) return null;
  if (!maxDays) maxDays = 7;
  
  // 先精确匹配
  for (var i = 0; i < navs.length; i++) {
    if (navs[i].date === targetDate) return navs[i];
  }
  
  // 找targetDate之后最近的（在maxDays范围内）
  var target = new Date(targetDate);
  for (var i = 0; i < navs.length; i++) {
    var navDate = new Date(navs[i].date);
    var diff = (navDate - target) / 86400000;
    if (diff > 0 && diff <= maxDays) {
      return navs[i];
    }
  }
  
  return null;
}

/**
 * 校验日期是否有效
 * @param {string} dateStr - 日期字符串 YYYY-MM-DD
 * @returns {boolean}
 */
function isValidDate(dateStr) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return false;
  var d = new Date(dateStr);
  return !isNaN(d.getTime()) && d.toISOString().substring(0, 10) === dateStr;
}

/**
 * 记录一笔买入
 * @param {string} code - 基金代码
 * @param {string} name - 基金名称
 * @param {number} amount - 买入金额（元）
 * @param {number|null} nav - 买入净值（可选，确认净值）
 * @param {string|null} buyDate - 买入日期（可选，格式 YYYY-MM-DD，不传则用当天）
 * @param {number|null} settleDays - 结算天数（可选，默认2表示T+2）
 */
function recordBuy(code, name, amount, nav, buyDate, settleDays) {
  var portfolio = loadPortfolio();
  var today = new Date().toISOString().substring(0, 10);
  var date = buyDate || today;
  var cache = loadNavCache();

  // 日期校验
  if (buyDate) {
    if (!isValidDate(date)) {
      console.warn("[持仓] 无效的日期格式: " + buyDate + "（需要 YYYY-MM-DD）");
      return null;
    }
    if (date > today) {
      console.warn("[持仓] 买入日期不能是未来: " + buyDate);
      return null;
    }
  }

  // 计算结算日期（交易日）
  var settleDate = null;
  var settleInfo = null;
  if (buyDate) {
    var sd = settleDays !== null && settleDays !== undefined ? settleDays : 2;
    settleInfo = calcSettleDate(date, sd);
    settleDate = settleInfo.date;
    // 结算日不能超过今天
    if (settleDate > today) {
      settleDate = today;
    }
  }

  // 查找已有持仓
  var holding = portfolio.holdings.find(function(h) { return h.code === code; });

  if (!holding) {
    holding = { code: code, name: name, buys: [] };
    portfolio.holdings.push(holding);
  }

  // 更新名称（可能更名）
  if (name) holding.name = name;

  // 确定买入净值（用结算日查找净值）
  if (!nav && buyDate && settleDate) {
    // 指定了买入日期，用结算日查找净值
    var navs = cache[code];
    if (navs && navs.length > 0) {
      var cachedNav = navs.find(function(n) { return n.date === settleDate; });
      if (cachedNav) {
        nav = cachedNav.nav;
        console.log("[持仓] 使用结算日 " + settleDate + " " + tradingCal.getWeekdayName(settleDate) + " 净值: " + nav);
      } else {
        // 结算日没有净值，找之后最近的交易日
        var nextNav = findNavOnOrAfter(navs, settleDate, 7);
        if (nextNav) {
          nav = nextNav.nav;
          settleDate = nextNav.date; // 更新为实际使用的日期
          console.log("[持仓] 结算日 " + settleDate + " 无净值，使用下一个交易日 " + nextNav.date + " " + tradingCal.getWeekdayName(nextNav.date) + " 净值: " + nav);
        } else {
          console.warn("[持仓] 结算日 " + settleDate + " 附近无净值数据，请手动提供净值");
        }
      }
    }
  } else if (!nav && !buyDate) {
    // 没指定日期也没传净值，用最新净值
    var navs = cache[code];
    if (navs && navs.length > 0) {
      nav = navs[navs.length - 1].nav;
    }
  }

  var shares = nav ? Math.round(amount / nav * 10000) / 10000 : null;

  holding.buys.push({
    date: date,
    settleDate: settleDate,
    amount: amount,
    nav: nav || null,
    shares: shares
  });

  // 按日期排序买入记录
  holding.buys.sort(function(a, b) { return a.date < b.date ? -1 : (a.date > b.date ? 1 : 0); });

  if (!portfolio.startDate || date < portfolio.startDate) {
    portfolio.startDate = date;
  }

  savePortfolio(portfolio);

  // 构建日志信息
  var logMsg = "[持仓] 已记录: " + (name || code) + " " + date + " " + tradingCal.getWeekdayName(date) + " 买入 " + amount + "元";
  if (settleInfo && settleDate) {
    logMsg += " (结算日: " + settleDate + " " + tradingCal.getWeekdayName(settleDate);
    if (settleInfo.skipped > 0) {
      logMsg += ", 跳过" + settleInfo.skipped + "个非交易日";
    }
    logMsg += ")";
  }
  if (nav) {
    logMsg += " (净值" + nav + ", 份额" + shares + ")";
  }
  console.log(logMsg);
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
    pnlRate: pnlRate,
    buyDetails: holding.buys
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
    // 显示买入明细
    for (var j = 0; j < h.buyCount; j++) {
      var b = h.buyDetails[j];
      var detailStr = "     " + (j+1) + ". " + b.date + " 买入" + b.amount + "元";
      if (b.settleDate && b.settleDate !== b.date) {
        detailStr += " (结算日: " + b.settleDate + ")";
      }
      if (b.nav) detailStr += " 净值" + b.nav + " " + b.shares + "份";
      lines.push(detailStr);
    }
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
 *   基金代码 买入金额 [确认净值] [日期]
 *   买入 基金名称 10元 确认净值8.5243 [日期]
 *   广发纳斯达克100 10
 *   2026-06-03 270042 10 8.5243  (日期在最前面)
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

    var code = null, amount = null, nav = null, name = null, date = null;

    // 格式4: "日期 代码 金额 [净值]" (如 "2026-06-03 270042 10 8.5243")
    var dateFirstMatch = line.match(/^(\d{4}[-\/]\d{1,2}[-\/]\d{1,2})\s+(\d{6})\s+(\d+\.?\d*)\s*(\d+\.?\d*)?/);
    if (dateFirstMatch) {
      date = normalizeDate(dateFirstMatch[1]);
      code = dateFirstMatch[2];
      amount = parseFloat(dateFirstMatch[3]);
      nav = dateFirstMatch[4] ? parseFloat(dateFirstMatch[4]) : null;
    }

    // 格式1: "代码 金额 [净值] [日期]" (如 "270042 10 8.5243 2026-06-03")
    if (!code) {
      var simpleMatch = line.match(/^(\d{6})\s+(\d+\.?\d*)\s*(\d+\.?\d*)?\s*(\d{4}[-\/]\d{1,2}[-\/]\d{1,2})?/);
      if (simpleMatch) {
        code = simpleMatch[1];
        amount = parseFloat(simpleMatch[2]);
        nav = simpleMatch[3] ? parseFloat(simpleMatch[3]) : null;
        date = simpleMatch[4] ? normalizeDate(simpleMatch[4]) : null;
      }
    }

    // 格式2: "买入 基金名称 10元 确认净值8.5243 [日期]"
    if (!code) {
      var buyMatch = line.match(/买入\s+(.+?)\s+(\d+\.?\d*)\s*元/);
      if (buyMatch) {
        name = buyMatch[1].trim();
        amount = parseFloat(buyMatch[2]);
        var navMatch = line.match(/确认净值\s*(\d+\.?\d*)/);
        nav = navMatch ? parseFloat(navMatch[1]) : null;
        var dateMatch = line.match(/(\d{4}[-\/]\d{1,2}[-\/]\d{1,2})\s*$/);
        date = dateMatch ? normalizeDate(dateMatch[1]) : null;
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
    var settleDays = fundInfo ? fundInfo.settleDays : 2;

    recordBuy(code, name, amount, nav, date, settleDays);
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
  lines.push("单笔买入（自动计算T+2结算日）:");
  lines.push("  node index.js --buy <代码> <金额> [净值] [日期]");
  lines.push("");
  lines.push("批量买入（逗号分隔，自动结算）:");
  lines.push("  node index.js --quick-add \"270042 10, 040046 20, 161130 15\"");
  lines.push("");
  lines.push("从文件导入（每行: 代码 金额 [净值] [日期]，自动结算）:");
  lines.push("  node index.js --import-file data/buys.txt");
  lines.push("");
  lines.push("注意: QDII基金T+2交易日结算（自动跳过周末和节假日），系统会自动用结算日净值计算份额");
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
  calcSettleDate: calcSettleDate,
  findNavOnOrAfter: findNavOnOrAfter,
  calcHoldingDetail: calcHoldingDetail,
  calcPortfolioSummary: calcPortfolioSummary,
  formatPortfolioReport: formatPortfolioReport,
  importFromText: importFromText,
  validateHoldings: validateHoldings,
  showTodayBuyCommands: showTodayBuyCommands
};
