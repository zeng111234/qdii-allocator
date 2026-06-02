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
      { role: "system", content: "你是一个专业的量化基金投资分析师。你的任务是基于回测数据、历史表现和技术指标，给出精确的投资决策报告。你必须用数据说话，给出具体的胜率、预期收益、风险评级和置信度。输出必须包含结构化的数据指标，不要说空话套话。" },
      { role: "user", content: prompt }
    ],
    temperature: 0.3,
    max_tokens: 2048
  });
  return new Promise(function(resolve, reject) {
    var req = lib.request({
      hostname: url.hostname, port: url.port || (isHTTPS ? 443 : 80),
      path: url.pathname, method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + apiKey, "Content-Length": Buffer.byteLength(body) },
      timeout: 60000
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
            reject(new Error("Unexpected response"));
          }
        } catch(e) { reject(new Error("Parse error: " + e.message)); }
      });
    });
    req.on("error", reject);
    req.on("timeout", function() { req.destroy(); reject(new Error("LLM timeout (60s)")); });
    req.write(body);
    req.end();
  });
}

function generateCommentary(result, llmConfig) {
  var prompt = buildPrompt(result);
  return callLLM(prompt, llmConfig).then(function(text) {
    return text;
  }).catch(function(err) {
    console.error("[AI] error: " + err.message);
    return "";
  });
}

function buildPrompt(result) {
  var lines = [];
  lines.push("=== 投资决策分析请求 ===");
  lines.push("日期: " + result.date);
  lines.push("预算: " + result.budget + "元");
  lines.push("策略: " + result.strategyName);
  if (result.budgetInfo) {
    lines.push("机会评级: " + result.budgetInfo.label + " (TopN均分" + result.budgetInfo.avgScore + ")");
  }
  lines.push("");

  // 当前推荐方案详情
  if (result.allocations && result.allocations.length > 0) {
    lines.push("--- 今日推荐方案 ---");
    for (var i = 0; i < result.allocations.length; i++) {
      var f = result.allocations[i];
      var yearRet = f.yearReturn || "N/A";
      var maDev = f.indicators ? f.indicators.maDeviation : "N/A";
      var vol = f.indicators ? f.indicators.volatility : "N/A";
      var dd = f.indicators ? f.indicators.drawdown : "N/A";
      var chg5 = f.indicators ? f.indicators.recent5Change : "N/A";
      lines.push("[" + (i+1) + "] " + f.name + "(" + f.code + ")");
      lines.push("  得分: " + f.score + " | 买入: " + f.allocated + "元 | 限购: " + f.dailyLimit + "元 | 费率: " + f.feeRate + "%");
      lines.push("  1年收益: " + yearRet + "% | MA偏离: " + maDev + "% | 5日涨跌: " + chg5 + "% | 波动率: " + vol + "% | 回撤: " + dd + "%");
      if (f.reason) lines.push("  评分理由: " + f.reason);
    }
  }

  // 跳过的基金
  if (result.suspended && result.suspended.length > 0) {
    lines.push("");
    lines.push("--- 不可买的基金 (" + result.suspended.length + "只) ---");
    var suspNames = result.suspended.map(function(s) {
      var r = s._purchaseRawStatus || "暂停";
      return s.name + "(" + r + ")";
    });
    lines.push(suspNames.join("、"));
  }

  // 历史推荐记录（带实际收益）
  var histData = loadHistoryWithPerformance();
  if (histData) {
    lines.push("");
    lines.push(histData);
  }

  lines.push("");
  lines.push("--- 请输出以下结构化决策报告 ---");
  lines.push("【AI决策报告】");
  lines.push("1. 本次推荐胜率: X%（基于回测/历史统计）");
  lines.push("2. 预期5日收益: +X% ~ +X%");
  lines.push("3. 预期10日收益: +X% ~ +X%");
  lines.push("4. 最大回撤风险: -X%");
  lines.push("5. 风险评级: 低/中/高");
  lines.push("6. 置信度: 高/中/低（并说明原因）");
  lines.push("7. 策略评价: 这次推荐好不好，为什么");
  lines.push("8. 建议: 具体该怎么操作，是否需要调整投入金额");
  lines.push("9. 一句话总结");

  return lines.join("\n");
}

function loadHistoryWithPerformance() {
  try {
    if (!fs.existsSync(HISTORY_FILE)) return null;
    var data = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf-8"));
    if (!data.records || data.records.length === 0) return null;

    var records = data.records;
    var recent = records.slice(-10);
    var lines = ["--- 历史推荐表现 (最近" + recent.length + "次) ---"];

    var totalWin5d = 0, totalValid5d = 0, totalReturn5d = 0;
    var totalWin10d = 0, totalValid10d = 0, totalReturn10d = 0;

    for (var i = 0; i < recent.length; i++) {
      var rec = recent[i];
      if (!rec.allocations || rec.allocations.length === 0) continue;

      var allocs = rec.allocations.map(function(a) {
        var perf = "";
        if (a.followUp5dReturn !== null && a.followUp5dReturn !== undefined) {
          perf = "5日" + (a.followUp5dReturn >= 0 ? "+" : "") + a.followUp5dReturn + "%";
          totalValid5d++;
          totalReturn5d += a.followUp5dReturn;
          if (a.followUp5dReturn > 0) totalWin5d++;
        }
        if (a.followUp10dReturn !== null && a.followUp10dReturn !== undefined) {
          perf += " 10日" + (a.followUp10dReturn >= 0 ? "+" : "") + a.followUp10dReturn + "%";
          totalValid10d++;
          totalReturn10d += a.followUp10dReturn;
          if (a.followUp10dReturn > 0) totalWin10d++;
        }
        if (!perf) perf = "待验证";
        return a.name + "(" + a.allocated + "元 " + perf + ")";
      }).join("、");

      lines.push(rec.date + " | " + rec.totalAllocated + "元 | " + allocs);
    }

    // 汇总统计
    lines.push("");
    lines.push("--- 历史统计汇总 ---");
    if (totalValid5d > 0) {
      lines.push("5日胜率: " + Math.round(totalWin5d / totalValid5d * 100) + "% (" + totalWin5d + "/" + totalValid5d + ")");
      lines.push("5日平均收益: " + Math.round(totalReturn5d / totalValid5d * 100) / 100 + "%");
    }
    if (totalValid10d > 0) {
      lines.push("10日胜率: " + Math.round(totalWin10d / totalValid10d * 100) + "% (" + totalWin10d + "/" + totalValid10d + ")");
      lines.push("10日平均收益: " + Math.round(totalReturn10d / totalValid10d * 100) / 100 + "%");
    }

    // 最常推荐的基金
    var freq = {};
    for (var j = 0; j < records.length; j++) {
      var r = records[j];
      if (!r.allocations) continue;
      for (var k = 0; k < r.allocations.length; k++) {
        var a = r.allocations[k];
        freq[a.code] = (freq[a.code] || 0) + 1;
      }
    }
    var sorted = Object.entries(freq).sort(function(a,b) { return b[1] - a[1]; }).slice(0, 5);
    if (sorted.length > 0) {
      lines.push("最常推荐: " + sorted.map(function(e) { return e[0] + "(" + e[1] + "次)"; }).join("、"));
    }

    return lines.join("\n");
  } catch (err) {
    return null;
  }
}

module.exports = { generateCommentary: generateCommentary, callLLM: callLLM };