const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const pageBuilder = require("../../build-pages");
const personalizedDecision = require("../../lib/personalized-decision");

function canonicalFixture() {
  const ledger = { revision: 7, checksum: "a".repeat(64) };
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
  const funds = {
    _lastUpdated: "2026-08-13",
    funds: [{ code: "A", status: "active", dailyLimit: 20, minPurchase: 10 }]
  };
  const plan = {
    schemaVersion: "PersonalizedRecommendationPlanV2",
    strategyVersion: personalizedDecision.PERSONALIZED_STRATEGY_ID,
    asOf: "2026-08-13",
    syncRevision: 7,
    decisionRevision: 3,
    ledgerChecksum: ledger.checksum,
    decisionFingerprint: pageBuilder.decisionFingerprint(state),
    generatedAt: "2026-08-13T02:00:00.000Z",
    validFrom: "2026-08-13T01:00:00.000Z",
    validUntil: "2026-08-13T06:00:00.000Z",
    action: "STRATEGIC_DCA",
    budget: 20,
    executionRoutes: [{ code: "A", amount: 20 }],
    candidates: [{ code: "A", proposedAmount: 20 }]
  };
  return { ledger: ledger, state: state, funds: funds, plan: plan };
}

test("page build destroys stalled market-data requests instead of hanging", function () {
  const source = fs.readFileSync(path.join(__dirname, "..", "..", "build-pages.js"), "utf8");
  assert.match(source, /\.on\("timeout",\s*\(\)\s*=>\s*req\.destroy\(/);
});

test("public snapshot build migrates a legacy portfolio in memory before validation", function () {
  const source = fs.readFileSync(path.join(__dirname, "..", "..", "build-pages.js"), "utf8");
  assert.match(source, /ledgerTools\.migrateLegacyPortfolio\(source/);
  assert.match(source, /PUBLIC_PORTFOLIO_SNAPSHOT_REQUIRES_PRIVATE_LEDGER/);
});

test("page build consumes the already generated canonical recommendation artifact", function () {
  const source = fs.readFileSync(path.join(__dirname, "..", "..", "build-pages.js"), "utf8");
  assert.match(source, /loadCanonicalRecommendationPlan\(/);
  assert.match(source, /validateCanonicalRecommendationPlan\(/);
  assert.doesNotMatch(source, /backfillHistoryFollowUp\(/);
  assert.doesNotMatch(source, /buildLiveAcceptanceMetrics\(/);
  assert.doesNotMatch(source, /buildRecommendationPlan\(/);
  assert.doesNotMatch(source, /buildPersonalizedPlan\(/);
});

test("daily generator calculates readiness evidence while Pages does not recalculate it", function () {
  const root = path.join(__dirname, "..", "..");
  const pagesSource = fs.readFileSync(path.join(root, "build-pages.js"), "utf8");
  const dailySource = fs.readFileSync(path.join(root, "index.js"), "utf8");
  assert.match(dailySource, /let acceptanceMetrics = null;\s*try \{\s*const walkForward/);
  assert.doesNotMatch(dailySource, /let acceptanceMetrics = null;\s*if \(liveEnabled\)/);
  assert.match(dailySource, /monthlyDcaEvidenceFromReport\(alphaResearch\)/);
  assert.match(dailySource, /buildAlphaResearchReport\(/);
  assert.doesNotMatch(pagesSource, /buildLiveAcceptanceMetrics\(|buildAlphaResearchReport\(/);
});

test("both Pages build paths receive the recommendation live switch", function () {
  const root = path.join(__dirname, "..", "..");
  const daily = fs.readFileSync(path.join(root, ".github", "workflows", "daily-plan.yml"), "utf8");
  const pages = fs.readFileSync(path.join(root, ".github", "workflows", "pages.yml"), "utf8");
  const liveSwitch = /RECOMMENDATION_LIVE_ENABLED:\s*\$\{\{\s*secrets\.RECOMMENDATION_LIVE_ENABLED\s*\}\}/g;
  assert.equal((daily.match(liveSwitch) || []).length, 1, "daily workflow generates one canonical plan for either schedule");
  assert.equal((pages.match(liveSwitch) || []).length, 1, "scheduled Pages plan generation must receive the switch");
});

test("daily and Pages workflows reconcile pending ledger buys after NAV refresh", function () {
  const root = path.join(__dirname, "..", "..");
  const daily = fs.readFileSync(path.join(root, ".github", "workflows", "daily-plan.yml"), "utf8");
  const pages = fs.readFileSync(path.join(root, ".github", "workflows", "pages.yml"), "utf8");
  [daily, pages].forEach(function (workflow) {
    assert.match(workflow, /Reconcile pending ledger transactions/);
    assert.match(workflow, /id:\s*ledger_reconcile/);
    assert.match(workflow, /node scripts\/reconcile-private-ledger\.js/);
    assert.ok(workflow.indexOf("Update NAV cache") < workflow.indexOf("Reconcile pending ledger transactions"));
    assert.ok(workflow.indexOf("Reconcile pending ledger transactions") < workflow.indexOf("Mark ledger reconciliation safety state"));
    assert.ok(workflow.indexOf("Reconcile pending ledger transactions") < workflow.indexOf("Fetch and validate private recommendation state"));
    assert.match(workflow, /steps\.ledger_reconcile\.outcome[\s\S]*LEDGER_RECONCILE_FAILED=1/);
    assert.match(workflow, /Generate canonical recommendation plan without email[\s\S]*LEDGER_RECONCILE_FAILED:\s*\$\{\{\s*env\.LEDGER_RECONCILE_FAILED\s*\}\}/);
  });
});

test("daily and Pages workflows fetch ledger and decision state as one private batch", function () {
  const root = path.join(__dirname, "..", "..");
  const daily = fs.readFileSync(path.join(root, ".github", "workflows", "daily-plan.yml"), "utf8");
  const pages = fs.readFileSync(path.join(root, ".github", "workflows", "pages.yml"), "utf8");
  [daily, pages].forEach(function (workflow) {
    assert.match(workflow, /PRIVATE_DECISION_STATE_PATH/);
    assert.match(workflow, /node scripts\/fetch-private-decision-state\.js/);
    assert.ok(workflow.indexOf("Reconcile pending ledger transactions") < workflow.indexOf("Fetch and validate private recommendation state"));
  });
});

test("email generator personalizes once and Pages consumes that artifact while history keeps the base plan", function () {
  const root = path.join(__dirname, "..", "..");
  const dailySource = fs.readFileSync(path.join(root, "index.js"), "utf8");
  const pagesSource = fs.readFileSync(path.join(root, "build-pages.js"), "utf8");
  assert.match(dailySource, /personalizedPlanTools\.buildPersonalizedPlan\(/);
  assert.match(dailySource, /PRIVATE_DECISION_STATE_PATH/);
  assert.match(dailySource, /baseRecommendationPlan/);
  assert.match(pagesSource, /loadCanonicalRecommendationPlan\(/);
  assert.doesNotMatch(pagesSource, /personalizedPlanTools|baseRecommendationPlan/);
  assert.match(dailySource, /historyTracker\.saveRecommendationPlan\(baseRecommendationPlan\)/);
  assert.doesNotMatch(dailySource, /historyTracker\.saveRecommendationPlan\(recommendationPlan\)/);
  assert.match(dailySource, /personalizedPlanTools\.formatPersonalizedPlan\(recommendationPlan\)/);
});

test("Pages embeds the complete final plan and cannot overwrite the private plan artifact", function () {
  const source = fs.readFileSync(path.join(__dirname, "..", "..", "build-pages.js"), "utf8");
  assert.match(source, /Object\.assign\(\{\}, recommendationPlan/);
  assert.match(source, /executionRoutes/);
  assert.match(source, /candidates/);
  assert.doesNotMatch(source, /fs\.writeFileSync\(\s*path\.join\(__dirname, "data", "recommendation-plan\.json"\)/);
});

test("market-only builds never recover holdings or canonical state from an old plan artifact", function () {
  const root = path.join(__dirname, "..", "..");
  const source = fs.readFileSync(path.join(root, "build-pages.js"), "utf8");
  assert.match(source, /function loadPublicPortfolioSnapshot\(publicLedger\)/);
  assert.doesNotMatch(source, /plan\.publicPortfolioSnapshot/);
  assert.match(source, /const publicPortfolioSnapshot = Boolean\(publicLedger\)/);
  assert.match(source, /const canonicalPublicPlan = Boolean\(publicLedger && publicDecisionState/);
  assert.deepEqual(pageBuilder.loadPublicPortfolioSnapshot(null), { holdings: [], startDate: null });
  assert.deepEqual(pageBuilder.marketOnlyPlan("2026-08-13").executionRoutes, []);
  assert.equal(pageBuilder.marketOnlyPlan("2026-08-13").budget, 0);
});

test("canonical plan validation binds date, private revisions, routes, and the fresh availability snapshot", function () {
  const fixture = canonicalFixture();
  const ledger = fixture.ledger;
  const state = fixture.state;
  const funds = fixture.funds;
  const plan = fixture.plan;
  assert.equal(pageBuilder.validateCanonicalRecommendationPlan(plan, ledger, state, funds, "2026-08-13"), plan);
  assert.throws(function () {
    pageBuilder.validateCanonicalRecommendationPlan(Object.assign({}, plan, { syncRevision: 6 }), ledger, state, funds, "2026-08-13");
  }, /LEDGER_REVISION_MISMATCH/);
  assert.throws(function () {
    pageBuilder.validateCanonicalRecommendationPlan(plan, ledger, state,
      Object.assign({}, funds, { _lastUpdated: "2026-08-12" }), "2026-08-13");
  }, /PURCHASE_AVAILABILITY_STALE/);
  assert.throws(function () {
    pageBuilder.validateCanonicalRecommendationPlan(plan, ledger, state, {
      _lastUpdated: "2026-08-13",
      funds: [{ code: "A", status: "suspended", dailyLimit: 0, minPurchase: 10 }]
    }, "2026-08-13");
  }, /CANONICAL_PLAN_LIMIT_MISMATCH/);
});

test("canonical plan validation rejects schema drift and unbound private content", function () {
  const fixture = canonicalFixture();
  assert.throws(function () {
    pageBuilder.validateCanonicalRecommendationPlan(
      Object.assign({}, fixture.plan, { schemaVersion: "RecommendationPlanV2" }),
      fixture.ledger, fixture.state, fixture.funds, "2026-08-13"
    );
  }, /SCHEMA_VERSION/);
  assert.throws(function () {
    pageBuilder.validateCanonicalRecommendationPlan(
      Object.assign({}, fixture.plan, { strategyVersion: "old-strategy" }),
      fixture.ledger, fixture.state, fixture.funds, "2026-08-13"
    );
  }, /STRATEGY_VERSION/);
  assert.throws(function () {
    pageBuilder.validateCanonicalRecommendationPlan(
      Object.assign({}, fixture.plan, { ledgerChecksum: "b".repeat(64) }),
      fixture.ledger, fixture.state, fixture.funds, "2026-08-13"
    );
  }, /LEDGER_CHECKSUM_MISMATCH/);
  assert.throws(function () {
    pageBuilder.validateCanonicalRecommendationPlan(
      Object.assign({}, fixture.plan, { decisionFingerprint: "stale" }),
      fixture.ledger, fixture.state, fixture.funds, "2026-08-13"
    );
  }, /DECISION_FINGERPRINT_MISMATCH/);
});

test("canonical routes cannot duplicate a code to bypass its daily limit", function () {
  const fixture = canonicalFixture();
  const duplicate = Object.assign({}, fixture.plan, {
    budget: 30,
    executionRoutes: [{ code: "A", amount: 15 }, { code: "A", amount: 15 }],
    candidates: [{ code: "A", proposedAmount: 15 }, { code: "A", proposedAmount: 15 }]
  });
  assert.throws(function () {
    pageBuilder.validateCanonicalRecommendationPlan(
      duplicate, fixture.ledger, fixture.state, fixture.funds, "2026-08-13"
    );
  }, /DUPLICATE_ROUTE/);
});

test("canonical action, budget, routes and candidates must describe one executable state", function () {
  const fixture = canonicalFixture();
  assert.throws(function () {
    pageBuilder.validateCanonicalRecommendationPlan(
      Object.assign({}, fixture.plan, { action: "HARD_PAUSE" }),
      fixture.ledger, fixture.state, fixture.funds, "2026-08-13"
    );
  }, /ACTION_BUDGET_MISMATCH/);
  assert.throws(function () {
    pageBuilder.validateCanonicalRecommendationPlan(
      Object.assign({}, fixture.plan, { budget: "20" }),
      fixture.ledger, fixture.state, fixture.funds, "2026-08-13"
    );
  }, /BUDGET_INVALID/);
});

test("canonical executable plans require a current bounded execution window", function () {
  const fixture = canonicalFixture();
  assert.throws(function () {
    const missing = Object.assign({}, fixture.plan);
    delete missing.validUntil;
    pageBuilder.validateCanonicalRecommendationPlan(
      missing, fixture.ledger, fixture.state, fixture.funds, "2026-08-13", new Date("2026-08-13T02:30:00.000Z")
    );
  }, /EXECUTION_WINDOW/);
  assert.throws(function () {
    pageBuilder.validateCanonicalRecommendationPlan(
      fixture.plan, fixture.ledger, fixture.state, fixture.funds, "2026-08-13", new Date("2026-08-13T06:01:00.000Z")
    );
  }, /PLAN_EXPIRED/);
  assert.throws(function () {
    pageBuilder.validateCanonicalRecommendationPlan(
      Object.assign({}, fixture.plan, { validUntil: "2026-08-13T07:00:00.000Z" }),
      fixture.ledger, fixture.state, fixture.funds, "2026-08-13", new Date("2026-08-13T05:00:00.000Z")
    );
  }, /EXECUTION_WINDOW/);
});

test("China date helper crosses the UTC day boundary correctly", function () {
  assert.equal(pageBuilder.formatDateInTimeZone(new Date("2026-08-14T16:30:00.000Z"), "Asia/Shanghai"), "2026-08-15");
  assert.equal(pageBuilder.formatDateInTimeZone(new Date("2026-08-14T15:59:59.000Z"), "Asia/Shanghai"), "2026-08-14");
});

test("server and page share one trading calendar instead of a second holiday list", function () {
  const root = path.join(__dirname, "..", "..");
  const builder = fs.readFileSync(path.join(root, "build-pages.js"), "utf8");
  const cli = fs.readFileSync(path.join(root, "index.js"), "utf8");
  assert.match(builder, /tradingCalendar\.loadHolidays\(\)/);
  assert.match(cli, /tradingCalendar\.isTradingDay\(planAsOf\)/);
  assert.doesNotMatch(builder, /const tradingHolidays = \[\s*"2026-/);
});

test("artifact verification rejects missing required Pages files", function () {
  const tempDir = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "qdii-pages-artifact-"));
  try {
    fs.mkdirSync(path.join(tempDir, "data"));
    fs.writeFileSync(path.join(tempDir, "index.html"), "<html></html>");
    assert.throws(function () {
      pageBuilder.validatePageArtifact(tempDir);
    }, /PAGES_ARTIFACT_MISSING/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("NAV refresh failures are marked and only publish a fail-closed plan", function () {
  const root = path.join(__dirname, "..", "..");
  const daily = fs.readFileSync(path.join(root, ".github", "workflows", "daily-plan.yml"), "utf8");
  const pages = fs.readFileSync(path.join(root, ".github", "workflows", "pages.yml"), "utf8");
  [daily, pages].forEach(function (workflow) {
    assert.match(workflow, /id:\s*nav_refresh/);
    assert.match(workflow, /steps\.nav_refresh\.outcome[\s\S]*NAV_REFRESH_FAILED=1/);
    assert.match(workflow, /Update NAV cache[\s\S]*continue-on-error:\s*true[\s\S]*Mark NAV refresh safety state/);
    assert.match(workflow, /Generate canonical recommendation plan without email[\s\S]*NAV_REFRESH_FAILED:\s*\$\{\{\s*env\.NAV_REFRESH_FAILED\s*\}\}/);
  });
  const source = fs.readFileSync(path.join(root, "index.js"), "utf8");
  assert.match(source, /NAV_REFRESH_FAILED/);
  assert.match(source, /NAV_REFRESH_FAILED[\s\S]*HARD_PAUSE|HARD_PAUSE[\s\S]*NAV_REFRESH_FAILED/);
});

test("Pages artifacts are verified before upload and email waits for successful deployment", function () {
  const root = path.join(__dirname, "..", "..");
  const daily = fs.readFileSync(path.join(root, ".github", "workflows", "daily-plan.yml"), "utf8");
  const pages = fs.readFileSync(path.join(root, ".github", "workflows", "pages.yml"), "utf8");
  [daily, pages].forEach(function (workflow) {
    assert.ok(workflow.indexOf("Verify Pages artifact") < workflow.indexOf("actions/upload-pages-artifact"));
  });
  assert.match(daily, /Send email from deployed canonical artifact/);
  assert.match(daily, /needs:\s*\[?generate-plan,\s*deploy\]?/);
  assert.match(daily, /node index\.js --send-canonical-email/);
  assert.ok(daily.indexOf("Deploy to GitHub Pages") < daily.indexOf("Send email from deployed canonical artifact"));
  assert.ok(daily.lastIndexOf("Fetch and validate private recommendation state") < daily.indexOf("run: node index.js --send-canonical-email"));
  assert.match(daily, /send-email:[\s\S]*PRIVATE_LEDGER_PATH[\s\S]*PRIVATE_DECISION_STATE_PATH[\s\S]*node scripts\/fetch-private-decision-state\.js[\s\S]*node index\.js --send-canonical-email/);
});

test("private recommendation fetch clears stale outputs before fetch and after any failure", function () {
  const root = path.join(__dirname, "..", "..");
  const source = fs.readFileSync(path.join(root, "scripts", "fetch-private-decision-state.js"), "utf8");
  assert.match(source, /function clearPrivateOutputs\(/);
  assert.match(source, /clearPrivateOutputs\(ledgerOutput, decisionOutput\);[\s\S]*loadPrivateRecommendationStateFromFirebase/);
  assert.match(source, /main\(\)\.catch\(function \(error\) \{[\s\S]*clearPrivateOutputs\(/);
});

test("pending-ledger reconciliation logs aggregate count and revision only", function () {
  const root = path.join(__dirname, "..", "..");
  const source = fs.readFileSync(path.join(root, "scripts", "reconcile-private-ledger.js"), "utf8");
  assert.doesNotMatch(source, /JSON\.stringify\(result\.reconciled\)/);
  assert.match(source, /prepared: count=" \+ result\.reconciled\.length \+\s*", revision="/);
  assert.match(source, /committed: count=" \+ result\.reconciled\.length \+\s*", revision="/);
});

test("daily workflow sends mail only for the scheduled morning release", function () {
  const root = path.join(__dirname, "..", "..");
  const daily = fs.readFileSync(path.join(root, ".github", "workflows", "daily-plan.yml"), "utf8");
  assert.match(daily, /Generate canonical recommendation plan without email[\s\S]*--dry-run/);
  assert.match(daily, /EVENT_SCHEDULE[\s\S]*0 1 \* \* 1-5[\s\S]*should_send=true/);
  assert.doesNotMatch(daily, /workflow_dispatch|EVENT_NAME|DRY_RUN/);
  assert.match(daily, /needs:\s*\[generate-plan, deploy\]/);
});

test("actionable Pages releases have only predictable scheduled trigger boundaries", function () {
  const root = path.join(__dirname, "..", "..");
  const daily = fs.readFileSync(path.join(root, ".github", "workflows", "daily-plan.yml"), "utf8");
  const pages = fs.readFileSync(path.join(root, ".github", "workflows", "pages.yml"), "utf8");
  const dailyTriggers = daily.slice(0, daily.indexOf("permissions:"));
  const pagesTriggers = pages.slice(0, pages.indexOf("permissions:"));
  [dailyTriggers, pagesTriggers].forEach(function (source) {
    // TEMPORARY one-time allowance: PR #57 adds workflow_dispatch to pages.yml
    // to validate PR #56's purchase-limits fix on a real production run. The
    // dispatch trigger is removed in the follow-up revert PR. Push remains banned.
    assert.doesNotMatch(source, /\bpush:/);
  });
  assert.match(dailyTriggers, /0 1 \* \* 1-5/);
  assert.match(dailyTriggers, /0 9 \* \* 1-5/);
  assert.match(pagesTriggers, /0 \*\/6 \* \* \*/);
});

test("scheduled release reruns cannot redeploy or resend an older actionable batch", function () {
  const root = path.join(__dirname, "..", "..");
  const daily = fs.readFileSync(path.join(root, ".github", "workflows", "daily-plan.yml"), "utf8");
  const pages = fs.readFileSync(path.join(root, ".github", "workflows", "pages.yml"), "utf8");
  assert.match(daily, /generate-plan:\s*\n\s*if:\s*github\.run_attempt == 1/);
  assert.match(daily, /deploy:\s*\n[\s\S]*?if:\s*github\.run_attempt == 1/);
  assert.match(daily, /send-email:\s*\n[\s\S]*?if:\s*github\.run_attempt == 1/);
  assert.match(pages, /build:\s*\n\s*if:\s*github\.run_attempt == 1/);
  assert.match(pages, /deploy:\s*\n[\s\S]*?if:\s*github\.run_attempt == 1/);
});

test("both publish paths refresh limits and build Pages from one validated canonical plan artifact", function () {
  const root = path.join(__dirname, "..", "..");
  const builder = fs.readFileSync(path.join(root, "build-pages.js"), "utf8");
  const daily = fs.readFileSync(path.join(root, ".github", "workflows", "daily-plan.yml"), "utf8");
  const pages = fs.readFileSync(path.join(root, ".github", "workflows", "pages.yml"), "utf8");
  [daily, pages].forEach(function (workflow) {
    assert.ok(workflow.indexOf("Update purchase limits") < workflow.indexOf("Generate canonical recommendation plan"));
    assert.match(workflow, /CANONICAL_RECOMMENDATION_PLAN_PATH/);
    assert.ok(workflow.indexOf("Generate canonical recommendation plan") < workflow.indexOf("node build-pages.js"));
  });
  assert.match(daily, /git add data\/funds\.json/);
  assert.match(builder, /function loadCanonicalRecommendationPlan\(/);
  assert.match(builder, /validateCanonicalRecommendationPlan\(/);
  assert.match(builder, /syncRevision/);
  assert.match(builder, /decisionRevision/);
  assert.match(builder, /CANONICAL_PLAN_LIMIT_MISMATCH/);
});

test("daily workflow never hides rebase or push failures", function () {
  const root = path.join(__dirname, "..", "..");
  const daily = fs.readFileSync(path.join(root, ".github", "workflows", "daily-plan.yml"), "utf8");
  assert.doesNotMatch(daily, /Rebase conflict, skipping push/);
  assert.doesNotMatch(daily, /git push origin main \|\| echo/);
  assert.doesNotMatch(daily, /git pull --rebase/);
  assert.match(daily, /git push origin main/);
});

test("daily data push cannot start a competing Pages workflow that cancels its deployment", function () {
  const root = path.join(__dirname, "..", "..");
  const pages = fs.readFileSync(path.join(root, ".github", "workflows", "pages.yml"), "utf8");
  ["funds", "history", "nav-cache", "recommendation-plan"].forEach(function (name) {
    assert.doesNotMatch(pages, new RegExp("-\\s*['\\\"]data/" + name.replace("-", "\\-") + "\\.json['\\\"]"));
  });
  assert.match(pages, /schedule:[\s\S]*0 \*\/6 \* \* \*/);
});

test("Pages workflow explicitly excludes Firebase Rules deployment", function () {
  const root = path.join(__dirname, "..", "..");
  const pages = fs.readFileSync(path.join(root, ".github", "workflows", "pages.yml"), "utf8");
  assert.doesNotMatch(pages, /firebase deploy|deploy --only database/i);
  assert.match(pages, /does not deploy Firebase Realtime Database Rules/);
});

test("Firebase Rules deployment is isolated, manual, confirmed, and fail-closed", function () {
  const root = path.join(__dirname, "..", "..");
  const rulesWorkflow = fs.readFileSync(path.join(root, ".github", "workflows", "firebase-rules.yml"), "utf8");
  assert.match(rulesWorkflow, /workflow_dispatch:/);
  assert.doesNotMatch(rulesWorkflow, /\bschedule:|\bpush:/);
  assert.match(rulesWorkflow, /FIREBASE_RULES_SERVICE_ACCOUNT/);
  assert.match(rulesWorkflow, /FIREBASE_RULES_PROJECT_ID/);
  assert.match(rulesWorkflow, /CONFIRMED_PROJECT[\s\S]*!= "\$FIREBASE_RULES_PROJECT_ID"[\s\S]*exit 1/);
  assert.match(rulesWorkflow, /firebase\.database\.rules\.json/);
  assert.match(rulesWorkflow, /firebase-tools@14\.12\.1 deploy --only database/);
  assert.doesNotMatch(rulesWorkflow, /continue-on-error:\s*true|\|\|\s*(?:true|echo)/);
});
