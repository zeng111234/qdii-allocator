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

function build() {
  console.log('[构建] 开始构建 GitHub Pages...');
  
  // 读取模板
  let template = fs.readFileSync(TEMPLATE, 'utf-8');
  
  // 读取数据
  const portfolio = JSON.parse(fs.readFileSync(PORTFOLIO, 'utf-8'));
  const funds = JSON.parse(fs.readFileSync(FUNDS, 'utf-8'));
  
  // 嵌入数据
  template = template.replace('PORTFOLIO_DATA', JSON.stringify(portfolio));
  template = template.replace('FUNDS_DATA', JSON.stringify(funds));
  
  // 写入输出
  fs.writeFileSync(OUTPUT, template, 'utf-8');
  
  console.log('[构建] 完成！持仓: ' + portfolio.holdings.length + '只基金');
}

build();
