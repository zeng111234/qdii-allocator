const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");

var NAV_CACHE_FILE = path.join(__dirname, "..", "data", "nav-cache.json");

function loadNavCache() {
  try {
    if (fs.existsSync(NAV_CACHE_FILE)) {
      return JSON.parse(fs.readFileSync(NAV_CACHE_FILE, "utf-8"));
    }
  } catch(e) {}
  return {};
}

function saveNavCache(cache) {
  try {
    fs.writeFileSync(NAV_CACHE_FILE, JSON.stringify(cache, null, 1), "utf-8");
  } catch(e) {
    console.error("[cache] save error:", e.message);
  }
}

function httpGet(url, timeoutMs) {
  if (!timeoutMs) timeoutMs = 15000;
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const lib = parsedUrl.protocol === "https:" ? https : http;
    var req = lib.get(url, { headers: { "User-Agent": "Mozilla/5.0", "Referer": "https://fund.eastmoney.com/" }, timeout: timeoutMs }, res => {
      let data = "";
      res.on("data", chunk => (data += chunk));
      res.on("end", () => resolve(data));
    });
    req.on("error", reject);
    req.on("timeout", function() { req.destroy(); reject(new Error("HTTP timeout (" + timeoutMs + "ms)")); });
  });
}

/**
 * 获取基金历史净值，支持3年长周期
 * 使用pageSize=500减少API调用次数
 */
async function getFundNavHistory(fundCode, days) {
  if (!days) days = 750; // 默认3年
  var pageSize = 20; // API硬限制最大20条/页

  // 使用缓存：先读缓存，只请求缺失的新数据
  var cache = loadNavCache();
  var cached = cache[fundCode] || [];
  var cachedDates = {};
  for (var c = 0; c < cached.length; c++) {
    cachedDates[cached[c].date] = true;
  }

  // 计算需要请求多少页：如果缓存有数据，只请求前几页获取最新数据
  var pagesToFetch;
  var allFromCache = cached.length > 0;

  if (allFromCache) {
    // 增量更新：只请求最近2页（40条）新数据
    pagesToFetch = 2;
  } else {
    // 首次运行：请求全部
    pagesToFetch = Math.ceil(days / pageSize);
  }

  var newRecords = [];
  for (var page = 1; page <= pagesToFetch; page++) {
    var url = "https://api.fund.eastmoney.com/f10/lsjz?fundCode=" + fundCode + "&pageIndex=" + page + "&pageSize=" + pageSize;
    try {
      var raw = await httpGet(url, 30000);
      var json = JSON.parse(raw);
      if (!json.Data || !json.Data.LSJZList || json.Data.LSJZList.length === 0) break;
      var records = json.Data.LSJZList.map(function(item) {
        return { date: item.FSRQ, nav: parseFloat(item.DWJZ), accNav: parseFloat(item.LJJZ), changeRate: item.JZZZL ? parseFloat(item.JZZZL) : 0 };
      });
      newRecords = newRecords.concat(records);
      if (json.Data.LSJZList.length < pageSize) break;
      if (page < pagesToFetch) await new Promise(function(r) { setTimeout(r, 300); });
    } catch (err) {
      console.error("[data] fund " + fundCode + " page " + page + " error: " + err.message);
      break;
    }
  }

  // 合并缓存和新数据（按日期去重）
  var merged = {};
  for (var m = 0; m < cached.length; m++) {
    merged[cached[m].date] = cached[m];
  }
  for (var n = 0; n < newRecords.length; n++) {
    merged[newRecords[n].date] = newRecords[n];
  }

  // 转为数组，按日期排序
  var allRecords = Object.values(merged).sort(function(a, b) {
    return a.date < b.date ? -1 : (a.date > b.date ? 1 : 0);
  });

  // 保存更新后的缓存
  if (newRecords.length > 0) {
    cache[fundCode] = allRecords;
    saveNavCache(cache);
  }

  if (allRecords.length === 0) {
    console.warn("[data] fund " + fundCode + ": no data");
  }

  // 返回最近N天的数据
  return allRecords.slice(-days);
}

/**
 * 计算基金技术指标（含长期指标）
 * 支持3年数据的MA120、MA250、夏普比率、年化收益等
 */
function calcIndicators(navHistory) {
  if (!navHistory || navHistory.length < 5) { return { error: "insufficient data" }; }
  var navs = navHistory.map(function(d) { return d.nav; });
  var latest = navs[navs.length - 1];

  // --- 短期指标 ---
  var ma5 = navs.length >= 5 ? navs.slice(-5).reduce(function(a,b){return a+b},0) / 5 : latest;
  var ma10 = navs.length >= 10 ? navs.slice(-10).reduce(function(a,b){return a+b},0) / 10 : ma5;
  var ma20 = navs.length >= 20 ? navs.slice(-20).reduce(function(a,b){return a+b},0) / 20 : ma10;
  var maDeviation = ((latest - ma10) / ma10) * 100;
  var recent5Change = navs.length >= 5 ? ((latest - navs[navs.length-5]) / navs[navs.length-5]) * 100 : 0;
  var recent10Change = navs.length >= 10 ? ((latest - navs[navs.length-10]) / navs[navs.length-10]) * 100 : recent5Change;

  // 近期回撤（最近20日最高点）
  var recentHigh = Math.max.apply(null, navs.slice(-Math.min(20, navs.length)));
  var drawdown = ((latest - recentHigh) / recentHigh) * 100;

  // 收益率序列（用全部数据，用于波动率和夏普比率计算）
  var returns = [];
  for (var i = 1; i < navs.length; i++) {
    returns.push((navs[i] - navs[i-1]) / navs[i-1]);
  }
  // 波动率用近20日
  var volPeriod = Math.min(20, returns.length);
  var volReturns = returns.slice(-volPeriod);
  var avgReturn = volReturns.reduce(function(a,b){return a+b},0) / (volReturns.length || 1);
  var variance = volReturns.reduce(function(sum,r){return sum + Math.pow(r - avgReturn, 2)},0) / (volReturns.length || 1);
  var volatility = Math.sqrt(variance) * 100;

  // --- 长期指标 ---
  // 中期均线
  var ma60 = navs.length >= 60 ? navs.slice(-60).reduce(function(a,b){return a+b},0) / 60 : ma20;
  var ma120 = navs.length >= 120 ? navs.slice(-120).reduce(function(a,b){return a+b},0) / 120 : ma60;
  var ma250 = navs.length >= 250 ? navs.slice(-250).reduce(function(a,b){return a+b},0) / 250 : ma120;

  // 1年/3年收益率（从K线计算，备用）
  var yearReturn = null;
  var threeYearReturn = null;
  var annualizedReturn = null;

  if (navs.length >= 250) {
    // 1年收益：最近250天
    yearReturn = r2(((latest - navs[navs.length - 250]) / navs[navs.length - 250]) * 100);
  } else if (navs.length >= 200) {
    // 数据不足250天，用全部数据
    yearReturn = r2(((latest - navs[0]) / navs[0]) * 100);
  }

  if (navs.length >= 700) {
    // 3年收益：用全部数据
    threeYearReturn = r2(((latest - navs[0]) / navs[0]) * 100);
    var years = navs.length / 250;
    if (years > 0) {
      annualizedReturn = r2((Math.pow(latest / navs[0], 1 / years) - 1) * 100);
    }
  }

  // 3年最大回撤
  var maxDrawdown = 0;
  if (navs.length >= 60) {
    var peak = navs[0];
    for (var j = 1; j < navs.length; j++) {
      if (navs[j] > peak) peak = navs[j];
      var dd = (navs[j] - peak) / peak * 100;
      if (dd < maxDrawdown) maxDrawdown = dd;
    }
    maxDrawdown = r2(maxDrawdown);
  }

  // 夏普比率（年化，用全部数据计算更稳定）
  var sharpeRatio = null;
  if (returns.length >= 60) {
    var allAvg = returns.reduce(function(a,b){return a+b},0) / returns.length;
    var allVar = returns.reduce(function(sum,r){return sum + Math.pow(r - allAvg, 2)},0) / returns.length;
    var annualReturn = allAvg * 250;
    var annualVol = Math.sqrt(allVar) * Math.sqrt(250);
    if (annualVol > 0) {
      sharpeRatio = r2((annualReturn - 0.02) / annualVol);
    }
  }

  // 长期趋势判断
  var longTermTrend = "unknown";
  if (navs.length >= 250) {
    if (latest > ma120 && ma120 > ma250) longTermTrend = "bull";
    else if (latest < ma120 && ma120 < ma250) longTermTrend = "bear";
    else longTermTrend = "neutral";
  }

  // 近20日涨跌
  var recent20Change = navs.length >= 20 ? r2(((latest - navs[navs.length-20]) / navs[navs.length-20]) * 100) : null;

  function r2(n) { return Math.round(n*100)/100; }
  return {
    latest: r2(latest),
    ma5: r2(ma5), ma10: r2(ma10), ma20: r2(ma20),
    ma60: r2(ma60), ma120: r2(ma120), ma250: r2(ma250),
    maDeviation: r2(maDeviation),
    recent5Change: r2(recent5Change),
    recent10Change: r2(recent10Change),
    recent20Change: recent20Change,
    drawdown: r2(drawdown),
    volatility: r2(volatility),
    yearReturn: yearReturn,
    threeYearReturn: threeYearReturn,
    annualizedReturn: annualizedReturn,
    maxDrawdown: maxDrawdown,
    sharpeRatio: sharpeRatio,
    longTermTrend: longTermTrend,
    dataPoints: navs.length
  };
}

async function getFundBasicInfo(fundCode) {
  // 统一获取基金基本信息：限购状态 + 溢价率（一次API调用）
  var url = "https://fundmobapi.eastmoney.com/FundMApi/FundBasicInformation.ashx?FCODE=" + fundCode + "&deviceid=wap&version=5.8.0&product=EFund&plat=Wap";
  try {
    var raw = await httpGet(url, 30000);
    var json = JSON.parse(raw);
    var data = json.Datas || json;
    if (!data || !data.SGZT) return { status: "unknown", limit: 100, minPurchase: 10, premiumRate: 0 };

    // 限购状态
    var status = "active";
    var limit = 100;
    var minPurchase = 10;
    var sgzt = data.SGZT || "";
    var isBuy = data.ISBUY === "1" || data.BUY === true;
    if (data.MINSG) minPurchase = parseInt(data.MINSG) || 10;
    if (data.MAXSG && data.MAXSG !== "" && data.MAXSG !== "0") {
      limit = parseInt(data.MAXSG) || 100;
    }
    var suspended = sgzt.indexOf("\u6682\u505c") >= 0 || sgzt.indexOf("\u5c01\u95ed") >= 0;
    var limited = sgzt.indexOf("\u9650\u5927\u989d") >= 0 || sgzt.indexOf("\u9650\u5236") >= 0;
    var opened = sgzt.indexOf("\u5f00\u653e") >= 0;
    if (!isBuy || suspended) {
      status = "suspended";
    } else if (limited) {
      status = "limited";
    } else if (opened) {
      status = "active";
    }

    // 溢价率
    var premiumRate = 0;
    var nav = parseFloat(data.DWJZ) || 0;
    var realNav = parseFloat(data.GSZ) || 0;
    if (nav > 0 && realNav > 0) {
      premiumRate = Math.round(((realNav - nav) / nav) * 10000) / 100;
    }

    // 收益率（多周期）
    var yearReturn = parseFloat(data.SYL_1N) || 0;
    var threeYearReturn = parseFloat(data.SYL_3N) || null;

    return {
      status: status, limit: limit, minPurchase: minPurchase,
      rawStatus: sgzt, premiumRate: premiumRate,
      nav: nav, realNav: realNav,
      yearReturn: yearReturn, threeYearReturn: threeYearReturn
    };
  } catch (err) {
    console.error("[data] getFundBasicInfo error for " + fundCode + ":", err.message);
    return { status: "unknown", limit: 100, minPurchase: 10, premiumRate: 0, yearReturn: 0 };
  }
}

// 兼容旧接口
async function getFundPurchaseInfo(fundCode) {
  return getFundBasicInfo(fundCode);
}

async function getPremiumRate(fundCode) {
  var info = await getFundBasicInfo(fundCode);
  return { premiumRate: info.premiumRate, nav: info.nav, realNav: info.realNav };
}

/**
 * 获取实时市场快照（美股指数、A股、港股、VIX、汇率）
 */
async function getMarketSnapshot() {
  var indices = [
    { code: "100.NDX", name: "纳斯达克" },
    { code: "100.SPX", name: "标普500" },
    { code: "100.DJIA", name: "道琼斯" },
    { code: "1.000001", name: "上证指数" },
    { code: "100.HSI", name: "恒生指数" },
    { code: "100.VIXF", name: "VIX恐慌" },
    { code: "119.USDCNH", name: "美元/人民币" }
  ];
  var secids = indices.map(function(i) { return i.code; }).join(",");
  var url = "https://push2.eastmoney.com/api/qt/ulist.np/get?fields=f2,f3,f4,f12,f14&secids=" + secids;
  try {
    var raw = await httpGet(url, 10000);
    var json = JSON.parse(raw);
    if (json.data && json.data.diff) {
      var result = [];
      for (var i = 0; i < json.data.diff.length; i++) {
        var d = json.data.diff[i];
        result.push({
          code: d.f12,
          name: d.f14,
          price: d.f2 / 100,
          change: d.f3 / 100,
          changeAmt: d.f4 / 100
        });
      }
      return result;
    }
  } catch(e) {
    console.warn("[market] snapshot error:", e.message);
  }
  return [];
}

/**
 * 获取最新财经快讯（东方财富）
 */
async function getMarketNews(count) {
  if (!count) count = 5;
  var url = "https://np-listapi.eastmoney.com/comm/web/getNewsByColumns?client=web&biz=web_news_col&column=350&order=1&needInteractData=0&page_index=1&page_size=" + count;
  try {
    var raw = await httpGet(url, 10000);
    var json = JSON.parse(raw);
    if (json.data && json.data.list) {
      return json.data.list.map(function(item) {
        return { title: item.title || "", digest: item.digest || "", time: item.showTime || "" };
      });
    }
  } catch(e) {
    console.warn("[market] news error:", e.message);
  }
  return [];
}

/**
 * 获取热门投资观点（尝试nitter获取X推文，回退到东方财富）
 */
async function getMarketSentiment(count) {
  if (!count) count = 5;
  var tweets = await getTweetsFromNitter();
  if (tweets.length > 0) return tweets;
  return await getMarketNews(count);
}

async function getTweetsFromNitter() {
  var instances = ["nitter.privacydev.net", "nitter.poast.org", "xcancel.com"];
  for (var i = 0; i < instances.length; i++) {
    try {
      var url = "https://" + instances[i] + "/aleabitoreddit/rss";
      var raw = await httpGet(url, 8000);
      if (raw && raw.indexOf("<item>") > 0) {
        var items = raw.split("<item>").slice(1, 6);
        return items.map(function(item) {
          var title = item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/);
          var desc = item.match(/<description><!\[CDATA\[(.*?)\]\]><\/description>/s);
          return {
            title: title ? title[1].replace(/<[^>]+>/g, "").substring(0, 100) : "",
            digest: desc ? desc[1].replace(/<[^>]+>/g, "").substring(0, 200) : "",
            source: "X/" + instances[i]
          };
        }).filter(function(t) { return t.title; });
      }
    } catch(e) { continue; }
  }
  return [];
}

module.exports = { getFundNavHistory: getFundNavHistory, calcIndicators: calcIndicators, getFundPurchaseInfo: getFundPurchaseInfo, getPremiumRate: getPremiumRate, getFundBasicInfo: getFundBasicInfo, getMarketSnapshot: getMarketSnapshot, getMarketNews: getMarketNews, getMarketSentiment: getMarketSentiment, loadNavCache: loadNavCache };
