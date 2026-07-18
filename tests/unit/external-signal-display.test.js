const test = require("node:test");
const assert = require("node:assert/strict");

const { normalizeExternalSignalsForPage } = require("../../lib/external-signal-display");

test("stale external signals remain visible but are marked stale", function () {
  const result = normalizeExternalSignalsForPage(
    {
      data: {
        status: "ok",
        fetchedAt: "2026-07-17T09:00:00.000Z",
        items: [{ title: "old but useful context" }],
        tickerOpinions: [{ ticker: "NVDA", sentiment: "bullish" }],
        themeScores: { globalTech: { score: 0.5 } }
      }
    },
    "2026-07-18T02:00:00.000Z"
  );

  assert.equal(result.status, "stale");
  assert.equal(result.items.length, 1);
  assert.equal(result.tickerOpinions.length, 1);
  assert.equal(result.cachedAt, "2026-07-17T09:00:00.000Z");
});

test("current external signals retain their source status and cap displayed posts", function () {
  const result = normalizeExternalSignalsForPage(
    {
      status: "cached",
      cachedAt: "2026-07-18T01:00:00.000Z",
      items: Array.from({ length: 12 }, function (_, index) { return { title: String(index) }; }),
      tickerOpinions: []
    },
    "2026-07-18T02:00:00.000Z"
  );

  assert.equal(result.status, "cached");
  assert.equal(result.items.length, 10);
});
