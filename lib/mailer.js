const nodemailer = require("nodemailer");

function createTransporter(config) {
  return nodemailer.createTransport({
    host: config.host, port: config.port,
    secure: config.port === 465,
    auth: { user: config.user, pass: config.pass },
    // [security] TLS 验证默认启用，不再跳过证书检查
    dns: function(hostname, cb) {
      require("dns").lookup(hostname, { family: 4 }, cb);
    }
  });
}

function esc(s) {
  if (!s) return "";
  const amp = String.fromCharCode(38) + "amp;";
  const lt = String.fromCharCode(38) + "lt;";
  const gt = String.fromCharCode(38) + "gt;";
  const quot = String.fromCharCode(38) + "quot;";
  return String(s).replace(/&/g, amp).replace(/</g, lt).replace(/>/g, gt).replace(/"/g, quot);
}

/** 安全数值：null/undefined/NaN 统一返回 fallback */
function safeNum(v, fallback) {
  if (fallback === undefined) fallback = "-";
  if (v === null || v === undefined || (typeof v === "number" && isNaN(v))) return fallback;
  return v;
}

function formatValuationIssues(issues, fallbackCodes) {
  if (Array.isArray(issues) && issues.length > 0) {
    return issues.map(function(issue) {
      return String(issue.code || "UNKNOWN") + ":" + String(issue.reason || "NAV_MISSING") +
        (issue.latestDate ? "@" + issue.latestDate : "");
    }).join(", ");
  }
  return (fallbackCodes || []).map(function(code) { return code + ":NAV_MISSING"; }).join(", ");
}

function buildEmailHtml(textContent, aiCommentary, result, options) {
  const dateStr = result ? result.date : new Date().toLocaleDateString("zh-CN",{timeZone:"Asia/Shanghai"});
  const budgetStr = result ? result.budget : "50";
  const _strategyStr = result ? result.strategyName : "";
  const poolInfo = result ? (result.totalPool + "\u53ea\u57fa\u91d1\uff0c" + result.allAvailable + "\u53ea\u6709\u6548") : "";
  const recPlan = result && result.recommendationPlan;
  const action = recPlan && recPlan.action ? recPlan.action : "UNKNOWN";
  const actionLabels = {
    BUY: "\u6b63\u5e38\u4e70\u5165",
    TACTICAL_PAUSE: "\u6807\u666e500\u57fa\u51c6\u5b9a\u6295",
    STRATEGIC_DCA: "\u8fdb\u53d6\u578b\u6838\u5fc3\u5b9a\u6295",
    PAUSE: "\u4eca\u65e5\u6682\u505c\u4e70\u5165",
    HARD_PAUSE: "\u4eca\u65e5\u786c\u6682\u505c",
    HOLD: "\u4eca\u65e5\u6301\u6709\u4e0d\u52a0\u4ed3"
  };
  const purchaseAllowed = ["BUY", "TACTICAL_PAUSE", "STRATEGIC_DCA"].includes(action) && Number(budgetStr) > 0;
  const executionRoutes = recPlan && Array.isArray(recPlan.executionRoutes)
    ? recPlan.executionRoutes.filter(function (route) { return Number(route.amount) > 0; })
    : [];

  // Build ranked cards
  let cards = "";
  if (result && result.ranked && result.ranked.length > 0) {
    for (let i = 0; i < result.ranked.length; i++) {
      const f = result.ranked[i];
      const ind = f.indicators || {};

      // Trend
      let trendColor = "#f39c12";
      let trendText = "\u2500";
      if (ind.longTermTrend === "bull") { trendColor = "#27ae60"; trendText = "\u2191\u725b"; }
      else if (ind.longTermTrend === "bear") { trendColor = "#e74c3c"; trendText = "\u2193\u718a"; }
      else if (ind.longTermTrend === "neutral") { trendColor = "#f39c12"; trendText = "=\u4e2d"; }

      // Score color (guard against NaN)
      const displayScore = safeNum(f.score, 0);
      const scoreColor = displayScore >= 20 ? "#27ae60" : (displayScore >= 10 ? "#3498db" : "#f39c12");

      // Metrics row
      const metrics = [];
      if (ind.annualizedReturn !== null && ind.annualizedReturn !== undefined) metrics.push("\u5e74\u5316 " + safeNum(ind.annualizedReturn) + "%");
      if (ind.threeYearReturn !== null && ind.threeYearReturn !== undefined) metrics.push("3\u5e74 " + safeNum(ind.threeYearReturn) + "%");
      if (ind.sharpeRatio !== null && ind.sharpeRatio !== undefined) metrics.push("\u590f\u666e " + safeNum(ind.sharpeRatio));
      if (ind.maxDrawdown !== null && ind.maxDrawdown !== undefined) metrics.push("\u56de\u64a4 " + safeNum(ind.maxDrawdown) + "%");

      // Row 2
      const row2 = [];
      if (Number(f.proposedAmount) > 0) row2.push("\u5efa\u8bae " + Number(f.proposedAmount) + "\u5143");
      if (ind.recent5Change !== null && ind.recent5Change !== undefined) row2.push("5\u65e5 " + (ind.recent5Change >= 0 ? "+" : "") + safeNum(ind.recent5Change) + "%");
      if (ind.maDeviation !== null && ind.maDeviation !== undefined) row2.push("MA\u504f\u79bb " + safeNum(ind.maDeviation) + "%");
      if (ind.volatility !== null && ind.volatility !== undefined) row2.push("\u6ce2\u52a8 " + safeNum(ind.volatility) + "%");
      if (f.dailyLimit) row2.push("\u9650\u8d2d " + f.dailyLimit + "\u5143");

      const borderColor = (f.rank <= 3) ? scoreColor : "#e0e0e0";
      const rankBg = (f.rank <= 3) ? scoreColor : "#95a5a6";

      cards += "<div style=\"margin-bottom:12px;border:1px solid " + borderColor + ";border-radius:10px;overflow:hidden\">"
        + "<div style=\"background:" + rankBg + ";color:#fff;padding:10px 14px;display:flex;justify-content:space-between;align-items:center\">"
        + "<div style=\"font-size:15px;font-weight:700\">#" + f.rank + " " + esc(f.name) + "</div>"
        + "<div style=\"font-size:20px;font-weight:700\">" + safeNum(f.score, 0) + "\u5206</div>"
        + "</div>"
        + "<div style=\"padding:10px 14px;background:#fff\">"
        + "<div style=\"font-size:12px;color:#999;margin-bottom:6px\">" + f.code + " | " + esc(f.type || "-") + " | <span style=\"color:" + trendColor + "\">\u8d8b\u52bf:" + trendText + "</span></div>"
        + "<div style=\"font-size:13px;color:#333;line-height:1.8\">" + metrics.join(" | ") + "</div>"
        + "<div style=\"font-size:12px;color:#888;line-height:1.8\">" + row2.join(" | ") + "</div>"
        + "</div>"
        + "</div>";
    }
  }

  // Budget info
  const budgetInfo = result && result.budgetInfo ? result.budgetInfo : null;
  const oppLabel = budgetInfo ? budgetInfo.label : "\u5f85\u786e\u5b9a";
  let oppColor = "#f39c12";
  if (budgetInfo && budgetInfo.avgScore !== null && budgetInfo.avgScore !== undefined && !isNaN(budgetInfo.avgScore) && budgetInfo.avgScore >= 15) oppColor = "#27ae60";
  else if (budgetInfo && budgetInfo.avgScore !== null && budgetInfo.avgScore !== undefined && !isNaN(budgetInfo.avgScore) && budgetInfo.avgScore >= 12) oppColor = "#3498db";
  else if (budgetInfo && budgetInfo.avgScore !== null && budgetInfo.avgScore !== undefined && !isNaN(budgetInfo.avgScore) && budgetInfo.avgScore < 10) oppColor = "#e74c3c";

  // [fix] \u6682\u505c\u539f\u56e0\u900f\u660e\u5316: action \u975e BUY \u65f6\u5c55\u793a\u6682\u505c\u539f\u56e0\u4e0e\u4fe1\u53f7\u9a8c\u8bc1\u8fdb\u5ea6, \u4e0d\u518d\u201c\u83ab\u540d\u5176\u5999\u505c\u6b62\u8d2d\u4e70\u201d
  let pauseHtml = "";
  if (recPlan && !purchaseAllowed) {
    const reasonMap = {
      LIVE_DISABLED: "\u771f\u5b9e\u4e70\u5165\u5f00\u5173\u672a\u5f00\u542f\uff08\u9700\u914d\u7f6e RECOMMENDATION_LIVE_ENABLED=true\uff09",
      SIGNAL_WARMING_UP: "\u4fe1\u53f7\u9a8c\u8bc1\u4e2d\uff1a\u5386\u53f2\u9a8c\u8bc1\u8bb0\u5f55\u4e0d\u8db3\uff0c\u7cfb\u7edf\u53ea\u505a\u6a21\u62df\u8ddf\u8e2a\u4e0d\u4e0b\u771f\u5b9e\u4e70\u5165\u6307\u4ee4",
      SIGNAL_BREAKER: "\u4fe1\u53f7\u878d\u65ad\uff1a\u8fd1\u671f\u80dc\u7387/\u6536\u76ca\u4e0d\u8fbe\u6807",
      ACCEPTANCE_GATE: "\u56de\u6d4b\u9a8c\u6536\u672a\u901a\u8fc7",
      UNKNOWN_HOLDINGS: "\u5b58\u5728\u672a\u77e5\u6301\u4ed3\u57fa\u91d1",
      RISK_ANCHOR_DRAWDOWN_10: "\u7ec4\u5408\u56de\u64a4\u8d85\u8fc7\u5b89\u5168\u7ebf",
      RISK_ANCHOR_DRAWDOWN_15: "\u8fdb\u53d6\u578b\u7ec4\u5408\u56de\u64a4\u8d85\u8fc7\u5b89\u5168\u7ebf",
      PRIVATE_LEDGER_MISSING: "\u79c1\u6709\u8d26\u672c\u672a\u52a0\u8f7d",
      PRIVATE_LEDGER_INVALID: "\u79c1\u6709\u8d26\u672c\u6821\u9a8c\u5931\u8d25",
      DECISION_STATE_MISSING: "\u4e91\u7aef\u98ce\u9669\u8bbe\u7f6e\u672a\u52a0\u8f7d",
      DECISION_STATE_INVALID: "\u4e91\u7aef\u98ce\u9669\u8bbe\u7f6e\u6821\u9a8c\u5931\u8d25",
      DATA_ERROR: "\u6570\u636e\u9519\u8bef"
    };
    const reasons = (recPlan.pauseReasons || []).map(function (r) {
      return "\u2022 " + (reasonMap[r] || r);
    });
    const sh = recPlan.signalHealth || {};
    const matured = (sh.matured && sh.matured.count) || 0;
    const shadow = (sh.shadow && sh.shadow.count) || 0;
    const evidenceCount = Math.max(matured, shadow);
    // \u95e8\u69db\u4e0e lib/recommendation-engine.js evaluateSignalHealth \u7684 15 \u6761\u4fdd\u6301\u4e00\u81f4
    const progressStr = sh.status === "HEALTHY" ? "\u5df2\u8fbe\u6807" : ("\u9a8c\u8bc1\u4e2d " + evidenceCount + "/15 \u6761" + (sh.evidenceSource === "SHADOW" ? "\uff08\u5f53\u524d\u4ee5\u6a21\u62df\u8bb0\u5f55\u8ba1\u5165\uff09" : ""));
    if (reasons.length > 0) {
      pauseHtml = "<div style=\"margin-top:12px;padding:12px;background:#fff8e1;border-radius:10px;border-left:4px solid #f39c12\">"
        + "<div style=\"font-size:13px;font-weight:bold;margin-bottom:6px;color:#8a6d3b\">\u23f8 " + esc(actionLabels[action] || "\u4eca\u65e5\u6682\u505c\u4e70\u5165") + "\uff0c\u539f\u56e0\uff1a</div>"
        + "<div style=\"font-size:12px;line-height:1.8;color:#6d5a2a\">" + reasons.join("<br>") + "</div>"
        + "<div style=\"font-size:11px;line-height:1.6;color:#a08020;margin-top:6px\">\u4fe1\u53f7\u8fdb\u5ea6\uff1a" + progressStr + "</div>"
        + "</div>";
    }
  }

  let executionHtml = "";
  if (purchaseAllowed && executionRoutes.length > 0) {
    const routeRows = executionRoutes.map(function (route) {
      return "<div style=\"padding:4px 0\"><strong>" + esc(route.name || route.code) + "</strong> " +
        esc(route.code) + " " + Number(route.amount) + "\u5143</div>";
    }).join("");
    executionHtml = "<div style=\"margin:12px 0;padding:12px;background:#eef7ff;border-radius:10px;border-left:4px solid #3498db\">"
      + "<div style=\"font-size:13px;font-weight:bold;color:#245b82\">\u4eca\u65e5\u52a8\u4f5c\uff1a" + esc(actionLabels[action] || action) +
        "\uff08\u5408\u8ba1" + Number(budgetStr) + "\u5143\uff09</div>"
      + "<div style=\"font-size:12px;line-height:1.7;color:#234;margin-top:6px\">" + routeRows + "</div></div>";
  }

  // Daily brief section
  let briefSection = "";
  if (options.dailyBrief && options.dailyBrief.content && options.dailyBrief.content.length > 10) {
    const briefFormatted = esc(options.dailyBrief.content).replace(/\n/g, "<br>");
    briefSection = "<div style=\"margin-top:20px;padding:16px;background:linear-gradient(135deg,#e8f4fd 0%,#d1ecf9 100%);border-radius:10px;border-left:4px solid #3498db\">"
      + "<div style=\"font-size:14px;font-weight:bold;margin-bottom:10px;color:#2c3e50\">\ud83d\udcf0 \u4eca\u65e5\u65e9\u62a5</div>"
      + "<div style=\"font-size:13px;line-height:1.8;color:#34495e\">" + briefFormatted + "</div>"
      + "</div>";
  }

  // AI section
  // [fix] 不再丢弃以 [AI 开头的提示(解读被拒/暂不可用), 改为轻量提示样式, 让用户知道 AI 未产出的原因
  let aiSection = "";
  if (aiCommentary && aiCommentary.length > 10) {
    const aiFormatted = esc(aiCommentary).replace(/\n/g, "<br>");
    if (aiCommentary.startsWith("[AI")) {
      aiSection = "<div style=\"margin-top:20px;padding:12px;background:#f8f9fa;border-radius:10px;border-left:4px solid #95a5a6\">"
        + "<div style=\"font-size:13px;font-weight:bold;margin-bottom:6px;color:#7f8c8d\">\ud83e\udd16 AI\u51b3\u7b56\u62a5\u544a</div>"
        + "<div style=\"font-size:12px;line-height:1.8;color:#555\">" + aiFormatted + "</div>"
        + "</div>";
    } else {
      aiSection = "<div style=\"margin-top:20px;padding:16px;background:linear-gradient(135deg,#1a1a2e 0%,#16213e 50%,#0f3460 100%);border-radius:10px;color:#fff\">"
        + "<div style=\"font-size:14px;font-weight:bold;margin-bottom:10px\">\ud83e\udd16 AI\u51b3\u7b56\u62a5\u544a</div>"
        + "<div style=\"font-size:12px;line-height:1.8;opacity:0.95\">" + aiFormatted + "</div>"
        + "</div>";
    }
  }

  // Suspended
  let suspendedHtml = "";
  if (result && result.suspended && result.suspended.length > 0) {
    const suspList = result.suspended.map(function(s) {
      const r = s._purchaseRawStatus || (s.status === "suspended" ? "\u6682\u505c" : "\u9650\u989d0");
      return esc(s.name) + "(" + esc(r) + ")";
    }).join("\u3001");
    suspendedHtml = "<div style=\"margin-top:16px;padding:10px;background:#fff3cd;border-radius:8px;font-size:11px;color:#856404\">"
      + "<strong>\u8df3\u8fc7\uff08" + result.suspended.length + "\u53ea\uff09\uff1a</strong>" + suspList + "</div>";
  }

  // Fund changes section
  let changesHtml = "";
  if (result && result.fundChanges && result.fundChanges.length > 0) {
    const changesList = result.fundChanges.map(function(c) {
      return "<div style=\"padding:4px 0;border-bottom:1px solid rgba(255,255,255,0.1)\">\u26a0\ufe0f " + esc(c.message) + "</div>";
    }).join("");
    changesHtml = "<div style=\"margin-top:12px;padding:12px;background:linear-gradient(135deg,#e74c3c 0%,#c0392b 100%);border-radius:10px;color:#fff\">"
      + "<div style=\"font-size:13px;font-weight:bold;margin-bottom:8px\">\u26a0\ufe0f \u9650\u8d2d\u53d8\u5316</div>"
      + "<div style=\"font-size:12px;line-height:1.8\">" + changesList + "</div>"
      + "</div>";
  }

  // Risk section
  let riskHtml = "";
  if (result && result.risk) {
    const rk = result.risk;
    const healthColor = rk.healthScore >= 80 ? "#27ae60" : (rk.healthScore >= 60 ? "#f39c12" : "#e74c3c");
    riskHtml = "<div style=\"margin-top:12px;padding:12px;background:linear-gradient(135deg,#2c3e50 0%,#34495e 100%);border-radius:10px;color:#fff\">"
      + "<div style=\"font-size:13px;font-weight:bold;margin-bottom:8px\">\ud83d\udee1\ufe0f \u7ec4\u5408\u98ce\u9669</div>"
      + "<div style=\"display:flex;gap:8px;margin-bottom:8px\">"
      + "<div style=\"flex:1;text-align:center;padding:6px;background:rgba(255,255,255,0.15);border-radius:6px\">"
      + "<div style=\"font-size:10px;opacity:0.8\">\u5065\u5eb7\u5ea6</div>"
      + "<div style=\"font-size:18px;font-weight:bold;color:" + healthColor + "\">" + safeNum(rk.healthScore, "-") + "</div></div>"
      + "<div style=\"flex:1;text-align:center;padding:6px;background:rgba(255,255,255,0.15);border-radius:6px\">"
      + "<div style=\"font-size:10px;opacity:0.8\">\u590f\u666e</div>"
      + "<div style=\"font-size:16px;font-weight:bold\">" + safeNum(rk.portfolioSharpe, "-") + "</div></div>"
      + "<div style=\"flex:1;text-align:center;padding:6px;background:rgba(255,255,255,0.15);border-radius:6px\">"
      + "<div style=\"font-size:10px;opacity:0.8\">\u56de\u64a4</div>"
      + "<div style=\"font-size:16px;font-weight:bold;color:#e74c3c\">" + safeNum(rk.portfolioMaxDrawdown, "-") + "%</div></div>"
      + "</div>"
      + "<div style=\"font-size:11px;opacity:0.9\">" + esc(rk.concentration.dominantType) + " \u5360\u6bd4 " + safeNum(rk.concentration.dominantWeight, "-") + "%"
      + (rk.concentration.dominantWeight > 70 ? " <span style=\"color:#e74c3c\">\u26a0\u8fc7\u4e8e\u96c6\u4e2d</span>" : "") + "</div>"
      + "</div>";
  }

  // Alternatives section
  let altHtml = "";
  if (result && result.alternatives && result.alternatives.length > 0) {
    const altItems = result.alternatives.map(function(a) {
      const altNames = a.alternatives.map(function(alt) { return esc(alt.name); }).join("\u3001");
      return "<div style=\"padding:4px 0;border-bottom:1px solid rgba(255,255,255,0.1)\">"
        + "<strong>" + esc(a.fund.name) + "</strong> \u4e0d\u53ef\u4e70 \u2192 " + altNames
        + "</div>";
    }).join("");
    altHtml = "<div style=\"margin-top:12px;padding:12px;background:linear-gradient(135deg,#8e44ad 0%,#9b59b6 100%);border-radius:10px;color:#fff\">"
      + "<div style=\"font-size:13px;font-weight:bold;margin-bottom:8px\">\ud83d\udd04 \u66ff\u4ee3\u65b9\u6848</div>"
      + "<div style=\"font-size:12px;line-height:1.8\">" + altItems + "</div>"
      + "</div>";
  }

  // Buy hints section
  let buyHintsHtml = "";
  if (purchaseAllowed && executionRoutes.length > 0) {
    const routeCommands = executionRoutes.map(function (route) { return route.code + " " + Number(route.amount); });
    const quickCmd = "node index.js --quick-add \"" + routeCommands.join(", ") + "\"";
    buyHintsHtml = "<div style=\"margin-top:12px;padding:12px;background:linear-gradient(135deg,#16a085 0%,#1abc9c 100%);border-radius:10px;color:#fff\">"
      + "<div style=\"font-size:13px;font-weight:bold;margin-bottom:8px\">\ud83d\uded2 \u4eca\u65e5\u4e70\u5165\u6307\u5357</div>"
      + "<div style=\"font-size:12px;line-height:1.8;opacity:0.95\">"
      + "<div>\u6700\u7ec8\u8def\u7ebf: " + routeCommands.map(esc).join(", ") + "</div>"
      + "<div style=\"margin-top:6px;padding:8px;background:rgba(0,0,0,0.2);border-radius:6px;font-family:monospace;font-size:11px;word-break:break-all\">"
      + esc(quickCmd)
      + "</div>"
      + "<div style=\"margin-top:6px;font-size:10px;opacity:0.8\">\u547d\u4ee4\u4e2d\u7684\u57fa\u91d1\u548c\u91d1\u989d\u4e0e\u6700\u7ec8\u51b3\u7b56\u8def\u7ebf\u4e00\u81f4</div>"
      + "</div></div>";
  }

  // Build portfolio HTML BEFORE return
  let portfolioHtml = "";
  if (result && result.portfolio && !result.portfolio.empty && result.portfolio.summary) {
    const ps = result.portfolio.summary;
    const valuationComplete = ps.valuationComplete !== false;
    const pnlColor = !valuationComplete ? "rgba(255,255,255,0.8)" :
      ((ps.totalPnl !== null && ps.totalPnl !== undefined && !isNaN(ps.totalPnl) && ps.totalPnl >= 0) ? "#27ae60" : "#e74c3c");
    const pnlSign = valuationComplete && ps.totalPnl !== null && ps.totalPnl !== undefined && !isNaN(ps.totalPnl) && ps.totalPnl >= 0 ? "+" : "";
    portfolioHtml = "<div style=\"margin-bottom:16px;padding:12px;background:linear-gradient(135deg,#0a3d62 0%,#1e5f74 100%);border-radius:10px;color:#fff\">"
      + "<div style=\"font-size:13px;font-weight:bold;margin-bottom:8px\">\ud83d\udcb0 \u6211\u7684\u6301\u4ed3</div>"
      + "<div style=\"display:flex;gap:8px;margin-bottom:8px\">"
      + "<div style=\"flex:1;text-align:center;padding:6px;background:rgba(255,255,255,0.15);border-radius:6px\">"
      + "<div style=\"font-size:10px;opacity:0.8\">\u5df2\u786e\u8ba4\u6295\u5165</div>"
      + "<div style=\"font-size:16px;font-weight:bold\">" + safeNum(ps.totalInvested, "-") + "</div></div>"
      + "<div style=\"flex:1;text-align:center;padding:6px;background:rgba(255,255,255,0.15);border-radius:6px\">"
      + "<div style=\"font-size:10px;opacity:0.8\">\u5f53\u524d\u5e02\u503c</div>"
      + "<div style=\"font-size:16px;font-weight:bold\">" + safeNum(ps.totalValue, "-") + "</div></div>"
      + "<div style=\"flex:1;text-align:center;padding:6px;background:rgba(255,255,255,0.15);border-radius:6px\">"
      + "<div style=\"font-size:10px;opacity:0.8\">\u76c8\u4e8f</div>"
      + "<div style=\"font-size:16px;font-weight:bold;color:" + pnlColor + "\">" + pnlSign + safeNum(ps.totalPnl, "-") + "</div></div>"
      + "</div>";
    if (!valuationComplete) {
      portfolioHtml += "<div style=\"font-size:11px;color:#ffe7a3;margin-bottom:8px\">估值不完整：" +
        esc(formatValuationIssues(ps.valuationIssues, ps.missingValuationCodes)) + "；未计算组合市值与盈亏</div>";
    }
    if (Number(ps.pendingInvested) > 0) {
      portfolioHtml += "<div style=\"font-size:11px;color:#ffe7a3;margin-bottom:8px\">\u5f85\u786e\u8ba4 " +
        Number(ps.pendingInvested) + "\u5143\u672a\u8ba1\u5165\u5e02\u503c\u548c\u76c8\u4e8f</div>";
    }
    // 已实现盈亏
    if (ps.totalRealizedPnl && ps.totalRealizedPnl !== 0 && !isNaN(ps.totalRealizedPnl)) {
      const rPnlColor = ps.totalRealizedPnl >= 0 ? "#27ae60" : "#e74c3c";
      const rPnlSign = ps.totalRealizedPnl >= 0 ? "+" : "";
      portfolioHtml += "<div style=\"font-size:11px;color:rgba(255,255,255,0.8);margin-bottom:8px\">\u5df2\u5b9e\u73b0\u76c8\u4e8f: <span style=\"color:" + rPnlColor + "\">" + rPnlSign + ps.totalRealizedPnl + "\u5143</span></div>";
    }
    if (result.portfolio.holdings && result.portfolio.holdings.length > 0) {
      portfolioHtml += "<div style=\"font-size:11px;opacity:0.9;line-height:1.6\">";
      for (let hi = 0; hi < result.portfolio.holdings.length; hi++) {
        const h = result.portfolio.holdings[hi];
        const hHasPnl = h.pnl !== null && h.pnl !== undefined && !isNaN(h.pnl);
        const hPnlColor = !hHasPnl ? "#ffe7a3" : (h.pnl >= 0 ? "#27ae60" : "#e74c3c");
        const hPnlStr = hHasPnl
          ? ((h.pnl >= 0 ? "+" : "") + safeNum(h.pnlRate, "0") + "%")
          : String(h.valuationIssue || "NAV_MISSING");
        const confirmedAmount = h.confirmedAmount !== null && h.confirmedAmount !== undefined ? h.confirmedAmount : h.totalAmount;
        portfolioHtml += "<div>" + esc(h.name) + " " + (safeNum(confirmedAmount, "-") + "\u5143") + " <span style=\"color:" + hPnlColor + "\">" + hPnlStr + "</span></div>";
      }
      portfolioHtml += "</div>";
    }
    portfolioHtml += "</div>";
  }

  return "<!DOCTYPE html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"></head><body style=\"margin:0;padding:0;background:#f0f2f5\">"
    + "<div style=\"max-width:480px;margin:0 auto;padding:16px\">"
    + "<div style=\"background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08)\">"
    + "<div style=\"background:linear-gradient(135deg,#1a1a2e 0%,#16213e 50%,#0f3460 100%);padding:24px 20px;text-align:center\">"
    + "<div style=\"font-size:28px;margin-bottom:8px\">\ud83d\udcca</div>"
    + "<h1 style=\"margin:0;color:#fff;font-size:18px;font-weight:600\">QDII\u6295\u8d44\u6392\u540d</h1>"
    + "<p style=\"margin:6px 0 0;color:rgba(255,255,255,0.7);font-size:13px\">" + dateStr + "</p>"
    + "</div>"
    + "<div style=\"padding:16px\">"
    + portfolioHtml
    + "<div style=\"display:flex;gap:8px;margin-bottom:16px\">"
    + "<div style=\"flex:1;text-align:center;padding:10px;background:#f8f9fa;border-radius:8px\">"
    + "<div style=\"font-size:10px;color:#999\">\u53c2\u8003\u9884\u7b97</div>"
    + "<div style=\"font-size:18px;font-weight:bold;color:#2c3e50\">" + budgetStr + "</div></div>"
    + "<div style=\"flex:1;text-align:center;padding:10px;background:#f8f9fa;border-radius:8px\">"
    + "<div style=\"font-size:10px;color:#999\">\u673a\u4f1a\u8bc4\u7ea7</div>"
    + "<div style=\"font-size:13px;font-weight:bold;color:" + oppColor + "\">" + esc(oppLabel) + "</div></div>"
    + "</div>"
    + executionHtml
    + cards
    + "<div style=\"font-size:10px;color:#999;text-align:center;margin-top:8px\">\u6570\u636e\u6c60: " + esc(poolInfo) + " | \u91d1\u989d\u4ee5\u6700\u7ec8\u6267\u884c\u8def\u7ebf\u4e3a\u51c6</div>"
    + pauseHtml
    + suspendedHtml
    + changesHtml
    + riskHtml
    + altHtml
    + buyHintsHtml
    + briefSection
    + aiSection
    + "</div>"
    + "<div style=\"text-align:center;padding:12px;font-size:10px;color:#999\">QDII\u57fa\u91d1\u667a\u80fd\u6392\u540d\u7cfb\u7edf</div>"
    + "</div></body></html>";
}

function sendEmail(options, smtpConfig) {
  const transporter = createTransporter(smtpConfig);
  const mailOptions = {
    from: '"QDII Ranking" <' + smtpConfig.user + ">",
    to: options.to,
    subject: options.subject || "QDII Top Ranking",
    text: options.textContent,
    html: buildEmailHtml(options.textContent, options.aiCommentary, options.result, options)
  };
  return transporter.sendMail(mailOptions).then(function(info) {
    console.log("[mail] sent: " + info.messageId);
    return true;
  }).catch(function(err) {
    console.error("[mail] failed: " + err.message);
    return false;
  });
}

module.exports = { sendEmail: sendEmail, buildEmailHtml: buildEmailHtml };
