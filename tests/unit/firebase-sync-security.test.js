const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..", "..");
const template = fs.readFileSync(path.join(root, "docs", "index.html.template"), "utf8");
const workflow = fs.readFileSync(path.join(root, ".github", "workflows", "daily-plan.yml"), "utf8");
const indexSource = fs.readFileSync(path.join(root, "index.js"), "utf8");

test("public template contains no personal holdings and supports a local-only account view", function () {
  assert.match(template, /var portfolioData = \{"holdings":\[\]\};/);
  assert.doesNotMatch(template, /"holdings":\[\{"code"/);
  assert.match(template, /正在同步/);
  assert.match(template, /sync-revision/);
  assert.match(template, /cloudWriteReady && actionAllowsPurchase\(todayPicks\)/);
  assert.match(template, /本机账本可查看；登录同步后才计算个人预算/);
  assert.match(template, /function loadLegacyChromeReadOnlySnapshot\(\)/);
  assert.match(template, /detail\.status === 'CONFIG_MISSING' \|\| detail\.status === 'EMPTY'/);
  assert.match(template, /source: 'Chrome 本地只读'/);
  assert.match(template, /function renderUnavailableLedgerState\(detail\)/);
  assert.match(template, /当前浏览器没有可显示的持仓数据/);
  assert.match(template, /可在保存过持仓的浏览器直接查看本机账本/);
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
  assert.doesNotMatch(source, /FIREBASE_KEY|localStorage.*(?:key|token)/i);
  assert.doesNotMatch(template, /api\.github\.com\/gists|GIST_TOKEN_KEY|qdii-gist-token/);
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

test("Actions never commit the private portfolio and always removes its temp ledger", function () {
  assert.doesNotMatch(workflow, /git add[^\n]*data\/portfolio\.json/);
  assert.match(workflow, /PRIVATE_LEDGER_PATH/);
  assert.match(workflow, /rm -f "\$PRIVATE_LEDGER_PATH"/);
  assert.doesNotMatch(workflow, /continue-on-error:\s*true\s*\n\s*run:[^\n]*portfolio/i);
  assert.match(workflow, /PRIVATE_LEDGER_AVAILABLE=0/);
  assert.match(workflow, /public market data and Pages will still update/);
});

test("public Pages snapshot is explicit, derived from the private ledger, and read-only in the browser", function () {
  const builder = fs.readFileSync(path.join(root, "build-pages.js"), "utf8");
  const client = fs.readFileSync(path.join(root, "docs", "firebase-sync.js"), "utf8");
  assert.match(builder, /PUBLIC_PORTFOLIO_SNAPSHOT/);
  assert.match(builder, /PUBLIC_PORTFOLIO_SNAPSHOT_REQUIRES_PRIVATE_LEDGER/);
  assert.match(builder, /ledgerTools\.derivePortfolio\(ledger\)/);
  assert.match(builder, /QDII_PUBLIC_PORTFOLIO_SNAPSHOT_PLACEHOLDER/);
  assert.match(client, /status: "PUBLIC_SNAPSHOT"/);
  assert.match(template, /window\.QDII_PUBLIC_PORTFOLIO_SNAPSHOT/);
  assert.match(template, /status === 'PUBLIC_SNAPSHOT'/);
  assert.match(builder, /plan\.publicPortfolioSnapshot/);
  assert.match(indexSource, /process\.env\.PORTFOLIO_READ_ONLY === "1"/);
  assert.match(indexSource, /recommendationPlan\.publicPortfolioSnapshot = portfolioSnapshot/);
  assert.match(indexSource, /function persistPublicPortfolioSnapshot\(\)/);
  assert.match(indexSource, /opts\.dryRun && process\.env\.PORTFOLIO_READ_ONLY === "1"/);
  assert.match(indexSource, /跳过策略、AI 和邮件/);
});
