const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const updater = require("../../scripts/update-nav-cache");

test("NAV updater preserves cumulative NAV used by total-return research", function () {
  const parsed = updater.parseHistoryResponse('jQuery({"Data":{"LSJZList":[{"FSRQ":"2026-08-11","DWJZ":"2.0950","LJJZ":"2.2580","JZZZL":"0.10"}]},"TotalCount":3711})');
  assert.deepEqual(parsed.records, [
    { date: "2026-08-11", nav: 2.095, accNav: 2.258, changeRate: 0.1 }
  ]);
  assert.equal(parsed.totalCount, 3711);
});

test("research assets request a full backfill when their cache starts after the research period", function () {
  assert.equal(updater.needsResearchBackfill(
    [{ date: "2023-05-17", nav: 1 }],
    "320013",
    { alphaResearchCodes: ["320013"], alphaResearchStartDate: "2017-01-01" }
  ), true);
  assert.equal(updater.needsResearchBackfill(
    [{ date: "2011-01-13", nav: 1 }],
    "320013",
    { alphaResearchCodes: ["320013"], alphaResearchStartDate: "2017-01-01" }
  ), false);
});

test("malformed upstream payload is a hard parse failure", function () {
  assert.throws(function () {
    updater.parseHistoryResponse("upstream gateway error");
  }, /NAV_RESPONSE_INVALID/);
  assert.throws(function () {
    updater.parseHistoryResponse('jQuery({"Data":{}})');
  }, /NAV_RESPONSE_INVALID/);
});

test("an upstream failure preserves the complete old cache instead of writing partial updates", async function () {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "qdii-nav-atomic-"));
  const fundsFile = path.join(tempDir, "funds.json");
  const cacheFile = path.join(tempDir, "nav-cache.json");
  const oldCache = {
    A: [{ date: "2026-08-13", nav: 1, accNav: 1, changeRate: 0 }],
    B: [{ date: "2026-08-13", nav: 2, accNav: 2, changeRate: 0 }]
  };
  fs.writeFileSync(fundsFile, JSON.stringify({ funds: [{ code: "A" }, { code: "B" }], config: {} }));
  fs.writeFileSync(cacheFile, JSON.stringify(oldCache, null, 2));
  try {
    await assert.rejects(updater.main({
      fundsFile: fundsFile,
      navCacheFile: cacheFile,
      timeoutMs: 60_000,
      sleep: async function () {},
      fetchPage: async function (code) {
        if (code === "B") throw new Error("UPSTREAM_DOWN");
        return [{ date: "2026-08-14", nav: 1.1, accNav: 1.1, changeRate: 0 }];
      }
    }), /UPSTREAM_DOWN/);
    assert.deepEqual(JSON.parse(fs.readFileSync(cacheFile, "utf8")), oldCache);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("a global timeout preserves the old cache and rejects", async function () {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "qdii-nav-timeout-"));
  const fundsFile = path.join(tempDir, "funds.json");
  const cacheFile = path.join(tempDir, "nav-cache.json");
  const oldText = JSON.stringify({ A: [] }, null, 2);
  fs.writeFileSync(fundsFile, JSON.stringify({ funds: [{ code: "A" }], config: {} }));
  fs.writeFileSync(cacheFile, oldText);
  let tick = 0;
  try {
    await assert.rejects(updater.main({
      fundsFile: fundsFile,
      navCacheFile: cacheFile,
      timeoutMs: 10,
      now: function () { tick += 20; return tick; },
      sleep: async function () {},
      fetchPage: async function () { return []; }
    }), /NAV_UPDATE_TIMEOUT/);
    assert.equal(fs.readFileSync(cacheFile, "utf8"), oldText);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("successful refresh replaces the cache only after every fund finishes", async function () {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "qdii-nav-success-"));
  const fundsFile = path.join(tempDir, "funds.json");
  const cacheFile = path.join(tempDir, "nav-cache.json");
  fs.writeFileSync(fundsFile, JSON.stringify({ funds: [{ code: "A" }, { code: "B" }], config: {} }));
  fs.writeFileSync(cacheFile, "{}");
  try {
    const summary = await updater.main({
      fundsFile: fundsFile,
      navCacheFile: cacheFile,
      timeoutMs: 60_000,
      sleep: async function () {},
      fetchPage: async function (code, startDate, pageSize, pageIndex) {
        return pageIndex === 1
          ? [{ date: "2026-08-14", nav: code === "A" ? 1.1 : 2.1, accNav: 1, changeRate: 0 }]
          : [];
      }
    });
    const written = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    assert.deepEqual(Object.keys(written).sort(), ["A", "B"]);
    assert.equal(summary.errors, 0);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
