/**
 * 构建 GitHub Pages 页面
 * 把数据嵌入到 HTML 中，不需要 token
 */

const fs = require('fs');
const path = require('path');

const TEMPLATE = path.join(__dirname, 'docs', 'index.html.template');
const OUTPUT = path.join(__dirname, 'docs', 'index.html');
const PORTFOLIO = path.join(__dirname, 'data', 'portfolio.json');
const FUNDS = path.join(__dirname, 'data', 'funds.json');
const NAV_CACHE = path.join(__dirname, 'data', 'nav-cache.json');

function build() {
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
  
  // 嵌入数据
  template = template.replace('PORTFOLIO_DATA', JSON.stringify(portfolio));
  template = template.replace('FUNDS_DATA', JSON.stringify(funds));
  template = template.replace('NAV_CACHE_DATA', JSON.stringify(latestNavs));
  
  // 写入输出
  fs.writeFileSync(OUTPUT, template, 'utf-8');
  
  console.log('[构建] 完成！持仓: ' + portfolio.holdings.length + '只基金, 最新净值: ' + Object.keys(latestNavs).length + '只');
}

build();
