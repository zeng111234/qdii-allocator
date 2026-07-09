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

function buildEmailHtml(textContent, aiCommentary, result, options) {
  const dateStr = result ? result.date : new Date().toLocaleDateString("zh-CN",{timeZone:"Asia/Shanghai"});
  const budgetStr = result ? result.budget : "50";
  const _strategyStr = result ? result.strategyName : "";
  const poolInfo = result ? (result.totalPool + "\u53ea\u57fa\u91d1\uff0c" + result.allAvailable + "\u53ea\u6709\u6548") : "";

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
  let aiSection = "";
  if (aiCommentary && aiCommentary.length > 10 && !aiCommentary.startsWith("[AI")) {
    const aiFormatted = esc(aiCommentary).replace(/\n/g, "<br>");
    aiSection = "<div style=\"margin-top:20px;padding:16px;background:linear-gradient(135deg,#1a1a2e 0%,#16213e 50%,#0f3460 100%);border-radius:10px;color:#fff\">"
      + "<div style=\"font-size:14px;font-weight:bold;margin-bottom:10px\">\ud83e\udd16 AI\u51b3\u7b56\u62a5\u544a</div>"
      + "<div style=\"font-size:12px;line-height:1.8;opacity:0.95\">" + aiFormatted + "</div>"
      + "</div>";
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
  if (result && result.ranked && result.ranked.length > 0) {
    const topCodes = result.ranked.slice(0, 5).map(function(f) { return f.code; });
    const quickCmd = "node index.js --quick-add \"" + topCodes.map(function(c) { return c + " 10"; }).join(", ") + "\"";
    buyHintsHtml = "<div style=\"margin-top:12px;padding:12px;background:linear-gradient(135deg,#16a085 0%,#1abc9c 100%);border-radius:10px;color:#fff\">"
      + "<div style=\"font-size:13px;font-weight:bold;margin-bottom:8px\">\ud83d\uded2 \u4eca\u65e5\u4e70\u5165\u6307\u5357</div>"
      + "<div style=\"font-size:12px;line-height:1.8;opacity:0.95\">"
      + "<div>\u63a8\u8350\u57fa\u91d1\u4ee3\u7801: " + topCodes.join(", ") + "</div>"
      + "<div style=\"margin-top:6px;padding:8px;background:rgba(0,0,0,0.2);border-radius:6px;font-family:monospace;font-size:11px;word-break:break-all\">"
      + esc(quickCmd)
      + "</div>"
      + "<div style=\"margin-top:6px;font-size:10px;opacity:0.8\">\u590d\u5236\u4e0a\u9762\u547d\u4ee4\u5230\u7ec8\u7aef\u6267\u884c\uff0c\u6216\u4fee\u6539\u91d1\u989d</div>"
      + "</div></div>";
  }

  // Build portfolio HTML BEFORE return
  let portfolioHtml = "";
  if (result && result.portfolio && !result.portfolio.empty && result.portfolio.summary) {
    const ps = result.portfolio.summary;
    const pnlColor = (ps.totalPnl !== null && ps.totalPnl !== undefined && !isNaN(ps.totalPnl) && ps.totalPnl >= 0) ? "#27ae60" : "#e74c3c";
    const pnlSign = (ps.totalPnl !== null && ps.totalPnl !== undefined && !isNaN(ps.totalPnl) && ps.totalPnl >= 0) ? "+" : "";
    portfolioHtml = "<div style=\"margin-bottom:16px;padding:12px;background:linear-gradient(135deg,#0a3d62 0%,#1e5f74 100%);border-radius:10px;color:#fff\">"
      + "<div style=\"font-size:13px;font-weight:bold;margin-bottom:8px\">\ud83d\udcb0 \u6211\u7684\u6301\u4ed3</div>"
      + "<div style=\"display:flex;gap:8px;margin-bottom:8px\">"
      + "<div style=\"flex:1;text-align:center;padding:6px;background:rgba(255,255,255,0.15);border-radius:6px\">"
      + "<div style=\"font-size:10px;opacity:0.8\">\u603b\u6295\u5165</div>"
      + "<div style=\"font-size:16px;font-weight:bold\">" + safeNum(ps.totalInvested, "-") + "</div></div>"
      + "<div style=\"flex:1;text-align:center;padding:6px;background:rgba(255,255,255,0.15);border-radius:6px\">"
      + "<div style=\"font-size:10px;opacity:0.8\">\u5f53\u524d\u5e02\u503c</div>"
      + "<div style=\"font-size:16px;font-weight:bold\">" + safeNum(ps.totalValue, "-") + "</div></div>"
      + "<div style=\"flex:1;text-align:center;padding:6px;background:rgba(255,255,255,0.15);border-radius:6px\">"
      + "<div style=\"font-size:10px;opacity:0.8\">\u76c8\u4e8f</div>"
      + "<div style=\"font-size:16px;font-weight:bold;color:" + pnlColor + "\">" + pnlSign + safeNum(ps.totalPnl, "-") + "</div></div>"
      + "</div>";
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
        const hPnlColor = (h.pnl !== null && h.pnl !== undefined && !isNaN(h.pnl) && h.pnl >= 0) ? "#27ae60" : "#e74c3c";
        const hPnlStr = (h.pnl !== null && h.pnl !== undefined && !isNaN(h.pnl)) ? ((h.pnl >= 0 ? "+" : "") + safeNum(h.pnlRate, "0") + "%") : "-";
        portfolioHtml += "<div>" + esc(h.name) + " " + (safeNum(h.totalAmount, "-") + "\u5143") + " <span style=\"color:" + hPnlColor + "\">" + hPnlStr + "</span></div>";
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
    + cards
    + "<div style=\"font-size:10px;color:#999;text-align:center;margin-top:8px\">\u6570\u636e\u6c60: " + esc(poolInfo) + " | \u91d1\u989d\u81ea\u884c\u786e\u5b9a</div>"
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