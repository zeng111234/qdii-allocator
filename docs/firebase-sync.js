const config = window.QDII_FIREBASE_CONFIG || {};
const configured = [config.apiKey, config.authDomain, config.databaseURL, config.projectId, config.appId]
  .every(function (value) { return value && !String(value).includes("PLACEHOLDER"); });
const snapshotPrefix = "qdii-ledger-snapshot-v2:";
const decisionSnapshotPrefix = "qdii-decision-state-v1:";
const strategySnapshotPrefix = "qdii-strategy-state-v1:";
const publicDecisionStateKey = "qdii-public-decision-state-v1";
let auth = null;
let database = null;
let currentLedger = null;
let currentDecisionState = null;
let currentStrategyState = null;
let currentUser = null;
let publicLedgerSnapshot = null;
let firebaseModulesPromise = null;
let initializeApp, browserLocalPersistence, getAuth, GoogleAuthProvider, onAuthStateChanged;
let getIdToken, setPersistence, signInWithPopup, signOut, get, getDatabase, ref, runTransaction;

async function loadFirebaseModules() {
  if (firebaseModulesPromise) return firebaseModulesPromise;
  firebaseModulesPromise = Promise.all([
    import("https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js"),
    import("https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js"),
    import("https://www.gstatic.com/firebasejs/11.10.0/firebase-database.js")
  ]).then(function (modules) {
    const appModule = modules[0];
    const authModule = modules[1];
    const databaseModule = modules[2];
    initializeApp = appModule.initializeApp;
    browserLocalPersistence = authModule.browserLocalPersistence;
    getAuth = authModule.getAuth;
    GoogleAuthProvider = authModule.GoogleAuthProvider;
    onAuthStateChanged = authModule.onAuthStateChanged;
    getIdToken = authModule.getIdToken;
    setPersistence = authModule.setPersistence;
    signInWithPopup = authModule.signInWithPopup;
    signOut = authModule.signOut;
    get = databaseModule.get;
    getDatabase = databaseModule.getDatabase;
    ref = databaseModule.ref;
    runTransaction = databaseModule.runTransaction;
  });
  return firebaseModulesPromise;
}

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
  const fundNames = {};
  ((portfolio && portfolio.holdings) || []).slice().sort(function (a, b) {
    return String((a && a.code) || "").localeCompare(String((b && b.code) || ""));
  }).forEach(function (holding) {
    const code = String((holding && holding.code) || "").trim();
    if (code && holding.name) fundNames[code] = String(holding.name).trim();
    (holding.buys || []).forEach(function (buy) {
      drafts.push(canonicalTransaction({
        type: "BUY", code: code, tradeDate: buy.tradeDate || buy.date, settleDate: buy.settleDate,
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
    transactions: drafts, fundNames: fundNames
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
  const fundNames = (ledger && ledger.fundNames) || {};
  ledger.transactions.forEach(function (transaction) {
    const tx = canonicalTransaction(transaction);
    const sign = tx.type === "SELL" ? -1 : 1;
    if (!holdings[tx.code]) holdings[tx.code] = {
      code: tx.code, name: fundNames[tx.code] || "", buys: [], totalAmount: 0, totalShares: 0, pendingBuys: [], pendingAmount: 0
    };
    const holding = holdings[tx.code];
    holding.totalAmount += sign * tx.amount;
    holding.totalShares += sign * tx.shares;
    const buy = {
      id: tx.id, date: tx.tradeDate, settleDate: tx.settleDate,
      type: tx.type, amount: sign * tx.amount, nav: tx.nav, shares: sign * tx.shares
    };
    holding.buys.push(buy);
    if (tx.type === "BUY" && tx.amount > 0 && tx.shares === 0) {
      holding.pendingBuys.push(buy);
      holding.pendingAmount += tx.amount;
    }
  });
  const allHoldings = Object.values(holdings);
  const pendingHoldings = allHoldings.filter(function (holding) { return holding.pendingAmount > 0; }).map(function (holding) {
    return { code: holding.code, name: holding.name, totalAmount: holding.pendingAmount, buys: holding.pendingBuys };
  });
  return {
    holdings: allHoldings.filter(function (holding) { return holding.totalShares > 0; }),
    pendingHoldings: pendingHoldings,
    pendingInvested: pendingHoldings.reduce(function (sum, holding) { return sum + holding.totalAmount; }, 0)
  };
}

function ledgerPath(uid) {
  return "users/" + uid + "/portfolioLedger";
}

function decisionStatePath(uid) {
  return "users/" + uid + "/decisionState";
}

function strategyStatePath(uid) {
  return "users/" + uid + "/strategyState";
}

function normalizeDecisionState(state) {
  if (!state) return null;
  const schemaVersion = Number(state.schemaVersion);
  if ((schemaVersion !== 1 && schemaVersion !== 2) || !Number.isInteger(Number(state.revision)) || Number(state.revision) < 1) {
    throw new Error("INVALID_DECISION_STATE");
  }
  const riskAnchorValue = Number(state.riskAnchorValue);
  if (!(riskAnchorValue > 0)) throw new Error("INVALID_RISK_ANCHOR");
  const riskAnchorTransactionIds = Array.isArray(state.riskAnchorTransactionIds)
    ? Array.from(new Set(state.riskAnchorTransactionIds.map(function (id) { return String(id || ""); }).filter(Boolean))).sort()
    : [];
  return {
    schemaVersion: schemaVersion,
    revision: Number(state.revision),
    updatedAt: String(state.updatedAt || ""),
    riskAnchorValue: riskAnchorValue,
    riskAnchorAt: String(state.riskAnchorAt || state.updatedAt || ""),
    riskAnchorLedgerRevision: Number(state.riskAnchorLedgerRevision || 0),
    riskAnchorTransactionIds: riskAnchorTransactionIds,
    cashBalance: Math.max(0, Number(state.cashBalance) || 0)
  };
}

function normalizeStrategyState(state) {
  if (!state) return null;
  if (Number(state.schemaVersion) !== 1 || !state.latestPlan || !Array.isArray(state.observations)) {
    throw new Error("INVALID_STRATEGY_STATE");
  }
  return state;
}

function saveSnapshot(uid, ledger) {
  localStorage.setItem(snapshotPrefix + uid, JSON.stringify(ledger));
}

function saveDecisionSnapshot(uid, state) {
  if (state) localStorage.setItem(decisionSnapshotPrefix + uid, JSON.stringify(state));
  else localStorage.removeItem(decisionSnapshotPrefix + uid);
}

function saveStrategySnapshot(uid, state) {
  if (state) localStorage.setItem(strategySnapshotPrefix + uid, JSON.stringify(state));
  else localStorage.removeItem(strategySnapshotPrefix + uid);
}

function loadPublicDecisionState() {
  const saved = localStorage.getItem(publicDecisionStateKey);
  return saved ? normalizeDecisionState(JSON.parse(saved)) : null;
}

function initializePublicRiskAnchor(value, ledgerRevision) {
  if (currentDecisionState && Number(currentDecisionState.riskAnchorValue) > 0) throw new Error("RISK_ANCHOR_ALREADY_SET");
  if (!currentLedger || Number(currentLedger.revision) !== Number(ledgerRevision)) throw new Error("LEDGER_REVISION_CONFLICT");
  const riskAnchorValue = Number(value);
  if (!(riskAnchorValue > 0)) throw new Error("INVALID_RISK_ANCHOR");
  const now = new Date().toISOString();
  currentDecisionState = normalizeDecisionState({
    schemaVersion: 2,
    revision: 1,
    updatedAt: now,
    riskAnchorValue: riskAnchorValue,
    riskAnchorAt: now,
    riskAnchorLedgerRevision: Number(currentLedger.revision),
    riskAnchorTransactionIds: currentLedger.transactions.map(function (transaction) { return String(transaction.id); }).filter(Boolean).sort(),
    cashBalance: 0
  });
  localStorage.setItem(publicDecisionStateKey, JSON.stringify(currentDecisionState));
  emitLedger("公开只读快照", true);
  return currentDecisionState;
}

function emitLedger(source, readOnly) {
  emit("qdii-cloud-ledger", {
    ledger: currentLedger,
    decisionState: currentDecisionState,
    strategyState: currentStrategyState,
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
    const strategySnapshot = localStorage.getItem(strategySnapshotPrefix + currentUser.uid);
    currentStrategyState = strategySnapshot ? normalizeStrategyState(JSON.parse(strategySnapshot)) : null;
    emitLedger("本地只读快照", true);
    return currentLedger;
  }
  const results = await Promise.all([
    readLedgerAt(ref(database, ledgerPath(currentUser.uid))),
    get(ref(database, decisionStatePath(currentUser.uid))),
    get(ref(database, strategyStatePath(currentUser.uid)))
  ]);
  const ledgerResult = results[0];
  const decisionResult = results[1];
  const strategyResult = results[2];
  if (!ledgerResult) {
    currentLedger = null;
    currentDecisionState = null;
    currentStrategyState = null;
    emit("qdii-cloud-state", { status: "EMPTY", source: "云端", uid: currentUser.uid });
    return null;
  }
  currentLedger = ledgerResult;
  currentDecisionState = decisionResult.exists() ? normalizeDecisionState(decisionResult.val()) : null;
  currentStrategyState = strategyResult.exists() ? normalizeStrategyState(strategyResult.val()) : null;
  saveSnapshot(currentUser.uid, currentLedger);
  saveDecisionSnapshot(currentUser.uid, currentDecisionState);
  saveStrategySnapshot(currentUser.uid, currentStrategyState);
  emitLedger("Firebase 云端", false);
  return currentLedger;
}

async function readLedgerAt(target) {
  const snapshot = await get(target);
  return snapshot.exists() ? validateLedger(snapshot.val()) : null;
}

function ledgerRestUrl(idToken) {
  const base = String(config.databaseURL || "").replace(/\/$/, "");
  return base + "/users/" + encodeURIComponent(currentUser.uid) + "/portfolioLedger.json?auth=" + encodeURIComponent(idToken);
}

async function ledgerIdToken(forceRefresh) {
  if (!currentUser) throw new Error("AUTH_REQUIRED");
  try {
    return await getIdToken(currentUser, forceRefresh === true);
  } catch (error) {
    throw new Error("AUTH_EXPIRED");
  }
}

async function readLedgerWithEtag(forceRefresh) {
  if (!currentUser) throw new Error("AUTH_REQUIRED");
  if (!navigator.onLine) throw new Error("OFFLINE_READ_ONLY");
  const token = await ledgerIdToken(forceRefresh);
  let response;
  try {
    response = await fetch(ledgerRestUrl(token), {
      headers: { "X-Firebase-ETag": "true", "Cache-Control": "no-cache" },
      cache: "no-store"
    });
  } catch (error) {
    throw new Error("NETWORK_REQUEST_FAILED");
  }
  if (response.status === 401) throw new Error("AUTH_EXPIRED");
  if (response.status === 403) throw new Error("PERMISSION_DENIED");
  if (!response.ok) throw new Error("FIREBASE_HTTP_" + response.status);
  const etag = response.headers.get("ETag");
  if (!etag) throw new Error("ETAG_MISSING");
  const payload = await response.json();
  return { ledger: payload === null ? null : await validateLedger(payload), etag: etag };
}

async function conditionalWriteLedger(nextLedger, expected, forceRefresh) {
  const preflight = await readLedgerWithEtag(forceRefresh);
  const remoteLedger = preflight.ledger;
  const remoteRevision = remoteLedger ? Number(remoteLedger.revision) : 0;
  const remoteChecksum = remoteLedger ? remoteLedger.checksum : null;
  if (remoteRevision !== Number(expected.revision) ||
      (expected.checksum !== undefined && remoteChecksum !== expected.checksum) ||
      (expected.etag !== undefined && preflight.etag !== expected.etag)) {
    throw new Error("ETAG_CONFLICT");
  }
  if (Number(nextLedger.revision) !== Number(expected.revision) + 1) throw new Error("INVALID_NEXT_REVISION");
  const token = await ledgerIdToken(forceRefresh);
  let response;
  try {
    response = await fetch(ledgerRestUrl(token), {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "if-match": expected.etag || preflight.etag,
        "Cache-Control": "no-cache"
      },
      cache: "no-store",
      body: JSON.stringify(nextLedger)
    });
  } catch (error) {
    throw new Error("NETWORK_REQUEST_FAILED");
  }
  if (response.status === 412) throw new Error("ETAG_CONFLICT");
  if (response.status === 401) throw new Error("AUTH_EXPIRED");
  if (response.status === 403) throw new Error("PERMISSION_DENIED");
  if (!response.ok) throw new Error("FIREBASE_HTTP_" + response.status);
}

async function writeLedger(nextLedger, expected) {
  if (!currentUser) throw new Error("AUTH_REQUIRED");
  if (!navigator.onLine) throw new Error("OFFLINE_READ_ONLY");
  await validateLedger(nextLedger);
  try {
    await conditionalWriteLedger(nextLedger, expected, false);
  } catch (error) {
    if (!error || error.message !== "AUTH_EXPIRED") throw error;
    await conditionalWriteLedger(nextLedger, expected, true);
  }
  const verified = await readLedgerWithEtag(false);
  const verifiedLedger = verified.ledger;
  if (!verifiedLedger || verifiedLedger.checksum !== nextLedger.checksum ||
      Number(verifiedLedger.revision) !== Number(nextLedger.revision)) {
    throw new Error("READBACK_MISMATCH");
  }
  currentLedger = verifiedLedger;
  saveSnapshot(currentUser.uid, currentLedger);
  emitLedger("Firebase 云端", false);
  return currentLedger;
}

async function appendBuyTransactions(drafts) {
  if (!currentUser) throw new Error("AUTH_REQUIRED");
  if (!currentLedger) throw new Error("SYNC_REQUIRED");
  const createdAt = new Date().toISOString();
  const additions = [];
  const fundNames = Object.assign({}, currentLedger.fundNames || {});
  for (const draft of (drafts || [])) {
    const code = String((draft && draft.code) || "").trim();
    const tradeDate = String((draft && (draft.tradeDate || draft.date)) || "");
    const amount = Number(draft && draft.amount);
    const nav = Number(draft && draft.nav) || 0;
    if (!code || !/^\d{4}-\d{2}-\d{2}$/.test(tradeDate) || !(amount > 0)) {
      throw new Error("INVALID_BUY_TRANSACTION");
    }
    const shares = nav > 0 ? Math.round(amount / nav * 10000) / 10000 : 0;
    const uniqueSeed = [code, tradeDate, amount, nav, createdAt, crypto.randomUUID()].join("|");
    additions.push(canonicalTransaction({
      id: "tx_" + (await sha256(uniqueSeed)).slice(0, 24),
      type: "BUY", code: code, tradeDate: tradeDate,
      amount: amount, nav: nav, shares: shares, createdAt: createdAt
    }));
    if (draft.name) fundNames[code] = String(draft.name).trim();
  }
  if (additions.length === 0) throw new Error("EMPTY_BUY_TRANSACTIONS");
  const expected = { revision: currentLedger.revision, checksum: currentLedger.checksum };
  const nextLedger = {
    schemaVersion: 2,
    revision: Number(currentLedger.revision) + 1,
    updatedAt: createdAt,
    transactions: currentLedger.transactions.concat(additions),
    fundNames: fundNames
  };
  nextLedger.checksum = await checksumTransactions(nextLedger.transactions);
  return writeLedger(nextLedger, expected);
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
    schemaVersion: 2,
    revision: 1,
    updatedAt: now,
    riskAnchorValue: riskAnchorValue,
    riskAnchorAt: now,
    riskAnchorLedgerRevision: Number(currentLedger.revision),
    riskAnchorTransactionIds: currentLedger.transactions.map(function (transaction) { return String(transaction.id); }).filter(Boolean).sort(),
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
  return writeLedger(migrated, { revision: currentLedger.revision, checksum: currentLedger.checksum });
}

async function previewLegacy(portfolio) {
  const holdings = ((portfolio && portfolio.holdings) || []);
  const invalidHoldings = [];
  const codes = new Set();
  holdings.forEach(function (holding, index) {
    const code = String((holding && holding.code) || "").trim();
    if (!code) invalidHoldings.push({ index: index + 1, code: "-", reason: "MISSING_CODE" });
    else if (codes.has(code)) invalidHoldings.push({ index: index + 1, code: code, reason: "DUPLICATE_CODE" });
    else codes.add(code);
    if (!holding || !Array.isArray(holding.buys) || holding.buys.length === 0) {
      invalidHoldings.push({ index: index + 1, code: code || "-", reason: "MISSING_TRANSACTIONS" });
    }
  });
  const cloud = await readLedgerWithEtag(false);
  const cloudRevision = cloud.ledger ? Number(cloud.ledger.revision) : 0;
  const ledger = await migrateLegacyPortfolio(portfolio, cloudRevision + 1);
  const activeFundCount = derivePortfolio(ledger).holdings.length;
  if (activeFundCount !== holdings.length) {
    invalidHoldings.push({ index: 0, code: "-", reason: "ACTIVE_FUND_COUNT_MISMATCH" });
  }
  return {
    ledger: ledger,
    rawFundCount: holdings.length,
    activeFundCount: activeFundCount,
    invalidHoldings: invalidHoldings,
    transactionCount: ledger.transactions.length,
    totalInvested: ledger.transactions.reduce(function (sum, tx) { return sum + (tx.type === "BUY" ? tx.amount : -tx.amount); }, 0),
    checksum: ledger.checksum,
    cloudRevision: cloudRevision,
    cloudChecksum: cloud.ledger ? cloud.ledger.checksum : null,
    cloudEtag: cloud.etag,
    nextRevision: cloudRevision + 1
  };
}

async function overwriteWithLegacy(portfolio, preview) {
  const ledger = await migrateLegacyPortfolio(portfolio, Number(preview.cloudRevision) + 1);
  return writeLedger(ledger, {
    revision: preview.cloudRevision, checksum: preview.cloudChecksum, etag: preview.cloudEtag
  });
}

async function signIn() {
  if (!configured) throw new Error("FIREBASE_WEB_CONFIG_MISSING");
  if (!auth) throw new Error("FIREBASE_AUTH_NOT_READY");
  return signInWithPopup(auth, new GoogleAuthProvider());
}

async function initializeFirebase(preservePublicLedger) {
  if (!configured) {
    if (!preservePublicLedger) emit("qdii-cloud-state", { status: "CONFIG_MISSING", source: "未配置" });
    return;
  }
  await loadFirebaseModules();
  const app = initializeApp(config);
  auth = getAuth(app);
  database = getDatabase(app);
  await setPersistence(auth, browserLocalPersistence);
  onAuthStateChanged(auth, async function (user) {
    currentUser = user;
    if (!user) {
      if (preservePublicLedger) {
        currentLedger = publicLedgerSnapshot;
        currentDecisionState = loadPublicDecisionState();
        currentStrategyState = null;
        if (currentLedger) emitLedger("公开只读快照", true);
        emit("qdii-cloud-state", {
          status: "PUBLIC_SNAPSHOT", source: "公开账本快照", canSignIn: true
        });
        return;
      }
      currentLedger = null;
      currentDecisionState = null;
      currentStrategyState = null;
      emit("qdii-cloud-state", { status: "SIGNED_OUT", source: "未登录" });
      return;
    }
    emit("qdii-cloud-state", { status: "SYNCING", source: "正在同步", uid: user.uid });
    try { await loadLedger(); }
    catch (error) { emit("qdii-cloud-state", { status: "ERROR", source: navigator.onLine ? "同步失败" : "本地只读快照", error: error.message }); }
  });
}

async function bootstrap() {
  if (window.QDII_PUBLIC_PORTFOLIO_SNAPSHOT === true) {
    const publicLedger = window.QDII_PUBLIC_PORTFOLIO_LEDGER;
    emit("qdii-cloud-state", { status: "PUBLIC_SNAPSHOT", source: "公开账本快照", canSignIn: configured });
    if (!publicLedger) return;
    try {
      currentLedger = await validateLedger(publicLedger);
      publicLedgerSnapshot = currentLedger;
      currentDecisionState = loadPublicDecisionState();
      currentStrategyState = null;
      emitLedger("公开只读快照", true);
    } catch (error) {
      emit("qdii-cloud-state", { status: "ERROR", source: "公开账本快照无效", error: error.message });
      return;
    }
    await initializeFirebase(true);
    return;
  }
  await initializeFirebase(false);
}

window.QdiiCloudSync = {
  bootstrap: bootstrap, signIn: signIn, signOut: function () {
    if (!auth) throw new Error("FIREBASE_AUTH_NOT_READY");
    return signOut(auth);
  },
  loadLedger: loadLedger, saveLegacyPortfolio: saveLegacyPortfolio,
  appendBuyTransactions: appendBuyTransactions,
  previewLegacy: previewLegacy, overwriteWithLegacy: overwriteWithLegacy,
  initializeRiskAnchor: initializeRiskAnchor,
  initializePublicRiskAnchor: initializePublicRiskAnchor,
  getCurrentLedger: function () { return currentLedger; },
  getCurrentDecisionState: function () { return currentDecisionState; }
};

bootstrap();
