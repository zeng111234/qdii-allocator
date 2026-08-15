/**
 * 历史记录追踪模块
 * 管理推荐历史、计算成功率、回填后续收益
 */

const { normalizeDate, round2, addDaysToDate: _addDaysToDate, daysBetween } = require("./utils");
const fs = require("fs");
const path = require("path");

const HISTORY_FILE = path.join(__dirname, "..", "data", "history.json");
const CURRENT_STRATEGY_VERSION = "allocation-v2.4-monthly-alpha-gate";

/**
 * 获取近期推荐记录（用于轮动机制）
 * @returns {Object} { fundCode: consecutiveDays }
 */
function getRecentPicks() {
  try {
    if (!fs.existsSync(HISTORY_FILE)) return {};
    const data = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf-8"));
    if (!data.records || data.records.length === 0) return {};
    const picks = {};
    const records = data.records.slice(-5);
    for (let i = records.length - 1; i >= 0; i--) {
      const rec = records[i];
      const allocs = rec.allocations || rec.ranked || [];
      for (let j = 0; j < allocs.length; j++) {
        const code = allocs[j].code;
        if (!picks[code]) picks[code] = 0;
        picks[code]++;
      }
    }
    return picks;
  } catch (err) {
    console.warn("[策略] 加载近期推荐失败，轮动机制将失效:", err.message);
    return {};
  }
}

/**
 * 加载历史上下文（用于评分因子）
 * 计算每只基金的历史推荐成功率
 * @param {Array} funds - 基金列表
 * @returns {Object} { fundCode: { successRate, appearances, successes } }
 */
function loadHistoryContext(funds) {
  try {
    if (!fs.existsSync(HISTORY_FILE)) return {};
    const data = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf-8"));
    if (!data.records || data.records.length === 0) return {};

    const contextMap = {};
    const recentRecords = data.records.slice(-10);

    for (let i = 0; i < funds.length; i++) {
      const code = funds[i].code;
      let appearances = 0;
      let successes = 0;

      for (let j = 0; j < recentRecords.length; j++) {
        const rec = recentRecords[j];
        const allocs = rec.allocations || rec.ranked || [];
        const alloc = allocs.find(a => a.code === code);
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
    console.warn("[历史] 加载历史数据失败:", err.message);
    return {};
  }
}

/**
 * 保存本次推荐到历史记录
 * @param {Object} result - 排名结果
 * @param {Array} allScored - 所有评分过的基金
 */
function saveHistory(result, allScored) {
  try {
    let data = { records: [] };
    if (fs.existsSync(HISTORY_FILE)) {
      data = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf-8"));
    }

    const record = {
      date: result.date,
      budget: result.budget,
      strategy: result.strategyName,
      budgetInfo: result.budgetInfo || null,
      marketTemperature: result.marketTemperature || null,
      totalRanked: result.totalRanked,
      allAvailable: result.allAvailable,
      ranked: result.ranked.map(function (f) {
        return {
          rank: f.rank,
          code: f.code,
          name: f.name,
          type: f.type,
          score: f.score,
          reason: f.reason,
          yearReturn: f.yearReturn || null,
          indicators: f.indicators
            ? {
                drawdown: f.indicators.drawdown,
                maDeviation: f.indicators.maDeviation,
                recent5Change: f.indicators.recent5Change,
                volatility: f.indicators.volatility,
                annualizedReturn: f.indicators.annualizedReturn,
                threeYearReturn: f.indicators.threeYearReturn,
                sharpeRatio: f.indicators.sharpeRatio,
                maxDrawdown: f.indicators.maxDrawdown,
                longTermTrend: f.indicators.longTermTrend
              }
            : null,
          followUp5dReturn: null,
          followUp10dReturn: null
        };
      }),
      allScores: allScored.map(function (f) {
        return { code: f.code, name: f.name, score: f.score, status: f.status };
      })
    };

    // 同一天只保留一条记录
    let todayIndex = -1;
    for (let t = 0; t < data.records.length; t++) {
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
    console.log("[历史] 已保存第" + data.records.length + "条记录");
  } catch (err) {
    console.warn("[历史] 保存失败:", err.message);
  }
}

function saveRecommendationPlan(plan) {
  try {
    let data = { records: [] };
    if (fs.existsSync(HISTORY_FILE)) data = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf-8"));
    if (!Array.isArray(data.records)) data.records = [];
    const planKind = "BASE_RESEARCH";
    const previous = data.records.find(function (record) {
      const existingKind = record.planKind || (record.strategy === "RecommendationPlan" ? "BASE_RESEARCH" : "LEGACY");
      return record.date === plan.asOf && existingKind === planKind;
    });
    const priorReturns = {};
    ((previous && previous.ranked) || []).forEach(function (candidate) { priorReturns[candidate.code] = candidate; });
    const record = {
      date: plan.asOf,
      strategy: "RecommendationPlan",
      planKind: planKind,
      strategyVersion: plan.strategyVersion || CURRENT_STRATEGY_VERSION,
      allocationWeek: plan.allocationWeek || null,
      action: plan.action,
      budget: plan.budget,
      pauseReasons: Array.isArray(plan.pauseReasons) ? plan.pauseReasons : [],
      dataFreshness: plan.dataFreshness,
      signalHealth: plan.signalHealth,
      liveAcceptance: plan.liveAcceptance || null,
      ranked: (plan.candidates || []).map(function (candidate, index) {
        const prior = priorReturns[candidate.code] || {};
        return {
          rank: index + 1, code: candidate.code, name: candidate.name,
          score: candidate.marketScore, suitabilityScore: candidate.suitabilityScore,
          proposedAmount: candidate.proposedAmount, blockedBy: candidate.blockedBy,
          followUp5dReturn: prior.followUp5dReturn === undefined ? null : prior.followUp5dReturn,
          followUp10dReturn: prior.followUp10dReturn === undefined ? null : prior.followUp10dReturn
        };
      })
    };
    data.records = data.records.filter(function (record) {
      const existingKind = record.planKind || (record.strategy === "RecommendationPlan" ? "BASE_RESEARCH" : "LEGACY");
      return record.date !== plan.asOf || existingKind !== planKind;
    });
    data.records.push(record);
    data.records.sort(function (a, b) { return a.date.localeCompare(b.date); });
    if (data.records.length > 60) data.records = data.records.slice(-60);
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(data, null, 2), "utf-8");
    return record;
  } catch (error) {
    console.warn("[历史] 保存统一推荐计划失败:", error.message);
    return null;
  }
}

/**
 * 回填历史记录的 followUp5dReturn 和 followUp10dReturn
 * 使用 nav-cache 中的实际净值数据计算推荐后的实际收益
 * @param {Object} navCache - 净值缓存
 * @returns {number} 回填的记录数
 */
function backfillFollowUp(navCache) {
  if (!navCache) return 0;
  try {
    if (!fs.existsSync(HISTORY_FILE)) return 0;
    const data = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf-8"));
    if (!data.records || data.records.length === 0) return 0;

    let updated = 0;
    let changed = false;

    for (let i = 0; i < data.records.length; i++) {
      const rec = data.records[i];
      // 标准化日期格式
      const recDate = normalizeDate(rec.date);
      if (recDate !== rec.date) {
        rec.date = recDate;
        changed = true;
      }

      const allocs = rec.ranked || [];
      for (let j = 0; j < allocs.length; j++) {
        const alloc = allocs[j];
        // 只回填 null 的字段
        if (alloc.followUp5dReturn !== null && alloc.followUp10dReturn !== null) continue;

        const navs = navCache[alloc.code];
        if (!navs || navs.length === 0) continue;

        // 找到推荐日的净值
        const recNav = navs.find(function (n) {
          return n.date === recDate;
        });
        if (!recNav) continue;

        // 找5个交易日后的净值
        if (alloc.followUp5dReturn === null) {
          let recIdx = -1;
          for (let r = 0; r < navs.length; r++) {
            if (navs[r].date === recDate) {
              recIdx = r;
              break;
            }
          }
          let nav5 = null;
          if (recIdx >= 0 && navs[recIdx + 5]) {
            nav5 = navs[recIdx + 5];
          }
          if (!nav5) {
            for (let k = 0; k < navs.length; k++) {
              const diff = daysBetween(recDate, navs[k].date);
              if (diff >= 4 && diff <= 6) {
                nav5 = navs[k];
                break;
              }
            }
          }
          if (nav5) {
            alloc.followUp5dReturn = round2(((nav5.nav - recNav.nav) / recNav.nav) * 100);
            updated++;
          }
        }

        // 找10个交易日后的净值
        if (alloc.followUp10dReturn === null) {
          let recIdx10 = -1;
          for (let r2 = 0; r2 < navs.length; r2++) {
            if (navs[r2].date === recDate) {
              recIdx10 = r2;
              break;
            }
          }
          let nav10 = null;
          if (recIdx10 >= 0 && navs[recIdx10 + 10]) {
            nav10 = navs[recIdx10 + 10];
          }
          if (!nav10) {
            for (let k2 = 0; k2 < navs.length; k2++) {
              const diff2 = daysBetween(recDate, navs[k2].date);
              if (diff2 >= 9 && diff2 <= 12) {
                nav10 = navs[k2];
                break;
              }
            }
          }
          if (nav10) {
            alloc.followUp10dReturn = round2(((nav10.nav - recNav.nav) / recNav.nav) * 100);
            updated++;
          }
        }
      }
    }

    if (changed || updated > 0) {
      fs.writeFileSync(HISTORY_FILE, JSON.stringify(data, null, 2), "utf-8");
      console.log("[历史] 回填完成: " + updated + "条收益数据, 日期格式已标准化");
    }
    return updated;
  } catch (err) {
    console.warn("[历史] 回填失败:", err.message);
    return 0;
  }
}

module.exports = {
  HISTORY_FILE,
  getRecentPicks,
  loadHistoryContext,
  saveHistory,
  saveRecommendationPlan,
  backfillFollowUp
};
