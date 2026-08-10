/**
 * SQLite 数据库模块（基于 sql.js，纯 JS 实现）
 * 当前仅用于 nav-cache 存储，替代 JSON 文件
 *
 * 优势：
 * - 按 code+date 索引查询，O(log n) 而非 O(n)
 * - 增量写入无需全量序列化
 * - 文件体积更小（二进制格式）
 */

const initSqlJs = require("sql.js");
const fs = require("fs");
const path = require("path");

const DB_FILE = process.env.NAV_DB_FILE
  ? path.resolve(process.env.NAV_DB_FILE)
  : path.join(__dirname, "..", "data", "nav-cache.db");

let _db = null;
let _sqlReady = false;

/**
 * 初始化数据库（懒加载，首次调用时创建）
 */
async function getDb() {
  if (_db) return _db;

  const SQL = await initSqlJs();

  if (fs.existsSync(DB_FILE)) {
    const buffer = fs.readFileSync(DB_FILE);
    _db = new SQL.Database(buffer);
  } else {
    _db = new SQL.Database();
  }

  // 创建表（如果不存在）
  _db.run(`
    CREATE TABLE IF NOT EXISTS nav_cache (
      code TEXT NOT NULL,
      date TEXT NOT NULL,
      nav REAL NOT NULL,
      acc_nav REAL,
      change_rate REAL,
      PRIMARY KEY (code, date)
    )
  `);

  // 创建索引
  _db.run("CREATE INDEX IF NOT EXISTS idx_nav_code ON nav_cache(code)");
  _db.run("CREATE INDEX IF NOT EXISTS idx_nav_date ON nav_cache(date)");
  _db.run("CREATE INDEX IF NOT EXISTS idx_nav_code_date ON nav_cache(code, date)");

  _sqlReady = true;
  return _db;
}

/**
 * 持久化数据库到文件
 */
function saveDb() {
  if (!_db) return;
  try {
    fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
    const data = _db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(DB_FILE, buffer);
  } catch(e) {
    console.error("[db] save error:", e.message);
  }
}

/**
 * 获取某只基金的全部净值记录
 * @param {string} code
 * @returns {Array<{date, nav, accNav, changeRate}>}
 */
function getNavHistory(code) {
  if (!_db) return [];
  const stmt = _db.prepare("SELECT date, nav, acc_nav, change_rate FROM nav_cache WHERE code = ? ORDER BY date");
  stmt.bind([code]);
  const results = [];
  while (stmt.step()) {
    const row = stmt.getAsObject();
    results.push({
      date: row.date,
      nav: row.nav,
      accNav: row.acc_nav,
      changeRate: row.change_rate
    });
  }
  stmt.free();
  return results;
}

/**
 * 获取某只基金指定日期范围的净值记录
 * @param {string} code
 * @param {string} fromDate - YYYY-MM-DD
 * @param {string} toDate - YYYY-MM-DD
 * @returns {Array<{date, nav, accNav, changeRate}>}
 */
function getNavHistoryRange(code, fromDate, toDate) {
  if (!_db) return [];
  const stmt = _db.prepare(
    "SELECT date, nav, acc_nav, change_rate FROM nav_cache WHERE code = ? AND date >= ? AND date <= ? ORDER BY date"
  );
  stmt.bind([code, fromDate, toDate]);
  const results = [];
  while (stmt.step()) {
    const row = stmt.getAsObject();
    results.push({
      date: row.date,
      nav: row.nav,
      accNav: row.acc_nav,
      changeRate: row.change_rate
    });
  }
  stmt.free();
  return results;
}

/**
 * 获取某只基金的最新净值
 * @param {string} code
 * @returns {{date, nav}|null}
 */
function getLatestNav(code) {
  if (!_db) return null;
  const stmt = _db.prepare("SELECT date, nav FROM nav_cache WHERE code = ? ORDER BY date DESC LIMIT 1");
  stmt.bind([code]);
  let result = null;
  if (stmt.step()) {
    const row = stmt.getAsObject();
    result = { date: row.date, nav: row.nav };
  }
  stmt.free();
  return result;
}

/**
 * 插入或更新净值记录（批量）
 * @param {string} code
 * @param {Array<{date, nav, accNav, changeRate}>} records
 */
function upsertNavRecords(code, records) {
  if (!_db || !records || records.length === 0) return 0;

  const stmt = _db.prepare(
    "INSERT OR REPLACE INTO nav_cache (code, date, nav, acc_nav, change_rate) VALUES (?, ?, ?, ?, ?)"
  );

  let count = 0;
  _db.run("BEGIN TRANSACTION");
  try {
    for (const rec of records) {
      stmt.run([code, rec.date, rec.nav, rec.accNav || null, rec.changeRate || 0]);
      count++;
    }
    _db.run("COMMIT");
  } catch(e) {
    _db.run("ROLLBACK");
    console.error("[db] upsert error:", e.message);
  }
  stmt.free();
  return count;
}

function deleteNavRecords(code) {
  if (!_db || !code) return 0;
  _db.run("DELETE FROM nav_cache WHERE code = ?", [code]);
  return _db.getRowsModified();
}

/**
 * 获取数据库统计信息
 * @returns {{fundCount, totalRecords, oldestDate, newestDate}}
 */
function getStats() {
  if (!_db) return { fundCount: 0, totalRecords: 0 };
  const row = _db.exec(
    "SELECT COUNT(DISTINCT code) as fund_count, COUNT(*) as total_records, MIN(date) as oldest, MAX(date) as newest FROM nav_cache"
  );
  if (row.length === 0 || row[0].values.length === 0) {
    return { fundCount: 0, totalRecords: 0 };
  }
  const v = row[0].values[0];
  return {
    fundCount: v[0],
    totalRecords: v[1],
    oldestDate: v[2],
    newestDate: v[3]
  };
}

/**
 * 从 JSON 文件迁移到 SQLite
 * @returns {{migrated, funds}}
 */
function migrateFromJson(jsonPath) {
  if (!fs.existsSync(jsonPath)) {
    console.log("[db] JSON file not found, skipping migration");
    return { migrated: 0, funds: 0 };
  }

  const json = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
  const codes = Object.keys(json);
  let totalRecords = 0;

  _db.run("BEGIN TRANSACTION");
  try {
    const stmt = _db.prepare(
      "INSERT OR IGNORE INTO nav_cache (code, date, nav, acc_nav, change_rate) VALUES (?, ?, ?, ?, ?)"
    );

    for (const code of codes) {
      const records = json[code];
      if (!records || records.length === 0) continue;
      for (const rec of records) {
        stmt.run([code, rec.date, rec.nav, rec.accNav || null, rec.changeRate || 0]);
        totalRecords++;
      }
    }
    stmt.free();
    _db.run("COMMIT");
  } catch(e) {
    _db.run("ROLLBACK");
    console.error("[db] migration error:", e.message);
    return { migrated: 0, funds: 0 };
  }

  saveDb();
  console.log("[db] 迁移完成: " + codes.length + " 只基金, " + totalRecords + " 条记录");
  return { migrated: totalRecords, funds: codes.length };
}

/**
 * 关闭数据库
 */
function closeDb() {
  if (_db) {
    saveDb();
    _db.close();
    _db = null;
    _sqlReady = false;
  }
}

module.exports = {
  getDb,
  saveDb,
  closeDb,
  getNavHistory,
  getNavHistoryRange,
  getLatestNav,
  upsertNavRecords,
  deleteNavRecords,
  getStats,
  migrateFromJson
};
