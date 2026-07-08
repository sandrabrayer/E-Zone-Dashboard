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

const STAGES = [
  { id: 'new',         label: 'ליד חדש' },
  { id: 'visit',       label: 'ביקור נקבע' },
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
  mode: null, // 'edit' | 'viewer'
  currentScreen: 'dashboard',
  currentHouseTab: 'arfoni',
  leadSearch: '',
  patientSearch: '',
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

/* ===== PIN ===== */
function initPin() {
  const saved = sessionStorage.getItem('ezone-mode');
  if (saved === 'edit' || saved === 'viewer') {
    enterApp(saved);
    return;
  }
  document.getElementById('pin-screen').classList.remove('hidden');
  document.getElementById('app').classList.add('hidden');

  const input = document.getElementById('pin-input');
  const errEl = document.getElementById('pin-error');
  const submitBtn = document.getElementById('pin-submit');

  submitBtn.onclick = tryPin;
  input.addEventListener('keydown', e => { if (e.key === 'Enter') tryPin(); });
  document.getElementById('pin-viewer').onclick = () => enterApp('viewer');

  /* The PIN is verified server-side (POST /api/verify-pin) so it never lives in
   * this bundle. Disable the button while the request is in flight so a slow
   * network can't queue up duplicate attempts against the rate limiter. */
  let pending = false;
  async function tryPin() {
    if (pending) return;
    pending = true;
    submitBtn.disabled = true;
    errEl.classList.add('hidden');
    try {
      const res = await fetch('/api/verify-pin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: input.value }),
      });
      if (res.ok) {
        enterApp('edit');
        return;
      }
      errEl.classList.remove('hidden');
      input.value = '';
    } catch (_) {
      errEl.classList.remove('hidden');
      input.value = '';
    } finally {
      pending = false;
      submitBtn.disabled = false;
    }
  }
}

function enterApp(mode) {
  state.mode = mode;
  sessionStorage.setItem('ezone-mode', mode);
  document.getElementById('pin-screen').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');
  document.body.classList.toggle('viewer-mode', mode === 'viewer');

  document.getElementById('logout').onclick = () => {
    sessionStorage.removeItem('ezone-mode');
    location.reload();
  };

  initTabs();
  loadAll();
}

/* ===== Top tabs ===== */
const SCREENS = ['dashboard', 'leads', 'retention', 'occupancy', 'discharged-patients', 'billing', 'breakeven', 'growth'];

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
  document.getElementById('add-lead-btn').onclick = openAddLeadModal;
  document.getElementById('add-patient-btn').onclick = openDirectAddPatientModal;

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
    console.log('[E-ZONE] after promote — leads:', state.leads.length, 'patients:', state.patients.length, '(+', promoted.length, 'promoted,', retired.length, 'retired)');
    renderAll();

    if ((promoted.length > 0 || retired.length > 0) && state.mode === 'edit') {
      console.log(`[E-ZONE] Persisting ${promoted.length} auto-promoted patient(s) + ${retired.length} retired lead(s)...`);
      saveAll().catch(e => console.warn('[E-ZONE] auto-promote save failed', e.message));
    }
  } catch (e) {
    console.error('[E-ZONE] loadAll failed:', e);
    showError('טעינת נתונים מהגיליון נכשלה — ' + e.message);
  } finally {
    setLoading(false);
  }
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

  state.leads.forEach(lead => {
    const stage = String(lead.stage || '').toLowerCase();
    if (stage !== 'entry' && stage !== 'entered') return;

    if (lead.id && byFromLead.has(String(lead.id))) return;

    const house = houseByName(lead.house) || houseById(lead.house);
    if (!house) {
      console.warn('[E-ZONE] entered lead has no recognizable house, skipping auto-promote:', lead);
      return;
    }
    const key = `${house.id}::${String(lead.name || '').trim()}`;
    if (byNameHouse.has(key)) return;

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
  base.dischargedAt   = pickField(p, ['dischargedAt', 'discharged_at', 'תאריך שחרור']) || '';
  base.disposition    = pickField(p, ['disposition']) || '';
  base.discharge_note = pickField(p, ['discharge_note', 'dischargeNote', 'הערת שחרור']) || '';
  base.restored       = pickField(p, ['restored', 'משוחזר']);
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
function renderAll() {
  renderDashboard();
  renderKanban();
  renderIrrelevantLeads();
  renderRemovedLeads();
  renderHouseTabs();
  renderPatients();
  renderDischargedPatients();
  renderBilling();
  renderBreakeven();
  renderGrowthGraph();
}

/* ====================================================
   DASHBOARD
   ==================================================== */
function renderDashboard() {
  const activePatients = state.patients.filter(p => p.status !== 'released');
  const totalCap = HOUSES.reduce((s, h) => s + h.capacity, 0);
  const occupied = activePatients.length;
  const pct = totalCap ? Math.round((occupied / totalCap) * 100) : 0;
  document.getElementById('stat-occ-pct').textContent = pct + '%';
  document.getElementById('stat-occ-bar').style.width = pct + '%';
  document.getElementById('stat-occ-sub').textContent = `${occupied} / ${totalCap} מיטות`;
  document.getElementById('stat-active').textContent = occupied;

  const revenue = activePatients.reduce((s, p) => s + (p.pay || 0), 0);
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

  renderRenewalAlert();
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
    row.querySelector('[data-action="renew"]').onclick = () => renewPatient(patient, renewalISO);
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
function renewPatient(patient, dueDateISO) {
  if (state.mode !== 'edit') return;

  const base   = paymentForPatientOnDate(patient, dueDateISO);
  const amount = base.amount || patient.pay || 0;
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
  const saved = savePayment(payment);
  renderDashboard();
  Promise.resolve(saved).then(() => {
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

function filterLeads() {
  const q = state.leadSearch;
  return state.leads.filter(l => {
    if (l.stage === 'irrelevant') return false; // hidden from board, but counted in pipeline + on dashboard
    if (!q) return true;
    return [l.name, l.phone, l.house].some(v => String(v == null ? '' : v).toLowerCase().includes(q));
  });
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
    stageFields = `
      <div class="lc-fields edit-only">
        <input type="date" data-field="visitDate" value="${lead.visitDate || ''}" />
        <input type="time" data-field="visitTime" value="${lead.visitTime || ''}" />
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

  card.innerHTML = `
    <div class="lc-name">${escapeHtml(lead.name)}</div>
    <div class="lc-meta">
      ${escapeHtml(lead.phone)} ${lead.house ? '· ' + escapeHtml(lead.house) : ''}
      ${lead.source ? '· מקור: ' + escapeHtml(lead.source) : ''}
    </div>
    ${lead.assignedTo
      ? `<div class="lc-assigned"><span class="lc-assigned-label">משוייך ל</span>${escapeHtml(lead.assignedTo)}</div>`
      : ''}
    <div class="lc-created">
      <span class="lc-created-label">נוצר</span>
      ${createdInner}
    </div>
    ${lead.note ? `<div class="lc-note">${escapeHtml(lead.note)}</div>` : ''}
    ${stageFields}
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
  lead.stage = newStage;
  renderAll();
  try {
    await saveAll();
  } catch (e) {
    lead.stage = prev;
    renderAll();
    showError('עדכון שלב נכשל — ' + e.message);
  }
}

async function updateLead(id, fields) {
  const lead = state.leads.find(l => l.id === id);
  if (!lead) return;
  const prev = { ...lead };
  Object.assign(lead, fields);
  try {
    await saveAll();
  } catch (e) {
    Object.assign(lead, prev);
    renderAll();
    showError('עדכון ליד נכשל — ' + e.message);
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

function renderIrrelevantLeads() {
  const list = document.getElementById('irrelevant-list');
  if (!list) return;
  list.innerHTML = '';

  const rows = state.irrelevantLeads || [];
  document.getElementById('irrelevant-count').textContent = rows.length;

  if (!rows.length) {
    list.innerHTML = `<div class="card billing-empty">אין לידים סגורים</div>`;
    return;
  }

  /* Phase 2d-1 — group rows by disposition and render up to three sections
   * in spec order. Sections with zero rows are skipped so empty headers
   * don't clutter the tab. */
  const grouped = { not_relevant: [], completed: [], stopped_early: [] };
  rows.forEach(lead => {
    const key = grouped[lead.disposition] ? lead.disposition : 'not_relevant';
    grouped[key].push(lead);
  });

  ['not_relevant', 'completed', 'stopped_early'].forEach(key => {
    const sectionRows = grouped[key];
    if (!sectionRows.length) return;

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

/* Phase 2e-1 — discharged-patients tab. Read-only audit list. Each row has a
 * "שחזר מטופל" button that posts restorePatient (creates a new lead carrying
 * over name/house; phone is not stored on patient rows so it starts blank).
 * Discharge record stays on the sheet as the audit trail — restore is
 * additive only on the Leads side. */
function renderDischargedPatients() {
  const list = document.getElementById('discharged-patients-list');
  if (!list) return;
  list.innerHTML = '';

  /* Phase 2e-2: hide rows the user has already restored. Backend writes
   * restored='TRUE' (string) on restorePatient_; Sheets may coerce to bool
   * in some configs, so accept both. The audit row stays in the sheet. */
  const rows = (state.dischargedPatients || [])
    .filter(d => d.restored !== 'TRUE' && d.restored !== true);
  const countEl = document.getElementById('discharged-patients-count');
  if (countEl) countEl.textContent = rows.length;

  if (!rows.length) {
    const empty = document.createElement('div');
    empty.className = 'card billing-empty';
    empty.textContent = 'אין מטופלים משוחררים';
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

      const btn = document.createElement('button');
      btn.className = 'btn small';
      btn.textContent = 'שחזר מטופל';
      btn.onclick = () => restorePatient(p);
      actions.appendChild(btn);

      // Restore-to-active: one-click undo for an accidental discharge. Sits
      // beside "שחזר מטופל" (which sends the patient back to the leads pipeline).
      const activeBtn = document.createElement('button');
      activeBtn.className = 'btn small primary';
      activeBtn.textContent = 'החזר לסטטוס פעיל';
      activeBtn.onclick = () => restorePatientToActive(p);
      actions.appendChild(activeBtn);

      row.appendChild(actions);
    }

    list.appendChild(row);
  });
}

async function restorePatient(p) {
  if (state.mode !== 'edit') return;

  showConfirm({
    text: 'להחזיר את המטופל למסלול לידים חדש?',
    onConfirm: async () => {
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
       * audit trail (per Phase 2e spec), so after the next page reload the
       * discharged row WILL reappear in this tab. That re-show is intended
       * audit behavior, not a bug — but the "row vanishes then comes back"
       * UX is a known rough edge. 2e-2 decides the final shape: either a
       * restored-flag column on the discharged sheet, or delete-on-restore. */
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
    },
  });
}

/* ===== Restore to active =====
 * "החזר לסטטוס פעיל" — a one-click undo for an accidental discharge. Unlike
 * restorePatient (which spawns a NEW LEAD), this returns the person to ACTIVE
 * patient status with their original record intact, and flags the audit row so
 * it leaves the discharged tab. The audit row is KEPT (restored='TRUE' hides
 * it; it is never deleted).
 *
 * The work is split into pure helpers (unit-tested) + a thin optimistic
 * handler that mirrors restorePatient's optimistic + rollback shape. */

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

/* Reconstruct an ACTIVE patient record from a discharged audit row. Used ONLY
 * when no existing row matches (e.g. the original row was hard-deleted from the
 * sheet). Carries every reconstructable field from the audit row, forcing
 * status='active' and a blank exitDate. Pure + tested. */
function reconstructActivePatientFromAudit(audit) {
  const a = audit || {};
  return {
    id:       a.id || cryptoId(),
    houseId:  a.houseId || '',
    name:     a.name || '',
    date:     a.date || '',
    pay:      Number(a.pay) || 0,
    adv:      Number(a.adv) || 0,
    status:   'active',
    fromLead: a.fromLead || '',
    exitDate: '',
    source:   a.source || 'lead',
    notes:    a.notes || '',
  };
}

/* Produce the post-restore patients array. If an existing row matches
 * (houseId+name+date) flip THAT row in place (status='active', exitDate='') —
 * guaranteeing NO duplicate, even across a reload where ids differ. Otherwise
 * reconstruct from the audit row and append. Returns a NEW array (the input is
 * never mutated) so the caller can roll back by restoring the previous
 * reference. Pure + tested. */
function buildRestoredToActivePatients(patients, audit) {
  const src = Array.isArray(patients) ? patients : [];
  const idx = matchActivePatientIndex(src, audit);
  if (idx >= 0) {
    const next = src.slice();
    next[idx] = Object.assign({}, src[idx], { status: 'active', exitDate: '' });
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

function restorePatientToActive(p) {
  if (state.mode !== 'edit') return;
  showConfirm({
    text: 'להחזיר את המטופל לסטטוס פעיל?',
    onConfirm: () => doRestorePatientToActive(p),
  });
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
    showError('החזרת המטופל לסטטוס פעיל נכשלה — ' + e.message);
    return;
  }

  showToast('המטופל הוחזר לסטטוס פעיל');
  // The discharge that produced this row may have created a cross-app Outpatient
  // lead (released_outpatient, PR #24). Restoring to active does not remove it,
  // so prompt the operator to clean it up manually in the Outpatient app.
  if (restoreNeedsOutpatientCleanup(p)) {
    showToast('שים לב: יש להסיר ידנית את ליד טיפול החוץ באפליקציית אאוטפיישנט');
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
  back.querySelector('[data-action="cancel"]').onclick = close;
  back.addEventListener('click', e => { if (e.target === back) close(); });

  back.querySelector('[data-action="confirm"]').onclick = async () => {
    close();
    try { await onConfirm(); }
    catch (err) {
      console.error('[E-ZONE] confirm onConfirm threw:', err);
      showError(err.message || 'הפעולה נכשלה');
    }
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
  showModal({
    title: 'ליד חדש',
    fields: [
      { name: 'name', label: 'שם מלא', type: 'text', required: true },
      { name: 'phone', label: 'טלפון', type: 'tel' },
      { name: 'house', label: 'בית מועדף', type: 'select',
        options: [{ value: '', label: '— ללא —' }, ...HOUSES.map(h => ({ value: h.name, label: h.name }))] },
      { name: 'source', label: 'מקור הפניה', type: 'text' },
      /* assignedTo (משוייך ל) — required. Empty placeholder option fails the
       * !values.assignedTo guard below, matching how `name` is validated. */
      { name: 'assignedTo', label: 'משוייך ל', type: 'select', required: true,
        options: [{ value: '', label: '— בחר —' }, ...ASSIGNEE_OPTIONS.map(a => ({ value: a, label: a }))] },
      { name: 'note', label: 'הערות', type: 'textarea' },
    ],
    submitLabel: 'הוסף ליד',
    onSubmit: async values => {
      if (!values.name) { showError('יש להזין שם'); return false; }
      if (!values.assignedTo) { showError('יש לבחור משוייך ל'); return false; }

      const doCreateLead = async vals => {
        const id = cryptoId();
        const lead = normalizeLead({
          id, ...vals,
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
      { name: 'name',  label: 'שם',          type: 'text',     required: true, value: lead.name || '' },
      { name: 'phone', label: 'טלפון',       type: 'tel',      value: lead.phone || '' },
      { name: 'house', label: 'בית מועדף',   type: 'select',
        value: lead.house || '',
        options: [{ value: '', label: '— ללא —' }, ...HOUSES.map(h => ({ value: h.name, label: h.name }))] },
      { name: 'created',   label: 'נוצר',          type: 'date', value: isoDate(lead.created || '') },
      { name: 'visitDate', label: 'תאריך ביקור', type: 'date', value: lead.visitDate || '' },
      { name: 'visitTime', label: 'שעת ביקור',   type: 'time', value: lead.visitTime || '' },
      { name: 'note',  label: 'הערות',       type: 'textarea', value: lead.note || '' },
    ],
    submitLabel: 'שמור שינויים',
    onSubmit: async v => {
      if (!v.name) { showError('יש להזין שם'); return false; }
      const prev = { ...lead };
      lead.name      = v.name.trim();
      lead.phone     = v.phone || '';
      lead.house     = v.house || '';
      lead.created   = v.created || '';
      lead.visitDate = v.visitDate || '';
      lead.visitTime = v.visitTime || '';
      lead.note      = (v.note || '').trim();
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
      /* Retire the lead to the terminal 'admitted' stage instead of leaving it
       * at 'entry'. An 'entry' lead stays in promoteEnteredLeads' candidate
       * pool forever and re-stamps this patient's date from lead.entryDate on
       * every load (clobbering any later edit to the entry date). 'admitted' is
       * excluded from that pool (and from the board/pipeline), so once the
       * patient exists the lead can no longer overwrite it. */
      lead.stage = 'admitted';
      lead.entryDate = v.date;
      renderAll();
      try {
        await saveAll();
      } catch (e) {
        state.patients = state.patients.filter(p => p.id !== patient.id);
        lead.stage = prevStage;
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
function renderHouseTabs() {
  const tabs = document.getElementById('house-tabs');
  tabs.innerHTML = '';
  HOUSES.forEach(h => {
    const t = document.createElement('button');
    t.className = 'h-tab' + (state.currentHouseTab === h.id ? ' active' : '');
    const inHouse = state.patients.filter(p => p.houseId === h.id && p.status !== 'released').length;
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
  const rows = state.patients
    .filter(p => p.status !== 'released')
    .filter(p => p.houseId === state.currentHouseTab)
    .filter(p => !q || (p.name || '').toLowerCase().includes(q));

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
        ${isReleased ? '' : `<button class="btn small" data-action="release">שחרר</button>`}
        <button class="btn small danger" data-action="delete" title="מחק לצמיתות">✕</button>
        <button class="btn small" data-action="edit" title="ערוך מטופל">✏️</button>
      </div>
    `;

    row.querySelector('[data-action="edit"]').onclick = () => openEditPatientModal(p);
    const releaseBtn = row.querySelector('[data-action="release"]');
    if (releaseBtn) releaseBtn.onclick = () => dischargePatient(p);
    row.querySelector('[data-action="delete"]').onclick = () => deletePatient(p);

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
      const prev = { status: p.status, exitDate: p.exitDate };

      const auditRow = dischargeAuditRow(p, { disposition, note, dischargeDate });
      const exitDate = auditRow.exitDate;

      p.status   = 'released';
      p.exitDate = exitDate;
      state.dischargedPatients = state.dischargedPatients || [];
      state.dischargedPatients.unshift(auditRow);
      renderAll();

      try {
        await saveAll();
      } catch (e) {
        Object.assign(p, prev);
        state.dischargedPatients = state.dischargedPatients.filter(d => d.id !== auditRow.id);
        renderAll();
        showError('שחרור המטופל נכשל — ' + e.message);
        throw e;
      }

      try {
        await apiPost({
          action: 'dischargePatient',
          patient: { ...p, disposition: disposition, discharge_note: note },
        });
      } catch (e) {
        Object.assign(p, prev);
        state.dischargedPatients = state.dischargedPatients.filter(d => d.id !== auditRow.id);
        renderAll();
        showError('כתיבת רישום השחרור נכשלה — ' + e.message);
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
    if (f.type === 'select') {
      return `
        <div class="form-row">
          <label>${f.label}${f.required ? ' *' : ''}</label>
          <select name="${f.name}">
            ${f.options.map(o => `<option value="${o.value}" ${o.value === val ? 'selected' : ''}>${o.label}</option>`).join('')}
          </select>
        </div>`;
    }
    if (f.type === 'textarea') {
      return `
        <div class="form-row">
          <label>${f.label}${f.required ? ' *' : ''}</label>
          <textarea name="${f.name}" rows="3">${escapeHtml(val)}</textarea>
        </div>`;
    }
    return `
      <div class="form-row">
        <label>${f.label}${f.required ? ' *' : ''}</label>
        <input name="${f.name}" type="${f.type}" value="${escapeHtml(val)}" />
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
    fields.forEach(f => { values[f.name] = (fd.get(f.name) || '').toString(); });

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
  return {
    id:          String(r.id || ''),
    patientId:   String(r.patientId || ''),
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

/* Sheets stores time-only cells as a Date anchored on 1899-12-30 UTC. When
 * the Apps Script readSheet_ uses getValues(), those cells come back as
 * Date objects (or, after JSON transport, full ISO strings like
 * "1899-12-30T13:30:00.000Z"). <input type="time"> only accepts "HH:MM",
 * so without coercion the input silently renders empty. Mirrors isoDate.
 * UTC getters are deliberate — local-timezone reads would shift the
 * displayed time by the user's offset since the anchor is UTC. */
function isoTime(v) {
  if (!v) return '';
  if (typeof v === 'string') {
    const m = v.match(/^(\d{2}):(\d{2})/);
    if (m) return `${m[1]}:${m[2]}`;
    const d = new Date(v);
    if (!isNaN(d)) {
      const hh = String(d.getUTCHours()).padStart(2, '0');
      const mm = String(d.getUTCMinutes()).padStart(2, '0');
      return `${hh}:${mm}`;
    }
    return v;
  }
  const d = new Date(v);
  if (!isNaN(d)) {
    const hh = String(d.getUTCHours()).padStart(2, '0');
    const mm = String(d.getUTCMinutes()).padStart(2, '0');
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

/* Build (or reuse) the payment record for a given patient + due date. If
 * there's no sheet-persisted record yet, return an in-memory "unpaid"
 * placeholder — not added to state.payments until it's actually saved. */
function paymentForPatientOnDate(patient, dueDateISO) {
  const id = paymentId(patient, dueDateISO);
  const existing = state.payments.find(x => x.id === id);
  if (existing) return existing;
  return normalizePayment({
    id,
    patientId: patientKey(patient),
    patientName: patient.name,
    houseId: patient.houseId,
    dueDate: dueDateISO,
    amount: patient.pay || 0,
    status: 'unpaid',
    amountPaid: 0,
    balance: patient.pay || 0,
  });
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

function renderBilling() {
  const selected = state.billingDate || todayISO();
  const billingDateEl = document.getElementById('billing-date');
  if (billingDateEl && billingDateEl.value !== selected) billingDateEl.value = selected;

  const due = patientsDueOn(selected).map(p => ({
    patient: p,
    payment: paymentForPatientOnDate(p, selected),
  }));

  const totalDue       = due.reduce((s, d) => s + (d.patient.pay || 0), 0);
  const totalCollected = due.reduce((s, d) => s + (d.payment.amountPaid || 0), 0);

  document.getElementById('bill-due-count').textContent    = due.length;
  document.getElementById('bill-due-total').textContent    = '₪ ' + totalDue.toLocaleString('he-IL');
  document.getElementById('bill-due-collected').textContent = '₪ ' + totalCollected.toLocaleString('he-IL');

  renderBillingDueList(due, selected);
  renderBillingOpenList(selected);
  renderBillingMonthlySummary(selected);
}

function renderBillingDueList(due, selectedISO) {
  const list = document.getElementById('billing-due-list');
  list.innerHTML = '';
  if (!due.length) {
    list.innerHTML = `<div class="card billing-empty">אין תשלומים לגבייה בתאריך זה</div>`;
    return;
  }
  due.forEach(({ patient, payment }) => {
    list.appendChild(buildBillingRow(patient, payment, selectedISO, false));
  });
}

function renderBillingOpenList(selectedISO) {
  const list = document.getElementById('billing-open-list');
  list.innerHTML = '';
  const open = state.payments
    .filter(p => (p.status === 'unpaid' || p.status === 'partial') && p.dueDate && p.dueDate < selectedISO)
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate));

  if (!open.length) {
    list.innerHTML = `<div class="card billing-empty">אין יתרות פתוחות מתאריכים קודמים</div>`;
    return;
  }
  open.forEach(pay => {
    const patient = findPatientForPayment(pay) || {
      name: pay.patientName,
      houseId: pay.houseId,
      pay: pay.amount,
      date: '',
      status: '',
    };
    list.appendChild(buildBillingRow(patient, pay, pay.dueDate, true));
  });
}

function buildBillingRow(patient, payment, dueDateISO, isCarryForward) {
  const house = houseById(payment.houseId) || houseById(patient.houseId);
  const houseName = house ? house.name : (patient.houseId || '');
  const amount = payment.amount || patient.pay || 0;

  const row = document.createElement('div');
  row.className = 'billing-row' + (isCarryForward ? ' carry' : '');
  row.dataset.pid = payment.id;

  const statusSelect = PAYMENT_STATUS.map(s =>
    `<option value="${s.id}" ${payment.status === s.id ? 'selected' : ''}>${s.label}</option>`
  ).join('');

  row.innerHTML = `
    <div>
      <span class="p-label">מטופל</span>
      <span class="p-name">${escapeHtml(patient.name || payment.patientName)}</span>
    </div>
    <div>
      <span class="p-label">בית</span>
      <span class="p-val">${escapeHtml(houseName)}</span>
    </div>
    <div>
      <span class="p-label">${isCarryForward ? 'תאריך מקורי' : 'סכום חודשי'}</span>
      <span class="p-val">${isCarryForward
        ? formatDate(dueDateISO)
        : '₪ ' + amount.toLocaleString('he-IL')}</span>
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

  statusSel.onchange = () => {
    const updated = recompute(statusSel.value, paidInput.value);
    savePayment(updated);
  };

  paidInput.onchange = () => {
    if (statusSel.value !== 'partial') return;
    let v = Number(paidInput.value);
    if (!Number.isFinite(v) || v < 0) v = 0;
    if (v >= amount) {
      // Fully paid — flip to "שולם" so the row stops carrying forward.
      statusSel.value = 'paid';
      const updated = recompute('paid', amount);
      savePayment(updated);
    } else {
      const updated = recompute('partial', v);
      savePayment(updated);
    }
  };

  return row;
}

function renderBillingMonthlySummary(selectedISO) {
  const mk = monthKey(selectedISO);
  document.getElementById('bill-month-label').textContent = formatMonth(selectedISO);

  const thisMonth = state.payments.filter(p => monthKey(p.dueDate) === mk);
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

/* Build an inline-SVG line chart (no lib, no CDN). Pure string output; every
 * dynamic label is escapeHtml'd. RTL is handled by the container; the SVG plots
 * time left→right (earliest→latest) which reads naturally under the Hebrew
 * heading above it. `labelEvery` thins x-labels so they don't overlap. */
function growthLineChartSVG(series, opts) {
  const o = opts || {};
  const W = 760, H = 240, padL = 56, padR = 16, padT = 16, padB = 44;
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

  // x labels, thinned
  const every = Math.max(1, Math.ceil(n / (o.maxXLabels || 8)));
  let xlabels = '';
  for (let i = 0; i < n; i++) {
    if (i % every !== 0 && i !== n - 1) continue;
    xlabels += '<text x="' + x(i).toFixed(1) + '" y="' + (H - padB + 18) +
               '" class="growth-xlabel" text-anchor="middle">' +
               escapeHtml(series[i].label) + '</text>';
  }

  const dots = series.map((s, i) =>
    '<circle cx="' + x(i).toFixed(1) + '" cy="' + y(s.value).toFixed(1) +
    '" r="2.5" class="growth-dot"><title>' +
    escapeHtml(s.label + ' — ' + (o.fmtY ? o.fmtY(s.value) : s.value)) +
    '</title></circle>'
  ).join('');

  return '<svg viewBox="0 0 ' + W + ' ' + H + '" class="growth-svg" preserveAspectRatio="xMidYMid meet" role="img">' +
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

  host.innerHTML =
    '<div class="card growth-card">' +
      '<div class="growth-title">מספר מטופלים פעילים (שבועי)</div>' +
      growthLineChartSVG(weeklySeries, { maxXLabels: 8 }) +
    '</div>' +
    '<div class="card growth-card">' +
      '<div class="growth-title">הכנסות חודשיות (₪)</div>' +
      growthLineChartSVG(monthlySeries, { fmtY: fmtShekel, maxXLabels: 8 }) +
    '</div>';
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
          <div class="be-metric-value">₪ ${m.totalExpenses.toLocaleString('he-IL')}</div>
        </div>
        <div class="be-metric">
          <div class="be-metric-label">מחיר ממוצע למטופל (ללא מע"מ)</div>
          <div class="be-metric-value">₪ ${Math.round(m.price).toLocaleString('he-IL')}</div>
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
          <div class="be-metric-value positive">₪ ${Math.round(m.marginalProfit).toLocaleString('he-IL')}</div>
        </div>
        <div class="be-metric">
          <div class="be-metric-label">רווח/הפסד נוכחי</div>
          <div class="be-metric-value ${plClass}">₪ ${Math.round(m.currentPL).toLocaleString('he-IL')}</div>
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
}

/* ===== Boot ===== */
document.addEventListener('DOMContentLoaded', initPin);
