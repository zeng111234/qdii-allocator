/**
 * Design Verification Script
 * 
 * Checks that design improvements were applied correctly.
 * 
 * Usage: node scripts/verify-design.js
 */

const fs = require('fs');
const path = require('path');

console.log('🔍 Verifying design improvements...\n');

const filePath = path.join(__dirname, '..', 'prototype', 'index.html');

if (!fs.existsSync(filePath)) {
  console.error('❌ Optimized file not found:', filePath);
  console.log('   Run: node scripts/optimize-design.js first');
  process.exit(1);
}

const content = fs.readFileSync(filePath, 'utf8');
const checks = [];

// ── Check 1: No AI Slop purple ──
checks.push({
  name: 'No AI Slop purple (#6366f1)',
  pass: !content.includes('#6366f1'),
  detail: content.includes('#6366f1') ? 'Still contains purple color' : 'Purple removed'
});

// ── Check 2: Deep blue primary color ──
checks.push({
  name: 'Deep blue primary (#1a56db)',
  pass: content.includes('#1a56db'),
  detail: content.includes('#1a56db') ? 'Deep blue applied' : 'Deep blue not found'
});

// ── Check 3: No header gradient ──
checks.push({
  name: 'No header gradient',
  pass: !content.includes('linear-gradient(135deg, #6366f1'),
  detail: !content.includes('linear-gradient(135deg, #6366f1') ? 'Gradient removed' : 'Gradient still exists'
});

// ── Check 4: Inter font ──
checks.push({
  name: 'Inter font family',
  pass: content.includes("'Inter'") || content.includes('"Inter"'),
  detail: content.includes('Inter') ? 'Inter font added' : 'Inter font not found'
});

// ── Check 5: Google Fonts import ──
checks.push({
  name: 'Google Fonts import',
  pass: content.includes('fonts.googleapis.com/css2?family=Inter'),
  detail: content.includes('fonts.googleapis.com') ? 'Google Fonts imported' : 'Google Fonts not imported'
});

// ── Check 6: Viewport allows zoom ──
checks.push({
  name: 'Viewport allows zoom',
  pass: !content.includes('user-scalable=no'),
  detail: !content.includes('user-scalable=no') ? 'Zoom allowed' : 'Zoom still disabled'
});

// ── Check 7: Border radius variables ──
checks.push({
  name: 'Layered border radius system',
  pass: content.includes('--radius-xs') && content.includes('--radius-full'),
  detail: content.includes('--radius-xs') ? 'Radius system added' : 'Radius system missing'
});

// ── Check 8: Focus visible styles ──
checks.push({
  name: 'Focus visible styles',
  pass: content.includes('focus-visible'),
  detail: content.includes('focus-visible') ? 'Focus styles added' : 'Focus styles missing'
});

// ── Check 9: Reduced motion support ──
checks.push({
  name: 'Reduced motion support',
  pass: content.includes('prefers-reduced-motion'),
  detail: content.includes('prefers-reduced-motion') ? 'Reduced motion supported' : 'Reduced motion not supported'
});

// ── Check 10: Responsive breakpoints ──
checks.push({
  name: 'Multiple responsive breakpoints',
  pass: content.includes('@media (min-width: 768px)') && content.includes('@media (min-width: 1024px)'),
  detail: (content.includes('@media (min-width: 768px)') ? 'Tablet' : 'No tablet') + ' + ' + 
          (content.includes('@media (min-width: 1024px)') ? 'Desktop' : 'No desktop')
});

// ── Check 11: Tab scroll on mobile ──
checks.push({
  name: 'Tab scroll on mobile',
  pass: content.includes('overflow-x: auto') && content.includes('-webkit-overflow-scrolling: touch'),
  detail: content.includes('overflow-x: auto') ? 'Tab scroll enabled' : 'Tab scroll not enabled'
});

// ── Check 12: CSS animations ──
checks.push({
  name: 'CSS animations',
  pass: content.includes('@keyframes fadeIn') && content.includes('@keyframes slideDown'),
  detail: content.includes('@keyframes fadeIn') ? 'Animations added' : 'Animations missing'
});

// ── Check 13: Emoji removal ──
// Check for common UI emoji patterns (not data content)
const uiEmojiPatterns = [
  '👁️ 显示', '🏆 今日推荐', '📊 今日早报', '☁️ 云同步',
  '⬆️ 上传', '⬇️ 下载', '📤 导出', '📥 导入',
  '🤖 多智能体', '🐂', '🐻', '🛡️', '📊 辩论',
  '🚀 开始辩论', '💡 辩论', '⚙️ API', '💾 保存',
  '🔌 测试', '⚙️ 设置', '🗑️ 清空', '💡 基于',
  '🎯 今天', '🛡️ 组合', '📰 市场', '📊 加减仓',
  '🏆 同类', '⚠️ 风险', '👋 你好', '⚠️ 本工具'
];
const uiEmojisFound = uiEmojiPatterns.filter(pattern => content.includes(pattern));
checks.push({
  name: 'Emojis removed from UI',
  pass: uiEmojisFound.length === 0,
  detail: uiEmojisFound.length > 0 
    ? `Found ${uiEmojisFound.length} UI emojis: ${uiEmojisFound.slice(0, 3).join(', ')}...`
    : 'All UI emojis removed'
});

// ── Print Results ──
console.log('═══════════════════════════════════════════════════════');
console.log('DESIGN VERIFICATION RESULTS');
console.log('═══════════════════════════════════════════════════════\n');

let passed = 0;
let failed = 0;

checks.forEach((check, i) => {
  const status = check.pass ? '✅ PASS' : '❌ FAIL';
  console.log(`${status} ${check.name}`);
  console.log(`     ${check.detail}\n`);
  
  if (check.pass) passed++;
  else failed++;
});

console.log('═══════════════════════════════════════════════════════');
console.log(`TOTAL: ${passed} passed, ${failed} failed`);
console.log('═══════════════════════════════════════════════════════\n');

if (failed === 0) {
  console.log('🎉 All design improvements verified successfully!');
  console.log('');
  console.log('The optimized prototype is ready for testing.');
  console.log('Open: prototype/index.html in your browser');
} else {
  console.log('⚠️  Some checks failed. Review the output above.');
  console.log('You may need to manually fix these issues.');
}

console.log('');
