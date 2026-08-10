const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const TEST_PORTFOLIO_FILE = path.join(os.tmpdir(), "trade-web-portfolio-" + process.pid + ".json");
process.env.PORTFOLIO_FILE = TEST_PORTFOLIO_FILE;
const webServer = require("../../lib/web-server");

test.after(function() {
  if (fs.existsSync(TEST_PORTFOLIO_FILE)) fs.unlinkSync(TEST_PORTFOLIO_FILE);
});

async function withServer(fn) {
  const app = webServer.createApp({ authToken: "test-local-token", port: 0 });
  const server = await new Promise(function(resolve) {
    const instance = app.listen(0, "127.0.0.1", function() { resolve(instance); });
  });
  const baseUrl = "http://127.0.0.1:" + server.address().port;
  try {
    await fn(baseUrl);
  } finally {
    await new Promise(function(resolve) { server.close(resolve); });
  }
}

test("web UI and portfolio reads require login", async function () {
  await withServer(async function(baseUrl) {
    const page = await fetch(baseUrl + "/", { redirect: "manual" });
    assert.strictEqual(page.status, 302);
    assert.strictEqual(page.headers.get("location"), "/login");

    const api = await fetch(baseUrl + "/api/buys");
    assert.strictEqual(api.status, 401);
  });
});

test("login cookie authorizes page reads and write requests", async function () {
  await withServer(async function(baseUrl) {
    const login = await fetch(baseUrl + "/login", {
      method: "POST",
      redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "token=" + encodeURIComponent("test-local-token")
    });
    assert.strictEqual(login.status, 303);
    const setCookie = login.headers.get("set-cookie");
    assert.match(setCookie, /trade_session=/);
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /SameSite=Strict/i);
    const cookie = setCookie.split(";", 1)[0];

    const page = await fetch(baseUrl + "/", { headers: { Cookie: cookie } });
    assert.strictEqual(page.status, 200);

    const write = await fetch(baseUrl + "/api/buys", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ code: "270042", amount: 10, nav: 1, date: "2026-08-10" })
    });
    assert.strictEqual(write.status, 200, "已登录写请求应成功进入业务处理");

    const summary = await fetch(baseUrl + "/api/buys", { headers: { Cookie: cookie } });
    const summaryBody = await summary.json();
    assert.strictEqual(summary.status, 200);
    assert.strictEqual(summaryBody.summary.holdingCount, 1);

    const clear = await fetch(baseUrl + "/api/buys-all", { method: "DELETE", headers: { Cookie: cookie } });
    assert.strictEqual(clear.status, 200);
  });
});

test("health endpoint exposes no portfolio details", async function () {
  await withServer(async function(baseUrl) {
    const response = await fetch(baseUrl + "/health");
    assert.strictEqual(response.status, 200);
    const body = await response.json();
    assert.strictEqual(body.status, "ok");
    assert.ok(!Object.prototype.hasOwnProperty.call(body, "holdings"));
  });
});
