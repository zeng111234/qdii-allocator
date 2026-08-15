const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const allocatorCli = require("../../index");
const mailer = require("../../lib/mailer");
const ledgerTools = require("../../lib/portfolio-ledger");
const personalizedDecision = require("../../lib/personalized-decision");

function executablePlan() {
  return {
    schemaVersion: "PersonalizedRecommendationPlanV2",
    action: "STRATEGIC_DCA",
    budget: 20,
    executionRoutes: [{ code: "A", amount: 20 }],
    candidates: [{ code: "A", proposedAmount: 20 }],
    ranked: [{ code: "A", proposedAmount: 20 }]
  };
}

test("release safety converts a NAV refresh failure into a zero-budget hard pause", function () {
  const plan = allocatorCli.enforceReleaseSafety(executablePlan(), {
    navRefreshFailed: true,
    tradingDay: true
  });
  assert.equal(plan.action, "HARD_PAUSE");
  assert.equal(plan.budget, 0);
  assert.deepEqual(plan.executionRoutes, []);
  assert.deepEqual(plan.candidates, []);
  assert.ok(plan.pauseReasons.includes("NAV_REFRESH_FAILED"));
});

test("release safety converts a pending-ledger reconciliation failure into a zero-budget hard pause", function () {
  const plan = allocatorCli.enforceReleaseSafety(executablePlan(), {
    navRefreshFailed: false,
    reconciliationFailed: true,
    tradingDay: true
  });
  assert.equal(plan.action, "HARD_PAUSE");
  assert.equal(plan.budget, 0);
  assert.deepEqual(plan.executionRoutes, []);
  assert.deepEqual(plan.candidates, []);
  assert.ok(plan.pauseReasons.includes("LEDGER_RECONCILE_FAILED"));
});

test("release safety makes weekends and holidays non-executable", function () {
  const plan = allocatorCli.enforceReleaseSafety(executablePlan(), {
    navRefreshFailed: false,
    tradingDay: false
  });
  assert.equal(plan.action, "HARD_PAUSE");
  assert.equal(plan.budget, 0);
  assert.ok(plan.pauseReasons.includes("NON_TRADING_DAY"));
});

test("release safety converts an exhausted executable mode into HOLD", function () {
  const plan = allocatorCli.enforceReleaseSafety(Object.assign(executablePlan(), {
    budget: 0,
    executionRoutes: [],
    candidates: [],
    ranked: []
  }), { navRefreshFailed: false, tradingDay: true });
  assert.equal(plan.action, "HOLD");
  assert.equal(plan.budget, 0);
  assert.ok(plan.pauseReasons.includes("NO_EXECUTABLE_BUDGET"));
});

test("canonical input binding includes ledger content and decision fingerprint", function () {
  const state = {
    schemaVersion: 2,
    revision: 3,
    updatedAt: "2026-08-13T01:02:03.000Z",
    riskAnchorValue: 1000,
    riskAnchorAt: "2026-08-01T01:02:03.000Z",
    riskAnchorLedgerRevision: 7,
    riskAnchorTransactionIds: ["b", "a"],
    riskProfile: "AGGRESSIVE",
    cashBalance: 20
  };
  const bound = allocatorCli.bindCanonicalInputs(executablePlan(), {
    revision: 7,
    checksum: "a".repeat(64)
  }, state);
  assert.equal(bound.ledgerChecksum, "a".repeat(64));
  assert.equal(bound.decisionFingerprint, allocatorCli.decisionFingerprint(state));
});

test("China business date is independent of the runner UTC date", function () {
  assert.equal(allocatorCli.formatDateInTimeZone(new Date("2026-08-14T16:01:00.000Z"), "Asia/Shanghai"), "2026-08-15");
});

test("executable plans carry a bounded Shanghai purchase window and expire the same day", function () {
  const open = allocatorCli.enforcePlanExecutionWindow(
    executablePlan(), "2026-08-15", new Date("2026-08-15T02:00:00.000Z")
  );
  assert.equal(open.action, "STRATEGIC_DCA");
  assert.equal(open.generatedAt, "2026-08-15T02:00:00.000Z");
  assert.equal(open.validFrom, "2026-08-15T01:00:00.000Z");
  assert.equal(open.validUntil, "2026-08-15T06:00:00.000Z");

  const expired = allocatorCli.enforcePlanExecutionWindow(
    open, "2026-08-15", new Date("2026-08-15T06:30:00.000Z")
  );
  assert.equal(expired.action, "HARD_PAUSE");
  assert.equal(expired.budget, 0);
  assert.deepEqual(expired.executionRoutes, []);
  assert.ok(expired.pauseReasons.includes("PLAN_WINDOW_EXPIRED"));
});

test("missing SMTP configuration is a hard email failure", async function () {
  const keys = ["SMTP_HOST", "SMTP_USER", "SMTP_PASS", "MAIL_TO"];
  const saved = Object.fromEntries(keys.map(function (key) { return [key, process.env[key]]; }));
  keys.forEach(function (key) { delete process.env[key]; });
  try {
    await assert.rejects(allocatorCli.sendReport({ date: "2026-08-15" }, "", "", 1, null), /SMTP_CONFIGURATION_REQUIRED/);
  } finally {
    keys.forEach(function (key) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    });
  }
});

test("a false SMTP result is a hard email failure", async function () {
  const keys = ["SMTP_HOST", "SMTP_USER", "SMTP_PASS", "MAIL_TO"];
  const saved = Object.fromEntries(keys.map(function (key) { return [key, process.env[key]]; }));
  const originalSend = mailer.sendEmail;
  process.env.SMTP_HOST = "smtp.invalid";
  process.env.SMTP_USER = "user";
  process.env.SMTP_PASS = "pass";
  process.env.MAIL_TO = "self@example.invalid";
  mailer.sendEmail = async function () { return false; };
  try {
    await assert.rejects(allocatorCli.sendReport({ date: "2026-08-15" }, "", "", 1, null), /EMAIL_SEND_FAILED/);
  } finally {
    mailer.sendEmail = originalSend;
    keys.forEach(function (key) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    });
  }
});

test("canonical email validates the current plan, strategy, routes, and bound private inputs before mailer", async function (t) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "qdii-canonical-email-"));
  t.after(function () { fs.rmSync(tempDir, { recursive: true, force: true }); });
  const ledgerPath = path.join(tempDir, "portfolio-ledger.json");
  const decisionPath = path.join(tempDir, "decision-state.json");
  const planPath = path.join(tempDir, "recommendation-plan.json");
  const fundsPath = path.join(tempDir, "funds.json");
  const asOf = allocatorCli.formatDateInTimeZone(new Date(), "Asia/Shanghai");
  const ledger = ledgerTools.createLedger([], {
    revision: 7,
    updatedAt: asOf + "T01:00:00.000Z"
  });
  const decisionState = {
    schemaVersion: 2,
    revision: 3,
    updatedAt: asOf + "T01:00:00.000Z",
    riskAnchorValue: 1000,
    riskAnchorAt: asOf + "T01:00:00.000Z",
    riskAnchorLedgerRevision: 7,
    riskAnchorTransactionIds: [],
    riskProfile: "AGGRESSIVE",
    cashBalance: 20
  };
  const validPlan = {
    schemaVersion: "PersonalizedRecommendationPlanV2",
    strategyVersion: personalizedDecision.PERSONALIZED_STRATEGY_ID,
    asOf: asOf,
    syncRevision: 7,
    decisionRevision: 3,
    ledgerChecksum: ledger.checksum,
    decisionFingerprint: allocatorCli.decisionFingerprint(decisionState),
    action: "HARD_PAUSE",
    budget: 0,
    candidates: [],
    executionRoutes: [],
    marketRanking: []
  };
  fs.writeFileSync(ledgerPath, JSON.stringify(ledger));
  fs.writeFileSync(decisionPath, JSON.stringify(decisionState));
  fs.writeFileSync(fundsPath, JSON.stringify({
    _lastUpdated: asOf,
    funds: [{ code: "A", name: "A", status: "active", dailyLimit: 20, minPurchase: 10 }]
  }));

  const keys = [
    "CANONICAL_RECOMMENDATION_PLAN_PATH", "PRIVATE_LEDGER_PATH", "PRIVATE_DECISION_STATE_PATH",
    "FUNDS_FILE", "SMTP_HOST", "SMTP_USER", "SMTP_PASS", "MAIL_TO"
  ];
  const saved = Object.fromEntries(keys.map(function (key) { return [key, process.env[key]]; }));
  const originalSend = mailer.sendEmail;
  let sendCount = 0;
  process.env.CANONICAL_RECOMMENDATION_PLAN_PATH = planPath;
  process.env.PRIVATE_LEDGER_PATH = ledgerPath;
  process.env.PRIVATE_DECISION_STATE_PATH = decisionPath;
  process.env.FUNDS_FILE = fundsPath;
  process.env.SMTP_HOST = "smtp.invalid";
  process.env.SMTP_USER = "user";
  process.env.SMTP_PASS = "pass";
  process.env.MAIL_TO = "self@example.invalid";
  mailer.sendEmail = async function () { sendCount++; return true; };
  try {
    const invalidPlans = [
      { value: Object.assign({}, validPlan, { asOf: "1999-01-01" }), error: /CANONICAL_PLAN_STALE/ },
      { value: Object.assign({}, validPlan, { strategyVersion: "old-strategy" }), error: /STRATEGY_VERSION_MISMATCH/ },
      { value: Object.assign({}, validPlan, { ledgerChecksum: "b".repeat(64) }), error: /LEDGER_CHECKSUM_MISMATCH/ },
      {
        value: Object.assign({}, validPlan, {
          action: "STRATEGIC_DCA", budget: 20,
          candidates: [{ code: "A", name: "A", proposedAmount: 20 }],
          executionRoutes: [{ code: "A", name: "A", amount: 20 }]
        }),
        error: /EXECUTION_WINDOW/
      }
    ];
    for (const invalid of invalidPlans) {
      fs.writeFileSync(planPath, JSON.stringify(invalid.value));
      await assert.rejects(allocatorCli.sendCanonicalArtifactEmail(), invalid.error);
    }
    assert.equal(sendCount, 0, "invalid canonical artifacts must never reach the mailer");

    fs.writeFileSync(planPath, JSON.stringify(validPlan));
    await allocatorCli.sendCanonicalArtifactEmail();
    assert.equal(sendCount, 1);
  } finally {
    mailer.sendEmail = originalSend;
    keys.forEach(function (key) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    });
  }
});
