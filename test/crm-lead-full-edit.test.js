'use strict';
/* CHANGELOG-crm-lead-full-edit.md — the whole lead is edited inside the CRM card
 * («עריכת פרטי הליד») instead of the «עריכה מלאה בדשבורד» link to the classic page.
 * Pure rules + source wiring here; the real page is a scenario in
 * test/crm-shell-browser.test.js. Names and phones are SYNTHETIC. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const core = require('../public/crm/crm.js');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'crm', 'crm.js'), 'utf8');
const CSS = fs.readFileSync(path.join(__dirname, '..', 'public', 'crm', 'crm.css'), 'utf8');
const GS = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8');

const TODAY = '2026-11-17';
const LEAD = () => ({ id: 'L1', name: 'דנה כהן', phone: '0501111111', house: 'ramot', source: 'גוגל', note: 'אמא מתקשרת בערב', stage: 'visit',
  visitDate: '2026-11-20', visitTime: '10:00', entryDate: '', advance: '', created: '2026-11-10', assignedTo: 'ורד', meetingWith: 'אורן', meetingOutcome: '',
  contactName: 'רות כהן', contactPhone: '0502222222', contactRelation: 'אמא', billingPhone: '' });
const plan = (lead, over) => core.leadEditPlan(lead, Object.assign(core.leadEditValues(lead), over || {}), TODAY);

test('the form starts from the lead as stored; saving it untouched changes nothing', () => {
  const v = core.leadEditValues(LEAD());
  assert.deepEqual(v, { name: 'דנה כהן', phone: '0501111111', contactName: 'רות כהן', contactPhone: '0502222222', contactRelation: 'אמא', contactRelationOther: '',
    billingMode: 'patient', billingOther: '', house: 'רמות השבים', source: 'גוגל', assignedTo: 'ורד', created: '2026-11-10', entryDate: '', note: 'אמא מתקשרת בערב', track: 'private' });
  assert.deepEqual(plan(LEAD()), { errors: {}, patch: {} });
  assert.deepEqual(core.leadEditPlan(null, null, TODAY), { errors: {}, patch: {} }, 'never throws on nothing');
});

test('every field of the lead is editable, and the patch carries ONLY what changed', () => {
  const p = plan(LEAD(), { name: '  דנה   כהן-לוי ', phone: '052-333 4444', contactName: 'יוסי כהן', contactPhone: '+972504445555', contactRelation: 'אבא',
    house: 'קיסריה עפרוני', source: 'בית חולים', assignedTo: 'דנה', created: '2026-11-09', note: 'שורה א\r\nשורה ב  ' });
  assert.deepEqual(p.errors, {});
  assert.deepEqual(p.patch, { name: 'דנה כהן-לוי', phone: '0523334444', contactName: 'יוסי כהן', contactPhone: '0504445555', contactRelation: 'אבא',
    house: 'קיסריה עפרוני', source: 'בית חולים', assignedTo: 'דנה', created: '2026-11-09', note: 'שורה א\nשורה ב' });
  assert.deepEqual(plan(LEAD(), { note: 'רק הערה' }).patch, { note: 'רק הערה' }, 'one field → one key');
  for (const k of ['stage', 'visitDate', 'visitTime', 'meetingWith', 'meetingOutcome', 'id', 'advance'])
    assert.ok(!(k in p.patch), k + ' keeps its own control in the card');
});

test('the classic rules: a CHANGED name needs two words, a CHANGED phone must be an Israeli 10-digit number', () => {
  assert.deepEqual(plan(LEAD(), { name: 'דנה' }), { errors: { name: 'יש להזין שם מלא (שם פרטי ושם משפחה)' }, patch: {} });
  assert.deepEqual(plan(LEAD(), { name: '   ' }).errors, { name: 'יש להזין שם מלא (שם פרטי ושם משפחה)' });
  assert.deepEqual(plan(LEAD(), { phone: '12345' }), { errors: { phone: 'יש להזין טלפון ישראלי תקין (10 ספרות)' }, patch: {} });
  assert.deepEqual(plan(LEAD(), { phone: '' }).errors, { phone: 'יש להזין טלפון ישראלי תקין (10 ספרות)' });
  assert.deepEqual(plan(LEAD(), { contactPhone: '99' }).errors, { contactPhone: 'טלפון הפונה אינו תקין' });
  assert.deepEqual(plan(LEAD(), { contactPhone: '' }).patch, { contactPhone: '' }, 'the contact phone may be cleared');
  assert.deepEqual(plan(LEAD(), { source: '' }).errors, { source: 'יש לבחור מקור ליד' });
  assert.deepEqual(plan(LEAD(), { house: '' }).errors, { house: 'יש לבחור בית (או «נפגש/ת עם: אמבולטורי»)' });
  assert.deepEqual(plan(Object.assign(LEAD(), { meetingWith: 'אמבולטורי' }), { house: '' }), { errors: {}, patch: { house: '' } });
  // the same wording as the new-lead form; the same rule as Code.gs (a changed field only)
  assert.equal(core.leadFormErrors({}).name, 'יש להזין שם מלא (שם פרטי ושם משפחה)');
  assert.match(GS, /an EXISTING lead is checked only on a field whose value CHANGED/);
});

test('an old incomplete lead still saves its other fields (only a changed field is checked)', () => {
  const old = Object.assign(LEAD(), { name: 'דנה', phone: '544668861', contactPhone: '544668861', source: '', house: '', created: '' });
  assert.deepEqual(plan(old, { note: 'עדכון' }), { errors: {}, patch: { note: 'עדכון' } });
  assert.deepEqual(plan(old, { assignedTo: '' }), { errors: {}, patch: { assignedTo: '' } });
  // and it can be completed: a repaired phone is stored normalised
  assert.deepEqual(plan(old, { phone: '0544668861', contactPhone: '054-4668861' }).patch, { phone: '0544668861', contactPhone: '0544668861' });
});

test('קשר למטופל: «אחר» stores the typed text; a legacy value is kept; a named contact needs a relation', () => {
  assert.deepEqual(plan(LEAD(), { contactRelation: 'אחר', contactRelationOther: ' שכנה ' }).patch, { contactRelation: 'שכנה' });
  assert.deepEqual(plan(LEAD(), { contactRelation: 'אחר' }).errors, { contactRelationOther: 'יש לפרט את הקשר' });
  const stored = Object.assign(LEAD(), { contactRelation: 'אחר' });
  assert.deepEqual(plan(stored), { errors: {}, patch: {} }, 'a stored «אחר» with no text is left as it is');
  const legacy = Object.assign(LEAD(), { contactRelation: 'דודה' });
  assert.equal(core.leadEditValues(legacy).contactRelation, 'דודה');
  assert.deepEqual(plan(legacy, { note: 'x' }).patch, { note: 'x' });
  assert.deepEqual(plan(LEAD(), { contactRelation: '' }).errors, { contactRelation: 'יש לבחור קשר למטופל' });
  const bare = Object.assign(LEAD(), { contactName: '', contactRelation: '' });
  assert.deepEqual(plan(bare, { contactName: 'רון לוי' }).errors, { contactRelation: 'יש לבחור קשר למטופל' });
  assert.deepEqual(plan(bare, { contactName: 'רון לוי', contactRelation: 'אח/אחות' }).patch, { contactName: 'רון לוי', contactRelation: 'אח/אחות' });
});

test('טלפון לגבייה ועדכונים: מטופל / פונה / אחר, as the classic selector', () => {
  assert.deepEqual(core.billingModeOf({ phone: '0501111111', billingPhone: '' }), { mode: 'patient', other: '' });
  assert.deepEqual(core.billingModeOf({ phone: '0501111111', billingPhone: '050-1111111' }), { mode: 'patient', other: '' });
  assert.deepEqual(core.billingModeOf({ phone: '0501111111', contactPhone: '0502222222', billingPhone: '0502222222' }), { mode: 'contact', other: '' });
  assert.deepEqual(core.billingModeOf({ phone: '0501111111', billingPhone: '0509999999' }), { mode: 'other', other: '0509999999' });
  // a blank stored value already means «מטופל»: nothing is written for it
  assert.deepEqual(plan(LEAD(), { phone: '0523334444' }).patch, { phone: '0523334444' });
  assert.deepEqual(plan(LEAD(), { billingMode: 'contact' }).patch, { billingPhone: '0502222222' });
  assert.deepEqual(plan(LEAD(), { billingMode: 'other', billingOther: '050-777 8888' }).patch, { billingPhone: '0507778888' });
  assert.deepEqual(plan(LEAD(), { billingMode: 'other', billingOther: '' }).errors, { billingOther: 'יש להזין טלפון תקין לגבייה' });
  assert.deepEqual(plan(Object.assign(LEAD(), { contactPhone: '' }), { billingMode: 'contact' }).errors, { contactPhone: 'גבייה דרך הפונה — חסר טלפון פונה תקין' });
  // billing that followed the patient keeps following a new patient phone; billing via the contact follows a new contact phone
  assert.deepEqual(plan(Object.assign(LEAD(), { billingPhone: '0501111111' }), { phone: '0523334444' }).patch, { phone: '0523334444', billingPhone: '0523334444' });
  assert.deepEqual(plan(Object.assign(LEAD(), { billingPhone: '0502222222' }), { contactPhone: '0506667777' }).patch, { contactPhone: '0506667777', billingPhone: '0506667777' });
  // back to «מטופל» from its own number
  assert.deepEqual(plan(Object.assign(LEAD(), { billingPhone: '0509999999' }), { billingMode: 'patient' }).patch, { billingPhone: '0501111111' });
  // an unreadable legacy «אחר» number is kept until it is really changed
  assert.deepEqual(plan(Object.assign(LEAD(), { billingPhone: 'משרד' }), { note: 'x' }), { errors: {}, patch: { note: 'x' } });
});

test('dates: «נוצר» cannot be empty, in the future or out of range; «תאריך כניסה» only on a lead that has one', () => {
  assert.deepEqual(plan(LEAD(), { created: '2026-11-18' }).errors, { created: 'תאריך יצירה חסר, עתידי או מחוץ לטווח' });
  assert.deepEqual(plan(LEAD(), { created: '' }).errors, { created: 'תאריך יצירה חסר, עתידי או מחוץ לטווח' });
  assert.deepEqual(plan(LEAD(), { created: '1026-11-10' }).errors, { created: 'תאריך יצירה חסר, עתידי או מחוץ לטווח' });
  assert.deepEqual(plan(LEAD(), { created: TODAY }).patch, { created: TODAY });
  assert.deepEqual(plan(LEAD(), { entryDate: '2026-11-12' }).patch, {}, 'no entry date on the lead → the field does not exist');
  const admitted = Object.assign(LEAD(), { entryDate: '2026-11-11T22:00:00.000Z'.slice(0, 10) });
  assert.deepEqual(plan(admitted, { entryDate: '2026-11-12' }).patch, { entryDate: '2026-11-12' });
  assert.deepEqual(plan(admitted, { entryDate: '' }).errors, { entryDate: 'תאריך כניסה חסר או מחוץ לטווח' });
});

test('a patient\'s own lead («פנייה ישירה»): the source is a system key and is never rewritten; a blank phone is allowed', () => {
  const direct = Object.assign(LEAD(), { source: 'direct_approach', name: 'גל', phone: '' });
  assert.deepEqual(plan(direct, { source: 'גוגל', note: 'x' }).patch, { note: 'x' });
  assert.deepEqual(plan(direct, { name: 'גלי' }).patch, { name: 'גלי' }, 'exempt from the two-word rule, as on the server');
  assert.deepEqual(plan(direct, { name: '' }).errors, { name: 'יש להזין שם מלא (שם פרטי ושם משפחה)' }, 'never nameless');
  assert.deepEqual(plan(Object.assign(direct, { phone: '0501111111' }), { phone: '' }).patch, { phone: '' });
  assert.match(GS, /const LEAD_DIRECT_ADMIN_SOURCE = 'direct_admin';/);
  assert.match(GS, /const LEAD_DIRECT_APPROACH_SOURCE = 'direct_approach';/);
});

test('the patch goes through the existing one-lead save: the full raw row, patched; unknown keys never added', () => {
  const lead = Object.assign(LEAD(), { meetingReportOutcome: 'undecided', billingPhone: '0501111111' });
  const p = plan(lead, { house: 'רעננה אשר', note: 'חדש' });
  const next = core.applyLeadPatch(lead, p.patch, '2026-11-17T10:00:00.000Z');
  assert.deepEqual(Object.keys(next).sort(), Object.keys(lead).sort(), 'no key the row did not have');
  assert.equal(next.house, 'רעננה אשר'); assert.equal(next.note, 'חדש');
  assert.equal(next.stage, 'visit'); assert.equal(next.visitDate, '2026-11-20'); assert.equal(next.meetingReportOutcome, 'undecided');
  assert.deepEqual(core.leadSaveBody(next), { action: 'saveAll', leads: [next], patients: {}, prove: { leads: ['L1'] } });
  for (const k of Object.keys(p.patch)) assert.ok(core.LEAD_EDIT_FIELDS.indexOf(k) >= 0 || k === 'billingPhone', k);
});

test('the card: «עריכת פרטי הליד» replaces the classic link for a lead; the form is escaped, guarded and saved by writeLead', () => {
  // the lead no longer links to the classic page; a patient card still does (its own actions are separate work)
  assert.match(SRC, /data-lead-edit-open="' \+ esc\(lead\.id\) \+ '">עריכת פרטי הליד<\/button>/);
  assert.match(SRC, /\(lead \? \(rawLead\(lead\.id\) && !\(state\.me && state\.me\.view === 'controller'\) \? '<p><button[^\n]*: ''\) : '<p><a class="btn" href="\/\?view=classic">עריכה מלאה בדשבורד<\/a><\/p>'\)/);
  const form = SRC.slice(SRC.indexOf('function renderLeadEdit(l)'), SRC.indexOf('function leadEditForm()'));
  assert.match(form, /<form data-form="lead-edit" class="lead-edit" data-lead="' \+ esc\(l\.id\)/);
  for (const name of ['name', 'phone', 'contactName', 'contactPhone', 'contactRelation', 'contactRelationOther', 'billingMode', 'billingOther', 'house', 'source', 'track', 'assignedTo', 'created', 'entryDate', 'note'])
    assert.ok(form.includes("'" + name + "'") || form.includes('name="' + name + '"'), 'field ' + name);
  assert.match(form, /value="' \+ esc\(v\[name\]\)/, 'input values escaped');
  assert.match(form, /esc\(v\.note\) \+ '<\/textarea>/, 'the note escaped');
  assert.match(form, /if \(!raw \|\| \(state\.me && state\.me\.view === 'controller'\)\) return '';/, 'the verifier (no lead details by D11) gets no edit form');
  assert.ok(!/innerHTML/.test(form), 'built as an escaped string, rendered by the drawer');
  // saved through the existing proven write — no second lead write path, no new action
  const save = SRC.slice(SRC.indexOf('function saveLeadEdit(id, f)'), SRC.indexOf("/* «סיבת המתנה» (Vered 04/11/2026)"));
  assert.match(save, /leadEditPlan\(raw, vals, state\.today\)/);
  assert.match(save, /writeLead\(id, plan\.patch, label\)/);   // the label names a move in / out of «מכבי» (CHANGELOG-crm-lead-payer-switch.md)
  assert.ok(!/fetch\(/.test(save), 'no fetch of its own');
  assert.match(save, /אין שינויים לשמירה/);
  assert.match(save, /כבר קיים ליד «/, 'the duplicate-phone question, as on a new lead');
  assert.match(SRC, /f\.dataset\.form === 'lead-edit'\) \{\s*saveLeadEdit\(id, f\);/);
  // unsaved edits: asked before the card closes (✕, the scrim, Esc); a refused save keeps what was typed
  assert.match(SRC, /if \(!leaveLeadEdit\(\)\) return; closeDrawer\(\);/);
  assert.match(SRC, /ev\.key === 'Escape' && leaveLeadEdit\(\)\) closeDrawer\(\);/);
  assert.match(SRC, /יש שינויים שלא נשמרו בפרטי הליד\. לסגור בלי לשמור\?/);
  assert.match(save, /state\.leadEdit = \{ id: id, vals: vals \};/);
  assert.match(save, /if \(!ok\) return;/);
  assert.match(CSS, /details\.act form\.lead-edit \.wide \{ flex-basis: 100%;/);
});

test('no server change: Code.gs has no lead-edit action; the lead columns are untouched', () => {
  assert.ok(!/lead-edit|leadEdit/.test(GS));
  assert.match(GS, /'contactName',[\s\S]*'contactPhone',[\s\S]*'contactRelation',[\s\S]*'billingPhone'/);
});
