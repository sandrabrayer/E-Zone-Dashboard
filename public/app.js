/* ===== E-ZONE Dashboard — frontend ===== */
console.log('[E-ZONE] app.js loaded at', new Date().toISOString(), 'origin:', location.origin, 'href:', location.href);

const HOUSES = [
  { id: 'arfoni', name: 'קיסריה עפרוני', capacity: 13 },
  { id: 'rehab',  name: 'קיסריה ריהאב',  capacity: 12 },
  { id: 'asher',  name: 'רעננה אשר',      capacity: 16 },
  { id: 'pardes', name: 'רעננה הפרדס',    capacity: 13 },
  { id: 'ramot',  name: 'רמות השבים',     capacity: 20 },
  { id: 'sde',    name: 'שדה אליעזר',     capacity: 16 },
];

const STAGES = [
  { id: 'new',         label: 'ליד חדש' },
  { id: 'visit',       label: 'ביקור נקבע' },
  { id: 'paid',        label: 'בטיפול פעיל' },
  { id: 'entry',       label: 'כניסה לבית' },
];
const STAGE_IRRELEVANT = { id: 'irrelevant', label: 'לא רלוונטי' };
const ALL_STAGES_FOR_PIPELINE = [...STAGES, STAGE_IRRELEVANT];

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
  patients: [],
  payments: [],
  mode: null, // 'edit' | 'viewer'
  currentScreen: 'dashboard',
  currentHouseTab: 'arfoni',
  leadSearch: '',
  patientSearch: '',
  billingDate: '',
};

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

  document.getElementById('pin-submit').onclick = tryPin;
  input.addEventListener('keydown', e => { if (e.key === 'Enter') tryPin(); });
  document.getElementById('pin-viewer').onclick = () => enterApp('viewer');

  function tryPin() {
    if (input.value === '2107') {
      enterApp('edit');
    } else {
      errEl.classList.remove('hidden');
      input.value = '';
    }
  }
}

function enterApp(mode) {
  state.mode = mode;
  sessionStorage.setItem('ezone-mode', mode);
  document.getElementById('pin-screen').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');
  document.body.classList.toggle('viewer-mode', mode === 'viewer');
  document.getElementById('mode-label').textContent =
    mode === 'edit' ? 'מצב עריכה' : 'מצב צפייה';

  document.getElementById('logout').onclick = () => {
    sessionStorage.removeItem('ezone-mode');
    location.reload();
  };

  initTabs();
  loadAll();
}

/* ===== Top tabs ===== */
const SCREENS = ['dashboard', 'leads', 'occupancy', 'billing'];

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
    console.log('[E-ZONE] after promote — leads:', state.leads.length, 'patients:', state.patients.length, '(+', promoted.length, 'promoted)');
    renderAll();

    if (promoted.length > 0 && state.mode === 'edit') {
      console.log(`[E-ZONE] Persisting ${promoted.length} auto-promoted patient(s)...`);
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
  'paid': 'paid', 'בטיפול פעיל': 'paid', 'מקדמה שולמה': 'paid', 'מקדמה': 'paid', 'שילם מקדמה': 'paid',
  'entry': 'entry', 'entered': 'entry',
  'כניסה לבית': 'entry', 'נכנס לבית': 'entry', 'נכנס': 'entry', 'כניסה': 'entry',
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
    visitDate: pickField(l, ['visitDate', 'visit_date', 'תאריך ביקור']),
    visitTime: pickField(l, ['visitTime', 'visit_time', 'שעת ביקור', 'שעה']),
    entryDate: pickField(l, ['entryDate', 'entry_date', 'תאריך כניסה']),
    advance:   advRaw === '' ? '' : Number(advRaw) || 0,
    created:   pickField(l, ['created', 'created_at', 'נוצר', 'נוצר ב', 'תאריך יצירה']),
  };
}

function normalizePatient(p) {
  if (!p || typeof p !== 'object') p = {};
  return {
    id:       pickField(p, ['id', 'ID', 'מזהה']) || cryptoId(),
    houseId:  resolveHouseId(pickField(p, ['houseId', 'house_id', 'בית', 'בית_מזהה'])),
    name:     pickField(p, ['name', 'שם', 'שם מטופל', 'Name']),
    date:     pickField(p, ['date', 'תאריך', 'תאריך כניסה', 'entryDate']),
    pay:      Number(pickField(p, ['pay', 'payment', 'תשלום', 'תשלום חודשי'])) || 0,
    adv:      Number(pickField(p, ['adv', 'advance', 'מקדמה'])) || 0,
    status:   normalizeStatus(pickField(p, ['status', 'סטטוס', 'מצב'])),
    fromLead: pickField(p, ['fromLead', 'from_lead', 'מקור_ליד', 'ליד מקור']),
    exitDate: pickField(p, ['exitDate', 'exit_date', 'תאריך שחרור', 'שחרור']),
    source:   pickField(p, ['source', 'מקור']) || 'lead',
    notes:    pickField(p, ['notes', 'note', 'הערות', 'הערה']),
  };
}
function cryptoId() {
  return 'id-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

/* ===== Render router ===== */
function renderAll() {
  renderDashboard();
  renderKanban();
  renderHouseTabs();
  renderPatients();
  renderBilling();
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
    const count = state.leads.filter(l => l.stage === s.id).length;
    const el = document.createElement('div');
    el.className = 'pipe';
    el.dataset.stage = s.id;
    el.innerHTML = `<div class="p-name">${s.label}</div><div class="p-count">${count}</div>`;
    pipe.appendChild(el);
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
  const isLast = idx === STAGES.length - 1;

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

  card.innerHTML = `
    <button class="lc-irrelevant edit-only" title="סמן כלא רלוונטי">לא רלוונטי ✕</button>
    <div class="lc-name">${escapeHtml(lead.name)}</div>
    <div class="lc-meta">
      ${escapeHtml(lead.phone)} ${lead.house ? '· ' + escapeHtml(lead.house) : ''}
      ${lead.source ? '· מקור: ' + escapeHtml(lead.source) : ''}
    </div>
    ${lead.note ? `<div class="lc-note">${escapeHtml(lead.note)}</div>` : ''}
    ${stageFields}
    <div class="lc-actions edit-only">
      <button class="btn small" data-action="back" ${idx === 0 ? 'disabled' : ''}>שלב קודם →</button>
      <button class="btn small primary" data-action="next">${isLast ? 'הושלם' : '← שלב הבא'}</button>
      <button class="btn small" data-action="edit" title="ערוך ליד">✏️</button>
    </div>
  `;

  card.querySelector('[data-action="next"]').onclick = () => advanceLead(lead);
  if (idx > 0) card.querySelector('[data-action="back"]').onclick = () => moveLead(lead, STAGES[idx - 1].id);
  card.querySelector('.lc-irrelevant').onclick = () => moveLead(lead, 'irrelevant');
  card.querySelector('[data-action="edit"]').onclick = () => openEditLeadModal(lead);

  card.querySelectorAll('[data-field]').forEach(inp => {
    inp.onchange = () => updateLead(lead.id, { [inp.dataset.field]: inp.value });
  });

  return card;
}

async function advanceLead(lead) {
  const idx = STAGES.findIndex(s => s.id === lead.stage);
  if (idx === STAGES.length - 1) {
    // already entered — nothing to do
    return;
  }
  if (idx === STAGES.length - 2) {
    // moving from "paid" → "entry": open entry modal
    openEntryModal(lead);
    return;
  }
  await moveLead(lead, STAGES[idx + 1].id);
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
      { name: 'note', label: 'הערות', type: 'textarea' },
    ],
    submitLabel: 'הוסף ליד',
    onSubmit: async values => {
      if (!values.name) { showError('יש להזין שם'); return false; }
      const id = cryptoId();
      const lead = normalizeLead({
        id, ...values,
        stage: 'new',
        created: new Date().toISOString(),
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
      lead.stage = 'entry';
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
    if (releaseBtn) releaseBtn.onclick = () => releasePatient(p);
    row.querySelector('[data-action="delete"]').onclick = () => deletePatient(p);

    list.appendChild(row);
  });
}

function releasePatient(p) {
  showModal({
    title: 'שחרור מטופל — ' + p.name,
    fields: [
      { name: 'exitDate', label: 'תאריך שחרור', type: 'date', required: true, value: todayISO() },
    ],
    submitLabel: 'שחרר',
    onSubmit: async v => {
      if (!v.exitDate) return false;
      const prev = { status: p.status, exitDate: p.exitDate };
      p.status = 'released';
      p.exitDate = v.exitDate;
      renderAll();
      try {
        await saveAll();
      } catch (e) {
        Object.assign(p, prev);
        renderAll();
        showError('עדכון נכשל — ' + e.message);
        return false;
      }
      return true;
    }
  });
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
    // already ISO-ish? keep just the date portion
    const m = v.match(/^\d{4}-\d{2}-\d{2}/);
    if (m) return m[0];
    const d = new Date(v);
    if (!isNaN(d)) return d.toISOString().slice(0, 10);
    return v;
  }
  const d = new Date(v);
  if (!isNaN(d)) return d.toISOString().slice(0, 10);
  return String(v);
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

/* ===== Boot ===== */
document.addEventListener('DOMContentLoaded', initPin);
