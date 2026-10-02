/* «חובות פתוחים» — the debtAging response (apps-script/Code.gs debtAging_) as
 * a filtered view and as an .xlsx spec for lib/xlsx-report.js.
 * Pure: no I/O, no clock (the caller passes `now` / `todayIso`).
 *
 * NO NEW MATH. Every amount comes from the server's own cycles. The view only
 *   - FILTERS (house, patient status) and
 *   - GROUPS the cycles the server returned into the house × bucket tables.
 * With no filter, the tables equal the server's `totals` / `byHouse` exactly
 * (test/debt-aging-ui.test.js runs the real Code.gs and checks it).
 *
 * The two figures are NEVER added together:
 *   «חוב רשום»            recorded_debt     — a Payments row exists and is short;
 *   «מחזורים ללא רישום»   unrecorded_cycles — no Payments row at all.
 * There is no field, cell or label anywhere here that combines them. Pending
 * credits are reported BESIDE the debt, never subtracted. The separate lists
 * (detached payments, rows after exit, discharged with no exit date,
 * zero-amount patients, no entry date) are never part of either total.
 *
 * public/app.js carries the browser copy of debtAgingView and the labels below
 * (DEBT_AGING_*). test/debt-aging-ui.test.js fails if the two drift apart. */

const { HOUSE_NAMES } = require('./refund-forecast-xlsx');

const HOUSE_ORDER = Object.keys(HOUSE_NAMES);
const DEBT_BUCKETS = [
  { key: 'd0_7',     label: '0–7' },
  { key: 'd8_30',    label: '8–30' },
  { key: 'd31_60',   label: '31–60' },
  { key: 'd61_plus', label: '61+' },
];
const BLOCK_LABELS = {
  recorded_debt:     'חוב רשום',
  unrecorded_cycles: 'מחזורים ללא רישום',
};
const UNRECORDED_NOTE = 'לא שולם או שולם ולא נרשם';
/* lib/report-colors.js keys: חוב רשום red, מחזורים ללא רישום orange; the
 * credits line green; the separate lists grey. */
const BLOCK_COLORS = { recorded_debt: 'debt', unrecorded_cycles: 'unrecorded' };
const CREDITS_LABEL = 'זיכויים ממתינים — לא מקוזזים מהחוב';
const STATUS_LABELS = { all: 'כל המטופלים', active: 'פעילים', discharged: 'משוחררים' };
const PATIENT_STATUS_LABELS = { active: 'פעיל', discharged: 'משוחרר' };
const KIND_LABELS = { recorded: 'חוב רשום', unrecorded: 'ללא רישום' };
const DETACHED_REASON_LABELS = { not_a_patient: 'סומן: לא כסף של מטופל', unmatched: 'לא נמצא מטופל תואם' };
const LIST_LABELS = {
  detached:      'תשלומים לא משויכים',
  outsideStay:   'תשלומים אחרי יציאה',
  releasedNoExit: 'משוחררים ללא תאריך יציאה',
  zeroAmount:    'מטופלים בסכום אפס',
  noEntryDate:   'ללא תאריך כניסה',
};
const SHEET_NAMES = {
  summary:     'סיכום',
  recorded:    'חוב רשום',
  unrecorded:  'מחזורים ללא רישום',
  detached:    'תשלומים לא משויכים',
  outsideStay: 'תשלומים אחרי יציאה',
  noExit:      'חסרי תאריך יציאה',
};

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

/* A bare 'YYYY-MM-DD' naming a real calendar day (2026-02-30 is not). Pure. */
function isRealIsoDay(s) {
  if (typeof s !== 'string' || !ISO_RE.test(s)) return false;
  const d = new Date(Date.UTC(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10))));
  return d.toISOString().slice(0, 10) === s;
}

/* The export's query string → { ok, asOf, house, status } or { ok:false, error }.
 * asOf is REQUIRED (a real day). house: '' / 'all' / a known house id.
 * status: '' / 'all' / 'active' / 'discharged'. A repeated parameter (an
 * array) is refused. Pure. */
function validateDebtAgingQuery(query) {
  const q = query || {};
  const one = (k) => (q[k] === undefined ? '' : q[k]);
  const asOf = one('asOf'), house = one('house'), status = one('status');
  if (typeof asOf !== 'string' || !isRealIsoDay(asOf)) return { ok: false, error: 'bad_asOf' };
  if (typeof house !== 'string' || (house !== '' && house !== 'all' && HOUSE_ORDER.indexOf(house) < 0)) return { ok: false, error: 'bad_house' };
  if (typeof status !== 'string' || (status !== '' && !Object.prototype.hasOwnProperty.call(STATUS_LABELS, status))) return { ok: false, error: 'bad_status' };
  return { ok: true, asOf, house: house || 'all', status: status || 'all' };
}

/* True when `data` has the shape debtAging returns on success. */
function isDebtAgingResponse(data) {
  return !!(data && data.ok === true && typeof data.asOf === 'string' &&
    data.totals && data.totals.recorded_debt && data.totals.unrecorded_cycles &&
    Array.isArray(data.byPatient));
}

function houseName(id) { return HOUSE_NAMES[id] || id || '—'; }
function patientStatusGroup(status) { return status === 'released' ? 'discharged' : 'active'; }
function bucketLabel(key) {
  const b = DEBT_BUCKETS.find((x) => x.key === key);
  return b ? b.label : String(key || '—');
}

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const arr = (v) => (Array.isArray(v) ? v : []);
const rowsOf = (o) => arr(o && o.rows);

/* The filtered view of one debtAging response. Pure.
 * filters: { house: 'all'|<id>, status: 'all'|'active'|'discharged' }. */
function debtAgingView(data, filters) {
  const f = filters || {};
  const house = f.house || 'all', status = f.status || 'all';
  const houseOk = (h) => house === 'all' || h === house;
  const statusOk = (s) => status === 'all' || patientStatusGroup(s) === status;

  // The houses shown: every known house in a fixed order, plus any other id
  // the data carries (shown under its raw id), or just the filtered one.
  const seen = [];
  arr(data.byPatient).forEach((p) => seen.push(p.houseId));
  arr(data.byHouse).forEach((h) => seen.push(h.houseId));
  arr(data.pendingCredits && data.pendingCredits.byHouse).forEach((h) => seen.push(h.houseId));
  const extra = seen.filter((h, i) => h && HOUSE_ORDER.indexOf(h) < 0 && seen.indexOf(h) === i).sort();
  const houseIds = house === 'all' ? HOUSE_ORDER.concat(extra) : [house];

  const emptyRow = (houseId) => {
    const o = { houseId, house: houseId ? houseName(houseId) : 'סה"כ', total: 0 };
    DEBT_BUCKETS.forEach((b) => { o[b.key] = 0; });
    return o;
  };
  const table = () => ({ rows: houseIds.map(emptyRow), totals: emptyRow('') });
  const tables = { recorded_debt: table(), unrecorded_cycles: table() };
  const addTo = (t, houseId, bucket, amount) => {
    let row = t.rows.find((r) => r.houseId === houseId);
    if (!row) { row = emptyRow(houseId); t.rows.push(row); }
    if (!(bucket in row)) return;
    row[bucket] = r2(row[bucket] + amount); row.total = r2(row.total + amount);
    t.totals[bucket] = r2(t.totals[bucket] + amount); t.totals.total = r2(t.totals.total + amount);
  };

  const patients = [];
  const zeroAmount = [];
  arr(data.byPatient).forEach((p) => {
    if (!houseOk(p.houseId) || !statusOk(p.status)) return;
    const owed = arr(p.cycles).filter((c) => Number(c.balance) > 0);
    const base = { patientId: p.patientId, name: p.name, houseId: p.houseId, status: p.status,
      statusGroup: patientStatusGroup(p.status), entryDate: p.entryDate || '', exitDate: p.exitDate || '' };
    if (!owed.length) { zeroAmount.push(Object.assign(base, { cycles: arr(p.cycles).length })); return; }
    let recorded = 0, unrecorded = 0, oldest = -1;
    owed.forEach((c) => {
      const bal = Number(c.balance) || 0;
      if (c.kind === 'recorded') { recorded = r2(recorded + bal); addTo(tables.recorded_debt, p.houseId, c.bucket, bal); }
      else { unrecorded = r2(unrecorded + bal); addTo(tables.unrecorded_cycles, p.houseId, c.bucket, bal); }
      oldest = Math.max(oldest, DEBT_BUCKETS.findIndex((b) => b.key === c.bucket));
    });
    patients.push(Object.assign(base, {
      recordedBalance: recorded, unrecordedTotal: unrecorded,
      oldestBucket: oldest >= 0 ? DEBT_BUCKETS[oldest].key : '',
      cycles: owed.slice().sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0)),
    }));
  });
  const orderOf = (h) => { const i = houseIds.indexOf(h); return i < 0 ? houseIds.length : i; };
  patients.sort((a, b) => (orderOf(a.houseId) - orderOf(b.houseId)) || String(a.name).localeCompare(String(b.name), 'he'));

  const creditRows = arr(data.pendingCredits && data.pendingCredits.byHouse)
    .filter((h) => houseOk(h.houseId))
    .map((h) => ({ houseId: h.houseId, house: houseName(h.houseId), count: Number(h.count) || 0, total: r2(h.total) }))
    .sort((a, b) => orderOf(a.houseId) - orderOf(b.houseId));
  const credits = {
    rows: creditRows,
    count: creditRows.reduce((s, r) => s + r.count, 0),
    total: r2(creditRows.reduce((s, r) => s + r.total, 0)),
  };

  // Separate lists — never part of either debt figure. Detached payments have
  // no patient, so the status filter does not apply to them; a "released
  // with no exit date" patient is discharged by definition.
  const detachedRows = rowsOf(data.detachedPayments).filter((r) => houseOk(r.houseId));
  const outsideRows = rowsOf(data.outsideStay).filter((r) => houseOk(r.houseId) && statusOk(r.status));
  const noExitRows = rowsOf(data.releasedWithoutExit).filter((r) => houseOk(r.houseId) && (status === 'all' || status === 'discharged'));
  const noEntryRows = rowsOf(data.noEntryDate).filter((r) => houseOk(r.houseId) && statusOk(r.status));
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

const fmtDayHe = (iso) => (ISO_RE.test(String(iso)) ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : String(iso || ''));

/* The workbook spec. Six sheets; every total is the block's own. Pure. */
function buildDebtAgingSpec(data, filters, now, todayIso) {
  const view = debtAgingView(data, filters);
  const caveats = debtAgingCaveats(data, todayIso);
  const title = `חובות פתוחים נכון ל־${fmtDayHe(view.asOf)}`;

  const bucketCols = [{ header: 'בית', key: 'house', type: 'text', width: 20 }]
    .concat(DEBT_BUCKETS.map((b) => ({ header: `${b.label} ימים`, key: b.key, type: 'money', width: 14 })))
    .concat([{ header: 'סה"כ', key: 'total', type: 'money', width: 16 }]);
  const blockSection = (key, heading) => {
    const t = view.tables[key];
    const values = { total: t.totals.total };
    DEBT_BUCKETS.forEach((b) => { values[b.key] = t.totals[b.key]; });
    return { heading, color: BLOCK_COLORS[key], columns: bucketCols, rows: t.rows, totals: [{ label: 'סה"כ ' + BLOCK_LABELS[key], values }] };
  };
  const L = view.lists;
  const summary = {
    name: SHEET_NAMES.summary, title,
    // The report's details ride as merged note lines (not a table), so a long
    // caveat never widens a bucket column.
    note: ['שני הגושים אינם מסתכמים יחד · זיכויים ממתינים אינם מקוזזים מהחוב · הסכומים כוללים מע"מ',
      `בית: ${view.house === 'all' ? 'כל הבתים' : houseName(view.house)} · סטטוס מטופל: ${STATUS_LABELS[view.status] || view.status}`]
      .concat(caveats),
    sections: [
      blockSection('recorded_debt', BLOCK_LABELS.recorded_debt + ' — שורות תשלום שלא שולמו או שולמו חלקית'),
      blockSection('unrecorded_cycles', BLOCK_LABELS.unrecorded_cycles + ' — ' + UNRECORDED_NOTE),
      { heading: CREDITS_LABEL, color: 'credits',
        columns: [
          { header: 'בית', key: 'house', type: 'text', width: 20 },
          { header: 'מספר', key: 'count', type: 'int', width: 10 },
          { header: 'סכום', key: 'total', type: 'money', width: 14 },
        ],
        rows: view.credits.rows,
        totals: [{ label: 'סה"כ זיכויים ממתינים', values: { count: view.credits.count, total: view.credits.total } }],
        emptyText: 'אין זיכויים ממתינים בתאריך זה' },
      { heading: 'לבדיקה — לא נכלל בחוב (כל שורה בנפרד, ללא סה"כ)', color: 'unresolved',
        columns: [
          { header: 'רשימה', key: 'label', type: 'text', width: 30 },
          { header: 'מספר', key: 'count', type: 'int', width: 10 },
          { header: 'סכום', key: 'total', type: 'money', width: 14 },
        ],
        rows: [
          { label: LIST_LABELS.detached, count: L.detached.count, total: L.detached.total },
          { label: LIST_LABELS.outsideStay, count: L.outsideStay.count },
          { label: LIST_LABELS.releasedNoExit, count: L.releasedNoExit.count },
          { label: LIST_LABELS.zeroAmount, count: L.zeroAmount.count, total: 0 },
          { label: LIST_LABELS.noEntryDate, count: L.noEntryDate.count },
        ] },
    ],
  };

  const cycleRows = (kind) => {
    const out = [];
    view.patients.forEach((p) => p.cycles.filter((c) => c.kind === kind).forEach((c) => out.push({
      name: p.name, house: houseName(p.houseId), status: PATIENT_STATUS_LABELS[p.statusGroup],
      start: c.start, end: c.end, expected: c.expected, received: c.received, balance: c.balance,
      days: c.days, bucket: bucketLabel(c.bucket), note: UNRECORDED_NOTE,
    })));
    return out;
  };
  const identCols = [
    { header: 'מטופל', key: 'name', type: 'text', width: 24 },
    { header: 'בית', key: 'house', type: 'text', width: 16 },
    { header: 'סטטוס', key: 'status', type: 'text', width: 10 },
  ];
  const recordedSheet = {
    name: SHEET_NAMES.recorded, title: title + ' — ' + BLOCK_LABELS.recorded_debt, color: BLOCK_COLORS.recorded_debt,
    columns: identCols.concat([
      { header: 'תחילת מחזור', key: 'start', type: 'date', width: 14 },
      { header: 'סוף מחזור', key: 'end', type: 'date', width: 14 },
      { header: 'צפוי', key: 'expected', type: 'money', width: 14 },
      { header: 'התקבל עד התאריך', key: 'received', type: 'money', width: 16 },
      { header: 'יתרה', key: 'balance', type: 'money', width: 14 },
      { header: 'ימים', key: 'days', type: 'int', width: 10 },
      { header: 'תקופת חוב (ימים)', key: 'bucket', type: 'text', width: 14 },
    ]),
    rows: cycleRows('recorded'),
    totals: [{ label: 'סה"כ ' + BLOCK_LABELS.recorded_debt, values: { balance: view.tables.recorded_debt.totals.total } }],
    emptyText: 'אין חוב רשום בתאריך זה',
  };
  const unrecordedSheet = {
    name: SHEET_NAMES.unrecorded, title: title + ' — ' + BLOCK_LABELS.unrecorded_cycles, color: BLOCK_COLORS.unrecorded_cycles,
    note: UNRECORDED_NOTE,
    columns: identCols.concat([
      { header: 'תחילת מחזור', key: 'start', type: 'date', width: 14 },
      { header: 'סוף מחזור', key: 'end', type: 'date', width: 14 },
      { header: 'סכום צפוי', key: 'balance', type: 'money', width: 14 },
      { header: 'ימים', key: 'days', type: 'int', width: 10 },
      { header: 'תקופת חוב (ימים)', key: 'bucket', type: 'text', width: 14 },
      { header: 'הערה', key: 'note', type: 'text', width: 26 },
    ]),
    rows: cycleRows('unrecorded'),
    totals: [{ label: 'סה"כ ' + BLOCK_LABELS.unrecorded_cycles, values: { balance: view.tables.unrecorded_cycles.totals.total } }],
    emptyText: 'אין מחזורים ללא רישום בתאריך זה',
  };
  const detachedSheet = {
    name: SHEET_NAMES.detached, title: title + ' — ' + LIST_LABELS.detached, color: 'unresolved',
    note: 'לא נכלל בחוב',
    columns: [
      { header: 'שם בשורת התשלום', key: 'name', type: 'text', width: 24 },
      { header: 'בית', key: 'house', type: 'text', width: 16 },
      { header: 'תאריך לתשלום', key: 'dueDate', type: 'date', width: 14 },
      { header: 'סכום', key: 'amount', type: 'money', width: 14 },
      { header: 'התקבל עד התאריך', key: 'receivedByAsOf', type: 'money', width: 16 },
      { header: 'סיבה', key: 'reason', type: 'text', width: 26 },
    ],
    rows: L.detached.rows.map((r) => ({
      name: r.patientName, house: houseName(r.houseId), dueDate: r.dueDate, amount: r.amount,
      receivedByAsOf: r.receivedByAsOf, reason: DETACHED_REASON_LABELS[r.reason] || r.reason || '',
    })),
    totals: [{ label: `סה"כ ${LIST_LABELS.detached} (${L.detached.count})`, values: { amount: L.detached.total, receivedByAsOf: L.detached.receivedByAsOf } }],
    emptyText: 'אין תשלומים לא משויכים',
  };
  const outsideSheet = {
    name: SHEET_NAMES.outsideStay, title: title + ' — ' + LIST_LABELS.outsideStay, color: 'unresolved',
    note: 'שורת תשלום שמחזורה מחוץ לתקופת השהייה — לא נכלל בחוב',
    columns: identCols.concat([
      { header: 'תחילת מחזור', key: 'start', type: 'date', width: 14 },
      { header: 'כניסה', key: 'entryDate', type: 'date', width: 14 },
      { header: 'יציאה', key: 'exitDate', type: 'date', width: 14 },
    ]),
    rows: L.outsideStay.rows.map((r) => ({
      name: r.name, house: houseName(r.houseId), status: PATIENT_STATUS_LABELS[patientStatusGroup(r.status)],
      start: r.start, entryDate: r.entryDate, exitDate: r.exitDate,
    })),
    totals: [{ label: 'מספר שורות', values: { house: L.outsideStay.count } }],
    emptyText: 'אין תשלומים אחרי יציאה',
  };
  const noExitSheet = {
    name: SHEET_NAMES.noExit, title: title + ' — ' + LIST_LABELS.releasedNoExit, color: 'unresolved',
    note: 'משוחררים ללא תאריך יציאה — לא נוצרו להם מחזורים; לא נכלל בחוב',
    columns: [
      { header: 'מטופל', key: 'name', type: 'text', width: 24 },
      { header: 'בית', key: 'house', type: 'text', width: 16 },
      { header: 'כניסה', key: 'entryDate', type: 'date', width: 14 },
    ],
    rows: L.releasedNoExit.rows.map((r) => ({ name: r.name, house: houseName(r.houseId), entryDate: r.entryDate })),
    totals: [{ label: 'מספר מטופלים', values: { house: L.releasedNoExit.count } }],
    emptyText: 'אין משוחררים ללא תאריך יציאה',
  };

  return {
    generatedAt: now,
    sheets: [summary, recordedSheet, unrecordedSheet, detachedSheet, outsideSheet, noExitSheet],
  };
}

/* An attachment Content-Disposition: an ASCII fallback name plus the RFC 5987
 * UTF-8 «חובות-YYYY-MM-DD.xlsx». The day is validated, so nothing from the
 * request can reach the header. Pure. */
function debtAgingContentDisposition(isoDay) {
  const day = isRealIsoDay(String(isoDay)) ? String(isoDay) : 'unknown-date';
  const utf8Name = `חובות-${day}.xlsx`;
  const encoded = encodeURIComponent(utf8Name).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return `attachment; filename="debt-aging-${day}.xlsx"; filename*=UTF-8''${encoded}`;
}

module.exports = {
  debtAgingView,
  debtAgingCaveats,
  buildDebtAgingSpec,
  validateDebtAgingQuery,
  isDebtAgingResponse,
  debtAgingContentDisposition,
  isRealIsoDay,
  patientStatusGroup,
  DEBT_BUCKETS,
  BLOCK_LABELS,
  UNRECORDED_NOTE,
  CREDITS_LABEL,
  STATUS_LABELS,
  PATIENT_STATUS_LABELS,
  KIND_LABELS,
  DETACHED_REASON_LABELS,
  LIST_LABELS,
  SHEET_NAMES,
};
