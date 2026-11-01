'use strict';
/*
 * CRM-ID-01 — read-only regression *diagnosis* for merged #338.
 * NO application code changes, NO real clients, NO network and NO writes.
 *
 * These tests intentionally document the UNSAFE CURRENT behavior so that the
 * risk can be reproduced on the current merged base. They are NOT acceptance
 * tests for a fix. The test.todo entries below specify the future safe
 * contract and must be promoted to active tests with the future isolated
 * implementation PR.
 *
 * Business decision ARCH-01: do not link different people/episodes based
 * solely on name or phone; select and verify an exact lead id.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crm = require('../public/crm/crm.js');

const sharedPhone = '0521112233';
const leadA = {
  id: 'lead-aaa',
  name: 'אורי דוגמה',
  phone: sharedPhone,
  house: 'רמות השבים',
  stage: 'paid'
};
const leadB = {
  id: 'lead-bbb',
  name: 'דנה בדיקה',
  phone: '0509876543',
  house: 'רמות השבים',
  stage: 'visit'
};

test('REPRO P0 — a different person with one shared family phone is matched to lead A', () => {
  const selected = crm.openLeadOfPerson([leadA], 'מיכל בדיקה', sharedPhone);
  assert.equal(selected && selected.id, 'lead-aaa');
  assert.notEqual(selected.name, 'מיכל בדיקה');
});

test('REPRO P0 — different supplied phone falls back to another person with identical full name', () => {
  const selected = crm.openLeadOfPerson([leadA], 'אורי דוגמה', '0524445566');
  assert.equal(selected && selected.id, 'lead-aaa');
  assert.notEqual(selected.phone, '0524445566');
});

test('REPRO P0 — missing phone and identical full name still returns an automatic lead', () => {
  const selected = crm.openLeadOfPerson([leadA], 'אורי דוגמה', '');
  assert.equal(selected && selected.id, 'lead-aaa');
});

test('BASELINE — two matching open leads are marked ambiguous, not automatically selected', () => {
  const second = { ...leadB, phone: sharedPhone };
  assert.equal(crm.openLeadOfPerson([leadA, second], 'מיכל בדיקה', sharedPhone), 'ambiguous');
});

test('BASELINE — an exact lead already closed does not participate in proposed matching', () => {
  assert.equal(crm.openLeadOfPerson([{ ...leadA, stage: 'admitted' }], 'אורי דוגמה', sharedPhone), null);
});

// TARGET CONTRACT — activate only in the future implementation PR.
// A single candidate by contact phone MUST be considered a search suggestion
// at most, never authorization to admit it. The employee must select one
// specific lead and the backend must verify it still matches before writing.
test.todo('P0 future: a shared contact phone never admits a distinct person without exact leadId confirmation');
test.todo('P0 future: a namesake or mismatched supplied phone never silently reuses another person lead');
test.todo('P0 future: concurrent close/admit of the selected lead refuses stale association without side effects');
test.todo('P0 future: explicit selection is preserved on retry but never creates two stays or loses the source lead');
