const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("page build destroys stalled market-data requests instead of hanging", function () {
  const source = fs.readFileSync(path.join(__dirname, "..", "..", "build-pages.js"), "utf8");
  assert.match(source, /\.on\("timeout",\s*\(\)\s*=>\s*req\.destroy\(/);
});
