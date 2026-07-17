/**
 * AI 智能问答模块测试
 */

const { describe, it, beforeEach: _beforeEach, afterEach: _afterEach } = require("node:test");
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const {
  askQuestion,
  buildPrompt,
  validateBuyAnswer,
  validateMarketSentimentAnswer
} = require("../../lib/smart-qa");

const PAUSE_PLAN = {
  asOf: "2026-07-17",
  action: "PAUSE",
  budget: 0,
  dataFreshness: { status: "FRESH", latestNavDate: "2026-07-16" },
  signalHealth: {
    status: "PAUSE",
    matured: { count: 30, winRate: 10, averageReturn: -2.5 },
    breakerTriggered: true
  },
  candidates: [
    { code: "017641", name: "摩根标普500指数(QDII)A", proposedAmount: 0 }
  ]
};

const BUY_PLAN = {
  asOf: "2026-07-17",
  action: "BUY",
  budget: 40,
  dataFreshness: { status: "FRESH", latestNavDate: "2026-07-16" },
  signalHealth: { status: "HEALTHY" },
  candidates: [
    { code: "017641", name: "摩根标普500指数(QDII)A", proposedAmount: 20 },
    { code: "096001", name: "大成标普500A(QDII)", proposedAmount: 20 }
  ]
};

describe("Smart QA Module", function () {
  describe("buildPrompt", function () {
    it("should detect buy recommendation scenario", function () {
      const prompt = buildPrompt("今天该买什么基金？", { recommendationPlan: PAUSE_PLAN });
      assert.ok(prompt.includes("场景：今日买什么"));
      assert.ok(prompt.includes("RecommendationPlan"));
      assert.ok(prompt.includes("action: PAUSE"));
      assert.ok(prompt.includes("预算: 0元"));
      assert.ok(prompt.includes("禁止推荐任何基金或金额"));
      assert.ok(!prompt.includes("推荐2-3只"));
      assert.ok(!prompt.includes("30-100元"));
    });

    it("should detect market sentiment scenario", function () {
      const prompt = buildPrompt("市场情绪如何？", { recommendationPlan: PAUSE_PLAN });
      assert.ok(prompt.includes("场景：市场情绪分析"));
      assert.ok(prompt.includes("情绪分数解读"));
      assert.ok(prompt.includes("市场情绪只作说明"));
      assert.ok(prompt.includes("不得据此触发买入、加仓"));
      assert.ok(!prompt.includes("偏悲观→可逢低加仓"));
      assert.ok(!prompt.includes("抄底"));
    });

    it("should detect portfolio analysis scenario", function () {
      const prompt = buildPrompt("帮我看看持仓风险");
      assert.ok(prompt.includes("用户持仓"));
    });

    it("should include market temperature", function () {
      const prompt = buildPrompt("今天买什么？");
      assert.ok(prompt.includes("市场温度"));
      assert.ok(prompt.includes("温度:"));
    });

    it("should include hypothesis stats", function () {
      const prompt = buildPrompt("今天买什么？");
      // 只有当假设数据存在时才包含
      const hypothesesPath = path.join(__dirname, "../../data/hypotheses.json");
      if (fs.existsSync(hypothesesPath)) {
        assert.ok(prompt.includes("假设追踪胜率"));
      }
    });

    it("should include external signals when data exists", function () {
      const prompt = buildPrompt("市场情绪如何？");
      // 只有当外部信号数据存在且非空时才包含
      const signalsPath = path.join(__dirname, "../../data/external-signals-cache.json");
      if (fs.existsSync(signalsPath)) {
        try {
          const signalsData = JSON.parse(fs.readFileSync(signalsPath, "utf8"));
          const signals = Array.isArray(signalsData) ? signalsData : signalsData.data || [];
          if (signals.length > 0) {
            assert.ok(prompt.includes("外部信号情绪"));
          }
          // 如果没有数据，prompt不应包含该部分
        } catch (e) {
          // 文件读取失败，跳过检查
        }
      }
    });

    it("should clean daily brief thinking chains", function () {
      const prompt = buildPrompt("今天买什么？");
      // 确保不包含思维链标签
      assert.ok(!prompt.includes("<think>"));
      // ANALYSIS_BLOCK标签应该被清理
      const dailyBriefPath = path.join(__dirname, "../../data/daily-brief.json");
      if (fs.existsSync(dailyBriefPath)) {
        try {
          const briefData = JSON.parse(fs.readFileSync(dailyBriefPath, "utf8"));
          if (briefData.content && briefData.content.includes("<ANALYSIS_BLOCK>")) {
            // 如果原始内容包含ANALYSIS_BLOCK，清理后的prompt不应包含
            assert.ok(!prompt.includes("<ANALYSIS_BLOCK>"));
          }
        } catch (e) {
          // 文件读取失败，跳过检查
        }
      }
    });

    it("should include output format requirements for buy scenario", function () {
      const prompt = buildPrompt("今天该买什么？", { recommendationPlan: BUY_PLAN });
      assert.ok(prompt.includes("输出格式要求"));
      assert.ok(prompt.includes('"action":"BUY"'));
      assert.ok(prompt.includes("017641"));
      assert.ok(prompt.includes("20元"));
      assert.ok(prompt.includes("不得新增基金或修改金额"));
    });

    it("should include output format requirements for sentiment scenario", function () {
      const prompt = buildPrompt("市场情绪如何？", { recommendationPlan: PAUSE_PLAN });
      assert.ok(prompt.includes("输出格式要求"));
      assert.ok(prompt.includes("当前情绪判断"));
      assert.ok(prompt.includes("支撑证据"));
      assert.ok(prompt.includes("与交易计划的关系"));
      assert.ok(!prompt.includes("具体买入/卖出/观望建议"));
    });
  });

  describe("deterministic RecommendationPlan enforcement", function () {
    it("bypasses the LLM for buy questions while PAUSE is active", async function () {
      let calls = 0;
      const result = await askQuestion("今天该买什么？", null, {
        recommendationPlan: PAUSE_PLAN,
        callLLM: async function () {
          calls++;
          return "建议买入017641，金额50元";
        }
      });

      assert.equal(calls, 0);
      assert.match(result.answer, /今天不买/);
      assert.match(result.answer, /预算为0元/);
      assert.match(result.answer, /胜率10%/);
      assert.doesNotMatch(result.answer, /建议买入/);
    });

    it("accepts only exact BUY candidates and proposed amounts", function () {
      const valid = validateBuyAnswer(
        BUY_PLAN,
        JSON.stringify({
          action: "BUY",
          candidates: [
            { code: "017641", proposedAmount: 20, explanation: "计划内候选" },
            { code: "096001", proposedAmount: 20, explanation: "计划内候选" }
          ],
          summary: "仅解释确定性计划"
        })
      );
      assert.equal(valid.valid, true);

      const extraFund = validateBuyAnswer(
        BUY_PLAN,
        JSON.stringify({
          action: "BUY",
          candidates: [{ code: "000001", proposedAmount: 20 }],
          summary: "新增基金"
        })
      );
      assert.equal(extraFund.valid, false);

      const changedAmount = validateBuyAnswer(
        BUY_PLAN,
        JSON.stringify({
          action: "BUY",
          candidates: [
            { code: "017641", proposedAmount: 30 },
            { code: "096001", proposedAmount: 10 }
          ]
        })
      );
      assert.equal(changedAmount.valid, false);
    });

    it("rejects market-sentiment answers that trigger trading", function () {
      assert.equal(validateMarketSentimentAnswer("当前偏悲观，建议逢低加仓").valid, false);
      assert.equal(validateMarketSentimentAnswer("当前情绪中性，仅作市场背景说明").valid, true);
    });

    it("replaces unsafe market-sentiment output with a deterministic disclaimer", async function () {
      const result = await askQuestion("市场情绪如何？", null, {
        recommendationPlan: PAUSE_PLAN,
        callLLM: async function () { return "现在适合抄底并加仓50元"; }
      });

      assert.match(result.answer, /市场情绪仅作说明/);
      assert.match(result.answer, /PAUSE/);
      assert.match(result.answer, /预算0元/);
      assert.doesNotMatch(result.answer, /加仓50元/);
    });
  });
});
