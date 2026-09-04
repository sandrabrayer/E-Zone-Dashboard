#!/usr/bin/env node
/* Weekly healthcheck against the LIVE E-ZONE Dashboard.
 *
 * Run by .github/workflows/weekly-healthcheck.yml every Saturday evening
 * (Israel time) and on manual dispatch. Exit code 1 (→ workflow failure →
 * email to Sandra) ONLY on real breakage (CRITICAL checks); data-quality
 * issues are reported as WARNINGS and never fail the run.
 *
 * The script replicates exactly what the frontend does (public/app.js):
 *   1. GET  /                          → the HTML shell (index.html)
 *   2. POST /api/verify-pin {pin}      → 200 + Set-Cookie: ezone_session=…
 *      (server.js app.post('/api/verify-pin') — mints the signed HttpOnly
 *      session cookie)
 *   3. GET  /api/sheets?action=getData → riding that cookie, same as
 *      app.js loadAll() → apiGet({action:'getData'})
 *
 * No dependencies beyond Node built-ins (global fetch, Node 20+).
 *
 * SECURITY: APP_PIN and the session-cookie value are NEVER printed or written
 * to any report. Patient NAMES never appear in CI output — ids only.
 */
'use strict';

const fs = require('node:fs');

const DEFAULT_APP_URL = 'https://ezone-dashboard.up.railway.app';

/* How long to wait for any single HTTP request before calling it broken. */
const REQUEST_TIMEOUT_MS = 45000;

/* Stable marker from public/index.html — present in every served shell
 * (<title>E-ZONE Dashboard</title>); BUILD_ID substitution never touches it. */
const HTML_MARKER = 'E-ZONE Dashboard';

const SESSION_COOKIE = 'ezone_session'; // server.js SESSION_COOKIE

/* Top-level keys of the getData response — duplicated from the return object
 * of getData_() in apps-script/Code.gs. Keep in sync with that function. */
const EXPECTED_TOP_KEYS = [
  'ok',
  'leads',
  'patients',
  'irrelevantLeads',
  'removedLeads',
  'dischargedPatients',
  'billingOverrides',
  'houseManagers',
  'managerPhones',
];

/* Duplicated from LEAD_COLUMNS in apps-script/Code.gs (append-only there —
 * keep in sync). A live lead missing one of these keys means the deployed
 * Apps Script pre-dates a merged column append: a stale deployment. */
const LEAD_COLUMNS = [
  'id', 'name', 'phone', 'house', 'source', 'note',
  'stage', 'visitDate', 'visitTime', 'entryDate', 'advance', 'created',
  'assignedTo', 'meetingWith', 'meetingOutcome',
  'contactName', 'contactPhone', 'contactRelation', 'billingPhone',
  'waitlistedAt',
  'meetingReportOutcome', 'meetingCompanion', 'meetingNote',
  'meetingReporter', 'meetingReportedAt', 'meetingSeen',
];

/* Duplicated from PATIENT_COLUMNS in apps-script/Code.gs (keep in sync).
 * `id` (last) is the persisted patient id from the patient identity
 * foundation: getData_ backfills it on the first read after the column lands,
 * so a blank one on a live row is a data-quality warning (see warnBlankIds). */
const PATIENT_COLUMNS = [
  'houseId', 'name', 'date', 'pay', 'adv',
  'status', 'fromLead', 'exitDate', 'source', 'notes',
  'id', 'updatedAt', 'updatedBy',
];

/* Anchored plain-date shape. A non-empty date field that fails this leaked
 * through a Sheets Date-coercion (the visitDate/visitTime corruption class). */
const PLAIN_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/* ===== Config ===== */

/* Throws when APP_PIN is unset. The error message explains the fix and never
 * contains any secret value (there is nothing to echo — that's the point). */
function resolveConfig(env) {
  const e = env || {};
  const appUrl = String(e.APP_URL || DEFAULT_APP_URL).replace(/\/+$/, '');
  const pin = e.APP_PIN == null ? '' : String(e.APP_PIN);
  if (!pin) {
    throw new Error(
      'APP_PIN is not set. Add it as a GitHub Actions repository secret named APP_PIN ' +
      '(repo Settings → Secrets and variables → Actions → New repository secret) — ' +
      'the same PIN the dashboard login screen accepts. Its value is never printed.'
    );
  }
  return { appUrl, pin };
}

/* ===== CRITICAL checks (pure — injectable for tests) ===== */

/* a. The HTML shell: HTTP 200 + the known index.html marker. */
function checkHtmlShell(status, body) {
  const criticals = [];
  if (status !== 200) {
    criticals.push(`App shell: GET / returned HTTP ${status} (expected 200).`);
    return criticals;
  }
  const text = String(body == null ? '' : body);
  if (text.indexOf(HTML_MARKER) === -1) {
    criticals.push(
      `App shell: GET / returned 200 but the response does not contain the ` +
      `"${HTML_MARKER}" marker from index.html — the app is not serving its shell.`
    );
  }
  return criticals;
}

/* b. Pull the session cookie pair ("ezone_session=<token>") out of the login
 * response's Set-Cookie values. Returns '' when absent. The returned value is
 * only ever placed on a Cookie header — never logged. */
function extractSessionCookie(setCookieValues) {
  const list = Array.isArray(setCookieValues) ? setCookieValues : [setCookieValues];
  const prefix = SESSION_COOKIE + '=';
  for (const raw of list) {
    if (typeof raw !== 'string') continue;
    const first = raw.split(';')[0].trim();
    if (first.indexOf(prefix) === 0 && first.length > prefix.length) return first;
  }
  return '';
}

/* c. The getData response body: must be HTTP 200, must NOT be an HTML page
 * (a Google Apps Script error/permission page starts with '<'), must parse as
 * JSON, and must carry ok:true. Returns { criticals, data }. */
function checkDataBody(status, bodyText) {
  const criticals = [];
  const text = String(bodyText == null ? '' : bodyText);
  if (status !== 200) {
    criticals.push(`Data: GET /api/sheets?action=getData returned HTTP ${status} (expected 200). Body starts: ${text.slice(0, 200)}`);
    return { criticals, data: null };
  }
  if (text.trim().charAt(0) === '<') {
    criticals.push(
      'Data: the getData response is an HTML page, not JSON — this is the Google ' +
      'Apps Script HTML error page signature (deployment access flipped off "Anyone", ' +
      'a broken deployment, or a Google-side error).'
    );
    return { criticals, data: null };
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch (_) {
    criticals.push(`Data: the getData response is not parseable JSON. Body starts: ${text.slice(0, 200)}`);
    return { criticals, data: null };
  }
  if (!data || typeof data !== 'object' || data.ok !== true) {
    criticals.push(`Data: getData returned JSON but not ok:true (got ok=${JSON.stringify(data && data.ok)}${data && data.error ? ', error=' + JSON.stringify(data.error) : ''}).`);
    return { criticals, data: null };
  }
  return { criticals, data };
}

/* d. Every expected top-level key must be present. */
function checkTopLevelKeys(data) {
  const criticals = [];
  const missing = EXPECTED_TOP_KEYS.filter((k) => !(k in Object(data)));
  if (missing.length) {
    criticals.push(`Data shape: getData is missing top-level key(s): ${missing.join(', ')} — stale Apps Script deployment?`);
  }
  return criticals;
}

/* Flatten the patients-by-house object into rows tagged with their house +
 * position, for sampling and per-row warnings. */
function flattenPatients(patients) {
  const rows = [];
  if (patients && typeof patients === 'object' && !Array.isArray(patients)) {
    for (const [houseId, arr] of Object.entries(patients)) {
      if (!Array.isArray(arr)) continue;
      arr.forEach((p, i) => rows.push({ houseId, index: i, row: p }));
    }
  }
  return rows;
}

/* e. Column/field presence — catches a stale Apps Script deployment that
 * pre-dates newly merged column appends. Empty arrays are skipped with a
 * note, never failed. Returns { criticals, notes }. */
function checkColumnPresence(data) {
  const criticals = [];
  const notes = [];

  const leads = Array.isArray(data && data.leads) ? data.leads : [];
  if (leads.length === 0) {
    notes.push('Leads array is empty — column-presence check skipped (not a failure).');
  } else {
    const sample = Object(leads[0]);
    const missing = LEAD_COLUMNS.filter((c) => !(c in sample));
    if (missing.length) {
      criticals.push(
        `Lead columns: a sampled lead is missing field(s): ${missing.join(', ')} — ` +
        'the deployed Apps Script pre-dates these LEAD_COLUMNS appends (stale deployment).'
      );
    }
  }

  const patientRows = flattenPatients(data && data.patients);
  if (patientRows.length === 0) {
    notes.push('No patient rows — patient column-presence check skipped (not a failure).');
  } else {
    const sample = Object(patientRows[0].row);
    const missing = PATIENT_COLUMNS.filter((c) => !(c in sample));
    if (missing.length) {
      criticals.push(
        `Patient columns: a sampled patient is missing field(s): ${missing.join(', ')} — ` +
        'the deployed Apps Script pre-dates these PATIENT_COLUMNS appends (stale deployment).'
      );
    }
  }

  return { criticals, notes };
}

/* ===== WARNING checks (never fail the run) ===== */

/* A row counts as restored exactly the way the frontend decides it
 * (public/app.js renderDischargedPatients): restored === 'TRUE' or true. */
function isRestored(row) {
  return !!row && (row.restored === 'TRUE' || row.restored === true);
}

function isBlank(v) {
  return v == null || String(v).trim() === '';
}

/* Blank/missing persisted ids on leads, dischargedPatients and — since the
 * patient identity foundation — active patients (getData_ backfills them, so
 * a blank one means the deployed Apps Script pre-dates the column or a writer
 * bypassed the merge). Offenders are reported by 0-based position (patients:
 * houseId + position) — the id itself is blank, so position is the only
 * handle; never by name. */
function warnBlankIds(data) {
  const warnings = [];
  const blankPatients = [];
  flattenPatients(data && data.patients).forEach(({ houseId, index, row }) => {
    if (isBlank(row && row.id)) blankPatients.push(`house ${houseId} position ${index}`);
  });
  if (blankPatients.length) {
    warnings.push(`Blank patient id: ${blankPatients.length} patient row(s) with blank/missing id, at ${blankPatients.join(', ')}.`);
  }
  const leads = Array.isArray(data && data.leads) ? data.leads : [];
  const blankLeads = [];
  leads.forEach((l, i) => { if (isBlank(l && l.id)) blankLeads.push(i); });
  if (blankLeads.length) {
    warnings.push(`Blank lead id: ${blankLeads.length} lead row(s) with blank/missing id, at position(s) ${blankLeads.join(', ')}.`);
  }
  const discharged = Array.isArray(data && data.dischargedPatients) ? data.dischargedPatients : [];
  const blankDischarged = [];
  discharged.forEach((d, i) => { if (isBlank(d && d.id)) blankDischarged.push(i); });
  if (blankDischarged.length) {
    warnings.push(`Blank discharged-audit id: ${blankDischarged.length} audit row(s) with blank/missing id, at position(s) ${blankDischarged.join(', ')}.`);
  }
  return warnings;
}

/* True when a non-empty value fails the anchored YYYY-MM-DD shape. For
 * `created`, only the date-part (before any 'T') is validated. */
function isMalformedPlainDate(v) {
  if (isBlank(v)) return false;
  return !PLAIN_DATE_RE.test(String(v).trim());
}

function isMalformedDatePart(v) {
  if (isBlank(v)) return false;
  return !PLAIN_DATE_RE.test(String(v).trim().split('T')[0]);
}

/* Date fields that leaked through a Sheets Date-coercion. Offenders are
 * identified by id (leads/audit rows) or houseId+position (patients) — never
 * by name. */
function warnMalformedDates(data) {
  const warnings = [];
  const offenders = []; // { where, field, ref }

  const leads = Array.isArray(data && data.leads) ? data.leads : [];
  leads.forEach((l, i) => {
    const ref = isBlank(l && l.id) ? `position ${i}` : `id ${String(l.id)}`;
    for (const f of ['entryDate', 'visitDate']) {
      if (isMalformedPlainDate(l && l[f])) offenders.push({ where: 'lead', field: f, ref });
    }
    if (isMalformedDatePart(l && l.created)) offenders.push({ where: 'lead', field: 'created', ref });
  });

  flattenPatients(data && data.patients).forEach(({ houseId, index, row }) => {
    for (const f of ['date', 'exitDate']) {
      if (isMalformedPlainDate(row && row[f])) {
        offenders.push({ where: 'patient', field: f, ref: `house ${houseId} position ${index}` });
      }
    }
  });

  const discharged = Array.isArray(data && data.dischargedPatients) ? data.dischargedPatients : [];
  discharged.forEach((d, i) => {
    const ref = isBlank(d && d.id) ? `position ${i}` : `id ${String(d.id)}`;
    for (const f of ['date', 'exitDate']) {
      if (isMalformedPlainDate(d && d[f])) offenders.push({ where: 'discharged-audit', field: f, ref });
    }
  });

  if (offenders.length) {
    const details = offenders.map((o) => `${o.where}.${o.field} (${o.ref})`).join('; ');
    warnings.push(`Malformed date values: ${offenders.length} non-empty date field(s) not matching YYYY-MM-DD (Sheets Date-coercion leak?): ${details}.`);
  }
  return warnings;
}

/* Duplicate NON-restored discharged-patient audit rows: grouped by fromLead
 * and by houseId::name; any group with >1 non-restored row is flagged. Groups
 * are reported by audit-row ids (and houseId) only — the name half of the
 * houseId::name key is NEVER printed. */
function warnDuplicateDischargeAudit(dischargedPatients) {
  const warnings = [];
  const rows = Array.isArray(dischargedPatients) ? dischargedPatients : [];
  const active = rows.filter((d) => d && !isRestored(d));

  const refOf = (d, i) => (isBlank(d.id) ? `position ${i}` : String(d.id));

  const byFromLead = new Map();
  const byHouseName = new Map();
  active.forEach((d) => {
    const i = rows.indexOf(d);
    if (!isBlank(d.fromLead)) {
      const k = String(d.fromLead);
      if (!byFromLead.has(k)) byFromLead.set(k, []);
      byFromLead.get(k).push(refOf(d, i));
    }
    if (!isBlank(d.houseId) && !isBlank(d.name)) {
      const k = `${String(d.houseId)}::${String(d.name)}`;
      if (!byHouseName.has(k)) byHouseName.set(k, { houseId: String(d.houseId), refs: [] });
      byHouseName.get(k).refs.push(refOf(d, i));
    }
  });

  const dupFromLead = [...byFromLead.entries()].filter(([, refs]) => refs.length > 1);
  if (dupFromLead.length) {
    const details = dupFromLead.map(([k, refs]) => `fromLead ${k} → audit ids [${refs.join(', ')}]`).join('; ');
    warnings.push(`Duplicate non-restored discharge-audit rows by fromLead: ${dupFromLead.length} group(s): ${details}.`);
  }
  const dupHouseName = [...byHouseName.values()].filter((g) => g.refs.length > 1);
  if (dupHouseName.length) {
    const details = dupHouseName.map((g) => `house ${g.houseId} → audit ids [${g.refs.join(', ')}]`).join('; ');
    warnings.push(`Duplicate non-restored discharge-audit rows by houseId+name: ${dupHouseName.length} group(s): ${details}.`);
  }
  return warnings;
}

function collectWarnings(data) {
  return [
    ...warnBlankIds(data),
    ...warnMalformedDates(data),
    ...warnDuplicateDischargeAudit(data && data.dischargedPatients),
  ];
}

/* ===== Reporting ===== */

function buildReport(criticals, warnings, notes) {
  const lines = [];
  lines.push('# Weekly healthcheck — E-ZONE Dashboard');
  lines.push('');
  lines.push(criticals.length
    ? `## ❌ CRITICAL — ${criticals.length} failure(s)`
    : '## ✅ All critical checks passed');
  for (const c of criticals) lines.push(`- ${c}`);
  lines.push('');
  lines.push(warnings.length
    ? `## ⚠️ Warnings — ${warnings.length} (do not fail the run)`
    : '## Warnings: none');
  for (const w of warnings) lines.push(`- ${w}`);
  if (notes.length) {
    lines.push('');
    lines.push('## Notes');
    for (const n of notes) lines.push(`- ${n}`);
  }
  lines.push('');
  return lines.join('\n');
}

/* ===== Runner ===== */

async function timedFetch(fetchFn, url, options) {
  return fetchFn(url, Object.assign({ signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }, options || {}));
}

/* Orchestrates the live checks. env and fetchFn are injectable so tests never
 * touch the network. Returns the process exit code (0 ok / 1 critical). */
async function run(env, fetchFn) {
  const e = env || process.env;
  const f = fetchFn || fetch;
  const criticals = [];
  const warnings = [];
  const notes = [];

  let config;
  try {
    config = resolveConfig(e);
  } catch (err) {
    console.error(err.message);
    return 1;
  }

  // a. HTML shell
  try {
    const res = await timedFetch(f, config.appUrl + '/');
    criticals.push(...checkHtmlShell(res.status, await res.text()));
  } catch (err) {
    criticals.push(`App shell: GET / failed: ${err.message}`);
  }

  // b. Login → session cookie
  let cookie = '';
  try {
    const res = await timedFetch(f, config.appUrl + '/api/verify-pin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: config.pin }),
    });
    if (res.status !== 200) {
      criticals.push(`Login: POST /api/verify-pin returned HTTP ${res.status} (expected 200) — wrong APP_PIN secret, rate-limited, or the server rejects the PIN.`);
    } else {
      const setCookies = typeof res.headers.getSetCookie === 'function'
        ? res.headers.getSetCookie()
        : [res.headers.get('set-cookie') || ''];
      cookie = extractSessionCookie(setCookies);
      if (!cookie) {
        criticals.push('Login: PIN accepted (HTTP 200) but no ezone_session cookie was issued — SESSION_SECRET likely unset on the server (fail-closed state).');
      }
    }
  } catch (err) {
    criticals.push(`Login: POST /api/verify-pin failed: ${err.message}`);
  }

  // c/d/e. Authenticated getData — only reachable with a session cookie.
  if (cookie) {
    try {
      const res = await timedFetch(f, config.appUrl + '/api/sheets?action=getData', {
        headers: { cookie },
      });
      const { criticals: dataCriticals, data } = checkDataBody(res.status, await res.text());
      criticals.push(...dataCriticals);
      if (data) {
        criticals.push(...checkTopLevelKeys(data));
        const cols = checkColumnPresence(data);
        criticals.push(...cols.criticals);
        notes.push(...cols.notes);
        warnings.push(...collectWarnings(data));
      }
    } catch (err) {
      criticals.push(`Data: GET /api/sheets?action=getData failed: ${err.message}`);
    }
  } else {
    notes.push('Data checks skipped — no session cookie (see the login failure above).');
  }

  const report = buildReport(criticals, warnings, notes);
  console.log(report);
  if (e.GITHUB_STEP_SUMMARY) {
    try {
      fs.appendFileSync(e.GITHUB_STEP_SUMMARY, report + '\n');
    } catch (err) {
      console.error('Could not append to GITHUB_STEP_SUMMARY:', err.message);
    }
  }

  return criticals.length ? 1 : 0;
}

/* Same pattern as server.js: only run when executed directly, so tests can
 * require the module and call the checks with injected fixtures. */
if (require.main === module) {
  run().then(
    (code) => process.exit(code),
    (err) => {
      console.error('healthcheck crashed:', err.message);
      process.exit(1);
    }
  );
}

module.exports = {
  DEFAULT_APP_URL,
  HTML_MARKER,
  SESSION_COOKIE,
  EXPECTED_TOP_KEYS,
  LEAD_COLUMNS,
  PATIENT_COLUMNS,
  resolveConfig,
  checkHtmlShell,
  extractSessionCookie,
  checkDataBody,
  checkTopLevelKeys,
  flattenPatients,
  checkColumnPresence,
  isRestored,
  warnBlankIds,
  warnMalformedDates,
  warnDuplicateDischargeAudit,
  collectWarnings,
  buildReport,
  run,
};
