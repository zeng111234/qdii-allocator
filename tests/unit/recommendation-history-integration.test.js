const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..", "..");

test("CLI and Pages pass disjoint live and shadow history and expose pause reasons", function () {
  const indexSource = fs.readFileSync(path.join(root, "index.js"), "utf-8");
  const pagesSource = fs.readFileSync(path.join(root, "build-pages.js"), "utf-8");

  [indexSource, pagesSource].forEach(function (source) {
    assert.match(source, /partitionRecommendationHistory\(history(?:Data)?\)/);
    assert.match(source, /history:\s*recommendationHistory\.liveHistory/);
    assert.match(source, /shadowHistory:\s*recommendationHistory\.shadowHistory/);
  });
  assert.match(pagesSource, /pauseReasons:\s*recommendationPlan\.pauseReasons/);
});
