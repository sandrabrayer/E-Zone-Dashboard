'use strict';

/* Read-only operational state projection from OUT getHandoffStatus.
 * No client-provided matching by name/phone; no shadow task/lead records.
 * Source link must first be resolved from Dashboard's verified AuditLog.
 */
const ALLOWED_STATES = new Set([
  'referred', 'contacted', 'intro_scheduled', 'intro_passed', 'plan',
  'admitted', 'active', 'ended', 'not_relevant',
]);
const EXACT_ID = /^[A-Za-z0-9_:-]{1,120}$/;
const MAX_CACHE_MS = 60000;

function exactId(value) {
  const v = typeof value === 'string' ? value.trim() : '';
  return EXACT_ID.test(v) ? v : '';
}

function limitedText(v, n) {
  return typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, n) : '';
}
function date(v) {
  const t = limitedText(v, 30);
  return /^\d{4}-\d{2}-\d{2}$/.test(t.slice(0, 10)) ? t.slice(0, 10) : '';
}
function projectOutpatientStatus(response) {
  if (!response || response.ok !== true || response.sourceApp !== 'ezone-outpatient' ||
      !Array.isArray(response.results) || response.results.length !== 1) {
    return { verified: false, reason: 'unverified_outpatient_status' };
  }
  const r = response.results[0];
  if (!r || !exactId(r.outpatientId) || !ALLOWED_STATES.has(r.state) ||
      (r.entity !== 'lead' && r.entity !== 'client')) {
    return { verified: false, reason: 'invalid_outpatient_status' };
  }
  return {
    verified: true, state: r.state, entity: r.entity,
    stateDate: date(r.stateDate), assignedTo: limitedText(r.assignedTo, 80),
    nextAction: limitedText(r.nextAction, 160), nextActionDate: date(r.nextActionDate),
    lastActionDate: date(r.lastActionDate),
  };
}

/* At most 60 sec cache after a verified result; no failed/empty/unknown
 * responses cached, so a newly documented contact is never hidden by a false
 * 'no match'. Pass a read-only fetcher that speaks the existing OUT contract. */
function createStatusReader(fetchStatus, now = Date.now) {
  const cache = new Map();
  return async function read(outpatientId) {
    const id = exactId(outpatientId);
    if (!id) return { verified: false, reason: 'missing_exact_id' };
    const stamp = now(), hit = cache.get(id);
    if (hit && stamp >= hit.at && stamp - hit.at < MAX_CACHE_MS) return hit.value;
    let response;
    try { response = await fetchStatus(id); }
    catch (_) { return { verified: false, reason: 'outpatient_unavailable' }; }
    const projected = projectOutpatientStatus(response);
    if (projected.verified) cache.set(id, { at: stamp, value: projected });
    return projected;
  };
}

module.exports = { ALLOWED_STATES, MAX_CACHE_MS, exactId, projectOutpatientStatus, createStatusReader };
