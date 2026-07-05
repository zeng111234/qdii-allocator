/**
 * 统一 LLM 调用客户端
 * [修复] 原问题：callLLM 在 ai-analyst.js 和 daily-brief.js 中重复实现两遍
 *
 * 所有需要调用 LLM 的模块统一引用此文件
 */

const https = require("https");
const http = require("http");

/**
 * 调用 LLM API
 * @param {string} prompt - 用户 prompt
 * @param {Object} config - { apiKey, baseUrl, model, systemPrompt?, temperature?, maxTokens?, timeout? }
 * @returns {Promise<string>} LLM 返回的文本
 */
async function callLLM(prompt, config) {
  const apiKey = config.apiKey;
  const baseUrl = config.baseUrl;
  const model = config.model;
  const systemPrompt = config.systemPrompt || "你是一个专业的QDII基金定投分析师。";
  const temperature = config.temperature !== undefined ? config.temperature : 0.2;
  const maxTokens = config.maxTokens || 6000;
  const timeout = config.timeout || 120000;

  if (!apiKey || !baseUrl || !model) {
    throw new Error("LLM 配置不完整：缺少 apiKey/baseUrl/model");
  }

  const url = new URL(baseUrl);
  const isHTTPS = url.protocol === "https:";
  const lib = isHTTPS ? https : http;

  const body = JSON.stringify({
    model: model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: prompt }
    ],
    temperature: temperature,
    max_tokens: maxTokens
  });

  return new Promise(function(resolve, reject) {
    const req = lib.request({
      hostname: url.hostname,
      port: url.port || (isHTTPS ? 443 : 80),
      path: url.pathname,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api-key": apiKey,
        "Authorization": "Bearer " + apiKey,
        "Content-Length": Buffer.byteLength(body)
      },
      timeout: timeout
    }, function(res) {
      let data = "";
      res.on("data", function(chunk) { data += chunk; });
      res.on("end", function() {
        if (res.statusCode >= 400) {
          let errMsg = "LLM HTTP " + res.statusCode;
          try {
            const errJson = JSON.parse(data);
            if (errJson.error) errMsg += ": " + (errJson.error.message || JSON.stringify(errJson.error));
          } catch(e) {
            errMsg += ": " + data.substring(0, 200);
          }
          reject(new Error(errMsg));
          return;
        }
        try {
          const json = JSON.parse(data);
          if (json.choices && json.choices[0]) {
            const msg = json.choices[0].message;
            const text = msg.content || msg.reasoning_content || "";
            if (text.length > 0) {
              resolve(text.trim());
            } else {
              reject(new Error("LLM returned empty content"));
            }
          } else if (json.error) {
            reject(new Error("LLM API error: " + (json.error.message || JSON.stringify(json.error))));
          } else {
            reject(new Error("Unexpected response: " + data.substring(0, 200)));
          }
        } catch(e) { reject(new Error("Parse error: " + e.message)); }
      });
    });
    req.on("error", reject);
    req.on("timeout", function() { req.destroy(); reject(new Error("LLM timeout (" + timeout + "ms)")); });
    req.write(body);
    req.end();
  });
}

module.exports = { callLLM: callLLM };
