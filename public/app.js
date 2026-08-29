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

const STATUS_OPTIONS = [
  { id: 'active',   label: 'פעיל' },
  { id: 'trial',    label: 'תקופת ניסיון' },
  { id: 'wait',     label: 'בהמתנה' },
  { id: 'released', label: 'שוחרר' },
];

/* Payment status values are stored in Hebrew in the Payments sheet so the
 * sheet is legible to non-developers. Keep the ids in sync with the values
 * written by savePayment(). */
const PAYMENT_STATUS = [
  { id: 'paid',    label: 'שולם' },
  { id: 'partial', label: 'שולם חלקית' },
  { id: 'unpaid',  label: 'לא שולם' },
];
const PAYMENT_STATUS_ALIASES = {
  'שולם': 'paid', 'paid': 'paid',
  'שולם חלקית': 'partial', 'partial': 'partial',
  'לא שולם': 'unpaid', 'unpaid': 'unpaid',
};

const houseById = id => HOUSES.find(h => h.id === id);
const houseByName = name => HOUSES.find(h => h.name === name);

const state = {
  leads: [],
  irrelevantLeads: [],
  removedLeads: [],
  patients: [],
  dischargedPatients: [],
  payments: [],
  /* Per-patient, per-month overrides of the monthly billing amount (סכום חודשי),
   * returned by getData as `billingOverrides`. One entry per (patientId, month).
   * Foundation phase: populated on load and plumbed through state only — no UI
   * reads it yet. Empty until the first load / on older deploys. */
  billingOverrides: [],
  /* House-id → manager-name roster returned by getData (HOUSE_MANAGERS in
   * Code.gs). Populated in loadAll; the meetingWith dropdown and the meetings
   * board read it instead of hardcoding names. '{}' until the first load. */
  houseManagers: {},
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

/* ===== API ===== */
async function apiGet(params) {
  const qs = new URLSearchParams(params).toString();
  const url = '/api/sheets?' + qs;
  console.log('[E-ZONE] GET →', new URL(url, location.origin).href);
  const res = await fetch(url);
  if (res.status === 401) { showPinScreen(); throw new Error('unauthorized'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    throw new Error(data.message || data.error || ('HTTP ' + res.status));
  }
  return data;
}

async function apiPost(body) {
  const url = '/api/sheets';
  console.log('[E-ZONE] POST →', new URL(url, location.origin).href);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status === 401) { showPinScreen(); throw new Error('unauthorized'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    throw new Error(data.message || data.error || ('HTTP ' + res.status));
  }
  return data;
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
    };

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

/* Save full state to Sheets. Serialized so overlapping calls don't interleave. */
function saveAll() {
  if (state.mode !== 'edit') return Promise.resolve();
  const run = async () => {
    const patients = serializePatients();
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

    return apiPost(payload);
  };
  savePromise = savePromise.then(run, run);
  return savePromise;
}

function showError(msg) {
  const el = document.getElementById('error-banner');
  el.textContent = 'שגיאה: ' + msg;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 6000);
}
function setLoading(on) {
  document.getElementById('loading-banner').classList.toggle('hidden', !on);
}

/* ===== PIN / session =====
 *
 * Auth is a server-signed HttpOnly cookie minted by POST /api/verify-pin. There
 * is no client-trusted "logged in" flag: on load we reveal the app shell and
 * attempt the initial data load; the cookie rides the fetch automatically. If it
 * is missing or expired the server answers 401 and apiGet flips to the PIN
 * screen (see apiGet/apiPost). A correct PIN sets the cookie and re-enters.
 * Single mode — being authenticated means edit access; viewer mode was removed. */

/* Reveal the PIN overlay and hide the app. Called at startup only implicitly
 * (via a 401) and whenever a session expires mid-use. */
function showPinScreen() {
  const pin = document.getElementById('pin-screen');
  const app = document.getElementById('app');
  if (pin) pin.classList.remove('hidden');
  if (app) app.classList.add('hidden');
  const input = document.getElementById('pin-input');
  if (input) { input.value = ''; try { input.focus(); } catch (_) { /* no-op */ } }
}

function revealApp() {
  document.getElementById('pin-screen').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');
}

let _pinPending = false;
async function tryPin() {
  const input = document.getElementById('pin-input');
  const errEl = document.getElementById('pin-error');
  const submitBtn = document.getElementById('pin-submit');
  if (_pinPending) return;
  _pinPending = true;
  submitBtn.disabled = true;
  errEl.classList.add('hidden');
  try {
    const res = await fetch('/api/verify-pin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: input.value }),
    });
    if (res.ok) {          // cookie is now set → enter the app
      enterApp();
      return;
    }
    errEl.classList.remove('hidden');
    input.value = '';
  } catch (_) {
    errEl.classList.remove('hidden');
    input.value = '';
  } finally {
    _pinPending = false;
    submitBtn.disabled = false;
  }
}

/* Startup: wire the PIN form + logout + tabs once, then attempt the authorized
 * initial load. No stored-flag trust — the cookie is the only source of truth. */
function initPin() {
  const input = document.getElementById('pin-input');
  const submitBtn = document.getElementById('pin-submit');
  submitBtn.onclick = tryPin;
  input.addEventListener('keydown', e => { if (e.key === 'Enter') tryPin(); });

  const logoutBtn = document.getElementById('logout');
  if (logoutBtn) logoutBtn.onclick = async () => {
    try { await fetch('/api/logout', { method: 'POST' }); } catch (_) { /* reload anyway */ }
    location.reload();
  };

  initTabs();
  enterApp();
}

function enterApp() {
  state.mode = 'edit';   // single mode: an authenticated user is an editor
  revealApp();
  loadAll();             // getData rides the cookie; a 401 flips to the PIN screen
}

/* ===== Top tabs ===== */
/* Tab / screen order. Mirrors the .tabs nav in index.html exactly (each id has a
 * matching <section id="screen-<id>">). `meetings` is an empty placeholder shell
 * (see index.html #screen-meetings); `retention` is intentionally last. */
const SCREENS = ['dashboard', 'leads', 'meetings', 'occupancy', 'discharged-patients', 'billing', 'breakeven', 'growth', 'retention'];

function initTabs() {
  document.querySelectorAll('.tabs .tab').forEach(btn => {
    btn.onclick = () => {
      document.querySelectorAll('.tabs .tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.currentScreen = btn.dataset.screen;
      SCREENS.forEach(s => {
        document.getElementById('screen-' + s).classList.toggle('hidden', s !== state.currentScreen);
      });
      renderAll();
    };
  });

  document.getElementById('lead-search').addEventListener('input', e => {
    state.leadSearch = String(e.target.value || '').trim().toLowerCase();
    renderKanban();
  });
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
  document.getElementById('add-patient-btn').onclick = openDirectAddPatientModal;

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

  initBreakeven();
}

/* ===== Initial load ===== */
async function loadAll() {
  setLoading(true);
  try {
    let data = await apiGet({ action: 'getData' });

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

    state.leads = rawLeads.map(normalizeLead);
    state.patients = parsePatients(rawPatients);

    /* House-manager roster (HOUSE_MANAGERS, exported by getData_). Keyed by
     * house id. Missing/invalid on older deploys → empty object, so the
     * meetingWith dropdown falls back to a blank default with no options and
     * the meetings board still renders (just no manager names). */
    state.houseManagers = (data.houseManagers && typeof data.houseManagers === 'object' && !Array.isArray(data.houseManagers))
      ? data.houseManagers
      : {};
    console.log('[E-ZONE] houseManagers loaded:', Object.keys(state.houseManagers).length, 'houses');

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

    // Payments live on their own sheet and their own action. A fresh
    // install has no Payments sheet yet — treat any failure as "empty
    // list" so the rest of the app still loads.
    try {
      const pr = await apiGet({ action: 'getPayments' });
      const raw = Array.isArray(pr && pr.payments) ? pr.payments : [];
      state.payments = raw.map(normalizePayment).filter(p => p.id);
      console.log('[E-ZONE] getPayments →', state.payments.length, 'records');
    } catch (err) {
      console.warn('[E-ZONE] getPayments failed, assuming empty:', err.message);
      state.payments = [];
    }

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

    const promoted = promoteEnteredLeads();
    const retired  = retireAdmittedLeads();
    /* Discharge-persistence heal — after promote/retire so a freshly promoted
     * patient is also checked against the audit sheet in the same pass. */
    const healed   = healClobberedDischarges();
    console.log('[E-ZONE] after promote — leads:', state.leads.length, 'patients:', state.patients.length, '(+', promoted.length, 'promoted,', retired.length, 'retired,', healed.length, 'healed)');
    renderAll();

    if ((promoted.length > 0 || retired.length > 0 || healed.length > 0) && state.mode === 'edit') {
      console.log(`[E-ZONE] Persisting ${promoted.length} auto-promoted patient(s) + ${retired.length} retired lead(s) + ${healed.length} healed discharge(s)...`);
      saveAll().catch(e => console.warn('[E-ZONE] auto-promote save failed', e.message));
    }
  } catch (e) {
    console.error('[E-ZONE] loadAll failed:', e);
    showError('טעינת נתונים מהגיליון נכשלה — ' + e.message);
  } finally {
    setLoading(false);
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
    if (d.restored === 'TRUE' || d.restored === true) return;
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
 * (matchActivePatientIndex: houseId + name + date) — the Patients sheet has
 * no id column, so this triple IS row identity. `date` in the key is what
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
    if (!d || d.restored === 'TRUE' || d.restored === true) return;
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

/* The distinct manager names offered in the meetingWith dropdown, in a stable
 * order (HOUSES order first, then any roster entry not tied to a known house).
 * Vered can pick any of them regardless of the lead's house. */
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
  return seen;
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
    managerOptions(roster).map(m => ({ value: m, label: m }))
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
    .catch(() => {
      applied.forEach(({ lead, prev }) => {
        lead.meetingWith = prev || '';
        _meetingWithAutosaveFailed.add(lead.id);     // don't retry this lead again this session
      });
      renderMeetings();                              // revert the board; no kanban re-render
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
 * formatDateDDMMYYYY, time is already isoTime-normalized in meetingsForWeek. */
function meetingWhatsappMessage(m) {
  const base = `נקבעה פגישה: ${m.name || ''}, ${m.houseLabel || ''}, ${formatDateDDMMYYYY(m.date || '')}`;
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
  const date = formatDateDDMMYYYY(dateISO);
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

/* Build the meetingWith modal field. `preselect` is the resolved default (the
 * house manager, or '' → the blank placeholder). Shared by the add and edit
 * lead modals so the option list and blank-default behaviour stay identical. */
function meetingWithField(preselect) {
  return {
    name: 'meetingWith', label: 'נפגש עם', type: 'select',
    value: preselect || '',
    options: [{ value: '', label: '— ללא —' }, ...managerOptions().map(m => ({ value: m, label: m }))],
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
    name:     pickField(p, ['name', 'שם', 'שם מטופל', 'Name']),
    date:     isoDate(pickField(p, ['date', 'תאריך', 'תאריך כניסה', 'entryDate'])),
    pay:      Number(pickField(p, ['pay', 'payment', 'תשלום', 'תשלום חודשי'])) || 0,
    adv:      Number(pickField(p, ['adv', 'advance', 'מקדמה'])) || 0,
    status:   normalizeStatus(pickField(p, ['status', 'סטטוס', 'מצב'])),
    fromLead: pickField(p, ['fromLead', 'from_lead', 'מקור_ליד', 'ליד מקור']),
    exitDate: pickField(p, ['exitDate', 'exit_date', 'תאריך שחרור', 'שחרור']),
    source:   pickField(p, ['source', 'מקור']) || 'lead',
    notes:    pickField(p, ['notes', 'note', 'הערות', 'הערה']),
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
  return base;
}
function cryptoId() {
  return 'id-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
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
function meetingsSummaryHTML(leads) {
  const rows = computeManagerConversion(leads);
  if (!rows.length) return '';
  const items = rows.map(r => `
      <div class="mtg-sum-row">
        <span class="mtg-sum-mgr">${escapeHtml(r.manager)}</span>
        <span class="mtg-sum-sep">·</span><span class="mtg-sum-stat">פגישות: <b>${r.total}</b></span>
        <span class="mtg-sum-sep">·</span><span class="mtg-sum-stat">התקיימו: <b>${r.held}</b></span>
        <span class="mtg-sum-sep">·</span><span class="mtg-sum-stat">נכנסו: <b>${r.converted}</b></span>
        <span class="mtg-sum-sep">·</span><span class="mtg-sum-rate">${r.rate}%</span>
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
  return `
    <div class="mtg-row">
      <span class="mtg-time">${escapeHtml(timeText || m.time || '—')}</span>
      <span class="mtg-name">${escapeHtml(m.name || '—')}</span>
      <span class="mtg-house">${escapeHtml(m.houseLabel || '—')}</span>
      <span class="mtg-with">${escapeHtml(m.meetingWith || '—')}</span>
      <span class="mtg-actions">${outcome}${wa}${edit}</span>
    </div>`;
}

function renderMeetings() {
  const board = document.getElementById('meetings-board');
  if (!board) return;

  if (!state.meetingsWeekStart) state.meetingsWeekStart = weekStartSunday(todayISO());
  const wk = meetingsForWeek(state.leads, state.meetingsWeekStart);

  const rangeLabel = `${formatDateDDMMYYYY(wk.weekStart)} – ${formatDateDDMMYYYY(wk.weekEnd)}`;

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
          <h3 class="mtg-day-head">${escapeHtml(HEBREW_DAYS[d.dow])} · ${escapeHtml(formatDateDDMMYYYY(d.iso))}${todayBadge}</h3>
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
    sel.addEventListener('change', async () => {
      const id = sel.getAttribute('data-mtg-outcome');
      if (!id) return;
      const ok = await updateLead(id, { meetingOutcome: sel.value });
      if (ok) renderMeetings();
    });
  });
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
    .concat(managerOptions().map(name => ({ value: name, label: name })))
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

  let submitting = false;
  form.onsubmit = async e => {
    e.preventDefault();
    if (submitting) return;
    submitting = true;
    submitBtn.disabled = true;
    cancelBtn.disabled = true;
    submitBtn.textContent = 'שומר...';

    const ok = await updateLead(m.id, {
      visitDate: dateInp.value, visitTime: timeInp.value, meetingWith: withInp.value,
    });
    if (ok) {
      close();
      renderMeetings();
      return;
    }
    // updateLead already rolled back + surfaced the error; re-enable for retry.
    submitting = false;
    submitBtn.disabled = false;
    cancelBtn.disabled = false;
    submitBtn.textContent = 'שמור';
  };
}

function renderAll() {
  renderDashboard();
  renderKanban();
  renderMeetings();
  renderIrrelevantLeads();
  renderRemovedLeads();
  renderHouseTabs();
  renderPatients();
  renderDischargedPatients();
  renderBilling();
  renderBreakeven();
  renderGrowthGraph();
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
function confirmRenewPatient(patient, dueDateISO) {
  if (state.mode !== 'edit') return;
  const amount = renewalAmount(patient, dueDateISO);
  showConfirm({
    text: `לחדש תשלום עבור ${patient.name || ''} — ${amount.toLocaleString('he-IL')} ₪ לתאריך ${formatDate(dueDateISO)}?`,
    onConfirm: () => renewPatient(patient, dueDateISO),
  });
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
      <input type="text" data-field="contactRelation" value="${escapeHtml(lead.contactRelation || '')}" placeholder="קשר למטופל" />
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
  const createdDisplay = createdISO ? formatDateDDMMYYYY(createdISO) : '—';
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
    ${stageFields}
    ${state.mode === 'edit' ? leadContactEditHTML(lead) : ''}
    <div class="lc-actions edit-only">
      <button class="btn small" data-action="back" ${idx === 0 ? 'disabled' : ''}>שלב קודם →</button>
      <button class="btn small primary" data-action="next">${nextLabel}</button>
      <button class="btn small" data-action="edit" title="ערוך ליד">✏️</button>
      <button class="lc-irrelevant" title="סגור ליד">סגירת ליד</button>
      <button class="lc-irrelevant lc-remove" title="הסר ליד">הסר</button>
    </div>
  `;

  card.querySelector('[data-action="next"]').onclick = () => advanceLead(lead);
  if (idx > 0) card.querySelector('[data-action="back"]').onclick = () => moveLead(lead, STAGES[idx - 1].id);
  card.querySelector('.lc-irrelevant:not(.lc-remove)').onclick = () => closeLead(lead);
  card.querySelector('.lc-remove').onclick = () => {
    showConfirm({
      text: 'להסיר את הליד? פעולה זו תסיר אותו מהמערכת.',
      confirmLabel: 'כן, הסר',
      danger: true,
      onConfirm: () => removeLead(lead),
    });
  };
  card.querySelector('[data-action="edit"]').onclick = () => openEditLeadModal(lead);

  card.querySelectorAll('[data-field]').forEach(inp => {
    inp.onchange = () => updateLead(lead.id, { [inp.dataset.field]: inp.value });
  });

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
    const applyBilling = () => {
      billOther.style.display = billMode.value === 'other' ? '' : 'none';
      const contactInp = card.querySelector('[data-field="contactPhone"]');
      const contactVal = contactInp ? contactInp.value : lead.contactPhone;
      const resolved = resolveBillingPhone(billMode.value, lead.phone, contactVal, billOther.value);
      updateLead(lead.id, { billingPhone: resolved });
    };
    billMode.addEventListener('change', applyBilling);
    billOther.addEventListener('change', applyBilling);
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
  try {
    await saveAll();
  } catch (e) {
    lead.stage = prev;
    lead.waitlistedAt = prevWaitlistedAt;
    renderAll();
    showError('עדכון שלב נכשל — ' + e.message);
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
function renderDischargedPatients() {
  const list = document.getElementById('discharged-patients-list');
  if (!list) return;
  list.innerHTML = '';

  /* Phase 2e-2: hide rows the user has already restored. Backend writes
   * restored='TRUE' (string) on restorePatient_; Sheets may coerce to bool
   * in some configs, so accept both. The audit row stays in the sheet. */
  const allRows = (state.dischargedPatients || [])
    .filter(d => d.restored !== 'TRUE' && d.restored !== true);

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

      row.appendChild(actions);
    }

    list.appendChild(row);
  });
}

/* Restore path A — back into the leads pipeline as a NEW LEAD. The restore-
 * choice modal is the confirmation step, so this worker runs unconditionally.
 * Optimistic + rollback; errors are handled here (toast) and never thrown. */
async function doRestorePatientAsNewLead(p) {
  if (state.mode !== 'edit') return;
  const newLead = {
    id:       cryptoId(),
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
    await apiPost({ action: 'restorePatient', patient: { ...p, newLeadId: newLead.id } });
    showToast('המטופל הוחזר למסלול לידים חדש');
  } catch (e) {
    state.dischargedPatients = prevDischarged;
    state.leads = prevLeads;
    renderAll();
    showError('שחזור המטופל נכשל — ' + e.message);
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
 * houseId + name + date — NOT by id. Patient ids are session-local (the
 * Patients sheet has no id column; normalizePatient mints a fresh cryptoId on
 * every load), so the audit row's stored id will not match any state.patients
 * id after a reload. The three-field key is the stable discriminator. Returns
 * -1 when no row matches. Pure + tested. */
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
    d && d.restored !== 'TRUE' && d.restored !== true &&
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

  let submitting = false;
  form.onsubmit = async e => {
    e.preventDefault();
    if (submitting) return;
    submitting = true;
    submitBtn.disabled = true;
    cancelBtn.disabled = true;
    submitBtn.textContent = 'שומר...';

    const choice = (new FormData(form).get('restoreChoice') || 'prev_status').toString();
    if (choice === 'new_lead') {
      await doRestorePatientAsNewLead(p);
    } else {
      await doRestorePatientToActive(p);
    }
    close();
  };
}

/* Optimistic restore-to-active. Two persisted writes, in this order:
 *   1. saveAll() — re-activates the patient row via replaceHousePatients_
 *      (the Patients sheet has no dedicated action; status flips there). This
 *      is the IMPORTANT record, so it goes first.
 *   2. restorePatientToActive action — flags the audit row restored='TRUE' on
 *      the discharged sheet so it leaves the tab. Cosmetic; goes second.
 * On any failure BOTH optimistic changes roll back (previous refs restored).
 * If write 2 fails after write 1 persisted, the patient is already active on
 * the sheet and the audit row just reappears on reload — re-clicking restore is
 * idempotent (the match flips an already-active row in place, no duplicate). */
async function doRestorePatientToActive(p) {
  const prevPatients   = state.patients;
  const prevDischarged = state.dischargedPatients.slice();

  const { patients } = buildRestoredToActivePatients(state.patients, p);
  state.patients = patients;
  // Flag the audit row locally so renderDischargedPatients' restored-filter
  // hides it; the row object stays in state as the audit trail.
  state.dischargedPatients = state.dischargedPatients.map(d =>
    d.id === p.id ? Object.assign({}, d, { restored: 'TRUE' }) : d);
  renderAll();

  try {
    await saveAll();
    await apiPost({ action: 'restorePatientToActive', patient: { ...p, restored: 'TRUE' } });
  } catch (e) {
    state.patients = prevPatients;
    state.dischargedPatients = prevDischarged;
    renderAll();
    showError('החזרת המטופל לסטטוס הקודם נכשלה — ' + e.message);
    return;
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

/* Run an async action with the triggering button disabled and marked busy
 * (.busy adds the inline spinner), so a slow Apps Script round-trip can't be
 * double-fired. Restores the button's state when the action settles — success
 * or failure alike; a rejection propagates to the caller after the restore.
 * No-op passthrough when btn is falsy. */
async function withBusyButton(btn, fn) {
  if (!btn) return fn();
  const prevDisabled = btn.disabled;
  btn.disabled = true;
  btn.classList.add('busy');
  try {
    return await fn();
  } finally {
    btn.disabled = prevDisabled;
    btn.classList.remove('busy');
  }
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
  let busy = false;
  cancelBtn.onclick = () => { if (!busy) close(); };
  back.addEventListener('click', e => { if (e.target === back && !busy) close(); });

  confirmBtn.onclick = async () => {
    if (busy) return;
    busy = true;
    cancelBtn.disabled = true;
    confirmBtn.disabled = true;
    confirmBtn.classList.add('busy');
    try { await onConfirm(); }
    catch (err) {
      console.error('[E-ZONE] confirm onConfirm threw:', err);
      showError(err.message || 'הפעולה נכשלה');
    }
    close();
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

  let submitting = false;
  form.onsubmit = async e => {
    e.preventDefault();
    if (submitting) return;
    const picked = Array.from(radios).find(x => x.checked);
    if (!picked) return;                 // defensive — submit was disabled
    submitting = true;
    submitBtn.disabled = true;
    cancelBtn.disabled = true;
    submitBtn.textContent = 'שומר...';

    const fd = new FormData(form);
    const disposition = (fd.get('disposition')         || '').toString();
    const note        = (fd.get('not_relevant_note')   || '').toString();
    const payload     = { disposition, note };
    if (dateField) {
      payload[dateField.name] = (fd.get(dateField.name) || '').toString();
    }

    try {
      await onConfirm(payload);
      close();
    } catch (err) {
      console.error('[E-ZONE] close-lead onConfirm threw:', err);
      showError(err.message || 'הפעולה נכשלה');
      submitting = false;
      submitBtn.disabled = false;
      cancelBtn.disabled = false;
      submitBtn.textContent = 'אישור';
    }
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
      { name: 'contactRelation', label: 'קשר למטופל', type: 'text' },
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
        const lead = normalizeLead({
          id, ...vals, billingPhone,
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
      { name: 'contactRelation', label: 'קשר למטופל',  type: 'text', value: lead.contactRelation || '' },
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
      lead.contactRelation = (v.contactRelation || '').trim();
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
    ],
    submitLabel: 'אשר כניסה',
    onSubmit: async v => {
      if (!v.houseId || !v.date || !v.pay) { showError('שדות חסרים'); return false; }
      const patient = normalizePatient({
        id: cryptoId(),
        houseId: v.houseId,
        name: lead.name,
        date: v.date,
        pay: Number(v.pay),
        adv: Number(v.adv),
        status: v.status || 'trial',
        fromLead: lead.id,
      });
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
        await saveAll();
      } catch (e) {
        state.patients = state.patients.filter(p => p.id !== patient.id);
        lead.stage = prevStage;
        lead.meetingOutcome = prevOutcome;
        renderAll();
        showError('שמירה נכשלה — ' + e.message);
        return false;
      }
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
function openDirectAddPatientModal() {
  showModal({
    title: 'הוספת מטופל ישירות',
    fields: [
      { name: 'name', label: 'שם מטופל', type: 'text', required: true },
      { name: 'houseId', label: 'בית', type: 'select', required: true,
        value: state.currentHouseTab || HOUSES[0].id,
        options: HOUSES.map(h => ({ value: h.id, label: h.name })) },
      { name: 'date', label: 'תאריך כניסה', type: 'date', required: true,
        value: todayISO() },
      { name: 'pay', label: 'סכום חודשי (₪)', type: 'number', required: true,
        value: '29000' },
      { name: 'status', label: 'סטטוס', type: 'select',
        value: 'active',
        options: [
          { value: 'active',   label: 'פעיל' },
          { value: 'released', label: 'יצא' },
        ] },
      { name: 'notes', label: 'הערות', type: 'textarea' },
    ],
    submitLabel: 'הוסף מטופל',
    onSubmit: async v => {
      if (!v.name || !v.houseId || !v.date || !v.pay) {
        showError('שדות חובה חסרים');
        return false;
      }
      const patient = normalizePatient({
        id: cryptoId(),
        houseId: v.houseId,
        name: v.name.trim(),
        date: v.date,
        pay: Number(v.pay) || 0,
        adv: 0,
        status: v.status || 'active',
        fromLead: '',
        source: 'direct_admin',
        notes: (v.notes || '').trim(),
      });
      state.patients.unshift(patient);
      // Jump to the house the new patient landed in so the admin can
      // immediately verify the record appeared.
      state.currentHouseTab = patient.houseId;
      renderAll();
      try {
        await saveAll();
      } catch (e) {
        state.patients = state.patients.filter(x => x.id !== patient.id);
        renderAll();
        showError('שמירה נכשלה — ' + e.message);
        return false;
      }
      return true;
    }
  });
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
      const houseChanged = p.houseId !== v.houseId;
      p.name    = v.name.trim();
      p.houseId = v.houseId;
      p.date    = v.date;
      p.pay     = Number(v.pay) || 0;
      p.status  = v.status || 'active';
      p.notes   = (v.notes || '').trim();
      if (houseChanged) state.currentHouseTab = p.houseId;
      renderAll();
      try {
        await saveAll();
      } catch (e) {
        Object.assign(p, prev);
        renderAll();
        showError('שמירה נכשלה — ' + e.message);
        return false;
      }
      return true;
    }
  });
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
    row.className = 'patient-row' + (isReleased ? ' released' : '');
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
      <div class="row-actions edit-only">
        ${isReleased
          ? `<button class="btn small primary" data-action="restore">שחזר</button>`
          : `<button class="btn small" data-action="release">שחרר</button>`}
        <button class="btn small danger" data-action="delete" title="מחק לצמיתות">✕</button>
        <button class="btn small" data-action="edit" title="ערוך מטופל">✏️</button>
      </div>
    `;

    row.querySelector('[data-action="edit"]').onclick = () => openEditPatientModal(p);
    const releaseBtn = row.querySelector('[data-action="release"]');
    if (releaseBtn) releaseBtn.onclick = () => dischargePatient(p);
    /* Released rows (visible only under הצג משוחררים) restore through the SAME
     * choice modal as the discharged tab, bridged to that row's audit record. */
    const restoreBtn = row.querySelector('[data-action="restore"]');
    if (restoreBtn) restoreBtn.onclick = () =>
      showRestorePatientChoiceModal(auditRowForReleasedPatient(p, state.dischargedPatients));
    row.querySelector('[data-action="delete"]').onclick = e =>
      withBusyButton(e.currentTarget, () => deletePatient(p));

    list.appendChild(row);
  });
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
function dischargePatient(p) {
  if (state.mode !== 'edit') return;

  showCloseLeadModal({
    title: 'שחרור מטופל',
    dispositions: DISCHARGE_DISPOSITIONS,
    dateField: { name: 'dischargeDate', label: 'תאריך שחרור' },
    onConfirm: async ({ disposition, note, dischargeDate }) => {
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

      const auditRow = dischargeAuditRow(p, { disposition, note, dischargeDate });
      const exitDate = auditRow.exitDate;
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
      try {
        await apiPost({ action: 'dischargePatient', patient: auditRow });
      } catch (e) {
        // Nothing persisted yet — a full rollback is truthful.
        rollback();
        showError('שחרור המטופל נכשל — לא נשמר. ' + e.message);
        throw e;
      }

      try {
        await saveAll();
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
    },
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

async function deletePatient(p) {
  if (!confirm(`למחוק לצמיתות את ${p.name}?`)) return;
  const prev = state.patients.slice();
  state.patients = state.patients.filter(x => x.id !== p.id);
  renderAll();
  try {
    await saveAll();
  } catch (e) {
    state.patients = prev;
    renderAll();
    showError('מחיקה נכשלה — ' + e.message);
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
  const submitOriginalLabel = submitBtn.textContent;

  cancelBtn.onclick = close;
  back.addEventListener('click', e => { if (e.target === back) close(); });

  let submitting = false;
  back.querySelector('form').onsubmit = async e => {
    e.preventDefault();
    if (submitting) return;              // double-click guard
    submitting = true;
    submitBtn.disabled = true;
    cancelBtn.disabled = true;
    submitBtn.textContent = 'שומר...';

    const fd = new FormData(e.target);
    const values = {};
    fields.forEach(f => {
      if (!f.name) return;   // section headers carry no value
      values[f.name] = (fd.get(f.name) || '').toString();
    });

    try {
      const ok = await onSubmit(values);
      if (ok !== false) { close(); return; }
    } catch (err) {
      console.error('[E-ZONE] modal submit threw:', err);
      showError(err.message || 'שמירה נכשלה');
    }
    // Save failed or was rejected — re-enable so the user can retry.
    submitting = false;
    submitBtn.disabled = false;
    cancelBtn.disabled = false;
    submitBtn.textContent = submitOriginalLabel;
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

function patientKey(p) {
  // Stable identifier for a patient across sessions. The sheet doesn't
  // persist the per-session id; house + name + entry-date is effectively
  // unique and won't drift under normal edits.
  return `${p.houseId}::${p.name || ''}::${p.date || ''}`;
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
  };
}

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

function dayOfMonth(iso) {
  if (!iso) return null;
  const parts = String(iso).slice(0, 10).split('-');
  if (parts.length < 3) return null;
  const day = parseInt(parts[2], 10);
  return isNaN(day) ? null : day;
}

function monthKey(iso) {
  // "YYYY-MM" extracted from an ISO date string.
  return String(iso || '').slice(0, 7);
}

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
    patientName: patient.name,
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

function patientsDueOn(dateISO) {
  const d = dayOfMonth(dateISO);
  if (!d) return [];
  return activePatients().filter(p => {
    const pd = dayOfMonth(p.date);
    return pd === d;
  });
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
    if (pay.status === 'paid' || pay.status === 'partial') return;
    out.push({ patient: p, dueISO });
  });
  return out.sort((a, b) => a.dueISO.localeCompare(b.dueISO));
}

/* Dashboard strip — "X מטופלים ממתינים לתשלום". Hidden at zero; the click
 * navigation to the גבייה tab is wired once in initTabs. */
function renderOverdueAlert() {
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
    if (pay.status === 'paid' || pay.status === 'partial') return;
    out.push({ patient: p, renewalISO, days });
  });
  return out.sort((a, b) => a.renewalISO.localeCompare(b.renewalISO));
}

/* The payment may exist on Sheets without a matching patient (e.g., the
 * patient was released after a payment was recorded). We still want to show
 * those records in "open balances" so the money isn't forgotten. */
function findPatientForPayment(pay) {
  if (pay.patientId) {
    const direct = state.patients.find(p => patientKey(p) === pay.patientId);
    if (direct) return direct;
  }
  if (pay.patientName && pay.houseId) {
    return state.patients.find(p => p.houseId === pay.houseId && p.name === pay.patientName);
  }
  return null;
}

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
  const selected = state.billingDate || todayISO();
  const billingDateEl = document.getElementById('billing-date');
  if (billingDateEl && billingDateEl.value !== selected) billingDateEl.value = selected;

  const dueAll = patientsDueOn(selected).map(p => ({
    patient: p,
    payment: paymentForPatientOnDate(p, selected),
  }));

  /* Live search (name / phone / house). The KPI cards recompute from the
   * FILTERED due list — same "counts match what the list shows" rule as the
   * discharged tab — so while searching they read as the subset's totals. */
  const q = state.billingSearch;
  const due = dueAll.filter(d => billingRowMatchesQuery(d.patient, d.payment, q));

  // KPI totals sum the payment records' EFFECTIVE amounts (override-aware via
  // paymentForPatientOnDate) — previously totalDue summed the base pay directly,
  // which would have ignored per-month overrides.
  const totalDue       = due.reduce((s, d) => s + (d.payment.amount || 0), 0);
  const totalCollected = due.reduce((s, d) => s + (d.payment.amountPaid || 0), 0);

  document.getElementById('bill-due-count').textContent    = due.length;
  document.getElementById('bill-due-total').textContent    = '₪ ' + totalDue.toLocaleString('he-IL');
  document.getElementById('bill-due-collected').textContent = '₪ ' + totalCollected.toLocaleString('he-IL');

  renderBillingDueList(due, selected, dueAll.length);
  renderBillingOpenList(selected);
  renderBillingMonthlySummary(selected);
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
    .filter(p => (p.status === 'unpaid' || p.status === 'partial') && p.dueDate && p.dueDate < selectedISO)
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
    });

  const open = openAll.filter(o => billingRowMatchesQuery(o.patient, o.pay, state.billingSearch));

  if (!open.length) {
    const msg = openAll.length ? 'לא נמצאו תוצאות' : 'אין יתרות פתוחות מתאריכים קודמים';
    list.innerHTML = `<div class="card billing-empty">${msg}</div>`;
    return;
  }
  open.forEach(({ patient, pay }) => {
    list.appendChild(buildBillingRow(patient, pay, pay.dueDate, true));
  });
}

function buildBillingRow(patient, payment, dueDateISO, isCarryForward) {
  const house = houseById(payment.houseId) || houseById(patient.houseId);
  const houseName = house ? house.name : (patient.houseId || '');
  const amount = payment.amount || patient.pay || 0;

  const row = document.createElement('div');
  /* Overdue highlight: an unpaid current-list row whose due date has arrived.
   * Carry-forward rows keep their existing amber treatment (same warning
   * language) and are skipped here. */
  const isOverdue = !isCarryForward && payment.status === 'unpaid' && dueDateISO <= todayISO();
  row.className = 'billing-row' + (isCarryForward ? ' carry' : '') + (isOverdue ? ' overdue' : '');
  row.dataset.pid = payment.id;

  const statusSelect = PAYMENT_STATUS.map(s =>
    `<option value="${s.id}" ${payment.status === s.id ? 'selected' : ''}>${s.label}</option>`
  ).join('');

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
  const amountCellHtml = `
      <span class="p-val bill-amount-view">₪ ${amount.toLocaleString('he-IL')}
        ${hasOverride ? '<span class="badge override" title="סכום מותאם לחודש זה">מותאם</span>' : ''}
        ${amountEditable ? '<button class="bill-amount-edit-btn" title="עריכת הסכום לחודש זה בלבד">✏️</button>' : ''}
        ${amountEditable && hasOverride ? '<button class="bill-amount-clear-btn" title="ביטול ההתאמה — חזרה לסכום הבסיס">↩</button>' : ''}
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
    </div>
    <div>
      <span class="p-label">בית</span>
      <span class="p-val">${escapeHtml(houseName)}</span>
    </div>
    <div class="bill-amount-cell">
      <span class="p-label">${amountCellLabel}</span>
      ${amountCellHtml}
    </div>
    <div>
      <span class="p-label">סטטוס</span>
      <select class="billing-status" ${state.mode === 'edit' ? '' : 'disabled'}>${statusSelect}</select>
    </div>
    <div class="billing-paid-wrap ${payment.status === 'partial' ? '' : 'hidden'}">
      <span class="p-label">שולם בפועל</span>
      <input class="billing-paid" type="number" min="0" step="50"
             value="${payment.amountPaid || 0}" ${state.mode === 'edit' ? '' : 'disabled'} />
    </div>
    <div>
      <span class="p-label">יתרה</span>
      <span class="p-val billing-balance">₪ ${(payment.balance || 0).toLocaleString('he-IL')}</span>
    </div>
  `;

  const statusSel = row.querySelector('.billing-status');
  const paidWrap  = row.querySelector('.billing-paid-wrap');
  const paidInput = row.querySelector('.billing-paid');
  const balanceEl = row.querySelector('.billing-balance');

  const recompute = (newStatus, newAmountPaid) => {
    let amountPaid = Number(newAmountPaid);
    if (!Number.isFinite(amountPaid) || amountPaid < 0) amountPaid = 0;
    if (newStatus === 'paid')   amountPaid = amount;
    if (newStatus === 'unpaid') amountPaid = 0;
    const balance = Math.max(0, amount - amountPaid);

    balanceEl.textContent = '₪ ' + balance.toLocaleString('he-IL');
    paidWrap.classList.toggle('hidden', newStatus !== 'partial');
    paidInput.value = amountPaid;

    return {
      ...payment,
      patientId:   payment.patientId   || patientKey(patient),
      patientName: payment.patientName || patient.name || '',
      houseId:     payment.houseId     || patient.houseId || '',
      dueDate:     dueDateISO,
      amount,
      status:      newStatus,
      amountPaid,
      balance,
      timestamp:   new Date().toISOString(),
    };
  };

  /* Busy discipline (async-button pass): both controls freeze (and the row
   * dims) while savePayment's round-trip is in flight, so the status can't be
   * flipped again mid-save. savePayment owns rollback + the error toast; a
   * failure re-renders the whole billing tab, so re-enabling a detached row is
   * harmless. */
  const setRowSaving = saving => {
    statusSel.disabled = saving || state.mode !== 'edit';
    paidInput.disabled = saving || state.mode !== 'edit';
    row.classList.toggle('saving', saving);
  };
  const saveRow = async updated => {
    setRowSaving(true);
    try { await savePayment(updated); }
    finally { setRowSaving(false); }
  };

  statusSel.onchange = () => {
    const updated = recompute(statusSel.value, paidInput.value);
    saveRow(updated);
  };

  paidInput.onchange = () => {
    if (statusSel.value !== 'partial') return;
    let v = Number(paidInput.value);
    if (!Number.isFinite(v) || v < 0) v = 0;
    if (v >= amount) {
      // Fully paid — flip to "שולם" so the row stops carrying forward.
      statusSel.value = 'paid';
      const updated = recompute('paid', amount);
      saveRow(updated);
    } else {
      const updated = recompute('partial', v);
      saveRow(updated);
    }
  };

  /* Per-month amount editor wiring (present only when amountEditable). The
   * save/clear workers are optimistic — their renderBilling() rebuilds this
   * row with the new amount + badge, which IS the visual feedback;
   * withBusyButton guards double-fire until the rebuild lands. */
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
      withBusyButton(e.currentTarget, () => {
        const v = Number(input.value);
        if (!Number.isFinite(v) || v < 0) {
          showError('סכום לא תקין');
          return Promise.resolve();
        }
        return saveBillingOverride(payment, v);
      });
  }
  const amountClearBtn = row.querySelector('.bill-amount-clear-btn');
  if (amountClearBtn) {
    amountClearBtn.onclick = e =>
      withBusyButton(e.currentTarget, () => clearBillingOverride(payment));
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
  const collected   = thisMonth.reduce((s, p) => s + (p.amountPaid || 0), 0);
  const outstanding = thisMonth
    .filter(p => p.status !== 'paid')
    .reduce((s, p) => s + (p.balance || 0), 0);

  document.getElementById('bill-month-collected').textContent   = '₪ ' + collected.toLocaleString('he-IL');
  document.getElementById('bill-month-outstanding').textContent = '₪ ' + outstanding.toLocaleString('he-IL');

  const breakdownEl = document.getElementById('bill-month-breakdown');
  breakdownEl.innerHTML = '';
  HOUSES.forEach(h => {
    const rows = thisMonth.filter(p => p.houseId === h.id);
    if (!rows.length) return;
    const col = rows.reduce((s, p) => s + (p.amountPaid || 0), 0);
    const out = rows.filter(p => p.status !== 'paid').reduce((s, p) => s + (p.balance || 0), 0);
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
  if (!breakdownEl.children.length) {
    breakdownEl.innerHTML = `<div class="bd-line muted">אין רישומי גבייה החודש</div>`;
  }
}

function formatMonth(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return iso || '';
  return d.toLocaleDateString('he-IL', { month: 'long', year: 'numeric' });
}

/* Upsert a payment record locally, then persist to the Payments sheet. */
async function savePayment(payment) {
  if (state.mode !== 'edit') return;
  const idx = state.payments.findIndex(x => x.id === payment.id);
  const prev = idx >= 0 ? { ...state.payments[idx] } : null;
  if (idx >= 0) state.payments[idx] = payment;
  else state.payments.push(payment);

  // Re-render the monthly summary right away; the row itself was already
  // updated in place by buildBillingRow's recompute.
  renderBillingMonthlySummary(state.billingDate || todayISO());

  try {
    await apiPost({ action: 'savePayment', payment });
  } catch (e) {
    // Roll back local change so the UI doesn't lie about persistence.
    if (prev) state.payments[idx] = prev;
    else state.payments = state.payments.filter(x => x.id !== payment.id);
    renderBilling();
    showError('שמירת גבייה נכשלה — ' + e.message);
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

  const prev = state.billingOverrides.slice();
  const idx = state.billingOverrides.findIndex(o => o && o.id === record.id);
  state.billingOverrides = idx >= 0
    ? state.billingOverrides.map((o, i) => (i === idx ? record : o))
    : prev.concat([record]);
  renderBilling();

  try {
    await apiPost({ action: 'upsertBillingOverride', override: record });
    showToast('הסכום עודכן לחודש ' + formatMonth(payment.dueDate));
  } catch (e) {
    state.billingOverrides = prev;
    renderBilling();
    showError('עדכון הסכום נכשל — ' + e.message);
  }
}

/* Remove the payment record's (patientId, month) override — the row reverts
 * to the base amount. Same single-identity-source rule and optimistic +
 * rollback shape as saveBillingOverride. */
async function clearBillingOverride(payment) {
  if (state.mode !== 'edit') return;
  const pid = payment && payment.patientId;
  if (!pid) return;
  const month = monthKey(payment.dueDate);
  const existing = billingOverrideFor(state.billingOverrides, pid, month);
  if (!existing) return;

  const prev = state.billingOverrides.slice();
  state.billingOverrides = state.billingOverrides.filter(o => o !== existing);
  renderBilling();

  try {
    await apiPost({ action: 'deleteBillingOverride', override: { id: existing.id, patientId: pid, month } });
    showToast('הסכום הוחזר לסכום הבסיס');
  } catch (e) {
    state.billingOverrides = prev;
    renderBilling();
    showError('ביטול ההתאמה נכשל — ' + e.message);
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
    label: formatDateDDMMYYYY(w.weekStart),
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
function formatDate(s) {
  if (!s) return '—';
  const d = new Date(s);
  if (isNaN(d)) return s;
  return d.toLocaleDateString('he-IL');
}
/* Strict DD/MM/YYYY (zero-padded, slash-separated) — used for the lead
 * "נוצר" display. he-IL's default locale format uses dots and no zero
 * padding (9.5.2026), which the spec rules out. */
function formatDateDDMMYYYY(s) {
  if (!s) return '';
  const iso = isoDate(s);
  if (!iso) return '';
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return '';
  return `${m[3]}/${m[2]}/${m[1]}`;
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

/* ===== Boot ===== */
document.addEventListener('DOMContentLoaded', initPin);
