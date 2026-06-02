const { getFundNavHistory, calcIndicators, getFundBasicInfo } = require("./fund-data");
const fs = require("fs");
const path = require("path");

const HISTORY_FILE = path.join(__dirname, "..", "data", "history.json");

const WEIGHTS = {
  base: 10,
  drawdown: 2.0,
  maDeviation: 1.5,
  recent5Change: -0.8,
  recent10Change: -0.3,
  volatility: -0.5,
  yearReturn: 0.5,       // 1年收益率权重（越高越好）
  // Enhanced factors
  trendBonus: 2.0,       // MA5 > MA10 多头排列加分
  momentumReversal: 3.0, // 连续下跌后阳线反弹加分
  relativeStrength: 1.5, // 同类型基金相对强弱
  historicalSuccess: 1.0,// 历史推荐成功率加分
  feePenalty: -1.0,      // 费率惩罚系数 (feeRate * this)
  rotationPenalty: -1.0, // 连续推荐惩罚 (per day)
  premiumPenalty: -3.0,  // 溢价>3%时的惩罚
  scarcityBonus: 1.5,    // 稀缺加分：限购越严加分越多
  unknownPenalty: -3.0,  // API获取失败时的惩罚
  suspended: -999
};

function scoreFund(fund, indicators, historyContext, recentPicks, premiumInfo) {
  if (fund.status !== "active" || fund.dailyLimit <= 0) {
    return { score: WEIGHTS.suspended, reason: fund.status === "suspended" ? "暂停申购" : "限额为0", indicators };
  }

  // API获取失败时降权
  if (fund._purchaseStatus === "unknown") {
    return { score: WEIGHTS.unknownPenalty, reason: "限购信息未知(降权)", indicators };
  }

  if (indicators.error) {
    return { score: WEIGHTS.base, reason: "数据不足，使用基础评分", indicators };
  }

  let score = WEIGHTS.base;
  const reasons = [];

  // === 原有因子 ===

  // 1. 回撤因子：跌幅越大，加价越高
  const drawdownScore = indicators.drawdown * WEIGHTS.drawdown;
  score += drawdownScore;
  if (drawdownScore > 0) reasons.push("回撤" + indicators.drawdown + "%加" + round1(drawdownScore) + "分");
  else if (drawdownScore < 0) reasons.push("近期新高扣" + round1(Math.abs(drawdownScore)) + "分");

  // 2. MA偏离因子：低于均线加分，高于均线扣分
  const maScore = indicators.maDeviation * WEIGHTS.maDeviation;
  score += maScore;
  if (maScore > 0) reasons.push("低于MA10加" + round1(maScore) + "分");
  else if (maScore < 0) reasons.push("高于MA10扣" + round1(Math.abs(maScore)) + "分");

  // 3. 5日涨跌因子：短期涨太多扣分（追高风险）
  const change5Score = indicators.recent5Change * WEIGHTS.recent5Change;
  score += change5Score;
  if (change5Score < -2) reasons.push("5日涨" + indicators.recent5Change + "%扣" + round1(Math.abs(change5Score)) + "分");

  // 4. 波动率因子：高波动扣分
  const volScore = indicators.volatility * WEIGHTS.volatility;
  score += volScore;
  if (volScore < -1) reasons.push("波动" + indicators.volatility + "%扣" + round1(Math.abs(volScore)) + "分");

  // 13. 1年长期收益因子：使用API返回的SYL_1N（更可靠）
  var yr = (premiumInfo && premiumInfo.yearReturn) || (indicators && indicators.yearReturn);
  if (yr && yr !== 0) {
    var yearScore = yr * WEIGHTS.yearReturn;
    score += yearScore;
    if (Math.abs(yearScore) > 0.3) {
      if (yearScore > 0) reasons.push("1年涨" + yr + "%加" + round1(yearScore) + "分");
      else reasons.push("1年跌" + Math.abs(yr) + "%扣" + round1(Math.abs(yearScore)) + "分");
    }
  }

  // === 新增智能因子 ===

  // 5. 趋势强度因子：多头排列加分
  if (indicators.navs && indicators.navs.length >= 10) {
    var navs = indicators.navs;
    var latest = navs[navs.length - 1];
    var calcMa = function(arr, n) {
      var slice = arr.slice(-n);
      return slice.reduce(function(a,b){return a+b},0) / slice.length;
    };
    var ma5Val = calcMa(navs, 5);
    var ma10Val = calcMa(navs, 10);
    var ma20Val = navs.length >= 20 ? calcMa(navs, 20) : ma10Val;

    if (ma5Val > ma10Val && ma10Val > ma20Val) {
      // 完美多头排列
      score += WEIGHTS.trendBonus;
      reasons.push("多头排列+" + WEIGHTS.trendBonus + "分");
    } else if (ma5Val < ma10Val && ma10Val < ma20Val) {
      // 完美空头排列，但可能意味着更大回撤机会
      score += WEIGHTS.trendBonus * 0.5;
      reasons.push("空头排列(潜力)+" + round1(WEIGHTS.trendBonus * 0.5) + "分");
    }

    // 6. 动量反转信号：连续3天阴线后出现阳线
    if (navs.length >= 5) {
      var last3Down = true;
      var todayUp = navs[navs.length-1] > navs[navs.length-2];
      for (var k = navs.length - 4; k < navs.length - 1; k++) {
        if (navs[k] >= navs[k-1]) { last3Down = false; break; }
      }
      if (last3Down && todayUp) {
        score += WEIGHTS.momentumReversal;
        reasons.push("反转信号+" + WEIGHTS.momentumReversal + "分");
      }
    }
  }

  // 7. 历史推荐成功率加分
  if (historyContext && historyContext.successRate !== undefined) {
    var histBonus = historyContext.successRate * WEIGHTS.historicalSuccess;
    score += histBonus;
    if (histBonus > 0.5) reasons.push("历史成功率" + round1(historyContext.successRate * 100) + "%加" + round1(histBonus) + "分");
  }

  // 9. 费率惩罚：管理费率越高，扣分越多
  if (fund.feeRate && fund.feeRate > 0) {
    var feeScore = fund.feeRate * WEIGHTS.feePenalty;
    score += feeScore;
    if (Math.abs(feeScore) > 0.5) reasons.push("费率" + fund.feeRate + "%扣" + round1(Math.abs(feeScore)) + "分");
  }

  // 10. 轮换惩罚：连续推荐的基金降权
  if (recentPicks && recentPicks[fund.code]) {
    var consecutiveDays = recentPicks[fund.code];
    var rotPenalty = consecutiveDays * WEIGHTS.rotationPenalty;
    score += rotPenalty;
    if (consecutiveDays >= 1) reasons.push("连续推荐" + consecutiveDays + "天扣" + round1(Math.abs(rotPenalty)) + "分");
  }

  // 8. 限购惩罚：限大额的基金降低优先级（避免推荐买不了的）
  if (fund._purchaseStatus === "limited") {
    score *= 0.5;
    reasons.push("限大额，降权50%");
  }

  // 11. 溢价率惩罚：溢价>3%扣分
  if (premiumInfo && premiumInfo.premiumRate > 3) {
    score += WEIGHTS.premiumPenalty;
    reasons.push("溢价" + premiumInfo.premiumRate + "%扣" + Math.abs(WEIGHTS.premiumPenalty) + "分");
  }

  // 12. 稀缺加分：限购越严说明需求越旺盛，品质越高
  if (fund._purchaseStatus === "limited" && fund.dailyLimit > 0) {
    var scarceScore = 0;
    if (fund.dailyLimit <= 10) {
      scarceScore = WEIGHTS.scarcityBonus * 2;
      reasons.push("限购" + fund.dailyLimit + "元稀缺+" + round1(scarceScore) + "分");
    } else if (fund.dailyLimit <= 50) {
      scarceScore = WEIGHTS.scarcityBonus;
      reasons.push("限购" + fund.dailyLimit + "元稀缺+" + round1(scarceScore) + "分");
    }
    score += scarceScore;
  }

  score = Math.max(0.1, score);
  return { score: round2(score), reason: reasons.length > 0 ? reasons.join("，") : "正常评分", indicators };
}

/**
 * TopN分配策略：只推荐得分最高的N只基金，每只金额>=minPurchase
 */
function allocateTopN(budget, scoredFunds, topN, minPurchase) {
  if (!topN) topN = 3;
  if (!minPurchase) minPurchase = 10;

  // 过滤掉得分<=0的
  var available = scoredFunds.filter(f => f.score > 0);
  if (available.length === 0) return [];

  // 按得分降序排列
  available.sort(function(a,b) { return b.score - a.score; });

  // 多元化约束：同类型基金最多选1只
  var usedTypes = {};
  var candidates = [];
  for (var i = 0; i < available.length && candidates.length < topN; i++) {
    var fund = available[i];
    var fundType = fund.type || "unknown";
    if (!usedTypes[fundType]) {
      candidates.push(fund);
      usedTypes[fundType] = true;
    }
  }
  // 如果去重后不够N只，用剩余最高分补齐
  if (candidates.length < topN) {
    for (var j = 0; j < available.length && candidates.length < topN; j++) {
      if (candidates.indexOf(available[j]) === -1) {
        candidates.push(available[j]);
      }
    }
  }

  // 检查每只基金的minPurchase
  var validCandidates = candidates.filter(f => {
    var min = f.minPurchase || minPurchase;
    return f.dailyLimit >= min;
  });

  if (validCandidates.length === 0) return [];

  // 计算总分
  var totalScore = validCandidates.reduce(function(sum, f) { return sum + f.score; }, 0);

  // 按比例分配，但每只不少于minPurchase
  var remaining = budget;
  var result = [];

  // 第一轮：按比例分配
  for (var i = 0; i < validCandidates.length; i++) {
    var fund = validCandidates[i];
    var min = fund.minPurchase || minPurchase;
    var share = round2((fund.score / totalScore) * budget);
    var allocated = Math.min(share, fund.dailyLimit, remaining);

    // 确保不低于最低投资额
    if (allocated < min) {
      if (remaining >= min) {
        allocated = min;
      } else {
        allocated = 0;
      }
    }

    // 确保不超过限购
    allocated = Math.min(allocated, fund.dailyLimit);

    if (allocated > 0) {
      fund.allocated = round2(allocated);
      remaining = round2(remaining - allocated);
      result.push(fund);
    }
  }

  // 第二轮：如果还有剩余，按得分优先补齐
  if (remaining >= minPurchase) {
    for (var j = 0; j < result.length && remaining >= minPurchase; j++) {
      var extra = Math.min(remaining, result[j].dailyLimit - result[j].allocated);
      if (extra >= minPurchase) {
        result[j].allocated = round2(result[j].allocated + extra);
        remaining = round2(remaining - extra);
      }
    }
  }

  // 修正：移除分配为0的
  result = result.filter(f => f.allocated > 0);

  return result.sort(function(a,b) { return b.score - a.score; });
}

async function allocateDynamic(budget, funds, config) {
  var lookbackDays = config.lookbackDays || 30;
  var topN = config.topN || 3;
  var minPurchase = config.minPurchase || 10;
  var enableHistory = config.enableHistory !== false;
  var budgetScale = config.budgetScale || null;

  console.log("[动态策略] 获取基金数据和限购信息...");

  // Step 1: 统一获取限购+溢价信息（一次API调用）
  var purchaseInfoMap = {};
  var premiumInfoMap = {};
  try {
    var basicResults = await Promise.all(funds.map(async fund => {
      var info = await getFundBasicInfo(fund.code);
      return { code: fund.code, info: info };
    }));
    for (var i = 0; i < basicResults.length; i++) {
      purchaseInfoMap[basicResults[i].code] = basicResults[i].info;
      premiumInfoMap[basicResults[i].code] = { premiumRate: basicResults[i].info.premiumRate, nav: basicResults[i].info.nav, realNav: basicResults[i].info.realNav, yearReturn: basicResults[i].info.yearReturn };
    }
    var highPremium = Object.entries(premiumInfoMap).filter(function(e) { return e[1].premiumRate > 3; });
    if (highPremium.length > 0) {
      console.log("[溢价] " + highPremium.length + "只基金溢价>3%，已降权");
    }
  } catch (err) {
    console.warn("[动态策略] 获取基金信息失败，使用默认值:", err.message);
  }

  // Step 2: 更新基金状态
  var updatedFunds = funds.map(fund => {
    var info = purchaseInfoMap[fund.code];
    if (info) {
      var updated = {
        ...fund,
        _purchaseStatus: info.status,
        _purchaseRawStatus: info.rawStatus
      };
      if (info.status === "suspended") {
        updated.status = "suspended";
        updated.dailyLimit = 0;
      } else {
        // 使用API返回的真实限购金额和最低申购金额
        if (info.limit && info.limit > 0) {
          updated.dailyLimit = info.limit;
        }
        if (info.minPurchase && info.minPurchase > 0) {
          updated.minPurchase = info.minPurchase;
        }
      }
      return updated;
    }
    return fund;
  });

  // Step 3: 加载历史数据
  var historyContextMap = {};
  if (enableHistory) {
    historyContextMap = loadHistoryContext(updatedFunds);
  }

  // Step 4: 获取K线数据并评分
  console.log("[动态策略] 获取K线数据 (lookback=" + lookbackDays + "天)...");
  var fundDataPairs = await Promise.all(updatedFunds.map(async fund => {
    var history = await getFundNavHistory(fund.code, lookbackDays);
    var indicators = calcIndicators(history);
    // 把navs传入indicators供高级因子使用
    if (history.length > 0) {
      indicators.navs = history.map(function(d) { return d.nav; });
    }
    return { fund, history, indicators };
  }));

  var scored = fundDataPairs.map(({ fund, indicators }) => {
    var histCtx = historyContextMap[fund.code] || null;
    var recentPicksMap = getRecentPicks();
    var premiumData = premiumInfoMap[fund.code] || null;
    var result = scoreFund(fund, indicators, histCtx, recentPicksMap, premiumData);
    return { ...fund, ...result, yearReturn: premiumData ? premiumData.yearReturn : null };
  });

  // Step 5: TopN分配
  var available = scored.filter(f => f.score > 0);
  var suspended = scored.filter(f => f.score <= 0);

  // 显示实时限购信息
  for (var j = 0; j < available.length; j++) {
    var f = available[j];
    if (f._purchaseRawStatus && f._purchaseRawStatus !== "开放申购") {
      console.log("[限购] " + f.name + "(" + f.code + ") -> " + f._purchaseRawStatus);
    }
  }

  // Step 5.5: 动态预算计算
  var budgetInfo = { budget: budget, label: "默认定投", avgScore: 0 };
  if (budgetScale) {
    var tempTop = available.slice().sort(function(a,b) { return b.score - a.score; }).slice(0, topN);
    budgetInfo = calculateDynamicBudget(tempTop, budgetScale);
    budget = budgetInfo.budget;
    console.log("[动态预算] 机会评级: " + budgetInfo.label + " (均分" + budgetInfo.avgScore + ") -> 本次投入: " + budget + "元");
  }

  var allocations = allocateTopN(budget, available, topN, minPurchase);
  var totalAllocated = allocations.reduce(function(sum, f) { return sum + f.allocated; }, 0);

  var result = {
    budget, strategy: "dynamic",
    budgetInfo: budgetInfo,
    strategyName: "智能动态策略(Top" + topN + ")",
    date: new Date().toLocaleDateString("zh-CN", { timeZone: "Asia/Shanghai" }),
    allocations, suspended,
    totalAllocated: round2(totalAllocated),
    leftover: round2(budget - totalAllocated),
    purchaseInfo: purchaseInfoMap
  };

  // Step 6: 保存历史记录
  if (enableHistory) {
    saveHistory(result, scored);
  }

  return result;
}

function getRecentPicks() {
  try {
    if (!fs.existsSync(HISTORY_FILE)) return {};
    var data = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf-8"));
    if (!data.records || data.records.length === 0) return {};
    // Count consecutive days each fund was recommended (from most recent)
    var picks = {};
    var records = data.records.slice(-5); // check last 5 records
    for (var i = records.length - 1; i >= 0; i--) {
      var rec = records[i];
      if (!rec.allocations) continue;
      for (var j = 0; j < rec.allocations.length; j++) {
        var code = rec.allocations[j].code;
        if (!picks[code]) picks[code] = 0;
        picks[code]++;
      }
    }
    return picks;
  } catch (err) {
    return {};
  }
}

function loadHistoryContext(funds) {
  try {
    if (!fs.existsSync(HISTORY_FILE)) return {};
    var data = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf-8"));
    if (!data.records || data.records.length === 0) return {};

    // 计算每只基金的历史推荐成功率
    var contextMap = {};
    var recentRecords = data.records.slice(-10); // 最近10次

    for (var i = 0; i < funds.length; i++) {
      var code = funds[i].code;
      var appearances = 0;
      var successes = 0;

      for (var j = 0; j < recentRecords.length; j++) {
        var rec = recentRecords[j];
        if (!rec.allocations) continue;
        var alloc = rec.allocations.find(a => a.code === code);
        if (alloc) {
          appearances++;
          // 如果推荐后5天内涨幅为正，算成功
          if (alloc.followUp5dReturn && alloc.followUp5dReturn > 0) {
            successes++;
          }
        }
      }

      if (appearances > 0) {
        contextMap[code] = {
          successRate: round2(successes / appearances),
          appearances: appearances,
          successes: successes
        };
      }
    }

    return contextMap;
  } catch (err) {
    console.warn("[历史] 加载历史数据失败:", err.message);
    return {};
  }
}

function saveHistory(result, allScored) {
  try {
    var data = { records: [] };
    if (fs.existsSync(HISTORY_FILE)) {
      data = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf-8"));
    }

    var record = {
      date: result.date,
      budget: result.budget,
      strategy: result.strategyName,
      totalAllocated: result.totalAllocated,
      allocations: result.allocations.map(function(f) {
        return {
          code: f.code,
          name: f.name,
          score: f.score,
          allocated: f.allocated,
          reason: f.reason,
          yearReturn: f.yearReturn || null,
          indicators: f.indicators ? {
            drawdown: f.indicators.drawdown,
            maDeviation: f.indicators.maDeviation,
            recent5Change: f.indicators.recent5Change,
            volatility: f.indicators.volatility
          } : null,
          followUp5dReturn: null,
          followUp10dReturn: null
        };
      }),
      allScores: allScored.map(function(f) {
        return { code: f.code, name: f.name, score: f.score, status: f.status };
      })
    };

    // 同一天只保留一条记录（覆盖），每天每只基金推荐次数最多+1
    var todayIndex = -1;
    for (var t = 0; t < data.records.length; t++) {
      if (data.records[t].date === result.date) {
        todayIndex = t;
        break;
      }
    }
    if (todayIndex >= 0) {
      data.records[todayIndex] = record;
    } else {
      data.records.push(record);
    }

    // 保留最近60条记录
    if (data.records.length > 60) {
      data.records = data.records.slice(-60);
    }

    fs.writeFileSync(HISTORY_FILE, JSON.stringify(data, null, 2), "utf-8");
    console.log("[历史] 已保存第" + data.records.length + "条记录");
  } catch (err) {
    console.warn("[历史] 保存失败:", err.message);
  }
}

function formatDynamicResult(result) {
  var lines = [];
  lines.push("[今日QDII投资计划] " + result.date);
  lines.push("");
  lines.push("总预算：" + result.budget + "元");
  if (result.budgetInfo && result.budgetInfo.label) {
    lines.push("机会评级：" + result.budgetInfo.label + " (TopN均分" + result.budgetInfo.avgScore + ")");
  }
  lines.push("策略：" + result.strategyName + "（基于近期K线动态加权）");
  lines.push("");

  if (result.allocations.length > 0) {
    lines.push("★ 今日推荐买入 " + result.allocations.length + " 只：");
    lines.push("+----------------------------+------+------+------+----------+--------+");
    lines.push("| 基金                        | 得分 | 5日涨跌 | 趋势 | 限购      | 买入    |");
    lines.push("+----------------------------+------+------+------+----------+--------+");
    for (var i = 0; i < result.allocations.length; i++) {
      var f = result.allocations[i];
      var name = (f.name.length > 24 ? f.name.substring(0, 24) + ".." : f.name).padEnd(26);
      var score = String(f.score).padStart(4);
      var change = f.indicators && !f.indicators.error
        ? ((f.indicators.recent5Change >= 0 ? "+" : "") + f.indicators.recent5Change + "%").padStart(7)
        : "    N/A";
      var trend = "  - ";
      if (f.indicators && f.indicators.navs && f.indicators.navs.length >= 10) {
        var navs = f.indicators.navs;
        var m5 = navs.slice(-5).reduce(function(a,b){return a+b},0)/5;
        var m10 = navs.slice(-10).reduce(function(a,b){return a+b},0)/10;
        trend = m5 > m10 ? " ↑ " : (m5 < m10 ? " ↓ " : " = ");
      }
      var limitStr = f._purchaseRawStatus || (f.dailyLimit + "元");
      var limit = limitStr.padStart(8).substring(0, 8);
      var alloc = (f.allocated + "元").padStart(6);
      lines.push("| " + name + "| " + score + " | " + change + " | " + trend + " | " + limit + " | " + alloc + " |");
    }
    lines.push("+----------------------------+------+------+------+----------+--------+");
    lines.push("");
    lines.push("评分说明：得分越高 = 近期跌幅越大 / 低于均线越深 / 越该多买");
  } else {
    lines.push(">> 今日无可申购基金");
  }

  if (result.suspended.length > 0) {
    lines.push("");
    lines.push("今日跳过（不可买）：");
    for (var k = 0; k < result.suspended.length; k++) {
      var sf = result.suspended[k];
      var reasonStr = sf._purchaseRawStatus || (sf.status === "suspended" ? "暂停申购" : "限额为0");
      lines.push("  - " + sf.name + "(" + sf.code + ") -> " + reasonStr);
    }
  }

  if (result.leftover > 0) {
    lines.push("");
    lines.push("剩余未分配：" + result.leftover + "元");
  }

  lines.push("");
  lines.push("合计买入：" + result.totalAllocated + "元 / 预算" + result.budget + "元");
  return lines.join("\n");
}

function calculateDynamicBudget(topAllocations, budgetScale) {
  if (!budgetScale || !budgetScale.thresholds || topAllocations.length === 0) {
    return { budget: budgetScale ? budgetScale.base : 20, label: "默认定投", avgScore: 0 };
  }
  var avgScore = topAllocations.reduce(function(sum, f) { return sum + f.score; }, 0) / topAllocations.length;
  avgScore = round2(avgScore);

  var thresholds = budgetScale.thresholds.sort(function(a, b) { return b.minScore - a.minScore; });
  for (var i = 0; i < thresholds.length; i++) {
    if (avgScore >= thresholds[i].minScore) {
      var budget = Math.min(thresholds[i].budget, budgetScale.max || 100);
      return { budget: budget, label: thresholds[i].label, avgScore: avgScore };
    }
  }
  return { budget: budgetScale.base || 20, label: "默认定投", avgScore: avgScore };
}

function round1(n) { return Math.round(n * 10) / 10; }
function round2(n) { return Math.round(n * 100) / 100; }

module.exports = { allocateDynamic, formatDynamicResult, scoreFund, WEIGHTS, allocateTopN, calculateDynamicBudget };
