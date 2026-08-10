const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

test("dry-run never authorizes paid providers", function () {
  const runPolicy = require("../../lib/run-policy");
  assert.strictEqual(runPolicy.allowPaidProviders({ dryRun: true }), false);
  assert.strictEqual(runPolicy.allowPaidProviders({ dryRun: false }), true);
});

test("CLI applies the paid-provider policy to LLM work", function () {
  const source = fs.readFileSync(path.join(__dirname, "..", "..", "index.js"), "utf8");
  assert.match(source, /runPolicy\.allowPaidProviders\(opts\)/);
  assert.match(source, /paidProvidersEnabled && llmApiKey/);
});
