/* Patient funder (גורם מממן) — pure helpers. CHANGELOG-patient-funder-foundation.md.
 *
 * FOUNDATION ONLY: nothing in the browser loads this file yet (not index.html,
 * not sw.js). PR 2 wires it into the UI. UMD so node --test can require it.
 *
 * The data is the FunderHistory sheet (Code.gs FUNDER_HISTORY_COLUMNS), served
 * as getData.funderHistory: rows of { id, patientId, funder, effectiveFrom
 * ('YYYY-MM-DD'), recordedAt (ISO), recordedBy }. Append-only: a correction
 * is a new row, never an edit.
 *
 * Rules (Sandra, locked):
 *   - funder keys are a fixed list with stable keys; no "other". No row for
 *     a patient on a day → 'unset' («לא הוגדר»).
 *   - the funder on day D = the row with the latest effectiveFrom <= D; for
 *     the same effectiveFrom the latest recordedAt wins (then the later row).
 *   - debt by funder: each owed cycle of the EXISTING debt report (Code.gs
 *     debtAging_ — never re-derived here) goes to the funder active on that
 *     cycle's start date. recorded_debt and unrecorded_cycles stay two
 *     figures, never summed (the debt-aging rule). */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Funder = api;
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* KEEP IN SYNC with Code.gs FUNDER_KEYS (a guard test pins them equal). */
  const FUNDER_KEYS = Object.freeze(['private', 'btl', 'mod', 'maccabi']);
  const FUNDER_UNSET = 'unset';
  const FUNDER_LABELS = Object.freeze({
    private: 'פרטי',
    btl:     'ביטוח לאומי',
    mod:     'משרד הביטחון',
    maccabi: 'מכבי',
    unset:   'לא הוגדר',
  });
  /* The two debt figures of debtAging_, kept apart. */
  const DEBT_KINDS = Object.freeze(['recorded_debt', 'unrecorded_cycles']);

  /* app.js pickField: the first non-empty value among `keys`. */
  function pickField(obj, keys) {
    if (!obj) return '';
    for (let i = 0; i < keys.length; i++) {
      const v = obj[keys[i]];
      if (v !== undefined && v !== null && v !== '') return v;
    }
    return '';
  }

  /* Exactly one of FUNDER_KEYS — no trim, no case folding, no Hebrew label. */
  function isFunderKey(v) {
    return typeof v === 'string' && FUNDER_KEYS.indexOf(v) >= 0;
  }

  function funderLabel(key) {
    return isFunderKey(key) ? FUNDER_LABELS[key] : FUNDER_LABELS.unset;
  }

  function realDay(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (!m) return '';
    const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
    return d.toISOString().slice(0, 10) === s ? s : '';
  }

  /* A value → 'YYYY-MM-DD', or '' when it is not a real day. A bare string
   * passes as-is (validated). A Date (a Sheets date-typed cell) or a full
   * timestamp string is read by its LOCAL parts, never a UTC slice — the
   * app.js isoDate rule (Israel is UTC+2/+3; a UTC slice drifts −1 day). */
  function isoDay(v) {
    if (v === undefined || v === null || v === '') return '';
    if (typeof v === 'string') {
      const s = v.trim();
      if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return realDay(s);
      if (!/^\d{4}-\d{2}-\d{2}T/.test(s)) return '';
    } else if (Object.prototype.toString.call(v) !== '[object Date]') {
      return '';
    }
    const d = new Date(v);
    if (isNaN(d.getTime())) return '';
    return realDay(d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0'));
  }

  /* recordedAt → epoch ms; unknown sorts first. */
  function recordedMs(v) {
    const t = Object.prototype.toString.call(v) === '[object Date]' ? v.getTime() : Date.parse(String(v || ''));
    return isNaN(t) ? -Infinity : t;
  }

  /* One FunderHistory row (any column naming) → a clean entry, or null when
   * it cannot count: no patient id, a funder that is not exactly a key, or
   * no real effectiveFrom day. Never throws. */
  function normalizeFunderEntry(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const patientId = String(pickField(raw, ['patientId', 'patient_id', 'patientUid', 'מזהה מטופל'])).trim();
    const funder = pickField(raw, ['funder', 'funderKey', 'גורם מממן']);
    const effectiveFrom = isoDay(pickField(raw, ['effectiveFrom', 'effective_from', 'החל מ']));
    if (!patientId || !isFunderKey(funder) || !effectiveFrom) return null;
    const at = pickField(raw, ['recordedAt', 'recorded_at', 'נרשם']);
    return {
      id: String(pickField(raw, ['id', 'מזהה'])),
      patientId: patientId,
      funder: funder,
      effectiveFrom: effectiveFrom,
      recordedAt: Object.prototype.toString.call(at) === '[object Date]'
        ? (isNaN(at.getTime()) ? '' : at.toISOString()) : String(at),
      recordedBy: String(pickField(raw, ['recordedBy', 'recorded_by'])),
    };
  }

  /* history (rows) → { patientId: [entry…] }, each list in precedence order:
   * effectiveFrom, then recordedAt, then sheet order (the later row wins). */
  function indexHistory(history) {
    const idx = {};
    (Array.isArray(history) ? history : []).forEach(function (raw, pos) {
      const e = normalizeFunderEntry(raw);
      if (!e) return;
      (idx[e.patientId] || (idx[e.patientId] = [])).push({ e: e, ms: recordedMs(e.recordedAt), pos: pos });
    });
    Object.keys(idx).forEach(function (k) {
      idx[k].sort(function (a, b) {
        if (a.e.effectiveFrom !== b.e.effectiveFrom) return a.e.effectiveFrom < b.e.effectiveFrom ? -1 : 1;
        if (a.ms !== b.ms) return a.ms < b.ms ? -1 : 1;
        return a.pos - b.pos;
      });
    });
    return idx;
  }

  function funderAtIndexed(idx, patientId, day) {
    const list = idx[String(patientId == null ? '' : patientId).trim()];
    if (!list || !day) return FUNDER_UNSET;
    let out = FUNDER_UNSET;
    for (let i = 0; i < list.length; i++) {
      if (list[i].e.effectiveFrom > day) break;
      out = list[i].e.funder;
    }
    return out;
  }

  /* The funder key of `patientId` on `isoDate`, or 'unset'. Pure. */
  function funderAt(history, patientId, isoDate) {
    return funderAtIndexed(indexHistory(history), patientId, isoDay(isoDate));
  }

  /* Today in Asia/Jerusalem as 'YYYY-MM-DD' (whatever the device zone). */
  function jerusalemToday(now) {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit' })
      .format(now || new Date());
  }

  /* The funder of `patientId` today (Asia/Jerusalem), or on `todayIso`. */
  function currentFunder(history, patientId, todayIso) {
    return funderAt(history, patientId, todayIso || jerusalemToday());
  }

  function round2(n) { return Math.round(n * 100) / 100; }
  function emptyFigure() { return { count: 0, total: 0 }; }
  function emptyBucket() {
    const o = { byHouse: {} };
    DEBT_KINDS.forEach(function (k) { o[k] = emptyFigure(); });
    return o;
  }
  function addTo(fig, amount) {
    fig.count++;
    fig.total = round2(fig.total + amount);
  }

  /* Split the EXISTING debt report by funder.
   *   report  — a debtAging_ response ({ ok:true, asOf, byPatient: [{ patientId,
   *             houseId, cycles: [{ start, balance, kind }] }] }); the debt is
   *             taken as-is, never recomputed.
   *   history — FunderHistory rows (getData.funderHistory).
   *   asOfDate — optional; must equal report.asOf when both are given.
   * → { private, btl, mod, maccabi, unset }, each { recorded_debt: {count,total},
   *   unrecorded_cycles: {count,total}, byHouse: { houseId: { recorded_debt,
   *   unrecorded_cycles } } }. A cycle goes to the funder active on its start
   *   day; a patient with no history (or no id) → unset. For each figure, the
   *   five funders sum to report.totals, and per house to report.byHouse. */
  function debtByFunder(report, history, asOfDate) {
    if (!report || report.ok !== true || !Array.isArray(report.byPatient)) {
      throw new TypeError('debtByFunder: expected a debtAging report');
    }
    const reportAsOf = isoDay(report.asOf);
    const wanted = asOfDate === undefined || asOfDate === null || asOfDate === '' ? reportAsOf : isoDay(asOfDate);
    if (!wanted || (reportAsOf && wanted !== reportAsOf)) {
      throw new RangeError('debtByFunder: asOfDate must equal the report asOf');
    }
    const idx = indexHistory(history);
    const out = {};
    FUNDER_KEYS.concat([FUNDER_UNSET]).forEach(function (k) { out[k] = emptyBucket(); });
    report.byPatient.forEach(function (p) {
      if (!p || !Array.isArray(p.cycles)) return;
      const house = String(p.houseId == null ? '' : p.houseId);
      p.cycles.forEach(function (c) {
        const kind = c && c.kind === 'recorded' ? 'recorded_debt' : c && c.kind === 'unrecorded' ? 'unrecorded_cycles' : '';
        if (!kind) return;
        const amount = Number(c.balance) || 0;
        const start = isoDay(c.start);
        const day = start && start <= wanted ? start : wanted;
        const f = funderAtIndexed(idx, p.patientId, day);
        const bucket = out[f];
        addTo(bucket[kind], amount);
        const h = bucket.byHouse[house] || (bucket.byHouse[house] = { recorded_debt: emptyFigure(), unrecorded_cycles: emptyFigure() });
        addTo(h[kind], amount);
      });
    });
    return out;
  }

  return {
    FUNDER_KEYS: FUNDER_KEYS,
    FUNDER_UNSET: FUNDER_UNSET,
    FUNDER_LABELS: FUNDER_LABELS,
    isFunderKey: isFunderKey,
    funderLabel: funderLabel,
    isoDay: isoDay,
    normalizeFunderEntry: normalizeFunderEntry,
    funderAt: funderAt,
    currentFunder: currentFunder,
    debtByFunder: debtByFunder,
  };
}));
