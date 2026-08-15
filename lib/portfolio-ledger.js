const crypto = require("crypto");
const tradingCalendar = require("./trading-calendar");

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

function isNonNegativeFiniteInput(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isIsoDate(value) {
  const text = String(value || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const parsed = new Date(text + "T00:00:00.000Z");
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === text;
}

function effectiveApplicationDate(tradeDate) {
  if (!isIsoDate(tradeDate)) return null;
  if (tradingCalendar.isTradingDay(tradeDate)) return tradeDate;
  return tradingCalendar.addTradingDays(tradeDate, 1).date;
}

function hasValidTransactionSemantics(transaction) {
  const tx = transaction || {};
  const type = tx.type;
  const tradeDate = tx.tradeDate || tx.date;
  return Boolean(String(tx.id || "")) && Boolean(String(tx.code || "")) && isIsoDate(tradeDate) &&
    ["BUY", "SELL"].includes(type) && isNonNegativeFiniteInput(tx.amount) &&
    isNonNegativeFiniteInput(tx.nav) && isNonNegativeFiniteInput(tx.shares) &&
    (type !== "SELL" || (tx.amount > 0 && tx.nav > 0 && tx.shares > 0));
}

function createLedger(transactions, options) {
  const settings = options || {};
  const sourceTransactions = transactions || [];
  const requestedRevision = settings.revision === undefined ? 1 : Number(settings.revision);
  if (!Array.isArray(sourceTransactions) || !Number.isInteger(requestedRevision) || requestedRevision < 1) {
    throw new Error("INVALID_LEDGER");
  }
  sourceTransactions.forEach(function (tx) {
    if (!hasValidTransactionSemantics(tx)) throw new Error("INVALID_TRANSACTION");
  });
  const normalized = sourceTransactions.map(canonicalTransaction).sort(function (left, right) {
    return left.tradeDate.localeCompare(right.tradeDate) || left.id.localeCompare(right.id);
  });
  const ids = new Set();
  const sharesByCode = {};
  normalized.forEach(function (tx) {
    if (ids.has(tx.id)) throw new Error("DUPLICATE_TRANSACTION:" + tx.id);
    ids.add(tx.id);
    const sign = tx.type === "SELL" ? -1 : 1;
    sharesByCode[tx.code] = round((sharesByCode[tx.code] || 0) + sign * tx.shares, 8);
    if (sharesByCode[tx.code] < 0) throw new Error("NEGATIVE_HOLDING:" + tx.code);
  });
  return {
    schemaVersion: SCHEMA_VERSION,
    revision: requestedRevision,
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
  if (!ledger || ledger.schemaVersion !== SCHEMA_VERSION) errors.push("SCHEMA_VERSION");
  if (!ledger || !Number.isInteger(ledger.revision) || ledger.revision < 1) errors.push("REVISION");
  const transactions = ledger && Array.isArray(ledger.transactions) ? ledger.transactions : [];
  if (!ledger || !Array.isArray(ledger.transactions)) errors.push("TRANSACTIONS");
  const ids = new Set();
  const sharesByCode = {};
  transactions.forEach(function (tx) {
    const normalized = canonicalTransaction(tx);
    if (!hasValidTransactionSemantics(tx)) {
      errors.push("INVALID_TRANSACTION");
    }
    if (ids.has(normalized.id)) errors.push("DUPLICATE_TRANSACTION:" + normalized.id);
    ids.add(normalized.id);
    const sign = normalized.type === "SELL" ? -1 : 1;
    sharesByCode[normalized.code] = round((sharesByCode[normalized.code] || 0) + sign * normalized.shares, 8);
    if (sharesByCode[normalized.code] < 0) errors.push("NEGATIVE_HOLDING:" + normalized.code);
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
      code: tx.code, buys: [], totalAmount: 0, totalShares: 0, pendingBuys: [], pendingAmount: 0,
      remainingCostBasis: 0, realizedPnl: 0, confirmedBuyAmount: 0, hasSell: false
    };
    const holding = holdingsByCode[tx.code];
    const sign = tx.type === "SELL" ? -1 : 1;
    if (tx.type === "BUY" && tx.shares > 0) {
      holding.remainingCostBasis = round(holding.remainingCostBasis + tx.amount, 8);
      holding.confirmedBuyAmount = round(holding.confirmedBuyAmount + tx.amount, 8);
    } else if (tx.type === "SELL") {
      const sharesBeforeSell = holding.totalShares;
      const soldCostBasis = sharesBeforeSell > 0
        ? holding.remainingCostBasis * Math.min(1, tx.shares / sharesBeforeSell)
        : 0;
      holding.remainingCostBasis = round(Math.max(0, holding.remainingCostBasis - soldCostBasis), 8);
      holding.realizedPnl = round(holding.realizedPnl + tx.amount - soldCostBasis, 8);
      holding.hasSell = true;
    }
    holding.totalAmount = round(holding.totalAmount + sign * tx.amount, 8);
    holding.totalShares = round(holding.totalShares + sign * tx.shares, 8);
    totalInvested = round(totalInvested + sign * tx.amount, 8);
    const buy = {
      id: tx.id, date: tx.tradeDate, settleDate: tx.settleDate,
      amount: sign * tx.amount, nav: tx.nav, shares: sign * tx.shares, type: tx.type
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
  const closedPositions = allHoldings.filter(function (holding) {
    return holding.hasSell && holding.totalShares === 0;
  }).map(function (holding) {
    return {
      code: holding.code,
      investedAmount: holding.confirmedBuyAmount,
      realizedPnl: holding.realizedPnl
    };
  });
  const closedRealizedPnl = round(closedPositions.reduce(function (sum, position) {
    return sum + position.realizedPnl;
  }, 0), 8);
  return {
    holdings: allHoldings.filter(function (holding) { return holding.totalShares > 0; }),
    pendingHoldings: pendingHoldings,
    pendingInvested: pendingInvested,
    closedPositions: closedPositions,
    closedRealizedPnl: closedRealizedPnl,
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
    if (tx.nav > 0) {
      const shares = round(tx.amount / tx.nav, 4);
      reconciled.push({
        id: tx.id, code: tx.code, tradeDate: tx.tradeDate, nav: tx.nav, shares: shares, source: "TRANSACTION_NAV"
      });
      return Object.assign({}, tx, { shares: shares });
    }
    const effectiveDate = effectiveApplicationDate(tx.tradeDate);
    const rows = Array.isArray(navCache && navCache[tx.code]) ? navCache[tx.code] : [];
    const match = rows.find(function (row) {
      return effectiveDate && String(row.date || "") === effectiveDate && Number(row.nav) > 0;
    });
    if (!match) return tx;
    const nav = round(match.nav, 8);
    const shares = round(tx.amount / nav, 4);
    reconciled.push({ id: tx.id, code: tx.code, tradeDate: tx.tradeDate, nav: nav, shares: shares, source: "NAV_CACHE" });
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
