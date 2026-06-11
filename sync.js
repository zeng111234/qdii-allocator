/**
 * 一键同步脚本
 * 把电脑上的持仓/买入/净值数据同步到 GitHub Pages
 * 
 * 使用方法：
 *   node sync.js
 *   npm run sync
 */

const { execSync } = require('child_process');
const path = require('path');

const ROOT = __dirname;

function run(cmd) {
  console.log('[sync] ' + cmd);
  try {
    execSync(cmd, { cwd: ROOT, stdio: 'inherit' });
    return true;
  } catch (e) {
    console.error('[sync] 命令失败: ' + cmd);
    return false;
  }
}

function main() {
  console.log('========================================');
  console.log('  QDII 基金同步工具');
  console.log('========================================');
  console.log('');

  // Step 1: 构建 GitHub Pages
  console.log('[1/3] 构建 GitHub Pages...');
  if (!run('node build-pages.js')) {
    console.error('[错误] 构建失败');
    process.exit(1);
  }
  console.log('');

  // Step 2: Git add & commit
  console.log('[2/3] 提交更改...');
  run('git add data/portfolio.json data/nav-cache.json data/history.json data/fund-info-cache.json data/external-signals-cache.json docs/index.html');
  
  try {
    execSync('git diff --cached --quiet', { cwd: ROOT });
    console.log('[sync] 没有新的更改需要提交');
  } catch (e) {
    // 有更改，提交
    const date = new Date().toISOString().slice(0, 10);
    run('git commit -m "sync: 更新持仓数据 ' + date + '"');
  }
  console.log('');

  // Step 3: Git push
  console.log('[3/3] 推送到 GitHub...');
  if (!run('git push origin main')) {
    console.error('[错误] 推送失败，请检查网络连接');
    process.exit(1);
  }
  console.log('');

  console.log('========================================');
  console.log('  同步完成！');
  console.log('  手机访问: https://zeng111234.github.io/trade/');
  console.log('========================================');
}

main();
