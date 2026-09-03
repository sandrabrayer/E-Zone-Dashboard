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
 *   POST action=deletePatientRow&patient=...     → {ok, deleted, key}
 *                                                 (permanent patient-row delete by identity
 *                                                  key; tombstones BEFORE deleting)
 *
 * Merge semantics (important for the split-save path in server.js):
 *   - leads present and non-empty → upsert each lead by id; leads whose id is
 *     not in the payload are left untouched. This mirrors the patients
 *     per-houseId behavior and lets the server chunk leads into batches.
 *   - leads missing, empty string, null, or empty array → leave Leads untouched
 *   - patients: for every houseId key present in the payload, that house's
 *     rows are MERGED by the identity triple houseId::name::entryDate
 *     (patientKey_): matched rows are replaced, new rows appended, and sheet
 *     rows ABSENT from the payload are KEPT — never dropped by omission, so a
 *     stale tab can no longer clobber rows it never loaded. Every kept-but-
 *     omitted row is echoed per house in the response's `preserved` map and
 *     audited to the PatientsTombstones sheet. Houses NOT present in the
 *     payload are untouched.
 *   - patients missing / empty object → leave the Patients sheet untouched
 *
 * Note: leads cannot be deleted through saveAll (only marked irrelevant via
 * the app). A dedicated delete action can be added if that becomes needed.
 */

const LEADS_SHEET    = 'Leads';
const PATIENTS_SHEET = 'Patients';
const PAYMENTS_SHEET = 'Payments';
/* Internal sheet — per-patient, per-month override of the monthly billing
 * amount (סכום חודשי). Not surfaced in the Hebrew UI as its own tab; it backs
 * the inline per-month amount edit in the גבייה tab. */
const BILLING_OVERRIDES_SHEET = 'BillingOverrides';
const IRRELEVANT_LEADS_SHEET = 'לידים לא רלוונטיים';
const REMOVED_LEADS_SHEET    = 'לידים שהוסרו';
const DISCHARGED_PATIENTS_SHEET = 'מטופלים משוחררים';
/* Append-only audit of Patients rows that a saveAll payload OMITTED while
 * writing their house (merge-don't-drop). The rows are KEPT on the Patients
 * sheet by replaceHousePatients_'s merge; each is also copied here so a stale
 * save leaves a durable, queryable trace independent of Sheets version
 * history. Never read by the app; recovery/inspection is manual. */
const PATIENTS_TOMBSTONES_SHEET = 'PatientsTombstones';

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
 * The bonus dashboard uses the keys raanana / ramot / efroni / rehab /
 * pardes, but the existing Patients sheet was set up with different
 * houseIds (asher / ramot / arfoni / rehab; pardes, added 2026-08, uses
 * the same id on both sides). MANAGER_HOUSE_TO_PATIENTS_HOUSE_ID lets us
 * read residence data from the Patients sheet without forcing a
 * historical rename.
 */
const MANAGERS_SHEET     = 'Managers';
const BONUS_CONFIG_SHEET = 'BonusConfig';
const OUTPATIENTS_SHEET  = 'Outpatients';

const MANAGER_COLUMNS       = ['house', 'manager_name', 'start_date', 'end_date'];
const BONUS_CONFIG_COLUMNS  = ['house', 'bep_patients', 'capacity_patients', 'bonus_base', 'bonus_per_day', 'type'];
const OUTPATIENT_COLUMNS    = ['patient_name', 'house_of_origin', 'therapy_type', 'start_date', 'end_date', 'notes'];

const MANAGER_HOUSES = ['raanana', 'ramot', 'efroni', 'rehab', 'pardes'];
const MANAGER_HOUSE_NAMES = {
  raanana: 'רעננה אשר',
  ramot:   'רמות השבים',
  efroni:  'קיסריה עפרוני',
  rehab:   'קיסריה ריהאב',
  pardes:  'רעננה הפרדס',
};
const MANAGER_HOUSE_TO_PATIENTS_HOUSE_ID = {
  raanana: 'asher',
  ramot:   'ramot',
  efroni:  'arfoni',
  rehab:   'rehab',
  pardes:  'pardes',
};

/* House managers keyed by patients-sheet house id. Names only — no phone
 * numbers. Exported by getData_ so the frontend can look up who runs each
 * house without a second round-trip. pardes is intentionally absent until a
 * manager is named for it — every consumer renders a blank manager for a
 * missing key. Keep in sync with the patients-house ids above if the roster
 * changes. */
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
  'meetingWith',
  /* meetingOutcome — the outcome of the lead's meeting (stable key, e.g.
   * 'entered'|'thinking'|'postponed'|'cancelled'|'not_relevant'). APPEND ONLY:
   * readSheet_ maps cells to keys by POSITION, so this must stay last and
   * nothing above it may be reordered or inserted mid-array. Pre-existing rows
   * have no such column and stay blank (getOrCreateSheet_ appends the missing
   * header non-destructively, objectToRow_ defaults missing keys to '', and
   * normalizeLead reads it via pickField defaulting to ''). Foundation only —
   * no UI yet; the field flows through save/load untouched. Mirrors the
   * meetingWith append. */
  'meetingOutcome',
  /* Lead contact fields (foundation). The lead's name/phone now semantically
   * mean the PATIENT (פרטי המטופל); these carry the REFERRER's contact details
   * (פרטי הפונה) plus a dedicated billing/updates phone (טלפון לגבייה ועדכונים)
   * the user sets per lead:
   *   contactName     — referrer's name
   *   contactPhone    — referrer's phone
   *   contactRelation — referrer's relation to the patient
   *   billingPhone    — phone for billing + updates
   * APPEND ONLY, in this exact order: readSheet_ maps cells to keys by POSITION,
   * so these must stay last and nothing above them may be reordered or inserted
   * mid-array. Pre-existing rows have no such columns and stay blank
   * (getOrCreateSheet_ appends the missing headers non-destructively,
   * objectToRow_ defaults missing keys to '', and normalizeLead reads each via
   * pickField defaulting to ''). Foundation only — no UI yet; the fields flow
   * through save/load untouched. Mirrors the meetingOutcome append. They flow
   * automatically into IRRELEVANT_LEAD_COLUMNS / REMOVED_LEAD_COLUMNS below,
   * which derive from LEAD_COLUMNS via .concat(). */
  'contactName',
  'contactPhone',
  'contactRelation',
  'billingPhone',
  /* waitlistedAt — ISO timestamp string recorded when a lead enters the
   * רשימת המתנה (waitlist) stage; the lead's existing `house` field is the
   * house it is waiting for. APPEND ONLY: readSheet_ maps cells to keys by
   * POSITION, so this must stay last and nothing above it may be reordered or
   * inserted mid-array. Pre-existing rows have no such column and stay blank
   * (getOrCreateSheet_ appends the missing header non-destructively,
   * objectToRow_ defaults missing keys to '', and normalizeLead reads it via
   * pickField defaulting to ''). The column is forced to plain text ('@') at
   * sheet-ensure time so Sheets never coerces the ISO string into a Date cell
   * (the same coercion that corrupted visitDate/visitTime). Foundation only —
   * no UI yet; the field flows through save/load untouched. Mirrors the
   * meetingOutcome append. Flows automatically into IRRELEVANT_LEAD_COLUMNS /
   * REMOVED_LEAD_COLUMNS below, which derive from LEAD_COLUMNS via .concat(). */
  'waitlistedAt',
  /* Meeting-report fields (foundation) — house managers report what happened
   * in a lead meeting (today reported only in a WhatsApp group). Distinct from
   * the meetings-board `meetingOutcome` above, which is a separate live feature
   * with its own key set; hence the distinct meetingReportOutcome name.
   *   meetingReportOutcome — stable key: 'advancing' | 'undecided' | 'not_fit'
   *                          | 'no_show' ('' = no report yet)
   *   meetingCompanion     — stable key: 'mother' | 'father' | 'parents' |
   *                          'partner' | 'sibling' | 'friend' | 'alone' |
   *                          'other'; when the companion doesn't match a preset
   *                          key the RAW free text is stored here as-is (no
   *                          'other:' prefix) and rendered verbatim
   *   meetingNote          — free text (what was discussed)
   *   meetingReporter      — house manager name (from dropdown)
   *   meetingReportedAt    — ISO timestamp string; plain text, NOT a Sheets
   *                          date — the column is forced to '@' at sheet-ensure
   *                          time (same guard as waitlistedAt) so Sheets never
   *                          coerces it into a Date cell
   *   meetingSeen          — '' or '1' (Vered's mark-seen flag; used in PR 3);
   *                          also text-forced so '1' never coerces to number 1
   * APPEND ONLY, in this exact order: readSheet_ maps cells to keys by
   * POSITION, so these must stay last and nothing above them may be reordered
   * or inserted mid-array. Pre-existing rows have no such columns and stay
   * blank (getOrCreateSheet_ appends the missing headers non-destructively,
   * objectToRow_ defaults missing keys to '', and normalizeLead reads each via
   * pickField defaulting to ''). Foundation only — no UI yet; the fields flow
   * through save/load untouched. UI ships in PR 2 (manager form) and PR 3
   * (Vered's view). Flow automatically into IRRELEVANT_LEAD_COLUMNS /
   * REMOVED_LEAD_COLUMNS below, which derive from LEAD_COLUMNS via .concat(). */
  'meetingReportOutcome',
  'meetingCompanion',
  'meetingNote',
  'meetingReporter',
  'meetingReportedAt',
  'meetingSeen'
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

/* PatientsTombstones columns: a full patient row snapshot + audit metadata.
 * OWN literal list, deliberately NOT derived from PATIENT_COLUMNS via concat —
 * a future PATIENT_COLUMNS append must not silently shift these audit columns;
 * the write maps values by name through objectToRow_, so the two lists may
 * even diverge safely. Metadata:
 *   droppedAt     — ISO timestamp of the save whose payload omitted the row
 *                   (text-forced at sheet-ensure time, same guard as
 *                   waitlistedAt, so Sheets never coerces it to a Date cell)
 *   reason        — why the row was recorded:
 *                   'saveAll-omitted-preserved' — the merge KEPT the row on
 *                   the Patients sheet; this entry is the audit trace of the
 *                   stale save that omitted it;
 *                   'user-delete' — the row was PERMANENTLY deleted via the
 *                   dedicated deletePatientRow action; this entry is the
 *                   recovery copy (written before the delete, fail-hard)
 *   savedByAction — the endpoint that produced the entry ('saveAll' /
 *                   'deletePatientRow') */
const PATIENT_TOMBSTONE_COLUMNS = [
  'houseId', 'name', 'date', 'pay', 'adv',
  'status', 'fromLead', 'exitDate', 'source', 'notes',
  'droppedAt', 'reason', 'savedByAction'
];

/* How long a 'user-delete' tombstone SUPPRESSES the deleted identity key in
 * the saveAll merge (see recentUserDeleteKeys_): a stale tab still carrying
 * the deleted patient would otherwise re-APPEND it on its next save. The
 * Patients sheet has no per-row edit timestamp to compare against, so the
 * suppression is time-bounded instead: within this window a payload row whose
 * key matches the tombstone (and is no longer on the sheet) is dropped; after
 * it, a deliberate re-add of the identical houseId+name+entryDate works
 * again. 24h is generous — the visibilitychange reload (app.js) refreshes any
 * refocused tab, so a tab can hardly stay stale for a day AND save. */
const USER_DELETE_SUPPRESS_MS = 24 * 60 * 60 * 1000;

/* Phase 2e-1 — discharged-patients audit sheet. Mirrors IRRELEVANT_LEAD_COLUMNS
 * shape: base columns + discharge-time metadata. `id` is prepended so
 * upsertRowById_ has a key to dedupe by (Patients sheet has no id column;
 * the client-side patient id is session-local but unique-at-write-time, which
 * is all the audit sheet needs). */
/* `prior_status` (append-only, added with the restore-choice modal): the
 * patient's status at the MOMENT of discharge (active/trial/wait), captured by
 * the client's dischargeAuditRow before the released flip. Restore-to-previous-
 * status reads it; legacy rows have it blank and fall back to 'active'. */
const DISCHARGED_PATIENT_COLUMNS =
  ['id'].concat(PATIENT_COLUMNS).concat(['dischargedAt', 'disposition', 'discharge_note', 'restored', 'prior_status']);

/* Payments sheet columns. `id` is a deterministic per-patient-per-due-date
 * string built by the client (see paymentId() in app.js) so the same monthly
 * payment always upserts into the same row instead of creating duplicates. */
const PAYMENT_COLUMNS = [
  'id', 'patientId', 'patientName', 'houseId', 'dueDate',
  'amount', 'status', 'amountPaid', 'balance', 'timestamp'
];

/* BillingOverrides sheet columns. One row per (patientId, month); `id` is a
 * deterministic `ovr::<patientId>::<month>` string built by the client (see
 * billingOverrideId() in app.js) so re-writing the same pair REPLACES the
 * amount instead of appending a duplicate. `month` is 'YYYY-MM' and `amount`
 * a number, but BOTH are persisted in plain-text ('@') cells — getOrCreateSheet_
 * force-texts these two columns at ensure time. Sheets would otherwise coerce
 * "2026-08" into a date and drift the number's format, the same corruption class
 * the Leads visitDate/visitTime text-column fix guards against. */
const BILLING_OVERRIDE_COLUMNS = ['id', 'patientId', 'month', 'amount', 'created'];

/* AuditLog sheet — append-only, hidden. One row per Patients-sheet write event
 * (promotion created/skipped, direct add, edit, discharge, delete, restore),
 * written by logAudit_ ONLY. APPEND-ONLY contract, same rule as LEAD_COLUMNS:
 * never insert/delete/reorder — new columns go at the END. Guard-tested.
 *   timestamp — ISO string (text-forced at ensure time, same coercion guard as
 *               the tombstones' droppedAt)
 *   action    — event name, e.g. 'promote_created', 'promote_skipped_duplicate'
 *   fn        — the backend function that wrote the event
 *   patientId — the row's fromLead lead-id when it has one, else the discharge
 *               audit id, else '' (the Patients sheet itself has no id column)
 *   name      — patient name
 *   details   — compact JSON string (houseId, identity key, skip reason, …) */
const AUDIT_LOG_SHEET = 'AuditLog';
const AUDIT_LOG_COLUMNS = ['timestamp', 'action', 'fn', 'patientId', 'name', 'details'];

/* RepairPlan sheet — the human-approval gate for the corrupted-rows cleanup
 * (U+FFFD Hebrew-name corruption, see CHANGELOG-corrupted-rows-cleanup.md).
 * writeRepairPlanNow fills it from the dry-run scan with approved=FALSE;
 * Sandra reviews and flips approved to TRUE per row; only then does
 * applyCorruptedRowRepairsNow touch data. Hidden sheet, never read by any
 * HTTP endpoint. APPEND-ONLY contract, same rule as LEAD_COLUMNS — never
 * insert/delete/reorder; new columns go at the END. Guard-tested.
 *   sheet    — target sheet name
 *   row      — 1-based sheet row number at scan time (drift-checked at apply)
 *   column   — target column name (per that sheet's schema)
 *   newValue — proposed replacement ('' when no source was found — Sandra
 *              fills it in by hand before approving)
 *   action   — 'repair' (single-cell write) | 'delete' (tombstone-then-delete
 *              of a corrupted exact-duplicate Patients twin)
 *   approved — 'FALSE' as written by the scan; Sandra flips to TRUE
 *   oldValue — the corrupted value the scan saw; apply re-verifies the cell
 *              still holds EXACTLY this before writing (row-drift guard)
 *   source   — which repair tier produced newValue ('repair from snapshot',
 *              'repair from enum', 'repair from roster', 'repair from
 *              twin-merge', the #105 tiers, or a '… — manual' classification
 *              when the scan found nothing). APPENDED at the END per the
 *              append-only rule; apply ignores it — review context only. */
const REPAIR_PLAN_SHEET = 'RepairPlan';
const REPAIR_PLAN_COLUMNS = ['sheet', 'row', 'column', 'newValue', 'action', 'approved', 'oldValue', 'source'];

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
    if (action === 'upsertBillingOverride') {
      return jsonOut_(upsertBillingOverride_(parseJsonParam_(params.override)));
    }
    if (action === 'deleteBillingOverride') {
      return jsonOut_(deleteBillingOverride_(parseJsonParam_(params.override)));
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
    if (action === 'deletePatientRow') {
      const res = deletePatientRow_(parseJsonParam_(params.patient));
      // A permanent delete drops a resident out of the active population.
      // Fail-soft, mirroring dischargePatient.
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
    if (action === 'deleteMeetingReport') {
      // Dashboard-side (Vered) action, same trust model as saveAll/removeLead:
      // reached only through the session-authed /api/sheets proxy.
      return jsonOut_(deleteMeetingReport_(params.leadId));
    }
    if (action === 'meetingReportLeads') {
      if (!meetingReportAuthOk_(params)) {
        return jsonOut_({ ok: false, error: 'unauthorized' });
      }
      return jsonOut_(meetingReportLeads_());
    }
    if (action === 'submitMeetingReport') {
      if (!meetingReportAuthOk_(params)) {
        return jsonOut_({ ok: false, error: 'unauthorized' });
      }
      return jsonOut_(submitMeetingReport_(parseJsonParam_(params.report)));
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
  // Leads sheet: force the WHOLE visitDate + visitTime + waitlistedAt columns to
  // plain text so any write — present or future, via any path (mergeLeads_,
  // upsertRowById_, manual edit) — lands in a text cell and Sheets can never
  // coerce "08:18", "2026-06-11" or an ISO timestamp into a Date/time-typed cell
  // (the coercion that drifted values through the getValues→UTC round-trip).
  // Done once at sheet-ensure time rather than per-write. Idempotent.
  if (name === LEADS_SHEET) {
    // meetingReportedAt: ISO timestamp that must survive as a string (same
    // guard as waitlistedAt). meetingSeen: '' | '1' flag — text-forced so
    // Sheets never coerces '1' into the number 1.
    forceColumnsText_(sh, LEAD_COLUMNS,
      ['visitDate', 'visitTime', 'waitlistedAt', 'meetingReportedAt', 'meetingSeen']);
  }
  // BillingOverrides: force month + amount to plain text for the same reason —
  // "2026-08" must not coerce into a date and the amount must not pick up a
  // locale number format that a later read could reinterpret. Whole-column,
  // idempotent, so rows appended later inherit it.
  if (name === BILLING_OVERRIDES_SHEET) {
    forceColumnsText_(sh, BILLING_OVERRIDE_COLUMNS, ['month', 'amount']);
  }
  // PatientsTombstones: entry date and droppedAt must survive as plain strings
  // (same coercion class as the Leads visitDate/waitlistedAt guards).
  if (name === PATIENTS_TOMBSTONES_SHEET) {
    forceColumnsText_(sh, PATIENT_TOMBSTONE_COLUMNS, ['date', 'droppedAt']);
  }
  // AuditLog: the ISO timestamp must survive as a plain string (same guard as
  // droppedAt); details is JSON text that must never be reinterpreted.
  if (name === AUDIT_LOG_SHEET) {
    forceColumnsText_(sh, AUDIT_LOG_COLUMNS, ['timestamp', 'details']);
  }
  // RepairPlan: old/new values must survive byte-for-byte as plain text — the
  // apply step compares oldValue against the live cell EXACTLY, so Sheets must
  // never coerce either (a value like "050..." would lose its leading zero).
  if (name === REPAIR_PLAN_SHEET) {
    forceColumnsText_(sh, REPAIR_PLAN_COLUMNS, ['newValue', 'oldValue', 'approved']);
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
  const overridesSh  = getOrCreateSheet_(BILLING_OVERRIDES_SHEET, BILLING_OVERRIDE_COLUMNS);

  // Heal blank id cells BEFORE reading, so the ids returned to the client are
  // the same ones now stored on the sheet — client and sheet agree on the
  // delete/update key. Only the two sheets that are targets of delete-by-id are
  // healed: Leads (removeLead_ / moveLeadIrrelevant_) and the irrelevant-leads
  // sheet (restoreLead_). The Patients sheet has no id column; the removed and
  // discharged sheets are written with client-stamped ids and are not
  // delete-by-id targets, so they need no backfill (see CHANGELOG for the audit).
  backfillMissingIds_(leadsSh, LEAD_COLUMNS);
  backfillMissingIds_(irrelevantSh, IRRELEVANT_LEAD_COLUMNS);

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
  const billingOverrides    = readSheet_(overridesSh, BILLING_OVERRIDE_COLUMNS);

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
    billingOverrides: billingOverrides,
    houseManagers: HOUSE_MANAGERS,
    managerPhones: managerPhones_(),
  };
}

/* ===== Write (merge semantics) ===== */

function saveAll_(leads, patients) {
  const lock = LockService.getScriptLock();
  lock.tryLock(10000);
  try {
    // Leads — upsert by id; leads not in the payload are preserved.
    // `reportConflicts` lists the leadIds whose meetingReport* fields the
    // merge guard kept from the SHEET instead of the payload (the client's
    // copy carried a different report timestamp — stale echo, or an edit that
    // raced a manager resubmission/deletion). The dashboard's edit flow
    // checks its own leadId here to surface the conflict instead of
    // pretending the edit saved.
    let reportConflicts = [];
    if (Array.isArray(leads) && leads.length > 0) {
      reportConflicts = mergeLeads_(leads);
    }

    // Patients — only touch houseIds that are present in the payload.
    // `written` echoes, per house, how many patient rows were actually written
    // — backend truth the server-side diagnostics compare against the counts
    // the client SENT, to catch a silent serialize/houseId drop.
    // `preserved` lists, per house, the identity keys of sheet rows the
    // payload OMITTED but the merge KEPT (merge-don't-drop): non-empty means
    // the saving client's in-memory state is stale and it should reload
    // instead of trusting its copy. Houses with nothing preserved are absent.
    // `deletedSuppressed` lists, per house, payload rows the merge DROPPED
    // because their identity key carries a fresh 'user-delete' tombstone — a
    // stale tab trying to resurrect a permanently deleted patient. Note these
    // rows are excluded from `written`, so the server diagnostics'
    // sent-vs-written comparison flags such a save; deletedSuppressed in the
    // recorded response preview is the explanation.
    // `promoteSkipped` lists, per house, payload rows the promotion dedupe
    // guard REFUSED to append: their fromLead already has a Patients row in
    // ANOTHER house (or earlier in this same save), or a non-restored
    // discharged-audit row — the true duplicate-promotion signatures. (A
    // SAME-house fromLead match is a rename/entry-date edit and is updated
    // in place instead — see replaceHousePatients_.) Skipped rows are
    // excluded from `written`, audit-logged (promote_skipped_duplicate), and
    // surfaced by the client as an error toast so no refusal is silent.
    const written = {};
    const preserved = {};
    const deletedSuppressed = {};
    const promoteSkipped = {};
    if (patients && typeof patients === 'object' && !Array.isArray(patients)) {
      const houseIds = Object.keys(patients);
      const userDeleteKeys = houseIds.length > 0 ? recentUserDeleteKeys_() : {};
      const dischargedIds = houseIds.length > 0 ? dischargedFromLeadIds_() : {};
      for (let i = 0; i < houseIds.length; i++) {
        const hid = houseIds[i];
        const arr = patients[hid];
        const res = replaceHousePatients_(hid, Array.isArray(arr) ? arr : [], userDeleteKeys, dischargedIds);
        written[hid] = res.written;
        if (res.preservedKeys.length > 0) preserved[hid] = res.preservedKeys;
        if (res.suppressedKeys.length > 0) deletedSuppressed[hid] = res.suppressedKeys;
        if (res.skippedPromotes.length > 0) promoteSkipped[hid] = res.skippedPromotes;
      }
    }

    return {
      ok: true,
      written: written,
      preserved: preserved,
      deletedSuppressed: deletedSuppressed,
      promoteSkipped: promoteSkipped,
      reportConflicts: reportConflicts,
    };
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

  // leadIds whose meetingReport* fields the guard kept from the sheet instead
  // of the payload (detected as: the guard changed the row's reportedAt away
  // from what the client sent). Returned to saveAll_ → the save response, so
  // the dashboard's edit flow can detect a raced manager resubmit/delete.
  const reportConflicts = [];

  const newRows = leads.map(function (l) {
    const merged = {};
    for (let k in l) merged[k] = l[k];
    const existing = existingById[String(merged.id || '')];

    const incomingCreated = merged.created;
    const isMissing = (incomingCreated === undefined ||
                      incomingCreated === null ||
                      incomingCreated === '');

    if (isMissing) {
      merged.created = existing
        ? asISODate_(existing[createdColIdx])  // update path → preserve
        : today;                               // insert path → stamp today
    } else {
      // Round-trip whatever the client sent through asISODate_ so a Date
      // object (some integrations) becomes the same plain YYYY-MM-DD that
      // the dashboard writes.
      merged.created = asISODate_(incomingCreated);
    }

    const sentAt = asTimestampText_(merged.meetingReportedAt);
    preserveNewerMeetingReport_(merged, existing);
    if (asTimestampText_(merged.meetingReportedAt) !== sentAt) {
      reportConflicts.push(String(merged.id == null ? '' : merged.id));
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

  // WRITE-THEN-TRIM (not clear-then-write): write the final row set first,
  // then clear only the surplus tail rows. A crash between the two steps can
  // leave duplicate tail rows (visible, fixable) but can no longer leave the
  // Leads sheet empty the way an exception between a body-clear and the
  // rewrite could.
  if (finalRows.length > 0) {
    const textColIdxs = dateColIdxs.concat(vTimeIdx >= 0 ? [vTimeIdx] : []);
    textColIdxs.forEach(function (i) {
      sh.getRange(2, i + 1, finalRows.length, 1).setNumberFormat('@');
    });
    sh.getRange(2, 1, finalRows.length, LEAD_COLUMNS.length).setValues(finalRows);
  }
  if (lastRow > finalRows.length + 1) {
    sh.getRange(finalRows.length + 2, 1, lastRow - finalRows.length - 1, LEAD_COLUMNS.length).clearContent();
  }

  return reportConflicts;
}

/* The six lead columns owned by the manager reporting form (submitMeetingReport_
 * writes five of them + resets meetingSeen). mergeLeads_ must never let a
 * dashboard payload regress them — see preserveNewerMeetingReport_. */
const MEETING_REPORT_LEAD_FIELDS = [
  'meetingReportOutcome',
  'meetingCompanion',
  'meetingNote',
  'meetingReporter',
  'meetingReportedAt',
  'meetingSeen',
];

/* A timestamp cell as a comparable string: '' when empty, ISO for a Date cell
 * (legacy coercion), the raw string otherwise. ISO strings from
 * new Date().toISOString() compare correctly as plain strings. */
function asTimestampText_(v) {
  if (v === undefined || v === null || v === '') return '';
  if (Object.prototype.toString.call(v) === '[object Date]') return v.toISOString();
  return String(v);
}

/* Guard against the meeting-report lost-update clobber: the manager form writes
 * the meetingReport* fields OUT-OF-BAND (submitMeetingReport_ → upsertRowById_),
 * while every dashboard save (saveAll → mergeLeads_) rewrites each lead row
 * wholesale from the CLIENT's in-memory copy — which is frozen at page-load
 * time. A tab loaded before a manager reported therefore carried '' in all six
 * fields and erased the report on its next save (any inline edit, the
 * meetingWith autosave, auto-promote). The rule, keyed on meetingReportedAt
 * (only the backend ever stamps it — submitMeetingReport_ / deleteMeetingReport_
 * bypass this merge entirely):
 *   - the incoming lead's reportedAt DIFFERS from the sheet's (older, newer,
 *     or the sheet has no report at all) → the sheet's six fields win, the
 *     client's copy wins everywhere else. No legitimate saveAll can carry a
 *     report state the sheet doesn't already hold: reports are created only
 *     by submitMeetingReport_ and removed only by deleteMeetingReport_, so a
 *     differing timestamp always means a stale echo — including a stale tab
 *     trying to resurrect a report onto a row deleteMeetingReport_ already
 *     cleared (sheetAt '' beats a non-empty clientAt);
 *   - same reportedAt → same report: the client's copy stands (this is how
 *     Vered's content edit and mark-seen persist), except meetingSeen is
 *     sticky — once the sheet says '1' for THIS report, a peer tab that
 *     hasn't seen the click can't flip it back to unseen. Only a manager
 *     resubmission (a NEWER reportedAt via submitMeetingReport_) resets it.
 * Mutates and returns `merged`. No-op for new leads (no existing row). */
function preserveNewerMeetingReport_(merged, existingRow) {
  if (!existingRow) return merged;
  const atIdx = LEAD_COLUMNS.indexOf('meetingReportedAt');
  if (atIdx < 0) return merged;
  const sheetAt = asTimestampText_(existingRow[atIdx]);
  const clientAt = asTimestampText_(merged.meetingReportedAt);
  if (clientAt !== sheetAt) {
    MEETING_REPORT_LEAD_FIELDS.forEach(function (f) {
      merged[f] = existingRow[LEAD_COLUMNS.indexOf(f)];
    });
  } else if (sheetAt) {
    const seenIdx = LEAD_COLUMNS.indexOf('meetingSeen');
    if (String(existingRow[seenIdx] == null ? '' : existingRow[seenIdx]) === '1') {
      merged.meetingSeen = '1';
    }
  }
  return merged;
}

/* Identity key for a Patients row. The sheet has no id column, so this triple
 * IS row identity — the same key the client's matchActivePatientIndex, the
 * discharge heal, and digestPatientKey_ already rely on. `date` goes through
 * asISODate_ so a legacy Date-typed cell and the client's 'YYYY-MM-DD' string
 * compare equal. */
function patientKey_(houseId, name, date) {
  return String(houseId == null ? '' : houseId).trim() + '::' +
         String(name    == null ? '' : name).trim()    + '::' +
         asISODate_(date);
}

/* Low-level PatientsTombstones writer: snapshot each raw patient row + audit
 * metadata. THROWS on failure — each caller decides whether that is fatal.
 * Callers run inside a script lock. */
function appendPatientTombstones_(rows, reason, savedByAction) {
  if (!rows || rows.length === 0) return;
  const sh = getOrCreateSheet_(PATIENTS_TOMBSTONES_SHEET, PATIENT_TOMBSTONE_COLUMNS);
  const nowIso = new Date().toISOString();
  const out = rows.map(function (row) {
    const obj = {};
    for (let i = 0; i < PATIENT_COLUMNS.length; i++) obj[PATIENT_COLUMNS[i]] = row[i];
    obj.date          = asISODate_(obj.date);
    obj.droppedAt     = nowIso;
    obj.reason        = reason;
    obj.savedByAction = savedByAction;
    return objectToRow_(obj, PATIENT_TOMBSTONE_COLUMNS);
  });
  // Write at the next row (not appendRow) so the whole-column text formats
  // getOrCreateSheet_ applied are already in place when the values land.
  const target = sh.getLastRow() + 1;
  sh.getRange(target, 1, out.length, PATIENT_TOMBSTONE_COLUMNS.length).setValues(out);
}

/* Copy omitted-but-kept patient rows to the PatientsTombstones audit sheet.
 * FAIL-SOFT by contract: the rows are already being KEPT on the Patients
 * sheet by the merge, so an audit failure must never block or fail the save.
 * (Contrast deletePatientRow_, where the tombstone is fail-HARD because the
 * row is about to be destroyed.) Only caller is replaceHousePatients_. */
function tombstonePreservedPatients_(rows, savedByAction) {
  try {
    appendPatientTombstones_(rows, 'saveAll-omitted-preserved', savedByAction || 'saveAll');
  } catch (err) {
    try { console.warn('[tombstone] audit write skipped: ' + ((err && err.message) || err)); } catch (_) { /* no-op */ }
  }
}

/* Append one event row to the hidden AuditLog sheet. FAIL-SOFT by hard
 * contract (locked by test): audit logging must NEVER break or fail the main
 * operation — every failure is swallowed. `details` may be an object (JSON-
 * stringified compactly) or a ready string. The sheet is ensured on first use
 * and kept hidden — Vered sees nothing new. Callers keep their call ONE line. */
function logAudit_(action, fn, patientId, name, details) {
  try {
    const sh = getOrCreateSheet_(AUDIT_LOG_SHEET, AUDIT_LOG_COLUMNS);
    try { if (!sh.isSheetHidden()) sh.hideSheet(); } catch (_) { /* no-op */ }
    const row = objectToRow_({
      timestamp: new Date().toISOString(),
      action:    String(action == null ? '' : action),
      fn:        String(fn == null ? '' : fn),
      patientId: String(patientId == null ? '' : patientId),
      name:      String(name == null ? '' : name),
      details:   typeof details === 'string' ? details : JSON.stringify(details || {}),
    }, AUDIT_LOG_COLUMNS);
    // Write at the next row (not appendRow) so the whole-column text formats
    // applied at ensure time are already in place — same pattern as the
    // tombstones writer.
    sh.getRange(sh.getLastRow() + 1, 1, 1, AUDIT_LOG_COLUMNS.length).setValues([row]);
  } catch (err) {
    try { console.warn('[audit] log skipped: ' + ((err && err.message) || err)); } catch (_) { /* no-op */ }
  }
}

/* fromLead lead-ids of NON-restored discharged-audit rows, as a {id: true} set
 * for the promotion dedupe guard — the server-side mirror of the client's
 * dischargedByFromLead guard (discharge-loop pattern: a released patient's
 * lead must not re-promote; restored==='TRUE' rows are excluded so both
 * restore paths keep re-promoting). Read once per saveAll_, inside its lock.
 * FAIL-OPEN like recentUserDeleteKeys_: an unreadable sheet must never fail
 * the save — the guard is then merely inactive for that save. */
function dischargedFromLeadIds_() {
  const out = {};
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sh = ss.getSheetByName(DISCHARGED_PATIENTS_SHEET);
    if (!sh) return out;
    const rows = readSheet_(sh, DISCHARGED_PATIENT_COLUMNS);
    for (let i = 0; i < rows.length; i++) {
      if (String(rows[i].restored) === 'TRUE' || rows[i].restored === true) continue;
      const fl = String(rows[i].fromLead == null ? '' : rows[i].fromLead).trim();
      if (fl) out[fl] = true;
    }
  } catch (err) {
    try { console.warn('[audit] discharged-id scan skipped: ' + ((err && err.message) || err)); } catch (_) { /* no-op */ }
  }
  return out;
}

/**
 * MERGE the payload's patients into the house's rows — merge-don't-drop.
 * Rows for other houses are untouched, exactly as before. Within the house:
 *   - payload row matches a sheet row by patientKey_ → the sheet row is
 *     replaced by the payload row (field edits, status flips, exitDate all
 *     behave as they always did — per-row last-writer-wins);
 *   - payload row matches nothing → appended (admission);
 *   - sheet row ABSENT from the payload → KEPT. Genuine deletion goes through
 *     the dedicated deletePatientRow action (discharge is a status flip), so
 *     a saveAll omission is never a legitimate deletion — it is a stale tab
 *     that loaded before the row existed. Kept rows are copied to the
 *     PatientsTombstones audit sheet (fail-soft, before the rewrite) and
 *     their keys returned so the response can tell the client to resync.
 * Accepted trade-off (documented, locked by test): editing a patient's name
 * or entry date changes the identity key, so the old row is preserved and the
 * edit lands as a new row — a visible, mergeable duplicate instead of silent
 * loss. Duplicate keys consume matches one payload row per sheet row, in
 * sheet order.
 *
 * `suppressedDeleteKeys` (optional, from recentUserDeleteKeys_): identity
 * keys with a FRESH 'user-delete' tombstone. A payload row whose key is in
 * that set and matches no current sheet row is DROPPED, not appended — it is
 * a stale tab resurrecting a permanently deleted patient. A key that IS back
 * on the sheet (deliberately re-added) is matched normally, never dropped.
 *
 * `dischargedFromLeads` (optional, from dischargedFromLeadIds_): fromLead
 * lead-ids with a NON-restored discharged-audit row.
 *
 * PROMOTION DEDUPE GUARD (the הדס duplicate fix) + RENAME-IN-PLACE: a payload
 * row that would be APPENDED (no patientKey_ match) and carries a non-empty
 * fromLead is resolved in this order:
 *   1. An unconsumed SAME-HOUSE sheet row carries that fromLead (and its own
 *      identity key is not claimed by another payload row) → this is Vered's
 *      legitimate name/entry-date edit arriving under a new identity key: the
 *      existing row is UPDATED IN PLACE (all fields overwritten from the
 *      incoming row), audit-logged as 'patient_renamed_via_fromLead' with
 *      old→new name. If MORE than one such row exists (a pre-existing
 *      duplicate, the הדס state), the FIRST in sheet order is updated —
 *      deterministic, never both — and the ambiguity is flagged in the audit
 *      details (matches>1, ambiguous:true).
 *   2. The fromLead exists anywhere ELSE on the sheet (another house,
 *      released included) or on a row appended earlier in this save → the
 *      true duplicate-promotion signature: SKIPPED, audit-logged
 *      'promote_skipped_duplicate', echoed in skippedPromotes.
 *   3. The fromLead has a non-restored discharged-audit row → same skip
 *      (discharge-loop guard, mirroring the client's dischargedByFromLead).
 * All read from the sheet at write time, so a stale tab whose in-memory
 * guards missed can no longer create a second row for the same lead — while
 * an edit-modal rename lands instead of being dropped. Note a HOUSE-MOVE of a
 * lead-linked patient also arrives as an append (houseId is in the key) and
 * falls under rule 2 — refused, surfaced by the client's promoteSkipped
 * toast. Hand-entered patients (fromLead '') keep the old rename trade-off
 * (old row kept + edit appended) unchanged.
 *
 * Returns { written, preservedKeys, suppressedKeys, skippedPromotes }:
 * `written` counts the rows actually written for the house (payload count
 * minus suppressed minus skipped), so the saveAll_ `written` echo stays
 * honest for the server diagnostics.
 *
 * Write order is WRITE-THEN-TRIM, not clear-then-write: the final row set is
 * written first, then only surplus tail rows are cleared. A crash between the
 * two steps can leave duplicate tail rows (visible, fixable) but can no
 * longer empty the sheet. Note the merge means the Patients sheet never
 * shrinks through this path, so the trim is a pure safety net here.
 */
function replaceHousePatients_(houseId, patientsArr, suppressedDeleteKeys, dischargedFromLeads) {
  const sh = getOrCreateSheet_(PATIENTS_SHEET, PATIENT_COLUMNS);
  const houseColIdx = PATIENT_COLUMNS.indexOf('houseId');
  const nameColIdx  = PATIENT_COLUMNS.indexOf('name');
  const dateColIdx  = PATIENT_COLUMNS.indexOf('date');
  const fromLeadIdx = PATIENT_COLUMNS.indexOf('fromLead');
  const lastRow = sh.getLastRow();

  const kept = [];       // other houses' rows, original order — untouched
  const houseRows = [];  // this house's current sheet rows, sheet order
  if (lastRow > 1) {
    const values = sh.getRange(2, 1, lastRow - 1, PATIENT_COLUMNS.length).getValues();
    for (let i = 0; i < values.length; i++) {
      if (values[i][houseColIdx] === houseId) houseRows.push(values[i]);
      else kept.push(values[i]);
    }
  }

  // Index this house's sheet rows by identity key; duplicate keys queue up.
  const byKey = {};
  for (let i = 0; i < houseRows.length; i++) {
    const key = patientKey_(houseId, houseRows[i][nameColIdx], houseRows[i][dateColIdx]);
    if (!byKey[key]) byKey[key] = [];
    byKey[key].push(i);
  }

  // fromLead → name of every row currently ON the sheet (all houses,
  // released included) — the existence set the promotion dedupe guard checks
  // appends against. Extended as this save appends, so the same lead can't
  // land twice even within one payload.
  const fromLeadOnSheet = {};
  const indexFromLead = function (row) {
    const fl = fromLeadIdx >= 0 ? String(row[fromLeadIdx] == null ? '' : row[fromLeadIdx]).trim() : '';
    if (fl && !(fl in fromLeadOnSheet)) fromLeadOnSheet[fl] = String(row[nameColIdx] == null ? '' : row[nameColIdx]);
  };
  for (let i = 0; i < kept.length; i++) indexFromLead(kept[i]);
  for (let i = 0; i < houseRows.length; i++) indexFromLead(houseRows[i]);

  // THIS house's sheet rows by fromLead (indices, sheet order) — the
  // rename-in-place lookup. Separate from fromLeadOnSheet so a same-house
  // match can be told apart from a cross-house one.
  const houseRowsByFromLead = {};
  for (let i = 0; i < houseRows.length; i++) {
    const fl = fromLeadIdx >= 0 ? String(houseRows[i][fromLeadIdx] == null ? '' : houseRows[i][fromLeadIdx]).trim() : '';
    if (!fl) continue;
    if (!houseRowsByFromLead[fl]) houseRowsByFromLead[fl] = [];
    houseRowsByFromLead[fl].push(i);
  }

  // Identity keys the payload itself claims. A sheet row whose key another
  // payload row will key-match must never be consumed by the rename-in-place
  // branch — that would double-consume it and let the payload land two rows
  // for one fromLead.
  const payloadKeys = {};
  for (let i = 0; i < patientsArr.length; i++) {
    const p = patientsArr[i] || {};
    payloadKeys[patientKey_(houseId, p.name, p.date)] = true;
  }

  const discharged = dischargedFromLeads || {};
  const suppressed = suppressedDeleteKeys || {};
  const suppressedKeys = [];
  const skippedPromotes = [];
  const consumed = {};
  const newRows = [];
  for (let i = 0; i < patientsArr.length; i++) {
    const withHouse = Object.assign({}, patientsArr[i], { houseId: houseId });
    const key = patientKey_(houseId, withHouse.name, withHouse.date);
    const queue = byKey[key];
    if (queue && queue.length > 0) {
      // On the sheet → normal replace, even if the key was once user-deleted
      // (a row that is back on the sheet was re-added deliberately).
      const rowIdx = queue.shift();
      consumed[rowIdx] = true;
      const newRow = objectToRow_(withHouse, PATIENT_COLUMNS);
      const changed = [];
      for (let c = 0; c < PATIENT_COLUMNS.length; c++) {
        const dateLike = (c === dateColIdx || PATIENT_COLUMNS[c] === 'exitDate');
        const before = dateLike ? asISODate_(houseRows[rowIdx][c]) : String(houseRows[rowIdx][c] == null ? '' : houseRows[rowIdx][c]);
        const after  = dateLike ? asISODate_(newRow[c])            : String(newRow[c] == null ? '' : newRow[c]);
        if (before !== after) changed.push(PATIENT_COLUMNS[c]);
      }
      if (changed.length > 0) logAudit_('patient_edited', 'replaceHousePatients_', withHouse.fromLead || '', withHouse.name || '', { key: key, changed: changed });
      newRows.push(newRow);
      continue;
    }
    if (suppressed[key]) {
      // Not on the sheet + fresh user-delete tombstone → a stale tab trying
      // to resurrect a deleted patient. Drop the row, tell the caller.
      suppressedKeys.push(key);
      continue;
    }
    // APPEND path — rename-in-place, then dedupe guard (contract comment above).
    const fl = String(withHouse.fromLead == null ? '' : withHouse.fromLead).trim();
    if (fl) {
      // Rule 1: unconsumed SAME-HOUSE row with this fromLead whose own key no
      // payload row claims → a rename / entry-date edit. Update it in place:
      // consume the old row and write the incoming row over it. First match
      // in sheet order when the fromLead is (pre-existing-bug) duplicated —
      // deterministic, never both; ambiguity flagged in the audit details.
      const matches = (houseRowsByFromLead[fl] || []).filter(function (idx) {
        return !consumed[idx] &&
          !payloadKeys[patientKey_(houseId, houseRows[idx][nameColIdx], houseRows[idx][dateColIdx])];
      });
      if (matches.length > 0) {
        const idx = matches[0];
        consumed[idx] = true;
        const oldName = String(houseRows[idx][nameColIdx] == null ? '' : houseRows[idx][nameColIdx]);
        const oldKey = patientKey_(houseId, houseRows[idx][nameColIdx], houseRows[idx][dateColIdx]);
        logAudit_('patient_renamed_via_fromLead', 'replaceHousePatients_', fl, withHouse.name || '', { houseId: houseId, oldName: oldName, newName: String(withHouse.name || ''), oldKey: oldKey, newKey: key, matches: matches.length, ambiguous: matches.length > 1 });
        newRows.push(objectToRow_(withHouse, PATIENT_COLUMNS));
        continue;
      }
    }
    if (fl && (fl in fromLeadOnSheet)) {
      skippedPromotes.push({ fromLead: fl, name: String(withHouse.name || ''), reason: 'existing_patient_row' });
      logAudit_('promote_skipped_duplicate', 'replaceHousePatients_', fl, withHouse.name || '', { houseId: houseId, key: key, existingName: fromLeadOnSheet[fl], reason: 'existing_patient_row' });
      continue;
    }
    if (fl && discharged[fl]) {
      skippedPromotes.push({ fromLead: fl, name: String(withHouse.name || ''), reason: 'discharged_not_restored' });
      logAudit_('promote_skipped_duplicate', 'replaceHousePatients_', fl, withHouse.name || '', { houseId: houseId, key: key, reason: 'discharged_not_restored' });
      continue;
    }
    if (fl) fromLeadOnSheet[fl] = String(withHouse.name || '');
    logAudit_(fl ? 'promote_created' : 'patient_added', 'replaceHousePatients_', fl, withHouse.name || '', { houseId: houseId, key: key, status: String(withHouse.status || ''), source: String(withHouse.source || '') });
    newRows.push(objectToRow_(withHouse, PATIENT_COLUMNS));
  }

  // Sheet rows the payload did not carry: KEEP them, audit each one.
  const preservedRows = [];
  const preservedKeys = [];
  for (let i = 0; i < houseRows.length; i++) {
    if (consumed[i]) continue;
    preservedRows.push(houseRows[i]);
    preservedKeys.push(patientKey_(houseId, houseRows[i][nameColIdx], houseRows[i][dateColIdx]));
  }
  tombstonePreservedPatients_(preservedRows, 'saveAll');

  // Canonicalize the entry-date column to a clean YYYY-MM-DD string for ALL
  // rows — kept/preserved rows (whose cell may already be a coerced Date
  // object from getValues) and new rows (a string from the client) alike.
  // asISODate_ formats any Date in the spreadsheet timezone, so the stored
  // value is unambiguous text — mirrors the treatment leads' `created` column
  // gets in mergeLeads_.
  const finalRows = kept.concat(preservedRows).concat(newRows).map(function (row) {
    if (dateColIdx >= 0) row[dateColIdx] = asISODate_(row[dateColIdx]);
    return row;
  });

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
  // Trim only the surplus tail AFTER the write (write-then-trim).
  if (lastRow > finalRows.length + 1) {
    sh.getRange(finalRows.length + 2, 1, lastRow - finalRows.length - 1, PATIENT_COLUMNS.length).clearContent();
  }
  return { written: newRows.length, preservedKeys: preservedKeys, suppressedKeys: suppressedKeys, skippedPromotes: skippedPromotes };
}

/* Identity keys of FRESH 'user-delete' tombstones (droppedAt within
 * USER_DELETE_SUPPRESS_MS), as a {key: true} set for the saveAll merge. Read
 * once per saveAll_, inside its lock. FAIL-OPEN by contract: an unreadable
 * tombstone sheet or an unparseable droppedAt must never fail the save and
 * never permanently block a key — the row is then merely appendable again,
 * and the visibilitychange reload remains the outer defense. */
function recentUserDeleteKeys_() {
  const out = {};
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sh = ss.getSheetByName(PATIENTS_TOMBSTONES_SHEET);
    if (!sh) return out;
    const lastRow = sh.getLastRow();
    if (lastRow < 2) return out;
    const values = sh.getRange(2, 1, lastRow - 1, PATIENT_TOMBSTONE_COLUMNS.length).getValues();
    const hIdx = PATIENT_TOMBSTONE_COLUMNS.indexOf('houseId');
    const nIdx = PATIENT_TOMBSTONE_COLUMNS.indexOf('name');
    const dIdx = PATIENT_TOMBSTONE_COLUMNS.indexOf('date');
    const rIdx = PATIENT_TOMBSTONE_COLUMNS.indexOf('reason');
    const aIdx = PATIENT_TOMBSTONE_COLUMNS.indexOf('droppedAt');
    const now = Date.now();
    for (let i = 0; i < values.length; i++) {
      const row = values[i];
      if (String(row[rIdx]) !== 'user-delete') continue;
      const at = Date.parse(asTimestampText_(row[aIdx]));
      if (!isFinite(at) || now - at > USER_DELETE_SUPPRESS_MS) continue;
      out[patientKey_(row[hIdx], row[nIdx], row[dIdx])] = true;
    }
  } catch (err) {
    try { console.warn('[tombstone] user-delete key scan skipped: ' + ((err && err.message) || err)); } catch (_) { /* no-op */ }
  }
  return out;
}

/* ===== Permanent patient-row delete (dedicated action) =====
 *
 * The occupancy tab's ✕ button used to delete by OMISSION — drop the patient
 * from the client's list and let saveAll's whole-house replace lose the row.
 * Merge-don't-drop closed that channel (omission now preserves), so genuine
 * deletion is a first-class action, mirroring removeLead_'s safe sequence but
 * keyed by patientKey_ (the Patients sheet has no id column):
 *   1. Peek FIRST (read-only): no row matches the key → refuse, touch
 *      NOTHING. The client surfaces the error and rolls its state back.
 *   2. Tombstone the matched row(s) — reason 'user-delete' — BEFORE the
 *      delete, FAIL-HARD: if the audit write throws, the delete is aborted
 *      and the row survives. Nothing is ever destroyed without its recovery
 *      copy. (Deliberate opposite of tombstonePreservedPatients_'s fail-soft
 *      contract, where the row is being kept anyway.)
 *   3. Rewrite the kept rows, then trim the surplus tail (write-then-trim).
 * All under the script lock. Duplicate identity keys delete ALL matching rows
 * — they are indistinguishable by construction. For USER_DELETE_SUPPRESS_MS
 * afterwards, the saveAll merge drops stale payload rows carrying this key so
 * another open tab can't resurrect the patient. */
function deletePatientRow_(patient) {
  if (!patient || !patient.houseId || !patient.name) {
    return { ok: false, error: 'missing_patient' };
  }
  const lock = LockService.getScriptLock();
  lock.tryLock(10000);
  try {
    const sh = getOrCreateSheet_(PATIENTS_SHEET, PATIENT_COLUMNS);
    const houseColIdx = PATIENT_COLUMNS.indexOf('houseId');
    const nameColIdx  = PATIENT_COLUMNS.indexOf('name');
    const dateColIdx  = PATIENT_COLUMNS.indexOf('date');
    const key = patientKey_(patient.houseId, patient.name, patient.date);
    const lastRow = sh.getLastRow();
    if (lastRow < 2) return { ok: false, error: 'patient_not_found' };

    const values = sh.getRange(2, 1, lastRow - 1, PATIENT_COLUMNS.length).getValues();
    const kept = [];
    const matched = [];
    for (let i = 0; i < values.length; i++) {
      const row = values[i];
      if (patientKey_(row[houseColIdx], row[nameColIdx], row[dateColIdx]) === key) matched.push(row);
      else kept.push(row);
    }
    if (matched.length === 0) return { ok: false, error: 'patient_not_found' };

    // Tombstone BEFORE delete — fail-HARD (no catch): an audit failure aborts
    // the whole action via handle_'s exception envelope and the row survives.
    appendPatientTombstones_(matched, 'user-delete', 'deletePatientRow');

    if (kept.length > 0) {
      sh.getRange(2, 1, kept.length, PATIENT_COLUMNS.length).setValues(kept);
    }
    if (lastRow > kept.length + 1) {
      sh.getRange(kept.length + 2, 1, lastRow - kept.length - 1, PATIENT_COLUMNS.length).clearContent();
    }
    logAudit_('patient_deleted', 'deletePatientRow_', patient.fromLead || '', patient.name || '', { key: key, deleted: matched.length });
    return { ok: true, deleted: matched.length, key: key };
  } finally {
    try { lock.releaseLock(); } catch (_) { /* no-op */ }
  }
}

/* ===== Irrelevant leads (move + restore) =====
 *
 * One-way automatic move on the move side; explicit restore brings a row back.
 * Both operations are atomic under a script lock so a concurrent saveAll can't
 * race a move and resurrect the row in the Leads sheet.
 */

/* Count the rows whose id column equals `idValue` — the read-only peek that
 * opens removeLead_'s peek → append → delete sequence. 0 means the id isn't on
 * the sheet (e.g. a client-invented random id for a blank-id row) and the
 * caller must refuse to proceed without touching anything. */
function countRowsById_(sh, columns, idValue) {
  const idIdx = columns.indexOf('id');
  if (idIdx < 0) return 0;
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return 0;
  const ids = sh.getRange(2, idIdx + 1, lastRow - 1, 1).getValues();
  const target = String(idValue);
  let n = 0;
  for (let i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === target) n++;
  }
  return n;
}

/* Delete every row whose id column equals `idValue`. Returns the NUMBER of rows
 * removed (0 when nothing matched) so callers can distinguish a real delete from
 * a no-op — e.g. removeLead_ refuses to append a phantom "removed" row when the
 * id never matched. Backward-compatible: existing callers that ignore the return
 * value are unaffected. */
function deleteRowsById_(sh, columns, idValue) {
  const idIdx = columns.indexOf('id');
  if (idIdx < 0) return 0;
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return 0;
  const values = sh.getRange(2, 1, lastRow - 1, columns.length).getValues();
  const target = String(idValue);
  const kept = values.filter(function (row) { return String(row[idIdx]) !== target; });
  const removed = values.length - kept.length;
  if (removed === 0) return 0;
  // WRITE-THEN-TRIM: rewrite the kept rows first, then clear only the surplus
  // tail. A crash between the two steps leaves stale duplicate tail rows
  // (visible, re-deletable) instead of an emptied sheet.
  if (kept.length > 0) {
    sh.getRange(2, 1, kept.length, columns.length).setValues(kept);
  }
  if (lastRow > kept.length + 1) {
    sh.getRange(kept.length + 2, 1, lastRow - kept.length - 1, columns.length).clearContent();
  }
  return removed;
}

/* Heal an id-keyed sheet in place: any row that has content but a BLANK id cell
 * gets a freshly generated id written back to that single cell (per-row single-
 * cell write — never a whole-sheet rewrite). This closes the blank-id bug: a
 * blank-id row makes the client's normalizeLead invent a random cryptoId, which
 * then never matches for delete/update-by-id (removeLead / moveLeadIrrelevant /
 * restoreLead), so the operation silently no-ops and the row reappears on reload.
 * After backfill, client and sheet agree on the key. Idempotent — a sheet with
 * every id present performs ZERO writes. Fully-empty trailing rows are skipped
 * (readSheet_ ignores them). Returns the count backfilled. No-op if `columns`
 * has no id column. */
function backfillMissingIds_(sh, columns) {
  const idIdx = columns.indexOf('id');
  if (idIdx < 0) return 0;
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return 0;
  const values = sh.getRange(2, 1, lastRow - 1, columns.length).getValues();
  const idCol = idIdx + 1;
  let filled = 0;
  for (let i = 0; i < values.length; i++) {
    const row = values[i];
    const cur = String(row[idIdx] == null ? '' : row[idIdx]).trim();
    if (cur !== '') continue;
    let hasContent = false;
    for (let j = 0; j < row.length; j++) {
      if (row[j] !== '' && row[j] !== null) { hasContent = true; break; }
    }
    if (!hasContent) continue; // fully-empty row — leave it alone
    const newId = 'id-' + Utilities.getUuid();
    const cell = sh.getRange(i + 2, idCol, 1, 1);
    cell.setNumberFormat('@');   // ids are opaque text — never let Sheets coerce
    cell.setValue(newId);
    filled++;
  }
  return filled;
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

/* ONE-TIME MANUAL DETECTION — run from the Apps Script editor (Run dropdown).
 *
 * READ-ONLY: scans the Patients sheet and Logger.logs every lead-id (fromLead)
 * that appears on MORE than one row — the הדס duplicate class — with each
 * row's sheet row number, name, status and entry date, so the surplus row can
 * be cleaned by hand (dashboard ✕ / deletePatientRow). Performs ZERO writes
 * (reads via getSheetByName, never the ensure path, so it cannot even create
 * a sheet). Intentionally PUBLIC (no trailing underscore) so it shows in the
 * editor's Run dropdown — same rationale and same non-exposure argument as
 * repairLeadVisitTimes above: handle_'s fixed action allow-list never names
 * it, so no HTTP request can reach it. Returns the duplicate groups (also
 * handy for tests). */
function findDuplicatePatientIdsNow() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(PATIENTS_SHEET);
  if (!sh) {
    Logger.log('findDuplicatePatientIdsNow: no Patients sheet.');
    return [];
  }
  const fromLeadIdx = PATIENT_COLUMNS.indexOf('fromLead');
  const nameIdx     = PATIENT_COLUMNS.indexOf('name');
  const statusIdx   = PATIENT_COLUMNS.indexOf('status');
  const dateIdx     = PATIENT_COLUMNS.indexOf('date');
  const lastRow = sh.getLastRow();
  if (lastRow < 2) {
    Logger.log('findDuplicatePatientIdsNow: no data rows.');
    return [];
  }
  const values = sh.getRange(2, 1, lastRow - 1, PATIENT_COLUMNS.length).getValues();
  const byId = {};
  for (let i = 0; i < values.length; i++) {
    const fl = String(values[i][fromLeadIdx] == null ? '' : values[i][fromLeadIdx]).trim();
    if (!fl) continue; // hand-entered rows have no lead id — nothing to key on
    if (!byId[fl]) byId[fl] = [];
    byId[fl].push({
      row:    i + 2, // 1-based sheet row (header is row 1)
      name:   String(values[i][nameIdx] == null ? '' : values[i][nameIdx]),
      status: String(values[i][statusIdx] == null ? '' : values[i][statusIdx]),
      date:   asISODate_(values[i][dateIdx]),
    });
  }
  const dupes = [];
  Object.keys(byId).forEach(function (fl) {
    if (byId[fl].length < 2) return;
    dupes.push({ fromLead: fl, rows: byId[fl] });
    Logger.log('DUPLICATE patient id ' + fl + ' on ' + byId[fl].length + ' rows: ' +
      byId[fl].map(function (r) { return 'row ' + r.row + ' "' + r.name + '" (' + r.status + ', ' + r.date + ')'; }).join('; '));
  });
  Logger.log('findDuplicatePatientIdsNow: ' + dupes.length + ' duplicate id(s) across ' + values.length + ' data rows. No writes performed.');
  return dupes;
}

/* ===== Corrupted-rows cleanup (U+FFFD Hebrew-name corruption) =====
 *
 * The server.js UTF-8 chunk-split bug (fixed in PR #102) wrote U+FFFD
 * replacement characters into Hebrew free text between 2026-07-27 and the
 * fix, and the resulting name changes also spawned duplicate Patients rows
 * (name is part of row identity). These utilities find the damage, PROPOSE
 * repairs from cross-reference sources, and apply ONLY what Sandra has
 * explicitly approved row-by-row in the hidden RepairPlan sheet. All three
 * entry points are PUBLIC (Run dropdown) and unreachable over HTTP —
 * handle_'s fixed action allow-list never names them (same non-exposure
 * argument as repairLeadVisitTimes; guard-tested).
 *
 * Workflow: scanCorruptedRowsNow (dry run, read-only) → writeRepairPlanNow
 * (fills RepairPlan, approved=FALSE) → Sandra reviews/edits/approves →
 * applyCorruptedRowRepairsNow (executes approved rows only). */

const CORRUPTION_MARK = '�';

function hasCorruption_(v) {
  return typeof v === 'string' ? v.indexOf(CORRUPTION_MARK) >= 0 :
    String(v == null ? '' : v).indexOf(CORRUPTION_MARK) >= 0;
}

/* Phone key for cross-reference matching, per the ecosystem rule: normalize
 * (strip non-digits, 972→0 via normalizePhone_), then heal the
 * Sheets-dropped-leading-zero case (9 digits not starting with 0 → prepend
 * '0'), and accept ONLY a full /^0\d{9}$/ match — anything else returns ''
 * and never participates in matching. LOCAL to the cleanup: the admitted
 * roster's normalizePhone_ contract is untouched. */
function corruptionPhoneKey_(raw) {
  let digits = normalizePhone_(raw);
  if (/^\d{9}$/.test(digits) && digits.charAt(0) !== '0') digits = '0' + digits;
  return /^0\d{9}$/.test(digits) ? digits : '';
}

function escapeRegex_(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/* The wildcard-compatibility rule shared by the snapshot sanity guard and the
 * enum/roster tiers: a candidate is compatible with a corrupted value when the
 * corrupted value's SURVIVING characters appear in order, anchored at both
 * ends, and every maximal U+FFFD run stands in for 1+ characters (a single
 * U+FFFD may replace a multi-byte char OR one split char may produce several
 * U+FFFDs, so run LENGTH is meaningless — only 'at least one char' holds).
 * Returns a compiled RegExp for the corrupted value, or null when the value
 * carries no corruption (nothing to match against). */
function corruptionMatcherFor_(corrupted) {
  const c = String(corrupted == null ? '' : corrupted);
  if (!hasCorruption_(c)) return null;
  const parts = c.split(/�+/).map(escapeRegex_);
  return new RegExp('^' + parts.join('.+') + '$');
}

function corruptionPatternMatches_(corrupted, candidate) {
  const s = String(candidate == null ? '' : candidate);
  if (s === '' || hasCorruption_(s)) return false;
  const re = corruptionMatcherFor_(corrupted);
  return re ? re.test(s) : String(corrupted) === s;
}

/* Exactly-one wildcard match of `corrupted` against a {value: true} set.
 * Returns the single matching value, or '' on zero / two-plus matches —
 * ambiguity is never guessed. */
function corruptionMatchExactlyOne_(corrupted, valuesSet) {
  const re = corruptionMatcherFor_(corrupted);
  if (!re || !valuesSet) return '';
  let hit = '';
  const keys = Object.keys(valuesSet);
  for (let i = 0; i < keys.length; i++) {
    if (re.test(keys[i])) {
      if (hit) return ''; // second match — ambiguous
      hit = keys[i];
    }
  }
  return hit;
}

/* Twin-merge (tier-3 bonus): two same-length values corrupted in DIFFERENT
 * positions; where exactly one side is clean its character wins, where both
 * are clean they must agree. Returns the reconstructed clean string, or ''
 * when the pair conflicts, overlaps in corruption, differs in length, or the
 * union is still corrupted. Length-equality is required because U+FFFD run
 * length does not track character count — only position-aligned pairs can be
 * merged safely. */
function mergeCorruptedTwins_(a, b) {
  const x = String(a == null ? '' : a), y = String(b == null ? '' : b);
  if (x.length !== y.length || x.length === 0) return '';
  let out = '';
  for (let i = 0; i < x.length; i++) {
    const cx = x.charAt(i), cy = y.charAt(i);
    if (cx === CORRUPTION_MARK && cy === CORRUPTION_MARK) return '';
    if (cx !== CORRUPTION_MARK && cy !== CORRUPTION_MARK && cx !== cy) return '';
    out += (cx === CORRUPTION_MARK) ? cy : cx;
  }
  return hasCorruption_(out) ? '' : out;
}

/* ===== Tier 1 — EZONE-SNAPSHOT spreadsheets (read-only) =====
 *
 * Sandra creates a pre-bug copy via File → Version history → Make a copy and
 * names it starting with 'EZONE-SNAPSHOT'. Every such spreadsheet is a
 * snapshot source, tried OLDEST-modified first (newest-modified last in
 * priority — an older copy is closer to the pre-corruption state). Snapshots
 * are NEVER written to: they are opened read-only via openById and only
 * getRange(...).getValues() is ever called on them (locked by test).
 * FAIL-OPEN: no Drive access, no matching file, or an unreadable snapshot
 * just means tier 1 is inactive — tiers 2–3 still run. */
function corruptionSnapshots_() {
  const out = [];
  try {
    const it = DriveApp.searchFiles(
      'title contains "EZONE-SNAPSHOT" and trashed = false and mimeType = "application/vnd.google-apps.spreadsheet"');
    const files = [];
    while (it.hasNext()) {
      const f = it.next();
      if (String(f.getName()).indexOf('EZONE-SNAPSHOT') === 0) files.push(f);
    }
    files.sort(function (a, b) { return a.getLastUpdated() - b.getLastUpdated(); });
    files.forEach(function (f) {
      try {
        out.push({ name: String(f.getName()), ss: SpreadsheetApp.openById(f.getId()), _rows: {} });
      } catch (err) {
        try { Logger.log('snapshot "' + f.getName() + '" could not be opened: ' + ((err && err.message) || err)); } catch (_) { /* no-op */ }
      }
    });
  } catch (err) {
    try { Logger.log('snapshot lookup skipped: ' + ((err && err.message) || err)); } catch (_) { /* no-op */ }
  }
  return out;
}

/* Read (and cache) one target sheet from one snapshot, mapping cells to the
 * LIVE schema's column names BY POSITION — tolerant of a snapshot that
 * pre-dates appended columns (only the first min(live, snapshot) columns are
 * read; missing trailing columns are simply absent from the row objects).
 * Returns null when the snapshot has no such sheet. */
function snapshotRows_(snap, target) {
  if (target.sheet in snap._rows) return snap._rows[target.sheet];
  let rows = null;
  try {
    const sh = snap.ss.getSheetByName(target.sheet);
    if (sh) {
      rows = [];
      const lastRow = sh.getLastRow();
      const nCols = Math.min(target.columns.length, sh.getLastColumn());
      if (lastRow >= 2 && nCols > 0) {
        const values = sh.getRange(2, 1, lastRow - 1, nCols).getValues();
        for (let i = 0; i < values.length; i++) {
          const row = values[i];
          let hasContent = false;
          for (let j = 0; j < row.length; j++) {
            if (row[j] !== '' && row[j] !== null) { hasContent = true; break; }
          }
          if (!hasContent) continue;
          const obj = {};
          for (let j = 0; j < nCols; j++) obj[target.columns[j]] = row[j];
          rows.push(obj);
        }
      }
    }
  } catch (err) {
    rows = null;
    try { Logger.log('snapshot "' + snap.name + '" sheet ' + target.sheet + ' unreadable: ' + ((err && err.message) || err)); } catch (_) { /* no-op */ }
  }
  snap._rows[target.sheet] = rows;
  return rows;
}

/* Locate the live row's twin inside one snapshot, per the target's
 * snapshotKey. Returns {status: 'match', row} | {status: 'ambiguous', count}
 * | {status: 'none'} (covers missing sheet / missing key too). */
function snapshotMatch_(snap, target, liveObj) {
  const rows = snapshotRows_(snap, target);
  if (!rows) return { status: 'none' };
  let candidates = [];
  if (target.snapshotKey === 'id') {
    const id = String(liveObj.id == null ? '' : liveObj.id).trim();
    if (!id) return { status: 'none' };
    candidates = rows.filter(function (r) { return String(r.id == null ? '' : r.id).trim() === id; });
  } else if (target.snapshotKey === 'patient') {
    const fl = String(liveObj.fromLead == null ? '' : liveObj.fromLead).trim();
    if (fl) {
      candidates = rows.filter(function (r) { return String(r.fromLead == null ? '' : r.fromLead).trim() === fl; });
    }
    if (candidates.length === 0) {
      const key = String(liveObj.houseId == null ? '' : liveObj.houseId) + '::' +
                  asISODate_(liveObj.date) + '::' + String(liveObj.pay == null ? '' : liveObj.pay);
      candidates = rows.filter(function (r) {
        return String(r.houseId == null ? '' : r.houseId) + '::' + asISODate_(r.date) + '::' +
               String(r.pay == null ? '' : r.pay) === key;
      });
    }
  } else {
    return { status: 'none' };
  }
  if (candidates.length === 0) return { status: 'none' };
  if (candidates.length > 1) return { status: 'ambiguous', count: candidates.length };
  return { status: 'match', row: candidates[0] };
}

/* The sheets + columns where free-text Hebrew lives — the scan targets.
 * Stable-key columns (stage, status, disposition, meetingOutcome, …) and
 * date/number columns are deliberately absent: U+FFFD cannot appear in them
 * unless the row is damaged beyond what a text repair fixes.
 *   textCols    — columns scanned for U+FFFD
 *   phoneCols   — columns whose digits feed the phone cross-reference
 *   leadIdCol   — column holding the Leads id ('' when the sheet has none)
 *   nameCol     — the sheet's person-name column (lead/phone/roster repairs
 *                 propose values only for THIS column)
 *   snapshotKey — how a live row is matched to its EZONE-SNAPSHOT twin:
 *                 'id' (the sheet's own id column), 'patient' (fromLead when
 *                 non-empty, else houseId + entryDate + monthly pay), 'none'
 *                 (no trustworthy key — Payments.patientId is session-local,
 *                 Managers/Outpatients have no key; tiers 2–3 still apply)
 *   enumCols    — closed-set columns eligible for the enum tier. NEVER
 *                 name/notes/long-text columns. */
function corruptionScanTargets_() {
  const leadText = ['name', 'house', 'source', 'note', 'assignedTo', 'meetingWith',
    'meetingCompanion', 'meetingNote', 'meetingReporter', 'contactName', 'contactRelation'];
  const leadPhones = ['phone', 'contactPhone', 'billingPhone'];
  const leadEnums = ['house', 'source', 'meetingWith', 'assignedTo', 'meetingReporter'];
  return [
    { sheet: PATIENTS_SHEET,             columns: PATIENT_COLUMNS,           textCols: ['name', 'notes'],                        phoneCols: [],         leadIdCol: 'fromLead', nameCol: 'name',         snapshotKey: 'patient', enumCols: [] },
    { sheet: LEADS_SHEET,                columns: LEAD_COLUMNS,              textCols: leadText,                                 phoneCols: leadPhones, leadIdCol: 'id',       nameCol: 'name',         snapshotKey: 'id',      enumCols: leadEnums },
    { sheet: IRRELEVANT_LEADS_SHEET,     columns: IRRELEVANT_LEAD_COLUMNS,   textCols: leadText.concat(['not_relevant_note']),   phoneCols: leadPhones, leadIdCol: 'id',       nameCol: 'name',         snapshotKey: 'id',      enumCols: leadEnums },
    { sheet: REMOVED_LEADS_SHEET,        columns: REMOVED_LEAD_COLUMNS,      textCols: leadText,                                 phoneCols: leadPhones, leadIdCol: 'id',       nameCol: 'name',         snapshotKey: 'id',      enumCols: leadEnums },
    { sheet: DISCHARGED_PATIENTS_SHEET,  columns: DISCHARGED_PATIENT_COLUMNS, textCols: ['name', 'notes', 'discharge_note'],     phoneCols: [],         leadIdCol: 'fromLead', nameCol: 'name',         snapshotKey: 'id',      enumCols: [] },
    { sheet: PATIENTS_TOMBSTONES_SHEET,  columns: PATIENT_TOMBSTONE_COLUMNS, textCols: ['name', 'notes'],                        phoneCols: [],         leadIdCol: 'fromLead', nameCol: 'name',         snapshotKey: 'patient', enumCols: [] },
    { sheet: PAYMENTS_SHEET,             columns: PAYMENT_COLUMNS,           textCols: ['patientName'],                          phoneCols: [],         leadIdCol: '',         nameCol: 'patientName',  snapshotKey: 'none',    enumCols: [] },
    { sheet: MANAGERS_SHEET,             columns: MANAGER_COLUMNS,           textCols: ['manager_name'],                         phoneCols: [],         leadIdCol: '',         nameCol: 'manager_name', snapshotKey: 'none',    enumCols: ['manager_name'] },
    { sheet: OUTPATIENTS_SHEET,          columns: OUTPATIENT_COLUMNS,        textCols: ['patient_name', 'house_of_origin', 'therapy_type', 'notes'], phoneCols: [], leadIdCol: '', nameCol: 'patient_name', snapshotKey: 'none', enumCols: ['house_of_origin', 'therapy_type'] },
  ];
}

/* Read a target sheet's data rows WITH their 1-based sheet row numbers.
 * getSheetByName only — the scanner must not even create a sheet. Fully-empty
 * rows are skipped (mirrors readSheet_) but row numbers stay true. */
function corruptionReadRows_(target) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(target.sheet);
  if (!sh) return null;
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return [];
  const values = sh.getRange(2, 1, lastRow - 1, target.columns.length).getValues();
  const rows = [];
  for (let i = 0; i < values.length; i++) {
    const row = values[i];
    let hasContent = false;
    for (let j = 0; j < row.length; j++) {
      if (row[j] !== '' && row[j] !== null) { hasContent = true; break; }
    }
    if (!hasContent) continue;
    const obj = {};
    for (let j = 0; j < target.columns.length; j++) obj[target.columns[j]] = row[j];
    rows.push({ rowNumber: i + 2, obj: obj });
  }
  return rows;
}

/* The shared scan engine behind scanCorruptedRowsNow / writeRepairPlanNow.
 * READ-ONLY (snapshots included). Returns:
 *   cells     — [{sheet,row,column,value,proposal,source,newValue}] one per
 *               corrupted cell. Proposal tiers, first that produces a value
 *               wins: 'repair from twin' | 'repair from lead' (the #105
 *               exact-key tiers) → 'repair from snapshot' (tier 1; a matched
 *               snapshot value failing the compatibility guard TERMINATES as
 *               'snapshot mismatch — manual') → 'repair from phone match' →
 *               'repair from enum' (tier 2, closed-set columns only) →
 *               'repair from roster' → 'repair from twin-merge' (tier 3,
 *               name columns only) → 'no source — manual'.
 *   deletes   — [{row,name,houseId,date,fromLead}] corrupted Patients rows
 *               whose clean twin makes them EXACT duplicates (same fromLead +
 *               house + entryDate + status) → proposed 'delete corrupted twin'
 *   keepBoth  — [{fromLead,rows,reason}] same-fromLead pairs that differ in
 *               entryDate or status (the readmission pattern) or are both
 *               corrupted: NEVER proposed for delete — repair only, keep both
 *   snapshots — names of the EZONE-SNAPSHOT spreadsheets used, priority order
 *   summary   — counts */
function corruptionScan_() {
  const targets = corruptionScanTargets_();
  const bySheet = {};
  targets.forEach(function (t) { bySheet[t.sheet] = { target: t, rows: corruptionReadRows_(t) }; });

  // Tier 1 sources — read-only EZONE-SNAPSHOT spreadsheets, oldest first.
  const snapshots = corruptionSnapshots_();

  // Tier 2 sources — closed value sets per enum column, DERIVED from the
  // clean values observed live + in snapshots (the app's legal sets live in
  // the frontend; clean data is the authoritative server-side mirror). A set
  // that grows past 40 distinct values is clearly not closed — disabled for
  // that run (fail-safe: manual instead of a guess).
  // Tier 3 sources — the roster: every clean person name live + in snapshots.
  const enumSets = {};
  const roster = {};
  targets.forEach(function (t) {
    t.enumCols.forEach(function (col) { if (!enumSets[col]) enumSets[col] = {}; });
    const addRow = function (obj) {
      t.enumCols.forEach(function (col) {
        const v = obj[col];
        if (v !== '' && v != null && typeof enumSets[col] === 'object' && enumSets[col] && !hasCorruption_(v)) enumSets[col][String(v)] = true;
      });
      const n = obj[t.nameCol];
      if (n !== '' && n != null && !hasCorruption_(n)) roster[String(n)] = true;
    };
    if (bySheet[t.sheet].rows) bySheet[t.sheet].rows.forEach(function (r) { addRow(r.obj); });
    snapshots.forEach(function (snap) {
      const srows = snapshotRows_(snap, t);
      if (srows) srows.forEach(addRow);
    });
  });
  Object.keys(enumSets).forEach(function (col) {
    if (Object.keys(enumSets[col]).length > 40) {
      try { Logger.log('enum tier disabled for column "' + col + '": ' + Object.keys(enumSets[col]).length + ' distinct values — not a closed set'); } catch (_) { /* no-op */ }
      enumSets[col] = null;
    }
  });

  // Cross-reference sources. (a) Leads-family rows by lead id — clean name +
  // phone; first clean hit wins. (b) normalized phone → clean name.
  const leadById = {};
  const phoneToName = {};
  [LEADS_SHEET, IRRELEVANT_LEADS_SHEET, REMOVED_LEADS_SHEET].forEach(function (name) {
    const entry = bySheet[name];
    if (!entry || !entry.rows) return;
    entry.rows.forEach(function (r) {
      const id = String(r.obj.id == null ? '' : r.obj.id).trim();
      const leadName = String(r.obj.name == null ? '' : r.obj.name);
      const cleanName = leadName !== '' && !hasCorruption_(leadName);
      if (id && !leadById[id]) {
        leadById[id] = { name: leadName, cleanName: cleanName, phone: r.obj.phone };
      }
      if (cleanName) {
        entry.target.phoneCols.forEach(function (pc) {
          const key = corruptionPhoneKey_(r.obj[pc]);
          if (key && !phoneToName[key]) phoneToName[key] = leadName;
        });
      }
    });
  });

  // (c) clean same-fromLead Patients twins, per column.
  const patientsEntry = bySheet[PATIENTS_SHEET];
  const patientsByFromLead = {};
  if (patientsEntry && patientsEntry.rows) {
    patientsEntry.rows.forEach(function (r) {
      const fl = String(r.obj.fromLead == null ? '' : r.obj.fromLead).trim();
      if (!fl) return;
      if (!patientsByFromLead[fl]) patientsByFromLead[fl] = [];
      patientsByFromLead[fl].push(r);
    });
  }

  const cells = [];
  targets.forEach(function (t) {
    const entry = bySheet[t.sheet];
    if (!entry.rows) return; // sheet absent — nothing to scan
    entry.rows.forEach(function (r) {
      t.textCols.forEach(function (col) {
        const v = r.obj[col];
        if (!hasCorruption_(v)) return;
        const finding = { sheet: t.sheet, row: r.rowNumber, column: col,
                          value: String(v), proposal: 'no source — manual', source: '', newValue: '' };
        const leadId = t.leadIdCol ? String(r.obj[t.leadIdCol] == null ? '' : r.obj[t.leadIdCol]).trim() : '';

        // #105 tier (a): clean same-fromLead Patients twin — same column.
        if (t.sheet === PATIENTS_SHEET && leadId && patientsByFromLead[leadId]) {
          const twin = patientsByFromLead[leadId].find(function (tw) {
            const tv = tw.obj[col];
            return tw.rowNumber !== r.rowNumber && tv !== '' && tv != null && !hasCorruption_(tv);
          });
          if (twin) {
            finding.proposal = 'repair from twin';
            finding.source = t.sheet + ' row ' + twin.rowNumber;
            finding.newValue = String(twin.obj[col]);
            cells.push(finding);
            return;
          }
        }
        // #105 tier (b): the Leads-family row with the same lead id — name
        // column only. (A corrupted Leads row can never propose itself: its
        // own name fails the clean check.)
        if (col === t.nameCol && leadId &&
            leadById[leadId] && leadById[leadId].cleanName) {
          finding.proposal = 'repair from lead';
          finding.source = 'lead ' + leadId;
          finding.newValue = leadById[leadId].name;
          cells.push(finding);
          return;
        }
        // TIER 1: snapshot repair — ALL text columns (notes included).
        // Snapshots in priority order (oldest-modified first); the first
        // snapshot with an unambiguously matched row holding a clean value in
        // this column decides. Compatibility guard: the corrupted value's
        // surviving characters must appear in order within the proposal
        // (U+FFFD runs = 1+ chars) — an incompatible value means the matched
        // row is not this row's history, so tier 1 terminates as manual
        // rather than letting weaker tiers guess.
        if (t.snapshotKey !== 'none') {
          let done = false;
          for (let s = 0; s < snapshots.length && !done; s++) {
            const m = snapshotMatch_(snapshots[s], t, r.obj);
            if (m.status === 'ambiguous') {
              try { Logger.log('snapshot "' + snapshots[s].name + '": ' + m.count + ' candidate rows for ' + t.sheet + ' row ' + r.rowNumber + ' — ambiguous, no snapshot proposal'); } catch (_) { /* no-op */ }
              done = true; // identity unclear — do not shop other snapshots
              break;
            }
            if (m.status !== 'match') continue;
            const sv = m.row[col];
            if (sv === undefined || sv === '' || sv == null || hasCorruption_(sv)) continue; // column absent/empty/corrupted in this snapshot — try the next one
            if (corruptionPatternMatches_(v, sv)) {
              finding.proposal = 'repair from snapshot';
              finding.source = snapshots[s].name;
              finding.newValue = String(sv);
            } else {
              finding.proposal = 'snapshot mismatch — manual';
              finding.source = snapshots[s].name;
              try { Logger.log('snapshot "' + snapshots[s].name + '" value "' + sv + '" is INCOMPATIBLE with corrupted "' + v + '" (' + t.sheet + ' row ' + r.rowNumber + ' [' + col + ']) — manual'); } catch (_) { /* no-op */ }
            }
            done = true;
          }
          if (finding.newValue || finding.proposal === 'snapshot mismatch — manual') {
            cells.push(finding);
            return;
          }
        }
        // #105 tier (c): a clean row elsewhere sharing this row's phone —
        // name column only.
        if (col === t.nameCol) {
          const phones = [];
          t.phoneCols.forEach(function (pc) {
            const key = corruptionPhoneKey_(r.obj[pc]);
            if (key) phones.push(key);
          });
          if (phones.length === 0 && leadId && leadById[leadId]) {
            const key = corruptionPhoneKey_(leadById[leadId].phone);
            if (key) phones.push(key);
          }
          for (let p = 0; p < phones.length; p++) {
            const candidate = phoneToName[phones[p]];
            if (candidate && !hasCorruption_(candidate) && candidate !== String(v)) {
              finding.proposal = 'repair from phone match';
              finding.source = 'phone ' + phones[p];
              finding.newValue = candidate;
              break;
            }
          }
          if (finding.newValue) { cells.push(finding); return; }
        }
        // TIER 2: closed-set (enum) columns — the corrupted value's surviving
        // characters must match exactly ONE legal value; 0 or 2+ → manual.
        if (t.enumCols.indexOf(col) >= 0 && enumSets[col]) {
          const hit = corruptionMatchExactlyOne_(v, enumSets[col]);
          if (hit) {
            finding.proposal = 'repair from enum';
            finding.source = 'enum:' + col;
            finding.newValue = hit;
            cells.push(finding);
            return;
          }
        }
        // TIER 3: roster of clean names (name columns only) — exactly one.
        if (col === t.nameCol) {
          const hit = corruptionMatchExactlyOne_(v, roster);
          if (hit) {
            finding.proposal = 'repair from roster';
            finding.source = 'roster';
            finding.newValue = hit;
            cells.push(finding);
            return;
          }
          // Tier-3 bonus: corrupted-twin merge — a same-fromLead Patients row
          // corrupted in DIFFERENT positions whose union reconstructs the
          // full clean string.
          if (t.sheet === PATIENTS_SHEET && leadId && patientsByFromLead[leadId]) {
            for (let w = 0; w < patientsByFromLead[leadId].length; w++) {
              const tw = patientsByFromLead[leadId][w];
              if (tw.rowNumber === r.rowNumber) continue;
              const merged = mergeCorruptedTwins_(v, tw.obj[col]);
              if (merged) {
                finding.proposal = 'repair from twin-merge';
                finding.source = t.sheet + ' rows ' + r.rowNumber + '+' + tw.rowNumber;
                finding.newValue = merged;
                break;
              }
            }
            if (finding.newValue) { cells.push(finding); return; }
          }
        }
        cells.push(finding);
      });
    });
  });

  // Duplicate-pair analysis (Patients only). Delete is proposed ONLY for the
  // exact-duplicate signature: same fromLead + houseId + entryDate + status,
  // one side corrupted and the other clean. A pair differing in entryDate or
  // status is the READMISSION pattern (e.g. released 2026-01-12 + active
  // 2026-08-15) — never a delete candidate: repair only, keep both.
  const deletes = [];
  const keepBoth = [];
  Object.keys(patientsByFromLead).forEach(function (fl) {
    const group = patientsByFromLead[fl];
    if (group.length < 2) return;
    const describe = group.map(function (g) {
      return { row: g.rowNumber, name: String(g.obj.name), houseId: String(g.obj.houseId),
               date: asISODate_(g.obj.date), status: String(g.obj.status) };
    });
    if (group.length > 2) {
      keepBoth.push({ fromLead: fl, rows: describe, reason: 'more than 2 rows — manual review' });
      return;
    }
    const a = group[0], b = group[1];
    const aCor = hasCorruption_(a.obj.name), bCor = hasCorruption_(b.obj.name);
    const exactTwin = String(a.obj.houseId) === String(b.obj.houseId) &&
                      asISODate_(a.obj.date) === asISODate_(b.obj.date) &&
                      String(a.obj.status) === String(b.obj.status);
    if (exactTwin && aCor !== bCor) {
      const bad = aCor ? a : b;
      deletes.push({ row: bad.rowNumber, name: String(bad.obj.name), houseId: String(bad.obj.houseId),
                     date: asISODate_(bad.obj.date), fromLead: fl });
    } else if (aCor || bCor) {
      keepBoth.push({ fromLead: fl, rows: describe,
        reason: exactTwin ? 'both corrupted — repair only' : 'entryDate/status differ (readmission pattern) — repair only, keep both' });
    }
  });

  let proposed = 0;
  for (let i = 0; i < cells.length; i++) { if (cells[i].newValue) proposed++; }
  return {
    cells: cells,
    deletes: deletes,
    keepBoth: keepBoth,
    snapshots: snapshots.map(function (s) { return s.name; }),
    summary: { corruptedCells: cells.length, proposedRepairs: proposed,
               proposedDeletes: deletes.length, keepBothPairs: keepBoth.length },
  };
}

/* DRY RUN — run from the Apps Script editor. READ-ONLY (getSheetByName only;
 * cannot even create a sheet): scans every target sheet/column for U+FFFD and
 * Logger.logs each hit with its PROPOSED action and source, plus the
 * duplicate-pair verdicts. NOTHING is written; use writeRepairPlanNow to turn
 * these proposals into the reviewable RepairPlan sheet. */
function scanCorruptedRowsNow() {
  const res = corruptionScan_();
  if (res.snapshots.length > 0) {
    Logger.log('snapshots in use (priority order, oldest-modified first): ' + res.snapshots.join(', '));
  } else {
    Logger.log('NO SNAPSHOT FOUND — no spreadsheet named "EZONE-SNAPSHOT…" is visible to this script. ' +
      'Tier 1 (snapshot repair) is inactive; enum + roster tiers still ran. Create one via ' +
      'File → Version history → Make a copy, named starting with EZONE-SNAPSHOT.');
  }
  res.cells.forEach(function (c) {
    Logger.log('CORRUPTED ' + c.sheet + ' row ' + c.row + ' [' + c.column + '] "' + c.value + '" → ' +
      c.proposal + (c.newValue ? ' ("' + c.newValue + '" from ' + c.source + ')' : ''));
  });
  res.deletes.forEach(function (d) {
    Logger.log('DUPLICATE-TWIN ' + PATIENTS_SHEET + ' row ' + d.row + ' "' + d.name + '" (fromLead ' + d.fromLead +
      ') is an exact corrupted duplicate of a clean twin → proposed delete corrupted twin');
  });
  res.keepBoth.forEach(function (k) {
    Logger.log('KEEP-BOTH fromLead ' + k.fromLead + ': ' + k.reason + ' — ' + JSON.stringify(k.rows));
  });
  Logger.log('scanCorruptedRowsNow: ' + res.summary.corruptedCells + ' corrupted cell(s), ' +
    res.summary.proposedRepairs + ' with an auto-proposed repair, ' +
    res.summary.proposedDeletes + ' proposed delete(s), ' + res.summary.keepBothPairs +
    ' keep-both pair(s). NO WRITES performed.');
  return res;
}

/* Populate the hidden RepairPlan sheet from the scan, every row with
 * approved=FALSE — Sandra reviews, edits newValue where the scan found no
 * source, and flips approved to TRUE per row she wants executed. FULL
 * REWRITE on each run (write-then-trim), so re-running RESETS approvals —
 * run it once, review, apply. Writes ONLY to RepairPlan. */
function writeRepairPlanNow() {
  const res = corruptionScan_();
  const sh = getOrCreateSheet_(REPAIR_PLAN_SHEET, REPAIR_PLAN_COLUMNS);
  try { if (!sh.isSheetHidden()) sh.hideSheet(); } catch (_) { /* no-op */ }

  const planRows = [];
  res.cells.forEach(function (c) {
    // `source` records the winning tier (plus the snapshot's name when tier 1
    // fired) so Sandra can weigh each proposal's provenance while approving.
    planRows.push(objectToRow_({ sheet: c.sheet, row: c.row, column: c.column,
      newValue: c.newValue, action: 'repair', approved: 'FALSE', oldValue: c.value,
      source: c.proposal + (c.proposal === 'repair from snapshot' ? ' (' + c.source + ')' : '') }, REPAIR_PLAN_COLUMNS));
  });
  res.deletes.forEach(function (d) {
    planRows.push(objectToRow_({ sheet: PATIENTS_SHEET, row: d.row, column: 'name',
      newValue: '', action: 'delete', approved: 'FALSE', oldValue: d.name,
      source: 'delete corrupted twin' }, REPAIR_PLAN_COLUMNS));
  });

  const lastRow = sh.getLastRow();
  if (planRows.length > 0) {
    sh.getRange(2, 1, planRows.length, REPAIR_PLAN_COLUMNS.length).setValues(planRows);
  }
  if (lastRow > planRows.length + 1) {
    sh.getRange(planRows.length + 2, 1, lastRow - planRows.length - 1, REPAIR_PLAN_COLUMNS.length).clearContent();
  }
  Logger.log('writeRepairPlanNow: wrote ' + planRows.length + ' plan row(s) (' + res.cells.length +
    ' repair, ' + res.deletes.length + ' delete), ALL approved=FALSE. Review the hidden RepairPlan sheet, ' +
    'fill any blank newValue, flip approved to TRUE per row, then run applyCorruptedRowRepairsNow.');
  return planRows.length;
}

/* Execute ONLY the approved=TRUE rows of RepairPlan, under the script lock.
 * Repairs run before deletes (a delete rewrites the Patients sheet and
 * shifts row numbers; the drift guard would then rightly skip stale rows).
 *   repair — re-verify the target cell still holds EXACTLY oldValue AND that
 *            it is still corrupted; then write newValue to that single cell.
 *            Any mismatch (drift), unknown sheet/column, or blank newValue →
 *            SKIP + log, touch nothing.
 *   delete — Patients only. The stored row number is only a hint: the name
 *            cell there must still equal oldValue; the row is then deleted BY
 *            IDENTITY through deletePatientRow_ (peek → tombstone fail-hard →
 *            write-then-trim), so history is preserved and a shifted sheet
 *            can never delete the wrong row.
 * Every applied change is audit-logged (corruption_repair /
 * corruption_delete, old→new in details) — fail-soft as always. */
function applyCorruptedRowRepairsNow() {
  const lock = LockService.getScriptLock();
  lock.tryLock(10000);
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const planSh = ss.getSheetByName(REPAIR_PLAN_SHEET);
    if (!planSh) {
      Logger.log('applyCorruptedRowRepairsNow: no RepairPlan sheet — run writeRepairPlanNow first.');
      return { applied: 0, deleted: 0, skipped: 0 };
    }
    const lastRow = planSh.getLastRow();
    if (lastRow < 2) {
      Logger.log('applyCorruptedRowRepairsNow: RepairPlan is empty.');
      return { applied: 0, deleted: 0, skipped: 0 };
    }
    const values = planSh.getRange(2, 1, lastRow - 1, REPAIR_PLAN_COLUMNS.length).getValues();
    const plan = values.map(function (row) {
      const obj = {};
      for (let j = 0; j < REPAIR_PLAN_COLUMNS.length; j++) obj[REPAIR_PLAN_COLUMNS[j]] = row[j];
      return obj;
    }).filter(function (p) {
      return String(p.approved).toUpperCase() === 'TRUE';
    });

    const targetsBySheet = {};
    corruptionScanTargets_().forEach(function (t) { targetsBySheet[t.sheet] = t; });

    let applied = 0, deleted = 0, skipped = 0;
    const skip = function (p, why) {
      skipped++;
      Logger.log('SKIP ' + p.action + ' ' + p.sheet + ' row ' + p.row + ' [' + p.column + ']: ' + why);
    };

    const repairs = plan.filter(function (p) { return String(p.action) === 'repair'; });
    const deletes = plan.filter(function (p) { return String(p.action) === 'delete'; });
    plan.filter(function (p) { return String(p.action) !== 'repair' && String(p.action) !== 'delete'; })
      .forEach(function (p) { skip(p, 'unknown action "' + p.action + '"'); });

    repairs.forEach(function (p) {
      const target = targetsBySheet[String(p.sheet)];
      if (!target) return skip(p, 'unknown sheet');
      const colIdx = target.columns.indexOf(String(p.column));
      if (colIdx < 0) return skip(p, 'unknown column');
      const rowNum = Number(p.row);
      if (!isFinite(rowNum) || rowNum < 2) return skip(p, 'bad row number');
      const newValue = String(p.newValue == null ? '' : p.newValue);
      if (newValue === '' || hasCorruption_(newValue)) return skip(p, 'newValue blank or corrupted — fill it in before approving');
      const sh = ss.getSheetByName(target.sheet);
      if (!sh) return skip(p, 'sheet missing');
      const cell = sh.getRange(rowNum, colIdx + 1, 1, 1);
      const current = String(cell.getValue());
      if (current !== String(p.oldValue) || !hasCorruption_(current)) {
        return skip(p, 'cell no longer holds the expected corrupted value (row drift or already repaired)');
      }
      cell.setValue(newValue);
      applied++;
      logAudit_('corruption_repair', 'applyCorruptedRowRepairsNow', '', newValue, { sheet: target.sheet, row: rowNum, column: String(p.column), oldValue: current, newValue: newValue });
    });

    deletes.forEach(function (p) {
      if (String(p.sheet) !== PATIENTS_SHEET) return skip(p, 'delete is only supported for the Patients sheet');
      const rowNum = Number(p.row);
      if (!isFinite(rowNum) || rowNum < 2) return skip(p, 'bad row number');
      const sh = ss.getSheetByName(PATIENTS_SHEET);
      if (!sh) return skip(p, 'Patients sheet missing');
      if (rowNum > sh.getLastRow()) return skip(p, 'row beyond sheet (drift)');
      const rowVals = sh.getRange(rowNum, 1, 1, PATIENT_COLUMNS.length).getValues()[0];
      const obj = {};
      for (let j = 0; j < PATIENT_COLUMNS.length; j++) obj[PATIENT_COLUMNS[j]] = rowVals[j];
      if (String(obj.name) !== String(p.oldValue) || !hasCorruption_(String(obj.name))) {
        return skip(p, 'row no longer holds the expected corrupted name (row drift or already handled)');
      }
      // Identity-keyed delete: tombstone fail-hard first, then write-then-trim
      // — exactly deletePatientRow_'s contract. Row number was only the hint.
      const res = deletePatientRow_({ houseId: obj.houseId, name: obj.name, date: obj.date });
      if (!res || res.ok !== true) return skip(p, 'delete refused: ' + ((res && res.error) || 'unknown'));
      deleted++;
      logAudit_('corruption_delete', 'applyCorruptedRowRepairsNow', String(obj.fromLead || ''), String(obj.name), { key: res.key, deleted: res.deleted, oldValue: String(p.oldValue) });
    });

    Logger.log('applyCorruptedRowRepairsNow: ' + applied + ' repair(s) applied, ' + deleted +
      ' delete(s) applied, ' + skipped + ' skipped. Approved rows only; see AuditLog for the trail.');
    return { applied: applied, deleted: deleted, skipped: skipped };
  } finally {
    try { lock.releaseLock(); } catch (_) { /* no-op */ }
  }
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

    // Safe sequence: peek → append → delete. The old UNCONDITIONAL
    // append-before-delete meant a blank-id lead (whose client-side random id
    // matches nothing here) left a phantom "removed" row AND the still-present
    // active row — the lead reappeared on reload.
    //   1. Peek FIRST (countRowsById_, read-only): 0 matches → refuse, touch
    //      NOTHING. The client surfaces the error and rolls back; getData_
    //      backfills blank ids on read, so after one reload the retry carries
    //      a real id and matches.
    //   2. Append to the removed sheet — BEFORE the delete, so if the append
    //      throws the active row is still intact (nothing is ever lost).
    //   3. Delete the matched row(s) from Leads.
    // All three steps run under the script lock, so no writer can slip between
    // the peek and the delete.
    if (countRowsById_(leadsSh, LEAD_COLUMNS, lead.id) < 1) {
      return { ok: false, error: 'lead_id_not_found' };
    }
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
    logAudit_('patient_discharged', 'dischargePatient_', record.fromLead || record.id || '', record.name || '', { id: record.id, houseId: record.houseId || '', disposition: record.disposition || '' });
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

    logAudit_('patient_restored_to_lead', 'restorePatient_', patient.fromLead || patient.id, patient.name || '', { id: patient.id, newLeadId: restored.id });
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
    logAudit_('patient_restored_active', 'restorePatientToActive_', patient.fromLead || patient.id, patient.name || '', { id: patient.id });
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

/* ===== Meeting reports (PR 2 — manager form endpoint) =====
 *
 * House managers report what happened in a lead meeting from a standalone
 * mobile page (served by the Railway proxy at /meeting-report). Two actions,
 * both fail-closed behind MEETING_REPORT_SECRET — a Script Property mirroring
 * the ADMITTED_ROSTER_SECRET discipline: unset or mismatched secret means
 * refuse, never serve. The proxy injects the secret server-side (POST body,
 * never a URL), so it never reaches a browser. */
const MEETING_REPORT_SECRET_PROP = 'MEETING_REPORT_SECRET';

function meetingReportAuthOk_(params) {
  const expected = PropertiesService.getScriptProperties().getProperty(MEETING_REPORT_SECRET_PROP);
  // Fail closed: no secret configured → refuse (never serve lead data open).
  if (!expected) return false;
  const got = (params && params.secret) ? String(params.secret) : '';
  return got === expected;
}

/* The stable outcome keys a report may carry — must match
 * MEETING_REPORT_OUTCOME_LABELS in public/app.js (PR 1). */
const MEETING_REPORT_OUTCOMES = ['advancing', 'undecided', 'not_fit', 'no_show'];

/* Preset companion keys — must match MEETING_COMPANION_LABELS in public/app.js
 * (PR 1). A companion value outside this list is the אחר flow: raw free text,
 * stored as-is (capped at 100 chars by validation). */
const MEETING_COMPANION_KEYS =
  ['mother', 'father', 'parents', 'partner', 'sibling', 'friend', 'alone', 'other'];

/* An "open" lead is a row of the Leads sheet still in the pipeline: admitted
 * leads (kept on the sheet with stage 'admitted' so the Patients record owns
 * them) and any stray irrelevant-stage rows are closed. The stage cell may
 * hold a stable id or a legacy Hebrew label — cover both, mirroring the
 * STAGE_ALIASES treatment in app.js. */
function isOpenLeadStage_(stage) {
  const s = String(stage == null ? '' : stage).trim();
  const closed = ['admitted', 'נקלט', 'אושפז', 'irrelevant', 'לא רלוונטי', 'לא_רלוונטי'];
  return closed.indexOf(s) === -1;
}

/* Open leads from the Leads sheet, unfiltered columns. */
function openLeads_() {
  const sh = getOrCreateSheet_(LEADS_SHEET, LEAD_COLUMNS);
  return readSheet_(sh, LEAD_COLUMNS).filter(function (l) {
    return l && isOpenLeadStage_(l.stage);
  });
}

/* meetingReportLeads — the minimal picker list for the reporting form. ONLY
 * { id, name, house, visitDate } per lead: no phones, no notes, no contact or
 * billing fields, deliberately — the reporting PIN must expose as little as
 * possible. visitDate is normalized to YYYY-MM-DD (asISODate_) so the form's
 * "visited already" filter can compare plain strings. */
function meetingReportLeads_() {
  const leads = openLeads_().map(function (l) {
    return {
      id:        l.id == null ? '' : String(l.id),
      name:      l.name || '',
      house:     l.house || '',
      visitDate: asISODate_(l.visitDate),
    };
  });
  return { ok: true, leads: leads };
}

/* submitMeetingReport — validate and persist one meeting report onto its lead
 * row. Payload: { leadId, outcome, companion, note, reporter }. Rejects (never
 * partially writes) on: unknown/closed leadId, outcome outside
 * MEETING_REPORT_OUTCOMES, companion free text over 100 chars, note over 2000
 * chars, or a blank/oversized reporter. On success the five report fields are
 * written via upsertRowById_ (read-merge-write: the full existing row is
 * preserved, only the meeting-report fields change) and meetingSeen resets to
 * '' so Vered's PR-3 view surfaces the new report as unseen. A resubmission
 * for the same lead overwrites the previous report — last write wins. */
function submitMeetingReport_(report) {
  if (!report || typeof report !== 'object') {
    return { ok: false, error: 'bad_request', message: 'missing report payload' };
  }
  const leadId    = report.leadId    == null ? '' : String(report.leadId).trim();
  const outcome   = report.outcome   == null ? '' : String(report.outcome).trim();
  const companion = report.companion == null ? '' : String(report.companion).trim();
  const note      = report.note      == null ? '' : String(report.note);
  const reporter  = report.reporter  == null ? '' : String(report.reporter).trim();

  if (!leadId) return { ok: false, error: 'bad_lead', message: 'leadId is required' };
  if (MEETING_REPORT_OUTCOMES.indexOf(outcome) === -1) {
    return { ok: false, error: 'bad_outcome', message: 'outcome must be one of ' + MEETING_REPORT_OUTCOMES.join('|') };
  }
  // Preset key, or the אחר flow: raw free text capped at 100 chars.
  if (MEETING_COMPANION_KEYS.indexOf(companion) === -1 && companion.length > 100) {
    return { ok: false, error: 'bad_companion', message: 'companion free text is limited to 100 chars' };
  }
  if (note.length > 2000) {
    return { ok: false, error: 'bad_note', message: 'note is limited to 2000 chars' };
  }
  if (!reporter || reporter.length > 100) {
    return { ok: false, error: 'bad_reporter', message: 'reporter is required (max 100 chars)' };
  }

  const leads = openLeads_();
  let lead = null;
  for (let i = 0; i < leads.length; i++) {
    if (String(leads[i].id) === leadId) { lead = leads[i]; break; }
  }
  if (!lead) return { ok: false, error: 'lead_not_found', message: 'no open lead with that id' };

  // Read-merge-write: upsertRowById_ replaces the ENTIRE row from the object,
  // so start from the lead as read and change only the report fields.
  const reportedAt = new Date().toISOString(); // plain-text column ('@'), read back verbatim
  lead.meetingReportOutcome = outcome;
  lead.meetingCompanion     = companion;
  lead.meetingNote          = note;
  lead.meetingReporter      = reporter;
  lead.meetingReportedAt    = reportedAt;
  lead.meetingSeen          = ''; // new/updated report → unseen for Vered (PR 3)

  const sh = getOrCreateSheet_(LEADS_SHEET, LEAD_COLUMNS);
  upsertRowById_(sh, LEAD_COLUMNS, lead);

  // Read-back verification: a confirmation screen must mean the report is ON
  // THE SHEET, not merely that no exception was thrown. Re-read the row and
  // require the exact reportedAt just stamped; anything else is a silent write
  // failure surfaced as an explicit error the form shows the manager.
  const after = readSheet_(sh, LEAD_COLUMNS);
  let persisted = null;
  for (let j = 0; j < after.length; j++) {
    if (String(after[j].id) === leadId) { persisted = after[j]; break; }
  }
  if (!persisted || asTimestampText_(persisted.meetingReportedAt) !== reportedAt) {
    return {
      ok: false,
      error: 'write_verify_failed',
      message: 'the report did not land on the Leads sheet — nothing was saved',
    };
  }

  return {
    ok: true,
    saved: {
      leadId: leadId,
      outcome: outcome,
      companion: companion,
      reporter: reporter,
      reportedAt: reportedAt,
    },
  };
}

/* deleteMeetingReport — Vered removes a manager's report from a lead (PR 4).
 * A DASHBOARD action (dispatched without the MEETING_REPORT_SECRET, like
 * saveAll/removeLead — the session-authed proxy is the trust boundary), not a
 * manager-form action. Clearing the six fields client-side through saveAll
 * cannot work since the merge guard: the sheet's non-empty reportedAt beats
 * the incoming empty one and the report resurrects. So the delete clears the
 * fields DIRECTLY on the sheet row (read-merge-write via upsertRowById_,
 * whole row preserved), after which the guard treats the row as report-less
 * and stale echoes can no longer bring the report back (differing timestamp →
 * sheet wins). Idempotent: deleting a report-less lead is ok:true. Verifies
 * the write landed, mirroring submitMeetingReport_. */
function deleteMeetingReport_(leadId) {
  const id = leadId == null ? '' : String(leadId).trim();
  if (!id) return { ok: false, error: 'bad_lead', message: 'leadId is required' };

  const lock = LockService.getScriptLock();
  lock.tryLock(10000);
  try {
    const sh = getOrCreateSheet_(LEADS_SHEET, LEAD_COLUMNS);
    const rows = readSheet_(sh, LEAD_COLUMNS);
    let lead = null;
    for (let i = 0; i < rows.length; i++) {
      if (String(rows[i].id) === id) { lead = rows[i]; break; }
    }
    if (!lead) return { ok: false, error: 'lead_not_found', message: 'no lead with that id' };

    MEETING_REPORT_LEAD_FIELDS.forEach(function (f) { lead[f] = ''; });
    upsertRowById_(sh, LEAD_COLUMNS, lead);

    // Read-back verification — ok must mean the report is OFF the sheet.
    const after = readSheet_(sh, LEAD_COLUMNS);
    for (let j = 0; j < after.length; j++) {
      if (String(after[j].id) === id) {
        if (asTimestampText_(after[j].meetingReportedAt) !== '') {
          return { ok: false, error: 'write_verify_failed', message: 'the report is still on the Leads sheet' };
        }
        break;
      }
    }

    return { ok: true, deleted: { leadId: id } };
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

/* ===== Billing overrides ===== */

/* Deterministic id for a (patientId, month) override — the single row-key both
 * the upsert and the delete resolve against. Mirrors billingOverrideId() in
 * app.js exactly; the client normally sends the id, but building it here too
 * keeps the server robust to a client that only sends patientId+month. */
function billingOverrideId_(patientId, month) {
  return 'ovr::' + patientId + '::' + month;
}

/**
 * Upsert a single billing-amount override by (patientId, month) — one override
 * per patient per month, so re-writing the same pair REPLACES the amount rather
 * than appending. Keyed on the deterministic id above. `month` must be 'YYYY-MM'.
 * The month + amount cells of the target row are set to plain text BEFORE the
 * write (belt-and-suspenders over the whole-column format getOrCreateSheet_
 * already applies) so Sheets can't coerce them.
 */
function upsertBillingOverride_(override) {
  if (!override || typeof override !== 'object') {
    return { ok: false, error: 'missing_override' };
  }
  const patientId = String(override.patientId == null ? '' : override.patientId).trim();
  const month     = String(override.month == null ? '' : override.month).trim();
  if (!patientId) return { ok: false, error: 'missing_patientId' };
  if (!/^\d{4}-\d{2}$/.test(month)) return { ok: false, error: 'bad_month' };

  const amount = Number(override.amount);
  if (!isFinite(amount) || amount < 0) return { ok: false, error: 'bad_amount' };

  const id = override.id ? String(override.id) : billingOverrideId_(patientId, month);
  const record = {
    id:        id,
    patientId: patientId,
    month:     month,
    amount:    amount,
    created:   override.created ? String(override.created) : todayISODate_(),
  };

  const lock = LockService.getScriptLock();
  lock.tryLock(10000);
  try {
    const sh = getOrCreateSheet_(BILLING_OVERRIDES_SHEET, BILLING_OVERRIDE_COLUMNS);
    const idIdx     = BILLING_OVERRIDE_COLUMNS.indexOf('id');
    const monthIdx  = BILLING_OVERRIDE_COLUMNS.indexOf('month');
    const amountIdx = BILLING_OVERRIDE_COLUMNS.indexOf('amount');
    const row = objectToRow_(record, BILLING_OVERRIDE_COLUMNS);
    const lastRow = sh.getLastRow();

    if (lastRow > 1) {
      const existingIds = sh.getRange(2, idIdx + 1, lastRow - 1, 1).getValues();
      for (let i = 0; i < existingIds.length; i++) {
        if (String(existingIds[i][0]) === String(id)) {
          const r = i + 2;
          sh.getRange(r, monthIdx + 1, 1, 1).setNumberFormat('@');
          sh.getRange(r, amountIdx + 1, 1, 1).setNumberFormat('@');
          sh.getRange(r, 1, 1, BILLING_OVERRIDE_COLUMNS.length).setValues([row]);
          return { ok: true, override: record, updated: true };
        }
      }
    }

    // Insert at the next row (not appendRow) so the text format lands BEFORE the
    // value — the same ordering upsertRowById_ relies on.
    const target = sh.getLastRow() + 1;
    sh.getRange(target, monthIdx + 1, 1, 1).setNumberFormat('@');
    sh.getRange(target, amountIdx + 1, 1, 1).setNumberFormat('@');
    sh.getRange(target, 1, 1, BILLING_OVERRIDE_COLUMNS.length).setValues([row]);
    return { ok: true, override: record, created: true };
  } finally {
    try { lock.releaseLock(); } catch (_) { /* no-op */ }
  }
}

/**
 * Delete a billing override, restoring the patient's base amount for that month.
 * Resolves the row by id — either the explicit `id` or one rebuilt from
 * (patientId, month). Reuses deleteRowsById_ (the established per-row delete).
 */
function deleteBillingOverride_(override) {
  if (!override || typeof override !== 'object') {
    return { ok: false, error: 'missing_override' };
  }
  let id = override.id ? String(override.id) : '';
  if (!id) {
    const patientId = String(override.patientId == null ? '' : override.patientId).trim();
    const month     = String(override.month == null ? '' : override.month).trim();
    if (!patientId || !month) return { ok: false, error: 'missing_id' };
    id = billingOverrideId_(patientId, month);
  }

  const lock = LockService.getScriptLock();
  lock.tryLock(10000);
  try {
    const sh = getOrCreateSheet_(BILLING_OVERRIDES_SHEET, BILLING_OVERRIDE_COLUMNS);
    deleteRowsById_(sh, BILLING_OVERRIDE_COLUMNS, id);
    return { ok: true, deleted: true, id: id };
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
 *   house       — canonical house id: ramot | raanana | efroni | rehab | pardes
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
 * HOUSES: only the canonical houses are exported (ramot, raanana, efroni,
 * rehab, and — since 2026-08 — pardes). The dashboard's internal house ids
 * (and their Hebrew display names) map to canonical ids below; houses outside
 * the canonical set (sde, anything unknown) are excluded, not renamed.
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
const DIGEST_CANONICAL_HOUSES = { ramot: true, raanana: true, efroni: true, rehab: true, pardes: true };

/* Dashboard internal house id → canonical digest house id. pardes (added
 * 2026-08) uses the same id on both sides. sde is intentionally ABSENT so it
 * resolves to '' and is excluded from the feed. */
const DIGEST_INTERNAL_TO_CANONICAL = {
  asher:  'raanana',
  ramot:  'ramot',
  arfoni: 'efroni',
  rehab:  'rehab',
  pardes: 'pardes',
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
 * outside the exported houses. */
function canonicalDigestHouse_(rawHouse) {
  if (rawHouse === undefined || rawHouse === null) return '';
  const s = String(rawHouse).trim();
  if (!s) return '';
  if (DIGEST_CANONICAL_HOUSES[s]) return s;                 // already canonical
  if (DIGEST_INTERNAL_TO_CANONICAL[s]) return DIGEST_INTERNAL_TO_CANONICAL[s]; // internal id
  const internal = DIGEST_HOUSE_NAME_TO_INTERNAL[s];        // Hebrew display name
  if (internal) return DIGEST_INTERNAL_TO_CANONICAL[internal] || '';
  return '';                                                // sde / unknown → excluded
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
 * פעיל) and their house maps to one of the canonical houses. `nowIso` is
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
    if (!house) continue; // outside the canonical houses
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
 * reason it was excluded (unknown/absent house, or a house outside the
 * canonical set). This is what makes the previously-silent exclusions visible.
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

/* ===== Nightly integrity job (detection + backup) ===========================
 *
 * Second layer of defense after the merge-don't-drop guard (PR #96): a
 * time-driven job (~2:30 AM, project timezone Asia/Jerusalem — pinned in
 * appsscript.json; offset from the outpatient app's 2:00 job so the two
 * never load Drive/Sheets at the same minute) that DETECTS silent
 * patient-row loss and keeps a daily off-spreadsheet backup, independent of
 * any save path. Mirror of the outpatient app's nightlyIntegrityJob adapted
 * to this app's data model: Patients rows have NO id column — identity is
 * the triple key houseId::name::entryDate (patientKey_), and recorded
 * removals live in the PatientsTombstones sheet (any reason: 'user-delete'
 * or 'saveAll-omitted-preserved').
 *
 * READ-ONLY contract: this job NEVER writes to the live Patients / Leads /
 * Payments / BillingOverrides / PatientsTombstones sheets — not even a
 * header backfill, which is why every live read goes through getSheetByName
 * (never getOrCreateSheet_). Its only writes are Script Properties, the
 * separate EZONE-Backups spreadsheet, and the alert email.
 *
 * Three checks, in a FIXED ORDER (locked by test/nightly-integrity.test.js):
 *   1. Patient-roster sentinel — the previous run's full key list (chunked
 *      Script Properties) vs the live Patients keys; a key gone WITHOUT a
 *      PatientsTombstones entry is the silent-loss signature. Discharge is a
 *      status flip (dischargePatient_ is append-only to the audit sheet) and
 *      a client rename appends a new-key row while the merge KEEPS the old
 *      one, so deletePatientRow_ — which tombstones fail-hard BEFORE
 *      deleting — is the ONLY legitimate row removal; no other whitelist
 *      exists. Runs BEFORE check 3 so a same-day snapshot overwrite can
 *      never mask what yesterday's backup still holds.
 *   2. Orphan sweep — every Payments row and BillingOverrides row keyed to a
 *      patient (patientId column = the same triple key, healed from the
 *      deterministic row id when blank, mirroring app.js normalizePayment /
 *      normalizeBillingOverride) must match a live Patients row or a
 *      tombstone; unmatched → alert.
 *   3. Daily snapshot — values-only copies of Patients AND Leads (covers the
 *      lead-resurrection blind spot for cheap) into the SAME EZONE-Backups
 *      spreadsheet the outpatient job owns: stored id first, then DriveApp
 *      lookup BY NAME, and only if truly absent SpreadsheetApp.create. One
 *      sheet per day per source ('dashboard-patients-YYYY-MM-DD' /
 *      'dashboard-leads-YYYY-MM-DD'); retention deletes ONLY names strictly
 *      matching those dashboard- prefixes and older than 30 days — the
 *      outpatient app's 'outpatient-*' sheets and any other tab are
 *      untouchable by construction.
 *
 * Alerting: ONE email per run, ONLY when something is wrong (no daily
 * noise), to the ALERT_EMAIL Script Property (a per-project property — set
 * it in THIS project even though the outpatient project has its own).
 * Fail-open: no property / send failure → Logger.log, never throw.
 *
 * Install once by running setupIntegrityTrigger() from the editor. */

/* Previous-run roster keys, chunked: the full key list is JSON already
 * ~6.6KB UTF-8 at 144 rows and grows monotonically (released rows stay on
 * the sheet), so a single property would cross the ~9KB per-value limit.
 * INTEGRITY_LAST_PATIENT_KEYS_CHUNKS holds the chunk count; the JSON string
 * is split across INTEGRITY_LAST_PATIENT_KEYS_0..N-1. 3000 chars per chunk
 * stays under 9KB even if every char is a 3-byte code point. */
const INTEGRITY_PROP_KEY_CHUNK_COUNT  = 'INTEGRITY_LAST_PATIENT_KEYS_CHUNKS';
const INTEGRITY_PROP_KEY_CHUNK_PREFIX = 'INTEGRITY_LAST_PATIENT_KEYS_';
const INTEGRITY_KEY_CHUNK_CHARS       = 3000;
const INTEGRITY_PROP_LAST_RUN    = 'INTEGRITY_LAST_RUN';
const INTEGRITY_PROP_BACKUP_SSID = 'INTEGRITY_BACKUP_SSID';
const INTEGRITY_PROP_ALERT_EMAIL = 'ALERT_EMAIL';
const INTEGRITY_BACKUP_NAME      = 'EZONE-Backups';
const INTEGRITY_RETENTION_DAYS   = 30;
const INTEGRITY_ALERT_SUBJECT    = '⚠️ E-ZONE Dashboard: אי-התאמה בנתוני מטופלים';
/* Snapshot sheet names are app-prefixed: EZONE-Backups is SHARED with the
 * outpatient app's job ('outpatient-YYYY-MM-DD' sheets), so each app's
 * snapshots and retention must never collide. Keep the prefixes and the
 * STRICT matcher in sync — the round-trip test locks them together. */
const INTEGRITY_PATIENTS_SNAPSHOT_PREFIX = 'dashboard-patients-';
const INTEGRITY_LEADS_SNAPSHOT_PREFIX    = 'dashboard-leads-';
const INTEGRITY_SNAPSHOT_RE = /^dashboard-(?:patients|leads)-(\d{4})-(\d{2})-(\d{2})$/;

/* ---- pure helpers (no GAS services — exercised directly by node --test) ---- */

/* Re-key a stored triple ('houseId::name::YYYY-MM-DD', from a payments /
 * overrides patientId cell or a persisted snapshot) through patientKey_ so
 * both sides of every comparison share trimming + date normalization. The
 * date is the LAST segment (a name containing '::' keeps working); anything
 * with fewer than 3 segments is returned trimmed — it can never match a
 * live key, which is exactly the alert we want for a malformed cell. */
function integrityNormalizeKey_(key) {
  const parts = String(key == null ? '' : key).split('::');
  if (parts.length < 3) return String(key == null ? '' : key).trim();
  return patientKey_(parts[0], parts.slice(1, parts.length - 1).join('::'), parts[parts.length - 1]);
}

/* Keys present in the previous run's list but absent from the current one.
 * Both sides normalized; blanks ignored. */
function integrityDiffMissingKeys_(prevKeys, currentKeys) {
  const cur = {};
  for (let i = 0; i < (currentKeys || []).length; i++) {
    const ck = integrityNormalizeKey_(currentKeys[i]);
    if (ck) cur[ck] = true;
  }
  const missing = [];
  const seen = {};
  for (let j = 0; j < (prevKeys || []).length; j++) {
    const pk = integrityNormalizeKey_(prevKeys[j]);
    if (pk && !cur[pk] && !seen[pk]) { seen[pk] = true; missing.push(pk); }
  }
  return missing;
}

/* patientId out of a Payments row id — 'pay::<houseId>::<name>::<date>::<dueDate>'
 * (paymentId() in app.js). Mirrors the parts.slice(1, 4) heal in
 * normalizePayment. Non-conforming → '' (caller falls back nowhere: the
 * patientId column is authoritative and this parse is ITS fallback). */
function integrityParsePaymentPatientId_(paymentId) {
  const parts = String(paymentId == null ? '' : paymentId).split('::');
  if (parts.length < 5 || parts[0] !== 'pay') return '';
  return parts.slice(1, 4).join('::');
}

/* patientId out of a BillingOverrides row id — 'ovr::<patientId>::<YYYY-MM>'
 * where <patientId> is itself the triple (billingOverrideId() in app.js), so
 * the month is the LAST segment and the id has exactly 5. */
function integrityParseOverridePatientId_(overrideId) {
  const parts = String(overrideId == null ? '' : overrideId).split('::');
  if (parts.length < 5 || parts[0] !== 'ovr') return '';
  return parts.slice(1, parts.length - 1).join('::');
}

/* Unique normalized patient keys across `rows` with NEITHER a live Patients
 * row NOR a tombstone. Key resolution mirrors app.js: the patientId column
 * wins, a blank cell is healed by parsing the row id via parseIdFn. Rows
 * that yield no key at all are skipped (nothing to attribute). */
function integrityOrphanKeys_(rows, parseIdFn, liveKeySet, tombstoneKeySet) {
  const seen = {};
  const orphans = [];
  for (let i = 0; i < (rows || []).length; i++) {
    const row = rows[i] || {};
    let pid = row.patientId == null ? '' : String(row.patientId).trim();
    if (!pid) pid = parseIdFn(row.id);
    if (!pid) continue;
    const key = integrityNormalizeKey_(pid);
    if (!key || seen[key]) continue;
    seen[key] = true;
    if (!liveKeySet[key] && !tombstoneKeySet[key]) orphans.push(key);
  }
  return orphans;
}

/* '<prefix>YYYY-MM-DD' from a Date's LOCAL parts — the runtime clock is the
 * project timezone (Asia/Jerusalem), so the day rolls at local midnight. */
function integritySnapshotName_(prefix, date) {
  const m = date.getMonth() + 1;
  const d = date.getDate();
  return prefix + date.getFullYear() +
    '-' + (m < 10 ? '0' + m : String(m)) +
    '-' + (d < 10 ? '0' + d : String(d));
}

/* Retention date math over SHEET NAMES. Strict: only names matching the
 * dashboard- prefixed snapshot format can ever expire — every other sheet
 * (the outpatient app's outpatient-* snapshots, a manual tab, a malformed
 * name) is untouchable. Expired = strictly older than retentionDays days
 * before today's snapshot name. */
function integrityIsExpiredSnapshot_(sheetName, todayName, retentionDays) {
  const m = INTEGRITY_SNAPSHOT_RE.exec(String(sheetName == null ? '' : sheetName));
  if (!m) return false;
  const t = INTEGRITY_SNAPSHOT_RE.exec(String(todayName == null ? '' : todayName));
  if (!t) return false;
  const ageDays = (Date.UTC(+t[1], +t[2] - 1, +t[3]) - Date.UTC(+m[1], +m[2] - 1, +m[3])) / 86400000;
  return ageDays > retentionDays;
}

/* Split a string into fixed-size slices ('' → no chunks). Pure counterpart
 * of the chunked key-list storage. */
function integritySplitChunks_(str, size) {
  const out = [];
  const s = String(str == null ? '' : str);
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size));
  return out;
}

/* 'houseId — name — entryDate' for the alert body — the triple disambiguates
 * duplicate names; a non-triple string is shown as-is. */
function integrityKeyDisplay_(key) {
  const parts = String(key == null ? '' : key).split('::');
  if (parts.length < 3) return String(key == null ? '' : key);
  return parts[0] + ' — ' + parts.slice(1, parts.length - 1).join('::') + ' — ' + parts[parts.length - 1];
}

/* Hebrew alert body from a plain report object (pure — unit-tested). */
function integrityAlertBody_(report) {
  const lines = [];
  lines.push('בדיקת שלמות הנתונים הלילית (nightlyIntegrityJob) מצאה אי-התאמות:');
  if (report.missing && report.missing.length) {
    lines.push('');
    lines.push('שורות מטופלים שנעלמו מגיליון Patients ללא רישום ב-PatientsTombstones:');
    for (let i = 0; i < report.missing.length; i++) {
      lines.push('  • ' + integrityKeyDisplay_(report.missing[i]));
    }
    lines.push('מספר שורות בריצה הקודמת: ' + report.prevCount + ' | מספר נוכחי: ' + report.currentCount);
  }
  if (report.orphanPayments && report.orphanPayments.length) {
    lines.push('');
    lines.push('תשלומים (Payments) ללא שורת מטופל חיה וללא רישום ב-PatientsTombstones:');
    for (let j = 0; j < report.orphanPayments.length; j++) {
      lines.push('  • ' + integrityKeyDisplay_(report.orphanPayments[j]));
    }
  }
  if (report.orphanOverrides && report.orphanOverrides.length) {
    lines.push('');
    lines.push('עקיפות חיוב (BillingOverrides) ללא שורת מטופל חיה וללא רישום ב-PatientsTombstones:');
    for (let k = 0; k < report.orphanOverrides.length; k++) {
      lines.push('  • ' + integrityKeyDisplay_(report.orphanOverrides[k]));
    }
  }
  if (report.errors && report.errors.length) {
    lines.push('');
    lines.push('שגיאות פנימיות במהלך הבדיקה:');
    for (let e = 0; e < report.errors.length; e++) {
      lines.push('  • ' + report.errors[e]);
    }
  }
  return lines.join('\n');
}

/* ---- Script Properties chunk store (props-only — testable with a fake) ---- */

/* Persist the full key list as JSON split across chunk properties, then
 * delete any stale higher-numbered chunks a previously longer list left
 * behind (probe until the first gap — chunks are always written densely). */
function integrityStoreKeys_(props, keys) {
  const chunks = integritySplitChunks_(JSON.stringify(keys || []), INTEGRITY_KEY_CHUNK_CHARS);
  for (let i = 0; i < chunks.length; i++) {
    props.setProperty(INTEGRITY_PROP_KEY_CHUNK_PREFIX + i, chunks[i]);
  }
  props.setProperty(INTEGRITY_PROP_KEY_CHUNK_COUNT, String(chunks.length));
  for (let j = chunks.length; ; j++) {
    if (props.getProperty(INTEGRITY_PROP_KEY_CHUNK_PREFIX + j) === null) break;
    props.deleteProperty(INTEGRITY_PROP_KEY_CHUNK_PREFIX + j);
  }
}

/* Previous run's key list, or null when there is no usable snapshot (first
 * run, a missing chunk, corrupt JSON). null tells the sentinel to SKIP the
 * diff — never to treat "no baseline" as "everything vanished". */
function integrityLoadKeys_(props) {
  const countRaw = props.getProperty(INTEGRITY_PROP_KEY_CHUNK_COUNT);
  if (countRaw === null) return null;
  const count = Number(countRaw);
  if (!isFinite(count) || count < 0) return null;
  let json = '';
  for (let i = 0; i < count; i++) {
    const chunk = props.getProperty(INTEGRITY_PROP_KEY_CHUNK_PREFIX + i);
    if (chunk === null) return null;
    json += chunk;
  }
  try {
    const keys = JSON.parse(json || '[]');
    return Array.isArray(keys) ? keys : null;
  } catch (_) {
    return null;
  }
}

/* ---- GAS-facing helpers (backup spreadsheet only — never the live one) ---- */

/* Open the shared backup spreadsheet WITHOUT creating it: stored id first,
 * then a DriveApp lookup by name (the outpatient app's job may already own
 * EZONE-Backups — creating a second one would fork the backups), persisting
 * a found id. null → check 3 may create as a last resort. */
function integrityOpenBackupSpreadsheet_(props, errors) {
  const ssid = props.getProperty(INTEGRITY_PROP_BACKUP_SSID);
  if (ssid) {
    try { return SpreadsheetApp.openById(ssid); }
    catch (err) { errors.push('פתיחת גיליון הגיבוי (' + ssid + ') נכשלה: ' + err); }
  }
  try {
    const files = DriveApp.getFilesByName(INTEGRITY_BACKUP_NAME);
    while (files.hasNext()) {
      const file = files.next();
      if (file.isTrashed()) continue;
      const ss = SpreadsheetApp.openById(file.getId());
      props.setProperty(INTEGRITY_PROP_BACKUP_SSID, ss.getId());
      return ss;
    }
  } catch (err) { errors.push('חיפוש גיליון הגיבוי בדרייב נכשל: ' + err); }
  return null;
}

/* Write a values-only snapshot into the BACKUP spreadsheet (only — never the
 * live one). Idempotent for a same-day re-run: an existing sheet with the
 * name is cleared and rewritten in place (never deleted first, so this also
 * works when it is the spreadsheet's only sheet). */
function integrityWriteSnapshot_(backupSs, snapName, grid) {
  let sh = backupSs.getSheetByName(snapName);
  if (sh) sh.clear();
  else sh = backupSs.insertSheet(snapName);
  if (grid && grid.length) {
    sh.getRange(1, 1, grid.length, grid[0].length).setValues(grid);
  }
  // A just-created backup spreadsheet's default sheet is dead weight once a
  // snapshot exists; drop it (guarded — never a snapshot, never the last sheet).
  const def = backupSs.getSheetByName('Sheet1') || backupSs.getSheetByName('גיליון1');
  if (def && !INTEGRITY_SNAPSHOT_RE.test(def.getName()) && backupSs.getSheets().length > 1) {
    backupSs.deleteSheet(def);
  }
  return sh;
}

/* Delete OUR expired snapshot sheets from the backup spreadsheet. Strictly
 * name-matched via integrityIsExpiredSnapshot_ — the outpatient app's
 * sheets and any non-conforming name can never be selected; never deletes
 * the last remaining sheet (Sheets requires >= 1). */
function integrityApplyRetention_(backupSs, todayName, retentionDays) {
  const sheets = backupSs.getSheets();
  const deleted = [];
  for (let i = 0; i < sheets.length; i++) {
    if (backupSs.getSheets().length <= 1) break;
    const name = sheets[i].getName();
    if (integrityIsExpiredSnapshot_(name, todayName, retentionDays)) {
      backupSs.deleteSheet(sheets[i]);
      deleted.push(name);
    }
  }
  return deleted;
}

/* One email per run, only when called (i.e. something is wrong). Fail-open:
 * no ALERT_EMAIL property, or a send failure → Logger.log the report and
 * return false; NEVER throw (an alerting failure must not kill the job). */
function integritySendAlert_(body) {
  let email = '';
  try {
    email = PropertiesService.getScriptProperties().getProperty(INTEGRITY_PROP_ALERT_EMAIL) || '';
  } catch (_) { /* fall through to the log-only path */ }
  if (!email) {
    Logger.log('INTEGRITY ALERT (no ' + INTEGRITY_PROP_ALERT_EMAIL + ' Script Property — email not sent):\n' + body);
    return false;
  }
  try {
    MailApp.sendEmail(email, INTEGRITY_ALERT_SUBJECT, body);
    return true;
  } catch (err) {
    Logger.log('INTEGRITY ALERT send failed (' + err + '):\n' + body);
    return false;
  }
}

/* The nightly trigger handler. Each check runs in its own try/catch so one
 * failure never silences the others; internal errors join the alert. */
function nightlyIntegrityJob() {
  const props = PropertiesService.getScriptProperties();
  const errors = [];

  // ---- read-only reads of the live data (getSheetByName, NEVER
  //      getOrCreateSheet_: this job must not write to Patients / Leads /
  //      Payments / BillingOverrides, not even a header backfill) ----
  let patientRows = [], patientsGrid = null, patientsReadOk = false;
  try {
    const patientsSh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(PATIENTS_SHEET);
    if (patientsSh) {
      patientRows = readSheet_(patientsSh, PATIENT_COLUMNS);
      patientsGrid = patientsSh.getDataRange().getValues();
    }
    patientsReadOk = true;
  } catch (err) { errors.push('קריאת Patients נכשלה: ' + err); }

  let leadsGrid = null;
  try {
    const leadsSh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(LEADS_SHEET);
    if (leadsSh) leadsGrid = leadsSh.getDataRange().getValues();
  } catch (err) { errors.push('קריאת Leads נכשלה: ' + err); }

  let paymentRows = [];
  try {
    const paymentsSh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(PAYMENTS_SHEET);
    if (paymentsSh) paymentRows = readSheet_(paymentsSh, PAYMENT_COLUMNS);
  } catch (err) { errors.push('קריאת Payments נכשלה: ' + err); }

  let overrideRows = [];
  try {
    const overridesSh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(BILLING_OVERRIDES_SHEET);
    if (overridesSh) overrideRows = readSheet_(overridesSh, BILLING_OVERRIDE_COLUMNS);
  } catch (err) { errors.push('קריאת BillingOverrides נכשלה: ' + err); }

  // A tombstone with ANY reason ('user-delete' or 'saveAll-omitted-preserved')
  // means the disappearance was RECORDED — only an unrecorded one alerts.
  const tombstoneKeySet = {};
  try {
    const tombSh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(PATIENTS_TOMBSTONES_SHEET);
    const tombs = tombSh ? readSheet_(tombSh, PATIENT_TOMBSTONE_COLUMNS) : [];
    for (let t = 0; t < tombs.length; t++) {
      const tk = patientKey_(tombs[t].houseId, tombs[t].name, tombs[t].date);
      if (tk) tombstoneKeySet[tk] = true;
    }
  } catch (err) { errors.push('קריאת PatientsTombstones נכשלה: ' + err); }

  const currentKeys = [], liveKeySet = {};
  for (let c = 0; c < patientRows.length; c++) {
    const key = patientKey_(patientRows[c].houseId, patientRows[c].name, patientRows[c].date);
    if (key && key !== '::::') { currentKeys.push(key); liveKeySet[key] = true; }
  }

  // ---- CHECK 1: patient-roster sentinel (ALWAYS before the check-3 snapshot
  //      overwrite — yesterday's backup must still hold the missing rows) ----
  let missing = [];
  let prevKeys = null;
  try {
    prevKeys = integrityLoadKeys_(props);
    if (patientsReadOk && prevKeys) {
      const gone = integrityDiffMissingKeys_(prevKeys, currentKeys);
      for (let m = 0; m < gone.length; m++) {
        if (!tombstoneKeySet[gone[m]]) missing.push(gone[m]);
      }
    }
  } catch (err) { errors.push('בדיקת רשימת המטופלים נכשלה: ' + err); }

  // ---- CHECK 2: orphan sweep (Payments + BillingOverrides) ----
  let orphanPayments = [], orphanOverrides = [];
  try {
    orphanPayments = integrityOrphanKeys_(paymentRows, integrityParsePaymentPatientId_, liveKeySet, tombstoneKeySet);
  } catch (err) { errors.push('בדיקת תשלומים יתומים נכשלה: ' + err); }
  try {
    orphanOverrides = integrityOrphanKeys_(overrideRows, integrityParseOverridePatientId_, liveKeySet, tombstoneKeySet);
  } catch (err) { errors.push('בדיקת עקיפות חיוב יתומות נכשלה: ' + err); }

  // ---- CHECK 3: daily snapshot + retention (AFTER check 1) ----
  try {
    if ((patientsGrid && patientsGrid.length) || (leadsGrid && leadsGrid.length)) {
      // Lookup (stored id, then Drive BY NAME) BEFORE any create — the
      // outpatient job already owns EZONE-Backups; never fork a second one.
      let backupSs = integrityOpenBackupSpreadsheet_(props, errors);
      if (!backupSs) {
        backupSs = SpreadsheetApp.create(INTEGRITY_BACKUP_NAME);
        props.setProperty(INTEGRITY_PROP_BACKUP_SSID, backupSs.getId());
      }
      const now = new Date();
      const todayPatientsName = integritySnapshotName_(INTEGRITY_PATIENTS_SNAPSHOT_PREFIX, now);
      if (patientsGrid && patientsGrid.length) {
        integrityWriteSnapshot_(backupSs, todayPatientsName, patientsGrid);
      }
      if (leadsGrid && leadsGrid.length) {
        integrityWriteSnapshot_(backupSs, integritySnapshotName_(INTEGRITY_LEADS_SNAPSHOT_PREFIX, now), leadsGrid);
      }
      const deletedNames = integrityApplyRetention_(backupSs, todayPatientsName, INTEGRITY_RETENTION_DAYS);
      if (deletedNames.length) Logger.log('nightlyIntegrityJob: retention deleted %s', deletedNames.join(', '));
    }
  } catch (err) { errors.push('הגיבוי היומי נכשל: ' + err); }

  // ---- alert: one email per run, ONLY when something is wrong ----
  if (missing.length || orphanPayments.length || orphanOverrides.length || errors.length) {
    integritySendAlert_(integrityAlertBody_({
      missing: missing,
      orphanPayments: orphanPayments,
      orphanOverrides: orphanOverrides,
      errors: errors,
      prevCount: prevKeys === null ? '?' : String(prevKeys.length),
      currentCount: String(currentKeys.length)
    }));
  } else {
    Logger.log('nightlyIntegrityJob: ok (patients=%s, payments=%s, overrides=%s)',
      String(currentKeys.length), String(paymentRows.length), String(overrideRows.length));
  }

  // ---- persist the sentinel state for tomorrow's run — but only off a
  //      SUCCESSFUL Patients read: seeding an empty list after a failed read
  //      would hide a real loss AND fire false orphan-style alerts later ----
  if (patientsReadOk) {
    integrityStoreKeys_(props, currentKeys);
    props.setProperty(INTEGRITY_PROP_LAST_RUN, new Date().toISOString());
  }
}

/* One-time installer (run from the Apps Script editor). Idempotent: deletes
 * every existing trigger bound to nightlyIntegrityJob before creating the
 * single daily ~2:30 AM trigger (project timezone: Asia/Jerusalem —
 * nearMinute(30) staggers this job off the outpatient app's 2:00 run; if the
 * runtime rejects it, plain atHour(2) is the accepted fallback). */
function setupIntegrityTrigger() {
  const triggers = ScriptApp.getProjectTriggers();
  for (let i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'nightlyIntegrityJob') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
  try {
    ScriptApp.newTrigger('nightlyIntegrityJob').timeBased().everyDays(1).atHour(2).nearMinute(30).create();
    return { ok: true, installed: 'nightlyIntegrityJob @ ~02:30' };
  } catch (_) {
    ScriptApp.newTrigger('nightlyIntegrityJob').timeBased().everyDays(1).atHour(2).create();
    return { ok: true, installed: 'nightlyIntegrityJob @ 02:00' };
  }
}
