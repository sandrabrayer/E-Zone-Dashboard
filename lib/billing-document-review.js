/* Read-only invoice-request review from the existing billingControlQueue.
 * A request or a bank confirmation is never evidence of document issuance.
 * No money arithmetic, persistence, reminder changes or inferred obligations.
 */
(function (root) {
'use strict';
const STATUSES = ['reported', 'partial', 'flagged', 'confirmed'];
const text = v => typeof v === 'string' ? v.trim() : '';
function day(v) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return '';
  const d = new Date(v + 'T00:00:00Z');
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === v ? v : '';
}
function review(data, options) {
  const d = data || {}, o = options || {};
  const available = d.ok === true && Array.isArray(d.receipts);
  const out = { available, complete: available, stale: o.stale === true,
    requestedCount: 0, unknownCount: 0, excludedCount: 0, invalidCount: 0, rows: [] };
  if (!available) return out;
  const counts = new Map();
  d.receipts.forEach(r => {
    if (r && text(r.id)) counts.set(text(r.id), (counts.get(text(r.id)) || 0) + 1);
  });
  d.receipts.forEach(r => {
    if (!r || !text(r.id) || counts.get(text(r.id)) !== 1) {
      out.invalidCount++; return;
    }
    // The real queue already excludes these; never reintroduce a void if a
    // cached/fixture payload supplies one. A void is not evidence of issuance.
    if (r.status === 'void' || r.status === 'מבוטל' || r.linkStatus === 'duplicate') return;
    if (r.invoiceWanted === 'no') { out.excludedCount++; return; }
    const kind = r.invoiceWanted === 'yes' ? 'requested' : 'unknown';
    if (kind === 'requested') out.requestedCount++; else out.unknownCount++;
    if (!STATUSES.includes(r.confirmStatus)) out.invalidCount++;
    const row = { receiptId: text(r.id), patientName: text(r.patientName), houseId: text(r.houseId),
      receivedDate: day(r.receivedDate), invoiceTo: kind === 'requested' ? text(r.invoiceTo) : '',
      confirmStatus: STATUSES.includes(r.confirmStatus) ? r.confirmStatus : 'unknown',
      kind, issuance: 'unrecorded' };
    if ((!o.house || o.house === 'all' || o.house === row.houseId) &&
        (!o.kind || o.kind === 'all' || o.kind === row.kind)) out.rows.push(row);
  });
  out.complete = out.invalidCount === 0;
  out.rows.sort((a, b) => (a.receivedDate || '9999').localeCompare(b.receivedDate || '9999') ||
    a.receiptId.localeCompare(b.receiptId));
  return out;
}
const api = { review };
if (typeof module === 'object' && module && module.exports) module.exports = api;
else root.BillingDocumentReview = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
