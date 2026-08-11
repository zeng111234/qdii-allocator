const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("page build destroys stalled market-data requests instead of hanging", function () {
  const source = fs.readFileSync(path.join(__dirname, "..", "..", "build-pages.js"), "utf8");
  assert.match(source, /\.on\("timeout",\s*\(\)\s*=>\s*req\.destroy\(/);
});

test("public snapshot build migrates a legacy portfolio in memory before validation", function () {
  const source = fs.readFileSync(path.join(__dirname, "..", "..", "build-pages.js"), "utf8");
  assert.match(source, /ledgerTools\.migrateLegacyPortfolio\(source/);
  assert.match(source, /PUBLIC_PORTFOLIO_SNAPSHOT_REQUIRES_PRIVATE_LEDGER/);
});

test("page build uses current shadow outcomes and the same live acceptance gate as email", function () {
  const source = fs.readFileSync(path.join(__dirname, "..", "..", "build-pages.js"), "utf8");
  assert.match(source, /backfillHistoryFollowUp\(navCache\)/);
  assert.match(source, /buildLiveAcceptanceMetrics\(/);
  assert.match(source, /acceptance:\s*acceptanceMetrics/);
});

test("both Pages build paths receive the recommendation live switch", function () {
  const root = path.join(__dirname, "..", "..");
  const daily = fs.readFileSync(path.join(root, ".github", "workflows", "daily-plan.yml"), "utf8");
  const pages = fs.readFileSync(path.join(root, ".github", "workflows", "pages.yml"), "utf8");
  const liveSwitch = /RECOMMENDATION_LIVE_ENABLED:\s*\$\{\{\s*secrets\.RECOMMENDATION_LIVE_ENABLED\s*\}\}/g;
  assert.equal((daily.match(liveSwitch) || []).length, 2, "daily workflow must pass the switch to allocation and page build");
  assert.equal((pages.match(liveSwitch) || []).length, 1, "scheduled Pages build must receive the switch");
});
