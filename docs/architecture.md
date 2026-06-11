# QDII 基金投资系统架构

## 系统概述

QDII基金投资操作系统是一个自动化的基金投资分析和管理平台，主要功能包括：
- 智能基金排名（4种策略）
- 持仓追踪和盈亏计算
- 组合风险分析
- 外部信号抓取（X/Twitter）
- AI决策报告生成
- 邮件/Telegram/飞书推送

## 核心模块

### 1. 入口层
- `index.js` - CLI主入口，处理命令行参数，协调各模块

### 2. 策略层
- `lib/allocator.js` - 基础分配算法（equal/low_fee/scarce）
- `lib/dynamic-strategy.js` - 智能动态策略（综合评分）

### 3. 数据层
- `lib/fund-data.js` - 基金数据获取（净值、行情、限购信息）
- `lib/external-signals.js` - 外部信号抓取（X/Twitter大V观点）
- `lib/trading-calendar.js` - 交易日历（节假日、T+2结算）

### 4. 分析层
- `lib/risk.js` - 组合风险分析（夏普比率、最大回撤、健康度）
- `lib/backtest.js` - 回测和权重优化
- `lib/alternatives.js` - 替代方案推荐

### 5. 展示层
- `lib/ai-analyst.js` - AI分析模块（LLM调用）
- `lib/mailer.js` - 邮件发送模块
- `lib/web-server.js` - Web管理界面

### 6. 通信层
- `telegram.js` - Telegram机器人
- `feishu.js` - 飞书机器人
- `wechat.js` - 微信机器人（WeChatFerry）

## 数据流

```
┌─────────────────┐
│   用户输入       │
│ (CLI/Web/Bot)   │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│   index.js      │
│   (主入口)       │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  策略引擎        │
│ allocator.js    │
│ dynamic-strategy│
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  数据服务        │
│ fund-data.js    │
│ external-signals│
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  分析服务        │
│ risk.js         │
│ backtest.js     │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  展示服务        │
│ ai-analyst.js   │
│ mailer.js       │
│ web-server.js   │
└─────────────────┘
```

## 文件结构

```
├── index.js                    # 主入口
├── lib/
│   ├── allocator.js            # 基础分配算法
│   ├── dynamic-strategy.js     # 智能动态策略
│   ├── ai-analyst.js           # AI分析模块
│   ├── mailer.js               # 邮件模块
│   ├── web-server.js           # Web界面
│   ├── portfolio.js            # 持仓追踪
│   ├── risk.js                 # 组合风控
│   ├── alternatives.js         # 替代方案
│   ├── external-signals.js     # 外部信号
│   ├── fund-data.js            # 基金数据
│   ├── backtest.js             # 回测优化
│   └── trading-calendar.js     # 交易日历
├── data/
│   ├── funds.json              # 基金池配置
│   ├── portfolio.json          # 持仓记录
│   ├── history.json            # 历史推荐
│   ├── nav-cache.json          # 净值缓存
│   └── ...
├── agents/                     # Agent配置
│   ├── data-agent.md
│   ├── strategy-agent.md
│   ├── portfolio-agent.md
│   └── ...
└── tests/                      # 测试用例
    └── unit/
```
