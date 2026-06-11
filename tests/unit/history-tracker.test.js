/**
 * Tests for lib/history-tracker.js
 * Uses Node.js built-in test runner (node:test)
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const HISTORY_FILE = path.join(__dirname, '..', '..', 'data', 'history.json');
const BACKUP_FILE = HISTORY_FILE + '.test-backup';

function backupHistory() {
  if (fs.existsSync(HISTORY_FILE)) {
    fs.copyFileSync(HISTORY_FILE, BACKUP_FILE);
  }
}

function restoreHistory() {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      if (fs.existsSync(BACKUP_FILE)) {
        fs.copyFileSync(BACKUP_FILE, HISTORY_FILE);
        fs.unlinkSync(BACKUP_FILE);
      }
      return;
    } catch (e) {
      if (attempt < 2) {
        const start = Date.now();
        while (Date.now() - start < 100) {}
      }
    }
  }
}

function resetHistory(data) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      fs.writeFileSync(HISTORY_FILE, JSON.stringify(data, null, 2), 'utf-8');
      return;
    } catch (e) {
      if (attempt < 2) {
        const start = Date.now();
        while (Date.now() - start < 100) {}
      }
    }
  }
}

test('getRecentPicks - counts consecutive days from most recent records', function () {
  const ht = require('../../lib/history-tracker');
  backupHistory();
  try {
    resetHistory({
      records: [
        { date: '2026-06-09', ranked: [{ code: '270042' }] },
        { date: '2026-06-10', ranked: [{ code: '270042' }] }
      ]
    });

    const picks = ht.getRecentPicks();
    assert.strictEqual(picks['270042'], 2);
  } finally {
    restoreHistory();
  }
});

test('loadHistoryContext - calculates success rate based on followUp5dReturn', function () {
  const ht = require('../../lib/history-tracker');
  backupHistory();
  try {
    resetHistory({
      records: [
        { date: '2026-06-08', ranked: [{ code: 'A', followUp5dReturn: 1.2 }] },
        { date: '2026-06-09', ranked: [{ code: 'A', followUp5dReturn: -0.5 }] },
        { date: '2026-06-10', ranked: [{ code: 'B', followUp5dReturn: 0.3 }] }
      ]
    });

    const ctx = ht.loadHistoryContext([{ code: 'A' }, { code: 'B' }]);
    assert.strictEqual(ctx['A'].appearances, 2);
    assert.strictEqual(ctx['A'].successes, 1);
    assert.strictEqual(ctx['A'].successRate, 0.5);
    assert.strictEqual(ctx['B'].appearances, 1);
    assert.strictEqual(ctx['B'].successes, 1);
    assert.strictEqual(ctx['B'].successRate, 1);
  } finally {
    restoreHistory();
  }
});

test('backfillFollowUp - fills 5d and 10d returns using index-based lookup', function () {
  const ht = require('../../lib/history-tracker');
  backupHistory();
  try {
    resetHistory({
      records: [
        {
          date: '2026-06-03',
          ranked: [
            { code: 'A', followUp5dReturn: null, followUp10dReturn: null }
          ]
        }
      ]
    });

    const navCache = {
      A: [
        { date: '2026-06-03', nav: 10 },
        { date: '2026-06-04', nav: 10.1 },
        { date: '2026-06-05', nav: 10.2 },
        { date: '2026-06-06', nav: 10.3 },
        { date: '2026-06-07', nav: 10.4 },
        { date: '2026-06-08', nav: 10.5 },
        { date: '2026-06-09', nav: 10.6 },
        { date: '2026-06-10', nav: 10.7 },
        { date: '2026-06-11', nav: 10.8 },
        { date: '2026-06-12', nav: 10.9 },
        { date: '2026-06-13', nav: 11 },
        { date: '2026-06-14', nav: 11.1 },
        { date: '2026-06-15', nav: 11.2 },
        { date: '2026-06-16', nav: 11.3 }
      ]
    };

    const updated = ht.backfillFollowUp(navCache);
    const data = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'));
    const alloc = data.records[0].ranked[0];

    assert.ok(updated >= 1);
    assert.ok(alloc.followUp5dReturn !== null);
    assert.ok(alloc.followUp10dReturn !== null);
    assert.strictEqual(alloc.followUp5dReturn, 5);
    assert.strictEqual(alloc.followUp10dReturn, 10);
  } finally {
    restoreHistory();
  }
});
