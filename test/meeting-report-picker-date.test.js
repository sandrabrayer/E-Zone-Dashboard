/* Tests for mrPickerDate (public/meeting-report.js) — the lead picker's date
 * segment (CHANGELOG-meeting-report-picker-date.md).
 *
 * The picker rendered raw ISO dates ('2026-08-20') inside RTL option labels,
 * where the bidi algorithm garbles the LTR digit run against the Hebrew text.
 * mrPickerDate renders DD/MM wrapped in a Unicode LTR isolate
 * (U+2066 LRI … U+2069 PDI) so the segment can never reorder. */

const { test } = require('node:test');
const assert = require('node:assert');

const mr = require('../public/meeting-report.js');

const LRI = '⁦';
const PDI = '⁩';

test('mrPickerDate: ISO date → DD/MM inside an LTR isolate', () => {
  assert.strictEqual(mr.mrPickerDate('2026-08-20'), LRI + '20/08' + PDI);
  assert.strictEqual(mr.mrPickerDate('2026-01-05'), LRI + '05/01' + PDI);
});

test('mrPickerDate: a leading-ISO timestamp still yields DD/MM', () => {
  assert.strictEqual(mr.mrPickerDate('2026-08-20T10:00:00.000Z'), LRI + '20/08' + PDI);
});

test('mrPickerDate: empty/null → empty string (label omits the date segment)', () => {
  assert.strictEqual(mr.mrPickerDate(''), '');
  assert.strictEqual(mr.mrPickerDate(null), '');
  assert.strictEqual(mr.mrPickerDate(undefined), '');
});

test('mrPickerDate: a non-ISO legacy value passes through verbatim but still isolated', () => {
  assert.strictEqual(mr.mrPickerDate('מחר'), LRI + 'מחר' + PDI);
  assert.strictEqual(mr.mrPickerDate('20/08'), LRI + '20/08' + PDI);
});

test('mrPickerDate: the isolate is always balanced (LRI opens, PDI closes)', () => {
  ['2026-08-20', 'junk', '1'].forEach((v) => {
    const out = mr.mrPickerDate(v);
    assert.strictEqual(out[0], LRI);
    assert.strictEqual(out[out.length - 1], PDI);
    assert.strictEqual(out.split(LRI).length - 1, 1);
    assert.strictEqual(out.split(PDI).length - 1, 1);
  });
});
