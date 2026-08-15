const test = require("node:test");
const assert = require("node:assert/strict");
const { buildDecisionPrompt } = require("../../lib/ai-analyst");

test("AI prompt discloses stale and future NAV issue codes and forbids inferred PnL", function () {
  const prompt = buildDecisionPrompt({
    date: "2026-08-15",
    strategyName: "test",
    totalPool: 0,
    allAvailable: 0,
    budget: 0,
    ranked: [],
    allRanked: [],
    suspended: [],
    fundChanges: [],
    portfolio: {
      empty: false,
      summary: {
        totalInvested: 200,
        pendingInvested: 0,
        totalValue: null,
        totalPnl: null,
        totalPnlRate: null,
        valuationComplete: false,
        missingValuationCodes: ["STALE", "FUTURE"],
        valuationIssues: [
          { code: "STALE", reason: "NAV_STALE", latestDate: "2026-08-10", tradingDayLag: 4 },
          { code: "FUTURE", reason: "NAV_FUTURE", latestDate: "2026-08-18", tradingDayLag: null }
        ],
        holdingCount: 2,
        daysSinceStart: 10
      },
      holdings: [
        { code: "STALE", name: "陈旧基金", confirmedAmount: 100, pnl: null, pnlRate: null, valuationIssue: "NAV_STALE" },
        { code: "FUTURE", name: "未来基金", confirmedAmount: 100, pnl: null, pnlRate: null, valuationIssue: "NAV_FUTURE" }
      ]
    }
  });

  assert.match(prompt, /估值不完整/);
  assert.match(prompt, /NAV_STALE/);
  assert.match(prompt, /NAV_FUTURE/);
  assert.match(prompt, /不得推断市值或盈亏/);
  assert.doesNotMatch(prompt, /陈旧基金[^\n]*-100元/);
});
