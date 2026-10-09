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
 *   GET  ?action=getCredits                     → {ok, credits:[...]}
 *   POST action=saveCredit&credit=...            → {ok, credit, created|updated}
 *                                                 (credits/refunds ledger; id
 *                                                  minted server-side on create,
 *                                                  stale edits refused)
 *   GET  ?action=getAdmittedRoster&secret=...    → {ok, patients:[{sourceApp,name,phone,house}]}
 *                                                 (cross-app, read-only: currently-admitted
 *                                                  patients with phone recovered via fromLead)
 *   POST action=deletePatientRow&patient=...     → {ok, deleted, key, id, matchedBy}
 *                                                 (permanent patient-row delete by persisted
 *                                                  id, else by identity key; tombstones
 *                                                  BEFORE deleting)
 *
 * Merge semantics (important for the split-save path in server.js):
 *   - leads present and non-empty → upsert each lead by id; leads whose id is
 *     not in the payload are left untouched. This mirrors the patients
 *     per-houseId behavior and lets the server chunk leads into batches.
 *   - leads missing, empty string, null, or empty array → leave Leads untouched
 *   - patients: for every houseId key present in the payload, that house's
 *     rows are MERGED — by the persisted patient `id` first, else by the
 *     identity triple houseId::name::entryDate (patientKey_): matched rows
 *     are replaced (an id match survives a rename / entry-date edit in
 *     place), new rows appended, and sheet
 *     rows ABSENT from the payload are KEPT — never dropped by omission, so a
 *     stale tab can no longer clobber rows it never loaded. Every kept-but-
 *     omitted row is echoed per house in the response's `preserved` map and
 *     audited to the PatientsTombstones sheet. Houses NOT present in the
 *     payload are untouched.
 *   - a patient row carrying `movedFrom` (the ✏ modal's deliberate house
 *     move) is MOVED: its row leaves the old house and lands in the new one
 *     with the same id — or the move is refused with a reason in
 *     `conflicts[].move` (stale stamp / moved elsewhere / deleted) and nothing
 *     changes. Landed moves are echoed in `moved`; fresh who/when stamps the
 *     client did not hold yet in `stamps`. See replaceHousePatients_.
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
  // ONE getProperties() round trip instead of one getProperty() per manager
  // (this runs on every dashboard load). Same override rule either way; a
  // store without getProperties, or one that throws, falls back per key.
  var all = null;
  if (props && typeof props.getProperties === 'function') {
    try { all = props.getProperties() || null; } catch (_) { all = null; }
  }
  Object.keys(MANAGER_PHONES).forEach(function (name) {
    var key = 'MANAGER_PHONE_' + name;
    var override = all ? all[key] : (props ? props.getProperty(key) : null);
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
 *
 * `source` and `notes` were added after the initial release. Sheets that
 * pre-date this will be backfilled by getOrCreateSheet_ on the next read.
 *
 * `id` — PATIENT IDENTITY FOUNDATION (appended LAST; append-only contract,
 * getOrCreateSheet_ extends a live sheet's header non-destructively). A
 * stable, opaque per-row identifier ('id-…'), the first persisted identity a
 * Patients row has ever had. Until now the client minted a fresh session id
 * on every load and a row's only identity was the triple
 * houseId::name::entryDate (patientKey_) — which is why a rename or an
 * entry-date edit landed as a NEW row and why identical-key duplicates were
 * indistinguishable. Rules (locked by test/patient-identity-foundation.test.js):
 *   - minted server-side for any row that lacks one (getData_ backfill under
 *     the script lock; the saveAll merge for rows it writes or preserves)
 *     and ADOPTED from the client for a genuinely new row that carries one
 *     (the client already stamps cryptoId() on every new patient);
 *   - IMMUTABLE once on a row: a payload row that matches an existing sheet
 *     row keeps the SHEET's id whatever the payload carried — a stale tab's
 *     session id never overwrites a persisted one;
 *   - UNIQUE across the whole sheet: an incoming id already held by another
 *     row is re-minted for the incoming row (audited), never duplicated;
 *   - the triple key stays the FALLBACK identity for rows and payloads
 *     without an id (legacy tabs, cross-app writers) — nothing regresses.
 * Opaque 'id-' text: no Sheets coercion risk, so no whole-column format. */
/* Who/when stamps (APPENDED after `id`, append-only contract — never
 * insert/delete/reorder; guard-tested):
 *   updatedAt — ISO timestamp (server clock) of the last write that CHANGED
 *               the row. Text-forced at ensure time so Sheets never coerces.
 *   updatedBy — who made that change: the `user` the proxy injects into the
 *               request body FROM THE SIGNED SESSION COOKIE (never a
 *               client-supplied value). Blank for sessions whose cookie
 *               pre-dates the user field — allowed by contract. */
const PATIENT_COLUMNS = [
  'houseId', 'name', 'date', 'pay', 'adv',
  'status', 'fromLead', 'exitDate', 'source', 'notes',
  'id', 'updatedAt', 'updatedBy'
];

/* The SERVER-OWNED meta columns of PATIENT_COLUMNS — identity + stamps, not
 * content. patientRowDiffCols_ ignores them (an echo of stale stamps or an
 * ignored payload id must never read as an edit), and on a matched replace
 * the sheet's values win: only a real content change re-stamps them. */
const PATIENT_META_COLUMNS = ['id', 'updatedAt', 'updatedBy'];

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
 *                   'deletePatientRow')
 *   id            — the row's persisted patient id (appended LAST, after the
 *                   metadata, so the live tombstone sheet's layout is
 *                   untouched; blank on entries that pre-date the identity
 *                   foundation) */
/* updatedAt/updatedBy: appended after `id` (append-only). A tombstone
 * snapshots the row's own stamps — EXCEPT on a user delete, where
 * appendPatientTombstones_'s optional deleter overwrites them so the
 * tombstone answers "who deleted this and when". */
const PATIENT_TOMBSTONE_COLUMNS = [
  'houseId', 'name', 'date', 'pay', 'adv',
  'status', 'fromLead', 'exitDate', 'source', 'notes',
  'droppedAt', 'reason', 'savedByAction',
  'id', 'updatedAt', 'updatedBy'
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
 * shape: base columns + discharge-time metadata. The LEADING `id` is the
 * AUDIT row's own key (upsertRowById_ dedupes by it; the client mints a fresh
 * one per discharge). The Patients `id` column is deliberately EXCLUDED from
 * the base slice so the live sheet's positional layout stays byte-identical
 * to the pre-identity-foundation one (readSheet_ maps by position). */
/* `prior_status` (append-only, added with the restore-choice modal): the
 * patient's status at the MOMENT of discharge (active/trial/wait), captured by
 * the client's dischargeAuditRow before the released flip. Restore-to-previous-
 * status reads it; legacy rows have it blank and fall back to 'active'. */
/* NOW A FROZEN LITERAL, no longer derived from PATIENT_COLUMNS: the live
 * discharged sheet stores dischargedAt…prior_status at their current
 * positions, so a PATIENT_COLUMNS append must land at the END here — the
 * derive-by-concat form would have injected updatedAt/updatedBy MID-list
 * (reads and getOrCreateSheet_'s header-extend are positional). The legacy
 * prefix below is byte-identical to the derived list it replaces (Patients
 * `id` still excluded; the leading `id` is the audit row's own key); the
 * who/when stamps are appended LAST. Writes map by name via objectToRow_, so
 * this list and PATIENT_COLUMNS may diverge safely. */
const DISCHARGED_PATIENT_COLUMNS = [
  'id',
  'houseId', 'name', 'date', 'pay', 'adv',
  'status', 'fromLead', 'exitDate', 'source', 'notes',
  'dischargedAt', 'disposition', 'discharge_note', 'restored', 'prior_status',
  'updatedAt', 'updatedBy',
  // Coordinators discharge audit (APPENDED LAST, append-only — see
  // recordDischargeFromCoordinators_). Blank on every row the Dashboard's own
  // שחרר flow writes; set only by a discharge a coordinator recorded:
  //   dischargeSource — 'ezone-coordinators'
  //   dischargedBy    — the coordinator name the request carried (`by`)
  //   dischargeReason — the coordinator's free-text reason (cleaned, capped)
  //   patientId       — the persisted Patients `id` the discharge targeted
  'dischargeSource', 'dischargedBy', 'dischargeReason', 'patientId',
  // Duplicate-discharge soft delete (APPENDED LAST, append-only — see
  // deleteDuplicateDischarge_, CHANGELOG-duplicate-discharges.md). Blank on
  // every live row; set ONCE when a deleter removes a duplicate row:
  //   deletedAt    — ISO timestamp of the delete
  //   deletedBy    — the acting user (actorLabel_)
  //   deleteReason — the required reason (2–120 chars, cleaned)
  // A row with deletedAt set is not a discharge any more: it leaves the tab,
  // the heal, the duplicate guard and the refund forecast. It stays on the
  // sheet as the audit trail and is never physically removed.
  'deletedAt', 'deletedBy', 'deleteReason'
];

/* Payments sheet columns. `id` is a deterministic per-patient-per-due-date
 * string built by the client (see paymentId() in app.js) so the same monthly
 * payment always upserts into the same row instead of creating duplicates.
 *
 * APPEND-ONLY, same contract as LEAD_COLUMNS / CREDIT_COLUMNS: readSheet_
 * maps by POSITION, so inserting or reordering a column silently re-reads
 * every historical row against the wrong field. New columns go at the END.
 *
 * coverageStart / coverageEnd (appended) — the period the payment ACTUALLY
 * covers, as 'YYYY-MM-DD' text. Until these existed the period was inferred
 * from the due date plus "one month paid in advance", and nothing recorded
 * whether that was true. They are written on every save from the client's
 * default (the inferred cycle, so nothing changes) and editable when it was
 * wrong. BLANK IS LEGAL and is what every pre-existing row carries: readers
 * fall back to the inferred cycle (paymentCoverage() in app.js), so no old
 * row is ever rewritten. Validated on write by coveragePeriodError_(). */
/* ACCOUNTING SOURCE-DATA COLUMNS (appended at the END, append-only contract
 * above — the twelve existing columns keep their exact positions).
 *
 * These exist for ONE reason: an external accounting-control app has to be
 * able to say "this source payment is the one I already confirmed" without
 * re-deriving identity from data that legitimately changes (a corrected
 * patient name, a re-dated cycle, an edited amount all rewrite the `id`'s
 * inputs). Dashboard itself does not read them for any user-visible purpose.
 *
 *   paymentUid      — 'pmt-<uuid>', MINTED ONCE per row and then PERMANENT.
 *                     Never derived at read time, never re-minted, never
 *                     changed when patientName / dueDate / amount / status
 *                     change. Backfilled onto existing rows by
 *                     backfillPaymentIdentityLocked_ under the script lock
 *                     (the backfillPatientIdsLocked_ pattern, PR #112).
 *                     The existing `id` scheme is DELIBERATELY UNCHANGED:
 *                     billing overrides, the orphan-payments reconcile, the
 *                     integrity job and the client all still key on it.
 *   patientUid      — the PERSISTED Patients `id` (PATIENT_COLUMNS position
 *                     11). Resolved ONCE, by an EXACT match of this row's
 *                     `patientId` cell (the houseId::name::entryDate billing
 *                     triple) against the same triple computed from the
 *                     Patients sheet — never a name lookup, never a fuzzy or
 *                     partial match. Unresolvable → BLANK, never guessed.
 *   payerUid        — RESERVED AND ALWAYS BLANK. Dashboard has no payer /
 *                     billing-party entity: nothing records who actually pays
 *                     (a parent, a fund, a municipality). The column exists so
 *                     the accounting contract has a stable slot; the
 *                     accounting app needs its own explicit crosswalk. Payer
 *                     identity is NEVER inferred from a name here.
 *   chargedAt       — SERVER-generated Israel-time timestamp with an explicit
 *                     offset ('2026-09-22T14:03:11+03:00') of the moment the
 *                     row was REPORTED PAID (status paid/partial) by the
 *                     dashboard user. It means "reported paid by Vered",
 *                     NOT "confirmed in the bank" — the accounting app owns
 *                     bank confirmation and Dashboard stores none of it.
 *   chargedBy       — WHO reported it: requestUser_, i.e. the name inside the
 *                     SIGNED SESSION COOKIE (the PR #113 stamping rule). A
 *                     client-supplied user is never trusted, ever.
 *   sourceUpdatedAt — SERVER Israel-time stamp of the last write that actually
 *                     CHANGED the row's content. (`timestamp` is the client's
 *                     clock and moves on every save, so it cannot serve.)
 *   sourceVersion   — integer, incremented by that same write. 1 on the first
 *                     content write after this column landed.
 *
 * BLANK IS LEGAL on all seven and is what every pre-existing row carries
 * until it is next written. A blank sourceUpdatedAt marks a HISTORICAL row:
 * no charge stamp is ever invented for it, because nobody recorded when or by
 * whom it was reported. */
/* THE MANUAL LINK COLUMNS (appended after the accounting seven).
 *
 * `patientUid` above resolves a payment to a patient by an EXACT match of the
 * houseId::name::entryDate triple, and leaves the cell BLANK when it cannot —
 * deliberately, because a fuzzy match would put money on the wrong ledger.
 * That is the right default and it is not enough: the live sheet holds rows
 * the exact match will never resolve, because the triple itself is damaged.
 * "שחר חיון " carries a trailing space; "אביב שבתאי" carries invisible
 * characters; "ערן" and "עדי" are single words matching no patient row;
 * נועם אשבל moved ריהאב → הפרדס and her payment stayed on the ריהאב record.
 *
 * These five record what a PERSON decided about such a row:
 *
 *   linkPatientUid — the patient a human (or the client's normalized-triple
 *                    match) says this row belongs to. The ONLY client-writable
 *                    input to `patientUid`, validated here, and the only thing
 *                    that may override an automatic resolution — a person who
 *                    looked at the row beats a triple that did not parse.
 *   linkStatus     — '' (nobody has reviewed this row) | 'linked' |
 *                    'not_a_patient'.
 *   linkNote       — why it is not a patient row. REQUIRED for 'not_a_patient':
 *                    a dismissal nobody can audit is indistinguishable, a year
 *                    later, from a row nobody ever looked at.
 *   linkedBy       — WHO decided. SERVER-OWNED, from the signed session cookie.
 *   linkedAt       — WHEN. SERVER-OWNED, from the server clock.
 *
 * BLANK IS LEGAL on all five and is what every existing row carries. */
const PAYMENT_COLUMNS = [
  'id', 'patientId', 'patientName', 'houseId', 'dueDate',
  'amount', 'status', 'amountPaid', 'balance', 'timestamp',
  'coverageStart', 'coverageEnd',
  'paymentUid', 'patientUid', 'payerUid',
  'chargedAt', 'chargedBy', 'sourceUpdatedAt', 'sourceVersion',
  'linkPatientUid', 'linkStatus', 'linkNote', 'linkedBy', 'linkedAt',
  /* The strict payment report (Phase 3 PR 1, PAYMENT_REPORT_COLUMNS below). */
  'receivedDate', 'method', 'payer', 'funder', 'reference',
  'recordedBy', 'recordedAt',
  'confirmStatus', 'confirmedBy', 'confirmedAt', 'flagNote',
  /* One row per money received (Phase 3 PR 2, RECEIPT_ID_PREFIX below). */
  'legacyAmountPaid',
  /* The invoice choice on the report (PAYMENT_INVOICE_COLUMNS below). */
  'invoiceWanted', 'invoiceTo',
  /* Ortal's partial confirmation and her free-text note
   * (PAYMENT_CONTROL_COLUMNS below; CHANGELOG-ortal-billing-access.md). */
  'confirmedAmount', 'controlNote',
  /* The «דווח תשלום» form's idempotency key, on the receipt row it wrote
   * (CHANGELOG-payment-report-persistence.md). Server-owned, text-forced. */
  'submissionId'
];
const PAYMENT_LINK_STATUSES = ['linked', 'not_a_patient', 'duplicate'];

/* ===== The invoice on the payment report (CHANGELOG-payment-invoice.md) =====
 * Two columns APPENDED at the very end of PAYMENT_COLUMNS (append-only), both
 * text-forced:
 *   invoiceWanted  'yes' | 'no' — «חשבונית?». There is NO default: a report
 *                  without a choice is refused (invoice_choice_missing).
 *                  Blank on every row written before this change, and shown
 *                  as «—», never as כן or לא.
 *   invoiceTo      «על שם» — free text, 1–120 characters, required when
 *                  invoiceWanted is 'yes'; '' when 'no'. No control
 *                  character, no formula lead-in (= + @ -).
 * Written by reportPayment_ on the receipt; changed later only through
 * savePayment / updatePayment (paymentInvoiceFields_, the same rules), which
 * writes one AuditLog row (payment_invoice_changed). On a receipt this is the
 * one edit besides the void decision. lib/payment-report-rules.js mirrors
 * validatePaymentInvoice_ (parity-tested). */
const PAYMENT_INVOICE_COLUMNS = ['invoiceWanted', 'invoiceTo'];
const INVOICE_CHOICES = ['yes', 'no'];
const INVOICE_TO_MAX = 120;

/* ===== «בקרת גבייה» — partial confirmation + Ortal's note
 * (CHANGELOG-ortal-billing-access.md, Sandra 2026-10-06) =====
 * Two columns APPENDED at the very end of PAYMENT_COLUMNS (append-only):
 *   confirmedAmount  the money Ortal found in the bank for this receipt.
 *                    SERVER-OWNED, written ONLY by confirmPayment_:
 *                      confirmed → the full reported amount
 *                      partial   → 0 < x < the reported amount
 *                      reported / flagged → ''
 *                    Blank on a receipt confirmed before this change reads
 *                    as the full amount (receiptVerifiedAmount_).
 *   controlNote      Ortal's free-text note on the receipt, 0–500 characters,
 *                    editable at any time, SEPARATE from flagNote (the
 *                    required «לא שולם» reason). Text-forced; one line, no
 *                    control character, no formula lead-in.
 * savePayment / updatePayment never write either (upsertPayment_ pins both
 * to the stored row). Every change writes one AuditLog row with
 * at / by / prev / next — nothing is overwritten silently. */
const PAYMENT_CONTROL_COLUMNS = ['confirmedAmount', 'controlNote'];
/* The statuses confirmPayment_ accepts: CONFIRM_STATUSES + 'partial'
 * («שולם חלקית»). The savePayment path keeps CONFIRM_STATUSES (it cannot
 * carry an amount, so it can never set 'partial'). */
const CONTROL_STATUSES = ['reported', 'confirmed', 'partial', 'flagged'];
const CONTROL_NOTE_MAX = 500;

/* ===== The strict payment report — foundation (Phase 3 PR 1) =====
 * docs/billing-control-plan.md Phase 3, decided by Sandra 2026-10-04.
 * CHANGELOG-payment-report-foundation.md. Eleven columns APPENDED to
 * PAYMENT_COLUMNS (positions 25–35), all text-forced:
 *
 *   receivedDate  the day the money actually arrived, 'YYYY-MM-DD'
 *                 (Asia/Jerusalem). APPEND-ONLY: set once, never re-stamped by
 *                 the server, never erased by a blank; a deliberate change is
 *                 allowed and writes an AuditLog row (old, new, actor).
 *   method        PAYMENT_METHODS (Hebrew labels, stored as shown)
 *   payer         free text, who paid
 *   funder        PAYMENT_FUNDERS; filled from currentFunder_ on the first
 *                 report when the payload names none — and REFUSED
 *                 (funder_unset) when the patient has no funder either:
 *                 there is no default funder (CHANGELOG-patient-funder-on-funders.md)
 *   reference     transaction / cheque number
 *   recordedBy / recordedAt
 *                 SERVER-OWNED: the signed-session user and the server clock,
 *                 stamped once, when the row first gets a receivedDate
 *   confirmStatus 'reported' | 'confirmed' | 'flagged'. 'reported' on the
 *                 first report; any other write needs the verified
 *                 `controller` role (Ortal, Phase 4) or `approver` (Sandra)
 *   confirmedBy / confirmedAt
 *                 SERVER-OWNED, stamped when confirmStatus changes
 *   flagNote      why a payment was flagged (controller / approver only)
 *
 * PHASE 3 PR 2 (the form, live): money is reported ONLY through
 * action=reportPayment, which appends a receipt row (RECEIPT_ID_PREFIX) and
 * enforces validatePaymentReport_ in full — see reportPayment_. What follows
 * describes the savePayment path, which still works as below.
 *
 * FOUNDATION ONLY: a savePayment without these fields behaves exactly as
 * before. The required-field rules (validatePaymentReport_) are NOT enforced
 * on the save path yet — Phase 3 PR 2 wires the form. What IS enforced now,
 * because a bad value would otherwise land in the sheet: a value that CHANGES
 * one of these columns must be well-formed (a real, non-future date; a method
 * or funder from the list; a sane payer / reference), and the confirm fields
 * are refused (forbidden_role) to everyone but controller / approver.
 * lib/payment-report-rules.js mirrors validatePaymentReport_ for the form; a
 * parity test runs both on the same inputs. */
const PAYMENT_REPORT_COLUMNS = [
  'receivedDate', 'method', 'payer', 'funder', 'reference',
  'recordedBy', 'recordedAt',
  'confirmStatus', 'confirmedBy', 'confirmedAt', 'flagNote'
];
const PAYMENT_METHODS = ['העברה בנקאית', 'אשראי', "צ'ק", 'מזומן', 'ביט', 'אחר'];
const PAYMENT_FUNDERS = ['פרטי', 'ביטוח לאומי', 'משרד הביטחון', 'מכבי', 'פרו-בונו'];
/* Pro-bono (Sandra, 2026-10-05; CHANGELOG-funder-probono.md). APPENDED LAST:
 * the list is append-only. A patient whose funder on a cycle's start day is
 * pro-bono owes nothing for that cycle: debtAging_ drops it from byPatient,
 * byHouse and totals. Ortal's digest still lists every payment received,
 * whatever the funder (money received is always reported). A payment
 * report for such a patient is still allowed and still names its funder
 * explicitly (validatePaymentReport_; the savePayment fill path refuses
 * funder_probono_explicit instead of copying pro-bono onto the row). */
const FUNDER_PROBONO = 'פרו-בונו';
/* There is NO default funder (Sandra, 2026-10-04). A patient with no Funders
 * row — or whose effective row carries a label not in PAYMENT_FUNDERS — reads
 * as FUNDER_UNSET («לא הוגדר»): never guessed, never silently private. Listed
 * in the cleanup workbook as «חסר גורם מממן» and on the גבייה fill screen.
 * public/funder.js mirrors it (FUNDER_UNSET, LABEL_TO_KEY); a guard test pins
 * PAYMENT_FUNDERS to its labels and forbids any fallback to the private label. */
const FUNDER_UNSET = 'unset';
const REFERENCE_REQUIRED_METHODS = ['העברה בנקאית', "צ'ק"];
const CONFIRM_STATUSES = ['reported', 'confirmed', 'flagged'];
/* Mirrors COVERAGE_MAX_DAYS (declared further down; consts are not hoisted). */
const COVERAGE_MAX_DAYS_REPORT_ = 366;
const PAYMENT_REPORT_FIELDS = ['receivedDate', 'amount', 'method', 'payer', 'coverageStart', 'coverageEnd', 'funder', 'reference'];
const PAYER_MIN = 2;
const PAYER_MAX = 100;
const REFERENCE_MIN = 3;
const REFERENCE_MAX = 40;
const FLAG_NOTE_MIN = 2;
const FLAG_NOTE_MAX = 300;
/* The operation name a refused confirm write is logged under. Not in
 * DELETE_ACTIONS / APPROVER_ACTIONS: it needs controller OR approver, and the
 * decision needs the stored row, so upsertPayment_ makes it (like un-void). */
const CONFIRM_OPERATION = 'confirmPayment';
const PAYMENT_REPORT_MESSAGES = {
  received_date_missing: 'חסר: תאריך קבלת התשלום',
  received_date_invalid: 'תאריך קבלת התשלום לא תקין',
  received_date_future: 'תאריך קבלת התשלום לא יכול להיות בעתיד',
  amount_missing: 'חסר: סכום',
  amount_invalid: 'סכום לא תקין',
  amount_not_positive: 'הסכום חייב להיות גדול מאפס',
  method_missing: 'חסר: אמצעי תשלום',
  method_invalid: 'אמצעי תשלום לא מוכר',
  payer_missing: 'חסר: שם משלם',
  payer_invalid: 'שם משלם לא תקין',
  coverage_start_missing: 'חסר: תחילת תקופת הכיסוי',
  coverage_end_missing: 'חסר: סוף תקופת הכיסוי',
  coverage_invalid: 'תאריך לא תקין בתקופת הכיסוי',
  coverage_reversed: 'תאריך הסיום מוקדם מתאריך ההתחלה',
  coverage_too_long: 'תקופת כיסוי ארוכה מדי (המקסימום ' + COVERAGE_MAX_DAYS_REPORT_ + ' ימים)',
  funder_missing: 'חסר: גורם מממן',
  funder_invalid: 'גורם מממן לא מוכר',
  funder_unset: 'לא הוגדר גורם מממן למטופל — יש לבחור גורם מממן בדיווח או להגדיר אותו בכרטיס המטופל',
  funder_probono_explicit: 'המטופל פרו-בונו — יש לבחור גורם מממן בדיווח במפורש',
  reference_missing: "חסר: מספר אסמכתא (חובה בהעברה בנקאית ובצ'ק)",
  reference_invalid: 'מספר אסמכתא לא תקין',
  confirm_status_invalid: 'סטטוס אישור לא מוכר',
  confirm_without_report: 'אין דיווח תשלום לאשר — חסר תאריך קבלה',
  flag_note_missing: 'בסימון «בעיה» חובה לפרט (2 עד 300 תווים)',
  received_date_too_old: 'תאריך קבלה לפני יותר מ-90 יום — פנו לסנדרה',
  invoice_choice_missing: 'חסר: חשבונית? — יש לבחור כן או לא',
  invoice_choice_invalid: 'בחירת חשבונית לא תקינה — כן או לא בלבד',
  invoice_to_missing: 'חסר: על שם מי החשבונית',
  invoice_to_invalid: 'שם לחשבונית לא תקין — עד 120 תווים, לא מתחיל ב-= + - @',
};

/* Funders — the patient's funder over time. APPEND-ONLY (rows and columns):
 * a change is a new row with a later effectiveFrom, never an edit.
 *   patientId     the patient's stable id (Patients.id, 'id-<uuid>' — the
 *                 same value Payments.patientUid holds)
 *   funder        PAYMENT_FUNDERS
 *   effectiveFrom 'YYYY-MM-DD'
 *   setBy / setAt who and when (server-stamped by appendFunder_)
 * The current funder = the row with the latest effectiveFrom ≤ the date
 * (currentFunder_); none, or an unrecognized label on that row → FUNDER_UNSET. */
const FUNDERS_SHEET = 'Funders';
/* APPEND-ONLY. submissionId (CHANGELOG-write-path-hardening.md) is the
 * appending form's idempotency key — a retry of a lost answer replays the
 * stored row instead of appending a second one. Server-validated, LAST. */
const FUNDER_COLUMNS = ['patientId', 'funder', 'effectiveFrom', 'setBy', 'setAt', 'submissionId'];

/* ===== VOID =====
 * The status of a payment row that was entered TWICE — the patient renamed
 * after the first entry, the first row detached, the money recorded again
 * under the new name. THE ROW IS NEVER DELETED: it keeps its amount, its
 * amountPaid and its dates as the only evidence that the money was entered
 * twice rather than collected twice, and every figure in the client steps
 * over it (isVoidPayment in app.js).
 *
 * It must be ALIASED, not merely allowed: paymentStatus_ maps an unknown
 * status to 'unpaid', so a void row read back would silently un-void itself
 * and re-enter the accounting feed as money owed. */
const PAYMENT_VOID_STATUS = 'void';

/* Who may UNDO a void. Marking a duplicate is ordinary daily work; unmarking
 * one puts a second payment back into every revenue and debt figure, which is
 * a money decision. Since PR C (2026-10-04) the un-void is the APPROVER_ACTIONS
 * operation `unvoidPayment`: it needs the verified `approver` role (Sandra's
 * personal session only, hasRole_) AND this name, which comes from the SIGNED
 * SESSION COOKIE via requestUser_ — never from the request body. The client's
 * matching list only decides whether to offer the control. */
const PAYMENT_VOID_REVERSERS = ['סנדרה'];
const PAYMENT_LINK_NOTE_MAX = 300;
const PAYMENT_LINK_UID_MAX = 100;

/* SERVER-OWNED payment columns: upsertPayment_ DELETES whatever the payload
 * carries for these before writing, so a hand-built POST can never set its own
 * uid or claim a charge stamp. Mirrors PATIENT_META_COLUMNS' intent. */
const PAYMENT_SERVER_COLUMNS = [
  'paymentUid', 'patientUid', 'payerUid',
  'chargedAt', 'chargedBy', 'sourceUpdatedAt', 'sourceVersion',
  /* Who decided a link and when. The DECISION itself (linkPatientUid,
   * linkStatus, linkNote) is the client's to send — it is what a person chose
   * — but its provenance never is: a caller that can post a payment can post
   * any name and any date it likes. */
  'linkedBy', 'linkedAt',
  /* The part of a cycle's amountPaid recorded BEFORE its first receipt row
   * (Phase 3 PR 2). Set once, by reportPayment_, never from a payload. */
  'legacyAmountPaid',
  /* The report's idempotency key — written by reportPayment_ only. */
  'submissionId'
];

/* Columns that do NOT count as a content change when deciding whether to bump
 * sourceUpdatedAt / sourceVersion. `timestamp` is excluded because the client
 * restamps it on every save — including saves that change nothing — and a
 * version that ticks on every no-op would flood the accounting app's queue.
 * `patientUid` is deliberately NOT excluded: healing a blank patient link IS a
 * change the accounting app must see. */
const PAYMENT_VERSION_IGNORED_COLUMNS = [
  'paymentUid', 'payerUid', 'chargedAt', 'chargedBy',
  'sourceUpdatedAt', 'sourceVersion', 'timestamp'
];

/* The two payment statuses that mean money was reported as received. */
const PAYMENT_CHARGED_STATUSES = ['paid', 'partial'];

/* Legacy Hebrew status labels live on the sheet alongside the canonical keys
 * (the client has always canonicalized on READ via PAYMENT_STATUS_ALIASES in
 * app.js — this is the server mirror, and it MUST stay in sync). It matters
 * for more than display: without it a legacy 'שולם' row would read as
 * not-previously-paid, and an unrelated edit would stamp a charge time onto a
 * historical row that nobody ever reported. Unknown → 'unpaid'. */
const PAYMENT_STATUS_ALIASES_ = {
  'שולם': 'paid', 'paid': 'paid',
  'שולם חלקית': 'partial', 'partial': 'partial',
  'לא שולם': 'unpaid', 'unpaid': 'unpaid',
  'מבוטל': PAYMENT_VOID_STATUS, 'void': PAYMENT_VOID_STATUS,
};
function isVoidStatus_(raw) {
  return paymentStatus_(raw) === PAYMENT_VOID_STATUS;
}
function paymentStatus_(raw) {
  const t = String(raw == null ? '' : raw).trim();
  return PAYMENT_STATUS_ALIASES_[t] || PAYMENT_STATUS_ALIASES_[t.toLowerCase()] || 'unpaid';
}

const PAYMENT_UID_PREFIX = 'pmt-';
const CREDIT_UID_PREFIX  = 'crd-';
/* Longest period a single payment row may claim. Mirrors COVERAGE_MAX_DAYS in
 * app.js. A mistyped year would otherwise swallow a year of allocation. */
const COVERAGE_MAX_DAYS = 366;
/* The two coverage columns are plain 'YYYY-MM-DD' text and must stay that
 * way: a date-TYPED cell reads back as a Date, serializes as a UTC timestamp
 * and drifts the day −1 for Israel — the exact exitDate bug, and here it
 * would move money between months. Only the NEW columns are forced; the
 * existing ones keep whatever format they already have. */
/* `sourceVersion` is deliberately NOT text-forced — it is a small integer and
 * reads back as a number. Everything else appended is opaque text or an ISO
 * timestamp, the same coercion class as coverageStart/coverageEnd. */
const PAYMENT_TEXT_COLUMNS = [
  'coverageStart', 'coverageEnd',
  'paymentUid', 'patientUid', 'payerUid',
  'chargedAt', 'chargedBy', 'sourceUpdatedAt',
  /* The link columns, for the same reason patientUid is: a persisted id is an
   * opaque string, and one that happens to look like a date or a long number
   * is coerced by Sheets — on the very column that decides whose money a row
   * is. linkNote is text because it is text. */
  'linkPatientUid', 'linkStatus', 'linkNote', 'linkedBy', 'linkedAt',
  /* The payment report: a date, ids, a cheque number with leading zeros and
   * ISO stamps — every one of them something Sheets would coerce. */
  'receivedDate', 'method', 'payer', 'funder', 'reference',
  'recordedBy', 'recordedAt',
  'confirmStatus', 'confirmedBy', 'confirmedAt', 'flagNote',
  /* «חשבונית?» / «על שם» — free text; a name typed as =… must stay text. */
  'invoiceWanted', 'invoiceTo',
  /* Ortal's note — free text (confirmedAmount stays a number). */
  'controlNote',
  /* An opaque key — never a number or a date. */
  'submissionId'
];

/* PaymentsTombstones — the recoverable record of a DELETED Payments row.
 *
 * Nothing in the dashboard UI deletes a payment; the single delete path in the
 * whole repo is runOrphanPaymentsReconcile_'s stray-twin removal (a manual
 * repair run from the Apps Script editor). Until now that delete left only an
 * AuditLog entry, which no external reader can page through. The accounting
 * app has to be able to tell "this source record was deleted" apart from "this
 * source record was never in my window", so every such delete now also lands
 * here and is served by the accounting endpoint.
 *
 * APPEND-ONLY, same contract as every other sheet: new columns go at the END.
 *   paymentUid / sourceRecordId — the deleted row's stable uid and its `id`.
 *   deletedAt  — Israel-time ISO stamp with offset.
 *   deletedBy  — '' for a repair run from the editor (there is no signed
 *                session behind it); the function name travels in deletedByFn.
 *   reason     — why it was deleted.
 *   values     — compact JSON of the whole deleted row (PAYMENT_COLUMNS order),
 *                so the delete is recoverable. NEVER served by the endpoint. */
const PAYMENTS_TOMBSTONES_SHEET = 'PaymentsTombstones';
const PAYMENT_TOMBSTONE_COLUMNS = [
  'paymentUid', 'sourceRecordId', 'patientUid', 'houseId', 'dueDate',
  'amount', 'amountPaid', 'status',
  'deletedAt', 'deletedBy', 'deletedByFn', 'reason', 'values'
];
const PAYMENT_TOMBSTONE_TEXT_COLUMNS = [
  'paymentUid', 'sourceRecordId', 'patientUid', 'dueDate', 'deletedAt', 'deletedBy'
];
const PAYMENT_DELETE_REASON_STRAY_TWIN = 'orphan_reconcile_stray_twin';

/* BillingOverrides sheet columns. One row per (patientId, month); `id` is a
 * deterministic `ovr::<patientId>::<month>` string built by the client (see
 * billingOverrideId() in app.js) so re-writing the same pair REPLACES the
 * amount instead of appending a duplicate. `month` is 'YYYY-MM' and `amount`
 * a number, but BOTH are persisted in plain-text ('@') cells — getOrCreateSheet_
 * force-texts these two columns at ensure time. Sheets would otherwise coerce
 * "2026-08" into a date and drift the number's format, the same corruption class
 * the Leads visitDate/visitTime text-column fix guards against. */
const BILLING_OVERRIDE_COLUMNS = ['id', 'patientId', 'month', 'amount', 'created',
  /* updatedBy — the acting user of the last upsert (personal PINs PR A). The
   * name comes from the SIGNED SESSION COOKIE via requestUser_, never from the
   * payload. APPENDED LAST (append-only, same rule as AUDIT_LOG_COLUMNS):
   * getOrCreateSheet_ extends the header non-destructively; rows written
   * before it stay blank. */
  'updatedBy'];

/* ===== Facility types =====
 * Patients-sheet houseId (HOUSES in app.js) → billing-policy family used by
 * the credits ledger. Mirrors FACILITY_TYPE_BY_HOUSE in app.js EXACTLY; the
 * SERVER derives facilityType from houseId on every credit write — the client
 * value is never trusted.
 *   residential — asher (רעננה אשר), ramot (רמות השבים)
 *   detox_dual  — rehab (קיסריה ריהאב), pardes (רעננה הפרדס),
 *                 arfoni (קיסריה עפרוני), sde (שדה אליעזר) */
const FACILITY_TYPE_BY_HOUSE = {
  asher:  'residential',
  ramot:  'residential',
  rehab:  'detox_dual',
  pardes: 'detox_dual',
  arfoni: 'detox_dual',
  sde:    'detox_dual',
};
const FACILITY_TYPES = ['residential', 'detox_dual'];
function facilityTypeFor_(houseId) {
  return FACILITY_TYPE_BY_HOUSE[String(houseId == null ? '' : houseId).trim()] || '';
}

/* ===== Credits sheet — credits / refunds ledger =====
 *
 * One row per credit decision (a refund owed — or explicitly NOT owed — to a
 * patient on discharge, or a manual credit). APPEND-ONLY contract, same rule
 * as LEAD_COLUMNS / PAYMENT_COLUMNS: never insert/delete/reorder — position IS
 * the data contract (readSheet_ maps by position); new columns go at the END.
 * Guard-tested (test/credits-ledger.test.js). Auto-created on first use via
 * getOrCreateSheet_. Rules: CHANGELOG-credits-ledger.md.
 *
 *   id               — deterministic 'credit::<patientId>::<allocationMonth>::<seq>',
 *                      MINTED SERVER-SIDE under the script lock (seq = 1-based
 *                      count of rows already carrying that patientId+month).
 *                      A client never mints ids; an unknown client id is refused.
 *   patientId        — the PERSISTED Patients `id` (PATIENT_COLUMNS position 11)
 *                      — joins to Patients, survives the identity migration.
 *   patientKey       — the legacy triple houseId::name::entryDate (patientKey()
 *                      in app.js) — joins to Payments (whose patientId column
 *                      is this triple). BOTH keys are stored on every row and
 *                      neither is ever derived from the other at read time.
 *   patientName, houseId — denormalized display copies.
 *   facilityType     — residential | detox_dual, DERIVED from houseId here.
 *   creditType       — one of CREDIT_TYPES, validated server-side:
 *                        days_unused    — pro-rata for days paid but not stayed
 *                                         (residential: any tenure except an
 *                                         exit in the last 7 days of the month;
 *                                         detox_dual: tenure < 14 days, a
 *                                         DISCRETIONARY cutoff the override
 *                                         path carries), capped at amountPaid;
 *                        prepaid_return — a payment billed for a month AFTER
 *                                         the discharge month, returned in full
 *                                         (amountPaid — never the billed amount);
 *                        other          — manual credit; calculatedAmount is
 *                                         the entered amount, `reason` required.
 *   allocationMonth  — plain-text 'YYYY-MM' (the billed month the credit
 *                      belongs to). Column text-forced ('@') at ensure time.
 *   calculatedAmount — what the rule computed (VAT-INCLUSIVE, like `pay` and
 *                      Payments.amount). IMMUTABLE after creation: an edit never
 *                      overwrites it — the override lives in `amount`.
 *   amount           — the credit actually granted (VAT-inclusive). Defaults to
 *                      calculatedAmount; when it differs, overrideReason is
 *                      REQUIRED (server-enforced, not only in the UI).
 *   overrideReason   — why amount ≠ calculatedAmount ('' when equal).
 *   reason           — human-readable calculation trail written at creation;
 *                      the free-text justification for 'other'. Immutable.
 *   approvedBy       — free text, who approved the credit.
 *   decidedDate      — 'YYYY-MM-DD' the credit was decided/approved (defaults
 *                      to the save day in the spreadsheet timezone).
 *   payoutDate       — SERVER-DERIVED from decidedDate (refundPayoutDate_):
 *                      decided on the 1st–10th → the 15th of that month,
 *                      the 11th onward → the 15th of the next month. Credits
 *                      pay out on the 15th, never at discharge. Set once: an
 *                      edit that keeps decidedDate keeps the stored payoutDate.
 *   status           — one of CREDIT_STATUSES: pending | paid | cancelled.
 *                      'paid' is an EXPLICIT action: it requires paidDate AND
 *                      method (never flipped automatically when payoutDate
 *                      passes).
 *   paidDate         — 'YYYY-MM-DD' the refund was actually paid out.
 *   method           — how it was paid (free text).
 *   notes            — free text (editable).
 *   basis            — compact JSON of the calculation inputs/outputs (rule,
 *                      facilityType, tenure, days, divisor, UNCAPPED figure,
 *                      cap) written at creation. Immutable.
 *   createdAt/createdBy — SERVER-owned stamps of the first write (ISO server
 *                      clock + the user from the SIGNED SESSION COOKIE via
 *                      requestUser_ — never a client value). Immutable.
 *   updatedAt/updatedBy — SERVER-owned stamps of the last write. The client
 *                      echoes updatedAt back on an edit; a differing sheet stamp
 *                      REFUSES the write (stale-save conflict, same rule as the
 *                      Patients id-match branch).
 *
 * Every figure is stored VAT-inclusive (the existing revenue convention);
 * displays divide by VAT_RATE (1.18) in app.js. A ZERO credit is still a row:
 * "no refund owed" is an auditable decision, never silence. */
const CREDITS_SHEET = 'Credits';
/* creditUid — APPENDED for the accounting contract, minted once and then
 * permanent. The existing `id` is 'credit::<patientId>::<allocationMonth>::<seq>':
 * a COMPOSITE of mutable inputs (patientId is the houseId::name::entryDate
 * triple; seq is a row count at mint time), so it is a good in-app key but a
 * poor external one. creditUid is 'crd-<uuid>', carries no data, and is never
 * re-minted or rewritten. `id` behaviour is UNCHANGED — the client, the ledger
 * UI and the edit path all still key on it. */
const CREDIT_COLUMNS = [
  'id', 'patientId', 'patientKey', 'patientName', 'houseId', 'facilityType', 'creditType',
  'allocationMonth', 'calculatedAmount', 'amount', 'overrideReason', 'reason',
  'approvedBy', 'decidedDate', 'payoutDate', 'status', 'paidDate', 'method', 'notes',
  'basis', 'createdAt', 'createdBy', 'updatedAt', 'updatedBy',
  'creditUid'
];
const CREDIT_TYPES    = ['days_unused', 'prepaid_return', 'other'];
const CREDIT_STATUSES = ['pending', 'paid', 'cancelled'];
/* Day of month credits pay out on. */
const CREDIT_PAYOUT_DAY = 15;
/* Text-forced columns (whole column at ensure time + the target row per write). */
const CREDIT_TEXT_COLUMNS = ['allocationMonth', 'decidedDate', 'payoutDate', 'paidDate', 'createdAt', 'updatedAt'];
/* Columns a later edit may change. Everything else on an existing row is
 * carried from the SHEET, whatever the payload says (identity, facilityType,
 * the computed figure, the trail, the basis and the creation stamps are
 * immutable; payoutDate is re-derived from decidedDate). */
const CREDIT_EDITABLE_COLUMNS = ['amount', 'overrideReason', 'approvedBy', 'decidedDate', 'status', 'paidDate', 'method', 'notes'];

/* AuditLog sheet — append-only, hidden. One row per Patients-sheet write event
 * (promotion created/skipped, direct add, edit, discharge, delete, restore),
 * written by logAudit_ ONLY. APPEND-ONLY contract, same rule as LEAD_COLUMNS:
 * never insert/delete/reorder — new columns go at the END. Guard-tested.
 *   timestamp — ISO string (text-forced at ensure time, same coercion guard as
 *               the tombstones' droppedAt)
 *   action    — event name, e.g. 'promote_created', 'promote_skipped_duplicate'
 *   fn        — the backend function that wrote the event
 *   patientId — the row's fromLead lead-id when it has one, else the discharge
 *               audit id, else ''. The persisted Patients `id` travels in
 *               `details.id` where the event has one.
 *   name      — patient name
 *   details   — compact JSON string (houseId, identity key, skip reason, …)
 *   actor     — APPENDED (personal PINs PR A): who did it — the acting user's
 *               name from the signed session cookie (actorLabel_), suffixed
 *               ' (unverified)' when the request did not carry a valid
 *               PROXY_SECRET. Every delete / void writes it. '' on rows written
 *               before the column existed and on editor-run jobs. */
const AUDIT_LOG_SHEET = 'AuditLog';
const AUDIT_LOG_COLUMNS = ['timestamp', 'action', 'fn', 'patientId', 'name', 'details', 'actor'];

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
 *   source   — which repair tier proposed newValue plus its provenance (e.g.
 *              'repair from snapshot — EZONE-SNAPSHOT Patients row 12'), so
 *              Sandra can judge each proposal's trustworthiness while
 *              reviewing. Informational only — apply never reads it. APPENDED
 *              AT THE END per the append-only contract above; sheets created
 *              before it exist get the header backfilled non-destructively by
 *              getOrCreateSheet_. */
const REPAIR_PLAN_SHEET = 'RepairPlan';
const REPAIR_PLAN_COLUMNS = ['sheet', 'row', 'column', 'newValue', 'action', 'approved', 'oldValue', 'source'];

/* ===== Entry points ===== */

/* The handle_ actions that can write the Patients sheet: after each one,
 * handle_ drops the read caches built from that sheet (invalidateReadCaches_). */
const PATIENTS_WRITE_ACTIONS = [
  'saveAll', 'deletePatientRow', 'dischargePatient', 'restorePatient', 'restorePatientToActive',
  // Coordinators roster (#177): writes exitDate/status only — the patient key
  // set is unchanged, but a write to Patients clears the lookup all the same.
  'recordDischargeFromCoordinators',
];

function doGet(e) {
  return gatedEntry_(e, 'GET');
}

function doPost(e) {
  return gatedEntry_(e, 'POST');
}

/* ===== Proxy secret (Phase 0b-1 — TRANSITION) =====
 *
 * The Railway proxy (server.js) sends PROXY_SECRET on EVERY call to this
 * backend, in the POST body only — never in a URL. doGet/doPost verify it
 * here, before any action runs, against Script Property PROXY_SECRET with a
 * constant-time compare. The secret is read from the POST body ONLY:
 * collectParams_ drops proxySecret / proxyUser from the querystring, so a
 * secret pasted into a URL counts as missing.
 *
 * Script Property PROXY_SECRET_MODE:
 *   unset / 'log' → TRANSITION (the default for this PR). A request without a
 *                   valid secret is still served, but recorded in the
 *                   append-only SecurityLog tab (timestamp, action, method,
 *                   whether a secret was present — NEVER its value) at most
 *                   once per action per hour.
 *   'enforce'     → a request without a valid secret is refused with
 *                   {ok:false,error:'unauthorized'} and NOTHING is written.
 *   anything else → treated as 'enforce' (a typo must fail closed, not open).
 * With PROXY_SECRET itself unset no request can be valid: 'log' records
 * everything, 'enforce' refuses everything (fail-closed).
 *
 * Acting user: for a request WITH a valid secret the user is the proxy's
 * `proxyUser` (server.js reads it from the signed session cookie). A body
 * `user` that contradicts it is ignored and recorded as 'user_mismatch'.
 *
 * ===== Open actions (Phase 0b-2) =====
 *
 * Managers and Therapists call this same backend WITHOUT PROXY_SECRET and
 * must need zero changes. OPEN_ACTIONS is the fixed list they call; those
 * actions are served without PROXY_SECRET in BOTH modes (getAdmittedRoster
 * still requires its own ADMITTED_ROSTER_SECRET inside handle_). EVERY other
 * action — GET or POST, getData, every write, every future billing action —
 * is gated by PROXY_SECRET under PROXY_SECRET_MODE.
 *
 * Every request gets a caller class (callerClass_):
 *   proxy — a valid PROXY_SECRET (the Dashboard)
 *   open  — no valid PROXY_SECRET, on an OPEN_ACTIONS action
 *   none  — no secret, on a gated action
 *   wrong — a secret that is not PROXY_SECRET, on a gated action
 * SecurityLog records open / none / wrong (column callerClass, appended);
 * proxy traffic stays unlogged. securityCallersReportNow counts
 * "non-open actions without a valid secret" — it must be 0 before
 * PROXY_SECRET_MODE is set to 'enforce' (Phase 0b-3). */
const PROXY_SECRET_PROP      = 'PROXY_SECRET';
const PROXY_SECRET_MODE_PROP = 'PROXY_SECRET_MODE';
const PROXY_SECRET_FIELD     = 'proxySecret';
const PROXY_USER_FIELD       = 'proxyUser';
/* Personal PINs PR A: the proxy also sends the session principal. Like
 * proxyUser they are accepted from the POST body ONLY and believed ONLY when
 * PROXY_SECRET verifies; proxyGate_ strips all three before handle_ runs. */
const PROXY_ROLES_FIELD      = 'proxyRoles';
const PROXY_AUTH_FIELD       = 'proxyAuth';
const PROXY_USER_ID_FIELD    = 'proxyUserId';
/* Restricted view (2026-10-03): the session's view capabilities, e.g.
 * ['finance']. Same rules as the three above: POST body only, believed only
 * with a valid PROXY_SECRET, stripped by proxyGate_ before handle_ runs. */
const PROXY_CAPS_FIELD       = 'proxyCaps';
/* Where proxyGate_ puts the acting user for handle_. ALWAYS overwritten by
 * proxyGate_ (a client-sent value never survives) and dropped from the
 * querystring by collectParams_. Read it through actingUser_ only. */
const ACTOR_FIELD            = '__actor';
const PROXY_ONLY_FIELDS = [PROXY_SECRET_FIELD, PROXY_USER_FIELD, PROXY_ROLES_FIELD,
  PROXY_AUTH_FIELD, PROXY_USER_ID_FIELD, PROXY_CAPS_FIELD, ACTOR_FIELD];

/* ===== Roles (docs/billing-control-plan.md §11.5 — ENFORCED since PR C, 2026-10-04) =====
 *
 * Mirrors lib/users.js ROLES. The server sends the session's roles as
 * proxyRoles; they count ONLY for a request with a valid PROXY_SECRET
 * (a non-proxy caller never has a role, whatever it sends). On top of that:
 *   - approver is honoured only for the personal session of APPROVER_USER_ID
 *     (Sandra) — the server's startup validator refuses any other approver,
 *     and this is the same rule again on this side;
 *   - only a PERSONAL session holds roles: the shared APP_PIN was removed, so
 *     any other proxyAuth (including a stale 'shared') is treated as 'none'.
 * handle_ refuses every DELETE_ACTIONS operation without `deleter` and every
 * APPROVER_ACTIONS operation without `approver`: {ok:false,
 * error:'forbidden_role', message: ROLE_FORBIDDEN_MESSAGE}, before anything is
 * read or written. lib/role-scope.js (server.js) makes the same decision
 * first; a guard test pins the two lists equal. */
const KNOWN_ROLES = ['staff', 'reporter', 'deleter', 'approver', 'viewer', 'controller'];
const APPROVER_USER_ID = 'sandra';
const ROLE_FORBIDDEN_MESSAGE = 'אין הרשאה לפעולה זו';

/* Every delete / void operation. Each needs the `deleter` role (Vered,
 * Sandra — NOT Shiran / Yael).
 * Dispatched action names, plus two payload-level operations that ride an
 * ordinary write action (roleOperationFor_ maps them):
 *   voidPayment — savePayment / updatePayment that sets status 'void'
 *                 (the duplicate-void marking, PR #144)
 *   cancelCredit — saveCredit that sets status 'cancelled'
 * test/personal-pins-foundation.test.js fails if handle_ dispatches a
 * delete / remove / void action that is missing here. Every future billing
 * delete is added here. */
const DELETE_ACTIONS = [
  'removeLead', 'deletePatientRow', 'deleteBillingOverride', 'deleteMeetingReport',
  'voidPayment', 'cancelCredit',
  // Duplicate discharges (CHANGELOG-duplicate-discharges.md): soft-deletes ONE
  // duplicate row of the discharged sheet. Appended — the list is append-only.
  'deleteDuplicateDischarge',
];

/* ===== Restricted view — the `finance` capability (Sandra, 2026-10-03) =====
 *
 * Mirrors lib/finance-scope.js FINANCE_ACTIONS (a guard test pins the two
 * lists equal) and lib/users.js FINANCE_USER_IDS. Shiran and Yael see every
 * tab except the four money tabs; server.js refuses them first (403), and
 * handle_ refuses again here: a VERIFIED proxy call whose actor lacks
 * `finance` gets {ok:false, error:'forbidden'} and nothing is read or
 * written. The capability is RE-DERIVED here from proxyAuth + proxyUserId
 * (personal → by id; anything else → none) and
 * intersected with the server's proxyCaps when present — so neither side
 * alone can widen it. A call without a valid PROXY_SECRET has no actor and
 * is not refused here: enforce mode already refuses it at the gate, and the
 * accounting feed (own secret) keeps working. */
const FINANCE_ACTIONS = [
  'getPayments', 'savePayment', 'updatePayment', 'upsertBillingOverride', 'deleteBillingOverride',
  'getCredits', 'saveCredit', 'suggestRefunds', 'refundPayoutForecast', 'debtAging', 'cleanupReport',
  'accountingPayments', 'accountingCredits',
  'reportPayment', 'appendFunder',
  /* Appended (CHANGELOG-receipt-duplicates-and-edit.md): the receipt's
   * non-money fields (editReceipt_). Not on CONTROLLER_ACTIONS. */
  'editReceipt',
];
const FINANCE_USER_IDS = ['vered', 'sandra'];

/* ===== «בקרת גבייה» — the billing-control tab (Phase 4, Sandra 2026-10-04) =====
 *
 * Mirrors lib/finance-scope.js BILLING_CONTROL_ACTIONS / CONTROLLER_ACTIONS and
 * lib/users.js CONTROLLER_USER_IDS (a guard test pins the lists equal).
 *
 *   billingControl  a VIEW capability: may open the tab and read its queue.
 *                   Derived here by stable id — the finance users (Vered,
 *                   Sandra) plus the controller (Ortal) — and intersected with
 *                   the server's proxyCaps, like `finance`.
 *   controller view Ortal's session (CONTROLLER_USER_IDS, by id — never by
 *                   caps alone, so a narrowed or missing proxyCaps can never
 *                   widen her view): ONLY the CONTROLLER_ACTIONS; every other
 *                   action (getData included — no patients, no leads) is
 *                   refused before anything is read.
 *
 * Confirming / flagging still needs the controller or approver ROLE
 * (confirmPayment_), so Vered sees the tab but cannot decide.
 *
 * READ access to the full «גבייה» tab (Sandra 2026-10-06,
 * CHANGELOG-ortal-billing-access.md): the controller view also reaches
 * CONTROLLER_BILLING_READ_ACTIONS — the tab's READS only. Every write of that
 * tab (savePayment, updatePayment, reportPayment, the override, credits,
 * funder), every delete / void and every approval stays refused: none is on
 * the list, and her roles hold no deleter / approver. getData answers her
 * with CONTROLLER_GETDATA_KEYS only (no lead, no discharge record). */
const BILLING_CONTROL_ACTIONS = ['billingControlQueue', 'confirmPayment'];
const CONTROLLER_BILLING_READ_ACTIONS = ['getData', 'getPayments', 'getCredits', 'refundPayoutForecast', 'debtAging', 'cleanupReport'];
/* Append-only: the Phase 4 three first, then the «גבייה» reads. */
const CONTROLLER_ACTIONS = ['billingControlQueue', 'confirmPayment', 'debtAging',
  'getData', 'getPayments', 'getCredits', 'refundPayoutForecast', 'cleanupReport'];
const CONTROLLER_GETDATA_KEYS = ['ok', 'patients', 'billingOverrides'];
const CONTROLLER_USER_IDS = ['ortal'];

/* ===== Field allow-lists for the controller view (privacy fix, Sandra
 * 2026-10-06; CHANGELOG-ortal-billing-access.md «Field allow-lists») =====
 * Mirrors lib/finance-scope.js CONTROLLER_*_SCHEMA EXACTLY (a guard test pins
 * the literals equal). Every row the controller view (Ortal) receives from
 * getData, cleanupReport and refundPayoutForecast keeps ONLY the named
 * fields, at every depth (projectBySchema_): no lead row, no notes, no phone,
 * no source, no free-text reason. Grammar:
 *   true          a primitive, or an array of primitives
 *   ['a', 'b']    an array of rows, each cut to these fields
 *   { $each: S }  an array, each element projected by S
 *   { '*': S }    an object map, every value projected by S
 *   { k: S, … }   an object, only these keys */
const CONTROLLER_PATIENT_FIELDS = ['id', 'houseId', 'name', 'date', 'exitDate', 'status', 'pay', 'adv'];
const CONTROLLER_OVERRIDE_FIELDS = ['id', 'patientId', 'month', 'amount', 'created', 'updatedBy'];
const CONTROLLER_GETDATA_SCHEMA = {
  ok: true, error: true, message: true,
  patients: { '*': CONTROLLER_PATIENT_FIELDS },
  billingOverrides: CONTROLLER_OVERRIDE_FIELDS,
};
const CONTROLLER_CLEANUP_SCHEMA = {
  ok: true, error: true, message: true,
  today: true, recordsCutoff: true, notAPatientExcluded: true, missingTabs: true, generatedAt: true,
  counts: { names: true, gaps: true, detached: true, outsideStay: true, releasedNoExit: true, noEntryDate: true,
    zeroAmount: true, leads: true, duplicates: true, credits: true, noFunder: true, probono: true,
    defaultedFunder: true },
  sections: {
    names: ['kind', 'houseId', 'name', 'recordedName', 'otherName', 'entryDate', 'otherEntryDate', 'proposal', 'confidence', 'via', 'why', 'refs'],
    gaps: ['kind', 'houseId', 'name', 'status', 'entryDate', 'exitDate', 'start', 'end', 'due', 'expected', 'charged', 'received', 'balance',
      'bucket', 'days', 'laterActivity', 'probablyEntryError'],
    detached: ['kind', 'houseId', 'name', 'dueDate', 'amount', 'receivedByAsOf', 'candidate', 'candidateReason', 'refs'],
    outsideStay: ['kind', 'houseId', 'name', 'status', 'start', 'entryDate', 'exitDate', 'amount', 'refs'],
    releasedNoExit: ['kind', 'houseId', 'name', 'entryDate'],
    noEntryDate: ['kind', 'houseId', 'name', 'status', 'paymentRows'],
    zeroAmount: ['kind', 'houseId', 'name', 'status', 'entryDate', 'exitDate', 'cycles'],
    leads: ['kind', 'houseId', 'name', 'stage', 'created', 'entryDate', 'advance', 'paymentName', 'dueDate', 'amount', 'reason', 'refs'],
    duplicates: ['kind', 'houseId', 'name', 'names', 'dueDate', 'otherDueDate', 'amount', 'rule', 'refs'],
    credits: ['kind', 'houseId', 'name', 'entryDate', 'exitDate', 'amount', 'payoutDate', 'rule', 'error'],
    noFunder: ['kind', 'houseId', 'name', 'status', 'entryDate', 'funder'],
    probono: ['kind', 'houseId', 'name', 'status', 'entryDate', 'exitDate', 'from', 'current', 'excludedCycles'],
    // CHANGELOG-defaulted-funder-report.md — no patientUid for the controller view.
    defaultedFunder: ['kind', 'houseId', 'name', 'paymentId', 'receipt', 'receivedDate', 'amount', 'fix'],
  },
};
const CONTROLLER_FORECAST_BY_HOUSE_ = ['houseId', 'count', 'total'];
const CONTROLLER_FORECAST_SCHEMA = {
  ok: true, error: true, message: true,
  today: true, recordsCutoff: true, payoutDateIfDecidedToday: true, preCutoffExcludedCount: true, zeroByPolicyCount: true, generatedAt: true,
  awaiting_decision: { count: true, total: true, byHouse: CONTROLLER_FORECAST_BY_HOUSE_,
    byPayoutDate: { $each: { payoutDate: true, count: true, total: true,
      rows: ['patientName', 'houseId', 'entryDate', 'exitDate', 'suggestedAmount', 'rule', 'payoutDate'] } } },
  decided: { count: true, total: true, byHouse: CONTROLLER_FORECAST_BY_HOUSE_,
    byPayoutDate: { $each: { payoutDate: true, count: true, total: true,
      rows: ['creditId', 'creditType', 'patientName', 'houseId', 'amount', 'decidedDate', 'payoutDate', 'rule'] } } },
  missing_payment_data: { count: true, rows: ['patientName', 'houseId', 'entryDate', 'exitDate'] },
  unresolved: { count: true, rows: ['patientName', 'houseId', 'entryDate', 'exitDate', 'error'] },
};

function isPrimitive_(v) {
  return v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
}

/* `value` cut to `schema` (the grammar above); undefined = drop. PURE.
 * lib/finance-scope.js projectBySchema is the same function. */
function projectBySchema_(value, schema) {
  if (schema === true) {
    if (isPrimitive_(value)) return value;
    if (Array.isArray(value) && value.every(isPrimitive_)) return value.slice();
    return undefined;
  }
  if (Array.isArray(schema)) {
    if (!Array.isArray(value)) return undefined;
    const row = {};
    schema.forEach(function (k) { row[k] = true; });
    return value.map(function (v) { return projectBySchema_(v, row); }).filter(function (v) { return v !== undefined; });
  }
  if (!schema || typeof schema !== 'object') return undefined;
  if (schema.$each) {
    if (!Array.isArray(value)) return undefined;
    return value.map(function (v) { return projectBySchema_(v, schema.$each); }).filter(function (v) { return v !== undefined; });
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out = {};
  Object.keys(value).forEach(function (k) {
    const sub = Object.prototype.hasOwnProperty.call(schema, k) ? schema[k] : schema['*'];
    if (sub === undefined) return;
    const v = projectBySchema_(value[k], sub);
    if (v !== undefined) out[k] = v;
  });
  return out;
}

/* The controller view's answer, cut by its schema when the actor is the
 * controller view (by id — isControllerActor_); anyone else: unchanged. */
function controllerProjected_(params, data, schema) {
  return isControllerActor_(actingUser_(params)) ? projectBySchema_(data, schema) : data;
}
const BILLING_CONTROL_FORBIDDEN_MESSAGE = 'אין הרשאה לפעולה זו';
/* getData keys only billing reads — omitted for a restricted actor. */
const GETDATA_FINANCE_KEYS = ['billingOverrides'];
const FINANCE_FORBIDDEN_MESSAGE = 'אין הרשאה לצפות בנתוני גבייה';

/* Approver-only operations (Sandra's personal session). unvoidPayment is
 * decided inside upsertPayment_ (only the stored row shows an un-void); the
 * other three are the Phase 1/2 decisions (plan §7.3, §8.5, §9) and are
 * refused by handle_ before dispatch. */
const APPROVER_ACTIONS = [
  'unvoidPayment', 'approveRefundException', 'writeOffOpeningBalance', 'acceptOpeningBalance',
];
/* The ONLY actions served without PROXY_SECRET, in log AND enforce mode.
 * From the consumers' deployed code (2026-10-01, see
 * CHANGELOG-open-actions-gate.md):
 *   ezone-managers @ main               — managersOverview, managersHouse,
 *                                          occupancySnapshots
 *   ezone-therapists @ claude/inspiring-tesla-jipobw — getAdmittedRoster
 * test/open-actions-gate.test.js pins exactly these six. */
/* Coordinators roster (2026-10-04): getPatientsForCoordinators and
 * recordDischargeFromCoordinators are called by the ezone-coordinators app
 * directly (no Dashboard session), so they are open here and gated INSIDE
 * handle_ by their own fail-closed COORDINATORS_PATIENTS_SECRET — exactly the
 * getAdmittedRoster model. */
const OPEN_ACTIONS = ['managersOverview', 'managersHouse', 'occupancySnapshots', 'getAdmittedRoster',
  'getPatientsForCoordinators', 'recordDischargeFromCoordinators'];
const CALLER_CLASSES = ['proxy', 'open', 'none', 'wrong'];
/* Every action handle_ dispatches. An action name is caller-controlled, so
 * SecurityLog records only these; anything else is logged as '(unknown)' —
 * an attacker can neither spam distinct rows nor inject a formula.
 * test/proxy-secret-transition.test.js checks this list against handle_. */
const PROXY_KNOWN_ACTIONS = [
  'getData', 'getAdmittedRoster', 'saveAll', 'getPayments', 'savePayment',
  'updatePayment', 'upsertBillingOverride', 'deleteBillingOverride',
  'getCredits', 'saveCredit', 'suggestRefunds', 'refundPayoutForecast', 'debtAging', 'cleanupReport',
  'reportPayment', 'appendFunder', 'billingControlQueue', 'confirmPayment',
  'moveLeadIrrelevant', 'restoreLead',
  'removeLead', 'deletePatientRow', 'dischargePatient', 'restorePatient',
  'restorePatientToActive', 'deleteMeetingReport', 'meetingReportLeads',
  'submitMeetingReport', 'managersOverview', 'managersHouse',
  'occupancySnapshots', 'accountingPayments', 'accountingCredits',
  'getPatientsForCoordinators', 'recordDischargeFromCoordinators',
  'deleteDuplicateDischarge',
  'editReceipt',
];

/* SecurityLog — append-only, one row per (event, action, hour) at most.
 * APPEND-ONLY contract, same rule as AUDIT_LOG_COLUMNS: never insert /
 * delete / reorder; new columns go at the END.
 *   timestamp     — ISO string of the first such request in that hour
 *   action        — a PROXY_KNOWN_ACTIONS name, or '(unknown)' / '(none)'
 *   method        — 'GET' | 'POST'
 *   secretPresent — 'yes' | 'no' (whether ANY proxySecret was sent; the
 *                   value itself is never written anywhere)
 *   callerType    — 'no_secret' | 'bad_secret' | 'user_mismatch'
 *   hourKey       — 'YYYY-MM-DDTHH' (UTC), the dedupe bucket
 *   callerClass   — appended in 0b-2: 'proxy' | 'open' | 'none' | 'wrong'
 *                   (see callerClass_). Blank on rows written before it; the
 *                   report derives it. */
const SECURITY_LOG_SHEET   = 'SecurityLog';
const SECURITY_LOG_COLUMNS = ['timestamp', 'action', 'method', 'secretPresent', 'callerType', 'hourKey', 'callerClass'];
/* How many trailing rows the once-per-hour dedupe re-reads under the lock. */
const SECURITY_LOG_SCAN_ROWS = 500;

const LOCK_BUSY_MESSAGE = 'could not acquire the script lock — try again.';

/* The clean refusal every request-path writer returns when the script lock
 * is busy: nothing has been written, the caller may retry. */
function lockBusy_(_fn) {
  return { ok: false, error: 'lock_busy', message: LOCK_BUSY_MESSAGE };
}

function gatedEntry_(e, method) {
  const params = collectParams_(e);
  const gate = proxyGate_(params, method);
  if (!gate.ok) return jsonOut_({ ok: false, error: 'unauthorized' });
  return handle_(gate.params);
}

/* 'log' | 'enforce' from the Script Property value (see the block above). */
function proxySecretMode_(raw) {
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  if (v === '' || v === 'log') return 'log';
  return 'enforce';
}

/* Constant-time string equality: always walks the FULL length of the longer
 * input and folds every difference (length included) into one accumulator,
 * so the running time does not reveal how many leading characters matched.
 * No early return inside the loop. */
function constantTimeEquals_(a, b) {
  const x = String(a == null ? '' : a);
  const y = String(b == null ? '' : b);
  const n = Math.max(x.length, y.length);
  let diff = x.length ^ y.length;
  for (let i = 0; i < n; i++) {
    const cx = i < x.length ? x.charCodeAt(i) : 0;
    const cy = i < y.length ? y.charCodeAt(i) : 0;
    diff |= cx ^ cy;
  }
  return diff === 0;
}

/* Decide one request. ALWAYS strips proxySecret / proxyUser from params, so
 * no handler, response or error message can ever see the secret.
 * → { ok:true, params } to serve, { ok:false } to refuse (enforce mode). */
function proxyGate_(params, method) {
  const p = params || {};
  const presented = typeof p[PROXY_SECRET_FIELD] === 'string' ? p[PROXY_SECRET_FIELD] : '';
  const proxyUser = p[PROXY_USER_FIELD];
  const hasProxyUser = Object.prototype.hasOwnProperty.call(p, PROXY_USER_FIELD);
  const proxyRoles = p[PROXY_ROLES_FIELD];
  const proxyAuth = p[PROXY_AUTH_FIELD];
  const proxyUserId = p[PROXY_USER_ID_FIELD];
  const hasProxyCaps = Object.prototype.hasOwnProperty.call(p, PROXY_CAPS_FIELD);
  // A verified proxy body WITHOUT proxyAuth predates the session principal
  // (personal PINs PR A): a legacy full-view caller. The current server
  // always sends proxyAuth ('none' for the meeting-report micro-app).
  const legacyProxy = !Object.prototype.hasOwnProperty.call(p, PROXY_AUTH_FIELD);
  const proxyCaps = p[PROXY_CAPS_FIELD];
  PROXY_ONLY_FIELDS.forEach(function (k) { delete p[k]; });

  const action = String(p.action == null ? '' : p.action);
  const props = PropertiesService.getScriptProperties();
  const expected = String(props.getProperty(PROXY_SECRET_PROP) || '');
  const cls = callerClass_(action, presented, expected);
  const valid = cls === 'proxy';

  if (valid) {
    // The proxy's session user is the ONLY identity. A body `user` that
    // contradicts it is ignored (overwritten) and recorded.
    const trusted = requestUser_({ user: hasProxyUser ? proxyUser : '' });
    const bodyUserRaw = p.user == null ? '' : String(p.user);
    if (bodyUserRaw !== '' && requestUser_(p) !== trusted) {
      securityLogOnce_(action, method, true, 'user_mismatch');
    }
    p.user = trusted;
    p[ACTOR_FIELD] = proxyActor_(trusted, proxyUserId, proxyAuth, proxyRoles,
      legacyProxy ? ['finance'] : (hasProxyCaps ? proxyCaps : undefined), legacyProxy);
    return { ok: true, params: p };
  }

  // Every path below is NOT a verified proxy call: never any role.
  p[ACTOR_FIELD] = unverifiedActor_(p);

  // Open actions: served without PROXY_SECRET in BOTH modes, exactly as
  // today (getAdmittedRoster's own secret is still checked in handle_).
  if (cls === 'open') {
    securityLogOnce_(action, method, presented !== '', 'open');
    return { ok: true, params: p };
  }

  const mode = proxySecretMode_(props.getProperty(PROXY_SECRET_MODE_PROP));
  if (mode === 'enforce') return { ok: false };
  securityLogOnce_(action, method, presented !== '', cls);
  return { ok: true, params: p };
}

/* The caller class of one request (see the Open actions block above):
 * 'proxy' | 'open' | 'none' | 'wrong'. `expected` is PROXY_SECRET; when it
 * is unset nothing can be 'proxy'. Constant-time compare. Pure. */
function callerClass_(action, presented, expected) {
  const got = String(presented == null ? '' : presented);
  const want = String(expected == null ? '' : expected);
  if (want !== '' && got !== '' && constantTimeEquals_(got, want)) return 'proxy';
  if (OPEN_ACTIONS.indexOf(String(action)) >= 0) return 'open';
  return got === '' ? 'none' : 'wrong';
}

/* Append one SecurityLog row unless the same (event, action, hour) bucket
 * already has one. Fail-soft: a logging problem never blocks or breaks the
 * request. Never receives — and so can never write — the secret or a body. */
function securityLogOnce_(action, method, secretPresent, clsOrEvent) {
  try {
    const now = new Date();
    const hourKey = now.toISOString().slice(0, 13);
    const act = action === '' ? '(none)'
      : (PROXY_KNOWN_ACTIONS.indexOf(action) >= 0 ? action : '(unknown)');
    const meth = method === 'POST' ? 'POST' : 'GET';
    // callerType keeps its 0b-1 meaning (was a secret sent at all?);
    // callerClass carries the class.
    const type = clsOrEvent === 'user_mismatch' ? 'user_mismatch'
      : (secretPresent ? 'bad_secret' : 'no_secret');
    const klass = clsOrEvent === 'user_mismatch' ? 'proxy'
      : (CALLER_CLASSES.indexOf(clsOrEvent) >= 0 ? clsOrEvent : (secretPresent ? 'wrong' : 'none'));
    const bucket = securityLogBucket_(act, type, hourKey, klass);

    let cache = null;
    try { cache = CacheService.getScriptCache(); } catch (_) { cache = null; }
    if (cache && cache.get(bucket)) return false;

    const lock = LockService.getScriptLock();
    if (lock.tryLock(2000) !== true) return false;   // busy → skip; nothing written
    try {
      const sh = getOrCreateSheet_(SECURITY_LOG_SHEET, SECURITY_LOG_COLUMNS);
      const lastRow = sh.getLastRow();
      if (lastRow <= 1) {
        // Fresh tab: keep timestamp + hourKey as plain text so Sheets never
        // re-types them as dates.
        sh.getRange(2, 1, 1000, SECURITY_LOG_COLUMNS.length).setNumberFormat('@');
      }
      const n = Math.min(SECURITY_LOG_SCAN_ROWS, Math.max(0, lastRow - 1));
      if (n > 0) {
        const rows = sh.getRange(lastRow - n + 1, 1, n, SECURITY_LOG_COLUMNS.length).getValues();
        for (let i = 0; i < rows.length; i++) {
          if (securityLogBucket_(String(rows[i][1]), String(rows[i][4]), String(rows[i][5]), String(rows[i][6] || '')) === bucket) {
            if (cache) cache.put(bucket, '1', 3600);
            return false;
          }
        }
      }
      sh.appendRow([now.toISOString(), act, meth, secretPresent ? 'yes' : 'no', type, hourKey, klass]);
      if (cache) cache.put(bucket, '1', 3600);
      return true;
    } finally {
      try { lock.releaseLock(); } catch (_) { /* no-op */ }
    }
  } catch (_) {
    return false;
  }
}

/* Dedupe bucket, one row per (bucket, action, hour):
 *   'open'            — open-action traffic (class open)
 *   'user_mismatch'   — a valid proxy request with a contradicting body user
 *   'no_valid_secret' — none and wrong on a gated action share one bucket,
 *                       "at most one row per action per hour" as in 0b-1.
 * A pre-0b-2 row has no callerClass and dedupes as before. */
function securityLogBucket_(action, callerType, hourKey, callerClass) {
  let event = 'no_valid_secret';
  if (callerType === 'user_mismatch') event = 'user_mismatch';
  else if (callerClass === 'open') event = 'open';
  return 'seclog|' + event + '|' + action + '|' + hourKey;
}

/* The class of a SecurityLog row; a pre-0b-2 row (no callerClass) is derived
 * from its action and callerType. */
function securityLogRowClass_(action, callerType, callerClass) {
  const c = String(callerClass || '');
  if (CALLER_CLASSES.indexOf(c) >= 0) return c;
  if (callerType === 'user_mismatch') return 'proxy';
  if (OPEN_ACTIONS.indexOf(String(action)) >= 0) return 'open';
  return callerType === 'bad_secret' ? 'wrong' : 'none';
}

/**
 * Editor-run, READ-ONLY: who calls this backend, and is it safe to enforce?
 * Summarizes SecurityLog for the last 7 days by action × callerClass
 * (open / none / wrong, and proxy for a user_mismatch event). Each row is one
 * active hour, so `hours` = in how many distinct hours that action was hit.
 * The summary line "non-open actions without a valid secret: N" counts the
 * none / wrong hours on actions outside OPEN_ACTIONS — every one of them
 * would be REFUSED in enforce mode, so N must be 0 before Phase 0b-3.
 * Writes nothing: no cell, no tab, no lock, no property.
 */
function securityCallersReportNow() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(SECURITY_LOG_SHEET);
  const report = { since: '', rows: 0, summary: [], nonOpenWithoutSecret: 0 };
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  report.since = cutoff.toISOString();
  if (!sh || sh.getLastRow() < 2) {
    Logger.log('securityCallersReportNow: SecurityLog is empty — nothing but valid Dashboard (proxy) traffic so far.');
    Logger.log('non-open actions without a valid secret: 0');
    return report;
  }
  const values = sh.getRange(2, 1, sh.getLastRow() - 1, SECURITY_LOG_COLUMNS.length).getValues();
  const groups = {};
  for (let i = 0; i < values.length; i++) {
    const r = values[i];
    const ts = r[0] instanceof Date ? r[0] : new Date(String(r[0]));
    if (isNaN(ts.getTime()) || ts < cutoff) continue;
    report.rows++;
    const klass = securityLogRowClass_(String(r[1]), String(r[4]), r[6]);
    const key = String(r[1]) + '|' + klass;
    const g = groups[key] || (groups[key] = {
      action: String(r[1]), callerClass: klass, hours: 0, userMismatchHours: 0, methods: {}, firstSeen: '', lastSeen: '',
    });
    g.hours++;
    if (String(r[4]) === 'user_mismatch') g.userMismatchHours++;
    if ((klass === 'none' || klass === 'wrong') && OPEN_ACTIONS.indexOf(String(r[1])) < 0) report.nonOpenWithoutSecret++;
    g.methods[String(r[2])] = true;
    const iso = ts.toISOString();
    if (!g.firstSeen || iso < g.firstSeen) g.firstSeen = iso;
    if (!g.lastSeen || iso > g.lastSeen) g.lastSeen = iso;
  }
  report.summary = Object.keys(groups).map(function (k) {
    const g = groups[k];
    return {
      action: g.action, callerClass: g.callerClass, hours: g.hours, userMismatchHours: g.userMismatchHours,
      methods: Object.keys(g.methods).sort().join('+'), firstSeen: g.firstSeen, lastSeen: g.lastSeen,
    };
  }).sort(function (a, b) { return b.hours - a.hours || (a.action < b.action ? -1 : a.action > b.action ? 1 : 0); });
  Logger.log('securityCallersReportNow — READ-ONLY. Last 7 days (since ' + report.since + '): ' +
    report.rows + ' row(s).');
  report.summary.forEach(function (s) {
    Logger.log(s.action + ' · ' + s.callerClass + ' · ' + s.hours + ' hour(s)' +
      (s.userMismatchHours ? ' (' + s.userMismatchHours + ' with user_mismatch)' : '') + ' · ' + s.methods +
      ' · first ' + s.firstSeen + ' · last ' + s.lastSeen);
  });
  // Must be 0 before PROXY_SECRET_MODE = 'enforce' (Phase 0b-3).
  Logger.log('non-open actions without a valid secret: ' + report.nonOpenWithoutSecret);
  return report;
}

function handle_(params) {
  try {
    const action = params.action;
    // «בקרת גבייה» (Phase 4): the controller view reaches only its own
    // actions, and the tab's actions need billingControl — refused BEFORE any
    // read or write (server.js already answered 403; this is the second lock).
    const viewNo = viewRefused_(params, action);
    if (viewNo) return jsonOut_(viewNo);
    // Restricted view: refused BEFORE any read or write (server.js already
    // answered 403; this is the second lock).
    if (financeRefused_(params, action)) {
      return jsonOut_({ ok: false, error: 'forbidden', message: FINANCE_FORBIDDEN_MESSAGE });
    }
    // Roles (PR C): a delete / void / cancel without `deleter`, or an
    // approver operation outside Sandra's personal session → refused BEFORE
    // any read or write (server.js already answered 403; this is the second
    // lock). The un-void is decided in upsertPayment_ against the stored row.
    const roleOp = roleOperationFor_(action, params);
    if (roleOp && !roleAllowed_(params, roleOp)) return jsonOut_(roleRefused_(params, roleOp));
    if (action === 'getData') return jsonOut_(getDataForActor_(params));
    if (action === 'getAdmittedRoster') {
      if (!admittedRosterAuthOk_(params)) {
        return jsonOut_({ ok: false, error: 'unauthorized' });
      }
      return jsonOut_(getAdmittedRoster_());
    }
    /* ===== Coordinators roster — own fail-closed secret =====
     * Read feed + the one write (a discharge). Refused with NOTHING read or
     * written unless COORDINATORS_PATIENTS_SECRET is set and matches. */
    if (action === 'getPatientsForCoordinators' || action === 'recordDischargeFromCoordinators') {
      if (!coordinatorsPatientsAuthOk_(params)) {
        return jsonOut_({ ok: false, error: 'unauthorized' });
      }
      if (action === 'getPatientsForCoordinators') return jsonOut_(getPatientsForCoordinators_());
      const res = recordDischargeFromCoordinators_(params);
      // A discharge drops a resident out of the active population. Fail-soft.
      if (res && res.ok && res.discharged) refreshDigestBestEffort_();
      return jsonOut_(res);
    }
    if (action === 'saveAll') {
      const perf = perfStart_('saveAll');
      const leads    = parseJsonParam_(params.leads);
      const patients = parseJsonParam_(params.patients);
      const res = saveAll_(leads, patients, requestUser_(params), parseJsonParam_(params.prove));
      perfLap_(perf, 'save');
      // The digest is the active-resident population, which an admission or a
      // patient status/house change (both ride saveAll's patients payload)
      // mutates; lead edits can too. Refresh when either bucket is present.
      // Fail-soft.
      if ((Array.isArray(leads) && leads.length > 0) ||
          (patients && typeof patients === 'object' && Object.keys(patients).length > 0)) {
        refreshDigestBestEffort_();
      }
      perfLap_(perf, 'roster');
      perfEnd_(perf, 'leads=' + (Array.isArray(leads) ? leads.length : 0) +
        ' houses=' + (patients && typeof patients === 'object' ? Object.keys(patients).length : 0));
      return jsonOut_(res);
    }
    if (action === 'getPayments') return jsonOut_(getPayments_());
    if (action === 'savePayment' || action === 'updatePayment') {
      const payment = parseJsonParam_(params.payment);
      // chargedBy comes from the SIGNED SESSION COOKIE via requestUser_, the
      // same rule saveAll / discharge / saveCredit already follow. A
      // client-supplied user name never reaches the Payments sheet.
      // privileged: may write the confirm fields (controller = Ortal, Phase 4;
      // approver = Sandra). From hasRole_ — the verified actor — only.
      const paid = upsertPayment_(payment, requestUser_(params),
        { actor: actorLabel_(params), verified: actingUser_(params).verified, approver: hasRole_(params, 'approver'),
          privileged: hasRole_(params, 'controller') || hasRole_(params, 'approver'),
          // Item H (Phase 4): the HTTP save path never writes money directly.
          refuseLegacyMoney: true });
      if (paid && paid.error === 'forbidden_role') {
        roleRefusedLog_(params, paid.operation || 'unvoidPayment');
        delete paid.operation;
      }
      return jsonOut_(paid);
    }
    // The strict «דווח תשלום» (Phase 3 PR 2): one NEW receipt row per money
    // received; the cycle's money is re-derived. user / actor / approver come
    // from the verified session only, never from the body.
    if (action === 'reportPayment') {
      return jsonOut_(reportPayment_(parseJsonParam_(params.report), requestUser_(params),
        { actor: actorLabel_(params), approver: hasRole_(params, 'approver') }));
    }
    // A receipt's NON-money fields (CHANGELOG-receipt-duplicates-and-edit.md):
    // finance-gated (FINANCE_ACTIONS), never the controller view. user /
    // actor from the verified session only.
    if (action === 'editReceipt') {
      return jsonOut_(editReceipt_(parseJsonParam_(params.edit), requestUser_(params), { actor: actorLabel_(params) }));
    }
    // The patient card's funder editor: appends ONE Funders row.
    if (action === 'appendFunder') return jsonOut_(appendFunderAction_(params));
    // «בקרת גבייה» (Phase 4): the verification queue (READ-ONLY) and Ortal's
    // decision on a receipt. The decision needs the controller or approver
    // ROLE of the verified session (never anything in the body).
    if (action === 'billingControlQueue') {
      return jsonOut_(billingControlQueue_({ approver: hasRole_(params, 'approver') }));
    }
    if (action === 'confirmPayment') {
      const privileged = hasRole_(params, 'controller') || hasRole_(params, 'approver');
      if (!privileged) {
        roleRefusedLog_(params, CONFIRM_OPERATION);
        return jsonOut_({ ok: false, error: 'forbidden_role', message: ROLE_FORBIDDEN_MESSAGE });
      }
      return jsonOut_(confirmPayment_(parseJsonParam_(params.confirm), requestUser_(params),
        { actor: actorLabel_(params) }));
    }
    if (action === 'upsertBillingOverride') {
      return jsonOut_(upsertBillingOverride_(parseJsonParam_(params.override), requestUser_(params)));
    }
    if (action === 'deleteBillingOverride') {
      return jsonOut_(deleteBillingOverride_(parseJsonParam_(params.override), actorLabel_(params)));
    }
    // Credits ledger. Same trust model as savePayment: reached only through
    // the session-authed /api/sheets proxy (no new unauthenticated endpoint);
    // the stamping user comes from the signed cookie via requestUser_.
    if (action === 'getCredits') return jsonOut_(getCredits_());
    // Refund suggestion for a discharge: READ-ONLY (no sheet write, no lock),
    // gated by PROXY_SECRET like every non-OPEN_ACTIONS action.
    if (action === 'suggestRefunds') return jsonOut_(suggestRefunds_(params));
    // Payout forecast for the bookkeeper: READ-ONLY, gated by PROXY_SECRET.
    // The controller view gets both «גבייה» reads cut to their field
    // allow-lists (no lead phone / notes, no free-text reason).
    if (action === 'refundPayoutForecast') return jsonOut_(controllerProjected_(params, refundPayoutForecast_(), CONTROLLER_FORECAST_SCHEMA));
    // Debt aging as of a date: READ-ONLY, gated by PROXY_SECRET.
    if (action === 'debtAging') return jsonOut_(debtAgingAction_(params));
    // The data-cleanup workbook («ייצוא רשימת תיקונים»): READ-ONLY, gated by PROXY_SECRET.
    if (action === 'cleanupReport') return jsonOut_(controllerProjected_(params, cleanupReportAction_(), CONTROLLER_CLEANUP_SCHEMA));
    if (action === 'saveCredit') {
      return jsonOut_(upsertCredit_(parseJsonParam_(params.credit), requestUser_(params)));
    }
    if (action === 'moveLeadIrrelevant') {
      const res = moveLeadIrrelevant_(parseJsonParam_(params.lead), actorLabel_(params));
      refreshDigestBestEffort_();
      return jsonOut_(res);
    }
    if (action === 'restoreLead') {
      const res = restoreLead_(parseJsonParam_(params.lead), actorLabel_(params));
      refreshDigestBestEffort_();
      return jsonOut_(res);
    }
    if (action === 'removeLead') {
      const res = removeLead_(parseJsonParam_(params.lead), actorLabel_(params));
      refreshDigestBestEffort_();
      return jsonOut_(res);
    }
    if (action === 'deletePatientRow') {
      const res = deletePatientRow_(parseJsonParam_(params.patient), requestUser_(params), actorLabel_(params));
      // A permanent delete drops a resident out of the active population.
      // Fail-soft, mirroring dischargePatient.
      refreshDigestBestEffort_();
      return jsonOut_(res);
    }
    if (action === 'dischargePatient') {
      const res = dischargePatient_(parseJsonParam_(params.patient), requestUser_(params));
      // A discharge drops a resident out of the active population. Fail-soft.
      refreshDigestBestEffort_();
      return jsonOut_(res);
    }
    if (action === 'deleteDuplicateDischarge') {
      // Role-gated above (DELETE_ACTIONS → deleter: Vered, Sandra). Soft
      // delete of one duplicate discharged-audit row; Patients and Payments
      // are never touched, so no digest refresh.
      return jsonOut_(deleteDuplicateDischarge_(params, actorLabel_(params)));
    }
    if (action === 'restorePatient') {
      const res = restorePatient_(parseJsonParam_(params.patient), requestUser_(params));
      refreshDigestBestEffort_();
      return jsonOut_(res);
    }
    if (action === 'restorePatientToActive') {
      const res = restorePatientToActive_(parseJsonParam_(params.patient), requestUser_(params));
      // Restoring a patient to active adds them back to the digest. Fail-soft.
      refreshDigestBestEffort_();
      return jsonOut_(res);
    }
    if (action === 'deleteMeetingReport') {
      // Dashboard-side (Vered) action, same trust model as saveAll/removeLead:
      // reached only through the session-authed /api/sheets proxy.
      return jsonOut_(deleteMeetingReport_(params.leadId, actorLabel_(params)));
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
    // Read-only permanent occupancy history. Same access model as
    // managersOverview above: no new secret, no financial data.
    if (action === 'occupancySnapshots') {
      return jsonOut_(occupancySnapshots_());
    }
    /* ===== Accounting source feed (READ-ONLY) =====
     * Two read actions behind their OWN least-privilege secret. There is no
     * write action on this secret and never will be — see the contract block
     * above accountingAuthOk_. Fail-closed: an unset or mismatched secret
     * refuses, exactly as getAdmittedRoster / meetingReport do. */
    if (action === 'accountingPayments' || action === 'accountingCredits') {
      if (!accountingAuthOk_(params)) {
        return jsonOut_({ ok: false, error: 'unauthorized' });
      }
      return jsonOut_(action === 'accountingPayments'
        ? accountingPayments_(params)
        : accountingCredits_(params));
    }
    return jsonOut_({ ok: false, error: 'unknown_action', action: action || null });
  } catch (err) {
    return jsonOut_({ ok: false, error: 'exception', message: String((err && err.message) || err) });
  } finally {
    // AFTER (never before) a request that can change the Patients sheet —
    // also when it threw part-way — drop the cached lookups built from it.
    // Fail-soft and returns nothing, so the response above is untouched.
    if (params && PATIENTS_WRITE_ACTIONS.indexOf(params.action) >= 0) invalidateReadCaches_();
  }
}

function collectParams_(e) {
  const out = {};
  if (e && e.parameter) {
    Object.keys(e.parameter).forEach(function (k) {
      // The proxy secret / proxy user are accepted from the POST body ONLY —
      // a value in the querystring is dropped (it would sit in a URL).
      if (PROXY_ONLY_FIELDS.indexOf(k) >= 0) return;
      out[k] = e.parameter[k];
    });
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

/* The authenticated user name for who/when stamping (updatedBy). The Railway
 * proxy sets `user` on every /api/sheets POST body FROM THE SIGNED SESSION
 * COOKIE, overwriting anything the browser sent — so this value is never
 * client-controlled. Since Phase 0b-1, a request carrying a VALID proxy
 * secret has params.user replaced by the proxy's `proxyUser` in proxyGate_
 * before handle_ runs (a contradicting body user is ignored + logged).
 * Blank for sessions whose cookie pre-dates the user
 * field (allowed by contract). Defensive normalization here too: trimmed,
 * capped at 40 chars, angle brackets stripped. */
function requestUser_(params) {
  return String(params && params.user != null ? params.user : '')
    .replace(/[<>]/g, '').trim().slice(0, 40);
}

/* ===== Acting user + roles (personal PINs PR A — defined, NOT enforced) ===== */

/* proxyRoles as sent (an array, or its JSON text from a form-encoded body)
 * → the known roles only, de-duplicated, in KNOWN_ROLES order. Pure. */
function cleanRoles_(raw) {
  let list = raw;
  if (typeof list === 'string') {
    try { list = JSON.parse(list); } catch (_) { list = []; }
  }
  if (!Array.isArray(list)) return [];
  const want = {};
  list.forEach(function (r) { want[String(r)] = true; });
  return KNOWN_ROLES.filter(function (r) { return want[r] === true; });
}

/* The actor of a VERIFIED proxy call (valid PROXY_SECRET). Defense in depth
 * over the server's own rules: a shared session is capped to staff, and
 * approver survives only on Sandra's personal session. Pure. */
function proxyActor_(user, userId, auth, roles, caps, legacy) {
  // Only a personal session is an auth kind any more; a stale 'shared' (the
  // removed APP_PIN) or anything else is 'none': no role, no capability.
  const a = auth === 'personal' ? auth : 'none';
  const id = a === 'personal' && /^[a-z][a-z0-9]{0,31}$/.test(String(userId || '')) ? String(userId) : '';
  let r = cleanRoles_(roles);
  if (a === 'none') r = [];
  if (id !== APPROVER_USER_ID) r = r.filter(function (x) { return x !== 'approver'; });
  const c = legacy === true ? ['finance', 'billingControl'] : actorCaps_(a, id, caps);
  return { verified: true, user: String(user || ''), id: id, auth: a, roles: r, caps: c };
}

/* The view capabilities of a verified actor: derived HERE from auth + id
 * (shared → finance; personal → finance only for FINANCE_USER_IDS; none →
 * nothing), then intersected with the server's proxyCaps when it sent them
 * (an older server that sends none is judged by the derivation alone). Pure. */
function actorCaps_(auth, id, sent) {
  let derived = [];
  if (auth === 'personal' && FINANCE_USER_IDS.indexOf(id) >= 0) derived = ['finance', 'billingControl'];
  else if (auth === 'personal' && CONTROLLER_USER_IDS.indexOf(id) >= 0) derived = ['billingControl'];
  if (sent === undefined) return derived;
  let list = sent;
  if (typeof list === 'string') {
    try { list = JSON.parse(list); } catch (_) { list = []; }
  }
  if (!Array.isArray(list)) list = [];
  return derived.filter(function (c) { return list.indexOf(c) >= 0; });
}

/* Whether the VERIFIED acting user holds view capability `cap`. Always false
 * for a non-proxy caller. */
function hasCapability_(params, cap) {
  const a = actingUser_(params);
  return a.verified && a.caps.indexOf(String(cap)) >= 0;
}

/* true when handle_ must refuse `action`: a billing action from a verified
 * proxy call whose actor lacks `finance` (restricted view). The controller
 * view's own allow-list (CONTROLLER_ACTIONS, e.g. debtAging for the
 * «חובות מעל 60 יום» export) is decided by viewRefused_ instead. */
function financeRefused_(params, action) {
  if (FINANCE_ACTIONS.indexOf(String(action)) < 0) return false;
  const a = actingUser_(params);
  if (!a.verified) return false;
  if (isControllerActor_(a) && CONTROLLER_ACTIONS.indexOf(String(action)) >= 0) return a.caps.indexOf('billingControl') < 0;
  return a.caps.indexOf('finance') < 0;
}

/* Whether a verified actor is the controller view (Ortal): by stable id on a
 * personal session — never by caps, so a missing or narrowed proxyCaps can
 * only shrink what she reaches. Pure. */
function isControllerActor_(a) {
  return !!a && a.verified === true && a.auth === 'personal' && CONTROLLER_USER_IDS.indexOf(String(a.id)) >= 0;
}

/* The «בקרת גבייה» view gate (Phase 4), run by handle_ BEFORE dispatch:
 *   - the controller view reaches ONLY CONTROLLER_ACTIONS (getData, every
 *     lead / patient / billing action → refused);
 *   - BILLING_CONTROL_ACTIONS need the billingControl capability (Shiran and
 *     Yael → refused).
 * → null (allowed) or the refusal body. A call without a valid PROXY_SECRET
 * has no actor: enforce mode refuses it at the gate already. */
function viewRefused_(params, action) {
  const a = actingUser_(params);
  if (!a.verified) return null;
  const act = String(action == null ? '' : action);
  if (isControllerActor_(a) && CONTROLLER_ACTIONS.indexOf(act) < 0) {
    return { ok: false, error: 'forbidden', message: BILLING_CONTROL_FORBIDDEN_MESSAGE };
  }
  if (BILLING_CONTROL_ACTIONS.indexOf(act) >= 0 && a.caps.indexOf('billingControl') < 0) {
    return { ok: false, error: 'forbidden', message: BILLING_CONTROL_FORBIDDEN_MESSAGE };
  }
  return null;
}

/* The actor of any call WITHOUT a valid PROXY_SECRET: the legacy body user is
 * kept for stamping (log mode, unchanged), but it holds NO role. Pure. */
function unverifiedActor_(params) {
  return { verified: false, user: requestUser_(params), id: '', auth: 'none', roles: [], caps: [] };
}

/* The acting user for a handler: { verified, user, id, auth, roles, caps }. Only
 * proxyGate_ ever sets it; a params object that did not pass the gate
 * (an editor-run job, a direct call) has no verified actor and no role. */
function actingUser_(params) {
  const a = params ? params[ACTOR_FIELD] : null;
  if (a && typeof a === 'object' && a.verified === true && Array.isArray(a.roles)) {
    return { verified: true, user: String(a.user || ''), id: String(a.id || ''), auth: String(a.auth || 'none'), roles: a.roles.slice(),
      caps: Array.isArray(a.caps) ? a.caps.slice() : [] };
  }
  return { verified: false, user: requestUser_(params), id: '', auth: 'none', roles: [], caps: [] };
}

/* Whether the acting user holds `role`. Always false for a non-proxy caller;
 * approver additionally requires Sandra's personal session. */
function hasRole_(params, role) {
  const a = actingUser_(params);
  if (!a.verified || a.roles.indexOf(String(role)) < 0) return false;
  if (role === 'approver' && (a.id !== APPROVER_USER_ID || a.auth !== 'personal')) return false;
  return true;
}

/* The AuditLog `actor` value: the acting user's name, marked
 * ' (unverified)' when the request did not carry a valid PROXY_SECRET. */
function actorLabel_(params) {
  const a = actingUser_(params);
  const name = a.user || '(unknown)';
  return a.verified ? name : name + ' (unverified)';
}

/* The role-checked operation a request performs: a DELETE_ACTIONS /
 * APPROVER_ACTIONS name, or '' for an ordinary action. Payload-level
 * operations (voidPayment, cancelCredit) are read from the request; the
 * un-void decision needs the stored row, so upsertPayment_ makes it. */
function roleOperationFor_(action, params) {
  const act = String(action == null ? '' : action);
  if (DELETE_ACTIONS.indexOf(act) >= 0 || APPROVER_ACTIONS.indexOf(act) >= 0) return act;
  if (act === 'savePayment' || act === 'updatePayment') {
    const pay = parseJsonParam_(params && params.payment);
    if (pay && isVoidStatus_(pay.status)) return 'voidPayment';
  }
  if (act === 'saveCredit') {
    const credit = parseJsonParam_(params && params.credit);
    if (credit && String(credit.status || '').trim().toLowerCase() === 'cancelled') return 'cancelCredit';
  }
  return '';
}

/* The role an operation needs: 'deleter' | 'approver' | ''. */
function requiredRoleFor_(operation) {
  if (DELETE_ACTIONS.indexOf(operation) >= 0) return 'deleter';
  if (APPROVER_ACTIONS.indexOf(operation) >= 0) return 'approver';
  return '';
}

/* Whether the acting user may perform `operation`. Called by handle_ in
 * front of every dispatch (PR C). A non-proxy caller never holds a role, so
 * it can never delete, void, cancel or approve. */
function roleAllowed_(params, operation) {
  const need = requiredRoleFor_(operation);
  return need === '' ? true : hasRole_(params, need);
}

/* Log a role refusal: the acting user's stable id (or 'none') and the
 * operation ONLY — never a name, a payload or any patient data. Fail-soft. */
function roleRefusedLog_(params, operation) {
  try {
    const a = actingUser_(params);
    console.warn('[role] forbidden_role user=' + (a.id || 'none') + ' op=' + String(operation).slice(0, 40));
  } catch (_) { /* no-op */ }
}

/* The refusal body for a role-checked operation (logged once). */
function roleRefused_(params, operation) {
  roleRefusedLog_(params, operation);
  return { ok: false, error: 'forbidden_role', message: ROLE_FORBIDDEN_MESSAGE };
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
  // Payments: the two APPENDED coverage columns only. They carry plain
  // 'YYYY-MM-DD' strings that must never coerce into date-typed cells (the
  // exitDate −1-day drift class — here it would move revenue between
  // months). The pre-existing columns are deliberately left alone: changing
  // a live column's format is a migration, not a guard.
  if (name === PAYMENTS_SHEET) {
    forceColumnsText_(sh, PAYMENT_COLUMNS, PAYMENT_TEXT_COLUMNS);
  }
  // Funders: every column — an opaque id, a Hebrew label, a bare date and an
  // ISO stamp. effectiveFrom as a date-typed cell would drift a day.
  if (name === FUNDERS_SHEET) {
    forceColumnsText_(sh, FUNDER_COLUMNS, FUNDER_COLUMNS);
  }
  // PaymentsTombstones: opaque uids, a bare due date and two ISO stamps —
  // the same coercion class the Payments coverage columns are guarded for.
  if (name === PAYMENTS_TOMBSTONES_SHEET) {
    forceColumnsText_(sh, PAYMENT_TOMBSTONE_COLUMNS, PAYMENT_TOMBSTONE_TEXT_COLUMNS);
  }
  // Credits: allocationMonth ('YYYY-MM') must never coerce into a date; the
  // decided/payout/paid dates + ISO stamps are the same coercion class as droppedAt.
  if (name === CREDITS_SHEET) {
    forceColumnsText_(sh, CREDIT_COLUMNS, CREDIT_TEXT_COLUMNS);
  }
  // Patients: the entry date AND exitDate must survive as plain 'YYYY-MM-DD'
  // strings — a date-typed cell reads back as a Date, serializes as a UTC
  // timestamp and drifts the day −1 for Israel (the exitDate timezone-drift
  // bug; replaceHousePatients_ ALSO forces both per-write, exactly like the
  // entry date always was). The updatedAt ISO timestamp is the same coercion
  // class as droppedAt/waitlistedAt; updatedBy is opaque text. (`id` needs no
  // format — 'id-…' strings never coerce.)
  if (name === PATIENTS_SHEET) {
    forceColumnsText_(sh, PATIENT_COLUMNS, ['date', 'exitDate', 'updatedAt', 'updatedBy']);
  }
  // PatientsTombstones: entry date, exitDate and droppedAt must survive as
  // plain strings (same coercion class as the Leads visitDate/waitlistedAt
  // guards) — and the snapshot's who/when stamps for the same reasons as on
  // Patients.
  if (name === PATIENTS_TOMBSTONES_SHEET) {
    forceColumnsText_(sh, PATIENT_TOMBSTONE_COLUMNS, ['date', 'exitDate', 'droppedAt', 'updatedAt', 'updatedBy']);
  }
  // Discharged patients: entry date + exitDate (the audit row carries the
  // patient's dates) and the appended who/when stamps.
  if (name === DISCHARGED_PATIENTS_SHEET) {
    forceColumnsText_(sh, DISCHARGED_PATIENT_COLUMNS, ['date', 'exitDate', 'updatedAt', 'updatedBy',
      'dischargeSource', 'dischargedBy', 'dischargeReason', 'patientId',
      'deletedAt', 'deletedBy', 'deleteReason']);
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
  return rowsFromValues_(sheetValues_(sh, columns), columns);
}

/* The data block of `sh` (row 2 down, `columns.length` wide) as ONE getValues —
 * the single read a request needs per sheet. [] when there are no data rows. */
function sheetValues_(sh, columns) {
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return [];
  return sh.getRange(2, 1, lastRow - 1, columns.length).getValues();
}

/* readSheet_'s row objects from values already read (fully-empty rows
 * skipped), so a request that also pre-scans those values reads the sheet
 * once, not twice. */
function rowsFromValues_(values, columns) {
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

/* A sheet opened for a READ. getOrCreateSheet_ also re-applies whole-column
 * text formats (and can extend the header) — WRITES, on every call. Those
 * guards protect values being written, so every write path still runs them;
 * a read gains nothing from them. Only a missing sheet, or one whose header is
 * shorter than the columns the app maps, is handed to getOrCreateSheet_ (the
 * one-time setup a first read has always done). */
function sheetForRead_(name, headers) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sh || sh.getLastColumn() < headers.length) return getOrCreateSheet_(name, headers);
  return sh;
}

/* Does any CONTENT row of `values` have a blank `column` cell? (Fully-empty
 * rows are ignored, as every backfill ignores them.) Pure. */
function blankInContentRows_(values, columns, column) {
  const idx = columns.indexOf(column);
  if (idx < 0) return false;
  for (let i = 0; i < values.length; i++) {
    const row = values[i];
    if (String(row[idx] == null ? '' : row[idx]).trim() !== '') continue;
    for (let j = 0; j < row.length; j++) {
      if (row[j] !== '' && row[j] !== null) return true;
    }
  }
  return false;
}

/* ===== Per-request timing (Executions log only) =====
 * One Logger line per request, e.g.
 *   [perf] getData_ 812ms | open=31 read=402 backfill=0 shape=77 phones=12 | leads=250 patients=90
 * Milliseconds and row counts only: no names, no values, never in a response,
 * never stored. Read it in Apps Script → Executions → the request's log. */
function perfStart_(label) {
  const now = Date.now();
  return { label: label, t0: now, last: now, laps: [] };
}
function perfLap_(p, name) {
  const now = Date.now();
  p.laps.push(name + '=' + (now - p.last));
  p.last = now;
}
function perfEnd_(p, extra) {
  try {
    Logger.log('[perf] ' + p.label + ' ' + (Date.now() - p.t0) + 'ms' +
      (p.laps.length ? ' | ' + p.laps.join(' ') : '') + (extra ? ' | ' + extra : ''));
  } catch (_) { /* timing must never break a request */ }
}

/* ===== Script cache for read-only lookups =====
 * CacheService's script cache, shared by every execution of this script.
 * Only LOOKUPS whose staleness is harmless go here — never a response, never
 * a value that is written back — and only as fastHash_ values, so no patient
 * name is ever copied into the cache. Each key is either re-recorded by the
 * write that changes it or removed by invalidateReadCaches_() after every
 * write action (handle_), and always has a TTL. Everything is fail-soft: no
 * cache service (absent, or refused by the deployment), a failed get/put or
 * an oversized value simply means "not cached", i.e. exactly the behaviour
 * before the cache existed. */
const READ_CACHE_PATIENT_KEYS = 'read:patientKeyHashes:v1';
const READ_CACHE_PATIENT_KEYS_TTL = 600;        // seconds
const READ_CACHE_MAX_CHARS = 90000;             // CacheService caps a value at 100 KB

/* 53-bit string hash (cyrb53, public domain), as base-36 text. Pure and
 * deterministic, no service call. NOT a security primitive: it only keeps
 * names out of the cache and values short. A collision can only make a
 * pre-scan say "look closer" (or, for the digest, skip one redundant write
 * until the hourly rebuild) — never change a stored cell. */
function fastHash_(str) {
  const s = String(str == null ? '' : str);
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

function scriptCache_() {
  try { return CacheService.getScriptCache(); } catch (_) { return null; }
}
function cacheGetJson_(key) {
  const c = scriptCache_();
  if (!c) return null;
  try {
    const s = c.get(key);
    return s ? JSON.parse(s) : null;
  } catch (_) { return null; }
}
function cachePutJson_(key, value, ttlSeconds) {
  const c = scriptCache_();
  if (!c) return false;
  try {
    const s = JSON.stringify(value);
    if (s.length > READ_CACHE_MAX_CHARS) return false;
    c.put(key, s, ttlSeconds);
    return true;
  } catch (_) { return false; }
}

function cacheRemove_(key) {
  const c = scriptCache_();
  if (!c) return;
  try { c.remove(key); } catch (_) { /* fail-soft */ }
}

/* Called after every request that can change the Patients sheet (handle_) and
 * after a Patients id backfill: the next reader recomputes the lookups. */
function invalidateReadCaches_() {
  cacheRemove_(READ_CACHE_PATIENT_KEYS);
}

function objectToRow_(obj, columns) {
  const row = new Array(columns.length);
  for (let i = 0; i < columns.length; i++) {
    const v = obj[columns[i]];
    row[i] = (v === undefined || v === null) ? '' : v;
  }
  return row;
}

/* In-place: `date` and `exitDate` of every row object (readSheet_ output)
 * rendered as local 'YYYY-MM-DD' text via asISODate_ (blank stays blank).
 * Returns the same array. */
function normalizePatientDates_(rows) {
  for (let i = 0; i < rows.length; i++) {
    rows[i].date     = asISODate_(rows[i].date);
    rows[i].exitDate = asISODate_(rows[i].exitDate);
  }
  return rows;
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
 * <input type="date"> can read it without extra parsing.
 *
 * Every form derives the calendar day from the SPREADSHEET timezone
 * (Asia/Jerusalem), never from UTC parts — Israel is UTC+2/+3, so local
 * midnight is 21:00/22:00 UTC of the PREVIOUS day and a UTC slice drifts the
 * day −1 (the entry-date and exitDate timezone bugs):
 *   - Date object (a date-typed cell via getValues) → formatted in the sheet tz;
 *   - Number: a Sheets date SERIAL (days since 1899-12-30) — what getValues
 *     hands back for a date-valued cell whose format was switched to plain
 *     text; the day is exact, converted directly (no timezone involved);
 *   - 'YYYY-MM-DDTHH:mm…' string carrying a timezone marker (trailing 'Z' or
 *     ±hh:mm — a Date that went through JSON.stringify/toISOString and was
 *     persisted as text) → parsed and formatted in the sheet tz, so
 *     '2026-05-06T21:00:00.000Z' yields '2026-05-07', not the sliced UTC day;
 *   - any other string: the leading YYYY-MM-DD if present (a bare date passes
 *     through unchanged; a tz-less 'YYYY-MM-DDT…' is wall-clock), else as-is;
 *   - blank / null / undefined → ''. */
function asISODate_(v) {
  if (v === undefined || v === null || v === '') return '';
  // The spreadsheet timezone is resolved lazily: only the Date and tz-marked
  // timestamp branches need it, so a bare 'YYYY-MM-DD' (the common case)
  // never touches a GAS service.
  const sheetTz = function () {
    return SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone() || 'Asia/Jerusalem';
  };
  if (Object.prototype.toString.call(v) === '[object Date]') {
    return isNaN(v.getTime()) ? '' : Utilities.formatDate(v, sheetTz(), 'yyyy-MM-dd');
  }
  if (typeof v === 'number' && isSheetDateSerial_(v)) {
    return sheetSerialToISODate_(v);
  }
  const s = String(v);
  const m = s.match(/^\d{4}-\d{2}-\d{2}/);
  // Only a timestamp with an explicit timezone marker (trailing 'Z' or a
  // ±hh:mm / ±hhmm offset) is re-localized; a tz-less 'YYYY-MM-DDT…' string
  // is a wall-clock value whose leading date is already the intended day.
  if (m && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/.test(s)) {
    const d = new Date(s);
    if (!isNaN(d.getTime())) return Utilities.formatDate(d, sheetTz(), 'yyyy-MM-dd');
  }
  return m ? m[0] : s;
}

/* Sheets date serials: days since 1899-12-30 (serial 25569 = 1970-01-01).
 * The plausible window (1950-01-01 … 2199-12-31) keeps an ordinary number
 * such as a payment amount from being mistaken for a date. */
const SHEET_SERIAL_MIN = 18264;  // 1950-01-01
const SHEET_SERIAL_MAX = 109574; // 2199-12-31
function isSheetDateSerial_(n) {
  return isFinite(n) && n >= SHEET_SERIAL_MIN && n <= SHEET_SERIAL_MAX;
}
function sheetSerialToISODate_(n) {
  // The serial's integer part IS the calendar day; the epoch arithmetic is
  // done in UTC on purpose so no host/script timezone can shift it.
  const ms = (Math.floor(n) - 25569) * 86400000;
  return Utilities.formatDate(new Date(ms), 'UTC', 'yyyy-MM-dd');
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
  // The timezone lookup is a spreadsheet round trip; only the Date and the
  // timestamp-string branches need it, so the 'HH:MM' fast path (every clean
  // cell, i.e. almost every lead on every load) never pays for it.
  const tz = function () {
    return SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone() || 'Asia/Jerusalem';
  };
  if (Object.prototype.toString.call(v) === '[object Date]') {
    return Utilities.formatDate(v, tz(), 'HH:mm');
  }
  const s = String(v);
  const m = s.match(/^(\d{2}):(\d{2})/);
  if (m) return m[1] + ':' + m[2];
  const d = new Date(s);
  return isNaN(d) ? '' : Utilities.formatDate(d, tz(), 'HH:mm');
}

/* Every date-like column name any row-level writer (upsertRowById_) may meet:
 * the leads' three date columns plus the patients' entry date and exitDate —
 * the DischargedPatients rows written by dischargePatient_ / the restore
 * flows carry both. Each is normalized through asISODate_ and text-forced at
 * the target row before the write, so no date value can be coerced into a
 * Date cell (the exitDate timezone-drift class). */
const DATE_LIKE_COLUMNS = ['visitDate', 'entryDate', 'created', 'date', 'exitDate'];

/* The date columns and the time column present in a `columns` list. Safe on
 * any columns list — absent names are simply skipped. Used to normalize and
 * text-format row writes so a value can't be coerced into a Date cell. */
function leadDateColIdxs_(columns) {
  const out = [];
  DATE_LIKE_COLUMNS.forEach(function (n) {
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

/* getData for the acting user: every key for a full-view session (the
 * append-only contract); a verified actor without `finance` gets the same
 * object minus GETDATA_FINANCE_KEYS (no tab it can see reads them). */
function getDataForActor_(params) {
  const out = getData_();
  const a = actingUser_(params);
  // The controller view (Ortal): the «גבייה» tab's keys ONLY — by stable id,
  // like viewRefused_, so a forged cap can never widen it.
  if (isControllerActor_(a)) return controllerGetData_(out, a.caps.indexOf('billingControl') >= 0);
  if (a.verified && a.caps.indexOf('finance') < 0) {
    GETDATA_FINANCE_KEYS.forEach(function (k) { delete out[k]; });
  }
  return out;
}

/* getData as the controller view sees it: CONTROLLER_GETDATA_KEYS only, and
 * every row cut to its FIELD allow-list (CONTROLLER_GETDATA_SCHEMA: patients
 * → CONTROLLER_PATIENT_FIELDS, overrides → CONTROLLER_OVERRIDE_FIELDS);
 * billingOverrides only with billingControl. PURE. */
function controllerGetData_(data, billingControl) {
  const keys = {};
  CONTROLLER_GETDATA_KEYS.forEach(function (k) {
    if (k === 'billingOverrides' && billingControl !== true) return;
    if (data && Object.prototype.hasOwnProperty.call(data, k)) keys[k] = data[k];
  });
  return projectBySchema_(keys, CONTROLLER_GETDATA_SCHEMA);
}

function getData_() {
  const perf = perfStart_('getData_');
  // READ accessors: no whole-column re-formatting and no header writes on a
  // load (sheetForRead_). Every write path still runs getOrCreateSheet_.
  const leadsSh      = sheetForRead_(LEADS_SHEET, LEAD_COLUMNS);
  const patientsSh   = sheetForRead_(PATIENTS_SHEET, PATIENT_COLUMNS);
  const irrelevantSh = sheetForRead_(IRRELEVANT_LEADS_SHEET, IRRELEVANT_LEAD_COLUMNS);
  const removedSh    = sheetForRead_(REMOVED_LEADS_SHEET, REMOVED_LEAD_COLUMNS);
  const dischargedSh = sheetForRead_(DISCHARGED_PATIENTS_SHEET, DISCHARGED_PATIENT_COLUMNS);
  const overridesSh  = sheetForRead_(BILLING_OVERRIDES_SHEET, BILLING_OVERRIDE_COLUMNS);
  perfLap_(perf, 'open');

  // ONE getValues per sheet: the id-backfill pre-scans below look at these
  // same values instead of reading each sheet a second time.
  let leadValues      = sheetValues_(leadsSh, LEAD_COLUMNS);
  let irrelevantValues = sheetValues_(irrelevantSh, IRRELEVANT_LEAD_COLUMNS);
  let patientValues   = sheetValues_(patientsSh, PATIENT_COLUMNS);
  const removedValues    = sheetValues_(removedSh, REMOVED_LEAD_COLUMNS);
  const dischargedValues = sheetValues_(dischargedSh, DISCHARGED_PATIENT_COLUMNS);
  const overrideValues   = sheetValues_(overridesSh, BILLING_OVERRIDE_COLUMNS);
  perfLap_(perf, 'read');

  // Heal blank id cells BEFORE answering, so the ids returned to the client are
  // the same ones now stored on the sheet — client and sheet agree on the
  // delete/update key. Only the two sheets that are targets of delete-by-id are
  // healed: Leads (removeLead_ / moveLeadIrrelevant_), the irrelevant-leads
  // sheet (restoreLead_), and — patient identity foundation — the Patients
  // sheet (deletePatientRow_ by id; the saveAll merge matches by id first).
  // The patients backfill is one-time (the first read after the `id` column
  // lands) and takes the script lock so it cannot race a saveAll rewrite;
  // with every id present it performs ZERO writes and takes no lock. The
  // removed and discharged sheets are written with client-stamped ids and
  // are not delete-by-id targets, so they need no backfill. A sheet that WAS
  // healed is read again, so the answer carries the stored ids.
  if (blankInContentRows_(leadValues, LEAD_COLUMNS, 'id')) {
    backfillMissingIds_(leadsSh, LEAD_COLUMNS);
    leadValues = sheetValues_(leadsSh, LEAD_COLUMNS);
  }
  if (blankInContentRows_(irrelevantValues, IRRELEVANT_LEAD_COLUMNS, 'id')) {
    backfillMissingIds_(irrelevantSh, IRRELEVANT_LEAD_COLUMNS);
    irrelevantValues = sheetValues_(irrelevantSh, IRRELEVANT_LEAD_COLUMNS);
  }
  if (blankInContentRows_(patientValues, PATIENT_COLUMNS, 'id')) {
    backfillPatientIdsLocked_(patientsSh);
    patientValues = sheetValues_(patientsSh, PATIENT_COLUMNS);
    invalidateReadCaches_();   // new ids → the patient-uid lookup is stale
  }
  perfLap_(perf, 'backfill');

  const leads               = rowsFromValues_(leadValues, LEAD_COLUMNS);
  // Normalize visitTime on the way out: a legacy cell coerced to a time-typed
  // value (before the text-format fix in mergeLeads_) reads back from getValues
  // as a Date; asISOTime_ converts it to 'HH:MM' in the SPREADSHEET timezone so
  // it no longer drifts through the UTC round-trip. A clean 'HH:MM' text cell
  // passes through unchanged.
  // visitDate gets the same treatment (meetings board): a date-typed legacy
  // cell (a Date, serialized as a UTC timestamp) or a serial left behind by a
  // text re-format would otherwise reach the client raw and be read in the
  // device's timezone / as 1970-01-01. asISODate_ renders it as the sheet-tz
  // 'YYYY-MM-DD' — the form meetingReportLeads_ already sends. Clean text
  // cells pass through unchanged.
  for (let i = 0; i < leads.length; i++) {
    leads[i].visitTime = asISOTime_(leads[i].visitTime);
    leads[i].visitDate = asISODate_(leads[i].visitDate);
  }
  const patientRows         = rowsFromValues_(patientValues, PATIENT_COLUMNS);
  const irrelevantLeads     = rowsFromValues_(irrelevantValues, IRRELEVANT_LEAD_COLUMNS);
  const removedLeads        = rowsFromValues_(removedValues, REMOVED_LEAD_COLUMNS);
  const dischargedPatients  = rowsFromValues_(dischargedValues, DISCHARGED_PATIENT_COLUMNS);
  const billingOverrides    = rowsFromValues_(overrideValues, BILLING_OVERRIDE_COLUMNS);
  // Normalize the patient dates on the way out — same treatment visitTime
  // gets above. A legacy date-typed (or serial-numbered) exitDate / entry
  // date cell would otherwise serialize to the client as a UTC timestamp
  // ('2026-05-06T21:00:00.000Z' for a 2026-05-07 discharge) and drift the
  // day; asISODate_ renders it as the local 'YYYY-MM-DD' so the client can
  // never see the drifted form, even before repairPatientExitDatesNow runs.
  // Clean text cells pass through unchanged.
  normalizePatientDates_(patientRows);
  normalizePatientDates_(dischargedPatients);

  const patients = {};
  for (let i = 0; i < patientRows.length; i++) {
    const p = patientRows[i];
    const hid = p.houseId;
    if (!hid) continue;
    if (!patients[hid]) patients[hid] = [];
    patients[hid].push(p);
  }
  perfLap_(perf, 'shape');

  const phones = managerPhones_();
  perfLap_(perf, 'phones');
  perfEnd_(perf, 'leads=' + leads.length + ' patients=' + patientRows.length);

  const cm = currentManagers_();

  return {
    ok: true,
    leads: leads,
    patients: patients,
    irrelevantLeads: irrelevantLeads,
    removedLeads: removedLeads,
    dischargedPatients: dischargedPatients,
    billingOverrides: billingOverrides,
    houseManagers: HOUSE_MANAGERS,
    managerPhones: phones,
    // Additive (append-only contract): who manages each house TODAY. Read
    // only — see currentManagers_. houseManagers above is unchanged for every
    // other consumer.
    currentManagers: cm.managers,
    currentManagersSource: cm.source,
  };
}

/* ===== Current house managers (READ-ONLY) =====
 *
 * Who manages each house today, for the dashboard's meetings summary strip,
 * the meetingWith dropdown and the per-house meetingWith default. Three
 * sources, first one that has data wins:
 *
 *   1. 'managers'    — the Managers tab (house | manager_name | start_date |
 *                      end_date). A row is CURRENT only when
 *                        (start_date blank OR start_date <= today) AND
 *                        (end_date blank OR end_date >= today),
 *                      today in Asia/Jerusalem. A future start_date is NOT
 *                      current yet. Used whenever the tab has at least one
 *                      named row — even if no row is current (then no house
 *                      has a current manager).
 *   2. 'bonusconfig' — only when the Managers tab is missing or has no named
 *                      row: the `manager` column of the bonusconfig tab.
 *   3. 'default'     — when neither has a name: exactly what getData has always
 *                      sent as houseManagers (HOUSE_MANAGERS). No new behavior.
 *
 * Tabs are found by name case-insensitively ('bonusconfig' = 'BonusConfig')
 * and columns by their HEADER text, never by position. Nothing is written:
 * no getOrCreateSheet_ (it would create a missing tab), no header backfill,
 * no format. House keys are returned as Patients-sheet ids
 * (raanana→asher, efroni→arfoni, …) via MANAGER_HOUSE_TO_PATIENTS_HOUSE_ID;
 * an unknown house is skipped. Within a house the most recent start_date
 * comes first, so the first entry per house is the default. Never throws:
 * any read problem falls through to the next source. */
function currentManagers_(todayIso) {
  const today = todayIso || Utilities.formatDate(new Date(), 'Asia/Jerusalem', 'yyyy-MM-dd');
  let ss = null;
  try { ss = SpreadsheetApp.getActiveSpreadsheet(); } catch (_) { ss = null; }

  try {
    const fromManagers = managersTabCurrent_(ss, today);
    if (fromManagers) return { source: 'managers', managers: fromManagers };
  } catch (_) { /* fall through */ }

  try {
    const fromConfig = bonusConfigManagers_(ss);
    if (fromConfig && fromConfig.length) return { source: 'bonusconfig', managers: fromConfig };
  } catch (_) { /* fall through */ }

  return {
    source: 'default',
    managers: Object.keys(HOUSE_MANAGERS).map(function (h) { return { house: h, name: HOUSE_MANAGERS[h] }; }),
  };
}

/* A tab by name, ignoring case and surrounding spaces. null when absent.
 * Read-only lookup — never creates. */
function findSheetByNameCI_(ss, name) {
  if (!ss) return null;
  const exact = ss.getSheetByName(name);
  if (exact) return exact;
  if (typeof ss.getSheets !== 'function') return null;
  const want = String(name).trim().toLowerCase();
  const sheets = ss.getSheets() || [];
  for (let i = 0; i < sheets.length; i++) {
    if (String(sheets[i].getName()).trim().toLowerCase() === want) return sheets[i];
  }
  return null;
}

/* Every data row of a tab as objects keyed by its lower-cased header text.
 * [] for a missing or header-only tab. Read-only. */
function readTabByHeader_(sh) {
  if (!sh) return [];
  const lastRow = sh.getLastRow();
  const lastCol = sh.getLastColumn();
  if (lastRow < 2 || lastCol < 1) return [];
  const header = sh.getRange(1, 1, 1, lastCol).getValues()[0]
    .map(function (h) { return String(h == null ? '' : h).trim().toLowerCase(); });
  const values = sh.getRange(2, 1, lastRow - 1, lastCol).getValues();
  return values.map(function (row) {
    const o = {};
    for (let j = 0; j < header.length; j++) if (header[j]) o[header[j]] = row[j];
    return o;
  });
}

/* A Managers-tab / bonusconfig house key → Patients-sheet house id, or ''.
 * Accepts the bonus keys (raanana/efroni/…) and the Patients ids themselves. */
function managerHouseToPatientsId_(raw) {
  const k = String(raw == null ? '' : raw).trim().toLowerCase();
  if (!k) return '';
  if (MANAGER_HOUSE_TO_PATIENTS_HOUSE_ID[k]) return MANAGER_HOUSE_TO_PATIENTS_HOUSE_ID[k];
  for (const key in MANAGER_HOUSE_TO_PATIENTS_HOUSE_ID) {
    if (MANAGER_HOUSE_TO_PATIENTS_HOUSE_ID[key] === k) return k;
  }
  return '';
}

/* A Managers-tab date cell → 'YYYY-MM-DD', or '' when blank or unreadable.
 * Accepts a real date cell, 'YYYY-MM-DD…' and a hand-typed DD/MM/YYYY (or
 * DD.MM.YYYY). An unreadable start_date or end_date reads as '' — i.e. blank,
 * so the row stays CURRENT and a typo never hides a manager.
 * A Date cell is formatted in Asia/Jerusalem explicitly — the same zone as
 * `today` — NOT the spreadsheet's zone (asISODate_), which would turn a
 * Jerusalem-midnight date into the previous day under UTC or any zone west
 * of Israel. */
function managerDateIso_(v) {
  if (Object.prototype.toString.call(v) === '[object Date]') {
    return isNaN(v.getTime()) ? '' : Utilities.formatDate(v, 'Asia/Jerusalem', 'yyyy-MM-dd');
  }
  const iso = asISODate_(v);
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  const m = String(iso).trim().match(/^(\d{1,2})[\/.](\d{1,2})[\/.](\d{4})$/);
  if (!m) return '';
  return m[3] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[1]).slice(-2);
}

/* Current managers from the Managers tab, or null when the tab is missing or
 * has no row with a name (→ caller falls back). */
function managersTabCurrent_(ss, today) {
  const rows = readTabByHeader_(findSheetByNameCI_(ss, MANAGERS_SHEET))
    .filter(function (r) { return String(r.manager_name == null ? '' : r.manager_name).trim() !== ''; });
  if (!rows.length) return null;
  const out = [];
  rows.forEach(function (r) {
    const house = managerHouseToPatientsId_(r.house);
    if (!house) return;
    const start = managerDateIso_(r.start_date);
    const end = managerDateIso_(r.end_date);
    if (start && start > today) return;        // starts after today → not current yet
    if (end && end < today) return;            // ended before today → not current
    out.push({ house: house, name: String(r.manager_name).trim(), start: start });
  });
  out.sort(function (a, b) {
    if (a.house !== b.house) return a.house < b.house ? -1 : 1;
    return a.start < b.start ? 1 : a.start > b.start ? -1 : 0;   // newest start first
  });
  const seen = {};
  return out.filter(function (m) {
    const k = m.house + '|' + m.name;
    if (seen[k]) return false;
    seen[k] = true;
    return true;
  }).map(function (m) { return { house: m.house, name: m.name }; });
}

/* The `manager` column of the bonusconfig tab, one entry per house that has
 * a name. [] when the tab or the column is missing. */
function bonusConfigManagers_(ss) {
  const out = [];
  const seen = {};
  readTabByHeader_(findSheetByNameCI_(ss, BONUS_CONFIG_SHEET)).forEach(function (r) {
    const house = managerHouseToPatientsId_(r.house);
    const name = String(r.manager == null ? '' : r.manager).trim();
    if (!house || !name || seen[house]) return;
    seen[house] = true;
    out.push({ house: house, name: name });
  });
  return out;
}

/* ===== Write (merge semantics) ===== */

function saveAll_(leads, patients, user, prove) {
  // Validated BEFORE the lock: a malformed proof request writes nothing.
  const want = saveProveRequest_(prove);
  if (want === null) return { ok: false, error: 'bad_prove' };
  const lock = LockService.getScriptLock();
  if (lock.tryLock(10000) !== true) return lockBusy_('saveAll_');
  try {
    // Leads — upsert by id; leads not in the payload are preserved.
    // `reportConflicts` lists the leadIds whose meetingReport* fields the
    // merge guard kept from the SHEET instead of the payload (the client's
    // copy carried a different report timestamp — stale echo, or an edit that
    // raced a manager resubmission/deletion). The dashboard's edit flow
    // checks its own leadId here to surface the conflict instead of
    // pretending the edit saved.
    let reportConflicts = [];
    const leadOut = {};
    if (Array.isArray(leads) && leads.length > 0) {
      reportConflicts = mergeLeads_(leads, leadOut);
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
    // Stale-stamp refusals aggregated across houses (the id-match branch and
    // refused house moves) — additive: absent from the response when no save
    // conflicted, so old clients and the Managers consumer see nothing new.
    const conflicts = [];
    // Deliberate house moves that LANDED ({id, name, fromHouseId, toHouseId})
    // and the fresh who/when stamps of rows this save wrote whose stamp the
    // client did not already hold ({id: {updatedAt, updatedBy}}). Both are
    // additive and absent when empty.
    const moved = [];
    const stamps = {};
    if (patients && typeof patients === 'object' && !Array.isArray(patients)) {
      const houseIds = Object.keys(patients);
      const userDeleteKeys = houseIds.length > 0 ? recentUserDeleteKeys_() : {};
      const dischargedIds = houseIds.length > 0 ? dischargedFromLeadIds_() : {};
      // Collected from the WHOLE payload before any house is written, so the
      // house a patient is leaving and the house it is joining both know about
      // the move, whichever of the two passes runs first.
      const moves = houseIds.length > 0 ? collectHouseMoves_(patients) : {};
      for (let i = 0; i < houseIds.length; i++) {
        const hid = houseIds[i];
        const arr = patients[hid];
        const res = replaceHousePatients_(hid, Array.isArray(arr) ? arr : [], userDeleteKeys, dischargedIds, user, moves);
        written[hid] = res.written;
        if (res.preservedKeys.length > 0) preserved[hid] = res.preservedKeys;
        if (res.suppressedKeys.length > 0) deletedSuppressed[hid] = res.suppressedKeys;
        if (res.skippedPromotes.length > 0) promoteSkipped[hid] = res.skippedPromotes;
        for (let c = 0; c < res.conflicts.length; c++) conflicts.push(res.conflicts[c]);
        for (let m = 0; m < res.moved.length; m++) moved.push(res.moved[m]);
        Object.keys(res.stamps).forEach(function (id) { stamps[id] = res.stamps[id]; });
      }
    }

    const out = {
      ok: true,
      written: written,
      preserved: preserved,
      deletedSuppressed: deletedSuppressed,
      promoteSkipped: promoteSkipped,
      reportConflicts: reportConflicts,
    };
    if (conflicts.length > 0) out.conflicts = conflicts;
    // Leads a stale payload tried to put back after they were closed or
    // removed (CHANGELOG-write-path-hardening.md, R1). Absent when none.
    if (leadOut.closedSuppressed && leadOut.closedSuppressed.length > 0) out.closedSuppressed = leadOut.closedSuppressed;
    if (moved.length > 0) out.moved = moved;
    if (Object.keys(stamps).length > 0) out.stamps = stamps;
    // R3 proof (CHANGELOG-write-path-hardening.md): which of the ids the
    // client asked about are on the sheet NOW, read under the same lock.
    if (want) out.proven = saveProven_(want);
    return out;
  } finally {
    try { lock.releaseLock(); } catch (_) { /* no-op */ }
  }
}

/* ===== saveAll proof (CHANGELOG-write-path-hardening.md, R3) =====
 * A saveAll payload may carry `prove: { leads: [id…], patients: [id…] }` —
 * the rows the caller must see persisted before it says «נשמר». The answer's
 * `proven` lists those of them the sheet holds after the write. The ids are
 * the client-minted row ids (one per form), which the merge already matches
 * on, so a retry re-sends the same id and never adds a row.
 * → undefined (no proof asked), null (malformed: refused, nothing written),
 *   or { leads: [...], patients: [...] }. PURE. */
const SAVE_PROVE_MAX = 50;
// Row ids are opaque (legacy rows predate the client's format): any text of
// 1–200 characters without control characters. Only the shape is checked.
const SAVE_PROVE_ID_RE = /^[^\u0000-\u001f\u007f]{1,200}$/;
// The id a restore mints for its new lead (cryptoId: 'id-' + base36).
const NEW_LEAD_ID_RE = /^[A-Za-z0-9_-]{4,64}$/;
function saveProveRequest_(prove) {
  if (prove === undefined || prove === null || prove === '') return undefined;
  if (typeof prove !== 'object' || Array.isArray(prove)) return null;
  const out = { leads: [], patients: [] };
  const keys = ['leads', 'patients'];
  for (let k = 0; k < keys.length; k++) {
    const list = prove[keys[k]];
    if (list === undefined) continue;
    if (!Array.isArray(list) || list.length > SAVE_PROVE_MAX) return null;
    for (let i = 0; i < list.length; i++) {
      if (typeof list[i] !== 'string' || !SAVE_PROVE_ID_RE.test(list[i])) return null;
      out[keys[k]].push(list[i]);
    }
  }
  return out;
}
function saveProven_(want) {
  const has = function (sheetName, columns, ids) {
    if (!ids.length) return [];
    const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
    if (!sh || sh.getLastRow() < 2) return [];
    const at = columns.indexOf('id');
    const col = sh.getRange(2, at + 1, sh.getLastRow() - 1, 1).getValues();
    const seen = {};
    col.forEach(function (r) { seen[String(r[0] == null ? '' : r[0]).trim()] = true; });
    return ids.filter(function (id) { return seen[id] === true; });
  };
  return {
    leads: has(LEADS_SHEET, LEAD_COLUMNS, want.leads),
    patients: has(PATIENTS_SHEET, PATIENT_COLUMNS, want.patients),
  };
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
function mergeLeads_(leadsIn, out) {
  const sh = getOrCreateSheet_(LEADS_SHEET, LEAD_COLUMNS);
  const idColIdx      = LEAD_COLUMNS.indexOf('id');
  const createdColIdx = LEAD_COLUMNS.indexOf('created');
  const lastRow = sh.getLastRow();

  /* R1, server side (CHANGELOG-write-path-hardening.md): a lead that is NOT
   * on Leads but IS on the closed or the removed sheet was moved there by
   * moveLeadIrrelevant_ / removeLead_. A payload that still carries it is a
   * stale tab (or a rollback after a lost answer) — appending it would put
   * the lead in two sheets. It is dropped and reported (closedSuppressed).
   * A lead already on Leads is an update and is never touched by this. */
  const onLeads = {};
  if (lastRow > 1) {
    sh.getRange(2, idColIdx + 1, lastRow - 1, 1).getValues().forEach(function (r) {
      onLeads[String(r[0] == null ? '' : r[0])] = true;
    });
  }
  const parked = movedOffLeadsIds_();
  const suppressed = [];
  const leads = leadsIn.filter(function (l) {
    const id = String(l && l.id != null ? l.id : '');
    if (id && !onLeads[id] && parked[id]) { suppressed.push(id); return false; }
    return true;
  });
  if (out && typeof out === 'object') out.closedSuppressed = suppressed;

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
  let before = [];   // the sheet as read, untouched by the canonicalization below
  if (lastRow > 1) {
    const values = sh.getRange(2, 1, lastRow - 1, LEAD_COLUMNS.length).getValues();
    before = values.map(function (row) { return row.slice(); });
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

  // Every save sends EVERY lead, so a save that changed none of them (a
  // patient edit) would still rewrite the whole sheet. When the final rows
  // equal the sheet as read above, cell for cell, nothing is written (no
  // format pass, no setValues, no trim) — the sheet already holds them.
  if (leadRowsUnchanged_(before, finalRows)) return reportConflicts;

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

/* {id: true} for every lead id on the closed (לידים לא רלוונטיים) or removed
 * (לידים שהוסרו) sheet. Read-only (never creates a sheet); fail-open to {}
 * so a read error can never block a save. */
function movedOffLeadsIds_() {
  const out = {};
  [[IRRELEVANT_LEADS_SHEET, IRRELEVANT_LEAD_COLUMNS], [REMOVED_LEADS_SHEET, REMOVED_LEAD_COLUMNS]].forEach(function (x) {
    try {
      const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(x[0]);
      if (!sh || sh.getLastRow() < 2) return;
      const at = x[1].indexOf('id');
      sh.getRange(2, at + 1, sh.getLastRow() - 1, 1).getValues().forEach(function (r) {
        const id = String(r[0] == null ? '' : r[0]).trim();
        if (id) out[id] = true;
      });
    } catch (err) {
      try { console.warn('[leads] moved-off scan skipped: ' + ((err && err.message) || err)); } catch (_) { /* no-op */ }
    }
  });
  return out;
}

/* Would writing `after` over `before` (both raw Leads row arrays, same
 * column order) change the sheet? Same row count and every cell equal as
 * text ('' for empty). A legacy Date cell always counts as a change: its text
 * ('Tue Jun 02 2026 …') never equals the canonical 'YYYY-MM-DD' / 'HH:MM'
 * the write stores, so the write still heals it. Pure. */
function leadRowsUnchanged_(before, after) {
  if (!before || before.length !== after.length) return false;
  for (let i = 0; i < after.length; i++) {
    const a = before[i], b = after[i];
    if (!a || !b || a.length !== b.length) return false;
    for (let c = 0; c < b.length; c++) {
      if (String(a[c] == null ? '' : a[c]) !== String(b[c] == null ? '' : b[c])) return false;
    }
  }
  return true;
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

/* Identity KEY for a Patients row: the triple houseId::name::entryDate. Since
 * the patient identity foundation the persisted `id` column is the PRIMARY
 * identity wherever a row/payload carries one; this triple is the fallback
 * identity and stays the compatibility key the client's
 * matchActivePatientIndex, the discharge heal, digestPatientKey_, the payment
 * ids and the user-delete suppression rely on. `date` goes through asISODate_
 * so a legacy Date-typed cell and the client's 'YYYY-MM-DD' string compare
 * equal. */
function patientKey_(houseId, name, date) {
  return String(houseId == null ? '' : houseId).trim() + '::' +
         String(name    == null ? '' : name).trim()    + '::' +
         asISODate_(date);
}

/* Column names where two raw Patients row arrays differ — the SAME
 * normalization replaceHousePatients_'s changed-columns diff has always used
 * (asISODate_ for the date-like columns so a legacy Date-typed cell and a
 * 'YYYY-MM-DD' string compare equal; plain String elsewhere). An empty result
 * means the rows are byte-identical for every purpose this file has: the
 * dedupe utilities collapse only what this says is equal. */
function patientRowDiffCols_(a, b) {
  const dateColIdx = PATIENT_COLUMNS.indexOf('date');
  const diff = [];
  for (let c = 0; c < PATIENT_COLUMNS.length; c++) {
    // Meta columns (id + who/when stamps) are identity/audit, not content:
    // two rows that differ ONLY in them are the same patient content-wise.
    // The dedupe utilities must keep seeing repaired-twin duplicates as
    // byte-identical after each row got its own id and stamps, an ignored
    // payload id must not read as an edit, and an echo of stale stamps must
    // never churn updatedAt (the stamp itself would otherwise BE the change).
    if (PATIENT_META_COLUMNS.indexOf(PATIENT_COLUMNS[c]) >= 0) continue;
    const dateLike = (c === dateColIdx || PATIENT_COLUMNS[c] === 'exitDate');
    const av = dateLike ? asISODate_(a[c]) : String(a[c] == null ? '' : a[c]);
    const bv = dateLike ? asISODate_(b[c]) : String(b[c] == null ? '' : b[c]);
    if (av !== bv) diff.push(PATIENT_COLUMNS[c]);
  }
  return diff;
}

/* Low-level PatientsTombstones writer: snapshot each raw patient row + audit
 * metadata. THROWS on failure — each caller decides whether that is fatal.
 * Callers run inside a script lock.
 * `deletedBy` (optional): when given (the user-delete path), the tombstone's
 * updatedAt/updatedBy are OVERWRITTEN with now + the deleting user, so the
 * recovery copy answers "who deleted this and when". Omitted (preserve /
 * dedupe snapshots), the row's own last-edit stamps ride along untouched. */
function appendPatientTombstones_(rows, reason, savedByAction, deletedBy) {
  if (!rows || rows.length === 0) return;
  const sh = getOrCreateSheet_(PATIENTS_TOMBSTONES_SHEET, PATIENT_TOMBSTONE_COLUMNS);
  const nowIso = new Date().toISOString();
  const out = rows.map(function (row) {
    const obj = {};
    for (let i = 0; i < PATIENT_COLUMNS.length; i++) obj[PATIENT_COLUMNS[i]] = row[i];
    obj.date          = asISODate_(obj.date);
    obj.exitDate      = asISODate_(obj.exitDate);
    obj.droppedAt     = nowIso;
    obj.reason        = reason;
    obj.savedByAction = savedByAction;
    if (deletedBy !== undefined) {
      obj.updatedAt = nowIso;
      obj.updatedBy = String(deletedBy == null ? '' : deletedBy);
    }
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
function logAudit_(action, fn, patientId, name, details, actor) {
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
      actor:     String(actor == null ? '' : actor),
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
      if (dischargeRowDeleted_(rows[i])) continue;   // a soft-deleted duplicate is not a discharge
      const fl = String(rows[i].fromLead == null ? '' : rows[i].fromLead).trim();
      if (fl) out[fl] = true;
    }
  } catch (err) {
    try { console.warn('[audit] discharged-id scan skipped: ' + ((err && err.message) || err)); } catch (_) { /* no-op */ }
  }
  return out;
}

/* Deliberate house moves in a saveAll payload, as {id: {from, to}}.
 *
 * The ✏ edit modal marks a patient whose house it changed with `movedFrom`
 * (the house the patient is leaving); the row then arrives under the NEW
 * house's key still carrying its persisted id. That explicit intent is the
 * only thing that makes a cross-house id legitimate: without it, the same
 * payload shape is a stale tab or an old client, and the legacy rules apply
 * unchanged (fromLead guard refuses, id re-minted). A payload row counts as a
 * move when it has an id and a non-blank movedFrom that differs from the
 * house it arrived under. The same id claimed as moving by two payload rows
 * is ambiguous (a duplicated client object), so neither is treated as a move.
 * `movedFrom` itself is never written: it is not a PATIENT_COLUMNS column.
 * Pure. */
function collectHouseMoves_(patients) {
  const out = {};
  const ambiguous = {};
  Object.keys(patients || {}).forEach(function (hid) {
    const arr = Array.isArray(patients[hid]) ? patients[hid] : [];
    for (let i = 0; i < arr.length; i++) {
      const p = arr[i] || {};
      const id = String(p.id == null ? '' : p.id).trim();
      const from = String(p.movedFrom == null ? '' : p.movedFrom).trim();
      if (!id || !from || from === hid) continue;
      if (id in out) { ambiguous[id] = true; continue; }
      out[id] = { from: from, to: hid };
    }
  });
  Object.keys(ambiguous).forEach(function (id) { delete out[id]; });
  return out;
}

/**
 * MERGE the payload's patients into the house's rows — merge-don't-drop.
 * Rows for other houses are untouched, exactly as before. Within the house:
 *   - payload row carries a persisted `id` held by an unconsumed row of THIS
 *     house → ID MATCH: that sheet row is replaced by the payload row WHATEVER
 *     its name/entry date say — a rename or an entry-date edit is an in-place
 *     update for every patient, hand-entered included (audited
 *     'patient_rekeyed_via_id' when the key changed, 'patient_edited'
 *     otherwise). The id is immutable: the row keeps it;
 *   - else payload row matches a sheet row by patientKey_ → the sheet row is
 *     replaced by the payload row (field edits, status flips, exitDate all
 *     behave as they always did — per-row last-writer-wins); the SHEET row's
 *     id wins over whatever the payload carried (a stale tab's session id
 *     never overwrites a persisted one); a sheet row without an id adopts
 *     the payload's (if unused) or gets one minted;
 *   - payload row matches nothing → appended (admission);
 *   - sheet row ABSENT from the payload → KEPT. Genuine deletion goes through
 *     the dedicated deletePatientRow action (discharge is a status flip), so
 *     a saveAll omission is never a legitimate deletion — it is a stale tab
 *     that loaded before the row existed. Kept rows are copied to the
 *     PatientsTombstones audit sheet (fail-soft, before the rewrite) and
 *     their keys returned so the response can tell the client to resync.
 *     EXCEPTION (identical-key dedupe): a leftover that shares its identity
 *     key with a row this save consumed AND is byte-identical to that
 *     consumed row's original sheet content is tombstoned
 *     ('dedupe-identical-key') and dropped, not preserved — see the preserve
 *     loop. Differing same-key leftovers are still preserved
 *     (collapseDuplicatePatientKeysNow handles those explicitly).
 * Remaining trade-off (documented, locked by test): a payload row WITHOUT a
 * persisted id (legacy tab, cross-app writer) whose name or entry date was
 * edited changes the identity key, so the old row is preserved and the edit
 * lands as a new row — a visible, mergeable duplicate instead of silent loss.
 * Duplicate keys consume matches one payload row per sheet row, in sheet
 * order; a sheet row whose id ANOTHER payload row claims is reserved for that
 * id match and is never key-consumed.
 *
 * ID UNIQUENESS: every id written by this save is checked against every id
 * on the sheet (all houses) plus the ids assigned earlier in the save. An
 * incoming id already held elsewhere — a house move WITHOUT the explicit
 * movedFrom intent (an old client or a stale tab: the old house's row is
 * preserved by merge-don't-drop and keeps the id), a duplicated client
 * object, or an id whose row this save already consumed — is re-minted for
 * the incoming row and audited 'patient_id_reminted'. Preserved (omitted)
 * rows that still lack an id get one minted here too, so the sheet converges
 * to fully-identified rows through ordinary saves.
 *
 * DELIBERATE HOUSE MOVE (`moves`, from collectHouseMoves_: the ✏ modal's
 * explicit `movedFrom` intent). A payload row whose id `moves` names with
 * to === this house, and which is NOT already a row of this house, is
 * resolved BEFORE the id / key match, against the row that holds its id in
 * another house:
 *   - the row sits in the house the tab says it is leaving AND its updatedAt
 *     is exactly the stamp the tab loaded (blank === blank) → MOVED: that row
 *     is removed from its old house and the payload row written here with
 *     the SAME id and the sheet's own fromLead, re-stamped, audited
 *     'patient_moved_house', echoed in `moved`. One row before, one after —
 *     never a duplicate, never a second row for the lead;
 *   - the stamps differ (someone saved the patient after this tab loaded),
 *     the row is in a THIRD house (someone moved it meanwhile), or no row
 *     holds the id any more (deleted) → REFUSED: nothing is written, the old
 *     row stays byte-for-byte, and a `conflicts` entry carrying
 *     `move: {from, to, reason, currentHouseId}` tells the client why
 *     (audited 'patient_move_refused'). A stale tab can therefore never
 *     drag a patient back, and a deleted patient is never resurrected.
 * On the LEAVING house's own pass the row is reserved for the move: it is
 * neither key-consumed nor preserved/tombstoned as a stale omission — it is
 * kept untouched, so a refused move leaves it exactly where it was.
 * The destination pass drops the old row and adds the new one in the SAME
 * setValues of the sheet, so the two can never both exist or both be missing.
 *
 * STAMP ECHO: every row written from the payload whose final updatedAt
 * differs from the one the payload carried is returned in `stamps`
 * ({id: {updatedAt, updatedBy}}). The client adopts them, so its OWN next
 * edit of the same patient is not mistaken for a stale save.
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
 * an edit-modal rename lands instead of being dropped. A house move that
 * carries the ✏ modal's explicit intent never reaches these rules (see
 * DELIBERATE HOUSE MOVE above). WITHOUT that intent — an old client, or a
 * stale tab that still holds the patient in a house it has since left — a
 * lead-linked row arriving in a new house is still an append and falls under
 * rule 2: refused, surfaced by the client's promoteSkipped message. That is
 * the stale-tab protection, and it is unchanged. Hand-entered patients
 * (fromLead '') keep the old rename trade-off (old row kept + edit appended)
 * unchanged.
 *
 * Returns { written, preservedKeys, suppressedKeys, skippedPromotes,
 * conflicts, moved, stamps }: `written` counts the rows actually written for
 * the house (payload count minus suppressed, skipped and refused-move rows),
 * so the saveAll_ `written` echo stays honest for the server diagnostics.
 *
 * Write order is WRITE-THEN-TRIM, not clear-then-write: the final row set is
 * written first, then only surplus tail rows are cleared. A crash between the
 * two steps can leave duplicate tail rows (visible, fixable) but can no
 * longer empty the sheet. Note the merge means the Patients sheet never
 * shrinks through this path, so the trim is a pure safety net here.
 */
function replaceHousePatients_(houseId, patientsArr, suppressedDeleteKeys, dischargedFromLeads, user, moves) {
  const sh = getOrCreateSheet_(PATIENTS_SHEET, PATIENT_COLUMNS);
  const houseColIdx = PATIENT_COLUMNS.indexOf('houseId');
  const nameColIdx  = PATIENT_COLUMNS.indexOf('name');
  const dateColIdx  = PATIENT_COLUMNS.indexOf('date');
  const exitDateColIdx = PATIENT_COLUMNS.indexOf('exitDate');
  const fromLeadIdx = PATIENT_COLUMNS.indexOf('fromLead');
  const idIdx       = PATIENT_COLUMNS.indexOf('id');
  const updatedAtIdx = PATIENT_COLUMNS.indexOf('updatedAt');
  const updatedByIdx = PATIENT_COLUMNS.indexOf('updatedBy');
  const stampUser = String(user == null ? '' : user);
  // Who/when stamps are SERVER-OWNED: on a matched replace the payload's
  // copies are discarded (the sheet row's values are carried instead), and a
  // real content change — or any append/rename — re-stamps here. Preserved
  // rows are never touched.
  const carryStamps = function (withHouse, sheetRow) {
    withHouse.updatedAt = sheetRow[updatedAtIdx];
    withHouse.updatedBy = sheetRow[updatedByIdx];
  };
  const stampNow = function (withHouse) {
    withHouse.updatedAt = new Date().toISOString();
    withHouse.updatedBy = stampUser;
  };
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

  // Persisted ids. idsInUse: every id on the sheet (ALL houses) — the
  // uniqueness set every assignment below checks against, extended as this
  // save assigns ids. houseRowByIdIdx: THIS house's rows by id — the primary
  // match (first in sheet order if an id is, pre-existing-bug, duplicated).
  const rowId = function (row) { return String(row[idIdx] == null ? '' : row[idIdx]).trim(); };
  const idsInUse = {};
  const houseRowByIdIdx = {};
  for (let i = 0; i < kept.length; i++) { const id = rowId(kept[i]); if (id) idsInUse[id] = true; }
  for (let i = 0; i < houseRows.length; i++) {
    const id = rowId(houseRows[i]);
    if (!id) continue;
    idsInUse[id] = true;
    if (!(id in houseRowByIdIdx)) houseRowByIdIdx[id] = i;
  }
  // OTHER houses' rows by id (first in sheet order) — where a deliberate
  // house move finds the row it is taking over.
  const keptRowByIdIdx = {};
  for (let i = 0; i < kept.length; i++) {
    const id = rowId(kept[i]);
    if (id && !(id in keptRowByIdIdx)) keptRowByIdIdx[id] = i;
  }
  // Deliberate moves of the WHOLE payload (collectHouseMoves_). A row of THIS
  // house whose id is moving out is reserved for that move: no payload row of
  // this house may consume it, and it is not a stale omission to preserve.
  const moveIntents = moves || {};
  const leavingThisHouse = function (id) {
    const mv = id ? moveIntents[id] : null;
    return !!mv && mv.from === houseId && mv.to !== houseId;
  };
  // Ids the payload claims. A sheet row holding one is RESERVED for its id
  // match: neither the key-match queue nor the fromLead rename branch may
  // consume it for a different payload row.
  const payloadIds = {};
  for (let i = 0; i < patientsArr.length; i++) {
    const p = patientsArr[i] || {};
    const id = String(p.id == null ? '' : p.id).trim();
    if (id) payloadIds[id] = true;
  }
  const reservedByPayloadId = function (rowIdx) {
    const id = rowId(houseRows[rowIdx]);
    return !!id && (!!payloadIds[id] || leavingThisHouse(id));
  };
  // The id a written row ends up with (stamped onto `withHouse`, recorded in
  // idsInUse): the consumed sheet row's own id is immutable and wins; else
  // the payload's id is adopted when no other row holds it; else a fresh id
  // is minted (audited when the payload's id had to be discarded).
  const assignId = function (withHouse, sheetId, context) {
    const incoming = String(withHouse.id == null ? '' : withHouse.id).trim();
    let id;
    if (sheetId) {
      id = sheetId;
    } else if (incoming && !idsInUse[incoming]) {
      id = incoming;
    } else {
      id = 'id-' + Utilities.getUuid();
      if (incoming) {
        logAudit_('patient_id_reminted', 'replaceHousePatients_', withHouse.fromLead || '', withHouse.name || '',
          Object.assign({ houseId: houseId, incomingId: incoming, newId: id }, context || {}));
      }
    }
    idsInUse[id] = true;
    withHouse.id = id;
    return id;
  };

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
  // Stale-stamp refusals from the id-match branch and refused house moves
  // (see there) — additive response data; empty on every save with no
  // conflict.
  const conflicts = [];
  // Deliberate house moves that landed here, and `kept` indices of the rows
  // they took over (dropped from their old house at write time).
  const moved = [];
  const movedOutOfKept = {};
  // STAMP ECHO (contract comment above): id → the stamps this save wrote,
  // for every payload row whose final updatedAt differs from the one it
  // carried in. `seen` is the payload's own updatedAt, trimmed.
  const stamps = {};
  const echoStamp = function (withHouse, seen) {
    const id = String(withHouse.id == null ? '' : withHouse.id).trim();
    const at = String(withHouse.updatedAt == null ? '' : withHouse.updatedAt).trim();
    if (id && at !== seen) {
      stamps[id] = { updatedAt: at, updatedBy: String(withHouse.updatedBy == null ? '' : withHouse.updatedBy) };
    }
  };
  const consumed = {};
  // ORIGINAL sheet content of every row this save consumes, indexed by the
  // consumed row's own identity key — the exact-duplicate dedupe below
  // compares unconsumed leftovers against these.
  const consumedOriginalsByKey = {};
  const recordConsumed = function (rowIdx) {
    const k = patientKey_(houseId, houseRows[rowIdx][nameColIdx], houseRows[rowIdx][dateColIdx]);
    if (!consumedOriginalsByKey[k]) consumedOriginalsByKey[k] = [];
    consumedOriginalsByKey[k].push(houseRows[rowIdx]);
  };
  const newRows = [];
  for (let i = 0; i < patientsArr.length; i++) {
    /* THE NAME IS TRIMMED ON EVERY WRITE. patientKey_() has always trimmed,
     * so a stored "שחר חיון " already produced a DIFFERENT key on the server
     * than the client's untrimmed patientKey() computed for the same row —
     * and patientUidIndexByKey_() builds its index from the trimmed key while
     * a payment row holds the untrimmed one, which is exactly why the exact
     * match leaves such a row BLANK. Trimming what is STORED closes the gap
     * at the source: from here on there is no stray space left to disagree
     * about. Only leading/trailing whitespace; nothing inside a name. */
    const withHouse = Object.assign({}, patientsArr[i], { houseId: houseId });
    withHouse.name = String(withHouse.name == null ? '' : withHouse.name).trim();
    const key = patientKey_(houseId, withHouse.name, withHouse.date);
    const incomingId = String(withHouse.id == null ? '' : withHouse.id).trim();
    // The stamp this tab LOADED, as echoed by the round-trip — captured
    // BEFORE any branch overwrites it (carryStamps / stampNow). It is the
    // conflict-refusal witness: differing from the sheet's current stamp
    // means someone else saved after this tab loaded.
    const seenStamp = String(withHouse.updatedAt == null ? '' : withHouse.updatedAt).trim();

    // DELIBERATE HOUSE MOVE (contract comment above): the ✏ modal moved this
    // patient here from `mv.from`, and the id is not (yet) a row of this
    // house. Resolved against the row that holds the id elsewhere.
    const mv = incomingId ? moveIntents[incomingId] : null;
    if (mv && mv.to === houseId && !(incomingId in houseRowByIdIdx)) {
      const srcIdx = keptRowByIdIdx[incomingId];
      const src = srcIdx === undefined ? null : kept[srcIdx];
      const srcHouse = src ? String(src[houseColIdx] == null ? '' : src[houseColIdx]) : '';
      const srcStamp = src ? String(src[updatedAtIdx] == null ? '' : src[updatedAtIdx]).trim() : '';
      const reason = !src ? 'source_missing'
        : srcHouse !== mv.from ? 'moved_elsewhere'
          : srcStamp !== seenStamp ? 'stale'
            : '';
      if (reason) {
        // REFUSED: nothing is written and the row stays where it is.
        const refusal = {
          id: incomingId,
          name: src ? String(src[nameColIdx] == null ? '' : src[nameColIdx]) : withHouse.name,
          houseId: houseId,
          sheetUpdatedAt: srcStamp,
          sheetUpdatedBy: src ? String(src[updatedByIdx] == null ? '' : src[updatedByIdx]) : '',
          changed: ['houseId'],
          move: { from: mv.from, to: houseId, reason: reason, currentHouseId: srcHouse },
        };
        conflicts.push(refusal);
        logAudit_('patient_move_refused', 'replaceHousePatients_', withHouse.fromLead || '', refusal.name,
          Object.assign({ seenUpdatedAt: seenStamp, updatedBy: stampUser }, refusal));
        continue;
      }
      // MOVED: the old house's row is dropped at write time and the payload row
      // lands here with the SAME id and the sheet's own lead link.
      movedOutOfKept[srcIdx] = true;
      if (fromLeadIdx >= 0) withHouse.fromLead = src[fromLeadIdx];
      assignId(withHouse, incomingId, { via: 'move' });
      stampNow(withHouse); // a house move is always a real edit
      const movedRow = objectToRow_(withHouse, PATIENT_COLUMNS);
      moved.push({ id: incomingId, name: withHouse.name, fromHouseId: mv.from, toHouseId: houseId });
      logAudit_('patient_moved_house', 'replaceHousePatients_', withHouse.fromLead || '', withHouse.name || '', {
        id: incomingId, fromHouseId: mv.from, toHouseId: houseId,
        oldKey: patientKey_(mv.from, src[nameColIdx], src[dateColIdx]), newKey: key,
        changed: patientRowDiffCols_(src, movedRow), updatedBy: stampUser,
      });
      echoStamp(withHouse, seenStamp);
      newRows.push(movedRow);
      continue;
    }

    // ID MATCH (primary identity, contract comment above): the payload's
    // persisted id names an unconsumed row of THIS house → replace it in
    // place whatever the name/entry date say.
    if (incomingId && (incomingId in houseRowByIdIdx) && !consumed[houseRowByIdIdx[incomingId]]) {
      const rowIdx = houseRowByIdIdx[incomingId];
      const oldKey = patientKey_(houseId, houseRows[rowIdx][nameColIdx], houseRows[rowIdx][dateColIdx]);
      consumed[rowIdx] = true;
      recordConsumed(rowIdx);
      const sheetStamp = String(houseRows[rowIdx][updatedAtIdx] == null ? '' : houseRows[rowIdx][updatedAtIdx]).trim();
      assignId(withHouse, incomingId);
      carryStamps(withHouse, houseRows[rowIdx]);
      let newRow = objectToRow_(withHouse, PATIENT_COLUMNS);
      const changed = patientRowDiffCols_(houseRows[rowIdx], newRow);
      // CONFLICT REFUSAL (id-match only): this tab loaded an OLDER version of
      // the row (its echoed updatedAt differs from the sheet's) AND wants to
      // change real content → do NOT write. The sheet row is kept
      // byte-for-byte and the refusal is surfaced in the response's
      // `conflicts` so the client can tell the user and reload. Rows with an
      // empty seenStamp (pre-stamping tabs) or an empty sheetStamp (row
      // never stamped) keep today's last-writer-wins behavior — no refusal.
      if (changed.length > 0 && sheetStamp !== '' && seenStamp !== '' && seenStamp !== sheetStamp) {
        const conflict = {
          id: incomingId,
          name: String(houseRows[rowIdx][nameColIdx] == null ? '' : houseRows[rowIdx][nameColIdx]),
          houseId: houseId,
          sheetUpdatedAt: sheetStamp,
          sheetUpdatedBy: String(houseRows[rowIdx][updatedByIdx] == null ? '' : houseRows[rowIdx][updatedByIdx]),
          changed: changed,
        };
        conflicts.push(conflict);
        logAudit_('patient_save_conflict', 'replaceHousePatients_', withHouse.fromLead || '', conflict.name,
          Object.assign({ seenUpdatedAt: seenStamp, updatedBy: stampUser }, conflict));
        newRows.push(houseRows[rowIdx]); // the sheet's version survives untouched
        continue;
      }
      if (changed.length > 0) {
        stampNow(withHouse);
        newRow = objectToRow_(withHouse, PATIENT_COLUMNS);
      }
      if (oldKey !== key) {
        logAudit_('patient_rekeyed_via_id', 'replaceHousePatients_', withHouse.fromLead || '', withHouse.name || '', { houseId: houseId, id: incomingId, oldKey: oldKey, newKey: key, changed: changed, updatedBy: stampUser });
      } else if (changed.length > 0) {
        logAudit_('patient_edited', 'replaceHousePatients_', withHouse.fromLead || '', withHouse.name || '', { key: key, id: incomingId, changed: changed, updatedBy: stampUser });
      }
      echoStamp(withHouse, seenStamp);
      newRows.push(newRow);
      continue;
    }

    // KEY MATCH (fallback identity). Rows already consumed (by an id match
    // under a different key) or reserved for another payload row's id match
    // are skipped in the queue.
    const queue = byKey[key];
    while (queue && queue.length > 0 && (consumed[queue[0]] || reservedByPayloadId(queue[0]))) queue.shift();
    if (queue && queue.length > 0) {
      // On the sheet → normal replace, even if the key was once user-deleted
      // (a row that is back on the sheet was re-added deliberately).
      const rowIdx = queue.shift();
      consumed[rowIdx] = true;
      recordConsumed(rowIdx);
      assignId(withHouse, rowId(houseRows[rowIdx]), { via: 'key' });
      carryStamps(withHouse, houseRows[rowIdx]);
      let newRow = objectToRow_(withHouse, PATIENT_COLUMNS);
      const changed = patientRowDiffCols_(houseRows[rowIdx], newRow);
      if (changed.length > 0) {
        stampNow(withHouse);
        newRow = objectToRow_(withHouse, PATIENT_COLUMNS);
        logAudit_('patient_edited', 'replaceHousePatients_', withHouse.fromLead || '', withHouse.name || '', { key: key, id: withHouse.id, changed: changed, updatedBy: stampUser });
      }
      echoStamp(withHouse, seenStamp);
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
        return !consumed[idx] && !reservedByPayloadId(idx) &&
          !payloadKeys[patientKey_(houseId, houseRows[idx][nameColIdx], houseRows[idx][dateColIdx])];
      });
      if (matches.length > 0) {
        const idx = matches[0];
        consumed[idx] = true;
        recordConsumed(idx);
        assignId(withHouse, rowId(houseRows[idx]), { via: 'fromLead' });
        stampNow(withHouse); // a rename/entry-date edit is always a real edit
        const oldName = String(houseRows[idx][nameColIdx] == null ? '' : houseRows[idx][nameColIdx]);
        const oldKey = patientKey_(houseId, houseRows[idx][nameColIdx], houseRows[idx][dateColIdx]);
        logAudit_('patient_renamed_via_fromLead', 'replaceHousePatients_', fl, withHouse.name || '', { houseId: houseId, id: withHouse.id, oldName: oldName, newName: String(withHouse.name || ''), oldKey: oldKey, newKey: key, matches: matches.length, ambiguous: matches.length > 1, updatedBy: stampUser });
        echoStamp(withHouse, seenStamp);
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
    assignId(withHouse, '', { via: 'append' });
    stampNow(withHouse); // a new row's first write is its first edit
    logAudit_(fl ? 'promote_created' : 'patient_added', 'replaceHousePatients_', fl, withHouse.name || '', { houseId: houseId, key: key, id: withHouse.id, status: String(withHouse.status || ''), source: String(withHouse.source || ''), updatedBy: stampUser });
    echoStamp(withHouse, seenStamp);
    newRows.push(objectToRow_(withHouse, PATIENT_COLUMNS));
  }

  // Sheet rows the payload did not carry: KEEP them, audit each one — with
  // ONE exception. A leftover that shares its identity key with a row this
  // save CONSUMED and is byte-identical to that consumed row's ORIGINAL sheet
  // content carries zero information of its own: it is the immortal-duplicate
  // artifact (the corruption-repair pipeline collapsing repaired names onto
  // an existing key), and preserving it would resurrect it on every save
  // forever — the payload can never carry enough same-key rows to consume it.
  // Such a row is tombstoned ('dedupe-identical-key') and DROPPED. The
  // tombstone comes first and a failed tombstone falls back to preserving
  // (nothing is ever destroyed without its recovery copy, and an audit
  // failure must never fail the save). Same-key leftovers that DIFFER in any
  // column keep today's preserve behavior — collapseDuplicatePatientKeysNow
  // handles those explicitly, with the differences audited.
  const preservedRows = [];
  const preservedKeys = [];
  // Rows leaving this house through a deliberate move (the destination pass
  // takes them over, or refuses and leaves them here): written back exactly
  // as they are — not a stale omission, so neither tombstoned nor echoed in
  // `preserved`.
  const leavingRows = [];
  for (let i = 0; i < houseRows.length; i++) {
    if (consumed[i]) continue;
    if (leavingThisHouse(rowId(houseRows[i]))) { leavingRows.push(houseRows[i]); continue; }
    const rowKey = patientKey_(houseId, houseRows[i][nameColIdx], houseRows[i][dateColIdx]);
    const consumedTwins = consumedOriginalsByKey[rowKey];
    if (consumedTwins && consumedTwins.some(function (t) { return patientRowDiffCols_(houseRows[i], t).length === 0; })) {
      let dropped = false;
      try {
        appendPatientTombstones_([houseRows[i]], 'dedupe-identical-key', 'replaceHousePatients_');
        dropped = true;
      } catch (err) {
        try { console.warn('[dedupe] tombstone failed — leftover duplicate preserved instead: ' + ((err && err.message) || err)); } catch (_) { /* no-op */ }
      }
      if (dropped) {
        const fl = fromLeadIdx >= 0 ? String(houseRows[i][fromLeadIdx] == null ? '' : houseRows[i][fromLeadIdx]).trim() : '';
        logAudit_('patient_dedupe_collapsed', 'replaceHousePatients_', fl, String(houseRows[i][nameColIdx] == null ? '' : houseRows[i][nameColIdx]), { houseId: houseId, key: rowKey, removed: 1, byteIdentical: true });
        continue;
      }
    }
    // A preserved row that still lacks a persisted id gets one minted here
    // (unique by construction — a fresh UUID checked into idsInUse), so the
    // sheet converges to fully-identified rows through ordinary saves. The
    // tombstone below then carries the id the row will have.
    if (idIdx >= 0 && !rowId(houseRows[i])) {
      const minted = 'id-' + Utilities.getUuid();
      houseRows[i][idIdx] = minted;
      idsInUse[minted] = true;
    }
    preservedRows.push(houseRows[i]);
    preservedKeys.push(rowKey);
  }
  tombstonePreservedPatients_(preservedRows, 'saveAll');

  // Canonicalize the entry-date AND exitDate columns to a clean YYYY-MM-DD
  // string for ALL rows — kept/preserved rows (whose cell may already be a
  // coerced Date object from getValues) and new rows (a string from the
  // client — possibly a full ISO timestamp echoed from a legacy read) alike.
  // asISODate_ renders any Date / tz-marked timestamp in the spreadsheet
  // timezone, so the stored value is unambiguous local-day text — mirrors the
  // treatment leads' `created` column gets in mergeLeads_. Blank stays blank.
  const keptStaying = kept.filter(function (_, idx) { return !movedOutOfKept[idx]; });
  const finalRows = keptStaying.concat(preservedRows).concat(leavingRows).concat(newRows).map(function (row) {
    if (dateColIdx >= 0) row[dateColIdx] = asISODate_(row[dateColIdx]);
    if (exitDateColIdx >= 0) row[exitDateColIdx] = asISODate_(row[exitDateColIdx]);
    return row;
  });

  if (finalRows.length > 0) {
    // Force the entry-date and exitDate columns to plain text BEFORE writing
    // so Sheets never re-coerces "2026-06-11" into a date-typed cell. A
    // date-typed cell reads back via getValues() as a Date, serializes to the
    // client as a UTC timestamp, and drifts the day by one for UTC+2/+3 users
    // (exitDate: a 2026-05-07 discharge stored as 2026-05-06T21:00:00.000Z).
    // Text storage keeps the value a stable string end-to-end — no UTC trip,
    // no drift. Scope is the two date columns only, never the whole sheet.
    if (dateColIdx >= 0) {
      sh.getRange(2, dateColIdx + 1, finalRows.length, 1).setNumberFormat('@');
    }
    if (exitDateColIdx >= 0) {
      sh.getRange(2, exitDateColIdx + 1, finalRows.length, 1).setNumberFormat('@');
    }
    sh.getRange(2, 1, finalRows.length, PATIENT_COLUMNS.length).setValues(finalRows);
  }
  // Trim only the surplus tail AFTER the write (write-then-trim).
  if (lastRow > finalRows.length + 1) {
    sh.getRange(finalRows.length + 2, 1, lastRow - finalRows.length - 1, PATIENT_COLUMNS.length).clearContent();
  }
  return { written: newRows.length, preservedKeys: preservedKeys, suppressedKeys: suppressedKeys, skippedPromotes: skippedPromotes, conflicts: conflicts, moved: moved, stamps: stamps };
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

/* True when PatientsTombstones holds a 'user-delete' row for patient `id` of
 * house `houseId` dropped within USER_DELETE_SUPPRESS_MS. Read-only;
 * fail-closed (false) on any read error. */
function recentUserDeleteTombstoneHolds_(id, houseId) {
  try {
    const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(PATIENTS_TOMBSTONES_SHEET);
    if (!sh || sh.getLastRow() < 2) return false;
    const values = sh.getRange(2, 1, sh.getLastRow() - 1, PATIENT_TOMBSTONE_COLUMNS.length).getValues();
    const iIdx = PATIENT_TOMBSTONE_COLUMNS.indexOf('id');
    const hIdx = PATIENT_TOMBSTONE_COLUMNS.indexOf('houseId');
    const rIdx = PATIENT_TOMBSTONE_COLUMNS.indexOf('reason');
    const aIdx = PATIENT_TOMBSTONE_COLUMNS.indexOf('droppedAt');
    const now = Date.now();
    return values.some(function (row) {
      if (String(row[rIdx]) !== 'user-delete') return false;
      if (String(row[iIdx] == null ? '' : row[iIdx]).trim() !== id) return false;
      if (String(row[hIdx] == null ? '' : row[hIdx]).trim() !== houseId) return false;
      const at = Date.parse(asTimestampText_(row[aIdx]));
      return isFinite(at) && now - at <= USER_DELETE_SUPPRESS_MS;
    });
  } catch (err) {
    return false;
  }
}

/* ===== Permanent patient-row delete (dedicated action) =====
 *
 * The occupancy tab's ✕ button used to delete by OMISSION — drop the patient
 * from the client's list and let saveAll's whole-house replace lose the row.
 * Merge-don't-drop closed that channel (omission now preserves), so genuine
 * deletion is a first-class action, mirroring removeLead_'s safe sequence,
 * keyed by the persisted patient `id` first and by patientKey_ as fallback:
 *   0. `patient.id` given and held by a row of the given house → EXACTLY that
 *      row (matchedBy 'id') — one of several identical-key duplicates can now
 *      be deleted on its own. An id seen only in ANOTHER house, or not on the
 *      sheet at all (stale tab, pre-foundation row), falls through to the key
 *      path — never a cross-house delete.
 *   1. Peek FIRST (read-only): no row matches the key → refuse, touch
 *      NOTHING. The client surfaces the error and rolls its state back.
 *   2. Tombstone the matched row(s) — reason 'user-delete' — BEFORE the
 *      delete, FAIL-HARD: if the audit write throws, the delete is aborted
 *      and the row survives. Nothing is ever destroyed without its recovery
 *      copy. (Deliberate opposite of tombstonePreservedPatients_'s fail-soft
 *      contract, where the row is being kept anyway.)
 *   3. Rewrite the kept rows, then trim the surplus tail (write-then-trim).
 * All under the script lock. On the KEY path duplicate identity keys delete
 * ALL matching rows — without an id they are indistinguishable by
 * construction. For USER_DELETE_SUPPRESS_MS
 * afterwards, the saveAll merge drops stale payload rows carrying this key so
 * another open tab can't resurrect the patient. */
function deletePatientRow_(patient, user, actor) {
  if (!patient || !patient.houseId || !patient.name) {
    return { ok: false, error: 'missing_patient' };
  }
  const lock = LockService.getScriptLock();
  if (lock.tryLock(10000) !== true) return lockBusy_('deletePatientRow_');
  try {
    const sh = getOrCreateSheet_(PATIENTS_SHEET, PATIENT_COLUMNS);
    const houseColIdx = PATIENT_COLUMNS.indexOf('houseId');
    const nameColIdx  = PATIENT_COLUMNS.indexOf('name');
    const dateColIdx  = PATIENT_COLUMNS.indexOf('date');
    const idIdx       = PATIENT_COLUMNS.indexOf('id');
    const key = patientKey_(patient.houseId, patient.name, patient.date);
    const wantId = String(patient.id == null ? '' : patient.id).trim();
    const wantHouse = String(patient.houseId == null ? '' : patient.houseId).trim();
    const lastRow = sh.getLastRow();
    /* A RETRY of a delete whose answer was lost: this id's row is gone and a
     * fresh 'user-delete' tombstone of the same house holds it. Answer the
     * delete, write nothing (CHANGELOG-write-path-hardening.md). */
    const replayDeleted = function () {
      return wantId && recentUserDeleteTombstoneHolds_(wantId, wantHouse)
        ? { ok: true, deleted: 0, alreadyDeleted: true, key: key, id: wantId, matchedBy: 'id' }
        : { ok: false, error: 'patient_not_found' };
    };
    if (lastRow < 2) return replayDeleted();

    const values = sh.getRange(2, 1, lastRow - 1, PATIENT_COLUMNS.length).getValues();
    let kept = [];
    let matched = [];
    let matchedBy = 'key';
    if (wantId && idIdx >= 0) {
      for (let i = 0; i < values.length; i++) {
        const row = values[i];
        const rid = String(row[idIdx] == null ? '' : row[idIdx]).trim();
        if (rid === wantId && String(row[houseColIdx] == null ? '' : row[houseColIdx]).trim() === wantHouse) matched.push(row);
        else kept.push(row);
      }
      if (matched.length > 0) matchedBy = 'id';
      else { kept = []; matched = []; }
    }
    if (matchedBy === 'key') {
      for (let i = 0; i < values.length; i++) {
        const row = values[i];
        if (patientKey_(row[houseColIdx], row[nameColIdx], row[dateColIdx]) === key) matched.push(row);
        else kept.push(row);
      }
    }
    if (matched.length === 0) return replayDeleted();

    // Tombstone BEFORE delete — fail-HARD (no catch): an audit failure aborts
    // the whole action via handle_'s exception envelope and the row survives.
    // The deleter is stamped onto the tombstone (who/when of the delete).
    appendPatientTombstones_(matched, 'user-delete', 'deletePatientRow', String(user == null ? '' : user));

    if (kept.length > 0) {
      sh.getRange(2, 1, kept.length, PATIENT_COLUMNS.length).setValues(kept);
    }
    if (lastRow > kept.length + 1) {
      sh.getRange(kept.length + 2, 1, lastRow - kept.length - 1, PATIENT_COLUMNS.length).clearContent();
    }
    logAudit_('patient_deleted', 'deletePatientRow_', patient.fromLead || '', patient.name || '', { key: key, id: matchedBy === 'id' ? wantId : '', matchedBy: matchedBy, deleted: matched.length, updatedBy: String(user == null ? '' : user) }, actor === undefined ? String(user == null ? '' : user) : actor);
    return { ok: true, deleted: matched.length, key: key, id: matchedBy === 'id' ? wantId : '', matchedBy: matchedBy };
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

/* Patient identity foundation — Patients-sheet twin of the lead-id backfill
 * above. Only if at least one content row has a blank `id` does it take the
 * script lock and delegate to backfillMissingIds_ (so a concurrent saveAll
 * rewrite cannot shift rows under the per-cell writes); with every id present
 * it performs ZERO writes and takes no lock — the steady state after the
 * first read following the column's arrival. Returns the count backfilled. */
function backfillPatientIdsLocked_(sh) {
  const idIdx = PATIENT_COLUMNS.indexOf('id');
  if (idIdx < 0) return 0;
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return 0;
  const values = sh.getRange(2, 1, lastRow - 1, PATIENT_COLUMNS.length).getValues();
  let needs = false;
  for (let i = 0; i < values.length && !needs; i++) {
    const row = values[i];
    if (String(row[idIdx] == null ? '' : row[idIdx]).trim() !== '') continue;
    for (let j = 0; j < row.length; j++) {
      if (row[j] !== '' && row[j] !== null) { needs = true; break; }
    }
  }
  if (!needs) return 0;
  const lock = LockService.getScriptLock();
  // Busy lock → skip this pass (nothing written); the next read retries.
  if (lock.tryLock(10000) !== true) return 0;
  try {
    return backfillMissingIds_(sh, PATIENT_COLUMNS);
  } finally {
    try { lock.releaseLock(); } catch (_) { /* no-op */ }
  }
}

/* ===== Stable source identity for the accounting contract =====
 *
 * Everything below follows the backfillPatientIdsLocked_ discipline from
 * PR #112 exactly, because the failure it prevents is the same one:
 *   - PRE-SCAN WITHOUT THE LOCK. If every cell is already filled the function
 *     performs ZERO writes and takes NO lock — the steady state, hit on every
 *     read after the first one following the column's arrival.
 *   - Only when something is missing does it take the SCRIPT lock and re-read
 *     inside it, so a concurrent upsert/rewrite cannot shift rows under the
 *     per-cell writes.
 *   - PER-CELL writes, never a whole-sheet rewrite.
 *   - IDEMPOTENT: a second run fills 0. A value already present is NEVER
 *     overwritten — that is what "minted once, then permanent" means.
 *   - Fully-empty trailing rows are skipped (readSheet_ ignores them too).
 */

/* Now, as an Israel-time ISO-8601 timestamp WITH AN EXPLICIT OFFSET:
 * '2026-09-22T14:03:11+03:00'. Deliberately not new Date().toISOString() (the
 * repo's older stamps): a bare 'Z' timestamp forces every reader to know the
 * Israel offset AND which side of the DST switch the instant fell on. With the
 * offset written down the value is unambiguous to a human and to Date.parse.
 * The project timezone is pinned to Asia/Jerusalem in appsscript.json; the
 * spreadsheet timezone is preferred so a stamp and a sheet date agree. */
function israelTimestamp_(now) {
  var tz;
  try {
    tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone() || 'Asia/Jerusalem';
  } catch (_) { tz = 'Asia/Jerusalem'; }
  var d = (now instanceof Date && !isNaN(now.getTime())) ? now : new Date();
  /* RFC-822 offset ('+0300') rather than SimpleDateFormat's ISO 'XXX' token:
   * 'Z' is supported by every SimpleDateFormat there has ever been, so the
   * stamp cannot depend on the runtime's pattern vocabulary. The colon is
   * inserted here to make it ISO-8601 — the form Date.parse and a human both
   * read without ambiguity. */
  var s = Utilities.formatDate(d, tz, "yyyy-MM-dd'T'HH:mm:ssZ");
  return String(s).replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
}

/* How many cells one invocation may mint. The Patients backfill needs no such
 * bound — that sheet holds tens of rows — but Payments holds one row per
 * patient per month for years, and the per-cell writes this pattern mandates
 * are ~20ms each. An unbounded first read after deploy could therefore run
 * into the Apps Script 6-minute execution limit, and getPayments_ is the read
 * behind Vered's גבייה tab: a timeout there looks exactly like an outage.
 * Bounded, it converges over the next few reads instead and then performs zero
 * writes forever. Idempotent either way. */
const IDENTITY_BACKFILL_MAX_PER_RUN = 1000;

/* Mint a fresh opaque uid into every content row whose `column` cell is blank.
 * The twin of backfillMissingIds_, generalized to a named column + prefix so
 * Payments (paymentUid) and Credits (creditUid) share ONE implementation
 * rather than two that can drift. Stops after `max` cells (see above).
 * Returns the count filled. */
function backfillMissingUids_(sh, columns, column, prefix, max) {
  const cap = (max === undefined || max === null) ? IDENTITY_BACKFILL_MAX_PER_RUN : max;
  const idx = columns.indexOf(column);
  if (idx < 0) return 0;
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return 0;
  const values = sh.getRange(2, 1, lastRow - 1, columns.length).getValues();
  const col = idx + 1;
  let filled = 0;
  for (let i = 0; i < values.length; i++) {
    const row = values[i];
    if (String(row[idx] == null ? '' : row[idx]).trim() !== '') continue;
    let hasContent = false;
    for (let j = 0; j < row.length; j++) {
      if (row[j] !== '' && row[j] !== null) { hasContent = true; break; }
    }
    if (!hasContent) continue; // fully-empty row — leave it alone
    const cell = sh.getRange(i + 2, col, 1, 1);
    cell.setNumberFormat('@');  // uids are opaque text — never let Sheets coerce
    cell.setValue(prefix + Utilities.getUuid());
    filled++;
    if (filled >= cap) break;
  }
  return filled;
}

/* houseId::name::entryDate  →  the PERSISTED Patients `id`, for every row of
 * the Patients sheet that has both. This is the ONLY join used to fill
 * patientUid, and it is an EXACT match on the full billing triple that the
 * Payments `patientId` cell already stores — not a name lookup. A key claimed
 * by two patient rows is dropped from the index entirely: an ambiguous link is
 * worse than no link, and no link is what a blank patientUid means. */
function patientUidIndexByKey_() {
  // A READ of Patients (the fill writes Payments cells, never Patients), so
  // no whole-column re-format of Patients here — see sheetForRead_.
  const sh = sheetForRead_(PATIENTS_SHEET, PATIENT_COLUMNS);
  const rows = readSheet_(sh, PATIENT_COLUMNS);
  const index = {};
  const ambiguous = {};
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const uid = String(r.id == null ? '' : r.id).trim();
    if (!uid) continue;
    const key = patientKey_(r.houseId, r.name, asISODate_(r.date));
    if (!key || key === '::::') continue;
    if (index[key] !== undefined && index[key] !== uid) { ambiguous[key] = true; continue; }
    index[key] = uid;
  }
  Object.keys(ambiguous).forEach(function (k) { delete index[k]; });
  return index;
}

/* Fill the blank patientUid cells of the Payments sheet from that index.
 * Called only from inside the locked backfill below. A row whose triple
 * resolves to nothing is LEFT BLANK — never guessed, never name-matched. */
function fillPaymentPatientUids_(sh, max) {
  const cap = (max === undefined || max === null) ? IDENTITY_BACKFILL_MAX_PER_RUN : max;
  const uidIdx = PAYMENT_COLUMNS.indexOf('patientUid');
  const keyIdx = PAYMENT_COLUMNS.indexOf('patientId');
  if (uidIdx < 0 || keyIdx < 0) return 0;
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return 0;
  const values = sh.getRange(2, 1, lastRow - 1, PAYMENT_COLUMNS.length).getValues();
  let index = null;
  let filled = 0;
  for (let i = 0; i < values.length; i++) {
    const row = values[i];
    if (String(row[uidIdx] == null ? '' : row[uidIdx]).trim() !== '') continue;
    const key = String(row[keyIdx] == null ? '' : row[keyIdx]).trim();
    if (!key) continue;
    if (index === null) index = patientUidIndexByKey_();  // read Patients at most once
    const uid = index[key];
    if (!uid) continue;
    const cell = sh.getRange(i + 2, uidIdx + 1, 1, 1);
    cell.setNumberFormat('@');
    cell.setValue(uid);
    filled++;
    if (filled >= cap) break;
  }
  return filled;
}

/* Which billing keys patientUidIndexByKey_() resolves — as a set of
 * fastHash_ values, for the PRE-SCAN only, served from the script cache
 * (READ_CACHE_PATIENT_KEYS) when present. A stale or colliding set can only
 * change the pre-scan's yes/no — never a written cell: the fill runs under
 * the lock against a FRESH patientUidIndexByKey_(). Removed by
 * invalidateReadCaches_() after every write action, TTL-bounded otherwise. */
function resolvablePatientKeyHashes_() {
  let hashes = cacheGetJson_(READ_CACHE_PATIENT_KEYS);
  if (!Array.isArray(hashes)) {
    hashes = Object.keys(patientUidIndexByKey_()).map(fastHash_);
    cachePutJson_(READ_CACHE_PATIENT_KEYS, hashes, READ_CACHE_PATIENT_KEYS_TTL);
  }
  const set = Object.create(null);
  for (let i = 0; i < hashes.length; i++) set[hashes[i]] = true;
  return set;
}

/* Does the Payments sheet have any content row missing a paymentUid, or any
 * with a RESOLVABLE-but-blank patientUid? Cheap pre-scan, no lock, no writes.
 *
 * "Resolvable" is checked, not assumed: a payment whose billing triple
 * matches no patient row (a patient long since discharged, renamed or
 * deleted) keeps a blank patientUid forever — that is what blank means —
 * and must not send EVERY read into the locked backfill only to fill
 * nothing. The Patients index is built lazily, only when such a row exists.
 * `values` (optional) are the Payments rows the caller already read, so the
 * sheet is not read twice. */
function paymentIdentityNeedsBackfill_(sh, values) {
  const pIdx = PAYMENT_COLUMNS.indexOf('paymentUid');
  const uIdx = PAYMENT_COLUMNS.indexOf('patientUid');
  const kIdx = PAYMENT_COLUMNS.indexOf('patientId');
  if (pIdx < 0 || uIdx < 0 || kIdx < 0) return false;
  if (!values) {
    const lastRow = sh.getLastRow();
    if (lastRow < 2) return false;
    values = sh.getRange(2, 1, lastRow - 1, PAYMENT_COLUMNS.length).getValues();
  }
  let resolvable = null;
  for (let i = 0; i < values.length; i++) {
    const row = values[i];
    let hasContent = false;
    for (let j = 0; j < row.length; j++) {
      if (row[j] !== '' && row[j] !== null) { hasContent = true; break; }
    }
    if (!hasContent) continue;
    if (String(row[pIdx] == null ? '' : row[pIdx]).trim() === '') return true;
    if (String(row[uIdx] == null ? '' : row[uIdx]).trim() !== '') continue;
    const key = String(row[kIdx] == null ? '' : row[kIdx]).trim();
    if (!key) continue;
    if (resolvable === null) resolvable = resolvablePatientKeyHashes_();
    if (resolvable[fastHash_(key)]) return true;
  }
  return false;
}

/* Payments identity foundation — the Payments-sheet twin of
 * backfillPatientIdsLocked_ (PR #112), same contract to the letter.
 * `values` (optional): the caller's own read of the sheet, for the pre-scan.
 * Returns { paymentUids, patientUids } counts. */
function backfillPaymentIdentityLocked_(sh, values) {
  if (!paymentIdentityNeedsBackfill_(sh, values)) return { paymentUids: 0, patientUids: 0 };
  const lock = LockService.getScriptLock();
  // Busy lock → skip this pass (nothing written); the next read retries.
  if (lock.tryLock(10000) !== true) return { paymentUids: 0, patientUids: 0 };
  try {
    return {
      paymentUids: backfillMissingUids_(sh, PAYMENT_COLUMNS, 'paymentUid', PAYMENT_UID_PREFIX),
      patientUids: fillPaymentPatientUids_(sh),
    };
  } finally {
    try { lock.releaseLock(); } catch (_) { /* no-op */ }
  }
}

/* Credits identity foundation — same contract again. Credit behaviour is
 * otherwise untouched: `id`, the edit rules, the stale-save refusal and every
 * figure stay exactly as they were. */
function creditUidsNeedBackfill_(sh, values) {
  const idx = CREDIT_COLUMNS.indexOf('creditUid');
  if (idx < 0) return false;
  if (!values) {
    const lastRow = sh.getLastRow();
    if (lastRow < 2) return false;
    values = sh.getRange(2, 1, lastRow - 1, CREDIT_COLUMNS.length).getValues();
  }
  return blankInContentRows_(values, CREDIT_COLUMNS, 'creditUid');
}

/* `values` (optional): the caller's own read of the sheet, for the pre-scan. */
function backfillCreditUidsLocked_(sh, values) {
  if (!creditUidsNeedBackfill_(sh, values)) return 0;
  const lock = LockService.getScriptLock();
  // Busy lock → skip this pass (nothing written); the next read retries.
  if (lock.tryLock(10000) !== true) return 0;
  try {
    return backfillMissingUids_(sh, CREDIT_COLUMNS, 'creditUid', CREDIT_UID_PREFIX);
  } finally {
    try { lock.releaseLock(); } catch (_) { /* no-op */ }
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

/* ===== ONE-TIME MANUAL REPAIR — patient exitDate timezone drift =====
 *
 * The bug: replaceHousePatients_ text-forced the `date` column before writing
 * but NOT `exitDate`, so Sheets coerced a discharge date such as "2026-05-07"
 * into a date-typed cell at local midnight; getValues() handed it back as a
 * Date, JSON serialized it as UTC ("2026-05-06T21:00:00.000Z" — Israel is
 * UTC+2/+3) and the day drifted −1. The same value could then be persisted
 * as that timestamp TEXT by a later save. The prevention (text-force +
 * asISODate_ on every write and read) ships alongside; these two functions
 * clean the cells already on the sheets.
 *
 * Both are PUBLIC (Run dropdown — Apps Script hides underscore names from
 * the editor) and NOT reachable over HTTP: handle_ dispatches on a fixed
 * allow-list of `action` literals that never names them (guard-tested, same
 * argument as repairLeadVisitTimes). Neither is attached to any trigger.
 *
 * Scope: the `exitDate` column — and, in the same pass, the entry `date`
 * column — of Patients, DischargedPatients and PatientsTombstones. `date`
 * rides along because this change also text-forces it at sheet-ensure time
 * on the discharged sheet (where it was never forced): a whole-column plain-
 * text format makes Sheets hand a legacy date-typed cell back as a numeric
 * SERIAL, so every such cell must be rewritten as text too, not just read
 * defensively. A cell is DRIFTED when it holds a Date object, a Sheets date
 * serial number, or text matching /^\d{4}-\d{2}-\d{2}T/ (an ISO timestamp).
 * Each drifted cell is rewritten as the LOCAL (Asia/Jerusalem — the
 * spreadsheet timezone) 'YYYY-MM-DD' via asISODate_, the column having been
 * forced to plain text FIRST so the string cannot be re-coerced. Clean
 * 'YYYY-MM-DD' text and blank cells are never touched.
 *
 * This is a FORMAT fix, not an edit: updatedAt/updatedBy are deliberately
 * NOT re-stamped (the row's content — the discharge day the user chose —
 * does not change; only its storage form does). Runs under the script lock
 * so it cannot race a saveAll rewrite. Idempotent: a second run rewrites 0
 * cells and logs nothing to the AuditLog. Logger summary per sheet (rows
 * scanned / rewritten / examples) and one 'exit_date_repaired' AuditLog
 * event with the counts when anything was rewritten. Returns the summary.
 *
 * previewPatientExitDatesNow is the same scan with ZERO writes (no format
 * change, no values, no audit row): run it first to see what the repair
 * would do, and again afterwards to confirm 0. */
function repairPatientExitDatesNow() {
  return runPatientExitDateRepair_(false);
}
function previewPatientExitDatesNow() {
  return runPatientExitDateRepair_(true);
}

/* The three sheets the repair covers, with their positional column lists. */
function exitDateRepairTargets_() {
  return [
    { name: PATIENTS_SHEET,            columns: PATIENT_COLUMNS },
    { name: DISCHARGED_PATIENTS_SHEET, columns: DISCHARGED_PATIENT_COLUMNS },
    { name: PATIENTS_TOMBSTONES_SHEET, columns: PATIENT_TOMBSTONE_COLUMNS },
  ];
}
/* The date columns the repair rewrites on each target sheet. */
const EXIT_DATE_REPAIR_COLUMNS = ['exitDate', 'date'];

/* Is this date cell value in the drifted class the repair rewrites? */
function isDriftedExitDateCell_(v) {
  if (v === undefined || v === null || v === '') return false;
  if (Object.prototype.toString.call(v) === '[object Date]') return true;
  if (typeof v === 'number') return isSheetDateSerial_(v);
  return /^\d{4}-\d{2}-\d{2}T/.test(String(v));
}

function runPatientExitDateRepair_(dryRun) {
  const tag = dryRun ? 'previewPatientExitDatesNow' : 'repairPatientExitDatesNow';
  const lock = LockService.getScriptLock();
  if (lock.tryLock(10000) !== true) throw new Error('runPatientExitDateRepair_: ' + LOCK_BUSY_MESSAGE);
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const summary = { dryRun: !!dryRun, sheets: {}, scanned: 0, rewritten: 0 };
    exitDateRepairTargets_().forEach(function (t) {
      const per = { scanned: 0, rewritten: 0, examples: [], columns: {} };
      summary.sheets[t.name] = per;
      const sh = ss.getSheetByName(t.name);
      if (!sh) {
        Logger.log(tag + ': ' + t.name + ' — sheet absent, skipped.');
        return;
      }
      const lastRow = sh.getLastRow();
      if (lastRow < 2) {
        Logger.log(tag + ': ' + t.name + ' — no data rows.');
        return;
      }
      EXIT_DATE_REPAIR_COLUMNS.forEach(function (colName) {
        const colIdx = t.columns.indexOf(colName);
        if (colIdx < 0) return;
        const col = { scanned: 0, rewritten: 0 };
        per.columns[colName] = col;
        // Read the raw cells FIRST (a Date-typed cell must be seen as a Date
        // before any format change), then decide, then force text, then write.
        const vals = sh.getRange(2, colIdx + 1, lastRow - 1, 1).getValues();
        const fixes = [];
        for (let i = 0; i < vals.length; i++) {
          const v = vals[i][0];
          if (v === '' || v === null || v === undefined) continue;
          col.scanned++;
          if (!isDriftedExitDateCell_(v)) continue;
          const fixed = asISODate_(v);
          if (!/^\d{4}-\d{2}-\d{2}$/.test(fixed)) continue; // unrecoverable — leave it
          fixes.push({ row: i + 2, before: v, after: fixed });
        }
        col.rewritten = fixes.length;
        fixes.slice(0, 5).forEach(function (f) {
          per.examples.push({ column: colName, row: f.row, before: asTimestampText_(f.before), after: f.after });
        });
        if (!dryRun && fixes.length > 0) {
          // Whole column to plain text first (idempotent, same guard the
          // ensure step applies), then each drifted cell alone — never a
          // whole-column rewrite, so clean cells and every other column stay
          // byte-for-byte untouched; updatedAt/updatedBy are NOT re-stamped.
          forceColumnsText_(sh, t.columns, [colName]);
          fixes.forEach(function (f) {
            const cell = sh.getRange(f.row, colIdx + 1, 1, 1);
            cell.setNumberFormat('@');
            cell.setValue(f.after);
          });
        }
        per.scanned += col.scanned;
        per.rewritten += col.rewritten;
      });
      summary.scanned += per.scanned;
      summary.rewritten += per.rewritten;
      Logger.log(tag + ': ' + t.name + ' — ' + per.scanned + ' non-blank date cell(s) scanned (' +
        Object.keys(per.columns).map(function (c) { return c + ' ' + per.columns[c].scanned + '/' + per.columns[c].rewritten; }).join(', ') +
        ' scanned/drifted), ' + per.rewritten + (dryRun ? ' would be rewritten' : ' rewritten') +
        (per.examples.length ? '. Examples: ' + JSON.stringify(per.examples) : '.'));
    });
    if (!dryRun && summary.rewritten > 0) {
      logAudit_('exit_date_repaired', 'repairPatientExitDatesNow', '', '', {
        scanned: summary.scanned,
        rewritten: summary.rewritten,
        perSheet: Object.keys(summary.sheets).reduce(function (acc, k) {
          acc[k] = { scanned: summary.sheets[k].scanned, rewritten: summary.sheets[k].rewritten, columns: summary.sheets[k].columns };
          return acc;
        }, {}),
        stampsRestamped: false,
      });
    }
    Logger.log(tag + ': total ' + summary.scanned + ' scanned, ' + summary.rewritten +
      (dryRun ? ' would be rewritten (no writes performed).' : ' rewritten.'));
    return summary;
  } finally {
    try { lock.releaseLock(); } catch (_) { /* no-op */ }
  }
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
  Logger.log('Note: this scanner groups by fromLead only — rows sharing the same IDENTITY KEY ' +
    '(houseId::name::entryDate) with blank or differing fromLead are invisible to it; ' +
    'run findDuplicatePatientKeysNow for those.');
  return dupes;
}

/* Group a Patients values array (data rows, no header) by identity key.
 * Returns only the DUPLICATE groups — [{key, indexes}] with `indexes` into
 * `values`, sheet order — in first-seen order. Shared by the two dedupe
 * entry points below. */
function patientKeyGroups_(values) {
  const houseIdx = PATIENT_COLUMNS.indexOf('houseId');
  const nameIdx  = PATIENT_COLUMNS.indexOf('name');
  const dateIdx  = PATIENT_COLUMNS.indexOf('date');
  const byKey = {};
  const order = [];
  for (let i = 0; i < values.length; i++) {
    // Fully-empty rows (cleared tails, stray blanks) are not patients —
    // skip them so they can never group under the empty key (mirrors
    // corruptionReadRows_ / readSheet_).
    let hasContent = false;
    for (let j = 0; j < values[i].length; j++) {
      if (values[i][j] !== '' && values[i][j] !== null) { hasContent = true; break; }
    }
    if (!hasContent) continue;
    const key = patientKey_(values[i][houseIdx], values[i][nameIdx], values[i][dateIdx]);
    if (!byKey[key]) { byKey[key] = []; order.push(key); }
    byKey[key].push(i);
  }
  const groups = [];
  order.forEach(function (key) {
    if (byKey[key].length > 1) groups.push({ key: key, indexes: byKey[key] });
  });
  return groups;
}

/* Which row of a same-key duplicate group a collapse KEEPS: the first row
 * (sheet order) carrying a non-empty fromLead — the lead link is the only
 * identity the rows can differ in that other features (promotion dedupe,
 * discharge heal) rely on — else simply the first row. `rows` are raw
 * Patients row arrays; returns an index INTO THE GROUP. */
function dedupeKeepIndex_(rows) {
  const flIdx = PATIENT_COLUMNS.indexOf('fromLead');
  for (let i = 0; i < rows.length; i++) {
    if (String(rows[i][flIdx] == null ? '' : rows[i][flIdx]).trim() !== '') return i;
  }
  return 0;
}

/* MANUAL DETECTION, DRY RUN — run from the Apps Script editor (Run dropdown).
 *
 * READ-ONLY companion to findDuplicatePatientIdsNow for the OTHER duplicate
 * class: rows sharing the same IDENTITY KEY (houseId::name::entryDate, the
 * Patients sheet's only row identity). These were minted when the corruption
 * repair collapsed a repaired name onto a key that already existed, have
 * blank/differing fromLead (so the id scanner never sees them), survive every
 * saveAll (the merge preserves unconsumed same-key rows), and ✕ on any one
 * card would delete them all (deletePatientRow_ deletes by key). Logs every
 * group of 2+ same-key rows — row numbers, fromLead, status, whether the
 * rows are byte-identical (patientRowDiffCols_ empty — the same date-aware
 * normalization the saveAll changed-columns diff uses), and which row
 * collapseDuplicatePatientKeysNow would KEEP. ZERO writes (getSheetByName
 * only — cannot even create a sheet). Intentionally PUBLIC (no trailing
 * underscore) so it shows in the editor's Run dropdown; NOT exposed over
 * HTTP — handle_'s fixed action allow-list never names it (guard-tested,
 * same non-exposure argument as repairLeadVisitTimes). Returns the groups
 * (also handy for tests). */
function findDuplicatePatientKeysNow() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(PATIENTS_SHEET);
  if (!sh) {
    Logger.log('findDuplicatePatientKeysNow: no Patients sheet.');
    return [];
  }
  const lastRow = sh.getLastRow();
  if (lastRow < 2) {
    Logger.log('findDuplicatePatientKeysNow: no data rows.');
    return [];
  }
  const values = sh.getRange(2, 1, lastRow - 1, PATIENT_COLUMNS.length).getValues();
  const flIdx = PATIENT_COLUMNS.indexOf('fromLead');
  const stIdx = PATIENT_COLUMNS.indexOf('status');
  const groups = patientKeyGroups_(values);
  let surplus = 0;
  const out = groups.map(function (g) {
    const rows = g.indexes.map(function (i) { return values[i]; });
    const keep = dedupeKeepIndex_(rows);
    const keepRow = g.indexes[keep] + 2;
    const identical = rows.every(function (row) { return patientRowDiffCols_(row, rows[keep]).length === 0; });
    surplus += rows.length - 1;
    const describe = g.indexes.map(function (i) {
      return { row: i + 2, // 1-based sheet row (header is row 1)
               fromLead: String(values[i][flIdx] == null ? '' : values[i][flIdx]).trim(),
               status:   String(values[i][stIdx] == null ? '' : values[i][stIdx]) };
    });
    Logger.log('DUPLICATE KEY ' + g.key + ' on ' + rows.length + ' rows: ' +
      describe.map(function (r) { return 'row ' + r.row + ' (fromLead "' + r.fromLead + '", ' + r.status + ')'; }).join('; ') +
      ' — ' + (identical ? 'byte-identical' : 'NOT byte-identical (differing columns beyond the key)') +
      '; a collapse would KEEP row ' + keepRow + '.');
    return { key: g.key, rows: describe, identical: identical, keepRow: keepRow };
  });
  Logger.log('findDuplicatePatientKeysNow: ' + out.length + ' duplicate key group(s) across ' + values.length +
    ' data rows (' + surplus + ' surplus row(s) a collapse would remove). No writes performed. ' +
    'To collapse: run collapseDuplicatePatientKeysNow.');
  return out;
}

/* MANUAL REPAIR — run from the Apps Script editor (Run dropdown) after
 * reviewing findDuplicatePatientKeysNow's log.
 *
 * Collapses every same-identity-key duplicate group on the Patients sheet to
 * ONE row: keeps the first row (sheet order) with a non-empty fromLead, else
 * the first row (dedupeKeepIndex_). Every removed row is tombstoned FIRST via
 * appendPatientTombstones_ (reason 'dedupe-identical-key') — fail-HARD, the
 * same contract as deletePatientRow_: if the tombstone write throws, nothing
 * has been removed. The sheet is then rewritten without the removed rows
 * (write-then-trim — a crash between the two steps leaves duplicate tail
 * rows, visible and re-collapsible, never an emptied sheet). Groups whose
 * rows are NOT byte-identical are still collapsed — nothing is lost, the
 * tombstones hold the full rows — but the differing columns are named in the
 * audit details so they can be consulted. One 'patient_dedupe_collapsed'
 * audit event per group (key, kept row, removed count). Runs under the
 * script lock. PUBLIC (Run dropdown) and NOT exposed over HTTP — handle_'s
 * fixed action allow-list never names it (guard-tested). Idempotent: a
 * second run finds 0 groups. */
function collapseDuplicatePatientKeysNow() {
  const lock = LockService.getScriptLock();
  if (lock.tryLock(10000) !== true) throw new Error('collapseDuplicatePatientKeysNow: ' + LOCK_BUSY_MESSAGE);
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sh = ss.getSheetByName(PATIENTS_SHEET);
    if (!sh) {
      Logger.log('collapseDuplicatePatientKeysNow: no Patients sheet.');
      return { groups: 0, removed: 0 };
    }
    const lastRow = sh.getLastRow();
    if (lastRow < 2) {
      Logger.log('collapseDuplicatePatientKeysNow: no data rows.');
      return { groups: 0, removed: 0 };
    }
    const values = sh.getRange(2, 1, lastRow - 1, PATIENT_COLUMNS.length).getValues();
    const flIdx   = PATIENT_COLUMNS.indexOf('fromLead');
    const nameIdx = PATIENT_COLUMNS.indexOf('name');
    const groups = patientKeyGroups_(values);
    if (groups.length === 0) {
      Logger.log('collapseDuplicatePatientKeysNow: no duplicate identity keys — nothing to collapse.');
      return { groups: 0, removed: 0 };
    }

    const removeIdx = {};
    const auditEntries = [];
    groups.forEach(function (g) {
      const rows = g.indexes.map(function (i) { return values[i]; });
      const keep = dedupeKeepIndex_(rows);
      const keptRow = values[g.indexes[keep]];
      const differing = {};
      g.indexes.forEach(function (idx, j) {
        if (j === keep) return;
        removeIdx[idx] = true;
        patientRowDiffCols_(values[idx], keptRow).forEach(function (c) { differing[c] = true; });
      });
      auditEntries.push({
        key: g.key,
        keptRow: g.indexes[keep] + 2,
        removed: g.indexes.length - 1,
        fromLead: String(keptRow[flIdx] == null ? '' : keptRow[flIdx]).trim(),
        name: String(keptRow[nameIdx] == null ? '' : keptRow[nameIdx]),
        differingColumns: Object.keys(differing),
      });
    });

    const removedRows = [];
    const kept = [];
    for (let i = 0; i < values.length; i++) {
      if (removeIdx[i]) removedRows.push(values[i]); else kept.push(values[i]);
    }

    // Tombstone BEFORE the rewrite — fail-HARD (no catch): if this throws,
    // the Patients sheet has not been touched and every row survives.
    appendPatientTombstones_(removedRows, 'dedupe-identical-key', 'collapseDuplicatePatientKeysNow');

    if (kept.length > 0) {
      sh.getRange(2, 1, kept.length, PATIENT_COLUMNS.length).setValues(kept);
    }
    if (lastRow > kept.length + 1) {
      sh.getRange(kept.length + 2, 1, lastRow - kept.length - 1, PATIENT_COLUMNS.length).clearContent();
    }

    auditEntries.forEach(function (e) {
      logAudit_('patient_dedupe_collapsed', 'collapseDuplicatePatientKeysNow', e.fromLead, e.name, {
        key: e.key, keptRow: e.keptRow, removed: e.removed,
        byteIdentical: e.differingColumns.length === 0,
        differingColumns: e.differingColumns,
      });
    });

    Logger.log('collapseDuplicatePatientKeysNow: ' + groups.length + ' duplicate key group(s) found, ' +
      removedRows.length + ' surplus row(s) removed (each tombstoned first, reason dedupe-identical-key). ' +
      'See the AuditLog sheet for the per-group trail.');
    return { groups: groups.length, removed: removedRows.length };
  } finally {
    try { lock.releaseLock(); } catch (_) { /* no-op */ }
  }
}

/* ===== Corrupted-rows cleanup (U+FFFD Hebrew-name corruption) =====
 *
 * The server.js UTF-8 chunk-split bug (fixed in PR #102) wrote U+FFFD
 * replacement characters into Hebrew free text between 2026-07-27 and the
 * fix, and the resulting name changes also spawned duplicate Patients rows
 * (name is part of row identity). These utilities find the damage, PROPOSE
 * repairs, and apply ONLY what Sandra has explicitly approved row-by-row in
 * the hidden RepairPlan sheet. All three entry points are PUBLIC (Run
 * dropdown) and unreachable over HTTP — handle_'s fixed action allow-list
 * never names them (same non-exposure argument as repairLeadVisitTimes;
 * guard-tested).
 *
 * Proposal tiers, in priority order (first tier that yields a proposal wins;
 * the live scan showed the in-spreadsheet cross-references rarely fire, so
 * the snapshot tier is the workhorse):
 *   tier 0 — in-spreadsheet cross-references (PR #105, unchanged): a clean
 *            same-fromLead Patients twin ('repair from twin'), the lead row
 *            with the same id ('repair from lead'), a clean row sharing the
 *            phone ('repair from phone match').
 *   tier 1 — SNAPSHOT ('repair from snapshot'): rows created before the bug
 *            went live (2026-07-27) were written clean and corrupted later by
 *            full-house rewrites, so their clean values exist in a pre-bug
 *            copy of this spreadsheet. Sandra creates it manually via
 *            File → Version history → Make a copy, named EZONE-SNAPSHOT (any
 *            name with that prefix counts; see corruptionSnapshots_).
 *            Snapshots are READ-ONLY — never written. Covers ALL scanned text
 *            columns, notes/free text included, guarded by a compatibility
 *            check (corruptionWildcardRegex_). An incompatible snapshot value
 *            classifies the cell 'snapshot mismatch — manual' (the live value
 *            was edited after the snapshot — a machine must not pick sides).
 *   tier 2 — closed value sets ('repair from enum'): house / source /
 *            manager-name-like columns; a corrupted value whose surviving
 *            characters match exactly ONE legal value is repaired to it.
 *   tier 3 — name roster ('repair from roster'): clean person names pooled
 *            from every sheet AND every snapshot; exactly-one match wins.
 *            Bonus: two same-fromLead Patients rows corrupted in DIFFERENT
 *            positions whose union reconstructs a full clean string
 *            ('repair from twin-merge').
 * Enum/roster tiers NEVER touch notes/meetingNote/long-free-text columns —
 * those repair only from a snapshot (or by hand). Everything still lands in
 * RepairPlan as approved=FALSE; applyCorruptedRowRepairsNow is unchanged.
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

/* The sheets + columns where free-text Hebrew lives — the scan targets.
 * Stable-key columns (stage, status, disposition, meetingOutcome, …) and
 * date/number columns are deliberately absent: U+FFFD cannot appear in them
 * unless the row is damaged beyond what a text repair fixes.
 *   textCols  — columns scanned for U+FFFD
 *   phoneCols — columns whose digits feed the phone cross-reference
 *   leadIdCol — column holding the Leads id ('' when the sheet has none)
 *   nameCol   — the sheet's person-name column (lead/phone/roster repairs
 *               propose values only for THIS column)
 *   snapshotMatch — how tier 1 relocates this sheet's rows in a snapshot:
 *               'patient' (by fromLead, else houseId+entryDate+pay) | 'lead'
 *               (by lead id) | '' (no reliable row identity — Payments'
 *               patientId is session-local per the PR #105 findings, and
 *               Managers/Outpatients have no key; roster still covers their
 *               name columns)
 *   enumCols  — {column: valueClass} closed-set columns tier 2 may repair;
 *               valueClass keys corruptionEnumSets_'s legal-value pools.
 *               Free-text columns (note/notes/meetingNote/…) are deliberately
 *               absent — enum/roster never touch them. */
function corruptionScanTargets_() {
  const leadText = ['name', 'house', 'source', 'note', 'assignedTo', 'meetingWith',
    'meetingCompanion', 'meetingNote', 'meetingReporter', 'contactName', 'contactRelation'];
  const leadPhones = ['phone', 'contactPhone', 'billingPhone'];
  const leadEnums = { house: 'house', source: 'source', assignedTo: 'assignee',
    meetingWith: 'manager', meetingReporter: 'manager' };
  return [
    { sheet: PATIENTS_SHEET,             columns: PATIENT_COLUMNS,           textCols: ['name', 'notes'],                        phoneCols: [],         leadIdCol: 'fromLead', nameCol: 'name', snapshotMatch: 'patient', enumCols: {} },
    { sheet: LEADS_SHEET,                columns: LEAD_COLUMNS,              textCols: leadText,                                 phoneCols: leadPhones, leadIdCol: 'id',       nameCol: 'name', snapshotMatch: 'lead',    enumCols: leadEnums },
    { sheet: IRRELEVANT_LEADS_SHEET,     columns: IRRELEVANT_LEAD_COLUMNS,   textCols: leadText.concat(['not_relevant_note']),   phoneCols: leadPhones, leadIdCol: 'id',       nameCol: 'name', snapshotMatch: 'lead',    enumCols: leadEnums },
    { sheet: REMOVED_LEADS_SHEET,        columns: REMOVED_LEAD_COLUMNS,      textCols: leadText,                                 phoneCols: leadPhones, leadIdCol: 'id',       nameCol: 'name', snapshotMatch: 'lead',    enumCols: leadEnums },
    { sheet: DISCHARGED_PATIENTS_SHEET,  columns: DISCHARGED_PATIENT_COLUMNS, textCols: ['name', 'notes', 'discharge_note'],     phoneCols: [],         leadIdCol: 'fromLead', nameCol: 'name', snapshotMatch: 'patient', enumCols: {} },
    { sheet: PATIENTS_TOMBSTONES_SHEET,  columns: PATIENT_TOMBSTONE_COLUMNS, textCols: ['name', 'notes'],                        phoneCols: [],         leadIdCol: 'fromLead', nameCol: 'name', snapshotMatch: 'patient', enumCols: {} },
    { sheet: PAYMENTS_SHEET,             columns: PAYMENT_COLUMNS,           textCols: ['patientName'],                          phoneCols: [],         leadIdCol: '',         nameCol: 'patientName', snapshotMatch: '', enumCols: {} },
    { sheet: MANAGERS_SHEET,             columns: MANAGER_COLUMNS,           textCols: ['manager_name'],                         phoneCols: [],         leadIdCol: '',         nameCol: 'manager_name', snapshotMatch: '', enumCols: { manager_name: 'manager' } },
    { sheet: OUTPATIENTS_SHEET,          columns: OUTPATIENT_COLUMNS,        textCols: ['patient_name', 'house_of_origin', 'therapy_type', 'notes'], phoneCols: [], leadIdCol: '', nameCol: 'patient_name', snapshotMatch: '', enumCols: { house_of_origin: 'house' } },
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

/* ---- Tier 1–3 machinery: snapshot / enum / roster / twin-merge ---- */

/* Any spreadsheet whose NAME starts with this prefix is a repair snapshot —
 * a pre-bug copy Sandra creates via File → Version history → Make a copy. */
const SNAPSHOT_NAME_PREFIX = 'EZONE-SNAPSHOT';

/* The shared compatibility/wildcard rule for every tier: split the corrupted
 * value on runs of U+FFFD, and require the surviving segments to appear IN
 * ORDER in the candidate with each U+FFFD run standing for 1+ characters
 * (a run always replaced at least one original character — a Hebrew char is
 * 2 UTF-8 bytes, so a run may stand for FEWER chars than its length, never
 * zero). Anchored: surviving leading/trailing text must lead/trail the
 * candidate too. This is both tier 1's sanity guard and tiers 2–3's matcher. */
function corruptionWildcardRegex_(corrupted) {
  const parts = String(corrupted).split(/�+/);
  const esc = parts.map(function (s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); });
  return new RegExp('^' + esc.join('[\\s\\S]+') + '$');
}

/* Exactly-one-match helper for the enum and roster tiers: returns
 * {count, value} where value is set only when EXACTLY ONE candidate matches
 * the corrupted value under the wildcard rule. 0 or 2+ → manual (the caller
 * must not guess). */
function corruptionMatchOne_(corrupted, candidates) {
  const re = corruptionWildcardRegex_(corrupted);
  let hit = '';
  let count = 0;
  for (let i = 0; i < candidates.length; i++) {
    if (re.test(candidates[i])) {
      count++;
      if (count === 1) hit = candidates[i]; else break;
    }
  }
  return { count: count, value: count === 1 ? hit : '' };
}

/* Locate snapshot spreadsheets: every Drive spreadsheet whose name starts
 * with SNAPSHOT_NAME_PREFIX, READ-ONLY (opened, never written). Priority
 * order is OLDEST content first — a snapshot whose name ends in an encoded
 * yyyy-MM-dd date (the harvested EZONE-SNAPSHOT-AUTO-<date> files) sorts by
 * THAT date, because all harvested files are CREATED at harvest time and
 * their lastUpdated says nothing about content age; a snapshot without an
 * encoded date (the manual EZONE-SNAPSHOT copy) keeps lastUpdated as its
 * key. Older content first — the more likely to pre-date the corruption.
 * Fail-soft everywhere: no Drive access / no snapshot / a non-spreadsheet
 * name-collision just shrinks the list (tiers 2–3 run regardless). The live
 * spreadsheet itself is excluded even if it were renamed to match the
 * prefix. */
function corruptionSnapshots_() {
  const found = [];
  const seen = {};
  let activeId = '';
  try { activeId = SpreadsheetApp.getActiveSpreadsheet().getId(); } catch (_) { /* fake env */ }
  const collect = function (iter) {
    while (iter && iter.hasNext()) {
      const f = iter.next();
      const name = String(f.getName());
      if (name.indexOf(SNAPSHOT_NAME_PREFIX) !== 0) continue;
      const id = String(f.getId());
      if (seen[id] || id === activeId) continue;
      seen[id] = true;
      let updated = 0;
      try { updated = f.getLastUpdated().getTime(); } catch (_) { /* keep 0 → highest priority */ }
      const encoded = name.match(/(\d{4}-\d{2}-\d{2})$/);
      const encodedMs = encoded ? Date.parse(encoded[1]) : NaN;
      found.push({ id: id, name: name, sortKey: isNaN(encodedMs) ? updated : encodedMs });
    }
  };
  try {
    collect(DriveApp.searchFiles('title contains "' + SNAPSHOT_NAME_PREFIX + '"'));
  } catch (e) {
    // Drive search unavailable — fall back to the exact-name lookup.
    try { collect(DriveApp.getFilesByName(SNAPSHOT_NAME_PREFIX)); } catch (_) { /* no Drive at all */ }
  }
  found.sort(function (a, b) { return a.sortKey - b.sortKey; });
  const out = [];
  found.forEach(function (f) {
    try {
      out.push({ name: f.name, ss: SpreadsheetApp.openById(f.id) });
    } catch (e) {
      Logger.log('snapshot "' + f.name + '" could not be opened as a spreadsheet — skipped (' + e + ')');
    }
  });
  return out;
}

/* ---- Automated revision harvesting (feeds tier 1 with many snapshots) ----
 *
 * A single pre-bug snapshot covers only rows created before 2026-07-27, but
 * corruption happened on read→rewrite cycles throughout 2026-07-27 →
 * 2026-08-31 — each row's LAST CLEAN value lives in a different revision,
 * the one just before that row's first corrupting rewrite. Instead of Sandra
 * making many Version-history copies by hand, harvestRevisionSnapshotsNow
 * lists the container spreadsheet's Drive revisions, picks a spread of them
 * across the corruption window, exports each as xlsx, and rebuilds each as a
 * real Google Sheet named EZONE-SNAPSHOT-AUTO-<yyyy-MM-dd> — exactly what
 * corruptionSnapshots_'s prefix discovery already consumes (and orders by
 * the encoded date). deleteAutoSnapshotsNow cleans them all up afterwards,
 * never touching the manual EZONE-SNAPSHOT copy. Both are PUBLIC (Run
 * dropdown) and unreachable over HTTP — handle_ never names them
 * (guard-tested, same as the three cleanup entry points). */

const AUTO_SNAPSHOT_PREFIX = SNAPSHOT_NAME_PREFIX + '-AUTO-'; // EZONE-SNAPSHOT-AUTO-
const CORRUPTION_BUG_LIVE_DATE = '2026-07-27';  // server.js chunk-split went live (PR #49)
const CORRUPTION_WINDOW_END_DATE = '2026-09-01'; // day after the fix deployed (PR #102, 2026-08-31)
const XLSX_EXPORT_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/* Normalize Drive revision metadata across API shapes (v3: revisions[] with
 * modifiedTime; v2: items[] with modifiedDate) into
 * {id, modified(ms), exportLinks}, ascending by modified. Undatable entries
 * are dropped — the selector can only place a revision it can date. */
function normalizeRevisions_(rawList) {
  const out = [];
  (rawList || []).forEach(function (r) {
    if (!r) return;
    const modified = Date.parse(r.modifiedTime || r.modifiedDate || '');
    const id = String(r.id == null ? '' : r.id);
    if (!id || isNaN(modified)) return;
    out.push({ id: id, modified: modified, exportLinks: r.exportLinks || null });
  });
  out.sort(function (a, b) { return a.modified - b.modified; });
  return out;
}

/* List ALL revisions of a file. Advanced Drive service first (v2/v3 shapes
 * both handled, fields:* so exportLinks come along); UrlFetchApp against the
 * Drive v3 REST API with the script's own OAuth token as the fallback. */
function listSpreadsheetRevisions_(fileId) {
  let raw = [];
  try {
    if (typeof Drive !== 'undefined' && Drive.Revisions && Drive.Revisions.list) {
      let pageToken = null;
      do {
        const args = { fields: '*', pageSize: 200 };
        if (pageToken) args.pageToken = pageToken;
        const resp = Drive.Revisions.list(fileId, args);
        raw = raw.concat(resp.revisions || resp.items || []);
        pageToken = resp.nextPageToken || null;
      } while (pageToken);
      return normalizeRevisions_(raw);
    }
    Logger.log('Drive advanced service not enabled — falling back to the REST API');
  } catch (e) {
    Logger.log('advanced Drive revision listing failed (' + e + ') — falling back to the REST API');
  }
  raw = [];
  let pageToken = null;
  do {
    let url = 'https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(fileId) +
      '/revisions?fields=*&pageSize=200';
    if (pageToken) url += '&pageToken=' + encodeURIComponent(pageToken);
    const resp = UrlFetchApp.fetch(url, {
      headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
      muteHttpExceptions: true,
    });
    if (resp.getResponseCode() !== 200) {
      throw new Error('revision list failed: HTTP ' + resp.getResponseCode());
    }
    const body = JSON.parse(resp.getContentText());
    raw = raw.concat(body.revisions || []);
    pageToken = body.nextPageToken || null;
  } while (pageToken);
  return normalizeRevisions_(raw);
}

/* Pick which revisions to harvest. PURE (no services) so it is directly
 * testable. Selection: the newest revision strictly BEFORE the bug went
 * live (the clean baseline), plus the latest revision inside each ~6-day
 * bucket across the corruption window, plus the newest pre-fix revision —
 * deduped by revision id and then by calendar day (latest per day wins,
 * since the harvested file name encodes only the date), capped at `cap` by
 * evenly thinning the middle while always keeping the first and last.
 * Revisions may be sparse (Google consolidates old ones): empty buckets are
 * simply skipped — take what exists. Returns [{id, modified, exportLinks,
 * dateLabel}] ascending; dateLabel is the UTC yyyy-MM-dd used in the file
 * name. */
function selectHarvestRevisions_(revisions, opts) {
  opts = opts || {};
  const bugLive = Date.parse((opts.bugLive || CORRUPTION_BUG_LIVE_DATE) + 'T00:00:00Z');
  const windowEnd = Date.parse((opts.windowEnd || CORRUPTION_WINDOW_END_DATE) + 'T00:00:00Z');
  const stepMs = (opts.stepDays || 6) * 24 * 60 * 60 * 1000;
  const cap = opts.cap || 10;

  const sorted = (revisions || []).slice().sort(function (a, b) { return a.modified - b.modified; });
  const pickedIds = {};
  let picked = [];
  const add = function (rev) {
    if (!rev || pickedIds[rev.id]) return;
    pickedIds[rev.id] = true;
    picked.push(rev);
  };

  let baseline = null;
  sorted.forEach(function (r) { if (r.modified < bugLive) baseline = r; });
  add(baseline);
  for (let start = bugLive; start < windowEnd; start += stepMs) {
    const end = Math.min(start + stepMs, windowEnd);
    let inBucket = null;
    sorted.forEach(function (r) { if (r.modified >= start && r.modified < end) inBucket = r; });
    add(inBucket);
  }
  let preFix = null;
  sorted.forEach(function (r) { if (r.modified < windowEnd) preFix = r; });
  add(preFix);

  picked.sort(function (a, b) { return a.modified - b.modified; });
  // One file per calendar day (the name encodes only the date): latest wins.
  const byLabel = {};
  const labels = [];
  picked.forEach(function (r) {
    const label = new Date(r.modified).toISOString().slice(0, 10);
    if (!byLabel[label]) labels.push(label);
    byLabel[label] = { id: r.id, modified: r.modified, exportLinks: r.exportLinks, dateLabel: label };
  });
  let out = labels.map(function (l) { return byLabel[l]; });

  if (out.length > cap) {
    const kept = [out[0]];
    const middle = out.slice(1, out.length - 1);
    const slots = cap - 2;
    for (let i = 0; i < slots; i++) {
      kept.push(middle[Math.round(i * (middle.length - 1) / Math.max(slots - 1, 1))]);
    }
    kept.push(out[out.length - 1]);
    const seenOut = {};
    out = kept.filter(function (r) {
      if (seenOut[r.id]) return false;
      seenOut[r.id] = true;
      return true;
    });
  }
  return out;
}

/* Export one revision as an xlsx blob via its exportLinks, fetched with the
 * script's own OAuth token. When the listed revision came without
 * exportLinks, the single revision is re-fetched with fields:* first. */
function exportRevisionXlsxBlob_(fileId, rev) {
  let url = rev.exportLinks && rev.exportLinks[XLSX_EXPORT_MIME];
  if (!url) {
    const meta = UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/files/' +
      encodeURIComponent(fileId) + '/revisions/' + encodeURIComponent(rev.id) + '?fields=*', {
      headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
      muteHttpExceptions: true,
    });
    if (meta.getResponseCode() === 200) {
      const body = JSON.parse(meta.getContentText());
      url = body.exportLinks && body.exportLinks[XLSX_EXPORT_MIME];
    }
  }
  if (!url) throw new Error('no xlsx exportLink for revision ' + rev.id);
  const resp = UrlFetchApp.fetch(url, {
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    muteHttpExceptions: true,
  });
  if (resp.getResponseCode() !== 200) {
    throw new Error('xlsx export of revision ' + rev.id + ' failed: HTTP ' + resp.getResponseCode());
  }
  return resp.getBlob();
}

/* Rebuild an xlsx blob as a real Google Sheet named `name` via the Drive
 * advanced service — v3 Files.create converts when the target mimeType is
 * the Google Sheets type; v2 Files.insert uses convert:true. */
function createSpreadsheetFromXlsx_(blob, name) {
  if (typeof Drive === 'undefined' || !Drive.Files) {
    throw new Error('Drive advanced service unavailable — enable it in appsscript.json');
  }
  if (Drive.Files.create) {
    return Drive.Files.create({ name: name, mimeType: 'application/vnd.google-apps.spreadsheet' }, blob);
  }
  if (Drive.Files.insert) {
    return Drive.Files.insert({ title: name, mimeType: 'application/vnd.google-apps.spreadsheet' }, blob, { convert: true });
  }
  throw new Error('Drive advanced service exposes neither Files.create (v3) nor Files.insert (v2)');
}

/* Harvest revision snapshots of THIS spreadsheet for the tier-1 repair.
 * PUBLIC (Run dropdown), never dispatchable via handle_. Idempotent: a date
 * whose EZONE-SNAPSHOT-AUTO-<date> file already exists is skipped, so
 * re-running only fills gaps. Per-revision try/catch: one failed export
 * neither kills the harvest nor blocks the rest. Read-only toward the live
 * spreadsheet; creates only the AUTO-named snapshot files. */
function harvestRevisionSnapshotsNow() {
  const fileId = SpreadsheetApp.getActiveSpreadsheet().getId();
  const revisions = listSpreadsheetRevisions_(fileId);
  Logger.log('harvestRevisionSnapshotsNow: ' + revisions.length + ' revision(s) found for this spreadsheet.');
  const selected = selectHarvestRevisions_(revisions);
  Logger.log('Selected ' + selected.length + ' revision(s): ' +
    selected.map(function (r) { return r.dateLabel + ' (rev ' + r.id + ')'; }).join(', '));

  let harvested = 0, skipped = 0, failed = 0;
  selected.forEach(function (rev) {
    const name = AUTO_SNAPSHOT_PREFIX + rev.dateLabel;
    try {
      if (DriveApp.getFilesByName(name).hasNext()) {
        skipped++;
        Logger.log('SKIP ' + name + ' — already harvested.');
        return;
      }
      const blob = exportRevisionXlsxBlob_(fileId, rev);
      createSpreadsheetFromXlsx_(blob, name);
      harvested++;
      Logger.log('HARVESTED ' + name + ' from revision ' + rev.id + '.');
    } catch (e) {
      failed++;
      Logger.log('FAILED ' + name + ' (revision ' + rev.id + '): ' + e);
    }
  });
  const summary = { found: revisions.length, selected: selected.length,
                    harvested: harvested, skipped: skipped, failed: failed };
  Logger.log('harvestRevisionSnapshotsNow: ' + revisions.length + ' revision(s) found, ' +
    selected.length + ' selected, ' + harvested + ' harvested, ' + skipped +
    ' skipped (already present), ' + failed + ' failed. Next: run scanCorruptedRowsNow / ' +
    'writeRepairPlanNow — the EZONE-SNAPSHOT-AUTO-* files feed tier 1 automatically.');
  return summary;
}

/* Trash every harvested EZONE-SNAPSHOT-AUTO-* file — cleanup for after the
 * repair is done. PUBLIC (Run dropdown), never dispatchable via handle_.
 * The manually created EZONE-SNAPSHOT copy (no -AUTO-) is NEVER touched:
 * only names starting with the full AUTO prefix qualify. Trash, not delete —
 * recoverable from the Drive trash for 30 days. */
function deleteAutoSnapshotsNow() {
  let trashed = 0;
  let iter = null;
  try {
    iter = DriveApp.searchFiles('title contains "' + AUTO_SNAPSHOT_PREFIX + '"');
  } catch (e) {
    Logger.log('deleteAutoSnapshotsNow: Drive search failed (' + e + ') — nothing trashed.');
    return { trashed: 0 };
  }
  while (iter.hasNext()) {
    const f = iter.next();
    const name = String(f.getName());
    if (name.indexOf(AUTO_SNAPSHOT_PREFIX) !== 0) continue; // never the manual snapshot
    try {
      f.setTrashed(true);
      trashed++;
      Logger.log('TRASHED ' + name + '.');
    } catch (e) {
      Logger.log('FAILED to trash ' + name + ': ' + e);
    }
  }
  Logger.log('deleteAutoSnapshotsNow: ' + trashed + ' auto-snapshot(s) trashed. ' +
    'The manual ' + SNAPSHOT_NAME_PREFIX + ' copy is never touched.');
  return { trashed: trashed };
}

/* Read one snapshot sheet's data rows keyed by ITS OWN header row — the
 * column-position tolerance: the snapshot pre-dates later schema appends, so
 * it may have fewer columns than the live schema; since every schema is
 * append-only, mapping by the snapshot's headers lines each logical column up
 * with today's name, and a column the snapshot lacks simply reads as
 * undefined. READ-ONLY. Returns null when the sheet is absent. */
function corruptionSnapshotRows_(ss, sheetName) {
  let sh = null;
  try { sh = ss.getSheetByName(sheetName); } catch (_) { sh = null; }
  if (!sh) return null;
  const lastRow = sh.getLastRow();
  const lastCol = sh.getLastColumn();
  if (lastRow < 2 || lastCol < 1) return [];
  const headers = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h); });
  const values = sh.getRange(2, 1, lastRow - 1, lastCol).getValues();
  const rows = [];
  for (let i = 0; i < values.length; i++) {
    const row = values[i];
    let hasContent = false;
    for (let j = 0; j < row.length; j++) {
      if (row[j] !== '' && row[j] !== null) { hasContent = true; break; }
    }
    if (!hasContent) continue;
    const obj = {};
    for (let j = 0; j < headers.length; j++) {
      if (headers[j] !== '') obj[headers[j]] = row[j];
    }
    rows.push({ rowNumber: i + 2, obj: obj });
  }
  return rows;
}

/* Index one snapshot for matching: patients-family rows per sheet, leads
 * rows per sheet by id, and every clean person name (for the roster tier). */
function corruptionSnapshotIndex_(snap) {
  const idx = { name: snap.name, patients: {}, leads: {}, names: [], namesSeen: {} };
  const addName = function (v) {
    const s = String(v == null ? '' : v).trim();
    if (s === '' || hasCorruption_(s) || idx.namesSeen[s]) return;
    idx.namesSeen[s] = true;
    idx.names.push(s);
  };
  [PATIENTS_SHEET, DISCHARGED_PATIENTS_SHEET, PATIENTS_TOMBSTONES_SHEET].forEach(function (nm) {
    const rows = corruptionSnapshotRows_(snap.ss, nm);
    if (!rows) return;
    idx.patients[nm] = rows;
    rows.forEach(function (r) { addName(r.obj.name); });
  });
  [LEADS_SHEET, IRRELEVANT_LEADS_SHEET, REMOVED_LEADS_SHEET].forEach(function (nm) {
    const rows = corruptionSnapshotRows_(snap.ss, nm);
    if (!rows) return;
    const byId = {};
    rows.forEach(function (r) {
      addName(r.obj.name);
      const id = String(r.obj.id == null ? '' : r.obj.id).trim();
      if (!id) return;
      if (!byId[id]) byId[id] = [];
      byId[id].push(r);
    });
    idx.leads[nm] = byId;
  });
  const payRows = corruptionSnapshotRows_(snap.ss, PAYMENTS_SHEET);
  if (payRows) payRows.forEach(function (r) { addName(r.obj.patientName); });
  return idx;
}

/* Find THE snapshot row for a live patients-family row: by fromLead when it
 * is non-empty, else by houseId + entryDate + monthly amount (pay). The live
 * row's own sheet is searched first; only if it yields nothing do the other
 * patients-family sheets get a turn (a live discharged row may have been an
 * active patient at snapshot time). 2+ candidates in whichever pool answered
 * → ambiguous: {row:null, why} and NO proposal — a machine must not guess…
 * with ONE exception on the fallback key (live finding: houseId+entryDate+pay
 * collisions are common): when the live row's NAME is corrupted, its
 * surviving characters disambiguate under the same in-order wildcard rule
 * the enum/roster tiers use — exactly one candidate with a clean, compatible
 * name → that candidate is the match; zero or 2+ compatible → still
 * ambiguous, unchanged behavior. */
function corruptionSnapshotMatchPatient_(idx, liveSheet, rowObj) {
  const order = [liveSheet].concat(
    [PATIENTS_SHEET, DISCHARGED_PATIENTS_SHEET, PATIENTS_TOMBSTONES_SHEET]
      .filter(function (nm) { return nm !== liveSheet; }));
  const fl = String(rowObj.fromLead == null ? '' : rowObj.fromLead).trim();
  const houseId = String(rowObj.houseId == null ? '' : rowObj.houseId).trim();
  const date = asISODate_(rowObj.date);
  const pay = String(rowObj.pay == null ? '' : rowObj.pay).trim();
  const matchIn = function (rows) {
    if (!rows) return [];
    if (fl) {
      return rows.filter(function (r) {
        return String(r.obj.fromLead == null ? '' : r.obj.fromLead).trim() === fl;
      });
    }
    if (!houseId || !date) return []; // too little identity to match on
    return rows.filter(function (r) {
      return String(r.obj.houseId == null ? '' : r.obj.houseId).trim() === houseId &&
             asISODate_(r.obj.date) === date &&
             String(r.obj.pay == null ? '' : r.obj.pay).trim() === pay;
    });
  };
  for (let i = 0; i < order.length; i++) {
    const cand = matchIn(idx.patients[order[i]]);
    if (cand.length === 1) return { row: cand[0], sheet: order[i], why: '' };
    if (cand.length > 1) {
      // Fallback-key collisions only: let the corrupted name's surviving
      // characters break the tie (same wildcard rule as enum/roster).
      if (!fl) {
        const liveName = String(rowObj.name == null ? '' : rowObj.name);
        if (liveName !== '' && hasCorruption_(liveName)) {
          const re = corruptionWildcardRegex_(liveName);
          const compatible = cand.filter(function (r) {
            const nm = String(r.obj.name == null ? '' : r.obj.name);
            return nm !== '' && !hasCorruption_(nm) && re.test(nm);
          });
          if (compatible.length === 1) return { row: compatible[0], sheet: order[i], why: '' };
        }
      }
      return { row: null, sheet: '', why: cand.length + ' rows in ' + order[i] +
        (fl ? ' share fromLead ' + fl : ' share houseId+entryDate+pay') + ' — ambiguous, no proposal' };
    }
  }
  return { row: null, sheet: '', why: '' };
}

/* Find THE snapshot row for a live leads-family row by lead id — own sheet
 * first, then the other leads-family sheets (the lead may have moved sheets
 * since the snapshot). Same 2+ → ambiguous rule. */
function corruptionSnapshotMatchLead_(idx, liveSheet, rowObj, leadIdCol) {
  const id = String(rowObj[leadIdCol] == null ? '' : rowObj[leadIdCol]).trim();
  if (!id) return { row: null, sheet: '', why: '' };
  const order = [liveSheet].concat(
    [LEADS_SHEET, IRRELEVANT_LEADS_SHEET, REMOVED_LEADS_SHEET]
      .filter(function (nm) { return nm !== liveSheet; }));
  for (let i = 0; i < order.length; i++) {
    const byId = idx.leads[order[i]];
    if (!byId || !byId[id]) continue;
    if (byId[id].length === 1) return { row: byId[id][0], sheet: order[i], why: '' };
    return { row: null, sheet: '', why: byId[id].length + ' rows in ' + order[i] +
      ' share lead id ' + id + ' — ambiguous, no proposal' };
  }
  return { row: null, sheet: '', why: '' };
}

/* Tier 1 for one corrupted cell: walk the snapshots in priority order; the
 * first matched row whose value in the SAME LOGICAL COLUMN is clean and
 * passes the compatibility guard wins. A clean-but-incompatible value sets
 * mismatch=true — the caller classifies 'snapshot mismatch — manual' and
 * does NOT fall through to enum/roster (the value visibly changed after the
 * snapshot; guessing from weaker sources would be worse, not better). */
function corruptionSnapshotProposal_(snapIndexes, t, r, col) {
  const res = { newValue: '', source: '', mismatch: false, notes: [] };
  const corrupted = String(r.obj[col]);
  for (let i = 0; i < snapIndexes.length; i++) {
    const idx = snapIndexes[i];
    let m;
    if (t.snapshotMatch === 'patient') m = corruptionSnapshotMatchPatient_(idx, t.sheet, r.obj);
    else if (t.snapshotMatch === 'lead') m = corruptionSnapshotMatchLead_(idx, t.sheet, r.obj, t.leadIdCol);
    else return res; // no row identity in this sheet (Payments/Managers/Outpatients)
    if (!m.row) {
      if (m.why) res.notes.push(idx.name + ': ' + m.why);
      continue;
    }
    const v = m.row.obj[col];
    if (v === undefined || v === null || v === '') continue; // snapshot lacks the column/value
    const sv = String(v);
    if (hasCorruption_(sv)) continue; // snapshot row corrupted too (post-bug copy?)
    if (corruptionWildcardRegex_(corrupted).test(sv)) {
      res.newValue = sv;
      res.source = idx.name + ' ' + m.sheet + ' row ' + m.row.rowNumber;
      return res;
    }
    res.mismatch = true;
    res.notes.push(idx.name + ': snapshot value "' + sv + '" is incompatible with the corrupted cell');
  }
  return res;
}

/* Tier 2 legal-value pools, keyed by the valueClass names used in
 * corruptionScanTargets_'s enumCols. Seeded from the in-code closed sets
 * (house display names; manager names) and extended with every clean value
 * observed in the live enum columns themselves — that is where free-but-
 * closed sets like source (מקור הפניה) and assignedTo get their values. */
function corruptionEnumSets_(bySheet, targets) {
  const sets = { house: {}, manager: {}, source: {}, assignee: {} };
  Object.keys(MANAGER_HOUSE_NAMES).forEach(function (k) { sets.house[MANAGER_HOUSE_NAMES[k]] = true; });
  Object.keys(HOUSE_MANAGERS).forEach(function (k) { sets.manager[HOUSE_MANAGERS[k]] = true; });
  Object.keys(MANAGER_PHONES).forEach(function (name) { sets.manager[name] = true; });
  targets.forEach(function (t) {
    const entry = bySheet[t.sheet];
    if (!entry || !entry.rows) return;
    Object.keys(t.enumCols || {}).forEach(function (col) {
      const cls = t.enumCols[col];
      if (!sets[cls]) sets[cls] = {};
      entry.rows.forEach(function (r) {
        const v = String(r.obj[col] == null ? '' : r.obj[col]).trim();
        if (v !== '' && !hasCorruption_(v)) sets[cls][v] = true;
      });
    });
  });
  const out = {};
  Object.keys(sets).forEach(function (cls) { out[cls] = Object.keys(sets[cls]); });
  return out;
}

/* Tier 3 roster: every clean person name from every live target sheet's
 * nameCol plus every snapshot's names. */
function corruptionRoster_(bySheet, targets, snapIndexes) {
  const seen = {};
  const names = [];
  const add = function (v) {
    const s = String(v == null ? '' : v).trim();
    if (s === '' || hasCorruption_(s) || seen[s]) return;
    seen[s] = true;
    names.push(s);
  };
  targets.forEach(function (t) {
    const entry = bySheet[t.sheet];
    if (!entry || !entry.rows || !t.nameCol) return;
    entry.rows.forEach(function (r) { add(r.obj[t.nameCol]); });
  });
  snapIndexes.forEach(function (idx) { idx.names.forEach(add); });
  return names;
}

/* Tier 3 bonus — merge two same-length strings corrupted in DIFFERENT
 * positions: where one has U+FFFD the other must be clean, and where both
 * are clean they must agree. Returns the reconstructed string, or '' when
 * the union cannot fully reconstruct (overlapping corruption, conflicting
 * clean chars, or differing lengths — U+FFFD-run length need not equal the
 * original char count, so differing lengths are simply not mergeable). */
function corruptionTwinMerge_(a, b) {
  a = String(a);
  b = String(b);
  if (a.length === 0 || a.length !== b.length) return '';
  let out = '';
  for (let i = 0; i < a.length; i++) {
    const ca = a.charAt(i);
    const cb = b.charAt(i);
    if (ca === CORRUPTION_MARK && cb === CORRUPTION_MARK) return '';
    if (ca !== CORRUPTION_MARK && cb !== CORRUPTION_MARK && ca !== cb) return '';
    out += (ca === CORRUPTION_MARK) ? cb : ca;
  }
  return out;
}

/* The shared scan engine behind scanCorruptedRowsNow / writeRepairPlanNow.
 * READ-ONLY (snapshots included — they are opened and read, never written).
 * Returns:
 *   cells    — [{sheet,row,column,value,proposal,source,newValue,note}] one
 *              per corrupted cell; proposal ∈ 'repair from twin' | 'repair
 *              from lead' | 'repair from phone match' | 'repair from
 *              snapshot' | 'repair from enum' | 'repair from roster' |
 *              'repair from twin-merge' | 'snapshot mismatch — manual' |
 *              'no source — manual' | 'key collision — delete corrupted
 *              twin' | 'key collision — manual'; note carries why weaker
 *              outcomes were reached (ambiguous snapshot match, 2+
 *              enum/roster hits, post-repair key already taken, …). The two
 *              'key collision' outcomes come from the identity-key guard: a
 *              Patients name/date repair whose post-repair key already
 *              belongs to another row is never proposed as a repair
 *   snapshots— snapshot spreadsheet names in priority order ([] when none
 *              was found — tiers 2–3 still ran)
 *   deletes  — [{row,name,houseId,date,fromLead,source?}] corrupted Patients
 *              rows whose clean twin makes them EXACT duplicates (same
 *              fromLead + house + entryDate + status) → proposed 'delete
 *              corrupted twin'; the key-collision guard adds its own with
 *              source 'key collision — delete corrupted twin' (deduped by
 *              row — one delete proposal per row)
 *   keepBoth — [{fromLead,rows,reason}] same-fromLead pairs that differ in
 *              entryDate or status (the readmission pattern) or are both
 *              corrupted: NEVER proposed for delete — repair only, keep both
 *   summary  — counts */
function corruptionScan_() {
  const targets = corruptionScanTargets_();
  const bySheet = {};
  targets.forEach(function (t) { bySheet[t.sheet] = { target: t, rows: corruptionReadRows_(t) }; });

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

  // Patients rows by CURRENT identity key — the key-collision guard's lookup.
  // A repair that changes name (or date) changes the row's key; if the
  // repaired key already belongs to another row, applying the repair would
  // mint identical-key duplicates (the immortal-duplicate class — see
  // findDuplicatePatientKeysNow), so such a repair is never proposed.
  const patientsByKey = {};
  if (patientsEntry && patientsEntry.rows) {
    patientsEntry.rows.forEach(function (r) {
      const k = patientKey_(r.obj.houseId, r.obj.name, r.obj.date);
      if (!patientsByKey[k]) patientsByKey[k] = [];
      patientsByKey[k].push(r);
    });
  }
  // Declared before the cells loop: the collision guard adds delete
  // proposals; the fromLead duplicate-pair analysis below adds its own,
  // deduped by row number against these.
  const deletes = [];

  // Tier 1–3 sources, computed once for the whole scan. All READ-ONLY.
  const snapshots = corruptionSnapshots_();
  const snapIndexes = snapshots.map(corruptionSnapshotIndex_);
  const enumSets = corruptionEnumSets_(bySheet, targets);
  const roster = corruptionRoster_(bySheet, targets, snapIndexes);
  const addNote = function (finding, note) {
    finding.note = finding.note ? finding.note + '; ' + note : note;
  };

  const cells = [];
  targets.forEach(function (t) {
    const entry = bySheet[t.sheet];
    if (!entry.rows) return; // sheet absent — nothing to scan
    entry.rows.forEach(function (r) {
      t.textCols.forEach(function (col) {
        const v = r.obj[col];
        if (!hasCorruption_(v)) return;
        const finding = { sheet: t.sheet, row: r.rowNumber, column: col,
                          value: String(v), proposal: 'no source — manual', source: '', newValue: '', note: '' };
        const leadId = t.leadIdCol ? String(r.obj[t.leadIdCol] == null ? '' : r.obj[t.leadIdCol]).trim() : '';
        const manual = function () { return finding.proposal === 'no source — manual'; };

        // Tier 0 (PR #105, unchanged behavior) —
        // (a) clean same-fromLead Patients twin — same column, clean value.
        if (t.sheet === PATIENTS_SHEET && leadId && patientsByFromLead[leadId]) {
          const twin = patientsByFromLead[leadId].find(function (tw) {
            const tv = tw.obj[col];
            return tw.rowNumber !== r.rowNumber && tv !== '' && tv != null && !hasCorruption_(tv);
          });
          if (twin) {
            finding.proposal = 'repair from twin';
            finding.source = t.sheet + ' row ' + twin.rowNumber;
            finding.newValue = String(twin.obj[col]);
          }
        }
        // (b) the Leads-family row with the same lead id — name column only.
        // (A corrupted Leads row can never propose itself: its own name fails
        // the clean check, so leadById only offers rows that are clean.)
        if (manual() && col === t.nameCol && leadId &&
            leadById[leadId] && leadById[leadId].cleanName) {
          finding.proposal = 'repair from lead';
          finding.source = 'lead ' + leadId;
          finding.newValue = leadById[leadId].name;
        }
        // (c) a clean row elsewhere sharing this row's phone — name column only.
        if (manual() && col === t.nameCol) {
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
        }

        // Tier 1 — snapshot (all text columns, notes included).
        if (manual() && snapIndexes.length > 0 && t.snapshotMatch) {
          const sp = corruptionSnapshotProposal_(snapIndexes, t, r, col);
          if (sp.notes.length > 0) addNote(finding, sp.notes.join('; '));
          if (sp.newValue) {
            finding.proposal = 'repair from snapshot';
            finding.source = sp.source;
            finding.newValue = sp.newValue;
          } else if (sp.mismatch) {
            // A clean snapshot value exists but fails the compatibility
            // guard: the live value was edited after the snapshot. Manual —
            // and the weaker tiers must not have a go either.
            finding.proposal = 'snapshot mismatch — manual';
          }
        }
        // Tier 2 — closed value sets (enum columns only, never free text).
        if (manual() && t.enumCols && t.enumCols[col] && enumSets[t.enumCols[col]]) {
          const em = corruptionMatchOne_(String(v), enumSets[t.enumCols[col]]);
          if (em.count === 1) {
            finding.proposal = 'repair from enum';
            finding.source = t.enumCols[col] + ' value set';
            finding.newValue = em.value;
          } else if (em.count > 1) {
            addNote(finding, em.count + ' legal ' + t.enumCols[col] + ' values match — manual');
          }
        }
        // Tier 3 — name roster (name columns only, never free text).
        if (manual() && col === t.nameCol) {
          const rm = corruptionMatchOne_(String(v), roster);
          if (rm.count === 1) {
            finding.proposal = 'repair from roster';
            finding.source = 'name roster (' + roster.length + ' names)';
            finding.newValue = rm.value;
          } else if (rm.count > 1) {
            addNote(finding, rm.count + ' roster names match — manual');
          }
        }
        // Tier 3 bonus — corrupted-twin merge (Patients only): two rows for
        // the same logical entity corrupted in DIFFERENT positions whose
        // union reconstructs the full clean string.
        if (manual() && t.sheet === PATIENTS_SHEET && leadId && patientsByFromLead[leadId]) {
          const group = patientsByFromLead[leadId];
          for (let g = 0; g < group.length; g++) {
            const tw = group[g];
            if (tw.rowNumber === r.rowNumber) continue;
            const tv = tw.obj[col];
            if (tv === undefined || tv === null || !hasCorruption_(tv)) continue;
            const merged = corruptionTwinMerge_(String(v), String(tv));
            if (merged !== '') {
              finding.proposal = 'repair from twin-merge';
              finding.source = t.sheet + ' rows ' + r.rowNumber + '+' + tw.rowNumber;
              finding.newValue = merged;
              break;
            }
          }
        }

        // KEY-COLLISION GUARD (Patients identity columns only): whatever tier
        // proposed the value, a repair whose post-repair identity key already
        // belongs to ANOTHER Patients row is never proposed as 'repair' —
        // applying it would create identical-key duplicate rows that saveAll
        // preserves forever (deletePatientRow_ would then delete all of them
        // at once). When the colliding row shares this row's houseId +
        // entryDate + status, the corrupted row is an exact twin of an
        // already-clean row → propose DELETE of the corrupted row instead.
        // Anything else (e.g. differing status) → manual, no newValue.
        if (t.sheet === PATIENTS_SHEET && (col === 'name' || col === 'date') && finding.newValue !== '') {
          const repairedKey = patientKey_(r.obj.houseId,
            col === 'name' ? finding.newValue : r.obj.name,
            col === 'date' ? finding.newValue : r.obj.date);
          const collisions = (patientsByKey[repairedKey] || []).filter(function (o) { return o.rowNumber !== r.rowNumber; });
          if (collisions.length > 0) {
            addNote(finding, 'post-repair key "' + repairedKey + '" already on row ' +
              collisions.map(function (o) { return o.rowNumber; }).join('+'));
            finding.newValue = '';
            finding.source = '';
            const twin = collisions.find(function (o) {
              return String(o.obj.houseId == null ? '' : o.obj.houseId).trim() === String(r.obj.houseId == null ? '' : r.obj.houseId).trim() &&
                     asISODate_(o.obj.date) === asISODate_(r.obj.date) &&
                     String(o.obj.status) === String(r.obj.status);
            });
            if (twin) {
              finding.proposal = 'key collision — delete corrupted twin';
              if (!deletes.some(function (d) { return d.row === r.rowNumber; })) {
                deletes.push({ row: r.rowNumber, name: String(r.obj.name), houseId: String(r.obj.houseId),
                               date: asISODate_(r.obj.date),
                               fromLead: String(r.obj.fromLead == null ? '' : r.obj.fromLead).trim(),
                               source: 'key collision — delete corrupted twin' });
              }
            } else {
              finding.proposal = 'key collision — manual';
            }
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
      // The collision guard may already carry this row (same signature seen
      // through the repaired key) — one delete proposal per row, never two.
      if (!deletes.some(function (d) { return d.row === bad.rowNumber; })) {
        deletes.push({ row: bad.rowNumber, name: String(bad.obj.name), houseId: String(bad.obj.houseId),
                       date: asISODate_(bad.obj.date), fromLead: fl });
      }
    } else if (aCor || bCor) {
      keepBoth.push({ fromLead: fl, rows: describe,
        reason: exactTwin ? 'both corrupted — repair only' : 'entryDate/status differ (readmission pattern) — repair only, keep both' });
    }
  });

  const byProposal = {};
  cells.forEach(function (c) { byProposal[c.proposal] = (byProposal[c.proposal] || 0) + 1; });

  return {
    cells: cells,
    deletes: deletes,
    keepBoth: keepBoth,
    snapshots: snapshots.map(function (s) { return s.name; }),
    summary: { corruptedCells: cells.length, proposedDeletes: deletes.length,
               keepBothPairs: keepBoth.length, byProposal: byProposal },
  };
}

/* One Logger line describing snapshot availability — shared by both public
 * scan/plan entry points so the log always states clearly whether tier 1 ran. */
function logSnapshotStatus_(res) {
  if (res.snapshots.length === 0) {
    Logger.log('NO SNAPSHOT FOUND — no spreadsheet named "' + SNAPSHOT_NAME_PREFIX +
      '*" is visible in Drive, so tier 1 (snapshot repair) was skipped; the enum and roster tiers still ran. ' +
      'To enable it: File → Version history → pick a pre-2026-07-27 version → Make a copy, name it ' +
      SNAPSHOT_NAME_PREFIX + ', then re-run.');
  } else {
    Logger.log('Snapshot(s) used for tier 1, in priority order (oldest-modified first): ' +
      res.snapshots.join(', ') + '. Snapshots are read-only — never written.');
  }
}

/* DRY RUN — run from the Apps Script editor. READ-ONLY (getSheetByName only;
 * cannot even create a sheet): scans every target sheet/column for U+FFFD and
 * Logger.logs each hit with its PROPOSED action and source, plus the
 * duplicate-pair verdicts. NOTHING is written; use writeRepairPlanNow to turn
 * these proposals into the reviewable RepairPlan sheet. */
function scanCorruptedRowsNow() {
  const res = corruptionScan_();
  logSnapshotStatus_(res);
  res.cells.forEach(function (c) {
    Logger.log('CORRUPTED ' + c.sheet + ' row ' + c.row + ' [' + c.column + '] "' + c.value + '" → ' +
      c.proposal + (c.newValue ? ' ("' + c.newValue + '" from ' + c.source + ')' : '') +
      (c.note ? ' [' + c.note + ']' : ''));
  });
  res.deletes.forEach(function (d) {
    Logger.log('DUPLICATE-TWIN ' + PATIENTS_SHEET + ' row ' + d.row + ' "' + d.name + '" (fromLead ' + d.fromLead +
      ') is an exact corrupted duplicate of a clean twin → proposed ' + (d.source || 'delete corrupted twin'));
  });
  res.keepBoth.forEach(function (k) {
    Logger.log('KEEP-BOTH fromLead ' + k.fromLead + ': ' + k.reason + ' — ' + JSON.stringify(k.rows));
  });
  Logger.log('scanCorruptedRowsNow: ' + res.summary.corruptedCells + ' corrupted cell(s), ' +
    res.summary.proposedDeletes + ' proposed delete(s), ' + res.summary.keepBothPairs +
    ' keep-both pair(s). By tier: ' + JSON.stringify(res.summary.byProposal) + '. NO WRITES performed.');
  return res;
}

/* Populate the hidden RepairPlan sheet from the scan, every row with
 * approved=FALSE — Sandra reviews, edits newValue where the scan found no
 * source, and flips approved to TRUE per row she wants executed. FULL
 * REWRITE on each run (write-then-trim), so re-running RESETS approvals —
 * run it once, review, apply. Writes ONLY to RepairPlan. */
function writeRepairPlanNow() {
  const res = corruptionScan_();
  logSnapshotStatus_(res);
  const sh = getOrCreateSheet_(REPAIR_PLAN_SHEET, REPAIR_PLAN_COLUMNS);
  try { if (!sh.isSheetHidden()) sh.hideSheet(); } catch (_) { /* no-op */ }

  const planRows = [];
  res.cells.forEach(function (c) {
    // A cell whose collision guard replaced the repair with a delete proposal
    // is carried by its delete row below — a blank repair row alongside it
    // would only invite hand-filling a value that recreates the collision.
    if (c.proposal === 'key collision — delete corrupted twin') return;
    planRows.push(objectToRow_({ sheet: c.sheet, row: c.row, column: c.column,
      newValue: c.newValue, action: 'repair', approved: 'FALSE', oldValue: c.value,
      source: c.proposal + (c.source ? ' — ' + c.source : '') }, REPAIR_PLAN_COLUMNS));
  });
  res.deletes.forEach(function (d) {
    planRows.push(objectToRow_({ sheet: PATIENTS_SHEET, row: d.row, column: 'name',
      newValue: '', action: 'delete', approved: 'FALSE', oldValue: d.name,
      source: d.source || 'delete corrupted twin' }, REPAIR_PLAN_COLUMNS));
  });

  const lastRow = sh.getLastRow();
  if (planRows.length > 0) {
    sh.getRange(2, 1, planRows.length, REPAIR_PLAN_COLUMNS.length).setValues(planRows);
  }
  if (lastRow > planRows.length + 1) {
    sh.getRange(planRows.length + 2, 1, lastRow - planRows.length - 1, REPAIR_PLAN_COLUMNS.length).clearContent();
  }
  Logger.log('writeRepairPlanNow: wrote ' + planRows.length + ' plan row(s) (' +
    (planRows.length - res.deletes.length) +
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
  if (lock.tryLock(10000) !== true) throw new Error('applyCorruptedRowRepairsNow: ' + LOCK_BUSY_MESSAGE);
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
      // KEY-COLLISION GUARD at apply time (Patients identity columns): the
      // sheet may have changed since the plan was written — and earlier
      // repairs in THIS run (e.g. two twin-merge repairs converging on the
      // same clean name) change it too — so re-check that the repaired key
      // is not already held by another row. A duplicate key is never written.
      if (target.sheet === PATIENTS_SHEET && (String(p.column) === 'name' || String(p.column) === 'date')) {
        const hIdx = PATIENT_COLUMNS.indexOf('houseId');
        const nIdx = PATIENT_COLUMNS.indexOf('name');
        const dIdx = PATIENT_COLUMNS.indexOf('date');
        const rowVals = sh.getRange(rowNum, 1, 1, PATIENT_COLUMNS.length).getValues()[0];
        const repairedKey = patientKey_(rowVals[hIdx],
          String(p.column) === 'name' ? newValue : rowVals[nIdx],
          String(p.column) === 'date' ? newValue : rowVals[dIdx]);
        const sheetLast = sh.getLastRow();
        const all = sheetLast > 1 ? sh.getRange(2, 1, sheetLast - 1, PATIENT_COLUMNS.length).getValues() : [];
        for (let i = 0; i < all.length; i++) {
          if (i + 2 === rowNum) continue;
          if (patientKey_(all[i][hIdx], all[i][nIdx], all[i][dIdx]) === repairedKey) {
            return skip(p, 'key collision: row ' + (i + 2) + ' already holds key "' + repairedKey + '" — repairing would create identical-key duplicates');
          }
        }
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

function moveLeadIrrelevant_(lead, actor) {
  if (!lead || !lead.id) return { ok: false, error: 'missing_lead' };
  const lock = LockService.getScriptLock();
  if (lock.tryLock(10000) !== true) return lockBusy_('moveLeadIrrelevant_');
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
    logAudit_('lead_moved_irrelevant', 'moveLeadIrrelevant_', String(lead.id), String(lead.name || ''),
      { reason: String(record.not_relevant_reason || ''), disposition: String(record.disposition || '') }, actor);
    return { ok: true, moved: true, lead: record };
  } finally {
    try { lock.releaseLock(); } catch (_) { /* no-op */ }
  }
}

function restoreLead_(lead, actor) {
  if (!lead || !lead.id) return { ok: false, error: 'missing_lead' };
  const lock = LockService.getScriptLock();
  if (lock.tryLock(10000) !== true) return lockBusy_('restoreLead_');
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
    logAudit_('lead_restored', 'restoreLead_', String(lead.id), String(lead.name || ''), {}, actor);
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
function removeLead_(lead, actor) {
  if (!lead || !lead.id) return { ok: false, error: 'missing_lead' };
  const lock = LockService.getScriptLock();
  if (lock.tryLock(10000) !== true) return lockBusy_('removeLead_');
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
      /* A RETRY whose first answer was lost: the lead is already on the
       * removed sheet. Answer that row, write nothing (CHANGELOG-write-path-hardening.md). */
      const prior = readSheet_(removedSh, REMOVED_LEAD_COLUMNS).filter(function (r) {
        return String(r.id == null ? '' : r.id) === String(lead.id);
      })[0];
      if (prior) return { ok: true, removed: true, replayed: true, lead: prior };
      return { ok: false, error: 'lead_id_not_found' };
    }
    upsertRowById_(removedSh, REMOVED_LEAD_COLUMNS, record);
    deleteRowsById_(leadsSh, LEAD_COLUMNS, lead.id);
    logAudit_('lead_removed', 'removeLead_', String(lead.id), String(lead.name || ''), {}, actor);
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
/* ===== Duplicate discharges (CHANGELOG-duplicate-discharges.md, 2026-10-07) =====
 *
 * ONE open discharge row per stay. A stay is houseId + name + entry date — the
 * same triple the client's restore / heal flows match on (matchActivePatientIndex)
 * — with the name trimmed and its inner whitespace collapsed, and the entry
 * date read through asISODate_ (a Date-typed cell and 'YYYY-MM-DD' text agree).
 * A row is OPEN while it is neither restored (restored='TRUE') nor soft-deleted
 * (deletedAt set). Every discharge writer checks this under the script lock
 * before it appends; a re-discharge after a restore is legal because the
 * restored row is no longer open. */
function dischargeStayKey_(row) {
  if (!row) return '';
  const houseId = String(row.houseId == null ? '' : row.houseId).trim();
  const name = String(row.name == null ? '' : row.name).replace(/\s+/g, ' ').trim();
  if (!houseId || !name) return '';
  return houseId + '::' + name + '::' + asISODate_(row.date);
}

function dischargeRowRestored_(row) {
  const r = row ? row.restored : '';
  return r === true || String(r == null ? '' : r).trim().toUpperCase() === 'TRUE';
}

function dischargeRowDeleted_(row) {
  return !!row && String(row.deletedAt == null ? '' : row.deletedAt).trim() !== '';
}

function dischargeRowOpen_(row) {
  return !!row && !dischargeRowRestored_(row) && !dischargeRowDeleted_(row);
}

/* The OPEN rows (readSheet_ objects) of `key`'s stay, other than `exceptId`.
 * Pure. */
function openDischargeRowsForStay_(rows, key, exceptId) {
  if (!key) return [];
  const skip = String(exceptId == null ? '' : exceptId);
  return (Array.isArray(rows) ? rows : []).filter(function (r) {
    return dischargeRowOpen_(r) && dischargeStayKey_(r) === key &&
      String(r.id == null ? '' : r.id) !== skip;
  });
}

/* A keyed upsert of a discharged-audit row from a CLIENT copy (restore paths)
 * must never blank the server-owned soft-delete stamps: carry them from the
 * stored row with the same id. Mutates and returns `record`. */
function carryDischargeDeleteStamps_(sh, record) {
  if (!sh || !record || !record.id) return record;
  const rows = readSheet_(sh, DISCHARGED_PATIENT_COLUMNS);
  for (let i = 0; i < rows.length; i++) {
    if (String(rows[i].id) !== String(record.id)) continue;
    if (dischargeRowDeleted_(rows[i])) {
      record.deletedAt = rows[i].deletedAt;
      record.deletedBy = rows[i].deletedBy;
      record.deleteReason = rows[i].deleteReason;
    }
    break;
  }
  return record;
}

function dischargePatient_(patient, user) {
  if (!patient || !patient.id) return { ok: false, error: 'missing_patient' };
  const lock = LockService.getScriptLock();
  if (lock.tryLock(10000) !== true) return lockBusy_('dischargePatient_');
  try {
    const dischargedSh = getOrCreateSheet_(DISCHARGED_PATIENTS_SHEET, DISCHARGED_PATIENT_COLUMNS);

    /* Duplicate guard (root cause of the doubled row): the client mints a
     * fresh audit id per confirm, so a retry after a lost response, a second
     * tab, or a «נשמר חלקית» rollback re-sent the SAME stay under a NEW id and
     * upsertRowById_ appended a second row. An open row of this stay under
     * another id → answer duplicate and write NOTHING. The same id is a plain
     * retry of this very row and still upserts (idempotent). */
    const stayKey = dischargeStayKey_(patient);
    const open = openDischargeRowsForStay_(readSheet_(dischargedSh, DISCHARGED_PATIENT_COLUMNS), stayKey, patient.id);
    if (open.length) {
      console.log('[discharge] duplicate refused: stay already has open row ' + open[0].id);
      return {
        ok: true, duplicate: true, discharged: false,
        id: String(open[0].id), exitDate: asISODate_(open[0].exitDate),
      };
    }

    const record = Object.assign({}, patient, {
      dischargedAt:   patient.dischargedAt   || new Date().toISOString(),
      disposition:    patient.disposition    || '',
      discharge_note: patient.discharge_note || '',
      // Who/when stamps are SERVER-owned — never taken from the client copy.
      updatedAt:      new Date().toISOString(),
      updatedBy:      String(user == null ? '' : user),
    });

    upsertRowById_(dischargedSh, DISCHARGED_PATIENT_COLUMNS, record);
    logAudit_('patient_discharged', 'dischargePatient_', record.fromLead || record.id || '', record.name || '', { id: record.id, houseId: record.houseId || '', disposition: record.disposition || '', updatedBy: record.updatedBy });
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
function restorePatient_(patient, user) {
  if (!patient || !patient.id) return { ok: false, error: 'missing_patient' };
  // The client-minted lead id is this restore's idempotency key: validated.
  if (patient.newLeadId !== undefined && patient.newLeadId !== null && patient.newLeadId !== '' &&
      !(typeof patient.newLeadId === 'string' && NEW_LEAD_ID_RE.test(patient.newLeadId))) {
    return { ok: false, error: 'bad_new_lead_id' };
  }
  const lock = LockService.getScriptLock();
  if (lock.tryLock(10000) !== true) return lockBusy_('restorePatient_');
  try {
    const leadsSh = getOrCreateSheet_(LEADS_SHEET, LEAD_COLUMNS);
    /* A RETRY whose first answer was lost: the lead this restore creates is
     * already on the sheet. Answer it, write nothing — never a second lead,
     * never a reset of what the lead holds now (CHANGELOG-write-path-hardening.md). */
    if (patient.newLeadId) {
      const prior = readSheet_(leadsSh, LEAD_COLUMNS).filter(function (r) {
        return String(r.id == null ? '' : r.id).trim() === String(patient.newLeadId);
      })[0];
      if (prior) {
        return { ok: true, restored: true, replayed: true, newLeadId: String(patient.newLeadId), originalPatientId: patient.id, lead: prior };
      }
    }

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
    const flagged = Object.assign({}, patient, { restored: 'TRUE',
      updatedAt: new Date().toISOString(), updatedBy: String(user == null ? '' : user) });
    carryDischargeDeleteStamps_(dischargedSh, flagged);
    upsertRowById_(dischargedSh, DISCHARGED_PATIENT_COLUMNS, flagged);

    logAudit_('patient_restored_to_lead', 'restorePatient_', patient.fromLead || patient.id, patient.name || '', { id: patient.id, newLeadId: restored.id, updatedBy: flagged.updatedBy });
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
function restorePatientToActive_(patient, user) {
  if (!patient || !patient.id) return { ok: false, error: 'missing_patient' };
  const lock = LockService.getScriptLock();
  if (lock.tryLock(10000) !== true) return lockBusy_('restorePatientToActive_');
  try {
    const dischargedSh = getOrCreateSheet_(DISCHARGED_PATIENTS_SHEET, DISCHARGED_PATIENT_COLUMNS);
    const flagged = Object.assign({}, patient, { restored: 'TRUE',
      updatedAt: new Date().toISOString(), updatedBy: String(user == null ? '' : user) });
    carryDischargeDeleteStamps_(dischargedSh, flagged);
    upsertRowById_(dischargedSh, DISCHARGED_PATIENT_COLUMNS, flagged);
    logAudit_('patient_restored_active', 'restorePatientToActive_', patient.fromLead || patient.id, patient.name || '', { id: patient.id, updatedBy: flagged.updatedBy });
    return { ok: true, restoredToActive: true, id: patient.id };
  } finally {
    try { lock.releaseLock(); } catch (_) { /* no-op */ }
  }
}

/* ===== «מחק כפילות» — soft-delete ONE duplicate discharge row =====
 * (CHANGELOG-duplicate-discharges.md, 2026-10-07)
 *
 * action=deleteDuplicateDischarge { id, reason } — DELETE_ACTIONS, so handle_
 * has already refused anyone without the `deleter` role (Vered, Sandra) before
 * this runs. Under the script lock:
 *   - reason: required, cleaned (control chars, < >, formula lead-in), 2–120;
 *   - the row must exist and be OPEN (not restored); an already-deleted row
 *     answers ok + alreadyDeleted, nothing written (idempotent retry);
 *   - the stay must keep at least ONE other open row — the last remaining
 *     discharge row of a stay is never deleted;
 *   - credits: a stay with two open credits for the same rule (creditType +
 *     allocationMonth) is a possible DOUBLE REFUND, and a credit whose basis
 *     exitDate matches only THIS row is this row's own credit — both refuse.
 *     Cancelling a credit is Sandra's decision, never a side effect here.
 *   - the write: three APPENDED cells on that one row (deletedAt / deletedBy /
 *     deleteReason) + one AuditLog row (at / by / prev). The Patients and
 *     Payments sheets are never read for writing, never touched. */
const DUP_DELETE_REASON_MIN = 2;
const DUP_DELETE_REASON_MAX = 120;
const DUP_DELETE_MESSAGES = {
  missing_id:          'חסר מזהה שורת שחרור',
  reason_required:     'יש להזין סיבה למחיקה (2–120 תווים)',
  reason_too_long:     'הסיבה ארוכה מדי (עד 120 תווים)',
  not_found:           'שורת השחרור לא נמצאה',
  not_open:            'שורת שחרור משוחזרת אינה כפילות פתוחה — לא נמחקה',
  last_discharge_row:  'זו שורת השחרור היחידה של השהייה — לא ניתן למחוק אותה',
  duplicate_credit:    'לשהייה זו קיימים שני זיכויים פתוחים לאותו כלל (חשד להחזר כפול). ביטול זיכוי דורש אישור סנדרה — השורה לא נמחקה',
  row_has_credit:      'לשורת שחרור זו יש זיכוי משלה. ביטול זיכוי דורש אישור סנדרה — השורה לא נמחקה',
};

function dupDeleteRefusal_(code, extra) {
  return Object.assign({ ok: false, error: code, message: DUP_DELETE_MESSAGES[code] || code }, extra || {});
}

/* A credit's stay key: its stored patientKey ('house::name::date'), read
 * through the same normalization as dischargeStayKey_. Pure. */
function creditStayKey_(c) {
  const parts = String(c && c.patientKey != null ? c.patientKey : '').split('::');
  if (parts.length < 3) return '';
  return dischargeStayKey_({ houseId: parts[0], name: parts.slice(1, parts.length - 1).join('::'), date: parts[parts.length - 1] });
}

function creditOpen_(c) {
  return !!c && String(c.status == null ? '' : c.status).trim().toLowerCase() !== 'cancelled';
}

/* The exit date a credit was computed for (basis.exitDate), or ''. Pure. */
function creditBasisExit_(c) {
  let b = c ? c.basis : null;
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch (_) { b = null; } }
  return b && b.exitDate ? asISODate_(b.exitDate) : '';
}

/* The open credits of a stay (Credits rows as objects). Pure. */
function openCreditsForStay_(credits, key) {
  if (!key) return [];
  return (Array.isArray(credits) ? credits : []).filter(function (c) {
    return creditOpen_(c) && creditStayKey_(c) === key;
  });
}

/* Two or more open credits of one stay under the same rule. Pure. */
function duplicateCreditRules_(credits) {
  const seen = {}, out = [];
  (credits || []).forEach(function (c) {
    const k = String(c.creditType) + '::' + String(c.allocationMonth);
    seen[k] = (seen[k] || 0) + 1;
    if (seen[k] === 2) out.push(k);
  });
  return out;
}

/* The credits that belong to `row` ALONE: an open credit whose basis exitDate
 * equals this row's exit date when no other remaining open row of the stay
 * carries that exit date. A credit shared by identical duplicates stays with
 * the surviving row, so it never blocks the delete. Pure. */
function creditsOwnedByDischargeRow_(row, siblings, stayCredits) {
  const exit = asISODate_(row && row.exitDate);
  if (!exit) return [];
  const shared = (siblings || []).some(function (s) { return asISODate_(s.exitDate) === exit; });
  if (shared) return [];
  return (stayCredits || []).filter(function (c) { return creditBasisExit_(c) === exit; });
}

function deleteDuplicateDischarge_(params, actor) {
  const p = params || {};
  const id = String(p.id == null ? '' : p.id).trim().slice(0, 200);
  if (!id) return dupDeleteRefusal_('missing_id');
  const reason = coordTextClean_(p.reason, 1000);
  if (reason.length < DUP_DELETE_REASON_MIN) return dupDeleteRefusal_('reason_required');
  if (reason.length > DUP_DELETE_REASON_MAX) return dupDeleteRefusal_('reason_too_long');

  const lock = LockService.getScriptLock();
  if (lock.tryLock(10000) !== true) return lockBusy_('deleteDuplicateDischarge_');
  try {
    const sh = getOrCreateSheet_(DISCHARGED_PATIENTS_SHEET, DISCHARGED_PATIENT_COLUMNS);
    const lastRow = sh.getLastRow();
    const values = lastRow >= 2 ? sh.getRange(2, 1, lastRow - 1, DISCHARGED_PATIENT_COLUMNS.length).getValues() : [];
    const rows = values.map(function (v) {
      const o = {};
      for (let c = 0; c < DISCHARGED_PATIENT_COLUMNS.length; c++) o[DISCHARGED_PATIENT_COLUMNS[c]] = v[c];
      return o;
    });
    let idx = -1;
    for (let i = 0; i < rows.length; i++) {
      if (String(rows[i].id) === id) { idx = i; break; }
    }
    if (idx < 0) return dupDeleteRefusal_('not_found');
    const target = rows[idx];
    if (dischargeRowDeleted_(target)) {
      return { ok: true, alreadyDeleted: true, id: id, deletedAt: String(target.deletedAt) };
    }
    if (dischargeRowRestored_(target)) return dupDeleteRefusal_('not_open');

    const key = dischargeStayKey_(target);
    const siblings = openDischargeRowsForStay_(rows, key, id);
    if (!key || siblings.length === 0) return dupDeleteRefusal_('last_discharge_row');

    const creditsSh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CREDITS_SHEET);
    const stayCredits = openCreditsForStay_(creditsSh ? readSheet_(creditsSh, CREDIT_COLUMNS) : [], key);
    const dupRules = duplicateCreditRules_(stayCredits);
    if (dupRules.length) {
      return dupDeleteRefusal_('duplicate_credit', { creditIds: stayCredits.map(function (c) { return String(c.id); }) });
    }
    const own = creditsOwnedByDischargeRow_(target, siblings, stayCredits);
    if (own.length) {
      return dupDeleteRefusal_('row_has_credit', { creditIds: own.map(function (c) { return String(c.id); }) });
    }

    const nowIso = new Date().toISOString();
    const by = String(actor == null ? '' : actor).slice(0, 60);
    const sheetRow = idx + 2;
    const col = function (name) { return DISCHARGED_PATIENT_COLUMNS.indexOf(name) + 1; };
    // The three appended cells are contiguous; text-forced so the ISO stamp
    // never coerces into a Date cell.
    sh.getRange(sheetRow, col('deletedAt'), 1, 3).setNumberFormat('@');
    sh.getRange(sheetRow, col('deletedAt'), 1, 3).setValues([[nowIso, by, reason]]);

    const prev = {};
    DISCHARGED_PATIENT_COLUMNS.forEach(function (c) {
      const v = target[c];
      prev[c] = v instanceof Date ? v.toISOString() : (v == null ? '' : v);
    });
    logAudit_('discharge_duplicate_deleted', 'deleteDuplicateDischarge_', target.fromLead || id,
      String(target.name == null ? '' : target.name),
      { id: id, at: nowIso, by: by, reason: reason, keptId: String(siblings[0].id), prev: prev }, by);
    return { ok: true, deleted: true, id: id, keptId: String(siblings[0].id), deletedAt: nowIso, deletedBy: by, deleteReason: reason };
  } finally {
    try { lock.releaseLock(); } catch (_) { /* no-op */ }
  }
}

/* EDITOR-RUN, DRY RUN — read-only. Lists every stay with two or more OPEN
 * discharge rows, and the credits of that stay (with the row each one is
 * attributed to by basis exitDate). Writes NOTHING: no lock, no
 * getOrCreateSheet_, no header extension, no AuditLog row.
 * Run: Apps Script editor → choose listDuplicateDischargesNow → Run →
 * View → Executions (or Logs). Public name (no trailing underscore) so the
 * editor's Run dropdown shows it; handle_ never dispatches it. */
function listDuplicateDischargesNow() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(DISCHARGED_PATIENTS_SHEET);
  const out = { ok: true, dryRun: true, stays: [] };
  if (!sh) { console.log('[dup-discharges] no sheet «' + DISCHARGED_PATIENTS_SHEET + '» — nothing to list'); return out; }
  const values = sheetValues_(sh, DISCHARGED_PATIENT_COLUMNS);
  const byStay = {};
  values.forEach(function (v, i) {
    const o = {};
    for (let c = 0; c < DISCHARGED_PATIENT_COLUMNS.length; c++) o[DISCHARGED_PATIENT_COLUMNS[c]] = v[c];
    if (!dischargeRowOpen_(o)) return;
    const k = dischargeStayKey_(o);
    if (!k) return;
    o.__row = i + 2;
    (byStay[k] = byStay[k] || []).push(o);
  });
  const creditsSh = ss.getSheetByName(CREDITS_SHEET);
  const credits = creditsSh ? readSheet_(creditsSh, CREDIT_COLUMNS) : [];
  Object.keys(byStay).sort().forEach(function (k) {
    const rows = byStay[k];
    if (rows.length < 2) return;
    const stayCredits = credits.filter(function (c) { return creditStayKey_(c) === k; });
    const stay = {
      stay: k,
      rows: rows.map(function (r) {
        return {
          sheetRow: r.__row, id: String(r.id), exitDate: asISODate_(r.exitDate),
          disposition: String(r.disposition || ''), dischargedAt: String(r.dischargedAt || ''),
          updatedBy: String(r.updatedBy || ''), source: String(r.dischargeSource || 'dashboard'),
          ownCredits: creditsOwnedByDischargeRow_(r, rows.filter(function (x) { return x !== r; }),
            stayCredits.filter(creditOpen_)).map(function (c) { return String(c.id); }),
        };
      }),
      credits: stayCredits.map(function (c) {
        return {
          id: String(c.id), creditType: String(c.creditType), allocationMonth: String(c.allocationMonth),
          amount: c.amount, status: String(c.status), basisExitDate: creditBasisExit_(c),
        };
      }),
      doubleRefund: duplicateCreditRules_(stayCredits.filter(creditOpen_)),
    };
    out.stays.push(stay);
    console.log('[dup-discharges] ' + JSON.stringify(stay));
  });
  console.log('[dup-discharges] DRY RUN — ' + out.stays.length + ' stay(s) with 2+ open discharge rows; nothing written.');
  return out;
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
  return constantTimeEquals_(got, expected);   // constant-time (0b-2)
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

/* ===== Cross-app: coordinators patient roster (2026-10-04) =====
 *
 * The ezone-coordinators app shows a per-house patient list and lets a
 * coordinator mark a discharge. Two actions, BOTH behind their own Script
 * Property COORDINATORS_PATIENTS_SECRET (passed as `secret`), constant-time
 * compared, FAIL-CLOSED: unset / empty / mismatched → {ok:false,
 * error:'unauthorized'} and nothing is read or written. The secret is
 * separate from every other app's, so it unlocks nothing else and can be
 * rotated alone. Both actions are in OPEN_ACTIONS (the coordinators app
 * calls Apps Script directly, like the therapists roster).
 *
 * 1. getPatientsForCoordinators — READ-ONLY feed. FROZEN per-row contract,
 *    EXACTLY these keys (test/coordinators-roster.test.js pins the set):
 *      id            — the persisted Patients `id` (immutable)
 *      name          — patient display name (trimmed)
 *      house         — canonical coordinators house id, the DIGEST-CONTRACT
 *                      encoding: ramot | raanana | efroni | rehab | pardes.
 *                      Houses outside that set (sde, unknown) are EXCLUDED.
 *      active        — boolean: in the house now (status not released AND no
 *                      exitDate) — the population occupancy counts
 *      admissionDate — 'yyyy-MM-dd' (Patients `date`), '' if blank
 *      dischargeDate — 'yyyy-MM-dd' (Patients `exitDate`), '' if none
 *    Every active patient, plus released patients whose dischargeDate is
 *    within the last COORD_RELEASED_WINDOW_DAYS days (so a discharge stays
 *    visible to the coordinator who made it; older history is not shared —
 *    data minimization). NO phone, billing, payment, advance, notes, lead
 *    link or source field — the projection is an explicit allow-list.
 *
 * 2. recordDischargeFromCoordinators — the ONE write. Payload: id,
 *    dischargeDate ('yyyy-MM-dd', not in the future, not before admission),
 *    reason (optional, ≤ 500 chars), by (required, the coordinator's name).
 *    Only a patient the feed can show (a canonical house) can be discharged;
 *    any other id answers patient_not_found. Under the script lock it:
 *      a. upserts the standard discharged-audit row (DISCHARGED_PATIENTS_SHEET,
 *         the same sheet the Dashboard's own שחרר writes) with the appended
 *         audit columns dischargeSource / dischargedBy / dischargeReason /
 *         patientId. Its id is DETERMINISTIC ('coord-<patientId>-<date>'), so
 *         a retry rewrites the same row, never a second one. Written FIRST:
 *         once it lands the discharge is durable (the client's
 *         healClobberedDischarges completes a release from it), exactly the
 *         write order the Dashboard's own discharge uses;
 *      b. flips the Patients row: status='released', exitDate=dischargeDate,
 *         updatedAt=now, updatedBy='רכזות · <by>'. Only those four cells; the
 *         row is never deleted and nothing else on it changes. The fresh
 *         updatedAt makes a stale Dashboard tab's later save of that row a
 *         refused CONFLICT (replaceHousePatients_), not a silent re-activation.
 *    DECISION (Sandra, 2026-10-04): the discharge takes effect IMMEDIATELY —
 *    occupancy, the Managers feed and the ActivePatients digest all see it on
 *    their next read. No Vered confirmation step; Vered sees it in the
 *    «🚪 שחרורים מהבתים» panel for billing/refunds.
 *    IDEMPOTENT: the patient already released with the SAME exitDate → ok,
 *    alreadyDischarged:true, zero writes. Released with a DIFFERENT date →
 *    refused 'already_discharged' (a coordinator never rewrites a discharge
 *    the Dashboard recorded). Never deletes anything.
 */
const COORDINATORS_PATIENTS_SECRET_PROP = 'COORDINATORS_PATIENTS_SECRET';
const COORD_FEED_KEYS = ['id', 'name', 'house', 'active', 'admissionDate', 'dischargeDate'];
const COORD_RELEASED_WINDOW_DAYS = 30;
const COORD_DISCHARGE_SOURCE = 'ezone-coordinators';
const COORD_REASON_MAX = 500;
const COORD_BY_MAX = 60;
const COORD_ID_MAX = 100;
const COORD_RELEASED_STATUSES = ['released', 'שוחרר', 'שחרור'];

function coordinatorsPatientsAuthOk_(params) {
  const expected = PropertiesService.getScriptProperties().getProperty(COORDINATORS_PATIENTS_SECRET_PROP);
  // Fail closed: no secret configured → refuse (never serve patient names open).
  if (!expected) return false;
  const got = (params && typeof params.secret === 'string') ? params.secret : '';
  if (!got) return false;
  return constantTimeEquals_(got, expected);
}

function coordStatusReleased_(raw) {
  return COORD_RELEASED_STATUSES.indexOf(String(raw == null ? '' : raw).trim()) >= 0;
}

/* One line of free text as stored: control characters flattened, a formula
 * lead-in stripped, angle brackets removed, capped. */
function coordTextClean_(v, max) {
  let t = String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/[<>]/g, '').trim();
  t = t.replace(/^[=+@-]+/, '').trim();
  return t.slice(0, max);
}

/* A strict calendar 'yyyy-MM-dd', or '' — 2026-02-30 is not a date. */
function coordIsoDateClean_(v) {
  const s = String(v == null ? '' : v).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return '';
  const d = new Date(s + 'T00:00:00Z');
  if (isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) return '';
  return s;
}

/* Today and the released-window cutoff as 'yyyy-MM-dd' (Asia/Jerusalem). */
function coordToday_() {
  return Utilities.formatDate(new Date(), 'Asia/Jerusalem', 'yyyy-MM-dd');
}
function coordReleasedCutoff_() {
  return Utilities.formatDate(new Date(Date.now() - COORD_RELEASED_WINDOW_DAYS * 86400000),
    'Asia/Jerusalem', 'yyyy-MM-dd');
}

/* PURE projection: Patients rows (readSheet_ objects) → feed rows. Built
 * from exactly COORD_FEED_KEYS, so nothing else on the row can leak. */
function buildCoordinatorsRoster_(rows, cutoffIso) {
  const out = [];
  if (!Array.isArray(rows)) return out;
  for (let i = 0; i < rows.length; i++) {
    const p = rows[i];
    if (!p) continue;
    const id = String(p.id == null ? '' : p.id).trim();
    const name = String(p.name == null ? '' : p.name).trim();
    if (!id || !name) continue;
    const house = canonicalDigestHouse_(p.houseId);
    if (!house) continue;                       // sde / unknown → excluded
    const admissionDate = asISODate_(p.date);
    const dischargeDate = asISODate_(p.exitDate);
    const active = !coordStatusReleased_(p.status) && dischargeDate === '';
    // Released history beyond the window is not shared (minimization).
    if (!active && !(dischargeDate !== '' && dischargeDate >= cutoffIso)) continue;
    out.push({
      id: id,
      name: name,
      house: house,
      active: active,
      admissionDate: admissionDate,
      dischargeDate: dischargeDate,
    });
  }
  return out;
}

function getPatientsForCoordinators_() {
  const sh = getOrCreateSheet_(PATIENTS_SHEET, PATIENT_COLUMNS);
  // Every row must carry its persisted id before it is served: zero writes
  // and no lock in the steady state (the getData_ discipline).
  backfillPatientIdsLocked_(sh);
  const rows = readSheet_(sh, PATIENT_COLUMNS);
  return { ok: true, patients: buildCoordinatorsRoster_(rows, coordReleasedCutoff_()) };
}

/* Validate the discharge payload → { ok:true, value } | { ok:false, error }. Pure
 * apart from `today`. */
function coordDischargeInput_(params, today) {
  const p = params || {};
  const id = String(p.id == null ? '' : p.id).trim();
  if (!id || id.length > COORD_ID_MAX || /[\u0000-\u001f\u007f]/.test(id)) {
    return { ok: false, error: 'invalid_id' };
  }
  const dischargeDate = coordIsoDateClean_(p.dischargeDate);
  if (!dischargeDate) return { ok: false, error: 'invalid_discharge_date' };
  if (dischargeDate > today) return { ok: false, error: 'discharge_date_in_future' };
  const by = coordTextClean_(p.by, COORD_BY_MAX);
  if (!by) return { ok: false, error: 'missing_by' };
  const reason = coordTextClean_(p.reason, COORD_REASON_MAX);
  return { ok: true, value: { id: id, dischargeDate: dischargeDate, by: by, reason: reason } };
}

function recordDischargeFromCoordinators_(params) {
  const input = coordDischargeInput_(params, coordToday_());
  if (!input.ok) return input;
  const v = input.value;

  const lock = LockService.getScriptLock();
  if (lock.tryLock(10000) !== true) return lockBusy_('recordDischargeFromCoordinators_');
  try {
    const sh = getOrCreateSheet_(PATIENTS_SHEET, PATIENT_COLUMNS);
    const lastRow = sh.getLastRow();
    const idIdx = PATIENT_COLUMNS.indexOf('id');
    const matches = [];
    let values = [];
    if (lastRow >= 2) {
      values = sh.getRange(2, 1, lastRow - 1, PATIENT_COLUMNS.length).getValues();
      for (let i = 0; i < values.length; i++) {
        if (String(values[i][idIdx] == null ? '' : values[i][idIdx]).trim() === v.id) matches.push(i);
      }
    }
    if (matches.length === 0) return { ok: false, error: 'patient_not_found' };
    if (matches.length > 1) return { ok: false, error: 'ambiguous_patient_id' };

    const rowIdx = matches[0];
    const rowVals = values[rowIdx];
    const patient = {};
    for (let c = 0; c < PATIENT_COLUMNS.length; c++) patient[PATIENT_COLUMNS[c]] = rowVals[c];
    // The write reaches only patients the feed can show: a house outside the
    // coordinators' canonical set (sde / unknown) answers like an unknown id.
    if (!canonicalDigestHouse_(patient.houseId)) return { ok: false, error: 'patient_not_found' };
    const admissionDate = asISODate_(patient.date);
    const currentExit = asISODate_(patient.exitDate);

    if (coordStatusReleased_(patient.status)) {
      if (currentExit === v.dischargeDate) {
        // Idempotent replay (or the Dashboard already recorded this exact
        // discharge): nothing to do, nothing written.
        return { ok: true, discharged: false, alreadyDischarged: true, id: v.id, dischargeDate: currentExit };
      }
      return { ok: false, error: 'already_discharged', id: v.id, dischargeDate: currentExit };
    }
    if (admissionDate && v.dischargeDate < admissionDate) {
      return { ok: false, error: 'discharge_before_admission', admissionDate: admissionDate };
    }

    const nowIso = new Date().toISOString();
    const stampBy = ('רכזות · ' + v.by).slice(0, 40);

    // a. The audit row FIRST (durable intent; deterministic id → idempotent).
    const dischargedSh = getOrCreateSheet_(DISCHARGED_PATIENTS_SHEET, DISCHARGED_PATIENT_COLUMNS);
    // Duplicate guard (CHANGELOG-duplicate-discharges.md): this stay already
    // has an OPEN discharge row (the Dashboard's, whose Patients flip was
    // clobbered or has not landed yet) → write NOTHING. The Dashboard's
    // load-time heal completes the release from that row.
    const coordAuditId = 'coord-' + v.id + '-' + v.dischargeDate;
    const openRows = openDischargeRowsForStay_(readSheet_(dischargedSh, DISCHARGED_PATIENT_COLUMNS),
      dischargeStayKey_({ houseId: patient.houseId, name: patient.name, date: admissionDate }), coordAuditId);
    if (openRows.length) {
      return { ok: true, discharged: false, alreadyDischarged: true, duplicate: true, id: v.id,
        auditId: String(openRows[0].id), dischargeDate: asISODate_(openRows[0].exitDate) };
    }
    const audit = {};
    for (let c = 0; c < PATIENT_COLUMNS.length; c++) {
      if (PATIENT_META_COLUMNS.indexOf(PATIENT_COLUMNS[c]) >= 0) continue; // own id + stamps below
      audit[PATIENT_COLUMNS[c]] = rowVals[c];
    }
    audit.id              = coordAuditId;
    audit.date            = admissionDate;
    audit.status          = 'released';
    audit.exitDate        = v.dischargeDate;
    audit.dischargedAt    = nowIso;
    audit.disposition     = '';
    audit.discharge_note  = v.reason;
    audit.restored        = '';
    audit.prior_status    = String(patient.status == null ? '' : patient.status).trim();
    audit.updatedAt       = nowIso;
    audit.updatedBy       = stampBy;
    audit.dischargeSource = COORD_DISCHARGE_SOURCE;
    audit.dischargedBy    = v.by;
    audit.dischargeReason = v.reason;
    audit.patientId       = v.id;
    upsertRowById_(dischargedSh, DISCHARGED_PATIENT_COLUMNS, audit);

    // b. The Patients row: four cells, nothing else touched, never deleted.
    // `status` is written LAST: an interrupted write leaves the row not yet
    // released, so the retry runs the full discharge again (never a false
    // 'already_discharged').
    const sheetRow = rowIdx + 2;
    const setCell = function (col, val) {
      sh.getRange(sheetRow, PATIENT_COLUMNS.indexOf(col) + 1).setValue(val);
    };
    setCell('exitDate', v.dischargeDate);
    setCell('updatedAt', nowIso);
    setCell('updatedBy', stampBy);
    setCell('status', 'released');

    logAudit_('patient_discharged_by_coordinators', 'recordDischargeFromCoordinators_',
      patient.fromLead || v.id, String(patient.name == null ? '' : patient.name), {
        id: v.id, houseId: String(patient.houseId == null ? '' : patient.houseId),
        dischargeDate: v.dischargeDate, priorStatus: audit.prior_status, by: v.by, auditId: audit.id,
      }, stampBy);
    return { ok: true, discharged: true, id: v.id, dischargeDate: v.dischargeDate };
  } finally {
    try { lock.releaseLock(); } catch (_) { /* no-op */ }
  }
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
  return constantTimeEquals_(got, expected);   // constant-time (0b-2)
}

/* The stable outcome keys a report may carry — must match
 * MEETING_REPORT_OUTCOME_LABELS in public/app.js (PR 1). */
const MEETING_REPORT_OUTCOMES = ['advancing', 'undecided', 'not_fit', 'no_show'];

/* Preset companion keys — must match MEETING_COMPANION_LABELS in public/app.js
 * (PR 1). A companion value outside this list is the אחר flow: raw free text,
 * stored as-is (capped at 100 chars by validation). */
const MEETING_COMPANION_KEYS =
  ['mother', 'father', 'parents', 'partner', 'sibling', 'friend', 'alone', 'other'];

/* The ONLY cap on the manager report's פירוט (meetingNote) free text. Raised
 * 2000 → 5000 (Sandra, Sep 2026: managers write a full meeting summary there).
 * KEEP IN SYNC with MANAGER_REPORT_MAX_CHARS in public/meeting-report.js,
 * public/app.js and server.js — test/manager-report-length.test.js fails if
 * the four drift apart or if any other numeric literal caps this field.
 * The limit REJECTS; nothing on the write path ever truncates the text. */
const MANAGER_REPORT_MAX_CHARS = 5000;

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
 * MEETING_REPORT_OUTCOMES, companion free text over 100 chars, note over
 * MANAGER_REPORT_MAX_CHARS (5000) chars, or a blank/oversized reporter. On
 * success the five report fields are written via upsertRowById_
 * (read-merge-write: the full existing row is preserved, only the
 * meeting-report fields change) and meetingSeen resets to
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
  // Over the cap is REFUSED, never trimmed: a silently truncated clinical
  // summary is worse than a visible refusal. The message carries lengths only
  // — report text is never echoed into a response or a log.
  if (note.length > MANAGER_REPORT_MAX_CHARS) {
    return {
      ok: false,
      error: 'bad_note',
      message: 'הפירוט מוגבל ל-' + MANAGER_REPORT_MAX_CHARS + ' תווים (נשלחו ' + note.length + ')',
    };
  }
  if (!reporter || reporter.length > 100) {
    return { ok: false, error: 'bad_reporter', message: 'reporter is required (max 100 chars)' };
  }
  // The form's idempotency key (CHANGELOG-write-path-hardening.md): same
  // shape as reportPayment's; malformed → refused, nothing written.
  const submissionId = receiptSubmissionIdClean_(report.submissionId);
  if (submissionId === null) return { ok: false, error: 'bad_submission_id', message: 'bad submissionId' };

  /* Under the script lock, like every other writer: the read-merge-write of
   * one lead row below must not interleave with a saveAll rebuilding Leads. */
  const lock = LockService.getScriptLock();
  if (lock.tryLock(10000) !== true) return lockBusy_('submitMeetingReport_');
  try {
    // A RETRY of a submission whose answer was lost: replay the stored answer
    // — never a second reportedAt, never «נצפה» reset again.
    const cacheKey = submissionId ? MEETING_REPORT_REPLAY_PREFIX + submissionId : '';
    if (cacheKey) {
      const seen = CacheService.getScriptCache().get(cacheKey);
      if (seen) {
        try {
          const prior = JSON.parse(seen);
          if (prior && prior.saved && String(prior.saved.leadId) === leadId) {
            return Object.assign({}, prior, { replayed: true });
          }
        } catch (_) { /* a corrupt entry is ignored: the write below runs */ }
      }
    }
    const res = submitMeetingReportLocked_(leadId, outcome, companion, note, reporter);
    if (cacheKey && res && res.ok === true) {
      try { CacheService.getScriptCache().put(cacheKey, JSON.stringify(res), MEETING_REPORT_REPLAY_TTL_S); } catch (_) { /* best effort */ }
    }
    return res;
  } finally {
    try { lock.releaseLock(); } catch (_) { /* no-op */ }
  }
}

/* The idempotency window for a meeting report retry (CacheService; a retry
 * after a lost answer comes within minutes). Keys hold the saved answer only
 * — no report text. */
const MEETING_REPORT_REPLAY_PREFIX = 'mr-sub:';
const MEETING_REPORT_REPLAY_TTL_S = 6 * 60 * 60;

/* The write itself, called by submitMeetingReport_ under the script lock. */
function submitMeetingReportLocked_(leadId, outcome, companion, note, reporter) {
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
function deleteMeetingReport_(leadId, actor) {
  const id = leadId == null ? '' : String(leadId).trim();
  if (!id) return { ok: false, error: 'bad_lead', message: 'leadId is required' };

  const lock = LockService.getScriptLock();
  if (lock.tryLock(10000) !== true) return lockBusy_('deleteMeetingReport_');
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

    logAudit_('meeting_report_deleted', 'deleteMeetingReport_', id, String(lead.name || ''), {}, actor);
    return { ok: true, deleted: { leadId: id } };
  } finally {
    try { lock.releaseLock(); } catch (_) { /* no-op */ }
  }
}

/* ===== Payments ===== */

/* Normalize a coverage-period cell to bare 'YYYY-MM-DD', or '' when it is
 * blank / unusable. Accepts what the sheet or the client may hand over: a
 * bare ISO date (kept verbatim), or a Date object / ISO timestamp, read by
 * its LOCAL parts — never toISOString().slice(0,10), which lands a day early
 * for Israel. Anything else is rejected by the caller, not silently coerced. */
function coverageDateISO_(v) {
  if (v === null || v === undefined || v === '') return '';
  if (typeof v === 'string') {
    var t = v.trim();
    if (!t) return '';
    var m = t.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    // Shape is not enough: '2026-13-45' matches the pattern and would roll
    // over into a different, valid-looking day. The parts must be a REAL
    // calendar date — round-trip them through a local Date and insist the
    // parts come back unchanged.
    if (m) return isRealCalendarDate_(Number(m[1]), Number(m[2]), Number(m[3])) ? t : null;
    /* A full ISO timestamp, and ONLY that. Handing an arbitrary string to
     * `new Date()` would accept loose forms like '2026-1-5' whose parsing is
     * engine-dependent — and the client mirror would reject them, forking
     * the rule. Anything unrecognized is refused. */
    if (!/^\d{4}-\d{2}-\d{2}T/.test(t)) return null;
    var ts = new Date(t);
    if (isNaN(ts.getTime())) return null;            // unusable — caller refuses
    return localPartsISO_(ts);
  }
  // A Sheets date cell. A number, a boolean or an object is NOT a date and
  // is refused rather than coerced (new Date(0) would read as 1970-01-01).
  if (!(v instanceof Date)) return null;
  if (isNaN(v.getTime())) return null;
  return localPartsISO_(v);
}

/* A Date's LOCAL calendar day as 'YYYY-MM-DD' — never toISOString().slice(),
 * which lands a day early for Israel. */
function localPartsISO_(d) {
  return d.getFullYear() + '-' +
    ('0' + (d.getMonth() + 1)).slice(-2) + '-' +
    ('0' + d.getDate()).slice(-2);
}

/* Do (y, m1, day) name a day that actually exists? Feb 30 and month 13 do
 * not; Date rolls both over silently, so the parts are compared back. */
function isRealCalendarDate_(y, m1, day) {
  if (!(m1 >= 1 && m1 <= 12) || !(day >= 1 && day <= 31)) return false;
  var d = new Date(y, m1 - 1, day);
  return d.getFullYear() === y && d.getMonth() === m1 - 1 && d.getDate() === day;
}

/* SERVER-SIDE validation of a payment's recorded coverage period — the
 * authority, mirroring coveragePeriodError() in app.js. The client checks the
 * same rule for immediate feedback, but a hand-built POST bypasses the client
 * entirely, so nothing reaches the Payments sheet without passing here.
 *
 * Returns '' when acceptable, otherwise the Hebrew reason, surfaced to the
 * caller as { ok:false, error } — never swallowed, never "fixed" by writing
 * a guessed period.
 *
 * REFUSED: a half-filled pair, a malformed date, an end before its start, a
 * span longer than COVERAGE_MAX_DAYS.
 * NOT REFUSED: a blank pair (means "use the inferred cycle" — what every
 * historical row carries), and overlaps or gaps against OTHER rows, which
 * are legitimate (two months paid at once, a skipped month, a re-dated
 * cycle) and which the credits ledger already de-duplicates day by day. */
function coveragePeriodError_(startRaw, endRaw) {
  /* PRESENCE first, then validity — the same order as the client. Deciding
   * "half-filled" from the PARSED value would report '' + 'garbage' as a
   * malformed date on the server and as a missing date on the client, and
   * the two messages must match (parity is asserted in
   * test/payment-coverage-period.test.js). */
  var rawS = (startRaw === null || startRaw === undefined) ? '' : String(startRaw).trim();
  var rawE = (endRaw === null || endRaw === undefined) ? '' : String(endRaw).trim();
  if (!rawS && !rawE) return '';
  if (!rawS || !rawE) return 'יש למלא גם תאריך התחלה וגם תאריך סיום לתקופת הכיסוי';
  var s = coverageDateISO_(startRaw);
  var e = coverageDateISO_(endRaw);
  if (!s || !e) return 'תאריך לא תקין בתקופת הכיסוי';
  // Local-midnight Dates from the parts — never Date.parse, which reads a
  // bare ISO date as UTC midnight.
  var sp = s.split('-'), ep = e.split('-');
  var ds = new Date(Number(sp[0]), Number(sp[1]) - 1, Number(sp[2]));
  var de = new Date(Number(ep[0]), Number(ep[1]) - 1, Number(ep[2]));
  if (isNaN(ds.getTime()) || isNaN(de.getTime())) return 'תאריך לא תקין בתקופת הכיסוי';
  if (de.getTime() < ds.getTime()) return 'תאריך הסיום מוקדם מתאריך ההתחלה';
  // Math.round absorbs the ±1h a DST switch injects between local midnights.
  var days = Math.round((de.getTime() - ds.getTime()) / 86400000) + 1;
  if (days > COVERAGE_MAX_DAYS) {
    return 'תקופת כיסוי ארוכה מדי (' + days + ' ימים, המקסימום ' + COVERAGE_MAX_DAYS + ')';
  }
  return '';
}

function getPayments_() {
  const perf = perfStart_('getPayments_');
  // READ accessor: no whole-column re-format on a load (sheetForRead_);
  // savePayment still runs getOrCreateSheet_ before every write.
  const sh = sheetForRead_(PAYMENTS_SHEET, PAYMENT_COLUMNS);
  let values = sheetValues_(sh, PAYMENT_COLUMNS);   // the ONE read of Payments
  perfLap_(perf, 'read');
  /* Heal the stable-identity cells BEFORE answering, exactly as getData_ heals
   * the Patients `id` column: the uids handed to any reader are then the ones
   * now stored on the sheet. One-time (the first read after the columns land);
   * ZERO writes and no lock once every cell is filled. It mints identity only
   * — it never touches an amount, a status or a charge stamp. The pre-scan
   * runs over the values just read; only a sheet that was healed is read
   * again, so the answer carries the stored uids. */
  const healed = backfillPaymentIdentityLocked_(sh, values);
  if (healed.paymentUids || healed.patientUids) values = sheetValues_(sh, PAYMENT_COLUMNS);
  perfLap_(perf, 'backfill');
  /* Phase 3 PR 2: `payments` stays what every reader expects — one row per
   * CYCLE — with the money of each cycle that has receipts derived from them
   * (recomputeCycleFromReceipts_; a legacy cycle is returned untouched).
   * The receipts themselves ride a NEW key, each with the cycleId it pays
   * for ('' = unlinked), and `funders` carries the Funders tab (read-only,
   * never created here) for the patient card. */
  const split = paymentRowsDerived_(rowsFromValues_(values, PAYMENT_COLUMNS));
  let funders = [];
  try { funders = fundersForClient_(fundersRows_()); } catch (_) { funders = []; }
  perfEnd_(perf, 'payments=' + split.cycles.length + ' receipts=' + split.receipts.length);
  return { ok: true, payments: split.cycles, receipts: split.receipts, funders: funders };
}

/**
 * Upsert a single payment row by id. Both `savePayment` and `updatePayment`
 * route here: if a row with the same id exists it's replaced in place,
 * otherwise the record is appended. id is required — it's generated client-
 * side as a deterministic `pay::<houseId>::<name>::<entryDate>::<dueDate>`
 * string so the same monthly payment always maps to the same row.
 */
/* A persisted patient id, or '' — and NOTHING else reaches a cell.
 *
 * Ids are minted server-side as 'id-<uuid>' (assignId in
 * replaceHousePatients_), so a value carrying a control character, a line
 * break or a formula lead-in is not an id: it is a bug or somebody probing.
 * savePayment is reachable by any caller holding the API key, and this value
 * decides which patient a sum of money belongs to. */
function paymentLinkUidClean_(v) {
  var t = String(v == null ? '' : v).trim();
  if (!t) return '';
  if (t.length > PAYMENT_LINK_UID_MAX) return '';
  if (/[\u0000-\u001f\u007f]/.test(t)) return '';
  return t;
}
/* A one-line reason, cap-limited, control characters flattened and a leading
 * '='/'+'/'@'/'-' stripped — a text-forced cell will not evaluate a formula,
 * but this note is also rendered on screen and exported, so it never leaves
 * here carrying one. */
function paymentLinkNoteClean_(v) {
  var t = String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  t = t.replace(/^[=+@-]+/, '').trim();
  return t.slice(0, PAYMENT_LINK_NOTE_MAX);
}
function paymentLinkStatusClean_(v) {
  var t = String(v == null ? '' : v).trim();
  return PAYMENT_LINK_STATUSES.indexOf(t) >= 0 ? t : '';
}

function upsertPayment_(payment, user, ctx) {
  if (!payment || typeof payment !== 'object') {
    return { ok: false, error: 'missing_payment' };
  }
  if (!payment.id) {
    return { ok: false, error: 'missing_id' };
  }
  /* Coverage period: validated BEFORE the lock is taken and before a single
   * cell is touched, so a bad period is refused outright rather than
   * half-written. The client validates the same rule, but this is the
   * authority — savePayment is reachable by any caller holding the API key,
   * and a wrong period here silently moves money between months on the
   * הכנסות חודשיות screen. The reason is returned verbatim, not
   * swallowed: the client surfaces it. */
  const coverageError = coveragePeriodError_(payment.coverageStart, payment.coverageEnd);
  if (coverageError) {
    return { ok: false, error: coverageError };
  }
  /* Store the NORMALIZED pair, so a Date-typed cell or an ISO timestamp from
   * any caller lands as the same bare 'YYYY-MM-DD' text every reader
   * expects. A blank pair stays blank — it means "infer", and writing a
   * guessed period would be exactly the assumption this column replaces. */
  payment.coverageStart = coverageDateISO_(payment.coverageStart) || '';
  payment.coverageEnd   = coverageDateISO_(payment.coverageEnd) || '';

  /* ---- the manual link ---------------------------------------------------
   * The DECISION is the client's to send; none of it is trusted as sent.
   * linkedBy / linkedAt are not read off the request at all — they are in
   * PAYMENT_SERVER_COLUMNS and stampPaymentRow_ writes them. */
  payment.linkPatientUid = paymentLinkUidClean_(payment.linkPatientUid);
  payment.linkStatus     = paymentLinkStatusClean_(payment.linkStatus);
  payment.linkNote       = paymentLinkNoteClean_(payment.linkNote);
  /* "Not a patient" with no reason is a dismissal nobody can audit, and is
   * indistinguishable a year later from a row nobody ever reviewed. Refused
   * here as well as in the browser, because the browser is not the authority. */
  if (payment.linkStatus === 'not_a_patient' && !payment.linkNote) {
    return { ok: false, error: 'יש לציין סיבה לסימון "לא מטופל"' };
  }
  /* A link with no patient behind it is not a link. Refused rather than
   * silently downgraded, so a caller never believes it recorded a decision
   * the sheet does not hold. */
  if (payment.linkStatus === 'linked' && !payment.linkPatientUid) {
    return { ok: false, error: 'שיוך ידני מחייב מזהה מטופל קבוע' };
  }
  /* ---- the void, and the two things that may never be separated ----------
   * A void row must carry the DECISION that voided it and the REASON for it.
   * Refusing the pair here is what stops a status of 'void' ever appearing on
   * the sheet with nothing behind it — which would read, a year from now,
   * exactly like a row somebody mistyped. */
  if (isVoidStatus_(payment.status) && payment.linkStatus !== 'duplicate') {
    return { ok: false, error: 'ביטול שורה מחייב סימון ככפילות' };
  }
  if (payment.linkStatus === 'duplicate') {
    if (!isVoidStatus_(payment.status)) {
      return { ok: false, error: 'סימון ככפילות מחייב סטטוס מבוטל' };
    }
    if (!payment.linkNote) {
      return { ok: false, error: 'יש לציין סיבה לסימון ככפילות' };
    }
  }

  /* The stamping user. NEVER params.user as the browser sent it: the Railway
   * proxy overwrites body.user from the SIGNED SESSION COOKIE on every
   * /api/sheets POST, handle_ re-normalizes it through requestUser_, and this
   * is the value that lands in chargedBy. The PR #113 rule, applied to money.
   * Blank for a legacy user-less cookie — allowed by contract, and blank is
   * honest where a guessed name would not be. */
  const stampUser = String(user == null ? '' : user);
  /* ctx (from handle_): { actor, verified }. `actor` is the AuditLog actor
   * label; `verified` is whether PROXY_SECRET verified. A direct call (an
   * editor job or a test) passes nothing and keeps the old behavior. */
  const c = ctx && typeof ctx === 'object' ? ctx : {};
  const auditActor = c.actor === undefined ? stampUser : String(c.actor);
  /* The invoice pair as the caller sent it — kept apart, because a receipt
   * edit below replaces `payment` with the stored row. */
  const invoiceIn = { invoiceWanted: payment.invoiceWanted, invoiceTo: payment.invoiceTo };

  const lock = LockService.getScriptLock();
  if (lock.tryLock(10000) !== true) return lockBusy_('upsertPayment_');
  try {
    const sh = getOrCreateSheet_(PAYMENTS_SHEET, PAYMENT_COLUMNS);
    const idIdx = PAYMENT_COLUMNS.indexOf('id');
    const lastRow = sh.getLastRow();

    // Find the existing row (if any) and read it WHOLE — every server-owned
    // decision below is made against the SHEET, never against the payload.
    let targetRow = 0;
    const prev = {};
    let hadRow = false;
    let existing = [];
    if (lastRow > 1) {
      existing = sh.getRange(2, 1, lastRow - 1, PAYMENT_COLUMNS.length).getValues();
      for (let i = 0; i < existing.length; i++) {
        if (String(existing[i][idIdx]) === String(payment.id)) {
          targetRow = i + 2;
          hadRow = true;
          for (let c = 0; c < PAYMENT_COLUMNS.length; c++) prev[PAYMENT_COLUMNS[c]] = existing[i][c];
          break;
        }
      }
    }

    /* UN-VOIDING IS SANDRA'S ALONE (APPROVER_ACTIONS 'unvoidPayment').
     * Checked HERE, against the row the sheet actually holds: the caller must
     * hold the verified `approver` role (Sandra's personal session — c.approver
     * comes from hasRole_, never from the payload) AND the name in the SIGNED
     * SESSION COOKIE must be hers. Marking a duplicate is daily work;
     * unmarking one puts a second payment back into every revenue and debt
     * figure, which is a money decision. Refused before a single cell moves. */
    if (hadRow && isVoidStatus_(prev.status) && !isVoidStatus_(payment.status)
        && (PAYMENT_VOID_REVERSERS.indexOf(stampUser) < 0 || c.approver !== true)) {
      return { ok: false, error: 'forbidden_role', message: ROLE_FORBIDDEN_MESSAGE };
    }

    /* ---- receipts (Phase 3 PR 2) --------------------------------------
     * A receipt is born ONLY through reportPayment_, and is never edited: the
     * one thing savePayment may do to it is the void decision (and Sandra's
     * un-void) — everything else is taken from the stored row. A cycle that
     * has receipts gets its money DERIVED from them, whatever the payload
     * says, and cannot be voided while a live receipt still pays it. */
    const isReceipt = isReceiptRow_(payment) || (hadRow && isReceiptRow_(prev));
    let cycleHasReceipts = false;
    if (isReceipt && !hadRow) {
      return { ok: false, error: 'receipt_via_report_only', message: 'קבלה נרשמת רק דרך «דווח תשלום»' };
    }
    if (isReceipt) {
      const voidMove = isVoidStatus_(payment.status) !== isVoidStatus_(prev.status);
      /* «כפילות» from Ortal's tab (confirmDuplicate_, ctx.duplicateGuard):
       * the receipt may not be the ONLY live receipt of its cycle — then it
       * is not a duplicate of anything there. Decided here, under the lock,
       * against the sheet. CHANGELOG-receipt-duplicates-and-edit.md. */
      if (voidMove && isVoidStatus_(payment.status) && c.duplicateGuard === true
          && !receiptHasLiveSibling_(existing, targetRow - 2)) {
        return { ok: false, error: 'duplicate_last_receipt', message: DUPLICATE_LAST_RECEIPT_MESSAGE };
      }
      /* The one other edit a receipt takes: its invoice choice (validated by
       * paymentInvoiceFields_ below, audited). Every other cell is kept. */
      const invoiceEdit = !voidMove && paymentInvoiceFields_(invoiceIn, prev, {}).change !== null;
      const invoiceBad = !voidMove && !paymentInvoiceFields_(invoiceIn, prev, {}).ok;
      /* A RETRY of a void whose first answer was lost: the receipt is already
       * void as a duplicate with this very reason. Answer the stored row and
       * its cycle, write nothing (CHANGELOG-write-path-hardening.md). */
      if (!voidMove && !invoiceEdit && isVoidStatus_(payment.status)) {
        const replay = receiptVoidReplay_(existing, payment.id, payment.linkNote);
        if (replay) return replay;
      }
      if (!voidMove && !invoiceEdit && !invoiceBad) return { ok: false, error: 'receipt_immutable', message: 'קבלה אינה ניתנת לעריכה — ניתן רק לבטל אותה' };
      const keep = {};
      PAYMENT_COLUMNS.forEach(function (k) { keep[k] = prev[k]; });
      if (voidMove) {
        keep.status = isVoidStatus_(payment.status) ? PAYMENT_VOID_STATUS : 'paid';
        keep.linkStatus = payment.linkStatus;
        keep.linkNote = payment.linkNote;
      } else {
        keep.linkStatus = paymentCell_(prev.linkStatus);
        keep.linkNote = paymentCell_(prev.linkNote);
      }
      keep.linkPatientUid = paymentCell_(prev.linkPatientUid);
      keep.timestamp = payment.timestamp || prev.timestamp;
      payment = keep;
    } else if (hadRow) {
      const rowsNow = existing.map(function (g) {
        const o = {};
        for (let k = 0; k < PAYMENT_COLUMNS.length; k++) o[PAYMENT_COLUMNS[k]] = g[k];
        return o;
      });
      const mine = linkReceiptsToCycles_(rowsNow).byCycle[targetRow - 2];
      if (mine && mine.length) {
        cycleHasReceipts = true;
        const live = mine.some(function (r) { return !isVoidStatus_(r.status); });
        if (isVoidStatus_(payment.status) && !isVoidStatus_(prev.status) && live) {
          return { ok: false, error: 'cycle_has_receipts', message: 'יש קבלות פעילות על המחזור — יש לבטל אותן קודם' };
        }
        if (!isVoidStatus_(payment.status) && !isVoidStatus_(prev.status)) {
          const d = recomputeCycleFromReceipts_(prev, mine);
          payment.amountPaid = d.amountPaid;
          payment.balance = d.balance;
          payment.status = d.status;
        }
      }
    }

    /* Item H (Phase 4, closes PR #176 choice 7): money is reported ONLY
     * through «דווח תשלום». A cycle with no receipts used to accept the old
     * direct amountPaid / status write (a stale cached page); it is refused
     * now too — nothing is written. Linking, the coverage period, a void and
     * Sandra's un-void are unaffected (they do not move money). Decided for
     * every call through handle_ (ctx.refuseLegacyMoney); a direct editor-run
     * call has no HTTP caller and keeps the old behaviour. */
    if (c.refuseLegacyMoney === true && !isReceipt && !cycleHasReceipts) {
      const legacyNo = legacyMoneyWriteRefused_(payment, hadRow ? prev : null);
      if (legacyNo) return legacyNo;
    }

    /* The payment report columns (Phase 3 PR 1). Decided against the STORED
     * row: a payload without them keeps what the sheet holds; receivedDate is
     * append-only; the confirm fields need controller / approver (c.privileged
     * comes from hasRole_, never from the payload). Refused before a single
     * cell moves. A hand-added column where a report column belongs leaves
     * all eleven exactly as stored (paymentReportHeaderClash_). */
    const clash = paymentReportHeaderClash_(sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), 1)).getValues()[0]);
    if (clash.length) {
      try { console.warn('[payments] report columns not used — header clash at column ' + clash[0].column); } catch (_) { /* no-op */ }
    }
    const rep = paymentReportFields_(payment, prev, { stampUser: stampUser, privileged: c.privileged === true, headerClash: clash.length > 0 });
    if (!rep.ok) return rep;
    /* The invoice pair (CHANGELOG-payment-invoice.md): same rules as the
     * report; refused before a single cell moves. */
    const invClash = paymentInvoiceHeaderClash_(sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), 1)).getValues()[0]);
    const inv = paymentInvoiceFields_(invoiceIn, prev, { headerClash: invClash.length > 0 });
    if (!inv.ok) return inv;
    const merged = {};
    Object.keys(payment).forEach(function (k) { merged[k] = payment[k]; });
    Object.keys(rep.fields).forEach(function (k) { merged[k] = rep.fields[k]; });
    Object.keys(inv.fields).forEach(function (k) { merged[k] = inv.fields[k]; });
    /* Ortal's partial amount and note (PAYMENT_CONTROL_COLUMNS) are written
     * ONLY by confirmPayment_: whatever the payload says, the stored cells
     * stay (blank on a new row). */
    PAYMENT_CONTROL_COLUMNS.forEach(function (k) {
      merged[k] = hadRow && prev[k] !== undefined && prev[k] !== null ? prev[k] : '';
    });

    const out = stampPaymentRow_(merged, prev, hadRow, stampUser);
    // A first report that names no funder gets the patient's current one —
    // and is REFUSED, nothing written, when the patient has none (no default).
    if (rep.needsFunder) {
      const f = currentFunder_(out.patientUid, out.receivedDate);
      if (f === FUNDER_UNSET) return { ok: false, error: 'funder_unset', message: PAYMENT_REPORT_MESSAGES.funder_unset };
      // A pro-bono patient's report must name its funder itself (never copied).
      if (f === FUNDER_PROBONO) return { ok: false, error: 'funder_probono_explicit', message: PAYMENT_REPORT_MESSAGES.funder_probono_explicit };
      out.funder = f;
    }
    const row = objectToRow_(out, PAYMENT_COLUMNS);
    const unvoided = hadRow && isVoidStatus_(prev.status) && !isVoidStatus_(out.status);
    /* Informational only (nothing is refused for it yet): what the report on
     * this row still lacks, for a row that carries a receivedDate. */
    const reportExtra = function (res) {
      if (paymentCell_(out.receivedDate)) res.reportIssues = validatePaymentReport_(paymentReportFromRow_(out));
      return res;
    };

    if (targetRow) {
      setPaymentRowTextCols_(sh, targetRow);
      sh.getRange(targetRow, 1, 1, PAYMENT_COLUMNS.length).setValues([row]);
      logPaymentLink_(out, prev, 'update', auditActor);
      if (unvoided) logPaymentVoidReversed_(out, prev, stampUser, auditActor);
      logPaymentReceivedDateChanged_(out, rep.receivedChange, stampUser, auditActor);
      logPaymentInvoiceChanged_(out, inv.change, stampUser, auditActor);
      logPaymentConfirm_(out, rep.confirmChange, auditActor);
      // A voided / un-voided receipt re-derives the cycle it pays for.
      const res = { ok: true, payment: out, updated: true };
      if (isReceipt) {
        const cy = rederiveReceiptCycleLocked_(sh, stampUser, out.id);
        if (cy) res.cycle = cy;
      }
      return reportExtra(res);
    }

    // Insert at the next row (not appendRow) so the text format is applied
    // BEFORE the value lands — the treatment upsertRowById_ gives its writes.
    const insertAt = sh.getLastRow() + 1;
    setPaymentRowTextCols_(sh, insertAt);
    sh.getRange(insertAt, 1, 1, PAYMENT_COLUMNS.length).setValues([row]);
    logPaymentLink_(out, prev, 'create', auditActor);
    logPaymentConfirm_(out, rep.confirmChange, auditActor);
    return reportExtra({ ok: true, payment: out, created: true });
  } finally {
    try { lock.releaseLock(); } catch (_) { /* no-op */ }
  }
}

/* Item H (Phase 4): the refusal a direct money write on a cycle gets.
 * PURE. payment = the request; prev = the stored row (null on insert).
 * Refused when the request CHANGES the money a cycle shows — its amountPaid,
 * or its paid / partial / unpaid status — outside a void / un-void move.
 * A request that echoes the stored figures (linking, the coverage period, an
 * override frozen on an unpaid cycle) passes. → null | refusal */
const USE_REPORT_PAYMENT_MESSAGE = 'יש לדווח תשלום דרך ״דווח תשלום״';
function legacyMoneyWriteRefused_(payment, prev) {
  const pay = payment || {};
  const had = !!prev;
  const P = prev || {};
  if (isVoidStatus_(pay.status) || (had && isVoidStatus_(P.status))) return null;
  const refuse = { ok: false, error: 'use_report_payment', message: USE_REPORT_PAYMENT_MESSAGE };
  const sentPaid = pay.amountPaid !== undefined && pay.amountPaid !== null && String(pay.amountPaid).trim() !== '';
  if (sentPaid && receiptMoney_(pay.amountPaid) !== (had ? receiptMoney_(P.amountPaid) : 0)) return refuse;
  const sentStatus = pay.status !== undefined && pay.status !== null && String(pay.status).trim() !== '';
  if (sentStatus && paymentStatus_(pay.status) !== (had ? paymentStatus_(P.status) : 'unpaid')) return refuse;
  return null;
}

/* Belt-and-suspenders over the whole-column '@' format getOrCreateSheet_
 * applies: force THIS row's text cells before the values land (the same guard
 * upsertCredit_ uses). */
function setPaymentRowTextCols_(sh, rowNumber) {
  for (let k = 0; k < PAYMENT_TEXT_COLUMNS.length; k++) {
    const c = PAYMENT_COLUMNS.indexOf(PAYMENT_TEXT_COLUMNS[k]);
    if (c >= 0) sh.getRange(rowNumber, c + 1, 1, 1).setNumberFormat('@');
  }
}

function paymentIsCharged_(status) {
  return PAYMENT_CHARGED_STATUSES.indexOf(paymentStatus_(status)) >= 0;
}

/* Comparable form of a cell for the content-change test: a number read back
 * from Sheets and the same number sent as JSON must compare equal. */
function paymentCell_(v) {
  return String(v === null || v === undefined ? '' : v).trim();
}

/* Did this write CHANGE the row's content? Server-owned bookkeeping and the
 * client's `timestamp` are excluded (PAYMENT_VERSION_IGNORED_COLUMNS) — a
 * version that ticked on every no-op save would hand the accounting app a
 * queue full of rows that did not move. */
function paymentContentChanged_(prev, next) {
  for (let i = 0; i < PAYMENT_COLUMNS.length; i++) {
    const col = PAYMENT_COLUMNS[i];
    if (PAYMENT_VERSION_IGNORED_COLUMNS.indexOf(col) >= 0) continue;
    if (paymentCell_(prev[col]) !== paymentCell_(next[col])) return true;
  }
  return false;
}

/**
 * Build the row that will actually be written: the caller's content columns,
 * plus the SEVEN server-owned accounting columns decided here and nowhere else.
 *
 * `prev` is the sheet row as an object ({} for an insert); `hadRow` says which.
 * PURE — no sheet access, no clock beyond israelTimestamp_ — so the rules
 * below are directly testable.
 *
 * IDENTITY
 *   paymentUid : the sheet's, or one freshly minted. Once set it is carried
 *                verbatim forever — a renamed patient, a corrected due date,
 *                an edited amount and a status flip all leave it alone.
 *   patientUid : the sheet's if present; otherwise resolved ONCE by an exact
 *                match of the billing triple (never by name). Unresolved
 *                stays blank.
 *   payerUid   : carried; never minted here (see PAYMENT_COLUMNS).
 *
 * CHARGE STAMP — "reported paid by Vered", not "confirmed in the bank".
 *   Stamped when the row is paid/partial AND either it was not paid/partial
 *   before (a real report event) or amountPaid MOVED (a correction to the
 *   reported figure, which the accounting app must re-verify).
 *   Carried unchanged on a re-save that reports the same figure — which is
 *   exactly why a HISTORICAL paid row stays BLANK: its stamp is '' on the
 *   sheet, nothing about it changed, so '' is what gets carried. No stamp is
 *   ever derived from `timestamp`, `dueDate` or anything else: nobody recorded
 *   who reported those rows, and inventing an answer would be a lie an
 *   accountant would act on.
 *   Cleared when the row leaves paid/partial: a row reverted to unpaid was not
 *   reported paid, and "stamped but unpaid" is a state no reader should have
 *   to interpret. The sourceVersion bump is what tells the accounting app the
 *   record changed after it confirmed.
 *
 * CHANGE TRACKING
 *   sourceUpdatedAt/sourceVersion move together, and only on a real content
 *   change (or an insert). Version 1 is the first content write after these
 *   columns shipped; a blank pair means the row has not been written since.
 */
function stampPaymentRow_(payment, prev, hadRow, stampUser, now) {
  prev = prev || {};
  const out = {};
  const keys = Object.keys(payment);
  for (let i = 0; i < keys.length; i++) out[keys[i]] = payment[keys[i]];
  // A hand-built POST may not set its own uid, its own charge stamp or its
  // own version. Drop them before anything else looks at `out`.
  for (let i = 0; i < PAYMENT_SERVER_COLUMNS.length; i++) delete out[PAYMENT_SERVER_COLUMNS[i]];

  const prevUid = paymentCell_(prev.paymentUid);
  out.paymentUid = prevUid || (PAYMENT_UID_PREFIX + Utilities.getUuid());

  /* ---- the manual link, and what it does to patientUid --------------------
   * linkPatientUid / linkStatus / linkNote are the DECISION and are carried
   * from the payload (blank means blank — the client always sends the whole
   * row). linkedBy / linkedAt were dropped above with the other server-owned
   * columns and are written below, only when the decision actually CHANGED:
   * re-stamping them on an unrelated save would turn the audit trail into a
   * record of the last time anybody touched the row. */
  const prevLinkUid    = paymentCell_(prev.linkPatientUid);
  const prevLinkStatus = paymentCell_(prev.linkStatus);
  out.linkPatientUid = paymentCell_(out.linkPatientUid);
  out.linkStatus     = paymentCell_(out.linkStatus);
  out.linkNote       = paymentCell_(out.linkNote);
  const linkDecided  = out.linkPatientUid !== prevLinkUid || out.linkStatus !== prevLinkStatus;

  const prevPatientUid = paymentCell_(prev.patientUid);
  if (out.linkStatus === 'linked' && out.linkPatientUid) {
    /* A PERSON looked at this row and said whose it is. That beats both the
     * automatic resolution and "immutable once resolved": the whole reason
     * the reconnect screen exists is that the triple can be wrong, and a
     * correction nobody may apply is not a correction. */
    out.patientUid = out.linkPatientUid;
  } else if (out.linkStatus === 'not_a_patient') {
    /* Declared not a patient's money. Leaving an automatic patient link on
     * such a row is exactly the wrong-ledger outcome these columns exist to
     * prevent, so the link is cleared — the one case where patientUid is not
     * immutable, and the decision that cleared it is recorded beside it. */
    out.patientUid = '';
  } else if (prevPatientUid) {
    out.patientUid = prevPatientUid;   // immutable once resolved
  } else {
    const key = paymentCell_(out.patientId);
    let resolved = '';
    if (key) {
      const index = patientUidIndexByKey_();
      resolved = index[key] || '';
    }
    out.patientUid = resolved;
  }

  if (linkDecided && out.linkStatus) {
    out.linkedBy = stampUser;
    out.linkedAt = israelTimestamp_(now);
  } else if (linkDecided) {
    out.linkedBy = '';                 // the decision was withdrawn
    out.linkedAt = '';
  } else {
    out.linkedBy = paymentCell_(prev.linkedBy);
    out.linkedAt = paymentCell_(prev.linkedAt);
  }

  out.payerUid = paymentCell_(prev.payerUid);
  // Server-owned (reportPayment_ sets it once, after this function); carried.
  out.legacyAmountPaid = paymentCell_(prev.legacyAmountPaid);

  const nowStamp = israelTimestamp_(now);

  const chargedNow = paymentIsCharged_(out.status);
  const chargedBefore = hadRow && paymentIsCharged_(prev.status);
  const paidChanged = paymentCell_(prev.amountPaid) !== paymentCell_(out.amountPaid);
  if (!chargedNow) {
    out.chargedAt = '';
    out.chargedBy = '';
  } else if (!chargedBefore || paidChanged) {
    out.chargedAt = nowStamp;
    out.chargedBy = stampUser;
  } else {
    out.chargedAt = paymentCell_(prev.chargedAt);
    out.chargedBy = paymentCell_(prev.chargedBy);
  }

  if (!hadRow || paymentContentChanged_(prev, out)) {
    out.sourceUpdatedAt = nowStamp;
    out.sourceVersion   = (Number(prev.sourceVersion) || 0) + 1;
  } else {
    out.sourceUpdatedAt = paymentCell_(prev.sourceUpdatedAt);
    out.sourceVersion   = prev.sourceVersion === '' || prev.sourceVersion === undefined || prev.sourceVersion === null
      ? '' : prev.sourceVersion;
  }
  return out;
}

/* The reversal of a void gets its OWN audit row, not just the link row above:
 * un-voiding is the rarer and more consequential of the two, and searching the
 * log for it should not mean filtering a link decision by what it used to be.
 * Fail-soft, like every logAudit_ caller. */
function logPaymentVoidReversed_(out, prev, user, actor) {
  logAudit_('payment_void_reversed', 'upsertPayment_',
    String(out.patientUid || ''), String(out.patientName || ''), {
      paymentId: String(out.id || ''),
      paymentUid: String(out.paymentUid || ''),
      patientId: String(out.patientId || ''),
      dueDate: String(out.dueDate || ''),
      amount: out.amount,
      amountPaid: out.amountPaid,
      restoredStatus: String(out.status || ''),
      previousNote: String((prev && prev.linkNote) || ''),
      by: String(user == null ? '' : user),
      at: israelTimestamp_(),
    }, actor === undefined ? String(user == null ? '' : user) : actor);
}

/* One AuditLog row per LINK DECISION — never for an ordinary payment save.
 * "Logged with who and when" has to survive the payment row being edited
 * again later, and the five columns on the row cannot do that: they hold the
 * LATEST decision, not the history of them. Fail-soft by the logAudit_
 * contract: audit logging never breaks the operation it records. */
function logPaymentLink_(out, prev, how, actor) {
  if (!out || !out.linkStatus) return;
  const before = prev || {};
  if (paymentCell_(before.linkStatus) === out.linkStatus
      && paymentCell_(before.linkPatientUid) === out.linkPatientUid) return;
  logAudit_('payment_link_' + out.linkStatus, 'upsertPayment_',
    String(out.patientUid || ''), String(out.patientName || ''), {
      how: String(how || ''),
      paymentId: String(out.id || ''),
      paymentUid: String(out.paymentUid || ''),
      patientId: String(out.patientId || ''),
      houseId: String(out.houseId || ''),
      dueDate: String(out.dueDate || ''),
      amount: out.amount,
      linkPatientUid: String(out.linkPatientUid || ''),
      previousPatientUid: String(before.patientUid || ''),
      note: String(out.linkNote || ''),
      by: String(out.linkedBy || ''),
      at: String(out.linkedAt || ''),
    }, actor === undefined ? String(out.linkedBy || '') : actor);
}

/* ===== The strict payment report: rules (PURE) =====
 * The authority for every rule in lib/payment-report-rules.js (its mirror;
 * a parity test runs both on the same inputs). See PAYMENT_REPORT_COLUMNS. */

function paymentReportText_(v) {
  return v === null || v === undefined ? '' : String(v).trim();
}
/* "צ׳ק" (geresh) and "צ’ק" are the stored "צ'ק". Nothing else is folded. */
function paymentReportMethod_(v) {
  return paymentReportText_(v).replace(/[\u05F3\u2019\u2018`]/g, "'");
}
function paymentReportRealDate_(y, m, d) {
  if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31 && y >= 1900 && y <= 2999)) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}
/* 'YYYY-MM-DD' or 'DD/MM/YYYY' → 'YYYY-MM-DD'; '' blank; null not a real date. */
function paymentReportDate_(v) {
  const t = paymentReportText_(v);
  if (!t) return '';
  let m = t.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return paymentReportRealDate_(+m[1], +m[2], +m[3]) ? t : null;
  m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) {
    const pad = function (n) { return (n < 10 ? '0' : '') + n; };
    return paymentReportRealDate_(+m[3], +m[2], +m[1]) ? m[3] + '-' + pad(+m[2]) + '-' + pad(+m[1]) : null;
  }
  return null;
}
function paymentReportToday_() {
  return Utilities.formatDate(new Date(), 'Asia/Jerusalem', 'yyyy-MM-dd');
}
function paymentReportDayNum_(iso) {
  const p = iso.split('-');
  return Math.round(Date.UTC(+p[0], +p[1] - 1, +p[2]) / 86400000);
}
function paymentReportAmountCode_(v) {
  if (v === null || v === undefined || paymentReportText_(v) === '') return 'amount_missing';
  let n;
  if (typeof v === 'number') {
    if (!isFinite(v)) return 'amount_invalid';
    n = v;
    if (Math.round(n * 100) / 100 !== n) return 'amount_invalid';
  } else {
    const t = paymentReportText_(v);
    if (/^-\d/.test(t) || /^0(\.0+)?$/.test(t)) return 'amount_not_positive';
    if (!/^\d+(\.\d{1,2})?$/.test(t)) return 'amount_invalid';
    n = Number(t);
  }
  return n > 0 ? '' : 'amount_not_positive';
}
function paymentReportPayerCode_(v) {
  const t = paymentReportText_(v);
  if (!t) return 'payer_missing';
  if (/[\u0000-\u001f\u007f]/.test(t) || /^[=+@-]/.test(t) || t.length < PAYER_MIN || t.length > PAYER_MAX) return 'payer_invalid';
  return '';
}
function paymentReportReferenceCode_(v, method) {
  const t = paymentReportText_(v);
  if (!t) return REFERENCE_REQUIRED_METHODS.indexOf(paymentReportMethod_(method)) >= 0 ? 'reference_missing' : '';
  if (t.length < REFERENCE_MIN || t.length > REFERENCE_MAX) return 'reference_invalid';
  return /^[A-Za-z0-9\u05D0-\u05EA][A-Za-z0-9\u05D0-\u05EA\-/]*$/.test(t) ? '' : 'reference_invalid';
}
function paymentReportIssue_(field, code) {
  return { field: field, code: code, hebrewMessage: PAYMENT_REPORT_MESSAGES[code] || code };
}

/* validatePaymentReport_(report, ctx) → [{ field, code, hebrewMessage }] in
 * PAYMENT_REPORT_FIELDS order; [] = valid. ctx.todayIso pins "today"
 * (default: today in Asia/Jerusalem). Pure but for that default.
 * `report.amount` is the money received (on a Payments row: amountPaid —
 * paymentReportFromRow_). NOT enforced on savePayment in this PR. */
function validatePaymentReport_(report, ctx) {
  const r = report && typeof report === 'object' ? report : {};
  const today = (ctx && ctx.todayIso) || paymentReportToday_();
  const out = [];

  const rd = paymentReportDate_(r.receivedDate);
  if (rd === '') out.push(paymentReportIssue_('receivedDate', 'received_date_missing'));
  else if (rd === null) out.push(paymentReportIssue_('receivedDate', 'received_date_invalid'));
  else if (rd > today) out.push(paymentReportIssue_('receivedDate', 'received_date_future'));
  /* ctx.maxDaysBack (Phase 3 PR 2): reportPayment_ passes
   * RECEIVED_DATE_STAFF_MAX_DAYS for everyone but the approver. Omitted → no
   * age limit (the PR 1 behaviour, and the parity cases). */
  else if (ctx && Number(ctx.maxDaysBack) > 0 &&
           paymentReportDayNum_(today) - paymentReportDayNum_(rd) > Number(ctx.maxDaysBack)) {
    out.push(paymentReportIssue_('receivedDate', 'received_date_too_old'));
  }

  const ac = paymentReportAmountCode_(r.amount);
  if (ac) out.push(paymentReportIssue_('amount', ac));

  const method = paymentReportMethod_(r.method);
  if (!method) out.push(paymentReportIssue_('method', 'method_missing'));
  else if (PAYMENT_METHODS.indexOf(method) < 0) out.push(paymentReportIssue_('method', 'method_invalid'));

  const pc = paymentReportPayerCode_(r.payer);
  if (pc) out.push(paymentReportIssue_('payer', pc));

  const cs = paymentReportDate_(r.coverageStart);
  const ce = paymentReportDate_(r.coverageEnd);
  if (cs === '') out.push(paymentReportIssue_('coverageStart', 'coverage_start_missing'));
  else if (cs === null) out.push(paymentReportIssue_('coverageStart', 'coverage_invalid'));
  if (ce === '') out.push(paymentReportIssue_('coverageEnd', 'coverage_end_missing'));
  else if (ce === null) out.push(paymentReportIssue_('coverageEnd', 'coverage_invalid'));
  if (cs && ce) {
    if (ce < cs) out.push(paymentReportIssue_('coverageEnd', 'coverage_reversed'));
    else if (paymentReportDayNum_(ce) - paymentReportDayNum_(cs) + 1 > COVERAGE_MAX_DAYS_REPORT_) {
      out.push(paymentReportIssue_('coverageEnd', 'coverage_too_long'));
    }
  }

  const funder = paymentReportText_(r.funder);
  if (!funder) out.push(paymentReportIssue_('funder', 'funder_missing'));
  else if (PAYMENT_FUNDERS.indexOf(funder) < 0) out.push(paymentReportIssue_('funder', 'funder_invalid'));

  const rc = paymentReportReferenceCode_(r.reference, method);
  if (rc) out.push(paymentReportIssue_('reference', rc));

  return out;
}

/* A Payments row as a report: the money received is amountPaid. */
function paymentReportFromRow_(row) {
  const p = row && typeof row === 'object' ? row : {};
  return {
    receivedDate: p.receivedDate, amount: p.amountPaid, method: p.method, payer: p.payer,
    coverageStart: p.coverageStart, coverageEnd: p.coverageEnd, funder: p.funder, reference: p.reference,
  };
}

/* «על שם»: '' valid, else the error code. Trimmed; 1–INVOICE_TO_MAX
 * characters, no control character, no formula lead-in. PURE. */
function paymentInvoiceToCode_(v) {
  const t = paymentReportText_(v);
  if (!t) return 'invoice_to_missing';
  if (/[\u0000-\u001f\u007f]/.test(t) || /^[=+@-]/.test(t) || t.length > INVOICE_TO_MAX) return 'invoice_to_invalid';
  return '';
}

/* validatePaymentInvoice_({ invoiceWanted, invoiceTo }) → issues in field
 * order (invoiceWanted, invoiceTo); [] = valid. 'no' needs nothing more (the
 * name is stored ''); 'yes' needs a valid name. PURE. */
function validatePaymentInvoice_(report) {
  const r = report && typeof report === 'object' ? report : {};
  const w = paymentReportText_(r.invoiceWanted);
  if (!w) return [paymentReportIssue_('invoiceWanted', 'invoice_choice_missing')];
  if (INVOICE_CHOICES.indexOf(w) < 0) return [paymentReportIssue_('invoiceWanted', 'invoice_choice_invalid')];
  if (w === 'yes') {
    const code = paymentInvoiceToCode_(r.invoiceTo);
    if (code) return [paymentReportIssue_('invoiceTo', code)];
  }
  return [];
}

/* The invoice pair as stored: 'yes' + the trimmed name, or 'no' + ''. Call
 * only after validatePaymentInvoice_ passed. PURE. */
function paymentInvoiceClean_(report) {
  const r = report || {};
  const w = paymentReportText_(r.invoiceWanted);
  return { invoiceWanted: w, invoiceTo: w === 'yes' ? paymentReportText_(r.invoiceTo) : '' };
}

/* Whether the header holds the invoice columns where they belong (blank or
 * their own name). Pure — the paymentReportHeaderClash_ rule. */
function paymentInvoiceHeaderClash_(header) {
  const h = Array.isArray(header) ? header : [];
  const clash = [];
  PAYMENT_INVOICE_COLUMNS.forEach(function (name) {
    const i = PAYMENT_COLUMNS.indexOf(name);
    const got = i < h.length ? String(h[i] == null ? '' : h[i]).trim() : '';
    if (got !== '' && got !== name) clash.push({ column: i + 1, expected: name, found: got });
  });
  return clash;
}

/* The invoice pair of the row about to be written by savePayment /
 * updatePayment. PURE. A payload that does not carry them (undefined / null,
 * or a blank invoiceWanted — "not sending", so an older client can never
 * wipe a choice) keeps the stored pair. A pair equal to the stored one is
 * not re-validated. 'no' always stores invoiceTo ''.
 * → { ok:true, fields, change: null | { from, to } }
 *   { ok:false, error:'validation', message, fields:[issues] } */
function paymentInvoiceFields_(payment, prev, opts) {
  const P = prev || {};
  const pay = payment || {};
  const o = opts || {};
  const prevW = paymentCell_(P.invoiceWanted), prevTo = paymentCell_(P.invoiceTo);
  const keep = { ok: true, fields: { invoiceWanted: prevW, invoiceTo: prevTo }, change: null };
  if (o.headerClash) return keep;
  const sentW = pay.invoiceWanted !== undefined && pay.invoiceWanted !== null && paymentReportText_(pay.invoiceWanted) !== '';
  const sentTo = pay.invoiceTo !== undefined && pay.invoiceTo !== null;
  const w = sentW ? paymentReportText_(pay.invoiceWanted) : prevW;
  let to = sentTo ? paymentReportText_(pay.invoiceTo) : prevTo;
  if (w === 'no') to = '';
  if (w === prevW && to === prevTo) return keep;
  const issues = validatePaymentInvoice_({ invoiceWanted: w, invoiceTo: to });
  if (issues.length) return { ok: false, error: 'validation', message: issues[0].hebrewMessage, fields: issues };
  const next = paymentInvoiceClean_({ invoiceWanted: w, invoiceTo: to });
  return { ok: true, fields: next, change: { from: { invoiceWanted: prevW, invoiceTo: prevTo }, to: next } };
}

/* One AuditLog row when a row's invoice choice changes (old, new, actor) —
 * the receivedDate-change treatment. Fail-soft, like every logAudit_ caller. */
function logPaymentInvoiceChanged_(out, change, user, actor) {
  if (!change) return;
  logAudit_('payment_invoice_changed', 'upsertPayment_',
    String(out.patientUid || ''), String(out.patientName || ''), {
      paymentId: String(out.id || ''),
      paymentUid: String(out.paymentUid || ''),
      old: change.from,
      new: change.to,
      by: String(user == null ? '' : user),
      at: israelTimestamp_(),
    }, actor === undefined ? String(user == null ? '' : user) : actor);
}

/* flagNote as stored: one line, control characters flattened, a formula
 * lead-in stripped, capped — the paymentLinkNoteClean_ treatment. */
function paymentFlagNoteClean_(v) {
  let t = String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  t = t.replace(/^[=+@-]+/, '').trim();
  return t.slice(0, FLAG_NOTE_MAX);
}

/* Whether the Payments header row can hold the report columns: each of their
 * positions is blank or already carries its own name. A hand-added column
 * sitting where a report column belongs (readSheet_ maps BY POSITION) would
 * otherwise be read and written as receivedDate / method / … — so then the
 * report columns are left exactly as the sheet holds them. Pure. */
function paymentReportHeaderClash_(header) {
  const h = Array.isArray(header) ? header : [];
  const clash = [];
  for (let k = 0; k < PAYMENT_REPORT_COLUMNS.length; k++) {
    const i = PAYMENT_COLUMNS.indexOf(PAYMENT_REPORT_COLUMNS[k]);
    const got = i < h.length ? String(h[i] == null ? '' : h[i]).trim() : '';
    if (got !== '' && got !== PAYMENT_REPORT_COLUMNS[k]) clash.push({ column: i + 1, expected: PAYMENT_REPORT_COLUMNS[k], found: got });
  }
  return clash;
}

/**
 * The eleven report columns of the row about to be written. PURE (no sheet,
 * no clock beyond israelTimestamp_ / opts.todayIso).
 *
 *   payment  the request payload; prev the stored row ({} on insert)
 *   opts     { stampUser, privileged (controller or approver, from hasRole_ —
 *              never the payload), todayIso, now, headerClash }
 *
 * A column the payload does not carry (undefined / null) keeps the stored
 * value — so a client that has never heard of these columns changes nothing.
 * A carried value equal to the stored one changes nothing either and is NOT
 * re-validated (a hand-typed cell must not block an unrelated save).
 *
 * → { ok:true, fields, firstReport, receivedChange, confirmChange, needsFunder }
 *   { ok:false, error:'validation', message, fields:[issues] }
 *   { ok:false, error:'forbidden_role', message, operation:CONFIRM_OPERATION }
 */
function paymentReportFields_(payment, prev, opts) {
  const P = prev || {};
  const o = opts || {};
  const pay = payment || {};
  const fields = {};
  if (o.headerClash) {
    for (let k = 0; k < PAYMENT_REPORT_COLUMNS.length; k++) {
      const c = PAYMENT_REPORT_COLUMNS[k];
      fields[c] = P[c] === undefined || P[c] === null ? '' : P[c];
    }
    return { ok: true, fields: fields, firstReport: false, receivedChange: null, confirmChange: null, needsFunder: false };
  }
  const sent = function (k) { return pay[k] !== undefined && pay[k] !== null; };
  const today = o.todayIso || paymentReportToday_();
  const issues = [];

  // ---- the confirmation: controller / approver only — checked first, so a
  // refused write is refused before anything else is looked at.
  const prevCs = paymentCell_(P.confirmStatus);
  const prevNote = paymentCell_(P.flagNote);
  const wantCs = sent('confirmStatus') ? paymentCell_(pay.confirmStatus) : '';
  const wantNote = sent('flagNote') ? paymentFlagNoteClean_(pay.flagNote) : '';
  /* Blank is "not sending", never "clear": a client holding an older copy of
   * the row must not be able to wipe Ortal's decision by saving something
   * else. */
  /* 'reported' onto a row that has no status yet is what the server sets on
   * the first report anyway (below) — echoing it is not a decision. */
  const csWrite = wantCs !== '' && wantCs !== prevCs && !(prevCs === '' && wantCs === 'reported');
  const noteWrite = wantNote !== '' && wantNote !== prevNote;
  if ((csWrite || noteWrite) && o.privileged !== true) {
    return { ok: false, error: 'forbidden_role', message: ROLE_FORBIDDEN_MESSAGE, operation: CONFIRM_OPERATION };
  }

  // ---- receivedDate: append-only
  const prevRd = paymentCell_(P.receivedDate);
  let rd = prevRd;
  let receivedChange = null;
  if (sent('receivedDate') && paymentCell_(pay.receivedDate) !== '' && paymentCell_(pay.receivedDate) !== prevRd) {
    const iso = paymentReportDate_(pay.receivedDate);
    if (iso === null) issues.push(paymentReportIssue_('receivedDate', 'received_date_invalid'));
    else if (iso > today) issues.push(paymentReportIssue_('receivedDate', 'received_date_future'));
    else if (iso !== prevRd) {
      if (prevRd) receivedChange = { from: prevRd, to: iso };
      rd = iso;
    }
  }
  fields.receivedDate = rd;
  const firstReport = !prevRd && rd !== '';

  // ---- the client-written report fields: validated only when they change
  const prevMethod = paymentCell_(P.method);
  fields.method = sent('method') ? paymentReportMethod_(pay.method) : prevMethod;
  if (fields.method !== prevMethod && fields.method && PAYMENT_METHODS.indexOf(fields.method) < 0) {
    issues.push(paymentReportIssue_('method', 'method_invalid'));
  }
  const prevPayer = paymentCell_(P.payer);
  fields.payer = sent('payer') ? paymentReportText_(pay.payer) : prevPayer;
  if (fields.payer !== prevPayer && fields.payer && paymentReportPayerCode_(fields.payer)) {
    issues.push(paymentReportIssue_('payer', 'payer_invalid'));
  }
  const prevFunder = paymentCell_(P.funder);
  fields.funder = sent('funder') ? paymentReportText_(pay.funder) : prevFunder;
  if (fields.funder !== prevFunder && fields.funder && PAYMENT_FUNDERS.indexOf(fields.funder) < 0) {
    issues.push(paymentReportIssue_('funder', 'funder_invalid'));
  }
  const prevRef = paymentCell_(P.reference);
  fields.reference = sent('reference') ? paymentReportText_(pay.reference) : prevRef;
  if (fields.reference !== prevRef && fields.reference && paymentReportReferenceCode_(fields.reference, fields.method)) {
    issues.push(paymentReportIssue_('reference', 'reference_invalid'));
  }

  // ---- who recorded the report: once, from the signed session, never again
  if (firstReport) {
    fields.recordedBy = String(o.stampUser == null ? '' : o.stampUser);
    fields.recordedAt = israelTimestamp_(o.now);
  } else {
    fields.recordedBy = paymentCell_(P.recordedBy);
    fields.recordedAt = paymentCell_(P.recordedAt);
  }

  // ---- the confirmation state
  let cs = prevCs;
  let confirmChange = null;
  if (csWrite) {
    if (CONFIRM_STATUSES.indexOf(wantCs) < 0) issues.push(paymentReportIssue_('confirmStatus', 'confirm_status_invalid'));
    else if (!rd) issues.push(paymentReportIssue_('confirmStatus', 'confirm_without_report'));
    else { cs = wantCs; confirmChange = { from: prevCs, to: cs }; }
  }
  const note = noteWrite ? wantNote : prevNote;
  if (cs === 'flagged' && (csWrite || noteWrite) && note.length < FLAG_NOTE_MIN) {
    issues.push(paymentReportIssue_('flagNote', 'flag_note_missing'));
  }
  if (firstReport && !cs) cs = 'reported';   // a new report is always 'reported' (plan R12)
  fields.confirmStatus = cs;
  fields.flagNote = note;
  if (confirmChange) {
    fields.confirmedBy = String(o.stampUser == null ? '' : o.stampUser);
    fields.confirmedAt = israelTimestamp_(o.now);
  } else {
    fields.confirmedBy = paymentCell_(P.confirmedBy);
    fields.confirmedAt = paymentCell_(P.confirmedAt);
  }

  if (issues.length) return { ok: false, error: 'validation', message: issues[0].hebrewMessage, fields: issues };
  return {
    ok: true, fields: fields, firstReport: firstReport, receivedChange: receivedChange,
    confirmChange: confirmChange, needsFunder: firstReport && !fields.funder,
  };
}

/* One AuditLog row when a recorded receivedDate is changed (old, new, actor).
 * Setting it for the first time is not a change: recordedBy / recordedAt say
 * who and when. Fail-soft, like every logAudit_ caller. */
function logPaymentReceivedDateChanged_(out, change, user, actor) {
  if (!change) return;
  logAudit_('payment_received_date_changed', 'upsertPayment_',
    String(out.patientUid || ''), String(out.patientName || ''), {
      paymentId: String(out.id || ''),
      paymentUid: String(out.paymentUid || ''),
      old: change.from,
      new: change.to,
      by: String(user == null ? '' : user),
      at: israelTimestamp_(),
    }, actor === undefined ? String(user == null ? '' : user) : actor);
}

/* One AuditLog row per confirmation decision (reported / confirmed /
 * flagged), so un-confirming is visible after the row moves on. */
function logPaymentConfirm_(out, change, actor) {
  if (!change) return;
  logAudit_('payment_confirm_' + change.to, 'upsertPayment_',
    String(out.patientUid || ''), String(out.patientName || ''), {
      paymentId: String(out.id || ''),
      paymentUid: String(out.paymentUid || ''),
      from: change.from,
      to: change.to,
      flagNote: String(out.flagNote || ''),
      by: String(out.confirmedBy || ''),
      at: String(out.confirmedAt || ''),
    }, actor === undefined ? String(out.confirmedBy || '') : actor);
}

/* ===== Funders (append-only) ===== */

/* PURE. rows: Funders row objects. → { funder, effectiveFrom, unset }.
 * The row with the latest effectiveFrom ≤ asOf wins; on the same day the
 * later setAt, then the later row. No row → FUNDER_UNSET. When the winning
 * row's label is not in PAYMENT_FUNDERS the answer is FUNDER_UNSET too (a
 * typo is never read past to an older row, and never guessed). A row with an
 * unreadable date is skipped. public/funder.js funderAt is the same rule. */
function currentFunderFrom_(rows, patientId, asOfIso) {
  const id = paymentReportText_(patientId);
  const asOf = paymentReportDate_(asOfIso) || paymentReportToday_();
  let best = null;
  const list = Array.isArray(rows) ? rows : [];
  if (id) {
    for (let i = 0; i < list.length; i++) {
      const r = list[i] || {};
      if (paymentReportText_(r.patientId) !== id) continue;
      const f = paymentReportText_(r.funder);
      const eff = r.effectiveFrom instanceof Date ? refundForecastIso_(r.effectiveFrom) : paymentReportDate_(r.effectiveFrom);
      if (!eff || eff > asOf) continue;
      const setAt = paymentReportText_(r.setAt);
      if (!best || eff > best.effectiveFrom || (eff === best.effectiveFrom && setAt >= best.setAt)) {
        best = { funder: f, effectiveFrom: eff, setAt: setAt };
      }
    }
  }
  if (!best || PAYMENT_FUNDERS.indexOf(best.funder) < 0) return { funder: FUNDER_UNSET, effectiveFrom: '', unset: true };
  return { funder: best.funder, effectiveFrom: best.effectiveFrom, unset: false };
}

/* ===== Institutional-funder grace period (Sandra, 07/10/2026) =====
 * CHANGELOG-funder-grace.md. A cycle whose funder ON ITS DUE DATE (the
 * Funders history, currentFunderFrom_'s rule) is ביטוח לאומי, מכבי or משרד
 * הביטחון is NOT a collection problem until FUNDER_GRACE_DAYS after its due
 * date: while today − due ≤ 30 it reads «ממתין לגורם מממן»; from day 31 the
 * normal marking applies. Private, pro-bono and unset: unchanged. The AMOUNT
 * stays outstanding everywhere — only the problem marking waits. The same rule
 * lives in lib/funder-grace.js (window.FunderGrace); test/funder-grace.test.js
 * checks the two agree. */
const FUNDER_GRACE_DAYS = 30;
const FUNDER_GRACE_FUNDERS = ['ביטוח לאומי', 'מכבי', 'משרד הביטחון'];
const FUNDER_GRACE_KEY_BY_LABEL = { 'ביטוח לאומי': 'btl', 'מכבי': 'maccabi', 'משרד הביטחון': 'mod' };

/* A funder sheet label or key → its grace key ('btl' | 'maccabi' | 'mod'), or
 * '' when that funder gets no grace. Exact strings. PURE. */
function graceFunderKey_(funder) {
  if (typeof funder !== 'string') return '';
  if (funder === 'btl' || funder === 'maccabi' || funder === 'mod') return funder;
  return Object.prototype.hasOwnProperty.call(FUNDER_GRACE_KEY_BY_LABEL, funder) ? FUNDER_GRACE_KEY_BY_LABEL[funder] : '';
}

/* A bare real 'YYYY-MM-DD' → epoch-day number, else null. PURE. */
function funderGraceDayNum_(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const n = refundDayNum_(s);
  return refundIsoFromDayNum_(n) === s ? n : null;
}
function funderGraceDue_(cycle) {
  if (typeof cycle === 'string') return cycle;
  if (cycle && typeof cycle === 'object') return String(cycle.dueDate || cycle.start || '');
  return '';
}

/* PURE. True while the cycle (a due ISO, or { dueDate } / { start }) is inside
 * its funder's grace window: an institutional funder and today − due ≤ 30
 * (a cycle not yet due is inside too). Any unreadable date → false, so the
 * normal marking applies. Same as lib/funder-grace.js isWithinFunderGrace. */
function isWithinFunderGrace_(cycle, funder, todayIso) {
  if (!graceFunderKey_(funder)) return false;
  const due = funderGraceDayNum_(funderGraceDue_(cycle)), today = funderGraceDayNum_(todayIso);
  if (due === null || today === null) return false;
  return today - due <= FUNDER_GRACE_DAYS;
}

/* The last day of the grace window (due + 30), or '' for a bad date. PURE. */
function funderGraceUntil_(cycle) {
  const due = funderGraceDayNum_(funderGraceDue_(cycle));
  return due === null ? '' : refundIsoFromDayNum_(due + FUNDER_GRACE_DAYS);
}

/* The Funders rows, read-only: getSheetByName (a missing tab is never
 * created here) → [] when there is none. */
function fundersRows_() {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(FUNDERS_SHEET);
  return sh ? readSheet_(sh, FUNDER_COLUMNS) : [];
}

/* currentFunder_(patientId, asOfIso) → the funder label (PAYMENT_FUNDERS),
 * or FUNDER_UNSET when there is none, the label is unrecognized, or the read
 * fails. Read-only. A caller that needs a funder must refuse on FUNDER_UNSET
 * (upsertPayment_ does) — it never stands in for one. */
function currentFunder_(patientId, asOfIso) {
  try {
    return currentFunderFrom_(fundersRows_(), patientId, asOfIso).funder;
  } catch (e) {
    try { console.warn('[funders] read failed: ' + ((e && e.message) || e)); } catch (_) { /* no-op */ }
    return FUNDER_UNSET;
  }
}

/* Append ONE Funders row. Reached over HTTP since Phase 3 PR 2 through
 * action=appendFunder (appendFunderAction_, finance-gated) — the patient
 * card's funder editor. ctx { user, actor } — setBy is ctx.user, taken from
 * the signed session (requestUser_), never a payload.
 * → { ok:true, row } | { ok:false, error }. */
function appendFunder_(patientId, funder, effectiveFrom, ctx) {
  const c = ctx || {};
  const id = paymentLinkUidClean_(patientId);
  if (!id) return { ok: false, error: 'patient_id_invalid' };
  const f = paymentReportText_(funder);
  if (PAYMENT_FUNDERS.indexOf(f) < 0) return { ok: false, error: 'funder_invalid', message: PAYMENT_REPORT_MESSAGES.funder_invalid };
  const eff = paymentReportDate_(effectiveFrom);
  if (!eff) return { ok: false, error: 'effective_from_invalid' };
  // Idempotency key: same shape as reportPayment's; malformed → refused, nothing written.
  const sid = receiptSubmissionIdClean_(c.submissionId);
  if (sid === null) return { ok: false, error: 'bad_submission_id' };
  const lock = LockService.getScriptLock();
  if (lock.tryLock(10000) !== true) return lockBusy_('appendFunder_');
  try {
    const sh = getOrCreateSheet_(FUNDERS_SHEET, FUNDER_COLUMNS);
    /* A hand-added column where submissionId belongs: write the five original
     * columns only (the old behaviour) — never into somebody else's column. */
    const header = sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), 1)).getValues()[0];
    const sidAt = FUNDER_COLUMNS.indexOf('submissionId');
    const sidHead = String(header[sidAt] == null ? '' : header[sidAt]).trim();
    const sidOk = sidHead === '' || sidHead === 'submissionId';
    if (!sidOk) { try { console.warn('[funders] submissionId not used — header clash at column ' + (sidAt + 1)); } catch (_) { /* no-op */ } }
    // A retry: the key is already on a row → answer that row, write nothing.
    if (sid && sidOk) {
      const prior = readSheet_(sh, FUNDER_COLUMNS).filter(function (r) {
        return String(r.submissionId == null ? '' : r.submissionId).trim() === sid;
      })[0];
      if (prior) {
        const replay = {};
        FUNDER_COLUMNS.forEach(function (k) { replay[k] = String(prior[k] == null ? '' : prior[k]); });
        return { ok: true, row: replay, replayed: true };
      }
    }
    const row = { patientId: id, funder: f, effectiveFrom: eff, setBy: String(c.user == null ? '' : c.user), setAt: israelTimestamp_(),
      submissionId: sidOk ? sid : '' };
    const width = sidOk ? FUNDER_COLUMNS.length : sidAt;
    sh.getRange(sh.getLastRow() + 1, 1, 1, width).setValues([objectToRow_(row, FUNDER_COLUMNS).slice(0, width)]);
    logAudit_('funder_set', 'appendFunder_', id, '', { funder: f, effectiveFrom: eff, by: row.setBy, at: row.setAt },
      c.actor === undefined ? row.setBy : String(c.actor));
    return { ok: true, row: row };
  } finally {
    try { lock.releaseLock(); } catch (_) { /* no-op */ }
  }
}

/* Editor-run: create the Funders tab (headers, frozen row, text-format) so
 * Sandra can type rows into it. Idempotent; touches no other tab. */
function setupFundersSheetNow() {
  const sh = getOrCreateSheet_(FUNDERS_SHEET, FUNDER_COLUMNS);
  console.log('[funders] ready: ' + FUNDERS_SHEET + ', ' + Math.max(0, sh.getLastRow() - 1) + ' rows');
  return { ok: true, rows: Math.max(0, sh.getLastRow() - 1) };
}

/* ===== One row per money received (Phase 3 PR 2, Sandra 2026-10-04) =====
 * docs/billing-control-plan.md Phase 3 and §14.1;
 * CHANGELOG-payment-report-form.md.
 *
 * A «דווח תשלום» report ALWAYS appends a NEW Payments row — a RECEIPT:
 *   id            RECEIPT_ID_PREFIX + uuid, minted here (never by a client)
 *   status        'paid'; amount = amountPaid = the money received; balance 0
 *   patientId / patientName / houseId / dueDate / patientUid
 *                 copied from the cycle it pays for
 *   coverageStart / coverageEnd, receivedDate, method, payer, funder,
 *   reference     the report (validatePaymentReport_, strict)
 *   recordedBy / recordedAt / confirmStatus 'reported' — server-stamped
 * A receipt is never edited. Un-doing one = voiding it (the existing void
 * flow, `deleter`), which re-derives its cycle.
 *
 * A CYCLE row (every non-receipt row: a dueDate, the expected `amount`) stays
 * the charge. Its amountPaid / balance / status are DERIVED from the receipts
 * linked to it (recomputeCycleFromReceipts_), written on every report / void
 * and re-derived on every read, so legacy data reads consistently.
 *
 * LINK (receiptLinksToCycle_): same patient (patientUid when both rows carry
 * one, else the billing-triple patientId) AND the receipt's coverageStart
 * falls in the cycle's window (its recorded coverage, else dueDate … dueDate
 * + 1 month − 1 day — app.js inferredCoverage). Several candidates → the one
 * with the receipt's own dueDate, then the latest start, then the first row.
 * Void cycles and other receipts are never candidates.
 *
 * LEGACY: a cycle with NO receipt row (void ones included) keeps its stored
 * amountPaid / balance / status untouched — one legacy receipt. When its first
 * receipt is reported, the stored amountPaid moves into legacyAmountPaid
 * (once), so the derived total = legacyAmountPaid + Σ live receipts and a
 * void of every receipt falls back to exactly the legacy figure. */
const RECEIPT_ID_PREFIX = 'rcpt-';
/* Older than this many days back → approver only («פנו לסנדרה»). */
const RECEIVED_DATE_STAFF_MAX_DAYS = 90;
const PAYMENT_REPORT_REFUSED_MESSAGE = 'הדיווח לא נשמר — יש להשלים את השדות המסומנים';

function isReceiptRow_(row) {
  return !!row && String(row.id == null ? '' : row.id).trim().indexOf(RECEIPT_ID_PREFIX) === 0;
}

/* A money cell as a number rounded to agorot ('' / junk → 0). */
function receiptMoney_(v) {
  const n = Number(v);
  return isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

/* The cycle's window { start, end } ('YYYY-MM-DD'), or null. Pure. */
function receiptCycleWindow_(cycle) {
  const c = cycle || {};
  const cs = coverageDateISO_(c.coverageStart), ce = coverageDateISO_(c.coverageEnd);
  if (cs && ce && ce >= cs) return { start: cs, end: ce };
  const due = c.dueDate instanceof Date ? localPartsISO_(c.dueDate) : coverageDateISO_(c.dueDate);
  if (!due) return null;
  return { start: due, end: refundIsoFromDayNum_(refundDayNum_(refundAddMonths_(due, 1)) - 1) };
}

/* Same patient? patientUid when both rows carry one, else patientId. Pure. */
function receiptSamePatient_(a, b) {
  const ua = paymentCell_(a.patientUid), ub = paymentCell_(b.patientUid);
  if (ua && ub) return ua === ub;
  const pa = paymentCell_(a.patientId), pb = paymentCell_(b.patientId);
  return !!pa && pa === pb;
}

function receiptLinksToCycle_(receipt, cycle) {
  if (!receipt || !cycle || isReceiptRow_(cycle) || isVoidStatus_(cycle.status)) return false;
  if (!receiptSamePatient_(receipt, cycle)) return false;
  const w = receiptCycleWindow_(cycle);
  const at = coverageDateISO_(receipt.coverageStart) ||
    (receipt.dueDate instanceof Date ? localPartsISO_(receipt.dueDate) : coverageDateISO_(receipt.dueDate));
  return !!(w && at && at >= w.start && at <= w.end);
}

/* rows: Payments row objects (any order). PURE.
 * → { cycles: [{ index, row }], receipts: [{ index, row, cycleIndex }],
 *     byCycle: { index: [receipt rows] } } — indexes into `rows`;
 *     cycleIndex -1 = unlinked. */
function linkReceiptsToCycles_(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const cycles = [], receipts = [], byCycle = {};
  list.forEach(function (r, i) { (isReceiptRow_(r) ? receipts : cycles).push({ index: i, row: r || {} }); });
  receipts.forEach(function (rc) {
    let best = null;
    const ownDue = coverageDateISO_(rc.row.dueDate);
    cycles.forEach(function (cy) {
      if (!receiptLinksToCycle_(rc.row, cy.row)) return;
      const sameDue = !!ownDue && coverageDateISO_(cy.row.dueDate) === ownDue;
      const start = receiptCycleWindow_(cy.row).start;
      if (!best || (sameDue && !best.sameDue) || (sameDue === best.sameDue && start > best.start)) {
        best = { index: cy.index, sameDue: sameDue, start: start };
      }
    });
    rc.cycleIndex = best ? best.index : -1;
    if (best) (byCycle[best.index] = byCycle[best.index] || []).push(rc.row);
  });
  return { cycles: cycles, receipts: receipts, byCycle: byCycle };
}

/* THE DERIVATION. PURE.
 *   cycleRow  the cycle's row object (stored values)
 *   receipts  the receipt rows linked to it (void ones included)
 * → { amountPaid, balance, status, legacy, legacyAmountPaid, receiptCount,
 *     liveReceipts, received: [{ date, amount }] }
 * No receipt row at all → the stored figures, untouched (legacy: its own
 * amountPaid is one receipt). Otherwise amountPaid = legacyAmountPaid + Σ
 * live receipts, balance = max(0, amount − amountPaid) and status
 * paid / partial / unpaid from those. A void cycle stays void. */
function recomputeCycleFromReceipts_(cycleRow, receipts) {
  const c = cycleRow || {};
  const list = Array.isArray(receipts) ? receipts : [];
  const amount = receiptMoney_(c.amount);
  const storedPaid = receiptMoney_(c.amountPaid);
  if (!list.length) {
    const bal = paymentCell_(c.balance) === '' ? Math.max(0, receiptMoney_(amount - storedPaid)) : receiptMoney_(c.balance);
    return {
      amountPaid: storedPaid, balance: bal, status: paymentStatus_(c.status), legacy: true,
      legacyAmountPaid: storedPaid, receiptCount: 0, liveReceipts: 0, received: [],
    };
  }
  const legacyPaid = receiptMoney_(c.legacyAmountPaid);
  const received = [];
  let sum = legacyPaid;
  list.forEach(function (r) {
    if (isVoidStatus_(r.status)) return;
    const a = receiptMoney_(r.amountPaid !== '' && r.amountPaid !== undefined && r.amountPaid !== null ? r.amountPaid : r.amount);
    sum = receiptMoney_(sum + a);
    received.push({ date: paymentReportDate_(r.receivedDate instanceof Date ? localPartsISO_(r.receivedDate) : r.receivedDate) || '', amount: a });
  });
  let status;
  if (isVoidStatus_(c.status)) status = PAYMENT_VOID_STATUS;
  else if (sum <= 0) status = 'unpaid';
  else if (sum >= amount) status = 'paid';
  else status = 'partial';
  return {
    amountPaid: sum, balance: Math.max(0, receiptMoney_(amount - sum)), status: status, legacy: false,
    legacyAmountPaid: legacyPaid, receiptCount: list.length, liveReceipts: received.length, received: received,
  };
}

/* Payments row objects → the same rows with every cycle that has receipts
 * re-derived, receipts left out. PURE; new objects only where derived.
 * → { cycles: [rows], receipts: [rows + cycleId], links }. */
function paymentRowsDerived_(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const L = linkReceiptsToCycles_(list);
  const cycles = L.cycles.map(function (cy) {
    const rs = L.byCycle[cy.index];
    if (!rs) return cy.row;
    const d = recomputeCycleFromReceipts_(cy.row, rs);
    const o = {};
    Object.keys(cy.row).forEach(function (k) { o[k] = cy.row[k]; });
    o.amountPaid = d.amountPaid;
    o.balance = d.balance;
    o.status = d.status;
    return o;
  });
  const receipts = L.receipts.map(function (rc) {
    const o = {};
    Object.keys(rc.row).forEach(function (k) { o[k] = rc.row[k]; });
    o.cycleId = rc.cycleIndex >= 0 ? String(list[rc.cycleIndex].id == null ? '' : list[rc.cycleIndex].id) : '';
    return o;
  });
  return { cycles: cycles, receipts: receipts, links: L };
}

/* Payments row objects → the cycles only, derived (what every reader that
 * predates receipts expects). PURE. */
function paymentCyclesDerived_(rows) {
  return paymentRowsDerived_(rows).cycles;
}

/* recCollect_-shaped tabs → the same, with tabs.payments.rows = the cycles
 * (derived, their rowNumber kept) and tabs.receipts.rows = the receipts with
 * their cycle's rowNumber (cycleRowNumber, 0 = unlinked). Idempotent. PURE. */
function paymentTabsDerived_(tabs) {
  const t = tabs || {};
  if (t.__receiptsDerived) return t;
  const src = (t.payments && Array.isArray(t.payments.rows)) ? t.payments.rows : [];
  const objs = src.map(function (r) { return (r && r.obj) || {}; });
  const L = linkReceiptsToCycles_(objs);
  const out = {};
  Object.keys(t).forEach(function (k) { out[k] = t[k]; });
  const payTab = {};
  Object.keys(t.payments || {}).forEach(function (k) { payTab[k] = t.payments[k]; });
  payTab.rows = L.cycles.map(function (cy) {
    const rs = L.byCycle[cy.index];
    if (!rs) return src[cy.index];
    const d = recomputeCycleFromReceipts_(cy.row, rs);
    const o = {};
    Object.keys(cy.row).forEach(function (k) { o[k] = cy.row[k]; });
    o.amountPaid = d.amountPaid;
    o.balance = d.balance;
    o.status = d.status;
    return { rowNumber: src[cy.index].rowNumber, obj: o, receipts: rs, derived: d };
  });
  out.payments = payTab;
  out.receipts = {
    sheet: (t.payments && t.payments.sheet) || PAYMENTS_SHEET,
    rows: L.receipts.map(function (rc) {
      return { rowNumber: src[rc.index].rowNumber, obj: rc.row, cycleRowNumber: rc.cycleIndex >= 0 ? src[rc.cycleIndex].rowNumber : 0 };
    }),
  };
  out.__receiptsDerived = true;
  return out;
}

/* The report fields of a reportPayment payload, normalized for storage. */
function receiptReportClean_(r) {
  const x = r || {};
  return {
    receivedDate: paymentReportDate_(x.receivedDate) || '',
    amount: x.amount,
    method: paymentReportMethod_(x.method),
    payer: paymentReportText_(x.payer),
    coverageStart: paymentReportDate_(x.coverageStart) || '',
    coverageEnd: paymentReportDate_(x.coverageEnd) || '',
    funder: paymentReportText_(x.funder),
    reference: paymentReportText_(x.reference),
  };
}

/**
 * action=reportPayment — the strict «דווח תשלום». PROXY_SECRET-gated (not in
 * OPEN_ACTIONS), finance-gated (FINANCE_ACTIONS).
 *
 *   body   { cycle: { id, patientId, patientName, houseId, dueDate, amount,
 *                     coverageStart?, coverageEnd? },
 *            report: { receivedDate, amount, method, payer, coverageStart,
 *                      coverageEnd, funder, reference } }
 *   ctx    { user (signed session), actor (AuditLog label), approver }
 *
 * Validates FIRST (validatePaymentReport_, strict; older than
 * RECEIVED_DATE_STAFF_MAX_DAYS needs the approver) — an incomplete report is
 * refused { ok:false, error:'invalid_report', message, issues } and NOTHING
 * is written. Then, under the script lock: find (or create) the cycle row,
 * append ONE receipt row, re-derive the cycle from all its receipts and write
 * it, and log AuditLog 'payment_reported' with the actor.
 * → { ok:true, receipt, cycle } */
function reportPayment_(body, user, ctx) {
  const b = body && typeof body === 'object' ? body : {};
  const c = ctx || {};
  const stampUser = String(user == null ? '' : user);
  const cycleIn = b.cycle && typeof b.cycle === 'object' ? b.cycle : null;
  const reportIn = b.report && typeof b.report === 'object' ? b.report : null;
  if (!cycleIn || !reportIn) return { ok: false, error: 'missing_report' };
  const cycleId = String(cycleIn.id == null ? '' : cycleIn.id).trim();
  if (!cycleId || cycleId.length > 300 || /[\u0000-\u001f\u007f]/.test(cycleId) ||
      cycleId.indexOf(RECEIPT_ID_PREFIX) === 0) return { ok: false, error: 'bad_cycle' };
  const submissionId = receiptSubmissionIdClean_(b.submissionId);
  if (submissionId === null) return { ok: false, error: 'bad_submission_id' };

  const today = paymentReportToday_();
  const issues = validatePaymentReport_(reportIn, {
    todayIso: c.todayIso || today,
    maxDaysBack: c.approver === true ? 0 : RECEIVED_DATE_STAFF_MAX_DAYS,
  }).concat(validatePaymentInvoice_(reportIn));   // «חשבונית?» — no default
  if (issues.length) {
    return { ok: false, error: 'invalid_report', message: PAYMENT_REPORT_REFUSED_MESSAGE, issues: issues };
  }
  const rep = receiptReportClean_(reportIn);
  const inv = paymentInvoiceClean_(reportIn);
  const amount = receiptMoney_(rep.amount);

  const lock = LockService.getScriptLock();
  if (lock.tryLock(10000) !== true) return lockBusy_('reportPayment_');
  try {
    const sh = getOrCreateSheet_(PAYMENTS_SHEET, PAYMENT_COLUMNS);
    const header = sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), 1)).getValues()[0];
    if (paymentReportHeaderClash_(header).length || receiptHeaderClash_(header).length || paymentInvoiceHeaderClash_(header).length) {
      try { console.warn('[payments] reportPayment refused — Payments header clash'); } catch (_) { /* no-op */ }
      return { ok: false, error: 'sheet_header_clash', message: 'מבנה גיליון התשלומים לא תקין — פנו לסנדרה' };
    }
    const lastRow = sh.getLastRow();
    const grid = lastRow > 1 ? sh.getRange(2, 1, lastRow - 1, PAYMENT_COLUMNS.length).getValues() : [];
    const rows = grid.map(function (g) {
      const o = {};
      for (let k = 0; k < PAYMENT_COLUMNS.length; k++) o[PAYMENT_COLUMNS[k]] = g[k];
      return o;
    });
    // A retry of a report already written: answer from the sheet, write nothing.
    const replay = receiptReplayFor_(rows, submissionId);
    if (replay) {
      try { console.log('[payments] reportPayment replayed an idempotent retry'); } catch (_) { /* no-op */ }
      return replay;
    }
    let cycleAt = -1;
    for (let i = 0; i < rows.length; i++) if (String(rows[i].id) === cycleId) { cycleAt = i; break; }
    const prevCycle = cycleAt >= 0 ? rows[cycleAt] : {};
    if (cycleAt >= 0 && isVoidStatus_(prevCycle.status)) {
      return { ok: false, error: 'cycle_void', message: 'לא ניתן לדווח תשלום על שורה מבוטלת' };
    }

    // The cycle as it will stand (a new one is born unpaid, from the payload).
    let cycle = {};
    if (cycleAt >= 0) {
      Object.keys(prevCycle).forEach(function (k) { cycle[k] = prevCycle[k]; });
    } else {
      if (cycleId.indexOf('pay::') !== 0) return { ok: false, error: 'bad_cycle' };
      const due = coverageDateISO_(cycleIn.dueDate);
      const expected = Number(cycleIn.amount);
      if (!due || !isFinite(expected) || expected < 0) return { ok: false, error: 'bad_cycle' };
      const covErr = coveragePeriodError_(cycleIn.coverageStart, cycleIn.coverageEnd);
      if (covErr) return { ok: false, error: covErr };
      cycle = {
        id: cycleId, patientId: paymentLinkNoteClean_(cycleIn.patientId),
        patientName: paymentLinkNoteClean_(cycleIn.patientName).slice(0, 100),
        houseId: paymentLinkNoteClean_(cycleIn.houseId).slice(0, 40), dueDate: due,
        amount: receiptMoney_(expected), status: 'unpaid', amountPaid: 0, balance: receiptMoney_(expected),
        timestamp: new Date().toISOString(),
        coverageStart: coverageDateISO_(cycleIn.coverageStart) || '', coverageEnd: coverageDateISO_(cycleIn.coverageEnd) || '',
      };
    }
    const win = receiptCycleWindow_(cycle);
    if (!win || rep.coverageStart < win.start || rep.coverageStart > win.end) {
      return { ok: false, error: 'invalid_report', message: PAYMENT_REPORT_REFUSED_MESSAGE, issues: [
        { field: 'coverageStart', code: 'coverage_outside_cycle', hebrewMessage: 'תחילת תקופת הכיסוי חייבת להיות בתוך מחזור החיוב' }] };
    }
    // The expected amount of an unpaid cycle is frozen at what was billed
    // (a per-month override included), exactly as the old row save did.
    const prevStatus = paymentStatus_(cycle.status);
    if (prevStatus === 'unpaid') {
      const mk = String(cycle.dueDate instanceof Date ? localPartsISO_(cycle.dueDate) : coverageDateISO_(cycle.dueDate) || '').slice(0, 7);
      const ovr = receiptOverrideAmount_(cycle.patientId, mk);
      if (ovr !== null) cycle.amount = ovr;
    }
    const cycleOut = stampPaymentRow_(cycle, prevCycle, cycleAt >= 0, stampUser);
    // A cycle that pays its first receipt keeps its legacy money, once.
    const linked = linkReceiptsToCycles_(rows.concat([cycleOut])).byCycle;
    const priorReceipts = (cycleAt >= 0 ? linked[cycleAt] : linked[rows.length]) || [];
    if (!priorReceipts.length && paymentCell_(cycleOut.legacyAmountPaid) === '') {
      cycleOut.legacyAmountPaid = receiptMoney_(prevCycle.amountPaid) > 0 ? receiptMoney_(prevCycle.amountPaid) : '';
    }

    /* A possible duplicate (CHANGELOG-receipt-duplicates-and-edit.md): the
     * same patient already has a live receipt of the same amount received
     * within DUPLICATE_WINDOW_DAYS. Refused, NOTHING written, unless the
     * caller re-sends with confirmDuplicate:true (Vered's «כן, קבלה נוספת») —
     * then the override is audited below. */
    const dup = receiptPossibleDuplicate_(rows, cycleOut, amount, rep.receivedDate);
    if (dup && b.confirmDuplicate !== true) {
      return { ok: false, error: 'possible_duplicate', message: POSSIBLE_DUPLICATE_MESSAGE, existing: dup };
    }

    // The receipt row.
    const nowIso = new Date().toISOString();
    const receiptIn = {
      id: RECEIPT_ID_PREFIX + Utilities.getUuid(),
      patientId: cycleOut.patientId, patientName: cycleOut.patientName, houseId: cycleOut.houseId,
      dueDate: cycleOut.dueDate instanceof Date ? localPartsISO_(cycleOut.dueDate) : coverageDateISO_(cycleOut.dueDate) || '',
      amount: amount, status: 'paid', amountPaid: amount, balance: 0, timestamp: nowIso,
      coverageStart: rep.coverageStart, coverageEnd: rep.coverageEnd,
      linkPatientUid: '', linkStatus: '', linkNote: '',
      receivedDate: rep.receivedDate, method: rep.method, payer: rep.payer, funder: rep.funder, reference: rep.reference,
      recordedBy: stampUser, recordedAt: israelTimestamp_(),
      confirmStatus: 'reported', confirmedBy: '', confirmedAt: '', flagNote: '',
      invoiceWanted: inv.invoiceWanted, invoiceTo: inv.invoiceTo,
    };
    const receiptOut = stampPaymentRow_(receiptIn, {}, false, stampUser);
    receiptOut.patientUid = paymentCell_(cycleOut.patientUid);   // same patient as its cycle, always
    receiptOut.legacyAmountPaid = '';
    receiptOut.submissionId = submissionId;   // the idempotency key ('' = none sent)

    // Re-derive the cycle from every receipt it has, the new one included.
    const d = recomputeCycleFromReceipts_(cycleOut, priorReceipts.concat([receiptOut]));
    const finalCycle = {};
    Object.keys(cycleOut).forEach(function (k) { finalCycle[k] = cycleOut[k]; });
    finalCycle.amountPaid = d.amountPaid;
    finalCycle.balance = d.balance;
    finalCycle.status = d.status;
    const cycleWritten = receiptRestampCycle_(finalCycle, prevCycle, cycleAt >= 0, stampUser);
    // A cycle born here keeps the identity minted for it above.
    cycleWritten.paymentUid = cycleOut.paymentUid;
    cycleWritten.patientUid = cycleOut.patientUid;

    // Write: the cycle in place (or appended), then the receipt appended.
    let cycleRowNumber;
    if (cycleAt >= 0) cycleRowNumber = cycleAt + 2;
    else cycleRowNumber = sh.getLastRow() + 1;
    setPaymentRowTextCols_(sh, cycleRowNumber);
    sh.getRange(cycleRowNumber, 1, 1, PAYMENT_COLUMNS.length).setValues([objectToRow_(cycleWritten, PAYMENT_COLUMNS)]);
    const receiptRowNumber = sh.getLastRow() + 1;
    setPaymentRowTextCols_(sh, receiptRowNumber);
    sh.getRange(receiptRowNumber, 1, 1, PAYMENT_COLUMNS.length).setValues([objectToRow_(receiptOut, PAYMENT_COLUMNS)]);

    logAudit_('payment_reported', 'reportPayment_', String(receiptOut.patientUid || ''), String(receiptOut.patientName || ''), {
      receiptId: String(receiptOut.id), paymentUid: String(receiptOut.paymentUid || ''),
      cycleId: String(cycleWritten.id), dueDate: String(receiptOut.dueDate || ''),
      amount: amount, receivedDate: rep.receivedDate, method: rep.method, funder: rep.funder,
      invoiceWanted: inv.invoiceWanted,
      cycleStatus: String(cycleWritten.status), cycleAmountPaid: cycleWritten.amountPaid,
      by: stampUser, at: String(receiptOut.recordedAt || ''),
    }, c.actor === undefined ? stampUser : String(c.actor));
    if (dup) {
      logAudit_('payment_duplicate_override', 'reportPayment_', String(receiptOut.patientUid || ''), String(receiptOut.patientName || ''), {
        receiptId: String(receiptOut.id), existingId: dup.id, existingReceivedDate: dup.receivedDate,
        existingReference: dup.reference, amount: amount, receivedDate: rep.receivedDate, reference: rep.reference,
        by: stampUser, at: String(receiptOut.recordedAt || ''),
      }, c.actor === undefined ? stampUser : String(c.actor));
    }

    const echoReceipt = {};
    Object.keys(receiptOut).forEach(function (k) { echoReceipt[k] = receiptOut[k]; });
    echoReceipt.cycleId = String(cycleWritten.id);
    return { ok: true, receipt: echoReceipt, cycle: cycleWritten, created: cycleAt < 0 };
  } finally {
    try { lock.releaseLock(); } catch (_) { /* no-op */ }
  }
}

/* A cycle's derived money through stampPaymentRow_'s rules (uid, version
 * bump), but the charge stamp of money that was ALREADY recorded is carried:
 * chargedAt dates the legacy part of the cycle (debtAgingReceivedOn_); each
 * receipt carries its own receivedDate. */
function receiptRestampCycle_(cycle, prev, hadRow, stampUser) {
  const out = stampPaymentRow_(cycle, prev, hadRow, stampUser);
  out.legacyAmountPaid = cycle.legacyAmountPaid === undefined ? paymentCell_(prev.legacyAmountPaid) : cycle.legacyAmountPaid;
  if (hadRow && paymentIsCharged_(prev.status) && paymentIsCharged_(out.status)) {
    out.chargedAt = paymentCell_(prev.chargedAt);
    out.chargedBy = paymentCell_(prev.chargedBy);
  }
  return out;
}

/* The per-month BillingOverrides amount for (patientId, 'YYYY-MM'), or null.
 * Read-only (getSheetByName); fail-soft → null. */
function receiptOverrideAmount_(patientId, month) {
  try {
    const pid = paymentCell_(patientId);
    if (!pid || !month) return null;
    const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(BILLING_OVERRIDES_SHEET);
    if (!sh) return null;
    const rows = readSheet_(sh, BILLING_OVERRIDE_COLUMNS);
    for (let i = rows.length - 1; i >= 0; i--) {
      if (paymentCell_(rows[i].patientId) === pid && String(rows[i].month == null ? '' : rows[i].month).slice(0, 7) === month) {
        const n = Number(rows[i].amount);
        return isFinite(n) && n >= 0 ? receiptMoney_(n) : null;
      }
    }
  } catch (_) { /* fail-soft */ }
  return null;
}

/* Like paymentReportHeaderClash_, for the receipt column(s). Pure. */
function receiptHeaderClash_(header) {
  const h = Array.isArray(header) ? header : [];
  const clash = [];
  ['legacyAmountPaid', 'submissionId'].forEach(function (name) {
    const i = PAYMENT_COLUMNS.indexOf(name);
    const got = i < h.length ? String(h[i] == null ? '' : h[i]).trim() : '';
    if (got !== '' && got !== name) clash.push({ column: i + 1, expected: name, found: got });
  });
  return clash;
}

/* ===== Idempotent «דווח תשלום» (CHANGELOG-payment-report-persistence.md) =====
 * The form mints ONE key per opened form ('sub-' + hex) and every send of it
 * carries the same key. reportPayment_ stores it on the receipt row; a
 * request whose key is already on a receipt is a RETRY (its first response
 * was lost — a proxy 502, a dropped connection) and is answered from the
 * sheet with that receipt, writing nothing. No key (an older client) = the
 * old behaviour. */
const SUBMISSION_ID_RE = /^sub-[A-Za-z0-9-]{8,64}$/;

/* undefined / null / '' → '' (no key); a well-formed key → itself; anything
 * else → null (refused). Pure. */
function receiptSubmissionIdClean_(v) {
  if (v === undefined || v === null || v === '') return '';
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return SUBMISSION_ID_RE.test(t) ? t : null;
}

/* The replay answer for a key already stored on a receipt of `rows`, or null.
 * The cycle is the one the receipt links to, derived from all its receipts
 * exactly as getPayments_ derives it. PURE. */
function receiptReplayFor_(rows, submissionId) {
  if (!submissionId) return null;
  const list = Array.isArray(rows) ? rows : [];
  let hit = -1;
  for (let i = 0; i < list.length; i++) {
    if (isReceiptRow_(list[i]) && paymentCell_(list[i].submissionId) === submissionId) { hit = i; break; }
  }
  if (hit < 0) return null;
  const split = paymentRowsDerived_(list);
  const rid = paymentCell_(list[hit].id);
  const receipt = split.receipts.find(function (r) { return paymentCell_(r.id) === rid; }) || list[hit];
  const cycle = split.cycles.find(function (c) { return paymentCell_(c.id) === paymentCell_(receipt.cycleId); }) || null;
  return { ok: true, receipt: receipt, cycle: cycle, created: false, replayed: true };
}

/* The replay answer for a void RETRY (CHANGELOG-write-path-hardening.md):
 * receipt `id` in `grid` (raw PAYMENT_COLUMNS rows) is already void as a
 * duplicate with reason `note` → { ok, payment, cycle, replayed:true }, the
 * cycle derived exactly as getPayments_ derives it; otherwise null. PURE. */
function receiptVoidReplay_(grid, id, note) {
  const rows = (Array.isArray(grid) ? grid : []).map(function (g) {
    if (!Array.isArray(g)) return g;
    const o = {};
    for (let k = 0; k < PAYMENT_COLUMNS.length; k++) o[PAYMENT_COLUMNS[k]] = g[k];
    return o;
  });
  const want = paymentCell_(id);
  const row = rows.filter(function (r) { return r && paymentCell_(r.id) === want; })[0];
  if (!row || !isReceiptRow_(row) || !isVoidStatus_(row.status)) return null;
  if (paymentLinkStatusClean_(row.linkStatus) !== 'duplicate') return null;
  if (paymentLinkNoteClean_(row.linkNote) !== paymentLinkNoteClean_(note)) return null;
  const split = paymentRowsDerived_(rows);
  const receipt = split.receipts.find(function (r) { return paymentCell_(r.id) === want; }) || row;
  const cycle = split.cycles.find(function (c) { return paymentCell_(c.id) === paymentCell_(receipt.cycleId); }) || null;
  return { ok: true, payment: receipt, cycle: cycle, updated: false, replayed: true };
}

/* Re-derive the cycle a (void / un-voided) receipt belongs to, and write it.
 * Called by upsertPayment_ INSIDE its lock, after the receipt row landed.
 * → the cycle as written, or null when the receipt links to no cycle. */
function rederiveReceiptCycleLocked_(sh, stampUser, receiptId) {
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return null;
  const grid = sh.getRange(2, 1, lastRow - 1, PAYMENT_COLUMNS.length).getValues();
  const rows = grid.map(function (g) {
    const o = {};
    for (let k = 0; k < PAYMENT_COLUMNS.length; k++) o[PAYMENT_COLUMNS[k]] = g[k];
    return o;
  });
  const L = linkReceiptsToCycles_(rows);
  let at = -1;
  L.receipts.forEach(function (rc) { if (String(rc.row.id) === String(receiptId)) at = rc.cycleIndex; });
  if (at < 0) return null;
  const prev = rows[at];
  const d = recomputeCycleFromReceipts_(prev, L.byCycle[at] || []);
  const next = {};
  Object.keys(prev).forEach(function (k) { next[k] = prev[k]; });
  next.amountPaid = d.amountPaid;
  next.balance = d.balance;
  next.status = d.status;
  next.legacyAmountPaid = prev.legacyAmountPaid;
  const out = receiptRestampCycle_(next, prev, true, stampUser);
  setPaymentRowTextCols_(sh, at + 2);
  sh.getRange(at + 2, 1, 1, PAYMENT_COLUMNS.length).setValues([objectToRow_(out, PAYMENT_COLUMNS)]);
  return out;
}

/* ===== Duplicate receipts + the receipt's non-money fields =====
 * CHANGELOG-receipt-duplicates-and-edit.md (Sandra, 2026-10-07).
 *
 * B1 — at report time: reportPayment_ refuses { ok:false,
 *   error:'possible_duplicate', existing:{ id, receivedDate, reference } }
 *   when the same patient already has a LIVE receipt of the same amount
 *   received within DUPLICATE_WINDOW_DAYS (either side). Vered confirms
 *   «כן, קבלה נוספת» → the same report with confirmDuplicate:true is
 *   accepted and AuditLog 'payment_duplicate_override' names both receipts.
 * B2 — Ortal's «כפילות» (confirmPayment status 'duplicate', ONE receipt, a
 *   note 2–300): the receipt is voided through upsertPayment_ — the PR #144
 *   void path, linkStatus 'duplicate', its 'payment_link_duplicate' audit and
 *   the cycle re-derivation — so «נגבה» stops counting it. Refused when it
 *   is the only live receipt of its cycle. Un-void stays Sandra's alone.
 * B3 — listDuplicateReceiptsNow(): READ-ONLY editor report.
 * C  — editReceipt_: reference / method / payer / invoice / coverage only. */
const DUPLICATE_WINDOW_DAYS = 14;
const DUPLICATE_DECISION = 'duplicate';
const POSSIBLE_DUPLICATE_MESSAGE = 'קיימת כבר קבלה דומה';
const DUPLICATE_LAST_RECEIPT_MESSAGE = 'זו הקבלה היחידה של המחזור — אי אפשר לסמן אותה ככפילות. אם הכסף לא התקבל, סמנו «לא שולם»';

/* A Payments cell as 'YYYY-MM-DD' ('' when it is not a real day). */
function receiptDayIso_(v) {
  if (v instanceof Date) return localPartsISO_(v);
  return paymentReportDate_(v) || '';
}

/* The live receipt of the same patient (receiptSamePatient_ against
 * `probe`), the same amount (agorot) and received within
 * DUPLICATE_WINDOW_DAYS of receivedIso — the closest one, or null. PURE.
 * → { id, receivedDate, reference } */
function receiptPossibleDuplicate_(rows, probe, amount, receivedIso) {
  if (!receivedIso || !probe) return null;
  const at = paymentReportDayNum_(receivedIso);
  const want = receiptMoney_(amount);
  let best = null;
  (Array.isArray(rows) ? rows : []).forEach(function (r) {
    if (!isReceiptRow_(r) || isVoidStatus_(r.status) || !receiptSamePatient_(r, probe)) return;
    if (receiptReportedAmount_(r) !== want) return;
    const d = receiptDayIso_(r.receivedDate);
    if (!d) return;
    const gap = Math.abs(paymentReportDayNum_(d) - at);
    if (gap > DUPLICATE_WINDOW_DAYS) return;
    if (!best || gap < best.gap) best = { gap: gap, row: r, date: d };
  });
  return best ? { id: paymentCell_(best.row.id), receivedDate: best.date, reference: paymentCell_(best.row.reference) } : null;
}

/* Whether the receipt at `index` of the raw Payments grid shares its cycle
 * with at least one OTHER live receipt. Unlinked → false. PURE. */
function receiptHasLiveSibling_(grid, index) {
  const rows = (Array.isArray(grid) ? grid : []).map(function (g) {
    const o = {};
    for (let k = 0; k < PAYMENT_COLUMNS.length; k++) o[PAYMENT_COLUMNS[k]] = g[k];
    return o;
  });
  const L = linkReceiptsToCycles_(rows);
  let cycleIndex = -1;
  L.receipts.forEach(function (rc) { if (rc.index === index) cycleIndex = rc.cycleIndex; });
  if (cycleIndex < 0) return false;
  const self = paymentCell_(rows[index] && rows[index].id);
  return (L.byCycle[cycleIndex] || []).some(function (r) {
    return paymentCell_(r.id) !== self && !isVoidStatus_(r.status);
  });
}

/* confirmPayment status 'duplicate' — Ortal (controller) or Sandra
 * (approver); handle_ already checked the role. ONE receipt; req.note is the
 * required reason (confirmRequestClean_). Reuses the PR #144 void path. */
function confirmDuplicate_(req, user, ctx) {
  const c = ctx || {};
  const stampUser = String(user == null ? '' : user);
  const id = req.ids[0];
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(PAYMENTS_SHEET);
  const rows = sh ? readSheet_(sh, PAYMENT_COLUMNS) : [];
  let row = null;
  for (let i = 0; i < rows.length; i++) if (paymentCell_(rows[i].id) === id) { row = rows[i]; break; }
  if (!row || !isReceiptRow_(row)) return Object.assign(confirmError_('not_found'), { id: id });
  if (isVoidStatus_(row.status)) {
    // A RETRY of this very «כפילות» (same note): answer what landed.
    const replay = receiptVoidReplay_(rows, id, req.note);
    if (!replay) return Object.assign(confirmError_('receipt_void'), { id: id });
    return {
      ok: true, changed: [], unchanged: 0, replayed: true,
      voided: [{ id: id, status: PAYMENT_VOID_STATUS, linkStatus: 'duplicate', linkNote: paymentCell_(replay.payment.linkNote) }],
      cycle: replay.cycle,
    };
  }
  const res = upsertPayment_({
    id: id, status: PAYMENT_VOID_STATUS, linkPatientUid: '', linkStatus: 'duplicate',
    linkNote: req.note, timestamp: new Date().toISOString(),
  }, stampUser, { actor: c.actor === undefined ? stampUser : String(c.actor), duplicateGuard: true, refuseLegacyMoney: true });
  if (!res || res.ok !== true) return Object.assign({}, res || { ok: false, error: 'duplicate_failed' }, { id: id });
  return {
    ok: true, changed: [], unchanged: 0,
    voided: [{ id: id, status: PAYMENT_VOID_STATUS, linkStatus: 'duplicate', linkNote: req.note }],
    cycle: res.cycle || null,
  };
}

/* Every patient with 2+ LIVE receipts of the same amount received within
 * DUPLICATE_WINDOW_DAYS of each other (a chain: each one within the window
 * of the previous). PURE. → [{ patientName, houseId, amount, receipts:
 * [{ id, receivedDate, reference, method, confirmStatus, recordedBy }] }] */
function duplicateReceiptGroups_(rows) {
  const byKey = {};
  (Array.isArray(rows) ? rows : []).forEach(function (r) {
    if (!isReceiptRow_(r) || isVoidStatus_(r.status)) return;
    const d = receiptDayIso_(r.receivedDate);
    if (!d) return;
    const who = paymentCell_(r.patientUid) || paymentCell_(r.patientId);
    if (!who) return;
    const k = who + '|' + receiptReportedAmount_(r);
    (byKey[k] = byKey[k] || []).push({ row: r, date: d });
  });
  const out = [];
  Object.keys(byKey).sort().forEach(function (k) {
    const list = byKey[k].sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
    let chain = [list[0]];
    const flush = function () {
      if (chain.length < 2) return;
      const first = chain[0].row;
      out.push({
        patientName: paymentCell_(first.patientName), houseId: paymentCell_(first.houseId),
        amount: receiptReportedAmount_(first),
        receipts: chain.map(function (x) {
          return { id: paymentCell_(x.row.id), receivedDate: x.date, reference: paymentCell_(x.row.reference),
            method: paymentCell_(x.row.method), confirmStatus: receiptConfirmStatus_(x.row), recordedBy: paymentCell_(x.row.recordedBy) };
        }),
      });
    };
    for (let i = 1; i < list.length; i++) {
      if (paymentReportDayNum_(list[i].date) - paymentReportDayNum_(chain[chain.length - 1].date) <= DUPLICATE_WINDOW_DAYS) chain.push(list[i]);
      else { flush(); chain = [list[i]]; }
    }
    flush();
  });
  return out;
}

/**
 * EDITOR-RUN, READ-ONLY. Run from the Apps Script editor (no argument):
 * logs every patient with 2+ live receipts of the same amount received within
 * 14 days of each other. Reads Payments only — no lock, no write, no sheet
 * created. Decide each group in «בקרת גבייה» («כפילות») or with Vered.
 * → { ok, groups, receipts } */
function listDuplicateReceiptsNow() {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(PAYMENTS_SHEET);
  const rows = sh ? readSheet_(sh, PAYMENT_COLUMNS) : [];
  const groups = duplicateReceiptGroups_(rows);
  let n = 0;
  Logger.log('listDuplicateReceiptsNow — ' + groups.length + ' patient group(s) with possible duplicate receipts (same amount, ≤' +
    DUPLICATE_WINDOW_DAYS + ' days). READ-ONLY: nothing was changed.');
  groups.forEach(function (g) {
    n += g.receipts.length;
    Logger.log('• ' + g.patientName + ' (' + g.houseId + ') ₪' + g.amount + ' × ' + g.receipts.length);
    g.receipts.forEach(function (r) {
      Logger.log('    ' + r.receivedDate + ' · ' + r.id + ' · אסמכתא ' + (r.reference || '—') + ' · ' + (r.method || '—') +
        ' · ' + r.confirmStatus + ' · ' + (r.recordedBy || '—'));
    });
  });
  return { ok: true, groups: groups, receipts: n };
}

/* ---- C: the receipt's non-money fields (editReceipt) -------------------
 * Vered and Sandra (FINANCE_ACTIONS; never the controller view). ONLY
 * RECEIPT_EDIT_FIELDS; amount, receivedDate, status and every other key are
 * REFUSED (field_not_editable), nothing written. The edited fields are
 * validated with the reportPayment rules (validatePaymentReport_ /
 * validatePaymentInvoice_); a coverage change must keep the receipt on the
 * SAME cycle (money never moves between cycles here). Only the changed cells
 * are written — no restamp, no version bump, confirmStatus untouched. One
 * AuditLog row 'receipt_edited' with prev / next, the optional reason, by, at. */
const RECEIPT_EDIT_FIELDS = ['reference', 'method', 'payer', 'invoiceWanted', 'invoiceTo', 'coverageStart', 'coverageEnd'];
const RECEIPT_EDIT_REASON_MAX = 300;
const RECEIPT_EDIT_MESSAGES = {
  bad_edit: 'בקשת עריכה לא תקינה',
  field_not_editable: 'סכום, תאריך קבלה וסטטוס אינם ניתנים לעריכה',
  not_found: 'הקבלה לא נמצאה — רעננו את הדף',
  receipt_void: 'הקבלה בוטלה — אין מה לערוך',
  reason_invalid: 'סיבה — טקסט עד 300 תווים',
  coverage_outside_cycle: 'תחילת תקופת הכיסוי חייבת להישאר בתוך מחזור החיוב',
  sheet_header_clash: 'מבנה גיליון התשלומים השתנה — פנו לסנדרה',
};
function receiptEditError_(code, extra) {
  return Object.assign({ ok: false, error: code, message: RECEIPT_EDIT_MESSAGES[code] || code }, extra || {});
}

/* body { id: 'rcpt-…', fields: { …RECEIPT_EDIT_FIELDS }, reason? }. */
function editReceipt_(body, user, ctx) {
  const b = body && typeof body === 'object' ? body : {};
  const c = ctx || {};
  const stampUser = String(user == null ? '' : user);
  const id = String(b.id == null ? '' : b.id).trim();
  if (!id || id.length > 300 || /[\u0000-\u001f\u007f]/.test(id) || id.indexOf(RECEIPT_ID_PREFIX) !== 0) return receiptEditError_('bad_edit');
  const f = b.fields && typeof b.fields === 'object' && !Array.isArray(b.fields) ? b.fields : null;
  if (!f) return receiptEditError_('bad_edit');
  const sent = Object.keys(f);
  const forbidden = sent.filter(function (k) { return RECEIPT_EDIT_FIELDS.indexOf(k) < 0; });
  if (forbidden.length) return receiptEditError_('field_not_editable', { fields: forbidden });
  if (!sent.length) return receiptEditError_('bad_edit');
  for (let i = 0; i < sent.length; i++) {
    const v = f[sent[i]];
    if (v !== null && typeof v !== 'string') return receiptEditError_('bad_edit');
  }
  const rawReason = b.reason === undefined || b.reason === null ? '' : b.reason;
  if (typeof rawReason !== 'string') return receiptEditError_('reason_invalid');
  const reason = rawReason.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().replace(/^[=+@-]+/, '').trim();
  if (reason.length > RECEIPT_EDIT_REASON_MAX) return receiptEditError_('reason_invalid');

  const lock = LockService.getScriptLock();
  if (lock.tryLock(10000) !== true) return lockBusy_('editReceipt_');
  try {
    const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(PAYMENTS_SHEET);
    if (!sh || sh.getLastRow() < 2) return receiptEditError_('not_found');
    const header = sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), 1)).getValues()[0];
    if (paymentReportHeaderClash_(header).length || paymentInvoiceHeaderClash_(header).length) return receiptEditError_('sheet_header_clash');
    const grid = sh.getRange(2, 1, sh.getLastRow() - 1, PAYMENT_COLUMNS.length).getValues();
    const rows = grid.map(function (g) {
      const o = {};
      for (let k = 0; k < PAYMENT_COLUMNS.length; k++) o[PAYMENT_COLUMNS[k]] = g[k];
      return o;
    });
    let at = -1;
    for (let i = 0; i < rows.length; i++) if (paymentCell_(rows[i].id) === id) { at = i; break; }
    if (at < 0 || !isReceiptRow_(rows[at])) return receiptEditError_('not_found');
    const prevRow = rows[at];
    if (isVoidStatus_(prevRow.status)) return receiptEditError_('receipt_void');

    const stored = {
      reference: paymentCell_(prevRow.reference), method: paymentCell_(prevRow.method), payer: paymentCell_(prevRow.payer),
      invoiceWanted: paymentCell_(prevRow.invoiceWanted), invoiceTo: paymentCell_(prevRow.invoiceTo),
      coverageStart: receiptDayIso_(prevRow.coverageStart), coverageEnd: receiptDayIso_(prevRow.coverageEnd),
    };
    const next = {};
    RECEIPT_EDIT_FIELDS.forEach(function (k) { next[k] = sent.indexOf(k) >= 0 ? paymentReportText_(f[k]) : stored[k]; });
    // Validate the edited fields with the reportPayment rules (only the
    // fields this edit touches — a legacy blank elsewhere is not its issue).
    const touched = {};
    sent.forEach(function (k) { touched[k] = true; });
    if (touched.coverageStart || touched.coverageEnd) { touched.coverageStart = true; touched.coverageEnd = true; }
    if (touched.method) touched.reference = true;
    const issues = validatePaymentReport_({
      receivedDate: receiptDayIso_(prevRow.receivedDate), amount: receiptReportedAmount_(prevRow),
      method: next.method, payer: next.payer, coverageStart: next.coverageStart, coverageEnd: next.coverageEnd,
      funder: paymentCell_(prevRow.funder), reference: next.reference,
    }, { todayIso: paymentReportToday_() }).filter(function (i) { return touched[i.field]; });
    if (touched.invoiceWanted || touched.invoiceTo) issues.push.apply(issues, validatePaymentInvoice_(next));
    if (issues.length) {
      return { ok: false, error: 'invalid_report', message: PAYMENT_REPORT_REFUSED_MESSAGE, issues: issues };
    }
    // Only a field this edit touches is normalized (an untouched legacy cell
    // never reads as a change).
    if (touched.method) next.method = paymentReportMethod_(next.method);
    if (touched.invoiceWanted || touched.invoiceTo) {
      const inv = paymentInvoiceClean_(next);
      next.invoiceWanted = inv.invoiceWanted;
      next.invoiceTo = inv.invoiceTo;
    }
    // A coverage change keeps the receipt on the cycle it pays.
    if (next.coverageStart !== stored.coverageStart || next.coverageEnd !== stored.coverageEnd) {
      const moved = rows.slice();
      const probe = {};
      Object.keys(prevRow).forEach(function (k) { probe[k] = prevRow[k]; });
      probe.coverageStart = next.coverageStart;
      probe.coverageEnd = next.coverageEnd;
      moved[at] = probe;
      const before = linkReceiptsToCycles_(rows).receipts.filter(function (rc) { return rc.index === at; })[0];
      const after = linkReceiptsToCycles_(moved).receipts.filter(function (rc) { return rc.index === at; })[0];
      if (!before || !after || before.cycleIndex !== after.cycleIndex) return receiptEditError_('coverage_outside_cycle');
    }

    const changedKeys = RECEIPT_EDIT_FIELDS.filter(function (k) { return next[k] !== stored[k]; });
    // Nothing to change (e.g. a retry whose first answer was lost): answer
    // the stored row, so the caller has its proof (CHANGELOG-write-path-hardening.md).
    if (!changedKeys.length) {
      const same = {};
      Object.keys(prevRow).forEach(function (k) { same[k] = prevRow[k]; });
      return { ok: true, changed: false, receipt: same };
    }
    setPaymentRowTextCols_(sh, at + 2);
    changedKeys.forEach(function (k) {
      sh.getRange(at + 2, PAYMENT_COLUMNS.indexOf(k) + 1).setValue(next[k]);
    });
    const prevOut = {}, nextOut = {};
    changedKeys.forEach(function (k) { prevOut[k] = stored[k]; nextOut[k] = next[k]; });
    const nowStamp = israelTimestamp_();
    logAudit_('receipt_edited', 'editReceipt_', String(prevRow.patientUid || ''), String(prevRow.patientName || ''), {
      receiptId: id, paymentUid: paymentCell_(prevRow.paymentUid), fields: changedKeys,
      prev: prevOut, next: nextOut, reason: reason, by: stampUser, at: nowStamp,
    }, c.actor === undefined ? stampUser : String(c.actor));
    const echo = {};
    Object.keys(prevRow).forEach(function (k) { echo[k] = prevRow[k]; });
    changedKeys.forEach(function (k) { echo[k] = next[k]; });
    return { ok: true, changed: true, fields: changedKeys, receipt: echo };
  } finally {
    try { lock.releaseLock(); } catch (_) { /* no-op */ }
  }
}

/* ===== «בקרת גבייה» — Ortal's verification (Phase 4, Sandra 2026-10-04) =====
 * docs/billing-control-plan.md Phase 4 / §7; CHANGELOG-billing-control-tab.md.
 *
 * Every receipt (rcpt- row, Phase 3 PR 2) is born confirmStatus 'reported'.
 * Ortal (controller) — or Sandra (approver) — checks the bank herself, outside
 * the system, and decides per receipt:
 *   reported → confirmed   «אושר בבנק» — the money is real revenue
 *   reported → flagged     «לא נמצא / בעיה» — flagNote REQUIRED (2–300 chars)
 *   flagged  → reported    «הסר דגל» (she was wrong)
 *   flagged  → confirmed   allowed (found after all)
 *   confirmed → reported / flagged
 *                          allowed (a mistake), never silent: AuditLog
 * confirmedBy / confirmedAt are stamped ONCE, at the first confirmation, and
 * never re-stamped or cleared; every transition writes ONE AuditLog row with
 * the old and new status, the old and new note, and the actor. The amount,
 * the date and every other cell of the receipt are never touched — a wrong
 * amount is flagged, and Vered cancels and re-reports (the existing flow).
 *
 * Extended 2026-10-06 (CHANGELOG-ortal-billing-access.md) — the status
 * dropdown and the note:
 *   any → confirmed   «שולם» — confirmedAmount = the full reported amount
 *   any → partial     «שולם חלקית» — ONE receipt, confirmedAmount required,
 *                     0 < x < the reported amount (agorot). Only x is verified
 *                     money; the rest stays open debt in the tab
 *   any → flagged     «לא שולם» — the existing flow, flagNote required
 *   controlNote       Ortal's free-text note (0–500), ONE receipt, at any
 *                     time, with or without a status change
 * Each status change → one AuditLog row 'payment_confirm_<to>'; each note
 * change → one row 'payment_control_note'; both carry at / by / prev / next.
 * The reported amount (amountPaid) is still never touched. */
const CONFIRM_BATCH_MAX = 200;
const BILLING_CONTROL_FLAG_STALE_DAYS = 7;
const BILLING_CONTROL_DEBT_BUCKET = 'd61_plus';
const CONFIRM_ERROR_MESSAGES = {
  confirm_status_invalid: 'סטטוס אישור לא מוכר',
  bad_ids: 'לא נבחרו קבלות לאישור',
  flag_note_invalid: 'בסימון «בעיה» חובה לפרט (2 עד 300 תווים)',
  not_found: 'הקבלה לא נמצאה — רעננו את הדף',
  receipt_void: 'הקבלה בוטלה — אין מה לאשר',
  confirm_without_report: 'אין דיווח תשלום לאשר — חסר תאריך קבלה',
  sheet_header_clash: 'מבנה גיליון התשלומים השתנה — פנו לסנדרה',
  partial_single: '«שולם חלקית» — קבלה אחת בכל פעם',
  partial_amount_invalid: 'בתשלום חלקי חובה להזין סכום שהתקבל (מספר, עד שתי ספרות אחרי הנקודה)',
  partial_amount_range: 'הסכום שהתקבל חייב להיות גדול מאפס וקטן מהסכום שדווח',
  control_note_invalid: 'הערה — טקסט עד 500 תווים',
  control_note_single: 'הערה נשמרת לקבלה אחת בכל פעם',
  /* «כפילות» (CHANGELOG-receipt-duplicates-and-edit.md). */
  duplicate_single: '«כפילות» — קבלה אחת בכל פעם',
  duplicate_note_invalid: 'בסימון «כפילות» חובה לפרט (2 עד 300 תווים)',
};

function confirmError_(code) {
  return { ok: false, error: code, message: CONFIRM_ERROR_MESSAGES[code] || code };
}

/* A receipt's stored confirm status: blank (or anything unknown) on a
 * receipt reads 'reported'. */
function receiptConfirmStatus_(row) {
  const cs = paymentCell_(row && row.confirmStatus);
  return CONTROL_STATUSES.indexOf(cs) >= 0 ? cs : 'reported';
}

/* The amount Vered reported on a receipt (amountPaid, else amount). PURE. */
function receiptReportedAmount_(row) {
  const r = row || {};
  return receiptMoney_(r.amountPaid !== '' && r.amountPaid !== undefined && r.amountPaid !== null ? r.amountPaid : r.amount);
}

/* The verified money of a receipt — only what Ortal confirmed. PURE.
 *   confirmed → confirmedAmount, or the reported amount when blank (a
 *               receipt confirmed before the column existed)
 *   partial   → confirmedAmount
 *   reported / flagged / void → 0
 * lib/billing-control-rules.js verifiedAmountOf is the same rule. */
function receiptVerifiedAmount_(row) {
  if (!row || isVoidStatus_(row.status)) return 0;
  const cs = receiptConfirmStatus_(row);
  const cell = paymentCell_(row.confirmedAmount);
  if (cs === 'confirmed') return cell === '' ? receiptReportedAmount_(row) : receiptMoney_(row.confirmedAmount);
  if (cs === 'partial') return cell === '' ? 0 : receiptMoney_(row.confirmedAmount);
  return 0;
}

/* The open (unverified) money of a DECIDED receipt in the tab: partial →
 * reported − verified; flagged («לא שולם») → the whole reported amount;
 * reported (still waiting) / confirmed / void → 0. PURE. Mirrors
 * lib/billing-control-rules.js openAmountOf. */
function receiptOpenAmount_(row) {
  if (!row || isVoidStatus_(row.status)) return 0;
  const cs = receiptConfirmStatus_(row);
  if (cs === 'partial') return Math.max(0, receiptMoney_(receiptReportedAmount_(row) - receiptVerifiedAmount_(row)));
  if (cs === 'flagged') return receiptReportedAmount_(row);
  return 0;
}

/* «שולם חלקית» amount as sent: a finite number > 0 with at most two decimals
 * (a number, or its plain decimal text). → the amount | null. The upper bound
 * (< the reported amount) needs the stored row: confirmTransition_. PURE. */
function confirmedAmountParse_(v) {
  if (typeof v === 'number') {
    if (!isFinite(v)) return null;
  } else if (typeof v === 'string') {
    if (!/^\s*\d{1,9}(\.\d{1,2})?\s*$/.test(v)) return null;
  } else return null;
  const n = Number(v);
  if (!isFinite(n) || n <= 0) return null;
  if (Math.abs(Math.round(n * 100) - n * 100) > 1e-6) return null;
  return receiptMoney_(n);
}

/* controlNote as stored: one line (control characters → space), trimmed, a
 * formula lead-in (= + - @) dropped — the flagNote treatment. A longer note
 * is REFUSED, never cut. '' is legal (clears the note). Non-text → refused.
 * → { ok:true, note } | { ok:false }. PURE. Mirrors
 * lib/billing-control-rules.js controlNoteCheck. */
function controlNoteClean_(v) {
  if (typeof v !== 'string') return { ok: false };
  const t = v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().replace(/^[=+@-]+/, '').trim();
  if (t.length > CONTROL_NOTE_MAX) return { ok: false };
  return { ok: true, note: t };
}

/* The confirm request, validated. PURE.
 *   body { ids: [rcpt-…] | id, status, flagNote, confirmedAmount, controlNote }
 *   status           CONTROL_STATUSES; may be omitted ONLY when controlNote
 *                    is sent (a note-only edit)
 *   confirmedAmount  required for 'partial' (ONE id); ignored otherwise
 *   controlNote      optional, ONE id; '' clears it
 * → { ok:true, ids, status ('' = keep), note, amount, controlNote (null =
 *     keep) } | refusal */
function confirmRequestClean_(body) {
  const b = body && typeof body === 'object' ? body : {};
  const status = String(b.status == null ? '' : b.status).trim();
  const noteSent = b.controlNote !== undefined && b.controlNote !== null;
  // «כפילות» is a DECISION, never a stored confirmStatus: it voids the
  // receipt (confirmDuplicate_). CHANGELOG-receipt-duplicates-and-edit.md.
  const isDup = status === DUPLICATE_DECISION;
  if (status === '' ? !noteSent : (CONTROL_STATUSES.indexOf(status) < 0 && !isDup)) return confirmError_('confirm_status_invalid');
  const raw = Array.isArray(b.ids) ? b.ids : (b.id !== undefined && b.id !== null ? [b.id] : []);
  if (!raw.length || raw.length > CONFIRM_BATCH_MAX) return confirmError_('bad_ids');
  const ids = [];
  for (let i = 0; i < raw.length; i++) {
    const id = String(raw[i] == null ? '' : raw[i]).trim();
    if (!id || id.length > 300 || /[\u0000-\u001f\u007f]/.test(id) || id.indexOf(RECEIPT_ID_PREFIX) !== 0) return confirmError_('bad_ids');
    if (ids.indexOf(id) < 0) ids.push(id);
  }
  let note = '';
  if (isDup) {
    if (ids.length !== 1) return confirmError_('duplicate_single');
    const rawDup = String(b.flagNote == null ? '' : b.flagNote);
    const dupNote = rawDup.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().replace(/^[=+@-]+/, '').trim();
    if (dupNote.length < FLAG_NOTE_MIN || dupNote.length > FLAG_NOTE_MAX) return confirmError_('duplicate_note_invalid');
    return { ok: true, ids: ids, status: status, note: dupNote, amount: null, controlNote: null };
  }
  if (status === 'flagged') {
    const rawNote = String(b.flagNote == null ? '' : b.flagNote);
    note = paymentFlagNoteClean_(rawNote);
    const full = rawNote.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().replace(/^[=+@-]+/, '').trim();
    if (note.length < FLAG_NOTE_MIN || full.length > FLAG_NOTE_MAX) return confirmError_('flag_note_invalid');
  }
  let amount = null;
  if (status === 'partial') {
    if (ids.length !== 1) return confirmError_('partial_single');
    amount = confirmedAmountParse_(b.confirmedAmount);
    if (amount === null) return confirmError_('partial_amount_invalid');
  }
  let controlNote = null;
  if (noteSent) {
    if (ids.length !== 1) return confirmError_('control_note_single');
    const c = controlNoteClean_(b.controlNote);
    if (!c.ok) return confirmError_('control_note_invalid');
    controlNote = c.note;
  }
  return { ok: true, ids: ids, status: status, note: note, amount: amount, controlNote: controlNote };
}

/* A stored confirmedAmount cell as compared and audited: '' or agorot. */
function confirmedAmountCell_(v) {
  return paymentCell_(v) === '' ? '' : receiptMoney_(v);
}

/* The next confirm cells of ONE stored receipt for the request. PURE.
 * → { changed:false }
 *   | { changed:true, statusChanged, noteChanged, from, to, oldNote, prev,
 *       next, cells:{confirmStatus, confirmedBy, confirmedAt, flagNote,
 *       confirmedAmount, controlNote} }
 *   | refusal
 * prev / next = { status, confirmedAmount, flagNote, controlNote } — the
 * audit pair. A status re-sent unchanged (same amount, same flag note) is no
 * change; a receipt confirmed before confirmedAmount existed reads as its
 * full amount, so re-confirming it is still a no-op. */
function confirmTransition_(row, req, user, nowStamp) {
  if (isVoidStatus_(row.status)) return confirmError_('receipt_void');
  const rd = row.receivedDate instanceof Date ? localPartsISO_(row.receivedDate) : paymentReportDate_(row.receivedDate);
  if (!rd) return confirmError_('confirm_without_report');
  const reported = receiptReportedAmount_(row);
  const from = receiptConfirmStatus_(row);
  const oldNote = paymentCell_(row.flagNote);
  const prevAmountCell = confirmedAmountCell_(row.confirmedAmount);
  const prev = {
    status: from,
    confirmedAmount: from === 'confirmed' && prevAmountCell === '' ? reported : prevAmountCell,
    flagNote: oldNote,
    controlNote: paymentCell_(row.controlNote),
  };
  const statusSent = req.status !== '' && req.status !== undefined && req.status !== null;
  const to = statusSent ? req.status : from;
  let amount = prev.confirmedAmount;
  let flagNote = oldNote;
  if (statusSent) {
    flagNote = to === 'flagged' ? req.note : '';
    if (to === 'confirmed') amount = reported;
    else if (to === 'partial') {
      if (!(req.amount > 0 && req.amount < reported)) return confirmError_('partial_amount_range');
      amount = req.amount;
    } else amount = '';
  }
  const controlNote = req.controlNote === null || req.controlNote === undefined ? prev.controlNote : req.controlNote;
  const next = { status: to, confirmedAmount: amount, flagNote: flagNote, controlNote: controlNote };
  const statusChanged = statusSent && (to !== from || flagNote !== oldNote || amount !== prev.confirmedAmount);
  const noteChanged = controlNote !== prev.controlNote;
  if (!statusChanged && !noteChanged) return { changed: false };
  let by = paymentCell_(row.confirmedBy), at = paymentCell_(row.confirmedAt);
  if (statusChanged && (to === 'confirmed' || to === 'partial') && !by && !at) { by = String(user == null ? '' : user); at = nowStamp; }
  return {
    changed: true, statusChanged: statusChanged, noteChanged: noteChanged,
    from: from, to: to, oldNote: oldNote, prev: prev, next: next,
    cells: {
      confirmStatus: to, confirmedBy: by, confirmedAt: at, flagNote: flagNote,
      confirmedAmount: statusChanged ? amount : prevAmountCell, controlNote: controlNote,
    },
  };
}

/* Whether the Payments header can hold PAYMENT_CONTROL_COLUMNS: each of
 * their positions is blank or already carries its own name (readSheet_ maps
 * BY POSITION). Pure. */
function paymentControlHeaderClash_(header) {
  const h = Array.isArray(header) ? header : [];
  const clash = [];
  PAYMENT_CONTROL_COLUMNS.forEach(function (name) {
    const i = PAYMENT_COLUMNS.indexOf(name);
    const got = i < h.length ? String(h[i] == null ? '' : h[i]).trim() : '';
    if (got !== '' && got !== name) clash.push({ column: i + 1, expected: name, found: got });
  });
  return clash;
}

/* The fields of a receipt the tab / the export may show — an explicit
 * allow-list (no patientUid, no paymentUid, no triple id). PURE. */
function billingControlReceipt_(r, flaggedAt) {
  const iso = function (v) {
    if (v instanceof Date) return localPartsISO_(v);
    return paymentReportDate_(v) || coverageDateISO_(v) || '';
  };
  const cs = receiptConfirmStatus_(r);
  return {
    id: paymentCell_(r.id),
    cycleId: paymentCell_(r.cycleId),
    patientName: paymentCell_(r.patientName),
    houseId: paymentCell_(r.houseId),
    amount: receiptMoney_(r.amountPaid !== '' && r.amountPaid !== undefined && r.amountPaid !== null ? r.amountPaid : r.amount),
    receivedDate: iso(r.receivedDate),
    method: paymentCell_(r.method),
    reference: paymentCell_(r.reference),
    payer: paymentCell_(r.payer),
    funder: paymentCell_(r.funder),
    /* 'yes' | 'no' | '' (a receipt from before the invoice question — shown «—») */
    invoiceWanted: INVOICE_CHOICES.indexOf(paymentCell_(r.invoiceWanted)) >= 0 ? paymentCell_(r.invoiceWanted) : '',
    invoiceTo: paymentCell_(r.invoiceWanted) === 'yes' ? paymentCell_(r.invoiceTo) : '',
    coverageStart: iso(r.coverageStart),
    coverageEnd: iso(r.coverageEnd),
    recordedBy: paymentCell_(r.recordedBy),
    recordedAt: paymentCell_(r.recordedAt),
    confirmStatus: cs,
    confirmedBy: paymentCell_(r.confirmedBy),
    confirmedAt: paymentCell_(r.confirmedAt),
    flagNote: cs === 'flagged' ? paymentCell_(r.flagNote) : '',
    flaggedAt: cs === 'flagged' ? String(flaggedAt || paymentCell_(r.recordedAt) || '') : '',
    /* CHANGELOG-ortal-billing-access.md: the verified money, the open rest,
     * the partial amount as entered ('' unless partial) and Ortal's note. */
    verifiedAmount: receiptVerifiedAmount_(r),
    openAmount: receiptOpenAmount_(r),
    confirmedAmount: cs === 'partial' ? receiptVerifiedAmount_(r) : '',
    controlNote: paymentCell_(r.controlNote),
  };
}

/* Newest first: receivedDate, then recordedAt, then id. PURE. */
function billingControlSort_(list) {
  return list.sort(function (a, b) {
    if (a.receivedDate !== b.receivedDate) return a.receivedDate < b.receivedDate ? 1 : -1;
    if (a.recordedAt !== b.recordedAt) return a.recordedAt < b.recordedAt ? 1 : -1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/* { count, amount } per confirm status over projected receipts. PURE. */
function billingControlCounts_(list) {
  const out = { reported: { count: 0, amount: 0 }, flagged: { count: 0, amount: 0 }, confirmed: { count: 0, amount: 0 },
    partial: { count: 0, amount: 0, verified: 0, open: 0 } };
  list.forEach(function (r) {
    const b = out[r.confirmStatus];
    if (!b) return;
    b.count++;
    b.amount = receiptMoney_(b.amount + r.amount);
    if (r.confirmStatus === 'partial') {
      b.verified = receiptMoney_(b.verified + (Number(r.verifiedAmount) || 0));
      b.open = receiptMoney_(b.open + (Number(r.openAmount) || 0));
    }
  });
  return out;
}

/* The tab's open debt by verification (CHANGELOG-ortal-billing-access.md):
 * only confirmed money reduces it. partial = the unconfirmed rest of every
 * «שולם חלקית» receipt; notReceived = every «לא שולם» receipt in full.
 * Receipts still waiting are NOT debt here (counts.reported shows them).
 * debtAging_ / «חובות פתוחים» / revenue are unchanged. PURE. */
function billingControlOpenDebt_(list) {
  const out = { partial: { count: 0, amount: 0 }, notReceived: { count: 0, amount: 0 }, total: 0 };
  list.forEach(function (r) {
    const open = Number(r.openAmount) || 0;
    if (open <= 0) return;
    const b = r.confirmStatus === 'partial' ? out.partial : r.confirmStatus === 'flagged' ? out.notReceived : null;
    if (!b) return;
    b.count++;
    b.amount = receiptMoney_(b.amount + open);
    out.total = receiptMoney_(out.total + open);
  });
  return out;
}

/* The day ('YYYY-MM-DD', Israel) of a stored stamp, or ''. */
function billingControlDay_(stamp) {
  const s = String(stamp == null ? '' : stamp).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s) && s.length === 10) return s;
  const t = Date.parse(s);
  if (!isFinite(t)) return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : '';
  return String(Utilities.formatDate(new Date(t), 'Asia/Jerusalem', 'yyyy-MM-dd')).slice(0, 10);
}

/* Whole days from the day of `stamp` to todayIso (0 when unknown). PURE. */
function billingControlAgeDays_(stamp, todayIso) {
  const d = billingControlDay_(stamp);
  if (!d || !todayIso) return 0;
  return Math.max(0, paymentReportDayNum_(todayIso) - paymentReportDayNum_(d));
}

/* The latest «flagged» decision per receipt id, from AuditLog (both this
 * action and the savePayment path write 'payment_confirm_flagged').
 * READ-ONLY, fail-soft: an unreadable log → {} (the age falls back to
 * recordedAt). */
function billingControlFlagTimes_() {
  const out = {};
  try {
    const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(AUDIT_LOG_SHEET);
    if (!sh) return out;
    readSheet_(sh, AUDIT_LOG_COLUMNS).forEach(function (r) {
      if (String(r.action) !== 'payment_confirm_flagged') return;
      let d = null;
      try { d = JSON.parse(String(r.details || '')); } catch (_) { d = null; }
      const id = d && d.paymentId ? String(d.paymentId) : '';
      if (!id) return;
      const at = String(r.timestamp || '');
      if (!out[id] || at > out[id]) out[id] = at;
    });
  } catch (_) { /* fail-soft */ }
  return out;
}

/* «חובות מעל 60 יום» from debtAging_'s own output (no second engine): the
 * cycles in the 61+ bucket, recorded debt and unrecorded cycles kept apart
 * (never summed — the debt-aging rule). PURE. */
function billingControlDebt60_(aging) {
  if (!aging || aging.ok !== true) return null;
  const out = { asOf: aging.asOf, recorded: { count: 0, amount: 0 }, unrecorded: { count: 0, amount: 0 }, rows: [] };
  (aging.byPatient || []).forEach(function (p) {
    (p.cycles || []).forEach(function (c) {
      if (c.bucket !== BILLING_CONTROL_DEBT_BUCKET) return;
      const b = c.kind === 'recorded' ? out.recorded : out.unrecorded;
      b.count++;
      b.amount = receiptMoney_(b.amount + (Number(c.balance) || 0));
      out.rows.push({
        patientName: String(p.name || ''), houseId: String(p.houseId || ''), start: String(c.start || ''),
        balance: receiptMoney_(c.balance), days: Number(c.days) || 0, kind: c.kind === 'recorded' ? 'recorded' : 'unrecorded',
      });
    });
  });
  out.rows.sort(function (a, b) { return b.days - a.days || (a.patientName < b.patientName ? -1 : a.patientName > b.patientName ? 1 : 0); });
  return out;
}

/* Refund exceptions awaiting Sandra (plan §7.4 / §8.5), from existing data:
 *   awaiting  — refundPayoutForecastFor_'s «ממתין להחלטה» stays
 *   overPolicy — a PENDING credit whose amount exceeds its stored
 *                calculatedAmount (the policy figure)
 * PURE over its inputs. */
function billingControlRefundExceptions_(forecast, credits) {
  const out = [];
  const aw = forecast && forecast.awaiting_decision ? forecast.awaiting_decision : null;
  ((aw && aw.byPayoutDate) || []).forEach(function (g) {
    (g.rows || []).forEach(function (r) {
      out.push({
        kind: 'awaiting_decision', patientName: String(r.patientName || ''), houseId: String(r.houseId || ''),
        exitDate: String(r.exitDate || ''), amount: receiptMoney_(r.suggestedAmount), policyAmount: receiptMoney_(r.suggestedAmount),
        payoutDate: String(r.payoutDate || ''),
      });
    });
  });
  (Array.isArray(credits) ? credits : []).forEach(function (c) {
    if (!c || String(c.status == null ? '' : c.status).trim() !== 'pending') return;
    const amount = Number(c.amount), calc = Number(c.calculatedAmount);
    if (!isFinite(amount) || !isFinite(calc) || String(c.calculatedAmount).trim() === '') return;
    if (receiptMoney_(amount) <= receiptMoney_(calc)) return;
    out.push({
      kind: 'over_policy', patientName: String(c.patientName || ''), houseId: String(c.houseId || ''),
      exitDate: '', amount: receiptMoney_(amount), policyAmount: receiptMoney_(calc),
      payoutDate: refundForecastIso_(c.payoutDate) || String(c.payoutDate || ''),
      reason: String(c.overrideReason || ''),
    });
  });
  return out;
}

/* The whole queue answer from already-read rows. PURE apart from the clock
 * passed in.
 *   rows       Payments row objects
 *   flagTimes  { receiptId: ISO } (AuditLog)
 *   opts       { todayIso, approver, aging (debtAging_ output), forecast, credits }
 * Sandra's «חריגים פתוחים» (read-only) rides only an approver answer. */
function billingControlQueueFor_(rows, flagTimes, opts) {
  const o = opts || {};
  const today = o.todayIso;
  const split = paymentRowsDerived_(Array.isArray(rows) ? rows : []);
  const ft = flagTimes || {};
  const receipts = billingControlSort_(split.receipts.filter(function (r) {
    return !isVoidStatus_(r.status);
  }).map(function (r) { return billingControlReceipt_(r, ft[paymentCell_(r.id)]); }));
  const debt60 = billingControlDebt60_(o.aging);
  const out = {
    ok: true, today: today, receipts: receipts, counts: billingControlCounts_(receipts),
    openDebt: billingControlOpenDebt_(receipts),
    debt60: debt60 ? { asOf: debt60.asOf, recorded: debt60.recorded, unrecorded: debt60.unrecorded } : null,
    flagStaleDays: BILLING_CONTROL_FLAG_STALE_DAYS,
  };
  if (o.approver === true) {
    out.exceptions = {
      flaggedOld: receipts.filter(function (r) {
        return r.confirmStatus === 'flagged' && billingControlAgeDays_(r.flaggedAt, today) > BILLING_CONTROL_FLAG_STALE_DAYS;
      }).map(function (r) {
        return Object.assign({}, r, { ageDays: billingControlAgeDays_(r.flaggedAt, today) });
      }),
      debtsOver60: debt60 ? debt60.rows : [],
      refundExceptions: billingControlRefundExceptions_(o.forecast, o.credits),
    };
  }
  return out;
}

/**
 * action=billingControlQueue — READ-ONLY. PROXY_SECRET-gated (not in
 * OPEN_ACTIONS), needs billingControl (Vered, Sandra, Ortal). Reads Payments,
 * AuditLog, and — through the existing read actions — debt aging as of today
 * and (approver only) the refund forecast + Credits. Never creates a sheet,
 * no lock, no write. The minimal payload the tab needs: no patient or lead
 * list, no clinical field.
 */
function billingControlQueue_(opts) {
  try {
    const o = opts || {};
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sh = ss.getSheetByName(PAYMENTS_SHEET);
    const rows = sh ? readSheet_(sh, PAYMENT_COLUMNS) : [];
    const today = paymentReportToday_();
    let aging = null;
    try { aging = debtAgingAction_({ asOf: today }); } catch (_) { aging = null; }
    let forecast = null, credits = [];
    if (o.approver === true) {
      try { forecast = refundPayoutForecast_(); } catch (_) { forecast = null; }
      try { const csh = ss.getSheetByName(CREDITS_SHEET); credits = csh ? readSheet_(csh, CREDIT_COLUMNS) : []; } catch (_) { credits = []; }
    }
    const out = billingControlQueueFor_(rows, billingControlFlagTimes_(), {
      todayIso: today, approver: o.approver === true, aging: aging, forecast: forecast, credits: credits,
    });
    out.generatedAt = new Date().toISOString();
    return out;
  } catch (e) {
    return { ok: false, error: (e && e.code) || 'billing_control_failed' };
  }
}

/**
 * action=confirmPayment — Ortal's decision on one or more receipts.
 * PROXY_SECRET-gated, needs billingControl AND the controller or approver
 * role (handle_ checks the role from the verified session before calling).
 *
 *   body  { ids: ['rcpt-…', …] (1–200) | id, status: 'confirmed' | 'partial'
 *           | 'flagged' | 'reported', flagNote (flagged: 2–300 chars),
 *           confirmedAmount (partial, one id), controlNote (one id, ≤500) }
 *
 * ATOMIC: every id is checked first (exists, is a live receipt with a
 * receivedDate, a partial amount below the reported one); one problem →
 * { ok:false, error, message, id } and NOTHING is written. Only the confirm
 * cells (the four + confirmedAmount / controlNote) move. One AuditLog row
 * per status change and one per note change (at / by / prev / next).
 * → { ok:true, changed:[projected receipts], unchanged:N }
 *
 * status 'duplicate' («כפילות», ONE id, the reason in flagNote 2–300) is
 * not a confirm status: confirmDuplicate_ voids the receipt through the
 * PR #144 void path → { ok:true, changed:[], voided:[{ id, … }], cycle }.
 */
function confirmPayment_(body, user, ctx) {
  const req = confirmRequestClean_(body);
  if (!req.ok) return req;
  if (req.status === DUPLICATE_DECISION) return confirmDuplicate_(req, user, ctx);
  const c = ctx || {};
  const stampUser = String(user == null ? '' : user);
  const auditActor = c.actor === undefined ? stampUser : String(c.actor);
  const lock = LockService.getScriptLock();
  if (lock.tryLock(10000) !== true) return lockBusy_('confirmPayment_');
  try {
    const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(PAYMENTS_SHEET);
    if (!sh || sh.getLastRow() < 2) return Object.assign(confirmError_('not_found'), { id: req.ids[0] });
    const header = sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), 1)).getValues()[0];
    if (paymentReportHeaderClash_(header).length) return confirmError_('sheet_header_clash');
    const grid = sh.getRange(2, 1, sh.getLastRow() - 1, PAYMENT_COLUMNS.length).getValues();
    const idIdx = PAYMENT_COLUMNS.indexOf('id');
    const at = {};
    grid.forEach(function (g, i) { const id = String(g[idIdx] == null ? '' : g[idIdx]).trim(); if (id && !(id in at)) at[id] = i; });
    const nowStamp = israelTimestamp_();
    const plan = [];
    for (let k = 0; k < req.ids.length; k++) {
      const id = req.ids[k];
      if (!(id in at)) return Object.assign(confirmError_('not_found'), { id: id });
      const row = {};
      for (let j = 0; j < PAYMENT_COLUMNS.length; j++) row[PAYMENT_COLUMNS[j]] = grid[at[id]][j];
      const t = confirmTransition_(row, req, stampUser, nowStamp);
      if (t.ok === false) return Object.assign(t, { id: id });
      plan.push({ id: id, index: at[id], row: row, t: t });
    }
    // The two appended columns: refused when a hand-added column sits where
    // they belong; their header names are written when still blank.
    if (paymentControlHeaderClash_(header).length) return confirmError_('sheet_header_clash');
    const first = PAYMENT_COLUMNS.indexOf('confirmStatus');
    const ctlFirst = PAYMENT_COLUMNS.indexOf(PAYMENT_CONTROL_COLUMNS[0]);
    const changed = [];
    let unchanged = 0;
    // The rows already in the asked state (a retry of a decision that landed):
    // answered too, so the caller can prove every id it sent.
    const unchangedRows = [];
    if (plan.some(function (p) { return p.t.changed; })) {
      PAYMENT_CONTROL_COLUMNS.forEach(function (name, k) {
        const i = ctlFirst + k;
        if (i >= header.length || String(header[i] == null ? '' : header[i]).trim() === '') sh.getRange(1, i + 1).setValue(name);
      });
    }
    plan.forEach(function (p) {
      if (!p.t.changed) {
        unchanged++;
        const same = billingControlReceipt_(p.row, '');
        delete same.cycleId;
        unchangedRows.push(same);
        return;
      }
      const cells = p.t.cells;
      setPaymentRowTextCols_(sh, p.index + 2);
      sh.getRange(p.index + 2, first + 1, 1, 4).setValues([[cells.confirmStatus, cells.confirmedBy, cells.confirmedAt, cells.flagNote]]);
      sh.getRange(p.index + 2, ctlFirst + 1, 1, 2).setValues([[cells.confirmedAmount, cells.controlNote]]);
      Object.keys(cells).forEach(function (k) { p.row[k] = cells[k]; });
      const base = {
        paymentId: p.id,
        paymentUid: String(p.row.paymentUid || ''),
        amount: receiptReportedAmount_(p.row),
        by: stampUser,
        at: nowStamp,
      };
      if (p.t.statusChanged) {
        logAudit_('payment_confirm_' + p.t.to, 'confirmPayment_',
          String(p.row.patientUid || ''), String(p.row.patientName || ''), Object.assign({}, base, {
            from: p.t.from,
            to: p.t.to,
            oldFlagNote: p.t.oldNote,
            flagNote: cells.flagNote,
            confirmedAmount: p.t.next.confirmedAmount,
            openAmount: receiptOpenAmount_(p.row),
            prev: { status: p.t.prev.status, confirmedAmount: p.t.prev.confirmedAmount, flagNote: p.t.prev.flagNote },
            next: { status: p.t.next.status, confirmedAmount: p.t.next.confirmedAmount, flagNote: p.t.next.flagNote },
          }), auditActor);
      }
      if (p.t.noteChanged) {
        logAudit_('payment_control_note', 'confirmPayment_',
          String(p.row.patientUid || ''), String(p.row.patientName || ''), Object.assign({}, base, {
            prev: { controlNote: p.t.prev.controlNote },
            next: { controlNote: p.t.next.controlNote },
          }), auditActor);
      }
      // The row as the tab shows it. cycleId is the queue's (the link needs
      // every row), so it is left out here rather than sent blank.
      const proj = billingControlReceipt_(p.row, p.t.to === 'flagged' && p.t.statusChanged ? nowStamp : '');
      delete proj.cycleId;
      changed.push(proj);
    });
    return { ok: true, changed: changed, unchanged: unchanged, unchangedRows: unchangedRows };
  } finally {
    try { lock.releaseLock(); } catch (_) { /* no-op */ }
  }
}

/* action=appendFunder — the patient card's funder editor (finance-gated).
 * Appends ONE Funders row (appendFunder_), setBy from the signed session.
 * → { ok:true, row, current, history } | { ok:false, error, message? } */
function appendFunderAction_(params) {
  const f = parseJsonParam_(params && params.funder) || {};
  const res = appendFunder_(f.patientId, f.funder, f.effectiveFrom,
    { user: requestUser_(params), actor: actorLabel_(params), submissionId: f.submissionId });
  if (!res.ok) {
    if (!res.message) {
      res.message = res.error === 'effective_from_invalid' ? 'תאריך תחילה לא תקין'
        : res.error === 'patient_id_invalid' ? 'מטופל לא מזוהה — יש לשמור את המטופל קודם' : res.message;
    }
    return res;
  }
  const rows = fundersRows_();
  return {
    ok: true, row: res.row, replayed: res.replayed === true,
    current: currentFunderFrom_(rows, res.row.patientId, ''),
    history: fundersHistoryFor_(rows, res.row.patientId),
  };
}

/* Funders rows for the client, effectiveFrom as a bare 'YYYY-MM-DD' (a
 * Date-typed cell never travels as a UTC stamp). Every row with a patient id
 * travels — an unrecognized label too — so the page reads the SAME answer as
 * currentFunderFrom_ (an unrecognized effective row → «לא הוגדר»). PURE. */
function fundersForClient_(rows) {
  return (Array.isArray(rows) ? rows : []).filter(function (r) {
    return r && paymentReportText_(r.patientId);
  }).map(function (r) {
    return {
      patientId: paymentReportText_(r.patientId), funder: paymentReportText_(r.funder),
      effectiveFrom: r.effectiveFrom instanceof Date ? localPartsISO_(r.effectiveFrom) : (paymentReportDate_(r.effectiveFrom) || ''),
      setBy: paymentReportText_(r.setBy), setAt: paymentReportText_(r.setAt),
    };
  });
}

/* A patient's Funders rows, newest effectiveFrom first. PURE. */
function fundersHistoryFor_(rows, patientId) {
  const id = paymentReportText_(patientId);
  return (Array.isArray(rows) ? rows : []).filter(function (r) {
    return r && paymentReportText_(r.patientId) === id && PAYMENT_FUNDERS.indexOf(paymentReportText_(r.funder)) >= 0;
  }).map(function (r) {
    return {
      funder: paymentReportText_(r.funder),
      effectiveFrom: r.effectiveFrom instanceof Date ? localPartsISO_(r.effectiveFrom) : (paymentReportDate_(r.effectiveFrom) || ''),
      setBy: paymentReportText_(r.setBy), setAt: paymentReportText_(r.setAt),
    };
  }).sort(function (a, b) {
    return a.effectiveFrom < b.effectiveFrom ? 1 : a.effectiveFrom > b.effectiveFrom ? -1 : (a.setAt < b.setAt ? 1 : a.setAt > b.setAt ? -1 : 0);
  });
}

/* ===== Credits ledger ===== */

function getCredits_() {
  const perf = perfStart_('getCredits_');
  const sh = sheetForRead_(CREDITS_SHEET, CREDIT_COLUMNS);   // saveCredit re-formats before writing
  let values = sheetValues_(sh, CREDIT_COLUMNS);             // the ONE read of Credits
  perfLap_(perf, 'read');
  // Same one-time, zero-writes-in-steady-state rule; re-read only if healed.
  if (backfillCreditUidsLocked_(sh, values)) values = sheetValues_(sh, CREDIT_COLUMNS);
  perfLap_(perf, 'backfill');
  const credits = rowsFromValues_(values, CREDIT_COLUMNS);
  perfEnd_(perf, 'credits=' + credits.length);
  return { ok: true, credits: credits };
}

/* Deterministic credit id. Mirrors creditId() in app.js (display only there —
 * the SERVER mints every persisted id, under the lock, from the row count). */
function creditId_(patientId, allocationMonth, seq) {
  return 'credit::' + patientId + '::' + allocationMonth + '::' + seq;
}

/* ===== Refund calculation (docs/billing-control-plan.md §8) =====
 * PURE functions: no sheet read or write, no lock. THE source of the refund
 * rules: the suggestRefunds read action (suggestRefunds_ → refundSuggestionsFor_)
 * builds every credit suggestion from computeRefund_, and upsertCredit_
 * derives every payoutDate from refundPayoutDate_. app.js holds no copy of the
 * rules (its payoutDateFor() is a display echo with a parity test).
 * See CHANGELOG-refund-logic-foundation.md, CHANGELOG-refund-logic-wiring.md.
 *
 * Rules (Sandra, 01/10/2026):
 *   - cycle      = the patient's OWN month, anchored on the entry date: cycle k
 *                  starts at entry + k months (day clamped to the target
 *                  month's length: 31 Jan → 28/29 Feb) and ends the day before
 *                  cycle k+1 starts. A recorded coverageStart/coverageEnd wins
 *                  over the derived cycle (plan §8.1).
 *   - rate       = amountPaid / 30 (CREDIT_DAYS_DIVISOR), whatever the cycle's
 *                  length; refund = rate × days not stayed, capped at amountPaid.
 *                  The exit day counts as stayed (entry day is day 1).
 *   - v2, every house (exit on/after REFUND_RULE_V2_FROM, Sandra 07/10/2026):
 *                  exit on STAY day 14 or later (entry day = day 1, counted
 *                  across month boundaries) → 0 for the current cycle; stay
 *                  day 1–13 → pro-rata of the current cycle.
 *   - v1 (exit before REFUND_RULE_V2_FROM), kept for those exits:
 *     residential (asher, ramot): exit within the last 7 days of the cycle
 *                  (cycle end and the 6 days before it) → 0 for that cycle.
 *     detox_dual (rehab, pardes, arfoni, sde): exit on stay day 14 or later
 *                  (entry day = day 1) → 0 for the current cycle.
 *   - a cycle that had not started at the exit → amountPaid back in full, in
 *     every house (prepaid_return).
 *   - payout: decided on or before the 10th → the 15th of that month; after
 *     the 10th → the 15th of the next month (refundPayoutDate_).
 * Dates are Asia/Jerusalem calendar days. Arithmetic is on day numbers
 * (UTC epoch days), so no runtime or sheet timezone can shift a day.
 *
 * TODO(Phase 0b-3, personal PINs): exceptions / write-offs (a refund > 0 where
 * the policy gives 0) are Sandra-only, enforced on the server against the
 * signed-cookie user. Deliberately NO override parameter here until the user
 * can no longer be spoofed. */
const CREDIT_DAYS_DIVISOR             = 30;
const CREDIT_RESIDENTIAL_LAST_DAYS    = 7;
const CREDIT_DETOX_TENURE_CUTOFF_DAYS = 14;   // stay day, entry day = day 1
const CREDIT_DECISION_CUTOFF_DAY      = 10;
const REFUND_MAX_CYCLES               = 1200; // 100 years — a guard, never a real stay
/* Refund rule v2 (Sandra, 07/10/2026 — CHANGELOG-refund-rule-v2.md, plan §8.6):
 * EVERY house — stayDay = exit − entry + 1 (entry day = day 1); stayDay ≥ 14
 * → no refund for the current cycle; stayDay 1–13 → pro-rata of the current
 * cycle. A prepaid cycle that starts after the exit is still returned in full. Selected by the EXIT date: an exit on/after
 * REFUND_RULE_V2_FROM uses v2, an earlier exit keeps the v1 per-house rule
 * above (last 7 days for asher/ramot, stay day 14 for the others). The same
 * rule lives in lib/refund-rules.js (window.RefundRules); the parity test
 * test/refund-rule-v2.test.js runs both over a grid of inputs. */
const REFUND_RULE_V2_FROM             = '2026-10-07';
const REFUND_V2_NO_REFUND_FROM_DAY    = 14;   // stay day, entry day = day 1

/* An Error carrying a machine code. Messages name the field, never a patient. */
function refundError_(code, field) {
  const e = new Error('refund: ' + code + (field ? ' (' + field + ')' : ''));
  e.code = code;
  if (field) e.field = field;
  return e;
}

/* Any accepted date input → 'YYYY-MM-DD' (Asia/Jerusalem calendar day), or
 * throws bad_date. Accepted:
 *   - a Date (a Sheets date cell): formatted in Asia/Jerusalem EXPLICITLY, not
 *     in the spreadsheet's zone — a Jerusalem-midnight cell under a UTC sheet
 *     must stay on its own day (same trap as managerDateIso_);
 *   - a Sheets date serial (the day is exact, no timezone involved);
 *   - a timestamp string with a timezone marker (Z / ±hh:mm) → its Jerusalem day;
 *   - a bare 'YYYY-MM-DD' that is a real calendar date. */
function refundDateIso_(v, field) {
  if (Object.prototype.toString.call(v) === '[object Date]') {
    if (isNaN(v.getTime())) throw refundError_('bad_date', field);
    return Utilities.formatDate(v, 'Asia/Jerusalem', 'yyyy-MM-dd');
  }
  if (typeof v === 'number' && isSheetDateSerial_(v)) return sheetSerialToISODate_(v);
  const s = String(v == null ? '' : v).trim();
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/.test(s)) {
    const d = new Date(s);
    if (isNaN(d.getTime())) throw refundError_('bad_date', field);
    return Utilities.formatDate(d, 'Asia/Jerusalem', 'yyyy-MM-dd');
  }
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) throw refundError_('bad_date', field);
  if (refundIsoFromDayNum_(refundDayNum_(s)) !== s) throw refundError_('bad_date', field);   // 2026-02-30
  return s;
}

/* 'YYYY-MM-DD' ↔ whole days since 1970-01-01 (UTC epoch days: no DST, no zone). */
function refundDayNum_(iso) {
  const p = iso.split('-');
  return Math.round(Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2])) / 86400000);
}
function refundIsoFromDayNum_(n) {
  return new Date(n * 86400000).toISOString().slice(0, 10);
}

/* iso + n months, day CLAMPED to the target month (31 Jan + 1 → 28/29 Feb).
 * Always stepped from the anchor (the entry date), never chained, so a
 * 31 Jan entry gives 28 Feb, then 31 Mar — not 28 Mar. */
function refundAddMonths_(iso, n) {
  const p = iso.split('-');
  const y = Number(p[0]), m0 = Number(p[1]) - 1 + n, d = Number(p[2]);
  const ty = y + Math.floor(m0 / 12), tm = ((m0 % 12) + 12) % 12;
  const last = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
  return ty + '-' + String(tm + 1).padStart(2, '0') + '-' + String(Math.min(d, last)).padStart(2, '0');
}

function refundRound2_(n) {
  return Math.round(n * 100) / 100;
}

/* The refund payout date for a decision date. Decided on the 1st–10th → the
 * 15th of that month; the 11th onward → the 15th of the next month (December
 * rolls into January of the next year). Throws bad_date on an unreadable date.
 * Replaced payoutDateFor_ (cutoff on the 15th) in the wiring PR. */
function refundPayoutDate_(decided) {
  const iso = refundDateIso_(decided, 'decidedDate');
  let y = Number(iso.slice(0, 4)), mo = Number(iso.slice(5, 7));
  if (Number(iso.slice(8, 10)) > CREDIT_DECISION_CUTOFF_DAY) { mo += 1; if (mo > 12) { mo = 1; y += 1; } }
  return y + '-' + String(mo).padStart(2, '0') + '-' + String(CREDIT_PAYOUT_DAY).padStart(2, '0');
}

/* 2 when the exit ('YYYY-MM-DD') is on/after REFUND_RULE_V2_FROM, else 1.
 * Same as lib/refund-rules.js refundRuleVersion (parity-tested). */
function refundRuleVersion_(exitIso) {
  const s = String(exitIso == null ? '' : exitIso);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw refundError_('bad_date', 'exitDate');
  return s >= REFUND_RULE_V2_FROM ? 2 : 1;
}

/* Pure. The rule for the cycle that holds the exit (cycleStart ≤ exit ≤
 * cycleEnd), picked by the exit date. Same as lib/refund-rules.js
 * currentCycleRule (parity-tested).
 * x: { facilityType, entryDate, exitDate, cycleStart, cycleEnd } — ISO days.
 * → { ruleVersion, rule, stayDay, lastDaysFrom, lastDaysTo, refundDue } */
function refundCurrentCycleRule_(x) {
  const o = x || {};
  const version = refundRuleVersion_(o.exitDate);
  const entryN = refundDayNum_(o.entryDate), exitN = refundDayNum_(o.exitDate);
  const endN = refundDayNum_(o.cycleEnd);
  const stayDay = exitN - entryN + 1;
  let rule, lastDaysFrom = '', lastDaysTo = '';
  if (version === 2) {
    rule = stayDay >= REFUND_V2_NO_REFUND_FROM_DAY ? 'stay_day14_zero' : 'stay_prorata';
  } else if (o.facilityType === 'residential') {
    const fromN = endN - (CREDIT_RESIDENTIAL_LAST_DAYS - 1);
    lastDaysFrom = refundIsoFromDayNum_(fromN);
    lastDaysTo = refundIsoFromDayNum_(endN);
    rule = exitN >= fromN ? 'residential_last_days_zero' : 'residential_prorata';
  } else if (o.facilityType === 'detox_dual') {
    rule = stayDay >= CREDIT_DETOX_TENURE_CUTOFF_DAYS ? 'detox_tenure_cutoff_zero' : 'detox_prorata';
  } else {
    throw refundError_('unknown_house', 'houseId');
  }
  return {
    ruleVersion: version, rule: rule, stayDay: stayDay,
    lastDaysFrom: lastDaysFrom, lastDaysTo: lastDaysTo,
    refundDue: rule === 'stay_prorata' || rule === 'residential_prorata' || rule === 'detox_prorata',
  };
}

/* Pure. The refund for ONE paid billing cycle of a discharged patient, with
 * the full breakdown. Throws (err.code) on any bad input — never a silent 0.
 *
 * input:
 *   houseId      — Patients-sheet house id; unknown → unknown_house
 *   entryDate    — first day of the stay (day 1)
 *   exitDate     — last day of the stay (counts as stayed); before entry → exit_before_entry
 *   amountPaid   — VAT-inclusive ₪ received for this cycle, ≥ 0 → else bad_amount
 *   decidedDate  — the day the refund is decided (drives payoutDate)
 *   cycleStart   — optional: which cycle, as its start date. Must be an
 *                  entry-anchored cycle start (else cycle_not_aligned).
 *                  Omitted → the cycle that contains the exit.
 *   coverageStart / coverageEnd — optional, together: the period the payment
 *                  row RECORDS. Wins over the derived cycle (plan §8.1).
 *
 * output: { houseId, facilityType, entryDate, exitDate, stayDay, cycleStart,
 *   cycleEnd, cycleSource, cycleDays, daysStayed, daysNotStayed, divisor,
 *   amountPaid, dailyRate, uncappedRefund, capped, lastDaysFrom, lastDaysTo,
 *   rule, creditType, refund, ruleVersion, decidedDate, payoutDate }
 *   rule ∈ stay_prorata | stay_day14_zero (v2) |
 *          residential_prorata | residential_last_days_zero | detox_prorata |
 *          detox_tenure_cutoff_zero (v1) | prepaid_return | cycle_fully_used
 *   ruleVersion — 2 / 1 by the exit date (refundRuleVersion_); stayDay is the
 *   v2 deciding figure; lastDaysFrom/To only for a v1 residential stay.
 *   refund is computed from the unrounded rate; dailyRate is rounded for display. */
function computeRefund_(input) {
  const x = input || {};
  const houseId = String(x.houseId == null ? '' : x.houseId).trim();
  const facilityType = facilityTypeFor_(houseId);
  if (!facilityType) throw refundError_('unknown_house', 'houseId');

  const entryDate = refundDateIso_(x.entryDate, 'entryDate');
  const exitDate = refundDateIso_(x.exitDate, 'exitDate');
  const decidedDate = refundDateIso_(x.decidedDate, 'decidedDate');
  const entryN = refundDayNum_(entryDate), exitN = refundDayNum_(exitDate);
  if (exitN < entryN) throw refundError_('exit_before_entry', 'exitDate');

  if (x.amountPaid === '' || x.amountPaid === null || x.amountPaid === undefined || typeof x.amountPaid === 'boolean') {
    throw refundError_('bad_amount', 'amountPaid');
  }
  const paidNum = Number(x.amountPaid);
  if (!isFinite(paidNum) || paidNum < 0) throw refundError_('bad_amount', 'amountPaid');
  const amountPaid = refundRound2_(paidNum);

  // The cycle: recorded coverage, else entry-anchored (given, or the one holding the exit).
  let cycleStart, cycleEnd, cycleSource;
  const hasCovStart = !(x.coverageStart === '' || x.coverageStart == null);
  const hasCovEnd = !(x.coverageEnd === '' || x.coverageEnd == null);
  if (hasCovStart || hasCovEnd) {
    if (!hasCovStart || !hasCovEnd) throw refundError_('coverage_incomplete', hasCovStart ? 'coverageEnd' : 'coverageStart');
    cycleStart = refundDateIso_(x.coverageStart, 'coverageStart');
    cycleEnd = refundDateIso_(x.coverageEnd, 'coverageEnd');
    if (refundDayNum_(cycleEnd) < refundDayNum_(cycleStart)) throw refundError_('bad_coverage', 'coverageEnd');
    cycleSource = 'recorded_coverage';
  } else {
    const wanted = (x.cycleStart === '' || x.cycleStart == null) ? null : refundDayNum_(refundDateIso_(x.cycleStart, 'cycleStart'));
    const target = wanted === null ? exitN : wanted;
    let k = -1;
    for (let i = 0; i <= REFUND_MAX_CYCLES; i++) {
      const s = refundDayNum_(refundAddMonths_(entryDate, i));
      if (s > target) break;
      if (wanted === null || s === wanted) k = i;
      if (s === target) break;
    }
    if (k < 0 || (wanted !== null && refundDayNum_(refundAddMonths_(entryDate, k)) !== wanted)) {
      throw refundError_(wanted === null ? 'cycle_out_of_range' : 'cycle_not_aligned', wanted === null ? 'exitDate' : 'cycleStart');
    }
    cycleStart = refundAddMonths_(entryDate, k);
    cycleEnd = refundIsoFromDayNum_(refundDayNum_(refundAddMonths_(entryDate, k + 1)) - 1);
    cycleSource = 'entry_anchored';
  }
  const startN = refundDayNum_(cycleStart), endN = refundDayNum_(cycleEnd);
  const cycleDays = endN - startN + 1;
  const stayDay = exitN - entryN + 1;
  const rate = amountPaid / CREDIT_DAYS_DIVISOR;
  const ruleVersion = refundRuleVersion_(exitDate);
  // v1 residential only: the cycle's last 7 days, recorded in the breakdown.
  const showLastDays = ruleVersion === 1 && facilityType === 'residential';
  const lastDaysFromN = endN - (CREDIT_RESIDENTIAL_LAST_DAYS - 1);

  let daysStayed, daysNotStayed, rule, creditType = 'days_unused', uncapped, refund;
  if (startN > exitN) {
    // Prepaid and not started at the exit: unearned in full, in every house.
    daysStayed = 0; daysNotStayed = cycleDays;
    rule = 'prepaid_return'; creditType = 'prepaid_return';
    uncapped = amountPaid; refund = amountPaid;
  } else if (endN < exitN) {
    // Ended before the exit: fully used.
    daysStayed = cycleDays; daysNotStayed = 0;
    rule = 'cycle_fully_used'; uncapped = 0; refund = 0;
  } else {
    // The current cycle: the facility rule applies.
    daysStayed = exitN - startN + 1; daysNotStayed = endN - exitN;
    uncapped = refundRound2_(rate * daysNotStayed);
    const prorata = Math.min(uncapped, amountPaid);
    const cur = refundCurrentCycleRule_({
      facilityType: facilityType, entryDate: entryDate, exitDate: exitDate, cycleStart: cycleStart, cycleEnd: cycleEnd,
    });
    rule = cur.rule;
    refund = cur.refundDue ? prorata : 0;
  }

  return {
    houseId: houseId, facilityType: facilityType,
    entryDate: entryDate, exitDate: exitDate, stayDay: stayDay,
    cycleStart: cycleStart, cycleEnd: cycleEnd, cycleSource: cycleSource, cycleDays: cycleDays,
    daysStayed: daysStayed, daysNotStayed: daysNotStayed,
    divisor: CREDIT_DAYS_DIVISOR, amountPaid: amountPaid, dailyRate: refundRound2_(rate),
    uncappedRefund: uncapped, capped: uncapped > amountPaid,
    lastDaysFrom: showLastDays ? refundIsoFromDayNum_(lastDaysFromN) : '',
    lastDaysTo: showLastDays ? cycleEnd : '',
    rule: rule, creditType: creditType, refund: refund,
    ruleVersion: ruleVersion,
    decidedDate: decidedDate, payoutDate: refundPayoutDate_(decidedDate),
  };
}

/* ===== Refund suggestions for a discharge (the live path) =====
 * Pure. Every credit suggestion the credits modal offers, built from
 * computeRefund_ over the patient's Payments rows — the server is the only
 * place the rules live (CHANGELOG-refund-logic-wiring.md).
 *
 * input: { houseId, entryDate, exitDate, patientKey } — patientKey is the
 *   'houseId::name::entryDate' triple that keys Payments.patientId.
 * rows: raw Payments rows (readSheet_ objects). A row belongs to the patient
 *   when its patientId cell — or, when blank, the triple inside its
 *   'pay::h::n::d::due' id (the normalizePayment() rule) — equals patientKey.
 *   VOID rows are skipped (a double entry is not money).
 * todayIso: the decision day (Asia/Jerusalem).
 *
 * Per row, in dueDate order, its window is:
 *   - the RECORDED coverageStart/coverageEnd when both are usable;
 *   - else the entry-anchored cycle starting on dueDate;
 *   - else (a dueDate that is not a cycle start) dueDate … dueDate + 1 month − 1.
 * computeRefund_ decides the rule and the figure. A window that ended before
 * the exit produces nothing. Days already credited by an earlier row's window
 * are never credited twice (alreadyCreditedThrough). When no row yields a
 * days_unused line, ONE zero days_unused line is still returned — "no refund
 * owed" is a recorded decision — from the latest used row, else from the
 * cycle that holds the exit with nothing paid.
 *
 * Each suggestion: { creditType, allocationMonth, calculatedAmount, basis }.
 * basis = computeRefund_'s breakdown (basisVersion 2) plus the fields the
 * revenue screen allocates by (coverageStart, coverageEnd, creditedFrom).
 * Throws (err.code) on any bad input — never a silent 0. */
function refundSuggestionsFor_(input, rows, todayIso) {
  // Receipts are not cycles; each cycle's amountPaid is derived (Phase 3 PR 2).
  rows = paymentCyclesDerived_(rows);
  const x = input || {};
  const key = String(x.patientKey == null ? '' : x.patientKey);
  if (!key) throw refundError_('missing_patientKey', 'patientKey');
  const base = { houseId: x.houseId, entryDate: x.entryDate, exitDate: x.exitDate, decidedDate: todayIso };
  // Validates house and dates up front, and is the "nothing paid" fallback.
  const probe = computeRefund_(Object.assign({}, base, { amountPaid: 0 }));
  const exitN = refundDayNum_(probe.exitDate);
  const tryIso = function (v) { try { return refundDateIso_(v, 'date'); } catch (_) { return ''; } };
  const rowKey = function (r) {
    const pid = String(r.patientId == null ? '' : r.patientId);
    if (pid) return pid;
    const parts = String(r.id == null ? '' : r.id).split('::');
    return parts.length === 5 && parts[0] === 'pay' ? parts.slice(1, 4).join('::') : '';
  };

  const mine = (Array.isArray(rows) ? rows : [])
    .filter(function (r) { return r && rowKey(r) === key && !isVoidStatus_(r.status); })
    .map(function (r) { return { r: r, due: tryIso(r.dueDate) }; })
    .filter(function (o) { return o.due !== ''; })
    .sort(function (a, b) { return a.due < b.due ? -1 : a.due > b.due ? 1 : 0; });

  const out = [];
  let creditedThroughN = null;
  let latestUsed = null;
  mine.forEach(function (o) {
    const r = o.r;
    const amountPaid = (r.amountPaid === '' || r.amountPaid == null) ? 0 : r.amountPaid;
    const one = Object.assign({}, base, { amountPaid: amountPaid });
    const cs = tryIso(r.coverageStart), ce = tryIso(r.coverageEnd);
    let b, windowSource;
    if (cs && ce && refundDayNum_(ce) >= refundDayNum_(cs)) {
      b = computeRefund_(Object.assign(one, { coverageStart: cs, coverageEnd: ce }));
      windowSource = 'recorded';
    } else {
      try {
        b = computeRefund_(Object.assign({}, one, { cycleStart: o.due }));
        windowSource = 'inferred';
      } catch (e) {
        if (!e || e.code !== 'cycle_not_aligned') throw e;
        const end = refundIsoFromDayNum_(refundDayNum_(refundAddMonths_(o.due, 1)) - 1);
        b = computeRefund_(Object.assign({}, one, { coverageStart: o.due, coverageEnd: end }));
        windowSource = 'due_date';
      }
    }
    const extra = { paymentDueDate: o.due, billedAmount: refundRound2_(Number(r.amount) || 0), coverageWindowSource: windowSource };
    if (b.rule === 'cycle_fully_used') { latestUsed = { b: b, extra: extra, due: o.due }; return; }
    if (b.rule === 'prepaid_return') {
      out.push(refundSuggestion_(b, Object.assign(extra, { creditedDays: b.daysNotStayed, creditedFrom: '', alreadyCreditedThrough: '' }), o.due.slice(0, 7)));
      return;
    }
    // The cycle that holds the exit: days after the exit, minus any day an
    // earlier window already credited.
    latestUsed = { b: b, extra: extra, due: o.due };
    const endN = refundDayNum_(b.cycleEnd);
    const fromN = Math.max(exitN, creditedThroughN === null ? exitN : creditedThroughN) + 1;
    const creditedDays = Math.max(0, endN - fromN + 1);
    const already = creditedThroughN !== null && creditedThroughN > exitN ? refundIsoFromDayNum_(creditedThroughN) : '';
    if (creditedDays > 0) creditedThroughN = endN;
    const adj = Object.assign({}, b);
    if (creditedDays !== b.daysNotStayed && b.refund > 0) {
      adj.refund = Math.min(refundRound2_(b.amountPaid / CREDIT_DAYS_DIVISOR * creditedDays), b.amountPaid);
    }
    out.push(refundSuggestion_(adj, Object.assign(extra, {
      creditedDays: creditedDays,
      creditedFrom: creditedDays > 0 ? refundIsoFromDayNum_(fromN) : '',
      alreadyCreditedThrough: already,
    }), o.due.slice(0, 7)));
  });

  if (!out.some(function (s) { return s.creditType === 'days_unused'; })) {
    const zero = latestUsed
      ? refundSuggestion_(Object.assign({}, latestUsed.b, { refund: 0 }),
          Object.assign({}, latestUsed.extra, { creditedDays: 0, creditedFrom: '', alreadyCreditedThrough: '' }), latestUsed.due.slice(0, 7))
      : refundSuggestion_(probe, { paymentDueDate: '', billedAmount: 0, coverageWindowSource: 'no_payment_row',
          creditedDays: 0, creditedFrom: '', alreadyCreditedThrough: '' }, probe.exitDate.slice(0, 7));
    zero.creditType = 'days_unused';
    zero.basis.creditType = 'days_unused';
    out.unshift(zero);
  }
  return out;
}

/* One suggestion from a computeRefund_ breakdown + the row's extras. */
function refundSuggestion_(b, extra, allocationMonth) {
  const basis = Object.assign({ basisVersion: 2 }, b, extra, {
    coverageStart: b.cycleStart,
    coverageEnd:   b.cycleEnd,
    unusedDays:    extra.creditedDays,
    eligible:      b.rule === 'residential_prorata' || b.rule === 'detox_prorata' || b.rule === 'stay_prorata' || b.rule === 'prepaid_return',
  });
  return { creditType: b.creditType, allocationMonth: allocationMonth, calculatedAmount: b.refund, basis: basis };
}

/* action=suggestRefunds — READ-ONLY. Reads the Payments sheet (never creates
 * it, never backfills, no lock) and returns the suggestions for one
 * discharge. Gated by PROXY_SECRET (not in OPEN_ACTIONS).
 * → { ok:true, decidedDate, payoutDate, facilityType, suggestions }
 *   | { ok:false, error:<code>, field } — e.g. unknown_house. The error names
 *   a field, never a patient. */
function suggestRefunds_(params) {
  const p = params || {};
  try {
    const today = Utilities.formatDate(new Date(), 'Asia/Jerusalem', 'yyyy-MM-dd');
    const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(PAYMENTS_SHEET);
    const rows = sh ? readSheet_(sh, PAYMENT_COLUMNS) : [];
    const input = {
      houseId:    creditStr_(p.houseId, 40),
      entryDate:  creditStr_(p.entryDate, 40),
      exitDate:   creditStr_(p.exitDate, 40),
      patientKey: String(p.patientKey == null ? '' : p.patientKey).slice(0, 300),
    };
    const suggestions = refundSuggestionsFor_(input, rows, today);
    return {
      ok: true, decidedDate: today, payoutDate: refundPayoutDate_(today),
      facilityType: facilityTypeFor_(input.houseId), suggestions: suggestions,
    };
  } catch (e) {
    if (e && e.code) return { ok: false, error: e.code, field: e.field || '' };
    return { ok: false, error: 'refund_failed' };
  }
}

/* The payoutDate a credit save writes. A CREATE, or an edit that changes the
 * decision date, gets refundPayoutDate_(decidedDate) — the 10th cutoff. An
 * edit that keeps the stored decidedDate keeps the stored payoutDate, so a
 * credit decided under the old 15th cutoff is never re-dated by a re-save
 * (saved credits are not recalculated). */
function creditPayoutDate_(decidedDate, existing) {
  if (existing && existing.payoutDate && existing.decidedDate === decidedDate) return existing.payoutDate;
  return refundPayoutDate_(decidedDate);
}

/* ===== Refund payout forecast (CHANGELOG-refund-payout-forecast.md) =====
 * READ-ONLY. What the bookkeeper needs before each 15th, in three sections
 * that are NEVER summed together:
 *   decided              — saved credits, status 'pending', amount > 0, grouped
 *                          by the STORED payoutDate (never recomputed);
 *   awaiting_decision    — discharges (exit on/after the records cutoff) with
 *                          NO saved credit for that stay, where the server's
 *                          suggestion (refundSuggestionsFor_ → computeRefund_)
 *                          totals > 0. NOT money to pay — a decision to make;
 *   missing_payment_data — discharges (same cutoff) with no saved credit and NO
 *                          recorded payment covering the exit cycle, whose
 *                          suggestion would be 0 only for lack of data. They
 *                          carry no amount at all — never a 0. A discharge
 *                          whose EXIT CYCLE started before the records cutoff
 *                          is left out (records before it were never entered,
 *                          so it is neither debt nor a refund question) and
 *                          only counted in preCutoffExcludedCount.
 * Plus `unresolved` (a discharge the rules refused, e.g. unknown_house — an
 * error code, never a 0) and zeroByPolicyCount (discharges whose suggestion is
 * a real, data-backed 0; counted, not listed).
 *
 * A credit belongs to a stay when its patientKey triple equals the discharge's
 * (house, trimmed name, Jerusalem entry day). Any saved row — pending, paid,
 * cancelled, zero — means the stay is decided. Restored discharges are not
 * discharges. Pure: no sheet access, no clock. */
const REFUND_FORECAST_MISSING_NOTE = 'אין תשלום רשום — לבדוק';

function refundForecastIso_(v) {
  try { return refundDateIso_(v, 'date'); } catch (_) { return ''; }
}
function refundForecastKey_(houseId, name, entryIso) {
  return String(houseId == null ? '' : houseId).trim() + '::' +
         String(name == null ? '' : name).trim() + '::' + entryIso;
}
/* A stored 'house::name::entry' reduced the same way (trimmed name, ISO day). */
function refundForecastStoredKey_(k) {
  const parts = String(k == null ? '' : k).split('::');
  if (parts.length !== 3) return '';
  return refundForecastKey_(parts[0], parts[1], refundForecastIso_(parts[2]) || parts[2].trim());
}
/* The rule a saved credit was decided under (from its stored basis). */
function refundForecastRule_(c) {
  const raw = c && c.basis;
  let b = raw;
  if (typeof raw === 'string') { try { b = JSON.parse(raw); } catch (_) { b = null; } }
  return (b && typeof b === 'object' && b.rule) ? String(b.rule) : String((c && c.creditType) || '');
}
/* Totals per payoutDate and per house for one section. */
function refundForecastTotals_(rows, dateField, amountField) {
  const byDate = {}, byHouse = {};
  let total = 0;
  rows.forEach(function (r) {
    const amt = Number(r[amountField]) || 0;
    const d = r[dateField] || '';
    if (!byDate[d]) byDate[d] = { payoutDate: d, total: 0, count: 0, rows: [] };
    byDate[d].total = refundRound2_(byDate[d].total + amt); byDate[d].count++; byDate[d].rows.push(r);
    const h = r.houseId || '';
    if (!byHouse[h]) byHouse[h] = { houseId: h, total: 0, count: 0 };
    byHouse[h].total = refundRound2_(byHouse[h].total + amt); byHouse[h].count++;
    total = refundRound2_(total + amt);
  });
  const sortKeys = function (o) { return Object.keys(o).sort(); };
  return {
    count: rows.length, total: total,
    byPayoutDate: sortKeys(byDate).map(function (k) { return byDate[k]; }),
    byHouse: sortKeys(byHouse).map(function (k) { return byHouse[k]; }),
  };
}

/* The start of the cycle that holds the exit, from debtAging_'s own cycle
 * helper (recCycleDueDates_: entry-anchored, none on/after the exit), so both
 * engines agree on which cycle it is. A stay that ends inside its first cycle
 * (or on its entry day) starts that cycle on the entry day. */
function refundForecastExitCycleStart_(entryIso, exitIso) {
  const dues = recCycleDueDates_({ date: entryIso, exitDate: exitIso }, exitIso);
  return dues.length ? dues[dues.length - 1] : entryIso;
}

function refundPayoutForecastFor_(discharged, credits, payments, todayIso) {
  // Receipts are not cycles; each cycle's amountPaid is derived (Phase 3 PR 2).
  payments = paymentCyclesDerived_(payments);
  const today = refundDateIso_(todayIso, 'today');
  const cutoff = recRecordsCutoff_();
  const creditList = Array.isArray(credits) ? credits : [];

  // a. decided — the stored payoutDate, as stored.
  const decidedRows = [];
  creditList.forEach(function (c) {
    if (!c || String(c.status == null ? '' : c.status).trim() !== 'pending') return;
    const amount = Number(c.amount);
    if (!isFinite(amount) || amount <= 0) return;
    const pd = c.payoutDate;
    const payoutDate = Object.prototype.toString.call(pd) === '[object Date]'
      ? refundForecastIso_(pd) : String(pd == null ? '' : pd).trim();
    decidedRows.push({
      creditId: String(c.id || ''), patientName: String(c.patientName || ''), houseId: String(c.houseId || ''),
      amount: refundRound2_(amount), decidedDate: refundForecastIso_(c.decidedDate) || String(c.decidedDate || ''),
      payoutDate: payoutDate, rule: refundForecastRule_(c), creditType: String(c.creditType || ''),
      overrideReason: String(c.overrideReason || ''),
    });
  });

  // Stays that already hold a saved credit (any status, any amount).
  const decidedKeys = {};
  creditList.forEach(function (c) {
    const k = c && refundForecastStoredKey_(c.patientKey);
    if (k) decidedKeys[k] = true;
  });

  // One discharge per stay (the latest exit), restored ones excluded.
  const stays = {};
  (Array.isArray(discharged) ? discharged : []).forEach(function (d) {
    if (!d || diagIsRestored_(d.restored) || dischargeRowDeleted_(d)) return;
    const exitIso = refundForecastIso_(d.exitDate) || refundForecastIso_(d.dischargedAt);
    const entryIso = refundForecastIso_(d.date);
    const name = String(d.name == null ? '' : d.name).trim();
    const houseId = String(d.houseId == null ? '' : d.houseId).trim();
    if (exitIso && exitIso < cutoff) return;            // before the records cutoff
    const key = refundForecastKey_(houseId, name, entryIso);
    const prev = stays[key];
    if (!prev || (exitIso && exitIso > prev.exitDate)) {
      stays[key] = { key: key, patientName: name, houseId: houseId, entryDate: entryIso, exitDate: exitIso };
    }
  });

  const payoutIfToday = refundPayoutDate_(today);
  const awaitingRows = [], missingRows = [], unresolvedRows = [];
  let zeroByPolicyCount = 0, preCutoffExcludedCount = 0;
  Object.keys(stays).sort().forEach(function (k) {
    const s = stays[k];
    if (decidedKeys[k]) return;
    const ident = { patientName: s.patientName, houseId: s.houseId, entryDate: s.entryDate, exitDate: s.exitDate };
    if (!s.exitDate || !s.entryDate) {
      unresolvedRows.push(Object.assign(ident, { error: 'bad_date' }));
      return;
    }
    let sugg;
    try {
      sugg = refundSuggestionsFor_({ houseId: s.houseId, entryDate: s.entryDate, exitDate: s.exitDate, patientKey: k }, payments, today);
    } catch (e) {
      unresolvedRows.push(Object.assign(ident, { error: (e && e.code) || 'refund_failed' }));
      return;
    }
    const positive = sugg.filter(function (x) { return (Number(x.calculatedAmount) || 0) > 0; });
    const total = refundRound2_(positive.reduce(function (t, x) { return t + Number(x.calculatedAmount); }, 0));
    if (total > 0) {
      const rules = [];
      positive.forEach(function (x) { const r = x.basis && x.basis.rule; if (r && rules.indexOf(r) < 0) rules.push(r); });
      awaitingRows.push(Object.assign(ident, { suggestedAmount: total, rule: rules.join(','), payoutDate: payoutIfToday }));
      return;
    }
    // A recorded payment covers the exit cycle when a real row (amountPaid > 0)
    // produced the line for the cycle that holds the exit.
    const covered = sugg.some(function (x) {
      const b = x.basis || {};
      return b.coverageWindowSource !== 'no_payment_row' && (Number(b.amountPaid) || 0) > 0 &&
        b.rule !== 'prepaid_return' && b.rule !== 'cycle_fully_used';
    });
    if (covered) { zeroByPolicyCount++; return; }
    // Records before the cutoff were never entered: an exit cycle that started
    // before it is not debt (debtAging_ skips it with the same recBeforeCutoff_
    // test) and not a refund question. Counted, never listed.
    if (recBeforeCutoff_(refundForecastExitCycleStart_(s.entryDate, s.exitDate), cutoff)) {
      preCutoffExcludedCount++;
      return;
    }
    missingRows.push(Object.assign(ident, { note: REFUND_FORECAST_MISSING_NOTE }));
  });

  return {
    ok: true, today: today, recordsCutoff: cutoff, payoutDateIfDecidedToday: payoutIfToday,
    decided: refundForecastTotals_(decidedRows, 'payoutDate', 'amount'),
    awaiting_decision: refundForecastTotals_(awaitingRows, 'payoutDate', 'suggestedAmount'),
    missing_payment_data: { count: missingRows.length, rows: missingRows },
    unresolved: { count: unresolvedRows.length, rows: unresolvedRows },
    zeroByPolicyCount: zeroByPolicyCount,
    preCutoffExcludedCount: preCutoffExcludedCount,
  };
}

/* action=refundPayoutForecast — READ-ONLY. Reads Credits, the discharged tab
 * and Payments with getSheetByName (never creates a sheet, never backfills,
 * no lock, no audit row). Gated by PROXY_SECRET (not in OPEN_ACTIONS). */
function refundPayoutForecast_() {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const read = function (name, cols) { const sh = ss.getSheetByName(name); return sh ? readSheet_(sh, cols) : []; };
    const now = new Date();
    const out = refundPayoutForecastFor_(
      read(DISCHARGED_PATIENTS_SHEET, DISCHARGED_PATIENT_COLUMNS),
      read(CREDITS_SHEET, CREDIT_COLUMNS),
      read(PAYMENTS_SHEET, PAYMENT_COLUMNS),
      Utilities.formatDate(now, 'Asia/Jerusalem', 'yyyy-MM-dd'));
    out.generatedAt = now.toISOString();
    return out;
  } catch (e) {
    return { ok: false, error: (e && e.code) || 'forecast_failed' };
  }
}

/* ===== Debt aging, as of any date (READ-ONLY foundation) =====
 * CHANGELOG-debt-aging-foundation.md. No UI, no write, no lock, no audit row.
 *
 * As of a date D (default: today, Asia/Jerusalem):
 *   - a cycle counts when it STARTED on or before D and on or after the
 *     records cutoff (recRecordsCutoff_, 2026-07-01);
 *   - money counts when it was RECEIVED on or before D: the row's
 *     receivedDate (Phase 3, the day the money arrived) when it has one,
 *     else chargedAt (the moment it was reported paid, server-stamped —
 *     the legacy rule; debtAgingReceivedOn_). A paid row with neither
 *     (written before the columns existed) is dated to its cycle start and
 *     counted in receivedDateUnknown, never silently.
 *
 * Two figures, NEVER summed (no field adds them):
 *   recorded_debt     — cycles with a Payments row still short at D
 *                       (balance = expected − received by D);
 *   unrecorded_cycles — cycles with NO Payments row: the expected amount,
 *                       "unpaid, or paid and not entered".
 *
 * Reused, not re-implemented: recModel_ (normalizing + the four-tier
 * payment→patient match), recCycleDueDates_ (entry-anchored cycle starts,
 * clamped, bounded by entry / exit / D), recStayCovers_, recExitISO_,
 * recApplyOverride_ (BillingOverrides), recBeforeCutoff_, refundAddMonths_
 * (the computeRefund_ clamp) for cycle ends.
 *
 * Amounts are VAT-inclusive, as stored. Credits are reported beside the debt
 * (pending at D, per house), never subtracted from it. */
const DEBT_AGING_BUCKETS = [
  { key: 'd0_7',     from: 0,  to: 7 },
  { key: 'd8_30',    from: 8,  to: 30 },
  { key: 'd31_60',   from: 31, to: 60 },
  { key: 'd61_plus', from: 61, to: null },
];
const DEBT_UNRECORDED_NOTE = 'לא שולם, או ששולם ולא הוזן';

/* The as-of date: blank → today in Asia/Jerusalem; else a bare 'YYYY-MM-DD'
 * naming a real calendar day. Anything else throws bad_asOf. */
function debtAgingAsOf_(raw) {
  if (raw === undefined || raw === null || raw === '') {
    return Utilities.formatDate(new Date(), 'Asia/Jerusalem', 'yyyy-MM-dd');
  }
  if (typeof raw !== 'string') throw refundError_('bad_asOf', 'asOf');
  const s = raw.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw refundError_('bad_asOf', 'asOf');
  if (refundIsoFromDayNum_(refundDayNum_(s)) !== s) throw refundError_('bad_asOf', 'asOf');   // 2026-02-30
  return s;
}

/* Days from the cycle start to D → bucket key. */
function debtAgingBucket_(days) {
  for (let i = 0; i < DEBT_AGING_BUCKETS.length; i++) {
    const b = DEBT_AGING_BUCKETS[i];
    if (days >= b.from && (b.to === null || days <= b.to)) return b.key;
  }
  return '';
}

function debtAgingEmpty_() {
  const o = { count: 0, total: 0 };
  DEBT_AGING_BUCKETS.forEach(function (b) { o[b.key] = 0; });
  return o;
}
function debtAgingAdd_(acc, bucket, amount) {
  acc[bucket] = refundRound2_(acc[bucket] + amount);
  acc.total = refundRound2_(acc.total + amount);
  acc.count++;
}

/* The end of the cycle that starts on startIso: the entry-anchored cycle end
 * (the computeRefund_ clamp: entry + k + 1 months − 1 day) when startIso is
 * an entry-anchored cycle start, else startIso + 1 month − 1 day. */
function debtAgingCycleEnd_(entryIso, startIso) {
  const k = (Number(startIso.slice(0, 4)) - Number(entryIso.slice(0, 4))) * 12 +
            (Number(startIso.slice(5, 7)) - Number(entryIso.slice(5, 7)));
  const base = (k >= 0 && refundAddMonths_(entryIso, k) === startIso) ? refundAddMonths_(entryIso, k + 1) : refundAddMonths_(startIso, 1);
  return refundIsoFromDayNum_(refundDayNum_(base) - 1);
}

/* When a row's money was received. `raw` is the Payments row object.
 *   1. receivedDate (Phase 3: the day the money actually arrived, set once);
 *   2. else chargedAt's Jerusalem day — the legacy rule. chargedAt is
 *      re-stamped whenever amountPaid moves, so for a row topped up later it
 *      is the day of the LAST change, which made a historical as-of overstate
 *      the debt;
 *   3. else unknown, dated to fallbackIso (the cycle start).
 * `source` says which one answered. */
function debtAgingReceivedOn_(raw, fallbackIso) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const rd = r.receivedDate instanceof Date ? refundForecastIso_(r.receivedDate) : paymentReportDate_(r.receivedDate);
  if (rd) return { iso: rd, known: true, source: 'receivedDate' };
  const iso = refundForecastIso_(r.chargedAt);
  return iso ? { iso: iso, known: true, source: 'chargedAt' } : { iso: fallbackIso, known: false, source: '' };
}

/* How much of a cycle's money had arrived by asOf. PURE.
 *   prow  the cycle's tab row ({ obj, receipts?, derived? } — paymentTabsDerived_)
 *   pay   recPayment_(prow) (its amountPaid is the derived total)
 * A cycle WITH receipts: its legacy part (legacyAmountPaid) dated as before
 * (debtAgingReceivedOn_ of the cycle row), plus every live receipt whose own
 * receivedDate is on or before asOf — so a partial payment topped up later
 * is owed exactly the top-up between the two dates. A cycle without
 * receipts: the PR 1 rule, unchanged.
 * → { received, known, source, unknownAmount } */
function debtAgingReceivedBy_(prow, pay, asOf, fallbackIso) {
  const p = prow || {};
  const raw = p.obj || {};
  if (p.receipts && p.derived) {
    let received = 0, unknownAmount = 0;
    const legacy = refundRound2_(Number(p.derived.legacyAmountPaid) || 0);
    let known = true;
    if (legacy > 0) {
      const g = debtAgingReceivedOn_(raw, fallbackIso);
      if (!g.known) { unknownAmount = legacy; known = false; }
      if (g.iso <= asOf) received = refundRound2_(received + legacy);
    }
    p.derived.received.forEach(function (r) {
      if (r.date && r.date <= asOf) received = refundRound2_(received + r.amount);
    });
    return { received: received, known: known, source: 'receipts', unknownAmount: unknownAmount };
  }
  const got = debtAgingReceivedOn_(raw, fallbackIso);
  const paid = refundRound2_(pay.amountPaid);
  return {
    received: got.iso <= asOf ? paid : 0, known: got.known, source: got.source,
    unknownAmount: !got.known && paid > 0 ? paid : 0,
  };
}

/* Pure. tabs = recCollect_'s shape ({ patients, payments, credits, overrides },
 * each { rows: [{ rowNumber, obj }] }); a missing tab reads as empty.
 * → the report, or { ok:false, error:'bad_asOf' }. */
function debtAging_(asOfIso, tabs) {
  let asOf;
  try { asOf = debtAgingAsOf_(asOfIso); } catch (e) { return { ok: false, error: (e && e.code) || 'bad_asOf' }; }
  // Receipts (Phase 3 PR 2) are not cycles: the cycles carry their derived
  // money, and each receipt dates its own part of it (debtAgingReceivedBy_).
  const t = paymentTabsDerived_(tabs || {});
  const rawRows = function (k) { return (t[k] && Array.isArray(t[k].rows)) ? t[k].rows : []; };
  const cutoff = recRecordsCutoff_();
  const asOfN = refundDayNum_(asOf);
  const m = recModel_(t, asOf);
  const probonoOn = debtAgingProbonoTest_(rawRows('funders'));
  const funderOn = debtAgingFunderOf_(rawRows('funders'));
  const probonoRows = [];
  // Cycles inside an institutional funder's grace window at asOf: flagged on
  // the cycle (funderGrace), counted here. Still owed — never taken out of
  // totals, byHouse or the buckets (CHANGELOG-funder-grace.md).
  const funderGrace = { count: 0, amount: 0 };
  const graceFlags = function (patientId, due, balance) {
    const funder = funderOn(patientId, due);
    if (!isWithinFunderGrace_(due, funder, asOf)) return { funderGrace: false, funderGraceUntil: '' };
    funderGrace.count++;
    funderGrace.amount = refundRound2_(funderGrace.amount + balance);
    return { funderGrace: true, funderGraceUntil: funderGraceUntil_(due) };
  };

  const totals = { recorded_debt: debtAgingEmpty_(), unrecorded_cycles: debtAgingEmpty_() };
  const byHouse = {};
  const house = function (h) {
    if (!byHouse[h]) byHouse[h] = { houseId: h, recorded_debt: debtAgingEmpty_(), unrecorded_cycles: debtAgingEmpty_() };
    return byHouse[h];
  };
  const detachedRows = [], outsideStayRows = [], releasedNoExitRows = [], noEntryRows = [];
  const unknownDate = { count: 0, amount: 0 };
  let voidExcluded = 0;

  // Payments: void out, detached apart, the rest grouped under their patient.
  const rowsByPatient = m.patients.map(function () { return []; });
  m.payments.forEach(function (pay, i) {
    if (pay.status === 'void') { voidExcluded++; return; }
    const prow = rawRows('payments')[i] || {};
    const raw = prow.obj || {};
    const owner = pay.linkStatus === 'not_a_patient' ? null : m.payOwner[i];
    if (!owner) {
      if (!pay.dueDate || pay.dueDate > asOf) return;
      const got = debtAgingReceivedBy_(prow, pay, asOf, pay.dueDate);
      detachedRows.push({
        paymentId: pay.id, patientName: pay.patientName, houseId: pay.houseId, dueDate: pay.dueDate,
        amount: refundRound2_(pay.amount), receivedByAsOf: got.received,
        receivedDateKnown: got.known,
        reason: pay.linkStatus === 'not_a_patient' ? 'not_a_patient' : 'unmatched',
      });
      return;
    }
    rowsByPatient[m.patients.indexOf(owner.patient)].push({ pay: pay, raw: raw, prow: prow });
  });

  const patientsOut = [];
  m.patients.forEach(function (p, pi) {
    const entry = p.date;
    const exit = recExitISO_(p);
    const ident = { patientId: p.id, patientKey: recPatientKey_(p), name: p.name, houseId: p.houseId, status: p.status };
    const mine = rowsByPatient[pi];
    if (!entry) {
      if (mine.length) noEntryRows.push(Object.assign({}, ident, { paymentRows: mine.length }));
      return;
    }
    const cycles = [];
    let settled = 0;
    let probonoCycles = 0;
    const claimed = {};

    // recorded cycles — one per Payments row, as the monthly revenue view does
    mine.forEach(function (o) {
      const pay = o.pay;
      if (!pay.dueDate) return;
      claimed[pay.dueDate] = true;
      claimed['m:' + pay.dueDate.slice(0, 7)] = true;
      const cs = refundForecastIso_(pay.coverageStart), ce = refundForecastIso_(pay.coverageEnd);
      const recorded = !!(cs && ce && ce >= cs);
      const start = recorded ? cs : pay.dueDate;
      if (start > asOf || recBeforeCutoff_(start, cutoff)) return;
      let end = recorded ? ce : debtAgingCycleEnd_(entry, pay.dueDate);
      if (start < entry || (exit && start >= exit)) {
        outsideStayRows.push(Object.assign({}, ident, { paymentId: pay.id, start: start, entryDate: entry, exitDate: exit }));
        return;
      }
      if (exit && end > exit) end = exit;
      // Pro-bono on the cycle's start day: nothing is owed for this cycle.
      if (probonoOn(p.id, start)) { probonoCycles++; return; }
      const expected = refundRound2_(Number(recApplyOverride_(pay, m.overrides).amount) || 0);
      const got = debtAgingReceivedBy_(o.prow, pay, asOf, start);
      if (got.unknownAmount > 0) { unknownDate.count++; unknownDate.amount = refundRound2_(unknownDate.amount + got.unknownAmount); }
      const received = got.received;
      const balance = refundRound2_(Math.max(0, expected - received));
      if (balance <= 0) { settled++; return; }
      const days = asOfN - refundDayNum_(start);
      const bucket = debtAgingBucket_(days);
      cycles.push(Object.assign({
        start: start, end: end, expected: expected, received: received, balance: balance,
        days: days, bucket: bucket, kind: 'recorded', paymentId: pay.id,
        coverageSource: recorded ? 'recorded' : 'derived', receivedDateKnown: got.known,
        receivedDateSource: got.source,
      }, graceFlags(p.id, pay.dueDate, balance)));
      debtAgingAdd_(totals.recorded_debt, bucket, balance);
      debtAgingAdd_(house(p.houseId).recorded_debt, bucket, balance);
    });

    // unrecorded cycles — the stay's cycles up to D with no Payments row
    const releasedNoExit = p.status === 'released' && !exit;
    if (releasedNoExit) {
      releasedNoExitRows.push({ patientId: p.id, name: p.name, houseId: p.houseId, entryDate: entry });
    } else {
      recCycleDueDates_(p, asOf).forEach(function (due) {
        if (recBeforeCutoff_(due, cutoff)) return;
        if (claimed[due] || claimed['m:' + due.slice(0, 7)]) return;
        if (probonoOn(p.id, due)) { probonoCycles++; return; }
        const expected = refundRound2_(Number(recApplyOverride_({
          patientId: recPatientKey_(p), dueDate: due, amount: p.pay, status: 'unpaid', amountPaid: 0,
        }, m.overrides).amount) || 0);
        let end = debtAgingCycleEnd_(entry, due);
        if (exit && end > exit) end = exit;
        const days = asOfN - refundDayNum_(due);
        const bucket = debtAgingBucket_(days);
        cycles.push(Object.assign({
          start: due, end: end, expected: expected, received: 0, balance: expected,
          days: days, bucket: bucket, kind: 'unrecorded', note: DEBT_UNRECORDED_NOTE,
        }, graceFlags(p.id, due, expected)));
        debtAgingAdd_(totals.unrecorded_cycles, bucket, expected);
        debtAgingAdd_(house(p.houseId).unrecorded_cycles, bucket, expected);
      });
    }

    if (probonoCycles) {
      probonoRows.push({ patientId: p.id, name: p.name, houseId: p.houseId, status: p.status,
        entryDate: entry, exitDate: exit, cycles: probonoCycles });
    }
    if (!cycles.length) return;
    cycles.sort(function (a, b) { return a.start < b.start ? -1 : a.start > b.start ? 1 : 0; });
    patientsOut.push(Object.assign(ident, {
      entryDate: entry, exitDate: exit, inHouseAtAsOf: recStayCovers_(p, asOf),
      settledCycles: settled, cycles: cycles,
    }));
  });

  // Credits pending at D: created on/before D, not cancelled, not paid by D.
  const creditsByHouse = {};
  let creditsTotal = 0, creditsCount = 0, createdUnknown = 0;
  m.credits.forEach(function (c, i) {
    if (!(c.amount > 0) || c.status === 'cancelled') return;
    const raw = (rawRows('credits')[i] || {}).obj || {};
    const created = refundForecastIso_(raw.createdAt) || refundForecastIso_(raw.decidedDate);
    if (created && created > asOf) return;
    if (c.status === 'paid') {
      const paidOn = refundForecastIso_(raw.paidDate);
      if (!paidOn || paidOn <= asOf) return;
    }
    if (!created) createdUnknown++;
    const h = c.houseId || '';
    if (!creditsByHouse[h]) creditsByHouse[h] = { houseId: h, count: 0, total: 0 };
    creditsByHouse[h].count++;
    creditsByHouse[h].total = refundRound2_(creditsByHouse[h].total + c.amount);
    creditsCount++;
    creditsTotal = refundRound2_(creditsTotal + c.amount);
  });

  const sumField = function (rows, f) { return refundRound2_(rows.reduce(function (s, r) { return s + (Number(r[f]) || 0); }, 0)); };
  const sorted = function (o) { return Object.keys(o).sort().map(function (k) { return o[k]; }); };
  patientsOut.sort(function (a, b) {
    return (a.houseId < b.houseId ? -1 : a.houseId > b.houseId ? 1 : 0) || String(a.name).localeCompare(String(b.name), 'he');
  });

  return {
    ok: true, asOf: asOf, recordsCutoff: cutoff, vatInclusive: true,
    buckets: DEBT_AGING_BUCKETS.map(function (b) { return { key: b.key, from: b.from, to: b.to }; }),
    totals: totals,
    byHouse: sorted(byHouse),
    byPatient: patientsOut,
    detachedPayments: {
      count: detachedRows.length, amount: sumField(detachedRows, 'amount'),
      receivedByAsOf: sumField(detachedRows, 'receivedByAsOf'), rows: detachedRows,
    },
    pendingCredits: { count: creditsCount, total: creditsTotal, createdDateUnknown: createdUnknown, byHouse: sorted(creditsByHouse) },
    receivedDateUnknown: unknownDate,
    outsideStay: { count: outsideStayRows.length, rows: outsideStayRows },
    releasedWithoutExit: { count: releasedNoExitRows.length, rows: releasedNoExitRows },
    noEntryDate: { count: noEntryRows.length, rows: noEntryRows },
    voidExcluded: voidExcluded,
    /* Cycles left out because the patient was pro-bono on their start day —
     * counted, never owed, never in totals / byHouse / byPatient. */
    probonoExcluded: {
      count: probonoRows.reduce(function (s, r) { return s + r.cycles; }, 0),
      patients: probonoRows.length, rows: probonoRows,
    },
    /* Owed cycles inside an institutional funder's grace window at asOf —
     * INCLUDED in totals / byHouse / byPatient above; this only counts them. */
    funderGrace: funderGrace,
  };
}

/* Funders row objects → test(patientId, dayIso): true when the patient's
 * funder on that day is FUNDER_PROBONO — currentFunderFrom_'s rule, the same
 * one Funder.debtByFunder applies to a cycle's start day. Rows are grouped by
 * patient once, so a large report stays linear. No rows → always false. PURE. */
function debtAgingProbonoTest_(funderRows) {
  const byId = {};
  (Array.isArray(funderRows) ? funderRows : []).forEach(function (r) {
    const o = r && r.obj && typeof r.obj === 'object' ? r.obj : r;
    const id = paymentReportText_(o && o.patientId);
    if (id) (byId[id] || (byId[id] = [])).push(o);
  });
  return function (patientId, dayIso) {
    const id = paymentReportText_(patientId);
    if (!id || !byId[id] || !dayIso) return false;
    return currentFunderFrom_(byId[id], id, dayIso).funder === FUNDER_PROBONO;
  };
}

/* Funders row objects → funderOf(patientId, dayIso): the patient's funder
 * label on that day (currentFunderFrom_'s rule), or FUNDER_UNSET. Grouped once
 * like debtAgingProbonoTest_. PURE. */
function debtAgingFunderOf_(funderRows) {
  const byId = {};
  (Array.isArray(funderRows) ? funderRows : []).forEach(function (r) {
    const o = r && r.obj && typeof r.obj === 'object' ? r.obj : r;
    const id = paymentReportText_(o && o.patientId);
    if (id) (byId[id] || (byId[id] = [])).push(o);
  });
  return function (patientId, dayIso) {
    const id = paymentReportText_(patientId);
    if (!id || !byId[id] || !dayIso) return FUNDER_UNSET;
    return currentFunderFrom_(byId[id], id, dayIso).funder;
  };
}

/* action=debtAging — READ-ONLY. Reads Patients, Payments, Credits and
 * BillingOverrides with getSheetByName (never creates a sheet, no lock, no
 * write, no audit row). Gated by PROXY_SECRET (not in OPEN_ACTIONS). */
function debtAgingAction_(params) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const tabs = {};
    [['patients', PATIENTS_SHEET, PATIENT_COLUMNS], ['payments', PAYMENTS_SHEET, PAYMENT_COLUMNS],
     ['credits', CREDITS_SHEET, CREDIT_COLUMNS], ['overrides', BILLING_OVERRIDES_SHEET, BILLING_OVERRIDE_COLUMNS],
     ['funders', FUNDERS_SHEET, FUNDER_COLUMNS]]
      .forEach(function (x) {
        const sh = ss.getSheetByName(x[1]);
        tabs[x[0]] = sh ? recReadSheet_(sh, x[2]) : { rows: [] };
        tabs[x[0]].sheet = x[1];
      });
    const out = debtAging_((params || {}).asOf, tabs);
    if (out.ok) out.generatedAt = new Date().toISOString();
    return out;
  } catch (e) {
    return { ok: false, error: (e && e.code) || 'debt_aging_failed' };
  }
}

/* ===== Data cleanup workbook (READ-ONLY) =====
 * CHANGELOG-cleanup-workbook.md. action=cleanupReport → every known gap and
 * inconsistency as of today (Asia/Jerusalem), one list per kind, for the
 * «ייצוא רשימת תיקונים» workbook. Each row carries a `kind`; lib/cleanup-xlsx.js
 * turns it into the problem, who fixes it and how. No write, no lock, no audit
 * row, no property, nothing logged.
 *
 * NO SECOND ENGINE — every list is an existing check:
 *   names      reconciliation §D (U+FFFD, recSectionD_); the names joined by
 *              the existing links — payment→patient (recMatchPatient_),
 *              credit→patient (recCreditPatient_), patient→lead (fromLead);
 *              near-duplicate names in one house (new: nothing checked it)
 *   gaps       debtAging_ as of today, both figures, never summed
 *   detached, outsideStay, releasedNoExit, noEntryDate, zeroAmount
 *              debtAging_'s own separate lists (zero amount = every cycle 0,
 *              the «חובות פתוחים» view's rule)
 *   leads      reconciliation §A (paid / admitted, no Patients row) + §F
 *   duplicates same owner + amount + cycle month (the שיוך תשלומים "same
 *              cycle" rule), or due dates ≤ 7 days apart (reconciliation §I);
 *              void rows never count
 *   credits    refundPayoutForecastFor_: awaiting_decision + unresolved
 *              (missing_payment_data is already in gaps, via debtAging_)
 *   noFunder   (Phase 3 PR 1) patients not released with no Funders row —
 *              they read as «לא הוגדר» — no default (cleanupNoFunder_)
 *   probono    «מטופלי פרו-בונו»: patients whose funder is pro-bono today
 *              (released: on the exit day), or who have cycles debtAging_
 *              left out as pro-bono (cleanupProbono_).
 *   defaultedFunder  payments the old default funder decided (written as the
 *              private label with no Funders row on their receivedDate) —
 *              defaultedFunderPayments_, CHANGELOG-defaulted-funder-report.md.
 *              Appended LAST. */
const CLEANUP_SECTION_KEYS = ['names', 'gaps', 'detached', 'outsideStay', 'releasedNoExit', 'noEntryDate',
  'zeroAmount', 'leads', 'duplicates', 'credits', 'noFunder', 'probono', 'defaultedFunder'];
/* A gap cycle older than this, with no later activity, is "probably a
 * data-entry error" (cleanupProbablyEntryError_). */
const CLEANUP_STALE_DAYS = 30;

/* The rule for «כנראה טעות רישום», exactly:
 *   the cycle starts before the records cutoff (2026-07-01), OR
 *   the patient has NO later activity — no non-void Payments row of theirs
 *   due after the cycle start and none reported paid (chargedAt) after it —
 *   AND the cycle is more than CLEANUP_STALE_DAYS old (so this month's fresh
 *   cycle, which naturally has nothing after it yet, is not flagged). */
function cleanupProbablyEntryError_(startIso, days, laterActivity) {
  if (recBeforeCutoff_(startIso, recRecordsCutoff_())) return true;
  return !laterActivity && Number(days) > CLEANUP_STALE_DAYS;
}

/* True when a and b differ by exactly one inserted, deleted or replaced character. */
function cleanupOneEdit_(a, b) {
  if (a === b || Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else { i++; j++; }
  }
  return edits + (a.length - i) + (b.length - j) === 1;
}

/* Why two names in one house look like the same person, or '':
 *   same_name  identical; spacing  equal once spaces / invisibles / case are
 *   normalized (recNameKey_); partial  one name's words start the other's
 *   («ערן» / «ערן כהן»); word_order  the same words reordered; one_letter  one
 *   character apart (both at least 4 long). */
function cleanupNearDuplicateWhy_(a, b) {
  const ka = recNameKey_(a), kb = recNameKey_(b);
  if (!ka || !kb) return '';
  if (ka === kb) return recText_(a) === recText_(b) ? 'same_name' : 'spacing';
  const wa = ka.split(' ').filter(Boolean), wb = kb.split(' ').filter(Boolean);
  const short = wa.length <= wb.length ? wa : wb;
  const long = short === wa ? wb : wa;
  if (short.every(function (w, i) { return long[i] === w; })) return 'partial';
  if (wa.length === wb.length && wa.slice().sort().join(' ') === wb.slice().sort().join(' ')) return 'word_order';
  if (Math.min(ka.length, kb.length) >= 4 && cleanupOneEdit_(ka, kb)) return 'one_letter';
  return '';
}

/* «שמות לא תואמים». */
function cleanupNames_(m, rec) {
  const out = [];
  const houseAt = {};
  m.patients.concat(m.audits, m.tombs, m.allLeads).forEach(function (x) { houseAt[x.sheet + '#' + x.row] = x.houseId || ''; });
  m.payments.forEach(function (p) { houseAt[PAYMENTS_SHEET + '#' + p.row] = p.houseId || ''; });
  m.credits.forEach(function (c) { houseAt[CREDITS_SHEET + '#' + c.row] = c.houseId || ''; });

  // 1. U+FFFD — reconciliation §D, with its proposal and confidence.
  rec.sections.D.forEach(function (d) {
    out.push({ kind: 'fffd', houseId: houseAt[d.sheet + '#' + d.row] || '', name: d.name, refs: [d.ref],
      proposal: d.proposal, confidence: d.confidence, via: d.via });
  });

  // 2. One patient, spelled differently where an existing link joins two tabs.
  //    One row per (tab, patient, spelling); the Patients name is the proposal.
  const groups = {};
  const spelling = function (source, patient, recordedName, ref) {
    const shown = recText_(recordedName);
    if (!shown || shown === recText_(patient.name)) return;
    if (hasCorruption_(recordedName) || hasCorruption_(patient.name)) return;   // listed under fffd
    const k = source + '|' + patient.sheet + ':' + patient.row + '|' + shown;
    if (!groups[k]) {
      groups[k] = { kind: 'spelling', source: source, houseId: patient.houseId || '', name: recText_(patient.name),
        recordedName: shown, refs: [], proposal: recText_(patient.name) };
      out.push(groups[k]);
    }
    groups[k].refs.push(ref);
  };
  m.payments.forEach(function (p, i) {
    const o = m.payOwner[i];
    if (!o || p.status === 'void' || p.linkStatus === 'not_a_patient') return;
    spelling('payments', o.patient, p.patientName, recRef_(PAYMENTS_SHEET, p.row));
  });
  m.credits.forEach(function (c) {
    if (c.status === 'cancelled') return;
    const p = recCreditPatient_(c, m);
    if (p) spelling('credits', p, c.patientName, recRef_(CREDITS_SHEET, c.row));
  });
  m.patients.forEach(function (p) {
    const l = p.fromLead ? m.leadById[p.fromLead] : null;
    if (l) spelling('leads', p, l.name, recRef_(l.sheet, l.row));
  });

  // 3. Near-duplicate names in one house (Patients; at least one still active,
  //    an identical name only when both are active — else it is a readmission).
  const paid = m.patients.map(function () { return 0; });
  m.payments.forEach(function (p, i) {
    const o = m.payOwner[i];
    if (o && p.status !== 'void') paid[m.patients.indexOf(o.patient)]++;
  });
  const byHouse = {};
  m.patients.forEach(function (p, i) {
    if (!recText_(p.name) || hasCorruption_(p.name)) return;
    const h = p.houseId || '';
    (byHouse[h] = byHouse[h] || []).push(i);
  });
  Object.keys(byHouse).sort().forEach(function (h) {
    const list = byHouse[h];
    for (let a = 0; a < list.length; a++) {
      for (let b = a + 1; b < list.length; b++) {
        const x = m.patients[list[a]], y = m.patients[list[b]];
        const ax = recIsBillable_(x), ay = recIsBillable_(y);
        if (!ax && !ay) continue;
        const why = cleanupNearDuplicateWhy_(x.name, y.name);
        if (!why || (why === 'same_name' && !(ax && ay))) continue;
        // The proposal: the row with more payments, else the fuller name, else the earlier entry.
        const px = paid[list[a]], py = paid[list[b]];
        let keep = x;
        if (py > px) keep = y;
        else if (py === px && recText_(y.name).length > recText_(x.name).length) keep = y;
        else if (py === px && recText_(y.name).length === recText_(x.name).length && y.date && (!x.date || y.date < x.date)) keep = y;
        out.push({ kind: 'near_duplicate', why: why, houseId: h, name: recText_(x.name), otherName: recText_(y.name),
          entryDate: x.date || '', otherEntryDate: y.date || '', refs: [recRef_(x.sheet, x.row), recRef_(y.sheet, y.row)],
          proposal: recText_(keep.name) });
      }
    }
  });
  return out;
}

/* «פערי גבייה לבדיקה» — debtAging_'s owed cycles, oldest first. */
function cleanupGaps_(m, tabs, aging) {
  const rawPay = (tabs.payments && tabs.payments.rows) || [];
  const activity = {};
  m.payments.forEach(function (p, i) {
    const o = m.payOwner[i];
    if (!o || p.status === 'void' || p.linkStatus === 'not_a_patient') return;
    const k = recPatientKey_(o.patient);
    (activity[k] = activity[k] || []).push({
      due: p.dueDate || '', charged: refundForecastIso_(((rawPay[i] || {}).obj || {}).chargedAt) || '',
    });
  });
  const rows = [];
  aging.byPatient.forEach(function (p) {
    const acts = activity[p.patientKey] || [];
    p.cycles.forEach(function (c) {
      if (!(Number(c.balance) > 0)) return;   // a 0 cycle is a zero-amount patient, listed apart
      const later = acts.some(function (a) { return (a.due && a.due > c.start) || (a.charged && a.charged > c.start); });
      rows.push({
        kind: c.kind === 'recorded' ? 'recorded_debt' : 'unrecorded_cycle',
        houseId: p.houseId || '', name: p.name, status: p.status, entryDate: p.entryDate || '', exitDate: p.exitDate || '',
        start: c.start, end: c.end, expected: c.expected, received: c.received, balance: c.balance,
        days: c.days, bucket: c.bucket, laterActivity: later,
        probablyEntryError: cleanupProbablyEntryError_(c.start, c.days, later),
      });
    });
  });
  return rows.sort(function (a, b) {
    return (a.start < b.start ? -1 : a.start > b.start ? 1 : 0) ||
      (a.houseId < b.houseId ? -1 : a.houseId > b.houseId ? 1 : 0) || String(a.name).localeCompare(String(b.name), 'he');
  });
}

/* Suspected duplicate payments that are not voided yet. The owner is the
 * matched patient; a detached row takes its single best reconnect candidate
 * (recCandidates_) when that candidate is in the same house and shares the
 * name or the entry date — the renamed-patient pairs PR #144 voided; else the
 * row's own house + name. */
function cleanupDuplicates_(m) {
  const ownerOf = function (p, i) {
    const o = m.payOwner[i];
    if (o) return { key: 'p:' + o.patient.sheet + ':' + o.patient.row, patient: o.patient };
    const cands = recCandidates_(p, m.patients);
    const c = cands[0];
    const unique = c && !(cands[1] && cands[1].score === c.score);
    const strong = c && c.reasons.indexOf('same_house') >= 0 &&
      (c.reasons.indexOf('name') >= 0 || c.reasons.indexOf('entry_date') >= 0 || c.reasons.indexOf('uid') >= 0);
    if (unique && strong) return { key: 'p:' + c.patient.sheet + ':' + c.patient.row, patient: c.patient };
    return { key: 'd:' + (p.houseId || '') + '::' + recNameKey_(p.patientName), patient: null };
  };
  const owners = {};
  m.payments.forEach(function (p, i) {
    if (p.status === 'void' || p.linkStatus === 'not_a_patient' || !(p.amount > 0) || !p.dueDate) return;
    const o = ownerOf(p, i);
    if (!owners[o.key]) owners[o.key] = { patient: o.patient, list: [] };
    owners[o.key].list.push({ p: p, linked: !!m.payOwner[i] });
  });
  const out = [];
  Object.keys(owners).sort().forEach(function (k) {
    const g = owners[k];
    for (let a = 0; a < g.list.length; a++) {
      for (let b = a + 1; b < g.list.length; b++) {
        const x = g.list[a].p, y = g.list[b].p;
        if (x.amount !== y.amount) continue;
        const sameMonth = x.dueDate.slice(0, 7) === y.dueDate.slice(0, 7);
        const d = Math.abs(recDaysBetween_(x.dueDate, y.dueDate));
        if (!sameMonth && !(isFinite(d) && d <= 7)) continue;
        const first = x.dueDate <= y.dueDate ? x : y, second = first === x ? y : x;
        out.push({
          kind: g.list[a].linked && g.list[b].linked ? 'duplicate' : 'duplicate_detached',
          rule: sameMonth ? 'same_month' : 'within_7_days',
          houseId: (g.patient && g.patient.houseId) || first.houseId || '',
          name: g.patient ? recText_(g.patient.name) : recText_(first.patientName),
          amount: x.amount, dueDate: first.dueDate, otherDueDate: second.dueDate,
          names: [recText_(first.patientName), recText_(second.patientName)],
          refs: [recRef_(PAYMENTS_SHEET, first.row), recRef_(PAYMENTS_SHEET, second.row)],
        });
      }
    }
  });
  return out.sort(function (a, b) { return a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : 0; });
}

/* «זיכויים לבדיקה» — refundPayoutForecastFor_'s awaiting_decision and
 * unresolved groups. missing_payment_data is left out: those exit cycles are
 * already unrecorded cycles in «פערי גבייה לבדיקה» (debtAging_). */
function cleanupCredits_(forecast) {
  const rows = [];
  const ident = function (r) {
    return { houseId: r.houseId || '', name: r.patientName || '', entryDate: r.entryDate || '', exitDate: r.exitDate || '' };
  };
  forecast.awaiting_decision.byPayoutDate.forEach(function (g) {
    g.rows.forEach(function (r) {
      rows.push(Object.assign(ident(r), { kind: 'credit_awaiting', amount: r.suggestedAmount, rule: r.rule, payoutDate: r.payoutDate }));
    });
  });
  forecast.unresolved.rows.forEach(function (r) { rows.push(Object.assign(ident(r), { kind: 'credit_unresolved', error: r.error })); });
  return rows.sort(function (a, b) { return a.exitDate < b.exitDate ? -1 : a.exitDate > b.exitDate ? 1 : 0; });
}

/* «חסר גורם מממן» — every patient who is not released and has no Funders
 * row at all. Such a patient reads as FUNDER_UNSET («לא הוגדר»); the list is
 * so somebody decides. There is no default. A row for the
 * patient with any date counts as recorded (a future effectiveFrom is still a
 * decision). Pure. */
function cleanupNoFunder_(m, funderObjs) {
  const has = {};
  (funderObjs || []).forEach(function (r) {
    const id = paymentReportText_(r && r.patientId);
    if (id) has[id] = true;
  });
  return m.patients.filter(function (p) {
    return p.status !== 'released' && !has[paymentReportText_(p.id)];
  }).map(function (p) {
    return { kind: 'no_funder', houseId: p.houseId || '', name: p.name, status: p.status,
      entryDate: p.date || '', funder: FUNDER_UNSET };
  }).sort(function (a, b) {
    return (a.houseId < b.houseId ? -1 : a.houseId > b.houseId ? 1 : 0) || String(a.name).localeCompare(String(b.name), 'he');
  });
}

/* «מטופלי פרו-בונו». A patient is listed when their funder on their funder
 * day (today; a released patient's exit day when it is earlier) is
 * FUNDER_PROBONO, or when debtAging_ left out any of their cycles as
 * pro-bono (a patient who was pro-bono for part of the stay). `from` = the
 * effectiveFrom of the pro-bono row in force on the funder day ('' when the
 * patient is no longer pro-bono). Pure. */
function cleanupProbono_(m, funderObjs, aging, todayIso) {
  const rows = Array.isArray(funderObjs) ? funderObjs : [];
  const excluded = {};
  ((aging && aging.probonoExcluded && aging.probonoExcluded.rows) || []).forEach(function (r) {
    if (r && r.patientId) excluded[r.patientId] = r.cycles;
  });
  return m.patients.filter(function (p) { return !!paymentReportText_(p.id); }).map(function (p) {
    const exit = recExitISO_(p);
    const day = exit && exit < todayIso ? exit : todayIso;
    const cur = currentFunderFrom_(rows, p.id, day);
    const now = cur.funder === FUNDER_PROBONO;
    const cycles = Number(excluded[p.id]) || 0;
    if (!now && !cycles) return null;
    return { kind: 'probono', houseId: p.houseId || '', name: p.name, status: p.status,
      entryDate: p.date || '', exitDate: exit || '', from: now ? cur.effectiveFrom : '',
      current: cur.funder, excludedCycles: cycles };
  }).filter(Boolean).sort(function (a, b) {
    return (a.houseId < b.houseId ? -1 : a.houseId > b.houseId ? 1 : 0) || String(a.name).localeCompare(String(b.name), 'he');
  });
}

/* Pure. tabs = recCollect_'s shape (a missing tab reads as empty), plus an
 * optional `funders` tab (cleanupReportAction_ adds it).
 * → { ok, today, recordsCutoff, sections: { <CLEANUP_SECTION_KEYS> }, counts }. */
function cleanupReport_(todayIso, tabs) {
  let today;
  try { today = debtAgingAsOf_(todayIso); } catch (e) { return { ok: false, error: 'bad_today' }; }
  // Receipts (Phase 3 PR 2) are not cycles: derive once here, so every
  // section below indexes the same rows recModel_ does (cleanupGaps_ reads
  // tabs.payments.rows in parallel with m.payments).
  const t = paymentTabsDerived_(tabs || {});
  const objs = function (k) { return ((t[k] && t[k].rows) || []).map(function (r) { return r.obj; }); };
  const m = recModel_(t, today);
  const rec = recBuildReport_(t, today);
  const aging = debtAging_(today, t);
  if (!aging.ok) return { ok: false, error: aging.error || 'debt_aging_failed' };
  const forecast = refundPayoutForecastFor_(objs('discharged'), objs('credits'), objs('payments'), today);

  const payById = {};
  m.payments.forEach(function (p) { if (p.id && !(p.id in payById)) payById[p.id] = p; });
  const bestById = {};
  rec.sections.E.forEach(function (e) { if (e.payment.id && !(e.payment.id in bestById)) bestById[e.payment.id] = e; });

  // A row someone already marked «לא מטופל» (with a note) is a decision, not a gap.
  const decided = aging.detachedPayments.rows.filter(function (r) { return r.reason === 'not_a_patient'; }).length;
  const detached = aging.detachedPayments.rows.filter(function (r) { return r.reason !== 'not_a_patient'; }).map(function (r) {
    const e = bestById[r.paymentId] || {};
    const p = payById[r.paymentId];
    return { kind: 'detached', houseId: r.houseId || '', name: recText_(r.patientName), dueDate: r.dueDate, amount: r.amount,
      receivedByAsOf: r.receivedByAsOf, candidate: e.best || '', candidateReason: e.reason || '',
      refs: p ? [recRef_(PAYMENTS_SHEET, p.row)] : [] };
  }).sort(function (a, b) { return a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : 0; });

  const outsideStay = aging.outsideStay.rows.map(function (r) {
    const p = payById[r.paymentId];
    return { kind: r.start < r.entryDate ? 'before_entry' : 'after_exit', houseId: r.houseId || '', name: r.name,
      status: r.status, start: r.start, entryDate: r.entryDate, exitDate: r.exitDate || '',
      amount: p ? p.amount : '', refs: p ? [recRef_(PAYMENTS_SHEET, p.row)] : [] };
  }).sort(function (a, b) { return a.start < b.start ? -1 : a.start > b.start ? 1 : 0; });

  const zeroAmount = aging.byPatient.filter(function (p) {
    return !p.cycles.some(function (c) { return Number(c.balance) > 0; });
  }).map(function (p) {
    return { kind: 'zero_amount', houseId: p.houseId || '', name: p.name, status: p.status,
      entryDate: p.entryDate || '', exitDate: p.exitDate || '', cycles: p.cycles.length };
  });

  const leads = rec.sections.A.map(function (a) {
    return { kind: 'lead_no_patient', houseId: a.lead.houseId || '', name: a.lead.name, phone: a.lead.phone,
      stage: a.why, created: a.lead.created || '', entryDate: a.lead.entryDate || '', advance: a.lead.advance,
      notes: a.notes, refs: [a.ref] };
  }).concat(rec.sections.F.filter(function (f) { return f.payment.linkStatus !== 'not_a_patient'; }).map(function (f) {
    return { kind: 'paid_not_admitted', houseId: f.lead.houseId || f.payment.houseId || '', name: f.lead.name,
      phone: f.lead.phone, paymentName: recText_(f.payment.patientName), dueDate: f.payment.dueDate, amount: f.money,
      reason: f.reason, refs: [f.ref, recRef_(f.lead.sheet, f.lead.row)] };
  }));

  const sections = {
    names: cleanupNames_(m, rec),
    gaps: cleanupGaps_(m, t, aging),
    detached: detached,
    outsideStay: outsideStay,
    releasedNoExit: aging.releasedWithoutExit.rows.map(function (r) {
      return { kind: 'released_no_exit', houseId: r.houseId || '', name: r.name, entryDate: r.entryDate || '' };
    }),
    noEntryDate: aging.noEntryDate.rows.map(function (r) {
      return { kind: 'no_entry_date', houseId: r.houseId || '', name: r.name, status: r.status, paymentRows: r.paymentRows };
    }),
    zeroAmount: zeroAmount,
    leads: leads,
    duplicates: cleanupDuplicates_(m),
    credits: cleanupCredits_(forecast),
    noFunder: cleanupNoFunder_(m, objs('funders')),
    probono: cleanupProbono_(m, objs('funders'), aging, today),
    // Every Payments row (cycles AND receipts), from the derived tabs.
    defaultedFunder: defaultedFunderPayments_(objs('payments').concat(objs('receipts')), objs('funders')),
  };
  const counts = {};
  CLEANUP_SECTION_KEYS.forEach(function (k) { counts[k] = sections[k].length; });
  return { ok: true, today: today, recordsCutoff: recRecordsCutoff_(), sections: sections, counts: counts,
    notAPatientExcluded: decided };
}

/* action=cleanupReport — READ-ONLY. Reads every tab the reconciliation report
 * reads (recCollect_: getSheetByName + getValues; a missing tab is listed,
 * never created). Gated by PROXY_SECRET (not in OPEN_ACTIONS) and refused for
 * an actor without `finance` (FINANCE_ACTIONS). */
function cleanupReportAction_() {
  try {
    const data = recCollect_();
    // Funders is read here, not in recTargets_: the reconciliation report has
    // no use for it, and a tab that does not exist yet is not "missing".
    const fsh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(FUNDERS_SHEET);
    data.tabs.funders = fsh ? recReadSheet_(fsh, FUNDER_COLUMNS) : { rows: [] };
    const out = cleanupReport_(Utilities.formatDate(new Date(), 'Asia/Jerusalem', 'yyyy-MM-dd'), data.tabs);
    if (out.ok) {
      out.missingTabs = data.missing;
      out.generatedAt = new Date().toISOString();
    }
    return out;
  } catch (e) {
    return { ok: false, error: (e && e.code) || 'cleanup_failed' };
  }
}

/* ===== Payments the old default funder decided (READ-ONLY) =====
 * CHANGELOG-defaulted-funder-report.md. Until #178, a payment report that
 * named no funder for a patient without a Funders row was written as פרטי
 * (the old default constant, removed in #178). The report form also pre-selected פרטי, so a
 * receipt sent without anyone choosing could carry it too. This lists every
 * such row so a person decides. A row is listed when ALL of these hold:
 *   - funder is exactly the private label (PAYMENT_FUNDERS[0]);
 *   - it has a readable receivedDate (the default only ever ran on a report,
 *     and a report always has one);
 *   - it is not void (a voided row has nothing left to fix);
 *   - the patient (patientUid, else linkPatientUid) has NO Funders row with
 *     a recognized label and an effectiveFrom <= that receivedDate. This is
 *     the rule the old currentFunderFrom_ used, so the old default is exactly
 *     what decided the row. A patient with no id cannot have a Funders row,
 *     so the row is listed.
 * How each row is fixed depends on its type: a cycle row (savePayment)
 * takes updatePayment with the right funder; a receipt (rcpt-…) is
 * immutable (receipt_immutable), so it is voided and reported again.
 * PURE. paymentObjs / funderObjs: sheet row objects (Payments, Funders).
 * → rows sorted by receivedDate, then id:
 *   { kind, paymentId, receipt, houseId, name, patientUid, receivedDate,
 *     amount, fix: 'update_payment' | 'void_and_rereport' } */
function defaultedFunderPayments_(paymentObjs, funderObjs) {
  const day = function (v) { return v instanceof Date ? refundForecastIso_(v) : (paymentReportDate_(v) || ''); };
  const first = {};   // patientId → the earliest effectiveFrom of a recognized row
  (Array.isArray(funderObjs) ? funderObjs : []).forEach(function (r) {
    const id = paymentReportText_(r && r.patientId);
    const eff = day(r && r.effectiveFrom);
    if (!id || !eff || PAYMENT_FUNDERS.indexOf(paymentReportText_(r.funder)) < 0) return;
    if (!first[id] || eff < first[id]) first[id] = eff;
  });
  const privateLabel = PAYMENT_FUNDERS[0];
  return (Array.isArray(paymentObjs) ? paymentObjs : []).filter(function (p) {
    if (!p || paymentReportText_(p.funder) !== privateLabel || isVoidStatus_(p.status)) return false;
    const rd = day(p.receivedDate);
    if (!rd) return false;
    const uid = paymentReportText_(p.patientUid) || paymentReportText_(p.linkPatientUid);
    return !uid || !first[uid] || first[uid] > rd;
  }).map(function (p) {
    const receipt = isReceiptRow_(p);
    const amountPaid = Number(p.amountPaid) || 0;
    return {
      kind: 'defaulted_funder',
      paymentId: paymentReportText_(p.id),
      receipt: receipt,
      houseId: paymentReportText_(p.houseId),
      name: paymentReportText_(p.patientName),
      patientUid: paymentReportText_(p.patientUid) || paymentReportText_(p.linkPatientUid),
      receivedDate: day(p.receivedDate),
      amount: receipt ? (Number(p.amount) || 0) : (amountPaid > 0 ? amountPaid : (Number(p.amount) || 0)),
      fix: receipt ? 'void_and_rereport' : 'update_payment',
    };
  }).sort(function (a, b) {
    return (a.receivedDate < b.receivedDate ? -1 : a.receivedDate > b.receivedDate ? 1 : 0) ||
      (a.paymentId < b.paymentId ? -1 : a.paymentId > b.paymentId ? 1 : 0);
  });
}

/* Editor-run, DRY RUN: writes nothing to the spreadsheet. It opens Payments
 * and Funders with getSheetByName (a missing tab reads as empty and is never
 * created) and reads them with getValues. There is no lock, no AuditLog row
 * and no property. Its ONLY write is one new private Google Doc
 * ("E-Zone תשלומים עם גורם מממן ברירת מחדל YYYY-MM-DD HH:mm", not shared or
 * moved), whose URL it logs, the same as reconciliationReportNow. Public (Run
 * dropdown), and handle_ never names it, so it is not reachable over HTTP.
 * The log carries counts and the URL only: no names (no PII in logs).
 * Returns { rows, count, total, title, url }. */
function defaultedFunderPaymentsReportNow() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const objs = function (name, cols) {
    const sh = ss.getSheetByName(name);
    return sh ? recReadSheet_(sh, cols).rows.map(function (r) { return r.obj; }) : [];
  };
  const rows = defaultedFunderPayments_(objs(PAYMENTS_SHEET, PAYMENT_COLUMNS), objs(FUNDERS_SHEET, FUNDER_COLUMNS));
  const total = rows.reduce(function (s, r) { return Math.round((s + r.amount) * 100) / 100; }, 0);
  const title = 'E-Zone תשלומים עם גורם מממן ברירת מחדל ' + Utilities.formatDate(new Date(), 'Asia/Jerusalem', 'yyyy-MM-dd HH:mm');
  const doc = DocumentApp.create(title);
  const body = doc.getBody();
  const paras = body.getParagraphs();
  for (let i = 0; i < paras.length; i++) paras[i].setLeftToRight(false);
  recDocPara_(body, title, DocumentApp.ParagraphHeading.TITLE);
  recDocPara_(body, 'דוח לקריאה בלבד: הגיליון לא שונה. תשלומים שנרשמו כ«' + PAYMENT_FUNDERS[0] +
    '» כשלמטופל לא הייתה שורה בלשונית Funders בתאריך קבלת התשלום — כלומר ברירת המחדל הישנה קבעה את הגורם המממן, לא אדם.', null);
  recDocPara_(body, 'נמצאו ' + rows.length + ' תשלומים, סה״כ ' + recShekel_(total) + '.', null);
  recDocPara_(body, 'איך מתקנים: (1) לקבוע את הגורם המממן הנכון בגבייה ← «השלמת גורם מממן» (או בכרטיס המטופל), מתאריך הכניסה. ' +
    '(2) שורת מחזור — לתקן את הגורם המממן של התשלום (updatePayment). ' +
    'קבלה (rcpt-…) אינה ניתנת לעריכה — לבטל אותה («ביטול קבלה») ולדווח מחדש עם הגורם המממן הנכון.', null);
  if (!rows.length) recDocPara_(body, 'אין פריטים.', null);
  else {
    recDocTable_(body, [['מזהה תשלום', 'סוג', 'מטופל', 'בית', 'תאריך קבלה', 'סכום', 'תיקון']].concat(rows.map(function (r) {
      return [r.paymentId, r.receipt ? 'קבלה' : 'מחזור', r.name || '—', defaultedFunderHouseName_(r.houseId),
        recDateText_(r.receivedDate), recShekel_(r.amount), r.receipt ? 'ביטול ודיווח מחדש' : 'updatePayment'];
    })));
  }
  doc.saveAndClose();
  const url = doc.getUrl();
  Logger.log('defaultedFunderPaymentsReportNow — DRY RUN, READ-ONLY on the spreadsheet (no cell, tab, lock or property written). ' +
    'Rows: ' + rows.length + ' (' + rows.filter(function (r) { return r.receipt; }).length + ' receipts), total ₪' + recMoneyText_(total) +
    '. Report: ' + title + ' — ' + url);
  return { rows: rows, count: rows.length, total: total, title: title, url: url };
}

/* A patients-sheet house id → its Hebrew name (MANAGER_HOUSE_NAMES is keyed
 * by the managers' ids), else the id itself. Pure. */
function defaultedFunderHouseName_(houseId) {
  const id = paymentReportText_(houseId);
  const keys = Object.keys(MANAGER_HOUSE_TO_PATIENTS_HOUSE_ID);
  for (let i = 0; i < keys.length; i++) {
    if (MANAGER_HOUSE_TO_PATIENTS_HOUSE_ID[keys[i]] === id) return MANAGER_HOUSE_NAMES[keys[i]];
  }
  return id || '—';
}

function creditStr_(v, max) {
  return String(v == null ? '' : v).replace(/[<>]/g, '').trim().slice(0, max);
}
function creditAmount_(v) {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  if (!isFinite(n) || n < 0) return null;
  return Math.round(n * 100) / 100;
}
/* '' or a valid 'YYYY-MM-DD' (via asISODate_); null when unparseable. */
function creditDate_(v) {
  if (v === undefined || v === null || v === '') return '';
  const iso = asISODate_(v);
  return /^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso : null;
}

/**
 * Create or edit ONE credit row. Every field is validated here — the client
 * value is never trusted:
 *   - creditType ∈ CREDIT_TYPES, status ∈ CREDIT_STATUSES, allocationMonth
 *     'YYYY-MM', amounts finite and ≥ 0, both identity keys present, houseId
 *     in FACILITY_TYPE_BY_HOUSE (facilityType is DERIVED from it);
 *   - amount ≠ calculatedAmount without a non-empty overrideReason → refused
 *     (override_reason_required); 'other' without a reason → refused;
 *   - status 'paid' without paidDate AND method → refused (marking paid is an
 *     explicit action, never automatic); a non-paid status carries no paidDate;
 *   - decidedDate defaults to today (spreadsheet tz); payoutDate is derived
 *     from it (refundPayoutDate_: cutoff on the 10th). An EDIT that keeps the
 *     stored decidedDate keeps the stored payoutDate — a credit saved under
 *     the old 15th cutoff is never moved by a re-save;
 *   - CREATE (no id in the payload): id minted here; basis stored as JSON;
 *     createdAt/By + updatedAt/By stamped from the server clock + cookie user;
 *   - EDIT (id present): the row must exist (unknown_credit otherwise — a
 *     client never mints ids); only CREDIT_EDITABLE_COLUMNS are taken from the
 *     payload, everything else is carried from the sheet (calculatedAmount is
 *     never overwritten by the edited amount); a payload updatedAt that
 *     differs from the sheet's REFUSES the write with the same `conflicts`
 *     shape the Patients merge uses (stale tab — someone saved first).
 * Zero amounts are valid rows ("no refund owed" is a decision, not silence).
 */
function upsertCredit_(credit, user) {
  if (!credit || typeof credit !== 'object') return { ok: false, error: 'missing_credit' };
  const stampUser = String(user == null ? '' : user);

  const lock = LockService.getScriptLock();
  if (lock.tryLock(10000) !== true) return lockBusy_('upsertCredit_');
  try {
    const sh = getOrCreateSheet_(CREDITS_SHEET, CREDIT_COLUMNS);
    const idIdx = CREDIT_COLUMNS.indexOf('id');
    const lastRow = sh.getLastRow();
    const nowIso = new Date().toISOString();
    const existing = lastRow > 1
      ? sh.getRange(2, 1, lastRow - 1, CREDIT_COLUMNS.length).getValues()
      : [];

    const wantId = creditStr_(credit.id, 200);
    let record, targetRow = 0;
    // EDIT only: the stored { decidedDate, payoutDate } before this edit.
    let existingPayout = null;

    if (wantId) {
      // ---- EDIT ----
      let rowIdx = -1;
      for (let i = 0; i < existing.length; i++) {
        if (String(existing[i][idIdx]) === wantId) { rowIdx = i; break; }
      }
      if (rowIdx < 0) return { ok: false, error: 'unknown_credit', id: wantId };
      const sheetObj = {};
      for (let c = 0; c < CREDIT_COLUMNS.length; c++) sheetObj[CREDIT_COLUMNS[c]] = existing[rowIdx][c];

      // Stale-save refusal: the stamp this tab loaded vs the sheet's now.
      const seenStamp  = creditStr_(credit.updatedAt, 60);
      const sheetStamp = creditStr_(sheetObj.updatedAt, 60);
      if (sheetStamp !== '' && seenStamp !== '' && seenStamp !== sheetStamp) {
        /* A RETRY of this user's own edit whose answer was lost: the sheet was
         * stamped by them and already holds every value this edit asks for.
         * Answer the stored row, write nothing (CHANGELOG-write-path-hardening.md). */
        if (String(sheetObj.updatedBy == null ? '' : sheetObj.updatedBy) === stampUser && creditEditAlreadyApplied_(credit, sheetObj)) {
          return { ok: true, credit: sheetObj, updated: false, replayed: true };
        }
        const conflict = {
          id: wantId, name: String(sheetObj.patientName || ''), houseId: String(sheetObj.houseId || ''),
          sheetUpdatedAt: sheetStamp, sheetUpdatedBy: String(sheetObj.updatedBy || ''),
        };
        logAudit_('credit_save_conflict', 'upsertCredit_', String(sheetObj.patientId || ''), conflict.name,
          Object.assign({ seenUpdatedAt: seenStamp, updatedBy: stampUser }, conflict));
        return { ok: false, error: 'conflict', conflicts: [conflict] };
      }

      record = Object.assign({}, sheetObj);
      existingPayout = { decidedDate: creditDate_(sheetObj.decidedDate), payoutDate: creditDate_(sheetObj.payoutDate) };
      for (let k = 0; k < CREDIT_EDITABLE_COLUMNS.length; k++) {
        const col = CREDIT_EDITABLE_COLUMNS[k];
        if (credit[col] !== undefined) record[col] = credit[col];
      }
      targetRow = rowIdx + 2;
    } else {
      // ---- CREATE ----
      record = Object.assign({}, credit);
      record.createdAt = nowIso;
      record.createdBy = stampUser;
      record.basis = typeof credit.basis === 'string' ? credit.basis : JSON.stringify(credit.basis || {});
    }

    // ---- Validation (both paths; on an edit the immutable fields are the sheet's) ----
    const patientId  = creditStr_(record.patientId, 200);
    const patientKey = creditStr_(record.patientKey, 300);
    const houseId    = creditStr_(record.houseId, 40);
    const facilityType = facilityTypeFor_(houseId);
    const month      = creditStr_(record.allocationMonth, 7);
    const creditType = creditStr_(record.creditType, 40);
    const status     = creditStr_(record.status, 20) || 'pending';
    if (!patientId)  return { ok: false, error: 'missing_patientId' };
    if (!patientKey) return { ok: false, error: 'missing_patientKey' };
    if (!facilityType) return { ok: false, error: 'bad_houseId', houseId: houseId };
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return { ok: false, error: 'bad_month' };
    if (CREDIT_TYPES.indexOf(creditType) < 0)    return { ok: false, error: 'bad_creditType', creditType: creditType };
    if (CREDIT_STATUSES.indexOf(status) < 0)     return { ok: false, error: 'bad_status', status: status };
    const calculated = creditAmount_(record.calculatedAmount);
    const amount     = creditAmount_(record.amount === undefined || record.amount === '' ? record.calculatedAmount : record.amount);
    if (calculated === null || amount === null) return { ok: false, error: 'bad_amount' };
    const overrideReason = creditStr_(record.overrideReason, 300);
    const reason         = creditStr_(record.reason, 1000);
    if (amount !== calculated && !overrideReason) return { ok: false, error: 'override_reason_required' };
    if (creditType === 'other' && !reason)        return { ok: false, error: 'reason_required' };
    const decidedRaw = creditDate_(record.decidedDate);
    if (decidedRaw === null) return { ok: false, error: 'bad_decidedDate' };
    const decidedDate = decidedRaw || todayISODate_();   // blank → today; invalid → refused above
    const paidDate = creditDate_(record.paidDate);
    if (paidDate === null) return { ok: false, error: 'bad_paidDate' };
    const method = creditStr_(record.method, 40);
    if (status === 'paid' && (!paidDate || !method)) return { ok: false, error: 'paid_requires_paidDate_method' };

    const out = {
      id:               wantId,
      patientId:        patientId,
      patientKey:       patientKey,
      patientName:      creditStr_(record.patientName, 120),
      houseId:          houseId,
      facilityType:     facilityType,
      creditType:       creditType,
      allocationMonth:  month,
      calculatedAmount: calculated,
      amount:           amount,
      overrideReason:   amount !== calculated ? overrideReason : '',
      reason:           reason,
      approvedBy:       creditStr_(record.approvedBy, 40),
      decidedDate:      decidedDate,
      payoutDate:       creditPayoutDate_(decidedDate, wantId ? existingPayout : null),
      status:           status,
      paidDate:         status === 'paid' ? paidDate : '',
      method:           method,
      notes:            creditStr_(record.notes, 500),
      basis:            String(record.basis == null ? '' : record.basis).slice(0, 4000),
      createdAt:        String(record.createdAt || nowIso),
      createdBy:        String(record.createdBy == null ? '' : record.createdBy),
      updatedAt:        nowIso,
      updatedBy:        stampUser,
      /* Stable external key. On an EDIT the sheet's value is carried verbatim
       * (record is a copy of the sheet row); on a CREATE — and on an edit of a
       * legacy row that pre-dates the column — one is minted. Never re-minted
       * once present, whatever else the edit changes. */
      creditUid:        creditStr_(record.creditUid, 60) || (CREDIT_UID_PREFIX + Utilities.getUuid()),
    };

    if (!targetRow) {
      /* Duplicate guard (CHANGELOG-duplicate-discharges.md): never a second
       * OPEN (non-cancelled) credit for the same stay (patientKey, normalized
       * like the discharge stay key) and the same rule (creditType +
       * allocationMonth). A manual 'other' credit is a duplicate only when its
       * amount and reason match too (a retry), since two distinct manual
       * credits in one month are legitimate. → answer the existing row,
       * write nothing. */
      const wantStay = creditStayKey_({ patientKey: patientKey });
      for (let i = 0; i < existing.length && wantStay; i++) {
        const c = {};
        for (let j = 0; j < CREDIT_COLUMNS.length; j++) c[CREDIT_COLUMNS[j]] = existing[i][j];
        if (!creditOpen_(c) || creditStayKey_(c) !== wantStay) continue;
        if (String(c.creditType) !== creditType || String(c.allocationMonth) !== month) continue;
        if (creditType === 'other' &&
            (creditAmount_(c.amount) !== amount || creditStr_(c.reason, 1000) !== reason)) continue;
        console.log('[credit] duplicate refused: stay already has open credit ' + c.id);
        return { ok: true, duplicate: true, id: String(c.id), credit: c };
      }
      // Mint: seq = rows already carrying this patientId + month, plus one.
      const pIdx = CREDIT_COLUMNS.indexOf('patientId');
      const mIdx = CREDIT_COLUMNS.indexOf('allocationMonth');
      let seq = 1;
      for (let i = 0; i < existing.length; i++) {
        if (String(existing[i][pIdx]) === patientId && String(existing[i][mIdx]) === month) seq++;
      }
      out.id = creditId_(patientId, month, seq);
      targetRow = sh.getLastRow() + 1;
    }

    // Belt-and-suspenders over the whole-column '@' format getOrCreateSheet_
    // applies: force the text cells of THIS row before the values land.
    CREDIT_TEXT_COLUMNS.forEach(function (col) {
      const c = CREDIT_COLUMNS.indexOf(col);
      if (c >= 0) sh.getRange(targetRow, c + 1, 1, 1).setNumberFormat('@');
    });
    sh.getRange(targetRow, 1, 1, CREDIT_COLUMNS.length).setValues([objectToRow_(out, CREDIT_COLUMNS)]);

    logAudit_(wantId ? 'credit_updated' : 'credit_created', 'upsertCredit_', patientId, out.patientName, {
      id: out.id, patientKey: patientKey, facilityType: facilityType, creditType: creditType, allocationMonth: month,
      calculatedAmount: calculated, amount: amount, override: amount !== calculated,
      status: status, payoutDate: out.payoutDate, paidDate: out.paidDate, updatedBy: stampUser,
    });
    return wantId ? { ok: true, credit: out, updated: true } : { ok: true, credit: out, created: true };
  } finally {
    try { lock.releaseLock(); } catch (_) { /* no-op */ }
  }
}

/* True when every editable field `credit` sends already equals the stored
 * row `sheetObj` (amounts as numbers, dates as ISO days, the rest as trimmed
 * text). A field the payload leaves out is not compared. PURE. */
function creditEditAlreadyApplied_(credit, sheetObj) {
  const sent = CREDIT_EDITABLE_COLUMNS.filter(function (col) { return credit && credit[col] !== undefined; });
  if (!sent.length) return false;
  return sent.every(function (col) {
    const a = credit[col], b = sheetObj[col];
    if (col === 'amount' || col === 'calculatedAmount') return creditAmount_(a) === creditAmount_(b);
    if (/Date$/.test(col)) return creditDate_(a) === creditDate_(b);
    return String(a == null ? '' : a).trim() === String(b == null ? '' : b).trim();
  });
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
function upsertBillingOverride_(override, user) {
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
    // From the signed session cookie (handle_ → requestUser_), never the payload.
    updatedBy: String(user == null ? '' : user),
  };

  const lock = LockService.getScriptLock();
  if (lock.tryLock(10000) !== true) return lockBusy_('upsertBillingOverride_');
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
function deleteBillingOverride_(override, actor) {
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
  if (lock.tryLock(10000) !== true) return lockBusy_('deleteBillingOverride_');
  try {
    const sh = getOrCreateSheet_(BILLING_OVERRIDES_SHEET, BILLING_OVERRIDE_COLUMNS);
    const removed = deleteRowsById_(sh, BILLING_OVERRIDE_COLUMNS, id);
    logAudit_('billing_override_deleted', 'deleteBillingOverride_', String(override.patientId || ''), '',
      { id: id, removed: removed }, actor);
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
  // A Sheets date serial (a date-valued cell read back under a plain-text
  // format — see asISODate_): `new Date(46149)` would be 1970-01-01 + 46s,
  // so convert the serial's exact calendar day instead.
  if (typeof v === 'number' && isSheetDateSerial_(v)) {
    const p = sheetSerialToISODate_(v).split('-').map(Number);
    return new Date(p[0], p[1] - 1, p[2]);
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

/* ===== Monthly occupancy snapshots (permanent, append-only) ================
 *
 * WHY
 *   managersOverview_ recomputes a month's occupancy from the LIVE Patients
 *   sheet every time it is called. That is correct for the running month, but
 *   it means a finished month's numbers silently change whenever a historical
 *   patient row is edited, merged, repaired or discharged after the fact. This
 *   module writes each finished month's per-house occupancy into the
 *   `OccupancySnapshots` sheet ONCE, so the settled history stays settled.
 *
 * THE SHEET IS APPEND-ONLY
 *   Rows are never overwritten and never deleted — the only write in this
 *   module is a block appended below the last row. A (month, houseId) pair
 *   that is already present is SKIPPED, which makes every entry point
 *   idempotent: a second run of the same month appends zero rows. The
 *   existing-key check is re-read INSIDE the script lock so two concurrent
 *   runs (the monthly trigger and a manual backfill) can't both decide the
 *   same month is missing.
 *
 * NO DUPLICATED MATH
 *   snapshotMonth_ does NOT recompute occupancy. It calls managersOverview_ —
 *   the exact computation the Managers app reads — and projects its per-house
 *   numbers into snapshot rows. If the bonus/occupancy math ever changes,
 *   snapshots follow it automatically; there is no second implementation to
 *   drift.
 *
 * FINISHED MONTHS ONLY
 *   The running month is REFUSED (`month_not_finished`), because its
 *   occupancy is still accruing — a snapshot taken mid-month would freeze a
 *   partial figure permanently. Months are compared as 'YYYY-MM' strings,
 *   which orders correctly, against defaultMonth_() (Asia/Jerusalem — the
 *   project timezone pinned in appsscript.json).
 *
 * HOUSES AND CAPACITY
 *   Capacity is PINNED here rather than read from BonusConfig: a snapshot is
 *   a permanent historical record, and a later edit to the config sheet must
 *   not change what a past month's occupancy percentage meant. `houseId` uses
 *   the ids the ecosystem records for this feed (efroni's backend id is
 *   `arfoni`); managerHouse is the managersOverview_ key the row is read from.
 *
 * NO NEW SECRET, NO FINANCIAL DATA
 *   `doGet?action=occupancySnapshots` is read-only and sits on exactly the
 *   same access model as `managersOverview` — no new Script Property, no new
 *   auth check. The column contract below carries occupancy only: no billing,
 *   debt, rates, bonus or payment fields.
 */

const OCCUPANCY_SNAPSHOTS_SHEET = 'OccupancySnapshots';

/* FROZEN COLUMN CONTRACT — append-only. Never reorder or remove a column;
 * add new ones at the END only (getOrCreateSheet_ backfills the header row
 * non-destructively on the first write after deploy). */
const OCCUPANCY_SNAPSHOT_COLUMNS = [
  'month',         // 'YYYY-MM', stored as TEXT (the column is pinned to '@')
  'houseId',
  'treatmentDays',
  'daysInMonth',
  'avgDaily',
  'capacity',
  'occupancyPct',
  'manager',
  'capturedAt',    // ISO 8601 UTC timestamp of the run that wrote the row
];

/* The first month the snapshot history starts from — the same May 2026 anchor
 * the Managers app uses for its quarterly windows and history pickers. */
const OCCUPANCY_SNAPSHOT_FIRST_MONTH = '2026-05';

const OCCUPANCY_SNAPSHOT_TRIGGER_HANDLER = 'runMonthlyOccupancySnapshot';

/* Snapshot houses, with the capacity each occupancyPct is measured against.
 * managerHouse is the key in managersOverview_'s `houses` array. */
const OCCUPANCY_SNAPSHOT_HOUSES = [
  { houseId: 'raanana', managerHouse: 'raanana', capacity: 14 },
  { houseId: 'ramot',   managerHouse: 'ramot',   capacity: 20 },
  { houseId: 'arfoni',  managerHouse: 'efroni',  capacity: 13 },
  { houseId: 'rehab',   managerHouse: 'rehab',   capacity: 13 },
  { houseId: 'pardes',  managerHouse: 'pardes',  capacity: 13 },
];

/* ----- Pure helpers (no GAS services — unit-tested directly) ----- */

function occupancySnapshotValidMonth_(ym) {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(String(ym == null ? '' : ym).trim());
}

/* True only for a month that is strictly BEFORE the current one. The running
 * month and any future month are refused. */
function occupancySnapshotIsFinishedMonth_(ym, currentYm) {
  if (!occupancySnapshotValidMonth_(ym)) return false;
  if (!occupancySnapshotValidMonth_(currentYm)) return false;
  return String(ym).trim() < String(currentYm).trim();
}

function occupancySnapshotRound_(n, decimals) {
  const v = Number(n);
  if (!isFinite(v)) return 0;
  const f = Math.pow(10, decimals);
  return Math.round(v * f) / f;
}

/* occupancyPct = avgDaily ÷ capacity × 100, rounded to ONE decimal. A missing
 * or zero capacity yields 0 rather than Infinity/NaN. */
function occupancyPct_(avgDaily, capacity) {
  const cap = Number(capacity);
  if (!isFinite(cap) || cap <= 0) return 0;
  return occupancySnapshotRound_((Number(avgDaily) / cap) * 100, 1);
}

/* Identity of a snapshot row: one row per month per house, forever. */
function occupancySnapshotKey_(month, houseId) {
  return String(month == null ? '' : month).trim() + '::' +
         String(houseId == null ? '' : houseId).trim();
}

/* Normalize a `month` cell back to 'YYYY-MM' text. The column is written as
 * text, but a human could reformat the sheet and hand us a Date — in which
 * case the LOCAL calendar month is the right reading (never a UTC slice). */
function occupancySnapshotMonthText_(v) {
  if (v === undefined || v === null) return '';
  // Object.prototype.toString rather than `instanceof Date`: a Date handed
  // back by Sheets does not always share this script's Date prototype.
  if (Object.prototype.toString.call(v) === '[object Date]') {
    if (isNaN(v.getTime())) return '';
    const m = v.getMonth() + 1;
    return String(v.getFullYear()) + '-' + (m < 10 ? '0' + m : String(m));
  }
  const s = String(v).trim();
  const m = s.match(/^(\d{4})-(\d{2})/);
  return m ? m[1] + '-' + m[2] : s;
}

/* { 'YYYY-MM::houseId': true } for every row already on the sheet. */
function occupancySnapshotExistingKeys_(rows) {
  const seen = {};
  const list = rows || [];
  for (let i = 0; i < list.length; i++) {
    const r = list[i] || {};
    seen[occupancySnapshotKey_(occupancySnapshotMonthText_(r.month), r.houseId)] = true;
  }
  return seen;
}

/* The idempotency filter: drop every candidate whose month+house is already
 * on the sheet, and de-duplicate within the candidate list itself. */
function occupancySnapshotNewRows_(candidateRows, existingKeys) {
  const out = [];
  const seen = {};
  const list = candidateRows || [];
  for (let i = 0; i < list.length; i++) {
    const r = list[i];
    if (!r) continue;
    const k = occupancySnapshotKey_(r.month, r.houseId);
    if (existingKeys && existingKeys[k]) continue;
    if (seen[k]) continue;
    seen[k] = true;
    out.push(r);
  }
  return out;
}

/* Project a managersOverview_ payload into snapshot rows. This is the ONLY
 * place snapshot numbers come from — treatmentDays and avgDaily are read off
 * the overview, not recomputed. A house that is absent from the payload, or
 * that had no patient-days at all that month, yields NO ROW. */
function occupancySnapshotRowsFromOverview_(ym, overview, capturedAt) {
  const rows = [];
  if (!overview || overview.ok === false || !Array.isArray(overview.houses)) return rows;

  const byKey = {};
  for (let i = 0; i < overview.houses.length; i++) {
    const h = overview.houses[i];
    if (h && h.key) byKey[String(h.key)] = h;
  }

  const nDays = daysInMonth_(String(ym));
  for (let i = 0; i < OCCUPANCY_SNAPSHOT_HOUSES.length; i++) {
    const spec = OCCUPANCY_SNAPSHOT_HOUSES[i];
    const h = byKey[spec.managerHouse];
    if (!h) continue;                                  // house missing from this month
    const treatmentDays = Number(h.treatmentDays) || 0;
    if (treatmentDays <= 0) continue;                  // no data for this house
    const avgDaily = occupancySnapshotRound_(Number(h.avgDaily) || 0, 2);
    rows.push({
      month:         String(ym),
      houseId:       spec.houseId,
      treatmentDays: treatmentDays,
      daysInMonth:   nDays,
      avgDaily:      avgDaily,
      capacity:      spec.capacity,
      occupancyPct:  occupancyPct_(avgDaily, spec.capacity),
      manager:       String((h && h.manager) || ''),
      capturedAt:    String(capturedAt || ''),
    });
  }
  return rows;
}

/* Stable read order for the feed: month ascending, then houseId ascending. */
function occupancySnapshotSortRows_(rows) {
  return (rows || []).slice().sort(function (a, b) {
    const am = String((a && a.month) || ''), bm = String((b && b.month) || '');
    if (am !== bm) return am < bm ? -1 : 1;
    const ah = String((a && a.houseId) || ''), bh = String((b && b.houseId) || '');
    if (ah !== bh) return ah < bh ? -1 : 1;
    return 0;
  });
}

/* Inclusive 'YYYY-MM' range. Empty when `lastYm` precedes `firstYm` (which is
 * what a backfill run before the anchor month must do — nothing). */
function occupancySnapshotMonthRange_(firstYm, lastYm) {
  const out = [];
  if (!occupancySnapshotValidMonth_(firstYm)) return out;
  if (!occupancySnapshotValidMonth_(lastYm)) return out;
  const first = String(firstYm).trim();
  const last  = String(lastYm).trim();
  if (last < first) return out;
  let y = Number(first.slice(0, 4));
  let m = Number(first.slice(5, 7));
  for (let guard = 0; guard < 1200; guard++) {
    const ym = String(y) + '-' + (m < 10 ? '0' + m : String(m));
    out.push(ym);
    if (ym === last) break;
    m++;
    if (m > 12) { m = 1; y++; }
  }
  return out;
}

/* ----- Sheet access ----- */

function occupancySnapshotSheet_() {
  return getOrCreateSheet_(OCCUPANCY_SNAPSHOTS_SHEET, OCCUPANCY_SNAPSHOT_COLUMNS);
}

function readOccupancySnapshots_() {
  const rows = readSheet_(occupancySnapshotSheet_(), OCCUPANCY_SNAPSHOT_COLUMNS);
  return rows.map(function (r) {
    return {
      month:         occupancySnapshotMonthText_(r.month),
      houseId:       String(r.houseId == null ? '' : r.houseId).trim(),
      treatmentDays: Number(r.treatmentDays) || 0,
      daysInMonth:   Number(r.daysInMonth) || 0,
      avgDaily:      Number(r.avgDaily) || 0,
      capacity:      Number(r.capacity) || 0,
      occupancyPct:  Number(r.occupancyPct) || 0,
      manager:       String(r.manager == null ? '' : r.manager),
      capturedAt:    String(r.capturedAt == null ? '' : r.capturedAt),
    };
  });
}

/* APPEND-ONLY write. Nothing here clears, overwrites or deletes a row: the
 * single setValues call targets getLastRow() + 1 and below. Wrapped in the
 * script lock, and the existing-key set is re-read inside it so a trigger run
 * and a manual backfill can never double-write the same month. */
function appendOccupancySnapshotRows_(rows) {
  const wanted = rows || [];
  if (wanted.length === 0) return { appended: 0, skipped: 0, rows: [] };

  const lock = LockService.getScriptLock();
  if (lock.tryLock(30000) !== true) throw new Error('appendOccupancySnapshotRows_: ' + LOCK_BUSY_MESSAGE);
  try {
    const sh = occupancySnapshotSheet_();
    const existingKeys = occupancySnapshotExistingKeys_(
      readSheet_(sh, OCCUPANCY_SNAPSHOT_COLUMNS));
    const fresh = occupancySnapshotNewRows_(wanted, existingKeys);
    if (fresh.length === 0) {
      return { appended: 0, skipped: wanted.length, rows: [] };
    }

    const monthIdx    = OCCUPANCY_SNAPSHOT_COLUMNS.indexOf('month');
    const capturedIdx = OCCUPANCY_SNAPSHOT_COLUMNS.indexOf('capturedAt');
    const target = sh.getLastRow() + 1;
    // Pin the text columns BEFORE the values land, so Sheets can never coerce
    // '2026-06' into a date-typed cell (the ordering upsertRowById_ relies on).
    sh.getRange(target, monthIdx + 1, fresh.length, 1).setNumberFormat('@');
    sh.getRange(target, capturedIdx + 1, fresh.length, 1).setNumberFormat('@');

    const values = fresh.map(function (r) {
      return objectToRow_(r, OCCUPANCY_SNAPSHOT_COLUMNS);
    });
    sh.getRange(target, 1, values.length, OCCUPANCY_SNAPSHOT_COLUMNS.length).setValues(values);
    return { appended: fresh.length, skipped: wanted.length - fresh.length, rows: fresh };
  } finally {
    try { lock.releaseLock(); } catch (_) { /* no-op */ }
  }
}

/* ----- The snapshot itself ----- */

/**
 * Snapshot one FINISHED month. Idempotent — a month+house already on the
 * sheet is skipped, never rewritten.
 *
 * @param {string} yyyyMm  month to snapshot, 'YYYY-MM'.
 * @param {{dryRun:boolean}=} opts  dry run reports what WOULD be written.
 */
function snapshotMonth_(yyyyMm, opts) {
  const ym = String(yyyyMm == null ? '' : yyyyMm).trim();
  const dryRun = !!(opts && opts.dryRun);

  if (!occupancySnapshotValidMonth_(ym)) {
    return { ok: false, error: 'bad_month', month: ym, appended: 0, wouldAppend: 0, skipped: 0, rows: [] };
  }
  const currentMonth = defaultMonth_();
  if (!occupancySnapshotIsFinishedMonth_(ym, currentMonth)) {
    return {
      ok: false, error: 'month_not_finished', month: ym, currentMonth: currentMonth,
      appended: 0, wouldAppend: 0, skipped: 0, rows: [],
    };
  }

  // THE shared computation — no second occupancy implementation exists.
  const overview = managersOverview_(ym);
  const candidates = occupancySnapshotRowsFromOverview_(ym, overview, new Date().toISOString());

  if (dryRun) {
    const fresh = occupancySnapshotNewRows_(
      candidates, occupancySnapshotExistingKeys_(readOccupancySnapshots_()));
    return {
      ok: true, month: ym, dryRun: true,
      appended: 0, wouldAppend: fresh.length,
      skipped: candidates.length - fresh.length, rows: fresh,
    };
  }

  const res = appendOccupancySnapshotRows_(candidates);
  return {
    ok: true, month: ym, dryRun: false,
    appended: res.appended, wouldAppend: res.appended,
    skipped: res.skipped, rows: res.rows,
  };
}

/**
 * TRIGGER HANDLER — snapshots the PREVIOUS month. Runs on the 1st of each
 * month (see installOccupancySnapshotTrigger), by which time the previous
 * month is finished. Asia/Jerusalem, via defaultMonth_/offsetMonth_.
 */
function runMonthlyOccupancySnapshot() {
  const month = offsetMonth_(defaultMonth_(), 1);
  const res = snapshotMonth_(month);
  Logger.log('[occupancy-snapshot] monthly run ' + month + ': appended ' + res.appended +
             ', skipped ' + res.skipped + (res.error ? ' — ' + res.error : ''));
  return res;
}

/**
 * ONE-TIME SETUP — run from the Apps Script editor. Idempotent: deletes EVERY
 * existing trigger bound to runMonthlyOccupancySnapshot (so duplicates from a
 * repeated run are removed) and installs exactly one time-driven trigger on
 * day 1 of each month, in the 03:00–04:00 slot (project timezone
 * Asia/Jerusalem). Apps Script schedules hourly time-driven triggers within
 * the requested hour, so atHour(3) means "some minute between 03:00 and
 * 04:00" — off the nightly integrity job's ~02:30 run.
 */
function installOccupancySnapshotTrigger() {
  const triggers = ScriptApp.getProjectTriggers();
  let removed = 0;
  for (let i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === OCCUPANCY_SNAPSHOT_TRIGGER_HANDLER) {
      ScriptApp.deleteTrigger(triggers[i]);
      removed++;
    }
  }
  ScriptApp.newTrigger(OCCUPANCY_SNAPSHOT_TRIGGER_HANDLER)
    .timeBased()
    .onMonthDay(1)
    .atHour(3)
    .create();

  const res = {
    ok: true,
    handler: OCCUPANCY_SNAPSHOT_TRIGGER_HANDLER,
    removed: removed,
    installed: 1,
    monthDay: 1,
    hour: 3,
  };
  Logger.log('[occupancy-snapshot] trigger installed: removed ' + removed +
             ' existing trigger(s), exactly one monthly trigger now runs ' +
             OCCUPANCY_SNAPSHOT_TRIGGER_HANDLER + ' on day 1 @ 03:00–04:00 (Asia/Jerusalem).');
  return res;
}

/* Shared body of the backfill / preview pair. Walks
 * OCCUPANCY_SNAPSHOT_FIRST_MONTH → the last FINISHED month and logs one line
 * per month. Idempotent in both modes. */
function occupancySnapshotBackfill_(dryRun) {
  const currentMonth = defaultMonth_();
  const lastFinished = offsetMonth_(currentMonth, 1);
  const months = occupancySnapshotMonthRange_(OCCUPANCY_SNAPSHOT_FIRST_MONTH, lastFinished);
  const label = dryRun ? '[occupancy-snapshot] (dry run) ' : '[occupancy-snapshot] ';

  const summary = [];
  let appended = 0;
  let skipped = 0;

  for (let i = 0; i < months.length; i++) {
    const month = months[i];
    const res = snapshotMonth_(month, { dryRun: !!dryRun });
    const n = dryRun ? (res.wouldAppend || 0) : (res.appended || 0);
    appended += n;
    skipped  += (res.skipped || 0);
    summary.push({
      month: month,
      ok: res.ok !== false,
      appended: n,
      skipped: res.skipped || 0,
      error: res.error || null,
    });
    Logger.log(label + month + ': ' + (dryRun ? 'would append ' : 'appended ') + n +
               ' row(s), skipped ' + (res.skipped || 0) +
               (res.error ? ' — ' + res.error : ''));
  }

  Logger.log(label + 'TOTAL ' + OCCUPANCY_SNAPSHOT_FIRST_MONTH + ' → ' + lastFinished +
             ': ' + months.length + ' month(s), ' +
             (dryRun ? 'would append ' : 'appended ') + appended +
             ' row(s), skipped ' + skipped + '.');

  return {
    ok: true,
    dryRun: !!dryRun,
    firstMonth: OCCUPANCY_SNAPSHOT_FIRST_MONTH,
    lastMonth: lastFinished,
    currentMonth: currentMonth,
    months: months.length,
    appended: appended,
    skipped: skipped,
    summary: summary,
  };
}

/* PUBLIC (Run dropdown) — writes 2026-05 → the last finished month. Safe to
 * re-run: months already on the sheet are skipped. */
function backfillOccupancySnapshotsNow() {
  return occupancySnapshotBackfill_(false);
}

/* PUBLIC (Run dropdown) — same walk, DRY RUN. Writes nothing. */
function previewOccupancySnapshotsNow() {
  return occupancySnapshotBackfill_(true);
}

/* ----- Read-only feed ----- */

/* doGet?action=occupancySnapshots → { ok:true, rows:[...] }, sorted by month
 * then houseId. Read-only; same access model as managersOverview. */
function occupancySnapshots_() {
  return { ok: true, rows: occupancySnapshotSortRows_(readOccupancySnapshots_()) };
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
 * path. It also recomputes the rows in full every time, but skips the WRITE
 * when they equal what the digest already holds (most saves don't touch the
 * active population) — `updatedAt` then keeps the time of the last write. The
 * hourly backstop always writes, so `updatedAt` is never more than ~1h old.
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

/* What the digest tab holds, as one fastHash_ of the target spreadsheet id
 * and every row's house/patientName/patientId — updatedAt excluded, it is the
 * rebuild time, not content. Order-insensitive: the tab is a SET of residents
 * (nothing in the contract depends on row order), so a Patients sheet that
 * merely reordered does not force a rewrite. Recorded by writeDigestRows_
 * under the lock. */
const DIGEST_WRITTEN_SIG_KEY = 'digest:writtenSig:v1';
const DIGEST_WRITTEN_SIG_TTL = 21600;   // 6 h, CacheService's maximum

function digestSignature_(ssId, rows) {
  const lines = rows.map(function (r) { return JSON.stringify([r.house, r.patientName, r.patientId]); });
  lines.sort();
  return fastHash_(JSON.stringify([ssId, lines]));
}

/* Whole-tab replace: clear the body and write the current row set. Locked so a
 * request-driven rebuild and the hourly trigger can't interleave writes.
 * `signature` (optional, digestSignature_ of `rows`): recorded once the write
 * lands, so an identical request-path rebuild can skip it. */
function writeDigestRows_(ssId, rows, signature) {
  const lock = LockService.getScriptLock();
  if (lock.tryLock(10000) !== true) throw new Error('writeDigestRows_: ' + LOCK_BUSY_MESSAGE);
  try {
    // Forget the old record BEFORE touching the tab: a write that fails half
    // way must never leave a record that lets the next rebuild skip.
    cacheRemove_(DIGEST_WRITTEN_SIG_KEY);
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
    // Recorded only while holding the lock, where writers are ordered (a
    // busy lock threw above, before anything was touched).
    if (signature) {
      cachePutJson_(DIGEST_WRITTEN_SIG_KEY, signature, DIGEST_WRITTEN_SIG_TTL);
    }
  } finally {
    try { lock.releaseLock(); } catch (_) { /* no-op */ }
  }
}

/* Rebuild the whole digest from the current Patients sheet (active residents).
 * Returns a small status object; no-ops with a clear error if setup hasn't run
 * yet. `opts.skipIfUnchanged` (the request path only): the rows are still
 * recomputed in full, but when they equal what the digest already holds the
 * write — opening a second spreadsheet, clearing and rewriting its body — is
 * skipped ({ skipped: true }). The hourly backstop and setup never skip. */
function rebuildActivePatientsDigest_(opts) {
  const ssId = getDigestSpreadsheetId_();
  if (!ssId) return { ok: false, error: 'digest_not_configured' };
  // A READ of Patients: no whole-column re-format here (see sheetForRead_).
  const patientsSh = sheetForRead_(PATIENTS_SHEET, PATIENT_COLUMNS);
  const patients   = readSheet_(patientsSh, PATIENT_COLUMNS);
  const nowIso     = new Date().toISOString();
  const rows       = buildActivePatientsRows_(patients, nowIso);
  const signature  = digestSignature_(ssId, rows);
  if (opts && opts.skipIfUnchanged && cacheGetJson_(DIGEST_WRITTEN_SIG_KEY) === signature) {
    return { ok: true, count: rows.length, skipped: true };
  }
  writeDigestRows_(ssId, rows, signature);
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
    // Setup hasn't run → digest_not_configured, nothing read or written.
    rebuildActivePatientsDigest_({ skipIfUnchanged: true });
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
 *      normalizeBillingOverride) must match a live Patients row, a
 *      DischargedPatients row or a tombstone (names compared through
 *      normalizeNameKey_ on both sides); unmatched → alert. The orphan
 *      list is worked down by reconcileOrphanPaymentsNow (below).
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

/* Shared NAME normalizer for the integrity checker and the orphan-payments
 * reconciler (NOT for row identity — patientKey_ / the saveAll merge keep
 * comparing the raw trimmed name, so a whitespace edit still behaves as it
 * always did): NFC, every internal whitespace run collapsed to one space,
 * trimmed. 'אורנה  אשכנזי' (double space) and 'אורנה אשכנזי' compare equal;
 * a decomposed and a precomposed form of the same glyph compare equal. */
function normalizeNameKey_(s) {
  let str = String(s == null ? '' : s);
  if (typeof str.normalize === 'function') str = str.normalize('NFC');
  return str.replace(/\s+/g, ' ').trim();
}

/* The integrity checker's comparison key: patientKey_ over the NORMALIZED
 * name (normalizeNameKey_). Every set the checker builds (live, discharged,
 * tombstones) and every key it looks up (sentinel list, Payments /
 * BillingOverrides patientId) goes through this, so whitespace drift alone
 * can never read as an orphan or a lost row. */
function integrityKey_(houseId, name, date) {
  return patientKey_(houseId, normalizeNameKey_(name), date);
}

/* Split a stored triple ('houseId::name::YYYY-MM-DD') into its parts. The
 * date is the LAST segment (a name containing '::' keeps working); fewer
 * than 3 segments → null (malformed). */
function integritySplitKey_(key) {
  const parts = String(key == null ? '' : key).split('::');
  if (parts.length < 3) return null;
  return { houseId: parts[0], name: parts.slice(1, parts.length - 1).join('::'), date: parts[parts.length - 1] };
}

/* Re-key a stored triple ('houseId::name::YYYY-MM-DD', from a payments /
 * overrides patientId cell or a persisted snapshot) through integrityKey_ so
 * both sides of every comparison share trimming + name normalization + date
 * normalization. Anything with fewer than 3 segments is returned trimmed —
 * it can never match a live key, which is exactly the alert we want for a
 * malformed cell. */
function integrityNormalizeKey_(key) {
  const parts = integritySplitKey_(key);
  if (!parts) return String(key == null ? '' : key).trim();
  return integrityKey_(parts.houseId, parts.name, parts.date);
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

  // A tombstone with ANY reason ('user-delete', 'saveAll-omitted-preserved',
  // or the reconciler's 'legacy_orphan_payment') means the disappearance was
  // RECORDED — only an unrecorded one alerts. Keys are integrityKey_ (name
  // normalized) on EVERY side below, so whitespace drift never alerts.
  const tombstoneKeySet = {};
  try {
    const tombSh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(PATIENTS_TOMBSTONES_SHEET);
    const tombs = tombSh ? readSheet_(tombSh, PATIENT_TOMBSTONE_COLUMNS) : [];
    for (let t = 0; t < tombs.length; t++) {
      const tk = integrityKey_(tombs[t].houseId, tombs[t].name, tombs[t].date);
      if (tk) tombstoneKeySet[tk] = true;
    }
  } catch (err) { errors.push('קריאת PatientsTombstones נכשלה: ' + err); }

  const currentKeys = [], liveKeySet = {};
  for (let c = 0; c < patientRows.length; c++) {
    const key = integrityKey_(patientRows[c].houseId, patientRows[c].name, patientRows[c].date);
    if (key && key !== '::::') { currentKeys.push(key); liveKeySet[key] = true; }
  }

  // DischargedPatients rows are KNOWN patients for the orphan sweep (check 2)
  // — a payment keyed to a discharged patient is history, not an orphan.
  // Deliberately NOT part of the sentinel (check 1): discharge is a status
  // flip that keeps the Patients row, so a live row vanishing is still a
  // loss even when a discharge audit row exists for it.
  const knownKeySet = {};
  for (const lk in liveKeySet) knownKeySet[lk] = true;
  try {
    const dischargedSh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(DISCHARGED_PATIENTS_SHEET);
    const discharged = dischargedSh ? readSheet_(dischargedSh, DISCHARGED_PATIENT_COLUMNS) : [];
    for (let d = 0; d < discharged.length; d++) {
      const dk = integrityKey_(discharged[d].houseId, discharged[d].name, discharged[d].date);
      if (dk && dk !== '::::') knownKeySet[dk] = true;
    }
  } catch (err) { errors.push('קריאת DischargedPatients נכשלה: ' + err); }

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
    orphanPayments = integrityOrphanKeys_(paymentRows, integrityParsePaymentPatientId_, knownKeySet, tombstoneKeySet);
  } catch (err) { errors.push('בדיקת תשלומים יתומים נכשלה: ' + err); }
  try {
    orphanOverrides = integrityOrphanKeys_(overrideRows, integrityParseOverridePatientId_, knownKeySet, tombstoneKeySet);
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

/* ===== Orphan-payments reconciler (Run dropdown only) =======================
 *
 * Works down nightlyIntegrityJob's "Payments rows with no live Patients row
 * and no PatientsTombstones row" list. The live list is dominated by three
 * causes, none of which is a real data loss:
 *   1. the payment's patientId / id / patientName still carry a U+FFFD
 *      spelling (the name-repair pipeline, PRs #105–#108, rewrote Patients
 *      but Payments had no row identity to relocate by — its rows were
 *      classified 'manual' and never touched);
 *   2. whitespace drift (a double space inside the name) — the checker used
 *      to compare exact strings;
 *   3. true legacy orphans — patients deleted / collapsed before the
 *      PatientsTombstones sheet existed.
 *
 * Two PUBLIC entry points (Run dropdown), unreachable over HTTP — handle_'s
 * fixed action allow-list never names them (guard-tested, same non-exposure
 * argument as scanCorruptedRowsNow / repairPatientExitDatesNow):
 *   previewOrphanPaymentsNow   — ZERO writes; Logger.logs the exact plan.
 *   reconcileOrphanPaymentsNow — the same plan, executed under the script
 *                                lock. Idempotent: a second run plans and
 *                                writes NOTHING (no cell, no tombstone, no
 *                                AuditLog row).
 *
 * Detection = the checker's rule on RAW keys: a payment's patientId triple
 * (healed from the deterministic 'pay::…' id when blank, exactly as
 * integrityOrphanKeys_ does) that matches no Patients, DischargedPatients or
 * PatientsTombstones key. Raw (patientKey_, trim-only) rather than the
 * checker's normalized key ON PURPOSE: the hardened checker already tolerates
 * whitespace drift, but the drifted cells stay wrong on the sheet and the
 * client (app.js patientKey / paymentId, exact strings) still cannot match
 * them to their patient — the reconciler fixes the cells.
 *
 * Per orphan key (house::name::date), candidates = Patients ∪
 * DischargedPatients ∪ PatientsTombstones rows of the SAME house whose name
 * is clean (no U+FFFD — a corrupted candidate can never be canonical, and a
 * 'legacy_orphan_payment' tombstone carrying an as-is corrupted name must not
 * pollute the pool). Names compare through normalizeNameKey_:
 *   - exact normalized match (whitespace-only drift), else
 *   - the U+FFFD wildcard: orphanPaymentNameRegex_ — corruptionWildcardRegex_'s
 *     run rule (a run of replacement characters stands for 1+ original
 *     characters, ordered, anchored), tightened so a run of N stands for at
 *     most N characters (each lost byte produced ONE U+FFFD, and a character
 *     is at least one byte — so a run can never stand for MORE characters
 *     than its length).
 *   → exactly ONE distinct canonical name, with a candidate at the payment's
 *     entry date: RENAME — single-cell writes of patientId (the new triple),
 *     patientName (the canonical name) and, when the deterministic id parses
 *     and embeds the old name, id ('pay::house::canonical::date::dueDate' —
 *     the client's upsert key, paymentForPatientOnDate looks payments up BY
 *     id, so a stale id would leave the row invisible to its patient and a
 *     duplicate would be minted). amount / dueDate / status / amountPaid /
 *     balance / timestamp are never touched; nothing is re-stamped (Payments
 *     carries no updatedAt; `timestamp` is left as-is).
 *   → DUPLICATE (follow-up to PR #118): the rewritten id would COLLIDE with a
 *     row already on the sheet (the client already minted the canonical
 *     payment for that month) or with a same-key twin renamed in this run.
 *     The corrupted row and its twin are compared on every PAYMENT_COLUMNS
 *     field EXCEPT the identity columns (id / patientId / patientName) and
 *     the stamp columns (ORPHAN_PAYMENT_DUP_IGNORE — `timestamp`, plus
 *     updatedAt/updatedBy should Payments ever grow them): strings trimmed +
 *     normalizeNameKey_, amounts numerically coerced, dueDate through
 *     asISODate_, status through the client's alias table. ALL equal → the
 *     corrupted row is a stray twin and is DELETED (deleteRow, bottom-up so
 *     row numbers stay valid; the deleted values ride in the AuditLog
 *     payload so the row is recoverable). ANY difference → SKIPPED with
 *     reason 'duplicate row differs' and the differing fields + both values
 *     in detail — never deleted, never merged.
 *   → REKEY (follow-up to PR #118): exactly one canonical name but NO
 *     candidate at the payment's entry date. When that name belongs to a
 *     LIVE Patients row with exactly one distinct entry date (an entry-date
 *     edit — the payment followed the old key), the payment is re-keyed to
 *     the patient's CURRENT date: patientId / patientName / id rewritten
 *     (single cells, same collision guard → duplicate rules above);
 *     dueDate and every other column untouched. When the only match is a
 *     DischargedPatients row or a tombstone (or live rows disagree on the
 *     date — a readmission), SKIPPED: a machine must not pick.
 *   → zero or 2+ canonical names: one PatientsTombstones row per orphan key
 *     — house, the payment's name AS-IS, the payment's entry date, reason
 *     ORPHAN_PAYMENT_TOMBSTONE_REASON ('legacy_orphan_payment'),
 *     savedByAction 'reconcileOrphanPaymentsNow', notes naming the payment
 *     ids and why (no candidate / the ambiguous candidates). Existing
 *     PATIENT_TOMBSTONE_COLUMNS, values mapped by name — no schema change.
 *     The checker then treats the key as recorded (any reason silences).
 * Nothing but a byte-equivalent stray twin is ever deleted, and its values
 * are audited first. One 'orphan_payments_reconciled' AuditLog event per run
 * that wrote anything. */

const ORPHAN_PAYMENT_TOMBSTONE_REASON = 'legacy_orphan_payment';
const ORPHAN_PAYMENT_RECONCILE_FN     = 'reconcileOrphanPaymentsNow';
const ORPHAN_PAYMENT_PREVIEW_FN       = 'previewOrphanPaymentsNow';
/* Columns the duplicate check IGNORES: identity (rewritten by the rename
 * itself) and stamps (who/when — not content). Everything else in
 * PAYMENT_COLUMNS must agree before a stray twin may be deleted. */
const ORPHAN_PAYMENT_DUP_IGNORE = ['id', 'patientId', 'patientName', 'timestamp', 'updatedAt', 'updatedBy'];
/* Mirror of app.js PAYMENT_STATUS_ALIASES — 'שולם' and 'paid' are the same
 * status for the duplicate comparison. */
const ORPHAN_PAYMENT_STATUS_ALIASES = {
  'שולם': 'paid', 'paid': 'paid',
  'שולם חלקית': 'partial', 'partial': 'partial',
  'לא שולם': 'unpaid', 'unpaid': 'unpaid',
};

/* ---- pure helpers (no GAS services — exercised directly by node --test) ---- */

/* Anchored regex from a (possibly corrupted) payment name, applied to
 * NORMALIZED names on both sides: every clean character is escaped and
 * matched literally; a run of N U+FFFD stands for 1..N arbitrary
 * characters. A clean name yields an exact-match regex. */
function orphanPaymentNameRegex_(name) {
  const n = normalizeNameKey_(name);
  let src = '^';
  let run = 0;
  const flush = function () {
    if (run > 0) src += '[\\s\\S]{1,' + run + '}';
    run = 0;
  };
  for (let i = 0; i < n.length; i++) {
    const ch = n.charAt(i);
    if (ch === CORRUPTION_MARK) { run++; continue; }
    flush();
    src += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  flush();
  return new RegExp(src + '$');
}

/* Distinct canonical names (normalized) among same-house clean candidates
 * that the payment name resolves to: the exact normalized match when there
 * is one, else the wildcard matches when the name is corrupted. Returns
 * [{norm, raw, sameDate, liveDates}] — raw is the sheet spelling to WRITE
 * (the first same-date candidate's, else the first seen), sameDate whether
 * any candidate with that name carries the payment's entry date, liveDates
 * the distinct 'YYYY-MM-DD' entry dates of the LIVE Patients rows carrying
 * that name (the rekey targets; discharged / tombstone rows never count). */
function orphanPaymentMatches_(paymentName, paymentDateISO, houseCandidates) {
  const want = normalizeNameKey_(paymentName);
  const byNorm = {};
  const order = [];
  for (let i = 0; i < houseCandidates.length; i++) {
    const c = houseCandidates[i];
    const norm = c.norm;
    if (!byNorm[norm]) { byNorm[norm] = { norm: norm, raw: c.raw, sameDate: false, liveDates: [], liveRawByDate: {} }; order.push(norm); }
    const m = byNorm[norm];
    if (c.date === paymentDateISO && !m.sameDate) {
      m.sameDate = true;
      m.raw = c.raw; // prefer the same-date row's spelling
    }
    if (c.live && c.date && m.liveDates.indexOf(c.date) < 0) {
      m.liveDates.push(c.date);
      m.liveRawByDate[c.date] = c.raw;
    }
  }
  if (byNorm[want]) return [byNorm[want]];
  if (!hasCorruption_(want)) return [];
  const re = orphanPaymentNameRegex_(want);
  const out = [];
  for (let j = 0; j < order.length; j++) {
    if (re.test(order[j])) out.push(byNorm[order[j]]);
  }
  return out;
}

/* Comparable form of one Payments cell for the duplicate check. */
function orphanPaymentFieldKey_(column, v) {
  if (column === 'amount' || column === 'amountPaid' || column === 'balance') return Number(v) || 0;
  if (column === 'dueDate') return asISODate_(v);
  if (column === 'status') {
    const raw = normalizeNameKey_(v);
    return ORPHAN_PAYMENT_STATUS_ALIASES[raw] || ORPHAN_PAYMENT_STATUS_ALIASES[raw.toLowerCase()] || raw.toLowerCase();
  }
  return normalizeNameKey_(v);
}

/* Fields on which two Payments row objects DIFFER, ignoring identity and
 * stamp columns (ORPHAN_PAYMENT_DUP_IGNORE). [] → byte-equivalent twins. */
function orphanPaymentDiffFields_(a, b) {
  const diffs = [];
  for (let i = 0; i < PAYMENT_COLUMNS.length; i++) {
    const col = PAYMENT_COLUMNS[i];
    if (ORPHAN_PAYMENT_DUP_IGNORE.indexOf(col) >= 0) continue;
    const av = orphanPaymentFieldKey_(col, a[col]);
    const bv = orphanPaymentFieldKey_(col, b[col]);
    if (av !== bv) diffs.push({ field: col, row: a[col] == null ? '' : a[col], twin: b[col] == null ? '' : b[col] });
  }
  return diffs;
}


/* Build the reconcile plan. Pure.
 *   paymentRows — [{rowNumber, obj}] Payments rows (corruptionReadRows_ shape)
 *   candidates  — [{houseId, name, date, source?}] Patients ∪
 *                 DischargedPatients ∪ PatientsTombstones rows (date already
 *                 'YYYY-MM-DD'; source = sheet name, absent → live Patients)
 *   knownKeySet — {rawKey: true} over the same rows (patientKey_, trim-only)
 * Returns {scanned, orphanKeys, renames, rekeys, duplicates, tombstones, skipped}:
 *   renames    — [{rowNumber, key, newKey, oldName, newName, cells:[{column,from,to}]}]
 *   rekeys     — same shape + oldDate, newDate (entry date changed)
 *   duplicates — [{rowNumber, twinRowNumber, key, twinId, values}] rows to
 *                DELETE (values = the row in PAYMENT_COLUMNS order, for the audit)
 *   tombstones — [{houseId, name, date, key, paymentIds, why}]
 *   skipped    — [{key, rowNumber?, reason, detail}] */
function orphanPaymentsPlan_(paymentRows, candidates, knownKeySet) {
  const plan = { scanned: 0, orphanKeys: 0, renames: [], rekeys: [], duplicates: [], tombstones: [], skipped: [] };
  const rows = paymentRows || [];
  plan.scanned = rows.length;

  // Every id currently on the sheet → its first row — the rename's collision
  // guard AND the duplicate check's twin lookup. A rename planned in this run
  // registers its target id too, so a same-key twin with the same dueDate
  // compares against its renamed sibling instead of getting the same id.
  const rowById = {};
  for (let r = 0; r < rows.length; r++) {
    const idv = String(rows[r].obj.id == null ? '' : rows[r].obj.id).trim();
    if (idv && !rowById[idv]) rowById[idv] = rows[r];
  }

  // Same-house clean candidate pools, keyed by trimmed houseId.
  const poolByHouse = {};
  for (let c = 0; c < (candidates || []).length; c++) {
    const cand = candidates[c];
    const house = String(cand.houseId == null ? '' : cand.houseId).trim();
    const raw = String(cand.name == null ? '' : cand.name).trim();
    if (!house || !raw || hasCorruption_(raw)) continue;
    if (!poolByHouse[house]) poolByHouse[house] = [];
    const live = cand.source === undefined || cand.source === null || cand.source === '' || cand.source === PATIENTS_SHEET;
    poolByHouse[house].push({ norm: normalizeNameKey_(raw), raw: raw, date: asISODate_(cand.date), live: live });
  }

  // Group orphan payment rows by RAW key (the checker's rule, un-normalized).
  const byKey = {};
  const keyOrder = [];
  for (let i = 0; i < rows.length; i++) {
    const obj = rows[i].obj || {};
    let pid = obj.patientId == null ? '' : String(obj.patientId).trim();
    if (!pid) pid = integrityParsePaymentPatientId_(obj.id);
    if (!pid) continue; // nothing to attribute — the checker skips it too
    const parts = integritySplitKey_(pid);
    if (!parts) {
      plan.skipped.push({ key: pid, rowNumber: rows[i].rowNumber, reason: 'malformed patientId', detail: pid });
      continue;
    }
    const key = patientKey_(parts.houseId, parts.name, parts.date);
    if (knownKeySet[key]) continue; // not an orphan
    if (!byKey[key]) {
      byKey[key] = { houseId: String(parts.houseId).trim(), name: String(parts.name).trim(), date: asISODate_(parts.date), rows: [] };
      keyOrder.push(key);
    }
    byKey[key].rows.push(rows[i]);
  }
  plan.orphanKeys = keyOrder.length;

  // Plan the identity rewrite of every row of an orphan key to (newName,
  // newDate). bucket = 'renames' | 'rekeys'. A target id already held by
  // another row (on the sheet, or claimed earlier in this run) routes the row
  // through the duplicate rules instead.
  const planRewrite = function (key, g, newName, newDate, bucket) {
    const newKey = patientKey_(g.houseId, newName, newDate);
    for (let r = 0; r < g.rows.length; r++) {
      const row = g.rows[r];
      const obj = row.obj;
      const cells = [];
      const curPid = String(obj.patientId == null ? '' : obj.patientId);
      if (curPid !== newKey) cells.push({ column: 'patientId', from: curPid, to: newKey });
      const curName = String(obj.patientName == null ? '' : obj.patientName);
      if (curName !== newName) cells.push({ column: 'patientName', from: curName, to: newName });
      const curId = String(obj.id == null ? '' : obj.id);
      const idParts = curId.split('::');
      if (idParts.length === 5 && idParts[0] === 'pay') {
        const newId = ['pay', g.houseId, newName, newDate, idParts[4]].join('::');
        if (newId !== curId) {
          const twin = rowById[newId];
          if (twin) {
            const diffs = orphanPaymentDiffFields_(obj, twin.obj);
            if (diffs.length === 0) {
              plan.duplicates.push({ rowNumber: row.rowNumber, twinRowNumber: twin.rowNumber, key: key, twinId: newId, values: objectToRow_(obj, PAYMENT_COLUMNS) });
            } else {
              plan.skipped.push({
                key: key, rowNumber: row.rowNumber, reason: 'duplicate row differs',
                detail: 'twin row ' + twin.rowNumber + ' (' + newId + '): ' +
                  diffs.map(function (d) { return d.field + ' ' + JSON.stringify(d.row) + ' vs ' + JSON.stringify(d.twin); }).join('; '),
              });
            }
            continue;
          }
          cells.push({ column: 'id', from: curId, to: newId });
          rowById[newId] = row; // claim it: a same-key twin with the same dueDate compares against this row
        }
      }
      if (cells.length === 0) continue; // nothing to change on this row
      const entry = { rowNumber: row.rowNumber, key: key, newKey: newKey, oldName: g.name, newName: newName, cells: cells };
      if (bucket === 'rekeys') { entry.oldDate = g.date; entry.newDate = newDate; }
      plan[bucket].push(entry);
    }
  };

  for (let k = 0; k < keyOrder.length; k++) {
    const key = keyOrder[k];
    const g = byKey[key];
    const paymentIds = g.rows.map(function (r) { return String(r.obj.id == null ? '' : r.obj.id); });
    const matches = orphanPaymentMatches_(g.name, g.date, poolByHouse[g.houseId] || []);

    if (matches.length === 1) {
      const m = matches[0];
      if (m.sameDate) {
        planRewrite(key, g, m.raw, g.date, 'renames');
        continue;
      }
      if (m.liveDates.length === 1) {
        // Entry-date edit: the LIVE patient carries the name at one other
        // date — the payment follows it. Discharged / tombstone rows never
        // supply a target date.
        const newDate = m.liveDates[0];
        planRewrite(key, g, m.liveRawByDate[newDate], newDate, 'rekeys');
        continue;
      }
      plan.skipped.push({
        key: key,
        reason: m.liveDates.length === 0
          ? 'name matched at a different entry date — only a discharged / tombstone row, review manually'
          : 'name matched at a different entry date — live rows disagree on the date (' + m.liveDates.join(', ') + '), review manually',
        detail: m.raw,
      });
      continue;
    }

    const why = matches.length === 0
      ? 'no candidate'
      : 'ambiguous: ' + matches.map(function (m) { return m.raw; }).join(' | ');
    plan.tombstones.push({ houseId: g.houseId, name: g.name, date: g.date, key: key, paymentIds: paymentIds, why: why });
  }
  return plan;
}


/* ---- GAS-backed pieces ---- */

/* Candidate rows + the raw known-key set from Patients ∪ DischargedPatients ∪
 * PatientsTombstones. getSheetByName only — a missing sheet contributes
 * nothing and is never created here. */
function orphanPaymentCandidates_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const candidates = [];
  const knownKeySet = {};
  const sources = [
    { sheet: PATIENTS_SHEET,            columns: PATIENT_COLUMNS },
    { sheet: DISCHARGED_PATIENTS_SHEET, columns: DISCHARGED_PATIENT_COLUMNS },
    { sheet: PATIENTS_TOMBSTONES_SHEET, columns: PATIENT_TOMBSTONE_COLUMNS },
  ];
  sources.forEach(function (src) {
    const sh = ss.getSheetByName(src.sheet);
    if (!sh) return;
    const rows = readSheet_(sh, src.columns);
    for (let i = 0; i < rows.length; i++) {
      const date = asISODate_(rows[i].date);
      candidates.push({ houseId: rows[i].houseId, name: rows[i].name, date: date, source: src.sheet });
      const key = patientKey_(rows[i].houseId, rows[i].name, date);
      if (key && key !== '::::') knownKeySet[key] = true;
    }
  });
  return { candidates: candidates, knownKeySet: knownKeySet };
}

/* Append the plan's tombstone rows to PatientsTombstones (existing columns,
 * mapped by name via objectToRow_; the sheet is ensured so its text-forced
 * date/droppedAt columns are in place before the values land). */
function appendOrphanPaymentTombstones_(entries) {
  if (!entries || entries.length === 0) return;
  const sh = getOrCreateSheet_(PATIENTS_TOMBSTONES_SHEET, PATIENT_TOMBSTONE_COLUMNS);
  const nowIso = new Date().toISOString();
  const out = entries.map(function (e) {
    return objectToRow_({
      houseId:       e.houseId,
      name:          e.name,
      date:          e.date,
      notes:         'orphan payment (' + e.why + '); ' + e.paymentIds.length + ' payment row(s): ' + e.paymentIds.join(', '),
      droppedAt:     nowIso,
      reason:        ORPHAN_PAYMENT_TOMBSTONE_REASON,
      savedByAction: ORPHAN_PAYMENT_RECONCILE_FN,
    }, PATIENT_TOMBSTONE_COLUMNS);
  });
  sh.getRange(sh.getLastRow() + 1, 1, out.length, PATIENT_TOMBSTONE_COLUMNS.length).setValues(out);
}

/* Append one PaymentsTombstones row per deleted Payments row. `entries` are
 * the reconcile plan's duplicate entries — each carries `values`, the whole
 * deleted row in PAYMENT_COLUMNS order. deletedBy is '' because a repair run
 * from the Apps Script editor has no signed session behind it; the function
 * name travels in deletedByFn instead of a name nobody authenticated. */
function appendPaymentTombstones_(entries, reason, fnName) {
  if (!entries || entries.length === 0) return 0;
  const sh = getOrCreateSheet_(PAYMENTS_TOMBSTONES_SHEET, PAYMENT_TOMBSTONE_COLUMNS);
  const deletedAt = israelTimestamp_();
  const col = function (values, name) {
    const i = PAYMENT_COLUMNS.indexOf(name);
    if (i < 0 || !values || values[i] === undefined || values[i] === null) return '';
    return values[i];
  };
  const out = entries.map(function (e) {
    const v = e && e.values;
    return objectToRow_({
      paymentUid:     col(v, 'paymentUid'),
      sourceRecordId: col(v, 'id'),
      patientUid:     col(v, 'patientUid'),
      houseId:        col(v, 'houseId'),
      dueDate:        col(v, 'dueDate'),
      amount:         col(v, 'amount'),
      amountPaid:     col(v, 'amountPaid'),
      status:         col(v, 'status'),
      deletedAt:      deletedAt,
      deletedBy:      '',
      deletedByFn:    String(fnName || ''),
      reason:         String(reason || ''),
      values:         JSON.stringify(v || []).slice(0, 4000),
    }, PAYMENT_TOMBSTONE_COLUMNS);
  });
  sh.getRange(sh.getLastRow() + 1, 1, out.length, PAYMENT_TOMBSTONE_COLUMNS.length).setValues(out);
  return out.length;
}

function runOrphanPaymentsReconcile_(dryRun) {
  const tag = dryRun ? ORPHAN_PAYMENT_PREVIEW_FN : ORPHAN_PAYMENT_RECONCILE_FN;
  const lock = LockService.getScriptLock();
  if (lock.tryLock(30000) !== true) throw new Error(tag + ': ' + LOCK_BUSY_MESSAGE);
  try {
    /* DELIBERATELY NOT backfilling identity here. This repair's guarantees are
     * "single-cell writes to the three identity cells only" and "a dry run
     * performs ZERO writes"; minting uids inside it would widen both for a
     * function that runs by hand, rarely, on a corrupted sheet. getPayments_
     * mints them on every dashboard load, so in practice every row already
     * carries one by the time anyone runs this; a row that somehow does not
     * still tombstones with its sourceRecordId, which names it just as well.
     * (Operational note in CHANGELOG-accounting-source-feed.md: open the
     * dashboard once before running the repair.) */
    const paymentRows = corruptionReadRows_({ sheet: PAYMENTS_SHEET, columns: PAYMENT_COLUMNS }) || [];
    const cand = orphanPaymentCandidates_();
    const plan = orphanPaymentsPlan_(paymentRows, cand.candidates, cand.knownKeySet);

    const renameExamples = plan.renames.slice(0, 10).map(function (r) {
      return 'row ' + r.rowNumber + ': "' + r.oldName + '" → "' + r.newName + '" [' +
        r.cells.map(function (c) { return c.column; }).join(', ') + ']';
    });
    const rekeyExamples = plan.rekeys.slice(0, 10).map(function (r) {
      return 'row ' + r.rowNumber + ': ' + r.key + ' → ' + r.newKey + ' [' +
        r.cells.map(function (c) { return c.column; }).join(', ') + ']';
    });
    const dupExamples = plan.duplicates.slice(0, 10).map(function (d) {
      return 'row ' + d.rowNumber + (dryRun ? ' would be deleted' : ' deleted') + ' (stray twin of row ' + d.twinRowNumber + ', ' + d.twinId + ')';
    });
    const tombExamples = plan.tombstones.slice(0, 10).map(function (t) {
      return t.key + ' (' + t.why + '; ' + t.paymentIds.length + ' row(s))';
    });
    const skipExamples = plan.skipped.slice(0, 10).map(function (s) {
      return (s.rowNumber ? 'row ' + s.rowNumber + ' ' : '') + s.key + ': ' + s.reason + (s.detail ? ' (' + s.detail + ')' : '');
    });

    if (!dryRun) {
      const sh = (plan.renames.length || plan.rekeys.length || plan.duplicates.length)
        ? SpreadsheetApp.getActiveSpreadsheet().getSheetByName(PAYMENTS_SHEET) : null;
      // Single-cell identity rewrites first (row numbers are still the ones
      // the plan was built on) …
      plan.renames.concat(plan.rekeys).forEach(function (r) {
        r.cells.forEach(function (c) {
          const colIdx = PAYMENT_COLUMNS.indexOf(c.column);
          if (colIdx < 0) return;
          sh.getRange(r.rowNumber, colIdx + 1, 1, 1).setValue(c.to);
        });
      });
      appendOrphanPaymentTombstones_(plan.tombstones);
      /* Record the stray twins BEFORE they are deleted. This is the only path
       * in the repo that removes a Payments row, so it is the only place a
       * payment tombstone can be written — and without one an external reader
       * cannot tell a deleted source record from one that simply fell outside
       * its window. Recoverable: the whole row rides along as JSON. */
      appendPaymentTombstones_(plan.duplicates, PAYMENT_DELETE_REASON_STRAY_TWIN,
        ORPHAN_PAYMENT_RECONCILE_FN);
      // … and the stray-twin deletes LAST, bottom-up, so every row number
      // above a deleted row stays valid while the deletes run.
      plan.duplicates
        .map(function (d) { return d.rowNumber; })
        .sort(function (x, y) { return y - x; })
        .forEach(function (rowNumber) { sh.deleteRow(rowNumber); });
    }

    const summary = {
      dryRun: !!dryRun,
      scanned: plan.scanned,
      orphanKeys: plan.orphanKeys,
      renamed: plan.renames.length,
      rekeyed: plan.rekeys.length,
      deleted: plan.duplicates.length,
      tombstoned: plan.tombstones.length,
      skipped: plan.skipped.length,
      renames: plan.renames,
      rekeys: plan.rekeys,
      duplicates: plan.duplicates,
      tombstones: plan.tombstones,
      skippedRows: plan.skipped,
    };
    Logger.log(tag + ': ' + plan.scanned + ' payment row(s) scanned, ' + plan.orphanKeys + ' orphan key(s): ' +
      plan.renames.length + (dryRun ? ' row(s) would be renamed' : ' row(s) renamed') + ', ' +
      plan.rekeys.length + (dryRun ? ' row(s) would be re-keyed' : ' row(s) re-keyed') + ', ' +
      plan.duplicates.length + (dryRun ? ' stray twin row(s) would be deleted' : ' stray twin row(s) deleted') + ', ' +
      plan.tombstones.length + (dryRun ? ' key(s) would be tombstoned' : ' key(s) tombstoned') + ' (reason ' +
      ORPHAN_PAYMENT_TOMBSTONE_REASON + '), ' + plan.skipped.length + ' skipped.' +
      (dryRun ? ' No writes performed.' : ''));
    if (renameExamples.length) Logger.log(tag + ' renames: ' + renameExamples.join('; '));
    if (rekeyExamples.length)  Logger.log(tag + ' rekeys: ' + rekeyExamples.join('; '));
    if (dupExamples.length)    Logger.log(tag + ' duplicates: ' + dupExamples.join('; '));
    if (tombExamples.length)   Logger.log(tag + ' tombstones: ' + tombExamples.join('; '));
    if (skipExamples.length)   Logger.log(tag + ' skipped: ' + skipExamples.join('; '));

    if (!dryRun && (plan.renames.length || plan.rekeys.length || plan.duplicates.length || plan.tombstones.length)) {
      logAudit_('orphan_payments_reconciled', ORPHAN_PAYMENT_RECONCILE_FN, '', '', {
        scanned: plan.scanned,
        orphanKeys: plan.orphanKeys,
        renamed: plan.renames.length,
        rekeyed: plan.rekeys.length,
        deleted: plan.duplicates.length,
        tombstoned: plan.tombstones.length,
        skipped: plan.skipped.length,
        tombstoneReason: ORPHAN_PAYMENT_TOMBSTONE_REASON,
        // Recoverable copies of every deleted stray twin (PAYMENT_COLUMNS order)
        // and the exact old → new key of every rekey.
        deletedRows: plan.duplicates.map(function (d) { return { rowNumber: d.rowNumber, twinRowNumber: d.twinRowNumber, values: d.values }; }),
        rekeys: plan.rekeys.map(function (r) { return { rowNumber: r.rowNumber, from: r.key, to: r.newKey }; }),
        examples: { renames: renameExamples, rekeys: rekeyExamples, duplicates: dupExamples, tombstones: tombExamples, skipped: skipExamples },
        stampsRestamped: false,
      });
    }
    return summary;
  } finally {
    try { lock.releaseLock(); } catch (_) { /* no-op */ }
  }
}

/* Run from the Apps Script editor (Run dropdown). ZERO writes — logs the
 * plan reconcileOrphanPaymentsNow would execute. */
function previewOrphanPaymentsNow() {
  return runOrphanPaymentsReconcile_(true);
}

/* Run from the Apps Script editor (Run dropdown). Executes the plan under
 * the script lock; idempotent (second run = 0 writes). */
function reconcileOrphanPaymentsNow() {
  return runOrphanPaymentsReconcile_(false);
}

/* ===================================================================== *
 *  ACCOUNTING SOURCE FEED — read-only, own secret, no clinical data
 * ===================================================================== *
 *
 * WHAT THIS IS. An external accounting-control app reconciles what Vered
 * reported as collected against what actually reached the bank. It needs to
 * PULL source payment records, incrementally, and it needs each record to
 * carry a key that survives every legitimate edit to the row. That is the
 * whole job. Dashboard stores NO accounting state: no confirmation flag, no
 * queue, no invoice, no "verified by Ortal". Vered's workflow is unchanged —
 * she marks a payment paid, exactly as before.
 *
 * AUTH. Its OWN Script Property, ACCOUNTING_SECRET, separate from
 * ADMITTED_ROSTER_SECRET and MEETING_REPORT_SECRET, so the accounting app's
 * credential unlocks nothing else and can be rotated on its own. FAIL-CLOSED,
 * the discipline every authenticated endpoint here follows: unset or
 * mismatched → { ok:false, error:'unauthorized' }, never data.
 *
 * READ-ONLY. The two actions below return data and nothing else. They perform
 * no business write. The one thing they CAN cause is the idempotent identity
 * backfill (minting paymentUid / creditUid into blank cells, under the script
 * lock) — that is what makes the feed self-sufficient, it never touches an
 * amount, a status, a date or a charge stamp, and in the steady state it
 * performs zero writes and takes no lock.
 *
 * KNOWN, PRE-EXISTING, DELIBERATELY NOT CHANGED HERE: the Apps Script web app
 * is deployed ANYONE_ANONYMOUS, so anyone holding the /exec URL can already
 * reach the session-gated write actions — that is true today of every
 * cross-app integration this repo has (ezone-outpatient holds the same URL for
 * getAdmittedRoster). This endpoint adds no write surface and no new exposure,
 * but handing the URL to one more app widens who holds it. The proper fix is a
 * separate deployment for cross-app reads; it is a migration, not a column,
 * and it is called out in CHANGELOG-accounting-source-feed.md as follow-up.
 *
 * NO CLINICAL DATA. The projection is an explicit allow-list, not a filtered
 * copy of the row. Nothing from Patients.notes, the discharge note, the
 * disposition, a meeting report or a lead note can reach it, and the credit
 * projection deliberately drops the free-text `reason`, `overrideReason`,
 * `notes` and `basis` fields — they are financial justification, but they are
 * free text staff type, and free text is where clinical detail leaks. The
 * structured creditType says why the credit exists without the prose.
 * test/accounting-source-feed.test.js locks this against the shipped code. */

const ACCOUNTING_SECRET_PROP    = 'ACCOUNTING_SECRET';
const ACCOUNTING_SOURCE_APP     = 'ezone-dashboard';
const ACCOUNTING_SCHEMA_VERSION = 1;
const ACCOUNTING_PAGE_DEFAULT   = 200;
const ACCOUNTING_PAGE_MAX       = 500;
/* Deletions are rare (one manual repair path in the whole repo), so tombstones
 * are not paginated — they ride the FIRST page of a sync, capped, with a flag
 * if the cap was hit. */
const ACCOUNTING_TOMBSTONE_MAX  = 500;

function accountingAuthOk_(params) {
  const expected = PropertiesService.getScriptProperties().getProperty(ACCOUNTING_SECRET_PROP);
  // Fail closed: no secret configured → refuse (never serve financial data open).
  if (!expected) return false;
  const got = (params && params.secret) ? String(params.secret) : '';
  return constantTimeEquals_(got, expected);   // constant-time (0b-2)
}

function accStr_(v) {
  return String(v === null || v === undefined ? '' : v).trim();
}
function accNum_(v) {
  const n = Number(v);
  return isFinite(n) ? n : 0;
}
/* A cell that is blank on the sheet is null in the feed, never '' — the
 * accounting app must be able to tell "no value recorded" from "empty string"
 * without guessing. */
function accOrNull_(v) {
  const t = accStr_(v);
  return t === '' ? null : t;
}

/* Every timestamp the feed emits is rendered as Israel time WITH an explicit
 * offset, whatever form the cell holds. The Payments stamps are written that
 * way already (idempotent here); the Credits stamps are the repo's older UTC
 * 'Z' ISO strings and are converted — the same instant, stated unambiguously,
 * so one consumer never has to handle two conventions. Unparseable → null. */
function accIsraelStamp_(v) {
  const t = accStr_(v);
  if (!t) return null;
  const ms = Date.parse(t);
  if (isNaN(ms)) return null;
  return israelTimestamp_(new Date(ms));
}

/* Sort/filter key for a source timestamp. Israel-time ISO strings WITH an
 * offset parse exactly; a blank (historical) row sorts to 0, i.e. first, and
 * is excluded by any updatedSince. Never lexicographic: the autumn DST switch
 * makes two same-day stamps sort wrongly as strings. */
function accountingSortMs_(iso) {
  const t = accStr_(iso);
  if (!t) return 0;
  const ms = Date.parse(t);
  return isNaN(ms) ? 0 : ms;
}

/* Cursor: OPAQUE to the caller (do not parse it — the format may change).
 * Internally '<sortMs>|<uid>', the exact (timestamp, tie-break) pair the page
 * ended on, so a resumed sync can never skip or repeat a row. */
function accountingCursorOf_(sortMs, uid) {
  return String(sortMs) + '|' + String(uid);
}
function accountingCursorParse_(raw) {
  const t = accStr_(raw);
  if (!t) return { ok: true, cursor: null };
  const i = t.indexOf('|');
  if (i < 0) return { ok: false };
  const ms = Number(t.slice(0, i));
  if (!isFinite(ms)) return { ok: false };
  return { ok: true, cursor: { ms: ms, uid: t.slice(i + 1) } };
}

/* Shared page mechanics for both actions: filter by updatedSince, sort by
 * (sortMs, uid), resume at the cursor, cut at the limit. `items` are
 * { sortMs, uid, value } triples. */
function accountingPage_(items, sinceMs, cursor, limit) {
  const kept = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (sinceMs !== null && it.sortMs < sinceMs) continue;
    if (cursor && !(it.sortMs > cursor.ms || (it.sortMs === cursor.ms && it.uid > cursor.uid))) continue;
    kept.push(it);
  }
  kept.sort(function (a, b) {
    if (a.sortMs !== b.sortMs) return a.sortMs - b.sortMs;
    return a.uid < b.uid ? -1 : (a.uid > b.uid ? 1 : 0);
  });
  const page = kept.slice(0, limit);
  const hasMore = kept.length > page.length;
  const last = page.length ? page[page.length - 1] : null;
  return {
    values: page.map(function (x) { return x.value; }),
    hasMore: hasMore,
    nextCursor: hasMore && last ? accountingCursorOf_(last.sortMs, last.uid) : null,
  };
}

function accountingLimit_(raw) {
  const n = Math.floor(Number(raw));
  if (!isFinite(n) || n <= 0) return ACCOUNTING_PAGE_DEFAULT;
  return Math.min(n, ACCOUNTING_PAGE_MAX);
}

/* updatedSince → epoch ms, or null for "everything" (a full sync).
 * A value we cannot parse is REFUSED rather than silently treated as a full
 * sync: an accounting app that mistypes its watermark must not be handed the
 * entire history and flood its own queue. */
function accountingSince_(raw) {
  const t = accStr_(raw);
  if (!t) return { ok: true, ms: null };
  const ms = Date.parse(t);
  if (isNaN(ms)) return { ok: false };
  return { ok: true, ms: ms };
}

/* ---- coverage window + day/month allocation (SERVER mirror) -------------
 * The same rule paymentCoverage() and the הכנסות חודשיות allocation apply in
 * app.js: the RECORDED coverageStart/coverageEnd win; a row that records none falls
 * back to the inferred cycle [dueDate, dueDate + 1 month − 1 day]. The window
 * is then split across the calendar months it touches, day by day.
 * `source` is carried so the accounting app can say which it is instead of
 * implying a precision the row does not have. */
function accDateFromISO_(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(accStr_(iso));
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return isNaN(d.getTime()) ? null : d;
}
/* Math.round absorbs the ±1h a DST switch injects between two local midnights. */
function accDiffDays_(a, b) { return Math.round((b.getTime() - a.getTime()) / 86400000); }
function accAddMonthsClamped_(d, n) {
  const y = d.getFullYear(), m = d.getMonth() + n, day = d.getDate();
  const last = new Date(y, m + 1, 0).getDate();
  return new Date(y, m, Math.min(day, last));
}
function accAddDays_(d, n) { return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n); }
function accRoundMoney_(n) { return Math.round((Number(n) || 0) * 100) / 100; }

function accountingCoverage_(row) {
  const recS = coverageDateISO_(row.coverageStart);
  const recE = coverageDateISO_(row.coverageEnd);
  if (recS && recE && !coveragePeriodError_(recS, recE)) {
    const s = accDateFromISO_(recS), e = accDateFromISO_(recE);
    if (s && e) return { start: s, end: e, source: 'recorded' };
  }
  const dueISO = asISODate_(row.dueDate);
  const start = accDateFromISO_(dueISO);
  if (!start) return null;
  return { start: start, end: accAddDays_(accAddMonthsClamped_(start, 1), -1), source: 'inferred' };
}

/* The window split across the calendar months it touches. Each entry carries
 * its day count, its share of the window and that share of BOTH the billed
 * amount and the amount actually reported paid. Shares sum to 1 and the
 * per-month amounts sum to the row total up to 2dp rounding, so a consolidated
 * figure always adds up to the row it came from. */
function accountingAllocation_(cov, amount, amountPaid) {
  if (!cov) return [];
  const total = accDiffDays_(cov.start, cov.end) + 1;
  if (total <= 0) return [];
  const out = [];
  let cur = new Date(cov.start.getFullYear(), cov.start.getMonth(), 1);
  let guard = 0;
  while (cur.getTime() <= cov.end.getTime() && guard++ < 400) {
    const mStart = new Date(cur.getFullYear(), cur.getMonth(), 1);
    const mEnd   = new Date(cur.getFullYear(), cur.getMonth() + 1, 0);
    const s = mStart.getTime() > cov.start.getTime() ? mStart : cov.start;
    const e = mEnd.getTime()   < cov.end.getTime()   ? mEnd   : cov.end;
    const days = accDiffDays_(s, e) + 1;
    if (days > 0) {
      out.push({
        month:      localPartsISO_(mStart).slice(0, 7),
        days:       days,
        share:      Math.round((days / total) * 1e6) / 1e6,
        amount:     accRoundMoney_(amount * days / total),
        amountPaid: accRoundMoney_(amountPaid * days / total),
      });
    }
    cur = new Date(cur.getFullYear(), cur.getMonth() + 1, 1);
  }
  return out;
}

/* ---- projections (ALLOW-LISTS — see the no-clinical-data note above) ---- */

function accountingCreditView_(c) {
  return {
    sourceApp:       ACCOUNTING_SOURCE_APP,
    sourceRecordId:  accStr_(c.id),
    creditUid:       accOrNull_(c.creditUid),
    patientUid:      accOrNull_(c.patientId),   // Credits.patientId IS the persisted Patients id
    patientKey:      accOrNull_(c.patientKey),  // the billing triple, for the Payments join
    payerUid:        null,
    house:           accStr_(c.houseId),
    creditType:      accStr_(c.creditType),
    allocationMonth: accStr_(c.allocationMonth),
    calculatedAmount: accNum_(c.calculatedAmount),
    amount:          accNum_(c.amount),
    currency:        'ILS',
    vatInclusive:    true,
    status:          accStr_(c.status),
    decidedDate:     accOrNull_(c.decidedDate),
    payoutDate:      accOrNull_(c.payoutDate),
    paidDate:        accOrNull_(c.paidDate),
    sourceUpdatedAt: accIsraelStamp_(c.updatedAt),
    sourceCreatedAt: accIsraelStamp_(c.createdAt),
  };
}

/* The invoice choice of one row for the feed: 'yes' | 'no' | null (a row from
 * before the question — never guessed), and the name only when 'yes'. PURE. */
function accountingInvoice_(r) {
  const w = accStr_(r && r.invoiceWanted);
  const known = INVOICE_CHOICES.indexOf(w) >= 0;
  return { invoiceWanted: known ? w : null, invoiceTo: w === 'yes' ? (accStr_(r.invoiceTo) || null) : null };
}

function accountingPaymentView_(r, creditsByLink, receipts) {
  const amount     = accNum_(r.amount);
  const amountPaid = accNum_(r.amountPaid);
  const cov = accountingCoverage_(r);
  const dueISO = asISODate_(r.dueDate);
  const linkKey = accStr_(r.patientId) + '|' + String(dueISO || '').slice(0, 7);
  const sourceUpdatedAt = accIsraelStamp_(r.sourceUpdatedAt);
  return {
    sourceApp:      ACCOUNTING_SOURCE_APP,
    sourceRecordId: accStr_(r.id),
    paymentUid:     accOrNull_(r.paymentUid),
    patientUid:     accOrNull_(r.patientUid),
    /* ALWAYS null today: Dashboard has no payer entity. The accounting app
     * needs its own crosswalk from patientUid to the party it bills. Never
     * inferred from a name here. */
    payerUid:       accOrNull_(r.payerUid),
    patientName:    accStr_(r.patientName),
    house:          accStr_(r.houseId),
    dueDate:        dueISO || null,
    amount:         amount,
    amountPaid:     amountPaid,
    balance:        accNum_(r.balance),
    /* VAT-INCLUSIVE AT THE SOURCE, like every other figure in this repo
     * (`pay`, Payments.amount, every credit). Do NOT apply a second VAT
     * conversion downstream. */
    currency:       'ILS',
    vatInclusive:   true,
    status:         paymentStatus_(r.status),
    statusRaw:      accStr_(r.status),
    /* "Reported paid by Vered", NOT "confirmed in the bank". */
    chargedAt:      accIsraelStamp_(r.chargedAt),
    chargedBy:      accOrNull_(r.chargedBy),
    coverageStart:  cov ? localPartsISO_(cov.start) : null,
    coverageEnd:    cov ? localPartsISO_(cov.end) : null,
    coverageSource: cov ? cov.source : null,
    coverageDays:   cov ? accDiffDays_(cov.start, cov.end) + 1 : 0,
    coverageAllocation: accountingAllocation_(cov, amount, amountPaid),
    sourceUpdatedAt: sourceUpdatedAt,
    sourceVersion:   r.sourceVersion === '' || r.sourceVersion === null || r.sourceVersion === undefined
      ? null : accNum_(r.sourceVersion),
    /* TRUE for a row that has not been written since this contract shipped —
     * i.e. a payment Vered reported BEFORE the accounting app was activated.
     * This is the flag that keeps a historical import out of a confirmation
     * queue: see "avoiding a historical flood" in the changelog. */
    historical:     !sourceUpdatedAt,
    deleted:        false,
    /* DERIVED link, not a stored one: Dashboard has no payment↔credit foreign
     * key. A credit is attached here when its patientKey matches this row's
     * billing key AND its allocationMonth is this row's due-date month. A
     * credit that matches no payment row is still returned in full by
     * accountingCredits, which is the authoritative list — dedupe on
     * creditUid. */
    creditLinkBasis: 'derived:patientKey+allocationMonth==dueDateMonth',
    credits: (creditsByLink && creditsByLink[linkKey]) || [],
    /* The invoice (CHANGELOG-payment-invoice.md). The feed stays one record
     * per cycle, so the choice — made per money received — rides along: the
     * row's own pair (null on a cycle), and one entry per receipt of this
     * cycle (void ones included, flagged), oldest first. */
    invoiceWanted: accountingInvoice_(r).invoiceWanted,
    invoiceTo: accountingInvoice_(r).invoiceTo,
    invoices: (receipts || []).map(function (x) {
      const inv = accountingInvoice_(x);
      return {
        receiptUid: accOrNull_(x.paymentUid), receivedDate: paymentReportDate_(x.receivedDate) || null,
        amount: accNum_(x.amountPaid !== '' && x.amountPaid !== undefined && x.amountPaid !== null ? x.amountPaid : x.amount),
        void: isVoidStatus_(x.status), invoiceWanted: inv.invoiceWanted, invoiceTo: inv.invoiceTo,
      };
    }),
  };
}

function accountingTombstoneView_(t) {
  return {
    sourceApp:      ACCOUNTING_SOURCE_APP,
    sourceRecordId: accStr_(t.sourceRecordId),
    paymentUid:     accOrNull_(t.paymentUid),
    patientUid:     accOrNull_(t.patientUid),
    house:          accStr_(t.houseId),
    dueDate:        accOrNull_(t.dueDate),
    amount:         accNum_(t.amount),
    amountPaid:     accNum_(t.amountPaid),
    status:         paymentStatus_(t.status),
    deletedAt:      accIsraelStamp_(t.deletedAt),
    deletedBy:      accOrNull_(t.deletedBy),
    reason:         accStr_(t.reason),
    deleted:        true,
  };
  /* `values` (the recovery copy of the whole deleted row) is deliberately NOT
   * projected — it is for a human restoring data, not for an external app. */
}

function accountingTombstones_(sinceMs) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(PAYMENTS_TOMBSTONES_SHEET);
  if (!sh) return { tombstones: [], truncated: false };   // never created one → nothing deleted
  const rows = readSheet_(sh, PAYMENT_TOMBSTONE_COLUMNS);
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    if (sinceMs !== null && accountingSortMs_(rows[i].deletedAt) < sinceMs) continue;
    out.push(rows[i]);
  }
  out.sort(function (a, b) { return accountingSortMs_(a.deletedAt) - accountingSortMs_(b.deletedAt); });
  const truncated = out.length > ACCOUNTING_TOMBSTONE_MAX;
  return {
    tombstones: out.slice(0, ACCOUNTING_TOMBSTONE_MAX).map(accountingTombstoneView_),
    truncated: truncated,
  };
}

/* ---- the two actions ---------------------------------------------------- */

function accountingPayments_(params) {
  const since = accountingSince_(params && params.updatedSince);
  if (!since.ok) return { ok: false, error: 'bad_updatedSince' };
  const cur = accountingCursorParse_(params && params.cursor);
  if (!cur.ok) return { ok: false, error: 'bad_cursor' };
  const limit = accountingLimit_(params && params.limit);

  const sh = getOrCreateSheet_(PAYMENTS_SHEET, PAYMENT_COLUMNS);
  // Identity only — see the read-only note at the top of this section.
  backfillPaymentIdentityLocked_(sh);
  const rows = readSheet_(sh, PAYMENT_COLUMNS);

  // Credits, grouped by the derived link key, so each payment carries its own.
  const creditsSh = getOrCreateSheet_(CREDITS_SHEET, CREDIT_COLUMNS);
  backfillCreditUidsLocked_(creditsSh);
  const creditRows = readSheet_(creditsSh, CREDIT_COLUMNS);
  const creditsByLink = {};
  for (let i = 0; i < creditRows.length; i++) {
    const c = creditRows[i];
    const key = accStr_(c.patientKey) + '|' + accStr_(c.allocationMonth);
    if (!creditsByLink[key]) creditsByLink[key] = [];
    creditsByLink[key].push(accountingCreditView_(c));
  }

  const items = [];
  let identityPending = 0;
  /* Receipt rows (Phase 3 PR 2) are not exported: the feed's contract is one
   * record per cycle, and each cycle row already carries the total of its
   * receipts (written by reportPayment_ and on every void). */
  const derived = paymentRowsDerived_(rows);
  const cyclesOnly = derived.cycles;
  /* Each cycle's receipts (for `invoices`). A receipt edited later (its
   * invoice choice) moves its cycle's place in the incremental feed too:
   * sortMs = the newest sourceUpdatedAt of the cycle and its receipts. */
  const receiptsOf = {};
  derived.receipts.forEach(function (x) {
    if (!x.cycleId) return;
    (receiptsOf[x.cycleId] || (receiptsOf[x.cycleId] = [])).push(x);
  });
  for (let i = 0; i < cyclesOnly.length; i++) {
    const r = cyclesOnly[i];
    if (!accStr_(r.paymentUid)) identityPending++;
    const uid = accStr_(r.paymentUid) || accStr_(r.id);
    if (!uid) continue;   // a row with no identity at all is not exportable
    const mine = (receiptsOf[accStr_(r.id)] || []).slice().sort(function (a, b) {
      const da = paymentReportDate_(a.receivedDate) || '', db = paymentReportDate_(b.receivedDate) || '';
      return da < db ? -1 : da > db ? 1 : 0;
    });
    let sortMs = accountingSortMs_(r.sourceUpdatedAt);
    mine.forEach(function (x) {
      const ms = accountingSortMs_(x.sourceUpdatedAt);
      if (isFinite(ms) && (!isFinite(sortMs) || ms > sortMs)) sortMs = ms;
    });
    items.push({
      sortMs: sortMs,
      uid: uid,
      value: accountingPaymentView_(r, creditsByLink, mine),
    });
  }

  const page = accountingPage_(items, since.ms, cur.cursor, limit);
  // Tombstones ride the FIRST page of a sync only (no cursor), so a paging
  // client does not receive the same deletions on every page.
  const tomb = cur.cursor ? { tombstones: [], truncated: false } : accountingTombstones_(since.ms);

  return {
    ok: true,
    sourceApp: ACCOUNTING_SOURCE_APP,
    schemaVersion: ACCOUNTING_SCHEMA_VERSION,
    serverTime: israelTimestamp_(),
    payments: page.values,
    /* Rows still awaiting their permanent paymentUid. The identity backfill is
     * bounded per invocation (IDENTITY_BACKFILL_MAX_PER_RUN) so a first read
     * after deploy on a large sheet cannot hit the execution limit; it
     * converges over the next few reads. NON-ZERO means: do not treat this
     * sync as complete — such rows come back with paymentUid null and must not
     * be imported under a substitute key. Read again until it reaches 0, which
     * it then stays at forever. */
    identityPending: identityPending,
    tombstones: tomb.tombstones,
    tombstonesTruncated: tomb.truncated,
    page: {
      limit: limit,
      count: page.values.length,
      hasMore: page.hasMore,
      nextCursor: page.nextCursor,
      updatedSince: accOrNull_(params && params.updatedSince),
    },
  };
}

function accountingCredits_(params) {
  const since = accountingSince_(params && params.updatedSince);
  if (!since.ok) return { ok: false, error: 'bad_updatedSince' };
  const cur = accountingCursorParse_(params && params.cursor);
  if (!cur.ok) return { ok: false, error: 'bad_cursor' };
  const limit = accountingLimit_(params && params.limit);

  const sh = getOrCreateSheet_(CREDITS_SHEET, CREDIT_COLUMNS);
  backfillCreditUidsLocked_(sh);
  const rows = readSheet_(sh, CREDIT_COLUMNS);

  const items = [];
  for (let i = 0; i < rows.length; i++) {
    const c = rows[i];
    const uid = accStr_(c.creditUid) || accStr_(c.id);
    if (!uid) continue;
    items.push({
      sortMs: accountingSortMs_(c.updatedAt),
      uid: uid,
      value: accountingCreditView_(c),
    });
  }

  const page = accountingPage_(items, since.ms, cur.cursor, limit);
  return {
    ok: true,
    sourceApp: ACCOUNTING_SOURCE_APP,
    schemaVersion: ACCOUNTING_SCHEMA_VERSION,
    serverTime: israelTimestamp_(),
    credits: page.values,
    page: {
      limit: limit,
      count: page.values.length,
      hasMore: page.hasMore,
      nextCursor: page.nextCursor,
      updatedSince: accOrNull_(params && params.updatedSince),
    },
  };
}

/* ===== Ortal's daily payments digest (time-driven, mail only) ===============
 *
 * One email per working morning (Sunday–Thursday, ~08:00 Asia/Jerusalem) to
 * Ortal, listing every payment RECORDED since the last successful digest, so
 * she can check each one against the bank. Read-only against every sheet: it
 * reads Payments and writes nothing but its own Script Properties.
 *
 * WHAT "RECORDED" MEANS — the charge stamp from the accounting source feed
 * (CHANGELOG-accounting-source-feed.md): `chargedAt` is set when a row becomes
 * paid/partial and RE-SET when its amountPaid moves. It means "reported paid",
 * never "seen in the bank" — confirming that is exactly what this mail asks
 * Ortal to do. A historical row (blank stamp) is never listed.
 *
 * THE WINDOW is (DIGEST_LAST_AT, now], compared as INSTANTS (the stamps carry
 * their own offset). DIGEST_LAST_AT moves ONLY after MailApp succeeded, under
 * the script lock, so a failed send is simply covered by the next run, and
 * Sunday's mail naturally spans Thursday-after-send through Saturday. With no
 * DIGEST_LAST_AT yet (the first run) the window is the last
 * DIGEST_FIRST_RUN_DAYS days.
 *
 * WHAT IS LISTED — paid/partial rows whose chargedAt is in the window. A void
 * row (PR #144) is excluded even if a stamp survived on it. A row that an
 * EARLIER digest already sent and that was re-stamped since (its amount was
 * edited, or it was re-recorded) is marked «עודכן», with the previously sent
 * amount when it differs. That needs memory the sheet does not keep — the
 * charge stamp is overwritten, not versioned — so each successful send records
 * {row → amount sent} in a small chunked ledger in Script Properties, pruned
 * after DIGEST_LEDGER_KEEP_DAYS.
 *
 * WHAT IS NEVER IN THE MAIL — anything clinical, any phone number, any id
 * (paymentUid / patientUid / the billing triple / the row id). The row is
 * projected onto an explicit allow-list (digestRow_) before anything renders,
 * and every value is HTML-escaped.
 *
 * RECIPIENTS COME ONLY FROM SCRIPT PROPERTIES, never from code:
 *   DIGEST_TO        Ortal — REQUIRED. Missing or malformed → nothing is sent
 *                    and a warning is logged (fail closed).
 *   DIGEST_CC        Sandra — CC'd only while today <= DIGEST_CC_UNTIL.
 *   DIGEST_CC_UNTIL  'YYYY-MM-DD' (the trial week). Missing / malformed → no CC.
 *
 * Editor-run entry points (Run dropdown; handle_ never names any of them):
 *   authorizeDigestNow, previewDigestNow, sendDigestTestNow,
 *   installDigestTriggerNow. Trigger handler: paymentsDigestJob.
 */
const DIGEST_PROP_TO        = 'DIGEST_TO';
const DIGEST_PROP_CC        = 'DIGEST_CC';
const DIGEST_PROP_CC_UNTIL  = 'DIGEST_CC_UNTIL';
const DIGEST_PROP_LAST_AT   = 'DIGEST_LAST_AT';
const DIGEST_PROP_LAST_DAY  = 'DIGEST_LAST_SENT_DAY';
const DIGEST_PROP_LEDGER_N  = 'DIGEST_LEDGER_CHUNKS';
const DIGEST_PROP_LEDGER_PREFIX = 'DIGEST_LEDGER_';
const DIGEST_LEDGER_CHUNK_CHARS = 8000;
const DIGEST_LEDGER_KEEP_DAYS = 180;
const DIGEST_FIRST_RUN_DAYS = 7;
const DIGEST_TZ = 'Asia/Jerusalem';
const DIGEST_TRIGGER_HANDLER = 'paymentsDigestJob';
const DIGEST_TRIGGER_HOUR = 8;
const DIGEST_DASHBOARD_URL = 'https://ezone-dashboard.up.railway.app';
/* Phase 4: the «בקרת גבייה» tab — the deep link the digest's «ממתינים
 * לאימות» line opens (app.js screenFromHash). */
const DIGEST_BILLING_CONTROL_URL = DIGEST_DASHBOARD_URL + '/#billing-control';
const DIGEST_SENDER_NAME = 'E-ZONE Dashboard';
/* SimpleDateFormat 'u': 1 = Monday … 7 = Sunday. Friday and Saturday skip. */
const DIGEST_SKIP_WEEKDAYS = [5, 6];

/* ---------------- pure helpers ---------------- */

/* Jerusalem wall-clock parts of an instant: { iso:'YYYY-MM-DD', dmy:'DD/MM/YYYY',
 * weekday: 1..7 (Mon..Sun) }. Always DIGEST_TZ — the weekday rule is Israel's,
 * whatever the spreadsheet or the runtime say. */
function digestJerusalemParts_(now) {
  const s = String(Utilities.formatDate(now, DIGEST_TZ, 'yyyy-MM-dd u'));
  const iso = s.slice(0, 10);
  return {
    iso: iso,
    dmy: iso.slice(8, 10) + '/' + iso.slice(5, 7) + '/' + iso.slice(0, 4),
    weekday: Number(s.slice(11)) || 0,
  };
}

function digestIsWorkday_(now) {
  return DIGEST_SKIP_WEEKDAYS.indexOf(digestJerusalemParts_(now).weekday) < 0;
}

/* Escape for HTML text AND attribute context. Every value that reaches the
 * HTML body goes through here — names are free text typed by staff. */
function digestEsc_(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/* One line of plain text: control characters (incl. CR/LF) become spaces, so a
 * value can never break the text table or forge a line. */
function digestPlain_(v) {
  return String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
}

/* A recipient list from a Script Property: one or more addresses separated by
 * ',' or ';'. Returns the cleaned ','-joined list, or '' when the value is
 * blank OR any part is malformed — a half-valid list is refused whole, never
 * partly sent. No whitespace, quotes, angle brackets or line breaks can pass,
 * so a property value can never inject a header. */
function digestRecipients_(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return '';
  const parts = s.split(/[,;]/).map(function (p) { return p.trim(); }).filter(function (p) { return p; });
  if (!parts.length) return '';
  const re = /^[^\s@<>"'(),;:\\[\]]+@[^\s@<>"'(),;:\\[\]]+\.[A-Za-z]{2,}$/;
  for (let i = 0; i < parts.length; i++) if (!re.test(parts[i])) return '';
  return parts.join(',');
}

/* Is Sandra still CC'd today? Only with a well-formed DIGEST_CC_UNTIL and only
 * while today (Jerusalem) is on or before it. Anything else → no CC. */
function digestCcActive_(todayIso, untilRaw) {
  const until = String(untilRaw == null ? '' : untilRaw).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(until)) return false;
  return String(todayIso) <= until;
}

/* An instant from a charge stamp: an ISO string with its offset (what the
 * server writes) or a Date (if Sheets ever coerced the cell). NaN otherwise. */
function digestInstant_(v) {
  if (v instanceof Date) return v.getTime();
  const s = String(v == null ? '' : v).trim();
  if (!s) return NaN;
  return Date.parse(s);
}

function digestDmyFromIso_(iso) {
  const s = String(iso || '');
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s.slice(8, 10) + '/' + s.slice(5, 7) + '/' + s.slice(0, 4) : '';
}

/* '₪12,345' / '₪1,234.50'. VAT-INCLUSIVE, as stored; no conversion here. */
function digestMoney_(n) {
  const v = Math.round((Number(n) || 0) * 100) / 100;
  const neg = v < 0;
  const abs = Math.abs(v);
  const whole = Math.floor(abs);
  const cents = Math.round((abs - whole) * 100);
  const w = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (neg ? '-' : '') + '₪' + w + (cents ? '.' + (cents < 10 ? '0' : '') + cents : '');
}

/* Reverse of DIGEST_HOUSE_NAME_TO_INTERNAL: internal id → Hebrew label. A
 * stored Hebrew label resolves too. Unknown → the raw value (escaped later). */
function digestHouseLabel_(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (DIGEST_HOUSE_NAME_TO_INTERNAL[s]) return s;
  const labels = Object.keys(DIGEST_HOUSE_NAME_TO_INTERNAL);
  for (let i = 0; i < labels.length; i++) {
    if (DIGEST_HOUSE_NAME_TO_INTERNAL[labels[i]] === s) return labels[i];
  }
  for (let i = 0; i < labels.length; i++) {
    if (DIGEST_HOUSE_NAME_TO_INTERNAL[labels[i]].toLowerCase() === s.toLowerCase()) return labels[i];
  }
  return s || '—';
}

/* The payment method: the `method` column (Phase 3) when the row has one,
 * else the optional hand-added column ('אמצעי תשלום' etc.) to the right of
 * PAYMENT_COLUMNS — the same lookup recPayment_ uses; '' when there is none. */
function digestMethod_(obj) {
  const own = String(obj.method == null ? '' : obj.method).trim();
  if (own) return own;
  const want = ['method', 'אמצעי תשלום', 'אמצעי', 'paymentMethod'].map(function (n) { return diagNormText_(n); });
  const keys = Object.keys(obj);
  for (let i = 0; i < keys.length; i++) {
    if (PAYMENT_COLUMNS.indexOf(keys[i]) < 0 && want.indexOf(diagNormText_(keys[i])) >= 0) {
      return String(obj[keys[i]] == null ? '' : obj[keys[i]]).trim();
    }
  }
  return '';
}

/* The ledger key of a row: its permanent paymentUid, else its row id. Never
 * rendered — it lives only in Script Properties. */
function digestRowKey_(obj) {
  const uid = String(obj.paymentUid == null ? '' : obj.paymentUid).trim();
  return uid || String(obj.id == null ? '' : obj.id).trim();
}

/* The amount reported received: amountPaid; for a 'paid' row with no
 * amountPaid recorded, its amount. */
function digestAmount_(obj) {
  const paid = Number(obj.amountPaid);
  if (String(obj.amountPaid == null ? '' : obj.amountPaid).trim() !== '' && isFinite(paid)) return paid;
  return paymentStatus_(obj.status) === 'paid' ? (Number(obj.amount) || 0) : 0;
}

/* 'yes' → «כן», 'no' → «לא», anything else (a row from before the question)
 * → '' (rendered «—»): never guessed as כן or לא. */
function digestInvoiceLabel_(v) {
  const t = String(v == null ? '' : v).trim();
  return t === 'yes' ? 'כן' : t === 'no' ? 'לא' : '';
}

/* THE ALLOW-LIST. The only fields of a Payments row that ever reach the mail.
 * `key` and `instant` are bookkeeping and are never rendered. */
function digestRow_(obj, ledger) {
  const key = digestRowKey_(obj);
  const amount = digestAmount_(obj);
  const instant = digestInstant_(obj.chargedAt);
  const prior = key && ledger ? ledger[key] : null;
  return {
    key: key,
    instant: instant,
    patientName: String(obj.patientName == null ? '' : obj.patientName).trim(),
    houseLabel: digestHouseLabel_(obj.houseId),
    amount: amount,
    /* The day the money arrived (receivedDate, Phase 3) when the row has
     * one; a legacy row keeps showing its due date. Which rows are listed is
     * still decided by chargedAt — "recorded since the last digest". */
    paymentDate: digestDmyFromIso_(paymentReportDate_(obj.receivedDate) || asISODate_(obj.dueDate)),
    method: digestMethod_(obj),
    reference: String(obj.reference == null ? '' : obj.reference).trim(),
    /* «חשבונית» / «על שם» (CHANGELOG-payment-invoice.md): כן / לא, and the
     * name only when כן. A row from before the question → «—» in both. */
    invoice: digestInvoiceLabel_(obj.invoiceWanted),
    invoiceTo: String(obj.invoiceWanted == null ? '' : obj.invoiceWanted).trim() === 'yes'
      ? String(obj.invoiceTo == null ? '' : obj.invoiceTo).trim() : '',
    recordedBy: String(obj.chargedBy == null ? '' : obj.chargedBy).trim(),
    recordedAt: isFinite(instant) ? String(Utilities.formatDate(new Date(instant), DIGEST_TZ, 'dd/MM/yyyy HH:mm')) : '',
    updated: !!prior,
    previousAmount: prior && Number(prior.amount) !== amount ? Number(prior.amount) : null,
  };
}

/* Select and project. `rowObjs` are Payments row objects (recReadSheet_'s
 * .obj); keeps paid/partial, non-void rows recorded in (sinceMs, untilMs]. */
function digestSelect_(rowObjs, sinceMs, untilMs, ledger) {
  const out = [];
  /* One line per money received (Phase 3 PR 2): a cycle that has receipt
   * rows is listed through them, never itself — its re-derived amountPaid
   * would count the same money twice. A legacy row is listed as before. */
  const paidByReceipts = linkReceiptsToCycles_(rowObjs).byCycle;
  for (let i = 0; i < rowObjs.length; i++) {
    const o = rowObjs[i];
    if (paidByReceipts[i]) continue;
    if (isVoidStatus_(o.status)) continue;
    if (!paymentIsCharged_(o.status)) continue;
    const t = digestInstant_(o.chargedAt);
    if (!isFinite(t) || t <= sinceMs || t > untilMs) continue;
    out.push(digestRow_(o, ledger));
  }
  out.sort(function (a, b) {
    if (a.houseLabel !== b.houseLabel) return a.houseLabel < b.houseLabel ? -1 : 1;
    return a.instant - b.instant;
  });
  return out;
}

/* Phase 4: how many live receipts still wait for Ortal's check
 * (confirmStatus 'reported', or blank on a receipt). Counts only — no name,
 * no amount. PURE over Payments row objects. */
function digestPendingCount_(rowObjs) {
  let n = 0;
  (Array.isArray(rowObjs) ? rowObjs : []).forEach(function (o) {
    if (!isReceiptRow_(o) || isVoidStatus_(o.status)) return;
    if (receiptConfirmStatus_(o) === 'reported') n++;
  });
  return n;
}

/* Totals per house (in first-seen order) and overall. */
function digestTotals_(rows) {
  const byHouse = [];
  const idx = {};
  let total = 0;
  for (let i = 0; i < rows.length; i++) {
    const h = rows[i].houseLabel;
    if (!(h in idx)) { idx[h] = byHouse.length; byHouse.push({ houseLabel: h, count: 0, amount: 0 }); }
    byHouse[idx[h]].count++;
    byHouse[idx[h]].amount = Math.round((byHouse[idx[h]].amount + rows[i].amount) * 100) / 100;
    total = Math.round((total + rows[i].amount) * 100) / 100;
  }
  return { byHouse: byHouse, count: rows.length, amount: total };
}

/* The whole message: { subject, htmlBody, body }. Pure given its inputs. */
function digestCompose_(rows, ctx) {
  const subject = (ctx.test ? '[בדיקה] ' : '') + 'תשלומים שנרשמו — ' + ctx.todayDmy;
  const windowText = 'תשלומים שנרשמו בין ' + ctx.sinceText + ' ל-' + ctx.untilText +
    (ctx.firstRun ? ' (הרצה ראשונה: ' + DIGEST_FIRST_RUN_DAYS + ' הימים האחרונים)' : '');
  const totals = digestTotals_(rows);
  const td = 'padding:6px 10px;border:1px solid #d0d7de;text-align:right;vertical-align:top;';
  const th = td + 'background:#f3f6f8;font-weight:bold;';
  const wrap = '<div dir="rtl" style="direction:rtl;text-align:right;font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#1f2328;">';
  const link = '<p style="margin:16px 0 0;"><a href="' + digestEsc_(DIGEST_DASHBOARD_URL) + '" style="color:#0b6e4f;">פתיחת הדשבורד</a></p>';
  const note = '<p style="margin:12px 0 0;color:#57606a;font-size:12px;">«נרשם» = דווח כשולם בדשבורד, לא אישור שהכסף הגיע לבנק. הסכומים כוללים מע״מ.</p>';
  /* Phase 4: one line with the count still waiting for her check, linking
   * straight to the «בקרת גבייה» tab. Absent when the count is unknown. */
  const pending = ctx.pendingCount === undefined || ctx.pendingCount === null ? null : Math.max(0, Number(ctx.pendingCount) || 0);
  const pendingHtml = pending === null ? '' :
    '<p style="margin:0 0 10px;font-weight:bold;">ממתינים לאימות: ' + pending +
    ' · <a href="' + digestEsc_(DIGEST_BILLING_CONTROL_URL) + '" style="color:#0b6e4f;">לטאב «בקרת גבייה»</a></p>';
  const pendingText = pending === null ? '' : 'ממתינים לאימות: ' + pending + ' — ' + DIGEST_BILLING_CONTROL_URL + '\n\n';

  if (!rows.length) {
    const html = wrap +
      '<p style="margin:0 0 8px;font-weight:bold;">אין תשלומים חדשים</p>' + pendingHtml +
      '<p style="margin:0;">' + digestEsc_(windowText) + '</p>' + note + link + '</div>';
    const text = 'אין תשלומים חדשים\n' + pendingText + digestPlain_(windowText) + '\n\nפתיחת הדשבורד: ' + DIGEST_DASHBOARD_URL;
    return { subject: subject, htmlBody: html, body: text, count: 0, total: 0, pending: pending };
  }

  const head = ['מטופל', 'בית', 'סכום (כולל מע״מ)', 'תאריך תשלום', 'אמצעי', 'אסמכתא', 'חשבונית', 'על שם', 'נרשם ע״י', 'נרשם ב-', ''];
  let html = wrap + pendingHtml + '<p style="margin:0 0 10px;">' + digestEsc_(windowText) + '</p>' +
    '<table dir="rtl" cellpadding="0" cellspacing="0" style="border-collapse:collapse;direction:rtl;">' +
    '<tr>' + head.map(function (h) { return '<th style="' + th + '">' + digestEsc_(h) + '</th>'; }).join('') + '</tr>';
  const lines = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const flag = r.updated
      ? 'עודכן' + (r.previousAmount !== null ? ' (נשלח קודם: ' + digestMoney_(r.previousAmount) + ')' : '')
      : '';
    const cells = [r.patientName || '—', r.houseLabel, digestMoney_(r.amount), r.paymentDate || '—',
      r.method || '—', r.reference || '—', r.invoice || '—', r.invoiceTo || '—',
      r.recordedBy || '—', r.recordedAt || '—', flag];
    html += '<tr>' + cells.map(function (c, j) {
      const style = td + (j === 2 ? 'white-space:nowrap;' : '') + (j === cells.length - 1 && c ? 'color:#9a6700;font-weight:bold;' : '');
      return '<td style="' + style + '">' + digestEsc_(c) + '</td>';
    }).join('') + '</tr>';
    lines.push(cells.map(digestPlain_).filter(function (c) { return c; }).join(' | '));
  }
  html += '</table>';

  html += '<p style="margin:16px 0 6px;font-weight:bold;">סיכום לפי בית</p>' +
    '<table dir="rtl" cellpadding="0" cellspacing="0" style="border-collapse:collapse;direction:rtl;">' +
    '<tr><th style="' + th + '">בית</th><th style="' + th + '">תשלומים</th><th style="' + th + '">סכום (כולל מע״מ)</th></tr>';
  const sumLines = [];
  totals.byHouse.forEach(function (h) {
    html += '<tr><td style="' + td + '">' + digestEsc_(h.houseLabel) + '</td><td style="' + td + '">' + h.count +
      '</td><td style="' + td + 'white-space:nowrap;">' + digestEsc_(digestMoney_(h.amount)) + '</td></tr>';
    sumLines.push(digestPlain_(h.houseLabel) + ': ' + h.count + ' תשלומים, ' + digestMoney_(h.amount));
  });
  html += '<tr><td style="' + th + '">סה״כ</td><td style="' + th + '">' + totals.count +
    '</td><td style="' + th + 'white-space:nowrap;">' + digestEsc_(digestMoney_(totals.amount)) + '</td></tr></table>';
  html += note + link + '</div>';

  const text = pendingText + digestPlain_(windowText) + '\n\n' +
    'מטופל | בית | סכום | תאריך תשלום | אמצעי | אסמכתא | חשבונית | על שם | נרשם ע״י | נרשם ב-\n' + lines.join('\n') +
    '\n\nסיכום לפי בית:\n' + sumLines.join('\n') +
    '\nסה״כ: ' + totals.count + ' תשלומים, ' + digestMoney_(totals.amount) +
    '\n\n«נרשם» = דווח כשולם בדשבורד, לא אישור שהכסף הגיע לבנק. הסכומים כוללים מע״מ.' +
    '\nפתיחת הדשבורד: ' + DIGEST_DASHBOARD_URL;
  return { subject: subject, htmlBody: html, body: text, count: totals.count, total: totals.amount, pending: pending };
}

/* ---------------- the ledger (Script Properties, chunked) ---------------- */

/* { key: { amount, day: 'YYYY-MM-DD' } }. Unreadable → {} (the only cost is
 * that an edited row is not marked «עודכן» once). */
function digestLedgerLoad_(props) {
  const out = {};
  try {
    const n = Number(props.getProperty(DIGEST_PROP_LEDGER_N)) || 0;
    let s = '';
    for (let i = 0; i < n; i++) s += props.getProperty(DIGEST_PROP_LEDGER_PREFIX + i) || '';
    if (!s) return out;
    const obj = JSON.parse(s);
    Object.keys(obj).forEach(function (k) {
      const v = obj[k];
      if (v && typeof v === 'object') out[k] = { amount: Number(v[0]) || 0, day: String(v[1] || '') };
    });
  } catch (_) { /* fall through with what we have */ }
  return out;
}

/* The ledger after a successful send: every sent row at the amount sent,
 * entries older than DIGEST_LEDGER_KEEP_DAYS dropped. Returns the property
 * map to write (chunks + count) and the keys of stale chunks to delete. */
function digestLedgerNext_(ledger, rows, todayIso, oldChunkCount) {
  const next = {};
  const cutoff = new Date(Date.parse(todayIso + 'T00:00:00Z') - DIGEST_LEDGER_KEEP_DAYS * 86400000).toISOString().slice(0, 10);
  Object.keys(ledger).forEach(function (k) {
    if (ledger[k].day >= cutoff) next[k] = [ledger[k].amount, ledger[k].day];
  });
  rows.forEach(function (r) { if (r.key) next[r.key] = [r.amount, todayIso]; });
  const s = JSON.stringify(next);
  const set = {};
  let n = 0;
  for (let i = 0; i < s.length; i += DIGEST_LEDGER_CHUNK_CHARS) {
    set[DIGEST_PROP_LEDGER_PREFIX + n] = s.slice(i, i + DIGEST_LEDGER_CHUNK_CHARS);
    n++;
  }
  set[DIGEST_PROP_LEDGER_N] = String(n);
  const drop = [];
  for (let i = n; i < (Number(oldChunkCount) || 0); i++) drop.push(DIGEST_PROP_LEDGER_PREFIX + i);
  return { set: set, drop: drop };
}

/* ---------------- the run ---------------- */

/* Payments row objects, header-aware (so a hand-added method column is read),
 * READ-ONLY: getSheetByName, never getOrCreateSheet_. No sheet → []. */
function digestReadPayments_() {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(PAYMENTS_SHEET);
  if (!sh) return [];
  return recReadSheet_(sh, PAYMENT_COLUMNS).rows.map(function (r) { return r.obj; });
}

/* Build the digest for `now`, reading DIGEST_LAST_AT and the ledger. Pure apart
 * from the two reads; sends nothing, writes nothing. */
function digestBuild_(props, now, test) {
  const nowMs = now.getTime();
  const lastRaw = props.getProperty(DIGEST_PROP_LAST_AT) || '';
  const lastMs = digestInstant_(lastRaw);
  const firstRun = !isFinite(lastMs);
  const sinceMs = firstRun ? nowMs - DIGEST_FIRST_RUN_DAYS * 86400000 : lastMs;
  const ledger = digestLedgerLoad_(props);
  const payRows = digestReadPayments_();
  const rows = digestSelect_(payRows, sinceMs, nowMs, ledger);
  const today = digestJerusalemParts_(now);
  const fmt = function (ms) { return String(Utilities.formatDate(new Date(ms), DIGEST_TZ, 'dd/MM/yyyy HH:mm')); };
  const msg = digestCompose_(rows, {
    todayDmy: today.dmy, sinceText: fmt(sinceMs), untilText: fmt(nowMs), firstRun: firstRun, test: !!test,
    pendingCount: digestPendingCount_(payRows),
  });
  return { rows: rows, msg: msg, ledger: ledger, today: today, sinceMs: sinceMs, nowMs: nowMs, firstRun: firstRun };
}

/* The script lock was busy: nothing sent, nothing advanced. */
function digestLockBusy_() {
  Logger.log('DIGEST: script lock busy — nothing sent; the next run covers this window.');
  return { ok: false, mode: 'scheduled', error: 'lock_busy', sent: false };
}

/* The core. mode:
 *   'scheduled' — weekday gate, DIGEST_TO required, script lock, once per
 *                 Jerusalem day, advance DIGEST_LAST_AT + ledger after success;
 *   'preview'   — build and log; no send, no lock, no property write;
 *   'test'      — send to DIGEST_CC only; no property write.
 * Never throws for a configuration fault — it returns { ok:false, error } and
 * logs. A MailApp failure returns error 'send_failed' (and nothing advances). */
function paymentsDigestRun_(mode, nowArg) {
  const now = (nowArg instanceof Date) ? nowArg : new Date();
  const props = PropertiesService.getScriptProperties();

  if (mode === 'preview') {
    const b = digestBuild_(props, now, false);
    const to = digestRecipients_(props.getProperty(DIGEST_PROP_TO));
    const cc = digestRecipients_(props.getProperty(DIGEST_PROP_CC));
    const ccOn = !!cc && digestCcActive_(b.today.iso, props.getProperty(DIGEST_PROP_CC_UNTIL));
    Logger.log('DIGEST PREVIEW (not sent; ' + DIGEST_PROP_LAST_AT + ' unchanged)\n' +
      'to: ' + (to || '(DIGEST_TO missing or invalid — a scheduled run would send NOTHING)') + '\n' +
      'cc: ' + (ccOn ? cc : '(none)') + '\n' +
      'subject: ' + b.msg.subject + '\nrows: ' + b.msg.count + ', total: ' + digestMoney_(b.msg.total) + '\n\n' +
      b.msg.body + '\n\n--- HTML ---\n' + b.msg.htmlBody);
    return { ok: true, mode: 'preview', sent: false, to: to, cc: ccOn ? cc : '', subject: b.msg.subject,
      htmlBody: b.msg.htmlBody, body: b.msg.body, count: b.msg.count, total: b.msg.total };
  }

  if (mode === 'test') {
    const cc = digestRecipients_(props.getProperty(DIGEST_PROP_CC));
    if (!cc) {
      Logger.log('DIGEST TEST: ' + DIGEST_PROP_CC + ' is missing or invalid — nothing sent.');
      return { ok: false, mode: 'test', error: 'no_cc', sent: false };
    }
    const b = digestBuild_(props, now, true);
    try {
      MailApp.sendEmail({ to: cc, subject: b.msg.subject, htmlBody: b.msg.htmlBody, body: b.msg.body, name: DIGEST_SENDER_NAME });
    } catch (err) {
      Logger.log('DIGEST TEST: send failed: ' + ((err && err.message) || err));
      return { ok: false, mode: 'test', error: 'send_failed', sent: false };
    }
    Logger.log('DIGEST TEST: sent to ' + DIGEST_PROP_CC + ' only (' + b.msg.count + ' rows). ' + DIGEST_PROP_LAST_AT + ' unchanged.');
    return { ok: true, mode: 'test', sent: true, to: cc, subject: b.msg.subject, count: b.msg.count, total: b.msg.total };
  }

  // ---- scheduled ----
  const today = digestJerusalemParts_(now);
  if (!digestIsWorkday_(now)) {
    Logger.log('DIGEST: ' + today.iso + ' is Friday/Saturday in Jerusalem — skipped.');
    return { ok: true, mode: 'scheduled', skipped: 'weekend', sent: false };
  }
  const to = digestRecipients_(props.getProperty(DIGEST_PROP_TO));
  if (!to) {
    Logger.log('WARNING DIGEST: ' + DIGEST_PROP_TO + ' is missing or invalid — nothing sent (fail closed).');
    return { ok: false, mode: 'scheduled', error: 'no_recipient', sent: false };
  }
  const lock = LockService.getScriptLock();
  if (lock.tryLock(30000) !== true) return digestLockBusy_();
  try {
    if ((props.getProperty(DIGEST_PROP_LAST_DAY) || '') === today.iso) {
      Logger.log('DIGEST: already sent today (' + today.iso + ') — skipped.');
      return { ok: true, mode: 'scheduled', skipped: 'already_sent_today', sent: false };
    }
    const b = digestBuild_(props, now, false);
    const cc = digestRecipients_(props.getProperty(DIGEST_PROP_CC));
    const ccOn = !!cc && digestCcActive_(today.iso, props.getProperty(DIGEST_PROP_CC_UNTIL));
    const mail = { to: to, subject: b.msg.subject, htmlBody: b.msg.htmlBody, body: b.msg.body, name: DIGEST_SENDER_NAME };
    if (ccOn) mail.cc = cc;
    try {
      MailApp.sendEmail(mail);
    } catch (err) {
      Logger.log('DIGEST: send failed (' + ((err && err.message) || err) + ') — ' +
        DIGEST_PROP_LAST_AT + ' NOT advanced; the next run covers this window.');
      return { ok: false, mode: 'scheduled', error: 'send_failed', sent: false };
    }
    // Sent. Only now does the window move.
    const oldChunks = Number(props.getProperty(DIGEST_PROP_LEDGER_N)) || 0;
    const led = digestLedgerNext_(b.ledger, b.rows, today.iso, oldChunks);
    const set = led.set;
    set[DIGEST_PROP_LAST_AT] = israelTimestamp_(now);
    set[DIGEST_PROP_LAST_DAY] = today.iso;
    props.setProperties(set, false);
    led.drop.forEach(function (k) { props.deleteProperty(k); });
    Logger.log('DIGEST: sent (' + b.msg.count + ' rows, ' + digestMoney_(b.msg.total) + ')' + (ccOn ? ' with CC.' : '.'));
    return { ok: true, mode: 'scheduled', sent: true, cc: ccOn, count: b.msg.count, total: b.msg.total };
  } finally {
    try { lock.releaseLock(); } catch (_) { /* no-op */ }
  }
}

/* TRIGGER HANDLER (time-driven, daily ~08:00 Asia/Jerusalem). Public because a
 * trigger cannot call a trailing-underscore function; handle_ never names it.
 * A failed send THROWS after logging, so the execution shows as Failed and
 * Google's failure notice reaches the trigger owner; nothing has advanced. */
function paymentsDigestJob() {
  const res = paymentsDigestRun_('scheduled');
  if (res && res.error === 'send_failed') throw new Error('Payments digest: send failed — the next run covers this window.');
  return res;
}

/* ---------------- editor-run (Run dropdown) ---------------- */

/* STEP 1. Forces the FULL consent dialog. Deliberately UNCAUGHT and FIRST: with
 * Google's granular consent a user can tick only some scopes; a partial grant
 * must fail HERE, loudly, not at 08:00 inside a trigger nobody watches. */
function authorizeDigestNow() {
  ScriptApp.requireAllScopes(ScriptApp.AuthMode.FULL);
  const quota = MailApp.getRemainingDailyQuota();
  Logger.log('DIGEST: authorized. Remaining daily mail quota: ' + quota);
  return { ok: true, remainingDailyQuota: quota };
}

/* STEP 2. Build the mail for now and log it. Sends NOTHING, moves NOTHING. */
function previewDigestNow() {
  return paymentsDigestRun_('preview');
}

/* STEP 3. Send to DIGEST_CC only. DIGEST_LAST_AT does not move. */
function sendDigestTestNow() {
  return paymentsDigestRun_('test');
}

/* STEP 4. Idempotent: removes EVERY trigger bound to the digest handler, then
 * installs exactly one daily trigger at 08:00 Asia/Jerusalem (Apps Script runs
 * it within that hour; nearMinute(0) asks for the top of it). */
function installDigestTriggerNow() {
  const triggers = ScriptApp.getProjectTriggers();
  let removed = 0;
  for (let i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === DIGEST_TRIGGER_HANDLER) {
      ScriptApp.deleteTrigger(triggers[i]);
      removed++;
    }
  }
  let installed = '';
  try {
    ScriptApp.newTrigger(DIGEST_TRIGGER_HANDLER).timeBased().everyDays(1)
      .atHour(DIGEST_TRIGGER_HOUR).nearMinute(0).inTimezone(DIGEST_TZ).create();
    installed = DIGEST_TRIGGER_HANDLER + ' @ ~08:00 ' + DIGEST_TZ;
  } catch (_) {
    ScriptApp.newTrigger(DIGEST_TRIGGER_HANDLER).timeBased().everyDays(1)
      .atHour(DIGEST_TRIGGER_HOUR).inTimezone(DIGEST_TZ).create();
    installed = DIGEST_TRIGGER_HANDLER + ' @ 08:00–09:00 ' + DIGEST_TZ;
  }
  const res = { ok: true, removed: removed, installed: installed };
  Logger.log('DIGEST trigger: ' + JSON.stringify(res));
  return res;
}

/* ===== Duplicate-payment report (READ-ONLY on the spreadsheet — run from the editor) =====
 * CHANGELOG-duplicate-payments-report.md.
 *
 * duplicatePaymentsReportNow() lists the Payments rows that look like the
 * SAME money recorded twice, and writes them into ONE new, private Google Doc
 * ("E-Zone דוח תשלומים כפולים YYYY-MM-DD HH:mm"), right-to-left, whose URL it
 * logs — the reconciliationReportNow() pattern (recReadSheet_, recDocPara_,
 * recDocTable_). The spreadsheet is NEVER written: getSheetByName +
 * getValues only, no lock, no AuditLog row, no property. The Doc is not
 * shared or moved.
 *
 * Which rows (dupPaymentsFind_, pure):
 *   - a money row: a receipt ('rcpt-…') or a legacy cycle marked paid /
 *     partial with NO receipt linked to it (a cycle that has receipts carries
 *     their derived total, so comparing it with them would flag every report);
 *   - not voided (status void / מבוטל);
 *   - created on/after DUP_REPORT_SINCE (Israel time): recordedAt, else
 *     timestamp, else chargedAt.
 * Two such rows are a suspected duplicate when they share the patient
 * (patientUid, else patientId) OR the cycle (a receipt's linked cycle id / a
 * cycle's own id), AND the same amount, AND either the same payment date
 * (receivedDate, else dueDate) or creation times within 10 minutes. Pairs are
 * grouped (a chain of three is one group). Intentionally PUBLIC (Run menu)
 * and NOT reachable over HTTP: handle_'s action allow-list never names it. */
const DUP_REPORT_SINCE = '2026-09-30';
const DUP_REPORT_WINDOW_MS = 10 * 60 * 1000;

function duplicatePaymentsReportNow() {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(PAYMENTS_SHEET);
  const read = sh ? recReadSheet_(sh, PAYMENT_COLUMNS) : { rows: [] };
  const report = dupPaymentsFind_(read.rows, DUP_REPORT_SINCE);
  report.missingSheet = !sh;
  const now = new Date();
  const two = function (n) { return ('0' + n).slice(-2); };
  const title = 'E-Zone דוח תשלומים כפולים ' + localPartsISO_(now) + ' ' + two(now.getHours()) + ':' + two(now.getMinutes());
  const out = dupPaymentsWriteDoc_(report, title);
  report.title = title;
  report.url = out.url;
  Logger.log('duplicatePaymentsReportNow — READ-ONLY on the spreadsheet. ' + report.groups.length + ' group(s), ' +
    report.rowCount + ' row(s) since ' + DUP_REPORT_SINCE + '. Report: ' + title + ' — ' + out.url);
  return report;
}

/* A cell's creation instant in ms, or NaN. Date cells as-is; strings through
 * Date.parse (recordedAt is ISO with an offset, timestamp is ISO UTC). Pure. */
function dupCreatedMs_(obj) {
  const o = obj || {};
  const cands = [o.recordedAt, o.timestamp, o.chargedAt];
  for (let i = 0; i < cands.length; i++) {
    const v = cands[i];
    if (v instanceof Date && !isNaN(v.getTime())) return v.getTime();
    const t = String(v == null ? '' : v).trim();
    if (!t) continue;
    const ms = Date.parse(t);
    if (!isNaN(ms)) return ms;
  }
  return NaN;
}

/* 'YYYY-MM-DD' of a date cell (receivedDate, else dueDate), or ''. Pure. */
function dupPayDate_(obj) {
  const o = obj || {};
  const pick = function (v) { return v instanceof Date ? localPartsISO_(v) : (paymentReportDate_(v) || coverageDateISO_(v) || ''); };
  return pick(o.receivedDate) || pick(o.dueDate);
}

/* rows: [{ rowNumber, obj }] (recReadSheet_). PURE.
 * → { since, rowCount, groups: [[entry…]] }, entry = { rowNumber, patient,
 *   house, amount, date, method, reference, receiptId, created, createdMs }. */
function dupPaymentsFind_(rows, sinceIso) {
  const list = Array.isArray(rows) ? rows : [];
  const objs = list.map(function (r) { return (r && r.obj) || {}; });
  const L = linkReceiptsToCycles_(objs);
  const cycleOf = {};
  L.receipts.forEach(function (rc) { cycleOf[rc.index] = rc.cycleIndex >= 0 ? paymentCell_(objs[rc.cycleIndex].id) : ''; });
  const sinceMs = Date.parse(String(sinceIso || DUP_REPORT_SINCE) + 'T00:00:00+03:00');

  const entries = [];
  objs.forEach(function (o, i) {
    if (isVoidStatus_(o.status)) return;
    const receipt = isReceiptRow_(o);
    if (!receipt && (!paymentIsCharged_(o.status) || L.byCycle[i])) return;
    const createdMs = dupCreatedMs_(o);
    if (isNaN(createdMs) || createdMs < sinceMs) return;
    const paid = paymentCell_(o.amountPaid);
    const amount = receiptMoney_(paid !== '' && receiptMoney_(paid) > 0 ? paid : o.amount);
    if (amount <= 0) return;
    entries.push({
      index: i, rowNumber: list[i].rowNumber,
      patientKey: paymentCell_(o.patientUid) || paymentCell_(o.patientId),
      cycleKey: receipt ? (cycleOf[i] || '') : paymentCell_(o.id),
      patient: paymentCell_(o.patientName), house: paymentCell_(o.houseId), amount: amount,
      date: dupPayDate_(o), method: paymentCell_(o.method), reference: paymentCell_(o.reference),
      receiptId: receipt ? paymentCell_(o.id) : '',
      created: o.recordedAt instanceof Date || o.timestamp instanceof Date
        ? new Date(createdMs).toISOString() : (paymentCell_(o.recordedAt) || paymentCell_(o.timestamp) || paymentCell_(o.chargedAt)),
      createdMs: createdMs,
    });
  });

  // Union-find over the matching pairs.
  const parent = entries.map(function (_, k) { return k; });
  const find = function (k) { while (parent[k] !== k) { parent[k] = parent[parent[k]]; k = parent[k]; } return k; };
  for (let a = 0; a < entries.length; a++) {
    for (let b = a + 1; b < entries.length; b++) {
      const x = entries[a], y = entries[b];
      const samePatient = !!x.patientKey && x.patientKey === y.patientKey;
      const sameCycle = !!x.cycleKey && x.cycleKey === y.cycleKey;
      if (!(samePatient || sameCycle) || x.amount !== y.amount) continue;
      const sameDate = !!x.date && x.date === y.date;
      const close = Math.abs(x.createdMs - y.createdMs) <= DUP_REPORT_WINDOW_MS;
      if (sameDate || close) parent[find(b)] = find(a);
    }
  }
  const byRoot = {};
  entries.forEach(function (e, k) { const r = find(k); (byRoot[r] = byRoot[r] || []).push(e); });
  const groups = Object.keys(byRoot).map(function (r) { return byRoot[r]; })
    .filter(function (g) { return g.length > 1; })
    .map(function (g) { return g.sort(function (p, q) { return p.createdMs - q.createdMs || p.rowNumber - q.rowNumber; }); })
    .sort(function (p, q) { return p[0].createdMs - q[0].createdMs; });
  return { since: String(sinceIso || DUP_REPORT_SINCE), rowCount: entries.length, groups: groups };
}

/* Writes the report into ONE new Google Doc → { url, id }. Nothing is shared,
 * moved or written anywhere else. */
function dupPaymentsWriteDoc_(report, title) {
  const doc = DocumentApp.create(title);
  const body = doc.getBody();
  const first = body.getParagraphs();
  for (let i = 0; i < first.length; i++) first[i].setLeftToRight(false);
  recDocPara_(body, title, DocumentApp.ParagraphHeading.TITLE);
  recDocPara_(body, 'דוח לקריאה בלבד: הגיליון לא שונה. שורות תשלום (לא מבוטלות) שנוצרו מ-' + recDateText_(report.since) +
    ': אותו מטופל או מחזור, אותו סכום, ואותו תאריך תשלום או נוצרו בהפרש של עד 10 דקות.', null);
  if (report.missingSheet) recDocPara_(body, 'לשונית Payments לא נמצאה.', null);
  recDocPara_(body, 'נבדקו ' + report.rowCount + ' שורות. נמצאו ' + report.groups.length + ' קבוצות חשודות.', null);
  if (!report.groups.length) { recDocPara_(body, 'אין פריטים.', null); doc.saveAndClose(); return { url: doc.getUrl(), id: doc.getId() }; }
  const rows = [['קבוצה', 'שורה בגיליון', 'מטופל', 'בית', 'סכום', 'תאריך', 'אמצעי', 'אסמכתא', 'מזהה קבלה', 'נוצר']];
  report.groups.forEach(function (g, n) {
    g.forEach(function (e) {
      rows.push([String(n + 1), String(e.rowNumber), e.patient, e.house, recShekel_(e.amount), recDateText_(e.date),
        e.method, e.reference, e.receiptId, e.created]);
    });
  });
  recDocTable_(body, rows);
  doc.saveAndClose();
  return { url: doc.getUrl(), id: doc.getId() };
}


/* ===== Missing-patient diagnostic (READ-ONLY — run from the editor) =====
 *
 * diagnoseRamotPatientsNow() answers "where did this ramot patient go?" from
 * the live spreadsheet in one run, with ZERO writes: sheets are opened with
 * getSheetByName only (never getOrCreateSheet_, which can insert a tab, extend
 * a header row and re-format columns), cells are read with getValues, and the
 * findings go to the Executions log. No lock, no AuditLog row, no property.
 * test/missing-patient-diagnostic.test.js source-scans this function AND every
 * Code.gs helper it reaches for a write call, and runs it against sheets whose
 * every mutator throws.
 *
 * Log sections:
 *   (0) header check — each tab's row 1 against the columns the app reads it
 *       with. The app maps cells BY POSITION (readSheet_): a drifted header
 *       means every field under it is misread.
 *   (a) every row whose house is ramot in ANY form — the id, the Hebrew label,
 *       padded / cased / invisible-character / U+FFFD-damaged variants — in
 *       Leads, Clients (only if such a tab exists: CLIENTS_HEADERS belongs to
 *       ezone-outpatient, not this app), Patients, מטופלים משוחררים, לידים לא
 *       רלוונטיים, לידים שהוסרו, plus PatientsTombstones (recovery copies of
 *       deleted / de-duplicated rows) and Outpatients (house_of_origin).
 *       Patients rows with NO house are listed too: getData_ drops them, so no
 *       tab can ever show them. Every Patients / discharge line carries the
 *       Dashboard's verdict — would the ramot tab show it, and if not, why.
 *   (b) every row, in ANY tab, whose name holds U+FFFD.
 *   (c) every id / normalized phone seen more than once (in one tab or across
 *       tabs), plus ramot identity-key and fromLead twins in Patients (rows the
 *       discharge heal and the key-delete cannot tell apart).
 *   (e) ANY house, not only ramot, in two parts:
 *       - every Patients and PatientsTombstones row whose house resolves to NO
 *         known house id (app.js resolveHouseId: no house tab can ever show
 *         such a row), blank houses included, each with the one known house
 *         it most likely means when exactly one fits;
 *       - every PatientsTombstones 'user-delete' row (the recovery copy the ✕
 *         permanent delete writes) whose droppedAt is within the last 60 days
 *         — who deleted it and when, and whether that patient is back on
 *         Patients. An unreadable droppedAt is listed too, never hidden.
 *       Printed BEFORE (d), so the SUMMARY stays the last log line.
 *   (d) SUMMARY — ramot counts per tab and per status / stage, plus the (e)
 *       counts.
 * Returns the report object as well. Intentionally PUBLIC (Run dropdown) and
 * NOT reachable over HTTP: handle_'s fixed action allow-list never names it. */
function diagnoseRamotPatientsNow() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const RAMOT = MANAGER_HOUSE_TO_PATIENTS_HOUSE_ID.ramot;
  const lines = [];
  const say = function (s) { lines.push(s); Logger.log(s); };
  const report = { headers: [], ramotRows: [], blankHouseRows: [], corruptedNames: [], duplicates: [], twins: [],
    unresolvedHouseRows: [], recentUserDeletes: [], summary: {} };

  say('diagnoseRamotPatientsNow — READ-ONLY: no cell, tab, lock or property is written. House: ' +
    RAMOT + ' / ' + MANAGER_HOUSE_NAMES.ramot + '.');

  // ---- read every target tab (positional where the app owns the tab) ----
  const tabs = {};
  diagRamotTargets_().forEach(function (t) {
    const sh = ss.getSheetByName(t.sheet);
    if (!sh) {
      say('(0) ' + t.sheet + ': no such tab' + (t.columns ? '' : ' (expected — CLIENTS_HEADERS is ezone-outpatient\'s sheet)') + ' — skipped.');
      return;
    }
    let d;
    try { d = diagReadSheet_(sh, t.columns); } catch (err) {
      say('(0) ' + t.sheet + ': READ FAILED — ' + ((err && err.message) || err));
      return;
    }
    const f = {};
    ['id', 'name', 'phone', 'house', 'stage', 'status', 'disposition', 'dischargedAt', 'restored', 'removedAt',
      'date', 'exitDate', 'fromLead', 'prior_status', 'reason', 'droppedAt', 'movedAt', 'updatedAt', 'updatedBy',
      'savedByAction']
      .forEach(function (k) { f[k] = diagColumnFor_(d.columns, k); });
    tabs[t.sheet] = { spec: t, data: d, f: f };
    const drift = t.columns ? diagHeaderDrift_(d.header, t.columns) : [];
    report.headers.push({ sheet: t.sheet, drift: drift });
    say('(0) ' + t.sheet + ': ' + d.rows.length + ' data row(s); header ' +
      (!t.columns ? 'read from the tab itself (' + d.header.length + ' columns)'
        : drift.length === 0 ? 'OK' : 'DRIFT — ' + drift.join('; ') + ' — the app reads this tab BY POSITION, so these fields are misread'));
  });

  const cell = function (tab, r, k) { return tab.f[k] ? r.obj[tab.f[k]] : undefined; };
  const text = function (v) { return String(v == null ? '' : v).trim(); };

  // Lead phone by lead id (Leads + the two closed-lead tabs) — the fromLead
  // join getAdmittedRoster_ uses; Patients rows carry no phone of their own.
  const leadPhone = {};
  [LEADS_SHEET, IRRELEVANT_LEADS_SHEET, REMOVED_LEADS_SHEET].forEach(function (name) {
    const tab = tabs[name];
    if (!tab) return;
    tab.data.rows.forEach(function (r) {
      const id = text(cell(tab, r, 'id'));
      if (id && !(id in leadPhone)) leadPhone[id] = cell(tab, r, 'phone');
    });
  });

  // ---- the Dashboard's view of Patients: load order, client house/status ----
  const pat = tabs[PATIENTS_SHEET];
  const dis = tabs[DISCHARGED_PATIENTS_SHEET];
  const stayKey = function (house, name, date) { return house + '::' + text(name) + '::' + asISODate_(date); };
  const loadOrder = [];   // Patients rows in the order the client holds them
  if (pat) {
    const buckets = [];
    const byBucket = {};
    pat.data.rows.forEach(function (r) {
      const raw = cell(pat, r, 'house');
      if (!raw) return;                       // getData_: `if (!hid) continue;`
      const k = String(raw);
      if (!byBucket[k]) { byBucket[k] = []; buckets.push(k); }
      byBucket[k].push(r);
    });
    buckets.forEach(function (k) { byBucket[k].forEach(function (r) { loadOrder.push(r); }); });
  }
  const healFirstByStay = {};           // stay → the heal's first match
  loadOrder.forEach(function (r) {
    const k = stayKey(diagClientHouseId_(cell(pat, r, 'house')), cell(pat, r, 'name'), cell(pat, r, 'date'));
    if (!(k in healFirstByStay)) healFirstByStay[k] = r;
  });
  const openAuditsByStay = {};
  if (dis) {
    dis.data.rows.forEach(function (r) {
      if (diagIsRestored_(cell(dis, r, 'restored'))) return;
      const k = stayKey(diagClientHouseId_(cell(dis, r, 'house')), cell(dis, r, 'name'), cell(dis, r, 'date'));
      (openAuditsByStay[k] = openAuditsByStay[k] || []).push(r.rowNumber);
    });
  }
  const patientsByStay = {};
  loadOrder.forEach(function (r) {
    const k = stayKey(diagClientHouseId_(cell(pat, r, 'house')), cell(pat, r, 'name'), cell(pat, r, 'date'));
    (patientsByStay[k] = patientsByStay[k] || []).push(r);
  });

  const patientVerdict = function (r) {
    const raw = cell(pat, r, 'house');
    if (raw === '' || raw === null || raw === undefined) return 'DROPPED by getData_ (blank houseId) — invisible in every tab';
    const house = diagClientHouseId_(raw);
    if (house !== RAMOT) return 'HIDDEN — the app resolves house ' + diagVisible_(raw) + ' to ' + diagVisible_(house) + ', not the ramot tab';
    const status = diagClientStatus_(cell(pat, r, 'status'));
    if (status === 'released') return 'HIDDEN — status ' + diagVisible_(cell(pat, r, 'status')) + ' reads as released (shown only with הצג משוחררים)';
    const k = stayKey(house, cell(pat, r, 'name'), cell(pat, r, 'date'));
    const open = openAuditsByStay[k];
    if (open && open.length) {
      return healFirstByStay[k] === r
        ? 'VISIBLE NOW, BUT the OPEN discharge record (' + DISCHARGED_PATIENTS_SHEET + ' row ' + open.join('+') +
          ') matches it — the next load\'s heal will mark it released'
        : 'VISIBLE (an open discharge record matches this stay, but the heal acts on row ' + healFirstByStay[k].rowNumber + ' first)';
    }
    return 'VISIBLE in the ramot tab (' + status + ')';
  };
  const auditVerdict = function (r) {
    if (diagIsRestored_(cell(dis, r, 'restored'))) return 'closed (restored) — ignored by the heal';
    const k = stayKey(diagClientHouseId_(cell(dis, r, 'house')), cell(dis, r, 'name'), cell(dis, r, 'date'));
    const rows = patientsByStay[k] || [];
    if (rows.length === 0) return 'OPEN — no Patients row has this house+name+entry date (a restore would RECONSTRUCT the patient)';
    const first = rows[0];
    return 'OPEN — matches Patients row ' + rows.map(function (x) { return x.rowNumber; }).join('+') +
      '; the heal acts on row ' + first.rowNumber + ' (status ' + diagVisible_(cell(pat, first, 'status')) +
      (diagClientStatus_(cell(pat, first, 'status')) === 'released' ? ', already released)' : ' → WILL BE MARKED RELEASED on the next load)');
  };

  // ---- (a) every ramot row, every tab ----
  say('(a) Rows whose house is ramot in any form:');
  const counts = {};
  diagRamotTargets_().forEach(function (t) {
    const tab = tabs[t.sheet];
    if (!tab) return;
    const perReason = {};
    tab.data.rows.forEach(function (r) {
      const rawHouse = cell(tab, r, 'house');
      const kind = diagRamotHouseMatch_(rawHouse);
      const blank = t.sheet === PATIENTS_SHEET && text(rawHouse) === '';
      if (!kind && !blank) return;
      const statusCol = t.stageNotStatus ? 'stage' : 'status';
      const statusRaw = cell(tab, r, statusCol);
      if (kind) {
        const c = counts[t.sheet] = counts[t.sheet] || { rows: 0, by: {} };
        const statusKey = t.sheet === PATIENTS_SHEET ? diagClientStatus_(statusRaw)
          : t.sheet === DISCHARGED_PATIENTS_SHEET ? (diagIsRestored_(cell(tab, r, 'restored')) ? 'restored' : 'OPEN')
          : t.sheet === PATIENTS_TOMBSTONES_SHEET ? (text(cell(tab, r, 'reason')) || '(no reason)')
          : !tab.f[statusCol] && !tab.f.disposition ? 'n/a'
          : text(statusRaw) || text(cell(tab, r, 'disposition')) || '(blank)';
        c.rows++;
        c.by[statusKey] = (c.by[statusKey] || 0) + 1;
      }
      // Merge-don't-drop audit copies are numerous and mean the row was KEPT:
      // summarized per name below instead of one line each.
      if (t.sheet === PATIENTS_TOMBSTONES_SHEET && text(cell(tab, r, 'reason')) === 'saveAll-omitted-preserved') {
        const nm = text(cell(tab, r, 'name'));
        const agg = perReason[nm] = perReason[nm] || { n: 0, last: '' };
        agg.n++;
        const at = text(cell(tab, r, 'droppedAt'));
        if (at > agg.last) agg.last = at;
        return;
      }
      const fl = text(cell(tab, r, 'fromLead'));
      const ownPhone = cell(tab, r, 'phone');
      const phone = diagPhoneKey_(ownPhone) ||
        (fl && diagPhoneKey_(leadPhone[fl]) ? diagPhoneKey_(leadPhone[fl]) + ' (via fromLead ' + fl + ')' : '');
      const entry = {
        sheet: t.sheet, row: r.rowNumber, house: blank ? 'BLANK' : kind,
        id: text(cell(tab, r, 'id')), name: String(cell(tab, r, 'name') == null ? '' : cell(tab, r, 'name')), phone: phone,
      };
      let line = '(a) ' + t.sheet + ' row ' + r.rowNumber +
        ' | house ' + (blank ? diagVisible_(rawHouse) + ' [NO HOUSE]' : diagVisible_(rawHouse) + ' [' + kind + ']') +
        ' | id ' + diagVisible_(entry.id) +
        ' | name ' + diagVisible_(entry.name) + diagNameFlags_(entry.name) +
        ' | phone ' + (phone || '—') +
        ' | stage/status ' + (tab.f[statusCol] ? diagVisible_(statusRaw) : '—') +
        ' | disposition ' + (tab.f.disposition ? diagVisible_(cell(tab, r, 'disposition')) : '—') +
        ' | dischargedAt ' + (tab.f.dischargedAt ? diagVisible_(cell(tab, r, 'dischargedAt')) : '—') +
        ' | restored ' + (tab.f.restored ? diagVisible_(cell(tab, r, 'restored')) : '—') +
        ' | removedAt ' + (tab.f.removedAt ? diagVisible_(cell(tab, r, 'removedAt')) : '—');
      ['date', 'exitDate', 'fromLead', 'prior_status', 'movedAt', 'reason', 'droppedAt', 'updatedAt', 'updatedBy'].forEach(function (k) {
        if (tab.f[k]) line += ' | ' + (k === 'date' ? 'entryDate' : k) + ' ' + diagVisible_(cell(tab, r, k));
      });
      if (t.sheet === PATIENTS_SHEET) { entry.verdict = patientVerdict(r); line += ' || DASHBOARD: ' + entry.verdict; }
      if (t.sheet === DISCHARGED_PATIENTS_SHEET) { entry.verdict = auditVerdict(r); line += ' || ' + entry.verdict; }
      (blank ? report.blankHouseRows : report.ramotRows).push(entry);
      say(line);
    });
    Object.keys(perReason).forEach(function (nm) {
      say('(a) ' + t.sheet + ' | saveAll-omitted-preserved ×' + perReason[nm].n + ' for name ' + diagVisible_(nm) +
        ' (rows KEPT on Patients — audit copies of stale saves; last ' + (perReason[nm].last || '?') + ')');
    });
  });

  // ---- (b) U+FFFD names, any tab ----
  say('(b) Rows whose name holds U+FFFD (any tab):');
  let fffdTotal = 0;
  ss.getSheets().forEach(function (sh) {
    let name;
    try { name = sh.getName(); } catch (_) { return; }
    let hits = 0;
    try {
      const lastRow = sh.getLastRow();
      const lastCol = sh.getLastColumn();
      if (lastRow < 2 || lastCol < 1) return;
      const header = sh.getRange(1, 1, 1, lastCol).getValues()[0];
      for (let c = 0; c < header.length; c++) {
        if (!diagIsNameHeader_(header[c])) continue;
        const col = sh.getRange(2, c + 1, lastRow - 1, 1).getValues();
        for (let i = 0; i < col.length; i++) {
          if (!hasCorruption_(col[i][0])) continue;
          hits++;
          fffdTotal++;
          if (hits <= 200) {
            report.corruptedNames.push({ sheet: name, row: i + 2, column: String(header[c]), value: String(col[i][0]) });
            say('(b) ' + name + ' row ' + (i + 2) + ' [' + String(header[c]).trim() + '] ' + diagVisible_(col[i][0]));
          }
        }
      }
    } catch (err) {
      say('(b) ' + name + ': READ FAILED — ' + ((err && err.message) || err));
    }
    if (hits > 200) say('(b) ' + name + ': +' + (hits - 200) + ' more U+FFFD row(s) not listed (capped at 200 per tab).');
  });
  if (fffdTotal === 0) say('(b) none.');

  // ---- (c) duplicate ids / phones; ramot identity twins ----
  say('(c) ids / normalized phones seen more than once:');
  const seen = { id: {}, phone: {} };
  [LEADS_SHEET, 'Clients', PATIENTS_SHEET, DISCHARGED_PATIENTS_SHEET, IRRELEVANT_LEADS_SHEET, REMOVED_LEADS_SHEET].forEach(function (name) {
    const tab = tabs[name];
    if (!tab) return;
    tab.data.rows.forEach(function (r) {
      const where = name + ' row ' + r.rowNumber + (diagRamotHouseMatch_(cell(tab, r, 'house')) ? ' [ramot]' : '');
      const id = text(cell(tab, r, 'id'));
      if (id) (seen.id[id] = seen.id[id] || []).push(where);
      const ph = diagPhoneKey_(cell(tab, r, 'phone'));
      if (ph) (seen.phone[ph] = seen.phone[ph] || []).push(where);
    });
  });
  ['id', 'phone'].forEach(function (kind) {
    Object.keys(seen[kind]).forEach(function (v) {
      const at = seen[kind][v];
      if (at.length < 2) return;
      report.duplicates.push({ kind: kind, value: v, at: at });
      say('(c) DUPLICATE ' + kind + ' ' + diagVisible_(v) + ' ×' + at.length + ': ' + at.join('; '));
    });
  });
  if (pat) {
    const byKey = {};
    const byLead = {};
    pat.data.rows.forEach(function (r) {
      if (diagClientHouseId_(cell(pat, r, 'house')) !== RAMOT) return;
      const desc = 'row ' + r.rowNumber + ' (' + diagVisible_(cell(pat, r, 'status')) + ')';
      const k = stayKey(RAMOT, cell(pat, r, 'name'), cell(pat, r, 'date'));
      (byKey[k] = byKey[k] || []).push(desc);
      const fl = text(cell(pat, r, 'fromLead'));
      if (fl) (byLead[fl] = byLead[fl] || []).push(desc);
    });
    Object.keys(byKey).forEach(function (k) {
      if (byKey[k].length < 2) return;
      report.twins.push({ kind: 'key', value: k, at: byKey[k] });
      say('(c) ramot IDENTITY-KEY twins ' + diagVisible_(k) + ' ×' + byKey[k].length + ': ' + byKey[k].join('; ') +
        ' — the discharge heal acts on the first of these; the ✕ key-delete removes all');
    });
    Object.keys(byLead).forEach(function (fl) {
      if (byLead[fl].length < 2) return;
      report.twins.push({ kind: 'fromLead', value: fl, at: byLead[fl] });
      say('(c) ramot fromLead twins ' + diagVisible_(fl) + ' ×' + byLead[fl].length + ': ' + byLead[fl].join('; '));
    });
  }
  if (report.duplicates.length === 0 && report.twins.length === 0) say('(c) none.');

  // ---- (e) ANY house: houses that resolve to no known id; recent user deletes ----
  // Printed before (d) so the SUMMARY stays the last line of the log.
  const known = diagKnownHouseIds_();
  const tomb = tabs[PATIENTS_TOMBSTONES_SHEET];
  const USER_DELETE_DAYS = 60;
  const nowMs = new Date().getTime();
  const sinceMs = nowMs - USER_DELETE_DAYS * 24 * 60 * 60 * 1000;
  const field = function (tab, r, k, label) {
    return tab.f[k] ? ' | ' + (label || k) + ' ' + diagVisible_(cell(tab, r, k)) : '';
  };
  // Where a tombstoned patient is NOW on Patients: its id first, else its stay.
  const patientRowById = {};
  const patientRowByStay = {};
  if (pat) {
    pat.data.rows.forEach(function (r) {
      const id = text(cell(pat, r, 'id'));
      if (id && !(id in patientRowById)) patientRowById[id] = r.rowNumber;
      const k = stayKey(diagClientHouseId_(cell(pat, r, 'house')), cell(pat, r, 'name'), cell(pat, r, 'date'));
      if (!(k in patientRowByStay)) patientRowByStay[k] = r.rowNumber;
    });
  }
  const unresolved = {};
  say('(e) Patients / PatientsTombstones rows in ANY house whose house resolves to no known house id (' +
    known.join(', ') + '):');
  [PATIENTS_SHEET, PATIENTS_TOMBSTONES_SHEET].forEach(function (name) {
    const tab = tabs[name];
    if (!tab) { say('(e) ' + name + ': no such tab — skipped.'); return; }
    unresolved[name] = 0;
    const preservedCopies = {};   // merge-don't-drop audit copies, per house + name
    const copyOrder = [];
    tab.data.rows.forEach(function (r) {
      const raw = cell(tab, r, 'house');
      const resolved = diagClientHouseId_(raw);
      if (known.indexOf(resolved) >= 0) return;
      unresolved[name]++;
      const nm = String(cell(tab, r, 'name') == null ? '' : cell(tab, r, 'name'));
      const reason = text(cell(tab, r, 'reason'));
      const blank = text(raw) === '';
      const look = blank ? '' : diagHouseLookalike_(raw);
      report.unresolvedHouseRows.push({
        sheet: name, row: r.rowNumber, house: String(raw == null ? '' : raw), resolved: resolved,
        lookalike: look, id: text(cell(tab, r, 'id')), name: nm, reason: reason,
      });
      if (name === PATIENTS_TOMBSTONES_SHEET && reason === 'saveAll-omitted-preserved') {
        const k = JSON.stringify([String(raw == null ? '' : raw), nm]);
        if (!preservedCopies[k]) { preservedCopies[k] = { raw: raw, name: nm, rows: [], last: '' }; copyOrder.push(k); }
        preservedCopies[k].rows.push(r.rowNumber);
        const at = text(cell(tab, r, 'droppedAt'));
        if (at > preservedCopies[k].last) preservedCopies[k].last = at;
        return;
      }
      let line = '(e) ' + name + ' row ' + r.rowNumber + ' | house ' + diagVisible_(raw) +
        (blank ? ' [NO HOUSE]' : ' → ' + diagVisible_(resolved) + ' [no such house' + (look ? '; looks like ' + look : '') + ']') +
        ' | id ' + diagVisible_(text(cell(tab, r, 'id'))) + ' | name ' + diagVisible_(nm) + diagNameFlags_(nm) +
        field(tab, r, 'status') + field(tab, r, 'date', 'entryDate') + field(tab, r, 'exitDate') + field(tab, r, 'fromLead') +
        field(tab, r, 'reason') + field(tab, r, 'droppedAt') + field(tab, r, 'savedByAction') +
        field(tab, r, 'updatedAt') + field(tab, r, 'updatedBy');
      if (name === PATIENTS_SHEET) {
        line += blank ? ' || DASHBOARD: DROPPED by getData_ (blank houseId) — invisible in every tab'
          : ' || DASHBOARD: INVISIBLE — no house tab shows house ' + diagVisible_(resolved);
      }
      say(line);
    });
    copyOrder.forEach(function (k) {
      const c = preservedCopies[k];
      say('(e) ' + name + ' | saveAll-omitted-preserved ×' + c.rows.length + ' for house ' + diagVisible_(c.raw) +
        ' name ' + diagVisible_(c.name) + ' (rows ' + c.rows.join(', ') + '; audit copies of rows KEPT on Patients; last ' +
        (c.last || '?') + ')');
    });
    if (unresolved[name] === 0) say('(e) ' + name + ': none.');
  });

  say('(e) PatientsTombstones user-delete rows from the last ' + USER_DELETE_DAYS + ' days (droppedAt since ' +
    new Date(sinceMs).toISOString() + '):');
  let olderDeletes = 0;
  if (!tomb) {
    say('(e) PatientsTombstones: no such tab — no user-delete has ever been recorded.');
  } else {
    tomb.data.rows.forEach(function (r) {
      if (text(cell(tomb, r, 'reason')) !== 'user-delete') return;
      const at = cell(tomb, r, 'droppedAt');
      const ms = diagTimeMs_(at);
      const readable = !isNaN(ms);
      if (readable && ms < sinceMs) { olderDeletes++; return; }
      const raw = cell(tomb, r, 'house');
      const resolved = diagClientHouseId_(raw);
      const id = text(cell(tomb, r, 'id'));
      const nm = String(cell(tomb, r, 'name') == null ? '' : cell(tomb, r, 'name'));
      const stay = stayKey(resolved, nm, cell(tomb, r, 'date'));
      const now = !pat ? 'Patients tab missing'
        : id && (id in patientRowById) ? 'BACK on Patients row ' + patientRowById[id] + ' (same id)'
          : (stay in patientRowByStay) ? 'BACK on Patients row ' + patientRowByStay[stay] + ' (same house + name + entry date)'
            : 'not on Patients';
      const by = text(cell(tomb, r, 'updatedBy'));
      report.recentUserDeletes.push({
        row: r.rowNumber, droppedAt: String(at == null ? '' : at), readable: readable, house: String(raw == null ? '' : raw),
        resolved: resolved, id: id, name: nm, deletedBy: by, now: now,
      });
      say('(e) user-delete PatientsTombstones row ' + r.rowNumber + ' | droppedAt ' + diagVisible_(at) +
        (readable ? ' (' + Math.floor((nowMs - ms) / 86400000) + ' day(s) ago)' : ' (UNREADABLE date — listed so nothing is hidden)') +
        ' | house ' + diagVisible_(raw) + (known.indexOf(resolved) >= 0 ? ' [' + resolved + ']' : ' [NO KNOWN HOUSE]') +
        ' | id ' + diagVisible_(id) + ' | name ' + diagVisible_(nm) + diagNameFlags_(nm) +
        field(tomb, r, 'date', 'entryDate') + field(tomb, r, 'status') + field(tomb, r, 'fromLead') +
        ' | deleted by ' + (by ? diagVisible_(by) : '(not recorded)') + ' at ' + diagVisible_(cell(tomb, r, 'updatedAt')) +
        ' || now: ' + now);
    });
    if (report.recentUserDeletes.length === 0) say('(e) no user-delete in the last ' + USER_DELETE_DAYS + ' days.');
    if (olderDeletes > 0) say('(e) ' + olderDeletes + ' older user-delete row(s) not listed (droppedAt before the window).');
  }

  // ---- (d) summary ----
  const verdicts = report.ramotRows.filter(function (e) { return e.sheet === PATIENTS_SHEET; }).map(function (e) { return e.verdict; });
  const tally = function (re) { return verdicts.filter(function (v) { return re.test(v); }).length; };
  const parts = Object.keys(counts).map(function (name) {
    const by = counts[name].by;
    return name + ': ' + counts[name].rows + ' (' + Object.keys(by).map(function (k) { return k + ' ' + by[k]; }).join(' · ') + ')';
  });
  report.summary = {
    counts: counts,
    dashboardVisible: tally(/^VISIBLE/),
    hiddenReleased: tally(/^HIDDEN — status/),
    hiddenHouse: tally(/^HIDDEN — the app resolves/),
    healPending: tally(/the next load's heal will mark it released/),
    blankHouse: report.blankHouseRows.length,
    corruptedNames: fffdTotal,
    duplicateIds: report.duplicates.filter(function (d) { return d.kind === 'id'; }).length,
    duplicatePhones: report.duplicates.filter(function (d) { return d.kind === 'phone'; }).length,
    headerDrift: report.headers.filter(function (h) { return h.drift.length > 0; }).map(function (h) { return h.sheet; }),
    unresolvedHouse: unresolved,
    recentUserDeletes: report.recentUserDeletes.length,
    olderUserDeletes: olderDeletes,
    userDeleteWindowDays: USER_DELETE_DAYS,
  };
  const s = report.summary;
  const unresolvedParts = Object.keys(unresolved).map(function (name) { return name + ' ' + unresolved[name]; });
  say('(d) SUMMARY ramot — ' + (parts.length ? parts.join(' | ') : 'no ramot rows in any tab') +
    ' || Dashboard ramot tab: shows ' + s.dashboardVisible + ', hides ' + s.hiddenReleased + ' released, ' +
    s.hiddenHouse + ' with an unresolvable house; ' + s.healPending + ' will be released by the next load\'s heal' +
    ' || Patients rows with NO house: ' + s.blankHouse + ' || U+FFFD names: ' + s.corruptedNames +
    ' || duplicate ids: ' + s.duplicateIds + ', duplicate phones: ' + s.duplicatePhones +
    ' || header drift: ' + (s.headerDrift.length ? s.headerDrift.join(', ') : 'none') +
    ' || (e) any house resolving to no known id: ' + (unresolvedParts.length ? unresolvedParts.join(', ') : 'tabs missing') +
    '; user-deletes in the last ' + USER_DELETE_DAYS + ' days: ' + s.recentUserDeletes + '. No writes performed.');
  report.lines = lines;
  return report;
}

/* The tabs section (a) reads, with the positional columns the app reads each
 * one with. `columns: null` = not this app's tab: fields come from its own
 * header row. `stageNotStatus`: the lead-family tabs carry a pipeline stage. */
function diagRamotTargets_() {
  return [
    { sheet: LEADS_SHEET,               columns: LEAD_COLUMNS,               stageNotStatus: true },
    { sheet: 'Clients',                 columns: null,                       stageNotStatus: false },
    { sheet: PATIENTS_SHEET,            columns: PATIENT_COLUMNS,            stageNotStatus: false },
    { sheet: DISCHARGED_PATIENTS_SHEET, columns: DISCHARGED_PATIENT_COLUMNS, stageNotStatus: false },
    { sheet: IRRELEVANT_LEADS_SHEET,    columns: IRRELEVANT_LEAD_COLUMNS,    stageNotStatus: true },
    { sheet: REMOVED_LEADS_SHEET,       columns: REMOVED_LEAD_COLUMNS,       stageNotStatus: true },
    { sheet: PATIENTS_TOMBSTONES_SHEET, columns: PATIENT_TOMBSTONE_COLUMNS,  stageNotStatus: false },
    { sheet: OUTPATIENTS_SHEET,         columns: OUTPATIENT_COLUMNS,         stageNotStatus: false },
  ];
}

/* Rows of `sh` as {rowNumber, obj} (1-based, header = row 1), fully-empty rows
 * skipped — readSheet_'s rule, but with true row numbers. `columns` null → the
 * tab's own header row names the fields. Never reads past the sheet's grid.
 * READ-ONLY. */
function diagReadSheet_(sh, columns) {
  const lastRow = sh.getLastRow();
  const lastCol = sh.getLastColumn();
  const header = (lastRow >= 1 && lastCol >= 1)
    ? sh.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h == null ? '' : h).trim(); })
    : [];
  const cols = columns ? columns.slice() : header.slice();
  const width = Math.min(cols.length, sh.getMaxColumns());
  const rows = [];
  if (lastRow >= 2 && width >= 1) {
    const values = sh.getRange(2, 1, lastRow - 1, width).getValues();
    for (let i = 0; i < values.length; i++) {
      const row = values[i];
      let hasContent = false;
      for (let j = 0; j < row.length; j++) {
        if (row[j] !== '' && row[j] !== null) { hasContent = true; break; }
      }
      if (!hasContent) continue;
      const obj = {};
      for (let j = 0; j < cols.length; j++) obj[cols[j]] = j < row.length ? row[j] : '';
      rows.push({ rowNumber: i + 2, obj: obj });
    }
  }
  return { header: header, columns: cols, rows: rows };
}

/* Positions where a tab's live header differs from the columns the app maps
 * it with (a SHORTER header is normal — getOrCreateSheet_ extends it on the
 * app's next write — and is not drift). */
function diagHeaderDrift_(header, columns) {
  const out = [];
  for (let j = 0; j < columns.length && j < header.length; j++) {
    if (header[j] !== columns[j]) out.push('col ' + (j + 1) + ' expected "' + columns[j] + '" found "' + header[j] + '"');
  }
  return out;
}

/* The column in `columns` holding the logical field `key` — its own name
 * first, then the Hebrew / legacy header aliases the app itself accepts
 * (pickField lists in app.js), compared trimmed and case-folded. '' = none. */
function diagColumnFor_(columns, key) {
  const aliases = {
    id: ['id', 'מזהה'],
    name: ['name', 'patient_name', 'patientName', 'שם', 'שם מטופל', 'שם מלא'],
    phone: ['phone', 'טלפון', 'נייד', 'מספר טלפון'],
    house: ['houseId', 'house', 'house_of_origin', 'house_id', 'location', 'בית', 'סניף'],
    stage: ['stage', 'שלב'],
    status: ['status', 'סטטוס', 'מצב'],
    date: ['date', 'entryDate', 'start_date', 'תאריך כניסה'],
    exitDate: ['exitDate', 'end_date', 'תאריך שחרור'],
  };
  const want = (aliases[key] || [key]).map(function (a) { return diagNormText_(a); });
  for (let w = 0; w < want.length; w++) {
    for (let c = 0; c < columns.length; c++) {
      if (diagNormText_(columns[c]) === want[w]) return columns[c];
    }
  }
  return '';
}

/* A value reduced for MATCHING only: NFC, the invisible bidi / zero-width
 * marks app.js strips from names (NAME_INVISIBLES) removed, NBSP → space,
 * whitespace runs collapsed, trimmed, case-folded. */
function diagNormText_(v) {
  let s = String(v == null ? '' : v);
  try { s = s.normalize('NFC'); } catch (_) { /* runtime without normalize */ }
  return s.replace(/[\u200b-\u200f\u202a-\u202e\u2060\ufeff]/g, '')
    .replace(/[\s\u00a0]+/g, ' ').trim().toLowerCase();
}

/* How a stored house value refers to ramot: 'id' (exactly the id), 'label'
 * (exactly the Hebrew label), 'variant' (either one once padded / cased /
 * invisible-marked / NBSP / hyphenated / shortened forms are reduced),
 * 'corrupted' (U+FFFD where the surviving characters still fit the id or the
 * label), '' = not ramot. Pure. */
function diagRamotHouseMatch_(raw) {
  const s = String(raw == null ? '' : raw);
  if (!s) return '';
  const id = MANAGER_HOUSE_TO_PATIENTS_HOUSE_ID.ramot;
  const label = MANAGER_HOUSE_NAMES.ramot;
  if (s === id) return 'id';
  if (s === label) return 'label';
  const n = diagNormText_(s);
  const labelN = diagNormText_(label);
  if (hasCorruption_(s)) {
    // Attributed to ramot only when at least two characters survived and they
    // fit ramot's id or label and NO other house's (a lone U+FFFD fits all).
    const survivors = n.split(CORRUPTION_MARK).join('').replace(/\s/g, '');
    const re = corruptionWildcardRegex_(n);
    const fits = function (v) { return re.test(diagNormText_(v)); };
    const other = Object.keys(DIGEST_HOUSE_NAME_TO_INTERNAL).some(function (lbl) {
      return DIGEST_HOUSE_NAME_TO_INTERNAL[lbl] !== id && (fits(lbl) || fits(DIGEST_HOUSE_NAME_TO_INTERNAL[lbl]));
    });
    if (survivors.length >= 2 && (fits(id) || fits(labelN)) && !other) return 'corrupted';
  }
  const head = labelN.split(' ')[0];
  const tail = labelN.split(' ').slice(1).join(' ');
  const loose = n.replace(/[-_\u05be\x27\x22\u05f3\u05f4.,]/g, ' ').replace(/\s+/g, ' ').trim();
  if (n === id || n === labelN || loose === labelN || loose === head ||
      loose.indexOf(id) === 0 || loose.indexOf(head + ' ') === 0 ||
      (tail && loose.indexOf(tail) >= 0)) return 'variant';
  return '';
}

/* The house id public/app.js resolveHouseId() gives a stored value — trim, an
 * exact id, an exact Hebrew label, a case-insensitive id, else the trimmed raw
 * string (which then matches no house tab). The ids/labels are the HOUSES
 * list, mirrored here by DIGEST_HOUSE_NAME_TO_INTERNAL. Pure. */
function diagClientHouseId_(raw) {
  if (!raw) return '';
  const s = String(raw).trim();
  const ids = Object.keys(DIGEST_HOUSE_NAME_TO_INTERNAL).map(function (k) { return DIGEST_HOUSE_NAME_TO_INTERNAL[k]; });
  if (ids.indexOf(s) >= 0) return s;
  if (DIGEST_HOUSE_NAME_TO_INTERNAL[s]) return DIGEST_HOUSE_NAME_TO_INTERNAL[s];
  const lower = s.toLowerCase();
  for (let i = 0; i < ids.length; i++) if (ids[i].toLowerCase() === lower) return ids[i];
  return s;
}

/* Every house id a Patients row may resolve to — public/app.js HOUSES,
 * mirrored by DIGEST_HOUSE_NAME_TO_INTERNAL (pinned equal by test). A row whose
 * house resolves to anything else is shown by no house tab. Pure. */
function diagKnownHouseIds_() {
  return Object.keys(DIGEST_HOUSE_NAME_TO_INTERNAL).map(function (k) { return DIGEST_HOUSE_NAME_TO_INTERNAL[k]; });
}

/* For a stored house that resolves to NO known id: the ONE known house it most
 * likely means — its id or Hebrew label once invisible marks / NBSP / padding /
 * case / hyphens are reduced, or (U+FFFD damage, at least two characters
 * surviving) the house whose id or label the surviving characters fit. '' when
 * none or more than one house fits: a hint, never a guess. Pure. */
function diagHouseLookalike_(raw) {
  const s = String(raw == null ? '' : raw);
  const n = diagNormText_(s);
  if (!n) return '';
  const loose = n.replace(/[-_\u05be\x27\x22\u05f3\u05f4.,]/g, ' ').replace(/\s+/g, ' ').trim();
  const damaged = hasCorruption_(s) && n.split(CORRUPTION_MARK).join('').replace(/\s/g, '').length >= 2;
  const re = damaged ? corruptionWildcardRegex_(n) : null;
  const hits = [];
  Object.keys(DIGEST_HOUSE_NAME_TO_INTERNAL).forEach(function (label) {
    const id = DIGEST_HOUSE_NAME_TO_INTERNAL[label];
    const labelN = diagNormText_(label);
    const fits = n === id || n === labelN || loose === id || loose === labelN ||
      (re !== null && (re.test(id) || re.test(labelN)));
    if (fits && hits.indexOf(id) < 0) hits.push(id);
  });
  return hits.length === 1 ? hits[0] : '';
}

/* A timestamp cell as epoch ms: a Date cell, or ISO-8601 text as the app
 * writes droppedAt (new Date().toISOString()). NaN for blank or anything else
 * — the caller lists such a row rather than silently dropping it. Pure. */
function diagTimeMs_(v) {
  if (v === null || v === undefined || v === '') return NaN;
  if (Object.prototype.toString.call(v) === '[object Date]') return v.getTime();
  const s = String(v).trim();
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? new Date(s).getTime() : NaN;
}

/* The status public/app.js normalizeStatus() gives a stored value (its
 * STATUS_ALIASES, pinned equal by test): blank or unknown → 'active'. Pure. */
function diagClientStatus_(raw) {
  const aliases = {
    'active': 'active', 'פעיל': 'active',
    'trial': 'trial', 'תקופת ניסיון': 'trial', 'ניסיון': 'trial',
    'wait': 'wait', 'בהמתנה': 'wait', 'המתנה': 'wait', 'ממתין': 'wait',
    'released': 'released', 'שוחרר': 'released', 'שחרור': 'released',
  };
  if (raw === undefined || raw === null) return 'active';
  const s = String(raw).trim();
  if (!s) return 'active';
  return aliases[s] || aliases[s.toLowerCase()] || 'active';
}

/* The discharge audit row's restored flag as every reader treats it: the
 * string 'TRUE' or a boolean true (Sheets coerces the string). */
function diagIsRestored_(v) {
  return v === true || String(v == null ? '' : v) === 'TRUE';
}

/* A header cell that names a person — the columns section (b) scans. */
function diagIsNameHeader_(h) {
  const n = diagNormText_(h);
  return ['name', 'patientname', 'patient_name', 'manager_name', 'contactname', 'שם', 'שם מטופל', 'שם מלא', 'שם הפונה']
    .indexOf(n) >= 0;
}

/* A phone reduced to comparable digits: normalizePhone_ (non-digits out,
 * 972 → 0), then the leading 0 Sheets drops from a number-typed cell put
 * back. Fewer than 9 digits is not a phone → '' (never a duplicate). */
function diagPhoneKey_(raw) {
  let d = normalizePhone_(raw);
  if (/^[1-9]\d{7,8}$/.test(d)) d = '0' + d;
  return /^0\d{8,9}$/.test(d) ? d : '';
}

/* A raw cell as a quoted, log-safe string that SHOWS what the eye cannot:
 * control / NBSP / invisible bidi and zero-width characters as \uXXXX, and a
 * non-string cell's type (a boolean restored flag vs the 'TRUE' string). */
function diagVisible_(v) {
  if (v === null || v === undefined) return '""';
  if (Object.prototype.toString.call(v) === '[object Date]') {
    return isNaN(v.getTime()) ? '(invalid date)' : v.toISOString() + ' (date cell)';
  }
  const s = String(v).replace(/[\u0000-\u001f\u00a0\u200b-\u200f\u202a-\u202e\u2060\ufeff]/g, function (ch) {
    return '\\u' + ('0000' + ch.charCodeAt(0).toString(16)).slice(-4);
  });
  return '"' + s + '"' + (typeof v === 'string' ? '' : ' (' + typeof v + ')');
}

/* Name anomalies worth a flag in a section (a) line. */
function diagNameFlags_(name) {
  const s = String(name == null ? '' : name);
  const flags = [];
  if (hasCorruption_(s)) flags.push('U+FFFD');
  if (/[\u200b-\u200f\u202a-\u202e\u2060\ufeff]/.test(s)) flags.push('invisible marks');
  if (s !== s.trim()) flags.push('leading/trailing space');
  if (!s.trim()) flags.push('BLANK NAME');
  return flags.length ? ' [' + flags.join(', ') + ']' : '';
}

/* ===== Reconciliation report (READ-ONLY on the spreadsheet — run from the editor) =====
 *
 * reconciliationReportNow() cross-checks Leads, Patients, מטופלים משוחררים,
 * PatientsTombstones, Payments, Credits and BillingOverrides and writes what
 * does not add up into ONE new, private Google Doc
 * ("E-Zone דוח פערים YYYY-MM-DD HH:mm"), right-to-left, whose URL it logs.
 *
 * THE SPREADSHEET IS NEVER WRITTEN. Tabs are opened with getSheetByName only
 * (never getOrCreateSheet_, which can insert a tab, extend a header row and
 * re-format columns), cells are read with getValues, and there is no lock, no
 * AuditLog row and no property. The ONLY write in the whole run is
 * DocumentApp.create + that document's own body; the document is not shared
 * and not moved (it lands in the runner's My Drive root, visible to them
 * alone). test/reconciliation-report.test.js source-scans this function and
 * every Code.gs helper it reaches, and runs it against a spreadsheet whose
 * every mutator throws.
 *
 * THE SAME RULES AS THE APP. Every rule that decides "whose money is this" or
 * "what was owed" lives in public/app.js; the ones this report needs are
 * ported below as pure rec*_ helpers, and the test runs each port and its
 * app.js original on the same fixtures (parity):
 *   - identity: the four payment-match tiers (persisted uid, exact triple,
 *     normalized triple, house + name when exactly one fits — ambiguity is
 *     refused at every tier), the look-alike-name rule and the ranked
 *     reconnect candidates of the שיוך תשלומים screen;
 *   - the stay window (entry <= date <= exit, both ends inclusive; released
 *     with no exit date = no longer in the house);
 *   - the records cutoff: a cycle due before 2026-07-01 is neither expected
 *     nor debt — it is reported in its own column, summed into no gap;
 *   - cycles anchored on the ENTRY day-of-month, clamped in short months,
 *     none before entry, none on/after exit;
 *   - a payment's period: the recorded coverageStart/coverageEnd when usable,
 *     else dueDate .. dueDate + 1 month − 1 day (accountingCoverage_);
 *   - billing overrides replace the amount of an UNPAID cycle for their
 *     month; paid / partial rows are history and keep their amount;
 *   - amounts are stored VAT-inclusive; ex-VAT is per row at 2dp (÷1.18);
 *   - a payment status of 'void' / 'מבוטל' (the duplicate-void marking of
 *     PR #144) is excluded from every paid / owed figure and shown apart.
 *
 * Intentionally PUBLIC (Run dropdown) and NOT reachable over HTTP: handle_'s
 * fixed action allow-list never names it. Returns the report object. */
function reconciliationReportNow() {
  const data = recCollect_();
  const report = recBuildReport_(data.tabs, data.todayISO);
  report.missingTabs = data.missing;
  report.headerDrift = data.drift;
  const title = 'E-Zone דוח פערים ' + data.stamp;
  const out = recWriteDoc_(report, title);
  report.title = title;
  report.url = out.url;
  Logger.log('reconciliationReportNow — READ-ONLY on the spreadsheet (no cell, tab, lock or property written). ' +
    'Report: ' + title + ' — ' + out.url);
  Logger.log('Summary: ' + report.summary.map(function (s) {
    return s.letter + ' ' + s.count + (s.money ? ' (₪' + recMoneyText_(s.money) + ')' : '');
  }).join(' | '));
  return report;
}

/* ---------------- reading (getSheetByName + getValues only) ---------------- */

/* The tabs the report reads, with the positional columns the app reads each
 * one with (readSheet_ maps BY POSITION). */
function recTargets_() {
  return [
    { key: 'leads',       sheet: LEADS_SHEET,               columns: LEAD_COLUMNS },
    { key: 'irrelevant',  sheet: IRRELEVANT_LEADS_SHEET,    columns: IRRELEVANT_LEAD_COLUMNS },
    { key: 'removed',     sheet: REMOVED_LEADS_SHEET,       columns: REMOVED_LEAD_COLUMNS },
    { key: 'patients',    sheet: PATIENTS_SHEET,            columns: PATIENT_COLUMNS },
    { key: 'discharged',  sheet: DISCHARGED_PATIENTS_SHEET, columns: DISCHARGED_PATIENT_COLUMNS },
    { key: 'tombstones',  sheet: PATIENTS_TOMBSTONES_SHEET, columns: PATIENT_TOMBSTONE_COLUMNS },
    { key: 'payments',    sheet: PAYMENTS_SHEET,            columns: PAYMENT_COLUMNS },
    { key: 'credits',     sheet: CREDITS_SHEET,             columns: CREDIT_COLUMNS },
    { key: 'overrides',   sheet: BILLING_OVERRIDES_SHEET,   columns: BILLING_OVERRIDE_COLUMNS },
  ];
}

/* Every target tab as { key: {sheet, header, columns, rows} }; a missing tab
 * is listed, never created. Also today (script timezone) and the title stamp. */
function recCollect_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const tabs = {};
  const missing = [];
  const drift = [];
  recTargets_().forEach(function (t) {
    const sh = ss.getSheetByName(t.sheet);
    if (!sh) { missing.push(t.sheet); tabs[t.key] = { sheet: t.sheet, header: [], columns: t.columns, rows: [] }; return; }
    const d = recReadSheet_(sh, t.columns);
    d.sheet = t.sheet;
    tabs[t.key] = d;
    const dr = diagHeaderDrift_(d.header, t.columns);
    if (dr.length) drift.push({ sheet: t.sheet, drift: dr });
  });
  const now = new Date();
  const two = function (n) { return ('0' + n).slice(-2); };
  return {
    tabs: tabs, missing: missing, drift: drift,
    todayISO: localPartsISO_(now),
    stamp: localPartsISO_(now) + ' ' + two(now.getHours()) + ':' + two(now.getMinutes()),
  };
}

/* Rows of `sh` as {rowNumber, obj}, fully-empty rows skipped. The app's
 * columns name the first positions; any column to their right keeps its own
 * header (a hand-added 'טלפון' or 'אמצעי תשלום' column on Payments is read,
 * not ignored). READ-ONLY. */
function recReadSheet_(sh, columns) {
  const lastRow = sh.getLastRow();
  const lastCol = sh.getLastColumn();
  const header = (lastRow >= 1 && lastCol >= 1)
    ? sh.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h == null ? '' : h).trim(); })
    : [];
  const cols = columns.slice();
  for (let j = cols.length; j < header.length; j++) cols.push(header[j] || ('col' + (j + 1)));
  const width = Math.min(cols.length, sh.getMaxColumns());
  const rows = [];
  if (lastRow >= 2 && width >= 1) {
    const values = sh.getRange(2, 1, lastRow - 1, width).getValues();
    for (let i = 0; i < values.length; i++) {
      const row = values[i];
      let hasContent = false;
      for (let j = 0; j < row.length; j++) {
        if (row[j] !== '' && row[j] !== null) { hasContent = true; break; }
      }
      if (!hasContent) continue;
      const obj = {};
      for (let j = 0; j < cols.length; j++) {
        if (!(cols[j] in obj)) obj[cols[j]] = j < row.length ? row[j] : '';
      }
      rows.push({ rowNumber: i + 2, obj: obj });
    }
  }
  return { header: header, columns: cols, rows: rows };
}

/* ---------------- ports of the app.js rules (pure) ---------------- */

/* The records cutoff — app.js's constant of the same meaning (pinned equal by
 * the parity test). A cycle due before it is not expected and not debt. */
function recRecordsCutoff_() { return '2026-07-01'; }
/* app.js VAT_RATE — amounts are stored VAT-inclusive. */
function recVatRate_() { return 1.18; }
function recRound2_(n) { return Math.round((Number(n) || 0) * 100) / 100; }
/* Ex-VAT at 2dp, per row (app.js revenueExVat). */
function recExVat_(inclVat) { return recRound2_((Number(inclVat) || 0) / recVatRate_()); }
function recText_(v) { return String(v == null ? '' : v).trim(); }
function recNum_(v) { return Number(v) || 0; }

/* app.js normalizeStage: blank / unknown → 'new'. */
function recStage_(raw) {
  const aliases = {
    'new': 'new', 'ליד חדש': 'new', 'חדש': 'new', 'ליד': 'new',
    'visit': 'visit', 'ביקור נקבע': 'visit', 'ביקור': 'visit', 'נקבע ביקור': 'visit',
    'paid': 'paid', 'מקדמה שולמה': 'paid', 'בטיפול פעיל': 'paid', 'מקדמה': 'paid', 'שילם מקדמה': 'paid',
    'entry': 'entry', 'entered': 'entry',
    'כניסה לבית': 'entry', 'נכנס לבית': 'entry', 'נכנס': 'entry', 'כניסה': 'entry',
    'admitted': 'admitted', 'נקלט': 'admitted', 'אושפז': 'admitted',
    'irrelevant': 'irrelevant', 'לא רלוונטי': 'irrelevant', 'לא_רלוונטי': 'irrelevant',
    'waitlist': 'waitlist', 'רשימת המתנה': 'waitlist', 'רשימת_המתנה': 'waitlist',
  };
  if (raw === undefined || raw === null) return 'new';
  const s = String(raw).trim();
  if (!s) return 'new';
  return aliases[s] || aliases[s.toLowerCase()] || aliases[s.replace(/\s+/g, ' ')] || 'new';
}

/* A payment status: 'void' for the duplicate-void marking (PR #144 — kept
 * apart so its money is never counted twice), otherwise paymentStatus_ —
 * app.js normalizePayment's aliases, unknown → 'unpaid'. */
function recPaymentStatus_(raw) {
  const t = recText_(raw);
  if (t.toLowerCase() === 'void' || t === 'מבוטל') return 'void';
  return paymentStatus_(raw);
}

/* app.js normalizeNameForMatch (trim, NFC, invisibles out, whitespace runs
 * collapsed, case folded) — that is exactly diagNormText_. */
function recNameKey_(v) { return diagNormText_(v); }

/* app.js patientKey: resolved house :: trimmed name :: entry date. */
function recPatientKey_(p) {
  return (p.houseId || '') + '::' + recText_(p.name) + '::' + (p.date || '');
}
/* app.js patientMatchKey — the triple reduced for MATCHING. */
function recMatchKey_(houseId, name, date) {
  return diagClientHouseId_(houseId || '') + '::' + recNameKey_(name) + '::' + asISODate_(date);
}
/* app.js patientMatchKeyFromId: '' for anything that is not a triple. */
function recMatchKeyFromId_(patientId) {
  const parts = String(patientId == null ? '' : patientId).split('::');
  if (parts.length !== 3) return '';
  return recMatchKey_(parts[0], parts[1], parts[2]);
}
/* app.js paymentPatientUid: the person's link wins over the server's. */
function recPaymentUid_(pay) {
  if (!pay) return '';
  return String(pay.linkPatientUid || pay.patientUid || '').trim();
}

/* app.js matchPatientForPayment — the four tiers, most durable first, and
 * ambiguity refused at every tier. → { patient, via } or null. */
function recMatchPatient_(pay, patients) {
  if (!pay || !Array.isArray(patients)) return null;
  const uid = recPaymentUid_(pay);
  if (uid) {
    for (let i = 0; i < patients.length; i++) {
      if (patients[i] && recText_(patients[i].id) === uid) return { patient: patients[i], via: 'patientUid' };
    }
    return null;   // a uid that names nobody is a stale decision, not a licence to guess
  }
  const storedId = String(pay.patientId || '');
  if (storedId) {
    const exact = patients.filter(function (p) { return p && recPatientKey_(p) === storedId; });
    if (exact.length === 1) return { patient: exact[0], via: 'triple_exact' };
    if (exact.length > 1) return null;
    const loose = recMatchKeyFromId_(storedId);
    if (loose) {
      const hits = patients.filter(function (p) { return p && recMatchKey_(p.houseId, p.name, p.date) === loose; });
      if (hits.length === 1) return { patient: hits[0], via: 'triple_loose' };
      if (hits.length > 1) return null;
    }
  }
  if (pay.patientName && pay.houseId) {
    const house = diagClientHouseId_(pay.houseId);
    const name = recNameKey_(pay.patientName);
    const hits2 = patients.filter(function (p) {
      return p && diagClientHouseId_(p.houseId) === house && recNameKey_(p.name) === name;
    });
    if (hits2.length === 1) return { patient: hits2[0], via: 'house_name' };
  }
  return null;
}

/* app.js namesLookAlike — identical, a prefix, or a shared whole word. */
function recNamesLookAlike_(a, b) {
  const x = recNameKey_(a), y = recNameKey_(b);
  if (!x || !y) return false;
  if (x === y) return true;
  if (x.indexOf(y) === 0 || y.indexOf(x) === 0) return true;
  const xw = x.split(' ').filter(Boolean), yw = y.split(' ').filter(Boolean);
  return xw.some(function (w) { return w.length > 1 && yw.indexOf(w) !== -1; });
}

/* 'YYYY-MM-DD' → local-midnight Date, or null. */
function recDate_(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}
/* Whole days from a to b (ISO), or NaN. */
function recDaysBetween_(aISO, bISO) {
  const a = recDate_(asISODate_(aISO)), b = recDate_(asISODate_(bISO));
  if (!a || !b) return NaN;
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}

/* app.js: the day a stay ended ('' while still in the house). */
function recExitISO_(p) {
  return asISODate_((p && (p.exitDate || p.dischargedAt)) || '');
}
/* app.js: released stops billing. */
function recIsBillable_(p) { return !!p && p.status !== 'released'; }
/* app.js stay window: entry <= date AND (no exit OR exit >= date); released
 * with no exit date recorded → no longer in the house. */
function recStayCovers_(p, dateISO) {
  const date = asISODate_(dateISO);
  if (!p || !date) return false;
  const entry = asISODate_(p.date);
  if (!entry || entry > date) return false;
  const exit = recExitISO_(p);
  if (exit) return exit >= date;
  return recIsBillable_(p);
}
/* app.js: is this cycle before the records cutoff? */
function recBeforeCutoff_(dueISO, from) {
  const line = asISODate_(from) || recRecordsCutoff_();
  const d = asISODate_(dueISO);
  return !!d && d < line;
}

/* app.js reconnectCandidates — ranked, each with its reasons. A candidate
 * needs a name, entry-date or uid signal: house alone is never offered. */
function recCandidates_(pay, patients) {
  if (!pay || !Array.isArray(patients)) return [];
  const payHouse = diagClientHouseId_(pay.houseId || '');
  const uid = recPaymentUid_(pay);
  const dueISO = asISODate_(pay.dueDate);
  const out = [];
  patients.forEach(function (p) {
    if (!p) return;
    const reasons = [];
    let score = 0;
    if (uid && recText_(p.id) === uid) { reasons.push('uid'); score += 100; }
    if (payHouse && diagClientHouseId_(p.houseId) === payHouse) { reasons.push('same_house'); score += 10; }
    if (recNamesLookAlike_(pay.patientName, p.name)) { reasons.push('name'); score += 40; }
    const gap = Math.abs(recDaysBetween_(dueISO, p.date));
    if (isFinite(gap) && gap <= 1) { reasons.push('entry_date'); score += 30; }
    if (recStayCovers_(p, dueISO)) { reasons.push('in_house'); score += 5; }
    if (!reasons.some(function (r) { return r === 'name' || r === 'entry_date' || r === 'uid'; })) return;
    out.push({ patient: p, score: score, reasons: reasons });
  });
  return out.sort(function (a, b) {
    return (b.score - a.score) || String(a.patient.name || '').localeCompare(String(b.patient.name || ''), 'he');
  });
}

/* app.js billingOverrideFor / applyBillingOverride: an override replaces the
 * amount of an UNPAID row for its due-date month; paid / partial (and void)
 * rows are history and are returned untouched. */
function recOverrideFor_(overrides, patientId, month) {
  if (!Array.isArray(overrides)) return null;
  for (let i = 0; i < overrides.length; i++) {
    const o = overrides[i];
    if (o && o.patientId === patientId && o.month === month) return o;
  }
  return null;
}
function recApplyOverride_(payment, overrides) {
  if (!payment || payment.status === 'paid' || payment.status === 'partial' || payment.status === 'void') return payment;
  const ovr = recOverrideFor_(overrides, payment.patientId, String(asISODate_(payment.dueDate)).slice(0, 7));
  if (!ovr) return payment;
  const amount = Number(ovr.amount) || 0;
  const copy = {};
  Object.keys(payment).forEach(function (k) { copy[k] = payment[k]; });
  copy.amount = amount;
  copy.balance = Math.max(0, amount - (payment.amountPaid || 0));
  return copy;
}

/* app.js revenueOccurrenceIn — the anchor day clamped to the month's length. */
function recOccurrence_(year, monthIdx, anchorDay) {
  const first = new Date(year, monthIdx, 1);
  const y = first.getFullYear(), m = first.getMonth();
  const last = new Date(y, m + 1, 0).getDate();
  return new Date(y, m, Math.min(anchorDay, last));
}

/* Every cycle due date of a stay up to today: anchored on the entry
 * day-of-month (clamped), none before entry, none on/after exit (app.js
 * projectedCycleDueDates' bounds), none after today. */
function recCycleDueDates_(p, todayISO) {
  const anchorISO = asISODate_(p && p.date);
  const anchor = recDate_(anchorISO);
  const today = asISODate_(todayISO);
  if (!anchor || !today) return [];
  const exit = recExitISO_(p);
  const out = [];
  let y = anchor.getFullYear(), m = anchor.getMonth();
  let guard = 0;
  while (guard++ < 600) {
    const occISO = localPartsISO_(recOccurrence_(y, m, anchor.getDate()));
    if (occISO > today) break;
    if (occISO >= anchorISO && !(exit && occISO >= exit)) out.push(occISO);
    m++; if (m > 11) { m = 0; y++; }
  }
  return out;
}

/* ---------------- normalizing the tabs ---------------- */

function recLead_(r, sheet) {
  const o = r.obj;
  return {
    sheet: sheet, row: r.rowNumber, id: recText_(o.id), name: recText_(o.name),
    phone: recText_(o.phone), phoneKey: diagPhoneKey_(o.phone),
    house: recText_(o.house), houseId: diagClientHouseId_(o.house),
    stage: recStage_(o.stage), rawStage: recText_(o.stage),
    meetingOutcome: recText_(o.meetingOutcome),
    created: asISODate_(o.created), visitDate: asISODate_(o.visitDate), entryDate: asISODate_(o.entryDate),
    advance: recNum_(o.advance),
  };
}
function recPatient_(r, sheet) {
  const o = r.obj;
  return {
    sheet: sheet, row: r.rowNumber, id: recText_(o.id), houseId: diagClientHouseId_(o.houseId),
    rawName: o.name, name: recText_(o.name), date: asISODate_(o.date), pay: recNum_(o.pay),
    status: diagClientStatus_(o.status), fromLead: recText_(o.fromLead),
    exitDate: asISODate_(o.exitDate), dischargedAt: o.dischargedAt ? asISODate_(o.dischargedAt) : '',
    restored: o.restored, reason: recText_(o.reason), droppedAt: recText_(o.droppedAt),
  };
}
/* app.js normalizePayment's fields, plus row number and any hand-added
 * phone / method column. A blank patientId is healed from the 5-part id. */
function recPayment_(r) {
  const o = r.obj;
  const id = String(o.id == null ? '' : o.id);
  let patientId = String(o.patientId == null ? '' : o.patientId);
  if (!patientId) {
    const parts = id.split('::');
    if (parts.length === 5 && parts[0] === 'pay') patientId = parts.slice(1, 4).join('::');
  }
  const extra = function (names) {
    const want = names.map(function (n) { return diagNormText_(n); });
    const keys = Object.keys(o);
    for (let i = 0; i < keys.length; i++) {
      if (PAYMENT_COLUMNS.indexOf(keys[i]) < 0 && want.indexOf(diagNormText_(keys[i])) >= 0) return recText_(o[keys[i]]);
    }
    return '';
  };
  return {
    row: r.rowNumber, id: id, patientId: patientId, patientName: String(o.patientName == null ? '' : o.patientName),
    houseId: diagClientHouseId_(o.houseId), dueDate: asISODate_(o.dueDate),
    amount: recNum_(o.amount), status: recPaymentStatus_(o.status), rawStatus: recText_(o.status),
    amountPaid: recNum_(o.amountPaid),
    coverageStart: o.coverageStart, coverageEnd: o.coverageEnd,
    patientUid: recText_(o.patientUid), linkPatientUid: recText_(o.linkPatientUid),
    linkStatus: recText_(o.linkStatus), linkNote: recText_(o.linkNote),
    phone: extra(['phone', 'טלפון', 'נייד', 'מספר טלפון']),
    method: extra(['method', 'אמצעי תשלום', 'אמצעי', 'paymentMethod']),
  };
}
function recCredit_(r) {
  const o = r.obj;
  const status = recText_(o.status);
  return {
    row: r.rowNumber, id: recText_(o.id), patientId: recText_(o.patientId), patientKey: recText_(o.patientKey),
    patientName: recText_(o.patientName), houseId: diagClientHouseId_(o.houseId),
    amount: recNum_(o.amount), creditType: recText_(o.creditType),
    status: CREDIT_STATUSES.indexOf(status) >= 0 ? status : 'pending',
    allocationMonth: String(o.allocationMonth == null ? '' : o.allocationMonth).slice(0, 7),
  };
}
function recOverride_(r) {
  const o = r.obj;
  return { patientId: String(o.patientId == null ? '' : o.patientId), month: String(o.month == null ? '' : o.month).slice(0, 7), amount: recNum_(o.amount) };
}

/* The whole data set, normalized. Pure over the read tabs. */
function recModel_(tabs, todayISO) {
  // Receipt rows (Phase 3 PR 2) are not cycles: every check below sees the
  // cycles, with their money derived from their receipts. Idempotent.
  tabs = paymentTabsDerived_(tabs);
  const rows = function (k) { return (tabs[k] && tabs[k].rows) || []; };
  const name = function (k) { return (tabs[k] && tabs[k].sheet) || k; };
  const leads = rows('leads').map(function (r) { return recLead_(r, name('leads')); });
  const closedLeads = rows('irrelevant').map(function (r) { return recLead_(r, name('irrelevant')); })
    .concat(rows('removed').map(function (r) { return recLead_(r, name('removed')); }));
  const allLeads = leads.concat(closedLeads);
  const leadById = {};
  allLeads.forEach(function (l) { if (l.id && !(l.id in leadById)) leadById[l.id] = l; });
  const patients = rows('patients').map(function (r) { return recPatient_(r, name('patients')); });
  const payments = rows('payments').map(function (r) { return recPayment_(r); });
  const m = {
    todayISO: asISODate_(todayISO), leads: leads, closedLeads: closedLeads, allLeads: allLeads, leadById: leadById,
    patients: patients,
    active: patients.filter(function (p) { return recIsBillable_(p); }),
    // A soft-deleted duplicate (deletedAt) is not a discharge record.
    audits: rows('discharged').filter(function (r) { return !dischargeRowDeleted_(r.obj); })
      .map(function (r) { return recPatient_(r, name('discharged')); }),
    tombs: rows('tombstones').map(function (r) { return recPatient_(r, name('tombstones')); }),
    payments: payments,
    credits: rows('credits').map(function (r) { return recCredit_(r); }),
    overrides: rows('overrides').map(function (r) { return recOverride_(r); }).filter(function (o) { return o.patientId && o.month; }),
  };
  // Each payment's owner, by the app's own four tiers over ALL patients.
  m.payOwner = payments.map(function (p) { return recMatchPatient_(p, patients); });
  return m;
}

/* A patient's phone: Patients rows carry none, so it is the phone of the lead
 * they came from (getAdmittedRoster_'s fromLead join). */
function recPatientPhoneKey_(p, m) {
  const l = p && p.fromLead ? m.leadById[p.fromLead] : null;
  return l ? l.phoneKey : '';
}
function recRef_(sheet, row) { return sheet + ' שורה ' + row; }
function recPayMoney_(p) { return p.amountPaid > 0 ? p.amountPaid : p.amount; }
function recByMoney_(a, b) { return (b.money || 0) - (a.money || 0); }

/* The Patients rows a lead already has — by fromLead, then by phone, then by
 * name + house. → { patient, via } or null. */
function recLeadPatient_(lead, m) {
  const byLead = m.patients.filter(function (p) { return lead.id && p.fromLead === lead.id; });
  if (byLead.length) return { patient: byLead[0], via: 'fromLead' };
  if (lead.phoneKey) {
    const byPhone = m.patients.filter(function (p) { return recPatientPhoneKey_(p, m) === lead.phoneKey; });
    if (byPhone.length) return { patient: byPhone[0], via: 'phone' };
  }
  const nk = recNameKey_(lead.name);
  if (nk && lead.houseId) {
    const byName = m.patients.filter(function (p) { return recNameKey_(p.name) === nk && p.houseId === lead.houseId; });
    if (byName.length) return { patient: byName[0], via: 'name_house' };
  }
  return null;
}

/* ---------------- sections ---------------- */

/* A. Leads that paid / were admitted / are entering treatment, with no
 * Patients row. */
function recSectionA_(m) {
  const out = [];
  m.leads.forEach(function (l) {
    const outcome = l.meetingOutcome;
    const entering = outcome === 'entered' || outcome === 'נכנסים לטיפול';
    if (!(l.stage === 'paid' || l.stage === 'admitted' || entering)) return;
    if (recLeadPatient_(l, m)) return;
    const notes = [];
    m.audits.forEach(function (a) {
      if ((l.id && a.fromLead === l.id) || (recNameKey_(a.name) === recNameKey_(l.name) && a.houseId === l.houseId)) {
        notes.push('קיים ב' + recRef_(a.sheet, a.row));
      }
    });
    m.tombs.forEach(function (t) {
      if ((l.id && t.fromLead === l.id) || (recNameKey_(t.name) === recNameKey_(l.name) && t.houseId === l.houseId)) {
        notes.push('נמחק — ' + recRef_(t.sheet, t.row) + (t.reason ? ' (' + t.reason + ')' : ''));
      }
    });
    out.push({ ref: recRef_(l.sheet, l.row), lead: l, why: entering && l.stage !== 'paid' && l.stage !== 'admitted' ? 'נכנסים לטיפול' : l.stage,
      notes: notes, money: l.advance });
  });
  return out.sort(function (a, b) { return recByMoney_(a, b) || String(b.lead.created).localeCompare(String(a.lead.created)); });
}

/* B. Active patients that appear more than once. */
function recSectionB_(m) {
  const groups = {};
  const add = function (kind, key, p) {
    if (!key) return;
    const k = kind + '|' + key;
    if (!groups[k]) groups[k] = { kind: kind, key: key, rows: [] };
    groups[k].rows.push(p);
  };
  m.active.forEach(function (p) {
    add('key', recMatchKey_(p.houseId, p.name, p.date), p);
    add('fromLead', p.fromLead, p);
    add('phone', recPatientPhoneKey_(p, m), p);
  });
  return Object.keys(groups).map(function (k) { return groups[k]; })
    .filter(function (g) { return g.rows.length > 1; })
    .map(function (g) {
      return { kind: g.kind, key: g.key, rows: g.rows, refs: g.rows.map(function (p) { return recRef_(p.sheet, p.row); }),
        money: g.rows.reduce(function (s, p) { return s + p.pay; }, 0) - Math.max.apply(null, g.rows.map(function (p) { return p.pay; })) };
    })
    .sort(function (a, b) { return recByMoney_(a, b); });
}

/* C. Open discharge audit rows whose stay is still an ACTIVE patient. */
function recSectionC_(m) {
  const out = [];
  m.audits.forEach(function (a) {
    if (diagIsRestored_(a.restored)) return;
    const key = recMatchKey_(a.houseId, a.name, a.date);
    m.active.forEach(function (p) {
      let via = '';
      if (a.fromLead && p.fromLead === a.fromLead) via = 'fromLead';
      else if (recMatchKey_(p.houseId, p.name, p.date) === key) via = 'house_name_date';
      else if (a.id && p.id && a.id === p.id) via = 'id';
      if (via) out.push({ audit: a, patient: p, via: via, money: p.pay });
    });
  });
  return out.sort(function (a, b) { return recByMoney_(a, b); });
}

/* D. Names holding U+FFFD, with a proposed clean name from the same id /
 * fromLead / phone elsewhere, and a confidence level. */
function recSectionD_(m) {
  const clean = function (n) { return n && !hasCorruption_(n); };
  const namesById = {};
  m.patients.concat(m.tombs).forEach(function (p) { if (p.id && clean(p.name)) (namesById[p.id] = namesById[p.id] || []).push(p.name); });
  const leadNamesById = {};
  m.allLeads.forEach(function (l) { if (l.id && clean(l.name)) (leadNamesById[l.id] = leadNamesById[l.id] || []).push(l.name); });
  const patientNamesByLead = {};
  m.patients.concat(m.audits, m.tombs).forEach(function (p) { if (p.fromLead && clean(p.name)) (patientNamesByLead[p.fromLead] = patientNamesByLead[p.fromLead] || []).push(p.name); });
  const leadNamesByPhone = {};
  m.allLeads.forEach(function (l) { if (l.phoneKey && clean(l.name)) (leadNamesByPhone[l.phoneKey] = leadNamesByPhone[l.phoneKey] || []).push(l.name); });

  const items = [];
  const consider = function (sheet, row, name, house, cands) {
    if (!hasCorruption_(name)) return;
    const re = corruptionWildcardRegex_(recText_(name));
    const seen = {};
    const list = [];
    cands.forEach(function (c) {
      (c.names || []).forEach(function (n) {
        const k = c.via + '|' + n;
        if (seen[k]) return;
        seen[k] = true;
        list.push({ name: n, via: c.via, fits: re.test(n) });
      });
    });
    const fitting = list.filter(function (c) { return c.fits; });
    const distinct = fitting.map(function (c) { return c.name; }).filter(function (n, i, a) { return a.indexOf(n) === i; });
    let proposal = '', via = '', confidence = 'אין הצעה';
    if (distinct.length === 1) {
      proposal = distinct[0];
      const strong = fitting.some(function (c) { return c.name === proposal && (c.via === 'id' || c.via === 'fromLead'); });
      via = fitting.filter(function (c) { return c.name === proposal; }).map(function (c) { return c.via; }).join('+');
      confidence = strong ? 'גבוהה' : 'בינונית';
    } else if (distinct.length > 1) {
      proposal = distinct.join(' / '); via = 'כמה מועמדים'; confidence = 'נמוכה';
    } else if (list.length) {
      proposal = list[0].name; via = list[0].via + ' (לא תואם לתבנית)'; confidence = 'נמוכה';
    } else {
      // Nothing linked: a unique clean name in the same house that fits the pattern.
      const pool = m.patients.concat(m.allLeads).filter(function (p) {
        return clean(p.name) && (!house || (p.houseId || '') === house);
      }).map(function (p) { return p.name; }).filter(function (n, i, a) { return a.indexOf(n) === i; });
      const one = corruptionMatchOne_(recText_(name), pool);
      if (one.value) { proposal = one.value; via = 'תבנית בלבד'; confidence = 'נמוכה'; }
    }
    items.push({ ref: recRef_(sheet, row), sheet: sheet, row: row, name: String(name), proposal: proposal, via: via, confidence: confidence });
  };
  m.patients.concat(m.audits, m.tombs).forEach(function (p) {
    const phone = recPatientPhoneKey_(p, m);
    consider(p.sheet, p.row, p.name, p.houseId, [
      // A discharge audit row's id is the AUDIT's own key, not a patient id.
      { via: 'id', names: m.audits.indexOf(p) >= 0 ? [] : namesById[p.id] },
      { via: 'fromLead', names: (leadNamesById[p.fromLead] || []).concat(patientNamesByLead[p.fromLead] || []) },
      { via: 'phone', names: phone ? leadNamesByPhone[phone] : [] },
    ]);
  });
  m.allLeads.forEach(function (l) {
    consider(l.sheet, l.row, l.name, l.houseId, [
      { via: 'id', names: leadNamesById[l.id] },
      { via: 'fromLead', names: patientNamesByLead[l.id] },
      { via: 'phone', names: l.phoneKey ? leadNamesByPhone[l.phoneKey] : [] },
    ]);
  });
  m.payments.forEach(function (p, i) {
    const owner = m.payOwner[i];
    const uid = recPaymentUid_(p);
    consider(PAYMENTS_SHEET, p.row, p.patientName, p.houseId, [
      { via: 'id', names: (uid ? namesById[uid] : []) || [] },
      { via: 'id', names: owner && clean(owner.patient.name) ? [owner.patient.name] : [] },
    ]);
  });
  m.credits.forEach(function (c) {
    consider(CREDITS_SHEET, c.row, c.patientName, c.houseId, [
      { via: 'id', names: namesById[c.patientId] || [] },
    ]);
  });
  const rank = { 'גבוהה': 0, 'בינונית': 1, 'נמוכה': 2, 'אין הצעה': 3 };
  return items.sort(function (a, b) { return (rank[a.confidence] - rank[b.confidence]) || a.ref.localeCompare(b.ref); });
}

/* Hebrew labels for the app's match reasons. */
function recReasonText_(reasons) {
  const he = { uid: 'מזהה', same_house: 'אותו בית', name: 'שם דומה', entry_date: 'תאריך כניסה ±יום', in_house: 'בתוך תקופת השהייה' };
  return reasons.map(function (r) { return he[r] || r; }).join(', ');
}

/* The leads a detached payment may belong to: phone (when Payments has a
 * phone column), then an identical or look-alike name — look-alike only in
 * the same house. Leads that already have a Patients row are skipped. */
function recLeadCandidates_(pay, m) {
  const phoneKey = diagPhoneKey_(pay.phone);
  const nk = recNameKey_(pay.patientName);
  const out = [];
  m.allLeads.forEach(function (l) {
    const reasons = [];
    if (phoneKey && l.phoneKey === phoneKey) reasons.push('טלפון');
    if (nk && recNameKey_(l.name) === nk) reasons.push('שם זהה');
    else if (recNamesLookAlike_(pay.patientName, l.name) && pay.houseId && l.houseId === pay.houseId) reasons.push('שם דומה + אותו בית');
    if (!reasons.length) return;
    out.push({ lead: l, reasons: reasons, score: (reasons.indexOf('טלפון') >= 0 ? 100 : 0) + (reasons.indexOf('שם זהה') >= 0 ? 40 : 20) });
  });
  return out.sort(function (a, b) { return b.score - a.score; });
}

/* E. Payments attached to no existing Patients row. */
function recSectionE_(m) {
  const out = [];
  m.payments.forEach(function (p, i) {
    if (p.status === 'void' || m.payOwner[i]) return;
    const uid = recPaymentUid_(p);
    const tombNotes = [];
    const loose = recMatchKeyFromId_(p.patientId);
    m.tombs.forEach(function (t) {
      if ((uid && t.id === uid) || (loose && recMatchKey_(t.houseId, t.name, t.date) === loose)) {
        tombNotes.push('מצביע על מטופל שנמחק — ' + recRef_(t.sheet, t.row) + (t.reason ? ' (' + t.reason + ')' : ''));
      }
    });
    if (uid && !tombNotes.length) tombNotes.push('מזהה ' + uid + ' לא קיים ב-Patients');
    const cands = recCandidates_(p, m.patients);
    let best = '', reason = '';
    if (cands.length) {
      best = cands[0].patient.name + ' — ' + recRef_(cands[0].patient.sheet, cands[0].patient.row);
      reason = recReasonText_(cands[0].reasons) + (cands.length > 1 ? ' (+' + (cands.length - 1) + ' מועמדים)' : '');
    } else {
      const lc = recLeadCandidates_(p, m);
      if (lc.length) {
        best = 'ליד: ' + lc[0].lead.name + ' — ' + recRef_(lc[0].lead.sheet, lc[0].lead.row);
        reason = lc[0].reasons.join(', ');
      }
    }
    let phone = p.phone;
    if (!phone && cands.length) {
      const k = recPatientPhoneKey_(cands[0].patient, m);
      if (k) phone = k + ' (מהליד)';
    }
    if (p.linkStatus === 'not_a_patient') tombNotes.push('סומן "לא מטופל"' + (p.linkNote ? ': ' + p.linkNote : ''));
    out.push({ ref: recRef_(PAYMENTS_SHEET, p.row), payment: p, phone: phone, best: best, reason: reason,
      notes: tombNotes, money: recPayMoney_(p) });
  });
  return out.sort(function (a, b) { return recByMoney_(a, b); });
}

/* F. Detached payments that match a LEAD with no patient record — paid but
 * not admitted. */
function recSectionF_(m, e) {
  const out = [];
  e.forEach(function (item) {
    recLeadCandidates_(item.payment, m).forEach(function (c) {
      if (recLeadPatient_(c.lead, m)) return;
      out.push({ ref: item.ref, payment: item.payment, lead: c.lead, reason: c.reasons.join(', '), money: item.money });
    });
  });
  return out.sort(function (a, b) { return recByMoney_(a, b); });
}

/* H. Per active patient: the stay's cycles against what was paid. */
function recSectionH_(m) {
  const cutoff = recRecordsCutoff_();
  return m.active.map(function (p) {
    const key = recPatientKey_(p);
    const own = [];
    m.payments.forEach(function (pay, i) {
      if (pay.status !== 'void' && m.payOwner[i] && m.payOwner[i].patient === p) own.push(pay);
    });
    const totalPaid = recRound2_(own.reduce(function (s, x) { return s + x.amountPaid; }, 0));
    const cycles = recCycleDueDates_(p, m.todayISO);
    let before = 0, covered = 0, partial = 0, missing = 0, expected = 0, gap = 0;
    const gaps = [];
    cycles.forEach(function (due) {
      if (recBeforeCutoff_(due, cutoff)) { before++; return; }
      const rows = own.filter(function (x) { return String(x.dueDate).slice(0, 7) === due.slice(0, 7); });
      const byWindow = own.some(function (x) {
        const w = accountingCoverage_(x);
        return w && w.source === 'recorded' && x.amountPaid > 0 && localPartsISO_(w.start) <= due && localPartsISO_(w.end) >= due;
      });
      let billed, paid;
      if (rows.length) {
        billed = Math.max.apply(null, rows.map(function (x) { return recApplyOverride_(x, m.overrides).amount; }));
        paid = rows.reduce(function (s, x) { return s + x.amountPaid; }, 0);
      } else {
        const ovr = recOverrideFor_(m.overrides, key, due.slice(0, 7));
        billed = ovr ? ovr.amount : p.pay;
        paid = 0;
      }
      if (!rows.length && byWindow) { covered++; expected += billed; return; }
      expected += billed;
      const short = recRound2_(Math.max(0, billed - paid));
      if (short <= 0) covered++;
      else if (paid > 0) { partial++; gap += short; gaps.push(due + ' (חלקי ₪' + recMoneyText_(short) + ')'); }
      else { missing++; gap += short; gaps.push(due); }
    });
    gap = recRound2_(gap);
    return {
      ref: recRef_(p.sheet, p.row), patient: p, entry: p.date, end: recExitISO_(p) || m.todayISO,
      stayMonths: cycles.length, beforeCutoff: before, covered: covered, partial: partial, missing: missing,
      monthly: p.pay, monthlyExVat: recExVat_(p.pay), expected: recRound2_(expected), totalPaid: totalPaid,
      gapMonths: partial + missing, gap: gap, gapExVat: recExVat_(gap), gapDues: gaps, payments: own.length, money: gap,
    };
  }).sort(function (a, b) { return recByMoney_(a, b) || b.monthly - a.monthly; });
}

/* G. Active patients with no payment at all (from H's own figures). */
function recSectionG_(h) {
  return h.filter(function (x) { return x.payments === 0; })
    .map(function (x) { return { ref: x.ref, h: x, money: x.gap || x.monthly }; })
    .sort(function (a, b) { return recByMoney_(a, b); });
}

/* I. Suspected duplicate payments: the same owner and amount, due dates
 * within 7 days. Voided rows are listed apart with the twin they void. */
function recSectionI_(m) {
  const owners = {};
  const ownerKey = function (p, i) {
    const o = m.payOwner[i];
    return o ? 'p:' + o.patient.sheet + ':' + o.patient.row : 'd:' + p.houseId + '::' + recNameKey_(p.patientName);
  };
  m.payments.forEach(function (p, i) {
    if (p.status === 'void') return;
    const k = ownerKey(p, i);
    (owners[k] = owners[k] || []).push({ p: p, i: i });
  });
  const pairs = [];
  Object.keys(owners).forEach(function (k) {
    const list = owners[k];
    for (let a = 0; a < list.length; a++) {
      for (let b = a + 1; b < list.length; b++) {
        const x = list[a].p, y = list[b].p;
        if (!(x.amount > 0) || x.amount !== y.amount) continue;
        const d = Math.abs(recDaysBetween_(x.dueDate, y.dueDate));
        if (!isFinite(d) || d > 7) continue;
        const o = m.payOwner[list[a].i];
        pairs.push({ a: x, b: y, days: d, owner: o ? o.patient.name + ' — ' + recRef_(o.patient.sheet, o.patient.row) : 'לא משויך: ' + x.patientName,
          money: x.amount });
      }
    }
  });
  const voided = m.payments.filter(function (p) { return p.status === 'void'; }).map(function (v) {
    const twin = m.payments.filter(function (p, i) {
      if (p === v || p.status === 'void' || p.amount !== v.amount) return false;
      const d = Math.abs(recDaysBetween_(p.dueDate, v.dueDate));
      return isFinite(d) && d <= 7 && (diagClientHouseId_(p.houseId) === diagClientHouseId_(v.houseId));
    });
    return { payment: v, twins: twin, money: v.amount };
  }).sort(function (a, b) { return recByMoney_(a, b); });
  return { pairs: pairs.sort(function (a, b) { return recByMoney_(a, b); }), voided: voided };
}

/* The Patients row a credit belongs to: its patientId, else its stored
 * patientKey (exact), else ONE row by the loose triple. → the patient or null.
 * Section J's own lookup, shared with the cleanup workbook. */
function recCreditPatient_(c, m) {
  for (let i = 0; i < m.patients.length; i++) {
    const q = m.patients[i];
    if ((c.patientId && q.id === c.patientId) || (c.patientKey && recPatientKey_(q) === c.patientKey)) return q;
  }
  const loose = recMatchKeyFromId_(c.patientKey) || recMatchKeyFromId_(c.patientId);
  const hits = loose ? m.patients.filter(function (q) { return recMatchKey_(q.houseId, q.name, q.date) === loose; }) : [];
  return hits.length === 1 ? hits[0] : null;
}

/* J. Credits not attached to a patient, or larger than that patient's total
 * payments. Cancelled credits count for nothing (the app's rule). */
function recSectionJ_(m) {
  const out = [];
  const byPatient = {};
  m.credits.forEach(function (c) {
    if (c.status === 'cancelled') return;
    const p = recCreditPatient_(c, m);
    if (!p) { out.push({ kind: 'unattached', credits: [c], refs: [recRef_(CREDITS_SHEET, c.row)], name: c.patientName, money: c.amount }); return; }
    const k = p.sheet + ':' + p.row;
    if (!byPatient[k]) byPatient[k] = { patient: p, credits: [] };
    byPatient[k].credits.push(c);
  });
  Object.keys(byPatient).forEach(function (k) {
    const g = byPatient[k];
    const credited = recRound2_(g.credits.reduce(function (s, c) { return s + c.amount; }, 0));
    let paid = 0;
    m.payments.forEach(function (pay, i) {
      if (pay.status !== 'void' && m.payOwner[i] && m.payOwner[i].patient === g.patient) paid += pay.amountPaid;
    });
    paid = recRound2_(paid);
    if (credited > paid) {
      out.push({ kind: 'exceeds', credits: g.credits, refs: g.credits.map(function (c) { return recRef_(CREDITS_SHEET, c.row); }),
        patient: g.patient, name: g.patient.name, credited: credited, paid: paid, money: recRound2_(credited - paid) });
    }
  });
  return out.sort(function (a, b) { return recByMoney_(a, b); });
}

/* K. Payments dated after the patient's exit, and payment amounts more than
 * 5% away from the patient's monthly pay (override-aware; both sides are
 * VAT-inclusive — an amount that equals the pay ÷1.18 is called out). */
function recSectionK_(m) {
  const after = [], off = [];
  m.payments.forEach(function (p, i) {
    const o = m.payOwner[i];
    if (!o || p.status === 'void') return;
    const pt = o.patient;
    const exit = recExitISO_(pt);
    if (exit && p.dueDate && p.dueDate > exit) {
      after.push({ ref: recRef_(PAYMENTS_SHEET, p.row), payment: p, patient: pt, exit: exit, money: recPayMoney_(p) });
    }
    if (!(p.amount > 0)) return;
    const ovr = recOverrideFor_(m.overrides, recPatientKey_(pt), String(p.dueDate).slice(0, 7));
    const expected = ovr ? ovr.amount : pt.pay;
    let note = '';
    if (!(expected > 0)) note = 'אין תעריף חודשי למטופל';
    else {
      const ratio = Math.abs(p.amount - expected) / expected;
      if (ratio <= 0.05) return;
      if (Math.abs(p.amount - expected / recVatRate_()) <= expected * 0.01) note = 'נראה כסכום ללא מע״מ';
      else if (Math.abs(p.amount - expected * recVatRate_()) <= expected * 0.01) note = 'נראה כתעריף ללא מע״מ בכרטיס המטופל';
      else note = Math.round(ratio * 100) + '% הפרש';
      if (ovr) note += ' (מול חריגת חיוב לחודש)';
    }
    off.push({ ref: recRef_(PAYMENTS_SHEET, p.row), payment: p, patient: pt, expected: expected, note: note,
      money: recRound2_(Math.abs(p.amount - (expected || 0))) });
  });
  return { after: after.sort(function (a, b) { return recByMoney_(a, b); }), off: off.sort(function (a, b) { return recByMoney_(a, b); }) };
}

/* The whole report — pure over the read tabs. */
function recBuildReport_(tabs, todayISO) {
  const m = recModel_(tabs, todayISO);
  const s = {};
  s.A = recSectionA_(m);
  s.B = recSectionB_(m);
  s.C = recSectionC_(m);
  s.D = recSectionD_(m);
  s.E = recSectionE_(m);
  s.F = recSectionF_(m, s.E);
  s.H = recSectionH_(m);
  s.G = recSectionG_(s.H);
  s.I = recSectionI_(m);
  s.J = recSectionJ_(m);
  s.K = recSectionK_(m);
  const sum = function (list) { return recRound2_(list.reduce(function (t, x) { return t + (x.money || 0); }, 0)); };
  const hGap = s.H.filter(function (x) { return x.gap > 0; });
  const summary = [
    { letter: 'A', count: s.A.length, money: 0 },
    { letter: 'B', count: s.B.length, money: 0 },
    { letter: 'C', count: s.C.length, money: 0 },
    { letter: 'D', count: s.D.length, money: 0 },
    { letter: 'E', count: s.E.length, money: sum(s.E) },
    { letter: 'F', count: s.F.length, money: sum(s.F) },
    { letter: 'G', count: s.G.length, money: sum(s.G.map(function (x) { return { money: x.h.gap }; })) },
    { letter: 'H', count: hGap.length, money: sum(hGap) },
    { letter: 'I', count: s.I.pairs.length + s.I.voided.length, money: sum(s.I.pairs) },
    { letter: 'J', count: s.J.length, money: sum(s.J) },
    { letter: 'K', count: s.K.after.length + s.K.off.length, money: sum(s.K.after) },
  ];
  return {
    todayISO: m.todayISO, cutoff: recRecordsCutoff_(), sections: s, summary: summary,
    counts: { leads: m.leads.length, patients: m.patients.length, active: m.active.length, payments: m.payments.length,
      credits: m.credits.length, overrides: m.overrides.length, audits: m.audits.length, tombstones: m.tombs.length },
  };
}

/* ---------------- the document (the ONLY write path) ---------------- */

function recMoneyText_(n) {
  const v = Math.round(Number(n) || 0);
  return (v < 0 ? '-' : '') + String(Math.abs(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
function recShekel_(n) { return '₪' + recMoneyText_(n); }
/* 'YYYY-MM-DD' → 'DD/MM/YYYY' (the app's formatDateHe); anything else as-is. */
function recDateText_(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  return m ? m[3] + '/' + m[2] + '/' + m[1] : String(iso || '');
}
function recStatusText_(s) {
  return { paid: 'שולם', partial: 'שולם חלקית', unpaid: 'לא שולם', 'void': 'מבוטל' }[s] || s;
}
function recStageText_(s) {
  return { 'new': 'ליד חדש', visit: 'ביקור נקבע', paid: 'מקדמה שולמה', entry: 'כניסה לבית', admitted: 'נקלט',
    irrelevant: 'לא רלוונטי', waitlist: 'רשימת המתנה', 'נכנסים לטיפול': 'נכנסים לטיפול' }[s] || s;
}

/* Table rows (header first) per section, in LOGICAL order (first column =
 * rightmost once written). Pure. */
function recSectionTables_(report) {
  const s = report.sections;
  const t = {};
  t.A = [['גיליון ושורה', 'מזהה ליד', 'שם', 'טלפון', 'בית', 'שלב', 'נוצר', 'ביקור', 'כניסה', 'מקדמה', 'הערות']].concat(s.A.map(function (x) {
    const l = x.lead;
    return [x.ref, l.id, l.name, l.phone, l.house, recStageText_(x.why), recDateText_(l.created), recDateText_(l.visitDate),
      recDateText_(l.entryDate), l.advance ? recShekel_(l.advance) : '', x.notes.join('; ')];
  }));
  const kindB = { key: 'בית+שם+תאריך', fromLead: 'אותו ליד (fromLead)', phone: 'אותו טלפון' };
  t.B = [['סוג כפילות', 'ערך משותף', 'שורות', 'שמות', 'תאריכי כניסה', 'תשלום חודשי']].concat(s.B.map(function (x) {
    return [kindB[x.kind], x.key, x.refs.join(', '), x.rows.map(function (p) { return p.name; }).join(' | '),
      x.rows.map(function (p) { return recDateText_(p.date); }).join(' | '), x.rows.map(function (p) { return recShekel_(p.pay); }).join(' | ')];
  }));
  const viaC = { fromLead: 'אותו ליד', house_name_date: 'בית+שם+תאריך', id: 'אותו מזהה' };
  t.C = [['שורת שחרור', 'שם', 'בית', 'כניסה', 'שוחרר ב', 'מטופל פעיל', 'התאמה']].concat(s.C.map(function (x) {
    return [recRef_(x.audit.sheet, x.audit.row), x.audit.name, x.audit.houseId, recDateText_(x.audit.date),
      recDateText_(x.audit.dischargedAt || x.audit.exitDate), recRef_(x.patient.sheet, x.patient.row) + ' — ' + x.patient.name, viaC[x.via]];
  }));
  t.D = [['גיליון ושורה', 'שם פגום', 'שם מוצע', 'מקור ההצעה', 'רמת ביטחון']].concat(s.D.map(function (x) {
    return [x.ref, x.name, x.proposal, x.via, x.confidence];
  }));
  t.E = [['שורת תשלום', 'שם משלם/מטופל', 'בית', 'תאריך', 'סכום', 'שולם', 'סטטוס', 'טלפון', 'אמצעי תשלום', 'מועמד מוביל', 'סיבה', 'הערות']].concat(s.E.map(function (x) {
    const p = x.payment;
    return [x.ref, p.patientName, p.houseId, recDateText_(p.dueDate), recShekel_(p.amount), recShekel_(p.amountPaid), recStatusText_(p.status),
      x.phone || '', p.method || '', x.best || 'אין', x.reason, x.notes.join('; ')];
  }));
  t.F = [['שורת תשלום', 'שם בתשלום', 'תאריך', 'סכום', 'ליד', 'שם הליד', 'טלפון', 'שלב', 'התאמה']].concat(s.F.map(function (x) {
    return [x.ref, x.payment.patientName, recDateText_(x.payment.dueDate), recShekel_(recPayMoney_(x.payment)),
      recRef_(x.lead.sheet, x.lead.row) + ' (' + x.lead.id + ')', x.lead.name, x.lead.phone, recStageText_(x.lead.stage), x.reason];
  }));
  t.G = [['שורה', 'שם', 'בית', 'כניסה', 'תשלום חודשי', 'מחזורים לגבייה', 'לפני תחילת הרישום', 'פער ₪ (כולל מע״מ)']].concat(s.G.map(function (x) {
    const h = x.h;
    return [x.ref, h.patient.name, h.patient.houseId, recDateText_(h.entry), recShekel_(h.monthly),
      String(h.stayMonths - h.beforeCutoff), String(h.beforeCutoff), recShekel_(h.gap)];
  }));
  t.H = [['שורה', 'שם', 'בית', 'כניסה', 'עד', 'חודשי שהייה', 'לפני הרישום', 'מכוסים', 'חסרים', 'חלקיים',
    'חודשי כולל מע״מ', 'חודשי ללא מע״מ', 'צפוי', 'שולם', 'פער חודשים', 'פער ₪ כולל מע״מ', 'פער ₪ ללא מע״מ', 'מחזורים חסרים']].concat(s.H.map(function (x) {
    return [x.ref, x.patient.name, x.patient.houseId, recDateText_(x.entry), recDateText_(x.end), String(x.stayMonths),
      String(x.beforeCutoff), String(x.covered), String(x.missing), String(x.partial), recShekel_(x.monthly), recShekel_(x.monthlyExVat),
      recShekel_(x.expected), recShekel_(x.totalPaid), String(x.gapMonths), recShekel_(x.gap), recShekel_(x.gapExVat),
      x.gapDues.map(function (d) { return recDateText_(d.slice(0, 10)) + d.slice(10); }).join(', ')];
  }));
  t.I = [['תשלום א', 'תשלום ב', 'מטופל', 'תאריכים', 'סכום', 'ימים ביניהם']].concat(s.I.pairs.map(function (x) {
    return [recRef_(PAYMENTS_SHEET, x.a.row), recRef_(PAYMENTS_SHEET, x.b.row), x.owner,
      recDateText_(x.a.dueDate) + ' / ' + recDateText_(x.b.dueDate), recShekel_(x.a.amount), String(x.days)];
  }));
  t.Ivoid = [['שורת תשלום מבוטל', 'שם', 'תאריך', 'סכום', 'תאום אפשרי']].concat(s.I.voided.map(function (x) {
    return [recRef_(PAYMENTS_SHEET, x.payment.row), x.payment.patientName, recDateText_(x.payment.dueDate), recShekel_(x.payment.amount),
      x.twins.map(function (p) { return recRef_(PAYMENTS_SHEET, p.row) + ' ' + p.patientName; }).join('; ') || 'לא נמצא'];
  }));
  t.J = [['שורות זיכוי', 'שם', 'סוג', 'סכום זיכוי', 'סך תשלומים', 'חריגה ₪']].concat(s.J.map(function (x) {
    return [x.refs.join(', '), x.name, x.kind === 'unattached' ? 'לא משויך למטופל' : 'גדול מסך התשלומים',
      recShekel_(x.kind === 'unattached' ? x.money : x.credited), x.kind === 'unattached' ? '' : recShekel_(x.paid), recShekel_(x.money)];
  }));
  t.Kafter = [['שורת תשלום', 'מטופל', 'תאריך תשלום', 'תאריך שחרור', 'סכום', 'שולם']].concat(s.K.after.map(function (x) {
    return [x.ref, x.patient.name + ' — ' + recRef_(x.patient.sheet, x.patient.row), recDateText_(x.payment.dueDate), recDateText_(x.exit),
      recShekel_(x.payment.amount), recShekel_(x.payment.amountPaid)];
  }));
  t.Koff = [['שורת תשלום', 'מטופל', 'תאריך', 'סכום בתשלום', 'תשלום חודשי צפוי', 'הפרש ₪', 'הערה']].concat(s.K.off.map(function (x) {
    return [x.ref, x.patient.name + ' — ' + recRef_(x.patient.sheet, x.patient.row), recDateText_(x.payment.dueDate),
      recShekel_(x.payment.amount), recShekel_(x.expected), recShekel_(x.money), x.note];
  }));
  return t;
}

function recSectionTitles_() {
  return {
    A: 'A. לידים ששילמו / נקלטו / נכנסים לטיפול — ללא שורת מטופל',
    B: 'B. מטופלים פעילים כפולים',
    C: 'C. רשומות שחרור פתוחות של מטופל שעדיין פעיל',
    D: 'D. שמות פגומים (U+FFFD) והצעת תיקון',
    E: 'E. תשלומים שאינם משויכים לאף מטופל',
    F: 'F. שולם אך לא נקלט — תשלום שמתאים לליד ללא רשומת מטופל',
    G: 'G. מטופלים פעילים ללא אף תשלום',
    H: 'H. כיסוי חודשים מול תשלומים — לכל מטופל פעיל',
    I: 'I. חשד לתשלום כפול',
    J: 'J. זיכויים ללא מטופל או גדולים מסך התשלומים',
    K: 'K. תשלומים אחרי השחרור, וסכומים החורגים ביותר מ-5% מהתשלום החודשי',
  };
}

/* Writes the report into ONE new Google Doc and returns { url }. Nothing is
 * shared, moved or written anywhere else. */
function recWriteDoc_(report, title) {
  const doc = DocumentApp.create(title);
  const body = doc.getBody();
  const first = body.getParagraphs();
  for (let i = 0; i < first.length; i++) first[i].setLeftToRight(false);
  recDocPara_(body, title, DocumentApp.ParagraphHeading.TITLE);
  recDocPara_(body, 'דוח לקריאה בלבד: הגיליון לא שונה. תאריך: ' + recDateText_(report.todayISO) +
    '. תחילת הרישום: ' + recDateText_(report.cutoff) + ' — מחזורים שלפניה אינם נחשבים כחוב. ' +
    'כל הסכומים כוללים מע״מ (18%) אלא אם צוין אחרת.', null);
  recDocPara_(body, 'נקראו: ' + report.counts.leads + ' לידים, ' + report.counts.patients + ' מטופלים (' + report.counts.active +
    ' פעילים), ' + report.counts.payments + ' תשלומים, ' + report.counts.credits + ' זיכויים, ' + report.counts.overrides +
    ' חריגות חיוב, ' + report.counts.audits + ' רשומות שחרור, ' + report.counts.tombstones + ' רשומות מחיקה.', null);
  if (report.missingTabs && report.missingTabs.length) recDocPara_(body, 'לשוניות חסרות: ' + report.missingTabs.join(', '), null);
  (report.headerDrift || []).forEach(function (d) {
    recDocPara_(body, 'אזהרה — כותרות לא תואמות ב-' + d.sheet + ': ' + d.drift.join('; '), null);
  });
  const titles = recSectionTitles_();
  recDocPara_(body, 'סיכום', DocumentApp.ParagraphHeading.HEADING1);
  recDocTable_(body, [['סעיף', 'מספר פריטים', 'השפעה כספית']].concat(report.summary.map(function (x) {
    return [titles[x.letter], String(x.count), x.money ? recShekel_(x.money) : ''];
  })));
  const tables = recSectionTables_(report);
  const parts = [['A', 'A'], ['B', 'B'], ['C', 'C'], ['D', 'D'], ['E', 'E'], ['F', 'F'], ['G', 'G'], ['H', 'H'],
    ['I', 'I'], ['I', 'Ivoid'], ['J', 'J'], ['K', 'Kafter'], ['K', 'Koff']];
  const sub = { Ivoid: 'תשלומים שכבר סומנו כמבוטלים (כפילות)', Kafter: 'תשלומים אחרי תאריך השחרור', Koff: 'סכום שונה מהתשלום החודשי' };
  let last = '';
  parts.forEach(function (pt) {
    if (pt[0] !== last) { recDocPara_(body, titles[pt[0]], DocumentApp.ParagraphHeading.HEADING1); last = pt[0]; }
    if (sub[pt[1]]) recDocPara_(body, sub[pt[1]], DocumentApp.ParagraphHeading.HEADING2);
    const rows = tables[pt[1]];
    if (rows.length <= 1) { recDocPara_(body, 'אין פריטים.', null); return; }
    const cap = 300;
    recDocTable_(body, rows.slice(0, cap + 1));
    if (rows.length - 1 > cap) recDocPara_(body, 'מוצגים ' + cap + ' מתוך ' + (rows.length - 1) + ' (הגדולים ביותר ראשונים).', null);
  });
  doc.saveAndClose();
  return { url: doc.getUrl(), id: doc.getId() };
}

/* One right-to-left paragraph. */
function recDocPara_(body, text, heading) {
  const p = body.appendParagraph(String(text));
  if (heading) p.setHeading(heading);
  p.setLeftToRight(false);
  p.setAlignment(DocumentApp.HorizontalAlignment.RIGHT);
  return p;
}

/* One table, header row bold. Docs lays table columns out left-to-right, so
 * each row is reversed: the first logical column sits on the RIGHT, as a
 * Hebrew reader expects, and every cell's text runs right-to-left. */
function recDocTable_(body, rows) {
  const cells = rows.map(function (r) { return r.map(function (c) { return String(c == null ? '' : c); }).reverse(); });
  const table = body.appendTable(cells);
  for (let r = 0; r < table.getNumRows(); r++) {
    const row = table.getRow(r);
    for (let c = 0; c < row.getNumCells(); c++) {
      const cell = row.getCell(c);
      for (let k = 0; k < cell.getNumChildren(); k++) {
        const ch = cell.getChild(k);
        if (ch.getType() === DocumentApp.ElementType.PARAGRAPH) {
          const p = ch.asParagraph();
          p.setLeftToRight(false);
          p.setAlignment(DocumentApp.HorizontalAlignment.RIGHT);
        }
      }
    }
  }
  if (table.getNumRows() > 0) table.getRow(0).editAsText().setBold(true);
  return table;
}
