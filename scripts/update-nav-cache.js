/**
 * 每日更新净值缓存脚本 - GitHub Actions 使用
 */
const https = require('https');
const fs = require('fs');

const nav = JSON.parse(fs.readFileSync('data/nav-cache.json', 'utf8'));
const codes = Object.keys(nav);
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
  if (idx >= codes.length) {
    fs.writeFileSync('data/nav-cache.json', JSON.stringify(nav, null, 2));
    console.log(`NAV updated: ${updated} new, ${errors} errors, ${codes.length} funds`);
    return;
  }
  fetchNav(codes[idx], function() { idx++; next(); });
}
next();
