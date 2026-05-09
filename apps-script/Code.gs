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
