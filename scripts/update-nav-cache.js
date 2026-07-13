/**
 * 每日更新净值缓存脚本 - GitHub Actions 使用
 * [fix] 从 funds.json 读取基金列表（nav-cache.json 已从 git 移除）
 * [fix] 数据不足的基金自动分页拉取更多历史（至少60条用于评分）
 */
const https = require('https');
const fs = require('fs');
const path = require('path');

// 超时保护：最多运行8分钟
const TIMEOUT_MS = 8 * 60 * 1000;
const startTime = Date.now();
function isTimedOut() { return Date.now() - startTime > TIMEOUT_MS; }

const FUNDS_FILE = path.join(__dirname, '..', 'data', 'funds.json');
const NAV_CACHE_FILE = path.join(__dirname, '..', 'data', 'nav-cache.json');

// 从 funds.json 读取基金代码
const fundsData = JSON.parse(fs.readFileSync(FUNDS_FILE, 'utf8'));
const fundCodes = fundsData.funds.map(function(f) { return f.code; });

// 加载已有缓存（可能不存在）
let nav = {};
if (fs.existsSync(NAV_CACHE_FILE)) {
  try { nav = JSON.parse(fs.readFileSync(NAV_CACHE_FILE, 'utf8')); } catch(e) {}
}

let updated = 0, errors = 0;

function fetchPage(code, startDate, pageSize, pageIndex) {
  return new Promise(function(resolve) {
    const endDate = new Date().toISOString().slice(0, 10);
    const url = `https://api.fund.eastmoney.com/f10/lsjz?callback=jQuery&fundCode=${code}&pageIndex=${pageIndex}&pageSize=${pageSize}&startDate=${startDate}&endDate=${endDate}&_=${Date.now()}`;
    const req = https.get(url, { headers: { 'Referer': 'https://fundf10.eastmoney.com/' }, timeout: 10000 }, function(res) {
      let data = '';
      res.on('data', function(c) { data += c; });
      res.on('end', function() {
        try {
          const matches = data.match(/FSRQ":"(\d{4}-\d{2}-\d{2})".*?DWJZ":"([\d.]+)"/g);
          if (matches) {
            const records = [];
            matches.forEach(function(m) {
              const dm = m.match(/FSRQ":"(\d{4}-\d{2}-\d{2})".*?DWJZ":"([\d.]+)"/);
              if (dm) records.push({ date: dm[1], nav: parseFloat(dm[2]) });
            });
            resolve(records);
          } else {
            resolve([]);
          }
        } catch (e) { errors++; resolve([]); }
      });
    });
    req.on('timeout', function() { req.destroy(); errors++; resolve([]); });
    req.on('error', function() { errors++; resolve([]); });
  });
}

async function fetchFundHistory(code, targetCount) {
  const startDate = new Date(Date.now() - 730 * 86400000).toISOString().slice(0, 10);
  const pageSize = 20; // API硬限制
  const maxPages = Math.ceil(targetCount / pageSize) + 2; // 多拉几页确保够
  const existing = nav[code] || [];
  const existingDates = new Set(existing.map(function(r) { return r.date; }));
  const newRecords = [];

  for (let page = 1; page <= maxPages; page++) {
    const records = await fetchPage(code, startDate, pageSize, page);
    if (records.length === 0) break; // 没有更多数据

    for (let i = 0; i < records.length; i++) {
      if (!existingDates.has(records[i].date)) {
        newRecords.push(records[i]);
        existingDates.add(records[i].date);
      }
    }

    if (records.length < pageSize) break; // 最后一页
    // 避免API限流
    await new Promise(function(r) { setTimeout(r, 300); });
  }

  if (newRecords.length > 0) {
    const merged = existing.concat(newRecords).sort(function(a, b) {
      return a.date < b.date ? -1 : a.date > b.date ? 1 : 0;
    });
    nav[code] = merged;
    updated += newRecords.length;
  }

  return (nav[code] || []).length;
}

async function main() {
  console.log('Start: ' + fundCodes.length + ' funds, timeout=' + (TIMEOUT_MS/1000) + 's');

  for (let i = 0; i < fundCodes.length; i++) {
    if (isTimedOut()) {
      console.log('⏰ Timeout at fund ' + (i+1) + '/' + fundCodes.length + ', saving partial results');
      break;
    }

    const code = fundCodes[i];
    const existingCount = (nav[code] || []).length;

    if (existingCount < 60) {
      // [fix] 数据不足60条，分页拉取2年历史
      console.log('[' + (i+1) + '/' + fundCodes.length + '] ' + code + ': fetching history (' + existingCount + ' existing)...');
      const count = await fetchFundHistory(code, 60);
      if (count < 60) {
        console.log('  ⚠️ ' + code + ': 只有' + count + '条数据(需要>=60)');
      } else {
        console.log('  ✅ ' + code + ': ' + count + '条');
      }
    } else {
      // 已有足够数据，只拉最近1页更新
      const records = await fetchCode(code, 7);
      const existing = nav[code] || [];
      const existingDates = new Set(existing.map(function(r) { return r.date; }));
      let newCount = 0;
      for (let j = 0; j < records.length; j++) {
        if (!existingDates.has(records[j].date)) {
          existing.push(records[j]);
          newCount++;
        }
      }
      if (newCount > 0) {
        existing.sort(function(a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
        nav[code] = existing;
        updated += newCount;
      }
    }
  }

  fs.writeFileSync(NAV_CACHE_FILE, JSON.stringify(nav, null, 2));
  console.log('NAV updated: ' + updated + ' new, ' + errors + ' errors, ' + fundCodes.length + ' funds');
}

async function fetchCode(code, days) {
  const startDate = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  return await fetchPage(code, startDate, 20, 1);
}

main().catch(function(e) {
  console.error('Error:', e.message);
  process.exit(1);
});
