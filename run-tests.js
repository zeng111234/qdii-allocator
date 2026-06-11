/**
 * 测试运行器
 * 跨平台兼容的测试脚本
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const testDir = path.join(__dirname, 'tests', 'unit');

// 检查测试目录是否存在
if (!fs.existsSync(testDir)) {
  console.log('Test directory not found:', testDir);
  process.exit(0);
}

// 查找所有测试文件
const testFiles = fs.readdirSync(testDir)
  .filter(f => f.endsWith('.test.js'))
  .map(f => path.join(testDir, f));

if (testFiles.length === 0) {
  console.log('No test files found');
  process.exit(0);
}

console.log(`Found ${testFiles.length} test file(s)`);

// 运行测试
try {
  const cmd = `node --test ${testFiles.join(' ')}`;
  console.log(`Running: ${cmd}\n`);
  execSync(cmd, { stdio: 'inherit' });
  process.exit(0);
} catch (e) {
  process.exit(1);
}
