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

// 加载 .env（不依赖 dotenv 包）+ 环境变量 fallback（CI 中 secrets 通过 env 传入）
function loadEnv() {
  const env = Object.assign({}, process.env);
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    fs.readFileSync(envPath, 'utf-8').split('\n').forEach(line => {
      const m = line.match(/^\s*([\w]+)\s*=\s*(.*?)\s*$/);
      if (m) env[m[1]] = m[2];
    });
  }
  return env;
}

async function build() {
  console.log('[构建] 开始构建 GitHub Pages...');

  // 加载环境变量
  const env = loadEnv();

  // HTTP 工具函数（提取到顶层，供多处使用）
  const httpGetSync = (url) => new Promise((resolve, reject) => {
    https.get(url, { timeout: 8000 }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });

  // 读取模板
  let template = fs.readFileSync(TEMPLATE, 'utf-8');

  // 读取数据（portfolio.json 可能不存在，由 Firebase 同步或 daily-plan 生成）
  let portfolio = { holdings: [], startDate: null };
  if (fs.existsSync(PORTFOLIO)) {
    portfolio = JSON.parse(fs.readFileSync(PORTFOLIO, 'utf-8'));
  } else {
    console.log('[构建] ⚠️ portfolio.json 不存在，使用空持仓');
  }
  const funds = JSON.parse(fs.readFileSync(FUNDS, 'utf-8'));

  // 读取净值缓存，提取每只基金的最新净值（文件可能不存在，由 daily-plan 生成）
  let navCache = {};
  if (fs.existsSync(NAV_CACHE)) {
    navCache = JSON.parse(fs.readFileSync(NAV_CACHE, 'utf-8'));
  } else {
    console.log('[构建] ⚠️ nav-cache.json 不存在，净值数据将为空（由 daily-plan workflow 生成）');
  }
  const latestNavs = {};
  for (const code in navCache) {
    const navs = navCache[code];
    if (navs && navs.length > 0) {
      // 嵌入最近60条净值记录（用于盈亏计算+收益曲线图）
      latestNavs[code] = navs.length >= 60 ? navs.slice(-60) : navs;
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
  // [fix] 用正则替换硬编码的数据变量（占位符已被替换为实际数据）
  template = template.replace(/var portfolioData = \{.*?\};/s, 'var portfolioData = ' + JSON.stringify(portfolio) + ';');
  template = template.replace(/var fundsData = \{.*?\};/s, 'var fundsData = ' + JSON.stringify(funds) + ';');
  template = template.replace(/var navCacheData = \{.*?\};/s, 'var navCacheData = ' + JSON.stringify(latestNavs) + ';');
  template = template.replace(/var dailyBriefData = \{.*?\};/s, 'var dailyBriefData = ' + JSON.stringify(dailyBrief) + ';');
  template = template.replace(/var diaryData = \{.*?\};/s, 'var diaryData = ' + JSON.stringify(diary) + ';');

  // 替换 Firebase 配置（从 .env 读取，不提交到 git）
  if (env.FIREBASE_URL && env.FIREBASE_KEY) {
    template = template.replace('FIREBASE_URL_PLACEHOLDER', env.FIREBASE_URL);
    template = template.replace('FIREBASE_KEY_PLACEHOLDER', env.FIREBASE_KEY);
    console.log('[构建] Firebase 配置已注入');
  } else {
    console.log('[构建] ⚠️ 未找到 .env 中的 Firebase 配置');
  }

  // 抓取新闻数据嵌入（避免前端 CORS 问题）
  let newsData = { items: [], sentiment: null, fetchedAt: null };
  try {
    const [globalRaw, usRaw, hkRaw, futuresRaw, fundRaw] = await Promise.all([
      httpGetSync('https://np-listapi.eastmoney.com/comm/web/getNewsByColumns?client=web&biz=web_news_col&column=350&order=1&needInteractData=0&page_index=1&page_size=10&req_trace=' + Date.now()),
      httpGetSync('https://np-listapi.eastmoney.com/comm/web/getNewsByColumns?client=web&biz=web_news_col&column=353&order=1&needInteractData=0&page_index=1&page_size=8&req_trace=' + Date.now()),
      httpGetSync('https://np-listapi.eastmoney.com/comm/web/getNewsByColumns?client=web&biz=web_news_col&column=351&order=1&needInteractData=0&page_index=1&page_size=8&req_trace=' + Date.now()),
      httpGetSync('https://np-listapi.eastmoney.com/comm/web/getNewsByColumns?client=web&biz=web_news_col&column=354&order=1&needInteractData=0&page_index=1&page_size=5&req_trace=' + Date.now()),
      httpGetSync('https://np-listapi.eastmoney.com/comm/web/getNewsByColumns?client=web&biz=web_news_col&column=356&order=1&needInteractData=0&page_index=1&page_size=5&req_trace=' + Date.now())
    ]);

    const parseItems = (raw, source) => {
      try {
        const j = JSON.parse(raw);
        return (j.data && j.data.list) ? j.data.list.map(i => ({ title: i.title || '', digest: i.digest || '', time: i.showTime || '', url: i.url || i.art_url || '', source: source || '' })) : [];
      } catch(e) { return []; }
    };

    const allItems = parseItems(globalRaw, '环球')
      .concat(parseItems(usRaw, '美股'))
      .concat(parseItems(hkRaw, '港股'))
      .concat(parseItems(futuresRaw, '期货'))
      .concat(parseItems(fundRaw, '基金'));
    newsData.items = allItems;
    newsData.fetchedAt = new Date().toISOString();

    // 情绪分析
    const posWords = ['利好','上涨','突破','新高','增长','反弹','降息','宽松','牛市','大涨','看涨','bullish','rally','surge','gain','创新高','连续上涨','资金流入','超预期','盈利增长','回购','分红'];
    const negWords = ['利空','下跌','暴跌','新低','衰退','加息','紧缩','熊市','大跌','看跌','bearish','crash','plunge','sell-off','risk','关税','制裁','贸易战','地缘','冲突','战争','通胀','违约','爆雷','清盘','暂停申购'];
    let pos = 0, neg = 0, neu = 0, overallScore = 0;
    const themeKeywords = {
      nasdaq: ['nasdaq','ndx','qqq','nvda','microsoft','apple','meta','tesla','nvidia','ai','semiconductor','chip','英伟达','苹果','微软','谷歌','人工智能','半导体','芯片','算力'],
      sp500: ['s&p','sp500','spy','spx','美股','标普','美联储','fed','利率','道琼斯','dow','华尔街','wall street','通胀','cpi','pce','非农'],
      hongkong: ['港股','恒生','亚太','中国','亚洲','hong kong','恒指','国企','科技股','南向资金','北向资金'],
      oil: ['石油','原油','gold','黄金','能源','oil','commodity','大宗商品','opec','天然气','期货','金价','油价'],
      europe: ['欧洲','欧股','dax','德国','英国','ftse','欧洲央行','ecb','欧元','英镑'],
      japan: ['日本','日经','nikkei','日元','日银','boj','日本央行','丰田','索尼'],
      bonds: ['债券','国债','收益率','yield','降息','加息','美债','treasury','10年期'],
      qdii: ['qdii','限购','额度','申购','赎回','净值','基金','定投','份额']
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
  // [fix] 用正则替换硬编码数据（占位符已被替换为实际数据）
  template = template.replace(/var newsData = \{.*?\};/s, 'var newsData = ' + JSON.stringify(newsData) + ';');

  // [fix] 嵌入市场温度数据
  // 从已有历史推荐数据推算（避免CI环境API被封）
  let marketTemperature = { temperature: 50, level: '正常', multiplier: 1.0, reason: '基于历史推荐数据', vix: null, dailyChange: 0, peData: {} };
  try {
    const historyPath = path.join(__dirname, 'data', 'history.json');
    if (fs.existsSync(historyPath)) {
      const histData = JSON.parse(fs.readFileSync(historyPath, 'utf-8'));
      const records = histData.records || [];
      if (records.length > 0) {
        const latest = records[records.length - 1];
        const ranked = latest.ranked || [];
        // 用推荐基金的平均得分推算市场温度
        // 得分高 = 市场好 = 温度高（但不极端）
        if (ranked.length > 0) {
          const avgScore = ranked.reduce(function(s, f) { return s + (f.score || 0); }, 0) / ranked.length;
          // 得分映射到温度：得分10→温度35，得分20→温度50，得分30→温度65
          const temp = Math.max(20, Math.min(80, Math.round(35 + (avgScore - 10) * 1.5)));
          let multiplier, level;
          if (temp <= 20) { multiplier = 1.3; level = '极冷'; }
          else if (temp <= 35) { multiplier = 1.15; level = '偏冷'; }
          else if (temp <= 65) { multiplier = 1.0; level = '正常'; }
          else if (temp <= 80) { multiplier = 0.8; level = '偏热'; }
          else { multiplier = 0.6; level = '极热'; }
          marketTemperature = {
            temperature: temp, level: level, multiplier: multiplier,
            reason: '基于' + latest.date + '推荐数据(均分' + avgScore.toFixed(1) + ')',
            vix: null, dailyChange: 0, peData: {}
          };
          console.log('[构建] 市场温度: ' + temp + '/100 (' + level + ') 均分=' + avgScore.toFixed(1) + ' 倍数=' + multiplier + 'x');
        }
      }
    }
  } catch(e) {
    console.log('[构建] 市场温度计算失败: ' + e.message + ' (使用默认值)');
  }
  template = template.replace('MARKET_TEMPERATURE_DATA', JSON.stringify(marketTemperature));

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
          }),
          allRanked: (latest.ranked || []).map(function(r) {
            return { code: r.code, name: r.name, score: r.score, reason: r.reason ? r.reason.substring(0, 120) : '' };
          })
        };
      }
    }
    console.log('[构建] 今日推荐: ' + todayPicks.ranked.length + '只 (' + (todayPicks.date || '无') + ')');
  } catch(e) {
    console.log('[构建] 今日推荐获取失败: ' + e.message);
  }
  template = template.replace(/var todayPicks = \{.*?\};/s, 'var todayPicks = ' + JSON.stringify(todayPicks) + ';');

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
  template = template.replace(/var purchaseLimits = \{.*?\};/s, 'var purchaseLimits = ' + JSON.stringify(purchaseLimits) + ';');

  // 嵌入外部信号（X/Twitter 大V观点）
  let externalSignals = { items: [], tickerOpinions: [], themeScores: {}, cachedAt: null };
  try {
    const extPath = path.join(__dirname, 'data', 'external-signals-cache.json');
    if (fs.existsSync(extPath)) {
      const extRaw = JSON.parse(fs.readFileSync(extPath, 'utf-8'));
      const ext = extRaw.data || extRaw;
      externalSignals = {
        items: (ext.items || []).slice(0, 10),
        tickerOpinions: ext.tickerOpinions || [],
        themeScores: ext.themeScores || {},
        cachedAt: ext.cachedAt || ext.fetchedAt || extRaw.fetchedAt || null,
        status: ext.status || 'unknown'
      };
    }
    console.log('[构建] 外部信号: ' + externalSignals.items.length + '条, ' + (externalSignals.tickerOpinions || []).length + '个股票观点');
  } catch(e) {
    console.log('[构建] 外部信号获取失败: ' + e.message);
  }
  template = template.replace(/var externalSignalsData = \{.*?\};/s, 'var externalSignalsData = ' + JSON.stringify(externalSignals) + ';');

  // 嵌入假设数据
  let hypotheses = { hypotheses: [], stats: { total: 0, validated: 0, invalidated: 0, expired: 0 } };
  try {
    const hypPath = path.join(__dirname, 'data', 'hypotheses.json');
    if (fs.existsSync(hypPath)) {
      hypotheses = JSON.parse(fs.readFileSync(hypPath, 'utf-8'));
    }
  } catch(e) {}
  template = template.replace(/var hypothesesData = \{.*?\};/s, 'var hypothesesData = ' + JSON.stringify(hypotheses) + ';');

  // 嵌入交易日历（2026年中国法定节假日）
  const tradingHolidays = [
    '2026-01-01','2026-01-02','2026-01-03', // 元旦
    '2026-02-15','2026-02-16','2026-02-17','2026-02-18','2026-02-19','2026-02-20','2026-02-21', // 春节
    '2026-04-04','2026-04-05','2026-04-06', // 清明
    '2026-05-01','2026-05-02','2026-05-03','2026-05-04','2026-05-05', // 劳动节
    '2026-06-19','2026-06-20','2026-06-21', // 端午
    '2026-10-01','2026-10-02','2026-10-03','2026-10-04','2026-10-05','2026-10-06','2026-10-07' // 国庆
  ];
  template = template.replace(/var tradingHolidays = \[.*?\];/s, 'var tradingHolidays = ' + JSON.stringify(tradingHolidays) + ';');

  // 写入输出
  fs.writeFileSync(OUTPUT, template, 'utf-8');

  // 复制数据文件到 docs/data/ 供前端异步加载
  try {
    fs.mkdirSync(path.join(__dirname, 'docs', 'data'), { recursive: true });
    fs.copyFileSync(NAV_CACHE, path.join(__dirname, 'docs', 'data', 'nav-cache.json'));
    // 保存新闻数据到独立文件，前端可通过同源 fetch 加载
    fs.writeFileSync(path.join(__dirname, 'docs', 'data', 'news.json'), JSON.stringify(newsData), 'utf-8');
    console.log('[构建] 已复制 nav-cache.json + news.json 到 docs/data/');
  } catch(e) {
    console.log('[构建] 跳过数据文件复制: ' + e.message);
  }

  console.log('[构建] 完成！持仓: ' + portfolio.holdings.length + '只基金, 最新净值: ' + Object.keys(latestNavs).length + '只');
}

build().catch(e => { console.error('[构建] 失败:', e.message); process.exit(1); });
