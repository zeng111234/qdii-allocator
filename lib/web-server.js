const express = require("express");
const fs = require("fs");
const path = require("path");
const rateLimit = require("express-rate-limit");
const portfolio = require("./portfolio");
const fundData = require("./fund-data");

const FUNDS_FILE = path.join(__dirname, "..", "data", "funds.json");

function loadFunds() {
  try {
    if (fs.existsSync(FUNDS_FILE)) {
      return JSON.parse(fs.readFileSync(FUNDS_FILE, "utf-8"));
    }
  } catch(e) {
    console.warn("[web] 加载基金配置失败，使用空配置:", e.message);
  }
  return { config: {}, funds: [] };
}

function buildHtml(fundsList) {
  // 按 type 分组
  const grouped = {};
  fundsList.forEach(function(f) {
    const type = f.type || '其他';
    if (!grouped[type]) grouped[type] = [];
    grouped[type].push(f);
  });

  // 生成 optgroup
  const fundOptions = Object.keys(grouped).map(function(type) {
    const options = grouped[type].map(function(f) {
      const limit = f.dailyLimit && f.dailyLimit < 100000 ? ' (限' + f.dailyLimit + ')' : '';
      return '<option value="' + f.code + '">' + f.code + ' ' + f.name + limit + '</option>';
    }).join('');
    return '<optgroup label="' + type + '">' + options + '</optgroup>';
  }).join('');

  const templatePath = path.join(__dirname, "..", "views", "index.html");
  const template = fs.readFileSync(templatePath, "utf8");
  return template.replace("{{FUND_OPTIONS}}", fundOptions);
}

function buildQuickHtml() {
  const templatePath = path.join(__dirname, "..", "views", "quick.html");
  return fs.readFileSync(templatePath, "utf8");
}

function fetchEstimatedNav(code) {
  return new Promise(function(resolve) {
    const https = require("https");
    const url = "https://fundgz.1234567.com.cn/js/" + code + ".js";
    https.get(url, {
      headers: { "Referer": "https://fund.eastmoney.com/" },
      timeout: 5000
    }, function(res) {
      let data = "";
      res.on("data", function(chunk) { data += chunk; });
      res.on("end", function() {
        try {
          const match = data.match(/jsonpgz\((.*)\)/);
          if (match) {
            const json = JSON.parse(match[1]);
            if (json.gsz && parseFloat(json.gsz) > 0) {
              resolve(parseFloat(json.gsz));
              return;
            }
          }
        } catch(e) {
          console.warn("[web] 解析估值数据失败:", e.message);
        }
        resolve(null);
      });
    }).on("error", function() { resolve(null); });
  });
}

function parseBatchLine(line, fundsList) {
  line = line.trim();
  if (!line || line.startsWith('#')) return null;

  // Format: code amount [nav] [date]
  // or: name amount [nav] [date]
  const parts = line.split(/\s+/);
  if (parts.length < 2) return null;

  const codeOrName = parts[0];
  const amount = parseFloat(parts[1]);
  const nav = parts[2] ? parseFloat(parts[2]) : null;
  const date = parts[3] || null;

  if (!amount || amount <= 0) return null;

  // Try to find fund by code
  let fund = fundsList.find(function(f) { return f.code === codeOrName; });
  if (fund) {
    return { code: fund.code, name: fund.name, amount: amount, nav: nav, date: date, settleDays: fund.settleDays || 2 };
  }

  // Try to find by name substring
  fund = fundsList.find(function(f) { return f.name.indexOf(codeOrName) >= 0; });
  if (fund) {
    return { code: fund.code, name: fund.name, amount: amount, nav: nav, date: date, settleDays: fund.settleDays || 2 };
  }

  // Treat as code
  return { code: codeOrName, name: codeOrName, amount: amount, nav: nav, date: date, settleDays: 2 };
}


function createApp() {
  const app = express();
  app.use(express.json());

  // 速率限制：API 端点每分钟最多 60 次请求
  const apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "请求过于频繁，请稍后再试" }
  });
  app.use("/api/", apiLimiter);

  // Bearer Token 鉴权（可选，配置 WEB_AUTH_TOKEN 时启用）
  const AUTH_TOKEN = process.env.WEB_AUTH_TOKEN;
  if (AUTH_TOKEN) {
    app.use("/api/", function(req, res, next) {
      // GET 请求允许不带 token（只读操作）
      if (req.method === "GET") return next();

      const authHeader = req.headers.authorization;
      if (!authHeader || authHeader !== "Bearer " + AUTH_TOKEN) {
        return res.status(401).json({ error: "未授权，请提供有效的 Bearer Token" });
      }
      next();
    });
    console.log("[web] API 写操作鉴权已启用（WEB_AUTH_TOKEN）");
  } else {
    console.log("[web] 警告：未配置 WEB_AUTH_TOKEN，API 写操作无鉴权保护");
  }

  app.get("/", function(req, res) {
    const data = loadFunds();
    res.type("html").send(buildHtml(data.funds || []));
  });

  app.get("/api/funds", function(req, res) {
    res.json(loadFunds());
  });

  app.get("/api/buys", function(req, res) {
    res.json(portfolio.calcPortfolioSummary());
  });

  app.post("/api/buys", function(req, res) {
    const code = req.body.code;
    const amount = parseFloat(req.body.amount);
    const nav = req.body.nav ? parseFloat(req.body.nav) : null;
    const date = req.body.date || null;

    if (!code || !/^\d{6}$/.test(code)) {
      return res.status(400).json({ error: "基金代码必须为6位数字" });
    }
    if (!amount || isNaN(amount) || amount <= 0 || amount > 100000) {
      return res.status(400).json({ error: "金额必须为正数且不超过100000元" });
    }
    if (nav !== null && (isNaN(nav) || nav <= 0)) {
      return res.status(400).json({ error: "净值必须为正数" });
    }
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: "日期格式必须为 YYYY-MM-DD" });
    }

    const data = loadFunds();
    const fund = data.funds.find(function(f) { return f.code === code; });
    const name = fund ? fund.name : code;
    const settleDays = fund ? fund.settleDays : 2;

    const holding = portfolio.recordBuy(code, name, amount, nav, date, settleDays);
    if (!holding) {
      return res.json({ error: "记录失败，检查日期格式" });
    }

    res.json({ ok: true, code: code, name: name, amount: amount, nav: nav });
  });

  // 批量添加买入记录
  app.post("/api/buys/batch", function(req, res) {
    const items = req.body.items;
    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "请提供有效的买入记录数组" });
    }

    const data = loadFunds();
    let added = 0;
    let errors = [];

    items.forEach(function(item, idx) {
      const code = item.code;
      const amount = parseFloat(item.amount);
      const nav = item.nav ? parseFloat(item.nav) : null;
      const date = item.date || null;

      if (!code || !/^\d{6}$/.test(code)) {
        errors.push("第" + (idx + 1) + "条: 基金代码必须为6位数字");
        return;
      }
      if (!amount || isNaN(amount) || amount <= 0 || amount > 100000) {
        errors.push("第" + (idx + 1) + "条: 金额必须为正数且不超过100000元");
        return;
      }

      const fund = data.funds.find(function(f) { return f.code === code; });
      const name = fund ? fund.name : code;
      const settleDays = fund ? fund.settleDays : 2;

      const holding = portfolio.recordBuy(code, name, amount, nav, date, settleDays);
      if (holding) {
        added++;
      } else {
        errors.push("第" + (idx + 1) + "条: 记录失败");
      }
    });

    if (errors.length > 0 && added === 0) {
      return res.status(400).json({ error: errors.join("; ") });
    }

    res.json({ ok: true, added: added, errors: errors });
  });

  // 卖出记录
  app.post("/api/sells", function(req, res) {
    const code = req.body.code;
    const amount = parseFloat(req.body.amount);
    const nav = req.body.nav ? parseFloat(req.body.nav) : null;
    const date = req.body.date || null;

    if (!code || !/^\d{6}$/.test(code)) {
      return res.status(400).json({ error: "基金代码必须为6位数字" });
    }
    if (!amount || isNaN(amount) || amount <= 0 || amount > 10000000) {
      return res.status(400).json({ error: "金额必须为正数" });
    }
    if (nav !== null && (isNaN(nav) || nav <= 0)) {
      return res.status(400).json({ error: "净值必须为正数" });
    }

    const data = loadFunds();
    const fund = data.funds.find(function(f) { return f.code === code; });
    const name = fund ? fund.name : code;

    const result = portfolio.recordSell(code, name, amount, nav, date);
    if (!result) {
      return res.json({ error: "卖出失败，请检查持仓和净值" });
    }
    res.json({ ok: true, result: result });
  });

  // 更新买入记录的净值
  app.put("/api/buys/:code/:index", function(req, res) {
    const code = req.params.code;
    const index = parseInt(req.params.index);
    const nav = parseFloat(req.body.nav);

    if (!code || !/^\d{6}$/.test(code)) {
      return res.status(400).json({ error: "基金代码必须为6位数字" });
    }
    if (isNaN(index) || index < 0) {
      return res.status(400).json({ error: "无效的记录索引" });
    }
    if (!nav || isNaN(nav) || nav <= 0) {
      return res.status(400).json({ error: "请输入有效净值" });
    }

    const p = portfolio.loadPortfolio();
    const holding = p.holdings.find(function(h) { return h.code === code; });
    if (!holding) return res.json({ error: "未找到该基金持仓" });
    if (index < 0 || index >= holding.buys.length) return res.json({ error: "无效的记录索引" });

    const buy = holding.buys[index];
    buy.nav = nav;
    buy.shares = Math.round(buy.amount / nav * 10000) / 10000;

    portfolio.savePortfolio(p);
    res.json({ ok: true, nav: nav, shares: buy.shares });
  });

  app.post("/api/buys/batch", function(req, res) {
    const text = req.body.text;
    if (!text) return res.json({ error: "无内容" });

    const data = loadFunds();
    const lines = text.split('\n');
    let success = 0, failed = 0;
    const errors = [];

    lines.forEach(function(line, idx) {
      const parsed = parseBatchLine(line, data.funds || []);
      if (!parsed) { failed++; errors.push("行" + (idx+1) + ": 格式错误"); return; }

      const result = portfolio.recordBuy(parsed.code, parsed.name, parsed.amount, parsed.nav, parsed.date, parsed.settleDays);
      if (result) {
        success++;
      } else {
        failed++;
        errors.push("行" + (idx+1) + ": 记录失败");
      }
    });

    res.json({ ok: true, success: success, failed: failed, errors: errors.slice(0, 5) });
  });

  // 自动刷新待更新净值
  app.post("/api/refresh-nav", async function(req, res) {
    const p = portfolio.loadPortfolio();
    const navCache = fundData.loadNavCache();
    let updated = 0;

    for (const h of p.holdings) {
      const needFetch = h.buys.some(function(b) { return !b.nav && b.settleDate; });
      if (!needFetch) continue;

      // 刷新该基金净值缓存
      try {
        await fundData.getFundNavHistory(h.code, 10);
      } catch(e) {
        console.warn("[web] 刷新净值缓存失败 " + h.code + ":", e.message);
      }

      const cache = fundData.loadNavCache();
      const fundNavs = cache[h.code] || [];

      // 获取实时估值（东方财富更新慢时的后备）
      let estimatedNav = null;
      const unsettled = h.buys.filter(function(b) { return !b.nav && b.settleDate; });
      if (unsettled.length > 0) {
        estimatedNav = await fetchEstimatedNav(h.code);
      }

      for (const b of h.buys) {
        if (!b.nav && b.settleDate) {
          // 先从净值缓存找
          let navData = fundNavs.find(function(n) { return n.date === b.settleDate; });
          if (!navData) {
            for (const n of fundNavs) {
              if (n.date >= b.settleDate) { navData = n; break; }
            }
          }
          if (navData) {
            b.nav = navData.nav;
            b.shares = Math.round(b.amount / b.nav * 10000) / 10000;
            updated++;
          } else if (estimatedNav && b.settleDate <= new Date().toISOString().slice(0,10)) {
            // 官方净值没有，用估值作为临时值
            b.nav = estimatedNav;
            b.shares = Math.round(b.amount / b.nav * 10000) / 10000;
            b.estimated = true;
            updated++;
          } else if (b.settleDate <= new Date().toISOString().slice(0,10) && fundNavs.length > 0) {
            // 估值也没有，用缓存中最新的净值作为近似值
            const latestNav = fundNavs[fundNavs.length - 1].nav;
            b.nav = latestNav;
            b.shares = Math.round(b.amount / b.nav * 10000) / 10000;
            b.estimated = true;
            updated++;
          }
        }
      }
    }

    if (updated > 0) portfolio.savePortfolio(p);
    res.json({ ok: true, updated: updated });
  });

  app.delete("/api/buys/:code/:index", function(req, res) {
    const code = req.params.code;
    const index = parseInt(req.params.index);
    if (!code || !/^\d{6}$/.test(code)) {
      return res.status(400).json({ error: "基金代码必须为6位数字" });
    }
    if (isNaN(index) || index < 0) {
      return res.status(400).json({ error: "无效的记录索引" });
    }
    const p = portfolio.loadPortfolio();
    const holding = p.holdings.find(function(h) { return h.code === code; });
    if (!holding) return res.json({ error: "未找到该基金持仓" });
    if (index < 0 || index >= holding.buys.length) return res.json({ error: "无效的记录索引" });

    holding.buys.splice(index, 1);
    if (holding.buys.length === 0) {
      p.holdings = p.holdings.filter(function(h) { return h.code !== code; });
    }
    const allDates = [];
    p.holdings.forEach(function(h) { h.buys.forEach(function(b) { allDates.push(b.date); }); });
    p.startDate = allDates.length > 0 ? allDates.sort()[0] : null;
    portfolio.savePortfolio(p);
    res.json({ ok: true });
  });

  app.delete("/api/buys/:code", function(req, res) {
    const code = req.params.code;
    if (!code || !/^\d{6}$/.test(code)) {
      return res.status(400).json({ error: "基金代码必须为6位数字" });
    }
    const p = portfolio.loadPortfolio();
    const target = p.holdings.find(function(h) { return h.code === code; });
    if (!target) return res.json({ error: "未找到该基金持仓" });

    const name = target.name;
    const buyCount = target.buys.length;
    p.holdings = p.holdings.filter(function(h) { return h.code !== code; });
    const allDates = [];
    p.holdings.forEach(function(h) { h.buys.forEach(function(b) { allDates.push(b.date); }); });
    p.startDate = allDates.length > 0 ? allDates.sort()[0] : null;
    portfolio.savePortfolio(p);
    res.json({ ok: true, name: name, buyCount: buyCount });
  });

  // 按日期删除买入记录
  app.delete("/api/buys/date/:date", function(req, res) {
    const date = req.params.date;
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: "日期格式必须为 YYYY-MM-DD" });
    }
    const p = portfolio.loadPortfolio();
    let deleted = 0;

    p.holdings.forEach(function(h) {
      const before = h.buys.length;
      h.buys = h.buys.filter(function(b) { return b.date !== date; });
      deleted += before - h.buys.length;
    });

    // 删除空持仓
    p.holdings = p.holdings.filter(function(h) { return h.buys.length > 0; });

    const allDates = [];
    p.holdings.forEach(function(h) { h.buys.forEach(function(b) { allDates.push(b.date); }); });
    p.startDate = allDates.length > 0 ? allDates.sort()[0] : null;
    portfolio.savePortfolio(p);
    res.json({ ok: true, deleted: deleted });
  });

  app.delete("/api/buys-all", function(req, res) {
    portfolio.savePortfolio({ holdings: [], startDate: null });
    res.json({ ok: true });
  });

  // 快速买入 - 接受纯文本命令如 "270042 10"
  app.post("/api/quick-add", function(req, res) {
    const text = (req.body.text || "").trim();
    if (!text) return res.json({ error: "请输入内容" });

    const data = loadFunds();
    const results = [];

    // 支持逗号分隔批量
    const entries = text.indexOf(",") !== -1
      ? text.split(",").map(function(s) { return s.trim(); }).filter(Boolean)
      : [text];

    for (let i = 0; i < entries.length; i++) {
      const line = entries[i].trim();
      const parsed = parseBatchLine(line, data.funds || []);
      if (!parsed) {
        results.push({ ok: false, input: line, error: "格式错误" });
        continue;
      }

      const holding = portfolio.recordBuy(parsed.code, parsed.name, parsed.amount, parsed.nav, parsed.date, parsed.settleDays);
      if (holding) {
        const lastBuy = holding.buys[holding.buys.length - 1];
        results.push({
          ok: true,
          code: parsed.code,
          name: parsed.name,
          amount: parsed.amount,
          nav: lastBuy.nav,
          shares: lastBuy.shares,
          settleDate: lastBuy.settleDate
        });
      } else {
        results.push({ ok: false, name: parsed.name, error: "记录失败" });
      }
    }

    res.json({ ok: true, results: results });
  });

  // 快速买入页面（手机友好）
  app.get("/quick", function(req, res) {
    res.type("html").send(buildQuickHtml());
  });

  // 统一错误处理中间件
  app.use(function(err, req, res, _next) {
    console.error("[web] error:", err.message);
    res.status(500).json({ error: "服务器内部错误" });
  });

  return app;
}

function startWebServer(port) {
  if (!port) port = 3000;
  const app = createApp();
  const server = app.listen(port, function() {
    console.log("========================================");
    console.log("  QDII Fund Allocator - Web UI");
    console.log("  http://localhost:" + port);
    console.log("========================================");
  });

  // 后台定时刷新净值缓存（每 30 分钟）
  const REFRESH_INTERVAL = 30 * 60 * 1000;
  async function backgroundRefresh() {
    try {
      const p = portfolio.loadPortfolio();
      if (!p.holdings || p.holdings.length === 0) return;
      const codes = p.holdings.map(h => h.code);
      console.log("[web] 后台刷新 " + codes.length + " 只基金净值...");
      for (const code of codes) {
        try {
          await fundData.getFundNavHistory(code, 10);
        } catch(e) { /* 单只失败不影响其他 */ }
      }
      console.log("[web] 净值刷新完成");
    } catch(e) {
      console.warn("[web] 后台刷新失败:", e.message);
    }
  }
  // 启动后 5 分钟执行首次刷新，之后每 30 分钟
  setTimeout(backgroundRefresh, 5 * 60 * 1000);
  const refreshTimer = setInterval(backgroundRefresh, REFRESH_INTERVAL);

  // 优雅关闭
  process.on("SIGTERM", function() {
    console.log("[web] SIGTERM received, shutting down...");
    clearInterval(refreshTimer);
    server.close(function() {
      console.log("[web] server closed");
      process.exit(0);
    });
  });
}

module.exports = { startWebServer: startWebServer, createApp: createApp };
