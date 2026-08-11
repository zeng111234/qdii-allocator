const crypto = require("crypto");

const SCHEMA_VERSION = 2;

function round(value, digits) {
  const factor = Math.pow(10, digits || 8);
  return Math.round((Number(value) || 0) * factor) / factor;
}

function canonicalTransaction(transaction) {
  const tx = transaction || {};
  return {
    id: String(tx.id || ""),
    type: String(tx.type || "BUY").toUpperCase(),
    code: String(tx.code || ""),
    tradeDate: String(tx.tradeDate || tx.date || ""),
    settleDate: tx.settleDate ? String(tx.settleDate) : null,
    amount: round(tx.amount, 8),
    nav: round(tx.nav, 8),
    shares: round(tx.shares, 8),
    createdAt: String(tx.createdAt || ((tx.tradeDate || tx.date || "") + "T00:00:00.000Z"))
  };
}

function transactionFingerprint(transaction) {
  const tx = canonicalTransaction(transaction);
  return [tx.type, tx.code, tx.tradeDate, tx.settleDate || "", tx.amount, tx.nav, tx.shares].join("|");
}

function stableTransactionId(transaction, occurrence) {
  return "tx_" + crypto.createHash("sha256")
    .update(transactionFingerprint(transaction) + "|" + Number(occurrence || 0))
    .digest("hex").slice(0, 24);
}

function checksumTransactions(transactions) {
  const canonical = (transactions || []).map(canonicalTransaction).sort(function (left, right) {
    return left.id.localeCompare(right.id);
  });
  return crypto.createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function createLedger(transactions, options) {
  const settings = options || {};
  const normalized = (transactions || []).map(canonicalTransaction).sort(function (left, right) {
    return left.tradeDate.localeCompare(right.tradeDate) || left.id.localeCompare(right.id);
  });
  const ids = new Set();
  normalized.forEach(function (tx) {
    if (!tx.id || !tx.code || !tx.tradeDate || !Number.isFinite(tx.amount) || !Number.isFinite(tx.shares)) {
      throw new Error("INVALID_TRANSACTION");
    }
    if (ids.has(tx.id)) throw new Error("DUPLICATE_TRANSACTION:" + tx.id);
    ids.add(tx.id);
  });
  return {
    schemaVersion: SCHEMA_VERSION,
    revision: Number(settings.revision || 1),
    updatedAt: String(settings.updatedAt || new Date().toISOString()),
    checksum: checksumTransactions(normalized),
    transactions: normalized
  };
}

function migrateLegacyPortfolio(portfolio, options) {
  const occurrences = new Map();
  const transactions = [];
  ((portfolio && portfolio.holdings) || []).forEach(function (holding) {
    (holding.buys || []).forEach(function (buy) {
      const draft = canonicalTransaction({
        type: "BUY",
        code: holding.code,
        tradeDate: buy.tradeDate || buy.date,
        settleDate: buy.settleDate,
        amount: buy.amount,
        nav: buy.nav,
        shares: buy.shares,
        createdAt: buy.createdAt
      });
      const fingerprint = transactionFingerprint(draft);
      const occurrence = occurrences.get(fingerprint) || 0;
      occurrences.set(fingerprint, occurrence + 1);
      draft.id = stableTransactionId(draft, occurrence);
      transactions.push(draft);
    });
  });
  return createLedger(transactions, options);
}

function validateLedger(ledger) {
  const errors = [];
  if (!ledger || Number(ledger.schemaVersion) !== SCHEMA_VERSION) errors.push("SCHEMA_VERSION");
  if (!ledger || !Number.isInteger(Number(ledger.revision)) || Number(ledger.revision) < 1) errors.push("REVISION");
  const transactions = (ledger && ledger.transactions) || [];
  const ids = new Set();
  transactions.forEach(function (tx) {
    const normalized = canonicalTransaction(tx);
    if (!normalized.id || !normalized.code || !normalized.tradeDate) errors.push("INVALID_TRANSACTION");
    if (ids.has(normalized.id)) errors.push("DUPLICATE_TRANSACTION:" + normalized.id);
    ids.add(normalized.id);
  });
  if (ledger && ledger.checksum !== checksumTransactions(transactions)) errors.push("CHECKSUM_MISMATCH");
  return { valid: errors.length === 0, errors: Array.from(new Set(errors)) };
}

function derivePortfolio(ledger) {
  const validation = validateLedger(ledger);
  if (!validation.valid) throw new Error("INVALID_LEDGER:" + validation.errors.join(","));
  const holdingsByCode = {};
  let totalInvested = 0;
  ledger.transactions.forEach(function (tx) {
    if (!holdingsByCode[tx.code]) holdingsByCode[tx.code] = {
      code: tx.code, buys: [], totalAmount: 0, totalShares: 0, pendingBuys: [], pendingAmount: 0
    };
    const holding = holdingsByCode[tx.code];
    const sign = tx.type === "SELL" ? -1 : 1;
    holding.totalAmount = round(holding.totalAmount + sign * tx.amount, 8);
    holding.totalShares = round(holding.totalShares + sign * tx.shares, 8);
    totalInvested = round(totalInvested + sign * tx.amount, 8);
    const buy = {
      id: tx.id, date: tx.tradeDate, settleDate: tx.settleDate,
      amount: tx.amount, nav: tx.nav, shares: tx.shares, type: tx.type
    };
    holding.buys.push(buy);
    if (tx.type === "BUY" && tx.amount > 0 && tx.shares === 0) {
      holding.pendingBuys.push(buy);
      holding.pendingAmount = round(holding.pendingAmount + tx.amount, 8);
    }
  });
  const allHoldings = Object.values(holdingsByCode);
  const pendingHoldings = allHoldings.filter(function (holding) { return holding.pendingAmount > 0; }).map(function (holding) {
    return { code: holding.code, totalAmount: holding.pendingAmount, buys: holding.pendingBuys };
  });
  const pendingInvested = round(pendingHoldings.reduce(function (sum, holding) {
    return sum + holding.totalAmount;
  }, 0), 8);
  return {
    holdings: allHoldings.filter(function (holding) { return holding.totalShares > 0; }),
    pendingHoldings: pendingHoldings,
    pendingInvested: pendingInvested,
    confirmedInvested: round(totalInvested - pendingInvested, 8),
    totalInvested: totalInvested,
    transactionCount: ledger.transactions.length,
    revision: ledger.revision,
    checksum: ledger.checksum
  };
}

function appendTransactions(ledger, transactions, expectedRevision, updatedAt) {
  if (Number(ledger.revision) !== Number(expectedRevision)) throw new Error("REVISION_CONFLICT");
  const existingIds = new Set(ledger.transactions.map(function (tx) { return tx.id; }));
  (transactions || []).forEach(function (tx) {
    if (existingIds.has(tx.id)) throw new Error("DUPLICATE_TRANSACTION:" + tx.id);
  });
  return createLedger(ledger.transactions.concat(transactions || []), {
    revision: ledger.revision + 1,
    updatedAt: updatedAt || new Date().toISOString()
  });
}

function reconcilePendingTransactions(ledger, navCache, updatedAt) {
  const validation = validateLedger(ledger);
  if (!validation.valid) throw new Error("INVALID_LEDGER:" + validation.errors.join(","));
  const reconciled = [];
  const transactions = ledger.transactions.map(function (transaction) {
    const tx = canonicalTransaction(transaction);
    if (tx.type !== "BUY" || !(tx.amount > 0) || tx.shares > 0) return tx;
    const rows = Array.isArray(navCache && navCache[tx.code]) ? navCache[tx.code] : [];
    const match = rows.slice().sort(function (left, right) {
      return String(left.date || "").localeCompare(String(right.date || ""));
    }).find(function (row) {
      return String(row.date || "") >= tx.tradeDate && Number(row.nav) > 0;
    });
    if (!match) return tx;
    const nav = round(match.nav, 8);
    const shares = round(tx.amount / nav, 4);
    reconciled.push({
      id: tx.id, code: tx.code, tradeDate: tx.tradeDate, nav: nav, shares: shares
    });
    return Object.assign({}, tx, { nav: nav, shares: shares });
  });
  if (reconciled.length === 0) return { ledger: ledger, reconciled: reconciled };
  const nextLedger = createLedger(transactions, {
    revision: Number(ledger.revision) + 1,
    updatedAt: updatedAt || new Date().toISOString()
  });
  if (ledger.fundNames && typeof ledger.fundNames === "object") {
    nextLedger.fundNames = Object.assign({}, ledger.fundNames);
  }
  return { ledger: nextLedger, reconciled: reconciled };
}

function previewSource(source) {
  const ledger = source && Number(source.schemaVersion) === SCHEMA_VERSION
    ? source
    : migrateLegacyPortfolio(source || { holdings: [] }, { revision: 1, updatedAt: "1970-01-01T00:00:00.000Z" });
  const portfolio = derivePortfolio(ledger);
  return {
    fundCount: portfolio.holdings.length,
    transactionCount: portfolio.transactionCount,
    totalInvested: portfolio.totalInvested,
    checksum: ledger.checksum,
    revision: ledger.revision
  };
}

function previewSources(sources) {
  const result = {};
  Object.keys(sources || {}).forEach(function (name) { result[name] = previewSource(sources[name]); });
  const checksums = Object.values(result).map(function (row) { return row.checksum; });
  result.allEqual = checksums.length > 0 && new Set(checksums).size === 1;
  return result;
}

module.exports = {
  SCHEMA_VERSION: SCHEMA_VERSION,
  stableTransactionId: stableTransactionId,
  checksumTransactions: checksumTransactions,
  createLedger: createLedger,
  migrateLegacyPortfolio: migrateLegacyPortfolio,
  validateLedger: validateLedger,
  derivePortfolio: derivePortfolio,
  appendTransactions: appendTransactions,
  reconcilePendingTransactions: reconcilePendingTransactions,
  previewSources: previewSources
};
