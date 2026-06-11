# AI Assistant Skill

AI 投资助手技能，支持多种 AI 功能。

## 触发条件

用户说以下任意一种：
- 早报 / 今日早报 / 生成早报
- 深度分析 / 分析基金
- 问AI / 问一下 / 帮我问
- 预警 / 风险预警

## 执行步骤

### 早报功能
1. 调用 `lib/daily-brief.js` 的 `generateDailyBrief`
2. 输出早报内容

### 深度分析
1. 调用 `lib/fund-deep-dive.js` 的 `analyzeAllHoldings`
2. 输出分析报告

### 智能问答
1. 调用 `lib/smart-qa.js` 的 `askQuestion`
2. 输出回答

### 风险预警
1. 调用 `lib/risk-alert.js` 的 `checkAndAlert`
2. 输出预警信息

## 注意事项

- 需要配置 LLM_API_KEY 环境变量
- MiMo 模型响应时间约 2-5 秒
- 每次调用消耗约 1000-2000 tokens
