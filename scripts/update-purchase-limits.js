/**
 * 每日更新限购数据脚本 - GitHub Actions 使用
 */
const fs = require("fs");
const path = require("path");
const fd = require("../lib/fund-data");
const funds = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "funds.json"), "utf8"));
const codes = funds.funds.map(function (f) {
  return f.code;
});
let done = 0,
  updated = 0;

function next() {
  if (done >= codes.length) {
    funds._lastUpdated = new Date().toISOString().slice(0, 10);
    fs.writeFileSync(path.join(__dirname, "..", "data", "funds.json"), JSON.stringify(funds, null, 2));
    console.log("Purchase limits updated: " + updated + " changes, " + codes.length + " funds");
    return;
  }
  const code = codes[done];
  fd.getFundPurchaseInfo(code)
    .then(function (info) {
      const fund = funds.funds.find(function (f) {
        return f.code === code;
      });
      if (fund && info) {
        if (fd.hasMaterialFundIdentityMismatch(fund, info)) {
          console.error(code + ": catalog identity mismatch: " + fund.name + " != " + (info.name || "unknown"));
          fund.status = "metadata_mismatch";
          fund.metadataVerified = false;
          fund.officialName = info.name || null;
          fund.metadataMismatchDetectedAt = new Date().toISOString();
          updated++;
          done++;
          next();
          return;
        }
        if (info.limit !== undefined && info.limit !== fund.dailyLimit) {
          console.log(code + ": " + fund.dailyLimit + " -> " + info.limit);
          fund.dailyLimit = info.limit;
          updated++;
        }
        if (info.status === "suspended" && fund.status !== "suspended") {
          fund.status = "suspended";
          updated++;
        } else if (info.status === "limited" && fund.status === "suspended") {
          fund.status = "active";
          updated++;
        }
      }
      done++;
      next();
    })
    .catch(function () {
      done++;
      next();
    });
}
next();
