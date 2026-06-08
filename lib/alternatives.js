/**
 * QDII 替代方案模块
 * 当基金限购/停购时，推荐替代基金
 */

// 替代方案映射表
// key: 原基金类型/代码, value: 替代基金列表
var ALTERNATIVES_MAP = {
  // 纳指100 系列
  "纳指100": [
    { code: "270042", name: "广发纳斯达克100A", note: "场内LOF，可在券商买入" },
    { code: "040046", name: "华安纳斯达克100A", note: "限购10元，品质基金" },
    { code: "160213", name: "国泰纳斯达克100", note: "限购10元" },
    { code: "000834", name: "大成纳斯达克100", note: "限购10元" },
    { code: "539001", name: "建信纳斯达克100A", note: "限购10元" },
    { code: "006479", name: "南方纳斯达克100A", note: "限购10元" },
    { code: "161130", name: "易方达纳斯达克100A", note: "LOF，场内可买" },
    // 场内 ETF 替代
    { code: "513100", name: "纳指ETF(国泰)", note: "场内ETF，无限购，但可能溢价" },
    { code: "159941", name: "纳指ETF(广发)", note: "场内ETF，无限购" },
    { code: "513300", name: "纳斯达克100ETF", note: "场内ETF" }
  ],

  // 标普500 系列
  "标普500": [
    { code: "050025", name: "博时标普500ETF联接A", note: "限购10元" },
    { code: "096001", name: "大成标普500A", note: "限购10元" },
    { code: "161125", name: "易方达标普500A", note: "LOF" },
    { code: "513500", name: "标普500ETF", note: "场内ETF，无限购" }
  ],

  // 港股系列
  "港股": [
    { code: "164701", name: "汇添富恒生指数A", note: "QDII" },
    { code: "040018", name: "华安香港精选A", note: "QDII" },
    { code: "000041", name: "华夏全球股票QDII", note: "QDII" },
    { code: "159920", name: "恒生ETF", note: "场内ETF" },
    { code: "513660", name: "恒生科技ETF", note: "场内ETF" }
  ],

  // 全球精选
  "全球精选": [
    { code: "270023", name: "广发全球精选QDII", note: "主动管理" },
    { code: "486002", name: "工银全球精选QDII", note: "主动管理" },
    { code: "002230", name: "华夏全球股票QDII", note: "主动管理" }
  ],

  // 亚太
  "亚太": [
    { code: "050015", name: "博时亚太精选QDII", note: "QDII" },
    { code: "000369", name: "广发亚太精选QDII", note: "QDII" }
  ],

  // 德国DAX
  "德国DAX": [
    { code: "000614", name: "华安德国DAX30A", note: "QDII" },
    { code: "513030", name: "德国ETF", note: "场内ETF" }
  ],

  // 石油/能源
  "石油": [
    { code: "000988", name: "华安标普石油A", note: "QDII-LOF" },
    { code: "162411", name: "华宝标普油气A", note: "QDII-LOF" },
    { code: "159985", name: "豆粕ETF", note: "场内ETF" }
  ],

  // 生物科技
  "生物科技": [
    { code: "001092", name: "广发纳斯达克生物科技A", note: "QDII" },
    { code: "161127", name: "易方达标普生物科技A", note: "QDII-LOF" }
  ],

  // REITs
  "REITs": [
    { code: "000179", name: "广发美国房地产A", note: "QDII" },
    { code: "163208", name: "诺安全球收益不动产", note: "QDII" }
  ]
};

// QDII 政策收紧风险评估
var POLICY_RISK_LEVELS = {
  "纳指100": { risk: "高", reason: "美国科技股QDII长期受限，多家基金限购10元，暂停申购频繁", advice: "分散到不同基金公司，同时关注场内ETF" },
  "标普500": { risk: "中", reason: "标普500 QDII也有限购趋势，但比纳指宽松", advice: "保持关注，可适当配置场内ETF" },
  "港股": { risk: "低", reason: "港股QDII相对宽松，港股通ETF也是替代", advice: "可通过港股通ETF补充" },
  "全球精选": { risk: "中", reason: "主动管理型QDII额度有限，可能随时限购", advice: "分散到指数型QDII" },
  "亚太": { risk: "中", reason: "亚太QDII额度有限", advice: "关注港股通和场内ETF" },
  "石油": { risk: "中", reason: "商品类QDII政策敏感", advice: "场内商品ETF可替代" },
  "生物科技": { risk: "高", reason: "生物科技QDII长期限购", advice: "关注场内生物科技ETF" },
  "REITs": { risk: "中", reason: "REITs QDII额度有限", advice: "场内REITs ETF可替代" }
};

/**
 * 获取某类基金的替代方案
 * @param {string} type - 基金类型（如"纳指100"）
 * @param {string|null} excludeCode - 排除的基金代码（当前不可买的）
 * @returns {Array} 替代基金列表
 */
function getAlternatives(type, excludeCode) {
  var alternatives = ALTERNATIVES_MAP[type] || [];
  if (excludeCode) {
    alternatives = alternatives.filter(function(a) { return a.code !== excludeCode; });
  }
  return alternatives;
}

/**
 * 获取政策风险评估
 * @param {string} type - 基金类型
 * @returns {Object} 风险评估
 */
function getPolicyRisk(type) {
  return POLICY_RISK_LEVELS[type] || { risk: "未知", reason: "未收录该类型的风险信息", advice: "保持关注" };
}

/**
 * 分析不可买基金的替代方案
 * @param {Array} suspendedFunds - 不可买的基金列表
 * @returns {Array} 替代方案列表
 */
function analyzeAlternatives(suspendedFunds) {
  if (!suspendedFunds || suspendedFunds.length === 0) return [];

  var suggestions = [];
  for (var i = 0; i < suspendedFunds.length; i++) {
    var fund = suspendedFunds[i];
    var type = fund.type || "未知";
    var alternatives = getAlternatives(type, fund.code);
    var policyRisk = getPolicyRisk(type);

    if (alternatives.length > 0) {
      suggestions.push({
        fund: { code: fund.code, name: fund.name, type: type },
        alternatives: alternatives.slice(0, 3),
        policyRisk: policyRisk
      });
    }
  }
  return suggestions;
}

/**
 * 格式化替代方案报告（文本）
 */
function formatAlternativesReport(suspendedFunds) {
  var suggestions = analyzeAlternatives(suspendedFunds);
  if (suggestions.length === 0) return "";

  var lines = [];
  lines.push("--- QDII 替代方案 ---");
  lines.push("");

  for (var i = 0; i < suggestions.length; i++) {
    var s = suggestions[i];
    lines.push(s.fund.name + "(" + s.fund.code + ") \u4e0d\u53ef\u4e70");
    lines.push("  \u98ce\u9669\u7b49\u7ea7: " + s.policyRisk.risk + " | " + s.policyRisk.reason);
    lines.push("  \u5efa\u8bae: " + s.policyRisk.advice);
    lines.push("  \u66ff\u4ee3\u57fa\u91d1:");
    for (var j = 0; j < s.alternatives.length; j++) {
      var alt = s.alternatives[j];
      lines.push("    - " + alt.name + "(" + alt.code + ") " + alt.note);
    }
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * 生成政策风险总览
 * @param {Array} funds - 基金池
 * @returns {string} 风险报告
 */
function generatePolicyRiskOverview(funds) {
  var lines = [];
  lines.push("--- QDII 政策风险总览 ---");
  lines.push("");

  var typeGroups = {};
  for (var i = 0; i < funds.length; i++) {
    var type = funds[i].type || "其他";
    if (!typeGroups[type]) typeGroups[type] = { active: 0, suspended: 0, totalLimit: 0 };
    if (funds[i].status === "active") {
      typeGroups[type].active++;
      typeGroups[type].totalLimit += (funds[i].dailyLimit || 0);
    } else {
      typeGroups[type].suspended++;
    }
  }

  var types = Object.keys(typeGroups);
  for (var t = 0; t < types.length; t++) {
    var group = typeGroups[types[t]];
    var risk = getPolicyRisk(types[t]);
    var status = group.suspended > 0 ? "\u26a0\ufe0f" + group.suspended + "\u53ea\u505c\u8d2d" : "\u2705\u6b63\u5e38";
    lines.push(types[t] + ": " + status + " | \u98ce\u9669:" + risk.risk + " | \u603b\u9650\u989d:" + group.totalLimit + "\u5143/\u5929");
  }

  return lines.join("\n");
}

module.exports = {
  ALTERNATIVES_MAP: ALTERNATIVES_MAP,
  POLICY_RISK_LEVELS: POLICY_RISK_LEVELS,
  getAlternatives: getAlternatives,
  getPolicyRisk: getPolicyRisk,
  analyzeAlternatives: analyzeAlternatives,
  formatAlternativesReport: formatAlternativesReport,
  generatePolicyRiskOverview: generatePolicyRiskOverview
};
