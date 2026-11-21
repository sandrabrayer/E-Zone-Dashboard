'use strict';
/* CHANGELOG-crm-lead-payer-switch.md — «מסלול» in «עריכת פרטי הליד»: a private lead is
 * switched to מכבי and shows in the «מכבי» list (and back). The list's own rule is
 * unchanged; the switch writes the documents line in the lead's note. Pure rules +
 * source wiring here; the real page is a scenario in test/crm-shell-browser.test.js.
 * Names and phones are SYNTHETIC. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const core = require('../public/crm/crm.js');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'crm', 'crm.js'), 'utf8');
const GS = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8');

const TODAY = '2026-11-17';
const EMPTY = 'מסמכי מכבי: ✗ הפניה מפסיכיאטר | ✗ בדיקות דם | ✗ סיכום פסיכיאטר | ✗ סיכום רופא משפחה | ✗ אק״ג ופענוח';
const LEAD = (over) => Object.assign({ id: 'L1', name: 'נועה שגב', phone: '0501111111', house: 'arfoni', source: 'בית חולים', note: 'אמא התקשרה', stage: 'new',
  created: '2026-11-10', assignedTo: 'דנה', contactName: '', contactPhone: '', contactRelation: '', billingPhone: '' }, over || {});
const plan = (lead, over) => core.leadEditPlan(lead, Object.assign(core.leadEditValues(lead), over || {}), TODAY);
const after = (lead, over) => { const p = plan(lead, over); assert.deepEqual(p.errors, {}); return core.applyLeadPatch(lead, p.patch, TODAY + 'T10:00:00.000Z'); };

test('the track of a lead: מכבי when the «מכבי» list would show it, otherwise פרטי', () => {
  assert.equal(core.leadTrack(LEAD()), 'private');
  assert.equal(core.leadTrack(LEAD({ source: 'מכבי' })), 'maccabi');
  assert.equal(core.leadTrack(LEAD({ name: 'נועה שגב-מכבי' })), 'maccabi');
  assert.equal(core.leadTrack(LEAD({ note: 'x\n' + EMPTY })), 'maccabi');
  assert.equal(core.leadTrack(LEAD({ note: 'x\nמסמכי מכבי (לא פעיל): ✓ בדיקות דם' })), 'private', 'a parked list is not in the Maccabi list');
  assert.equal(core.leadTrack(null), 'private');
  assert.equal(core.leadEditValues(LEAD()).track, 'private');
  assert.equal(core.leadEditValues(LEAD({ source: 'מכבי' })).track, 'maccabi');
});

test('פרטי → מכבי: the lead enters the «מכבי» list with five missing documents; the source and the typed note are kept', () => {
  const lead = LEAD();
  assert.deepEqual(core.maccabiView([lead], '').rows, []);
  const p = plan(lead, { track: 'maccabi' });
  assert.deepEqual(p, { errors: {}, patch: { note: 'אמא התקשרה\n' + EMPTY } }, 'one field: the note gains the documents line');
  const next = after(lead, { track: 'maccabi' });
  assert.equal(next.source, 'בית חולים', 'the source is not rewritten — the funnel and the bonus read it');
  assert.equal(core.isMaccabiLead(next), true);
  const v = core.maccabiView([next, LEAD({ id: 'L2', name: 'גל רון' })], '');
  assert.deepEqual(v.rows.map((r) => [r.id, r.got, r.onWay, r.missing, r.complete]), [['L1', 0, 0, 5, false]]);
  assert.deepEqual([v.count, v.waiting], [1, 1]);
  // an empty note works too
  assert.deepEqual(plan(LEAD({ note: '' }), { track: 'maccabi' }).patch, { note: EMPTY });
  // the save is the ordinary one-lead write
  assert.deepEqual(core.leadSaveBody(next), { action: 'saveAll', leads: [next], patients: {}, prove: { leads: ['L1'] } });
});

test('the documents line is not shown in the «הערות» box and is never lost by editing the note', () => {
  const lead = LEAD({ note: 'לפני\n' + core.maccabiNoteWith('', { blood: 'in', ecg: 'has' }) + '\nאחרי' });
  assert.equal(core.leadEditValues(lead).note, 'לפני\nאחרי');
  assert.deepEqual(plan(lead), { errors: {}, patch: {} }, 'opened and saved untouched → nothing written');
  const next = after(lead, { note: 'לפני\nאחרי\nשורה חדשה' });
  assert.equal(next.note, 'לפני\nאחרי\nשורה חדשה\nמסמכי מכבי: ✗ הפניה מפסיכיאטר | ✓ בדיקות דם | ✗ סיכום פסיכיאטר | ✗ סיכום רופא משפחה | ◐ אק״ג ופענוח');
  assert.deepEqual(core.maccabiDocsOf(next.note), { referral: '', blood: 'in', psych: '', gp: '', ecg: 'has' });
  assert.equal(after(lead, { note: '' }).note, 'מסמכי מכבי: ✗ הפניה מפסיכיאטר | ✓ בדיקות דם | ✗ סיכום פסיכיאטר | ✗ סיכום רופא משפחה | ◐ אק״ג ופענוח', 'clearing the note keeps the list');
  assert.deepEqual(core.maccabiNoteParts(lead.note), { text: 'לפני\nאחרי', line: 'מסמכי מכבי: ✗ הפניה מפסיכיאטר | ✓ בדיקות דם | ✗ סיכום פסיכיאטר | ✗ סיכום רופא משפחה | ◐ אק״ג ופענוח', parked: false });
  assert.deepEqual(core.maccabiNoteParts(null), { text: '', line: '', parked: false });
});

test('מכבי → פרטי: out of the list; ticked documents are parked, not deleted — and come back on a return to מכבי', () => {
  const ticked = LEAD({ note: 'אמא התקשרה\n' + core.maccabiNoteWith('', { referral: 'in', blood: 'has' }) });
  const priv = after(ticked, { track: 'private' });
  assert.equal(priv.note, 'אמא התקשרה\nמסמכי מכבי (לא פעיל): ✓ הפניה מפסיכיאטר | ◐ בדיקות דם | ✗ סיכום פסיכיאטר | ✗ סיכום רופא משפחה | ✗ אק״ג ופענוח');
  assert.equal(core.isMaccabiLead(priv), false);
  assert.deepEqual(core.maccabiView([priv], '').rows, []);
  assert.equal(core.leadEditValues(priv).note, 'אמא התקשרה', 'the parked line stays out of the box too');
  assert.deepEqual(plan(priv), { errors: {}, patch: {} });
  assert.equal(after(priv, { note: 'אמא התקשרה שוב' }).note, 'אמא התקשרה שוב\nמסמכי מכבי (לא פעיל): ✓ הפניה מפסיכיאטר | ◐ בדיקות דם | ✗ סיכום פסיכיאטר | ✗ סיכום רופא משפחה | ✗ אק״ג ופענוח');
  const back = after(priv, { track: 'maccabi' });
  assert.equal(back.note, ticked.note, 'exactly as it was');
  assert.deepEqual(core.maccabiDocsOf(back.note), { referral: 'in', blood: 'has', psych: '', gp: '', ecg: '' });
  // nothing ticked → nothing to park: the line is simply removed
  const blank = LEAD({ note: 'אמא התקשרה\n' + EMPTY });
  assert.equal(after(blank, { track: 'private' }).note, 'אמא התקשרה');
  assert.equal(after(LEAD({ note: EMPTY }), { track: 'private' }).note, '');
});

test('a lead that says מכבי in its source or name stays a Maccabi lead until that text changes', () => {
  const bySource = LEAD({ source: 'מכבי', note: '' });
  assert.deepEqual(plan(bySource), { errors: {}, patch: {} }, 'no line is written just for opening and saving');
  assert.deepEqual(plan(bySource, { note: 'x' }).patch, { note: 'x' });
  assert.deepEqual(plan(bySource, { track: 'private' }), { errors: { track: 'המקור או השם כוללים «מכבי» — הליד נשאר ברשימת מכבי. למעבר לפרטי יש לשנות את מקור הליד.' }, patch: {} });
  assert.deepEqual(plan(LEAD({ name: 'נועה מכבי' }), { track: 'private' }).errors.track.slice(0, 20), 'המקור או השם כוללים ');
  // the source changed in the same edit → private, and it leaves the list
  const moved = after(bySource, { track: 'private', source: 'גוגל' });
  assert.deepEqual([moved.source, moved.note, core.isMaccabiLead(moved)], ['גוגל', '', false]);
  // the source changed but the track left on מכבי → the line keeps it in the list
  const kept = after(bySource, { source: 'קופת חולים' });
  assert.deepEqual([kept.source, kept.note, core.isMaccabiLead(kept)], ['קופת חולים', EMPTY, true]);
  // typing מכבי as the source is enough by itself, as «+ ליד מכבי» does
  const typed = after(LEAD(), { source: 'מכבי' });
  assert.deepEqual([typed.note, core.isMaccabiLead(typed)], ['אמא התקשרה', true]);
  // a parked list comes back when the lead is relabelled מכבי
  const parked = LEAD({ note: 'x\nמסמכי מכבי (לא פעיל): ✓ הפניה מפסיכיאטר | ✗ בדיקות דם | ✗ סיכום פסיכיאטר | ✗ סיכום רופא משפחה | ✗ אק״ג ופענוח' });
  assert.deepEqual(core.maccabiDocsOf(after(parked, { source: 'מכבי', track: 'maccabi' }).note).referral, 'in');
});

test('a hand-edited or unknown line never invents a received document; an unknown track changes nothing', () => {
  assert.equal(core.noteForTrack('טקסט', 'מסמכי מכבי: קיבלנו הכל', 'maccabi'), 'טקסט\n' + EMPTY);
  assert.equal(core.noteForTrack('טקסט', 'מסמכי מכבי: קיבלנו הכל', 'private'), 'טקסט', 'nothing readable → nothing parked');
  assert.equal(core.noteForTrack('', '', 'private'), '');
  assert.equal(core.noteForTrack('', '', 'maccabi'), EMPTY);
  assert.equal(core.noteForTrack('א\r\nב', '', 'private'), 'א\nב');
  const lead = LEAD({ note: 'x\n' + core.maccabiNoteWith('', { gp: 'in' }) });
  assert.deepEqual(plan(lead, { track: 'whatever' }), { errors: {}, patch: {} });
  assert.deepEqual(plan(lead, { track: '' }), { errors: {}, patch: {} });
  assert.ok(core.MACCABI_PARKED.indexOf('מסמכי מכבי:') !== 0, 'a parked line is not read as an active one');
  assert.equal(core.maccabiByLabel({ source: 'גוגל', name: 'גל רון', note: EMPTY }), false, 'the label is the source / name only');
});

test('the card: «מסלול» in the edit form, the track in the details, the save through writeLead; no server change', () => {
  const form = SRC.slice(SRC.indexOf('function renderLeadEdit(l)'), SRC.indexOf('function leadEditForm()'));
  assert.match(form, /<label>מסלול <select name="track">/);
  assert.match(form, /\['private', 'פרטי'\], \['maccabi', 'מכבי — ברשימת «מכבי»'\]/);
  assert.match(form, /err\('track'\)/);
  assert.ok(core.LEAD_EDIT_FIELDS.indexOf('track') >= 0, 'its message is painted and cleared with the others');
  const save = SRC.slice(SRC.indexOf('function saveLeadEdit(id, f)'), SRC.indexOf('/* «סיבת המתנה» (Vered 04/11/2026)'));
  assert.match(save, /const from = leadTrack\(raw\), to = leadTrack\(applyLeadPatch\(raw, plan\.patch\)\);/);
  assert.match(save, /הליד עבר לרשימת «מכבי» — השינוי/);
  assert.match(save, /הליד יצא מרשימת «מכבי» — השינוי/);
  assert.match(save, /writeLead\(id, plan\.patch, label\)/);
  assert.ok(!/fetch\(/.test(save));
  // the track row moved into the grouped details (CHANGELOG-crm-incoming-contact.md): same text, «סטטוס» group
  assert.match(SRC, /const docs = isMaccabiLead\(l\) \? 'מכבי · מסמכים ' \+/);
  assert.match(SRC, /\['מסלול', docs\]/);
  // the list's own rule is untouched (CHANGELOG-maccabi-leads.md)
  assert.match(SRC, /return \/מכבי\/\.test\(s\(o\.source\)\) \|\| \/מכבי\/\.test\(s\(o\.name\)\) \|\| !!maccabiLineOf\(o\.note\);/);
  assert.ok(!/מסמכי מכבי/.test(GS), 'Code.gs knows nothing of the line — no column, no action');
  assert.ok(!/leadTrack|payer-switch/.test(GS));
});
