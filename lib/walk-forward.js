/**
 * 走步回测验证器 (Walk-Forward Backtester)
 * 受 Vibe-Trading 启发：用滚动窗口验证策略，防止过拟合
 * 
 * 核心区别于普通回测：
 * - 普通回测：用全部历史数据训练参数，然后测同一段 → 过拟合
 * - 走步回测：用前N天训练，测后M天，然后滚动窗口 → 更接近真实
 * 
 * 例如：用前90天数据评分，测接下来30天的收益，然后窗口向前滚动30天重复
 */

const { calcIndicators } = require("./fund-data");
const { scoreFund, WEIGHTS } = require("./scorer");
const { round2 } = require("./utils");

/**
 * 走步回测主函数
 * @param {Object} fundHistories - { code: [{ date, nav }] }
 * @param {Array} funds - 基金配置列表
 * @param {Object} config - { trainDays, testDays, topN, stepDays }
 */
function runWalkForwardBacktest(fundHistories, funds, config) {
  var trainDays = config.trainDays || 90;   // 训练窗口
  var testDays = config.testDays || 30;     // 测试窗口
  var topN = config.topN || 5;              // 每次选几只
  var stepDays = config.stepDays || 30;     // 窗口滚动步长
  var minDataPoints = config.minDataPoints || 60;

  var fundCodes = Object.keys(fundHistories);
  if (fundCodes.length === 0) return null;

  var minRequired = trainDays + testDays;

  // 只保留数据充足的基金
  fundCodes = fundCodes.filter(function (code) {
    return fundHistories[code] && fundHistories[code].length >= minRequired;
  });
  if (fundCodes.length === 0) {
    console.log("[走步回测] 没有数据充足的基金（需要" + minRequired + "天）");
    return null;
  }

  // 找到所有基金共有的日期范围
  var commonDates = [];
  var firstFund = fundHistories[fundCodes[0]];
  for (var d = 0; d < firstFund.length; d++) {
    commonDates.push(firstFund[d].date);
  }

  var totalDays = commonDates.length;
  if (totalDays < minRequired) {
    console.log("[走步回测] 数据不足: 需要" + minRequired + "天, 只有" + totalDays + "天");
    return null;
  }

  var windows = [];
  var windowStart = 0;

  // 滚动窗口
  while (windowStart + trainDays + testDays <= totalDays) {
    var trainEnd = windowStart + trainDays;
    var testEnd = Math.min(trainEnd + testDays, totalDays);
    windows.push({
      trainStart: windowStart,
      trainEnd: trainEnd,
      testStart: trainEnd,
      testEnd: testEnd,
      trainStartDate: commonDates[windowStart],
      trainEndDate: commonDates[trainEnd - 1],
      testStartDate: commonDates[trainEnd],
      testEndDate: commonDates[testEnd - 1]
    });
    windowStart += stepDays;
  }

  console.log("[走步回测] " + windows.length + " 个滚动窗口");
  console.log("[走步回测] 训练=" + trainDays + "天, 测试=" + testDays + "天, 步长=" + stepDays + "天");
  console.log("");

  var windowResults = [];

  for (var w = 0; w < windows.length; w++) {
    var win = windows[w];

    // Step 1: 用训练窗口的数据评分（模拟"历史信息做决策"）
    var scored = [];
    for (var fi = 0; fi < fundCodes.length; fi++) {
      var code = fundCodes[fi];
      var fund = funds.find(function (f) { return f.code === code; });
      if (!fund) continue;

      // 只用训练窗口内的数据
      var trainSlice = fundHistories[code].slice(win.trainStart, win.trainEnd);
      if (trainSlice.length < minDataPoints) continue;

      var indicators = calcIndicators(trainSlice);
      if (trainSlice.length > 0) {
        indicators.navs = trainSlice.map(function (r) { return r.nav; });
      }

      // 回测时强制 active
      var backtestFund = Object.assign({}, fund, {
        status: "active",
        dailyLimit: fund.dailyLimit > 0 ? fund.dailyLimit : 10
      });
      var result = scoreFund(backtestFund, indicators, null);
      if (result.score > 0) {
        scored.push({
          code: code,
          name: fund.name,
          score: result.score,
          trainEndNav: trainSlice[trainSlice.length - 1].nav
        });
      }
    }

    // Step 2: 选TopN
    scored.sort(function (a, b) { return b.score - a.score; });
    var picked = scored.slice(0, topN);

    // Step 3: 用测试窗口的数据计算真实收益（模拟"按推荐买入后的实际收益"）
    var picks = [];
    var totalReturn = 0;
    var validPicks = 0;

    for (var pi = 0; pi < picked.length; pi++) {
      var pf = picked[pi];
      var testNavs = fundHistories[pf.code].slice(win.testStart, win.testEnd);
      if (testNavs.length === 0) continue;

      var navAtBuy = fundHistories[pf.code][win.testStart] ? fundHistories[pf.code][win.testStart].nav : pf.trainEndNav;
      var navAtEnd = testNavs[testNavs.length - 1].nav;
      var ret = round2(((navAtEnd - navAtBuy) / navAtBuy) * 100);

      picks.push({
        code: pf.code,
        name: pf.name,
        score: pf.score,
        return: ret
      });
      totalReturn += ret;
      validPicks++;
    }

    var avgReturn = validPicks > 0 ? round2(totalReturn / validPicks) : 0;
    var isWin = avgReturn > 0;

    windowResults.push({
      window: w + 1,
      trainPeriod: win.trainStartDate + " ~ " + win.trainEndDate,
      testPeriod: win.testStartDate + " ~ " + win.testEndDate,
      picks: picks,
      avgReturn: avgReturn,
      isWin: isWin
    });

    var emoji = isWin ? "🟢" : "🔴";
    console.log(
      "窗口" + (w + 1) + " | 测试: " + win.testStartDate + "~" + win.testEndDate +
      " | Top" + topN + "平均收益: " + (avgReturn >= 0 ? "+" : "") + avgReturn + "% " + emoji +
      " | " + picks.map(function (p) { return p.name.substring(0, 8); }).join(", ")
    );
  }

  // 汇总
  var totalWindows = windowResults.length;
  var winWindows = windowResults.filter(function (r) { return r.isWin; }).length;
  var winRate = totalWindows > 0 ? round2((winWindows / totalWindows) * 100) : 0;
  var allReturns = windowResults.map(function (r) { return r.avgReturn; });
  var avgAllReturn = allReturns.length > 0 ? round2(allReturns.reduce(function (s, r) { return s + r; }, 0) / allReturns.length) : 0;
  var maxReturn = allReturns.length > 0 ? Math.max.apply(null, allReturns) : 0;
  var minReturn = allReturns.length > 0 ? Math.min.apply(null, allReturns) : 0;

  // 计算累计收益（假设每个窗口等权投入）
  var cumReturn = 1;
  for (var ci = 0; ci < windowResults.length; ci++) {
    cumReturn *= (1 + windowResults[ci].avgReturn / 100);
  }
  var cumReturnPct = round2((cumReturn - 1) * 100);

  var summary = {
    windows: totalWindows,
    winRate: winRate + "%",
    avgReturnPerWindow: avgAllReturn + "%",
    bestWindow: maxReturn + "%",
    worstWindow: minReturn + "%",
    cumulativeReturn: cumReturnPct + "%",
    trainDays: trainDays,
    testDays: testDays,
    topN: topN
  };

  console.log("");
  console.log("=== 走步回测汇总 ===");
  console.log("窗口数: " + summary.windows);
  console.log("胜率: " + summary.winRate);
  console.log("每窗口平均收益: " + summary.avgReturnPerWindow);
  console.log("最佳窗口: " + summary.bestWindow);
  console.log("最差窗口: " + summary.worstWindow);
  console.log("累计收益: " + summary.cumulativeReturn);
  console.log("（训练" + trainDays + "天 → 测试" + testDays + "天, Top" + topN + "）");

  return { summary: summary, windows: windowResults };
}

module.exports = {
  runWalkForwardBacktest: runWalkForwardBacktest
};
