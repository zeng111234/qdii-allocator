/**
 * 多智能体辩论模块 (Multi-Agent Debate)
 * 借鉴 TradingAgents 的 Bull/Bear 辩论机制
 *
 * 架构：
 * 1. Bull Researcher - 看多研究员，找出买入理由
 * 2. Bear Researcher - 看空研究员，找出风险和卖出理由
 * 3. Risk Manager - 风险经理，独立评估风险
 * 4. Debate Moderator - 辩论主持人，汇总并做出最终决策
 */

const { callLLM } = require("./llm-client");

/**
 * Bull Researcher - 看多研究员
 * 专注于找出基金的买入理由和上涨潜力
 */
async function bullResearcher(fundData, marketContext, llmConfig) {
  const prompt = buildBullPrompt(fundData, marketContext);

  try {
    const response = await callLLM(prompt, {
      ...llmConfig,
      systemPrompt: `你是一位看多研究员（Bull Researcher），专注于寻找投资机会和上涨潜力。

你的职责：
1. 找出每只基金的买入理由和上涨催化剂
2. 分析技术指标中的看多信号
3. 识别市场情绪中的积极因素
4. 评估基金的长期增长潜力

分析原则：
- 基于数据说话，引用具体指标
- 关注趋势和动量
- 考虑宏观经济利好因素
- 评估基金经理和公司的优势

输出格式：
对每只基金输出：
- 看多评分：1-10分（10分最看多）
- 核心理由：2-3个关键买入理由
- 催化剂：可能推动上涨的事件
- 目标预期：预期涨幅范围`
    });

    return parseBullResponse(response, fundData);
  } catch (err) {
    console.error("[Bull Researcher] Error:", err.message);
    return null;
  }
}

/**
 * Bear Researcher - 看空研究员
 * 专注于找出风险和卖出理由
 */
async function bearResearcher(fundData, marketContext, llmConfig) {
  const prompt = buildBearPrompt(fundData, marketContext);

  try {
    const response = await callLLM(prompt, {
      ...llmConfig,
      systemPrompt: `你是一位看空研究员（Bear Researcher），专注于识别风险和下跌因素。

你的职责：
1. 找出每只基金的风险因素和卖出理由
2. 分析技术指标中的看空信号
3. 识别市场情绪中的消极因素
4. 评估潜在的黑天鹅事件

分析原则：
- 基于数据说话，引用具体指标
- 关注风险和回撤
- 考虑宏观经济风险因素
- 评估基金的结构性弱点

输出格式：
对每只基金输出：
- 风险评分：1-10分（10分风险最高）
- 核心风险：2-3个关键风险因素
- 警示信号：需要关注的危险信号
- 建议操作：持有/减仓/卖出`
    });

    return parseBearResponse(response, fundData);
  } catch (err) {
    console.error("[Bear Researcher] Error:", err.message);
    return null;
  }
}

/**
 * Risk Manager - 风险经理
 * 独立评估投资组合的整体风险
 */
async function riskManager(fundData, portfolioData, marketContext, llmConfig) {
  const prompt = buildRiskManagerPrompt(fundData, portfolioData, marketContext);

  try {
    const response = await callLLM(prompt, {
      ...llmConfig,
      systemPrompt: `你是一位风险经理（Risk Manager），负责独立评估投资风险。

你的职责：
1. 评估投资组合的整体风险水平
2. 识别集中度风险和相关性风险
3. 评估市场系统性风险
4. 提供风险管理建议

分析原则：
- 保守优先，风险控制第一
- 基于量化指标评估风险
- 考虑极端情况和黑天鹅
- 提供具体的风险控制措施

输出格式：
- 组合风险等级：低/中/高/极高
- 主要风险因素：列出3-5个主要风险
- 集中度警告：是否有过度集中的持仓
- 建议措施：具体的风险控制建议`
    });

    return parseRiskManagerResponse(response, fundData, portfolioData);
  } catch (err) {
    console.error("[Risk Manager] Error:", err.message);
    return null;
  }
}

/**
 * Debate Moderator - 辩论主持人
 * 汇总各方观点，做出最终决策
 */
async function debateModerator(bull观点, bear观点, riskAssessment, fundData, llmConfig) {
  const prompt = buildModeratorPrompt(bull观点, bear观点, riskAssessment, fundData);

  try {
    const response = await callLLM(prompt, {
      ...llmConfig,
      systemPrompt: `你是投资决策主持人（Debate Moderator），负责综合各方观点做出最终决策。

你的职责：
1. 综合看多和看空研究员的观点
2. 考虑风险经理的独立评估
3. 做出平衡的投资决策
4. 提供清晰的操作建议

决策原则：
- 平衡收益和风险
- 优先考虑风险控制
- 基于证据做决策
- 提供明确的操作指引

输出格式：
【最终投资决策】

1. 综合评估：
   - 整体市场判断
   - 主要机会和风险

2. 基金排名调整：
   - 对每只基金给出最终建议
   - 调整理由

3. 操作建议：
   - 具体买入/卖出/持有建议
   - 仓位建议

4. 风险提示：
   - 需要关注的风险点
   - 止损建议`
    });

    return parseModeratorResponse(response, fundData);
  } catch (err) {
    console.error("[Debate Moderator] Error:", err.message);
    return null;
  }
}

/**
 * 构建 Bull Researcher 的 Prompt
 */
function buildBullPrompt(fundData, marketContext) {
  const lines = [];

  lines.push("=== 看多研究员分析任务 ===");
  lines.push("");
  lines.push("请对以下基金进行看多分析，找出买入理由和上涨潜力。");
  lines.push("");

  // 市场背景
  if (marketContext) {
    lines.push("--- 市场背景 ---");
    if (marketContext.marketSnapshot) {
      lines.push("市场指数：");
      marketContext.marketSnapshot.forEach(function(s) {
        lines.push("  " + s.name + ": " + s.price + " (" + (s.change >= 0 ? "+" : "") + s.change + "%)");
      });
    }
    if (marketContext.marketNews && marketContext.marketNews.length > 0) {
      lines.push("");
      lines.push("最新新闻：");
      marketContext.marketNews.slice(0, 5).forEach(function(n) {
        lines.push("  - " + n.title);
      });
    }
    lines.push("");
  }

  // 基金数据
  lines.push("--- 基金数据 ---");
  fundData.forEach(function(fund) {
    lines.push("");
    lines.push("基金：" + fund.name + " (" + fund.code + ")");
    lines.push("类型：" + (fund.type || "未知"));
    lines.push("得分：" + (fund.score || "N/A"));

    if (fund.indicators) {
      const ind = fund.indicators;
      lines.push("年化收益：" + (ind.annualizedReturn || "N/A") + "%");
      lines.push("夏普比率：" + (ind.sharpeRatio || "N/A"));
      lines.push("最大回撤：" + (ind.maxDrawdown || "N/A") + "%");
      lines.push("波动率：" + (ind.volatility || "N/A") + "%");
      lines.push("趋势：" + (ind.longTermTrend || "N/A"));
    }

    if (fund.reason) {
      lines.push("评分理由：" + fund.reason);
    }
  });

  lines.push("");
  lines.push("请对每只基金进行详细的看多分析。");

  return lines.join("\n");
}

/**
 * 构建 Bear Researcher 的 Prompt
 */
function buildBearPrompt(fundData, marketContext) {
  const lines = [];

  lines.push("=== 看空研究员分析任务 ===");
  lines.push("");
  lines.push("请对以下基金进行风险分析，找出潜在的下跌因素和风险。");
  lines.push("");

  // 市场背景
  if (marketContext) {
    lines.push("--- 市场背景 ---");
    if (marketContext.marketSnapshot) {
      lines.push("市场指数：");
      marketContext.marketSnapshot.forEach(function(s) {
        lines.push("  " + s.name + ": " + s.price + " (" + (s.change >= 0 ? "+" : "") + s.change + "%)");
      });
    }
    lines.push("");
  }

  // 基金数据
  lines.push("--- 基金数据 ---");
  fundData.forEach(function(fund) {
    lines.push("");
    lines.push("基金：" + fund.name + " (" + fund.code + ")");
    lines.push("类型：" + (fund.type || "未知"));

    if (fund.indicators) {
      const ind = fund.indicators;
      lines.push("年化收益：" + (ind.annualizedReturn || "N/A") + "%");
      lines.push("夏普比率：" + (ind.sharpeRatio || "N/A"));
      lines.push("最大回撤：" + (ind.maxDrawdown || "N/A") + "%");
      lines.push("波动率：" + (ind.volatility || "N/A") + "%");
      lines.push("近期涨跌：" + (ind.recent5Change || "N/A") + "% (5日)");
    }
  });

  lines.push("");
  lines.push("请对每只基金进行详细的风险分析。");

  return lines.join("\n");
}

/**
 * 构建 Risk Manager 的 Prompt
 */
function buildRiskManagerPrompt(fundData, portfolioData, marketContext) {
  const lines = [];

  lines.push("=== 风险经理评估任务 ===");
  lines.push("");
  lines.push("请对投资组合进行独立的风险评估。");
  lines.push("");

  // 持仓数据
  if (portfolioData && !portfolioData.empty) {
    lines.push("--- 当前持仓 ---");
    lines.push("总投入：" + portfolioData.summary.totalInvested + "元");
    lines.push("当前市值：" + portfolioData.summary.totalValue + "元");
    lines.push("盈亏：" + portfolioData.summary.totalPnl + "元");
    lines.push("持有基金数：" + portfolioData.summary.holdingCount + "只");
    lines.push("");

    if (portfolioData.holdings && portfolioData.holdings.length > 0) {
      lines.push("持仓明细：");
      portfolioData.holdings.forEach(function(h) {
        lines.push("  " + h.name + ": " + h.totalAmount + "元 (" + (h.pnlRate >= 0 ? "+" : "") + h.pnlRate + "%)");
      });
    }
    lines.push("");
  }

  // 市场风险因素
  if (marketContext) {
    lines.push("--- 市场风险因素 ---");
    if (marketContext.marketSnapshot) {
      marketContext.marketSnapshot.forEach(function(s) {
        if (s.change < -2) {
          lines.push("⚠️ " + s.name + " 下跌 " + Math.abs(s.change) + "%");
        }
      });
    }
    lines.push("");
  }

  // 推荐基金
  lines.push("--- 计划买入的基金 ---");
  fundData.slice(0, 10).forEach(function(fund, idx) {
    lines.push((idx + 1) + ". " + fund.name + " (" + fund.code + ") - 得分：" + (fund.score || "N/A"));
  });

  lines.push("");
  lines.push("请评估整体投资组合的风险水平。");

  return lines.join("\n");
}

/**
 * 构建 Moderator 的 Prompt
 */
function buildModeratorPrompt(bull观点, bear观点, riskAssessment, fundData) {
  const lines = [];

  lines.push("=== 投资决策辩论汇总 ===");
  lines.push("");
  lines.push("以下是各方研究员的分析报告，请综合考虑后做出最终投资决策。");
  lines.push("");

  // Bull 观点
  lines.push("--- 看多研究员观点 ---");
  if (bull观点 && bull观点.fundAnalysis) {
    bull观点.fundAnalysis.forEach(function(analysis) {
      lines.push(analysis.fundName + "：");
      lines.push("  看多评分：" + analysis.bullScore + "/10");
      lines.push("  核心理由：" + analysis.reasons.join("；"));
      if (analysis.catalyst) {
        lines.push("  催化剂：" + analysis.catalyst);
      }
      lines.push("");
    });
  } else {
    lines.push("（看多分析不可用）");
    lines.push("");
  }

  // Bear 观点
  lines.push("--- 看空研究员观点 ---");
  if (bear观点 && bear观点.fundAnalysis) {
    bear观点.fundAnalysis.forEach(function(analysis) {
      lines.push(analysis.fundName + "：");
      lines.push("  风险评分：" + analysis.riskScore + "/10");
      lines.push("  核心风险：" + analysis.risks.join("；"));
      if (analysis.warningSignal) {
        lines.push("  警示信号：" + analysis.warningSignal);
      }
      lines.push("");
    });
  } else {
    lines.push("（看空分析不可用）");
    lines.push("");
  }

  // Risk Assessment
  lines.push("--- 风险经理评估 ---");
  if (riskAssessment) {
    lines.push("组合风险等级：" + riskAssessment.overallRiskLevel);
    if (riskAssessment.mainRisks && riskAssessment.mainRisks.length > 0) {
      lines.push("主要风险：");
      riskAssessment.mainRisks.forEach(function(risk) {
        lines.push("  - " + risk);
      });
    }
    if (riskAssessment.recommendations && riskAssessment.recommendations.length > 0) {
      lines.push("建议措施：");
      riskAssessment.recommendations.forEach(function(rec) {
        lines.push("  - " + rec);
      });
    }
  } else {
    lines.push("（风险评估不可用）");
  }
  lines.push("");

  // 基金列表
  lines.push("--- 候选基金 ---");
  fundData.slice(0, 15).forEach(function(fund, idx) {
    lines.push((idx + 1) + ". " + fund.name + " (" + fund.code + ") - 得分：" + (fund.score || "N/A"));
  });

  lines.push("");
  lines.push("请根据以上各方观点，做出最终的投资决策。");

  return lines.join("\n");
}

/**
 * 从 LLM 文本中提取结构化数据的通用工具
 */
function extractScore(text, patterns) {
  if (!text) return null;
  for (let i = 0; i < patterns.length; i++) {
    const m = text.match(patterns[i]);
    if (m) return parseFloat(m[1]);
  }
  return null;
}

function extractSection(text, headers) {
  if (!text) return '';
  for (let i = 0; i < headers.length; i++) {
    // 匹配 ## 标题 或 **标题** 或 【标题】
    const patterns = [
      new RegExp(headers[i] + '[^\\n]*\\n([\\s\\S]*?)(?=\\n#{1,3}\\s|\\n\\*\\*[^\\n]+\\*\\*\\n|\\n【|$)', 'i'),
      new RegExp('【' + headers[i] + '[^】]*】[^\\n]*\\n([\\s\\S]*?)(?=\\n【|$)', 'i')
    ];
    for (let j = 0; j < patterns.length; j++) {
      const m = text.match(patterns[j]);
      if (m && m[1].trim().length > 10) return m[1].trim();
    }
  }
  return '';
}

function extractBullets(text) {
  if (!text) return [];
  const lines = text.split('\n');
  const bullets = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/^[\s\-*•·]+/, '').trim();
    if (line.length > 5 && line.length < 200) bullets.push(line);
  }
  return bullets.slice(0, 5);
}

function extractFundAnalysis(text, fundData) {
  const results = [];
  for (let i = 0; i < fundData.length; i++) {
    const fund = fundData[i];
    const name = fund.name || fund.code;
    // 尝试匹配基金名称或代码附近的评分
    const escapedName = name.replace(/([.*+?^${}()|[\]\\])/g, '\\$1');
    const fundPattern = new RegExp(escapedName + '|' + fund.code + '[^\\n]*', 'i');
    let fundSection = '';
    const lines = text.split('\n');
    let inSection = false;
    for (let j = 0; j < lines.length; j++) {
      if (fundPattern.test(lines[j])) { inSection = true; fundSection = ''; }
      else if (inSection && (lines[j].match(/^\d+\./) || lines[j].match(/^#{1,3}\s/) || lines[j].match(/^【/))) { inSection = false; }
      if (inSection) fundSection += lines[j] + '\n';
    }

    const score = extractScore(fundSection, [
      /(?:评分|得分|分数)[：:]\s*(\d+(?:\.\d+)?)/,
      /(\d+(?:\.\d+)?)\s*[/／]\s*10/,
      /(?:看多|看空|风险)评[分估][：:]\s*(\d+(?:\.\d+)?)/
    ]) || 5;

    let reasons = extractBullets(fundSection).slice(0, 3);
    if (reasons.length === 0) reasons = ['待分析'];

    results.push({
      fundCode: fund.code,
      fundName: name,
      score: score,
      analysis: fundSection.substring(0, 300),
      reasons: reasons
    });
  }
  return results;
}

/**
 * 解析 Bull Researcher 的响应
 */
function parseBullResponse(response, fundData) {
  if (!response) return null;
  return {
    rawResponse: response,
    summary: extractSection(response, ['总结', '综合', '结论', 'Summary']) || response.substring(0, 300),
    fundAnalysis: extractFundAnalysis(response, fundData).map(function(f) {
      return {
        fundCode: f.fundCode,
        fundName: f.fundName,
        bullScore: f.score,
        reasons: f.reasons,
        catalyst: null
      };
    })
  };
}

/**
 * 解析 Bear Researcher 的响应
 */
function parseBearResponse(response, fundData) {
  if (!response) return null;
  return {
    rawResponse: response,
    summary: extractSection(response, ['总结', '综合', '风险概述', 'Summary']) || response.substring(0, 300),
    fundAnalysis: extractFundAnalysis(response, fundData).map(function(f) {
      return {
        fundCode: f.fundCode,
        fundName: f.fundName,
        riskScore: f.score,
        risks: f.reasons,
        warningSignal: null
      };
    })
  };
}

/**
 * 解析 Risk Manager 的响应
 */
function parseRiskManagerResponse(response, fundData, portfolioData) {
  if (!response) return null;
  let riskLevel = '中';
  const levelMatch = response.match(/(?:风险等级|风险水平)[：:]\s*(低|中|高|极高)/);
  if (levelMatch) riskLevel = levelMatch[1];
  else if (response.indexOf('极高') >= 0 || response.indexOf('非常高') >= 0) riskLevel = '极高';
  else if (response.indexOf('高风险') >= 0 || response.indexOf('风险较高') >= 0) riskLevel = '高';
  else if (response.indexOf('低风险') >= 0 || response.indexOf('风险较低') >= 0) riskLevel = '低';

  return {
    rawResponse: response,
    overallRiskLevel: riskLevel,
    mainRisks: extractBullets(extractSection(response, ['主要风险', '风险因素', '风险点', 'Main Risks'])).slice(0, 5),
    concentrationWarning: extractSection(response, ['集中度', '集中风险']) || null,
    recommendations: extractBullets(extractSection(response, ['建议', '措施', 'Recommendations'])).slice(0, 5)
  };
}

/**
 * 解析 Moderator 的响应
 */
function parseModeratorResponse(response, fundData) {
  if (!response) return null;
  return {
    rawResponse: response,
    finalDecision: response,
    summary: extractSection(response, ['综合评估', '总结', '结论', 'Summary']) || response.substring(0, 500),
    actionItems: extractBullets(extractSection(response, ['操作建议', '具体操作', 'Action'])).slice(0, 5),
    riskWarnings: extractBullets(extractSection(response, ['风险提示', '注意事项', 'Warning'])).slice(0, 3),
    fundRecommendations: extractFundAnalysis(response, fundData).map(function(f) {
      let action = '持有';
      const text = f.analysis || '';
      if (text.indexOf('买') >= 0 || text.indexOf('加仓') >= 0 || text.indexOf('增持') >= 0) action = '买入';
      else if (text.indexOf('卖') >= 0 || text.indexOf('减仓') >= 0 || text.indexOf('减持') >= 0) action = '卖出';
      return {
        fundCode: f.fundCode,
        fundName: f.fundName,
        action: action,
        reason: f.reasons[0] || '综合分析'
      };
    })
  };
}

/**
 * 运行完整的多智能体辩论流程
 */
async function runMultiAgentDebate(fundData, portfolioData, marketContext, llmConfig) {
  console.log("[Multi-Agent] 开始多智能体辩论...");

  // 并行运行 Bull 和 Bear Researcher
  const [bullResult, bearResult, riskResult] = await Promise.all([
    bullResearcher(fundData, marketContext, llmConfig),
    bearResearcher(fundData, marketContext, llmConfig),
    riskManager(fundData, portfolioData, marketContext, llmConfig)
  ]);

  console.log("[Multi-Agent] Bull/Bear/Risk 分析完成");

  // 运行辩论主持人
  const moderatorResult = await debateModerator(
    bullResult,
    bearResult,
    riskResult,
    fundData,
    llmConfig
  );

  console.log("[Multi-Agent] 辩论完成，生成最终决策");

  return {
    bull观点: bullResult,
    bear观点: bearResult,
    riskAssessment: riskResult,
    finalDecision: moderatorResult,
    summary: {
      bullAvailable: !!bullResult,
      bearAvailable: !!bearResult,
      riskAvailable: !!riskResult,
      moderatorAvailable: !!moderatorResult
    }
  };
}

/**
 * 格式化辩论报告
 */
function formatDebateReport(debateResult) {
  const lines = [];

  lines.push("=== 多智能体投资辩论报告 ===");
  lines.push("");

  // 汇总
  lines.push("--- 辩论概况 ---");
  lines.push("看多研究员：" + (debateResult.summary.bullAvailable ? "✅ 已完成" : "❌ 不可用"));
  lines.push("看空研究员：" + (debateResult.summary.bearAvailable ? "✅ 已完成" : "❌ 不可用"));
  lines.push("风险经理：" + (debateResult.summary.riskAvailable ? "✅ 已完成" : "❌ 不可用"));
  lines.push("辩论主持人：" + (debateResult.summary.moderatorAvailable ? "✅ 已完成" : "❌ 不可用"));
  lines.push("");

  // Bull 观点摘要
  if (debateResult.bull观点) {
    lines.push("--- 🐂 看多观点 ---");
    lines.push(debateResult.bull观点.summary || '(无摘要)');
    if (debateResult.bull观点.fundAnalysis) {
      debateResult.bull观点.fundAnalysis.forEach(function(a) {
        lines.push("  " + a.fundName + ": 看多 " + a.bullScore + "/10 — " + a.reasons.join('；'));
      });
    }
    lines.push("");
  }

  // Bear 观点摘要
  if (debateResult.bear观点) {
    lines.push("--- 🐻 看空观点 ---");
    lines.push(debateResult.bear观点.summary || '(无摘要)');
    if (debateResult.bear观点.fundAnalysis) {
      debateResult.bear观点.fundAnalysis.forEach(function(a) {
        lines.push("  " + a.fundName + ": 风险 " + a.riskScore + "/10 — " + a.risks.join('；'));
      });
    }
    lines.push("");
  }

  // 风险评估
  if (debateResult.riskAssessment) {
    lines.push("--- 🛡️ 风险评估 ---");
    lines.push("组合风险等级：" + debateResult.riskAssessment.overallRiskLevel);
    if (debateResult.riskAssessment.mainRisks && debateResult.riskAssessment.mainRisks.length > 0) {
      debateResult.riskAssessment.mainRisks.forEach(function(r) { lines.push("  ⚠️ " + r); });
    }
    lines.push("");
  }

  // 最终决策
  if (debateResult.finalDecision) {
    lines.push("--- 🤹 最终决策 ---");
    lines.push(debateResult.finalDecision.summary || debateResult.finalDecision.finalDecision || '(无决策)');
    if (debateResult.finalDecision.actionItems && debateResult.finalDecision.actionItems.length > 0) {
      lines.push("");
      lines.push("操作建议：");
      debateResult.finalDecision.actionItems.forEach(function(a) { lines.push("  → " + a); });
    }
    if (debateResult.finalDecision.riskWarnings && debateResult.finalDecision.riskWarnings.length > 0) {
      lines.push("");
      lines.push("风险提示：");
      debateResult.finalDecision.riskWarnings.forEach(function(w) { lines.push("  ⚠️ " + w); });
    }
  }

  return lines.join("\n");
}

module.exports = {
  bullResearcher,
  bearResearcher,
  riskManager,
  debateModerator,
  runMultiAgentDebate,
  formatDebateReport
};
