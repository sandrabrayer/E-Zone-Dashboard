/**
 * E-ZONE Dashboard — Google Apps Script backend
 * ------------------------------------------------
 * Paste this into the Apps Script project bound to the spreadsheet,
 * save, then:  Deploy → Manage deployments → Edit (pencil) → New version → Deploy.
 * The existing /exec URL stays the same; the new code goes live immediately.
 *
 * Endpoints:
 *   GET  ?action=getData                        → {ok, leads:[], patients:{houseId:[...]}}
 *   GET  ?action=saveAll&leads=...&patients=... → {ok:true}
 *   GET  ?action=getPayments                    → {ok, payments:[...]}
 *   POST action=savePayment / updatePayment     → {ok, payment, created|updated}
 *                                                 (upserts by payment.id)
 *   GET  ?action=getAdmittedRoster&secret=...    → {ok, patients:[{sourceApp,name,phone,house}]}
 *                                                 (cross-app, read-only: currently-admitted
 *                                                  patients with phone recovered via fromLead)
 *
 * Merge semantics (important for the split-save path in server.js):
 *   - leads present and non-empty → upsert each lead by id; leads whose id is
 *     not in the payload are left untouched. This mirrors the patients
 *     per-houseId behavior and lets the server chunk leads into batches.
 *   - leads missing, empty string, null, or empty array → leave Leads untouched
 *   - patients: for every houseId key present in the payload, that house's
 *     rows are replaced; houses NOT present in the payload are untouched
 *   - patients missing / empty object → leave the Patients sheet untouched
 *
 * Note: leads cannot be deleted through saveAll (only marked irrelevant via
 * the app). A dedicated delete action can be added if that becomes needed.
 */

const LEADS_SHEET    = 'Leads';
const PATIENTS_SHEET = 'Patients';
const PAYMENTS_SHEET = 'Payments';
const IRRELEVANT_LEADS_SHEET = 'לידים לא רלוונטיים';
const REMOVED_LEADS_SHEET    = 'לידים שהוסרו';
const DISCHARGED_PATIENTS_SHEET = 'מטופלים משוחררים';

/* ===== Bonuses module sheets =====
 *
 * Managers / BonusConfig / Outpatients power the /managers dashboard.
 * They are auto-created on first read with the headers below; populate
 * the rows by hand in the spreadsheet UI.
 *
 * Managers — one row per active manager assignment. end_date is left
 * blank while the assignment is current.
 *   house | manager_name | start_date | end_date
 *
 * BonusConfig — one row per house. bonus_base / bonus_per_day are the
 * monetary parameters of the model and live in the sheet so they can be
 * tuned without redeploying the script.
 *   house | bep_patients | capacity_patients | bonus_base | bonus_per_day | type
 *
 * Outpatients — continuity-therapy population. house_of_origin maps the
 * patient back to the residence whose manager earns the continuity bonus
 * (use "external" for patients who never lived in the network).
 * therapy_type ∈ { maintenance | day_2x | day_daily }.
 *   patient_name | house_of_origin | therapy_type | start_date | end_date | notes
 *
 * The bonus dashboard uses the keys raanana / ramot / efroni / rehab,
 * but the existing Patients sheet was set up with different houseIds
 * (asher / ramot / arfoni / rehab). MANAGER_HOUSE_TO_PATIENTS_HOUSE_ID
 * lets us read residence data from the Patients sheet without forcing a
 * historical rename.
 */
const MANAGERS_SHEET     = 'Managers';
const BONUS_CONFIG_SHEET = 'BonusConfig';
const OUTPATIENTS_SHEET  = 'Outpatients';

const MANAGER_COLUMNS       = ['house', 'manager_name', 'start_date', 'end_date'];
const BONUS_CONFIG_COLUMNS  = ['house', 'bep_patients', 'capacity_patients', 'bonus_base', 'bonus_per_day', 'type'];
const OUTPATIENT_COLUMNS    = ['patient_name', 'house_of_origin', 'therapy_type', 'start_date', 'end_date', 'notes'];

const MANAGER_HOUSES = ['raanana', 'ramot', 'efroni', 'rehab'];
const MANAGER_HOUSE_NAMES = {
  raanana: 'רעננה אשר',
  ramot:   'רמות השבים',
  efroni:  'קיסריה עפרוני',
  rehab:   'קיסריה ריהאב',
};
const MANAGER_HOUSE_TO_PATIENTS_HOUSE_ID = {
  raanana: 'asher',
  ramot:   'ramot',
  efroni:  'arfoni',
  rehab:   'rehab',
};

/* House managers keyed by patients-sheet house id. Names only — no phone
 * numbers. Exported by getData_ so the frontend can look up who runs each
 * house without a second round-trip. Exactly these four houses; keep in sync
 * with the patients-house ids above if the roster changes. */
const HOUSE_MANAGERS = {
  arfoni: 'חנן',
  rehab:  'רנטה',
  asher:  'עידו',
  ramot:  'אורן',
};

/* Manager WhatsApp phone numbers, keyed by manager NAME (not house). meetingWith
 * stores the name and Vered can override it to any manager, so the lookup must be
 * by name. Values are E.164 without the '+' (wa.me format). These constants are
 * the fallback; the live values are read from Script Properties (key
 * MANAGER_PHONE_<name>, e.g. MANAGER_PHONE_חנן) so a number can be corrected
 * without a code deploy. Exported by getData_ as managerPhones. */
const MANAGER_PHONES = {
  'חנן':  '972527046671',
  'רנטה': '972526765261',
  'עידו': '972524669814',
  'אורן': '972507580152',
};

/* Resolve the manager→phone map, letting a Script Property override each default.
 * For every known manager name, a property named 'MANAGER_PHONE_<name>' (if set
 * and non-empty) replaces the constant; otherwise the constant is used. Never
 * throws if PropertiesService is unavailable — falls back to the constants. */
function managerPhones_() {
  const out = {};
  var props = null;
  try { props = PropertiesService.getScriptProperties(); } catch (_) { props = null; }
  Object.keys(MANAGER_PHONES).forEach(function (name) {
    var override = props ? props.getProperty('MANAGER_PHONE_' + name) : null;
    out[name] = (override && String(override).trim()) || MANAGER_PHONES[name];
  });
  return out;
}

/* Continuity-therapy rates (₪/patient/month). The keys must match the
 * therapy_type values in the Outpatients sheet exactly. */
const CONTINUITY_RATES = {
  maintenance: 100,
  day_2x:      500,
  day_daily:   1000,
};

/* The quarterly stability bonus only starts being awarded from this
 * month onwards, even if the three preceding months also met the BEP
 * threshold. Effective month is May 2026; first eligible award is the
 * June 2026 calculation. */
const QUARTERLY_BONUS_AMOUNT = 5000;
const QUARTERLY_BONUS_FIRST_MONTH = '2026-06';

const LEAD_COLUMNS = [
  'id', 'name', 'phone', 'house', 'source', 'note',
  'stage', 'visitDate', 'visitTime', 'entryDate', 'advance', 'created',
  /* assignedTo (משוייך ל) — who owns the lead. Required on new leads via the
   * UI; appended LAST so the column lands before the metadata fields that
   * IRRELEVANT_LEAD_COLUMNS / REMOVED_LEAD_COLUMNS concat on. Pre-existing rows
   * have no value and stay blank (objectToRow_ defaults missing keys to ''). */
  'assignedTo',
  /* meetingWith — who the lead is meeting with (the house manager). APPEND
   * ONLY: readSheet_ maps cells to keys by POSITION, so this must stay last and
   * nothing above it may be reordered or inserted mid-array. Pre-existing rows
   * have no such column and stay blank (objectToRow_ defaults missing keys to
   * '', and normalizeLead reads it via pickField defaulting to ''). No backfill,
   * mirroring the assignedTo append. */
  'meetingWith'
];

/* Irrelevant-leads sheet mirrors LEAD_COLUMNS plus two metadata fields:
 *   originSheet — stable stage id the lead came from ('new'|'visit'|'paid'|'entry')
 *   movedAt     — ISO timestamp recorded when the lead was marked irrelevant
 * Storing the stage id (not the Hebrew label) keeps the restore lookup stable
 * across UI label renames. */
const IRRELEVANT_LEAD_COLUMNS = LEAD_COLUMNS.concat(['originSheet', 'movedAt', 'not_relevant_reason', 'not_relevant_note', 'disposition']);

/* Removed-leads sheet mirrors LEAD_COLUMNS plus two metadata fields:
 *   removedAt   — ISO timestamp recorded when the lead was soft-deleted
 *   originSheet — always 'Leads' in v1; the soft-delete action only fires
 *                 from the active leads kanban. Carried as a column anyway
 *                 so future flows (e.g., removing from the irrelevant tab)
 *                 can populate it without a schema change. */
const REMOVED_LEAD_COLUMNS = LEAD_COLUMNS.concat(['removedAt', 'originSheet']);

/* Must match the column headers in the Patients sheet exactly, in order.
 * The client generates a per-session id for each patient but it is NOT
 * persisted in the sheet — grouping + upserts happen by houseId.
 *
 * `source` and `notes` were added after the initial release. Sheets that
 * pre-date this will be backfilled by getOrCreateSheet_ on the next read. */
const PATIENT_COLUMNS = [
  'houseId', 'name', 'date', 'pay', 'adv',
  'status', 'fromLead', 'exitDate', 'source', 'notes'
];

/* Phase 2e-1 — discharged-patients audit sheet. Mirrors IRRELEVANT_LEAD_COLUMNS
 * shape: base columns + discharge-time metadata. `id` is prepended so
 * upsertRowById_ has a key to dedupe by (Patients sheet has no id column;
 * the client-side patient id is session-local but unique-at-write-time, which
 * is all the audit sheet needs). */
const DISCHARGED_PATIENT_COLUMNS =
  ['id'].concat(PATIENT_COLUMNS).concat(['dischargedAt', 'disposition', 'discharge_note', 'restored']);

/* Payments sheet columns. `id` is a deterministic per-patient-per-due-date
 * string built by the client (see paymentId() in app.js) so the same monthly
 * payment always upserts into the same row instead of creating duplicates. */
const PAYMENT_COLUMNS = [
  'id', 'patientId', 'patientName', 'houseId', 'dueDate',
  'amount', 'status', 'amountPaid', 'balance', 'timestamp'
];

/* ===== Entry points ===== */

function doGet(e) {
  return handle_(collectParams_(e));
}

function doPost(e) {
  return handle_(collectParams_(e));
}

function handle_(params) {
  try {
    const action = params.action;
    if (action === 'getData') return jsonOut_(getData_());
    if (action === 'getAdmittedRoster') {
      if (!admittedRosterAuthOk_(params)) {
        return jsonOut_({ ok: false, error: 'unauthorized' });
      }
      return jsonOut_(getAdmittedRoster_());
    }
    if (action === 'saveAll') {
      const leads    = parseJsonParam_(params.leads);
      const patients = parseJsonParam_(params.patients);
      const res = saveAll_(leads, patients);
      // The digest is the active-resident population, which an admission or a
      // patient status/house change (both ride saveAll's patients payload)
      // mutates; lead edits can too. Refresh when either bucket is present.
      // Fail-soft.
      if ((Array.isArray(leads) && leads.length > 0) ||
          (patients && typeof patients === 'object' && Object.keys(patients).length > 0)) {
        refreshDigestBestEffort_();
      }
      return jsonOut_(res);
    }
    if (action === 'getPayments') return jsonOut_(getPayments_());
    if (action === 'savePayment' || action === 'updatePayment') {
      const payment = parseJsonParam_(params.payment);
      return jsonOut_(upsertPayment_(payment));
    }
    if (action === 'moveLeadIrrelevant') {
      const res = moveLeadIrrelevant_(parseJsonParam_(params.lead));
      refreshDigestBestEffort_();
      return jsonOut_(res);
    }
    if (action === 'restoreLead') {
      const res = restoreLead_(parseJsonParam_(params.lead));
      refreshDigestBestEffort_();
      return jsonOut_(res);
    }
    if (action === 'removeLead') {
      const res = removeLead_(parseJsonParam_(params.lead));
      refreshDigestBestEffort_();
      return jsonOut_(res);
    }
    if (action === 'dischargePatient') {
      const res = dischargePatient_(parseJsonParam_(params.patient));
      // A discharge drops a resident out of the active population. Fail-soft.
      refreshDigestBestEffort_();
      return jsonOut_(res);
    }
    if (action === 'restorePatient') {
      const res = restorePatient_(parseJsonParam_(params.patient));
      refreshDigestBestEffort_();
      return jsonOut_(res);
    }
    if (action === 'restorePatientToActive') {
      const res = restorePatientToActive_(parseJsonParam_(params.patient));
      // Restoring a patient to active adds them back to the digest. Fail-soft.
      refreshDigestBestEffort_();
      return jsonOut_(res);
    }
    if (action === 'managersOverview') {
      return jsonOut_(managersOverview_(params.month));
    }
    if (action === 'managersHouse') {
      return jsonOut_(managersHouse_(params.house, params.month));
    }
    return jsonOut_({ ok: false, error: 'unknown_action', action: action || null });
  } catch (err) {
    return jsonOut_({ ok: false, error: 'exception', message: String((err && err.message) || err) });
  }
}

function collectParams_(e) {
  const out = {};
  if (e && e.parameter) {
    Object.keys(e.parameter).forEach(function (k) { out[k] = e.parameter[k]; });
  }
  if (e && e.postData && e.postData.contents) {
    try {
      const body = JSON.parse(e.postData.contents);
      if (body && typeof body === 'object') {
        Object.keys(body).forEach(function (k) { out[k] = body[k]; });
      }
    } catch (_) { /* body wasn't JSON — ignore */ }
  }
  return out;
}

function parseJsonParam_(v) {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch (_) { return null; }
}

function jsonOut_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/* ===== Sheet helpers ===== */

function getOrCreateSheet_(name, headers) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, headers.length).setValues([headers]);
    sh.setFrozenRows(1);
  } else if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, headers.length).setValues([headers]);
    sh.setFrozenRows(1);
  } else {
    // Existing sheet — non-destructively extend the header row if the
    // schema has grown since the sheet was created. Existing columns are
    // never overwritten, so bumping PATIENT_COLUMNS (or any headers list)
    // is safe on sheets that are already populated.
    const lastCol = sh.getLastColumn();
    if (lastCol < headers.length) {
      const missing = headers.slice(lastCol);
      sh.getRange(1, lastCol + 1, 1, missing.length).setValues([missing]);
    }
  }
  // Leads sheet: force the WHOLE visitDate + visitTime columns to plain text so
  // any write — present or future, via any path (mergeLeads_, upsertRowById_,
  // manual edit) — lands in a text cell and Sheets can never coerce "08:18" or
  // "2026-06-11" into a Date/time-typed cell (the coercion that drifted values
  // through the getValues→UTC round-trip). Done once at sheet-ensure time rather
  // than per-write. Idempotent.
  if (name === LEADS_SHEET) {
    forceColumnsText_(sh, LEAD_COLUMNS, ['visitDate', 'visitTime']);
  }
  return sh;
}

/* Force the ENTIRE named columns (by position in `columns`) of `sh` to the
 * plain-text ('@') number format — the whole column, so rows added later inherit
 * it too. Absent names are skipped. */
function forceColumnsText_(sh, columns, names) {
  const maxRows = sh.getMaxRows();
  for (let k = 0; k < names.length; k++) {
    const idx = columns.indexOf(names[k]);
    if (idx >= 0) sh.getRange(1, idx + 1, maxRows, 1).setNumberFormat('@');
  }
}

function readSheet_(sh, columns) {
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return [];
  const values = sh.getRange(2, 1, lastRow - 1, columns.length).getValues();
  const rows = [];
  for (let i = 0; i < values.length; i++) {
    const row = values[i];
    let hasContent = false;
    for (let j = 0; j < row.length; j++) {
      if (row[j] !== '' && row[j] !== null) { hasContent = true; break; }
    }
    if (!hasContent) continue;
    const obj = {};
    for (let j = 0; j < columns.length; j++) obj[columns[j]] = row[j];
    rows.push(obj);
  }
  return rows;
}

function objectToRow_(obj, columns) {
  const row = new Array(columns.length);
  for (let i = 0; i < columns.length; i++) {
    const v = obj[columns[i]];
    row[i] = (v === undefined || v === null) ? '' : v;
  }
  return row;
}

function clearBody_(sh, columnCount) {
  const lastRow = sh.getLastRow();
  if (lastRow > 1) {
    sh.getRange(2, 1, lastRow - 1, columnCount).clearContent();
  }
}

/* Today as YYYY-MM-DD in the spreadsheet's timezone — Israel rolls past
 * midnight ~3 hours before UTC, so a UTC-based stamp would mis-date leads
 * added late in the evening Israel time. Defensive default for the
 * `created` column when a payload arrives without one. */
function todayISODate_() {
  const tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone() || 'Asia/Jerusalem';
  return Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
}

/* Normalize a Sheets cell value to YYYY-MM-DD. Sheets sometimes hands back
 * a Date object for cells the user formatted as a date; we want the
 * persisted/returned value to always be a plain string so the frontend's
 * <input type="date"> can read it without extra parsing. */
function asISODate_(v) {
  if (v === undefined || v === null || v === '') return '';
  if (Object.prototype.toString.call(v) === '[object Date]') {
    const tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone() || 'Asia/Jerusalem';
    return Utilities.formatDate(v, tz, 'yyyy-MM-dd');
  }
  const s = String(v);
  const m = s.match(/^\d{4}-\d{2}-\d{2}/);
  return m ? m[0] : s;
}

/* Normalize a Sheets cell value to 'HH:MM' — the symmetric counterpart to
 * asISODate_. Sheets coerces a time string like "08:18" into a time-typed cell,
 * which getValues() hands back as a Date object anchored on the sheet epoch. We
 * extract the time in the SPREADSHEET timezone (never UTC): getValues built that
 * Date as the wall-clock time in the sheet tz, so formatting it back in the SAME
 * tz recovers the original "08:18" exactly — the UTC round-trip is what drifted
 * the value. A plain "HH:MM" string passes through unchanged (fast path). A
 * parseable timestamp string is formatted in the sheet tz too; anything
 * unrecognized returns '' rather than emitting a bogus time. */
function asISOTime_(v) {
  if (v === undefined || v === null || v === '') return '';
  const tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone() || 'Asia/Jerusalem';
  if (Object.prototype.toString.call(v) === '[object Date]') {
    return Utilities.formatDate(v, tz, 'HH:mm');
  }
  const s = String(v);
  const m = s.match(/^(\d{2}):(\d{2})/);
  if (m) return m[1] + ':' + m[2];
  const d = new Date(s);
  return isNaN(d) ? '' : Utilities.formatDate(d, tz, 'HH:mm');
}

/* The date columns and the time column present in a leads-shaped `columns` list.
 * Safe on any columns list — absent names are simply skipped. Used to normalize
 * and text-format lead writes so a value can't be coerced into a Date cell. */
function leadDateColIdxs_(columns) {
  const out = [];
  ['visitDate', 'entryDate', 'created'].forEach(function (n) {
    const i = columns.indexOf(n);
    if (i >= 0) out.push(i);
  });
  return out;
}
function leadTimeColIdx_(columns) { return columns.indexOf('visitTime'); }

/* Normalize a row array's date/time cells in place (returns the same row):
 * date columns via asISODate_, the time column via asISOTime_. */
function normalizeLeadRowDates_(row, columns) {
  leadDateColIdxs_(columns).forEach(function (i) { row[i] = asISODate_(row[i]); });
  const t = leadTimeColIdx_(columns);
  if (t >= 0) row[t] = asISOTime_(row[t]);
  return row;
}

/* Force the date/time columns of a single-row range to plain text BEFORE writing
 * it, so setValues can't be re-coerced into a Date cell. */
function setLeadDateColsText_(sh, columns, rowNumber) {
  const idxs = leadDateColIdxs_(columns);
  const t = leadTimeColIdx_(columns);
  if (t >= 0) idxs.push(t);
  idxs.forEach(function (i) { sh.getRange(rowNumber, i + 1, 1, 1).setNumberFormat('@'); });
}

/* ===== Read ===== */

function getData_() {
  const leadsSh      = getOrCreateSheet_(LEADS_SHEET, LEAD_COLUMNS);
  const patientsSh   = getOrCreateSheet_(PATIENTS_SHEET, PATIENT_COLUMNS);
  const irrelevantSh = getOrCreateSheet_(IRRELEVANT_LEADS_SHEET, IRRELEVANT_LEAD_COLUMNS);
  const removedSh    = getOrCreateSheet_(REMOVED_LEADS_SHEET, REMOVED_LEAD_COLUMNS);
  const dischargedSh = getOrCreateSheet_(DISCHARGED_PATIENTS_SHEET, DISCHARGED_PATIENT_COLUMNS);

  const leads               = readSheet_(leadsSh, LEAD_COLUMNS);
  // Normalize visitTime on the way out: a legacy cell coerced to a time-typed
  // value (before the text-format fix in mergeLeads_) reads back from getValues
  // as a Date; asISOTime_ converts it to 'HH:MM' in the SPREADSHEET timezone so
  // it no longer drifts through the UTC round-trip. A clean 'HH:MM' text cell
  // passes through unchanged.
  for (let i = 0; i < leads.length; i++) {
    leads[i].visitTime = asISOTime_(leads[i].visitTime);
  }
  const patientRows         = readSheet_(patientsSh, PATIENT_COLUMNS);
  const irrelevantLeads     = readSheet_(irrelevantSh, IRRELEVANT_LEAD_COLUMNS);
  const removedLeads        = readSheet_(removedSh, REMOVED_LEAD_COLUMNS);
  const dischargedPatients  = readSheet_(dischargedSh, DISCHARGED_PATIENT_COLUMNS);

  const patients = {};
  for (let i = 0; i < patientRows.length; i++) {
    const p = patientRows[i];
    const hid = p.houseId;
    if (!hid) continue;
    if (!patients[hid]) patients[hid] = [];
    patients[hid].push(p);
  }

  return {
    ok: true,
    leads: leads,
    patients: patients,
    irrelevantLeads: irrelevantLeads,
    removedLeads: removedLeads,
    dischargedPatients: dischargedPatients,
    houseManagers: HOUSE_MANAGERS,
    managerPhones: managerPhones_(),
  };
}

/* ===== Write (merge semantics) ===== */

function saveAll_(leads, patients) {
  const lock = LockService.getScriptLock();
  lock.tryLock(10000);
  try {
    // Leads — upsert by id; leads not in the payload are preserved
    if (Array.isArray(leads) && leads.length > 0) {
      mergeLeads_(leads);
    }

    // Patients — only touch houseIds that are present in the payload
    if (patients && typeof patients === 'object' && !Array.isArray(patients)) {
      const houseIds = Object.keys(patients);
      for (let i = 0; i < houseIds.length; i++) {
        const hid = houseIds[i];
        const arr = patients[hid];
        replaceHousePatients_(hid, Array.isArray(arr) ? arr : []);
      }
    }

    return { ok: true };
  } finally {
    try { lock.releaseLock(); } catch (_) { /* no-op */ }
  }
}

/**
 * Upsert leads by id. Existing rows whose id is present in the payload are
 * replaced; rows whose id is NOT in the payload are preserved. New ids are
 * appended. Same shape as replaceHousePatients_ but keyed on lead.id.
 *
 * `created` column semantics (added 2026-05):
 *   - Incoming lead with non-empty `created` → use as-is (lets the user
 *     edit a creation date through the dashboard's date picker).
 *   - Incoming lead with empty `created` AND id is NEW → stamp today.
 *     This is the defensive default: even if a payload from a non-dashboard
 *     route forgets the field, a new row never lands without a creation
 *     date.
 *   - Incoming lead with empty `created` AND id already exists in the sheet
 *     → preserve whatever value the sheet currently holds. This is what
 *     keeps legacy rows blank: editing any other field on a pre-`created`
 *     lead won't auto-backfill a guess.
 */
function mergeLeads_(leads) {
  const sh = getOrCreateSheet_(LEADS_SHEET, LEAD_COLUMNS);
  const idColIdx      = LEAD_COLUMNS.indexOf('id');
  const createdColIdx = LEAD_COLUMNS.indexOf('created');
  const lastRow = sh.getLastRow();

  const incomingIds = {};
  for (let i = 0; i < leads.length; i++) {
    const id = leads[i].id;
    if (id) incomingIds[String(id)] = true;
  }

  // Index existing rows by id so we can both (a) preserve them when they're
  // not in the payload and (b) read each one's current `created` value
  // without re-querying the sheet.
  const existingById = {};
  let kept = [];
  if (lastRow > 1) {
    const values = sh.getRange(2, 1, lastRow - 1, LEAD_COLUMNS.length).getValues();
    for (let i = 0; i < values.length; i++) {
      const row = values[i];
      const rowId = String(row[idColIdx] || '');
      if (rowId) existingById[rowId] = row;
      if (!incomingIds[rowId]) kept.push(row);
    }
  }

  const today = todayISODate_();

  const newRows = leads.map(function (l) {
    const merged = {};
    for (let k in l) merged[k] = l[k];

    const incomingCreated = merged.created;
    const isMissing = (incomingCreated === undefined ||
                      incomingCreated === null ||
                      incomingCreated === '');

    if (isMissing) {
      const existing = existingById[String(merged.id || '')];
      merged.created = existing
        ? asISODate_(existing[createdColIdx])  // update path → preserve
        : today;                               // insert path → stamp today
    } else {
      // Round-trip whatever the client sent through asISODate_ so a Date
      // object (some integrations) becomes the same plain YYYY-MM-DD that
      // the dashboard writes.
      merged.created = asISODate_(incomingCreated);
    }

    return objectToRow_(merged, LEAD_COLUMNS);
  });

  // Canonicalize the date/time columns to clean text for BOTH kept rows (whose
  // cells may already be coerced Date objects from getValues) and new rows, then
  // force those columns to plain text BEFORE writing. Without this Sheets coerces
  // "08:18" into a time-typed cell and "2026-06-11" into a date-typed cell; such
  // cells read back via getValues() as Date objects, serialize to the client as
  // UTC timestamps, and drift the value on every save→read cycle. Text storage
  // keeps them stable strings end-to-end. Mirrors replaceHousePatients_ exactly,
  // extended from one date column to all four date/time columns of the lead row.
  const vDateIdx = LEAD_COLUMNS.indexOf('visitDate');
  const vTimeIdx = LEAD_COLUMNS.indexOf('visitTime');
  const entryIdx = LEAD_COLUMNS.indexOf('entryDate');
  const dateColIdxs = [vDateIdx, entryIdx, createdColIdx].filter(function (i) { return i >= 0; });
  const finalRows = kept.concat(newRows).map(function (row) {
    dateColIdxs.forEach(function (i) { row[i] = asISODate_(row[i]); });
    if (vTimeIdx >= 0) row[vTimeIdx] = asISOTime_(row[vTimeIdx]);
    return row;
  });

  clearBody_(sh, LEAD_COLUMNS.length);
  if (finalRows.length > 0) {
    const textColIdxs = dateColIdxs.concat(vTimeIdx >= 0 ? [vTimeIdx] : []);
    textColIdxs.forEach(function (i) {
      sh.getRange(2, i + 1, finalRows.length, 1).setNumberFormat('@');
    });
    sh.getRange(2, 1, finalRows.length, LEAD_COLUMNS.length).setValues(finalRows);
  }
}

/**
 * Replace only the patients whose houseId matches `houseId`. Rows for other
 * houses are preserved untouched.
 */
function replaceHousePatients_(houseId, patientsArr) {
  const sh = getOrCreateSheet_(PATIENTS_SHEET, PATIENT_COLUMNS);
  const houseColIdx = PATIENT_COLUMNS.indexOf('houseId');
  const lastRow = sh.getLastRow();

  let kept = [];
  if (lastRow > 1) {
    const values = sh.getRange(2, 1, lastRow - 1, PATIENT_COLUMNS.length).getValues();
    kept = values.filter(function (row) { return row[houseColIdx] !== houseId; });
  }

  const newRows = patientsArr.map(function (p) {
    const withHouse = Object.assign({}, p, { houseId: houseId });
    return objectToRow_(withHouse, PATIENT_COLUMNS);
  });

  // Canonicalize the entry-date column to a clean YYYY-MM-DD string for BOTH
  // kept rows (whose cell may already be a coerced Date object from getValues)
  // and new rows (a string from the client). asISODate_ formats any Date in the
  // spreadsheet timezone, so the stored value is unambiguous text — mirrors the
  // treatment leads' `created` column gets in mergeLeads_.
  const dateColIdx = PATIENT_COLUMNS.indexOf('date');
  const finalRows = kept.concat(newRows).map(function (row) {
    if (dateColIdx >= 0) row[dateColIdx] = asISODate_(row[dateColIdx]);
    return row;
  });

  clearBody_(sh, PATIENT_COLUMNS.length);
  if (finalRows.length > 0) {
    // Force the entry-date column to plain text BEFORE writing so Sheets never
    // re-coerces "2026-06-11" into a date-typed cell. A date-typed cell reads
    // back via getValues() as a Date, serializes to the client as a UTC
    // timestamp, and drifts the day by one for UTC+2/+3 users. Text storage
    // keeps the value a stable string end-to-end — no UTC trip, no drift. Scope
    // is the date column only (single column), never the whole sheet.
    if (dateColIdx >= 0) {
      sh.getRange(2, dateColIdx + 1, finalRows.length, 1).setNumberFormat('@');
    }
    sh.getRange(2, 1, finalRows.length, PATIENT_COLUMNS.length).setValues(finalRows);
  }
}

/* ===== Irrelevant leads (move + restore) =====
 *
 * One-way automatic move on the move side; explicit restore brings a row back.
 * Both operations are atomic under a script lock so a concurrent saveAll can't
 * race a move and resurrect the row in the Leads sheet.
 */

function deleteRowsById_(sh, columns, idValue) {
  const idIdx = columns.indexOf('id');
  if (idIdx < 0) return;
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return;
  const values = sh.getRange(2, 1, lastRow - 1, columns.length).getValues();
  const target = String(idValue);
  const kept = values.filter(function (row) { return String(row[idIdx]) !== target; });
  if (kept.length === values.length) return;
  clearBody_(sh, columns.length);
  if (kept.length > 0) {
    sh.getRange(2, 1, kept.length, columns.length).setValues(kept);
  }
}

function upsertRowById_(sh, columns, obj) {
  const idIdx = columns.indexOf('id');
  if (idIdx < 0) return;
  // Normalize the date/time cells and, at the target row, force those columns to
  // text BEFORE setValues — the same treatment mergeLeads_ gives its writes, so a
  // restore/move/remove can't re-coerce visitDate/visitTime into a Date cell.
  const row = normalizeLeadRowDates_(objectToRow_(obj, columns), columns);
  const lastRow = sh.getLastRow();
  if (lastRow > 1) {
    const existingIds = sh.getRange(2, idIdx + 1, lastRow - 1, 1).getValues();
    for (let i = 0; i < existingIds.length; i++) {
      if (String(existingIds[i][0]) === String(obj.id)) {
        const r = i + 2;
        setLeadDateColsText_(sh, columns, r);
        sh.getRange(r, 1, 1, columns.length).setValues([row]);
        return;
      }
    }
  }
  // Insert: write at the next row (not appendRow) so the text format is applied
  // BEFORE the value lands.
  const target = sh.getLastRow() + 1;
  setLeadDateColsText_(sh, columns, target);
  sh.getRange(target, 1, 1, columns.length).setValues([row]);
}

/* ONE-TIME MANUAL REPAIR — run from the Apps Script editor.
 *
 * Intentionally PUBLIC (no trailing underscore): Apps Script hides underscore-
 * suffixed functions from the editor's Run dropdown, so a private name could
 * never be executed by hand — which is this function's entire purpose. Being
 * public does NOT expose it over HTTP: the web app only serves doGet/doPost, and
 * handle_ dispatches on a fixed allow-list of `action` string literals (ending in
 * 'unknown_action') that never names this function — so no request can reach it.
 * It is also not attached to any trigger.
 *
 * The legacy visitTime values were corrupted by repeated timezone round-trips and
 * are unrecoverable, so this BLANKS every existing visitTime and leaves the reader
 * to re-enter them by hand. visitDate is left intact. It also (re)forces the two
 * columns to plain text so subsequent writes stay clean. Logs how many rows were
 * blanked. Returns that count. Idempotent (a second run blanks 0). */
function repairLeadVisitTimes() {
  const sh = getOrCreateSheet_(LEADS_SHEET, LEAD_COLUMNS);
  // getOrCreateSheet_ already text-formats visitDate/visitTime, but do it here
  // too so the repair is self-contained if the ensure step ever changes.
  forceColumnsText_(sh, LEAD_COLUMNS, ['visitDate', 'visitTime']);

  const vTimeIdx = LEAD_COLUMNS.indexOf('visitTime');
  const lastRow = sh.getLastRow();
  if (vTimeIdx < 0 || lastRow < 2) {
    Logger.log('repairLeadVisitTimes: nothing to blank (data rows=' + Math.max(0, lastRow - 1) + ').');
    return 0;
  }

  const rng = sh.getRange(2, vTimeIdx + 1, lastRow - 1, 1);
  const vals = rng.getValues();
  let blanked = 0;
  const cleared = vals.map(function (r) {
    if (r[0] !== '' && r[0] !== null && r[0] !== undefined) blanked++;
    return [''];
  });
  rng.setValues(cleared);
  Logger.log('repairLeadVisitTimes: blanked ' + blanked + ' visitTime value(s); visitDate left intact.');
  return blanked;
}

function moveLeadIrrelevant_(lead) {
  if (!lead || !lead.id) return { ok: false, error: 'missing_lead' };
  const lock = LockService.getScriptLock();
  lock.tryLock(10000);
  try {
    const leadsSh = getOrCreateSheet_(LEADS_SHEET, LEAD_COLUMNS);
    const irrSh   = getOrCreateSheet_(IRRELEVANT_LEADS_SHEET, IRRELEVANT_LEAD_COLUMNS);

    const record = Object.assign({}, lead, {
      stage:               'irrelevant',
      originSheet:         lead.originSheet || '',
      movedAt:             lead.movedAt     || new Date().toISOString(),
      not_relevant_reason: lead.not_relevant_reason || '',
      not_relevant_note:   lead.not_relevant_note   || '',
      disposition:         lead.disposition || 'not_relevant',
    });

    deleteRowsById_(leadsSh, LEAD_COLUMNS, lead.id);
    upsertRowById_(irrSh, IRRELEVANT_LEAD_COLUMNS, record);
    return { ok: true, moved: true, lead: record };
  } finally {
    try { lock.releaseLock(); } catch (_) { /* no-op */ }
  }
}

function restoreLead_(lead) {
  if (!lead || !lead.id) return { ok: false, error: 'missing_lead' };
  const lock = LockService.getScriptLock();
  lock.tryLock(10000);
  try {
    const leadsSh = getOrCreateSheet_(LEADS_SHEET, LEAD_COLUMNS);
    const irrSh   = getOrCreateSheet_(IRRELEVANT_LEADS_SHEET, IRRELEVANT_LEAD_COLUMNS);

    // Strip metadata fields when re-inserting into Leads — they only exist on
    // the irrelevant sheet.
    const restored = {};
    for (let i = 0; i < LEAD_COLUMNS.length; i++) {
      const k = LEAD_COLUMNS[i];
      restored[k] = lead[k] === undefined ? '' : lead[k];
    }

    deleteRowsById_(irrSh, IRRELEVANT_LEAD_COLUMNS, lead.id);
    upsertRowById_(leadsSh, LEAD_COLUMNS, restored);
    return { ok: true, restored: true, lead: restored };
  } finally {
    try { lock.releaseLock(); } catch (_) { /* no-op */ }
  }
}

/* ===== Soft-delete (remove from Leads → לידים שהוסרו) =====
 *
 * The retention tab surfaces removed leads read-only — there is no in-app
 * restore for soft-deleted rows in v1. Manual restore via Sheets is the
 * documented recovery path. Mirrors moveLeadIrrelevant_'s structure.
 */
function removeLead_(lead) {
  if (!lead || !lead.id) return { ok: false, error: 'missing_lead' };
  const lock = LockService.getScriptLock();
  lock.tryLock(10000);
  try {
    const leadsSh   = getOrCreateSheet_(LEADS_SHEET, LEAD_COLUMNS);
    const removedSh = getOrCreateSheet_(REMOVED_LEADS_SHEET, REMOVED_LEAD_COLUMNS);

    const record = Object.assign({}, lead, {
      removedAt:   lead.removedAt   || new Date().toISOString(),
      originSheet: lead.originSheet || 'Leads',
    });

    // Append-before-delete order: if the upsert into the removed sheet throws
    // for any reason, the active row is still intact. The reverse order would
    // risk losing the row entirely.
    upsertRowById_(removedSh, REMOVED_LEAD_COLUMNS, record);
    deleteRowsById_(leadsSh, LEAD_COLUMNS, lead.id);
    return { ok: true, removed: true, lead: record };
  } finally {
    try { lock.releaseLock(); } catch (_) { /* no-op */ }
  }
}

/* ===== Patient discharge (Phase 2e-1) — additive audit only =====
 *
 * dischargePatient_ writes to DISCHARGED_PATIENTS_SHEET. It does NOT delete
 * from the Patients sheet — that side stays on the existing client-driven
 * saveAll → replaceHousePatients_ path (whole-house-replace, which is how
 * patient rows are mutated today). 2e-2 will wire the שחרר button to call
 * both this audit-write AND the existing save flow; this PR is purely
 * foundation.
 *
 * Mirrors moveLeadIrrelevant_'s pattern: record with defaults, lock, upsert.
 * Append-only on the discharged sheet.
 */
function dischargePatient_(patient) {
  if (!patient || !patient.id) return { ok: false, error: 'missing_patient' };
  const lock = LockService.getScriptLock();
  lock.tryLock(10000);
  try {
    const dischargedSh = getOrCreateSheet_(DISCHARGED_PATIENTS_SHEET, DISCHARGED_PATIENT_COLUMNS);

    const record = Object.assign({}, patient, {
      dischargedAt:   patient.dischargedAt   || new Date().toISOString(),
      disposition:    patient.disposition    || '',
      discharge_note: patient.discharge_note || '',
    });

    upsertRowById_(dischargedSh, DISCHARGED_PATIENT_COLUMNS, record);
    return { ok: true, discharged: true, patient: record };
  } finally {
    try { lock.releaseLock(); } catch (_) { /* no-op */ }
  }
}

/* Restore turns a discharged patient back into a new lead. The discharge
 * record is preserved as the audit trail — no delete from DISCHARGED — but
 * Phase 2e-2 marks the source row with restored='TRUE' so renderDischargedPatients
 * can hide it on the frontend (audit truth preserved, UI rough edge closed).
 * The new lead carries over name/phone/house only; everything else starts
 * blank with stage='new' and created=now. */
function restorePatient_(patient) {
  if (!patient || !patient.id) return { ok: false, error: 'missing_patient' };
  const lock = LockService.getScriptLock();
  lock.tryLock(10000);
  try {
    const leadsSh = getOrCreateSheet_(LEADS_SHEET, LEAD_COLUMNS);

    const restored = {};
    for (let i = 0; i < LEAD_COLUMNS.length; i++) {
      restored[LEAD_COLUMNS[i]] = '';
    }
    restored.id      = (patient.newLeadId && String(patient.newLeadId)) ||
                       ('id-' + Utilities.getUuid().slice(0, 8));
    restored.name    = patient.name  || '';
    restored.phone   = patient.phone || '';
    restored.house   = patient.house || '';
    restored.stage   = 'new';
    restored.created = todayISODate_();

    upsertRowById_(leadsSh, LEAD_COLUMNS, restored);

    const dischargedSh = getOrCreateSheet_(DISCHARGED_PATIENTS_SHEET, DISCHARGED_PATIENT_COLUMNS);
    const flagged = Object.assign({}, patient, { restored: 'TRUE' });
    upsertRowById_(dischargedSh, DISCHARGED_PATIENT_COLUMNS, flagged);

    return {
      ok: true,
      restored: true,
      newLeadId: restored.id,
      originalPatientId: patient.id,
      lead: restored,
    };
  } finally {
    try { lock.releaseLock(); } catch (_) { /* no-op */ }
  }
}

/* Restore-to-active companion to restorePatient_. The patient's ACTIVE row is
 * re-activated by the client's saveAll -> replaceHousePatients_ path (status is
 * flipped to 'active' there), so this action deliberately does NOT touch the
 * Patients sheet and creates NO lead. It ONLY flags the discharged audit row
 * restored='TRUE' (matched by the persisted audit id via upsertRowById_) so the
 * row leaves the discharged tab. The audit row itself is KEPT as the trail. */
function restorePatientToActive_(patient) {
  if (!patient || !patient.id) return { ok: false, error: 'missing_patient' };
  const lock = LockService.getScriptLock();
  lock.tryLock(10000);
  try {
    const dischargedSh = getOrCreateSheet_(DISCHARGED_PATIENTS_SHEET, DISCHARGED_PATIENT_COLUMNS);
    const flagged = Object.assign({}, patient, { restored: 'TRUE' });
    upsertRowById_(dischargedSh, DISCHARGED_PATIENT_COLUMNS, flagged);
    return { ok: true, restoredToActive: true, id: patient.id };
  } finally {
    try { lock.releaseLock(); } catch (_) { /* no-op */ }
  }
}

/* ===== Cross-app: admitted roster (read-only) =====
 *
 * getAdmittedRoster exposes currently-admitted patients with a recovered,
 * normalized phone so the E-Zone Therapists app can populate its inpatient
 * tab. The Patients sheet has no phone column; a phone is recovered by joining
 * Patients.fromLead → Leads.id and reading that lead's phone. Patients added
 * directly through the dashboard (source:'direct_admin') carry fromLead:'' and
 * therefore have no recoverable phone — they are still returned, but with
 * phone:'' so the therapists side falls back to free-text rather than
 * fabricating a match.
 *
 * Projection is intentionally minimal: { sourceApp, name, phone, house }. No
 * lead note, stage, advance, pricing, payment, or any other Leads/Patients
 * field is exposed. test/admitted-roster.test.js locks this no-leak contract
 * against the shipped function.
 *
 * Auth mirrors the sibling cross-app endpoints' shared-secret shape, but is
 * deliberately FAIL-CLOSED rather than fail-open: this is the first
 * authenticated endpoint in the repo and it exposes patient names + phones, so
 * an unconfigured or mismatched secret must never serve data. The roster is
 * returned only when ADMITTED_ROSTER_SECRET is set AND the request's ?secret=
 * matches it; otherwise the endpoint refuses. ADMITTED_ROSTER_SECRET is a
 * SEPARATE secret from the other apps' secrets — it must be set as a Script
 * Property before the endpoint will return anything.
 */
const ADMITTED_ROSTER_SECRET_PROP = 'ADMITTED_ROSTER_SECRET';

function admittedRosterAuthOk_(params) {
  const expected = PropertiesService.getScriptProperties().getProperty(ADMITTED_ROSTER_SECRET_PROP);
  // Fail closed: no secret configured → refuse (never serve patient PII open).
  if (!expected) return false;
  const got = (params && params.secret) ? String(params.secret) : '';
  return got === expected;
}

/* Normalize a phone to canonical Israeli local form: strip every non-digit,
 * then collapse a leading 972 country code to a single leading 0
 * (e.g. "+972-52-765-4321" → "0527654321"). Empty/blank → ''. */
function normalizePhone_(raw) {
  if (raw === undefined || raw === null) return '';
  let digits = String(raw).replace(/[^\d]/g, '');
  if (!digits) return '';
  if (digits.indexOf('972') === 0) digits = '0' + digits.slice(3);
  return digits;
}

function getAdmittedRoster_() {
  const patientsSh = getOrCreateSheet_(PATIENTS_SHEET, PATIENT_COLUMNS);
  const leadsSh    = getOrCreateSheet_(LEADS_SHEET, LEAD_COLUMNS);
  const patients   = readSheet_(patientsSh, PATIENT_COLUMNS);
  const leads      = readSheet_(leadsSh, LEAD_COLUMNS);

  // Index lead phones by lead id for the fromLead join.
  const phoneByLeadId = {};
  for (let i = 0; i < leads.length; i++) {
    const l = leads[i];
    if (l && l.id !== undefined && l.id !== null && l.id !== '') {
      phoneByLeadId[String(l.id)] = l.phone || '';
    }
  }

  const out = [];
  for (let p = 0; p < patients.length; p++) {
    const pt = patients[p];
    if (!pt || !pt.name) continue;
    // Admitted = not released. The dashboard sets status='released' AND an
    // exitDate on release, and the occupancy tab keys on status !== 'released'
    // (app.js); checking both keeps this consistent with occupancy even for
    // hand-edited rows where only one field was set.
    if (String(pt.status || '').trim() === 'released') continue;
    if (String(pt.exitDate || '').trim() !== '') continue;

    const rawPhone = pt.fromLead ? (phoneByLeadId[String(pt.fromLead)] || '') : '';
    out.push({
      sourceApp: 'ezone-dashboard',
      name:      pt.name || '',
      phone:     normalizePhone_(rawPhone),
      house:     pt.houseId || '',
      // Admission/entry date (PATIENT_COLUMNS 'date' — labelled "תאריך כניסה"
      // in the dashboard UI). Feeds the outpatient app's מסלול המשך tenure
      // badges. asISODate_ yields '' for blank/invalid so consumers that
      // ignore entryDate are unaffected. Additive — nothing else changed.
      entryDate: asISODate_(pt.date),
    });
  }
  return { ok: true, patients: out };
}

/* ===== Payments ===== */

function getPayments_() {
  const sh = getOrCreateSheet_(PAYMENTS_SHEET, PAYMENT_COLUMNS);
  return { ok: true, payments: readSheet_(sh, PAYMENT_COLUMNS) };
}

/**
 * Upsert a single payment row by id. Both `savePayment` and `updatePayment`
 * route here: if a row with the same id exists it's replaced in place,
 * otherwise the record is appended. id is required — it's generated client-
 * side as a deterministic `pay::<houseId>::<name>::<entryDate>::<dueDate>`
 * string so the same monthly payment always maps to the same row.
 */
function upsertPayment_(payment) {
  if (!payment || typeof payment !== 'object') {
    return { ok: false, error: 'missing_payment' };
  }
  if (!payment.id) {
    return { ok: false, error: 'missing_id' };
  }

  const lock = LockService.getScriptLock();
  lock.tryLock(10000);
  try {
    const sh = getOrCreateSheet_(PAYMENTS_SHEET, PAYMENT_COLUMNS);
    const idIdx = PAYMENT_COLUMNS.indexOf('id');
    const lastRow = sh.getLastRow();
    const row = objectToRow_(payment, PAYMENT_COLUMNS);

    if (lastRow > 1) {
      const existingIds = sh.getRange(2, idIdx + 1, lastRow - 1, 1).getValues();
      for (let i = 0; i < existingIds.length; i++) {
        if (String(existingIds[i][0]) === String(payment.id)) {
          sh.getRange(i + 2, 1, 1, PAYMENT_COLUMNS.length).setValues([row]);
          return { ok: true, payment: payment, updated: true };
        }
      }
    }

    sh.appendRow(row);
    return { ok: true, payment: payment, created: true };
  } finally {
    try { lock.releaseLock(); } catch (_) { /* no-op */ }
  }
}

/* ===== Bonuses module ===== */

/* "YYYY-MM" for a Date in the spreadsheet's timezone. The script's
 * timezone is what matters for monthly bucketing — using the JS
 * runtime's UTC offsets directly would mis-attribute boundary days. */
function ymOf_(d) {
  return Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM');
}
function ymdOf_(d) {
  return Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

/* Parse a value from the sheet into a midnight-local Date or null. The
 * value can already be a Date (typed cell) or a string in any common
 * Hebrew/ISO form; we normalize all of them through `new Date(...)`. */
function parseDate_(v) {
  if (!v && v !== 0) return null;
  if (v instanceof Date) {
    if (isNaN(v.getTime())) return null;
    return new Date(v.getFullYear(), v.getMonth(), v.getDate());
  }
  const s = String(v).trim();
  if (!s) return null;
  const d = new Date(s);
  if (isNaN(d.getTime())) return null;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function startOfMonth_(ym) {
  const [y, m] = ym.split('-').map(Number);
  return new Date(y, m - 1, 1);
}
function endOfMonth_(ym) {
  const [y, m] = ym.split('-').map(Number);
  return new Date(y, m, 0); // day 0 of next month = last of this month
}
function daysInMonth_(ym) {
  return endOfMonth_(ym).getDate();
}

/* Returns "YYYY-MM" for the month that is `n` calendar months before
 * the given month. n=1 → previous month. */
function offsetMonth_(ym, n) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(y, m - 1 - n, 1);
  return ymOf_(d);
}

/* The "current month" used for the dashboard if the caller doesn't pass
 * one. Single source of truth for the default. */
function defaultMonth_() {
  return ymOf_(new Date());
}

/* ----- Sheet readers (with auto-creation) ----- */

function readManagers_() {
  const sh = getOrCreateSheet_(MANAGERS_SHEET, MANAGER_COLUMNS);
  return readSheet_(sh, MANAGER_COLUMNS);
}

function readBonusConfig_() {
  const sh = getOrCreateSheet_(BONUS_CONFIG_SHEET, BONUS_CONFIG_COLUMNS);
  return readSheet_(sh, BONUS_CONFIG_COLUMNS);
}

function readOutpatients_() {
  const sh = getOrCreateSheet_(OUTPATIENTS_SHEET, OUTPATIENT_COLUMNS);
  return readSheet_(sh, OUTPATIENT_COLUMNS);
}

/* Patients with normalized entry/exit Date objects. Pulled once per
 * request and shared between overview and per-house calls. */
function readPatientsForBonus_() {
  const sh = getOrCreateSheet_(PATIENTS_SHEET, PATIENT_COLUMNS);
  const rows = readSheet_(sh, PATIENT_COLUMNS);
  return rows.map(function (p) {
    return {
      houseId:  p.houseId,
      name:     p.name,
      entry:    parseDate_(p.date),
      exit:     parseDate_(p.exitDate),
      status:   p.status,
    };
  });
}

/* ----- Active manager lookup -----
 *
 * Picks the row whose [start_date, end_date] window covers `asOf`. If
 * end_date is blank the assignment is treated as still current. If
 * multiple rows match (shouldn't happen, but the sheet is
 * human-edited), the latest start_date wins. */
function activeManagerForHouse_(managers, houseKey, asOf) {
  let best = null;
  for (let i = 0; i < managers.length; i++) {
    const m = managers[i];
    if (m.house !== houseKey) continue;
    const start = parseDate_(m.start_date);
    const end   = parseDate_(m.end_date);
    if (start && asOf < start) continue;
    if (end && asOf > end) continue;
    if (!best || (start && parseDate_(best.start_date) && start > parseDate_(best.start_date))) {
      best = m;
    }
  }
  return best ? best.manager_name : '';
}

/* ----- Per-day occupancy and patient-day stats for one house/month ----- */
function computeMonthStats_(patients, patientsHouseId, ym) {
  const start = startOfMonth_(ym);
  const end   = endOfMonth_(ym);
  const nDays = daysInMonth_(ym);

  let treatmentDays = 0;
  let entriesMonth = 0;
  let exitsMonth = 0;
  const dailyCounts = new Array(nDays).fill(0);
  const activity = [];

  for (let i = 0; i < patients.length; i++) {
    const p = patients[i];
    if (p.houseId !== patientsHouseId) continue;
    if (!p.entry) continue;

    // Effective residency window for this patient: [entry, exit] inclusive.
    // If exit is missing, the patient is still in residence — treat the
    // window as open-ended through end-of-month.
    const winStart = p.entry;
    const winEnd   = p.exit || end;

    // Skip patients whose window doesn't overlap the month at all.
    if (winEnd < start || winStart > end) {
      // not in this month, but we still may want to log nothing
    } else {
      const overlapStart = winStart > start ? winStart : start;
      const overlapEnd   = winEnd   < end   ? winEnd   : end;
      // Increment per-day counts across the overlap.
      for (let d = new Date(overlapStart); d <= overlapEnd; d.setDate(d.getDate() + 1)) {
        const idx = d.getDate() - 1;
        dailyCounts[idx]++;
        treatmentDays++;
      }
    }

    if (p.entry >= start && p.entry <= end) {
      entriesMonth++;
      activity.push({ date: ymdOf_(p.entry), kind: 'entry', name: p.name });
    }
    if (p.exit && p.exit >= start && p.exit <= end) {
      exitsMonth++;
      activity.push({ date: ymdOf_(p.exit), kind: 'exit', name: p.name });
    }
  }

  // Sort newest-first so the activity log reads chronologically downward.
  activity.sort(function (a, b) { return a.date < b.date ? 1 : a.date > b.date ? -1 : 0; });

  const dailyChart = dailyCounts.map(function (c, i) {
    return { date: ymdOf_(new Date(start.getFullYear(), start.getMonth(), i + 1)), count: c };
  });

  return {
    treatmentDays: treatmentDays,
    avgDaily: nDays > 0 ? treatmentDays / nDays : 0,
    entriesMonth: entriesMonth,
    exitsMonth: exitsMonth,
    dailyCounts: dailyCounts,
    dailyChart: dailyChart,
    activity: activity,
  };
}

/* True when the average daily count for `ym` met or exceeded BEP. */
function houseMetBepInMonth_(patients, patientsHouseId, ym, bep) {
  const stats = computeMonthStats_(patients, patientsHouseId, ym);
  return stats.avgDaily >= bep;
}

/* ----- Continuity bonus (Outpatients) -----
 *
 * Counts active outpatients per therapy_type whose residency window
 * overlaps the month, grouped by house_of_origin. Returns an object
 * keyed by manager-house with { maintenance, day_2x, day_daily, total }. */
function computeContinuityByHouse_(outpatients, ym) {
  const start = startOfMonth_(ym);
  const end   = endOfMonth_(ym);
  const out = {};
  MANAGER_HOUSES.forEach(function (h) {
    out[h] = { maintenance: 0, day_2x: 0, day_daily: 0, total: 0 };
  });

  for (let i = 0; i < outpatients.length; i++) {
    const o = outpatients[i];
    const houseKey = String(o.house_of_origin || '').trim();
    if (!out[houseKey]) continue; // "external" or unknown — not bonusable
    const ttype = String(o.therapy_type || '').trim();
    if (!CONTINUITY_RATES.hasOwnProperty(ttype)) continue;
    const oStart = parseDate_(o.start_date);
    const oEnd   = parseDate_(o.end_date) || end;
    if (oStart && oStart > end) continue;
    if (oEnd && oEnd < start) continue;
    out[houseKey][ttype]++;
    out[houseKey].total += CONTINUITY_RATES[ttype];
  }
  return out;
}

/* ----- Bonus calculation for one house in one month ----- */
function calcHouseBonus_(opts) {
  const cfg = opts.cfg;
  const stats = opts.stats;
  const ym = opts.ym;
  const continuity = opts.continuity || { maintenance: 0, day_2x: 0, day_daily: 0, total: 0 };
  const consecutiveAboveBep = opts.consecutiveAboveBep || 0;

  const bep = Number(cfg.bep_patients) || 0;
  const base = Number(cfg.bonus_base) || 0;
  const perDay = Number(cfg.bonus_per_day) || 0;

  // above-BEP patient-days for the month
  let aboveBepDays = 0;
  for (let i = 0; i < stats.dailyCounts.length; i++) {
    const c = stats.dailyCounts[i];
    if (c > bep) aboveBepDays += (c - bep);
  }

  const qualifies = stats.avgDaily >= bep && bep > 0;
  const baseBonus  = qualifies ? base : 0;
  const dailyBonus = qualifies ? aboveBepDays * perDay : 0;

  // Quarterly stability — 3 consecutive months above BEP, but not
  // awarded before QUARTERLY_BONUS_FIRST_MONTH.
  const quarterlyEligible = consecutiveAboveBep >= 3 && ym >= QUARTERLY_BONUS_FIRST_MONTH && qualifies;
  const quarterlyBonus = quarterlyEligible ? QUARTERLY_BONUS_AMOUNT : 0;

  // Continuity bonus is only paid if the manager qualifies (i.e., house
  // is at/above BEP). Otherwise the manager gets 0 across the board.
  const continuityBonus = qualifies ? continuity.total : 0;

  const total = baseBonus + dailyBonus + quarterlyBonus + continuityBonus;

  return {
    qualifies: qualifies,
    bep: bep,
    avgDaily: stats.avgDaily,
    aboveBepDays: aboveBepDays,
    base: baseBonus,
    daily: dailyBonus,
    dailyRate: perDay,
    quarterly: quarterlyBonus,
    quarterlyEligible: quarterlyEligible,
    consecutiveAboveBep: consecutiveAboveBep,
    continuity: {
      maintenance: continuity.maintenance,
      day_2x:      continuity.day_2x,
      day_daily:   continuity.day_daily,
      total:       continuityBonus,
      rates:       CONTINUITY_RATES,
    },
    total: total,
  };
}

/* Walks backwards from the month BEFORE `ym` and counts how many
 * preceding months had average daily count >= BEP, stopping at the
 * first miss. Used as input to the quarterly bonus (need 3 consecutive
 * months including the current one). */
function consecutiveMonthsAboveBepBefore_(patients, patientsHouseId, ym, bep) {
  if (!bep) return 0;
  let n = 0;
  for (let i = 1; i <= 24; i++) {
    const prev = offsetMonth_(ym, i);
    if (houseMetBepInMonth_(patients, patientsHouseId, prev, bep)) {
      n++;
    } else {
      break;
    }
  }
  return n;
}

/* ----- Endpoints ----- */

function managersOverview_(monthParam) {
  const ym = monthParam ? String(monthParam) : defaultMonth_();
  const monthEnd = endOfMonth_(ym);

  const managers    = readManagers_();
  const configs     = readBonusConfig_();
  const patients    = readPatientsForBonus_();
  const outpatients = readOutpatients_();
  const continuityByHouse = computeContinuityByHouse_(outpatients, ym);

  const configByHouse = {};
  configs.forEach(function (c) { configByHouse[c.house] = c; });

  const houses = MANAGER_HOUSES.map(function (key) {
    const cfg = configByHouse[key] || {};
    const patientsHouseId = MANAGER_HOUSE_TO_PATIENTS_HOUSE_ID[key];
    const stats = computeMonthStats_(patients, patientsHouseId, ym);
    const bep = Number(cfg.bep_patients) || 0;
    const consecutive = consecutiveMonthsAboveBepBefore_(patients, patientsHouseId, ym, bep);
    const bonus = calcHouseBonus_({
      cfg: cfg,
      stats: stats,
      ym: ym,
      continuity: continuityByHouse[key],
      consecutiveAboveBep: stats.avgDaily >= bep && bep > 0 ? consecutive + 1 : 0,
    });

    // Live patient count = number whose window covers month-end.
    let patientsNow = 0;
    for (let i = 0; i < patients.length; i++) {
      const p = patients[i];
      if (p.houseId !== patientsHouseId) continue;
      if (!p.entry) continue;
      const winEnd = p.exit || monthEnd;
      if (p.entry <= monthEnd && winEnd >= monthEnd) patientsNow++;
    }

    return {
      key: key,
      name: MANAGER_HOUSE_NAMES[key],
      manager: activeManagerForHouse_(managers, key, monthEnd),
      type: cfg.type || '',
      bep: bep,
      capacity: Number(cfg.capacity_patients) || 0,
      patientsNow: patientsNow,
      avgDaily: stats.avgDaily,
      treatmentDays: stats.treatmentDays,
      entriesMonth: stats.entriesMonth,
      exitsMonth: stats.exitsMonth,
      qualifies: bonus.qualifies,
      bonus: bonus,
    };
  });

  let totalActive = 0;
  let totalCapacity = 0;
  let totalTreatmentDays = 0;
  let totalBonus = 0;
  houses.forEach(function (h) {
    totalActive       += h.patientsNow;
    totalCapacity     += h.capacity;
    totalTreatmentDays += h.treatmentDays;
    totalBonus        += h.bonus.total;
  });

  return {
    ok: true,
    month: ym,
    totals: {
      activePatients:    totalActive,
      networkCapacity:   totalCapacity,
      totalTreatmentDays: totalTreatmentDays,
      totalBonus:        totalBonus,
    },
    houses: houses,
  };
}

function managersHouse_(houseKey, monthParam) {
  const key = String(houseKey || '').trim();
  if (!MANAGER_HOUSE_TO_PATIENTS_HOUSE_ID[key]) {
    return { ok: false, error: 'unknown_house', house: key };
  }
  const ym = monthParam ? String(monthParam) : defaultMonth_();
  const monthEnd = endOfMonth_(ym);

  const managers    = readManagers_();
  const configs     = readBonusConfig_();
  const patients    = readPatientsForBonus_();
  const outpatients = readOutpatients_();
  const continuityByHouse = computeContinuityByHouse_(outpatients, ym);

  const cfg = configs.filter(function (c) { return c.house === key; })[0] || {};
  const patientsHouseId = MANAGER_HOUSE_TO_PATIENTS_HOUSE_ID[key];
  const stats = computeMonthStats_(patients, patientsHouseId, ym);
  const bep = Number(cfg.bep_patients) || 0;
  const consecutive = consecutiveMonthsAboveBepBefore_(patients, patientsHouseId, ym, bep);
  const bonus = calcHouseBonus_({
    cfg: cfg,
    stats: stats,
    ym: ym,
    continuity: continuityByHouse[key],
    consecutiveAboveBep: stats.avgDaily >= bep && bep > 0 ? consecutive + 1 : 0,
  });

  let patientsNow = 0;
  for (let i = 0; i < patients.length; i++) {
    const p = patients[i];
    if (p.houseId !== patientsHouseId) continue;
    if (!p.entry) continue;
    const winEnd = p.exit || monthEnd;
    if (p.entry <= monthEnd && winEnd >= monthEnd) patientsNow++;
  }

  return {
    ok: true,
    month: ym,
    key: key,
    name: MANAGER_HOUSE_NAMES[key],
    manager: activeManagerForHouse_(managers, key, monthEnd),
    type: cfg.type || '',
    bep: bep,
    capacity: Number(cfg.capacity_patients) || 0,
    bonusBase: Number(cfg.bonus_base) || 0,
    bonusPerDay: Number(cfg.bonus_per_day) || 0,
    patientsNow: patientsNow,
    avgDaily: stats.avgDaily,
    treatmentDays: stats.treatmentDays,
    entriesMonth: stats.entriesMonth,
    exitsMonth: stats.exitsMonth,
    dailyChart: stats.dailyChart,
    activity: stats.activity,
    bonus: bonus,
  };
}

/* ===== Coordinators digest: ActivePatients feed (read-only export) =====
 *
 * A separate, small spreadsheet that THIS app creates and owns (sole writer)
 * so downstream apps (coordinators) can read the currently-active patient
 * population without touching — or being coupled to — the main dashboard
 * spreadsheet. This mirrors the digest pattern proven with logistics + kitchen.
 *
 * WHAT IT CONTAINS
 *   One row per patient currently in active treatment in a house — i.e. a
 *   Patients-sheet resident whose status is `active` (פעיל). This is the same
 *   population the dashboard's per-house occupancy board shows, so the digest's
 *   per-house row counts match the board. Rebuilt in full on every rebuild;
 *   never incremental.
 *
 *   NOTE — this used to source from pre-admission `paid` kanban leads ("בטיפול
 *   פעיל" is the label on that column). That was wrong: the paid column holds a
 *   handful of leads who have paid an advance but are NOT yet in a house, most
 *   with no house set, so the feed was near-empty and skewed to one house. The
 *   patients coordinators need — "in active treatment, in every house" — are the
 *   admitted residents, which is what this now exports.
 *
 * FROZEN COLUMN CONTRACT (append-only — never reorder or remove; see
 * DIGEST-CONTRACT.md at the repo root, which is the authoritative copy):
 *   house       — canonical house id: ramot | raanana | efroni | rehab
 *   patientName — patient display name
 *   patientId   — stable per-patient key. The Patients sheet has no persisted id
 *                 column, so this is derived deterministically from the patient's
 *                 identifying fields (houseId + name + entry date); the same
 *                 patient yields the same id across rebuilds.
 *   updatedAt   — ISO 8601 UTC timestamp of the rebuild that produced the row
 *
 * HARD RULE: the digest carries NO financial fields — no billing, debt, rates,
 * advance, or payment data. The projection below builds each row from exactly
 * the four columns above and nothing else; the test locks this no-leak contract
 * against the shipped function.
 *
 * HOUSES: only the four canonical houses are exported. The dashboard's internal
 * house ids (and their Hebrew display names) map to canonical ids below; houses
 * outside the four (pardes, sde, anything unknown) are excluded, not renamed.
 *
 * WRITE TRIGGERS: rebuilt best-effort at the end of every lead/patient-mutating
 * request (see refreshDigestBestEffort_ wired into handle_) so an admission,
 * discharge, or status change is reflected promptly, plus an hourly time-based
 * trigger as a backstop in case a mutation path is ever missed. The in-request
 * rebuild is fail-soft: a digest error can never break the primary read/write
 * path.
 */
const DIGEST_TAB                = 'ActivePatients';
const DIGEST_COLUMNS            = ['house', 'patientName', 'patientId', 'updatedAt'];
const DIGEST_SPREADSHEET_ID_PROP = 'DIGEST_SPREADSHEET_ID';
const DIGEST_SPREADSHEET_NAME    = 'E-Zone Dashboard — ActivePatients digest';
const DIGEST_VIEWER_EMAIL        = 'brayersandra@gmail.com';
const DIGEST_REBUILD_HANDLER     = 'rebuildActivePatientsDigest';

/* Canonical house set the digest is allowed to emit. */
const DIGEST_CANONICAL_HOUSES = { ramot: true, raanana: true, efroni: true, rehab: true };

/* Dashboard internal house id → canonical digest house id. pardes and sde are
 * intentionally ABSENT so they resolve to '' and are excluded from the feed. */
const DIGEST_INTERNAL_TO_CANONICAL = {
  asher:  'raanana',
  ramot:  'ramot',
  arfoni: 'efroni',
  rehab:  'rehab',
};

/* Hebrew display name (as it may appear in a `houseId`/`house` field) → internal
 * id. Mirrors HOUSES in public/app.js. Patients store the internal id directly,
 * but a name is accepted too so mixed/legacy rows still resolve. */
const DIGEST_HOUSE_NAME_TO_INTERNAL = {
  'קיסריה עפרוני': 'arfoni',
  'קיסריה ריהאב':  'rehab',
  'רעננה אשר':      'asher',
  'רעננה הפרדס':    'pardes',
  'רמות השבים':     'ramot',
  'שדה אליעזר':     'sde',
};

/* Status tokens that mean "in active treatment" (בטיפול פעיל / פעיל). Mirrors
 * the `active` entries in STATUS_ALIASES in public/app.js so a patient stored
 * under either the id or the Hebrew label is recognized. A resident counts as
 * active-treatment when their status is `active`; released residents (and the
 * trial/wait pre-active states) are not exported. */
const DIGEST_ACTIVE_STATUS_ALIASES = {
  'active': true,
  'פעיל':   true,
};

function digestStatusIsActive_(rawStatus) {
  if (rawStatus === undefined || rawStatus === null) return false;
  const s = String(rawStatus).trim();
  if (!s) return false;
  if (DIGEST_ACTIVE_STATUS_ALIASES[s]) return true;
  return DIGEST_ACTIVE_STATUS_ALIASES[s.toLowerCase()] === true;
}

/* Resolve a patient's stored house (internal id, Hebrew display name, or an
 * already-canonical id) to a canonical digest house id, or '' when the house is
 * outside the four exported houses. */
function canonicalDigestHouse_(rawHouse) {
  if (rawHouse === undefined || rawHouse === null) return '';
  const s = String(rawHouse).trim();
  if (!s) return '';
  if (DIGEST_CANONICAL_HOUSES[s]) return s;                 // already canonical
  if (DIGEST_INTERNAL_TO_CANONICAL[s]) return DIGEST_INTERNAL_TO_CANONICAL[s]; // internal id
  const internal = DIGEST_HOUSE_NAME_TO_INTERNAL[s];        // Hebrew display name
  if (internal) return DIGEST_INTERNAL_TO_CANONICAL[internal] || '';
  return '';                                                // pardes / sde / unknown → excluded
}

/* Deterministic stable id for an active patient. The Patients sheet has no
 * persisted id column (see PATIENT_COLUMNS), so we derive one from the fields
 * that identify a resident — canonical house, name, and entry date. The same
 * patient produces the same id on every rebuild, which is all a read-only feed
 * needs for a stable key. Prefixed so it is visibly a derived key, not a
 * Leads.id. */
function digestPatientKey_(canonHouse, name, patient) {
  const date = String(
    (patient && (patient.date !== undefined && patient.date !== null ? patient.date : '')) || ''
  ).trim();
  return 'ap:' + canonHouse + ':' + name + ':' + date;
}

/* PURE projection: active-treatment patients → digest rows. Each row is built
 * from exactly the four contract columns, so no financial field (pay, adv, …)
 * can leak. A patient is exported when their status is active (בטיפול פעיל /
 * פעיל) and their house maps to one of the four canonical houses. `nowIso` is
 * the rebuild timestamp stamped onto every row's updatedAt (passed in so the
 * function stays deterministic and testable). */
function buildActivePatientsRows_(patients, nowIso) {
  const out = [];
  if (!Array.isArray(patients)) return out;
  for (let i = 0; i < patients.length; i++) {
    const p = patients[i];
    if (!p) continue;
    if (!digestStatusIsActive_(p.status)) continue;
    const house = canonicalDigestHouse_(p.houseId);
    if (!house) continue; // outside the four canonical houses
    const name = String(p.name === undefined || p.name === null ? '' : p.name).trim();
    if (!name) continue;  // a digest row must name a patient
    out.push({
      house:       house,
      patientName: name,
      patientId:   digestPatientKey_(house, name, p),
      updatedAt:   nowIso,
    });
  }
  return out;
}

function getDigestSpreadsheetId_() {
  return PropertiesService.getScriptProperties().getProperty(DIGEST_SPREADSHEET_ID_PROP) || '';
}

/* Get (creating if absent) the ActivePatients tab in the digest spreadsheet,
 * with the frozen header row set to the column contract. */
function ensureDigestTab_(ss) {
  let sh = ss.getSheetByName(DIGEST_TAB);
  if (!sh) sh = ss.insertSheet(DIGEST_TAB);
  sh.getRange(1, 1, 1, DIGEST_COLUMNS.length).setValues([DIGEST_COLUMNS]);
  sh.setFrozenRows(1);
  return sh;
}

/* Whole-tab replace: clear the body and write the current row set. Locked so a
 * request-driven rebuild and the hourly trigger can't interleave writes. */
function writeDigestRows_(ssId, rows) {
  const lock = LockService.getScriptLock();
  lock.tryLock(10000);
  try {
    const ss = SpreadsheetApp.openById(ssId);
    const sh = ensureDigestTab_(ss);
    const lastRow = sh.getLastRow();
    if (lastRow > 1) {
      sh.getRange(2, 1, lastRow - 1, DIGEST_COLUMNS.length).clearContent();
    }
    if (rows.length > 0) {
      const values = rows.map(function (r) { return objectToRow_(r, DIGEST_COLUMNS); });
      sh.getRange(2, 1, values.length, DIGEST_COLUMNS.length).setValues(values);
    }
  } finally {
    try { lock.releaseLock(); } catch (_) { /* no-op */ }
  }
}

/* Rebuild the whole digest from the current Patients sheet (active residents).
 * Returns a small status object; no-ops with a clear error if setup hasn't run
 * yet. */
function rebuildActivePatientsDigest_() {
  const ssId = getDigestSpreadsheetId_();
  if (!ssId) return { ok: false, error: 'digest_not_configured' };
  const patientsSh = getOrCreateSheet_(PATIENTS_SHEET, PATIENT_COLUMNS);
  const patients   = readSheet_(patientsSh, PATIENT_COLUMNS);
  const nowIso     = new Date().toISOString();
  const rows       = buildActivePatientsRows_(patients, nowIso);
  writeDigestRows_(ssId, rows);
  return { ok: true, count: rows.length, updatedAt: nowIso };
}

/* DIAGNOSTIC — run manually from the editor (or read its return value) to see
 * exactly why the digest contains what it does. Reports, from the live Patients
 * sheet: the count of residents per status, and among active-treatment
 * residents the per-canonical-house kept count plus every dropped row with the
 * reason it was excluded (unknown/absent house, or a house outside the four
 * canonical ones). This is what makes the previously-silent exclusions visible.
 * Read-only: it never writes the digest. */
function diagnoseActivePatientsDigest() {
  const patientsSh = getOrCreateSheet_(PATIENTS_SHEET, PATIENT_COLUMNS);
  const patients   = readSheet_(patientsSh, PATIENT_COLUMNS);

  const byStatus = {};
  const keptByHouse = {};
  const dropped = [];
  let activeCount = 0;

  for (let i = 0; i < patients.length; i++) {
    const p = patients[i];
    if (!p) continue;
    const status = String(p.status === undefined || p.status === null ? '' : p.status).trim() || '(blank)';
    byStatus[status] = (byStatus[status] || 0) + 1;
    if (!digestStatusIsActive_(p.status)) continue;
    activeCount++;
    const name  = String(p.name === undefined || p.name === null ? '' : p.name).trim();
    const house = canonicalDigestHouse_(p.houseId);
    if (!house) {
      dropped.push({ name: name, houseId: p.houseId, reason: 'house_not_canonical_or_missing' });
      continue;
    }
    if (!name) {
      dropped.push({ name: name, houseId: p.houseId, reason: 'missing_name' });
      continue;
    }
    keptByHouse[house] = (keptByHouse[house] || 0) + 1;
  }

  const keptTotal = Object.keys(keptByHouse).reduce(function (s, k) { return s + keptByHouse[k]; }, 0);
  const report = {
    ok: true,
    source: PATIENTS_SHEET,
    totalPatients: patients.length,
    byStatus: byStatus,
    activeResidents: activeCount,
    keptByHouse: keptByHouse,
    keptTotal: keptTotal,
    droppedCount: dropped.length,
    dropped: dropped,
  };
  Logger.log('[digest] diagnostics: ' + JSON.stringify(report, null, 2));
  return report;
}

/* Public entry point for the time-based trigger (triggers call by name). */
function rebuildActivePatientsDigest() {
  return rebuildActivePatientsDigest_();
}

/* Best-effort rebuild invoked from the request path after a lead mutation. A
 * failure here (e.g. deployment not yet re-authorized for the wider scopes, or
 * setup not yet run) must NEVER surface to the caller or abort the write. */
function refreshDigestBestEffort_() {
  try {
    if (!getDigestSpreadsheetId_()) return; // setup hasn't run — nothing to update
    rebuildActivePatientsDigest_();
  } catch (err) {
    try { console.warn('[digest] rebuild skipped: ' + ((err && err.message) || err)); } catch (_) { /* no-op */ }
  }
}

/* Share the digest spreadsheet read-only with the coordinators reviewer. */
function shareDigestReadOnly_(ssId) {
  try {
    DriveApp.getFileById(ssId).addViewer(DIGEST_VIEWER_EMAIL);
  } catch (err) {
    try { console.warn('[digest] share failed: ' + ((err && err.message) || err)); } catch (_) { /* no-op */ }
  }
}

/* Install the hourly backstop trigger once (idempotent). */
function installDigestTrigger_() {
  const existing = ScriptApp.getProjectTriggers();
  for (let i = 0; i < existing.length; i++) {
    if (existing[i].getHandlerFunction() === DIGEST_REBUILD_HANDLER) return; // already installed
  }
  ScriptApp.newTrigger(DIGEST_REBUILD_HANDLER).timeBased().everyHours(1).create();
}

/**
 * ONE-TIME SETUP — run this manually from the Apps Script editor once.
 *
 * Creates the digest spreadsheet (or reuses the one already recorded in the
 * DIGEST_SPREADSHEET_ID script property), creates the ActivePatients tab with
 * the frozen column contract, shares it read-only with the coordinators
 * reviewer, installs the hourly backstop trigger, does an initial rebuild, and
 * prints the spreadsheet id + URL to the execution log.
 *
 * Idempotent: safe to run more than once. The printed id is the value to record
 * (it is also persisted in the script property, so the request path and trigger
 * find it automatically).
 */
function setupActivePatientsDigest() {
  const props = PropertiesService.getScriptProperties();
  let ssId = props.getProperty(DIGEST_SPREADSHEET_ID_PROP);
  let ss;

  if (ssId) {
    ss = SpreadsheetApp.openById(ssId); // reuse the app-owned spreadsheet
  } else {
    ss = SpreadsheetApp.create(DIGEST_SPREADSHEET_NAME);
    ssId = ss.getId();
    props.setProperty(DIGEST_SPREADSHEET_ID_PROP, ssId);
  }

  ensureDigestTab_(ss);

  // A freshly created spreadsheet ships with a default "Sheet1"; remove it so
  // the digest spreadsheet holds only the ActivePatients tab.
  const sheets = ss.getSheets();
  for (let i = 0; i < sheets.length; i++) {
    const name = sheets[i].getName();
    if (name !== DIGEST_TAB && sheets.length > 1) {
      try { ss.deleteSheet(sheets[i]); } catch (_) { /* keep going */ }
    }
  }

  shareDigestReadOnly_(ssId);
  installDigestTrigger_();
  const result = rebuildActivePatientsDigest_();

  Logger.log('ActivePatients digest spreadsheet id: ' + ssId);
  Logger.log('URL: ' + ss.getUrl());
  Logger.log('Tab: ' + DIGEST_TAB);
  Logger.log('Columns: ' + DIGEST_COLUMNS.join(', '));
  Logger.log('Initial rebuild: ' + JSON.stringify(result));

  return {
    ok: true,
    spreadsheetId: ssId,
    url: ss.getUrl(),
    tab: DIGEST_TAB,
    columns: DIGEST_COLUMNS,
    sharedWith: DIGEST_VIEWER_EMAIL,
    rebuild: result,
  };
}
