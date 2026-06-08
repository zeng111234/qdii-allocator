const https = require("https");
const http = require("http");
const net = require("net");
const tls = require("tls");
const { URL } = require("url");

const DEFAULT_X_URL = "https://x.com/aleabitoreddit";
const DEFAULT_MIRRORS = [
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

const POSITIVE_WORDS = ["bull", "bullish", "rally", "breakout", "upside", "strong", "beat", "growth", "long", "buy", "positive", "risk-on"];
const NEGATIVE_WORDS = ["bear", "bearish", "selloff", "downside", "weak", "miss", "risk", "crash", "short", "recession", "negative", "risk-off"];

const PROXY_HOST = "127.0.0.1";
const PROXY_PORT = 7890;

/**
 * 通过HTTP代理发起HTTPS请求（CONNECT隧道方式）
 */
function httpGetViaProxy(url, timeoutMs) {
  if (!timeoutMs) timeoutMs = 15000;
  return new Promise(function(resolve, reject) {
    var parsed = new URL(url);
    var targetHost = parsed.hostname;
    var targetPort = parseInt(parsed.port) || 443;

    // 先建立到代理的TCP连接
    var proxySocket = net.connect(PROXY_PORT, PROXY_HOST, function() {
      // 发送CONNECT请求建立隧道
      var connectReq = "CONNECT " + targetHost + ":" + targetPort + " HTTP/1.1\r\n" +
                       "Host: " + targetHost + ":" + targetPort + "\r\n\r\n";
      proxySocket.write(connectReq);
    });

    var connectResponse = "";
    var tunnelEstablished = false;
    var responseBuffer = "";

    proxySocket.on("data", function(chunk) {
      if (!tunnelEstablished) {
        connectResponse += chunk.toString("utf8");
        if (connectResponse.indexOf("\r\n\r\n") >= 0) {
          var statusLine = connectResponse.split("\r\n")[0];
          if (statusLine.indexOf("200") >= 0) {
            tunnelEstablished = true;
            // 隧道建立，升级到TLS
            var tlsSocket = tls.connect({
              socket: proxySocket,
              servername: targetHost
            }, function() {
              // 发送HTTP请求
              var path = parsed.pathname + (parsed.search || "");
              var httpReq = "GET " + path + " HTTP/1.1\r\n" +
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
              var headerEnd = responseBuffer.indexOf("\r\n\r\n");
              if (headerEnd >= 0) {
                var headerPart = responseBuffer.substring(0, headerEnd);
                var body = responseBuffer.substring(headerEnd + 4);
                var statusMatch = headerPart.match(/^HTTP\/\d\.\d\s+(\d+)/);
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
    var parsed = new URL(url);
    var lib = parsed.protocol === "https:" ? https : http;
    var req = lib.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 QDII-Allocator/1.0",
        "Accept": "application/rss+xml, application/xml, text/xml, " + "text/html"
      },
      timeout: timeoutMs
    }, function(res) {
      var chunks = [];
      res.on("data", function(chunk) { chunks.push(chunk); });
      res.on("end", function() {
        var body = Buffer.concat(chunks).toString("utf8");
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
  var result = "";
  var pos = 0;
  while (pos < chunked.length) {
    var lineEnd = chunked.indexOf("\r\n", pos);
    if (lineEnd < 0) break;
    var sizeStr = chunked.substring(pos, lineEnd).trim();
    var size = parseInt(sizeStr, 16);
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
    return httpGetViaProxy(url, timeoutMs).catch(function(proxyErr) {
      // 代理也失败，抛出原始错误
      throw directErr;
    });
  });
}

function extractHandle(sourceUrl) {
  try {
    var url = new URL(sourceUrl || DEFAULT_X_URL);
    var parts = url.pathname.split("/").filter(Boolean);
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
  var handle = extractHandle(config && config.sourceUrl ? config.sourceUrl : undefined);
  var whitelist = toArray(config && config.xMirrorWhitelist ? config.xMirrorWhitelist : []);
  var mirrors = whitelist.length > 0 ? whitelist : DEFAULT_MIRRORS;
  return mirrors.map(function(item) {
    var tpl = typeof item === "string" ? item : (item && item.url ? item.url : "");
    return tpl.replace(/\{handle\}/g, encodeURIComponent(handle));
  });
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
  var re = new RegExp("<" + tag + "[^>]*>([\\s\\S]*?)<\\/" + tag + ">", "i");
  var match = block.match(re);
  return match ? stripHtml(match[1]) : "";
}

function parseRssItems(xml, limit) {
  if (!limit) limit = 12;
  var items = [];
  var itemRe = /<item[\s\S]*?<\/item>/gi;
  var match;
  while ((match = itemRe.exec(xml)) && items.length < limit) {
    var block = match[0];
    var title = firstTag(block, "title");
    var description = firstTag(block, "description");
    var pubDate = firstTag(block, "pubDate");
    var link = firstTag(block, "link");
    var text = (description || title || "").trim();
    if (text) {
      items.push({ title: title, text: text, time: pubDate, link: link, source: "x-rsshub" });
    }
  }
  return items;
}

function scoreText(text) {
  var lower = String(text || "").toLowerCase();
  var score = 0;
  for (var i = 0; i < POSITIVE_WORDS.length; i++) {
    if (lower.indexOf(POSITIVE_WORDS[i]) >= 0) score++;
  }
  for (var j = 0; j < NEGATIVE_WORDS.length; j++) {
    if (lower.indexOf(NEGATIVE_WORDS[j]) >= 0) score--;
  }
  if (score > 2) return 1;
  if (score < -2) return -1;
  return score === 0 ? 0 : score / Math.abs(score);
}

function buildThemeScores(items, maxScore) {
  if (!maxScore) maxScore = 3;
  var themes = {};
  Object.keys(THEME_KEYWORDS).forEach(function(theme) {
    themes[theme] = { score: 0, matches: [] };
  });

  for (var i = 0; i < items.length; i++) {
    var text = (items[i].title + " " + items[i].text).toLowerCase();
    var sentiment = scoreText(text);
    if (sentiment === 0) sentiment = 0.5;
    Object.keys(THEME_KEYWORDS).forEach(function(theme) {
      var matched = THEME_KEYWORDS[theme].filter(function(keyword) {
        return text.indexOf(keyword) >= 0;
      });
      if (matched.length > 0) {
        themes[theme].score += sentiment * Math.min(1, matched.length / 2);
        themes[theme].matches = themes[theme].matches.concat(matched);
      }
    });
  }

  Object.keys(themes).forEach(function(theme) {
    var raw = themes[theme].score;
    themes[theme].score = clamp(Math.round(raw * 100) / 100, -maxScore, maxScore);
    themes[theme].matches = unique(themes[theme].matches).slice(0, 6);
  });
  return themes;
}

async function fetchExternalSignals(config) {
  config = config || {};
  var sourceUrl = config.sourceUrl || DEFAULT_X_URL;
  var maxScore = config.maxScore || 3;
  var rssUrls = buildMirrorUrls(config);
  var lastErr = null;
  var attempts = [];
  var cacheFile = config.cacheFile || null;

  for (var i = 0; i < rssUrls.length; i++) {
    attempts.push({ url: rssUrls[i], status: "pending" });
    try {
      if (i > 0) await new Promise(function(resolve) { setTimeout(resolve, 2000); });
      console.log("[X] trying mirror " + (i + 1) + "/" + rssUrls.length + ": " + rssUrls[i].substring(0, 60) + "...");
      var xml = await httpGet(rssUrls[i], 20000);
      var items = parseRssItems(xml, config.limit || 12);
      if (items.length === 0) {
        var snippet = xml ? xml.substring(0, 200).replace(/\n/g, " ") : "(empty)";
        console.warn("[X] mirror " + (i + 1) + " returned 0 items, response: " + snippet);
        attempts[attempts.length - 1].status = "empty";
        attempts[attempts.length - 1].error = "RSS contained no items";
        throw new Error("RSS contained no items");
      }
      console.log("[X] success with mirror " + (i + 1) + ", got " + items.length + " items");
      attempts[attempts.length - 1].status = "ok";
      var result = {
        sourceUrl: sourceUrl,
        fetchUrl: rssUrls[i],
        status: "ok",
        fetchedAt: new Date().toISOString(),
        items: items,
        themeScores: buildThemeScores(items, maxScore),
        attempts: attempts
      };
      // 缓存成功的信号供回退使用
      if (cacheFile) {
        try {
          var fs = require("fs");
          fs.writeFileSync(cacheFile, JSON.stringify({ data: result, cachedAt: Date.now() }, null, 1), "utf8");
        } catch(ce) {}
      }
      return result;
    } catch (err) {
      lastErr = err;
      console.warn("[X] mirror " + (i + 1) + " failed: " + err.message);
      var lastAttempt = attempts[attempts.length - 1];
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
      var fs2 = require("fs");
      if (fs2.existsSync(cacheFile)) {
        var cached = JSON.parse(fs2.readFileSync(cacheFile, "utf8"));
        if (cached && cached.data && cached.data.items && cached.data.items.length > 0) {
          var age = Date.now() - (cached.cachedAt || 0);
          var ageHours = Math.round(age / 3600000);
          console.warn("[X] using cached external signals (" + ageHours + "h old, " + cached.data.items.length + " items)");
          attempts.push({ url: "cache:" + cacheFile, status: "cached", ageHours: ageHours });
          cached.data.attempts = attempts;
          cached.data.status = "cached";
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
  var text = ((fund.type || "") + " " + (fund.name || "") + " " + (fund.note || "")).toLowerCase();
  var themes = [];
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
  var themes = inferFundThemes(fund);
  var score = 0;
  var matches = [];
  for (var i = 0; i < themes.length; i++) {
    var theme = externalSignals.themeScores[themes[i]];
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
  for (var i = 0; i < needles.length; i++) {
    if (text.indexOf(needles[i].toLowerCase()) >= 0) return true;
  }
  return false;
}

function unique(items) {
  var seen = {};
  var result = [];
  for (var i = 0; i < items.length; i++) {
    var key = items[i];
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
  buildThemeScores: buildThemeScores
};
