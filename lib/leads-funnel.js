/* «חתכים בלידים» — the leads funnel report (CHANGELOG-leads-funnel-report.md).
 *
 * PURE: no DOM, no I/O, no logging. The page loads it before app.js
 * (window.LeadsFunnel); node --test requires it. It reads only what the
 * existing getData payload already carries (Leads, the closed-leads sheet,
 * Patients, the discharged audit) — no Code.gs change.
 *
 * THE PERIOD: a lead is in the period when its CREATION date (`created`,
 * 'YYYY-MM-DD') is between `from` and `to`, both INCLUSIVE. A lead with no
 * creation date cannot be placed in any period: it is counted apart
 * (`noCreated`) and never in a bucket.
 *
 * THE POPULATION: every lead on the board (incl. stage 'admitted') and every
 * closed lead (לידים לא רלוונטיים), first copy of an id wins. Soft-removed
 * leads (הסרה) are out, and so are `source: 'direct_admin'` rows — those are
 * the phone records of patients admitted directly, never real leads.
 *
 * THE THREE BUCKETS — mutually exclusive, checked in this order:
 *   1. entered  «נכנסו לבית»: the lead became a patient — some Patients row or
 *      discharged-audit row has fromLead === lead.id (any status, released
 *      too), or the lead's stage is 'admitted' / 'entered' / 'entry'.
 *   2. notRelevant «לא רלוונטי»: a closed lead whose disposition
 *      (computeDisposition — passed in as opts.disposition) is 'not_relevant'.
 *   3. visitedNotEntered «הגיעו לפגישה ולא נכנסו»: not 1 and not 2, and the
 *      lead had a meeting: a visitDate, OR a stage at or past «ביקור נקבע»
 *      (visit / waitlist / paid), OR a manager meeting report
 *      (meetingReportedAt). Closed leads with another disposition
 *      (completed / stopped_early) that had a meeting land here.
 * A lead in none of the three (e.g. a new lead with no meeting yet) is in the
 * population count only. */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.LeadsFunnel = api;
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
  const ENTERED_STAGES = ['admitted', 'entered', 'entry'];
  const VISITED_STAGES = ['visit', 'waitlist', 'paid'];
  const DIRECT_ADMIN_SOURCE = 'direct_admin';
  const BUCKETS = Object.freeze([
    { key: 'notRelevant', label: 'לא רלוונטי' },
    { key: 'visitedNotEntered', label: 'הגיעו לפגישה ולא נכנסו' },
    { key: 'entered', label: 'נכנסו לבית' },
  ]);
  const PRESETS = Object.freeze([
    { key: 'this_month', label: 'החודש' },
    { key: 'last_month', label: 'החודש הקודם' },
    { key: 'last_3_months', label: '3 חודשים אחרונים' },
  ]);

  const text = (v) => String(v == null ? '' : v).trim();

  function isRealIso(s) {
    if (!ISO_RE.test(String(s || ''))) return false;
    const d = new Date(s + 'T00:00:00Z');
    return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }
  /* 'YYYY-MM-DD' from a plain date or a full ISO timestamp (its first 10
   * chars); '' otherwise. */
  function day(v) {
    const s = text(v).slice(0, 10);
    return isRealIso(s) ? s : '';
  }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function lastDayOfMonth(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }   // m 1-based

  /* A preset → { from, to } around `todayIso` (calendar months):
   *   this_month     the 1st of this month → today
   *   last_month     the whole previous calendar month
   *   last_3_months  the 1st of the month two months back → today
   *                  (this month + the two before it)
   * null for an unknown preset or a bad today. */
  function presetRange(preset, todayIso) {
    if (!isRealIso(todayIso)) return null;
    const y = Number(todayIso.slice(0, 4));
    const m = Number(todayIso.slice(5, 7));
    const back = (k) => { let mm = m - k, yy = y; while (mm < 1) { mm += 12; yy--; } return { y: yy, m: mm }; };
    if (preset === 'this_month') return { from: y + '-' + pad(m) + '-01', to: todayIso };
    if (preset === 'last_month') {
      const p = back(1);
      return { from: p.y + '-' + pad(p.m) + '-01', to: p.y + '-' + pad(p.m) + '-' + pad(lastDayOfMonth(p.y, p.m)) };
    }
    if (preset === 'last_3_months') { const p = back(2); return { from: p.y + '-' + pad(p.m) + '-01', to: todayIso }; }
    return null;
  }

  function leadRow(l, bucket) {
    return {
      id: text(l.id), name: text(l.name), phone: text(l.phone), created: day(l.created),
      house: text(l.house), source: text(l.source), stage: text(l.stage),
      visitDate: day(l.visitDate), bucket: bucket,
    };
  }

  /* The report. opts:
   *   leads, irrelevantLeads, patients, dischargedPatients — the state lists
   *   from, to       'YYYY-MM-DD', inclusive (by creation date)
   *   disposition    fn(lead) → 'not_relevant' | 'completed' | 'stopped_early'
   *                  (app.js passes computeDisposition); default: lead.disposition
   * → { ok, from, to, population, noCreated, counts: {notRelevant, visitedNotEntered, entered},
   *     rows: {notRelevant: [...], visitedNotEntered: [...], entered: [...]} }
   * A bad / reversed range → { ok: false, error: 'bad_range' }. */
  function funnel(opts) {
    const o = opts || {};
    const from = text(o.from), to = text(o.to);
    if (!isRealIso(from) || !isRealIso(to) || from > to) return { ok: false, error: 'bad_range' };
    const disp = typeof o.disposition === 'function' ? o.disposition : (l) => text(l && l.disposition);
    const patientLeadIds = new Set();
    [].concat(Array.isArray(o.patients) ? o.patients : [], Array.isArray(o.dischargedPatients) ? o.dischargedPatients : [])
      .forEach((p) => { const id = text(p && p.fromLead); if (id) patientLeadIds.add(id); });

    const seen = new Set();
    const pool = [];
    const add = (l, closed) => {
      if (!l || typeof l !== 'object') return;
      const id = text(l.id);
      if (id && seen.has(id)) return;
      if (id) seen.add(id);
      if (text(l.source) === DIRECT_ADMIN_SOURCE) return;
      pool.push({ lead: l, closed: closed });
    };
    (Array.isArray(o.leads) ? o.leads : []).forEach((l) => add(l, false));
    (Array.isArray(o.irrelevantLeads) ? o.irrelevantLeads : []).forEach((l) => add(l, true));

    const rows = { notRelevant: [], visitedNotEntered: [], entered: [] };
    let population = 0, noCreated = 0;
    pool.forEach(({ lead, closed }) => {
      const created = day(lead.created);
      if (!created) { noCreated++; return; }
      if (created < from || created > to) return;
      population++;
      const stage = text(lead.stage);
      if (patientLeadIds.has(text(lead.id)) || ENTERED_STAGES.indexOf(stage) >= 0) {
        rows.entered.push(leadRow(lead, 'entered'));
      } else if (closed && disp(lead) === 'not_relevant') {
        rows.notRelevant.push(leadRow(lead, 'notRelevant'));
      } else if (day(lead.visitDate) || VISITED_STAGES.indexOf(stage) >= 0 || text(lead.meetingReportedAt)) {
        rows.visitedNotEntered.push(leadRow(lead, 'visitedNotEntered'));
      }
    });
    const byCreated = (a, b) => a.created.localeCompare(b.created) || a.name.localeCompare(b.name, 'he');
    Object.keys(rows).forEach((k) => rows[k].sort(byCreated));
    return {
      ok: true, from: from, to: to, population: population, noCreated: noCreated,
      counts: { notRelevant: rows.notRelevant.length, visitedNotEntered: rows.visitedNotEntered.length, entered: rows.entered.length },
      rows: rows,
    };
  }

  /* One CSV cell: quoted, quotes doubled, and a leading = + - @ (or tab / CR)
   * neutralized with an apostrophe so a spreadsheet never runs it as a
   * formula (CSV injection). */
  function csvCell(v) {
    let s = String(v == null ? '' : v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return '"' + s.replace(/"/g, '""') + '"';
  }
  const CSV_HEAD = ['קטגוריה', 'שם', 'טלפון', 'נוצר', 'בית', 'מקור', 'תאריך ביקור'];
  /* rows (the report's row objects) → CSV text with a UTF-8 BOM (Excel opens
   * the Hebrew correctly) and CRLF line ends. */
  function toCsv(list) {
    const label = {};
    BUCKETS.forEach((b) => { label[b.key] = b.label; });
    const lines = [CSV_HEAD.map(csvCell).join(',')];
    (Array.isArray(list) ? list : []).forEach((r) => {
      lines.push([label[r.bucket] || '', r.name, r.phone, r.created, r.house, r.source, r.visitDate].map(csvCell).join(','));
    });
    return '﻿' + lines.join('\r\n') + '\r\n';
  }

  const CSV_MIME = 'text/csv;charset=utf-8';
  /* The download name: חתכים-בלידים-<from>-<to>-<bucket>.csv (bucket key only). */
  function csvFilename(from, to, bucket) {
    const safe = (v) => String(v == null ? '' : v).replace(/[^0-9A-Za-z-]/g, '');
    return 'חתכים-בלידים-' + safe(from) + '-' + safe(to) + '-' + safe(bucket) + '.csv';
  }

  return Object.freeze({ BUCKETS, PRESETS, CSV_MIME, presetRange, funnel, toCsv, csvCell, csvFilename, isRealIso });
}));
