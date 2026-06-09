/**
 * 微信买入机器人
 * 通过 WeChatFerry 连接桌面微信，发送消息即可添加买入记录
 *
 * 使用方法：
 *   1. 打开微信桌面版并登录
 *   2. 运行 node wechat.js
 *   3. 给自己发消息（文件传输助手）或在指定群聊发消息
 *
 * 支持的命令：
 *   270042 10           → 买入广发纳斯达克100A 10元
 *   270042 10 8.5243    → 买入并指定确认净值
 *   270042 10, 040046 20 → 批量买入
 *   持仓                → 查看当前持仓
 *   帮助                → 显示使用说明
 */

var path = require("path");
var fs = require("fs");

// 设置项目根目录
process.chdir(__dirname);

var portfolio = require("./lib/portfolio");
var fundData = require("./lib/fund-data");

// ========== 配置 ==========
var CONFIG_FILE = path.join(__dirname, "data", "wechat-config.json");

function loadConfig() {
  var defaults = {
    // 监听模式：'self' = 只监听自己发的消息（文件传输助手）
    //          'room' = 监听指定群聊
    //          'all'  = 监听所有私聊消息
    mode: "self",
    // 监听的群聊 roomId（mode='room' 时生效）
    roomId: "",
    // 只处理自己发的消息（避免回复其他人的消息）
    selfOnly: true
  };
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      var userConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
      return Object.assign(defaults, userConfig);
    }
  } catch (e) {
    console.warn("[配置] 读取配置失败，使用默认配置:", e.message);
  }
  return defaults;
}

function saveConfig(config) {
  var dir = path.dirname(CONFIG_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), "utf-8");
}

// ========== 消息解析 ==========

/**
 * 解析买入命令
 * 支持格式：
 *   270042 10
 *   270042 10 8.5243
 *   270042 10 8.5243 2025-05-28
 *   270042 10, 040046 20
 */
function parseBuyCommand(text) {
  text = text.trim();
  if (!text) return null;

  // 批量模式：逗号分隔
  if (text.indexOf(",") !== -1) {
    var parts = text.split(",").map(function(s) { return s.trim(); }).filter(Boolean);
    var results = [];
    for (var i = 0; i < parts.length; i++) {
      var parsed = parseSingleBuy(parts[i]);
      if (parsed) results.push(parsed);
    }
    return results.length > 0 ? { batch: results } : null;
  }

  // 单笔模式
  var single = parseSingleBuy(text);
  return single ? { single: single } : null;
}

function parseSingleBuy(text) {
  text = text.trim();
  var parts = text.split(/\s+/);
  if (parts.length < 2) return null;

  var code = parts[0];
  var amount = parseFloat(parts[1]);

  // 校验基金代码（6位数字）
  if (!/^\d{6}$/.test(code)) return null;
  if (isNaN(amount) || amount <= 0) return null;

  var nav = null;
  var date = null;

  // 解析可选参数
  for (var i = 2; i < parts.length; i++) {
    var p = parts[i];
    if (/^\d{4}[-\/]\d{1,2}[-\/]\d{1,2}$/.test(p)) {
      date = normalizeDate(p);
    } else if (!isNaN(parseFloat(p))) {
      nav = parseFloat(p);
    }
  }

  return { code: code, amount: amount, nav: nav, date: date };
}

function normalizeDate(dateStr) {
  var parts = dateStr.split(/[-\/]/);
  var y = parts[0];
  var m = parts[1].padStart(2, "0");
  var d = parts[2].padStart(2, "0");
  return y + "-" + m + "-" + d;
}

/**
 * 处理买入命令
 */
function handleBuy(parsed) {
  var fundsData = loadFunds();
  var results = [];

  if (parsed.batch) {
    for (var i = 0; i < parsed.batch.length; i++) {
      var r = processOneBuy(parsed.batch[i], fundsData);
      results.push(r);
    }
  } else if (parsed.single) {
    results.push(processOneBuy(parsed.single, fundsData));
  }

  return results;
}

function processOneBuy(buy, fundsData) {
  var fund = fundsData.funds.find(function(f) { return f.code === buy.code; });
  var name = fund ? fund.name : buy.code;
  var settleDays = fund ? fund.settleDays : 2;

  var holding = portfolio.recordBuy(buy.code, name, buy.amount, buy.nav, buy.date, settleDays);
  if (!holding) {
    return { ok: false, name: name, error: "记录失败，请检查日期格式" };
  }

  // 获取最新买入记录信息
  var lastBuy = holding.buys[holding.buys.length - 1];
  return {
    ok: true,
    code: buy.code,
    name: name,
    amount: buy.amount,
    nav: lastBuy.nav,
    shares: lastBuy.shares,
    date: lastBuy.date,
    settleDate: lastBuy.settleDate
  };
}

function loadFunds() {
  try {
    var file = path.join(__dirname, "data", "funds.json");
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch (e) {
    return { funds: [] };
  }
}

// ========== 消息回复格式化 ==========

function formatBuyReply(results) {
  var lines = [];
  for (var i = 0; i < results.length; i++) {
    var r = results[i];
    if (r.ok) {
      var line = "✅ " + r.name + " " + r.amount + "元";
      if (r.nav) line += " 净值" + r.nav;
      if (r.shares) line += " " + r.shares + "份";
      if (r.settleDate) line += " 结算日" + r.settleDate;
      lines.push(line);
    } else {
      lines.push("❌ " + r.name + ": " + r.error);
    }
  }
  return lines.join("\n");
}

function formatPortfolioReply() {
  var result = portfolio.calcPortfolioSummary();
  if (result.empty) {
    return "📭 暂无持仓记录";
  }

  var lines = [];
  lines.push("📊 当前持仓");
  lines.push("─────────");

  var s = result.summary;
  lines.push("总投入: " + s.totalInvested + "元");
  lines.push("当前市值: " + s.totalValue + "元");

  var pnlSign = s.totalPnl >= 0 ? "+" : "";
  lines.push("总盈亏: " + pnlSign + s.totalPnl + "元 (" + pnlSign + s.totalPnlRate + "%)");
  lines.push("");

  for (var i = 0; i < result.holdings.length; i++) {
    var h = result.holdings[i];
    var hPnlSign = h.pnl >= 0 ? "+" : "";
    var hPnlStr = h.pnl !== null ? hPnlSign + h.pnl + "元 (" + hPnlSign + h.pnlRate + "%)" : "待更新";

    lines.push((i + 1) + ". " + h.name);
    lines.push("   投入" + h.totalAmount + "元 | " + h.totalShares + "份 | " + hPnlStr);
  }

  return lines.join("\n");
}

function formatHelpReply() {
  return [
    "📖 QDII基金买入机器人",
    "─────────",
    "发送以下命令即可操作：",
    "",
    "💰 买入基金：",
    "  270042 10",
    "  270042 10 8.5243",
    "  270042 10, 040046 20",
    "",
    "📊 查看持仓：",
    "  持仓",
    "",
    "❓ 帮助：",
    "  帮助",
    "",
    "格式: 基金代码 金额 [净值] [日期]"
  ].join("\n");
}

// ========== 消息路由 ==========

function handleMessage(content, sender) {
  content = content.trim();

  // 帮助命令
  if (content === "帮助" || content === "help" || content === "?") {
    return formatHelpReply();
  }

  // 持仓查询
  if (content === "持仓" || content === "portfolio" || content === "p") {
    return formatPortfolioReply();
  }

  // 尝试解析为买入命令
  var parsed = parseBuyCommand(content);
  if (parsed) {
    var results = handleBuy(parsed);
    return formatBuyReply(results);
  }

  // 不识别的消息，忽略（不回复）
  return null;
}

// ========== 主程序 ==========

function main() {
  console.log("========================================");
  console.log("  QDII基金 微信买入机器人");
  console.log("========================================");
  console.log("");

  var config = loadConfig();
  console.log("[配置] 监听模式: " + config.mode);
  console.log("[配置] 配置文件: " + CONFIG_FILE);
  console.log("");

  // 动态导入 ESM 模块
  import("wechatferry").then(function(mod) {
    var Wechatferry = mod.Wechatferry;
    var client = new Wechatferry();

    console.log("[启动] 正在连接微信客户端...");

    try {
      client.start();
    } catch (e) {
      console.error("[错误] 连接失败:", e.message);
      console.error("[提示] 请确保：");
      console.error("  1. 微信桌面版已打开并登录");
      console.error("  2. 微信版本为 3.9.12.51（或与 WeChatFerry 兼容的版本）");
      console.error("  3. 以管理员权限运行");
      process.exit(1);
    }

    // 检查登录状态
    if (!client.isLogin()) {
      console.error("[错误] 微信未登录，请先登录微信桌面版");
      client.stop();
      process.exit(1);
    }

    var selfWxid = client.getSelfWxid();
    var userInfo = client.getUserInfo();
    console.log("[登录] wxid: " + selfWxid);
    console.log("[登录] 昵称: " + (userInfo.name || "未知"));
    console.log("");
    console.log("[就绪] 发送「帮助」查看使用说明");
    console.log("[就绪] 发送「270042 10」即可买入");
    console.log("");

    // 监听消息
    client.on("message", function(msg) {
      // 只处理文本消息
      if (msg.type !== 1) return;

      // 根据配置过滤消息
      if (config.selfOnly && msg.is_self !== true) return;
      if (config.mode === "room" && config.roomId && msg.roomid !== config.roomId) return;

      var content = msg.content || "";
      var sender = msg.sender || "";
      var receiver = msg.roomid || sender;

      // 处理消息
      var reply = handleMessage(content, sender);
      if (!reply) return;

      // 发送回复
      try {
        client.sendTxt(reply, receiver);
        console.log("[消息] " + content + " → 已回复");
      } catch (e) {
        console.error("[错误] 发送回复失败:", e.message);
      }
    });

    // 优雅退出
    process.on("SIGINT", function() {
      console.log("\n[退出] 正在关闭...");
      client.stop();
      process.exit(0);
    });

    process.on("SIGTERM", function() {
      client.stop();
      process.exit(0);
    });

  }).catch(function(e) {
    console.error("[错误] 加载 wechatferry 模块失败:", e.message);
    console.error("[提示] 请运行 npm install wechatferry 安装依赖");
    process.exit(1);
  });
}

main();
