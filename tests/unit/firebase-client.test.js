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
