const express = require('express');
const path = require('path');
const fs = require('fs');
const https = require('https');
const { URL } = require('url');
const { checkPin } = require('./lib/pin');
const { createSessionToken, verifySessionToken } = require('./lib/session');

const app = express();
app.disable('etag');
app.disable('x-powered-by');
const PORT = process.env.PORT || 3000;

/* Always emit headers that defeat browser caches, CDNs (Cloudflare,
 * Fastly), and shared proxies for every response the app serves. */
function noCache(res) {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0, private');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  res.set('Surrogate-Control', 'no-store');
  res.set('CDN-Cache-Control', 'no-store');
  res.set('Cloudflare-CDN-Cache-Control', 'no-store');
  res.set('Vary', '*');
}

/* Apps Script /exec endpoint. Pulled from Railway env — the old value was
 * hardcoded here and is now burned in git history, so a NEW Apps Script
 * deployment URL must be issued and set as SHEETS_URL. If it is unset every
 * /api/sheets call fails-closed (sheetsGet/sheetsPost hit an empty URL) rather
 * than silently talking to a stale/leaked deployment — that is intended. */
const SHEETS_URL = process.env.SHEETS_URL || '';
if (!SHEETS_URL) {
  console.error('[config] SHEETS_URL is not set — all /api/sheets calls will fail until it is configured.');
}

/* Outpatient cross-app lead write (PR 3). The /exec URL and the shared secret
 * come from Railway env so the secret never reaches the browser and is never
 * committed. Both must be set for the endpoint to do anything (fail-closed,
 * mirroring the getAdmittedRoster secret discipline on the Apps Script side). */
const OUTPATIENT_LEAD_URL    = process.env.OUTPATIENT_LEAD_URL    || '';
const OUTPATIENT_LEAD_SECRET = process.env.OUTPATIENT_LEAD_SECRET || '';

/* Edit-mode PIN. Verified server-side by POST /api/verify-pin so the value
 * never reaches the browser (the old PIN was hardcoded in public/app.js and is
 * now burned in git history — issue a NEW one). Unset means no PIN can match
 * (checkPin fails closed on the empty string), so edit mode is unreachable
 * until it is configured. */
const APP_PIN = process.env.APP_PIN || '';
if (!APP_PIN) {
  console.warn('[config] APP_PIN is not set — edit-mode PIN verification will reject every attempt until it is configured.');
}

/* Session-cookie signing secret. A correct PIN mints an HttpOnly session cookie
 * signed with this; every data route (/api/sheets, /api/outpatient-lead, the
 * data-bearing /api/debug/* endpoints) requires a valid cookie. FAIL-CLOSED: if
 * SESSION_SECRET is unset the server still boots and serves the static app +
 * /api/verify-pin, but the guarded routes return 503 (never open access) so a
 * misconfiguration can never silently expose the data. */
const SESSION_SECRET = process.env.SESSION_SECRET || '';
if (!SESSION_SECRET) {
  console.error('[config] SESSION_SECRET is not set — /api/sheets and the data-bearing /api/debug/* routes will return 503 until it is configured (fail-closed).');
}

const SESSION_COOKIE = 'ezone_session';
const SESSION_MAX_AGE = 7 * 24 * 60 * 60; // 604800 seconds (7 days), matches the token TTL

/* ===== Meeting-report micro-app config =====
 *
 * House managers report meeting outcomes on a standalone mobile page
 * (/meeting-report) gated by its OWN PIN — deliberately NOT the main-app PIN,
 * so a manager holding the reporting PIN gains zero access to the dashboard.
 * Its session cookie is signed with the same SESSION_SECRET but in the
 * 'meeting-report' token scope (see lib/session.js), so neither cookie can
 * ever unlock the other's routes. Fail-closed: with MEETING_REPORT_PIN unset
 * the page and its API return 503, never open access. */
const MEETING_REPORT_PIN = process.env.MEETING_REPORT_PIN || '';
if (!MEETING_REPORT_PIN) {
  console.warn('[config] MEETING_REPORT_PIN is not set — /meeting-report will return 503 until it is configured (fail-closed).');
}

/* Shared secret injected into every meeting-report Apps Script call (body-only,
 * mirroring the OUTPATIENT_LEAD_SECRET contract so it never lands in a URL or
 * log line, and never reaches the browser). The Apps Script side requires the
 * same value from Script Properties. Fail-closed: unset → the API routes 503. */
const MEETING_REPORT_SECRET = process.env.MEETING_REPORT_SECRET || '';
if (!MEETING_REPORT_SECRET) {
  console.warn('[config] MEETING_REPORT_SECRET is not set — the /api/meeting-report routes will return 503 until it is configured (fail-closed).');
}

const MR_SESSION_COOKIE = 'mr_session';
const MR_SESSION_SCOPE = 'meeting-report';

const BUILD_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

app.use(express.json({ limit: '10mb' }));

/* Apply no-cache headers to every response before any handler runs. */
app.use((_req, res, next) => { noCache(res); next(); });

/* Catch-all request logger — confirms what URLs the server actually receives,
 * visible in the Railway logs. Registered before any route so every request is
 * logged. (The in-memory hit counters + the /api/debug/routes and /api/debug/env
 * endpoints that exposed them were removed with the API-auth change: they leaked
 * infra metadata unauthenticated and had no consumer.) */
app.use((req, _res, next) => {
  console.log(`[req] ${req.method} ${req.originalUrl} host=${req.headers.host} xfwd=${req.headers['x-forwarded-host'] || '-'}`);
  next();
});

/* Serve index.html with BUILD_ID substituted so the script tag is unique
 * per deploy and cannot be cached between deploys. Read from disk on every
 * request so a hot-redeploy picks up edits immediately. */
function sendIndex(_req, res) {
  const html = fs.readFileSync(path.join(__dirname, 'public/index.html'), 'utf8')
    .replace(/__BUILD__/g, BUILD_ID);
  console.log(`[req] → serving /index.html (build ${BUILD_ID}, ${html.length} chars)`);
  noCache(res);
  res.type('html').send(html);
}
app.get('/', sendIndex);
app.get('/index.html', sendIndex);

/* Serve app.js and style.css by hand so we control the headers. Each file
 * is tagged with BUILD_ID in its URL via the HTML, but we ALSO no-cache
 * the response itself so even an unversioned request doesn't get cached. */
function sendStatic(relPath, mime) {
  return (_req, res) => {
    const full = path.join(__dirname, 'public', relPath);
    try {
      const content = fs.readFileSync(full);
      noCache(res);
      res.type(mime).send(content);
    } catch (err) {
      res.status(404).send('not found: ' + relPath);
    }
  };
}
app.get('/app.js', sendStatic('app.js', 'application/javascript'));
app.get('/style.css', sendStatic('style.css', 'text/css'));

/* PWA assets. Without these explicit routes they hit the 404 fallback, because
 * serving is hand-rolled (no express.static). The no-cache headers set above
 * are correct here too: sw.js in particular must NOT be HTTP-cached so a new
 * deploy's worker is always fetched; the worker does its own client-side
 * caching. Icons are tiny and versioned by filename. */
app.get('/manifest.json', sendStatic('manifest.json', 'application/manifest+json'));
app.get('/sw.js', sendStatic('sw.js', 'application/javascript'));
app.get('/icons/icon-192.png', sendStatic('icons/icon-192.png', 'image/png'));
app.get('/icons/icon-512.png', sendStatic('icons/icon-512.png', 'image/png'));
app.get('/icons/icon-maskable-512.png', sendStatic('icons/icon-maskable-512.png', 'image/png'));

/* GET the Apps Script with querystring params. Follows Google's 302 → googleusercontent.com. */
function sheetsGet(params) {
  return new Promise((resolve, reject) => {
    const url = new URL(SHEETS_URL);
    Object.entries(params || {}).forEach(([k, v]) => {
      if (v === undefined || v === null) return;
      const str = typeof v === 'object' ? JSON.stringify(v) : String(v);
      url.searchParams.append(k, str);
    });
    followingRequest({ method: 'GET' }, url.toString(), null, resolve, reject, 0);
  });
}

/* POST a JSON body to the Apps Script. Follows the 302 as GET (standard
 * Apps Script behavior — the redirect target serves the precomputed doPost
 * response). */
function sheetsPost(body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body || {});
    const opts = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'Accept': 'application/json',
      },
    };
    followingRequest(opts, SHEETS_URL, payload, resolve, reject, 0);
  });
}

/* POST a JSON body to the Outpatient app's createLead endpoint. The action is
 * a query param; the secret travels in the BODY (per the agreed contract) so it
 * never lands in a URL/log line. Follows the Apps Script 302 like sheetsPost. */
function outpatientPost(body) {
  return new Promise((resolve, reject) => {
    const sep = OUTPATIENT_LEAD_URL.indexOf('?') === -1 ? '?' : '&';
    const target = OUTPATIENT_LEAD_URL + sep + 'action=createLead';
    const payload = JSON.stringify(body || {});
    const opts = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'Accept': 'application/json',
      },
    };
    followingRequest(opts, target, payload, resolve, reject, 0);
  });
}

function followingRequest(opts, targetUrl, payload, resolve, reject, redirects) {
  if (redirects > 5) return reject(new Error('Too many redirects'));
  const req = https.request(targetUrl, opts, (res) => {
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      res.resume();
      return followingRequest({ method: 'GET' }, res.headers.location, null, resolve, reject, redirects + 1);
    }
    /* utf8 BEFORE reading: without it each chunk Buffer is decoded on its own
     * by the `data += c` implicit toString, and a multibyte character split
     * across a chunk boundary (every 2-byte Hebrew letter is a candidate)
     * decodes as two U+FFFD replacement chars. setEncoding routes the stream
     * through a StringDecoder, which buffers partial sequences across chunks. */
    res.setEncoding('utf8');
    let data = '';
    res.on('data', (c) => (data += c));
    res.on('end', () => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        return reject(new Error(`Apps Script HTTP ${res.statusCode}: ${data.slice(0, 400)}`));
      }
      try {
        resolve(JSON.parse(data));
      } catch (_) {
        reject(new Error('Apps Script returned non-JSON (first 400 chars): ' + data.slice(0, 400)));
      }
    });
  });
  req.on('error', reject);
  if (payload) req.write(payload);
  req.end();
}

/* Keep the most recent save AND load in memory so /api/debug/* can be hit
 * from a browser without digging through Railway logs. */
let lastSave = null;
let lastLoad = null;

/* ===== Write & handoff diagnostics =====
 *
 * The next time a "save didn't stick" / "handoff didn't happen" symptom shows
 * up, /api/debug/last-save should answer the question by itself — no live
 * DevTools repro needed. Everything here is in-memory (resets on redeploy,
 * like lastSave/lastLoad) and behind requireSession.
 *
 *  - writeLog: ring buffer of the last WRITE_LOG_MAX write attempts that PASSED
 *    auth (newest first): action, http status returned to the client, error if
 *    any, a truncated+redacted response preview, and — for saveAll — per-house
 *    patient counts SENT vs ACKNOWLEDGED by the backend (catches a silent
 *    serialize/houseId drop).
 *  - authFailures: counts every requireSession 401 with timestamps + paths. A
 *    write that dies at the auth gate never reaches a route handler, so it can
 *    never appear in writeLog — this counter is how the "session cookie
 *    rejected" hypothesis shows up without a live repro. */
const WRITE_LOG_MAX = 20;
const writeLog = [];
const authFailures = { total: 0, lastAt: null, byPath: {}, recent: [] };

/* Push a write record onto the ring buffer (newest first, capped). */
function recordWrite(entry) {
  writeLog.unshift(entry);
  if (writeLog.length > WRITE_LOG_MAX) writeLog.length = WRITE_LOG_MAX;
  return entry;
}

/* Count a requireSession 401. Timestamps are capped like the write log so the
 * store can't grow unbounded. */
function noteAuthFailure(path) {
  authFailures.total += 1;
  authFailures.lastAt = new Date().toISOString();
  const p = typeof path === 'string' && path ? path : '(unknown)';
  authFailures.byPath[p] = (authFailures.byPath[p] || 0) + 1;
  authFailures.recent.unshift({ at: authFailures.lastAt, path: p });
  if (authFailures.recent.length > WRITE_LOG_MAX) authFailures.recent.length = WRITE_LOG_MAX;
}

/* Replace every occurrence of each non-empty secret in `text` with [REDACTED].
 * Applied to every stored response preview so a far side that echoes a secret
 * back (or an error message that embeds one) can never park it in the debug
 * store. Pure — split/join, no regex, so secret characters can't be
 * misinterpreted as patterns. */
function redactSecrets(text, secrets) {
  let out = String(text == null ? '' : text);
  for (const s of secrets || []) {
    if (typeof s === 'string' && s.length > 0) out = out.split(s).join('[REDACTED]');
  }
  return out;
}

/* The secrets that must never appear in a stored debug record. */
function debugSecretList() {
  return [OUTPATIENT_LEAD_SECRET, SESSION_SECRET, MEETING_REPORT_SECRET];
}

/* Truncated, redacted preview of an upstream response for the write log. */
function responsePreview(data, max) {
  const cap = max || 2000;
  let str;
  if (typeof data === 'string') str = data;
  else {
    try { str = JSON.stringify(data); } catch (_) { str = String(data); }
  }
  return redactSecrets(String(str == null ? '' : str).slice(0, cap), debugSecretList());
}

/* Compare the per-house patient counts the client SENT (summarizeBody's
 * byHouse) with the counts the backend ACKNOWLEDGED writing (saveAll_'s
 * `written` — present once the matching Code.gs deploys). Pure:
 *   - acknowledged missing/invalid → { match: null } (older backend, no verdict)
 *   - otherwise match=true only when every house count agrees both ways;
 *     mismatches lists each disagreeing house as { sent, acknowledged }. */
function compareSaveAllCounts(sentByHouse, ackByHouse) {
  if (!ackByHouse || typeof ackByHouse !== 'object' || Array.isArray(ackByHouse)) {
    return { match: null, mismatches: null };
  }
  const sent = (sentByHouse && typeof sentByHouse === 'object') ? sentByHouse : {};
  const mismatches = {};
  const houses = new Set([...Object.keys(sent), ...Object.keys(ackByHouse)]);
  for (const hid of houses) {
    const s = Number(sent[hid] || 0);
    const a = Number(ackByHouse[hid] || 0);
    if (s !== a) mismatches[hid] = { sent: s, acknowledged: a };
  }
  const match = Object.keys(mismatches).length === 0;
  return { match, mismatches: match ? null : mismatches };
}

function summarizeBody(body) {
  const leadCount = Array.isArray(body && body.leads) ? body.leads.length : 0;
  const byHouse = {};
  let patientCount = 0;
  if (body && body.patients && typeof body.patients === 'object') {
    for (const [hid, arr] of Object.entries(body.patients)) {
      if (Array.isArray(arr)) {
        byHouse[hid] = arr.length;
        patientCount += arr.length;
      }
    }
  }
  return { action: body && body.action, leadCount, patientCount, byHouse };
}

function summarizeResponse(data) {
  if (!data || typeof data !== 'object') {
    return { topType: typeof data, value: String(data).slice(0, 200) };
  }
  const out = { topKeys: Object.keys(data) };
  out.leadsType = Array.isArray(data.leads) ? 'array' : typeof data.leads;
  out.leadCount = Array.isArray(data.leads) ? data.leads.length : null;

  const p = data.patients;
  out.patientsType = Array.isArray(p) ? 'array' : p === null ? 'null' : typeof p;
  if (Array.isArray(p)) {
    out.patientsLength = p.length;
    out.firstPatient = p[0] || null;
  } else if (p && typeof p === 'object') {
    out.patientsKeys = Object.keys(p);
    out.patientsByHouse = {};
    for (const k of out.patientsKeys) {
      const v = p[k];
      out.patientsByHouse[k] = Array.isArray(v) ? v.length : typeof v;
    }
  }
  return out;
}

/* Build the truncated patients/leads previews stored on `lastLoad` for the
 * /api/debug/last-load diagnostics endpoint. Pure + defensive: only responses
 * that actually carry a `patients` / `leads` field get a preview; anything
 * else (e.g. the getPayments response `{ok:true, payments:[...]}`, which has
 * neither) yields null. Guarding on `!== undefined` is the fix for the
 * getPayments 502: JSON.stringify(undefined) returns undefined, so calling
 * .slice() on it threw and bubbled up to the 502 handler. */
function buildLoadPreviews(data) {
  const isObj = data && typeof data === 'object';
  return {
    patientsPreview: isObj && data.patients !== undefined
      ? JSON.stringify(data.patients).slice(0, 4000)
      : null,
    leadsPreview: isObj && data.leads !== undefined
      ? JSON.stringify(data.leads).slice(0, 1500)
      : null,
  };
}

/* ===== Session auth =====
 *
 * A correct PIN (POST /api/verify-pin) mints a signed HttpOnly cookie; every
 * data route requires it. No cookie-parser dependency — the one cookie we read
 * is pulled from the raw header. */

/* Extract a named cookie's value from a Cookie header, or '' if absent. */
function parseCookieValue(cookieHeader, name) {
  if (typeof cookieHeader !== 'string' || !cookieHeader) return '';
  const parts = cookieHeader.split(';');
  const prefix = name + '=';
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i].trim();
    if (p.indexOf(prefix) === 0) return p.slice(prefix.length);
  }
  return '';
}

/* Extract the session token from a Cookie header, or '' if absent. */
function parseSessionCookie(cookieHeader) {
  return parseCookieValue(cookieHeader, SESSION_COOKIE);
}

/* Extract the meeting-report session token, or '' if absent. */
function parseMeetingReportCookie(cookieHeader) {
  return parseCookieValue(cookieHeader, MR_SESSION_COOKIE);
}

/* Pure auth decision, so every branch is unit-testable with an explicit secret:
 *   'not_configured' → SESSION_SECRET unset (fail-closed → 503)
 *   'ok'             → a valid, unexpired, correctly-signed cookie is present
 *   'unauthorized'   → missing / malformed / tampered / expired cookie (→ 401) */
function sessionAuthStatus(cookieHeader, secret) {
  if (typeof secret !== 'string' || secret.length === 0) return 'not_configured';
  const token = parseSessionCookie(cookieHeader);
  if (token && verifySessionToken(token, secret)) return 'ok';
  return 'unauthorized';
}

/* Express middleware guarding the data routes. Fail-closed: an unset
 * SESSION_SECRET yields 503 (never open). A missing/invalid cookie yields 401. */
function requireSession(req, res, next) {
  const status = sessionAuthStatus(req.headers.cookie, SESSION_SECRET);
  if (status === 'not_configured') {
    return res.status(503).json({
      ok: false,
      error: 'session_not_configured',
      message: 'SESSION_SECRET is not set — data routes are closed by design (fail-closed).',
    });
  }
  if (status === 'unauthorized') {
    // Count it: a request that dies here never reaches a route handler, so
    // this counter (surfaced on /api/debug/last-save) is the only trace a
    // rejected-cookie write leaves behind.
    noteAuthFailure(req.originalUrl || req.url || req.path);
    return res.status(401).json({ error: 'unauthorized' });
  }
  return next();
}

/* ===== Meeting-report session auth =====
 *
 * Same design as the main-app session above, but a SEPARATE cookie
 * (mr_session) whose token is signed in the 'meeting-report' scope. A valid
 * ezone_session value pasted into mr_session verifies against a different HMAC
 * message and fails — and vice versa — so holding one credential never grants
 * the other surface. */

/* Pure auth decision for the meeting-report session (mirrors sessionAuthStatus):
 *   'not_configured' → SESSION_SECRET unset (fail-closed → 503)
 *   'ok'             → a valid, unexpired, meeting-report-scoped cookie
 *   'unauthorized'   → missing / malformed / tampered / expired / wrong-scope */
function mrSessionAuthStatus(cookieHeader, secret) {
  if (typeof secret !== 'string' || secret.length === 0) return 'not_configured';
  const token = parseMeetingReportCookie(cookieHeader);
  if (token && verifySessionToken(token, secret, MR_SESSION_SCOPE)) return 'ok';
  return 'unauthorized';
}

/* Express middleware guarding the meeting-report API routes. Fail-closed on
 * BOTH the session secret and the reporting PIN: with either unset the whole
 * micro-app is closed (503), never open. A missing/invalid/wrong-scope cookie
 * — including a perfectly valid MAIN-APP cookie — yields 401. */
function requireMeetingReportSession(req, res, next) {
  if (!MEETING_REPORT_PIN) {
    return res.status(503).json({
      ok: false,
      error: 'meeting_report_not_configured',
      message: 'MEETING_REPORT_PIN is not set — the meeting-report routes are closed by design (fail-closed).',
    });
  }
  const status = mrSessionAuthStatus(req.headers.cookie, SESSION_SECRET);
  if (status === 'not_configured') {
    return res.status(503).json({
      ok: false,
      error: 'session_not_configured',
      message: 'SESSION_SECRET is not set — the meeting-report routes are closed by design (fail-closed).',
    });
  }
  if (status === 'unauthorized') {
    noteAuthFailure(req.originalUrl || req.url || req.path);
    return res.status(401).json({ error: 'unauthorized' });
  }
  return next();
}

/* Whether the ORIGINAL client request reached us over HTTPS. Railway terminates
 * TLS and forwards x-forwarded-proto=https; plain-HTTP localhost dev has neither,
 * so the Secure attribute is omitted there (a Secure cookie would never be sent
 * back over http and would break local dev). */
function requestIsHttps(req) {
  return req.headers['x-forwarded-proto'] === 'https' || req.secure === true;
}

/* Build the Set-Cookie value for a freshly-minted session token. */
function buildSessionCookie(token, isHttps) {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    'HttpOnly',
    'SameSite=Strict',
    'Path=/',
    `Max-Age=${SESSION_MAX_AGE}`,
  ];
  if (isHttps) parts.push('Secure');
  return parts.join('; ');
}

/* Build the Set-Cookie value for a meeting-report session token. Same
 * attributes as the main cookie (HttpOnly, Strict, 7 days); Path stays '/'
 * because the cookie must ride both /meeting-report and /api/meeting-report/*.
 * Sending it on main-app routes is harmless — the scope check rejects it there. */
function buildMeetingReportCookie(token, isHttps) {
  const parts = [
    `${MR_SESSION_COOKIE}=${token}`,
    'HttpOnly',
    'SameSite=Strict',
    'Path=/',
    `Max-Age=${SESSION_MAX_AGE}`,
  ];
  if (isHttps) parts.push('Secure');
  return parts.join('; ');
}

/* GET /api/sheets?action=getData — forwarded as GET to Apps Script */
app.get('/api/sheets', requireSession, async (req, res) => {
  const action = req.query && req.query.action;
  console.log('[sheets GET] → action=', JSON.stringify(action), 'fullQuery=', JSON.stringify(req.query));
  try {
    const data = await sheetsGet(req.query);

    const summary = summarizeResponse(data);
    console.log('[sheets GET] ← response summary:', summary);

    // Record the last load for ANY GET to /api/sheets so we can tell
    // whether the route is being hit even if the client sends a
    // different action name.
    lastLoad = {
      at: new Date().toISOString(),
      action: action === undefined ? null : action,
      query: req.query,
      summary,
      ...buildLoadPreviews(data),
    };

    res.json(data);
  } catch (err) {
    console.error('[sheets GET] error:', err.message);
    lastLoad = {
      at: new Date().toISOString(),
      action: action === undefined ? null : action,
      query: req.query,
      error: err.message,
    };
    res.status(502).json({ ok: false, error: 'sheets_unreachable', message: err.message });
  }
});


/* POST /api/sheets — body is forwarded as POST application/json to Apps Script.
 * All save operations (saveAll, etc.) use POST so the data never hits the
 * querystring length limit. */
app.post('/api/sheets', requireSession, async (req, res) => {
  const body = req.body || {};
  const summary = summarizeBody(body);
  console.log('[sheets POST] →', summary);
  try {
    const data = await sheetsPost(body);
    console.log('[sheets POST] ←', data && typeof data === 'object' ? data : String(data).slice(0, 300));
    lastSave = {
      at: new Date().toISOString(),
      request: { summary, keys: Object.keys(body) },
      response: data,
    };
    // saveAll only: compare per-house patient counts sent vs acknowledged by
    // the backend (`written` in the saveAll_ response — null verdict until the
    // matching Code.gs deploys). A false match pinpoints a silent
    // serialize/houseId drop without a live repro.
    const counts = summary.action === 'saveAll'
      ? compareSaveAllCounts(summary.byHouse, data && data.written)
      : null;
    recordWrite({
      at: lastSave.at,
      route: '/api/sheets',
      action: summary.action || null,
      auth: 'ok',
      httpStatus: 200,
      okFromBackend: !(data && data.ok === false),
      summary,
      acknowledged: (data && data.written) || null,
      countsMatch: counts ? counts.match : null,
      countMismatches: counts ? counts.mismatches : null,
      responsePreview: responsePreview(data, 1000),
    });
    res.json(data);
  } catch (err) {
    console.error('[sheets POST] error:', err.message);
    lastSave = {
      at: new Date().toISOString(),
      request: { summary, keys: Object.keys(body) },
      error: err.message,
    };
    recordWrite({
      at: lastSave.at,
      route: '/api/sheets',
      action: summary.action || null,
      auth: 'ok',
      httpStatus: 502,
      error: redactSecrets(err.message, debugSecretList()),
      summary,
    });
    res.status(502).json({ ok: false, error: 'sheets_unreachable', message: err.message });
  }
});

/* Diagnostics — last save and last load. These echo lead/patient previews, so
 * they are gated behind the session cookie like the data routes.
 *
 * last-save now also carries:
 *   writes       — ring buffer of the last WRITE_LOG_MAX auth-passed write
 *                  attempts (newest first): action, http status, saveAll
 *                  sent-vs-acknowledged counts, outpatient response body.
 *   authFailures — every requireSession 401 (total, per path, recent
 *                  timestamps) — the trace a rejected-cookie write leaves.
 * The legacy lastSave shape is preserved under `lastSave`. */
app.get('/api/debug/last-save', requireSession, (_req, res) => {
  res.json({
    lastSave: lastSave || { empty: true },
    writes: writeLog,
    authFailures,
  });
});
app.get('/api/debug/last-load', requireSession, (_req, res) => {
  res.json(lastLoad || { empty: true });
});

/* POST /api/outpatient-lead — browser sends { name, phone, house, note }; we
 * inject the shared secret from Railway env (never exposed to the client) and
 * forward to the Outpatient app's createLead endpoint. Fail-closed: if the URL
 * or secret isn't configured, refuse without calling out. The Dashboard treats
 * any non-2xx / { ok:false } here as a NON-FATAL warning — the discharge has
 * already succeeded locally. The secret is never logged. */
app.post('/api/outpatient-lead', requireSession, async (req, res) => {
  const startedAt = new Date().toISOString();
  if (!OUTPATIENT_LEAD_URL || !OUTPATIENT_LEAD_SECRET) {
    recordWrite({
      at: startedAt,
      route: '/api/outpatient-lead',
      action: 'createOutpatientLead',
      auth: 'ok',
      httpStatus: 503,
      error: 'outpatient_not_configured',
    });
    return res.status(503).json({ ok: false, error: 'outpatient_not_configured' });
  }
  const b = req.body || {};
  const body = {
    secret: OUTPATIENT_LEAD_SECRET,
    name:  b.name  == null ? '' : String(b.name),
    phone: b.phone == null ? '' : String(b.phone),
    house: b.house == null ? '' : String(b.house),
    note:  b.note  == null ? '' : String(b.note),
  };
  try {
    const data = await outpatientPost(body);
    // Log only the outcome — never the secret or the full forwarded body.
    console.log('[outpatient-lead] ←', data && typeof data === 'object'
      ? { ok: data.ok, id: data.id, error: data.error }
      : String(data).slice(0, 120));
    // Record the FULL far-side response (truncated + redacted). A {ok:false}
    // from the Outpatient Apps Script used to be invisible; after this, one
    // discharge test shows exactly what Outpatient said (unauthorized vs
    // validation error vs unexpected shape).
    recordWrite({
      at: startedAt,
      route: '/api/outpatient-lead',
      action: 'createOutpatientLead',
      auth: 'ok',
      httpStatus: 200,
      okFromBackend: !!(data && data.ok === true),
      outpatientResponse: responsePreview(data, 2000),
    });
    res.json(data);
  } catch (err) {
    // The rejection message embeds the far side's HTTP status + body slice
    // ("Apps Script HTTP 401: …" / "…returned non-JSON…: <html>…"), so storing
    // it captures the Google-HTML-page and non-2xx signatures too.
    console.error('[outpatient-lead] error:', err.message);
    recordWrite({
      at: startedAt,
      route: '/api/outpatient-lead',
      action: 'createOutpatientLead',
      auth: 'ok',
      httpStatus: 502,
      error: 'outpatient_unreachable',
      outpatientResponse: redactSecrets(String(err.message).slice(0, 2000), debugSecretList()),
    });
    res.status(502).json({ ok: false, error: 'outpatient_unreachable', message: err.message });
  }
});

/* POST /api/verify-pin — the browser sends { pin } and we compare it, in
 * constant time, against APP_PIN (which never leaves the server). Rate-limited
 * to 10 attempts per 15 minutes per client IP to blunt brute-forcing of a
 * short numeric PIN. A correct PIN resets that IP's counter (200); a wrong one
 * counts against it (401); exceeding the window is 429 without even checking.
 * Fail-closed: an unset APP_PIN makes checkPin return false, so every attempt
 * is a 401. */
const PIN_RATE_LIMIT = { max: 10, windowMs: 15 * 60 * 1000 };
const pinAttempts = new Map(); // ip -> { count, resetAt }

function pinClientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length) return xff.split(',')[0].trim();
  return req.ip || req.socket.remoteAddress || 'unknown';
}

app.post('/api/verify-pin', (req, res) => {
  const ip = pinClientIp(req);
  const now = Date.now();

  let rec = pinAttempts.get(ip);
  if (!rec || now >= rec.resetAt) {
    rec = { count: 0, resetAt: now + PIN_RATE_LIMIT.windowMs };
    pinAttempts.set(ip, rec);
  }

  if (rec.count >= PIN_RATE_LIMIT.max) {
    const retryAfter = Math.max(1, Math.ceil((rec.resetAt - now) / 1000));
    res.set('Retry-After', String(retryAfter));
    return res.status(429).json({ ok: false, error: 'rate_limited', retryAfter });
  }

  const pin = req.body && req.body.pin;
  if (checkPin(pin, APP_PIN)) {
    pinAttempts.delete(ip); // reset the counter on success
    /* Mint the session cookie so subsequent data requests are authorized. Only
     * possible when SESSION_SECRET is configured; if it isn't, the PIN is still
     * accepted (200) but no usable cookie is issued, so the data routes stay
     * 503 — the fail-closed state, surfaced to the operator, not to an attacker. */
    if (SESSION_SECRET) {
      const token = createSessionToken(SESSION_SECRET);
      res.set('Set-Cookie', buildSessionCookie(token, requestIsHttps(req)));
    }
    return res.status(200).json({ ok: true });
  }

  rec.count++;
  return res.status(401).json({ ok: false, error: 'invalid_pin' });
});

/* POST /api/logout — clear the session cookie (expire it immediately). Open
 * route: clearing a credential never needs one. The client reloads afterward,
 * which re-hits getData, gets 401, and shows the PIN screen. */
app.post('/api/logout', (req, res) => {
  const parts = [
    `${SESSION_COOKIE}=`,
    'HttpOnly',
    'SameSite=Strict',
    'Path=/',
    'Max-Age=0',
  ];
  if (requestIsHttps(req)) parts.push('Secure');
  res.set('Set-Cookie', parts.join('; '));
  res.status(200).json({ ok: true });
});

/* ===== Meeting-report micro-app routes =====
 *
 * A standalone mobile page for house managers to report meeting outcomes.
 * Own PIN (MEETING_REPORT_PIN), own scoped session cookie (mr_session) — a
 * manager with the reporting PIN can never reach the main dashboard, and a
 * dashboard session can never call the meeting-report API. */

/* GET /meeting-report — serve the form page to a valid meeting-report session,
 * the PIN entry page otherwise. Fail-closed 503 when MEETING_REPORT_PIN or
 * SESSION_SECRET is unset: the page itself is gated, not just the API. */
function handleMeetingReportPage(req, res) {
  if (!MEETING_REPORT_PIN || !SESSION_SECRET) {
    return res.status(503).json({
      ok: false,
      error: 'meeting_report_not_configured',
      message: 'MEETING_REPORT_PIN / SESSION_SECRET is not set — /meeting-report is closed by design (fail-closed).',
    });
  }
  const authed = mrSessionAuthStatus(req.headers.cookie, SESSION_SECRET) === 'ok';
  const file = authed ? 'meeting-report.html' : 'meeting-report-pin.html';
  const html = fs.readFileSync(path.join(__dirname, 'public', file), 'utf8')
    .replace(/__BUILD__/g, BUILD_ID);
  noCache(res);
  return res.type('html').send(html);
}
app.get('/meeting-report', handleMeetingReportPage);

/* The form's own JS/CSS — served only to a valid meeting-report session (the
 * form page is gated, so its assets are too; the PIN page is self-contained). */
app.get('/meeting-report.js', requireMeetingReportSession, sendStatic('meeting-report.js', 'application/javascript'));
app.get('/meeting-report.css', requireMeetingReportSession, sendStatic('meeting-report.css', 'text/css'));

/* POST /api/meeting-report/verify-pin — mirrors /api/verify-pin (constant-time
 * compare, per-IP rate limit with its OWN counter map) but checks
 * MEETING_REPORT_PIN and mints the meeting-report-scoped cookie. Fail-closed:
 * an unset MEETING_REPORT_PIN makes checkPin reject every attempt. */
const mrPinAttempts = new Map(); // ip -> { count, resetAt }

app.post('/api/meeting-report/verify-pin', (req, res) => {
  const ip = pinClientIp(req);
  const now = Date.now();

  let rec = mrPinAttempts.get(ip);
  if (!rec || now >= rec.resetAt) {
    rec = { count: 0, resetAt: now + PIN_RATE_LIMIT.windowMs };
    mrPinAttempts.set(ip, rec);
  }

  if (rec.count >= PIN_RATE_LIMIT.max) {
    const retryAfter = Math.max(1, Math.ceil((rec.resetAt - now) / 1000));
    res.set('Retry-After', String(retryAfter));
    return res.status(429).json({ ok: false, error: 'rate_limited', retryAfter });
  }

  const pin = req.body && req.body.pin;
  if (checkPin(pin, MEETING_REPORT_PIN)) {
    mrPinAttempts.delete(ip);
    /* Same fail-closed shape as the main verify-pin: without SESSION_SECRET the
     * PIN is accepted but no usable cookie can be minted, so the routes stay
     * 503 — surfaced to the operator, not to an attacker. */
    if (SESSION_SECRET) {
      const token = createSessionToken(SESSION_SECRET, undefined, MR_SESSION_SCOPE);
      res.set('Set-Cookie', buildMeetingReportCookie(token, requestIsHttps(req)));
    }
    return res.status(200).json({ ok: true });
  }

  rec.count++;
  return res.status(401).json({ ok: false, error: 'invalid_pin' });
});

/* GET /api/meeting-report/leads — minimal open-lead list for the picker:
 * { id, name, house, visitDate } ONLY (no phones, no notes, no billing).
 * The field whitelist is enforced on the Apps Script side (meetingReportLeads_)
 * AND re-applied here, so a backend regression can never widen the exposure.
 * The shared secret rides the POST body (never a URL, never the browser). */
app.get('/api/meeting-report/leads', requireMeetingReportSession, async (_req, res) => {
  if (!MEETING_REPORT_SECRET) {
    return res.status(503).json({ ok: false, error: 'meeting_report_not_configured' });
  }
  try {
    const data = await sheetsPost({ action: 'meetingReportLeads', secret: MEETING_REPORT_SECRET });
    if (!data || data.ok !== true || !Array.isArray(data.leads)) {
      const preview = redactSecrets(responsePreview(data, 300), [MEETING_REPORT_SECRET]);
      console.error('[meeting-report leads] backend refused:', preview);
      return res.status(502).json({ ok: false, error: 'backend_refused' });
    }
    const leads = data.leads.map((l) => ({
      id:        l && l.id        != null ? String(l.id)        : '',
      name:      l && l.name      != null ? String(l.name)      : '',
      house:     l && l.house     != null ? String(l.house)     : '',
      visitDate: l && l.visitDate != null ? String(l.visitDate) : '',
    }));
    res.json({ ok: true, leads });
  } catch (err) {
    console.error('[meeting-report leads] error:', redactSecrets(err.message, [MEETING_REPORT_SECRET]));
    res.status(502).json({ ok: false, error: 'sheets_unreachable' });
  }
});

/* POST /api/meeting-report/submit — forward the report to Apps Script with the
 * shared secret attached server-side. Validation is authoritative on the Apps
 * Script side (submitMeetingReport_); the browser only ever sees ok/error. */
app.post('/api/meeting-report/submit', requireMeetingReportSession, async (req, res) => {
  if (!MEETING_REPORT_SECRET) {
    return res.status(503).json({ ok: false, error: 'meeting_report_not_configured' });
  }
  const b = req.body || {};
  const report = {
    leadId:    b.leadId    == null ? '' : String(b.leadId),
    outcome:   b.outcome   == null ? '' : String(b.outcome),
    companion: b.companion == null ? '' : String(b.companion),
    note:      b.note      == null ? '' : String(b.note),
    reporter:  b.reporter  == null ? '' : String(b.reporter),
  };
  try {
    const data = await sheetsPost({ action: 'submitMeetingReport', secret: MEETING_REPORT_SECRET, report });
    recordWrite({
      at: new Date().toISOString(),
      route: '/api/meeting-report/submit',
      action: 'submitMeetingReport',
      auth: 'ok',
      httpStatus: 200,
      okFromBackend: !!(data && data.ok === true),
      responsePreview: redactSecrets(responsePreview(data, 1000), [MEETING_REPORT_SECRET]),
    });
    res.json(data);
  } catch (err) {
    console.error('[meeting-report submit] error:', redactSecrets(err.message, [MEETING_REPORT_SECRET]));
    recordWrite({
      at: new Date().toISOString(),
      route: '/api/meeting-report/submit',
      action: 'submitMeetingReport',
      auth: 'ok',
      httpStatus: 502,
      error: redactSecrets(err.message, debugSecretList().concat([MEETING_REPORT_SECRET])),
    });
    res.status(502).json({ ok: false, error: 'sheets_unreachable' });
  }
});

app.get('/healthz', (_, res) => res.json({ ok: true }));

/* 404 fallback — logs and returns JSON so an unexpected request (e.g.
 * Sandra typing a stray URL) is visible in the logs. */
app.use((req, res) => {
  console.log(`[req] 404 for ${req.method} ${req.originalUrl}`);
  res.status(404).json({ error: 'not_found', method: req.method, url: req.originalUrl });
});

/* Only bind the port when run directly (node server.js / Procfile `web`).
 * When required from a test, skip listen so the pure helpers above can be
 * exercised without opening a socket. */
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`E-ZONE Dashboard running on port ${PORT} build ${BUILD_ID}`);
  });
}

module.exports = {
  buildLoadPreviews,
  followingRequest,
  parseSessionCookie,
  sessionAuthStatus,
  requireSession,
  buildSessionCookie,
  requestIsHttps,
  // Meeting-report micro-app (see test/meeting-report-server.test.js).
  parseMeetingReportCookie,
  mrSessionAuthStatus,
  requireMeetingReportSession,
  buildMeetingReportCookie,
  handleMeetingReportPage,
  // Write & handoff diagnostics (in-memory state exposed for the test harness;
  // the running server mutates the same objects the tests inspect).
  recordWrite,
  noteAuthFailure,
  redactSecrets,
  responsePreview,
  compareSaveAllCounts,
  writeLog,
  authFailures,
  WRITE_LOG_MAX,
};
