const fs = require("fs");
const path = require("path");
const { loadNavCache, saveNavCache, httpGet, httpGetWithRetry } = require("./utils");
const db = require("./db");

const NAV_CACHE_FILE = path.join(__dirname, "..", "data", "nav-cache.json");
const FUND_INFO_CACHE_FILE = path.join(__dirname, "..", "data", "fund-info-cache.json");

let _dbReady = false;

/**
 * 初始化数据库（启动时调用一次）
 */
async function initNavDb() {
  try {
    await db.getDb();
    const stats = db.getStats();
    if (stats.totalRecords === 0 && fs.existsSync(NAV_CACHE_FILE)) {
      console.log("[data] 首次使用 SQLite，自动迁移 nav-cache...");
      db.migrateFromJson(NAV_CACHE_FILE);
    }
    _dbReady = true;
    const newStats = db.getStats();
    console.log("[data] SQLite nav-cache: " + newStats.fundCount + " 只基金, " + newStats.totalRecords + " 条记录");
  } catch(e) {
    console.warn("[data] SQLite 初始化失败，使用 JSON 兼容模式:", e.message);
    _dbReady = false;
  }
}

function loadFundInfoCache() {
  try {
    if (fs.existsSync(FUND_INFO_CACHE_FILE)) {
      return JSON.parse(fs.readFileSync(FUND_INFO_CACHE_FILE, "utf-8"));
    }
  } catch(e) {
    console.warn("[cache] load fund-info failed, using empty:", e.message);
  }
  return {};
}

function saveFundInfoCache(cache) {
  try {
    fs.writeFileSync(FUND_INFO_CACHE_FILE, JSON.stringify(cache, null, 1), "utf-8");
  } catch(e) {
    console.error("[cache] save fund-info error:", e.message);
  }
}

function describeCachedRecords(records) {
  if (!records || records.length === 0) return "0 cached records";
  const first = records[0] && records[0].date ? records[0].date : "?";
  const last = records[records.length - 1] && records[records.length - 1].date ? records[records.length - 1].date : "?";
  return records.length + " cached records (" + first + " -> " + last + ")";
}

/**
 * ��ȡ������ʷ��ֵ��֧��3�곤����
 * ʹ��pageSize=500����API���ô���
 */
async function getFundNavHistory(fundCode, days) {
  if (!days) days = 5000; // 默认拉全部历史（约20年交易日），SQLite不限存储
  const pageSize = 20; // API硬限制最大20条/页

  // 从 SQLite 或 JSON 读取缓存
  let cached = [];
  if (_dbReady) {
    cached = db.getNavHistory(fundCode);
  } else {
    const cache = loadNavCache();
    cached = cache[fundCode] || [];
  }

  let pagesToFetch;
  if (cached.length > 0) {
    // 计算缓存最新日期距今的交易日数，加 20% 缓冲
    const lastCachedDate = cached[cached.length - 1].date;
    const now = new Date();
    const lastDate = new Date(lastCachedDate + "T00:00:00");
    const daysSinceLastCached = Math.ceil((now - lastDate) / 86400000);
    // 交易日约为日历日的 5/7，加 20% 缓冲
    const tradingDaysNeeded = Math.ceil(daysSinceLastCached * 5 / 7 * 1.2);
    // 至少拉 1 页，最多拉满请求天数
    const gapPages = Math.max(1, Math.ceil(Math.min(tradingDaysNeeded, days) / pageSize));

    // 检查是否需要回填更早的历史数据
    const firstCachedDate = cached[0].date;
    const cachedYears = (new Date(lastCachedDate) - new Date(firstCachedDate)) / 86400000 / 365;
    // 如果缓存不到4年，说明可能缺少早期数据，需要从第1页开始拉
    if (cachedYears < 4) {
      pagesToFetch = Math.ceil(days / pageSize);
    } else {
      pagesToFetch = gapPages;
    }
  } else {
    pagesToFetch = Math.ceil(days / pageSize); // 首次全量
  }

  let newRecords = [];
  let fetchSuccess = true;
  const _maxAttempts = 3; // 增加重试次数
  const _retryDelays = [2000, 4000, 6000]; // 增加重试间隔

  for (let page = 1; page <= pagesToFetch; page++) {
    const url = "https://api.fund.eastmoney.com/f10/lsjz?fundCode=" + fundCode + "&pageIndex=" + page + "&pageSize=" + pageSize;
    let _pageSuccess = false;
    try {
      const raw = await httpGetWithRetry(url, { timeoutMs: 20000, maxRetries: 3, retryDelays: [2000, 4000, 6000] });
      const json = JSON.parse(raw);
      if (!json.Data || !json.Data.LSJZList || json.Data.LSJZList.length === 0) {
        const respInfo = "ErrCode=" + (json.ErrCode || "N/A") + " TotalCount=" + (json.Data ? json.Data.TotalCount : "N/A") + " pageSize=" + pageSize;
        console.log("[data] fund " + fundCode + " page " + page + " no more data (" + respInfo + ")");
        fetchSuccess = true; // 到底了，不算失败
        break;
      }
      const records = json.Data.LSJZList.map(function(item) {
        return { date: item.FSRQ, nav: parseFloat(item.DWJZ), accNav: parseFloat(item.LJJZ), changeRate: item.JZZZL ? parseFloat(item.JZZZL) : 0 };
      });
      newRecords = newRecords.concat(records);
      _pageSuccess = true;
      if (json.Data.LSJZList.length < pageSize) { page = pagesToFetch; break; } // no more
    } catch (err) {
      console.warn("[data] fund " + fundCode + " page " + page + " failed after retries: " + err.message);
      fetchSuccess = false;
      if (cached.length > 0) break;
    }
    if (page < pagesToFetch) await new Promise(function(r) { setTimeout(r, 500); });
  }

  // 合并数据
  const merged = {};
  for (let m = 0; m < cached.length; m++) merged[cached[m].date] = cached[m];
  for (let n = 0; n < newRecords.length; n++) merged[newRecords[n].date] = newRecords[n];
  const allRecords = Object.values(merged).sort(function(a, b) {
    return a.date < b.date ? -1 : (a.date > b.date ? 1 : 0);
  });

  // 保存到 SQLite 或 JSON
  if (newRecords.length > 0 && allRecords.length >= cached.length) {
    if (_dbReady) {
      db.upsertNavRecords(fundCode, newRecords);
      db.saveDb();
    } else {
      const cache = loadNavCache();
      cache[fundCode] = allRecords;
      saveNavCache(cache);
    }
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
  const navs = navHistory.map(function(d) { return d.nav; });
  const latest = navs[navs.length - 1];

  // --- ����ָ�� ---
  const ma5 = navs.length >= 5 ? navs.slice(-5).reduce(function(a,b){return a+b;},0) / 5 : latest;
  const ma10 = navs.length >= 10 ? navs.slice(-10).reduce(function(a,b){return a+b;},0) / 10 : ma5;
  const ma20 = navs.length >= 20 ? navs.slice(-20).reduce(function(a,b){return a+b;},0) / 20 : ma10;
  const maDeviation = ((latest - ma10) / ma10) * 100;
  const recent5Change = navs.length >= 5 ? ((latest - navs[navs.length-5]) / navs[navs.length-5]) * 100 : 0;
  const recent10Change = navs.length >= 10 ? ((latest - navs[navs.length-10]) / navs[navs.length-10]) * 100 : recent5Change;

  // ���ڻس������20����ߵ㣩
  const recentHigh = Math.max.apply(null, navs.slice(-Math.min(20, navs.length)));
  const drawdown = ((latest - recentHigh) / recentHigh) * 100;

  // ���������У���ȫ�����ݣ����ڲ����ʺ����ձ��ʼ��㣩
  const returns = [];
  for (let i = 1; i < navs.length; i++) {
    returns.push((navs[i] - navs[i-1]) / navs[i-1]);
  }
  // �������ý�20��
  const volPeriod = Math.min(20, returns.length);
  const volReturns = returns.slice(-volPeriod);
  const avgReturn = volReturns.reduce(function(a,b){return a+b;},0) / (volReturns.length || 1);
  const variance = volReturns.reduce(function(sum,r){return sum + Math.pow(r - avgReturn, 2);},0) / (volReturns.length || 1);
  const volatility = Math.sqrt(variance) * 100;

  // --- ����ָ�� ---
  // ���ھ���
  const ma60 = navs.length >= 60 ? navs.slice(-60).reduce(function(a,b){return a+b;},0) / 60 : ma20;
  const ma120 = navs.length >= 120 ? navs.slice(-120).reduce(function(a,b){return a+b;},0) / 120 : ma60;
  const ma250 = navs.length >= 250 ? navs.slice(-250).reduce(function(a,b){return a+b;},0) / 250 : ma120;

  // 1��/3�������ʣ���K�߼��㣬���ã�
  let yearReturn = null;
  let threeYearReturn = null;
  let annualizedReturn = null;

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
    const years = navs.length / 250;
    if (years > 0) {
      annualizedReturn = r2((Math.pow(latest / navs[0], 1 / years) - 1) * 100);
    }
  }

  // 3�����س�
  let maxDrawdown = 0;
  if (navs.length >= 60) {
    let peak = navs[0];
    for (let j = 1; j < navs.length; j++) {
      if (navs[j] > peak) peak = navs[j];
      const dd = (navs[j] - peak) / peak * 100;
      if (dd < maxDrawdown) maxDrawdown = dd;
    }
    maxDrawdown = r2(maxDrawdown);
  }

  // ���ձ��ʣ��껯����ȫ�����ݼ�����ȶ���
  let sharpeRatio = null;
  if (returns.length >= 60) {
    const allAvg = returns.reduce(function(a,b){return a+b;},0) / returns.length;
    const allVar = returns.reduce(function(sum,r){return sum + Math.pow(r - allAvg, 2);},0) / returns.length;
    const annualReturn = allAvg * 250;
    const annualVol = Math.sqrt(allVar) * Math.sqrt(250);
    if (annualVol > 0) {
      sharpeRatio = r2((annualReturn - 0.02) / annualVol);
    }
  }

  // ���������ж�
  let longTermTrend = "unknown";
  if (navs.length >= 250) {
    if (latest > ma120 && ma120 > ma250) longTermTrend = "bull";
    else if (latest < ma120 && ma120 < ma250) longTermTrend = "bear";
    else longTermTrend = "neutral";
  }

  // 近期涨跌
  const recent20Change = navs.length >= 20 ? r2(((latest - navs[navs.length-20]) / navs[navs.length-20]) * 100) : null;
  const recent30Change = navs.length >= 30 ? r2(((latest - navs[navs.length-30]) / navs[navs.length-30]) * 100) : null;
  const recent60Change = navs.length >= 60 ? r2(((latest - navs[navs.length-60]) / navs[navs.length-60]) * 100) : null;
  const recent90Change = navs.length >= 90 ? r2(((latest - navs[navs.length-90]) / navs[navs.length-90]) * 100) : null;

  function r2(n) { return Math.round(n*100)/100; }
  return {
    latest: r2(latest),
    ma5: r2(ma5), ma10: r2(ma10), ma20: r2(ma20),
    ma60: r2(ma60), ma120: r2(ma120), ma250: r2(ma250),
    maDeviation: r2(maDeviation),
    recent5Change: r2(recent5Change),
    recent10Change: r2(recent10Change),
    recent20Change: recent20Change,
    recent30Change: recent30Change,
    recent60Change: recent60Change,
    recent90Change: recent90Change,
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
  const cache = loadFundInfoCache();
  const cached = cache[fundCode];

  // 缓存有效期内直接返回（4小时）
  if (cached && cached._cachedAt && (Date.now() - cached._cachedAt < 14400000)) {
    return cached;
  }

  const url = "https://fundmobapi.eastmoney.com/FundMApi/FundBasicInformation.ashx?FCODE=" + fundCode + "&deviceid=wap&version=5.8.0&product=EFund&plat=Wap";

  try {
    const raw = await httpGetWithRetry(url, { timeoutMs: 15000, maxRetries: 2, retryDelays: [1000] });
    const json = JSON.parse(raw);
    const data = json.Datas || json;
    if (!data || !data.SGZT) {
      if (cached) return cached;
      return { status: "unknown", limit: 100, minPurchase: 10, premiumRate: 0 };
    }

    // 限购状态
    let status = "active";
    let limit = 100;
    let minPurchase = 10;
    const sgzt = data.SGZT || "";
    const isBuy = data.ISBUY === "1" || data.BUY === true;
    if (data.MINSG) minPurchase = parseInt(data.MINSG) || 10;
    if (data.MAXSG && data.MAXSG !== "" && data.MAXSG !== "0") {
      limit = parseInt(data.MAXSG) || 100;
    }
    const suspended = sgzt.indexOf("暂停") >= 0 || sgzt.indexOf("封闭") >= 0;
    const limited = sgzt.indexOf("限大额") >= 0 || sgzt.indexOf("限制") >= 0;
    const opened = sgzt.indexOf("开放") >= 0;
    if (!isBuy || suspended) {
      status = "suspended";
    } else if (limited) {
      status = "limited";
    } else if (opened) {
      status = "active";
    }

    // 溢价率
    let premiumRate = 0;
    const nav = parseFloat(data.DWJZ) || 0;
    const realNav = parseFloat(data.GSZ) || 0;
    const gzTime = data.GZTIME || "";
    let premiumStale = false;
    if (nav > 0 && realNav > 0) {
      premiumRate = Math.round(((realNav - nav) / nav) * 10000) / 100;
      if (gzTime) {
        const today = new Date().toISOString().substring(0, 10);
        const gzDate = gzTime.substring(0, 10);
        if (gzDate !== today) {
          premiumStale = true;
          premiumRate = 0;
        }
      }
    }

    // 收益率（优先API数据）
    let yearReturn = parseFloat(data.SYL_1N) || 0;
    if (yearReturn === 0 && data.SYL_6N) {
      yearReturn = Math.round(parseFloat(data.SYL_6N) * 2 * 100) / 100;
    }
    const threeYearReturn = parseFloat(data.SYL_3N) || null;

    const result = {
      status: status, limit: limit, minPurchase: minPurchase,
      rawStatus: sgzt, premiumRate: premiumRate,
      premiumStale: premiumStale, gzTime: gzTime,
      nav: nav, realNav: realNav,
      yearReturn: yearReturn, threeYearReturn: threeYearReturn,
      _cachedAt: Date.now()
    };

    cache[fundCode] = result;
    saveFundInfoCache(cache);
    return result;
  } catch (err) {
    // 请求失败，回退到缓存
    if (cached) return cached;
    return { status: "unknown", limit: 100, minPurchase: 10, premiumRate: 0, yearReturn: 0 };
  }
}

// ���ݾɽӿ�
async function getFundPurchaseInfo(fundCode) {
  return getFundBasicInfo(fundCode);
}

async function getPremiumRate(fundCode) {
  const info = await getFundBasicInfo(fundCode);
  return { premiumRate: info.premiumRate, nav: info.nav, realNav: info.realNav };
}

/**
 * ��ȡʵʱ�г����գ�����ָ����A�ɡ��۹ɡ�VIX�����ʣ�
 */
async function getMarketSnapshot() {
  const indices = [
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
  const secids = indices.map(function(i) { return i.code; }).join(",");
  const url = "https://push2.eastmoney.com/api/qt/ulist.np/get?fields=f2,f3,f4,f12,f14&secids=" + secids;
  // ����3��
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const raw = await httpGet(url, 15000);
      if (!raw || raw.length < 10) {
        await new Promise(function(r) { setTimeout(r, [1000,2000,4000][attempt]); });
        continue;
      }
      const json = JSON.parse(raw);
      if (json.data && json.data.diff) {
        const result = [];
        for (let i = 0; i < json.data.diff.length; i++) {
          const d = json.data.diff[i];
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
  const url = "https://np-listapi.eastmoney.com/comm/web/getNewsByColumns?client=web&biz=web_news_col&column=350&order=1&needInteractData=0&page_index=1&page_size=" + count;
  try {
    const raw = await httpGet(url, 10000);
    const json = JSON.parse(raw);
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
  const news = await getMarketNews(count);
  const fundTopics = await getFundTopics(count);
  return news.concat(fundTopics);
}

/**
 * ��ȡ�����Ƹ��������黰��
 */
async function getFundTopics(count) {
  if (!count) count = 5;
  const url = "https://emappdata.eastmoney.com/ETFCount/getETFHotTopic?product=etf&plat=wap&version=5.8.0&deviceid=wap&fields=topic,hot,rate&count=" + count;
  try {
    const raw = await httpGet(url, 10000);
    const json = JSON.parse(raw);
    if (json.data && json.data.length > 0) {
      return json.data.map(function(item) {
        return { title: "\u70ed\u8bae\u8bdd\u9898: " + (item.topic || ""), digest: "\u70ed\u5ea6:" + (item.hot || "N/A") + " \u6da8\u8dcc:" + (item.rate || "N/A"), time: "", source: "eastmoney" };
      });
    }
  } catch(e) {
    console.warn("[data] ETF热点话题获取失败:", e.message);
  }
  const url2 = "https://np-listapi.eastmoney.com/comm/web/getNewsByColumns?client=web&biz=web_news_col&column=450&order=1&needInteractData=0&page_index=1&page_size=" + count;
  try {
    const raw2 = await httpGet(url2, 10000);
    const json2 = JSON.parse(raw2);
    if (json2.data && json2.data.list) {
      return json2.data.list.map(function(item) {
        return { title: item.title || "", digest: item.digest || "", time: item.showTime || "", source: "eastmoney" };
      });
    }
  } catch(e2) {
    console.warn("[data] 东方财富新闻获取失败:", e2.message);
  }
  return [];
}

/**
 * 获取雪球热帖（QDII/基金相关）
 */
async function getXueqiuHot(count) {
  if (!count) count = 10;
  const url = "https://stock.xueqiu.com/v5/stock/hot_stock/list.json?size=" + count + "&order=desc&order_by=percent&type=10&_type=10";
  try {
    const raw = await httpGet(url, 10000);
    const json = JSON.parse(raw);
    if (json.data && json.data.items) {
      return json.data.items.map(function(item) {
        return { title: item.name || "", digest: "涨跌:" + (item.percent || 0) + "%", time: "", source: "xueqiu", code: item.code || "" };
      });
    }
  } catch(e) {
    console.warn("[data] 雪球热帖获取失败:", e.message);
  }
  return [];
}

/**
 * 获取东方财富基金公告
 */
async function getFundAnnouncements(fundCode, count) {
  if (!count) count = 5;
  const url = "https://np-anotice-stock.eastmoney.com/api/security/ann?page_size=" + count + "&page_index=1&ann_type=A&stock_list=" + fundCode + "&f_node=0&s_node=0";
  try {
    const raw = await httpGet(url, 10000);
    const json = JSON.parse(raw);
    if (json.data && json.data.list) {
      return json.data.list.map(function(item) {
        return { title: item.title || "", digest: item.art_code || "", time: item.notice_date || "", source: "announcement" };
      });
    }
  } catch(e) {
    // 静默失败，公告不是必须的
  }
  return [];
}

/**
 * 获取全球财经新闻（东方财富全球快讯）
 */
async function getGlobalNews(count) {
  if (!count) count = 10;
  const url = "https://np-listapi.eastmoney.com/comm/web/getNewsByColumns?client=web&biz=web_news_col&column=350&order=1&needInteractData=0&page_index=1&page_size=" + count;
  try {
    const raw = await httpGet(url, 10000);
    const json = JSON.parse(raw);
    if (json.data && json.data.list) {
      return json.data.list.map(function(item) {
        return { title: item.title || "", digest: item.digest || "", time: item.showTime || "", source: "global-news" };
      });
    }
  } catch(e) {
    console.warn("[data] 全球快讯获取失败:", e.message);
  }
  return [];
}

/**
 * 获取美股/纳斯达克相关新闻
 */
async function getUSMarketNews(count) {
  if (!count) count = 8;
  // 东方财富美股频道
  const url = "https://np-listapi.eastmoney.com/comm/web/getNewsByColumns?client=web&biz=web_news_col&column=353&order=1&needInteractData=0&page_index=1&page_size=" + count;
  try {
    const raw = await httpGet(url, 10000);
    const json = JSON.parse(raw);
    if (json.data && json.data.list) {
      return json.data.list.map(function(item) {
        return { title: item.title || "", digest: item.digest || "", time: item.showTime || "", source: "us-market" };
      });
    }
  } catch(e) {
    console.warn("[data] 美股新闻获取失败:", e.message);
  }
  return [];
}

/**
 * 综合新闻情绪分析
 * 汇总多来源新闻，分析对各主题的情绪倾向
 */
async function getNewsSentiment() {
  const [globalNews, usNews, topics] = await Promise.all([
    getGlobalNews(10),
    getUSMarketNews(8),
    getFundTopics(5)
  ]);

  const allNews = globalNews.concat(usNews).concat(topics);

  // 关键词情绪评分
  const positiveWords = ["利好", "上涨", "突破", "新高", "增长", "反弹", "降息", "宽松", "牛市", "大涨", "看涨", "bullish", "rally", "surge", "gain"];
  const negativeWords = ["利空", "下跌", "暴跌", "新低", "衰退", "加息", "紧缩", "熊市", "大跌", "看跌", "bearish", "crash", "plunge", "sell-off", "risk"];

  // 主题关键词（与 external-signals.js 同步）
  const themeKeywords = {
    nasdaq: ["nasdaq", "ndx", "qqq", "nvda", "microsoft", "apple", "meta", "tesla", "nvidia", "ai", "semiconductor", "chip"],
    sp500: ["s&p", "sp500", "spy", "spx", "us stocks", "equity"],
    biotech: ["biotech", "healthcare", "pharma", "drug", "fda"],
    reit: ["reit", "real estate", "property", "housing"],
    hongkong: ["hong kong", "hsi", "hang seng", "china", "hk", "asia"],
    oil: ["oil", "crude", "brent", "wti", "energy", "opec"],
    bonds: ["bond", "treasury", "yield", "rate cut", "rate hike", "fed"]
  };

  const sentiment = {
    overall: 0,
    positive: 0,
    negative: 0,
    neutral: 0,
    items: allNews.length,
    byTheme: {},
    headlines: allNews.slice(0, 8).map(function(n) { return n.title; })
  };

  allNews.forEach(function(news) {
    const text = (news.title + " " + (news.digest || "")).toLowerCase();
    let score = 0;

    positiveWords.forEach(function(w) { if (text.indexOf(w) >= 0) score += 1; });
    negativeWords.forEach(function(w) { if (text.indexOf(w) >= 0) score -= 1; });

    if (score > 0) sentiment.positive++;
    else if (score < 0) sentiment.negative++;
    else sentiment.neutral++;

    sentiment.overall += score;

    // 主题关联
    Object.keys(themeKeywords).forEach(function(theme) {
      const keywords = themeKeywords[theme];
      for (let i = 0; i < keywords.length; i++) {
        if (text.indexOf(keywords[i]) >= 0) {
          if (!sentiment.byTheme[theme]) sentiment.byTheme[theme] = { positive: 0, negative: 0, count: 0 };
          sentiment.byTheme[theme].count++;
          if (score > 0) sentiment.byTheme[theme].positive++;
          else if (score < 0) sentiment.byTheme[theme].negative++;
          break;
        }
      }
    });
  });

  // 归一化到 -100 ~ +100
  if (allNews.length > 0) {
    sentiment.overall = Math.round(sentiment.overall / allNews.length * 100);
  }

  return sentiment;
}

/**
 * 清理陈旧的nav-cache数据
 * 移除超过180天未更新的基金缓存
 * @returns {Object} { removed: string[], kept: number }
 */
function cleanStaleCache() {
  const cache = loadNavCache();
  const removed = [];
  let kept = 0;
  const staleThreshold = 180 * 86400000; // 180天
  const now = Date.now();

  const codes = Object.keys(cache);
  for (let i = 0; i < codes.length; i++) {
    const code = codes[i];
    const navs = cache[code];
    if (!navs || navs.length === 0) {
      delete cache[code];
      removed.push(code);
      continue;
    }
    const lastDate = navs[navs.length - 1].date;
    const lastMs = new Date(lastDate + "T00:00:00").getTime();
    if (now - lastMs > staleThreshold) {
      delete cache[code];
      removed.push(code + "(" + lastDate + ")");
    } else {
      kept++;
    }
  }

  if (removed.length > 0) {
    saveNavCache(cache);
    console.log("[data] 清理陈旧缓存: 移除" + removed.length + "只基金, 保留" + kept + "只");
    for (let r = 0; r < removed.length; r++) {
      console.log("  - " + removed[r]);
    }
  }
  return { removed: removed, kept: kept };
}

module.exports = { getFundNavHistory: getFundNavHistory, calcIndicators: calcIndicators, getFundPurchaseInfo: getFundPurchaseInfo, getPremiumRate: getPremiumRate, getFundBasicInfo: getFundBasicInfo, getMarketSnapshot: getMarketSnapshot, getMarketNews: getMarketNews, getMarketSentiment: getMarketSentiment, getGlobalNews: getGlobalNews, getUSMarketNews: getUSMarketNews, getNewsSentiment: getNewsSentiment, getXueqiuHot: getXueqiuHot, getFundAnnouncements: getFundAnnouncements, loadNavCache: loadNavCache, cleanStaleCache: cleanStaleCache, initNavDb: initNavDb };
