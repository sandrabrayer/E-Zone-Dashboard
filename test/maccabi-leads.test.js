'use strict';
/* CHANGELOG-maccabi-leads.md — Maccabi leads: five required documents per lead, kept as one
 * readable line in the lead's note. Synthetic names. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const core = require('../public/crm/crm.js');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'crm', 'crm.js'), 'utf8');
const GS = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8');

test('the five documents and the message Vered sends', () => {
  assert.deepEqual(core.MACCABI_DOCS.map((d) => d.id), ['referral', 'blood', 'psych', 'gp', 'ecg']);
  assert.equal(core.MACCABI_EMAIL, 'maccabi@ezone-house.co.il');
  for (const d of core.MACCABI_DOCS) assert.ok(core.MACCABI_MESSAGE.includes(d.label), d.label);
  assert.match(core.MACCABI_MESSAGE, /1\. הפניה מפסיכיאטר של מכבי לתחלואה כפולה\n2\. בדיקות דם כלליות\n3\. סיכום פסיכיאטר אחרון\n4\. סיכום מצב בריאותי מרופא המשפחה\n5\. אק״ג ופענוח/);
  assert.match(core.MACCABI_MESSAGE, /maccabi@ezone-house\.co\.il — סרוק וקריא/);
});

test('which lead is a Maccabi lead', () => {
  assert.equal(core.isMaccabiLead({ source: 'מכבי', name: 'דנה כהן' }), true);
  assert.equal(core.isMaccabiLead({ source: 'קופת חולים מכבי' }), true);
  assert.equal(core.isMaccabiLead({ source: 'גוגל', name: 'אבי לוי-מכבי' }), true, 'named so on the board');
  assert.equal(core.isMaccabiLead({ source: 'גוגל', name: 'גל רון', note: 'שיחה\nמסמכי מכבי: ✗ הפניה מפסיכיאטר' }), true, 'already carries the list');
  assert.equal(core.isMaccabiLead({ source: 'קופת חולים', name: 'נועה שגב', note: 'מבוטחת כללית' }), false);
  assert.equal(core.isMaccabiLead(null), false);
});

test('the list lives in one line of the note: written, read back, the rest of the note untouched', () => {
  const empty = core.maccabiDocsOf('');
  assert.deepEqual(empty, { referral: '', blood: '', psych: '', gp: '', ecg: '' });
  const n1 = core.maccabiNoteWith('אמא מתקשרת בערב', { referral: 'in', blood: 'has' });
  assert.equal(n1, 'אמא מתקשרת בערב\nמסמכי מכבי: ✓ הפניה מפסיכיאטר | ◐ בדיקות דם | ✗ סיכום פסיכיאטר | ✗ סיכום רופא משפחה | ✗ אק״ג ופענוח');
  assert.deepEqual(core.maccabiDocsOf(n1), { referral: 'in', blood: 'has', psych: '', gp: '', ecg: '' });
  // an update replaces the line in place — never a second line, text around it kept
  const n2 = core.maccabiNoteWith('שורה לפני\n' + n1.split('\n')[1] + '\nשורה אחרי', Object.assign(core.maccabiDocsOf(n1), { ecg: 'in', blood: 'in' }));
  assert.equal(n2.split('\n').filter((l) => l.startsWith('מסמכי מכבי:')).length, 1);
  assert.deepEqual([n2.split('\n')[0], n2.split('\n')[2]], ['שורה לפני', 'שורה אחרי']);
  assert.deepEqual(core.maccabiDocsOf(n2), { referral: 'in', blood: 'in', psych: '', gp: '', ecg: 'in' });
  assert.equal(core.maccabiNoteWith('', {}), 'מסמכי מכבי: ✗ הפניה מפסיכיאטר | ✗ בדיקות דם | ✗ סיכום פסיכיאטר | ✗ סיכום רופא משפחה | ✗ אק״ג ופענוח');
  assert.equal(core.maccabiNoteWith('טקסט\n\n', { gp: 'in' }).split('\n').length, 2, 'no blank lines pile up');
});

test('a line someone edited by hand never invents a received document', () => {
  assert.deepEqual(core.maccabiDocsOf('מסמכי מכבי: קיבלנו הכל'), { referral: '', blood: '', psych: '', gp: '', ecg: '' });
  assert.deepEqual(core.maccabiDocsOf('מסמכי מכבי: ✓ בדיקות דם | ? הפניה מפסיכיאטר | ✓סיכום רופא משפחה'), { referral: '', blood: 'in', psych: '', gp: 'in', ecg: '' });
  assert.deepEqual(core.maccabiDocsOf('מסמכי מכבי: ✓ בדיקות דם חלקיות'), { referral: '', blood: '', psych: '', gp: '', ecg: '' }, 'only an exact document name counts');
  assert.deepEqual(core.maccabiDocsOf(null), { referral: '', blood: '', psych: '', gp: '', ecg: '' });
});

test('a click cycles: missing → with the patient → received → missing', () => {
  assert.deepEqual([core.maccabiNext(''), core.maccabiNext('has'), core.maccabiNext('in'), core.maccabiNext('junk')], ['has', 'in', '', '']);
  assert.deepEqual(core.MACCABI_STATES.map((m) => m.mark), ['✗', '◐', '✓']);
});

test('the view: only Maccabi leads, incomplete first, with counts', () => {
  const all = { referral: 'in', blood: 'in', psych: 'in', gp: 'in', ecg: 'in' };
  const leads = [
    { id: 'a', name: 'א׳ שלם', source: 'מכבי', house: 'ramot', stage: 'visit', note: core.maccabiNoteWith('', all) },
    { id: 'b', name: 'ב׳ חלקי', source: 'מכבי', phone: '050-1234567', house: 'ramot', stage: 'new', note: core.maccabiNoteWith('', { referral: 'in', blood: 'has' }) },
    { id: 'c', name: 'ג׳ כלום', source: 'מכבי', stage: 'new', note: '' },
    { id: 'd', name: 'ד׳ מגוגל', source: 'גוגל', stage: 'new' },
  ];
  const v = core.maccabiView(leads, '');
  assert.deepEqual(v.rows.map((r) => r.id), ['c', 'b', 'a']);
  assert.deepEqual([v.count, v.complete, v.waiting], [3, 1, 2]);
  const b = v.rows[1];
  assert.deepEqual([b.got, b.onWay, b.missing, b.complete], [1, 1, 3, false]);
  assert.deepEqual(core.maccabiView(leads, 'חלקי').rows.map((r) => r.id), ['b']);
  assert.deepEqual(core.maccabiView(null, '').rows, []);
});

test('WhatsApp digits for an Israeli phone; nothing for a non-phone', () => {
  assert.equal(core.waDigits('050-123 4567'), '972501234567');
  assert.equal(core.waDigits('+972 50 1234567'), '972501234567');
  assert.equal(core.waDigits('abc'), ''); assert.equal(core.waDigits(''), ''); assert.equal(core.waDigits('12'), '');
});

test('wiring: saved through the existing lead write; no new column, no new action; cells escaped', () => {
  const fn = SRC.slice(SRC.indexOf('function maccabiToggle('), SRC.indexOf('function renderNewLeadForm()'));
  assert.match(fn, /writeLead\(leadId, \{ note: maccabiNoteWith\(raw\.note, docs\) \}/, 'the proven saveAll path — one lead, prove.leads');
  assert.ok(!/fetch\(|action:/.test(fn), 'no request of its own');
  const view = SRC.slice(SRC.indexOf('function renderMaccabi(c)'), SRC.indexOf('function maccabiToggle('));
  assert.ok(!/'<td>' \+ r\.(name|house|phone)\b/.test(view), 'text cells escaped');
  assert.match(view, /encodeURIComponent\(r\.draft\.text\)/);
  assert.match(view, /rel="noopener"/);
  assert.ok(!/maccabi/i.test(GS.slice(GS.indexOf('const LEAD_COLUMNS = ['), GS.indexOf('const IRRELEVANT_LEAD_COLUMNS'))), 'the Leads header is untouched (the closed / removed sheets mirror it)');
});

test('each Maccabi card prepares only missing documents and suppresses requests for in-transit, received or ambiguous statuses', () => {
  const note = (statuses) => core.maccabiNoteWith('', statuses);
  const draft = (value) => core.maccabiView([{id:'s1',source:'מכבי',note:value}]).rows[0].draft;
  assert.equal(draft('').text, core.MACCABI_MESSAGE);
  const mixed = draft(note({blood:'in',ecg:'has'}));
  assert.match(mixed.status,/3/);
  assert.match(mixed.text,/1\. הפניה/);
  for (const doc of core.MACCABI_DOCS) assert.equal(mixed.text.includes(doc.label), !['blood','ecg'].includes(doc.id));
  const all = Object.fromEntries(core.MACCABI_DOCS.map(d => [d.id,'in']));
  assert.deepEqual(draft(note(all)),{text:'',status:'כל המסמכים התקבלו'});
  assert.deepEqual(draft(note({...all,blood:'has'})),{text:'',status:'ממתינים למסמכים שכבר בדרך'});
  for(const ambiguous of ['מסמכי מכבי: סימון ישן',note(all)+'\n'+note(all),'מסמכי מכבי: ✓ בדיקות דם']) {
    assert.deepEqual(draft(ambiguous),{text:'',status:'נדרשת בדיקת סימוני המסמכים'});
  }
});
