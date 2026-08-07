/**
 * llm-client.js 核心测试 — 正文为空时不得回退 reasoning_content(思维链)
 */
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { callLLM } = require('../../lib/llm-client');

function startMockServer(responseBody) {
  return new Promise(function (resolve) {
    const server = http.createServer(function (req, res) {
      req.resume();
      req.on('end', function () {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(responseBody));
      });
    });
    server.listen(0, '127.0.0.1', function () {
      resolve(server);
    });
  });
}

function configFor(server) {
  return {
    apiKey: 'test-key',
    baseUrl: 'http://127.0.0.1:' + server.address().port + '/v1/chat/completions',
    model: 'test-model'
  };
}

test('callLLM: content 为空但 reasoning_content 有内容时拒绝, 不得返回思维链', async () => {
  const server = await startMockServer({
    choices: [{ message: { content: '', reasoning_content: '这是模型的思考过程, 不应作为正文' } }]
  });
  try {
    await assert.rejects(
      callLLM('test prompt', configFor(server)),
      /empty content/,
      '正文为空时应 reject'
    );
  } finally {
    server.close();
  }
});

test('callLLM: content 正常时返回正文', async () => {
  const server = await startMockServer({
    choices: [{ message: { content: '今天市场不错，建议定投。', reasoning_content: '思考...' } }]
  });
  try {
    const text = await callLLM('test prompt', configFor(server));
    assert.strictEqual(text, '今天市场不错，建议定投。');
  } finally {
    server.close();
  }
});

test('callLLM: content 为数组格式时拼接文本块', async () => {
  const server = await startMockServer({
    choices: [{ message: { content: [{ type: 'text', text: '第一段' }, { type: 'text', text: '第二段' }] } }]
  });
  try {
    const text = await callLLM('test prompt', configFor(server));
    assert.strictEqual(text, '第一段第二段');
  } finally {
    server.close();
  }
});
