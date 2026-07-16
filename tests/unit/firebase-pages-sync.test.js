const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..", "..");
const template = fs.readFileSync(path.join(ROOT, "docs", "index.html.template"), "utf8");
const builtPage = fs.readFileSync(path.join(ROOT, "docs", "index.html"), "utf8");

test("GitHub Pages can configure Firebase credentials in the browser", function () {
  assert.ok(template.includes("qdii-firebase-config"), "Firebase config should be stored locally in the browser");
  assert.ok(template.includes("function configureFirebase()"), "Firebase configuration flow should exist");
  assert.ok(template.includes("encodeURIComponent(config.token)"), "Firebase token should be URL encoded");
  assert.ok(!template.includes("window.prompt('Firebase 访问令牌/数据库密钥（仅保存在当前浏览器）', current.token)"), "Saved token should not be displayed in a prompt");
  assert.ok(!template.includes("GitHub Pages 版本不支持"), "GitHub Pages should no longer be reported as unsupported");
});

test("Firebase credentials are not embedded in the page template", function () {
  assert.ok(template.includes("FIREBASE_URL_PLACEHOLDER"), "Only the build-time URL placeholder should be present");
  assert.ok(!template.includes("FIREBASE_KEY_PLACEHOLDER"), "A Firebase key placeholder must not be injected at build time");
});

test("generated GitHub Pages output includes browser Firebase sync", function () {
  assert.ok(builtPage.includes("qdii-firebase-config"), "Generated page should include local Firebase configuration");
  assert.ok(!builtPage.includes("GitHub Pages 版本不支持"), "Generated page should not contain the old warning");
});

test("Firebase browser config validates the URL and URL-encodes the token", async function () {
  const start = template.indexOf("var FIREBASE_URL =");
  const end = template.indexOf("function loadNewsSentiment", start);
  const firebaseCode = template.slice(start, end);
  const stored = new Map();
  const prompts = ["https://example-default-rtdb.asia-southeast1.firebasedatabase.app/", "token+/=?"];
  const requests = [];
  const context = {
    URL,
    portfolioData: { holdings: [] },
    localStorage: {
      getItem: key => stored.get(key) || null,
      setItem: (key, value) => stored.set(key, value)
    },
    window: { prompt: () => prompts.shift() },
    showToast: () => {},
    fetch: (url, options) => {
      requests.push({ url, options });
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    }
  };

  vm.runInNewContext(firebaseCode, context);
  assert.strictEqual(context.isValidFirebaseUrl("https://evil.example.com"), false);
  assert.strictEqual(context.configureFirebase(), true);
  await context.firebaseRequest("GET");
  assert.strictEqual(
    requests[0].url,
    "https://example-default-rtdb.asia-southeast1.firebasedatabase.app/portfolio.json?auth=token%2B%2F%3D%3F"
  );
});
