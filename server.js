const express = require('express');
const path = require('path');
const fs = require('fs');
const https = require('https');
const { URL } = require('url');

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

const SHEETS_URL = 'https://script.google.com/macros/s/AKfycbyScn2vcaOb_YCiTIRw-I-NugkZ4Zbt0hY5LgrM5D-WroSy-iuNhb9ewxoGcyZW63fsBw/exec';

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
  console.log(`[req] ${req.method} ${req.originalUrl}`);
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
app.get('/api/debug/env', (_req, res) => res.json({
  buildId: BUILD_ID,
  startedAt: SERVER_STARTED_AT,
  uptimeSeconds: Math.round(process.uptime()),
  node: process.version,
  pid: process.pid,
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
      patientsPreview: data && typeof data === 'object'
        ? JSON.stringify(data.patients).slice(0, 4000)
        : null,
      leadsPreview: data && typeof data === 'object'
        ? JSON.stringify(data.leads).slice(0, 1500)
        : null,
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

app.get('/healthz', (_, res) => res.json({ ok: true }));

/* 404 fallback — logs and returns JSON so an unexpected request (e.g.
 * Sandra typing a stray URL) is visible in the logs. */
app.use((req, res) => {
  console.log(`[req] 404 for ${req.method} ${req.originalUrl}`);
  res.status(404).json({ error: 'not_found', method: req.method, url: req.originalUrl });
});

app.listen(PORT, () => {
  console.log(`E-ZONE Dashboard running on port ${PORT} build ${BUILD_ID}`);
});
