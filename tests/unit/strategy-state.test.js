const test = require("node:test");
const assert = require("node:assert/strict");
const state = require("../../lib/strategy-state");

function navs(values) {
  return values.map(function(value, index) {
    return { date: "2026-07-" + String(index + 1).padStart(2, "0"), nav: value };
  });
}

test("strategy state keeps one observation per day and preserves completed outcomes", function () {
  const plan = {
    asOf: "2026-07-01", strategyVersion: "allocation-v2.1-balanced", action: "PAUSE",
    candidates: [{ code: "A", name: "Fund A", indexGroup: "SPX", marketScore: 72 }]
  };
  const first = state.advanceState({}, plan, { A: navs([10, 10, 10, 10, 10, 11, 12, 12, 12, 12, 13]) }, "2026-07-20T00:00:00.000Z");
  assert.equal(first.observations.length, 1);
  assert.equal(first.observations[0].ranked[0].followUp5dReturn, 10);
  assert.equal(first.observations[0].ranked[0].followUp10dReturn, 30);

  const second = state.advanceState(first, Object.assign({}, plan, { candidates: [{ code: "A", name: "Renamed", indexGroup: "SPX", marketScore: 80 }] }), { A: navs([10, 10, 10, 10, 10, 9, 9, 9, 9, 9, 9]) }, "2026-07-21T00:00:00.000Z");
  assert.equal(second.observations.length, 1);
  assert.equal(second.observations[0].ranked[0].followUp5dReturn, 10);
  assert.equal(second.summary.completed5dResults, 1);
});

test("strategy state backfills older observations when later NAV data arrives", function () {
  const plan = {
    asOf: "2026-07-01", action: "PAUSE", candidates: [{ code: "A", name: "Fund A" }]
  };
  const initial = state.advanceState({}, plan, { A: navs([10, 10, 10]) }, "2026-07-03T00:00:00.000Z");
  assert.equal(initial.summary.completed5dResults, 0);

  const nextPlan = {
    asOf: "2026-07-02", action: "PAUSE", candidates: [{ code: "B", name: "Fund B" }]
  };
  const advanced = state.advanceState(initial, nextPlan, {
    A: navs([10, 10, 10, 10, 10, 9]),
    B: navs([10, 10, 10, 10, 10, 10, 10])
  }, "2026-07-10T00:00:00.000Z");
  assert.equal(advanced.observations[0].ranked[0].followUp5dReturn, -10);
  assert.equal(advanced.summary.completed5dResults, 2);
  assert.equal(advanced.summary.positive5dResults, 0);
});

test("strategy state accepts only normalized plan dates", function () {
  assert.throws(function() {
    state.advanceState({}, { asOf: "not-a-date", candidates: [] }, {}, "2026-07-01T00:00:00.000Z");
  }, /INVALID_PLAN_DATE/);
});
