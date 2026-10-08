/* ===== E-ZONE Dashboard — frontend ===== */
console.log('[E-ZONE] app.js loaded at', new Date().toISOString(), 'origin:', location.origin, 'href:', location.href);

const HOUSES = [
  { id: 'arfoni', name: 'קיסריה עפרוני', capacity: 13 },
  { id: 'rehab',  name: 'קיסריה ריהאב',  capacity: 13 },
  { id: 'asher',  name: 'רעננה אשר',      capacity: 14 },
  { id: 'pardes', name: 'רעננה הפרדס',    capacity: 13 },
  { id: 'ramot',  name: 'רמות השבים',     capacity: 20 },
  { id: 'sde',    name: 'שדה אליעזר',     capacity: 16 },
];

/* assignedTo (משוייך ל) options — the three fixed lead owners. Required on the
 * add-lead form; rendered on the kanban card. Fixed list (no free text). */
const ASSIGNEE_OPTIONS = ['ורד', 'שירן', 'יעל'];

/* רשימת המתנה — a potential patient waiting for a spot; the lead's existing
 * `house` field is the house they are waiting for. Entering the stage stamps
 * `waitlistedAt` (ISO timestamp string, schema shipped in the foundation PR);
 * leaving clears it — both handled in moveLead, the single choke point for
 * board stage changes. */
const STAGE_WAITLIST = { id: 'waitlist', label: 'רשימת המתנה' };

const STAGES = [
  { id: 'new',         label: 'ליד חדש' },
  { id: 'visit',       label: 'ביקור נקבע' },
  /* Waitlist sits between ביקור נקבע and בטיפול פעיל: a lead that visited and
   * is waiting for a spot to open before it can start active care. This slot
   * also keeps every generic stage-move path working with no special cases —
   * visit's שלב הבא enters the waitlist, waitlist's שלב הבא reaches paid, and
   * paid's admit action (keyed on the stage ID, not array position) is
   * untouched. Placed LAST it would be unreachable: paid's next button is the
   * admit action, so no button path would ever move a lead in. */
  STAGE_WAITLIST,
  /* `paid` keeps its stable id so historical sheet rows still resolve via
   * STAGE_ALIASES below; only the displayed label was changed to "בטיפול פעיל".
   * `paid` is now the LAST board stage: advancing it is the admit action
   * (openEntryModal → creates the patient → retires the lead to 'admitted').
   * The old { id: 'entry', label: 'כניסה לבית' } holding column was removed —
   * it always sat empty (a paid lead enters תפוסה directly). The 'entry'/
   * 'entered' STAGE_ALIASES stay below so any legacy stored value still
   * normalizes and is caught by promoteEnteredLeads / retireAdmittedLeads. */
  { id: 'paid',        label: 'בטיפול פעיל' },
];
const STAGE_IRRELEVANT = { id: 'irrelevant', label: 'לא רלוונטי' };
const ALL_STAGES_FOR_PIPELINE = [...STAGES, STAGE_IRRELEVANT];

/* Reason captured when Vered marks a lead as "לא רלוונטי" (Phase 2b).
 * Keys persist to the irrelevant sheet (not_relevant_reason column) so a UI
 * label rename never invalidates historical rows. The Hebrew labels are
 * render-time only. */
const NOT_RELEVANT_REASON_LABELS = {
  never_relevant:     'לא היה רלוונטי מלכתחילה',
  stopped_from_house: 'המשיך מאחד הבתים והפסיק',
  stopped_new:        'ליד חדש שהתחיל והפסיק',
};

/* Phase 2d — three-disposition closure model. Splits the single לא רלוונטי
 * bucket into three first-class outcomes. Stable keys persist to the sheet
 * (disposition column); Hebrew labels are render-time only so a UI label
 * rename never invalidates historical rows. Sections render in this order. */
const DISPOSITION_LABELS = {
  not_relevant:        'לא רלוונטי',
  completed:           'סיים טיפול',
  stopped_early:       'הפסיק לפני הזמן',
  released_outpatient: 'משוחרר לטיפול חוץ',
};

/* The three discharge outcomes offered by the שחרור modal, in render order.
 * A subset of DISPOSITION_LABELS (excludes the lead-only not_relevant). The
 * modal is generic over whatever keys it's handed, so this list is the single
 * source of truth for "which dispositions a discharge can have". */
const DISCHARGE_DISPOSITIONS = ['completed', 'stopped_early', 'released_outpatient'];

/* Meeting-outcome closure model — the outcome recorded after a lead's meeting.
 * Stable keys persist to the sheet (meetingOutcome column via LEAD_COLUMNS);
 * Hebrew labels are render-time only so a UI label rename never invalidates
 * historical rows. Mirrors the DISPOSITION_LABELS precedent. Foundation only —
 * no UI consumes this map yet; it ships now so the next PR can render it. */
const MEETING_OUTCOME_LABELS = {
  not_relevant: 'לא רלוונטי',
  thinking:     'חושבים על זה',
  entered:      'נכנסים לטיפול',
  postponed:    'נדחה',
  cancelled:    'התבטל',
};

/* Meeting-report model (foundation) — house managers report what happened in a
 * lead meeting (today reported only in a WhatsApp group). DISTINCT from the
 * meetings-board MEETING_OUTCOME_LABELS above, which is a separate live feature
 * with its own key set — hence the meetingReportOutcome column name. Stable
 * keys persist to the sheet (meetingReportOutcome via LEAD_COLUMNS); Hebrew
 * labels are render-time only so a UI label rename never invalidates stored
 * rows. Foundation only — no UI consumes these maps yet; the manager form
 * ships in PR 2 and Vered's view in PR 3. */
const MEETING_REPORT_OUTCOME_LABELS = Object.freeze({
  advancing: 'התקיימה — מתקדם לכניסה',
  undecided: 'התקיימה — מתלבט',
  not_fit:   'התקיימה — לא מתאים',
  no_show:   'לא הגיע / בוטל',
});

/* Companion display rule (used in later PRs): if meetingCompanion matches a
 * key in MEETING_COMPANION_LABELS, show the label; otherwise show the raw
 * value — free text entered via אחר is stored as-is in meetingCompanion (no
 * 'other:' prefix) and rendered verbatim. */
const MEETING_COMPANION_LABELS = Object.freeze({
  mother:  'אמא',
  father:  'אבא',
  parents: 'הורים',
  partner: 'בן/בת זוג',
  sibling: 'אח/אחות',
  friend:  'חבר',
  alone:   'לבד',
  other:   'אחר',
});

/* ===== קשר למטופל (contactRelation) — fixed options + free-text escape =====
 *
 * Same shape as MEETING_COMPANION_LABELS / meetingCompanion directly above: a
 * frozen list, an «אחר» escape whose TYPED TEXT is what gets stored (never the
 * literal 'אחר'), and a display rule that renders anything off-list verbatim.
 *
 * ONE deliberate difference from the companion pattern. meetingCompanion stores
 * stable English KEYS ('mother') and maps them to Hebrew only for display.
 * contactRelation cannot: production column R has held free Hebrew text since
 * PR #67 (אמא · אבא · אחות · חברה · אישתו · בעל · בת זוג · סבתא · המטופל ·
 * עו"ס …), so the STORED value has to stay the Hebrew string itself or every
 * existing row would stop matching its own option. The option value therefore
 * IS the label, which makes this an ordered ARRAY rather than a key→label map —
 * and it carries its own order, so no separate *_ORDER array is needed.
 *
 * NOTHING here migrates, normalizes or rewrites data. A stored value that is
 * not on the list is surfaced as an extra option pinned at the top and already
 * selected (see contactRelationOptions), so opening a legacy lead and saving it
 * round-trips the value byte for byte. אישתו stays אישתו. */
const CONTACT_RELATION_OTHER = 'אחר';
const CONTACT_RELATION_LABELS = Object.freeze([
  'מטופל',
  'אמא',
  'אבא',
  'אח/אחות',
  'בן/בת',
  'בן/בת זוג',
  'סבא/סבתא',
  'קרוב משפחה',
  'חבר/חברה',
  'עו"ס',
  CONTACT_RELATION_OTHER,
]);

/* Blank placeholder — the field is optional and must stay optional. */
const CONTACT_RELATION_BLANK_LABEL = '— ללא —';

/* true when `value` is one of the fixed options (so it needs no extra option). */
function isContactRelationPreset(value) {
  return CONTACT_RELATION_LABELS.indexOf(String(value == null ? '' : value)) !== -1;
}

/* The option list for a lead's stored value: the blank placeholder, then the
 * LEGACY value pinned at the top when the stored value is off-list and
 * non-empty, then the fixed options in order. Pure — shared by the inline card
 * select and both modals so the three surfaces cannot drift. */
function contactRelationOptions(stored) {
  const v = String(stored == null ? '' : stored);
  const legacy = (v && !isContactRelationPreset(v)) ? [{ value: v, label: v }] : [];
  return [{ value: '', label: CONTACT_RELATION_BLANK_LABEL }]
    .concat(legacy)
    .concat(CONTACT_RELATION_LABELS.map(label => ({ value: label, label: label })));
}

/* What a (selection, free text) pair actually stores. Mirrors mrCompanionValue:
 * the selection itself, except under אחר where the TRIMMED free text wins.
 * Empty free text under אחר falls back to 'אחר' — the same fallback the
 * companion flow uses, and what lets a legacy row literally holding 'אחר'
 * round-trip unchanged. Pure. */
function resolveContactRelation(selected, freeText) {
  const sel = String(selected == null ? '' : selected);
  if (sel !== CONTACT_RELATION_OTHER) return sel;
  const typed = String(freeText == null ? '' : freeText).trim();
  return typed || CONTACT_RELATION_OTHER;
}

/* Display rule, mirroring meetingReportCompanionDisplay: the value is already
 * the Hebrew string, so it renders verbatim (CALLERS ESCAPE). Kept as a named
 * function so the lead card reads the same way the report block does. */
function contactRelationDisplay(value) {
  return String(value == null ? '' : value);
}

const STATUS_OPTIONS = [
  { id: 'active',   label: 'פעיל' },
  { id: 'trial',    label: 'תקופת ניסיון' },
  { id: 'wait',     label: 'בהמתנה' },
  { id: 'released', label: 'שוחרר' },
];

/* Payment status values are stored in Hebrew in the Payments sheet so the
 * sheet is legible to non-developers. Keep the ids in sync with the values
 * written by savePayment(). */
/* The three statuses a recorder CHOOSES, and the only ones in the גבייה
 * dropdown. 'void' is deliberately absent: voiding is a decision taken on the
 * שיוך תשלומים screen, against a named original, with a reason — never a
 * fourth option one click away from "לא שולם". */
const PAYMENT_STATUS = [
  { id: 'paid',    label: 'שולם' },
  { id: 'partial', label: 'שולם חלקית' },
  { id: 'unpaid',  label: 'לא שולם' },
];

/* ===== VOID =====
 * A payment row that was entered TWICE — the patient was renamed after the
 * first entry, the first row detached, and somebody recorded the money again
 * under the new name. Three confirmed pairs in the live sheet:
 *
 *   arfoni::ערן::2026-08-09        ₪35,000  duplicates  arfoni::ערן יצחק חונה::2026-08-09
 *   rehab::עדי::2026-09-14         ₪35,000  duplicates  rehab::עדי עמית::2026-09-14
 *   arfoni::עמית יעקובי::2026-09-07 ₪30,000  duplicates  arfoni::עמית בורנשטיין::2026-09-07
 *
 * THE ROW IS NEVER DELETED. Deleting it would destroy the evidence that the
 * money was entered twice — which is the only way anyone could later tell a
 * double entry from a payment that really was collected twice. It is marked
 * VOID: it keeps its amount, its amountPaid and its dates exactly as recorded,
 * and every figure in the app steps over it.
 *
 * 'void' is a real, aliased status, NOT an unknown one: normalizePayment maps
 * an unrecognized status to 'unpaid', so a void row read back from the sheet
 * would silently un-void itself. Mirrored by PAYMENT_STATUS_ALIASES_ in
 * Code.gs for the same reason. */
const PAYMENT_VOID_STATUS = 'void';
const PAYMENT_VOID_LABEL = 'מבוטל';

const PAYMENT_STATUS_ALIASES = {
  'שולם': 'paid', 'paid': 'paid',
  'שולם חלקית': 'partial', 'partial': 'partial',
  'לא שולם': 'unpaid', 'unpaid': 'unpaid',
  'מבוטל': 'void', 'void': 'void',
};

/* THE ONE QUESTION every revenue, debt and alert figure asks before counting a
 * payment row. One predicate, so "excluded everywhere" is a property of the
 * code rather than a promise in a changelog: a new consumer that forgets it is
 * the bug this function exists to make findable. */
function isVoidPayment(pay) {
  return !!pay && String(pay.status || '') === PAYMENT_VOID_STATUS;
}

/* Who may UNDO a void. Not a role system — this app has none — but the name
 * the repo already uses for the person who decides exceptions (see
 * CREDIT_RULE_LABELS' "חריגה באישור סנדרה" and meeting-report's "פנו לסנדרה").
 *
 * Marking a duplicate is ordinary daily work; UNMARKING one puts a second
 * payment back into the revenue and debt figures, which is a money decision.
 * The SERVER is the authority (PAYMENT_VOID_REVERSERS in Code.gs); this copy
 * only decides whether the control is offered, so the refusal never has to be
 * discovered by clicking. */
const PAYMENT_VOID_REVERSERS = ['סנדרה'];
function canReverseVoid() {
  return state.approver === true && PAYMENT_VOID_REVERSERS.indexOf(String(state.sessionUser || '').trim()) >= 0;
}

/* ===== Roles in the UI (PR C) =====
 *
 * deleter (Vered, Sandra): every delete / void / cancel control — הסר ליד,
 * מחיקת דיווח, ✕ (מחיקה לצמיתות), ↩ (ביטול התאמת סכום), כפילות (סימון
 * תשלום כמבוטל), and the «בוטל» credit status. approver (Sandra's personal
 * session): «ביטול סימון הכפילות» (un-void) — and the refund-exception /
 * write-off controls when they are built (Phase 1/2).
 *
 * Display only: server.js (lib/role-scope.js) and Code.gs refuse the
 * operation itself (403 forbidden_role). Each control carries
 * data-role="deleter" | "approver", hidden by CSS unless <body> has the
 * matching role-* class (applyRoleView), and each handler re-checks — so a
 * control is never offered before /api/me has answered. */
const ROLE_FORBIDDEN_TEXT = 'אין הרשאה לפעולה זו';
function canDelete() {
  return state.deleter === true;
}

/* The <body> role classes for a session. Pure. */
function roleBodyClasses(deleter, approver) {
  return { 'role-deleter': deleter === true, 'role-approver': approver === true };
}

function applyRoleView() {
  const body = document.body;
  if (!body || !body.classList) return;
  const cls = roleBodyClasses(state.deleter, state.approver);
  Object.keys(cls).forEach(k => body.classList.toggle(k, cls[k]));
}

const houseById = id => HOUSES.find(h => h.id === id);
const houseByName = name => HOUSES.find(h => h.name === name);

const state = {
  leads: [],
  irrelevantLeads: [],
  removedLeads: [],
  patients: [],
  dischargedPatients: [],
  /* The name inside the signed session cookie, echoed by /api/me. Display and
   * control-gating only; every server-side decision reads the cookie itself. */
  sessionUser: '',
  /* 'personal' | '' — from /api/me. Display only. */
  sessionAuth: '',
  /* Roles (PR C), from /api/me — display only; server.js and Code.gs refuse
   * the operation itself (403 forbidden_role). deleter = Vered, Sandra: every
   * delete / void / cancel control. approver = Sandra's personal session:
   * un-void, refund exceptions, write-off. false until /api/me answers, so a
   * control is never offered before the role is known. */
  deleter: false,
  approver: false,
  /* Restricted view: true = the session may see billing (Sandra, Vered);
   * false = Shiran / Yael; null = not
   * known yet (before /api/me). From /api/me — display only; the server
   * refuses the data itself. */
  finance: null,
  /* «בקרת גבייה» (Phase 4), from /api/me — display only; server.js and
   * Code.gs refuse the data and the decision themselves.
   *   view            'full' | 'restricted' | 'controller' | null (unknown)
   *   billingControl  may open the «בקרת גבייה» tab (Vered, Sandra, Ortal)
   *   canConfirm      may confirm / flag a receipt (Ortal, Sandra) */
  view: null,
  billingControl: null,
  canConfirm: false,
  payments: [],
  /* Phase 3 PR 2: one row per money received (getPayments `receipts`, each
   * with the cycleId it pays for) and the Funders tab (getPayments
   * `funders`). Finance sessions only — a restricted session never loads them. */
  receipts: [],
  funders: [],
  /* Credits / refunds ledger rows (Credits sheet), loaded by getCredits in
   * loadAll. Empty on a fresh install or an older deploy. */
  credits: [],
  /* Per-patient, per-month overrides of the monthly billing amount (סכום חודשי),
   * returned by getData as `billingOverrides`. One entry per (patientId, month).
   * Foundation phase: populated on load and plumbed through state only — no UI
   * reads it yet. Empty until the first load / on older deploys. */
  billingOverrides: [],
  /* גבייה funder filter: 'all' | a funder key (public/funder.js) | 'unset'. */
  billingFunder: 'all',
  /* House-id → manager-name roster returned by getData (HOUSE_MANAGERS in
   * Code.gs). Populated in loadAll; the meetingWith dropdown and the meetings
   * board read it instead of hardcoding names. '{}' until the first load. */
  houseManagers: {},
  /* Who manages each house TODAY: [{ house, name }] from getData's
   * currentManagers (Managers tab → bonusconfig → houseManagers, see
   * currentManagers_ in Code.gs). null until a backend that sends it loads. */
  currentManagers: null,
  /* Manager-name → WhatsApp phone map returned by getData (MANAGER_PHONES in
   * Code.gs). Keyed by NAME because meetingWith stores the name. Drives the
   * meetings-board WhatsApp button; '{}' until the first load (button disabled). */
  managerPhones: {},
  /* Render mode. Historically 'edit' | 'viewer'; viewer mode was removed with
   * the API-auth change, so 'edit' is now the only reachable value (an
   * authenticated user is an editor). The mode machinery is retained because the
   * `state.mode === 'edit'` checks are woven through many render sites — they all
   * simply evaluate true now. */
  mode: null,
  currentScreen: 'dashboard',
  currentHouseTab: 'arfoni',
  /* Sunday (bare YYYY-MM-DD) anchoring the visible week on the meetings board.
   * Defaults to the current week on first render (see renderMeetings). */
  meetingsWeekStart: '',
  leadSearch: '',
  retentionSearch: '',
  patientSearch: '',
  dischargedSearch: '',
  billingSearch: '',
  /* תפוסה tab: reveal released patients in the LIST (dimmed, with a שחזר
   * button). SESSION-ONLY by design — never persisted (no localStorage), so
   * every fresh load starts with released patients hidden. Display-only:
   * released patients stay excluded from every occupancy count and KPI
   * regardless of this flag (houseOccupancyCount and the dashboard/billing
   * filters ignore it). */
  showReleasedPatients: false,
  billingDate: '',
  /* הכנסות חודשיות — its OWN month + search, so changing either here
   * never disturbs the daily גבייה screen's date above. */
  revenueMonth: '',    // 'YYYY-MM'; defaults to the current month
  revenueSearch: '',
  breakeven: null, // loaded from localStorage in initBreakeven()
};

/* ===== Break-even defaults =====
 * Default expense data based on the financial analysis (May 2026).
 * These values are loaded from localStorage and edited from the UI.
 * Stored per-house under the same houseId used in HOUSES.
 * `active` controls whether the house participates in the network calculation. */
const BREAKEVEN_DEFAULTS = {
  hqCost: 300000,
  houses: {
    arfoni: { active: true,  fixed: 147200, variable: 90000 },
    rehab:  { active: true,  fixed: 130000, variable: 80000 },
    asher:  { active: true,  fixed: 170000, variable: 140000 },
    pardes: { active: false, fixed: 0,      variable: 0 },
    ramot:  { active: true,  fixed: 239000, variable: 217000 },
    sde:    { active: false, fixed: 147200, variable: 90000 },
  },
};

const BREAKEVEN_STORAGE_KEY = 'ezone-breakeven-v1';

/* Israeli VAT multiplier (18% as of 2025). Patient payments (`pay`) and the
 * PRICE_FALLBACKS below are stored VAT-inclusive (the gross amount billed).
 * The break-even tab reasons about revenue net of VAT, so we divide by this
 * at point of use in computeHouseMetrics rather than mutating the stored data. */
const VAT_RATE = 1.18;

/* ===== RECORDS CUTOFF =====
 * The first date from which this app's payment records are COMPLETE.
 *
 * Payments were not entered here before July 2026: of the 27 patients admitted
 * in June, not one has a first payment recorded. The cycles are real — the
 * patients were in the house and the money was collected — but the ROWS were
 * never created, so every screen that infers a cycle from a patient's entry
 * day was reading that absence as unpaid debt and forecasting revenue that had
 * already been earned and banked elsewhere.
 *
 * A cycle whose due date falls before this line is therefore neither EXPECTED
 * nor DEBT. It is not hidden either — hiding it would be the same silent
 * assumption in the other direction — it goes to its own bucket,
 * "לפני תחילת הרישום", which no total sums.
 *
 * One constant, one date, deliberately configurable: when the historical rows
 * are eventually backfilled, moving this line earlier is the whole migration.
 * Bare 'YYYY-MM-DD', compared as a string against isoDate()-normalized dates —
 * never parsed, so no timezone can move it. */
const RECORDS_COMPLETE_FROM = '2026-07-01';

/* Is this cycle's due date before the records cutoff? `dueISO` is normalized
 * through isoDate() first: a date-typed sheet cell arrives as a UTC timestamp
 * and a raw string compare would put 2026-07-01T21:00:00Z on the wrong side of
 * the line — the same one-day drift this app has fixed in five other places.
 *
 * `from` overrides the constant. It exists for buildMonthlyRevenue(), which is
 * a PURE function its tests drive over arbitrary months — a suite pinned to a
 * calendar would otherwise start failing the day the cutoff moves. Nothing in
 * the app passes it: every screen reads RECORDS_COMPLETE_FROM, and a guard
 * test asserts renderMonthlyRevenue() hands over no override. */
function isPreRecordsCycle(dueISO, from) {
  const line = isoDate(from) || RECORDS_COMPLETE_FROM;
  const d = isoDate(dueISO);
  return !!d && d < line;
}

/* ===== API ===== */
async function apiGet(params) {
  const qs = new URLSearchParams(params).toString();
  const url = '/api/sheets?' + qs;
  console.log('[E-ZONE] GET →', new URL(url, location.origin).href);
  // cache: 'no-store' — a read is never answered from any HTTP cache (the
  // server already sends no-store and sw.js never caches /api/; this makes
  // the browser side explicit too). CHANGELOG-payment-report-persistence.md.
  const res = await fetch(url, { cache: 'no-store' });
  if (res.status === 401) { showPinScreen(); throw new Error('unauthorized'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    throw new Error(data.message || data.error || ('HTTP ' + res.status));
  }
  return data;
}

/* ===== Busy script lock (lock_busy) =====
 *
 * Every Apps Script writer answers {ok:false, error:'lock_busy'} when it could
 * not take the script lock — BEFORE writing anything (see lockBusy_ in
 * Code.gs). So the exact same request is safe to send again: apiPost waits
 * LOCK_BUSY_RETRY_MS and retries ONCE. If the lock is still busy it throws an
 * error whose message is the Hebrew LOCK_BUSY_MESSAGE_HE (never the server's
 * English text) and carries lockBusy:true, so every caller's existing
 * showError(prefix + e.message) tells the user what happened.
 * test/lock-busy-frontend.test.js covers every write path. */
const LOCK_BUSY_ERROR = 'lock_busy';
const LOCK_BUSY_MESSAGE_HE = 'המערכת עסוקה, נסו שוב';
const LOCK_BUSY_RETRY_MS = 2000;

/* The 2 s pause before the one automatic retry. A separate function so the
 * tests can run it instantly. */
function lockBusyDelay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/* True for an error apiPost threw because the script lock stayed busy. */
function isLockBusyError(e) {
  return !!(e && e.lockBusy === true);
}

async function apiPost(body) {
  const url = '/api/sheets';
  const payload = JSON.stringify(body);
  let { res, data } = await apiPostOnce(url, payload);
  if (data && data.error === LOCK_BUSY_ERROR) {
    // Nothing was written — wait, then send the SAME body once more.
    console.warn('[E-ZONE] script lock busy — retrying once in', LOCK_BUSY_RETRY_MS, 'ms');
    await lockBusyDelay(LOCK_BUSY_RETRY_MS);
    ({ res, data } = await apiPostOnce(url, payload));
    if (data && data.error === LOCK_BUSY_ERROR) {
      const err = new Error(LOCK_BUSY_MESSAGE_HE);
      err.data = data;
      err.lockBusy = true;
      throw err;
    }
  }
  if (!res.ok || data.ok === false) {
    // A HTTP 200 carrying {ok:false} is a FAILURE — never swallowed. The parsed
    // body rides on the error so callers can read structured refusals (e.g. a
    // stale-save `conflicts` list) instead of only the message string.
    const err = new Error(data.message || data.error || ('HTTP ' + res.status));
    err.data = data;
    throw err;
  }
  return data;
}

/* One POST round-trip: the response plus its parsed body. A 401 shows the PIN
 * screen and throws, exactly as before. */
async function apiPostOnce(url, payload) {
  console.log('[E-ZONE] POST →', new URL(url, location.origin).href);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: payload,
  });
  if (res.status === 401) { showPinScreen(); throw new Error('unauthorized'); }
  const data = await res.json().catch(() => ({}));
  return { res, data };
}

/* Serialize current state into the shape the Apps Script expects.
 * The output is ALWAYS an object with all six house keys, each mapping
 * to an array. We build it explicitly (not via HOUSES.forEach) so the
 * shape is guaranteed even if HOUSES is ever mutated or mis-ordered. */
function serializePatients() {
  const out = {
    arfoni: [],
    rehab:  [],
    asher:  [],
    pardes: [],
    ramot:  [],
    sde:    [],
  };

  const src = Array.isArray(state.patients) ? state.patients : [];
  const invalid = [];

  for (let i = 0; i < src.length; i++) {
    const p = src[i];
    if (!p || typeof p !== 'object') { invalid.push({ i, reason: 'not-object', p }); continue; }
    const hid = p.houseId;
    if (!hid || typeof hid !== 'string') { invalid.push({ i, reason: 'no-houseId', p }); continue; }

    // Rebuild each record as a plain primitives-only object so nothing
    // unstringifiable (e.g., a stray Date reference) can poison JSON.stringify.
    const record = {
      id:       p.id       ? String(p.id)       : '',
      houseId:  hid,
      name:     p.name     ? String(p.name)     : '',
      date:     p.date     ? String(p.date)     : '',
      pay:      Number(p.pay) || 0,
      adv:      Number(p.adv) || 0,
      status:   p.status   ? String(p.status)   : 'active',
      fromLead: p.fromLead ? String(p.fromLead) : '',
      exitDate: p.exitDate ? String(p.exitDate) : '',
      source:   p.source   ? String(p.source)   : 'lead',
      notes:    p.notes    ? String(p.notes)    : '',
      /* Who/when round-trip: echo the server-owned stamps unchanged (the
       * server discards them on a matched replace and re-stamps real edits;
       * dropping them here would look like data loss to the diff). */
      updatedAt: p.updatedAt ? String(p.updatedAt) : '',
      updatedBy: p.updatedBy ? String(p.updatedBy) : '',
    };
    /* A deliberate house move from the ✏ modal: the house this patient is
     * LEAVING, sent only while the move is pending. It is what lets the
     * backend move the row (same id, one row) instead of reading a patient
     * that shows up in a new house as a duplicate admission. Never stored. */
    if (p.movedFrom) record.movedFrom = String(p.movedFrom);

    if (!out[hid]) out[hid] = [];   // unknown houseId — keep the data, don't drop
    out[hid].push(record);
  }

  const total = Object.keys(out).reduce((n, k) => n + out[k].length, 0);
  if (invalid.length) console.warn('[E-ZONE] serializePatients dropped invalid records:', invalid);
  if (src.length > 0 && total === 0) {
    console.error('[E-ZONE] serializePatients produced 0 patients from', src.length, 'state entries — sample:', src.slice(0, 3));
  }
  return out;
}

let savePromise = Promise.resolve();

/* ===== Merge-don't-drop, client side (stale-tab resync) =====
 *
 * The backend's saveAll MERGES patients per house instead of whole-house
 * replacing: sheet rows this tab's payload omitted (its in-memory state
 * predates them) are KEPT on the sheet and their identity keys echoed back
 * under `preserved`. A non-empty echo means THIS tab's memory is stale by
 * definition — reload from the sheet instead of trusting it, or the missing
 * rows never render here and every subsequent save keeps re-reporting them.
 * Guards: one resync at a time, and a 30s floor between resyncs so a
 * pathological backend echo can't loop reloads. */
function saveAllResponseNeedsResync(res) {
  if (!res || typeof res !== 'object') return false;
  const nonEmpty = (m) => !!m && typeof m === 'object' && !Array.isArray(m) &&
    Object.keys(m).some(h => Array.isArray(m[h]) && m[h].length > 0);
  // preserved: rows this tab's payload omitted (it never loaded them).
  // deletedSuppressed: rows this tab tried to resurrect past a user-delete
  // tombstone. conflicts: rows the backend REFUSED because this tab loaded
  // an older version someone else has since updated (stale-stamp refusal).
  // Any of them means the tab's memory is stale — reload.
  return nonEmpty(res.preserved) || nonEmpty(res.deletedSuppressed) ||
    (Array.isArray(res.conflicts) && res.conflicts.length > 0);
}

/* Hebrew error message when the backend's promotion dedupe guard refused
 * rows (saveAll response carries a non-empty promoteSkipped map); null when
 * nothing was refused. The refusal must NEVER be silent — a refused row means
 * something this tab tried to write did not land (a duplicate promotion, a
 * house-move of a lead-linked patient, a discharged lead re-promotion).
 * Pure — unit-tested; tolerant of old backends that don't send the field. */
function promoteSkippedMessage(res) {
  if (!res || typeof res !== 'object') return null;
  const m = res.promoteSkipped;
  if (!m || typeof m !== 'object' || Array.isArray(m)) return null;
  const names = [];
  Object.keys(m).forEach(h => {
    (Array.isArray(m[h]) ? m[h] : []).forEach(s => {
      if (s && s.name) names.push(String(s.name));
    });
  });
  if (names.length === 0) return null;
  return 'שורה לא נשמרה — כפילות זוהתה: ' + names.join(', ');
}

/* Hebrew error message when the backend REFUSED stale saves — the saveAll
 * response carries a non-empty `conflicts` array (the id-match branch found
 * this tab loaded an OLDER version of a row someone else has since updated);
 * null when none. The refusal is never silent and never retried
 * automatically: the banner tells who saved first, and the resync (same
 * mechanism as `preserved`) reloads the sheet's version. Pure — unit-tested;
 * tolerant of old backends without the field (precedent:
 * promoteSkippedMessage). */
function conflictsMessage(res) {
  if (!res || typeof res !== 'object') return null;
  if (!Array.isArray(res.conflicts) || res.conflicts.length === 0) return null;
  // A refused HOUSE MOVE says so in its own words (moveRefusalMessage);
  // every other refusal keeps the one combined sentence below.
  const parts = res.conflicts.filter(c => c && c.move).map(moveRefusalMessage);
  const edits = res.conflicts.filter(c => !(c && c.move));
  if (edits.length > 0) {
    const names = [];
    const by = [];
    edits.forEach(c => {
      const n = c && c.name ? String(c.name) : '';
      if (n && names.indexOf(n) < 0) names.push(n);
      const u = c && c.sheetUpdatedBy ? String(c.sheetUpdatedBy) : '';
      if (u && by.indexOf(u) < 0) by.push(u);
    });
    const who = by.length > 0 ? by.join(', ') : 'משתמש/ת אחר/ת';
    parts.push('השינוי ל־' + (names.length ? names.join(', ') : 'מטופל/ת') +
      ' לא נשמר — ' + who + ' עדכן/ה קודם. הנתונים רועננו.');
  }
  return parts.join(' ');
}

/* A house label for messages: the Hebrew name, or the raw id when the house
 * is unknown. */
function houseLabel(id) {
  const h = houseById(resolveHouseId(id));
  return h ? h.name : String(id || '');
}

/* The Hebrew message for ONE refused house move — a `conflicts` entry that
 * carries `move: {from, to, reason, currentHouseId}` (replaceHousePatients_).
 * Says what was refused, why, and where the patient actually is. Pure. */
function moveRefusalMessage(c) {
  const name = c && c.name ? String(c.name) : 'המטופל/ת';
  const m = (c && c.move) || {};
  const to = houseLabel(m.to);
  const who = c && c.sheetUpdatedBy ? String(c.sheetUpdatedBy) : 'משתמש/ת אחר/ת';
  if (m.reason === 'moved_elsewhere') {
    return 'המעבר של ' + name + ' ל' + to + ' לא נשמר — ' + name + ' כבר נמצא/ת ב' +
      houseLabel(m.currentHouseId) + ' (' + who + ' העביר/ה קודם). הנתונים רועננו.';
  }
  if (m.reason === 'source_missing') {
    return 'המעבר של ' + name + ' ל' + to + ' לא נשמר — הרשומה כבר לא קיימת בגיליון. הנתונים רועננו.';
  }
  return 'המעבר של ' + name + ' ל' + to + ' לא נשמר — ' + who + ' עדכן/ה את הרשומה בינתיים, ו' +
    name + ' נשאר/ה ב' + houseLabel(m.from) + '. הנתונים רועננו — אפשר לנסות שוב.';
}

/* The Hebrew message when a house move got NO answer from the backend —
 * neither landed (`moved`) nor refused with a reason. That is an older
 * backend, or a save that never reached the sheet. Pure. */
function moveNotSavedMessage(name, fromHouseId, toHouseId) {
  const who = name ? String(name) : 'המטופל/ת';
  return 'המעבר של ' + who + ' ל' + houseLabel(toHouseId) + ' לא נשמר — ' + who +
    ' נשאר/ה ב' + houseLabel(fromHouseId) + '.';
}

/* What one saveAll SENT, per patient id: the object and the updatedAt it
 * carried. Built from the same state the payload was serialized from, in the
 * same tick. An id held by two objects is ambiguous and left out. */
function sentPatientsById(patients) {
  const out = new Map();
  const dup = new Set();
  (Array.isArray(patients) ? patients : []).forEach(p => {
    const id = p && p.id ? String(p.id) : '';
    if (!id) return;
    if (out.has(id)) { dup.add(id); return; }
    out.set(id, { obj: p, stamp: String(p.updatedAt || '') });
  });
  dup.forEach(id => out.delete(id));
  return out;
}

/* Apply a saveAll response to the patient objects that save SENT (`sent`,
 * from sentPatientsById):
 *   - `stamps`: adopt the who/when stamps the backend just wrote, but only
 *     on an object that still holds the stamp it was sent with — so this
 *     tab's OWN next edit of the patient is not refused as stale, while an
 *     object a reload has replaced (or that changed hands) is never touched;
 *   - `moved`: a house move landed — the pending movedFrom intent is done;
 *   - a refused move (a `conflicts` entry with `move`): the object goes back
 *     to the house the patient is really in, the intent is dropped, and the
 *     refusal is recorded on it (`_moveRefused`) for the ✏ modal. Reverting
 *     here, not in the modal, matters: a later queued save must never send
 *     the patient under the new house WITHOUT the intent.
 * Returns what it did, for tests. Tolerant of old backends (fields absent). */
function applySaveOutcome(sent, res) {
  const out = { stamped: [], moved: [], refused: [] };
  if (!(sent instanceof Map) || !res || typeof res !== 'object') return out;
  const stamps = res.stamps && typeof res.stamps === 'object' && !Array.isArray(res.stamps) ? res.stamps : {};
  Object.keys(stamps).forEach(id => {
    const e = sent.get(id);
    const s = stamps[id] || {};
    if (!e || String(e.obj.updatedAt || '') !== e.stamp || !s.updatedAt) return;
    e.obj.updatedAt = String(s.updatedAt);
    e.obj.updatedBy = String(s.updatedBy == null ? '' : s.updatedBy);
    out.stamped.push(id);
  });
  (Array.isArray(res.moved) ? res.moved : []).forEach(m => {
    const e = m && sent.get(String(m.id || ''));
    if (!e) return;
    delete e.obj.movedFrom;
    out.moved.push(String(m.id));
  });
  (Array.isArray(res.conflicts) ? res.conflicts : []).forEach(c => {
    const e = c && c.move && sent.get(String(c.id || ''));
    if (!e || !e.obj.movedFrom) return;
    e.obj.houseId = c.move.currentHouseId || c.move.from || e.obj.movedFrom;
    delete e.obj.movedFrom;
    e.obj._moveRefused = c;
    out.refused.push(String(c.id));
  });
  return out;
}

let _preservedResyncBusy = false;
let _preservedResyncLastAt = 0;
function maybeResyncPreservedPatients(res) {
  if (!saveAllResponseNeedsResync(res)) return;
  const now = Date.now();
  if (_preservedResyncBusy || now - _preservedResyncLastAt < 30000) return;
  _preservedResyncBusy = true;
  _preservedResyncLastAt = now;
  console.warn('[E-ZONE] stale save detected — resyncing from sheet. preserved:',
    res.preserved, 'deletedSuppressed:', res.deletedSuppressed);
  showToast('זוהה מידע לא מעודכן — מרענן נתונים מהגיליון');
  // Fire-and-forget: loadAll re-chains any follow-up save onto savePromise.
  Promise.resolve()
    .then(() => loadAll())
    .catch(e => console.warn('[E-ZONE] preserved-rows resync failed:', e.message))
    .finally(() => { _preservedResyncBusy = false; });
}

/* Saves currently in flight — the visibilitychange resync (see loadAll's
 * listener) skips reloading while a write is mid-air. */
let _savesInFlight = 0;

/* ===== Money-state freshness (CHANGELOG-payment-report-persistence.md) =====
 * The bug: a getPayments read that STARTED before a payment write landed
 * (loadAll from the visibility resync, a second tab action…) answered AFTER
 * the write's echo had been applied and overwrote it with the sheet as it
 * was before — the row Vered had just reported read «לא שולם» again.
 *
 * The guard: every confirmed (or in-flight) payment write bumps
 * _paymentsWriteSeq; every getPayments read takes a ticket when it STARTS.
 * A read is applied only if no write happened since its ticket and no
 * newer read was applied already — otherwise it is discarded and the
 * current (newer, confirmed) money state stays on screen. */
/* ===== Read guards (CHANGELOG-write-path-hardening.md) =====
 * The PR #201 sequence guard, generalized: one guard per slice of state that
 * a read replaces wholesale. A write calls noteWrite() (before it is sent and
 * again when it answers); a read takes begin() when it STARTS; isCurrent()
 * says whether its answer may still be applied — no write since its ticket,
 * no newer read applied already, and (opts.quiescent) no save in flight now.
 * applied(ticket) records that the answer was applied. */
function createReadGuard(opts) {
  const o = opts || {};
  let writeSeq = 0, readSeq = 0, appliedSeq = 0;
  return {
    begin() { readSeq++; return { read: readSeq, write: writeSeq }; },
    noteWrite() { writeSeq++; },
    isCurrent(ticket) {
      if (!ticket || ticket.write !== writeSeq || ticket.read <= appliedSeq) return false;
      return !(o.quiescent && _savesInFlight > 0);
    },
    applied(ticket) { if (ticket && ticket.read > appliedSeq) appliedSeq = ticket.read; },
  };
}
/* getPayments (payments + receipts + funders) — PR #201. */
const _paymentsGuard = createReadGuard();
/* getData (leads, patients, overrides, closed / removed / discharged lists).
 * Quiescent: an edit waiting in the saveAll queue lives in the state objects
 * a getData answer would replace, so no getData answer lands while any save
 * is in flight — it is discarded and re-read once the saves drain. */
const _dataGuard = createReadGuard({ quiescent: true });
/* getCredits. */
const _creditsGuard = createReadGuard();
/* billingControlQueue («בקרת גבייה»). */
const _billingControlGuard = createReadGuard();

/* The post-save reconcile in flight (tests await it). */
let _paymentsReconcile = null;
const PAYMENTS_LOAD_FAILED_HE = 'טעינת התשלומים נכשלה — הסטטוסים המוצגים אינם מעודכנים, רעננו את הדף';
const CREDITS_LOAD_FAILED_HE = 'טעינת הזיכויים נכשלה — הרשימה המוצגת אינה מעודכנת, רעננו את הדף';

function beginPaymentsRead() {
  return _paymentsGuard.begin();
}
function notePaymentsWrite() {
  _paymentsGuard.noteWrite();
}
function paymentsReadIsCurrent(ticket) {
  return _paymentsGuard.isCurrent(ticket);
}

/* ===== Saves in flight (CHANGELOG-write-path-hardening.md) =====
 * Every write — saveAll and every direct apiPost write — is bracketed by
 * beginSave / endSave: counted in _savesInFlight (the visibility resync and
 * the data guard wait for it) and noted on the read guards of the state it
 * changes, before it is sent and again when it answers. When the last save
 * ends, callbacks queued by whenSavesDrain run (a getData answer that was
 * discarded as stale is re-read then). */
let _drainCallbacks = [];
function beginSave(guards) {
  _savesInFlight++;
  (guards || []).forEach(g => g.noteWrite());
}
function endSave(guards) {
  (guards || []).forEach(g => g.noteWrite());
  _savesInFlight = Math.max(0, _savesInFlight - 1);
  if (_savesInFlight === 0 && _drainCallbacks.length) {
    const cbs = _drainCallbacks;
    _drainCallbacks = [];
    cbs.forEach(fn => { try { fn(); } catch (e) { console.warn('[E-ZONE] drain callback failed:', e && e.message); } });
  }
}
function whenSavesDrain(fn) {
  if (_savesInFlight === 0) { fn(); return; }
  _drainCallbacks.push(fn);
}
/* One write, tracked: beginSave → work() → endSave (also on failure). */
async function trackedWrite(guards, work) {
  beginSave(guards);
  try {
    return await work();
  } finally {
    endSave(guards);
  }
}

/* «נשמר» only with proof (R3): the server's answer must carry the persisted
 * row's id. pick(res) → that id ('' when absent); `want`, when given, is the
 * id this write targeted. Otherwise throws SAVE_UNPROVEN_HE — the caller's
 * form stays open with its values. → the id. */
const SAVE_UNPROVEN_HE = 'השמירה לא אושרה בשרת — לא נשמר, נסו שוב';
const AUTO_SAVE_FAILED_HE = 'עדכון אוטומטי (קליטה / שחרור) לא נשמר — יישלח שוב בשמירה הבאה. ';
function requireSavedId(res, pick, want) {
  let id = '';
  try { id = res && res.ok !== false ? String(pick(res) || '') : ''; } catch (_) { id = ''; }
  if (!id || (want !== undefined && want !== null && String(want) !== id)) {
    const err = new Error(SAVE_UNPROVEN_HE);
    err.data = res;
    err.unproven = true;
    throw err;
  }
  return id;
}

/* The saveAll version of requireSavedId: `id` must be in the answer's
 * proven[kind] (the server read it back under the save's lock). */
function requireProven(res, kind, id) {
  return requireSavedId(res, r => {
    const list = r && r.proven && Array.isArray(r.proven[kind]) ? r.proven[kind] : [];
    return list.indexOf(String(id)) >= 0 ? String(id) : '';
  }, id);
}

/* True when a saveAll answer REFUSED this tab's edit of patient `id` as stale
 * (a `conflicts` entry that is not a house move — those have their own flow). */
function saveRefusedEdit(res, id) {
  return !!res && Array.isArray(res.conflicts) &&
    res.conflicts.some(c => c && !c.move && String(c.id || '') === String(id));
}
/* A getPayments answer → the three state lists. Throws on a malformed row,
 * BEFORE anything is assigned, so a bad answer never half-replaces state. */
function paymentsStateFrom(pr) {
  return {
    payments: (Array.isArray(pr && pr.payments) ? pr.payments : []).map(normalizePayment).filter(p => p.id),
    receipts: (Array.isArray(pr && pr.receipts) ? pr.receipts : []).map(normalizeReceipt).filter(r => r.id),
    funders: (Array.isArray(pr && pr.funders) ? pr.funders : []).map(normalizeFunderRow).filter(f => f.patientId),
  };
}
/* Apply a getPayments answer read under `ticket` — or discard it as stale.
 * → true when applied. */
function applyPaymentsRead(ticket, pr) {
  const next = paymentsStateFrom(pr);
  if (!paymentsReadIsCurrent(ticket)) {
    console.warn('[E-ZONE] getPayments answer discarded — a payment write landed after it started');
    return false;
  }
  state.payments = next.payments;
  state.receipts = next.receipts;
  state.funders = next.funders;
  _paymentsGuard.applied(ticket);
  return true;
}

/* A getCredits answer read under `ticket` → state.credits, or discarded as
 * stale. Parsed fully before anything is assigned. → true when applied. */
function applyCreditsRead(ticket, cr) {
  const next = (Array.isArray(cr && cr.credits) ? cr.credits : []).map(normalizeCredit).filter(c => c.id);
  if (!_creditsGuard.isCurrent(ticket)) {
    console.warn('[E-ZONE] getCredits answer discarded — a credit write landed after it started');
    return false;
  }
  state.credits = next;
  _creditsGuard.applied(ticket);
  return true;
}

/* A discarded getData answer is re-read ONCE, after the saves in flight
 * drain — never under them. */
let _dataResyncQueued = false;
function queueDataResync() {
  if (_dataResyncQueued) return;
  _dataResyncQueued = true;
  whenSavesDrain(() => {
    _dataResyncQueued = false;
    Promise.resolve().then(() => loadAll())
      .catch(e => console.warn('[E-ZONE] data resync failed:', e && e.message));
  });
}

/* Save full state to Sheets. Serialized so overlapping calls don't interleave. */
function saveAll(opts) {
  if (state.mode !== 'edit') return Promise.resolve();
  // opts.prove: { leads: [id], patients: [id] } — the rows the caller must
  // see on the sheet before it says «נשמר» (requireProven).
  const prove = opts && opts.prove ? opts.prove : null;
  const work = async () => {
    const patients = serializePatients();
    // The objects this save is sending, with the stamps they carry — read in
    // the same tick as the payload, so the response is applied to exactly
    // what was sent (applySaveOutcome).
    const sent = sentPatientsById(state.patients);
    const patientCount = Object.values(patients).reduce((n, arr) => n + arr.length, 0);
    const byHouse = {};
    Object.entries(patients).forEach(([k, v]) => { byHouse[k] = v.length; });

    console.log('[E-ZONE] saveAll →', {
      leadCount: state.leads.length,
      patientCount,
      byHouse,
      stateTotal: state.patients.length,
    });

    if (state.patients.length > 0 && patientCount === 0) {
      throw new Error(`state.patients has ${state.patients.length} items but serialized payload is empty — houseId mismatch?`);
    }
    if (state.patients.length !== patientCount) {
      console.warn('[E-ZONE] patient count mismatch — state:', state.patients.length, 'serialized:', patientCount, state.patients);
    }

    const payload = {
      action: 'saveAll',
      leads: state.leads,
      patients,
    };
    if (prove) payload.prove = prove;

    // Hard guard: patients must be a plain object keyed by houseId, never
    // an array. serializePatients already guarantees this, but asserting
    // here makes sure no future refactor can regress the shape.
    if (Array.isArray(payload.patients) || typeof payload.patients !== 'object' || payload.patients === null) {
      console.error('[E-ZONE] payload.patients wrong shape, regrouping', payload.patients);
      payload.patients = serializePatients();
    }

    // Log the ACTUAL body leaving the browser, not the internal state.
    // JSON.stringify guarantees what the network sees.
    console.log('[E-ZONE] saveAll sending payload:', JSON.stringify({
      action: payload.action,
      leadCount: payload.leads.length,
      patientCount,
      patientsShape: Array.isArray(payload.patients) ? 'ARRAY (BUG!)' : 'object',
      patientsKeys: Object.keys(payload.patients),
      patientsByHouse: Object.fromEntries(Object.entries(payload.patients).map(([k, v]) => [k, Array.isArray(v) ? v.length : '(not array)'])),
    }));
    console.log('[E-ZONE] saveAll body preview (first 400 chars):', JSON.stringify(payload).slice(0, 400));

    const res = await apiPost(payload);
    // Fresh stamps, landed moves, refused moves — applied BEFORE any resync
    // so a later queued save never re-sends a refused move without intent.
    applySaveOutcome(sent, res);
    const skippedMsg = promoteSkippedMessage(res);
    if (skippedMsg) showError(skippedMsg, REFUSAL_BANNER_MS);
    // Stale-save refusal: tell the user whose edit won; the resync below
    // reloads the sheet's version. Never retried automatically.
    const conflictMsg = conflictsMessage(res);
    if (conflictMsg) showError(conflictMsg, REFUSAL_BANNER_MS);
    // The resync reloads only once every save has drained (R1).
    if (saveAllResponseNeedsResync(res)) whenSavesDrain(() => maybeResyncPreservedPatients(res));
    return res;
  };
  // endSave runs however run ends — a throw before the POST included.
  const run = () => Promise.resolve().then(work).finally(() => endSave([_dataGuard]));
  // Counted (and noted on the data guard) from the moment it is QUEUED: the
  // edit it carries already lives in state, so a getData read that started
  // before this point must never replace it (CHANGELOG-write-path-hardening.md).
  beginSave([_dataGuard]);
  savePromise = savePromise.then(run, run);
  return savePromise;
}

/* A refusal (something the user did was NOT saved) stays on screen long
 * enough to be read on a phone; ordinary errors keep the 6 s banner. */
const REFUSAL_BANNER_MS = 15000;

function showError(msg, ms) {
  const el = document.getElementById('error-banner');
  el.textContent = 'שגיאה: ' + msg;
  el.classList.remove('hidden');
  // One timer: an older banner's timeout must not hide a newer message early.
  clearTimeout(showError._t);
  showError._t = setTimeout(() => el.classList.add('hidden'), ms || 6000);
}
/* ===== The page-level busy banner (#loading-banner) =====
 *
 * setLoading(on) — «טוען נתונים…», a whole-page READ. Unchanged in meaning;
 *                  it is only reference-counted now (see below).
 * setSaving(on)  — «שומר נתונים…», for the four OPTIMISTIC writes whose
 *                  trigger is detached before the browser can paint a busy
 *                  state on it.
 *
 * WHY setSaving EXISTS, given busyButton is the pattern everywhere else.
 * moveLead, deletePatient, saveBillingOverride and clearBillingOverride each
 * call renderAll()/renderBilling() BEFORE they await. busyButton sets its class
 * synchronously but runs `fn` on a microtask, so class-set → worker entered →
 * node detached all complete inside ONE task, with no paint in between: the
 * busy state on those four triggers never reaches a frame. That is the same
 * failure #130 diagnosed for the renew button, where the fix was to move the
 * indicator onto a control the re-render cannot touch.
 *
 * Measured, not assumed: test/optimistic-gap-browser.test.js drives the real
 * app in Chromium, samples every animation frame for the whole round-trip, and
 * fails if a trigger's feedback paints in zero of them. Against the code before
 * this change all four painted 0/~90 frames, while a modal button (which no
 * list re-render touches) painted 43/43.
 *
 * #loading-banner is that untouchable control: it is a fixed element outside
 * every re-rendered region, it already exists, and it already carries the
 * .loading-banner style — so this adds no second indicator and no CSS.
 *
 * REFERENCE-COUNTED, both of them. loadAll awaits getPayments and getCredits
 * inside its own banner and reloadCredits can run while another read is in
 * flight, so a plain boolean lets an inner operation's `false` hide the banner
 * while the outer one is still working. The counters floor at zero, so a stray
 * unwind is inert rather than corrupting. A read outranks a write when both are
 * up: a reload replaces everything on screen, which is the bigger news. */
const BANNER_LOADING = 'טוען נתונים…';
const BANNER_SAVING  = 'שומר נתונים…';
let _loadingCount = 0;
let _savingCount  = 0;

function syncBusyBanner() {
  const el = document.getElementById('loading-banner');
  if (!el) return;
  const msg = _loadingCount > 0 ? BANNER_LOADING
            : _savingCount  > 0 ? BANNER_SAVING
            : '';
  if (msg) el.textContent = msg;
  el.classList.toggle('hidden', !msg);
}

function setLoading(on) {
  _loadingCount = on ? _loadingCount + 1 : Math.max(0, _loadingCount - 1);
  syncBusyBanner();
}

function setSaving(on) {
  _savingCount = on ? _savingCount + 1 : Math.max(0, _savingCount - 1);
  syncBusyBanner();
}

/* ===== PIN / session =====
 *
 * Auth is a server-signed HttpOnly cookie minted by POST /api/verify-pin. There
 * is no client-trusted "logged in" flag: on load we reveal the app shell and
 * attempt the initial data load; the cookie rides the fetch automatically. If it
 * is missing or expired the server answers 401 and apiGet flips to the PIN
 * screen (see apiGet/apiPost). A correct PIN sets the cookie and re-enters.
 * Single mode — being authenticated means edit access; viewer mode was removed. */

/* Reveal the login overlay and hide the app. Called at startup only implicitly
 * (via a 401) and whenever a session expires mid-use — including a personal
 * session whose PIN was reset (pinVersion++) or revoked: the server answers
 * 401 and this brings the person back to step 1 / 2. Clears every PIN field. */
function showPinScreen() {
  const pin = document.getElementById('pin-screen');
  const app = document.getElementById('app');
  if (pin) pin.classList.remove('hidden');
  if (app) app.classList.add('hidden');
  const personal = document.getElementById('login-pin-input');
  if (personal) personal.value = '';
  loadLoginOptions().catch(() => { showLoginStep('name'); });
}

/* ===== Personal-PIN login (PR B) =====
 *
 * Step 1: tap your name — GET /api/login-users lists ONLY users with an
 * ACTIVE personal-PIN record. Step 2: the 6-digit PIN → POST /api/verify-pin
 * { userId, pin }. The last chosen name is remembered per device
 * (localStorage, wrapped: the login works without it). The shared APP_PIN
 * field, its name picker and its banner were removed in PR C. The PIN lives
 * only in the input and the one request body — never stored, never logged. */
const LOGIN_REMEMBER_KEY = 'ezone.lastLoginUser';
let _loginUsers = [];
let _loginChosen = null;

function rememberLoginUser(id) {
  try { localStorage.setItem(LOGIN_REMEMBER_KEY, String(id || '')); } catch (_) { /* private mode: fine */ }
}
function rememberedLoginUser() {
  try { return String(localStorage.getItem(LOGIN_REMEMBER_KEY) || ''); } catch (_) { return ''; }
}

/* The Hebrew message for a failed login response. Pure. */
function loginErrorMessage(status, error) {
  if (status === 429 && error === 'locked') return 'נעול ל־15 דקות — יותר מדי ניסיונות שגויים';
  if (status === 429) return 'יותר מדי ניסיונות — נסו שוב בעוד כמה דקות';
  if (status === 503 || error === 'not_configured') return 'הכניסה עוד לא הוגדרה בשרת — פנו לסנדרה';
  if (status === 401) return 'קוד שגוי';
  return 'הכניסה נכשלה — נסו שוב';
}

/* Step-1 buttons as HTML. Every name goes through escapeHtml (the names come
 * from the server's fixed model, but nothing reaches innerHTML unescaped). */
function loginNamesHtml(users) {
  return (Array.isArray(users) ? users : []).map(u =>
    '<button type="button" class="btn primary user-option" data-user-id="' + escapeHtml(u && u.id) + '">' +
    escapeHtml(u && u.name) + '</button>').join('');
}

function showLoginStep(step) {
  ['name', 'pin'].forEach(k => {
    const el = document.getElementById('login-step-' + k);
    if (el) el.classList.toggle('hidden', k !== step);
  });
  const f = step === 'pin' && document.getElementById('login-pin-input');
  if (f) { try { f.focus(); } catch (_) { /* no-op */ } }
}

/* Fetch the name list, then render step 1 (or jump straight to step 2 for
 * the name this device chose last time). */
async function loadLoginOptions() {
  const res = await fetch('/api/login-users');
  const data = res && res.ok ? await res.json() : null;
  _loginUsers = data && Array.isArray(data.users) ? data.users : [];
  renderLoginNames();
  const last = rememberedLoginUser();
  const hit = _loginUsers.find(u => u.id === last);
  if (hit) chooseLoginUser(hit);
  else showLoginStep('name');
}

function renderLoginNames() {
  const box = document.getElementById('login-names');
  const empty = document.getElementById('login-names-empty');
  if (!box) return;
  box.innerHTML = loginNamesHtml(_loginUsers);
  if (empty) empty.classList.toggle('hidden', _loginUsers.length > 0);
  const buttons = box.querySelectorAll ? box.querySelectorAll('button[data-user-id]') : [];
  Array.prototype.forEach.call(buttons, btn => {
    btn.onclick = () => {
      const u = _loginUsers.find(x => x.id === btn.getAttribute('data-user-id'));
      if (u) chooseLoginUser(u);
    };
  });
}

function chooseLoginUser(u) {
  _loginChosen = u;
  const nameEl = document.getElementById('login-chosen-name');
  if (nameEl) nameEl.textContent = u.name;
  const err = document.getElementById('login-error');
  if (err) err.classList.add('hidden');
  const input = document.getElementById('login-pin-input');
  if (input) input.value = '';
  showLoginStep('pin');
}

function tryPersonalLogin() {
  const btn = document.getElementById('login-pin-submit');
  return busyButton(btn, 'load', tryPersonalLoginWorker);
}

async function tryPersonalLoginWorker() {
  const input = document.getElementById('login-pin-input');
  const errEl = document.getElementById('login-error');
  errEl.classList.add('hidden');
  if (!_loginChosen) { showLoginStep('name'); return; }
  const userId = _loginChosen.id;
  try {
    const res = await fetch('/api/verify-pin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: userId, pin: input.value }),
    });
    input.value = '';
    if (res.ok) {
      rememberLoginUser(userId);
      // Apply the view BEFORE the app is revealed, so a restricted session
      // never paints a money tab (restricted view).
      const info = await fetchSessionInfo();
      if (info && info.user) { applySessionInfo(info); _sessionUserChecked = true; }
      else _sessionUserChecked = false; // re-read /api/me inside enterApp
      enterApp();
      return;
    }
    const data = await res.json().catch(() => ({}));
    errEl.textContent = loginErrorMessage(res.status, data && data.error);
    errEl.classList.remove('hidden');
  } catch (_) {
    input.value = '';
    errEl.textContent = loginErrorMessage(0, '');
    errEl.classList.remove('hidden');
  }
}

/* The header state for a verified session (/api/me). «קוד אישי חדש» shows
 * only for Sandra's approver session; delete / void / cancel controls only
 * for a deleter; un-void and the other approver controls only for Sandra —
 * the server re-checks every one (403 otherwise). */
function applySessionInfo(info) {
  const i = info || {};
  state.sessionAuth = String(i.auth || '');
  const roleChanged = state.deleter !== (i.deleter === true) || state.approver !== (i.approver === true);
  state.deleter = i.deleter === true;
  state.approver = i.approver === true;
  const confirmChanged = state.canConfirm !== (i.canConfirm === true);
  state.canConfirm = i.canConfirm === true;
  renderWhoami(i.user || '');
  const adminBtn = document.getElementById('pin-admin-open');
  if (adminBtn) adminBtn.classList.toggle('hidden', i.approver !== true);
  applyRoleView();
  // «בקרת גבייה» (Phase 4): Ortal's controller session sees that tab — and,
  // since CHANGELOG-ortal-verification-status.md, «גבייה» read-only when the
  // server says billingRead.
  if (i.view === 'controller') {
    const readChanged = state.billingRead !== (i.billingRead === true);
    state.billingRead = i.billingRead === true;
    applyControllerView();
    if (readChanged && state.billingRead) loadBillingRead().catch(() => { /* shown in the tab */ });
    return;
  }
  if (_controllerApplied) { location.reload(); return; }
  // The tab itself: only an explicit false removes it (Shiran, Yael).
  applyBillingControlCap(i.billingControl !== false && i.finance !== false);
  // Restricted only on an explicit false (the server always sends a
  // boolean); an /api/me without the field keeps the full view as before.
  applyView(i.finance !== false);
  if (confirmChanged && state.currentScreen === 'billing-control') renderBillingControl();
  // A render that ran before /api/me answered drew no role-gated control;
  // redraw once the roles (and the view) are known.
  if (roleChanged && typeof renderAll === 'function') { try { renderAll(); } catch (_) { /* no-op */ } }
}

function revealApp() {
  document.getElementById('pin-screen').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');
}

/* ===== The session (/api/me) =====
 *
 * Every session is personal: the name rides inside the signed cookie for its
 * whole lifetime (7 days) and the server stamps updatedBy from it. Switching
 * (החלף) = logout → the login screen. The shared APP_PIN name picker was
 * removed in PR C. */

/* The session's user name via /api/me: '' when the cookie carries none,
 * null when the answer is not a clean 200 (unauthenticated / network) —
 * callers must not block entry on null. */
async function fetchSessionUser() {
  const info = await fetchSessionInfo();
  return info === null ? null : info.user;
}

/* The whole /api/me answer ({ user, auth, approver, deleter, finance }, user
 * always a string), or null when it is not a clean 200. */
async function fetchSessionInfo() {
  try {
    const res = await fetch('/api/me');
    if (!res.ok) return null;
    const data = await res.json();
    return Object.assign({}, data, { user: typeof data.user === 'string' ? data.user : '' });
  } catch (_) {
    return null;
  }
}

/* Header line 'מחובר/ת כ: <name> · החלף'. Hidden when the session has no
 * name. החלף goes through logout → the login screen. */
function renderWhoami(name) {
  /* Remembered so canReverseVoid() can decide whether to OFFER the un-void
   * control. It is never the authority — upsertPayment_() re-checks against
   * the signed session cookie — but a control that always fails is worse than
   * one that is not shown. */
  state.sessionUser = String(name || '');
  const el = document.getElementById('whoami');
  if (!el) return;
  if (!name) {
    el.classList.add('hidden');
    el.textContent = '';
    return;
  }
  el.textContent = '';
  el.appendChild(document.createTextNode('מחובר/ת כ: '));
  const b = document.createElement('b');
  b.textContent = name;
  el.appendChild(b);
  el.appendChild(document.createTextNode(' · '));
  const sw = document.createElement('button');
  sw.className = 'link-btn';
  sw.textContent = 'החלף';
  sw.onclick = () => busyButton(sw, 'load', async () => {
    try { await fetch('/api/logout', { method: 'POST' }); } catch (_) { /* reload anyway */ }
    location.reload();
  });
  el.appendChild(sw);
  el.classList.remove('hidden');
}

/* Startup / existing sessions: a named session renders the header line and
 * the role view. An authenticated /api/me with an EMPTY user cannot happen
 * for a personal session; it is sent to the login screen. null
 * (unauthenticated / network) changes nothing — the normal 401 flow owns
 * those cases. Runs once per page load. */
let _sessionUserChecked = false;
async function checkSessionUser() {
  if (_sessionUserChecked) return;
  _sessionUserChecked = true;
  const info = await fetchSessionInfo();
  if (info === null) return;
  if (info.user === '') {
    showPinScreen();
    return;
  }
  applySessionInfo(info);
}

/* Startup: wire the PIN form + logout + tabs once, then attempt the authorized
 * initial load. No stored-flag trust — the cookie is the only source of truth. */
function initPin() {
  const pInput = document.getElementById('login-pin-input');
  const pSubmit = document.getElementById('login-pin-submit');
  if (pSubmit) pSubmit.onclick = tryPersonalLogin;
  if (pInput) pInput.addEventListener('keydown', e => { if (e.key === 'Enter') tryPersonalLogin(); });
  const back = document.getElementById('login-back');
  if (back) back.onclick = () => { _loginChosen = null; rememberLoginUser(''); showLoginStep('name'); };
  initPinAdmin();

  const logoutBtn = document.getElementById('logout');
  if (logoutBtn) logoutBtn.onclick = () => busyButton(logoutBtn, 'load', async () => {
    try { await fetch('/api/logout', { method: 'POST' }); } catch (_) { /* reload anyway */ }
    location.reload();
  });

  initTabs();
  initPayoutForecastControls();
  initDebtAgingControls();
  initFunderControls();
  initBillingControlControls();
  // «בקרת גבייה» (Phase 4): the server served <body class="view-controller">
  // to Ortal's session — every other tab goes BEFORE the first load, and
  // loadAll never asks for getData.
  if (document.body && document.body.classList && document.body.classList.contains('view-controller')) applyControllerView();
  // Restricted view: the server served <body class="view-restricted"> to a
  // session without `finance`, so the view is known BEFORE the first load —
  // the money tabs go now and loadAll never asks for getPayments / getCredits.
  if (document.body && document.body.classList && document.body.classList.contains('view-restricted')) applyView(false);
  enterApp();
}

function enterApp() {
  // single mode: an authenticated user is an editor — except the controller
  // view (Ortal), which only READS «גבייה» (CHANGELOG-ortal-verification-status.md):
  // 'view' leaves out every edit / report / void control the tab draws.
  state.mode = controllerView() ? 'view' : 'edit';
  revealApp();
  loadAll();             // getData rides the cookie; a 401 flips to the PIN screen
  checkSessionUser();    // fire-and-forget: whoami line + the role view
}

/* ===== «קוד אישי חדש» — Sandra only (PR B) =====
 *
 * Shown only for Sandra's personal approver session (the button stays hidden
 * otherwise, and the server answers 403 to anyone else). Picks a user, takes
 * the new PIN twice, and shows the ONE record line the server returns, with
 * a «העתקה» button and the steps for Railway. The page saves nothing: the
 * PIN fields are cleared as soon as the request is sent. */
const PIN_ADMIN_ERRORS = {
  weak_pin: 'קוד חלש — לא 000000, לא 123456, לא ספרה אחת שחוזרת ולא רצף עולה או יורד',
  pin_mismatch: 'שני הקודים לא זהים',
  unknown_user: 'משתמש לא מוכר',
  forbidden: 'רק סנדרה, בכניסה עם הקוד האישי שלה, יכולה ליצור קוד אישי',
  rate_limited: 'יותר מדי ניסיונות — נסו שוב בעוד כמה דקות',
  not_configured: 'PIN_PEPPER לא מוגדר ב-Railway',
};

function pinAdminErrorMessage(status, error) {
  if (PIN_ADMIN_ERRORS[error]) return PIN_ADMIN_ERRORS[error];
  if (status === 403) return PIN_ADMIN_ERRORS.forbidden;
  if (status === 401) return 'נדרשת התחברות מחדש';
  return 'היצירה נכשלה — נסו שוב';
}

/* The option label for one user. Sandra appears only as a reset of her own
 * code. Pure. */
function pinAdminOptionLabel(u) {
  if (u.id === 'sandra') return u.name + ' — איפוס הקוד שלי';
  if (!u.hasRecord) return u.name + ' (חדש)';
  return u.name + (u.status === 'revoked' ? ' (מבוטל — איפוס מחזיר אותו)' : ' (איפוס)');
}

/* The Railway steps for the line just made. Pure: returns plain strings. */
function pinAdminSteps(name, reset) {
  return [
    'לוחצים «העתקה».',
    'Railway ← השירות של הדשבורד ← Variables ← USER_PIN_HASHES ← עריכה.',
    reset
      ? 'מוחקים את הרשומה הקיימת של ' + name + ' (מ־{"id" ועד ה־} שלה) ומדביקים במקומה את השורה החדשה.'
      : 'מוסיפים פסיק אחרי הרשומה האחרונה ומדביקים את השורה לפני הסוגר ].',
    'שומרים. Railway עולה מחדש. אם העלייה נכשלת — ההדבקה שבורה (פסיק או סוגר חסרים); מתקנים ושומרים שוב.',
    reset
      ? 'אחרי העלייה הקוד הישן של ' + name + ' מפסיק לעבוד, וכל מכשיר שמחובר בשמו/ה מתנתק.'
      : 'מוסרים את הקוד ל־' + name + ' פנים אל פנים או בשיחת טלפון — לא בוואטסאפ ולא במייל.',
  ];
}

let _pinAdminUsers = [];

function initPinAdmin() {
  const open = document.getElementById('pin-admin-open');
  if (open) open.onclick = () => busyButton(open, 'load', openPinAdmin)
    .catch(() => showError('הטעינה נכשלה — נסו שוב'));
  const close = document.getElementById('pin-admin-close');
  if (close) close.onclick = closePinAdmin;
  const make = document.getElementById('pin-admin-make');
  if (make) make.onclick = () => busyButton(make, 'save', makePinAdminRecord)
    .catch(() => pinAdminShowError(pinAdminErrorMessage(0, '')));
  const copy = document.getElementById('pin-admin-copy');
  if (copy) copy.onclick = copyPinAdminLine;
}

function pinAdminShowError(msg) {
  const el = document.getElementById('pin-admin-error');
  if (!el) return;
  el.textContent = msg || '';
  el.classList.toggle('hidden', !msg);
}

async function openPinAdmin() {
  const screen = document.getElementById('pin-admin-screen');
  pinAdminShowError('');
  document.getElementById('pin-admin-result').classList.add('hidden');
  document.getElementById('pin-admin-line').value = '';
  const res = await fetch('/api/pin-admin/users');
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    if (res.status === 401) { showPinScreen(); return; }
    showError(pinAdminErrorMessage(res.status, data.error));
    return;
  }
  _pinAdminUsers = (data.users || []).filter(u => u.id !== 'sandra' || u.hasRecord);
  const sel = document.getElementById('pin-admin-user');
  sel.textContent = '';
  _pinAdminUsers.forEach(u => {
    const o = document.createElement('option');
    o.value = u.id;
    o.textContent = pinAdminOptionLabel(u);
    sel.appendChild(o);
  });
  const first = _pinAdminUsers.find(u => !u.hasRecord) || _pinAdminUsers[0];
  if (first) sel.value = first.id;
  screen.classList.remove('hidden');
}

function closePinAdmin() {
  ['pin-admin-pin', 'pin-admin-pin2'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  const line = document.getElementById('pin-admin-line');
  if (line) line.value = '';
  const screen = document.getElementById('pin-admin-screen');
  if (screen) screen.classList.add('hidden');
}

async function makePinAdminRecord() {
  pinAdminShowError('');
  const sel = document.getElementById('pin-admin-user');
  const a = document.getElementById('pin-admin-pin');
  const b = document.getElementById('pin-admin-pin2');
  const user = _pinAdminUsers.find(u => u.id === sel.value);
  const body = JSON.stringify({ userId: sel.value, pin: a.value, pin2: b.value });
  a.value = '';
  b.value = '';
  const res = await fetch('/api/pin-admin/record', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) { closePinAdmin(); showPinScreen(); return; }
  if (!res.ok || !data.ok || typeof data.record !== 'string') {
    pinAdminShowError(pinAdminErrorMessage(res.status, data.error));
    return;
  }
  document.getElementById('pin-admin-line').value = data.record;
  const steps = document.getElementById('pin-admin-steps');
  steps.textContent = '';
  pinAdminSteps(user ? user.name : '', !!(user && user.hasRecord)).forEach(t => {
    const li = document.createElement('li');
    li.textContent = t;
    steps.appendChild(li);
  });
  document.getElementById('pin-admin-result').classList.remove('hidden');
}

async function copyPinAdminLine() {
  const line = document.getElementById('pin-admin-line');
  if (!line || !line.value) return;
  try {
    await navigator.clipboard.writeText(line.value);
    showToast('השורה הועתקה');
  } catch (_) {
    try { line.select(); document.execCommand('copy'); showToast('השורה הועתקה'); }
    catch (__) { showError('ההעתקה נכשלה — סמנו את השורה והעתיקו ידנית'); }
  }
}

/* ===== Top tabs ===== */
/* Tab / screen order. Mirrors the .tabs nav in index.html exactly (each id has a
 * matching <section id="screen-<id>">). `meetings` is an empty placeholder shell
 * (see index.html #screen-meetings); `retention` is intentionally last. */
const SCREENS = ['dashboard', 'leads', 'patients', 'meetings', 'occupancy', 'discharged-patients', 'billing', 'billing-control', 'revenue', 'reconnect', 'breakeven', 'growth', 'retention'];

/* ===== Restricted view (Sandra, 2026-10-03) =====
 *
 * Shiran and Yael (no `finance` capability) see every tab EXCEPT these four,
 * and no billing widget elsewhere. Their tab buttons and screens are removed
 * from the DOM (not just hidden), every billing render is a no-op, and a deep
 * link (#billing) or a current tab pointing at one of them falls back to the
 * first allowed tab. Display only: server.js answers 403 for the data. */
const FINANCE_SCREENS = ['billing', 'revenue', 'reconnect', 'growth'];

/* false only once /api/me said this session is restricted. Unknown (null)
 * renders as before (a restricted page load is already hidden by the
 * server-served body.view-restricted). */
function financeView() {
  return state.finance !== false;
}

/* «בקרת גבייה» (Phase 4): the tab Vered, Sandra and Ortal see; for Ortal
 * (the controller view) it is the ONLY screen. */
const BILLING_CONTROL_SCREEN = 'billing-control';

/* «גבייה» read-only for the controller view (Ortal) when the server allows
 * it (/api/me billingRead, or <body class="view-billing-read">). */
const BILLING_SCREEN = 'billing';

/* The screens a session may open, in tab order. Pure.
 *   view 'controller' → «בקרת גבייה» (first) and, with billingRead, «גבייה»;
 *   finance false     → no money tab and no «בקרת גבייה». */
function allowedScreens(finance, view, billingRead) {
  if (view === 'controller') return billingRead === true ? [BILLING_CONTROL_SCREEN, BILLING_SCREEN] : [BILLING_CONTROL_SCREEN];
  return SCREENS.filter(s => finance !== false || (FINANCE_SCREENS.indexOf(s) < 0 && s !== BILLING_CONTROL_SCREEN));
}

/* `requested` when it is a screen the session may open, else the first
 * allowed one (the dashboard). Pure. */
function resolveScreen(requested, finance, view, billingRead) {
  const allowed = allowedScreens(finance, view, billingRead);
  return allowed.indexOf(requested) >= 0 ? requested : allowed[0];
}

/* true once the session is known to be the controller view (Ortal). */
function controllerView() {
  return state.view === 'controller';
}

/* true for the controller view with read access to «גבייה». */
function billingReadView() {
  return controllerView() && state.billingRead === true;
}

/* Whether the «גבייה» screen renders: the finance view, or Ortal's read-only
 * view. Every write control in it also needs state.mode === 'edit', which
 * the controller view never is. */
function billingTabView() {
  return financeView() || billingReadView();
}

let _controllerApplied = false;
let _billingControlRemoved = false;

/* Remove the «בקרת גבייה» tab (and its screen) for a session without the
 * capability (Shiran, Yael). Display only — the server answers 403. */
function applyBillingControlCap(allowed) {
  state.billingControl = allowed === true;
  if (allowed === true) {
    if (_billingControlRemoved) location.reload();
    return;
  }
  const nodes = document.querySelectorAll('[data-billing-control]');
  Array.prototype.forEach.call(nodes, el => { if (el && el.remove) el.remove(); });
  _billingControlRemoved = true;
}

/* The controller view (Ortal): every tab button and every screen except
 * «בקרת גבייה» is REMOVED from the DOM (not just hidden), together with every
 * billing widget; the data already in memory is dropped; the tab opens. The
 * server refuses every other action and route (403) either way. Idempotent. */
function applyControllerView() {
  const first = state.view !== 'controller';
  state.view = 'controller';
  state.finance = false;
  state.billingControl = true;
  state.mode = 'view';
  if (document.body && document.body.classList) {
    document.body.classList.add('view-controller');
    document.body.classList.remove('view-restricted');
    // Served by the server for Ortal's billingRead session; /api/me decides after.
    if (state.billingRead === undefined) state.billingRead = document.body.classList.contains('view-billing-read');
    document.body.classList.toggle('view-billing-read', state.billingRead === true);
  }
  const read = state.billingRead === true;
  // A page drawn without «גבייה» (served before billingRead) gets it back by
  // a reload — the server then serves <body class="view-billing-read">.
  if (!first && read && !document.getElementById('screen-' + BILLING_SCREEN)) { location.reload(); return; }
  const screens = allowedScreens(false, 'controller', read);
  const keepScreen = name => screens.indexOf(name) >= 0;
  // The «גבייה» screen keeps its own [data-finance] children (read-only).
  const inKeptScreen = el => !!(el && el.closest && screens.some(n => el.closest('#screen-' + n)));
  const keep = el => el && (keepScreen(el.getAttribute('data-screen')) || keepScreen(String(el.id || '').replace(/^screen-/, '')) || inKeptScreen(el));
  const drop = el => { if (el && el.remove && !keep(el)) el.remove(); };
  Array.prototype.forEach.call(document.querySelectorAll('.tabs .tab'), drop);
  Array.prototype.forEach.call(document.querySelectorAll('section.screen'), drop);
  Array.prototype.forEach.call(document.querySelectorAll('[data-finance]'), drop);
  // «השלמת גורם מממן» is data entry — never in the read-only view.
  const ff = document.getElementById('funder-fill');
  if (ff && ff.remove) ff.remove();
  _controllerApplied = true;
  _financeRemoved = true;
  if (first) {
    state.leads = [];
    state.patients = [];
    state.payments = [];
    state.credits = [];
    state.billingOverrides = [];
    state.receipts = [];
    state.funders = [];
  }
  if (first || !keepScreen(state.currentScreen)) showScreen(BILLING_CONTROL_SCREEN);
  renderBillingControl();
}

/* The screen named by a deep link (#billing, #screen-billing), or ''. */
function screenFromHash(hash) {
  const h = String(hash || '').replace(/^#/, '').replace(/^screen-/, '');
  return SCREENS.indexOf(h) >= 0 ? h : '';
}

/* Show exactly one screen and mark its tab active. Missing elements (a
 * removed finance screen) are skipped. */
function showScreen(name) {
  state.currentScreen = name;
  document.querySelectorAll('.tabs .tab').forEach(b => b.classList.toggle('active', b.dataset.screen === name));
  SCREENS.forEach(s => {
    const el = document.getElementById('screen-' + s);
    if (el) el.classList.toggle('hidden', s !== name);
  });
}

let _financeRemoved = false;

/* Apply the session's view. finance === true → reveal the money tabs.
 * Otherwise remove every [data-finance] element from the DOM, drop any
 * billing data already in memory, and move off a finance screen. A later
 * full-view login on the same page reloads to get the tabs back. */
function applyView(finance) {
  if (controllerView()) return; // the controller view is final for this page
  const full = finance === true;
  if (full && _financeRemoved) { location.reload(); return; }
  state.finance = full;
  if (!state.view) state.view = full ? 'full' : 'restricted';
  if (document.body && document.body.classList) document.body.classList.toggle('view-restricted', !full);
  if (!full) {
    const nodes = document.querySelectorAll('[data-finance]');
    Array.prototype.forEach.call(nodes, el => { if (el && el.remove) el.remove(); });
    _financeRemoved = true;
    applyBillingControlCap(false);
    state.payments = [];
    state.credits = [];
    state.billingOverrides = [];
    state.receipts = [];
    state.funders = [];
  }
  const want = screenFromHash(location.hash) || state.currentScreen;
  const target = resolveScreen(want, full, state.view);
  if (target !== state.currentScreen || want !== state.currentScreen) {
    showScreen(target);
    renderAll();
    // The digest's «ממתינים לאימות» link opens #billing-control directly.
    if (target === BILLING_CONTROL_SCREEN && full) loadBillingControl().catch(() => { /* shown in the tab */ });
  }
}

function initTabs() {
  document.querySelectorAll('.tabs .tab').forEach(btn => {
    btn.onclick = () => {
      showScreen(resolveScreen(btn.dataset.screen, state.finance, state.view, state.billingRead === true));
      renderAll();
      if (state.currentScreen === BILLING_CONTROL_SCREEN) loadBillingControl().catch(() => { /* shown in the tab */ });
    };
  });

  document.getElementById('lead-search').addEventListener('input', e => {
    state.leadSearch = String(e.target.value || '').trim().toLowerCase();
    renderKanban();
  });
  initPatientsTabFilters();
  document.getElementById('patient-search').oninput = e => {
    state.patientSearch = e.target.value.trim().toLowerCase();
    renderPatients();
  };
  /* הצג משוחררים — session-only display toggle (state, never localStorage). */
  const showReleasedEl = document.getElementById('show-released-toggle');
  if (showReleasedEl) {
    showReleasedEl.onchange = e => {
      state.showReleasedPatients = !!e.target.checked;
      renderPatients();
    };
  }
  /* שימור לידים tab search — same immediate-on-input behavior as the leads tab;
   * filters the closed-lead disposition groups (see renderIrrelevantLeads). */
  const retentionSearchEl = document.getElementById('retention-search');
  if (retentionSearchEl) {
    retentionSearchEl.addEventListener('input', e => {
      state.retentionSearch = String(e.target.value || '').trim().toLowerCase();
      renderIrrelevantLeads();
    });
  }
  /* מטופלים משוחררים tab search — same immediate-on-input behavior as the
   * other tabs; filters the audit rows by name / phone / house label. */
  const dischargedSearchEl = document.getElementById('discharged-search');
  if (dischargedSearchEl) {
    dischargedSearchEl.addEventListener('input', e => {
      state.dischargedSearch = String(e.target.value || '').trim().toLowerCase();
      renderDischargedPatients();
    });
  }
  /* גבייה tab search — same immediate-on-input behavior as the other tabs;
   * filters both billing lists (due + carry-forward) by name / phone / house.
   * The KPI cards recompute from the filtered due list (renderBilling). */
  const billingSearchEl = document.getElementById('billing-search');
  if (billingSearchEl) {
    billingSearchEl.addEventListener('input', e => {
      state.billingSearch = String(e.target.value || '').trim().toLowerCase();
      renderBilling();
    });
  }
  document.getElementById('add-lead-btn').onclick = openAddLeadModal;
  document.getElementById('add-patient-btn').onclick = () => openDirectAddPatientModal();
  /* «🟢 קליטת מטופל חדש» — the top-level intake entry on the dashboard. Same
   * direct-add flow, intake mode (see openDirectAddPatientModal). */
  const intakeBtn = document.getElementById('intake-patient-btn');
  if (intakeBtn) intakeBtn.onclick = () => openDirectAddPatientModal({ intake: true });

  /* Overdue strip (dashboard) → navigate to the גבייה tab. Invoking the tab
   * button's own onclick runs the exact switch logic wired above (active
   * class, screen toggle, renderAll). */
  const overdueStrip = document.getElementById('overdue-alert');
  if (overdueStrip) {
    overdueStrip.onclick = () => {
      const billingTab = document.querySelector('.tabs .tab[data-screen="billing"]');
      if (billingTab && typeof billingTab.onclick === 'function') billingTab.onclick();
      else if (billingTab && billingTab.click) billingTab.click();
    };
  }

  const billingDateEl = document.getElementById('billing-date');
  if (!state.billingDate) state.billingDate = todayISO();
  billingDateEl.value = state.billingDate;
  billingDateEl.onchange = e => {
    state.billingDate = e.target.value || todayISO();
    renderBilling();
  };

  /* הכנסות חודשיות — month picker + search. Separate state from the daily
   * גבייה screen, so the two never move each other. */
  const revenueMonthEl = document.getElementById('revenue-month');
  if (revenueMonthEl) {
    if (!state.revenueMonth) state.revenueMonth = monthKey(todayISO());
    revenueMonthEl.value = state.revenueMonth;
    revenueMonthEl.onchange = e => {
      state.revenueMonth = e.target.value || monthKey(todayISO());
      renderMonthlyRevenue();
    };
  }
  const revenueSearchEl = document.getElementById('revenue-search');
  if (revenueSearchEl) {
    revenueSearchEl.addEventListener('input', e => {
      state.revenueSearch = String(e.target.value || '').trim().toLowerCase();
      renderMonthlyRevenue();
    });
  }

  initBreakeven();
}

/* ===== Initial load ===== */

/* Stale-tab prevention (merge-don't-drop C2): the app otherwise loads data
 * ONCE per page life, and every save writes full in-memory state — so a PWA
 * resumed from background or a tab refocused hours later saves a snapshot of
 * the past. Reload from the sheet when the tab becomes visible again.
 * Guards: skipped while any save is mid-air (never yank state under a write),
 * and floored at 60s since the last completed load start so quick tab
 * flips don't hammer getData. Every edit in this app persists immediately via
 * saveAll, so in-memory state is never legitimately AHEAD of the sheet
 * outside an in-flight save — reloading loses nothing. */
let _lastLoadAllAt = 0;
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (_savesInFlight > 0) return;
  if (Date.now() - _lastLoadAllAt < 60000) return;
  console.log('[E-ZONE] tab visible again — refreshing from sheet');
  loadAll().catch(e => console.warn('[E-ZONE] visibility resync failed:', e.message));
});

/* Milliseconds for the load timing — performance.now() where the browser has
 * it, Date.now() otherwise. */
function perfNow() {
  return (typeof performance !== 'undefined' && performance && typeof performance.now === 'function')
    ? performance.now() : Date.now();
}

/* Start one read now and settle it into { ok, value | error, ms } — it never
 * rejects, so a read nobody has awaited yet can't become an unhandled
 * rejection, and `ms` is that request's own round trip. */
function startTimedRead(params) {
  const t0 = perfNow();
  return apiGet(params).then(
    value => ({ ok: true, value, ms: Math.round(perfNow() - t0) }),
    error => ({ ok: false, error, ms: Math.round(perfNow() - t0) })
  );
}

/* The controller view's «גבייה» data (CHANGELOG-ortal-verification-status.md):
 * getData (the server cuts it to patients + billingOverrides), getPayments
 * and getCredits — the same normalizers as loadAll. Fail-soft per read, like
 * loadAll; nothing else is loaded. */
async function loadBillingRead() {
  if (!billingReadView()) return;
  const dataTicket = _dataGuard.begin();
  const paymentsTicket = beginPaymentsRead();
  const creditsTicket = _creditsGuard.begin();
  const [d, p, c] = await Promise.all([
    startTimedRead({ action: 'getData' }), startTimedRead({ action: 'getPayments' }), startTimedRead({ action: 'getCredits' }),
  ]);
  // R1: applied only if no write was queued or landed since the read started.
  if (d.ok && d.value && typeof d.value === 'object') {
    const patients = parsePatients(d.value.patients);
    const overrides = (Array.isArray(d.value.billingOverrides) ? d.value.billingOverrides : [])
      .map(normalizeBillingOverride).filter(o => o.patientId && o.month);
    if (_dataGuard.isCurrent(dataTicket)) {
      _dataGuard.applied(dataTicket);
      state.patients = patients;
      state.billingOverrides = overrides;
    } else {
      console.warn('[E-ZONE] «גבייה» getData answer discarded — a write landed after it started');
    }
  }
  // The Funders rows ride along: pro-bono cycles are not debt (isProbonoOn).
  // Applied only if no payment write landed since the read started.
  if (p.ok && p.value) applyPaymentsRead(paymentsTicket, p.value);
  else if (!p.ok) showError(PAYMENTS_LOAD_FAILED_HE);
  if (c.ok && c.value) applyCreditsRead(creditsTicket, c.value);
  else if (!c.ok) showError(CREDITS_LOAD_FAILED_HE);   // R2: the list on screen stays
  if (!d.ok) showError('טעינת «גבייה» נכשלה — ' + ((d.error && d.error.message) || 'שגיאה'));
  renderBilling();
  renderCreditsPayouts();
}

async function loadAll() {
  _lastLoadAllAt = Date.now();
  // «בקרת גבייה» (Phase 4): the controller view loads its queue and — with
  // read access to «גבייה» — the tab's reads (loadBillingRead). No lead.
  if (controllerView()) {
    return Promise.all([loadBillingControl(), billingReadView() ? loadBillingRead() : null]).then(() => undefined);
  }
  setLoading(true);
  const t0 = perfNow();
  // The three reads are independent: start them TOGETHER, so the page waits
  // for the slowest one instead of the sum of all three. getPayments and
  // getCredits stay fail-soft exactly as before (see below); a getData
  // failure still fails the whole load. A session without `finance`
  // (restricted view) never asks for the two money reads.
  const finance      = financeView();
  // R1: each read takes its guard's ticket as it STARTS (CHANGELOG-write-path-hardening.md).
  const dataTicket   = _dataGuard.begin();
  const dataRead     = startTimedRead({ action: 'getData' });
  const paymentsTicket = finance ? beginPaymentsRead() : null;
  const paymentsRead = finance ? startTimedRead({ action: 'getPayments' }) : null;
  const creditsTicket = finance ? _creditsGuard.begin() : null;
  const creditsRead  = finance ? startTimedRead({ action: 'getCredits' }) : null;
  const timing = {};
  try {
    const d = await dataRead;
    timing.getData = d.ms;
    if (!d.ok) throw d.error;
    let data = d.value;

    console.log('[E-ZONE] raw response type:', typeof data);
    if (data && typeof data === 'object') {
      console.log('[E-ZONE] raw response keys:', Object.keys(data));
      console.log('[E-ZONE] raw response preview:', JSON.stringify(data).slice(0, 300));
    } else {
      console.log('[E-ZONE] raw response value:', String(data).slice(0, 300));
    }

    // Apps Script sometimes double-encodes (string → JSON-of-JSON); unwrap once.
    if (typeof data === 'string') {
      try { data = JSON.parse(data); console.log('[E-ZONE] unwrapped string response'); }
      catch (_) { /* fall through to shape check */ }
    }

    if (!data || typeof data !== 'object') {
      throw new Error('פורמט תגובה לא תקין מהגיליון — ' + String(data).slice(0, 100));
    }

    // Locate leads / patients. Accept the expected shape first, then fall
    // back to common nestings (data.data, data.result, data.payload).
    let rawLeads = data.leads;
    let rawPatients = data.patients;

    if (!Array.isArray(rawLeads)) {
      for (const key of ['data', 'result', 'payload', 'body']) {
        if (data[key] && typeof data[key] === 'object' && Array.isArray(data[key].leads)) {
          console.log(`[E-ZONE] leads found under data.${key}`);
          rawLeads = data[key].leads;
          rawPatients = data[key].patients;
          break;
        }
      }
    }

    if (!Array.isArray(rawLeads)) {
      console.error('[E-ZONE] leads array not found in response:', data);
      throw new Error(`לא נמצא מערך leads (מפתחות: ${Object.keys(data).join(', ')})`);
    }

    /* R1: a getData answer replaces leads, patients and every list below
     * wholesale. If a write was queued or answered since this read started,
     * or one is still in flight, this answer predates it — discard it (what
     * is on screen is newer) and re-read once the saves drain. */
    const dataFresh = _dataGuard.isCurrent(dataTicket);
    if (!dataFresh) {
      console.warn('[E-ZONE] getData answer discarded — a write was in flight or landed after it started');
      queueDataResync();
    } else {
      _dataGuard.applied(dataTicket);
      state.leads = rawLeads.map(normalizeLead);
      state.patients = parsePatients(rawPatients);

      /* House-manager roster (HOUSE_MANAGERS, exported by getData_). Keyed by
       * house id. Missing/invalid on older deploys → empty object, so the
       * meetingWith dropdown falls back to a blank default with no options and
       * the meetings board still renders (just no manager names). */
      state.houseManagers = (data.houseManagers && typeof data.houseManagers === 'object' && !Array.isArray(data.houseManagers))
        ? data.houseManagers
        : {};
      /* Current managers (additive getData key). When present it is THE roster:
       * the per-house default, the meetingWith dropdown and the summary strip
       * all read state.houseManagers / state.currentManagers. An older backend
       * that does not send it keeps the houseManagers above — no change. */
      state.currentManagers = normalizeCurrentManagers(data.currentManagers);
      if (state.currentManagers) state.houseManagers = rosterFromCurrentManagers(state.currentManagers);
      console.log('[E-ZONE] houseManagers loaded:', Object.keys(state.houseManagers).length, 'houses',
        'source:', data.currentManagersSource || '(houseManagers)');

      /* Manager-name → WhatsApp phone map (MANAGER_PHONES, exported by getData_).
       * Missing/invalid on older deploys → empty object, so the WhatsApp button
       * renders disabled (no phone resolves). */
      state.managerPhones = (data.managerPhones && typeof data.managerPhones === 'object' && !Array.isArray(data.managerPhones))
        ? data.managerPhones
        : {};
      console.log('[E-ZONE] managerPhones loaded:', Object.keys(state.managerPhones).length, 'managers');

      const rawIrrelevant = Array.isArray(data.irrelevantLeads) ? data.irrelevantLeads : [];
      state.irrelevantLeads = rawIrrelevant.map(normalizeIrrelevantLead);
      console.log('[E-ZONE] irrelevantLeads loaded:', state.irrelevantLeads.length);

      const rawRemoved = Array.isArray(data.removedLeads) ? data.removedLeads : [];
      state.removedLeads = rawRemoved.map(normalizeRemovedLead);
      console.log('[E-ZONE] removedLeads loaded:', state.removedLeads.length);

      /* Phase 2e-1 — discharged-patient audit rows. Sheet may not exist yet on
       * older deploys; treat missing array as empty so the rest of the app
       * still loads. */
      const rawDischarged = Array.isArray(data.dischargedPatients) ? data.dischargedPatients : [];
      state.dischargedPatients = rawDischarged.map(normalizeDischargedPatient);
      console.log('[E-ZONE] dischargedPatients loaded:', state.dischargedPatients.length);

      /* Billing overrides (per patient, per month). Sheet may not exist yet on
       * older deploys; treat a missing array as empty so the rest of the app
       * still loads. Foundation phase: state only, nothing renders it. Rows
       * without a patientId+month are dropped (can't key a valid override). */
      const rawOverrides = Array.isArray(data.billingOverrides) ? data.billingOverrides : [];
      state.billingOverrides = rawOverrides
        .map(normalizeBillingOverride)
        .filter(o => o.patientId && o.month);
      console.log('[E-ZONE] billingOverrides loaded:', state.billingOverrides.length);
    } // dataFresh

    // Payments live on their own sheet and their own action. A failed read
    // KEEPS the money state already on screen and says so — it used to
    // wipe it to [] silently, and every row then read «לא שולם»
    // (CHANGELOG-payment-report-persistence.md). The rest of the app still
    // loads either way.
    if (!financeView() || !paymentsRead) {
      state.payments = [];
      state.credits = [];
      state.receipts = [];
      state.funders = [];
    } else try {
      const got = await paymentsRead;
      timing.getPayments = got.ms;
      if (!got.ok) throw got.error;
      /* The cycles carry the money their receipts add up to (the server
       * derives it); the receipts themselves are listed under each cycle.
       * Applied only if no payment write landed since the read started. */
      applyPaymentsRead(paymentsTicket, got.value);
      console.log('[E-ZONE] getPayments →', state.payments.length, 'records,', state.receipts.length, 'receipts');
    } catch (err) {
      console.warn('[E-ZONE] getPayments failed — keeping the money state on screen:', err && err.message);
      if (err && err.message === 'unauthorized') throw err;
      showError(PAYMENTS_LOAD_FAILED_HE + (err && err.message ? ' (' + err.message + ')' : ''));
    }

    // Credits ledger — own sheet, own action (same fail-soft rule as payments:
    // an older backend without getCredits must not block the app).
    if (financeView() && creditsRead) try {
      const got = await creditsRead;
      timing.getCredits = got.ms;
      if (!got.ok) throw got.error;
      // Applied only if no credit write landed since the read started.
      applyCreditsRead(creditsTicket, got.value);
      console.log('[E-ZONE] getCredits →', state.credits.length, 'records');
    } catch (err) {
      // R2: a failed read KEEPS the credits on screen and says so — it used
      // to assume [] silently (CHANGELOG-write-path-hardening.md).
      console.warn('[E-ZONE] getCredits failed — keeping the credits on screen:', err && err.message);
      if (err && err.message === 'unauthorized') throw err;
      showError(CREDITS_LOAD_FAILED_HE + (err && err.message ? ' (' + err.message + ')' : ''));
    }
    timing.fetched = Math.round(perfNow() - t0);

    // ===== Patient-load diagnosis =====
    // Log the exact rawPatients as received from the server, its shape,
    // and what parsePatients produced. Also stash on window so Sandra can
    // inspect it in the DevTools console without re-running anything.
    const rawType = Array.isArray(rawPatients) ? 'array'
                  : rawPatients === null ? 'null'
                  : typeof rawPatients;
    const rawKeys = rawPatients && typeof rawPatients === 'object' && !Array.isArray(rawPatients)
                  ? Object.keys(rawPatients) : null;
    const rawShape = {
      type: rawType,
      length: Array.isArray(rawPatients) ? rawPatients.length : undefined,
      keys: rawKeys,
      byHouse: rawKeys
        ? Object.fromEntries(rawKeys.map(k => {
            const v = rawPatients[k];
            return [k, Array.isArray(v) ? v.length : typeof v];
          }))
        : undefined,
    };
    console.log('[E-ZONE] RAW patients from server — shape:', rawShape);
    console.log('[E-ZONE] RAW patients from server — preview:', JSON.stringify(rawPatients).slice(0, 1000));
    console.log('[E-ZONE] parsePatients() produced', state.patients.length, 'patient(s)');
    if (state.patients[0]) console.log('[E-ZONE] first parsed patient:', state.patients[0]);

    window.__ezoneLastLoad = {
      rawLeads, rawPatients,
      parsedLeads: state.leads,
      parsedPatients: state.patients,
      rawShape,
    };
    console.log('[E-ZONE] full raw payload saved to window.__ezoneLastLoad for inspection');

    if (rawPatients && !Array.isArray(rawPatients) && typeof rawPatients === 'object') {
      const rawTotal = Object.values(rawPatients).reduce(
        (n, v) => n + (Array.isArray(v) ? v.length : 0), 0);
      if (rawTotal > 0 && state.patients.length === 0) {
        console.error('[E-ZONE] BUG: server returned', rawTotal, 'patient rows but parsePatients produced 0');
      }
    }

    console.log('[E-ZONE] after parse — leads:', state.leads.length, 'patients:', state.patients.length);
    if (state.leads[0])    console.log('[E-ZONE] first lead:', state.leads[0]);
    if (state.patients[0]) console.log('[E-ZONE] first patient:', state.patients[0]);

    // A discarded getData answer changed nothing — nothing to promote or heal.
    const promoted = dataFresh ? promoteEnteredLeads() : [];
    const retired  = dataFresh ? retireAdmittedLeads() : [];
    /* Discharge-persistence heal — after promote/retire so a freshly promoted
     * patient is also checked against the audit sheet in the same pass. */
    const healed   = dataFresh ? healClobberedDischarges() : [];
    console.log('[E-ZONE] after promote — leads:', state.leads.length, 'patients:', state.patients.length, '(+', promoted.length, 'promoted,', retired.length, 'retired,', healed.length, 'healed)');
    // The heal moves patients out of the house tab — never silently.
    if (healed.length > 0) showToast(healedToastMessage(healed));
    renderAll();

    if ((promoted.length > 0 || retired.length > 0 || healed.length > 0) && state.mode === 'edit') {
      console.log(`[E-ZONE] Persisting ${promoted.length} auto-promoted patient(s) + ${retired.length} retired lead(s) + ${healed.length} healed discharge(s)...`);
      saveAll().catch(e => {
        console.warn('[E-ZONE] auto-promote save failed', e.message);
        // The promoted / healed rows stay on screen (state is untouched) and
        // ride the next saveAll; the failure is said out loud, never silent.
        showError(isLockBusyError(e) ? LOCK_BUSY_MESSAGE_HE : AUTO_SAVE_FAILED_HE + ((e && e.message) || 'שגיאה'));
      });
    }
  } catch (e) {
    console.error('[E-ZONE] loadAll failed:', e);
    // A 401 already brought up the login screen (apiGet → showPinScreen);
    // an «unauthorized» toast on top of it only lingers after the login.
    if (e && e.message === 'unauthorized') return;
    showError('טעינת נתונים מהגיליון נכשלה — ' + e.message);
  } finally {
    setLoading(false);
    // One line per load, console only: each read's own round trip (they run
    // in parallel, so the wait is the slowest, not the sum), all three
    // fetched, and the whole load including parse + render. Milliseconds only.
    timing.total = Math.round(perfNow() - t0);
    console.log('[E-ZONE][perf] loadAll ' + timing.total + 'ms | ' +
      ['getData', 'getPayments', 'getCredits', 'fetched']
        .filter(k => timing[k] !== undefined)
        .map(k => k + '=' + timing[k])
        .join(' '));
  }
}

/* The meetingOutcome to record when a lead is admitted into a house. A lead
 * that had a meeting (visitDate set) converts to 'entered' — overwriting any
 * earlier outcome (e.g. 'thinking'), because entering treatment is the final
 * word on that meeting. A lead with NO meeting returns null: it must not get an
 * outcome, or a manager's conversion stats would count a meeting that never
 * happened. Pure — unit-tested directly and shared by both admission paths
 * (openEntryModal + promoteEnteredLeads). */
function admissionMeetingOutcome(lead) {
  return (lead && lead.visitDate) ? 'entered' : null;
}

/**
 * For every lead in stage=entry (or 'entered') that doesn't already have a
 * patient record, create one using whatever data we have on the lead.
 * A matching patient is any patient whose fromLead equals the lead id, OR
 * (as a fallback) whose name+house match the lead's name+house.
 */
function promoteEnteredLeads() {
  const created = [];
  if (!Array.isArray(state.leads) || state.leads.length === 0) return created;

  const byFromLead = new Set();
  const byNameHouse = new Set();
  state.patients.forEach(p => {
    if (p.fromLead) byFromLead.add(String(p.fromLead));
    if (p.name && p.houseId) byNameHouse.add(`${p.houseId}::${String(p.name).trim()}`);
  });

  /* Guard 1 (discharge re-promotion fix): a released patient's SOURCE lead can
   * still sit at stage 'entry'/'entered' — dischargePatient never retired it on
   * older records, and if the released patient row was dropped by the
   * whole-house-replace path there is no ACTIVE patient to match either. Without
   * this guard promoteEnteredLeads would re-promote her as a fresh 'trial'
   * patient, so Vered's discharge "doesn't stick". Skip any lead that already
   * has a NON-RESTORED discharged audit row, matched by the SAME two keys as
   * the active-patient match above. restored==='TRUE' rows are intentionally
   * NOT indexed so restore-to-lead still re-promotes. */
  const dischargedByFromLead = new Set();
  const dischargedByNameHouse = new Set();
  (state.dischargedPatients || []).forEach(d => {
    if (!dischargeRowOpen(d)) return;
    if (d.fromLead) dischargedByFromLead.add(String(d.fromLead));
    if (d.name && d.houseId) dischargedByNameHouse.add(`${d.houseId}::${String(d.name).trim()}`);
  });

  state.leads.forEach(lead => {
    const stage = String(lead.stage || '').toLowerCase();
    if (stage !== 'entry' && stage !== 'entered') return;

    if (lead.id && byFromLead.has(String(lead.id))) return;
    if (lead.id && dischargedByFromLead.has(String(lead.id))) return;

    const house = houseByName(lead.house) || houseById(lead.house);
    if (!house) {
      console.warn('[E-ZONE] entered lead has no recognizable house, skipping auto-promote:', lead);
      return;
    }
    const key = `${house.id}::${String(lead.name || '').trim()}`;
    if (byNameHouse.has(key)) return;
    if (dischargedByNameHouse.has(key)) return;

    const patient = normalizePatient({
      id: cryptoId(),
      houseId: house.id,
      name: lead.name,
      date: lead.entryDate || '',
      pay: 0,
      adv: Number(lead.advance) || 0,
      status: 'trial',
      fromLead: lead.id,
    });
    state.patients.push(patient);
    /* Record the conversion on the source lead when it had a meeting, so the
     * per-manager conversion metric captures auto-promoted admissions too. Gated
     * on visitDate (no meeting → no outcome). Persisted by loadAll's post-promote
     * saveAll (edit mode). Mirrors the manual openEntryModal admit. */
    const outcome = admissionMeetingOutcome(lead);
    if (outcome) lead.meetingOutcome = outcome;
    byFromLead.add(String(lead.id));
    byNameHouse.add(key);
    created.push(patient);
  });

  if (created.length > 0) {
    console.log(`[E-ZONE] promoted ${created.length} entered lead(s) to patient records`, created.map(p => p.name));
  }
  return created;
}

/**
 * One-time, idempotent self-heal. Any lead still parked at stage 'entry' /
 * 'entered' that ALREADY has a matching patient is retired to the terminal
 * 'admitted' stage so it leaves promoteEnteredLeads' candidate pool and can no
 * longer re-stamp that patient's (possibly edited) entry date on the next load.
 *
 * Matching mirrors promoteEnteredLeads exactly: by the fromLead link, or by
 * houseId::name. This NEVER creates a patient and NEVER touches a patient's
 * date — it only flips the lead's stage. Once a lead is 'admitted' it no longer
 * matches the entry/entered filter, so re-running this on every load is a no-op.
 *
 * Run after promoteEnteredLeads so freshly auto-promoted leads (which now have a
 * matching patient via fromLead) are retired in the same pass.
 */
function retireAdmittedLeads() {
  const retired = [];
  if (!Array.isArray(state.leads) || state.leads.length === 0) return retired;

  const byFromLead = new Set();
  const byNameHouse = new Set();
  state.patients.forEach(p => {
    if (p.fromLead) byFromLead.add(String(p.fromLead));
    if (p.name && p.houseId) byNameHouse.add(`${p.houseId}::${String(p.name).trim()}`);
  });

  state.leads.forEach(lead => {
    const stage = String(lead.stage || '').toLowerCase();
    if (stage !== 'entry' && stage !== 'entered') return;

    const matchedByFromLead = lead.id && byFromLead.has(String(lead.id));
    const house = houseByName(lead.house) || houseById(lead.house);
    const matchedByNameHouse = house &&
      byNameHouse.has(`${house.id}::${String(lead.name || '').trim()}`);
    if (!matchedByFromLead && !matchedByNameHouse) return;

    lead.stage = 'admitted';
    retired.push(lead);
  });

  if (retired.length > 0) {
    console.log(`[E-ZONE] retired ${retired.length} admitted lead(s) to 'admitted' stage`, retired.map(l => l.name));
  }
  return retired;
}

/**
 * Load-time self-heal (discharge-persistence fix): re-release any ACTIVE
 * patient whose discharge is recorded on the discharged-audit sheet.
 *
 * Why this exists: the Patients sheet is written by saveAll's WHOLE-HOUSE
 * REPLACE (replaceHousePatients_) — last writer wins. A stale session (a
 * second tab, a PWA resumed from background with old in-memory state) that
 * saves ANYTHING silently resurrects a discharged patient as active. The
 * discharged-audit row, by contrast, is a keyed upsert on its own sheet that
 * saveAll never touches — it survives every clobber. So on every load, a
 * NON-restored audit row whose patient shows up active means the discharge
 * was clobbered (or its saveAll half failed): flip the row back to released
 * and restore the exit date from the audit record.
 *
 * Matching is the SAME identity key the restore flow uses
 * (matchActivePatientIndex: houseId + name + date) — the audit row's id is
 * its own key, not the patient's, so the triple is the link. `date` in the key is what
 * keeps a genuine re-admission safe: a patient re-admitted after a discharge
 * gets a NEW entry date, so the old audit row no longer matches and the new
 * stay is never touched. restored==='TRUE' rows are skipped so both restore
 * paths (to-active / to-lead) keep working — a restored patient stays active.
 *
 * Mirrors the promoteEnteredLeads / retireAdmittedLeads self-heal precedent:
 * runs on every load, idempotent (a released patient no longer matches the
 * status filter), persisted by loadAll's existing post-promote saveAll.
 */
function healClobberedDischarges() {
  const healed = [];
  const audits = Array.isArray(state.dischargedPatients) ? state.dischargedPatients : [];
  audits.forEach(d => {
    if (!dischargeRowOpen(d)) return;
    const idx = matchActivePatientIndex(state.patients, d);
    if (idx < 0) return;
    const p = state.patients[idx];
    if (p.status === 'released') return;
    p.status   = 'released';
    p.exitDate = p.exitDate || d.exitDate || '';
    healed.push(p);
  });
  if (healed.length > 0) {
    console.log(`[E-ZONE] healed ${healed.length} clobbered discharge(s) back to released`, healed.map(p => p.name));
  }
  return healed;
}

/* Accept patients as either an array OR an object keyed by houseId. */
function parsePatients(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map(normalizePatient);
  if (typeof raw === 'object') {
    const flat = [];
    const knownHouseIds = new Set(HOUSES.map(h => h.id));
    Object.entries(raw).forEach(([key, val]) => {
      if (Array.isArray(val)) {
        val.forEach(p => {
          if (p && typeof p === 'object') {
            flat.push(normalizePatient({ ...p, houseId: p.houseId || key }));
          }
        });
      } else if (val && typeof val === 'object' && knownHouseIds.has(key) === false && (val.name || val.houseId)) {
        // Treat as a single patient keyed by id only if it looks like a patient record.
        flat.push(normalizePatient({ ...val, id: val.id || key }));
      }
    });
    return flat;
  }
  return [];
}

/* ===== Sheet value normalization ===== */

const STAGE_ALIASES = {
  'new': 'new', 'ליד חדש': 'new', 'חדש': 'new', 'ליד': 'new',
  'visit': 'visit', 'ביקור נקבע': 'visit', 'ביקור': 'visit', 'נקבע ביקור': 'visit',
  'paid': 'paid', 'מקדמה שולמה': 'paid', 'בטיפול פעיל': 'paid', 'מקדמה': 'paid', 'שילם מקדמה': 'paid',
  'entry': 'entry', 'entered': 'entry',
  'כניסה לבית': 'entry', 'נכנס לבית': 'entry', 'נכנס': 'entry', 'כניסה': 'entry',
  /* Terminal stage: lead has been admitted to a house and a patient record
   * owns it. Kept out of STAGES so it never renders on the board, but aliased
   * here so normalizeStage round-trips it on load instead of resetting it to
   * 'new' (the unknown-stage default), which would resurrect the lead. */
  'admitted': 'admitted', 'נקלט': 'admitted', 'אושפז': 'admitted',
  'irrelevant': 'irrelevant', 'לא רלוונטי': 'irrelevant', 'לא_רלוונטי': 'irrelevant',
  'waitlist': 'waitlist', 'רשימת המתנה': 'waitlist', 'רשימת_המתנה': 'waitlist',
};

const STATUS_ALIASES = {
  'active': 'active', 'פעיל': 'active',
  'trial': 'trial', 'תקופת ניסיון': 'trial', 'ניסיון': 'trial',
  'wait': 'wait', 'בהמתנה': 'wait', 'המתנה': 'wait', 'ממתין': 'wait',
  'released': 'released', 'שוחרר': 'released', 'שחרור': 'released',
};

function normalizeStage(raw) {
  if (raw === undefined || raw === null) return 'new';
  const s = String(raw).trim();
  if (!s) return 'new';
  if (STAGE_ALIASES[s]) return STAGE_ALIASES[s];
  const low = s.toLowerCase();
  if (STAGE_ALIASES[low]) return STAGE_ALIASES[low];
  const compact = s.replace(/\s+/g, ' ');
  if (STAGE_ALIASES[compact]) return STAGE_ALIASES[compact];
  console.warn('[E-ZONE] unknown stage, defaulting to "new":', JSON.stringify(raw));
  return 'new';
}

function normalizeStatus(raw) {
  if (raw === undefined || raw === null) return 'active';
  const s = String(raw).trim();
  if (!s) return 'active';
  return STATUS_ALIASES[s] || STATUS_ALIASES[s.toLowerCase()] || 'active';
}

function resolveHouseId(raw) {
  if (!raw) return '';
  const s = String(raw).trim();
  if (HOUSES.some(h => h.id === s)) return s;
  const byName = HOUSES.find(h => h.name === s);
  if (byName) return byName.id;
  const lower = s.toLowerCase();
  const byLowerId = HOUSES.find(h => h.id.toLowerCase() === lower);
  if (byLowerId) return byLowerId.id;
  return s;
}

/* ===== House-manager resolution (meetingWith) =====
 * The roster comes from getData (HOUSE_MANAGERS in Code.gs), keyed by house id.
 * Names are never hardcoded here — callers pass the roster or fall back to
 * state.houseManagers. Kept pure (roster injectable) so the resolution is
 * unit-tested without touching state. */

/* Manager name for a lead's house. `house` may be a Hebrew label or an internal
 * id (resolveHouseId maps both). Returns '' for houses with no manager
 * (pardes/sde), an unknown/external house, or no house at all — those get a
 * blank default and the full override list. */
function managerForHouse(house, managers) {
  const roster = managers || state.houseManagers || {};
  const id = resolveHouseId(house);
  return (id && roster[id]) || '';
}

/* getData's currentManagers → [{ house, name }] (trimmed, blanks dropped), or
 * null when the field is absent / not an array (an older backend). An EMPTY
 * array is kept: it means "no house has a current manager". Pure. */
function normalizeCurrentManagers(raw) {
  if (!Array.isArray(raw)) return null;
  return raw
    .map(m => ({
      house: String((m && m.house) == null ? '' : m.house).trim(),
      name:  String((m && m.name)  == null ? '' : m.name).trim(),
    }))
    .filter(m => m.house && m.name);
}

/* { houseId: name } for the per-house default — the FIRST current manager of
 * each house (the server lists the most recent start first). Pure. */
function rosterFromCurrentManagers(list) {
  const out = {};
  (list || []).forEach(m => { if (m && m.house && m.name && !out[m.house]) out[m.house] = m.name; });
  return out;
}

/* The distinct manager names offered in the meetingWith dropdown, in a stable
 * order (HOUSES order first, then any roster entry not tied to a known house).
 * Vered can pick any of them regardless of the lead's house. With no explicit
 * roster it also lists every CURRENT manager (a house can briefly have two). */
function managerOptions(managers) {
  const roster = managers || state.houseManagers || {};
  const seen = [];
  HOUSES.forEach(h => {
    const m = roster[h.id];
    if (m && seen.indexOf(m) === -1) seen.push(m);
  });
  Object.keys(roster).forEach(k => {
    const m = roster[k];
    if (m && seen.indexOf(m) === -1) seen.push(m);
  });
  if (!managers && Array.isArray(state.currentManagers)) {
    state.currentManagers.forEach(m => { if (m.name && seen.indexOf(m.name) === -1) seen.push(m.name); });
  }
  return seen;
}

/* The meetingWith dropdown's names: the current managers, plus the lead's
 * SAVED value pinned at the end when it is not one of them (a former
 * manager). Without the pin the select would fall to "— ללא —" and the next
 * save of that form would silently erase the stored name. Pure. */
function meetingWithOptionNames(saved, managers) {
  const names = managerOptions(managers);
  const v = String(saved == null ? '' : saved).trim();
  if (v && names.indexOf(v) === -1) names.push(v);
  return names;
}

/* Inline meetingWith <select> for a lead card. Carries data-field="meetingWith"
 * so buildLeadCard's generic [data-field] handler persists it through the same
 * single-field save path (updateLead → saveAll) the visitDate/visitTime inputs
 * use. Options come from the roster (state.houseManagers by default) — no
 * hardcoded names. The pre-selected default is the lead's existing meetingWith,
 * or — when empty — the manager of the lead's house (or blank for
 * pardes/sde/external). Rendering it selected does NOT save; the value only
 * persists when the user changes the select (onchange), matching the other
 * inline fields. Roster injectable so the render is unit-tested without state. */
function meetingWithSelectHTML(lead, managers) {
  const roster = managers || state.houseManagers || {};
  const selected = (lead && lead.meetingWith) || managerForHouse(lead && lead.house, roster);
  const opts = [{ value: '', label: '— ללא —' }].concat(
    meetingWithOptionNames(lead && lead.meetingWith, managers).map(m => ({ value: m, label: m }))
  );
  const optsHtml = opts.map(o =>
    `<option value="${escapeHtml(o.value)}" ${o.value === selected ? 'selected' : ''}>${escapeHtml(o.label)}</option>`
  ).join('');
  return `<select class="lc-meeting-with" data-field="meetingWith" title="נפגש עם">${optsHtml}</select>`;
}

/* ===== visitTime quarter-hour select =====
 * The native <input type="time"> shows 1-minute increments on mobile (the OS
 * picker ignores step="900"), so visitTime is a <select> of quarter-hours. */
const QUARTER_HOUR_TIMES = (() => {
  const out = [];
  for (let h = 0; h < 24; h++) {
    for (const m of [0, 15, 30, 45]) {
      out.push(String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0'));
    }
  }
  return out;
})();

/* Option list for a visitTime select: a blank placeholder plus every quarter
 * hour (00:00…23:45). A non-empty, non-quarter stored value (e.g. a legacy
 * '08:18') is added as an extra option, sorted into place, so it still displays
 * and round-trips instead of being silently dropped. Pure — unit-tested. */
function visitTimeOptions(value) {
  const v = value || '';
  const times = QUARTER_HOUR_TIMES.slice();
  if (v && times.indexOf(v) === -1) { times.push(v); times.sort(); }  // HH:MM sorts chronologically
  return [{ value: '', label: '— בחר —' }].concat(times.map(t => ({ value: t, label: t })));
}

/* Inline visitTime <select> for the lead card. Carries data-field="visitTime" so
 * buildLeadCard's generic [data-field] handler persists it through the same
 * single-field save path the other inline fields use — no wiring change. */
function visitTimeSelectHTML(value) {
  const v = value || '';
  const optsHtml = visitTimeOptions(v).map(o =>
    `<option value="${escapeHtml(o.value)}" ${o.value === v ? 'selected' : ''}>${escapeHtml(o.label)}</option>`
  ).join('');
  return `<select class="lc-visit-time" data-field="visitTime" title="שעת ביקור">${optsHtml}</select>`;
}

/* Visit-stage leads whose meetingWith is empty but whose house resolves to a
 * manager — the set the card renders a correct default for but never persisted
 * (the select only saves on user change). Pure so the selection is unit-tested.
 * A lead with a value, a blank-resolving house (pardes/sde/external), or a
 * non-visit stage is excluded. */
function leadsNeedingMeetingWithDefault(leads, roster) {
  const map = roster || {};
  return (leads || []).filter(l =>
    l && l.stage === 'visit' && !l.meetingWith && managerForHouse(l.house, map)
  );
}

/* Backfill the house-default meetingWith for the leads above and persist it, so
 * the meetings board shows the manager instead of '—'. Applies the default to
 * EVERY qualifying lead in one pass and persists with a SINGLE saveAll (the same
 * persistence updateLead relies on) — so N cards rendering at once is one save,
 * not a storm. Guards:
 *   - edit mode only (saveAll no-ops for viewers; they never write);
 *   - `_autosaveMeetingWithBusy` blocks re-entry — renderAll calls this, and the
 *     failure-rollback re-render path could otherwise loop;
 *   - idempotent — once a lead's meetingWith is set it no longer qualifies, so a
 *     successful save never re-triggers and a later re-render doesn't re-save;
 *   - on save failure, roll the in-memory assignments back to '' (no phantom
 *     values, nothing persisted) and refresh only the board — never renderKanban
 *     / renderAll, which would re-enter;
 *   - per-lead failure guard — a lead whose autosave save already FAILED this
 *     session is recorded in `_meetingWithAutosaveFailed` and skipped on every
 *     later render. Without this, the failure rollback (meetingWith → '') leaves
 *     the lead permanently "pending", so a failing backend would make this
 *     re-fire saveAll on every renderAll — an infinite write loop. The guard
 *     caps it at one attempt per lead per session.
 * Returns the save promise so callers (and tests) can await; renderAll fires it
 * and forgets. */
let _autosaveMeetingWithBusy = false;
const _meetingWithAutosaveFailed = new Set();
function autosaveMeetingWithDefaults() {
  if (_autosaveMeetingWithBusy) return Promise.resolve();
  if (state.mode !== 'edit') return Promise.resolve();
  const pending = leadsNeedingMeetingWithDefault(state.leads, state.houseManagers)
    .filter(l => !_meetingWithAutosaveFailed.has(l.id));
  if (!pending.length) return Promise.resolve();

  _autosaveMeetingWithBusy = true;
  const applied = pending.map(l => ({ lead: l, prev: l.meetingWith }));
  applied.forEach(({ lead }) => { lead.meetingWith = managerForHouse(lead.house, state.houseManagers); });
  renderMeetings();                                  // board: '—' → manager name, immediately

  return saveAll()
    .catch((e) => {
      const busy = isLockBusyError(e);
      applied.forEach(({ lead, prev }) => {
        lead.meetingWith = prev || '';
        // don't retry this lead again this session — unless the lock was
        // merely busy: then the next autosave pass tries it again.
        if (!busy) _meetingWithAutosaveFailed.add(lead.id);
      });
      renderMeetings();                              // revert the board; no kanban re-render
      if (busy) showError(LOCK_BUSY_MESSAGE_HE);
    })
    .finally(() => { _autosaveMeetingWithBusy = false; });
}

/* Decide what meetingWith becomes when the house changes in the add-lead modal.
 * The house's manager auto-fills — but only while the user hasn't manually
 * touched meetingWith (`dirty`). Returns:
 *   - null   → leave meetingWith as-is (user override wins);
 *   - ''     → clear it (houses with no manager: pardes/sde/external);
 *   - name   → the matching manager.
 * Pure (roster injectable) so the autofill rule is unit-tested without a DOM. */
function autofillMeetingWith(newHouse, dirty, managers) {
  if (dirty) return null;
  return managerForHouse(newHouse, managers);
}

/* ===== Meetings-board WhatsApp link =====
 * meetingWith stores the manager NAME, so the phone lookup is by name. The map
 * comes from getData (MANAGER_PHONES in Code.gs); callers pass it or fall back
 * to state.managerPhones. Pure (map injectable) so URL/message building is
 * unit-tested without state or a DOM. */

/* wa.me phone digits for a manager NAME. '' when the name is empty or unknown
 * (no entry in the map) — which disables the button. */
function phoneForManager(name, phones) {
  const map = phones || state.managerPhones || {};
  return (name && map[name]) || '';
}

/* Hebrew WhatsApp message for a meeting. The " בשעה <שעה>" clause is dropped
 * entirely when the meeting has no time (m.time === ''). Date via
 * formatDateHe, time is already isoTime-normalized in meetingsForWeek. */
function meetingWhatsappMessage(m) {
  const base = `נקבעה פגישה: ${m.name || ''}, ${m.houseLabel || ''}, ${formatDateHe(m.date || '')}`;
  return m.time ? `${base} בשעה ${m.time}` : base;
}

/* wa.me URL for a meeting, or '' when the button must render disabled: no
 * meetingWith (incl. blank-house leads), or no phone resolves for that name —
 * so we never link to nobody. */
function meetingWhatsappUrl(m, phones) {
  const phone = phoneForManager(m.meetingWith, phones);
  if (!m.meetingWith || !phone) return '';
  return `https://wa.me/${phone}?text=${encodeURIComponent(meetingWhatsappMessage(m))}`;
}

/* Open a wa.me link so it also works OUTSIDE a normal browser tab. In an
 * installed standalone PWA a plain <a target="_blank"> to an external origin is
 * silently dropped, so the row's click handler calls this instead: try
 * window.open in a new tab first, and when it returns null (blocked, or a
 * standalone window with nowhere to put a tab) fall back to a same-window
 * navigation. The <a href> stays in the markup for hover-preview and
 * right-click-copy — this only supplements the click. `opener`/`setHref` are
 * injected so the fallback rule is unit-tested without a real window.
 * Returns 'window' when a new context opened, 'href' when it fell back. */
function openWhatsAppLink(url, opener, setHref) {
  const open = opener || ((typeof window !== 'undefined' && window.open)
    ? window.open.bind(window) : function () { return null; });
  const w = open(url, '_blank', 'noopener');
  if (!w) {
    (setHref || function (u) { location.href = u; })(url);
    return 'href';
  }
  return 'window';
}

/* ===== Meeting invite / update WhatsApp messages =====
 * Addressed to the LEAD (by name) and sent to the LEAD's phone — distinct from
 * the meetings-board manager link above (that one pings the manager). Pure
 * (no state / no DOM) so the two Hebrew templates are unit-tested directly. */

/* Bare Hebrew weekday names (no "יום " prefix) so the "ביום <שם>" / "ליום <שם>"
 * clauses read naturally. HEBREW_DAYS carries the prefixed form used as day
 * headings; these are the un-prefixed names the message templates need. */
const HEBREW_WEEKDAY_NAMES = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];

/* Hebrew weekday name for a bare YYYY-MM-DD, derived from LOCAL date parts
 * (parseLocalISO) — never UTC parsing, per the isoDate timezone rule. '' when
 * the date can't be parsed. */
function hebrewWeekday(dateISO) {
  const d = parseLocalISO(dateISO);
  if (!d) return '';
  return HEBREW_WEEKDAY_NAMES[d.getDay()] || '';
}

/* House display name (e.g. "קיסריה עפרוני") for a house key / label / id.
 * Resolves canonical keys (arfoni…), Hebrew labels, and ids alike; falls back
 * to the raw value for an unknown house so the message never renders blank. */
function houseDisplayName(house) {
  const h = houseByName(house) || houseById(resolveHouseId(house));
  return h ? h.name : (house || '');
}

/* Hebrew invite/update message for a meeting, addressed to the lead by name.
 *   type 'invite': שלום <שם>, נקבעה פגישה עם <מנהל> ביום <יום> <תאריך> בשעה <שעה> בבית <בית>.
 *   type 'update': שלום <שם>, הפגישה שונתה ליום <יום> <תאריך> בשעה <שעה> עם <מנהל> בבית <בית>.
 * The " בשעה <שעה>" clause is dropped cleanly (no double space) when time is
 * empty/missing. [יום] is the Hebrew weekday from LOCAL parts; [תאריך] is
 * DD/MM/YYYY; [בית] is the house DISPLAY name, not the canonical key. Pure. */
function buildMeetingMessage({ type, name, manager, house, dateISO, time }) {
  const day = hebrewWeekday(dateISO);
  const date = formatDateHe(dateISO);
  const houseLabel = houseDisplayName(house);
  const timeClause = time ? ` בשעה ${time}` : '';
  if (type === 'update') {
    return `שלום ${name || ''}, הפגישה שונתה ליום ${day} ${date}${timeClause} עם ${manager || ''} בבית ${houseLabel}.`;
  }
  return `שלום ${name || ''}, נקבעה פגישה עם ${manager || ''} ביום ${day} ${date}${timeClause} בבית ${houseLabel}.`;
}

/* wa.me deep link to a phone with a pre-filled message. Reuses normalizePhone
 * (the same normalization the duplicate-check uses) and the same wa.me
 * construction as meetingWhatsappUrl — not reimplemented. Digits may be ''
 * (no/blank phone) → wa.me/?text=… which lets the sender pick the recipient. */
function meetingInviteWaUrl(rawPhone, message) {
  const digits = normalizePhone(rawPhone);
  return `https://wa.me/${digits}?text=${encodeURIComponent(message)}`;
}

/* ===== Billing / contact phone helpers =====
 *
 * A lead's name/phone are the PATIENT (פרטי המטופל). contactName/contactPhone/
 * contactRelation are the REFERRER (פרטי הפונה). billingPhone (טלפון לגבייה
 * ועדכונים) is the default number for OUTGOING communication; Vered picks it per
 * lead. It stores a RESOLVED phone STRING (never a reference), so downstream —
 * WhatsApp links, search — treats it like any other phone. All pure + testable. */

/* The phone to use for outgoing communication: the explicit billingPhone if set,
 * otherwise fall back to the patient phone. Never throws on a missing lead. */
function leadBillingPhone(lead) {
  if (!lead) return '';
  const bill = String(lead.billingPhone == null ? '' : lead.billingPhone).trim();
  return bill || String(lead.phone == null ? '' : lead.phone).trim();
}

/* Resolve the billing selector choice into the actual phone string to STORE.
 *   'patient' (default) → the patient phone
 *   'contact'           → the referrer (contact) phone
 *   'other'             → a free-typed number
 * Trims so a blank selection doesn't store stray whitespace. */
function resolveBillingPhone(mode, patientPhone, contactPhone, otherPhone) {
  const t = (v) => String(v == null ? '' : v).trim();
  if (mode === 'contact') return t(contactPhone);
  if (mode === 'other')   return t(otherPhone);
  return t(patientPhone); // 'patient' (default)
}

/* Which selector mode + free-input value a stored billingPhone corresponds to,
 * for initializing the selector in edit mode. Compares by NORMALIZED phone so a
 * formatting difference (spaces/dashes/+972) doesn't force 'אחר'. Unset billing
 * → default 'patient' (matches leadBillingPhone's fallback). Patient is checked
 * before contact, so when both phones are equal it reads as 'patient'. */
function billingModeForLead(lead) {
  const bill = String((lead && lead.billingPhone) == null ? '' : lead.billingPhone).trim();
  if (!bill) return { mode: 'patient', other: '' };
  const b = normalizePhone(bill);
  const p = normalizePhone(lead && lead.phone);
  const c = normalizePhone(lead && lead.contactPhone);
  if (b && p && b === p) return { mode: 'patient', other: '' };
  if (b && c && b === c) return { mode: 'contact', other: '' };
  return { mode: 'other', other: bill };
}

/* Whether a lead's billing number is genuinely a DIFFERENT number than the
 * patient phone (normalized) — drives the subtle "גבייה" marker in the card. An
 * unset or patient-equal billingPhone returns false (the default case, no mark). */
function leadBillingDiffersFromPatient(lead) {
  const b = normalizePhone(lead && lead.billingPhone);
  if (!b) return false;
  return b !== normalizePhone(lead && lead.phone);
}

/* Shared billing-selector field defs for the add + edit lead modals, so both
 * stay identical. `lead` initializes the mode + free input in edit mode (null in
 * add mode → default 'patient'). Resolve the choice on submit with
 * resolveBillingPhone() over the sibling phone / contactPhone values. */
function billingSelectorFields(lead) {
  const init = billingModeForLead(lead || {});
  return [
    { name: 'billingMode', label: 'טלפון לגבייה ועדכונים', type: 'select',
      value: init.mode,
      options: [
        { value: 'patient', label: 'מטופל' },
        { value: 'contact', label: 'פונה' },
        { value: 'other',   label: 'אחר' },
      ],
      onChange: (val, form) => {
        const inp = form.querySelector('[name="billingOther"]');
        if (inp) inp.closest('.form-row').style.display = (val === 'other') ? '' : 'none';
      } },
    { name: 'billingOther', label: 'מספר טלפון אחר', type: 'tel',
      value: init.mode === 'other' ? init.other : '',
      hidden: init.mode !== 'other' },
  ];
}

/* The קשר למטופל pair for a showModal field list — the select plus its אחר
 * free-text row, mirroring billingSelectorFields above (same hidden-row +
 * onChange mechanics). Shared by the add and edit lead modals so the option
 * list and the legacy-value handling stay identical in both.
 *
 * `lead` is null for the add form. The free-text row starts hidden unless the
 * stored value is literally 'אחר'; an off-list LEGACY value selects its own
 * pinned option instead of routing through אחר, which is what preserves it. */
function contactRelationFields(lead) {
  const stored = (lead && lead.contactRelation) || '';
  return [
    { name: 'contactRelation', label: 'קשר למטופל', type: 'select',
      value: stored,
      options: contactRelationOptions(stored),
      onChange: (val, form) => {
        const inp = form.querySelector('[name="contactRelationOther"]');
        if (inp) inp.closest('.form-row').style.display = (val === CONTACT_RELATION_OTHER) ? '' : 'none';
      } },
    { name: 'contactRelationOther', label: 'קשר אחר', type: 'text',
      value: '',
      hidden: stored !== CONTACT_RELATION_OTHER },
  ];
}

/* Build the meetingWith modal field. `preselect` is the resolved default (the
 * house manager, or '' → the blank placeholder). Shared by the add and edit
 * lead modals so the option list and blank-default behaviour stay identical. */
function meetingWithField(preselect) {
  return {
    name: 'meetingWith', label: 'נפגש עם', type: 'select',
    value: preselect || '',
    options: [{ value: '', label: '— ללא —' }, ...meetingWithOptionNames(preselect).map(m => ({ value: m, label: m }))],
  };
}

/* Pick the first non-empty value from a list of keys. Accepts Hebrew or
 * English column names so the app works against sheets populated by any
 * route (original form, manual entry, or this app itself). */
function pickField(obj, keys) {
  if (!obj) return '';
  for (const k of keys) {
    const v = obj[k];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return '';
}

function normalizeLead(l) {
  if (!l || typeof l !== 'object') l = {};
  const advRaw = pickField(l, ['advance', 'adv', 'מקדמה', 'מקדמה ששולמה']);
  return {
    id:        pickField(l, ['id', 'ID', 'מזהה']) || cryptoId(),
    name:      pickField(l, ['name', 'שם', 'שם מלא', 'Name']),
    phone:     pickField(l, ['phone', 'טלפון', 'נייד', 'מספר טלפון', 'Phone']),
    house:     pickField(l, ['house', 'בית', 'בית מועדף', 'House']),
    source:    pickField(l, ['source', 'מקור', 'מקור הפניה', 'Source']),
    note:      pickField(l, ['note', 'notes', 'הערות', 'הערה', 'Note']),
    stage:     normalizeStage(pickField(l, ['stage', 'שלב', 'סטטוס ליד', 'Stage'])),
    visitDate: isoDate(pickField(l, ['visitDate', 'visit_date', 'תאריך ביקור'])),
    visitTime: isoTime(pickField(l, ['visitTime', 'visit_time', 'שעת ביקור', 'שעה'])),
    entryDate: isoDate(pickField(l, ['entryDate', 'entry_date', 'תאריך כניסה'])),
    advance:   advRaw === '' ? '' : Number(advRaw) || 0,
    /* assignedTo (משוייך ל) — required on new leads via the add-lead form.
     * pickField returns '' when absent so pre-existing leads (no such column)
     * stay blank with no backfill, mirroring the originSheet/movedAt
     * pass-through idiom. */
    assignedTo: pickField(l, ['assignedTo', 'assigned_to', 'משוייך ל', 'משויך ל']),
    /* meetingWith — the house manager the lead is meeting with. Schema-only
     * pass-through: no UI, no dropdown, nothing rendered. pickField returns ''
     * when absent so pre-existing leads (no such column) stay blank with no
     * backfill, mirroring the assignedTo idiom. */
    meetingWith: pickField(l, ['meetingWith', 'meeting_with', 'נפגש עם']),
    /* meetingOutcome — the outcome of the lead's meeting (stable key; see
     * MEETING_OUTCOME_LABELS). Foundation-only schema pass-through: no UI,
     * nothing rendered. pickField returns '' when absent so pre-existing leads
     * (no such column) stay blank with no backfill, mirroring the meetingWith
     * idiom. */
    meetingOutcome: pickField(l, ['meetingOutcome', 'meeting_outcome', 'תוצאת פגישה']),
    /* Lead contact fields (foundation). name/phone above now mean the PATIENT
     * (פרטי המטופל); these carry the REFERRER's details (פרטי הפונה) and a
     * dedicated billing/updates phone (טלפון לגבייה ועדכונים). Schema-only
     * pass-through: no UI, nothing rendered. pickField returns '' when absent so
     * pre-existing leads (no such columns) stay blank with no backfill,
     * mirroring the meetingOutcome idiom. These also flow through
     * normalizeIrrelevantLead / normalizeRemovedLead, which build on this
     * function's output (base = normalizeLead(l)). */
    contactName:     pickField(l, ['contactName', 'contact_name', 'שם הפונה', 'שם פונה']),
    contactPhone:    pickField(l, ['contactPhone', 'contact_phone', 'טלפון הפונה', 'טלפון פונה']),
    contactRelation: pickField(l, ['contactRelation', 'contact_relation', 'קשר', 'קרבה']),
    billingPhone:    pickField(l, ['billingPhone', 'billing_phone', 'טלפון לגבייה', 'טלפון לגבייה ועדכונים']),
    /* waitlistedAt — ISO timestamp string recorded when the lead entered the
     * רשימת המתנה (waitlist) stage. Foundation-only schema pass-through: no UI,
     * nothing rendered. Kept verbatim (no isoDate) — the column is text-forced
     * at sheet-ensure time so it arrives as the string that was written.
     * pickField returns '' when absent so pre-existing leads (no such column)
     * stay blank with no backfill, mirroring the meetingOutcome idiom. Flows
     * through normalizeIrrelevantLead / normalizeRemovedLead automatically
     * (base = normalizeLead(l)). */
    waitlistedAt: pickField(l, ['waitlistedAt', 'waitlisted_at']),
    /* Meeting-report fields (foundation) — see MEETING_REPORT_OUTCOME_LABELS /
     * MEETING_COMPANION_LABELS. Schema-only pass-through: no UI, nothing
     * rendered. pickField returns '' when absent so pre-existing leads (no such
     * columns) stay blank with no backfill, mirroring the waitlistedAt idiom —
     * without this, upsertRowById_ round-trips would silently drop the values.
     * meetingReportedAt and meetingSeen are kept verbatim (no isoDate): both
     * columns are text-forced at sheet-ensure time so they arrive as the
     * strings that were written. All six flow through normalizeIrrelevantLead /
     * normalizeRemovedLead automatically (base = normalizeLead(l)). */
    meetingReportOutcome: pickField(l, ['meetingReportOutcome', 'meeting_report_outcome']),
    meetingCompanion:     pickField(l, ['meetingCompanion', 'meeting_companion']),
    meetingNote:          pickField(l, ['meetingNote', 'meeting_note']),
    meetingReporter:      pickField(l, ['meetingReporter', 'meeting_reporter']),
    meetingReportedAt:    pickField(l, ['meetingReportedAt', 'meeting_reported_at']),
    meetingSeen:          pickField(l, ['meetingSeen', 'meeting_seen']),
    /* Stored as YYYY-MM-DD. Sheets sometimes returns a Date object for date
     * cells (depending on locale + column type); isoDate normalizes both
     * Date objects and full ISO timestamps down to a plain date string so
     * the inline <input type="date"> always has a usable value. Empty string
     * stays empty — that is the "no original creation timestamp" case for
     * pre-existing leads, per spec. */
    created:   isoDate(pickField(l, ['created', 'created_at', 'נוצר', 'נוצר ב', 'תאריך יצירה'])),
  };
}

/* Irrelevant leads carry the same fields as a regular lead plus two metadata
 * columns (originSheet, movedAt) added when the lead was marked irrelevant. */
function normalizeIrrelevantLead(l) {
  const base = normalizeLead(l);
  base.stage = 'irrelevant';
  base.originSheet = pickField(l, ['originSheet', 'origin_sheet', 'גיליון מקור']) || '';
  base.movedAt     = pickField(l, ['movedAt', 'moved_at', 'תאריך העברה']) || '';
  /* Phase 2b — reason + free-text note captured at לא רלוונטי time. Mirror
   * the originSheet/movedAt pass-through pattern: without this, the backend
   * writes the columns but the next getData() round-trip silently drops them
   * (same bug Outpatient hit in commit 1d2436c). */
  base.not_relevant_reason = pickField(l, ['not_relevant_reason']) || '';
  base.not_relevant_note   = pickField(l, ['not_relevant_note']) || '';
  /* Phase 2d-1 — disposition pass-through, then lazy migration. New writes
   * have an explicit disposition column; legacy rows have it empty and
   * computeDisposition fills it from the Phase 2b reason field. */
  base.disposition = pickField(l, ['disposition']) || '';
  base.disposition = computeDisposition(base);
  return base;
}

/* Phase 2d-1 — derives a row's disposition from either the new explicit
 * column or, for legacy rows, the Phase 2b not_relevant_reason field. Always
 * resolves to one of the three stable keys so callers can group safely. */
function computeDisposition(lead) {
  const explicit = lead.disposition;
  if (explicit === 'not_relevant' || explicit === 'completed' || explicit === 'stopped_early') {
    return explicit;
  }
  const reason = lead.not_relevant_reason;
  if (reason === 'never_relevant') return 'not_relevant';
  if (reason === 'stopped_from_house' || reason === 'stopped_new') return 'stopped_early';
  return 'not_relevant';
}

/* Removed (soft-deleted) leads carry the same fields as a regular lead plus
 * two metadata columns (removedAt, originSheet) added when the lead was
 * removed. No stage decoration — removed leads don't participate in the
 * pipeline; they're surfaced read-only in the retention tab. */
function normalizeRemovedLead(l) {
  const base = normalizeLead(l);
  base.removedAt   = pickField(l, ['removedAt', 'removed_at', 'תאריך הסרה']) || '';
  base.originSheet = pickField(l, ['originSheet', 'origin_sheet', 'גיליון מקור']) || '';
  return base;
}

function normalizePatient(p) {
  if (!p || typeof p !== 'object') p = {};
  return {
    id:       pickField(p, ['id', 'ID', 'מזהה']) || cryptoId(),
    houseId:  resolveHouseId(pickField(p, ['houseId', 'house_id', 'בית', 'בית_מזהה'])),
    /* TRIMMED. A stray space is invisible on screen and fatal to the
     * payment link: "שחר חיון " and "שחר חיון" are two different patients to
     * houseId::name::entryDate, and the live sheet holds a payment row proving
     * it. Trimming HERE covers every write path at once — the add and edit
     * forms, the lead promotion, and any saveAll echo — because every patient
     * object in state goes through this function. */
    name:     trimName(pickField(p, ['name', 'שם', 'שם מטופל', 'Name'])),
    date:     isoDate(pickField(p, ['date', 'תאריך', 'תאריך כניסה', 'entryDate'])),
    pay:      Number(pickField(p, ['pay', 'payment', 'תשלום', 'תשלום חודשי'])) || 0,
    adv:      Number(pickField(p, ['adv', 'advance', 'מקדמה'])) || 0,
    status:   normalizeStatus(pickField(p, ['status', 'סטטוס', 'מצב'])),
    fromLead: pickField(p, ['fromLead', 'from_lead', 'מקור_ליד', 'ליד מקור']),
    exitDate: pickField(p, ['exitDate', 'exit_date', 'תאריך שחרור', 'שחרור']),
    source:   pickField(p, ['source', 'מקור']) || 'lead',
    notes:    pickField(p, ['notes', 'note', 'הערות', 'הערה']),
    /* Who/when stamps (server-owned; the client only echoes them back so a
     * saveAll never drops them — same defensive pickField pattern as
     * prior_status). The server ignores client-supplied stamps and always
     * overwrites on a real change; blanks are legacy rows. */
    updatedAt: pickField(p, ['updatedAt', 'updated_at']) || '',
    updatedBy: pickField(p, ['updatedBy', 'updated_by']) || '',
  };
}

/* Phase 2e-1 — discharged-patient audit rows carry the same fields as a
 * patient plus three discharge-time metadata columns. Mirror
 * normalizeIrrelevantLead's pass-through pattern: pickField for each extra
 * field with multiple aliases so the next getData() round-trip doesn't
 * silently drop columns (same bug pattern Phase 2b hit). */
function normalizeDischargedPatient(p) {
  const base = normalizePatient(p);
  /* Phone is not part of the patient schema (normalizePatient drops it), but
   * audit rows that DO carry a phone column (same aliases as normalizeLead)
   * keep it here so the discharged-tab search can match on it. */
  base.phone          = pickField(p, ['phone', 'טלפון', 'נייד', 'מספר טלפון', 'Phone']) || '';
  base.dischargedAt   = pickField(p, ['dischargedAt', 'discharged_at', 'תאריך שחרור']) || '';
  base.disposition    = pickField(p, ['disposition']) || '';
  base.discharge_note = pickField(p, ['discharge_note', 'dischargeNote', 'הערת שחרור']) || '';
  base.restored       = pickField(p, ['restored', 'משוחזר']);
  /* Status at the moment of discharge (restore-choice modal). Legacy rows
   * (recorded before the column existed) stay blank — priorStatusFromAudit
   * falls back to 'active' for them. */
  base.prior_status   = pickField(p, ['prior_status', 'priorStatus', 'סטטוס קודם']) || '';
  /* Coordinators discharge audit (appended columns, 2026-10-04). Carried so
   * the panel can list them AND so a restore — which upserts this whole row
   * back — never blanks them. Empty on the Dashboard's own discharges. */
  base.dischargeSource = pickField(p, ['dischargeSource']) || '';
  base.dischargedBy    = pickField(p, ['dischargedBy']) || '';
  base.dischargeReason = pickField(p, ['dischargeReason']) || '';
  base.patientId       = pickField(p, ['patientId']) || '';
  /* Duplicate-discharge soft delete (appended columns, 2026-10-07). Carried
   * so every open-row filter can skip a deleted row (dischargeRowOpen). */
  base.deletedAt       = pickField(p, ['deletedAt']) || '';
  base.deletedBy       = pickField(p, ['deletedBy']) || '';
  base.deleteReason    = pickField(p, ['deleteReason']) || '';
  return base;
}

/* An OPEN discharge row: neither restored (restored='TRUE', or a Sheets bool)
 * nor soft-deleted as a duplicate (deletedAt). Mirrors dischargeRowOpen_ in
 * Code.gs. Every reader that treats a row as a live discharge uses it. Pure. */
function dischargeRowOpen(d) {
  return !!d && d.restored !== 'TRUE' && d.restored !== true && !String(d.deletedAt || '').trim();
}

/* The stay a discharge row belongs to: houseId + name + entry date, with the
 * name trimmed and inner whitespace collapsed — dischargeStayKey_ in Code.gs.
 * '' when house or name is blank. Pure. */
function dischargeStayKey(d) {
  if (!d) return '';
  const houseId = String(d.houseId || '').trim();
  const name = String(d.name || '').replace(/\s+/g, ' ').trim();
  if (!houseId || !name) return '';
  return houseId + '::' + name + '::' + String(d.date || '').slice(0, 10);
}

/* The OTHER open rows of `d`'s stay — what makes `d` a duplicate. Pure. */
function openDuplicateSiblings(d, dischargedPatients) {
  const key = dischargeStayKey(d);
  if (!key || !dischargeRowOpen(d)) return [];
  return (Array.isArray(dischargedPatients) ? dischargedPatients : []).filter(x =>
    x && x !== d && x.id !== d.id && dischargeRowOpen(x) && dischargeStayKey(x) === key);
}
/* A client-minted row id — the row's idempotency key, minted ONCE per form
 * (CHANGELOG-write-path-hardening.md): a retry re-sends the same id and the
 * server's merge matches it, never adding a second row. crypto when the
 * browser has it (every supported one does). Same shape as before:
 * 'id-' + [0-9a-z]. */
function cryptoId() {
  const c = typeof crypto !== 'undefined' && crypto && typeof crypto.getRandomValues === 'function' ? crypto : null;
  let rnd = '';
  if (c) {
    const bytes = new Uint8Array(8);
    c.getRandomValues(bytes);
    rnd = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  } else {
    rnd = Math.random().toString(36).slice(2, 10);
  }
  return 'id-' + rnd + Date.now().toString(36);
}

/* Canonicalize Israeli phone numbers so different input formats of the same
 * number collapse to one comparable string. Mirrors the Outpatient app's
 * helper. Empty / null / undefined returns '' (caller skips dedup). */
function normalizePhone(raw) {
  if (!raw) return '';
  var s = String(raw);
  s = s.replace(/[\s\-\(\)]/g, '');
  s = s.replace(/^\+/, '');
  s = s.replace(/^00/, '');
  if (s.length > 0 && s[0] === '0') {
    s = '972' + s.substring(1);
  }
  s = s.replace(/\D/g, '');
  return s;
}

/* Looks for an existing lead (active or marked-irrelevant) with the same
 * normalized phone. Removed (soft-deleted) leads are intentionally excluded:
 * re-adding a contact after retention removal is a legitimate flow. */
function findDuplicateLeadByPhone(normalizedPhone) {
  if (!normalizedPhone) return null;
  var pool = state.leads.concat(state.irrelevantLeads);
  for (var i = 0; i < pool.length; i++) {
    if (normalizePhone(pool[i].phone) === normalizedPhone) {
      return pool[i];
    }
  }
  return null;
}

/* ===== Render router ===== */
/* ====================================================
   MEETINGS BOARD (לוח פגישות) — weekly, list grouped by day
   ==================================================== */
/* Hebrew weekday names, indexed by getDay() (0 = Sunday). The board is
 * Sunday-anchored, so day index i (0..6) from the week start maps directly. */
const HEBREW_DAYS = [
  'יום ראשון', 'יום שני', 'יום שלישי', 'יום רביעי', 'יום חמישי', 'יום שישי', 'יום שבת',
];

/* Pure bucketing for the meetings board. Given the lead list and any date in
 * the target week, returns the week's meetings grouped by day.
 *
 *   - A "meeting" is any lead with a non-empty visitDate that falls within the
 *     Sunday–Saturday week containing weekAnchorISO (inclusive both ends).
 *   - Days are returned in Sun→Sat order; empty days are omitted.
 *   - Within a day, timed meetings sort by visitTime ascending (HH:MM sorts
 *     lexicographically == chronologically), name as tiebreak; leads with a
 *     date but NO time are collected separately (noTime) so the renderer can
 *     place them last under a "ללא שעה" grouping.
 *
 * Pure (no DOM / no state): weekStartSunday/addDaysISO/isoDate/isoTime do all
 * the date normalization, so bucketing is unit-tested directly. */
function meetingsForWeek(leads, weekAnchorISO) {
  const start = weekStartSunday(weekAnchorISO);
  const end = start ? addDaysISO(start, 6) : '';
  const byIso = {};
  if (start) {
    (leads || []).forEach(l => {
      const v = isoDate(l && l.visitDate);
      if (!v) return;
      if (v < start || v > end) return;          // bare YYYY-MM-DD sorts chronologically
      const h = houseByName(l.house) || houseById(resolveHouseId(l.house));
      const meeting = {
        id: l.id || '',
        date: v,                                  // bucket key: local bare YYYY-MM-DD
        time: isoTime(l.visitTime || ''),
        name: l.name || '',
        house: l.house || '',
        houseLabel: h ? h.name : (l.house || ''),
        meetingWith: l.meetingWith || '',
        meetingOutcome: l.meetingOutcome || '',    // pre-selects the row's outcome <select>
        /* Manager-report fields (PR 3) — carried so the row can render the
         * read-only דיווח מנהל block + unseen cue. Display-only here; the
         * mark-seen write goes through updateLead against state.leads. */
        meetingReportOutcome: l.meetingReportOutcome || '',
        meetingCompanion:     l.meetingCompanion || '',
        meetingNote:          l.meetingNote || '',
        meetingReporter:      l.meetingReporter || '',
        meetingReportedAt:    l.meetingReportedAt || '',
        meetingSeen:          l.meetingSeen || '',
      };
      (byIso[v] || (byIso[v] = [])).push(meeting);
    });
  }

  const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const days = [];
  for (let i = 0; i < 7; i++) {
    const iso = addDaysISO(start, i);
    const list = byIso[iso] || [];
    if (!list.length) continue;
    const timed = list.filter(m => m.time)
      .sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : byName(a, b)));
    const noTime = list.filter(m => !m.time).sort(byName);
    days.push({ iso: iso, dow: i, timed: timed, noTime: noTime });
  }
  const total = days.reduce((n, d) => n + d.timed.length + d.noTime.length, 0);
  return { weekStart: start, weekEnd: end, days: days, total: total };
}

/* Whether a meeting on bare local date `dateISO` is eligible for an outcome
 * selector — i.e. it has already happened (today or earlier). Comparison is on
 * bare YYYY-MM-DD strings (local date parts, never UTC), mirroring
 * meetingsForWeek's own bucket-range check; `todayISO()` builds today from local
 * getFullYear/getMonth/getDate. Future-dated meetings return false → no selector.
 * Pure (todayISOStr is injectable) so the date predicate is unit-tested directly. */
function meetingOutcomeEligible(dateISO, todayISOStr) {
  const d = isoDate(dateISO);
  if (!d) return false;
  return d <= (todayISOStr || todayISO());
}

/* Outcome <select> for a past/today meeting row. Option values are the stable
 * MEETING_OUTCOME_LABELS keys; labels come from that map (single source of
 * truth). Two optgroups split "the meeting was held" (התקיימה) from "it wasn't"
 * (לא התקיימה). Pre-selects the lead's current meetingOutcome. data-mtg-outcome
 * carries the lead id so renderMeetings can wire the change without threading
 * the meeting object through the HTML. Rendered only for eligible rows. */
function meetingOutcomeSelectHTML(m) {
  const cur = (m && m.meetingOutcome) || '';
  const opt = (val) =>
    `<option value="${escapeHtml(val)}"${val === cur ? ' selected' : ''}>${escapeHtml(MEETING_OUTCOME_LABELS[val])}</option>`;
  return `
    <select class="mtg-outcome" data-mtg-outcome="${escapeHtml(m.id || '')}" title="תוצאת פגישה">
      <option value=""${cur === '' ? ' selected' : ''}>— תוצאה —</option>
      <optgroup label="התקיימה">${opt('not_relevant')}${opt('thinking')}${opt('entered')}</optgroup>
      <optgroup label="לא התקיימה">${opt('postponed')}${opt('cancelled')}</optgroup>
    </select>`;
}

/* ===== Manager meeting reports — Vered's view (PR 3) =====
 *
 * Managers submit reports from the standalone /meeting-report form (PR 2) into
 * the six meetingReport* lead fields (PR 1). Vered sees each report where she
 * already works — on the meetings-board row and the lead card — as READ-ONLY
 * context (a "דיווח מנהל" block), visually distinct from her own authoritative
 * meetingOutcome selector. A report is UNSEEN until she expands it; expanding
 * writes meetingSeen='1' through the normal updateLead→saveAll path. A manager
 * resubmission resets meetingSeen to '' (PR 2), so the cue reappears. */

/* Unseen = a report exists (meetingReportedAt non-empty) that Vered hasn't
 * opened yet (meetingSeen !== '1'). Pure. */
function meetingReportUnseen(lead) {
  if (!lead || !lead.meetingReportedAt) return false;
  return String(lead.meetingSeen || '') !== '1';
}

/* How many leads carry an unseen manager report — drives the tab badge. Pure. */
function countUnseenMeetingReports(leads) {
  return (Array.isArray(leads) ? leads : []).filter(meetingReportUnseen).length;
}

/* Companion display rule (PR 1): a preset key renders its Hebrew label; any
 * other value is raw free text from the manager form's אחר flow, shown
 * verbatim (CALLERS ESCAPE — this returns plain text). Blank → em dash. */
function meetingReportCompanionDisplay(value) {
  if (value === undefined || value === null || value === '') return '—';
  return MEETING_COMPANION_LABELS[value] || String(value);
}

/* Human display for the report's ISO timestamp: "DD/MM/YYYY HH:MM" in LOCAL
 * time (isoDate collapses the timestamp to the local calendar day; hours from
 * the local Date). Unparseable input falls back to the raw string. Pure. */
function meetingReportWhenText(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${formatDateHe(isoDate(iso))} ${hh}:${mm}`;
}

/* The read-only "דיווח מנהל" block for one lead. '' when the lead has no
 * report (meetingReportedAt empty) — nothing renders at all. Collapsed by
 * default: the head shows the title + outcome label (+ unseen dot); clicking
 * toggles the detail open (companion / note / reporter / when) and marks the
 * report seen (see wireMeetingReportToggle). data-mrv-toggle carries the lead
 * id. All free text is escaped. Deliberately styled apart from Vered's own
 * .mtg-outcome selector — this is upstream context, never her outcome. */
/* The outcome badge's color class, keyed by the report outcome: advancing →
 * green (success), undecided → amber (warning), not_fit → red (danger),
 * no_show → gray (neutral). An unknown/legacy value gets the neutral class so
 * the badge always renders legibly. Pure — unit-tested. */
function meetingReportOutcomeBadgeClass(outcome) {
  const map = {
    advancing: 'mrv-badge-advancing',
    undecided: 'mrv-badge-undecided',
    not_fit:   'mrv-badge-not_fit',
    no_show:   'mrv-badge-no_show',
  };
  return map[outcome] || 'mrv-badge-neutral';
}

/* LEAD SURFACES ONLY (lead card + meetings-board row): a report describes a
 * pre-admission meeting, so it must never follow the person onto a patient
 * card — once a lead is admitted, the תפוסה view shows no report strip (the
 * report row itself stays untouched in the sheet). The patient-card rendering
 * path (patientReportBlockHTML) was removed deliberately; do not reintroduce
 * a caller from renderPatients. */
function meetingReportBlockHTML(lead) {
  if (!lead || !lead.meetingReportedAt) return '';
  const unseen = meetingReportUnseen(lead);
  const outcomeLabel =
    MEETING_REPORT_OUTCOME_LABELS[lead.meetingReportOutcome] || lead.meetingReportOutcome || '—';
  const badgeClass = meetingReportOutcomeBadgeClass(lead.meetingReportOutcome);
  const dot = unseen ? '<span class="mrv-dot" title="דיווח חדש"></span>' : '';
  /* Edit / delete (PR 4) — edit mode only, same gating as mark-seen (both write
   * via updateLead→saveAll, which is pointless for viewers). Vered-side only:
   * managers' own correction path stays resubmit-overwrite on /meeting-report. */
  const actions = (state.mode === 'edit')
    ? `<div class="mrv-actions">
          <button type="button" class="btn small" data-mrv-edit="${escapeHtml(lead.id || '')}">עריכה</button>
          ${canDelete() ? `<button type="button" class="btn small danger" data-role="deleter" data-mrv-delete="${escapeHtml(lead.id || '')}">מחיקת דיווח</button>` : ''}
        </div>`
    : '';
  return `
    <div class="mrv-report${unseen ? ' mrv-unseen' : ''}" data-mrv-toggle="${escapeHtml(lead.id || '')}">
      <div class="mrv-head">
        ${dot}<span class="mrv-title">דיווח מנהל</span>
        <span class="mrv-outcome-badge ${badgeClass}">${escapeHtml(outcomeLabel)}</span>
        <span class="mrv-chevron">▾</span>
      </div>
      <div class="mrv-detail">
        <div><span class="mrv-label">הגיע/ה עם:</span> ${escapeHtml(meetingReportCompanionDisplay(lead.meetingCompanion))}</div>
        ${lead.meetingNote ? `<div><span class="mrv-label">פירוט:</span> <span class="mrv-note">${escapeHtml(lead.meetingNote)}</span></div>` : ''}
        <div class="mrv-byline"><span class="mrv-label">דווח ע"י:</span> ${escapeHtml(lead.meetingReporter || '—')} · ${escapeHtml(meetingReportWhenText(lead.meetingReportedAt))}</div>
        ${actions}
      </div>
    </div>`;
}

/* Mark a lead's manager report seen. Edit-mode only (saveAll no-ops for
 * viewers) and only when actually unseen — re-opening a seen report is a pure
 * UI toggle, no write. Optimistic via the SAME updateLead→saveAll path every
 * lead-card inline field uses: updateLead assigns meetingSeen synchronously
 * (cue-clearing callers see the new state immediately), saves, and on failure
 * rolls the lead back + renderAll (which re-renders the dots and the badge) +
 * shows the error. The write preserves the whole row: state.leads carries
 * every lead field (normalizeLead pass-through) and mergeLeads_ writes the
 * full client row — nothing drops. Returns updateLead's promise (false on
 * no-op) so tests can await the outcome. */
function markMeetingReportSeen(leadId) {
  if (state.mode !== 'edit') return Promise.resolve(false);
  const lead = state.leads.find(l => l.id === leadId);
  if (!lead || !meetingReportUnseen(lead)) return Promise.resolve(false);
  const p = updateLead(leadId, { meetingSeen: '1' });
  // State is already updated (optimistic) — refresh the tab badge now; a
  // failed save renders everything back via updateLead's rollback path.
  renderMeetingsUnseenBadge();
  return p;
}

/* The unseen-report count badge on the לוח פגישות tab. Hidden at zero. Called
 * from renderMeetings (so every renderAll / board refresh updates it) and
 * directly after a mark-seen. */
function renderMeetingsUnseenBadge() {
  const el = document.getElementById('meetings-unseen-badge');
  if (!el) return;
  const n = countUnseenMeetingReports(state.leads);
  el.textContent = String(n);
  el.classList.toggle('hidden', n === 0);
}

/* Wire one rendered report block: click toggles the detail open/closed; the
 * transition to OPEN on an unseen report marks it seen (optimistic — the dot
 * and unseen tint clear in place, no re-render, so the just-opened detail
 * stays open). */
function wireMeetingReportToggle(el) {
  el.addEventListener('click', e => {
    // Clicks on the edit/delete actions act, never collapse the block.
    if (e.target && e.target.closest && e.target.closest('.mrv-actions')) return;
    const opening = !el.classList.contains('open');
    el.classList.toggle('open');
    if (!opening) return;
    const id = el.getAttribute('data-mrv-toggle');
    if (!id) return;
    const lead = state.leads.find(l => l.id === id);
    if (!lead || !meetingReportUnseen(lead)) return;
    /* Mark-seen is a real write, so it gets the same indicator as every other
     * inline save — brief, and only on the FIRST expand of an unseen report.
     * The optimistic cue-clearing below is unchanged; a failed write still
     * rolls back and re-renders the block with its dot restored. */
    withFieldSaving(el, 'save', () => markMeetingReportSeen(id));
    // Clear the cue in place (state already reflects seen; rollback re-renders).
    el.classList.remove('mrv-unseen');
    el.querySelectorAll('.mrv-dot').forEach(d => d.remove());
  });

  /* Edit / delete actions (PR 4) — present only when the block rendered in
   * edit mode (see meetingReportBlockHTML). Edit opens the pre-filled modal
   * and swaps the block in place on success; delete confirms, clears the six
   * report fields and removes the block. */
  const editBtn = el.querySelector('[data-mrv-edit]');
  if (editBtn) {
    editBtn.addEventListener('click', () => {
      const lead = state.leads.find(l => l.id === editBtn.getAttribute('data-mrv-edit'));
      if (lead) showMeetingReportEditModal(lead, () => refreshMeetingReportBlock(el, lead.id));
    });
  }
  const delBtn = el.querySelector('[data-mrv-delete]');
  if (delBtn) {
    delBtn.addEventListener('click', () => {
      const id = delBtn.getAttribute('data-mrv-delete');
      if (!canDelete()) { showError(ROLE_FORBIDDEN_TEXT); return; }
      showConfirm({
        text: 'למחוק את דיווח המנהל? הדיווח יוסר מהליד ולא ניתן יהיה לשחזר אותו.',
        confirmLabel: 'כן, מחק',
        danger: true,
        onConfirm: async () => {
          const ok = await deleteMeetingReport(id);
          // The block is gone from state; drop it from the DOM in place (a
          // failed save already re-rendered everything back via rollback).
          if (ok) el.remove();
        },
      });
    });
  }
}

/* ===== Manager meeting reports — edit / delete (PR 4, Vered-side only) =====
 *
 * Vered can correct or remove a manager's report from the expanded דיווח מנהל
 * block. EDIT rewrites content only (outcome / companion / note) — it never
 * touches meetingReporter, meetingReportedAt or meetingSeen, so the report
 * keeps its original attribution and timestamp: Vered is correcting, not
 * re-reporting (managers' own correction path stays resubmit-overwrite via
 * /meeting-report). DELETE clears ALL six report fields to '', so the block
 * disappears and the unseen dot / tab badge recompute (an empty
 * meetingReportedAt can never count as unseen). Both write through the same
 * optimistic updateLead→saveAll path as every inline lead edit — full row
 * preserved, rollback + renderAll + error on failure. */

/* Client-side mirror of the PR-2 submit constraints (submitMeetingReport_ in
 * Code.gs): outcome must be one of the 4 MEETING_REPORT_OUTCOME_LABELS keys,
 * companion is a preset key or אחר free text capped at 100 chars, note capped
 * at MANAGER_REPORT_MAX_CHARS. Keep in sync with the backend caps. */
const MEETING_REPORT_COMPANION_MAX = 100;

/* The ONLY cap on the manager report's פירוט free text — raised 2000 → 5000
 * (Sandra, Sep 2026). KEEP IN SYNC with MANAGER_REPORT_MAX_CHARS in
 * public/meeting-report.js, server.js and apps-script/Code.gs;
 * test/manager-report-length.test.js fails if the four drift apart or if any
 * other numeric literal caps this field. Over the cap REFUSES the save — the
 * text is never truncated. */
const MANAGER_REPORT_MAX_CHARS = 5000;

/* Where the live counter turns amber: derived from the cap (90% = 4500), so
 * raising the cap moves the warning with it and no second literal exists. */
const MANAGER_REPORT_WARN_CHARS = Math.round(MANAGER_REPORT_MAX_CHARS * 0.9);

/* Counter text under the פירוט textarea: 'X / 5000' inside a Unicode LTR
 * isolate (U+2066 … U+2069) so the RTL modal cannot re-order the two digit
 * runs around the slash. Pure. */
function managerReportCounterText(len) {
  const n = Number(len) > 0 ? Number(len) : 0;
  return `\u2066${n} / ${MANAGER_REPORT_MAX_CHARS}\u2069`;
}

/* true once the counter should go amber (strictly ABOVE the threshold). Pure. */
function managerReportCounterWarn(len) {
  return Number(len) > MANAGER_REPORT_WARN_CHARS;
}

/* '' when the edited values are saveable, otherwise a Hebrew error. Pure. */
function validateMeetingReportEdit({ outcome, companion, note }) {
  if (!outcome || !MEETING_REPORT_OUTCOME_LABELS[outcome]) return 'נא לבחור תוצאה';
  const comp = String(companion || '');
  if (!MEETING_COMPANION_LABELS[comp] && comp.length > MEETING_REPORT_COMPANION_MAX) {
    return `הטקסט של "מי הגיע איתו" מוגבל ל-${MEETING_REPORT_COMPANION_MAX} תווים`;
  }
  const noteLen = String(note || '').length;
  if (noteLen > MANAGER_REPORT_MAX_CHARS) {
    // Refuse, never trim — and report lengths only, never the text itself.
    return `הפירוט מוגבל ל-${MANAGER_REPORT_MAX_CHARS} תווים (נכתבו ${noteLen})`;
  }
  return '';
}

/* How the edit modal opens from the stored values: a preset meetingCompanion
 * key selects its chip; any other non-empty value is the אחר flow — the אחר
 * chip selected with the raw text in the free-text input; blank selects no
 * chip. Pure. */
function meetingReportEditPrefill(lead) {
  const companion = String((lead && lead.meetingCompanion) || '');
  let chip = '', otherText = '';
  if (MEETING_COMPANION_LABELS[companion]) chip = companion;
  else if (companion) { chip = 'other'; otherText = companion; }
  return {
    outcome: (lead && lead.meetingReportOutcome) || '',
    chip,
    otherText,
    note: (lead && lead.meetingNote) || '',
  };
}

/* The edit modal's markup, pre-filled from the lead (checked outcome radio,
 * selected companion chip, populated אחר input + note). Pure — built apart
 * from showMeetingReportEditModal so tests can assert the pre-fill without a
 * DOM. Same structure as showCloseLeadModal (radio fieldset + note textarea);
 * the chips mirror the manager form's. All values escaped. */
function meetingReportEditModalHTML(lead) {
  const pre = meetingReportEditPrefill(lead);
  const radios = Object.keys(MEETING_REPORT_OUTCOME_LABELS).map(key => `
    <label class="reason-radio">
      <input type="radio" name="mrvOutcome" value="${escapeHtml(key)}"${key === pre.outcome ? ' checked' : ''} />
      <span>${escapeHtml(MEETING_REPORT_OUTCOME_LABELS[key])}</span>
    </label>`).join('');
  const chips = Object.keys(MEETING_COMPANION_LABELS).map(key =>
    `<button type="button" class="mrv-chip${key === pre.chip ? ' selected' : ''}" data-mrv-chip="${escapeHtml(key)}">${escapeHtml(MEETING_COMPANION_LABELS[key])}</button>`
  ).join('');
  return `
    <div class="modal">
      <h3>עריכת דיווח מנהל</h3>
      <form>
        <div class="form-row">
          <fieldset class="reason-fieldset">
            <legend>תוצאה</legend>
            ${radios}
          </fieldset>
        </div>
        <div class="form-row">
          <label>מי הגיע איתו</label>
          <div class="mrv-chips">${chips}</div>
          <div class="mrv-other-wrap${pre.chip === 'other' ? '' : ' hidden'}">
            <input name="mrvCompanionOther" type="text" maxlength="${MEETING_REPORT_COMPANION_MAX}" placeholder="מי הגיע איתו?" value="${escapeHtml(pre.otherText)}" />
          </div>
        </div>
        <div class="form-row">
          <label>פירוט</label>
          <textarea name="mrvNote" class="mrv-note-input" rows="6" maxlength="${MANAGER_REPORT_MAX_CHARS}">${escapeHtml(pre.note)}</textarea>
          <div class="mrv-note-count" aria-live="polite">${escapeHtml(managerReportCounterText(String(pre.note || '').length))}</div>
        </div>
        <div class="form-actions">
          <button type="button" class="btn" data-action="cancel">ביטול</button>
          <button type="submit" class="btn primary">שמירה</button>
        </div>
      </form>
    </div>`;
}

/* Persist an edited report. Edit-mode gated like mark-seen; refuses values
 * that would fail the backend caps (mirrored client-side — showError, no
 * write). Writes ONLY the three content fields, so meetingReporter /
 * meetingReportedAt / meetingSeen ride through untouched (original
 * attribution + timestamp kept) — and the unchanged timestamp is exactly what
 * lets the edit through mergeLeads_'s report guard (equal timestamps → the
 * client's content wins).
 *
 * The race the guard can't let through silently: a manager RESUBMITTED (or
 * the report was deleted) after the modal opened, so this save carries a
 * timestamp that no longer matches the sheet's. The guard then keeps the
 * sheet's report and flags the leadId in the saveAll response's
 * `reportConflicts`; we surface that as a Hebrew conflict message and refresh
 * the data instead of pretending the edit saved. Returns true (saved),
 * 'conflict' (newer report won — data refreshed), or false (refused/failed —
 * rolled back). */
function saveMeetingReportEdit(leadId, { outcome, companion, note }) {
  if (state.mode !== 'edit') return Promise.resolve(false);
  const lead = state.leads.find(l => l.id === leadId);
  if (!lead || !lead.meetingReportedAt) return Promise.resolve(false);
  const err = validateMeetingReportEdit({ outcome, companion, note });
  if (err) { showError(err); return Promise.resolve(false); }

  // updateLead's optimistic pattern, inlined so the saveAll RESPONSE (which
  // carries reportConflicts) is visible — updateLead swallows it.
  const prev = { ...lead };
  Object.assign(lead, {
    meetingReportOutcome: outcome,
    meetingCompanion: String(companion || ''),
    meetingNote: String(note || ''),
  });
  return (async () => {
    try {
      const res = await saveAll();
      const conflicts = (res && res.reportConflicts) || [];
      if (conflicts.indexOf(String(leadId)) !== -1) {
        showError('דיווח המנהל השתנה בזמן העריכה (דיווח חדש או מחיקה) — העריכה לא נשמרה, הנתונים רועננו');
        await loadAll(); // pull the sheet's newer report state and re-render
        return 'conflict';
      }
      return true;
    } catch (e) {
      Object.assign(lead, prev);
      renderAll();
      showError('עדכון הדיווח נכשל — ' + e.message);
      return false;
    }
  })();
}

/* Remove a report — a DEDICATED backend action, not a saveAll field-clear.
 * Since the mergeLeads_ report guard (write-clobber fix), a saveAll carrying
 * empty report fields against a sheet row with a non-empty timestamp is a
 * stale echo by definition and the sheet wins — so clearing client-side would
 * silently no-op. deleteMeetingReport (Code.gs) clears the six fields on the
 * sheet row itself; on success the LOCAL copy is cleared too, so this tab's
 * next saveAll echoes the deletion (equal empty timestamps → guard inert) and
 * the badge recomputes optimistically. Failure rolls the local fields back
 * and re-renders. */
function deleteMeetingReport(leadId) {
  if (state.mode !== 'edit') return Promise.resolve(false);
  const lead = state.leads.find(l => l.id === leadId);
  if (!lead || !lead.meetingReportedAt) return Promise.resolve(false);

  const prev = { ...lead };
  ['meetingReportOutcome', 'meetingCompanion', 'meetingNote',
   'meetingReporter', 'meetingReportedAt', 'meetingSeen'].forEach(f => { lead[f] = ''; });
  renderMeetingsUnseenBadge();

  return (async () => {
    try {
      await apiPost({ action: 'deleteMeetingReport', leadId: String(leadId) });
      return true;
    } catch (e) {
      Object.assign(lead, prev);
      renderMeetingsUnseenBadge();
      renderAll();
      showError('מחיקת הדיווח נכשלה — ' + e.message);
      return false;
    }
  })();
}

/* Re-render one block in place after a successful edit (board and lead card
 * alike — no full re-render, so nothing else on screen is perturbed). Keeps
 * the open/collapsed state; removes the block when the lead no longer has a
 * report. */
function refreshMeetingReportBlock(el, leadId) {
  const lead = state.leads.find(l => l.id === leadId);
  const html = lead ? meetingReportBlockHTML(lead) : '';
  if (!html) { el.remove(); renderMeetingsUnseenBadge(); return; }
  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  const fresh = tmp.firstElementChild;
  if (el.classList.contains('open')) fresh.classList.add('open');
  el.replaceWith(fresh);
  wireMeetingReportToggle(fresh);
}

/* The edit modal itself. Hand-rolled on the showCloseLeadModal pattern (the
 * showModal field list can't express chips / a segmented radio group): chip
 * clicks re-select in place and toggle the אחר free-text row; submit resolves
 * the companion (chip key, or the trimmed free text under אחר), validates,
 * and saves via saveMeetingReportEdit. The submitting flag + disabled buttons
 * are the modal-form equivalent of busyButton — no double-fire. On a
 * refused validation or a failed save the modal stays open for retry
 * (updateLead already rolled back and surfaced the error). */
function showMeetingReportEditModal(lead, onSaved) {
  const root = document.getElementById('modal-root');
  const back = document.createElement('div');
  back.className = 'modal-backdrop';
  back.innerHTML = meetingReportEditModalHTML(lead);
  root.appendChild(back);

  const form       = back.querySelector('form');
  const cancelBtn  = back.querySelector('[data-action="cancel"]');
  const submitBtn  = back.querySelector('button[type="submit"]');
  const otherWrap  = back.querySelector('.mrv-other-wrap');
  const otherInput = back.querySelector('[name="mrvCompanionOther"]');
  let chip = meetingReportEditPrefill(lead).chip;

  back.querySelectorAll('[data-mrv-chip]').forEach(btn => {
    btn.addEventListener('click', () => {
      chip = btn.getAttribute('data-mrv-chip');
      back.querySelectorAll('[data-mrv-chip]').forEach(b => b.classList.toggle('selected', b === btn));
      otherWrap.classList.toggle('hidden', chip !== 'other');
      if (chip === 'other') otherInput.focus();
    });
  });

  /* פירוט: live 'X / 5000' counter (amber past MANAGER_REPORT_WARN_CHARS) and
   * auto-grow, so Vered can read and correct a full 5,000-char report without
   * scrolling a 3-row box. Nothing here blocks a save — the cap is enforced by
   * maxlength + validateMeetingReportEdit + the backend. */
  const noteInput = back.querySelector('[name="mrvNote"]');
  const noteCount = back.querySelector('.mrv-note-count');
  const MRV_NOTE_MAX_HEIGHT = 420; // px — past this the textarea scrolls itself
  const syncNote = () => {
    if (!noteInput) return;
    const len = noteInput.value.length;
    if (noteCount) {
      noteCount.textContent = managerReportCounterText(len);
      noteCount.classList.toggle('warn', managerReportCounterWarn(len));
    }
    noteInput.style.height = 'auto';
    noteInput.style.height = Math.min(noteInput.scrollHeight, MRV_NOTE_MAX_HEIGHT) + 'px';
  };
  if (noteInput) { noteInput.addEventListener('input', syncNote); syncNote(); }

  const close = () => back.remove();
  cancelBtn.onclick = close;
  back.addEventListener('click', e => { if (e.target === back) close(); });

  /* Busy discipline via the shared busyButton pattern: the save button goes
   * disabled + aria-busy + spinner + «שומר…» for the whole round-trip and is
   * restored by busyButton's finally on every exit — saved, conflicted,
   * refused by validation, or a thrown save. A second submit while busy is
   * dropped by busyButton itself, so no local `submitting` flag is needed.
   * ביטול is frozen alongside it (and thawed in the same finally) so the modal
   * cannot be dismissed out from under an in-flight write. */
  form.onsubmit = e => {
    e.preventDefault();
    return busyButton(submitBtn, 'save', async () => {
      cancelBtn.disabled = true;
      try {
        const fd = new FormData(form);
        const outcome   = (fd.get('mrvOutcome') || '').toString();
        const companion = chip === 'other'
          ? (fd.get('mrvCompanionOther') || '').toString().trim()
          : chip;
        const note      = (fd.get('mrvNote') || '').toString().trim();

        const ok = await saveMeetingReportEdit(lead.id, { outcome, companion, note });
        // A raced manager resubmit/delete: the edit did NOT save; loadAll already
        // refreshed everything (this block's DOM included), so just close — the
        // modal's content is built on a report that no longer exists as-was.
        if (ok === 'conflict') { close(); return; }
        if (ok) { close(); if (onSaved) onSaved(); return; }
        // Refused or failed — the error is already shown and the modal stays
        // open; busyButton's finally hands the button back for a retry.
      } finally {
        cancelBtn.disabled = false;
      }
    });
  };
}

/* The meetingOutcome keys that count as "the meeting was held" (התקיימו) — the
 * denominator of the conversion rate. postponed/cancelled are outcomes too (they
 * count toward `total`) but the meeting did not take place, so they are excluded
 * from `held` and from the rate. */
const HELD_OUTCOMES = ['not_relevant', 'thinking', 'entered'];
/* Stable bucket for leads that have an outcome but no meetingWith — they still
 * count (never silently dropped); rendered under this label. */
const MANAGER_CONVERSION_UNASSIGNED = 'ללא מנהל';

/* Per-manager meeting→treatment conversion over ALL leads (all-time, not just
 * the displayed week) — the real conversion metric the Managers app will reuse.
 * A meeting "counts" once its lead has a (valid) meetingOutcome. Returns one row
 * per manager that has at least one such lead:
 *   total     = leads with ANY valid outcome (incl. postponed/cancelled)
 *   held      = outcomes in HELD_OUTCOMES ("התקיימו")
 *   converted = outcomes === 'entered' ("נכנסו")
 *   rate      = round(converted / held * 100); 0 when held === 0 (no div-by-zero)
 * Leads with an outcome but a blank meetingWith are grouped under
 * MANAGER_CONVERSION_UNASSIGNED. Sorted by held desc, then name asc. Pure — no
 * DOM, no state — so it is unit-tested directly. */
function computeManagerConversion(leads) {
  const by = new Map();
  (leads || []).forEach(l => {
    const outcome = l && l.meetingOutcome;
    if (!outcome || !MEETING_OUTCOME_LABELS[outcome]) return;   // no/invalid outcome → ignored
    const mgr = (l.meetingWith && String(l.meetingWith).trim()) || MANAGER_CONVERSION_UNASSIGNED;
    let row = by.get(mgr);
    if (!row) { row = { manager: mgr, total: 0, held: 0, converted: 0 }; by.set(mgr, row); }
    row.total += 1;
    if (HELD_OUTCOMES.indexOf(outcome) !== -1) row.held += 1;
    if (outcome === 'entered') row.converted += 1;
  });
  const rows = Array.from(by.values()).map(r => Object.assign({}, r, {
    rate: r.held === 0 ? 0 : Math.round((r.converted / r.held) * 100),
  }));
  rows.sort((a, b) => (b.held - a.held) ||
    (a.manager < b.manager ? -1 : a.manager > b.manager ? 1 : 0));
  return rows;
}

/* Compact per-manager conversion strip rendered above the board. Returns '' when
 * no manager has an outcome yet (nothing to show). RTL-safe; styling reuses the
 * board's surface/border tokens. */
function meetingsSummaryHTML(leads, managers) {
  /* CURRENT managers only (state.currentManagers / houseManagers): a former
   * manager's row and the ללא מנהל bucket are not shown. The counts are
   * computeManagerConversion's, unchanged — this only picks which rows to show. */
  const current = managerOptions(managers);
  const rows = computeManagerConversion(leads)
    .filter(r => r.manager !== MANAGER_CONVERSION_UNASSIGNED && current.indexOf(r.manager) !== -1);
  if (!rows.length) return '';
  /* Band class for the percentage pill: ≥80 green, 50–79 amber, <50 red
   * (style.css .mtg-sum-rate.rate-*). Pure presentation — rate math unchanged. */
  const band = rate => (rate >= 80 ? 'rate-high' : rate >= 50 ? 'rate-mid' : 'rate-low');
  const items = rows.map(r => `
      <div class="mtg-sum-row">
        <span class="mtg-sum-mgr">${escapeHtml(r.manager)}</span>
        <span class="mtg-sum-sep">·</span><span class="mtg-sum-stat">פגישות: <b>${r.total}</b></span>
        <span class="mtg-sum-sep">·</span><span class="mtg-sum-stat">התקיימו: <b>${r.held}</b></span>
        <span class="mtg-sum-sep">·</span><span class="mtg-sum-stat">נכנסו: <b>${r.converted}</b></span>
        <span class="mtg-sum-sep">·</span><span class="mtg-sum-rate ${band(r.rate)}">${r.rate}%</span>
      </div>`).join('');
  return `
    <div class="mtg-summary">
      <div class="mtg-summary-head">המרת פגישות למנהל</div>
      ${items}
    </div>`;
}

/* Render one meeting row (RTL). Missing fields render as an em dash so columns
 * stay aligned. The WhatsApp cell is a real link when meetingWith resolves to a
 * phone, otherwise a disabled button (never a link to nobody). Read-only —
 * clicking opens WhatsApp in a new tab and never writes. `showOutcome` gates the
 * outcome <select> (true only for today-or-earlier rows; see renderMeetings). */
function meetingRowHTML(m, timeText, showOutcome) {
  const url = meetingWhatsappUrl(m);
  const wa = url
    ? `<a class="mtg-wa" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">WhatsApp</a>`
    : `<button type="button" class="mtg-wa" disabled title="אין מספר להצגה">WhatsApp</button>`;
  /* Edit (✏️) — edit mode only (it writes via updateLead→saveAll, which no-ops
   * for viewers). data-mtg-edit carries the lead id so renderMeetings can wire
   * the click without threading the meeting object through the HTML. */
  const edit = state.mode === 'edit'
    ? `<button type="button" class="mtg-edit" data-mtg-edit="${escapeHtml(m.id || '')}" title="ערוך פגישה">✏️</button>`
    : '';
  /* Outcome selector — only on today-or-earlier rows, and only in edit mode
   * (viewers never write; saveAll no-ops for them and there is nothing to pick). */
  const outcome = (showOutcome && state.mode === 'edit') ? meetingOutcomeSelectHTML(m) : '';
  /* Manager report (PR 3): the read-only דיווח מנהל block renders directly
   * under the row it belongs to — '' when the lead has no report. */
  return `
    <div class="mtg-row">
      <span class="mtg-time">${escapeHtml(timeText || m.time || '—')}</span>
      <span class="mtg-name">${escapeHtml(m.name || '—')}</span>
      <span class="mtg-house">${escapeHtml(m.houseLabel || '—')}</span>
      <span class="mtg-with">${escapeHtml(m.meetingWith || '—')}</span>
      <span class="mtg-actions">${outcome}${wa}${edit}</span>
    </div>${meetingReportBlockHTML(m)}`;
}

function renderMeetings() {
  const board = document.getElementById('meetings-board');
  if (!board) return;

  if (!state.meetingsWeekStart) state.meetingsWeekStart = weekStartSunday(todayISO());
  const wk = meetingsForWeek(state.leads, state.meetingsWeekStart);

  const rangeLabel = `${formatDateHe(wk.weekStart)} – ${formatDateHe(wk.weekEnd)}`;

  /* Per-manager conversion strip — computed over ALL leads (all-time), so it
   * renders even in a week with no meetings and reflects every recorded outcome. */
  const summary = meetingsSummaryHTML(state.leads);

  const today = todayISO();
  let body;
  if (wk.total === 0) {
    body = `<div class="mtg-empty">אין פגישות מתוזמנות לשבוע זה</div>`;
  } else {
    body = wk.days.map(d => {
      const isToday = d.iso === today;
      const rows = d.timed.map(m => meetingRowHTML(m, undefined, meetingOutcomeEligible(m.date, today))).join('');
      const noTimeBlock = d.noTime.length
        ? `<div class="mtg-notime-head">ללא שעה</div>` +
          d.noTime.map(m => meetingRowHTML(m, '—', meetingOutcomeEligible(m.date, today))).join('')
        : '';
      const todayBadge = isToday ? `<span class="mtg-today-badge">היום</span>` : '';
      return `
        <section class="mtg-day${isToday ? ' mtg-today' : ''}">
          <h3 class="mtg-day-head">${escapeHtml(HEBREW_DAYS[d.dow])} · ${escapeHtml(formatDateHe(d.iso))}${todayBadge}</h3>
          <div class="mtg-rows">${rows}${noTimeBlock}</div>
        </section>`;
    }).join('');
  }

  board.innerHTML = `
    <div class="mtg-nav">
      <button type="button" class="btn" data-mtg="prev">← שבוע קודם</button>
      <button type="button" class="btn" data-mtg="today">השבוע</button>
      <button type="button" class="btn" data-mtg="next">שבוע הבא →</button>
      <span class="mtg-range">${escapeHtml(rangeLabel)}</span>
    </div>
    ${summary}
    <div class="mtg-list">${body}</div>`;

  board.querySelector('[data-mtg="prev"]').onclick = () => {
    state.meetingsWeekStart = addDaysISO(state.meetingsWeekStart, -7);
    renderMeetings();
  };
  board.querySelector('[data-mtg="next"]').onclick = () => {
    state.meetingsWeekStart = addDaysISO(state.meetingsWeekStart, 7);
    renderMeetings();
  };
  board.querySelector('[data-mtg="today"]').onclick = () => {
    state.meetingsWeekStart = weekStartSunday(todayISO());
    renderMeetings();
  };

  /* Supplement each WhatsApp link's click so it works in a standalone PWA
   * (where <a target="_blank"> to an external origin is silently dropped). The
   * anchor stays for hover-preview / right-click-copy; here we take over the
   * click and route through openWhatsAppLink (window.open → location fallback). */
  board.querySelectorAll('a.mtg-wa').forEach(a => {
    a.addEventListener('click', e => {
      const url = a.getAttribute('href');
      if (!url) return;
      e.preventDefault();
      openWhatsAppLink(url);
    });
  });

  /* Edit (✏️) — open the per-meeting edit modal. Look the meeting up by lead id
   * from the week's buckets so the modal pre-fills from the same normalized data
   * the row rendered. Edit buttons only exist in edit mode (see meetingRowHTML). */
  const meetingsById = {};
  wk.days.forEach(d => d.timed.concat(d.noTime).forEach(m => { meetingsById[m.id] = m; }));
  board.querySelectorAll('.mtg-edit').forEach(btn => {
    btn.addEventListener('click', () => {
      const m = meetingsById[btn.getAttribute('data-mtg-edit')];
      if (m) openMeetingEditModal(m);
    });
  });

  /* Outcome <select> — persist the picked value through the SAME per-row path
   * the lead-card inline fields use (updateLead → saveAll, optimistic + rollback).
   * On success re-render the board only (updates the summary strip + the row's
   * selected value); NOT renderAll — that would fire autosaveMeetingWithDefaults
   * and its busy-flag guard, which this edit must not perturb. On failure
   * updateLead already rolled back and surfaced the error. */
  board.querySelectorAll('.mtg-outcome').forEach(sel => {
    sel.addEventListener('change', () => withFieldSaving(sel, 'save', async () => {
      const id = sel.getAttribute('data-mtg-outcome');
      if (!id) return;
      const ok = await updateLead(id, { meetingOutcome: sel.value });
      if (ok) renderMeetings();
    }));
  });

  /* Manager-report blocks (PR 3): click to expand the detail; opening an
   * unseen report marks it seen in place (see wireMeetingReportToggle). */
  board.querySelectorAll('[data-mrv-toggle]').forEach(wireMeetingReportToggle);

  /* Keep the tab badge in step with every board refresh (renderAll included). */
  renderMeetingsUnseenBadge();
}

/* Per-meeting edit modal (meetings board). Edits map to the underlying lead's
 * visitDate / visitTime / meetingWith and persist through the SAME per-row save
 * path the lead-card inline fields use (updateLead → saveAll) — no new endpoint.
 * The modal also carries a "שלח עדכון" WhatsApp button that builds the 'update'
 * message from the modal's CURRENT (live) field values and sends it to the lead.
 * On a successful save the board re-renders so the row reflects the change. */
function openMeetingEditModal(m) {
  const lead = state.leads.find(l => l.id === m.id);
  if (!lead) return;

  const root = document.getElementById('modal-root');
  const back = document.createElement('div');
  back.className = 'modal-backdrop';

  const timeOptsHtml = visitTimeOptions(m.time).map(o =>
    `<option value="${escapeHtml(o.value)}" ${o.value === (m.time || '') ? 'selected' : ''}>${escapeHtml(o.label)}</option>`
  ).join('');
  const withOptsHtml = [{ value: '', label: '— ללא —' }]
    .concat(meetingWithOptionNames(m.meetingWith).map(name => ({ value: name, label: name })))
    .map(o => `<option value="${escapeHtml(o.value)}" ${o.value === (m.meetingWith || '') ? 'selected' : ''}>${escapeHtml(o.label)}</option>`)
    .join('');

  back.innerHTML = `
    <div class="modal">
      <h3>עריכת פגישה</h3>
      <form>
        <div class="form-row">
          <label>תאריך</label>
          <input type="date" name="visitDate" lang="he" dir="rtl" value="${escapeHtml(m.date || '')}" />
        </div>
        <div class="form-row">
          <label>שעה</label>
          <select name="visitTime">${timeOptsHtml}</select>
        </div>
        <div class="form-row">
          <label>נפגש עם</label>
          <select name="meetingWith">${withOptsHtml}</select>
        </div>
        <div class="form-actions">
          <button type="button" class="mtg-wa mtg-update-wa" title="שלח עדכון בוואטסאפ">שלח עדכון</button>
          <button type="button" class="btn" data-action="cancel">ביטול</button>
          <button type="submit" class="btn primary">שמור</button>
        </div>
      </form>
    </div>
  `;
  root.appendChild(back);

  const form      = back.querySelector('form');
  const dateInp   = form.querySelector('[name="visitDate"]');
  const timeInp   = form.querySelector('[name="visitTime"]');
  const withInp   = form.querySelector('[name="meetingWith"]');
  const updateBtn = form.querySelector('.mtg-update-wa');
  const cancelBtn = back.querySelector('[data-action="cancel"]');
  const submitBtn = back.querySelector('button[type="submit"]');

  const close = () => back.remove();
  cancelBtn.onclick = close;
  back.addEventListener('click', e => { if (e.target === back) close(); });

  /* "שלח עדכון" — build the update message from the modal's LIVE values (not the
   * pre-edit meeting), so sending after changing a field reflects the new plan
   * even before saving. Sent to the lead's billing/updates phone (falls back to
   * the patient phone) via the shared PWA-safe opener. */
  updateBtn.onclick = () => {
    const msg = buildMeetingMessage({
      type: 'update', name: lead.name, manager: withInp.value,
      house: lead.house, dateISO: dateInp.value, time: timeInp.value,
    });
    openWhatsAppLink(meetingInviteWaUrl(leadBillingPhone(lead), msg));
  };

  form.onsubmit = e => {
    e.preventDefault();
    return busyButton(submitBtn, 'save', async () => {
      cancelBtn.disabled = true;
      try {
        const ok = await updateLead(m.id, {
          visitDate: dateInp.value, visitTime: timeInp.value, meetingWith: withInp.value,
        });
        if (ok) { close(); renderMeetings(); }
        // Refused/failed: updateLead already rolled back and surfaced the error,
        // and busyButton's finally hands the button back for a retry.
      } finally {
        cancelBtn.disabled = false;
      }
    });
  };
}

function renderAll() {
  // The controller view: «בקרת גבייה», and «גבייה» read-only when allowed.
  if (controllerView()) {
    renderBillingControl();
    if (billingReadView()) { renderBilling(); renderCreditsPayouts(); }
    return;
  }
  renderDashboard();
  renderCoordinatorDischarges();
  renderKanban();
  renderPatientsTab();
  renderMeetings();
  renderIrrelevantLeads();
  renderRemovedLeads();
  renderHouseTabs();
  renderPatients();
  renderDischargedPatients();
  renderBilling();
  renderCreditsPayouts();
  renderMonthlyRevenue();
  renderReconnect();
  renderBreakeven();
  renderGrowthGraph();
  renderBillingControl();
  /* Backfill + persist any visit-stage lead whose meetingWith default was only
   * rendered, never saved. Fire-and-forget: one batched saveAll, re-entry- and
   * idempotency-guarded so it never loops or storms. */
  autosaveMeetingWithDefaults();
}

/* ====================================================
   NUMBER FIT — never clip a KPI value
   ==================================================== */
/* Shrink one value element's font-size until its single-line content fits its
 * box. Large currency figures (e.g. ₪1,513,200) otherwise overflow a narrow
 * card and get clipped by `.card { overflow:hidden }` — in RTL that cuts the
 * LEADING digits, so ₪1,513,200 read as "₪3,200". Starts from the CSS font-size
 * and steps down to a floor. No-op when the element isn't laid out yet
 * (clientWidth 0, e.g. a hidden screen) or already fits — so it's cheap and
 * safe to call after every render. */
function fitStatText(el, minPx) {
  if (!el || !el.clientWidth) return;
  const floor = minPx || 14;
  el.style.fontSize = '';                       // reset to the CSS-driven size
  if (typeof getComputedStyle !== 'function') return;
  let size = parseFloat(getComputedStyle(el).fontSize) || 0;
  if (!size) return;
  let guard = 80;                               // bounded loop (42px→14px is ~28 steps)
  while (el.scrollWidth > el.clientWidth && size > floor && guard-- > 0) {
    size -= 1;
    el.style.fontSize = size + 'px';
  }
}

/* Fit every currency/number value on the dashboard and the נקודת איזון tab. */
function fitAllStatText(root) {
  const scope = root || document;
  if (!scope.querySelectorAll) return;
  scope.querySelectorAll('.card.stat .stat-value, .be-metric-value')
    .forEach(el => fitStatText(el));
}

/* Re-fit on viewport changes (rotation / resize) so a value that fit in one
 * orientation isn't clipped in another. Debounced; safe when nothing matches. */
let _statFitTimer = null;
function onStatViewportChange() {
  clearTimeout(_statFitTimer);
  _statFitTimer = setTimeout(() => fitAllStatText(), 150);
}
if (typeof window !== 'undefined' && window.addEventListener) {
  window.addEventListener('resize', onStatViewportChange);
  window.addEventListener('orientationchange', onStatViewportChange);
}

/* ====================================================
   DASHBOARD
   ==================================================== */
/* Dashboard "הכנסות חודשיות" KPI, ex-VAT. `pay` (תשלום חודשי) is stored
 * VAT-inclusive, so sum active patients' pay and divide by the shared VAT_RATE,
 * then round. Pure + testable, and it reconciles with the per-house ex-VAT
 * revenue on the נקודת איזון tab (each house = actualRevenuePerHouse / VAT_RATE):
 * the sum of the per-house revenues equals this total, rounding aside. */
function dashboardMonthlyRevenueExVat(patients) {
  const inclVat = (patients || [])
    .filter(p => p.status !== 'released')
    .reduce((s, p) => s + (Number(p.pay) || 0), 0);
  return Math.round(inclVat / VAT_RATE);
}

function renderDashboard() {
  const activePatients = state.patients.filter(p => p.status !== 'released');
  const totalCap = HOUSES.reduce((s, h) => s + h.capacity, 0);
  const occupied = activePatients.length;
  const pct = totalCap ? Math.round((occupied / totalCap) * 100) : 0;
  document.getElementById('stat-occ-pct').textContent = pct + '%';
  document.getElementById('stat-occ-bar').style.width = pct + '%';
  document.getElementById('stat-occ-sub').textContent = `${occupied} / ${totalCap} מיטות`;
  document.getElementById('stat-active').textContent = occupied;

  const revenue = dashboardMonthlyRevenueExVat(state.patients);
  document.getElementById('stat-revenue').textContent = '₪ ' + revenue.toLocaleString('he-IL');

  const grid = document.getElementById('houses-grid');
  grid.innerHTML = '';
  HOUSES.forEach(h => {
    const inHouse = activePatients.filter(p => p.houseId === h.id).length;
    const free = h.capacity - inHouse;
    const housePct = Math.round((inHouse / h.capacity) * 100);
    const card = document.createElement('div');
    card.className = 'house-card';
    card.innerHTML = `
      <div class="h-name">${h.name}</div>
      <div class="h-stats">${inHouse} / ${h.capacity} מאוכלסים</div>
      <span class="h-beds ${free === 0 ? 'full' : ''}">${free === 0 ? 'מלא' : free + ' מיטות פנויות'}</span>
      <div class="progress"><div class="progress-bar" style="width:${housePct}%"></div></div>
    `;
    grid.appendChild(card);
  });

  const pipe = document.getElementById('pipeline-row');
  pipe.innerHTML = '';
  ALL_STAGES_FOR_PIPELINE.forEach(s => {
    // Irrelevant leads now live on their own sheet (state.irrelevantLeads)
    // after being moved; the pipeline pill should reflect that count.
    const count = s.id === 'irrelevant'
      ? (state.irrelevantLeads.length + state.leads.filter(l => l.stage === 'irrelevant').length)
      : state.leads.filter(l => l.stage === s.id).length;
    const el = document.createElement('div');
    el.className = 'pipe';
    el.dataset.stage = s.id;
    el.innerHTML = `<div class="p-name">${s.label}</div><div class="p-count">${count}</div>`;
    pipe.appendChild(el);
  });

  fitAllStatText(); // scale KPI values down to fit narrow cards (no clipping)
  renderRenewalAlert();
  renderOverdueAlert();
}

/* Dashboard renewal alert — active patients due to renew within 7 days whose
 * upcoming cycle isn't already paid. Hidden entirely when the list is empty.
 * Each row offers RENEW (writes next month's payment) and DISCHARGE (opens the
 * existing שחרור modal). Action buttons carry `edit-only` so they're hidden in
 * viewer mode, matching the rest of the app. */
function renderRenewalAlert() {
  if (!financeView()) return; // restricted view: no billing UI at all
  const wrap    = document.getElementById('renewal-alert');
  const listEl  = document.getElementById('renewal-alert-list');
  const countEl = document.getElementById('renewal-alert-count');
  if (!wrap || !listEl) return;

  const list = patientsNeedingRenewal(todayISO(), 7);
  if (countEl) countEl.textContent = list.length;

  if (!list.length) {
    wrap.classList.add('hidden');
    listEl.innerHTML = '';
    return;
  }
  wrap.classList.remove('hidden');
  listEl.innerHTML = '';

  list.forEach(({ patient, renewalISO, days }) => {
    const house = houseById(patient.houseId);
    const daysLabel = days === 0 ? 'היום' : `בעוד ${days} ימים`;
    const row = document.createElement('div');
    row.className = 'renewal-row';
    row.innerHTML = `
      <div class="rn-info">
        <span class="rn-name">${escapeHtml(patient.name)}</span>
        <span class="rn-house">${escapeHtml(house ? house.name : patient.houseId)}</span>
      </div>
      <div class="rn-when">
        <span class="rn-date">חידוש ${escapeHtml(formatDate(renewalISO))}</span>
        <span class="rn-days">${escapeHtml(daysLabel)}</span>
      </div>
      <div class="rn-actions edit-only">
        <button class="btn small primary" data-action="renew">חידוש תשלום</button>
        <button class="btn small" data-action="discharge">שחרור</button>
      </div>`;
    row.querySelector('[data-action="renew"]').onclick = () =>
      confirmRenewPatient(patient, renewalISO);
    row.querySelector('[data-action="discharge"]').onclick = () => dischargePatient(patient);
    listEl.appendChild(row);
  });
}

/* RENEW — record next month's charge for `patient` on its renewal due date.
 * Reuses the billing write path exactly: build the (patient, dueDate) payment
 * via paymentForPatientOnDate, mark it paid, and persist with savePayment
 * (which already does optimistic upsert + rollback on failure). Because the
 * renewal date is derived from the patient's billing schedule, writing this
 * payment marks the upcoming cycle covered — so the patient drops off the
 * alert and the next occurrence advances a month automatically. */
/* The amount a renewal will charge for (patient, dueDate) — the existing
 * payment record's amount when one exists, else the patient's base pay. Shared
 * by the confirm-modal text and the actual write so they can never disagree.
 * Pure + tested. */
function renewalAmount(patient, dueDateISO) {
  const base = paymentForPatientOnDate(patient, dueDateISO);
  return base.amount || patient.pay || 0;
}

/* חידוש תשלום entry point — a renewal now requires explicit confirmation
 * (Sandra accidentally renewed a real patient off the one-click button).
 * Opens the standard confirm dialog naming the patient, the amount, and the
 * due date; only אישור fires the write.
 *
 * This is ALSO the spinner fix: renewPatient's optimistic update re-renders
 * the renewals list synchronously, which destroys the clicked row button in
 * the same tick — so a busy state on the ROW button (the R3 approach) never
 * survived to a paint. showConfirm's busy discipline lives on the modal's
 * confirm button inside #modal-root, which no list re-render touches, so the
 * spinner now stays visible for the whole round-trip (renewPatient returns
 * its settle promise; the dialog stays open + frozen until it resolves). */
/* Phase 3 PR 2: a renewal is money received like any other, so «חידוש
 * תשלום» opens the strict «דווח תשלום» form for the renewal cycle (prefilled
 * with its amount and window) instead of marking the cycle paid. The report
 * creates the receipt; the derived cycle status takes the patient off the
 * alert. renewPatient (below) is no longer reachable from the UI. */
function confirmRenewPatient(patient, dueDateISO) {
  if (state.mode !== 'edit') return;
  openPaymentReportModal(patient, paymentForPatientOnDate(patient, dueDateISO), dueDateISO);
}

function renewPatient(patient, dueDateISO) {
  if (state.mode !== 'edit') return;

  const base   = paymentForPatientOnDate(patient, dueDateISO);
  const amount = renewalAmount(patient, dueDateISO);
  const payment = normalizePayment({
    ...base,
    patientId:   base.patientId   || patientKey(patient),
    patientName: base.patientName || patient.name || '',
    houseId:     base.houseId     || patient.houseId || '',
    amount,
    status:      'paid',
    amountPaid:  amount,
    balance:     0,
    timestamp:   new Date().toISOString(),
  });

  // savePayment applies the optimistic local upsert synchronously, then awaits
  // persistence and rolls back itself on failure. Re-render the dashboard right
  // away (optimistic — the row disappears), then again after the round-trip so
  // a rollback re-shows it. Mirrors closeLead's optimistic-then-reconcile move.
  // Return the settle promise so the renew button's busy wrapper can track it.
  const saved = savePayment(payment);
  renderDashboard();
  return Promise.resolve(saved).then(() => {
    renderDashboard();
    // Confirm only if the paid record actually survived. savePayment swallows
    // its own errors (rolls back state.payments + showError on failure), so the
    // promise resolves either way — check that the paid payment is still in
    // state before claiming success, mirroring the other write paths' toast.
    if (state.payments.some(x => x.id === payment.id && x.status === 'paid')) {
      showToast(`חידוש נרשם — ${patient.name}`);
    }
  });
}

/* ====================================================
   LEADS / KANBAN
   ==================================================== */
function renderKanban() {
  const kanban = document.getElementById('kanban');
  kanban.innerHTML = '';
  STAGES.forEach(stage => {
    const col = document.createElement('div');
    col.className = 'col';
    col.dataset.stage = stage.id;

    const filtered = filterLeads().filter(l => l.stage === stage.id);
    /* Default-sort the "ליד חדש" column by creation date, newest first.
     * Leads with no created timestamp (legacy rows that pre-date the field)
     * sort to the bottom, which keeps the newest activity at the top of the
     * board without dropping legacy rows. Other stages keep their existing
     * insertion order — sorting visit/paid/entry by created date would be
     * misleading since stage progression is the primary signal there. */
    if (stage.id === 'new') {
      filtered.sort((a, b) => {
        const ac = isoDate(a.created || '') || '';
        const bc = isoDate(b.created || '') || '';
        if (!ac && !bc) return 0;
        if (!ac) return 1;
        if (!bc) return -1;
        return bc.localeCompare(ac);
      });
    }
    col.innerHTML = `
      <div class="col-head">
        <span class="col-title">${stage.label}</span>
        <span class="col-count">${filtered.length}</span>
      </div>
    `;

    filtered.forEach(lead => col.appendChild(buildLeadCard(lead)));
    kanban.appendChild(col);
  });
  renderUnadmittedLeadsBadge();
}

/* Whether a lead matches the search box query `q` (already trimmed+lowercased by
 * the input handler). Pure + exported for tests. Text fields (name, house,
 * contactName) match by lowercased substring — today's behavior for name/house,
 * now extended to the referrer name. Phone fields (patient phone, contactPhone,
 * billingPhone) match either by raw lowercased substring (unchanged patient-phone
 * behavior — a partial as-displayed still hits) OR by normalized-digit substring,
 * so "050-12" and "+97250 12" find the same lead regardless of formatting. */
function leadMatchesQuery(lead, q) {
  if (!q) return true;
  const ql = String(q).toLowerCase();
  const text = [lead.name, lead.house, lead.contactName];
  if (text.some(v => String(v == null ? '' : v).toLowerCase().includes(ql))) return true;
  const qDigits = normalizePhone(q);
  return [lead.phone, lead.contactPhone, lead.billingPhone].some(p => {
    const s = String(p == null ? '' : p).toLowerCase();
    if (s.includes(ql)) return true;
    return !!qDigits && normalizePhone(p).includes(qDigits);
  });
}

function filterLeads() {
  const q = state.leadSearch;
  return state.leads.filter(l => {
    if (l.stage === 'irrelevant') return false; // hidden from board, but counted in pipeline + on dashboard
    return leadMatchesQuery(l, q);
  });
}

/* Compact "פונה" line for a lead card (view mode). Rendered only when the
 * referrer has a name or phone; empty parts are omitted cleanly. A subtle
 * "גבייה" tag sits next to the contact phone when billingPhone resolves to it. */
function leadContactLineHTML(lead) {
  const name  = lead.contactName || '';
  const phone = lead.contactPhone || '';
  const rel   = lead.contactRelation || '';
  if (!name && !phone) return '';
  const billOnContact = leadBillingDiffersFromPatient(lead) &&
    normalizePhone(lead.billingPhone) === normalizePhone(lead.contactPhone);
  const billTag = billOnContact ? ' <span class="lc-bill-tag">גבייה</span>' : '';
  const parts = [];
  if (name)  parts.push(escapeHtml(name));
  if (phone) parts.push(escapeHtml(phone) + billTag);
  let line = parts.join(' · ');
  if (rel) line += ` (${escapeHtml(rel)})`;
  return `<div class="lc-contact"><span class="lc-contact-label">פונה:</span> ${line}</div>`;
}

/* Separate billing line for the case where billingPhone is an "אחר" number —
 * one that is neither the patient phone nor the contact phone, so it isn't shown
 * anywhere else. When billing resolves to the patient (default) or the contact
 * phone, nothing renders here (the contact-line tag covers the contact case). */
function leadBillingLineHTML(lead) {
  if (!leadBillingDiffersFromPatient(lead)) return '';
  const b = normalizePhone(lead.billingPhone);
  if (b && b === normalizePhone(lead.contactPhone)) return '';
  return `<div class="lc-billing"><span class="lc-bill-tag">גבייה</span> ${escapeHtml(lead.billingPhone)}</div>`;
}

/* <option> markup for the inline card's קשר למטופל select, built from the same
 * contactRelationOptions the modals use so the surfaces cannot drift. The
 * stored value is always among them (an off-list legacy value gets its own
 * pinned option), so `selected` can never fall through to the blank. */
function contactRelationOptionsHTML(stored) {
  const v = String(stored == null ? '' : stored);
  return contactRelationOptions(v).map(o =>
    `<option value="${escapeHtml(o.value)}"${o.value === v ? ' selected' : ''}>${escapeHtml(o.label)}</option>`
  ).join('');
}

/* Edit-mode inline block: פרטי הפונה fields + the billing selector, all inside
 * the card. contactName/contactPhone/contactRelation use the generic
 * [data-field] → updateLead autosave path; the billing mode select + free input
 * are wired separately in buildLeadCard (they resolve to a single billingPhone
 * string, so they can't use the 1:1 data-field mapping). */
function leadContactEditHTML(lead) {
  const init = billingModeForLead(lead);
  const modeOpt = (v, label) => `<option value="${v}"${init.mode === v ? ' selected' : ''}>${label}</option>`;
  return `
    <div class="lc-contact-edit edit-only">
      <div class="lc-section-head">פרטי הפונה</div>
      <input type="text" data-field="contactName"     value="${escapeHtml(lead.contactName || '')}"     placeholder="שם הפונה" />
      <input type="tel"  data-field="contactPhone"    value="${escapeHtml(lead.contactPhone || '')}"    placeholder="טלפון הפונה" />
      <label class="lc-field-label">קשר למטופל</label>
      <select class="lc-relation" data-field="contactRelation">${contactRelationOptionsHTML(lead.contactRelation)}</select>
      <input type="text" class="lc-relation-other" value="" placeholder="קשר אחר"${lead.contactRelation === CONTACT_RELATION_OTHER ? '' : ' style="display:none"'} />
      <label class="lc-field-label">טלפון לגבייה ועדכונים</label>
      <select class="lc-billing-mode">${modeOpt('patient', 'מטופל')}${modeOpt('contact', 'פונה')}${modeOpt('other', 'אחר')}</select>
      <input type="tel" class="lc-billing-other" value="${escapeHtml(init.mode === 'other' ? init.other : '')}" placeholder="מספר טלפון אחר"${init.mode === 'other' ? '' : ' style="display:none"'} />
    </div>`;
}

/* ===== Waitlist waiting-duration badge ===== */

/* Whole days the lead has been waiting: a calendar-date diff (not an hour
 * diff) from waitlistedAt to today. isoDate collapses both a bare YYYY-MM-DD
 * and a full ISO timestamp to the LOCAL calendar day (its bare-date regex is
 * anchored on purpose — prefix-matching a timestamp is the UTC-day bug); the
 * diff itself is then computed in UTC space so a DST transition inside the
 * span can't produce an off-by-one. Returns null when waitlistedAt is blank
 * or unparseable (legacy/edge rows) — callers render no badge, never NaN. A
 * future-dated stamp (clock skew) clamps to 0. `now` is injectable for tests;
 * production callers omit it. Pure. */
function waitlistDayCount(waitlistedAt, now) {
  const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
  const start = DATE_RE.exec(isoDate(waitlistedAt || ''));
  if (!start) return null;
  const today = DATE_RE.exec(isoDate(now || new Date()));
  if (!today) return null;
  const ms = Date.UTC(+today[1], +today[2] - 1, +today[3]) -
             Date.UTC(+start[1], +start[2] - 1, +start[3]);
  return Math.max(0, Math.round(ms / 86400000));
}

/* Hebrew waiting-duration label for a waitlist card: day 0 → "ממתין מהיום",
 * one day → "ממתין יום אחד", N days → "ממתין N ימים". '' (no badge) when the
 * day count is null. Pure. */
function waitlistBadgeText(waitlistedAt, now) {
  const days = waitlistDayCount(waitlistedAt, now);
  if (days === null) return '';
  if (days === 0) return 'ממתין מהיום';
  if (days === 1) return 'ממתין יום אחד';
  return `ממתין ${days} ימים`;
}

/* ===== «לא נקלט כמטופל» — a paid / entering lead with no patient record =====
 * CHANGELOG-unadmitted-lead-warning.md. Display only, computed here; nothing
 * is written.
 *
 * The lead → patient match is NOT a new rule. It is reconciliationReportNow's
 * §A rule (Code.gs recLeadPatient_), ported as is and pinned by a parity test
 * that runs both on the same fixtures:
 *   1. a Patients row whose fromLead is the lead's id; else
 *   2. a Patients row whose phone (the phone of the lead it came from, as
 *      getAdmittedRoster_ joins it) is the lead's phone; else
 *   3. a Patients row with the same normalized name in the same house.
 * Every Patients row counts, released ones included, exactly as in §A. */
const UNADMITTED_AFTER_DAYS = 3;

/* Code.gs normalizePhone_ + diagPhoneKey_: digits only, 972 → 0, the leading 0
 * a number-typed cell drops put back; fewer than 9 digits is not a phone. */
function unadmittedPhoneKey(raw) {
  let d = String(raw == null ? '' : raw).replace(/[^\d]/g, '');
  if (d.indexOf('972') === 0) d = '0' + d.slice(3);
  if (/^[1-9]\d{7,8}$/.test(d)) d = '0' + d;
  return /^0\d{8,9}$/.test(d) ? d : '';
}

/* Code.gs diagClientHouseId_: an id, a Hebrew house name, or an id in another
 * case → the id; anything else is kept as written (trimmed). */
function unadmittedHouseId(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return '';
  const h = HOUSES.find(x => x.id === s) || HOUSES.find(x => x.name === s)
    || HOUSES.find(x => x.id.toLowerCase() === s.toLowerCase());
  return h ? h.id : s;
}

/* The Patients row a lead already has → { patient, via, ambiguous } or null.
 * `ambiguous` = the tier that decided found more than one row. `allLeads` is
 * every lead (board, closed and removed), for the phone join. Pure. */
function unadmittedLeadPatient(lead, patients, allLeads) {
  const pats = Array.isArray(patients) ? patients : [];
  const text = v => String(v == null ? '' : v).trim();
  const found = (list, via) => ({ patient: list[0], via, ambiguous: list.length > 1 });
  const id = text(lead && lead.id);
  const byLead = id ? pats.filter(p => text(p && p.fromLead) === id) : [];
  if (byLead.length) return found(byLead, 'fromLead');
  const phone = unadmittedPhoneKey(lead && lead.phone);
  if (phone) {
    const leadById = {};
    (Array.isArray(allLeads) ? allLeads : []).forEach(l => {
      const k = text(l && l.id);
      if (k && !(k in leadById)) leadById[k] = l;
    });
    const byPhone = pats.filter(p => {
      const src = p && text(p.fromLead) ? leadById[text(p.fromLead)] : null;
      return !!src && unadmittedPhoneKey(src.phone) === phone;
    });
    if (byPhone.length) return found(byPhone, 'phone');
  }
  const nk = normalizeNameForMatch(lead && lead.name);
  const hid = unadmittedHouseId(lead && lead.house);
  if (nk && hid) {
    const byName = pats.filter(p => p && normalizeNameForMatch(p.name) === nk
      && unadmittedHouseId(p.houseId) === hid);
    if (byName.length) return found(byName, 'name_house');
  }
  return null;
}

/* Rule part 1: paid (stage בטיפול פעיל / מקדמה שולמה, an advance on the lead,
 * or a non-void payment with money on it recorded under the lead's own
 * house::name::entryDate) OR entering treatment (meetingOutcome «נכנסים
 * לטיפול»). Closed, irrelevant and removed leads never qualify. Pure. */
function unadmittedLeadEligible(lead, payments) {
  if (!lead) return false;
  if (lead.stage === 'irrelevant' || lead.stage === 'admitted') return false;
  if (lead.disposition || lead.removedAt) return false;
  const outcome = String(lead.meetingOutcome || '').trim();
  if (outcome === 'entered' || outcome === MEETING_OUTCOME_LABELS.entered) return true;
  if (lead.stage === 'paid') return true;
  if ((Number(lead.advance) || 0) > 0) return true;
  const key = patientMatchKey(lead.house, lead.name, lead.entryDate);
  return (Array.isArray(payments) ? payments : []).some(pay => pay && !isVoidPayment(pay)
    && (Number(pay.amountPaid) || 0) > 0 && patientMatchKeyFromId(pay.patientId) === key);
}

/* Logged once per lead per page load, so a re-render never repeats it. */
const _unadmittedAmbiguousLogged = new Set();

/* Whole days since the lead's entryDate when it is flagged, else null.
 * Flagged = eligible (above) AND todayIso (Asia/Jerusalem, 'YYYY-MM-DD') is
 * UNADMITTED_AFTER_DAYS or more after entryDate AND no Patients row matches.
 * No entryDate, unloaded patients, or an ambiguous match → null (never fail
 * open). Pure apart from the one-time console line. */
function unadmittedLeadDays(lead, patients, payments, todayIso, allLeads) {
  if (!lead || !Array.isArray(patients)) return null;
  const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
  const entry = DATE_RE.exec(isoDate(lead.entryDate || ''));
  const today = DATE_RE.exec(String(todayIso || ''));
  if (!entry || !today) return null;
  if (!unadmittedLeadEligible(lead, payments)) return null;
  const days = Math.round((Date.UTC(+today[1], +today[2] - 1, +today[3]) -
                           Date.UTC(+entry[1], +entry[2] - 1, +entry[3])) / 86400000);
  if (days < UNADMITTED_AFTER_DAYS) return null;
  const match = unadmittedLeadPatient(lead, patients, allLeads || [lead]);
  if (match) {
    if (match.ambiguous && !_unadmittedAmbiguousLogged.has(String(lead.id))) {
      _unadmittedAmbiguousLogged.add(String(lead.id));
      console.warn('[E-ZONE] unadmitted-lead check: ambiguous patient match, not flagged',
        { leadId: lead.id, via: match.via });
    }
    return null;
  }
  return days;
}

/* The same check against the live state, for one lead on the board. */
function unadmittedDaysForLead(lead) {
  const allLeads = (state.leads || []).concat(state.irrelevantLeads || [], state.removedLeads || []);
  return unadmittedLeadDays(lead, state.patients, state.payments || [], debtAgingTodayIso(), allLeads);
}

/* The chip on a flagged card; '' when the lead is not flagged. Pure. */
function unadmittedChipHTML(days) {
  if (days == null) return '';
  return `<div class="lc-unadmitted">${escapeHtml(`לא נקלט כמטופל · ${days} ימים`)}</div>`;
}

/* How many leads ON THE BOARD (the STAGES columns, before any search filter)
 * carry the chip — the number on the לידים tab. Pure. */
function countUnadmittedLeads(leads, patients, payments, todayIso, allLeads) {
  const onBoard = new Set(STAGES.map(s => s.id));
  return (Array.isArray(leads) ? leads : []).filter(l => l && onBoard.has(l.stage)
    && unadmittedLeadDays(l, patients, payments, todayIso, allLeads) != null).length;
}

/* The count badge on the לידים tab. Hidden at zero. */
function renderUnadmittedLeadsBadge() {
  const el = document.getElementById('leads-unadmitted-badge');
  if (!el) return;
  const allLeads = (state.leads || []).concat(state.irrelevantLeads || [], state.removedLeads || []);
  const n = countUnadmittedLeads(state.leads, state.patients, state.payments || [], debtAgingTodayIso(), allLeads);
  el.textContent = String(n);
  el.classList.toggle('hidden', n === 0);
}


/* ===== «מטופלים» — the patient list (CHANGELOG-patients-tab-foundation.md) =====
 * Pure helpers for the patient list tab. Display only: nothing here writes,
 * and no lead field is ever copied onto a Patients row — the lead's details
 * are JOINED at render time, so the lead stays the one source of truth.
 *
 * The lead ↔ patient link is the #192 rule (unadmittedLeadPatient), read
 * from the patient's side:
 *   - fromLead set   → the lead with that id, in any list (board, closed,
 *                      removed). Never a fallback: a fromLead whose lead is
 *                      gone reads «הליד לא נמצא», it is not re-guessed.
 *   - fromLead blank → the leads whose #192 match lands on THIS patient. With
 *                      no fromLead the only tier that can reach a patient is
 *                      name + house (the phone tier joins through a
 *                      patient's own fromLead). More than one lead, or a tier
 *                      that hits several patients → ambiguous: no lead is
 *                      shown and the patient is never flagged for it. */
const PATIENT_NO_PAYMENT_AFTER_DAYS = 3;

/* The patient list's filters, as the tab opens: active patients, every house. */
const PATIENT_LIST_DEFAULT_FILTERS = Object.freeze({ house: '', status: 'active', problemsOnly: false, q: '' });

/* The problem chips, in display order. `finance` = only computed for a
 * finance session (the data is never loaded for any other). */
const PATIENT_PROBLEMS = Object.freeze([
  { code: 'no_funder',      label: 'ללא גורם מממן',        finance: true },
  { code: 'no_payment',     label: 'לא דווח תשלום',         finance: true },
  { code: 'house_mismatch', label: 'בית שונה מהליד',        finance: false },
  { code: 'no_lead',        label: 'ללא ליד',               finance: false },
]);

/* Every lead the app holds (board incl. admitted, closed, removed), first
 * copy of an id wins. */
function patientLeadPool(s) {
  const src = s || state;
  return (src.leads || []).concat(src.irrelevantLeads || [], src.removedLeads || []);
}

/* A patient's lead → { lead, via, ambiguous }.
 *   via: 'fromLead' | 'fromLead_missing' | 'name_house' | 'ambiguous' | 'none'
 * `leads` = every lead (patientLeadPool); `patients` = every Patients row, for
 * the ambiguity check (defaults to just this one). Pure. */
function patientLeadInfo(patient, leads, patients) {
  const text = v => String(v == null ? '' : v).trim();
  const all = [];
  const seen = new Set();
  (Array.isArray(leads) ? leads : []).forEach(l => {
    const k = text(l && l.id);
    if (!l || (k && seen.has(k))) return;
    if (k) seen.add(k);
    all.push(l);
  });
  const none = { lead: null, via: 'none', ambiguous: false };
  if (!patient) return none;
  const fromLead = text(patient.fromLead);
  if (fromLead) {
    const lead = all.find(l => text(l.id) === fromLead) || null;
    return { lead, via: lead ? 'fromLead' : 'fromLead_missing', ambiguous: false };
  }
  const pats = Array.isArray(patients) && patients.length ? patients : [patient];
  const nk = normalizeNameForMatch(patient.name);
  const hid = unadmittedHouseId(patient.houseId);
  if (!nk || !hid) return none;
  let tierAmbiguous = false;
  const hits = all.filter(l => {
    if (normalizeNameForMatch(l.name) !== nk || unadmittedHouseId(l.house) !== hid) return false;
    const m = unadmittedLeadPatient(l, pats, all);
    if (!m || m.via !== 'name_house') return false;   // the lead belongs to another patient
    if (m.ambiguous) tierAmbiguous = true;
    return true;
  });
  if (!hits.length) return none;
  if (hits.length > 1 || tierAmbiguous) return { lead: null, via: 'ambiguous', ambiguous: true };
  return { lead: hits[0], via: 'name_house', ambiguous: false };
}

/* Whole days from `fromIso` to `toIso` (both 'YYYY-MM-DD'), or null. Pure. */
function patientDayDiff(fromIso, toIso) {
  const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
  const a = DATE_RE.exec(isoDate(fromIso || ''));
  const b = DATE_RE.exec(String(toIso || ''));
  if (!a || !b) return null;
  return Math.round((Date.UTC(+b[1], +b[2] - 1, +b[3]) - Date.UTC(+a[1], +a[2] - 1, +a[3])) / 86400000);
}

/* Days in the house: entry → today, or entry → exit for a released patient.
 * null without an entry date; a future entry date clamps to 0. Pure. */
function patientDaysInHouse(patient, todayIso) {
  if (!patient) return null;
  const exit = patient.status === 'released' ? patientExitISO(patient) : '';
  const d = patientDayDiff(patient.date, exit && exit < todayIso ? exit : todayIso);
  return d == null ? null : Math.max(0, d);
}

/* Did any payment row record money for this patient? A row is the patient's
 * by the server-owned uid, or by the house::name::entryDate reduction the
 * payment matcher uses. A void row is not money. Pure. */
function patientHasReportedPayment(patient, payments) {
  const uid = patientUid(patient);
  const key = patientMatchKeyOf(patient);
  return (Array.isArray(payments) ? payments : []).some(pay => {
    if (!pay || isVoidPayment(pay)) return false;
    const mine = (uid && paymentPatientUid(pay) === uid) || (key && patientMatchKeyFromId(pay.patientId) === key);
    return !!mine && (paymentCoversCycle(pay) || (Number(pay.amountPaid) || 0) > 0);
  });
}

/* The open problems of one patient → [{ code, label }] in PATIENT_PROBLEMS
 * order. A released patient has none (the list is about who is in a house).
 *   leadInfo  patientLeadInfo's answer.
 *   payments  the Payments rows, or null when this session has none (no
 *             finance) → «לא דווח תשלום» is not computed.
 *   funders   the Funders rows, or null likewise → «ללא גורם מממן» is not
 *             computed. Also skipped when funder.js did not load.
 *   todayIso  'YYYY-MM-DD' in Asia/Jerusalem.
 * Pure. */
function patientProblems(patient, leadInfo, payments, funders, todayIso) {
  if (!patient || patient.status === 'released') return [];
  const info = leadInfo || { lead: null, via: 'none', ambiguous: false };
  const lead = info.lead || null;
  const hasFunders = Array.isArray(funders) && !!funderLib();
  const funderKey = hasFunders ? patientFunderKey(patient, funders, todayIso, todayIso) : '';
  const out = new Set();
  if (hasFunders && (!patientUid(patient) || funderKey === FUNDER_UNSET_KEY)) out.add('no_funder');
  if (Array.isArray(payments) && funderKey !== FUNDER_PROBONO_KEY) {
    const days = patientDayDiff(patient.date, todayIso);
    // Nothing reported since the entry — the first cycle, due on the entry
    // day. Inside an institutional funder's grace window it is not a problem
    // yet (CHANGELOG-funder-grace.md); the row's payment cell says why.
    if (days != null && days >= PATIENT_NO_PAYMENT_AFTER_DAYS && !patientHasReportedPayment(patient, payments)
      && !patientCycleInFunderGrace(patient, funders, patient.date, todayIso)) out.add('no_payment');
  }
  if (lead) {
    const leadHouse = unadmittedHouseId(lead.house);
    if (leadHouse && leadHouse !== unadmittedHouseId(patient.houseId)) out.add('house_mismatch');
  }
  if (!String(patient.fromLead || '').trim() && !lead && !info.ambiguous) out.add('no_lead');
  return PATIENT_PROBLEMS.filter(p => out.has(p.code)).map(p => ({ code: p.code, label: p.label }));
}

/* The current cycle's payment state, from the same helpers as גבייה:
 * lastBillingDayOnOrBefore → the cycle's Payments row (paymentId) → its
 * derived status. null for a released patient or without an entry date.
 * → { key: 'paid'|'partial'|'unpaid'|'void'|'probono'|'not_due', label, dueISO }
 * Pure (payments / funders passed in). */
function patientPaymentState(patient, payments, funders, todayIso) {
  if (!patient || patient.status === 'released' || !isoDate(patient.date)) return null;
  const d = lastBillingDayOnOrBefore(patient.date, todayIso);
  const dueISO = d ? isoDate(d) : '';
  if (!dueISO || dueISO < isoDate(patient.date)) return { key: 'not_due', label: 'טרם חויב', dueISO: '' };
  if (Array.isArray(funders) && funderLib() && patientFunderKey(patient, funders, todayIso, dueISO) === FUNDER_PROBONO_KEY) {
    return { key: 'probono', label: funderLib().labelFor(FUNDER_PROBONO_KEY), dueISO };
  }
  const id = paymentId(patient, dueISO);
  const pay = (Array.isArray(payments) ? payments : []).find(x => x && x.id === id) || null;
  if (pay && isVoidPayment(pay)) return { key: 'void', label: PAYMENT_VOID_LABEL, dueISO };
  const key = pay ? pay.status : 'unpaid';
  // Institutional funder, within 30 days of the due date: neutral, not red.
  // `owed` keeps the real state (the cell still offers «דווח תשלום»).
  if ((key === 'unpaid' || key === 'partial') && patientCycleInFunderGrace(patient, funders, dueISO, todayIso)) {
    return { key: 'funder_grace', label: funderGraceStatusLabel(key), dueISO, owed: key };
  }
  return { key, label: paymentStatusLabel(key), dueISO };
}

/* What the row shows of its lead (the «פרטי הליד» section). Pure. */
function patientLeadDetails(lead) {
  if (!lead) return null;
  const s = v => String(v == null ? '' : v).trim();
  return {
    phone: s(lead.phone),
    source: s(lead.source),
    visitDate: isoDate(lead.visitDate || ''),
    advance: Number(lead.advance) || 0,
    note: s(lead.note),
    assignedTo: s(lead.assignedTo),
    meetingWith: s(lead.meetingWith),
    house: s(lead.house),
  };
}

/* The patient list → rows, filtered and sorted (newest entry first, then
 * name). `s` is the app state (patients, the three lead lists, and — finance
 * only — payments and funders); `filters` is PATIENT_LIST_DEFAULT_FILTERS'
 * shape. A session without finance never reads payments or funders, even if
 * an array is present. Pure apart from reading `s`.
 * → [{ patient, leadInfo, lead, problems, days, payment }] */
function patientListRows(s, filters, todayIso) {
  const src = s || state;
  const f = Object.assign({}, PATIENT_LIST_DEFAULT_FILTERS, filters || {});
  const today = todayIso || debtAgingTodayIso();
  const finance = src.finance === true;
  const payments = finance && Array.isArray(src.payments) ? src.payments : null;
  const funders = finance && Array.isArray(src.funders) ? src.funders : null;
  const patients = Array.isArray(src.patients) ? src.patients : [];
  const leads = patientLeadPool(src);
  const q = normalizeNameForMatch(f.q);
  const rows = [];
  patients.forEach(p => {
    if (!p) return;
    const released = p.status === 'released';
    if (f.status === 'active' && released) return;
    if (f.status === 'released' && !released) return;
    if (f.house && unadmittedHouseId(p.houseId) !== f.house) return;
    if (q && normalizeNameForMatch(p.name).indexOf(q) < 0) return;
    const leadInfo = patientLeadInfo(p, leads, patients);
    const problems = patientProblems(p, leadInfo, payments, funders, today);
    if (f.problemsOnly && !problems.length) return;
    rows.push({
      patient: p,
      leadInfo,
      lead: patientLeadDetails(leadInfo.lead),
      problems,
      days: patientDaysInHouse(p, today),
      payment: finance ? patientPaymentState(p, payments, funders, today) : null,
    });
  });
  return rows.sort((a, b) => String(isoDate(b.patient.date) || '').localeCompare(String(isoDate(a.patient.date) || ''))
    || String(a.patient.name || '').localeCompare(String(b.patient.name || ''), 'he'));
}

/* Open problems across the ACTIVE list (every house, no search), for the
 * summary line and the tab badge. → { patients: N with ≥1, byCode: {code: n} }
 * Pure apart from reading `s`. */
function patientProblemSummary(s, todayIso) {
  const rows = patientListRows(s, { status: 'active' }, todayIso);
  const byCode = {};
  PATIENT_PROBLEMS.forEach(p => { byCode[p.code] = 0; });
  let n = 0;
  rows.forEach(r => {
    if (r.problems.length) n++;
    r.problems.forEach(p => { byCode[p.code]++; });
  });
  return { patients: n, byCode };
}

/* «ממתינים לקליטה»: board leads that are paid or entering treatment
 * (unadmittedLeadEligible) with no patient record — the #192 rule WITHOUT its
 * 3-day threshold; `chipDays` carries the #192 chip (3+ days) when it
 * applies. Ambiguous matches and an unloaded patient list are never listed.
 * → [{ lead, days, chipDays }], oldest entry first. Pure. */
function pendingAdmissionRows(leads, patients, payments, todayIso, allLeads) {
  if (!Array.isArray(patients)) return [];
  const onBoard = new Set(STAGES.map(st => st.id));
  const pool = allLeads || leads || [];
  return (Array.isArray(leads) ? leads : [])
    .filter(l => l && onBoard.has(l.stage) && unadmittedLeadEligible(l, payments)
      && !unadmittedLeadPatient(l, patients, pool))
    .map(l => {
      const d = patientDayDiff(l.entryDate, todayIso);
      return {
        lead: l,
        days: d == null ? null : Math.max(0, d),
        chipDays: unadmittedLeadDays(l, patients, payments, todayIso, pool),
      };
    })
    .sort((a, b) => String(isoDate(a.lead.entryDate) || '9999').localeCompare(String(isoDate(b.lead.entryDate) || '9999')));
}
function buildLeadCard(lead) {
  const card = document.createElement('div');
  card.className = 'lead-card';
  card.dataset.id = lead.id;

  const idx = STAGES.findIndex(s => s.id === lead.stage);
  /* Label the advance button by stage id, not array position. A paid
   * (בטיפול פעיל) lead is admitted into a house, so its button is the explicit
   * admit action "כניסה לבית" (the removed column's name — keeps the action
   * findable for Vered). All other stages keep the generic next-stage label. */
  const nextLabel = lead.stage === 'paid' ? 'כניסה לבית' : '← שלב הבא';

  let stageFields = '';
  if (lead.stage === 'visit') {
    /* "שלח הזמנה" — opens a WhatsApp invite to the LEAD. Enabled only when
     * visitDate + visitTime + meetingWith are all set (see refreshInvite
     * below). Reuses the shared .mtg-wa green styling. No data-field, so the
     * generic autosave handler never touches it — it can't perturb the busy
     * flag / autosave loop guard. */
    stageFields = `
      <div class="lc-fields edit-only">
        <input type="date" data-field="visitDate" value="${lead.visitDate || ''}" />
        ${visitTimeSelectHTML(lead.visitTime)}
        ${meetingWithSelectHTML(lead)}
        <button type="button" class="mtg-wa lc-wa-invite" title="שלח הזמנה בוואטסאפ">שלח הזמנה</button>
      </div>`;
  } else if (lead.stage === 'paid') {
    stageFields = `
      <div class="lc-fields edit-only">
        <label class="lc-field-label">מקדמה ששולמה (₪)</label>
        <input type="number" min="0" step="50" data-field="advance" value="${lead.advance || ''}" placeholder="סכום" />
      </div>`;
  }

  /* "נוצר" — date display + inline picker. In edit mode the input uses
   * lang="he" + dir="rtl" so the native picker honors Hebrew locale; in
   * viewer mode a static DD/MM/YYYY display, or "—" for legacy rows whose
   * original creation timestamp doesn't exist. Rendered AFTER the name
   * + meta block so the lead name keeps the prominent top-of-card title
   * slot — sitting it above the name made it visually compete with the
   * title (regression noted 2026-05). */
  const createdISO = lead.created ? isoDate(lead.created) : '';
  const createdDisplay = createdISO ? formatDateHe(createdISO) : '—';
  const createdInner = state.mode === 'edit'
    ? `<input class="lc-created-input" type="date" lang="he" dir="rtl"
              data-field="created" value="${escapeHtml(createdISO)}" />`
    : `<span class="lc-created-value">${escapeHtml(createdDisplay)}</span>`;

  /* Waiting-duration badge (waitlist column only). The card's meta line above
   * it already shows the house — that IS "which house they're waiting for".
   * Blank waitlistedAt (legacy/edge row) renders no badge at all. */
  const waitBadge = lead.stage === 'waitlist' ? waitlistBadgeText(lead.waitlistedAt) : '';

  card.innerHTML = `
    <div class="lc-name">${escapeHtml(lead.name)}</div>
    <div class="lc-meta">
      ${escapeHtml(lead.phone)} ${lead.house ? '· ' + escapeHtml(lead.house) : ''}
      ${lead.source ? '· מקור: ' + escapeHtml(lead.source) : ''}
    </div>
    ${waitBadge ? `<div class="lc-wait-badge">${waitBadge}</div>` : ''}
    ${unadmittedChipHTML(unadmittedDaysForLead(lead))}
    ${state.mode === 'edit' ? '' : leadContactLineHTML(lead)}
    ${state.mode === 'edit' ? '' : leadBillingLineHTML(lead)}
    ${lead.assignedTo
      ? `<div class="lc-assigned"><span class="lc-assigned-label">משוייך ל</span>${escapeHtml(lead.assignedTo)}</div>`
      : ''}
    <div class="lc-created">
      <span class="lc-created-label">נוצר</span>
      ${createdInner}
    </div>
    ${lead.note ? `<div class="lc-note">${escapeHtml(lead.note)}</div>` : ''}
    ${meetingReportBlockHTML(lead)}
    ${stageFields}
    ${state.mode === 'edit' ? leadContactEditHTML(lead) : ''}
    <div class="lc-actions edit-only">
      <button class="btn small" data-action="back" ${idx === 0 ? 'disabled' : ''}>שלב קודם →</button>
      <button class="btn small primary" data-action="next">${nextLabel}</button>
      <button class="btn small" data-action="edit" title="ערוך ליד">✏️</button>
      <button class="lc-irrelevant" title="סגור ליד">סגירת ליד</button>
      ${canDelete() ? '<button class="lc-irrelevant lc-remove" data-role="deleter" title="הסר ליד">הסר</button>' : ''}
    </div>
  `;

  /* Stage changes: both write through saveAll, both re-render the board on
   * success (which destroys this very button), so the busy state only has to
   * survive the round-trip — busyButton's restore on a detached node is inert. */
  card.querySelector('[data-action="next"]').onclick = e =>
    busyButton(e.currentTarget, 'save', () => advanceLead(lead));
  if (idx > 0) card.querySelector('[data-action="back"]').onclick = e =>
    busyButton(e.currentTarget, 'save', () => moveLead(lead, STAGES[idx - 1].id));
  card.querySelector('.lc-irrelevant:not(.lc-remove)').onclick = () => closeLead(lead);
  const removeBtn = card.querySelector('.lc-remove');
  if (removeBtn) removeBtn.onclick = () => {
    if (!canDelete()) { showError(ROLE_FORBIDDEN_TEXT); return; }
    showConfirm({
      text: 'להסיר את הליד? פעולה זו תסיר אותו מהמערכת.',
      confirmLabel: 'כן, הסר',
      danger: true,
      onConfirm: () => removeLead(lead),
    });
  };
  card.querySelector('[data-action="edit"]').onclick = () => openEditLeadModal(lead);

  /* Manager-report block (PR 3): expand/collapse + mark-seen on first open. */
  const mrvEl = card.querySelector('[data-mrv-toggle]');
  if (mrvEl && mrvEl.getAttribute && mrvEl.getAttribute('data-mrv-toggle')) {
    wireMeetingReportToggle(mrvEl);
  }

  /* Inline autosave. These are <input>/<select> change events, not buttons, so
   * busyButton has no label to swap — withFieldSaving attaches the SAME ring
   * and the SAME Hebrew word beside the control instead. updateLead's optimistic
   * write, rollback and error banner are untouched: a failed save re-renders the
   * card with the previous value, so the field is never left looking saved. */
  card.querySelectorAll('[data-field]').forEach(inp => {
    inp.onchange = () => withFieldSaving(inp, 'save',
      () => updateLead(lead.id, { [inp.dataset.field]: inp.value }));
  });

  /* קשר למטופל (edit mode) — the <select> carries data-field, so the generic
   * autosave above already persists every ordinary choice with no extra code.
   * Only the אחר free input is compound: reveal it when אחר is picked and
   * persist the TYPED text through the same updateLead path. addEventListener,
   * so the data-field .onchange handler is never clobbered. Picking אחר stores
   * 'אחר' via the generic handler and the typed text replaces it on the next
   * change — both are values resolveContactRelation itself would produce, so no
   * intermediate state is ever wrong. */
  const relSel   = card.querySelector('.lc-relation');
  const relOther = card.querySelector('.lc-relation-other');
  if (relSel && relOther) {
    relSel.addEventListener('change', () => {
      relOther.style.display = relSel.value === CONTACT_RELATION_OTHER ? '' : 'none';
    });
    relOther.addEventListener('change', () => withFieldSaving(relOther, 'save',
      () => updateLead(lead.id, { contactRelation: resolveContactRelation(relSel.value, relOther.value) })));
  }

  /* Billing selector (edit mode) — compound: the mode <select> + free-input
   * resolve to ONE billingPhone string, so they can't use the 1:1 data-field
   * mapping above. Wire them separately (addEventListener, so nothing clobbers
   * the data-field .onchange handlers) and persist via updateLead → saveAll,
   * exactly like the other inline fields. On success updateLead does NOT
   * re-render, so the autosave busy-flag guard is never perturbed. contactPhone
   * is read LIVE from its inline input so a just-typed number resolves correctly. */
  const billMode  = card.querySelector('.lc-billing-mode');
  const billOther = card.querySelector('.lc-billing-other');
  if (billMode && billOther) {
    const applyBilling = (el) => {
      billOther.style.display = billMode.value === 'other' ? '' : 'none';
      const contactInp = card.querySelector('[data-field="contactPhone"]');
      const contactVal = contactInp ? contactInp.value : lead.contactPhone;
      const resolved = resolveBillingPhone(billMode.value, lead.phone, contactVal, billOther.value);
      return withFieldSaving(el, 'save', () => updateLead(lead.id, { billingPhone: resolved }));
    };
    billMode.addEventListener('change', () => applyBilling(billMode));
    billOther.addEventListener('change', () => applyBilling(billOther));
  }

  /* WhatsApp invite button (visit stage only). Reads the three inline fields
   * LIVE from the DOM — not from `lead` — so it reflects the user's current
   * selections regardless of whether updateLead's async save has run yet, and
   * stays correct even though a successful save does not re-render the card.
   * A separate 'change' listener (addEventListener, so it never clobbers the
   * autosave .onchange above) keeps its enabled state in sync. */
  const inviteBtn = card.querySelector('.lc-wa-invite');
  if (inviteBtn) {
    const dateInp = card.querySelector('[data-field="visitDate"]');
    const timeInp = card.querySelector('[data-field="visitTime"]');
    const withInp = card.querySelector('[data-field="meetingWith"]');
    const refreshInvite = () => {
      const ready = !!((dateInp && dateInp.value) && (timeInp && timeInp.value) && (withInp && withInp.value));
      inviteBtn.disabled = !ready;
    };
    refreshInvite();
    [dateInp, timeInp, withInp].forEach(el => el && el.addEventListener('change', refreshInvite));
    inviteBtn.onclick = () => {
      const dateISO = dateInp ? dateInp.value : '';
      const time    = timeInp ? timeInp.value : '';
      const manager = withInp ? withInp.value : '';
      if (!dateISO || !time || !manager) return;   // defensive — button was disabled
      const msg = buildMeetingMessage({
        type: 'invite', name: lead.name, manager, house: lead.house, dateISO, time,
      });
      /* Outgoing communication targets the billing/updates phone (falls back to
       * the patient phone when billingPhone is unset — see leadBillingPhone). */
      openWhatsAppLink(meetingInviteWaUrl(leadBillingPhone(lead), msg));
    };
  }

  return card;
}

async function advanceLead(lead) {
  // Admit action: advancing a paid (בטיפול פעיל) lead enters it into a house.
  // openEntryModal creates the patient and retires the lead to 'admitted'.
  // Keyed on the stage id — NOT array position — so it stays anchored to paid
  // regardless of how many board columns exist.
  if (lead.stage === 'paid') {
    openEntryModal(lead);
    return;
  }
  // Already admitted, or a stray legacy holding stage. These no longer render a
  // board column, but guard defensively so a stray lead never crashes or moves.
  if (lead.stage === 'entry' || lead.stage === 'entered' || lead.stage === 'admitted') {
    return;
  }
  // new / visit → advance to the next board stage by id.
  const idx = STAGES.findIndex(s => s.id === lead.stage);
  if (idx >= 0 && idx < STAGES.length - 1) {
    await moveLead(lead, STAGES[idx + 1].id);
  }
}

async function moveLead(lead, newStage) {
  const prev = lead.stage;
  const prevWaitlistedAt = lead.waitlistedAt;
  lead.stage = newStage;
  /* Waitlist stamp: entering רשימת המתנה records now as an ISO timestamp
   * (text-safe column — see LEAD_COLUMNS in Code.gs); leaving clears it so a
   * future re-entry restamps. Every board stage change funnels through
   * moveLead (the on-card שלב הבא/קודם buttons — there is no drag-and-drop),
   * so this is the single stamp point. Rollback below restores both fields. */
  if (newStage === 'waitlist' && prev !== 'waitlist') {
    lead.waitlistedAt = new Date().toISOString();
  } else if (prev === 'waitlist' && newStage !== 'waitlist') {
    lead.waitlistedAt = '';
  }
  renderAll();
  /* The renderAll() above has already detached the שלב הבא/קודם button that
   * was pressed, so its busyButton state cannot paint. Raise the page-level
   * banner AFTER the re-render — it lives outside every re-rendered region, so
   * this is the indicator the round-trip actually gets. The optimistic move and
   * the rollback below are untouched. */
  setSaving(true);
  try {
    await saveAll();
  } catch (e) {
    lead.stage = prev;
    lead.waitlistedAt = prevWaitlistedAt;
    renderAll();
    showError('עדכון שלב נכשל — ' + e.message);
  } finally {
    setSaving(false);
  }
}

async function updateLead(id, fields) {
  const lead = state.leads.find(l => l.id === id);
  if (!lead) return false;
  const prev = { ...lead };
  Object.assign(lead, fields);
  try {
    await saveAll();
    return true;
  } catch (e) {
    Object.assign(lead, prev);
    renderAll();
    showError('עדכון ליד נכשל — ' + e.message);
    return false;
  }
}

/* ===== Irrelevant leads — move + restore =====
 *
 * Move side: removes the lead from state.leads, stamps it with originSheet
 * (the stage id it was sitting in) + movedAt, pushes it onto state.irrelevantLeads,
 * and persists the move atomically via the dedicated backend action so the row
 * can never end up in both sheets at once. The move is one-way automatic per
 * spec — even if the lead's stage is later edited, it stays in the irrelevant
 * sheet until manually restored.
 *
 * Restore side: the user clicks "שחזר ליד", confirms the dialog, and the row
 * is moved back to the Leads sheet with its original stage. If the recorded
 * origin stage no longer exists in STAGES, the restore is refused.
 */

function stageLabelById(stageId) {
  const s = STAGES.find(x => x.id === stageId);
  return s ? s.label : '';
}

/* Phase 2d-2 — closure flow. Replaces markLeadIrrelevant. Opens the
 * three-disposition closure modal, then on confirm performs the same
 * optimistic-UI-plus-rollback move as the old flow. apiPost still hits
 * action: 'moveLeadIrrelevant' (backend name unchanged for compatibility);
 * the payload now carries disposition explicitly and skips the Phase 2b
 * not_relevant_reason / not_relevant_note fields — those stay blank on
 * new rows ("dead-but-readable" for legacy data). */
function closeLead(lead) {
  if (state.mode !== 'edit') return;

  showCloseLeadModal({
    onConfirm: async ({ disposition, note }) => {
      const moved = {
        ...lead,
        stage: 'irrelevant',
        originSheet: lead.stage || 'new',
        movedAt: new Date().toISOString(),
        disposition: disposition,
        not_relevant_note: note,
      };

      // Optimistic UI update
      state.leads = state.leads.filter(l => l.id !== lead.id);
      state.irrelevantLeads.unshift(moved);
      renderAll();

      try {
        await apiPost({ action: 'moveLeadIrrelevant', lead: moved });
      } catch (e) {
        // Roll back on failure
        state.irrelevantLeads = state.irrelevantLeads.filter(l => l.id !== moved.id);
        state.leads.unshift(lead);
        renderAll();
        showError('סגירת הליד נכשלה — ' + e.message);
        throw e;                         // keep modal open so the user can retry
      }
    },
  });
}

async function restoreIrrelevantLead(ilead) {
  if (state.mode !== 'edit') return;

  /* Phase 2d-2 — restore always returns to ליד חדש. A returning lead is a
   * functionally new engagement (new commitment, new schedule, new payment),
   * so re-entering the pipeline at 'new' is the locked design. The backend
   * never inspected originSheet during restore — it just writes whatever
   * stage the payload carries — so this is a frontend-only change. */
  showConfirm({
    text: 'להחזיר את הליד לגיליון ליד חדש?',
    onConfirm: async () => {
      const restored = {
        ...ilead,
        stage: 'new',
      };
      delete restored.originSheet;
      delete restored.movedAt;

      // Optimistic UI update
      state.irrelevantLeads = state.irrelevantLeads.filter(l => l.id !== ilead.id);
      state.leads.unshift(restored);
      renderAll();

      try {
        await apiPost({ action: 'restoreLead', lead: restored });
        showToast('הליד הוחזר לגיליון ליד חדש');
      } catch (e) {
        state.leads = state.leads.filter(l => l.id !== restored.id);
        state.irrelevantLeads.unshift(ilead);
        renderAll();
        showError('שחזור הליד נכשל — ' + e.message);
      }
    }
  });
}

/* Disposition sections for the שימור לידים tab, in the fixed render order. */
const IRRELEVANT_SECTION_ORDER = ['not_relevant', 'completed', 'stopped_early'];

/* Thin per-tab search wrapper over the shared leadMatchesQuery: a closed lead
 * also matches on its origin sheet (the stage it was closed from — shown in the
 * row's meta), by both the stable stage id and its Hebrew label. leadMatchesQuery
 * is NOT modified; this only widens matching for this tab. Pure + testable. */
function irrelevantLeadMatchesQuery(lead, q) {
  if (!q) return true;
  if (leadMatchesQuery(lead, q)) return true;
  const ql = String(q).toLowerCase();
  const origin = String(lead.originSheet == null ? '' : lead.originSheet).toLowerCase();
  if (origin.includes(ql)) return true;
  return String(stageLabelById(lead.originSheet) || '').toLowerCase().includes(ql);
}

/* Group closed leads into the three disposition sections (spec order) and apply
 * the search query inside each group. Returns [{ key, rows }] for non-empty
 * groups only, so a group with zero matches is dropped while a query is active.
 * An unknown/blank disposition falls into 'not_relevant' (matches the pre-search
 * grouping). Empty query → every row matches → the current unfiltered grouping.
 * Pure (no DOM / no state) so grouping + filtering + zero-match exclusion are
 * unit-tested directly. */
function filterIrrelevantGroups(rows, q) {
  const grouped = { not_relevant: [], completed: [], stopped_early: [] };
  (rows || []).forEach(lead => {
    const key = grouped[lead.disposition] ? lead.disposition : 'not_relevant';
    if (irrelevantLeadMatchesQuery(lead, q)) grouped[key].push(lead);
  });
  return IRRELEVANT_SECTION_ORDER
    .map(key => ({ key: key, rows: grouped[key] }))
    .filter(g => g.rows.length > 0);
}

function renderIrrelevantLeads() {
  const list = document.getElementById('irrelevant-list');
  if (!list) return;
  list.innerHTML = '';

  const rows = state.irrelevantLeads || [];

  if (!rows.length) {
    document.getElementById('irrelevant-count').textContent = 0;
    list.innerHTML = `<div class="card billing-empty">אין לידים סגורים</div>`;
    return;
  }

  /* Phase 2d-1 — group rows by disposition and render up to three sections in
   * spec order (empty groups skipped). The search box (retentionSearch) filters
   * inside each group; the count pill + per-group counts reflect the FILTERED
   * result so "clearing restores the full list" is exact. */
  const q = state.retentionSearch;
  const groups = filterIrrelevantGroups(rows, q);
  const shown = groups.reduce((n, g) => n + g.rows.length, 0);
  document.getElementById('irrelevant-count').textContent = shown;

  if (!groups.length) {
    // Non-empty collection, but the active query matched nothing.
    list.innerHTML = `<div class="card billing-empty">לא נמצאו לידים סגורים לחיפוש זה</div>`;
    return;
  }

  groups.forEach(({ key, rows: sectionRows }) => {
    const section = document.createElement('div');
    section.className = 'closure-section';
    section.dataset.disposition = key;

    const heading = document.createElement('div');
    heading.className = 'closure-section-heading';
    const caret = document.createElement('span');
    caret.className = 'closure-section-caret';
    caret.textContent = '▾';
    const label = document.createElement('span');
    label.className = 'closure-section-label';
    label.textContent = DISPOSITION_LABELS[key];
    const count = document.createElement('span');
    count.className = 'closure-section-count';
    count.textContent = '(' + sectionRows.length + ')';
    heading.appendChild(caret);
    heading.appendChild(label);
    heading.appendChild(count);
    heading.onclick = () => section.classList.toggle('collapsed');

    const body = document.createElement('div');
    body.className = 'closure-section-body';

    sectionRows.forEach(lead => body.appendChild(buildIrrelevantRow(lead)));

    section.appendChild(heading);
    section.appendChild(body);
    list.appendChild(section);
  });
}

/* Builds one row card for the שימור לידים tab. Extracted from
 * renderIrrelevantLeads in Phase 2d-1 so the three disposition sections
 * share identical row markup (including the Phase 2b meta block). */
function buildIrrelevantRow(lead) {
  const originLabel = stageLabelById(lead.originSheet) || '—';
  const movedLabel  = lead.movedAt ? formatDate(lead.movedAt) : '—';

  const row = document.createElement('div');
  row.className = 'irrelevant-row';
  row.dataset.id = lead.id;
  row.innerHTML = `
    <div>
      <span class="p-label">שם</span>
      <span class="p-name">${escapeHtml(lead.name)}</span>
    </div>
    <div>
      <span class="p-label">טלפון</span>
      <span class="p-val">${escapeHtml(lead.phone || '—')}</span>
    </div>
    <div>
      <span class="p-label">בית מועדף</span>
      <span class="p-val">${escapeHtml(lead.house || '—')}</span>
    </div>
    <div>
      <span class="p-label">גיליון מקור</span>
      <span class="p-val">${escapeHtml(originLabel)}</span>
    </div>
    <div>
      <span class="p-label">תאריך העברה</span>
      <span class="p-val">${escapeHtml(movedLabel)}</span>
    </div>
    <div class="row-actions edit-only">
      <button class="btn small primary" data-action="restore">שחזר ליד</button>
    </div>
  `;
  row.querySelector('[data-action="restore"]').onclick = () => restoreIrrelevantLead(lead);

  /* Phase 2b — reason + free-text note captured when the lead was marked.
   * Built imperatively with textContent for both the reason label and the
   * user-entered note (note is free-text → must not be parsed as HTML).
   * Legacy rows from before this PR have empty reason+note → meta block
   * is skipped entirely so the row layout stays compact. */
  const reasonLabel = lead.not_relevant_reason
    ? (NOT_RELEVANT_REASON_LABELS[lead.not_relevant_reason] || lead.not_relevant_reason)
    : '';
  const noteText = lead.not_relevant_note || '';
  if (reasonLabel || noteText) {
    const meta = document.createElement('div');
    meta.className = 'irrelevant-meta';
    if (reasonLabel) {
      const r = document.createElement('div');
      r.className = 'irrelevant-meta-reason';
      const rl = document.createElement('span');
      rl.className = 'irrelevant-meta-label';
      rl.textContent = 'סיבה: ';
      const rv = document.createElement('span');
      rv.textContent = reasonLabel;
      r.appendChild(rl);
      r.appendChild(rv);
      meta.appendChild(r);
    }
    if (noteText) {
      const n = document.createElement('div');
      n.className = 'irrelevant-meta-note';
      const nl = document.createElement('span');
      nl.className = 'irrelevant-meta-label';
      nl.textContent = 'פירוט: ';
      const nv = document.createElement('span');
      nv.textContent = noteText;
      n.appendChild(nl);
      n.appendChild(nv);
      meta.appendChild(n);
    }
    row.appendChild(meta);
  }

  return row;
}

/* ===== Removed leads — soft-delete =====
 *
 * One-way soft-delete: the lead is removed from the kanban and routed to the
 * "לידים שהוסרו" sheet via the dedicated backend action. Mirrors the move side
 * of markLeadIrrelevant but is one-way only — there is no in-app restore for
 * soft-deleted rows in v1. Manual restore via the Sheets UI is the documented
 * recovery path.
 *
 * Viewer mode is silently inert — matches markLeadIrrelevant's behavior. The
 * הסר button is rendered unconditionally (no edit-only gating), so the runtime
 * guard here is what actually prevents viewer-mode mutations.
 */
async function removeLead(lead) {
  if (!canDelete()) { showError(ROLE_FORBIDDEN_TEXT); return; }
  if (state.mode !== 'edit') return;

  const prev = state.leads.slice();
  state.leads = state.leads.filter(l => l.id !== lead.id);
  renderAll();

  try {
    const res = await apiPost({ action: 'removeLead', lead: lead });
    /* Backend stamps removedAt + originSheet on the record it persists; prefer
     * that exact record so the in-memory state matches what's on the sheet.
     * Fall back to a client-stamped record if the response shape is unexpected
     * (defensive — moveLeadIrrelevant uses the same pattern). */
    const stored = (res && res.lead)
      ? normalizeRemovedLead(res.lead)
      : normalizeRemovedLead({
          ...lead,
          removedAt:   new Date().toISOString(),
          originSheet: 'Leads',
        });
    state.removedLeads.unshift(stored);
    renderAll();
    showToast('הליד הוסר');
  } catch (e) {
    state.leads = prev;
    renderAll();
    showError('הסרת הליד נכשלה — ' + e.message);
  }
}

function renderRemovedLeads() {
  const list = document.getElementById('removed-list');
  if (!list) return;
  list.innerHTML = '';

  const rows = state.removedLeads || [];

  if (!rows.length) {
    const empty = document.createElement('div');
    empty.className = 'card billing-empty';
    empty.textContent = 'אין לידים שהוסרו';
    list.appendChild(empty);
    return;
  }

  /* Build each row imperatively with textContent for user-entered fields
   * (name, phone, originSheet) so no markup in those values is ever parsed
   * as HTML. removedAt goes through formatDate which produces a locale string
   * from a Date — also safe to set via textContent. */
  rows.forEach(lead => {
    const row = document.createElement('div');
    row.className = 'irrelevant-row';
    row.dataset.id = lead.id;

    const cells = [
      { label: 'שם',          value: lead.name  || '—', valueClass: 'p-name' },
      { label: 'טלפון',        value: lead.phone || '—' },
      { label: 'גיליון מקור',   value: lead.originSheet || '—' },
      { label: 'תאריך הסרה',    value: lead.removedAt ? formatDate(lead.removedAt) : '—' },
    ];

    cells.forEach(c => {
      const cell = document.createElement('div');
      const label = document.createElement('span');
      label.className = 'p-label';
      label.textContent = c.label;
      const val = document.createElement('span');
      val.className = c.valueClass || 'p-val';
      val.textContent = c.value;
      cell.appendChild(label);
      cell.appendChild(val);
      row.appendChild(cell);
    });

    list.appendChild(row);
  });
}

/* House label as the discharged tab displays it: resolved house name, falling
 * back to the raw houseId. Injected into the search matcher so what the user
 * sees on the card is what the query matches. '' (not '—') when both are
 * missing, so the placeholder dash never satisfies a search. */
function dischargedHouseLabel(p) {
  const h = houseById(p && p.houseId);
  return (h && h.name) || (p && p.houseId) || '';
}

/* Whether a discharged audit row matches the search query `q` (already
 * trimmed+lowercased by the input handler). Mirrors leadMatchesQuery: text
 * fields (name, house label) match by lowercased substring; the phone matches
 * either by raw lowercased substring (a partial as-displayed still hits) OR by
 * normalized-digit substring via normalizePhone, so "050-12" and "+97250 12"
 * find the same row regardless of formatting. Pure + exported for tests. */
function dischargedPatientMatchesQuery(p, q, houseLabel) {
  if (!q) return true;
  const ql = String(q).toLowerCase();
  const text = [p && p.name, houseLabel];
  if (text.some(v => String(v == null ? '' : v).toLowerCase().includes(ql))) return true;
  const phone = String((p && p.phone) == null ? '' : p.phone).toLowerCase();
  if (phone.includes(ql)) return true;
  const qDigits = normalizePhone(q);
  return !!qDigits && normalizePhone(phone).includes(qDigits);
}

/* Phase 2e-1 — discharged-patients tab. Read-only audit list. Each row has a
 * single שחזר button opening the restore-choice modal
 * (showRestorePatientChoiceModal): prior-status restore (default) or a new
 * lead. The discharge record stays on the sheet as the audit trail either way. */
/* ===== «🚪 שחרורים מהבתים» — discharges a coordinator recorded =====
 * The coordinators app writes a discharge straight back (Code.gs
 * recordDischargeFromCoordinators_): the patient is released IMMEDIATELY
 * and the standard discharged-audit row is stamped dischargeSource =
 * 'ezone-coordinators'. This panel is Vered's worklist for the follow-up
 * (billing, refunds): the last COORD_PANEL_WINDOW_DAYS days, newest
 * first, restored rows hidden. Nothing here writes. */
const COORD_PANEL_SOURCE = 'ezone-coordinators';
const COORD_PANEL_WINDOW_DAYS = 30;

/* Pure + tested: the panel's rows. `today` is 'YYYY-MM-DD'. A row counts by
 * its discharge date (exitDate), falling back to when it was recorded. */
function coordinatorDischarges(list, today) {
  const t = Date.parse(String(today || todayISO()) + 'T00:00:00Z');
  const cutoff = new Date(t - COORD_PANEL_WINDOW_DAYS * 86400000).toISOString().slice(0, 10);
  const day = d => String(d.exitDate || d.dischargedAt || '').slice(0, 10);
  return (Array.isArray(list) ? list : [])
    .filter(d => d && d.dischargeSource === COORD_PANEL_SOURCE)
    .filter(d => dischargeRowOpen(d))
    .filter(d => day(d) >= cutoff)
    .sort((a, b) => (day(b) + String(b.dischargedAt || '')).localeCompare(day(a) + String(a.dischargedAt || '')));
}

function renderCoordinatorDischarges() {
  const panel = document.getElementById('coord-discharges');
  const list = document.getElementById('coord-discharges-list');
  if (!panel || !list) return;
  const rows = coordinatorDischarges(state.dischargedPatients, todayISO());
  const countEl = document.getElementById('coord-discharges-count');
  if (countEl) countEl.textContent = rows.length;
  list.innerHTML = '';
  if (!rows.length) {
    const empty = document.createElement('div');
    empty.className = 'coord-discharges-empty';
    empty.textContent = 'אין שחרורים מהבתים ב־30 הימים האחרונים';
    list.appendChild(empty);
    return;
  }
  rows.forEach(d => {
    const row = document.createElement('div');
    row.className = 'coord-discharge-row';
    row.dataset.id = d.id;
    const houseName = (houseById(d.houseId) && houseById(d.houseId).name) || d.houseId || '—';
    const cells = [
      { label: 'שם', value: d.name || '—', cls: 'p-name' },
      { label: 'בית', value: houseName },
      { label: 'תאריך שחרור', value: d.exitDate ? formatDate(d.exitDate) : '—' },
      { label: 'סיבה', value: d.dischargeReason || '—' },
      { label: 'דווח ע״י', value: d.dischargedBy || '—' },
    ];
    // textContent only — every value here came from another app.
    cells.forEach(c => {
      const cell = document.createElement('div');
      const label = document.createElement('span');
      label.className = 'p-label';
      label.textContent = c.label;
      const val = document.createElement('span');
      val.className = c.cls || 'p-val';
      val.textContent = c.value;
      cell.appendChild(label);
      cell.appendChild(val);
      row.appendChild(cell);
    });
    list.appendChild(row);
  });
}

function renderDischargedPatients() {
  const list = document.getElementById('discharged-patients-list');
  if (!list) return;
  list.innerHTML = '';

  /* Phase 2e-2: hide rows the user has already restored. Backend writes
   * restored='TRUE' (string) on restorePatient_; Sheets may coerce to bool
   * in some configs, so accept both. The audit row stays in the sheet. */
  const allRows = (state.dischargedPatients || [])
    .filter(d => dischargeRowOpen(d));

  /* Live search (name / phone / house). The count pill reflects the FILTERED
   * count, matching what the list actually shows. */
  const q = state.dischargedSearch;
  const rows = allRows.filter(p => dischargedPatientMatchesQuery(p, q, dischargedHouseLabel(p)));
  const countEl = document.getElementById('discharged-patients-count');
  if (countEl) countEl.textContent = rows.length;

  if (!rows.length) {
    const empty = document.createElement('div');
    empty.className = 'card billing-empty';
    empty.textContent = allRows.length ? 'לא נמצאו תוצאות' : 'אין מטופלים משוחררים';
    list.appendChild(empty);
    return;
  }

  rows.forEach(p => {
    const row = document.createElement('div');
    row.className = 'irrelevant-row';
    row.dataset.id = p.id;

    const houseName = (houseById(p.houseId) && houseById(p.houseId).name) || p.houseId || '—';
    const dispLabel = p.disposition && DISPOSITION_LABELS[p.disposition]
                    ? DISPOSITION_LABELS[p.disposition]
                    : (p.disposition || '—');

    const cells = [
      { label: 'שם',          value: p.name || '—', valueClass: 'p-name' },
      { label: 'בית',          value: houseName },
      { label: 'תאריך כניסה',   value: p.date ? formatDate(p.date) : '—' },
      // Prefer the user-chosen discharge date (exitDate); fall back to the
      // action timestamp (dischargedAt) for rows recorded before the date field.
      { label: 'תאריך שחרור',   value: (p.exitDate || p.dischargedAt)
                                  ? formatDate(p.exitDate || p.dischargedAt) : '—' },
      { label: 'סטטוס סגירה',   value: dispLabel },
    ];
    if (p.discharge_note) {
      cells.push({ label: 'הערה', value: p.discharge_note });
    }

    cells.forEach(c => {
      const cell = document.createElement('div');
      const label = document.createElement('span');
      label.className = 'p-label';
      label.textContent = c.label;
      const val = document.createElement('span');
      val.className = c.valueClass || 'p-val';
      val.textContent = c.value;
      cell.appendChild(label);
      cell.appendChild(val);
      row.appendChild(cell);
    });

    if (state.mode === 'edit') {
      const actions = document.createElement('div');
      actions.className = 'irrelevant-actions';

      /* ONE שחזר button → the restore-choice modal. The old two-button pair
       * ("שחזר מטופל" = new lead, "החזר לסטטוס פעיל" = undo) was a label trap:
       * the new-lead button read like the default restore. The modal makes the
       * choice explicit, with prior-status restore pre-selected. */
      const btn = document.createElement('button');
      btn.className = 'btn small primary';
      btn.textContent = 'שחזר';
      btn.onclick = () => showRestorePatientChoiceModal(p);
      actions.appendChild(btn);

      /* Credits / refunds — create or edit without touching the discharge
       * record (recovery path for a failed or deferred credit). The count pill
       * shows how many ledger rows already exist for this patient. */
      // Restricted view: no «זיכויים» button (credits are billing data).
      if (financeView()) {
        const nCredits = creditsForPatient(state.credits, '', patientKey(p)).length;
        const creditBtn = document.createElement('button');
        creditBtn.className = 'btn small';
        creditBtn.textContent = nCredits ? `זיכויים (${nCredits})` : 'זיכויים';
        creditBtn.onclick = () => openCreditsForDischarged(p);
        actions.appendChild(creditBtn);
      }

      /* «מחק כפילות» — only on a row whose stay has ANOTHER open discharge
       * row (so the last row of a stay never offers it), and only to a
       * deleter (Vered, Sandra). Code.gs re-checks both, plus the credits. */
      if (canDelete() && openDuplicateSiblings(p, state.dischargedPatients).length > 0) {
        const dupBtn = document.createElement('button');
        dupBtn.className = 'btn small danger';
        dupBtn.dataset.role = 'deleter';
        dupBtn.dataset.action = 'delete-duplicate-discharge';
        dupBtn.textContent = 'מחק כפילות';
        dupBtn.onclick = () => showDeleteDuplicateDischargeModal(p);
        actions.appendChild(dupBtn);
      }

      row.appendChild(actions);
    }

    list.appendChild(row);
  });
}

/* ===== «מחק כפילות» — soft-delete a duplicate discharge row =====
 * (CHANGELOG-duplicate-discharges.md.) The server (deleteDuplicateDischarge_)
 * is the authority: deleter role, a 2–120 char reason, never the last open row
 * of a stay, never a row with its own credit or a stay with a double credit.
 * Here: the reason check up front, busyButton against a double tap, the row
 * leaves the tab only once the server confirmed. Nothing optimistic. */
const DUP_DISCHARGE_REASON_MIN = 2;
const DUP_DISCHARGE_REASON_MAX = 120;

/* '' when the reason is acceptable, else the Hebrew error. Pure. */
function duplicateDischargeReasonError(reason) {
  const r = String(reason == null ? '' : reason).trim();
  if (r.length < DUP_DISCHARGE_REASON_MIN) return 'יש להזין סיבה למחיקה (2–120 תווים)';
  if (r.length > DUP_DISCHARGE_REASON_MAX) return 'הסיבה ארוכה מדי (עד 120 תווים)';
  return '';
}

/* The worker: one deleteDuplicateDischarge call. On success the row carries
 * the server's stamps (so every open-row filter drops it) and the tab
 * re-renders. Throws the server's Hebrew message on a refusal. */
async function deleteDuplicateDischarge(d, reason) {
  if (state.mode !== 'edit' || !canDelete()) throw new Error('אין הרשאה לפעולה זו');
  const err = duplicateDischargeReasonError(reason);
  if (err) throw new Error(err);
  const res = await trackedWrite([_dataGuard], () =>
    apiPost({ action: 'deleteDuplicateDischarge', id: String(d.id), reason: String(reason).trim() }));
  // R3: the server names the row it soft-deleted (or had already).
  requireSavedId(res, r => r.id, d.id);
  const stamps = {
    deletedAt: (res && res.deletedAt) || new Date().toISOString(),
    deletedBy: (res && res.deletedBy) || '',
    deleteReason: (res && res.deleteReason) || String(reason).trim(),
  };
  state.dischargedPatients = (state.dischargedPatients || []).map(x =>
    x && x.id === d.id ? Object.assign({}, x, stamps) : x);
  renderAll();
  showToast('הכפילות נמחקה');
  return res;
}

function showDeleteDuplicateDischargeModal(d) {
  if (state.mode !== 'edit' || !canDelete()) return;
  const root = document.getElementById('modal-root');
  if (!root) return;
  const back = document.createElement('div');
  back.className = 'modal-backdrop';
  const houseName = (houseById(d.houseId) && houseById(d.houseId).name) || d.houseId || '';
  back.innerHTML = `
    <div class="modal">
      <h3>מחיקת שורת שחרור כפולה</h3>
      <p class="confirm-text">${escapeHtml(d.name || '')} · ${escapeHtml(houseName)} · כניסה ${escapeHtml(d.date ? formatDate(d.date) : '—')} · שחרור ${escapeHtml((d.exitDate || d.dischargedAt) ? formatDate(d.exitDate || d.dischargedAt) : '—')}</p>
      <p class="confirm-text">השורה תוסתר מהלשונית ותישמר ביומן. המטופל, התשלומים ושורת השחרור האחרת לא ישתנו.</p>
      <form>
        <div class="form-row">
          <label for="dup-discharge-reason">סיבת המחיקה (חובה)</label>
          <input type="text" id="dup-discharge-reason" name="reason" minlength="2" maxlength="120" required />
        </div>
        <div class="form-actions">
          <button type="button" class="btn" data-action="cancel">ביטול</button>
          <button type="submit" class="btn danger" data-role="deleter">מחק כפילות</button>
        </div>
      </form>
    </div>`;
  const close = () => back.remove();
  back.querySelector('[data-action="cancel"]').onclick = close;
  const form = back.querySelector('form');
  form.onsubmit = e => {
    e.preventDefault();
    const submitBtn = back.querySelector('button[type="submit"]');
    const reason = (back.querySelector('[name="reason"]').value || '').trim();
    const err = duplicateDischargeReasonError(reason);
    if (err) { showError(err); return; }
    return busyButton(submitBtn, 'delete', async () => {
      try {
        await deleteDuplicateDischarge(d, reason);
        close();
      } catch (ex) {
        showError('מחיקת הכפילות נכשלה — ' + ((ex && ex.message) || 'שגיאה'));
      }
    });
  };
  root.appendChild(back);
}

/* Restore path A — back into the leads pipeline as a NEW LEAD. The restore-
 * choice modal is the confirmation step, so this worker runs unconditionally.
 * Optimistic + rollback; errors are handled here (toast) and never thrown. */
async function doRestorePatientAsNewLead(p, newLeadId) {
  if (state.mode !== 'edit') return;
  const newLead = {
    // R3: the choice modal mints ONE id; a retry re-sends it and the server
    // answers the lead it already created.
    id:       newLeadId || cryptoId(),
    name:     p.name  || '',
    phone:    '',
    house:    (houseById(p.houseId) && houseById(p.houseId).name) || '',
    source:   '',
    note:     '',
    stage:    'new',
    visitDate: '',
    visitTime: '',
    entryDate: '',
    advance:  0,
    created:  todayISO(),
  };

  /* Optimistic UI: hide the discharged row locally + unshift the new
   * lead onto the kanban. The backend keeps the discharge row as the
   * audit trail (per Phase 2e spec) and flags it restored='TRUE'. */
  const prevDischarged = state.dischargedPatients.slice();
  const prevLeads      = state.leads.slice();
  state.dischargedPatients = state.dischargedPatients.filter(d => d.id !== p.id);
  state.leads.unshift(newLead);
  renderAll();

  try {
    const res = await trackedWrite([_dataGuard], () =>
      apiPost({ action: 'restorePatient', patient: { ...p, newLeadId: newLead.id } }));
    requireSavedId(res, r => r.lead && r.lead.id, newLead.id);
    showToast('המטופל הוחזר למסלול לידים חדש');
  } catch (e) {
    state.dischargedPatients = prevDischarged;
    state.leads = prevLeads;
    renderAll();
    showError('שחזור המטופל נכשל — ' + e.message);
    throw e;   // the choice modal stays open (R3)
  }
}

/* ===== Restore to previous status =====
 * The restore-choice modal's default path — the undo for an accidental
 * discharge. Unlike doRestorePatientAsNewLead (which spawns a NEW LEAD), this
 * returns the person to their PRE-DISCHARGE status (prior_status; legacy rows →
 * active) with their original record intact, and flags the audit row so it
 * leaves the discharged tab. The audit row is KEPT (restored='TRUE' hides it;
 * it is never deleted).
 *
 * The work is split into pure helpers (unit-tested) + a thin optimistic
 * handler that mirrors doRestorePatientAsNewLead's optimistic + rollback shape. */

/* Find the patient row this audit row should restore, matched by
 * houseId + name + date — NOT by id. The audit row's id is the AUDIT record's
 * own key (a fresh cryptoId per discharge — see dischargeAuditRow), never the
 * patient's, and legacy audit rows predate the persisted patient id anyway, so
 * the three-field key is the stable discriminator. Returns -1 when no row
 * matches. Pure + tested. */
function matchActivePatientIndex(patients, audit) {
  if (!Array.isArray(patients) || !audit) return -1;
  return patients.findIndex(p =>
    p && p.houseId === audit.houseId && p.name === audit.name && p.date === audit.date);
}

/* The status a restore-to-previous-status should give back. The audit row's
 * prior_status column holds the status at the MOMENT of discharge (captured by
 * dischargeAuditRow before the released flip). Only the three live statuses are
 * honored; anything else — blank (legacy rows recorded before the column
 * existed), 'released', or junk — falls back to 'active'. Pure + tested. */
function priorStatusFromAudit(audit) {
  const s = audit && audit.prior_status;
  if (s === 'active' || s === 'trial' || s === 'wait') return s;
  return 'active';
}

/* Reconstruct a live patient record from a discharged audit row. Used ONLY
 * when no existing row matches (e.g. the original row was hard-deleted from the
 * sheet). Carries every reconstructable field from the audit row, restoring the
 * PRE-DISCHARGE status (prior_status, fallback 'active') and a blank exitDate.
 * Pure + tested. */
function reconstructActivePatientFromAudit(audit) {
  const a = audit || {};
  return {
    id:       a.id || cryptoId(),
    houseId:  a.houseId || '',
    name:     a.name || '',
    date:     a.date || '',
    pay:      Number(a.pay) || 0,
    adv:      Number(a.adv) || 0,
    status:   priorStatusFromAudit(a),
    fromLead: a.fromLead || '',
    exitDate: '',
    source:   a.source || 'lead',
    notes:    a.notes || '',
  };
}

/* Produce the post-restore patients array. If an existing row matches
 * (houseId+name+date) flip THAT row in place (status=prior status, exitDate='')
 * — guaranteeing NO duplicate, even across a reload where ids differ. Otherwise
 * reconstruct from the audit row and append. Returns a NEW array (the input is
 * never mutated) so the caller can roll back by restoring the previous
 * reference. Pure + tested. */
function buildRestoredToActivePatients(patients, audit) {
  const src = Array.isArray(patients) ? patients : [];
  const idx = matchActivePatientIndex(src, audit);
  if (idx >= 0) {
    const next = src.slice();
    next[idx] = Object.assign({}, src[idx], { status: priorStatusFromAudit(audit), exitDate: '' });
    return { patients: next, reconstructed: false, patient: next[idx] };
  }
  const rebuilt = reconstructActivePatientFromAudit(audit);
  return { patients: src.concat([rebuilt]), reconstructed: true, patient: rebuilt };
}

/* True when the discharge that produced this audit row also created a cross-app
 * Outpatient lead (disposition === 'released_outpatient'; see PR #24's
 * createOutpatientLead). Restoring to active does NOT remove that lead, so the
 * operator is told to remove it manually in the Outpatient app. Pure + tested. */
function restoreNeedsOutpatientCleanup(audit) {
  return !!audit && audit.disposition === 'released_outpatient';
}

/* Bridge a released PATIENT row (the house view under הצג משוחררים) to the
 * discharged-audit record the restore-choice modal + workers operate on.
 * Prefers the matching NON-RESTORED audit row — same houseId+name+date key as
 * matchActivePatientIndex — so prior_status (and the audit id the restored
 * flag writes against) come from the real record. A released row with no audit
 * match (legacy release predating Phase 2e) gets a synthesized audit object:
 * prior_status '' → restores to active; the restorePatientToActive write then
 * appends a restored='TRUE' audit row for it, which is invisible (the tab
 * filters restored rows) and simply documents the restore. Pure + tested. */
function auditRowForReleasedPatient(p, dischargedPatients) {
  const match = (Array.isArray(dischargedPatients) ? dischargedPatients : []).find(d =>
    dischargeRowOpen(d) &&
    d.houseId === p.houseId && d.name === p.name && d.date === p.date);
  if (match) return match;
  return {
    id:           p.id || cryptoId(),
    houseId:      p.houseId || '',
    name:         p.name || '',
    date:         p.date || '',
    pay:          Number(p.pay) || 0,
    adv:          Number(p.adv) || 0,
    status:       'released',
    fromLead:     p.fromLead || '',
    exitDate:     p.exitDate || '',
    source:       p.source || '',
    notes:        p.notes || '',
    dischargedAt: '',
    disposition:  '',
    discharge_note: '',
    restored:     '',
    prior_status: '',
  };
}

/* ===== A deliberate re-activation must close the stay's open discharges =====
 * (CHANGELOG-reactivation-fix.md — PR #145's fix, re-landed.)
 * healClobberedDischarges runs on EVERY load and releases the first patient
 * whose houseId + name + date matches a NON-restored discharge audit row. The
 * only thing it reads is that restored flag, so it cannot tell a clobbered
 * discharge from a patient someone set back to live on purpose. Every write
 * that leaves a stay live therefore has to flag ALL of that stay's open audit
 * rows restored='TRUE' — one left open and the patient flips back to released
 * on the next load and silently vanishes from the house tab. The ✏️ edit
 * modal (released → פעיל), a direct re-add or an admission with the original
 * entry date (the new row is written FIRST in the house, so it is the heal's
 * first match), and a restore with a second open row all left rows open. */

/* Every OPEN (non-restored) discharge audit row of this stay — the same
 * houseId + name + date key matchActivePatientIndex uses. Pure + tested. */
function openDischargeAuditsFor(patient, dischargedPatients) {
  if (!patient) return [];
  return (Array.isArray(dischargedPatients) ? dischargedPatients : []).filter(d =>
    dischargeRowOpen(d) &&
    d.houseId === patient.houseId && d.name === patient.name && d.date === patient.date);
}

/* The open audit rows a deliberate write re-opens: `after` is the patient as
 * it will be saved, `before` (optional) the same patient before an edit — an
 * edit can fix the name / date / house in the same save, so both identities
 * count. Nothing when `after` is released. Deduplicated by audit id. Pure +
 * tested. */
function reopenedDischargeAudits(before, after, dischargedPatients) {
  if (!after || after.status === 'released') return [];
  const out = [];
  const seen = new Set();
  [after, before].forEach(p => {
    openDischargeAuditsFor(p, dischargedPatients).forEach(d => {
      if (seen.has(d.id)) return;
      seen.add(d.id);
      out.push(d);
    });
  });
  return out;
}

/* A NEW array with `rows` flagged restored='TRUE' (matched by audit id); the
 * input is never mutated, so a caller rolls back by keeping its old
 * reference. Pure + tested. */
function withAuditsRestored(dischargedPatients, rows) {
  const ids = new Set((rows || []).map(d => d.id));
  return (Array.isArray(dischargedPatients) ? dischargedPatients : []).map(d =>
    d && ids.has(d.id) ? Object.assign({}, d, { restored: 'TRUE' }) : d);
}

/* Persist those flags with the SAME restorePatientToActive action and payload
 * shape the restore-choice modal sends (a keyed upsert of the audit row by its
 * own id — no new backend action). Sequential; the first refusal rejects to
 * the caller, whose rollback restores its state. A view-mode session writes
 * nothing, exactly like saveAll. */
async function persistAuditsRestored(rows) {
  if (state.mode !== 'edit') return;
  for (const d of rows || []) {
    // R1 tracked; R3: the server names the audit row it flagged (an upsert by
    // its own id, so a retry is idempotent).
    const res = await trackedWrite([_dataGuard], () =>
      apiPost({ action: 'restorePatientToActive', patient: { ...d, restored: 'TRUE' } }));
    requireSavedId(res, r => r.restoredToActive === true && r.id, d.id);
  }
}

/* The ✏️ edit's message when the save (with a landed house move) went through
 * but closing the discharge rows did not. */
const REOPEN_NOT_CLOSED_MESSAGE = 'השינוי נשמר, אבל רישום השחרור לא נסגר — בטעינה הבאה המטופל יסומן שוב כמשוחרר. ערכו שוב את הסטטוס. ';

/* The toast loadAll shows when the heal moved patients to released. Names are
 * plain text (showToast sets textContent). Pure + tested. */
function healedToastMessage(healed) {
  return 'סומנו כמשוחררים לפי רישום שחרור פתוח: ' +
    (Array.isArray(healed) ? healed : []).map(p => String((p && p.name) || '')).join(', ');
}

/* ===== Restore-choice modal =====
 * The single שחזר button on a discharged row opens this modal: an explicit
 * choice between the two restore paths, radio-style (mirrors the
 * showCloseLeadModal look), with prior-status restore pre-selected as the
 * common case (undoing a discharge):
 *   ⦿ החזרה לסטטוס הקודם — flips the original patient row back to its
 *      pre-discharge status (prior_status; legacy rows → active) in their house.
 *   ○ פתיחת ליד חדש     — sends the person back into the leads pipeline as a
 *      brand-new lead (the original Phase 2e-2 behavior).
 * The modal IS the confirmation — the workers run without their own confirm.
 * Both workers handle rollback + error toasts themselves and never throw. */
function showRestorePatientChoiceModal(p) {
  if (state.mode !== 'edit') return;
  const root = document.getElementById('modal-root');
  const back = document.createElement('div');
  back.className = 'modal-backdrop';

  const prior      = priorStatusFromAudit(p);
  const priorInfo  = STATUS_OPTIONS.find(s => s.id === prior);
  const priorLabel = priorInfo ? priorInfo.label : 'פעיל';

  back.innerHTML = `
    <div class="modal">
      <h3>שחזור מטופל — ${escapeHtml(p.name || '')}</h3>
      <form>
        <div class="form-row">
          <fieldset class="reason-fieldset">
            <legend>לאן לשחזר?</legend>
            <label class="reason-radio">
              <input type="radio" name="restoreChoice" value="prev_status" checked />
              <span>החזרה לסטטוס הקודם (${escapeHtml(priorLabel)})</span>
            </label>
            <label class="reason-radio">
              <input type="radio" name="restoreChoice" value="new_lead" />
              <span>פתיחת ליד חדש</span>
            </label>
          </fieldset>
        </div>
        <div class="form-actions">
          <button type="button" class="btn" data-action="cancel">ביטול</button>
          <button type="submit" class="btn primary">אישור</button>
        </div>
      </form>
    </div>
  `;
  root.appendChild(back);

  const close     = () => back.remove();
  const cancelBtn = back.querySelector('[data-action="cancel"]');
  const submitBtn = back.querySelector('button[type="submit"]');
  const form      = back.querySelector('form');

  cancelBtn.onclick = close;
  back.addEventListener('click', e => { if (e.target === back) close(); });
  // R3: one new-lead id for this form — a retry never creates a second lead.
  const newLeadId = cryptoId();

  form.onsubmit = e => {
    e.preventDefault();
    return busyButton(submitBtn, 'save', async () => {
      cancelBtn.disabled = true;
      try {
        const choice = (new FormData(form).get('restoreChoice') || 'prev_status').toString();
        if (choice === 'new_lead') {
          await doRestorePatientAsNewLead(p, newLeadId);
        } else {
          await doRestorePatientToActive(p);
        }
        close();
      } catch (_) {
        // The worker rolled back and showed the Hebrew error; the modal stays
        // open with the choice, ready for a retry (R3).
      } finally {
        cancelBtn.disabled = false;
      }
    });
  };
}

/* Optimistic restore-to-active. Two persisted writes, in this order:
 *   1. saveAll() — re-activates the patient row via replaceHousePatients_
 *      (the Patients sheet has no dedicated action; status flips there). This
 *      is the IMPORTANT record, so it goes first.
 *   2. restorePatientToActive action — flags the audit row restored='TRUE' on
 *      the discharged sheet so it leaves the tab. NOT cosmetic: an open audit
 *      row is exactly what healClobberedDischarges re-releases on the next
 *      load, so every OTHER open row of the same stay is flagged too.
 * On any failure BOTH optimistic changes roll back (previous refs restored).
 * If write 2 fails after write 1 persisted, the next load's heal re-releases
 * the row on the sheet as well (its audit row is still open), so the sheet
 * converges back to the rolled-back UI — re-clicking restore is idempotent
 * (the match flips an already-active row in place, no duplicate). */
async function doRestorePatientToActive(p) {
  const prevPatients   = state.patients;
  const prevDischarged = state.dischargedPatients.slice();

  const { patients, patient: restoredRow } = buildRestoredToActivePatients(state.patients, p);
  state.patients = patients;
  // A stay discharged twice without a restore in between has a SECOND open
  // audit row; flagging only `p` let the heal release the patient again.
  const siblings = openDischargeAuditsFor(p, prevDischarged).filter(d => d.id !== p.id);
  // Flag the audit row(s) locally so renderDischargedPatients' restored-filter
  // hides them; the row objects stay in state as the audit trail.
  state.dischargedPatients = withAuditsRestored(state.dischargedPatients, [p].concat(siblings));
  renderAll();

  try {
    // R3: the patient row is proven on the sheet, then each audit row flag.
    const rid = restoredRow && restoredRow.id ? String(restoredRow.id) : '';
    const res = await saveAll(rid ? { prove: { patients: [rid] } } : undefined);
    if (rid) requireProven(res, 'patients', rid);
    await persistAuditsRestored([p].concat(siblings));
  } catch (e) {
    state.patients = prevPatients;
    state.dischargedPatients = prevDischarged;
    renderAll();
    showError('החזרת המטופל לסטטוס הקודם נכשלה — ' + e.message);
    throw e;   // the choice modal stays open (R3)
  }

  const restoredInfo = STATUS_OPTIONS.find(s => s.id === priorStatusFromAudit(p));
  showToast('המטופל הוחזר לסטטוס ' + (restoredInfo ? restoredInfo.label : 'פעיל'));
  // The discharge that produced this row may have created a cross-app Outpatient
  // lead (released_outpatient, PR #24). Restoring to active does not remove it,
  // so prompt the operator to clean it up manually in the Outpatient app.
  if (restoreNeedsOutpatientCleanup(p)) {
    showToast('שים לב: יש להסיר ידנית את ליד טיפול החוץ באפליקציית אאוטפיישנט');
  }
}

/* ===== BUSY-BUTTON PATTERN — START (duplicated verbatim; keep in sync) =====
 *
 * ONE loading-spinner pattern for the whole product: every async user action
 * runs through busyButton(), so the control the user actually pressed freezes,
 * announces itself to assistive tech and says in Hebrew what it is doing for
 * as long as the round-trip is in flight.
 *
 * It is DUPLICATED, not imported, on purpose: /meeting-report must never load
 * the dashboard bundle (house managers get a small standalone page, not the
 * 350 KB app), so the identical block lives in BOTH public/app.js and
 * public/meeting-report.js under the SAME name. test/loading-spinners.test.js
 * extracts the text between these two markers out of both files and fails the
 * build if they drift by a single character — and separately fails if
 * meeting-report.html ever pulls app.js or style.css.
 *
 * Contract:
 *   - busy = disabled + aria-busy="true" + class 'is-busy' (the pure-CSS
 *     spinner, rendered BEFORE the label in the inline direction so it is
 *     RTL-correct, and static rather than animated under
 *     prefers-reduced-motion) + the label swapped to the Hebrew busy word for
 *     the kind of work: 'save' → שומר…, 'load' → טוען…, 'delete' → מוחק…,
 *     'send' → שולח…;
 *   - a second click while busy does NOTHING — it never reaches `fn`, so a
 *     double tap on a slow phone can never fire two writes;
 *   - the button is restored in a finally, so a success, a rejected fetch and
 *     a validation refusal all end with a usable button carrying its original
 *     label and its original disabled state;
 *   - a falsy button is a passthrough (fn still runs), so a caller whose
 *     trigger was re-rendered away never silently loses its action.
 *
 * ES5 (var/function, no arrows, no template literals) because the two copies
 * must be byte-identical and public/meeting-report.js is ES5 throughout.
 */
var BUSY_LABELS = {
  save: 'שומר…',
  load: 'טוען…',
  'delete': 'מוחק…',
  send: 'שולח…'
};

function busyLabelFor(kind) {
  return BUSY_LABELS[kind] || BUSY_LABELS.save;
}

/* true while `btn` is mid-action. Read off the DOM (aria-busy), never a
 * closure flag, so the guard, the CSS and assistive tech all read the same
 * single source of truth — and a caller that re-enters from a different
 * handler sees it too. */
function busyButtonActive(btn) {
  return !!(btn && btn.getAttribute && btn.getAttribute('aria-busy') === 'true');
}

function busyButton(btn, kind, fn) {
  if (!btn) return Promise.resolve().then(fn);
  if (busyButtonActive(btn)) return Promise.resolve(undefined);
  var prevLabel = btn.textContent;
  var prevDisabled = btn.disabled;
  btn.setAttribute('aria-busy', 'true');
  btn.disabled = true;
  btn.classList.add('is-busy');
  btn.textContent = busyLabelFor(kind);
  return Promise.resolve().then(fn).finally(function () {
    btn.removeAttribute('aria-busy');
    btn.classList.remove('is-busy');
    btn.disabled = prevDisabled;
    btn.textContent = prevLabel;
  });
}
/* ===== BUSY-BUTTON PATTERN — END ===== */

/* ===== Inline field saving indicator =====
 *
 * busyButton swaps a BUTTON's label. An <input> or <select> has no label to
 * swap — and browsers do not render ::before/::after on form controls at all —
 * so an inline autosave (the [data-field] pattern on the lead card, the
 * meetings-board outcome select, the billing row controls) needs its own
 * affordance.
 *
 * This is NOT a second spinner. The marker it inserts carries the very same
 * `is-busy` class the button helper uses, so it renders the identical ring from
 * the identical CSS, followed by the identical Hebrew word out of BUSY_LABELS.
 * One vocabulary, one stylesheet rule; only the attachment differs.
 *
 * Contract, matching busyButton:
 *   - a second change while the first is in flight does NOTHING (the guard is
 *     aria-busy read off the DOM, so it cannot double-write);
 *   - the marker is removed in a finally — success, rejected fetch and
 *     validation refusal alike — so a field is NEVER left looking mid-save;
 *   - a failed save is not left looking saved either: the worker's own rollback
 *     restores the previous value and surfaces the Hebrew error (updateLead and
 *     savePayment already do exactly this, and this helper does not touch that
 *     logic);
 *   - a falsy element is a passthrough, and a detached node (a re-render can
 *     replace the field mid-flight) is tolerated rather than thrown on. */
var FIELD_SAVING_CLASS = 'field-saving';

/* Insert the marker after `el`, or return null when the node has no parent
 * (already detached by a re-render — nothing to attach to, and that is fine). */
function fieldSavingMarker(el, kind) {
  if (!el || !el.parentNode || typeof document === 'undefined') return null;
  var span = document.createElement('span');
  span.className = FIELD_SAVING_CLASS + ' is-busy';
  span.setAttribute('aria-busy', 'true');
  span.textContent = busyLabelFor(kind);
  el.parentNode.insertBefore(span, el.nextSibling);
  return span;
}

function withFieldSaving(el, kind, fn) {
  if (!el) return Promise.resolve().then(fn);
  if (el.getAttribute && el.getAttribute('aria-busy') === 'true') return Promise.resolve(undefined);
  if (el.setAttribute) el.setAttribute('aria-busy', 'true');
  var marker = fieldSavingMarker(el, kind);
  return Promise.resolve().then(fn).finally(function () {
    if (el.removeAttribute) el.removeAttribute('aria-busy');
    if (marker && marker.parentNode) marker.parentNode.removeChild(marker);
  });
}

/* Confirm dialog with "אישור" / "ביטול" buttons. Reuses the same backdrop +
 * surface styling as the form modal but with no fields.
 *
 * Options:
 *   text          — single-sentence Hebrew prompt (escaped, rendered inside <p>)
 *   onConfirm     — async callback fired when the user clicks confirm
 *   confirmLabel  — text on the confirm button (default 'אישור')
 *   danger        — when true, the confirm button uses .btn.danger (red
 *                   destructive gradient) instead of .btn.primary
 *
 * Backward-compatible with the prior {text, onConfirm} signature — existing
 * callers (restoreIrrelevantLead) continue to render with 'אישור' / primary. */
function showConfirm({ text, onConfirm, confirmLabel = 'אישור', danger = false }) {
  const root = document.getElementById('modal-root');
  const back = document.createElement('div');
  back.className = 'modal-backdrop';
  const confirmClass = danger ? 'btn danger' : 'btn primary';
  back.innerHTML = `
    <div class="modal confirm-modal">
      <p class="confirm-text">${escapeHtml(text)}</p>
      <div class="form-actions">
        <button type="button" class="btn" data-action="cancel">ביטול</button>
        <button type="button" class="${confirmClass}" data-action="confirm">${escapeHtml(confirmLabel)}</button>
      </div>
    </div>
  `;
  root.appendChild(back);

  const close = () => back.remove();
  const cancelBtn  = back.querySelector('[data-action="cancel"]');
  const confirmBtn = back.querySelector('[data-action="confirm"]');
  /* Busy discipline (async-button pass): the dialog used to close IMMEDIATELY
   * and run onConfirm untracked, leaving no feedback during a slow round-trip
   * and letting the underlying row button be re-clicked. Now the dialog stays
   * open with both buttons disabled + a spinner until onConfirm settles, then
   * closes (the workers own rollback/toasts; errors are still caught here). */
  /* The busy state belongs HERE, on the dialog's action button, not on the row
   * button that opened it: an optimistic worker re-renders the list and destroys
   * that trigger mid-flight, while #modal-root is untouched by any re-render.
   * busyButton owns the double-click guard, the label swap and the restore;
   * `busyConfirm` mirrors its aria-busy so cancel and the backdrop stay locked
   * for exactly as long. A destructive dialog says «מוחק…», any other «שומר…». */
  const busyConfirm = () => confirmBtn.getAttribute('aria-busy') === 'true';
  cancelBtn.onclick = () => { if (!busyConfirm()) close(); };
  back.addEventListener('click', e => { if (e.target === back && !busyConfirm()) close(); });

  confirmBtn.onclick = () => {
    // ביטול freezes SYNCHRONOUSLY, at the tap — busyButton runs its worker on a
    // microtask, and the cancel button must not stay live for even that long.
    // A second click is dropped by busyButton before the worker runs, so this
    // redundant re-freeze cannot unfreeze the first one.
    cancelBtn.disabled = true;
    return busyButton(confirmBtn, danger ? 'delete' : 'save', async () => {
      try { await onConfirm(); }
      catch (err) {
        console.error('[E-ZONE] confirm onConfirm threw:', err);
        showError(err.message || 'הפעולה נכשלה');
      }
      // Closes on success AND on a handled failure, exactly as before — the
      // workers own rollback and their own Hebrew error.
      cancelBtn.disabled = false;
      close();
    });
  };
}

/* Phase 2d-2 closure modal. Mirrors showIrrelevantReasonModal but driven by
 * DISPOSITION_LABELS (three first-class outcomes: not_relevant / completed
 * / stopped_early) instead of the Phase 2b reason map. Submit stays disabled
 * until a disposition is picked. onConfirm payload: { disposition, note }.
 *
 * Phase 2e-2: accepts optional `dispositions` (array of keys to render —
 * defaults to all 3 keys of DISPOSITION_LABELS) and `title` (defaults to
 * 'סגירת ליד'). Patient discharge passes a 2-key subset + 'שחרור מטופל'.
 * Existing closeLead caller relies on defaults.
 *
 * PR 2 (discharge): accepts optional `dateField` = { name, label }. When given,
 * an OPTIONAL native <input type="date"> (empty default, never required) is
 * rendered and its value is added to the onConfirm payload under `name`. Callers
 * that omit dateField (e.g. closeLead) get the unchanged { disposition, note }
 * payload and no date row — fully backward-compatible. */
function showCloseLeadModal({ onConfirm, dispositions, title, dateField }) {
  const root = document.getElementById('modal-root');
  const back = document.createElement('div');
  back.className = 'modal-backdrop';

  const keys      = Array.isArray(dispositions) && dispositions.length
                  ? dispositions
                  : Object.keys(DISPOSITION_LABELS);
  const heading   = title || 'סגירת ליד';

  const radiosHtml = keys.map(key => `
    <label class="reason-radio">
      <input type="radio" name="disposition" value="${escapeHtml(key)}" />
      <span>${escapeHtml(DISPOSITION_LABELS[key] || key)}</span>
    </label>
  `).join('');

  // Optional date row — only when a dateField is supplied. dir="rtl" + lang="he"
  // so the native picker honors the Hebrew locale, matching the lead "נוצר"
  // input. Starts empty and carries no `required`, so any disposition can be
  // confirmed without it.
  const dateRowHtml = dateField ? `
        <div class="form-row">
          <label>${escapeHtml(dateField.label || 'תאריך')}</label>
          <input type="date" name="${escapeHtml(dateField.name)}" lang="he" dir="rtl" />
        </div>` : '';

  back.innerHTML = `
    <div class="modal">
      <h3>${escapeHtml(heading)}</h3>
      <form>
        <div class="form-row">
          <fieldset class="reason-fieldset">
            <legend>סטטוס סגירה</legend>
            ${radiosHtml}
          </fieldset>
        </div>
        ${dateRowHtml}
        <div class="form-row">
          <label>פירוט</label>
          <textarea name="not_relevant_note" rows="3" maxlength="500"></textarea>
        </div>
        <div class="form-actions">
          <button type="button" class="btn" data-action="cancel">ביטול</button>
          <button type="submit" class="btn primary" disabled>אישור</button>
        </div>
      </form>
    </div>
  `;
  root.appendChild(back);

  const close = () => back.remove();
  const cancelBtn = back.querySelector('[data-action="cancel"]');
  const submitBtn = back.querySelector('button[type="submit"]');
  const form      = back.querySelector('form');
  const radios    = back.querySelectorAll('input[name="disposition"]');

  cancelBtn.onclick = close;
  back.addEventListener('click', e => { if (e.target === back) close(); });

  /* Enable submit only once a disposition is picked. No default selection
   * per spec — forces explicit choice. */
  radios.forEach(r => {
    r.addEventListener('change', () => {
      submitBtn.disabled = !Array.from(radios).some(x => x.checked);
    });
  });

  /* closeLead and dischargePatient both run behind this modal, and both are
   * optimistic-with-rollback. NOTHING about that changes here — the worker
   * still throws on failure, still rolls back, still surfaces its own Hebrew
   * error, and the modal still stays open for a retry. busyButton only adds the
   * spinner, the label and the double-submit guard on top. */
  form.onsubmit = e => {
    e.preventDefault();
    const picked = Array.from(radios).find(x => x.checked);
    if (!picked) return;                 // defensive — submit was disabled
    return busyButton(submitBtn, 'save', async () => {
      cancelBtn.disabled = true;
      try {
        const fd = new FormData(form);
        const disposition = (fd.get('disposition')         || '').toString();
        const note        = (fd.get('not_relevant_note')   || '').toString();
        const payload     = { disposition, note };
        if (dateField) {
          payload[dateField.name] = (fd.get(dateField.name) || '').toString();
        }
        await onConfirm(payload);
        close();
      } catch (err) {
        console.error('[E-ZONE] close-lead onConfirm threw:', err);
        showError(err.message || 'הפעולה נכשלה');
      } finally {
        cancelBtn.disabled = false;
      }
    });
  };
}

function showToast(msg) {
  const el = document.getElementById('toast-banner');
  if (!el) return;
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => el.classList.add('hidden'), 3500);
}

/* ===== Add Lead modal ===== */
function openAddLeadModal() {
  /* Tracks whether the user has manually picked a meetingWith value. Once
   * dirty, changing the house no longer overwrites their choice (see
   * autofillMeetingWith). Programmatic `.value =` from the house autofill does
   * not fire 'change', so it never flips this flag. */
  let meetingDirty = false;

  showModal({
    title: 'ליד חדש',
    fields: [
      /* פרטי המטופל — the patient. name/phone are unchanged from the original
       * form, so existing leads and the duplicate-phone check keep working. */
      { type: 'section', label: 'פרטי המטופל' },
      { name: 'name', label: 'שם מלא', type: 'text', required: true },
      { name: 'phone', label: 'טלפון', type: 'tel' },
      /* פרטי הפונה — the referrer. All optional; a lead with only patient
       * name+phone stays fully valid. */
      { type: 'section', label: 'פרטי הפונה' },
      { name: 'contactName',     label: 'שם', type: 'text' },
      { name: 'contactPhone',    label: 'טלפון', type: 'tel' },
      ...contactRelationFields(null),
      /* billingPhone selector — default מטופל. Resolved to a plain phone string
       * on submit (see resolveBillingPhone). */
      ...billingSelectorFields(null),
      { type: 'section', label: 'פרטים נוספים' },
      /* Changing the house auto-fills נפגש עם with that house's manager, unless
       * the user already set it. Houses with no manager (pardes/sde/external)
       * clear it. resolveHouseId maps the Hebrew label options below. */
      { name: 'house', label: 'בית מועדף', type: 'select',
        options: [{ value: '', label: '— ללא —' }, ...HOUSES.map(h => ({ value: h.name, label: h.name }))],
        onChange: (houseVal, form) => {
          const next = autofillMeetingWith(houseVal, meetingDirty, state.houseManagers);
          if (next === null) return;
          const sel = form.querySelector('[name="meetingWith"]');
          if (sel) sel.value = next;
        } },
      { name: 'source', label: 'מקור הפניה', type: 'text' },
      /* assignedTo (משוייך ל) — required. Empty placeholder option fails the
       * !values.assignedTo guard below, matching how `name` is validated. */
      { name: 'assignedTo', label: 'משוייך ל', type: 'select', required: true,
        options: [{ value: '', label: '— בחר —' }, ...ASSIGNEE_OPTIONS.map(a => ({ value: a, label: a }))] },
      /* meetingWith (נפגש עם) — house manager. No house is chosen yet at add
       * time, so the default resolves to '' (blank); it auto-fills when a house
       * is picked. A manual pick sets meetingDirty so the house autofill stops
       * overwriting it. Options come from state.houseManagers — never hardcoded. */
      { ...meetingWithField(managerForHouse('')), onChange: () => { meetingDirty = true; } },
      { name: 'note', label: 'הערות', type: 'textarea' },
    ],
    submitLabel: 'הוסף ליד',
    onSubmit: async values => {
      if (!values.name) { showError('יש להזין שם'); return false; }
      if (!values.assignedTo) { showError('יש לבחור משוייך ל'); return false; }

      const doCreateLead = async vals => {
        const id = cryptoId();
        /* Resolve the billing selector into the stored phone string. billingMode
         * / billingOther are selector-only and not lead fields — normalizeLead
         * ignores them; the explicit billingPhone below is what persists. */
        const billingPhone = resolveBillingPhone(
          vals.billingMode, vals.phone, vals.contactPhone, vals.billingOther);
        /* קשר למטופל resolves BEFORE normalizeLead, exactly like billingPhone:
         * under אחר the stored value is the typed text, never the literal
         * 'אחר'. The selector-only contactRelationOther is not a lead field —
         * normalizeLead builds an explicit object, so it is dropped here. */
        const contactRelation = resolveContactRelation(
          vals.contactRelation, vals.contactRelationOther);
        const lead = normalizeLead({
          id, ...vals, billingPhone, contactRelation,
          stage: 'new',
          /* todayISO() (YYYY-MM-DD) instead of a full toISOString() timestamp
           * so the value matches what the inline date picker reads/writes —
           * mismatched formats round-trip through isoDate() but the local
           * date field is the source of truth. */
          created: todayISO(),
        });
        state.leads.unshift(lead);
        renderAll();
        try {
          await saveAll();
        } catch (e) {
          state.leads = state.leads.filter(l => l.id !== id);
          renderAll();
          showError('הוספת ליד נכשלה — ' + e.message);
        }
      };

      const normalized = normalizePhone(values.phone);
      if (normalized) {
        const existing = findDuplicateLeadByPhone(normalized);
        if (existing) {
          /* Closes the Add Lead modal (showModal treats any non-false return
           * as success → calls close()). The user re-confirms in showConfirm;
           * cancel = no lead created, confirm = doCreateLead runs. */
          showConfirm({
            text: 'כבר קיים ליד "' + existing.name + '" עם הטלפון ' + values.phone + '. להוסיף בכל זאת?',
            confirmLabel: 'הוסף בכל זאת',
            onConfirm: () => doCreateLead(values),
          });
          return true;
        }
      }

      await doCreateLead(values);
      return true;
    }
  });
}

/* ===== Edit existing lead =====
 * For fixing typos or updating the preferred house / visit slot after a
 * lead has been created. Stage advancement still goes through the kanban
 * buttons — this modal only touches descriptive fields. */
function openEditLeadModal(lead) {
  showModal({
    title: 'עריכת ליד',
    fields: [
      { type: 'section', label: 'פרטי המטופל' },
      { name: 'name',  label: 'שם',          type: 'text',     required: true, value: lead.name || '' },
      { name: 'phone', label: 'טלפון',       type: 'tel',      value: lead.phone || '' },
      { type: 'section', label: 'פרטי הפונה' },
      { name: 'contactName',     label: 'שם',          type: 'text', value: lead.contactName || '' },
      { name: 'contactPhone',    label: 'טלפון',       type: 'tel',  value: lead.contactPhone || '' },
      ...contactRelationFields(lead),
      /* Billing selector initialized from the stored billingPhone (matches
       * patient → מטופל, matches contact → פונה, else אחר with the value). */
      ...billingSelectorFields(lead),
      { type: 'section', label: 'פרטים נוספים' },
      { name: 'house', label: 'בית מועדף',   type: 'select',
        value: lead.house || '',
        options: [{ value: '', label: '— ללא —' }, ...HOUSES.map(h => ({ value: h.name, label: h.name }))] },
      { name: 'created',   label: 'נוצר',          type: 'date', value: isoDate(lead.created || '') },
      { name: 'visitDate', label: 'תאריך ביקור', type: 'date', value: lead.visitDate || '' },
      /* Quarter-hour <select> (native time picker ignores step on mobile). An
       * off-step legacy value is preserved as an extra option (visitTimeOptions). */
      { name: 'visitTime', label: 'שעת ביקור',   type: 'select', value: lead.visitTime || '',
        options: visitTimeOptions(lead.visitTime) },
      /* meetingWith (נפגש עם) — keep an existing choice, otherwise default to
       * the manager of the lead's house. '' for pardes/sde/external. */
      meetingWithField(lead.meetingWith || managerForHouse(lead.house)),
      { name: 'note',  label: 'הערות',       type: 'textarea', value: lead.note || '' },
    ],
    submitLabel: 'שמור שינויים',
    onSubmit: async v => {
      if (!v.name) { showError('יש להזין שם'); return false; }
      const prev = { ...lead };
      lead.name        = v.name.trim();
      lead.phone       = v.phone || '';
      lead.house       = v.house || '';
      lead.created     = v.created || '';
      lead.visitDate   = v.visitDate || '';
      lead.visitTime   = v.visitTime || '';
      lead.meetingWith = v.meetingWith || '';
      lead.note        = (v.note || '').trim();
      lead.contactName     = (v.contactName || '').trim();
      lead.contactPhone    = (v.contactPhone || '').trim();
      /* Under אחר the typed text is what persists (resolveContactRelation
       * trims it); every other selection — including an off-list legacy value
       * carried on its own pinned option — stores exactly what was selected. */
      lead.contactRelation = resolveContactRelation(v.contactRelation, v.contactRelationOther);
      lead.billingPhone    = resolveBillingPhone(
        v.billingMode, v.phone, v.contactPhone, v.billingOther);
      renderAll();
      try {
        await saveAll();
      } catch (e) {
        Object.assign(lead, prev);
        renderAll();
        showError('שמירה נכשלה — ' + e.message);
        return false;
      }
      return true;
    }
  });
}

/* ===== Entry modal: paid → entry, creates patient ===== */
function openEntryModal(lead) {
  const preferredHouse = houseByName(lead.house);
  // R3: ONE patient id per form — a retry after a lost answer re-sends it and
  // the server's merge matches it (never a second patient row).
  const patientId = cryptoId();
  showModal({
    title: 'כניסה לבית — ' + lead.name,
    fields: [
      { name: 'houseId', label: 'בית', type: 'select', required: true,
        value: preferredHouse ? preferredHouse.id : '',
        options: HOUSES.map(h => ({ value: h.id, label: h.name })) },
      { name: 'date', label: 'תאריך כניסה', type: 'date', required: true,
        value: lead.entryDate || todayISO() },
      { name: 'pay', label: 'תשלום חודשי כולל מע"מ (₪)', type: 'number', required: true },
      { name: 'adv', label: 'מקדמה ששולמה (₪)', type: 'number', required: true,
        value: String(lead.advance || 0) },
      { name: 'status', label: 'סטטוס', type: 'select',
        value: 'trial',
        options: STATUS_OPTIONS.filter(s => s.id !== 'released').map(s => ({ value: s.id, label: s.label })) },
    ].concat(admissionFunderFields()),
    submitLabel: 'אשר כניסה',
    onSubmit: async v => {
      if (!v.houseId || !v.date || !v.pay) { showError('שדות חסרים'); return false; }
      const funderErr = admissionFunderError(state.finance, v.funder);
      if (funderErr) { showError(funderErr); return false; }
      const patient = normalizePatient({
        id: patientId,
        houseId: v.houseId,
        name: lead.name,
        date: v.date,
        pay: Number(v.pay),
        adv: Number(v.adv),
        status: v.status || 'trial',
        fromLead: lead.id,
      });
      // Same stay as an open discharge (house + name + entry date)? Close it,
      // or the load-time heal releases the new row (see reopenedDischargeAudits).
      const prevDischarged = state.dischargedPatients;
      const reopened = reopenedDischargeAudits(null, patient, state.dischargedPatients);
      if (reopened.length) state.dischargedPatients = withAuditsRestored(state.dischargedPatients, reopened);
      state.patients.unshift(patient);
      const prevStage = lead.stage;
      const prevOutcome = lead.meetingOutcome;
      /* Retire the lead to the terminal 'admitted' stage instead of leaving it
       * at 'entry'. An 'entry' lead stays in promoteEnteredLeads' candidate
       * pool forever and re-stamps this patient's date from lead.entryDate on
       * every load (clobbering any later edit to the entry date). 'admitted' is
       * excluded from that pool (and from the board/pipeline), so once the
       * patient exists the lead can no longer overwrite it. */
      lead.stage = 'admitted';
      lead.entryDate = v.date;
      /* Record the meeting's conversion in the SAME save: a lead admitted after
       * a meeting (visitDate set) flips to 'entered', overwriting any prior
       * outcome. A lead with no meeting gets nothing (must not pollute stats). */
      const admitOutcome = admissionMeetingOutcome(lead);
      if (admitOutcome) lead.meetingOutcome = admitOutcome;
      renderAll();
      try {
        // R3: «נשמר» only when the sheet holds this patient's row — a
        // promotion the server refused (promoteSkipped) is not proven.
        const res = await saveAll({ prove: { patients: [patient.id] } });
        requireProven(res, 'patients', patient.id);
        await persistAuditsRestored(reopened);
      } catch (e) {
        state.patients = state.patients.filter(p => p.id !== patient.id);
        state.dischargedPatients = prevDischarged;
        lead.stage = prevStage;
        lead.meetingOutcome = prevOutcome;
        renderAll();
        showError('שמירה נכשלה — ' + e.message);
        return false;
      }
      await saveAdmissionFunder(patient, v.funder);
      return true;
    }
  });
}

/* ===== Direct-add patient (admin bypass of the Lead → Patient flow) =====
 * Used for historical patients who pre-date the app, cross-house transfers,
 * corrections, and non-lead referrals. Button is hidden in viewer mode via
 * .edit-only. Saved records are flagged source='direct_admin' so reports
 * can distinguish them from lead-converted patients; the Billing tab is
 * source-agnostic and treats them identically. */
function openDirectAddPatientModal(opts) {
  /* Intake mode («🟢 קליטת מטופל חדש», 2026-10-04): a NEW inpatient arriving
   * today. The same record and the same saveAll path — only the form differs:
   * the required fields are exactly name, house and admission date; the
   * monthly amount is optional (pre-filled, blank → 0) and the status is
   * always פעיל, so the new patient lands in occupancy and in the
   * coordinators feed (getPatientsForCoordinators) on save. A finance
   * session (Vered / Sandra) ALSO gets the required «גורם מממן» picker —
   * the admission funder rule (CHANGELOG-patient-funder-on-funders.md)
   * applies to intake exactly as to the direct-add form. */
  const intake = !!(opts && opts.intake);
  const fields = intakeFormFields(intake, state.currentHouseTab || HOUSES[0].id, todayISO());
  // R3: ONE patient id per form (see openEntryModal).
  const patientId = cryptoId();
  showModal({
    title: intake ? 'קליטת מטופל חדש' : 'הוספת מטופל ישירות',
    // The funder picker (finance sessions only, required there — PR #178)
    // rides along in BOTH modes.
    fields: fields.concat(admissionFunderFields()),
    submitLabel: intake ? 'קליטה' : 'הוסף מטופל',
    onSubmit: async v => {
      const missing = intakeMissingFields(v, intake);
      if (missing.length) {
        showError('שדות חובה חסרים: ' + missing.join(', '));
        return false;
      }
      const funderErr = admissionFunderError(state.finance, v.funder);
      if (funderErr) { showError(funderErr); return false; }
      const patient = normalizePatient({
        id: patientId,
        houseId: v.houseId,
        name: v.name.trim(),
        date: v.date,
        pay: Number(v.pay) || 0,
        adv: 0,
        status: intake ? 'active' : (v.status || 'active'),
        fromLead: '',
        source: 'direct_admin',
        notes: (v.notes || '').trim(),
      });
      // Re-adding a discharged patient with the ORIGINAL entry date recreates
      // a stay whose discharge rows are still open (see reopenedDischargeAudits).
      const prevDischarged = state.dischargedPatients;
      const reopened = reopenedDischargeAudits(null, patient, state.dischargedPatients);
      if (reopened.length) state.dischargedPatients = withAuditsRestored(state.dischargedPatients, reopened);
      state.patients.unshift(patient);
      // Jump to the house the new patient landed in so the admin can
      // immediately verify the record appeared.
      state.currentHouseTab = patient.houseId;
      renderAll();
      try {
        const res = await saveAll({ prove: { patients: [patient.id] } });
        requireProven(res, 'patients', patient.id);
        await persistAuditsRestored(reopened);
      } catch (e) {
        state.patients = state.patients.filter(x => x.id !== patient.id);
        state.dischargedPatients = prevDischarged;
        renderAll();
        showError('שמירה נכשלה — ' + e.message);
        return false;
      }
      await saveAdmissionFunder(patient, v.funder);
      if (intake) showToast('המטופל נקלט — ' + patient.name);
      return true;
    }
  });
}

/* The direct-add / intake form fields. Pure + tested. In intake mode the
 * ONLY required fields are name, house and admission date (תאריך כניסה). */
function intakeFormFields(intake, houseId, today) {
  const fields = [
    { name: 'name', label: 'שם מטופל', type: 'text', required: true },
    { name: 'houseId', label: 'בית', type: 'select', required: true,
      value: houseId,
      options: HOUSES.map(h => ({ value: h.id, label: h.name })) },
    { name: 'date', label: 'תאריך כניסה', type: 'date', required: true,
      value: today },
    { name: 'pay', label: 'סכום חודשי (₪)', type: 'number', required: !intake,
      value: '29000' },
  ];
  if (!intake) {
    fields.push({ name: 'status', label: 'סטטוס', type: 'select',
      value: 'active',
      options: [
        { value: 'active',   label: 'פעיל' },
        { value: 'released', label: 'יצא' },
      ] });
  }
  fields.push({ name: 'notes', label: 'הערות', type: 'textarea' });
  return fields;
}

/* Labels of the required fields missing from a submitted form. Pure + tested. */
function intakeMissingFields(v, intake) {
  const missing = [];
  if (!v || !String(v.name || '').trim()) missing.push('שם מטופל');
  if (!v || !v.houseId || !houseById(v.houseId)) missing.push('בית');
  if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(String(v.date || ''))) missing.push('תאריך כניסה');
  if (!intake && (!v || !v.pay)) missing.push('סכום חודשי');
  return missing;
}

/* ===== Edit existing patient =====
 * Lets admins fix typos, shift entry dates, adjust billing amounts, move
 * patients between houses, or toggle active/paused without deleting and
 * re-adding. Reuses the same showModal + saveAll plumbing as add-new. */
function openEditPatientModal(p) {
  const statusOptions = [
    { value: 'active', label: 'פעיל' },
    { value: 'wait',   label: 'הפסקה זמנית' },
  ];
  // Preserve any current status that isn't in the two spec'd options so
  // editing a trial/released patient for a typo doesn't silently reset it.
  if (p.status && !statusOptions.some(o => o.value === p.status)) {
    const extra = STATUS_OPTIONS.find(s => s.id === p.status);
    if (extra) statusOptions.push({ value: extra.id, label: extra.label });
  }

  showModal({
    title: 'עריכת מטופל',
    fields: [
      { name: 'name', label: 'שם מטופל', type: 'text', required: true, value: p.name || '' },
      { name: 'houseId', label: 'בית', type: 'select', required: true,
        value: p.houseId || '',
        options: HOUSES.map(h => ({ value: h.id, label: h.name })) },
      { name: 'date', label: 'תאריך כניסה', type: 'date', required: true, value: p.date || '' },
      { name: 'pay', label: 'תשלום חודשי (₪)', type: 'number', required: true, value: String(p.pay || 0) },
      { name: 'status', label: 'סטטוס', type: 'select',
        value: p.status || 'active',
        options: statusOptions },
      { name: 'notes', label: 'הערות', type: 'textarea', value: p.notes || '' },
    ],
    submitLabel: 'שמור שינויים',
    onSubmit: async v => {
      if (!v.name || !v.houseId || !v.date || v.pay === '') {
        showError('שדות חובה חסרים');
        return false;
      }
      const prev = { ...p };
      const prevDischarged = state.dischargedPatients;
      const houseChanged = p.houseId !== v.houseId;
      p.name    = v.name.trim();
      p.houseId = v.houseId;
      p.date    = v.date;
      p.pay     = Number(v.pay) || 0;
      p.status  = v.status || 'active';
      p.notes   = (v.notes || '').trim();
      // ✏️ is also how a released patient is set back to פעיל / הפסקה זמנית:
      // close the stay's open discharge rows with it, or the load-time heal
      // releases the patient again (see reopenedDischargeAudits).
      const reopened = reopenedDischargeAudits(prev, p, state.dischargedPatients);
      if (reopened.length) state.dischargedPatients = withAuditsRestored(state.dischargedPatients, reopened);
      if (houseChanged) {
        // The explicit move intent (serializePatients → collectHouseMoves_ in
        // Code.gs). Without it the backend cannot tell this deliberate move
        // from a stale tab, and refuses a lead-linked patient in a new house.
        // While an earlier move of this patient is still pending, the house it
        // is really leaving is still that move's origin; moving back there
        // cancels the move instead of sending one.
        const origin = p.movedFrom || prev.houseId;
        if (origin === v.houseId) delete p.movedFrom; else p.movedFrom = origin;
        state.currentHouseTab = p.houseId;
      }
      renderAll();
      let saved = false;
      let res = null;
      try {
        // R3: proven = the sheet holds this patient's row after the save.
        res = await saveAll({ prove: { patients: [String(p.id || '')] } });
        if (p.id) requireProven(res, 'patients', p.id);
        saved = true;
        // A house move the backend refused (or never confirmed) is undone
        // below — the discharge rows stay open with it.
        if (!houseChanged || houseMoveVerdict(p) === 'moved') {
          await persistAuditsRestored(reopened);
        } else {
          state.dischargedPatients = prevDischarged;
        }
      } catch (e) {
        state.dischargedPatients = prevDischarged;
        if (saved && houseChanged) {
          // The move already landed on the sheet: putting the patient back in
          // the old house here would send them there WITHOUT a move intent.
          // Keep the saved edit and say what did not save — the next load's
          // heal (announced by its toast) releases the patient again.
          renderAll();
          showError(REOPEN_NOT_CLOSED_MESSAGE + e.message, REFUSAL_BANNER_MS);
          return true;
        }
        Object.assign(p, prev);
        if (prev.movedFrom === undefined) delete p.movedFrom;
        renderAll();
        showError('שמירה נכשלה — ' + e.message);
        return false;
      }
      /* A stale-edit refusal of THIS patient (someone saved first): saveAll
       * already said who, and reloads the sheet. Nothing was saved, so the
       * form stays open with what was typed (R3). */
      if (!houseChanged && saveRefusedEdit(res, p.id)) {
        Object.assign(p, prev);
        state.dischargedPatients = prevDischarged;
        renderAll();
        return false;
      }
      if (houseChanged) {
        const verdict = houseMoveVerdict(p);
        if (verdict === 'moved') {
          showToast(p.name + ' הועבר/ה ל' + houseLabel(p.houseId));
        } else if (verdict === 'refused') {
          // saveAll already showed why (moveRefusalMessage), put the patient
          // back in the house they are really in, and is reloading the sheet.
          delete p._moveRefused;
          state.currentHouseTab = p.houseId;
          renderAll();
        } else {
          // Neither landed nor refused: an older backend, or a save that never
          // reached the sheet. Never leave the screen claiming a move that
          // did not happen — undo it here and say so.
          Object.assign(p, prev);
          delete p.movedFrom;
          state.currentHouseTab = p.houseId;
          renderAll();
          showError(moveNotSavedMessage(p.name, prev.houseId, v.houseId), REFUSAL_BANNER_MS);
        }
      }
      return true;
    }
  });
}

/* How a house move requested from the ✏ modal ended, read off the patient
 * object after its save settled (applySaveOutcome marks it):
 *   'moved'   — the backend confirmed it (the movedFrom intent was cleared);
 *   'refused' — the backend refused it with a reason (`_moveRefused`);
 *   'pending' — no save answered for it (an older backend / no save ran).
 * Pure. */
function houseMoveVerdict(p) {
  if (!p) return 'pending';
  if (p._moveRefused) return 'refused';
  return p.movedFrom ? 'pending' : 'moved';
}

/* ====================================================
   OCCUPANCY
   ==================================================== */
/* Occupancy headcount for a house — released patients NEVER count, regardless
 * of the הצג משוחררים display toggle. Single source of truth for the house-tab
 * (N/capacity) figures. Pure + tested. */
function houseOccupancyCount(patients, houseId) {
  return (Array.isArray(patients) ? patients : [])
    .filter(p => p && p.houseId === houseId && p.status !== 'released').length;
}

/* The rows the תפוסה list shows for a house: released patients are excluded
 * unless `showReleased` (the session-only toggle) is on; the search query
 * applies either way. Display-only — counts/KPIs never use this. Pure + tested. */
function visibleOccupancyRows(patients, houseId, query, showReleased) {
  return (Array.isArray(patients) ? patients : [])
    .filter(p => p && (showReleased || p.status !== 'released'))
    .filter(p => p.houseId === houseId)
    .filter(p => !query || (p.name || '').toLowerCase().includes(query));
}

function renderHouseTabs() {
  const tabs = document.getElementById('house-tabs');
  tabs.innerHTML = '';
  HOUSES.forEach(h => {
    const t = document.createElement('button');
    t.className = 'h-tab' + (state.currentHouseTab === h.id ? ' active' : '');
    const inHouse = houseOccupancyCount(state.patients, h.id);
    t.textContent = `${h.name} (${inHouse}/${h.capacity})`;
    t.onclick = () => {
      state.currentHouseTab = h.id;
      renderHouseTabs();
      renderPatients();
    };
    tabs.appendChild(t);
  });
}

function renderPatients() {
  const list = document.getElementById('patients-list');
  list.innerHTML = '';
  const q = state.patientSearch;
  const rows = visibleOccupancyRows(
    state.patients, state.currentHouseTab, q, state.showReleasedPatients);

  if (!rows.length) {
    list.innerHTML = `<div class="card" style="text-align:center;color:var(--text-muted);">אין מטופלים להצגה</div>`;
    return;
  }

  rows.forEach(p => {
    const isReleased = p.status === 'released';
    const firstDue = Math.max(0, (p.pay || 0) - (p.adv || 0));
    const statusInfo = STATUS_OPTIONS.find(s => s.id === p.status) || STATUS_OPTIONS[0];
    const badgeCls =
      p.status === 'active' ? 'active' :
      p.status === 'trial' ? 'trial' :
      p.status === 'released' ? 'released' : 'wait';

    const row = document.createElement('div');
    const funderCell = patientFunderCellHtml(p);
    row.className = 'patient-row' + (isReleased ? ' released' : '') + (funderCell ? ' has-funder' : '');
    row.innerHTML = `
      <div>
        <span class="p-label">מטופל</span>
        <span class="p-name">${escapeHtml(p.name)}</span>
      </div>
      <div>
        <span class="p-label">תאריך כניסה</span>
        <span class="p-val">${formatDate(p.date)}</span>
      </div>
      <div>
        <span class="p-label">תשלום חודשי</span>
        <span class="p-val">₪ ${(p.pay || 0).toLocaleString('he-IL')}</span>
      </div>
      <div>
        <span class="p-label">מקדמה</span>
        <span class="p-val">₪ ${(p.adv || 0).toLocaleString('he-IL')}</span>
      </div>
      <div>
        <span class="p-label">תשלום ראשון לגביה</span>
        <span class="p-val">₪ ${firstDue.toLocaleString('he-IL')}</span>
      </div>
      <div>
        <span class="p-label">סטטוס</span>
        <span class="badge ${badgeCls}">${statusInfo.label}${isReleased && p.exitDate ? ' · ' + formatDate(p.exitDate) : ''}</span>
      </div>
      ${funderCell}
      <div class="row-actions edit-only">
        ${isReleased
          ? `<button class="btn small primary" data-action="restore">שחזר</button>`
          : `<button class="btn small" data-action="release">שחרר</button>`}
        ${canDelete() ? '<button class="btn small danger" data-action="delete" data-role="deleter" title="מחק לצמיתות">✕</button>' : ''}
        <button class="btn small" data-action="edit" title="ערוך מטופל">✏️</button>
      </div>
    `;

    row.querySelector('[data-action="edit"]').onclick = () => openEditPatientModal(p);
    // The funder editor (finance sessions, edit mode — patientFunderCellHtml).
    const funderBtn = row.querySelector('.funder-edit-btn');
    if (funderBtn) funderBtn.onclick = () => openFunderModal(p);
    const releaseBtn = row.querySelector('[data-action="release"]');
    if (releaseBtn) releaseBtn.onclick = () => dischargePatient(p);
    /* Released rows (visible only under הצג משוחררים) restore through the SAME
     * choice modal as the discharged tab, bridged to that row's audit record. */
    const restoreBtn = row.querySelector('[data-action="restore"]');
    if (restoreBtn) restoreBtn.onclick = () =>
      showRestorePatientChoiceModal(auditRowForReleasedPatient(p, state.dischargedPatients));
    const deleteBtn = row.querySelector('[data-action="delete"]');
    if (deleteBtn) deleteBtn.onclick = e =>
      busyButton(e.currentTarget, 'delete', () => deletePatient(p));

    list.appendChild(row);
  });
}

/* ===== «מטופלים» — the patient list tab (CHANGELOG-patients-tab-ui.md) =====
 * The rows come from the pure helpers (patientListRows, pendingAdmissionRows,
 * patientProblemSummary — CHANGELOG-patients-tab-foundation.md). Every action
 * here is an EXISTING flow: ✏️ openEditPatientModal, «הגדר גורם מממן»
 * openFunderModal, «דווח תשלום» openPaymentReportModal, «קלוט כמטופל»
 * openEntryModal (the «כניסה לבית» admission), «שחזר»
 * showRestorePatientChoiceModal. Nothing new is written or sent.
 *
 * Restricted view (Shiran, Yael): no payment column, no funder cell or chip,
 * no «דווח תשלום» — patientListRows never reads money data without
 * `finance`, and the cells below are built only for a finance session. The
 * controller view (Ortal) has no tab: applyControllerView removes it and
 * renderAll returns first. Every value goes through escapeHtml — a lead's
 * notes are free text. */

/* The session's filters (never persisted). */
function patientsTabFilters() {
  if (!state.ptFilters) state.ptFilters = Object.assign({}, PATIENT_LIST_DEFAULT_FILTERS);
  return state.ptFilters;
}

/* The red problem chips of one row. Pure. */
function patientProblemChipsHtml(problems) {
  return (problems || []).map(p =>
    `<span class="plist-chip" data-problem="${escapeHtml(p.code)}">${escapeHtml(p.label)}</span>`).join('');
}

/* The «פרטי הליד» section (a closed <details>). Pure. */
function patientLeadDetailsHtml(row) {
  const L = row.lead;
  const via = row.leadInfo ? row.leadInfo.via : 'none';
  let body;
  if (L) {
    const item = (label, value) => `<div class="plist-lead-item"><span class="p-label">${escapeHtml(label)}</span>`
      + `<span class="p-val">${value ? escapeHtml(value) : '—'}</span></div>`;
    body = `<div class="plist-lead-grid">
        ${item('טלפון', L.phone)}
        ${item('מקור', L.source)}
        ${item('תאריך ביקור', L.visitDate ? formatDate(L.visitDate) : '')}
        ${item('מקדמה', L.advance ? '₪ ' + L.advance.toLocaleString('he-IL') : '')}
        ${item('משוייך ל', L.assignedTo)}
        ${item('נפגש עם', L.meetingWith)}
        ${item('בית בליד', L.house)}
      </div>
      <div class="plist-lead-note"><span class="p-label">הערות הליד</span>`
      + `<span class="p-val">${L.note ? escapeHtml(L.note) : '—'}</span></div>`;
  } else if (via === 'fromLead_missing') {
    body = '<div class="plist-lead-none">הליד המקושר לא נמצא</div>';
  } else if (via === 'ambiguous') {
    body = '<div class="plist-lead-none">ללא ליד · נמצאו כמה לידים תואמים, לא קושר</div>';
  } else {
    body = '<div class="plist-lead-none">ללא ליד</div>';
  }
  return `<details class="plist-lead"><summary>פרטי הליד${L ? '' : ' · ללא ליד'}</summary>${body}</details>`;
}

/* One patient row's HTML. `finance` = the session may see money data; `edit`
 * = edit mode. Pure (reads the funder rows only through currentFunderFor
 * when `finance`). */
function patientListRowHtml(row, finance, edit) {
  const p = row.patient;
  const house = HOUSES.find(h => h.id === p.houseId);
  const released = p.status === 'released';
  const statusInfo = STATUS_OPTIONS.find(s => s.id === p.status) || STATUS_OPTIONS[0];
  const cells = [];
  cells.push(`<div class="plist-name-cell"><span class="p-label">מטופל</span><span class="p-name">${escapeHtml(p.name)}</span>`
    + (released ? ` <span class="badge released">${escapeHtml(statusInfo.label)}${p.exitDate ? ' · ' + escapeHtml(formatDate(p.exitDate)) : ''}</span>` : '')
    + `</div>`);
  cells.push(`<div><span class="p-label">בית</span><span class="p-val">${escapeHtml(house ? house.name : p.houseId)}</span></div>`);
  cells.push(`<div><span class="p-label">תאריך כניסה</span><span class="p-val">${escapeHtml(p.date ? formatDate(p.date) : '—')}</span></div>`);
  cells.push(`<div><span class="p-label">ימים בבית</span><span class="p-val">${row.days == null ? '—' : escapeHtml(String(row.days))}</span></div>`);
  if (finance && funderView()) {
    const uid = patientUid(p);
    const cur = uid ? currentFunderFor(uid, patientFunderDay(p, todayISO())) : { unset: true };
    const value = cur.unset
      ? `<span class="funder-chip funder-unset" data-funder="unset">${escapeHtml(FUNDER_UNSET_LABEL)}</span>`
      : escapeHtml(cur.funder);
    cells.push(`<div class="plist-funder" data-finance><span class="p-label">גורם מממן</span><span class="p-val">${value}</span>`
      + (edit ? '<button type="button" class="btn small plist-funder-btn">הגדר גורם מממן</button>' : '') + `</div>`);
  }
  if (finance && row.payment) {
    const pay = row.payment;
    const owedKey = pay.key === 'funder_grace' ? pay.owed : pay.key;
    const canReport = edit && (owedKey === 'unpaid' || owedKey === 'partial');
    cells.push(`<div class="plist-pay" data-finance><span class="p-label">תשלום${pay.dueISO ? ' · ' + escapeHtml(formatDate(pay.dueISO)) : ''}</span>`
      + `<span class="badge pay-state pay-state-${escapeHtml(pay.key)}">${escapeHtml(pay.label)}</span>`
      + (canReport ? '<button type="button" class="btn small primary plist-report-btn">דווח תשלום</button>' : '') + `</div>`);
  }
  const chips = patientProblemChipsHtml(row.problems);
  return `
    <div class="plist-main">${cells.join('')}</div>
    ${chips ? `<div class="plist-chips">${chips}</div>` : ''}
    <div class="plist-foot">
      ${patientLeadDetailsHtml(row)}
      <div class="row-actions edit-only">
        ${released ? '<button type="button" class="btn small primary plist-restore-btn">שחזר</button>' : ''}
        <button type="button" class="btn small plist-edit-btn" title="ערוך מטופל">✏️</button>
      </div>
    </div>`;
}

/* One «ממתינים לקליטה» row's HTML. Pure. */
function pendingAdmissionRowHtml(r, edit) {
  const L = r.lead;
  const house = unadmittedHouseId(L.house);
  const h = HOUSES.find(x => x.id === house);
  const item = (label, value) => `<div><span class="p-label">${escapeHtml(label)}</span><span class="p-val">${value ? escapeHtml(value) : '—'}</span></div>`;
  return `
    <div class="plist-main">
      <div class="plist-name-cell"><span class="p-label">ליד</span><span class="p-name">${escapeHtml(L.name)}</span></div>
      ${item('בית', h ? h.name : L.house)}
      ${item('תאריך כניסה', L.entryDate ? formatDate(L.entryDate) : '')}
      ${item('ימים מהכניסה', r.days == null ? '' : String(r.days))}
      ${item('טלפון', L.phone)}
      ${item('מקור', L.source)}
      ${item('מקדמה', L.advance ? '₪ ' + Number(L.advance).toLocaleString('he-IL') : '')}
    </div>
    ${r.chipDays != null ? `<div class="plist-chips"><span class="plist-chip">${escapeHtml(`לא נקלט כמטופל · ${r.chipDays} ימים`)}</span></div>` : ''}
    ${edit ? '<div class="row-actions"><button type="button" class="btn small primary plist-admit-btn">קלוט כמטופל</button></div>' : ''}`;
}

/* The count on the «מטופלים» tab: active patients with at least one open
 * problem. Hidden at zero. */
function renderPatientsProblemsBadge(summary) {
  const el = document.getElementById('patients-problems-badge');
  if (!el) return;
  const n = summary ? summary.patients : 0;
  el.textContent = String(n);
  el.classList.toggle('hidden', n === 0);
}

function renderPatientsTab() {
  if (controllerView()) return;
  const today = debtAgingTodayIso();
  const summary = patientProblemSummary(state, today);
  renderPatientsProblemsBadge(summary);
  const list = document.getElementById('plist-list');
  if (!list) return;
  const f = patientsTabFilters();
  const finance = state.finance === true;
  const edit = state.mode === 'edit';

  const houseSel = document.getElementById('plist-house');
  if (houseSel) {
    houseSel.innerHTML = '<option value="">כל הבתים</option>'
      + HOUSES.map(h => `<option value="${escapeHtml(h.id)}">${escapeHtml(h.name)}</option>`).join('');
    houseSel.value = f.house;
  }
  const statusSel = document.getElementById('plist-status');
  if (statusSel) statusSel.value = f.status;
  const probEl = document.getElementById('plist-problems');
  if (probEl) probEl.checked = !!f.problemsOnly;

  const sumEl = document.getElementById('plist-summary');
  if (sumEl) {
    const parts = PATIENT_PROBLEMS.filter(p => summary.byCode[p.code] > 0)
      .map(p => `<span class="plist-chip" data-problem="${escapeHtml(p.code)}">${escapeHtml(p.label)} · ${summary.byCode[p.code]}</span>`);
    sumEl.innerHTML = summary.patients
      ? `<span class="plist-summary-head">${escapeHtml(`${summary.patients} מטופלים פעילים עם בעיות פתוחות`)}</span>${parts.join('')}`
      : '<span class="plist-summary-ok">אין בעיות פתוחות במטופלים הפעילים</span>';
  }

  // «ממתינים לקליטה» — follows the house and name filters, not the status one.
  const pendEl = document.getElementById('plist-pending');
  if (pendEl) {
    const q = normalizeNameForMatch(f.q);
    const pending = pendingAdmissionRows(state.leads, state.patients, state.payments || [], today, patientLeadPool(state))
      .filter(r => (!f.house || unadmittedHouseId(r.lead.house) === f.house)
        && (!q || normalizeNameForMatch(r.lead.name).indexOf(q) >= 0));
    pendEl.innerHTML = '';
    if (pending.length) {
      const head = document.createElement('h3');
      head.className = 'plist-section-title';
      head.textContent = `ממתינים לקליטה (${pending.length})`;
      pendEl.appendChild(head);
      pending.forEach(r => {
        const el = document.createElement('div');
        el.className = 'plist-row plist-pending-row';
        el.innerHTML = pendingAdmissionRowHtml(r, edit);
        const btn = el.querySelector('.plist-admit-btn');
        if (btn) btn.onclick = () => openEntryModal(r.lead);
        pendEl.appendChild(el);
      });
    }
  }

  const rows = patientListRows(state, f, today);
  const countEl = document.getElementById('plist-count');
  if (countEl) countEl.textContent = String(rows.length);
  list.innerHTML = '';
  if (!rows.length) {
    list.innerHTML = '<div class="card plist-empty">אין מטופלים להצגה</div>';
    return;
  }
  rows.forEach(row => {
    const p = row.patient;
    const el = document.createElement('div');
    el.className = 'plist-row' + (p.status === 'released' ? ' released' : '') + (row.problems.length ? ' has-problems' : '');
    el.dataset.id = p.id;
    el.innerHTML = patientListRowHtml(row, finance, edit);
    const on = (sel, fn) => { const b = el.querySelector(sel); if (b) b.onclick = fn; };
    on('.plist-edit-btn', () => openEditPatientModal(p));
    on('.plist-funder-btn', () => openFunderModal(p));
    on('.plist-report-btn', () => {
      const due = row.payment && row.payment.dueISO;
      if (due) openPaymentReportModal(p, paymentForPatientOnDate(p, due), due);
    });
    on('.plist-restore-btn', () => showRestorePatientChoiceModal(auditRowForReleasedPatient(p, state.dischargedPatients)));
    list.appendChild(el);
  });
}

/* Filter controls — wired once from initTabs. Each handler reads the LIVE
 * filters object (patientsTabFilters), never one captured at wiring time. */
function initPatientsTabFilters() {
  const set = (k, v) => { patientsTabFilters()[k] = v; renderPatientsTab(); };
  const search = document.getElementById('plist-search');
  if (search) search.oninput = e => set('q', String(e.target.value || '').trim());
  const house = document.getElementById('plist-house');
  if (house) house.onchange = e => set('house', String(e.target.value || ''));
  const status = document.getElementById('plist-status');
  if (status) status.onchange = e => {
    const v = String(e.target.value || '');
    set('status', ['active', 'released', 'all'].indexOf(v) >= 0 ? v : 'active');
  };
  const prob = document.getElementById('plist-problems');
  if (prob) prob.onchange = e => set('problemsOnly', !!e.target.checked);
}

/* Build the discharged-patient audit row (pure — no DOM, no I/O, so it's unit
 * tested directly). Resolves the effective discharge date: a user-entered
 * `dischargeDate` (from the optional date field) wins; an empty field falls
 * back to today. The resolved date lands in the existing `exitDate` column —
 * no new sheet column, so this stays frontend-only. `dischargedAt` remains the
 * true action timestamp, independent of the user-chosen date. */
function dischargeAuditRow(patient, { disposition, note, dischargeDate }, today) {
  const picked   = dischargeDate ? isoDate(dischargeDate) : '';
  const exitDate = picked || today || todayISO();
  return {
    ...patient,
    /* Patient identity foundation: the patient's `id` is now PERSISTED on the
     * Patients sheet and survives reloads, so the audit row must carry its
     * OWN fresh id — otherwise a second discharge after a restore would upsert
     * over the first discharge's audit row (upsertRowById_) and erase that
     * history. The audit ↔ patient link stays the houseId+name+date key the
     * restore flows already use (matchActivePatientIndex). */
    id:             cryptoId(),
    status:         'released',
    /* The status at the MOMENT of discharge — dischargePatient builds this row
     * BEFORE flipping p.status to 'released', so patient.status here is the
     * pre-discharge value (active/trial/wait). Restore-to-previous-status reads
     * it back; legacy audit rows (recorded before this field) have it blank. */
    prior_status:   patient.status || '',
    exitDate:       exitDate,
    dischargedAt:   new Date().toISOString(),
    disposition:    disposition,
    discharge_note: note,
  };
}

/* PR 2 — שחרר button entry point. Opens the closure modal with all THREE
 * discharge dispositions (סיים טיפול / הפסיק לפני הזמן / משוחרר לטיפול חוץ) plus
 * an optional תאריך שחרור date field, and performs TWO writes on confirm:
 *   1. existing release semantics: status='released' + exitDate (chosen date or
 *      today), persisted via saveAll → replaceHousePatients_ (no backend change).
 *   2. additive audit row to DISCHARGED_PATIENTS_SHEET via dischargePatient
 *      action, carrying disposition + discharge date + free-text note.
 * Optimistic UI for both. Rollback restores the patient mutation AND drops
 * the optimistic discharged row if either write fails.
 * NOTE: the משוחרר לטיפול חוץ option only records the disposition + date here;
 * the cross-app Outpatient lead creation is PR 3 — intentionally not built. */
/* Duplicate discharges (CHANGELOG-duplicate-discharges.md). The server
 * refuses a second OPEN discharge row for a stay and answers duplicate:true;
 * this is what the user reads then. */
const DISCHARGE_ALREADY_RECORDED_HE = 'השחרור כבר נרשם';

/* Stays (dischargeStayKey) with a discharge being saved right now in THIS
 * tab: a second confirm for the same stay — the house row's שחרר and the
 * renewals row's שחרור are two doors to the same worker — waits for nothing
 * and writes nothing. */
const dischargesInFlight = new Set();

function dischargePatient(p) {
  if (state.mode !== 'edit') return;

  /* ONE audit id per modal: a retry from the same modal (after a lost
   * response or a «נשמר חלקית» error — the modal stays open) re-sends the
   * SAME row, which the server upserts in place instead of appending a
   * second one. The old per-confirm cryptoId() was the duplicate's source. */
  const auditId = cryptoId();

  showCloseLeadModal({
    title: 'שחרור מטופל',
    dispositions: DISCHARGE_DISPOSITIONS,
    dateField: { name: 'dischargeDate', label: 'תאריך שחרור' },
    onConfirm: async (fields) => {
      const stay = dischargeStayKey(p) || ('id:' + String(p.id || ''));
      if (dischargesInFlight.has(stay)) {
        showToast('השחרור כבר בשמירה…');
        return;
      }
      dischargesInFlight.add(stay);
      try {
        await runDischarge(p, auditId, fields);
      } finally {
        dischargesInFlight.delete(stay);
      }
    },
  });
}

/* The discharge itself (both writes + the follow-ups). Split out of
 * dischargePatient only so the in-flight guard can wrap it. */
async function runDischarge(p, auditId, { disposition, note, dischargeDate }) {
  // Guard 2 (discharge re-promotion fix, insurance): retire the source lead
  // to the terminal 'admitted' stage (the same value retireAdmittedLeads
  // uses) so a later loadAll's promoteEnteredLeads can't re-create this
  // just-discharged patient from a lead still parked at 'entry'/'entered'.
  // Only a fromLead that resolves to a REAL lead is touched; hand-entered
  // patients (no fromLead) are covered by Guard 1. `prev` also captures the
  // lead's prior stage so a failed persist rolls the lead back with the
  // patient.
  const sourceLead = p.fromLead
    ? (state.leads || []).find(l => String(l.id) === String(p.fromLead)) || null
    : null;
  const prev = {
    status: p.status,
    exitDate: p.exitDate,
    lead: sourceLead,
    leadStage: sourceLead ? sourceLead.stage : undefined,
  };

  const auditRow = Object.assign(dischargeAuditRow(p, { disposition, note, dischargeDate }), { id: auditId });
  let exitDate = auditRow.exitDate;
  const rollback = () => {
    p.status = prev.status;
    p.exitDate = prev.exitDate;
    if (prev.lead) prev.lead.stage = prev.leadStage;
    state.dischargedPatients = state.dischargedPatients.filter(d => d.id !== auditRow.id);
    renderAll();
  };

  p.status   = 'released';
  p.exitDate = exitDate;
  if (sourceLead) sourceLead.stage = 'admitted';
  state.dischargedPatients = state.dischargedPatients || [];
  state.dischargedPatients.unshift(auditRow);
  renderAll();

  /* WRITE ORDER MATTERS (discharge-persistence fix). The audit row goes
   * FIRST: it is a keyed upsert on its own sheet that no saveAll can ever
   * clobber, so once it lands the discharge intent is durable — if the
   * saveAll below then fails, healClobberedDischarges completes the
   * release from the audit row on the next load. The old order (saveAll
   * first) had the fatal inverse: a failed audit write rolled the LOCAL
   * patient back to active while the sheet already said released, and the
   * session's next saveAll silently re-activated the sheet — the
   * discharge evaporated with nothing but a 6-second toast.
   *
   * The payload is the full auditRow (not {...p}): it carries
   * prior_status + exitDate + dischargedAt, which the old payload dropped
   * — persisted audit rows always had a blank prior_status, so
   * restore-to-previous-status silently fell back to 'active'. */
  let auditRes;
  try {
    // R1 tracked. R3: the server names the row it holds — this audit row, or
    // (duplicate:true) the stay's open row recorded earlier.
    auditRes = await trackedWrite([_dataGuard], () => apiPost({ action: 'dischargePatient', patient: auditRow }));
    requireSavedId(auditRes, r => (r.duplicate === true ? r.id : (r.patient && r.patient.id)),
      auditRes && auditRes.duplicate === true ? undefined : auditRow.id);
  } catch (e) {
    // Nothing persisted yet — a full rollback is truthful.
    rollback();
    showError('שחרור המטופל נכשל — לא נשמר. ' + e.message);
    throw e;
  }

  /* duplicate:true — this stay ALREADY has an open discharge row (an
   * earlier attempt whose answer was lost, or another tab). The server
   * wrote nothing. Drop the optimistic row, keep the patient released
   * (on the recorded exit date) so the Patients sheet matches the
   * recorded discharge, and skip the follow-ups the first discharge
   * already owned (outpatient lead, credits). */
  if (auditRes && auditRes.duplicate === true) {
    state.dischargedPatients = state.dischargedPatients.filter(d => d.id !== auditRow.id);
    if (auditRes.exitDate) { exitDate = String(auditRes.exitDate).slice(0, 10); p.exitDate = exitDate; }
    renderAll();
    showToast(DISCHARGE_ALREADY_RECORDED_HE);
    try {
      requireProven(await saveAll({ prove: { patients: [String(p.id)] } }), 'patients', p.id);
    } catch (e) {
      rollback();
      showError(DISCHARGE_ALREADY_RECORDED_HE + ' — הסטטוס יתעדכן בטעינה הבאה. ' + e.message);
      throw e;
    }
    return;
  }

  try {
    requireProven(await saveAll({ prove: { patients: [String(p.id)] } }), 'patients', p.id);
  } catch (e) {
    /* The audit row IS persisted; only the status flip failed. Roll the
     * UI back so it reflects the Patients sheet (still active), and let
     * the load-time heal finish the release — the discharge converges to
     * the user's intent instead of silently disappearing. */
    rollback();
    showError('שחרור המטופל נשמר חלקית — הסטטוס יתעדכן בטעינה הבאה. ' + e.message);
    throw e;
  }

  // PR 3 — cross-app effect: a "released to outpatient" discharge also
  // creates a lead in the Outpatient app. This runs ONLY after the local
  // discharge has fully persisted, and is deliberately NON-FATAL — a failed
  // Outpatient write must never roll back the (already saved) discharge.
  // createOutpatientLead swallows its own errors and warns the user, so we
  // await it without a try/throw: it cannot break the discharge.
  if (shouldCreateOutpatientLead(disposition)) {
    await createOutpatientLead(p);
  }

  // Credits / refunds — a SEPARATE write, offered only once BOTH discharge
  // writes above have succeeded. Nothing here can roll the discharge back:
  // the modal's save failures surface the Hebrew error banner and leave
  // the discharge intact; a deferred or failed credit is recoverable from
  // the מטופלים משוחררים tab (openCreditsForDischarged).
  // Restricted view: the refund step is skipped (Sandra / Vered create
  // the credit later from מטופלים משוחררים → «זיכויים»).
  if (financeView()) try {
    await showCreditsModal({
      patient: p, patientId: p.id ? String(p.id) : '', patientKey: patientKey(p), exitDate: exitDate,
    });
  } catch (e) {
    console.warn('[E-ZONE] credits modal failed to open:', e && e.message);
    showError('לא ניתן לפתוח את חלון הזיכויים — ניתן ליצור זיכוי מלשונית מטופלים משוחררים. ' + (e && e.message || ''));
  }
}

/* ====================================================
   CREDITS / REFUNDS LEDGER
   ====================================================
   Sheet: Credits (CREDIT_COLUMNS in Code.gs). Every amount is stored
   VAT-INCLUSIVE (the `pay` / Payments convention); displays divide by
   VAT_RATE. Two identity keys ride on every row — patientId (the persisted
   Patients id) and patientKey (the legacy triple that keys Payments) — both
   stored, neither derived from the other at read time. Full rules:
   CHANGELOG-credits-ledger.md. */

/* houseId → facility type. Mirrors FACILITY_TYPE_BY_HOUSE in Code.gs EXACTLY
 * (the server re-derives it from houseId on every write). Keys are the
 * Patients-sheet ids from HOUSES above, never the Hebrew display names. */
const FACILITY_TYPE_BY_HOUSE = {
  asher:  'residential',   // רעננה אשר
  ramot:  'residential',   // רמות השבים
  rehab:  'detox_dual',    // קיסריה ריהאב
  pardes: 'detox_dual',    // רעננה הפרדס
  arfoni: 'detox_dual',    // קיסריה עפרוני
  sde:    'detox_dual',    // שדה אליעזר
};
const FACILITY_TYPE_LABELS = { residential: 'מגורים', detox_dual: 'גמילה / דואלי' };
function facilityTypeFor(houseId) {
  return FACILITY_TYPE_BY_HOUSE[String(houseId || '').trim()] || '';
}

const CREDIT_TYPE_LABELS = {
  days_unused:    'ימים שלא נוצלו',
  prepaid_return: 'החזר תשלום מראש',
  other:          'זיכוי אחר',
};
const CREDIT_STATUS_LABELS = { pending: 'ממתין', paid: 'שולם', cancelled: 'בוטל' };

/* The credit status options a session is offered: «בוטל» (cancelCredit, a
 * DELETE_ACTIONS operation) only for a deleter — or when the line is already
 * cancelled, so its stored state still shows. Pure. */
function creditStatusOptionKeys(current, deleter) {
  return Object.keys(CREDIT_STATUS_LABELS).filter(s => s !== 'cancelled' || deleter === true || current === 'cancelled');
}
const CREDIT_TYPES = Object.keys(CREDIT_TYPE_LABELS);

/* The refund RULES live on the server only (computeRefund_ /
 * refundSuggestionsFor_ in Code.gs, reached through action=suggestRefunds).
 * This file holds no copy of them — see CHANGELOG-refund-logic-wiring.md. */
/* Credits pay out on this day of the month, never at discharge. */
const CREDIT_PAYOUT_DAY = 15;
/* A decision on or before this day of the month pays out on that month's
 * 15th; after it, on the next month's. Mirrors CREDIT_DECISION_CUTOFF_DAY in
 * Code.gs (test/refund-logic-wiring.test.js checks parity day by day). */
const CREDIT_DECISION_CUTOFF_DAY = 10;

/* Display mirror of creditId_() in Code.gs. The SERVER mints every persisted
 * id (it owns the seq counter under the lock); this exists for tests + logs. */
function creditId(patientId, allocationMonth, seq) {
  return `credit::${patientId}::${allocationMonth}::${seq}`;
}

/* 'YYYY-MM-DD' → local-midnight Date (getFullYear/getMonth/getDate parts —
 * never Date.parse, which would read the string as UTC midnight and drift the
 * day −1 in Israel). null for anything that is not a bare ISO date. */
function localDateFromISO(iso) {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}
function isoFromLocalDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
/* Whole calendar days from a to b (local midnights). Math.round absorbs the
 * ±1h a DST change injects between two local midnights, so a span across the
 * March / October switch still counts exact days — no drift. */
function diffWholeDays(a, b) {
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}
/* d + n months with the day-of-month CLAMPED to the target month's length
 * (Jan 31 + 1 → Feb 28/29, never a March overflow). Local parts throughout. */
function addMonthsClamped(d, n) {
  const y = d.getFullYear(), m = d.getMonth() + n, day = d.getDate();
  const last = new Date(y, m + 1, 0).getDate();
  return new Date(y, m, Math.min(day, last));
}
function addDays(d, n) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}
function roundMoney(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/* Longest period one payment row may claim to cover. A cycle is a month; a
 * year is already absurd. This exists so a mistyped year ('2027-01-05' for
 * '2026-01-05') is refused at the keyboard instead of quietly swallowing a
 * whole year of allocation. */
const COVERAGE_MAX_DAYS = 366;

/* Validate a recorded coverage period. '' when acceptable, otherwise the
 * Hebrew reason — the SAME function the editor calls before saving and the
 * same rule coveragePeriodError_() enforces in Code.gs on write, so the
 * client can never talk the server into storing something it would refuse.
 *
 * DELIBERATELY NOT REFUSED: overlaps and gaps BETWEEN rows. Both are real
 * — two months paid at once overlap nothing wrongly, a patient who skipped a
 * month leaves a genuine gap, and a re-dated cycle legitimately overlaps its
 * neighbour. The credits ledger already de-duplicates overlapping days
 * (creditedThrough), so an overlap costs nothing there; refusing one would
 * force the recorder to lie about what the money bought. What IS refused is
 * a period that cannot be true of a single row: half-filled, malformed,
 * backwards, or longer than a year. */
/* Normalize one coverage-period value to bare 'YYYY-MM-DD'.
 *   ''   — blank / absent (legal: it means "infer")
 *   null — present but unusable (the caller refuses)
 *
 * EXACT MIRROR of coverageDateISO_() in Code.gs, including what it does NOT
 * accept. Three shapes only: a bare ISO date naming a REAL day, a full ISO
 * timestamp (read by its LOCAL parts — never toISOString().slice(), which
 * lands a day early for Israel), and a Date object. Everything else is
 * refused rather than handed to `new Date()`, whose tolerance for loose
 * strings is engine-dependent and would let '2026-1-5' mean one thing here
 * and another on the server. A parity sweep over both implementations is
 * asserted in test/payment-coverage-period.test.js. */
function coverageDateISO(v) {
  if (v === null || v === undefined || v === '') return '';
  if (typeof v === 'string') {
    const t = v.trim();
    if (!t) return '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(t)) {
      /* Shape is not enough: '2026-02-30' matches and would roll over into
       * March 2. Insist the parts survive the round-trip, so a day that does
       * not exist is refused instead of silently becoming another one. */
      const d = localDateFromISO(t);
      return (d && isoFromLocalDate(d) === t) ? t : null;
    }
    if (!/^\d{4}-\d{2}-\d{2}T/.test(t)) return null;      // not a date we recognize
    const ts = new Date(t);
    return isNaN(ts.getTime()) ? null : isoFromLocalDate(ts);
  }
  // A number, a boolean or a plain object is NOT a date and is refused rather
  // than coerced (new Date(0) would read as 1970-01-01).
  if (!(v instanceof Date) || isNaN(v.getTime())) return null;
  return isoFromLocalDate(v);
}

function coveragePeriodError(startISO, endISO) {
  /* PRESENCE first, then validity — the same order as coveragePeriodError_().
   * Deciding "half-filled" from the PARSED value would report '' + 'garbage'
   * as a malformed date on one side and a missing date on the other. */
  const rawS = String(startISO == null ? '' : startISO).trim();
  const rawE = String(endISO == null ? '' : endISO).trim();
  if (!rawS && !rawE) return '';                            // blank pair → infer, the default
  if (!rawS || !rawE) return 'יש למלא גם תאריך התחלה וגם תאריך סיום לתקופת הכיסוי';
  const s = coverageDateISO(startISO), e = coverageDateISO(endISO);
  if (!s || !e) return 'תאריך לא תקין בתקופת הכיסוי';
  const ds = localDateFromISO(s), de = localDateFromISO(e);
  if (de < ds) return 'תאריך הסיום מוקדם מתאריך ההתחלה';
  const days = diffWholeDays(ds, de) + 1;
  if (days > COVERAGE_MAX_DAYS) return 'תקופת כיסוי ארוכה מדי (' + days + ' ימים, המקסימום ' + COVERAGE_MAX_DAYS + ')';
  return '';
}

/* The period a payment row pays for, INFERRED from its due date: dueDate D
 * through D + 1 month − 1 day (local parts) — never "until the next payment
 * row", which is usually absent at discharge. This was the whole rule before
 * coverageStart/coverageEnd existed, and it is still the DEFAULT offered when
 * a payment is recorded and the fallback for every row that carries none. */
function inferredCoverage(payment) {
  const start = localDateFromISO(isoDate(payment && payment.dueDate));
  if (!start) return null;
  return { start, end: addDays(addMonthsClamped(start, 1), -1) };
}

/* The period a payment row RECORDS, or null when it records none (blank
 * pair) or records something unusable. An unusable stored pair is treated as
 * absent rather than thrown: a row corrupted by a manual sheet edit must
 * still produce a window, and the inferred one is the honest fallback. */
function recordedCoverage(payment) {
  if (!payment) return null;
  if (coveragePeriodError(payment.coverageStart, payment.coverageEnd)) return null;
  const s = coverageDateISO(payment.coverageStart), e = coverageDateISO(payment.coverageEnd);
  if (!s || !e) return null;                                // blank pair — nothing recorded
  const start = localDateFromISO(s), end = localDateFromISO(e);
  if (!start || !end) return null;
  return { start, end };
}

/* THE ONE SOURCE OF TRUTH for "what period does this payment pay for", shared
 * by all three consumers: the credits ledger (via the server's suggestRefunds), the
 * הכנסות חודשיות allocation (buildMonthlyRevenue) and the גבייה row editor.
 *
 * THE RECORDED PERIOD WINS. coverageStart/coverageEnd are columns on the
 * payment row: when both are stored and usable they ARE the answer — the
 * person who took the money said what it bought, and an assumption does not
 * get to overrule them. When they are absent — every row written before this
 * PR — the period is inferred exactly as it always was, DERIVED ON READ. No
 * old row is ever rewritten, so history reads today exactly as it read
 * yesterday.
 *
 * → { start, end, source } as local Dates; source is 'recorded' | 'inferred',
 *   carried so a drill-down can say which it is rather than implying a
 *   precision it lacks. null only when there is neither a usable recorded
 *   pair nor a due date. */
function paymentCoverage(payment) {
  const rec = recordedCoverage(payment);
  if (rec) return { start: rec.start, end: rec.end, source: 'recorded' };
  const inf = inferredCoverage(payment);
  if (!inf) return null;
  return { start: inf.start, end: inf.end, source: 'inferred' };
}

/* Does this row's recorded period DIFFER from the cycle that would have been
 * inferred for it? Drives the "תקופה מותאמת" badge. A row that records
 * exactly the default is not marked — the badge means "somebody decided
 * otherwise", and a badge on every row would mean nothing. */
function coverageDiffersFromDefault(payment) {
  const rec = recordedCoverage(payment);
  if (!rec) return false;
  const inf = inferredCoverage(payment);
  if (!inf) return true;   // recorded a period for a row that has no cycle to infer
  return isoFromLocalDate(rec.start) !== isoFromLocalDate(inf.start)
      || isoFromLocalDate(rec.end)   !== isoFromLocalDate(inf.end);
}

/* Stamp the inferred cycle onto a payment that records no period, so the
 * value lands in the sheet as a FACT instead of being re-derived from an
 * assumption on every future read. Called from savePayment(), i.e. on every
 * write path there is — so "accept the default" costs the recorder zero
 * clicks and changes zero figures (the default IS what was being inferred).
 * A row that already records a period is returned untouched. */
function withDefaultCoverage(payment) {
  if (!payment) return payment;
  if (recordedCoverage(payment)) return payment;
  const inf = inferredCoverage(payment);
  if (!inf) return payment;
  return Object.assign({}, payment, {
    coverageStart: isoFromLocalDate(inf.start),
    coverageEnd:   isoFromLocalDate(inf.end),
  });
}

/* The coverage period's DISPLAY format lives in dateRangeHeHtml() (below,
 * with the rest of the date helpers). This file deliberately has no second
 * coverage-date formatter: the גבייה row and the הכנסות חודשיות
 * drill-down both call that one helper, so they cannot drift apart. */

/* DISPLAY ECHO of refundPayoutDate_() in Code.gs, which is authoritative:
 * the server derives every stored payoutDate (upsertCredit_). Kept here only
 * so the modal can show the date live while Vered edits the decision date.
 * Decided on the 1st–10th → the 15th of that month; the 11th onward → the
 * 15th of the next month. String arithmetic on the parts (no Date, no
 * timezone). Parity with Code.gs is tested for every day of a year. */
function payoutDateFor(decidedISO) {
  const m = String(decidedISO || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return '';
  let y = Number(m[1]), mo = Number(m[2]);
  if (Number(m[3]) > CREDIT_DECISION_CUTOFF_DAY) { mo += 1; if (mo > 12) { mo = 1; y += 1; } }
  return `${y}-${String(mo).padStart(2, '0')}-${String(CREDIT_PAYOUT_DAY).padStart(2, '0')}`;
}

/* Amount ÷ VAT_RATE for display — every credit figure is stored VAT-inclusive. */
function exVat(amount) {
  return Math.round((Number(amount) || 0) / VAT_RATE);
}
function fmtShekel(n) {
  return '₪ ' + (Number(n) || 0).toLocaleString('he-IL');
}

/* Hebrew label per rule, for suggestions built by the server (basis
 * basisVersion 2 — computeRefund_ in Code.gs). */
const CREDIT_RULE_LABELS = {
  stay_prorata:               'יציאה ביום שהייה 1–13 — זיכוי יחסי על המחזור הנוכחי',
  stay_day14_zero:            'יציאה ביום שהייה 14 ומעלה — ללא זיכוי על המחזור הנוכחי',
  residential_prorata:        'מגורים — זיכוי יחסי על הימים שלא שהה',
  residential_last_days_zero: '7 הימים האחרונים במחזור — ללא זיכוי',
  detox_prorata:              'גמילה/דואלי — יציאה עד יום 13 — זיכוי יחסי',
  detox_tenure_cutoff_zero:   'יום 14 ומעלה — ללא זיכוי',
  prepaid_return:             'מחזור ששולם מראש ולא התחיל — החזר מלא',
  cycle_fully_used:           'המחזור הסתיים לפני היציאה — ללא זיכוי',
};
/* Labels of the rules a credit SAVED BEFORE the wiring PR was decided under
 * (calendar-month last 7 days, tenure counted from day 0). Display only, so a
 * saved credit still reads as what was decided at the time — never relabelled
 * with today's rule. */
const CREDIT_RULE_LABELS_LEGACY = {
  residential_prorata:        'מגורים — זיכוי יחסי בכל אורך שהות',
  residential_last_days_zero: 'מגורים — שחרור בשבוע האחרון של החודש: אין זיכוי ימים',
  detox_prorata:              'גמילה/דואלי — שהות מתחת ל־14 יום: זיכוי יחסי',
  detox_tenure_cutoff_zero:   'גמילה/דואלי — שהות 14 יום ומעלה: אין זיכוי (חיתוך לשיקול דעת, חריגה באישור סנדרה)',
  prepaid_return:             'תשלום מראש — חלון הכיסוי מתחיל אחרי השחרור, מוחזר במלואו',
};
function isServerBasis(basis) {
  return !!basis && Number(basis.basisVersion) === 2;
}
function creditRuleLabel(basis) {
  if (!basis || !basis.rule) return '';
  const map = isServerBasis(basis) ? CREDIT_RULE_LABELS : CREDIT_RULE_LABELS_LEGACY;
  return map[basis.rule] || String(basis.rule);
}

/* Human-readable calculation trail persisted in the row's `reason` column at
 * creation (the machine copy is the `basis` JSON column). Built from the
 * server's breakdown; '' for anything else. Plain text — escaped on render. */
function creditBasisText(creditType, basis) {
  if (!isServerBasis(basis)) return '';
  const windowSource = basis.coverageWindowSource === 'recorded' ? ', תקופה שנרשמה על התשלום'
    : basis.coverageWindowSource === 'no_payment_row' ? ', אין שורת תשלום' : '';
  const parts = [
    creditRuleLabel(basis),
    `מחזור ${basis.cycleStart} → ${basis.cycleEnd} (${basis.cycleDays} ימים${basis.paymentDueDate ? ', תשלום ' + basis.paymentDueDate : ''}${windowSource})`,
    `כניסה ${basis.entryDate}, יציאה ${basis.exitDate} (יום שהייה ${basis.stayDay})`,
    `ימים ששהה במחזור ${basis.daysStayed}, ימים שלא שהה ${basis.daysNotStayed}` +
      (basis.alreadyCreditedThrough ? ` (עד ${basis.alreadyCreditedThrough} כבר זוכה בשורה קודמת)` : ''),
    `שולם ${basis.amountPaid} / ${basis.divisor} = תעריף יומי ${basis.dailyRate}; לפני הכלל ${basis.uncappedRefund}` +
      (basis.capped ? ' — הוגבל לסכום ששולם' : ''),
  ];
  if (creditType === 'prepaid_return') parts.push('מוחזר במלואו');
  return parts.join(' | ');
}

/* Hebrew message for a suggestRefunds refusal. Never a silent 0: the modal
 * shows this instead of a suggested amount. */
const REFUND_ERROR_MESSAGES = {
  unknown_house:      'לא ניתן לחשב זיכוי: הבית של המטופל לא מוכר במערכת. לא הוצע סכום — אפשר להוסיף זיכוי ידני.',
  exit_before_entry:  'לא ניתן לחשב זיכוי: תאריך היציאה לפני תאריך הכניסה.',
  bad_date:           'לא ניתן לחשב זיכוי: תאריך כניסה, יציאה או תשלום לא תקין.',
  bad_amount:         'לא ניתן לחשב זיכוי: סכום ששולם לא תקין באחת משורות התשלום.',
  bad_coverage:       'לא ניתן לחשב זיכוי: תקופת כיסוי לא תקינה בשורת תשלום.',
  missing_patientKey: 'לא ניתן לחשב זיכוי: חסר מזהה מטופל.',
  lock_busy:          LOCK_BUSY_MESSAGE_HE,
};
function refundErrorMessage(code) {
  return REFUND_ERROR_MESSAGES[code] || 'לא ניתן לחשב זיכוי כרגע — לא הוצע סכום. אפשר לנסות שוב או להוסיף זיכוי ידני.';
}

/* The server's refund suggestions for one discharge (action=suggestRefunds,
 * POST so no patient name rides a URL). → { suggestions, error } — error is a
 * code ('unknown_house', …, or 'network') and suggestions is [] with it.
 * Never throws. */
async function fetchRefundSuggestions(patient, pKey, exitDate) {
  try {
    const res = await apiPost({
      action: 'suggestRefunds',
      houseId: (patient && patient.houseId) || '',
      entryDate: isoDate(patient && patient.date) || '',
      exitDate: isoDate(exitDate) || '',
      patientKey: pKey || '',
    });
    const list = Array.isArray(res && res.suggestions) ? res.suggestions : null;
    if (!list) return { suggestions: [], error: 'refund_failed' };
    return { suggestions: list, error: '' };
  } catch (e) {
    if (isLockBusyError(e)) return { suggestions: [], error: 'lock_busy' };
    const code = e && e.data && e.data.error ? String(e.data.error) : 'network';
    return { suggestions: [], error: code };
  }
}

/* The refund rule in one Hebrew line, for the «זיכויים» modal. Picked by the
 * EXIT date through lib/refund-rules.js (window.RefundRules — the same rule
 * Code.gs computeRefund_ applies, parity-tested): an exit from
 * REFUND_RULE_V2_FROM on → the unified billing-month rule; earlier → the
 * per-house rule it was decided under. '' without a usable exit date or
 * without the rules file. CHANGELOG-refund-rule-v2.md. */
function refundPolicyNote(exitISO, facility) {
  const R = typeof RefundRules !== 'undefined' ? RefundRules : null;
  const exit = isoDate(exitISO);
  if (!R || !exit) return '';
  let version;
  try { version = R.refundRuleVersion(exit); } catch (_) { return ''; }
  const prepaid = 'מחזור ששולם מראש ומתחיל אחרי היציאה — החזר מלא.';
  if (version === 2) {
    return `כלל ההחזר (יציאה מ־${formatDateHe(R.REFUND_RULE_V2_FROM)}, כל הבתים): יציאה ביום השהייה ה־${R.REFUND_V2_NO_REFUND_FROM_DAY} ומעלה (יום הכניסה = יום 1, נספר גם מעבר לסוף החודש) — ללא זיכוי על המחזור הנוכחי; יציאה ביום שהייה 1–${R.REFUND_V2_NO_REFUND_FROM_DAY - 1} — זיכוי יחסי על המחזור הנוכחי. ${prepaid}`;
  }
  if (facility === 'residential') {
    return `כלל ההחזר (יציאה לפני ${formatDateHe(R.REFUND_RULE_V2_FROM)}, בית מאזן): יציאה ב־${R.REFUND_V1_RESIDENTIAL_LAST_DAYS} הימים האחרונים של חודש החיוב — ללא זיכוי. ${prepaid}`;
  }
  if (facility === 'detox_dual') {
    return `כלל ההחזר (יציאה לפני ${formatDateHe(R.REFUND_RULE_V2_FROM)}, גמילה / דואלי): יציאה ביום שהייה ${R.REFUND_V1_DETOX_CUTOFF_DAY} ומעלה — ללא זיכוי. ${prepaid}`;
  }
  return '';
}

/* The breakdown Vered reads under a suggested amount (server basis only).
 * Every value goes through escapeHtml. */
function creditBreakdownHtml(basis) {
  if (!isServerBasis(basis)) return '';
  const row = (k, v) => `<div class="credit-bd-row"><span class="credit-bd-k">${escapeHtml(k)}</span> <span class="credit-bd-v">${escapeHtml(v)}</span></div>`;
  const d = (iso) => formatDateHe(iso) || String(iso || '—');
  const rows = [
    row('מחזור:', `${d(basis.cycleStart)} – ${d(basis.cycleEnd)} (${basis.cycleDays} ימים)`),
    row('ימים ששהה במחזור:', String(basis.daysStayed)),
    row('ימים שלא שהה:', String(basis.daysNotStayed)),
    row('תעריף יומי:', `${fmtShekel(basis.dailyRate)} (${fmtShekel(basis.amountPaid)} ÷ ${basis.divisor})`),
  ];
  // Rule v2 (exit from 07/10/2026, every house) and v1 detox: the stay day
  // decides. v1 residential: the last 7 days of the cycle.
  if (Number(basis.ruleVersion) === 2 || basis.facilityType === 'detox_dual') rows.push(row('יום שהייה ביציאה:', String(basis.stayDay)));
  if (Number(basis.ruleVersion) !== 2 && basis.facilityType === 'residential' && basis.lastDaysFrom) {
    rows.push(row('7 הימים האחרונים במחזור:', `${d(basis.lastDaysFrom)} – ${d(basis.lastDaysTo)}`));
  }
  if (basis.alreadyCreditedThrough) rows.push(row('כבר זוכה עד:', d(basis.alreadyCreditedThrough)));
  rows.push(row('כלל:', creditRuleLabel(basis)));
  return `<div class="credit-breakdown">${rows.join('')}</div>`;
}

/* Pure. null when the line may be saved, else the Hebrew refusal:
 *   - amount must be a finite number ≥ 0 (0 is valid — a zero credit is a row);
 *   - amount ≠ calculatedAmount REQUIRES a non-empty overrideReason;
 *   - creditType ∈ CREDIT_TYPES; allocationMonth 'YYYY-MM'; decidedDate a date;
 *   - 'other' requires a free-text reason;
 *   - status 'paid' requires paidDate AND method (explicit action). */
function validateCreditLine(line) {
  if (!line || typeof line !== 'object') return 'שורת זיכוי לא תקינה';
  if (CREDIT_TYPES.indexOf(line.creditType) < 0) return 'סוג זיכוי לא מוכר';
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(line.allocationMonth || ''))) return 'חודש הזיכוי חסר או לא תקין (YYYY-MM)';
  const amount = Number(line.amount);
  const calculated = Number(line.calculatedAmount);
  if (line.amount === '' || line.amount === null || line.amount === undefined || !isFinite(amount) || amount < 0) return 'סכום הזיכוי חסר או לא תקין';
  if (!isFinite(calculated) || calculated < 0) return 'הסכום המחושב לא תקין';
  if (roundMoney(amount) !== roundMoney(calculated) && !String(line.overrideReason || '').trim()) {
    return 'הסכום שונה מהסכום המחושב — יש למלא נימוק לשינוי';
  }
  if (line.creditType === 'other' && !String(line.reason || '').trim()) return 'זיכוי אחר דורש סיבה';
  if (line.decidedDate && !/^\d{4}-\d{2}-\d{2}$/.test(String(line.decidedDate))) return 'תאריך ההחלטה לא תקין';
  if (line.status && !CREDIT_STATUS_LABELS[line.status]) return 'סטטוס לא מוכר';
  if (line.status === 'paid' && (!/^\d{4}-\d{2}-\d{2}$/.test(String(line.paidDate || '')) || !String(line.method || '').trim())) {
    return 'סימון כשולם דורש תאריך תשלום ואמצעי תשלום';
  }
  return null;
}

/* One Credits-sheet row → the client shape. Both identity keys are read
 * AS STORED (never derived from each other). */
function normalizeCredit(r) {
  if (!r || typeof r !== 'object') r = {};
  const type = String(r.creditType || '').trim();
  const status = String(r.status || '').trim();
  let basis = r.basis;
  if (typeof basis === 'string') { try { basis = basis ? JSON.parse(basis) : null; } catch (_) { basis = null; } }
  return {
    id:               String(r.id || ''),
    patientId:        String(r.patientId || ''),
    patientKey:       String(r.patientKey || ''),
    patientName:      String(r.patientName || ''),
    houseId:          resolveHouseId(r.houseId || ''),
    facilityType:     String(r.facilityType || ''),
    creditType:       CREDIT_TYPES.indexOf(type) >= 0 ? type : 'other',
    allocationMonth:  String(r.allocationMonth || '').slice(0, 7),
    calculatedAmount: Number(r.calculatedAmount) || 0,
    amount:           Number(r.amount) || 0,
    overrideReason:   String(r.overrideReason || ''),
    reason:           String(r.reason || ''),
    approvedBy:       String(r.approvedBy || ''),
    decidedDate:      r.decidedDate ? isoDate(r.decidedDate) : '',
    payoutDate:       r.payoutDate ? isoDate(r.payoutDate) : '',
    status:           CREDIT_STATUS_LABELS[status] ? status : 'pending',
    paidDate:         r.paidDate ? isoDate(r.paidDate) : '',
    method:           String(r.method || ''),
    notes:            String(r.notes || ''),
    basis:            basis && typeof basis === 'object' ? basis : null,
    createdAt:        String(r.createdAt || ''),
    createdBy:        String(r.createdBy || ''),
    updatedAt:        String(r.updatedAt || ''),
    updatedBy:        String(r.updatedBy || ''),
  };
}

/* Credits for a patient — matched on EITHER stored key (a row written before
 * an identity migration still joins by patientKey; a renamed patient still
 * joins by patientId). */
function creditsForPatient(credits, patientId, pKey) {
  return (Array.isArray(credits) ? credits : []).filter(c =>
    c && ((patientId && c.patientId === patientId) || (pKey && c.patientKey === pKey)));
}

/* Pending credits grouped by payoutDate, ascending, with a total per date —
 * the outgoing amount visible before each 15th. Pure. */
function pendingCreditsByPayout(credits) {
  const groups = {};
  (Array.isArray(credits) ? credits : []).forEach(c => {
    if (!c || c.status !== 'pending') return;
    const k = c.payoutDate || '—';
    if (!groups[k]) groups[k] = { payoutDate: k, total: 0, credits: [] };
    groups[k].total = roundMoney(groups[k].total + (Number(c.amount) || 0));
    groups[k].credits.push(c);
  });
  return Object.keys(groups).sort().map(k => groups[k]);
}

/* Re-read the Credits sheet into state (best-effort; a failure leaves the
 * current list in place and returns false). Used after a stale-save refusal
 * so the banner's "הנתונים רועננו" is true for credits too. */
async function reloadCredits() {
  /* A whole-data reload that used to run completely silently. It fires after a
   * stale-save refusal, i.e. exactly when the user is already confused about
   * what the screen shows — so it raises the same #loading-banner loadAll does,
   * cleared in a finally so a failed reload cannot strand it on screen. */
  setLoading(true);
  const ticket = _creditsGuard.begin();
  try {
    const cr = await apiGet({ action: 'getCredits' });
    // R1: a credit write that landed meanwhile is newer than this answer.
    return applyCreditsRead(ticket, cr);
  } catch (e) {
    console.warn('[E-ZONE] credits reload failed:', e && e.message);
    return false;
  } finally {
    setLoading(false);
  }
}

/* Persist one credit line (create when `id` is blank — the server mints it;
 * edit otherwise). Backend refusals are NEVER silent: apiPost throws on
 * {ok:false}; a stale-save `conflict` is rendered through the same Hebrew
 * banner the Patients merge uses (conflictsMessage) and re-thrown flagged
 * `handled` so the caller does not double-report it. A 200 whose body lacks
 * the echoed credit is treated as a failure too. Updates state.credits. */
async function saveCredit(credit) {
  if (state.mode !== 'edit') throw new Error('שמירת זיכוי אפשרית רק בעריכה');
  let res;
  try {
    // R1: counted in flight, noted on the credits guard.
    res = await trackedWrite([_creditsGuard], () => apiPost({ action: 'saveCredit', credit }));
  } catch (e) {
    if (e && e.data && e.data.error === 'conflict') {
      // Refresh FIRST so the banner's "refreshed" claim holds, then refuse.
      await reloadCredits();
      const msg = conflictsMessage({ conflicts: e.data.conflicts }) || 'הזיכוי לא נשמר — עודכן קודם על ידי משתמש/ת אחר/ת';
      showError(msg);
      const err = new Error(msg); err.handled = true; err.conflict = true;
      throw err;
    }
    throw e;
  }
  if (!res || res.ok !== true || !res.credit || !res.credit.id) {
    throw new Error('תשובת שרת לא תקינה בשמירת זיכוי');
  }
  const saved = normalizeCredit(res.credit);
  /* duplicate:true — the stay already has an OPEN credit for this rule; the
   * server wrote nothing and answered that row, which replaces the line. */
  if (res.duplicate === true) console.warn('[E-ZONE] credit already recorded — kept', saved.id);
  state.credits = Array.isArray(state.credits) ? state.credits : [];
  const idx = state.credits.findIndex(c => c.id === saved.id);
  if (idx >= 0) state.credits[idx] = saved; else state.credits.push(saved);
  markPayoutForecastStale();   // the forecast's sections move with every saved credit
  return saved;
}

/* Build the editable lines for the credits modal: every EXISTING row for the
 * patient first, then any suggestion for a (creditType, allocationMonth) pair
 * that has no row yet — so re-opening after a partial save never proposes a
 * duplicate of a credit already on the sheet. */
function buildCreditLines(existing, suggestions, today) {
  const decided = today || todayISO();
  /* A saved credit keeps its STORED payoutDate (origPayoutDate) unless Vered
   * changes its decision date — the server does the same (creditPayoutDate_). */
  const lines = (existing || []).map(c => Object.assign({}, c, {
    isNew: false, origDecidedDate: c.decidedDate || '', origPayoutDate: c.payoutDate || '',
  }));
  (suggestions || []).forEach(s => {
    const dup = lines.some(l => l.creditType === s.creditType && l.allocationMonth === s.allocationMonth);
    if (dup) return;
    lines.push({
      id: '', isNew: true, creditType: s.creditType, allocationMonth: s.allocationMonth,
      calculatedAmount: s.calculatedAmount, amount: s.calculatedAmount, overrideReason: '',
      reason: creditBasisText(s.creditType, s.basis),
      approvedBy: '', decidedDate: decided, payoutDate: payoutDateFor(decided),
      status: 'pending', paidDate: '', method: '', notes: '', updatedAt: '', basis: s.basis,
    });
  });
  return lines;
}

/* The payout date a line shows for a decision date: a SAVED credit whose
 * decision date is unchanged keeps its stored payoutDate (never re-dated);
 * anything else gets the display echo of the server rule. */
function linePayoutDate(line, decidedDate) {
  if (line && !line.isNew && line.origPayoutDate && decidedDate === line.origDecidedDate) return line.origPayoutDate;
  return payoutDateFor(decidedDate);
}

/* Hebrew RTL modal: the credit lines for one patient — suggestions after a
 * discharge and/or the existing rows (recovery / edit path). Vered can accept
 * or edit each amount; an amount that differs from calculatedAmount demands
 * an overrideReason before save (validateCreditLine, then again server-side).
 * calculatedAmount is displayed, never overwritten. The override input is
 * never disabled — the detox_dual 14-day zero is discretionary. Save is
 * guarded by busyButton; lines are written one by one and a failure stops
 * the run with the error banner, keeping the modal open (already-saved lines
 * are marked so a retry edits instead of duplicating). */
async function showCreditsModal({ patient, patientId, patientKey: pKey, exitDate }) {
  const root = document.getElementById('modal-root');
  if (!root) return;
  // The suggestion comes from the SERVER (computeRefund_). A refusal is shown
  // as a Hebrew error in the modal — never replaced by a silent 0.
  let suggestions = [];
  let suggestionError = '';
  if (exitDate) {
    setLoading(true);
    try {
      const got = await fetchRefundSuggestions(patient, pKey, exitDate);
      suggestions = got.suggestions;
      suggestionError = got.error;
    } finally {
      setLoading(false);
    }
    if (suggestionError) showError(refundErrorMessage(suggestionError));
  }
  const existing    = creditsForPatient(state.credits, patientId, pKey);
  const lines       = buildCreditLines(existing, suggestions);
  const facility    = facilityTypeFor(patient && patient.houseId);
  const policyNote  = refundPolicyNote(exitDate, facility);

  const back = document.createElement('div');
  back.className = 'modal-backdrop';

  const lineHtml = (l, i) => {
    const typeLabel = CREDIT_TYPE_LABELS[l.creditType] || l.creditType;
    const statusOpts = creditStatusOptionKeys(l.status, canDelete()).map(s =>
      `<option value="${s}" ${l.status === s ? 'selected' : ''}>${CREDIT_STATUS_LABELS[s]}</option>`).join('');
    const isOther = l.creditType === 'other';
    const b = l.basis;
    const ruleLabel = creditRuleLabel(b);
    const serverBasis = isServerBasis(b);
    return `
      <fieldset class="credit-line" data-line="${i}">
        <legend>${escapeHtml(typeLabel)}${l.isNew ? ' <span class="credit-new">חדש</span>' : ''}</legend>
        <div class="form-row credit-inline">
          <label>חודש</label>
          ${isOther && l.isNew
            ? `<input type="month" name="allocationMonth" value="${escapeHtml(l.allocationMonth)}" dir="ltr" required />`
            : `<span class="p-val" dir="ltr">${escapeHtml(l.allocationMonth || '—')}</span>`}
        </div>
        ${isOther ? '' : `
        <div class="credit-calc">
          מחושב: <b>${fmtShekel(l.calculatedAmount)}</b>
          <span class="credit-exvat">(${fmtShekel(exVat(l.calculatedAmount))} ללא מע"מ)</span>
          ${ruleLabel ? `<span class="credit-rule">${escapeHtml(ruleLabel)}</span>` : ''}
          ${serverBasis
            ? `${b.eligible === false && b.uncappedRefund > 0 ? `<span class="credit-cap">לפני הכלל: ${escapeHtml(fmtShekel(b.uncappedRefund))}</span>` : ''}
               ${creditBreakdownHtml(b)}`
            : `${b && b.eligible === false && b.uncappedAmount > 0 ? `<span class="credit-cap">לפני הכלל: ${fmtShekel(b.uncappedAmount)}${b.discretionary ? ' — ניתן לאשר חריגה בשדה הסכום עם נימוק' : ''}</span>` : ''}
               ${b && b.eligible !== false && b.capped ? `<span class="credit-cap">הוגבל לסכום ששולם — לפני ${l.creditType === 'prepaid_return' ? 'החזר מלא' : 'תקרה'} ${fmtShekel(b.uncappedAmount)}</span>` : ''}`}
        </div>`}
        <div class="form-row">
          <label>סכום הזיכוי (כולל מע"מ)</label>
          <input type="number" name="amount" min="0" step="1" value="${escapeHtml(String(l.amount))}" dir="ltr" required />
          <span class="credit-exvat" data-role="amount-exvat">${fmtShekel(exVat(l.amount))} ללא מע"מ</span>
        </div>
        <div class="form-row credit-override" ${roundMoney(l.amount) !== roundMoney(l.calculatedAmount) || isOther ? '' : 'hidden'}>
          <label>${isOther ? 'סיבת הזיכוי' : 'נימוק לשינוי הסכום'}</label>
          <input type="text" name="${isOther ? 'reason' : 'overrideReason'}" maxlength="300" value="${escapeHtml(isOther ? l.reason : l.overrideReason)}" />
        </div>
        <div class="form-row credit-inline">
          <label>אושר ע"י</label>
          <input type="text" name="approvedBy" maxlength="40" value="${escapeHtml(l.approvedBy || '')}" />
        </div>
        <div class="form-row credit-inline">
          <label>תאריך החלטה</label>
          <input type="date" name="decidedDate" value="${escapeHtml(l.decidedDate || '')}" dir="ltr" />
          <span class="credit-exvat" data-role="payout">ישולם ב־${escapeHtml(formatDateHe(linePayoutDate(l, l.decidedDate)) || '—')}</span>
        </div>
        <div class="form-row credit-inline">
          <label>סטטוס</label>
          <select name="status">${statusOpts}</select>
        </div>
        <div class="form-row credit-paid" ${l.status === 'paid' ? '' : 'hidden'}>
          <div class="credit-inline">
            <label>תאריך תשלום</label>
            <input type="date" name="paidDate" value="${escapeHtml(l.paidDate || '')}" dir="ltr" />
          </div>
          <div class="credit-inline">
            <label>אמצעי</label>
            <input type="text" name="method" maxlength="40" value="${escapeHtml(l.method || '')}" />
          </div>
        </div>
        <div class="form-row">
          <label>הערות</label>
          <input type="text" name="notes" maxlength="500" value="${escapeHtml(l.notes || '')}" />
        </div>
        ${l.reason && !isOther ? `<div class="credit-basis">${escapeHtml(l.reason)}</div>` : ''}
      </fieldset>`;
  };

  const render = () => {
    back.innerHTML = `
      <div class="modal credits-modal">
        <h3>זיכויים והחזרים — ${escapeHtml((patient && patient.name) || '')}${facility ? ` <span class="credit-new">${escapeHtml(FACILITY_TYPE_LABELS[facility])}</span>` : ''}</h3>
        ${policyNote ? `<p class="credit-policy">${escapeHtml(policyNote)}</p>` : ''}
        ${suggestionError ? `<div class="credit-error" role="alert">${escapeHtml(refundErrorMessage(suggestionError))}</div>` : ''}
        <form>
          <div class="credit-lines">${lines.map(lineHtml).join('')}</div>
          <button type="button" class="btn small" data-action="add-other">+ זיכוי ידני</button>
          <div class="form-actions">
            <button type="button" class="btn" data-action="cancel">ביטול</button>
            <button type="submit" class="btn primary">שמור זיכויים</button>
          </div>
        </form>
      </div>`;
    wire();
  };

  const close = () => back.remove();

  /* Pull the current field values back into `lines` (before a re-render or a
   * save). calculatedAmount is NEVER read from the form. */
  const collect = () => {
    back.querySelectorAll('.credit-line').forEach(fs => {
      const l = lines[Number(fs.dataset.line)];
      if (!l) return;
      const val = (n) => { const el = fs.querySelector(`[name="${n}"]`); return el ? el.value : undefined; };
      const amount = val('amount');
      if (amount !== undefined) l.amount = amount === '' ? '' : Number(amount);
      ['overrideReason', 'reason', 'status', 'notes', 'allocationMonth', 'approvedBy', 'decidedDate', 'paidDate', 'method'].forEach(n => {
        if (val(n) !== undefined) l[n] = val(n);
      });
      l.payoutDate = linePayoutDate(l, l.decidedDate);
      if (l.creditType === 'other' && l.isNew) l.calculatedAmount = l.amount === '' ? 0 : Number(l.amount);
    });
  };

  const wire = () => {
    back.querySelector('[data-action="cancel"]').onclick = close;
    back.querySelector('[data-action="add-other"]').onclick = () => {
      collect();
      const decided = todayISO();
      lines.push({
        id: '', isNew: true, creditType: 'other', allocationMonth: (isoDate(exitDate) || decided).slice(0, 7),
        calculatedAmount: 0, amount: 0, overrideReason: '', reason: '', approvedBy: '',
        decidedDate: decided, payoutDate: payoutDateFor(decided), status: 'pending', paidDate: '', method: '',
        notes: '', updatedAt: '', basis: null,
      });
      render();
    };
    // Live: reveal the override-reason row + refresh the ex-VAT echo as the
    // amount changes; reveal the paid fields on status=paid; echo payoutDate.
    back.querySelectorAll('.credit-line').forEach(fs => {
      const l = lines[Number(fs.dataset.line)];
      const amountEl = fs.querySelector('[name="amount"]');
      const ovr = fs.querySelector('.credit-override');
      const ex = fs.querySelector('[data-role="amount-exvat"]');
      if (amountEl) amountEl.addEventListener('input', () => {
        const v = Number(amountEl.value);
        if (ex) ex.textContent = fmtShekel(exVat(v)) + ' ללא מע"מ';
        if (ovr && l.creditType !== 'other') ovr.hidden = roundMoney(v) === roundMoney(l.calculatedAmount);
      });
      const statusEl = fs.querySelector('[name="status"]');
      const paidRow = fs.querySelector('.credit-paid');
      if (statusEl && paidRow) statusEl.addEventListener('change', () => {
        paidRow.hidden = statusEl.value !== 'paid';
        const pd = fs.querySelector('[name="paidDate"]');
        if (statusEl.value === 'paid' && pd && !pd.value) pd.value = todayISO();
      });
      const decidedEl = fs.querySelector('[name="decidedDate"]');
      const payoutEl = fs.querySelector('[data-role="payout"]');
      if (decidedEl && payoutEl) decidedEl.addEventListener('change', () => {
        payoutEl.textContent = 'ישולם ב־' + (formatDateHe(linePayoutDate(l, decidedEl.value)) || '—');
      });
    });
    const form = back.querySelector('form');
    form.onsubmit = (e) => {
      e.preventDefault();
      const submitBtn = back.querySelector('button[type="submit"]');
      busyButton(submitBtn, 'save', async () => {
        collect();
        // Validate EVERY line before the first write — no partial run on a
        // refusable payload.
        for (let i = 0; i < lines.length; i++) {
          const err = validateCreditLine(lines[i]);
          if (err) { showError(`${CREDIT_TYPE_LABELS[lines[i].creditType] || ''} ${lines[i].allocationMonth || ''}: ${err}`); return; }
        }
        let saved = 0;
        for (let i = 0; i < lines.length; i++) {
          const l = lines[i];
          const payload = {
            id: l.id || '', patientId, patientKey: pKey,
            patientName: (patient && patient.name) || '', houseId: (patient && patient.houseId) || '',
            creditType: l.creditType, allocationMonth: l.allocationMonth,
            calculatedAmount: roundMoney(l.calculatedAmount), amount: roundMoney(l.amount),
            overrideReason: roundMoney(l.amount) !== roundMoney(l.calculatedAmount) ? String(l.overrideReason || '').trim() : '',
            reason: l.reason || '', approvedBy: l.approvedBy || '', decidedDate: l.decidedDate || '',
            status: l.status || 'pending', paidDate: l.paidDate || '', method: l.method || '', notes: l.notes || '',
            basis: l.basis || {},
            updatedAt: l.updatedAt || '',
          };
          try {
            const row = await saveCredit(payload);
            Object.assign(l, row, { isNew: false });
            saved++;
          } catch (err) {
            if (!(err && err.handled)) showError('שמירת הזיכוי נכשלה — ' + (err && err.message || 'שגיאה'));
            if (err && err.conflict) {
              // The sheet's version won: rebuild the lines from the reloaded
              // state so Vered edits what is actually there, not her stale copy.
              const fresh = buildCreditLines(creditsForPatient(state.credits, patientId, pKey), suggestions);
              lines.splice(0, lines.length, ...fresh);
            }
            render();       // keep the modal open with what did / did not land
            renderAll();
            return;
          }
        }
        showToast(saved === 1 ? 'הזיכוי נשמר' : `נשמרו ${saved} זיכויים`);
        close();
        renderAll();
      }).catch(err => {
        if (!(err && err.handled)) showError(err && err.message || 'הפעולה נכשלה');
      });
    };
  };

  render();
  root.appendChild(back);
}

/* Recovery / edit entry point from the מטופלים משוחררים tab: create or edit
 * credits for an ALREADY-discharged patient without touching the discharge
 * record. The persisted patientId comes from the live Patients row (matched by
 * the same houseId+name+entryDate key the restore flows use — discharge never
 * deletes the row); a patient with no matching row can still edit credits
 * already keyed to the triple. Neither key is derived from the other. */
function openCreditsForDischarged(audit) {
  if (state.mode !== 'edit') return;
  const idx = matchActivePatientIndex(state.patients, audit);
  const row = idx >= 0 ? state.patients[idx] : null;
  const pKey = patientKey(audit);
  let patientId = row && row.id ? String(row.id) : '';
  if (!patientId) {
    const byKey = creditsForPatient(state.credits, '', pKey).find(c => c.patientId);
    patientId = byKey ? byKey.patientId : '';
  }
  if (!patientId) {
    showError('לא נמצאה שורת מטופל תואמת בגיליון המטופלים — לא ניתן ליצור זיכוי');
    return;
  }
  const patient = Object.assign({}, audit, row || {}, { name: audit.name, houseId: audit.houseId, date: audit.date });
  Promise.resolve(showCreditsModal({ patient, patientId, patientKey: pKey, exitDate: audit.exitDate || audit.dischargedAt || '' }))
    .catch(e => showError('לא ניתן לפתוח את חלון הזיכויים — ' + (e && e.message || '')));
}

/* Edit entry point from the payout view: the same modal, keyed by the row's
 * own stored identity (no suggestions — there is no discharge context). */
function openCreditsForCredit(c) {
  if (state.mode !== 'edit' || !c) return;
  const parts = String(c.patientKey || '').split('::');
  const patient = { id: c.patientId, houseId: c.houseId, name: c.patientName || parts[1] || '', date: parts[2] || '' };
  Promise.resolve(showCreditsModal({ patient, patientId: c.patientId, patientKey: c.patientKey, exitDate: '' }))
    .catch(e => showError('לא ניתן לפתוח את חלון הזיכויים — ' + (e && e.message || '')));
}

/* "סמן כשולם" — the EXPLICIT mark-paid action: method + paidDate, then a
 * status edit through saveCredit (stale-save guarded). Never automatic. */
function showMarkCreditPaidModal(c) {
  if (state.mode !== 'edit' || !c) return;
  const root = document.getElementById('modal-root');
  if (!root) return;
  const back = document.createElement('div');
  back.className = 'modal-backdrop';
  back.innerHTML = `
    <div class="modal">
      <h3>סימון זיכוי כשולם — ${escapeHtml(c.patientName || '')}</h3>
      <p class="credit-calc">${escapeHtml(CREDIT_TYPE_LABELS[c.creditType] || c.creditType)} ${escapeHtml(c.allocationMonth)} · <b>${fmtShekel(c.amount)}</b>
        <span class="credit-exvat">(${fmtShekel(exVat(c.amount))} ללא מע"מ)</span></p>
      <form>
        <div class="form-row"><label>תאריך תשלום</label><input type="date" name="paidDate" value="${escapeHtml(todayISO())}" dir="ltr" required /></div>
        <div class="form-row"><label>אמצעי תשלום</label><input type="text" name="method" maxlength="40" required placeholder="העברה / מזומן / המחאה" /></div>
        <div class="form-actions">
          <button type="button" class="btn" data-action="cancel">ביטול</button>
          <button type="submit" class="btn primary">סמן כשולם</button>
        </div>
      </form>
    </div>`;
  root.appendChild(back);
  const close = () => back.remove();
  back.querySelector('[data-action="cancel"]').onclick = close;
  back.addEventListener('click', e => { if (e.target === back) close(); });
  const form = back.querySelector('form');
  form.onsubmit = (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const paidDate = String(fd.get('paidDate') || '');
    const method = String(fd.get('method') || '').trim();
    const err = validateCreditLine(Object.assign({}, c, { status: 'paid', paidDate, method }));
    if (err) { showError(err); return; }
    busyButton(back.querySelector('button[type="submit"]'), 'save', async () => {
      await saveCredit({ id: c.id, updatedAt: c.updatedAt, status: 'paid', paidDate, method });
      showToast('הזיכוי סומן כשולם');
      close();
      renderAll();
    }).catch(err => {
      if (!(err && err.handled)) showError('סימון הזיכוי נכשל — ' + (err && err.message || 'שגיאה'));
    });
  };
}

/* Payout view (גבייה tab): pending credits grouped by payoutDate with a
 * total per date, so the outgoing amount is visible before each 15th. */
function renderCreditsPayouts() {
  if (!billingTabView()) return; // restricted view: no billing UI at all
  renderPayoutForecast();
  const list = document.getElementById('credits-payout-list');
  if (!list) return;
  list.innerHTML = '';
  const groups = pendingCreditsByPayout(state.credits);
  const totalEl = document.getElementById('credits-pending-total');
  const grand = groups.reduce((s, g) => s + g.total, 0);
  if (totalEl) totalEl.textContent = fmtShekel(grand);
  if (!groups.length) {
    const empty = document.createElement('div');
    empty.className = 'card billing-empty';
    empty.textContent = 'אין זיכויים ממתינים לתשלום';
    list.appendChild(empty);
    return;
  }
  groups.forEach(g => {
    const head = document.createElement('div');
    head.className = 'credit-payout-head';
    head.innerHTML = `<span><bdi>${escapeHtml(formatDateHe(g.payoutDate))}</bdi></span><span>${g.credits.length} זיכויים</span><b>${fmtShekel(g.total)}</b><span class="credit-exvat">(${fmtShekel(exVat(g.total))} ללא מע"מ)</span>`;
    list.appendChild(head);
    g.credits.forEach(c => {
      const row = document.createElement('div');
      row.className = 'billing-row credit-payout-row';
      const houseName = (houseById(c.houseId) && houseById(c.houseId).name) || c.houseId || '—';
      const cells = [
        { label: 'שם', value: c.patientName || '—', cls: 'p-name' },
        { label: 'בית', value: houseName },
        { label: 'סוג', value: CREDIT_TYPE_LABELS[c.creditType] || c.creditType },
        { label: 'חודש', value: c.allocationMonth || '—' },
        { label: 'סכום', value: fmtShekel(c.amount) + (c.amount !== c.calculatedAmount ? ' *' : '') },
        { label: 'אושר ע"י', value: c.approvedBy || '—' },
      ];
      cells.forEach(cdef => {
        const cell = document.createElement('div');
        const label = document.createElement('span'); label.className = 'p-label'; label.textContent = cdef.label;
        const val = document.createElement('span'); val.className = cdef.cls || 'p-val'; val.textContent = cdef.value;
        cell.appendChild(label); cell.appendChild(val); row.appendChild(cell);
      });
      if (state.mode === 'edit') {
        const actions = document.createElement('div');
        actions.className = 'irrelevant-actions';
        const paidBtn = document.createElement('button');
        paidBtn.className = 'btn small primary';
        paidBtn.textContent = 'סמן כשולם';
        paidBtn.onclick = () => showMarkCreditPaidModal(c);
        const editBtn = document.createElement('button');
        editBtn.className = 'btn small';
        editBtn.textContent = 'ערוך';
        editBtn.onclick = () => openCreditsForCredit(c);
        actions.appendChild(paidBtn); actions.appendChild(editBtn);
        row.appendChild(actions);
      }
      list.appendChild(row);
    });
  });
}

/* ===== Refund payout forecast (extends the payout view above) =====
 * action=refundPayoutForecast (Code.gs) — READ-ONLY, three sections that are
 * never summed together. See CHANGELOG-refund-payout-forecast.md.
 *   ממתין להחלטה — לא לתשלום   discharges with no saved credit whose server
 *                              suggestion is > 0 (a decision, not a payment);
 *   discharges with no saved credit and no recorded payment for the exit
 *   cycle are DEBT, not refunds: only their count, as one linked line (below).
 * Fetched only while the גבייה screen is shown (and on «רענון»); a credit
 * save marks it stale. Loading and errors are explicit — never a silent
 * empty list. */
/* A discharge with NO recorded payment is DEBT, not a refund (Sandra,
 * 02/10/2026): no section here — one muted line, shown only when the count is
 * > 0, that opens «חובות פתוחים» where those cycles are listed. */
const PAYOUT_FORECAST_MISSING_LINE = 'משוחררים ללא תשלום רשום — מופיעים ב״חובות פתוחים״';
const PAYOUT_FORECAST_SECTION_LABELS = {
  decided:    'הוחלט — ממתין לתשלום',
  awaiting:   'ממתין להחלטה — לא לתשלום',
  unresolved: 'לא ניתן לחשב — לבדוק',
};
const PAYOUT_FORECAST_ERROR_LABELS = {
  unknown_house:     'בית לא מוכר',
  bad_date:          'תאריך כניסה או יציאה חסר / לא תקין',
  exit_before_entry: 'תאריך היציאה לפני תאריך הכניסה',
  bad_amount:        'סכום ששולם לא תקין',
  bad_coverage:      'תקופת כיסוי לא תקינה',
};

function payoutForecastState() {
  if (!state.payoutForecast) state.payoutForecast = { status: 'idle', data: null, error: '' };
  return state.payoutForecast;
}
function markPayoutForecastStale() {
  const f = payoutForecastState();
  if (f.status !== 'loading') f.status = 'idle';
}

async function loadPayoutForecast() {
  if (!billingTabView()) return; // restricted view: no billing UI at all
  const f = payoutForecastState();
  if (f.status === 'loading') return f.promise;
  f.status = 'loading'; f.error = '';
  renderPayoutForecast();
  f.promise = (async () => {
    try {
      const res = await apiPost({ action: 'refundPayoutForecast' });
      if (!res || res.ok !== true || !res.decided || !res.awaiting_decision || !res.missing_payment_data) {
        throw new Error('תשובת שרת לא תקינה');
      }
      f.data = res; f.status = 'ok';
    } catch (e) {
      f.status = 'error';
      f.error = isLockBusyError(e) ? LOCK_BUSY_MESSAGE_HE : String((e && e.message) || 'שגיאה');
      showError('טעינת תחזית ההחזרים נכשלה — ' + f.error);
    }
    renderPayoutForecast();
    return f;
  })();
  return f.promise;
}

function payoutForecastHouseName(houseId) {
  const h = houseById(houseId);
  return (h && h.name) || houseId || '—';
}
function payoutForecastRuleText(rule) {
  return String(rule || '').split(',').filter(Boolean)
    .map(r => CREDIT_RULE_LABELS[r] || CREDIT_TYPE_LABELS[r] || r).join(' + ') || '—';
}
function payoutForecastErrorText(code) {
  return PAYOUT_FORECAST_ERROR_LABELS[code] || String(code || 'שגיאה');
}

/* Pure: the forecast sections as HTML. Every value goes through escapeHtml. */
function payoutForecastHtml(data) {
  const esc = escapeHtml;
  const awaiting = data.awaiting_decision;
  const missingCount = Number(data.missing_payment_data && data.missing_payment_data.count) || 0;
  const unresolved = data.unresolved || { count: 0, rows: [] };
  let html = '';

  html += `<div class="bill-group bill-group--awaiting" data-group="awaiting">`;
  html += `<h4 class="bill-group-title forecast-title forecast-awaiting">${esc(PAYOUT_FORECAST_SECTION_LABELS.awaiting)} <span class="count-pill">${esc(fmtShekel(awaiting.total))}</span></h4>`;
  html += `<p class="billing-date-label">שוחררו מ־${esc(formatDateHe(data.recordsCutoff) || '—')} ואין להם זיכוי שמור. הסכום הוא הצעת המערכת בלבד — לא הוחלט ולא לתשלום. תאריך התשלום הוא אם יוחלט היום.</p>`;
  if (!awaiting.count) {
    html += `<div class="card billing-empty">אין שחרורים הממתינים להחלטה</div>`;
  } else {
    awaiting.byPayoutDate.forEach(g => {
      g.rows.forEach(r => {
        html += `<div class="billing-row forecast-row forecast-awaiting-row">`
          + `<div><span class="p-label">שם</span><span class="p-name">${esc(r.patientName || '—')}</span></div>`
          + `<div><span class="p-label">בית</span><span class="p-val">${esc(payoutForecastHouseName(r.houseId))}</span></div>`
          + `<div><span class="p-label">יציאה</span><span class="p-val"><bdi>${esc(formatDateHe(r.exitDate) || '—')}</bdi></span></div>`
          + `<div><span class="p-label">סכום מוצע</span><span class="p-val">${esc(fmtShekel(r.suggestedAmount))}</span></div>`
          + `<div><span class="p-label">כלל</span><span class="p-val">${esc(payoutForecastRuleText(r.rule))}</span></div>`
          + `<div><span class="p-label">תשלום אם יוחלט היום</span><span class="p-val"><bdi>${esc(formatDateHe(r.payoutDate) || '—')}</bdi></span></div>`
          + `</div>`;
      });
    });
    html += `<div class="forecast-totals">` + awaiting.byHouse.map(h =>
      `<span>${esc(payoutForecastHouseName(h.houseId))}: <b>${esc(fmtShekel(h.total))}</b> (${esc(h.count)})</span>`).join('') + `</div>`;
  }

  html += `</div>`;

  if (missingCount > 0) {
    html += `<p class="forecast-missing-line"><a href="#debt-aging-view" data-open-debt-aging>${esc(missingCount + ' ' + PAYOUT_FORECAST_MISSING_LINE)}</a></p>`;
  }

  if (unresolved.count) {
    html += `<div class="bill-group bill-group--unresolved" data-group="unresolved">`;
    html += `<h4 class="bill-group-title forecast-title forecast-unresolved">${esc(PAYOUT_FORECAST_SECTION_LABELS.unresolved)} <span class="count-pill">${esc(unresolved.count)}</span></h4>`;
    unresolved.rows.forEach(r => {
      html += `<div class="billing-row forecast-row forecast-missing-row">`
        + `<div><span class="p-label">שם</span><span class="p-name">${esc(r.patientName || '—')}</span></div>`
        + `<div><span class="p-label">בית</span><span class="p-val">${esc(payoutForecastHouseName(r.houseId))}</span></div>`
        + `<div><span class="p-label">יציאה</span><span class="p-val"><bdi>${esc(formatDateHe(r.exitDate) || '—')}</bdi></span></div>`
        + `<div><span class="p-label">סיבה</span><span class="p-val forecast-check">${esc(payoutForecastErrorText(r.error))}</span></div>`
        + `</div>`;
    });
    html += `</div>`;
  }
  return html;
}

/* The muted «… מופיעים ב״חובות פתוחים״» line: open that section (its toggle
 * handler loads it) and scroll to it. */
function openDebtAgingSection() {
  const view = document.getElementById('debt-aging-view');
  if (!view) return;
  if (!view.open) view.open = true;
  if (view.scrollIntoView) view.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderPayoutForecast() {
  const box = document.getElementById('credits-forecast');
  if (!box) return;
  const f = payoutForecastState();
  if (f.status === 'idle' && state.currentScreen === 'billing') { loadPayoutForecast(); return; }
  if (f.status === 'loading') {
    box.innerHTML = `<div class="card billing-empty forecast-loading">${escapeHtml('טוען תחזית החזרים…')}</div>`;
    return;
  }
  if (f.status === 'error') {
    box.innerHTML = `<div class="card billing-empty forecast-error">${escapeHtml('טעינת תחזית ההחזרים נכשלה — ' + f.error + '. הרשימות למטה לא נטענו; אין להסיק שהן ריקות.')}</div>`;
    return;
  }
  if (f.status !== 'ok' || !f.data) { box.innerHTML = ''; return; }
  box.innerHTML = payoutForecastHtml(f.data);
}

/* ---- «ייצוא זיכויים לאקסל»: a formatted .xlsx built on the server ---- */

/* The workbook (RTL, Hebrew headers, ₪ and date formats, a bold total per
 * section) is built by lib/xlsx-report.js behind GET PAYOUT_FORECAST_XLSX_URL,
 * which reads refundPayoutForecast itself. The browser only downloads it: no
 * patient data is assembled here, and the service worker never caches /api/. */
const PAYOUT_FORECAST_XLSX_URL = '/api/export/refund-forecast.xlsx';
const PAYOUT_FORECAST_XLSX_ERRORS = {
  lock_busy:            LOCK_BUSY_MESSAGE_HE,
  sheets_unreachable:   'אין חיבור לגיליון הנתונים',
  proxy_not_configured: 'השרת לא מוגדר לגישה לגיליון',
  xlsx_build_failed:    'יצירת הקובץ נכשלה',
  bad_response:         'תשובת שרת לא תקינה',
};

/* Pure: the Hebrew reason for a failed export response. */
function payoutForecastXlsxErrorText(status, code) {
  if (status === 401) return 'נדרשת התחברות מחדש';
  return PAYOUT_FORECAST_XLSX_ERRORS[code] || ('השרת החזיר שגיאה ' + status);
}

async function exportPayoutForecastXlsx() {
  let res;
  try {
    res = await fetch(PAYOUT_FORECAST_XLSX_URL, { method: 'GET', credentials: 'same-origin', cache: 'no-store' });
  } catch (_e) {
    throw new Error('אין חיבור לשרת');
  }
  if (res.status === 401) showPinScreen();
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(payoutForecastXlsxErrorText(res.status, body && body.error));
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `זיכויים-לתשלום-${todayISO()}.xlsx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ---- «ייצוא רשימת תיקונים»: the data-cleanup workbook ---- */

/* Every known gap and inconsistency, one tab per kind, each row with who
 * fixes it, how, and a «טופל» box. Built on the server (lib/cleanup-xlsx.js)
 * from action=cleanupReport behind GET CLEANUP_XLSX_URL, which needs the
 * finance capability (403 otherwise). The browser only downloads it. */
const CLEANUP_XLSX_URL = '/api/export/cleanup.xlsx';

/* Pure: the Hebrew reason for a failed cleanup export. */
function cleanupXlsxErrorText(status, code) {
  if (status === 403) return 'אין הרשאה לייצוא זה';
  return payoutForecastXlsxErrorText(status, code);
}

async function exportCleanupXlsx() {
  if (!billingTabView()) throw new Error('אין הרשאה לייצוא זה');
  let res;
  try {
    res = await fetch(CLEANUP_XLSX_URL, { method: 'GET', credentials: 'same-origin', cache: 'no-store' });
  } catch (_e) {
    throw new Error('אין חיבור לשרת');
  }
  if (res.status === 401) showPinScreen();
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(cleanupXlsxErrorText(res.status, body && body.error));
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `רשימת-תיקונים-${todayISO()}.xlsx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function initPayoutForecastControls() {
  const cleanup = document.getElementById('cleanup-export');
  if (cleanup) cleanup.onclick = () => busyButton(cleanup, 'load', exportCleanupXlsx)
    .catch(e => showError('הייצוא נכשל — ' + ((e && e.message) || 'שגיאה')));
  const exp = document.getElementById('credits-forecast-export');
  if (exp) exp.onclick = () => busyButton(exp, 'load', exportPayoutForecastXlsx)
    .catch(e => showError('הייצוא נכשל — ' + ((e && e.message) || 'שגיאה')));
  const refresh = document.getElementById('credits-forecast-refresh');
  if (refresh) refresh.onclick = () => busyButton(refresh, 'load', () => { markPayoutForecastStale(); return loadPayoutForecast(); });
  const box = document.getElementById('credits-forecast');
  if (box && box.addEventListener) box.addEventListener('click', (e) => {
    const link = e.target && e.target.closest && e.target.closest('[data-open-debt-aging]');
    if (!link) return;
    e.preventDefault();
    openDebtAgingSection();
  });
}

/* ===== «חובות פתוחים» — debt aging as of a date (גבייה tab) =====
 * action=debtAging (Code.gs debtAging_) — READ-ONLY. See
 * CHANGELOG-debt-aging-ui.md. No new math: the server's cycles are only
 * FILTERED (house, patient status) and GROUPED into house × bucket tables.
 *
 * NEVER ADDED TOGETHER:
 *   «חוב רשום»           recorded_debt     — a Payments row exists and is short;
 *   «מחזורים ללא רישום»  unrecorded_cycles — no Payments row («לא שולם או
 *                                           שולם ולא נרשם»).
 * Pending credits sit beside the debt and are never subtracted. The separate
 * lists (detached payments, payments after exit, discharged without an exit
 * date, zero-amount patients) are never part of either figure.
 *
 * The view (debtAgingView) and the labels below are the browser copy of
 * lib/debt-aging-xlsx.js; test/debt-aging-ui.test.js fails if they drift.
 * Fetched only when the section is opened or the as-of date changes — never on
 * a tab switch. Loading and errors are explicit, never a silent empty view. */
const DEBT_AGING_BUCKETS = [
  { key: 'd0_7',     label: '0–7' },
  { key: 'd8_30',    label: '8–30' },
  { key: 'd31_60',   label: '31–60' },
  { key: 'd61_plus', label: '61+' },
];
const DEBT_AGING_BLOCK_LABELS = {
  recorded_debt:     'חוב רשום',
  unrecorded_cycles: 'מחזורים ללא רישום',
};
const DEBT_AGING_UNRECORDED_NOTE = 'לא שולם או שולם ולא נרשם';
const DEBT_AGING_CREDITS_LABEL = 'זיכויים ממתינים — לא מקוזזים מהחוב';
const DEBT_AGING_STATUS_LABELS = { all: 'כל המטופלים', active: 'פעילים', discharged: 'משוחררים' };
const DEBT_AGING_PATIENT_STATUS_LABELS = { active: 'פעיל', discharged: 'משוחרר' };
const DEBT_AGING_KIND_LABELS = { recorded: 'חוב רשום', unrecorded: 'ללא רישום' };
const DEBT_AGING_DETACHED_REASON_LABELS = { not_a_patient: 'סומן: לא כסף של מטופל', unmatched: 'לא נמצא מטופל תואם' };
const DEBT_AGING_LIST_LABELS = {
  detached:       'תשלומים לא משויכים',
  outsideStay:    'תשלומים אחרי יציאה',
  releasedNoExit: 'משוחררים ללא תאריך יציאה',
  zeroAmount:     'מטופלים בסכום אפס',
  noEntryDate:    'ללא תאריך כניסה',
};
const DEBT_AGING_XLSX_URL = '/api/export/debt-aging.xlsx';
const DEBT_AGING_XLSX_ERRORS = Object.assign({}, PAYOUT_FORECAST_XLSX_ERRORS, {
  bad_asOf:   'תאריך לא תקין',
  bad_house:  'בית לא תקין',
  bad_status: 'סטטוס לא תקין',
});

/* Today in Asia/Jerusalem, 'YYYY-MM-DD' — whatever the device's clock zone. */
function debtAgingTodayIso(now) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(now || new Date());
}
/* The last day of the month before todayIso's month. Pure. */
function debtAgingPrevMonthEnd(todayIso) {
  const y = Number(todayIso.slice(0, 4)), m = Number(todayIso.slice(5, 7));
  return new Date(Date.UTC(y, m - 1, 0)).toISOString().slice(0, 10);
}
/* A bare 'YYYY-MM-DD' naming a real calendar day. Pure. */
function debtAgingIsRealDay(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(Date.UTC(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10))));
  return d.toISOString().slice(0, 10) === s;
}
function debtAgingStatusGroup(status) { return status === 'released' ? 'discharged' : 'active'; }
function debtAgingBucketLabel(key) {
  const b = DEBT_AGING_BUCKETS.find(x => x.key === key);
  return b ? b.label : String(key || '—');
}
function debtAgingHouseName(houseId) {
  if (!houseId) return 'סה"כ';
  const h = houseById(houseId);
  return (h && h.name) || houseId;
}

/* The filtered view of one debtAging response — the browser copy of
 * lib/debt-aging-xlsx.js debtAgingView. Pure. */
function debtAgingView(data, filters) {
  const f = filters || {};
  const house = f.house || 'all', status = f.status || 'all';
  const arr = v => (Array.isArray(v) ? v : []);
  const rowsOf = o => arr(o && o.rows);
  const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
  const houseOk = h => house === 'all' || h === house;
  const statusOk = s => status === 'all' || debtAgingStatusGroup(s) === status;
  const order = HOUSES.map(h => h.id);

  const seen = [];
  arr(data.byPatient).forEach(p => seen.push(p.houseId));
  arr(data.byHouse).forEach(h => seen.push(h.houseId));
  arr(data.pendingCredits && data.pendingCredits.byHouse).forEach(h => seen.push(h.houseId));
  const extra = seen.filter((h, i) => h && order.indexOf(h) < 0 && seen.indexOf(h) === i).sort();
  const houseIds = house === 'all' ? order.concat(extra) : [house];

  const emptyRow = houseId => {
    const o = { houseId, house: debtAgingHouseName(houseId), total: 0 };
    DEBT_AGING_BUCKETS.forEach(b => { o[b.key] = 0; });
    return o;
  };
  const table = () => ({ rows: houseIds.map(emptyRow), totals: emptyRow('') });
  const tables = { recorded_debt: table(), unrecorded_cycles: table() };
  const addTo = (t, houseId, bucket, amount) => {
    let row = t.rows.find(r => r.houseId === houseId);
    if (!row) { row = emptyRow(houseId); t.rows.push(row); }
    if (!(bucket in row)) return;
    row[bucket] = r2(row[bucket] + amount); row.total = r2(row.total + amount);
    t.totals[bucket] = r2(t.totals[bucket] + amount); t.totals.total = r2(t.totals.total + amount);
  };

  const patients = [];
  const zeroAmount = [];
  arr(data.byPatient).forEach(p => {
    if (!houseOk(p.houseId) || !statusOk(p.status)) return;
    const owed = arr(p.cycles).filter(c => Number(c.balance) > 0);
    const base = { patientId: p.patientId, name: p.name, houseId: p.houseId, status: p.status,
      statusGroup: debtAgingStatusGroup(p.status), entryDate: p.entryDate || '', exitDate: p.exitDate || '' };
    if (!owed.length) { zeroAmount.push(Object.assign(base, { cycles: arr(p.cycles).length })); return; }
    let recorded = 0, unrecorded = 0, oldest = -1;
    owed.forEach(c => {
      const bal = Number(c.balance) || 0;
      if (c.kind === 'recorded') { recorded = r2(recorded + bal); addTo(tables.recorded_debt, p.houseId, c.bucket, bal); }
      else { unrecorded = r2(unrecorded + bal); addTo(tables.unrecorded_cycles, p.houseId, c.bucket, bal); }
      oldest = Math.max(oldest, DEBT_AGING_BUCKETS.findIndex(b => b.key === c.bucket));
    });
    patients.push(Object.assign(base, {
      recordedBalance: recorded, unrecordedTotal: unrecorded,
      oldestBucket: oldest >= 0 ? DEBT_AGING_BUCKETS[oldest].key : '',
      cycles: owed.slice().sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0)),
    }));
  });
  const orderOf = h => { const i = houseIds.indexOf(h); return i < 0 ? houseIds.length : i; };
  patients.sort((a, b) => (orderOf(a.houseId) - orderOf(b.houseId)) || String(a.name).localeCompare(String(b.name), 'he'));

  const creditRows = arr(data.pendingCredits && data.pendingCredits.byHouse)
    .filter(h => houseOk(h.houseId))
    .map(h => ({ houseId: h.houseId, house: debtAgingHouseName(h.houseId), count: Number(h.count) || 0, total: r2(h.total) }))
    .sort((a, b) => orderOf(a.houseId) - orderOf(b.houseId));
  const credits = {
    rows: creditRows,
    count: creditRows.reduce((s, r) => s + r.count, 0),
    total: r2(creditRows.reduce((s, r) => s + r.total, 0)),
  };

  const detachedRows = rowsOf(data.detachedPayments).filter(r => houseOk(r.houseId));
  const outsideRows = rowsOf(data.outsideStay).filter(r => houseOk(r.houseId) && statusOk(r.status));
  const noExitRows = rowsOf(data.releasedWithoutExit).filter(r => houseOk(r.houseId) && (status === 'all' || status === 'discharged'));
  const noEntryRows = rowsOf(data.noEntryDate).filter(r => houseOk(r.houseId) && statusOk(r.status));
  const lists = {
    detached: {
      rows: detachedRows, count: detachedRows.length,
      total: r2(detachedRows.reduce((s, r) => s + (Number(r.amount) || 0), 0)),
      receivedByAsOf: r2(detachedRows.reduce((s, r) => s + (Number(r.receivedByAsOf) || 0), 0)),
    },
    outsideStay: { rows: outsideRows, count: outsideRows.length },
    releasedNoExit: { rows: noExitRows, count: noExitRows.length },
    zeroAmount: { rows: zeroAmount, count: zeroAmount.length, total: 0 },
    noEntryDate: { rows: noEntryRows, count: noEntryRows.length },
  };

  return { asOf: data.asOf, house, status, houseIds, tables, patients, credits, lists };
}

/* «ממתין לגורם מממן · עד DD/MM/YYYY» for a cycle the server flagged
 * funderGrace (Code.gs debtAging_); a cycle with money received and a
 * balance left is partly paid: «שולם חלקית · ממתין לגורם מממן · עד …». Pure. */
function debtAgingGraceText(c) {
  const until = c && c.funderGraceUntil ? formatDateHe(c.funderGraceUntil) : '';
  const partial = c && Number(c.received) > 0 && Number(c.balance) > 0;
  return funderGraceStatusLabel(partial ? 'partial' : 'unpaid') + (until ? ' · עד ' + until : '');
}
/* The one line under the two blocks: how many owed cycles are inside an
 * institutional funder's grace window — still INCLUDED in both blocks. '' at
 * zero. Pure. */
function debtAgingGraceLine(data) {
  const g = data && data.funderGrace;
  const n = Number(g && g.count) || 0;
  if (!n) return '';
  return `${n} מחזורים (${fmtShekel(g.amount)}) ${FUNDER_GRACE_COLUMN_LABEL} — נכללים בחוב, לא מסומנים כבעיה`;
}

/* The caveats to show — only the relevant ones. Pure. */
function debtAgingCaveats(data, todayIso) {
  const out = [];
  const unknown = Number(data && data.receivedDateUnknown && data.receivedDateUnknown.count) || 0;
  if (unknown > 0) out.push(`${unknown} תשלומים ללא תאריך קבלה — הוערכו לפי תחילת המחזור`);
  if (data && typeof data.asOf === 'string' && typeof todayIso === 'string' && data.asOf < todayIso) {
    out.push('בתאריך עבר, תשלום שהושלם מאוחר יותר עלול להופיע כחוב');
  }
  return out;
}

/* Pure: one block's house × bucket table. Every value goes through escapeHtml. */
function debtAgingBlockHtml(key, table, sub) {
  const esc = escapeHtml;
  const cls = key === 'recorded_debt' ? 'debt-block-recorded' : 'debt-block-unrecorded';
  const cells = r => DEBT_AGING_BUCKETS.map(b => `<td data-bucket="${esc(b.key)}">${esc(fmtShekel(r[b.key]))}</td>`).join('')
    + `<td class="debt-row-total">${esc(fmtShekel(r.total))}</td>`;
  return `<div class="debt-block ${cls}" data-block="${esc(key)}">`
    + `<h4 class="debt-block-title">${esc(DEBT_AGING_BLOCK_LABELS[key])} <span class="count-pill debt-block-total">${esc(fmtShekel(table.totals.total))}</span></h4>`
    + `<p class="billing-date-label">${esc(sub)}</p>`
    + `<div class="debt-table-wrap"><table class="debt-table"><thead><tr><th>בית</th>`
    + DEBT_AGING_BUCKETS.map(b => `<th><span dir="ltr">${esc(b.label)}</span> ימים</th>`).join('') + `<th>סה"כ</th></tr></thead><tbody>`
    + table.rows.map(r => `<tr data-house="${esc(r.houseId)}"><th>${esc(r.house)}</th>${cells(r)}</tr>`).join('')
    + `</tbody><tfoot><tr class="debt-col-totals"><th>סה"כ ${esc(DEBT_AGING_BLOCK_LABELS[key])}</th>${cells(table.totals)}</tr></tfoot></table></div>`
    + `</div>`;
}

/* Pure: a collapsible separate list with its own count (and total, when the
 * report carries an amount). Never part of the debt figures. */
function debtAgingListHtml(id, list, rowHtml, totalText) {
  const esc = escapeHtml;
  return `<details class="debt-list" data-list="${esc(id)}"><summary>${esc(DEBT_AGING_LIST_LABELS[id])} `
    + `<span class="count-pill">${esc(list.count)}</span>`
    + (totalText ? ` <span class="count-pill">${esc(totalText)}</span>` : '')
    + `</summary>`
    + (list.count ? list.rows.map(rowHtml).join('') : `<div class="card billing-empty">אין</div>`)
    + `</details>`;
}

/* Pure: the whole view as HTML. Every value goes through escapeHtml. */
function debtAgingHtml(data, filters, todayIso) {
  const esc = escapeHtml;
  const v = debtAgingView(data, filters);
  let html = '';

  const caveats = debtAgingCaveats(data, todayIso);
  if (caveats.length) {
    html += `<div class="debt-caveats">` + caveats.map(c => `<p class="debt-caveat">${esc(c)}</p>`).join('') + `</div>`;
  }
  html += `<p class="billing-date-label">נכון לסוף יום <bdi>${esc(formatDateHe(v.asOf) || '—')}</bdi> · כולל מע"מ · שני הגושים אינם מסתכמים יחד</p>`;
  html += `<div class="debt-blocks">`
    + debtAgingBlockHtml('recorded_debt', v.tables.recorded_debt, 'שורות תשלום שלא שולמו או שולמו חלקית')
    + debtAgingBlockHtml('unrecorded_cycles', v.tables.unrecorded_cycles, DEBT_AGING_UNRECORDED_NOTE)
    + `</div>`;
  const graceLine = debtAgingGraceLine(data);
  if (graceLine) html += `<p class="debt-grace-line">${esc(graceLine)}</p>`;

  html += `<div class="debt-credits"><span class="debt-credits-label">${esc(DEBT_AGING_CREDITS_LABEL)}:</span> `
    + (v.credits.rows.length
      ? v.credits.rows.map(r => `<span data-house="${esc(r.houseId)}">${esc(r.house)}: <b>${esc(fmtShekel(r.total))}</b> (${esc(r.count)})</span>`).join(' ')
      : `<span>אין</span>`)
    + `</div>`;

  // Drill-down: house → patients → cycles.
  html += `<h4 class="debt-drill-title">פירוט לפי בית</h4>`;
  if (!v.patients.length) {
    html += `<div class="card billing-empty debt-none">אין חוב פתוח בסינון זה</div>`;
  } else {
    v.houseIds.forEach(h => {
      const ps = v.patients.filter(p => p.houseId === h);
      if (!ps.length) return;
      const rec = v.tables.recorded_debt.rows.find(r => r.houseId === h);
      const unr = v.tables.unrecorded_cycles.rows.find(r => r.houseId === h);
      html += `<details class="debt-house" data-house="${esc(h)}"><summary>${esc(debtAgingHouseName(h))} · ${esc(ps.length)} מטופלים`
        + ` · ${esc(DEBT_AGING_BLOCK_LABELS.recorded_debt)} ${esc(fmtShekel(rec ? rec.total : 0))}`
        + ` · ${esc(DEBT_AGING_BLOCK_LABELS.unrecorded_cycles)} ${esc(fmtShekel(unr ? unr.total : 0))}</summary>`;
      ps.forEach(p => {
        html += `<details class="debt-patient" data-patient="${esc(p.patientId)}"><summary class="billing-row debt-patient-row">`
          + `<div><span class="p-label">שם</span><span class="p-name">${esc(p.name || '—')}</span></div>`
          + `<div><span class="p-label">סטטוס</span><span class="p-val">${esc(DEBT_AGING_PATIENT_STATUS_LABELS[p.statusGroup])}</span></div>`
          + `<div><span class="p-label">${esc(DEBT_AGING_BLOCK_LABELS.recorded_debt)}</span><span class="p-val">${esc(fmtShekel(p.recordedBalance))}</span></div>`
          + `<div><span class="p-label">ללא רישום</span><span class="p-val">${esc(fmtShekel(p.unrecordedTotal))}</span></div>`
          + `<div><span class="p-label">הוותיק ביותר</span><span class="p-val"><span dir="ltr">${esc(debtAgingBucketLabel(p.oldestBucket))}</span> ימים</span></div>`
          + `</summary><div class="debt-table-wrap"><table class="debt-table debt-cycles"><thead><tr>`
          + `<th>תחילה</th><th>סוף</th><th>צפוי</th><th>התקבל</th><th>יתרה</th><th>תקופת חוב (ימים)</th><th>סוג</th><th>${esc(FUNDER_GRACE_COLUMN_LABEL)}</th></tr></thead><tbody>`
          + p.cycles.map(c => `<tr class="debt-cycle${c.funderGrace ? ' funder-grace' : ''}" data-kind="${esc(c.kind)}"><td><bdi>${esc(formatDateHe(c.start) || '—')}</bdi></td><td><bdi>${esc(formatDateHe(c.end) || '—')}</bdi></td>`
            + `<td>${esc(fmtShekel(c.expected))}</td><td>${esc(fmtShekel(c.received))}</td><td>${esc(fmtShekel(c.balance))}</td>`
            + `<td><span dir="ltr">${esc(debtAgingBucketLabel(c.bucket))}</span></td><td>${esc(DEBT_AGING_KIND_LABELS[c.kind] || c.kind)}</td>`
            + `<td>${c.funderGrace ? `<span class="badge pay-state pay-state-funder_grace">${esc(debtAgingGraceText(c))}</span>` : '—'}</td></tr>`).join('')
          + `</tbody></table></div></details>`;
      });
      html += `</details>`;
    });
  }

  // Separate lists — each with its own count/total, never in the debt figures.
  const L = v.lists;
  html += `<h4 class="debt-drill-title">לבדיקה — לא נכלל בחוב</h4>`;
  html += debtAgingListHtml('detached', L.detached, r => `<div class="billing-row debt-list-row">`
    + `<div><span class="p-label">שם</span><span class="p-name">${esc(r.patientName || '—')}</span></div>`
    + `<div><span class="p-label">בית</span><span class="p-val">${esc(debtAgingHouseName(r.houseId))}</span></div>`
    + `<div><span class="p-label">תאריך לתשלום</span><span class="p-val"><bdi>${esc(formatDateHe(r.dueDate) || '—')}</bdi></span></div>`
    + `<div><span class="p-label">סכום</span><span class="p-val">${esc(fmtShekel(r.amount))}</span></div>`
    + `<div><span class="p-label">סיבה</span><span class="p-val">${esc(DEBT_AGING_DETACHED_REASON_LABELS[r.reason] || r.reason || '—')}</span></div>`
    + `</div>`, fmtShekel(L.detached.total));
  html += debtAgingListHtml('outsideStay', L.outsideStay, r => `<div class="billing-row debt-list-row">`
    + `<div><span class="p-label">שם</span><span class="p-name">${esc(r.name || '—')}</span></div>`
    + `<div><span class="p-label">בית</span><span class="p-val">${esc(debtAgingHouseName(r.houseId))}</span></div>`
    + `<div><span class="p-label">תחילת מחזור</span><span class="p-val"><bdi>${esc(formatDateHe(r.start) || '—')}</bdi></span></div>`
    + `<div><span class="p-label">יציאה</span><span class="p-val"><bdi>${esc(formatDateHe(r.exitDate) || '—')}</bdi></span></div>`
    + `</div>`, '');
  html += debtAgingListHtml('releasedNoExit', L.releasedNoExit, r => `<div class="billing-row debt-list-row">`
    + `<div><span class="p-label">שם</span><span class="p-name">${esc(r.name || '—')}</span></div>`
    + `<div><span class="p-label">בית</span><span class="p-val">${esc(debtAgingHouseName(r.houseId))}</span></div>`
    + `<div><span class="p-label">כניסה</span><span class="p-val"><bdi>${esc(formatDateHe(r.entryDate) || '—')}</bdi></span></div>`
    + `</div>`, '');
  html += debtAgingListHtml('zeroAmount', L.zeroAmount, r => `<div class="billing-row debt-list-row">`
    + `<div><span class="p-label">שם</span><span class="p-name">${esc(r.name || '—')}</span></div>`
    + `<div><span class="p-label">בית</span><span class="p-val">${esc(debtAgingHouseName(r.houseId))}</span></div>`
    + `<div><span class="p-label">כניסה</span><span class="p-val"><bdi>${esc(formatDateHe(r.entryDate) || '—')}</bdi></span></div>`
    + `</div>`, fmtShekel(0));
  if (L.noEntryDate.count) {
    html += debtAgingListHtml('noEntryDate', L.noEntryDate, r => `<div class="billing-row debt-list-row">`
      + `<div><span class="p-label">שם</span><span class="p-name">${esc(r.name || '—')}</span></div>`
      + `<div><span class="p-label">בית</span><span class="p-val">${esc(debtAgingHouseName(r.houseId))}</span></div>`
      + `</div>`, '');
  }
  return html;
}

function debtAgingState() {
  if (!state.debtAging) state.debtAging = { status: 'idle', asOf: '', house: 'all', statusFilter: 'all', data: null, error: '', seq: 0 };
  return state.debtAging;
}

/* Fetch debtAging for the current as-of date. A response for an older date
 * (the picker moved while it was in flight) is dropped. */
async function loadDebtAging() {
  const s = debtAgingState();
  if (!s.asOf) s.asOf = debtAgingTodayIso();
  if (!debtAgingIsRealDay(s.asOf)) {
    s.status = 'error'; s.error = 'תאריך לא תקין';
    renderDebtAging();
    return s;
  }
  const seq = ++s.seq;
  const asOf = s.asOf;
  s.status = 'loading'; s.error = '';
  renderDebtAging();
  try {
    const res = await apiPost({ action: 'debtAging', asOf });
    if (seq !== s.seq) return s;
    if (!res || res.ok !== true || res.asOf !== asOf || !res.totals || !Array.isArray(res.byPatient)) {
      throw new Error('תשובת שרת לא תקינה');
    }
    s.data = res; s.status = 'ok';
  } catch (e) {
    if (seq !== s.seq) return s;
    s.status = 'error'; s.data = null;
    s.error = isLockBusyError(e) ? LOCK_BUSY_MESSAGE_HE : String((e && e.message) || 'שגיאה');
    showError('טעינת החובות הפתוחים נכשלה — ' + s.error);
  }
  renderDebtAging();
  return s;
}

function renderDebtAging() {
  const box = document.getElementById('debt-aging');
  if (!box) return;
  const s = debtAgingState();
  if (s.status === 'loading') {
    box.innerHTML = `<div class="card billing-empty debt-loading">${escapeHtml('טוען חובות פתוחים…')}</div>`;
    return;
  }
  if (s.status === 'error') {
    box.innerHTML = `<div class="card billing-empty forecast-error debt-error">${escapeHtml('טעינת החובות הפתוחים נכשלה — ' + s.error + '. הנתונים לא נטענו; אין להסיק שאין חוב.')}</div>`;
    return;
  }
  if (s.status !== 'ok' || !s.data) {
    box.innerHTML = `<div class="card billing-empty">${escapeHtml('פתחו את הסעיף כדי לטעון')}</div>`;
    return;
  }
  const filters = { house: s.house, status: s.statusFilter };
  if (!funderView()) {
    box.innerHTML = debtAgingHtml(s.data, filters, debtAgingTodayIso());
    renderFunderFill();
    return;
  }
  // Funder view: the strip splits the SAME report (house/status filters, all
  // funders); the blocks and drill-down below follow the funder filter.
  const strip = debtFunderStripHtml(debtFunderStrip(s.data, state.funders, filters));
  const shown = filterDebtReportByFunder(s.data, state.funders, billingFunderFilter());
  box.innerHTML = strip + debtAgingHtml(shown, filters, debtAgingTodayIso());
  // The fill screen counts released patients by the debt this report shows.
  renderFunderFill();
}

/* Pure: the export URL for the current controls. */
function debtAgingExportUrl(asOf, house, status) {
  const qs = new URLSearchParams({ asOf: String(asOf || ''), house: String(house || 'all'), status: String(status || 'all') });
  return DEBT_AGING_XLSX_URL + '?' + qs.toString();
}

async function exportDebtAgingXlsx() {
  const s = debtAgingState();
  if (!s.asOf) s.asOf = debtAgingTodayIso();
  if (!debtAgingIsRealDay(s.asOf)) throw new Error('תאריך לא תקין');
  let res;
  try {
    res = await fetch(debtAgingExportUrl(s.asOf, s.house, s.statusFilter), { method: 'GET', credentials: 'same-origin', cache: 'no-store' });
  } catch (_e) {
    throw new Error('אין חיבור לשרת');
  }
  if (res.status === 401) showPinScreen();
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const code = body && body.error;
    throw new Error(res.status === 401 ? 'נדרשת התחברות מחדש' : (DEBT_AGING_XLSX_ERRORS[code] || ('השרת החזיר שגיאה ' + res.status)));
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `חובות-${s.asOf}.xlsx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function initDebtAgingControls() {
  const s = debtAgingState();
  const view = document.getElementById('debt-aging-view');
  const asOfEl = document.getElementById('debt-asof');
  const houseEl = document.getElementById('debt-house');
  const statusEl = document.getElementById('debt-status');
  if (!view || !asOfEl) return;
  if (!s.asOf) s.asOf = debtAgingTodayIso();
  asOfEl.value = s.asOf;
  if (houseEl) {
    houseEl.innerHTML = `<option value="all">כל הבתים</option>`
      + HOUSES.map(h => `<option value="${escapeHtml(h.id)}">${escapeHtml(h.name)}</option>`).join('');
    houseEl.value = s.house;
    houseEl.onchange = () => { s.house = houseEl.value || 'all'; renderDebtAging(); };
  }
  if (statusEl) {
    statusEl.innerHTML = Object.keys(DEBT_AGING_STATUS_LABELS)
      .map(k => `<option value="${escapeHtml(k)}">${escapeHtml(DEBT_AGING_STATUS_LABELS[k])}</option>`).join('');
    statusEl.value = s.statusFilter;
    statusEl.onchange = () => { s.statusFilter = statusEl.value || 'all'; renderDebtAging(); };
  }
  const setAsOf = (iso) => {
    s.asOf = iso; asOfEl.value = iso;
    if (view.open) loadDebtAging();
  };
  asOfEl.onchange = () => setAsOf(String(asOfEl.value || '') || debtAgingTodayIso());   // cleared → today
  const prev = document.getElementById('debt-asof-prev-month');
  if (prev) prev.onclick = () => setAsOf(debtAgingPrevMonthEnd(debtAgingTodayIso()));
  view.addEventListener('toggle', () => { if (view.open) loadDebtAging(); });
  const refresh = document.getElementById('debt-refresh');
  if (refresh) refresh.onclick = () => busyButton(refresh, 'load', loadDebtAging);
  const exp = document.getElementById('debt-export');
  if (exp) exp.onclick = () => busyButton(exp, 'load', exportDebtAgingXlsx)
    .catch(e => showError('הייצוא נכשל — ' + ((e && e.message) || 'שגיאה')));
  renderDebtAging();
}

/* ===== Patient funder (גורם מממן) on the Funders sheet =====
 * CHANGELOG-patient-funder-on-funders.md. The source of truth is the existing
 * append-only Funders sheet (#173/#176): state.funders comes from getPayments,
 * every write is action=appendFunder (saveFunder), and the card's funder field
 * and editor are #176's (patientFunderCellHtml / openFunderModal). This block
 * adds, for the FINANCE VIEW ONLY:
 *   - the funder REQUIRED at admission (direct add + admit-from-lead);
 *   - «השלמת גורם מממן — X נותרו» on גבייה;
 *   - the funder filter on the billing lists and «חובות פתוחים»;
 *   - the funder × house strip (Funder.debtByFunder over the SAME debtAging
 *     report and as-of the view uses; the two figures are never summed).
 * There is NO default funder: no row → «לא הוגדר». A restricted session
 * (Shiran, Yael) gets none of it and never sends appendFunder.
 * public/funder.js (global Funder) maps the stored labels to stable keys. */
const FUNDER_UNSET_KEY = 'unset';
const FUNDER_UNSET_LABEL = 'לא הוגדר';
/* Pro-bono (CHANGELOG-funder-probono.md): the fifth funder. A patient whose
 * funder on a cycle's day is pro-bono owes nothing for it — the server drops
 * those cycles from «חובות פתוחים»; here the due list, «יתרות פתוחות» and the
 * renewal / overdue alerts skip them (isProbonoOn). The strip keeps its ₪0 row. */
const FUNDER_PROBONO_KEY = 'probono';
const FUNDER_FILTER_ALL = 'all';
const FUNDER_REQUIRED_MESSAGE = 'יש לבחור גורם מממן';
const FUNDER_RELEASED_DEBT_TAG = 'שוחרר/ה · יתרה פתוחה';

/* The funder module, or null when funder.js did not load. */
function funderLib() {
  return (typeof Funder !== 'undefined' && Funder && typeof Funder.funderAt === 'function') ? Funder : null;
}

/* True only for a session KNOWN to have `finance` (Sandra, Vered), with
 * funder.js loaded. Unknown (before /api/me) or restricted → false. */
function funderView() {
  return state.finance === true && !!funderLib();
}

/* The day a patient's funder is read on: today, or the exit day of a
 * patient who already left. Pure. */
function patientFunderDay(p, today) {
  const t = today || todayISO();
  const exit = p ? isoDate(p.exitDate) : '';
  return exit && exit < t ? exit : t;
}

/* The funder KEY of a patient on `day` (default: patientFunderDay), or 'unset'. Pure. */
function patientFunderKey(p, funders, today, day) {
  const F = funderLib();
  if (!F || !p) return FUNDER_UNSET_KEY;
  return F.funderAt(Array.isArray(funders) ? funders : state.funders, patientUid(p), day || patientFunderDay(p, today));
}

/* The admission rule: a finance session must pick one of the four labels; a
 * restricted (or unknown) session never sees the field and is never blocked.
 * '' = OK. Pure. */
function admissionFunderError(finance, value) {
  if (finance !== true || !funderLib()) return '';
  return paymentFunderLabels().indexOf(value) >= 0 ? '' : FUNDER_REQUIRED_MESSAGE;
}

/* The select options for a funder field: the stored labels as values (the
 * Funders sheet keeps labels), escaped for showModal, led by «— בחרו —». */
function funderSelectOptions() {
  return [{ value: '', label: '— בחרו —' }].concat(paymentFunderLabels().map(f => ({ value: escapeHtml(f), label: escapeHtml(f) })));
}

/* The funder field an admission modal adds (none outside the finance view). */
function admissionFunderFields() {
  if (!funderView()) return [];
  return [{ name: 'funder', label: 'גורם מממן', type: 'select', required: true, value: '', options: funderSelectOptions() }];
}

/* The effectiveFrom recorded at admission / offered on the fill screen: the
 * entry date. appendFunder_ accepts any real date (no future limit today);
 * an unreadable entry date falls back to today. Pure. */
function funderEffectiveFromEntry(entryIso, today) {
  return isoDate(entryIso) || today || todayISO();
}

/* After an admission saved: append the picked funder from the entry date. A
 * failure keeps the patient (already saved) and says so in Hebrew; the
 * patient then shows «לא הוגדר» and waits on the fill screen. */
async function saveAdmissionFunder(patient, picked) {
  if (!funderView() || !patient || paymentFunderLabels().indexOf(picked) < 0) return;
  try {
    await saveFunder(patient, picked, funderEffectiveFromEntry(patient.date));
  } catch (e) {
    showError('המטופל נשמר, אך שמירת הגורם המממן נכשלה — ' + (isLockBusyError(e) ? LOCK_BUSY_MESSAGE_HE : ((e && e.message) || 'שגיאה')));
  }
}

/* Patient ids with an OPEN balance: owed cycles in the loaded debtAging
 * report, or an unpaid / partial past-due row in «יתרות פתוחות». Read from
 * what the page already holds — no new endpoint. Pure. */
function openDebtPatientIds(report, payments, patients, today) {
  const ids = {};
  ((report && Array.isArray(report.byPatient)) ? report.byPatient : []).forEach(p => {
    if (p && p.patientId && (Array.isArray(p.cycles) ? p.cycles : []).some(c => Number(c && c.balance) > 0)) ids[String(p.patientId)] = true;
  });
  const t = today || todayISO();
  (Array.isArray(payments) ? payments : []).forEach(pay => {
    if (!pay || isVoidPayment(pay) || (pay.status !== 'unpaid' && pay.status !== 'partial') || !pay.dueDate || pay.dueDate >= t) return;
    const hit = findPatientForPaymentIn(patients, pay);
    const uid = patientUid(hit) || paymentPatientUid(pay);
    if (uid) ids[uid] = true;
  });
  return ids;
}

/* «השלמת גורם מממן»: every patient with an id whose funder today is unset —
 * not released, or released WITH open debt (tagged «שוחרר/ה · יתרה פתוחה»).
 * By house, then name; default effectiveFrom = the entry date, so the debt
 * already accrued is attributed too. Pure. */
function funderFillRows(patients, funders, today, debtIds) {
  const F = funderLib();
  if (!F) return [];
  const t = today || todayISO();
  const owes = debtIds || {};
  const order = HOUSES.map(h => h.id);
  const rank = h => { const i = order.indexOf(h); return i < 0 ? order.length : i; };
  return (Array.isArray(patients) ? patients : [])
    .filter(p => p && patientUid(p) && F.funderAt(funders, patientUid(p), t) === FUNDER_UNSET_KEY)
    .filter(p => p.status !== 'released' || owes[patientUid(p)] === true)
    .sort((a, b) => (rank(a.houseId) - rank(b.houseId)) || String(a.name || '').localeCompare(String(b.name || ''), 'he'))
    .map(p => ({ patient: p, released: p.status === 'released', defaultFrom: funderEffectiveFromEntry(p.date, t) }));
}

/* Pure: the fill screen's HTML ('' when nothing is left). */
function funderFillHtml(rows) {
  if (!rows.length) return '';
  const esc = escapeHtml;
  const opts = funderSelectOptions().map(o => `<option value="${o.value}">${o.label}</option>`).join('');
  return `<h3 class="funder-fill-title">השלמת גורם מממן — <span class="count-pill" data-funder-fill-count>${esc(rows.length)}</span> נותרו</h3>`
    + `<p class="billing-date-label">ברירת המחדל של «בתוקף מתאריך» היא תאריך הכניסה, כך שגם חוב קודם משויך לגורם הנכון.</p>`
    + rows.map(({ patient: p, released, defaultFrom }) => `<div class="billing-row funder-fill-row" data-patient="${esc(patientUid(p))}">`
      + `<div><span class="p-label">שם</span><span class="p-name">${esc(p.name || '—')}</span>`
      + (released ? ` <span class="funder-chip funder-unset funder-released-tag">${esc(FUNDER_RELEASED_DEBT_TAG)}</span>` : '') + `</div>`
      + `<div><span class="p-label">בית</span><span class="p-val">${esc(houseLabel(p.houseId))}</span></div>`
      + `<div><span class="p-label">כניסה</span><span class="p-val"><bdi>${esc(formatDateHe(p.date) || '—')}</bdi></span></div>`
      + `<label class="funder-field"><span class="p-label">גורם מממן</span><select data-fill-funder aria-label="גורם מממן">${opts}</select></label>`
      + `<label class="funder-field"><span class="p-label">בתוקף מתאריך</span><input type="date" data-fill-from value="${esc(defaultFrom)}" /></label>`
      + `<button type="button" class="btn small primary" data-fill-save>שמירה</button>`
      + `</div>`).join('');
}

function renderFunderFill() {
  const box = document.getElementById('funder-fill');
  if (!box) return;
  let rows = [];
  if (funderView()) {
    const today = todayISO();
    const aging = state.debtAging && state.debtAging.status === 'ok' ? state.debtAging.data : null;
    rows = funderFillRows(state.patients, state.funders, today, openDebtPatientIds(aging, state.payments, state.patients, today));
  }
  box.innerHTML = funderFillHtml(rows);
  box.classList.toggle('hidden', rows.length === 0);
}

/* Whether a funder key passes the גבייה filter ('all' | key | 'unset'). Pure. */
function funderFilterMatch(filter, key) {
  return !filter || filter === FUNDER_FILTER_ALL || filter === key;
}

/* Is `label` the pro-bono funder label (funder.js's map; no literal here)? Pure. */
function isProbonoLabel(label) {
  const F = funderLib();
  return !!F && F.keyFromLabel(label) === FUNDER_PROBONO_KEY;
}

/* True when `patient` is pro-bono on `dayISO` — finance view only (a
 * restricted session holds no funders and sees no billing). Such a row is
 * not owed, so the due list, «יתרות פתוחות» and the alerts skip it. */
function isProbonoOn(patient, dayISO) {
  // Ortal's read-only «גבייה» (billingReadView) must leave pro-bono cycles
  // out exactly like Vered's — the funder data rides getPayments for her too.
  if (!(funderView() || (billingReadView() && !!funderLib())) || !patient) return false;
  return patientFunderKey(patient, state.funders, todayISO(), isoDate(dayISO) || todayISO()) === FUNDER_PROBONO_KEY;
}

/* A billing row's funder: the patient's funder ON THAT CYCLE'S DUE DATE. */
function billingRowFunderKey(patient, dueISO) {
  return patientFunderKey(patient, state.funders, todayISO(), isoDate(dueISO) || todayISO());
}

/* ===== Institutional-funder grace (CHANGELOG-funder-grace.md) =====
 * A cycle whose funder on its due date is ביטוח לאומי / מכבי / משרד הביטחון
 * is not a collection problem until 30 days after its due date: it reads
 * «ממתין לגורם מממן» (grey) instead of the overdue / «לא דווח תשלום» marking.
 * The amount still counts as outstanding everywhere. The rule is
 * lib/funder-grace.js (global FunderGrace, the same as Code.gs
 * isWithinFunderGrace_); without it nothing is deferred (normal marking). */
const FUNDER_GRACE_STATUS_LABEL = 'ממתין לגורם מממן';
/* The status shown inside the window: a partly paid cycle keeps its fact —
 * «שולם חלקית · ממתין לגורם מממן»; an unpaid one reads the grace label. Pure. */
function funderGraceStatusLabel(owedKey) {
  return owedKey === 'partial' ? paymentStatusLabel('partial') + ' · ' + FUNDER_GRACE_STATUS_LABEL : FUNDER_GRACE_STATUS_LABEL;
}
const FUNDER_GRACE_COLUMN_LABEL = 'בתוך תקופת גורם מממן';
function funderGraceLib() {
  return (typeof FunderGrace !== 'undefined' && FunderGrace && typeof FunderGrace.isWithinFunderGrace === 'function') ? FunderGrace : null;
}
/* Pure: is the cycle due on dueISO inside the grace window on todayIso, for
 * this patient, with these Funders rows? false without the rules, the funder
 * module, a funder rows array or a readable due date. */
function patientCycleInFunderGrace(patient, funders, dueISO, todayIso) {
  const G = funderGraceLib();
  const due = isoDate(dueISO);
  if (!G || !funderLib() || !patient || !due || !Array.isArray(funders)) return false;
  return G.isWithinFunderGrace(due, patientFunderKey(patient, funders, todayIso, due), todayIso);
}
/* The live-state form, for the גבייה rows and the dashboard alert: only
 * where funder data is loaded (the same gate as isProbonoOn). */
function isInFunderGraceOn(patient, dueISO) {
  if (!(funderView() || (billingReadView() && !!funderLib())) || !patient) return false;
  return patientCycleInFunderGrace(patient, state.funders, dueISO, todayISO());
}

/* The active funder filter — 'all' outside the finance view. */
function billingFunderFilter() {
  return funderView() ? (state.billingFunder || FUNDER_FILTER_ALL) : FUNDER_FILTER_ALL;
}

/* The day a debt cycle is attributed on: its start, never after the as-of
 * date — the same rule as Funder.debtByFunder. Pure. */
function debtCycleFunderDay(cycle, asOf) {
  const start = isoDate(cycle && cycle.start);
  return start && start <= asOf ? start : asOf;
}

/* The debtAging report keeping only the cycles of funder `filter` (a patient
 * left with none is dropped); 'all' → the report itself. Pure. */
function filterDebtReportByFunder(data, funders, filter) {
  const F = funderLib();
  if (!F || !data || !filter || filter === FUNDER_FILTER_ALL) return data;
  const byPatient = (Array.isArray(data.byPatient) ? data.byPatient : []).map(p => Object.assign({}, p, {
    cycles: (Array.isArray(p.cycles) ? p.cycles : []).filter(c => F.funderAt(funders, p.patientId, debtCycleFunderDay(c, data.asOf)) === filter),
  })).filter(p => p.cycles.length > 0);
  return Object.assign({}, data, { byPatient });
}

/* The report narrowed by the view's house / status filters only (never by
 * funder) — what the strip splits. Pure. */
function debtReportForStrip(data, filters) {
  const f = filters || {};
  const house = f.house || 'all', status = f.status || 'all';
  const byPatient = (Array.isArray(data && data.byPatient) ? data.byPatient : [])
    .filter(p => (house === 'all' || p.houseId === house) && (status === 'all' || debtAgingStatusGroup(p.status) === status));
  return Object.assign({}, data, { byPatient });
}

/* The funder × house strip. → { houseIds, recorded_debt, unrecorded_cycles },
 * each { rows: [{ funder, label, byHouse, total }], totals: { byHouse, total } }.
 * Columns = the view's houses; totals = the view's block totals. Pure. */
function debtFunderStrip(data, funders, filters) {
  const F = funderLib();
  const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
  const split = F.debtByFunder(debtReportForStrip(data, filters), funders, data.asOf);
  const houseIds = debtAgingView(data, filters).houseIds;
  const keys = F.FUNDER_KEYS.concat([F.FUNDER_UNSET]);
  const block = kind => {
    const totals = { byHouse: {}, total: 0 };
    houseIds.forEach(h => { totals.byHouse[h] = 0; });
    const rows = keys.map(k => {
      const row = { funder: k, label: F.labelFor(k), byHouse: {}, total: r2(split[k][kind].total) };
      houseIds.forEach(h => {
        const v = r2(((split[k].byHouse[h] || {})[kind] || { total: 0 }).total);
        row.byHouse[h] = v;
        totals.byHouse[h] = r2(totals.byHouse[h] + v);
      });
      totals.total = r2(totals.total + row.total);
      return row;
    });
    return { rows, totals };
  };
  return { houseIds, recorded_debt: block('recorded_debt'), unrecorded_cycles: block('unrecorded_cycles') };
}

/* Pure: the strip's HTML — two tables, never one summed figure. */
function debtFunderStripHtml(strip) {
  const esc = escapeHtml;
  const table = kind => {
    const b = strip[kind];
    return `<div class="funder-strip-block" data-block="${esc(kind)}">`
      + `<h4 class="debt-block-title">${esc(DEBT_AGING_BLOCK_LABELS[kind])} לפי גורם מממן <span class="count-pill">${esc(fmtShekel(b.totals.total))}</span></h4>`
      + `<div class="debt-table-wrap"><table class="debt-table funder-strip-table"><thead><tr><th>גורם מממן</th>`
      + strip.houseIds.map(h => `<th>${esc(debtAgingHouseName(h))}</th>`).join('') + `<th>סה"כ</th></tr></thead><tbody>`
      + b.rows.map(r => `<tr data-funder="${esc(r.funder)}"><th>`
        + (r.funder === FUNDER_UNSET_KEY ? `<span class="funder-chip funder-unset">${esc(r.label)}</span>` : esc(r.label)) + `</th>`
        + strip.houseIds.map(h => `<td data-house="${esc(h)}">${esc(fmtShekel(r.byHouse[h]))}</td>`).join('')
        + `<td class="debt-row-total">${esc(fmtShekel(r.total))}</td></tr>`).join('')
      + `</tbody><tfoot><tr class="debt-col-totals"><th>סה"כ</th>`
      + strip.houseIds.map(h => `<td data-house="${esc(h)}">${esc(fmtShekel(b.totals.byHouse[h]))}</td>`).join('')
      + `<td class="debt-row-total">${esc(fmtShekel(b.totals.total))}</td></tr></tfoot></table></div></div>`;
  };
  return `<div class="funder-strip" data-finance>`
    + `<p class="billing-date-label">פילוח לפי גורם מממן — כל מחזור משויך לגורם שהיה בתוקף בתחילתו. שני הגושים אינם מסתכמים יחד.</p>`
    + table('recorded_debt') + table('unrecorded_cycles')
    + `</div>`;
}

function initFunderControls() {
  const sel = document.getElementById('billing-funder');
  if (sel) {
    const F = funderLib();
    sel.innerHTML = `<option value="${FUNDER_FILTER_ALL}">כל הגורמים המממנים</option>`
      + (F ? F.FUNDER_KEYS.concat([F.FUNDER_UNSET]).map(k => `<option value="${escapeHtml(k)}">${escapeHtml(F.labelFor(k))}</option>`).join('') : '');
    sel.value = state.billingFunder || FUNDER_FILTER_ALL;
    sel.onchange = () => { state.billingFunder = sel.value || FUNDER_FILTER_ALL; renderBilling(); renderDebtAging(); };
  }
  const box = document.getElementById('funder-fill');
  if (box && box.addEventListener) box.addEventListener('click', (e) => {
    const btn = e.target && e.target.closest && e.target.closest('[data-fill-save]');
    if (!btn || !funderView()) return;
    const row = btn.closest('[data-patient]');
    const patient = row && state.patients.find(p => patientUid(p) === row.getAttribute('data-patient'));
    if (!patient) return;
    const picked = (row.querySelector('[data-fill-funder]') || {}).value || '';
    const from = isoDate((row.querySelector('[data-fill-from]') || {}).value || '');
    if (paymentFunderLabels().indexOf(picked) < 0) { showError(FUNDER_REQUIRED_MESSAGE); return; }
    if (!from) { showError('יש לבחור תאריך תחילה תקין'); return; }
    // R3: one key per row while it is on screen — a retry re-sends it.
    if (!btn.dataset.submissionId) btn.dataset.submissionId = newSubmissionId();
    busyButton(btn, 'save', () => saveFunder(patient, picked, from, btn.dataset.submissionId))
      .catch(e => showError('שמירת הגורם המממן נכשלה — ' + (isLockBusyError(e) ? LOCK_BUSY_MESSAGE_HE : ((e && e.message) || 'שגיאה'))));
  });
}

/* True only for the "released to outpatient" disposition — the single trigger
 * for the cross-app Outpatient lead write. The other two dispositions
 * (completed / stopped_early) do nothing cross-app. Pure + tested. */
function shouldCreateOutpatientLead(disposition) {
  return disposition === 'released_outpatient';
}

/* Build the { name, phone, house, note } payload sent to the Outpatient app.
 * Pure (no DOM, no I/O) so the field mapping is unit-tested directly:
 *   - phone is NOT stored on the patient; it's joined from the originating
 *     lead (patient.fromLead). Hand-entered patients with no lead send ''.
 *   - house is the stable houseId KEY (e.g. 'arfoni'), NOT the Hebrew display
 *     name — the Outpatient side maps the key to its own house.
 *   - note is the patient's source + notes combined (no exit date — the
 *     discharge date lives on the discharge audit row, not the lead). */
function outpatientLeadPayload(patient, lead) {
  const phone = lead && lead.phone ? String(lead.phone) : '';
  const note  = [patient.source, patient.notes]
    .filter(s => s != null && String(s).trim() !== '')
    .map(String)
    .join(' — ');
  return {
    name:  patient.name || '',
    phone: phone,
    house: patient.houseId || '',
    note:  note,
  };
}

/* POST the Outpatient lead via the server proxy (/api/outpatient-lead), which
 * injects the shared secret from Railway env — the secret never reaches the
 * client. NON-FATAL by contract: this is called after the discharge already
 * persisted, so it catches every error and only warns; it never throws and
 * never mutates discharge state, guaranteeing it cannot roll back the
 * discharge. The Outpatient createLead endpoint + env config are a separate
 * deploy (see CHANGELOG); until they exist the proxy returns not-configured
 * and the user is told to add the lead manually. */
async function createOutpatientLead(patient) {
  const lead    = (state.leads || []).find(l => String(l.id) === String(patient.fromLead)) || null;
  const payload = outpatientLeadPayload(patient, lead);
  try {
    const res = await fetch('/api/outpatient-lead', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data || data.ok !== true) {
      throw new Error((data && (data.message || data.error)) || ('HTTP ' + res.status));
    }
    showToast('נוצר ליד טיפול חוץ באפליקציית אאוטפיישנט');
  } catch (e) {
    showError('יצירת ליד טיפול חוץ נכשלה — יש להוסיף את הליד ידנית באאוטפיישנט. ' + (e.message || ''));
  }
}

/* Permanent delete — a DEDICATED backend action (deletePatientRow), NOT a
 * saveAll omission. The merge-don't-drop backend KEEPS rows a saveAll payload
 * omits, so deletion-by-omission stopped being a thing; the dedicated action
 * tombstones the row (reason 'user-delete', written BEFORE the delete, fail-
 * hard) and then removes it, and the backend merge suppresses stale payloads
 * carrying the deleted key for 24h so another open tab can't resurrect it.
 * Local state drops the row WITHOUT a full saveAll — the action IS the whole
 * delete; on failure the optimistic removal rolls back. */
async function deletePatient(p) {
  if (!canDelete()) { showError(ROLE_FORBIDDEN_TEXT); return; }
  if (!confirm(`למחוק לצמיתות את ${p.name}?`)) return;
  const prev = state.patients.slice();
  state.patients = state.patients.filter(x => x.id !== p.id);
  renderAll();
  // The row (and its ✕) is gone by here, so the banner is what reports the
  // round-trip. The native confirm() above is left exactly as it is.
  setSaving(true);
  try {
    /* Patient identity foundation: the persisted id is sent alongside the
     * identity key. The backend deletes EXACTLY the row holding that id
     * (one of several identical-key duplicates can now go on its own) and
     * falls back to the key when the id isn't on the sheet (stale tab). */
    const res = await trackedWrite([_dataGuard], () => apiPost({
      action: 'deletePatientRow',
      patient: { id: p.id ? String(p.id) : '', houseId: p.houseId, name: p.name, date: p.date },
    }));
    if (!res || res.ok !== true) {
      throw new Error((res && (res.message || res.error)) || 'delete_failed');
    }
    // R3: the server names the row it deleted (by id, or by key for a row
    // that predates ids); a retry answers alreadyDeleted with the same id.
    requireSavedId(res, r => r.id || (r.deleted > 0 ? r.key : ''));
    showToast(`${p.name} נמחק לצמיתות`);
  } catch (e) {
    state.patients = prev;
    renderAll();
    showError('מחיקה נכשלה — ' + e.message);
  } finally {
    setSaving(false);
  }
}

/* ====================================================
   MODAL
   ==================================================== */
function showModal({ title, fields, submitLabel, onSubmit }) {
  const root = document.getElementById('modal-root');
  const back = document.createElement('div');
  back.className = 'modal-backdrop';

  const fieldsHtml = fields.map(f => {
    const val = f.value !== undefined ? f.value : '';
    /* Section header — a non-input divider label (no `name`, excluded from value
     * collection and onChange wiring). Lets a modal group fields visually. */
    if (f.type === 'section') {
      return `<div class="form-section-head">${escapeHtml(f.label)}</div>`;
    }
    // A field may render its row initially hidden (f.hidden); an onChange on a
    // sibling can reveal it. Kept as an inline style so no CSS class is needed.
    const rowStyle = f.hidden ? ' style="display:none"' : '';
    if (f.type === 'select') {
      return `
        <div class="form-row"${rowStyle}>
          <label>${f.label}${f.required ? ' *' : ''}</label>
          <select name="${f.name}">
            ${f.options.map(o => `<option value="${o.value}" ${o.value === val ? 'selected' : ''}>${o.label}</option>`).join('')}
          </select>
        </div>`;
    }
    if (f.type === 'textarea') {
      return `
        <div class="form-row"${rowStyle}>
          <label>${f.label}${f.required ? ' *' : ''}</label>
          <textarea name="${f.name}" rows="3">${escapeHtml(val)}</textarea>
        </div>`;
    }
    return `
      <div class="form-row"${rowStyle}>
        <label>${f.label}${f.required ? ' *' : ''}</label>
        <input name="${f.name}" type="${f.type}"${f.step ? ` step="${escapeHtml(f.step)}"` : ''} value="${escapeHtml(val)}" />
      </div>`;
  }).join('');

  back.innerHTML = `
    <div class="modal">
      <h3>${title}</h3>
      <form>
        ${fieldsHtml}
        <div class="form-actions">
          <button type="button" class="btn" data-action="cancel">ביטול</button>
          <button type="submit" class="btn primary">${submitLabel}</button>
        </div>
      </form>
    </div>
  `;
  root.appendChild(back);

  const formEl = back.querySelector('form');

  /* Opt-in per-field change hook. A field may declare `onChange(value, form)`;
   * it fires on the field's native 'change' event (user interaction only —
   * programmatic `.value =` assignments do NOT dispatch 'change', so a handler
   * updating a sibling field can't loop back on itself). Fields without an
   * onChange are untouched, so existing modals are unaffected. */
  fields.forEach(f => {
    if (typeof f.onChange !== 'function') return;
    const el = formEl.querySelector(`[name="${f.name}"]`);
    if (el) el.addEventListener('change', () => f.onChange(el.value, formEl));
  });

  const close = () => back.remove();
  const cancelBtn = back.querySelector('[data-action="cancel"]');
  const submitBtn = back.querySelector('button[type="submit"]');

  cancelBtn.onclick = close;
  back.addEventListener('click', e => { if (e.target === back) close(); });

  /* Every showModal caller (add/edit lead, admit, add/edit patient) shares this
   * one submit. busyButton owns the double-click guard, the «שומר…» label and
   * the restore on all three exits — saved, refused (onSubmit returned false)
   * and thrown — so the per-caller rollback logic is untouched. */
  back.querySelector('form').onsubmit = e => {
    e.preventDefault();
    const formTarget = e.target;
    return busyButton(submitBtn, 'save', async () => {
      cancelBtn.disabled = true;
      try {
        const fd = new FormData(formTarget);
        const values = {};
        fields.forEach(f => {
          if (!f.name) return;   // section headers carry no value
          values[f.name] = (fd.get(f.name) || '').toString();
        });
        const ok = await onSubmit(values);
        if (ok !== false) close();
        // ok === false → the caller refused and already showed why; the modal
        // stays open and busyButton hands the button back for a retry.
      } catch (err) {
        console.error('[E-ZONE] modal submit threw:', err);
        showError(err.message || 'שמירה נכשלה');
      } finally {
        cancelBtn.disabled = false;
      }
    });
  };
}

/* ====================================================
   BILLING
   ====================================================
   Each active patient pays monthly on the same day of the month as their
   entry date (state.patients[].date), one month in advance. A payment is
   "due on D" when DAY(D) == DAY(entryDate). Each (patient, dueDate) pair
   maps to a deterministic payment id so toggling status upserts the same
   sheet row instead of creating duplicates.
*/

/* ===== PAYMENT ↔ PATIENT IDENTITY =====
 *
 * THE PROBLEM. A payment was linked to a patient by houseId::name::entryDate.
 * Any change to any of the three DETACHES it, silently, for good. Found in the
 * live sheet: "שחר חיון " with a trailing space; "אביב שבתאי" carrying
 * invisible characters; נועם אשבל's payment left behind on her ריהאב record
 * after she moved to הפרדס; and four rows — "עמית יעקובי", "ערן", "עדי" and
 * שחר's — attached to no patient at all.
 *
 * THE FIX, in three parts:
 *   1. patientUid — the PERSISTED Patients-sheet id — is stamped on every new
 *      payment row and matched FIRST. It survives a rename and a house
 *      transfer, because it is not made of either.
 *   2. Names are trimmed at every write, client and server, so the triple
 *      stops acquiring new variants.
 *   3. The triple is still read, as a FALLBACK, in two flavours: exactly as
 *      stored, then normalized — so a row already carrying "שחר חיון " keeps
 *      matching the patient whose name is now stored trimmed.
 *
 * Nothing here rewrites an existing patientId. The triple on a historical row
 * is left exactly as it is; what changes is what we are willing to RECOGNIZE. */

/* One trim, used by every patient-name write path. */
function trimName(v) {
  return String(v == null ? '' : v).trim();
}

/* Characters that make two identical-LOOKING names different strings: the
 * zero-width space/joiners, the bidi embedding and override marks, the word
 * joiner and the BOM. Hebrew text pasted out of WhatsApp, Word or a PDF
 * carries them routinely, and "אביב שבתאי" in the live sheet does. They are
 * stripped for MATCHING only — never from what is stored, because removing
 * characters from somebody's recorded name is a data edit, not a comparison. */
const NAME_INVISIBLES = /[\u200b-\u200f\u202a-\u202e\u2060\ufeff]/g;

/* A name reduced to what two humans would call "the same name": trimmed,
 * Unicode-composed, invisibles gone, inner whitespace runs collapsed, case
 * folded. MATCHING ONLY. */
function normalizeNameForMatch(v) {
  return trimName(v).normalize('NFC').replace(NAME_INVISIBLES, '')
    .replace(/\s+/g, ' ').trim().toLowerCase();
}

/* The PERSISTED Patients-sheet row id (patient identity foundation). This is
 * the identity that survives every edit; `patientKey` is the one that does
 * not. Blank for a pseudo-patient built by findPatientForPayment. */
function patientUid(p) {
  return String((p && p.id) || '').trim();
}
/* The uid a payment ROW claims.
 *
 * TWO COLUMNS, one answer. `patientUid` is SERVER-OWNED (PR #139): the server
 * resolves it from an EXACT match of the row's triple and leaves it blank
 * when it cannot. `linkPatientUid` is what a PERSON decided on the reconnect
 * screen, and the server lets it win. Reading the decision first also makes
 * the optimistic local row correct in the moment between the click and the
 * server's echo. */
function paymentPatientUid(pay) {
  if (!pay) return '';
  return String(pay.linkPatientUid || pay.patientUid || '').trim();
}

function patientKey(p) {
  /* Billing/payment identity for a patient across sessions: house + name +
   * entry-date. Kept as the payment/override key even now that the Patients
   * sheet persists a per-row `id` — every existing payment and override row is
   * keyed on this triple, so switching it would orphan them; patientUid is
   * added ALONGSIDE it and consulted first, rather than replacing it.
   *
   * The name is trimmed, mirroring patientKey_() in Code.gs, which has always
   * trimmed. The two disagreeing is how a payment row came to hold
   * "…::שחר חיון ::…" while the server's own key for the same row was
   * "…::שחר חיון::…". */
  return `${p.houseId}::${trimName(p.name)}::${p.date || ''}`;
}

/* The triple, reduced for MATCHING: house, normalized name, normalized date.
 * Built from a patient, or from a stored `patientId` string, so both sides of
 * a comparison go through the same reduction. */
function patientMatchKey(houseId, name, dateISO) {
  return `${resolveHouseId(houseId || '')}::${normalizeNameForMatch(name)}::${isoDate(dateISO)}`;
}
function patientMatchKeyOf(p) {
  return p ? patientMatchKey(p.houseId, p.name, p.date) : '';
}
/* A stored 'houseId::name::entryDate' put through the same reduction. Returns
 * '' for anything that is not that shape — an unparseable id is a true orphan
 * and must not be coerced into looking like a match. */
function patientMatchKeyFromId(patientId) {
  const parts = String(patientId == null ? '' : patientId).split('::');
  if (parts.length !== 3) return '';
  return patientMatchKey(parts[0], parts[1], parts[2]);
}

function paymentId(patient, dueDateISO) {
  return `pay::${patientKey(patient)}::${dueDateISO}`;
}

function normalizePayment(r) {
  if (!r || typeof r !== 'object') r = {};
  const rawStatus = String(r.status == null ? '' : r.status).trim();
  const status = PAYMENT_STATUS_ALIASES[rawStatus]
              || PAYMENT_STATUS_ALIASES[rawStatus.toLowerCase()]
              || 'unpaid';
  const amount     = Number(r.amount) || 0;
  const amountPaid = Number(r.amountPaid) || 0;
  const balance    = r.balance !== undefined && r.balance !== ''
    ? Number(r.balance) || 0
    : Math.max(0, amount - amountPaid);
  const id = String(r.id || '');
  /* Heal a blank patientId cell from the deterministic id. Live sheets contain
   * records whose id is well-formed (pay::<houseId>::<name>::<entryDate>::<dueDate>)
   * but whose patientId cell is blank — recompute()'s save-time backfill and
   * findPatientForPayment's fallbacks exist precisely because of them. Deriving
   * it here makes payment.patientId the SINGLE source of identity for every
   * consumer at once: the override overlay lookup, the row editor's match
   * guard, and the override write. A non-blank cell is preserved as-is; an id
   * that doesn't parse to the 5-part shape leaves it blank (a true orphan). */
  let patientId = String(r.patientId || '');
  if (!patientId) {
    const parts = id.split('::');
    if (parts.length === 5 && parts[0] === 'pay') {
      patientId = parts.slice(1, 4).join('::');
    }
  }
  return {
    id:          id,
    patientId:   patientId,
    patientName: String(r.patientName || ''),
    houseId:     resolveHouseId(r.houseId || ''),
    dueDate:     isoDate(r.dueDate),
    amount,
    status,
    amountPaid,
    balance,
    timestamp:   String(r.timestamp || ''),
    /* The RECORDED coverage period (appended columns). Kept verbatim — blank
     * stays blank, and paymentCoverage() falls back to the inferred cycle for
     * it. isoDate() normalizes a full timestamp or a Sheets Date cell to its
     * LOCAL day, the same guard dueDate gets, so a period read back from the
     * sheet can never drift −1 day in Israel. An unusable pair is left as-is
     * here and treated as absent by recordedCoverage() — normalizing is not
     * this function's job to refuse. */
    coverageStart: isoDate(r.coverageStart),
    coverageEnd:   isoDate(r.coverageEnd),
    /* The identity + link columns (appended; see PAYMENT_COLUMNS in Code.gs).
     *
     *   patientUid     — SERVER-OWNED (PR #139): the persisted Patients id,
     *                    resolved from an EXACT triple match and left blank
     *                    when that fails. Carried here so the client reads
     *                    the same answer the accounting feed does; never sent.
     *   linkPatientUid — what a PERSON decided on the reconnect screen. The
     *                    one client-writable input to the link, and the only
     *                    thing that may override the automatic resolution.
     *   linkStatus     — '' (never reviewed) | 'linked' | 'not_a_patient'.
     *   linkNote       — the reason, required for 'not_a_patient'.
     *   linkedBy/At    — who decided and when. SERVER-STAMPED; a client value
     *                    is dropped on write and only echoed back on read. */
    patientUid:     String(r.patientUid || '').trim(),
    linkPatientUid: String(r.linkPatientUid || '').trim(),
    linkStatus: PAYMENT_LINK_STATUSES.indexOf(String(r.linkStatus || '').trim()) >= 0
      ? String(r.linkStatus).trim() : '',
    linkNote:   String(r.linkNote || ''),
    linkedBy:   String(r.linkedBy || ''),
    linkedAt:   String(r.linkedAt || ''),
  };
}

/* The only values linkStatus may hold. Mirrors PAYMENT_LINK_STATUSES in
 * Code.gs, which is the authority on write. '' means "nobody has looked at
 * this row yet" and is what every historical row carries. */
/* 'duplicate' is a link decision like the other two — it says what this row
 * IS — and it is the only one that also changes the row's payment status. */
const PAYMENT_LINK_STATUSES = ['linked', 'not_a_patient', 'duplicate'];
/* Longest note the reconnect screen will store. Mirrors the server cap. */
const PAYMENT_LINK_NOTE_MAX = 300;

/* Deterministic id for a per-patient, per-month billing-amount override.
 * Mirrors billingOverrideId_() in Code.gs exactly so a client-built id upserts
 * into the same row the server would compute. `month` is 'YYYY-MM'. */
function billingOverrideId(patientId, month) {
  return `ovr::${patientId}::${month}`;
}

/* Defensive normalizer for a billing-override row from getData — same pickField
 * idiom as normalizePayment/normalizeLead. `month` is clamped to 'YYYY-MM'
 * (slice(0,7)) so a stray full date can't leak day precision into the key;
 * `amount` is coerced to a number; a missing `id` is rebuilt deterministically
 * from (patientId, month). Rows missing patientId or month are filtered out by
 * the caller. */
function normalizeBillingOverride(r) {
  if (!r || typeof r !== 'object') r = {};
  const patientId = String(pickField(r, ['patientId', 'patient_id', 'מזהה מטופל']) || '');
  const month     = String(pickField(r, ['month', 'חודש']) || '').slice(0, 7);
  const amountRaw = pickField(r, ['amount', 'סכום']);
  const id        = String(pickField(r, ['id', 'ID', 'מזהה']) || '');
  return {
    id:        id || (patientId && month ? billingOverrideId(patientId, month) : ''),
    patientId,
    month,
    amount:    Number(amountRaw) || 0,
    created:   String(pickField(r, ['created', 'created_at', 'נוצר']) || ''),
  };
}

/* Make sure a date coming from the sheet ends up as a YYYY-MM-DD string.
 * Google Sheets sometimes hands back Date objects (in serialized form as
 * ISO strings, but occasionally as locale strings). Normalize both. */
function isoDate(v) {
  if (!v) return '';
  if (typeof v === 'string') {
    // Already a bare YYYY-MM-DD (no time / no timezone) — the canonical stored
    // form. Return it untouched; parsing it through Date would inject UTC
    // midnight. Anchored to the full string on purpose: a *full timestamp*
    // ("2026-06-10T21:00:00.000Z") must NOT be caught here — slicing its
    // leading date portion is the UTC-day bug — it falls through to the
    // local-part path below instead.
    const m = v.match(/^\d{4}-\d{2}-\d{2}$/);
    if (m) return m[0];
  }
  // Full timestamp string (e.g. a Sheets date cell serialized to the client as
  // "2026-06-10T21:00:00.000Z") or a Date object. Derive the calendar day from
  // LOCAL parts — NOT toISOString().slice(0, 10). A UTC slice lands on the
  // previous calendar day for UTC+2/+3 (Israel), drifting the date −1 per
  // save→read round-trip. getFullYear/getMonth/getDate read the local day, so
  // an already-drifted date-typed cell renders back on its correct local date.
  const d = new Date(v);
  if (isNaN(d)) return typeof v === 'string' ? v : String(v);
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${mo}-${day}`;
}

/* Sheets stores time-only cells as a Date anchored on 1899-12-30. When the Apps
 * Script readSheet_ uses getValues(), those cells come back as Date objects (or,
 * after JSON transport, full ISO strings). The server now normalizes visitTime
 * to a plain "HH:MM" string (asISOTime_ in the spreadsheet timezone), so the
 * fast path below handles the normal case; the Date/string fallbacks use LOCAL
 * getters — consistent with the isoDate rule — so a timestamp that still slips
 * through is read on the user's wall clock, not shifted by the UTC offset (the
 * mismatched-tz UTC read is what drifted the value save→save). <input type=time>
 * only accepts "HH:MM". */
function isoTime(v) {
  if (!v) return '';
  if (typeof v === 'string') {
    const m = v.match(/^(\d{2}):(\d{2})/);
    if (m) return `${m[1]}:${m[2]}`;
    const d = new Date(v);
    if (!isNaN(d)) {
      const hh = String(d.getHours()).padStart(2, '0');
      const mm = String(d.getMinutes()).padStart(2, '0');
      return `${hh}:${mm}`;
    }
    return v;
  }
  const d = new Date(v);
  if (!isNaN(d)) {
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `${hh}:${mm}`;
  }
  return '';
}

/* The day-of-month a billing cycle is anchored to.
 *
 * ROUTED THROUGH isoDate(). It used to slice the raw string, which is correct
 * only for a value already stored as bare 'YYYY-MM-DD'. A date-TYPED sheet
 * cell reaches the client as "2026-09-06T21:00:00.000Z"; slicing that gives
 * day 6, while the calendar day in Israel is the 7th. The anchor would then be
 * one day early for every such patient — and, because the whole billing
 * schedule hangs off this number, so would every due date, every renewal and
 * every inferred coverage window. isoDate() reads the LOCAL parts, which is
 * the same rule every other date on this screen already goes through. */
function dayOfMonth(iso) {
  const parts = String(isoDate(iso) || '').split('-');
  if (parts.length < 3) return null;
  const day = parseInt(parts[2], 10);
  return isNaN(day) ? null : day;
}

/* monthKey lives ONCE, further down beside firstDayOfMonth/lastDayOfMonth.
 * There used to be a second declaration right here whose body sliced the raw
 * string without isoDate(). Two function declarations in one script scope are
 * not two functions: the later one silently overwrote this one at hoist time,
 * so the isoDate-routed version below is what has always run and the copy here
 * was dead code that merely looked authoritative. Removing it changes no
 * behaviour — it removes the chance of "fixing" the dead one and wondering why
 * nothing moved. monthly-revenue's guard test now pins each shared date
 * primitive to exactly one declaration so the twin cannot come back. */

/* The override record for (patientId, 'YYYY-MM'), or null. Pure. */
function billingOverrideFor(overrides, patientId, month) {
  if (!Array.isArray(overrides)) return null;
  return overrides.find(o => o && o.patientId === patientId && o.month === month) || null;
}

/* Overlay a per-month billing override onto a payment record. Pure — returns a
 * NEW object when an overlay applies, the input untouched otherwise.
 *   - paid / partial records are HISTORY: money already moved at a recorded
 *     amount — never rewritten by an override.
 *   - unpaid records (persisted or in-memory placeholders): the override for
 *     the record's due-date month replaces `amount`, and `balance` is
 *     recomputed. This is the single rule that routes the override into the
 *     row display, יתרה, the due-list KPI totals, the monthly-summary
 *     outstanding figure, and the renewal write. */
function applyBillingOverride(payment, overrides) {
  if (!payment || payment.status === 'paid' || payment.status === 'partial') return payment;
  const ovr = billingOverrideFor(overrides, payment.patientId, monthKey(payment.dueDate));
  if (!ovr) return payment;
  const amount = Number(ovr.amount) || 0;
  return {
    ...payment,
    amount,
    balance: Math.max(0, amount - (payment.amountPaid || 0)),
  };
}

/* Build (or reuse) the payment record for a given patient + due date. If
 * there's no sheet-persisted record yet, return an in-memory "unpaid"
 * placeholder — not added to state.payments until it's actually saved. Either
 * way the result carries the per-month override overlay (unpaid only), so
 * every consumer — billing rows, KPI totals, the renewal confirm + write —
 * sees the effective amount for that month. */
function paymentForPatientOnDate(patient, dueDateISO) {
  const id = paymentId(patient, dueDateISO);
  const existing = state.payments.find(x => x.id === id);
  if (existing) return applyBillingOverride(existing, state.billingOverrides);
  return applyBillingOverride(normalizePayment({
    id,
    patientId: patientKey(patient),
    /* patientUid is SERVER-OWNED (PR #139) — it is resolved from the triple
     * on write, so a placeholder does not claim one. What the placeholder DOES
     * carry is a trimmed name, so the triple it is born with is the same one
     * the server's index is built from. */
    patientName: trimName(patient.name),
    houseId: patient.houseId,
    dueDate: dueDateISO,
    amount: patient.pay || 0,
    status: 'unpaid',
    amountPaid: 0,
    balance: patient.pay || 0,
  }), state.billingOverrides);
}

function activePatients() {
  return state.patients.filter(p => p.status !== 'released');
}

/* ===== THE STAY WINDOW =====
 * ONE rule, shared by every screen that asks "was this patient in the house
 * then": the daily גבייה list and its KPI cards, יתרות פתוחות, the old
 * סיכום חודשי and הכנסות חודשיות.
 *
 * THE BUG IT CLOSES. Being due was decided by DAY-OF-MONTH alone. עמית
 * בורנשטיין entered on 7.9.2026 and appeared on the גבייה list for 07/07/2026
 * — two months before he arrived — along with ניר כהן, אבי משען, בן שלום,
 * שחר חיון and גיל, every one of them a September admission showing on a July
 * date. The day matched; nothing asked whether the stay did.
 *
 * Every date is normalized through isoDate() before it is compared. Comparing
 * raw stored strings is how a date-typed cell's UTC timestamp lands on the
 * wrong side of a boundary — a one-day drift that would move a patient's first
 * or last cycle by a whole month at the edges. */

/* The day a patient's stay ended, or '' while they are still in the house. */
function patientExitISO(patient) {
  return isoDate((patient && (patient.exitDate || patient.dischargedAt)) || '');
}

/* Did this patient's stay cover `dateISO`?
 *   entryDate <= date  AND  (exitDate empty OR exitDate >= date)
 *
 * A released patient with NO exit date recorded is the one case the dates
 * cannot answer. The conservative reading is taken — they are treated as no
 * longer in the house — because status is then the only signal there is, and
 * inventing a stay would re-create the very "billed for a period they were not
 * here" this function exists to stop. */
function patientStayCoversDate(patient, dateISO) {
  const date = isoDate(dateISO);
  if (!patient || !date) return false;
  const entry = isoDate(patient.date);
  if (!entry || entry > date) return false;
  const exit = patientExitISO(patient);
  if (exit) return exit >= date;
  return isBillablePatient(patient);
}

/* Did the stay cover ANY day of [fromISO, toISO]? The month-level form of the
 * rule above: a patient discharged in August was in the house in July, so
 * their July cycles are July's business whatever their status reads today. */
function patientStayOverlapsRange(patient, fromISO, toISO) {
  const from = isoDate(fromISO), to = isoDate(toISO);
  if (!patient || !from || !to) return false;
  const entry = isoDate(patient.date);
  if (!entry || entry > to) return false;
  const exit = patientExitISO(patient);
  if (exit) return exit >= from;
  return isBillablePatient(patient);
}

/* A patient is due on a date when their billing anchor falls on it AND their
 * stay covered it. Both halves, always — the day-of-month half alone is the
 * bug above. */
function patientDueOnDate(patient, dateISO) {
  const d = dayOfMonth(dateISO);
  if (!d || !patientStayCoversDate(patient, dateISO)) return false;
  return dayOfMonth(patient && patient.date) === d;
}

function patientsDueOn(dateISO) {
  if (!dayOfMonth(dateISO)) return [];
  return state.patients.filter(p => patientDueOnDate(p, dateISO));
}

/* ===== Renewal alert =====
   A renewal is the patient's NEXT monthly billing-day occurrence. It uses the
   SAME anchor as the גבייה tab: the patient's entry-date day-of-month
   (dayOfMonth(p.date)) recurring every month — one source of truth with
   patientsDueOn. We do NOT derive it from "last payment + 1 month"; the entry
   day-of-month IS the schedule. A patient with no payment history therefore
   still has a renewal date (their entry day in the current/next month).
*/

/* Parse a bare YYYY-MM-DD into a local-midnight Date (or null). Local parts —
 * not new Date(iso), which would parse as UTC and drift the day for Israel. */
function parseLocalISO(iso) {
  const m = String(iso == null ? '' : iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/* Whole calendar days from one ISO date to another (toISO - fromISO).
 * Both are read as local midnights so the result is an exact integer. */
function daysBetween(fromISO, toISO) {
  const a = parseLocalISO(fromISO);
  const b = parseLocalISO(toISO);
  if (!a || !b) return NaN;
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}

/* The next calendar date on or after `fromISO` whose day-of-month equals the
 * entry date's day-of-month. Months shorter than the target day clamp to the
 * month's last day (e.g. an entry day of 31 renews on Feb 28). Returns a Date
 * or null. Mirrors the day-of-month matching patientsDueOn relies on. */
function nextBillingDayOnOrAfter(entryISO, fromISO) {
  const targetDay = dayOfMonth(entryISO);
  const from = parseLocalISO(fromISO);
  if (!targetDay || !from) return null;
  const occ = (year, monthIdx) => {
    // Normalize year/month so monthIdx overflow (e.g. 12) rolls the year.
    const first = new Date(year, monthIdx, 1);
    const yy = first.getFullYear();
    const mm = first.getMonth();
    const lastDay = new Date(yy, mm + 1, 0).getDate();
    return new Date(yy, mm, Math.min(targetDay, lastDay));
  };
  let cand = occ(from.getFullYear(), from.getMonth());
  if (cand.getTime() < from.getTime()) {
    cand = occ(from.getFullYear(), from.getMonth() + 1);
  }
  return cand;
}

/* ISO (YYYY-MM-DD) of the patient's next billing-day occurrence on or after
 * `fromISO`, or '' if the entry date is unusable. */
function renewalDateISO(entryISO, fromISO) {
  const d = nextBillingDayOnOrAfter(entryISO, fromISO);
  return d ? isoDate(d) : '';
}

/* The MOST RECENT billing-day occurrence ON OR BEFORE `fromISO` — the current
 * cycle's due date. Mirror image of nextBillingDayOnOrAfter with the same
 * entry-day anchor and the same short-month clamp (entry day 29/30/31 in a
 * shorter month → that month's last day). Returns a Date or null. */
function lastBillingDayOnOrBefore(entryISO, fromISO) {
  const targetDay = dayOfMonth(entryISO);
  const from = parseLocalISO(fromISO);
  if (!targetDay || !from) return null;
  const occ = (year, monthIdx) => {
    // Normalize year/month so monthIdx underflow (e.g. -1) rolls the year.
    const first = new Date(year, monthIdx, 1);
    const yy = first.getFullYear();
    const mm = first.getMonth();
    const lastDay = new Date(yy, mm + 1, 0).getDate();
    return new Date(yy, mm, Math.min(targetDay, lastDay));
  };
  let cand = occ(from.getFullYear(), from.getMonth());
  if (cand.getTime() > from.getTime()) {
    cand = occ(from.getFullYear(), from.getMonth() - 1);
  }
  return cand;
}

/* ===== Overdue-payment alert =====
 * A patient is OVERDUE when the current cycle's due date has arrived
 * (today >= their most recent billing-day occurrence — entry-day anchor,
 * short-month clamped) AND no payment is recorded for that cycle. A recorded
 * paid/partial payment clears the alert immediately (the same coverage rule
 * patientsNeedingRenewal uses). Released patients are excluded via
 * activePatients(). Returns [{ patient, dueISO }] sorted oldest-due first. */
/* Does this payment row COVER its cycle — i.e. does it silence the overdue
 * and renewal alerts? Only money actually recorded does, and a VOID row is
 * not money: it is the second copy of a sum already counted on its twin.
 * Shared by both alerts so they cannot drift apart. */
function paymentCoversCycle(pay) {
  if (!pay || isVoidPayment(pay)) return false;
  return pay.status === 'paid' || pay.status === 'partial';
}

function overduePatients(fromISO) {
  const today = fromISO || todayISO();
  const out = [];
  activePatients().forEach(p => {
    const d = lastBillingDayOnOrBefore(p.date, today);
    if (!d) return;
    const dueISO = isoDate(d);
    // A brand-new patient whose first cycle hasn't started yet: the computed
    // occurrence predates their entry date — no cycle exists, nothing overdue.
    if (dueISO < isoDate(p.date)) return;
    const pay = paymentForPatientOnDate(p, dueISO);
    if (paymentCoversCycle(pay)) return;
    if (isProbonoOn(p, dueISO)) return;   // pro-bono: nothing is owed
    if (isInFunderGraceOn(p, dueISO)) return;   // institutional funder, ≤ 30 days: not overdue yet
    out.push({ patient: p, dueISO });
  });
  return out.sort((a, b) => a.dueISO.localeCompare(b.dueISO));
}

/* Dashboard strip — "X מטופלים ממתינים לתשלום". Hidden at zero; the click
 * navigation to the גבייה tab is wired once in initTabs. */
function renderOverdueAlert() {
  if (!financeView()) return; // restricted view: no billing UI at all
  const wrap    = document.getElementById('overdue-alert');
  const countEl = document.getElementById('overdue-alert-count');
  const textEl  = document.getElementById('overdue-alert-text');
  if (!wrap) return;
  const list = overduePatients(todayISO());
  if (!list.length) {
    wrap.classList.add('hidden');
    return;
  }
  wrap.classList.remove('hidden');
  if (countEl) countEl.textContent = list.length;
  if (textEl)  textEl.textContent = `${list.length} מטופלים ממתינים לתשלום`;
}

/* Active patients whose next billing day falls within [today, today+window]
 * AND whose upcoming cycle is NOT already covered by a paid/partial payment.
 * Returns [{ patient, renewalISO, days }] sorted by renewal date. */
function patientsNeedingRenewal(fromISO, windowDays) {
  const today = fromISO || todayISO();
  const win = windowDays == null ? 7 : windowDays;
  const out = [];
  activePatients().forEach(p => {
    const renewalISO = renewalDateISO(p.date, today);
    if (!renewalISO) return;
    const days = daysBetween(today, renewalISO);
    if (!(days >= 0 && days <= win)) return;
    // Cycle coverage: only a paid/partial payment for THIS due date counts as
    // covered — an unpaid placeholder does not suppress the alert.
    const pay = paymentForPatientOnDate(p, renewalISO);
    if (paymentCoversCycle(pay)) return;
    if (isProbonoOn(p, renewalISO)) return;   // pro-bono: nothing to renew
    out.push({ patient: p, renewalISO, days });
  });
  return out.sort((a, b) => a.renewalISO.localeCompare(b.renewalISO));
}

/* ===== MATCHING A PAYMENT TO A PATIENT =====
 *
 * FOUR TIERS, most durable first. The tier is REPORTED, not just used: the
 * reconnect screen shows how a row is holding on, and `matchPatientForPayment`
 * is the one place the order is written down.
 *
 *   1. patientUid    — the persisted Patients id. Survives a rename AND a
 *                      house transfer, because it is made of neither.
 *   2. triple_exact  — houseId::name::entryDate exactly as the row stores it.
 *                      What every historical row has, and all it has.
 *   3. triple_loose  — the same triple with the name normalized (trimmed,
 *                      invisibles stripped, case folded). This is what keeps
 *                      "שחר חיון " attached to שחר חיון.
 *   4. house_name    — house + normalized name, no date, and ONLY when exactly
 *                      one patient matches. A second candidate means we cannot
 *                      tell them apart, and guessing is how a payment ends up
 *                      on the wrong person's ledger.
 *
 * Returns { patient, via } or null. Pure over the `patients` list it is
 * given — buildMonthlyRevenue and the reconnect screen both drive it over
 * their own arrays. */
const PAYMENT_MATCH_TIERS = ['patientUid', 'triple_exact', 'triple_loose', 'house_name'];

function matchPatientForPayment(pay, patients) {
  if (!pay || !Array.isArray(patients)) return null;

  const uid = paymentPatientUid(pay);
  if (uid) {
    const byUid = patients.find(p => p && patientUid(p) === uid);
    if (byUid) return { patient: byUid, via: 'patientUid' };
    /* A uid that names nobody is a DECISION that has gone stale (the patient
     * row was deleted). It is not a licence to fall through to a name match —
     * that would quietly re-link the money to somebody else. Send it to the
     * reconnect screen instead. */
    return null;
  }

  const storedId = String(pay.patientId || '');
  if (storedId) {
    /* AMBIGUITY IS REFUSED AT EVERY TIER, this one included. Two patients CAN
     * share a triple — the same person readmitted on the same day into the
     * same house, or a genuine namesake — and `find` would silently hand back
     * whichever the array happened to hold first. That is a coin flip
     * deciding whose ledger a payment lands on. */
    const exactHits = patients.filter(p => p && patientKey(p) === storedId);
    if (exactHits.length === 1) return { patient: exactHits[0], via: 'triple_exact' };
    if (exactHits.length > 1) return null;
    const loose = patientMatchKeyFromId(storedId);
    if (loose) {
      const hits = patients.filter(p => p && patientMatchKeyOf(p) === loose);
      if (hits.length === 1) return { patient: hits[0], via: 'triple_loose' };
      if (hits.length > 1) return null;   // ambiguous — never guess
    }
  }

  if (pay.patientName && pay.houseId) {
    const house = resolveHouseId(pay.houseId);
    const name = normalizeNameForMatch(pay.patientName);
    const hits = patients.filter(p => p
      && resolveHouseId(p.houseId) === house
      && normalizeNameForMatch(p.name) === name);
    if (hits.length === 1) return { patient: hits[0], via: 'house_name' };
  }
  return null;
}

/* The payment may exist on Sheets without a matching patient (e.g., the
 * patient was released after a payment was recorded). We still want to show
 * those records in "open balances" so the money isn't forgotten. */
function findPatientForPayment(pay) {
  const m = matchPatientForPayment(pay, state.patients);
  return m ? m.patient : null;
}

/* ====================================================
   שיוך תשלומים — THE RECONNECT TOOL
   ====================================================
   Every payment row that matches NO current patient, with the candidates it
   might belong to, for a person to decide. NOTHING here reconnects on its own:
   the engine ranks, the screen presents, Sandra chooses.

   The rows this was built for, found in the live sheet:
     "שחר חיון " (trailing space)   07/09  ₪35,000  עפרוני
     "עמית יעקובי"                  07/09  ₪30,000  עפרוני — attached to nobody,
       while עמית בורנשטיין (עפרוני, entered 7.9) has his OWN ₪30,000 that day.
       A rename, or a double entry. The tool REFUSES to decide which: it shows
       both, warns that the cycle is already paid, and waits.
     "אביב שבתאי" (invisible chars)  13/07  ₪18,000  ריהאב
     "ערן"                           09/08  ₪35,000  עפרוני
     "עדי"                           14/09  ₪35,000  ריהאב
     נועם אשבל — moved ריהאב → הפרדס; her payment stayed on the ריהאב record. */

/* Rows a person still has to look at: no current patient, and no decision
 * recorded. A row marked 'not_a_patient' or voided as a 'duplicate' has been
 * decided and drops out — it is not a loose end, it is a documented one.
 * Both stay visible further down the screen, under their own headings. Pure. */
const RECONNECT_DECIDED_STATUSES = ['not_a_patient', 'duplicate'];
function detachedPayments(payments, patients) {
  if (!Array.isArray(payments)) return [];
  const list = Array.isArray(patients) ? patients : [];
  return payments.filter(pay => pay
    && RECONNECT_DECIDED_STATUSES.indexOf(pay.linkStatus) < 0
    && !isVoidPayment(pay)
    && !matchPatientForPayment(pay, list));
}

/* Whole days between two ISO dates, or null when either is unusable. Used for
 * the ±1 day entry-date proximity below; daysBetween() is the shared one. */
function candidateDayGap(aISO, bISO) {
  const n = daysBetween(isoDate(aISO), isoDate(bISO));
  return Number.isFinite(n) ? Math.abs(n) : null;
}

/* Do two names look like the same person? Deliberately CONSERVATIVE — this
 * only decides what to SHOW Sandra, never what to write:
 *   - identical after normalization (the trailing-space and invisibles cases);
 *   - one is a prefix of the other ("ערן" vs "ערן כהן", "עדי" vs "עדי לוי") —
 *     the live sheet's single-word rows are exactly this shape;
 *   - they share a whole word (a first or last name in common). */
function namesLookAlike(a, b) {
  const x = normalizeNameForMatch(a), y = normalizeNameForMatch(b);
  if (!x || !y) return false;
  if (x === y) return true;
  if (x.indexOf(y) === 0 || y.indexOf(x) === 0) return true;
  const xw = x.split(' ').filter(Boolean), yw = y.split(' ').filter(Boolean);
  return xw.some(w => w.length > 1 && yw.indexOf(w) !== -1);
}

/* Candidate patients for a detached payment, best first, each carrying the
 * REASONS it is offered so the screen can show them rather than a bare score.
 *
 * The four signals, in the order they are trusted:
 *   uid          — the row's patientUid names this patient, but the tiers
 *                  above rejected it (a stale decision). Strongest signal
 *                  there is, and the one case where the row already told us.
 *   same_house   — the payment's house is this patient's house.
 *   name         — the names look alike (see namesLookAlike).
 *   entry_date   — the payment's due date is within ONE DAY of the patient's
 *                  entry date. A first payment is taken on admission, so this
 *                  is how "עמית יעקובי, 07/09" finds עמית בורנשטיין, who
 *                  entered on 7.9.
 *
 * A candidate needs at least ONE of name / entry_date / uid: house alone would
 * offer every resident of עפרוני and teach Sandra to ignore the list. */
function reconnectCandidates(pay, patients) {
  if (!pay || !Array.isArray(patients)) return [];
  const payHouse = resolveHouseId(pay.houseId || '');
  const uid = paymentPatientUid(pay);
  const dueISO = isoDate(pay.dueDate);
  const out = [];
  patients.forEach(p => {
    if (!p) return;
    const reasons = [];
    let score = 0;
    if (uid && patientUid(p) === uid) { reasons.push('uid'); score += 100; }
    if (payHouse && resolveHouseId(p.houseId) === payHouse) { reasons.push('same_house'); score += 10; }
    if (namesLookAlike(pay.patientName, p.name)) { reasons.push('name'); score += 40; }
    const gap = candidateDayGap(dueISO, p.date);
    if (gap !== null && gap <= 1) { reasons.push('entry_date'); score += 30; }
    /* The stay window (PR 1's rule): a patient whose stay covered the due date
     * is a likelier owner of the money than one who was not in the house. Not
     * required — a payment can legitimately precede an entry by a day — but it
     * ranks. */
    if (patientStayCoversDate(p, dueISO)) { reasons.push('in_house'); score += 5; }
    if (!reasons.some(r => r === 'name' || r === 'entry_date' || r === 'uid')) return;
    out.push({ patient: p, patientUid: patientUid(p), score, reasons });
  });
  return out.sort((a, b) => (b.score - a.score)
    || String(a.patient.name || '').localeCompare(String(b.patient.name || ''), 'he'));
}

/* Would linking this payment to this patient create a SECOND payment for a
 * cycle they already have? Returns the colliding rows, never blocks: the
 * "עמית יעקובי / עמית בורנשטיין" pair is either a rename (one row is a
 * duplicate to be removed later) or a genuine double entry, and only a person
 * knows which. Two rows are the same cycle when their due dates fall in the
 * same month — a stored due date that drifted a day or two from the entry-day
 * anchor is still THAT cycle, the same rule buildMonthlyRevenue uses. */
function reconnectDoubleEntry(pay, patient, payments) {
  if (!pay || !patient || !Array.isArray(payments)) return [];
  const mk = monthKey(pay.dueDate);
  if (!mk) return [];
  /* "Already this patient's" by EITHER half of the link: a row carrying their
   * uid, or one carrying their triple. Checking only the uid would miss every
   * historical row, which is most of them. */
  const belongs = other => !!matchPatientForPayment(other, [patient]);
  return payments.filter(other => other
    && other.id !== pay.id
    && monthKey(other.dueDate) === mk
    && belongs(other));
}

/* THE BACKFILL PLAN (never the write). The rows the server's exact match
 * left blank and the NORMALIZED triple can place without a judgement call —
 * the same rule withPatientUid() applies at write time, read over the whole
 * sheet so the existing rows can be caught up in one go.
 *
 * It deliberately does NOT re-do PR #139's work: a row whose triple is intact
 * is the server's to resolve (on write, and by its own locked backfill), and
 * planning it here would be a second writer racing the first for no gain.
 *
 * Pure: returns [{ payment, patient, via }] and writes nothing. */
function planPatientUidBackfill(payments, patients) {
  if (!Array.isArray(payments)) return [];
  const list = Array.isArray(patients) ? patients : [];
  const out = [];
  payments.forEach(pay => {
    if (!pay || paymentPatientUid(pay)) return;
    const m = matchPatientForPayment(pay, list);
    if (!m || m.via !== 'triple_loose') return;
    const uid = patientUid(m.patient);
    if (!uid) return;
    out.push({ payment: pay, patient: m.patient, via: m.via });
  });
  return out;
}

/* ---- the three writes -----------------------------------------------------
 * All three go through savePayment(), the ONE payment write path — optimistic
 * upsert, rollback and the שמירת גבייה נכשלה toast included — so a link can
 * never be persisted by a route the rest of the app does not know about. Only
 * the link columns move: amount, status, amountPaid, balance and the coverage
 * period ride through untouched, so a reconnection can never move money.
 *
 * linkedBy / linkedAt are never sent. upsertPayment_() stamps them from the
 * signed session cookie and its own clock, because a client that can post a
 * payment can post any name and any date it likes. savePayment() adopts the
 * server's echo, so the decided row shows the real who-and-when without a
 * reload. */

async function reconnectPaymentToPatient(pay, patient) {
  if (state.mode !== 'edit') return;
  const uid = patientUid(patient);
  if (!uid) { showError('למטופל זה אין מזהה קבוע — יש לשמור אותו שוב לפני השיוך'); return; }
  await savePayment(Object.assign({}, pay, {
    linkPatientUid: uid,
    linkStatus: 'linked',
    linkNote: '',
  }));
  renderReconnect();
}

/* "This is not a patient" — a refund, a supplier, a test row, a duplicate.
 * A REASON IS REQUIRED: a row dismissed without one is indistinguishable next
 * year from a row nobody ever looked at, which is the state this whole screen
 * exists to get out of. */
async function markPaymentNotAPatient(pay, note) {
  if (state.mode !== 'edit') return;
  const reason = String(note || '').trim().slice(0, PAYMENT_LINK_NOTE_MAX);
  if (!reason) { showError('יש לציין סיבה לסימון "לא מטופל"'); return; }
  await savePayment(Object.assign({}, pay, {
    linkPatientUid: '',
    linkStatus: 'not_a_patient',
    linkNote: reason,
  }));
  renderReconnect();
}

/* "This row is the same money, entered twice" — the third resolution.
 *
 * IT NEVER DELETES THE ROW. The row keeps its amount, its amountPaid, its due
 * date and its stored triple, and is marked VOID: that record is the only
 * evidence anyone will ever have that the money was entered twice rather than
 * collected twice. What changes is that every revenue, debt and alert figure
 * steps over it (isVoidPayment), and the screen says who decided, when, and
 * against WHICH original.
 *
 * `original` is the surviving payment row — the one attached to the current
 * patient — and it is named in the note so the pair can be reconstructed from
 * the sheet alone, long after this screen has forgotten them. */
function duplicateVoidNote(pay, original, patient) {
  const who = (patient && patient.name) || (original && original.patientName) || '';
  return `כפילות של ${original ? original.id : ''}`
    + (who ? ` (${who}` : '')
    + (original ? `, ${formatDate(original.dueDate)}, ${fmtShekel(original.amount || 0)}` : '')
    + (who ? ')' : '');
}

async function markPaymentDuplicate(pay, original, note) {
  if (state.mode !== 'edit') return;
  if (!canDelete()) { showError(ROLE_FORBIDDEN_TEXT); return; }
  if (!original || !original.id) { showError('אין שורה מקורית לסמן מולה כפילות'); return; }
  if (original.id === pay.id) { showError('לא ניתן לסמן שורה ככפילות של עצמה'); return; }
  const reason = String(note || '').trim().slice(0, PAYMENT_LINK_NOTE_MAX);
  if (!reason) { showError('יש לציין סיבה לסימון ככפילות'); return; }
  await savePayment(Object.assign({}, pay, {
    /* The MONEY columns are untouched — amount, amountPaid, balance and the
     * coverage period all ride through exactly as recorded. Only the status
     * and the decision change. */
    status: PAYMENT_VOID_STATUS,
    linkPatientUid: '',
    linkStatus: 'duplicate',
    linkNote: reason,
  }));
  renderReconnect();
}

/* Undo a void: the row goes back to being an undecided detached payment, and
 * its money re-enters every figure. SANDRA ONLY — see PAYMENT_VOID_REVERSERS.
 * The server refuses anyone else outright; this check only decides whether the
 * control is offered.
 *
 * The restored status is DERIVED from the amounts the row still carries, which
 * is exact precisely because voiding never touched them. */
function statusFromAmounts(pay) {
  const amount = Number(pay && pay.amount) || 0;
  const paid = Number(pay && pay.amountPaid) || 0;
  if (paid <= 0) return 'unpaid';
  return paid >= amount ? 'paid' : 'partial';
}

async function reversePaymentVoid(pay) {
  if (state.mode !== 'edit') return;
  if (!canReverseVoid()) { showError(ROLE_FORBIDDEN_TEXT); return; }
  await savePayment(Object.assign({}, pay, {
    status: statusFromAmounts(pay),
    linkPatientUid: '',
    linkStatus: '',
    linkNote: '',
  }));
  renderReconnect();
}

/* The backfill (PR 2C). Writes a uid ONLY where the triple names exactly one
 * current patient — planPatientUidBackfill() is the rule, and it is pure.
 *
 * ON DEMAND, never on load. A write that runs by itself when a screen opens is
 * a write nobody chose, and this one touches every historical payment row. The
 * button says how many rows it will change before it changes them. */
async function runPatientUidBackfill() {
  if (state.mode !== 'edit') return;
  const plan = planPatientUidBackfill(state.payments, state.patients);
  if (!plan.length) { showError('אין שורות להשלמה — כל השורות כבר משויכות או דורשות הכרעה'); return; }
  let done = 0;
  for (const item of plan) {
    /* Sequential on purpose: savePayment() is an optimistic upsert into a
     * shared array, and a parallel storm would race its own rollbacks. */
    // eslint-disable-next-line no-await-in-loop
    await savePayment(Object.assign({}, item.payment, {
      linkPatientUid: patientUid(item.patient),
      linkStatus: 'linked',
    }));
    done += 1;
  }
  showToast(`הושלם שיוך ל־${done} שורות תשלום`);
  renderReconnect();
}

/* ---- the screen ---------------------------------------------------------- */

function renderReconnect() {
  if (!financeView()) return; // restricted view: no billing UI at all
  const list = document.getElementById('reconnect-list');
  if (!list) return;
  const rows = detachedPayments(state.payments, state.patients);
  const plan = planPatientUidBackfill(state.payments, state.patients);

  const countEl = document.getElementById('reconnect-count');
  if (countEl) countEl.textContent = rows.length;
  /* The nav badge: detached money is not something to go looking for. Hidden
   * at zero, like the meetings badge. */
  const badge = document.getElementById('reconnect-badge');
  if (badge) {
    badge.textContent = rows.length;
    badge.classList.toggle('hidden', !rows.length);
  }
  const linkedEl = document.getElementById('reconnect-linked-count');
  if (linkedEl) {
    linkedEl.textContent = state.payments.filter(p => p && paymentPatientUid(p)).length;
  }
  const backfillEl = document.getElementById('reconnect-backfill');
  if (backfillEl) {
    backfillEl.textContent = plan.length
      ? `השלמת שיוך ל־${plan.length} שורות חד־משמעיות`
      : 'אין שורות חד־משמעיות להשלמה';
    backfillEl.disabled = !plan.length || state.mode !== 'edit';
    backfillEl.onclick = e => busyButton(e.currentTarget, 'save', () => runPatientUidBackfill());
  }

  list.innerHTML = '';
  if (!rows.length) {
    list.innerHTML = '<div class="card billing-empty">כל התשלומים משויכים למטופל</div>';
  } else {
    rows.forEach(pay => list.appendChild(buildReconnectRow(pay)));
  }

  /* The decisions already taken. Shown — not archived out of sight — because
   * "who decided this, and when" is the half of an audit trail a person can
   * actually act on, and a row marked "not a patient" by mistake would
   * otherwise be unreachable. */
  const decidedRow = (pay, extraClass) => {
    const el = document.createElement('div');
    el.className = 'card reconnect-row decided' + (extraClass ? ' ' + extraClass : '');
    el.innerHTML = `
      <div class="reconnect-head">
        <span class="p-name">${escapeHtml(String(pay.patientName || '')) || '<i>ללא שם</i>'}</span>
        <span class="rev-chip">${escapeHtml(formatDate(pay.dueDate))}</span>
        <span class="rev-chip">${escapeHtml(fmtShekel(pay.amount || 0))}</span>
        ${pay.amountPaid ? `<span class="rev-chip">שולם ${escapeHtml(fmtShekel(pay.amountPaid))}</span>` : ''}
      </div>
      <div class="reconnect-note-shown">${escapeHtml(pay.linkNote || '')}</div>
      <div class="reconnect-id">${escapeHtml(pay.linkedBy || '—')} · ${escapeHtml(formatDate(pay.linkedAt) || '—')}</div>
    `;
    return el;
  };

  const notPatient = state.payments.filter(p => p && p.linkStatus === 'not_a_patient');
  if (notPatient.length) {
    const head = document.createElement('div');
    head.className = 'rev-detail-head';
    head.innerHTML = `<span>סומנו כ"לא מטופל"</span><span>${notPatient.length}</span>`;
    list.appendChild(head);
    notPatient.forEach(pay => {
      const el = decidedRow(pay);
      const btn = document.createElement('button');
      btn.className = 'btn small reconnect-undo';
      btn.textContent = 'החזרה לבדיקה';
      btn.disabled = state.mode !== 'edit';
      btn.onclick = e => busyButton(e.currentTarget, 'save', async () => {
        await savePayment(Object.assign({}, pay, {
          linkPatientUid: '', linkStatus: '', linkNote: '',
        }));
        renderReconnect();
      });
      el.appendChild(btn);
      list.appendChild(el);
    });
  }

  /* The voided duplicates. Kept on screen for the same reason the row is kept
   * on the sheet: a decision nobody can see again is a decision nobody can
   * check. Undoing one is SANDRA'S ALONE — it puts a second payment back into
   * the revenue and debt figures — so everyone else is told whom to ask
   * instead of being handed a button that will be refused. */
  const voided = state.payments.filter(p => p && isVoidPayment(p));
  if (voided.length) {
    const head = document.createElement('div');
    head.className = 'rev-detail-head';
    head.innerHTML = `<span>סומנו ככפילות (${escapeHtml(PAYMENT_VOID_LABEL)})</span><span>${voided.length}</span>`;
    list.appendChild(head);
    voided.forEach(pay => {
      const el = decidedRow(pay, 'voided');
      if (canReverseVoid()) {
        const btn = document.createElement('button');
        btn.className = 'btn small reconnect-unvoid';
        btn.setAttribute('data-role', 'approver');
        btn.textContent = 'ביטול סימון הכפילות';
        btn.disabled = state.mode !== 'edit';
        btn.onclick = e => busyButton(e.currentTarget, 'save', () => reversePaymentVoid(pay));
        el.appendChild(btn);
      } else {
        const note = document.createElement('div');
        note.className = 'reconnect-locked';
        note.textContent = 'לביטול הסימון — פנו לסנדרה';
        el.appendChild(note);
      }
      list.appendChild(el);
    });
  }
}

/* One payment, rendered as the sheet holds it — for the side-by-side panel.
 * Verbatim on purpose: a trailing space or an invisible character in the name
 * is the whole reason the pair exists, and the comparison is worthless if the
 * two sides are prettied up into looking identical. */
function duplicatePanelHtml(pay, title, cls) {
  const house = houseById(pay.houseId);
  const rows = [
    ['שם כפי שנרשם', String(pay.patientName || '') || '—'],
    ['בית', (house && house.name) || pay.houseId || '—'],
    ['תאריך לתשלום', formatDate(pay.dueDate)],
    ['סכום', fmtShekel(pay.amount || 0)],
    ['שולם בפועל', fmtShekel(pay.amountPaid || 0)],
    ['סטטוס', (PAYMENT_STATUS.find(x => x.id === pay.status) || {}).label || pay.status || '—'],
  ];
  return `<div class="dup-panel ${cls}">
    <div class="dup-panel-title">${escapeHtml(title)}</div>
    ${rows.map(([k, v]) =>
      `<div class="dup-field"><span class="dup-k">${escapeHtml(k)}</span>`
      + `<span class="dup-v">${escapeHtml(String(v))}</span></div>`).join('')}
    <div class="dup-field"><span class="dup-k">מזהה שורה</span>
      <span class="dup-v mono" dir="ltr">${escapeHtml(pay.id || '—')}</span></div>
    <div class="dup-field"><span class="dup-k">שיוך מאוחסן</span>
      <span class="dup-v mono" dir="ltr">${escapeHtml(pay.patientId || '—')}</span></div>
  </div>`;
}

/* CONFIRM BEFORE VOIDING, with both rows on screen at once.
 *
 * The two payments are shown SIDE BY SIDE, field for field, because the only
 * way to tell a duplicate from two genuine payments in the same month is to
 * read them against each other — same amount, same due date, same house, a
 * name that differs. Voiding on the strength of a warning chip alone is how
 * real money disappears from a month's revenue. */
function showDuplicateConfirm({ pay, original, patient, onConfirm }) {
  const back = document.createElement('div');
  back.className = 'modal-backdrop';
  const sameAmount = Number(pay.amount || 0) === Number(original.amount || 0);
  const sameMonth = monthKey(pay.dueDate) === monthKey(original.dueDate);
  back.innerHTML = `
    <div class="modal dup-modal">
      <h3>סימון כפילות</h3>
      <p class="dup-lead">השורה הימנית תסומן <b>${escapeHtml(PAYMENT_VOID_LABEL)}</b> — היא נשמרת בגיליון
        כרישום, ואינה נספרת בשום חישוב הכנסה, חוב או התראה. <b>שום שורה אינה נמחקת.</b></p>
      <div class="dup-compare">
        ${duplicatePanelHtml(pay, 'תסומן ככפילות', 'dup-void')}
        ${duplicatePanelHtml(original, 'המקור שנשאר', 'dup-keep')}
      </div>
      <div class="dup-flags">
        <span class="rev-chip ${sameAmount ? 'rev-chip-soft' : 'dup-flag-warn'}">
          ${sameAmount ? 'אותו סכום' : 'סכומים שונים — לבדוק'}</span>
        <span class="rev-chip ${sameMonth ? 'rev-chip-soft' : 'dup-flag-warn'}">
          ${sameMonth ? 'אותו מחזור' : 'מחזורים שונים — לבדוק'}</span>
      </div>
      <div class="form-row">
        <label>סיבה (נשמרת ביומן)</label>
        <input type="text" class="dup-note" maxlength="${PAYMENT_LINK_NOTE_MAX}" />
      </div>
      <div class="form-actions">
        <button type="button" class="btn" data-action="cancel">ביטול</button>
        <button type="button" class="btn primary" data-action="confirm">סמן ככפילות</button>
      </div>
    </div>`;
  const noteEl = back.querySelector('.dup-note');
  noteEl.value = duplicateVoidNote(pay, original, patient);
  const close = () => back.remove();
  back.querySelector('[data-action="cancel"]').onclick = close;
  back.onclick = e => { if (e.target === back) close(); };
  back.querySelector('[data-action="confirm"]').onclick = e =>
    busyButton(e.currentTarget, 'save', async () => {
      await onConfirm(noteEl.value);
      close();
    });
  document.body.appendChild(back);
  if (noteEl.focus) noteEl.focus();
}

function buildReconnectRow(pay) {
  const el = document.createElement('div');
  el.className = 'card reconnect-row';
  const house = houseById(pay.houseId);
  const candidates = reconnectCandidates(pay, state.patients).slice(0, 5);
  const editable = state.mode === 'edit';

  /* The row as the SHEET holds it — name verbatim, so a trailing space or an
   * invisible character is visible rather than merely implied. */
  const rawName = String(pay.patientName || '');
  const odd = rawName !== trimName(rawName) || NAME_INVISIBLES.test(rawName);
  NAME_INVISIBLES.lastIndex = 0;   // the regex is /g; leaving lastIndex set would flip the next test

  el.innerHTML = `
    <div class="reconnect-head">
      <span class="p-name">${escapeHtml(rawName) || '<i>ללא שם</i>'}</span>
      ${odd ? '<span class="badge warn" title="השם מכיל רווח מיותר או תו בלתי נראה — זו הסיבה שהשורה התנתקה">תו חריג בשם</span>' : ''}
      <span class="rev-chip">${escapeHtml(house ? house.name : (pay.houseId || 'ללא בית'))}</span>
      <span class="rev-chip">${escapeHtml(formatDate(pay.dueDate))}</span>
      <span class="rev-chip">${escapeHtml(fmtShekel(pay.amount || 0))}</span>
      ${pay.amountPaid ? `<span class="rev-chip">שולם ${escapeHtml(fmtShekel(pay.amountPaid))}</span>` : ''}
    </div>
    <div class="reconnect-id" dir="ltr">${escapeHtml(pay.patientId || '—')}</div>
    <div class="reconnect-cands"></div>
    <div class="reconnect-dismiss">
      <input class="reconnect-note" type="text" maxlength="${PAYMENT_LINK_NOTE_MAX}"
             placeholder="סיבה — למה זו אינה שורת מטופל" ${editable ? '' : 'disabled'} />
      <button class="btn small reconnect-not-patient" ${editable ? '' : 'disabled'}>לא מטופל</button>
    </div>
  `;

  const cands = el.querySelector('.reconnect-cands');
  if (!candidates.length) {
    cands.innerHTML = '<div class="reconnect-empty">לא נמצאו מועמדים — יש לבדוק ידנית</div>';
  }
  candidates.forEach(c => {
    const dup = reconnectDoubleEntry(pay, c.patient, state.payments);
    const line = document.createElement('div');
    line.className = 'reconnect-cand' + (dup.length ? ' has-dup' : '');
    line.innerHTML = `
      <span class="cand-name">${escapeHtml(c.patient.name || '')}</span>
      <span class="cand-meta">${escapeHtml((houseById(c.patient.houseId) || {}).name || c.patient.houseId || '')}
        · כניסה ${escapeHtml(formatDate(c.patient.date))}</span>
      <span class="cand-why">${c.reasons.map(r =>
        `<span class="rev-chip rev-chip-soft">${escapeHtml(RECONNECT_REASON_LABELS[r] || r)}</span>`).join('')}</span>
      ${dup.length ? `<span class="cand-warn" title="${escapeHtml(dup.map(d => formatDate(d.dueDate)).join(', '))}">⚠ ייתכן רישום כפול — כבר קיים תשלום לאותו מחזור</span>` : ''}
      ${dup.length && canDelete() ? `<button class="btn small primary cand-dup" data-role="deleter" ${editable ? '' : 'disabled'}>כפילות</button>` : ''}
      <button class="btn small ${dup.length && canDelete() ? '' : 'primary'} cand-link" ${editable ? '' : 'disabled'}>שייך</button>
    `;
    /* WHERE THE WARNING IS, THE WARNING LEADS. A candidate that already has a
     * payment for this cycle is far more often a double entry than a second
     * real payment, so כפילות becomes the primary action and שייך steps down
     * to secondary — offered, never removed, because the pair CAN be a rename
     * whose first row was simply never linked. Only a person knows which, and
     * the side-by-side confirm is where they find out. */
    line.querySelector('.cand-link').onclick = e =>
      busyButton(e.currentTarget, 'save', () => reconnectPaymentToPatient(pay, c.patient));
    const dupBtn = line.querySelector('.cand-dup');
    if (dupBtn) {
      dupBtn.onclick = () => showDuplicateConfirm({
        pay, original: dup[0], patient: c.patient,
        onConfirm: note => markPaymentDuplicate(pay, dup[0], note),
      });
    }
    cands.appendChild(line);
  });

  el.querySelector('.reconnect-not-patient').onclick = e =>
    busyButton(e.currentTarget, 'save', () =>
      markPaymentNotAPatient(pay, el.querySelector('.reconnect-note').value));
  return el;
}

const RECONNECT_REASON_LABELS = {
  uid: 'מזהה קבוע תואם',
  same_house: 'אותו בית',
  name: 'שם דומה',
  entry_date: 'תאריך כניסה ±יום',
  in_house: 'שהה בבית באותו תאריך',
};

/* Billing-tab search: same matching semantics as the discharged-tab search —
 * dischargedPatientMatchesQuery is the shared core (name + house label by
 * lowercased substring, phone by raw substring OR normalized digits via
 * normalizePhone). A billing row's identity is split across the patient (which
 * may be findPatientForPayment's fallback pseudo-patient) and the payment
 * record, so both are consulted for name/house. House label resolution mirrors
 * buildBillingRow exactly, so what the row displays is what matches. Patients
 * carry no phone in the schema today; the phone leg is defensive and matches
 * whenever a phone field is present. Pure + exported for tests. */
function billingRowMatchesQuery(patient, payment, q) {
  if (!q) return true;
  const name  = (patient && patient.name) || (payment && payment.patientName) || '';
  const phone = (patient && patient.phone) || (payment && payment.phone) || '';
  const house = houseById(payment && payment.houseId) || houseById(patient && patient.houseId);
  const houseLabel = house ? house.name : ((patient && patient.houseId) || '');
  return dischargedPatientMatchesQuery({ name, phone }, q, houseLabel);
}

function renderBilling() {
  if (!billingTabView()) return; // restricted view: no billing UI at all
  const selected = state.billingDate || todayISO();
  const billingDateEl = document.getElementById('billing-date');
  if (billingDateEl && billingDateEl.value !== selected) billingDateEl.value = selected;

  // A patient pro-bono on the selected date owes nothing: not listed.
  const dueAll = patientsDueOn(selected).filter(p => !isProbonoOn(p, selected)).map(p => ({
    patient: p,
    payment: paymentForPatientOnDate(p, selected),
  }));

  /* Live search (name / phone / house). The KPI cards recompute from the
   * FILTERED due list — same "counts match what the list shows" rule as the
   * discharged tab — so while searching they read as the subset's totals. */
  const q = state.billingSearch;
  const funderFilter = billingFunderFilter();
  const due = dueAll.filter(d => billingRowMatchesQuery(d.patient, d.payment, q)
    && funderFilterMatch(funderFilter, billingRowFunderKey(d.patient, selected)));

  /* KPI totals sum the payment records' EFFECTIVE amounts (override-aware via
   * paymentForPatientOnDate) — previously totalDue summed the base pay
   * directly, which would have ignored per-month overrides.
   *
   * סך לגבייה is a DEBT figure, so a cycle before the records cutoff is left
   * out of it: nobody entered payments here before RECORDS_COMPLETE_FROM, and
   * counting those cycles as owed invents debt that was in fact collected and
   * recorded elsewhere. The rows are still listed and still counted — they are
   * real cycles — and a note under the cards says how many were excluded, so
   * the difference between the list and the total is stated rather than left
   * to be discovered.
   *
   * נגבה is NOT filtered: an amountPaid on a row is money somebody recorded,
   * and money that arrived is money whatever the cutoff says about forecasts. */
  const preRecordsDue  = due.filter(d => isPreRecordsCycle(selected) && !isVoidPayment(d.payment));
  /* VOID rows count toward nothing. They are still LISTED — the row carries a
   * מבוטל badge — because a duplicate that vanishes from every screen is
   * indistinguishable from one that was deleted, and deleting is exactly what
   * this feature refuses to do. */
  const countableDue   = due.filter(d => !isPreRecordsCycle(selected) && !isVoidPayment(d.payment));
  const totalDue       = countableDue.reduce((s, d) => s + (d.payment.amount || 0), 0);
  const totalCollected = due.filter(d => !isVoidPayment(d.payment))
    .reduce((s, d) => s + (d.payment.amountPaid || 0), 0);

  document.getElementById('bill-due-count').textContent    = due.length;
  document.getElementById('bill-due-total').textContent    = '₪ ' + totalDue.toLocaleString('he-IL');
  document.getElementById('bill-due-collected').textContent = '₪ ' + totalCollected.toLocaleString('he-IL');
  renderPreRecordsNote(preRecordsDue.length);

  renderBillingDueList(due, selected, dueAll.length);
  renderBillingOpenList(selected);
  renderBillingMonthlySummary(selected);
  renderFunderFill();
}

/* Says, under the גבייה KPI cards, that N cycles on this date predate the
 * records cutoff and are therefore not in סך לגבייה. Built by the renderer
 * (no static markup to drift), hidden at zero, and it names the date so the
 * rule is legible rather than magic. */
function renderPreRecordsNote(count) {
  const cards = document.getElementById('bill-due-total');
  const host = cards && cards.closest ? cards.closest('.cards-row') : null;
  if (!host || !host.parentNode) return;
  let el = document.getElementById('bill-pre-records-note');
  if (!count) { if (el) el.remove(); return; }
  if (!el) {
    el = document.createElement('div');
    el.id = 'bill-pre-records-note';
    el.className = 'rev-basis-note pre-records-note';
    host.parentNode.insertBefore(el, host.nextSibling);
  }
  el.innerHTML = `<b>לפני תחילת הרישום</b> — ${count} ${count === 1 ? 'מחזור' : 'מחזורים'} `
    + `בתאריך זה קודמים ל־${escapeHtml(formatDate(RECORDS_COMPLETE_FROM))}, `
    + `המועד שממנו רישום התשלומים במערכת מלא. הם מוצגים אך אינם נספרים כחוב.`;
}

function renderBillingDueList(due, selectedISO, unfilteredCount) {
  const list = document.getElementById('billing-due-list');
  list.innerHTML = '';
  if (!due.length) {
    /* Rows exist but the search filtered them all → "no results"; genuinely
     * nothing due on this date → the original empty message. */
    const msg = unfilteredCount ? 'לא נמצאו תוצאות' : 'אין תשלומים לגבייה בתאריך זה';
    list.innerHTML = `<div class="card billing-empty">${msg}</div>`;
    return;
  }
  due.forEach(({ patient, payment }) => {
    list.appendChild(buildBillingRow(patient, payment, selectedISO, false));
  });
}

function renderBillingOpenList(selectedISO) {
  const list = document.getElementById('billing-open-list');
  list.innerHTML = '';
  const openAll = state.payments
    /* isVoidPayment is redundant beside the status whitelist and kept anyway:
     * this is a DEBT list, and the whitelist is one refactor away from being
     * "not paid" instead of "unpaid or partial". */
    .filter(p => !isVoidPayment(p)
      && (p.status === 'unpaid' || p.status === 'partial') && p.dueDate && p.dueDate < selectedISO)
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate))
    .map(rawPay => {
      // Carry-forward rows read straight from state.payments — overlay the
      // per-month override here too so a past unpaid month edited by Sandra
      // shows (and balances at) its effective amount.
      const pay = applyBillingOverride(rawPay, state.billingOverrides);
      const patient = findPatientForPayment(pay) || {
        name: pay.patientName,
        houseId: pay.houseId,
        pay: pay.amount,
        date: '',
        status: '',
      };
      return { patient, pay };
    })
    // Pro-bono on the row's due date: not a balance (never owed).
    .filter(o => !isProbonoOn(o.patient, o.pay.dueDate));

  const funderFilter = billingFunderFilter();
  const matched = openAll.filter(o => billingRowMatchesQuery(o.patient, o.pay, state.billingSearch)
    && funderFilterMatch(funderFilter, billingRowFunderKey(o.patient, o.pay.dueDate)));
  /* Cycles before the records cutoff are not debt (see RECORDS_COMPLETE_FROM).
   * They are still LISTED — under their own heading, after the real balances —
   * because a cycle that vanishes from every screen is indistinguishable from
   * one that was never there. Nothing above this line sums them. */
  const open = matched.filter(o => !isPreRecordsCycle(o.pay.dueDate));
  const pre  = matched.filter(o => isPreRecordsCycle(o.pay.dueDate));

  if (!open.length && !pre.length) {
    const msg = openAll.length ? 'לא נמצאו תוצאות' : 'אין יתרות פתוחות מתאריכים קודמים';
    list.innerHTML = `<div class="card billing-empty">${msg}</div>`;
    return;
  }
  open.forEach(({ patient, pay }) => {
    list.appendChild(buildBillingRow(patient, pay, pay.dueDate, true));
  });
  if (pre.length) {
    const head = document.createElement('div');
    head.className = 'rev-detail-head pre-records-head';
    head.innerHTML = `<span>לפני תחילת הרישום — אינו נספר כחוב</span>`
      + `<span>עד ${escapeHtml(formatDate(RECORDS_COMPLETE_FROM))}</span>`;
    list.appendChild(head);
    pre.forEach(({ patient, pay }) => {
      list.appendChild(buildBillingRow(patient, pay, pay.dueDate, true));
    });
  }
}

/* The month split, rendered. THE KEY FACT ON THE ROW: a payment is one number
 * but it almost never buys one calendar month, and until now the row said
 * nothing about where the money actually lands — you had to open
 * הכנסות חודשיות to find out. Now it is stated where the decision is made.
 *
 * `currentKey` is the month the גבייה screen is showing. That month is the
 * money you are looking at; every other month in the window is revenue this
 * row DEFERS, and is dimmed and marked so it reads that way at a glance. When
 * a recorded period sits entirely outside the selected month, every line reads
 * deferred — which is the honest answer, and the מותאמת badge above already
 * says why.
 *
 * A single-month window renders ONE line: there is no division to show, and a
 * split with one row in it would imply there was.
 *
 * Figures are VAT-inclusive, matching the סכום חודשי directly above them. */
function coverageSplitHtml(amount, win, currentKey) {
  const parts = coverageMonthSplit(amount, win);
  if (!parts.length) return '';
  return parts.map(p => {
    const deferred = p.key !== currentKey;
    return `<span class="cov-split-line${deferred ? ' deferred' : ''}"${
      deferred ? ' title="נדחה לחודש אחר — הכנסה שאינה שייכת לחודש המוצג"' : ''}>
      <span class="cov-split-month">${escapeHtml(p.label)}</span>
      <span class="cov-split-sep">·</span>
      <span class="cov-split-days">${p.days} ימים</span>
      <span class="cov-split-sep">·</span>
      <span class="cov-split-amount">₪ ${p.amount.toLocaleString('he-IL')}</span>
    </span>`;
  }).join('');
}

function buildBillingRow(patient, payment, dueDateISO, isCarryForward) {
  const house = houseById(payment.houseId) || houseById(patient.houseId);
  const houseName = house ? house.name : (patient.houseId || '');
  const amount = payment.amount || patient.pay || 0;

  const row = document.createElement('div');
  /* Overdue highlight: an unpaid current-list row whose due date has arrived.
   * Carry-forward rows keep their existing amber treatment (same warning
   * language) and are skipped here. */
  /* Institutional funder (ביטוח לאומי / מכבי / משרד הביטחון) within 30 days
   * of the due date: «ממתין לגורם מממן», grey — not overdue, not amber.
   * The amount still counts in every total (CHANGELOG-funder-grace.md). */
  const inFunderGrace = !isVoidPayment(payment) && payment.status !== 'paid'
    && isoDate(dueDateISO) <= todayISO() && isInFunderGraceOn(patient, dueDateISO);
  const isOverdue = !isCarryForward && !inFunderGrace && payment.status === 'unpaid' && dueDateISO <= todayISO();
  /* Two facts about the CYCLE rather than the money, both said on the row
   * instead of silently changing a total somewhere else:
   *   - before the records cutoff → not counted as debt (see
   *     RECORDS_COMPLETE_FROM); the row is still shown, because the cycle was
   *     real even though nobody entered a payment for it here;
   *   - outside the patient's stay → the row should not exist at all. Rows
   *     like this are the residue of the day-of-month-only due list that
   *     patientDueOnDate now replaces: a recorded row is never hidden or
   *     rewritten (it may be money somebody really took), it is FLAGGED so
   *     Sandra can correct it. */
  /* A VOID row is still SHOWN — never deleted, never hidden — and says what
   * it is. It offers no «דווח תשלום»: the way back from a void is the
   * שיוך תשלומים screen, where the decision was taken and where the audit
   * trail lives. */
  const isVoid = isVoidPayment(payment);
  const preRecords = isPreRecordsCycle(dueDateISO);
  const outsideStay = !!(patient && isoDate(patient.date))
    && !patientStayCoversDate(patient, dueDateISO);
  row.className = 'billing-row' + (isCarryForward ? ' carry' : '') + (isOverdue ? ' overdue' : '') + (inFunderGrace ? ' funder-grace' : '');
  row.dataset.pid = payment.id;

  /* Phase 3 PR 2: the row no longer edits money. Its state (שולם / שולם
   * חלקית / לא שולם, or מבוטל) is DERIVED by the server from the receipts
   * that pay it — one Payments row per money received — and the only way to
   * record money is the strict «דווח תשלום» form. A void row offers no form,
   * and neither does a cycle already paid in full (a second report there is
   * almost always the same money twice; voiding a receipt reopens it). */
  const stateLabel = isVoid ? PAYMENT_VOID_LABEL : inFunderGrace ? funderGraceStatusLabel(payment.status) : paymentStatusLabel(payment.status);
  const canReport = state.mode === 'edit' && !isVoid && payment.status !== 'paid' && financeView();

  /* Per-month amount override (this row's OWN due-date month — for a
   * carry-forward row that is the record's original month, so an edit there
   * targets that month, never the selected one). The badge marks an active
   * override; the pencil opens the inline editor. Editable when:
   *   - edit mode, and the row is not paid/partial history, and
   *   - the row's patient is REALLY matched (patientKey === payment.patientId).
   *     Carry rows for an orphaned payment (patient released/renamed — the
   *     findPatientForPayment fallback pseudo-patient) must not offer the
   *     editor: the override it would write would key on a patientId that the
   *     record doesn't carry, so it could never overlay this row. */
  const hasOverride =
    !!billingOverrideFor(state.billingOverrides, payment.patientId, monthKey(dueDateISO));
  /* Due-list rows are matched BY CONSTRUCTION — the payment was looked up (or
   * built) from an id derived from THIS patient, so the strict key equality is
   * redundant there and, worse, broke on live records whose patientId cell was
   * blank (now healed in normalizePayment, kept as belt-and-suspenders). Carry
   * rows keep the equality guard so true orphans get no editor. */
  const patientMatched = !isCarryForward || patientKey(patient) === payment.patientId;
  const amountEditable = state.mode === 'edit' &&
    payment.status !== 'paid' && payment.status !== 'partial' &&
    patientMatched;
  /* Carry rows fold the original due date into the label line so the amount —
   * override-aware, same as due rows — can occupy the value line with its
   * editor. Due rows keep the plain סכום חודשי label. */
  const amountCellLabel = isCarryForward
    ? `תאריך מקורי · ${escapeHtml(formatDate(dueDateISO))}`
    : 'סכום חודשי';
  /* ---- תקופת כיסוי (the recorded coverage period) -------------------
   * WHERE IT LIVES: its own cell on the row, right after the amount — the
   * two facts a recorder decides together ("how much, for what period") sit
   * side by side, and the row already carries the due date, so the period
   * reads as a refinement of it rather than a new concept elsewhere.
   *
   * WHEN IT IS EDITABLE: edit mode, and the payment row actually EXISTS in
   * the sheet. That second condition is deliberate and differs from the
   * amount editor, twice over:
   *   - Paid and partial rows ARE editable here. The amount override is
   *     refused on them because it would rewrite settled money; the period
   *     is the opposite — a payment already taken is exactly the one whose
   *     period must be correctable, since that is the row the revenue screen
   *     allocates.
   *   - A due-list row that has never been saved is NOT editable. Its
   *     payment is an in-memory placeholder (paymentForPatientOnDate), so
   *     writing a period would conjure an unpaid Payments row that does not
   *     exist today. Record the payment first, then adjust its period.
   * No patientMatched guard is needed: unlike an override, these columns
   * live ON the payment row and are keyed by payment.id, so an orphaned
   * carry row can still say what its own money covered. */
  const paymentPersisted = state.payments.some(x => x && x.id === payment.id);
  const coverageEditable = state.mode === 'edit' && paymentPersisted;
  const cov = paymentCoverage(payment);
  const covStart = cov ? isoFromLocalDate(cov.start) : '';
  const covEnd   = cov ? isoFromLocalDate(cov.end) : '';
  const covAdjusted = coverageDiffersFromDefault(payment);
  /* Display only. covStart/covEnd stay ISO below — they are the two
   * <input type="date"> values and what saveCoveragePeriod persists. */
  const covHtml = cov ? dateRangeHeHtml(covStart, covEnd) : '—';
  /* The month the גבייה screen is currently showing. Everything else in the
   * split is money this row defers to another month, and reads as such. */
  const covCurrentKey = monthKey(state.billingDate || todayISO());
  const coverageCellHtml = `
      <span class="p-val bill-cov-view">${covHtml}
        ${covAdjusted ? '<span class="badge override" title="תקופה שנרשמה ידנית, שונה ממחזור החיוב הרגיל">מותאמת</span>' : ''}
        ${coverageEditable ? '<button class="bill-cov-edit-btn" title="עריכת תקופת הכיסוי של תשלום זה">✏️</button>' : ''}
        ${coverageEditable && covAdjusted ? '<button class="bill-cov-reset-btn" title="חזרה למחזור החיוב הרגיל">↩</button>' : ''}
      </span>
      ${coverageEditable ? `<span class="bill-cov-edit hidden">
        <input class="bill-cov-start" type="date" value="${escapeHtml(covStart)}" />
        <input class="bill-cov-end" type="date" value="${escapeHtml(covEnd)}" />
        <button class="btn small primary bill-cov-save">שמור</button>
        <button class="btn small bill-cov-cancel">ביטול</button>
      </span>` : ''}
      <span class="bill-cov-split">${coverageSplitHtml(amount, cov, covCurrentKey)}</span>`;

  const amountCellHtml = `
      <span class="p-val bill-amount-view">₪ ${amount.toLocaleString('he-IL')}
        ${hasOverride ? '<span class="badge override" title="סכום מותאם לחודש זה">מותאם</span>' : ''}
        ${amountEditable ? '<button class="bill-amount-edit-btn" title="עריכת הסכום לחודש זה בלבד">✏️</button>' : ''}
        ${amountEditable && hasOverride && canDelete() ? '<button class="bill-amount-clear-btn" data-role="deleter" title="ביטול ההתאמה — חזרה לסכום הבסיס">↩</button>' : ''}
      </span>
      ${amountEditable ? `<span class="bill-amount-edit hidden">
        <input class="bill-amount-input" type="number" min="0" step="50" value="${amount}" />
        <button class="btn small primary bill-amount-save">שמור</button>
        <button class="btn small bill-amount-cancel">ביטול</button>
      </span>` : ''}`;

  row.innerHTML = `
    <div>
      <span class="p-label">מטופל</span>
      <span class="p-name">${escapeHtml(patient.name || payment.patientName)}</span>
      ${preRecords ? `<span class="badge pre-records" title="מחזור שקדם ל־${escapeHtml(formatDate(RECORDS_COMPLETE_FROM))} — רישום התשלומים במערכת אינו מלא לפני מועד זה, ולכן אינו נספר כחוב">לפני תחילת הרישום</span>` : ''}
      ${isVoid ? `<span class="badge void" title="שורה שסומנה ככפילות — נשמרת כרישום, ואינה נספרת בשום חישוב הכנסה, חוב או התראה">${escapeHtml(PAYMENT_VOID_LABEL)}</span>` : ''}
      ${outsideStay ? `<span class="badge warn" title="תאריך החיוב אינו בתוך תקופת השהות של המטופל (כניסה ${escapeHtml(formatDate(isoDate(patient.date)))}${patientExitISO(patient) ? ', שחרור ' + escapeHtml(formatDate(patientExitISO(patient))) : ''})">מחוץ לתקופת השהות</span>` : ''}
    </div>
    <div>
      <span class="p-label">בית</span>
      <span class="p-val">${escapeHtml(houseName)}</span>
    </div>
    <div class="bill-amount-cell">
      <span class="p-label">${amountCellLabel}</span>
      ${amountCellHtml}
    </div>
    <div class="bill-cov-cell">
      <span class="p-label">תקופת כיסוי</span>
      ${coverageCellHtml}
    </div>
    <div>
      <span class="p-label">סטטוס</span>
      <span class="badge pay-state pay-state-${escapeHtml(isVoid ? PAYMENT_VOID_STATUS : inFunderGrace ? 'funder_grace' : payment.status)}">${escapeHtml(stateLabel)}</span>
    </div>
    <div>
      <span class="p-label">שולם</span>
      <span class="p-val billing-paid-total">₪ ${(payment.amountPaid || 0).toLocaleString('he-IL')}</span>
    </div>
    <div>
      <span class="p-label">יתרה</span>
      <span class="p-val billing-balance">₪ ${(payment.balance || 0).toLocaleString('he-IL')}</span>
    </div>
    <div class="bill-report-cell">
      ${canReport ? '<button type="button" class="btn small primary bill-report-btn">דווח תשלום</button>' : ''}
    </div>
    ${receiptsListHtml(payment.id)}
  `;

  const reportBtn = row.querySelector('.bill-report-btn');
  if (reportBtn) reportBtn.onclick = () => openPaymentReportModal(patient, payment, dueDateISO);
  wireReceiptVoidButtons(row);

  /* Per-month amount editor wiring (present only when amountEditable). The
   * save/clear workers are optimistic — their renderBilling() rebuilds this
   * row with the new amount + badge, which IS the visual feedback;
   * busyButton guards double-fire until the rebuild lands. */
  const amountEditBtn = row.querySelector('.bill-amount-edit-btn');
  if (amountEditBtn) {
    const view     = row.querySelector('.bill-amount-view');
    const editWrap = row.querySelector('.bill-amount-edit');
    const input    = row.querySelector('.bill-amount-input');
    amountEditBtn.onclick = () => {
      view.classList.add('hidden');
      editWrap.classList.remove('hidden');
      if (input.focus) input.focus();
    };
    row.querySelector('.bill-amount-cancel').onclick = () => {
      editWrap.classList.add('hidden');
      view.classList.remove('hidden');
    };
    row.querySelector('.bill-amount-save').onclick = e =>
      busyButton(e.currentTarget, 'save', () => {
        const v = Number(input.value);
        if (!Number.isFinite(v) || v < 0) {
          showError('סכום לא תקין');
          return Promise.resolve();
        }
        return saveBillingOverride(payment, v);
      });
  }
  /* Coverage-period editor wiring (present only when coverageEditable).
   * Writes through savePayment() like every other payment edit — optimistic
   * upsert, rollback + שמירת גבייה נכשלה on failure — so the period
   * cannot be persisted by a path the rest of the app does not know about.
   * Validation is the SHARED coveragePeriodError(); the server re-checks it. */
  const covEditBtn = row.querySelector('.bill-cov-edit-btn');
  if (covEditBtn) {
    const covView  = row.querySelector('.bill-cov-view');
    const covWrap  = row.querySelector('.bill-cov-edit');
    const startIn  = row.querySelector('.bill-cov-start');
    const endIn    = row.querySelector('.bill-cov-end');
    const covSplit = row.querySelector('.bill-cov-split');
    /* Repaint the split from the values CURRENTLY in the two inputs, before
     * anything is saved — the whole point of the split is to answer "what
     * does this period do to my months?" while you are still choosing it.
     *
     * The preview is not a second opinion: it runs the typed pair through
     * withDefaultCoverage() + paymentCoverage(), exactly the pair savePayment()
     * would store and exactly the window every consumer would then read. A
     * blank pair therefore previews the inferred cycle — which is what the
     * ↩ reset writes — rather than an empty split.
     *
     * A half-typed or invalid pair repaints nothing and leaves the last good
     * split on screen: the row must not flash to '—' between two keystrokes,
     * and coveragePeriodError() already owns saying what is wrong. */
    const repaintSplit = () => {
      if (!covSplit) return;
      if (coveragePeriodError(startIn.value, endIn.value)) return;
      const win = paymentCoverage(withDefaultCoverage(Object.assign({}, payment, {
        coverageStart: startIn.value, coverageEnd: endIn.value,
      })));
      covSplit.innerHTML = coverageSplitHtml(amount, win, covCurrentKey);
    };
    startIn.oninput = repaintSplit;
    endIn.oninput = repaintSplit;
    covEditBtn.onclick = () => {
      covView.classList.add('hidden');
      covWrap.classList.remove('hidden');
      if (startIn.focus) startIn.focus();
    };
    row.querySelector('.bill-cov-cancel').onclick = () => {
      covWrap.classList.add('hidden');
      covView.classList.remove('hidden');
      // Discard the half-typed values — reopening must show what is stored.
      startIn.value = covStart;
      endIn.value = covEnd;
      // …and put the split back to the stored period along with them.
      repaintSplit();
    };
    row.querySelector('.bill-cov-save').onclick = e =>
      busyButton(e.currentTarget, 'save', () => saveCoveragePeriod(payment, startIn.value, endIn.value));
  }
  const covResetBtn = row.querySelector('.bill-cov-reset-btn');
  if (covResetBtn) {
    // Back to the billing cycle: clear the stored pair and let savePayment's
    // withDefaultCoverage() re-stamp the inferred window.
    covResetBtn.onclick = e =>
      busyButton(e.currentTarget, 'save', () => saveCoveragePeriod(payment, '', ''));
  }

  const amountClearBtn = row.querySelector('.bill-amount-clear-btn');
  if (amountClearBtn) {
    amountClearBtn.onclick = e =>
      busyButton(e.currentTarget, 'delete', () => clearBillingOverride(payment));
  }

  return row;
}

function renderBillingMonthlySummary(selectedISO) {
  const mk = monthKey(selectedISO);
  document.getElementById('bill-month-label').textContent = formatMonth(selectedISO);

  // Overlay per-month overrides so the outstanding figure + per-house
  // breakdown reflect effective amounts (collected sums amountPaid — the
  // overlay never touches paid/partial history).
  const thisMonth = state.payments
    .filter(p => monthKey(p.dueDate) === mk)
    .map(p => applyBillingOverride(p, state.billingOverrides));
  /* יתרה is a DEBT figure, so it honours the records cutoff exactly as the
   * גבייה KPI card does: a cycle before RECORDS_COMPLETE_FROM is not owed, it
   * is unrecorded. נגבה is untouched — money that was entered arrived,
   * whatever the cutoff says about what was NOT entered. RECORDS_COMPLETE_FROM
   * is a month boundary, so a month is wholly on one side of it; the note
   * below says so when the whole panel is on the earlier side. */
  /* VOID first, and for BOTH figures: a double entry is neither money that
   * arrived nor money that is owed. Unlike the records cutoff — which leaves
   * נגבה alone because a recorded payment did arrive — a void row's amountPaid
   * is the second copy of a sum already counted on its twin. */
  const liveRows = thisMonth.filter(p => !isVoidPayment(p));
  const voidRows = thisMonth.filter(p => isVoidPayment(p));
  const preRecordsRows = liveRows.filter(p => isPreRecordsCycle(p.dueDate));
  const debtRows = liveRows.filter(p => !isPreRecordsCycle(p.dueDate));
  const collected   = liveRows.reduce((s, p) => s + (p.amountPaid || 0), 0);
  const outstanding = debtRows
    .filter(p => p.status !== 'paid')
    .reduce((s, p) => s + (p.balance || 0), 0);

  document.getElementById('bill-month-collected').textContent   = '₪ ' + collected.toLocaleString('he-IL');
  document.getElementById('bill-month-outstanding').textContent = '₪ ' + outstanding.toLocaleString('he-IL');

  const breakdownEl = document.getElementById('bill-month-breakdown');
  breakdownEl.innerHTML = '';
  HOUSES.forEach(h => {
    const rows = liveRows.filter(p => p.houseId === h.id);
    if (!rows.length) return;
    const col = rows.reduce((s, p) => s + (p.amountPaid || 0), 0);
    const out = rows.filter(p => p.status !== 'paid' && !isPreRecordsCycle(p.dueDate))
      .reduce((s, p) => s + (p.balance || 0), 0);
    const line = document.createElement('div');
    line.className = 'bd-line';
    line.innerHTML = `
      <span class="bd-house">${escapeHtml(h.name)}</span>
      <span class="bd-vals">
        <span class="bd-col">נגבה ₪${col.toLocaleString('he-IL')}</span>
        <span class="bd-out">יתרה ₪${out.toLocaleString('he-IL')}</span>
      </span>
    `;
    breakdownEl.appendChild(line);
  });
  if (voidRows.length) {
    const line = document.createElement('div');
    line.className = 'bd-line muted void-line';
    line.innerHTML = `<span class="bd-house">${escapeHtml(PAYMENT_VOID_LABEL)} — כפילויות</span>`
      + `<span class="bd-vals"><span class="rev-count">${voidRows.length} שורות — לא נספרות כלל</span></span>`;
    breakdownEl.appendChild(line);
  }
  if (preRecordsRows.length) {
    const line = document.createElement('div');
    line.className = 'bd-line muted pre-records-line';
    line.innerHTML = `<span class="bd-house">לפני תחילת הרישום `
      + `(${escapeHtml(formatDate(RECORDS_COMPLETE_FROM))})</span>`
      + `<span class="bd-vals"><span class="rev-count">${preRecordsRows.length} שורות — לא נספרות ביתרה</span></span>`;
    breakdownEl.appendChild(line);
  }
  if (!breakdownEl.children.length) {
    breakdownEl.innerHTML = `<div class="bd-line muted">אין רישומי גבייה החודש</div>`;
  }
}

function formatMonth(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return iso || '';
  return d.toLocaleDateString('he-IL', { month: 'long', year: 'numeric' });
}

/* ====================================================
   הכנסות חודשיות — MONTHLY REVENUE ALLOCATION
   ====================================================
   THE QUESTION THIS ANSWERS: "how much revenue belongs to month X" — NOT
   "how much cash arrived during month X". The גבייה tab above answers neither:
   it is a daily worklist ("who is due today"), and its סיכום חודשי panel
   buckets rows by monthKey(dueDate) — the month a cycle STARTED in, not the
   month the money was earned in. A patient billed on the 20th has two thirds
   of every cycle falling in the next month, so that panel is systematically
   wrong about which month owns the revenue.

   This is the SAME CONTRACT as ezone-outpatient's public/monthly-revenue.js
   (PR #109). The two apps' figures are meant to be added together into a
   network total, so the allocation rule, the four figures, the never-blend
   rule and the ex-VAT basis must agree exactly. Divergences forced by this
   repo are marked >>> DIVERGES <<< below and listed in
   CHANGELOG-monthly-revenue.md.

   ALLOCATION — BY COVERAGE WINDOW, DAY BY DAY
   A payment's coverage window is [dueDate, dueDate + 1 month − 1 day] — the
   window paymentCoverage() already computes for credits, REUSED, not copied.
   A window straddling a month boundary contributes to BOTH months, split by
   the number of its days in each:

       ₪3,000 covering 20 Jan – 19 Feb  (31 days)
         → January   12/31 × 3,000 = ₪1,161.29
         → February  19/31 × 3,000 = ₪1,838.71

   monthKey(dueDate) takes NO part in the allocation.

   >>> DIVERGES from #109: there is no payment-date column here at all.
   PAYMENT_COLUMNS is id, patientId, patientName, houseId, dueDate, amount,
   status, amountPaid, balance, timestamp — `timestamp` is the row's write
   time, not when money changed hands. The outpatient app has a real
   paymentDate and shows it in the drill-down (labelled "never moved a
   shekel"). Here there is nothing to show and nothing that could have leaked
   into the maths. The rule is identical; only the reassurance is missing.

   THE FOUR FIGURES
     נגבה בפועל (RECEIVED) — cash collected, allocated by the window above.
     צפוי (EXPECTED)       — contracted money for the month NOT yet in hand.
     זיכויים (CREDITS)     — refunds allocated to the month, as a NEGATIVE.
     נטו (NET)             — received + expected − credits.

   RECEIVED AND EXPECTED ARE NEVER SUMMED INTO ONE FIGURE. One is money, the
   other a forecast; a blended "revenue" number launders the forecast into the
   bank balance. They are separate fields with no combined accessor, separate
   cards coloured apart, and NET is the one place they meet — labelled as the
   projection it is.

   NO DOUBLE COUNTING. Each day of the month is either a paid coverage day or
   a scheduled-but-unbilled day, never both. On a partly-paid row amountPaid
   goes to RECEIVED and the shortfall to EXPECTED over the SAME window with
   the SAME day weights, so the two partition the row's contracted amount
   exactly; a cycle that already has a Payments row is never also projected.

   VAT. `pay`, PRICE_FALLBACKS and every Payments amount are stored
   VAT-INCLUSIVE; displays divide by VAT_RATE. Same basis and same divisor as
   the outpatient app, so a consolidated total is sound. Every bucket carries
   BOTH `.inclVat` (stored, untouched) and `.exVat`.

   Ex-VAT is taken PER ROW at 2dp via revenueExVat() and a bucket total is the
   SUM OF ITS ROWS, so a drill-down always adds up to the figure printed above
   it. >>> DIVERGES from the existing exVat() in this file, which rounds to a
   whole shekel: summing whole-shekel rows drifts from a separately-rounded
   total by up to half a shekel per row. exVat() is left exactly as it is —
   the credits UI depends on it — and this view uses its own 2dp helper.

   PURE. Everything down to buildMonthlyRevenue() takes its inputs as
   arguments and touches no DOM and no `state`; the renderers below are the
   only part that reads either. */

/* Ex-VAT at 2dp, for a figure stored VAT-inclusive. Distinct from exVat()
 * above (whole shekels) so drill-down rows reconcile with their total. */
function revenueExVat(inclVat) {
  return roundMoney((Number(inclVat) || 0) / VAT_RATE);
}

/* Patient statuses that stop billing. 'released' is the only one this repo
 * has; activePatients() applies the same rule for every other view. */
function isBillablePatient(patient) {
  return !!patient && patient.status !== 'released';
}

/* Bucket for a payment or credit whose house cannot be resolved. Never '' —
 * an unlabelled breakdown row reads as a rendering bug. */
const REVENUE_NO_HOUSE = 'ללא בית';

function isMonthKey(v) {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(String(v == null ? '' : v).trim());
}

/* 'YYYY-MM' → { key, start, end, days, startISO, endISO }, or null for
 * anything that is not a month key. Refused, never guessed at. */
function revenueMonthBounds(key) {
  const k = String(key == null ? '' : key).trim();
  if (!isMonthKey(k)) return null;
  const y = Number(k.slice(0, 4));
  const m1 = Number(k.slice(5, 7));
  const days = new Date(y, m1, 0).getDate();      // day 0 of next month
  const start = new Date(y, m1 - 1, 1);
  const end = new Date(y, m1 - 1, days);
  return {
    key: k, start, end, days,
    startISO: isoFromLocalDate(start), endISO: isoFromLocalDate(end),
  };
}
function revenueMonthLabel(key) {
  const b = revenueMonthBounds(key);
  if (!b) return String(key || '');
  return b.start.toLocaleDateString('he-IL', { month: 'long', year: 'numeric' });
}
function revenueShiftMonth(key, n) {
  if (!isMonthKey(key)) return '';
  const d = new Date(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1 + n, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/* Whole days of [winStart, winEnd] falling inside the month. Both ends
 * inclusive; 0 when the window misses the month entirely. */
function revenueOverlapDays(winStart, winEnd, bounds) {
  if (!winStart || !winEnd || !bounds) return 0;
  const from = winStart > bounds.start ? winStart : bounds.start;
  const to   = winEnd   < bounds.end   ? winEnd   : bounds.end;
  if (from > to) return 0;
  return diffWholeDays(from, to) + 1;
}

/* revenueAllocate(amount, win, bounds, effectiveEnd) →
 *   { amount, daysInMonth, windowDays, share }
 *
 * The ONE place a sum is divided between months. A window with no days in the
 * month yields a zero slice, never null, so callers can sum blindly.
 *
 * `effectiveEnd` truncates the window WITHOUT changing the denominator — used
 * when a patient is discharged mid-cycle, so days after the exit earn nothing
 * while the remaining days keep their true daily rate. Shortening the
 * denominator instead would silently RAISE the daily rate and charge the same
 * money for fewer days. */
function revenueAllocate(amount, win, bounds, effectiveEnd) {
  const zero = { amount: 0, daysInMonth: 0, windowDays: 0, share: 0 };
  if (!win || !win.start || !win.end || !bounds) return zero;
  const windowDays = diffWholeDays(win.start, win.end) + 1;
  if (windowDays <= 0) return zero;
  const lastDay = (effectiveEnd && effectiveEnd < win.end) ? effectiveEnd : win.end;
  if (lastDay < win.start) return { amount: 0, daysInMonth: 0, windowDays, share: 0 };
  const inMonth = revenueOverlapDays(win.start, lastDay, bounds);
  if (!inMonth) return { amount: 0, daysInMonth: 0, windowDays, share: 0 };
  const share = inMonth / windowDays;
  return { amount: roundMoney((Number(amount) || 0) * share), daysInMonth: inMonth, windowDays, share };
}

/* Every 'YYYY-MM' key a coverage window touches, in month order. Pure.
 *
 * The 14-iteration bound is a guard, not a limit: coveragePeriodError caps a
 * recorded window at COVERAGE_MAX_DAYS (366) = 13 calendar months at worst, so
 * a longer walk means a pair that reached here corrupted, and a corrupted pair
 * must not spin the render loop. */
function coverageMonthKeys(win) {
  if (!win || !win.start || !win.end || win.end < win.start) return [];
  const keys = [];
  let y = win.start.getFullYear(), m = win.start.getMonth();
  const lastY = win.end.getFullYear(), lastM = win.end.getMonth();
  for (let i = 0; i < 14 && (y < lastY || (y === lastY && m <= lastM)); i++) {
    keys.push(`${y}-${String(m + 1).padStart(2, '0')}`);
    m += 1;
    if (m > 11) { m = 0; y += 1; }
  }
  return keys;
}

/* How ONE payment divides across the calendar months its coverage window
 * touches — the split shown under the period on the גבייה row.
 *
 * IT DIVIDES NOTHING ITSELF. Every slice comes from revenueAllocate() — the
 * same function, the same window, the same per-month bounds that
 * הכנסות חודשיות uses for the identical payment — so the denominator is the
 * WINDOW's own length (not the calendar month's) and the two screens cannot
 * drift: a change to the split rule lands on both at once. The no-fork guard
 * in test/monthly-revenue.test.js names this as the third consumer, and
 * test/coverage-month-split.test.js pins a row's split against the monthly
 * view's allocation for the same payment.
 *
 * WHAT IT DOES ADD is DISPLAY ROUNDING. revenueAllocate rounds each slice to
 * 2dp independently and this row prints whole shekels, so three slices of
 * 9,666.66… would read 9,667 ×3 = 29,001 directly beneath an amount of 29,000.
 * `amount` is therefore the largest-remainder reconciliation of `exact`: floor
 * every slice, then hand the leftover shekels to the largest fractions, ties
 * by month order so a re-render can never move a shekel between months. The
 * slices sum to the payment amount exactly, always.
 *
 * VAT: none applied, deliberately. The גבייה screen is VAT-INCLUSIVE — the
 * ₪29,000 this sits under is — so the split is stated in that same basis.
 * הכנסות חודשיות shows the identical slices ex-VAT through revenueExVat(),
 * one conversion at the edge, which is where it belongs.
 *
 * → [{ key, label, days, windowDays, share, exact, amount }] in month order,
 *   months the window misses dropped; [] when there is no usable window. A
 *   window inside a single month yields ONE part — the caller shows that one
 *   month rather than a split implying a division that did not happen. */
function coverageMonthSplit(amount, win) {
  const parts = [];
  coverageMonthKeys(win).forEach(key => {
    const a = revenueAllocate(amount, win, revenueMonthBounds(key));
    if (!a.daysInMonth) return;
    parts.push({
      key, label: revenueMonthLabel(key), days: a.daysInMonth,
      windowDays: a.windowDays, share: a.share, exact: a.amount,
      amount: Math.floor(a.amount),
    });
  });
  if (!parts.length) return parts;

  let residual = Math.round(Number(amount) || 0) - parts.reduce((s, p) => s + p.amount, 0);
  const order = parts
    .map((p, i) => ({ i, frac: p.exact - Math.floor(p.exact) }))
    .sort((a, b) => (b.frac - a.frac) || (a.i - b.i));
  const step = residual < 0 ? -1 : 1;
  /* |residual| < parts.length whenever the slices really do sum to `amount`,
   * so one pass over `order` always suffices; the bound just makes
   * termination independent of that argument. */
  for (let k = 0; residual !== 0 && k < order.length * 2; k++) {
    parts[order[k % order.length].i].amount += step;
    residual -= step;
  }
  return parts;
}

/* ---- billing-cycle projection -------------------------------------------
 * >>> DIVERGES from #109: the outpatient app stores an explicit
 * nextBillingDate per client. Here the schedule IS the patient's ENTRY
 * day-of-month, recurring monthly — the same anchor patientsDueOn(),
 * nextBillingDayOnOrAfter() and lastBillingDayOnOrBefore() use, so this view
 * and the גבייה tab agree on when a cycle falls due. The day-of-month is
 * re-clamped from the ORIGINAL entry date every month (entry day 31 → Feb
 * 28/29), never walked forward from the previous occurrence, which would
 * migrate the cycle earlier for good. */
function patientBillingAnchorISO(patient) {
  return isoDate(patient && patient.date);
}
function revenueOccurrenceIn(year, monthIdx, anchorDay) {
  const first = new Date(year, monthIdx, 1);
  const y = first.getFullYear(), m = first.getMonth();
  const last = new Date(y, m + 1, 0).getDate();
  return new Date(y, m, Math.min(anchorDay, last));
}
/* Every cycle due-date whose coverage window INTERSECTS the month. A cycle
 * starting the month before still pays for days inside it, so the walk starts
 * one month early.
 *
 * Bounded by the patient's own stay: never before their entry date, and never
 * on/after their exit date. A cycle STRADDLING a discharge is kept and
 * clipped at the exit by the caller — the days up to the exit were earned;
 * the days after it are the credits ledger's business, not this view's. */
function projectedCycleDueDates(patient, bounds) {
  const anchorISO = patientBillingAnchorISO(patient);
  const anchor = localDateFromISO(anchorISO);
  if (!anchor || !bounds) return [];
  const anchorDay = anchor.getDate();
  const exitISO = isoDate(patient && patient.exitDate);
  const out = [];
  for (let n = -1; n <= 0; n++) {
    const probe = new Date(bounds.start.getFullYear(), bounds.start.getMonth() + n, 1);
    const occ = revenueOccurrenceIn(probe.getFullYear(), probe.getMonth(), anchorDay);
    const occISO = isoFromLocalDate(occ);
    if (anchorISO && occISO < anchorISO) continue;
    if (exitISO && occISO >= exitISO) continue;
    const win = paymentCoverage({ dueDate: occISO });
    if (!win || !revenueOverlapDays(win.start, win.end, bounds)) continue;
    if (out.indexOf(occISO) === -1) out.push(occISO);
  }
  return out.sort();
}

/* ---- credits -------------------------------------------------------------
 * The span a credit actually refunds, which is NOT its allocationMonth — that
 * column is documented in refundSuggestionsFor_() (Code.gs) as reporting metadata that never
 * enters the math, and using it here would contradict the module that wrote it.
 *
 *   prepaid_return — the whole coverage window was unearned.
 *   days_unused    — only the credited tail, creditedFrom..coverageEnd. The
 *                    days BEFORE the exit were used and never refunded.
 *
 * A credit whose basis carries no usable span (a manual `other` credit, or a
 * legacy row saved before basis was written) falls back to its
 * allocationMonth and lands whole in it — the only honest thing to do with a
 * figure that has no window. `spanSource` records which path was taken so the
 * drill-down can say so rather than implying a precision it lacks. */
function creditRefundSpan(credit) {
  const basis = (credit && credit.basis) || {};
  const endISO = isoDate(basis.coverageEnd);
  const startISO = String(credit && credit.creditType) === 'prepaid_return'
    ? isoDate(basis.coverageStart)
    : isoDate(basis.creditedFrom);
  if (startISO && endISO && startISO <= endISO) {
    const s = localDateFromISO(startISO), e = localDateFromISO(endISO);
    if (s && e) return { start: s, end: e, source: 'coverage_window' };
  }
  const mb = revenueMonthBounds(String((credit && credit.allocationMonth) || '').slice(0, 7));
  if (mb) return { start: mb.start, end: mb.end, source: 'allocation_month' };
  return null;
}

/* Is this payment row the patient's base monthly cycle? Every Payments row in
 * this repo is (there are no extra-charge rows — see the DIVERGES note in the
 * changelog), so this exists to make the intent explicit and to give the
 * projection something to match against. */
function revenuePaymentHouse(payment, patient) {
  const house = houseById(payment && payment.houseId) || houseById(patient && patient.houseId);
  return house ? house.name : REVENUE_NO_HOUSE;
}

/**
 * buildMonthlyRevenue(opts) → the whole month, or null for an unusable key.
 *
 * opts: month ('YYYY-MM'), patients, payments, credits, overrides
 *       (BillingOverrides rows), today ('YYYY-MM-DD', injected so a report
 *       reruns identically).
 *
 * PURE — no DOM, no state, no network.
 */
function buildMonthlyRevenue(opts) {
  opts = opts || {};
  const bounds = revenueMonthBounds(opts.month);
  if (!bounds) return null;

  const patients  = Array.isArray(opts.patients) ? opts.patients : [];
  const payments  = Array.isArray(opts.payments) ? opts.payments : [];
  const credits   = Array.isArray(opts.credits) ? opts.credits : [];
  const overrides = Array.isArray(opts.overrides) ? opts.overrides : [];
  const todayISOv = isoDate(opts.today) || isoFromLocalDate(new Date());
  /* The records cutoff in force for this build. Defaults to the app-wide
   * constant; see isPreRecordsCycle() for why it is overridable at all. */
  const recordsFrom = isoDate(opts.recordsFrom) || RECORDS_COMPLETE_FROM;
  const preRecords = dueISO => isPreRecordsCycle(dueISO, recordsFrom);

  const patientById = {};
  patients.forEach(p => { if (p) patientById[patientKey(p)] = p; });

  const receivedRows = [];
  const expectedRows = [];
  const creditRows   = [];
  /* Cycles before RECORDS_COMPLETE_FROM. Their own array from the start, so
   * there is no moment at which they are inside EXPECTED and have to be
   * subtracted back out — a bucket you have to remember to exclude is a bucket
   * that will eventually be included by accident. */
  const preRecordsRows = [];

  /* --- RECEIVED, and the billed half of EXPECTED ------------------------
   * One pass over the payment rows. applyBillingOverride() supplies the
   * EFFECTIVE amount due, so a per-month edit Sandra made on the גבייה tab is
   * the figure this view forecasts against too — a naive p.amount would
   * ignore it. The overlay never touches paid/partial history, so RECEIVED is
   * always the real amountPaid. */
  payments.forEach(raw => {
    /* VOID — a row entered twice. It keeps its amount and its amountPaid on
     * the sheet as the evidence of the double entry, and contributes to no
     * figure on this screen: not RECEIVED, not EXPECTED, not NET. */
    if (!raw || isVoidPayment(raw)) return;
    const dueISO = isoDate(raw.dueDate);
    if (!dueISO) return;
    /* THE WHOLE ROW, not a { dueDate } stub: the stub threw away any recorded
     * coverageStart/coverageEnd and re-inferred the cycle, which is exactly
     * the assumption this screen now stops making. paymentCoverage() picks
     * the recorded period when the row has one and infers when it does not,
     * so this screen and the credits ledger read the identical window. */
    const win = paymentCoverage(raw);
    if (!win) return;

    const p = applyBillingOverride(raw, overrides);
    const patient = patientById[String(p.patientId || '')] || findPatientForPaymentIn(patients, p);
    const billed = roundMoney(Number(p.amount) || 0);
    const paid   = roundMoney(Number(p.amountPaid) || 0);
    const shortfall = roundMoney(Math.max(0, billed - paid));

    const base = {
      paymentId: String(p.id || ''),
      patientId: String(p.patientId || ''),
      patientName: String(p.patientName || '') || (patient && patient.name) || '',
      house: revenuePaymentHouse(p, patient),
      houseId: String((p.houseId || (patient && patient.houseId)) || ''),
      status: String(p.status || ''),
      dueDate: dueISO,
      coverageStart: isoFromLocalDate(win.start),
      coverageEnd: isoFromLocalDate(win.end),
      /* 'recorded' — the row says what it covered; 'inferred' — the cycle was
       * assumed from the due date. Reported, never used in the arithmetic. */
      coverageWindowSource: win.source,
      coverageAdjusted: coverageDiffersFromDefault(raw),
      billedAmount: billed,
      amountPaid: paid,
      overridden: !!billingOverrideFor(overrides, p.patientId, monthKey(dueISO)),
    };

    if (paid > 0) {
      const a = revenueAllocate(paid, win, bounds);
      if (a.daysInMonth > 0) {
        receivedRows.push(Object.assign({}, base, {
          fullAmount: paid, amountInMonth: a.amount,
          amountInMonthExVat: revenueExVat(a.amount),
          daysInMonth: a.daysInMonth, windowDays: a.windowDays, share: a.share,
        }));
      }
    }
    if (shortfall > 0) {
      const b = revenueAllocate(shortfall, win, bounds);
      if (b.daysInMonth > 0) {
        expectedRows.push(Object.assign({}, base, {
          kind: 'billed_unpaid', fullAmount: shortfall, amountInMonth: b.amount,
          amountInMonthExVat: revenueExVat(b.amount),
          daysInMonth: b.daysInMonth, windowDays: b.windowDays, share: b.share,
        }));
      }
    }
  });

  /* --- the projected half of EXPECTED -----------------------------------
   * Active patients whose cycle covers days of this month with NO payment row
   * behind it. A cycle that already has a row was fully handled above (paid
   * part + shortfall), so it is skipped here — that skip is the only thing
   * standing between this view and double counting. */
  const billedCycleKeys = {};
  payments.forEach(p => {
    /* A VOID row is not a billing record, so it must not claim its cycle
     * either: if the only row for a cycle was voided as a duplicate, that
     * cycle has no payment behind it and belongs back in the projected pass.
     * (In the duplicate case the surviving twin keeps the key, so nothing
     * moves — which is the point.) */
    if (!p || isVoidPayment(p)) return;
    const dueISO = isoDate(p.dueDate);
    if (!dueISO) return;
    const pid = String(p.patientId || '');
    billedCycleKeys[pid + '|' + dueISO] = true;
    // Also key by month: a stored row whose dueDate drifted a day or two from
    // the entry-day anchor is still THAT cycle, not a second one.
    billedCycleKeys[pid + '|m|' + dueISO.slice(0, 7)] = true;
  });

  patients.forEach(patient => {
    /* THE STAY WINDOW, not the current status. This pass used to start with
     * isBillablePatient(), i.e. "is this patient active TODAY" — which silently
     * erased a discharged patient's whole billing history: somebody discharged
     * in August was in the house all July, and their July cycles are July's
     * revenue no matter what their row says in September. projectedCycleDueDates
     * already clips each cycle at entry and exit, and revenueAllocate()
     * truncates a straddling cycle at the exit day, so the stay is respected
     * day by day; what was missing was letting the patient into the pass at
     * all. */
    if (!patientStayOverlapsRange(patient, bounds.startISO, bounds.endISO)) return;
    const key = patientKey(patient);
    // The contracted rate, override-aware: the same effective amount the
    // גבייה tab would bill for that month, not the raw p.pay.
    const exitDay = localDateFromISO(isoDate(patient.exitDate));
    projectedCycleDueDates(patient, bounds).forEach(dueISO => {
      if (billedCycleKeys[key + '|' + dueISO]) return;
      if (billedCycleKeys[key + '|m|' + dueISO.slice(0, 7)]) return;
      const contracted = roundMoney(Number(
        applyBillingOverride({
          id: paymentId(patient, dueISO), patientId: key, patientName: patient.name,
          houseId: patient.houseId, dueDate: dueISO, amount: patient.pay || 0,
          status: 'unpaid', amountPaid: 0, balance: patient.pay || 0,
        }, overrides).amount
      ) || 0);
      if (contracted <= 0) return;
      const win = paymentCoverage({ dueDate: dueISO });
      const a = revenueAllocate(contracted, win, bounds, exitDay);
      if (!a.daysInMonth) return;
      const house = houseById(patient.houseId);
      /* A cycle before the records cutoff is not a forecast and not a debt —
       * it is a gap in the RECORDS, not in the money. It goes to its own
       * bucket, which no total sums, rather than being dropped: the cycle
       * happened, and a screen that quietly omits it is making the same
       * unstated assumption in the opposite direction. */
      (preRecords(dueISO) ? preRecordsRows : expectedRows).push({
        /* A cycle still ahead of us is a forecast; one whose date has gone by
         * with no row is a recording gap wearing a forecast's clothes. Same
         * money, very different confidence — so they are named apart and the
         * UI flags the second in amber. */
        kind: preRecords(dueISO) ? 'pre_records'
            : (dueISO > todayISOv ? 'projected' : 'unbilled_past'),
        paymentId: '', patientId: key, patientName: String(patient.name || ''),
        house: house ? house.name : REVENUE_NO_HOUSE,
        houseId: String(patient.houseId || ''),
        status: '', dueDate: dueISO,
        coverageStart: isoFromLocalDate(win.start),
        coverageEnd: isoFromLocalDate(win.end),
        // A projected cycle has no payment row, so there is nothing recorded
        // to honour — inferred by construction, and said so.
        coverageWindowSource: win.source, coverageAdjusted: false,
        billedAmount: contracted, amountPaid: 0,
        overridden: !!billingOverrideFor(overrides, key, monthKey(dueISO)),
        fullAmount: contracted, amountInMonth: a.amount,
        amountInMonthExVat: revenueExVat(a.amount),
        daysInMonth: a.daysInMonth, windowDays: a.windowDays, share: a.share,
      });
    });
  });

  /* --- CREDITS ----------------------------------------------------------
   * pending and paid both reduce the month's revenue: the money is owed back
   * either way, and when it was actually handed over is no more relevant than
   * when a payment arrived. cancelled is a void decision and counts for
   * nothing. */
  credits.forEach(c => {
    if (!c || c.status === 'cancelled') return;
    const amount = roundMoney(Number(c.amount) || 0);
    if (!amount) return;
    const span = creditRefundSpan(c);
    if (!span) return;
    const a = revenueAllocate(amount, span, bounds);
    if (!a.daysInMonth) return;
    const patient = patientById[String(c.patientKey || '')] || null;
    const house = houseById(c.houseId) || houseById(patient && patient.houseId);
    creditRows.push({
      creditId: String(c.id || ''), patientId: String(c.patientId || ''),
      patientName: String(c.patientName || '') || (patient && patient.name) || '',
      house: house ? house.name : REVENUE_NO_HOUSE,
      houseId: String(c.houseId || ''),
      creditType: String(c.creditType || ''), status: String(c.status || ''),
      allocationMonth: String(c.allocationMonth || ''),
      payoutDate: isoDate(c.payoutDate),
      coverageStart: isoFromLocalDate(span.start),
      coverageEnd: isoFromLocalDate(span.end),
      spanSource: span.source,
      fullAmount: amount, amountInMonth: a.amount,
      amountInMonthExVat: revenueExVat(a.amount),
      daysInMonth: a.daysInMonth, windowDays: a.windowDays, share: a.share,
    });
  });

  /* --- totals: rows first, totals from the rows, so every figure on screen
   * is the sum of things you can click through to. */
  const received = revenueBucket(receivedRows);
  const expected = revenueBucket(expectedRows);
  const creditsB = revenueBucket(creditRows);
  const preRecordsB = revenueBucket(preRecordsRows);
  const byKind = k => revenueBucket(expectedRows.filter(r => r.kind === k));

  revenueSortRows(receivedRows); revenueSortRows(expectedRows);
  revenueSortRows(creditRows); revenueSortRows(preRecordsRows);

  return {
    month: bounds.key,
    monthLabel: revenueMonthLabel(bounds.key),
    monthStart: bounds.startISO,
    monthEnd: bounds.endISO,
    daysInMonth: bounds.days,
    vatRate: VAT_RATE,

    received: Object.assign(received, { rows: receivedRows }),
    expected: Object.assign(expected, {
      rows: expectedRows,
      /* The three confidences inside EXPECTED, kept visible rather than
       * blended: a receivable on a cycle already billed, a forecast that
       * assumes the patient stays, and a cycle nobody ever recorded. */
      billedUnpaid: byKind('billed_unpaid'),
      projected: byKind('projected'),
      unbilledPast: byKind('unbilled_past'),
    }),
    credits: Object.assign(creditsB, { rows: creditRows }),

    /* Cycles that fall before RECORDS_COMPLETE_FROM. Reported so the money is
     * not forgotten, and summed into NOTHING: not EXPECTED, not NET, not the
     * per-house breakdown. The bucket is the whole point — a figure you can
     * see and choose to act on, rather than debt the screen asserts. */
    preRecords: Object.assign(preRecordsB, {
      rows: preRecordsRows, from: recordsFrom,
    }),

    /* NET is the ONLY place received and expected meet, and it is a
     * projection by construction — never quote it as cash. */
    net: {
      inclVat: roundMoney(received.inclVat + expected.inclVat - creditsB.inclVat),
      exVat: roundMoney(received.exVat + expected.exVat - creditsB.exVat),
    },

    byHouse: revenueBreakdownByHouse(receivedRows, expectedRows, creditRows),

    /* «מאומת» (Phase 4): the part of the month's money Ortal confirmed in the
     * bank — the CONFIRMED receipts allocated by their coverage window, by
     * lib/billing-control-rules.js verifiedForMonth (the «בקרת גבייה» tab's
     * own figure). A SEPARATE field: it is in no other figure here — not
     * RECEIVED, not NET — so every shared revenue rule is unchanged. null
     * when the receipts or the rules are not available. */
    verified: revenueVerified(opts.receipts, bounds.key),
  };
}

/* { inclVat, exVat, count, rows } of «מאומת» for month `key`, or null. Ex-VAT
 * is taken PER ROW at 2dp, like every bucket on this screen. Pure. */
function revenueVerified(receipts, key) {
  const R = (typeof globalThis !== 'undefined' && globalThis.BillingControlRules) || null;
  if (!R || !Array.isArray(receipts)) return null;
  const v = R.verifiedForMonth(receipts, key, 'all');
  let ex = 0;
  v.rows.forEach(r => { ex = roundMoney(ex + revenueExVat(r.amountInMonth)); });
  return { inclVat: v.total, exVat: ex, count: v.count, rows: v.rows };
}

/* A payment whose patient is gone still counts — money is money. The SAME
 * four-tier rule as findPatientForPayment(), over an explicit list so
 * buildMonthlyRevenue stays pure. One rule, two entry points: a payment that
 * the גבייה tab considers attached and the revenue screen does not is exactly
 * the class of disagreement this change exists to end. */
function findPatientForPaymentIn(patients, pay) {
  const m = matchPatientForPayment(pay, patients);
  return m ? m.patient : null;
}

/* Sum a row list into { inclVat, exVat, count }. exVat is the SUM OF THE ROWS'
 * own ex-VAT figures, so a drill-down reconciles with its header. */
function revenueBucket(rows) {
  let incl = 0, ex = 0;
  rows.forEach(r => {
    incl = roundMoney(incl + r.amountInMonth);
    ex = roundMoney(ex + r.amountInMonthExVat);
  });
  return { inclVat: incl, exVat: ex, count: rows.length };
}

/* Newest cycle first, then by patient name (he collation). */
function revenueSortRows(rows) {
  rows.sort((a, b) => {
    const d = String(b.dueDate || b.coverageStart || '').localeCompare(String(a.dueDate || a.coverageStart || ''));
    if (d) return d;
    return String(a.patientName || '').localeCompare(String(b.patientName || ''), 'he');
  });
}

/* BREAKDOWN DIMENSION: house. Sorted by NET descending so the houses carrying
 * the month lead; all-zero rows are dropped as noise. */
function revenueBreakdownByHouse(receivedRows, expectedRows, creditRows) {
  const by = {};
  const slot = name => {
    const k = name || REVENUE_NO_HOUSE;
    if (!by[k]) {
      by[k] = {
        house: k,
        received: { inclVat: 0, exVat: 0, count: 0 },
        expected: { inclVat: 0, exVat: 0, count: 0 },
        credits:  { inclVat: 0, exVat: 0, count: 0 },
      };
    }
    return by[k];
  };
  const add = (target, r) => {
    target.inclVat = roundMoney(target.inclVat + r.amountInMonth);
    target.exVat = roundMoney(target.exVat + r.amountInMonthExVat);
    target.count += 1;
  };
  receivedRows.forEach(r => add(slot(r.house).received, r));
  expectedRows.forEach(r => add(slot(r.house).expected, r));
  creditRows.forEach(r => add(slot(r.house).credits, r));

  return Object.keys(by).map(k => {
    const b = by[k];
    b.net = {
      inclVat: roundMoney(b.received.inclVat + b.expected.inclVat - b.credits.inclVat),
      exVat: roundMoney(b.received.exVat + b.expected.exVat - b.credits.exVat),
    };
    return b;
  }).filter(b => b.received.count || b.expected.count || b.credits.count)
    .sort((a, b) => (b.net.exVat !== a.net.exVat)
      ? b.net.exVat - a.net.exVat
      : String(a.house).localeCompare(String(b.house), 'he'));
}

/* Display helper: whole shekels, like every other figure in this app and like
 * money() in ezone-outpatient #109. The underlying figures keep 2dp — that is
 * what makes a bucket total equal the sum of its rows — and only the PRINTED
 * value is rounded. Rounding the data instead would drift a drill-down from
 * its own header by up to half a shekel per row. */
function revMoney(exVatAmount) {
  return fmtShekel(Math.round(Number(exVatAmount) || 0));
}

/* ---- הכנסות חודשיות — rendering ------------------------------------------
 * Read-only. Adds no endpoint and no write path: every figure is derived in
 * the browser from data already loaded for the other tabs (state.patients,
 * state.payments, state.billingOverrides, state.credits). The daily גבייה
 * screen is not touched by anything here — separate state, separate renderer,
 * separate screen.
 *
 * Every figure printed is EX-VAT, via revenueExVat() at 2dp. */
function renderMonthlyRevenue() {
  if (!financeView()) return; // restricted view: no billing UI at all
  const monthEl = document.getElementById('revenue-month');
  if (!state.revenueMonth) state.revenueMonth = monthKey(todayISO());
  if (monthEl && monthEl.value !== state.revenueMonth) monthEl.value = state.revenueMonth;

  const model = buildMonthlyRevenue({
    month: state.revenueMonth,
    patients: state.patients,
    payments: state.payments,
    credits: Array.isArray(state.credits) ? state.credits : [],
    overrides: state.billingOverrides,
    receipts: Array.isArray(state.receipts) ? state.receipts : [],
    today: todayISO(),
  });
  if (!model) return;

  const labelEl = document.getElementById('rev-month-label');
  if (labelEl) labelEl.textContent = model.monthLabel;

  const set = (id, txt) => { const el = document.getElementById(id); if (el) el.textContent = txt; };
  set('rev-received', revMoney(model.received.exVat));
  set('rev-verified', model.verified ? revMoney(model.verified.exVat) : '—');
  set('rev-expected', revMoney(model.expected.exVat));
  // Credits are a deduction; the minus sign is part of the figure so the card
  // cannot be misread as income.
  set('rev-credits', model.credits.exVat ? '−' + revMoney(model.credits.exVat) : revMoney(0));
  set('rev-net', revMoney(model.net.exVat));

  renderRevenueExpectedComposition(model);
  renderRevenueByHouse(model);
  renderRevenueDetail(model);
  fitAllStatText();   // scale the KPI values to fit, like every other stat card
}

/* The three confidences inside צפוי, kept apart on screen because they are not
 * equally believable: a cycle already billed, a cycle still ahead, and a cycle
 * whose date passed with nothing recorded — that last usually means a missing
 * payment row rather than future income, so it is flagged. */
function renderRevenueExpectedComposition(model) {
  const el = document.getElementById('rev-expected-breakdown');
  if (!el) return;
  el.innerHTML = '';
  const parts = [
    { b: model.expected.billedUnpaid, label: 'חויב וטרם נגבה', warn: false },
    { b: model.expected.projected,    label: 'טרם חויב — מחזור עתידי', warn: false },
    { b: model.expected.unbilledPast, label: 'מחזור שחלף ללא רישום תשלום', warn: true },
  ];
  parts.forEach(p => {
    if (!p.b.count) return;
    const line = document.createElement('div');
    line.className = 'bd-line' + (p.warn ? ' rev-warn' : '');
    line.innerHTML = `
      <span class="bd-house">${escapeHtml(p.label)}</span>
      <span class="bd-vals">
        <span class="${p.warn ? 'bd-out' : 'bd-col'}">${revMoney(p.b.exVat)}</span>
        <span class="rev-count">${p.b.count} שורות</span>
      </span>
    `;
    el.appendChild(line);
  });
  /* Named on the same panel, but outside the list above and outside every
   * figure it adds up to: this is what the screen is NOT claiming. Stating it
   * beside צפוי is the point — a bucket nobody ever sees is indistinguishable
   * from data that was quietly dropped. */
  if (model.preRecords && model.preRecords.count) {
    const line = document.createElement('div');
    line.className = 'bd-line pre-records-line';
    line.innerHTML = `
      <span class="bd-house">לפני תחילת הרישום <span class="rev-count">(לא נכלל בצפוי ובנטו)</span></span>
      <span class="bd-vals">
        <span class="bd-muted">${revMoney(model.preRecords.exVat)}</span>
        <span class="rev-count">${model.preRecords.count} שורות</span>
      </span>
    `;
    el.appendChild(line);
  }
  if (!el.children.length) {
    el.innerHTML = `<div class="bd-line muted">אין הכנסה צפויה בחודש זה</div>`;
  }
}

/* BREAKDOWN DIMENSION: house — the same dimension the גבייה monthly summary and
 * the נקודת איזון tab use, and the one ezone-outpatient's location breakdown
 * lines up with per site. */
function renderRevenueByHouse(model) {
  const el = document.getElementById('rev-by-house');
  if (!el) return;
  el.innerHTML = '';
  model.byHouse.forEach(b => {
    const line = document.createElement('div');
    line.className = 'bd-line';
    line.innerHTML = `
      <span class="bd-house">${escapeHtml(b.house)}</span>
      <span class="bd-vals">
        <span class="bd-col">נגבה ${revMoney(b.received.exVat)}</span>
        <span class="rev-exp">צפוי ${revMoney(b.expected.exVat)}</span>
        ${b.credits.exVat ? `<span class="bd-out">זיכויים −${revMoney(b.credits.exVat)}</span>` : ''}
        <b>נטו ${revMoney(b.net.exVat)}</b>
      </span>
    `;
    el.appendChild(line);
  });
  if (!el.children.length) {
    el.innerHTML = `<div class="bd-line muted">אין נתונים לחודש זה</div>`;
  }
}

const REVENUE_KIND_LABELS = {
  billed_unpaid: 'חויב וטרם נגבה',
  projected: 'טרם חויב — מחזור עתידי',
  unbilled_past: 'מחזור שחלף ללא רישום תשלום',
  pre_records: 'לפני תחילת הרישום',
};

/* Drill-down: every payment, and WHICH PORTION of it landed in this month.
 * The window and the day count ride on the row, so the arithmetic is visible
 * rather than asserted. */
function renderRevenueDetail(model) {
  const list = document.getElementById('rev-detail');
  if (!list) return;
  list.innerHTML = '';
  const q = state.revenueSearch;
  const match = r => !q || String(r.patientName || '').toLowerCase().indexOf(q) !== -1;

  const groups = [
    { key: 'received', title: 'נגבה בפועל', rows: model.received.rows.filter(match), sign: '' },
    { key: 'expected', title: 'צפוי',        rows: model.expected.rows.filter(match), sign: '' },
    { key: 'credits',  title: 'זיכויים',     rows: model.credits.rows.filter(match),  sign: '−' },
    /* Listed last, and its heading says the rule rather than a total, because
     * the figure beside a group heading everywhere else on this screen IS part
     * of a total and this one is not. */
    {
      key: 'preRecords',
      title: `לפני תחילת הרישום — לא נספר (עד ${formatDate(RECORDS_COMPLETE_FROM)})`,
      rows: (model.preRecords ? model.preRecords.rows : []).filter(match), sign: '',
    },
  ];
  let any = false;
  groups.forEach(g => {
    if (!g.rows.length) return;
    any = true;
    const sum = roundMoney(g.rows.reduce((s, r) => s + r.amountInMonthExVat, 0));
    const head = document.createElement('div');
    head.className = 'rev-detail-head';
    head.innerHTML = `<span>${escapeHtml(g.title)}</span><span>${g.sign}${revMoney(sum)}</span>`;
    list.appendChild(head);
    g.rows.forEach(r => list.appendChild(buildRevenueDetailRow(r, g.key, g.sign)));
  });
  if (!any) {
    const msg = (model.received.count || model.expected.count || model.credits.count
                 || (model.preRecords && model.preRecords.count))
      ? 'לא נמצאו תוצאות'
      : 'אין תנועות בחודש זה';
    list.innerHTML = `<div class="card billing-empty">${msg}</div>`;
  }
}

function buildRevenueDetailRow(row, groupKey, sign) {
  const el = document.createElement('div');
  el.className = 'billing-row rev-detail-row'
    + (row.kind === 'unbilled_past' ? ' rev-warn' : '')
    + (row.kind === 'pre_records' ? ' rev-pre-records' : '');

  // Display only — row.coverageStart/End stay ISO for the allocation maths.
  const windowHtml = dateRangeHeHtml(row.coverageStart, row.coverageEnd);
  // The split, shown as the fraction it is: 12 מתוך 31 ימים.
  const daysText = `${row.daysInMonth} מתוך ${row.windowDays} ימים`;

  let chips = '';
  if ((groupKey === 'expected' || groupKey === 'preRecords') && REVENUE_KIND_LABELS[row.kind]) {
    chips += `<span class="rev-chip">${escapeHtml(REVENUE_KIND_LABELS[row.kind])}</span>`;
  }
  if (groupKey === 'credits') {
    const typeLabel = CREDIT_TYPE_LABELS[row.creditType] || row.creditType || '';
    chips += `<span class="rev-chip">${escapeHtml(typeLabel)}</span>`;
    // A credit with no usable coverage window fell back to its allocationMonth
    // — say so rather than implying a day-level split.
    if (row.spanSource === 'allocation_month') {
      chips += `<span class="rev-chip rev-chip-soft">לפי חודש שיוך</span>`;
    }
  }
  // A per-month billing override is visible on the row it changed, so the
  // forecast never differs from the גבייה tab without saying why.
  if (row.overridden) chips += `<span class="rev-chip rev-chip-soft">סכום מותאם</span>`;
  /* The period this row was allocated by was RECORDED and differs from the
   * billing cycle. Without this chip the row's window would silently
   * contradict the due date printed beside it, which is precisely the
   * "money in the wrong month with no way to tell" this change exists to
   * end — so the screen says which rows are not on their default cycle. */
  if (row.coverageAdjusted) chips += `<span class="rev-chip rev-chip-soft">תקופה מותאמת</span>`;

  el.innerHTML = `
    <div><span class="p-label">מטופל</span><span class="p-name">${escapeHtml(row.patientName || '—')}</span>${chips}</div>
    <div><span class="p-label">בית</span><span class="p-val">${escapeHtml(row.house || '')}</span></div>
    <div><span class="p-label">חלון כיסוי</span><span class="p-val">${windowHtml}</span></div>
    <div><span class="p-label">בחודש זה</span><span class="p-val">${escapeHtml(daysText)}</span></div>
    <div><span class="p-label">סכום מלא</span><span class="p-val">${revMoney(revenueExVat(row.fullAmount))}</span></div>
    <div><span class="p-label">שיוך לחודש</span><span class="p-val rev-portion">${sign}${revMoney(row.amountInMonthExVat)}</span></div>
  `;
  return el;
}

/* Upsert a payment record locally, then persist to the Payments sheet.
 *
 * THE ONE WRITE PATH for a payment row's NON-money columns — the coverage-
 * period editor and the שיוך תשלומים link / void decisions all funnel here
 * (money is recorded only by «דווח תשלום» → reportPayment, Phase 3 PR 2), which is why the coverage default is stamped HERE and nowhere
 * else: every payment written from today forward carries an explicit period,
 * and a recorder who never looks at the field gets exactly the cycle that
 * used to be inferred for it. The client-side refusal below mirrors
 * coveragePeriodError_() in Code.gs — the server is the authority and
 * re-validates every write; this only spares the user a round-trip. */
async function savePayment(payment, opts) {
  if (state.mode !== 'edit') return false;
  // keepEditor: on failure re-render only the summary, so an inline editor
  // stays open with what was typed (R3). Default: re-render the tab.
  const keepEditor = !!(opts && opts.keepEditor);
  const covErr = coveragePeriodError(payment && payment.coverageStart, payment && payment.coverageEnd);
  if (covErr) { showError(covErr); return false; }
  payment = withDefaultCoverage(payment);
  payment = withPatientUid(payment, state.patients);
  const idx = state.payments.findIndex(x => x.id === payment.id);
  const prev = idx >= 0 ? { ...state.payments[idx] } : null;
  if (idx >= 0) state.payments[idx] = payment;
  else state.payments.push(payment);

  // Re-render the monthly summary right away; the row itself was already
  // updated in place by buildBillingRow's recompute.
  renderBillingMonthlySummary(state.billingDate || todayISO());

  // Counted in flight and noted on the payments guard: reads that started
  // before this write must not overwrite it (R1).
  try {
    const res = await trackedWrite([_paymentsGuard], () => apiPost({ action: 'savePayment', payment }));
    // R3: «נשמר» only with the server's copy of THIS row.
    requireSavedId(res, r => r.payment && r.payment.id, payment.id);
    /* ADOPT THE SERVER'S COPY. The link columns (linkedBy / linkedAt) are
     * stamped SERVER-SIDE from the signed session cookie and the server's
     * clock — the client cannot know them, and must not be trusted with them.
     * Reading them back here is what puts the real "who and when" on screen
     * without a reload. Everything else in the echo is what we just sent. */
    const at = state.payments.findIndex(x => x.id === payment.id);
    if (at >= 0) state.payments[at] = normalizePayment(res.payment);
    else state.payments.push(normalizePayment(res.payment));
    if (res.cycle) adoptCycleEcho(res.cycle);
    return true;
  } catch (e) {
    // Roll back local change so the UI doesn't lie about persistence.
    const at = state.payments.findIndex(x => x.id === payment.id);
    if (prev) { if (at >= 0) state.payments[at] = prev; else state.payments.push(prev); }
    else state.payments = state.payments.filter(x => x.id !== payment.id);
    if (keepEditor) renderBillingMonthlySummary(state.billingDate || todayISO());
    else renderBilling();
    showError('שמירת גבייה נכשלה — ' + e.message);
    return false;
  }
}

/* ====================================================
   «דווח תשלום» — ONE ROW PER MONEY RECEIVED (Phase 3 PR 2)
   ====================================================
 * Sandra, 2026-10-04 (CHANGELOG-payment-report-form.md):
 *   - every report creates a NEW receipt row on the server (reportPayment);
 *     it never edits an existing amount. The cycle row stays the charge, and
 *     its amountPaid / balance / status are derived by the server from the
 *     receipts that pay it (recomputeCycleFromReceipts_ in Code.gs);
 *   - STRICT: the form cannot be sent until every field passes
 *     lib/payment-report-rules.js (window.PaymentReportRules), with an inline
 *     Hebrew error under each field; the server re-validates and refuses an
 *     incomplete report, writing nothing;
 *   - un-doing a receipt = voiding it (deleter), never editing it;
 *   - finance sessions only: a restricted session has no גבייה tab, no
 *     button, no form and no funder editor (and the server answers 403). */

const PAYMENT_REPORT_TOAST = 'התשלום נרשם — יופיע אצל אורטל מחר בבוקר';
/* The form's field order — the order the inline errors are checked in. */
const PAYMENT_REPORT_FORM_FIELDS = ['receivedDate', 'amount', 'method', 'payer', 'reference', 'funder', 'coverageStart', 'coverageEnd',
  'invoiceWanted', 'invoiceTo'];

/* «חשבונית?» / «על שם» (CHANGELOG-payment-invoice.md). A row from before the
 * question carries neither and reads «—» — never כן, never לא. Pure. */
const INVOICE_LABELS = { yes: 'כן', no: 'לא' };
function invoiceLabel(v) {
  return Object.prototype.hasOwnProperty.call(INVOICE_LABELS, v) ? INVOICE_LABELS[v] : '—';
}
function invoiceToLabel(r) {
  return r && r.invoiceWanted === 'yes' && r.invoiceTo ? String(r.invoiceTo) : '—';
}

/* The shared rules, loaded as /payment-report-rules.js before app.js. */
function paymentReportRules() {
  return (typeof window !== 'undefined' && window.PaymentReportRules) || null;
}

/* PAYMENT_STATUS label for a derived status. Pure. */
function paymentStatusLabel(status) {
  const s = PAYMENT_STATUS.find(x => x.id === status);
  return s ? s.label : 'לא שולם';
}

/* A receipt row from getPayments `receipts` (or a reportPayment echo). */
function normalizeReceipt(r) {
  const o = r && typeof r === 'object' ? r : {};
  const rawStatus = String(o.status == null ? '' : o.status).trim();
  const status = PAYMENT_STATUS_ALIASES[rawStatus] || PAYMENT_STATUS_ALIASES[rawStatus.toLowerCase()] || 'paid';
  return {
    id: String(o.id || ''),
    cycleId: String(o.cycleId || ''),
    patientId: String(o.patientId || ''),
    patientName: String(o.patientName || ''),
    houseId: resolveHouseId(o.houseId || ''),
    dueDate: isoDate(o.dueDate),
    amount: Number(o.amountPaid !== undefined && o.amountPaid !== '' ? o.amountPaid : o.amount) || 0,
    status,
    receivedDate: isoDate(o.receivedDate),
    method: String(o.method || ''),
    payer: String(o.payer || ''),
    funder: String(o.funder || ''),
    reference: String(o.reference || ''),
    coverageStart: isoDate(o.coverageStart),
    coverageEnd: isoDate(o.coverageEnd),
    recordedBy: String(o.recordedBy || ''),
    recordedAt: String(o.recordedAt || ''),
    confirmStatus: String(o.confirmStatus || ''),
    confirmedBy: String(o.confirmedBy || ''),
    confirmedAt: String(o.confirmedAt || ''),
    flagNote: String(o.flagNote || ''),
    // CHANGELOG-ortal-verification-status.md: «שולם חלקית» counts only this
    // in «מאומת» (lib/billing-control-rules.js verifiedAmountOf).
    confirmedAmount: o.confirmedAmount === undefined || o.confirmedAmount === null ? '' : o.confirmedAmount,
    controlNote: String(o.controlNote || ''),
    linkStatus: String(o.linkStatus || ''),
    linkNote: String(o.linkNote || ''),
    timestamp: String(o.timestamp || ''),
    invoiceWanted: ['yes', 'no'].indexOf(String(o.invoiceWanted || '').trim()) >= 0 ? String(o.invoiceWanted).trim() : '',
    invoiceTo: String(o.invoiceTo || ''),
  };
}

function normalizeFunderRow(r) {
  const o = r && typeof r === 'object' ? r : {};
  return {
    patientId: String(o.patientId || '').trim(),
    funder: String(o.funder || '').trim(),
    effectiveFrom: isoDate(o.effectiveFrom),
    setBy: String(o.setBy || ''),
    setAt: String(o.setAt || ''),
    // The appending form's idempotency key (blank on older rows).
    submissionId: String(o.submissionId || ''),
  };
}

/* The receipts that pay cycle `cycleId`, oldest received first. Pure over
 * state.receipts. */
function receiptsForCycle(cycleId, receipts) {
  const list = Array.isArray(receipts) ? receipts : state.receipts;
  return (list || []).filter(r => r && r.cycleId && r.cycleId === cycleId)
    .sort((a, b) => (a.receivedDate || '').localeCompare(b.receivedDate || '') || (a.recordedAt || '').localeCompare(b.recordedAt || ''));
}

/* The receipts list under a גבייה row: date, amount, method, reference, who.
 * A voided receipt stays listed, struck through. Empty → nothing. */
function receiptsListHtml(cycleId) {
  const rs = receiptsForCycle(cycleId);
  if (!rs.length) return '';
  const items = rs.map(r => {
    const isVoid = r.status === PAYMENT_VOID_STATUS;
    const voidBtn = !isVoid && state.mode === 'edit' && canDelete()
      ? `<button type="button" class="btn small receipt-void-btn" data-role="deleter" data-rid="${escapeHtml(r.id)}" title="ביטול הקבלה (נשמרת כרישום)">ביטול קבלה</button>`
      : '';
    // ✏️ the non-money fields (CHANGELOG-receipt-duplicates-and-edit.md):
    // Vered and Sandra (finance, edit mode); never Ortal's read-only view.
    const editBtn = !isVoid && canEditReceipt()
      ? `<button type="button" class="btn small receipt-edit-btn" data-rid="${escapeHtml(r.id)}" title="עריכת פרטי הקבלה (לא סכום, לא תאריך)" aria-label="עריכת פרטי הקבלה">✏️</button>`
      : '';
    return `<li class="receipt-item${isVoid ? ' receipt-void' : ''}" data-rid="${escapeHtml(r.id)}">
        <span class="receipt-date">${escapeHtml(formatDate(r.receivedDate) || '—')}</span>
        <span class="receipt-amount">${escapeHtml(fmtShekel(r.amount))}</span>
        <span class="receipt-method">${escapeHtml(r.method || '—')}</span>
        ${r.reference ? `<span class="receipt-ref">אסמכתא ${escapeHtml(r.reference)}</span>` : ''}
        <span class="receipt-invoice">חשבונית: ${escapeHtml(invoiceLabel(r.invoiceWanted))}${r.invoiceWanted === 'yes' ? ' · על שם ' + escapeHtml(invoiceToLabel(r)) : ''}</span>
        <span class="receipt-who">${escapeHtml(r.recordedBy || '')}</span>
        ${isVoid ? `<span class="badge void">${escapeHtml(PAYMENT_VOID_LABEL)}</span>` : ''}
        ${editBtn}
        ${voidBtn}
      </li>`;
  }).join('');
  return `<div class="bill-receipts"><span class="p-label">תשלומים שהתקבלו</span><ul class="receipt-list">${items}</ul></div>`;
}

function wireReceiptVoidButtons(row) {
  row.querySelectorAll('.receipt-void-btn').forEach(btn => {
    btn.onclick = () => {
      const r = state.receipts.find(x => x.id === btn.dataset.rid);
      if (r) openReceiptVoidModal(r);
    };
  });
  row.querySelectorAll('.receipt-edit-btn').forEach(btn => {
    btn.onclick = () => {
      const r = state.receipts.find(x => x.id === btn.dataset.rid);
      if (r) openReceiptEditModal(r);
    };
  });
}

/* ===== ✏️ a receipt's non-money fields (CHANGELOG-receipt-duplicates-and-edit.md)
 * Vered and Sandra: reference, method, payer, invoice, coverage dates —
 * NEVER amount, receivedDate or status (the server refuses those keys,
 * field_not_editable). Reason optional. A confirmed receipt stays confirmed.
 * Display only: Code.gs editReceipt_ is the authority (finance-gated;
 * the controller view gets 403 from server.js and Code.gs). */
const RECEIPT_EDIT_FIELDS = ['reference', 'method', 'payer', 'invoiceWanted', 'invoiceTo', 'coverageStart', 'coverageEnd'];
const RECEIPT_EDIT_REASON_MAX = 300;
const RECEIPT_EDIT_TOAST = 'פרטי הקבלה עודכנו';

function canEditReceipt() {
  return state.mode === 'edit' && financeView() && !controllerView();
}

/* The edit as sent: only the fields that differ from the receipt, plus the
 * issues the shared report rules find in THOSE fields. Pure.
 * → { fields: { k: v }, issues: [{ field, code, hebrewMessage }] } */
function receiptEditChanges(receipt, values) {
  const r = receipt || {};
  const v = values || {};
  const cur = {
    reference: String(r.reference || ''), method: String(r.method || ''), payer: String(r.payer || ''),
    invoiceWanted: String(r.invoiceWanted || ''), invoiceTo: r.invoiceWanted === 'yes' ? String(r.invoiceTo || '') : '',
    coverageStart: String(r.coverageStart || ''), coverageEnd: String(r.coverageEnd || ''),
  };
  const next = {};
  RECEIPT_EDIT_FIELDS.forEach(k => { next[k] = v[k] === undefined ? cur[k] : String(v[k] == null ? '' : v[k]).trim(); });
  if (next.invoiceWanted !== 'yes') next.invoiceTo = '';
  const fields = {};
  RECEIPT_EDIT_FIELDS.forEach(k => { if (next[k] !== cur[k]) fields[k] = next[k]; });
  // A coverage or invoice change is sent as its pair.
  if ('coverageStart' in fields || 'coverageEnd' in fields) { fields.coverageStart = next.coverageStart; fields.coverageEnd = next.coverageEnd; }
  if ('invoiceWanted' in fields || 'invoiceTo' in fields) { fields.invoiceWanted = next.invoiceWanted; fields.invoiceTo = next.invoiceTo; }
  const touched = {};
  Object.keys(fields).forEach(k => { touched[k] = true; });
  if (touched.method) touched.reference = true;
  const rules = paymentReportRules();
  let issues = [];
  if (rules && Object.keys(fields).length) {
    issues = rules.validatePaymentReport({
      receivedDate: r.receivedDate, amount: String(r.amount), method: next.method, payer: next.payer,
      coverageStart: next.coverageStart, coverageEnd: next.coverageEnd, funder: r.funder, reference: next.reference,
    }, { todayIso: rules.jerusalemToday(), maxDaysBack: 0 }).filter(i => touched[i.field]);
    if (touched.invoiceWanted) issues = issues.concat(rules.validatePaymentInvoice(next));
  }
  return { fields, issues };
}

function openReceiptEditModal(receipt) {
  if (!canEditReceipt()) { showError(ROLE_FORBIDDEN_TEXT); return; }
  const rules = paymentReportRules();
  const methods = rules ? rules.PAYMENT_METHODS : [];
  const root = document.getElementById('modal-root');
  const back = document.createElement('div');
  back.className = 'modal-backdrop';
  const r = receipt;
  const opt = (list, sel) => list.map(v => `<option value="${escapeHtml(v)}" ${v === sel ? 'selected' : ''}>${escapeHtml(v)}</option>`).join('');
  const err = f => `<div class="field-error" data-err="${f}" id="re-err-${f}" role="alert"></div>`;
  const yes = r.invoiceWanted === 'yes', no = r.invoiceWanted === 'no';
  // <input type="date"> values stay ISO; the two coverage errors share a row.
  const covStart = r.coverageStart, covEnd = r.coverageEnd;
  const covErrors = err('coverageStart') + err('coverageEnd');
  back.innerHTML = `
    <div class="modal pay-report-modal receipt-edit-modal" role="dialog" aria-labelledby="re-title">
      <h3 id="re-title">עריכת פרטי קבלה</h3>
      <p class="pay-report-lead"><b>${escapeHtml(r.patientName || '')}</b> · ${escapeHtml(fmtShekel(r.amount))} · התקבל ${escapeHtml(formatDate(r.receivedDate) || '—')}<br>
        <span class="bc-sub">סכום, תאריך קבלה וסטטוס אינם ניתנים לעריכה. אישור הקבלה נשמר.</span></p>
      <form novalidate>
        <div class="form-row">
          <label for="re-reference">מספר אסמכתא</label>
          <input type="text" id="re-reference" name="reference" maxlength="40" autocomplete="off" dir="ltr" value="${escapeHtml(r.reference)}" />
          ${err('reference')}
        </div>
        <div class="form-row">
          <label for="re-method">אמצעי תשלום</label>
          <select id="re-method" name="method">${opt(methods, r.method)}</select>
          ${err('method')}
        </div>
        <div class="form-row">
          <label for="re-payer">שם המשלם</label>
          <input type="text" id="re-payer" name="payer" maxlength="100" autocomplete="off" value="${escapeHtml(r.payer)}" />
          ${err('payer')}
        </div>
        <fieldset class="form-row pr-invoice">
          <legend>חשבונית?</legend>
          <div class="pr-invoice-choices" role="radiogroup">
            <label class="pr-radio"><input type="radio" name="invoiceWanted" value="yes"${yes ? ' checked' : ''} /> כן</label>
            <label class="pr-radio"><input type="radio" name="invoiceWanted" value="no"${no ? ' checked' : ''} /> לא</label>
          </div>
          ${err('invoiceWanted')}
        </fieldset>
        <div class="form-row re-invoice-to${yes ? '' : ' hidden'}">
          <label for="re-invoiceTo">על שם</label>
          <input type="text" id="re-invoiceTo" name="invoiceTo" maxlength="120" autocomplete="off" value="${escapeHtml(yes ? r.invoiceTo : '')}" />
          ${err('invoiceTo')}
        </div>
        <div class="form-row pr-cov-row">
          <label>תקופת כיסוי</label>
          <div class="pr-cov">
            <input type="date" name="coverageStart" lang="he" dir="rtl" aria-label="תחילת תקופת הכיסוי" value="${escapeHtml(covStart)}" />
            <input type="date" name="coverageEnd" lang="he" dir="rtl" aria-label="סוף תקופת הכיסוי" value="${escapeHtml(covEnd)}" />
          </div>
          ${covErrors}
        </div>
        <div class="form-row">
          <label for="re-reason">סיבה (לא חובה, נשמרת ביומן)</label>
          <input type="text" id="re-reason" name="reason" maxlength="${RECEIPT_EDIT_REASON_MAX}" autocomplete="off" />
        </div>
        <div class="field-error pr-form-error" data-err="_form" role="alert"></div>
        <div class="form-actions">
          <button type="button" class="btn" data-action="cancel">ביטול</button>
          <button type="submit" class="btn primary re-submit">שמירה</button>
        </div>
      </form>
    </div>`;
  root.appendChild(back);
  const form = back.querySelector('form');
  const submitBtn = back.querySelector('.re-submit');
  const close = () => back.remove();
  back.querySelector('[data-action="cancel"]').onclick = () => { if (!busyButtonActive(submitBtn)) close(); };
  const ctl = f => form.querySelector('[name="' + f + '"]');
  const toRow = back.querySelector('.re-invoice-to');
  form.querySelectorAll('[name="invoiceWanted"]').forEach(x => {
    if (x.addEventListener) x.addEventListener('change', () => {
      const on = form.querySelector('[name="invoiceWanted"]:checked');
      if (toRow && toRow.classList) toRow.classList.toggle('hidden', !(on && on.value === 'yes'));
    });
  });
  const values = () => {
    const v = {};
    ['reference', 'method', 'payer', 'invoiceTo', 'coverageStart', 'coverageEnd'].forEach(f => { v[f] = ctl(f) ? String(ctl(f).value || '').trim() : ''; });
    const on = form.querySelector('[name="invoiceWanted"]:checked');
    v.invoiceWanted = on ? String(on.value || '') : String(r.invoiceWanted || '');
    return v;
  };
  const paint = issues => {
    const by = {};
    issues.forEach(i => { if (!by[i.field]) by[i.field] = i.hebrewMessage; });
    back.querySelectorAll('[data-err]').forEach(el => {
      if (el.dataset.err === '_form') return;
      el.textContent = by[el.dataset.err] || '';
      const c = ctl(el.dataset.err);
      if (c && c.setAttribute) { if (by[el.dataset.err]) c.setAttribute('aria-invalid', 'true'); else c.removeAttribute('aria-invalid'); }
    });
  };
  form.onsubmit = e => {
    e.preventDefault();
    const formErr = back.querySelector('[data-err="_form"]');
    formErr.textContent = '';
    const ch = receiptEditChanges(r, values());
    paint(ch.issues);
    if (ch.issues.length) return;
    if (!Object.keys(ch.fields).length) { formErr.textContent = 'לא בוצע שינוי'; return; }
    const reason = String((ctl('reason') || {}).value || '').trim().slice(0, RECEIPT_EDIT_REASON_MAX);
    return busyButton(submitBtn, 'save', async () => {
      try {
        await submitReceiptEdit(r, ch.fields, reason);
        close();
        showToast(RECEIPT_EDIT_TOAST);
      } catch (e2) {
        const data = e2 && e2.data;
        if (data && Array.isArray(data.issues) && data.issues.length) paint(data.issues);
        formErr.textContent = (data && data.message) || ('השמירה נכשלה — ' + ((e2 && e2.message) || 'שגיאה'));
      }
    });
  };
  const first = ctl('reference');
  if (first && first.focus) first.focus();
}

/* POST editReceipt; the server's echo replaces the receipt in state. */
async function submitReceiptEdit(receipt, fields, reason) {
  const edit = { id: receipt.id, fields: Object.assign({}, fields) };
  if (reason) edit.reason = reason;
  // R1: counted in flight; an older in-flight getPayments must not undo it.
  const res = await trackedWrite([_paymentsGuard], () => apiPost({ action: 'editReceipt', edit }));
  // R3: the server's copy of THIS receipt, or the modal stays open.
  requireSavedId(res, r => r.receipt && r.receipt.id, receipt.id);
  const at = state.receipts.findIndex(x => x.id === receipt.id);
  if (at >= 0) state.receipts[at] = normalizeReceipt(Object.assign({}, res.receipt, { cycleId: receipt.cycleId }));
  renderBilling();
  return res;
}

/* Void a receipt — the existing void flow (savePayment, status void, a
 * reason), `deleter` only. The server re-derives the cycle and echoes it. */
function openReceiptVoidModal(receipt) {
  if (state.mode !== 'edit') return;
  if (!canDelete()) { showError(ROLE_FORBIDDEN_TEXT); return; }
  const root = document.getElementById('modal-root');
  const back = document.createElement('div');
  back.className = 'modal-backdrop';
  back.innerHTML = `
    <div class="modal pay-report-modal">
      <h3>ביטול קבלה</h3>
      <p class="dup-lead">הקבלה על ${escapeHtml(fmtShekel(receipt.amount))} מ־${escapeHtml(formatDate(receipt.receivedDate))}
        תסומן <b>${escapeHtml(PAYMENT_VOID_LABEL)}</b> ותישמר כרישום. סטטוס המחזור יחושב מחדש.</p>
      <div class="form-row">
        <label for="receipt-void-note">סיבה (נשמרת ביומן)</label>
        <input type="text" id="receipt-void-note" class="receipt-void-note" maxlength="${PAYMENT_LINK_NOTE_MAX}" />
        <div class="field-error" data-err="note" role="alert"></div>
      </div>
      <div class="form-actions">
        <button type="button" class="btn" data-action="cancel">חזרה</button>
        <button type="button" class="btn danger" data-action="confirm">בטל קבלה</button>
      </div>
    </div>`;
  root.appendChild(back);
  const close = () => back.remove();
  const noteEl = back.querySelector('.receipt-void-note');
  const confirmBtn = back.querySelector('[data-action="confirm"]');
  back.querySelector('[data-action="cancel"]').onclick = () => { if (!busyButtonActive(confirmBtn)) close(); };
  confirmBtn.onclick = () => {
    const note = String(noteEl.value || '').trim();
    if (!note) { back.querySelector('[data-err="note"]').textContent = 'יש לציין סיבה'; return; }
    return busyButton(confirmBtn, 'delete', async () => {
      try {
        await voidReceipt(receipt, note);
        close();
      } catch (e) {
        showError('ביטול הקבלה נכשל — ' + e.message);
      }
    });
  };
  if (noteEl.focus) noteEl.focus();
}

async function voidReceipt(receipt, note) {
  // R1: counted in flight and noted on the payments guard.
  const res = await trackedWrite([_paymentsGuard], () => apiPost({ action: 'savePayment', payment: {
    id: receipt.id, patientId: receipt.patientId, patientName: receipt.patientName, houseId: receipt.houseId,
    dueDate: receipt.dueDate, status: PAYMENT_VOID_STATUS, linkPatientUid: '', linkStatus: 'duplicate',
    linkNote: String(note).slice(0, PAYMENT_LINK_NOTE_MAX), timestamp: new Date().toISOString(),
  } }));
  /* R3: «בוטלה» only when the server's copy of THIS receipt reads void — no
   * optimistic fallback. A retry after a lost answer is replayed by the
   * server (replayed:true) with the stored void row. */
  requireSavedId(res, r => r.payment && isVoidPayment(r.payment) && r.payment.id, receipt.id);
  const at = state.receipts.findIndex(x => x.id === receipt.id);
  if (at >= 0) state.receipts[at] = normalizeReceipt(Object.assign({}, res.payment, { cycleId: receipt.cycleId }));
  if (res.cycle) adoptCycleEcho(res.cycle);
  renderBilling();
  showToast('הקבלה בוטלה');
}

/* Put the server's copy of a cycle into state.payments (replace or add). */
function adoptCycleEcho(cycle) {
  const c = normalizePayment(cycle);
  if (!c.id) return;
  const at = state.payments.findIndex(x => x.id === c.id);
  if (at >= 0) state.payments[at] = c; else state.payments.push(c);
}

/* ---- funders ----------------------------------------------------------- */

/* The four funder labels, as stored in the Funders sheet. From the shared
 * rules (lib/payment-report-rules.js), else funder.js's label map — there is
 * no inline copy here. */
function paymentFunderLabels() {
  const rules = paymentReportRules();
  if (rules && Array.isArray(rules.PAYMENT_FUNDERS)) return rules.PAYMENT_FUNDERS.slice();
  const F = funderLib();
  return F ? Object.keys(F.LABEL_TO_KEY) : [];
}

/* The current funder of a patient — mirrors currentFunderFrom_ in Code.gs:
 * the row with the latest effectiveFrom ≤ asOf (same day: the later setAt,
 * then the later row). NO DEFAULT: no row, or an unrecognized label on the
 * effective row → { funder: 'unset', unset: true }. Pure. */
function currentFunderFor(patientId, asOfIso, funders) {
  const known = paymentFunderLabels();
  const id = String(patientId || '').trim();
  const asOf = asOfIso || todayISO();
  let best = null;
  (Array.isArray(funders) ? funders : state.funders).forEach(r => {
    if (!r || !id || r.patientId !== id) return;
    if (!r.effectiveFrom || r.effectiveFrom > asOf) return;
    if (!best || r.effectiveFrom > best.effectiveFrom || (r.effectiveFrom === best.effectiveFrom && r.setAt >= best.setAt)) best = r;
  });
  if (!best || known.indexOf(best.funder) < 0) return { funder: FUNDER_UNSET_KEY, effectiveFrom: '', unset: true };
  return { funder: best.funder, effectiveFrom: best.effectiveFrom, unset: false };
}

/* A patient's funder history, newest first. Pure. */
function funderHistoryFor(patientId, funders) {
  const id = String(patientId || '').trim();
  return (Array.isArray(funders) ? funders : state.funders)
    .filter(r => r && id && r.patientId === id)
    .slice()
    .sort((a, b) => (b.effectiveFrom || '').localeCompare(a.effectiveFrom || '') || (b.setAt || '').localeCompare(a.setAt || ''));
}

/* The text for a current funder: its label, or «לא הוגדר». Pure. */
function funderLabel(cur) {
  return !cur || cur.unset ? FUNDER_UNSET_LABEL : cur.funder;
}

/* The funder cell on the patient card (finance view only). Unset is the
 * amber «לא הוגדר» badge. */
function patientFunderCellHtml(p) {
  if (!funderView() || !patientUid(p)) return '';
  const cur = currentFunderFor(patientUid(p), patientFunderDay(p, todayISO()));
  const value = cur.unset
    ? `<span class="funder-chip funder-unset" data-funder="unset">${escapeHtml(FUNDER_UNSET_LABEL)}</span>`
    : escapeHtml(cur.funder);
  return `<div class="patient-funder" data-finance>
      <span class="p-label">גורם מממן</span>
      <span class="p-val">${value}
        ${state.mode === 'edit' ? '<button type="button" class="btn small funder-edit-btn" title="שינוי גורם מממן">שינוי</button>' : ''}</span>
    </div>`;
}

function openFunderModal(p) {
  if (!funderView() || state.mode !== 'edit') return;
  const uid = patientUid(p);
  if (!uid) { showError('מטופל לא מזוהה — יש לשמור את המטופל קודם'); return; }
  const rules = paymentReportRules();
  const funders = paymentFunderLabels();
  const cur = currentFunderFor(uid);
  const hist = funderHistoryFor(uid).slice(0, 5);
  const root = document.getElementById('modal-root');
  const back = document.createElement('div');
  back.className = 'modal-backdrop';
  back.innerHTML = `
    <div class="modal pay-report-modal funder-modal">
      <h3>גורם מממן — ${escapeHtml(p.name || '')}</h3>
      <p class="pay-report-lead">כרגע: <b>${escapeHtml(funderLabel(cur))}</b>${cur.effectiveFrom ? ' · מ־' + escapeHtml(formatDate(cur.effectiveFrom)) : ''}</p>
      <form novalidate>
        <div class="form-row">
          <label for="funder-select">גורם מממן</label>
          <select id="funder-select" name="funder">
            ${cur.unset ? '<option value="" selected>בחרו…</option>' : ''}
            ${funders.map(f => `<option value="${escapeHtml(f)}" ${f === cur.funder ? 'selected' : ''}>${escapeHtml(f)}</option>`).join('')}
          </select>
          <div class="field-error" data-err="funder" role="alert"></div>
        </div>
        <div class="form-row">
          <label for="funder-from">בתוקף מתאריך</label>
          <input type="date" id="funder-from" name="effectiveFrom" lang="he" dir="rtl" value="${escapeHtml(todayISO())}" />
          <div class="field-error" data-err="effectiveFrom" role="alert"></div>
        </div>
        ${hist.length ? `<div class="funder-history"><span class="p-label">היסטוריה</span><ul>${hist.map(h =>
          `<li>${escapeHtml(h.funder)} · מ־${escapeHtml(formatDate(h.effectiveFrom))}${h.setBy ? ' · ' + escapeHtml(h.setBy) : ''}</li>`).join('')}</ul></div>` : ''}
        <div class="form-actions">
          <button type="button" class="btn" data-action="cancel">ביטול</button>
          <button type="submit" class="btn primary">שמירה</button>
        </div>
      </form>
    </div>`;
  root.appendChild(back);
  const close = () => back.remove();
  const form = back.querySelector('form');
  const submitBtn = back.querySelector('button[type="submit"]');
  // R3: one idempotency key for this form — every retry re-sends it.
  const submissionId = newSubmissionId();
  back.querySelector('[data-action="cancel"]').onclick = () => { if (!busyButtonActive(submitBtn)) close(); };
  form.onsubmit = e => {
    e.preventDefault();
    const funder = String(form.querySelector('[name="funder"]').value || '');
    const effectiveFrom = String(form.querySelector('[name="effectiveFrom"]').value || '');
    const errEl = back.querySelector('[data-err="effectiveFrom"]');
    errEl.textContent = '';
    const funderErr = back.querySelector('[data-err="funder"]');
    if (funderErr) funderErr.textContent = '';
    if (funders.indexOf(funder) < 0) { if (funderErr) funderErr.textContent = FUNDER_REQUIRED_MESSAGE; return; }
    const iso = rules ? rules.parseReportDate(effectiveFrom) : effectiveFrom;
    if (!iso) { errEl.textContent = 'יש לבחור תאריך תחילה תקין'; return; }
    return busyButton(submitBtn, 'save', async () => {
      try {
        await saveFunder(p, funder, iso, submissionId);
        close();
      } catch (err) {
        showError('שמירת הגורם המממן נכשלה — ' + err.message);
      }
    });
  };
}

/* Append ONE Funders row (action=appendFunder). The single write path for
 * the card editor, admission and the fill screen. Finance view only — a
 * restricted session never sends it. */
async function saveFunder(p, funder, effectiveFrom, submissionId) {
  if (!funderView()) throw new Error('אין הרשאה');
  /* R3: one idempotency key per form (the caller keeps it across retries;
   * a one-shot caller gets a fresh one). The server stores it on the Funders
   * row and answers a retry with that row — never a second one. */
  const sid = submissionId || newSubmissionId();
  // R1: funders ride getPayments — counted in flight, noted on that guard.
  const res = await trackedWrite([_paymentsGuard], () =>
    apiPost({ action: 'appendFunder', funder: { patientId: patientUid(p), funder, effectiveFrom, submissionId: sid } }));
  requireSavedId(res, r => r.row && r.row.submissionId, sid);
  const row = normalizeFunderRow(res.row);
  const at = state.funders.findIndex(f => f && f.submissionId === sid);
  if (at >= 0) state.funders[at] = row; else state.funders.push(row);
  renderAll();
  showToast('הגורם המממן נשמר');
  return res;
}

/* ---- the report form ---------------------------------------------------- */

/* What the form opens with, for (patient, cycle row, due date). Pure.
 * → { cycle: the cycle identity reportPayment needs, report: the defaults } */
function paymentReportDefaults(patient, payment, dueDateISO, todayIso) {
  const cov = paymentCoverage(payment);
  const covStart = cov ? isoFromLocalDate(cov.start) : '';
  const covEnd = cov ? isoFromLocalDate(cov.end) : '';
  const expected = Number(payment.amount) || Number(patient && patient.pay) || 0;
  const remaining = Math.max(0, roundMoney(expected - (Number(payment.amountPaid) || 0)));
  const uid = patientUid(patient) || paymentPatientUid(payment);
  return {
    cycle: {
      id: payment.id,
      patientId: payment.patientId || patientKey(patient),
      patientName: payment.patientName || trimName(patient && patient.name),
      houseId: payment.houseId || (patient && patient.houseId) || '',
      dueDate: dueDateISO || payment.dueDate,
      amount: expected,
      coverageStart: covStart,
      coverageEnd: covEnd,
    },
    expected,
    remaining,
    report: {
      receivedDate: todayIso || todayISO(),
      amount: remaining > 0 ? String(remaining) : '',
      method: '',
      payer: '',
      reference: '',
      // No default: an unset funder leaves the field empty, so the report
      // must name one (validatePaymentReport_ → «חסר: גורם מממן»). A
      // pro-bono patient's report names its funder EXPLICITLY too: never
      // prefilled (CHANGELOG-funder-probono.md).
      funder: (cur => (cur.unset || isProbonoLabel(cur.funder) ? '' : cur.funder))(currentFunderFor(uid)),
      coverageStart: covStart,
      coverageEnd: covEnd,
      // «חשבונית?» has NO default: neither כן nor לא is pre-selected.
      invoiceWanted: '',
      invoiceTo: '',
    },
  };
}

/* The issues for a form's values, through the shared rules. Pure. */
function paymentReportIssues(values, todayIso, approver) {
  const rules = paymentReportRules();
  if (!rules || typeof rules.validatePaymentInvoice !== 'function') {
    return [{ field: 'receivedDate', code: 'rules_missing', hebrewMessage: 'טעינת כללי הדיווח נכשלה — רעננו את הדף' }];
  }
  return rules.validatePaymentReport(values, {
    todayIso: todayIso || rules.jerusalemToday(),
    maxDaysBack: approver === true ? 0 : rules.RECEIVED_DATE_STAFF_MAX_DAYS,
  }).concat(rules.validatePaymentInvoice(values));
}

function openPaymentReportModal(patient, payment, dueDateISO) {
  if (!financeView() || state.mode !== 'edit') return;
  if (isVoidPayment(payment)) return;
  const rules = paymentReportRules();
  const methods = rules ? rules.PAYMENT_METHODS : [];
  const funders = paymentFunderLabels();
  const today = rules ? rules.jerusalemToday() : todayISO();
  const d = paymentReportDefaults(patient, payment, dueDateISO, today);
  /* ONE idempotency key per opened form: every send of it — the
   * «כן, קבלה נוספת» re-send and a retry after a lost response included —
   * carries the same id, so the server writes the receipt at most once. */
  const submissionId = newSubmissionId();
  const house = houseById(d.cycle.houseId);
  const root = document.getElementById('modal-root');
  const back = document.createElement('div');
  back.className = 'modal-backdrop';
  const opt = (list, sel, placeholder) => (placeholder ? `<option value="">${placeholder}</option>` : '') +
    list.map(v => `<option value="${escapeHtml(v)}" ${v === sel ? 'selected' : ''}>${escapeHtml(v)}</option>`).join('');
  const err = f => `<div class="field-error" data-err="${f}" id="pr-err-${f}" role="alert"></div>`;
  // <input type="date"> values stay ISO; the two coverage errors share a row.
  const covStart = d.report.coverageStart, covEnd = d.report.coverageEnd;
  const covErrors = err('coverageStart') + err('coverageEnd');
  back.innerHTML = `
    <div class="modal pay-report-modal" role="dialog" aria-labelledby="pr-title">
      <h3 id="pr-title">דווח תשלום</h3>
      <p class="pay-report-lead"><b>${escapeHtml(patient.name || d.cycle.patientName)}</b> · ${escapeHtml(house ? house.name : d.cycle.houseId)}<br>
        מחזור ${dateRangeHeHtml(d.cycle.coverageStart, d.cycle.coverageEnd)} · צפוי ${escapeHtml(fmtShekel(d.expected))}${d.remaining !== d.expected ? ' · יתרה ' + escapeHtml(fmtShekel(d.remaining)) : ''}</p>
      <form novalidate>
        <div class="form-row">
          <label for="pr-receivedDate">תאריך קבלת התשלום *</label>
          <input type="date" id="pr-receivedDate" name="receivedDate" lang="he" dir="rtl" max="${escapeHtml(today)}" value="${escapeHtml(d.report.receivedDate)}" aria-describedby="pr-err-receivedDate" />
          ${err('receivedDate')}
        </div>
        <div class="form-row">
          <label for="pr-amount">סכום שהתקבל (₪, כולל מע״מ) *</label>
          <input type="text" inputmode="decimal" id="pr-amount" name="amount" value="${escapeHtml(d.report.amount)}" aria-describedby="pr-err-amount" />
          ${err('amount')}
        </div>
        <div class="form-row">
          <label for="pr-method">אמצעי תשלום *</label>
          <select id="pr-method" name="method" aria-describedby="pr-err-method">${opt(methods, d.report.method, 'בחרו…')}</select>
          ${err('method')}
        </div>
        <div class="form-row">
          <label for="pr-payer">שם המשלם *</label>
          <input type="text" id="pr-payer" name="payer" maxlength="100" autocomplete="off" value="${escapeHtml(d.report.payer)}" aria-describedby="pr-err-payer" />
          ${err('payer')}
        </div>
        <div class="form-row">
          <label for="pr-reference">מספר אסמכתא <span class="pr-ref-hint">(חובה בהעברה בנקאית ובצ'ק)</span></label>
          <input type="text" id="pr-reference" name="reference" maxlength="40" autocomplete="off" dir="ltr" value="${escapeHtml(d.report.reference)}" aria-describedby="pr-err-reference" />
          ${err('reference')}
        </div>
        <div class="form-row">
          <label for="pr-funder">גורם מממן *</label>
          <select id="pr-funder" name="funder" aria-describedby="pr-err-funder">${opt(funders, d.report.funder, 'בחרו…')}</select>
          ${err('funder')}
        </div>
        <div class="form-row pr-cov-row">
          <label>תקופת כיסוי *</label>
          <div class="pr-cov">
            <input type="date" name="coverageStart" lang="he" dir="rtl" aria-label="תחילת תקופת הכיסוי" value="${escapeHtml(covStart)}" />
            <input type="date" name="coverageEnd" lang="he" dir="rtl" aria-label="סוף תקופת הכיסוי" value="${escapeHtml(covEnd)}" />
          </div>
          ${covErrors}
        </div>
        <fieldset class="form-row pr-invoice" aria-describedby="pr-err-invoiceWanted">
          <legend>חשבונית? *</legend>
          <div class="pr-invoice-choices" role="radiogroup">
            <label class="pr-radio"><input type="radio" name="invoiceWanted" value="yes" /> כן</label>
            <label class="pr-radio"><input type="radio" name="invoiceWanted" value="no" /> לא</label>
          </div>
          ${err('invoiceWanted')}
        </fieldset>
        <div class="form-row pr-invoice-to hidden">
          <label for="pr-invoiceTo">על שם *</label>
          <input type="text" id="pr-invoiceTo" name="invoiceTo" maxlength="120" autocomplete="off" value="" aria-describedby="pr-err-invoiceTo" />
          ${err('invoiceTo')}
        </div>
        <div class="field-error pr-form-error" data-err="_form" role="alert"></div>
        <div class="pr-dup-confirm hidden" role="alertdialog" aria-live="assertive"></div>
        <div class="form-actions">
          <button type="button" class="btn" data-action="cancel">ביטול</button>
          <button type="submit" class="btn primary pr-submit">שמירת הדיווח</button>
        </div>
      </form>
    </div>`;
  root.appendChild(back);

  const form = back.querySelector('form');
  const submitBtn = back.querySelector('.pr-submit');
  const close = () => back.remove();
  back.querySelector('[data-action="cancel"]').onclick = () => { if (!busyButtonActive(submitBtn)) close(); };
  back.addEventListener('click', e => { if (e.target === back && !busyButtonActive(submitBtn)) close(); });

  const ctl = f => form.querySelector('[name="' + f + '"]');
  /* The checked «חשבונית?» radio's value, or '' (none chosen — no default). */
  const invoiceChoice = () => {
    const on = form.querySelector('[name="invoiceWanted"]:checked');
    return on ? String(on.value || '') : '';
  };
  const values = () => {
    const v = {};
    PAYMENT_REPORT_FORM_FIELDS.forEach(f => { v[f] = ctl(f) ? String(ctl(f).value || '').trim() : ''; });
    v.invoiceWanted = invoiceChoice();
    if (v.invoiceWanted !== 'yes') v.invoiceTo = '';   // לא → stored ''
    return v;
  };
  /* כן shows «על שם», prefilled with the payer until the user types a name
   * of their own; לא hides it. */
  const toRow = back.querySelector('.pr-invoice-to');
  let invoiceToEdited = false;
  const syncInvoice = () => {
    const yes = invoiceChoice() === 'yes';
    if (toRow && toRow.classList) toRow.classList.toggle('hidden', !yes);
    const to = ctl('invoiceTo');
    if (yes && to && !invoiceToEdited) to.value = String((ctl('payer') || {}).value || '').trim();
  };
  form.querySelectorAll('[name="invoiceWanted"]').forEach(r => {
    if (r.addEventListener) r.addEventListener('change', () => { syncInvoice(); touched.invoiceWanted = true; touched.invoiceTo = true; paint(check(), touched); });
  });
  if (ctl('invoiceTo') && ctl('invoiceTo').addEventListener) ctl('invoiceTo').addEventListener('input', () => { invoiceToEdited = true; });
  if (ctl('payer') && ctl('payer').addEventListener) ctl('payer').addEventListener('input', syncInvoice);
  const touched = {};
  /* Paint the issues: one Hebrew line under each field, aria-invalid on the
   * control. `only` limits it to the fields the user has touched (live
   * feedback); a submit attempt paints them all. */
  const paint = (issues, only) => {
    const byField = {};
    issues.forEach(i => { if (!byField[i.field]) byField[i.field] = i.hebrewMessage; });
    back.querySelectorAll('[data-err]').forEach(el => {
      const f = el.dataset.err;
      if (f === '_form') return;
      if (only && !only[f]) return;
      el.textContent = byField[f] || '';
      const c = ctl(f);
      if (c && c.setAttribute) {
        if (byField[f]) c.setAttribute('aria-invalid', 'true'); else c.removeAttribute('aria-invalid');
      }
    });
  };
  const check = () => paymentReportIssues(values(), today, state.approver === true);
  PAYMENT_REPORT_FORM_FIELDS.forEach(f => {
    const c = ctl(f);
    if (!c || !c.addEventListener) return;
    const on = () => { touched[f] = true; if (f === 'method') touched.reference = true; paint(check(), touched); };
    c.addEventListener('change', on);
    c.addEventListener('blur', on);
  });

  form.onsubmit = e => {
    e.preventDefault();
    const issues = check();
    back.querySelector('[data-err="_form"]').textContent = '';
    if (issues.length) {
      paint(issues);
      const first = ctl(issues[0].field);
      if (first && first.focus) first.focus();
      return;
    }
    return sendReport(values(), false);
  };
  /* Send the report; confirmDup re-sends it after «כן, קבלה נוספת». */
  const dupBox = back.querySelector('.pr-dup-confirm');
  const hideDup = () => { if (dupBox) { dupBox.innerHTML = ''; dupBox.classList.add('hidden'); } };
  const sendReport = (v, confirmDup) => {
    hideDup();
    return busyButton(submitBtn, 'save', async () => {
      try {
        await submitPaymentReport(d.cycle, v, confirmDup, submissionId);
        close();
        showToast(PAYMENT_REPORT_TOAST);
      } catch (err) {
        const data = err && err.data;
        if (data && data.error === 'possible_duplicate' && !confirmDup && dupBox) {
          // «קיימת כבר קבלה דומה (dd/mm, אסמכתא X). האם זו קבלה נוספת?»
          dupBox.innerHTML = `<p class="pr-dup-text">${escapeHtml(possibleDuplicateText(data.existing))}</p>
            <div class="form-actions">
              <button type="button" class="btn primary" data-action="dup-yes">כן, קבלה נוספת</button>
              <button type="button" class="btn" data-action="dup-no">ביטול</button>
            </div>`;
          dupBox.classList.remove('hidden');
          dupBox.querySelector('[data-action="dup-yes"]').onclick = () => sendReport(v, true);
          dupBox.querySelector('[data-action="dup-no"]').onclick = hideDup;
          const yes = dupBox.querySelector('[data-action="dup-yes"]');
          if (yes && yes.focus) yes.focus();
        } else if (data && Array.isArray(data.issues) && data.issues.length) {
          paint(data.issues);
          back.querySelector('[data-err="_form"]').textContent = data.message || 'הדיווח לא נשמר';
        } else {
          // The modal stays open with every value; never a silent rollback.
          const msg = err && err.message && err.message !== PAYMENT_REPORT_SAVE_FAILED_HE ? ' (' + err.message + ')' : '';
          back.querySelector('[data-err="_form"]').textContent = PAYMENT_REPORT_SAVE_FAILED_HE + msg;
        }
      }
    });
  };
  const first = ctl('amount');
  if (first && first.focus) first.focus();
}

/* «קיימת כבר קבלה דומה (dd/mm, אסמכתא X). האם זו קבלה נוספת?» for the
 * server's possible_duplicate `existing` { id, receivedDate, reference }.
 * Plain text — the caller escapes it. Pure. */
function possibleDuplicateText(existing) {
  const e = existing || {};
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(e.receivedDate || ''));
  const day = m ? `${m[3]}/${m[2]}` : '—';
  const ref = String(e.reference || '').trim();
  return `קיימת כבר קבלה דומה (${day}, ${ref ? 'אסמכתא ' + ref : 'ללא אסמכתא'}). האם זו קבלה נוספת?`;
}

const PAYMENT_REPORT_SAVE_FAILED_HE = 'התשלום לא נשמר — נסי שוב';

/* An idempotency key for one report form: 'sub-' + 32 hex. crypto when the
 * browser has it (every supported one does), Math.random otherwise — it is
 * a dedupe key, not a secret. */
function newSubmissionId() {
  const bytes = new Uint8Array(16);
  const c = typeof crypto !== 'undefined' && crypto && typeof crypto.getRandomValues === 'function' ? crypto : null;
  if (c) c.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return 'sub-' + Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

/* POST reportPayment; on success put the receipt and the re-derived cycle
 * into state and re-render. Nothing is applied optimistically: the money a
 * row shows is always the server's. Throws on refusal (err.data.issues).
 * confirmDuplicate true = Vered answered «כן, קבלה נוספת» to the server's
 * possible_duplicate (the override is audited there). submissionId is the
 * form's idempotency key (newSubmissionId) — a retry never writes twice.
 *
 * CHANGELOG-payment-report-persistence.md:
 *   - "saved" only with proof: ok:true AND the persisted receipt id, else
 *     it throws PAYMENT_REPORT_SAVE_FAILED_HE and the modal stays open;
 *   - counted in _savesInFlight, so the visibility resync never reloads
 *     under it, and a payment write for the freshness guard, so a read that
 *     started before it can never overwrite the echo;
 *   - then a fresh getPayments re-reads the sheet and reconciles. */
async function submitPaymentReport(cycle, values, confirmDuplicate, submissionId) {
  const report = Object.assign({}, values);
  const body = { cycle, report };
  if (confirmDuplicate === true) body.confirmDuplicate = true;
  if (submissionId) body.submissionId = String(submissionId);
  const res = await trackedWrite([_paymentsGuard], () => apiPost({ action: 'reportPayment', report: body }));
  const receiptId = res && res.receipt && res.receipt.id ? String(res.receipt.id) : '';
  if (!receiptId) {
    const err = new Error(PAYMENT_REPORT_SAVE_FAILED_HE);
    err.data = res;
    throw err;
  }
  notePaymentsWrite();
  const at = state.receipts.findIndex(r => r.id === receiptId);   // a replayed retry
  if (at >= 0) state.receipts[at] = normalizeReceipt(res.receipt);
  else state.receipts.push(normalizeReceipt(res.receipt));
  if (res.cycle) adoptCycleEcho(res.cycle);
  renderBilling();
  if (typeof renderDashboard === 'function') renderDashboard();
  // «דווח תשלום» from the «מטופלים» row: its payment column follows.
  renderPatientsTab();
  _paymentsReconcile = reconcilePaymentsAfterWrite(receiptId);
  return res;
}

/* After a confirmed payment write: re-read getPayments (no cache) and adopt
 * the sheet's state — unless another write landed meanwhile (the sequence
 * guard), or the answer does not carry the receipt just confirmed (then the
 * confirmed echo stays). Never throws. → true when applied. */
async function reconcilePaymentsAfterWrite(receiptId) {
  const ticket = beginPaymentsRead();
  try {
    const pr = await apiGet({ action: 'getPayments' });
    if (receiptId && !(Array.isArray(pr && pr.receipts) && pr.receipts.some(r => r && String(r.id) === receiptId))) {
      console.warn('[E-ZONE] reconcile answer lacks the confirmed receipt — keeping the echo');
      return false;
    }
    if (!applyPaymentsRead(ticket, pr)) return false;
    renderBilling();
    if (typeof renderDashboard === 'function') renderDashboard();
    renderPatientsTab();
    return true;
  } catch (e) {
    console.warn('[E-ZONE] post-save reconcile failed:', e && e.message);
    return false;
  }
}

/* Record the link for a row the SERVER's exact match cannot resolve.
 *
 * The division of labour with PR #139: the server resolves `patientUid` from
 * an EXACT triple match, on every write and by a locked backfill over the
 * whole sheet, and leaves the cell blank rather than guess. That covers every
 * row whose triple is intact — which is most of them, and none of the six the
 * reconnect screen exists for.
 *
 * What this adds is the NORMALIZED triple: same house, same entry date, and a
 * name that differs only by a stray space, an invisible character or a case
 * fold. `"שחר חיון "` is that row. It is a match a person would make without
 * hesitating, and it is one the exact matcher will never make, so it is
 * written down as a decision (linkPatientUid) rather than smuggled in as if
 * the triple had been fine all along.
 *
 * DELIBERATELY NOT the house+name tier: it has no date in it, and two
 * admissions of the same person are exactly what it cannot tell apart. Those
 * rows go to the reconnect screen, where a person decides.
 *
 * Returns a COPY when it links, the input untouched otherwise. Never
 * overwrites a link already on the row — that was somebody's decision. */
function withPatientUid(payment, patients) {
  if (!payment || paymentPatientUid(payment)) return payment;
  const m = matchPatientForPayment(payment, Array.isArray(patients) ? patients : []);
  if (!m || m.via !== 'triple_loose') return payment;
  const uid = patientUid(m.patient);
  if (!uid) return payment;
  return Object.assign({}, payment, { linkPatientUid: uid, linkStatus: 'linked' });
}

/* Record what a payment ACTUALLY covered.
 *
 * Writes the two columns on the payment row itself — no override sheet, no
 * second identity — through savePayment(), so this shares the optimistic
 * upsert, the rollback and the error toast with every other payment edit.
 * Blank/blank means "back to the billing cycle": savePayment() re-stamps the
 * inferred window, so the row keeps an explicit period rather than reverting
 * to a blank cell somebody would have to interpret later.
 *
 * The period is validated HERE (shared rule, immediate feedback) and AGAIN in
 * upsertPayment_() on the server, which is the authority — a hand-built
 * request never reaches the sheet unchecked. Only the two columns change:
 * amount, status, amountPaid and balance ride through untouched, so this can
 * never move money, only say which month it belongs to. */
async function saveCoveragePeriod(payment, startISO, endISO) {
  if (state.mode !== 'edit') return;
  const start = String(startISO || '').trim();
  const end   = String(endISO || '').trim();
  const err = coveragePeriodError(start, end);
  if (err) { showError(err); return; }
  const updated = Object.assign({}, payment, {
    coverageStart: start,
    coverageEnd: end,
    timestamp: new Date().toISOString(),
  });
  /* What the row must read back as if the write landed. A blank pair is not
   * stored blank — withDefaultCoverage() stamps the inferred cycle — so the
   * reset case expects that window, not ''. */
  const stamped = withDefaultCoverage(updated);
  const expectStart = isoDate(stamped.coverageStart);
  const expectEnd   = isoDate(stamped.coverageEnd);

  // savePayment() shows its own failure (שמירת גבייה נכשלה) and, with
  // keepEditor, leaves this editor open with the typed dates (R3).
  const saved = await savePayment(updated, { keepEditor: true });
  if (!saved) return;
  // Proven by the server's echo — confirm against what it stored.
  const live = state.payments.find(x => x && x.id === payment.id);
  renderBilling();
  if (live && isoDate(live.coverageStart) === expectStart && isoDate(live.coverageEnd) === expectEnd) {
    showToast(start ? 'תקופת הכיסוי עודכנה' : 'תקופת הכיסוי הוחזרה למחזור החיוב');
  }
}

/* Persist a per-month amount override for the payment record's (patientId,
 * month). SINGLE IDENTITY SOURCE: both key parts come from the normalized
 * payment record itself — patientId (healed in normalizePayment) and
 * monthKey(payment.dueDate) — the exact keys applyBillingOverride looks up
 * with, so the save-key and the overlay lookup-key can never diverge. The
 * workers never recompute patientKey(patient) on their own. The patient's base
 * pay is NEVER touched. Optimistic + rollback, matching the
 * closeLead/dischargePatient pattern; re-writing the same (patientId, month)
 * replaces the amount (deterministic id, backend upsert semantics). */
async function saveBillingOverride(payment, newAmount) {
  if (state.mode !== 'edit') return;
  const pid = payment && payment.patientId;
  if (!pid) return; // no resolvable identity — nothing safe to write
  const month = monthKey(payment.dueDate);
  const record = {
    id: billingOverrideId(pid, month),
    patientId: pid,
    month,
    amount: Number(newAmount) || 0,
    created: todayISO(),
  };

  /* R3: applied only once the server proves it stored THIS override (its
   * id). Nothing is re-rendered before that, so on failure the ✏️ editor
   * stays open with the typed amount. Overrides ride getData, so the write
   * is noted on the data guard (R1). */
  setSaving(true);
  try {
    const res = await trackedWrite([_dataGuard], () => apiPost({ action: 'upsertBillingOverride', override: record }));
    requireSavedId(res, r => r.override && r.override.id, record.id);
    const saved = normalizeBillingOverride(Object.assign({}, record, res.override));
    const idx = state.billingOverrides.findIndex(o => o && o.id === saved.id);
    state.billingOverrides = idx >= 0
      ? state.billingOverrides.map((o, i) => (i === idx ? saved : o))
      : state.billingOverrides.concat([saved]);
    renderBilling();
    showToast('הסכום עודכן לחודש ' + formatMonth(payment.dueDate));
  } catch (e) {
    showError('עדכון הסכום נכשל — ' + e.message);
  } finally {
    setSaving(false);
  }
}

/* Remove the payment record's (patientId, month) override — the row reverts
 * to the base amount. Same single-identity-source rule and optimistic +
 * rollback shape as saveBillingOverride. */
async function clearBillingOverride(payment) {
  if (state.mode !== 'edit') return;
  if (!canDelete()) { showError(ROLE_FORBIDDEN_TEXT); return; }
  const pid = payment && payment.patientId;
  if (!pid) return;
  const month = monthKey(payment.dueDate);
  const existing = billingOverrideFor(state.billingOverrides, pid, month);
  if (!existing) return;

  const prev = state.billingOverrides.slice();
  state.billingOverrides = state.billingOverrides.filter(o => o !== existing);
  renderBilling();

  // Same detachment as saveBillingOverride — the ↩ button is gone by here.
  setSaving(true);
  try {
    const res = await trackedWrite([_dataGuard], () =>
      apiPost({ action: 'deleteBillingOverride', override: { id: existing.id, patientId: pid, month } }));
    // R3: the server names the override it removed (a retry answers the same).
    requireSavedId(res, r => r.deleted === true && r.id, existing.id);
    showToast('הסכום הוחזר לסכום הבסיס');
  } catch (e) {
    state.billingOverrides = prev;
    renderBilling();
    showError('ביטול ההתאמה נכשל — ' + e.message);
  } finally {
    setSaving(false);
  }
}

/* ===== Growth graph (גרף צמיחה) — network-wide growth over time =====
 *
 * Two stacked time-series over ALL houses combined:
 *   Graph 1 — active patient count, WEEKLY (Sunday-start) buckets.
 *   Graph 2 — revenue run-rate, MONTHLY buckets (sum of active patients' pay).
 *
 * MANDATORY date handling: a patient's `date` is already isoDate-normalized to
 * a bare YYYY-MM-DD, but `exitDate` is RAW from getData and may be a full ISO
 * timestamp ("2026-06-22T21:00:00.000Z"). We normalize BOTH through isoDate()
 * first (local-day correct, idempotent on bare dates), THEN do all week/month
 * math on the resulting bare YYYY-MM-DD via parseLocalISO/local Date arithmetic.
 * This avoids the exitDate raw-timestamp UTC off-by-one (a Z-timestamp at 21:00
 * UTC is the NEXT local calendar day in Israel). All comparisons below are on
 * bare YYYY-MM-DD strings, which sort lexicographically == chronologically.
 *
 * The functions are pure (no DOM/I/O) so the bucketing is unit-tested directly. */

/* Normalize a patient to { entry, exit, pay } with both dates as local bare
 * YYYY-MM-DD (exit '' when never released). */
function growthRecord(p) {
  return {
    entry: isoDate((p && p.date) || ''),
    exit:  p && p.exitDate ? isoDate(p.exitDate) : '',
    pay:   Number(p && p.pay) || 0,
  };
}

/* Local date math on bare YYYY-MM-DD — reuses parseLocalISO + isoDate so the
 * result is always a clean local bare date (never a UTC-sliced one). */
function addDaysISO(iso, n) {
  const d = parseLocalISO(iso);
  if (!d) return '';
  d.setDate(d.getDate() + n);
  return isoDate(d);
}

/* The Sunday on or before `iso` (Israeli week starts Sunday; getDay() 0=Sun). */
function weekStartSunday(iso) {
  const d = parseLocalISO(iso);
  if (!d) return '';
  d.setDate(d.getDate() - d.getDay());
  return isoDate(d);
}

/* 'YYYY-MM' month key + first/last calendar day of that month (local). */
function monthKey(iso)      { return String(isoDate(iso)).slice(0, 7); }
function firstDayOfMonth(k) { return k + '-01'; }
function lastDayOfMonth(k) {
  const parts = String(k).split('-');
  const y = Number(parts[0]); const m = Number(parts[1]);
  const last = new Date(y, m, 0).getDate();        // day 0 of next month = last day of m
  return k + '-' + String(last).padStart(2, '0');
}
function nextMonthKey(k) {
  const parts = String(k).split('-');
  let y = Number(parts[0]); let m = Number(parts[1]) + 1;
  if (m > 12) { m = 1; y += 1; }
  return y + '-' + String(m).padStart(2, '0');
}

/* Earliest entry date across the patient list (local bare YYYY-MM-DD, '' when
 * the list is empty / has no parseable entry dates). */
function earliestEntryISO(records) {
  let min = '';
  for (let i = 0; i < records.length; i++) {
    const e = records[i].entry;
    if (!e) continue;
    if (!min || e < min) min = e;
  }
  return min;
}

/* Graph 1 — weekly active counts, Sunday-start, from the earliest entry's week
 * through the week containing today. Active in week [S, E] (E = S+6) iff
 * entry <= E AND (exit === '' OR exit >= S). Network-wide. */
function weeklyActiveCounts(patients, todayIso) {
  const recs = (patients || []).map(growthRecord).filter(r => r.entry);
  if (!recs.length) return [];
  const start = weekStartSunday(earliestEntryISO(recs));
  const lastStart = weekStartSunday(isoDate(todayIso));
  const out = [];
  let S = start;
  let guard = 0;
  while (S && S <= lastStart && guard++ < 10000) {
    const E = addDaysISO(S, 6);
    let count = 0;
    for (let i = 0; i < recs.length; i++) {
      const r = recs[i];
      if (r.entry <= E && (r.exit === '' || r.exit >= S)) count++;
    }
    out.push({ weekStart: S, count: count });
    S = addDaysISO(S, 7);
  }
  return out;
}

/* Graph 2 — monthly revenue run-rate, from the earliest entry's month through
 * the current month. For month M [F, L], sum (pay || 0) over patients with
 * entry <= L AND (exit === '' OR exit >= F). Reuses the dashboard card's
 * sum-of-active-pay; the membership is time-based so EVERY month (incl. the
 * current one) counts anyone active for any part of the month — so the current
 * month's point may exceed the live דשבורד card when there were mid-month
 * releases. Intentional; keeps all buckets consistent. Network-wide. */
function monthlyRevenue(patients, todayIso) {
  const recs = (patients || []).map(growthRecord).filter(r => r.entry);
  if (!recs.length) return [];
  let k = monthKey(earliestEntryISO(recs));
  const lastK = monthKey(isoDate(todayIso));
  const out = [];
  let guard = 0;
  while (k && k <= lastK && guard++ < 10000) {
    const F = firstDayOfMonth(k);
    const L = lastDayOfMonth(k);
    let revenue = 0;
    for (let i = 0; i < recs.length; i++) {
      const r = recs[i];
      if (r.entry <= L && (r.exit === '' || r.exit >= F)) revenue += r.pay;
    }
    out.push({ month: k, revenue: revenue });
    k = nextMonthKey(k);
  }
  return out;
}

/* Choose which x-axis data points get a date label. Returns at most `maxTicks`
 * indices, evenly spaced, ALWAYS including the first (0) and last (n-1) point.
 * Rounding collisions are de-duplicated, so indices are strictly increasing and
 * two labels never land on the same point. Capping the count (the caller derives
 * it from chart width / estimated label width) is what stops the labels — in
 * particular the last two — from overlapping and clipping at the right edge. */
function growthTickIndices(n, maxTicks) {
  if (n <= 0) return [];
  if (n === 1) return [0];
  const cap = Math.max(2, Math.floor(maxTicks) || 2);
  if (n <= cap) {
    const all = [];
    for (let i = 0; i < n; i++) all.push(i);
    return all;
  }
  const out = [];
  let prev = -1;
  for (let k = 0; k < cap; k++) {
    const i = Math.round((k * (n - 1)) / (cap - 1));
    if (i !== prev) { out.push(i); prev = i; }
  }
  return out;
}

/* Build an inline-SVG line chart (no lib, no CDN). Pure string output; every
 * dynamic label is escapeHtml'd. RTL is handled by dir="ltr" on the <svg>; the
 * chart plots time left→right (earliest→latest) which reads naturally under the
 * Hebrew heading above it. x-labels are thinned via growthTickIndices so they
 * never overlap, and the first/last are anchored inward so nothing clips. */
function growthLineChartSVG(series, opts) {
  const o = opts || {};
  // Width-aware: the caller measures the container and passes its width; 760 is
  // the desktop fallback (and keeps the historical 760×240 coordinate box). The
  // viewBox scales to the container via CSS, but the coordinate WIDTH still
  // drives how many x-labels fit — a narrow phone box yields fewer ticks. Height
  // tracks width (~0.316 → 240 at 760) but never drops below 200 so the plot
  // stays legible on a phone. Clamp W to a sane floor so labels never collapse.
  const W = Math.max(280, Math.round(o.width) || 760);
  const H = Math.max(200, Math.round(W * 0.316));
  const padL = 56, padR = 16, padT = 16, padB = 44;
  const innerW = W - padL - padR, innerH = H - padT - padB;
  const n = series.length;
  if (!n) return '<div class="growth-empty">אין נתונים להצגה</div>';

  const vals = series.map(s => s.value);
  const maxV = Math.max.apply(null, vals.concat([0]));
  const yMax = maxV > 0 ? maxV : 1;
  const x = i => padL + (n === 1 ? innerW / 2 : (innerW * i) / (n - 1));
  const y = v => padT + innerH - (innerH * v) / yMax;

  const pts = series.map((s, i) => x(i).toFixed(1) + ',' + y(s.value).toFixed(1)).join(' ');

  // y gridlines / labels at 0, 50%, 100%
  let grid = '';
  [0, 0.5, 1].forEach(f => {
    const v = yMax * f;
    const yy = y(v).toFixed(1);
    grid += '<line x1="' + padL + '" y1="' + yy + '" x2="' + (W - padR) + '" y2="' + yy +
            '" class="growth-grid" />';
    grid += '<text x="' + (padL - 8) + '" y="' + (Number(yy) + 4) +
            '" class="growth-ylabel" text-anchor="end">' +
            escapeHtml(o.fmtY ? o.fmtY(v) : String(Math.round(v))) + '</text>';
  });

  // x labels: evenly spaced, count capped so labels never collide. Budget one
  // label per ~70px of plot width, then honor an optional caller cap. First and
  // last points are always labelled and anchored inward (start / end) so no text
  // renders past the viewBox edge; interior labels stay centered.
  const LABEL_W = 70;
  const widthCap = Math.max(2, Math.floor(innerW / LABEL_W));
  const cap = o.maxXLabels ? Math.min(widthCap, o.maxXLabels) : widthCap;
  let xlabels = '';
  growthTickIndices(n, cap).forEach(i => {
    const anchor = i === 0 ? 'start' : (i === n - 1 ? 'end' : 'middle');
    xlabels += '<text x="' + x(i).toFixed(1) + '" y="' + (H - padB + 18) +
               '" class="growth-xlabel" text-anchor="' + anchor + '">' +
               escapeHtml(series[i].label) + '</text>';
  });

  const dots = series.map((s, i) =>
    '<circle cx="' + x(i).toFixed(1) + '" cy="' + y(s.value).toFixed(1) +
    '" r="2.5" class="growth-dot"><title>' +
    escapeHtml(s.label + ' — ' + (o.fmtY ? o.fmtY(s.value) : s.value)) +
    '</title></circle>'
  ).join('');

  // dir="ltr": the app runs RTL, but the chart's x-axis and numeric/date labels
  // are inherently left-to-right — without this the bidi algorithm can mirror
  // label order and reorder the digits/slashes in the date strings.
  return '<svg viewBox="0 0 ' + W + ' ' + H + '" class="growth-svg" dir="ltr" preserveAspectRatio="xMidYMid meet" role="img">' +
         grid +
         '<polyline points="' + pts + '" class="growth-line" fill="none" />' +
         dots + xlabels +
         '</svg>';
}

/* Render the גרף צמיחה screen: two stacked, separately-scaled SVG charts. */
function renderGrowthGraph() {
  if (!financeView()) return; // restricted view: no billing UI at all
  const host = document.getElementById('growth-graphs');
  if (!host) return;

  const today = todayISO();
  const weekly  = weeklyActiveCounts(state.patients || [], today);
  const monthly = monthlyRevenue(state.patients || [], today);

  if (!weekly.length && !monthly.length) {
    host.innerHTML = '<div class="card growth-empty">אין נתוני מטופלים להצגה</div>';
    return;
  }

  const weeklySeries = weekly.map(w => ({
    value: w.count,
    label: formatDateHe(w.weekStart),
  }));
  const monthlySeries = monthly.map(m => ({
    value: m.revenue,
    label: m.month,
  }));

  const fmtShekel = v => '₪ ' + Math.round(v).toLocaleString('he-IL');

  // Build the card shells first (empty chart slots), then measure each slot's
  // real width and render the SVG into it. Measuring only works once the slot is
  // in the DOM, so this is a two-pass render. maxXLabels: 8 stays as an upper
  // cap for wide desktops; on a narrow phone the width-derived cap dominates.
  host.innerHTML =
    '<div class="card growth-card">' +
      '<div class="growth-title">מספר מטופלים פעילים (שבועי)</div>' +
      '<div class="growth-chart" data-chart="weekly"></div>' +
    '</div>' +
    '<div class="card growth-card">' +
      '<div class="growth-title">הכנסות חודשיות (₪)</div>' +
      '<div class="growth-chart" data-chart="monthly"></div>' +
    '</div>';

  const weeklyHost  = host.querySelector('[data-chart="weekly"]');
  const monthlyHost = host.querySelector('[data-chart="monthly"]');
  weeklyHost.innerHTML  = growthLineChartSVG(weeklySeries,  { maxXLabels: 8, width: growthChartWidth(weeklyHost) });
  monthlyHost.innerHTML = growthLineChartSVG(monthlySeries, { fmtY: fmtShekel, maxXLabels: 8, width: growthChartWidth(monthlyHost) });
}

/* Measured inner width of a chart slot, with a 760 fallback for when the element
 * isn't laid out yet (clientWidth 0) — e.g. the growth screen is still hidden. */
function growthChartWidth(el) {
  const w = el && el.clientWidth ? el.clientWidth : 0;
  return w > 0 ? w : 760;
}

/* Re-render the growth charts on viewport changes so the width-aware SVGs pick
 * up the new container size. Debounced (resize fires in bursts) and gated on the
 * growth screen being the active one, so we don't do work while it's hidden. */
let _growthResizeTimer = null;
function onGrowthViewportChange() {
  if (!financeView()) return; // restricted view: no billing UI at all
  if (state.currentScreen !== 'growth') return;
  clearTimeout(_growthResizeTimer);
  _growthResizeTimer = setTimeout(renderGrowthGraph, 150);
}
if (typeof window !== 'undefined' && window.addEventListener) {
  window.addEventListener('resize', onGrowthViewportChange);
  window.addEventListener('orientationchange', onGrowthViewportChange);
}

/* ===== Helpers ===== */
function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function todayISO() {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}
/* ===== THE date display formatter =====================================
 *
 * formatDateHe(value) → 'DD/MM/YYYY', the Israeli reading order. This is the
 * ONE place a calendar date becomes text for a human, so the whole app reads
 * the same way and a future change happens once.
 *
 * Accepts a bare 'YYYY-MM-DD', a full ISO timestamp, or a Date object.
 *   - '' for null / undefined / '' — a blank date renders blank, and the
 *     caller decides whether that becomes a '—' placeholder;
 *   - the ORIGINAL value back, unchanged, when it cannot be parsed. Never
 *     'NaN', never 'Invalid Date': showing the raw cell is how somebody
 *     notices a corrupted value instead of a plausible-looking wrong date.
 *
 * NO TIMEZONE SHIFT. A bare 'YYYY-MM-DD' is split on its own digits and never
 * handed to `new Date(...)`, which parses that form as UTC MIDNIGHT — and for
 * Israel (UTC+2/+3) renders as the PREVIOUS day. That is the exact −1-day
 * drift this repo has fixed twice already (exitDate, coverage period), and it
 * must not be reintroduced at the display layer. Anything that is not a bare
 * date goes through isoDate(), which reads a timestamp's LOCAL calendar day —
 * the same rule every other reader in this file follows.
 *
 * DISPLAY ONLY. Never call this for a value that is stored in state, posted to
 * /api/sheets, written to Sheets, or put in an <input type="date">: those stay
 * ISO, and isoDate()/isoTime() remain the canonical converters for them. */
function formatDateHe(value) {
  if (value === null || value === undefined || value === '') return '';
  if (typeof value === 'string') {
    const bare = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (bare) return `${bare[3]}/${bare[2]}/${bare[1]}`;
  }
  const iso = isoDate(value);
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return `${m[3]}/${m[2]}/${m[1]}`;
  /* Unparseable. A STRING comes back exactly as given, so a corrupted cell is
   * visible rather than disguised. Anything else (an invalid Date, a number, an
   * object) has no honest text form — String() would print 'Invalid Date' or
   * '[object Object]', which is the very output this must never produce — so it
   * renders BLANK and the caller's own '—' placeholder takes over. */
  return typeof value === 'string' ? value : '';
}

/* A date RANGE for display — 'start – end' as ESCAPED HTML.
 *
 * The start is written FIRST, so in the app's RTL flow it reads on the RIGHT:
 *
 *     ‏<bdi>22/09/2026</bdi> – <bdi>21/10/2026</bdi>
 *      ←—————— reads this way ——————
 *
 * Each date is wrapped in <bdi> so the bidi algorithm treats its digits and
 * slashes as one isolated run and can never reorder them against the Hebrew
 * around it — which is what a bare `dir="ltr"` span used to paper over at the
 * cost of flipping the whole range to start-on-the-left.
 *
 * Returns HTML that is ALREADY escaped — the caller must not escape it again.
 * One blank side renders the other date alone; both blank renders ''. */
function dateRangeHeHtml(startValue, endValue) {
  const a = formatDateHe(startValue);
  const b = formatDateHe(endValue);
  if (!a && !b) return '';
  if (!a || !b) return `<bdi>${escapeHtml(a || b)}</bdi>`;
  return `<bdi>${escapeHtml(a)}</bdi> – <bdi>${escapeHtml(b)}</bdi>`;
}

/* formatDateHe with a '—' placeholder for a blank date. Kept as its own name
 * because ~20 call sites read better with the placeholder built in. */
function formatDate(s) {
  if (!s) return '—';
  return formatDateHe(s) || '—';
}

/* ====================================================
   BREAK-EVEN MODULE
   ====================================================
   Self-contained module: loads expense data from localStorage,
   computes break-even per house and network-wide, and renders
   the dedicated screen. No changes to existing sheet data. */

function loadBreakevenFromStorage() {
  try {
    const raw = localStorage.getItem(BREAKEVEN_STORAGE_KEY);
    if (!raw) return JSON.parse(JSON.stringify(BREAKEVEN_DEFAULTS));
    const parsed = JSON.parse(raw);
    // Ensure every known house has an entry — handles new houses added to HOUSES later.
    const merged = { hqCost: parsed.hqCost ?? BREAKEVEN_DEFAULTS.hqCost, houses: {} };
    HOUSES.forEach(h => {
      const stored = (parsed.houses || {})[h.id];
      const def = BREAKEVEN_DEFAULTS.houses[h.id] || { active: false, fixed: 0, variable: 0 };
      merged.houses[h.id] = stored
        ? { active: !!stored.active, fixed: Number(stored.fixed) || 0, variable: Number(stored.variable) || 0 }
        : { ...def };
    });
    return merged;
  } catch (e) {
    console.warn('[E-ZONE] breakeven load failed, using defaults:', e.message);
    return JSON.parse(JSON.stringify(BREAKEVEN_DEFAULTS));
  }
}

function saveBreakevenToStorage() {
  try {
    localStorage.setItem(BREAKEVEN_STORAGE_KEY, JSON.stringify(state.breakeven));
  } catch (e) {
    console.warn('[E-ZONE] breakeven save failed:', e.message);
  }
}

function initBreakeven() {
  state.breakeven = loadBreakevenFromStorage();

  const resetBtn = document.getElementById('be-reset-btn');
  if (resetBtn) {
    resetBtn.onclick = () => {
      if (!confirm('לאפס את כל נתוני ההוצאות לברירת מחדל?')) return;
      state.breakeven = JSON.parse(JSON.stringify(BREAKEVEN_DEFAULTS));
      saveBreakevenToStorage();
      renderBreakeven();
    };
  }
}

/* ===== Calculations =====
 * Per-house metrics use the patient count and average price from live state.
 * Average price = mean of `pay` across active patients in that house.
 * Falls back to a sensible default per house if no patients yet. */
const PRICE_FALLBACKS = {
  arfoni: 30000, rehab: 30000, asher: 35000,
  pardes: 35000, ramot: 36000, sde:    30000,
};

function avgPricePerHouse(houseId) {
  const inHouse = state.patients.filter(p => p.houseId === houseId && p.status !== 'released' && (p.pay || 0) > 0);
  if (inHouse.length === 0) return PRICE_FALLBACKS[houseId] || 30000;
  const total = inHouse.reduce((s, p) => s + (p.pay || 0), 0);
  return Math.round(total / inHouse.length);
}

function activeCountPerHouse(houseId) {
  return state.patients.filter(p => p.houseId === houseId && p.status !== 'released').length;
}

/* Actual current revenue for a house: the real sum of each active patient's
 * `pay` (תשלום חודשי), NOT count × averaged price. Mirrors activeCountPerHouse's
 * filter exactly — released patients are excluded; active patients with pay 0
 * still count and contribute 0 to the sum. */
function actualRevenuePerHouse(houseId) {
  return state.patients
    .filter(p => p.houseId === houseId && p.status !== 'released')
    .reduce((s, p) => s + (Number(p.pay) || 0), 0);
}

function computeHouseMetrics(house) {
  const be = state.breakeven.houses[house.id] || { active: false, fixed: 0, variable: 0 };
  const fixed = Number(be.fixed) || 0;
  const variable = Number(be.variable) || 0;
  const totalExpenses = fixed + variable;
  const currentPatients = activeCountPerHouse(house.id);
  const capacity = house.capacity;

  // Revenue is reasoned about ex-VAT: `pay` and PRICE_FALLBACKS are stored
  // VAT-inclusive, so divide by VAT_RATE here before any derived math. Every
  // downstream figure (currentPL, maxRevenue, maxPL, breakevenPoint,
  // marginalProfit) then follows automatically from the ex-VAT basis.
  const price = avgPricePerHouse(house.id) / VAT_RATE;

  // Variable cost per patient — used to compute marginal profit.
  // Spread the variable line over max capacity so each occupied bed "absorbs"
  // its expected share. Matches the analysis in the Excel report.
  const variablePerPatient = capacity > 0 ? variable / capacity : 0;
  const marginalProfit = Math.max(0, price - variablePerPatient);

  // Break-even = number of patients needed to cover total house expenses.
  const breakevenPoint = price > 0 ? Math.ceil(totalExpenses / price) : 0;

  // Actual revenue = real sum of active patients' pay, net of VAT.
  const currentRevenue = actualRevenuePerHouse(house.id) / VAT_RATE;
  const currentPL = currentRevenue - totalExpenses;

  // Gross margin as a percentage of ex-VAT revenue. Null when there is no
  // revenue to divide by (avoids a divide-by-zero / meaningless -Infinity%).
  const marginPct = currentRevenue > 0 ? (currentPL / currentRevenue) * 100 : null;
  const maxRevenue = capacity * price;
  const maxPL = maxRevenue - totalExpenses;

  const freeBeds = Math.max(0, capacity - currentPatients);
  const fillPotential = freeBeds * marginalProfit;
  const gapToBreakeven = Math.max(0, breakevenPoint - currentPatients);

  return {
    house,
    active: !!be.active,
    fixed,
    variable,
    totalExpenses,
    price,
    currentPatients,
    capacity,
    variablePerPatient,
    marginalProfit,
    breakevenPoint,
    currentRevenue,
    currentPL,
    marginPct,
    maxRevenue,
    maxPL,
    freeBeds,
    fillPotential,
    gapToBreakeven,
  };
}

function computeNetworkMetrics(activeMetrics) {
  const totalHouseExpenses = activeMetrics.reduce((s, m) => s + m.totalExpenses, 0);
  const hqCost = Number(state.breakeven.hqCost) || 0;
  const totalExpenses = totalHouseExpenses + hqCost;

  const totalRevenueCurrent = activeMetrics.reduce((s, m) => s + m.currentRevenue, 0);
  const totalRevenueMax     = activeMetrics.reduce((s, m) => s + m.maxRevenue, 0);
  const totalPatientsCurrent = activeMetrics.reduce((s, m) => s + m.currentPatients, 0);
  const totalCapacity        = activeMetrics.reduce((s, m) => s + m.capacity, 0);

  const networkPL = totalRevenueCurrent - totalExpenses;
  const networkPLMax = totalRevenueMax - totalExpenses;

  // Houses-only P-L: the sum of each active house's currentPL. Excludes hqCost
  // (unlike networkPL, which subtracts it). Identity: housesPL === networkPL + hqCost.
  const housesPL = totalRevenueCurrent - totalHouseExpenses;

  // Weighted average price (revenue at full capacity / total capacity).
  const avgPrice = totalCapacity > 0 ? totalRevenueMax / totalCapacity : 0;
  const networkBreakeven = avgPrice > 0 ? Math.ceil(totalExpenses / avgPrice) : 0;

  return {
    hqCost,
    totalHouseExpenses,
    totalExpenses,
    totalRevenueCurrent,
    totalRevenueMax,
    totalPatientsCurrent,
    totalCapacity,
    networkPL,
    networkPLMax,
    housesPL,
    avgPrice,
    networkBreakeven,
  };
}

/* ===== Rendering ===== */
function renderBreakeven() {
  if (!state.breakeven) return;

  // Sync HQ input value
  const hqInput = document.getElementById('be-hq-cost');
  if (hqInput) {
    if (document.activeElement !== hqInput) {
      hqInput.value = state.breakeven.hqCost;
    }
    if (state.mode !== 'edit') hqInput.disabled = true;
    hqInput.oninput = e => {
      state.breakeven.hqCost = Number(e.target.value) || 0;
      saveBreakevenToStorage();
      renderBreakevenSummary();
    };
  }

  renderBreakevenActiveHouses();
  renderBreakevenHousesGrid();
  renderBreakevenComparisonTable();
  renderBreakevenActionPlan();
  renderBreakevenSummary();
}

function renderBreakevenActiveHouses() {
  const wrap = document.getElementById('be-active-houses');
  if (!wrap) return;
  wrap.innerHTML = '';
  HOUSES.forEach(h => {
    const be = state.breakeven.houses[h.id];
    const chip = document.createElement('label');
    chip.className = 'be-house-toggle' + (be.active ? ' is-active' : '');
    chip.innerHTML = `
      <input type="checkbox" ${be.active ? 'checked' : ''} ${state.mode === 'edit' ? '' : 'disabled'} />
      <span>${escapeHtml(h.name)}</span>
    `;
    const cb = chip.querySelector('input');
    cb.onchange = () => {
      state.breakeven.houses[h.id].active = cb.checked;
      saveBreakevenToStorage();
      renderBreakeven();
    };
    wrap.appendChild(chip);
  });
}

function renderBreakevenHousesGrid() {
  const grid = document.getElementById('be-houses-grid');
  if (!grid) return;
  grid.innerHTML = '';

  const activeMetrics = HOUSES
    .filter(h => state.breakeven.houses[h.id].active)
    .map(computeHouseMetrics);

  if (activeMetrics.length === 0) {
    grid.innerHTML = '<div class="be-empty">לא נבחרו בתים פעילים. סמני בתים בסעיף "בתים פעילים" למעלה.</div>';
    return;
  }

  activeMetrics.forEach(m => {
    const card = document.createElement('div');
    card.className = 'be-house-card';
    const plClass = m.currentPL >= 0 ? 'positive' : 'negative';
    // Gross margin: one decimal, red when negative, "—" when there's no revenue.
    const marginClass = m.marginPct != null && m.marginPct < 0 ? 'negative' : 'positive';
    const marginText = m.marginPct != null ? `${m.marginPct.toFixed(1)}%` : '—';
    const statusLabel = m.currentPatients >= m.breakevenPoint
      ? `<span class="be-pill positive">עבר נקודת איזון (+${m.currentPatients - m.breakevenPoint})</span>`
      : `<span class="be-pill negative">חסרים ${m.breakevenPoint - m.currentPatients} מטופלים לאיזון</span>`;

    card.innerHTML = `
      <div class="be-house-head">
        <div class="be-house-name">${escapeHtml(m.house.name)}</div>
        ${statusLabel}
      </div>

      <div class="be-grid-2">
        <div class="be-field">
          <label class="be-label">הוצאות קבועות (₪)</label>
          <input class="be-fixed" data-hid="${m.house.id}" type="number" min="0" step="1000" value="${m.fixed}" ${state.mode === 'edit' ? '' : 'disabled'} />
        </div>
        <div class="be-field">
          <label class="be-label">הוצאות משתנות (₪)</label>
          <input class="be-variable" data-hid="${m.house.id}" type="number" min="0" step="1000" value="${m.variable}" ${state.mode === 'edit' ? '' : 'disabled'} />
        </div>
      </div>

      <div class="be-metrics">
        <div class="be-metric">
          <div class="be-metric-label">סהכ הוצאות</div>
          <div class="be-metric-value"><span class="num-ltr">₪ ${m.totalExpenses.toLocaleString('he-IL')}</span></div>
        </div>
        <div class="be-metric">
          <div class="be-metric-label">מחיר ממוצע למטופל (ללא מע"מ)</div>
          <div class="be-metric-value"><span class="num-ltr">₪ ${Math.round(m.price).toLocaleString('he-IL')}</span></div>
        </div>
        <div class="be-metric">
          <div class="be-metric-label">נקודת איזון</div>
          <div class="be-metric-value strong">${m.breakevenPoint} מטופלים</div>
        </div>
        <div class="be-metric">
          <div class="be-metric-label">תפוסה נוכחית</div>
          <div class="be-metric-value">${m.currentPatients} / ${m.capacity}</div>
        </div>
        <div class="be-metric">
          <div class="be-metric-label">רווח שולי למטופל</div>
          <div class="be-metric-value positive"><span class="num-ltr">₪ ${Math.round(m.marginalProfit).toLocaleString('he-IL')}</span></div>
        </div>
        <div class="be-metric">
          <div class="be-metric-label">הכנסה נוכחית (ללא מע"מ)</div>
          <div class="be-metric-value"><span class="num-ltr">₪ ${Math.round(m.currentRevenue).toLocaleString('he-IL')}</span></div>
        </div>
        <div class="be-metric">
          <div class="be-metric-label">רווח/הפסד נוכחי</div>
          <div class="be-metric-value ${plClass}"><span class="num-ltr">₪ ${Math.round(m.currentPL).toLocaleString('he-IL')}</span></div>
        </div>
        <div class="be-metric">
          <div class="be-metric-label">רווח גולמי</div>
          <div class="be-metric-value ${marginClass}">${marginText}</div>
        </div>
      </div>

      <div class="be-fill-row">
        <span class="be-fill-label">מיטות פנויות: <strong>${m.freeBeds}</strong></span>
        <span class="be-fill-label">פוטנציאל ממילוי: <strong>₪ ${Math.round(m.fillPotential).toLocaleString('he-IL')}</strong></span>
      </div>
    `;

    grid.appendChild(card);

    // Wire up input changes
    const fixedInput = card.querySelector('.be-fixed');
    const varInput = card.querySelector('.be-variable');
    fixedInput.oninput = e => {
      state.breakeven.houses[m.house.id].fixed = Number(e.target.value) || 0;
      saveBreakevenToStorage();
      renderBreakevenHousesGrid();
      renderBreakevenComparisonTable();
      renderBreakevenActionPlan();
      renderBreakevenSummary();
    };
    varInput.oninput = e => {
      state.breakeven.houses[m.house.id].variable = Number(e.target.value) || 0;
      saveBreakevenToStorage();
      renderBreakevenHousesGrid();
      renderBreakevenComparisonTable();
      renderBreakevenActionPlan();
      renderBreakevenSummary();
    };
  });

  fitAllStatText(); // scale per-house currency metrics to fit their cells
}

function renderBreakevenComparisonTable() {
  const table = document.getElementById('be-comparison-table');
  if (!table) return;
  const activeMetrics = HOUSES
    .filter(h => state.breakeven.houses[h.id].active)
    .map(computeHouseMetrics);

  if (activeMetrics.length === 0) {
    table.innerHTML = '';
    return;
  }

  const rows = activeMetrics.map(m => {
    const plClass = m.currentPL >= 0 ? 'positive' : 'negative';
    return `
      <tr>
        <td class="be-td-name">${escapeHtml(m.house.name)}</td>
        <td>₪ ${m.totalExpenses.toLocaleString('he-IL')}</td>
        <td>₪ ${Math.round(m.price).toLocaleString('he-IL')}</td>
        <td class="be-td-strong">${m.breakevenPoint}</td>
        <td>${m.currentPatients}</td>
        <td>${m.gapToBreakeven > 0 ? '+' + m.gapToBreakeven : '✓'}</td>
        <td class="positive">₪ ${Math.round(m.marginalProfit).toLocaleString('he-IL')}</td>
        <td class="${plClass}">₪ ${Math.round(m.currentPL).toLocaleString('he-IL')}</td>
      </tr>
    `;
  }).join('');

  // Display-only summary rows. housesPL is the sum of each active house's
  // currentPL (excludes hqCost); hqCost is the network HQ cost shown as-is.
  const net = computeNetworkMetrics(activeMetrics);
  const housesPLClass = net.housesPL >= 0 ? 'positive' : 'negative';

  table.innerHTML = `
    <thead>
      <tr>
        <th>בית</th>
        <th>סהכ הוצאות</th>
        <th>מחיר ממוצע</th>
        <th>נקודת איזון</th>
        <th>נוכחי</th>
        <th>פער</th>
        <th>רווח שולי</th>
        <th>רווח/הפסד</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
    <tfoot>
      <tr>
        <td colspan="7" class="be-td-name">סהכ רווח/הפסד בתים</td>
        <td class="${housesPLClass}">₪ ${Math.round(net.housesPL).toLocaleString('he-IL')}</td>
      </tr>
      <tr>
        <td colspan="7" class="be-td-name">עלות מטה</td>
        <td>₪ ${Math.round(net.hqCost).toLocaleString('he-IL')}</td>
      </tr>
    </tfoot>
  `;
}

function renderBreakevenActionPlan() {
  const wrap = document.getElementById('be-action-plan');
  if (!wrap) return;
  const activeMetrics = HOUSES
    .filter(h => state.breakeven.houses[h.id].active)
    .map(computeHouseMetrics);

  if (activeMetrics.length === 0) {
    wrap.innerHTML = '';
    return;
  }

  // Priority algorithm:
  // 1. First, fill houses below breakeven (sorted by smallest gap → easiest wins)
  // 2. Then, fill remaining beds in houses with highest marginal profit per patient
  const belowBE = activeMetrics
    .filter(m => m.gapToBreakeven > 0)
    .sort((a, b) => a.gapToBreakeven - b.gapToBreakeven);

  const aboveBE = activeMetrics
    .filter(m => m.gapToBreakeven === 0 && m.freeBeds > 0)
    .sort((a, b) => b.marginalProfit - a.marginalProfit);

  const items = [];
  let priority = 1;

  belowBE.forEach(m => {
    const addPatients = m.gapToBreakeven;
    const revenue = addPatients * m.price;
    items.push({
      priority: priority++,
      name: m.house.name,
      from: m.currentPatients,
      to: m.breakevenPoint,
      add: addPatients,
      revenue,
      reason: `${m.house.name} - השלמה לנקודת איזון. הפסקת ההפסד החודשי של ₪ ${Math.round(Math.abs(m.currentPL)).toLocaleString('he-IL')}.`,
    });
    // Then add remaining beds after reaching breakeven
    if (m.capacity > m.breakevenPoint) {
      const addToFull = m.capacity - m.breakevenPoint;
      const revenueFull = addToFull * m.price;
      items.push({
        priority: priority++,
        name: m.house.name,
        from: m.breakevenPoint,
        to: m.capacity,
        add: addToFull,
        revenue: revenueFull,
        reason: `${m.house.name} - השלמה לתפוסה מלאה לאחר איזון. רווח שולי ₪ ${Math.round(m.marginalProfit).toLocaleString('he-IL')} למטופל.`,
      });
    }
  });

  aboveBE.forEach(m => {
    items.push({
      priority: priority++,
      name: m.house.name,
      from: m.currentPatients,
      to: m.capacity,
      add: m.freeBeds,
      revenue: m.freeBeds * m.price,
      reason: `${m.house.name} - הבית עבר איזון. כל מטופל נוסף הוא בעיקר רווח. תרומה שולית ₪ ${Math.round(m.marginalProfit).toLocaleString('he-IL')}.`,
    });
  });

  if (items.length === 0) {
    wrap.innerHTML = '<div class="be-empty">כל הבתים מלאים בתפוסה. אין צעדי מילוי להציע.</div>';
    return;
  }

  const totalAdd = items.reduce((s, x) => s + x.add, 0);
  const totalRevenue = items.reduce((s, x) => s + x.revenue, 0);

  const rows = items.map(x => `
    <tr>
      <td class="be-td-pri">${x.priority}</td>
      <td class="be-td-name">${escapeHtml(x.name)}</td>
      <td>${x.to} ← ${x.from}</td>
      <td>+${x.add}</td>
      <td class="positive">₪ ${Math.round(x.revenue).toLocaleString('he-IL')}</td>
      <td class="be-td-reason">${escapeHtml(x.reason)}</td>
    </tr>
  `).join('');

  wrap.innerHTML = `
    <table class="be-table be-action-table">
      <thead>
        <tr>
          <th>עדיפות</th>
          <th>בית</th>
          <th>מ → ל</th>
          <th>תוספת</th>
          <th>הכנסה חודשית נוספת</th>
          <th>נימוק</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
      <tfoot>
        <tr>
          <td colspan="3" class="be-td-name">סהכ פוטנציאל מילוי</td>
          <td>+${totalAdd}</td>
          <td class="positive be-td-strong">₪ ${Math.round(totalRevenue).toLocaleString('he-IL')}</td>
          <td></td>
        </tr>
      </tfoot>
    </table>
  `;
}

function renderBreakevenSummary() {
  const activeMetrics = HOUSES
    .filter(h => state.breakeven.houses[h.id].active)
    .map(computeHouseMetrics);
  const net = computeNetworkMetrics(activeMetrics);

  const totalEl = document.getElementById('be-total-expenses');
  const pointEl = document.getElementById('be-network-point');
  const plEl    = document.getElementById('be-pl');
  const plSub   = document.getElementById('be-pl-sub');

  if (totalEl) totalEl.textContent = '₪ ' + net.totalExpenses.toLocaleString('he-IL');
  if (pointEl) pointEl.textContent = net.networkBreakeven.toString();
  if (plEl) {
    const v = Math.round(net.networkPL);
    plEl.textContent = (v >= 0 ? '₪ ' : '-₪ ') + Math.abs(v).toLocaleString('he-IL');
    plEl.classList.remove('positive', 'negative');
    plEl.classList.add(v >= 0 ? 'positive' : 'negative');
  }
  if (plSub) {
    const patientGap = net.networkBreakeven - net.totalPatientsCurrent;
    if (net.networkPL >= 0) {
      plSub.textContent = `רווח חודשי - ${net.totalPatientsCurrent} מטופלים פעילים`;
    } else {
      plSub.textContent = `חסרים ${patientGap} מטופלים לאיזון - ${net.totalPatientsCurrent}/${net.networkBreakeven}`;
    }
  }

  fitAllStatText(); // scale the network summary KPI values to fit
}

/* ====================================================
   «בקרת גבייה» — Ortal's verification tab (Phase 4)
   ====================================================
 * Sandra, 2026-10-04 (docs/billing-control-plan.md Phase 4 / §7,
 * CHANGELOG-billing-control-tab.md):
 *   - every receipt Vered reports (a rcpt- row) waits here as «ממתין לאימות»;
 *     Ortal checks the bank herself, outside the system, and marks it
 *     ✓ «אושר בבנק» or ⚑ «לא נמצא / בעיה» (a note is required);
 *   - «סומנו כבעיה»: Vered resolves by cancelling + re-reporting (the existing
 *     flow); Ortal can «הסר דגל» if she was wrong;
 *   - «אומתו»: filterable by month and house — the month's total is the real
 *     revenue figure («הכנסה מאומתת», lib/billing-control-rules.js);
 *   - Sandra (approver) also sees «חריגים פתוחים», read-only.
 * Data: action=billingControlQueue (read), action=confirmPayment (write).
 * Display only: server.js and Code.gs refuse the data and the decision
 * themselves. Vered sees the tab without the decision buttons.
 *
 * Extended 2026-10-06 (CHANGELOG-ortal-verification-status.md): ✓ / ⚑ are
 * replaced by a status dropdown on every row — «שולם» (saved at once),
 * «שולם חלקית» (an amount field: > 0 and < the reported amount, with the
 * remaining balance shown live), «לא שולם» (the existing note form). Partial
 * receipts get their own list and their open rest is shown on the row and in
 * the «יתרה פתוחה» card. Every row also has Ortal's free-text note (≤500),
 * editable at any time. Every value is escaped on render. */

/* The flag-note bounds come from lib/billing-control-rules.js (2–300, the
 * same FLAG_NOTE_MIN / FLAG_NOTE_MAX as Code.gs). */
const BC_FLAG_MIN = (bcRules() && bcRules().FLAG_NOTE_MIN) || 2;
const BC_FLAG_MAX = (bcRules() && bcRules().FLAG_NOTE_MAX) || 300;
const BC_FLAG_LABEL = `מה הבעיה? (${BC_FLAG_MIN} עד ${BC_FLAG_MAX} תווים)`;
const BC_FLAG_EXAMPLE = 'לדוגמה: הגיע 29,500 ולא 30,000, או: לא נמצא בבנק';
const BC_ERRORS = {
  forbidden: 'אין הרשאה לפעולה זו',
  forbidden_role: 'אין הרשאה לפעולה זו',
  flag_note_invalid: 'בסימון «בעיה» חובה לפרט (2 עד 300 תווים)',
  not_found: 'הקבלה לא נמצאה — רעננו את הדף',
  receipt_void: 'הקבלה בוטלה — אין מה לאשר',
  partial_single: '«שולם חלקית» — קבלה אחת בכל פעם',
  partial_amount_invalid: 'בתשלום חלקי חובה להזין סכום שהתקבל (מספר, עד שתי ספרות אחרי הנקודה)',
  partial_amount_range: 'הסכום שהתקבל חייב להיות גדול מאפס וקטן מהסכום שדווח',
  control_note_invalid: 'הערה — טקסט עד 500 תווים',
  control_note_single: 'הערה נשמרת לקבלה אחת בכל פעם',
  confirm_status_invalid: 'סטטוס לא מוכר',
  sheet_header_clash: 'מבנה גיליון התשלומים השתנה — פנו לסנדרה',
  /* «כפילות» (CHANGELOG-receipt-duplicates-and-edit.md). */
  duplicate_single: '«כפילות» — קבלה אחת בכל פעם',
  duplicate_note_invalid: 'בסימון «כפילות» חובה לפרט (2 עד 300 תווים)',
  duplicate_last_receipt: 'זו הקבלה היחידה של המחזור — אי אפשר לסמן אותה ככפילות. אם הכסף לא התקבל, סמנו «לא שולם»',
};
const BC_DUP_LABEL = `למה זו כפילות? (${BC_FLAG_MIN} עד ${BC_FLAG_MAX} תווים)`;
const BC_DUP_EXAMPLE = 'לדוגמה: אותה העברה דווחה פעמיים (אסמכתא 12345)';
/* The dropdown (lib/billing-control-rules.js DECISION_OPTIONS) and the note
 * bound (CONTROL_NOTE_MAX, the same 500 as Code.gs). */
const BC_DECISIONS = (bcRules() && bcRules().DECISION_OPTIONS) || [
  { value: 'confirmed', label: 'שולם' }, { value: 'partial', label: 'שולם חלקית' }, { value: 'flagged', label: 'לא שולם' },
  { value: 'duplicate', label: 'כפילות' },
];
const BC_NOTE_MAX = (bcRules() && bcRules().CONTROL_NOTE_MAX) || 500;
const BC_XLSX_ERRORS = {
  forbidden: 'אין הרשאה לייצוא זה',
  lock_busy: 'המערכת עסוקה, נסו שוב',
  sheets_unreachable: 'הגיליון לא זמין כרגע — נסו שוב',
};

function bcRules() {
  return (typeof globalThis !== 'undefined' && globalThis.BillingControlRules) || null;
}

function billingControlState() {
  if (!state.bc) {
    state.bc = {
      data: null, loading: false, error: '', selected: {}, flagOpen: '', flagDraft: '',
      month: '', house: 'all',
      // «שולם חלקית» amount form and the note editor (one row at a time each).
      partialOpen: '', partialDraft: '', noteOpen: '', noteDraft: '',
      // «כפילות» reason form (one row at a time).
      dupOpen: '', dupDraft: '',
    };
  }
  return state.bc;
}

/* This month in Israel, 'YYYY-MM'. */
function bcThisMonth() {
  return debtAgingTodayIso().slice(0, 7);
}

function bcHouseName(id) {
  const h = houseById(id);
  return (h && h.name) || id || '—';
}

/* A stored stamp ('YYYY-MM-DD' or ISO) → DD/MM/YYYY [HH:MM]. Pure. */
function bcStampHe(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(String(s || ''));
  if (!m) return String(s || '');
  return `${m[3]}/${m[2]}/${m[1]}` + (m[4] ? ` ${m[4]}:${m[5]}` : '');
}

/* Load the queue. Never throws to a caller that does not await it; the
 * error is shown inside the tab. */
async function loadBillingControl() {
  if (state.billingControl === false) return;
  const s = billingControlState();
  s.loading = true;
  s.error = '';
  renderBillingControl();
  setLoading(true);
  const ticket = _billingControlGuard.begin();
  try {
    const data = await apiGet({ action: 'billingControlQueue' });
    // R1: a decision that landed after this read started is newer — keep it.
    if (!_billingControlGuard.isCurrent(ticket)) {
      console.warn('[E-ZONE] billingControlQueue answer discarded — a decision landed after it started');
      return;
    }
    _billingControlGuard.applied(ticket);
    s.data = data;
    // Drop a selection that is no longer waiting.
    const waiting = {};
    (data.receipts || []).forEach(r => { if (r.confirmStatus === 'reported') waiting[r.id] = true; });
    Object.keys(s.selected).forEach(id => { if (!waiting[id]) delete s.selected[id]; });
  } catch (e) {
    if (!(e && e.message === 'unauthorized')) s.error = 'הטעינה נכשלה — ' + ((e && e.message) || 'שגיאה');
  } finally {
    s.loading = false;
    setLoading(false);
    renderBillingControl();
  }
}

/* The decision (confirmPayment). ids: receipt ids; status: 'confirmed' |
 * 'partial' | 'flagged' | 'reported' | '' (a note-only edit). extra:
 * { flagNote, confirmedAmount, controlNote } — a string flagNote is accepted
 * as before. The server's answer replaces the rows on screen. */
async function confirmReceipts(ids, status, extra) {
  if (!state.canConfirm) { showError(ROLE_FORBIDDEN_TEXT); return null; }
  const s = billingControlState();
  const x = typeof extra === 'string' ? { flagNote: extra } : (extra || {});
  const body = { ids: ids.slice() };
  if (status) body.status = status;
  if (status === 'flagged' || status === 'duplicate') body.flagNote = x.flagNote;
  if (status === 'partial') body.confirmedAmount = x.confirmedAmount;
  if (x.controlNote !== undefined) body.controlNote = x.controlNote;
  let res;
  try {
    // R1: counted in flight; the queue and getPayments reads that started
    // before it are discarded (a «כפילות» voids a receipt).
    res = await trackedWrite([_billingControlGuard, _paymentsGuard], () => apiPost({ action: 'confirmPayment', confirm: body }));
  } catch (e) {
    const code = e && e.data && e.data.error;
    showError(BC_ERRORS[code] || (e && e.message) || 'השמירה נכשלה');
    return null;
  }
  /* R3: every id sent must come back — changed, already in that state
   * (unchangedRows: a retry of a decision that landed), or voided. Otherwise
   * nothing is cleared: the drafts and the selection stay on screen. */
  const answered = {};
  (res.changed || []).concat(res.unchangedRows || [], res.voided || [])
    .forEach(r => { if (r && r.id) answered[r.id] = true; });
  if (!ids.every(id => answered[id])) {
    showError(SAVE_UNPROVEN_HE);
    return null;
  }
  const changed = {};
  (res.changed || []).concat(res.unchangedRows || []).forEach(r => { changed[r.id] = r; });
  // «כפילות»: the receipt is void now — it leaves every list and total.
  const voided = {};
  (res.voided || []).forEach(r => { if (r && r.id) voided[r.id] = true; });
  if (s.data && Array.isArray(s.data.receipts)) {
    s.data.receipts = s.data.receipts.filter(r => !voided[r.id])
      .map(r => (changed[r.id] ? Object.assign({}, r, changed[r.id]) : r));
  }
  if (s.dupOpen && ids.indexOf(s.dupOpen) >= 0 && status) { s.dupOpen = ''; s.dupDraft = ''; }
  ids.forEach(id => { delete s.selected[id]; });
  if (s.flagOpen && ids.indexOf(s.flagOpen) >= 0 && status) { s.flagOpen = ''; s.flagDraft = ''; }
  if (s.partialOpen && ids.indexOf(s.partialOpen) >= 0 && status) { s.partialOpen = ''; s.partialDraft = ''; }
  if (s.noteOpen && ids.indexOf(s.noteOpen) >= 0 && x.controlNote !== undefined) { s.noteOpen = ''; s.noteDraft = ''; }
  renderBillingControl();
  const n = (res.changed || []).length;
  showToast(!status ? 'ההערה נשמרה'
    : status === 'confirmed' ? (n === 1 ? 'סומן «שולם»' : `סומנו ${n} קבלות «שולם»`)
    : status === 'partial' ? 'סומן «שולם חלקית» — היתרה נשארת חוב פתוח'
    : status === 'flagged' ? 'סומן «לא שולם» — חוזר לוורד'
    : status === 'duplicate' ? 'סומן «כפילות» — הקבלה בוטלה ואינה נספרת'
    : 'חזר ל«ממתין לאימות»');
  return res;
}

/* The status dropdown of one row. Every option value is fixed; the label is
 * escaped. The current status is preselected; the waiting row starts on a
 * blank «בחרו סטטוס». */
function bcStatusSelectHtml(r) {
  const id = escapeHtml(r.id);
  const cur = String(r.confirmStatus || 'reported');
  const opts = BC_DECISIONS.map(o => `<option value="${escapeHtml(o.value)}"${o.value === cur ? ' selected' : ''}>${escapeHtml(o.label)}</option>`).join('');
  return `<label class="bc-status-wrap"><span class="bc-k">סטטוס</span>
      <select class="bc-status" id="bc-status-${id}" data-bc-status="${id}" aria-label="סטטוס תשלום">
        <option value=""${cur === 'reported' ? ' selected' : ''} disabled>בחרו סטטוס…</option>${opts}
      </select></label>`;
}

/* «יתרה פתוחה: ₪x» — the partial form's live line and the partial row's. */
function bcRemainingText(reported, confirmed) {
  const rest = Math.max(0, Math.round(((Number(reported) || 0) - (Number(confirmed) || 0)) * 100) / 100);
  return 'יתרה פתוחה: ' + fmtShekel(rest);
}

/* The «שולם חלקית» amount form (one row). */
function bcPartialFormHtml(r) {
  const s = billingControlState();
  const id = escapeHtml(r.id);
  const R = bcRules();
  const chk = R && s.partialDraft ? R.partialAmountCheck(s.partialDraft, r.amount) : { amount: null, error: '' };
  return `<div class="bc-partial-form">
      <label for="bc-partial-${id}">כמה התקבל בפועל? (מתוך ${escapeHtml(fmtShekel(r.amount))})</label>
      <input id="bc-partial-${id}" class="bc-partial-input" data-bc-partial-amount="${id}" type="text" inputmode="decimal" autocomplete="off" dir="ltr" value="${escapeHtml(s.partialDraft)}" placeholder="0.00" />
      <div class="bc-remaining" data-bc-remaining="${id}" aria-live="polite">${escapeHtml(bcRemainingText(r.amount, chk.amount || 0))}</div>
      <div class="error-msg bc-partial-error hidden" role="alert"></div>
      <div class="bc-actions">
        <button type="button" class="btn small primary" data-bc-partial-save="${id}">שמירת תשלום חלקי</button>
        <button type="button" class="btn small ghost" data-bc-partial-cancel="${id}">ביטול</button>
      </div>
    </div>`;
}

/* The «כפילות» reason form (one row): a required note, 2–300, like «לא שולם».
 * Saving voids the receipt on the server (Code.gs confirmDuplicate_). */
function bcDuplicateFormHtml(r) {
  const s = billingControlState();
  const id = escapeHtml(r.id);
  return `<div class="bc-dup-form">
      <label for="bc-dup-${id}">${escapeHtml(BC_DUP_LABEL)}</label>
      <textarea id="bc-dup-${id}" class="bc-dup-note" data-bc-dup-note="${id}" maxlength="${BC_FLAG_MAX}" rows="3" placeholder="${escapeHtml(BC_DUP_EXAMPLE)}">${escapeHtml(s.dupDraft)}</textarea>
      <div class="bc-sub">הקבלה תסומן כמבוטלת ולא תיספר ב«נגבה». רק סנדרה יכולה לבטל את הסימון.</div>
      <div class="error-msg bc-dup-error hidden" role="alert"></div>
      <div class="bc-actions">
        <button type="button" class="btn small danger" data-bc-dup-save="${id}">שמירת «כפילות»</button>
        <button type="button" class="btn small ghost" data-bc-dup-cancel="${id}">ביטול</button>
      </div>
    </div>`;
}

/* Ortal's note on one row: the text (escaped) and, for a decider, the editor. */
function bcControlNoteHtml(r, can) {
  const s = billingControlState();
  const id = escapeHtml(r.id);
  const note = String(r.controlNote || '');
  if (can && s.noteOpen === r.id) {
    return `<div class="bc-cnote-form">
      <label for="bc-cnote-${id}">הערה (לא חובה, עד ${BC_NOTE_MAX} תווים)</label>
      <textarea id="bc-cnote-${id}" class="bc-cnote" data-bc-cnote="${id}" maxlength="${BC_NOTE_MAX}" rows="3">${escapeHtml(s.noteDraft)}</textarea>
      <div class="bc-sub bc-cnote-count" data-bc-cnote-count="${id}">${escapeHtml(String(s.noteDraft.length))} / ${BC_NOTE_MAX}</div>
      <div class="error-msg bc-cnote-error hidden" role="alert"></div>
      <div class="bc-actions">
        <button type="button" class="btn small primary" data-bc-cnote-save="${id}">שמירת הערה</button>
        <button type="button" class="btn small ghost" data-bc-cnote-cancel="${id}">ביטול</button>
      </div>
    </div>`;
  }
  const text = note ? `<span class="bc-cnote-text"><b>הערה:</b> ${escapeHtml(note)}</span>` : '';
  const btn = can ? ` <button type="button" class="btn small ghost bc-cnote-open" data-bc-cnote-open="${id}">${note ? '✎ עריכת הערה' : '+ הערה'}</button>` : '';
  return text || btn ? `<div class="bc-cnote-line">${text}${btn}</div>` : '';
}

/* One receipt as a phone-friendly card. mode: 'queue' | 'flagged' |
 * 'partial' | 'confirmed' | 'exception'. Every value is escaped. */
function bcReceiptHtml(r, mode, opts) {
  const o = opts || {};
  const s = billingControlState();
  const isPartial = r.confirmStatus === 'partial';
  // A partial receipt is ALSO listed by month under «אומתו»; its controls live
  // only in «שולם חלקית», so no element id is drawn twice.
  const can = state.canConfirm === true && mode !== 'exception' && !(mode === 'confirmed' && isPartial);
  const id = escapeHtml(r.id);
  const field = (label, value) => `<span class="bc-f"><span class="bc-k">${escapeHtml(label)}</span> <span class="bc-v">${escapeHtml(value || '—')}</span></span>`;
  const R = bcRules();
  const verified = R ? R.verifiedAmountOf(r) : Number(r.verifiedAmount) || 0;
  const open = R ? R.openAmountOf(r) : Number(r.openAmount) || 0;
  /* «אומתו» (CHANGELOG-receipt-duplicates-and-edit.md): «חלק אוקטובר: ₪x ·
   * הקבלה המלאה ₪y (תקופה dd/mm–dd/mm) · שולם במלואו» — «שולם חלקית» only
   * for a partial receipt (lib/billing-control-rules.js confirmedMonthLine). */
  const amount = mode === 'confirmed' && o.inMonth !== undefined
    ? `<span class="bc-month-line">${escapeHtml(R ? R.confirmedMonthLine(r, s.month, o.inMonth, fmtShekel) : fmtShekel(o.inMonth))}</span>`
    : fmtShekel(r.amount);
  let actions = '';
  if (can) {
    const pick = mode === 'queue'
      ? `<label class="bc-pick"><input type="checkbox" data-bc-pick="${id}"${s.selected[r.id] ? ' checked' : ''} aria-label="סימון לאישור"> סמן</label>`
      : '';
    const unflag = mode === 'flagged' ? `<button type="button" class="btn small" data-bc-unflag="${id}">הסר דגל</button>` : '';
    actions = `<div class="bc-actions">${pick}${bcStatusSelectHtml(r)}${unflag}</div>`;
    if (s.flagOpen === r.id) {
      actions += `<div class="bc-flag-form">
        <label for="bc-note-${id}">${escapeHtml(BC_FLAG_LABEL)}</label>
        <textarea id="bc-note-${id}" class="bc-note" data-bc-note="${id}" maxlength="${BC_FLAG_MAX}" rows="3" placeholder="${escapeHtml(BC_FLAG_EXAMPLE)}">${escapeHtml(s.flagDraft)}</textarea>
        <div class="error-msg bc-note-error hidden" role="alert"></div>
        <div class="bc-actions">
          <button type="button" class="btn small primary" data-bc-flag-save="${id}">שמירת «לא שולם»</button>
          <button type="button" class="btn small ghost" data-bc-flag-cancel="${id}">ביטול</button>
        </div>
      </div>`;
    }
    if (s.partialOpen === r.id) actions += bcPartialFormHtml(r);
    if (s.dupOpen === r.id) actions += bcDuplicateFormHtml(r);
  }
  const extra = [];
  if (mode === 'flagged' || (mode === 'exception' && r.flagNote)) {
    extra.push(`<div class="bc-note-text"><b>לא שולם:</b> ${escapeHtml(r.flagNote || '—')}${r.flaggedAt ? ` <span class="bc-sub">(${escapeHtml(bcStampHe(r.flaggedAt))})</span>` : ''}${o.ageDays !== undefined ? ` <span class="bc-sub">· ${escapeHtml(String(o.ageDays))} ימים</span>` : ''}</div>`);
  }
  if (isPartial && mode !== 'exception') {
    extra.push(`<div class="bc-partial-line"><span class="badge bc-partial-badge">שולם חלקית</span> אומת ${escapeHtml(fmtShekel(verified))} מתוך ${escapeHtml(fmtShekel(r.amount))} · <b class="bc-remaining">${escapeHtml(bcRemainingText(r.amount, verified))}</b></div>`);
  } else if (mode === 'flagged' && open > 0) {
    extra.push(`<div class="bc-partial-line"><b class="bc-remaining">${escapeHtml(bcRemainingText(r.amount, 0))}</b></div>`);
  }
  if (mode === 'confirmed' || mode === 'partial') {
    extra.push(`<div class="bc-sub">אומת ע״י ${escapeHtml(r.confirmedBy || '—')}${r.confirmedAt ? ' · ' + escapeHtml(bcStampHe(r.confirmedAt)) : ''}</div>`);
  }
  if (mode !== 'exception') extra.push(bcControlNoteHtml(r, can));
  return `<div class="bc-row bc-row--${escapeHtml(mode)}" data-bc-id="${id}">
    <div class="bc-head"><b class="bc-name">${escapeHtml(r.patientName || '—')}</b> <span class="bc-house">${escapeHtml(bcHouseName(r.houseId))}</span> <span class="bc-amount">${amount}</span></div>
    <div class="bc-fields">
      ${field('התקבל', formatDateHe(r.receivedDate))}
      ${field('אמצעי', r.method)}
      ${field('אסמכתא', r.reference)}
      ${field('משלם', r.payer)}
      ${field('גורם מממן', r.funder)}
      ${field('חשבונית', invoiceLabel(r.invoiceWanted))}
      ${field('על שם', invoiceToLabel(r))}
      ${field('נרשם ע״י', r.recordedBy)}
    </div>
    ${extra.join('')}
    ${actions}
  </div>`;
}

function bcCardsHtml(cards) {
  const c = cards;
  const d = c.debt60;
  const debtMain = d ? `${d.recorded.count} · ${fmtShekel(d.recorded.amount)}` : '—';
  const debtSub = d ? `חוב רשום · ללא רישום: ${d.unrecorded.count} · ${fmtShekel(d.unrecorded.amount)}` : 'לא ניתן לחשב כרגע';
  return `
    <div class="card stat bc-card bc-card--reported"><div class="stat-label">ממתין לאימות</div>
      <div class="stat-value" id="bc-card-reported">${c.reported.count} · ${fmtShekel(c.reported.amount)}</div>
      <div class="stat-sub">דווח וטרם אומת</div></div>
    <div class="card stat bc-card bc-card--flagged"><div class="stat-label">סומנו כבעיה</div>
      <div class="stat-value" id="bc-card-flagged">${c.flagged.count} · ${fmtShekel(c.flagged.amount)}</div>
      <div class="stat-sub">חוזר לוורד</div></div>
    <div class="card stat bc-card bc-card--open"><div class="stat-label">יתרה פתוחה</div>
      <div class="stat-value" id="bc-card-open">${fmtShekel(c.openDebt ? c.openDebt.total : 0)}</div>
      <div class="stat-sub">${escapeHtml(c.openDebt ? `חלקי ${fmtShekel(c.openDebt.partial.amount)} · לא שולם ${fmtShekel(c.openDebt.notReceived.amount)}` : '—')}</div></div>
    <div class="card stat bc-card bc-card--confirmed"><div class="stat-label">אומת החודש</div>
      <div class="stat-value" id="bc-card-confirmed">${fmtShekel(c.confirmedThisMonth.amount)}</div>
      <div class="stat-sub">הכנסה מאומתת · ${escapeHtml(formatMonth(c.confirmedThisMonth.month + '-01'))}</div></div>
    <div class="card stat bc-card bc-card--debt"><div class="stat-label">חובות מעל 60 יום</div>
      <div class="stat-value" id="bc-card-debt">${debtMain}</div>
      <div class="stat-sub">${escapeHtml(debtSub)}</div>
      <button type="button" class="btn small bc-debt-export" id="bc-debt-export">ייצוא חובות לאקסל</button></div>`;
}

/* Sandra's «חריגים פתוחים» — READ-ONLY: no button, no input. */
function bcExceptionsHtml(ex) {
  const e = ex || {};
  const flagged = Array.isArray(e.flaggedOld) ? e.flaggedOld : [];
  const debts = Array.isArray(e.debtsOver60) ? e.debtsOver60 : [];
  const refunds = Array.isArray(e.refundExceptions) ? e.refundExceptions : [];
  const empty = t => `<p class="billing-date-label">${escapeHtml(t)}</p>`;
  const debtRow = d => `<div class="bc-row bc-row--exception"><div class="bc-head"><b class="bc-name">${escapeHtml(d.patientName || '—')}</b> <span class="bc-house">${escapeHtml(bcHouseName(d.houseId))}</span> <span class="bc-amount">${fmtShekel(d.balance)}</span></div>
    <div class="bc-fields"><span class="bc-f"><span class="bc-k">תחילת מחזור</span> <span class="bc-v">${escapeHtml(formatDateHe(d.start))}</span></span>
    <span class="bc-f"><span class="bc-k">ימים</span> <span class="bc-v">${escapeHtml(String(d.days))}</span></span>
    <span class="bc-f"><span class="bc-k">סוג</span> <span class="bc-v">${d.kind === 'recorded' ? 'חוב רשום' : 'ללא רישום'}</span></span></div></div>`;
  const refundRow = x => `<div class="bc-row bc-row--exception"><div class="bc-head"><b class="bc-name">${escapeHtml(x.patientName || '—')}</b> <span class="bc-house">${escapeHtml(bcHouseName(x.houseId))}</span> <span class="bc-amount">${fmtShekel(x.amount)}</span></div>
    <div class="bc-fields"><span class="bc-f"><span class="bc-k">סוג</span> <span class="bc-v">${x.kind === 'over_policy' ? 'זיכוי מעל המדיניות' : 'ממתין להחלטה'}</span></span>
    ${x.kind === 'over_policy' ? `<span class="bc-f"><span class="bc-k">לפי המדיניות</span> <span class="bc-v">${escapeHtml(fmtShekel(x.policyAmount))}</span></span>` : ''}
    ${x.exitDate ? `<span class="bc-f"><span class="bc-k">יציאה</span> <span class="bc-v">${escapeHtml(formatDateHe(x.exitDate))}</span></span>` : ''}
    ${x.payoutDate ? `<span class="bc-f"><span class="bc-k">תשלום</span> <span class="bc-v">${escapeHtml(formatDateHe(x.payoutDate))}</span></span>` : ''}
    ${x.reason ? `<span class="bc-f"><span class="bc-k">סיבה</span> <span class="bc-v">${escapeHtml(x.reason)}</span></span>` : ''}</div></div>`;
  return `
    <h4 class="bc-ex-title">סומנו כבעיה לפני יותר מ־7 ימים <span class="count-pill">${flagged.length}</span></h4>
    ${flagged.length ? flagged.map(r => bcReceiptHtml(r, 'exception', { ageDays: r.ageDays })).join('') : empty('אין')}
    <h4 class="bc-ex-title">חובות מעל 60 יום <span class="count-pill">${debts.length}</span></h4>
    ${debts.length ? debts.map(debtRow).join('') : empty('אין')}
    <h4 class="bc-ex-title">החזרים שממתינים לאישור <span class="count-pill">${refunds.length}</span></h4>
    ${refunds.length ? refunds.map(refundRow).join('') : empty('אין')}`;
}

function renderBillingControl() {
  const screen = document.getElementById('screen-billing-control');
  if (!screen || state.billingControl === false) return;
  const s = billingControlState();
  const R = bcRules();
  const set = (id, html) => { const el = document.getElementById(id); if (el) el.innerHTML = html; };
  const errEl = document.getElementById('bc-error');
  if (errEl) { errEl.textContent = s.error || ''; errEl.classList.toggle('hidden', !s.error); }
  if (!s.data || !R) {
    set('bc-cards', '');
    set('bc-queue', `<p class="billing-date-label">${s.loading ? busyLabelFor('load') : (R ? '' : 'הקובץ לא נטען — רעננו את הדף')}</p>`);
    set('bc-flagged', '');
    set('bc-partial', '');
    set('bc-confirmed', '');
    return;
  }
  const receipts = Array.isArray(s.data.receipts) ? s.data.receipts : [];
  if (!s.month) s.month = bcThisMonth();
  set('bc-cards', bcCardsHtml(R.summaryCards(s.data, bcThisMonth())));

  const queue = R.receiptsByStatus(receipts, 'reported');
  const flagged = R.receiptsByStatus(receipts, 'flagged');
  const partial = R.receiptsByStatus(receipts, 'partial');
  set('bc-queue-count', String(queue.length));
  set('bc-flagged-count', String(flagged.length));
  set('bc-partial-count', String(partial.length));
  set('bc-partial-open', fmtShekel(R.openDebt(receipts).partial.amount));
  set('bc-partial', partial.length ? partial.map(r => bcReceiptHtml(r, 'partial')).join('') : '<p class="billing-date-label">אין קבלות ששולמו חלקית</p>');
  set('bc-queue', queue.length ? queue.map(r => bcReceiptHtml(r, 'queue')).join('') : '<p class="billing-date-label">אין קבלות שממתינות לאימות</p>');
  set('bc-flagged', flagged.length ? flagged.map(r => bcReceiptHtml(r, 'flagged')).join('') : '<p class="billing-date-label">אין קבלות שסומנו כבעיה</p>');

  const bulk = document.getElementById('bc-bulk');
  if (bulk) bulk.classList.toggle('hidden', !(state.canConfirm && queue.length));
  const picked = queue.filter(r => s.selected[r.id]).length;
  const bulkBtn = document.getElementById('bc-bulk-confirm');
  if (bulkBtn && !busyButtonActive(bulkBtn)) {
    bulkBtn.disabled = picked === 0;
    bulkBtn.textContent = picked ? `אשר את כל המסומנים (${picked})` : 'אשר את כל המסומנים';
  }
  const all = document.getElementById('bc-select-all');
  if (all) all.checked = queue.length > 0 && picked === queue.length;

  const monthEl = document.getElementById('bc-month');
  if (monthEl && monthEl.value !== s.month) monthEl.value = s.month;
  const houseEl = document.getElementById('bc-house');
  if (houseEl && !houseEl.options.length) {
    houseEl.innerHTML = `<option value="all">כל הבתים</option>`
      + HOUSES.map(h => `<option value="${escapeHtml(h.id)}">${escapeHtml(h.name)}</option>`).join('');
  }
  if (houseEl) houseEl.value = s.house;
  const v = R.verifiedForMonth(receipts, s.month, s.house);
  set('bc-verified-total', fmtShekel(v.total));
  set('bc-confirmed', v.rows.length
    ? v.rows.map(r => bcReceiptHtml(r, 'confirmed', { inMonth: r.amountInMonth })).join('')
    : '<p class="billing-date-label">אין קבלות שאומתו בחודש הזה</p>');

  const exEl = document.getElementById('bc-exceptions');
  if (exEl) {
    const show = state.approver === true && !!s.data.exceptions;
    exEl.classList.toggle('hidden', !show);
    if (show) set('bc-exceptions-body', bcExceptionsHtml(s.data.exceptions));
  }

  const badge = document.getElementById('bc-badge');
  if (badge) { badge.textContent = String(queue.length); badge.classList.toggle('hidden', !queue.length); }
  if (typeof fitAllStatText === 'function') fitAllStatText();
}

/* Download an .xlsx from one of the tab's export routes. */
async function bcDownload(url, filename) {
  let res;
  try {
    res = await fetch(url, { method: 'GET', credentials: 'same-origin', cache: 'no-store' });
  } catch (_e) {
    throw new Error('אין חיבור לשרת');
  }
  if (res.status === 401) showPinScreen();
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const code = body && body.error;
    throw new Error(res.status === 401 ? 'נדרשת התחברות מחדש' : (BC_XLSX_ERRORS[code] || ('השרת החזיר שגיאה ' + res.status)));
  }
  const blob = await res.blob();
  const href = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = href;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 1000);
}

function exportBillingControlXlsx() {
  return bcDownload('/api/export/billing-control.xlsx', `אימות-${debtAgingTodayIso()}.xlsx`);
}
function exportBillingControlDebtXlsx() {
  const today = debtAgingTodayIso();
  return bcDownload(debtAgingExportUrl(today, 'all', 'all'), `חובות-${today}.xlsx`);
}

/* Wire the tab once (event delegation — the lists re-render). */
function initBillingControlControls() {
  const screen = document.getElementById('screen-billing-control');
  if (!screen || screen._bcWired) return;
  screen._bcWired = true;
  const s = billingControlState();
  const refresh = document.getElementById('bc-refresh');
  if (refresh) refresh.onclick = () => busyButton(refresh, 'load', loadBillingControl);
  const exp = document.getElementById('bc-export');
  if (exp) exp.onclick = () => busyButton(exp, 'load', exportBillingControlXlsx)
    .catch(e => showError('הייצוא נכשל — ' + ((e && e.message) || 'שגיאה')));
  const monthEl = document.getElementById('bc-month');
  if (monthEl) monthEl.onchange = () => { s.month = monthEl.value || bcThisMonth(); renderBillingControl(); };
  const houseEl = document.getElementById('bc-house');
  if (houseEl) houseEl.onchange = () => { s.house = houseEl.value || 'all'; renderBillingControl(); };
  const all = document.getElementById('bc-select-all');
  if (all) all.onchange = () => {
    const R = bcRules();
    const queue = R && s.data ? R.receiptsByStatus(s.data.receipts, 'reported') : [];
    s.selected = {};
    if (all.checked) queue.forEach(r => { s.selected[r.id] = true; });
    renderBillingControl();
  };
  const bulkBtn = document.getElementById('bc-bulk-confirm');
  if (bulkBtn) bulkBtn.onclick = () => {
    const ids = Object.keys(s.selected).filter(id => s.selected[id]);
    if (!ids.length) return Promise.resolve();
    return busyButton(bulkBtn, 'save', () => confirmReceipts(ids, 'confirmed'));
  };

  screen.addEventListener('change', e => {
    const t = e.target;
    const pick = t && t.getAttribute && t.getAttribute('data-bc-pick');
    if (pick) {
      if (t.checked) s.selected[pick] = true; else delete s.selected[pick];
      renderBillingControl();
    }
    const sid = t && t.getAttribute && t.getAttribute('data-bc-status');
    if (sid) onBcStatusChange(t, sid, t.value);
  });
  screen.addEventListener('input', e => {
    const t = e.target;
    if (!t || !t.getAttribute) return;
    if (t.getAttribute('data-bc-note')) s.flagDraft = t.value;
    if (t.getAttribute('data-bc-dup-note')) { s.dupDraft = t.value; bcClearInlineError(t, '.bc-dup-error'); }
    const pid = t.getAttribute('data-bc-partial-amount');
    if (pid) {
      // Live remaining balance — computed by the shared rule, text only.
      s.partialDraft = t.value;
      const r = bcReceiptById(pid);
      const R = bcRules();
      const chk = r && R ? R.partialAmountCheck(t.value, r.amount) : { amount: null };
      const line = t.parentNode && t.parentNode.querySelector('[data-bc-remaining]');
      if (line && r) line.textContent = bcRemainingText(r.amount, chk.amount || 0);
      bcClearInlineError(t, '.bc-partial-error');
    }
    const nid = t.getAttribute('data-bc-cnote');
    if (nid) {
      s.noteDraft = t.value;
      const cnt = t.parentNode && t.parentNode.querySelector('[data-bc-cnote-count]');
      if (cnt) cnt.textContent = `${t.value.length} / ${BC_NOTE_MAX}`;
      bcClearInlineError(t, '.bc-cnote-error');
    }
  });
  screen.addEventListener('click', e => {
    const t = e.target && e.target.closest ? e.target.closest('button') : null;
    if (!t) return;
    const attr = n => t.getAttribute(n);
    if (attr('id') === 'bc-debt-export') {
      busyButton(t, 'load', exportBillingControlDebtXlsx).catch(err => showError('הייצוא נכשל — ' + ((err && err.message) || 'שגיאה')));
    } else if (attr('data-bc-confirm')) {
      busyButton(t, 'save', () => confirmReceipts([attr('data-bc-confirm')], 'confirmed'));
    } else if (attr('data-bc-flag')) {
      s.flagOpen = attr('data-bc-flag');
      s.flagDraft = '';
      renderBillingControl();
      const ta = document.getElementById('bc-note-' + s.flagOpen);
      if (ta && ta.focus) ta.focus();
    } else if (attr('data-bc-flag-cancel')) {
      s.flagOpen = ''; s.flagDraft = '';
      renderBillingControl();
    } else if (attr('data-bc-flag-save')) {
      const id = attr('data-bc-flag-save');
      const R = bcRules();
      const chk = R ? R.flagNoteCheck(s.flagDraft) : { note: s.flagDraft, error: '' };
      if (chk.error) {
        const row = t.closest('.bc-flag-form');
        const err = row && row.querySelector('.bc-note-error');
        const ta = row && row.querySelector('textarea');
        if (err) { err.textContent = chk.error; err.classList.remove('hidden'); }
        if (ta) { ta.setAttribute('aria-invalid', 'true'); if (ta.focus) ta.focus(); }
        return;
      }
      busyButton(t, 'save', () => confirmReceipts([id], 'flagged', chk.note));
    } else if (attr('data-bc-unflag')) {
      busyButton(t, 'save', () => confirmReceipts([attr('data-bc-unflag')], 'reported'));
    } else if (attr('data-bc-dup-cancel')) {
      s.dupOpen = ''; s.dupDraft = '';
      renderBillingControl();
    } else if (attr('data-bc-dup-save')) {
      const id = attr('data-bc-dup-save');
      const R = bcRules();
      const chk = R ? R.flagNoteCheck(s.dupDraft) : { note: s.dupDraft, error: '' };
      if (chk.error) {
        bcInlineError(t, '.bc-dup-form', '.bc-dup-error', 'textarea', BC_ERRORS.duplicate_note_invalid);
        return;
      }
      busyButton(t, 'save', () => confirmReceipts([id], 'duplicate', { flagNote: chk.note }));
    } else if (attr('data-bc-partial-cancel')) {
      s.partialOpen = ''; s.partialDraft = '';
      renderBillingControl();
    } else if (attr('data-bc-partial-save')) {
      const id = attr('data-bc-partial-save');
      const r = bcReceiptById(id);
      const R = bcRules();
      const chk = R && r ? R.partialAmountCheck(s.partialDraft, r.amount) : { amount: null, error: BC_ERRORS.partial_amount_invalid };
      if (chk.error) {
        bcInlineError(t, '.bc-partial-form', '.bc-partial-error', 'input', chk.error);
        return;
      }
      busyButton(t, 'save', () => confirmReceipts([id], 'partial', { confirmedAmount: chk.amount }));
    } else if (attr('data-bc-cnote-open')) {
      const id = attr('data-bc-cnote-open');
      const r = bcReceiptById(id);
      s.noteOpen = id; s.noteDraft = r ? String(r.controlNote || '') : '';
      renderBillingControl();
      const ta = document.getElementById('bc-cnote-' + id);
      if (ta && ta.focus) ta.focus();
    } else if (attr('data-bc-cnote-cancel')) {
      s.noteOpen = ''; s.noteDraft = '';
      renderBillingControl();
    } else if (attr('data-bc-cnote-save')) {
      const id = attr('data-bc-cnote-save');
      const R = bcRules();
      const chk = R ? R.controlNoteCheck(s.noteDraft) : { note: s.noteDraft, error: '' };
      if (chk.error) {
        bcInlineError(t, '.bc-cnote-form', '.bc-cnote-error', 'textarea', chk.error);
        return;
      }
      busyButton(t, 'save', () => confirmReceipts([id], '', { controlNote: chk.note }));
    }
  });
}

/* The receipt on screen with id `id`, or null. */
function bcReceiptById(id) {
  const s = billingControlState();
  const list = s.data && Array.isArray(s.data.receipts) ? s.data.receipts : [];
  return list.find(r => r.id === id) || null;
}

/* An inline Hebrew error under a form; the field gets aria-invalid + focus. */
function bcInlineError(btn, formSel, errSel, fieldSel, text) {
  const form = btn.closest(formSel);
  const err = form && form.querySelector(errSel);
  const field = form && form.querySelector(fieldSel);
  if (err) { err.textContent = text; err.classList.remove('hidden'); }
  if (field) { field.setAttribute('aria-invalid', 'true'); if (field.focus) field.focus(); }
}

/* A field being typed in again drops its stale inline error. */
function bcClearInlineError(field, errSel) {
  const err = field.parentNode && field.parentNode.querySelector(errSel);
  if (err) { err.textContent = ''; err.classList.add('hidden'); }
  field.removeAttribute('aria-invalid');
}

/* The status dropdown moved. «שולם» saves at once; «שולם חלקית» opens the
 * amount form; «לא שולם» opens the note form. The dropdown shows the saved
 * status again until a form is saved (nothing changes silently). */
function onBcStatusChange(sel, id, value) {
  const s = billingControlState();
  if (value === 'confirmed') {
    s.partialOpen = ''; s.flagOpen = ''; s.dupOpen = '';
    sel.disabled = true;
    return confirmReceipts([id], 'confirmed').finally(() => { sel.disabled = false; renderBillingControl(); });
  }
  if (value === 'partial') { s.partialOpen = id; s.partialDraft = ''; s.flagOpen = ''; s.dupOpen = ''; }
  else if (value === 'flagged') { s.flagOpen = id; s.flagDraft = ''; s.partialOpen = ''; s.dupOpen = ''; }
  else if (value === 'duplicate') { s.dupOpen = id; s.dupDraft = ''; s.partialOpen = ''; s.flagOpen = ''; }
  renderBillingControl();
  const focus = document.getElementById((value === 'partial' ? 'bc-partial-' : value === 'duplicate' ? 'bc-dup-' : 'bc-note-') + id);
  if (focus && focus.focus) focus.focus();
  return Promise.resolve();
}

/* ===== Boot ===== */
document.addEventListener('DOMContentLoaded', initPin);
