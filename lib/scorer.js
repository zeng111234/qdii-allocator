/**
 * 基金评分系统
 * 包含评分权重、评分函数、排名策略和轮动机制
 */

const { scoreFundExternalSignal } = require("./external-signals");
const { round1, round2 } = require("./utils");

/**
 * 评分权重体系（面向A类长线投资）
 * 核心逻辑：长期表现 > 短期信号
 */
const WEIGHTS = {
  base: 10,
  // 长期因子（核心，但权重平衡）
  yearReturn: 0.2,          // 1年收益率（降低权重避免过度追涨）
  threeYearReturn: 0.15,    // 3年累计收益（API SYL_3N，长期验证）
  sharpeRatio: 4.5,         // 夏普比率（提高权重，风险调整收益更重要）
  maxDrawdown: 0.15,        // 最大回撤惩罚（提高权重）
  longTermBull: 3.0,        // 长期牛市趋势加分
  longTermBear: -4.0,       // 长期熊市趋势扣分
  stabilityBonus: 2.5,      // 稳定收益加分（提高权重）

  // 中期因子
  drawdown: 2.0,            // 近期回撤（提高权重，下跌时买入更有价值）
  maDeviation: 1.5,         // MA10偏离（提高权重）
  trendBonus: 2.0,          // 多头排列加分
  trendPenalty: -2.5,       // 空头排列扣分
  momentumReversal: 2.0,    // 连续下跌后阳线反弹

  // 短期因子（低权重）
  recent5Change: -0.3,      // 5日涨跌（降低权重，短期波动不应主导）
  volatility: -0.5,         // 波动率惩罚（提高权重）

  // 辅助因子
  historicalSuccess: 1.0,   // 历史推荐成功率
  feePenalty: -0.8,         // 费率惩罚
  rotationPenalty: -0.8,    // 连续推荐惩罚（降低权重避免过度轮换）
  premiumPenalty: -3.0,     // 溢价>3%惩罚
  scarcityBonus: 2.0,       // 限购加分（降低权重，限购不等于品质）
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

  let score = WEIGHTS.base;
  const reasons = [];

  // API获取失败时使用默认值继续评分（不排除）
  if (fund._purchaseStatus === "unknown") {
    reasons.push("\u9650\u8d2dAPI\u5931\u8d25\uff0c\u4f7f\u7528\u9ed8\u8ba4\u503c");
  }

  // ========== 长期因子（核心） ==========

  // 1年收益率（优先使用API数据 SYL_1N）
  const yr = (premiumInfo && premiumInfo.yearReturn !== null && premiumInfo.yearReturn !== undefined) ? premiumInfo.yearReturn : (indicators.annualizedReturn !== null ? indicators.annualizedReturn : indicators.yearReturn);
  if (yr && yr !== 0) {
    const yrScore = yr * WEIGHTS.yearReturn;
    score += yrScore;
    if (Math.abs(yrScore) > 0.3) {
      if (yrScore > 0) reasons.push("1\u5e74\u6da8" + yr + "%\u52a0" + round1(yrScore) + "\u5206");
      else reasons.push("1\u5e74\u8dcc" + Math.abs(yr) + "%\u6263" + round1(Math.abs(yrScore)) + "\u5206");
    }
  }

  // 3年累计收益（优先使用API数据 SYL_3N）
  const y3 = (premiumInfo && premiumInfo.threeYearReturn !== null && premiumInfo.threeYearReturn !== undefined) ? premiumInfo.threeYearReturn : indicators.threeYearReturn;
  if (y3 && y3 !== 0) {
    const y3Score = (y3 / 3) * WEIGHTS.threeYearReturn;
    score += y3Score;
    if (Math.abs(y3Score) > 0.3) {
      if (y3Score > 0) reasons.push("3\u5e74\u7d2f\u8ba1" + y3 + "%\u52a0" + round1(y3Score) + "\u5206");
      else reasons.push("3\u5e74\u7d2f\u8ba1" + Math.abs(y3) + "%\u6263" + round1(Math.abs(y3Score)) + "\u5206");
    }
  }

  // 夏普比率（关键指标 - 风险调整后收益）
  if (indicators.sharpeRatio !== null) {
    const sharpeScore = indicators.sharpeRatio * WEIGHTS.sharpeRatio;
    score += sharpeScore;
    if (Math.abs(sharpeScore) > 0.5) {
      if (sharpeScore > 0) reasons.push("\u590f\u666e" + indicators.sharpeRatio + "\u52a0" + round1(sharpeScore) + "\u5206");
      else reasons.push("\u590f\u666e" + indicators.sharpeRatio + "\u6263" + round1(Math.abs(sharpeScore)) + "\u5206");
    }
  }

  // 最大回撤惩罚
  if (indicators.maxDrawdown !== null && indicators.maxDrawdown < 0) {
    const ddPenalty = Math.abs(indicators.maxDrawdown) * WEIGHTS.maxDrawdown;
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
  const drawdownScore = indicators.drawdown * WEIGHTS.drawdown;
  score += drawdownScore;
  if (drawdownScore > 0.5) reasons.push("\u56de\u64a4" + indicators.drawdown + "%\u52a0" + round1(drawdownScore) + "\u5206");
  else if (drawdownScore < -0.5) reasons.push("\u8fd1\u671f\u65b0\u9ad8\u6263" + round1(Math.abs(drawdownScore)) + "\u5206");

  // MA偏离因子
  const maScore = indicators.maDeviation * WEIGHTS.maDeviation;
  score += maScore;
  if (maScore > 0.5) reasons.push("\u4f4e\u4e8eMA10\u52a0" + round1(maScore) + "\u5206");
  else if (maScore < -0.5) reasons.push("\u9ad8\u4e8eMA10\u6263" + round1(Math.abs(maScore)) + "\u5206");

  // 趋势强度（多头/空头排列）
  if (indicators.navs && indicators.navs.length >= 20) {
    const navs = indicators.navs;
    const calcMa = function(arr, n) {
      const slice = arr.slice(-n);
      return slice.reduce(function(a,b){return a+b;},0) / slice.length;
    };
    const ma5Val = calcMa(navs, 5);
    const ma10Val = calcMa(navs, 10);
    const ma20Val = calcMa(navs, 20);

    if (ma5Val > ma10Val && ma10Val > ma20Val) {
      score += WEIGHTS.trendBonus;
      reasons.push("\u591a\u5934\u6392\u5217+" + WEIGHTS.trendBonus + "\u5206");
    } else if (ma5Val < ma10Val && ma10Val < ma20Val) {
      score += WEIGHTS.trendPenalty;
      reasons.push("\u7a7a\u5934\u6392\u5217" + WEIGHTS.trendPenalty + "\u5206");
    }

    // 动量反转信号
    if (navs.length >= 5) {
      let last3Down = true;
      const todayUp = navs[navs.length-1] > navs[navs.length-2];
      for (let k = navs.length - 4; k < navs.length - 1; k++) {
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
  const change5Score = indicators.recent5Change * WEIGHTS.recent5Change;
  score += change5Score;
  if (change5Score < -1) reasons.push("5\u65e5\u6da8" + indicators.recent5Change + "%\u6263" + round1(Math.abs(change5Score)) + "\u5206");

  // 波动率
  const volScore = indicators.volatility * WEIGHTS.volatility;
  score += volScore;
  if (volScore < -0.5) reasons.push("\u6ce2\u52a8" + indicators.volatility + "%\u6263" + round1(Math.abs(volScore)) + "\u5206");

  // ========== 辅助因子 ==========

  // 历史推荐成功率
  if (historyContext && historyContext.successRate !== undefined) {
    const histBonus = historyContext.successRate * WEIGHTS.historicalSuccess;
    score += histBonus;
    if (histBonus > 0.3) reasons.push("\u5386\u53f2\u6210\u529f\u7387" + round1(historyContext.successRate * 100) + "%\u52a0" + round1(histBonus) + "\u5206");
  }

  // 费率惩罚
  if (fund.feeRate && fund.feeRate > 0) {
    const feeScore = fund.feeRate * WEIGHTS.feePenalty;
    score += feeScore;
    if (Math.abs(feeScore) > 0.3) reasons.push("\u8d39\u7387" + fund.feeRate + "%\u6263" + round1(Math.abs(feeScore)) + "\u5206");
  }

  // 轮换惩罚
  if (recentPicks && recentPicks[fund.code]) {
    const consecutiveDays = recentPicks[fund.code];
    const rotPenalty = consecutiveDays * WEIGHTS.rotationPenalty;
    score += rotPenalty;
    if (consecutiveDays >= 1) reasons.push("\u8fde\u7eed\u63a8\u8350" + consecutiveDays + "\u5929\u6263" + round1(Math.abs(rotPenalty)) + "\u5206");
  }

  // 稳定性加分：波动率低 + 正收益 = 稳定赚钱
  if (yr && yr > 0 && indicators.volatility < 2.0) {
    const stabScore = WEIGHTS.stabilityBonus * (2.0 - indicators.volatility) / 2.0;
    score += stabScore;
    if (stabScore > 0.5) reasons.push("\u7a33\u5b9a\u6536\u76ca+" + round1(stabScore) + "\u5206");
  }

  // 溢价率惩罚
  if (premiumInfo && premiumInfo.premiumRate > 3) {
    score += WEIGHTS.premiumPenalty;
    reasons.push("\u6ea2\u4ef7" + premiumInfo.premiumRate + "%\u6263" + Math.abs(WEIGHTS.premiumPenalty) + "\u5206");
  }

  // 稀缺加分（限购越严说明越赚钱）- 适度加分
  if (fund._purchaseStatus === "limited" && fund.dailyLimit > 0) {
    let scarceScore = 0;
    if (fund.dailyLimit <= 10) {
      scarceScore = 3;
      reasons.push("\u9650\u8d2d" + fund.dailyLimit + "\u5143\u7a00\u7f3a+" + scarceScore + "\u5206");
    } else if (fund.dailyLimit <= 50) {
      scarceScore = 2;
      reasons.push("\u9650\u8d2d" + fund.dailyLimit + "\u5143\u7a00\u7f3a+" + scarceScore + "\u5206");
    } else if (fund.dailyLimit <= 100) {
      scarceScore = 1;
      reasons.push("\u9650\u8d2d" + fund.dailyLimit + "\u5143\u52a0\u5206+" + scarceScore + "\u5206");
    }
    score += scarceScore;
  }

  const externalSignal = scoreFundExternalSignal(fund, externalSignals, externalSignalMaxScore || 3);
  if (externalSignal.score !== 0) {
    score += externalSignal.score;
    let externalText = "External signal " + (externalSignal.score > 0 ? "+" : "") + externalSignal.score + " pts";
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
  const available = scoredFunds.filter(f => f.score > 0);
  if (available.length === 0) return [];

  // 按得分降序排列
  available.sort(function(a,b) { return b.score - a.score; });

  // 取TopN（不做同类型去重，因为用户要看完整排名）
  const top = available.slice(0, topN);

  // 标注排名
  top.forEach(function(item, idx) {
    item.rank = idx + 1;
  });

  return top;
}

/**
 * 轮动机制：在同档基金中优先推荐未被连续推荐过的
 * 避免同一只基金连续多天被推荐
 */
function applyRotation(available, recentPicks, topN) {
  if (!recentPicks || available.length <= topN) return available;

  // 按得分排序
  available.sort(function(a,b) { return b.score - a.score; });

  // 找到得分相近的组（差距<2分的基金视为同档）
  const groups = [];
  let currentGroup = [available[0]];
  for (let i = 1; i < available.length; i++) {
    if (available[i].score >= currentGroup[currentGroup.length - 1].score - 2) {
      currentGroup.push(available[i]);
    } else {
      groups.push(currentGroup);
      currentGroup = [available[i]];
    }
  }
  if (currentGroup.length > 0) groups.push(currentGroup);

  // 对每组内部做轮动：连续推荐>=2天的基金降权，让同组其他基金上位
  let result = [];
  for (let g = 0; g < groups.length; g++) {
    const group = groups[g];
    // 在组内，被连续推荐多次的放后面
    group.sort(function(a, b) {
      const aPenalty = (recentPicks[a.code] || 0) >= 2 ? 100 : 0;
      const bPenalty = (recentPicks[b.code] || 0) >= 2 ? 100 : 0;
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

module.exports = { WEIGHTS, scoreFund, rankTopN, applyRotation };
