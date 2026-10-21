const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const stall = require("../../lib/stall-detector");

const HISTORY_FILE = path.join(__dirname, "..", "..", "data", "history.json");

/** 造一条 history 记录 */
function rec(date, pauseReasons, action) {
  return {
    date: date,
    action: action || (pauseReasons && pauseReasons.length ? "PAUSE" : "BUY"),
    pauseReasons: pauseReasons || []
  };
}
/** 造 n 天连续暂停 */
function pauseRun(n, reason, startDay) {
  const day = startDay || 1;
  return Array.from({ length: n }, function (_, i) {
    const d = String(day + i).padStart(2, "0");
    return rec("2026-01-" + d, [reason]);
  });
}

test("stall detector flags the real multi-week stall in production history", function () {
  if (!fs.existsSync(HISTORY_FILE)) return; // 无数据时跳过，不让 CI 失败
  const history = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf-8"));
  const records = history.records || [];
  if (records.length < 20) return;

  const verdict = stall.detectStall(records);
  assert.equal(verdict.stalled, true, "生产历史里的长期停摆应被检出");
  assert.equal(verdict.reason, "ACCEPTANCE_GATE");
  assert.ok(verdict.runLength >= 10, "主导原因出现次数应达到阈值");
  assert.ok(verdict.dominance >= 0.7, "主导原因占比应超过阈值");
  assert.equal(verdict.class, "unverifiable_or_failed");
});

test("stall alert text names the evidence/failure blind spot", function () {
  const records = pauseRun(15, "ACCEPTANCE_GATE");
  const text = stall.buildStallAlert(records);
  assert.ok(text, "应生成告警文本");
  assert.match(text, /ACCEPTANCE_GATE/);
  assert.match(text, /无法继续推进/);
  assert.match(text, /证据不足|没法测/);
});

test("stall detector stays silent on empty or all-normal history", function () {
  assert.equal(stall.detectStall([]).stalled, false);
  assert.equal(stall.detectStall(null).stalled, false);
  const normal = Array.from({ length: 50 }, function (_, i) {
    return rec("2026-02-" + String((i % 28) + 1).padStart(2, "0"), []);
  });
  assert.equal(stall.detectStall(normal).stalled, false);
  assert.equal(stall.buildStallAlert(normal), null);
});

test("stall detector requires the threshold before alerting", function () {
  assert.equal(stall.detectStall(pauseRun(5, "ACCEPTANCE_GATE")).stalled, false);
  assert.equal(stall.detectStall(pauseRun(10, "ACCEPTANCE_GATE")).stalled, true);
});

test("stall detector survives a single mixed-reason day without losing the stall", function () {
  // 真实生产数据就是这种形态：2026-09-21 多带了一个 SIGNAL_BREAKER，
  // 严格「连续相同原因」计数会被打断，但系统实际仍在停摆。
  const records = [
    ...pauseRun(20, "ACCEPTANCE_GATE", 1),
    rec("2026-01-21", ["ACCEPTANCE_GATE", "SIGNAL_BREAKER"])
  ];
  const verdict = stall.detectStall(records);
  assert.equal(verdict.stalled, true, "一天混合原因不应掩盖整段停摆");
  assert.equal(verdict.reason, "ACCEPTANCE_GATE");
});

test("stall detector reports the new dominant reason after a regime change", function () {
  const records = [
    ...Array.from({ length: 12 }, function (_, i) {
      return rec("2026-03-" + String(i + 1).padStart(2, "0"), ["ACCEPTANCE_GATE"]);
    }),
    ...Array.from({ length: 15 }, function (_, i) {
      return rec("2026-04-" + String(i + 1).padStart(2, "0"), ["SIGNAL_BREAKER"]);
    })
  ];
  const verdict = stall.detectStall(records);
  assert.equal(verdict.stalled, true);
  assert.equal(verdict.reason, "SIGNAL_BREAKER");
});

test("stall detector does not alert after a genuine recovery", function () {
  const records = [
    ...pauseRun(20, "ACCEPTANCE_GATE", 1),
    ...Array.from({ length: 15 }, function (_, i) {
      return rec("2026-05-" + String(i + 1).padStart(2, "0"), []);
    })
  ];
  assert.equal(stall.detectStall(records).stalled, false, "恢复后不应继续报警");
});

test("stall detector ignores sparse occasional pauses", function () {
  const records = [
    ...pauseRun(4, "ACCEPTANCE_GATE", 1),
    ...Array.from({ length: 16 }, function (_, i) {
      return rec("2026-06-" + String(i + 1).padStart(2, "0"), []);
    })
  ];
  assert.equal(stall.detectStall(records).stalled, false, "偶发暂停占比低，不应报警");
});

test("stall detector thresholds are configurable", function () {
  const records = pauseRun(3, "ACCEPTANCE_GATE");
  assert.equal(stall.detectStall(records).stalled, false);
  assert.equal(stall.detectStall(records, { threshold: 3 }).stalled, true);
  assert.equal(stall.detectStall(records, { threshold: 3, dominance: 0.99 }).stalled, true);
});

test("stall detection never mutates the input records", function () {
  const records = pauseRun(12, "ACCEPTANCE_GATE");
  const snapshot = JSON.stringify(records);
  stall.detectStall(records);
  stall.buildStallAlert(records);
  assert.equal(JSON.stringify(records), snapshot, "检测器必须是只读的");
});

test("index pipeline appends the current run before detecting a stall", function () {
  // 复刻 index.js 里的接线：把本次结果接到历史尾部再判定。
  // 这里用一段「恰好差一条到阈值」的历史，验证补上当前这条后会被检出。
  const history = pauseRun(9, "ACCEPTANCE_GATE");
  assert.equal(stall.detectStall(history).stalled, false, "只有 9 条时不该报警");

  const withCurrent = history.concat([rec("2026-01-10", ["ACCEPTANCE_GATE"])]);
  const verdict = stall.detectStall(withCurrent);
  assert.equal(verdict.stalled, true, "补上本次结果后应达到阈值");
  assert.equal(verdict.runLength, 10);
});
