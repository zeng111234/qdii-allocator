/**
 * Firebase Realtime Database REST API 客户端
 * 纯 HTTP 调用，无需 Firebase SDK，零额外依赖
 *
 * 使用 Firebase Spark Plan（免费）：
 * - 1GB 存储
 * - 10GB/月 流量
 * - 100次/秒 并发
 *
 * 仅供 CLI/GitHub Actions 服务端使用。浏览器使用 Firebase Web SDK + Google Auth。
 */

const https = require("https");

// Firebase 配置（从环境变量读取）
function getConfig() {
  const url = process.env.FIREBASE_URL;
  const key = process.env.FIREBASE_KEY;
  if (!url || !key) return null;
  const uid = process.env.FIREBASE_UID ? process.env.FIREBASE_UID.trim() : null;
  return { url: url.replace(/\/+$/, ""), key: key, uid: uid || null };
}

function privateLedgerPath() {
  const config = getConfig();
  if (!config || !config.uid) throw new Error("FIREBASE_UID_REQUIRED");
  if (!/^[A-Za-z0-9_-]+$/.test(config.uid)) throw new Error("INVALID_FIREBASE_UID");
  return "/users/" + config.uid + "/portfolioLedger.json";
}

/**
 * 从 Firebase 读取数据
 * @param {string} path - 数据路径（如 "/portfolio.json"）
 * @returns {Promise<Object|null>} 解析后的 JSON 数据，失败返回 null
 */
async function firebaseGet(path) {
  const config = getConfig();
  if (!config) return null;

  const url = config.url + path + "?auth=" + config.key;
  return new Promise(function(resolve) {
    const req = https.get(url, { timeout: 10000 }, function(res) {
      let data = "";
      res.on("data", function(chunk) { data += chunk; });
      res.on("end", function() {
        if (res.statusCode >= 400) {
          console.warn("[firebase] GET " + path + " failed: HTTP " + res.statusCode);
          resolve(null);
          return;
        }
        try {
          resolve(JSON.parse(data));
        } catch(e) {
          console.warn("[firebase] GET " + path + " parse error:", e.message);
          resolve(null);
        }
      });
    });
    req.on("error", function(err) {
      console.warn("[firebase] GET " + path + " error:", err.message);
      resolve(null);
    });
    req.on("timeout", function() {
      req.destroy();
      console.warn("[firebase] GET " + path + " timeout");
      resolve(null);
    });
  });
}

/**
 * 向 Firebase 写入数据（PUT，全量覆盖）
 * @param {string} path - 数据路径
 * @param {Object} data - 要写入的数据
 * @returns {Promise<boolean>} 是否成功
 */
async function firebasePut(path, data) {
  const config = getConfig();
  if (!config) return false;

  const url = config.url + path + "?auth=" + config.key;
  const body = JSON.stringify(data);

  return new Promise(function(resolve) {
    const parsed = new URL(url);
    const req = https.request({
      hostname: parsed.hostname,
      port: 443,
      path: parsed.pathname + parsed.search,
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body)
      },
      timeout: 10000
    }, function(res) {
      res.resume(); // drain response body
      res.on("end", function() {
        if (res.statusCode >= 400) {
          console.warn("[firebase] PUT " + path + " failed: HTTP " + res.statusCode);
          resolve(false);
        } else {
          resolve(true);
        }
      });
    });
    req.on("error", function(err) {
      console.warn("[firebase] PUT " + path + " error:", err.message);
      resolve(false);
    });
    req.on("timeout", function() {
      req.destroy();
      console.warn("[firebase] PUT " + path + " timeout");
      resolve(false);
    });
    req.write(body);
    req.end();
  });
}

/**
 * 从 Firebase 加载持仓数据
 * @returns {Promise<Object|null>} 持仓数据或 null
 */
async function loadPortfolioFromFirebase() {
  return await firebaseGet(privateLedgerPath());
}

/**
 * 将持仓数据保存到 Firebase
 * @param {Object} portfolio - 持仓数据
 * @returns {Promise<boolean>} 是否成功
 */
async function savePortfolioToFirebase(portfolio) {
  return await firebasePut(privateLedgerPath(), portfolio);
}

async function loadPortfolioLedgerFromFirebase() {
  return await firebaseGet(privateLedgerPath());
}

/**
 * 检查 Firebase 是否可用
 * @returns {boolean}
 */
function isFirebaseAvailable() {
  return getConfig() !== null;
}

module.exports = {
  firebaseGet,
  firebasePut,
  privateLedgerPath,
  loadPortfolioLedgerFromFirebase,
  loadPortfolioFromFirebase,
  savePortfolioToFirebase,
  isFirebaseAvailable
};
