/**
 * Design Optimization Script for QDII Fund Allocator
 * 
 * This script applies design improvements to the original docs/index.html
 * while preserving all functionality.
 * 
 * Usage: node scripts/optimize-design.js
 */

const fs = require('fs');
const path = require('path');

console.log('🎨 Starting design optimization...\n');

// 1. Read original file
const originalPath = path.join(__dirname, '..', 'docs', 'index.html');
const prototypePath = path.join(__dirname, '..', 'prototype', 'index.html.template');

if (!fs.existsSync(originalPath)) {
  console.error('❌ Original file not found:', originalPath);
  process.exit(1);
}

console.log('📄 Reading original file...');
const originalContent = fs.readFileSync(originalPath, 'utf8');
console.log(`   Original size: ${(originalContent.length / 1024).toFixed(1)} KB\n`);

// 2. Define replacements
const replacements = [
  // ── Color System ──
  {
    name: 'Primary color (Indigo → Deep Blue)',
    find: /--primary:\s*#6366f1/g,
    replace: '--primary: #1a56db'
  },
  {
    name: 'Primary light color',
    find: /--primary-light:\s*#818cf8/g,
    replace: '--primary-light: #3b82f6'
  },
  {
    name: 'Primary RGB',
    find: /--primary-rgb:\s*99,\s*102,\s*241/g,
    replace: '--primary-rgb: 26, 86, 219'
  },
  {
    name: 'Header gradient (remove AI Slop)',
    find: /background:\s*linear-gradient\(135deg,\s*#6366f1\s*0%,\s*#8b5cf6\s*100%\)/g,
    replace: 'background: #0f172a'
  },
  
  // ── Font System ──
  {
    name: 'Font family (add Inter)',
    find: /font-family:\s*-apple-system,\s*BlinkMacSystemFont,\s*"Segoe UI",\s*Roboto,\s*sans-serif/g,
    replace: "font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
  },
  
  // ── Viewport (remove user-scalable=no) ──
  {
    name: 'Viewport (allow zoom)',
    find: /<meta name="viewport" content="width=device-width,\s*initial-scale=1\.0,\s*maximum-scale=1\.0,\s*user-scalable=no">/g,
    replace: '<meta name="viewport" content="width=device-width, initial-scale=1.0">'
  },
  
  // ── Border Radius System ──
  {
    name: 'Border radius variable',
    find: /--radius:\s*8px/g,
    replace: '--radius: 8px;\n      --radius-xs: 4px;\n      --radius-sm: 6px;\n      --radius-md: 8px;\n      --radius-lg: 12px;\n      --radius-xl: 16px;\n      --radius-full: 9999px'
  },
  
  // ── Emoji Replacements ──
  {
    name: 'Privacy button emoji',
    find: /👁️ 显示/g,
    replace: '显示'
  },
  {
    name: 'Top5 picks emoji',
    find: /🏆 今日推荐 Top5/g,
    replace: '今日推荐 Top5'
  },
  {
    name: 'Daily brief emoji',
    find: /📊 今日早报/g,
    replace: '今日早报'
  },
  {
    name: 'Cloud sync emoji',
    find: /☁️ 云同步/g,
    replace: '云同步'
  },
  {
    name: 'Upload button emoji',
    find: /⬆️ 上传/g,
    replace: '上传'
  },
  {
    name: 'Download button emoji',
    find: /⬇️ 下载/g,
    replace: '下载'
  },
  {
    name: 'Export button emoji',
    find: /📤 导出/g,
    replace: '导出'
  },
  {
    name: 'Import button emoji',
    find: /📥 导入/g,
    replace: '导入'
  },
  {
    name: 'AI debate emoji',
    find: /🤖 多智能体辩论/g,
    replace: '多智能体辩论'
  },
  {
    name: 'Bull emoji',
    find: /🐂<\/div>/g,
    replace: 'B</div>'
  },
  {
    name: 'Bear emoji',
    find: /🐻<\/div>/g,
    replace: 'R</div>'
  },
  {
    name: 'Shield emoji',
    find: /🛡️<\/span>/g,
    replace: 'R</span>'
  },
  {
    name: 'Debate result emoji',
    find: /📊 辩论结果/g,
    replace: '辩论结果'
  },
  {
    name: 'Start debate emoji',
    find: /🚀 开始辩论分析/g,
    replace: '开始辩论分析'
  },
  {
    name: 'Debate tip emoji',
    find: /💡 辩论分析基于/g,
    replace: '辩论分析基于'
  },
  {
    name: 'API config emoji',
    find: /⚙️ API 配置/g,
    replace: 'API 配置'
  },
  {
    name: 'Save button emoji',
    find: /💾 保存/g,
    replace: '保存'
  },
  {
    name: 'Test button emoji',
    find: /🔌 测试/g,
    replace: '测试'
  },
  {
    name: 'Settings button emoji',
    find: /⚙️ 设置/g,
    replace: '设置'
  },
  {
    name: 'Clear button emoji',
    find: /🗑️ 清空/g,
    replace: '清空'
  },
  {
    name: 'AI tip emoji',
    find: /💡 基于你的持仓/g,
    replace: '基于你的持仓'
  },
  {
    name: 'Quick question emojis',
    find: /🎯 今天该买什么/g,
    replace: '今天该买什么'
  },
  {
    name: 'Risk quick question emoji',
    find: /🛡️ 组合风险/g,
    replace: '组合风险'
  },
  {
    name: 'Market sentiment emoji',
    find: /📰 市场情绪/g,
    replace: '市场情绪'
  },
  {
    name: 'Position adjustment emoji',
    find: /📊 加减仓/g,
    replace: '加减仓'
  },
  {
    name: 'Comparison emoji',
    find: /🏆 同类对比/g,
    replace: '同类对比'
  },
  {
    name: 'Risk hedge emoji',
    find: /⚠️ 风险对冲/g,
    replace: '风险对冲'
  },
  {
    name: 'AI welcome emoji',
    find: /👋 你好！/g,
    replace: '你好！'
  },
  {
    name: 'Disclaimer emoji',
    find: /⚠️ 本工具仅供参考/g,
    replace: '本工具仅供参考'
  },
  
  // ── Shadow System ──
  {
    name: 'Shadow variable',
    find: /--shadow:\s*0 1px 3px rgba\(0,0,0,0\.1\)/g,
    replace: '--shadow: 0 1px 3px rgba(0, 0, 0, 0.08), 0 1px 2px rgba(0, 0, 0, 0.04)'
  },
  {
    name: 'Shadow hover variable',
    find: /--shadow-hover:\s*0 4px 12px rgba\(0,0,0,0\.15\)/g,
    replace: '--shadow-hover: 0 4px 6px -1px rgba(0, 0, 0, 0.08), 0 2px 4px -2px rgba(0, 0, 0, 0.04)'
  },
  
  // ── JavaScript Purple Color Fixes ──
  {
    name: 'Chart label background color',
    find: /labelBackgroundColor:\s*'#6366f1'/g,
    replace: "labelBackgroundColor: '#1a56db'"
  },
  {
    name: 'News source color (环球)',
    find: /'环球':'#6366f1'/g,
    replace: "'环球':'#1a56db'"
  },
  {
    name: 'News source color (基金)',
    find: /'基金':'#8b5cf6'/g,
    replace: "'基金':'#3b82f6'"
  },
  
  // ── JavaScript Emoji Fixes ──
  {
    name: 'System capabilities emoji',
    find: /📊 智能评分 · 🧪 假设引擎 · 📈 走步回测 · 🛡️ 反幻觉检查/g,
    replace: '智能评分 · 假设引擎 · 走步回测 · 反幻觉检查'
  },
  {
    name: 'Factor engine emoji (分散度)',
    find: /'🛡️ 分散度'/g,
    replace: "'分散度'"
  },
  {
    name: 'Risk assessment emoji',
    find: /🛡️ 三方风险评估/g,
    replace: '三方风险评估'
  }
];

// 3. Apply replacements
console.log('🔄 Applying design improvements...\n');
let optimizedContent = originalContent;
let appliedCount = 0;

replacements.forEach(({ name, find, replace }) => {
  const matches = optimizedContent.match(find);
  if (matches) {
    optimizedContent = optimizedContent.replace(find, replace);
    appliedCount++;
    console.log(`   ✅ ${name} (${matches.length} occurrences)`);
  }
});

console.log(`\n   Applied ${appliedCount} improvements\n`);

// 4. Add Google Fonts import
console.log('📝 Adding Google Fonts import...');
const fontsImport = `
  <!-- Google Fonts: Inter for professional typography -->
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
`;

optimizedContent = optimizedContent.replace(
  '<title>',
  fontsImport + '\n  <title>'
);

// 5. Add CSS animations
console.log('✨ Adding CSS animations...');
const animations = `
    /* ── Animations ── */
    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(4px); }
      to { opacity: 1; transform: translateY(0); }
    }
    
    @keyframes slideDown {
      from { opacity: 0; max-height: 0; }
      to { opacity: 1; max-height: 500px; }
    }
    
    .tab-content.active {
      animation: fadeIn 0.2s ease-out;
    }
    
    .detail {
      animation: slideDown 0.2s ease-out;
    }
    
    /* ── Focus Visible ── */
    *:focus-visible {
      outline: 2px solid var(--primary);
      outline-offset: 2px;
      border-radius: var(--radius-sm, 6px);
    }
    
    /* ── Reduced Motion ── */
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after {
        animation-duration: 0.01ms !important;
        animation-iteration-count: 1 !important;
        transition-duration: 0.01ms !important;
      }
    }
`;

optimizedContent = optimizedContent.replace(
  '</style>',
  animations + '\n  </style>'
);

// 6. Add responsive breakpoints
console.log('📱 Adding responsive breakpoints...');
const responsive = `
    /* ── Responsive: Tablet ── */
    @media (min-width: 768px) {
      .container { max-width: 720px; padding: 24px; }
      .summary-grid { grid-template-columns: repeat(6, 1fr); }
      .risk-summary-grid { grid-template-columns: repeat(4, 1fr); }
      .tabs { flex-wrap: nowrap; }
      .tab { flex: 1; }
    }
    
    /* ── Responsive: Desktop ── */
    @media (min-width: 1024px) {
      .container { max-width: 960px; padding: 32px; }
      .header { padding: 32px 24px 28px; }
      .card { padding: 24px; }
    }
    
    /* ── Responsive: Mobile Tabs ── */
    @media (max-width: 640px) {
      .tabs {
        overflow-x: auto;
        -webkit-overflow-scrolling: touch;
        scrollbar-width: none;
        -ms-overflow-style: none;
      }
      .tabs::-webkit-scrollbar { display: none; }
      .tab { flex: 0 0 auto; min-width: 64px; }
    }
`;

optimizedContent = optimizedContent.replace(
  '@media (max-width: 480px)',
  responsive + '\n    @media (max-width: 480px)'
);

// 7. Write optimized file
console.log('\n💾 Writing optimized file...');
const outputDir = path.join(__dirname, '..', 'prototype');
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

const outputPath = path.join(outputDir, 'index.html');
fs.writeFileSync(outputPath, optimizedContent, 'utf8');

const outputSize = fs.statSync(outputPath).size;
console.log(`   Output: ${outputPath}`);
console.log(`   Size: ${(outputSize / 1024).toFixed(1)} KB\n`);

// 8. Summary
console.log('═══════════════════════════════════════════════════════');
console.log('✅ Design optimization complete!');
console.log('═══════════════════════════════════════════════════════');
console.log('');
console.log('Improvements applied:');
console.log('  • Color system: Deep blue palette (no AI Slop purple)');
console.log('  • Font system: Inter with system fallbacks');
console.log('  • Viewport: Allow user zoom (accessibility)');
console.log('  • Border radius: Layered system (4/6/8/12/16/9999px)');
console.log('  • Emojis: Replaced with text labels');
console.log('  • Shadows: Refined depth hierarchy');
console.log('  • Animations: Fade-in, slide-down');
console.log('  • Focus: Visible focus states');
console.log('  • Responsive: 3 breakpoints (mobile/tablet/desktop)');
console.log('');
console.log('Next steps:');
console.log('  1. Open prototype/index.html in browser');
console.log('  2. Test all interactions');
console.log('  3. Verify responsive behavior');
console.log('  4. Compare with original design');
console.log('');
