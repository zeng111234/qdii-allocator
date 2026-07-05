const test = require('node:test');
const assert = require('node:assert');

function freshRequire() {
  delete require.cache[require.resolve('../../lib/firebase-client')];
  return require('../../lib/firebase-client');
}

test('isFirebaseAvailable returns false when env vars are not set', function () {
  const origUrl = process.env.FIREBASE_URL;
  const origKey = process.env.FIREBASE_KEY;
  delete process.env.FIREBASE_URL;
  delete process.env.FIREBASE_KEY;
  const fb = freshRequire();
  assert.strictEqual(fb.isFirebaseAvailable(), false);
  process.env.FIREBASE_URL = origUrl;
  process.env.FIREBASE_KEY = origKey;
});

test('isFirebaseAvailable returns true when env vars are set', function () {
  const origUrl = process.env.FIREBASE_URL;
  const origKey = process.env.FIREBASE_KEY;
  process.env.FIREBASE_URL = 'https://test.firebaseio.com';
  process.env.FIREBASE_KEY = 'testkey';
  const fb = freshRequire();
  assert.strictEqual(fb.isFirebaseAvailable(), true);
  if (origUrl !== undefined) process.env.FIREBASE_URL = origUrl; else delete process.env.FIREBASE_URL;
  if (origKey !== undefined) process.env.FIREBASE_KEY = origKey; else delete process.env.FIREBASE_KEY;
});

test('firebaseGet returns null when env vars are not set', async function () {
  const origUrl = process.env.FIREBASE_URL;
  const origKey = process.env.FIREBASE_KEY;
  delete process.env.FIREBASE_URL;
  delete process.env.FIREBASE_KEY;
  const fb = freshRequire();
  const result = await fb.firebaseGet('/test.json');
  assert.strictEqual(result, null);
  if (origUrl !== undefined) process.env.FIREBASE_URL = origUrl; else delete process.env.FIREBASE_URL;
  if (origKey !== undefined) process.env.FIREBASE_KEY = origKey; else delete process.env.FIREBASE_KEY;
});

test('firebasePut returns false when env vars are not set', async function () {
  const origUrl = process.env.FIREBASE_URL;
  const origKey = process.env.FIREBASE_KEY;
  delete process.env.FIREBASE_URL;
  delete process.env.FIREBASE_KEY;
  const fb = freshRequire();
  const result = await fb.firebasePut('/test.json', { foo: 'bar' });
  assert.strictEqual(result, false);
  if (origUrl !== undefined) process.env.FIREBASE_URL = origUrl; else delete process.env.FIREBASE_URL;
  if (origKey !== undefined) process.env.FIREBASE_KEY = origKey; else delete process.env.FIREBASE_KEY;
});

test('loadPortfolioFromFirebase returns null when env vars are not set', async function () {
  const origUrl = process.env.FIREBASE_URL;
  const origKey = process.env.FIREBASE_KEY;
  delete process.env.FIREBASE_URL;
  delete process.env.FIREBASE_KEY;
  const fb = freshRequire();
  const result = await fb.loadPortfolioFromFirebase();
  assert.strictEqual(result, null);
  if (origUrl !== undefined) process.env.FIREBASE_URL = origUrl; else delete process.env.FIREBASE_URL;
  if (origKey !== undefined) process.env.FIREBASE_KEY = origKey; else delete process.env.FIREBASE_KEY;
});

test('savePortfolioToFirebase returns false when env vars are not set', async function () {
  const origUrl = process.env.FIREBASE_URL;
  const origKey = process.env.FIREBASE_KEY;
  delete process.env.FIREBASE_URL;
  delete process.env.FIREBASE_KEY;
  const fb = freshRequire();
  const result = await fb.savePortfolioToFirebase({ funds: [] });
  assert.strictEqual(result, false);
  if (origUrl !== undefined) process.env.FIREBASE_URL = origUrl; else delete process.env.FIREBASE_URL;
  if (origKey !== undefined) process.env.FIREBASE_KEY = origKey; else delete process.env.FIREBASE_KEY;
});
