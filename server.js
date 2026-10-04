const express = require('express');
const path = require('path');
const fs = require('fs');
const https = require('https');
const { checkPin } = require('./lib/pin');
const { createSessionToken, verifySessionToken, readSession } = require('./lib/session');
const {
  APPROVER_ID, USER_MODEL, validateUserPinHashes, hasApprover, resolvePrincipal, recordLine,
  loginUsers, modelById, principalCapabilities, hasFinance,
  hasBillingControl, isControllerView, principalView,
} = require('./lib/users');
const {
  FINANCE_ACTIONS, FINANCE_ROUTES, FINANCE_FORBIDDEN_MESSAGE, isFinanceAction, stripFinanceKeys,
  BILLING_CONTROL_ACTIONS, CONTROLLER_ACTIONS, CONTROLLER_ROUTES, BILLING_CONTROL_FORBIDDEN_MESSAGE,
  isBillingControlAction, isControllerAction, isControllerRoute,
} = require('./lib/finance-scope');
const { hashPin, verifyPin, pinPolicyError } = require('./lib/pin-hash');
const { WindowCounter, PinLockout } = require('./lib/rate-limit');
const {
  ROLE_FORBIDDEN_MESSAGE, roleOperationFor, requiredRoleFor, principalHasRole, roleAllowed,
} = require('./lib/role-scope');
const { buildXlsxReport, isoDayInIsrael, XLSX_MIME } = require('./lib/xlsx-report');
const { buildRefundForecastSpec, isForecastResponse, contentDisposition } = require('./lib/refund-forecast-xlsx');
const { buildCleanupSpec, isCleanupResponse, cleanupContentDisposition } = require('./lib/cleanup-xlsx');
const {
  buildBillingControlSpec, isBillingControlResponse, billingControlContentDisposition,
} = require('./lib/billing-control-xlsx');
const {
  buildDebtAgingSpec, isDebtAgingResponse, validateDebtAgingQuery, debtAgingContentDisposition,
} = require('./lib/debt-aging-xlsx');

const app = express();
app.disable('etag');
app.disable('x-powered-by');

/* Trust exactly ONE proxy hop — Railway's edge, which appends the real client
 * address to X-Forwarded-For. Express then derives req.ip from the RIGHTMOST
 * entry (the one Railway wrote), so a client-supplied X-Forwarded-For can no
 * longer pick the address the PIN rate limit counts against. Before this, the
 * limiter read the LEFTMOST entry — fully client-controlled — and a new fake
 * address per request reset the counter (the XFF spoofing bug). */
/* TRUST_PROXY_HOPS (optional Railway variable, integer 0–5, default 1) is an
 * escape hatch only: if Railway ever adds a second hop, raise it without a
 * code change. Anything else falls back to 1. */
function trustProxyHops(raw) {
  const n = raw === undefined || raw === '' ? 1 : Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= 5 ? n : 1;
}
const TRUST_PROXY_HOPS = trustProxyHops(process.env.TRUST_PROXY_HOPS);
app.set('trust proxy', TRUST_PROXY_HOPS);
const PORT = process.env.PORT || 3000;

/* Always emit headers that defeat browser caches, CDNs (Cloudflare,
 * Fastly), and shared proxies for every response the app serves.
 *
 * `Vary: *` USED TO BE SET HERE AND IS DELIBERATELY GONE. It broke the service
 * worker outright: the Cache API refuses to STORE any response whose Vary
 * header contains '*' (Cache.add/addAll/put reject with a TypeError), so every
 * single precache write failed and sw.js could never finish installing. See
 * CHANGELOG-sw-install-fix.md.
 *
 * Nothing is weakened by its removal. `Vary: *` only ever told a SHARED cache
 * "never reuse this response for anyone" — which the four directives below
 * already say, more explicitly and to more caches:
 *   Cache-Control: no-store    — do not write it down, anywhere
 *                  no-cache    — never serve without revalidating
 *                  must-revalidate, max-age=0
 *                  private     — never store in a shared cache
 *   Surrogate-Control / CDN-Cache-Control / Cloudflare-CDN-Cache-Control:
 *                  no-store    — the same instruction to CDNs specifically
 * `Vary: *` added no protection on top of `no-store`; it only broke the one
 * cache we actually want: the app's own offline shell. */
function noCache(res) {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0, private');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  res.set('Surrogate-Control', 'no-store');
  res.set('CDN-Cache-Control', 'no-store');
  res.set('Cloudflare-CDN-Cache-Control', 'no-store');
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

/* Proxy secret (Phase 0b-1, docs/billing-control-plan.md §11.1). Sent on
 * EVERY call to this app's Apps Script backend (SHEETS_URL), in the POST body
 * only — never in a URL, a log line or an error message. Code.gs compares it in
 * constant time against Script Property PROXY_SECRET. FAIL-CLOSED: unset means
 * the server refuses to proxy at all (every Apps Script route answers 503
 * proxy_not_configured and no request leaves the server). It is NOT sent to the
 * Outpatient backend (a different app with its own secret). */
const PROXY_SECRET = process.env.PROXY_SECRET || '';
if (!PROXY_SECRET) {
  console.error('[config] PROXY_SECRET is not set — the server REFUSES to proxy to Apps Script: /api/sheets and /api/meeting-report/* will return 503 until it is configured (fail-closed). See DEPLOY.md → "Proxy secret".');
}

/* Outpatient cross-app lead write (PR 3). The /exec URL and the shared secret
 * come from Railway env so the secret never reaches the browser and is never
 * committed. Both must be set for the endpoint to do anything (fail-closed,
 * mirroring the getAdmittedRoster secret discipline on the Apps Script side). */
const OUTPATIENT_LEAD_URL    = process.env.OUTPATIENT_LEAD_URL    || '';
const OUTPATIENT_LEAD_SECRET = process.env.OUTPATIENT_LEAD_SECRET || '';

/* The shared code (APP_PIN) and its dual window (APP_PIN_UNTIL) were removed
 * on 2026-10-04 (personal PINs PR C, CHANGELOG-personal-pins-cleanup.md):
 * every login is a personal one. Neither variable is read for anything; if
 * either is still set in Railway, ONE warning says it is ignored. The line
 * names the variables only — never a value. */
const RETIRED_ENV = ['APP_PIN', 'APP_PIN_UNTIL'].filter((k) => !!process.env[k]);
if (RETIRED_ENV.length) {
  console.warn('[config] ' + RETIRED_ENV.join(' and ') + ' ' + (RETIRED_ENV.length > 1 ? 'are' : 'is') +
    ' set but ignored — the shared code was removed (personal codes only). Delete ' +
    (RETIRED_ENV.length > 1 ? 'them' : 'it') + ' in Railway.');
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

/* ===== Personal PINs — foundation (plan §11.2, PR A; nothing user-facing) =====
 *
 * USER_PIN_HASHES (Railway, JSON array of {id, name, roles, hash, pinVersion,
 * status}) is validated ONCE at startup by lib/users.js. Unset/blank is fine
 * (no personal users yet — today's state). Bad JSON, an unknown role or id, or
 * ANY approver other than Sandra is a STARTUP FAILURE: a mis-pasted value must
 * stop the deploy loudly, never silently grant or drop a role. The error names
 * the rule and record index only — never a hash. */
let USER_REGISTRY;
try {
  USER_REGISTRY = validateUserPinHashes(process.env.USER_PIN_HASHES);
} catch (err) {
  console.error('[config] USER_PIN_HASHES is invalid — refusing to start: ' + err.message);
  throw err;
}

/* PIN_PEPPER (Railway) — mixed into every personal-PIN hash (lib/pin-hash.js).
 * Never stored next to the hashes. Unset → no personal PIN can be hashed or
 * verified (fail-closed); nothing uses it until PR B except the bootstrap. */
const PIN_PEPPER = process.env.PIN_PEPPER || '';

/* BOOTSTRAP_TOKEN (Railway) — one-time setup of Sandra's own record. While it
 * is set AND USER_PIN_HASHES holds no approver, POST /api/bootstrap-pin with
 * this token + a PIN returns the record line for Sandra only. Remove it once
 * her line is pasted; the log warns on every start while it is still set. */
const BOOTSTRAP_TOKEN = process.env.BOOTSTRAP_TOKEN || '';
const BOOTSTRAP_TOKEN_MIN_LEN = 32;
if (BOOTSTRAP_TOKEN) {
  console.warn('[config] BOOTSTRAP_TOKEN is still set — delete it in Railway once Sandra\'s USER_PIN_HASHES line is pasted.' +
    (hasApprover(USER_REGISTRY) ? ' (An approver already exists, so /api/bootstrap-pin is disabled.)' : '') +
    (BOOTSTRAP_TOKEN.length < BOOTSTRAP_TOKEN_MIN_LEN ? ' (It is shorter than ' + BOOTSTRAP_TOKEN_MIN_LEN + ' characters, so /api/bootstrap-pin is disabled.)' : ''));
}

/* HEALTHCHECK_TOKEN (Railway, ≥ 32 characters) — the weekly healthcheck's
 * own credential (PR C; it replaced the shared APP_PIN). It opens exactly one
 * read-only route, GET /api/healthcheck (see there). Unset or shorter than 32
 * characters → the route answers 404 and the startup log says why — never
 * the value. */
const HEALTHCHECK_TOKEN = process.env.HEALTHCHECK_TOKEN || '';
const HEALTHCHECK_TOKEN_MIN_LEN = 32;
if (!HEALTHCHECK_TOKEN) {
  console.warn('[config] HEALTHCHECK_TOKEN is not set — GET /api/healthcheck is disabled (404) and the weekly healthcheck cannot read data.');
} else if (HEALTHCHECK_TOKEN.length < HEALTHCHECK_TOKEN_MIN_LEN) {
  console.warn('[config] HEALTHCHECK_TOKEN is shorter than ' + HEALTHCHECK_TOKEN_MIN_LEN + ' characters — GET /api/healthcheck is disabled (404).');
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
  // Path only — the querystring can carry request data and is never logged.
  console.log(`[req] ${req.method} ${req.path} host=${req.headers.host} xfwd=${req.headers['x-forwarded-host'] || '-'}`);
  next();
});

/* ===== «בקרת גבייה» — the controller view lock (Phase 4, Sandra 2026-10-04) =====
 *
 * Ortal's session (lib/users.js isControllerView — by stable id) sees ONLY
 * the «בקרת גבייה» tab. Registered BEFORE every route, so it also covers any
 * /api/ route added later: an /api/ path outside lib/finance-scope.js
 * CONTROLLER_ROUTES → 403, before any handler runs. /api/sheets is further
 * limited to CONTROLLER_ACTIONS by requireBillingControlForAction. Pages and
 * static assets are not data and pass. Logged with the path only. */
function controllerRouteLock(req, res, next) {
  if (isControllerRoute(req.path)) return next();
  const p = sessionPrincipalFromRequest(req);
  if (!isControllerView(p)) return next();
  console.warn(`[billing-control] 403 user=${p.id} route=${req.path}`);
  return res.status(403).json({ ok: false, error: 'forbidden', message: BILLING_CONTROL_FORBIDDEN_MESSAGE });
}
app.use(controllerRouteLock);

/* Serve index.html with BUILD_ID substituted so the script tag is unique
 * per deploy and cannot be cached between deploys. Read from disk on every
 * request so a hot-redeploy picks up edits immediately. */
function sendIndex(req, res) {
  let html = fs.readFileSync(path.join(__dirname, 'public/index.html'), 'utf8')
    .replace(/__BUILD__/g, BUILD_ID);
  // Restricted view: a session without `finance` (Shiran / Yael) gets
  // <body class="view-restricted">, so the four money tabs and the billing
  // widgets never paint; app.js then removes them from the DOM. No session
  // (the login screen) or a full-view session: the page is unchanged.
  // «בקרת גבייה» (Phase 4): Ortal's controller session gets
  // <body class="view-controller"> — only that tab ever paints.
  const principal = sessionPrincipalFromRequest(req);
  if (isControllerView(principal)) html = html.replace('<body>', '<body class="view-controller">');
  else if (principal && !hasFinance(principal)) html = html.replace('<body>', '<body class="view-restricted">');
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
/* The payment-report rules (Phase 3 PR 2): the SAME file the server tests
 * require (lib/payment-report-rules.js, a pure IIFE that exposes
 * window.PaymentReportRules in a browser), so the «דווח תשלום» form validates
 * with exactly the rules Code.gs mirrors. No data in it — only the rules and
 * the Hebrew messages — so it is served like app.js, to any page. */
app.get('/payment-report-rules.js', (_req, res) => {
  try {
    const content = fs.readFileSync(path.join(__dirname, 'lib', 'payment-report-rules.js'));
    noCache(res);
    res.type('application/javascript').send(content);
  } catch (_err) {
    res.status(404).send('not found');
  }
});
/* «בקרת גבייה» (Phase 4): lib/billing-control-rules.js — the tab's pure views
 * and the «הכנסה מאומתת» allocation — is the SAME file the «ייצוא אימות»
 * workbook requires (window.BillingControlRules in a browser). Rules only, no
 * data, so it is served like app.js. */
app.get('/billing-control-rules.js', (_req, res) => {
  try {
    const content = fs.readFileSync(path.join(__dirname, 'lib', 'billing-control-rules.js'));
    noCache(res);
    res.type('application/javascript').send(content);
  } catch (_err) {
    res.status(404).send('not found');
  }
});
app.get('/style.css', sendStatic('style.css', 'text/css'));
// Patient funder helpers (public/funder.js, global Funder) — loaded before app.js.
app.get('/funder.js', sendStatic('funder.js', 'application/javascript'));

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

/* Thrown (never sent anywhere) when PROXY_SECRET is unset. */
const PROXY_NOT_CONFIGURED = 'proxy_not_configured';

/* The read params a browser GET carries, converted exactly as the old
 * querystring forwarding did (objects JSON-stringified, everything else
 * String()), so Code.gs sees the same values. Pure. */
function readParamsToBody(params) {
  const out = {};
  Object.entries(params || {}).forEach(([k, v]) => {
    if (v === undefined || v === null) return;
    out[k] = typeof v === 'object' ? JSON.stringify(v) : String(v);
  });
  return out;
}

/* Proxy-owned identity fields beyond user/proxyUser. A client can never send
 * them: buildAppsScriptBody deletes any incoming copy before adding its own. */
const PROXY_PRINCIPAL_FIELDS = ['proxyRoles', 'proxyAuth', 'proxyUserId', 'proxyCaps'];

/* The principal for an Apps Script call that carries no dashboard session
 * (the meeting-report micro-app): no roles at all. */
const NO_PRINCIPAL = Object.freeze({ auth: 'none', id: '', user: '', roles: [] });

/* The exact JSON body sent to Apps Script: the caller's fields, then the
 * proxy-owned fields LAST so nothing a client sends can override them.
 *   user        — the session user (kept for a Code.gs that predates 0b-1)
 *   proxyUser   — the session user, which Code.gs trusts once the secret
 *                 verifies (a contradicting `user` is ignored + logged)
 *   proxySecret — PROXY_SECRET. Body only: never in a URL.
 *   proxyCaps   — the session's view capabilities (['finance'] or []).
 *   proxyRoles / proxyAuth / proxyUserId — the session principal's roles,
 *                 'personal' | 'none', and stable id (personal
 *                 only). Code.gs grants roles ONLY when the secret verifies.
 *                 Sent whenever a principal is given (sheetsPost always gives
 *                 one); any client-sent copy is dropped either way. Pure. */
function buildAppsScriptBody(fields, user, secret, principal) {
  const u = typeof user === 'string' ? user : '';
  const clean = Object.assign({}, fields || {});
  PROXY_PRINCIPAL_FIELDS.forEach((k) => { delete clean[k]; });
  const out = Object.assign(clean, { user: u, proxyUser: u, proxySecret: String(secret || '') });
  if (principal && typeof principal === 'object') {
    out.proxyUserId = typeof principal.id === 'string' ? principal.id : '';
    out.proxyAuth = typeof principal.auth === 'string' ? principal.auth : 'none';
    out.proxyRoles = Array.isArray(principal.roles) ? principal.roles.slice() : [];
    // View capabilities (restricted view): derived from the principal here,
    // never from the body. Code.gs re-derives them from proxyAuth +
    // proxyUserId and honours the intersection (defense in depth).
    out.proxyCaps = principalCapabilities(principal);
  }
  return out;
}

/* A READ (the browser's GET /api/sheets) — sent to Apps Script as a POST
 * whose JSON body carries the params, because Apps Script exposes no request
 * headers and a querystring would put the secret in a URL. doGet and doPost
 * both route through the same gate + handle_, so the result is identical.
 * Follows Google's 302 → googleusercontent.com. */
function sheetsGet(params, user, principal) {
  return sheetsPost(Object.assign(readParamsToBody(params), { user: typeof user === 'string' ? user : '' }), principal);
}

/* POST a JSON body to the Apps Script, with the proxy secret attached here —
 * the ONE place every Apps Script call goes through. Follows the 302 as GET
 * (standard Apps Script behavior — the redirect target serves the precomputed
 * doPost response). Fail-closed: no PROXY_SECRET → rejects WITHOUT any
 * network call. `body.user` is the session user the route resolved;
 * `principal` the session principal (NO_PRINCIPAL when omitted — no roles). */
function sheetsPost(body, principal) {
  return new Promise((resolve, reject) => {
    if (!PROXY_SECRET) return reject(new Error(PROXY_NOT_CONFIGURED));
    const b = body || {};
    const payload = JSON.stringify(buildAppsScriptBody(b, b.user, PROXY_SECRET, principal || NO_PRINCIPAL));
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
  return [OUTPATIENT_LEAD_SECRET, SESSION_SECRET, MEETING_REPORT_SECRET, PROXY_SECRET];
}

/* An error message safe to log or return: every configured secret redacted
 * and capped. Every Apps Script error path goes through this. */
function safeErrorMessage(err) {
  return redactSecrets(String((err && err.message) || err || '').slice(0, 500), debugSecretList());
}

/* Send an Apps Script response to the browser with PROXY_SECRET redacted.
 * Code.gs strips the secret before any handler runs, so this is
 * defense-in-depth: even a backend that echoed it could never hand it to a
 * browser. One split/join over the serialized body. */
function sendAppsScriptJson(res, data) {
  const text = JSON.stringify(data === undefined ? null : data);
  res.type('application/json').send(redactSecrets(text, [PROXY_SECRET]));
}

/* Express middleware: refuse to proxy when PROXY_SECRET is unset
 * (fail-closed, 503, no outbound request). */
function requireProxySecret(_req, res, next) {
  if (!PROXY_SECRET) {
    return res.status(503).json({
      ok: false,
      error: PROXY_NOT_CONFIGURED,
      message: 'PROXY_SECRET is not set — the server refuses to proxy to Apps Script (fail-closed).',
    });
  }
  return next();
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
 *                      AND (personal cookies only) its user is still active
 *                      with the same pinVersion in `registry`
 *   'unauthorized'   → missing / malformed / tampered / expired cookie, or a
 *                      personal cookie that was reset or revoked (→ 401)
 * `registry` defaults to the validated USER_PIN_HASHES. A cookie without a
 * personal id (the retired shared APP_PIN format) is always 'unauthorized'. */
function sessionAuthStatus(cookieHeader, secret, registry) {
  if (typeof secret !== 'string' || secret.length === 0) return 'not_configured';
  const token = parseSessionCookie(cookieHeader);
  const session = token ? readSession(token, secret) : null;
  if (session && currentPrincipal(session, registry)) return 'ok';
  return 'unauthorized';
}

/* resolvePrincipal over the validated USER_PIN_HASHES: a PERSONAL session
 * whose record is active with the same pinVersion, or null. A shared
 * (APP_PIN, auth:'shared') cookie resolves to null → 401 everywhere. */
function currentPrincipal(session, registry) {
  return resolvePrincipal(session, registry === undefined ? USER_REGISTRY : registry);
}

/* The principal behind the request's VERIFIED session cookie
 * ({ auth:'personal', id, user, roles } — see lib/users.js
 * resolvePrincipal), or null. */
function sessionPrincipalFromRequest(req, registry) {
  if (!SESSION_SECRET) return null;
  const session = readSession(parseSessionCookie(req.headers.cookie), SESSION_SECRET);
  return currentPrincipal(session, registry);
}

/* The user name of the request's VERIFIED personal session (the record's
 * name), '' when there is none (callers behind requireSession never see that
 * case). This — never a client-supplied body field — is the only source of
 * the `user` the sheets proxy forwards. */
function sessionUserFromRequest(req) {
  const principal = sessionPrincipalFromRequest(req);
  return principal ? principal.user : '';
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

/* ===== Restricted view — the `finance` capability (Sandra, 2026-10-03) =====
 *
 * Shiran and Yael see every tab except the four money tabs (גבייה, הכנסות
 * חודשיות, שיוך תשלומים, גרף צמיחה) and no billing widget elsewhere. THIS is
 * the real lock: any session without `finance` (lib/users.js
 * principalCapabilities — by stable user id, so no USER_PIN_HASHES change)
 * gets 403 for every action in lib/finance-scope.js FINANCE_ACTIONS and every
 * route in FINANCE_ROUTES, BEFORE anything is proxied. Sandra and Vered are
 * unchanged. The refusal is logged
 * with the user id and the action/route only — never data. */
function financeForbidden(res, req, what) {
  const p = sessionPrincipalFromRequest(req);
  const who = p ? (p.id || p.auth) : 'none';
  console.warn(`[finance] 403 user=${who} ${what}`);
  return res.status(403).json({ ok: false, error: 'forbidden', message: FINANCE_FORBIDDEN_MESSAGE });
}

/* /api/sheets: refuse a FINANCE_ACTIONS action (GET query or POST body).
 * The controller view's own allow-list (CONTROLLER_ACTIONS — debtAging for
 * the «חובות פתוחים» export) is decided by requireBillingControlForAction,
 * which runs first. */
function requireFinanceForAction(req, res, next) {
  const action = req.method === 'GET' ? (req.query && req.query.action) : (req.body && req.body.action);
  if (!isFinanceAction(action)) return next();
  const p = sessionPrincipalFromRequest(req);
  if (hasFinance(p)) return next();
  if (isControllerView(p) && isControllerAction(action) && hasBillingControl(p)) return next();
  return financeForbidden(res, req, 'action=' + action);
}

/* A whole route that only serves billing data. */
function requireFinance(req, res, next) {
  if (hasFinance(sessionPrincipalFromRequest(req))) return next();
  return financeForbidden(res, req, 'route=' + req.path);
}

/* «בקרת גבייה» (Phase 4) on /api/sheets, BEFORE anything is proxied:
 *   - the controller view (Ortal) may call ONLY CONTROLLER_ACTIONS — getData
 *     and every lead / patient / billing action → 403;
 *   - BILLING_CONTROL_ACTIONS need billingControl (Shiran, Yael → 403).
 * Code.gs (viewRefused_) refuses the same again. */
function billingControlForbidden(res, req, what) {
  const p = sessionPrincipalFromRequest(req);
  console.warn(`[billing-control] 403 user=${p ? (p.id || p.auth) : 'none'} ${what}`);
  return res.status(403).json({ ok: false, error: 'forbidden', message: BILLING_CONTROL_FORBIDDEN_MESSAGE });
}
function requireBillingControlForAction(req, res, next) {
  const action = req.method === 'GET' ? (req.query && req.query.action) : (req.body && req.body.action);
  const p = sessionPrincipalFromRequest(req);
  if (isControllerView(p) && !isControllerAction(action)) {
    return billingControlForbidden(res, req, 'action=' + String(action == null ? '' : action).slice(0, 60));
  }
  if (isBillingControlAction(action) && !hasBillingControl(p)) return billingControlForbidden(res, req, 'action=' + action);
  return next();
}

/* A route of the «בקרת גבייה» tab: billingControl (Vered, Sandra, Ortal). */
function requireBillingControl(req, res, next) {
  if (hasBillingControl(sessionPrincipalFromRequest(req))) return next();
  return billingControlForbidden(res, req, 'route=' + req.path);
}

/* A billing route the controller view also needs (the «חובות פתוחים»
 * export the tab links to): finance, or the controller view. */
function requireFinanceOrController(req, res, next) {
  const p = sessionPrincipalFromRequest(req);
  if (hasFinance(p) || (isControllerView(p) && hasBillingControl(p))) return next();
  return financeForbidden(res, req, 'route=' + req.path);
}

/* Roles (PR C): a DELETE_ACTIONS operation without `deleter`, or an
 * APPROVER_ACTIONS operation outside Sandra's personal session → 403
 * {ok:false, error:'forbidden_role', message:'אין הרשאה לפעולה זו'}, BEFORE
 * anything is proxied (lib/role-scope.js). Code.gs refuses the same again,
 * and is the only side that can see an un-void. Logged with the user id and
 * the operation only — never data. */
function requireRoleForAction(req, res, next) {
  const src = req.method === 'GET' ? (req.query || {}) : (req.body || {});
  const op = roleOperationFor(src.action, src);
  if (!op) return next();
  const p = sessionPrincipalFromRequest(req);
  if (roleAllowed(p, op)) return next();
  console.warn(`[role] 403 user=${p ? p.id : 'none'} op=${op} needs=${requiredRoleFor(op)}`);
  return res.status(403).json({ ok: false, error: 'forbidden_role', message: ROLE_FORBIDDEN_MESSAGE });
}

/* getData for a session without `finance`: drop the billing-only keys
 * (GETDATA_FINANCE_KEYS — no tab such a session can see reads them). A
 * full-view session gets every key, unchanged (append-only contract). */
function viewFilteredResponse(action, data, principal) {
  return action === 'getData' && !hasFinance(principal) ? stripFinanceKeys(data) : data;
}

/* GET /api/sheets?action=getData — forwarded to Apps Script as a POST whose
 * body carries the params + proxy secret (see sheetsGet). */
app.get('/api/sheets', requireSession, requireBillingControlForAction, requireFinanceForAction, requireRoleForAction, requireProxySecret, async (req, res) => {
  const action = req.query && req.query.action;
  // The action name only — never the query values or a response body.
  console.log('[sheets GET] → action=', JSON.stringify(typeof action === 'string' ? action.slice(0, 60) : null));
  try {
    const principal = sessionPrincipalFromRequest(req);
    const data = viewFilteredResponse(action, await sheetsGet(req.query, principal ? principal.user : '', principal), principal);

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

    sendAppsScriptJson(res, data);
  } catch (err) {
    const message = safeErrorMessage(err);
    console.error('[sheets GET] error:', message);
    lastLoad = {
      at: new Date().toISOString(),
      action: action === undefined ? null : action,
      query: req.query,
      error: message,
    };
    res.status(502).json({ ok: false, error: 'sheets_unreachable', message });
  }
});


/* POST /api/sheets — body is forwarded as POST application/json to Apps Script.
 * All save operations (saveAll, etc.) use POST so the data never hits the
 * querystring length limit. */
app.post('/api/sheets', requireSession, requireBillingControlForAction, requireFinanceForAction, requireRoleForAction, requireProxySecret, async (req, res) => {
  const body = req.body || {};
  // Who/when stamping: the `user` the Apps Script writes into updatedBy
  // comes ONLY from the signed session cookie. ALWAYS overwritten — a
  // client-supplied body.user is never trusted; '' (legacy user-less cookie)
  // is forwarded as-is and stamps blank, which is allowed by contract.
  body.user = sessionUserFromRequest(req);
  // The roles Code.gs may grant (only once PROXY_SECRET verifies) — from the
  // same signed cookie, never from the body (buildAppsScriptBody drops any
  // client-sent proxyRoles / proxyAuth / proxyUserId).
  const principal = sessionPrincipalFromRequest(req);
  const summary = summarizeBody(body);
  console.log('[sheets POST] →', summary);
  try {
    const data = viewFilteredResponse(body.action, await sheetsPost(body, principal), principal);
    // Outcome only — the response can carry patient / payment data, so it is
    // never written to the log.
    console.log('[sheets POST] ←', data && typeof data === 'object'
      ? { ok: data.ok, error: data.error }
      : { type: typeof data });
    lastSave = {
      at: new Date().toISOString(),
      request: { summary, keys: Object.keys(body) },
      // Truncated + redacted preview, never the raw response object.
      response: responsePreview(data, 1000),
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
    sendAppsScriptJson(res, data);
  } catch (err) {
    const message = safeErrorMessage(err);
    console.error('[sheets POST] error:', message);
    lastSave = {
      at: new Date().toISOString(),
      request: { summary, keys: Object.keys(body) },
      error: message,
    };
    recordWrite({
      at: lastSave.at,
      route: '/api/sheets',
      action: summary.action || null,
      auth: 'ok',
      httpStatus: 502,
      error: message,
      summary,
    });
    res.status(502).json({ ok: false, error: 'sheets_unreachable', message });
  }
});

/* GET /api/export/refund-forecast.xlsx — «ייצוא זיכויים לאקסל».
 *
 * Reads action=refundPayoutForecast through sheetsPost (PROXY_SECRET attached
 * there, the session user as `user`) and sends the formatted workbook built by
 * lib/xlsx-report.js. Behind requireSession + requireProxySecret like every
 * data route. Cache-Control: no-store (and the service worker never caches
 * /api/). The log carries the outcome only — never a patient name, amount or
 * response body. Deps are injectable so the test can run it without Apps
 * Script. */
function refundForecastXlsxHandler(deps) {
  const d = deps || {};
  const fetchForecast = d.fetchForecast || ((user, principal) => sheetsPost({ action: 'refundPayoutForecast', user }, principal));
  const clock = d.now || (() => new Date());
  return async (req, res) => {
    const fail = (status, error) => {
      console.error('[export refund-forecast] failed:', error);
      res.set('Cache-Control', 'no-store');
      return res.status(status).json({ ok: false, error });
    };
    let data;
    try {
      data = await fetchForecast(sessionUserFromRequest(req), sessionPrincipalFromRequest(req));
    } catch (err) {
      return fail(502, err && err.message === PROXY_NOT_CONFIGURED ? 'proxy_not_configured' : 'sheets_unreachable');
    }
    if (data && data.ok === false && data.error === 'lock_busy') return fail(503, 'lock_busy');
    if (!isForecastResponse(data)) {
      return fail(502, data && typeof data.error === 'string' ? data.error.slice(0, 60) : 'bad_response');
    }
    let buf;
    const now = clock();
    try {
      buf = await buildXlsxReport(buildRefundForecastSpec(data, now));
    } catch (_err) {
      return fail(500, 'xlsx_build_failed');
    }
    console.log('[export refund-forecast] ok, bytes=', buf.length);
    res.set({
      'Content-Type': XLSX_MIME,
      'Content-Disposition': contentDisposition(isoDayInIsrael(now)),
      'Content-Length': String(buf.length),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    return res.status(200).end(buf);
  };
}
app.get('/api/export/refund-forecast.xlsx', requireSession, requireFinance, requireProxySecret, refundForecastXlsxHandler());

/* GET /api/export/debt-aging.xlsx?asOf=YYYY-MM-DD&house=…&status=… — «חובות
 * פתוחים» → «ייצוא לאקסל».
 *
 * requireSession → query validation (400 on a bad asOf / house / status) →
 * requireProxySecret → handler. Reads action=debtAging (read-only) through
 * sheetsPost and sends the workbook built by lib/xlsx-report.js from
 * lib/debt-aging-xlsx.js: no amount is computed here, the cycles are only
 * filtered and grouped. The file is named after the AS-OF date. Never cached
 * (Cache-Control: no-store; the service worker never caches /api/). The log
 * carries the outcome only — never a patient name, amount or response body. */
function validateDebtAgingExportQuery(req, res, next) {
  const q = validateDebtAgingQuery(req.query);
  if (!q.ok) {
    console.error('[export debt-aging] failed:', q.error);
    res.set('Cache-Control', 'no-store');
    return res.status(400).json({ ok: false, error: q.error });
  }
  req.debtAgingQuery = q;
  return next();
}
function debtAgingXlsxHandler(deps) {
  const d = deps || {};
  const fetchAging = d.fetchAging || ((asOf, user, principal) => sheetsPost({ action: 'debtAging', asOf, user }, principal));
  const clock = d.now || (() => new Date());
  return async (req, res) => {
    const fail = (status, error) => {
      console.error('[export debt-aging] failed:', error);
      res.set('Cache-Control', 'no-store');
      return res.status(status).json({ ok: false, error });
    };
    const q = req.debtAgingQuery || validateDebtAgingQuery(req.query);
    if (!q.ok) return fail(400, q.error);
    let data;
    try {
      data = await fetchAging(q.asOf, sessionUserFromRequest(req), sessionPrincipalFromRequest(req));
    } catch (err) {
      return fail(502, err && err.message === PROXY_NOT_CONFIGURED ? 'proxy_not_configured' : 'sheets_unreachable');
    }
    if (data && data.ok === false && data.error === 'lock_busy') return fail(503, 'lock_busy');
    if (!isDebtAgingResponse(data) || data.asOf !== q.asOf) {
      return fail(502, data && typeof data.error === 'string' ? data.error.slice(0, 60) : 'bad_response');
    }
    let buf;
    const now = clock();
    try {
      buf = await buildXlsxReport(buildDebtAgingSpec(data, { house: q.house, status: q.status }, now, isoDayInIsrael(now)));
    } catch (_err) {
      return fail(500, 'xlsx_build_failed');
    }
    console.log('[export debt-aging] ok, bytes=', buf.length);
    res.set({
      'Content-Type': XLSX_MIME,
      'Content-Disposition': debtAgingContentDisposition(q.asOf),
      'Content-Length': String(buf.length),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    return res.status(200).end(buf);
  };
}
app.get('/api/export/debt-aging.xlsx', requireSession, requireFinanceOrController, validateDebtAgingExportQuery, requireProxySecret, debtAgingXlsxHandler());

/* GET /api/export/cleanup.xlsx — «ייצוא רשימת תיקונים».
 *
 * requireSession → requireFinance (403 for a restricted session) →
 * requireProxySecret → handler. Reads action=cleanupReport (read-only)
 * through sheetsPost and sends the workbook built by lib/xlsx-report.js from
 * lib/cleanup-xlsx.js: every known gap and inconsistency as of today, one tab
 * per kind, each row with who fixes it, how, and a «טופל» box. No check is
 * computed here. Never cached (Cache-Control: no-store; the service worker
 * never caches /api/). The log carries the outcome only — never a patient
 * name, amount or response body.
 *
 * All three export handlers pass the SESSION PRINCIPAL to sheetsPost: without
 * it the body says proxyAuth 'none' / proxyCaps [] and Code.gs
 * (financeRefused_) answers 'forbidden' to every billing action — even for
 * Sandra (CHANGELOG-cleanup-export-finance.md). */
function cleanupXlsxHandler(deps) {
  const d = deps || {};
  const fetchCleanup = d.fetchCleanup || ((user, principal) => sheetsPost({ action: 'cleanupReport', user }, principal));
  const clock = d.now || (() => new Date());
  return async (req, res) => {
    const fail = (status, error) => {
      console.error('[export cleanup] failed:', error);
      res.set('Cache-Control', 'no-store');
      return res.status(status).json({ ok: false, error });
    };
    let data;
    try {
      data = await fetchCleanup(sessionUserFromRequest(req), sessionPrincipalFromRequest(req));
    } catch (err) {
      return fail(502, err && err.message === PROXY_NOT_CONFIGURED ? 'proxy_not_configured' : 'sheets_unreachable');
    }
    if (data && data.ok === false && data.error === 'lock_busy') return fail(503, 'lock_busy');
    if (data && data.ok === false && data.error === 'forbidden') return fail(403, 'forbidden');
    if (!isCleanupResponse(data)) {
      return fail(502, data && typeof data.error === 'string' ? data.error.slice(0, 60) : 'bad_response');
    }
    let buf;
    const now = clock();
    try {
      buf = await buildXlsxReport(buildCleanupSpec(data, now));
    } catch (_err) {
      return fail(500, 'xlsx_build_failed');
    }
    console.log('[export cleanup] ok, bytes=', buf.length);
    res.set({
      'Content-Type': XLSX_MIME,
      'Content-Disposition': cleanupContentDisposition(data.today),
      'Content-Length': String(buf.length),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    return res.status(200).end(buf);
  };
}
app.get('/api/export/cleanup.xlsx', requireSession, requireFinance, requireProxySecret, cleanupXlsxHandler());

/* GET /api/export/billing-control.xlsx — «ייצוא אימות» (Phase 4).
 *
 * requireSession → requireBillingControl (Vered, Sandra, Ortal; 403 for
 * Shiran / Yael) → requireProxySecret → handler. Reads
 * action=billingControlQueue (read-only) with the SESSION PRINCIPAL (Code.gs
 * re-checks the capability) and sends the workbook built by
 * lib/xlsx-report.js from lib/billing-control-xlsx.js: ממתין / בעיה / אומתו
 * by month. No amount is computed here. Never cached (no-store; the service
 * worker never caches /api/). The log carries the outcome only. */
function billingControlXlsxHandler(deps) {
  const d = deps || {};
  const fetchQueue = d.fetchQueue || ((user, principal) => sheetsPost({ action: 'billingControlQueue', user }, principal));
  const clock = d.now || (() => new Date());
  return async (req, res) => {
    const fail = (status, error) => {
      console.error('[export billing-control] failed:', error);
      res.set('Cache-Control', 'no-store');
      return res.status(status).json({ ok: false, error });
    };
    let data;
    try {
      data = await fetchQueue(sessionUserFromRequest(req), sessionPrincipalFromRequest(req));
    } catch (err) {
      return fail(502, err && err.message === PROXY_NOT_CONFIGURED ? 'proxy_not_configured' : 'sheets_unreachable');
    }
    if (data && data.ok === false && data.error === 'lock_busy') return fail(503, 'lock_busy');
    if (data && data.ok === false && data.error === 'forbidden') return fail(403, 'forbidden');
    if (!isBillingControlResponse(data)) {
      return fail(502, data && typeof data.error === 'string' ? data.error.slice(0, 60) : 'bad_response');
    }
    let buf;
    const now = clock();
    try {
      buf = await buildXlsxReport(buildBillingControlSpec(data, now));
    } catch (_err) {
      return fail(500, 'xlsx_build_failed');
    }
    console.log('[export billing-control] ok, bytes=', buf.length);
    res.set({
      'Content-Type': XLSX_MIME,
      'Content-Disposition': billingControlContentDisposition(data.today),
      'Content-Length': String(buf.length),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    return res.status(200).end(buf);
  };
}
app.get('/api/export/billing-control.xlsx', requireSession, requireBillingControl, requireProxySecret, billingControlXlsxHandler());

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
app.get('/api/debug/last-save', requireSession, requireFinance, (_req, res) => {
  res.json({
    lastSave: lastSave || { empty: true },
    writes: writeLog,
    authFailures,
  });
});
app.get('/api/debug/last-load', requireSession, requireFinance, (_req, res) => {
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
    console.error('[outpatient-lead] error:', safeErrorMessage(err));
    recordWrite({
      at: startedAt,
      route: '/api/outpatient-lead',
      action: 'createOutpatientLead',
      auth: 'ok',
      httpStatus: 502,
      error: 'outpatient_unreachable',
      outpatientResponse: redactSecrets(String(err.message).slice(0, 2000), debugSecretList()),
    });
    res.status(502).json({ ok: false, error: 'outpatient_unreachable', message: safeErrorMessage(err) });
  }
});

/* ===== POST /api/verify-pin — the dashboard login (personal PINs only) =====
 *
 *   { userId, pin } — `pin` is checked against that user's USER_PIN_HASHES
 *     record (scrypt + PIN_PEPPER, constant-time, always one derivation — an
 *     unknown or inactive user costs the same as a wrong PIN and answers the
 *     same 401). Success mints the personal cookie
 *     `<expiry>.<name>.<id>-<pinVersion>.<sig>`.
 *   Anything without `userId` (the retired shared APP_PIN shape { pin }) →
 *     400 user_required. No PIN is checked and nothing is counted: there is
 *     no shared code left to guess (removed 2026-10-04, PR C).
 *
 * Limits (lib/rate-limit.js PinLockout, all checked BEFORE any PIN work):
 *   5 failures per user → that user is locked 15 min (429 'locked');
 *   10 failures per IP per 15 min and 30 globally per 15 min (429
 *   'rate_limited'). The IP is req.ip (trust proxy = Railway's one hop),
 *   never the raw X-Forwarded-For.
 *
 * Responses: 200 {ok:true}; 400 user_required; 401 invalid_pin; 429
 * locked|rate_limited (with Retry-After); 503 not_configured (no PIN_PEPPER).
 * The PIN is never logged, stored or echoed: the request logger prints the
 * path only and nothing here logs a body. */
const PIN_RATE_LIMIT = { max: 10, windowMs: 15 * 60 * 1000 };
const pinLockout = new PinLockout();
/* The per-IP counter (10 / 15 min). Kept under its old name for the
 * existing tests. */
const pinAttempts = pinLockout.ip;
const PERSONAL_ID_SHAPE = /^[a-z][a-z0-9]{0,31}$/;

/* The address the PIN limits count against: req.ip, which — with
 * 'trust proxy' = 1 hop — is the address Railway's edge appended, NOT the
 * client-controlled leftmost X-Forwarded-For entry. */
function pinClientIp(req) {
  return req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
}

/* 429 with Retry-After when `limit` says so; true when the caller must stop. */
function sendRateLimited(res, limit) {
  if (!limit.limited) return false;
  res.set('Retry-After', String(limit.retryAfter));
  res.status(429).json({ ok: false, error: 'rate_limited', retryAfter: limit.retryAfter });
  return true;
}

/* 429 for a PinLockout refusal: 'locked' when the USER is locked (the
 * «נעול ל־15 דקות» message), 'rate_limited' for the IP / global brakes. */
function sendLockout(res, verdict) {
  res.set('Retry-After', String(verdict.retryAfter));
  return res.status(429).json({
    ok: false, error: verdict.scope === 'user' ? 'locked' : 'rate_limited', retryAfter: verdict.retryAfter,
  });
}

async function personalLogin(req, res, b, ip) {
  // An id of the wrong shape is counted under one bucket, so junk ids can
  // neither fill the per-user map nor dodge the per-user lock.
  const rawId = typeof b.userId === 'string' ? b.userId : '';
  const key = PERSONAL_ID_SHAPE.test(rawId) ? rawId : '?';
  const verdict = pinLockout.check(key, ip);
  if (!verdict.ok) return sendLockout(res, verdict);
  if (!PIN_PEPPER) return res.status(503).json({ ok: false, error: 'not_configured' });

  // Own properties only: an id such as 'constructor' must never reach the
  // object prototype.
  const rec = Object.prototype.hasOwnProperty.call(USER_REGISTRY.byId, key) ? USER_REGISTRY.byId[key] : null;
  const loginable = !!(rec && rec.status === 'active' && modelById(key) && modelById(key).status === 'active');
  const pin = typeof b.pin === 'string' ? b.pin : '';
  // Always one scrypt derivation (verifyPin is constant-work), even for an
  // unknown / inactive user, so timing does not reveal who has a record.
  const match = await verifyPin(pin, loginable ? rec.hash : null, PIN_PEPPER);
  if (!(match && loginable)) {
    pinLockout.recordFailure(key, ip);
    const after = pinLockout.check(key, ip);
    if (!after.ok && after.scope === 'user') return sendLockout(res, after);
    return res.status(401).json({ ok: false, error: 'invalid_pin' });
  }
  pinLockout.recordSuccess(key, ip);
  if (SESSION_SECRET) {
    const token = createSessionToken(SESSION_SECRET, undefined, undefined, rec.name, { id: rec.id, pinVersion: rec.pinVersion });
    res.set('Set-Cookie', buildSessionCookie(token, requestIsHttps(req)));
  }
  return res.status(200).json({ ok: true });
}

app.post('/api/verify-pin', (req, res) => {
  const b = req.body && typeof req.body === 'object' ? req.body : {};
  const ip = pinClientIp(req);
  if (!Object.prototype.hasOwnProperty.call(b, 'userId')) {
    return res.status(400).json({ ok: false, error: 'user_required' });
  }
  return personalLogin(req, res, b, ip).catch(() => {
    if (!res.headersSent) res.status(500).json({ ok: false, error: 'login_failed' });
  });
});

/* GET /api/login-users — the login screen's step 1. Open (it runs before
 * any session exists). Lists ONLY users with an ACTIVE USER_PIN_HASHES record
 * ({ id, name }, nothing else). Ortal (inactive) is never listed. */
app.get('/api/login-users', (_req, res) => {
  res.status(200).json({ ok: true, users: loginUsers(USER_REGISTRY) });
});

/* ===== POST /api/bootstrap-pin — one-time setup of Sandra's own record =====
 *
 * Sandra has no local Node, so her FIRST personal PIN is hashed here, once:
 *   { token: BOOTSTRAP_TOKEN, pin: '<6 digits>' }
 *   → 200 { ok:true, record:'<one JSON line>' } — the line to paste into
 *     USER_PIN_HASHES. Always Sandra's record (id 'sandra', her model roles,
 *     pinVersion 1); the request cannot choose another user.
 * Open ONLY while BOOTSTRAP_TOKEN is set (≥ 32 chars), PIN_PEPPER is set, and
 * USER_PIN_HASHES has NO approver — once her line is pasted it closes for good
 * (404). Also closed after one success per process ("once only").
 * A wrong token → 403 and counts against a per-IP (5 / 15 min) and a global
 * (20 / 15 min) limit → 429. A weak PIN → 400 'weak_pin' (not counted).
 * The PIN is never stored, logged or echoed: the request logger prints the
 * path only, and nothing here logs a body. */
const BOOTSTRAP_RATE_LIMIT = { max: 5, windowMs: 15 * 60 * 1000 };
const BOOTSTRAP_GLOBAL_LIMIT = { max: 20, windowMs: 15 * 60 * 1000 };
const bootstrapAttempts = new WindowCounter(BOOTSTRAP_RATE_LIMIT);
const bootstrapGlobal = new WindowCounter(BOOTSTRAP_GLOBAL_LIMIT);
let bootstrapUsed = false;

/* 'open' or the reason the bootstrap is closed. Pure over its inputs. */
function bootstrapState(opts) {
  const o = opts || {};
  const token = o.token === undefined ? BOOTSTRAP_TOKEN : o.token;
  const pepper = o.pepper === undefined ? PIN_PEPPER : o.pepper;
  const registry = o.registry === undefined ? USER_REGISTRY : o.registry;
  const used = o.used === undefined ? bootstrapUsed : o.used;
  if (typeof token !== 'string' || token.length < BOOTSTRAP_TOKEN_MIN_LEN) return 'no_token';
  if (!pepper) return 'no_pepper';
  if (hasApprover(registry)) return 'approver_exists';
  if (used) return 'used';
  return 'open';
}

app.post('/api/bootstrap-pin', async (req, res) => {
  const state = bootstrapState();
  if (state !== 'open') return res.status(404).json({ ok: false, error: 'bootstrap_disabled' });

  const ip = pinClientIp(req);
  if (sendRateLimited(res, bootstrapGlobal.check('*'))) return undefined;
  if (sendRateLimited(res, bootstrapAttempts.check(ip))) return undefined;

  const b = req.body || {};
  if (!checkPin(typeof b.token === 'string' ? b.token : '', BOOTSTRAP_TOKEN)) {
    bootstrapAttempts.fail(ip);
    bootstrapGlobal.fail('*');
    return res.status(403).json({ ok: false, error: 'forbidden' });
  }
  bootstrapAttempts.reset(ip);

  const pin = typeof b.pin === 'string' ? b.pin : '';
  const weak = pinPolicyError(pin);
  if (weak) return res.status(400).json({ ok: false, error: 'weak_pin', reason: weak });

  // Reserve BEFORE the async hash so two concurrent calls cannot both succeed.
  bootstrapUsed = true;
  try {
    const hash = await hashPin(pin, PIN_PEPPER);
    return res.status(200).json({ ok: true, record: recordLine(APPROVER_ID, hash, 1) });
  } catch (_) {
    bootstrapUsed = false;
    return res.status(500).json({ ok: false, error: 'hash_failed' });
  }
});

/* ===== «קוד אישי חדש» — Sandra-only record maker (PR B) =====
 *
 * Sandra has no local Node, so every personal PIN after her own is hashed
 * HERE and she pastes the returned line into USER_PIN_HASHES (Railway).
 *
 *   GET  /api/pin-admin/users         → the model users she may create or
 *        reset a code for: { id, name, hasRecord, status } (no hash, no role).
 *   POST /api/pin-admin/record { userId, pin, pin2 }
 *        → 200 { ok:true, record:'<one JSON line>' } — ONLY the line.
 *          pinVersion = current + 1 for a reset (an existing record, any
 *          status — a reset re-activates), 1 for a new user. A reset keeps
 *          the existing record's (possibly narrowed) roles; a new record
 *          gets the model roles.
 *        400 weak_pin {reason} | pin_mismatch | unknown_user.
 *
 * Both need a CURRENT personal session of the approver (Sandra: id 'sandra'
 * with the approver role) — anyone else → 403
 * (requireSession → 401 first when there is no valid session at all).
 * POST is rate-limited (10 per 15 min per IP and globally), counted on every
 * call. The PIN is never stored, logged or echoed: the request logger prints
 * the path only, the response carries the scrypt hash only. Ortal (inactive
 * until Phase 4) is not offered. Nothing here changes USER_PIN_HASHES — a
 * line takes effect only when Sandra pastes it and Railway redeploys. */
const PIN_ADMIN_LIMIT = { max: 10, windowMs: 15 * 60 * 1000 };
const pinAdminAttempts = new WindowCounter(PIN_ADMIN_LIMIT);
const pinAdminGlobal = new WindowCounter(PIN_ADMIN_LIMIT);

function isApproverPrincipal(p) {
  return !!(p && p.auth === 'personal' && p.id === APPROVER_ID && p.roles.indexOf('approver') >= 0);
}

function requireApprover(req, res, next) {
  if (!isApproverPrincipal(sessionPrincipalFromRequest(req))) {
    return res.status(403).json({ ok: false, error: 'forbidden' });
  }
  return next();
}

/* The model users the page offers. Pure over the registry. */
function pinAdminUsers(registry) {
  const byId = registry && registry.byId ? registry.byId : {};
  return USER_MODEL.filter((m) => m.status === 'active').map((m) => ({
    id: m.id,
    name: m.name,
    hasRecord: !!byId[m.id],
    status: byId[m.id] ? byId[m.id].status : '',
  }));
}

app.get('/api/pin-admin/users', requireSession, requireApprover, (_req, res) => {
  res.status(200).json({ ok: true, users: pinAdminUsers(USER_REGISTRY) });
});

app.post('/api/pin-admin/record', requireSession, requireApprover, async (req, res) => {
  const ip = pinClientIp(req);
  if (sendRateLimited(res, pinAdminGlobal.check('*'))) return undefined;
  if (sendRateLimited(res, pinAdminAttempts.check(ip))) return undefined;
  pinAdminGlobal.fail('*');
  pinAdminAttempts.fail(ip);

  if (!PIN_PEPPER) return res.status(503).json({ ok: false, error: 'not_configured' });
  const b = req.body && typeof req.body === 'object' ? req.body : {};
  const userId = typeof b.userId === 'string' ? b.userId : '';
  const model = modelById(userId);
  if (!model || model.status !== 'active') return res.status(400).json({ ok: false, error: 'unknown_user' });
  const pin = typeof b.pin === 'string' ? b.pin : '';
  const pin2 = typeof b.pin2 === 'string' ? b.pin2 : '';
  // Constant-time compare of the two entries (two empty entries fall through
  // to the weak-PIN check below, which names the real problem).
  if (!(pin === '' && pin2 === '') && !checkPin(pin, pin2)) return res.status(400).json({ ok: false, error: 'pin_mismatch' });
  const weak = pinPolicyError(pin);
  if (weak) return res.status(400).json({ ok: false, error: 'weak_pin', reason: weak });

  const existing = USER_REGISTRY.byId[model.id];
  const pinVersion = existing ? existing.pinVersion + 1 : 1;
  try {
    const hash = await hashPin(pin, PIN_PEPPER);
    return res.status(200).json({ ok: true, record: recordLine(model.id, hash, pinVersion, existing ? existing.roles : undefined) });
  } catch (_) {
    return res.status(500).json({ ok: false, error: 'hash_failed' });
  }
});

/* GET /api/me — the session as the UI needs it: the display name (who/when
 * stamping), the auth kind ('personal'), whether this is Sandra's approver
 * session, whether it may delete, and whether it has the finance view.
 * Session-gated. Display only: every decision is re-made server-side from
 * the cookie (and again in Code.gs). */
app.get('/api/me', requireSession, (req, res) => {
  const p = sessionPrincipalFromRequest(req);
  res.status(200).json({
    ok: true,
    user: p ? p.user : '',
    auth: p ? p.auth : '',
    // The approver-only «קוד אישי חדש» button, un-void, exceptions, write-off.
    approver: isApproverPrincipal(p),
    // false hides every delete / void / cancel control (Shiran, Yael).
    deleter: principalHasRole(p, 'deleter'),
    // Restricted view: false hides the four money tabs and every billing
    // widget. Display only — the server refuses the data itself (403).
    finance: hasFinance(p),
    // «בקרת גבייה» (Phase 4): the capability set, the page view
    // ('full' | 'restricted' | 'controller' — Ortal sees only that tab), and
    // whether this session may confirm / flag (controller or approver role).
    capabilities: principalCapabilities(p),
    billingControl: hasBillingControl(p),
    view: principalView(p),
    canConfirm: roleAllowed(p, 'confirmPayment'),
  });
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
const mrPinAttempts = new WindowCounter(PIN_RATE_LIMIT);

app.post('/api/meeting-report/verify-pin', (req, res) => {
  const ip = pinClientIp(req);
  if (sendRateLimited(res, mrPinAttempts.check(ip))) return undefined;

  const pin = req.body && req.body.pin;
  if (checkPin(pin, MEETING_REPORT_PIN)) {
    mrPinAttempts.reset(ip);
    /* Same fail-closed shape as the main verify-pin: without SESSION_SECRET the
     * PIN is accepted but no usable cookie can be minted, so the routes stay
     * 503 — surfaced to the operator, not to an attacker. */
    if (SESSION_SECRET) {
      const token = createSessionToken(SESSION_SECRET, undefined, MR_SESSION_SCOPE);
      res.set('Set-Cookie', buildMeetingReportCookie(token, requestIsHttps(req)));
    }
    return res.status(200).json({ ok: true });
  }

  mrPinAttempts.fail(ip);
  return res.status(401).json({ ok: false, error: 'invalid_pin' });
});

/* GET /api/meeting-report/leads — minimal open-lead list for the picker:
 * { id, name, house, visitDate } ONLY (no phones, no notes, no billing).
 * The field whitelist is enforced on the Apps Script side (meetingReportLeads_)
 * AND re-applied here, so a backend regression can never widen the exposure.
 * The shared secret rides the POST body (never a URL, never the browser). */
app.get('/api/meeting-report/leads', requireMeetingReportSession, requireProxySecret, async (_req, res) => {
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
    console.error('[meeting-report leads] error:', safeErrorMessage(err));
    res.status(502).json({ ok: false, error: 'sheets_unreachable' });
  }
});

/* The ONLY cap on the manager report's פירוט free text — raised 2000 → 5000
 * (Sandra, Sep 2026). KEEP IN SYNC with MANAGER_REPORT_MAX_CHARS in
 * apps-script/Code.gs, public/meeting-report.js and public/app.js;
 * test/manager-report-length.test.js fails if the four drift apart or if any
 * other numeric literal caps this field. */
const MANAGER_REPORT_MAX_CHARS = 5000;

/* '' when the report's note is within the cap, otherwise the Hebrew refusal.
 * A pre-check in front of the Apps Script round trip (Code.gs stays the
 * authority): it REFUSES — it never truncates — and it names lengths only, so
 * no report text ever reaches a response body or the write log. Pure. */
function meetingReportNoteError(note) {
  const len = String(note == null ? '' : note).length;
  return len > MANAGER_REPORT_MAX_CHARS
    ? `הפירוט מוגבל ל-${MANAGER_REPORT_MAX_CHARS} תווים (נשלחו ${len})`
    : '';
}

/* POST /api/meeting-report/submit — forward the report to Apps Script with the
 * shared secret attached server-side. Validation is authoritative on the Apps
 * Script side (submitMeetingReport_); the browser only ever sees ok/error. */
app.post('/api/meeting-report/submit', requireMeetingReportSession, requireProxySecret, async (req, res) => {
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
  const noteError = meetingReportNoteError(report.note);
  if (noteError) {
    recordWrite({
      at: new Date().toISOString(),
      route: '/api/meeting-report/submit',
      action: 'submitMeetingReport',
      auth: 'ok',
      httpStatus: 400,
      okFromBackend: false,
      error: 'bad_note',
      noteLength: report.note.length,   // length only — never the text
    });
    return res.status(400).json({ ok: false, error: 'bad_note', message: noteError });
  }
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
    sendAppsScriptJson(res, data);
  } catch (err) {
    console.error('[meeting-report submit] error:', safeErrorMessage(err));
    recordWrite({
      at: new Date().toISOString(),
      route: '/api/meeting-report/submit',
      action: 'submitMeetingReport',
      auth: 'ok',
      httpStatus: 502,
      error: safeErrorMessage(err),
    });
    res.status(502).json({ ok: false, error: 'sheets_unreachable' });
  }
});

/* Deploy identity — which git commit / branch this process was built from.
 * Railway injects RAILWAY_GIT_COMMIT_SHA and RAILWAY_GIT_BRANCH at build time;
 * outside Railway (local, tests) both are blank and the fields are ''.
 * Pure: reads only the two named keys of the env it is given, so nothing else
 * from the environment (secrets included) can ever ride along. The commit is
 * accepted only as a 7–40 hex-char sha and the branch is trimmed and capped —
 * the values are echoed to an unauthenticated endpoint, so they are validated
 * rather than passed through. */
const DEPLOY_SHA_RE = /^[0-9a-f]{7,40}$/i;
const DEPLOY_BRANCH_MAX = 200;
function deployIdentity(env) {
  const e = env && typeof env === 'object' ? env : {};
  const rawSha = e.RAILWAY_GIT_COMMIT_SHA == null ? '' : String(e.RAILWAY_GIT_COMMIT_SHA).trim();
  const rawBranch = e.RAILWAY_GIT_BRANCH == null ? '' : String(e.RAILWAY_GIT_BRANCH).trim();
  return {
    commit: DEPLOY_SHA_RE.test(rawSha) ? rawSha.toLowerCase() : '',
    branch: rawBranch.slice(0, DEPLOY_BRANCH_MAX),
  };
}

/* /healthz body. `ok` is unchanged (Railway's healthcheck and the helpdesk
 * monitor key on it); `commit` / `branch` answer "is Railway running the
 * latest deploy branch?" from a browser — the known Redeploy-doesn't-pull
 * quirk was otherwise unverifiable from outside (issue #120 investigation).
 * `build` is the per-process BUILD_ID already embedded in the served HTML, so
 * a restart is visible without a redeploy. No secret is ever part of this. */
function healthzBody(env) {
  const id = deployIdentity(env || process.env);
  return { ok: true, commit: id.commit, branch: id.branch, build: BUILD_ID };
}

app.get('/healthz', (_, res) => res.json(healthzBody()));

/* ===== GET /api/healthcheck — the weekly healthcheck's data probe (PR C) =====
 *
 *   GET /api/healthcheck?action=getData
 *   Authorization: Bearer <HEALTHCHECK_TOKEN>
 *
 * READ-ONLY: the only action is getData (absent = getData; anything else →
 * 400 bad_action). It is proxied with NO principal (no user, no role, no
 * capability), so Code.gs and viewFilteredResponse both serve the RESTRICTED
 * getData — never billingOverrides, never a write.
 *
 * NO SESSION: it never sets or reads a cookie, and the token opens nothing
 * else (every other route still needs a personal session).
 *
 * The token is compared in constant time (lib/pin.js checkPin: both sides
 * SHA-256'd, timingSafeEqual). Rate limit: 10 calls per IP and 20 in total
 * per 15 minutes, counted on EVERY call before the token is looked at (the
 * job makes one call a week). The token is never logged: the request logger
 * prints the path only, and nothing here prints a header.
 *
 * Responses: 200 getData JSON; 400 bad_action; 401 unauthorized (missing or
 * wrong token, with WWW-Authenticate: Bearer); 404 healthcheck_disabled (no
 * token configured, or shorter than 32); 429 rate_limited; 503
 * proxy_not_configured; 502 sheets_unreachable. Cache-Control: no-store. */
const HEALTHCHECK_LIMIT = { max: 10, windowMs: 15 * 60 * 1000 };
const healthcheckAttempts = new WindowCounter(HEALTHCHECK_LIMIT);
const healthcheckGlobal = new WindowCounter({ max: 20, windowMs: 15 * 60 * 1000 });

/* The bearer token of an Authorization header, '' when absent or malformed.
 * Pure. */
function bearerToken(header) {
  if (typeof header !== 'string') return '';
  const m = /^Bearer[ ]+([\x21-\x7e]+)$/.exec(header.trim());
  return m ? m[1] : '';
}

/* Whether `header` carries the configured token. Fail-closed: no token (or a
 * short one) configured → false, whatever is sent. Constant-time. */
function healthcheckAuthorized(header, configured) {
  const want = configured === undefined ? HEALTHCHECK_TOKEN : configured;
  if (typeof want !== 'string' || want.length < HEALTHCHECK_TOKEN_MIN_LEN) return false;
  return checkPin(bearerToken(header), want);
}

app.get('/api/healthcheck', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (HEALTHCHECK_TOKEN.length < HEALTHCHECK_TOKEN_MIN_LEN) {
    return res.status(404).json({ ok: false, error: 'healthcheck_disabled' });
  }
  const ip = pinClientIp(req);
  if (sendRateLimited(res, healthcheckGlobal.check('*'))) return undefined;
  if (sendRateLimited(res, healthcheckAttempts.check(ip))) return undefined;
  healthcheckGlobal.fail('*');
  healthcheckAttempts.fail(ip);

  if (!healthcheckAuthorized(req.headers.authorization)) {
    console.warn('[healthcheck] 401');
    res.set('WWW-Authenticate', 'Bearer');
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  const action = req.query && req.query.action !== undefined ? req.query.action : 'getData';
  if (action !== 'getData') return res.status(400).json({ ok: false, error: 'bad_action' });
  if (!PROXY_SECRET) return res.status(503).json({ ok: false, error: PROXY_NOT_CONFIGURED });
  try {
    const data = viewFilteredResponse('getData', await sheetsPost({ action: 'getData', user: '' }, NO_PRINCIPAL), null);
    console.log('[healthcheck] ok');
    return sendAppsScriptJson(res, data);
  } catch (err) {
    console.error('[healthcheck] error:', safeErrorMessage(err));
    return res.status(502).json({ ok: false, error: 'sheets_unreachable' });
  }
});

/* 404 fallback — logs and returns JSON so an unexpected request (e.g.
 * Sandra typing a stray URL) is visible in the logs. */
app.use((req, res) => {
  console.log(`[req] 404 for ${req.method} ${req.path}`);
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
  // Proxy secret, Phase 0b-1 (see test/proxy-secret-transition.test.js).
  app,
  PROXY_NOT_CONFIGURED,
  readParamsToBody,
  buildAppsScriptBody,
  sheetsGet,
  sheetsPost,
  requireProxySecret,
  safeErrorMessage,
  // «ייצוא זיכויים לאקסל» .xlsx (see test/xlsx-export.test.js).
  refundForecastXlsxHandler,
  // «חובות פתוחים» .xlsx (see test/debt-aging-ui.test.js).
  debtAgingXlsxHandler,
  validateDebtAgingExportQuery,
  // «ייצוא רשימת תיקונים» .xlsx (see test/cleanup-workbook.test.js).
  cleanupXlsxHandler,
  // Deploy identity on /healthz (see test/healthz-deploy-identity.test.js).
  deployIdentity,
  healthzBody,
  buildLoadPreviews,
  followingRequest,
  parseSessionCookie,
  sessionAuthStatus,
  requireSession,
  buildSessionCookie,
  requestIsHttps,
  // Who/when stamping (see test/patient-who-when.test.js).
  sessionUserFromRequest,
  // Personal PINs — foundation (see test/personal-pins-foundation.test.js).
  TRUST_PROXY_HOPS,
  trustProxyHops,
  pinClientIp,
  pinAttempts,
  pinLockout,
  mrPinAttempts,
  // Personal PINs — login (see test/personal-pins-login.test.js).
  currentPrincipal,
  isApproverPrincipal,
  pinAdminUsers,
  pinAdminAttempts,
  pinAdminGlobal,
  // Restricted view (see test/restricted-view.test.js).
  requireFinanceForAction,
  requireFinance,
  // Roles + healthcheck (see test/personal-pins-cleanup.test.js).
  requireRoleForAction,
  bearerToken,
  healthcheckAuthorized,
  healthcheckAttempts,
  healthcheckGlobal,
  viewFilteredResponse,
  FINANCE_ACTIONS,
  FINANCE_ROUTES,
  // «בקרת גבייה» (see test/billing-control-tab.test.js).
  controllerRouteLock,
  requireBillingControlForAction,
  requireBillingControl,
  requireFinanceOrController,
  billingControlXlsxHandler,
  BILLING_CONTROL_ACTIONS,
  CONTROLLER_ACTIONS,
  CONTROLLER_ROUTES,
  bootstrapState,
  sessionPrincipalFromRequest,
  NO_PRINCIPAL,
  USER_REGISTRY,
  // Meeting-report micro-app (see test/meeting-report-server.test.js).
  parseMeetingReportCookie,
  mrSessionAuthStatus,
  requireMeetingReportSession,
  buildMeetingReportCookie,
  handleMeetingReportPage,
  MANAGER_REPORT_MAX_CHARS,
  meetingReportNoteError,
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
