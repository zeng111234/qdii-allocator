const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const HYP_FILE = path.join(__dirname, "..", "..", "data", "hypotheses.json");

function backup() {
  if (fs.existsSync(HYP_FILE)) fs.copyFileSync(HYP_FILE, HYP_FILE + ".bak");
}
function restore() {
  if (fs.existsSync(HYP_FILE + ".bak")) {
    fs.copyFileSync(HYP_FILE + ".bak", HYP_FILE);
    fs.unlinkSync(HYP_FILE + ".bak");
  }
}
function reset() {
  fs.writeFileSync(
    HYP_FILE,
    JSON.stringify({ hypotheses: [], stats: { total: 0, validated: 0, invalidated: 0, expired: 0 } })
  );
}

// Helper: create a hypothesis and return it (reserved for future tests)
function _createTestHypothesis(overrides) {
  const defaults = {
    fundCode: "000001",
    fundName: "Test Fund",
    type: "趋势跟踪",
    thesis: "Test thesis",
    conditions: { target: 10, stopLoss: -5, timeHorizon: 30 }
  };
  const opts = Object.assign({}, defaults, overrides || {});
  const he = require("../../lib/hypothesis-engine");
  return he.createHypothesis(opts.fundCode, opts.fundName, opts.type, opts.thesis, opts.conditions);
}

test("loadHypotheses returns object with hypotheses array and stats", function () {
  backup();
  try {
    reset();
    delete require.cache[require.resolve("../../lib/hypothesis-engine")];
    const he = require("../../lib/hypothesis-engine");
    const data = he.loadHypotheses();
    assert.ok(data !== null && typeof data === "object", "should return an object");
    assert.ok(Array.isArray(data.hypotheses), "should have hypotheses array");
    assert.ok(data.stats !== null && typeof data.stats === "object", "should have stats object");
    assert.strictEqual(data.stats.total, 0);
    assert.strictEqual(data.stats.validated, 0);
    assert.strictEqual(data.stats.invalidated, 0);
    assert.strictEqual(data.stats.expired, 0);
  } finally {
    restore();
  }
});

test("createHypothesis creates and saves a hypothesis with correct fields", function () {
  backup();
  try {
    reset();
    delete require.cache[require.resolve("../../lib/hypothesis-engine")];
    const he = require("../../lib/hypothesis-engine");
    const h = he.createHypothesis("110011", "Test Fund", "均值回归", "Fund is oversold", {
      target: 15,
      stopLoss: -10,
      timeHorizon: 60
    });
    assert.ok(h.id && h.id.startsWith("H"), "should have an id starting with H");
    assert.strictEqual(h.fundCode, "110011");
    assert.strictEqual(h.fundName, "Test Fund");
    assert.strictEqual(h.type, "均值回归");
    assert.strictEqual(h.thesis, "Fund is oversold");
    assert.deepStrictEqual(h.conditions, { target: 15, stopLoss: -10, timeHorizon: 60 });
    assert.strictEqual(h.status, "active");
    assert.ok(h.createdAt, "should have createdAt");
    assert.strictEqual(h.navAtCreation, null);
    assert.strictEqual(h.validatedAt, null);
    assert.strictEqual(h.invalidatedAt, null);
    assert.strictEqual(h.outcome, null);
    assert.deepStrictEqual(h.followUpReturns, { "3d": null, "7d": null, "14d": null, "30d": null });

    // Verify it was persisted
    const data = he.loadHypotheses();
    assert.strictEqual(data.hypotheses.length, 1);
    assert.strictEqual(data.stats.total, 1);
  } finally {
    restore();
  }
});

test("updateHypothesisReturns calculates follow-up returns from navCache", function () {
  backup();
  try {
    reset();
    delete require.cache[require.resolve("../../lib/hypothesis-engine")];
    const he = require("../../lib/hypothesis-engine");
    const h = he.createHypothesis("000001", "Fund", "趋势跟踪", "test", {
      target: 999,
      stopLoss: -999,
      timeHorizon: 999
    });
    const createdDate = h.createdAt.substring(0, 10);

    // Build a navCache with entries on the creation date and +3, +7, +14, +30 days
    const baseDate = new Date(createdDate);
    const dateOffset = days => {
      const d = new Date(baseDate);
      d.setDate(d.getDate() + days);
      return d.toISOString().substring(0, 10);
    };
    const navCache = {
      "000001": [
        { date: dateOffset(0), nav: 1.0 },
        { date: dateOffset(3), nav: 1.03 },
        { date: dateOffset(7), nav: 1.07 },
        { date: dateOffset(14), nav: 1.14 },
        { date: dateOffset(30), nav: 1.3 }
      ]
    };

    const result = he.updateHypothesisReturns(navCache);
    const updated = result.hypotheses[0];
    assert.strictEqual(updated.followUpReturns["3d"], 3);
    assert.strictEqual(updated.followUpReturns["7d"], 7);
    assert.strictEqual(updated.followUpReturns["14d"], 14);
    assert.strictEqual(updated.followUpReturns["30d"], 30);
    assert.strictEqual(updated.navAtCreation, 1.0);
  } finally {
    restore();
  }
});

test("updateHypothesisReturns marks as VALIDATED when return >= target", function () {
  backup();
  try {
    reset();
    delete require.cache[require.resolve("../../lib/hypothesis-engine")];
    const he = require("../../lib/hypothesis-engine");
    const h = he.createHypothesis("000001", "Fund", "趋势跟踪", "test", { target: 5, stopLoss: -10, timeHorizon: 999 });
    const createdDate = h.createdAt.substring(0, 10);

    const navCache = {
      "000001": [
        { date: createdDate, nav: 1.0 },
        { date: createdDate, nav: 1.1 } // 10% return >= 5% target
      ]
    };

    const result = he.updateHypothesisReturns(navCache);
    const updated = result.hypotheses[0];
    assert.strictEqual(updated.status, "validated");
    assert.ok(updated.validatedAt, "should have validatedAt");
    assert.ok(updated.outcome, "should have outcome");
    assert.ok(updated.outcome.return >= 5, "return should be >= target");
  } finally {
    restore();
  }
});

test("updateHypothesisReturns marks as INVALIDATED when return <= stopLoss", function () {
  backup();
  try {
    reset();
    delete require.cache[require.resolve("../../lib/hypothesis-engine")];
    const he = require("../../lib/hypothesis-engine");
    const h = he.createHypothesis("000001", "Fund", "趋势跟踪", "test", {
      target: 999,
      stopLoss: -5,
      timeHorizon: 999
    });
    const createdDate = h.createdAt.substring(0, 10);

    const navCache = {
      "000001": [
        { date: createdDate, nav: 1.0 },
        { date: createdDate, nav: 0.9 } // -10% return <= -5% stopLoss
      ]
    };

    const result = he.updateHypothesisReturns(navCache);
    const updated = result.hypotheses[0];
    assert.strictEqual(updated.status, "invalidated");
    assert.ok(updated.invalidatedAt, "should have invalidatedAt");
    assert.ok(updated.outcome, "should have outcome");
    assert.ok(updated.outcome.return <= -5, "return should be <= stopLoss");
  } finally {
    restore();
  }
});

test("updateHypothesisReturns marks as EXPIRED when days > timeHorizon", function () {
  backup();
  try {
    reset();
    delete require.cache[require.resolve("../../lib/hypothesis-engine")];
    const he = require("../../lib/hypothesis-engine");
    const h = he.createHypothesis("000001", "Fund", "趋势跟踪", "test", {
      target: 999,
      stopLoss: -999,
      timeHorizon: 5
    });
    const createdDate = h.createdAt.substring(0, 10);

    const baseDate = new Date(createdDate);
    const dateOffset = days => {
      const d = new Date(baseDate);
      d.setDate(d.getDate() + days);
      return d.toISOString().substring(0, 10);
    };
    // 10 days later, but return within -999..999 (flat 0%)
    const navCache = {
      "000001": [
        { date: dateOffset(0), nav: 1.0 },
        { date: dateOffset(10), nav: 1.0 }
      ]
    };

    const result = he.updateHypothesisReturns(navCache);
    const updated = result.hypotheses[0];
    assert.strictEqual(updated.status, "expired");
    assert.ok(updated.outcome, "should have outcome");
    assert.ok(updated.outcome.holdingDays > 5, "holdingDays should exceed timeHorizon");
  } finally {
    restore();
  }
});

test("getHypothesisStats returns correct win rate", function () {
  backup();
  try {
    reset();
    delete require.cache[require.resolve("../../lib/hypothesis-engine")];
    const he = require("../../lib/hypothesis-engine");

    // Create two hypotheses, validate one, invalidate the other
    he.createHypothesis("000001", "Fund1", "趋势跟踪", "win", { target: 1, stopLoss: -999, timeHorizon: 999 });
    he.createHypothesis("000002", "Fund2", "趋势跟踪", "lose", { target: 999, stopLoss: -1, timeHorizon: 999 });

    const createdDate1 = new Date().toISOString().substring(0, 10);
    const navCache = {
      "000001": [
        { date: createdDate1, nav: 1.0 },
        { date: createdDate1, nav: 1.05 }
      ],
      "000002": [
        { date: createdDate1, nav: 1.0 },
        { date: createdDate1, nav: 0.9 }
      ]
    };

    he.updateHypothesisReturns(navCache);
    const stats = he.getHypothesisStats();
    assert.strictEqual(stats.total, 2);
    assert.strictEqual(stats.validated, 1);
    assert.strictEqual(stats.invalidated, 1);
    assert.strictEqual(stats.winRate, 50);
  } finally {
    restore();
  }
});

test("formatHypothesisReport returns string with stats", function () {
  backup();
  try {
    reset();
    delete require.cache[require.resolve("../../lib/hypothesis-engine")];
    const he = require("../../lib/hypothesis-engine");

    he.createHypothesis("000001", "Test Fund", "均值回归", "Oversold bounce expected", {
      target: 10,
      stopLoss: -5,
      timeHorizon: 30
    });

    const report = he.formatHypothesisReport();
    assert.strictEqual(typeof report, "string");
    assert.ok(report.includes("投资假设追踪报告"), "should contain report title");
    assert.ok(report.includes("Test Fund"), "should contain fund name");
    assert.ok(report.includes("均值回归"), "should contain hypothesis type");
    assert.ok(report.includes("1"), "should contain total count");
  } finally {
    restore();
  }
});
