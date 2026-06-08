/**
 * QDII Fund Strategy Backtester
 * Uses historical NAV data to evaluate strategy performance
 */

const { getFundNavHistory, calcIndicators } = require("./fund-data");
const { scoreFund, WEIGHTS } = require("./dynamic-strategy");

var fs = require("fs");
var path = require("path");

/**
 * Run backtest for given funds over a historical period
 * @param {Array} funds - fund list from funds.json
 * @param {Object} config - { lookbackDays, topN, minPurchase, backtestDays }
 */
async function runBacktest(funds, config) {
  var lookbackDays = config.lookbackDays || 30;
  var topN = config.topN || 3;
  var minPurchase = config.minPurchase || 10;
  var backtestDays = config.backtestDays || 60;
  var totalDataDays = lookbackDays + backtestDays + 10; // extra buffer

  console.log("[回测] 获取基金历史数据 (共" + totalDataDays + "天)...");
  console.log("[回测] 参数: lookback=" + lookbackDays + ", topN=" + topN + ", 回测期=" + backtestDays + "天");
  console.log("");

  // Step 1: Fetch all fund NAV history
  var fundHistories = {};
  for (var i = 0; i < funds.length; i++) {
    var fund = funds[i];
    var history = await getFundNavHistory(fund.code, totalDataDays);
    if (history.length > lookbackDays + 5) {
      fundHistories[fund.code] = history;
      console.log("[数据] " + fund.name + "(" + fund.code + "): " + history.length + "天数据");
    } else {
      console.log("[跳过] " + fund.name + "(" + fund.code + "): 数据不足(" + history.length + "天)");
    }
    // Small delay to avoid rate limiting
    await new Promise(function(r) { setTimeout(r, 200); });
  }
  console.log("");

  // Step 2: Simulate daily strategy
  var fundCodes = Object.keys(fundHistories);
  if (fundCodes.length === 0) {
    console.log("[回测] 无可用基金数据，退出");
    return null;
  }

  // Find common date range
  var allDates = [];
  var firstFund = fundHistories[fundCodes[0]];
  for (var d = 0; d < firstFund.length; d++) {
    allDates.push(firstFund[d].date);
  }

  // Backtest from lookbackDays to len-5 (need 5 days ahead to measure performance)
  var results = [];
  var startIdx = lookbackDays;
  var endIdx = Math.min(allDates.length - 5, startIdx + backtestDays);

  console.log("[回测] 回测区间: " + allDates[startIdx] + " ~ " + allDates[endIdx - 1]);
  console.log("[回测] 共 " + (endIdx - startIdx) + " 个交易日");
  console.log("");
  console.log("=== 每日回测结果 ===");
  console.log("");

  for (var dayIdx = startIdx; dayIdx < endIdx; dayIdx++) {
    var currentDate = allDates[dayIdx];

    // Score each fund using data up to dayIdx
    var scored = [];
    for (var fi = 0; fi < fundCodes.length; fi++) {
      var code = fundCodes[fi];
      var fund = funds.find(function(f) { return f.code === code; });
      if (!fund) continue;

      var historySlice = fundHistories[code].slice(0, dayIdx + 1);
      var indicators = calcIndicators(historySlice);
      if (historySlice.length > 0) {
        indicators.navs = historySlice.map(function(r) { return r.nav; });
      }

      var result = scoreFund(fund, indicators, null);
      scored.push({ code: code, name: fund.name, score: result.score, nav: historySlice[historySlice.length - 1].nav, indicators: indicators });
    }

    // Filter active, sort by score, take topN
    var available = scored.filter(function(f) { return f.score > 0; });
    available.sort(function(a, b) { return b.score - a.score; });
    var picked = available.slice(0, topN);

    // Calculate actual 5-day and 10-day returns for each picked fund
    var dayResult = { date: currentDate, picks: [], avgReturn5d: 0, avgReturn10d: 0 };

    for (var pi = 0; pi < picked.length; pi++) {
      var pf = picked[pi];
      var navHistory = fundHistories[pf.code];
      var navAtPick = navHistory[dayIdx] ? navHistory[dayIdx].nav : null;
      var navAfter5 = navHistory[dayIdx + 5] ? navHistory[dayIdx + 5].nav : null;
      var navAfter10 = navHistory[dayIdx + 10] ? navHistory[dayIdx + 10].nav : null;

      var ret5 = navAtPick && navAfter5 ? r2(((navAfter5 - navAtPick) / navAtPick) * 100) : null;
      var ret10 = navAtPick && navAfter10 ? r2(((navAfter10 - navAtPick) / navAtPick) * 100) : null;

      dayResult.picks.push({
        code: pf.code,
        name: pf.name,
        score: pf.score,
        return5d: ret5,
        return10d: ret10
      });

      if (ret5 !== null) dayResult.avgReturn5d += ret5;
      if (ret10 !== null) dayResult.avgReturn10d += ret10;
    }

    if (picked.length > 0) {
      dayResult.avgReturn5d = r2(dayResult.avgReturn5d / picked.length);
      dayResult.avgReturn10d = r2(dayResult.avgReturn10d / picked.length);
    }

    results.push(dayResult);

    // Print daily result
    var pickStr = dayResult.picks.map(function(p) {
      var r5 = p.return5d !== null ? (p.return5d >= 0 ? "+" : "") + p.return5d + "%" : "N/A";
      return p.name.substring(0, 16) + "(" + p.score + "|" + r5 + ")";
    }).join(", ");
    console.log(currentDate + " | " + pickStr);
  }

  // Step 3: Calculate summary statistics
  console.log("");
  console.log("=== 回测总结 ===");
  console.log("");

  var valid5d = results.filter(function(r) { return r.avgReturn5d !== 0; });
  var valid10d = results.filter(function(r) { return r.avgReturn10d !== 0; });

  var win5d = valid5d.filter(function(r) { return r.avgReturn5d > 0; }).length;
  var win10d = valid10d.filter(function(r) { return r.avgReturn10d > 0; }).length;

  var totalReturn5d = valid5d.reduce(function(s, r) { return s + r.avgReturn5d; }, 0);
  var totalReturn10d = valid10d.reduce(function(s, r) { return s + r.avgReturn10d; }, 0);

  var avgReturn5d = valid5d.length > 0 ? r2(totalReturn5d / valid5d.length) : 0;
  var avgReturn10d = valid10d.length > 0 ? r2(totalReturn10d / valid10d.length) : 0;

  var winRate5d = valid5d.length > 0 ? r2((win5d / valid5d.length) * 100) : 0;
  var winRate10d = valid10d.length > 0 ? r2((win10d / valid10d.length) * 100) : 0;

  // Max drawdown (cumulative)
  var cumReturn = 0;
  var peak = 0;
  var maxDrawdown = 0;
  for (var ri = 0; ri < valid5d.length; ri++) {
    cumReturn += valid5d[ri].avgReturn5d;
    if (cumReturn > peak) peak = cumReturn;
    var dd = cumReturn - peak;
    if (dd < maxDrawdown) maxDrawdown = dd;
  }

  // Equal-weight DCA benchmark
  var dcaReturn5d = 0;
  var dcaCount = 0;
  for (var di = startIdx; di < endIdx; di++) {
    for (var dc = 0; dc < fundCodes.length; dc++) {
      var navH = fundHistories[fundCodes[dc]];
      if (navH[di] && navH[di + 5]) {
        dcaReturn5d += ((navH[di + 5].nav - navH[di].nav) / navH[di].nav) * 100;
        dcaCount++;
      }
    }
  }
  var dcaAvgReturn = dcaCount > 0 ? r2(dcaReturn5d / dcaCount) : 0;

  var summary = {
    backtestDays: valid5d.length,
    winRate5d: winRate5d + "%",
    winRate10d: winRate10d + "%",
    avgReturn5d: avgReturn5d + "%",
    avgReturn10d: avgReturn10d + "%",
    maxDrawdown: r2(maxDrawdown) + "%",
    dcaBenchmark5d: dcaAvgReturn + "%",
    alpha: r2(avgReturn5d - dcaAvgReturn) + "%"
  };

  console.log("回测天数: " + summary.backtestDays);
  console.log("5日胜率: " + summary.winRate5d);
  console.log("10日胜率: " + summary.winRate10d);
  console.log("5日平均收益: " + summary.avgReturn5d);
  console.log("10日平均收益: " + summary.avgReturn10d);
  console.log("最大回撤: " + summary.maxDrawdown);
  console.log("等额定投基准(5日): " + summary.dcaBenchmark5d);
  console.log("策略Alpha: " + summary.alpha);

  return { summary: summary, daily: results };
}

function r2(n) { return Math.round(n * 100) / 100; }

/**
 * 运行单次回测（内部函数，不打印）
 * @param {Array} funds - 基金列表
 * @param {Object} config - 回测配置
 * @param {Object|null} weightOverrides - 权重覆盖（null则用默认）
 * @returns {Object} 回测结果
 */
async function runBacktestSilent(funds, config, weightOverrides) {
  var lookbackDays = config.lookbackDays || 30;
  var topN = config.topN || 3;
  var backtestDays = config.backtestDays || 60;
  var totalDataDays = lookbackDays + backtestDays + 10;

  // 暂存原始权重并覆盖
  var originalWeights = null;
  if (weightOverrides) {
    originalWeights = {};
    var keys = Object.keys(weightOverrides);
    for (var wi = 0; wi < keys.length; wi++) {
      originalWeights[keys[wi]] = WEIGHTS[keys[wi]];
      WEIGHTS[keys[wi]] = weightOverrides[keys[wi]];
    }
  }

  try {
    // 获取基金历史数据（使用缓存）
    var fundHistories = {};
    for (var i = 0; i < funds.length; i++) {
      var fund = funds[i];
      var history = await getFundNavHistory(fund.code, totalDataDays);
      if (history.length > lookbackDays + 5) {
        fundHistories[fund.code] = history;
      }
      await new Promise(function(r) { setTimeout(r, 100); });
    }

    var fundCodes = Object.keys(fundHistories);
    if (fundCodes.length === 0) return null;

    var allDates = [];
    var firstFund = fundHistories[fundCodes[0]];
    for (var d = 0; d < firstFund.length; d++) {
      allDates.push(firstFund[d].date);
    }

    var results = [];
    var startIdx = lookbackDays;
    var endIdx = Math.min(allDates.length - 5, startIdx + backtestDays);

    for (var dayIdx = startIdx; dayIdx < endIdx; dayIdx++) {
      var scored = [];
      for (var fi = 0; fi < fundCodes.length; fi++) {
        var code = fundCodes[fi];
        var f = funds.find(function(ff) { return ff.code === code; });
        if (!f) continue;
        var historySlice = fundHistories[code].slice(0, dayIdx + 1);
        var indicators = calcIndicators(historySlice);
        if (historySlice.length > 0) indicators.navs = historySlice.map(function(r) { return r.nav; });
        var result = scoreFund(f, indicators, null);
        scored.push({ code: code, name: f.name, score: result.score });
      }

      var available = scored.filter(function(f) { return f.score > 0; });
      available.sort(function(a, b) { return b.score - a.score; });
      var picked = available.slice(0, topN);

      var dayResult = { avgReturn5d: 0, count: 0 };
      for (var pi = 0; pi < picked.length; pi++) {
        var pf = picked[pi];
        var navHistory = fundHistories[pf.code];
        var navAtPick = navHistory[dayIdx] ? navHistory[dayIdx].nav : null;
        var navAfter5 = navHistory[dayIdx + 5] ? navHistory[dayIdx + 5].nav : null;
        if (navAtPick && navAfter5) {
          dayResult.avgReturn5d += ((navAfter5 - navAtPick) / navAtPick) * 100;
          dayResult.count++;
        }
      }
      if (dayResult.count > 0) dayResult.avgReturn5d = r2(dayResult.avgReturn5d / dayResult.count);
      results.push(dayResult);
    }

    var valid = results.filter(function(r) { return r.count > 0; });
    var wins = valid.filter(function(r) { return r.avgReturn5d > 0; }).length;
    var totalRet = valid.reduce(function(s, r) { return s + r.avgReturn5d; }, 0);
    var avgRet = valid.length > 0 ? r2(totalRet / valid.length) : 0;
    var winRate = valid.length > 0 ? r2((wins / valid.length) * 100) : 0;

    return { avgReturn5d: avgRet, winRate5d: winRate, days: valid.length, score: r2(avgRet * winRate / 100) };

  } finally {
    // 恢复原始权重
    if (originalWeights) {
      var restoreKeys = Object.keys(originalWeights);
      for (var rki = 0; rki < restoreKeys.length; rki++) {
        WEIGHTS[restoreKeys[rki]] = originalWeights[restoreKeys[rki]];
      }
    }
  }
}

/**
 * 权重优化：网格搜索关键参数
 * @param {Array} funds - 基金列表
 * @param {Object} config - 回测配置
 */
async function runWeightOptimization(funds, config) {
  console.log("[权重优化] 开始网格搜索...");
  console.log("");

  // 定义搜索网格（6个关键参数）
  var grid = {
    yearReturn:     [0.1, 0.2, 0.3, 0.5],
    sharpeRatio:    [2.0, 3.0, 4.0, 5.0],
    maxDrawdown:    [0.06, 0.12, 0.2],
    drawdown:       [0.8, 1.5, 2.5],
    maDeviation:    [0.6, 1.2, 2.0],
    volatility:     [-0.2, -0.4, -0.8]
  };

  // 生成所有组合
  var combos = [];
  var keys = Object.keys(grid);
  function generateCombos(idx, current) {
    if (idx === keys.length) {
      combos.push(Object.assign({}, current));
      return;
    }
    var key = keys[idx];
    for (var vi = 0; vi < grid[key].length; vi++) {
      current[key] = grid[key][vi];
      generateCombos(idx + 1, current);
    }
  }
  generateCombos(0, {});

  console.log("[权重优化] 共 " + combos.length + " 种权重组合");
  console.log("[权重优化] 搜索参数: " + keys.join(", "));
  console.log("");

  // 测试每种组合
  var results = [];
  for (var ci = 0; ci < combos.length; ci++) {
    var combo = combos[ci];
    var btResult = await runBacktestSilent(funds, config, combo);
    if (btResult) {
      results.push({ weights: combo, result: btResult });
    }
    // 进度显示
    if ((ci + 1) % 50 === 0 || ci === combos.length - 1) {
      console.log("[权重优化] 进度: " + (ci + 1) + "/" + combos.length);
    }
  }

  // 按 score (avgReturn5d × winRate5d / 100) 降序排列
  results.sort(function(a, b) { return b.result.score - a.result.score; });

  // 输出 Top 5
  console.log("");
  console.log("=== 权重优化结果 Top 5 ===");
  console.log("");
  var top5 = results.slice(0, 5);
  for (var ti = 0; ti < top5.length; ti++) {
    var tr = top5[ti];
    console.log("#" + (ti + 1) + " 综合得分: " + tr.result.score + " | 5日收益: " + tr.result.avgReturn5d + "% | 胜率: " + tr.result.winRate5d + "% | " + tr.result.days + "天");
    console.log("   权重: " + keys.map(function(k) { return k + "=" + tr.weights[k]; }).join(", "));
    console.log("");
  }

  // 当前权重的基准
  var baseline = await runBacktestSilent(funds, config, null);
  if (baseline) {
    console.log("当前权重基准: 得分=" + baseline.score + " | 5日收益=" + baseline.avgReturn5d + "% | 胜率=" + baseline.winRate5d + "%");
    if (top5.length > 0 && top5[0].result.score > baseline.score) {
      console.log("最优权重比当前提升: " + r2(top5[0].result.score - baseline.score) + " 分");
    } else {
      console.log("当前权重已是最优，无需调整");
    }
  }

  // 保存结果
  var OPT_FILE = path.join(__dirname, "..", "data", "weight-optimization.json");
  try {
    fs.writeFileSync(OPT_FILE, JSON.stringify({ date: new Date().toISOString(), baseline: baseline, top5: top5, totalCombos: combos.length }, null, 2), "utf-8");
    console.log("");
    console.log("[权重优化] 结果已保存到 data/weight-optimization.json");
    console.log("使用 --optimize-weights --apply 可以应用最优权重");
  } catch(e) {
    console.warn("[权重优化] 保存失败:", e.message);
  }

  return { baseline: baseline, top5: top5 };
}

module.exports = { runBacktest, runWeightOptimization };