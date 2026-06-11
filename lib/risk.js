/**
 * 组合风险管理模块
 * 计算持仓相关性、组合夏普比率、最大回撤、健康度评分
 */

const { loadNavCache } = require("./utils");

// ========== 相关性计算 ==========

/**
 * 计算两组收益率序列的皮尔逊相关系数
 */
function pearsonCorrelation(x, y) {
  const n = Math.min(x.length, y.length);
  if (n < 10) return null;
  x = x.slice(0, n);
  y = y.slice(0, n);

  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0, sumY2 = 0;
  for (let i = 0; i < n; i++) {
    sumX += x[i];
    sumY += y[i];
    sumXY += x[i] * y[i];
    sumX2 += x[i] * x[i];
    sumY2 += y[i] * y[i];
  }
  const denom = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));
  if (denom === 0) return 0;
  return (n * sumXY - sumX * sumY) / denom;
}

/**
 * 从净值序列计算日收益率
 */
function calcDailyReturns(navHistory, days) {
  const navs = navHistory.slice(-days);
  const returns = [];
  for (let i = 1; i < navs.length; i++) {
    if (navs[i - 1].nav > 0) {
      returns.push((navs[i].nav - navs[i - 1].nav) / navs[i - 1].nav);
    }
  }
  return returns;
}

/**
 * 计算持仓基金间的相关性矩阵
 */
function calcCorrelationMatrix(holdings, days) {
  if (!days) days = 60;
  const navCache = loadNavCache();
  const codes = holdings.map(function(h) { return h.code; });
  const returnsMap = {};

  for (let i = 0; i < codes.length; i++) {
    const navs = navCache[codes[i]];
    if (navs && navs.length > days) {
      returnsMap[codes[i]] = calcDailyReturns(navs, days);
    }
  }

  const matrix = [];
  for (let j = 0; j < codes.length; j++) {
    const row = [];
    for (let k = 0; k < codes.length; k++) {
      if (j === k) {
        row.push(1);
      } else if (returnsMap[codes[j]] && returnsMap[codes[k]]) {
        const corr = pearsonCorrelation(returnsMap[codes[j]], returnsMap[codes[k]]);
        row.push(corr !== null ? Math.round(corr * 100) / 100 : null);
      } else {
        row.push(null);
      }
    }
    matrix.push(row);
  }

  return { codes: codes, matrix: matrix };
}

// ========== 组合指标 ==========

/**
 * 计算组合级别的风险指标
 */
function calcPortfolioRisk(holdings, navCache) {
  if (!navCache) navCache = loadNavCache();
  if (!holdings || holdings.length === 0) return null;

  // 计算每只基金的权重（按市值）
  let totalValue = 0;
  const holdingValues = [];
  for (let i = 0; i < holdings.length; i++) {
    const h = holdings[i];
    const navs = navCache[h.code];
    const latestNav = navs && navs.length > 0 ? navs[navs.length - 1].nav : null;
    const value = h.totalShares > 0 && latestNav ? h.totalShares * latestNav : h.totalAmount;
    holdingValues.push({ code: h.code, name: h.name, value: value, type: h.type || "" });
    totalValue += value;
  }

  if (totalValue <= 0) return null;

  // 权重
  for (let w = 0; w < holdingValues.length; w++) {
    holdingValues[w].weight = holdingValues[w].value / totalValue;
  }

  // 计算组合日收益率序列（加权平均）
  const allReturns = [];
  for (let r = 0; r < holdingValues.length; r++) {
    const navs = navCache[holdingValues[r].code];
    if (navs && navs.length > 60) {
      allReturns.push({ code: holdingValues[r].code, returns: calcDailyReturns(navs, 60), weight: holdingValues[r].weight });
    }
  }

  if (allReturns.length === 0) return null;

  // 组合收益率 = 加权平均
  const minLen = Math.min.apply(null, allReturns.map(function(r) { return r.returns.length; }));
  const portfolioReturns = [];
  for (let d = 0; d < minLen; d++) {
    let weightedReturn = 0;
    for (let g = 0; g < allReturns.length; g++) {
      weightedReturn += allReturns[g].returns[d] * allReturns[g].weight;
    }
    portfolioReturns.push(weightedReturn);
  }

  // 组合夏普比率
  const avgRet = portfolioReturns.reduce(function(s, r) { return s + r; }, 0) / portfolioReturns.length;
  const variance = portfolioReturns.reduce(function(s, r) { return s + (r - avgRet) * (r - avgRet); }, 0) / portfolioReturns.length;
  const stdDev = Math.sqrt(variance);
  const annualReturn = avgRet * 250;
  const annualVol = stdDev * Math.sqrt(250);
  const sharpe = annualVol > 0 ? (annualReturn - 0.02) / annualVol : 0;

  // 组合最大回撤
  let cumReturn = 1;
  let peak = 1;
  let maxDrawdown = 0;
  for (let m = 0; m < portfolioReturns.length; m++) {
    cumReturn *= (1 + portfolioReturns[m]);
    if (cumReturn > peak) peak = cumReturn;
    const dd = (cumReturn - peak) / peak;
    if (dd < maxDrawdown) maxDrawdown = dd;
  }

  // 集中度分析
  const typeWeights = {};
  for (let t = 0; t < holdingValues.length; t++) {
    const type = holdingValues[t].type || "其他";
    typeWeights[type] = (typeWeights[type] || 0) + holdingValues[t].weight;
  }
  const maxTypeWeight = Math.max.apply(null, Object.values(typeWeights));
  const dominantType = Object.keys(typeWeights).reduce(function(a, b) { return typeWeights[a] > typeWeights[b] ? a : b; });

  // 健康度评分 (0-100)
  let healthScore = 50; // 基础分

  // 分散度加分（最高25分）
  if (holdings.length >= 5) healthScore += 15;
  else if (holdings.length >= 3) healthScore += 10;
  else if (holdings.length >= 2) healthScore += 5;

  // 集中度扣分
  if (maxTypeWeight > 0.8) healthScore -= 15;
  else if (maxTypeWeight > 0.6) healthScore -= 8;
  else healthScore += 10;

  // 夏普比率加分（最高15分）
  if (sharpe > 1.5) healthScore += 15;
  else if (sharpe > 1.0) healthScore += 10;
  else if (sharpe > 0.5) healthScore += 5;
  else healthScore -= 5;

  // 回撤控制加分（最高10分）
  if (maxDrawdown > -0.1) healthScore += 10;
  else if (maxDrawdown > -0.2) healthScore += 5;
  else healthScore -= 5;

  // 相关性扣分（如果持仓基金高度相关）
  try {
    const corr = calcCorrelationMatrix(holdings, 60);
    if (corr && corr.matrix) {
      let highCorrCount = 0;
      for (let ci = 0; ci < corr.matrix.length; ci++) {
        for (let cj = ci + 1; cj < corr.matrix[ci].length; cj++) {
          if (corr.matrix[ci][cj] !== null && corr.matrix[ci][cj] > 0.85) {
            highCorrCount++;
          }
        }
      }
      if (highCorrCount >= 3) healthScore -= 12;
      else if (highCorrCount >= 2) healthScore -= 8;
      else if (highCorrCount >= 1) healthScore -= 4;
    }
  } catch(e) { /* 相关性计算失败不影响健康度 */ }

  healthScore = Math.max(0, Math.min(100, healthScore));

  return {
    holdingCount: holdings.length,
    totalValue: Math.round(totalValue * 100) / 100,
    portfolioSharpe: Math.round(sharpe * 100) / 100,
    portfolioMaxDrawdown: Math.round(maxDrawdown * 10000) / 100,
    portfolioAnnualReturn: Math.round(annualReturn * 10000) / 100,
    portfolioAnnualVol: Math.round(annualVol * 10000) / 100,
    healthScore: healthScore,
    concentration: {
      dominantType: dominantType,
      dominantWeight: Math.round(maxTypeWeight * 100),
      typeWeights: Object.keys(typeWeights).map(function(k) { return { type: k, weight: Math.round(typeWeights[k] * 100) }; }).sort(function(a, b) { return b.weight - a.weight; })
    },
    holdings: holdingValues.map(function(h) { return { code: h.code, name: h.name, weight: Math.round(h.weight * 100) }; })
  };
}

/**
 * 格式化组合风险报告（文本）
 */
function formatRiskReport(riskResult, correlationResult) {
  if (!riskResult) return "[风控] 暂无持仓数据，无法计算风险指标。";

  const lines = [];
  lines.push("=== 组合风险分析 ===");
  lines.push("");

  // 健康度
  const healthEmoji = riskResult.healthScore >= 80 ? "\ud83d\udfe2" : (riskResult.healthScore >= 60 ? "\ud83d\udfe1" : "\ud83d\udd34");
  lines.push(healthEmoji + " 组合健康度: " + riskResult.healthScore + "/100");
  lines.push("");

  // 组合指标
  lines.push("--- 组合指标 ---");
  lines.push("夏普比率: " + riskResult.portfolioSharpe);
  lines.push("最大回撤: " + riskResult.portfolioMaxDrawdown + "%");
  lines.push("年化收益: " + riskResult.portfolioAnnualReturn + "%");
  lines.push("年化波动: " + riskResult.portfolioAnnualVol + "%");
  lines.push("");

  // 集中度
  lines.push("--- 持仓集中度 ---");
  lines.push("主要类型: " + riskResult.concentration.dominantType + " (" + riskResult.concentration.dominantWeight + "%)");
  if (riskResult.concentration.dominantWeight > 70) {
    lines.push("\u26a0\ufe0f 警告: 持仓过于集中在" + riskResult.concentration.dominantType + "，建议分散到其他类型");
  }
  lines.push("类型分布:");
  for (let i = 0; i < riskResult.concentration.typeWeights.length; i++) {
    const tw = riskResult.concentration.typeWeights[i];
    lines.push("  " + tw.type + ": " + tw.weight + "%");
  }
  lines.push("");

  // 相关性矩阵
  if (correlationResult && correlationResult.matrix.length > 1) {
    lines.push("--- 基金相关性 ---");
    for (let j = 0; j < correlationResult.codes.length; j++) {
      let corrLine = riskResult.holdings[j] ? riskResult.holdings[j].name.substring(0, 10) : correlationResult.codes[j];
      for (let k = 0; k < correlationResult.matrix[j].length; k++) {
        const val = correlationResult.matrix[j][k];
        corrLine += (val !== null ? " " + val.toFixed(2) : " N/A");
      }
      lines.push(corrLine);
    }
    lines.push("");

    // 高相关性警告
    const highCorrPairs = [];
    for (let ci = 0; ci < correlationResult.matrix.length; ci++) {
      for (let cj = ci + 1; cj < correlationResult.matrix[ci].length; cj++) {
        if (correlationResult.matrix[ci][cj] !== null && correlationResult.matrix[ci][cj] > 0.85) {
          highCorrPairs.push({
            a: riskResult.holdings[ci] ? riskResult.holdings[ci].name : correlationResult.codes[ci],
            b: riskResult.holdings[cj] ? riskResult.holdings[cj].name : correlationResult.codes[cj],
            corr: correlationResult.matrix[ci][cj]
          });
        }
      }
    }
    if (highCorrPairs.length > 0) {
      lines.push("\u26a0\ufe0f 高相关性基金 (" + highCorrPairs.length + "对):");
      for (let hi = 0; hi < highCorrPairs.length; hi++) {
        lines.push("  " + highCorrPairs[hi].a + " \u2194 " + highCorrPairs[hi].b + " (" + highCorrPairs[hi].corr + ")");
      }
      lines.push("建议: 考虑用低相关性基金替换部分高相关性持仓");
    }
  }

  return lines.join("\n");
}

// ========== 导出 ==========

module.exports = {
  calcCorrelationMatrix: calcCorrelationMatrix,
  calcPortfolioRisk: calcPortfolioRisk,
  formatRiskReport: formatRiskReport,
  pearsonCorrelation: pearsonCorrelation
};
