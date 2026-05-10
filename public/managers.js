/* ===== E-ZONE — Managers (Bonuses) dashboard =====
 *
 * Reads from the same /api/sheets proxy as the main app, with two
 * dedicated actions:
 *   GET ?action=managersOverview&month=YYYY-MM   → network + per-house
 *   GET ?action=managersHouse&house=KEY&month=…  → one house's detail
 *
 * State is intentionally minimal: a single overview blob and a cache
 * of per-house detail blobs keyed by `${house}|${month}` so flipping
 * tabs back and forth doesn't refetch. Changing the month picker
 * clears the per-house cache. */

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
  view: 'overview', // 'overview' | one of HOUSE_KEYS
  overview: null,
  houseCache: {}, // `${key}|${month}` → detail
  loading: false,
};

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
  const v = Math.round(Number(n) || 0);
  return '₪ ' + v.toLocaleString('he-IL');
}
function fmtNum(n, digits) {
  const x = Number(n) || 0;
  return digits ? x.toFixed(digits) : Math.round(x).toLocaleString('he-IL');
}
function showError(msg) {
  const el = document.getElementById('error-banner');
  el.textContent = 'שגיאה: ' + msg;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 6000);
}
function setLoading(on) {
  document.getElementById('loading-banner').classList.toggle('hidden', !on);
  state.loading = on;
}

/* ===== Loaders ===== */
async function loadOverview() {
  setLoading(true);
  try {
    const data = await apiGet({ action: 'managersOverview', month: state.month });
    state.overview = data;
    renderOverview();
  } catch (err) {
    showError(err.message);
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
    state.houseCache[cacheKey] = data;
    renderHouse(data);
  } catch (err) {
    showError(err.message);
  } finally {
    setLoading(false);
  }
}

/* ===== Render: overview ===== */
function renderOverview() {
  document.getElementById('screen-overview').classList.remove('hidden');
  document.getElementById('screen-house').classList.add('hidden');

  const o = state.overview;
  if (!o) return;

  const t = o.totals || {};
  document.getElementById('net-active').textContent = fmtNum(t.activePatients);
  document.getElementById('net-active-sub').textContent = `מתוך ${fmtNum(t.networkCapacity)} מיטות`;
  document.getElementById('net-capacity').textContent = fmtNum(t.networkCapacity);
  document.getElementById('net-days').textContent = fmtNum(t.totalTreatmentDays);
  document.getElementById('net-days-sub').textContent = `חודש ${o.month}`;
  document.getElementById('net-bonus').textContent = fmtMoney(t.totalBonus);

  const grid = document.getElementById('overview-house-cards');
  grid.innerHTML = '';
  (o.houses || []).forEach(h => {
    const card = document.createElement('div');
    card.className = 'bonus-card ' + (h.qualifies ? 'qualifies' : 'below');
    card.dataset.house = h.key;
    card.innerHTML = renderHouseCardHtml(h);
    card.addEventListener('click', () => switchTab(h.key));
    grid.appendChild(card);
  });
}

function renderHouseCardHtml(h) {
  const status = h.qualifies
    ? '<span class="bc-status">מעל BEP — זכאי לבונוס</span>'
    : '<span class="bc-status">לא זכאי לבונוס</span>';
  const bonusText = h.qualifies ? fmtMoney(h.bonus.total) : '0 ₪';
  return `
    <div class="bc-row">
      <div>
        <div class="bc-name">${h.name}</div>
        <div class="bc-manager">מנהל: ${h.manager || '—'}</div>
        ${h.type ? `<div class="bc-type">${h.type}</div>` : ''}
      </div>
      <div style="text-align:left;">
        <div class="bc-stat-label">BEP</div>
        <div class="bc-stat-value">${h.bep} / ${h.capacity}</div>
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
    <div class="bc-bonus">${bonusText}</div>
    ${status}
  `;
}

/* ===== Render: house detail ===== */
function renderHouse(h) {
  document.getElementById('screen-overview').classList.add('hidden');
  document.getElementById('screen-house').classList.remove('hidden');

  document.getElementById('house-title').textContent = h.name;
  const subParts = [
    h.manager ? `מנהל: ${h.manager}` : '',
    h.type    ? h.type : '',
    `חודש ${h.month}`,
  ].filter(Boolean);
  document.getElementById('house-sub').textContent = subParts.join(' · ');

  const status = document.getElementById('house-status');
  status.innerHTML = h.bonus.qualifies
    ? '<span class="badge active">מעל BEP — זכאי</span>'
    : '<span class="badge released">מתחת ל-BEP — לא זכאי</span>';

  document.getElementById('h-entries').textContent = fmtNum(h.entriesMonth);
  document.getElementById('h-exits').textContent   = fmtNum(h.exitsMonth);
  document.getElementById('h-days').textContent    = fmtNum(h.treatmentDays);
  document.getElementById('h-days-sub').textContent = `ממוצע יומי ${fmtNum(h.avgDaily, 1)} · BEP ${h.bep}`;
  document.getElementById('h-bonus').textContent   = fmtMoney(h.bonus.total);
  document.getElementById('h-bonus-sub').textContent = h.bonus.qualifies
    ? 'בונוס בסיס + ימי-יתר + רציפות'
    : 'מנהל לא זכאי החודש';

  document.getElementById('chart-bep').textContent = h.bep;
  document.getElementById('chart-cap').textContent = h.capacity;

  renderChart(h);
  renderBreakdown(h);
  renderActivity(h);
}

function renderChart(h) {
  const chart = document.getElementById('h-chart');
  chart.innerHTML = '';
  const data = h.dailyChart || [];
  if (!data.length) {
    chart.innerHTML = '<div class="activity-empty" style="width:100%">אין נתונים יומיים לחודש זה</div>';
    return;
  }

  // Y axis scaled to capacity (or max count, whichever is larger) so
  // that an over-capacity day is still visible without overflowing.
  const maxCount = Math.max.apply(null, data.map(d => d.count));
  const yMax = Math.max(h.capacity, maxCount, h.bep, 1);

  data.forEach(d => {
    const bar = document.createElement('div');
    const heightPct = (d.count / yMax) * 100;
    bar.className = 'chart-bar' + (d.count > h.bep ? ' above-bep' : '');
    bar.style.height = `${heightPct}%`;
    bar.innerHTML = `<span class="bar-tip">${d.date.slice(8)} · ${d.count} מטופלים</span>`;
    chart.appendChild(bar);
  });

  // Reference lines — positioned from the bottom by % of yMax.
  if (h.bep > 0) {
    const line = document.createElement('div');
    line.className = 'chart-line bep';
    line.style.bottom = `${(h.bep / yMax) * 100}%`;
    line.innerHTML = `<span class="chart-line-label">BEP ${h.bep}</span>`;
    chart.appendChild(line);
  }
  if (h.capacity > 0) {
    const line = document.createElement('div');
    line.className = 'chart-line cap';
    line.style.bottom = `${(h.capacity / yMax) * 100}%`;
    line.innerHTML = `<span class="chart-line-label">קיבולת ${h.capacity}</span>`;
    chart.appendChild(line);
  }
}

function renderBreakdown(h) {
  const card = document.getElementById('h-breakdown');
  const b = h.bonus;

  if (!b.qualifies) {
    card.innerHTML = `
      <div class="bd-disqualified">
        <div class="big">לא זכאי לבונוס</div>
        <div>הבית מתחת לסף ה-BEP (${h.bep}). ממוצע יומי בחודש ${h.month}: <b>${fmtNum(h.avgDaily, 1)}</b>.</div>
        <div style="margin-top:14px;color:var(--text-dim);font-size:13px;">
          לפי המודל, מנהל מקבל בונוס רק כאשר הבית מגיע ל-BEP או מעליו.
        </div>
      </div>
    `;
    return;
  }

  const cont = b.continuity || { maintenance: 0, day_2x: 0, day_daily: 0, total: 0, rates: {} };
  const rates = cont.rates || {};
  const continuityFormula =
    `(${cont.maintenance} × ${rates.maintenance || 100}) + ` +
    `(${cont.day_2x} × ${rates.day_2x || 500}) + ` +
    `(${cont.day_daily} × ${rates.day_daily || 1000})`;

  const lines = [
    {
      title: 'בונוס בסיס',
      formula: `${h.bep} מטופלים BEP — הושג (ממוצע ${fmtNum(h.avgDaily, 1)})`,
      amount: b.base,
    },
    {
      title: 'בונוס ימי-יתר',
      formula: `${b.aboveBepDays} ימי-מטופל מעל BEP × ${b.dailyRate} ₪`,
      amount: b.daily,
    },
    {
      title: 'בונוס יציבות רבעוני',
      formula: b.quarterlyEligible
        ? `${b.consecutiveAboveBep} חודשים רצופים מעל BEP`
        : `דרושים 3 חודשים רצופים (כעת ${b.consecutiveAboveBep})`,
      amount: b.quarterly,
    },
    {
      title: 'בונוס רציפות (אמבולטורי)',
      formula: `${continuityFormula} = ${cont.total} ₪`,
      amount: cont.total,
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
  list.innerHTML = '';
  const rows = h.activity || [];
  if (!rows.length) {
    list.innerHTML = '<div class="activity-empty">אין כניסות או יציאות בחודש זה</div>';
    return;
  }
  rows.forEach(r => {
    const row = document.createElement('div');
    row.className = 'activity-row';
    row.innerHTML = `
      <div class="a-date">${r.date}</div>
      <div class="a-name">${r.name || '—'}</div>
      <div class="a-kind ${r.kind}">${r.kind === 'entry' ? 'כניסה' : 'יציאה'}</div>
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
}

/* ===== Boot ===== */
function init() {
  state.month = currentMonthStr();
  const picker = document.getElementById('month-picker');
  picker.value = state.month;
  picker.addEventListener('change', () => {
    state.month = picker.value || currentMonthStr();
    state.overview = null;
    state.houseCache = {};
    if (state.view === 'overview') loadOverview();
    else loadHouse(state.view);
  });

  document.querySelectorAll('#managers-tabs .h-tab').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.house));
  });

  loadOverview();
}

document.addEventListener('DOMContentLoaded', init);
