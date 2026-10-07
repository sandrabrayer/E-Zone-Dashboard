/* The institutional-funder grace period (Sandra, 07/10/2026).
 * CHANGELOG-funder-grace.md, docs/billing-control-plan.md §7.5.
 *
 * ONE definition, two runtimes, like lib/refund-rules.js: the page loads it
 * at /funder-grace.js (window.FunderGrace); apps-script/Code.gs holds the same
 * rule as isWithinFunderGrace_ (Apps Script cannot require a file). The parity
 * test test/funder-grace.test.js runs both over a grid and fails on any
 * difference. No data, no I/O, no clock (the caller passes today).
 *
 * The rule: a cycle whose funder (on its due date — the Funders sheet with
 * history, as everywhere) is ביטוח לאומי, מכבי or משרד הביטחון is NOT a
 * collection problem until FUNDER_GRACE_DAYS after its due date: while
 * today − due ≤ 30 days it reads «ממתין לגורם מממן» (neutral), from day 31
 * the normal red / overdue marking applies. Private: unchanged. Pro-bono:
 * unchanged (owes nothing — excluded elsewhere). Unset / unknown: unchanged.
 * The AMOUNT always stays outstanding — only the problem marking waits. */
(function (root) {
'use strict';

const FUNDER_GRACE_DAYS = 30;
/* Funder keys (public/funder.js) and the Funders-sheet labels (Code.gs
 * PAYMENT_FUNDERS) that get the grace period. */
const FUNDER_GRACE_KEYS = ['btl', 'maccabi', 'mod'];
const FUNDER_GRACE_SHEET_LABELS = { 'ביטוח לאומי': 'btl', 'מכבי': 'maccabi', 'משרד הביטחון': 'mod' };
const FUNDER_GRACE_LABEL = 'ממתין לגורם מממן';
const FUNDER_GRACE_COLUMN_LABEL = 'בתוך תקופת גורם מממן';

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

/* A bare 'YYYY-MM-DD' naming a real day → epoch-day number, else null. */
function dayNum(s) {
  if (typeof s !== 'string' || !ISO_RE.test(s)) return null;
  const t = Date.UTC(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10)));
  const n = Math.round(t / 86400000);
  return new Date(n * 86400000).toISOString().slice(0, 10) === s ? n : null;
}

/* A funder key ('btl') or sheet label ('ביטוח לאומי') → its grace key, or ''
 * when that funder gets no grace (private, pro-bono, unset, anything else).
 * Exact strings, like Funder.keyFromLabel. */
function graceFunderKey(funder) {
  if (typeof funder !== 'string') return '';
  if (FUNDER_GRACE_KEYS.indexOf(funder) >= 0) return funder;
  return Object.prototype.hasOwnProperty.call(FUNDER_GRACE_SHEET_LABELS, funder) ? FUNDER_GRACE_SHEET_LABELS[funder] : '';
}

/* The cycle's due date: a bare ISO string, or { dueDate } / { start }. */
function cycleDue(cycle) {
  if (typeof cycle === 'string') return cycle;
  if (cycle && typeof cycle === 'object') return String(cycle.dueDate || cycle.start || '');
  return '';
}

/* True while the cycle is inside its funder's grace window:
 * funder ∈ ביטוח לאומי / מכבי / משרד הביטחון and today − due ≤ 30 days.
 * A cycle not yet due (today < due) is inside too. Any unreadable date →
 * false: the normal marking applies, never a silent pass. */
function isWithinFunderGrace(cycle, funder, todayIso) {
  if (!graceFunderKey(funder)) return false;
  const due = dayNum(cycleDue(cycle)), today = dayNum(todayIso);
  if (due === null || today === null) return false;
  return today - due <= FUNDER_GRACE_DAYS;
}

/* The last day of the grace window (due + 30), or '' for a bad date. */
function funderGraceUntil(cycle) {
  const due = dayNum(cycleDue(cycle));
  return due === null ? '' : new Date((due + FUNDER_GRACE_DAYS) * 86400000).toISOString().slice(0, 10);
}

const API = {
  FUNDER_GRACE_DAYS,
  FUNDER_GRACE_KEYS,
  FUNDER_GRACE_SHEET_LABELS,
  FUNDER_GRACE_LABEL,
  FUNDER_GRACE_COLUMN_LABEL,
  graceFunderKey,
  isWithinFunderGrace,
  funderGraceUntil,
};

if (typeof module === 'object' && module && module.exports) module.exports = API;
else root.FunderGrace = API;
})(typeof globalThis !== 'undefined' ? globalThis : this);
