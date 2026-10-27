/* CRM shell (C2, CHANGELOG-crm-shell-areas.md; docs/crm/SPEC.md §4–§7).
 *
 * Loaded ONLY by /?view=crm (CRM_ENABLED). Read-only over the EXISTING
 * actions (/api/me, getData, billingControlQueue, getActivity): no new write
 * path — every action button links to the classic dashboard. The pure core
 * (CrmCore) is exported for node tests; the DOM part runs in the browser. */
(function (root, factory) {
  const core = factory();
  if (typeof module === 'object' && module.exports) module.exports = core;
  root.CrmCore = core;
  if (typeof document !== 'undefined' && document.getElementById('crm-root')) core.boot(root, document);
}(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  /* Mirrors public/app.js HOUSES / STAGES (ids are the stable keys). */
  const HOUSES = [
    { id: 'arfoni', name: 'קיסריה עפרוני', capacity: 13 }, { id: 'rehab', name: 'קיסריה ריהאב', capacity: 13 },
    { id: 'asher', name: 'רעננה אשר', capacity: 14 }, { id: 'pardes', name: 'רעננה הפרדס', capacity: 13 },
    { id: 'ramot', name: 'רמות השבים', capacity: 20 }, { id: 'sde', name: 'שדה אליעזר', capacity: 16, closed: true },
  ];
  /* Sibling-app / legacy house ids (app.js resolveHouseId). */
  const HOUSE_ALIASES = { hapardes: 'pardes', ofroni: 'arfoni', efroni: 'arfoni', raanana: 'asher' };
  const STAGES = [
    { id: 'new', label: 'ליד חדש' }, { id: 'visit', label: 'ביקור נקבע' },
    { id: 'waitlist', label: 'רשימת המתנה' }, { id: 'paid', label: 'בטיפול פעיל' },
  ];
  const AREAS = [
    { id: 'today', label: 'היום שלי' }, { id: 'leads', label: 'פניות' }, { id: 'occupancy', label: 'תפוסה' },
    { id: 'clients', label: 'מטופלים' }, { id: 'calendar', label: 'יומן' }, { id: 'billing', label: 'גבייה' }, { id: 'control', label: 'בקרה' },
  ];
  const WAIT_DAYS = 3;

  /* The areas a session may see — the SERVER's gates, mirrored for display
   * (the server refuses the data itself): the controller view (Ortal) sees
   * היום שלי / גבייה / בקרה; a session without finance (Dana) never sees גבייה. */
  function areasFor(me) {
    const m = me || {};
    if (m.view === 'controller') return ['today', 'billing', 'control'];
    if (!m.finance) return ['today', 'leads', 'occupancy', 'clients', 'calendar', 'control'];
    return AREAS.map(function (a) { return a.id; });
  }

  const s = function (v) { return String(v == null ? '' : v).trim(); };
  function houseId(idOrName) {
    const k = HOUSE_ALIASES[s(idOrName)] || s(idOrName);
    for (let i = 0; i < HOUSES.length; i++) if (HOUSES[i].id === k || HOUSES[i].name === k) return HOUSES[i].id;
    return '';
  }
  function houseName(idOrName) {
    const id = houseId(idOrName);
    for (let i = 0; i < HOUSES.length; i++) if (HOUSES[i].id === id) return HOUSES[i].name;
    return s(idOrName);
  }
  /* In the house now — the SAME rule as app.js houseOccupancyCount (status only). */
  function inHouse(p) { return s(p && p.status) !== 'released'; }

  /* «תפוסה»: per house, occupied / capacity / free; closed houses only when occupied;
   * patients whose house resolves to none are counted apart («בית לא מזוהה»). */
  function occupancy(patients) {
    const rows = [];
    let unknown = 0, totalIn = 0, totalCap = 0;
    const by = {};
    (patients || []).forEach(function (p) {
      if (!inHouse(p)) return;
      const id = houseId(p.houseId);
      if (!id) { unknown++; return; }
      by[id] = (by[id] || 0) + 1;
    });
    HOUSES.forEach(function (h) {
      const n = by[h.id] || 0;
      if (h.closed && n === 0) return;
      const cap = h.closed ? 0 : h.capacity;
      rows.push({ id: h.id, name: h.name, capacity: cap, inHouse: n, free: Math.max(0, cap - n), pct: cap ? Math.round(100 * n / cap) : 0, closed: !!h.closed });
      totalIn += n; totalCap += cap;
    });
    return { houses: rows, unknown: unknown, totalIn: totalIn, totalCap: totalCap, totalFree: Math.max(0, totalCap - totalIn) };
  }
  function isoDay(v) { const t = s(v); return /^\d{4}-\d{2}-\d{2}/.test(t) ? t.slice(0, 10) : ''; }
  function daysBetween(a, b) {
    const da = Date.parse(a + 'T00:00:00Z'), db = Date.parse(b + 'T00:00:00Z');
    if (isNaN(da) || isNaN(db)) return 0;
    return Math.round((db - da) / 86400000);
  }
  function addDays(iso, n) { return new Date(Date.parse(iso + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10); }
  /* ISO 'YYYY-MM-DD' → the dashboard's DD/MM/YYYY; anything else as is. Pure. */
  function fmtDate(iso) { const t = s(iso); const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(t); return m ? m[3] + '/' + m[2] + '/' + m[1] : t; }
  function stageLabel(id) { for (let i = 0; i < STAGES.length; i++) if (STAGES[i].id === id) return STAGES[i].label; return s(id); }

  /* getData → flat, normalised lists. Patients arrive keyed by house. */
  function normalise(data) {
    const d = data && typeof data === 'object' ? data : {};
    const leads = (Array.isArray(d.leads) ? d.leads : []).map(function (l) {
      return { id: s(l.id), name: s(l.name), phone: s(l.phone), house: s(l.house), source: s(l.source), stage: s(l.stage) || 'new',
        assignedTo: s(l.assignedTo), created: isoDay(l.created), visitDate: isoDay(l.visitDate), visitTime: s(l.visitTime),
        meetingWith: s(l.meetingWith), meetingOutcome: s(l.meetingOutcome), note: s(l.note),
        contactName: s(l.contactName), contactPhone: s(l.contactPhone), contactRelation: s(l.contactRelation),
        advance: l.advance === '' || l.advance == null ? '' : Number(l.advance) || 0 };
    });
    const patients = [];
    const p = d.patients;
    if (Array.isArray(p)) p.forEach(function (x) { patients.push(x); });
    else if (p && typeof p === 'object') Object.keys(p).forEach(function (h) { (Array.isArray(p[h]) ? p[h] : []).forEach(function (x) { patients.push(Object.assign({ houseId: h }, x)); }); });
    const pts = patients.map(function (x) {
      return { id: s(x.id), houseId: s(x.houseId), name: s(x.name), date: isoDay(x.date), status: s(x.status) || 'active',
        exitDate: isoDay(x.exitDate), fromLead: s(x.fromLead), source: s(x.source), personId: s(x.personId) };
    });
    return { leads: leads, patients: pts };
  }

  /* The work queue and the KPIs of «היום שלי» (Vered). Next action / due
   * date are COMPUTED from existing fields; a real task record is a later
   * track (spec §14) — rows say so with `derived: true`. */
  function compute(data, today) {
    const n = normalise(data);
    const rows = [];
    const kpi = { late: 0, today: 0, newLeads: 0, meetingsToday: 0 };
    n.leads.forEach(function (l) {
      if (STAGES.every(function (st) { return st.id !== l.stage; })) return;   // only open board leads
      if (l.created === today) kpi.newLeads++;
      if (l.stage === 'visit' && l.visitDate === today) kpi.meetingsToday++;
      let row = null;
      if (l.stage === 'visit' && l.visitDate && l.visitDate < today && !l.meetingOutcome) {
        row = { kind: 'meeting_no_outcome', action: 'לקבל דיווח מהמנהל/ת על הפגישה', owner: l.meetingWith || l.assignedTo,
          due: l.visitDate, state: 'late', reason: 'הפגישה התקיימה לפני ' + daysBetween(l.visitDate, today) + ' ימים' };
      } else if (l.stage === 'visit' && l.visitDate === today) {
        row = { kind: 'meeting_today', action: 'פגישת קבלה היום' + (l.visitTime ? ' · ' + l.visitTime : ''), owner: l.meetingWith || l.assignedTo, due: today, state: 'today', reason: '' };
      } else if (l.stage === 'visit' && !l.visitDate) {
        row = { kind: 'meeting_unscheduled', action: 'לתאם פגישה', owner: l.assignedTo, due: '', state: 'wait', reason: 'ביקור ללא תאריך' };
      } else if (l.stage === 'new' && l.created && daysBetween(l.created, today) >= WAIT_DAYS) {
        row = { kind: 'lead_waiting', action: 'לחזור למשפחה', owner: l.assignedTo, due: addDays(l.created, WAIT_DAYS), state: 'late',
          reason: 'ממתין ' + daysBetween(l.created, today) + ' ימים' };
      } else if (l.stage === 'new') {
        row = { kind: 'lead_new', action: 'ליצור קשר ראשון', owner: l.assignedTo, due: addDays(l.created || today, WAIT_DAYS), state: 'wait', reason: '' };
      } else if (l.stage === 'waitlist') {
        row = { kind: 'waitlist', action: 'לעדכן על מקום פנוי', owner: l.assignedTo, due: '', state: 'wait', reason: 'ממתין למקום · ' + houseName(l.house) };
      } else if (l.stage === 'paid') {
        row = { kind: 'admit', action: 'קליטה לבית', owner: l.assignedTo, due: '', state: 'wait', reason: 'בטיפול פעיל · ' + houseName(l.house) };
      }
      if (row) {
        row.leadId = l.id; row.client = l.name; row.house = houseName(l.house); row.derived = true;
        rows.push(row);
        if (row.state === 'late') kpi.late++; else if (row.state === 'today') kpi.today++;
      }
    });
    const order = { late: 0, today: 1, wait: 2 };
    rows.sort(function (a, b) { return (order[a.state] - order[b.state]) || (a.due || '9').localeCompare(b.due || '9'); });
    return { kpi: kpi, rows: rows, leads: n.leads, patients: n.patients };
  }

  /* «פניות»: the board columns and the table rows share one filter. */
  function filterLeads(leads, f) {
    const q = s(f && f.q).toLowerCase(), house = s(f && f.house), owner = s(f && f.owner);
    return leads.filter(function (l) {
      if (STAGES.every(function (st) { return st.id !== l.stage; })) return false;
      if (house && houseName(l.house) !== houseName(house)) return false;
      if (owner && l.assignedTo !== owner) return false;
      if (q && (l.name + ' ' + l.phone + ' ' + houseName(l.house)).toLowerCase().indexOf(q) < 0) return false;
      return true;
    });
  }
  function board(leads, f) {
    const list = filterLeads(leads, f);
    return STAGES.map(function (st) { return { stage: st, leads: list.filter(function (l) { return l.stage === st.id; }) }; });
  }
  function nextActionFor(l, today) {
    if (l.stage === 'visit' && l.visitDate && l.visitDate < today && !l.meetingOutcome) return { text: 'דיווח מהמנהל/ת', state: 'late' };
    if (l.stage === 'visit' && l.visitDate === today) return { text: 'פגישה היום', state: 'today' };
    if (l.stage === 'visit') return { text: l.visitDate ? 'פגישה ' + fmtDate(l.visitDate) : 'לתאם פגישה', state: 'wait' };
    if (l.stage === 'new') return { text: 'ליצור קשר', state: l.created && daysBetween(l.created, today) >= WAIT_DAYS ? 'late' : 'wait' };
    if (l.stage === 'waitlist') return { text: 'ממתין למקום', state: 'wait' };
    return { text: 'קליטה לבית', state: 'wait' };
  }

  /* «לקוחות»: patients in a house today, days in house. */
  function clients(patients, today, f) {
    const q = s(f && f.q).toLowerCase(), house = s(f && f.house);
    return patients.filter(function (p) {
      if (!inHouse(p)) return false;                                        // the dashboard's own count rule
      if (house && houseName(p.houseId) !== houseName(house)) return false;   // id or Hebrew name, shared with the leads filter
      if (q && (p.name + ' ' + houseName(p.houseId)).toLowerCase().indexOf(q) < 0) return false;
      return true;
    }).map(function (p) { return Object.assign({ houseName: houseName(p.houseId), days: p.date ? daysBetween(p.date, today) : '' }, p); })
      .sort(function (a, b) { return a.houseName.localeCompare(b.houseName) || a.name.localeCompare(b.name); });
  }

  /* «יומן»: meetings from today onward (14 days), earliest first. */
  function calendar(leads, today, days) {
    const last = addDays(today, days || 14);
    return leads.filter(function (l) { return l.stage === 'visit' && l.visitDate && l.visitDate >= today && l.visitDate <= last; })
      .sort(function (a, b) { return (a.visitDate + a.visitTime).localeCompare(b.visitDate + b.visitTime); });
  }

  /* «בקרה»: the action metrics of spec §10 — counts only. */
  function control(c, today) {
    const untouched = c.leads.filter(function (l) { return l.stage === 'new' && l.created && daysBetween(l.created, today) >= WAIT_DAYS; }).length;
    const noOutcome = c.leads.filter(function (l) { return l.stage === 'visit' && l.visitDate && l.visitDate < today && !l.meetingOutcome; }).length;
    const unscheduled = c.leads.filter(function (l) { return l.stage === 'visit' && !l.visitDate; }).length;
    const admitting = c.leads.filter(function (l) { return l.stage === 'paid'; }).length;
    return [
      { id: 'untouched', label: 'פניות ללא טיפול (' + WAIT_DAYS + '+ ימים)', value: untouched },
      { id: 'late', label: 'משימות באיחור', value: c.kpi.late },
      { id: 'noOutcome', label: 'פגישות ללא תוצאה', value: noOutcome },
      { id: 'unscheduled', label: 'ביקורים ללא תאריך', value: unscheduled },
      { id: 'admitting', label: 'מעברים פתוחים (קליטה)', value: admitting },
    ];
  }

  /* Ortal's day from billingControlQueue: counts by status. */
  function controllerDay(queue) {
    const list = queue && Array.isArray(queue.receipts) ? queue.receipts : [];
    const by = { reported: 0, flagged: 0, confirmed: 0 };
    list.forEach(function (r) { const st = s(r.status); if (by[st] !== undefined) by[st]++; });
    return { toVerify: by.reported, flagged: by.flagged, confirmed: by.confirmed, total: list.length };
  }

  const esc = function (v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };

  /* ================= DOM ================= */
  function boot(win, doc) {
    const state = { me: null, data: null, area: 'today', view: 'board', filters: { q: '', house: '', owner: '' }, kpiFilter: '', queue: null,
      today: new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date()), drawer: null, error: '', loading: true, sort: 'name' };
    const $ = function (sel) { return doc.querySelector(sel); };
    const root = $('#crm-root');
    const main = $('#crm-main');
    const navEl = $('#crm-nav');
    const menuEl = $('#crm-menu');

    function api(action, extra) {
      const q = Object.assign({ action: action }, extra || {});
      const qs = Object.keys(q).map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(q[k]); }).join('&');
      return win.fetch('/api/sheets?' + qs, { credentials: 'same-origin' }).then(function (r) {
        return r.json().catch(function () { return { ok: false, error: 'bad_json' }; }).then(function (j) { if (!r.ok && j && j.ok !== false) j = { ok: false, error: 'http_' + r.status }; return j; });
      });
    }

    function setArea(id) { state.area = id; state.kpiFilter = ''; renderNav(); renderMain(); menuEl.removeAttribute('data-open'); $('#crm-scrim').removeAttribute('data-open'); }

    function renderNav() {
      const areas = areasFor(state.me);
      const c = state.data ? compute(state.data, state.today) : null;
      navEl.innerHTML = AREAS.filter(function (a) { return areas.indexOf(a.id) >= 0; }).map(function (a) {
        let n = '';
        if (c && a.id === 'today') n = state.me && state.me.view === 'controller' ? (state.queue ? controllerDay(state.queue).toVerify : '') : c.kpi.late + c.kpi.today;
        if (c && a.id === 'leads') n = filterLeads(c.leads, {}).length;
        return '<button type="button" data-area="' + a.id + '"' + (state.area === a.id ? ' aria-current="page"' : '') + '><span>' + esc(a.label) + '</span>' + (n !== '' ? '<span class="n">' + esc(n) + '</span>' : '') + '</button>';
      }).join('');
    }

    function chip(state_, text) { return '<span class="chip ' + esc(state_) + '">' + esc(text) + '</span>'; }
    function stateText(st) { return st === 'late' ? 'באיחור' : st === 'today' ? 'להיום' : 'ממתין'; }

    function renderToday(c) {
      if (state.me && state.me.view === 'controller') return renderControllerToday();
      const k = c.kpi;
      const kp = [['late', 'משימות באיחור', k.late], ['today', 'לטיפול היום', k.today], ['new', 'פניות חדשות', k.newLeads], ['meetings', 'פגישות היום', k.meetingsToday]];
      let rows = c.rows;
      if (state.kpiFilter === 'late') rows = rows.filter(function (r) { return r.state === 'late'; });
      if (state.kpiFilter === 'today') rows = rows.filter(function (r) { return r.state === 'today'; });
      if (state.kpiFilter === 'meetings') rows = rows.filter(function (r) { return r.kind === 'meeting_today'; });
      if (state.kpiFilter === 'new') rows = rows.filter(function (r) { return r.kind === 'lead_new' || r.kind === 'lead_waiting'; });
      const groups = [['late', 'באיחור'], ['today', 'להיום'], ['wait', 'ממתין לגורם אחר / בתהליך']];
      return '<div class="kpis">' + kp.map(function (x) { return '<button type="button" class="kpi" data-kpi="' + x[0] + '" aria-pressed="' + (state.kpiFilter === x[0]) + '"><span class="v">' + x[2] + '</span><span class="l">' + esc(x[1]) + '</span></button>'; }).join('') + '</div>'
        + '<p class="na">הפעולה הבאה ומועד היעד מחושבים מהשדות הקיימים (ליד, פגישה, שלב). רשומת משימה עם תאריך יעד ואחראי — בשלב הבא.</p>'
        + (rows.length === 0 ? '<div class="crm-state">אין משימות פתוחות</div>' : '')
        + groups.map(function (g) {
          const list = rows.filter(function (r) { return r.state === g[0]; });
          if (!list.length) return '';
          return '<div class="group-title">' + esc(g[1]) + ' <span class="n chip">' + list.length + '</span></div><div class="rows">'
            + '<div class="row h"><span>לקוח</span><span>הפעולה הנדרשת</span><span>אחראי</span><span>מועד יעד</span><span>מצב</span><span></span></div>'
            + list.map(function (r) {
              return '<div class="row" data-lead="' + esc(r.leadId) + '"><span><span class="name">' + esc(r.client) + '</span><br><span class="sub">' + esc(r.house) + '</span></span>'
                + '<span>' + esc(r.action) + '</span><span>' + esc(r.owner || '—') + '</span><span>' + esc(r.due ? fmtDate(r.due) : '—') + '</span>'
                + '<span>' + chip(r.state, stateText(r.state)) + (r.reason ? '<br><span class="sub">' + esc(r.reason) + '</span>' : '') + '</span>'
                + '<span><button type="button" class="btn small" data-open-lead="' + esc(r.leadId) + '">כרטיס</button></span></div>';
            }).join('') + '</div>';
        }).join('');
    }

    function renderControllerToday() {
      if (!state.queue) return '<div class="crm-state">טוען את תור האימות…</div>';
      if (state.queue.ok === false) return '<div class="crm-state bad">תור האימות לא נטען (' + esc(state.queue.error || '') + ')</div>';
      const d = controllerDay(state.queue);
      return '<div class="kpis">' + [['toVerify', 'דיווחים לאימות', d.toVerify], ['flagged', 'אימותים חלקיים / לבירור', d.flagged], ['confirmed', 'אומתו', d.confirmed]].map(function (x) {
        return '<div class="kpi"><span class="v">' + x[2] + '</span><span class="l">' + esc(x[1]) + '</span></div>';
      }).join('') + '</div><div class="links"><a href="/">בקרת גבייה — העבודה המלאה בדשבורד<small>אימות, סימון לבירור, ייצוא</small></a></div>';
    }

    function renderLeads(c) {
      const owners = {};
      c.leads.forEach(function (l) { if (l.assignedTo) owners[l.assignedTo] = true; });
      const f = state.filters;
      const toolbar = '<div class="toolbar"><div class="seg"><button type="button" data-view="board" aria-pressed="' + (state.view === 'board') + '">לוח</button><button type="button" data-view="table" aria-pressed="' + (state.view === 'table') + '">טבלה</button></div>'
        + '<select id="f-house"><option value="">כל הבתים</option>' + HOUSES.filter(function (h) { return h.id !== 'sde'; }).map(function (h) { return '<option value="' + esc(h.name) + '"' + (f.house === h.name ? ' selected' : '') + '>' + esc(h.name) + '</option>'; }).join('') + '</select>'
        + '<select id="f-owner"><option value="">כל האחראים</option>' + Object.keys(owners).map(function (o) { return '<option' + (f.owner === o ? ' selected' : '') + '>' + esc(o) + '</option>'; }).join('') + '</select>'
        + '<a class="btn primary" href="/">+ פנייה חדשה (בדשבורד)</a></div>';
      if (state.view === 'board') {
        return toolbar + '<div class="board">' + board(c.leads, f).map(function (col) {
          return '<div class="col"><h3><span>' + esc(col.stage.label) + '</span><span class="n">' + col.leads.length + '</span></h3>' + col.leads.map(function (l) {
            const na = nextActionFor(l, state.today);
            return '<div class="card" data-open-lead="' + esc(l.id) + '"><div class="name">' + esc(l.name) + '</div><div class="meta"><span>' + esc(houseName(l.house) || '—') + '</span>' + (l.source ? '<span class="chip">' + esc(l.source) + '</span>' : '') + (l.assignedTo ? '<span>' + esc(l.assignedTo) + '</span>' : '') + '</div>'
              + (l.created ? '<div class="meta"><span>נוצר ' + esc(fmtDate(l.created)) + '</span>' + (l.visitDate ? '<span>פגישה ' + esc(fmtDate(l.visitDate)) + (l.visitTime ? ' ' + esc(l.visitTime) : '') + '</span>' : '') + '</div>' : '')
              + '<div class="next">' + chip(na.state, na.text) + '</div></div>';
          }).join('') + '</div>';
        }).join('') + '</div>';
      }
      const list = filterLeads(c.leads, f).slice().sort(function (a, b) { return s(a[state.sort]).localeCompare(s(b[state.sort])); });
      const cols = [['name', 'שם'], ['house', 'בית'], ['source', 'מקור'], ['assignedTo', 'אחראי'], ['stage', 'שלב'], ['visitDate', 'פגישה'], ['created', 'נוצר']];
      return toolbar + '<div class="tbl-wrap"><table class="tbl"><thead><tr>' + cols.map(function (c2) { return '<th data-sort="' + c2[0] + '">' + esc(c2[1]) + (state.sort === c2[0] ? ' ▾' : '') + '</th>'; }).join('') + '<th>פעולה הבאה</th></tr></thead><tbody>'
        + list.map(function (l) { const na = nextActionFor(l, state.today); return '<tr data-open-lead="' + esc(l.id) + '"><td>' + esc(l.name) + '</td><td>' + esc(houseName(l.house)) + '</td><td>' + esc(l.source) + '</td><td>' + esc(l.assignedTo) + '</td><td>' + esc(stageLabel(l.stage)) + '</td><td>' + esc(fmtDate(l.visitDate)) + '</td><td>' + esc(fmtDate(l.created)) + '</td><td>' + chip(na.state, na.text) + '</td></tr>'; }).join('')
        + '</tbody></table></div>' + (list.length === 0 ? '<div class="crm-state">אין פניות התואמות לסינון</div>' : '');
    }

    function renderClients(c) {
      const list = clients(c.patients, state.today, state.filters);
      const toolbar = '<div class="toolbar"><select id="f-house-c"><option value="">כל הבתים</option>' + HOUSES.map(function (h) { return '<option value="' + h.id + '"' + (state.filters.house === h.id ? ' selected' : '') + '>' + esc(h.name) + '</option>'; }).join('') + '</select><span class="na">' + list.length + ' בטיפול</span></div>';
      return toolbar + '<div class="tbl-wrap"><table class="tbl"><thead><tr><th>שם</th><th>בית</th><th>תאריך כניסה</th><th>ימים בבית</th><th>סטטוס</th></tr></thead><tbody>'
        + list.map(function (p) { return '<tr data-open-patient="' + esc(p.id) + '"><td>' + esc(p.name) + '</td><td>' + esc(p.houseName) + '</td><td>' + esc(fmtDate(p.date)) + '</td><td>' + esc(p.days) + '</td><td>' + esc(p.status) + '</td></tr>'; }).join('')
        + '</tbody></table></div>' + (list.length === 0 ? '<div class="crm-state">אין מטופלים</div>' : '');
    }

    function renderCalendar(c) {
      const list = calendar(c.leads, state.today, 14);
      if (!list.length) return '<div class="crm-state">אין פגישות ב-14 הימים הקרובים</div>';
      let day = '';
      return '<div class="rows">' + list.map(function (l) {
        const head = l.visitDate !== day ? '<div class="group-title">' + esc(l.visitDate === state.today ? 'היום · ' + fmtDate(l.visitDate) : fmtDate(l.visitDate)) + '</div>' : '';
        day = l.visitDate;
        return head + '<div class="row" data-open-lead="' + esc(l.id) + '"><span><span class="name">' + esc(l.name) + '</span><br><span class="sub">' + esc(houseName(l.house)) + '</span></span><span>פגישת קבלה' + (l.visitTime ? ' · ' + esc(l.visitTime) : '') + '</span><span>' + esc(l.meetingWith || l.assignedTo || '—') + '</span><span>' + esc(fmtDate(l.visitDate)) + '</span><span>' + chip(l.visitDate === state.today ? 'today' : 'wait', l.visitDate === state.today ? 'היום' : 'מתוכנן') + '</span><span><button type="button" class="btn small" data-open-lead="' + esc(l.id) + '">כרטיס</button></span></div>';
      }).join('') + '</div>';
    }

    function renderBilling() {
      return '<p class="na">הגבייה נשארת בדשבורד הרגיל בשלב זה; כאן הקישורים לתתי-המסכים.</p><div class="links">'
        + '<a href="/">גבייה<small>תשלומים, חובות, זיכויים</small></a><a href="/">בקרת גבייה<small>אימות דיווחים (אורטל)</small></a><a href="/">שיוך תשלומים<small>תשלומים ללא שיוך</small></a><a href="/">מסמכים<small>חשבוניות וקבלות</small></a></div>';
    }

    function renderOccupancy(c) {
      const o = occupancy(c.patients);
      return '<div class="kpis">' + [['בטיפול היום', o.totalIn], ['מיטות פנויות', o.totalFree], ['קיבולת', o.totalCap]].map(function (x) { return '<div class="kpi"><span class="v">' + x[1] + '</span><span class="l">' + esc(x[0]) + '</span></div>'; }).join('') + '</div>'
        + '<div class="links">' + o.houses.map(function (h) {
          const state_ = h.closed ? 'wait' : (h.free === 0 ? 'late' : (h.free <= 2 ? 'today' : 'ok'));
          return '<a href="#" data-house-open="' + esc(h.name) + '"><strong>' + esc(h.name) + '</strong> ' + chip(state_, h.closed ? 'סגור' : h.free + ' פנויות') + '<small>' + h.inHouse + ' / ' + (h.capacity || '—') + (h.capacity ? ' · ' + h.pct + '%' : '') + '</small></a>';
        }).join('') + (o.unknown ? '<a href="/"><strong>בית לא מזוהה</strong> ' + chip('late', o.unknown + ' מטופלים') + '<small>לתיקון בדשבורד</small></a>' : '') + '</div>'
        + '<p class="na">קליטה, יציאה והעברה בין בתים נעשות בדשבורד הרגיל (תפוסה).</p>';
    }

    function renderControl(c) {
      return '<div class="kpis">' + control(c, state.today).map(function (m) { return '<div class="kpi"><span class="v">' + m.value + '</span><span class="l">' + esc(m.label) + '</span></div>'; }).join('') + '</div><p class="na">מדדים תפעוליים בלבד; מדדים עסקיים ייבנו ממקורות מוגדרים.</p>';
    }

    function renderMain() {
      const title = (AREAS.filter(function (a) { return a.id === state.area; })[0] || AREAS[0]).label;
      $('#crm-title').textContent = title;
      if (state.loading) { main.innerHTML = '<div class="crm-state">טוען…</div>'; return; }
      if (state.error) { main.innerHTML = '<div class="crm-state bad">' + esc(state.error) + ' <button type="button" class="btn small" id="crm-retry">נסי שוב</button></div>'; return; }
      const c = compute(state.data, state.today);
      const r = { today: renderToday, leads: renderLeads, occupancy: renderOccupancy, clients: renderClients, calendar: renderCalendar, billing: renderBilling, control: renderControl }[state.area] || renderToday;
      main.innerHTML = r(c);
    }

    /* The client drawer: existing fields + the timeline from getActivity (B3). */
    function openDrawer(kind, id) {
      const c = compute(state.data, state.today);
      const lead = kind === 'lead' ? c.leads.filter(function (l) { return l.id === id; })[0] : null;
      const pat = kind === 'patient' ? c.patients.filter(function (p) { return p.id === id; })[0] : null;
      if (!lead && !pat) return;
      const dr = $('#crm-drawer');
      const name = lead ? lead.name : pat.name;
      const subject = lead ? { leadId: lead.id } : { patientId: pat.id };
      const kv = lead ? [['טלפון', lead.phone], ['בית', houseName(lead.house)], ['מקור', lead.source], ['אחראי', lead.assignedTo], ['שלב', stageLabel(lead.stage)], ['פגישה', fmtDate(lead.visitDate) + (lead.visitTime ? ' ' + lead.visitTime : '')], ['נוצר', fmtDate(lead.created)], ['נפגש/ת עם', lead.meetingWith], ['תוצאת פגישה', lead.meetingOutcome], ['איש קשר', lead.contactName + (lead.contactRelation ? ' (' + lead.contactRelation + ')' : '')], ['טלפון איש קשר', lead.contactPhone], ['הערות', lead.note]]
        : [['בית', houseName(pat.houseId)], ['תאריך כניסה', fmtDate(pat.date)], ['סטטוס', pat.status], ['ליד', pat.fromLead], ['מקור', pat.source]];
      const na = lead ? nextActionFor(lead, state.today) : null;
      dr.innerHTML = '<div class="drawer-head"><div><h2>' + esc(name) + '</h2><div class="meta">' + esc(lead ? stageLabel(lead.stage) + ' · ' + houseName(lead.house) : 'מטופל/ת · ' + houseName(pat.houseId)) + (na ? ' · ' + esc(na.text) : '') + '</div></div><button type="button" class="btn small" id="crm-drawer-close" aria-label="סגירה">✕</button></div>'
        + '<div class="tabs" role="tablist">' + [['overview', 'סקירה'], ['activity', 'פעילות'], ['meetings', 'פגישות ושירותים'], ['account', 'חשבון'], ['docs', 'מסמכים']].map(function (t, i) { return '<button type="button" role="tab" data-tab="' + t[0] + '" aria-selected="' + (i === 0) + '">' + esc(t[1]) + '</button>'; }).join('') + '</div>'
        + '<section data-pane="overview"><dl class="kv">' + kv.filter(function (x) { return s(x[1]); }).map(function (x) { return '<dt>' + esc(x[0]) + '</dt><dd>' + esc(x[1]) + '</dd>'; }).join('') + '</dl><p><a class="btn primary" href="/">עריכה בדשבורד</a></p></section>'
        + '<section data-pane="activity" hidden><ul class="tl" id="crm-tl"><li>טוען…</li></ul></section>'
        + '<section data-pane="meetings" hidden><p class="na">' + (lead && lead.visitDate ? 'פגישת קבלה ' + esc(fmtDate(lead.visitDate)) + (lead.meetingOutcome ? ' · ' + esc(lead.meetingOutcome) : ' · ללא תוצאה') : 'אין פגישות רשומות') + '</p></section>'
        + '<section data-pane="account" hidden><p class="na">' + (state.me && state.me.finance ? 'החשבון מנוהל בדשבורד הרגיל (גבייה).' : 'אין הרשאה לנתוני גבייה.') + '</p></section>'
        + '<section data-pane="docs" hidden><p class="na">מסמכים — חשבשבת נשארת המקור; עדיין לא מחובר.</p></section>';
      dr.setAttribute('aria-hidden', 'false');
      $('#crm-scrim').setAttribute('data-open', 'true');
      state.drawer = { kind: kind, id: id };
      api('getActivity', Object.assign({ limit: 50 }, subject)).then(function (r) {
        const tl = $('#crm-tl');
        if (!tl) return;
        if (!r || r.ok === false) { tl.innerHTML = '<li class="na">ציר הפעילות לא זמין (' + esc((r && r.error) || 'שגיאה') + ')</li>'; return; }
        if (!r.events || !r.events.length) { tl.innerHTML = '<li class="na">אין אירועים עדיין</li>'; return; }
        tl.innerHTML = r.events.map(function (e) { return '<li><div class="t">' + esc(fmtDate(String(e.occurredAt || '').slice(0, 10)) + ' ' + String(e.occurredAt || '').slice(11, 16)) + ' · ' + esc(e.actorName || e.source || '') + (String(e.source || '').indexOf('manual') === 0 ? ' · ידני' : ' · מערכת') + '</div><div>' + esc(e.summary || e.kind) + '</div></li>'; }).join('');
      });
    }
    function closeDrawer() { $('#crm-drawer').setAttribute('aria-hidden', 'true'); $('#crm-scrim').removeAttribute('data-open'); state.drawer = null; }

    /* events (delegated; filters, sort and scroll survive opening a card) */
    root.addEventListener('click', function (ev) {
      const t = ev.target.closest ? ev.target.closest('[data-area],[data-kpi],[data-view],[data-sort],[data-open-lead],[data-open-patient],[data-house-open],[data-tab],#crm-drawer-close,#crm-burger,#crm-scrim,#crm-retry') : null;
      if (!t) return;
      if (t.dataset.houseOpen) { ev.preventDefault(); state.filters.house = t.dataset.houseOpen; return setArea('clients'); }
      if (t.dataset.area) return setArea(t.dataset.area);
      if (t.dataset.kpi) { state.kpiFilter = state.kpiFilter === t.dataset.kpi ? '' : t.dataset.kpi; return renderMain(); }
      if (t.dataset.view) { state.view = t.dataset.view; return renderMain(); }
      if (t.dataset.sort) { state.sort = t.dataset.sort; return renderMain(); }
      if (t.dataset.openLead) return openDrawer('lead', t.dataset.openLead);
      if (t.dataset.openPatient) return openDrawer('patient', t.dataset.openPatient);
      if (t.dataset.tab) {
        doc.querySelectorAll('#crm-drawer [role="tab"]').forEach(function (b) { b.setAttribute('aria-selected', String(b === t)); });
        doc.querySelectorAll('#crm-drawer [data-pane]').forEach(function (p) { p.hidden = p.dataset.pane !== t.dataset.tab; });
        return;
      }
      if (t.id === 'crm-drawer-close' || t.id === 'crm-scrim') { closeDrawer(); menuEl.removeAttribute('data-open'); $('#crm-scrim').removeAttribute('data-open'); return; }
      if (t.id === 'crm-burger') { const open = menuEl.getAttribute('data-open') === 'true'; menuEl.setAttribute('data-open', String(!open)); $('#crm-scrim').setAttribute('data-open', String(!open)); return; }
      if (t.id === 'crm-retry') return load();
    });
    root.addEventListener('change', function (ev) {
      const t = ev.target;
      if (t.id === 'f-house' || t.id === 'f-house-c') state.filters.house = t.value;
      if (t.id === 'f-owner') state.filters.owner = t.value;
      renderMain();
    });
    $('#crm-search').addEventListener('input', function (ev) { state.filters.q = ev.target.value; if (state.area !== 'leads' && state.area !== 'clients') state.area = 'leads'; renderNav(); renderMain(); });
    doc.addEventListener('keydown', function (ev) { if (ev.key === 'Escape') closeDrawer(); });

    function load() {
      state.loading = true; state.error = ''; renderMain();
      return win.fetch('/api/me', { credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (me) {
        if (!me || me.ok === false) throw new Error('אין התחברות');
        state.me = me;
        $('#crm-user').textContent = me.user || '';
        if (areasFor(me).indexOf(state.area) < 0) state.area = 'today';
        const reads = [api('getData')];
        if (me.view === 'controller') reads.push(api('billingControlQueue'));
        return Promise.all(reads);
      }).then(function (res) {
        if (!res[0] || res[0].ok === false) throw new Error('הנתונים לא נטענו' + (res[0] && res[0].error ? ' (' + res[0].error + ')' : ''));
        state.data = res[0]; state.queue = res[1] || null; state.loading = false;
        renderNav(); renderMain();
      }).catch(function (e) { state.loading = false; state.error = String(e && e.message || e); renderNav(); renderMain(); });
    }
    renderNav(); renderMain();
    load();
    return { state: state, load: load, setArea: setArea };
  }

  return { HOUSES: HOUSES, STAGES: STAGES, AREAS: AREAS, WAIT_DAYS: WAIT_DAYS, areasFor: areasFor, normalise: normalise, compute: compute, filterLeads: filterLeads,
    board: board, nextActionFor: nextActionFor, clients: clients, calendar: calendar, control: control, controllerDay: controllerDay, houseName: houseName, houseId: houseId,
    occupancy: occupancy, inHouse: inHouse, fmtDate: fmtDate, esc: esc, boot: boot };
}));
