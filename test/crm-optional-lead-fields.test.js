'use strict';
/* CHANGELOG-optional-lead-fields.md — first-call intake relaxation (20/11/2026).
 * Patient name + phone are OPTIONAL when a lead is created/edited (the caller is
 * often ringing on behalf of someone else and won't give them); a typed phone
 * must still be valid. The name becomes required at ADMISSION, so no nameless
 * patient row is ever created. Names / phones are SYNTHETIC. crm.js is REAL. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const core = require('../public/crm/crm.js');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'crm', 'crm.js'), 'utf8');
const GS = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8');

test('new-lead form: name + phone are NOT required; source / house / assignedTo still are', () => {
  // a completely empty form flags only Vered's own fields — never name or phone
  const e0 = core.leadFormErrors({});
  assert.equal(e0.name, undefined);
  assert.equal(e0.phone, undefined);
  assert.equal(e0.source, 'יש לבחור מקור ליד');
  assert.equal(e0.assignedTo, 'יש לבחור משוייך ל');
  assert.ok(e0.house, 'house required unless ambulatory');
  // a partial (one-word) name + no phone, with the required fields filled → clean
  assert.deepEqual(core.leadFormErrors({ name: 'דנה', assignedTo: 'ורד', source: 'גוגל', house: 'רמות השבים' }), {});
  // «אמבולטורי» meeting lifts the house requirement
  assert.equal(core.leadFormErrors({ assignedTo: 'ורד', source: 'גוגל', meetingWith: 'אמבולטורי' }).house, undefined);
  // a TYPED phone must still be a valid Israeli number
  assert.ok(core.leadFormErrors({ phone: '123', assignedTo: 'ורד', source: 'גוגל', house: 'רמות השבים' }).phone);
  assert.equal(core.leadFormErrors({ phone: '052-765-4321', assignedTo: 'ורד', source: 'גוגל', house: 'רמות השבים' }).phone, undefined);
  // a contact name needs no relation anymore
  assert.equal(core.leadFormErrors({ contactName: 'רון', assignedTo: 'ורד', source: 'גוגל', house: 'רמות השבים' }).contactRelation, undefined);
});

test('new-lead form markup no longer marks name / phone required', () => {
  const form = SRC.slice(SRC.indexOf('function renderNewLeadForm()'), SRC.indexOf('function openNewLeadDrawer()'));
  assert.ok(!/field\('name', 'שם מלא \*'/.test(form), 'name no longer starred/required');
  assert.ok(!/field\('phone', 'טלפון \*'/.test(form), 'phone no longer starred/required');
  assert.match(form, /field\('name', 'שם \(לא חובה\)', 'text'\)/);
  assert.match(form, /field\('phone', 'טלפון \(לא חובה\)', 'tel'\)/);
});

test('leadLabel: a blank name shows a clickable placeholder, a real name shows itself', () => {
  assert.equal(core.leadLabel({ name: 'דנה כהן' }), 'דנה כהן');
  assert.equal(core.leadLabel({ name: '' }), '(ליד ללא שם)');
  assert.equal(core.leadLabel({ name: '   ' }), '(ליד ללא שם)');
  assert.equal(core.leadLabel(null), '(ליד ללא שם)');
  // the board card, the drawer head, the list rows and the search row all use it
  assert.ok(SRC.split('esc(leadLabel(l))').length - 1 >= 6, 'the fallback is applied at every lead-name render site');
});

test('admission REQUIRES a name, so a relaxed lead never becomes a nameless patient', () => {
  // the name field is missing → admission is refused
  assert.equal(core.admissionErrors({ houseId: 'ramot', date: '2026-11-20', pay: 5000 }, false).name, 'יש להזין שם מטופל/ת לפני קליטה');
  // with a name, the name check passes (other fields govern the rest)
  assert.equal(core.admissionErrors({ name: 'דנה כהן', houseId: 'ramot', date: '2026-11-20', pay: 5000 }, false).name, undefined);
  // the admit form carries a name input, pre-filled from the lead
  assert.match(SRC, /<label>שם מלא <input type="text" name="name" value="' \+ esc\(l\.name\)/);
  assert.match(SRC, /showErrs\(f, errs, \['name', 'houseId', 'date', 'pay', 'funder'\]\)/);
});

test("admissionRow takes the admitted name (what was typed), falling back to the lead's", () => {
  // a name typed at admission wins (a lead that was created nameless)
  assert.equal(core.admissionRow({ id: 'L1', name: '' }, { name: 'דנה כהן', houseId: 'ramot', date: '2026-11-20', pay: 1 }, 'p1').name, 'דנה כהן');
  // no typed value → the lead's own name
  assert.equal(core.admissionRow({ id: 'L1', name: 'רון לוי' }, { houseId: 'ramot', date: '2026-11-20', pay: 1 }, 'p1').name, 'רון לוי');
  // admitLead carries the admitted name back onto the lead row
  assert.match(SRC, /const nameSet = s\(v\.name\) && s\(v\.name\) !== s\(raw\.name\) \? \{ name: s\(v\.name\) \} : \{\};/);
});

test('server relaxation is documented in Code.gs (name optional, phone format kept)', () => {
  assert.match(GS, /a lead NAME is OPTIONAL/);
  assert.match(GS, /NON-EMPTY\s+\* phone must still be a valid Israeli number/);
  // the name violation is gone; only a present, changed, invalid phone refuses
  const fn = GS.slice(GS.indexOf('function leadRequiredViolations_'), GS.indexOf('function leadRequiredRefusalMessage_'));
  assert.ok(!/field: 'name'/.test(fn), 'no name refusal remains on the intake path');
  assert.match(fn, /phoneChanged && phone && !leadPhoneOk_\(l\.phone\)/);
});
