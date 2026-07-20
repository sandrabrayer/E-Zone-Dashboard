/* Regression tests for the getPayments 502 caused by the /api/sheets GET
 * diagnostics preview in server.js.
 *
 * Root cause: the GET handler built `lastLoad` diagnostics for EVERY action,
 * including a `patientsPreview` / `leadsPreview` via
 * `JSON.stringify(data.patients).slice(0, 4000)`. The getPayments response
 * `{ ok:true, payments:[...] }` has no `patients` / `leads` fields, so
 * JSON.stringify(undefined) returned undefined and `.slice()` threw
 * "Cannot read properties of undefined (reading 'slice')". That bubbled to the
 * catch, which returned 502, and the frontend fell back to state.payments = [],
 * making every paid mark in the גבייה tab look lost after reload.
 *
 * The fix extracted the preview construction into the pure helper
 * buildLoadPreviews(data) and guards each field on `!== undefined`, so a
 * missing field yields null instead of throwing. These tests exercise the REAL
 * shipped helper (required directly from server.js — which only listens when
 * run as the main module), locking the contract against the actual code. */

const { test } = require('node:test');
const assert = require('node:assert');
const { buildLoadPreviews } = require('../server');

test('getPayments-shaped response does not throw and yields null previews', () => {
  const payments = { ok: true, payments: [{ id: 'p1', amount: 100 }] };
  let previews;
  assert.doesNotThrow(() => {
    previews = buildLoadPreviews(payments);
  });
  assert.strictEqual(previews.patientsPreview, null);
  assert.strictEqual(previews.leadsPreview, null);
});

test('getData-shaped response populates both previews', () => {
  const data = {
    ok: true,
    leads: [{ id: 'L1', name: 'Test Lead' }],
    patients: { ramot: [{ id: 'P1', name: 'Test Patient' }] },
  };
  const previews = buildLoadPreviews(data);

  assert.strictEqual(typeof previews.patientsPreview, 'string');
  assert.strictEqual(typeof previews.leadsPreview, 'string');
  assert.deepStrictEqual(JSON.parse(previews.patientsPreview), data.patients);
  assert.deepStrictEqual(JSON.parse(previews.leadsPreview), data.leads);
});

test('previews are truncated to their documented caps', () => {
  const bigLeads = Array.from({ length: 500 }, (_, i) => ({ id: i, note: 'x'.repeat(50) }));
  const bigPatients = { house: Array.from({ length: 2000 }, (_, i) => ({ id: i })) };
  const previews = buildLoadPreviews({ leads: bigLeads, patients: bigPatients });

  assert.strictEqual(previews.leadsPreview.length, 1500);
  assert.strictEqual(previews.patientsPreview.length, 4000);
});

test('a present-but-empty field still yields a (non-null) preview', () => {
  // Distinguishes "field absent" (null) from "field present and empty" ("[]"),
  // confirming the guard keys on undefined, not on truthiness.
  const previews = buildLoadPreviews({ ok: true, leads: [], patients: {} });
  assert.strictEqual(previews.leadsPreview, '[]');
  assert.strictEqual(previews.patientsPreview, '{}');
});

test('non-object responses yield null previews without throwing', () => {
  for (const bad of [null, undefined, 'a string', 42]) {
    let previews;
    assert.doesNotThrow(() => {
      previews = buildLoadPreviews(bad);
    });
    assert.strictEqual(previews.patientsPreview, null);
    assert.strictEqual(previews.leadsPreview, null);
  }
});
