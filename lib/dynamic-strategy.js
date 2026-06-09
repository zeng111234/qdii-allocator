const { getFundNavHistory, calcIndicators, getFundBasicInfo } = require("./fund-data");
const { scoreFundExternalSignal } = require("./external-signals");
const fs = require("fs");
const path = require("path");

const HISTORY_FILE = path.join(__dirname, "..", "data", "history.json");

function formatLocalDate(date) {
  var d = new Date(date);
  var year = d.getFullYear();
  var month = ("0" + (d.getMonth() + 1)).slice(-2);
  var day = ("0" + d.getDate()).slice(-2);
  return year + "/" + month + "/" + day;
}

/**
 * 评分权重体系（面向A类长线投资）
 * 核心逻辑：长期表现 > 短期信号
 */
var WEIGHTS = {
  base: 10,
  // 长期因子（核心，但权重平衡）
  yearReturn: 0.3,          // 1年收益率（API SYL_1N，不主导排名）
  threeYearReturn: 0.15,    // 3年累计收益（API SYL_3N，长期验证）
  sharpeRatio: 4.0,         // 夏普比率（风险调整收益，高权重）
  maxDrawdown: 0.12,        // 最大回撤惩罚
  longTermBull: 3.0,        // 长期牛市趋势加分
  longTermBear: -4.0,       // 长期熊市趋势扣分
  stabilityBonus: 2.0,      // 稳定收益加分（低波动+正收益）
  
  // 中期因子
  drawdown: 1.5,            // 近期回撤（跌幅越大加分越多）
  maDeviation: 1.2,         // MA10偏离（低于均线加分）
  trendBonus: 2.0,          // 多头排列加分
  trendPenalty: -2.5,       // 空头排列扣分
  momentumReversal: 2.0,    // 连续下跌后阳线反弹
  
  // 短期因子（低权重）
  recent5Change: -0.5,      // 5日涨跌
  volatility: -0.4,         // 波动率惩罚
  
  // 辅助因子
  historicalSuccess: 1.0,   // 历史推荐成功率
  feePenalty: -0.8,         // 费率惩罚
  rotationPenalty: -1.0,    // 连续推荐惩罚
  premiumPenalty: -3.0,     // 溢价>3%惩罚
  scarcityBonus: 2.0,       // 限购加分（品质信号）
  unknownPenalty: -3.0,     // 信息未知惩罚
  suspended: -999
};

function scoreFund(fund, indicators, historyContext, recentPicks, premiumInfo, externalSignals, externalSignalMaxScore) {
  if (fund.status !== "active" || fund.dailyLimit <= 0) {
    return { score: WEIGHTS.suspended, reason: fund.status === "suspended" ? "\u6682\u505c\u7533\u8d2d" : "\u9650\u989d\u4e3a0", indicators };
  }

  // 数据不足直接排除
  if (indicators.error || !indicators.dataPoints || indicators.dataPoints < 60) {
    return { score: -1, reason: "\u6570\u636e\u4e0d\u8db3\uff08" + (indicators.dataPoints || 0) + "\u65e5\uff09\uff0c\u6392\u9664\u63a8\u8350", indicators };
  }

  var score = WEIGHTS.base;
  var reasons = [];

  // API获取失败时使用默认值继续评分（不排除）
  if (fund._purchaseStatus === "unknown") {
    reasons.push("\u9650\u8d2dAPI\u5931\u8d25\uff0c\u4f7f\u7528\u9ed8\u8ba4\u503c");
  }

  // ========== 长期因子（核心） ==========

  // 1年收益率（优先使用API数据 SYL_1N）
  var yr = (premiumInfo && premiumInfo.yearReturn !== null && premiumInfo.yearReturn !== undefined) ? premiumInfo.yearReturn : (indicators.annualizedReturn !== null ? indicators.annualizedReturn : indicators.yearReturn);
  if (yr && yr !== 0) {
    var yrScore = yr * WEIGHTS.yearReturn;
    score += yrScore;
    if (Math.abs(yrScore) > 0.3) {
      if (yrScore > 0) reasons.push("1\u5e74\u6da8" + yr + "%\u52a0" + round1(yrScore) + "\u5206");
      else reasons.push("1\u5e74\u8dcc" + Math.abs(yr) + "%\u6263" + round1(Math.abs(yrScore)) + "\u5206");
    }
  }

  // 3年累计收益（优先使用API数据 SYL_3N）
  var y3 = (premiumInfo && premiumInfo.threeYearReturn !== null && premiumInfo.threeYearReturn !== undefined) ? premiumInfo.threeYearReturn : indicators.threeYearReturn;
  if (y3 && y3 !== 0) {
    var y3Score = (y3 / 3) * WEIGHTS.threeYearReturn;
    score += y3Score;
    if (Math.abs(y3Score) > 0.3) {
      if (y3Score > 0) reasons.push("3\u5e74\u7d2f\u8ba1" + y3 + "%\u52a0" + round1(y3Score) + "\u5206");
      else reasons.push("3\u5e74\u7d2f\u8ba1" + Math.abs(y3) + "%\u6263" + round1(Math.abs(y3Score)) + "\u5206");
    }
  }

  // 夏普比率（关键指标 - 风险调整后收益）
  if (indicators.sharpeRatio !== null) {
    var sharpeScore = indicators.sharpeRatio * WEIGHTS.sharpeRatio;
    score += sharpeScore;
    if (Math.abs(sharpeScore) > 0.5) {
      if (sharpeScore > 0) reasons.push("\u590f\u666e" + indicators.sharpeRatio + "\u52a0" + round1(sharpeScore) + "\u5206");
      else reasons.push("\u590f\u666e" + indicators.sharpeRatio + "\u6263" + round1(Math.abs(sharpeScore)) + "\u5206");
    }
  }

  // 最大回撤惩罚
  if (indicators.maxDrawdown !== null && indicators.maxDrawdown < 0) {
    var ddPenalty = Math.abs(indicators.maxDrawdown) * WEIGHTS.maxDrawdown;
    score -= ddPenalty;
    if (ddPenalty > 1) reasons.push("\u6700\u5927\u56de\u64a4" + indicators.maxDrawdown + "%\u6263" + round1(ddPenalty) + "\u5206");
  }

  // 长期趋势
  if (indicators.longTermTrend === "bull") {
    score += WEIGHTS.longTermBull;
    reasons.push("\u957f\u671f\u725b\u5e02+" + WEIGHTS.longTermBull + "\u5206");
  } else if (indicators.longTermTrend === "bear") {
    score += WEIGHTS.longTermBear;
    reasons.push("\u957f\u671f\u718a\u5e02" + WEIGHTS.longTermBear + "\u5206");
  }

  // ========== 中期因子 ==========

  // 回撤因子
  var drawdownScore = indicators.drawdown * WEIGHTS.drawdown;
  score += drawdownScore;
  if (drawdownScore > 0.5) reasons.push("\u56de\u64a4" + indicators.drawdown + "%\u52a0" + round1(drawdownScore) + "\u5206");
  else if (drawdownScore < -0.5) reasons.push("\u8fd1\u671f\u65b0\u9ad8\u6263" + round1(Math.abs(drawdownScore)) + "\u5206");

  // MA偏离因子
  var maScore = indicators.maDeviation * WEIGHTS.maDeviation;
  score += maScore;
  if (maScore > 0.5) reasons.push("\u4f4e\u4e8eMA10\u52a0" + round1(maScore) + "\u5206");
  else if (maScore < -0.5) reasons.push("\u9ad8\u4e8eMA10\u6263" + round1(Math.abs(maScore)) + "\u5206");

  // 趋势强度（多头/空头排列）
  if (indicators.navs && indicators.navs.length >= 20) {
    var navs = indicators.navs;
    var calcMa = function(arr, n) {
      var slice = arr.slice(-n);
      return slice.reduce(function(a,b){return a+b},0) / slice.length;
    };
    var ma5Val = calcMa(navs, 5);
    var ma10Val = calcMa(navs, 10);
    var ma20Val = calcMa(navs, 20);

    if (ma5Val > ma10Val && ma10Val > ma20Val) {
      // 多头排列
      score += WEIGHTS.trendBonus;
      reasons.push("\u591a\u5934\u6392\u5217+" + WEIGHTS.trendBonus + "\u5206");
    } else if (ma5Val < ma10Val && ma10Val < ma20Val) {
      // 空头排列 - 扣分！
      score += WEIGHTS.trendPenalty;
      reasons.push("\u7a7a\u5934\u6392\u5217" + WEIGHTS.trendPenalty + "\u5206");
    }

    // 动量反转信号
    if (navs.length >= 5) {
      var last3Down = true;
      var todayUp = navs[navs.length-1] > navs[navs.length-2];
      for (var k = navs.length - 4; k < navs.length - 1; k++) {
        if (navs[k] >= navs[k-1]) { last3Down = false; break; }
      }
      if (last3Down && todayUp) {
        score += WEIGHTS.momentumReversal;
        reasons.push("\u53cd\u8f6c\u4fe1\u53f7+" + WEIGHTS.momentumReversal + "\u5206");
      }
    }
  }

  // ========== 短期因子（低权重） ==========

  // 5日涨跌
  var change5Score = indicators.recent5Change * WEIGHTS.recent5Change;
  score += change5Score;
  if (change5Score < -1) reasons.push("5\u65e5\u6da8" + indicators.recent5Change + "%\u6263" + round1(Math.abs(change5Score)) + "\u5206");

  // 波动率
  var volScore = indicators.volatility * WEIGHTS.volatility;
  score += volScore;
  if (volScore < -0.5) reasons.push("\u6ce2\u52a8" + indicators.volatility + "%\u6263" + round1(Math.abs(volScore)) + "\u5206");

  // ========== 辅助因子 ==========

  // 历史推荐成功率
  if (historyContext && historyContext.successRate !== undefined) {
    var histBonus = historyContext.successRate * WEIGHTS.historicalSuccess;
    score += histBonus;
    if (histBonus > 0.3) reasons.push("\u5386\u53f2\u6210\u529f\u7387" + round1(historyContext.successRate * 100) + "%\u52a0" + round1(histBonus) + "\u5206");
  }

  // 费率惩罚
  if (fund.feeRate && fund.feeRate > 0) {
    var feeScore = fund.feeRate * WEIGHTS.feePenalty;
    score += feeScore;
    if (Math.abs(feeScore) > 0.3) reasons.push("\u8d39\u7387" + fund.feeRate + "%\u6263" + round1(Math.abs(feeScore)) + "\u5206");
  }

  // 轮换惩罚
  if (recentPicks && recentPicks[fund.code]) {
    var consecutiveDays = recentPicks[fund.code];
    var rotPenalty = consecutiveDays * WEIGHTS.rotationPenalty;
    score += rotPenalty;
    if (consecutiveDays >= 1) reasons.push("\u8fde\u7eed\u63a8\u8350" + consecutiveDays + "\u5929\u6263" + round1(Math.abs(rotPenalty)) + "\u5206");
  }

  // 稳定性加分：波动率低 + 正收益 = 稳定赚钱
  if (yr && yr > 0 && indicators.volatility < 2.0) {
    var stabScore = WEIGHTS.stabilityBonus * (2.0 - indicators.volatility) / 2.0;
    score += stabScore;
    if (stabScore > 0.5) reasons.push("\u7a33\u5b9a\u6536\u76ca+" + round1(stabScore) + "\u5206");
  }

  // 限购是品质信号（太赚钱了才被限）- 不再降权，通过稀缺加分体现

  // 溢价率惩罚
  if (premiumInfo && premiumInfo.premiumRate > 3) {
    score += WEIGHTS.premiumPenalty;
    reasons.push("\u6ea2\u4ef7" + premiumInfo.premiumRate + "%\u6263" + Math.abs(WEIGHTS.premiumPenalty) + "\u5206");
  }

  // 稀缺加分（限购越严说明越赚钱）
  if (fund._purchaseStatus === "limited" && fund.dailyLimit > 0) {
    var scarceScore = 0;
    if (fund.dailyLimit <= 10) {
      scarceScore = 6;
      reasons.push("\u9650\u8d2d" + fund.dailyLimit + "\u5143\u6781\u54c1\u7a00\u7f3a+" + scarceScore + "\u5206");
    } else if (fund.dailyLimit <= 50) {
      scarceScore = 4;
      reasons.push("\u9650\u8d2d" + fund.dailyLimit + "\u5143\u7a00\u7f3a+" + scarceScore + "\u5206");
    } else if (fund.dailyLimit <= 100) {
      scarceScore = 2;
      reasons.push("\u9650\u8d2d" + fund.dailyLimit + "\u5143\u7a00\u7f3a+" + scarceScore + "\u5206");
    } else if (fund.dailyLimit <= 500) {
      scarceScore = 1;
      reasons.push("\u9650\u8d2d" + fund.dailyLimit + "\u5143\u52a0\u5206+" + scarceScore + "\u5206");
    }
    score += scarceScore;
  }

  var externalSignal = scoreFundExternalSignal(fund, externalSignals, externalSignalMaxScore || 3);
  if (externalSignal.score !== 0) {
    score += externalSignal.score;
    var externalText = "External signal " + (externalSignal.score > 0 ? "+" : "") + externalSignal.score + " pts";
    if (externalSignal.matches && externalSignal.matches.length > 0) {
      externalText += "(" + externalSignal.matches.join("/") + ")";
    }
    reasons.push(externalText);
  }

  score = Math.max(0.1, score);
  return { score: round2(score), reason: reasons.length > 0 ? reasons.join("\uff0c") : "\u6b63\u5e38\u8bc4\u5206", indicators, externalSignal: externalSignal };
}

/**
 * TopN排名策略：输出排名前N的基金（不分配金额）
 * 用户自行决定买入金额
 */
function rankTopN(scoredFunds, topN, minPurchase) {
  if (!topN) topN = 10;
  if (!minPurchase) minPurchase = 10;

  // 过滤掉得分<=0的（包括数据不足被排除的）
  var available = scoredFunds.filter(f => f.score > 0);
  if (available.length === 0) return [];

  // 按得分降序排列
  available.sort(function(a,b) { return b.score - a.score; });

  // 取TopN（不做同类型去重，因为用户要看完整排名）
  var ranked = available.slice(0, topN).map(function(f, i) {
    f.rank = i + 1;
    return f;
  });

  return ranked;
}

async function allocateDynamic(budget, funds, config) {
  var lookbackDays = config.lookbackDays || 750; // 默认3年
  var topN = config.topN || 10;
  var minPurchase = config.minPurchase || 10;
  var enableHistory = config.enableHistory !== false;
  var externalSignals = config.externalSignals || null;
  var externalSignalMaxScore = config.externalSignalMaxScore || 3;

  console.log("[\u52a8\u6001\u7b56\u7565] \u83b7\u53d6\u57fa\u91d1\u6570\u636e\u548c\u9650\u8d2d\u4fe1\u606f...");
  console.log("[\u52a8\u6001\u7b56\u7565] lookback=" + lookbackDays + "\u5929\uff08\u7ea6" + Math.round(lookbackDays/250) + "\u5e74\uff09\u6570\u636e\uff0cTop" + topN);

  // Step 1: 获取限购+溢价+收益率信息
  var purchaseInfoMap = {};
  var premiumInfoMap = {};
  try {
    // 分批请求避免API限流（每批5只，间隔500ms）
    var basicResults = [];
    for (var bi = 0; bi < funds.length; bi += 5) {
      var batch = funds.slice(bi, bi + 5);
      var batchResults = await Promise.all(batch.map(async fund => {
        var info = await getFundBasicInfo(fund.code);
        // 失败重试一次
        if (!info || info.status === "unknown") {
          await new Promise(function(r) { setTimeout(r, 1000); });
          info = await getFundBasicInfo(fund.code);
        }
        return { code: fund.code, info: info };
      }));
      basicResults = basicResults.concat(batchResults);
      if (bi + 5 < funds.length) await new Promise(function(r) { setTimeout(r, 500); });
    }
    for (var i = 0; i < basicResults.length; i++) {
      purchaseInfoMap[basicResults[i].code] = basicResults[i].info;
      premiumInfoMap[basicResults[i].code] = {
        premiumRate: basicResults[i].info.premiumRate,
        premiumStale: basicResults[i].info.premiumStale || false,
        gzTime: basicResults[i].info.gzTime || "",
        nav: basicResults[i].info.nav,
        realNav: basicResults[i].info.realNav,
        yearReturn: basicResults[i].info.yearReturn,
        threeYearReturn: basicResults[i].info.threeYearReturn
      };
    }
    var highPremium = Object.entries(premiumInfoMap).filter(function(e) { return e[1].premiumRate > 3; });
    if (highPremium.length > 0) {
      console.log("[溢价] " + highPremium.length + "只基金溢价>3%，已降权");
    }
    var stalePremium = Object.entries(premiumInfoMap).filter(function(e) { return e[1].premiumStale; });
    if (stalePremium.length > 0) {
      console.warn("[数据] " + stalePremium.length + "只基金估值过期（非当天），溢价率已置零");
    }
  } catch (err) {
    console.warn("[\u52a8\u6001\u7b56\u7565] \u83b7\u53d6\u57fa\u91d1\u4fe1\u606f\u5931\u8d25\uff0c\u4f7f\u7528\u9ed8\u8ba4\u503c:", err.message);
  }

  // Step 2: 更新基金状态 + 检测限购变化
  var fundChanges = [];
  var updatedFunds = funds.map(fund => {
    var info = purchaseInfoMap[fund.code];
    if (info) {
      // 检测变化
      var changes = [];
      if (info.status === "suspended" && fund.status === "active") {
        changes.push({ type: "suspended", from: fund.status, to: "suspended", message: fund.name + " \u6682\u505c\u7533\u8d2d" });
      } else if (info.status === "active" && fund.status === "suspended") {
        changes.push({ type: "restored", from: "suspended", to: "active", message: fund.name + " \u6062\u590d\u7533\u8d2d" });
      }
      if (info.limit && info.limit > 0 && fund.dailyLimit > 0 && info.limit < fund.dailyLimit) {
        changes.push({ type: "limit_down", from: fund.dailyLimit, to: info.limit, message: fund.name + " \u9650\u8d2d\u4ece" + fund.dailyLimit + "\u964d\u5230" + info.limit });
      } else if (info.limit && info.limit > 0 && fund.dailyLimit > 0 && info.limit > fund.dailyLimit) {
        changes.push({ type: "limit_up", from: fund.dailyLimit, to: info.limit, message: fund.name + " \u9650\u8d2d\u4ece" + fund.dailyLimit + "\u5347\u5230" + info.limit });
      }
      if (changes.length > 0) {
        fundChanges = fundChanges.concat(changes.map(function(c) { c.code = fund.code; return c; }));
      }

      var updated = {
        ...fund,
        _purchaseStatus: info.status,
        _purchaseRawStatus: info.rawStatus
      };
      if (info.status === "suspended") {
        updated.status = "suspended";
        updated.dailyLimit = 0;
      } else {
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

  // 自动更新 funds.json
  if (fundChanges.length > 0) {
    try {
      var fundsFilePath = path.join(__dirname, "..", "data", "funds.json");
      var fundsFileData = JSON.parse(fs.readFileSync(fundsFilePath, "utf-8"));
      for (var ci = 0; ci < updatedFunds.length; ci++) {
        var uf = updatedFunds[ci];
        var existing = fundsFileData.funds.find(function(f) { return f.code === uf.code; });
        if (existing) {
          if (uf.dailyLimit !== existing.dailyLimit) existing.dailyLimit = uf.dailyLimit;
          if (uf.status !== existing.status) existing.status = uf.status;
          if (uf.minPurchase !== existing.minPurchase) existing.minPurchase = uf.minPurchase;
        }
      }
      fs.writeFileSync(fundsFilePath, JSON.stringify(fundsFileData, null, 2), "utf-8");
      console.log("[\u9650\u8d2d\u76d1\u63a7] \u68c0\u6d4b\u5230 " + fundChanges.length + " \u9879\u53d8\u5316\uff0c\u5df2\u81ea\u52a8\u66f4\u65b0 funds.json");
      for (var fci = 0; fci < fundChanges.length; fci++) {
        console.log("  \u26a0\ufe0f " + fundChanges[fci].message);
      }
    } catch(e) {
      console.warn("[\u9650\u8d2d\u76d1\u63a7] \u66f4\u65b0 funds.json \u5931\u8d25:", e.message);
    }
  }

  // Step 3: 加载历史数据
  var historyContextMap = {};
  if (enableHistory) {
    historyContextMap = loadHistoryContext(updatedFunds);
  }

  // Step 4: 获取K线数据并评分（3年数据）
  console.log("[\u52a8\u6001\u7b56\u7565] \u83b7\u53d6" + updatedFunds.length + "\u53ea\u57fa\u91d1K\u7ebf\u6570\u636e (" + lookbackDays + "\u5929)...");
  // 逐个串行请求避免限流
  var fundDataPairs = [];
  var fetchFailCount = 0;
  for (var ki = 0; ki < updatedFunds.length; ki++) {
    var fund = updatedFunds[ki];
    var history = await getFundNavHistory(fund.code, lookbackDays);
    var indicators = calcIndicators(history);
    if (history.length > 0) {
      indicators.navs = history.map(function(d) { return d.nav; });
    }
    if (history.length < 30) {
      fetchFailCount++;
      console.warn("[动态策略] 基金 " + fund.name + "(" + fund.code + ") 数据不足: " + history.length + "条记录，需要>=30");
    }
    fundDataPairs.push({ fund, history, indicators });
    if (ki < updatedFunds.length - 1) await new Promise(function(r) { setTimeout(r, 300); });
  }
  if (fetchFailCount > 0) {
    console.warn("[动态策略] " + fetchFailCount + "只基金数据不足，将被排除评分");
  }

  var recentPicksMap = getRecentPicks();
  var scored = fundDataPairs.map(({ fund, indicators }) => {
    var histCtx = historyContextMap[fund.code] || null;
    var premiumData = premiumInfoMap[fund.code] || null;
    // scoreFund内部会优先使用premiumData的SYL_1N/SYL_3N
    var result = scoreFund(fund, indicators, histCtx, recentPicksMap, premiumData, externalSignals, externalSignalMaxScore);
    // 合并API数据到indicators供history保存
    if (premiumData) {
      if (premiumData.yearReturn) indicators.yearReturn = premiumData.yearReturn;
      if (premiumData.threeYearReturn) indicators.threeYearReturn = premiumData.threeYearReturn;
      if (premiumData.yearReturn && !indicators.annualizedReturn) {
        indicators.annualizedReturn = premiumData.yearReturn;
      }
    }
    return { ...fund, ...result, yearReturn: premiumData && premiumData.yearReturn !== null ? premiumData.yearReturn : null };
  });

  // Step 5: TopN排名
  var available = scored.filter(f => f.score > 0);
  var suspended = scored.filter(f => f.score <= 0);
  var dataMissing = scored.filter(f => f.reason && f.reason.indexOf("\u6392\u9664") >= 0);

  // 显示限购信息
  for (var j = 0; j < available.length; j++) {
    var f = available[j];
    if (f._purchaseRawStatus && f._purchaseRawStatus !== "\u5f00\u653e\u7533\u8d2d") {
      console.log("[\u9650\u8d2d] " + f.name + "(" + f.code + ") -> " + f._purchaseRawStatus);
    }
  }

  // 轮动机制：当得分接近时引入随机性，避免每天推荐一样的基金
  var rotationApplied = applyRotation(available, recentPicksMap, topN);
  var ranked = rankTopN(rotationApplied, topN, minPurchase);
  var totalFunds = ranked.length;

  // 动态预算（仅用于标注机会评级）
  var budgetInfo = { budget: budget, label: "\u9ed8\u8ba4\u5b9a\u6295", avgScore: 0 };
  if (ranked.length > 0) {
    var avgScore = ranked.reduce(function(s, f) { return s + f.score; }, 0) / ranked.length;
    budgetInfo.avgScore = round2(avgScore);
    if (avgScore >= 15) budgetInfo.label = "\u6781\u4f73\u673a\u4f1a";
    else if (avgScore >= 12) budgetInfo.label = "\u826f\u597d\u673a\u4f1a";
    else if (avgScore >= 10) budgetInfo.label = "\u6b63\u5e38\u673a\u4f1a";
    else budgetInfo.label = "\u8c28\u614e\u89c2\u671b";
    budgetInfo.budget = budget;
  }

  // 全部有效基金的简要排名（供AI参考补位）
  var allRanked = available.map(function(f, i) {
    return {
      rank: i + 1,
      code: f.code,
      name: f.name,
      type: f.type,
      score: f.score,
      dailyLimit: f.dailyLimit,
      yearReturn: f.yearReturn !== null && f.yearReturn !== undefined ? f.yearReturn : (f.indicators ? f.indicators.yearReturn : null),
      sharpeRatio: f.indicators ? f.indicators.sharpeRatio : null,
      maxDrawdown: f.indicators ? f.indicators.maxDrawdown : null,
      longTermTrend: f.indicators ? f.indicators.longTermTrend : null,
      _purchaseStatus: f._purchaseStatus,
      externalSignal: f.externalSignal || null
    };
  });

  var result = {
    budget, strategy: "dynamic",
    budgetInfo: budgetInfo,
    strategyName: "\u667a\u80fd\u52a8\u6001\u7b56\u7565(Top" + topN + " \u6392\u540d)",
    date: formatLocalDate(new Date()),
    ranked: ranked,
    allRanked: allRanked,
    suspended: suspended,
    dataMissing: dataMissing,
    totalRanked: totalFunds,
    allAvailable: available.length,
    totalPool: scored.length,
    purchaseInfo: purchaseInfoMap,
    externalSignals: externalSignals,
    fundChanges: fundChanges
  };

  // Step 5.5: 持仓感知 + 分数加权分配
  try {
    var portfolioData = loadPortfolioSafe();
    if (portfolioData && portfolioData.holdings && portfolioData.holdings.length > 0) {
      applyPortfolioAwareness(result, portfolioData);
    }
    if (budget > 0 && ranked.length > 0) {
      result.allocations = allocateByScore(budget, ranked, minPurchase);
      var totalAllocated = result.allocations.reduce(function(s, a) { return s + a.allocated; }, 0);
      result.totalAllocated = Math.round(totalAllocated * 100) / 100;
      result.leftover = Math.round((budget - totalAllocated) * 100) / 100;
    }
  } catch(e) {
    console.warn("[分配] 持仓感知/分数分配失败:", e.message);
  }

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
    var picks = {};
    var records = data.records.slice(-5);
    for (var i = records.length - 1; i >= 0; i--) {
      var rec = records[i];
      var allocs = rec.allocations || rec.ranked || [];
      for (var j = 0; j < allocs.length; j++) {
        var code = allocs[j].code;
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

    var contextMap = {};
    var recentRecords = data.records.slice(-10);

    for (var i = 0; i < funds.length; i++) {
      var code = funds[i].code;
      var appearances = 0;
      var successes = 0;

      for (var j = 0; j < recentRecords.length; j++) {
        var rec = recentRecords[j];
        var allocs = rec.allocations || rec.ranked || [];
        var alloc = allocs.find(a => a.code === code);
        if (alloc) {
          appearances++;
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
    console.warn("[\u5386\u53f2] \u52a0\u8f7d\u5386\u53f2\u6570\u636e\u5931\u8d25:", err.message);
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
      totalRanked: result.totalRanked,
      allAvailable: result.allAvailable,
      ranked: result.ranked.map(function(f) {
        return {
          rank: f.rank,
          code: f.code,
          name: f.name,
          type: f.type,
          score: f.score,
          reason: f.reason,
          yearReturn: f.yearReturn || null,
          indicators: f.indicators ? {
            drawdown: f.indicators.drawdown,
            maDeviation: f.indicators.maDeviation,
            recent5Change: f.indicators.recent5Change,
            volatility: f.indicators.volatility,
            annualizedReturn: f.indicators.annualizedReturn,
            threeYearReturn: f.indicators.threeYearReturn,
            sharpeRatio: f.indicators.sharpeRatio,
            maxDrawdown: f.indicators.maxDrawdown,
            longTermTrend: f.indicators.longTermTrend
          } : null,
          followUp5dReturn: null,
          followUp10dReturn: null
        };
      }),
      allScores: allScored.map(function(f) {
        return { code: f.code, name: f.name, score: f.score, status: f.status };
      })
    };

    // 同一天只保留一条记录
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
    console.log("[\u5386\u53f2] \u5df2\u4fdd\u5b58\u7b2c" + data.records.length + "\u6761\u8bb0\u5f55");
  } catch (err) {
    console.warn("[\u5386\u53f2] \u4fdd\u5b58\u5931\u8d25:", err.message);
  }
}

function formatDynamicResult(result) {
  var lines = [];
  lines.push("[\u4eca\u65e5QDII\u6295\u8d44\u6392\u540d] " + result.date);
  lines.push("");
  lines.push("\u53c2\u8003\u9884\u7b97\uff1a" + result.budget + "\u5143\uff08\u81ea\u884c\u786e\u5b9a\u91d1\u989d\uff09");
  if (result.budgetInfo && result.budgetInfo.label) {
    lines.push("\u673a\u4f1a\u8bc4\u7ea7\uff1a" + result.budgetInfo.label + " (Top\u5747\u5206" + result.budgetInfo.avgScore + ")");
  }
  lines.push("\u7b56\u7565\uff1a" + result.strategyName + "\uff08\u57fa\u4e8e3\u5e74K\u7ebf+\u957f\u671f\u6307\u6807\u7efc\u5408\u8bc4\u5206\uff09");
  if (result.externalSignals) {
    if (result.externalSignals.status === "ok" || result.externalSignals.status === "cached") {
      lines.push("External signals: X/RSSHub fetched " + result.externalSignals.items.length + " items and affected scoring" + (result.externalSignals.status === "cached" ? " (cached)" : ""));
    } else {
      lines.push("External signals: " + (result.externalSignals.error || "X source unavailable"));
    }
  }
  lines.push("\u6570\u636e\u6c60\uff1a" + result.totalPool + "\u53ea\u57fa\u91d1\uff0c\u5176\u4e2d" + result.allAvailable + "\u53ea\u6709\u6548\u6570\u636e");
  lines.push("");

  // 限购变化提醒
  if (result.fundChanges && result.fundChanges.length > 0) {
    lines.push("\u26a0\ufe0f \u9650\u8d2d\u53d8\u5316\uff1a");
    for (var fc = 0; fc < result.fundChanges.length; fc++) {
      lines.push("  " + result.fundChanges[fc].message);
    }
    lines.push("");
  }

  if (result.ranked && result.ranked.length > 0) {
    lines.push("\u2605 Top" + result.ranked.length + " \u63a8\u8350\u57fa\u91d1\u6392\u540d\uff1a");
    if (result.allocations && result.allocations.length > 0) {
      lines.push("\u5206\u914d\u603b\u989d\uff1a" + result.totalAllocated + "\u5143\uff08\u5269\u4f59" + result.leftover + "\u5143\u672a\u5206\u914d\uff09");
    }
    lines.push("");
    for (var i = 0; i < result.ranked.length; i++) {
      var f = result.ranked[i];
      var ind = f.indicators || {};
      var trendEmoji = "";
      if (ind.longTermTrend === "bull") trendEmoji = "\ud83d\udfe2"; // green
      else if (ind.longTermTrend === "bear") trendEmoji = "\ud83d\udd34"; // red
      else trendEmoji = "\ud83d\udfe1"; // yellow

      var allocInfo = "";
      if (result.allocations) {
        var alloc = result.allocations.find(function(a) { return a.code === f.code; });
        if (alloc) allocInfo = " | \u5206\u914d: " + alloc.allocated + "\u5143";
      }
      var penaltyInfo = f.portfolioPenalty ? " | \u6301\u4ed3\u964d\u6743-" + f.portfolioPenalty : "";

      lines.push(f.rank + ". " + f.name + "(" + f.code + ") " + trendEmoji);
      lines.push("   \u5f97\u5206: " + f.score + penaltyInfo + " | \u7c7b\u578b: " + (f.type || "-") + " | \u9650\u8d2d: " + (f.dailyLimit || "-") + "\u5143" + allocInfo);
      if (ind.annualizedReturn !== null) {
        lines.push("   \u5e74\u5316: " + ind.annualizedReturn + "% | 3\u5e74: " + (ind.threeYearReturn || "N/A") + "% | \u590f\u666e: " + (ind.sharpeRatio || "N/A") + " | \u6700\u5927\u56de\u64a4: " + (ind.maxDrawdown || "N/A") + "%");
      }
      lines.push("   5\u65e5: " + (ind.recent5Change || "N/A") + "% | MA\u504f\u79bb: " + (ind.maDeviation || "N/A") + "% | \u6ce2\u52a8: " + (ind.volatility || "N/A") + "%");
      lines.push("   \u7406\u7531: " + (f.reason || "-"));
      lines.push("");
    }
  } else {
    lines.push(">> \u4eca\u65e5\u65e0\u6709\u6548\u57fa\u91d1\u6392\u540d");
  }

  if (result.suspended && result.suspended.length > 0) {
    lines.push("\u4eca\u65e5\u8df3\u8fc7\uff08\u4e0d\u53ef\u4e70\uff09\uff1a");
    for (var k = 0; k < result.suspended.length; k++) {
      var sf = result.suspended[k];
      var reasonStr = sf._purchaseRawStatus || (sf.status === "suspended" ? "\u6682\u505c\u7533\u8d2d" : "\u9650\u989d\u4e3a0");
      lines.push("  - " + sf.name + "(" + sf.code + ") -> " + reasonStr);
    }
  }

  if (result.dataMissing && result.dataMissing.length > 0) {
    lines.push("");
    lines.push("\u6570\u636e\u4e0d\u8db3\u6392\u9664\uff1a");
    for (var m = 0; m < result.dataMissing.length; m++) {
      var dm = result.dataMissing[m];
      lines.push("  - " + dm.name + "(" + dm.code + ") -> " + dm.reason);
    }
  }

  lines.push("");
  lines.push("\u8bf4\u660e\uff1a\u5f97\u5206\u8d8a\u9ad8 = \u957f\u671f\u6536\u76ca\u8d8a\u597d + \u98ce\u9669\u8c03\u6574\u8d8a\u4f18 + \u8fd1\u671f\u56de\u64a4\u8d8a\u5927");
  return lines.join("\n");
}

/**
 * 轮动机制：得分接近的基金之间引入随机性
 * 避免每天推荐完全一样的Top10
 */
function applyRotation(available, recentPicks, topN) {
  if (!recentPicks || available.length <= topN) return available;
  
  // 按得分排序
  available.sort(function(a,b) { return b.score - a.score; });
  
  // 找到得分相近的组（差距<2分的基金视为同档）
  var groups = [];
  var currentGroup = [available[0]];
  for (var i = 1; i < available.length; i++) {
    if (available[i].score >= currentGroup[currentGroup.length - 1].score - 2) {
      currentGroup.push(available[i]);
    } else {
      groups.push(currentGroup);
      currentGroup = [available[i]];
    }
  }
  if (currentGroup.length > 0) groups.push(currentGroup);
  
  // 对每组内部做轮动：连续推荐>=2天的基金降权，让同组其他基金上位
  var result = [];
  for (var g = 0; g < groups.length; g++) {
    var group = groups[g];
    // 在组内，被连续推荐多次的放后面
    group.sort(function(a, b) {
      var aPenalty = (recentPicks[a.code] || 0) >= 2 ? 100 : 0;
      var bPenalty = (recentPicks[b.code] || 0) >= 2 ? 100 : 0;
      if (aPenalty !== bPenalty) return aPenalty - bPenalty;
      // 相同轮换惩罚时，按得分降序（稳定排序）
      if (Math.abs(a.score - b.score) > 0.001) return b.score - a.score;
      // 得分完全相同时，按基金代码字典序（保证确定性）
      return (a.code || "").localeCompare(b.code || "");
    });
    result = result.concat(group);
  }
  
  return result;
}

function round1(n) { return Math.round(n * 10) / 10; }
function round2(n) { return Math.round(n * 100) / 100; }

/**
 * 安全加载持仓数据
 */
function loadPortfolioSafe() {
  try {
    var portfolio = require("./portfolio");
    return portfolio.loadPortfolio();
  } catch(e) { return null; }
}

/**
 * 持仓感知：如果已有持仓中某大类占比过高，降低该类型基金的评分
 * 如果某只基金已经持有较多，降低其评分（避免重仓单只）
 */
function applyPortfolioAwareness(result, portfolioData) {
  if (!result.ranked || result.ranked.length === 0) return;

  // 大类归组映射
  var CATEGORY_MAP = {
    '纳指100': '美股科技', '纳指生物科技': '美股科技', '纳指科技': '美股科技',
    '标普500': '美股宽基', '标普科技': '美股宽基', '标普消费': '美股宽基', '标普医疗': '美股宽基',
    '美股消费': '美股宽基',
    '全球精选': '全球', '全球股票': '全球', '全球蓝筹': '全球', '全球科技': '全球', '全球成长': '全球', '全球制造': '全球', '全球资源': '全球', '全球医疗': '全球',
    '亚太精选': '亚太', '亚太': '亚太', '新兴市场': '亚太',
    '港股精选': '港股', '港股优选': '港股', '恒生指数': '港股',
    '德国': '欧洲',
    '石油能源': '商品', '大宗商品': '商品',
    '美国REITs': 'REITs', '标普REITs': 'REITs', '全球不动产': 'REITs',
    '亚洲债': '债券', '亚洲债券': '债券',
    '新能源车': '主题'
  };

  function getCategory(type) {
    return CATEGORY_MAP[type] || type || '其他';
  }

  // 计算各大类持仓市值
  var totalValue = 0;
  var categoryValues = {};
  var codeValues = {};

  portfolioData.holdings.forEach(function(h) {
    var value = h.totalShares * (h.latestNav || h.avgCost || 0);
    totalValue += value;
    codeValues[h.code] = value;

    // 查找基金类型
    var fundType = '未知';
    var rankedFund = result.ranked.find(function(r) { return r.code === h.code; });
    if (rankedFund) fundType = rankedFund.type || '未知';
    else if (h.type) fundType = h.type;

    var category = getCategory(fundType);
    categoryValues[category] = (categoryValues[category] || 0) + value;
  });

  if (totalValue === 0) return;

  // 对排名中的基金做持仓感知调整
  result.ranked.forEach(function(f) {
    var penalty = 0;
    var category = getCategory(f.type);

    // 1. 同大类占比过高 → 适度降分（不淘汰，只是少分配）
    var catWeight = ((categoryValues[category] || 0) / totalValue * 100);
    if (catWeight > 60) {
      penalty += 2 + (catWeight - 60) * 0.1; // 超60%扣2分，每多1%扣0.1
      f.reason = (f.reason || "") + " [" + category + "已占" + round1(catWeight) + "%]";
    } else if (catWeight > 40) {
      penalty += 1 + (catWeight - 40) * 0.05; // 超40%扣1分，轻度降权
      f.reason = (f.reason || "") + " [" + category + "占" + round1(catWeight) + "%]";
    }

    // 2. 已持有该基金 → 轻度降分
    var heldValue = codeValues[f.code] || 0;
    if (heldValue > 0) {
      var heldWeight = heldValue / totalValue * 100;
      if (heldWeight > 15) {
        penalty += 1.5;
        f.reason = (f.reason || "") + " [已持有" + round1(heldWeight) + "%]";
      } else if (heldWeight > 5) {
        penalty += 0.5;
      }
    }

    // 3. 同类已有3只以上 → 轻度提醒
    var catHeldCount = 0;
    for (var code in codeValues) {
      var heldFund = result.ranked.find(function(r) { return r.code === code; });
      if (heldFund && getCategory(heldFund.type) === category && codeValues[code] > 0) catHeldCount++;
    }
    if (catHeldCount >= 3) penalty += 1;

    if (penalty > 0) {
      f.score = round2(f.score - penalty);
      f.portfolioPenalty = round2(penalty);
    }
  });

  // 重新排序
  result.ranked.sort(function(a, b) { return b.score - a.score; });
  result.ranked.forEach(function(f, i) { f.rank = i + 1; });
}

/**
 * 分数加权分配：按评分高低分配预算，高分基金获得更高配额
 * 新增：同类型分配上限（避免重仓单一类型）
 */
function allocateByScore(budget, ranked, minPurchase) {
  if (!ranked || ranked.length === 0) return [];
  if (!minPurchase) minPurchase = 10;

  // 只分配正分基金
  var eligible = ranked.filter(function(f) { return f.score > 0; });
  if (eligible.length === 0) return [];

  // 按分数加权
  var totalScore = 0;
  eligible.forEach(function(f) {
    var baseScore = Math.min(eligible[0].score * 0.5, 5);
    f._allocWeight = Math.max(f.score - baseScore, 0.5);
    totalScore += f._allocWeight;
  });

  var allocations = [];
  var remaining = budget;
  var typeAllocated = {}; // 跟踪每种类型的已分配金额
  var TYPE_CAP_RATIO = 0.6; // 单类型最多占预算60%（强势方向可以多买）

  // 第一轮：按权重分配，带类型上限
  eligible.forEach(function(f) {
    var rawAlloc = budget * (f._allocWeight / totalScore);
    var cap = f.dailyLimit || 999999;

    // 类型上限：单类型最多40%预算
    var typeBudget = budget * TYPE_CAP_RATIO;
    var typeUsed = typeAllocated[f.type] || 0;
    var typeRemaining = Math.max(typeBudget - typeUsed, 0);

    var alloc = Math.min(rawAlloc, cap, remaining, typeRemaining);
    alloc = Math.floor(alloc);
    if (alloc < minPurchase) alloc = 0;

    f.allocated = alloc;
    remaining -= alloc;
    typeAllocated[f.type] = (typeAllocated[f.type] || 0) + alloc;

    allocations.push({
      code: f.code,
      name: f.name,
      type: f.type,
      score: f.score,
      allocated: alloc,
      dailyLimit: f.dailyLimit || 999999
    });
  });

  // 第二轮：把剩余预算分配给还没满的高分基金（仍受类型上限约束）
  if (remaining >= minPurchase) {
    allocations.sort(function(a, b) { return b.score - a.score; });
    for (var i = 0; i < allocations.length && remaining >= minPurchase; i++) {
      var a = allocations[i];
      var cap = a.dailyLimit || 999999;
      var typeBudget = budget * TYPE_CAP_RATIO;
      var typeUsed = typeAllocated[a.type] || 0;
      var typeRemaining = Math.max(typeBudget - typeUsed, 0);

      var canAdd = Math.min(cap - a.allocated, remaining, typeRemaining);
      canAdd = Math.floor(canAdd);
      if (canAdd >= 1) {
        a.allocated += canAdd;
        remaining -= canAdd;
        typeAllocated[a.type] = (typeAllocated[a.type] || 0) + canAdd;
      }
    }
  }

  // 清理临时字段
  eligible.forEach(function(f) { delete f._allocWeight; });

  return allocations.filter(function(a) { return a.allocated > 0; });
}

module.exports = { allocateDynamic, formatDynamicResult, scoreFund, WEIGHTS, rankTopN };