'use strict';

// Operator helper, deliberately OUTSIDE apps-script/ and the deployed runtime.
// No entrypoint, credentials, writes or logging. Supply a spreadsheet object
// only in a separately approved execution context. Only headers and ID columns
// are read; IDs stay in memory and never appear in the aggregate report.
function inspectCrmSource(spreadsheet) {
  const limit = 10000, seen = new Set();
  const required = ['id', 'name', 'stage', 'assignedTo', 'visitDate', 'meetingOutcome', 'meetingReportOutcome'];
  const specs = [
    { kind: 'active', name: 'Leads', fields: required },
    { kind: 'irrelevant', name: 'לידים לא רלוונטיים', fields: ['id'] },
    { kind: 'removed', name: 'לידים שהוסרו', fields: ['id'] },
  ];
  const report = { contract: 'crm-source-preflight-v1', measuredAt: new Date().toISOString(),
    checksPassed: false, atomicSnapshot: false, rowLimit: limit,
    rowSpanUpperBound: 0, validIdRows: 0, uniqueIds: 0, duplicateIdRows: 0,
    sheets: [], blockers: [] };
  const block = code => { if (!report.blockers.includes(code)) report.blockers.push(code); };
  for (const spec of specs) {
    const result = { kind: spec.kind, exists: false, rowSpanUpperBound: null,
      headerErrors: null, blankIds: null, invalidIds: null, duplicateIdRows: null };
    report.sheets.push(result);
    try {
      const sheet = spreadsheet.getSheetByName(spec.name);
      if (!sheet) { block('missing_' + spec.kind); continue; }
      result.exists = true;
      const lastRow = sheet.getLastRow(), columns = sheet.getLastColumn();
      if (!Number.isSafeInteger(lastRow) || lastRow < 1 || !Number.isSafeInteger(columns) || columns < 1 || columns > 1000) {
        block('invalid_dimensions_' + spec.kind); continue;
      }
      result.rowSpanUpperBound = lastRow - 1;
      report.rowSpanUpperBound += result.rowSpanUpperBound;
      if (lastRow > limit + 1) { block('sheet_capacity_' + spec.kind); continue; }
      const rows = sheet.getRange(1, 1, 1, columns).getValues();
      if (!Array.isArray(rows) || rows.length !== 1 || !Array.isArray(rows[0]) || rows[0].length !== columns) {
        block('invalid_headers_' + spec.kind); continue;
      }
      const headers = rows[0];
      result.headerErrors = spec.fields.filter(field => headers.filter(h => h === field).length !== 1).length;
      if (result.headerErrors) { block('required_headers_' + spec.kind); continue; }
      result.blankIds = 0; result.invalidIds = 0; result.duplicateIdRows = 0;
      if (!result.rowSpanUpperBound) continue;
      const ids = sheet.getRange(2, headers.indexOf('id') + 1, result.rowSpanUpperBound, 1).getValues();
      if (!Array.isArray(ids) || ids.length !== result.rowSpanUpperBound) { block('invalid_id_range_' + spec.kind); continue; }
      for (const row of ids) {
        if (!Array.isArray(row) || row.length !== 1 || typeof row[0] !== 'string') { result.invalidIds++; continue; }
        const id = row[0].trim();
        if (!id) { result.blankIds++; continue; }
        if (id.length > 1000) { result.invalidIds++; continue; }
        report.validIdRows++;
        if (seen.has(id)) { result.duplicateIdRows++; report.duplicateIdRows++; }
        else seen.add(id);
      }
      if (result.blankIds) block('blank_id_or_row_' + spec.kind);
      if (result.invalidIds) block('invalid_ids_' + spec.kind);
      if (result.duplicateIdRows) block('duplicate_ids');
    } catch (_) { block('read_failed_' + spec.kind); }
  }
  report.uniqueIds = seen.size;
  if (report.rowSpanUpperBound > limit) block('combined_capacity');
  report.checksPassed = report.blockers.length === 0;
  return report;
}
if (typeof module !== 'undefined') module.exports = { inspectCrmSource };
