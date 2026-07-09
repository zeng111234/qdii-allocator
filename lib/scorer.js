/**
 * 基金评分系统
 * 包含评分权重、评分函数、排名策略和轮动机制
 */

const { scoreFundExternalSignal } = require("./external-signals");
const { round1, round2 } = require("./utils");

/**
 * 评分权重体系（面向A类长线投资）
 * 核心逻辑：长期表现 > 短期信号
 */
const WEIGHTS = {
  base: 10,
  // 长期因子（降低追涨权重，避免历史赢家统治排名）
  yearReturn: 0.03,         // 1年收益率（从0.06降到0.03，减少追涨）
  threeYearReturn: 0.1,     // 3年累计收益（从0.2降到0.1，减少历史赢家优势）
  sharpeRatio: 1.5,         // 夏普比率（从2.5降到1.5，避免单一因子统治）
  maxDrawdown: 0.2,         // 最大回撤惩罚（从0.15提到0.2，更重视风险控制）
  longTermBull: 2.0,        // 长期牛市趋势加分（从3降到2，减少滞后信号影响）
  longTermBear: -3.0,       // 长期熊市趋势扣分（从-4调到-3，与牛市对称）
  stabilityBonus: 2.5,      // 稳定收益加分

  // 中期因子
  drawdown: 3.0,            // 近期回撤（鼓励买跌不买涨）
  maDeviation: 2.5,         // MA10偏离（惩罚追高）
  trendBonus: 2.0,          // 多头排列加分
  trendPenalty: -2.5,       // 空头排列扣分
  momentumReversal: 2.0,    // 连续下跌后阳线反弹

  // 短期因子
  recent5Change: -0.3,      // 5日涨跌（低权重，短期波动不应主导）
  volatility: -0.8,         // 波动率惩罚（从-0.5提到-0.8，更重视稳定性）

  // 过热回调因子（降低门槛，加大惩罚）
  overheat30d: -0.8,        // 30日涨超10%过热扣分（从-0.4加倍）
  overheat60d: -0.6,        // 60日涨超18%过热扣分（从-0.3加倍）
  overheat90d: -0.4,        // 90日涨超25%过热扣分（从-0.2加倍）

  // 辅助因子
  historicalSuccess: 1.0,   // 历史推荐成功率
  feePenalty: -0.8,         // 费率惩罚
  rotationPenalty: -0.8,    // 连续推荐惩罚（降低权重避免过度轮换）
  premiumPenalty: -3.0,     // 溢价>3%惩罚
  scarcityBonus: 0.0,       // 限购加分（设为0，限购不代表基金好）
  unknownPenalty: -3.0,     // 信息未知惩罚
  suspended: -999,

  // 估值因子（新增，面向长期持有者）
  valuationBonus: 2.0,      // PE便宜加分
  valuationPenalty: -3.0,   // PE很贵扣分
  vixFearBonus: 1.5,        // VIX恐慌逆向加分
  vixGreedPenalty: -2.0,     // VIX贪婪扣分

  // 高点距离惩罚（防止追高）
  peakPenalty: -3.0          // 距离历史高点<5%时扣分（从-2.0加到-3.0）
};

function scoreFund(fund, indicators, historyContext, recentPicks, premiumInfo, externalSignals, externalSignalMaxScore, options) {
  if (fund.status !== "active" || fund.dailyLimit <= 0) {
    return { score: WEIGHTS.suspended, reason: fund.status === "suspended" ? "\u6682\u505c\u7533\u8d2d" : "\u9650\u989d\u4e3a0", indicators };
  }

  // 数据不足直接排除
  if (indicators.error || !indicators.dataPoints || indicators.dataPoints < 60) {
    return { score: -1, reason: "\u6570\u636e\u4e0d\u8db3\uff08" + (indicators.dataPoints || 0) + "\u65e5\uff09\uff0c\u6392\u9664\u63a8\u8350", indicators };
  }

  let score = WEIGHTS.base;
  const reasons = [];

  // API获取失败时使用默认值继续评分（不排除）
  if (fund._purchaseStatus === "unknown") {
    reasons.push("\u9650\u8d2dAPI\u5931\u8d25\uff0c\u4f7f\u7528\u9ed8\u8ba4\u503c");
  }

  // ========== 长期因子（核心） ==========

  // 1年收益率（优先使用API数据 SYL_1N）
  const yr = (premiumInfo && premiumInfo.yearReturn !== null && premiumInfo.yearReturn !== undefined) ? premiumInfo.yearReturn : (indicators.annualizedReturn !== null ? indicators.annualizedReturn : indicators.yearReturn);
  if (yr && yr !== 0) {
    const yrScore = yr * WEIGHTS.yearReturn;
    score += yrScore;
    if (Math.abs(yrScore) > 0.3) {
      if (yrScore > 0) reasons.push("1\u5e74\u6da8" + yr + "%\u52a0" + round1(yrScore) + "\u5206");
      else reasons.push("1\u5e74\u8dcc" + Math.abs(yr) + "%\u6263" + round1(Math.abs(yrScore)) + "\u5206");
    }
  }

  // 3年累计收益（优先使用API数据 SYL_3N）
  const y3 = (premiumInfo && premiumInfo.threeYearReturn !== null && premiumInfo.threeYearReturn !== undefined) ? premiumInfo.threeYearReturn : indicators.threeYearReturn;
  if (y3 && y3 !== 0) {
    const y3Score = (y3 / 3) * WEIGHTS.threeYearReturn;
    score += y3Score;
    if (Math.abs(y3Score) > 0.3) {
      if (y3Score > 0) reasons.push("3\u5e74\u7d2f\u8ba1" + y3 + "%\u52a0" + round1(y3Score) + "\u5206");
      else reasons.push("3\u5e74\u7d2f\u8ba1" + Math.abs(y3) + "%\u6263" + round1(Math.abs(y3Score)) + "\u5206");
    }
  }

  // 夏普比率（关键指标 - 风险调整后收益）
  if (indicators.sharpeRatio !== null) {
    const sharpeScore = indicators.sharpeRatio * WEIGHTS.sharpeRatio;
    score += sharpeScore;
    if (Math.abs(sharpeScore) > 0.5) {
      if (sharpeScore > 0) reasons.push("\u590f\u666e" + indicators.sharpeRatio + "\u52a0" + round1(sharpeScore) + "\u5206");
      else reasons.push("\u590f\u666e" + indicators.sharpeRatio + "\u6263" + round1(Math.abs(sharpeScore)) + "\u5206");
    }
  }

  // 最大回撤惩罚
  if (indicators.maxDrawdown !== null && indicators.maxDrawdown < 0) {
    const ddPenalty = Math.abs(indicators.maxDrawdown) * WEIGHTS.maxDrawdown;
    score -= ddPenalty;
    if (ddPenalty > 1) reasons.push("\u6700\u5927\u56de\u64a4" + indicators.maxDrawdown + "%\u6263" + round1(ddPenalty) + "\u5206");
  }

  // 长期趋势
  if (indicators.longTermTrend === "bull") {
    score += WEIGHTS.longTermBull;
    reasons.push("\u957f\u671f\u725b\u5e02+" + WEIGHTS.longTermBull + "\u5206");
  } else if (indicators.longTermTrend === "bear") {
    score += WEIGHTS.longTermBear;
    reasons.push("\u957f\u671f\u718a\u5e02" + WEIGHTS.longTermBear + "\u5206");
  }

  // ========== 中期因子 ==========

  // 回撤因子（回撤越小越好：-20%以内加分，超过-20%扣分）
  const drawdownScore = (20 + indicators.drawdown) * WEIGHTS.drawdown * 0.05;
  score += drawdownScore;
  if (drawdownScore > 0.5) reasons.push("回撤" + Math.abs(indicators.drawdown) + "%加" + round1(drawdownScore) + "分");
  else if (drawdownScore < -0.5) reasons.push("回撤" + Math.abs(indicators.drawdown) + "%大扣" + round1(Math.abs(drawdownScore)) + "分");

  // MA偏离因子（取反：低于均线更值得买）
  const maScore = -indicators.maDeviation * WEIGHTS.maDeviation;
  score += maScore;
  if (maScore > 0.5) reasons.push("低于MA10加" + round1(maScore) + "分");
  else if (maScore < -0.5) reasons.push("高于MA10扣" + round1(Math.abs(maScore)) + "分");

  // 趋势强度（多头/空头排列）
  if (indicators.navs && indicators.navs.length >= 20) {
    const navs = indicators.navs;
    const calcMa = function(arr, n) {
      const slice = arr.slice(-n);
      return slice.reduce(function(a,b){return a+b;},0) / slice.length;
    };
    const ma5Val = calcMa(navs, 5);
    const ma10Val = calcMa(navs, 10);
    const ma20Val = calcMa(navs, 20);

    if (ma5Val > ma10Val && ma10Val > ma20Val) {
      score += WEIGHTS.trendBonus;
      reasons.push("\u591a\u5934\u6392\u5217+" + WEIGHTS.trendBonus + "\u5206");
    } else if (ma5Val < ma10Val && ma10Val < ma20Val) {
      score += WEIGHTS.trendPenalty;
      reasons.push("\u7a7a\u5934\u6392\u5217" + WEIGHTS.trendPenalty + "\u5206");
    }

    // 动量反转信号
    if (navs.length >= 5) {
      let last3Down = true;
      const todayUp = navs[navs.length-1] > navs[navs.length-2];
      for (let k = navs.length - 4; k < navs.length - 1; k++) {
        if (navs[k] >= navs[k-1]) { last3Down = false; break; }
      }
      if (last3Down && todayUp) {
        score += WEIGHTS.momentumReversal;
        reasons.push("\u53cd\u8f6c\u4fe1\u53f7+" + WEIGHTS.momentumReversal + "\u5206");
      }
    }
  }

  // ========== 过热回调因子（防止追高，QDII基金阈值适当放宽） ==========
  if (indicators.recent30Change && indicators.recent30Change > 15) {
    const overheat30 = (indicators.recent30Change - 15) * WEIGHTS.overheat30d;
    score += overheat30;
    if (overheat30 < -0.5) reasons.push("30日涨" + round1(indicators.recent30Change) + "%过热" + round1(overheat30) + "分");
  }
  if (indicators.recent60Change && indicators.recent60Change > 30) {
    const overheat60 = (indicators.recent60Change - 30) * WEIGHTS.overheat60d;
    score += overheat60;
    if (overheat60 < -0.5) reasons.push("60日涨" + round1(indicators.recent60Change) + "%过热" + round1(overheat60) + "分");
  }
  if (indicators.recent90Change && indicators.recent90Change > 40) {
    const overheat90 = (indicators.recent90Change - 40) * WEIGHTS.overheat90d;
    score += overheat90;
    if (overheat90 < -0.5) reasons.push("90日涨" + round1(indicators.recent90Change) + "%过热" + round1(overheat90) + "分");
  }

  // ========== 高点距离惩罚（防止追高） ==========
  if (indicators.peakDistance !== null && indicators.peakDistance !== undefined) {
    if (indicators.peakDistance > -5) {
      // 距离历史高点不到5%，扣分
      score += WEIGHTS.peakPenalty;
      reasons.push("近高点" + round1(indicators.peakDistance) + "%" + WEIGHTS.peakPenalty + "分");
    } else if (indicators.peakDistance > -10) {
      // 距离历史高点不到10%，减半扣分
      score += WEIGHTS.peakPenalty * 0.5;
      reasons.push("近高点" + round1(indicators.peakDistance) + "%" + round1(WEIGHTS.peakPenalty * 0.5) + "分");
    }
  }

  // ========== 短期因子（低权重） ==========

  // 5日涨跌
  const change5Score = indicators.recent5Change * WEIGHTS.recent5Change;
  score += change5Score;
  if (change5Score < -1) reasons.push("5\u65e5\u6da8" + indicators.recent5Change + "%\u6263" + round1(Math.abs(change5Score)) + "\u5206");

  // 波动率
  const volScore = indicators.volatility * WEIGHTS.volatility;
  score += volScore;
  if (volScore < -0.5) reasons.push("\u6ce2\u52a8" + indicators.volatility + "%\u6263" + round1(Math.abs(volScore)) + "\u5206");

  // ========== 辅助因子 ==========

  // 历史推荐成功率（>=3次推荐才计入，亏钱扣分，赚钱加分）
  if (historyContext && historyContext.successRate !== undefined && historyContext.appearances >= 3) {
    const histBonus = (historyContext.successRate - 0.5) * 2 * WEIGHTS.historicalSuccess;
    score += histBonus;
    if (histBonus > 0.3) reasons.push("\u5386\u53f2\u6210\u529f\u7387" + round1(historyContext.successRate * 100) + "%\u52a0" + round1(histBonus) + "\u5206");
    else if (histBonus < -0.3) reasons.push("\u5386\u53f2\u63a8\u8350\u4e8f\u94b1" + round1((1 - historyContext.successRate) * 100) + "%\u6263" + round1(Math.abs(histBonus)) + "\u5206");
  }

  // 费率惩罚
  if (fund.feeRate && fund.feeRate > 0) {
    const feeScore = fund.feeRate * WEIGHTS.feePenalty;
    score += feeScore;
    if (Math.abs(feeScore) > 0.3) reasons.push("\u8d39\u7387" + fund.feeRate + "%\u6263" + round1(Math.abs(feeScore)) + "\u5206");
  }

  // 轮换惩罚
  if (recentPicks && recentPicks[fund.code]) {
    const consecutiveDays = recentPicks[fund.code];
    const rotPenalty = consecutiveDays * WEIGHTS.rotationPenalty;
    score += rotPenalty;
    if (consecutiveDays >= 1) reasons.push("\u8fde\u7eed\u63a8\u8350" + consecutiveDays + "\u5929\u6263" + round1(Math.abs(rotPenalty)) + "\u5206");
  }

  // 稳定性加分：波动率低 + 正收益 = 稳定赚钱
  if (yr && yr > 0 && indicators.volatility < 2.0) {
    const stabScore = WEIGHTS.stabilityBonus * (2.0 - indicators.volatility) / 2.0;
    score += stabScore;
    if (stabScore > 0.5) reasons.push("\u7a33\u5b9a\u6536\u76ca+" + round1(stabScore) + "\u5206");
  }

  // 溢价率惩罚
  if (premiumInfo && premiumInfo.premiumRate > 3) {
    score += WEIGHTS.premiumPenalty;
    reasons.push("\u6ea2\u4ef7" + premiumInfo.premiumRate + "%\u6263" + Math.abs(WEIGHTS.premiumPenalty) + "\u5206");
  }

  // 稀缺度加分：限购越低说明需求越大（市场认可度高）
  if (fund.dailyLimit && fund.dailyLimit > 0 && fund.dailyLimit <= 100) {
    score += WEIGHTS.scarcityBonus;
    reasons.push("限购" + fund.dailyLimit + "元加" + WEIGHTS.scarcityBonus + "分");
  }

  // [fix] 弱化外部信号：从±3降到±0.5，一个大V的观点不应主导投资决策
  const externalSignal = scoreFundExternalSignal(fund, externalSignals, Math.min(externalSignalMaxScore || 3, 0.5));
  if (externalSignal.score !== 0) {
    score += externalSignal.score;
    reasons.push("外部信号 " + (externalSignal.score > 0 ? "+" : "") + externalSignal.score + "分" + (externalSignal.matches && externalSignal.matches.length > 0 ? "(" + externalSignal.matches.join("/") + ")" : ""));
  }

  // 新闻情绪评分（从 getNewsSentiment 获取的主题情绪）
  if (options && options.newsSentiment && options.newsSentiment.byTheme) {
    const ns = options.newsSentiment;
    // [修复] 原问题：主题映射不完整，"德国"错误映射到"bonds"
    const typeThemeMap = {
      "纳指100": "nasdaq", "纳指生物科技": "nasdaq", "纳斯达克": "nasdaq", "纳指科技": "nasdaq",
      "标普500": "sp500", "标普REITs": "sp500", "标普科技": "sp500",
      "港股精选": "hongkong", "亚太精选": "hongkong", "恒生指数": "hongkong",
      "石油能源": "oil", "全球石油": "oil", "大宗商品": "oil",
      "美国REITs": "reit", "全球不动产": "reit",
      "德国": "europe", "英国": "europe",
      "日本": "japan",
      "全球债券": "bonds", "亚洲债": "bonds",
      "全球科技": "globalTech", "全球成长": "globalTech", "全球精选": "globalTech",
      "新能源车": "nasdaq", "全球制造": "globalTech", "新兴市场": "hongkong"
    };
    const fundType = fund.type || "";
    const theme = typeThemeMap[fundType] || null;
    if (theme && ns.byTheme[theme]) {
      const themeData = ns.byTheme[theme];
      const themeScore = themeData.positive - themeData.negative;
      const newsPts = Math.round(Math.max(-2, Math.min(2, themeScore * 0.5)));
      if (newsPts !== 0) {
        score += newsPts;
        reasons.push("新闻" + theme + (newsPts > 0 ? "+" : "") + newsPts + "分");
      }
    }
    // 整体市场情绪也影响
    if (ns.overall !== 0) {
      const overallPts = Math.round(Math.max(-1, Math.min(1, ns.overall / 50)));
      if (overallPts !== 0) {
        score += overallPts;
        reasons.push("市场情绪" + (overallPts > 0 ? "+" : "") + overallPts + "分");
      }
    }
  }

  // ========== 估值评分（新增，面向长期持有者） ==========
  if (options && options.valuationData) {
    const vd = options.valuationData;
    const fundType = fund.type || "";

    // VIX 恐慌/贪婪指标（逆向思维）
    if (vd.vix !== null) {
      if (vd.vix >= 30) {
        score += WEIGHTS.vixFearBonus;
        reasons.push("VIX恐慌" + round1(vd.vix) + "逆向加" + WEIGHTS.vixFearBonus + "分");
      } else if (vd.vix <= 12) {
        score += WEIGHTS.vixGreedPenalty;
        reasons.push("VIX贪婪" + round1(vd.vix) + "减" + Math.abs(WEIGHTS.vixGreedPenalty) + "分");
      }
    }

    // 指数PE估值评分
    const ndxPe = vd.indices && vd.indices.NDX ? vd.indices.NDX.pe : null;
    const spxPe = vd.indices && vd.indices.SPX ? vd.indices.SPX.pe : null;

    let targetPe = null;
    const isNasdaq = fundType.indexOf("纳指") >= 0 || fundType.indexOf("纳斯达克") >= 0;
    const isSp500 = fundType.indexOf("标普") >= 0;
    if (isNasdaq && ndxPe) targetPe = ndxPe;
    else if (isSp500 && spxPe) targetPe = spxPe;
    else if (ndxPe && spxPe) targetPe = (ndxPe + spxPe) / 2;

    if (targetPe !== null && targetPe > 0) {
      if (targetPe < 18) {
        score += WEIGHTS.valuationBonus;
        reasons.push("PE=" + round1(targetPe) + "便宜+" + WEIGHTS.valuationBonus + "分");
      } else if (targetPe > 30) {
        score += WEIGHTS.valuationPenalty;
        reasons.push("PE=" + round1(targetPe) + "很贵" + WEIGHTS.valuationPenalty + "分");
      } else if (targetPe > 25) {
        score += WEIGHTS.valuationPenalty * 0.5;
        reasons.push("PE=" + round1(targetPe) + "偏贵" + round1(WEIGHTS.valuationPenalty * 0.5) + "分");
      }
    }
  }

  score = Math.max(0.1, score);
  return { score: round2(score), reason: reasons.length > 0 ? reasons.join("\uff0c") : "\u6b63\u5e38\u8bc4\u5206", indicators, externalSignal: externalSignal };
}

/**
 * TopN排名策略：输出排名前N的基金（不分配金额）
 * 用户自行决定买入金额
 * [改进] 同一底层指数只保留最高分一只，同类品类最多3只
 */
// 品类映射（用于品类上限控制）
const CATEGORY_MAP = {
  '纳指100': '美股科技', '纳指生物科技': '美股科技', '纳指科技': '美股科技',
  '标普500': '美股宽基', '标普科技': '美股宽基', '标普消费': '美股宽基', '标普医疗': '美股宽基',
  '美股消费': '美股宽基',
  '全球精选': '全球', '全球股票': '全球', '全球蓝筹': '全球', '全球科技': '全球',
  '全球成长': '全球', '全球制造': '全球', '全球资源': '全球', '全球医疗': '全球', '全球产业升级': '全球',
  '亚太精选': '亚太', '亚太': '亚太', '新兴市场': '亚太', '越南': '亚太',
  '港股精选': '港股', '港股优选': '港股', '恒生指数': '港股',
  '德国': '欧洲',
  '石油能源': '商品', '大宗商品': '商品', '黄金': '商品',
  '美国REITs': 'REITs', '标普REITs': 'REITs', '全球不动产': 'REITs',
  '亚洲债': '债券', '亚洲债券': '债券',
  '新能源车': '主题',
  '日本': '日本'
};
// 相关性分组：底层资产高度重叠的品类合并控制（防止"看似分散实则集中"）
const CORRELATION_GROUPS = {
  '美股科技': '美股', '美股宽基': '美股',  // 纳指≈标普，底层都是美股大盘科技
  '全球': '美股',   // "全球精选/科技/成长"实际重仓美股科技
  '主题': '美股'    // 新能源车等主题也偏美股
};
const MAX_PER_CATEGORY = 3;
const MAX_PER_CORRELATION_GROUP = 5; // 相关性分组内最多5只

function rankTopN(scoredFunds, topN, minPurchase) {
  if (!topN) topN = 10;
  if (!minPurchase) minPurchase = 10;

  // 过滤掉得分<=0的（包括数据不足被排除的）
  const available = scoredFunds.filter(f => f.score > 0);
  if (available.length === 0) return [];

  // 按得分降序排列
  available.sort(function(a,b) { return b.score - a.score; });

  // 指数去重 + 品类上限 + 相关性分组上限
  const usedIndexGroups = {};
  const categoryCounts = {};
  const corrGroupCounts = {};
  const top = [];

  for (let i = 0; i < available.length; i++) {
    const fund = available[i];
    if (top.length >= topN) break;

    // 指数去重：同一 indexGroup 只保留得分最高的第一只
    const ig = fund.indexGroup;
    if (ig && usedIndexGroups[ig]) continue;

    // 品类上限：同一品类最多 MAX_PER_CATEGORY 只
    const category = CATEGORY_MAP[fund.type] || fund.type || '其他';
    if (!categoryCounts[category]) categoryCounts[category] = 0;
    if (categoryCounts[category] >= MAX_PER_CATEGORY) continue;

    // 相关性分组上限：防止美股科技+美股宽基+全球科技全部推满
    const corrGroup = CORRELATION_GROUPS[category] || category;
    if (!corrGroupCounts[corrGroup]) corrGroupCounts[corrGroup] = 0;
    if (corrGroupCounts[corrGroup] >= MAX_PER_CORRELATION_GROUP) continue;

    // 通过筛选，加入结果
    top.push(fund);
    if (ig) usedIndexGroups[ig] = true;
    categoryCounts[category]++;
    corrGroupCounts[corrGroup]++;
  }

  // 标注排名
  top.forEach(function(item, idx) {
    item.rank = idx + 1;
  });

  return top;
}

/**
 * 轮动机制：在同档基金中优先推荐未被连续推荐过的
 * 避免同一只基金连续多天被推荐
 */
function applyRotation(available, recentPicks, topN) {
  if (!recentPicks || available.length <= topN) return available;

  // 按得分排序
  available.sort(function(a,b) { return b.score - a.score; });

  // 找到得分相近的组（差距<2分的基金视为同档）
  const groups = [];
  let currentGroup = [available[0]];
  for (let i = 1; i < available.length; i++) {
    if (available[i].score >= currentGroup[currentGroup.length - 1].score - 2) {
      currentGroup.push(available[i]);
    } else {
      groups.push(currentGroup);
      currentGroup = [available[i]];
    }
  }
  if (currentGroup.length > 0) groups.push(currentGroup);

  // 对每组内部做轮动：连续推荐>=2天的基金降权，让同组其他基金上位
  let result = [];
  for (let g = 0; g < groups.length; g++) {
    const group = groups[g];
    // 在组内，被连续推荐多次的放后面
    group.sort(function(a, b) {
      const aPenalty = (recentPicks[a.code] || 0) >= 2 ? 100 : 0;
      const bPenalty = (recentPicks[b.code] || 0) >= 2 ? 100 : 0;
      if (aPenalty !== bPenalty) return aPenalty - bPenalty;
      // 相同轮换惩罚时，按得分降序（稳定排序）
      if (Math.abs(a.score - b.score) > 0.001) return b.score - a.score;
      // 得分完全相同时，按基金代码字典序（保证确定性）
      return (a.code || "").localeCompare(b.code || "");
    });
    result = result.concat(group);
  }

  return result;
}

module.exports = { WEIGHTS, scoreFund, rankTopN, applyRotation };
