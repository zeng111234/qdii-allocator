const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..", "..");
const template = fs.readFileSync(path.join(root, "docs", "index.html.template"), "utf8");
const workflow = fs.readFileSync(path.join(root, ".github", "workflows", "daily-plan.yml"), "utf8");
const pagesWorkflow = fs.readFileSync(path.join(root, ".github", "workflows", "pages.yml"), "utf8");
const indexSource = fs.readFileSync(path.join(root, "index.js"), "utf8");

test("public template supports an explicit read-only account view without cloud writes", function () {
  assert.match(template, /var portfolioData = \{"holdings":\[\]\};/);
  assert.match(template, /正在同步/);
  assert.match(template, /sync-revision/);
  assert.match(template, /cloudWriteReady && planAllowsPurchase/);
  assert.match(template, /function loadLegacyChromeReadOnlySnapshot\(\)/);
  assert.match(template, /detail\.status === 'CONFIG_MISSING' \|\| detail\.status === 'EMPTY'/);
  assert.match(template, /source: 'Chrome 本地只读'/);
  assert.match(template, /function renderUnavailableLedgerState\(detail\)/);
  assert.match(template, /当前浏览器没有可显示的持仓数据/);
  assert.match(template, /登录并同步持仓/);
  assert.match(template, /导入账本备份/);
  assert.match(template, /if \(loadLegacyChromeReadOnlySnapshot\(\)\)/);
  assert.match(template, /localStorage\.setItem\(STORAGE_KEY, JSON\.stringify\(portfolioData\)\)/);
  assert.match(template, /payload && payload\.chrome && payload\.chrome\.holdings \? payload\.chrome : payload/);
});

test("browser sync uses Firebase Web SDK Google auth and uid-scoped ledger", function () {
  const source = fs.readFileSync(path.join(root, "docs", "firebase-sync.js"), "utf8");
  assert.match(source, /firebase-app\.js/);
  assert.match(source, /GoogleAuthProvider/);
  assert.match(source, /users.*uid.*portfolioLedger/s);
  assert.match(source, /users.*uid.*strategyState/s);
  assert.match(source, /runTransaction/);
  assert.match(source, /REVISION_CONFLICT/);
  assert.match(source, /本地只读快照/);
  assert.doesNotMatch(source, /FIREBASE_KEY/);
  assert.doesNotMatch(source, /localStorage\.(?:getItem|setItem)\(\s*['"][^'"]*(?:key|token)[^'"]*['"]/i);
  assert.doesNotMatch(template, /api\.github\.com\/gists|GIST_TOKEN_KEY|qdii-gist-token/);
});

test("public snapshot loads without fetching Firebase SDK until cloud login is configured", function () {
  const source = fs.readFileSync(path.join(root, "docs", "firebase-sync.js"), "utf8");
  assert.doesNotMatch(source, /^import\s/m);
  assert.match(source, /if \(!configured\)[\s\S]*return;/);
  assert.match(source, /await loadFirebaseModules\(\)/);
  assert.match(source, /import\("https:\/\/www\.gstatic\.com\/firebasejs\/11\.10\.0\/firebase-app\.js"\)/);
});

test("Chrome migration uses an ETag conditional write and verifies the committed ledger", function () {
  const source = fs.readFileSync(path.join(root, "docs", "firebase-sync.js"), "utf8");
  assert.match(source, /getIdToken/);
  assert.match(source, /async function readLedgerWithEtag/);
  assert.match(source, /"X-Firebase-ETag": "true"/);
  assert.match(source, /"if-match": expected\.etag/);
  assert.match(source, /response\.status === 412/);
  assert.match(source, /ETAG_CONFLICT/);
  assert.match(source, /const verified = await readLedgerWithEtag\(false\)/);
  assert.match(source, /READBACK_MISMATCH/);
  assert.match(source, /migrateLegacyPortfolio\(portfolio, Number\(preview\.cloudRevision\) \+ 1\)/);
  assert.match(source, /cloudEtag: cloud\.etag/);
  assert.match(source, /nextRevision: cloudRevision \+ 1/);
});

test("personalized decision state is uid-scoped and never initialized silently", function () {
  const source = fs.readFileSync(path.join(root, "docs", "firebase-sync.js"), "utf8");
  assert.match(source, /users.*uid.*decisionState/s);
  assert.match(source, /initializeRiskAnchor/);
  assert.match(source, /schemaVersion: 2/);
  assert.match(source, /riskAnchorTransactionIds/);
  assert.match(source, /RISK_ANCHOR_ALREADY_SET/);
  assert.doesNotMatch(source, /try\s*\{\s*await initializeRiskAnchor\(/);
  assert.match(template, /personalized-decision\.js/);
  assert.match(template, /firebaseSetRiskAnchor/);
  assert.match(template, /decision-anchor-card/);
  assert.match(template, /refreshPersonalizedPlan/);
});

test("browser ledger validation rejects impossible calendar dates like the server", function () {
  const source = fs.readFileSync(path.join(root, "docs", "firebase-sync.js"), "utf8");
  assert.match(source, /function isIsoCalendarDate\(value\)/);
  assert.match(source, /!isIsoCalendarDate\(tx\.tradeDate\)/);
  assert.match(source, /getUTCFullYear\(\) === year/);
  assert.match(source, /typeof ledger\.schemaVersion !== "number"/);
  assert.match(source, /typeof ledger\.revision !== "number"/);
  assert.match(source, /const rawType = transaction && transaction\.type/);
  assert.match(source, /rawType !== "BUY" && rawType !== "SELL"/);
  assert.match(source, /typeof rawAmount !== "number"/);
  assert.match(source, /typeof rawNav !== "number"/);
  assert.match(source, /typeof rawShares !== "number"/);
  assert.match(source, /rawType === "SELL"/);
  assert.match(source, /rawAmount <= 0/);
  assert.match(source, /rawNav <= 0/);
  assert.match(source, /rawShares <= 0/);
});

test("browser portfolio derivation preserves realized PnL after a complete exit", function () {
  const source = fs.readFileSync(path.join(root, "docs", "firebase-sync.js"), "utf8");
  const canonicalStart = source.indexOf("function canonicalTransaction(transaction)");
  const canonicalEnd = source.indexOf("\nfunction isIsoCalendarDate", canonicalStart);
  const deriveStart = source.indexOf("function derivePortfolio(ledger)");
  const deriveEnd = source.indexOf("\nfunction ledgerPath", deriveStart);
  assert.ok(canonicalStart >= 0 && canonicalEnd > canonicalStart, "应能提取浏览器交易归一化函数");
  assert.ok(deriveStart >= 0 && deriveEnd > deriveStart, "应能提取浏览器账本派生函数");
  const browserDerivePortfolio = new Function(
    source.slice(canonicalStart, canonicalEnd) + "\n" +
    source.slice(deriveStart, deriveEnd) + "\nreturn derivePortfolio;"
  )();

  const portfolio = browserDerivePortfolio({
    schemaVersion: 2,
    revision: 2,
    checksum: "test-checksum",
    fundNames: { "096001": "大成标普500A" },
    transactions: [
      { id: "buy", type: "BUY", code: "096001", tradeDate: "2026-08-01", amount: 100, nav: 1, shares: 100 },
      { id: "sell", type: "SELL", code: "096001", tradeDate: "2026-08-10", amount: 120, nav: 1.2, shares: 100 }
    ]
  });

  assert.deepEqual(portfolio.holdings, []);
  assert.equal(portfolio.closedPositions.length, 1);
  assert.equal(portfolio.closedPositions[0].code, "096001");
  assert.equal(portfolio.closedPositions[0].realizedPnl, 20);
  assert.equal(portfolio.closedRealizedPnl, 20);
});

test("risk profile is explicit, persisted, and the public snapshot prefers the embedded cloud state", function () {
  const source = fs.readFileSync(path.join(root, "docs", "firebase-sync.js"), "utf8");
  assert.match(source, /riskProfile/);
  assert.match(source, /state\.riskProfile \|\| "AGGRESSIVE"/);
  assert.match(source, /updateRiskProfile/);
  assert.match(source, /updatePublicRiskProfile/);
  assert.match(source, /window\.QDII_PUBLIC_DECISION_STATE/);
  assert.match(template, /id="risk-profile-select"/);
  assert.match(template, /firebaseSetRiskProfile/);
  assert.match(template, /defaultRiskProfile/);
  assert.match(template, /STRATEGIC_DCA/);
  assert.match(template, /window\.QDII_PUBLIC_DECISION_STATE = PUBLIC_DECISION_STATE_PLACEHOLDER/);
  assert.match(template, /window\.QDII_PUBLIC_PLAN_CANONICAL = PUBLIC_PLAN_CANONICAL_PLACEHOLDER/);
});

test("browser decision-state validation fails closed exactly like the server", function () {
  const source = fs.readFileSync(path.join(root, "docs", "firebase-sync.js"), "utf8");
  const match = source.match(/function normalizeDecisionState\(state\) \{([\s\S]*?)\r?\n\}\r?\n\r?\nfunction normalizeStrategyState/);
  assert.ok(match, "应能提取浏览器 decisionState 归一化函数");
  const isoMatch = source.match(/function isCanonicalUtcIsoTimestamp\(value\) \{([\s\S]*?)\r?\n\}/);
  assert.ok(isoMatch, "应能提取严格 UTC ISO 时间校验函数");
  const normalizeDecisionState = new Function("state", "isCanonicalUtcIsoTimestamp", match[1]);
  const isCanonicalUtcIsoTimestamp = new Function("value", isoMatch[1]);
  const valid = {
    schemaVersion: 2,
    revision: 1,
    updatedAt: "2026-08-13T00:00:00.000Z",
    riskAnchorValue: 1000,
    riskAnchorAt: "2026-08-13T00:00:00.000Z",
    riskAnchorLedgerRevision: 1,
    riskAnchorTransactionIds: [],
    riskProfile: "AGGRESSIVE",
    cashBalance: 0
  };
  function normalize(state) { return normalizeDecisionState(state, isCanonicalUtcIsoTimestamp); }
  assert.equal(normalize(valid).riskAnchorLedgerRevision, 1);
  assert.throws(function () { normalize(Object.assign({}, valid, { riskAnchorLedgerRevision: 0 })); });
  assert.throws(function () { normalize(Object.assign({}, valid, { riskAnchorAt: "" })); }, /INVALID_RISK_ANCHOR_AT/);
  assert.throws(function () { normalize(Object.assign({}, valid, { updatedAt: "" })); }, /INVALID_UPDATED_AT/);
  assert.throws(function () { normalize(Object.assign({}, valid, { riskAnchorAt: "2026-02-30T00:00:00.000Z" })); }, /INVALID_RISK_ANCHOR_AT/);
  assert.throws(function () { normalize(Object.assign({}, valid, { updatedAt: "2026-08-13T00:00:00Z" })); }, /INVALID_UPDATED_AT/);
  assert.throws(function () { normalize(Object.assign({}, valid, { riskAnchorTransactionIds: "bad" })); });
  assert.throws(function () { normalize(Object.assign({}, valid, { cashBalance: -1 })); });
});

test("browser accepts only server-written strategy state and uses it as a fresh plan source", function () {
  const source = fs.readFileSync(path.join(root, "docs", "firebase-sync.js"), "utf8");
  assert.match(source, /normalizeStrategyState/);
  assert.match(source, /strategyStatePath/);
  assert.match(source, /strategyState: currentStrategyState/);
  assert.match(template, /backendState = currentCloudDetail\.strategyState/);
  assert.match(template, /backendPlan\.dataFreshness\.status === 'FRESH'/);
});

test("database rules allow only the authenticated uid path", function () {
  const rules = JSON.parse(fs.readFileSync(path.join(root, "firebase.database.rules.json"), "utf8"));
  const userRule = rules.rules.users.$uid;
  assert.match(userRule.portfolioLedger[".read"], /auth\.uid === \$uid/);
  assert.match(userRule.portfolioLedger[".write"], /auth\.uid === \$uid/);
  assert.match(userRule.decisionState[".write"], /auth\.uid === \$uid/);
  assert.match(userRule.strategyState[".read"], /auth\.uid === \$uid/);
  assert.equal(userRule.strategyState[".write"], false);
  assert.equal(rules.rules[".read"], false);
  assert.equal(rules.rules[".write"], false);
});

test("database rules accept the decision-state schema written by the browser", function () {
  const rules = JSON.parse(fs.readFileSync(path.join(root, "firebase.database.rules.json"), "utf8"));
  const validation = rules.rules.users.$uid.decisionState[".validate"];
  assert.match(validation, /schemaVersion'\)\.val\(\) === 1/);
  assert.match(validation, /schemaVersion'\)\.val\(\) === 2/);
});

test("Actions never commit the private portfolio and always removes its temp ledger", function () {
  assert.doesNotMatch(workflow, /git add[^\n]*data\/portfolio\.json/);
  assert.match(workflow, /PRIVATE_LEDGER_PATH/);
  assert.match(workflow, /rm -f "\$PRIVATE_LEDGER_PATH"/);
  assert.doesNotMatch(workflow, /continue-on-error:\s*true\s*\n\s*run:[^\n]*portfolio/i);
  assert.match(workflow, /PRIVATE_RECOMMENDATION_STATE_AVAILABLE=0/);
  assert.match(workflow, /public market data and Pages will still update/);
});

test("public Pages snapshot is explicit, derived from the private ledger, and read-only in the browser", function () {
  const builder = fs.readFileSync(path.join(root, "build-pages.js"), "utf8");
  const client = fs.readFileSync(path.join(root, "docs", "firebase-sync.js"), "utf8");
  assert.match(builder, /PUBLIC_PORTFOLIO_SNAPSHOT/);
  assert.match(builder, /PUBLIC_PORTFOLIO_SNAPSHOT_REQUIRES_PRIVATE_LEDGER/);
  assert.match(builder, /ledgerTools\.derivePortfolio\(publicLedger\)/);
  assert.match(builder, /QDII_PUBLIC_PORTFOLIO_SNAPSHOT_PLACEHOLDER/);
  assert.match(client, /status: "PUBLIC_SNAPSHOT"/);
  assert.match(template, /window\.QDII_PUBLIC_PORTFOLIO_SNAPSHOT/);
  assert.match(template, /status === 'PUBLIC_SNAPSHOT'/);
  assert.match(builder, /const publicPortfolioSnapshot = Boolean\(publicLedger\)/);
  assert.match(builder, /const canonicalPublicPlan = Boolean\(publicLedger && publicDecisionState && canonicalRecommendationPlan\)/);
  assert.match(indexSource, /process\.env\.PORTFOLIO_READ_ONLY === "1"/);
  assert.match(indexSource, /recommendationPlan\.publicPortfolioSnapshot = portfolioSnapshot/);
  assert.match(indexSource, /function persistPublicPortfolioSnapshot\(\)/);
  assert.match(indexSource, /opts\.dryRun && process\.env\.PORTFOLIO_READ_ONLY === "1"/);
  assert.match(indexSource, /跳过策略、AI 和邮件/);
});

test("Pages deployment fetches a validated temporary ledger and decision state before publishing", function () {
  assert.match(pagesWorkflow, /Configure private recommendation state temp paths/);
  assert.match(pagesWorkflow, /Fetch and validate private recommendation state/);
  assert.match(pagesWorkflow, /PRIVATE_RECOMMENDATION_STATE_AVAILABLE=1/);
  assert.match(pagesWorkflow, /PUBLIC_PORTFOLIO_SNAPSHOT: \$\{\{ env\.PRIVATE_RECOMMENDATION_STATE_AVAILABLE == '1' && '1' \|\| '0' \}\}/);
  assert.match(pagesWorkflow, /Remove private recommendation state temp files/);
  assert.match(pagesWorkflow, /rm -f "\$PRIVATE_LEDGER_PATH"/);
  assert.match(pagesWorkflow, /"\$PRIVATE_DECISION_STATE_PATH"/);
  assert.doesNotMatch(pagesWorkflow, /echo .*FIREBASE_KEY/i);
});

test("public snapshots can calculate a read-only plan after an explicit local risk-anchor confirmation", function () {
  const builder = fs.readFileSync(path.join(root, "build-pages.js"), "utf8");
  const client = fs.readFileSync(path.join(root, "docs", "firebase-sync.js"), "utf8");
  assert.match(template, /PUBLIC_PORTFOLIO_LEDGER_PLACEHOLDER/);
  assert.match(builder, /PUBLIC_PORTFOLIO_LEDGER_PLACEHOLDER/);
  assert.match(client, /initializePublicRiskAnchor/);
  assert.match(client, /emitLedger\("公开只读快照", true\)/);
  assert.match(template, /detail\.status === 'PUBLIC_SNAPSHOT'[\s\S]*refreshPersonalizedPlan\(currentCloudDetail\)/);
});

test("deployed public snapshots keep the build-time canonical plan and decision state", function () {
  const builder = fs.readFileSync(path.join(root, "build-pages.js"), "utf8");
  const client = fs.readFileSync(path.join(root, "docs", "firebase-sync.js"), "utf8");
  assert.match(builder, /PUBLIC_DECISION_STATE_PLACEHOLDER/);
  assert.match(builder, /PRIVATE_DECISION_STATE_PATH/);
  assert.match(client, /const embedded = window\.QDII_PUBLIC_DECISION_STATE/);
  assert.match(client, /window\.QDII_PUBLIC_PLAN_CANONICAL === true/);
  assert.match(template, /function isCanonicalPublicSnapshot\(detail\)/);
  assert.match(template, /hasCanonicalBuildPlan\(\)[\s\S]*canonicalPlanInputsMatch\(publicTodayPicks, currentCloudDetail\)/);
  assert.match(template, /buildCanonicalRevisionMismatchPlan\(publicTodayPicks\)/);
  assert.match(template, /function firebaseSetRiskAnchor\(\)[\s\S]*isCanonicalPublicSnapshot\(currentCloudDetail\)/);
  assert.match(template, /function firebaseSetRiskProfile\(riskProfile\)[\s\S]*isCanonicalPublicSnapshot\(currentCloudDetail\)/);
  assert.match(client, /window\.QDII_PUBLIC_PLAN_CANONICAL === true\s*\?\s*null\s*:/);
  assert.match(client, /if \(window\.QDII_PUBLIC_PLAN_CANONICAL !== true\) \{\s*saveStrategySnapshot/);
});

test("public snapshot can switch to authenticated append-only editing", function () {
  const client = fs.readFileSync(path.join(root, "docs", "firebase-sync.js"), "utf8");
  assert.match(client, /async function initializeFirebase\(preservePublicLedger\)/);
  assert.match(client, /await initializeFirebase\(true\)/);
  assert.match(client, /async function appendBuyTransactions\(drafts\)/);
  assert.match(client, /appendBuyTransactions:\s*appendBuyTransactions/);
  assert.match(template, /status\.status === 'PUBLIC_SNAPSHOT' && status\.canSignIn === true/);
  assert.match(template, /登录并编辑/);
  assert.match(template, /QdiiCloudSync\.appendBuyTransactions/);
  assert.doesNotMatch(template, /async function addBuy\(\)[\s\S]*?holding\.buys\.push[\s\S]*?saveLocal\(\)/);
});
