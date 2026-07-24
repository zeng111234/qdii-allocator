const { initializeApp, getApps } = require("firebase-admin/app");
const { getDatabase } = require("firebase-admin/database");
const { logger } = require("firebase-functions");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const runner = require("./strategy-runner");

if (getApps().length === 0) initializeApp();

/**
 * Writes only user-scoped strategy observations and plans. It never changes
 * portfolioLedger transactions or decisionState, so scheduled work cannot buy,
 * sell, migrate, or alter the user's risk anchor.
 */
exports.refreshShadowStrategy = onSchedule({
  schedule: "15 18 * * 1-5",
  timeZone: "Asia/Shanghai",
  region: "asia-east1",
  maxInstances: 1,
  retryCount: 1
}, async function() {
  const result = await runner.refreshAllStrategyStates(getDatabase(), fetch);
  logger.info("strategy state refreshed", {
    processed: result.processed,
    skipped: result.skipped,
    asOf: result.asOf
  });
});
