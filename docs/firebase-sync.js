import { initializeApp } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js";
import {
  browserLocalPersistence, getAuth, GoogleAuthProvider, onAuthStateChanged,
  setPersistence, signInWithPopup, signOut
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js";
import {
  get, getDatabase, ref, runTransaction
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-database.js";

const config = window.QDII_FIREBASE_CONFIG || {};
const configured = [config.apiKey, config.authDomain, config.databaseURL, config.projectId, config.appId]
  .every(function (value) { return value && !String(value).includes("PLACEHOLDER"); });
const snapshotPrefix = "qdii-ledger-snapshot-v2:";
const decisionSnapshotPrefix = "qdii-decision-state-v1:";
let auth = null;
let database = null;
let currentLedger = null;
let currentDecisionState = null;
let currentUser = null;

function emit(name, detail) {
  window.dispatchEvent(new CustomEvent(name, { detail: detail }));
}

function canonicalTransaction(transaction) {
  return {
    id: String(transaction.id || ""), type: String(transaction.type || "BUY").toUpperCase(),
    code: String(transaction.code || ""), tradeDate: String(transaction.tradeDate || transaction.date || ""),
    settleDate: transaction.settleDate ? String(transaction.settleDate) : null,
    amount: Number(transaction.amount) || 0, nav: Number(transaction.nav) || 0,
    shares: Number(transaction.shares) || 0,
    createdAt: String(transaction.createdAt || ((transaction.tradeDate || transaction.date || "") + "T00:00:00.000Z"))
  };
}

async function sha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).map(function (byte) { return byte.toString(16).padStart(2, "0"); }).join("");
}

async function checksumTransactions(transactions) {
  const canonical = (transactions || []).map(canonicalTransaction).sort(function (left, right) { return left.id.localeCompare(right.id); });
  return sha256(JSON.stringify(canonical));
}

async function migrateLegacyPortfolio(portfolio, revision) {
  const drafts = [];
  ((portfolio && portfolio.holdings) || []).slice().sort(function (a, b) { return a.code.localeCompare(b.code); }).forEach(function (holding) {
    (holding.buys || []).forEach(function (buy) {
      drafts.push(canonicalTransaction({
        type: "BUY", code: holding.code, tradeDate: buy.tradeDate || buy.date, settleDate: buy.settleDate,
        amount: buy.amount, nav: buy.nav, shares: buy.shares, createdAt: buy.createdAt
      }));
    });
  });
  drafts.sort(function (left, right) {
    return left.tradeDate.localeCompare(right.tradeDate) || left.code.localeCompare(right.code) ||
      left.amount - right.amount || left.nav - right.nav || left.shares - right.shares;
  });
  const occurrences = new Map();
  for (const draft of drafts) {
    const fingerprint = [draft.type, draft.code, draft.tradeDate, draft.settleDate || "", draft.amount, draft.nav, draft.shares].join("|");
    const occurrence = occurrences.get(fingerprint) || 0;
    occurrences.set(fingerprint, occurrence + 1);
    draft.id = "tx_" + (await sha256(fingerprint + "|" + occurrence)).slice(0, 24);
  }
  const ledger = {
    schemaVersion: 2, revision: Number(revision || 1), updatedAt: new Date().toISOString(),
    transactions: drafts
  };
  ledger.checksum = await checksumTransactions(ledger.transactions);
  return ledger;
}

async function validateLedger(ledger) {
  if (!ledger || Number(ledger.schemaVersion) !== 2 || !Array.isArray(ledger.transactions)) throw new Error("INVALID_LEDGER");
  const ids = new Set();
  ledger.transactions.forEach(function (transaction) {
    if (!transaction.id || !transaction.code || !transaction.tradeDate) throw new Error("INVALID_TRANSACTION");
    if (ids.has(transaction.id)) throw new Error("DUPLICATE_TRANSACTION");
    ids.add(transaction.id);
  });
  if (ledger.checksum !== await checksumTransactions(ledger.transactions)) throw new Error("CHECKSUM_MISMATCH");
  return ledger;
}

function derivePortfolio(ledger) {
  const holdings = {};
  ledger.transactions.forEach(function (transaction) {
    const tx = canonicalTransaction(transaction);
    const sign = tx.type === "SELL" ? -1 : 1;
    if (!holdings[tx.code]) holdings[tx.code] = { code: tx.code, buys: [], totalAmount: 0, totalShares: 0 };
    holdings[tx.code].totalAmount += sign * tx.amount;
    holdings[tx.code].totalShares += sign * tx.shares;
    holdings[tx.code].buys.push({
      id: tx.id, date: tx.tradeDate, settleDate: tx.settleDate,
      type: tx.type, amount: sign * tx.amount, nav: tx.nav, shares: sign * tx.shares
    });
  });
  return { holdings: Object.values(holdings).filter(function (holding) { return holding.totalShares > 0 || holding.totalAmount > 0; }) };
}

function ledgerPath(uid) {
  return "users/" + uid + "/portfolioLedger";
}

function decisionStatePath(uid) {
  return "users/" + uid + "/decisionState";
}

function normalizeDecisionState(state) {
  if (!state) return null;
  if (Number(state.schemaVersion) !== 1 || !Number.isInteger(Number(state.revision)) || Number(state.revision) < 1) {
    throw new Error("INVALID_DECISION_STATE");
  }
  const riskAnchorValue = Number(state.riskAnchorValue);
  if (!(riskAnchorValue > 0)) throw new Error("INVALID_RISK_ANCHOR");
  return {
    schemaVersion: 1,
    revision: Number(state.revision),
    updatedAt: String(state.updatedAt || ""),
    riskAnchorValue: riskAnchorValue,
    riskAnchorAt: String(state.riskAnchorAt || state.updatedAt || ""),
    riskAnchorLedgerRevision: Number(state.riskAnchorLedgerRevision || 0),
    cashBalance: Math.max(0, Number(state.cashBalance) || 0)
  };
}

function saveSnapshot(uid, ledger) {
  localStorage.setItem(snapshotPrefix + uid, JSON.stringify(ledger));
}

function saveDecisionSnapshot(uid, state) {
  if (state) localStorage.setItem(decisionSnapshotPrefix + uid, JSON.stringify(state));
  else localStorage.removeItem(decisionSnapshotPrefix + uid);
}

function emitLedger(source, readOnly) {
  emit("qdii-cloud-ledger", {
    ledger: currentLedger,
    decisionState: currentDecisionState,
    portfolio: derivePortfolio(currentLedger),
    source: source,
    readOnly: readOnly === true
  });
}

async function loadLedger() {
  if (!currentUser) throw new Error("AUTH_REQUIRED");
  if (!navigator.onLine) {
    const snapshot = localStorage.getItem(snapshotPrefix + currentUser.uid);
    if (!snapshot) throw new Error("OFFLINE_WITHOUT_SNAPSHOT");
    currentLedger = await validateLedger(JSON.parse(snapshot));
    const decisionSnapshot = localStorage.getItem(decisionSnapshotPrefix + currentUser.uid);
    currentDecisionState = decisionSnapshot ? normalizeDecisionState(JSON.parse(decisionSnapshot)) : null;
    emitLedger("本地只读快照", true);
    return currentLedger;
  }
  const results = await Promise.all([
    get(ref(database, ledgerPath(currentUser.uid))),
    get(ref(database, decisionStatePath(currentUser.uid)))
  ]);
  const ledgerResult = results[0];
  const decisionResult = results[1];
  if (!ledgerResult.exists()) {
    currentLedger = null;
    currentDecisionState = null;
    emit("qdii-cloud-state", { status: "EMPTY", source: "云端", uid: currentUser.uid });
    return null;
  }
  currentLedger = await validateLedger(ledgerResult.val());
  currentDecisionState = decisionResult.exists() ? normalizeDecisionState(decisionResult.val()) : null;
  saveSnapshot(currentUser.uid, currentLedger);
  saveDecisionSnapshot(currentUser.uid, currentDecisionState);
  emitLedger("Firebase 云端", false);
  return currentLedger;
}

async function writeLedger(nextLedger, expectedRevision) {
  if (!currentUser) throw new Error("AUTH_REQUIRED");
  if (!navigator.onLine) throw new Error("OFFLINE_READ_ONLY");
  await validateLedger(nextLedger);
  const target = ref(database, ledgerPath(currentUser.uid));
  const result = await runTransaction(target, function (existing) {
    const actualRevision = existing ? Number(existing.revision) : 0;
    if (actualRevision !== Number(expectedRevision)) return;
    return nextLedger;
  }, { applyLocally: false });
  if (!result.committed) throw new Error("REVISION_CONFLICT");
  currentLedger = nextLedger;
  saveSnapshot(currentUser.uid, currentLedger);
  emitLedger("Firebase 云端", false);
  return currentLedger;
}

async function writeDecisionState(nextState, expectedRevision) {
  if (!currentUser) throw new Error("AUTH_REQUIRED");
  if (!currentLedger) throw new Error("SYNC_REQUIRED");
  if (!navigator.onLine) throw new Error("OFFLINE_READ_ONLY");
  const normalized = normalizeDecisionState(nextState);
  const target = ref(database, decisionStatePath(currentUser.uid));
  const result = await runTransaction(target, function (existing) {
    const actualRevision = existing ? Number(existing.revision) : 0;
    if (actualRevision !== Number(expectedRevision)) return;
    return normalized;
  }, { applyLocally: false });
  if (!result.committed) throw new Error("DECISION_REVISION_CONFLICT");
  currentDecisionState = normalized;
  saveDecisionSnapshot(currentUser.uid, currentDecisionState);
  emitLedger("Firebase 云端", false);
  return currentDecisionState;
}

async function initializeRiskAnchor(value, ledgerRevision) {
  if (currentDecisionState && Number(currentDecisionState.riskAnchorValue) > 0) throw new Error("RISK_ANCHOR_ALREADY_SET");
  if (!currentLedger || Number(currentLedger.revision) !== Number(ledgerRevision)) throw new Error("LEDGER_REVISION_CONFLICT");
  const riskAnchorValue = Number(value);
  if (!(riskAnchorValue > 0)) throw new Error("INVALID_RISK_ANCHOR");
  const now = new Date().toISOString();
  return writeDecisionState({
    schemaVersion: 1,
    revision: 1,
    updatedAt: now,
    riskAnchorValue: riskAnchorValue,
    riskAnchorAt: now,
    riskAnchorLedgerRevision: Number(currentLedger.revision),
    cashBalance: 0
  }, 0);
}

async function saveLegacyPortfolio(portfolio) {
  if (!currentLedger) throw new Error("MIGRATION_REQUIRED");
  const migrated = await migrateLegacyPortfolio(portfolio, currentLedger.revision + 1);
  const previousIds = new Set(currentLedger.transactions.map(function (tx) { return tx.id; }));
  const migratedIds = new Set(migrated.transactions.map(function (tx) { return tx.id; }));
  if (Array.from(previousIds).some(function (id) { return !migratedIds.has(id); })) throw new Error("IMMUTABLE_LEDGER_DELETE_FORBIDDEN");
  migrated.updatedAt = new Date().toISOString();
  migrated.checksum = await checksumTransactions(migrated.transactions);
  return writeLedger(migrated, currentLedger.revision);
}

async function previewLegacy(portfolio) {
  const ledger = await migrateLegacyPortfolio(portfolio, 1);
  return {
    ledger: ledger,
    fundCount: ((portfolio && portfolio.holdings) || []).length,
    transactionCount: ledger.transactions.length,
    totalInvested: ledger.transactions.reduce(function (sum, tx) { return sum + (tx.type === "BUY" ? tx.amount : -tx.amount); }, 0),
    checksum: ledger.checksum,
    cloudRevision: currentLedger ? currentLedger.revision : 0
  };
}

async function overwriteWithLegacy(portfolio, expectedCloudRevision) {
  const ledger = await migrateLegacyPortfolio(portfolio, 1);
  return writeLedger(ledger, expectedCloudRevision);
}

async function signIn() {
  if (!configured) throw new Error("FIREBASE_WEB_CONFIG_MISSING");
  return signInWithPopup(auth, new GoogleAuthProvider());
}

async function bootstrap() {
  if (!configured) {
    emit("qdii-cloud-state", { status: "CONFIG_MISSING", source: "未配置" });
    return;
  }
  const app = initializeApp(config);
  auth = getAuth(app);
  database = getDatabase(app);
  await setPersistence(auth, browserLocalPersistence);
  onAuthStateChanged(auth, async function (user) {
    currentUser = user;
    if (!user) {
      currentLedger = null;
      currentDecisionState = null;
      emit("qdii-cloud-state", { status: "SIGNED_OUT", source: "未登录" });
      return;
    }
    emit("qdii-cloud-state", { status: "SYNCING", source: "正在同步", uid: user.uid });
    try { await loadLedger(); }
    catch (error) { emit("qdii-cloud-state", { status: "ERROR", source: navigator.onLine ? "同步失败" : "本地只读快照", error: error.message }); }
  });
}

window.QdiiCloudSync = {
  bootstrap: bootstrap, signIn: signIn, signOut: function () { return signOut(auth); },
  loadLedger: loadLedger, saveLegacyPortfolio: saveLegacyPortfolio,
  previewLegacy: previewLegacy, overwriteWithLegacy: overwriteWithLegacy,
  initializeRiskAnchor: initializeRiskAnchor,
  getCurrentLedger: function () { return currentLedger; },
  getCurrentDecisionState: function () { return currentDecisionState; }
};

bootstrap();
