/**
 * Transactional NAV cache refresh used by GitHub Actions.
 * Every upstream request must finish successfully before the existing cache is
 * atomically replaced. Any failure leaves the previous cache untouched.
 */
const https = require("https");
const fs = require("fs");
const path = require("path");

const DEFAULT_TIMEOUT_MS = 8 * 60 * 1000;
const DEFAULT_FUNDS_FILE = path.join(__dirname, "..", "data", "funds.json");
const DEFAULT_NAV_CACHE_FILE = path.join(__dirname, "..", "data", "nav-cache.json");

function formatDateInTimeZone(date, timeZone) {
  const values = {};
  new globalThis.Intl.DateTimeFormat("en-US", {
    timeZone: timeZone || "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date || new Date()).forEach(function (part) { values[part.type] = part.value; });
  return values.year + "-" + values.month + "-" + values.day;
}

function invalidResponse(message) {
  const error = new Error("NAV_RESPONSE_INVALID:" + message);
  error.code = "NAV_RESPONSE_INVALID";
  return error;
}

function parseHistoryResponse(raw) {
  const text = String(raw || "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) throw invalidResponse("JSON_OBJECT_MISSING");
  let json;
  try {
    json = JSON.parse(text.slice(start, end + 1));
  } catch (error) {
    throw invalidResponse("JSON_PARSE_FAILED");
  }
  const list = json && json.Data && json.Data.LSJZList;
  if (!Array.isArray(list)) throw invalidResponse("NAV_LIST_MISSING");
  const records = list.map(function (item, index) {
    const date = item && item.FSRQ;
    const nav = Number(item && item.DWJZ);
    const accNavRaw = item && item.LJJZ;
    const accNav = accNavRaw === "" || accNavRaw === null || accNavRaw === undefined ? null : Number(accNavRaw);
    const changeRaw = item && item.JZZZL;
    const changeRate = changeRaw === "" || changeRaw === null || changeRaw === undefined ? 0 : Number(changeRaw);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || "")) || !Number.isFinite(nav) || nav <= 0 ||
        (accNav !== null && !Number.isFinite(accNav)) || !Number.isFinite(changeRate)) {
      throw invalidResponse("NAV_ROW_INVALID:" + index);
    }
    return { date: date, nav: nav, accNav: accNav, changeRate: changeRate };
  });
  const rawTotal = json.TotalCount;
  const totalCount = rawTotal === undefined || rawTotal === null || rawTotal === "" ? list.length : Number(rawTotal);
  if (!Number.isFinite(totalCount) || totalCount < 0) throw invalidResponse("TOTAL_COUNT_INVALID");
  return { records: records, totalCount: totalCount };
}

function needsResearchBackfill(records, code, config) {
  const settings = config || {};
  const researchCodes = Array.isArray(settings.alphaResearchCodes) ? settings.alphaResearchCodes.map(String) : [];
  const startDate = String(settings.alphaResearchStartDate || "");
  if (!researchCodes.includes(String(code)) || !startDate) return false;
  const dates = (records || []).map(function (record) { return record && record.date; }).filter(Boolean).sort();
  return dates.length === 0 || dates[0] > startDate;
}

function fetchPage(code, startDate, pageSize, pageIndex, options) {
  const settings = options || {};
  const request = settings.https || https;
  const endDate = settings.endDate || formatDateInTimeZone(new Date(), "Asia/Shanghai");
  const url = "https://api.fund.eastmoney.com/f10/lsjz?callback=jQuery" +
    "&fundCode=" + encodeURIComponent(code) + "&pageIndex=" + encodeURIComponent(pageIndex) +
    "&pageSize=" + encodeURIComponent(pageSize) + "&startDate=" + encodeURIComponent(startDate) +
    "&endDate=" + encodeURIComponent(endDate) + "&_=" + Date.now();
  return new Promise(function (resolve, reject) {
    let settled = false;
    function finish(error, value) {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(value);
    }
    const req = request.get(url, {
      headers: { Referer: "https://fundf10.eastmoney.com/" },
      timeout: Number(settings.requestTimeoutMs) || 10000
    }, function (res) {
      let data = "";
      if (!res || res.statusCode < 200 || res.statusCode >= 300) {
        if (res && typeof res.resume === "function") res.resume();
        finish(new Error("NAV_HTTP_STATUS:" + (res && res.statusCode)));
        return;
      }
      res.on("data", function (chunk) { data += chunk; });
      res.on("end", function () {
        try { finish(null, parseHistoryResponse(data).records); }
        catch (error) { finish(error); }
      });
      res.on("error", function (error) { finish(error); });
    });
    req.on("timeout", function () { req.destroy(new Error("NAV_REQUEST_TIMEOUT:" + code)); });
    req.on("error", function (error) { finish(error); });
  });
}

function readJsonFile(file, fsImpl) {
  const io = fsImpl || fs;
  try { return JSON.parse(io.readFileSync(file, "utf8")); }
  catch (error) { throw new Error("NAV_LOCAL_JSON_INVALID:" + path.basename(file) + ":" + error.message); }
}

function atomicWriteJson(file, value, fsImpl) {
  const io = fsImpl || fs;
  const tempFile = file + ".tmp-" + process.pid + "-" + Date.now();
  try {
    io.writeFileSync(tempFile, JSON.stringify(value, null, 2), "utf8");
    io.renameSync(tempFile, file);
  } catch (error) {
    try { if (io.existsSync(tempFile)) io.unlinkSync(tempFile); } catch (_) {}
    throw error;
  }
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

async function main(options) {
  const settings = options || {};
  const io = settings.fs || fs;
  const fundsFile = settings.fundsFile || DEFAULT_FUNDS_FILE;
  const navCacheFile = settings.navCacheFile || DEFAULT_NAV_CACHE_FILE;
  const timeoutMs = Number(settings.timeoutMs) >= 0 ? Number(settings.timeoutMs) : DEFAULT_TIMEOUT_MS;
  const now = settings.now || Date.now;
  const sleep = settings.sleep || function (ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); };
  const requestPage = settings.fetchPage || function (code, startDate, pageSize, pageIndex) {
    return fetchPage(code, startDate, pageSize, pageIndex, settings);
  };
  const startTime = now();
  function assertWithinDeadline() {
    if (now() - startTime > timeoutMs) throw new Error("NAV_UPDATE_TIMEOUT");
  }

  const fundsData = readJsonFile(fundsFile, io);
  if (!fundsData || !Array.isArray(fundsData.funds)) throw new Error("NAV_FUNDS_INVALID");
  const fundCodes = fundsData.funds.map(function (fund) { return String(fund && fund.code || ""); });
  if (fundCodes.some(function (code) { return !code; }) || new Set(fundCodes).size !== fundCodes.length) {
    throw new Error("NAV_FUND_CODES_INVALID");
  }
  const oldNav = io.existsSync(navCacheFile) ? readJsonFile(navCacheFile, io) : {};
  if (!oldNav || typeof oldNav !== "object" || Array.isArray(oldNav)) throw new Error("NAV_CACHE_INVALID");
  const workingNav = cloneJson(oldNav);
  let updated = 0;
  console.log("Start: " + fundCodes.length + " funds, timeout=" + (timeoutMs / 1000) + "s");

  async function fetchFundHistory(code, targetCount, requestedStartDate) {
    const startDate = requestedStartDate || formatDateInTimeZone(new Date(Date.now() - 730 * 86400000), "Asia/Shanghai");
    const pageSize = 20;
    const maxPages = Math.ceil(targetCount / pageSize) + 2;
    const existing = Array.isArray(workingNav[code]) ? workingNav[code] : [];
    const existingDates = new Set(existing.map(function (record) { return record.date; }));
    const newRecords = [];
    for (let pageIndex = 1; pageIndex <= maxPages; pageIndex++) {
      assertWithinDeadline();
      const records = await requestPage(code, startDate, pageSize, pageIndex);
      assertWithinDeadline();
      if (!Array.isArray(records)) throw new Error("NAV_FETCH_RESULT_INVALID:" + code);
      if (records.length === 0) break;
      records.forEach(function (record) {
        if (!existingDates.has(record.date)) {
          newRecords.push(record);
          existingDates.add(record.date);
        }
      });
      if (records.length < pageSize) break;
      await sleep(300);
      assertWithinDeadline();
    }
    if (newRecords.length > 0) {
      workingNav[code] = existing.concat(newRecords).sort(function (left, right) {
        return String(left.date).localeCompare(String(right.date));
      });
      updated += newRecords.length;
    } else if (!Array.isArray(workingNav[code])) {
      workingNav[code] = [];
    }
    return workingNav[code].length;
  }

  for (let index = 0; index < fundCodes.length; index++) {
    assertWithinDeadline();
    const code = fundCodes[index];
    const existing = Array.isArray(workingNav[code]) ? workingNav[code] : [];
    const researchBackfill = needsResearchBackfill(existing, code, fundsData.config);
    if (existing.length < 60 || researchBackfill) {
      console.log("[" + (index + 1) + "/" + fundCodes.length + "] " + code + ": fetching history (" + existing.length + " existing)...");
      const count = await fetchFundHistory(code, researchBackfill ? 5000 : 60,
        researchBackfill ? fundsData.config.alphaResearchStartDate : null);
      console.log("  " + code + ": " + count + " records");
    } else {
      const startDate = formatDateInTimeZone(new Date(Date.now() - 7 * 86400000), "Asia/Shanghai");
      const records = await requestPage(code, startDate, 20, 1);
      assertWithinDeadline();
      if (!Array.isArray(records)) throw new Error("NAV_FETCH_RESULT_INVALID:" + code);
      const existingDates = new Set(existing.map(function (record) { return record.date; }));
      records.forEach(function (record) {
        if (!existingDates.has(record.date)) {
          existing.push(record);
          existingDates.add(record.date);
          updated++;
        }
      });
      existing.sort(function (left, right) { return String(left.date).localeCompare(String(right.date)); });
      workingNav[code] = existing;
    }
  }

  assertWithinDeadline();
  atomicWriteJson(navCacheFile, workingNav, io);
  const summary = { updated: updated, errors: 0, funds: fundCodes.length };
  console.log("NAV updated: " + updated + " new, 0 errors, " + fundCodes.length + " funds");
  return summary;
}

if (require.main === module) {
  main().catch(function (error) {
    console.error("NAV update failed; old cache preserved:", error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  formatDateInTimeZone: formatDateInTimeZone,
  parseHistoryResponse: parseHistoryResponse,
  needsResearchBackfill: needsResearchBackfill,
  fetchPage: fetchPage,
  atomicWriteJson: atomicWriteJson,
  main: main
};
