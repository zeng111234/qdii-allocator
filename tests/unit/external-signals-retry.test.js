const test = require("node:test");
const assert = require("node:assert");
const http = require("http");

const externalSignals = require("../../lib/external-signals");

test("external signals stop after the initial request and one retry", async function () {
  let requests = 0;
  const server = http.createServer(function(_req, res) {
    requests++;
    res.writeHead(503, { "Content-Type": "text/plain" });
    res.end("unavailable");
  });
  await new Promise(function(resolve) { server.listen(0, "127.0.0.1", resolve); });
  const baseUrl = "http://127.0.0.1:" + server.address().port;

  try {
    const result = await externalSignals.fetchExternalSignals({
      xMirrorWhitelist: [baseUrl + "/one", baseUrl + "/two", baseUrl + "/three"],
      timeoutMs: 1000,
      maxAttempts: 99
    });
    assert.strictEqual(result.status, "unavailable");
    assert.strictEqual(requests, 2);
    assert.strictEqual(result.attempts.length, 2);
  } finally {
    await new Promise(function(resolve) { server.close(resolve); });
  }
});
