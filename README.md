<div align="center">

# 🛩️ QDII Pilot

### AI 驱动的 QDII 基金智能投资系统

**每天自动告诉你：今天该买哪只基金、各买多少、为什么这么买。**

[![GitHub Stars](https://img.shields.io/github/stars/zeng111234/qdii-allocator?style=social)](https://github.com/zeng111234/qdii-allocator/stargazers)
[![License](https://img.shields.io/github/license/zeng111234/qdii-allocator)](https://github.com/zeng111234/qdii-allocator/blob/main/LICENSE)
[![GitHub Actions](https://img.shields.io/github/actions/workflow/status/zeng111234/qdii-allocator/daily-plan.yml?label=daily%20run)](https://github.com/zeng111234/qdii-allocator/actions)
[![Node.js](https://img.shields.io/badge/Node.js-20+-green)](https://nodejs.org/)

<br/>

📸 **[在线 Demo](https://zeng111234.github.io/qdii-allocator/)** · 🚀 **[快速开始](#-快速开始)** · 📊 **[功能详解](#-核心功能)**

</div>

---

## 🤔 为什么做这个？

买 QDII 基金的人都知道这些痛点：

| 痛点 | QDII Pilot 的解法 |
|------|------------------|
| 每天限购 100~1000 元，额度稀缺 | 🧠 智能评估每只基金的稀缺度，优先买最值得的 |
| 10+ 只基金，预算怎么分？ | 📊 一键算出最优分配方案 |
| 什么时候买？买多少？ | 🤖 综合净值走势 + Twitter 情绪 + AI 判断，每天自动推荐 |
| 手动记账太麻烦 | 💰 自动追踪持仓、计算盈亏、评估组合风险 |
| 忘了看限购变化 | ⚡ 自动监控申购状态，暂停/恢复第一时间提醒 |

**不用盯盘，不用算，打开邮箱就有答案。**

---

## 📸 截图

<table>
  <tr>
    <td align="center"><b>投资仪表盘</b></td>
    <td align="center"><b>基金评分系统</b></td>
    <td align="center"><b>新闻情绪 & 外部信号</b></td>
  </tr>
  <tr>
    <td><img src="docs/images/dashboard.png" width="320" /></td>
    <td><img src="docs/images/scoring.png" width="320" /></td>
    <td><img src="docs/images/news-signals.png" width="320" /></td>
  </tr>
</table>

---

## ✨ 核心功能

| 功能 | 说明 |
|------|------|
| 🧠 **智能排名** | 4 种策略自动评估每只基金，综合净值走势、Twitter 情绪、AI 判断推荐 Top 基金 |
| 💰 **持仓追踪** | 记录每笔买入，自动计算盈亏、成本、当前市值，支持多次买入同一基金 |
| 🛡️ **组合风控** | 相关性分析、夏普比率、最大回撤、健康度评分（0-100） |
| 📊 **回测验证** | 历史回测 + 走步回测（滚动窗口验证，防止策略过拟合） |
| 🔬 **假设追踪** | 每次推荐自动创建投资假设，追踪 3/7/14/30 日收益，统计胜率 |
| 🤖 **AI 决策** | LLM 综合分析市场数据 + 持仓状态，生成个性化投资报告 |
| 🐂🐻 **多智能体辩论** | Bull/Bear 辩论机制，多视角分析避免单一偏见 |
| 🌐 **外部信号** | 抓取 X/Twitter 大V 观点，分析看涨/看跌情绪 |
| 📧 **邮件推送** | 每天自动发投资计划到邮箱，含排名、持仓、风控、AI 报告 |
| 📱 **手机买入** | `/quick` 手机优化页面，输入 `270042 10` 一键下单 |
| ⚡ **零服务器** | GitHub Actions 每天定时自动运行，不用自己运维 |

---

## 🚀 快速开始

### 1. 克隆 & 安装

```bash
git clone https://github.com/zeng111234/qdii-allocator.git
cd qdii-allocator
npm install
```

### 2. 配置

```bash
cp .env.example .env
```

编辑 `.env`：

| 配置项 | 说明 | 必填 |
|--------|------|------|
| `SMTP_HOST` | SMTP 服务器 | ✅ |
| `SMTP_USER` | 发件邮箱 | ✅ |
| `SMTP_PASS` | SMTP 授权码 | ✅ |
| `MAIL_TO` | 收件邮箱 | ✅ |
| `LLM_API_KEY` | AI API 密钥 | 可选 |
| `LLM_BASE_URL` | AI 接口地址 | 可选 |
| `LLM_MODEL` | 模型名 | 可选 |

### 3. 试运行

```bash
# 不发邮件，只看推荐结果
node index.js --dry-run

# 指定预算和策略
node index.js --dry-run --budget 30 --strategy dynamic
```

### 4. 部署到 GitHub Actions（零成本自动化）

1. 推送代码到 GitHub
2. 进入仓库 `Settings > Secrets and variables > Actions`
3. 添加上面表格中的 Secrets
4. 每天自动运行 🎉

---

## 📖 使用指南

### 每日推荐

```bash
# 查看今日推荐
node index.js --today

# 查看推荐 + 快捷买入指令
node index.js --today --quick
```

### 持仓管理

```bash
# 查看当前持仓
node index.js --portfolio

# 记录买入
node index.js --buy 270042 10
node index.js --buy 270042 10 2025-05-28           # 指定日期
node index.js --buy 270042 10 8.5243 2025-05-28    # 指定净值和日期

# 批量导入
node index.js --import-file data/buys.txt
```

### 回测 & 优化

```bash
# 策略回测
node index.js --backtest --backtest-days 120

# 走步回测（推荐，防过拟合）
node index.js --walk-forward

# 自动优化评分权重
node index.js --optimize-weights
```

### 假设追踪

```bash
# 查看投资假设报告
node index.js --hypotheses
```

### Web 界面

```bash
# 启动 Web 界面
node index.js --web

# 手机访问：http://你的IP:3000/quick
```

---

## 🌐 部署方式

### 方式一：GitHub Pages（推荐，零成本）

项目内置了 GitHub Pages 构建脚本，每天自动更新数据：

1. 进入仓库 `Settings > Pages`
2. Source 选择 `Deploy from a branch`，分支选 `main`，目录选 `/docs`
3. 保存后，访问 `https://你的用户名.github.io/qdii-allocator/`

**自动更新**：GitHub Actions 每天运行后会自动构建并推送数据到 `docs/`，你的在线 Demo 永远是最新状态。

### 方式二：本地 Web 界面

```bash
# 启动 Web 管理界面（电脑访问）
node index.js --web

# 或双击启动
web.bat
```

浏览器打开 `http://localhost:3000`，手机同 WiFi 访问 `http://你的IP:3000`

### 方式三：手机快捷买入

```bash
# 手机浏览器访问
http://你的IP:3000/quick
```

专为手机设计的页面：
- 顶部：持仓概览（总投入/市值/盈亏）
- 中部：快捷按钮（已持有的基金一键买入）
- 底部：输入框，输入 `270042 10` 即可买入

> 💡 **推荐**：GitHub Pages 作为公开看板，本地 Web 界面用来管理持仓和录入买入。

---

## 🏗️ 技术架构

```
qdii-allocator/
├── index.js                    # CLI 主入口
├── lib/
│   ├── allocator.js            # 基础分配算法
│   ├── dynamic-strategy.js     # 智能动态策略（核心）
│   ├── scorer.js               # 10 维评分系统
│   ├── ai-analyst.js           # LLM 分析模块
│   ├── hypothesis-engine.js    # 假设追踪引擎
│   ├── walk-forward.js         # 走步回测验证
│   ├── portfolio.js            # 持仓追踪
│   ├── risk.js                 # 组合风控
│   ├── external-signals.js     # Twitter 信号抓取
│   ├── web-server.js           # Web 管理界面
│   └── ...                     # 更多模块
├── data/
│   ├── funds.json              # 基金池配置
│   ├── portfolio.json          # 持仓记录
│   └── hypotheses.json         # 假设追踪数据
├── .github/workflows/
│   └── daily-plan.yml          # GitHub Actions 定时任务
└── docs/
    └── index.html              # GitHub Pages 页面
```

**技术栈**：Node.js · Express · ECharts · GitHub Actions · DeepSeek/OpenAI API

---

## ❓ FAQ

<details>
<summary><b>Q: 限购额度怎么知道？</b></summary>
<br/>
系统每天运行时自动检测限购变化并更新 funds.json，发现变化会邮件提醒。
</details>

<details>
<summary><b>Q: 净值需要手动填吗？</b></summary>
<br/>
不需要。系统自动从东方财富 API 获取净值，按结算日查找。也可以手动指定：--buy 270042 10 6.3835 2025-05-28
</details>

<details>
<summary><b>Q: 节假日怎么处理？</b></summary>
<br/>
系统内置 2025-2026 年中国法定节假日，结算日计算自动跳过周末和假期。
</details>

<details>
<summary><b>Q: 应该写买入日期还是确认日期？</b></summary>
<br/>
写买入日期。系统自动按 T+2 交易日计算确认日，用确认日净值算份额。
</details>

<details>
<summary><b>Q: 回测结果可信吗？</b></summary>
<br/>
回测基于历史数据，不代表未来。建议用走步回测（--walk-forward）验证策略，它比普通回测更接近真实情况。
</details>

<details>
<summary><b>Q: 和 Vibe-Trading 有什么关系？</b></summary>
<br/>
假设追踪引擎和走步回测模块受 Vibe-Trading 启发。Vibe-Trading 是港大的开源多 Agent 量化平台，功能更全面。本项目专注于 QDII 基金定投场景。
</details>

---

## 🤝 Contributing

欢迎 PR！请先阅读 [CONTRIBUTING.md](./CONTRIBUTING.md)。

---

## 📄 License

[MIT](./LICENSE)

---

<div align="center">

**⭐ 如果这个项目帮到了你，给个 Star 吧！**

</div>
