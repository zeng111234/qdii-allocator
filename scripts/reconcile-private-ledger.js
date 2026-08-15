"use strict";

const fs = require("node:fs");
const path = require("node:path");

const firebase = require("../lib/firebase-client");
const ledgerTools = require("../lib/portfolio-ledger");

function writePrivateSnapshot(ledger) {
  const output = String(process.env.PRIVATE_LEDGER_PATH || "").trim();
  if (!output) return;
  const target = path.resolve(output);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(ledger), { encoding: "utf8", mode: 0o600 });
}

async function main() {
  const navPath = path.join(__dirname, "..", "data", "nav-cache.json");
  const navCache = JSON.parse(fs.readFileSync(navPath, "utf8"));
  const snapshot = await firebase.loadPortfolioLedgerWithEtag();
  if (!snapshot || !snapshot.data || !snapshot.etag) throw new Error("PRIVATE_LEDGER_ETAG_UNAVAILABLE");
  const validation = ledgerTools.validateLedger(snapshot.data);
  if (!validation.valid) throw new Error("INVALID_PRIVATE_LEDGER:" + validation.errors.join(","));
  const result = ledgerTools.reconcilePendingTransactions(snapshot.data, navCache);
  if (result.reconciled.length === 0) {
    writePrivateSnapshot(snapshot.data);
    console.log("Pending ledger reconciliation: count=0, revision=" + snapshot.data.revision);
    return;
  }
  console.log("Pending ledger reconciliation prepared: count=" + result.reconciled.length +
    ", revision=" + result.ledger.revision);
  if (process.env.RECONCILE_WRITE !== "1") {
    console.log("Pending ledger reconciliation dry run: count=" + result.reconciled.length +
      ", revision=" + result.ledger.revision);
    return;
  }
  const write = await firebase.savePortfolioLedgerIfMatch(result.ledger, snapshot.etag);
  if (!write.ok) throw new Error(write.conflict ? "LEDGER_ETAG_CONFLICT" : "LEDGER_WRITE_FAILED:" + write.statusCode);
  const verified = await firebase.loadPortfolioLedgerFromFirebase();
  if (!verified || verified.checksum !== result.ledger.checksum ||
      Number(verified.revision) !== Number(result.ledger.revision)) {
    throw new Error("LEDGER_READBACK_MISMATCH");
  }
  writePrivateSnapshot(verified);
  console.log("Pending ledger reconciliation committed: count=" + result.reconciled.length +
    ", revision=" + verified.revision);
}

main().catch(function (error) {
  console.error("Pending ledger reconciliation failed:", error.message);
  process.exitCode = 1;
});
