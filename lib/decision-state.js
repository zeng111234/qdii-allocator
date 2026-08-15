function isCanonicalIsoInstant(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function validateDecisionState(state) {
  const errors = [];
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    return { valid: false, errors: ["DECISION_STATE_MISSING"] };
  }
  const schemaVersion = state.schemaVersion;
  if (schemaVersion !== 1 && schemaVersion !== 2) errors.push("SCHEMA_VERSION");
  if (!Number.isInteger(state.revision) || state.revision < 1) errors.push("REVISION");
  if (!Number.isFinite(state.riskAnchorValue) || !(state.riskAnchorValue > 0)) errors.push("RISK_ANCHOR_VALUE");
  if (!Number.isInteger(state.riskAnchorLedgerRevision) || state.riskAnchorLedgerRevision < 1) {
    errors.push("RISK_ANCHOR_LEDGER_REVISION");
  }
  if (!isCanonicalIsoInstant(state.updatedAt)) errors.push("UPDATED_AT");
  if (!isCanonicalIsoInstant(state.riskAnchorAt)) errors.push("RISK_ANCHOR_AT");
  const riskProfile = String(state.riskProfile || "AGGRESSIVE").toUpperCase();
  if (riskProfile !== "BALANCED" && riskProfile !== "AGGRESSIVE") errors.push("RISK_PROFILE");
  if (state.cashBalance !== undefined && (!Number.isFinite(state.cashBalance) || state.cashBalance < 0)) {
    errors.push("CASH_BALANCE");
  }
  if (state.riskAnchorTransactionIds !== undefined && !Array.isArray(state.riskAnchorTransactionIds)) {
    errors.push("RISK_ANCHOR_TRANSACTION_IDS");
  } else if (Array.isArray(state.riskAnchorTransactionIds) && state.riskAnchorTransactionIds.some(function (id) {
    return typeof id !== "string" || !id;
  })) {
    errors.push("RISK_ANCHOR_TRANSACTION_IDS");
  }
  return { valid: errors.length === 0, errors: Array.from(new Set(errors)) };
}

function normalizeDecisionState(state) {
  const validation = validateDecisionState(state);
  if (!validation.valid) throw new Error("INVALID_DECISION_STATE:" + validation.errors.join(","));
  return {
    schemaVersion: Number(state.schemaVersion),
    revision: Number(state.revision),
    updatedAt: String(state.updatedAt || ""),
    riskAnchorValue: Number(state.riskAnchorValue),
    riskAnchorAt: state.riskAnchorAt,
    riskAnchorLedgerRevision: Number(state.riskAnchorLedgerRevision),
    riskAnchorTransactionIds: Array.from(new Set((state.riskAnchorTransactionIds || []).map(function (id) {
      return String(id || "");
    }).filter(Boolean))).sort(),
    riskProfile: String(state.riskProfile || "AGGRESSIVE").toUpperCase(),
    cashBalance: Number(state.cashBalance) || 0
  };
}

module.exports = {
  isCanonicalIsoInstant: isCanonicalIsoInstant,
  validateDecisionState: validateDecisionState,
  normalizeDecisionState: normalizeDecisionState
};
