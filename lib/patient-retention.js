/* «חתכי מטופלים» — length of stay and continuity of care
 * (CHANGELOG-patient-retention-foundation.md).
 *
 * PURE: no DOM, no I/O, no logging. node --test requires it; a page can load
 * it as window.PatientRetention (the same UMD shape as lib/leads-funnel.js).
 * It reads only what getData already carries (Patients rows and the
 * discharged-audit rows) — no Code.gs read change.
 *
 * DATES. Every date is a calendar day 'YYYY-MM-DD' in Israel time — the same
 * day app.js isoDate() gives: a bare 'YYYY-MM-DD' is taken as is (never
 * parsed through Date, which would read it as UTC midnight), a full ISO
 * timestamp is converted to its Asia/Jerusalem calendar day. Day arithmetic
 * uses Date.UTC on the three numbers, so no timezone or DST shift is possible.
 *
 * THE DAY COUNT IS NOT INCLUSIVE: stayDays = discharge day − entry day.
 * Entry and discharge on the same day = 0 days; entry 01/10, discharge 31/10
 * = 30 days. An active stay counts to `today` the same way.
 *
 * THE DISCHARGE DAY of a stay is its audit row's `exitDate` (the date chosen
 * in the שחרור modal), else the calendar day of `dischargedAt` (the action
 * timestamp — rows recorded before the date field existed), else the
 * Patients row's `exitDate`. This is the order the «מטופלים משוחררים» tab
 * already displays.
 *
 * THE UNIT IS A STAY, not a person. A returning patient (personId set) has
 * one Patients row per stay, each with its own entry date, and each discharge
 * has its own audit row — so every stay is placed by its OWN entry date and
 * its OWN discharge date. Stays are joined across the two lists by the stay
 * key (houseId + name + entry date — dischargeStayKey_ in Code.gs) or by the
 * audit row's patientId:
 *   - an OPEN audit row (not restored, not soft-deleted) = a discharged stay;
 *     two open rows of one stay (a duplicate) count once (first wins);
 *   - a restored audit row is NOT a discharge any more (the stay went back to
 *     active) and is ignored; the Patients row decides;
 *   - a Patients row that is not 'released' = a stay still in treatment;
 *   - a 'released' Patients row with no open audit row = a discharged stay
 *     whose continuity is unknown (no row to record it on).
 *
 * THE COHORT: the stays whose entry date is in [from, to], both INCLUSIVE.
 * A stay that cannot be placed is never silently dropped — it is listed in
 * `missing` («נתונים חסרים») with a reason:
 *   no_entry_date        — no / invalid entry date (cannot be placed in any
 *                          period, so it is listed whatever the period);
 *   no_discharge_date    — discharged, entry in the period, no discharge day;
 *   discharge_before_entry — discharged, entry in the period, discharge day
 *                          earlier than the entry day;
 *   entry_in_future      — still in treatment, entry in the period but after
 *                          today (not in the house yet).
 *
 * BUCKETS (stayDays): upTo30 = 0–30, d31to60 = 31–60, over60 = 61+.
 * CUSTOM SPLIT «לתקופה מסוימת» at N days (a whole number 1–3650; anything
 * else = no split): atOrBelow = days ≤ N, above = days > N — over the
 * discharged stays, like the buckets.
 *
 * PERCENTAGES are fractions (0..1, or null when the base is 0) so the screen,
 * the CSV and an Excel % cell all use the same number:
 *   length cards (incl. «עדיין בטיפול») → of the cohort (placed stays only,
 *   i.e. discharged + still in treatment, missing excluded);
 *   continuity cards → of the discharged stays only. */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PatientRetention = api;
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
  const TZ = 'Asia/Jerusalem';
  const THRESHOLD_MIN = 1;
  const THRESHOLD_MAX = 3650;

  /* Stable keys persisted in the discharged sheet's `continuity` column
   * (Code.gs CONTINUITY_KEYS mirrors this list). Hebrew labels are render-time
   * only, so a label rename never invalidates a stored row. 'unknown' is the
   * default for every legacy row and is never offered as a choice. */
  const CONTINUITY_LABELS = Object.freeze({
    continued_outpatient: 'המשיך באמבולטורי (E-ZONE)',
    continued_other: 'המשיך במסגרת טיפולית אחרת',
    none: 'לא המשיך',
    unknown: 'לא ידוע',
  });
  const CONTINUITY_KEYS = Object.freeze(['continued_outpatient', 'continued_other', 'none', 'unknown']);
  /* The values a person may pick (the discharge modal, the inline update). */
  const CONTINUITY_CHOICES = Object.freeze(['continued_outpatient', 'continued_other', 'none']);
  const CONTINUITY_DEFAULT = 'unknown';

  const BUCKETS = Object.freeze([
    { key: 'upTo30', label: 'עד 30 יום', min: 0, max: 30 },
    { key: 'd31to60', label: '31–60 יום', min: 31, max: 60 },
    { key: 'over60', label: '61 יום ומעלה', min: 61, max: Infinity },
  ]);
  const STILL_IN_TREATMENT_LABEL = 'עדיין בטיפול';
  const MISSING_LABEL = 'נתונים חסרים';
  const COHORT_RULE_LABEL = 'לפי תאריך כניסה בתקופה';
  const MISSING_REASONS = Object.freeze({
    no_entry_date: 'חסר תאריך כניסה',
    no_discharge_date: 'חסר תאריך שחרור',
    discharge_before_entry: 'תאריך שחרור לפני תאריך כניסה',
    entry_in_future: 'תאריך כניסה עתידי',
  });

  const text = (v) => String(v == null ? '' : v).trim();
  const restoredFlag = (v) => v === true || text(v).toUpperCase() === 'TRUE';

  function isRealIso(s) {
    if (!ISO_RE.test(String(s || ''))) return false;
    const d = new Date(s + 'T00:00:00Z');
    return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }

  /* Any date value → 'YYYY-MM-DD' (Israel calendar day) or ''. */
  function toDay(v) {
    if (v === null || v === undefined || v === '') return '';
    if (typeof v === 'string') {
      const s = v.trim();
      if (ISO_RE.test(s)) return isRealIso(s) ? s : '';
      // Only full timestamps are converted; a free-text cell is not a date.
      if (!/^\d{4}-\d{2}-\d{2}T/.test(s)) return '';
    }
    const d = v instanceof Date ? v : new Date(v);
    if (isNaN(d.getTime())) return '';
    try {
      return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
    } catch (_) {
      return '';
    }
  }

  /* Whole days from day `a` to day `b` (b − a), or null. */
  function daysBetween(a, b) {
    if (!isRealIso(a) || !isRealIso(b)) return null;
    const ms = (s) => Date.UTC(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10)));
    return Math.round((ms(b) - ms(a)) / 86400000);
  }

  function todayIso(now) {
    return toDay(now instanceof Date ? now : new Date());
  }

  function isReleased(p) {
    const s = text(p && p.status).toLowerCase();
    return s === 'released' || s === 'שוחרר' || s === 'שחרור';
  }

  /* The stay's discharge day — see THE DISCHARGE DAY above. */
  function dischargeDayOf(patient) {
    const p = patient || {};
    return toDay(p.exitDate) || toDay(p.dischargedAt);
  }

  /* stayDays(patient, today?) — not inclusive (same day = 0). A discharged
   * stay (released, or an audit row with a discharge day) counts to its
   * discharge day; anything else counts to `today` (default: Israel today).
   * null when the entry date (`date` / `entryDate`) is missing or invalid, or
   * a released stay has no discharge day. */
  function stayDays(patient, today) {
    const p = patient || {};
    const entry = toDay(p.entryDate !== undefined && p.entryDate !== '' ? p.entryDate : p.date);
    if (!entry) return null;
    const end = dischargeDayOf(p);
    if (isReleased(p) || p.dischargedAt) return end ? daysBetween(entry, end) : null;
    return daysBetween(entry, isRealIso(today) ? today : todayIso());
  }

  /* A custom threshold → a whole number in [1, 3650], or null. Accepts a
   * number or a numeric string ("45"); rejects 0, negatives, fractions,
   * NaN, Infinity, '' and null. */
  function normalizeThreshold(v) {
    if (v === null || v === undefined) return null;
    const s = typeof v === 'number' ? v : (/^\s*\d+\s*$/.test(String(v)) ? Number(String(v).trim()) : NaN);
    if (!Number.isInteger(s) || s < THRESHOLD_MIN || s > THRESHOLD_MAX) return null;
    return s;
  }

  /* bucketFor(days, customThreshold) → { bucket, custom } where
   *   bucket  'upTo30' | 'd31to60' | 'over60' (null for an invalid day count)
   *   custom  'atOrBelow' | 'above' — the split at N days — or null when the
   *           threshold is null / invalid (or the day count is). */
  function bucketFor(days, customThreshold) {
    if (typeof days !== 'number' || !Number.isInteger(days) || days < 0) return { bucket: null, custom: null };
    const b = BUCKETS.find((x) => days >= x.min && days <= x.max);
    const n = normalizeThreshold(customThreshold);
    return { bucket: b ? b.key : null, custom: n === null ? null : (days <= n ? 'atOrBelow' : 'above') };
  }

  function normalizeContinuity(v) {
    const k = text(v);
    return CONTINUITY_KEYS.indexOf(k) >= 0 ? k : CONTINUITY_DEFAULT;
  }

  /* The stay key — dischargeStayKey_ in Code.gs: houseId + name (trimmed,
   * inner whitespace collapsed) + entry day; '' when house or name is blank. */
  function stayKey(r) {
    const houseId = text(r && r.houseId);
    const name = String((r && r.name) == null ? '' : r.name).replace(/\s+/g, ' ').trim();
    if (!houseId || !name) return '';
    return houseId + '::' + name + '::' + String((r && r.date) == null ? '' : r.date).slice(0, 10);
  }

  function dischargeRowOpen(d) {
    return !!d && !restoredFlag(d.restored) && !text(d.deletedAt);
  }

  /* fraction n / base, or null when base is 0. */
  function percentOf(n, base) {
    return base > 0 ? n / base : null;
  }
  /* A fraction → '42.9%' (one decimal, trailing .0 dropped); '—' for null. */
  function formatPercent(f) {
    if (f === null || f === undefined || !isFinite(f)) return '—';
    const v = Math.round(f * 1000) / 10;
    return (Number.isInteger(v) ? String(v) : v.toFixed(1)) + '%';
  }

  function stayRow(src, extra) {
    const s = src || {};
    return Object.assign({
      auditId: '',
      patientId: text(s.patientId) || '',
      personId: text(s.personId),
      name: text(s.name),
      houseId: text(s.houseId),
      phone: text(s.phone),
      entryDate: toDay(s.date),
      dischargeDate: '',
      days: null,
      bucket: null,
      custom: null,
      status: 'active',
      continuity: CONTINUITY_DEFAULT,
      returning: !!text(s.personId),
      reason: '',
    }, extra || {});
  }

  /* All stays from the two lists (see THE UNIT IS A STAY). */
  function buildStays(patients, discharged) {
    const P = (Array.isArray(patients) ? patients : []).filter((p) => p && typeof p === 'object');
    const D = (Array.isArray(discharged) ? discharged : []).filter((d) => d && typeof d === 'object');
    const stays = [];
    const auditByKey = {};
    const auditByPatientId = {};
    const usedAudit = new Set();
    const seenAuditKey = new Set();

    D.filter(dischargeRowOpen).forEach((d) => {
      const key = stayKey(d);
      // A duplicate open row of one stay counts once (first wins).
      if (key && seenAuditKey.has(key)) return;
      if (key) seenAuditKey.add(key);
      if (key) auditByKey[key] = d;
      const pid = text(d.patientId);
      if (pid && !auditByPatientId[pid]) auditByPatientId[pid] = d;
    });

    P.forEach((p) => {
      const released = isReleased(p);
      const key = stayKey(p);
      if (!released) {
        stays.push(stayRow(p, { patientId: text(p.id), status: 'active' }));
        return;
      }
      const d = (text(p.id) && auditByPatientId[text(p.id)]) || (key && auditByKey[key]) || null;
      if (d) usedAudit.add(d);
      stays.push(stayRow(d ? Object.assign({}, p, { phone: text(d.phone) || text(p.phone) }) : p, {
        patientId: text(p.id),
        auditId: d ? text(d.id) : '',
        status: 'discharged',
        dischargeDate: (d && dischargeDayOf(d)) || toDay(p.exitDate),
        continuity: d ? normalizeContinuity(d.continuity) : CONTINUITY_DEFAULT,
      }));
    });

    // Open audit rows with no Patients row (e.g. the Patients row was removed).
    Object.keys(auditByKey).map((k) => auditByKey[k]).concat(
      Object.keys(auditByPatientId).map((k) => auditByPatientId[k]))
      .forEach((d) => {
        if (usedAudit.has(d)) return;
        usedAudit.add(d);
        stays.push(stayRow(d, {
          auditId: text(d.id),
          status: 'discharged',
          dischargeDate: dischargeDayOf(d),
          continuity: normalizeContinuity(d.continuity),
        }));
      });
    // Open audit rows with neither a stay key nor a patientId still exist as
    // discharges; place them too (they are their own stay).
    D.filter(dischargeRowOpen).forEach((d) => {
      if (stayKey(d) || text(d.patientId)) return;
      stays.push(stayRow(d, {
        auditId: text(d.id), status: 'discharged',
        dischargeDate: dischargeDayOf(d), continuity: normalizeContinuity(d.continuity),
      }));
    });
    return stays;
  }

  /* List order everywhere: entry date, then name (Hebrew collation). */
  const byEntry = (a, b) => (a.entryDate || '').localeCompare(b.entryDate || '') || a.name.localeCompare(b.name, 'he');

  function emptyByKeys(keys, make) {
    const o = {};
    keys.forEach((k) => { o[k] = make(); });
    return o;
  }

  /* computeRetention({ patients, discharged, from, to, customThreshold, today })
   *   patients    — state.patients (flat, with houseId / status / date / exitDate / personId)
   *   discharged  — state.dischargedPatients (the audit rows)
   *   from, to    — 'YYYY-MM-DD', inclusive, by ENTRY date
   *   customThreshold — N days for «לתקופה מסוימת» (optional)
   *   today       — 'YYYY-MM-DD' (optional; default Israel today)
   * → { ok, from, to, today, customThreshold, cohortSize, dischargedCount,
   *     counts: { upTo30, d31to60, over60 },
   *     stillInTreatment: { count, buckets: { upTo30, d31to60, over60 } },
   *     custom: null | { threshold, atOrBelow, above },
   *     continuity: { continued_outpatient, continued_other, none, unknown },
   *     cross: { upTo30: {continuity counts}, d31to60: {...}, over60: {...} },
   *     percents: { upTo30, d31to60, over60, stillInTreatment,
   *                 continuity: {...} }   (fractions, see PERCENTAGES)
   *     missingCount,
   *     rows: { upTo30, d31to60, over60, stillInTreatment,
   *             stillInTreatmentBuckets: {...}, custom: { atOrBelow, above },
   *             continuity: {...}, cross: { bucket: { continuity: [...] } },
   *             missing } }
   * Every count equals the length of the list behind it. A bad / reversed
   * range → { ok: false, error: 'bad_range' }. */
  function computeRetention(opts) {
    const o = opts || {};
    const from = text(o.from), to = text(o.to);
    if (!isRealIso(from) || !isRealIso(to) || from > to) return { ok: false, error: 'bad_range' };
    const today = isRealIso(text(o.today)) ? text(o.today) : todayIso();
    const threshold = normalizeThreshold(o.customThreshold);
    const bucketKeys = BUCKETS.map((b) => b.key);

    const rows = {
      upTo30: [], d31to60: [], over60: [], stillInTreatment: [],
      stillInTreatmentBuckets: emptyByKeys(bucketKeys, () => []),
      custom: { atOrBelow: [], above: [] },
      continuity: emptyByKeys(CONTINUITY_KEYS, () => []),
      cross: emptyByKeys(bucketKeys, () => emptyByKeys(CONTINUITY_KEYS, () => [])),
      missing: [],
    };

    buildStays(o.patients, o.discharged).forEach((s) => {
      if (!s.entryDate) { rows.missing.push(Object.assign(s, { reason: 'no_entry_date' })); return; }
      if (s.entryDate < from || s.entryDate > to) return;
      if (s.status === 'discharged') {
        if (!s.dischargeDate) { rows.missing.push(Object.assign(s, { reason: 'no_discharge_date' })); return; }
        const days = daysBetween(s.entryDate, s.dischargeDate);
        if (days === null || days < 0) { rows.missing.push(Object.assign(s, { reason: 'discharge_before_entry' })); return; }
        const b = bucketFor(days, threshold);
        Object.assign(s, { days, bucket: b.bucket, custom: b.custom });
        rows[b.bucket].push(s);
        rows.continuity[s.continuity].push(s);
        rows.cross[b.bucket][s.continuity].push(s);
        if (b.custom) rows.custom[b.custom].push(s);
        return;
      }
      const days = daysBetween(s.entryDate, today);
      if (days === null || days < 0) { rows.missing.push(Object.assign(s, { reason: 'entry_in_future' })); return; }
      const b = bucketFor(days, threshold);
      Object.assign(s, { days, bucket: b.bucket, custom: null });
      rows.stillInTreatment.push(s);
      rows.stillInTreatmentBuckets[b.bucket].push(s);
    });

    const sortAll = (x) => {
      if (Array.isArray(x)) { x.sort(byEntry); return; }
      Object.keys(x).forEach((k) => sortAll(x[k]));
    };
    sortAll(rows);

    const len = (a) => a.length;
    const counts = { upTo30: len(rows.upTo30), d31to60: len(rows.d31to60), over60: len(rows.over60) };
    const dischargedCount = counts.upTo30 + counts.d31to60 + counts.over60;
    const stillCount = len(rows.stillInTreatment);
    const cohortSize = dischargedCount + stillCount;
    const continuity = emptyByKeys(CONTINUITY_KEYS, () => 0);
    CONTINUITY_KEYS.forEach((k) => { continuity[k] = len(rows.continuity[k]); });
    const cross = emptyByKeys(bucketKeys, () => null);
    bucketKeys.forEach((b) => {
      cross[b] = {};
      CONTINUITY_KEYS.forEach((k) => { cross[b][k] = len(rows.cross[b][k]); });
    });
    const stillBuckets = {};
    bucketKeys.forEach((b) => { stillBuckets[b] = len(rows.stillInTreatmentBuckets[b]); });
    const percents = {
      upTo30: percentOf(counts.upTo30, cohortSize),
      d31to60: percentOf(counts.d31to60, cohortSize),
      over60: percentOf(counts.over60, cohortSize),
      stillInTreatment: percentOf(stillCount, cohortSize),
      continuity: {},
    };
    CONTINUITY_KEYS.forEach((k) => { percents.continuity[k] = percentOf(continuity[k], dischargedCount); });

    return {
      ok: true, from, to, today, customThreshold: threshold,
      cohortSize, dischargedCount, counts,
      stillInTreatment: { count: stillCount, buckets: stillBuckets },
      custom: threshold === null ? null : {
        threshold, atOrBelow: len(rows.custom.atOrBelow), above: len(rows.custom.above),
      },
      continuity, cross, percents,
      missingCount: len(rows.missing),
      rows,
    };
  }

  /* ===== «השלמת תקופת טיפול» — completion (CHANGELOG-completion-view.md) =====
   * Over the SAME cohort as computeRetention (entered in the period) and the
   * SAME stayDays (discharge day first, not inclusive; an active stay counts
   * to `today`), per threshold N days:
   *   reached   = discharged with days >= N, or still active with days >= N
   *   leftEarly = discharged with days < N
   *   tooEarly  = still active with days < N — NOT in the rate
   *   evaluable = reached + leftEarly
   *   rate      = reached / evaluable (fraction), null when evaluable is 0
   *               (shown «אין מספיק נתונים», never 0% or NaN).
   * Stays that cannot be placed go to `rows.missing` exactly as in
   * computeRetention (same reasons, same rows). */
  const COMPLETION_TITLE = 'השלמת תקופת טיפול';
  const COMPLETION_SHEET_LABEL = 'השלמת טיפול';
  const COMPLETION_DEFAULT_THRESHOLDS = Object.freeze([30, 60]);
  const COMPLETION_KEYS = Object.freeze(['reached', 'leftEarly', 'tooEarly']);
  const COMPLETION_LABELS = Object.freeze({
    reached: 'הגיעו לסף',
    leftEarly: 'עזבו לפני הסף',
    tooEarly: 'מוקדם לקבוע',
  });
  const COMPLETION_NOTE = 'מטופלים שטרם הגיעו לסף אינם נספרים באחוז';
  const NOT_ENOUGH_DATA_LABEL = 'אין מספיק נתונים';

  /* thresholds → whole numbers in [1, 3650], invalid ones dropped, duplicates
   * once, order kept. Not an array → the default [30, 60]. */
  function normalizeThresholds(list) {
    const src = Array.isArray(list) ? list : COMPLETION_DEFAULT_THRESHOLDS;
    const out = [];
    src.forEach((v) => {
      const n = normalizeThreshold(v);
      if (n !== null && out.indexOf(n) < 0) out.push(n);
    });
    return out;
  }

  /* computeCompletion({ patients, discharged, from, to, thresholds, today })
   * → { ok, from, to, today, thresholds, cohortSize, dischargedCount,
   *     stillInTreatmentCount, missingCount,
   *     results: [{ threshold, counts: { reached, leftEarly, tooEarly },
   *                 evaluable, rate, rows: { reached, leftEarly, tooEarly } }],
   *     rows: { missing } }
   * Every count is the length of the list behind it. A bad / reversed range
   * → { ok: false, error: 'bad_range' }. */
  function computeCompletion(opts) {
    const o = opts || {};
    const base = computeRetention({ patients: o.patients, discharged: o.discharged, from: o.from, to: o.to, today: o.today });
    if (!base.ok) return base;
    const thresholds = normalizeThresholds(o.thresholds);
    const dischargedRows = [].concat(base.rows.upTo30, base.rows.d31to60, base.rows.over60).sort(byEntry);
    const activeRows = base.rows.stillInTreatment;
    const results = thresholds.map((n) => {
      const rows = {
        reached: dischargedRows.filter((s) => s.days >= n).concat(activeRows.filter((s) => s.days >= n)).sort(byEntry),
        leftEarly: dischargedRows.filter((s) => s.days < n),
        tooEarly: activeRows.filter((s) => s.days < n),
      };
      const counts = { reached: rows.reached.length, leftEarly: rows.leftEarly.length, tooEarly: rows.tooEarly.length };
      const evaluable = counts.reached + counts.leftEarly;
      return { threshold: n, counts, evaluable, rate: percentOf(counts.reached, evaluable), rows };
    });
    return {
      ok: true, from: base.from, to: base.to, today: base.today, thresholds,
      cohortSize: base.cohortSize, dischargedCount: base.dischargedCount,
      stillInTreatmentCount: base.stillInTreatment.count,
      missingCount: base.missingCount,
      results,
      rows: { missing: base.rows.missing },
    };
  }

  /* The result for threshold N, or null. */
  function completionResult(report, threshold) {
    if (!report || !report.ok || !Array.isArray(report.results)) return null;
    const n = normalizeThreshold(threshold);
    return n === null ? null : (report.results.find((x) => x.threshold === n) || null);
  }

  /* A completion rate → '42.9%', or «אין מספיק נתונים» when it is null. */
  function formatRate(rate) {
    return rate === null || rate === undefined || !isFinite(rate) ? NOT_ENOUGH_DATA_LABEL : formatPercent(rate);
  }

  /* { kind: 'completion', threshold, key } → its rows (the SAME arrays the
   * counts came from); [] when unknown. */
  function completionListFor(report, sel) {
    const x = sel || {};
    if (x.kind !== 'completion' || COMPLETION_KEYS.indexOf(x.key) < 0) return [];
    const r = completionResult(report, x.threshold);
    return r ? r.rows[x.key] : [];
  }

  /* The numbers table — ONE source for the CSV and the Excel sheet. */
  const COMPLETION_HEAD = Object.freeze(['סף (ימים)', 'הגיעו לסף', 'עזבו לפני הסף', 'מוקדם לקבוע', 'ניתנים להערכה', 'אחוז השלמה']);
  function completionTable(report) {
    if (!report || !report.ok) return [];
    return report.results.map((r) => ({
      threshold: r.threshold, reached: r.counts.reached, leftEarly: r.counts.leftEarly,
      tooEarly: r.counts.tooEarly, evaluable: r.evaluable, rate: r.rate,
    }));
  }
  /* Every row behind every number, threshold by threshold, key by key. */
  function completionListRows(report) {
    const out = [];
    if (!report || !report.ok) return out;
    report.results.forEach((r) => COMPLETION_KEYS.forEach((k) => r.rows[k].forEach((row) => out.push({ threshold: r.threshold, key: k, row }))));
    return out;
  }

    /* ===== The list behind a number (CHANGELOG-patient-retention-ui.md) =====
   * A selection names one number on the screen:
   *   { kind: 'bucket', key }            a length card (upTo30 / d31to60 / over60)
   *   { kind: 'still' }                  «עדיין בטיפול»
   *   { kind: 'stillBucket', key }       its days-so-far breakdown
   *   { kind: 'custom', key }            atOrBelow / above
   *   { kind: 'continuity', key }        a continuity card
   *   { kind: 'cross', bucket, key }     a cross-table cell
   *   { kind: 'missing' }                «נתונים חסרים»
   *   { kind: 'completion', threshold, key }  a completion count (reached /
   *                                      leftEarly / tooEarly) — its rows come
   *                                      from completionListFor, not listFor
   * listFor(report, sel) → the rows (the SAME array objects the counts were
   * taken from — never a recount); [] for an unknown selection.
   * listTitle(sel, report) → the Hebrew heading. Both pure. */
  const BUCKET_LABEL = {};
  BUCKETS.forEach((b) => { BUCKET_LABEL[b.key] = b.label; });
  const CUSTOM_KEYS = ['atOrBelow', 'above'];

  function validSelection(sel) {
    const x = sel || {};
    if (x.kind === 'bucket' || x.kind === 'stillBucket') return !!BUCKET_LABEL[x.key];
    if (x.kind === 'continuity') return CONTINUITY_KEYS.indexOf(x.key) >= 0;
    if (x.kind === 'cross') return !!BUCKET_LABEL[x.bucket] && CONTINUITY_KEYS.indexOf(x.key) >= 0;
    if (x.kind === 'custom') return CUSTOM_KEYS.indexOf(x.key) >= 0;
    if (x.kind === 'completion') return COMPLETION_KEYS.indexOf(x.key) >= 0 && normalizeThreshold(x.threshold) !== null;
    return x.kind === 'still' || x.kind === 'missing';
  }

  function listFor(report, sel) {
    if (!report || !report.ok || !validSelection(sel)) return [];
    const r = report.rows;
    switch (sel.kind) {
      case 'bucket': return r[sel.key];
      case 'still': return r.stillInTreatment;
      case 'stillBucket': return r.stillInTreatmentBuckets[sel.key];
      case 'custom': return report.custom ? r.custom[sel.key] : [];
      case 'continuity': return r.continuity[sel.key];
      case 'cross': return r.cross[sel.bucket][sel.key];
      case 'missing': return r.missing;
      default: return [];
    }
  }

  function customLabel(key, threshold) {
    return key === 'atOrBelow' ? 'עד ' + threshold + ' ימים' : 'מעל ' + threshold + ' ימים';
  }

  function listTitle(sel, report) {
    if (!validSelection(sel)) return '';
    switch (sel.kind) {
      case 'bucket': return 'שוחררו · ' + BUCKET_LABEL[sel.key];
      case 'still': return STILL_IN_TREATMENT_LABEL;
      case 'stillBucket': return STILL_IN_TREATMENT_LABEL + ' · ' + BUCKET_LABEL[sel.key];
      case 'custom': return 'שוחררו · ' + customLabel(sel.key, report && report.custom ? report.custom.threshold : '');
      case 'continuity': return 'המשך טיפול · ' + CONTINUITY_LABELS[sel.key];
      case 'cross': return BUCKET_LABEL[sel.bucket] + ' · ' + CONTINUITY_LABELS[sel.key];
      case 'missing': return MISSING_LABEL;
      case 'completion': return COMPLETION_SHEET_LABEL + ' · ' + normalizeThreshold(sel.threshold) + ' ימים · ' + COMPLETION_LABELS[sel.key];
      default: return '';
    }
  }

  /* The «קטגוריית שהות» text of a row. */
  function stayCategory(row) {
    if (!row) return '';
    if (row.reason) return MISSING_LABEL;
    const b = BUCKET_LABEL[row.bucket] || '';
    return row.status === 'active' ? STILL_IN_TREATMENT_LABEL + (b ? ' · ' + b : '') : b;
  }

  /* ===== CSV — the leads-funnel pattern (lib/leads-funnel.js toCsv) =====
   * Quoted cells, quotes doubled, a leading = + - @ tab or CR neutralized
   * with an apostrophe (CSV injection), a UTF-8 BOM, CRLF line ends.
   * csvCell is the SAME rule as LeadsFunnel.csvCell (a test pins them). */
  function csvCell(v) {
    let str = String(v == null ? '' : v);
    if (/^[=+\-@\t\r]/.test(str)) str = "'" + str;
    return '"' + str.replace(/"/g, '""') + '"';
  }
  const CSV_HEAD = Object.freeze(['קטגוריית שהות', 'שם', 'בית', 'טלפון', 'תאריך כניסה', 'תאריך שחרור', 'ימים', 'המשך טיפול', 'מטופל חוזר', 'הערה']);
  /* One row → its display cells (the CSV and the Excel list use them).
   * opts.houseName(houseId) → the house label (default: the id). */
  function rowCells(row, opts) {
    const o = opts || {};
    const house = typeof o.houseName === 'function' ? (o.houseName(row.houseId) || row.houseId) : row.houseId;
    return [
      stayCategory(row), row.name, house, row.phone, row.entryDate, row.dischargeDate,
      row.days === null || row.days === undefined ? '' : row.days,
      row.status === 'discharged' ? CONTINUITY_LABELS[row.continuity] || CONTINUITY_LABELS.unknown : '',
      row.returning ? 'כן' : '',
      row.reason ? (MISSING_REASONS[row.reason] || row.reason) : '',
    ];
  }
  function toCsv(list, opts) {
    const lines = [CSV_HEAD.map(csvCell).join(',')];
    (Array.isArray(list) ? list : []).forEach((r) => { lines.push(rowCells(r, opts).map(csvCell).join(',')); });
    return '\ufeff' + lines.join('\r\n') + '\r\n';
  }
  const CSV_MIME = 'text/csv;charset=utf-8';
  /* חתכי-מטופלים-<from>-<to>-<kind>[-<key>].csv — ASCII-safe parts only. */
  function csvFilename(from, to, sel) {
    const safe = (v) => String(v == null ? '' : v).replace(/[^0-9A-Za-z-]/g, '');
    const x = sel || {};
    const tail = [x.kind, x.bucket, x.key].filter(Boolean).map(safe).join('-');
    return 'חתכי-מטופלים-' + safe(from) + '-' + safe(to) + (tail ? '-' + tail : '') + '.csv';
  }

  /* «השלמת טיפול» as one CSV section: the numbers table (the same numbers as
   * the screen — a null rate is «אין מספיק נתונים»), the note, then every row
   * behind every number and the «נתונים חסרים» rows. Same cell rule as toCsv. */
  function completionToCsv(report, opts) {
    const line = (cells) => cells.map(csvCell).join(',');
    const lines = [line([COMPLETION_SHEET_LABEL])];
    lines.push(line(COMPLETION_HEAD));
    completionTable(report).forEach((t) => lines.push(line([t.threshold, t.reached, t.leftEarly, t.tooEarly, t.evaluable, formatRate(t.rate)])));
    lines.push(line([COMPLETION_NOTE]));
    lines.push('');
    lines.push(line(['סף (ימים)', 'סטטוס השלמה'].concat(CSV_HEAD)));
    completionListRows(report).forEach((x) => lines.push(line([x.threshold, COMPLETION_LABELS[x.key]].concat(rowCells(x.row, opts)))));
    if (report && report.ok) report.rows.missing.forEach((m) => lines.push(line(['', MISSING_LABEL].concat(rowCells(m, opts)))));
    return '\ufeff' + lines.join('\r\n') + '\r\n';
  }
  function completionCsvFilename(from, to) {
    const safe = (v) => String(v == null ? '' : v).replace(/[^0-9A-Za-z-]/g, '');
    return 'השלמת-טיפול-' + safe(from) + '-' + safe(to) + '.csv';
  }

  return Object.freeze({
    CONTINUITY_LABELS, CONTINUITY_KEYS, CONTINUITY_CHOICES, CONTINUITY_DEFAULT,
    BUCKETS, STILL_IN_TREATMENT_LABEL, MISSING_LABEL, MISSING_REASONS, COHORT_RULE_LABEL,
    THRESHOLD_MIN, THRESHOLD_MAX,
    isRealIso, toDay, daysBetween, stayDays, bucketFor, normalizeThreshold, normalizeContinuity,
    stayKey, percentOf, formatPercent, computeRetention,
    validSelection, listFor, listTitle, customLabel, stayCategory,
    CSV_HEAD, CSV_MIME, csvCell, rowCells, toCsv, csvFilename,
    COMPLETION_TITLE, COMPLETION_SHEET_LABEL, COMPLETION_DEFAULT_THRESHOLDS, COMPLETION_KEYS, COMPLETION_LABELS,
    COMPLETION_NOTE, NOT_ENOUGH_DATA_LABEL, COMPLETION_HEAD,
    normalizeThresholds, computeCompletion, completionResult, formatRate, completionListFor,
    completionTable, completionListRows, completionToCsv, completionCsvFilename,
  });
}));
