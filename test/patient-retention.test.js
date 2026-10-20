/* «חתכי מטופלים» foundation (CHANGELOG-patient-retention-foundation.md):
 * the pure rules in lib/patient-retention.js. All names and ids are synthetic. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const R = require('../lib/patient-retention');

const TODAY = '2026-10-20';
const P = (over) => Object.assign({ id: 'p-' + Math.random().toString(36).slice(2, 8), houseId: 'ramot', name: 'מטופל', date: '2026-09-01', status: 'active', exitDate: '' }, over || {});
const D = (over) => Object.assign({ id: 'd-' + Math.random().toString(36).slice(2, 8), houseId: 'ramot', name: 'מטופל', date: '2026-09-01', status: 'released', exitDate: '', dischargedAt: '', restored: '', deletedAt: '', continuity: '' }, over || {});
const run = (o) => R.computeRetention(Object.assign({ from: '2026-09-01', to: '2026-09-30', today: TODAY }, o));

/* ---------- constants ---------- */

test('continuity keys and Hebrew labels; unknown is the default and never a choice', () => {
  assert.deepEqual([...R.CONTINUITY_KEYS], ['continued_outpatient', 'continued_other', 'none', 'unknown']);
  assert.deepEqual({ ...R.CONTINUITY_LABELS }, {
    continued_outpatient: 'המשיך באמבולטורי (E-ZONE)',
    continued_other: 'המשיך במסגרת טיפולית אחרת',
    none: 'לא המשיך',
    unknown: 'לא ידוע',
  });
  assert.equal(R.CONTINUITY_DEFAULT, 'unknown');
  assert.deepEqual([...R.CONTINUITY_CHOICES], ['continued_outpatient', 'continued_other', 'none']);
  assert.ok(Object.isFrozen(R.CONTINUITY_LABELS) && Object.isFrozen(R.CONTINUITY_KEYS));
});

test('normalizeContinuity: a known key passes, anything else is unknown', () => {
  assert.equal(R.normalizeContinuity('none'), 'none');
  assert.equal(R.normalizeContinuity(' continued_other '), 'continued_other');
  for (const v of ['', null, undefined, 'NONE', 'לא המשיך', '=cmd', {}]) assert.equal(R.normalizeContinuity(v), 'unknown');
});

/* ---------- dates ---------- */

test('toDay: bare ISO as is; timestamps → Israel calendar day; garbage → ""', () => {
  assert.equal(R.toDay('2026-10-05'), '2026-10-05');
  // 21:30Z on 05/10 is already 06/10 in Israel (UTC+3) — the isoDate rule.
  assert.equal(R.toDay('2026-10-05T21:30:00.000Z'), '2026-10-06');
  assert.equal(R.toDay('2026-10-05T10:00:00.000Z'), '2026-10-05');
  assert.equal(R.toDay(new Date('2026-01-15T23:30:00Z')), '2026-01-16');   // UTC+2 in winter
  for (const v of ['', null, undefined, '2026-02-30', 'אתמול', '05/10/2026', 'NaN']) assert.equal(R.toDay(v), '');
});

test('daysBetween crosses DST and month ends without drift', () => {
  assert.equal(R.daysBetween('2026-03-26', '2026-03-28'), 2);   // Israel DST starts 27/03
  assert.equal(R.daysBetween('2026-10-24', '2026-10-26'), 2);   // DST ends 25/10
  assert.equal(R.daysBetween('2026-01-31', '2026-03-01'), 29);
  assert.equal(R.daysBetween('2028-02-28', '2028-03-01'), 2);   // leap year
  assert.equal(R.daysBetween('2026-10-02', '2026-10-01'), -1);
  assert.equal(R.daysBetween('', '2026-10-01'), null);
});

test('stayDays is NOT inclusive: same-day discharge = 0, 01→31 = 30', () => {
  assert.equal(R.stayDays({ date: '2026-10-01', status: 'released', exitDate: '2026-10-01' }), 0);
  assert.equal(R.stayDays({ date: '2026-10-01', status: 'released', exitDate: '2026-10-31' }), 30);
});

test('stayDays: active counts to today; dischargedAt is the fallback; missing → null', () => {
  assert.equal(R.stayDays({ date: '2026-10-01', status: 'active' }, TODAY), 19);
  assert.equal(R.stayDays({ date: '2026-10-01', status: 'released', dischargedAt: '2026-10-10T08:00:00Z' }), 9);
  assert.equal(R.stayDays({ date: '2026-10-01', status: 'released', exitDate: '2026-10-05', dischargedAt: '2026-10-10T08:00:00Z' }), 4,
    'exitDate (the chosen discharge date) wins over the action timestamp');
  assert.equal(R.stayDays({ entryDate: '2026-10-01', status: 'released', exitDate: '2026-10-03' }), 2, 'entryDate alias');
  assert.equal(R.stayDays({ date: '', status: 'active' }, TODAY), null);
  assert.equal(R.stayDays({ date: '2026-10-01', status: 'released' }), null);
  assert.equal(R.stayDays(null), null);
});

/* ---------- buckets / threshold ---------- */

test('bucketFor boundaries: 30 / 31 / 60 / 61', () => {
  const b = (d) => R.bucketFor(d).bucket;
  assert.equal(b(0), 'upTo30');
  assert.equal(b(30), 'upTo30');
  assert.equal(b(31), 'd31to60');
  assert.equal(b(60), 'd31to60');
  assert.equal(b(61), 'over60');
  assert.equal(b(900), 'over60');
  for (const bad of [-1, 1.5, NaN, null, '10', undefined]) assert.deepEqual(R.bucketFor(bad, 10), { bucket: null, custom: null });
});

test('bucketFor custom split: ≤ N atOrBelow, > N above; null/invalid N → no split', () => {
  assert.deepEqual(R.bucketFor(45, 45), { bucket: 'd31to60', custom: 'atOrBelow' });
  assert.deepEqual(R.bucketFor(46, 45), { bucket: 'd31to60', custom: 'above' });
  assert.deepEqual(R.bucketFor(46, '45'), { bucket: 'd31to60', custom: 'above' });
  for (const bad of [null, undefined, '', 0, -5, 2.5, 'abc', NaN, Infinity, 3651, '45x', {}]) {
    assert.equal(R.bucketFor(10, bad).custom, null, String(bad));
    assert.equal(R.normalizeThreshold(bad), null, String(bad));
  }
  assert.equal(R.normalizeThreshold(1), 1);
  assert.equal(R.normalizeThreshold(3650), 3650);
});

test('percentOf / formatPercent', () => {
  assert.equal(R.percentOf(1, 4), 0.25);
  assert.equal(R.percentOf(3, 0), null);
  assert.equal(R.formatPercent(0.25), '25%');
  assert.equal(R.formatPercent(1 / 7), '14.3%');
  assert.equal(R.formatPercent(null), '—');
});

/* ---------- computeRetention ---------- */

test('bad / reversed range → bad_range', () => {
  assert.deepEqual(run({ from: '2026-09-30', to: '2026-09-01' }), { ok: false, error: 'bad_range' });
  assert.deepEqual(run({ from: '', to: '2026-09-01' }), { ok: false, error: 'bad_range' });
  assert.deepEqual(run({ from: '2026-02-30', to: '2026-03-01' }), { ok: false, error: 'bad_range' });
});

test('cohort boundary: entry on from and on to are IN, the day before / after are OUT', () => {
  const r = run({ patients: [
    P({ name: 'a', date: '2026-08-31' }), P({ name: 'b', date: '2026-09-01' }),
    P({ name: 'c', date: '2026-09-30' }), P({ name: 'd', date: '2026-10-01' }),
  ] });
  assert.deepEqual(r.rows.stillInTreatment.map((x) => x.name), ['b', 'c']);
  assert.equal(r.cohortSize, 2);
});

test('buckets, still-in-treatment breakdown, percentages and the lists behind every number', () => {
  const patients = [
    P({ id: 'p1', name: 'א', date: '2026-09-01', status: 'released', exitDate: '2026-09-01' }),   // 0
    P({ id: 'p2', name: 'ב', date: '2026-09-01', status: 'released', exitDate: '2026-10-01' }),   // 30
    P({ id: 'p3', name: 'ג', date: '2026-09-01', status: 'released', exitDate: '2026-10-02' }),   // 31
    P({ id: 'p4', name: 'ד', date: '2026-09-01', status: 'released', exitDate: '2026-11-01' }),   // 61
    P({ id: 'p5', name: 'ה', date: '2026-09-25', status: 'active' }),                              // 25 so far
    P({ id: 'p6', name: 'ו', date: '2026-09-10', status: 'trial' }),                               // 40 so far
  ];
  const discharged = [
    D({ patientId: 'p1', name: 'א', exitDate: '2026-09-01', continuity: 'continued_outpatient' }),
    D({ patientId: 'p2', name: 'ב', exitDate: '2026-10-01', continuity: 'none' }),
    D({ patientId: 'p3', name: 'ג', exitDate: '2026-10-02', continuity: 'continued_other' }),
    D({ patientId: 'p4', name: 'ד', exitDate: '2026-11-01', continuity: '' }),
  ];
  const r = run({ patients, discharged, customThreshold: 30 });
  assert.equal(r.ok, true);
  assert.deepEqual(r.counts, { upTo30: 2, d31to60: 1, over60: 1 });
  assert.equal(r.dischargedCount, 4);
  assert.deepEqual(r.stillInTreatment, { count: 2, buckets: { upTo30: 1, d31to60: 1, over60: 0 } });
  assert.equal(r.cohortSize, 6);
  assert.deepEqual(r.continuity, { continued_outpatient: 1, continued_other: 1, none: 1, unknown: 1 });
  assert.equal(r.percents.upTo30, 2 / 6);
  assert.equal(r.percents.stillInTreatment, 2 / 6);
  assert.equal(r.percents.continuity.none, 1 / 4, 'continuity % is of the discharged only');
  assert.deepEqual(r.custom, { threshold: 30, atOrBelow: 2, above: 2 });
  assert.equal(r.cross.upTo30.continued_outpatient, 1);
  assert.equal(r.cross.upTo30.none, 1);
  assert.equal(r.cross.over60.unknown, 1);
  // Every count is the length of its list.
  for (const k of ['upTo30', 'd31to60', 'over60']) assert.equal(r.rows[k].length, r.counts[k]);
  for (const k of R.CONTINUITY_KEYS) assert.equal(r.rows.continuity[k].length, r.continuity[k]);
  assert.deepEqual(r.rows.upTo30.map((x) => [x.name, x.days]), [['א', 0], ['ב', 30]]);
  assert.equal(r.rows.d31to60[0].auditId !== '', true, 'the audit row id rides along (the inline update needs it)');
  assert.equal(r.missingCount, 0);
});

test('same-day discharge is 0 days → upTo30', () => {
  const r = run({ patients: [P({ id: 'x', date: '2026-09-15', status: 'released', exitDate: '2026-09-15' })] });
  assert.equal(r.rows.upTo30[0].days, 0);
});

test('missing dates are listed in «נתונים חסרים», never dropped', () => {
  const r = run({
    patients: [
      P({ id: 'm1', name: 'בלי כניסה', date: '' }),
      P({ id: 'm2', name: 'בלי שחרור', date: '2026-09-05', status: 'released', exitDate: '' }),
      P({ id: 'm3', name: 'הפוך', date: '2026-09-05', status: 'released', exitDate: '2026-09-01' }),
      P({ id: 'm4', name: 'עתידי', date: '2026-09-29', status: 'wait' }),
      P({ id: 'ok', name: 'תקין', date: '2026-09-05', status: 'active' }),
    ],
    today: '2026-09-20',
  });
  assert.equal(r.missingCount, 4);
  assert.deepEqual(r.rows.missing.map((x) => [x.name, x.reason]).sort(), [
    ['בלי כניסה', 'no_entry_date'], ['בלי שחרור', 'no_discharge_date'],
    ['הפוך', 'discharge_before_entry'], ['עתידי', 'entry_in_future'],
  ].sort());
  assert.equal(r.cohortSize, 1, 'missing stays are outside the percentage base');
  for (const k of Object.keys(R.MISSING_REASONS)) assert.equal(typeof R.MISSING_REASONS[k], 'string');
});

test('an audit row with only dischargedAt is placed by its Israel calendar day', () => {
  const r = run({ discharged: [D({ name: 'ישן', date: '2026-09-01', exitDate: '', dischargedAt: '2026-09-30T22:30:00.000Z' })] });
  // 22:30Z on 30/09 = 01/10 01:30 in Israel → 30 days.
  assert.equal(r.rows.upTo30[0].dischargeDate, '2026-10-01');
  assert.equal(r.rows.upTo30[0].days, 30);
});

test('restored audit rows are not discharges; the Patients row decides', () => {
  const r = run({
    patients: [P({ id: 'r1', name: 'שוחזר', date: '2026-09-02', status: 'active' })],
    discharged: [D({ patientId: 'r1', name: 'שוחזר', date: '2026-09-02', exitDate: '2026-09-10', restored: 'TRUE', continuity: 'none' })],
  });
  assert.equal(r.dischargedCount, 0);
  assert.equal(r.stillInTreatment.count, 1);
  assert.equal(r.continuity.none, 0);
});

test('soft-deleted duplicates and double open rows of one stay count once', () => {
  const base = { name: 'כפול', date: '2026-09-03', exitDate: '2026-09-13', continuity: 'none' };
  const r = run({ discharged: [D(Object.assign({ id: 'a' }, base)), D(Object.assign({ id: 'b' }, base)), D(Object.assign({ id: 'c', deletedAt: '2026-10-01' }, base))] });
  assert.equal(r.dischargedCount, 1);
  assert.equal(r.rows.upTo30[0].auditId, 'a');
});

test('a released Patients row and its audit row are ONE stay (joined by patientId or stay key)', () => {
  const r = run({
    patients: [
      P({ id: 'j1', name: 'לפי מזהה', date: '2026-09-04', status: 'released', exitDate: '2026-09-14' }),
      P({ id: 'j2', name: 'לפי  מפתח ', date: '2026-09-04', status: 'released', exitDate: '2026-09-24' }),
    ],
    discharged: [
      D({ id: 'aud-j1', patientId: 'j1', name: 'לפי מזהה', date: '2026-09-04', exitDate: '2026-09-14', continuity: 'continued_other' }),
      D({ id: 'aud-j2', name: 'לפי מפתח', date: '2026-09-04', exitDate: '2026-09-24', continuity: 'none' }),
    ],
  });
  assert.equal(r.dischargedCount, 2);
  assert.deepEqual(r.rows.upTo30.map((x) => x.auditId).sort(), ['aud-j1', 'aud-j2']);
});

test('a released Patients row with no audit row: discharged, continuity unknown, no audit id', () => {
  const r = run({ patients: [P({ id: 'n1', date: '2026-09-04', status: 'released', exitDate: '2026-09-08' })] });
  assert.equal(r.continuity.unknown, 1);
  assert.equal(r.rows.upTo30[0].auditId, '');
});

test('an open audit row with no Patients row still counts', () => {
  const r = run({ discharged: [D({ id: 'orph', name: 'יתום', date: '2026-09-04', exitDate: '2026-12-04', continuity: 'continued_outpatient' })] });
  assert.deepEqual(r.counts, { upTo30: 0, d31to60: 0, over60: 1 });
});

test('a returning patient: each stay by its OWN entry and discharge dates', () => {
  const patients = [
    // First stay (June) — outside the September cohort.
    P({ id: 'root', name: 'חוזר', date: '2026-06-01', status: 'released', exitDate: '2026-06-20' }),
    // Second stay (September) — in the cohort, carries personId.
    P({ id: 'second', name: 'חוזר', date: '2026-09-10', status: 'released', exitDate: '2026-11-20', personId: 'root' }),
    // Third stay, still active.
    P({ id: 'third', name: 'חוזר', date: '2026-09-28', status: 'active', personId: 'root' }),
  ];
  const discharged = [
    D({ id: 'a1', patientId: 'root', name: 'חוזר', date: '2026-06-01', exitDate: '2026-06-20', continuity: 'none' }),
    D({ id: 'a2', patientId: 'second', name: 'חוזר', date: '2026-09-10', exitDate: '2026-11-20', continuity: 'continued_outpatient' }),
  ];
  const r = run({ patients, discharged });
  assert.deepEqual(r.counts, { upTo30: 0, d31to60: 0, over60: 1 });
  assert.equal(r.rows.over60[0].days, 71);
  assert.equal(r.rows.over60[0].returning, true);
  assert.equal(r.continuity.continued_outpatient, 1);
  assert.equal(r.continuity.none, 0, 'the June stay is outside the period');
  assert.equal(r.stillInTreatment.count, 1);
  const june = run({ patients, discharged, from: '2026-06-01', to: '2026-06-30' });
  assert.deepEqual(june.counts, { upTo30: 1, d31to60: 0, over60: 0 });
  assert.equal(june.rows.upTo30[0].days, 19);
});

test('null or invalid threshold → custom is null; nothing else changes', () => {
  const patients = [P({ date: '2026-09-05', status: 'released', exitDate: '2026-09-25' })];
  const a = run({ patients, customThreshold: null });
  const b = run({ patients, customThreshold: 'abc' });
  const c = run({ patients, customThreshold: -3 });
  for (const r of [a, b, c]) {
    assert.equal(r.custom, null);
    assert.equal(r.customThreshold, null);
    assert.deepEqual(r.counts, { upTo30: 1, d31to60: 0, over60: 0 });
    assert.equal(r.rows.custom.atOrBelow.length + r.rows.custom.above.length, 0);
  }
});

test('empty input → zero counts, null percentages, no crash', () => {
  const r = run({});
  assert.equal(r.ok, true);
  assert.equal(r.cohortSize, 0);
  assert.equal(r.percents.upTo30, null);
  assert.equal(r.percents.continuity.none, null);
  assert.equal(r.missingCount, 0);
});

test('junk rows are ignored, not thrown on', () => {
  const r = run({ patients: [null, 7, 'x', P({ date: '2026-09-02' })], discharged: [undefined, D({ name: '', houseId: '', patientId: '', date: '2026-09-02', exitDate: '2026-09-03' })] });
  assert.equal(r.ok, true);
  assert.equal(r.stillInTreatment.count, 1);
  assert.equal(r.dischargedCount, 1, 'a keyless open audit row is still its own discharged stay');
});

test('the module is pure (no DOM, no network, no console)', () => {
  const src = require('node:fs').readFileSync(require.resolve('../lib/patient-retention'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(src, /document\.|window\.|fetch\(|XMLHttpRequest|console\.|localStorage/);
});
