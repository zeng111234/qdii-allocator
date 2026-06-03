const { getFundNavHistory, calcIndicators, getFundBasicInfo } = require("./fund-data");
const fs = require("fs");
const path = require("path");

const HISTORY_FILE = path.join(__dirname, "..", "data", "history.json");

/**
 * 评分权重体系（面向A类长线投资）
 * 核心逻辑：长期表现 > 短期信号
 */
var WEIGHTS = {
  base: 10,
  // 长期因子（权重高）
  annualizedReturn: 1.5,    // 年化收益率（越高越好）
  threeYearReturn: 0.8,     // 3年累计收益
  sharpeRatio: 3.0,         // 夏普比率（风险调整收益，越高越好）
  maxDrawdown: 0.15,        // 最大回撤惩罚（回撤越大扣分越多，注意是负数）
  longTermBull: 3.0,        // 长期牛市趋势加分
  longTermBear: -4.0,       // 长期熊市趋势扣分
  
  // 中期因子
  drawdown: 1.5,            // 近期回撤（跌幅越大加分越多）
  maDeviation: 1.2,         // MA10偏离（低于均线加分）
  trendBonus: 2.0,          // 多头排列加分（MA5>MA10>MA20）
  trendPenalty: -2.5,       // 空头排列扣分（MA5<MA10<MA20）
  momentumReversal: 2.0,    // 连续下跌后阳线反弹
  
  // 短期因子（低权重）
  recent5Change: -0.5,      // 5日涨跌（短期涨太多扣分）
  recent10Change: -0.3,     // 10日涨跌
  volatility: -0.4,         // 波动率惩罚
  
  // 辅助因子
  historicalSuccess: 1.0,   // 历史推荐成功率
  feePenalty: -0.8,         // 费率惩罚
  rotationPenalty: -1.0,    // 连续推荐惩罚
  premiumPenalty: -3.0,     // 溢价>3%惩罚
  scarcityBonus: 1.5,       // 限购稀缺加分
  unknownPenalty: -3.0,     // 信息未知惩罚
  suspended: -999
};

function scoreFund(fund, indicators, historyContext, recentPicks, premiumInfo) {
  if (fund.status !== "active" || fund.dailyLimit <= 0) {
    return { score: WEIGHTS.suspended, reason: fund.status === "suspended" ? "\u6682\u505c\u7533\u8d2d" : "\u9650\u989d\u4e3a0", indicators };
  }

  // API获取失败时降权
  if (fund._purchaseStatus === "unknown") {
    return { score: WEIGHTS.unknownPenalty, reason: "\u9650\u8d2d\u4fe1\u606f\u672a\u77e5(\u964d\u6743)", indicators };
  }

  // 数据不足直接排除
  if (indicators.error || !indicators.dataPoints || indicators.dataPoints < 60) {
    return { score: -1, reason: "\u6570\u636e\u4e0d\u8db3\uff08" + (indicators.dataPoints || 0) + "\u65e5\uff09\uff0c\u6392\u9664\u63a8\u8350", indicators };
  }

  var score = WEIGHTS.base;
  var reasons = [];

  // ========== 长期因子（核心） ==========

  // 年化收益率
  if (indicators.annualizedReturn !== null) {
    var annScore = indicators.annualizedReturn * WEIGHTS.annualizedReturn;
    score += annScore;
    if (Math.abs(annScore) > 1) {
      if (annScore > 0) reasons.push("\u5e74\u5316" + indicators.annualizedReturn + "%\u52a0" + round1(annScore) + "\u5206");
      else reasons.push("\u5e74\u5316" + Math.abs(indicators.annualizedReturn) + "%\u6263" + round1(Math.abs(annScore)) + "\u5206");
    }
  }

  // 3年累计收益
  if (indicators.threeYearReturn !== null) {
    var y3Score = (indicators.threeYearReturn / 3) * WEIGHTS.threeYearReturn;
    score += y3Score;
    if (Math.abs(y3Score) > 0.5) {
      if (y3Score > 0) reasons.push("3\u5e74\u7d2f\u8ba1" + indicators.threeYearReturn + "%\u52a0" + round1(y3Score) + "\u5206");
      else reasons.push("3\u5e74\u7d2f\u8ba1" + Math.abs(indicators.threeYearReturn) + "%\u6263" + round1(Math.abs(y3Score)) + "\u5206");
    }
  }

  // 夏普比率（关键指标）
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

  // 限购惩罚（限大额降权）
  if (fund._purchaseStatus === "limited") {
    score *= 0.7;
    reasons.push("\u9650\u5927\u989d\uff0c\u964d\u674330%");
  }

  // 溢价率惩罚
  if (premiumInfo && premiumInfo.premiumRate > 3) {
    score += WEIGHTS.premiumPenalty;
    reasons.push("\u6ea2\u4ef7" + premiumInfo.premiumRate + "%\u6263" + Math.abs(WEIGHTS.premiumPenalty) + "\u5206");
  }

  // 稀缺加分
  if (fund._purchaseStatus === "limited" && fund.dailyLimit > 0) {
    var scarceScore = 0;
    if (fund.dailyLimit <= 10) {
      scarceScore = WEIGHTS.scarcityBonus * 2;
      reasons.push("\u9650\u8d2d" + fund.dailyLimit + "\u5143\u7a00\u7f3a+" + round1(scarceScore) + "\u5206");
    } else if (fund.dailyLimit <= 50) {
      scarceScore = WEIGHTS.scarcityBonus;
      reasons.push("\u9650\u8d2d" + fund.dailyLimit + "\u5143\u7a00\u7f3a+" + round1(scarceScore) + "\u5206");
    }
    score += scarceScore;
  }

  score = Math.max(0.1, score);
  return { score: round2(score), reason: reasons.length > 0 ? reasons.join("\uff0c") : "\u6b63\u5e38\u8bc4\u5206", indicators };
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
  var lookbackDays = config.lookbackDays || 250; // 默认1年（API限制pageSize=20）
  var topN = config.topN || 10;
  var minPurchase = config.minPurchase || 10;
  var enableHistory = config.enableHistory !== false;

  console.log("[\u52a8\u6001\u7b56\u7565] \u83b7\u53d6\u57fa\u91d1\u6570\u636e\u548c\u9650\u8d2d\u4fe1\u606f...");
  console.log("[\u52a8\u6001\u7b56\u7565] lookback=" + lookbackDays + "\u5929\uff08\u7ea6" + Math.round(lookbackDays/250) + "\u5e74\uff09\u6570\u636e\uff0cTop" + topN);

  // Step 1: 获取限购+溢价+收益率信息
  var purchaseInfoMap = {};
  var premiumInfoMap = {};
  try {
    var basicResults = await Promise.all(funds.map(async fund => {
      var info = await getFundBasicInfo(fund.code);
      return { code: fund.code, info: info };
    }));
    for (var i = 0; i < basicResults.length; i++) {
      purchaseInfoMap[basicResults[i].code] = basicResults[i].info;
      premiumInfoMap[basicResults[i].code] = {
        premiumRate: basicResults[i].info.premiumRate,
        nav: basicResults[i].info.nav,
        realNav: basicResults[i].info.realNav,
        yearReturn: basicResults[i].info.yearReturn,
        threeYearReturn: basicResults[i].info.threeYearReturn
      };
    }
    var highPremium = Object.entries(premiumInfoMap).filter(function(e) { return e[1].premiumRate > 3; });
    if (highPremium.length > 0) {
      console.log("[\u6ea2\u4ef7] " + highPremium.length + "\u53ea\u57fa\u91d1\u6ea2\u4ef7>3%\uff0c\u5df2\u964d\u6743");
    }
  } catch (err) {
    console.warn("[\u52a8\u6001\u7b56\u7565] \u83b7\u53d6\u57fa\u91d1\u4fe1\u606f\u5931\u8d25\uff0c\u4f7f\u7528\u9ed8\u8ba4\u503c:", err.message);
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

  // Step 4: 获取K线数据并评分（3年数据）
  console.log("[\u52a8\u6001\u7b56\u7565] \u83b7\u53d6" + updatedFunds.length + "\u53ea\u57fa\u91d1K\u7ebf\u6570\u636e (" + lookbackDays + "\u5929)...");
  var fundDataPairs = await Promise.all(updatedFunds.map(async fund => {
    var history = await getFundNavHistory(fund.code, lookbackDays);
    var indicators = calcIndicators(history);
    if (history.length > 0) {
      indicators.navs = history.map(function(d) { return d.nav; });
    }
    return { fund, history, indicators };
  }));

  var scored = fundDataPairs.map(({ fund, indicators }) => {
    var histCtx = historyContextMap[fund.code] || null;
    var recentPicksMap = getRecentPicks();
    var premiumData = premiumInfoMap[fund.code] || null;
    // 优先使用API的3年收益率，回退到K线计算
    if (premiumData && premiumData.threeYearReturn && !indicators.threeYearReturn) {
      indicators.threeYearReturn = premiumData.threeYearReturn;
      // 根据3年收益率推算年化
      if (!indicators.annualizedReturn) {
        indicators.annualizedReturn = Math.round((Math.pow(1 + premiumData.threeYearReturn / 100, 1/3) - 1) * 10000) / 100;
      }
    }
    var result = scoreFund(fund, indicators, histCtx, recentPicksMap, premiumData);
    return { ...fund, ...result, yearReturn: premiumData ? premiumData.yearReturn : null };
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

  var ranked = rankTopN(available, topN, minPurchase);
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

  var result = {
    budget, strategy: "dynamic",
    budgetInfo: budgetInfo,
    strategyName: "\u667a\u80fd\u52a8\u6001\u7b56\u7565(Top" + topN + " \u6392\u540d)",
    date: new Date().toLocaleDateString("zh-CN", { timeZone: "Asia/Shanghai" }),
    ranked: ranked,
    suspended: suspended,
    dataMissing: dataMissing,
    totalRanked: totalFunds,
    allAvailable: available.length,
    totalPool: scored.length,
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
  lines.push("\u6570\u636e\u6c60\uff1a" + result.totalPool + "\u53ea\u57fa\u91d1\uff0c\u5176\u4e2d" + result.allAvailable + "\u53ea\u6709\u6548\u6570\u636e");
  lines.push("");

  if (result.ranked && result.ranked.length > 0) {
    lines.push("\u2605 Top" + result.ranked.length + " \u63a8\u8350\u57fa\u91d1\u6392\u540d\uff1a");
    lines.push("");
    for (var i = 0; i < result.ranked.length; i++) {
      var f = result.ranked[i];
      var ind = f.indicators || {};
      var trendEmoji = "";
      if (ind.longTermTrend === "bull") trendEmoji = "\ud83d\udfe2"; // green
      else if (ind.longTermTrend === "bear") trendEmoji = "\ud83d\udd34"; // red
      else trendEmoji = "\ud83d\udfe1"; // yellow

      lines.push(f.rank + ". " + f.name + "(" + f.code + ") " + trendEmoji);
      lines.push("   \u5f97\u5206: " + f.score + " | \u7c7b\u578b: " + (f.type || "-") + " | \u9650\u8d2d: " + (f.dailyLimit || "-") + "\u5143");
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

function round1(n) { return Math.round(n * 10) / 10; }
function round2(n) { return Math.round(n * 100) / 100; }

module.exports = { allocateDynamic, formatDynamicResult, scoreFund, WEIGHTS, rankTopN };