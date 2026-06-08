# QDII基金投资操作系统

每天早上自动帮你算好：今天该买哪几只QDII基金、各买多少，并追踪持仓盈亏、评估组合风险。

## 核心功能

| 功能 | 说明 |
|------|------|
| **智能排名** | 4种策略：平均主义 / 低费率优先 / 稀缺额度优先 / 智能动态（综合净值走势+外部信号+AI判断） |
| **持仓追踪** | 记录每笔买入，自动计算盈亏、持仓成本、当前市值 |
| **组合风控** | 基金相关性分析、组合夏普比率、最大回撤、健康度评分（0-100） |
| **限购监控** | 自动检测限购额度变化，发现暂停/恢复申购时立刻提醒 |
| **替代方案** | 某只基金限购/停购时，自动推荐同类型替代基金（含场内ETF） |
| **外部信号** | 抓取 X/Twitter 大V观点，分析投资主题情绪，影响评分 |
| **AI分析** | 调用 LLM 生成投资决策报告，结合市场新闻和持仓数据给出个性化建议 |
| **回测优化** | 历史回测验证策略效果，网格搜索自动优化评分权重 |
| **邮件推送** | 每天自动发投资计划到邮箱，含排名、持仓、风控、AI报告 |
| **GitHub Actions** | 不需要自己的服务器，每天定时自动运行 |

## 快速开始

### 1. 克隆安装

```bash
git clone https://github.com/你的用户名/qdii-allocator.git
cd qdii-allocator
npm install
```

### 2. 配置基金池

编辑 `data/funds.json`，每只基金的关键字段：

```json
{
  "code": "270042",
  "name": "广发纳斯达克100A(QDII)",
  "type": "纳指100",
  "feeRate": 0.8,
  "dailyLimit": 100,
  "status": "active",
  "settleDays": 2
}
```

- `status`: `"active"` 正常申购 / `"suspended"` 暂停申购
- `dailyLimit`: 每天限购金额（元），设 `0` 表示不可买
- `feeRate`: 管理费率（%），低费率优先策略用
- `settleDays`: 结算天数，QDII基金默认 `2`（T+2），国内基金设 `1`

### 3. 配置邮件和AI

```bash
cp .env.example .env
```

编辑 `.env` 填入：

| 配置项 | 说明 | 示例 |
|--------|------|------|
| `SMTP_HOST` | SMTP服务器 | `smtp.qq.com` |
| `SMTP_PORT` | 端口 | `465` |
| `SMTP_USER` | 发件邮箱 | `xxx@qq.com` |
| `SMTP_PASS` | SMTP授权码 | `abcdef1234` |
| `MAIL_TO` | 收件邮箱 | `xxx@163.com` |
| `LLM_API_KEY` | AI API密钥（可选） | `sk-xxx` |
| `LLM_BASE_URL` | AI接口地址（可选） | `https://api.example.com/v1/chat/completions` |
| `LLM_MODEL` | 模型名（可选） | `mimo-v2.5-pro` |

> QQ邮箱授权码：设置 > 账户 > POP3/SMTP服务 > 开启 > 生成授权码

### 4. 部署到 GitHub Actions

1. 在 GitHub 上创建仓库，推送代码
2. 进入仓库 Settings > Secrets and variables > Actions
3. 添加上面表格中的 Secrets
4. 推送代码后，每天自动运行
5. 可在 Actions 页面手动触发测试

## 命令速查

### 试运行（不发邮件）

```bash
# 默认策略试运行
node index.js --dry-run

# 指定预算和策略
node index.js --dry-run --budget 30 --strategy dynamic
```

### 持仓管理

```bash
# 查看当前持仓
node index.js --portfolio

# 记录单笔买入（代码 + 金额，净值和日期可选）
node index.js --buy 270042 10
node index.js --buy 270042 10 2025-05-28           # 指定买入日期（自动计算结算日）
node index.js --buy 270042 10 8.5243 2025-05-28    # 指定净值和日期

# 批量录入（逗号分隔多笔，每笔支持净值和日期）
node index.js --quick-add "270042 10, 040046 20 8.1467 2025-05-28"

# 从文件批量导入
node index.js --import-file data/buys.txt
```

> **QDII结算说明**：QDII基金是T+2结算（买入后第2个交易日确认份额）。系统会自动用结算日的净值计算份额，你只需输入买入日期即可。

`data/buys.txt` 支持四种格式：

```
# 格式1: 代码 金额 [净值] [日期]
270042 10 8.5243 2025-05-28

# 格式2: 基金名称 金额
广发纳斯达克100 10

# 格式3: 买入 基金名称 XX元 确认净值XX [日期]
买入 华安纳斯达克100 20元 确认净值8.1467 2025-05-28

# 格式4: 日期 代码 金额 [净值]（适合按时间顺序整理）
2025-05-28 270042 10 8.5243
2025-05-29 040046 20
```

### 今日推荐

```bash
# 显示今日推荐基金和快捷买入指令
node index.js --today
```

### 回测和优化

```bash
# 策略回测（默认60天）
node index.js --backtest

# 指定回测天数
node index.js --backtest --backtest-days 120

# 权重优化（网格搜索最优参数）
node index.js --optimize-weights
```

## 分配策略说明

| 策略 | 参数 | 逻辑 |
|------|------|------|
| 稀缺额度优先 | `scarce` | 先买限额最小的基金（稀缺货），再买限额大的 |
| 低费率优先 | `low_fee` | 管理费低的基金优先买满 |
| 平均主义 | `equal` | 预算平均分给所有可申购基金 |
| 智能动态 | `dynamic` | 综合净值走势、限购信号、外部信号、AI判断做TopN排名 |

### 智能动态策略详情

`dynamic` 策略是最完整的分析模式：

1. **净值走势分析**：计算每只基金的MA均线、波动率、回撤等技术指标
2. **限购信号**：限购额度越低 = 基金越稀缺 = 品质信号，自动加分
3. **外部信号**：抓取 X/Twitter 大V观点，分析看涨/看跌情绪
4. **AI决策**：调用 LLM 综合所有数据生成投资报告
5. **历史回填**：自动计算历史推荐的实际5日/10日收益

## 外部信号配置

在 `data/funds.json` 的 `config` 中配置：

```json
{
  "xSourceUrl": "https://x.com/aleabitoreddit",
  "enableExternalSignals": true,
  "externalSignalMaxScore": 3,
  "rsshubUrl": "https://your-rsshub-instance.com"
}
```

| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| `xSourceUrl` | 目标 X 账号地址 | `https://x.com/aleabitoreddit` |
| `enableExternalSignals` | 是否启用外部信号 | `true` |
| `externalSignalMaxScore` | 外部信号对总分的最大影响 | `3` |
| `rsshubUrl` | 自建 RSSHub 地址（推荐） | 空（使用公共镜像） |
| `xMirrorWhitelist` | 自定义镜像列表 | 空（使用内置列表） |

### 代理环境变量

| 变量 | 说明 |
|------|------|
| `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` | 标准代理地址 |
| `EXTERNAL_PROXY_AUTO` | 设置后启用代理自动回退（默认关闭） |
| `EXTERNAL_PROXY_DISABLED` | 设置后完全禁用代理逻辑 |

## 持仓追踪

系统会自动计算：

- **总投入**：所有买入金额之和
- **当前市值**：持有份额 x 最新净值
- **盈亏**：当前市值 - 总投入
- **持仓成本**：加权平均买入净值
- **组合健康度**：0-100分，综合分散度、夏普比率、回撤控制

持仓数据存储在 `data/portfolio.json`，支持多次买入同一基金。

### QDII结算日处理

QDII基金是T+2结算（买入后第2个交易日确认份额），系统自动处理：

1. **输入买入日期**：`node index.js --buy 270042 10 2025-05-28`
2. **自动计算结算日**：2025-05-28 + 2天 = 2025-05-30
3. **用结算日净值计算份额**：10元 ÷ 6.3835（结算日净值）= 1.5665份
4. **遇周末/假期自动顺延**：结算日无净值时，自动找下一个交易日

```
示例输出：
[持仓] 使用结算日 2025-05-30 净值: 6.3835
[持仓] 已记录: 广发纳斯达克100A(QDII) 2025-05-28 买入 10元 (结算日: 2025-05-30) (净值6.3835, 份额1.5665)
```

> **注意**：如果手动提供净值（`--buy 270042 10 6.3835 2025-05-28`），系统会直接使用你提供的净值，不走结算日查找逻辑。

## 组合风控

当有持仓数据时，系统自动计算：

- **基金相关性矩阵**：皮尔逊相关系数，识别高度相关的基金
- **组合夏普比率**：风险调整后收益
- **组合最大回撤**：历史最大亏损幅度
- **集中度分析**：持仓类型分布，过于集中时发出警告
- **健康度评分**：0-100分综合评估

## 限购监控

每天运行时自动检测：

- 限购额度变化（升降）
- 暂停申购 / 恢复申购
- 发现变化时自动更新 `data/funds.json`，并在邮件中提醒

## 替代方案

当基金不可买时，系统自动推荐替代基金：

- 同类型其他基金公司的产品
- 场内 ETF（无限购，但可能溢价）
- 场内 LOF（可通过券商买入）

替代方案覆盖：纳指100、标普500、港股、全球精选、亚太、石油、REITs 等主流类型。

## 项目结构

```
index.js                    # 主入口，CLI命令处理
watch.js                    # X/Twitter 推文实时监控（可选）
lib/
  allocator.js              # 基础分配算法（equal/low_fee/scarce）
  dynamic-strategy.js       # 智能动态策略（综合评分）
  ai-analyst.js             # AI分析模块（LLM调用）
  mailer.js                 # 邮件发送模块
  portfolio.js              # 持仓追踪模块
  risk.js                   # 组合风控模块
  alternatives.js           # 替代方案模块
  external-signals.js       # 外部信号抓取（X/Twitter）
  fund-data.js              # 基金数据获取（净值、行情）
  backtest.js               # 回测和权重优化
data/
  funds.json                # 基金池配置（手动维护）
  portfolio.json            # 持仓记录（自动维护）
  history.json              # 历史推荐记录
  nav-cache.json            # 净值缓存
  fund-info-cache.json      # 基金信息缓存
  buys.txt                  # 买入记录文件（用于导入）
  seen-tweets.json          # 已读推文记录
.github/workflows/
  daily-plan.yml            # GitHub Actions 定时任务
.env.example                # 配置模板
README.md
```

## 常见问题

**Q: 限购额度怎么知道？**
A: 系统会自动检测限购变化并更新 `funds.json`。也可以手动查看天天基金/支付宝的基金详情页。

**Q: 能不能自动获取限购额度？**
A: 可以！系统每天运行时会调用基金API获取最新限购状态，发现变化自动更新并邮件提醒。

**Q: 微信/支付宝买的基金怎么录入？**
A: 三种方式：
1. 单笔：`node index.js --buy 270042 10 2025-05-28`（写买入日期，系统自动算结算日）
2. 批量：`node index.js --quick-add "270042 10 2025-05-28, 040046 20 2025-05-29"`
3. 文件：编辑 `data/buys.txt`，然后 `node index.js --import-file`

**Q: 应该写买入日期还是确认日期？**
A: 写**买入日期**（你提交申购的那天）。系统会自动按T+2计算确认日，并用确认日的净值计算份额。比如5月28买入，系统会用5月30的净值。如果确认日没有净值数据（周末/假期），会自动找下一个交易日。

**Q: 净值需要手动填吗？**
A: 不需要。系统会自动从东方财富API获取净值数据，按结算日查找。如果你想用自己确认的净值，可以手动指定：`--buy 270042 10 6.3835 2025-05-28`。

**Q: 邮件发不出去？**
A: 检查SMTP授权码是否正确（不是QQ邮箱密码），确认端口465。

**Q: AI分析没反应？**
A: LLM配置是可选的，不配置就跳过。配好 `.env` 中的 `LLM_API_KEY` 后会自动调用。

**Q: 外部信号获取失败？**
A: 公共RSSHub镜像可能不稳定。建议自建RSSHub实例，在 `funds.json` 中配置 `rsshubUrl`。

**Q: 组合健康度多少分算好？**
A: 80分以上为健康，60-80为一般，60以下需要关注。主要看分散度和回撤控制。

**Q: 能投C类基金吗？**
A: 默认预置的是A类份额。你可以在 `funds.json` 中添加任何基金，修改 `shareClass` 字段即可。

**Q: 回测结果可信吗？**
A: 回测基于历史数据，不代表未来表现。但可以帮助验证策略逻辑是否合理，以及优化权重参数。
