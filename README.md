# QDII基金每日分配器

每天早上自动帮你算好：今天的N元定投预算，该买哪几只QDII基金、各买多少。

## 它能做什么

1. **维护一个基金池**：你关注的纳指/美股/QDII基金（A类份额）
2. **三种分配策略**：平均主义 / 低费率优先 / 稀缺额度优先
3. **AI智能点评**：调用 mimo-v2.5-pro 分析今日方案
4. **邮件推送**：每天早上自动发投资计划到你的手机邮箱
5. **GitHub Actions 托管**：不需要自己的服务器，全自动运行

## 快速开始

### 1. 克隆仓库

```bash
git clone https://github.com/你的用户名/qdii-allocator.git
cd qdii-allocator
npm install
```

### 2. 配置基金池

编辑 `data/funds.json`，修改每只基金的 `dailyLimit`（日限购额度）和 `status`：

- `status: "active"` — 正常申购
- `status: "suspended"` — 暂停申购
- `dailyLimit: 10` — 每天限购10元
- `dailyLimit: 100` — 每天限购100元

已预置10只常见的美股/QDII A类基金作为起点，请根据实际情况更新。

### 3. 本地测试

```bash
# 试运行（不发邮件，只看分配结果）
node index.js --dry-run

# 指定预算和策略
node index.js --dry-run --budget 30 --strategy low_fee
```

### 4. 配置邮件和AI

```bash
cp .env.example .env
```

编辑 `.env` 填入：
- **SMTP配置**：QQ邮箱的授权码（设置 > 账户 > POP3/SMTP服务 > 开启 > 生成授权码）
- **LLM配置**（可选）：mimo-v2.5-pro 或 DeepSeek 的 API Key

本地发一封测试：

```bash
node index.js
```

### 5. 部署到 GitHub Actions

1. 在 GitHub 上创建仓库，推送代码
2. 进入仓库 Settings > Secrets and variables > Actions
3. 添加以下 Secrets：

| Secret名称 | 说明 | 示例 |
|------------|------|------|
| `SMTP_HOST` | SMTP服务器 | `smtp.qq.com` |
| `SMTP_PORT` | 端口 | `465` |
| `SMTP_USER` | 发件邮箱 | `xxx@qq.com` |
| `SMTP_PASS` | SMTP授权码 | `abcdef1234` |
| `MAIL_TO` | 收件邮箱 | `xxx@163.com` |
| `LLM_API_KEY` | AI API密钥（可选） | `sk-xxx` |
| `LLM_BASE_URL` | AI接口地址（可选） | `https://api.example.com/v1/chat/completions` |
| `LLM_MODEL` | 模型名（可选） | `mimo-v2.5-pro` |

4. 推送代码后，每天北京时间 07:00 自动运行
5. 可在 Actions 页面手动触发测试

## 分配策略说明

| 策略 | 参数 | 逻辑 |
|------|------|------|
| 稀缺额度优先 | `scarce` | 先买限额最小的基金（稀缺货），再买限额大的 |
| 低费率优先 | `low_fee` | 管理费低的基金优先买满 |
| 平均主义 | `equal` | 预算平均分给所有可申购基金 |
| 智能动态 | `dynamic` | 综合净值走势、限购、外部信号和AI判断做TopN排名 |

### 外部信号配置（X / RSS）

在 `data/funds.json` 的 `config` 中可新增以下字段：

- `xSourceUrl`: 目标 X 账号地址（默认 `https://x.com/aleabitoreddit`）
- `xMirrorWhitelist`: 自定义镜像列表，支持 `{handle}` 占位符，留空则使用内置 RSSHub 镜像
- `enableExternalSignals`: 是否启用外部信号（默认 true）
- `externalSignalMaxScore`: 外部信号对总分的最大影响（默认 3）

建议在网络受限环境下配置 `xMirrorWhitelist` 或使用代理环境变量 `HTTP_PROXY` / `EXTERNAL_PROXY_AUTO`。新增可用环境变量：

| 变量 | 说明 |
|------|------|
| `EXTERNAL_PROXY_AUTO` | 设置后启用代理自动回退（默认关闭） |
| `EXTERNAL_PROXY_DISABLED` | 设置后完全禁用代理逻辑 |
| `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` | 标准代理地址，启用代理回退 |

## 每日操作流程

1. 早上收到邮件
2. 打开微信/支付宝
3. 按邮件清单手动买入
4. 完成！

如果某只基金限购额度变了，去 GitHub 编辑 `data/funds.json` 更新 `dailyLimit` 即可。

## 项目结构

```
├── index.js                 # 主入口
├── lib/
│   ├── allocator.js         # 分配算法（3种策略）
│   ├── ai-analyst.js        # AI分析模块
│   └── mailer.js            # 邮件发送模块
├── data/
│   └── funds.json           # 基金池数据（手动维护）
├── .github/workflows/
│   └── daily-plan.yml       # GitHub Actions 定时任务
├── .env.example             # 配置模板
└── README.md
```

## 常见问题

**Q: 限购额度怎么知道？**
A: 打开天天基金/支付宝的基金详情页，申购时会提示"单日限额XX元"。手动更新 `funds.json` 即可。

**Q: 能不能自动获取限购额度？**
A: 目前没有公开API，需要手动更新。未来可以尝试爬取天天基金页面。

**Q: 邮件发不出去？**
A: 检查SMTP授权码是否正确（不是QQ邮箱密码），确认端口465。

**Q: AI分析没反应？**
A: LLM配置是可选的，不配置就跳过。配好后会自动调用。

**Q: 能投C类基金吗？**
A: 默认预置的是A类份额。你可以在 `funds.json` 中添加任何基金，修改 `shareClass` 字段即可。