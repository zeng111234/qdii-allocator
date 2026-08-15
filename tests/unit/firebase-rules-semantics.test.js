const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const rules = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "firebase.database.rules.json"), "utf8"));
const userRules = rules.rules.users.$uid;

test("database rules reject malformed transaction fields before they reach the ledger", function () {
  const transactionRule = userRules.portfolioLedger.transactions.$transaction[".validate"];
  assert.match(transactionRule, /hasChildren\(\['id', 'type', 'code', 'tradeDate', 'amount', 'nav', 'shares'\]\)/);
  assert.match(transactionRule, /type.*BUY.*SELL/);
  assert.match(transactionRule, /amount.*isNumber/);
  assert.match(transactionRule, /amount.*>= 0/);
  assert.match(transactionRule, /nav.*isNumber/);
  assert.match(transactionRule, /shares.*isNumber/);
  assert.match(transactionRule, /type.*BUY.*amount.*> 0.*nav.*> 0.*shares.*> 0/);
});

test("database rules require the complete risk anchor used by both clients", function () {
  const stateRule = userRules.decisionState[".validate"];
  assert.match(stateRule, /riskAnchorAt/);
  assert.match(stateRule, /riskAnchorLedgerRevision.*isNumber/);
  assert.match(stateRule, /cashBalance.*>= 0/);
  assert.match(stateRule, /updatedAt.*isString/);
});
