/**
 * db.js 核心测试 — 只测数据读写正确性
 */
const test = require('node:test');
const assert = require('node:assert');
const db = require('../../lib/db');

// ─── 空库查询返回空 ───

test('getNavHistory: 不存在的基金返回空数组', async function () {
  await db.getDb(); // 初始化数据库
  const result = await db.getNavHistory('999999');
  assert.ok(Array.isArray(result));
  assert.strictEqual(result.length, 0);
  db.closeDb();
});

test('getLatestNav: 不存在的基金返回 null', async function () {
  await db.getDb();
  const result = await db.getLatestNav('999999');
  assert.strictEqual(result, null);
  db.closeDb();
});

// ─── upsert 往返测试（核心：写入后读出的值必须一致） ───

test('upsertNavRecords: 写入2条记录后读出值完全一致', async function () {
  await db.getDb(); // 必须先初始化数据库
  const records = [
    { date: '2020-01-01', nav: 1.0, accNav: 1.0, changeRate: 0 },
    { date: '2020-01-02', nav: 1.1, accNav: 1.1, changeRate: 10 }
  ];
  const count = db.upsertNavRecords('TEST001', records);
  assert.strictEqual(count, 2, '应插入2条记录，得到' + count);

  const history = await db.getNavHistory('TEST001');
  assert.strictEqual(history.length, 2, '应读出2条记录，得到' + history.length);
  assert.strictEqual(history[0].date, '2020-01-01');
  assert.strictEqual(history[0].nav, 1.0);
  assert.strictEqual(history[1].date, '2020-01-02');
  assert.strictEqual(history[1].nav, 1.1);

  db.closeDb();
});

// ─── migrateFromJson ───

test('migrateFromJson: 不存在的文件返回 {migrated:0, funds:0}', async function () {
  const result = await db.migrateFromJson('/non/existent/path.json');
  assert.ok(result && result.migrated === 0 && result.funds === 0);
});
