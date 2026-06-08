const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");

var NAV_CACHE_FILE = path.join(__dirname, "..", "data", "nav-cache.json");
var FUND_INFO_CACHE_FILE = path.join(__dirname, "..", "data", "fund-info-cache.json");

function loadFundInfoCache() {
  try {
    if (fs.existsSync(FUND_INFO_CACHE_FILE)) {
      return JSON.parse(fs.readFileSync(FUND_INFO_CACHE_FILE, "utf-8"));
    }
  } catch(e) {}
  return {};
}

function saveFundInfoCache(cache) {
  try {
    fs.writeFileSync(FUND_INFO_CACHE_FILE, JSON.stringify(cache, null, 1), "utf-8");
  } catch(e) {
    console.error("[cache] save fund-info error:", e.message);
  }
}

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

function describeCachedRecords(records) {
  if (!records || records.length === 0) return "0 cached records";
  var first = records[0] && records[0].date ? records[0].date : "?";
  var last = records[records.length - 1] && records[records.length - 1].date ? records[records.length - 1].date : "?";
  return records.length + " cached records (" + first + " -> " + last + ")";
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
 * ��ȡ������ʷ��ֵ��֧��3�곤����
 * ʹ��pageSize=500����API���ô���
 */
async function getFundNavHistory(fundCode, days) {
  if (!days) days = 750;
  var pageSize = 20; // API硬限制最大20条/页
  var cache = loadNavCache();
  var cached = cache[fundCode] || [];

  var pagesToFetch;
  if (cached.length > 0) {
    pagesToFetch = 2; // 增量更新
  } else {
    pagesToFetch = Math.ceil(days / pageSize); // 首次全量
  }

  var newRecords = [];
  var fetchSuccess = true;
  var maxAttempts = 3; // 增加重试次数
  var retryDelays = [2000, 4000, 6000]; // 增加重试间隔

  for (var page = 1; page <= pagesToFetch; page++) {
    var url = "https://api.fund.eastmoney.com/f10/lsjz?fundCode=" + fundCode + "&pageIndex=" + page + "&pageSize=" + pageSize;
    var lastErr = null;
    var pageSuccess = false;
    for (var attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        var raw = await httpGet(url, 20000);
        var json = JSON.parse(raw);
        if (!json.Data || !json.Data.LSJZList || json.Data.LSJZList.length === 0) {
          var respInfo = "ErrCode=" + (json.ErrCode || "N/A") + " TotalCount=" + (json.Data ? json.Data.TotalCount : "N/A") + " pageSize=" + pageSize;
          lastErr = new Error("empty data (" + respInfo + ")");
          if (attempt < maxAttempts - 1) await new Promise(function(r) { setTimeout(r, retryDelays[attempt]); });
          continue;
        }
        var records = json.Data.LSJZList.map(function(item) {
          return { date: item.FSRQ, nav: parseFloat(item.DWJZ), accNav: parseFloat(item.LJJZ), changeRate: item.JZZZL ? parseFloat(item.JZZZL) : 0 };
        });
        newRecords = newRecords.concat(records);
        pageSuccess = true;
        if (json.Data.LSJZList.length < pageSize) { page = pagesToFetch; break; } // no more
        break; // success
      } catch (err) {
        lastErr = err;
        if (attempt < maxAttempts - 1) await new Promise(function(r) { setTimeout(r, retryDelays[attempt]); });
      }
    }
    if (!pageSuccess) {
      console.warn("[data] fund " + fundCode + " page " + page + " failed after retries: " + (lastErr ? lastErr.message : "unknown error"));
      fetchSuccess = false;
      if (cached.length > 0) break;
    }
    if (page < pagesToFetch) await new Promise(function(r) { setTimeout(r, 800); });
  }

  // �ϲ�����
  var merged = {};
  for (var m = 0; m < cached.length; m++) merged[cached[m].date] = cached[m];
  for (var n = 0; n < newRecords.length; n++) merged[newRecords[n].date] = newRecords[n];
  var allRecords = Object.values(merged).sort(function(a, b) {
    return a.date < b.date ? -1 : (a.date > b.date ? 1 : 0);
  });

  // ֻ���õ������������������ڻ���ʱ�Ÿ��»���
  if (newRecords.length > 0 && allRecords.length >= cached.length) {
    cache[fundCode] = allRecords;
    saveNavCache(cache);
  }

  if (!fetchSuccess && cached.length > 0) {
    console.warn("[data] fund " + fundCode + ": API failed, using " + describeCachedRecords(cached));
    return cached.slice(-days);
  }

  // ����ϲ������ݱȻ����٣��쳣�����û���
  if (allRecords.length < cached.length && cached.length > 0) {
    console.warn("[data] fund " + fundCode + ": merged(" + allRecords.length + ") < cached(" + cached.length + "), using cache");
    return cached.slice(-days);
  }

  if (allRecords.length === 0) {
    console.warn("[data] fund " + fundCode + ": no data (no cache, no API)");
  }
  return allRecords.slice(-days);
}

/**
 * ���������ָ�꣨������ָ�꣩
 * ֧��3�����ݵ�MA120��MA250�����ձ��ʡ��껯�����
 */
function calcIndicators(navHistory) {
  if (!navHistory || navHistory.length < 5) { return { error: "insufficient data" }; }
  var navs = navHistory.map(function(d) { return d.nav; });
  var latest = navs[navs.length - 1];

  // --- ����ָ�� ---
  var ma5 = navs.length >= 5 ? navs.slice(-5).reduce(function(a,b){return a+b},0) / 5 : latest;
  var ma10 = navs.length >= 10 ? navs.slice(-10).reduce(function(a,b){return a+b},0) / 10 : ma5;
  var ma20 = navs.length >= 20 ? navs.slice(-20).reduce(function(a,b){return a+b},0) / 20 : ma10;
  var maDeviation = ((latest - ma10) / ma10) * 100;
  var recent5Change = navs.length >= 5 ? ((latest - navs[navs.length-5]) / navs[navs.length-5]) * 100 : 0;
  var recent10Change = navs.length >= 10 ? ((latest - navs[navs.length-10]) / navs[navs.length-10]) * 100 : recent5Change;

  // ���ڻس������20����ߵ㣩
  var recentHigh = Math.max.apply(null, navs.slice(-Math.min(20, navs.length)));
  var drawdown = ((latest - recentHigh) / recentHigh) * 100;

  // ���������У���ȫ�����ݣ����ڲ����ʺ����ձ��ʼ��㣩
  var returns = [];
  for (var i = 1; i < navs.length; i++) {
    returns.push((navs[i] - navs[i-1]) / navs[i-1]);
  }
  // �������ý�20��
  var volPeriod = Math.min(20, returns.length);
  var volReturns = returns.slice(-volPeriod);
  var avgReturn = volReturns.reduce(function(a,b){return a+b},0) / (volReturns.length || 1);
  var variance = volReturns.reduce(function(sum,r){return sum + Math.pow(r - avgReturn, 2)},0) / (volReturns.length || 1);
  var volatility = Math.sqrt(variance) * 100;

  // --- ����ָ�� ---
  // ���ھ���
  var ma60 = navs.length >= 60 ? navs.slice(-60).reduce(function(a,b){return a+b},0) / 60 : ma20;
  var ma120 = navs.length >= 120 ? navs.slice(-120).reduce(function(a,b){return a+b},0) / 120 : ma60;
  var ma250 = navs.length >= 250 ? navs.slice(-250).reduce(function(a,b){return a+b},0) / 250 : ma120;

  // 1��/3�������ʣ���K�߼��㣬���ã�
  var yearReturn = null;
  var threeYearReturn = null;
  var annualizedReturn = null;

  if (navs.length >= 250) {
    // 1�����棺���250��
    yearReturn = r2(((latest - navs[navs.length - 250]) / navs[navs.length - 250]) * 100);
  } else if (navs.length >= 200) {
    // ���ݲ���250�죬��ȫ������
    yearReturn = r2(((latest - navs[0]) / navs[0]) * 100);
  }

  if (navs.length >= 700) {
    // 3�����棺��ȫ������
    threeYearReturn = r2(((latest - navs[0]) / navs[0]) * 100);
    var years = navs.length / 250;
    if (years > 0) {
      annualizedReturn = r2((Math.pow(latest / navs[0], 1 / years) - 1) * 100);
    }
  }

  // 3�����س�
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

  // ���ձ��ʣ��껯����ȫ�����ݼ�����ȶ���
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

  // ���������ж�
  var longTermTrend = "unknown";
  if (navs.length >= 250) {
    if (latest > ma120 && ma120 > ma250) longTermTrend = "bull";
    else if (latest < ma120 && ma120 < ma250) longTermTrend = "bear";
    else longTermTrend = "neutral";
  }

  // ��20���ǵ�
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
  // �Ȳ黺��
  var cache = loadFundInfoCache();
  var cached = cache[fundCode];

  // �����������Ҳ����ڣ�24Сʱ�ڣ���ֱ�ӷ���
  if (cached && cached._cachedAt && (Date.now() - cached._cachedAt < 14400000)) {
    return cached;
  }

  var url = "https://fundmobapi.eastmoney.com/FundMApi/FundBasicInformation.ashx?FCODE=" + fundCode + "&deviceid=wap&version=5.8.0&product=EFund&plat=Wap";
  var maxRetries = 2;
  var delays = [1000]; // ָ���˱�

  for (var attempt = 0; attempt < maxRetries; attempt++) {
    try {
      var raw = await httpGet(url, 15000);
      var json = JSON.parse(raw);
      var data = json.Datas || json;
      if (!data || !data.SGZT) {
        // ������Ч������
        if (attempt < maxRetries - 1) {
          await new Promise(function(r) { setTimeout(r, delays[attempt]); });
          continue;
        }
        // ����ʧ�ܣ����ػ��棨����У�
        if (cached) return cached;
        return { status: "unknown", limit: 100, minPurchase: 10, premiumRate: 0 };
      }

      // �޹�״̬
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

      // �����
      var premiumRate = 0;
      var nav = parseFloat(data.DWJZ) || 0;
      var realNav = parseFloat(data.GSZ) || 0;
      var gzTime = data.GZTIME || "";
      var premiumStale = false;
      if (nav > 0 && realNav > 0) {
        premiumRate = Math.round(((realNav - nav) / nav) * 10000) / 100;
        if (gzTime) {
          var today = new Date().toISOString().substring(0, 10);
          var gzDate = gzTime.substring(0, 10);
          if (gzDate !== today) {
            premiumStale = true;
            premiumRate = 0;
          }
        }
      }

      // �����ʣ������ڣ�
      var yearReturn = parseFloat(data.SYL_1N) || 0;
      if (yearReturn === 0 && data.SYL_6N) {
        yearReturn = Math.round(parseFloat(data.SYL_6N) * 2 * 100) / 100;
      }
      var threeYearReturn = parseFloat(data.SYL_3N) || null;

      var result = {
        status: status, limit: limit, minPurchase: minPurchase,
        rawStatus: sgzt, premiumRate: premiumRate,
        premiumStale: premiumStale, gzTime: gzTime,
        nav: nav, realNav: realNav,
        yearReturn: yearReturn, threeYearReturn: threeYearReturn,
        _cachedAt: Date.now()
      };

      // ���浽����
      cache[fundCode] = result;
      saveFundInfoCache(cache);

      return result;
    } catch (err) {
      if (attempt < maxRetries - 1) {
        await new Promise(function(r) { setTimeout(r, delays[attempt]); });
      } else {
        // ����ʧ�ܣ����ػ���
        if (cached) return cached;
        return { status: "unknown", limit: 100, minPurchase: 10, premiumRate: 0, yearReturn: 0 };
      }
    }
  }
  // should not reach here
  if (cached) return cached;
  return { status: "unknown", limit: 100, minPurchase: 10, premiumRate: 0, yearReturn: 0 };
}

// ���ݾɽӿ�
async function getFundPurchaseInfo(fundCode) {
  return getFundBasicInfo(fundCode);
}

async function getPremiumRate(fundCode) {
  var info = await getFundBasicInfo(fundCode);
  return { premiumRate: info.premiumRate, nav: info.nav, realNav: info.realNav };
}

/**
 * ��ȡʵʱ�г����գ�����ָ����A�ɡ��۹ɡ�VIX�����ʣ�
 */
async function getMarketSnapshot() {
  var indices = [
    { code: "100.NDX", name: "纳斯达克" },
    { code: "100.SPX", name: "标普500" },
    { code: "100.DJIA", name: "道琼斯" },
    { code: "1.000001", name: "上证指数" },
    { code: "100.HSI", name: "恒生指数" },
    { code: "100.VIXF", name: "VIX期货" },
    { code: "119.USDCNH", name: "美元/人民币" },
    { code: "100.GDAXI", name: "德国DAX" },
    { code: "100.N225", name: "日经225" },
    { code: "119.EURUSD", name: "欧元/美元" },
    { code: "119.HKDCNY", name: "港币/人民币" },
    { code: "100.GC00Y", name: "黄金期货" },
    { code: "100.CL00Y", name: "原油期货" }
  ];
  var secids = indices.map(function(i) { return i.code; }).join(",");
  var url = "https://push2.eastmoney.com/api/qt/ulist.np/get?fields=f2,f3,f4,f12,f14&secids=" + secids;
  // ����3��
  for (var attempt = 0; attempt < 3; attempt++) {
    try {
      var raw = await httpGet(url, 15000);
      if (!raw || raw.length < 10) {
        await new Promise(function(r) { setTimeout(r, [1000,2000,4000][attempt]); });
        continue;
      }
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
      if (attempt < 2) await new Promise(function(r) { setTimeout(r, [1000,2000,4000][attempt]); });
      else console.warn("[market] snapshot error after 3 retries:", e.message);
    }
  }
  return [];
}

/**
 * ��ȡ���²ƾ���Ѷ�������Ƹ���
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
 * ��ȡ����Ͷ�ʹ۵㣨����nitter��ȡX���ģ����˵������Ƹ���
 */
async function getMarketSentiment(count) {
  if (!count) count = 8;
  // ��ȡ����Դ���ţ��ƾ���Ѷ + ��������
  var news = await getMarketNews(count);
  var fundTopics = await getFundTopics(count);
  return news.concat(fundTopics);
}

/**
 * ��ȡ�����Ƹ��������黰��
 */
async function getFundTopics(count) {
  if (!count) count = 5;
  var url = "https://emappdata.eastmoney.com/ETFCount/getETFHotTopic?product=etf&plat=wap&version=5.8.0&deviceid=wap&fields=topic,hot,rate&count=" + count;
  try {
    var raw = await httpGet(url, 10000);
    var json = JSON.parse(raw);
    if (json.data && json.data.length > 0) {
      return json.data.map(function(item) {
        return { title: "\u70ed\u8bae\u8bdd\u9898: " + (item.topic || ""), digest: "\u70ed\u5ea6:" + (item.hot || "N/A") + " \u6da8\u8dcc:" + (item.rate || "N/A"), time: "", source: "eastmoney" };
      });
    }
  } catch(e) {}
  // ���ˣ���ȡ������Ѷ
  var url2 = "https://np-listapi.eastmoney.com/comm/web/getNewsByColumns?client=web&biz=web_news_col&column=450&order=1&needInteractData=0&page_index=1&page_size=" + count;
  try {
    var raw2 = await httpGet(url2, 10000);
    var json2 = JSON.parse(raw2);
    if (json2.data && json2.data.list) {
      return json2.data.list.map(function(item) {
        return { title: item.title || "", digest: item.digest || "", time: item.showTime || "", source: "eastmoney" };
      });
    }
  } catch(e2) {}
  return [];
}

module.exports = { getFundNavHistory: getFundNavHistory, calcIndicators: calcIndicators, getFundPurchaseInfo: getFundPurchaseInfo, getPremiumRate: getPremiumRate, getFundBasicInfo: getFundBasicInfo, getMarketSnapshot: getMarketSnapshot, getMarketNews: getMarketNews, getMarketSentiment: getMarketSentiment, loadNavCache: loadNavCache };
