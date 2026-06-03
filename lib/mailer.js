var nodemailer = require("nodemailer");

function createTransporter(config) {
  return nodemailer.createTransport({
    host: config.host, port: config.port,
    secure: config.port === 465,
    auth: { user: config.user, pass: config.pass },
    tls: { rejectUnauthorized: false },
    dns: function(hostname, cb) { 
      require("dns").lookup(hostname, { family: 4 }, cb); 
    }
  });
}

function esc(s) {
  if (!s) return "";
  var amp = String.fromCharCode(38) + "amp;";
  var lt = String.fromCharCode(38) + "lt;";
  var gt = String.fromCharCode(38) + "gt;";
  var quot = String.fromCharCode(38) + "quot;";
  return String(s).replace(/&/g, amp).replace(/</g, lt).replace(/>/g, gt).replace(/"/g, quot);
}

function buildEmailHtml(textContent, aiCommentary, result) {
  var dateStr = result ? result.date : new Date().toLocaleDateString("zh-CN",{timeZone:"Asia/Shanghai"});
  var budgetStr = result ? result.budget : "50";
  var strategyStr = result ? result.strategyName : "";
  var poolInfo = result ? (result.totalPool + "\u53ea\u57fa\u91d1\uff0c" + result.allAvailable + "\u53ea\u6709\u6548") : "";

  // Build ranked cards
  var cards = "";
  if (result && result.ranked && result.ranked.length > 0) {
    for (var i = 0; i < result.ranked.length; i++) {
      var f = result.ranked[i];
      var ind = f.indicators || {};

      // Trend
      var trendColor = "#f39c12";
      var trendText = "\u2500";
      if (ind.longTermTrend === "bull") { trendColor = "#27ae60"; trendText = "\u2191\u725b"; }
      else if (ind.longTermTrend === "bear") { trendColor = "#e74c3c"; trendText = "\u2193\u718a"; }
      else if (ind.longTermTrend === "neutral") { trendColor = "#f39c12"; trendText = "=\u4e2d"; }

      // Score color
      var scoreColor = f.score >= 20 ? "#27ae60" : (f.score >= 10 ? "#3498db" : "#f39c12");

      // Metrics row
      var metrics = [];
      if (ind.annualizedReturn !== null) metrics.push("\u5e74\u5316 " + ind.annualizedReturn + "%");
      if (ind.threeYearReturn !== null) metrics.push("3\u5e74 " + ind.threeYearReturn + "%");
      if (ind.sharpeRatio !== null) metrics.push("\u590f\u666e " + ind.sharpeRatio);
      if (ind.maxDrawdown !== null) metrics.push("\u56de\u64a4 " + ind.maxDrawdown + "%");

      // Row 2
      var row2 = [];
      if (ind.recent5Change !== undefined) row2.push("5\u65e5 " + (ind.recent5Change >= 0 ? "+" : "") + ind.recent5Change + "%");
      if (ind.maDeviation !== undefined) row2.push("MA\u504f\u79bb " + ind.maDeviation + "%");
      if (ind.volatility !== undefined) row2.push("\u6ce2\u52a8 " + ind.volatility + "%");
      if (f.dailyLimit) row2.push("\u9650\u8d2d " + f.dailyLimit + "\u5143");

      var borderColor = (f.rank <= 3) ? scoreColor : "#e0e0e0";
      var rankBg = (f.rank <= 3) ? scoreColor : "#95a5a6";

      cards += "<div style=\"margin-bottom:12px;border:1px solid " + borderColor + ";border-radius:10px;overflow:hidden\">"
        + "<div style=\"background:" + rankBg + ";color:#fff;padding:10px 14px;display:flex;justify-content:space-between;align-items:center\">"
        + "<div style=\"font-size:15px;font-weight:700\">#" + f.rank + " " + esc(f.name) + "</div>"
        + "<div style=\"font-size:20px;font-weight:700\">" + f.score + "\u5206</div>"
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
  var budgetInfo = result && result.budgetInfo ? result.budgetInfo : null;
  var oppLabel = budgetInfo ? budgetInfo.label : "\u5f85\u786e\u5b9a";
  var oppColor = "#f39c12";
  if (budgetInfo && budgetInfo.avgScore >= 15) oppColor = "#27ae60";
  else if (budgetInfo && budgetInfo.avgScore >= 12) oppColor = "#3498db";
  else if (budgetInfo && budgetInfo.avgScore < 10) oppColor = "#e74c3c";

  // AI section
  var aiSection = "";
  if (aiCommentary && aiCommentary.length > 10 && !aiCommentary.startsWith("[AI")) {
    var aiFormatted = esc(aiCommentary).replace(/\n/g, "<br>");
    aiSection = "<div style=\"margin-top:20px;padding:16px;background:linear-gradient(135deg,#1a1a2e 0%,#16213e 50%,#0f3460 100%);border-radius:10px;color:#fff\">"
      + "<div style=\"font-size:14px;font-weight:bold;margin-bottom:10px\">\ud83e\udd16 AI\u51b3\u7b56\u62a5\u544a</div>"
      + "<div style=\"font-size:12px;line-height:1.8;opacity:0.95\">" + aiFormatted + "</div>"
      + "</div>";
  }

  // Suspended
  var suspendedHtml = "";
  if (result && result.suspended && result.suspended.length > 0) {
    var suspList = result.suspended.map(function(s) {
      var r = s._purchaseRawStatus || (s.status === "suspended" ? "\u6682\u505c" : "\u9650\u989d0");
      return esc(s.name) + "(" + esc(r) + ")";
    }).join("\u3001");
    suspendedHtml = "<div style=\"margin-top:16px;padding:10px;background:#fff3cd;border-radius:8px;font-size:11px;color:#856404\">"
      + "<strong>\u8df3\u8fc7\uff08" + result.suspended.length + "\u53ea\uff09\uff1a</strong>" + suspList + "</div>";
  }

  return "<!DOCTYPE html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"></head><body style=\"margin:0;padding:0;background:#f0f2f5\">"
    + "<div style=\"max-width:480px;margin:0 auto;padding:16px\">"
    + "<div style=\"background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08)\">"
    // Header
    + "<div style=\"background:linear-gradient(135deg,#1a1a2e 0%,#16213e 50%,#0f3460 100%);padding:24px 20px;text-align:center\">"
    + "<div style=\"font-size:28px;margin-bottom:8px\">\ud83d\udcca</div>"
    + "<h1 style=\"margin:0;color:#fff;font-size:18px;font-weight:600\">QDII\u6295\u8d44\u6392\u540d</h1>"
    + "<p style=\"margin:6px 0 0;color:rgba(255,255,255,0.7);font-size:13px\">" + dateStr + "</p>"
    + "</div>"
    + "<div style=\"padding:16px\">"
    // Stats
    + "<div style=\"display:flex;gap:8px;margin-bottom:16px\">"
    + "<div style=\"flex:1;text-align:center;padding:10px;background:#f8f9fa;border-radius:8px\">"
    + "<div style=\"font-size:10px;color:#999\">\u53c2\u8003\u9884\u7b97</div>"
    + "<div style=\"font-size:18px;font-weight:bold;color:#2c3e50\">" + budgetStr + "</div></div>"
    + "<div style=\"flex:1;text-align:center;padding:10px;background:#f8f9fa;border-radius:8px\">"
    + "<div style=\"font-size:10px;color:#999\">\u673a\u4f1a\u8bc4\u7ea7</div>"
    + "<div style=\"font-size:13px;font-weight:bold;color:" + oppColor + "\">" + esc(oppLabel) + "</div></div>"
    + "</div>"
    // Cards
    + cards
    // Pool info
    + "<div style=\"font-size:10px;color:#999;text-align:center;margin-top:8px\">\u6570\u636e\u6c60: " + esc(poolInfo) + " | \u91d1\u989d\u81ea\u884c\u786e\u5b9a</div>"
    + suspendedHtml
    + aiSection
    + "</div>"
    + "<div style=\"text-align:center;padding:12px;font-size:10px;color:#999\">QDII\u57fa\u91d1\u667a\u80fd\u6392\u540d\u7cfb\u7edf</div>"
    + "</div></body></html>";
}

function sendEmail(options, smtpConfig) {
  var transporter = createTransporter(smtpConfig);
  var mailOptions = {
    from: '"QDII Ranking" <' + smtpConfig.user + ">",
    to: options.to,
    subject: options.subject || "QDII Top Ranking",
    text: options.textContent,
    html: buildEmailHtml(options.textContent, options.aiCommentary, options.result)
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