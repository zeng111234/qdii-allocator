const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..", "..");
const template = fs.readFileSync(path.join(root, "docs", "index.html.template"), "utf8");
const workflow = fs.readFileSync(path.join(root, ".github", "workflows", "daily-plan.yml"), "utf8");

test("public template contains no personal holdings and starts in syncing state", function () {
  assert.match(template, /var portfolioData = \{"holdings":\[\]\};/);
  assert.doesNotMatch(template, /"holdings":\[\{"code"/);
  assert.match(template, /正在同步/);
  assert.match(template, /sync-revision/);
  assert.match(template, /cloudWriteReady && todayPicks\.action === 'BUY'/);
  assert.match(template, /系统预算 0 元/);
});

test("browser sync uses Firebase Web SDK Google auth and uid-scoped ledger", function () {
  const source = fs.readFileSync(path.join(root, "docs", "firebase-sync.js"), "utf8");
  assert.match(source, /firebase-app\.js/);
  assert.match(source, /GoogleAuthProvider/);
  assert.match(source, /users.*uid.*portfolioLedger/s);
  assert.match(source, /runTransaction/);
  assert.match(source, /REVISION_CONFLICT/);
  assert.match(source, /本地只读快照/);
  assert.doesNotMatch(source, /FIREBASE_KEY|localStorage.*(?:key|token)/i);
  assert.doesNotMatch(template, /api\.github\.com\/gists|GIST_TOKEN_KEY|qdii-gist-token/);
});

test("database rules allow only the authenticated uid path", function () {
  const rules = JSON.parse(fs.readFileSync(path.join(root, "firebase.database.rules.json"), "utf8"));
  const userRule = rules.rules.users.$uid;
  assert.match(userRule[".read"], /auth\.uid === \$uid/);
  assert.match(userRule[".write"], /auth\.uid === \$uid/);
  assert.equal(rules.rules[".read"], false);
  assert.equal(rules.rules[".write"], false);
});

test("Actions never commit the private portfolio and always removes its temp ledger", function () {
  assert.doesNotMatch(workflow, /git add[^\n]*data\/portfolio\.json/);
  assert.match(workflow, /PRIVATE_LEDGER_PATH/);
  assert.match(workflow, /rm -f "\$PRIVATE_LEDGER_PATH"/);
  assert.doesNotMatch(workflow, /continue-on-error:\s*true\s*\n\s*run:[^\n]*portfolio/i);
});
