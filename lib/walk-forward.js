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
const { scoreFund, WEIGHTS: _WEIGHTS } = require("./scorer");
const { round2 } = require("./utils");

/**
 * 走步回测主函数
 * @param {Object} fundHistories - { code: [{ date, nav }] }
 * @param {Array} funds - 基金配置列表
 * @param {Object} config - { trainDays, testDays, topN, stepDays }
 */
function runWalkForwardBacktest(fundHistories, funds, config) {
  const trainDays = config.trainDays || 90;   // 训练窗口
  const testDays = config.testDays || 30;     // 测试窗口
  const topN = config.topN || 5;              // 每次选几只
  const stepDays = config.stepDays || 30;     // 窗口滚动步长
  const minDataPoints = config.minDataPoints || 60;

  let fundCodes = Object.keys(fundHistories);
  if (fundCodes.length === 0) return null;

  const minRequired = trainDays + testDays;

  // 只保留数据充足的基金
  fundCodes = fundCodes.filter(function (code) {
    return fundHistories[code] && fundHistories[code].length >= minRequired;
  });
  if (fundCodes.length === 0) {
    console.log("[走步回测] 没有数据充足的基金（需要" + minRequired + "天）");
    return null;
  }

  // 找到所有基金共有的日期范围
  const commonDates = [];
  const firstFund = fundHistories[fundCodes[0]];
  for (let d = 0; d < firstFund.length; d++) {
    commonDates.push(firstFund[d].date);
  }

  const totalDays = commonDates.length;
  if (totalDays < minRequired) {
    console.log("[走步回测] 数据不足: 需要" + minRequired + "天, 只有" + totalDays + "天");
    return null;
  }

  const windows = [];
  let windowStart = 0;

  // 滚动窗口
  while (windowStart + trainDays + testDays <= totalDays) {
    const trainEnd = windowStart + trainDays;
    const testEnd = Math.min(trainEnd + testDays, totalDays);
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

  const windowResults = [];

  for (let w = 0; w < windows.length; w++) {
    const win = windows[w];

    // Step 1: 用训练窗口的数据评分（模拟"历史信息做决策"）
    const scored = [];
    for (let fi = 0; fi < fundCodes.length; fi++) {
      const code = fundCodes[fi];
      const fund = funds.find(function (f) { return f.code === code; });
      if (!fund) continue;

      // 只用训练窗口内的数据
      const trainSlice = fundHistories[code].slice(win.trainStart, win.trainEnd);
      if (trainSlice.length < minDataPoints) continue;

      const indicators = calcIndicators(trainSlice);
      if (trainSlice.length > 0) {
        indicators.navs = trainSlice.map(function (r) { return r.nav; });
      }

      // 回测时强制 active
      const backtestFund = Object.assign({}, fund, {
        status: "active",
        dailyLimit: fund.dailyLimit > 0 ? fund.dailyLimit : 10
      });
      const result = scoreFund(backtestFund, indicators, null);
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
    const picked = scored.slice(0, topN);

    // Step 3: 用测试窗口的数据计算真实收益（模拟"按推荐买入后的实际收益"）
    const picks = [];
    let totalReturn = 0;
    let validPicks = 0;

    for (let pi = 0; pi < picked.length; pi++) {
      const pf = picked[pi];
      const testNavs = fundHistories[pf.code].slice(win.testStart, win.testEnd);
      if (testNavs.length === 0) continue;

      const navAtBuy = fundHistories[pf.code][win.testStart] ? fundHistories[pf.code][win.testStart].nav : pf.trainEndNav;
      const navAtEnd = testNavs[testNavs.length - 1].nav;
      const ret = round2(((navAtEnd - navAtBuy) / navAtBuy) * 100);

      picks.push({
        code: pf.code,
        name: pf.name,
        score: pf.score,
        return: ret
      });
      totalReturn += ret;
      validPicks++;
    }

    const avgReturn = validPicks > 0 ? round2(totalReturn / validPicks) : 0;
    const isWin = avgReturn > 0;

    windowResults.push({
      window: w + 1,
      trainPeriod: win.trainStartDate + " ~ " + win.trainEndDate,
      testPeriod: win.testStartDate + " ~ " + win.testEndDate,
      picks: picks,
      avgReturn: avgReturn,
      isWin: isWin
    });

    const emoji = isWin ? "🟢" : "🔴";
    console.log(
      "窗口" + (w + 1) + " | 测试: " + win.testStartDate + "~" + win.testEndDate +
      " | Top" + topN + "平均收益: " + (avgReturn >= 0 ? "+" : "") + avgReturn + "% " + emoji +
      " | " + picks.map(function (p) { return p.name.substring(0, 8); }).join(", ")
    );
  }

  // 汇总
  const totalWindows = windowResults.length;
  const winWindows = windowResults.filter(function (r) { return r.isWin; }).length;
  const winRate = totalWindows > 0 ? round2((winWindows / totalWindows) * 100) : 0;
  const allReturns = windowResults.map(function (r) { return r.avgReturn; });
  const avgAllReturn = allReturns.length > 0 ? round2(allReturns.reduce(function (s, r) { return s + r; }, 0) / allReturns.length) : 0;
  const maxReturn = allReturns.length > 0 ? Math.max.apply(null, allReturns) : 0;
  const minReturn = allReturns.length > 0 ? Math.min.apply(null, allReturns) : 0;

  // 计算累计收益（假设每个窗口等权投入）
  let cumReturn = 1;
  for (let ci = 0; ci < windowResults.length; ci++) {
    cumReturn *= (1 + windowResults[ci].avgReturn / 100);
  }
  const cumReturnPct = round2((cumReturn - 1) * 100);

  const summary = {
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
