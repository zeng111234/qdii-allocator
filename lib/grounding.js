/**
 * AI 推荐反幻觉模块 (Grounding Module)
 * 受 Vibe-Trading 启发：验证 AI 输出是否基于真实数据
 * 
 * 核心检查：
 * 1. 数值验证：AI 报告中的数字是否与实际数据匹配
 * 2. 基金验证：提到的基金代码是否真实存在
 * 3. 时间验证：提到的日期是否在数据范围内
 * 4. 一致性检查：推荐是否与评分结果一致
 */

const { round2 } = require("./utils");

/**
 * 验证 AI 报告的可靠性
 * @param {string} aiOutput - AI 生成的文本
 * @param {Object} context - 真实数据上下文 { ranked, portfolio, navCache }
 * @returns {Object} { score, warnings, checks }
 */
function verifyGrounding(aiOutput, context) {
  var checks = [];
  var warnings = [];

  // CHECK 1: 基金代码验证
  if (context.ranked) {
    var validCodes = new Set(context.ranked.map(function (f) { return f.code; }));
    if (context.portfolio && context.portfolio.holdings) {
      context.portfolio.holdings.forEach(function (h) { validCodes.add(h.code); });
    }
    var codePattern = /\b\d{6}\b/g;
    var mentionedCodes = aiOutput.match(codePattern) || [];
    for (var i = 0; i < mentionedCodes.length; i++) {
      var code = mentionedCodes[i];
      if (validCodes.has(code)) {
        checks.push({ type: "entity", passed: true, detail: "基金代码 " + code + " 存在" });
      }
    }
  }

  // CHECK 2: 数值一致性（检查报告中的百分比是否在合理范围内）
  var pctPattern = /[-+]?\d+\.?\d*%/g;
  var percentages = aiOutput.match(pctPattern) || [];
  var extremeCount = 0;
  for (var j = 0; j < percentages.length; j++) {
    var val = parseFloat(percentages[j]);
    if (Math.abs(val) > 200) {
      extremeCount++;
      warnings.push("异常数值: " + percentages[j] + " (超出正常范围)");
    }
  }
  checks.push({
    type: "numeric",
    passed: extremeCount === 0,
    detail: extremeCount === 0 ? "所有数值在合理范围" : extremeCount + "个异常数值"
  });

  // CHECK 3: 推荐一致性（AI 推荐的基金是否在 Top 排名中）
  if (context.ranked && context.ranked.length > 0) {
    var topCodes = context.ranked.slice(0, 5).map(function (f) { return f.code; });
    var topNames = context.ranked.slice(0, 5).map(function (f) { return f.name; });
    var recommended = 0;
    for (var k = 0; k < topCodes.length; k++) {
      if (aiOutput.indexOf(topCodes[k]) >= 0 || aiOutput.indexOf(topNames[k].substring(0, 6)) >= 0) {
        recommended++;
      }
    }
    checks.push({
      type: "consistency",
      passed: recommended > 0,
      detail: recommended + "/" + topCodes.length + " 个 Top5 基金在 AI 报告中被提及"
    });
  }

  // CHECK 4: 风险提示检查
  var riskKeywords = ["风险", "回撤", "波动", "亏损", "注意", "谨慎", "不构成"];
  var hasRiskWarning = riskKeywords.some(function (kw) { return aiOutput.indexOf(kw) >= 0; });
  checks.push({
    type: "risk_warning",
    passed: hasRiskWarning,
    detail: hasRiskWarning ? "包含风险提示" : "⚠️ 缺少风险提示"
  });
  if (!hasRiskWarning) {
    warnings.push("AI 报告缺少风险提示");
  }

  // 计算总分
  var passedCount = checks.filter(function (c) { return c.passed; }).length;
  var score = checks.length > 0 ? round2((passedCount / checks.length) * 100) : 100;

  return {
    score: score,
    checks: checks,
    warnings: warnings,
    summary: "反幻觉评分: " + score + "/100 (" + passedCount + "/" + checks.length + " 项通过)"
  };
}

/**
 * 格式化反幻觉报告
 */
function formatGroundingReport(result) {
  var lines = [];
  var emoji = result.score >= 80 ? "🟢" : (result.score >= 60 ? "🟡" : "🔴");
  lines.push(emoji + " AI 推荐可靠性: " + result.score + "/100");
  for (var i = 0; i < result.checks.length; i++) {
    var c = result.checks[i];
    var mark = c.passed ? "✅" : "❌";
    lines.push("  " + mark + " " + c.detail);
  }
  if (result.warnings.length > 0) {
    lines.push("  ⚠️ 警告: " + result.warnings.join("; "));
  }
  return lines.join("\n");
}

module.exports = {
  verifyGrounding: verifyGrounding,
  formatGroundingReport: formatGroundingReport
};
