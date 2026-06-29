/**
 * 每日更新外部信号脚本 - GitHub Actions 使用
 * 超时保护：最多等 90 秒
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const CACHE_FILE = path.join(DATA_DIR, 'external-signals-cache.json');

// 超时保护
const timeout = setTimeout(function() {
  console.log('External signals timeout after 90s, keeping old data');
  process.exit(0);
}, 90000);

try {
  const es = require(path.join(__dirname, '..', 'lib', 'external-signals'));
  const fundsPath = path.join(DATA_DIR, 'funds.json');
  const funds = JSON.parse(fs.readFileSync(fundsPath, 'utf8'));

  es.fetchExternalSignals(funds.config || {}).then(function(r) {
    clearTimeout(timeout);
    if (r && r.items && r.items.length > 0) {
      fs.writeFileSync(CACHE_FILE, JSON.stringify({data: r}, null, 2));
      console.log('External signals updated: ' + r.items.length + ' items, ' + r.fetchedAt);
    } else {
      console.log('External signals fetch failed, keeping old data');
    }
    process.exit(0);
  }).catch(function(e) {
    clearTimeout(timeout);
    console.error('External signals error:', e.message);
    process.exit(0);
  });
} catch(e) {
  clearTimeout(timeout);
  console.error('External signals module error:', e.message);
  process.exit(0);
}
