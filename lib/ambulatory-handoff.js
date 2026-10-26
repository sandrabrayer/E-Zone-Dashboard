'use strict';

/* «אמבולטורי» → Outpatient handoff, the server.js half
 * (CHANGELOG-meeting-with-ambulatory.md).
 *
 * saveAll_ (Code.gs) answers `ambulatoryHandoff` — the leads whose «נפגש עם»
 * became «אמבולטורי» (or whose earlier send failed) and that were never sent.
 * server.js hands that list to handOffAmbulatoryLeads, which, per lead:
 *   - refuses a lead without a phone (no call; recorded as `no_phone`);
 *   - calls `send` (server.js sendToOutpatient — Railway-env URL + secret);
 *   - calls `record` (Code.gs recordOutpatientLeadSend → AuditLog) with the
 *     outcome, so Code.gs never offers a sent lead again and retries a failed
 *     one on the next save.
 * The meeting itself is already saved: nothing here can fail the save. Every
 * failure becomes `failed` + the Hebrew warning. The secret never passes
 * through this module; only lead ids and error codes are logged — never a
 * name or a phone. Deps are injected so the tests run without a network. */

const AMBULATORY_SEND_FAILED_HE = 'הפגישה נשמרה, אך שליחת הליד לאמבולטורי נכשלה — לא נשלח';
const AMBULATORY_MAX_ITEMS = 20;
const LIMITS = { leadId: 100, name: 100, phone: 20, note: 400, source: 60 };

/* Lead ids with a send in flight in THIS process: a second save that lands
 * while the first one's send is still running does not send again. */
const inFlight = new Set();

/* One handoff item, every field a capped string. null when it has no lead id. */
function cleanItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const out = {};
  Object.keys(LIMITS).forEach((k) => {
    out[k] = String(raw[k] == null ? '' : raw[k]).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, LIMITS[k]);
  });
  return out.leadId ? out : null;
}

/* The error code of one `send` result, or '' when Outpatient accepted it. */
function sendErrorCode(result) {
  if (!result || typeof result !== 'object') return 'outpatient_unreachable';
  if (result.outcome === 'not_configured') return 'outpatient_not_configured';
  if (result.outcome === 'timeout') return 'outpatient_timeout';
  if (result.outcome !== 'answered') return 'outpatient_unreachable';
  return result.data && result.data.ok === true ? '' : 'outpatient_refused';
}

/* → { sent: [leadId], failed: [leadId], warning? }. Never throws. */
async function handOffAmbulatoryLeads(items, deps) {
  const d = deps || {};
  const log = d.log || (() => {});
  const out = { sent: [], failed: [] };
  const list = (Array.isArray(items) ? items : []).slice(0, AMBULATORY_MAX_ITEMS).map(cleanItem).filter(Boolean);
  for (const item of list) {
    if (inFlight.has(item.leadId)) continue;
    inFlight.add(item.leadId);
    try {
      let error = '';
      let outpatientId = '';
      if (!item.phone) {
        error = 'no_phone';
      } else {
        let result;
        try {
          result = await d.send({ name: item.name, phone: item.phone, note: item.note, source: item.source });
        } catch (_) {
          result = null;
        }
        error = sendErrorCode(result);
        if (!error) outpatientId = String((result.data && result.data.id) == null ? '' : result.data.id).slice(0, 80);
      }
      try {
        await d.record({ leadId: item.leadId, sent: !error, error, outpatientId });
      } catch (_) {
        log('[ambulatory] record failed for lead ' + item.leadId);
      }
      log('[ambulatory] lead ' + item.leadId + ' → ' + (error || 'sent'));
      (error ? out.failed : out.sent).push(item.leadId);
    } finally {
      inFlight.delete(item.leadId);
    }
  }
  if (out.failed.length) out.warning = AMBULATORY_SEND_FAILED_HE;
  return out;
}

module.exports = {
  AMBULATORY_SEND_FAILED_HE,
  AMBULATORY_MAX_ITEMS,
  handOffAmbulatoryLeads,
  sendErrorCode,
  cleanItem,
  _inFlight: inFlight,
};
