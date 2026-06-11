/**
 * nav-cache 迁移脚本：JSON → SQLite
 * 运行一次即可，之后 SQLite 为主存储
 */

const path = require("path");
const db = require("../lib/db");

const JSON_FILE = path.join(__dirname, "..", "data", "nav-cache.json");

async function main() {
  console.log("=== nav-cache 迁移 (JSON → SQLite) ===");
  console.log("");

  await db.getDb();

  const stats = db.getStats();
  if (stats.totalRecords > 0) {
    console.log("SQLite 已有 " + stats.totalRecords + " 条记录，跳过迁移");
    console.log("如需重新迁移，请先删除 data/nav-cache.db");
    db.closeDb();
    return;
  }

  console.log("从 JSON 文件迁移: " + JSON_FILE);
  const result = db.migrateFromJson(JSON_FILE);

  if (result.migrated > 0) {
    const newStats = db.getStats();
    console.log("");
    console.log("迁移结果:");
    console.log("  基金数: " + newStats.fundCount);
    console.log("  总记录: " + newStats.totalRecords);
    console.log("  日期范围: " + newStats.oldestDate + " ~ " + newStats.newestDate);
    console.log("");
    console.log("迁移成功！后续数据将自动写入 SQLite。");
  } else {
    console.log("无数据可迁移（JSON 文件为空或不存在）");
  }

  db.closeDb();
}

main().catch(err => {
  console.error("Migration failed:", err);
  process.exit(1);
});
