/**
 * 安全测试 — 只测真实风险：密钥泄露
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
// 不在代码中写真实 token，只检查 atob() 调用和 base64 编码的长字符串
const GITHUB_TOKEN_RE = /gh[pousr]_[A-Za-z0-9_]{20,}/g;
const FIREBASE_KEY_RE = /AIza[0-9A-Za-z_-]{35}/g;
const ATOB_RE = /atob\s*\(\s*['"][A-Za-z0-9+/=]{20,}['"]\s*\)/g;

function scanFile(filePath, regex) {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const lines = content.split("\n");
    const findings = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim().startsWith("//") || line.trim().startsWith("*")) continue;
      if (line.includes("PLACEHOLDER")) continue;
      regex.lastIndex = 0;
      const m = regex.exec(line);
      if (m) findings.push({ file: path.relative(ROOT, filePath), line: i + 1, match: m[0].substring(0, 10) + "***" });
    }
    return findings;
  } catch (e) {
    return [];
  }
}

// 源代码中不能有 atob() 编码的密钥（之前泄露的 token 就是用 atob 隐藏的）
test("security: no atob() encoded secrets in source", () => {
  const files = ["docs/index.html.template", "build-pages.js", "index.js"];
  for (const f of files) {
    const fp = path.join(ROOT, f);
    if (!fs.existsSync(fp)) continue;
    const _content = fs.readFileSync(fp, "utf-8");
    const findings = scanFile(fp, ATOB_RE);
    assert.strictEqual(findings.length, 0, `atob() encoded secret found in ${f}`);
  }
});

// 模板文件中不能有真实 Firebase Key
test("security: template has no real Firebase keys", () => {
  const fp = path.join(ROOT, "docs", "index.html.template");
  if (!fs.existsSync(fp)) return;
  const findings = scanFile(fp, FIREBASE_KEY_RE);
  assert.strictEqual(findings.length, 0, `Real Firebase key in template: ${findings.map(f => f.match).join(", ")}`);
});

// 模板文件中不能有 GitHub Token
test("security: template has no GitHub tokens", () => {
  const fp = path.join(ROOT, "docs", "index.html.template");
  if (!fs.existsSync(fp)) return;
  const findings = scanFile(fp, GITHUB_TOKEN_RE);
  assert.strictEqual(findings.length, 0, `GitHub token in template: ${findings.map(f => f.match).join(", ")}`);
});

// .env 在 .gitignore 中
test("security: .env is gitignored", () => {
  const gi = path.join(ROOT, ".gitignore");
  assert.ok(fs.existsSync(gi), ".gitignore must exist");
  assert.ok(fs.readFileSync(gi, "utf-8").includes(".env"), ".env must be in .gitignore");
});

// [security] LLM proxy SSRF 白名单测试
test("security: LLM proxy rejects non-whitelisted baseUrl", () => {
  const { LLM_BASE_URL_WHITELIST } = require(path.join(ROOT, "lib", "web-server"));

  // 白名单内的域名应该通过
  const allowedHosts = ["api.siliconflow.cn", "api.openai.com", "api.deepseek.com"];
  for (const host of allowedHosts) {
    assert.ok(
      LLM_BASE_URL_WHITELIST.some(h => h === host || host.endsWith("." + h)),
      `Expected ${host} to be in whitelist`
    );
  }

  // 恶意域名不应在白名单中
  const maliciousHosts = ["evil.com", "internal.corp", "169.254.169.254", "metadata.google.internal"];
  for (const host of maliciousHosts) {
    const isWhitelisted = LLM_BASE_URL_WHITELIST.some(h => h === host || host.endsWith("." + h));
    assert.ok(!isWhitelisted, `Expected ${host} NOT to be in whitelist`);
  }
});

// [security] Web server exports whitelist for testability
test("security: web-server exports LLM_BASE_URL_WHITELIST", () => {
  const mod = require(path.join(ROOT, "lib", "web-server"));
  assert.ok(Array.isArray(mod.LLM_BASE_URL_WHITELIST), "LLM_BASE_URL_WHITELIST should be an array");
  assert.ok(mod.LLM_BASE_URL_WHITELIST.length > 0, "LLM_BASE_URL_WHITELIST should not be empty");
});

// [security] 错误响应不泄露内部信息
test("security: API error messages do not leak internals", () => {
  // 检查 web-server.js 源码中不存在直接暴露 error.message 给客户端的模式
  const webServerPath = path.join(ROOT, "lib", "web-server.js");
  const content = fs.readFileSync(webServerPath, "utf-8");
  const lines = content.split("\n");

  // 搜索 res.status(500).json 中包含 + error.message 的行
  // 允许日志中的 console.error(...error.message)，但不允许返回给客户端
  const leakPattern = /res\.status\(500\)\.json\(.*\+ *error\.message/;
  const leaks = [];
  for (let i = 0; i < lines.length; i++) {
    if (leakPattern.test(lines[i])) {
      leaks.push({ line: i + 1, content: lines[i].trim().substring(0, 80) });
    }
  }
  assert.strictEqual(
    leaks.length,
    0,
    `Found ${leaks.length} lines that leak error.message to client: ${JSON.stringify(leaks)}`
  );
});

// [security] 健康检查端点存在
test("security: health endpoint is defined", () => {
  const webServerPath = path.join(ROOT, "lib", "web-server.js");
  const content = fs.readFileSync(webServerPath, "utf-8");
  assert.ok(content.includes('"/health"'), "health endpoint should be defined");
  assert.ok(
    content.includes('status: "ok"') || content.includes('"status": "ok"'),
    "health endpoint should return ok status"
  );
});
