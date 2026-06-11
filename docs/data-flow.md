# 数据流图

## 主要数据流

### 1. 每日分析流程

```
[定时触发] GitHub Actions (UTC 00:00 = 北京时间 08:00)
    │
    ▼
[数据获取] fund-data.js
    ├── 获取基金净值 (东方财富API)
    ├── 获取市场快照 (13个国际指数)
    └── 获取限购信息
    │
    ▼
[外部信号] external-signals.js
    ├── 抓取X/Twitter推文 (RSSHub)
    ├── 分析投资主题情绪
    └── 提取股票代码观点
    │
    ▼
[策略排名] dynamic-strategy.js
    ├── 计算技术指标 (MA/波动率/回撤)
    ├── 评分权重体系
    └── 生成TopN推荐
    │
    ▼
[组合分析] risk.js
    ├── 计算夏普比率
    ├── 计算最大回撤
    ├── 相关性矩阵
    └── 健康度评分
    │
    ▼
[AI分析] ai-analyst.js
    ├── 生成投资报告
    ├── 实操建议
    └── 新方向发现
    │
    ▼
[结果输出]
    ├── 邮件推送 (mailer.js)
    ├── Telegram推送
    └── 历史记录 (history.json)
```

### 2. 持仓管理流程

```
[用户输入] --buy 270042 10
    │
    ▼
[日期处理] trading-calendar.js
    ├── 计算T+2结算日
    ├── 跳过周末和节假日
    └── 返回结算日期
    │
    ▼
[净值查找] portfolio.js
    ├── 查找结算日净值
    ├── 计算持有份额
    └── 更新持仓记录
    │
    ▼
[数据存储] portfolio.json
```

### 3. 外部信号流程

```
[RSSHub] X/Twitter推文
    │
    ▼
[信号提取] external-signals.js
    ├── 提取股票代码 ($TICKER)
    ├── 分析情绪 (看涨/看跌)
    └── 提取观点摘要
    │
    ▼
[主题匹配]
    ├── 纳指100 → AI/半导体
    ├── 港股 → 台积电等
    └── 新方向缺口检测
    │
    ▼
[评分影响] dynamic-strategy.js
    └── 外部信号加分/扣分
```

### 4. 缓存策略

```
[API请求]
    │
    ▼
[缓存检查] nav-cache.json
    ├── 命中 → 直接返回
    └── 未命中/过期 → 请求API
    │
    ▼
[缓存更新]
    ├── TTL: 4小时
    ├── 增量更新 (最近2页)
    └── 持久化到文件
```

## 数据文件说明

| 文件 | 内容 | 更新频率 |
|------|------|----------|
| `funds.json` | 基金池配置 | 手动维护 |
| `portfolio.json` | 持仓记录 | 实时更新 |
| `history.json` | 历史推荐 | 每日更新 |
| `nav-cache.json` | 净值缓存 | 4小时TTL |
| `fund-info-cache.json` | 基金信息缓存 | 按需更新 |
| `external-signals-cache.json` | 外部信号缓存 | 每日更新 |
| `data/review-report.md` | AI审查报告 | 每次push |
