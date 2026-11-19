'use strict';
/* CHANGELOG-crm-native-patient-edit.md — the patient card is edited inside the CRM
 * (name + the existing date/pay/status/notes), for in-house AND released patients,
 * instead of the «עריכה מלאה בדשבורד» link to the classic page. Phone / contact live
 * on the linked lead and open its own native edit. Pure rules + source wiring here;
 * the real page is a scenario in test/crm-shell-browser.test.js. SYNTHETIC data. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const core = require('../public/crm/crm.js');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'crm', 'crm.js'), 'utf8');
const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'crm', 'crm.html'), 'utf8');

const PAT = (o) => Object.assign({ id: 'p1', name: 'מיכל גרנט', houseId: 'ramot', date: '2026-07-22', pay: 9000, adv: 0, status: 'active', notes: 'הערה', fromLead: 'L1' }, o || {});

test('name is required only when the form carries it; a subset form (released: name + notes) is valid without date/pay/status', () => {
  assert.deepEqual(core.patientEditErrors({ name: 'מיכל גרנט', notes: 'x' }), {});
  assert.deepEqual(core.patientEditErrors({ name: '   ', notes: 'x' }), { name: 'יש להזין שם' });
  assert.deepEqual(core.patientEditErrors({ name: 'מיכל', date: '2026-07-22', pay: '9000', status: 'active' }), {});
  // the in-house rules still apply when those fields ARE present
  assert.deepEqual(core.patientEditErrors({ name: 'מ', date: 'nope', pay: '9000', status: 'active' }).date, 'תאריך כניסה חסר או מחוץ לטווח');
  assert.deepEqual(core.patientEditErrors({ name: 'מ', date: '2026-07-22', pay: '-5', status: 'active' }).pay, 'סכום חודשי לא תקין');
  assert.deepEqual(core.patientEditErrors({ name: 'מ', date: '2026-07-22', pay: '1', status: 'ghost' }).status, 'סטטוס לא תקין');
  // a form with no name field at all (legacy) is unaffected by the name rule
  assert.ok(!('name' in core.patientEditErrors({ date: '2026-07-22', pay: '1', status: 'active' })));
});

test('the patient row changes ONLY the fields the form carried; name is trimmed and space-collapsed', () => {
  assert.deepEqual(core.patientEditNext(PAT(), { name: '  מיכל   גרנט-לוי ', notes: 'חדש' }),
    PAT({ name: 'מיכל גרנט-לוי', notes: 'חדש' }));
  assert.deepEqual(core.patientEditNext(PAT(), { date: '2026-08-01', pay: '1200', adv: '100', status: 'wait', notes: 'z' }),
    PAT({ date: '2026-08-01', pay: 1200, adv: 100, status: 'wait', notes: 'z' }));
  // a released name/notes edit keeps the exit date, status and money untouched
  const rel = PAT({ status: 'released', exitDate: '2026-11-19', pay: 9000 });
  assert.deepEqual(core.patientEditNext(rel, { name: 'מיכל גרנט', notes: 'עדכון' }), PAT({ status: 'released', exitDate: '2026-11-19', pay: 9000, notes: 'עדכון' }));
});

test('the patient card no longer links to the classic page; editing (name + fields) lives in the card', () => {
  // the overview no longer RENDERS a patient «עריכה מלאה בדשבורד» link (the phrase may stay in comments)
  assert.ok(!/>עריכה מלאה בדשבורד<\/a>/.test(SRC));
  assert.ok(!SRC.includes('<p><a class="btn" href="/?view=classic">'));
  // the in-house edit form gained a name field
  const acts = SRC.slice(SRC.indexOf('function renderPatientActions'), SRC.indexOf('function findPatientRow'));
  assert.match(acts, /data-form="patient-edit"[\s\S]*<label>שם <input type="text" name="name"/);
  assert.match(acts, /value="' \+ esc\(raw\.name\)/);
  assert.match(acts, /linkedLeadEdit\(p\)/);
  // released patients now get a native name/notes edit (+ the transfer block)
  const rel = SRC.slice(SRC.indexOf('function releasedEditBlock'), SRC.indexOf('function releasedPatientBlock'));
  assert.match(rel, /עריכת פרטי המטופל\/ת/);
  assert.match(rel, /name="name"[\s\S]*name="notes"/);
  assert.ok(!/name="date"|name="pay"|name="status"/.test(rel), 'released: no stay-date / money / status here');
  // the finance note dropped its classic link
  assert.ok(!/כל הפעולות על החשבון זמינות כאן\. <a href="\/\?view=classic">/.test(SRC));
});

test('טלפון ופרטי קשר open the linked lead\'s own native edit — only when the lead is on the board and the user may edit', () => {
  const fn = SRC.slice(SRC.indexOf('function linkedLeadEdit'), SRC.indexOf('function releasedPatientBlock'));
  assert.match(fn, /if \(!fl \|\| !rawLead\(fl\) \|\| \(state\.me && state\.me\.view === 'controller'\)\) return '';/);
  assert.match(fn, /c\.leads\.some\(function \(l\) \{ return s\(l\.id\) === fl; \}\)/);
  assert.match(fn, /data-open-linked-lead="' \+ esc\(fl\)/);
  // the click opens the lead card and expands its edit — no classic navigation
  assert.match(SRC, /closest\('\[data-open-linked-lead\]'\)/);
  assert.match(SRC, /openDrawer\('lead', s\(t\.dataset\.openLinkedLead\)\);\s*openLeadEdit\(\);/);
});

test('the classic page stays reachable by URL and the remaining classic links are the unmigrated ops only', () => {
  // routing is untouched — ?view=classic still serves the classic page (that infra is not a UI link)
  assert.match(HTML, /href="\/\?view=classic">חזרה לדשבורד הרגיל/, 'the global escape hatch stays (rare admin ops)');
  // the removed links are gone; the unmigrated ones remain (Ortal billing-control, unknown-house)
  assert.ok(!/<p><a class="btn" href="\/\?view=classic">/.test(SRC), 'the patient-card link is gone');
  assert.ok(SRC.includes('id="crm-controller-classic"'), 'Ortal\'s billing-control link is untouched');
  assert.match(SRC, /בית לא מזוהה<\/strong>/, 'the unknown-house fix link remains');
});
