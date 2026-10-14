/**
 * 停机检测：同一个暂停原因连续 N 次出现 → 判定为「卡死」
 *
 * 背景：验收门是 fail-closed 设计，本意是保护实盘。
 * 但它无法区分「证据不足，无法验证」和「验证过了，但没通过」——
 * 两者都只报 ACCEPTANCE_GATE。结果：系统可以连续数周每天认真跑、
 * 认真暂停、认真记日志，却不发出任何信号。
 *
 * 本模块只做检测与报告，绝不改变任何决策语义：
 * 不碰 action / budget / picks / approvedForLive。
 */

const DEFAULT_THRESHOLD = 10;
/** 回看多少条记录来判定是否长期停摆 */
const DEFAULT_LOOKBACK = 20;
/** 主原因在该窗口内出现的占比下限 */
const DEFAULT_DOMINANCE = 0.7;

/**
 * 暂停原因分类。用于让告警说清「是测不过，还是根本没法测」。
 */
const REASON_CLASS = {
  ACCEPTANCE_GATE: "unverifiable_or_failed",
  ALPHA_GATE_NOT_PASSED: "unverifiable_or_failed",
  AGGRESSIVE_BETA_NOT_ALPHA: "unverifiable_or_failed",
  INSUFFICIENT_ROLLING_WINDOWS: "insufficient_evidence",
  INSUFFICIENT_NON_OVERLAPPING_WINDOWS: "insufficient_evidence",
  INSUFFICIENT_SHADOW_WEEKS: "insufficient_evidence",
  WIN_RATE_BELOW_55: "measured_failure",
  PROFIT_WIN_RATE_NOT_ABOVE_BASELINE: "measured_failure",
  OUTPERFORMANCE_WIN_RATE_BELOW_55: "measured_failure",
  AVERAGE_EXCESS_NOT_POSITIVE: "measured_failure",
  PROFIT_FACTOR_BELOW_1_2: "measured_failure",
  MEDIAN_EXCESS_NOT_POSITIVE: "measured_failure",
  DRAWDOWN_WORSE_THAN_LIMIT: "measured_failure",
  HARD_RISK_VIOLATION: "hard_risk",
  FEES_NOT_INCLUDED: "config_error",
  LIVE_DISABLED: "operator_switch",
  SIGNAL_WARMING_UP: "warming_up",
  SIGNAL_BREAKER: "breaker",
  PURCHASE_AVAILABILITY_STALE: "stale_data",
  DATA_ERROR: "data_error"
};

const CLASS_LABEL = {
  unverifiable_or_failed: "无法区分是「证据不足」还是「验证失败」——这正是本告警要暴露的盲区",
  insufficient_evidence: "证据不足，回测无法得出结论",
  measured_failure: "已测量，且未达标",
  hard_risk: "触发硬风控",
  config_error: "回测配置有误",
  operator_switch: "操作开关未打开",
  warming_up: "信号预热中（正常）",
  breaker: "信号熔断",
  stale_data: "数据过期",
  data_error: "数据错误"
};

/** 两个集合是否完全相同（忽略顺序） */
function sameReasons(a, b) {
  const x = [...new Set(a || [])].sort();
  const y = [...new Set(b || [])].sort();
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

/**
 * 判定是否长期停摆。
 *
 * 判据刻意不用「严格连续相同原因」：真实数据里 2026-09-21 多带了一个
 * SIGNAL_BREAKER，就把 09-01~09-20 与 09-22~09-28 两段切开了，
 * 严格连续计数只看到 5 次，于是一次长达数周的停摆被判为「正常」。
 * 判据太严会让最明显的问题恰好隐身。
 *
 * 改用：近 N 条记录里，暂停记录占比够高、且同一主原因占主导。
 *
 * @param {Array} records history.json 的 records
 * @param {Object} [options] { threshold, lookback, dominance }
 * @returns {{stalled: boolean, reason: string|null, runLength: number, runDates: string[],
 *            class: string|null, pausedCount: number, window: number, dominance: number}}
 */
function detectStall(records, options) {
  const opts = options || {};
  const threshold = Number(opts.threshold) > 0 ? Number(opts.threshold) : DEFAULT_THRESHOLD;
  const lookback = Number(opts.lookback) > 0 ? Number(opts.lookback) : DEFAULT_LOOKBACK;
  const minDominance = Number(opts.dominance) > 0 ? Number(opts.dominance) : DEFAULT_DOMINANCE;

  const empty = {
    stalled: false, reason: null, runLength: 0, runDates: [],
    class: null, pausedCount: 0, window: 0, dominance: 0
  };
  const list = Array.isArray(records) ? records : [];
  if (list.length === 0) return empty;

  // 只看尾部窗口
  const win = list.slice(-lookback);
  const paused = win.filter(function (r) {
    return Array.isArray(r.pauseReasons) && r.pauseReasons.length > 0;
  });
  if (paused.length === 0) return Object.assign({}, empty, { window: win.length });

  // 统计主原因（每条记录取第一个原因作为主因）
  const counts = {};
  paused.forEach(function (r) {
    const primary = r.pauseReasons[0];
    counts[primary] = (counts[primary] || 0) + 1;
  });
  let topReason = null;
  let topCount = 0;
  Object.keys(counts).forEach(function (k) {
    if (counts[k] > topCount) { topCount = counts[k]; topReason = k; }
  });

  const dom = paused.length ? topCount / paused.length : 0;
  // 「主因在窗口内的占比」以整个窗口为分母更直观：topCount / win.length
  const domOfWindow = win.length ? topCount / win.length : 0;

  const runDates = paused
    .filter(function (r) { return r.pauseReasons[0] === topReason; })
    .map(function (r) { return r.date; });

  const stalled = topCount >= threshold && domOfWindow >= minDominance;

  return {
    stalled: stalled,
    reason: topReason,
    runLength: topCount,
    runDates: runDates,
    class: REASON_CLASS[topReason] || "unknown",
    pausedCount: paused.length,
    window: win.length,
    dominance: Math.round(domOfWindow * 100) / 100
  };
}

/**
 * 生成给人看的告警文本。返回 null 表示无需告警。
 */
function buildStallAlert(records, options) {
  const opts = options || {};
  const stall = detectStall(records, opts);
  if (!stall.stalled) return null;

  const cls = stall.class || "unknown";
  const label = CLASS_LABEL[cls] || "未分类";
  const span = stall.runDates.length
    ? stall.runDates[0] + " ~ " + stall.runDates[stall.runDates.length - 1]
    : "(无)";

  const lines = [];
  lines.push("⚠️  定投计划疑似长期停摆");
  lines.push("    主导原因 : " + stall.reason);
  lines.push("    出现次数 : 近 " + stall.window + " 条记录中 " + stall.runLength + " 次（占比 " + Math.round(stall.dominance * 100) + "%）");
  lines.push("    时间跨度 : " + span);
  lines.push("    原因归类 : " + cls);
  lines.push("               " + label);
  lines.push("");
  lines.push("    这可能不是「策略表现不好」，而是「系统无法继续推进」。");
  lines.push("    检查方向：");
  if (cls === "unverifiable_or_failed" || cls === "insufficient_evidence") {
    lines.push("      · 回测是否真的选中了基金？picks 恒为 0 说明连验证都没跑起来");
    lines.push("      · 历史申购数据是否为空？空的会让所有基金被判 NOT_BUYABLE");
    lines.push("      · 此状态下 ACCEPTANCE_GATE 无法区分「测不过」与「没法测」");
  } else if (cls === "measured_failure") {
    lines.push("      · 策略已被真实测量且未达标 —— 这是策略问题，不是故障");
  } else if (cls === "stale_data") {
    lines.push("      · 先刷新净值与申购数据再重跑");
  } else if (cls === "operator_switch") {
    lines.push("      · RECOMMENDATION_LIVE_ENABLED 未打开，属预期行为");
  } else {
    lines.push("      · 确认该暂停原因是否属于预期行为");
  }
  return lines.join("\n");
}

module.exports = {
  DEFAULT_THRESHOLD,
  DEFAULT_LOOKBACK,
  DEFAULT_DOMINANCE,
  REASON_CLASS,
  CLASS_LABEL,
  detectStall,
  buildStallAlert,
  sameReasons
};
