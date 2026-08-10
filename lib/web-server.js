const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const rateLimit = require("express-rate-limit");
const portfolio = require("./portfolio");
const fundData = require("./fund-data");
const smartQa = require("./smart-qa");
const fundDeepDive = require("./fund-deep-dive");

// [security] LLM 代理允许的 baseUrl 白名单（防 SSRF）
const LLM_BASE_URL_WHITELIST = [
  "api.siliconflow.cn",
  "api.openai.com",
  "api.deepseek.com",
  "api.mimoai.org",
  "open.bigmodel.cn",
  "dashscope.aliyuncs.com",
  "token-plan-cn.xiaomimimo.com"
];

const FUNDS_FILE = path.join(__dirname, "..", "data", "funds.json");

function loadFunds() {
  try {
    if (fs.existsSync(FUNDS_FILE)) {
      return JSON.parse(fs.readFileSync(FUNDS_FILE, "utf-8"));
    }
  } catch (e) {
    console.warn("[web] 加载基金配置失败，使用空配置:", e.message);
  }
  return { config: {}, funds: [] };
}

function buildHtml(fundsList) {
  // 按基金公司分组
  const grouped = {};
  fundsList.forEach(function (f) {
    // 提取基金公司名：匹配已知公司名
    let corp = "";
    const m = f.name.match(
      /^(广发|易方达|华泰柏瑞|华夏|南方|华安|嘉实|大成|博时|工银|招商|天弘|富国|银华|万家|浦银安盛|摩根|景顺长城|国泰|汇添富|鹏华|建信|中银|交银|兴全|睿远|中欧|诺安|长城|融通|泰达宏利|信诚|海富通|上投摩根|长盛|国富|光大保德信|中邮|东方|新华|民生加银|兴业|安信|宝盈|创金合信|前海开源|永赢|太平|财通|中金|红土创新)/
    );
    if (m) corp = m[1];
    else corp = f.name.substring(0, 2);
    if (!grouped[corp]) grouped[corp] = [];
    grouped[corp].push(f);
  });

  // 生成 optgroup
  const fundOptions = Object.keys(grouped)
    .sort()
    .map(function (corp) {
      const options = grouped[corp]
        .map(function (f) {
          const limit = f.dailyLimit && f.dailyLimit < 100000 ? " (限" + f.dailyLimit + ")" : "";
          return '<option value="' + f.code + '">' + f.code + " " + f.name + limit + "</option>";
        })
        .join("");
      return '<optgroup label="' + corp + "（" + grouped[corp].length + '）">' + options + "</optgroup>";
    })
    .join("");

  const templatePath = path.join(__dirname, "..", "views", "index.html");
  const template = fs.readFileSync(templatePath, "utf8");
  return template.replace("{{FUND_OPTIONS}}", fundOptions);
}

function buildQuickHtml() {
  const templatePath = path.join(__dirname, "..", "views", "quick.html");
  return fs.readFileSync(templatePath, "utf8");
}

function buildLoginHtml(hasError) {
  const error = hasError ? '<p role="alert" style="color:#b42318">Token 不正确，请重试。</p>' : "";
  return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>QDII 本地登录</title><style>' +
    'body{font-family:system-ui,sans-serif;background:#f5f7fa;margin:0;padding:24px;color:#1d2939}' +
    'main{max-width:420px;margin:10vh auto;background:#fff;padding:28px;border-radius:16px;box-shadow:0 8px 30px rgba(16,24,40,.1)}' +
    'h1{font-size:24px;margin:0 0 12px}p{line-height:1.6}label{display:block;font-weight:600;margin:20px 0 8px}' +
    'input{box-sizing:border-box;width:100%;font-size:18px;padding:12px;border:1px solid #98a2b3;border-radius:10px}' +
    'button{width:100%;margin-top:18px;padding:13px;font-size:18px;border:0;border-radius:10px;background:#175cd3;color:#fff;cursor:pointer}' +
    '</style></head><body><main><h1>本地系统登录</h1>' +
    '<p>请输入启动终端显示的 Web Token。登录状态只保存在本次服务进程中。</p>' + error +
    '<form method="post" action="/login"><label for="token">Web Token</label>' +
    '<input id="token" name="token" type="password" required autocomplete="current-password" autofocus>' +
    '<button type="submit">进入系统</button></form></main></body></html>';
}

function parseCookies(header) {
  const result = {};
  String(header || "").split(";").forEach(function(part) {
    const index = part.indexOf("=");
    if (index <= 0) return;
    result[part.slice(0, index).trim()] = part.slice(index + 1).trim();
  });
  return result;
}

function safeTokenEqual(actual, expected) {
  const actualBuffer = Buffer.from(String(actual || ""));
  const expectedBuffer = Buffer.from(String(expected || ""));
  return actualBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

function fetchEstimatedNav(code) {
  return new Promise(function (resolve) {
    const https = require("https");
    const url = "https://fundgz.1234567.com.cn/js/" + code + ".js";
    https
      .get(
        url,
        {
          headers: { Referer: "https://fund.eastmoney.com/" },
          timeout: 5000
        },
        function (res) {
          let data = "";
          res.on("data", function (chunk) {
            data += chunk;
          });
          res.on("end", function () {
            try {
              const match = data.match(/jsonpgz\((.*)\)/);
              if (match) {
                const json = JSON.parse(match[1]);
                if (json.gsz && parseFloat(json.gsz) > 0) {
                  resolve(parseFloat(json.gsz));
                  return;
                }
              }
            } catch (e) {
              console.warn("[web] 解析估值数据失败:", e.message);
            }
            resolve(null);
          });
        }
      )
      .on("error", function () {
        resolve(null);
      });
  });
}

function parseBatchLine(line, fundsList) {
  line = line.trim();
  if (!line || line.startsWith("#")) return null;

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
  let fund = fundsList.find(function (f) {
    return f.code === codeOrName;
  });
  if (fund) {
    return { code: fund.code, name: fund.name, amount: amount, nav: nav, date: date, settleDays: fund.settleDays || 2 };
  }

  // Try to find by name substring
  fund = fundsList.find(function (f) {
    return f.name.indexOf(codeOrName) >= 0;
  });
  if (fund) {
    return { code: fund.code, name: fund.name, amount: amount, nav: nav, date: date, settleDays: fund.settleDays || 2 };
  }

  // Treat as code
  return { code: codeOrName, name: codeOrName, amount: amount, nav: nav, date: date, settleDays: 2 };
}

function createApp(options) {
  options = options || {};
  const app = express();
  app.disable("x-powered-by");
  // [security] 请求体大小限制 1MB
  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: false, limit: "16kb" }));

  const authToken = options.authToken || process.env.WEB_AUTH_TOKEN || crypto.randomBytes(32).toString("hex");
  const sessions = new Set();
  const sessionCookieName = "trade_session";
  const configuredPort = options.port || process.env.PORT || 3000;

  if (!options.authToken && !process.env.WEB_AUTH_TOKEN) {
    console.log("[web] ⚠️ 未配置 WEB_AUTH_TOKEN，自动生成临时 Token（重启后失效）:");
    console.log("[web]    Token: " + authToken);
  }

  // [修复] 原问题：速率限制仅覆盖 /api/，全局无限制
  const globalLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "请求过于频繁，请稍后再试" }
  });
  app.use(globalLimiter);

  // [修复] 安全头 + CORS 策略
  app.use(function (req, res, next) {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("X-XSS-Protection", "1; mode=block");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self' 'unsafe-inline' cdn.jsdelivr.net; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'"
    );
    // [security] CORS — 允许本地开发 + 同源
    const origin = req.headers.origin;
    if (
      !origin ||
      origin === "http://localhost:" + configuredPort ||
      origin === "http://127.0.0.1:" + configuredPort
    ) {
      if (origin) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Access-Control-Allow-Credentials", "true");
      }
    }
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  });

  // [monitor] 请求日志中间件（耗时、状态码）
  app.use(function (req, res, next) {
    const startMs = Date.now();
    const originalEnd = res.end;
    res.end = function () {
      const duration = Date.now() - startMs;
      const level = res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info";
      console.log("[req] " + level + " " + req.method + " " + req.path + " " + res.statusCode + " " + duration + "ms");
      originalEnd.apply(res, arguments);
    };
    next();
  });

  app.get("/login", function (_req, res) {
    res.setHeader("Cache-Control", "no-store");
    res.type("html").send(buildLoginHtml(false));
  });

  app.post("/login", function (req, res) {
    if (!safeTokenEqual(req.body && req.body.token, authToken)) {
      res.setHeader("Cache-Control", "no-store");
      return res.status(401).type("html").send(buildLoginHtml(true));
    }
    if (sessions.size >= 20) sessions.clear();
    const sessionId = crypto.randomBytes(32).toString("hex");
    sessions.add(sessionId);
    res.setHeader(
      "Set-Cookie",
      sessionCookieName + "=" + sessionId + "; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800"
    );
    res.redirect(303, "/");
  });

  app.post("/logout", function (req, res) {
    const sessionId = parseCookies(req.headers.cookie)[sessionCookieName];
    if (sessionId) sessions.delete(sessionId);
    res.setHeader("Set-Cookie", sessionCookieName + "=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0");
    res.redirect(303, "/login");
  });

  app.get("/favicon.ico", function (_req, res) {
    res.status(204).end();
  });

  app.use(function (req, res, next) {
    if (req.path === "/health") return next();
    const authHeader = req.headers.authorization;
    const bearerAuthorized = authHeader && authHeader.startsWith("Bearer ") && safeTokenEqual(authHeader.slice(7), authToken);
    const sessionId = parseCookies(req.headers.cookie)[sessionCookieName];
    if (bearerAuthorized || (sessionId && sessions.has(sessionId))) {
      res.setHeader("Cache-Control", "no-store");
      return next();
    }
    if (req.path.startsWith("/api/")) {
      return res.status(401).json({ error: "未授权，请先登录或提供有效的 Bearer Token" });
    }
    res.redirect("/login");
  });
  console.log("[web] 页面和 API 鉴权已启用");

  // [monitor] 健康检查端点（不需要鉴权）
  app.get("/health", function (_req, res) {
    try {
      res.json({
        status: "ok",
        uptime: Math.floor(process.uptime()),
        memory: { rss: Math.round(process.memoryUsage().rss / 1024 / 1024) + "MB" },
        timestamp: new Date().toISOString()
      });
    } catch (_e) {
      res.status(503).json({ status: "error", message: "service degraded" });
    }
  });

  app.get("/", function (req, res) {
    const data = loadFunds();
    res.type("html").send(buildHtml(data.funds || []));
  });

  app.get("/api/funds", function (req, res) {
    res.json(loadFunds());
  });

  app.get("/api/buys", function (req, res) {
    res.json(portfolio.calcPortfolioSummary());
  });

  app.post("/api/buys", function (req, res) {
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
    const fund = data.funds.find(function (f) {
      return f.code === code;
    });
    const name = fund ? fund.name : code;
    const settleDays = fund ? fund.settleDays : 2;

    const holding = portfolio.recordBuy(code, name, amount, nav, date, settleDays);
    if (!holding) {
      return res.json({ error: "记录失败，检查日期格式" });
    }

    res.json({ ok: true, code: code, name: name, amount: amount, nav: nav });
  });

  // 批量添加买入记录
  app.post("/api/buys/batch", function (req, res) {
    const items = req.body.items;
    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "请提供有效的买入记录数组" });
    }

    const data = loadFunds();
    let added = 0;
    const errors = [];

    items.forEach(function (item, idx) {
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

      const fund = data.funds.find(function (f) {
        return f.code === code;
      });
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
  app.post("/api/sells", function (req, res) {
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
    const fund = data.funds.find(function (f) {
      return f.code === code;
    });
    const name = fund ? fund.name : code;

    const result = portfolio.recordSell(code, name, amount, nav, date);
    if (!result) {
      return res.json({ error: "卖出失败，请检查持仓和净值" });
    }
    res.json({ ok: true, result: result });
  });

  // 更新买入记录的净值
  app.put("/api/buys/:code/:index", function (req, res) {
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
    const holding = p.holdings.find(function (h) {
      return h.code === code;
    });
    if (!holding) return res.json({ error: "未找到该基金持仓" });
    if (index < 0 || index >= holding.buys.length) return res.json({ error: "无效的记录索引" });

    const buy = holding.buys[index];
    buy.nav = nav;
    buy.shares = Math.round((buy.amount / nav) * 10000) / 10000;

    portfolio.savePortfolio(p);
    res.json({ ok: true, nav: nav, shares: buy.shares });
  });

  // [修复] 原问题：重复的 POST /api/buys/batch 路由（已有 JSON 数组版本，此处为多余的文本版本）
  // 文本批量录入已通过 /api/quick-add 端点处理

  // 自动刷新待更新净值
  app.post("/api/refresh-nav", async function (req, res) {
    const p = portfolio.loadPortfolio();
    const _navCache = fundData.loadNavCache();
    let updated = 0;

    for (const h of p.holdings) {
      const needFetch = h.buys.some(function (b) {
        return !b.nav && b.settleDate;
      });
      if (!needFetch) continue;

      // 刷新该基金净值缓存
      try {
        await fundData.getFundNavHistory(h.code, 10);
      } catch (e) {
        console.warn("[web] 刷新净值缓存失败 " + h.code + ":", e.message);
      }

      const cache = fundData.loadNavCache();
      const fundNavs = cache[h.code] || [];

      // 获取实时估值（东方财富更新慢时的后备）
      let estimatedNav = null;
      const unsettled = h.buys.filter(function (b) {
        return !b.nav && b.settleDate;
      });
      if (unsettled.length > 0) {
        estimatedNav = await fetchEstimatedNav(h.code);
      }

      for (const b of h.buys) {
        if (!b.nav && b.settleDate) {
          // 先从净值缓存找
          let navData = fundNavs.find(function (n) {
            return n.date === b.settleDate;
          });
          if (!navData) {
            for (const n of fundNavs) {
              if (n.date >= b.settleDate) {
                navData = n;
                break;
              }
            }
          }
          if (navData) {
            b.nav = navData.nav;
            b.shares = Math.round((b.amount / b.nav) * 10000) / 10000;
            updated++;
          } else if (estimatedNav && b.settleDate <= new Date().toISOString().slice(0, 10)) {
            // 官方净值没有，用估值作为临时值
            b.nav = estimatedNav;
            b.shares = Math.round((b.amount / b.nav) * 10000) / 10000;
            b.estimated = true;
            updated++;
          } else if (b.settleDate <= new Date().toISOString().slice(0, 10) && fundNavs.length > 0) {
            // 估值也没有，用缓存中最新的净值作为近似值
            const latestNav = fundNavs[fundNavs.length - 1].nav;
            b.nav = latestNav;
            b.shares = Math.round((b.amount / b.nav) * 10000) / 10000;
            b.estimated = true;
            updated++;
          }
        }
      }
    }

    if (updated > 0) portfolio.savePortfolio(p);
    res.json({ ok: true, updated: updated });
  });

  app.delete("/api/buys/:code/:index", function (req, res) {
    const code = req.params.code;
    const index = parseInt(req.params.index);
    if (!code || !/^\d{6}$/.test(code)) {
      return res.status(400).json({ error: "基金代码必须为6位数字" });
    }
    if (isNaN(index) || index < 0) {
      return res.status(400).json({ error: "无效的记录索引" });
    }
    const p = portfolio.loadPortfolio();
    const holding = p.holdings.find(function (h) {
      return h.code === code;
    });
    if (!holding) return res.json({ error: "未找到该基金持仓" });
    if (index < 0 || index >= holding.buys.length) return res.json({ error: "无效的记录索引" });

    holding.buys.splice(index, 1);
    if (holding.buys.length === 0) {
      p.holdings = p.holdings.filter(function (h) {
        return h.code !== code;
      });
    }
    const allDates = [];
    p.holdings.forEach(function (h) {
      h.buys.forEach(function (b) {
        allDates.push(b.date);
      });
    });
    p.startDate = allDates.length > 0 ? allDates.sort()[0] : null;
    portfolio.savePortfolio(p);
    res.json({ ok: true });
  });

  app.delete("/api/buys/:code", function (req, res) {
    const code = req.params.code;
    if (!code || !/^\d{6}$/.test(code)) {
      return res.status(400).json({ error: "基金代码必须为6位数字" });
    }
    const p = portfolio.loadPortfolio();
    const target = p.holdings.find(function (h) {
      return h.code === code;
    });
    if (!target) return res.json({ error: "未找到该基金持仓" });

    const name = target.name;
    const buyCount = target.buys.length;
    p.holdings = p.holdings.filter(function (h) {
      return h.code !== code;
    });
    const allDates = [];
    p.holdings.forEach(function (h) {
      h.buys.forEach(function (b) {
        allDates.push(b.date);
      });
    });
    p.startDate = allDates.length > 0 ? allDates.sort()[0] : null;
    portfolio.savePortfolio(p);
    res.json({ ok: true, name: name, buyCount: buyCount });
  });

  // 按日期删除买入记录
  app.delete("/api/buys/date/:date", function (req, res) {
    const date = req.params.date;
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: "日期格式必须为 YYYY-MM-DD" });
    }
    const p = portfolio.loadPortfolio();
    let deleted = 0;

    p.holdings.forEach(function (h) {
      const before = h.buys.length;
      h.buys = h.buys.filter(function (b) {
        return b.date !== date;
      });
      deleted += before - h.buys.length;
    });

    // 删除空持仓
    p.holdings = p.holdings.filter(function (h) {
      return h.buys.length > 0;
    });

    const allDates = [];
    p.holdings.forEach(function (h) {
      h.buys.forEach(function (b) {
        allDates.push(b.date);
      });
    });
    p.startDate = allDates.length > 0 ? allDates.sort()[0] : null;
    portfolio.savePortfolio(p);
    res.json({ ok: true, deleted: deleted });
  });

  app.delete("/api/buys-all", function (req, res) {
    portfolio.savePortfolio({ holdings: [], startDate: null });
    res.json({ ok: true });
  });

  // 快速买入 - 接受纯文本命令如 "270042 10"
  app.post("/api/quick-add", function (req, res) {
    const text = (req.body.text || "").trim();
    if (!text) return res.json({ error: "请输入内容" });

    const data = loadFunds();
    const results = [];

    // 支持逗号分隔批量
    const entries =
      text.indexOf(",") !== -1
        ? text
            .split(",")
            .map(function (s) {
              return s.trim();
            })
            .filter(Boolean)
        : [text];

    for (let i = 0; i < entries.length; i++) {
      const line = entries[i].trim();
      const parsed = parseBatchLine(line, data.funds || []);
      if (!parsed) {
        results.push({ ok: false, input: line, error: "格式错误" });
        continue;
      }

      const holding = portfolio.recordBuy(
        parsed.code,
        parsed.name,
        parsed.amount,
        parsed.nav,
        parsed.date,
        parsed.settleDays
      );
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

  // AI智能问答API
  app.post("/api/ask", async function (req, res) {
    try {
      const question = req.body.question;
      if (!question || typeof question !== "string") {
        return res.status(400).json({ error: "请提供问题内容" });
      }
      if (question.length > 2000) {
        return res.status(400).json({ error: "问题内容过长" });
      }
      console.log("[web] AI问答: " + question.substring(0, 100));
      const result = await smartQa.askQuestion(question);
      res.json(result);
    } catch (error) {
      console.error("[web] AI问答失败:", error.message);
      res.status(500).json({ error: "AI问答暂时不可用，请稍后再试" });
    }
  });

  // 基金深度分析API
  app.post("/api/fund-deep-dive", async function (req, res) {
    try {
      const { code } = req.body;
      if (!code || !/^\d{6}$/.test(code)) {
        return res.status(400).json({ error: "请提供有效的6位基金代码" });
      }
      console.log("[web] 基金深度分析: " + code);
      const result = await fundDeepDive.analyzeFund(code);
      res.json(result);
    } catch (error) {
      console.error("[web] 基金深度分析失败:", error.message);
      res.status(500).json({ error: "深度分析暂时不可用，请稍后再试" });
    }
  });

  // [security] LLM 代理端点 — 前端不直接存储 API Key，通过服务器代理
  app.post("/api/llm-proxy", async function (req, res) {
    try {
      const { messages, model, baseUrl } = req.body;
      if (!messages || !Array.isArray(messages)) {
        return res.status(400).json({ error: "请提供 messages 数组" });
      }
      if (messages.length > 50) {
        return res.status(400).json({ error: "消息数量过多" });
      }
      const apiKey = process.env.LLM_API_KEY;
      if (!apiKey) {
        return res.status(503).json({ error: "AI 服务未配置" });
      }
      let targetUrl = baseUrl || process.env.LLM_BASE_URL || "https://api.siliconflow.cn/v1";

      // [security] SSRF 防护 — 验证 baseUrl 是否在白名单中
      try {
        const parsedUrl = new URL(targetUrl);
        const isWhitelisted = LLM_BASE_URL_WHITELIST.some(function (allowed) {
          return parsedUrl.hostname === allowed || parsedUrl.hostname.endsWith("." + allowed);
        });
        if (!isWhitelisted) {
          console.warn("[web] LLM代理拒绝非白名单域名: " + parsedUrl.hostname);
          return res.status(403).json({ error: "不允许的 API 地址" });
        }
      } catch (_e) {
        return res.status(400).json({ error: "无效的 API 地址" });
      }

      if (!targetUrl.endsWith("/chat/completions")) {
        targetUrl = targetUrl + "/chat/completions";
      }
      const targetModel = model || process.env.LLM_MODEL || "Qwen/Qwen3-8B";

      const fetchRes = await fetch(targetUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + apiKey },
        body: JSON.stringify({ model: targetModel, messages: messages })
      });
      const data = await fetchRes.json();
      res.json(data);
    } catch (error) {
      console.error("[web] LLM代理失败:", error.message);
      res.status(500).json({ error: "AI 代理暂时不可用，请稍后再试" });
    }
  });

  // 快速买入页面（手机友好）
  app.get("/quick", function (req, res) {
    res.type("html").send(buildQuickHtml());
  });

  // 统一错误处理中间件
  app.use(function (err, req, res, _next) {
    console.error("[web] error:", err.message);
    res.status(500).json({ error: "服务器内部错误" });
  });

  return app;
}

function startWebServer(port) {
  if (!port) port = 3000;
  const host = process.env.WEB_HOST || "127.0.0.1";
  const app = createApp({ port: port });
  const server = app.listen(port, host, function () {
    console.log("========================================");
    console.log("  QDII Fund Allocator - Web UI");
    console.log("  http://" + (host === "127.0.0.1" ? "localhost" : host) + ":" + port);
    if (host !== "127.0.0.1" && host !== "::1" && host !== "localhost") {
      console.log("  ⚠️ 已显式开放非本机访问，所有页面和 API 均需登录");
    }
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
        } catch (e) {
          /* 单只失败不影响其他 */
        }
      }
      console.log("[web] 净值刷新完成");
    } catch (e) {
      console.warn("[web] 后台刷新失败:", e.message);
    }
  }
  // 启动后 5 分钟执行首次刷新，之后每 30 分钟
  setTimeout(backgroundRefresh, 5 * 60 * 1000);
  const refreshTimer = setInterval(backgroundRefresh, REFRESH_INTERVAL);
  refreshTimer.unref();

  // 优雅关闭
  process.on("SIGTERM", function () {
    console.log("[web] SIGTERM received, shutting down...");
    clearInterval(refreshTimer);
    server.close(function () {
      console.log("[web] server closed");
      process.exit(0);
    });
  });

  // [monitor] 全局未捕获异常处理
  process.on("unhandledRejection", function (reason) {
    console.error("[web] unhandledRejection:", reason instanceof Error ? reason.message : reason);
  });
  process.on("uncaughtException", function (err) {
    console.error("[web] uncaughtException:", err.message);
    // 给 1 秒让日志 flush，然后退出（PM2/systemd 会重启）
    setTimeout(function () {
      process.exit(1);
    }, 1000);
  });
  return server;
}

module.exports = {
  startWebServer: startWebServer,
  createApp: createApp,
  LLM_BASE_URL_WHITELIST: LLM_BASE_URL_WHITELIST
};
