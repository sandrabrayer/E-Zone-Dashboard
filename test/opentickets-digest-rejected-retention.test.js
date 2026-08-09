/* Tests for the OpenTickets digest inclusion rule in apps-script/Code.gs.
 *
 * Code.gs is Google Apps Script — no module.exports. Like
 * coordinators-patients-digest.test.js, we read the source and evaluate it in a
 * vm sandbox, then reach the REAL shipped functions:
 *   - isDigestTicket        : the base "is this an OPEN ticket" predicate
 *   - digestIncludeTicket_  : the full inclusion rule (open always; terminal
 *                             completed/closed/rejected kept for the archive
 *                             window, then dropped)
 *   - buildOpenTicketsRows_ : the pure tickets → digest-rows projection
 * This locks the contract against the actual code, not a reimplementation.
 *
 * BEHAVIOR UNDER TEST — rejected retention:
 *   A rejected (לא אושר) request no longer disappears the instant it is
 *   rejected. It stays in the digest for archive_after_days (7 days, the same
 *   window as completed/closed) after the rejection, carrying its RED status so
 *   a coordinator can see the request was denied — then it drops out.
 *   See DIGEST-CONTRACT.md ("OpenTickets feed"). */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadTickets() {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'apps-script', 'Code.gs'),
    'utf8'
  );

  // Shares lexical scope with the top-level consts, so we can reach the real
  // OpenTickets inclusion-rule helpers through a small test facade.
  const epilogue = `
    globalThis.__test = {
      isOpen(t) { return isDigestTicket(t); },
      statusClass(v) { return digestTicketStatusClass_(v); },
      statusColor(c) { return digestTicketStatusColor_(c); },
      include(t, nowIso, days) {
        return digestIncludeTicket_(t, digestParseMs_(nowIso), days);
      },
      buildRows(tickets, nowIso, days) { return buildOpenTicketsRows_(tickets, nowIso, days); },
      columns() { return OPEN_TICKETS_COLUMNS.slice(); },
      tabName() { return OPEN_TICKETS_TAB; },
      archiveAfterDays() { return DIGEST_TICKET_ARCHIVE_AFTER_DAYS; },
    };
  `;

  const noop = () => {};
  const sandbox = {
    console: { log: noop, warn: noop, error: noop, info: noop },
    JSON, Math, Date, Number, String, Array, Object, RegExp,
    // Code.gs references these at the top level; unused by the pure helpers here
    // but present so the module body evaluates cleanly.
    PropertiesService: { getScriptProperties() { return { getProperty() { return null; }, setProperty() { return this; } }; } },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src + epilogue, sandbox);
  return sandbox.__test;
}

const api = loadTickets();
const plain = (v) => JSON.parse(JSON.stringify(v));
const OPEN_TICKETS_COLUMNS_SORTED = ['house', 'status', 'statusColor', 'subject', 'ticketId', 'updatedAt'];

// A fixed "now" for deterministic aging math.
const NOW = '2026-08-09T12:00:00.000Z';
const NOW_MS = Date.parse(NOW);
const DAY_MS = 24 * 60 * 60 * 1000;
const iso = (msAgo) => new Date(NOW_MS - msAgo).toISOString();
const daysAgo = (n) => iso(n * DAY_MS);

test('the archive window is 7 days', () => {
  assert.strictEqual(api.archiveAfterDays(), 7);
});

test('status classification maps Hebrew labels + english/id aliases', () => {
  assert.strictEqual(api.statusClass('open'), 'open');
  assert.strictEqual(api.statusClass('פתוח'), 'open');
  assert.strictEqual(api.statusClass('completed'), 'completed');
  assert.strictEqual(api.statusClass('הושלם'), 'completed');
  assert.strictEqual(api.statusClass('closed'), 'closed');
  assert.strictEqual(api.statusClass('סגור'), 'closed');
  assert.strictEqual(api.statusClass('rejected'), 'rejected');
  assert.strictEqual(api.statusClass('לא אושר'), 'rejected');
  assert.strictEqual(api.statusClass('REJECTED'), 'rejected');
  // Unknown / blank → no class (not a digest ticket).
  assert.strictEqual(api.statusClass('whatever'), '');
  assert.strictEqual(api.statusClass(''), '');
  assert.strictEqual(api.statusClass(null), '');
});

test('isDigestTicket is true only for OPEN tickets', () => {
  assert.strictEqual(api.isOpen({ status: 'open' }), true);
  assert.strictEqual(api.isOpen({ status: 'פתוח' }), true);
  assert.strictEqual(api.isOpen({ status: 'completed' }), false);
  assert.strictEqual(api.isOpen({ status: 'rejected' }), false);
  assert.strictEqual(api.isOpen(null), false);
});

test('open tickets are always included, regardless of age', () => {
  assert.strictEqual(api.include({ status: 'open', updatedAt: daysAgo(999) }, NOW), true);
});

test('rejected is VISIBLE within the 7-day window, and RED', () => {
  const rejectedYesterday = { id: 'T1', subject: 'תקציב נוסף', status: 'rejected', rejectedAt: daysAgo(1) };
  assert.strictEqual(api.include(rejectedYesterday, NOW), true);

  const rows = api.buildRows([rejectedYesterday], NOW);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].status, 'rejected');
  assert.strictEqual(rows[0].statusColor, 'red'); // reads as denied
  assert.strictEqual(rows[0].ticketId, 'T1');
});

test('rejected DROPS OUT after the 7-day window (no longer vanishes immediately, but does age out)', () => {
  const rejectedLongAgo = { id: 'T2', subject: 'העברת דייר', status: 'rejected', rejectedAt: daysAgo(8) };
  assert.strictEqual(api.include(rejectedLongAgo, NOW), false);
  assert.strictEqual(api.buildRows([rejectedLongAgo], NOW).length, 0);
});

test('rejected at exactly 7 days has aged out (window is [ts, ts+7d))', () => {
  const rejectedExactly7 = { id: 'T3', subject: 'x', status: 'rejected', rejectedAt: daysAgo(7) };
  assert.strictEqual(api.include(rejectedExactly7, NOW), false);
});

test('rejected uses updated_at when there is no dedicated rejection timestamp', () => {
  const noDedicatedField = { id: 'T4', subject: 'y', status: 'rejected', updatedAt: daysAgo(2) };
  assert.strictEqual(api.include(noDedicatedField, NOW), true);
  const aged = { id: 'T5', subject: 'z', status: 'rejected', updated_at: daysAgo(10) };
  assert.strictEqual(api.include(aged, NOW), false);
});

test('rejected retention matches completed/closed exactly (same window)', () => {
  for (const status of ['completed', 'closed', 'rejected']) {
    const within = { id: status + '-in', subject: 's', status, updatedAt: daysAgo(3) };
    const past   = { id: status + '-out', subject: 's', status, updatedAt: daysAgo(9) };
    assert.strictEqual(api.include(within, NOW), true, status + ' within window');
    assert.strictEqual(api.include(past, NOW), false, status + ' past window');
  }
});

test('a rejected ticket with no parseable timestamp is kept (never silently vanishes)', () => {
  const noTs = { id: 'T6', subject: 'no timestamps', status: 'rejected' };
  assert.strictEqual(api.include(noTs, NOW), true);
});

test('unknown-status rows are not digest tickets', () => {
  assert.strictEqual(api.include({ id: 'X', subject: 's', status: 'draft' }, NOW), false);
  assert.strictEqual(api.buildRows([{ id: 'X', subject: 's', status: 'draft' }], NOW).length, 0);
});

test('projection: rejected within window renders red; only identified tickets become rows', () => {
  const rows = api.buildRows(
    [
      { id: 'A', subject: 'פתוח עכשיו', status: 'open', house: 'asher' },
      { id: 'B', subject: 'נדחה אתמול', status: 'rejected', rejectedAt: daysAgo(2), house: 'רמות השבים' },
      { id: 'C', subject: 'נדחה מזמן', status: 'rejected', rejectedAt: daysAgo(30) }, // aged out
      { id: '', subject: '   ', status: 'open' }, // no id and no subject → dropped
    ],
    NOW
  );

  assert.strictEqual(rows.length, 2);
  const open = rows.find((r) => r.ticketId === 'A');
  const rej = rows.find((r) => r.ticketId === 'B');
  assert.deepStrictEqual(plain(open), {
    house: 'raanana', ticketId: 'A', subject: 'פתוח עכשיו', status: 'open', statusColor: '', updatedAt: NOW,
  });
  assert.deepStrictEqual(plain(rej), {
    house: 'ramot', ticketId: 'B', subject: 'נדחה אתמול', status: 'rejected', statusColor: 'red', updatedAt: NOW,
  });

  // Every row exposes exactly the frozen OpenTickets column set.
  for (const row of rows) {
    assert.deepStrictEqual(Object.keys(plain(row)).sort(), OPEN_TICKETS_COLUMNS_SORTED);
  }
});

test('column contract + tab name are frozen', () => {
  assert.deepStrictEqual(plain(api.columns()), ['house', 'ticketId', 'subject', 'status', 'statusColor', 'updatedAt']);
  assert.strictEqual(api.tabName(), 'OpenTickets');
});

test('archiveAfterDays is configurable (retention window can be overridden)', () => {
  const rejected5dAgo = { id: 'T7', subject: 's', status: 'rejected', rejectedAt: daysAgo(5) };
  assert.strictEqual(api.include(rejected5dAgo, NOW, 3), false); // 3-day window → aged out
  assert.strictEqual(api.include(rejected5dAgo, NOW, 10), true); // 10-day window → still in
});
