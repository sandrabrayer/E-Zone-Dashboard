'use strict';

/* The 7-day dual-accept window for the shared APP_PIN (plan §11.5 decision 5,
 * personal PINs PR B). No deps.
 *
 * APP_PIN_UNTIL (Railway) = 'YYYY-MM-DD', the LAST day (inclusive) the shared
 * APP_PIN is still accepted, counted in Israel time (Asia/Jerusalem):
 *
 *   unset / blank        → closed ('unset')   — APP_PIN is refused
 *   not a real date      → closed ('invalid') — APP_PIN is refused
 *   before today         → closed ('past')    — APP_PIN is refused
 *   more than MAX_DAYS   → closed ('too_far') — a typo such as 2027 must not
 *     after today            keep the shared PIN alive for a year
 *   today … today+MAX    → open
 *
 * FAIL-CLOSED: every branch that is not a clean, near, future-or-today date
 * closes the window. The state is re-evaluated on every request (a server
 * that keeps running past midnight closes the window on time). Pure: `now` is
 * injectable. */

const TZ = 'Asia/Jerusalem';
const MAX_DAYS_AHEAD = 14;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/* 'YYYY-MM-DD' of `now` in Israel time. */
function israelDay(now) {
  const d = now instanceof Date ? now : new Date(now === undefined ? Date.now() : now);
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

/* Day number (UTC midnight epoch days) for a valid 'YYYY-MM-DD', else NaN.
 * Rejects calendar overflow (2026-02-30) by round-tripping. */
function dayNumber(iso) {
  const m = DATE_RE.exec(String(iso));
  if (!m) return NaN;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const back = new Date(t).toISOString().slice(0, 10);
  return back === iso ? Math.round(t / 86400000) : NaN;
}

/* { open, until, reason, today } — until is the validated date or ''. */
function sharedPinWindow(raw, now) {
  const today = israelDay(now);
  const v = raw === undefined || raw === null ? '' : String(raw).trim();
  if (!v) return { open: false, until: '', reason: 'unset', today };
  const u = dayNumber(v);
  if (!Number.isFinite(u)) return { open: false, until: '', reason: 'invalid', today };
  const t = dayNumber(today);
  if (u < t) return { open: false, until: v, reason: 'past', today };
  if (u - t > MAX_DAYS_AHEAD) return { open: false, until: v, reason: 'too_far', today };
  return { open: true, until: v, reason: 'open', today };
}

/* 'DD/MM/YYYY' for the banner, '' for anything but a valid date. */
function untilDisplay(iso) {
  if (!Number.isFinite(dayNumber(iso))) return '';
  const [y, m, d] = iso.split('-');
  return d + '/' + m + '/' + y;
}

/* One startup log line. Names the state and the date only. */
function windowLogLine(w) {
  if (w.open) return `[config] APP_PIN dual-accept window: OPEN until ${w.until} (inclusive, ${TZ}) — the shared PIN is accepted as staff only.`;
  const why = {
    unset: 'APP_PIN_UNTIL is not set',
    invalid: 'APP_PIN_UNTIL is not a valid YYYY-MM-DD date',
    past: `APP_PIN_UNTIL (${w.until}) has passed`,
    too_far: `APP_PIN_UNTIL (${w.until}) is more than ${MAX_DAYS_AHEAD} days ahead`,
  }[w.reason] || 'closed';
  return `[config] APP_PIN dual-accept window: CLOSED (${why}) — the shared APP_PIN is refused; personal PINs only.`;
}

module.exports = { sharedPinWindow, israelDay, untilDisplay, windowLogLine, MAX_DAYS_AHEAD, TZ };
