/* Tests for the lead contact fields (foundation only — no UI).
 *
 * Context: a lead's name/phone now semantically mean the PATIENT (פרטי המטופל).
 * Four new columns carry the REFERRER's contact details (פרטי הפונה) plus a
 * dedicated billing/updates phone (טלפון לגבייה ועדכונים):
 *   contactName, contactPhone, contactRelation, billingPhone
 *
 * Two source files are exercised, each loaded in its own vm sandbox the same
 * way the existing suite does it (see meeting-outcome-foundation.test.js):
 *   - apps-script/Code.gs — for LEAD_COLUMNS (append-only order contract) and
 *     the derived IRRELEVANT_LEAD_COLUMNS / REMOVED_LEAD_COLUMNS (which must
 *     inherit the new columns via .concat()). Code.gs is Google Apps Script
 *     with no module.exports and its helpers touch SpreadsheetApp, so we read
 *     the source and evaluate it in a sandbox; the constants asserted on are
 *     plain top-level `const`s with no side effects.
 *   - public/app.js — for normalizeLead / normalizeIrrelevantLead /
 *     normalizeRemovedLead, loaded by appending an epilogue exposing them and
 *     evaluating with the browser globals stubbed.
 *
 * The contract locked here:
 *   - LEAD_COLUMNS ends with contactName, contactPhone, contactRelation,
 *     billingPhone in that exact order, immediately after meetingOutcome
 *     (readSheet_ maps cells to keys by position, so any reorder or mid-array
 *     insert would silently corrupt reads);
 *   - the four fields flow into the derived irrelevant/removed schemas;
 *   - normalizeLead preserves each field when present and defaults it to
 *     present-but-blank '' when absent (legacy rows, no backfill) — none is
 *     silently dropped on a round-trip;
 *   - normalizeIrrelevantLead / normalizeRemovedLead carry the four fields too
 *     (they build on normalizeLead's output). */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const NEW_FIELDS = ['contactName', 'contactPhone', 'contactRelation', 'billingPhone'];

function loadCode() {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'apps-script', 'Code.gs'),
    'utf8'
  );
  const epilogue = `
    globalThis.__test = {
      LEAD_COLUMNS: LEAD_COLUMNS,
      IRRELEVANT_LEAD_COLUMNS: IRRELEVANT_LEAD_COLUMNS,
      REMOVED_LEAD_COLUMNS: REMOVED_LEAD_COLUMNS,
    };
  `;
  const noop = () => {};
  const sandbox = {
    console: { log: noop, warn: noop, error: noop, info: noop },
    JSON, Math, Date, Number, String, Array, Object, RegExp,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src + epilogue, sandbox);
  return sandbox.__test;
}

function loadApp() {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'app.js'),
    'utf8'
  );
  const epilogue = `
    globalThis.__test = {
      normalizeLead:          (l) => normalizeLead(l),
      normalizeIrrelevantLead:(l) => normalizeIrrelevantLead(l),
      normalizeRemovedLead:   (l) => normalizeRemovedLead(l),
    };
  `;
  const noop = () => {};
  const sandbox = {
    console: { log: noop, warn: noop, error: noop, info: noop },
    location: { origin: 'http://test', href: 'http://test/' },
    document: { addEventListener: noop, getElementById: () => null },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    URLSearchParams,
    Math, Date, JSON, Number, String, Array, Object, RegExp, Promise,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src + epilogue, sandbox);
  return sandbox.__test;
}

const code = loadCode();
const app = loadApp();

/* ===== Backend schema ===== */

test('LEAD_COLUMNS carries the four contact fields contiguously, after meetingOutcome', () => {
  const cols = Array.from(code.LEAD_COLUMNS);
  // Immediately after meetingOutcome, contiguous and in the specified order
  // (append-only: no gap, no reorder). Originally the terminal slice; later
  // appends (waitlistedAt) may follow, but nothing may come between them.
  const owIdx = cols.indexOf('meetingOutcome');
  assert.ok(owIdx > 0, 'meetingOutcome must still be present');
  assert.deepStrictEqual(cols.slice(owIdx + 1, owIdx + 1 + NEW_FIELDS.length), NEW_FIELDS,
    'the four contact fields must sit contiguously right after meetingOutcome');
  // Each new column appears exactly once (no accidental duplicate).
  NEW_FIELDS.forEach((f) => {
    assert.strictEqual(cols.filter((c) => c === f).length, 1, `${f} must appear exactly once`);
  });
});

test('derived irrelevant/removed schemas inherit the four contact fields', () => {
  const irr = Array.from(code.IRRELEVANT_LEAD_COLUMNS);
  const rem = Array.from(code.REMOVED_LEAD_COLUMNS);
  NEW_FIELDS.forEach((f) => {
    assert.ok(irr.indexOf(f) !== -1, `IRRELEVANT_LEAD_COLUMNS must carry ${f}`);
    assert.ok(rem.indexOf(f) !== -1, `REMOVED_LEAD_COLUMNS must carry ${f}`);
  });
});

/* ===== Frontend normalization ===== */

test('normalizeLead preserves all four contact fields when present', () => {
  const out = app.normalizeLead({
    id: 'L1', name: 'מטופל', stage: 'new',
    contactName: 'רותי', contactPhone: '0501234567',
    contactRelation: 'אחות', billingPhone: '0539876543',
  });
  assert.strictEqual(out.contactName, 'רותי');
  assert.strictEqual(out.contactPhone, '0501234567');
  assert.strictEqual(out.contactRelation, 'אחות');
  assert.strictEqual(out.billingPhone, '0539876543');
});

test('normalizeLead defaults each contact field to present-but-blank on legacy rows', () => {
  const out = app.normalizeLead({ id: 'L2', name: 'ליד ישן', stage: 'new' });
  NEW_FIELDS.forEach((f) => {
    assert.ok(f in out, `${f} key must be present`);
    assert.strictEqual(out[f], '', `${f} must default to ''`);
  });
});

test('normalizeLead does not silently drop the contact fields on round-trip', () => {
  const first = app.normalizeLead({
    id: 'L3', name: 'x',
    contactName: 'דנה', contactPhone: '0521112222',
    contactRelation: 'בן', billingPhone: '0523334444',
  });
  const second = app.normalizeLead(first);
  NEW_FIELDS.forEach((f) => {
    assert.strictEqual(second[f], first[f], `${f} must survive a normalize round-trip`);
  });
});

test('normalizeIrrelevantLead carries the four contact fields', () => {
  const out = app.normalizeIrrelevantLead({
    id: 'L4', name: 'x',
    contactName: 'שרה', contactPhone: '0501110000',
    contactRelation: 'אם', billingPhone: '0502220000',
    originSheet: 'new', movedAt: '2026-01-01T00:00:00Z',
  });
  assert.strictEqual(out.contactName, 'שרה');
  assert.strictEqual(out.contactPhone, '0501110000');
  assert.strictEqual(out.contactRelation, 'אם');
  assert.strictEqual(out.billingPhone, '0502220000');
  // Defaults to '' when absent, same as the base lead.
  const bare = app.normalizeIrrelevantLead({ id: 'L5', name: 'y' });
  NEW_FIELDS.forEach((f) => assert.strictEqual(bare[f], ''));
});

test('normalizeRemovedLead carries the four contact fields', () => {
  const out = app.normalizeRemovedLead({
    id: 'L6', name: 'x',
    contactName: 'יוסי', contactPhone: '0509998888',
    contactRelation: 'אב', billingPhone: '0507776666',
    removedAt: '2026-02-02T00:00:00Z', originSheet: 'Leads',
  });
  assert.strictEqual(out.contactName, 'יוסי');
  assert.strictEqual(out.contactPhone, '0509998888');
  assert.strictEqual(out.contactRelation, 'אב');
  assert.strictEqual(out.billingPhone, '0507776666');
  const bare = app.normalizeRemovedLead({ id: 'L7', name: 'y' });
  NEW_FIELDS.forEach((f) => assert.strictEqual(bare[f], ''));
});
