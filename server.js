const express = require('express');
const path = require('path');
const fs = require('fs');
const https = require('https');
const { URL } = require('url');
const { checkPin } = require('./lib/pin');

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

const BUILD_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const SERVER_STARTED_AT = new Date().toISOString();

app.use(express.json({ limit: '10mb' }));

/* Apply no-cache headers to every response before any handler runs. */
app.use((_req, res, next) => { noCache(res); next(); });

/* Catch-all request logger — confirms what URLs the server actually
 * receives. Registered before any route so every request is counted.
 * Keep a rolling list of the last 20 requests for quick debugging. */
const allHits = { total: 0, byPath: {}, recent: [] };
app.use((req, _res, next) => {
  allHits.total++;
  const bucket = req.method + ' ' + req.path;
  allHits.byPath[bucket] = (allHits.byPath[bucket] || 0) + 1;
  const entry = {
    at: new Date().toISOString(),
    method: req.method,
    url: req.originalUrl,
    ua: (req.headers['user-agent'] || '').slice(0, 120),
    xfwd: req.headers['x-forwarded-for'] || null,
    host: req.headers['host'] || null,
  };
  allHits.recent.push(entry);
  if (allHits.recent.length > 20) allHits.recent.shift();
  console.log(`[req] ${req.method} ${req.originalUrl} host=${req.headers.host} xfwd=${req.headers['x-forwarded-host'] || '-'}`);
  next();
});

/* Route hit counter — same idea but scoped to /api/sheets so we can
 * tell that route apart from /api/debug/* and static requests. */
const routeHits = { 'GET /api/sheets': 0, 'POST /api/sheets': 0, started: SERVER_STARTED_AT };
app.use('/api/sheets', (req, _res, next) => {
  const key = `${req.method} /api/sheets`;
  routeHits[key] = (routeHits[key] || 0) + 1;
  next();
});
app.get('/api/debug/routes', (_req, res) => res.json({ routeHits, allHits }));
app.get('/api/debug/env', (req, res) => res.json({
  buildId: BUILD_ID,
  startedAt: SERVER_STARTED_AT,
  uptimeSeconds: Math.round(process.uptime()),
  node: process.version,
  pid: process.pid,
  seenHost: req.headers.host,
  seenXForwardedHost: req.headers['x-forwarded-host'] || null,
  railwayStaticUrl: process.env.RAILWAY_STATIC_URL || null,
  railwayServiceName: process.env.RAILWAY_SERVICE_NAME || null,
}));

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

/* GET /api/sheets?action=getData — forwarded as GET to Apps Script */
app.get('/api/sheets', async (req, res) => {
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
app.post('/api/sheets', async (req, res) => {
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
    res.json(data);
  } catch (err) {
    console.error('[sheets POST] error:', err.message);
    lastSave = {
      at: new Date().toISOString(),
      request: { summary, keys: Object.keys(body) },
      error: err.message,
    };
    res.status(502).json({ ok: false, error: 'sheets_unreachable', message: err.message });
  }
});

/* Diagnostics — last save and last load, browsable from the live URL. */
app.get('/api/debug/last-save', (_req, res) => {
  res.json(lastSave || { empty: true });
});
app.get('/api/debug/last-load', (_req, res) => {
  res.json(lastLoad || { empty: true });
});

/* POST /api/outpatient-lead — browser sends { name, phone, house, note }; we
 * inject the shared secret from Railway env (never exposed to the client) and
 * forward to the Outpatient app's createLead endpoint. Fail-closed: if the URL
 * or secret isn't configured, refuse without calling out. The Dashboard treats
 * any non-2xx / { ok:false } here as a NON-FATAL warning — the discharge has
 * already succeeded locally. The secret is never logged. */
app.post('/api/outpatient-lead', async (req, res) => {
  if (!OUTPATIENT_LEAD_URL || !OUTPATIENT_LEAD_SECRET) {
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
    res.json(data);
  } catch (err) {
    console.error('[outpatient-lead] error:', err.message);
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
    return res.status(200).json({ ok: true });
  }

  rec.count++;
  return res.status(401).json({ ok: false, error: 'invalid_pin' });
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

module.exports = { buildLoadPreviews };
