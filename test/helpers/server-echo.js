'use strict';

/* Test helper (not a test). CHANGELOG-write-path-hardening.md made the page
 * say «נשמר» only with the server's proof — the persisted row's id. Older
 * suites stub the backend with a bare { ok: true }, which the page now
 * (correctly) treats as unproven. serverEcho(body, payload) fills in what the
 * REAL Code.gs handler answers on success, so those suites keep testing what
 * they test. A payload that is not a bare success (a refusal, an explicit
 * echo) is returned unchanged. node --test also loads this file; it defines
 * no test. */

function serverEcho(body, payload) {
  const b = body || {};
  const p = payload === undefined ? { ok: true } : payload;
  if (!p || p.ok !== true) return p;
  const out = Object.assign({}, p);
  switch (b.action) {
    case 'saveAll': {
      // saveAll_ answers `proven` for the ids the caller asked about — the
      // ones the sheet holds after the write (here: everything it was sent).
      // Upstream of server.js the field may arrive JSON-encoded.
      let prove = b.prove;
      if (typeof prove === 'string') { try { prove = JSON.parse(prove); } catch (_) { prove = null; } }
      if (prove && !out.proven) {
        out.proven = { leads: (prove.leads || []).slice(), patients: (prove.patients || []).slice() };
      }
      break;
    }
    case 'dischargePatient':
      if (!out.patient && !out.duplicate) Object.assign(out, { discharged: true, patient: b.patient });
      break;
    case 'restorePatientToActive':
      if (out.id === undefined) Object.assign(out, { restoredToActive: true, id: b.patient && b.patient.id });
      break;
    case 'restorePatient':
      if (!out.lead) Object.assign(out, { restored: true, newLeadId: b.patient && b.patient.newLeadId, lead: { id: b.patient && b.patient.newLeadId } });
      break;
    case 'deletePatientRow':
      if (out.id === undefined) Object.assign(out, { deleted: 1, id: b.patient && b.patient.id, matchedBy: 'id' });
      break;
    case 'deleteDuplicateDischarge':
      if (out.id === undefined) Object.assign(out, { deleted: true, id: b.id });
      break;
    case 'moveLeadIrrelevant':
    case 'restoreLead':
    case 'removeLead':
      if (!out.lead) out.lead = b.lead;
      break;
    case 'deleteMeetingReport':
      if (!out.deleted) out.deleted = { leadId: b.leadId };
      break;
    default:
      break;
  }
  return out;
}

module.exports = { serverEcho };
