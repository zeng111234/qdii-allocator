/**
 * 动态策略执行层
 * 编排评分、历史、持仓感知，输出最终排名
 *
 * 评分系统 → scorer.js
 * 历史追踪 → history-tracker.js
 */

const { getFundNavHistory, calcIndicators, getFundBasicInfo } = require("./fund-data");
const { scoreFund, WEIGHTS, rankTopN, applyRotation } = require("./scorer");
const { getRecentPicks, loadHistoryContext, saveHistory, backfillFollowUp } = require("./history-tracker");
const { formatLocalDate, round1, round2 } = require("./utils");
const fs = require("fs");
const path = require("path");

async function allocateDynamic(budget, funds, config) {
  const lookbackDays = config.lookbackDays || 750; // 默认3年
  const topN = config.topN || 10;
  const minPurchase = config.minPurchase || 10;
  const enableHistory = config.enableHistory !== false;
  const externalSignals = config.externalSignals || null;
  const externalSignalMaxScore = config.externalSignalMaxScore || 3;

  // 获取新闻情绪
  let newsSentiment = null;
  try {
    const { getNewsSentiment } = require("./fund-data");
    newsSentiment = await getNewsSentiment();
    console.log(
      "[新闻情绪] " +
        newsSentiment.items +
        "条新闻, 情绪=" +
        newsSentiment.overall +
        " (+" +
        newsSentiment.positive +
        "/-" +
        newsSentiment.negative +
        "/" +
        newsSentiment.neutral +
        "中性)"
    );
    if (newsSentiment.headlines.length > 0) {
      console.log("[新闻头条] " + newsSentiment.headlines.slice(0, 3).join(" | "));
    }
  } catch (e) {
    console.warn("[新闻情绪] 获取失败:", e.message);
  }

  // [fix] 获取估值数据（PE + VIX）
  let valuationData = null;
  try {
    const { getValuationData } = require("./fund-data");
    valuationData = await getValuationData();
    console.log("[估值] VIX=" + (valuationData.vix || "N/A") + " 市场=" + valuationData.overall);
  } catch (e) {
    console.warn("[估值] 获取失败:", e.message);
  }

  // [fix] 获取市场温度（用于定投金额建议）
  let marketTemp = null;
  try {
    const { getMarketTemperature } = require("./fund-data");
    marketTemp = await getMarketTemperature();
    console.log(
      "[定投] 市场温度=" + marketTemp.temperature + "(" + marketTemp.level + ") 建议倍数=" + marketTemp.multiplier + "x"
    );
    if (marketTemp.reason !== "市场正常") console.log("[定投] " + marketTemp.reason);
  } catch (e) {
    console.warn("[定投] 市场温度获取失败:", e.message);
  }

  console.log("[动态策略] 获取基金数据和限购信息...");
  console.log(
    "[动态策略] lookback=" + lookbackDays + "天（约" + Math.round(lookbackDays / 250) + "年）数据，Top" + topN
  );

  // Step 1: 获取限购+溢价+收益率信息
  const purchaseInfoMap = {};
  const premiumInfoMap = {};
  try {
    const { batchFetch } = require("./utils");
    const basicResults = await batchFetch(
      funds,
      async fund => {
        const info = await getFundBasicInfo(fund.code);
        return { code: fund.code, info: info };
      },
      { concurrency: 5, delayMs: 100 }
    );

    for (let i = 0; i < basicResults.length; i++) {
      if (basicResults[i] && basicResults[i].error) continue; // 跳过失败的
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
    const highPremium = Object.entries(premiumInfoMap).filter(function (e) {
      return e[1].premiumRate > 3;
    });
    if (highPremium.length > 0) {
      console.log("[溢价] " + highPremium.length + "只基金溢价>3%，已降权");
    }
    const stalePremium = Object.entries(premiumInfoMap).filter(function (e) {
      return e[1].premiumStale;
    });
    if (stalePremium.length > 0) {
      console.warn("[数据] " + stalePremium.length + "只基金估值过期（非当天），溢价率已置零");
    }
  } catch (err) {
    console.warn("[动态策略] 获取基金信息失败，使用默认值:", err.message);
  }

  // Step 2: 更新基金状态 + 检测限购变化
  let fundChanges = [];
  const updatedFunds = funds.map(fund => {
    const info = purchaseInfoMap[fund.code];
    if (info) {
      const changes = [];
      if (info.status === "suspended" && fund.status === "active") {
        changes.push({ type: "suspended", from: fund.status, to: "suspended", message: fund.name + " 暂停申购" });
      } else if (info.status === "active" && fund.status === "suspended") {
        changes.push({ type: "restored", from: "suspended", to: "active", message: fund.name + " 恢复申购" });
      }
      if (info.limit && info.limit > 0 && fund.dailyLimit > 0 && info.limit < fund.dailyLimit) {
        changes.push({
          type: "limit_down",
          from: fund.dailyLimit,
          to: info.limit,
          message: fund.name + " 限购从" + fund.dailyLimit + "降到" + info.limit
        });
      } else if (info.limit && info.limit > 0 && fund.dailyLimit > 0 && info.limit > fund.dailyLimit) {
        changes.push({
          type: "limit_up",
          from: fund.dailyLimit,
          to: info.limit,
          message: fund.name + " 限购从" + fund.dailyLimit + "升到" + info.limit
        });
      }
      if (changes.length > 0) {
        fundChanges = fundChanges.concat(
          changes.map(function (c) {
            c.code = fund.code;
            return c;
          })
        );
      }

      const updated = {
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
      const fundsFilePath = path.join(__dirname, "..", "data", "funds.json");
      const fundsFileData = JSON.parse(fs.readFileSync(fundsFilePath, "utf-8"));
      for (let ci = 0; ci < updatedFunds.length; ci++) {
        const uf = updatedFunds[ci];
        const existing = fundsFileData.funds.find(function (f) {
          return f.code === uf.code;
        });
        if (existing) {
          if (uf.dailyLimit !== existing.dailyLimit) existing.dailyLimit = uf.dailyLimit;
          if (uf.status !== existing.status) existing.status = uf.status;
          if (uf.minPurchase !== existing.minPurchase) existing.minPurchase = uf.minPurchase;
        }
      }
      fs.writeFileSync(fundsFilePath, JSON.stringify(fundsFileData, null, 2), "utf-8");
      console.log("[限购监控] 检测到 " + fundChanges.length + " 项变化，已自动更新 funds.json");
      for (let fci = 0; fci < fundChanges.length; fci++) {
        console.log("  ⚠️ " + fundChanges[fci].message);
      }
    } catch (e) {
      console.warn("[限购监控] 更新 funds.json 失败:", e.message);
    }
  }

  // Step 3: 加载历史数据
  let historyContextMap = {};
  if (enableHistory) {
    historyContextMap = loadHistoryContext(updatedFunds);
  }

  // Step 4: 获取K线数据并评分（3年数据）
  // [修复] 原问题：26只基金串行获取，每只间隔300ms，总耗时30-60秒。改用batchFetch并发
  console.log("[动态策略] 获取" + updatedFunds.length + "只基金K线数据 (" + lookbackDays + "天)...");
  const { batchFetch } = require("./utils");
  const fetchResults = await batchFetch(
    updatedFunds,
    async function (fund) {
      const history = await getFundNavHistory(fund.code, lookbackDays);
      const indicators = calcIndicators(history);
      if (history.length > 0) {
        indicators.navs = history.map(function (d) {
          return d.nav;
        });
      }
      return { fund: fund, history: history, indicators: indicators };
    },
    { concurrency: 3, delayMs: 200 }
  );

  const fundDataPairs = [];
  let fetchFailCount = 0;
  for (let ki = 0; ki < fetchResults.length; ki++) {
    const r = fetchResults[ki];
    if (r && r.error) {
      fetchFailCount++;
      console.warn("[动态策略] 基金 " + (r.item && r.item.name ? r.item.name : "?") + " 获取失败: " + r.error);
      continue;
    }
    if (r && r.history && r.history.length < 10) {
      fetchFailCount++;
      console.warn(
        "[动态策略] 基金 " + r.fund.name + "(" + r.fund.code + ") 数据不足: " + r.history.length + "条记录，需要>=10"
      );
    }
    if (r) fundDataPairs.push(r);
  }
  if (fetchFailCount > 0) {
    console.warn("[动态策略] " + fetchFailCount + "只基金数据不足，将被排除评分");
  }

  const recentPicksMap = getRecentPicks();
  const scored = fundDataPairs.map(({ fund, indicators }) => {
    const histCtx = historyContextMap[fund.code] || null;
    const premiumData = premiumInfoMap[fund.code] || null;
    const result = scoreFund(
      fund,
      indicators,
      histCtx,
      recentPicksMap,
      premiumData,
      externalSignals,
      externalSignalMaxScore,
      { newsSentiment: newsSentiment, valuationData: valuationData }
    );
    if (premiumData) {
      if (premiumData.yearReturn) indicators.yearReturn = premiumData.yearReturn;
      if (premiumData.threeYearReturn) indicators.threeYearReturn = premiumData.threeYearReturn;
      if (premiumData.yearReturn && !indicators.annualizedReturn) {
        indicators.annualizedReturn = premiumData.yearReturn;
      }
    }
    return {
      ...fund,
      ...result,
      yearReturn: premiumData && premiumData.yearReturn !== null ? premiumData.yearReturn : null
    };
  });

  // Step 5: TopN排名
  const available = scored.filter(f => f.score > 0);
  const suspended = scored.filter(f => f.score <= 0);
  const dataMissing = scored.filter(f => f.reason && f.reason.indexOf("排除") >= 0);

  for (let j = 0; j < available.length; j++) {
    const f = available[j];
    if (f._purchaseRawStatus && f._purchaseRawStatus !== "开放申购") {
      console.log("[限购] " + f.name + "(" + f.code + ") -> " + f._purchaseRawStatus);
    }
  }

  const rotationApplied = applyRotation(available, recentPicksMap, topN);
  const ranked = rankTopN(rotationApplied, topN, minPurchase);
  const totalFunds = ranked.length;

  const budgetInfo = { budget: budget, label: "默认定投", avgScore: 0 };
  if (ranked.length > 0) {
    const avgScore =
      ranked.reduce(function (s, f) {
        return s + f.score;
      }, 0) / ranked.length;
    budgetInfo.avgScore = round2(avgScore);
    if (avgScore >= 15) budgetInfo.label = "极佳机会";
    else if (avgScore >= 12) budgetInfo.label = "良好机会";
    else if (avgScore >= 10) budgetInfo.label = "正常机会";
    else budgetInfo.label = "谨慎观望";
    budgetInfo.budget = budget;
  }

  const allRanked = available.map(function (f, i) {
    return {
      rank: i + 1,
      code: f.code,
      name: f.name,
      type: f.type,
      score: f.score,
      dailyLimit: f.dailyLimit,
      yearReturn:
        f.yearReturn !== null && f.yearReturn !== undefined
          ? f.yearReturn
          : f.indicators
            ? f.indicators.yearReturn
            : null,
      sharpeRatio: f.indicators ? f.indicators.sharpeRatio : null,
      maxDrawdown: f.indicators ? f.indicators.maxDrawdown : null,
      longTermTrend: f.indicators ? f.indicators.longTermTrend : null,
      _purchaseStatus: f._purchaseStatus,
      externalSignal: f.externalSignal || null
    };
  });

  // [fix] 市场温度影响建议投入金额
  if (marketTemp && budget > 0) {
    budgetInfo.temperature = marketTemp.temperature;
    budgetInfo.temperatureLevel = marketTemp.level;
    budgetInfo.multiplier = marketTemp.multiplier;
    budgetInfo.adjustedBudget = Math.round(budget * marketTemp.multiplier);
  }

  // [fix] 买入开关：基于市场温度+评分决定是否建议买入
  let buySignal = "GO";
  const buySignalReasons = [];
  const temp = marketTemp ? marketTemp.temperature : 50;
  const avg = budgetInfo.avgScore || 0;

  if (temp >= 80 || avg < 8) {
    buySignal = "STOP";
    if (temp >= 80) buySignalReasons.push("市场极热(温度" + temp + ")");
    if (avg < 8) buySignalReasons.push("评分极低(均分" + round2(avg) + ")");
    budgetInfo.budget = 0;
    budgetInfo.label = "⏸ 建议观望";
  } else if (temp >= 65 || avg < 12) {
    buySignal = "CAUTION";
    if (temp >= 65) buySignalReasons.push("市场偏热(温度" + temp + ")");
    if (avg < 12) buySignalReasons.push("评分偏低(均分" + round2(avg) + ")");
    budgetInfo.budget = Math.round(budget * 0.5);
    budgetInfo.label = "⚠ 谨慎投入";
  }

  budgetInfo.buySignal = buySignal;
  budgetInfo.buySignalReason = buySignalReasons.length > 0 ? buySignalReasons.join("，") : "市场正常，可正常投入";

  const result = {
    budget,
    strategy: "dynamic",
    budgetInfo: budgetInfo,
    strategyName: "智能动态策略(Top" + topN + " 排名)",
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
    newsSentiment: newsSentiment,
    fundChanges: fundChanges,
    valuationData: valuationData,
    marketTemperature: marketTemp
  };

  // Step 5.5: 持仓感知 + 分数加权分配
  try {
    const portfolioData = loadPortfolioSafe();
    if (portfolioData && portfolioData.holdings && portfolioData.holdings.length > 0) {
      applyPortfolioAwareness(result, portfolioData);
    }
    if (budget > 0 && ranked.length > 0) {
      result.allocations = allocateByScore(budget, ranked, minPurchase);
      const totalAllocated = result.allocations.reduce(function (s, a) {
        return s + a.allocated;
      }, 0);
      result.totalAllocated = Math.round(totalAllocated * 100) / 100;
      result.leftover = Math.round((budget - totalAllocated) * 100) / 100;
    }
  } catch (e) {
    console.warn("[分配] 持仓感知/分数分配失败:", e.message);
  }

  // Step 6: 自动创建投资假设（受 Vibe-Trading 启发）
  try {
    const hypothesisEngine = require("./hypothesis-engine");
    const navCache = require("./utils").loadNavCache();
    // 为 Top5 推荐自动创建假设
    const topPicks = ranked.slice(0, 5);
    for (let hi = 0; hi < topPicks.length; hi++) {
      const pick = topPicks[hi];
      // 检查是否已有活跃假设
      const existing = hypothesisEngine.loadHypotheses();
      const hasActive = existing.hypotheses.some(function (eh) {
        return eh.fundCode === pick.code && eh.status === "active";
      });
      if (!hasActive) {
        // 优化后的假设类型判断逻辑：基于多个因子综合判断
        let type = hypothesisEngine.HYPOTHESIS_TYPES.TREND_FOLLOWING; // 默认趋势跟踪

        if (pick.indicators) {
          const drawdown = pick.indicators.drawdown || 0;
          const volatility = pick.indicators.volatility || 0;
          const sharpe = pick.indicators.sharpe || 0;
          const recentReturn = pick.indicators.recentReturn || 0;
          const daysSinceHigh = pick.indicators.daysSinceHigh || 0;

          // 均值回归：超跌反弹（回撤大、波动率适中、近期跌幅大）
          if (drawdown < -10 && volatility < 20 && recentReturn < -5) {
            type = hypothesisEngine.HYPOTHESIS_TYPES.MEAN_REVERSION;
          }
          // 稀缺溢价：限购额度低、夏普比率高、近期表现稳定
          else if (pick.dailyLimit <= 100 && sharpe > 1.0 && Math.abs(recentReturn) < 10) {
            type = hypothesisEngine.HYPOTHESIS_TYPES.SCARCITY_PREMIUM;
          }
          // 趋势跟踪：趋势强劲、回撤小、近期表现好
          else if (drawdown > -5 && recentReturn > 0 && daysSinceHigh < 30) {
            type = hypothesisEngine.HYPOTHESIS_TYPES.TREND_FOLLOWING;
          }
          // 外部信号：如果外部信号得分高
          else if (pick.externalSignalScore > 10) {
            type = hypothesisEngine.HYPOTHESIS_TYPES.EXTERNAL_SIGNAL;
          }
          // 分散配置：如果基金与持仓相关性低
          else if (pick.correlationScore && pick.correlationScore < 0.3) {
            type = hypothesisEngine.HYPOTHESIS_TYPES.DIVERSIFICATION;
          }
        }

        // 为不同类型的假设设置不同的验证条件
        let conditions;
        switch (type) {
          case hypothesisEngine.HYPOTHESIS_TYPES.MEAN_REVERSION:
            // 均值回归：目标收益较低，止损较宽，时间较短
            conditions = { target: 5, stopLoss: -10, timeHorizon: 14 };
            break;
          case hypothesisEngine.HYPOTHESIS_TYPES.SCARCITY_PREMIUM:
            // 稀缺溢价：目标收益中等，止损较宽，时间较长
            conditions = { target: 8, stopLoss: -10, timeHorizon: 30 };
            break;
          case hypothesisEngine.HYPOTHESIS_TYPES.TREND_FOLLOWING:
            // 趋势跟踪：目标收益较高，止损较窄，时间中等
            conditions = { target: 10, stopLoss: -6, timeHorizon: 21 };
            break;
          case hypothesisEngine.HYPOTHESIS_TYPES.EXTERNAL_SIGNAL:
            // 外部信号：目标收益中等，止损较窄，时间较短
            conditions = { target: 7, stopLoss: -7, timeHorizon: 14 };
            break;
          case hypothesisEngine.HYPOTHESIS_TYPES.DIVERSIFICATION:
            // 分散配置：目标收益较低，止损较宽，时间较长
            conditions = { target: 5, stopLoss: -12, timeHorizon: 30 };
            break;
          default:
            conditions = { target: 8, stopLoss: -8, timeHorizon: 30 };
        }

        const thesis =
          "系统推荐#" +
          (hi + 1) +
          "，分数" +
          round2(pick.score) +
          (pick.reason ? "。" + pick.reason.substring(0, 80) : "");
        hypothesisEngine.createHypothesis(pick.code, pick.name, type, thesis, conditions);
      }
    }
    // 更新已有假设的追踪收益
    hypothesisEngine.updateHypothesisReturns(navCache);
  } catch (e) {
    // 假设引擎非关键模块，失败不影响主流程
  }

  // Step 7: 保存历史记录
  if (enableHistory) {
    saveHistory(result, scored);
  }

  return result;
}

function formatDynamicResult(result) {
  const lines = [];
  lines.push("[今日QDII投资排名] " + result.date);
  lines.push("");
  lines.push("参考预算：" + result.budget + "元（自行确定金额）");
  if (result.budgetInfo && result.budgetInfo.label) {
    lines.push("机会评级：" + result.budgetInfo.label + " (Top均分" + result.budgetInfo.avgScore + ")");
  }
  if (result.budgetInfo && result.budgetInfo.buySignal) {
    const sig = result.budgetInfo.buySignal;
    const sigEmoji = sig === "STOP" ? "🔴" : sig === "CAUTION" ? "🟡" : "🟢";
    lines.push(sigEmoji + " 买入信号：" + sig + " — " + result.budgetInfo.buySignalReason);
    if (sig === "STOP") lines.push("   ⛔ 今日不建议买入，请观望等待");
    else if (sig === "CAUTION") lines.push("   ⚠ 建议减半投入，控制风险");
  }
  lines.push("策略：" + result.strategyName + "（基于3年K线+长期指标综合评分）");
  // [fix] 显示市场温度和定投建议
  if (result.marketTemperature) {
    const mt = result.marketTemperature;
    const tempEmoji = mt.temperature <= 35 ? "❄️" : mt.temperature >= 65 ? "🔥" : "🌡️";
    const adjustedBudget = Math.round(result.budget * mt.multiplier);
    lines.push(
      tempEmoji +
        " 市场温度: " +
        mt.temperature +
        "/100 (" +
        mt.level +
        ") 建议投入: " +
        adjustedBudget +
        "元 (" +
        mt.multiplier +
        "x)"
    );
    if (mt.reason !== "市场正常") lines.push("   原因: " + mt.reason);
  }
  if (result.externalSignals) {
    if (result.externalSignals.status === "ok" || result.externalSignals.status === "cached") {
      lines.push(
        "External signals: X/RSSHub fetched " +
          result.externalSignals.items.length +
          " items and affected scoring" +
          (result.externalSignals.status === "cached" ? " (cached)" : "")
      );
    } else {
      lines.push("External signals: " + (result.externalSignals.error || "X source unavailable"));
    }
  }
  if (result.newsSentiment) {
    const ns = result.newsSentiment;
    const moodEmoji = ns.overall > 10 ? "🟢 看涨" : ns.overall < -10 ? "🔴 看跌" : "⚪ 中性";
    lines.push("📰 新闻情绪: " + moodEmoji + " (" + ns.items + "条新闻, 综合=" + ns.overall + ")");
    if (ns.headlines.length > 0) {
      lines.push("   头条: " + ns.headlines.slice(0, 3).join(" | "));
    }
  }
  lines.push("数据池：" + result.totalPool + "只基金，其中" + result.allAvailable + "只有效数据");
  lines.push("");

  if (result.fundChanges && result.fundChanges.length > 0) {
    lines.push("⚠️ 限购变化：");
    for (let fc = 0; fc < result.fundChanges.length; fc++) {
      lines.push("  " + result.fundChanges[fc].message);
    }
    lines.push("");
  }

  if (result.ranked && result.ranked.length > 0) {
    lines.push("★ Top" + result.ranked.length + " 推荐基金排名：");
    if (result.allocations && result.allocations.length > 0) {
      lines.push("分配总额：" + result.totalAllocated + "元（剩余" + result.leftover + "元未分配）");
    }
    lines.push("");
    for (let i = 0; i < result.ranked.length; i++) {
      const f = result.ranked[i];
      const ind = f.indicators || {};
      let trendEmoji = "";
      if (ind.longTermTrend === "bull") trendEmoji = "\ud83d\udfe2";
      else if (ind.longTermTrend === "bear") trendEmoji = "\ud83d\udd34";
      else trendEmoji = "\ud83d\udfe1";

      let allocInfo = "";
      if (result.allocations) {
        const alloc = result.allocations.find(function (a) {
          return a.code === f.code;
        });
        if (alloc) allocInfo = " | 分配: " + alloc.allocated + "元";
      }
      const penaltyInfo = f.portfolioPenalty ? " | 持仓降权-" + f.portfolioPenalty : "";

      lines.push(f.rank + ". " + f.name + "(" + f.code + ") " + trendEmoji);
      lines.push(
        "   得分: " +
          f.score +
          penaltyInfo +
          " | 类型: " +
          (f.type || "-") +
          " | 限购: " +
          (f.dailyLimit || "-") +
          "元" +
          allocInfo
      );
      if (ind.annualizedReturn !== null) {
        lines.push(
          "   年化: " +
            ind.annualizedReturn +
            "% | 3年: " +
            (ind.threeYearReturn || "N/A") +
            "% | 夏普: " +
            (ind.sharpeRatio || "N/A") +
            " | 最大回撤: " +
            (ind.maxDrawdown || "N/A") +
            "%"
        );
      }
      lines.push(
        "   5日: " +
          (ind.recent5Change || "N/A") +
          "% | MA偏离: " +
          (ind.maDeviation || "N/A") +
          "% | 波动: " +
          (ind.volatility || "N/A") +
          "%"
      );
      lines.push("   理由: " + (f.reason || "-"));
      lines.push("");
    }
  } else {
    lines.push(">> 今日无有效基金排名");
  }

  if (result.suspended && result.suspended.length > 0) {
    lines.push("今日跳过（不可买）：");
    for (let k = 0; k < result.suspended.length; k++) {
      const sf = result.suspended[k];
      const reasonStr = sf._purchaseRawStatus || (sf.status === "suspended" ? "暂停申购" : "限额为0");
      lines.push("  - " + sf.name + "(" + sf.code + ") -> " + reasonStr);
    }
  }

  if (result.dataMissing && result.dataMissing.length > 0) {
    lines.push("");
    lines.push("数据不足排除：");
    for (let m = 0; m < result.dataMissing.length; m++) {
      const dm = result.dataMissing[m];
      lines.push("  - " + dm.name + "(" + dm.code + ") -> " + dm.reason);
    }
  }

  lines.push("");
  lines.push("说明：得分越高 = 长期收益越好 + 风险调整越优 + 近期回撤越大");
  return lines.join("\n");
}

/**
 * 安全加载持仓数据
 */
function loadPortfolioSafe() {
  try {
    const portfolio = require("./portfolio");
    return portfolio.loadPortfolio();
  } catch (e) {
    console.warn("[策略] 加载持仓数据失败，持仓感知将跳过:", e.message);
    return null;
  }
}

/**
 * 持仓感知：如果已有持仓中某大类占比过高，降低该类型基金的评分
 * 如果某只基金已经持有较多，降低其评分（避免重仓单只）
 */
function applyPortfolioAwareness(result, portfolioData) {
  if (!result.ranked || result.ranked.length === 0) return;

  const CATEGORY_MAP = {
    纳指100: "美股科技",
    纳指生物科技: "美股科技",
    纳指科技: "美股科技",
    标普500: "美股宽基",
    标普科技: "美股宽基",
    标普消费: "美股宽基",
    标普医疗: "美股宽基",
    美股消费: "美股宽基",
    全球精选: "全球",
    全球股票: "全球",
    全球蓝筹: "全球",
    全球科技: "全球",
    全球成长: "全球",
    全球制造: "全球",
    全球资源: "全球",
    全球医疗: "全球",
    亚太精选: "亚太",
    亚太: "亚太",
    新兴市场: "亚太",
    港股精选: "港股",
    港股优选: "港股",
    恒生指数: "港股",
    德国: "欧洲",
    石油能源: "商品",
    大宗商品: "商品",
    美国REITs: "REITs",
    标普REITs: "REITs",
    全球不动产: "REITs",
    亚洲债: "债券",
    亚洲债券: "债券",
    新能源车: "主题"
  };

  function getCategory(type) {
    return CATEGORY_MAP[type] || type || "其他";
  }

  let totalValue = 0;
  const categoryValues = {};
  const codeValues = {};

  portfolioData.holdings.forEach(function (h) {
    const value = h.totalShares * (h.latestNav || h.avgCost || 0);
    totalValue += value;
    codeValues[h.code] = value;

    let fundType = "未知";
    const rankedFund = result.ranked.find(function (r) {
      return r.code === h.code;
    });
    if (rankedFund) fundType = rankedFund.type || "未知";
    else if (h.type) fundType = h.type;

    const category = getCategory(fundType);
    categoryValues[category] = (categoryValues[category] || 0) + value;
  });

  if (totalValue === 0) return;

  result.ranked.forEach(function (f) {
    let penalty = 0;
    const category = getCategory(f.type);

    const catWeight = ((categoryValues[category] || 0) / totalValue) * 100;
    // [fix] 集中度惩罚：单一类别>60%扣8分，>40%扣5分（从3/2提升）
    if (catWeight > 60) {
      penalty += 8 + (catWeight - 60) * 0.2;
      f.reason = (f.reason || "") + " [" + category + "已占" + round1(catWeight) + "%严重超配]";
    } else if (catWeight > 40) {
      penalty += 5 + (catWeight - 40) * 0.15;
      f.reason = (f.reason || "") + " [" + category + "占" + round1(catWeight) + "%偏重]";
    }

    const heldValue = codeValues[f.code] || 0;
    if (heldValue > 0) {
      const heldWeight = (heldValue / totalValue) * 100;
      if (heldWeight > 15) {
        penalty += 1.5;
        f.reason = (f.reason || "") + " [已持有" + round1(heldWeight) + "%]";
      } else if (heldWeight > 5) {
        penalty += 0.5;
      }
    }

    let catHeldCount = 0;
    for (const code in codeValues) {
      const heldFund = result.ranked.find(function (r) {
        return r.code === code;
      });
      if (heldFund && getCategory(heldFund.type) === category && codeValues[code] > 0) catHeldCount++;
    }
    if (catHeldCount >= 3) penalty += 1;

    if (penalty > 0) {
      f.score = round2(f.score - penalty);
      f.portfolioPenalty = round2(penalty);
    }
  });

  result.ranked.sort(function (a, b) {
    return b.score - a.score;
  });
  result.ranked.forEach(function (f, i) {
    f.rank = i + 1;
  });
}

/**
 * 分数加权分配：按评分高低分配预算，高分基金获得更高配额
 */
function allocateByScore(budget, ranked, minPurchase) {
  if (!ranked || ranked.length === 0) return [];
  if (!minPurchase) minPurchase = 10;

  const eligible = ranked.filter(function (f) {
    return f.score > 0;
  });
  if (eligible.length === 0) return [];

  let totalScore = 0;
  eligible.forEach(function (f) {
    const baseScore = Math.min(eligible[0].score * 0.5, 5);
    f._allocWeight = Math.max(f.score - baseScore, 0.5);
    totalScore += f._allocWeight;
  });

  const allocations = [];
  let remaining = budget;
  const typeAllocated = {};
  const TYPE_CAP_RATIO = 0.6;

  eligible.forEach(function (f) {
    const rawAlloc = budget * (f._allocWeight / totalScore);
    const cap = f.dailyLimit || 999999;
    const typeBudget = budget * TYPE_CAP_RATIO;
    const typeUsed = typeAllocated[f.type] || 0;
    const typeRemaining = Math.max(typeBudget - typeUsed, 0);

    let alloc = Math.min(rawAlloc, cap, remaining, typeRemaining);
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

  if (remaining >= minPurchase) {
    allocations.sort(function (a, b) {
      return b.score - a.score;
    });
    for (let i = 0; i < allocations.length && remaining >= minPurchase; i++) {
      const a = allocations[i];
      const cap = a.dailyLimit || 999999;
      const typeBudget = budget * TYPE_CAP_RATIO;
      const typeUsed = typeAllocated[a.type] || 0;
      const typeRemaining = Math.max(typeBudget - typeUsed, 0);

      let canAdd = Math.min(cap - a.allocated, remaining, typeRemaining);
      canAdd = Math.floor(canAdd);
      if (canAdd >= 1) {
        a.allocated += canAdd;
        remaining -= canAdd;
        typeAllocated[a.type] = (typeAllocated[a.type] || 0) + canAdd;
      }
    }
  }

  eligible.forEach(function (f) {
    delete f._allocWeight;
  });

  return allocations.filter(function (a) {
    return a.allocated > 0;
  });
}

// 向后兼容：re-export 所有公共接口
module.exports = {
  allocateDynamic,
  formatDynamicResult,
  scoreFund,
  WEIGHTS,
  rankTopN,
  backfillFollowUp
};
