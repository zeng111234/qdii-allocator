/**
 * FactorEngine Node.js 版本
 * 与前端 FactorEngine 逻辑完全一致，用于统一排名
 */

// 工具函数
function tsMean(arr, n) {
  if (arr.length < n) return null;
  var sum = 0;
  for (var i = arr.length - n; i < arr.length; i++) sum += arr[i];
  return sum / n;
}

function tsStd(arr, n) {
  if (arr.length < n) return null;
  var slice = arr.slice(-n);
  var mean = slice.reduce(function(s, v) { return s + v; }, 0) / n;
  var sumSq = slice.reduce(function(s, v) { return s + (v - mean) * (v - mean); }, 0);
  return Math.sqrt(sumSq / (n - 1));
}

function tsMax(arr, n) {
  var max = -Infinity;
  for (var i = Math.max(0, arr.length - n); i < arr.length; i++) {
    if (arr[i] > max) max = arr[i];
  }
  return max;
}

function tsMin(arr, n) {
  var min = Infinity;
  for (var i = Math.max(0, arr.length - n); i < arr.length; i++) {
    if (arr[i] < min) min = arr[i];
  }
  return min;
}

/**
 * 计算单个基金的所有因子原始分数
 */
function computeAll(navArr, fundMeta, marketTemperature, newsData, externalSignalsData) {
  var scores = {};

  // 1. 波动率
  scores.volatility_hist = computeVolatility(navArr);

  // 2. 均线排列
  scores.trend_alignment = computeTrendAlignment(navArr);

  // 3. 回撤深度
  scores.drawdown_depth = computeDrawdownDepth(navArr);

  // 4. 夏普比率
  scores.quality_sharpe = computeSharpe(navArr);

  // 5. 近期加权收益
  scores.quality_decay_ret = computeDecayReturn(navArr);

  // 6. 限购稀缺度
  scores.scarce_limit = 50; // 禁用

  // 7. 估值温度
  scores.valuation_temp = computeValuationTemp(navArr, fundMeta, marketTemperature);

  // 8. 费率评估
  scores.fee_penalty = computeFeePenalty(fundMeta);

  // 9. 120日收益
  scores.momentum_120d = computeMomentum120d(navArr);

  // 10. 1年收益
  scores.momentum_1y = computeMomentum1y(navArr);

  // 11. 趋势强度
  scores.trend_strength = computeTrendStrength(navArr);

  // 12. 分散度
  scores.portfolio_diversity = 50; // 默认值，需要外部传入

  // 13. 高点距离
  scores.peak_penalty = computePeakPenalty(navArr);

  return scores;
}

function computeVolatility(navArr) {
  if (!navArr || navArr.length < 20) return null;
  var returns = [];
  for (var i = navArr.length - 21; i < navArr.length; i++) {
    if (navArr[i - 1] > 0) returns.push(navArr[i] / navArr[i - 1] - 1);
  }
  if (returns.length < 10) return null;
  var std = tsStd(returns, returns.length);
  if (std === null) return null;
  return Math.round(std * Math.sqrt(252) * 100 * 100) / 100;
}

function computeTrendAlignment(navArr) {
  if (!navArr || navArr.length < 20) return null;
  var ma5 = tsMean(navArr, 5);
  var ma10 = tsMean(navArr, 10);
  var ma20 = tsMean(navArr, 20);
  var ma60 = navArr.length >= 65 ? tsMean(navArr, 60) : ma20;
  if (!ma5 || !ma10 || !ma20 || !ma60) return null;
  var score = 0;
  if (ma5 > ma10) score++; else score--;
  if (ma10 > ma20) score++; else score--;
  if (ma20 > ma60) score++; else score--;
  var latest = navArr[navArr.length - 1];
  if (latest > ma20) score += 0.5; else score -= 0.5;
  return Math.round(score * 100) / 100;
}

function computeDrawdownDepth(navArr) {
  if (!navArr || navArr.length < 10) return null;
  var peak = -Infinity;
  for (var i = 0; i < navArr.length; i++) {
    if (navArr[i] > peak) peak = navArr[i];
  }
  if (peak <= 0) return null;
  var currentDD = (navArr[navArr.length - 1] - peak) / peak * 100;
  return Math.round(currentDD * 100) / 100;
}

function computeSharpe(navArr) {
  if (!navArr || navArr.length < 15) return null;
  var returns = [];
  for (var i = 1; i < navArr.length; i++) {
    if (navArr[i - 1] > 0) returns.push(navArr[i] / navArr[i - 1] - 1);
  }
  if (returns.length < 20) return null;
  var sum = 0;
  for (var j = 0; j < returns.length; j++) sum += returns[j];
  var mean = sum / returns.length;
  var sumSq = 0;
  for (var j = 0; j < returns.length; j++) {
    var d = returns[j] - mean;
    sumSq += d * d;
  }
  var std = Math.sqrt(sumSq / (returns.length - 1));
  if (std < 1e-10) return 0;
  var rfDaily = 0.02 / 252;
  var sharpe = (mean - rfDaily) / std * Math.sqrt(252);
  return Math.round(sharpe * 100) / 100;
}

function computeDecayReturn(navArr) {
  if (!navArr || navArr.length < 20) return null;
  var n = 20;
  var weightedSum = 0, weightTotal = 0;
  for (var i = navArr.length - n; i < navArr.length; i++) {
    var w = i - (navArr.length - n) + 1;
    if (navArr[i - 1] > 0) {
      weightedSum += (navArr[i] / navArr[i - 1] - 1) * w;
      weightTotal += w;
    }
  }
  if (weightTotal === 0) return 0;
  return Math.round(weightedSum / weightTotal * 10000) / 100;
}

function computeValuationTemp(navArr, fundMeta, marketTemperature) {
  if (!marketTemperature) return 50;
  var temp = marketTemperature.temperature || 50;
  if (!fundMeta) return 50;
  var type = (fundMeta.type || '').toLowerCase();
  var base = Math.max(20, Math.min(80, 100 - temp));
  var sensitivity = 1.0;
  if (type.indexOf('纳指') >= 0 || type.indexOf('纳斯达克') >= 0 || type.indexOf('科技') >= 0) {
    sensitivity = 1.5;
  } else if (type.indexOf('标普') >= 0 || type.indexOf('全球') >= 0) {
    sensitivity = 1.2;
  } else if (type.indexOf('港股') >= 0 || type.indexOf('亚太') >= 0 || type.indexOf('新兴') >= 0) {
    sensitivity = 1.3;
  } else if (type.indexOf('商品') >= 0 || type.indexOf('石油') >= 0 || type.indexOf('黄金') >= 0) {
    sensitivity = 0.5;
  } else if (type.indexOf('债') >= 0 || type.indexOf('reit') >= 0) {
    sensitivity = 0.3;
  }
  var deviation = base - 50;
  var adjusted = 50 + deviation * sensitivity;
  return Math.max(10, Math.min(90, Math.round(adjusted)));
}

function computeFeePenalty(fundMeta) {
  if (!fundMeta) return 50;
  var fee = (fundMeta.feeRate || 0) + (fundMeta.custodyFee || 0);
  if (fee <= 0) return 80;
  if (fee <= 0.5) return 70;
  if (fee <= 1.0) return 50;
  if (fee <= 1.5) return 30;
  return 20;
}

function computeMomentum120d(navArr) {
  if (!navArr || navArr.length < 15) return null;
  var n = navArr.length;
  var lookback = Math.min(120, n - 1);
  var baseNav = navArr[n - 1 - lookback] !== undefined ? navArr[n - 1 - lookback] : navArr[0];
  if (!baseNav || baseNav === 0) return null;
  return ((navArr[n - 1] / baseNav) - 1) * 100;
}

function computeMomentum1y(navArr) {
  if (!navArr || navArr.length < 200) return null;
  var n = navArr.length;
  var lookback = Math.min(250, n - 1);
  var baseNav = navArr[n - 1 - lookback] !== undefined ? navArr[n - 1 - lookback] : navArr[0];
  if (!baseNav || baseNav === 0) return null;
  return ((navArr[n - 1] / baseNav) - 1) * 100;
}

function computeTrendStrength(navArr) {
  if (!navArr || navArr.length < 20) return null;
  var closes = navArr;
  var gains = [], losses = [];
  for (var i = 1; i < closes.length; i++) {
    var diff = closes[i] - closes[i - 1];
    gains.push(diff > 0 ? diff : 0);
    losses.push(diff < 0 ? -diff : 0);
  }
  var avgGain = gains.slice(-14).reduce(function(s, v) { return s + v; }, 0) / 14;
  var avgLoss = losses.slice(-14).reduce(function(s, v) { return s + v; }, 0) / 14;
  if (avgGain + avgLoss === 0) return 50;
  var rs = avgGain / (avgLoss || 0.001);
  return Math.max(0, Math.min(100, 50 + rs * 10));
}

function computePeakPenalty(navArr) {
  if (!navArr || navArr.length < 30) return null;
  var peak = -Infinity;
  for (var i = 0; i < navArr.length; i++) {
    if (navArr[i] > peak) peak = navArr[i];
  }
  if (peak <= 0) return null;
  var latest = navArr[navArr.length - 1];
  var dist = (latest - peak) / peak * 100;
  return Math.max(0, Math.min(100, 100 + dist * 2));
}

/**
 * 默认权重（与前端一致）
 */
var DEFAULT_WEIGHTS = {
  volatility_hist: -1.0,
  trend_alignment: 1.5,
  drawdown_depth: -0.5,
  quality_sharpe: 2.5,
  quality_decay_ret: 0.6,
  scarce_limit: 0,
  valuation_temp: 1.5,
  fee_penalty: -0.8,
  momentum_120d: 0.8,
  momentum_1y: 3.0,
  trend_strength: 1.5,
  portfolio_diversity: 1.0,
  peak_penalty: -1.5
};

/**
 * 计算加权综合分数
 */
function weightedSum(factorScores, weights) {
  var totalWeight = 0, weightedSum = 0;
  Object.keys(factorScores).forEach(function(fid) {
    if (factorScores[fid] === null || factorScores[fid] === undefined || isNaN(factorScores[fid])) return;
    var w = weights[fid] || 1;
    weightedSum += factorScores[fid] * w;
    totalWeight += Math.abs(w);
  });
  return totalWeight > 0 ? Math.round(weightedSum / totalWeight * 10) / 10 : null;
}

/**
 * 计算排名（完整流程）
 */
function computeRankings(funds, navCache, marketTemperature, portfolioData) {
  var results = [];

  funds.forEach(function(fund) {
    var cached = navCache[fund.code];
    if (!cached || !Array.isArray(cached) || cached.length < 10) {
      results.push({ code: fund.code, name: fund.name, type: fund.type, composite: null, insufficient: true });
      return;
    }

    var sorted = cached.slice().sort(function(a, b) {
      return (a.date || '') < (b.date || '') ? -1 : ((a.date || '') > (b.date || '') ? 1 : 0);
    });
    var navArr = sorted.map(function(x) { return x.nav; });

    var rawScores = computeAll(navArr, fund, marketTemperature);
    var composite = weightedSum(rawScores, DEFAULT_WEIGHTS);

    results.push({
      code: fund.code,
      name: fund.name,
      type: fund.type,
      indexGroup: fund.indexGroup,
      composite: composite,
      rawScores: rawScores,
      insufficient: false
    });
  });

  // 排序
  results.sort(function(a, b) {
    if (a.composite === null && b.composite === null) return 0;
    if (a.composite === null) return 1;
    if (b.composite === null) return -1;
    return b.composite - a.composite;
  });

  // 去重
  function isBuyable(fund) {
    if (!fund) return false;
    if (fund.status === 'suspended') return false;
    if (fund.dailyLimit !== undefined && fund.dailyLimit <= 0) return false;
    return true;
  }

  var usedIG = {};
  results.forEach(function(r) {
    if (r.composite === null) { r.deduped = false; return; }
    var fund = funds.find(function(f) { return f.code === r.code; });
    var ig = r.indexGroup || r.code;
    var buyable = isBuyable(fund);

    if (usedIG[ig]) {
      if (!buyable) {
        r.deduped = false;
      } else {
        var blocker = usedIG[ig];
        if (!blocker.buyable) {
          usedIG[ig] = { name: r.name, fund: fund, buyable: true };
          r.deduped = false;
        } else {
          r.deduped = true;
          r.dedupedBy = blocker.name;
        }
      }
    } else {
      r.deduped = false;
      usedIG[ig] = { name: r.name, fund: fund, buyable: buyable };
    }
  });

  return results;
}

module.exports = {
  computeAll: computeAll,
  weightedSum: weightedSum,
  computeRankings: computeRankings,
  DEFAULT_WEIGHTS: DEFAULT_WEIGHTS
};
