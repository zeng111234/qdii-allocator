/**
 * 假设追踪数据修复脚本
 * 修复以下问题：
 * 1. ID碰撞：去重重复ID
 * 2. stats计数器漂移：重算stats
 * 3. navAtCreation为null：标记为待补充
 */

const fs = require("fs");
const path = require("path");

const HYPOTHESIS_FILE = path.join(__dirname, "..", "data", "hypotheses.json");
const BACKUP_FILE = path.join(__dirname, "..", "data", "hypotheses.backup.json");

console.log("🔧 开始修复假设追踪数据...");

// 1. 备份当前数据
if (fs.existsSync(HYPOTHESIS_FILE)) {
  fs.copyFileSync(HYPOTHESIS_FILE, BACKUP_FILE);
  console.log("✅ 已备份到:", BACKUP_FILE);
} else {
  console.log("❌ 数据文件不存在:", HYPOTHESIS_FILE);
  process.exit(1);
}

// 2. 加载数据
const data = JSON.parse(fs.readFileSync(HYPOTHESIS_FILE, "utf-8"));
console.log("📊 当前假设数量:", data.hypotheses.length);

// 3. 去重ID（保留第一个出现的，移除后续重复）
const seen = new Set();
const duplicates = [];
data.hypotheses = data.hypotheses.filter(h => {
  if (seen.has(h.id)) {
    duplicates.push({ id: h.id, fund: h.fundName });
    return false;
  }
  seen.add(h.id);
  return true;
});

if (duplicates.length > 0) {
  console.log("⚠️  发现重复ID:", duplicates.length, "个");
  duplicates.forEach(d => console.log("   -", d.id, ":", d.fund));
} else {
  console.log("✅ 无重复ID");
}

// 4. 重算stats计数器
data.stats = {
  total: data.hypotheses.length,
  active: data.hypotheses.filter(h => h.status === "active").length,
  validated: data.hypotheses.filter(h => h.status === "validated").length,
  invalidated: data.hypotheses.filter(h => h.status === "invalidated").length,
  expired: data.hypotheses.filter(h => h.status === "expired").length
};

console.log("📈 重算统计:");
console.log("   - 总数:", data.stats.total);
console.log("   - 活跃:", data.stats.active);
console.log("   - 已验证:", data.stats.validated);
console.log("   - 已否定:", data.stats.invalidated);
console.log("   - 已过期:", data.stats.expired);

// 5. 检查navAtCreation为null的假设
const nullNavHyps = data.hypotheses.filter(h => !h.navAtCreation && h.status === "active");
if (nullNavHyps.length > 0) {
  console.log("⚠️  发现navAtCreation为null的活跃假设:", nullNavHyps.length, "个");
  nullNavHyps.forEach(h => console.log("   -", h.id, ":", h.fundName, "(创建:", h.createdAt, ")"));

  // 为这些假设添加标记，但不修改状态（避免影响现有逻辑）
  nullNavHyps.forEach(h => {
    h._needsNavBackfill = true;
    h._backfillNote = "基准净值待补充，暂不参与胜率计算";
  });
}

// 6. 保存修复后的数据
fs.writeFileSync(HYPOTHESIS_FILE, JSON.stringify(data, null, 2), "utf-8");
console.log("✅ 数据修复完成，已保存到:", HYPOTHESIS_FILE);

// 7. 验证修复结果
const verification = JSON.parse(fs.readFileSync(HYPOTHESIS_FILE, "utf-8"));
const uniqueIds = new Set(verification.hypotheses.map(h => h.id));
console.log("\n🔍 修复验证:");
console.log(
  "   - 唯一ID数量:",
  uniqueIds.size,
  "/",
  verification.hypotheses.length,
  uniqueIds.size === verification.hypotheses.length ? "✅" : "❌"
);
console.log(
  "   - stats.total:",
  verification.stats.total,
  "/",
  verification.hypotheses.length,
  verification.stats.total === verification.hypotheses.length ? "✅" : "❌"
);
console.log(
  "   - stats.active:",
  verification.stats.active,
  "/",
  verification.hypotheses.filter(h => h.status === "active").length,
  verification.stats.active === verification.hypotheses.filter(h => h.status === "active").length ? "✅" : "❌"
);

console.log("\n📋 修复摘要:");
console.log("   - 移除重复ID:", duplicates.length, "个");
console.log("   - 重算stats计数器");
console.log("   - 标记待补充navAtCreation:", nullNavHyps.length, "个");
console.log("   - 备份文件:", BACKUP_FILE);
console.log("\n🎯 下一步: 运行 node index.js --hypotheses 验证修复效果");
