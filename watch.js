/**
 * Serenity (@aleabitoreddit) 实时推文监控
 * 
 * 每 10 分钟检查一次新推文，有新内容立刻发邮件通知
 * 运行方式：node watch.js
 * 后台运行：start /b node watch.js （Windows）
 */

require("dotenv").config();
var https = require("https");
var http = require("http");
var fs = require("fs");
var path = require("path");
var nodemailer = require("nodemailer");

// ============ 配置 ============
var RSSHUB_URL = "https://my-rsshub-z6ig.onrender.com";
var TWITTER_HANDLE = "aleabitoreddit";
var CHECK_INTERVAL = 10 * 60 * 1000; // 10 分钟
var SEEN_FILE = path.join(__dirname, "data", "seen-tweets.json");

// ============ 工具函数 ============
function httpGet(url, timeoutMs) {
  if (!timeoutMs) timeoutMs = 30000;
  return new Promise(function(resolve, reject) {
    var parsed = new URL(url);
    var lib = parsed.protocol === "https:" ? https : http;
    var req = lib.get(url, {
      headers: { "User-Agent": "QDII-Watcher/1.0" },
      timeout: timeoutMs
    }, function(res) {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpGet(res.headers.location, timeoutMs).then(resolve).catch(reject);
      }
      var data = "";
      res.on("data", function(chunk) { data += chunk; });
      res.on("end", function() { resolve(data); });
    });
    req.on("error", reject);
    req.on("timeout", function() { req.destroy(); reject(new Error("timeout")); });
  });
}

function loadSeen() {
  try {
    if (fs.existsSync(SEEN_FILE)) {
      return JSON.parse(fs.readFileSync(SEEN_FILE, "utf8"));
    }
  } catch(e) {}
  return { ids: [], lastCheck: null };
}

function saveSeen(seen) {
  try {
    fs.mkdirSync(path.dirname(SEEN_FILE), { recursive: true });
    fs.writeFileSync(SEEN_FILE, JSON.stringify(seen, null, 1), "utf8");
  } catch(e) {
    console.error("[save] error:", e.message);
  }
}

function parseRssItems(xml) {
  var items = [];
  var itemRe = /<item[\s\S]*?<\/item>/gi;
  var match;
  while ((match = itemRe.exec(xml)) && items.length < 20) {
    var block = match[0];
    var titleMatch = block.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    var guidMatch = block.match(/<guid[^>]*>([\s\S]*?)<\/guid>/i);
    var descMatch = block.match(/<description[^>]*>([\s\S]*?)<\/description>/i);
    var pubMatch = block.match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i);
    var linkMatch = block.match(/<link[^>]*>([\s\S]*?)<\/link>/i);
    
    var title = titleMatch ? titleMatch[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">") : "";
    var guid = guidMatch ? guidMatch[1].trim() : "";
    var desc = descMatch ? descMatch[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim() : "";
    var pubDate = pubMatch ? pubMatch[1].trim() : "";
    var link = linkMatch ? linkMatch[1].trim() : "";
    
    if (guid || title) {
      items.push({ id: guid || link || title, title: title, desc: desc.substring(0, 300), time: pubDate, link: link });
    }
  }
  return items;
}

function extractTickers(text) {
  var matches = text.match(/\$[A-Z]{2,6}/g) || [];
  var unique = {};
  matches.forEach(function(m) { unique[m] = true; });
  return Object.keys(unique).join(", ");
}

// ============ 邮件发送 ============
async function sendNotification(newTweets) {
  var host = process.env.SMTP_HOST;
  var port = parseInt(process.env.SMTP_PORT || "465");
  var user = process.env.SMTP_USER;
  var pass = process.env.SMTP_PASS;
  var to = process.env.MAIL_TO;
  
  if (!host || !user || !pass || !to) {
    console.error("[mail] SMTP not configured, skipping email");
    return false;
  }
  
  var transporter = nodemailer.createTransport({
    host: host, port: port, secure: port === 465,
    auth: { user: user, pass: pass }
  });
  
  var lines = [];
  lines.push("🔔 Serenity (@aleabitoreddit) 发布了 " + newTweets.length + " 条新推文！");
  lines.push("");
  
  var htmlLines = [];
  htmlLines.push("<h2>🔔 Serenity 新推文通知</h2>");
  htmlLines.push("<p>检测到 <b>" + newTweets.length + "</b> 条新推文：</p>");
  
  newTweets.forEach(function(t, i) {
    var tickers = extractTickers(t.title + " " + t.desc);
    lines.push("--- 推文 " + (i+1) + " ---");
    lines.push(t.title);
    lines.push(t.desc.substring(0, 200));
    if (tickers) lines.push("涉及股票: " + tickers);
    lines.push("时间: " + t.time);
    if (t.link) lines.push("链接: " + t.link);
    lines.push("");
    
    htmlLines.push("<hr>");
    htmlLines.push("<h3>推文 " + (i+1) + "</h3>");
    htmlLines.push("<p><b>" + t.title + "</b></p>");
    htmlLines.push("<p>" + t.desc.substring(0, 300) + "</p>");
    if (tickers) htmlLines.push("<p>📈 涉及股票: <b>" + tickers + "</b></p>");
    htmlLines.push("<p style='color:#666'>⏰ " + t.time + "</p>");
    if (t.link) htmlLines.push("<p><a href='" + t.link + "'>查看原文</a></p>");
  });
  
  try {
    await transporter.sendMail({
      from: user,
      to: to,
      subject: "🔔 Serenity 新推文 (" + newTweets.length + "条) - " + new Date().toLocaleString("zh-CN"),
      text: lines.join("\n"),
      html: htmlLines.join("\n")
    });
    console.log("[mail] ✅ 通知已发送 (" + newTweets.length + " 条新推文)");
    return true;
  } catch(e) {
    console.error("[mail] ❌ 发送失败:", e.message);
    return false;
  }
}

// ============ 主循环 ============
async function checkOnce() {
  var now = new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
  console.log("\n[" + now + "] 检查新推文...");
  
  try {
    var url = RSSHUB_URL + "/twitter/user/" + TWITTER_HANDLE;
    var xml = await httpGet(url, 30000);
    var items = parseRssItems(xml);
    
    if (items.length === 0) {
      console.log("[check] 未获取到推文（RSSHub 可能冷启动中）");
      return;
    }
    
    console.log("[check] 获取到 " + items.length + " 条推文");
    
    var seen = loadSeen();
    var newTweets = items.filter(function(item) {
      return seen.ids.indexOf(item.id) === -1;
    });
    
    if (newTweets.length > 0) {
      console.log("[check] 🆕 发现 " + newTweets.length + " 条新推文！");
      newTweets.forEach(function(t) {
        var tickers = extractTickers(t.title + " " + t.desc);
        console.log("  → " + t.title.substring(0, 80) + (tickers ? " [" + tickers + "]" : ""));
      });
      
      await sendNotification(newTweets);
      
      // 更新已读列表（保留最近 100 条）
      newTweets.forEach(function(t) { seen.ids.push(t.id); });
      if (seen.ids.length > 100) seen.ids = seen.ids.slice(-100);
    } else {
      console.log("[check] 没有新推文");
    }
    
    seen.lastCheck = new Date().toISOString();
    saveSeen(seen);
    
  } catch(e) {
    console.error("[check] ❌ 检查失败:", e.message);
  }
}

async function main() {
  console.log("========================================");
  console.log("  Serenity (@aleabitoreddit) 推文监控");
  console.log("  检查间隔: " + (CHECK_INTERVAL / 60000) + " 分钟");
  console.log("  RSSHub: " + RSSHUB_URL);
  console.log("  邮件通知: " + (process.env.MAIL_TO || "未配置"));
  console.log("========================================");
  console.log("按 Ctrl+C 停止\n");
  
  // 首次立即检查
  await checkOnce();
  
  // 定时循环
  setInterval(checkOnce, CHECK_INTERVAL);
}

main().catch(function(err) {
  console.error("[fatal]", err);
  process.exit(1);
});
