'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { inspectCrmSource } = require('../../scripts/crm-source-preflight');
const specs = ['Leads', 'לידים לא רלוונטיים', 'לידים שהוסרו'];
const columns = ['id', 'name', 'stage', 'assignedTo', 'visitDate', 'meetingOutcome', 'meetingReportOutcome'];
function fixture(extra = {}) {
  const calls = [];
  const data = Object.assign(Object.fromEntries(specs.map((name, i) => [name, { headers: i ? ['id', 'PRIVATE_NOTE'] : columns, ids: ['synthetic-' + i] }])), extra);
  const spreadsheet = { getSheetByName(name) {
    const d = data[name]; if (!d) return null;
    return {
      getLastRow: () => d.lastRow ?? d.ids.length + 1,
      getLastColumn: () => d.headers.length,
      getRange(r, c, nr, nc) {
        calls.push({ name, r, c, nr, nc });
        if (r === 1 && nr === 1) return { getValues: () => [d.headers] };
        assert.equal(c, d.headers.indexOf('id') + 1); assert.equal(nc, 1, 'never read names or other data columns');
        return { getValues: () => d.ids.map(id => [id]) };
      },
      getDataRange() { throw Error('must not read full rows'); },
      appendRow() { throw Error('must not write'); },
    };
  }, insertSheet() { throw Error('must not create'); } };
  return { spreadsheet, calls, data };
}
test('preflight reads headers/IDs only and returns counts without IDs, headers or private text', () => {
  const f = fixture(); f.data.Leads.ids = ['PRIVATE_ID'];
  const report = inspectCrmSource(f.spreadsheet);
  assert.equal(report.checksPassed, true); assert.equal(report.rowSpanUpperBound, 3);
  assert.equal(report.uniqueIds, 3); assert.equal(report.atomicSnapshot, false);
  assert.ok(!JSON.stringify(report).includes('PRIVATE'));
  assert.equal(f.calls.length, 6);
});
test('preflight missing archive is blocked without creating it', () => {
  const f = fixture({ [specs[2]]: null });
  assert.deepEqual(inspectCrmSource(f.spreadsheet).blockers, ['missing_removed']);
});
test('preflight empty but correctly headed archives are valid', () => {
  const f = fixture({ [specs[1]]: { headers: ['id'], ids: [] }, [specs[2]]: { headers: ['id'], ids: [] } });
  assert.equal(inspectCrmSource(f.spreadsheet).checksPassed, true);
  assert.equal(f.calls.length, 4);
});
test('preflight rejects missing/duplicate required headers', () => {
  for (const headers of [['name'], ['id', 'id']]) {
    const f = fixture({ [specs[2]]: { headers, ids: ['x'] } });
    assert.deepEqual(inspectCrmSource(f.spreadsheet).blockers, ['required_headers_removed']);
  }
});
test('preflight flags blank and malformed IDs without printing their content', () => {
  const f = fixture({ [specs[2]]: { headers: ['id'], ids: ['', ' ', 45, { private: 'SECRET' }] } });
  const r = inspectCrmSource(f.spreadsheet);
  assert.equal(r.sheets[2].blankIds, 2); assert.equal(r.sheets[2].invalidIds, 2); assert.equal(r.checksPassed, false);
  assert.ok(!JSON.stringify(r).includes('SECRET'));
});
test('preflight detects trimmed duplicates inside and across sheets', () => {
  const f = fixture({ Leads: { headers: columns, ids: ['same', ' same '] }, [specs[2]]: { headers: ['id'], ids: ['same'] } });
  const r = inspectCrmSource(f.spreadsheet); assert.equal(r.duplicateIdRows, 2); assert.equal(r.uniqueIds, 2);
  assert.deepEqual(r.blockers, ['duplicate_ids']);
});
test('preflight refuses oversized sheets before fetching IDs', () => {
  const f = fixture({ Leads: { headers: columns, ids: [], lastRow: 10002 } });
  const r = inspectCrmSource(f.spreadsheet); assert.equal(r.checksPassed, false);
  assert.ok(r.blockers.includes('sheet_capacity_active')); assert.ok(!f.calls.some(c => c.name === 'Leads'));
});
test('preflight enforces the combined conservative row span even when sheets individually fit', () => {
  const f = fixture(Object.fromEntries(specs.map((n, i) => [n, { headers: i ? ['id'] : columns, ids: Array.from({ length: 3400 }, (_, j) => i + '-' + j) }])));
  const r = inspectCrmSource(f.spreadsheet); assert.equal(r.rowSpanUpperBound, 10200);
  assert.deepEqual(r.blockers, ['combined_capacity']);
});
test('preflight bounds exception text and invalid dimensions', () => {
  const a = inspectCrmSource({ getSheetByName() { throw Error('SECRET URL NAME'); } });
  assert.equal(a.checksPassed, false); assert.ok(!JSON.stringify(a).includes('SECRET'));
  const f = fixture({ Leads: { headers: columns, ids: [], lastRow: -1 } });
  assert.ok(inspectCrmSource(f.spreadsheet).blockers.includes('invalid_dimensions_active'));
});
