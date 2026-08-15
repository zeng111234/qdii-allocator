const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..", "..");

test("CLI owns history partitioning while Pages preserves the complete canonical plan", function () {
  const indexSource = fs.readFileSync(path.join(root, "index.js"), "utf-8");
  const pagesSource = fs.readFileSync(path.join(root, "build-pages.js"), "utf-8");

  assert.match(indexSource, /partitionRecommendationHistory\(history(?:Data)?\)/);
  assert.match(indexSource, /history:\s*recommendationHistory\.liveHistory/);
  assert.match(indexSource, /shadowHistory:\s*recommendationHistory\.shadowHistory/);
  assert.doesNotMatch(pagesSource, /partitionRecommendationHistory|buildRecommendationPlan/);
  assert.match(pagesSource, /loadCanonicalRecommendationPlan\(/);
  assert.match(pagesSource, /Object\.assign\(\{\},\s*recommendationPlan,/);
  assert.match(pagesSource, /candidates:\s*recommendationPlan\.candidates\s*\|\|\s*\[\]/);
  assert.match(pagesSource, /executionRoutes:\s*recommendationPlan\.executionRoutes\s*\|\|\s*\[\]/);
});
