# 交易日历模块

## 概述

`lib/trading-calendar.js` 负责处理QDII基金的T+2交易日结算逻辑。

## 核心功能

### 1. 交易日判断

```javascript
isTradingDay(dateStr)
```

判断指定日期是否为交易日。

**规则：**
- 周一到周五为工作日
- 法定节假日不是交易日
- 周末不是交易日

**示例：**
```javascript
isTradingDay('2026-06-09')  // true (周一)
isTradingDay('2026-06-14')  // false (周六)
isTradingDay('2026-01-01')  // false (元旦)
```

### 2. 结算日计算

```javascript
calcSettleDate(buyDate, settleDays)
```

计算买入日期的结算日。

**参数：**
- `buyDate`: 买入日期 (YYYY-MM-DD)
- `settleDays`: 结算天数 (默认2，表示T+2)

**规则：**
- 从买入日开始，向后数N个交易日
- 自动跳过周末和法定节假日
- 返回结算日期

**示例：**
```javascript
// 周三买入，T+2 = 周五
calcSettleDate('2026-06-10', 2)  // '2026-06-12'

// 周四买入，T+2 = 下周一（跨周末）
calcSettleDate('2026-06-11', 2)  // '2026-06-15'

// 节前买入，T+2 = 节后
calcSettleDate('2026-04-30', 2)  // '2026-05-06' (跨劳动节)
```

### 3. 节假日管理

```javascript
loadHolidays()
```

加载节假日列表。

**内置节假日（2025-2026）：**
- 元旦
- 春节
- 清明节
- 劳动节
- 端午节
- 中秋节
- 国庆节

**自定义节假日：**
```javascript
addHolidays(['2026-07-01', '2026-07-02'])
```

## QDII结算规则

### 结算周期

| 买入日 | 结算日 | 说明 |
|--------|--------|------|
| 周一 | 周三 | T+2 |
| 周二 | 周四 | T+2 |
| 呑三 | 周五 | T+2 |
| 周四 | 下周一 | T+2 (跨周末) |
| 周五 | 下周二 | T+2 (跨周末) |

### 节假日影响

- 节前最后交易日买入 → 节后第2个交易日结算
- 遇周末顺延到周一

### 特殊情况

1. **净值未出**：结算日净值未更新时，自动查找下一个交易日净值
2. **跨年**：正常处理，节假日列表覆盖两年
3. **调休**：调休上班日按正常工作日处理

## 使用示例

```javascript
var tradingCal = require('./lib/trading-calendar');

// 计算结算日
var result = tradingCal.calcSettleDate('2026-06-11', 2);
console.log(result.date);     // '2026-06-15'
console.log(result.weekday);  // '周一'
console.log(result.skipped);  // 2 (跳过周六日)

// 判断交易日
console.log(tradingCal.isTradingDay('2026-06-09'));  // true
console.log(tradingCal.isTradingDay('2026-06-14'));  // false
```

## 测试覆盖

测试文件: `tests/unit/trading-calendar.test.js`

覆盖场景：
- 工作日判断
- 节假日判断
- T+2结算日计算
- 跨周末结算
- 跨节假日结算
- 边界case（节前最后一天）
