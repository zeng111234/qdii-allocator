/**
 * 交易日历模块
 * 处理QDII基金T+2交易日结算（非日历日）
 * 
 * 交易日 = 工作日 - 节假日
 * 周六日永远不是交易日，中国法定节假日也不是
 */

var fs = require("fs");
var path = require("path");

var HOLIDAYS_FILE = path.join(__dirname, "..", "data", "holidays.json");
var NAV_CACHE_FILE = path.join(__dirname, "..", "data", "nav-cache.json");

// ========== 中国法定节假日 (2025-2026) ==========
// 格式: "YYYY-MM-DD"，只包含实际休市的日子
// 来源: 中国证监会/沪深交易所公告
// 调休上班日不需要单独记录（因为本身就是工作日，只是不放假）

var BUILT_IN_HOLIDAYS = [
  // === 2025年 ===
  // 元旦: 2025-01-01
  "2025-01-01",
  // 春节: 2025-01-28 ~ 2025-02-04 (8天)
  "2025-01-28", "2025-01-29", "2025-01-30", "2025-01-31",
  "2025-02-01", "2025-02-02", "2025-02-03", "2025-02-04",
  // 清明节: 2025-04-04 ~ 2025-04-06
  "2025-04-04", "2025-04-05", "2025-04-06",
  // 劳动节: 2025-05-01 ~ 2025-05-05
  "2025-05-01", "2025-05-02", "2025-05-03", "2025-05-04", "2025-05-05",
  // 端午节: 2025-05-31 ~ 2025-06-02
  "2025-05-31", "2025-06-01", "2025-06-02",
  // 中秋+国庆: 2025-10-01 ~ 2025-10-08
  "2025-10-01", "2025-10-02", "2025-10-03", "2025-10-04",
  "2025-10-05", "2025-10-06", "2025-10-07", "2025-10-08",

  // === 2026年 ===
  // 元旦: 2026-01-01 ~ 2026-01-03
  "2026-01-01", "2026-01-02", "2026-01-03",
  // 春节: 2026-02-17 ~ 2026-02-23 (7天)
  "2026-02-17", "2026-02-18", "2026-02-19", "2026-02-20",
  "2026-02-21", "2026-02-22", "2026-02-23",
  // 清明节: 2026-04-04 ~ 2026-04-06
  "2026-04-04", "2026-04-05", "2026-04-06",
  // 劳动节: 2026-05-01 ~ 2026-05-05
  "2026-05-01", "2026-05-02", "2026-05-03", "2026-05-04", "2026-05-05",
  // 端午节: 2026-06-19 ~ 2026-06-21
  "2026-06-19", "2026-06-20", "2026-06-21",
  // 中秋节: 2026-09-25 ~ 2026-09-27
  "2026-09-25", "2026-09-26", "2026-09-27",
  // 国庆节: 2026-10-01 ~ 2026-10-07
  "2026-10-01", "2026-10-02", "2026-10-03",
  "2026-10-04", "2026-10-05", "2026-10-06", "2026-10-07",

  // === 2027年 ===
  // 元旦: 2027-01-01 ~ 2027-01-03
  "2027-01-01", "2027-01-02", "2027-01-03",
  // 春节: 2027-02-06 ~ 2027-02-12 (7天)
  "2027-02-06", "2027-02-07", "2027-02-08", "2027-02-09",
  "2027-02-10", "2027-02-11", "2027-02-12",
  // 清明节: 2027-04-03 ~ 2027-04-05
  "2027-04-03", "2027-04-04", "2027-04-05",
  // 劳动节: 2027-05-01 ~ 2027-05-05
  "2027-05-01", "2027-05-02", "2027-05-03", "2027-05-04", "2027-05-05",
  // 端午节: 2027-06-09 ~ 2027-06-11
  "2027-06-09", "2027-06-10", "2027-06-11",
  // 中秋节: 2027-09-15 ~ 2027-09-17
  "2027-09-15", "2027-09-16", "2027-09-17",
  // 国庆节: 2027-10-01 ~ 2027-10-07
  "2027-10-01", "2027-10-02", "2027-10-03",
  "2027-10-04", "2027-10-05", "2027-10-06", "2027-10-07"
];

// ========== 节假日数据管理 ==========

var _holidayCache = null;

/**
 * 加载所有节假日（内置 + 用户自定义）
 * @returns {Set<string>} 节假日日期集合 "YYYY-MM-DD"
 */
function loadHolidays() {
  if (_holidayCache) return _holidayCache;

  var holidays = new Set(BUILT_IN_HOLIDAYS);

  // 加载用户自定义节假日
  try {
    if (fs.existsSync(HOLIDAYS_FILE)) {
      var userHolidays = JSON.parse(fs.readFileSync(HOLIDAYS_FILE, "utf-8"));
      if (Array.isArray(userHolidays)) {
        userHolidays.forEach(function(d) { holidays.add(d); });
      } else if (userHolidays.dates && Array.isArray(userHolidays.dates)) {
        userHolidays.dates.forEach(function(d) { holidays.add(d); });
      }
    }
  } catch(e) {
    // 忽略加载错误，使用内置数据
  }

  _holidayCache = holidays;
  return holidays;
}

/**
 * 清除节假日缓存（用于测试或更新后）
 */
function clearHolidayCache() {
  _holidayCache = null;
}

/**
 * 添加自定义节假日
 * @param {string[]} dates - 日期数组 "YYYY-MM-DD"
 */
function addHolidays(dates) {
  var holidays = loadHolidays();
  dates.forEach(function(d) { holidays.add(d); });

  // 持久化
  try {
    var existing = [];
    if (fs.existsSync(HOLIDAYS_FILE)) {
      var data = JSON.parse(fs.readFileSync(HOLIDAYS_FILE, "utf-8"));
      existing = Array.isArray(data) ? data : (data.dates || []);
    }
    dates.forEach(function(d) {
      if (existing.indexOf(d) < 0) existing.push(d);
    });
    existing.sort();
    fs.writeFileSync(HOLIDAYS_FILE, JSON.stringify({ dates: existing, _note: "自定义节假日（补充内置数据）" }, null, 2), "utf-8");
  } catch(e) {
    console.error("[日历] 保存节假日失败:", e.message);
  }
}

// ========== 日期判断 ==========

/**
 * 判断是否为工作日（周一到周五）
 * @param {Date|string} date
 * @returns {boolean}
 */
function isWeekday(date) {
  var d = typeof date === "string" ? new Date(date + "T00:00:00") : date;
  var day = d.getDay();
  return day >= 1 && day <= 5;
}

/**
 * 判断是否为节假日（在节假日表中）
 * @param {Date|string} date
 * @returns {boolean}
 */
function isHoliday(date) {
  var dateStr = typeof date === "string" ? date : formatDate(date);
  var holidays = loadHolidays();
  return holidays.has(dateStr);
}

/**
 * 判断是否为交易日（工作日 且 非节假日）
 * @param {Date|string} date
 * @returns {boolean}
 */
function isTradingDay(date) {
  return isWeekday(date) && !isHoliday(date);
}

/**
 * 获取星期几的中文名
 * @param {Date|string} date
 * @returns {string}
 */
function getWeekdayName(date) {
  var names = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  var d = typeof date === "string" ? new Date(date + "T00:00:00") : date;
  return names[d.getDay()];
}

/**
 * 格式化日期为 YYYY-MM-DD
 * @param {Date} d
 * @returns {string}
 */
function formatDate(d) {
  return d.getFullYear() + "-" +
    ("0" + (d.getMonth() + 1)).slice(-2) + "-" +
    ("0" + d.getDate()).slice(-2);
}

// ========== 核心: 交易日加减 ==========

/**
 * 从某个日期开始，加 N 个交易日
 * 自动跳过周末和节假日
 * 
 * @param {string} startDate - 起始日期 "YYYY-MM-DD"
 * @param {number} tradingDays - 要加的交易日数
 * @returns {Object} { date: "YYYY-MM-DD", weekday: "周X", skipped: number }
 */
function addTradingDays(startDate, tradingDays) {
  if (!tradingDays || tradingDays <= 0) {
    return { date: startDate, weekday: getWeekdayName(startDate), skipped: 0 };
  }

  var d = new Date(startDate + "T00:00:00");
  var added = 0;
  var skipped = 0;
  var maxIterations = tradingDays * 3 + 30; // 安全上限，防止死循环

  while (added < tradingDays && maxIterations > 0) {
    d.setDate(d.getDate() + 1);
    maxIterations--;

    if (!isTradingDay(d)) {
      skipped++;
      continue;
    }
    added++;
  }

  var resultDate = formatDate(d);
  return {
    date: resultDate,
    weekday: getWeekdayName(resultDate),
    skipped: skipped
  };
}

/**
 * 从 nav-cache 中提取某个基金的历史交易日
 * @param {string} fundCode
 * @returns {Set<string>}
 */
function extractTradingDaysFromCache(fundCode) {
  var cacheFile = NAV_CACHE_FILE;
  try {
    if (!fs.existsSync(cacheFile)) return new Set();
    var cache = JSON.parse(fs.readFileSync(cacheFile, "utf-8"));
    var navs = cache[fundCode];
    if (!navs || navs.length === 0) return new Set();
    var dates = new Set();
    navs.forEach(function(n) { dates.add(n.date); });
    return dates;
  } catch(e) {
    return new Set();
  }
}

/**
 * 从 nav-cache 中提取所有基金的交易日并集
 * @returns {Set<string>}
 */
function extractAllTradingDays() {
  var cacheFile = NAV_CACHE_FILE;
  try {
    if (!fs.existsSync(cacheFile)) return new Set();
    var cache = JSON.parse(fs.readFileSync(cacheFile, "utf-8"));
    var dates = new Set();
    Object.keys(cache).forEach(function(code) {
      (cache[code] || []).forEach(function(n) { dates.add(n.date); });
    });
    return dates;
  } catch(e) {
    return new Set();
  }
}

/**
 * 验证某日期是否在 nav-cache 中有交易数据
 * @param {string} dateStr
 * @returns {boolean}
 */
function hasNavData(dateStr) {
  var tradingDays = extractAllTradingDays();
  return tradingDays.has(dateStr);
}

/**
 * 打印节假日统计信息
 */
function printCalendarInfo() {
  var holidays = loadHolidays();
  var holidayArray = Array.from(holidays).sort();

  console.log("[日历] 已加载 " + holidayArray.length + " 个节假日");
  console.log("[日历] 范围: " + holidayArray[0] + " ~ " + holidayArray[holidayArray.length - 1]);

  // 从 nav-cache 提取交易日
  var navTradingDays = extractAllTradingDays();
  if (navTradingDays.size > 0) {
    var navArray = Array.from(navTradingDays).sort();
    console.log("[日历] nav-cache 交易日: " + navArray.length + " 天 (" + navArray[0] + " ~ " + navArray[navArray.length - 1] + ")");

    // 检查节假日表和 nav-cache 的一致性
    var mismatchCount = 0;
    holidayArray.forEach(function(h) {
      // 检查节假日是否有 nav 数据（不应该有）
      if (navTradingDays.has(h)) {
        if (mismatchCount < 5) console.warn("[日历] ⚠️ 节假日 " + h + " 在 nav-cache 中有数据（可能是调休日或数据错误）");
        mismatchCount++;
      }
    });
    if (mismatchCount > 0) {
      console.warn("[日历] ⚠️ 共 " + mismatchCount + " 个节假日与 nav-cache 不一致");
    }
  }
}

// ========== 导出 ==========

module.exports = {
  isWeekday: isWeekday,
  isHoliday: isHoliday,
  isTradingDay: isTradingDay,
  getWeekdayName: getWeekdayName,
  addTradingDays: addTradingDays,
  loadHolidays: loadHolidays,
  addHolidays: addHolidays,
  clearHolidayCache: clearHolidayCache,
  extractTradingDaysFromCache: extractTradingDaysFromCache,
  extractAllTradingDays: extractAllTradingDays,
  hasNavData: hasNavData,
  printCalendarInfo: printCalendarInfo,
  formatDate: formatDate,
  BUILT_IN_HOLIDAYS: BUILT_IN_HOLIDAYS
};
