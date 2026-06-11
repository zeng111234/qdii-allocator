# QDII 基金系统 - 多 Agent 架构

## Agent 列表

| Agent | 文件 | 职责 | 对接人 |
|-------|------|------|--------|
| **PM Agent** | `pm-agent.md` | 客户对接、需求收集、任务分配 | ← 你（用户） |
| **Architecture Agent** | `architecture-agent.md` | 架构分析、依赖审查、性能优化 | ← PM |
| Data Agent | `data-agent.md` | 数据获取和缓存 | ← PM |
| Strategy Agent | `strategy-agent.md` | 排名和回测 | ← PM |
| Portfolio Agent | `portfolio-agent.md` | 持仓追踪和风控 | ← PM |
| Frontend Agent | `frontend-agent.md` | Web 界面 | ← PM |
| Communication Agent | `comm-agent.md` | 消息推送 | ← PM |
| Orchestrator | `orchestrator.md` | 协调每日工作流 | ← 自动 |
| Test Agent | `test-agent.md` | 自动化测试 | ← PM/Review |
| Review Agent | `review-agent.md` | 代码审查和找茬 | ← PM |

## 工作流程

```
用户（你）
    ↓ 说需求
PM Agent（产品经理）
    ↓ 拆解任务、分配
Architecture Agent（架构分析）
    ↓ 审查架构影响
各专业 Agent（Data/Strategy/Portfolio/Frontend/Comm）
    ↓ 执行任务
Test Agent（测试）
    ↓ 验证通过
Review Agent（审查）
    ↓ 无问题
PM Agent → 向用户汇报结果
```

## 代码模块映射

| 模块 | 负责 Agent | 文件大小 |
|------|-----------|----------|
| `index.js` | Orchestrator | 22KB |
| `lib/dynamic-strategy.js` | Strategy Agent | 44KB |
| `lib/fund-data.js` | Data Agent | 20KB |
| `lib/external-signals.js` | Data Agent | 27KB |
| `lib/portfolio.js` | Portfolio Agent | 22KB |
| `lib/risk.js` | Portfolio Agent | 10KB |
| `lib/backtest.js` | Strategy Agent | 16KB |
| `lib/alternatives.js` | Portfolio Agent | 8KB |
| `lib/ai-analyst.js` | Communication Agent | 24KB |
| `lib/mailer.js` | Communication Agent | 15KB |
| `lib/web-server.js` | Frontend Agent | 46KB |
| `lib/trading-calendar.js` | Data Agent | 10KB |
| `lib/utils.js` | 共享工具 | 3KB |

## 数据流

| 数据文件 | 生产者 | 消费者 |
|---------|--------|--------|
| `data/nav-cache.json` | Data Agent | Strategy, Portfolio |
| `data/external-signals-cache.json` | Data Agent | Strategy |
| `data/fund-info-cache.json` | Data Agent | Portfolio, Frontend |
| `data/history.json` | Strategy Agent | Backtest |
| `data/portfolio.json` | Portfolio Agent | Frontend, Comm, AI |
| `data/funds.json` | 用户维护 | 所有 Agent |

## 运行方式

```bash
# 每日分析（完整流程）
node index.js --strategy dynamic

# 运行测试
npm test

# 启动 Web UI
node index.js --web
```
