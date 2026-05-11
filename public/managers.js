/* ===== E-ZONE — Managers (Bonuses) dashboard =====
 *
 * Reads from the same /api/sheets proxy as the main app, with two
 * dedicated actions:
 *   GET ?action=managersOverview&month=YYYY-MM   → network + per-house
 *   GET ?action=managersHouse&house=KEY&month=…  → one house's detail
 */

console.log('[E-ZONE managers] managers.js loaded at', new Date().toISOString());

const HOUSE_KEYS = ['raanana', 'ramot', 'efroni', 'rehab'];
const HOUSE_NAMES = {
  raanana: 'רעננה אשר',
  ramot:   'רמות השבים',
  efroni:  'קיסריה עפרוני',
  rehab:   'קיסריה ריהאב',
};

const state = {
  month: '',
  view: 'overview',
  overview: null,
  houseCache: {},
  loading: false,
};

/* ===== Safe accessors — never crash on missing API fields ===== */
function safeNum(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : (fallback != null ? fallback : 0);
}
function safeStr(v, fallback) {
  if (v == null) return fallback != null ? fallback : '—';
  const s = String(v);
  return s.length ? s : (fallback != null ? fallback : '—');
}
function safeArr(v) { return Array.isArray(v) ? v : []; }
function safeObj(v) { return (v && typeof v === 'object' && !Array.isArray(v)) ? v : {}; }
/** Safe .slice() — returns '—' if the underlying value is missing. */
function safeSlice(v, start, end) {
  if (v == null) return '—';
  try {
    const s = String(v);
    return end != null ? s.slice(start, end) : s.slice(start);
  } catch (_) {
    return '—';
  }
}

/* ===== API ===== */
async function apiGet(params) {
  const qs = new URLSearchParams(params).toString();
  const url = '/api/sheets?' + qs;
  console.log('[managers] GET →', url);
  const res = await fetch(url);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    throw new Error(data.message || data.error || ('HTTP ' + res.status));
  }
  return data;
}

/* ===== Helpers ===== */
function currentMonthStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function fmtMoney(n) {
  const v = Math.round(safeNum(n));
  return '₪ ' + v.toLocaleString('he-IL');
}
function fmtNum(n, digits) {
  const x = safeNum(n);
  return digits ? x.toFixed(digits) : Math.round(x).toLocaleString('he-IL');
}
function showError(msg) {
  const el = document.getElementById('error-banner');
  if (!el) return;
  el.textContent = 'שגיאה: ' + msg;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 6000);
}
function setLoading(on) {
  const el = document.getElementById('loading-banner');
  if (el) el.classList.toggle('hidden', !on);
  state.loading = on;
}
function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

/* ===== Loaders ===== */
async function loadOverview() {
  setLoading(true);
  try {
    const data = await apiGet({ action: 'managersOverview', month: state.month });
    state.overview = data || {};
    renderOverview();
  } catch (err) {
    console.error('[managers] loadOverview', err);
    showError(err.message || 'נכשל בטעינת הנתונים');
    state.overview = { totals: {}, houses: [] };
    renderOverview();
  } finally {
    setLoading(false);
  }
}

async function loadHouse(key) {
  const cacheKey = `${key}|${state.month}`;
  if (state.houseCache[cacheKey]) {
    renderHouse(state.houseCache[cacheKey]);
    return;
  }
  setLoading(true);
  try {
    const data = await apiGet({ action: 'managersHouse', house: key, month: state.month });
    state.houseCache[cacheKey] = data || {};
    renderHouse(state.houseCache[cacheKey]);
  } catch (err) {
    console.error('[managers] loadHouse', err);
    showError(err.message || 'נכשל בטעינת בית');
    renderHouse({ key, name: HOUSE_NAMES[key] || key, month: state.month });
  } finally {
    setLoading(false);
  }
}

/* ===== Render: overview ===== */
function renderOverview() {
  document.getElementById('screen-overview').classList.remove('hidden');
  document.getElementById('screen-house').classList.add('hidden');

  const o = safeObj(state.overview);
  const t = safeObj(o.totals);

  setText('net-active', fmtNum(t.activePatients));
  setText('net-active-sub', `מתוך ${fmtNum(t.networkCapacity)} מיטות`);
  setText('net-capacity', fmtNum(t.networkCapacity));
  setText('net-days', fmtNum(t.totalTreatmentDays));
  setText('net-days-sub', `חודש ${safeStr(o.month, state.month || '—')}`);
  setText('net-bonus', fmtMoney(t.totalBonus));

  const grid = document.getElementById('overview-house-cards');
  if (!grid) return;
  grid.innerHTML = '';
  const houses = safeArr(o.houses);

  if (!houses.length) {
    grid.innerHTML = '<div class="activity-empty" style="grid-column:1/-1">אין נתוני בתים להצגה</div>';
    return;
  }

  houses.forEach(raw => {
    const h = normalizeHouseSummary(raw);
    const card = document.createElement('div');
    card.className = 'bonus-card ' + (h.qualifies ? 'qualifies' : 'below');
    card.dataset.house = h.key;
    card.innerHTML = renderHouseCardHtml(h);
    card.addEventListener('click', () => switchTab(h.key));
    grid.appendChild(card);
  });
}

/** Normalize a house summary so missing fields don't blow up renders. */
function normalizeHouseSummary(h) {
  const safe = safeObj(h);
  const bonus = safeObj(safe.bonus);
  const bep = safeNum(safe.bep);
  const patientsNow = safeNum(safe.patientsNow);
  const avgDaily = safeNum(safe.avgDaily);

  // A house "qualifies" if the API says so explicitly; otherwise fall back
  // to comparing the daily average (or current head-count) to BEP.
  const qualifies = (typeof safe.qualifies === 'boolean')
    ? safe.qualifies
    : (typeof bonus.qualifies === 'boolean' ? bonus.qualifies : (avgDaily >= bep && bep > 0));

  const missingPatients = Math.max(0, bep - Math.round(avgDaily || patientsNow));

  return {
    key: safeStr(safe.key, ''),
    name: safeStr(safe.name, HOUSE_NAMES[safe.key] || ''),
    manager: safeStr(safe.manager, ''),
    type: safeStr(safe.type, ''),
    bep,
    capacity: safeNum(safe.capacity),
    patientsNow,
    avgDaily,
    treatmentDays: safeNum(safe.treatmentDays),
    bonus: {
      total: safeNum(bonus.total),
      qualifies,
    },
    qualifies,
    missingPatients,
  };
}

function renderHouseCardHtml(h) {
  const trophy = h.qualifies
    ? '<div class="bc-trophy" aria-hidden="true">🏆</div>'
    : '';

  const badge = h.qualifies
    ? '<span class="bc-status status-good">✓ זכאי לבונוס</span>'
    : `<span class="bc-status status-bad">⚠ לא זכאי${h.missingPatients > 0 ? ` - חסרים ${h.missingPatients} מטופלים` : ''}</span>`;

  const bonusText = h.qualifies
    ? `<div class="bc-bonus good">${fmtMoney(h.bonus.total)}</div>`
    : `<div class="bc-bonus bad">0 ₪</div>`;

  return `
    ${trophy}
    <div class="bc-row">
      <div>
        <div class="bc-name">${h.name || '—'}</div>
        <div class="bc-manager">מנהל: ${h.manager || '—'}</div>
        ${h.type ? `<div class="bc-type">${h.type}</div>` : ''}
      </div>
      <div class="bc-bep-block">
        <div class="bc-stat-label">BEP</div>
        <div class="bc-stat-value">${fmtNum(h.bep)} / ${fmtNum(h.capacity)}</div>
      </div>
    </div>
    <div class="bc-stats">
      <div>
        <div class="bc-stat-label">מטופלים כעת</div>
        <div class="bc-stat-value">${fmtNum(h.patientsNow)}</div>
      </div>
      <div>
        <div class="bc-stat-label">ממוצע יומי</div>
        <div class="bc-stat-value">${fmtNum(h.avgDaily, 1)}</div>
      </div>
      <div>
        <div class="bc-stat-label">ימי טיפול</div>
        <div class="bc-stat-value">${fmtNum(h.treatmentDays)}</div>
      </div>
    </div>
    ${bonusText}
    ${badge}
  `;
}

/* ===== Render: house detail ===== */
function renderHouse(raw) {
  document.getElementById('screen-overview').classList.add('hidden');
  document.getElementById('screen-house').classList.remove('hidden');

  const h = safeObj(raw);
  const bonus = safeObj(h.bonus);
  const bep = safeNum(h.bep);
  const cap = safeNum(h.capacity);
  const avgDaily = safeNum(h.avgDaily);
  const patientsNow = safeNum(h.patientsNow);
  const qualifies = (typeof bonus.qualifies === 'boolean')
    ? bonus.qualifies
    : (avgDaily >= bep && bep > 0);
  const missingPatients = Math.max(0, bep - Math.round(avgDaily || patientsNow));

  // Decorate the whole screen so the same dramatic styling applies in detail view
  const screen = document.getElementById('screen-house');
  screen.classList.toggle('is-qualified', !!qualifies);
  screen.classList.toggle('is-below', !qualifies);

  setText('house-title', safeStr(h.name, HOUSE_NAMES[h.key] || '—'));

  const subParts = [
    h.manager ? `מנהל: ${h.manager}` : '',
    h.type    ? h.type : '',
    `חודש ${safeStr(h.month, state.month || '—')}`,
  ].filter(Boolean);
  setText('house-sub', subParts.join(' · '));

  const statusEl = document.getElementById('house-status');
  if (statusEl) {
    statusEl.innerHTML = qualifies
      ? '<span class="trophy-big" aria-hidden="true">🏆</span><span class="badge active">✓ זכאי לבונוס</span>'
      : `<span class="badge released">⚠ לא זכאי${missingPatients > 0 ? ` — חסרים ${missingPatients} מטופלים` : ''}</span>`;
  }

  setText('h-bep', fmtNum(bep));
  setText('h-bep-sub', `קיבולת מקסימלית ${fmtNum(cap)}`);
  setText('h-occupancy', fmtNum(patientsNow));
  setText('h-occupancy-sub', `ממוצע יומי ${fmtNum(avgDaily, 1)}`);
  setText('h-entries', fmtNum(h.entriesMonth));
  setText('h-exits',   fmtNum(h.exitsMonth));
  setText('h-days',    fmtNum(h.treatmentDays));
  setText('h-days-sub', `ממוצע יומי ${fmtNum(avgDaily, 1)} · BEP ${fmtNum(bep)}`);

  const bonusValueEl = document.getElementById('h-bonus');
  if (bonusValueEl) {
    bonusValueEl.textContent = qualifies ? fmtMoney(bonus.total) : '0 ₪';
    bonusValueEl.classList.toggle('value-good', !!qualifies);
    bonusValueEl.classList.toggle('value-bad', !qualifies);
  }
  setText('h-bonus-sub', qualifies
    ? 'בונוס בסיס + ימי-יתר + רציפות'
    : 'מנהל לא זכאי החודש');

  setText('chart-bep', fmtNum(bep));
  setText('chart-cap', fmtNum(cap));

  renderChart({ ...h, bep, capacity: cap });
  renderBreakdown({ ...h, bep, avgDaily, bonus: { ...bonus, qualifies } });
  renderActivity(h);
}

function renderChart(h) {
  const chart = document.getElementById('h-chart');
  if (!chart) return;
  chart.innerHTML = '';
  const data = safeArr(h.dailyChart);
  if (!data.length) {
    chart.innerHTML = '<div class="activity-empty" style="width:100%">אין נתונים יומיים לחודש זה</div>';
    return;
  }

  const bep = safeNum(h.bep);
  const cap = safeNum(h.capacity);
  const counts = data.map(d => safeNum(d && d.count));
  const maxCount = counts.length ? Math.max.apply(null, counts) : 0;
  const yMax = Math.max(cap, maxCount, bep, 1);

  data.forEach(d => {
    const item = safeObj(d);
    const count = safeNum(item.count);
    const bar = document.createElement('div');
    const heightPct = (count / yMax) * 100;
    bar.className = 'chart-bar' + (count > bep && bep > 0 ? ' above-bep' : '');
    bar.style.height = `${heightPct}%`;
    const dayLabel = safeSlice(item.date, 8);
    bar.innerHTML = `<span class="bar-tip">${dayLabel} · ${count} מטופלים</span>`;
    chart.appendChild(bar);
  });

  if (bep > 0) {
    const line = document.createElement('div');
    line.className = 'chart-line bep';
    line.style.bottom = `${(bep / yMax) * 100}%`;
    line.innerHTML = `<span class="chart-line-label">BEP ${bep}</span>`;
    chart.appendChild(line);
  }
  if (cap > 0) {
    const line = document.createElement('div');
    line.className = 'chart-line cap';
    line.style.bottom = `${(cap / yMax) * 100}%`;
    line.innerHTML = `<span class="chart-line-label">קיבולת ${cap}</span>`;
    chart.appendChild(line);
  }
}

function renderBreakdown(h) {
  const card = document.getElementById('h-breakdown');
  if (!card) return;
  const b = safeObj(h.bonus);
  const bep = safeNum(h.bep);

  if (!b.qualifies) {
    card.innerHTML = `
      <div class="bd-disqualified">
        <div class="big">⚠ לא זכאי לבונוס</div>
        <div>הבית מתחת לסף ה-BEP (${fmtNum(bep)}). ממוצע יומי בחודש ${safeStr(h.month, state.month || '—')}: <b>${fmtNum(h.avgDaily, 1)}</b>.</div>
        <div style="margin-top:14px;color:var(--text-dim);font-size:13px;">
          לפי המודל, מנהל מקבל בונוס רק כאשר הבית מגיע ל-BEP או מעליו.
        </div>
      </div>
    `;
    return;
  }

  const cont = safeObj(b.continuity);
  const rates = safeObj(cont.rates);
  const contMaint = safeNum(cont.maintenance);
  const cont2x    = safeNum(cont.day_2x);
  const contDaily = safeNum(cont.day_daily);
  const rateMaint = safeNum(rates.maintenance, 100);
  const rate2x    = safeNum(rates.day_2x, 500);
  const rateDaily = safeNum(rates.day_daily, 1000);
  const continuityFormula =
    `(${contMaint} × ${rateMaint}) + ` +
    `(${cont2x} × ${rate2x}) + ` +
    `(${contDaily} × ${rateDaily})`;

  const lines = [
    {
      title: 'בונוס בסיס',
      formula: `${fmtNum(bep)} מטופלים BEP — הושג (ממוצע ${fmtNum(h.avgDaily, 1)})`,
      amount: safeNum(b.base),
    },
    {
      title: 'בונוס ימי-יתר',
      formula: `${fmtNum(b.aboveBepDays)} ימי-מטופל מעל BEP × ${fmtNum(b.dailyRate)} ₪`,
      amount: safeNum(b.daily),
    },
    {
      title: 'בונוס יציבות רבעוני',
      formula: b.quarterlyEligible
        ? `${fmtNum(b.consecutiveAboveBep)} חודשים רצופים מעל BEP`
        : `דרושים 3 חודשים רצופים (כעת ${fmtNum(b.consecutiveAboveBep)})`,
      amount: safeNum(b.quarterly),
    },
    {
      title: 'בונוס רציפות (אמבולטורי)',
      formula: `${continuityFormula} = ${fmtNum(cont.total)} ₪`,
      amount: safeNum(cont.total),
    },
  ];

  let html = lines.map(l => `
    <div class="bd-line">
      <div>
        <div class="bd-title">${l.title}</div>
        <div class="bd-formula">${l.formula}</div>
      </div>
      <div class="bd-amount ${l.amount === 0 ? 'zero' : ''}">${fmtMoney(l.amount)}</div>
    </div>
  `).join('');

  html += `
    <div class="bd-line total">
      <div class="bd-title">סה"כ בונוס חודשי</div>
      <div class="bd-amount">${fmtMoney(b.total)}</div>
    </div>
  `;

  card.innerHTML = html;
}

function renderActivity(h) {
  const list = document.getElementById('h-activity');
  if (!list) return;
  list.innerHTML = '';
  const rows = safeArr(h.activity);
  if (!rows.length) {
    list.innerHTML = '<div class="activity-empty">אין כניסות או יציאות בחודש זה</div>';
    return;
  }
  rows.forEach(raw => {
    const r = safeObj(raw);
    const row = document.createElement('div');
    row.className = 'activity-row';
    const kind = r.kind === 'entry' ? 'entry' : (r.kind === 'exit' ? 'exit' : '');
    const kindLabel = kind === 'entry' ? 'כניסה' : (kind === 'exit' ? 'יציאה' : '—');
    row.innerHTML = `
      <div class="a-date">${safeStr(r.date, '—')}</div>
      <div class="a-name">${safeStr(r.name, '—')}</div>
      <div class="a-kind ${kind}">${kindLabel}</div>
    `;
    list.appendChild(row);
  });
}

/* ===== Tab switching ===== */
function switchTab(view) {
  state.view = view;
  document.querySelectorAll('#managers-tabs .h-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.house === view);
  });
  if (view === 'overview') {
    if (!state.overview) loadOverview(); else renderOverview();
  } else {
    loadHouse(view);
  }
  // Scroll to top on tab change — helps on mobile.
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/* ===== Boot ===== */
function init() {
  state.month = currentMonthStr();
  const picker = document.getElementById('month-picker');
  if (picker) {
    picker.value = state.month;
    picker.addEventListener('change', () => {
      state.month = picker.value || currentMonthStr();
      state.overview = null;
      state.houseCache = {};
      if (state.view === 'overview') loadOverview();
      else loadHouse(state.view);
    });
  }

  document.querySelectorAll('#managers-tabs .h-tab').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.house));
  });

  loadOverview();

  // Register the service worker so the app can be installed on mobile
  // and survives short connectivity drops. Fails silently in browsers
  // that don't support it (e.g. older iOS Safari).
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch(err => {
        console.warn('[managers] service worker registration failed', err);
      });
    });
  }
}

document.addEventListener('DOMContentLoaded', init);
