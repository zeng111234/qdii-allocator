var express = require("express");
var fs = require("fs");
var path = require("path");
var portfolio = require("./portfolio");

var FUNDS_FILE = path.join(__dirname, "..", "data", "funds.json");

function loadFunds() {
  try {
    if (fs.existsSync(FUNDS_FILE)) {
      return JSON.parse(fs.readFileSync(FUNDS_FILE, "utf-8"));
    }
  } catch(e) {}
  return { config: {}, funds: [] };
}

function buildHtml(fundsList) {
  var fundOptions = fundsList.map(function(f) {
    var limit = f.dailyLimit && f.dailyLimit < 100000 ? ' (限' + f.dailyLimit + ')' : '';
    return '<option value="' + f.code + '">' + f.code + ' ' + f.name + limit + '</option>';
  }).join('');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>QDII Fund Allocator</title>
  <style>
    :root {
      --primary: #6366f1;
      --primary-light: #818cf8;
      --danger: #ef4444;
      --success: #10b981;
      --bg: #f8fafc;
      --card: #ffffff;
      --border: #e2e8f0;
      --text: #1e293b;
      --text-secondary: #64748b;
      --text-muted: #94a3b8;
    }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { 
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; 
      background: var(--bg); 
      color: var(--text); 
      min-height: 100vh;
    }
    .header {
      background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%);
      color: white;
      padding: 24px 20px;
      text-align: center;
    }
    .header h1 { font-size: 20px; font-weight: 600; }
    .header p { font-size: 13px; opacity: 0.9; margin-top: 4px; }
    .container { max-width: 640px; margin: 0 auto; padding: 16px; }
    
    .card { 
      background: var(--card); 
      border-radius: 16px; 
      padding: 20px; 
      margin-bottom: 16px; 
      box-shadow: 0 1px 3px rgba(0,0,0,0.05); 
      border: 1px solid var(--border);
    }
    .card-title { 
      font-size: 14px; 
      font-weight: 600; 
      color: var(--text-secondary); 
      margin-bottom: 16px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    
    .summary-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; }
    .summary-item { 
      padding: 16px; 
      background: linear-gradient(135deg, #f0f4ff 0%, #e8ecf8 100%);
      border-radius: 12px; 
      text-align: center;
    }
    .summary-item .label { font-size: 12px; color: var(--text-muted); margin-bottom: 4px; }
    .summary-item .value { font-size: 22px; font-weight: 700; }
    .summary-item .value.positive { color: var(--danger); }
    .summary-item .value.negative { color: var(--success); }
    .summary-item .value.neutral { color: var(--text); }
    
    .form-row { display: flex; gap: 10px; margin-bottom: 10px; }
    .form-group { flex: 1; }
    .form-group label { 
      display: block; 
      font-size: 12px; 
      font-weight: 500;
      color: var(--text-secondary); 
      margin-bottom: 6px; 
    }
    .form-group select, .form-group input { 
      width: 100%;
      padding: 10px 12px; 
      border: 1.5px solid var(--border); 
      border-radius: 10px; 
      font-size: 14px;
      background: white;
      transition: border-color 0.2s;
    }
    .form-group select:focus, .form-group input:focus { 
      outline: none; 
      border-color: var(--primary);
      box-shadow: 0 0 0 3px rgba(99,102,241,0.1);
    }
    .btn { 
      padding: 10px 20px; 
      border: none; 
      border-radius: 10px; 
      font-size: 14px; 
      font-weight: 500;
      cursor: pointer; 
      transition: all 0.2s; 
    }
    .btn-primary { 
      background: var(--primary); 
      color: white; 
      width: 100%;
    }
    .btn-primary:hover { background: var(--primary-light); }
    .btn-danger-sm { 
      background: #fef2f2; 
      color: var(--danger); 
      font-size: 12px; 
      padding: 6px 12px;
      border: 1px solid #fecaca;
    }
    .btn-danger-sm:hover { background: #fee2e2; }
    
    .holding-card { 
      background: var(--card); 
      border: 1px solid var(--border); 
      border-radius: 12px; 
      padding: 16px; 
      margin-bottom: 12px; 
    }
    .holding-header { 
      display: flex; 
      justify-content: space-between; 
      align-items: flex-start; 
      margin-bottom: 12px; 
    }
    .holding-name { font-weight: 600; font-size: 15px; }
    .holding-code { 
      font-size: 12px; 
      color: var(--text-muted); 
      background: #f1f5f9; 
      padding: 2px 8px; 
      border-radius: 4px; 
      margin-left: 8px; 
    }
    .holding-stats { 
      font-size: 12px; 
      color: var(--text-secondary); 
      display: flex; 
      gap: 12px; 
      flex-wrap: wrap;
      margin-bottom: 12px;
    }
    .holding-stats span { display: flex; align-items: center; gap: 4px; }
    .pnl-box { 
      text-align: right; 
      min-width: 100px; 
    }
    .pnl-amount { 
      font-weight: 700; 
      font-size: 18px; 
    }
    .pnl-rate { 
      font-size: 12px; 
      margin-top: 2px; 
    }
    .pnl-positive { color: var(--danger); }
    .pnl-negative { color: var(--success); }
    .pnl-neutral { color: var(--text-muted); }
    
    .buy-list { 
      background: #f8fafc; 
      border-radius: 8px; 
      padding: 12px; 
      margin-top: 12px; 
    }
    .buy-item { 
      display: flex; 
      justify-content: space-between; 
      align-items: center; 
      padding: 8px 0; 
      border-bottom: 1px solid var(--border); 
      font-size: 13px; 
    }
    .buy-item:last-child { border-bottom: none; }
    .buy-detail { color: var(--text-secondary); }
    .delete-btn { 
      color: var(--danger); 
      cursor: pointer; 
      font-size: 16px; 
      padding: 4px 8px; 
      border-radius: 6px;
      transition: background 0.2s;
    }
    .delete-btn:hover { background: #fef2f2; }
    
    .empty-state { 
      text-align: center; 
      padding: 40px 20px; 
      color: var(--text-muted); 
    }
    .empty-state .icon { font-size: 48px; margin-bottom: 12px; }
    
    .footer { 
      text-align: center; 
      padding: 20px; 
      font-size: 12px; 
      color: var(--text-muted); 
    }
    
    .toast { 
      position: fixed; 
      top: 20px; 
      left: 50%; 
      transform: translateX(-50%); 
      padding: 12px 24px; 
      border-radius: 10px; 
      font-size: 14px; 
      z-index: 1000; 
      opacity: 0; 
      transition: opacity 0.3s; 
      box-shadow: 0 4px 12px rgba(0,0,0,0.15);
    }
    .toast.show { opacity: 1; }
    .toast.success { background: var(--success); color: white; }
    .toast.error { background: var(--danger); color: white; }
    
    @media (max-width: 480px) {
      .form-row { flex-direction: column; }
      .summary-grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div class="header">
    <h1>📊 QDII Fund Allocator</h1>
    <p>智能基金投资管理系统</p>
  </div>

  <div class="container">
    <div class="card">
      <div class="card-title">持仓概览</div>
      <div id="summary" class="summary-grid"></div>
    </div>

    <div class="card">
      <div class="card-title">添加买入</div>
      <div class="form-row">
        <div class="form-group">
          <label>选择基金</label>
          <select id="fundSelect">
            <option value="">-- 请选择 --</option>
            ${fundOptions}
          </select>
        </div>
        <div class="form-group" style="max-width:120px">
          <label>金额(元)</label>
          <input type="number" id="amount" min="1" step="0.01" placeholder="10">
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label>净值 (可选, 留空自动查询)</label>
          <input type="number" id="nav" step="0.0001" placeholder="">
        </div>
        <div class="form-group">
          <label>买入日期 (可选)</label>
          <input type="date" id="buyDate">
        </div>
      </div>
      <button class="btn btn-primary" onclick="addBuy()">确认买入</button>
    </div>

    <div class="card">
      <div class="card-title">
        <span>持仓明细</span>
        <button id="clearAllBtn" class="btn btn-danger-sm" style="display:none" onclick="clearAll()">清空全部</button>
      </div>
      <div id="holdings"></div>
    </div>
  </div>

  <div class="footer">QDII Fund Allocator · 数据仅供参考，投资需谨慎</div>
  <div id="toast" class="toast"></div>

  <script>
    function showToast(text, isError) {
      var el = document.getElementById("toast");
      el.textContent = text;
      el.className = "toast show " + (isError ? "error" : "success");
      setTimeout(function() { el.className = "toast"; }, 3000);
    }

    function addBuy() {
      var code = document.getElementById("fundSelect").value;
      var amount = parseFloat(document.getElementById("amount").value);
      var nav = document.getElementById("nav").value;
      var date = document.getElementById("buyDate").value;

      if (!code || !amount || amount <= 0) {
        showToast("请选择基金并填写有效金额", true);
        return;
      }

      var body = { code: code, amount: amount };
      if (nav) body.nav = parseFloat(nav);
      if (date) body.date = date;

      fetch("/api/buys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      }).then(function(r) { return r.json(); }).then(function(data) {
        if (data.error) {
          showToast(data.error, true);
        } else {
          showToast("已记录: " + data.name + " " + amount + "元");
          document.getElementById("amount").value = "";
          document.getElementById("nav").value = "";
          document.getElementById("buyDate").value = "";
          document.getElementById("fundSelect").value = "";
          loadPortfolio();
        }
      });
    }

    function deleteBuy(code, index) {
      if (!confirm("确认删除这笔买入记录？")) return;
      fetch("/api/buys/" + code + "/" + index, { method: "DELETE" })
        .then(function(r) { return r.json(); })
        .then(function(data) {
          if (data.error) showToast(data.error, true);
          else { showToast("已删除"); loadPortfolio(); }
        });
    }

    function deleteHolding(code, name) {
      if (!confirm("确认删除 " + name + " 的所有买入记录？")) return;
      fetch("/api/buys/" + code, { method: "DELETE" })
        .then(function(r) { return r.json(); })
        .then(function(data) {
          if (data.error) showToast(data.error, true);
          else { showToast("已删除 " + data.name); loadPortfolio(); }
        });
    }

    function clearAll() {
      if (!confirm("确认清空所有持仓记录？")) return;
      fetch("/api/buys-all", { method: "DELETE" })
        .then(function(r) { return r.json(); })
        .then(function() { showToast("已清空所有持仓"); loadPortfolio(); });
    }

    function pnlClass(val) {
      if (val > 0) return "positive";
      if (val < 0) return "negative";
      return "neutral";
    }

    function loadPortfolio() {
      fetch("/api/buys").then(function(r) { return r.json(); }).then(function(data) {
        var sumEl = document.getElementById("summary");
        var clearBtn = document.getElementById("clearAllBtn");
        var holdEl = document.getElementById("holdings");

        if (data.empty) {
          sumEl.innerHTML = '<div class="empty-state" style="grid-column:1/-1"><div class="icon">📭</div><div>暂无持仓记录</div></div>';
          holdEl.innerHTML = '<div class="empty-state"><div class="icon">📝</div><div>添加你的第一笔买入吧</div></div>';
          clearBtn.style.display = "none";
          return;
        }

        clearBtn.style.display = "inline-block";
        var s = data.summary;
        sumEl.innerHTML =
          '<div class="summary-item"><div class="label">总投入</div><div class="value neutral">' + s.totalInvested + '</div></div>' +
          '<div class="summary-item"><div class="label">当前市值</div><div class="value neutral">' + s.totalValue + '</div></div>' +
          '<div class="summary-item"><div class="label">总盈亏</div><div class="value ' + pnlClass(s.totalPnl) + '">' + (s.totalPnl >= 0 ? '+' : '') + s.totalPnl + '</div></div>' +
          '<div class="summary-item"><div class="label">收益率</div><div class="value ' + pnlClass(s.totalPnlRate) + '">' + (s.totalPnlRate >= 0 ? '+' : '') + s.totalPnlRate + '%</div></div>';

        var html = "";
        data.holdings.forEach(function(h) {
          var pnlStr = h.pnl !== null ? (h.pnl >= 0 ? "+" : "") + h.pnl : "待更新";
          var pnlRateStr = h.pnlRate !== null ? (h.pnlRate >= 0 ? "+" : "") + h.pnlRate + "%" : "";
          var pnlCls = h.pnl !== null ? pnlClass(h.pnl) : "neutral";

          html += '<div class="holding-card">';
          html += '<div class="holding-header">';
          html += '<div><span class="holding-name">' + h.name + '</span><span class="holding-code">' + h.code + '</span></div>';
          html += '<div class="pnl-box">';
          html += '<div class="pnl-amount pnl-' + pnlCls + '">' + pnlStr + '</div>';
          html += '<div class="pnl-rate pnl-' + pnlCls + '">' + pnlRateStr + '</div>';
          html += '</div></div>';

          html += '<div class="holding-stats">';
          html += '<span>投入 <b>' + h.totalAmount + '</b></span>';
          html += '<span>持有 <b>' + h.totalShares + '</b>份</span>';
          html += '<span>均价 <b>' + (h.avgCost || '-') + '</b></span>';
          html += '<span>净值 <b>' + (h.latestNav || '-') + '</b></span>';
          html += '</div>';

          html += '<div class="buy-list">';
          h.buyDetails.forEach(function(b, idx) {
            var detail = b.date + ' 买入 ' + b.amount + '元';
            if (b.nav) detail += ' 净值' + b.nav;
            if (b.shares) detail += ' ' + b.shares + '份';
            html += '<div class="buy-item">';
            html += '<span class="buy-detail">' + detail + '</span>';
            html += '<span class="delete-btn" onclick="deleteBuy(\\''+h.code+'\\','+idx+')" title="删除">✕</span>';
            html += '</div>';
          });
          html += '</div>';

          html += '<div style="text-align:right;margin-top:12px">';
          html += '<button class="btn btn-danger-sm" onclick="deleteHolding(\\''+h.code+'\\',\\''+h.name.replace(/'/g,"")+'\\')">删除 ' + h.name.split('(')[0].substring(0,8) + '</button>';
          html += '</div>';

          html += '</div>';
        });
        holdEl.innerHTML = html;
      });
    }

    loadPortfolio();
  </script>
</body>
</html>`;
}

function createApp() {
  var app = express();
  app.use(express.json());

  app.get("/", function(req, res) {
    var data = loadFunds();
    res.type("html").send(buildHtml(data.funds || []));
  });

  app.get("/api/funds", function(req, res) {
    res.json(loadFunds());
  });

  app.get("/api/buys", function(req, res) {
    res.json(portfolio.calcPortfolioSummary());
  });

  app.post("/api/buys", function(req, res) {
    var code = req.body.code;
    var amount = parseFloat(req.body.amount);
    var nav = req.body.nav ? parseFloat(req.body.nav) : null;
    var date = req.body.date || null;

    if (!code || !amount || amount <= 0) {
      return res.json({ error: "请填写基金代码和有效金额" });
    }

    var data = loadFunds();
    var fund = data.funds.find(function(f) { return f.code === code; });
    var name = fund ? fund.name : code;
    var settleDays = fund ? fund.settleDays : 2;

    var holding = portfolio.recordBuy(code, name, amount, nav, date, settleDays);
    if (!holding) {
      return res.json({ error: "记录失败，检查日期格式" });
    }

    res.json({ ok: true, code: code, name: name, amount: amount, nav: nav });
  });

  app.delete("/api/buys/:code/:index", function(req, res) {
    var code = req.params.code;
    var index = parseInt(req.params.index);
    var p = portfolio.loadPortfolio();
    var holding = p.holdings.find(function(h) { return h.code === code; });
    if (!holding) return res.json({ error: "未找到该基金持仓" });
    if (index < 0 || index >= holding.buys.length) return res.json({ error: "无效的记录索引" });

    holding.buys.splice(index, 1);
    if (holding.buys.length === 0) {
      p.holdings = p.holdings.filter(function(h) { return h.code !== code; });
    }
    var allDates = [];
    p.holdings.forEach(function(h) { h.buys.forEach(function(b) { allDates.push(b.date); }); });
    p.startDate = allDates.length > 0 ? allDates.sort()[0] : null;
    portfolio.savePortfolio(p);
    res.json({ ok: true });
  });

  app.delete("/api/buys/:code", function(req, res) {
    var code = req.params.code;
    var p = portfolio.loadPortfolio();
    var target = p.holdings.find(function(h) { return h.code === code; });
    if (!target) return res.json({ error: "未找到该基金持仓" });

    var name = target.name;
    var buyCount = target.buys.length;
    p.holdings = p.holdings.filter(function(h) { return h.code !== code; });
    var allDates = [];
    p.holdings.forEach(function(h) { h.buys.forEach(function(b) { allDates.push(b.date); }); });
    p.startDate = allDates.length > 0 ? allDates.sort()[0] : null;
    portfolio.savePortfolio(p);
    res.json({ ok: true, name: name, buyCount: buyCount });
  });

  app.delete("/api/buys-all", function(req, res) {
    portfolio.savePortfolio({ holdings: [], startDate: null });
    res.json({ ok: true });
  });

  return app;
}

function startWebServer(port) {
  if (!port) port = 3000;
  var app = createApp();
  app.listen(port, function() {
    console.log("========================================");
    console.log("  QDII Fund Allocator - Web UI");
    console.log("  http://localhost:" + port);
    console.log("========================================");
  });
}

module.exports = { startWebServer: startWebServer, createApp: createApp };
