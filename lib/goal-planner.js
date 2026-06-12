/**
 * 投资目标规划系统 (Goal-Directed Planning)
 * 受 Vibe-Trading 启发：设定、追踪、完成投资目标
 *
 * 目标类型：
 * - 收益目标：年化收益达到 X%
 * - 风险目标：最大回撤控制在 X% 以内
 * - 分散目标：单一市场占比不超过 X%
 * - 定投目标：连续定投 X 天
 * - 学习目标：假设胜率达到 X%
 */

const fs = require("fs");
const path = require("path");
const { round2 } = require("./utils");

const GOALS_FILE = path.join(__dirname, "..", "data", "goals.json");

const GOAL_STATUS = {
  ACTIVE: "active",
  COMPLETED: "completed",
  ABANDONED: "abandoned",
  BLOCKED: "blocked"
};

const GOAL_TEMPLATES = {
  RETURN: {
    title: "年化收益目标",
    metric: "annualized_return",
    unit: "%",
    direction: "above"
  },
  RISK: {
    title: "最大回撤控制",
    metric: "max_drawdown",
    unit: "%",
    direction: "below"
  },
  DIVERSIFY: {
    title: "分散度目标",
    metric: "max_single_type_weight",
    unit: "%",
    direction: "below"
  },
  STREAK: {
    title: "连续定投天数",
    metric: "dca_streak",
    unit: "天",
    direction: "above"
  },
  WIN_RATE: {
    title: "假设胜率目标",
    metric: "hypothesis_win_rate",
    unit: "%",
    direction: "above"
  }
};

function loadGoals() {
  try {
    if (fs.existsSync(GOALS_FILE)) {
      return JSON.parse(fs.readFileSync(GOALS_FILE, "utf-8"));
    }
  } catch (e) {}
  return { goals: [], history: [] };
}

function saveGoals(data) {
  try {
    fs.writeFileSync(GOALS_FILE, JSON.stringify(data, null, 2), "utf-8");
  } catch (e) {
    console.error("[目标] 保存失败:", e.message);
  }
}

/**
 * 创建投资目标
 */
function createGoal(template, target, deadline) {
  const data = loadGoals();
  const goal = {
    id: "G" + Date.now(),
    template: template,
    title: GOAL_TEMPLATES[template].title,
    metric: GOAL_TEMPLATES[template].metric,
    target: target,
    direction: GOAL_TEMPLATES[template].direction,
    unit: GOAL_TEMPLATES[template].unit,
    status: GOAL_STATUS.ACTIVE,
    progress: 0,
    current: null,
    createdAt: new Date().toISOString(),
    deadline: deadline || null,
    completedAt: null
  };
  data.goals.push(goal);
  saveGoals(data);
  return goal;
}

/**
 * 更新目标进度
 */
function updateGoals(portfolio, hypothesisStats, navCache) {
  const data = loadGoals();
  let updated = 0;

  for (let i = 0; i < data.goals.length; i++) {
    const goal = data.goals[i];
    if (goal.status !== GOAL_STATUS.ACTIVE) continue;

    let current = null;
    let progress = 0;

    switch (goal.metric) {
      case "annualized_return":
        if (portfolio && portfolio.holdings) {
          let totalInv = 0, totalVal = 0;
          for (let h = 0; h < portfolio.holdings.length; h++) {
            const holding = portfolio.holdings[h];
            for (let b = 0; b < holding.buys.length; b++) {
              totalInv += holding.buys[b].amount;
              totalVal += holding.buys[b].shares * (navCache[holding.code] ? navCache[holding.code][navCache[holding.code].length - 1].nav : holding.buys[b].nav);
            }
          }
          if (totalInv > 0) {
            const daysSinceStart = Math.floor((Date.now() - new Date(portfolio.startDate).getTime()) / 86400000);
            const totalReturn = (totalVal / totalInv - 1) * 100;
            current = daysSinceStart > 0 ? round2(totalReturn / daysSinceStart * 365) : 0;
            progress = goal.target > 0 ? Math.min(1, Math.max(0, current / goal.target)) : 0;
          }
        }
        break;

      case "hypothesis_win_rate":
        if (hypothesisStats && hypothesisStats.winRate !== null) {
          current = hypothesisStats.winRate;
          progress = goal.target > 0 ? Math.min(1, Math.max(0, current / goal.target)) : 0;
        }
        break;

      case "dca_streak":
        if (portfolio && portfolio.holdings) {
          const allDates = [];
          for (let hh = 0; hh < portfolio.holdings.length; hh++) {
            for (let bb = 0; bb < portfolio.holdings[hh].buys.length; bb++) {
              allDates.push(portfolio.holdings[hh].buys[bb].date);
            }
          }
          allDates.sort();
          const uniqueDates = [];
          for (let dd = 0; dd < allDates.length; dd++) {
            if (uniqueDates.indexOf(allDates[dd]) < 0) uniqueDates.push(allDates[dd]);
          }
          current = uniqueDates.length;
          progress = goal.target > 0 ? Math.min(1, current / goal.target) : 0;
        }
        break;
    }

    if (current !== null) {
      goal.current = current;
      goal.progress = round2(progress);

      if (progress >= 1 && goal.status === GOAL_STATUS.ACTIVE) {
        goal.status = GOAL_STATUS.COMPLETED;
        goal.completedAt = new Date().toISOString();
        data.history.push({
          goalId: goal.id,
          title: goal.title,
          target: goal.target,
          achieved: current,
          completedAt: goal.completedAt
        });
        console.log("🎉 目标达成: " + goal.title + " (" + current + goal.unit + " >= " + goal.target + goal.unit + ")");
      }
      updated++;
    }
  }

  if (updated > 0) saveGoals(data);
  return data;
}

/**
 * 格式化目标报告
 */
function formatGoalReport() {
  const data = loadGoals();
  const lines = [];

  lines.push("=== 投资目标追踪 ===");
  lines.push("");

  const active = data.goals.filter(function (g) { return g.status === GOAL_STATUS.ACTIVE; });
  const completed = data.goals.filter(function (g) { return g.status === GOAL_STATUS.COMPLETED; });

  if (active.length === 0 && completed.length === 0) {
    lines.push("暂无投资目标。使用 --create-goal 创建目标。");
    return lines.join("\n");
  }

  if (active.length > 0) {
    lines.push("📌 活跃目标 (" + active.length + "):");
    for (let i = 0; i < active.length; i++) {
      const g = active[i];
      let progressBar = "";
      const pct = Math.round(g.progress * 100);
      const filled = Math.round(pct / 5);
      for (let p = 0; p < 20; p++) {
        progressBar += p < filled ? "█" : "░";
      }
      const currentStr = g.current !== null ? g.current + g.unit : "N/A";
      lines.push("  " + g.title + ": " + currentStr + " / " + g.target + g.unit);
      lines.push("    " + progressBar + " " + pct + "%" + (g.deadline ? " (截止: " + g.deadline + ")" : ""));
    }
    lines.push("");
  }

  if (completed.length > 0) {
    lines.push("✅ 已达成 (" + completed.length + "):");
    for (let j = 0; j < completed.length; j++) {
      const cg = completed[j];
      lines.push("  " + cg.title + ": " + cg.current + cg.unit + " >= " + cg.target + cg.unit + " (" + cg.completedAt.substring(0, 10) + ")");
    }
    lines.push("");
  }

  return lines.join("\n");
}

module.exports = {
  GOAL_STATUS: GOAL_STATUS,
  GOAL_TEMPLATES: GOAL_TEMPLATES,
  createGoal: createGoal,
  updateGoals: updateGoals,
  formatGoalReport: formatGoalReport,
  loadGoals: loadGoals
};
