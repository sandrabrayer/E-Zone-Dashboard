/* FIN-01.3: date-only work age, never an action/permission gate.
 * Israel major holidays and their eves, including observed Independence Day.
 * See CHANGELOG-billing-workdays.md for the policy and validated date range. */
(function (root) {
'use strict';
const DAY = 86400000;
const FIRST_YEAR = 2020, LAST_YEAR = 2035;
const OWNERS = { vered: 3, ortal: 4 }; // Last regular weekday; Sunday = 0.
const CLOSED = { Elul: [29], Tishri: [1, 2, 9, 10, 14, 15, 21, 22],
  Nisan: [14, 15, 20, 21], Sivan: [5, 6] };
const MONTHS = ['Tishri', 'Heshvan', 'Kislev', 'Tevet', 'Shevat', 'Adar',
  'Adar I', 'Adar II', 'Nisan', 'Iyar', 'Sivan', 'Tamuz', 'Av', 'Elul'];
let formatter;
try {
  formatter = new Intl.DateTimeFormat('en-US-u-ca-hebrew', {
    timeZone: 'UTC', year: 'numeric', month: 'long', day: 'numeric',
  });
  if (formatter.resolvedOptions().calendar !== 'hebrew') formatter = null;
} catch (_) { formatter = null; }
const years = new Map(); // Bounded date counts only; never patient data.

function parseDay(iso) {
  if (typeof iso !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const year = Number(iso.slice(0, 4));
  if (year < FIRST_YEAR || year > LAST_YEAR) return null;
  const date = new Date(iso + 'T00:00:00Z');
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== iso) return null;
  return { year, n: date.getTime() / DAY };
}

function closed(date) {
  const parts = formatter.formatToParts(date);
  const month = parts.find(p => p.type === 'month').value;
  const day = Number(parts.find(p => p.type === 'day').value);
  if (!MONTHS.includes(month) || !Number.isInteger(day) || day < 1 || day > 30) throw new Error('Unsupported calendar');
  if ((CLOSED[month] || []).includes(day)) return true;
  if (month !== 'Iyar') return false;
  const fifthWeekday = (date.getUTCDay() + 5 - day + 35) % 7;
  const observed = fifthWeekday === 5 ? 4 : fifthWeekday === 6 ? 3 : fifthWeekday === 1 ? 6 : 5;
  return day === observed || day === observed - 1;
}

function yearCounts(year) {
  if (years.has(year)) return years.get(year);
  let result = null;
  if (formatter) {
    try {
      const start = Date.UTC(year, 0, 1) / DAY, end = Date.UTC(year + 1, 0, 1) / DAY;
      result = { start, end, vered: [0], ortal: [0] };
      for (let n = start; n < end; n++) {
        const date = new Date(n * DAY), holiday = closed(date), weekday = date.getUTCDay();
        for (const owner of Object.keys(OWNERS)) {
          const counts = result[owner];
          counts.push(counts[counts.length - 1] + (!holiday && weekday <= OWNERS[owner] ? 1 : 0));
        }
      }
    } catch (_) { result = null; } // Never silently count holidays as workdays.
  }
  years.set(year, result);
  return result;
}

function isBusinessDay(iso, owner) {
  const day = parseDay(iso);
  if (!day || !Object.prototype.hasOwnProperty.call(OWNERS, owner)) return null;
  const year = yearCounts(day.year);
  if (!year) return null;
  const i = day.n - year.start;
  return year[owner][i + 1] > year[owner][i];
}

/* (opened, asOf]: original day excluded; current regular day included.
 * Inputs must already be Israel civil dates, not timestamps. */
function businessDaysBetween(opened, asOf, owner) {
  const a = parseDay(opened), b = parseDay(asOf);
  if (!a || !b || !Object.prototype.hasOwnProperty.call(OWNERS, owner) || !formatter) return null;
  if (a.n >= b.n) return 0;
  let count = 0;
  for (let y = a.year; y <= b.year; y++) {
    const year = yearCounts(y);
    if (!year) return null;
    const from = Math.max(a.n + 1, year.start) - year.start;
    const to = Math.min(b.n + 1, year.end) - year.start;
    count += year[owner][to] - year[owner][from];
  }
  return count;
}

const API = { isBusinessDay, businessDaysBetween };
if (typeof module !== 'undefined' && module.exports) module.exports = API;
else root.BillingWorkCalendar = API;
})(typeof globalThis !== 'undefined' ? globalThis : this);
