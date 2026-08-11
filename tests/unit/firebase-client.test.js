const test = require("node:test");
const assert = require("node:assert/strict");

const firebase = require("../../lib/firebase-client");

test("privateLedgerPath trims whitespace around FIREBASE_UID", function() {
  const previous = {
    url: process.env.FIREBASE_URL,
    key: process.env.FIREBASE_KEY,
    uid: process.env.FIREBASE_UID
  };

  try {
    process.env.FIREBASE_URL = "https://example.firebaseio.com";
    process.env.FIREBASE_KEY = "test-key";
    process.env.FIREBASE_UID = "validUid_123-\r\n";

    assert.equal(
      firebase.privateLedgerPath(),
      "/users/validUid_123-/portfolioLedger.json"
    );
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      const envName = name === "url"
        ? "FIREBASE_URL"
        : name === "key"
          ? "FIREBASE_KEY"
          : "FIREBASE_UID";
      if (value === undefined) delete process.env[envName];
      else process.env[envName] = value;
    }
  }
});

test("isFirebaseAvailable requires a complete private-ledger configuration", function() {
  const previous = {
    url: process.env.FIREBASE_URL,
    key: process.env.FIREBASE_KEY,
    uid: process.env.FIREBASE_UID
  };

  try {
    process.env.FIREBASE_URL = "https://example.firebaseio.com";
    process.env.FIREBASE_KEY = "test-key";
    delete process.env.FIREBASE_UID;
    assert.equal(firebase.isFirebaseAvailable(), false);

    process.env.FIREBASE_UID = "valid_uid";
    assert.equal(firebase.isFirebaseAvailable(), true);
  } finally {
    if (previous.url === undefined) delete process.env.FIREBASE_URL;
    else process.env.FIREBASE_URL = previous.url;
    if (previous.key === undefined) delete process.env.FIREBASE_KEY;
    else process.env.FIREBASE_KEY = previous.key;
    if (previous.uid === undefined) delete process.env.FIREBASE_UID;
    else process.env.FIREBASE_UID = previous.uid;
  }
});

test("private ledger reconciliation exposes ETag guarded read and write helpers", function () {
  assert.equal(typeof firebase.loadPortfolioLedgerWithEtag, "function");
  assert.equal(typeof firebase.savePortfolioLedgerIfMatch, "function");
});
