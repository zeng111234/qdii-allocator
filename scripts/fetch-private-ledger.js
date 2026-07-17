const fs = require("fs");
const path = require("path");

const firebase = require("../lib/firebase-client");
const ledgerTools = require("../lib/portfolio-ledger");

async function main() {
  const output = process.env.PRIVATE_LEDGER_PATH;
  if (!output) throw new Error("PRIVATE_LEDGER_PATH_REQUIRED");
  const ledger = await firebase.loadPortfolioLedgerFromFirebase();
  const validation = ledgerTools.validateLedger(ledger);
  if (!validation.valid) throw new Error("INVALID_PRIVATE_LEDGER:" + validation.errors.join(","));
  fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
  fs.writeFileSync(path.resolve(output), JSON.stringify(ledger), { encoding: "utf8", mode: 0o600 });
  const derived = ledgerTools.derivePortfolio(ledger);
  console.log("Private ledger loaded: revision=" + ledger.revision +
    ", funds=" + derived.holdings.length + ", transactions=" + ledger.transactions.length);
}

main().catch(function (error) {
  console.error("Private ledger sync failed:", error.message);
  process.exitCode = 1;
});
