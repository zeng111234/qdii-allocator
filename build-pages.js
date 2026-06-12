/**
 * 构建 GitHub Pages 页面
 * 把数据嵌入到 HTML 中，不需要 token
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const TEMPLATE = path.join(__dirname, 'docs', 'index.html.template');
const OUTPUT = path.join(__dirname, 'docs', 'index.html');
const PORTFOLIO = path.join(__dirname, 'data', 'portfolio.json');
const FUNDS = path.join(__dirname, 'data', 'funds.json');
const NAV_CACHE = path.join(__dirname, 'data', 'nav-cache.json');
const DAILY_BRIEF = path.join(__dirname, 'data', 'daily-brief.json');
const DIARY = path.join(__dirname, 'data', 'diary.json');

async function build() {
  console.log('[构建] 开始构建 GitHub Pages...');

  // 读取模板
  let template = fs.readFileSync(TEMPLATE, 'utf-8');

  // 读取数据
  const portfolio = JSON.parse(fs.readFileSync(PORTFOLIO, 'utf-8'));
  const funds = JSON.parse(fs.readFileSync(FUNDS, 'utf-8'));

  // 读取净值缓存，提取每只基金的最新净值
  const navCache = JSON.parse(fs.readFileSync(NAV_CACHE, 'utf-8'));
  const latestNavs = {};
  for (const code in navCache) {
    const navs = navCache[code];
    if (navs && navs.length > 0) {
      latestNavs[code] = navs[navs.length - 1];
    }
  }

  // 读取每日早报
  let dailyBrief = null;
  try {
    if (fs.existsSync(DAILY_BRIEF)) {
      dailyBrief = JSON.parse(fs.readFileSync(DAILY_BRIEF, 'utf-8'));
    }
  } catch(e) {}

  // 读取投资日记
  let diary = { entries: [] };
  try {
    if (fs.existsSync(DIARY)) {
      diary = JSON.parse(fs.readFileSync(DIARY, 'utf-8'));
    }
  } catch(e) {}

  // 嵌入数据
  template = template.replace('PORTFOLIO_DATA', JSON.stringify(portfolio));
  template = template.replace('FUNDS_DATA', JSON.stringify(funds));
  template = template.replace('NAV_CACHE_DATA', JSON.stringify(latestNavs));
  template = template.replace('DAILY_BRIEF_DATA', JSON.stringify(dailyBrief));
  template = template.replace('DIARY_DATA', JSON.stringify(diary));

  // 抓取新闻数据嵌入（避免前端 CORS 问题）
  let newsData = { items: [], sentiment: null, fetchedAt: null };
  try {
    const httpGetSync = (url) => new Promise((resolve, reject) => {
      https.get(url, { timeout: 8000 }, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => resolve(data));
      }).on('error', reject);
    });

    const [globalRaw, usRaw] = await Promise.all([
      httpGetSync('https://np-listapi.eastmoney.com/comm/web/getNewsByColumns?client=web&biz=web_news_col&column=350&order=1&needInteractData=0&page_index=1&page_size=10&req_trace=' + Date.now()),
      httpGetSync('https://np-listapi.eastmoney.com/comm/web/getNewsByColumns?client=web&biz=web_news_col&column=353&order=1&needInteractData=0&page_index=1&page_size=8&req_trace=' + Date.now())
    ]);

    const parseItems = (raw) => {
      try {
        const j = JSON.parse(raw);
        return (j.data && j.data.list) ? j.data.list.map(i => ({ title: i.title || '', digest: i.digest || '', time: i.showTime || '' })) : [];
      } catch(e) { return []; }
    };

    const allItems = parseItems(globalRaw).concat(parseItems(usRaw));
    newsData.items = allItems;
    newsData.fetchedAt = new Date().toISOString();

    // 情绪分析
    const posWords = ['利好','上涨','突破','新高','增长','反弹','降息','宽松','牛市','大涨','看涨','bullish','rally','surge','gain'];
    const negWords = ['利空','下跌','暴跌','新低','衰退','加息','紧缩','熊市','大跌','看跌','bearish','crash','plunge','sell-off','risk'];
    let pos = 0, neg = 0, neu = 0, overallScore = 0;
    const themeKeywords = {
      nasdaq: ['nasdaq','ndx','qqq','nvda','microsoft','apple','meta','tesla','nvidia','ai','semiconductor','chip'],
      sp500: ['s&p','sp500','spy','美股','标普','美联储','fed','利率'],
      hongkong: ['港股','恒生','亚太','中国','亚洲','hong kong'],
      oil: ['石油','原油','gold','黄金','能源','oil','commodity']
    };
    const byTheme = {};

    allItems.forEach(item => {
      const text = (item.title + ' ' + (item.digest || '')).toLowerCase();
      let score = 0;
      posWords.forEach(w => { if (text.indexOf(w) >= 0) score++; });
      negWords.forEach(w => { if (text.indexOf(w) >= 0) score--; });
      item._score = score;
      if (score > 0) pos++; else if (score < 0) neg++; else neu++;
      overallScore += score;
      Object.keys(themeKeywords).forEach(theme => {
        themeKeywords[theme].forEach(kw => {
          if (text.indexOf(kw) >= 0) {
            if (!byTheme[theme]) byTheme[theme] = { pos: 0, neg: 0, count: 0 };
            byTheme[theme].count++;
            if (score > 0) byTheme[theme].pos++;
            else if (score < 0) byTheme[theme].neg++;
          }
        });
      });
    });

    newsData.sentiment = {
      overall: allItems.length > 0 ? Math.round(overallScore / allItems.length * 100) : 0,
      positive: pos, negative: neg, neutral: neu,
      byTheme: byTheme
    };

    console.log('[构建] 新闻: ' + allItems.length + '条, 情绪=' + newsData.sentiment.overall);
  } catch(e) {
    console.log('[构建] 新闻获取失败: ' + e.message + ' (使用空数据)');
  }
  template = template.replace('NEWS_DATA', JSON.stringify(newsData));

  // 嵌入今日推荐（从 history.json 取最新记录）
  let todayPicks = { date: null, ranked: [], strategy: null };
  try {
    const historyPath = path.join(__dirname, 'data', 'history.json');
    if (fs.existsSync(historyPath)) {
      const historyData = JSON.parse(fs.readFileSync(historyPath, 'utf-8'));
      const records = historyData.records || historyData;
      if (Array.isArray(records) && records.length > 0) {
        const latest = records[records.length - 1];
        todayPicks = {
          date: latest.date,
          strategy: latest.strategy,
          ranked: (latest.ranked || []).slice(0, 10).map(function(r) {
            return { code: r.code, name: r.name, score: r.score, reason: r.reason ? r.reason.substring(0, 80) : '' };
          })
        };
      }
    }
    console.log('[构建] 今日推荐: ' + todayPicks.ranked.length + '只 (' + (todayPicks.date || '无') + ')');
  } catch(e) {
    console.log('[构建] 今日推荐获取失败: ' + e.message);
  }
  template = template.replace('TODAY_PICKS_DATA', JSON.stringify(todayPicks));

  // 嵌入限购额度（从 fund-info-cache.json + funds.json 合并）
  let purchaseLimits = {};
  try {
    const infoCachePath = path.join(__dirname, 'data', 'fund-info-cache.json');
    if (fs.existsSync(infoCachePath)) {
      const infoCache = JSON.parse(fs.readFileSync(infoCachePath, 'utf-8'));
      Object.keys(infoCache).forEach(function(code) {
        const f = infoCache[code];
        purchaseLimits[code] = {
          limit: f.limit || null,
          status: f.rawStatus || '未知',
          premium: f.premiumRate || 0,
          minPurchase: f.minPurchase || 10
        };
      });
    }
    // 从 funds.json 补充
    (funds.funds || []).forEach(function(f) {
      if (!purchaseLimits[f.code]) {
        purchaseLimits[f.code] = {
          limit: f.dailyLimit || null,
          status: f.status === 'active' ? '开放申购' : '暂停申购',
          premium: 0,
          minPurchase: f.minPurchase || 10
        };
      }
    });
    console.log('[构建] 限购数据: ' + Object.keys(purchaseLimits).length + '只基金');
  } catch(e) {
    console.log('[构建] 限购数据获取失败: ' + e.message);
  }
  template = template.replace('PURCHASE_LIMITS_DATA', JSON.stringify(purchaseLimits));

  // 嵌入交易日历（2026年中国法定节假日）
  const tradingHolidays = [
    '2026-01-01','2026-01-02','2026-01-03', // 元旦
    '2026-02-15','2026-02-16','2026-02-17','2026-02-18','2026-02-19','2026-02-20','2026-02-21', // 春节
    '2026-04-04','2026-04-05','2026-04-06', // 清明
    '2026-05-01','2026-05-02','2026-05-03','2026-05-04','2026-05-05', // 劳动节
    '2026-05-31','2026-06-01','2026-06-02', // 端午
    '2026-10-01','2026-10-02','2026-10-03','2026-10-04','2026-10-05','2026-10-06','2026-10-07' // 国庆
  ];
  template = template.replace('TRADING_HOLIDAYS_DATA', JSON.stringify(tradingHolidays));

  // 写入输出
  fs.writeFileSync(OUTPUT, template, 'utf-8');

  // 复制 nav-cache.json 到 docs/ 供风险仪表盘异步加载完整历史数据
  try {
    fs.mkdirSync(path.join(__dirname, 'docs', 'data'), { recursive: true });
    fs.copyFileSync(NAV_CACHE, path.join(__dirname, 'docs', 'data', 'nav-cache.json'));
    console.log('[构建] 已复制 nav-cache.json 到 docs/data/');
  } catch(e) {
    console.log('[构建] 跳过 nav-cache.json 复制: ' + e.message);
  }

  console.log('[构建] 完成！持仓: ' + portfolio.holdings.length + '只基金, 最新净值: ' + Object.keys(latestNavs).length + '只');
}

build().catch(e => { console.error('[构建] 失败:', e.message); process.exit(1); });
