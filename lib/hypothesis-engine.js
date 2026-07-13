/**
 * 假设追踪引擎 (Hypothesis Engine)
 * 受 Vibe-Trading 启发：追踪投资假设，验证其是否成立
 *
 * 核心理念：每次推荐一只基金时，系统应该明确记录：
 * - 假设内容（为什么推荐这只基金）
 * - 验证条件（什么情况下假设成立/不成立）
 * - 后续追踪（假设是否被市场验证）
 */

const fs = require("fs");
const path = require("path");
const { round2 } = require("./utils");

const HYPOTHESIS_FILE = path.join(__dirname, "..", "data", "hypotheses.json");

// ========== 假设类型定义 ==========
const HYPOTHESIS_TYPES = {
  TREND_FOLLOWING: "趋势跟踪", // 基金处于上升趋势，继续持有/买入
  MEAN_REVERSION: "均值回归", // 基金超跌，预期反弹
  SCARCITY_PREMIUM: "稀缺溢价", // 限购基金因稀缺性值得持有
  DIVERSIFICATION: "分散配置", // 降低组合相关性
  FUNDAMENTAL: "基本面驱动", // 基于基金持仓的基本面判断
  EXTERNAL_SIGNAL: "外部信号" // 来自大V/新闻/情绪的信号
};

// ========== 假设状态 ==========
const STATUS = {
  ACTIVE: "active", // 假设仍在追踪中
  VALIDATED: "validated", // 假设被市场验证（正确）
  INVALIDATED: "invalidated", // 假设被市场否定（错误）
  EXPIRED: "expired" // 超过追踪期，无法判断
};

function loadHypotheses() {
  try {
    if (fs.existsSync(HYPOTHESIS_FILE)) {
      const data = JSON.parse(fs.readFileSync(HYPOTHESIS_FILE, "utf-8"));
      // 实时重算stats，覆盖可能漂移的值
      const validatedCount = data.hypotheses.filter(h => h.status === STATUS.VALIDATED).length;
      const invalidatedCount = data.hypotheses.filter(h => h.status === STATUS.INVALIDATED).length;
      const meaningfulCount = validatedCount + invalidatedCount;

      data.stats = {
        total: data.hypotheses.length,
        active: data.hypotheses.filter(h => h.status === STATUS.ACTIVE).length,
        validated: validatedCount,
        invalidated: invalidatedCount,
        expired: data.hypotheses.filter(h => h.status === STATUS.EXPIRED).length,
        winRate: meaningfulCount > 0 ? round2((validatedCount / meaningfulCount) * 100) : null
      };
      return data;
    }
  } catch (e) {}
  return { hypotheses: [], stats: { total: 0, active: 0, validated: 0, invalidated: 0, expired: 0, winRate: null } };
}

function saveHypotheses(data) {
  try {
    fs.writeFileSync(HYPOTHESIS_FILE, JSON.stringify(data, null, 2), "utf-8");
  } catch (e) {
    console.error("[假设] 保存失败:", e.message);
  }
}

/**
 * 创建新假设
 */
function createHypothesis(fundCode, fundName, type, thesis, conditions, navCache) {
  const data = loadHypotheses();

  // 生成唯一ID：时间戳 + 随机后缀，避免碰撞
  const id = "H" + Date.now() + "-" + Math.random().toString(36).substring(2, 6);

  // 尝试从navCache获取创建时的净值
  let navAtCreation = null;
  if (navCache && navCache[fundCode] && navCache[fundCode].length > 0) {
    const latestNav = navCache[fundCode][navCache[fundCode].length - 1];
    navAtCreation = latestNav.nav;
  }

  const h = {
    id: id,
    fundCode: fundCode,
    fundName: fundName,
    type: type,
    thesis: thesis, // 假设描述
    conditions: conditions, // 验证条件 { target, stopLoss, timeHorizon }
    status: STATUS.ACTIVE,
    createdAt: new Date().toISOString(),
    navAtCreation: navAtCreation, // 从navCache获取基准净值
    validatedAt: null,
    invalidatedAt: null,
    outcome: null, // 最终结果 { return, holdingDays }
    followUpReturns: {
      // 后续追踪收益
      "3d": null,
      "7d": null,
      "14d": null,
      "30d": null
    }
  };
  data.hypotheses.push(h);
  // 注意：不再手动增加stats.total，改为实时计算
  saveHypotheses(data);
  return h;
}

/**
 * 更新假设的净值数据和后续收益
 */
function updateHypothesisReturns(navCache) {
  const data = loadHypotheses();
  let updated = 0;

  for (const h of data.hypotheses) {
    // 为所有假设（包括非active）补充navAtCreation（如果缺失）
    if (!h.navAtCreation) {
      const fundNavs = navCache[h.fundCode];
      if (fundNavs && fundNavs.length > 0) {
        const createdDate = h.createdAt.substring(0, 10);
        // 先找精确日期或之后的净值
        let navAtCreation = fundNavs.find(function (n) {
          return n.date >= createdDate;
        });
        // 如果找不到，找之前最近的净值（向前回填）
        if (!navAtCreation) {
          const beforeNavs = fundNavs.filter(n => n.date <= createdDate);
          if (beforeNavs.length > 0) {
            navAtCreation = beforeNavs[beforeNavs.length - 1];
          }
        }
        if (navAtCreation) {
          h.navAtCreation = navAtCreation.nav;
          if (h._needsNavBackfill) {
            h._needsNavBackfill = false;
            delete h._backfillNote;
          }
          updated++;
        }
      }
    }

    // 只更新active状态的假设的收益和状态
    if (h.status !== STATUS.ACTIVE) continue;

    const fundNavs = navCache[h.fundCode];
    if (!fundNavs || fundNavs.length === 0) continue;

    const createdDate = h.createdAt.substring(0, 10);
    const navAtCreation = fundNavs.find(function (n) {
      return n.date >= createdDate;
    });
    if (!navAtCreation) continue;

    // 如果navAtCreation之前为null，现在已经补充了
    if (!h.navAtCreation) {
      h.navAtCreation = navAtCreation.nav;
    }

    const latestNav = fundNavs[fundNavs.length - 1].nav;
    const daysSinceCreation = Math.floor(
      (new Date(fundNavs[fundNavs.length - 1].date) - new Date(createdDate)) / 86400000
    );

    // 计算各时段收益
    const periods = { "3d": 3, "7d": 7, "14d": 14, "30d": 30 };
    for (const key in periods) {
      const targetDate = new Date(createdDate);
      targetDate.setDate(targetDate.getDate() + periods[key]);
      const targetDateStr = targetDate.toISOString().substring(0, 10);
      // 先找精确日期或之后的净值
      let targetNav = fundNavs.find(function (n) {
        return n.date >= targetDateStr;
      });
      // 如果找不到，找之前最近的净值（向前回填）
      if (!targetNav) {
        const beforeNavs = fundNavs.filter(n => n.date <= targetDateStr);
        if (beforeNavs.length > 0) {
          targetNav = beforeNavs[beforeNavs.length - 1];
        }
      }
      if (targetNav && h.navAtCreation > 0) {
        h.followUpReturns[key] = round2(((targetNav.nav - h.navAtCreation) / h.navAtCreation) * 100);
      }
    }

    // 检查验证/否定条件
    if (h.conditions) {
      const currentReturn = round2(((latestNav - h.navAtCreation) / h.navAtCreation) * 100);

      if (h.conditions.target && currentReturn >= h.conditions.target) {
        h.status = STATUS.VALIDATED;
        h.validatedAt = new Date().toISOString();
        h.outcome = { return: currentReturn, holdingDays: daysSinceCreation };
        data.stats.validated++;
        updated++;
      } else if (h.conditions.stopLoss && currentReturn <= h.conditions.stopLoss) {
        h.status = STATUS.INVALIDATED;
        h.invalidatedAt = new Date().toISOString();
        h.outcome = { return: currentReturn, holdingDays: daysSinceCreation };
        data.stats.invalidated++;
        updated++;
      } else if (h.conditions.timeHorizon && daysSinceCreation > h.conditions.timeHorizon) {
        h.status = STATUS.EXPIRED;
        h.outcome = { return: currentReturn, holdingDays: daysSinceCreation };
        data.stats.expired++;
        updated++;
      }
    }
  }

  if (updated > 0) {
    saveHypotheses(data);
    console.log("[假设] 更新了 " + updated + " 个假设状态");
  }
  return data;
}

/**
 * 计算假设统计
 */
function getHypothesisStats() {
  const data = loadHypotheses();
  const closed = data.hypotheses.filter(function (h) {
    return h.status !== STATUS.ACTIVE;
  });

  if (closed.length === 0) {
    return {
      total: data.stats.total,
      active: data.hypotheses.filter(function (h) {
        return h.status === STATUS.ACTIVE;
      }).length,
      validated: 0,
      invalidated: 0,
      expired: 0,
      winRate: null,
      avgReturn: null,
      avgHoldingDays: null
    };
  }

  const validated = closed.filter(function (h) {
    return h.status === STATUS.VALIDATED;
  });
  const _invalidated = closed.filter(function (h) {
    return h.status === STATUS.INVALIDATED;
  });
  const meaningful = closed.filter(function (h) {
    return h.status === STATUS.VALIDATED || h.status === STATUS.INVALIDATED;
  });
  const withOutcome = closed.filter(function (h) {
    return h.outcome;
  });

  return {
    total: data.stats.total,
    active: data.hypotheses.filter(function (h) {
      return h.status === STATUS.ACTIVE;
    }).length,
    validated: data.stats.validated,
    invalidated: data.stats.invalidated,
    expired: data.stats.expired,
    winRate: meaningful.length > 0 ? round2((validated.length / meaningful.length) * 100) : null,
    avgReturn:
      withOutcome.length > 0
        ? round2(
            withOutcome.reduce(function (s, h) {
              return s + h.outcome.return;
            }, 0) / withOutcome.length
          )
        : null,
    avgHoldingDays:
      withOutcome.length > 0
        ? Math.round(
            withOutcome.reduce(function (s, h) {
              return s + h.outcome.holdingDays;
            }, 0) / withOutcome.length
          )
        : null
  };
}

/**
 * 格式化假设报告
 */
function formatHypothesisReport() {
  const data = loadHypotheses();
  const stats = getHypothesisStats();
  const lines = [];

  lines.push("=== 投资假设追踪报告 ===");
  lines.push("");
  lines.push("📊 总计: " + stats.total + " 个假设");
  lines.push(
    "   活跃: " +
      stats.active +
      " | 验证: " +
      stats.validated +
      " | 否定: " +
      stats.invalidated +
      " | 过期: " +
      stats.expired
  );
  if (stats.winRate !== null) {
    lines.push(
      "   胜率: " +
        stats.winRate +
        "% (仅统计已完结假设，排除过期) | 平均收益: " +
        stats.avgReturn +
        "% | 平均持仓: " +
        stats.avgHoldingDays +
        "天"
    );
  }
  lines.push("");

  // 活跃假设
  const active = data.hypotheses.filter(function (h) {
    return h.status === STATUS.ACTIVE;
  });
  if (active.length > 0) {
    lines.push("--- 活跃假设 ---");
    for (let i = 0; i < active.length; i++) {
      const h = active[i];
      const ret3d = h.followUpReturns["3d"] !== null ? h.followUpReturns["3d"] + "%" : "N/A";
      const ret7d = h.followUpReturns["7d"] !== null ? h.followUpReturns["7d"] + "%" : "N/A";
      lines.push("  " + h.fundName + " | " + h.type + " | 3日:" + ret3d + " 7日:" + ret7d);
      lines.push("    假设: " + h.thesis);
    }
    lines.push("");
  }

  // 已验证/否定的假设
  const closed = data.hypotheses.filter(function (h) {
    return h.status === STATUS.VALIDATED || h.status === STATUS.INVALIDATED;
  });
  if (closed.length > 0) {
    lines.push("--- 历史假设（最近10条）---");
    const recent = closed.slice(-10);
    for (let j = 0; j < recent.length; j++) {
      const ch = recent[j];
      const emoji = ch.status === STATUS.VALIDATED ? "✅" : "❌";
      const ret = ch.outcome ? ch.outcome.return + "%" : "N/A";
      lines.push("  " + emoji + " " + ch.fundName + " | " + ch.type + " | 收益:" + ret + " | " + ch.thesis);
    }
    lines.push("");
  }

  // 按类型统计
  const byType = {};
  for (let k = 0; k < data.hypotheses.length; k++) {
    const th = data.hypotheses[k];
    if (!byType[th.type]) byType[th.type] = { total: 0, validated: 0 };
    byType[th.type].total++;
    if (th.status === STATUS.VALIDATED) byType[th.type].validated++;
  }
  const typeKeys = Object.keys(byType);
  if (typeKeys.length > 0) {
    lines.push("--- 按假设类型统计 ---");
    for (let ti = 0; ti < typeKeys.length; ti++) {
      const typeName = typeKeys[ti];
      const tStats = byType[typeName];
      const tWinRate = tStats.total > 0 ? round2((tStats.validated / tStats.total) * 100) : 0;
      lines.push("  " + typeName + ": " + tStats.total + "个, 胜率" + tWinRate + "%");
    }
  }

  return lines.join("\n");
}

module.exports = {
  HYPOTHESIS_TYPES: HYPOTHESIS_TYPES,
  STATUS: STATUS,
  createHypothesis: createHypothesis,
  updateHypothesisReturns: updateHypothesisReturns,
  getHypothesisStats: getHypothesisStats,
  formatHypothesisReport: formatHypothesisReport,
  loadHypotheses: loadHypotheses
};
