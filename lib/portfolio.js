/**
 * 持仓追踪模块
 * 管理基金买入记录，计算盈亏、组合指标
 */

const fs = require("fs");
const path = require("path");
const tradingCal = require("./trading-calendar");
const { normalizeDate, loadNavCache } = require("./utils");
const investmentDiary = require("./investment-diary");

const PORTFOLIO_FILE = path.join(__dirname, "..", "data", "portfolio.json");

// ========== 数据加载 ==========

// [修复] 原问题：loadPortfolio()/savePortfolio() 重复磁盘读写，批量导入100笔时读写100次
let _portfolioInstance = null;
let _portfolioMtime = 0;

function loadPortfolio() {
  try {
    if (!fs.existsSync(PORTFOLIO_FILE)) return { holdings: [], startDate: null };
    const stat = fs.statSync(PORTFOLIO_FILE);
    if (_portfolioInstance && stat.mtimeMs === _portfolioMtime) {
      return _portfolioInstance;
    }
    _portfolioInstance = JSON.parse(fs.readFileSync(PORTFOLIO_FILE, "utf-8"));
    _portfolioMtime = stat.mtimeMs;
    return _portfolioInstance;
  } catch(e) { console.warn("[持仓] 加载失败:", e.message); }
  return { holdings: [], startDate: null };
}

function savePortfolio(portfolio) {
  try {
    fs.writeFileSync(PORTFOLIO_FILE, JSON.stringify(portfolio, null, 2), "utf-8");
    _portfolioInstance = portfolio;
    _portfolioMtime = fs.statSync(PORTFOLIO_FILE).mtimeMs;
  } catch(e) { console.error("[持仓] 保存失败:", e.message); }
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
  for (let i = 0; i < navs.length; i++) {
    if (navs[i].date === targetDate) return navs[i];
  }

  // 找targetDate之后最近的（在maxDays范围内）
  const target = new Date(targetDate);
  for (let i = 0; i < navs.length; i++) {
    const navDate = new Date(navs[i].date);
    const diff = (navDate - target) / 86400000;
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
  const d = new Date(dateStr);
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
  const portfolio = loadPortfolio();
  const today = new Date().toISOString().substring(0, 10);
  const date = buyDate || today;
  const cache = loadNavCache();

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
  let settleDate = null;
  let settleInfo = null;
  if (buyDate) {
    const sd = settleDays !== null && settleDays !== undefined ? settleDays : 2;
    settleInfo = calcSettleDate(date, sd);
    settleDate = settleInfo.date;
    // 结算日可以超过今天，表示待结算
  }

  // 查找已有持仓
  let holding = portfolio.holdings.find(function(h) { return h.code === code; });

  if (!holding) {
    holding = { code: code, name: name, buys: [] };
    portfolio.holdings.push(holding);
  }

  // 更新名称（可能更名）
  if (name) holding.name = name;

  // 确定买入净值（用结算日查找净值）
  if (!nav && buyDate && settleDate) {
    // 指定了买入日期，用结算日查找净值
    const navs = cache[code];
    if (navs && navs.length > 0) {
      const cachedNav = navs.find(function(n) { return n.date === settleDate; });
      if (cachedNav) {
        nav = cachedNav.nav;
        console.log("[持仓] 使用结算日 " + settleDate + " " + tradingCal.getWeekdayName(settleDate) + " 净值: " + nav);
      } else {
        // 结算日没有净值，找之后最近的交易日
        const nextNav = findNavOnOrAfter(navs, settleDate, 7);
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
    const navs = cache[code];
    if (navs && navs.length > 0) {
      nav = navs[navs.length - 1].nav;
    }
  }

  // 去重检查：同一天同基金同金额同净值 → 累加而非新增
  let existingBuy = null;
  for (let bi = 0; bi < holding.buys.length; bi++) {
    const b = holding.buys[bi];
    if (b.date === date && b.amount === amount) {
      // 净值匹配（都为null或数值相同）
      const navMatch = (!b.nav && !nav) || (b.nav && nav && Math.abs(b.nav - nav) < 0.001);
      if (navMatch) {
        existingBuy = b;
        break;
      }
    }
  }

  if (existingBuy) {
    // 同日同金额同净值 → 累加金额，重新计算份额
    existingBuy.amount += amount;
    if (nav) {
      existingBuy.nav = nav;
      existingBuy.shares = Math.round(existingBuy.amount / nav * 10000) / 10000;
    }
    console.log("[持仓] 检测到重复买入，已累加: " + (name || code) + " " + date + " 累计" + existingBuy.amount + "元");
  } else {
    const shares = nav ? Math.round(amount / nav * 10000) / 10000 : null;
    holding.buys.push({
      date: date,
      settleDate: settleDate,
      amount: amount,
      nav: nav || null,
      shares: shares
    });
  }

  // 按日期排序买入记录
  holding.buys.sort(function(a, b) { return a.date < b.date ? -1 : (a.date > b.date ? 1 : 0); });

  if (!portfolio.startDate || date < portfolio.startDate) {
    portfolio.startDate = date;
  }

  savePortfolio(portfolio);

  // 记录投资日记（异步，不阻塞主流程）
  try {
    const buyInfo = { code: code, name: name || code, amount: amount, nav: nav, date: date };
    // 从环境变量读取 LLM 配置
    const llmApiKey = process.env.LLM_API_KEY;
    const llmBaseUrl = process.env.LLM_BASE_URL;
    const llmModel = process.env.LLM_MODEL;
    if (llmApiKey && llmBaseUrl && llmModel) {
      const llmConfig = { apiKey: llmApiKey, baseUrl: llmBaseUrl, model: llmModel };
      investmentDiary.recordBuyDiary(buyInfo, llmConfig).catch(function(err) {
        console.warn("[日记] 记录失败:", err.message);
      });
    }
  } catch (err) { /* ignore */ }

  // 构建日志信息
  let logMsg = "[持仓] 已记录: " + (name || code) + " " + date + " " + tradingCal.getWeekdayName(date) + " 买入 " + amount + "元";
  if (settleInfo && settleDate) {
    logMsg += " (结算日: " + settleDate + " " + tradingCal.getWeekdayName(settleDate);
    if (settleInfo.skipped > 0) {
      logMsg += ", 跳过" + settleInfo.skipped + "个非交易日";
    }
    logMsg += ")";
  }
  if (nav) {
    const lastBuy = holding.buys[holding.buys.length - 1];
    logMsg += " (净值" + nav + ", 份额" + (lastBuy.shares || "-") + ")";
  }
  console.log(logMsg);
  return holding;
}

// ========== 盈亏计算 ==========

/**
 * 计算单只基金的持仓详情
 */
function calcHoldingDetail(holding, navCache) {
  let totalAmount = 0;
  let totalShares = 0;
  let pendingAmount = 0;  // 待结算金额

  for (let i = 0; i < holding.buys.length; i++) {
    const buy = holding.buys[i];
    if (buy.shares !== null && buy.shares !== undefined && buy.shares > 0) {
      totalAmount += buy.amount;
      totalShares += buy.shares;
    } else if (buy.nav) {
      totalAmount += buy.amount;
      totalShares += buy.amount / buy.nav;
    } else {
      // 没有shares也没有nav的买入（未结算）也计入总投入
      totalAmount += buy.amount;
      pendingAmount += buy.amount;
    }
  }

  // 获取最新净值
  const navs = navCache[holding.code];
  let latestNav = null;
  let latestDate = null;
  if (navs && navs.length > 0) {
    const last = navs[navs.length - 1];
    latestNav = last.nav;
    latestDate = last.date;
  }

  // 计算当前市值（待结算的按投入金额计入）
  const settledValue = totalShares > 0 && latestNav ? Math.round(totalShares * latestNav * 100) / 100 : 0;
  const currentValue = Math.round((settledValue + pendingAmount) * 100) / 100;
  const pnl = currentValue > 0 ? Math.round((currentValue - totalAmount) * 100) / 100 : null;
  const pnlRate = currentValue > 0 && totalAmount > 0 ? Math.round((currentValue - totalAmount) / totalAmount * 10000) / 100 : null;

  // 计算平均成本
  const avgCost = totalShares > 0 ? Math.round(totalAmount / totalShares * 10000) / 10000 : null;

  // 已实现盈亏（从卖出记录）
  let totalRealizedPnl = 0;
  let totalSoldAmount = 0;
  if (holding.sells && holding.sells.length > 0) {
    for (let s = 0; s < holding.sells.length; s++) {
      totalRealizedPnl += holding.sells[s].realizedPnl || 0;
      totalSoldAmount += holding.sells[s].amount || 0;
    }
  }
  totalRealizedPnl = Math.round(totalRealizedPnl * 100) / 100;

  return {
    code: holding.code,
    name: holding.name,
    buyCount: holding.buys.length,
    sellCount: (holding.sells && holding.sells.length) || 0,
    totalAmount: totalAmount,
    totalShares: Math.round(totalShares * 10000) / 10000,
    avgCost: avgCost,
    latestNav: latestNav,
    latestDate: latestDate,
    currentValue: currentValue,
    pnl: pnl,
    pnlRate: pnlRate,
    realizedPnl: totalRealizedPnl,
    totalSoldAmount: totalSoldAmount,
    buyDetails: holding.buys.map(function(b) {
      return {
        date: b.date,
        settleDate: b.settleDate,
        amount: b.amount,
        nav: b.nav,
        shares: b.shares,
        settled: !!(b.shares && b.shares > 0)
      };
    })
  };
}

/**
 * 计算整个组合的汇总指标
 */
function calcPortfolioSummary() {
  const portfolio = loadPortfolio();
  const navCache = loadNavCache();

  if (!portfolio.holdings || portfolio.holdings.length === 0) {
    return { empty: true, holdings: [], summary: null };
  }

  const details = [];
  let totalInvested = 0;
  let totalValue = 0;
  let hasValue = false;

  let totalRealizedPnl = 0;
  for (let i = 0; i < portfolio.holdings.length; i++) {
    const detail = calcHoldingDetail(portfolio.holdings[i], navCache);
    details.push(detail);
    totalInvested += detail.totalAmount;
    totalRealizedPnl += detail.realizedPnl || 0;
    if (detail.currentValue !== null) {
      totalValue += detail.currentValue;
      hasValue = true;
    }
  }
  totalRealizedPnl = Math.round(totalRealizedPnl * 100) / 100;

  let summary = null;
  if (hasValue) {
    const totalPnl = Math.round((totalValue - totalInvested) * 100) / 100;
    const totalPnlRate = totalInvested > 0 ? Math.round(totalPnl / totalInvested * 10000) / 100 : 0;

    // 计算收益率（简单版：用首次买入日期到现在）
    const startDate = portfolio.startDate;
    let daysSinceStart = 0;
    if (startDate) {
      const startMs = new Date(startDate + "T00:00:00").getTime();
      if (!isNaN(startMs)) {
        daysSinceStart = Math.floor((Date.now() - startMs) / 86400000);
      }
    }

    summary = {
      totalInvested: totalInvested,
      totalValue: Math.round(totalValue * 100) / 100,
      totalPnl: totalPnl,
      totalPnlRate: totalPnlRate,
      totalRealizedPnl: totalRealizedPnl,
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

  const lines = [];
  lines.push("=== 我的持仓 ===");
  lines.push("");

  const holdings = calcResult.holdings;
  for (let i = 0; i < holdings.length; i++) {
    const h = holdings[i];
    const pnlStr = h.pnl !== null ? (h.pnl >= 0 ? "+" : "") + h.pnl + "元 (" + (h.pnlRate >= 0 ? "+" : "") + h.pnlRate + "%)" : "待更新";
    lines.push((i + 1) + ". " + h.name + "(" + h.code + ")");
    lines.push("   投入: " + h.totalAmount + "元 | 市值: " + (h.currentValue !== null ? h.currentValue + "元" : "待更新") + " | 盈亏: " + pnlStr);
    lines.push("   持有: " + h.totalShares + "份 | 均价: " + (h.avgCost || "-") + " | 最新净值: " + (h.latestNav || "-") + " (" + (h.latestDate || "-") + ")");
    // 显示买入明细
    for (let j = 0; j < h.buyCount; j++) {
      const b = h.buyDetails[j];
      let detailStr = "     " + (j+1) + ". " + b.date + " 买入" + b.amount + "元";
      if (b.settleDate && b.settleDate !== b.date) {
        detailStr += " (结算日: " + b.settleDate + ")";
      }
      if (b.nav) detailStr += " 净值" + b.nav + " " + b.shares + "份";
      lines.push(detailStr);
    }
    lines.push("");
  }

  if (calcResult.summary) {
    const s = calcResult.summary;
    const totalPnlStr = (s.totalPnl >= 0 ? "+" : "") + s.totalPnl + "元 (" + (s.totalPnlRate >= 0 ? "+" : "") + s.totalPnlRate + "%)";
    lines.push("--- 组合汇总 ---");
    lines.push("总投入: " + s.totalInvested + "元 | 总市值: " + s.totalValue + "元");
    lines.push("浮动盈亏: " + totalPnlStr);
    if (s.totalRealizedPnl && s.totalRealizedPnl !== 0) {
      const rPnlStr = (s.totalRealizedPnl >= 0 ? "+" : "") + s.totalRealizedPnl + "元";
      lines.push("已实现盈亏: " + rPnlStr + "（卖出已兑现）");
    }
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
  const lines = text.split("\n").map(function(s) { return s.trim(); }).filter(Boolean);
  const total = lines.length;
  let imported = 0;
  const errors = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // 跳过注释行
    if (line.startsWith("#") || line.startsWith("//")) continue;

    let code = null, amount = null, nav = null, name = null, date = null;

    // 格式4: "日期 代码 金额 [净值]" (如 "2026-06-03 270042 10 8.5243")
    const dateFirstMatch = line.match(/^(\d{4}[-/]\d{1,2}[-/]\d{1,2})\s+(\d{6})\s+(\d+\.?\d*)\s*(\d+\.?\d*)?/);
    if (dateFirstMatch) {
      date = normalizeDate(dateFirstMatch[1]);
      code = dateFirstMatch[2];
      amount = parseFloat(dateFirstMatch[3]);
      nav = dateFirstMatch[4] ? parseFloat(dateFirstMatch[4]) : null;
    }

    // 格式1: "代码 金额 [净值] [日期]" (如 "270042 10 8.5243 2026-06-03")
    if (!code) {
      const simpleMatch = line.match(/^(\d{6})\s+(\d+\.?\d*)\s*(\d+\.?\d*)?\s*(\d{4}[-/]\d{1,2}[-/]\d{1,2})?/);
      if (simpleMatch) {
        code = simpleMatch[1];
        amount = parseFloat(simpleMatch[2]);
        nav = simpleMatch[3] ? parseFloat(simpleMatch[3]) : null;
        date = simpleMatch[4] ? normalizeDate(simpleMatch[4]) : null;
      }
    }

    // 格式2: "买入 基金名称 10元 确认净值8.5243 [日期]"
    if (!code) {
      const buyMatch = line.match(/买入\s+(.+?)\s+(\d+\.?\d*)\s*元/);
      if (buyMatch) {
        name = buyMatch[1].trim();
        amount = parseFloat(buyMatch[2]);
        const navMatch = line.match(/确认净值\s*(\d+\.?\d*)/);
        nav = navMatch ? parseFloat(navMatch[1]) : null;
        const dateMatch = line.match(/(\d{4}[-/]\d{1,2}[-/]\d{1,2})\s*$/);
        date = dateMatch ? normalizeDate(dateMatch[1]) : null;
        // 通过名称匹配基金代码
        const matchedFund = fundsList.find(function(f) {
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
      const nameMatch = line.match(/^(.+?)\s+(\d+\.?\d*)$/);
      if (nameMatch) {
        const searchName = nameMatch[1].trim();
        amount = parseFloat(nameMatch[2]);
        const matchedFund2 = fundsList.find(function(f) {
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
      const fundByName = fundsList.find(function(f) {
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

    const fundInfo = fundsList.find(function(f) { return f.code === code; });
    if (!name && fundInfo) name = fundInfo.name;
    if (!name) name = code;
    const settleDays = fundInfo ? fundInfo.settleDays : 2;

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
  const results = [];
  for (let i = 0; i < holdings.length; i++) {
    const h = holdings[i];
    const navs = navCache[h.code];
    if (!navs || navs.length === 0) {
      results.push({ code: h.code, name: h.name, status: "no_cache", message: "无净值缓存数据" });
      continue;
    }
    for (let j = 0; j < h.buys.length; j++) {
      const buy = h.buys[j];
      if (!buy.nav || !buy.date) continue;
      const cachedNav = navs.find(function(n) { return n.date === buy.date; });
      if (cachedNav) {
        const diff = Math.abs(buy.nav - cachedNav.nav);
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
  const lines = [];
  lines.push("=== 今日买入指南 ===");
  lines.push("");

  // 显示基金池中的活跃基金
  const activeFunds = fundsList.filter(function(f) { return f.status === "active"; });

  // 按类型分组
  const groups = {};
  for (let i = 0; i < activeFunds.length; i++) {
    const f = activeFunds[i];
    const type = f.type || "其他";
    if (!groups[type]) groups[type] = [];
    groups[type].push(f);
  }

  const types = Object.keys(groups);
  for (let t = 0; t < types.length; t++) {
    lines.push("【" + types[t] + "】");
    const group = groups[types[t]];
    for (let g = 0; g < group.length; g++) {
      const fund = group[g];
      const limitStr = fund.dailyLimit ? " (限购" + fund.dailyLimit + "元)" : "";
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
    for (let p = 0; p < portfolioResult.holdings.length; p++) {
      const h = portfolioResult.holdings[p];
      const pnlStr = h.pnl !== null ? (h.pnl >= 0 ? "+" : "") + h.pnlRate + "%" : "待更新";
      lines.push("  " + h.name + ": " + h.totalAmount + "元 (" + pnlStr + ")");
    }
  }

  console.log(lines.join("\n"));
}

// ========== 卖出记录 ==========

/**
 * 记录一笔卖出（赎回）
 * @param {string} code - 基金代码
 * @param {string} name - 基金名称
 * @param {number} amount - 卖出金额（元）
 * @param {number|null} nav - 卖出净值（可选）
 * @param {string|null} sellDate - 卖出日期（可选，格式 YYYY-MM-DD）
 * @returns {Object|null} 卖出结果
 */
function recordSell(code, name, amount, nav, sellDate) {
  const portfolio = loadPortfolio();
  const today = new Date().toISOString().substring(0, 10);
  const date = sellDate || today;

  // 日期校验
  if (sellDate && !isValidDate(date)) {
    console.warn("[持仓] 无效的日期格式: " + sellDate);
    return null;
  }

  // 查找持仓
  const holding = portfolio.holdings.find(function(h) { return h.code === code; });
  if (!holding) {
    console.warn("[持仓] 未找到基金 " + code + " 的持仓记录");
    return null;
  }

  // 计算持有份额和总投入
  let totalShares = 0;
  let totalAmount = 0;
  for (let i = 0; i < holding.buys.length; i++) {
    const buy = holding.buys[i];
    if (buy.shares && buy.shares > 0) {
      totalShares += buy.shares;
      totalAmount += buy.amount;
    }
  }

  if (totalShares <= 0) {
    console.warn("[持仓] 基金 " + code + " 无有效份额可卖出");
    return null;
  }

  // 如果没有提供净值，从缓存获取
  if (!nav) {
    const cache = loadNavCache();
    const navs = cache[code];
    if (navs && navs.length > 0) {
      nav = navs[navs.length - 1].nav;
    }
  }

  if (!nav || nav <= 0) {
    console.warn("[持仓] 无法获取净值，请手动提供卖出净值");
    return null;
  }

  // 计算卖出份额（按金额卖出）
  const sellShares = Math.min(amount / nav, totalShares);
  const sellAmount = Math.round(sellShares * nav * 100) / 100;
  const avgCost = totalAmount / totalShares;
  const realizedPnl = Math.round((sellShares * (nav - avgCost)) * 100) / 100;
  const realizedPnlRate = Math.round((nav - avgCost) / avgCost * 10000) / 100;

  // 记录卖出
  if (!holding.sells) holding.sells = [];
  holding.sells.push({
    date: date,
    amount: sellAmount,
    nav: nav,
    shares: Math.round(sellShares * 10000) / 10000,
    realizedPnl: realizedPnl,
    realizedPnlRate: realizedPnlRate
  });

  // 按比例减少买入记录的份额（FIFO 方式）
  let remainingShares = sellShares;
  const newBuys = [];
  for (let i = 0; i < holding.buys.length; i++) {
    const buy = holding.buys[i];
    if (!buy.shares || buy.shares <= 0 || remainingShares <= 0) {
      newBuys.push(buy);
      continue;
    }
    if (buy.shares <= remainingShares) {
      remainingShares -= buy.shares;
      // 这笔买入全部卖出，不保留
    } else {
      // 部分卖出，更新份额和金额
      const keptShares = Math.round((buy.shares - remainingShares) * 10000) / 10000;
      const ratio = keptShares / buy.shares;
      buy.shares = keptShares;
      buy.amount = Math.round(buy.amount * ratio * 100) / 100;
      remainingShares = 0;
      newBuys.push(buy);
    }
  }
  holding.buys = newBuys;

  // 如果所有份额都卖出了，移除持仓
  let hasRemaining = false;
  for (let i = 0; i < holding.buys.length; i++) {
    if (holding.buys[i].shares && holding.buys[i].shares > 0) {
      hasRemaining = true;
      break;
    }
  }
  if (!hasRemaining) {
    portfolio.holdings = portfolio.holdings.filter(function(h) { return h.code !== code; });
  }

  // 更新 startDate
  const allDates = [];
  portfolio.holdings.forEach(function(h) {
    h.buys.forEach(function(b) { allDates.push(b.date); });
    if (h.sells) h.sells.forEach(function(s) { allDates.push(s.date); });
  });
  portfolio.startDate = allDates.length > 0 ? allDates.sort()[0] : null;

  savePortfolio(portfolio);

  const logMsg = "[持仓] 卖出: " + (name || code) + " " + date + " " + tradingCal.getWeekdayName(date)
    + " 卖出 " + sellAmount + "元 (净值" + nav + ", 份额" + Math.round(sellShares * 10000) / 10000 + ")"
    + " 实现盈亏 " + (realizedPnl >= 0 ? "+" : "") + realizedPnl + "元 (" + (realizedPnlRate >= 0 ? "+" : "") + realizedPnlRate + "%)";
  console.log(logMsg);

  return {
    code: code,
    name: name || code,
    date: date,
    amount: sellAmount,
    nav: nav,
    shares: Math.round(sellShares * 10000) / 10000,
    realizedPnl: realizedPnl,
    realizedPnlRate: realizedPnlRate,
    remainingHoldings: hasRemaining
  };
}

// ========== 自动结算回填 ==========
/**
 * 遍历所有待确认买入，检查结算日净值是否已更新，自动回填
 * 每日 workflow 调用，确保历史买入不会一直卡在"待确认"
 */
function autoSettlePending() {
  const portfolioData = loadPortfolio();
  // [修复] 原问题：函数内部重复 require fs/path 并直接读文件，应使用已有的 loadNavCache
  const cache = loadNavCache();
  let settled = 0;
  let skipped = 0;

  portfolioData.holdings.forEach(function(h) {
    h.buys.forEach(function(buy) {
      if (buy.shares && buy.shares > 0) return;
      if (!buy.date) return;

      const fundsFile = path.join(__dirname, "..", "data", "funds.json");
      let fundsData = { funds: [] };
      try { fundsData = JSON.parse(fs.readFileSync(fundsFile, "utf8")); } catch(e) {}
      const fundInfo = fundsData.funds.find(function(f) { return f.code === h.code; });
      const settleDays = fundInfo ? (fundInfo.settleDays || 2) : 2;
      const settleInfo = calcSettleDate(buy.date, settleDays);
      let settleDate = settleInfo ? settleInfo.date : null;

      const navs = cache[h.code];
      if (!navs || navs.length === 0) { skipped++; return; }

      let nav = null;
      if (settleDate) {
        const cachedNav = navs.find(function(n) { return n.date === settleDate; });
        if (cachedNav) {
          nav = cachedNav.nav;
        } else {
          const nextNav = findNavOnOrAfter(navs, settleDate, 7);
          if (nextNav) {
            nav = nextNav.nav;
            settleDate = nextNav.date;
          }
        }
      }

      if (nav && nav > 0) {
        buy.nav = nav;
        buy.shares = Math.round(buy.amount / nav * 10000) / 10000;
        buy.settleDate = settleDate;
        settled++;
        console.log("[结算] " + h.name + " " + buy.date + " " + buy.amount + "元 → 净值" + nav + " 份额" + buy.shares + " 结算日" + settleDate);
      } else {
        skipped++;
      }
    });
  });

  if (settled > 0) {
    savePortfolio(portfolioData);
    console.log("[结算] 回填完成: " + settled + "笔已结算, " + skipped + "笔仍待确认");
  } else {
    console.log("[结算] 无待确认记录需要回填");
  }

  return { settled: settled, skipped: skipped };
}

// ========== 导出 ==========

module.exports = {
  loadPortfolio: loadPortfolio,
  savePortfolio: savePortfolio,
  recordBuy: recordBuy,
  recordSell: recordSell,
  calcSettleDate: calcSettleDate,
  findNavOnOrAfter: findNavOnOrAfter,
  calcHoldingDetail: calcHoldingDetail,
  calcPortfolioSummary: calcPortfolioSummary,
  formatPortfolioReport: formatPortfolioReport,
  importFromText: importFromText,
  validateHoldings: validateHoldings,
  showTodayBuyCommands: showTodayBuyCommands,
  autoSettlePending: autoSettlePending
};
