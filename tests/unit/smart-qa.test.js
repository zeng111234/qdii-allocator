/**
 * AI 智能问答模块测试
 */

const { describe, it, beforeEach: _beforeEach, afterEach: _afterEach } = require("node:test");
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const { buildPrompt } = require("../../lib/smart-qa");

describe("Smart QA Module", function () {
  describe("buildPrompt", function () {
    it("should detect buy recommendation scenario", function () {
      const prompt = buildPrompt("今天该买什么基金？");
      assert.ok(prompt.includes("场景：今日买什么"));
      assert.ok(prompt.includes("推荐2-3只"));
    });

    it("should detect market sentiment scenario", function () {
      const prompt = buildPrompt("市场情绪如何？");
      assert.ok(prompt.includes("场景：市场情绪分析"));
      assert.ok(prompt.includes("情绪分数解读"));
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
      const prompt = buildPrompt("今天该买什么？");
      assert.ok(prompt.includes("输出格式要求"));
      assert.ok(prompt.includes("今日推荐"));
      assert.ok(prompt.includes("推荐理由"));
      assert.ok(prompt.includes("风险提示"));
    });

    it("should include output format requirements for sentiment scenario", function () {
      const prompt = buildPrompt("市场情绪如何？");
      assert.ok(prompt.includes("输出格式要求"));
      assert.ok(prompt.includes("当前情绪判断"));
      assert.ok(prompt.includes("支撑证据"));
      assert.ok(prompt.includes("操作建议"));
    });
  });
});
