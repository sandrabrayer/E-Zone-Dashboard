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
  'stage', 'visitDate', 'visitTime', 'entryDate', 'advance', 'created'
];

/* Irrelevant-leads sheet mirrors LEAD_COLUMNS plus two metadata fields:
 *   originSheet — stable stage id the lead came from ('new'|'visit'|'paid'|'entry')
 *   movedAt     — ISO timestamp recorded when the lead was marked irrelevant
 * Storing the stage id (not the Hebrew label) keeps the restore lookup stable
 * across UI label renames. */
const IRRELEVANT_LEAD_COLUMNS = LEAD_COLUMNS.concat(['originSheet', 'movedAt']);

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
    if (action === 'saveAll') {
      const leads    = parseJsonParam_(params.leads);
      const patients = parseJsonParam_(params.patients);
      return jsonOut_(saveAll_(leads, patients));
    }
    if (action === 'getPayments') return jsonOut_(getPayments_());
    if (action === 'savePayment' || action === 'updatePayment') {
      const payment = parseJsonParam_(params.payment);
      return jsonOut_(upsertPayment_(payment));
    }
    if (action === 'moveLeadIrrelevant') {
      return jsonOut_(moveLeadIrrelevant_(parseJsonParam_(params.lead)));
    }
    if (action === 'restoreLead') {
      return jsonOut_(restoreLead_(parseJsonParam_(params.lead)));
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
  return sh;
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

/* ===== Read ===== */

function getData_() {
  const leadsSh      = getOrCreateSheet_(LEADS_SHEET, LEAD_COLUMNS);
  const patientsSh   = getOrCreateSheet_(PATIENTS_SHEET, PATIENT_COLUMNS);
  const irrelevantSh = getOrCreateSheet_(IRRELEVANT_LEADS_SHEET, IRRELEVANT_LEAD_COLUMNS);

  const leads           = readSheet_(leadsSh, LEAD_COLUMNS);
  const patientRows     = readSheet_(patientsSh, PATIENT_COLUMNS);
  const irrelevantLeads = readSheet_(irrelevantSh, IRRELEVANT_LEAD_COLUMNS);

  const patients = {};
  for (let i = 0; i < patientRows.length; i++) {
    const p = patientRows[i];
    const hid = p.houseId;
    if (!hid) continue;
    if (!patients[hid]) patients[hid] = [];
    patients[hid].push(p);
  }

  return { ok: true, leads: leads, patients: patients, irrelevantLeads: irrelevantLeads };
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

  const finalRows = kept.concat(newRows);

  clearBody_(sh, LEAD_COLUMNS.length);
  if (finalRows.length > 0) {
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

  const finalRows = kept.concat(newRows);

  clearBody_(sh, PATIENT_COLUMNS.length);
  if (finalRows.length > 0) {
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
  const row = objectToRow_(obj, columns);
  const lastRow = sh.getLastRow();
  if (lastRow > 1) {
    const existingIds = sh.getRange(2, idIdx + 1, lastRow - 1, 1).getValues();
    for (let i = 0; i < existingIds.length; i++) {
      if (String(existingIds[i][0]) === String(obj.id)) {
        sh.getRange(i + 2, 1, 1, columns.length).setValues([row]);
        return;
      }
    }
  }
  sh.appendRow(row);
}

function moveLeadIrrelevant_(lead) {
  if (!lead || !lead.id) return { ok: false, error: 'missing_lead' };
  const lock = LockService.getScriptLock();
  lock.tryLock(10000);
  try {
    const leadsSh = getOrCreateSheet_(LEADS_SHEET, LEAD_COLUMNS);
    const irrSh   = getOrCreateSheet_(IRRELEVANT_LEADS_SHEET, IRRELEVANT_LEAD_COLUMNS);

    const record = Object.assign({}, lead, {
      stage:       'irrelevant',
      originSheet: lead.originSheet || '',
      movedAt:     lead.movedAt     || new Date().toISOString(),
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

/* ----- Outpatient-continuation bonus: pull from OUTPATIENTS app -----
 *
 * Policy (2026-05): the outpatient-continuation bonus is 5% of each
 * continuing patient's upfront monthly package, computed at source in the
 * OUTPATIENTS app (ezone-outpatient) and exposed by its read-only
 * `getContinuationBonus` endpoint. This REPLACES the old local flat-rate
 * model (CONTINUITY_RATES + the hand-maintained Outpatients tab), which is
 * now unused for bonus money.
 *
 * Config via Script Properties (Project Settings → Script Properties):
 *   OUTPATIENT_BONUS_URL    — the OUTPATIENTS Apps Script /exec URL
 *   OUTPATIENT_BONUS_SECRET — the shared secret (matches BONUS_SECRET there)
 *
 * Fail-safe: if the property is missing, the fetch fails, the response is
 * not ok, or the month does not match the requested month, this returns
 * the zeroed shape AND an `error` string. It never throws (the managers
 * dashboard must keep rendering) and never silently falls back to the old
 * flat-rate numbers (that would be wrong money).
 *
 * Returns the SAME shape computeContinuityByHouse_ returned, so the
 * downstream calculator (calcHouseBonus_) is unchanged:
 *   { <house>: { maintenance, day_2x, day_daily, total }, _meta: {...} }
 * The per-therapy counts are 0 (the source no longer works in therapy
 * buckets); only `total` carries the 5% figure, which is all
 * calcHouseBonus_ consumes.
 */
function fetchOutpatientContinuity_(ym) {
  const zero = {};
  MANAGER_HOUSES.forEach(function (h) {
    zero[h] = { maintenance: 0, day_2x: 0, day_daily: 0, total: 0 };
  });

  const props = PropertiesService.getScriptProperties();
  const url    = props.getProperty('OUTPATIENT_BONUS_URL');
  const secret = props.getProperty('OUTPATIENT_BONUS_SECRET');

  if (!url || !secret) {
    zero._meta = { ok: false, error: 'outpatient_bonus_not_configured' };
    return zero;
  }

  let payload;
  try {
    const sep = url.indexOf('?') === -1 ? '?' : '&';
    const full = url + sep + 'action=getContinuationBonus&secret=' +
                 encodeURIComponent(secret);
    const resp = UrlFetchApp.fetch(full, {
      method: 'get',
      muteHttpExceptions: true,
      followRedirects: true,
    });
    if (resp.getResponseCode() !== 200) {
      zero._meta = { ok: false, error: 'outpatient_http_' + resp.getResponseCode() };
      return zero;
    }
    payload = JSON.parse(resp.getContentText());
  } catch (err) {
    zero._meta = { ok: false, error: 'outpatient_fetch_failed',
                   message: String((err && err.message) || err) };
    return zero;
  }

  if (!payload || payload.ok !== true || !payload.byHouse) {
    zero._meta = { ok: false,
                   error: (payload && payload.error) || 'outpatient_bad_payload' };
    return zero;
  }

  // The source returns the CURRENT month only. If the managers dashboard
  // is being viewed for a different month, we must NOT attribute the
  // current-month figure to a historical/future month — that would be
  // wrong money. Surface a clear, non-fatal mismatch instead.
  if (payload.month && String(payload.month) !== String(ym)) {
    zero._meta = { ok: false, error: 'outpatient_month_mismatch',
                   sourceMonth: payload.month, requestedMonth: ym };
    return zero;
  }

  const out = {};
  MANAGER_HOUSES.forEach(function (h) {
    const v = Number(payload.byHouse[h]) || 0;
    out[h] = { maintenance: 0, day_2x: 0, day_daily: 0, total: v };
  });
  out._meta = {
    ok: true,
    source: 'ezone-outpatient',
    month: payload.month || ym,
    ratePct: payload.ratePct,
    total: Number(payload.total) || 0,
  };
  return out;
}

/* ----- Continuity bonus (Outpatients) — LEGACY local flat-rate model -----
 *
 * SUPERSEDED (2026-05) by fetchOutpatientContinuity_, which pulls the 5%
 * figure from the OUTPATIENTS app. Kept for reference / rollback only; it
 * is no longer called from the managers endpoints. Do NOT re-wire this
 * without a money-policy decision — using both is a double-pay bug.
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

  // Outpatient-continuation bonus is paid REGARDLESS of occupancy.
  // Policy decision (2026-05): the outpatient bonus rewards former
  // residents who continue treatment after discharge; it is independent
  // of whether the house is currently at/above BEP. The stability
  // bonuses (base / daily / quarterly) KEEP their `qualifies` gate above
  // and are intentionally NOT changed here. Only this line was un-gated.
  const continuityBonus = continuity.total;

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
  const continuityByHouse = fetchOutpatientContinuity_(ym);

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
    outpatientFeed: (continuityByHouse && continuityByHouse._meta) || null,
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
  const continuityByHouse = fetchOutpatientContinuity_(ym);

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
    outpatientFeed: (continuityByHouse && continuityByHouse._meta) || null,
  };
}
