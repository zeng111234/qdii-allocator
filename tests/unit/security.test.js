/**
 * 安全测试 — 只测真实风险：密钥泄露
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
// 不在代码中写真实 token，只检查 atob() 调用和 base64 编码的长字符串
const GITHUB_TOKEN_RE = /gh[pousr]_[A-Za-z0-9_]{20,}/g;
const FIREBASE_KEY_RE = /AIza[0-9A-Za-z_-]{35}/g;
const ATOB_RE = /atob\s*\(\s*['"][A-Za-z0-9+/=]{20,}['"]\s*\)/g;

function scanFile(filePath, regex) {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');
    const findings = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim().startsWith('//') || line.trim().startsWith('*')) continue;
      if (line.includes('PLACEHOLDER')) continue;
      regex.lastIndex = 0;
      const m = regex.exec(line);
      if (m) findings.push({ file: path.relative(ROOT, filePath), line: i + 1, match: m[0].substring(0, 10) + '***' });
    }
    return findings;
  } catch (e) { return []; }
}

// 源代码中不能有 atob() 编码的密钥（之前泄露的 token 就是用 atob 隐藏的）
test('security: no atob() encoded secrets in source', () => {
  const files = ['docs/index.html.template', 'build-pages.js', 'index.js'];
  for (const f of files) {
    const fp = path.join(ROOT, f);
    if (!fs.existsSync(fp)) continue;
    const content = fs.readFileSync(fp, 'utf-8');
    const findings = scanFile(fp, ATOB_RE);
    assert.strictEqual(findings.length, 0,
      `atob() encoded secret found in ${f}`);
  }
});

// 模板文件中不能有真实 Firebase Key
test('security: template has no real Firebase keys', () => {
  const fp = path.join(ROOT, 'docs', 'index.html.template');
  if (!fs.existsSync(fp)) return;
  const findings = scanFile(fp, FIREBASE_KEY_RE);
  assert.strictEqual(findings.length, 0,
    `Real Firebase key in template: ${findings.map(f => f.match).join(', ')}`);
});

// 模板文件中不能有 GitHub Token
test('security: template has no GitHub tokens', () => {
  const fp = path.join(ROOT, 'docs', 'index.html.template');
  if (!fs.existsSync(fp)) return;
  const findings = scanFile(fp, GITHUB_TOKEN_RE);
  assert.strictEqual(findings.length, 0,
    `GitHub token in template: ${findings.map(f => f.match).join(', ')}`);
});

// .env 在 .gitignore 中
test('security: .env is gitignored', () => {
  const gi = path.join(ROOT, '.gitignore');
  assert.ok(fs.existsSync(gi), '.gitignore must exist');
  assert.ok(fs.readFileSync(gi, 'utf-8').includes('.env'), '.env must be in .gitignore');
});
