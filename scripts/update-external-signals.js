/**
 * 每日更新外部信号脚本 - GitHub Actions 使用
 */
const fs = require('fs');
const es = require('./lib/external-signals');
const funds = JSON.parse(fs.readFileSync('data/funds.json', 'utf8'));

es.fetchExternalSignals(funds.config || {}).then(function(r) {
  if (r && r.items && r.items.length > 0) {
    fs.writeFileSync('data/external-signals-cache.json', JSON.stringify({data: r}, null, 2));
    console.log('External signals updated: ' + r.items.length + ' items, ' + r.fetchedAt);
  } else {
    console.log('External signals fetch failed, keeping old data');
  }
}).catch(function(e) {
  console.error('External signals error:', e.message);
});
