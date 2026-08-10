const https = require("https");
const http = require("http");
const net = require("net");
const tls = require("tls");
const { URL } = require("url");

const DEFAULT_X_URL = "https://x.com/aleabitoreddit";
const DEFAULT_MIRRORS = [
  "https://my-rsshub-z6ig.onrender.com/twitter/user/{handle}",
  "https://rsshub.app/twitter/user/{handle}",
  "https://rsshub.rssforever.com/twitter/user/{handle}",
  "https://rsshub.rssbird.top/twitter/user/{handle}",
  "https://hub.slarker.me/twitter/user/{handle}",
  "https://rsshub.pseudoyu.com/twitter/user/{handle}"
];
const THEME_KEYWORDS = {
  nasdaq: ["nasdaq", "ndx", "qqq", "nvda", "microsoft", "apple", "meta", "tesla", "nvidia", "ai", "semiconductor", "chip"],
  sp500: ["s&p", "sp500", "s&p500", "spy", "spx", "us stocks", "equity"],
  biotech: ["biotech", "healthcare", "health care", "pharma", "drug", "fda"],
  reit: ["reit", "real estate", "property", "housing", "mortgage"],
  hongkong: ["hong kong", "hsi", "hang seng", "china", "hk", "asia", "emerging market"],
  oil: ["oil", "crude", "brent", "wti", "energy", "opec"],
  commodities: ["commodity", "commodities", "gold", "copper", "silver", "metal"],
  bonds: ["bond", "bonds", "treasury", "yield", "duration", "rate cut", "rate hike", "fed"],
  globalTech: ["global tech", "technology", "software", "cloud", "ai", "semiconductor", "chip"]
};

/**
 * 股票代码 → 投资主题映射（用于发现新投资方向）
 */
const TICKER_THEME_MAP = {
  // AI/半导体核心
  NVDA: { theme: "AI芯片/GPU", related: ["nasdaq"], keywords: ["ai", "gpu", "nvidia", "semiconductor"] },
  AMD: { theme: "AI芯片/GPU", related: ["nasdaq"], keywords: ["ai", "gpu", "amd", "semiconductor"] },
  AVGO: { theme: "AI芯片/网络", related: ["nasdaq"], keywords: ["ai", "broadcom", "networking"] },
  INTC: { theme: "半导体制造", related: ["nasdaq"], keywords: ["intel", "semiconductor", "foundry"] },
  // CPO/光子学（新方向）
  SIVE: { theme: "CPO光子学", related: [], keywords: ["cpo", "photonics", "silicon photonics", "laser"] },
  AAOI: { theme: "CPO光子学", related: [], keywords: ["cpo", "photonics", "optical"] },
  LITE: { theme: "CPO光子学", related: [], keywords: ["cpo", "photonics", "lumentum"] },
  XFAB: { theme: "硅光子代工", related: [], keywords: ["silicon photonics", "foundry", "cpo"] },
  // 内存/存储
  MU: { theme: "内存/存储芯片", related: ["nasdaq"], keywords: ["memory", "dram", "nand", "micron"] },
  EWY: { theme: "韩国半导体(三星/SK)", related: ["hongkong"], keywords: ["samsung", "sk hynix", "korea", "memory"] },
  // 化合物半导体
  AXTI: { theme: "化合物半导体(InP)", related: [], keywords: ["inp", "substrate", "photonics", "compound semiconductor"] },
  IQE: { theme: "化合物半导体(外延片)", related: [], keywords: ["epiwafer", "compound semiconductor"] },
  // 台积电生态
  TSM: { theme: "台积电/先进封装", related: ["hongkong"], keywords: ["tsmc", "packaging", "advanced packaging"] },
  // AI基础设施
  IREN: { theme: "AI云/算力", related: ["nasdaq"], keywords: ["neocloud", "ai infrastructure", "gpu cloud"] },
  NBIS: { theme: "AI云/算力", related: ["nasdaq"], keywords: ["neocloud", "ai infrastructure"] },
  MRVL: { theme: "AI芯片/网络", related: ["nasdaq"], keywords: ["marvell", "ai", "networking", "custom chip"] },
  // 汽车/自动驾驶
  TSLA: { theme: "电动车/自动驾驶", related: ["nasdaq"], keywords: ["ev", "autonomous", "self-driving"] },
  // 其他
  PL: { theme: "卫星/太空", related: [], keywords: ["satellite", "space"] },
  RDDT: { theme: "社交媒体", related: [], keywords: ["social media"] },
  SNAP: { theme: "社交媒体", related: [], keywords: ["social media"] },
  SOI: { theme: "CPO光子学", related: [], keywords: ["photonics", "silicon"] }
};

/**
 * 从大神推文分析新投资方向，发现基金池缺口
 */
function analyzeNewDirections(tickerOpinions, existingFunds) {
  if (!tickerOpinions || tickerOpinions.length === 0) {
    return { newThemes: [], gapSummary: "" };
  }

  // 1. 统计大神提到的投资主题
  const themeStats = {};
  for (let i = 0; i < tickerOpinions.length; i++) {
    const tko = tickerOpinions[i];
    const mapping = TICKER_THEME_MAP[tko.ticker];
    if (!mapping) continue;
    const theme = mapping.theme;
    if (!themeStats[theme]) {
      themeStats[theme] = { theme: theme, tickers: [], totalMentions: 0, sentiment: 0, keywords: mapping.keywords };
    }
    themeStats[theme].tickers.push("$" + tko.ticker);
    themeStats[theme].totalMentions += tko.mentions;
    themeStats[theme].sentiment += (tko.sentiment === "bullish" ? 1 : (tko.sentiment === "bearish" ? -1 : 0));
  }

  // 2. 检查现有基金池覆盖情况
  const fundTypes = (existingFunds || []).map(function(f) {
    return ((f.type || "") + " " + (f.name || "") + " " + (f.note || "")).toLowerCase();
  }).join(" ");

  // 纳指100覆盖了大部分AI/半导体股票
  const hasNasdaq = fundTypes.indexOf("纳指") >= 0 || fundTypes.indexOf("nasdaq") >= 0;
  const hasSp500 = fundTypes.indexOf("标普") >= 0 || fundTypes.indexOf("sp500") >= 0;
  const hasHk = fundTypes.indexOf("港") >= 0 || fundTypes.indexOf("恒生") >= 0;
  const _hasGlobal = fundTypes.indexOf("全球") >= 0;
  const hasAsia = fundTypes.indexOf("亚太") >= 0;

  const newThemes = [];
  const themeKeys = Object.keys(themeStats);
  for (let j = 0; j < themeKeys.length; j++) {
    const stat = themeStats[themeKeys[j]];
    // 检查关键词是否在现有基金池中出现
    let covered = false;
    for (let k = 0; k < stat.keywords.length; k++) {
      if (fundTypes.indexOf(stat.keywords[k].toLowerCase()) >= 0) {
        covered = true;
        break;
      }
    }
    // 通过关联主题判断覆盖（纳指100覆盖AI/半导体，标普覆盖美股）
    if (!covered) {
      const mapping = TICKER_THEME_MAP[stat.tickers[0].replace("$", "")];
      if (mapping && mapping.related) {
        for (let r = 0; r < mapping.related.length; r++) {
          const rel = mapping.related[r];
          if (rel === "nasdaq" && hasNasdaq) { covered = true; break; }
          if (rel === "sp500" && hasSp500) { covered = true; break; }
          if (rel === "hongkong" && (hasHk || hasAsia)) { covered = true; break; }
        }
      }
    }
    const avgSentiment = stat.sentiment > 0 ? "bullish" : (stat.sentiment < 0 ? "bearish" : "neutral");
    newThemes.push({
      theme: stat.theme,
      tickers: [...new Set(stat.tickers)],
      totalMentions: stat.totalMentions,
      sentiment: avgSentiment,
      covered: covered
    });
  }

  // 排序：未覆盖 + 看好 + 提及多的排前面
  newThemes.sort(function(a, b) {
    if (a.covered !== b.covered) return a.covered ? 1 : -1;
    if (a.sentiment !== b.sentiment) {
      const sOrder = { bullish: 0, neutral: 1, bearish: 2 };
      return (sOrder[a.sentiment] || 1) - (sOrder[b.sentiment] || 1);
    }
    return b.totalMentions - a.totalMentions;
  });

  // 3. 生成缺口摘要
  const gaps = newThemes.filter(function(t) { return !t.covered && t.sentiment === "bullish"; });
  let gapSummary = "";
  if (gaps.length > 0) {
    gapSummary = gaps.map(function(g) {
      return g.theme + "(" + g.tickers.join(", ") + " ×" + g.totalMentions + ")";
    }).join("、");
  }

  return { newThemes: newThemes, gapSummary: gapSummary };
}

const POSITIVE_WORDS = ["bull", "bullish", "rally", "breakout", "upside", "strong", "beat", "growth", "long", "buy", "positive", "risk-on"];
const NEGATIVE_WORDS = ["bear", "bearish", "selloff", "downside", "weak", "miss", "risk", "crash", "short", "recession", "negative", "risk-off"];

// [修复] 原问题：代理地址硬编码，无法通过环境变量配置
const PROXY_HOST = process.env.PROXY_HOST || "127.0.0.1";
const PROXY_PORT = parseInt(process.env.PROXY_PORT || "7890");

/**
 * 通过HTTP代理发起HTTPS请求（CONNECT隧道方式）
 */
function httpGetViaProxy(url, timeoutMs) {
  if (!timeoutMs) timeoutMs = 15000;
  return new Promise(function(resolve, reject) {
    const parsed = new URL(url);
    const targetHost = parsed.hostname;
    const targetPort = parseInt(parsed.port) || 443;

    // 先建立到代理的TCP连接
    const proxySocket = net.connect(PROXY_PORT, PROXY_HOST, function() {
      // 发送CONNECT请求建立隧道
      const connectReq = "CONNECT " + targetHost + ":" + targetPort + " HTTP/1.1\r\n" +
                       "Host: " + targetHost + ":" + targetPort + "\r\n\r\n";
      proxySocket.write(connectReq);
    });

    let connectResponse = "";
    let tunnelEstablished = false;
    let responseBuffer = "";

    proxySocket.on("data", function(chunk) {
      if (!tunnelEstablished) {
        connectResponse += chunk.toString("utf8");
        if (connectResponse.indexOf("\r\n\r\n") >= 0) {
          const statusLine = connectResponse.split("\r\n")[0];
          if (statusLine.indexOf("200") >= 0) {
            tunnelEstablished = true;
            // 隧道建立，升级到TLS
            const tlsSocket = tls.connect({
              socket: proxySocket,
              servername: targetHost
            }, function() {
              // 发送HTTP请求
              const path = parsed.pathname + (parsed.search || "");
              const httpReq = "GET " + path + " HTTP/1.1\r\n" +
                            "Host: " + targetHost + "\r\n" +
                            "User-Agent: Mozilla/5.0 QDII-Allocator/1.0\r\n" +
                            "Accept: application/rss+xml, application/xml, text/xml, text/html\r\n" +
                            "Connection: close\r\n\r\n";
              tlsSocket.write(httpReq);
            });

            tlsSocket.on("data", function(data) {
              responseBuffer += data.toString("utf8");
            });
            tlsSocket.on("end", function() {
              // 解析HTTP响应
              const headerEnd = responseBuffer.indexOf("\r\n\r\n");
              if (headerEnd >= 0) {
                const headerPart = responseBuffer.substring(0, headerEnd);
                let body = responseBuffer.substring(headerEnd + 4);
                const statusMatch = headerPart.match(/^HTTP\/\d\.\d\s+(\d+)/);
                // 处理chunked transfer encoding
                if (headerPart.toLowerCase().indexOf("transfer-encoding: chunked") >= 0) {
                  body = decodeChunkedBody(body);
                }
                if (statusMatch && parseInt(statusMatch[1]) >= 400) {
                  reject(new Error("HTTP " + statusMatch[1] + " via proxy"));
                } else {
                  resolve(body);
                }
              } else {
                reject(new Error("Invalid HTTP response via proxy"));
              }
            });
            tlsSocket.on("error", function(err) {
              reject(new Error("TLS error: " + err.message));
            });
            tlsSocket.setTimeout(timeoutMs, function() {
              tlsSocket.destroy();
              reject(new Error("TLS timeout (" + timeoutMs + "ms)"));
            });
          } else {
            proxySocket.destroy();
            reject(new Error("Proxy CONNECT failed: " + statusLine));
          }
        }
      }
    });

    proxySocket.on("error", function(err) {
      reject(new Error("Proxy connection error: " + err.message));
    });
    proxySocket.on("timeout", function() {
      proxySocket.destroy();
      reject(new Error("Proxy timeout (" + timeoutMs + "ms)"));
    });
    proxySocket.setTimeout(timeoutMs);
  });
}

/**
 * 直接HTTP请求（不走代理）
 */
function httpGetDirect(url, timeoutMs) {
  if (!timeoutMs) timeoutMs = 15000;
  return new Promise(function(resolve, reject) {
    const parsed = new URL(url);
    const lib = parsed.protocol === "https:" ? https : http;
    const req = lib.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 QDII-Allocator/1.0",
        "Accept": "application/rss+xml, application/xml, text/xml, " + "text/html"
      },
      timeout: timeoutMs
    }, function(res) {
      const chunks = [];
      res.on("data", function(chunk) { chunks.push(chunk); });
      res.on("end", function() {
        const body = Buffer.concat(chunks).toString("utf8");
        if (res.statusCode >= 400) {
          reject(new Error("HTTP " + res.statusCode));
          return;
        }
        resolve(body);
      });
    });
    req.on("error", reject);
    req.on("timeout", function() {
      req.destroy();
      reject(new Error("HTTP timeout (" + timeoutMs + "ms)"));
    });
  });
}

/**
 * 带代理回退的HTTP GET
 * 先尝试直连，失败后走代理
 */
function decodeChunkedBody(chunked) {
  let result = "";
  let pos = 0;
  while (pos < chunked.length) {
    const lineEnd = chunked.indexOf("\r\n", pos);
    if (lineEnd < 0) break;
    const sizeStr = chunked.substring(pos, lineEnd).trim();
    const size = parseInt(sizeStr, 16);
    if (isNaN(size) || size === 0) break;
    pos = lineEnd + 2;
    result += chunked.substring(pos, pos + size);
    pos += size + 2; // skip chunk data + trailing \r\n
  }
  return result;
}

function isProxyAvailable() {
  if (process.env.EXTERNAL_PROXY_DISABLED) return false;
  if (process.env.HTTP_PROXY || process.env.HTTPS_PROXY || process.env.ALL_PROXY) return true;
  if (process.env.CI || process.env.GITHUB_ACTIONS) return false;
  return process.env.EXTERNAL_PROXY_AUTO ? true : false;
}

function httpGet(url, timeoutMs) {
  if (!isProxyAvailable()) {
    return httpGetDirect(url, timeoutMs);
  }
  return httpGetDirect(url, timeoutMs).catch(function(directErr) {
    // 直连失败，尝试代理
    return httpGetViaProxy(url, timeoutMs).catch(function(_proxyErr) {
      // 代理也失败，抛出原始错误
      throw directErr;
    });
  });
}

function extractHandle(sourceUrl) {
  try {
    const url = new URL(sourceUrl || DEFAULT_X_URL);
    const parts = url.pathname.split("/").filter(Boolean);
    return parts[0] || "aleabitoreddit";
  } catch (err) {
    return "aleabitoreddit";
  }
}

function toArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function buildMirrorUrls(config) {
  const handle = extractHandle(config && config.sourceUrl ? config.sourceUrl : undefined);
  const whitelist = toArray(config && config.xMirrorWhitelist ? config.xMirrorWhitelist : []);
  const mirrors = whitelist.length > 0 ? whitelist : DEFAULT_MIRRORS;
  const urls = mirrors.map(function(item) {
    const tpl = typeof item === "string" ? item : (item && item.url ? item.url : "");
    return tpl.replace(/\{handle\}/g, encodeURIComponent(handle));
  });
  // 自建 RSSHub 实例优先（放在最前面）
  const selfHosted = config && config.rsshubUrl ? config.rsshubUrl : "";
  if (selfHosted) {
    const base = selfHosted.replace(/\/+$/, "");
    const selfUrl = base + "/twitter/user/" + encodeURIComponent(handle);
    urls.unshift(selfUrl);
  }
  return unique(urls.filter(Boolean));
}

function decodeXml(text) {
  return String(text || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function stripHtml(text) {
  return decodeXml(text)
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function firstTag(block, tag) {
  const re = new RegExp("<" + tag + "[^>]*>([\\s\\S]*?)<\\/" + tag + ">", "i");
  const match = block.match(re);
  return match ? stripHtml(match[1]) : "";
}

function parseRssItems(xml, limit) {
  if (!limit) limit = 12;
  const items = [];
  const itemRe = /<item[\s\S]*?<\/item>/gi;
  let match;
  while ((match = itemRe.exec(xml)) && items.length < limit) {
    const block = match[0];
    const title = firstTag(block, "title");
    const description = firstTag(block, "description");
    const pubDate = firstTag(block, "pubDate");
    const link = firstTag(block, "link");
    const text = (description || title || "").trim();
    if (text) {
      items.push({ title: title, text: text, time: pubDate, link: link, source: "x-rsshub" });
    }
  }
  return items;
}

function scoreText(text) {
  const lower = String(text || "").toLowerCase();
  let score = 0;
  for (let i = 0; i < POSITIVE_WORDS.length; i++) {
    if (lower.indexOf(POSITIVE_WORDS[i]) >= 0) score++;
  }
  for (let j = 0; j < NEGATIVE_WORDS.length; j++) {
    if (lower.indexOf(NEGATIVE_WORDS[j]) >= 0) score--;
  }
  if (score > 2) return 1;
  if (score < -2) return -1;
  return score === 0 ? 0 : score / Math.abs(score);
}

function buildThemeScores(items, maxScore) {
  if (!maxScore) maxScore = 3;
  const themes = {};
  Object.keys(THEME_KEYWORDS).forEach(function(theme) {
    themes[theme] = { score: 0, matches: [] };
  });

  for (let i = 0; i < items.length; i++) {
    const text = (items[i].title + " " + items[i].text).toLowerCase();
    let sentiment = scoreText(text);
    if (sentiment === 0) sentiment = 0.5;
    Object.keys(THEME_KEYWORDS).forEach(function(theme) {
      const matched = THEME_KEYWORDS[theme].filter(function(keyword) {
        return text.indexOf(keyword) >= 0;
      });
      if (matched.length > 0) {
        themes[theme].score += sentiment * Math.min(1, matched.length / 2);
        themes[theme].matches = themes[theme].matches.concat(matched);
      }
    });
  }

  Object.keys(themes).forEach(function(theme) {
    const raw = themes[theme].score;
    themes[theme].score = clamp(Math.round(raw * 100) / 100, -maxScore, maxScore);
    themes[theme].matches = unique(themes[theme].matches).slice(0, 6);
  });
  return themes;
}

/**
 * 从推文中提取 $TICKER 股票代码及其观点
 */
function extractTickerOpinions(items) {
  const tickerMap = {};
  for (let i = 0; i < items.length; i++) {
    const text = items[i].title + " " + (items[i].text || "");
    // 提取 $TICKER 格式的股票代码
    const tickerRe = /\$([A-Z]{2,6})/g;
    let m;
    while ((m = tickerRe.exec(text)) !== null) {
      const ticker = m[1];
      if (!tickerMap[ticker]) {
        tickerMap[ticker] = { ticker: ticker, mentions: 0, snippets: [], sentiment: 0 };
      }
      tickerMap[ticker].mentions++;
      // 提取该 ticker 附近的上下文（最多150字）
      const pos = m.index;
      const snippet = text.substring(Math.max(0, pos - 40), Math.min(text.length, pos + 120))
        .replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      if (snippet.length > 10 && tickerMap[ticker].snippets.length < 2) {
        tickerMap[ticker].snippets.push(snippet);
      }
      // 该条推文对该 ticker 的情绪
      const itemSentiment = scoreText(text);
      tickerMap[ticker].sentiment += itemSentiment;
    }
  }
  // 排序：提及次数多的在前
  const result = Object.values(tickerMap).map(function(t) {
    t.sentiment = t.sentiment > 0 ? "bullish" : (t.sentiment < 0 ? "bearish" : "neutral");
    return t;
  });
  result.sort(function(a, b) { return b.mentions - a.mentions; });
  return result;
}

/**
 * 从推文中提取关键观点摘要（去HTML，截取核心内容）
 */
function extractOpinionSummaries(items, limit) {
  if (!limit) limit = 5;
  const summaries = [];
  for (let i = 0; i < Math.min(items.length, limit); i++) {
    const item = items[i];
    let text = (item.text || item.title || "")
      .replace(/<[^>]+>/g, " ")
      .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;/g, "'")
      .replace(/\s+/g, " ").trim();
    if (text.length > 200) text = text.substring(0, 200) + "...";
    if (text.length > 10) {
      summaries.push({
        time: item.time || "",
        text: text,
        tickers: (text.match(/\$[A-Z]{2,6}/g) || []).join(", ")
      });
    }
  }
  return summaries;
}

async function fetchExternalSignals(config) {
  config = config || {};
  const sourceUrl = config.sourceUrl || DEFAULT_X_URL;
  const maxScore = config.maxScore || 3;
  const requestedAttempts = Number(config.maxAttempts) || 2;
  const rssUrls = buildMirrorUrls(config).slice(0, Math.min(2, Math.max(1, requestedAttempts)));
  let lastErr = null;
  const attempts = [];
  const cacheFile = config.cacheFile || null;

  for (let i = 0; i < rssUrls.length; i++) {
    attempts.push({ url: rssUrls[i], status: "pending" });
    try {
      if (i > 0) await new Promise(function(resolve) { setTimeout(resolve, 1000); });
      console.log("[X] trying mirror " + (i + 1) + "/" + rssUrls.length + ": " + rssUrls[i].substring(0, 60) + "...");
      const xml = await httpGet(rssUrls[i], Number(config.timeoutMs) || 15000);
      const items = parseRssItems(xml, config.limit || 12);
      if (items.length === 0) {
        const snippet = xml ? xml.substring(0, 200).replace(/\n/g, " ") : "(empty)";
        console.warn("[X] mirror " + (i + 1) + " returned 0 items, response: " + snippet);
        attempts[attempts.length - 1].status = "empty";
        attempts[attempts.length - 1].error = "RSS contained no items";
        throw new Error("RSS contained no items");
      }
      console.log("[X] success with mirror " + (i + 1) + ", got " + items.length + " items");
      attempts[attempts.length - 1].status = "ok";
      const tickerOpinions = extractTickerOpinions(items);
      const opinionSummaries = extractOpinionSummaries(items, 5);
      console.log("[X] detected " + tickerOpinions.length + " tickers: " + tickerOpinions.slice(0, 8).map(function(t) { return "$" + t.ticker + "(" + t.mentions + ")"; }).join(", "));
      const result = {
        sourceUrl: sourceUrl,
        fetchUrl: rssUrls[i],
        status: "ok",
        fetchedAt: new Date().toISOString(),
        items: items,
        themeScores: buildThemeScores(items, maxScore),
        tickerOpinions: tickerOpinions,
        opinionSummaries: opinionSummaries,
        attempts: attempts
      };
      // 缓存成功的信号供回退使用
      if (cacheFile) {
        try {
          const fs = require("fs");
          fs.writeFileSync(cacheFile, JSON.stringify({ data: result, cachedAt: Date.now() }, null, 1), "utf8");
        } catch(ce) {
          console.warn("[X] 写入信号缓存失败:", ce.message);
        }
      }
      return result;
    } catch (err) {
      lastErr = err;
      console.warn("[X] mirror " + (i + 1) + " failed: " + err.message);
      const lastAttempt = attempts[attempts.length - 1];
      if (!lastAttempt || lastAttempt.url !== rssUrls[i]) {
        attempts.push({ url: rssUrls[i], status: "failed", error: err.message });
      } else if (lastAttempt.status !== "empty") {
        lastAttempt.status = "failed";
        lastAttempt.error = err.message;
      }
    }
  }

  // 回退到缓存的外部信号
  if (cacheFile) {
    try {
      const fs2 = require("fs");
      if (fs2.existsSync(cacheFile)) {
        const cached = JSON.parse(fs2.readFileSync(cacheFile, "utf8"));
        if (cached && cached.data && cached.data.items && cached.data.items.length > 0) {
          const age = Date.now() - (cached.cachedAt || 0);
          const ageHours = Math.round(age / 3600000);
          const STALE_HOURS = 12;
          const isStale = ageHours > STALE_HOURS;
          if (isStale) {
            console.warn("[X] cached signals are STALE (" + ageHours + "h old, limit " + STALE_HOURS + "h), will retry next run");
          } else {
            console.warn("[X] using cached external signals (" + ageHours + "h old, " + cached.data.items.length + " items)");
          }
          attempts.push({ url: "cache:" + cacheFile, status: isStale ? "stale" : "cached", ageHours: ageHours });
          cached.data.attempts = attempts;
          cached.data.status = isStale ? "stale" : "cached";
          return cached.data;
        }
      }
    } catch(ce2) {
      console.warn("[X] cache fallback failed: " + ce2.message);
    }
  }

  return {
    sourceUrl: sourceUrl,
    status: "unavailable",
    error: "X source unavailable: " + (lastErr ? lastErr.message : "unknown error"),
    fetchedAt: new Date().toISOString(),
    items: [],
    themeScores: buildThemeScores([], maxScore),
    attempts: attempts
  };
}

function inferFundThemes(fund) {
  const text = ((fund.type || "") + " " + (fund.name || "") + " " + (fund.note || "")).toLowerCase();
  const themes = [];
  if (hasAny(text, ["nasdaq", "绾虫", "纳斯", "ndx"])) themes.push("nasdaq");
  if (hasAny(text, ["s&p", "sp500", "sp 500", "鏍囨櫘", "标普"])) themes.push("sp500");
  if (hasAny(text, ["biotech", "health", "鐢熺墿", "鍖荤", "医疗", "生物"])) themes.push("biotech");
  if (hasAny(text, ["reit", "real estate", "鎴垮湴", "不动产", "房地产"])) themes.push("reit");
  if (hasAny(text, ["hong", "hang seng", "hsi", "娓", "棣欐腐", "恒生", "香港", "asia", "浜氭", "亚洲", "亚太"])) themes.push("hongkong");
  if (hasAny(text, ["oil", "energy", "鐭虫补", "石油", "能源"])) themes.push("oil");
  if (hasAny(text, ["commodity", "澶у畻", "商品", "资源", "璧勬簮"])) themes.push("commodities");
  if (hasAny(text, ["bond", "鍊", "债"])) themes.push("bonds");
  if (hasAny(text, ["tech", "绉戞妧", "科技", "智能", "ai"])) themes.push("globalTech");
  return unique(themes);
}

function scoreFundExternalSignal(fund, externalSignals, maxScore) {
  if (!externalSignals || (externalSignals.status !== "ok" && externalSignals.status !== "cached") || !externalSignals.themeScores) {
    return { score: 0, themes: [], matches: [] };
  }
  if (!maxScore) maxScore = 3;
  const themes = inferFundThemes(fund);
  let score = 0;
  let matches = [];
  for (let i = 0; i < themes.length; i++) {
    const theme = externalSignals.themeScores[themes[i]];
    if (theme) {
      score += theme.score;
      matches = matches.concat(theme.matches || []);
    }
  }
  return {
    score: clamp(Math.round(score * 100) / 100, -maxScore, maxScore),
    themes: themes,
    matches: unique(matches).slice(0, 6)
  };
}

function hasAny(text, needles) {
  for (let i = 0; i < needles.length; i++) {
    if (text.indexOf(needles[i].toLowerCase()) >= 0) return true;
  }
  return false;
}

function unique(items) {
  const seen = {};
  const result = [];
  for (let i = 0; i < items.length; i++) {
    const key = items[i];
    if (!seen[key]) {
      seen[key] = true;
      result.push(key);
    }
  }
  return result;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

module.exports = {
  fetchExternalSignals: fetchExternalSignals,
  scoreFundExternalSignal: scoreFundExternalSignal,
  inferFundThemes: inferFundThemes,
  buildThemeScores: buildThemeScores,
  extractTickerOpinions: extractTickerOpinions,
  extractOpinionSummaries: extractOpinionSummaries,
  analyzeNewDirections: analyzeNewDirections
};
