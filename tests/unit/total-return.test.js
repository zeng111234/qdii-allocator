const test = require("node:test");
const assert = require("node:assert/strict");

const totalReturn = require("../../lib/total-return");

test("total-return index is not diluted by dividends accumulated before the window", function () {
  const rows = totalReturn.buildReinvestedTotalReturnIndex([
    { date: "2026-01-01", nav: 1, accNav: 2 },
    { date: "2026-01-02", nav: 1.1, accNav: 2.1 }
  ]);
  assert.equal(rows[0].nav, 1);
  assert.ok(Math.abs(rows[1].nav - 1.1) < 1e-12);
  assert.equal(rows[1].totalReturnBasis, totalReturn.TOTAL_RETURN_BASIS);
});

test("total-return index reinvests a distribution without inventing a loss", function () {
  const rows = totalReturn.buildReinvestedTotalReturnIndex([
    { date: "2026-01-01", nav: 1, accNav: 2 },
    { date: "2026-01-02", nav: 0.9, accNav: 2 }
  ]);
  assert.equal(rows[1].nav, 1);
});

test("total-return index excludes rows missing either unit or accumulated NAV", function () {
  const rows = totalReturn.buildReinvestedTotalReturnIndex([
    { date: "2026-01-01", nav: 1, accNav: 1 },
    { date: "2026-01-02", nav: 1.1, accNav: null },
    { date: "2026-01-03", nav: 1.2, accNav: 1.2 }
  ]);
  assert.deepEqual(rows.map(function (row) { return row.date; }), ["2026-01-01", "2026-01-03"]);
  assert.ok(Math.abs(rows[1].nav - 1.2) < 1e-12);
});
