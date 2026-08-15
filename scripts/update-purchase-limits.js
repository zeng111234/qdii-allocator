/**
 * 每日更新限购数据脚本 - GitHub Actions 使用。
 * fund-data 的网络层已限制为首次失败后最多重试一次；这里不再叠加重试。
 * 任一基金缺少新鲜、可判定的结果时整批失败且不写 funds.json。
 */
const fs = require("fs");
const path = require("path");
const fd = require("../lib/fund-data");
const { formatDateInTimeZone } = require("./update-nav-cache");

const FUNDS_FILE = path.join(__dirname, "..", "data", "funds.json");
const MAX_INFO_AGE_MS = 4 * 60 * 60 * 1000;

function isFreshAvailability(info, now) {
  const fetchedAt = Number(info && info._cachedAt);
  return Number.isFinite(fetchedAt) && fetchedAt > 0 && now - fetchedAt <= MAX_INFO_AGE_MS &&
    ["active", "limited", "suspended"].includes(String(info.status));
}

function applyAvailability(fund, info, nowIso) {
  let updated = 0;
  if (fd.hasMaterialFundIdentityMismatch(fund, info)) {
    console.error(fund.code + ": catalog identity mismatch: " + fund.name + " != " + (info.name || "unknown"));
    fund.status = "metadata_mismatch";
    fund.metadataVerified = false;
    fund.officialName = info.name || null;
    fund.metadataMismatchDetectedAt = nowIso;
    return 1;
  }
  if (Number(info.limit) !== Number(fund.dailyLimit)) {
    console.log(fund.code + ": " + fund.dailyLimit + " -> " + info.limit);
    fund.dailyLimit = Number(info.limit);
    updated++;
  }
  const catalogRestricted = ["tracking_only", "metadata_mismatch"].includes(fund.status);
  if (!catalogRestricted) {
    const nextStatus = info.status === "suspended" ? "suspended" : "active";
    if (fund.status !== nextStatus) {
      fund.status = nextStatus;
      updated++;
    }
  }
  if (fund.metadataVerified === true) delete fund.metadataVerified;
  return updated;
}

async function updatePurchaseLimits(options) {
  const settings = options || {};
  const now = Number.isFinite(Number(settings.now)) ? Number(settings.now) : Date.now();
  const nowIso = new Date(now).toISOString();
  const fetchInfo = settings.fetchInfo || fd.getFundPurchaseInfo;
  const fundsFile = settings.fundsFile || FUNDS_FILE;
  const funds = JSON.parse(fs.readFileSync(fundsFile, "utf8"));
  let succeeded = 0;
  let updated = 0;

  for (const fund of funds.funds || []) {
    let info = null;
    try {
      info = await fetchInfo(fund.code);
    } catch (error) {
      throw new Error("PURCHASE_AVAILABILITY_INCOMPLETE: succeeded=" + succeeded +
        ", failed=1, total=" + (funds.funds || []).length + ", code=" + fund.code +
        ", reason=" + (error.message || "FETCH_FAILED"));
    }
    if (!isFreshAvailability(info, now)) {
      throw new Error("PURCHASE_AVAILABILITY_INCOMPLETE: succeeded=" + succeeded +
        ", failed=1, total=" + (funds.funds || []).length + ", code=" + fund.code +
        ", reason=STALE_OR_UNKNOWN");
    }
    updated += applyAvailability(fund, info, nowIso);
    succeeded++;
  }

  funds._lastUpdated = formatDateInTimeZone(new Date(now), "Asia/Shanghai");
  funds._purchaseAvailabilityUpdatedAt = nowIso;
  fs.writeFileSync(fundsFile, JSON.stringify(funds, null, 2));
  console.log("Purchase limits updated: succeeded=" + succeeded + ", failed=0, changes=" + updated + ", funds=" + (funds.funds || []).length +
    ", asOf=" + funds._lastUpdated);
  return { updated: updated, total: (funds.funds || []).length, asOf: funds._lastUpdated };
}

if (require.main === module) {
  updatePurchaseLimits().catch(function (error) {
    console.error("Purchase limits update failed:", error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  MAX_INFO_AGE_MS: MAX_INFO_AGE_MS,
  isFreshAvailability: isFreshAvailability,
  applyAvailability: applyAvailability,
  updatePurchaseLimits: updatePurchaseLimits
};
