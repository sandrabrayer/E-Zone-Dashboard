'use strict';
// CRM restructure, Session A: the docs/crm/ spec set is present, the spec is
// kept verbatim under its Decisions header, and the docs carry no secret
// values, /exec URLs or e-mail addresses (names of secrets only).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const DIR = path.join(ROOT, 'docs', 'crm');
const DOCS = ['SPEC.md', 'CURRENT-STATE.md', 'PERMISSIONS-MATRIX.md', 'LINKED-APPS.md', 'GAP-LIST.md', 'ROLLOUT.md'];
const read = (f) => fs.readFileSync(path.join(DIR, f), 'utf8');

test('docs/crm holds the six Session A documents', () => {
  for (const f of DOCS) assert.ok(fs.existsSync(path.join(DIR, f)), f + ' missing');
});

test('SPEC.md keeps the Decisions header before the verbatim Hebrew spec', () => {
  const spec = read('SPEC.md');
  const decisions = spec.indexOf('## Decisions');
  const body = spec.indexOf('שינוי הדשבורד למערכת CRM של E-ZONE');
  assert.ok(decisions > 0, 'Decisions header');
  assert.ok(body > decisions, 'spec text follows the Decisions');
  for (const d of ['D1', 'D2', 'D3', 'D4']) assert.match(spec, new RegExp('\\| ' + d + ' \\|'));
  assert.match(spec, /Ron = ניהול בית only, no Dashboard access/);
  assert.match(spec, /Ortal is NOT הנהלה/);
  // First and last spec sections survive verbatim.
  assert.match(spec, /1\. המטרה והיקף הגרסה הראשונה/);
  assert.match(spec, /16\. תנאי הקבלה/);
  assert.match(spec, /המטרה היא מערכת שבה כל בעל תפקיד רואה את העבודה שלו/);
});

test('the CRM docs carry no secret values, /exec URLs or e-mail addresses', () => {
  for (const f of DOCS) {
    const text = read(f);
    assert.doesNotMatch(text, /script\.google\.com\/macros\/s\//, f + ': /exec URL');
    assert.doesNotMatch(text, /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, f + ': e-mail address');
  }
});

test('EZONE-ECOSYSTEM-STATUS.md records Session A and CHANGELOG-crm-spec.md exists', () => {
  const ess = fs.readFileSync(path.join(ROOT, 'EZONE-ECOSYSTEM-STATUS.md'), 'utf8');
  assert.match(ess, /^## CRM restructure — Session A/m);
  assert.ok(fs.existsSync(path.join(ROOT, 'CHANGELOG-crm-spec.md')));
});
