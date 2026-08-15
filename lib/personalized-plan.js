const ledgerTools = require("./portfolio-ledger");
const decisionStateTools = require("./decision-state");
const personalizedDecision = require("./personalized-decision");

const EXECUTABLE_ACTIONS = new Set(["BUY", "STRATEGIC_DCA", "TACTICAL_PAUSE"]);
const MAX_EXECUTION_PLAN_AGE_MS = 5 * 60 * 60 * 1000;

function isExecutableAction(action) {
  return EXECUTABLE_ACTIONS.has(action);
}

function isStrictUtcTimestamp(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    return false;
  }
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function shanghaiDateString(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new globalThis.Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const byType = {};
  parts.forEach(function (part) { byType[part.type] = part.value; });
  return byType.year + "-" + byType.month + "-" + byType.day;
}

function executionWindowForShanghaiDate(asOf, generatedAtValue) {
  if (typeof asOf !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(asOf)) {
    throw new Error("PLAN_EXECUTION_DATE_INVALID");
  }
  const generatedAt = generatedAtValue instanceof Date ? generatedAtValue : new Date(generatedAtValue);
  const morningOpen = new Date(asOf + "T09:00:00+08:00");
  const afternoonRefresh = new Date(asOf + "T14:00:00+08:00");
  const purchaseCutoff = new Date(asOf + "T15:00:00+08:00");
  if (Number.isNaN(generatedAt.getTime()) || Number.isNaN(morningOpen.getTime()) ||
      Number.isNaN(afternoonRefresh.getTime()) || Number.isNaN(purchaseCutoff.getTime())) {
    throw new Error("PLAN_EXECUTION_DATE_INVALID");
  }
  const afternoonWindow = generatedAt >= afternoonRefresh;
  return {
    validFrom: (afternoonWindow ? afternoonRefresh : morningOpen).toISOString(),
    validUntil: (afternoonWindow ? purchaseCutoff : afternoonRefresh).toISOString()
  };
}

function bindExecutionWindow(plan, asOf, nowValue) {
  const value = plan || {};
  if (!isExecutableAction(value.action)) return value;
  if (value.generatedAt !== undefined || value.validFrom !== undefined || value.validUntil !== undefined) {
    return value;
  }
  const now = nowValue instanceof Date ? nowValue : new Date(nowValue);
  if (Number.isNaN(now.getTime())) throw new Error("PLAN_GENERATED_AT_INVALID");
  const window = executionWindowForShanghaiDate(asOf, now);
  return Object.assign({}, value, {
    generatedAt: now.toISOString(),
    validFrom: window.validFrom,
    validUntil: window.validUntil
  });
}

function executionWindowStatus(plan, asOf, nowValue) {
  const value = plan || {};
  if (!isExecutableAction(value.action)) return { valid: true, current: true, reason: null };
  if (typeof asOf !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(asOf)) {
    return { valid: false, current: false, reason: "PLAN_EXECUTION_WINDOW_INVALID" };
  }
  if (!isStrictUtcTimestamp(value.generatedAt) ||
      !isStrictUtcTimestamp(value.validFrom) ||
      !isStrictUtcTimestamp(value.validUntil)) {
    return { valid: false, current: false, reason: "PLAN_EXECUTION_WINDOW_INVALID" };
  }
  const generatedAt = new Date(value.generatedAt);
  const validFrom = new Date(value.validFrom);
  const validUntil = new Date(value.validUntil);
  const now = nowValue instanceof Date ? nowValue : new Date(nowValue);
  const expectedWindow = executionWindowForShanghaiDate(asOf, generatedAt);
  if (Number.isNaN(now.getTime()) ||
      shanghaiDateString(generatedAt) !== asOf ||
      shanghaiDateString(validFrom) !== asOf ||
      shanghaiDateString(validUntil) !== asOf ||
      value.validFrom !== expectedWindow.validFrom || value.validUntil !== expectedWindow.validUntil ||
      validFrom >= validUntil || generatedAt < validFrom || generatedAt > now) {
    return { valid: false, current: false, reason: "PLAN_EXECUTION_WINDOW_INVALID" };
  }
  if (now < validFrom) return { valid: true, current: false, reason: "PLAN_WINDOW_NOT_OPEN" };
  if (now >= validUntil || now.getTime() - generatedAt.getTime() > MAX_EXECUTION_PLAN_AGE_MS) {
    return { valid: true, current: false, reason: "PLAN_WINDOW_EXPIRED" };
  }
  return { valid: true, current: true, reason: null };
}

function failClosedPlan(basePlan, reasons) {
  const base = basePlan || {};
  return Object.assign({}, base, {
    action: "HARD_PAUSE",
    pauseReasons: Array.from(new Set((base.pauseReasons || []).concat(reasons || []))),
    budget: 0,
    candidates: [],
    ranked: [],
    executionRoutes: [],
    decisionMode: "DATA_BLOCKED",
    blockedStage: "PRIVATE_STATE_VALIDATION",
    confidence: "LOW",
    personalized: true
  });
}

function candidateFromRoute(route) {
  return {
    code: route.code,
    name: route.name || route.code,
    indexGroup: route.indexGroup,
    bucket: route.bucket,
    marketScore: null,
    suitabilityScore: null,
    proposedAmount: Number(route.amount) || 0,
    reasons: route.reason ? [route.reason] : [],
    reason: route.reason || "",
    blockedBy: []
  };
}

function buildPersonalizedPlan(input) {
  const settings = input || {};
  const reasons = [];
  if (!settings.ledger) reasons.push("PRIVATE_LEDGER_MISSING");
  else {
    const validation = ledgerTools.validateLedger(settings.ledger);
    if (!validation.valid) reasons.push("PRIVATE_LEDGER_INVALID");
  }
  if (!settings.decisionState) reasons.push("DECISION_STATE_MISSING");
  else if (!decisionStateTools.validateDecisionState(settings.decisionState).valid) reasons.push("DECISION_STATE_INVALID");
  if (reasons.length > 0) return failClosedPlan(settings.basePlan, reasons);

  const decisionState = decisionStateTools.normalizeDecisionState(settings.decisionState);
  const portfolio = ledgerTools.derivePortfolio(settings.ledger);
  const plan = personalizedDecision.personalizePlan({
    basePlan: settings.basePlan,
    ledger: settings.ledger,
    decisionState: decisionState,
    portfolio: portfolio,
    funds: settings.funds || [],
    navCache: settings.navCache || {},
    marketTemperature: settings.marketTemperature,
    signalConfirmation: settings.signalConfirmation,
    policy: settings.policy,
    defaultRiskProfile: settings.defaultRiskProfile,
    asOf: settings.asOf,
    readOnly: settings.readOnly === true
  });
  const routes = Array.isArray(plan.executionRoutes) ? plan.executionRoutes : [];
  const candidates = routes.map(candidateFromRoute);
  return Object.assign({}, plan, {
    candidates: candidates,
    ranked: candidates
  });
}

function formatPersonalizedPlan(plan) {
  const value = plan || {};
  const lines = ["=== 个性化推荐计划 ===", "日期: " + (value.asOf || value.date || "--"), "操作: " + (value.action || "HARD_PAUSE")];
  const candidates = Array.isArray(value.candidates) ? value.candidates : [];
  if (candidates.length === 0) {
    lines.push("今日无可执行新增路线。" + ((value.pauseReasons || []).length ? " 原因: " + value.pauseReasons.join(", ") : ""));
  } else {
    lines.push("执行路线:");
    candidates.forEach(function (candidate, index) {
      lines.push((index + 1) + ". " + candidate.name + "(" + candidate.code + ") 金额=" + candidate.proposedAmount + "元" +
        (candidate.reason ? "；" + candidate.reason : ""));
    });
  }
  return lines.join("\n");
}

module.exports = {
  EXECUTABLE_ACTIONS: EXECUTABLE_ACTIONS,
  MAX_EXECUTION_PLAN_AGE_MS: MAX_EXECUTION_PLAN_AGE_MS,
  isExecutableAction: isExecutableAction,
  isStrictUtcTimestamp: isStrictUtcTimestamp,
  executionWindowForShanghaiDate: executionWindowForShanghaiDate,
  bindExecutionWindow: bindExecutionWindow,
  executionWindowStatus: executionWindowStatus,
  buildPersonalizedPlan: buildPersonalizedPlan,
  failClosedPlan: failClosedPlan,
  candidateFromRoute: candidateFromRoute,
  formatPersonalizedPlan: formatPersonalizedPlan
};
