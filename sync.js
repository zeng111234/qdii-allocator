/**
 * 一键同步脚本
 * 把电脑上的持仓/买入/净值数据同步到 GitHub Pages
 *
 * 使用方法：
 *   node sync.js
 *   npm run sync
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;

// 需要同步的文件列表
// 注意：以下文件在 .gitignore 中被排除，不要添加：
// - data/daily-brief.json (数据缓存)
// - data/external-signals-cache.json (数据缓存)
// - docs/index.html (构建产物，由 CI 构建)
const SYNC_FILES = [
  // 数据文件 (git tracked)
  'data/nav-cache.json',
  'data/history.json',
  'data/funds.json',
  'data/factor-rankings.json',

  // 构建后的数据文件 (git tracked)
  'docs/data/nav-cache.json',
  'docs/data/news.json',
  'docs/data/external-signals-cache.json'
];

function run(cmd) {
  console.log('[sync] ' + cmd);
  try {
    execSync(cmd, { cwd: ROOT, stdio: 'inherit' });
    return true;
  } catch (e) {
    console.error('[sync] 命令失败: ' + cmd);
    console.error('[sync] 错误信息: ' + e.message);
    return false;
  }
}

function checkFiles() {
  console.log('[sync] 检查文件状态...');
  const results = [];

  for (const file of SYNC_FILES) {
    const filePath = path.join(ROOT, file);
    const exists = fs.existsSync(filePath);
    const status = exists ? '✓' : '✗';
    const size = exists ? fs.statSync(filePath).size : 0;
    const sizeStr = exists ? `(${(size / 1024).toFixed(1)}KB)` : '(不存在)';

    results.push({
      file,
      exists,
      size,
      status,
      sizeStr
    });

    console.log(`[sync]   ${status} ${file} ${sizeStr}`);
  }

  return results;
}

function main() {
  console.log('========================================');
  console.log('  QDII 基金同步工具');
  console.log('========================================');
  console.log('');

  // 检查文件状态
  const fileStatus = checkFiles();
  const missingFiles = fileStatus.filter(f => !f.exists).map(f => f.file);

  if (missingFiles.length > 0) {
    console.log('[sync] ⚠️ 以下文件不存在，将跳过同步:');
    missingFiles.forEach(f => console.log(`[sync]   - ${f}`));
    console.log('');
  }

  // Step 1: 构建 GitHub Pages
  console.log('[1/3] 构建 GitHub Pages...');
  if (!run('node build-pages.js')) {
    console.error('[错误] 构建失败');
    process.exit(1);
  }
  console.log('');

  // 重新检查文件状态（构建后可能生成新文件）
  console.log('[sync] 构建完成，重新检查文件状态...');
  const postBuildStatus = checkFiles();
  const postBuildFiles = postBuildStatus.filter(f => f.exists).map(f => f.file);

  // Step 2: Git add & commit
  console.log('[2/3] 提交更改...');

  // 只添加存在的文件
  if (postBuildFiles.length > 0) {
    const addCmd = 'git add ' + postBuildFiles.join(' ');
    if (!run(addCmd)) {
      console.error('[错误] 添加文件失败');
      process.exit(1);
    }
  } else {
    console.log('[sync] 没有文件需要添加');
  }

  try {
    execSync('git diff --cached --quiet', { cwd: ROOT });
    console.log('[sync] 没有新的更改需要提交');
  } catch (e) {
    // 有更改，提交
    const date = new Date().toISOString().slice(0, 10);
    const commitMsg = `sync: 更新持仓数据 ${date}`;

    // 统计更改的文件数量
    try {
      const diffStat = execSync('git diff --cached --stat', { cwd: ROOT, encoding: 'utf-8' });
      const lines = diffStat.split('\n');
      const fileCount = lines.length - 1; // 减去最后一行统计
      console.log(`[sync] 检测到 ${fileCount} 个文件有更改`);
    } catch (e) {
      // 忽略统计错误
    }

    if (!run(`git commit -m "${commitMsg}"`)) {
      console.error('[错误] 提交失败');
      process.exit(1);
    }
    console.log('[sync] ✓ 提交成功: ' + commitMsg);
  }
  console.log('');

  // Step 3: Git push
  console.log('[3/3] 推送到 GitHub...');
  if (!run('git push origin main')) {
    console.error('[错误] 推送失败，请检查网络连接');
    process.exit(1);
  }
  console.log('');

  // 同步结果统计
  console.log('========================================');
  console.log('  同步完成！');
  console.log('========================================');
  console.log('');
  console.log('📊 同步统计:');
  console.log(`  - 检查文件: ${SYNC_FILES.length} 个`);
  console.log(`  - 成功同步: ${postBuildFiles.length} 个`);
  console.log(`  - 跳过文件: ${missingFiles.length} 个`);
  console.log('');
  console.log('🌐 访问地址:');
  console.log('  - GitHub Pages: https://zeng111234.github.io/qdii-allocator/');
  console.log('');
  console.log('📱 手机访问提示:');
  console.log('  - 添加到主屏幕可获得更好的体验');
  console.log('  - 数据每天自动更新（通过 GitHub Actions）');
  console.log('');
}

main();
