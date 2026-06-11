# Chrome MCP Server 配置说明

## 安装状态

✅ mcp-chrome-bridge 已安装
✅ Native Messaging Host 已注册
✅ MCP 配置已创建

## 下一步：安装 Chrome 扩展

1. 下载 Chrome 扩展：
   - 访问 https://github.com/hangwin/mcp-chrome/releases
   - 下载最新版本的 `.zip` 文件
   - 解压到本地目录

2. 安装扩展：
   - 打开 Chrome，访问 `chrome://extensions/`
   - 开启"开发者模式"
   - 点击"加载已解压的扩展程序"
   - 选择解压后的文件夹

3. 连接扩展：
   - 点击 Chrome 工具栏的扩展图标
   - 点击"连接"按钮
   - 看到"已连接"表示成功

## 使用方式

### 在 Reasonix 中使用

配置文件已创建在 `.mcp/chrome.json`，Reasonix 会自动加载。

### 可用工具

| 工具 | 功能 |
|------|------|
| `chrome_navigate` | 导航到 URL |
| `chrome_screenshot` | 截图 |
| `chrome_get_web_content` | 获取页面文本内容 |
| `chrome_click_element` | 点击元素 |
| `chrome_fill_or_select` | 填写表单 |
| `search_tabs_content` | 语义搜索标签页 |
| `chrome_network_capture` | 捕获网络请求 |

### 示例用法

**抓取基金净值：**
```
请帮我访问 https://fund.eastmoney.com/270042.html 并获取最新净值
```

**获取限购信息：**
```
请帮我查看天天基金上 270042 的限购状态
```

**截图当前页面：**
```
请帮我截图当前页面
```

## 故障排除

### 扩展无法连接

1. 确保 Chrome 已打开
2. 确保扩展已安装并启用
3. 检查 Native Messaging Host 是否注册成功：
   ```bash
   mcp-chrome-bridge doctor
   ```

### 权限问题

如果遇到权限问题，运行：
```bash
mcp-chrome-bridge fix-permissions
```

## 相关链接

- [mcp-chrome GitHub](https://github.com/hangwin/mcp-chrome)
- [Chrome MCP 文档](https://github.com/hangwin/mcp-chrome/tree/main/docs)
