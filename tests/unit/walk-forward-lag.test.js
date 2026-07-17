const test = require("node:test");
const assert = require("node:assert/strict");

const walkForward = require("../../lib/walk-forward");

test("execution lag scenarios show the high-entry risk explicitly", function () {
  const history = [
    { date: "2026-01-01", nav: 1.00 },
    { date: "2026-01-02", nav: 1.10 },
    { date: "2026-01-03", nav: 1.20 },
    { date: "2026-01-04", nav: 1.10 }
  ];
  const scenarios = walkForward.simulateExecutionLagScenarios(history, 0, 3, [0, 1, 2], { buyFeeRate: 0, sellFeeRate: 0 });
  assert.deepEqual(scenarios.map(function (row) { return row.buyDate; }), ["2026-01-01", "2026-01-02", "2026-01-03"]);
  assert.ok(scenarios[0].netReturn > scenarios[1].netReturn);
  assert.ok(scenarios[1].netReturn > scenarios[2].netReturn);
});

test("execution lag scenarios deduct buy and redemption fees", function () {
  const history = [{ date: "2026-01-01", nav: 1 }, { date: "2026-01-02", nav: 1.1 }];
  const withoutFees = walkForward.simulateExecutionLagScenarios(history, 0, 1, [0], { buyFeeRate: 0, sellFeeRate: 0 })[0];
  const withFees = walkForward.simulateExecutionLagScenarios(history, 0, 1, [0], { buyFeeRate: 0.01, sellFeeRate: 0.01 })[0];
  assert.ok(withFees.netReturn < withoutFees.netReturn);
  assert.equal(withFees.feesIncluded, true);
});
