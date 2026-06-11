# API 文档

## Web UI REST API

基础URL: `http://localhost:3000`

### 1. 获取基金列表

**GET** `/api/funds`

返回基金池配置。

**响应示例：**
```json
{
  "config": { ... },
  "funds": [
    {
      "code": "270042",
      "name": "广发纳斯达克100A(QDII)",
      "type": "纳指100",
      "feeRate": 0.8,
      "dailyLimit": 100,
      "status": "active",
      "settleDays": 2
    }
  ]
}
```

### 2. 获取持仓信息

**GET** `/api/portfolio`

返回当前持仓和盈亏信息。

**响应示例：**
```json
{
  "holdings": [
    {
      "code": "270042",
      "name": "广发纳斯达克100A(QDII)",
      "totalAmount": 100,
      "totalShares": 12.34,
      "avgCost": 8.10,
      "currentValue": 105.50,
      "pnl": 5.50,
      "pnlRate": 5.50
    }
  ],
  "summary": {
    "totalInvested": 100,
    "totalValue": 105.50,
    "totalPnl": 5.50,
    "totalPnlRate": 5.50,
    "holdingCount": 1,
    "healthScore": 85
  }
}
```

### 3. 记录买入

**POST** `/api/buy`

**请求体：**
```json
{
  "code": "270042",
  "amount": 100,
  "nav": 8.10,
  "date": "2026-06-09"
}
```

**参数说明：**
- `code` (必填): 基金代码
- `amount` (必填): 买入金额（元）
- `nav` (可选): 买入净值，不填则自动查询
- `date` (可选): 买入日期，格式YYYY-MM-DD，默认今天

**响应示例：**
```json
{
  "success": true,
  "holding": { ... }
}
```

### 4. 批量导入

**POST** `/api/import`

**请求体：**
```json
{
  "text": "270042 10 8.5243\n040046 20"
}
```

**文本格式：**
- 每行一条记录
- 格式: `基金代码 金额 [净值] [日期]`
- 支持基金名称匹配

**响应示例：**
```json
{
  "total": 2,
  "imported": 2,
  "errors": []
}
```

### 5. 删除持仓

**DELETE** `/api/portfolio/:code`

删除指定基金的所有买入记录。

**响应示例：**
```json
{
  "success": true,
  "deleted": 3
}
```

### 6. 获取今日推荐

**GET** `/api/today`

返回今日基金推荐和买入指令。

**响应示例：**
```json
{
  "date": "2026-06-09",
  "strategy": "dynamic",
  "recommendations": [
    {
      "code": "270042",
      "name": "广发纳斯达克100A(QDII)",
      "score": 25.5,
      "reason": "夏普1.5加分..."
    }
  ],
  "buyCommands": [
    "node index.js --buy 270042 10"
  ]
}
```

### 7. 获取风险分析

**GET** `/api/risk`

返回组合风险指标。

**响应示例：**
```json
{
  "healthScore": 85,
  "portfolioSharpe": 1.2,
  "portfolioMaxDrawdown": -15.5,
  "concentration": {
    "dominantType": "纳指100",
    "dominantWeight": 60
  }
}
```

## Telegram Bot 命令

| 命令 | 说明 |
|------|------|
| `270042 10` | 买入指定基金 |
| `持仓` | 查看当前持仓 |
| `推荐` | 查看今日推荐 |
| `风险` | 查看风险分析 |
| `帮助` | 显示帮助信息 |

## 飞书 Bot 命令

与Telegram Bot命令相同。

## CLI 命令

```bash
# 试运行
node index.js --dry-run

# 指定策略
node index.js --strategy dynamic

# 查看持仓
node index.js --portfolio

# 记录买入
node index.js --buy 270042 10

# 批量导入
node index.js --import-file data/buys.txt

# 启动Web界面
node index.js --web

# 启动Telegram Bot
node telegram.js
```
