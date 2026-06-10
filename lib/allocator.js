/**
 * QDII Fund Budget Allocation Engine
 * Strategies: equal, low_fee, scarce
 */

const Strategy = {
  EQUAL: "equal",
  LOW_FEE: "low_fee",
  SCARCE_FIRST: "scarce"
};

function filterAvailable(funds, minPurchase) {
  if (!minPurchase) minPurchase = 0;
  return funds.filter(f => f.status === "active" && f.dailyLimit > 0 && f.dailyLimit >= minPurchase);
}

function allocateScarce(budget, funds) {
  if (funds.length === 0) return [];
  const sorted = [...funds].sort((a, b) => a.dailyLimit - b.dailyLimit);
  let remaining = budget;
  const result = [];
  for (const fund of sorted) {
    if (remaining <= 0) break;
    const allocated = Math.min(fund.dailyLimit, remaining);
    if (allocated > 0) { result.push({ ...fund, allocated }); remaining -= allocated; }
  }
  return result;
}

function allocateEqual(budget, funds) {
  if (funds.length === 0) return [];
  let remaining = budget;
  const result = funds.map(f => ({ ...f, allocated: 0 }));
  let unsettled = [...result];
  for (let round = 0; round < 5 && unsettled.length > 0 && remaining > 0; round++) {
    const avg = remaining / unsettled.length;
    const nextUnsettled = [];
    for (const fund of unsettled) {
      if (remaining <= 0) break;
      const canAllocate = Math.min(avg, fund.dailyLimit, remaining);
      fund.allocated += canAllocate;
      remaining -= canAllocate;
      if (fund.allocated < fund.dailyLimit && remaining > 0) nextUnsettled.push(fund);
    }
    unsettled = nextUnsettled;
  }
  return result.filter(f => f.allocated > 0);
}

function allocateLowFee(budget, funds) {
  if (funds.length === 0) return [];
  const sorted = [...funds].sort((a, b) => a.feeRate - b.feeRate);
  let remaining = budget; const result = [];
  for (const fund of sorted) {
    if (remaining <= 0) break;
    const allocated = Math.min(fund.dailyLimit, remaining);
    if (allocated > 0) { result.push({ ...fund, allocated }); remaining -= allocated; }
  }
  return result;
}

function formatLocalDate(date) {
  var d = new Date(date);
  var year = d.getFullYear();
  var month = ("0" + (d.getMonth() + 1)).slice(-2);
  var day = ("0" + d.getDate()).slice(-2);
  return year + "-" + month + "-" + day;
}

function allocate(budget, funds, strategy, minPurchase) {
  if (!strategy) strategy = Strategy.SCARCE_FIRST;
  const available = filterAvailable(funds, minPurchase);
  const suspended = funds.filter(f => f.status !== "active" || f.dailyLimit <= 0 || f.dailyLimit < (minPurchase || 0));
  let allocations;
  switch (strategy) {
    case Strategy.EQUAL: allocations = allocateEqual(budget, available); break;
    case Strategy.LOW_FEE: allocations = allocateLowFee(budget, available); break;
    default: allocations = allocateScarce(budget, available);
  }
  const totalAllocated = allocations.reduce((sum, f) => sum + f.allocated, 0);
  const leftover = budget - totalAllocated;
  const names = {equal: "\u5e73\u5747\u4e3b\u4e49", low_fee: "\u4f4e\u8d39\u7387\u4f18\u5148", scarce: "\u7a00\u7f3a\u989d\u5ea6\u4f18\u5148"};
  return {
    budget, strategy,
    strategyName: names[strategy] || names.scarce,
    date: formatLocalDate(new Date()),
    allocations, suspended,
    totalAllocated: Math.round(totalAllocated * 100) / 100,
    leftover: Math.round(leftover * 100) / 100
  };
}

function formatResult(result) {
  const lines = [];
  lines.push("[\u4eca\u65e5QDII\u6295\u8d44\u8ba1\u5212] " + result.date);
  lines.push("");
  lines.push("\u603b\u9884\u7b97\uff1a" + result.budget + "\u5143");
  lines.push("\u7b56\u7565\uff1a" + result.strategyName);
  lines.push("");
  if (result.allocations.length > 0) {
    lines.push("\u4e70\u5165\u6e05\u5355\uff1a");
    lines.push("+------------------------------+----------+--------+");
    lines.push("| \u57fa\u91d1                         | \u9650\u8d2d\u989d\u5ea6  | \u4e70\u5165   |");
    lines.push("+------------------------------+----------+--------+");
    for (const f of result.allocations) {
      const name = (f.name.length > 26 ? f.name.substring(0, 26) + ".." : f.name).padEnd(28);
      const limit = (f.dailyLimit + "\u5143").padStart(8);
      const alloc = (f.allocated + "\u5143").padStart(6);
      lines.push("| " + name + "|" + limit + "  |" + alloc + "  |");
    }
    lines.push("+------------------------------+----------+--------+");
  } else {
    lines.push(">> \u4eca\u65e5\u65e0\u53ef\u7533\u8d2d\u57fa\u91d1");
  }
  if (result.suspended.length > 0) {
    lines.push("");
    lines.push("\u4eca\u65e5\u8df3\u8fc7\uff1a");
    for (const f of result.suspended) {
      const reason = f.status === "suspended" ? "\u6682\u505c\u7533\u8d2d" : "\u9650\u989d\u4e3a0";
      lines.push("  - " + f.name + "(" + f.code + ") -> " + reason);
    }
  }
  if (result.leftover > 0) {
    lines.push("");
    lines.push("\u5269\u4f59\u672a\u5206\u914d\uff1a" + result.leftover + "\u5143");
  }
  lines.push("");
  lines.push("\u5408\u8ba1\u4e70\u5165\uff1a" + result.totalAllocated + "\u5143 / \u9884\u7b97" + result.budget + "\u5143");
  return lines.join("\n");
}

module.exports = { allocate, formatResult, Strategy, filterAvailable };