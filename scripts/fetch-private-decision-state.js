const fs = require("fs");
const path = require("path");

const firebase = require("../lib/firebase-client");
const ledgerTools = require("../lib/portfolio-ledger");
const decisionStateTools = require("../lib/decision-state");

function writePrivateJson(filePath, value) {
  const resolved = path.resolve(filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, JSON.stringify(value), { encoding: "utf8", mode: 0o600 });
}

function clearPrivateOutputs(ledgerOutput, decisionOutput) {
  [ledgerOutput, decisionOutput].forEach(function (filePath) {
    if (!filePath) return;
    const resolved = path.resolve(filePath);
    if (fs.existsSync(resolved)) fs.unlinkSync(resolved);
  });
}

async function main() {
  const ledgerOutput = process.env.PRIVATE_LEDGER_PATH;
  const decisionOutput = process.env.PRIVATE_DECISION_STATE_PATH;
  if (!ledgerOutput) throw new Error("PRIVATE_LEDGER_PATH_REQUIRED");
  if (!decisionOutput) throw new Error("PRIVATE_DECISION_STATE_PATH_REQUIRED");
  clearPrivateOutputs(ledgerOutput, decisionOutput);

  const snapshot = await firebase.loadPrivateRecommendationStateFromFirebase();
  if (!snapshot) throw new Error("PRIVATE_RECOMMENDATION_STATE_MISSING");
  const ledgerValidation = ledgerTools.validateLedger(snapshot.portfolioLedger);
  if (!ledgerValidation.valid) throw new Error("INVALID_PRIVATE_LEDGER:" + ledgerValidation.errors.join(","));
  const decisionState = decisionStateTools.normalizeDecisionState(snapshot.decisionState);

  writePrivateJson(ledgerOutput, snapshot.portfolioLedger);
  writePrivateJson(decisionOutput, decisionState);
  console.log("Private recommendation state loaded: ledgerRevision=" + snapshot.portfolioLedger.revision +
    ", decisionRevision=" + decisionState.revision);
}

main().catch(function (error) {
  clearPrivateOutputs(process.env.PRIVATE_LEDGER_PATH, process.env.PRIVATE_DECISION_STATE_PATH);
  console.error("Private recommendation state sync failed:", error.message);
  process.exitCode = 1;
});
