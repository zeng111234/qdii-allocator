/**
 * 共享工具模块
 * 抽取各文件中重复的工具函数
 */

const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");

const NAV_CACHE_FILE = path.join(__dirname, "..", "data", "nav-cache.json");

// ========== 日期工具 ==========

/**
 * N 天后的日期
 * @param {string} dateStr - YYYY-MM-DD
 * @param {number} days
 * @returns {string} YYYY-MM-DD
 */
function addDaysToDate(dateStr, days) {
  const d = new Date(dateStr + "T00:00:00");
  d.setDate(d.getDate() + days);
  return formatLocalDate(d);
}

/**
 * 两个日期之间的天数差
 * @param {string} d1 - YYYY-MM-DD
 * @param {string} d2 - YYYY-MM-DD
 * @returns {number}
 */
function daysBetween(d1, d2) {
  const dt1 = new Date(d1 + "T00:00:00");
  const dt2 = new Date(d2 + "T00:00:00");
  return Math.round((dt2 - dt1) / 86400000);
}

/**
 * 格式化日期为 YYYY-MM-DD（本地时区）
 * @param {Date|number|string} date
 * @returns {string}
 */
function formatLocalDate(date) {
  const d = new Date(date);
  const year = d.getFullYear();
  const month = ("0" + (d.getMonth() + 1)).slice(-2);
  const day = ("0" + d.getDate()).slice(-2);
  return year + "-" + month + "-" + day;
}

/**
 * 标准化日期字符串：统一为 YYYY-MM-DD
 * 支持 "2026/6/3"、"2026-06-03" 等格式
 * @param {string} dateStr
 * @returns {string}
 */
function normalizeDate(dateStr) {
  if (!dateStr) return "";
  const parts = dateStr.replace(/\//g, "-").split("-");
  if (parts.length === 3) {
    return parts[0] + "-" + ("0" + parts[1]).slice(-2) + "-" + ("0" + parts[2]).slice(-2);
  }
  return dateStr.replace(/\//g, "-");
}

// ========== 数值工具 ==========

/**
 * 四舍五入到 1 位小数
 */
function round1(n) {
  return Math.round(n * 10) / 10;
}

/**
 * 四舍五入到 2 位小数
 */
function round2(n) {
  return Math.round(n * 100) / 100;
}

// ========== 缓存工具 ==========

/**
 * 加载净值缓存
 * @returns {Object} { fundCode: [{ date, nav, accNav, changeRate }] }
 */
function loadNavCache() {
  try {
    if (fs.existsSync(NAV_CACHE_FILE)) {
      return JSON.parse(fs.readFileSync(NAV_CACHE_FILE, "utf-8"));
    }
  } catch (e) {}
  return {};
}

/**
 * 保存净值缓存
 * 自动裁剪每只基金超过 MAX_NAV_RECORDS 条的旧记录
 */
const MAX_NAV_RECORDS = 5000; // 约20年交易日，SQLite模式下存全部历史

function saveNavCache(cache) {
  try {
    // 裁剪过长的记录，保留最近数据
    let trimmed = 0;
    for (const code in cache) {
      if (cache[code] && cache[code].length > MAX_NAV_RECORDS) {
        cache[code] = cache[code].slice(-MAX_NAV_RECORDS);
        trimmed++;
      }
    }
    if (trimmed > 0) {
      console.log("[cache] 裁剪了 " + trimmed + " 只基金的旧净值记录（保留最近" + MAX_NAV_RECORDS + "条）");
    }
    fs.writeFileSync(NAV_CACHE_FILE, JSON.stringify(cache), "utf-8");
  } catch (e) {
    console.error("[cache] save error:", e.message);
  }
}

// ========== HTTP 工具 ==========

/**
 * 统一 HTTP GET 请求
 * @param {string} url
 * @param {number} timeoutMs
 * @returns {Promise<string>}
 */
function httpGet(url, timeoutMs) {
  if (!timeoutMs) timeoutMs = 15000;
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const lib = parsedUrl.protocol === "https:" ? https : http;
    const req = lib.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0",
        "Referer": "https://fund.eastmoney.com/"
      },
      timeout: timeoutMs
    }, res => {
      let data = "";
      res.on("data", chunk => (data += chunk));
      res.on("end", () => resolve(data));
    });
    req.on("error", reject);
    req.on("timeout", function () {
      req.destroy();
      reject(new Error("HTTP timeout (" + timeoutMs + "ms)"));
    });
  });
}

/**
 * 带重试的 HTTP GET
 * @param {string} url
 * @param {Object} opts - { timeoutMs, maxRetries, retryDelays }
 * @returns {Promise<string>}
 */
async function httpGetWithRetry(url, opts) {
  const timeoutMs = (opts && opts.timeoutMs) || 15000;
  const maxRetries = (opts && opts.maxRetries) || 3;
  const retryDelays = (opts && opts.retryDelays) || [1000, 2000, 4000];

  let lastErr = null;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await httpGet(url, timeoutMs);
    } catch (err) {
      lastErr = err;
      if (attempt < maxRetries - 1) {
        await new Promise(r => setTimeout(r, retryDelays[attempt] || 2000));
      }
    }
  }
  throw lastErr;
}

/**
 * 并发批量获取（带并发控制）
 * @param {Array} items - 要处理的项目数组
 * @param {Function} fetchFn - async (item) => result
 * @param {Object} opts - { concurrency, delayMs }
 * @returns {Promise<Array>} 结果数组（与 items 同序）
 */
async function batchFetch(items, fetchFn, opts) {
  const pLimit = require("p-limit");
  const concurrency = (opts && opts.concurrency) || 5;
  const delayMs = (opts && opts.delayMs) || 0;
  const limit = pLimit(concurrency);

  const tasks = items.map((item, index) => limit(async () => {
    if (delayMs > 0 && index > 0) {
      await new Promise(r => setTimeout(r, delayMs));
    }
    try {
      return await fetchFn(item);
    } catch (err) {
      return { error: err.message, item: item };
    }
  }));

  return Promise.all(tasks);
}

// ========== 历史归档 ==========

const HISTORY_FILE = path.join(__dirname, "..", "data", "history.json");
const ARCHIVE_DIR = path.join(__dirname, "..", "data", "history-archive");

/**
 * 归档旧的历史推荐记录
 * 保留最近 keepDays 天的记录，更早的移到归档文件
 * @param {number} keepDays - 保留天数（默认 180）
 * @returns {Object} { archived: number, kept: number }
 */
function archiveOldHistory(keepDays) {
  if (!keepDays) keepDays = 180;
  try {
    if (!fs.existsSync(HISTORY_FILE)) return { archived: 0, kept: 0 };

    const data = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf-8"));
    if (!data.records || data.records.length === 0) return { archived: 0, kept: 0 };

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - keepDays);
    const cutoffStr = formatLocalDate(cutoff);

    const toKeep = [];
    const toArchive = [];

    for (const rec of data.records) {
      if (rec.date >= cutoffStr) {
        toKeep.push(rec);
      } else {
        toArchive.push(rec);
      }
    }

    if (toArchive.length === 0) return { archived: 0, kept: toKeep.length };

    // 保存归档
    if (!fs.existsSync(ARCHIVE_DIR)) {
      fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
    }
    const archiveFile = path.join(ARCHIVE_DIR, "history-" + cutoffStr.substring(0, 7) + ".json");
    let existing = [];
    if (fs.existsSync(archiveFile)) {
      try {
        existing = JSON.parse(fs.readFileSync(archiveFile, "utf-8")).records || [];
      } catch(e) {}
    }
    const merged = existing.concat(toArchive).sort((a, b) => a.date < b.date ? -1 : 1);
    fs.writeFileSync(archiveFile, JSON.stringify({ records: merged, archivedAt: new Date().toISOString() }, null, 2), "utf-8");

    // 更新主文件
    data.records = toKeep;
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(data, null, 2), "utf-8");

    console.log("[history] 归档 " + toArchive.length + " 条记录到 " + path.basename(archiveFile) + "，保留 " + toKeep.length + " 条");
    return { archived: toArchive.length, kept: toKeep.length };
  } catch(e) {
    console.warn("[history] 归档失败:", e.message);
    return { archived: 0, kept: 0 };
  }
}

module.exports = {
  addDaysToDate,
  daysBetween,
  formatLocalDate,
  normalizeDate,
  round1,
  round2,
  loadNavCache,
  saveNavCache,
  httpGet,
  httpGetWithRetry,
  batchFetch,
  archiveOldHistory
};
