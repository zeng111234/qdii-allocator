/**
 * 每日更新净值缓存脚本 - GitHub Actions 使用
 * [fix] 从 funds.json 读取基金列表（nav-cache.json 已从 git 移除）
 */
const https = require('https');
const fs = require('fs');
const path = require('path');

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

let done = 0, updated = 0, errors = 0;
const startDate = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
const endDate = new Date().toISOString().slice(0, 10);

function fetchNav(code, cb) {
  const url = `https://api.fund.eastmoney.com/f10/lsjz?callback=jQuery&fundCode=${code}&pageIndex=1&pageSize=3&startDate=${startDate}&endDate=${endDate}&_=${Date.now()}`;
  const req = https.get(url, { headers: { 'Referer': 'https://fundf10.eastmoney.com/' }, timeout: 5000 }, function(res) {
    let data = '';
    res.on('data', function(c) { data += c; });
    res.on('end', function() {
      try {
        const matches = data.match(/FSRQ":"(\d{4}-\d{2}-\d{2})".*?DWJZ":"([\d.]+)"/g);
        if (matches) {
          const existing = nav[code] || [];
          const lastDate = existing.length > 0 ? existing[existing.length - 1].date : '';
          matches.forEach(function(m) {
            const dm = m.match(/FSRQ":"(\d{4}-\d{2}-\d{2})".*?DWJZ":"([\d.]+)"/);
            if (dm && dm[1] > lastDate) {
              existing.push({ date: dm[1], nav: parseFloat(dm[2]) });
              updated++;
            }
          });
          existing.sort(function(a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
          nav[code] = existing;
        }
      } catch (e) { errors++; }
      cb();
    });
  });
  req.on('timeout', function() { req.destroy(); errors++; cb(); });
  req.on('error', function() { errors++; cb(); });
}

let idx = 0;
function next() {
  if (idx >= fundCodes.length) {
    fs.writeFileSync(NAV_CACHE_FILE, JSON.stringify(nav, null, 2));
    console.log(`NAV updated: ${updated} new, ${errors} errors, ${fundCodes.length} funds`);
    return;
  }
  fetchNav(fundCodes[idx], function() { idx++; next(); });
}
next();
