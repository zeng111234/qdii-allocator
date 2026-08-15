const test = require("node:test");
const assert = require("node:assert/strict");

const goalPlanner = require("../../lib/goal-planner");

const AS_OF = new Date("2026-07-01T00:00:00Z");

test("annualized return excludes pending buys with zero shares", function () {
  const result = goalPlanner.calculateAnnualizedReturn({
    startDate: "2025-07-01",
    holdings: [{ code: "A", buys: [
      { type: "BUY", amount: 100, nav: 1, shares: 100 },
      { type: "BUY", amount: 50, nav: 1.1, shares: 0 }
    ] }]
  }, { A: [{ date: "2026-06-30", nav: 1.1 }] }, AS_OF);

  assert.equal(result, 10);
});

test("annualized return applies SELL cash flows with their signed direction", function () {
  const result = goalPlanner.calculateAnnualizedReturn({
    startDate: "2025-07-01",
    holdings: [{ code: "A", buys: [
      { type: "BUY", amount: 100, nav: 1, shares: 100 },
      { type: "SELL", amount: 60, nav: 1.2, shares: 50 }
    ] }]
  }, { A: [{ date: "2026-06-30", nav: 1.2 }] }, AS_OF);

  assert.equal(result, 50);
});

test("annualized return is unavailable when any confirmed holding lacks current NAV", function () {
  const result = goalPlanner.calculateAnnualizedReturn({
    startDate: "2025-07-01",
    holdings: [{ code: "A", confirmedAmount: 100, totalShares: 100, buys: [
      { type: "BUY", amount: 100, nav: 1, shares: 100 }
    ] }]
  }, {}, AS_OF);

  assert.equal(result, null);
});
