var nodemailer = require("nodemailer");

function createTransporter(config) {
  return nodemailer.createTransport({
    host: config.host, port: config.port,
    secure: config.port === 465,
    auth: { user: config.user, pass: config.pass }
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

  // Build ranked rows
  var rows = "";
  if (result && result.ranked && result.ranked.length > 0) {
    for (var i = 0; i < result.ranked.length; i++) {
      var f = result.ranked[i];
      var ind = f.indicators || {};

      // Trend indicator
      var trendColor = "#f39c12";
      var trendText = "\u2500";
      if (ind.longTermTrend === "bull") { trendColor = "#27ae60"; trendText = "\u2191 \u725b"; }
      else if (ind.longTermTrend === "bear") { trendColor = "#e74c3c"; trendText = "\u2193 \u718a"; }
      else if (ind.longTermTrend === "neutral") { trendColor = "#f39c12"; trendText = "= \u4e2d"; }

      // Annualized return
      var annStr = ind.annualizedReturn !== null ? ind.annualizedReturn + "%" : "N/A";
      var annColor = (ind.annualizedReturn && ind.annualizedReturn > 0) ? "#27ae60" : "#e74c3c";

      // Sharpe ratio
      var sharpeStr = ind.sharpeRatio !== null ? String(ind.sharpeRatio) : "N/A";
      var sharpeColor = (ind.sharpeRatio && ind.sharpeRatio > 0.5) ? "#27ae60" : ((ind.sharpeRatio && ind.sharpeRatio < 0) ? "#e74c3c" : "#f39c12");

      // Max drawdown
      var ddStr = ind.maxDrawdown !== null ? ind.maxDrawdown + "%" : "N/A";

      // Score bar (visual)
      var scoreWidth = Math.min(100, Math.round(f.score * 3));
      var scoreColor = f.score >= 15 ? "#27ae60" : (f.score >= 10 ? "#3498db" : (f.score >= 5 ? "#f39c12" : "#e74c3c"));

      rows += "<tr style=\"border-bottom:1px solid #eee\">"
        + "<td style=\"padding:12px 10px;text-align:center;font-weight:bold;font-size:18px;color:#2c3e50\">" + f.rank + "</td>"
        + "<td style=\"padding:12px 10px\">"
        + "<div style=\"font-size:14px;font-weight:600;color:#2c3e50\">" + esc(f.name) + "</div>"
        + "<div style=\"font-size:12px;color:#999;margin-top:2px\">" + f.code + " | " + esc(f.type || "-") + " | \u9650\u8d2d" + (f.dailyLimit || "-") + "\u5143</div>"
        + "</td>"
        + "<td style=\"padding:12px 10px;text-align:center\">"
        + "<div style=\"font-size:16px;font-weight:bold;color:" + scoreColor + "\">" + f.score + "</div>"
        + "<div style=\"background:#eee;border-radius:4px;height:4px;margin-top:4px\"><div style=\"background:" + scoreColor + ";border-radius:4px;height:4px;width:" + scoreWidth + "%\"></div></div>"
        + "</td>"
        + "<td style=\"padding:12px 10px;text-align:center;font-size:13px;color:" + trendColor + "\">" + trendText + "</td>"
        + "<td style=\"padding:12px 10px;text-align:center;font-size:13px;color:" + annColor + ";font-weight:bold\">" + annStr + "</td>"
        + "<td style=\"padding:12px 10px;text-align:center;font-size:13px;color:" + sharpeColor + "\">" + sharpeStr + "</td>"
        + "<td style=\"padding:12px 10px;text-align:center;font-size:13px;color:#666\">" + ddStr + "</td>"
        + "</tr>";
    }
  }

  var budgetInfo = result && result.budgetInfo ? result.budgetInfo : null;
  var oppLabel = budgetInfo ? budgetInfo.label : "\u5f85\u786e\u5b9a";
  var oppAvgScore = budgetInfo ? budgetInfo.avgScore : 0;
  var oppColor = "#f39c12";
  if (oppAvgScore >= 15) oppColor = "#27ae60";
  else if (oppAvgScore >= 12) oppColor = "#3498db";
  else if (oppAvgScore >= 10) oppColor = "#f39c12";
  else oppColor = "#e74c3c";

  // AI section
  var aiSection = "";
  if (aiCommentary && aiCommentary.length > 10 && !aiCommentary.startsWith("[AI")) {
    // Format AI text with line breaks
    var aiFormatted = esc(aiCommentary).replace(/\n/g, "<br>");
    aiSection = "<div style=\"margin-top:24px;padding:20px;background:linear-gradient(135deg,#1a1a2e 0%,#16213e 50%,#0f3460 100%);border-radius:12px;color:#fff\">"
      + "<div style=\"font-size:15px;font-weight:bold;margin-bottom:12px\">\ud83e\udd16 AI\u6295\u8d44\u51b3\u7b56\u62a5\u544a</div>"
      + "<div style=\"margin:0;line-height:1.8;font-size:13px;opacity:0.95\">" + aiFormatted + "</div>"
      + "</div>";
  }

  // Suspended info
  var suspendedHtml = "";
  if (result && result.suspended && result.suspended.length > 0) {
    var suspList = result.suspended.map(function(s) {
      var r = s._purchaseRawStatus || (s.status === "suspended" ? "\u6682\u505c" : "\u9650\u989d0");
      return esc(s.name) + "(" + esc(r) + ")";
    }).join("\u3001");
    suspendedHtml = "<div style=\"margin-top:16px;padding:12px;background:#fff3cd;border-radius:8px;font-size:12px;color:#856404\">"
      + "<strong>\u4eca\u65e5\u8df3\u8fc7\uff08" + result.suspended.length + "\u53ea\uff09\uff1a</strong>" + suspList + "</div>";
  }

  return "<!DOCTYPE html><html><head><meta charset=\"utf-8\"></head><body style=\"margin:0;padding:0;background:#f0f2f5\">"
    + "<div style=\"max-width:680px;margin:0 auto;padding:20px\">"
    + "<div style=\"background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08)\">"
    // Header
    + "<div style=\"background:linear-gradient(135deg,#1a1a2e 0%,#16213e 50%,#0f3460 100%);padding:28px 24px;text-align:center\">"
    + "<div style=\"font-size:28px;margin-bottom:8px\">\ud83d\udcca</div>"
    + "<h1 style=\"margin:0;color:#fff;font-size:20px;font-weight:600\">QDII\u6295\u8d44\u6392\u540d\u62a5\u544a</h1>"
    + "<p style=\"margin:8px 0 0;color:rgba(255,255,255,0.7);font-size:14px\">" + dateStr + "</p>"
    + "</div>"
    + "<div style=\"padding:24px\">"
    // Stats cards
    + "<div style=\"display:flex;justify-content:space-between;margin-bottom:20px;flex-wrap:wrap\">"
    + "<div style=\"text-align:center;flex:1;padding:12px;background:#f8f9fa;border-radius:10px;margin:4px\">"
    + "<div style=\"font-size:11px;color:#999\">\u53c2\u8003\u9884\u7b97</div>"
    + "<div style=\"font-size:22px;font-weight:bold;color:#2c3e50\">" + budgetStr + "\u5143</div></div>"
    + "<div style=\"text-align:center;flex:1;padding:12px;background:#f8f9fa;border-radius:10px;margin:4px\">"
    + "<div style=\"font-size:11px;color:#999\">\u673a\u4f1a\u8bc4\u7ea7</div>"
    + "<div style=\"font-size:14px;font-weight:bold;color:" + oppColor + "\">" + esc(oppLabel) + "<br><span style=\"font-size:11px\">\u5747\u5206" + oppAvgScore + "</span></div></div>"
    + "<div style=\"text-align:center;flex:1;padding:12px;background:#f8f9fa;border-radius:10px;margin:4px\">"
    + "<div style=\"font-size:11px;color:#999\">\u6570\u636e\u8303\u56f4</div>"
    + "<div style=\"font-size:14px;font-weight:bold;color:#2c3e50\">\u7ea63\u5e74</div></div>"
    + "</div>"
    // Table
    + "<div style=\"overflow-x:auto\">"
    + "<table style=\"width:100%;border-collapse:collapse;margin:16px 0;font-size:13px\">"
    + "<tr style=\"background:#f8f9fa\">"
    + "<th style=\"padding:10px 8px;text-align:center;font-size:12px;color:#666;width:40px\">#</th>"
    + "<th style=\"padding:10px 8px;text-align:left;font-size:12px;color:#666\">\u57fa\u91d1</th>"
    + "<th style=\"padding:10px 8px;text-align:center;font-size:12px;color:#666;width:70px\">\u5f97\u5206</th>"
    + "<th style=\"padding:10px 8px;text-align:center;font-size:12px;color:#666;width:50px\">\u8d8b\u52bf</th>"
    + "<th style=\"padding:10px 8px;text-align:center;font-size:12px;color:#666;width:70px\">\u5e74\u5316</th>"
    + "<th style=\"padding:10px 8px;text-align:center;font-size:12px;color:#666;width:55px\">\u590f\u666e</th>"
    + "<th style=\"padding:10px 8px;text-align:center;font-size:12px;color:#666;width:65px\">\u56de\u64a4</th>"
    + "</tr>"
    + rows
    + "</table></div>"
    // Pool info
    + "<div style=\"font-size:11px;color:#999;text-align:center;margin-top:8px\">\u6570\u636e\u6c60: " + esc(poolInfo) + " | \u5f97\u5206\u8d8a\u9ad8=\u957f\u671f\u6536\u76ca\u8d8a\u597d+\u98ce\u9669\u8c03\u6574\u8d8a\u4f18</div>"
    + suspendedHtml
    + aiSection
    + "</div>"
    + "<div style=\"text-align:center;padding:16px;font-size:12px;color:#999\">\u6b64\u90ae\u4ef6\u7531 QDII\u57fa\u91d1\u667a\u80fd\u6392\u540d\u7cfb\u7edf \u81ea\u52a8\u751f\u6210 | \u91d1\u989d\u81ea\u884c\u786e\u5b9a</div>"
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