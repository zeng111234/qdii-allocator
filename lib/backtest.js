/**
 * QDII Fund Strategy Backtester
 * Uses historical NAV data to evaluate strategy performance
 */

const { getFundNavHistory, calcIndicators } = require("./fund-data");
const { scoreFund, WEIGHTS } = require("./dynamic-strategy");

const fs = require("fs");
const path = require("path");

/**
 * Run backtest for given funds over a historical period
 * @param {Array} funds - fund list from funds.json
 * @param {Object} config - { lookbackDays, topN, minPurchase, backtestDays }
 */
async function runBacktest(funds, config) {
  const lookbackDays = config.lookbackDays || 30;
  const topN = config.topN || 3;
  const _minPurchase = config.minPurchase || 10;
  const backtestDays = config.backtestDays || 60;
  const totalDataDays = lookbackDays + backtestDays + 10; // extra buffer

  console.log("[�ز�] ��ȡ������ʷ���� (��" + totalDataDays + "��)...");
  console.log("[�ز�] ����: lookback=" + lookbackDays + ", topN=" + topN + ", �ز���=" + backtestDays + "��");
  console.log("");

  // Step 1: Fetch all fund NAV history
  const fundHistories = {};
  for (let i = 0; i < funds.length; i++) {
    const fund = funds[i];
    const history = await getFundNavHistory(fund.code, totalDataDays);
    if (history.length > lookbackDays + 5) {
      fundHistories[fund.code] = history;
      console.log("[����] " + fund.name + "(" + fund.code + "): " + history.length + "������");
    } else {
      console.log("[����] " + fund.name + "(" + fund.code + "): ���ݲ���(" + history.length + "��)");
    }
    // Small delay to avoid rate limiting
    await new Promise(function(r) { setTimeout(r, 200); });
  }
  console.log("");

  // Step 2: Simulate daily strategy
  const fundCodes = Object.keys(fundHistories);
  if (fundCodes.length === 0) {
    console.log("[�ز�] �޿��û������ݣ��˳�");
    return null;
  }

  // Find common date range
  const allDates = [];
  const firstFund = fundHistories[fundCodes[0]];
  for (let d = 0; d < firstFund.length; d++) {
    allDates.push(firstFund[d].date);
  }

  // Backtest from lookbackDays to len-5 (need 5 days ahead to measure performance)
  const results = [];
  const startIdx = lookbackDays;
  const endIdx = Math.min(allDates.length - 5, startIdx + backtestDays);

  console.log("[�ز�] �ز�����: " + allDates[startIdx] + " ~ " + allDates[endIdx - 1]);
  console.log("[�ز�] �� " + (endIdx - startIdx) + " ��������");
  console.log("");
  console.log("=== ÿ�ջز��� ===");
  console.log("");

  for (let dayIdx = startIdx; dayIdx < endIdx; dayIdx++) {
    const currentDate = allDates[dayIdx];

    // Score each fund using data up to dayIdx
    const scored = [];
    for (let fi = 0; fi < fundCodes.length; fi++) {
      const code = fundCodes[fi];
      const fund = funds.find(function(f) { return f.code === code; });
      if (!fund) continue;

      const historySlice = fundHistories[code].slice(0, dayIdx + 1);
      const indicators = calcIndicators(historySlice);
      if (historySlice.length > 0) {
        indicators.navs = historySlice.map(function(r) { return r.nav; });
      }

      // 回测时强制标记为 active：有历史净值说明该基金在当时是可申购的，
      // 不应因为当前的暂停状态而被排除
      const backtestFund = Object.assign({}, fund, {
        status: "active",
        dailyLimit: fund.dailyLimit > 0 ? fund.dailyLimit : 10
      });
      const result = scoreFund(backtestFund, indicators, null);
      scored.push({ code: code, name: fund.name, score: result.score, nav: historySlice[historySlice.length - 1].nav, indicators: indicators });
    }

    // Filter active, sort by score, take topN
    const available = scored.filter(function(f) { return f.score > 0; });
    available.sort(function(a, b) { return b.score - a.score; });
    const picked = available.slice(0, topN);

    // Calculate actual 5-day and 10-day returns for each picked fund
    const dayResult = { date: currentDate, picks: [], avgReturn5d: 0, avgReturn10d: 0 };

    for (let pi = 0; pi < picked.length; pi++) {
      const pf = picked[pi];
      const navHistory = fundHistories[pf.code];
      const navAtPick = navHistory[dayIdx] ? navHistory[dayIdx].nav : null;
      const navAfter5 = navHistory[dayIdx + 5] ? navHistory[dayIdx + 5].nav : null;
      const navAfter10 = navHistory[dayIdx + 10] ? navHistory[dayIdx + 10].nav : null;

      const ret5 = navAtPick && navAfter5 ? r2(((navAfter5 - navAtPick) / navAtPick) * 100) : null;
      const ret10 = navAtPick && navAfter10 ? r2(((navAfter10 - navAtPick) / navAtPick) * 100) : null;

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
    const pickStr = dayResult.picks.map(function(p) {
      const r5 = p.return5d !== null ? (p.return5d >= 0 ? "+" : "") + p.return5d + "%" : "N/A";
      return p.name.substring(0, 16) + "(" + p.score + "|" + r5 + ")";
    }).join(", ");
    console.log(currentDate + " | " + pickStr);
  }

  // Step 3: Calculate summary statistics
  console.log("");
  console.log("=== �ز��ܽ� ===");
  console.log("");

  const valid5d = results.filter(function(r) { return r.avgReturn5d !== 0; });
  const valid10d = results.filter(function(r) { return r.avgReturn10d !== 0; });

  const win5d = valid5d.filter(function(r) { return r.avgReturn5d > 0; }).length;
  const win10d = valid10d.filter(function(r) { return r.avgReturn10d > 0; }).length;

  const totalReturn5d = valid5d.reduce(function(s, r) { return s + r.avgReturn5d; }, 0);
  const totalReturn10d = valid10d.reduce(function(s, r) { return s + r.avgReturn10d; }, 0);

  const avgReturn5d = valid5d.length > 0 ? r2(totalReturn5d / valid5d.length) : 0;
  const avgReturn10d = valid10d.length > 0 ? r2(totalReturn10d / valid10d.length) : 0;

  const winRate5d = valid5d.length > 0 ? r2((win5d / valid5d.length) * 100) : 0;
  const winRate10d = valid10d.length > 0 ? r2((win10d / valid10d.length) * 100) : 0;

  // Max drawdown (cumulative)
  let cumReturn = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (let ri = 0; ri < valid5d.length; ri++) {
    cumReturn += valid5d[ri].avgReturn5d;
    if (cumReturn > peak) peak = cumReturn;
    const dd = cumReturn - peak;
    if (dd < maxDrawdown) maxDrawdown = dd;
  }

  // Equal-weight DCA benchmark
  let dcaReturn5d = 0;
  let dcaCount = 0;
  for (let di = startIdx; di < endIdx; di++) {
    for (let dc = 0; dc < fundCodes.length; dc++) {
      const navH = fundHistories[fundCodes[dc]];
      if (navH[di] && navH[di + 5]) {
        dcaReturn5d += ((navH[di + 5].nav - navH[di].nav) / navH[di].nav) * 100;
        dcaCount++;
      }
    }
  }
  const dcaAvgReturn = dcaCount > 0 ? r2(dcaReturn5d / dcaCount) : 0;

  const summary = {
    backtestDays: valid5d.length,
    winRate5d: winRate5d + "%",
    winRate10d: winRate10d + "%",
    avgReturn5d: avgReturn5d + "%",
    avgReturn10d: avgReturn10d + "%",
    maxDrawdown: r2(maxDrawdown) + "%",
    dcaBenchmark5d: dcaAvgReturn + "%",
    alpha: r2(avgReturn5d - dcaAvgReturn) + "%"
  };

  console.log("�ز�����: " + summary.backtestDays);
  console.log("5��ʤ��: " + summary.winRate5d);
  console.log("10��ʤ��: " + summary.winRate10d);
  console.log("5��ƽ������: " + summary.avgReturn5d);
  console.log("10��ƽ������: " + summary.avgReturn10d);
  console.log("���س�: " + summary.maxDrawdown);
  console.log("�ȶͶ��׼(5��): " + summary.dcaBenchmark5d);
  console.log("����Alpha: " + summary.alpha);

  return { summary: summary, daily: results };
}

function r2(n) { return Math.round(n * 100) / 100; }

/**
 * ���е��λز⣨�ڲ�����������ӡ��
 * @param {Array} funds - �����б�
 * @param {Object} config - �ز�����
 * @param {Object|null} weightOverrides - Ȩ�ظ��ǣ�null����Ĭ�ϣ�
 * @returns {Object} �ز���
 */
async function runBacktestSilent(funds, config, weightOverrides) {
  const lookbackDays = config.lookbackDays || 30;
  const topN = config.topN || 3;
  const backtestDays = config.backtestDays || 60;
  const totalDataDays = lookbackDays + backtestDays + 10;

  // �ݴ�ԭʼȨ�ز�����
  let originalWeights = null;
  if (weightOverrides) {
    originalWeights = {};
    const keys = Object.keys(weightOverrides);
    for (let wi = 0; wi < keys.length; wi++) {
      originalWeights[keys[wi]] = WEIGHTS[keys[wi]];
      WEIGHTS[keys[wi]] = weightOverrides[keys[wi]];
    }
  }

  try {
    // ��ȡ������ʷ���ݣ�ʹ�û��棩
    const fundHistories = {};
    for (let i = 0; i < funds.length; i++) {
      const fund = funds[i];
      const history = await getFundNavHistory(fund.code, totalDataDays);
      if (history.length > lookbackDays + 5) {
        fundHistories[fund.code] = history;
      }
      await new Promise(function(r) { setTimeout(r, 100); });
    }

    const fundCodes = Object.keys(fundHistories);
    if (fundCodes.length === 0) return null;

    const allDates = [];
    const firstFund = fundHistories[fundCodes[0]];
    for (let d = 0; d < firstFund.length; d++) {
      allDates.push(firstFund[d].date);
    }

    const results = [];
    const startIdx = lookbackDays;
    const endIdx = Math.min(allDates.length - 5, startIdx + backtestDays);

    for (let dayIdx = startIdx; dayIdx < endIdx; dayIdx++) {
      const scored = [];
      for (let fi = 0; fi < fundCodes.length; fi++) {
        const code = fundCodes[fi];
        const f = funds.find(function(ff) { return ff.code === code; });
        if (!f) continue;
        const historySlice = fundHistories[code].slice(0, dayIdx + 1);
        const indicators = calcIndicators(historySlice);
        if (historySlice.length > 0) indicators.navs = historySlice.map(function(r) { return r.nav; });
        // 回测时强制标记为 active
        const backtestFund = Object.assign({}, f, {
          status: "active",
          dailyLimit: f.dailyLimit > 0 ? f.dailyLimit : 10
        });
        const result = scoreFund(backtestFund, indicators, null);
        scored.push({ code: code, name: f.name, score: result.score });
      }

      const available = scored.filter(function(f) { return f.score > 0; });
      available.sort(function(a, b) { return b.score - a.score; });
      const picked = available.slice(0, topN);

      const dayResult = { avgReturn5d: 0, count: 0 };
      for (let pi = 0; pi < picked.length; pi++) {
        const pf = picked[pi];
        const navHistory = fundHistories[pf.code];
        const navAtPick = navHistory[dayIdx] ? navHistory[dayIdx].nav : null;
        const navAfter5 = navHistory[dayIdx + 5] ? navHistory[dayIdx + 5].nav : null;
        if (navAtPick && navAfter5) {
          dayResult.avgReturn5d += ((navAfter5 - navAtPick) / navAtPick) * 100;
          dayResult.count++;
        }
      }
      if (dayResult.count > 0) dayResult.avgReturn5d = r2(dayResult.avgReturn5d / dayResult.count);
      results.push(dayResult);
    }

    const valid = results.filter(function(r) { return r.count > 0; });
    const wins = valid.filter(function(r) { return r.avgReturn5d > 0; }).length;
    const totalRet = valid.reduce(function(s, r) { return s + r.avgReturn5d; }, 0);
    const avgRet = valid.length > 0 ? r2(totalRet / valid.length) : 0;
    const winRate = valid.length > 0 ? r2((wins / valid.length) * 100) : 0;

    return { avgReturn5d: avgRet, winRate5d: winRate, days: valid.length, score: r2(avgRet * winRate / 100) };

  } finally {
    // �ָ�ԭʼȨ��
    if (originalWeights) {
      const restoreKeys = Object.keys(originalWeights);
      for (let rki = 0; rki < restoreKeys.length; rki++) {
        WEIGHTS[restoreKeys[rki]] = originalWeights[restoreKeys[rki]];
      }
    }
  }
}

/**
 * Ȩ���Ż������������ؼ�����
 * @param {Array} funds - �����б�
 * @param {Object} config - �ز�����
 */
async function runWeightOptimization(funds, config) {
  console.log("[Ȩ���Ż�] ��ʼ��������...");
  console.log("");

  // ������������6���ؼ�������
  const grid = {
    yearReturn:     [0.1, 0.2, 0.3, 0.5],
    sharpeRatio:    [2.0, 3.0, 4.0, 5.0],
    maxDrawdown:    [0.06, 0.12, 0.2],
    drawdown:       [0.8, 1.5, 2.5],
    maDeviation:    [0.6, 1.2, 2.0],
    volatility:     [-0.2, -0.4, -0.8]
  };

  // �����������
  const combos = [];
  const keys = Object.keys(grid);
  function generateCombos(idx, current) {
    if (idx === keys.length) {
      combos.push(Object.assign({}, current));
      return;
    }
    const key = keys[idx];
    for (let vi = 0; vi < grid[key].length; vi++) {
      current[key] = grid[key][vi];
      generateCombos(idx + 1, current);
    }
  }
  generateCombos(0, {});

  console.log("[Ȩ���Ż�] �� " + combos.length + " ��Ȩ�����");
  console.log("[Ȩ���Ż�] ��������: " + keys.join(", "));
  console.log("");

  // ����ÿ�����
  const results = [];
  for (let ci = 0; ci < combos.length; ci++) {
    const combo = combos[ci];
    const btResult = await runBacktestSilent(funds, config, combo);
    if (btResult) {
      results.push({ weights: combo, result: btResult });
    }
    // ������ʾ
    if ((ci + 1) % 50 === 0 || ci === combos.length - 1) {
      console.log("[Ȩ���Ż�] ����: " + (ci + 1) + "/" + combos.length);
    }
  }

  // �� score (avgReturn5d �� winRate5d / 100) ��������
  results.sort(function(a, b) { return b.result.score - a.result.score; });

  // ��� Top 5
  console.log("");
  console.log("=== Ȩ���Ż���� Top 5 ===");
  console.log("");
  const top5 = results.slice(0, 5);
  for (let ti = 0; ti < top5.length; ti++) {
    const tr = top5[ti];
    console.log("#" + (ti + 1) + " �ۺϵ÷�: " + tr.result.score + " | 5������: " + tr.result.avgReturn5d + "% | ʤ��: " + tr.result.winRate5d + "% | " + tr.result.days + "��");
    console.log("   Ȩ��: " + keys.map(function(k) { return k + "=" + tr.weights[k]; }).join(", "));
    console.log("");
  }

  // ��ǰȨ�صĻ�׼
  const baseline = await runBacktestSilent(funds, config, null);
  if (baseline) {
    console.log("��ǰȨ�ػ�׼: �÷�=" + baseline.score + " | 5������=" + baseline.avgReturn5d + "% | ʤ��=" + baseline.winRate5d + "%");
    if (top5.length > 0 && top5[0].result.score > baseline.score) {
      console.log("����Ȩ�رȵ�ǰ����: " + r2(top5[0].result.score - baseline.score) + " ��");
    } else {
      console.log("��ǰȨ���������ţ��������");
    }
  }

  // ������
  const OPT_FILE = path.join(__dirname, "..", "data", "weight-optimization.json");
  try {
    fs.writeFileSync(OPT_FILE, JSON.stringify({ date: new Date().toISOString(), baseline: baseline, top5: top5, totalCombos: combos.length }, null, 2), "utf-8");
    console.log("");
    console.log("[Ȩ���Ż�] ����ѱ��浽 data/weight-optimization.json");
    console.log("ʹ�� --optimize-weights --apply ����Ӧ������Ȩ��");
  } catch(e) {
    console.warn("[Ȩ���Ż�] ����ʧ��:", e.message);
  }

  return { baseline: baseline, top5: top5 };
}

module.exports = { runBacktest, runWeightOptimization };