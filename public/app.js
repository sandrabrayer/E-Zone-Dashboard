/* ===== E-ZONE Dashboard — frontend ===== */

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
  { id: 'paid',        label: 'מקדמה שולמה' },
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

const houseById = id => HOUSES.find(h => h.id === id);
const houseByName = name => HOUSES.find(h => h.name === name);

const state = {
  leads: [],
  patients: [],
  mode: null, // 'edit' | 'viewer'
  currentScreen: 'dashboard',
  currentHouseTab: 'arfoni',
  leadSearch: '',
  patientSearch: '',
};

/* ===== API ===== */
async function apiGet(params) {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch('/api/sheets?' + qs);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    throw new Error(data.message || data.error || ('HTTP ' + res.status));
  }
  return data;
}

async function apiPost(body) {
  const res = await fetch('/api/sheets', {
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

    return apiPost({
      action: 'saveAll',
      leads: state.leads,
      patients,
    });
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
function initTabs() {
  document.querySelectorAll('.tabs .tab').forEach(btn => {
    btn.onclick = () => {
      document.querySelectorAll('.tabs .tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.currentScreen = btn.dataset.screen;
      ['dashboard', 'leads', 'occupancy'].forEach(s => {
        document.getElementById('screen-' + s).classList.toggle('hidden', s !== state.currentScreen);
      });
      renderAll();
    };
  });

  document.getElementById('lead-search').oninput = e => {
    state.leadSearch = e.target.value.trim().toLowerCase();
    renderKanban();
  };
  document.getElementById('patient-search').oninput = e => {
    state.patientSearch = e.target.value.trim().toLowerCase();
    renderPatients();
  };
  document.getElementById('add-lead-btn').onclick = openAddLeadModal;
}

/* ===== Initial load ===== */
async function loadAll() {
  setLoading(true);
  try {
    const data = await apiGet({ action: 'getData' });
    if (!data || typeof data !== 'object') {
      throw new Error('פורמט תגובה לא תקין מהגיליון');
    }
    state.leads = Array.isArray(data.leads) ? data.leads.map(normalizeLead) : [];
    state.patients = parsePatients(data.patients);

    const promoted = promoteEnteredLeads();
    renderAll();

    if (promoted.length > 0 && state.mode === 'edit') {
      console.log(`[E-ZONE] Persisting ${promoted.length} auto-promoted patient(s)...`);
      saveAll().catch(e => console.warn('[E-ZONE] auto-promote save failed', e.message));
    }
  } catch (e) {
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
    Object.entries(raw).forEach(([key, val]) => {
      if (Array.isArray(val)) {
        val.forEach(p => flat.push(normalizePatient({ ...p, houseId: p.houseId || key })));
      } else if (val && typeof val === 'object') {
        // object keyed by patient id
        flat.push(normalizePatient({ ...val, id: val.id || key }));
      }
    });
    return flat;
  }
  return [];
}

function normalizeLead(l) {
  return {
    id: l.id || l.ID || cryptoId(),
    name: l.name || '',
    phone: l.phone || '',
    house: l.house || '',
    source: l.source || '',
    note: l.note || '',
    stage: l.stage || 'new',
    visitDate: l.visitDate || '',
    visitTime: l.visitTime || '',
    entryDate: l.entryDate || '',
    advance: l.advance ? Number(l.advance) : '',
    created: l.created || '',
  };
}
function normalizePatient(p) {
  return {
    id: p.id || cryptoId(),
    houseId: p.houseId || '',
    name: p.name || '',
    date: p.date || '',
    pay: Number(p.pay || 0),
    adv: Number(p.adv || 0),
    status: p.status || 'active',
    fromLead: p.fromLead || '',
    exitDate: p.exitDate || '',
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
    return [l.name, l.phone, l.house].some(v => (v || '').toLowerCase().includes(q));
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
    </div>
  `;

  card.querySelector('[data-action="next"]').onclick = () => advanceLead(lead);
  if (idx > 0) card.querySelector('[data-action="back"]').onclick = () => moveLead(lead, STAGES[idx - 1].id);
  card.querySelector('.lc-irrelevant').onclick = () => moveLead(lead, 'irrelevant');

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
      </div>
    `;

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
  back.querySelector('[data-action="cancel"]').onclick = close;
  back.addEventListener('click', e => { if (e.target === back) close(); });
  back.querySelector('form').onsubmit = async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const values = {};
    fields.forEach(f => { values[f.name] = (fd.get(f.name) || '').toString(); });
    const ok = await onSubmit(values);
    if (ok !== false) close();
  };
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
