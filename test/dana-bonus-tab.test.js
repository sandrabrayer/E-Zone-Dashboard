'use strict';
/* CHANGELOG-dana-bonus-tab.md — Dana's lead bonus: ₪50 per lead whose visit took place,
 * ₪100 more when the lead enters a house. Synthetic names. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const core = require('../public/crm/crm.js');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'crm', 'crm.js'), 'utf8');

const TODAY = '2026-11-15';
const lead = (o) => Object.assign({ phone: '0500000000', house: 'ramot', source: 'גוגל', stage: 'visit', assignedTo: 'דנה', created: '2026-10-20' }, o);
const DATA = {
  leads: [
    lead({ id: 'L1', name: 'א׳ התקיים-דיווח', visitDate: '2026-11-03', meetingReportOutcome: 'undecided' }),               // 50
    lead({ id: 'L2', name: 'ב׳ התקיים-תוצאה', visitDate: '2026-11-05', meetingOutcome: 'thinking' }),                     // 50
    lead({ id: 'L3', name: 'ג׳ נכנס', stage: 'admitted', visitDate: '2026-11-04', meetingOutcome: 'entered', entryDate: '2026-11-08' }),   // 50 + 100
    lead({ id: 'L4', name: 'ד׳ לא הגיע', visitDate: '2026-11-06', meetingReportOutcome: 'no_show' }),                     // 0
    lead({ id: 'L5', name: 'ה׳ בוטל', visitDate: '2026-11-07', meetingOutcome: 'cancelled' }),                             // 0
    lead({ id: 'L6', name: 'ו׳ ממתין לדיווח', visitDate: '2026-11-10' }),                                                  // waiting
    lead({ id: 'L7', name: 'ז׳ מתוכנן', visitDate: '2026-11-20' }),                                                        // planned
    lead({ id: 'L8', name: 'ח׳ של ורד', assignedTo: 'ורד', visitDate: '2026-11-03', meetingOutcome: 'entered', stage: 'admitted', entryDate: '2026-11-04' }),   // not hers
    lead({ id: 'L9', name: 'ט׳ ביקור באוקטובר כניסה בנובמבר', visitDate: '2026-10-28', meetingReportOutcome: 'advancing' }),   // Oct 50; Nov 100 (via the patient row)
    lead({ id: 'L10', name: 'י׳ חדש', stage: 'new' }),                                                                     // nothing
    lead({ id: 'L11', name: 'כ׳ נדחה', visitDate: '2026-11-02', meetingOutcome: 'postponed' }),                            // 0
    lead({ id: 'L12', name: 'ל׳ רשומת טלפון', source: 'direct_admin', visitDate: '2026-11-03', meetingOutcome: 'thinking' }),   // not a lead
  ],
  irrelevantLeads: [
    lead({ id: 'C1', name: 'מ׳ נסגר אחרי ביקור', visitDate: '2026-11-09', meetingReportOutcome: 'not_fit', movedAt: '2026-11-10T10:00:00Z' }),   // 50 — the visit happened
    lead({ id: 'L1', name: 'כפילות', visitDate: '2026-11-03', meetingReportOutcome: 'undecided' }),                         // the same id never counts twice
  ],
  patients: { ramot: [{ id: 'p9', name: 'ט׳', date: '2026-11-02', status: 'active', fromLead: 'L9' }] },
  dischargedPatients: [],
};
const C = core.compute(DATA, TODAY);
const rows = core.leadBonus(DATA, C, TODAY);
const by = Object.fromEntries(rows.map((r) => [r.id, r]));

test('the rule: ₪50 for a visit that took place, ₪100 more for an admission — her leads only', () => {
  assert.deepEqual(core.BONUS, { user: 'דנה', visit: 50, admit: 100 });
  assert.deepEqual([by.L1.visit, by.L1.visitBonus, by.L1.admitBonus], ['held', 50, 0], 'the manager reported it was held');
  assert.deepEqual([by.L2.visit, by.L2.visitBonus], ['held', 50], 'a recorded outcome');
  assert.deepEqual([by.L3.visit, by.L3.visitBonus, by.L3.admitted, by.L3.admitBonus, by.L3.entryDate], ['held', 50, true, 100, '2026-11-08']);
  assert.deepEqual([by.L4.visit, by.L4.visitBonus], ['missed', 0], '«לא הגיע» earns nothing');
  assert.deepEqual([by.L5.visit, by.L5.visitBonus], ['missed', 0], 'cancelled');
  assert.deepEqual([by.L11.visit, by.L11.visitBonus], ['missed', 0], 'postponed');
  assert.deepEqual([by.L6.visit, by.L6.visitBonus], ['waiting', 0], 'a past visit nobody reported is not paid yet');
  assert.deepEqual([by.L7.visit, by.L7.visitBonus], ['planned', 0]);
  assert.deepEqual([by.L10.visit, by.L10.visitBonus, by.L10.admitBonus], ['none', 0, 0]);
  assert.equal(by.L8, undefined, 'Vered\'s lead is not Dana\'s bonus');
  assert.equal(by.L12, undefined, 'a phone record is not a lead');
  assert.deepEqual([by.C1.visit, by.C1.visitBonus, by.C1.closed], ['held', 50, true], 'a lead closed after its visit still earned the visit');
  assert.equal(rows.filter((r) => r.id === 'L1').length, 1, 'one id, one line');
  assert.deepEqual([by.L9.admitted, by.L9.entryDate, by.L9.admitBonus], [true, '2026-11-02', 100], 'admission proven by the Patients row (fromLead), dated by its entry');
});

test('a month: the visit counts in the month of the visit, the admission in the month of entry', () => {
  const nov = core.bonusMonth(rows, '2026-11', TODAY);
  assert.deepEqual([nov.visits, nov.visitTotal, nov.admits, nov.admitTotal, nov.total], [4, 200, 2, 200, 400]);   // L1 L2 L3 C1 · L3 L9
  assert.deepEqual(nov.lines.map((l) => [l.id, l.visitBonus, l.admitBonus, l.total]).sort(), [['C1', 50, 0, 50], ['L1', 50, 0, 50], ['L2', 50, 0, 50], ['L3', 50, 100, 150], ['L9', 0, 100, 100]].sort());
  assert.deepEqual([nov.waiting.map((r) => r.id), nov.planned.map((r) => r.id), nov.potential], [['L6'], ['L7'], 100]);
  const oct = core.bonusMonth(rows, '2026-10', TODAY);
  assert.deepEqual([oct.visits, oct.admits, oct.total, oct.lines.map((l) => l.id)], [1, 0, 50, ['L9']]);
  assert.deepEqual(nov.months, [{ month: '2026-11', visits: 4, admits: 2, total: 400 }, { month: '2026-10', visits: 1, admits: 0, total: 50 }]);
  assert.equal(nov.allTime, 450); assert.equal(oct.allTime, 450);
  const empty = core.bonusMonth([], '2026-11', TODAY);
  assert.deepEqual([empty.total, empty.lines, empty.months, empty.allTime], [0, [], [], 0]);
});

test('a visit dated in the future is never «held», whatever was typed; an admission with no date is listed apart', () => {
  const d = { leads: [lead({ id: 'F1', name: 'עתידי', visitDate: '2026-12-01', meetingOutcome: 'thinking' }), lead({ id: 'U1', name: 'בלי תאריך', stage: 'admitted', visitDate: '', entryDate: '' })], patients: {}, irrelevantLeads: [] };
  const r = core.leadBonus(d, core.compute(d, TODAY), TODAY);
  assert.deepEqual([r[0].visit, r[0].visitBonus], ['planned', 0]);
  const m = core.bonusMonth(r, '2026-11', TODAY);
  assert.deepEqual([m.admits, m.total, m.undated.map((x) => x.id)], [0, 0, ['U1']], 'never guessed into a month');
});

test('who sees the tab: Dana and Sandra only; display only', () => {
  const dana = { user: 'דנה', view: 'ops', ops: true, finance: false }, sandra = { user: 'סנדרה', view: 'full', finance: true, approver: true };
  const vered = { user: 'ורד', view: 'full', finance: true, approver: false }, ortal = { user: 'אורטל', view: 'controller' };
  assert.equal(core.bonusVisible(dana), true); assert.equal(core.bonusVisible(sandra), true);
  assert.equal(core.bonusVisible(vered), false); assert.equal(core.bonusVisible(ortal), false); assert.equal(core.bonusVisible(null), false);
  assert.ok(core.areasFor(dana).includes('bonus')); assert.ok(core.areasFor(sandra).includes('bonus'));
  assert.ok(!core.areasFor(vered).includes('bonus')); assert.ok(!core.areasFor(ortal).includes('bonus'));
  const fn = SRC.slice(SRC.indexOf('function renderBonus(c)'), SRC.indexOf('function kpiCard('));
  assert.match(fn, /if \(!bonusVisible\(state\.me\)\) return/, 'the render refuses too');
  assert.ok(!/fetch\(|api\(|action:/.test(fn), 'no request, no write');
  assert.ok(!/'<td>' \+ r\.(name|house)\b/.test(fn), 'names are escaped');
});
