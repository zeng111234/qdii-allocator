var https = require("https");
var http = require("http");
var fs = require("fs");
var path = require("path");

var HISTORY_FILE = path.join(__dirname, "..", "data", "history.json");

function callLLM(prompt, config) {
  var apiKey = config.apiKey, baseUrl = config.baseUrl, model = config.model;
  var url = new URL(baseUrl);
  var isHTTPS = url.protocol === "https:";
  var lib = isHTTPS ? https : http;
  var body = JSON.stringify({
    model: model,
    messages: [
      {
        role: "system",
        content: "你是一个专业的量化基金投资分析师，专注于A类基金的长期投资决策。你的核心任务：\n" +
          "1. 从候选基金中筛选出最值得长期持有的Top基金\n" +
          "2. 基于3年历史数据、年化收益率、夏普比率、最大回撤等量化指标做出决策\n" +
          "3. A类基金看长远，重点关注：年化收益稳定性、风险调整后收益（夏普比率）、长期趋势\n" +
          "4. 你必须用数据说话，给出具体的量化判断\n" +
          "5. 对于走势不好的基金要果断指出并建议降权或剔除"
      },
      { role: "user", content: prompt }
    ],
    temperature: 0.2,
    max_tokens: 3000
  });
  return new Promise(function(resolve, reject) {
    var req = lib.request({
      hostname: url.hostname, port: url.port || (isHTTPS ? 443 : 80),
      path: url.pathname, method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + apiKey, "Content-Length": Buffer.byteLength(body) },
      timeout: 120000
    }, function(res) {
      var data = "";
      res.on("data", function(chunk) { data += chunk; });
      res.on("end", function() {
        try {
          var json = JSON.parse(data);
          if (json.choices && json.choices[0]) {
            var msg = json.choices[0].message;
            var text = msg.content || msg.reasoning_content || "";
            if (text.length > 0) {
              resolve(text.trim());
            } else {
              reject(new Error("LLM returned empty content"));
            }
          } else if (json.error) {
            reject(new Error("LLM API error: " + (json.error.message || JSON.stringify(json.error))));
          } else {
            reject(new Error("Unexpected response: " + data.substring(0, 200)));
          }
        } catch(e) { reject(new Error("Parse error: " + e.message)); }
      });
    });
    req.on("error", reject);
    req.on("timeout", function() { req.destroy(); reject(new Error("LLM timeout (120s)")); });
    req.write(body);
    req.end();
  });
}

/**
 * AI两阶段决策：
 * 第一阶段：策略算法生成候选排名
 * 第二阶段：AI从候选中筛选最终推荐，可剔除走势不好的，可调整排名
 */
function generateCommentary(result, llmConfig) {
  var prompt = buildDecisionPrompt(result);
  return callLLM(prompt, llmConfig).then(function(text) {
    return text;
  }).catch(function(err) {
    console.error("[AI] error: " + err.message);
    return "[AI\u5206\u6790\u6682\u65f6\u4e0d\u53ef\u7528: " + err.message + "]";
  });
}

function buildDecisionPrompt(result) {
  var lines = [];
  lines.push("=== AI\u6295\u8d44\u51b3\u7b56\u8bf7\u6c42 ===");
  lines.push("\u65e5\u671f: " + result.date);
  lines.push("\u7b56\u7565: " + result.strategyName);
  lines.push("\u6570\u636e\u6c60: " + result.totalPool + "\u53ea\u57fa\u91d1\uff0c" + result.allAvailable + "\u53ea\u6709\u6548");
  if (result.budgetInfo) {
    lines.push("\u673a\u4f1a\u8bc4\u7ea7: " + result.budgetInfo.label + " (\u5747\u5206" + result.budgetInfo.avgScore + ")");
  }
  lines.push("");

  // 实时市场数据
  if (result.marketSnapshot && result.marketSnapshot.length > 0) {
    lines.push("--- \u5b9e\u65f6\u5e02\u573a\u6570\u636e ---");
    for (var s = 0; s < result.marketSnapshot.length; s++) {
      var m = result.marketSnapshot[s];
      lines.push(m.name + ": " + m.price + " (" + (m.change >= 0 ? "+" : "") + m.change + "%)");
    }
    lines.push("");
  }

  // 财经新闻
  if (result.marketNews && result.marketNews.length > 0) {
    lines.push("--- \u6700\u65b0\u8d22\u7ecf\u5feb\u8baf ---");
    for (var n = 0; n < result.marketNews.length; n++) {
      var news = result.marketNews[n];
      lines.push("- " + news.title + (news.digest ? ": " + news.digest : ""));
    }
    lines.push("");
  }

  // 全部有效基金排名（供AI参考补位）
  if (result.allRanked && result.allRanked.length > 0) {
    lines.push("--- \u5168\u90e8\u6709\u6548\u57fa\u91d1\u6392\u540d (" + result.allRanked.length + "\u53ea) ---");
    lines.push("\u8bf4\u660e\uff1a\u4ee5\u4e0b\u662f\u5168\u90e8\u6709\u6548\u57fa\u91d1\u7684\u5b8c\u6574\u6392\u540d\uff0c\u4f60\u53ef\u4ee5\u4ece\u4e2d\u9009\u62e9\u8865\u5145Top10");
    for (var ar = 0; ar < result.allRanked.length; ar++) {
      var af = result.allRanked[ar];
      var lim = af.dailyLimit <= 10 ? "\u2b50\u9650\u8d2d" + af.dailyLimit : (af._purchaseStatus === "limited" ? "\u9650\u8d2d" + af.dailyLimit : "");
      lines.push(af.rank + ". " + af.name + "(" + af.code + ") \u5f97\u5206:" + af.score + " 1\u5e74:" + (af.yearReturn || "N/A") + "% \u590f\u666e:" + (af.sharpeRatio || "N/A") + " \u56de\u64a4:" + (af.maxDrawdown || "N/A") + "% " + lim);
    }
    lines.push("");
  }

  // 算法推荐的Top排名
  if (result.ranked && result.ranked.length > 0) {
    lines.push("--- \u7b56\u7565\u7b97\u6cd5\u6392\u540d Top" + result.ranked.length + " ---");
    for (var i = 0; i < result.ranked.length; i++) {
      var f = result.ranked[i];
      var ind = f.indicators || {};
      lines.push("[" + f.rank + "] " + f.name + "(" + f.code + ") " + (f.type || ""));
      lines.push("  \u5f97\u5206: " + f.score + " | \u9650\u8d2d: " + (f.dailyLimit || "-") + "\u5143 | \u8d39\u7387: " + (f.feeRate || "-") + "%");
      if (ind.annualizedReturn !== null) {
        lines.push("  \u5e74\u5316: " + ind.annualizedReturn + "% | 3\u5e74: " + (ind.threeYearReturn || "N/A") + "% | \u590f\u666e: " + (ind.sharpeRatio || "N/A") + " | \u6700\u5927\u56de\u64a4: " + (ind.maxDrawdown || "N/A") + "%");
        lines.push("  1\u5e74: " + (ind.yearReturn || "N/A") + "% | 5\u65e5: " + (ind.recent5Change || "N/A") + "% | \u6ce2\u52a8: " + (ind.volatility || "N/A") + "% | \u8d8b\u52bf: " + (ind.longTermTrend || "N/A"));
      } else {
        lines.push("  \u6570\u636e: " + (ind.dataPoints || 0) + "\u4e2a\u4ea4\u6613\u65e5");
      }
      if (f.reason) lines.push("  \u8bc4\u5206\u7406\u7531: " + f.reason);
      lines.push("");
    }
  }

  // 跳过的基金
  if (result.suspended && result.suspended.length > 0) {
    lines.push("--- \u4e0d\u53ef\u4e70\u7684\u57fa\u91d1 (" + result.suspended.length + "\u53ea) ---");
    var suspNames = result.suspended.map(function(s) {
      var r = s._purchaseRawStatus || "\u6682\u505c";
      return s.name + "(" + r + ")";
    });
    lines.push(suspNames.join("\u3001"));
    lines.push("");
  }

  // 历史推荐记录
  var histData = loadHistoryWithPerformance();
  if (histData) {
    lines.push(histData);
    lines.push("");
  }

  // AI决策指令
  lines.push("--- \u8bf7\u6267\u884c\u4ee5\u4e0b\u5206\u6790\u5e76\u8f93\u51fa\u7ed3\u679c ---");
  lines.push("");
  lines.push("\u3010AI\u6295\u8d44\u51b3\u7b56\u62a5\u544a\u3011");
  lines.push("");
  lines.push("1. \u6574\u4f53\u5e02\u573a\u73b0\u72b6\u8bc4\u4f30\uff08\u4e00\u53e5\u8bdd\uff09");
  lines.push("");
  lines.push("2. \u5355\u53ea\u57fa\u91d1\u5ba1\u6838\uff08\u5bf9\u6bcf\u53ea\u6392\u540d\u57fa\u91d1\u505a\u51fa\u5224\u65ad\uff09\uff1a");
  lines.push("   \u5bf9\u6bcf\u53ea\u57fa\u91d1\u8f93\u51fa\uff1a");
  lines.push("   - \u957f\u671f\u5224\u65ad: \u770b\u597d/\u4e2d\u6027/\u770b\u6de1");
  lines.push("   - \u5efa\u8bae\u64cd\u4f5c: \u63a8\u8350\u4e70\u5165/\u53ef\u4ee5\u89c2\u671b/\u5efa\u8bae\u907f\u5f00");
  lines.push("   - \u5efa\u8bae\u7406\u7531: \u5177\u4f53\u6570\u636e\u4f9d\u636e");
  lines.push("");
  lines.push("3. \u6700\u7ec8\u63a8\u8350\u6392\u540d\uff08\u4f60\u53ef\u4ee5\u8c03\u6574\u7b97\u6cd5\u7684\u6392\u540d\uff09\uff1a");
  lines.push("   \u8bf7\u5217\u51fa\u4f60\u8ba4\u4e3a\u6700\u503c\u5f97\u957f\u671f\u6301\u6709\u7684\u524d10\u53ea\uff0c\u53ef\u4ee5\u8c03\u6574\u987a\u5e8f\uff0c\u4e5f\u53ef\u4ee5\u5254\u9664\u4e0d\u597d\u7684\u5e76\u8865\u5145\u5176\u4ed6\u57fa\u91d1");
  lines.push("   \u8f93\u51fa\u683c\u5f0f: [\u6392\u540d] \u57fa\u91d1\u540d\u79f0(\u4ee3\u7801) - \u5efa\u8bae\u64cd\u4f5c - \u4e00\u53e5\u8bdd\u7406\u7531");
  lines.push("");
  lines.push("4. \u53c2\u8003\u5b9a\u6295\u5efa\u8bae\uff1a\u6839\u636e\u673a\u4f1a\u8bc4\u7ea7\u548c\u57fa\u91d1\u8d28\u91cf\uff0c\u5efa\u8bae\u6bcf\u65e5\u6295\u5165\u591a\u5c11\u5143\uff0c\u4ee5\u53ca\u5206\u914d\u6bd4\u4f8b");
  lines.push("");
  lines.push("5. \u98ce\u9669\u63d0\u793a\uff08\u6709\u5219\u5199\uff09");
  lines.push("");
  lines.push("6. \u4e00\u53e5\u8bdd\u603b\u7ed3");

  return lines.join("\n");
}

function loadHistoryWithPerformance() {
  try {
    if (!fs.existsSync(HISTORY_FILE)) return null;
    var data = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf-8"));
    if (!data.records || data.records.length === 0) return null;

    var records = data.records;
    var recent = records.slice(-10);
    var lines = ["--- \u5386\u53f2\u63a8\u8350\u8868\u73b0 (\u6700\u8fd1" + recent.length + "\u6b21) ---"];

    var totalWin5d = 0, totalValid5d = 0, totalReturn5d = 0;
    var totalWin10d = 0, totalValid10d = 0, totalReturn10d = 0;

    for (var i = 0; i < recent.length; i++) {
      var rec = recent[i];
      var allocs = rec.allocations || rec.ranked || [];
      if (allocs.length === 0) continue;

      var allocStr = allocs.map(function(a) {
        var perf = "";
        if (a.followUp5dReturn !== null && a.followUp5dReturn !== undefined) {
          perf = "5\u65e5" + (a.followUp5dReturn >= 0 ? "+" : "") + a.followUp5dReturn + "%";
          totalValid5d++;
          totalReturn5d += a.followUp5dReturn;
          if (a.followUp5dReturn > 0) totalWin5d++;
        }
        if (a.followUp10dReturn !== null && a.followUp10dReturn !== undefined) {
          perf += " 10\u65e5" + (a.followUp10dReturn >= 0 ? "+" : "") + a.followUp10dReturn + "%";
          totalValid10d++;
          totalReturn10d += a.followUp10dReturn;
          if (a.followUp10dReturn > 0) totalWin10d++;
        }
        if (!perf) perf = "\u5f85\u9a8c\u8bc1";
        return a.name + "(" + perf + ")";
      }).join("\u3001");

      lines.push(rec.date + " | " + (rec.totalRanked || allocs.length) + "\u53ea | " + allocStr);
    }

    lines.push("");
    lines.push("--- \u5386\u53f2\u7edf\u8ba1\u6c47\u603b ---");
    if (totalValid5d > 0) {
      lines.push("5\u65e5\u80dc\u7387: " + Math.round(totalWin5d / totalValid5d * 100) + "% (" + totalWin5d + "/" + totalValid5d + ")");
      lines.push("5\u65e5\u5e73\u5747\u6536\u76ca: " + Math.round(totalReturn5d / totalValid5d * 100) / 100 + "%");
    }
    if (totalValid10d > 0) {
      lines.push("10\u65e5\u80dc\u7387: " + Math.round(totalWin10d / totalValid10d * 100) + "% (" + totalWin10d + "/" + totalValid10d + ")");
      lines.push("10\u65e5\u5e73\u5747\u6536\u76ca: " + Math.round(totalReturn10d / totalValid10d * 100) / 100 + "%");
    }

    // 最常推荐的基金
    var freq = {};
    for (var j = 0; j < records.length; j++) {
      var r = records[j];
      var aList = r.allocations || r.ranked || [];
      for (var k = 0; k < aList.length; k++) {
        var a = aList[k];
        freq[a.code] = (freq[a.code] || 0) + 1;
      }
    }
    var sorted = Object.entries(freq).sort(function(a,b) { return b[1] - a[1]; }).slice(0, 5);
    if (sorted.length > 0) {
      lines.push("\u6700\u5e38\u63a8\u8350: " + sorted.map(function(e) { return e[0] + "(" + e[1] + "\u6b21)"; }).join("\u3001"));
    }

    return lines.join("\n");
  } catch (err) {
    return null;
  }
}

module.exports = { generateCommentary: generateCommentary, callLLM: callLLM };