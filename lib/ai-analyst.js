const fs = require("fs");
const path = require("path");
const grounding = require("./grounding");
const { round2 } = require("./utils");

const HISTORY_FILE = path.join(__dirname, "..", "data", "history.json");

const { callLLM } = require("./llm-client");

/**
 * AI两阶段决策：
 * 第一阶段：策略算法生成候选排名
 * 第二阶段：AI从候选中筛选最终推荐，可剔除走势不好的，可调整排名
 */
async function generateCommentary(result, llmConfig) {
  const prompt = buildDecisionPrompt(result);
  const maxRetries = 2;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const text = await callLLM(prompt, llmConfig);
      // 反幻觉验证
      try {
        const context = { ranked: result.ranked, portfolio: result.portfolio };
        const gResult = grounding.verifyGrounding(text, context);
        if (gResult.score < 80) {
          console.warn("[AI] 反幻觉评分: " + gResult.score + "/100 - " + gResult.warnings.join("; "));
        }
      } catch (gErr) { /* ignore grounding errors */ }
      return text;
    } catch (err) {
      console.error("[AI] attempt " + (attempt + 1) + "/" + maxRetries + " error: " + err.message);
      if (attempt < maxRetries - 1) {
        console.log("[AI] retrying in 3s...");
        await new Promise(r => setTimeout(r, 3000));
      }
    }
  }
  return "[AI 分析暂时不可用: 重试 " + maxRetries + " 次后仍失败]";
}

function buildDecisionPrompt(result) {
  const lines = [];
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
    lines.push("--- 实时市场数据 ---");
    for (let s = 0; s < result.marketSnapshot.length; s++) {
      const m = result.marketSnapshot[s];
      const peInfo = m.pe ? " PE=" + m.pe : "";
      lines.push(m.name + ": " + m.price + " (" + (m.change >= 0 ? "+" : "") + m.change + "%)" + peInfo);
    }
    lines.push("");
  }

  // [fix] 估值数据（PE + 市场温度）
  if (result.marketTemperature) {
    const mt = result.marketTemperature;
    lines.push("--- 🌡️ 市场温度与估值 ---");
    lines.push("市场温度: " + mt.temperature + "/100 (" + mt.level + ")");
    lines.push("VIX: " + (mt.vix || "N/A") + " | 今日涨跌: " + (mt.dailyChange >= 0 ? "+" : "") + round2(mt.dailyChange) + "%");
    lines.push("建议投入: " + Math.round(result.budget * mt.multiplier) + "元 (正常" + result.budget + "元的" + mt.multiplier + "倍)");
    if (mt.reason !== "市场正常") lines.push("原因: " + mt.reason);
    lines.push("");
  }
  if (result.valuationData && result.valuationData.indices) {
    const vi = result.valuationData.indices;
    const peKeys = Object.keys(vi);
    if (peKeys.length > 0) {
      lines.push("--- 📊 指数估值 ---");
      for (let p = 0; p < peKeys.length; p++) {
        const idx = vi[peKeys[p]];
        lines.push(idx.name + ": PE=" + (idx.pe || "N/A"));
      }
      lines.push("");
    }
  }

  // 财经新闻
  if (result.marketNews && result.marketNews.length > 0) {
    lines.push("--- \u6700\u65b0\u8d22\u7ecf\u5feb\u8baf ---");
    for (let n = 0; n < result.marketNews.length; n++) {
      const news = result.marketNews[n];
      lines.push("- " + news.title + (news.digest ? ": " + news.digest : ""));
    }
    lines.push("");
  }

  // X/外部信号 — 大神最新观点（重点展示）
  if (result.externalSignals && (result.externalSignals.status === "ok" || result.externalSignals.status === "cached")) {
    lines.push("--- \u2b50 \u767d\u6bdb\u80a1\u795e\u6700\u65b0\u89c2\u70b9 (Serenity @aleabitoreddit) ---");

    // 核心：展示具体股票观点
    if (result.externalSignals.tickerOpinions && result.externalSignals.tickerOpinions.length > 0) {
      lines.push("\u2022 \u5177\u4f53\u80a1\u7968\u89c2\u70b9\uff08\u7528\u4e8e\u5224\u65ad\u57fa\u91d1\u6301\u4ed3\u66dd\u5149\uff09\uff1a");
      const topTickers = result.externalSignals.tickerOpinions.slice(0, 10);
      for (let tk = 0; tk < topTickers.length; tk++) {
        const tko = topTickers[tk];
        const sentimentLabel = tko.sentiment === "bullish" ? "\ud83d\udfe2\u770b\u597d" : (tko.sentiment === "bearish" ? "\ud83d\udd34\u770b\u6de1" : "\ud83d\udfe1\u4e2d\u6027");
        lines.push("   $" + tko.ticker + " (" + sentimentLabel + ", \u63d0\u53ca" + tko.mentions + "\u6b21)");
        if (tko.snippets.length > 0) {
          lines.push("     \u201c" + tko.snippets[0].substring(0, 150) + "\u201d");
        }
      }
      lines.push("");
    }

    // 推文摘要
    if (result.externalSignals.opinionSummaries && result.externalSignals.opinionSummaries.length > 0) {
      lines.push("\u2022 \u6700\u65b0\u63a8\u6587\u6458\u8981\uff1a");
      for (let os = 0; os < result.externalSignals.opinionSummaries.length; os++) {
        const opinion = result.externalSignals.opinionSummaries[os];
        const tickersStr = opinion.tickers ? " [" + opinion.tickers + "]" : "";
        lines.push("   - " + opinion.text.substring(0, 180) + tickersStr);
      }
      lines.push("");
    }

    // 主题分数（保留作为辅助参考）
    if (result.externalSignals.themeScores) {
      const themes = result.externalSignals.themeScores;
      const activeThemes = Object.keys(themes).filter(function(k) { return themes[k].score !== 0; });
      if (activeThemes.length > 0) {
        lines.push("\u2022 \u4e3b\u9898\u60c5\u611f: " + activeThemes.map(function(k) {
          return k + "(" + (themes[k].score > 0 ? "+" : "") + themes[k].score + ")";
        }).join(", "));
        lines.push("");
      }
    }
  } else if (result.externalSignals) {
    lines.push("--- X\u5916\u90e8\u4fe1\u53f7 ---");
    lines.push("\u72b6\u6001: " + (result.externalSignals.error || "\u4e0d\u53ef\u7528"));
    lines.push("");
  }

  // 新投资方向分析
  if (result.externalSignals && result.externalSignals.newDirections && result.externalSignals.newDirections.newThemes.length > 0) {
    const dirs = result.externalSignals.newDirections;
    const uncovered = dirs.newThemes.filter(function(t) { return !t.covered; });
    if (uncovered.length > 0) {
      lines.push("--- \ud83d\udd0d \u5927\u795e\u63d0\u5230\u7684\u65b0\u6295\u8d44\u65b9\u5411\uff08\u5f53\u524d\u57fa\u91d1\u6c60\u672a\u8986\u76d6\uff09 ---");
      for (let nd = 0; nd < uncovered.length; nd++) {
        const dir = uncovered[nd];
        const dirSentiment = dir.sentiment === "bullish" ? "\ud83d\udfe2\u770b\u597d" : (dir.sentiment === "bearish" ? "\ud83d\udd34\u770b\u6de1" : "\ud83d\udfe1\u4e2d\u6027");
        lines.push("  \u25b6 " + dir.theme + " (" + dirSentiment + ", \u63d0\u53ca" + dir.totalMentions + "\u6b21)");
        lines.push("    \u76f8\u5173\u80a1\u7968: " + dir.tickers.join(", "));
      }
      lines.push("");
      lines.push("  \u2757 \u4ee5\u4e0a\u65b9\u5411\u5728\u5f53\u524d40\u53ea\u57fa\u91d1\u6c60\u4e2d\u6ca1\u6709\u5bf9\u5e94\u57fa\u91d1\u3002");
      lines.push("  \u5efa\u8bae\u6295\u8d44\u8005\u5173\u6ce8\u8fd9\u4e9b\u65b9\u5411\uff0c\u5e76\u8003\u8651\u6dfb\u52a0\u76f8\u5173QDII\u57fa\u91d1\u5230\u57fa\u91d1\u6c60\u3002");
      lines.push("");
    }
  }

  // 全部有效基金排名（供AI参考补位）
  if (result.allRanked && result.allRanked.length > 0) {
    lines.push("--- \u5168\u90e8\u6709\u6548\u57fa\u91d1\u6392\u540d (" + result.allRanked.length + "\u53ea) ---");
    lines.push("\u8bf4\u660e\uff1a\u4ee5\u4e0b\u662f\u5168\u90e8\u6709\u6548\u57fa\u91d1\u7684\u5b8c\u6574\u6392\u540d\uff0c\u4f60\u53ef\u4ee5\u4ece\u4e2d\u9009\u62e9\u8865\u5145Top10");
    for (let ar = 0; ar < result.allRanked.length; ar++) {
      const af = result.allRanked[ar];
      const lim = af.dailyLimit <= 10 ? "\u2b50\u9650\u8d2d" + af.dailyLimit : (af._purchaseStatus === "limited" ? "\u9650\u8d2d" + af.dailyLimit : "");
      lines.push(af.rank + ". " + af.name + "(" + af.code + ") \u5f97\u5206:" + af.score + " 1\u5e74:" + (af.yearReturn !== null && af.yearReturn !== undefined ? af.yearReturn : "N/A") + "% \u590f\u666e:" + (af.sharpeRatio || "N/A") + " \u56de\u64a4:" + (af.maxDrawdown || "N/A") + "% " + lim);
    }
    lines.push("");
  }

  // 算法推荐的Top排名
  if (result.ranked && result.ranked.length > 0) {
    lines.push("--- \u7b56\u7565\u7b97\u6cd5\u6392\u540d Top" + result.ranked.length + " ---");
    for (let i = 0; i < result.ranked.length; i++) {
      const f = result.ranked[i];
      const ind = f.indicators || {};
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
    const suspNames = result.suspended.map(function(s) {
      const r = s._purchaseRawStatus || "\u6682\u505c";
      return s.name + "(" + r + ")";
    });
    lines.push(suspNames.join("\u3001"));
    lines.push("");
  }

  // 限购变化
  if (result.fundChanges && result.fundChanges.length > 0) {
    lines.push("--- \u26a0\ufe0f \u9650\u8d2d\u53d8\u5316\u63d0\u9192 ---");
    for (let fc = 0; fc < result.fundChanges.length; fc++) {
      lines.push("\u26a0\ufe0f " + result.fundChanges[fc].message);
    }
    lines.push("");
    lines.push("\u8bf7\u6839\u636e\u9650\u8d2d\u53d8\u5316\u7ed9\u51fa\u5e94\u5bf9\u5efa\u8bae\uff0c\u6bd4\u5982\u5207\u6362\u5230\u5176\u4ed6\u57fa\u91d1\u516c\u53f8\u7684\u540c\u7c7b\u4ea7\u54c1\u3002");
    lines.push("");
  }

  // 我的持仓
  if (result.portfolio && !result.portfolio.empty && result.portfolio.summary) {
    const ps = result.portfolio.summary;
    lines.push("--- \ud83d\udcb0 \u6211\u7684\u6301\u4ed3 ---");
    lines.push("\u603b\u6295\u5165: " + ps.totalInvested + "\u5143 | \u5f53\u524d\u5e02\u503c: " + ps.totalValue + "\u5143 | \u76c8\u4e8f: " + (ps.totalPnl >= 0 ? "+" : "") + ps.totalPnl + "\u5143 (" + (ps.totalPnlRate >= 0 ? "+" : "") + ps.totalPnlRate + "%)");
    lines.push("\u6301\u6709" + ps.holdingCount + "\u53ea\u57fa\u91d1 | \u5df2\u6295" + ps.daysSinceStart + "\u5929");
    if (result.portfolio.holdings && result.portfolio.holdings.length > 0) {
      for (let pi = 0; pi < result.portfolio.holdings.length; pi++) {
        const ph = result.portfolio.holdings[pi];
        const phPnl = ph.pnl !== null ? ((ph.pnl >= 0 ? "+" : "") + ph.pnl + "\u5143(" + (ph.pnlRate >= 0 ? "+" : "") + ph.pnlRate + "%)") : "\u5f85\u66f4\u65b0";
        lines.push("  " + ph.name + "(" + ph.code + "): \u6295\u5165" + ph.totalAmount + "\u5143, \u76c8\u4e8f" + phPnl);
      }
    }
    lines.push("");
    lines.push("\u8bf7\u6839\u636e\u6211\u7684\u5b9e\u9645\u6301\u4ed3\u7ed9\u51fa\u4e2a\u6027\u5316\u5efa\u8bae\uff1a\u52a0\u4ed3/\u51cf\u4ed3/\u6362\u4ed3\u3002");
    lines.push("");
  }

  // 组合风险
  if (result.risk) {
    const rk = result.risk;
    lines.push("--- \ud83d\udee1\ufe0f \u7ec4\u5408\u98ce\u9669 ---");
    lines.push("\u5065\u5eb7\u5ea6: " + rk.healthScore + "/100 | \u590f\u666e: " + rk.portfolioSharpe + " | \u56de\u64a4: " + rk.portfolioMaxDrawdown + "% | \u5e74\u5316: " + rk.portfolioAnnualReturn + "%");
    lines.push("\u4e3b\u8981\u7c7b\u578b: " + rk.concentration.dominantType + " (" + rk.concentration.dominantWeight + "%)");
    if (rk.concentration.dominantWeight > 70) {
      lines.push("\u26a0\ufe0f \u6301\u4ed3\u8fc7\u4e8e\u96c6\u4e2d\u5728" + rk.concentration.dominantType + "\uff0c\u5efa\u8bae\u5206\u6563\u5230\u5176\u4ed6\u7c7b\u578b");
    }
    lines.push("");
  }

  // 替代方案
  if (result.alternatives && result.alternatives.length > 0) {
    lines.push("--- \u66ff\u4ee3\u65b9\u6848 ---");
    for (let ai = 0; ai < result.alternatives.length; ai++) {
      const alt = result.alternatives[ai];
      lines.push(alt.fund.name + " \u4e0d\u53ef\u4e70 | \u98ce\u9669:" + alt.policyRisk.risk);
      lines.push("  \u66ff\u4ee3: " + alt.alternatives.map(function(a) { return a.name + "(" + a.code + ")"; }).join(", "));
    }
    lines.push("");
  }

  // 历史推荐记录
  const histData = loadHistoryWithPerformance();
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
  lines.push("   \u8bf7\u5217\u51fa\u4f60\u8ba4\u4e3a\u6700\u503c\u5f97\u957f\u671f\u6301\u6709\u7684\u524d10\u53ea");
  lines.push("   \u3010\u91cd\u8981\u3011\u7eb3\u6307100\u7cfb\u5217\u5fc5\u987b\u4fdd\u7559\u81f3\u5c115\u53ea\uff08\u6838\u5fc3\u4ed3\u4f4d\uff09\uff0c\u5e7f\u53d1\u5168\u7403\u3001\u6e2f\u80a1\u7b49\u4f5c\u4e3a\u536b\u661f\u4ed3\u4f4d\u6392\u5728\u540e\u9762");
  lines.push("   \u4e0d\u8981\u56e0\u4e3a\u9650\u8d2d\u4f4e\u5c31\u5254\u9664\u7eb3\u6307\u57fa\u91d1\uff0c\u9650\u8d2d10\u5143\u5c0f\u989d\u5b9a\u6295\u662f\u7ec3\u624b\u7684\u6700\u4f73\u65b9\u5f0f");
  lines.push("   \u8f93\u51fa\u683c\u5f0f: [\u6392\u540d] \u57fa\u91d1\u540d\u79f0(\u4ee3\u7801) - \u5efa\u8bae\u64cd\u4f5c - \u4e00\u53e5\u8bdd\u7406\u7531");
  lines.push("");
  lines.push("4. \u53c2\u8003\u5b9a\u6295\u5efa\u8bae\uff1a\u6839\u636e\u673a\u4f1a\u8bc4\u7ea7\u548c\u57fa\u91d1\u8d28\u91cf\uff0c\u5efa\u8bae\u6bcf\u65e5\u6295\u5165\u591a\u5c11\u5143\uff0c\u4ee5\u53ca\u5206\u914d\u6bd4\u4f8b");
  lines.push("");
  lines.push("5. \u98ce\u9669\u63d0\u793a\uff08\u6709\u5219\u5199\uff09");
  lines.push("");
  lines.push("6. \u5b9e\u64cd\u5efa\u8bae\uff08\u53e3\u8bed\u5316\u3001\u63a5\u5730\u6c14\uff0c\u50cf\u670b\u53cb\u804a\u5929\u4e00\u6837\uff09\uff1a");
  lines.push("   \u7528\u53e3\u8bed\u544a\u8bc9\u6295\u8d44\u8005\uff1a");
  lines.push("   - \u73b0\u5728\u662f\u4e0d\u662f\u597d\u65f6\u673a\uff1f\u8be5\u4e0d\u8be5\u62c5\u5fc3\uff1f");
  lines.push("   - \u5f53\u524d\u5e02\u573a\u4e0b\u8dcc\u65f6\u8be5\u600e\u4e48\u770b\uff1f\u6da8\u591a\u4e86\u53c8\u8be5\u600e\u4e48\u770b\uff1f");
  lines.push("   - \u7ed9\u4e00\u4e9b\u7b80\u5355\u7684\u64cd\u4f5c\u5efa\u8bae\uff0c\u6bd4\u5982\u201c\u4eca\u5929\u8dcc\u4e86\u53ef\u4ee5\u591a\u6295\u4e00\u70b9\u201d\u6216\u201c\u8fde\u7eed\u6da8\u4e86\u53ef\u4ee5\u7b49\u4e00\u7b49\u201d");
  lines.push("   - \u8bed\u6c14\u8981\u8f7b\u677e\u3001\u9f13\u52b1\u6027\u7684\uff0c\u800c\u4e0d\u662f\u51b7\u51b0\u51b0\u7684\u62a5\u544a\u98ce\u683c");
  lines.push("   \u793a\u4f8b\uff1a\u201c\u5e02\u573a\u521a\u8dcc\u4e864%\uff0c\u5176\u5b9e\u53cd\u800c\u662f\u5b9a\u6295\u7684\u597d\u65f6\u673a\u2014\u2014\u4e0b\u8dcc\u65f6\u4e70\u5165\u6210\u672c\u66f4\u4f4e\u3002\u4f60\u6bcf\u5929\u53ea\u629550\u5757\uff0c\u9650\u8d2d\u53c8\u53ea\u670910\u5757\uff0c\u5b8c\u5168\u4e0d\u7528\u62c5\u5fc3\uff0c\u575a\u6301\u5c31\u884c\u3002\u201d");
  lines.push("");
  lines.push("7. \u4f30\u503c\u8bc4\u4f30\uff08\u5fc5\u987b\u5305\u542b\uff09\uff1a");
  lines.push("   - \u5f53\u524d\u5e02\u573a\u6e29\u5ea6\u548cPE\u4f30\u503c\u6c34\u5e73");
  lines.push("   - \u5982\u679cPE>30\uff0c\u5fc5\u987b\u63d0\u9192\u201c\u5f53\u524d\u4f30\u503c\u504f\u9ad8\uff0c\u5efa\u8bae\u51cf\u5c11\u6295\u5165\u6216\u6682\u505c\u4e00\u5929\u201d");
  lines.push("   - \u5982\u679cVIX>30\uff0c\u5fc5\u987b\u63d0\u9192\u201c\u5e02\u573a\u6050\u614c\uff0c\u53cd\u800c\u662f\u5b9a\u6295\u597d\u65f6\u673a\uff0c\u53ef\u4ee5\u9002\u5f53\u591a\u6295\u201d");
  lines.push("   - \u5982\u679cPE<18\uff0c\u5fc5\u987b\u63d0\u9192\u201c\u5f53\u524d\u4f30\u503c\u504f\u4f4e\uff0c\u662f\u52a0\u4ed3\u597d\u65f6\u673a\u201d");
  lines.push("");
  lines.push("8. \u4e00\u53e5\u8bdd\u603b\u7ed3");

  return lines.join("\n");
}

function loadHistoryWithPerformance() {
  try {
    if (!fs.existsSync(HISTORY_FILE)) return null;
    const data = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf-8"));
    if (!data.records || data.records.length === 0) return null;

    const records = data.records;
    const recent = records.slice(-10);
    const lines = ["--- \u5386\u53f2\u63a8\u8350\u8868\u73b0 (\u6700\u8fd1" + recent.length + "\u6b21) ---"];

    let totalWin5d = 0, totalValid5d = 0, totalReturn5d = 0;
    let totalWin10d = 0, totalValid10d = 0, totalReturn10d = 0;

    for (let i = 0; i < recent.length; i++) {
      const rec = recent[i];
      const allocs = rec.allocations || rec.ranked || [];
      if (allocs.length === 0) continue;

      const allocStr = allocs.map(function(a) {
        let perf = "";
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
    const freq = {};
    for (let j = 0; j < records.length; j++) {
      const r = records[j];
      const aList = r.allocations || r.ranked || [];
      for (let k = 0; k < aList.length; k++) {
        const a = aList[k];
        freq[a.code] = (freq[a.code] || 0) + 1;
      }
    }
    const sorted = Object.entries(freq).sort(function(a,b) { return b[1] - a[1]; }).slice(0, 5);
    if (sorted.length > 0) {
      lines.push("\u6700\u5e38\u63a8\u8350: " + sorted.map(function(e) { return e[0] + "(" + e[1] + "\u6b21)"; }).join("\u3001"));
    }

    return lines.join("\n");
  } catch (err) {
    console.warn("[AI] 加载历史表现数据失败:", err.message);
    return null;
  }
}

module.exports = { generateCommentary: generateCommentary, callLLM: callLLM };