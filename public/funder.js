/* Patient funder (גורם מממן) over the Funders sheet — pure helpers.
 * CHANGELOG-patient-funder-on-funders.md.
 *
 * The source of truth is the existing append-only Funders sheet (#173/#176:
 * patientId, funder, effectiveFrom, setBy, setAt), whose `funder` is a Hebrew
 * label from PAYMENT_FUNDERS. Nothing is migrated: this module maps those
 * labels to stable keys for the UI (filter values, chips, strip rows).
 *
 * Rules (Sandra, locked):
 *   - five funders, stable keys private / btl / mod / maccabi / probono
 *     (probono appended last, CHANGELOG-funder-probono.md). There is NO
 *     default: no row, or an unrecognized label on the effective row → 'unset'
 *     («לא הוגדר») — never 'private'.
 *   - the funder on day D = the row with the latest effectiveFrom <= D; same
 *     day → the later setAt, then the later row (Code.gs currentFunderFrom_).
 *   - debt by funder: each owed cycle of the EXISTING debtAging report goes to
 *     the funder active on its start day. recorded_debt and unrecorded_cycles
 *     stay two figures, never summed.
 * UMD: the page loads it before app.js (global Funder); node --test requires it. */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Funder = api;
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const FUNDER_KEYS = Object.freeze(['private', 'btl', 'mod', 'maccabi', 'probono']);
  const FUNDER_UNSET = 'unset';
  /* A pro-bono patient owes nothing: debtAging_ drops the cycles whose funder
   * on their start day is pro-bono, so its strip row is always ₪0. */
  const FUNDER_PROBONO = 'probono';
  /* The Funders sheet's labels → keys. EXACT strings: no trim, no folding.
   * KEEP IN SYNC with Code.gs PAYMENT_FUNDERS (a guard test pins the keys of
   * this map to that list, in order). */
  const LABEL_TO_KEY = Object.freeze({
    'פרטי': 'private',
    'ביטוח לאומי': 'btl',
    'משרד הביטחון': 'mod',
    'מכבי': 'maccabi',
    'פרו-בונו': 'probono',
  });
  const KEY_TO_LABEL = Object.freeze(Object.keys(LABEL_TO_KEY).reduce(function (o, label) {
    o[LABEL_TO_KEY[label]] = label;
    return o;
  }, {}));
  const UNSET_LABEL = 'לא הוגדר';
  const DEBT_KINDS = Object.freeze(['recorded_debt', 'unrecorded_cycles']);

  /* A stored label → its key; anything else (blank, a typo, a key, a case
   * variant) → 'unset'. */
  function keyFromLabel(label) {
    return typeof label === 'string' && Object.prototype.hasOwnProperty.call(LABEL_TO_KEY, label)
      ? LABEL_TO_KEY[label] : FUNDER_UNSET;
  }
  function isFunderKey(v) {
    return typeof v === 'string' && FUNDER_KEYS.indexOf(v) >= 0;
  }
  /* key → the Hebrew label to display; 'unset' and unknown → «לא הוגדר». */
  function labelFor(key) {
    return isFunderKey(key) ? KEY_TO_LABEL[key] : UNSET_LABEL;
  }

  function realDay(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (!m) return '';
    const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
    return d.toISOString().slice(0, 10) === s ? s : '';
  }
  /* 'YYYY-MM-DD' (validated), or a Date / full timestamp read by its LOCAL
   * day (never a UTC slice — Israel is UTC+2/+3); '' otherwise. */
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
    return realDay(d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'));
  }

  /* rows → { patientId: [{ key, effectiveFrom, setAt, pos }] } in precedence
   * order (effectiveFrom, setAt, sheet order). A row without a patient id or
   * a readable effectiveFrom is skipped; an unrecognized label is KEPT as
   * 'unset' so it still wins its date. */
  function indexRows(rows) {
    const idx = {};
    (Array.isArray(rows) ? rows : []).forEach(function (r, pos) {
      if (!r || typeof r !== 'object') return;
      const id = String(r.patientId == null ? '' : r.patientId).trim();
      const eff = isoDay(r.effectiveFrom);
      if (!id || !eff) return;
      (idx[id] || (idx[id] = [])).push({
        key: keyFromLabel(typeof r.funder === 'string' ? r.funder.trim() : r.funder),
        effectiveFrom: eff, setAt: String(r.setAt == null ? '' : r.setAt), pos: pos,
      });
    });
    Object.keys(idx).forEach(function (k) {
      idx[k].sort(function (a, b) {
        if (a.effectiveFrom !== b.effectiveFrom) return a.effectiveFrom < b.effectiveFrom ? -1 : 1;
        if (a.setAt !== b.setAt) return a.setAt < b.setAt ? -1 : 1;
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
      if (list[i].effectiveFrom > day) break;
      out = list[i].key;
    }
    return out;
  }

  /* The funder KEY of `patientId` on `date` from Funders rows, or 'unset'. */
  function funderAt(fundersRows, patientId, date) {
    return funderAtIndexed(indexRows(fundersRows), patientId, isoDay(date));
  }

  function round2(n) { return Math.round(n * 100) / 100; }
  function emptyFigure() { return { count: 0, total: 0 }; }
  function addTo(fig, amount) { fig.count++; fig.total = round2(fig.total + amount); }

  /* Split the EXISTING debtAging report by funder (never recomputed).
   * → { private, btl, mod, maccabi, probono, unset }, each { recorded_debt, unrecorded_cycles
   * ({count,total}), byHouse: { houseId: { recorded_debt, unrecorded_cycles } } }.
   * Per figure, the six sum to report.totals and per house to report.byHouse.
   * asOf (optional) must equal report.asOf. */
  function debtByFunder(report, fundersRows, asOf) {
    if (!report || report.ok !== true || !Array.isArray(report.byPatient)) {
      throw new TypeError('debtByFunder: expected a debtAging report');
    }
    const reportAsOf = isoDay(report.asOf);
    const wanted = asOf === undefined || asOf === null || asOf === '' ? reportAsOf : isoDay(asOf);
    if (!wanted || (reportAsOf && wanted !== reportAsOf)) throw new RangeError('debtByFunder: asOf must equal the report asOf');
    const idx = indexRows(fundersRows);
    const out = {};
    FUNDER_KEYS.concat([FUNDER_UNSET]).forEach(function (k) {
      out[k] = { recorded_debt: emptyFigure(), unrecorded_cycles: emptyFigure(), byHouse: {} };
    });
    report.byPatient.forEach(function (p) {
      if (!p || !Array.isArray(p.cycles)) return;
      const house = String(p.houseId == null ? '' : p.houseId);
      p.cycles.forEach(function (c) {
        const kind = c && c.kind === 'recorded' ? 'recorded_debt' : c && c.kind === 'unrecorded' ? 'unrecorded_cycles' : '';
        if (!kind) return;
        const amount = Number(c.balance) || 0;
        const start = isoDay(c.start);
        const bucket = out[funderAtIndexed(idx, p.patientId, start && start <= wanted ? start : wanted)];
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
    FUNDER_PROBONO: FUNDER_PROBONO,
    LABEL_TO_KEY: LABEL_TO_KEY,
    KEY_TO_LABEL: KEY_TO_LABEL,
    UNSET_LABEL: UNSET_LABEL,
    DEBT_KINDS: DEBT_KINDS,
    keyFromLabel: keyFromLabel,
    isFunderKey: isFunderKey,
    labelFor: labelFor,
    isoDay: isoDay,
    funderAt: funderAt,
    debtByFunder: debtByFunder,
  };
}));
