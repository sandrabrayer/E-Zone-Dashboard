const express = require('express');
const path = require('path');
const https = require('https');
const { URL } = require('url');

const app = express();
const PORT = process.env.PORT || 3000;

const SHEETS_URL = 'https://script.google.com/macros/s/AKfycbyScn2vcaOb_YCiTIRw-I-NugkZ4Zbt0hY5LgrM5D-WroSy-iuNhb9ewxoGcyZW63fsBw/exec';

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

/**
 * Call the Apps Script. GET for reads (small payload fits in querystring),
 * POST with a JSON body for writes (large payloads that would overflow the URL).
 * Google Apps Script responds to /exec with a 302 to googleusercontent.com;
 * we follow the redirect with GET regardless of the original method — that's
 * the documented Apps Script behavior and what every client library does.
 */
function fetchSheets({ method = 'GET', params = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const url = new URL(SHEETS_URL);
    Object.entries(params || {}).forEach(([k, v]) => {
      if (v === undefined || v === null) return;
      const str = typeof v === 'object' ? JSON.stringify(v) : String(v);
      url.searchParams.append(k, str);
    });

    const payload = body == null ? null
      : (typeof body === 'string' ? body : JSON.stringify(body));

    const dispatch = (targetUrl, opts, data, redirects) => {
      if (redirects > 5) return reject(new Error('Too many redirects'));
      const req = https.request(targetUrl, opts, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          // Follow redirect as GET (standard after POST → 302)
          res.resume();
          return dispatch(res.headers.location, { method: 'GET' }, null, redirects + 1);
        }
        let chunks = '';
        res.on('data', c => chunks += c);
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(new Error(`Apps Script HTTP ${res.statusCode}: ${chunks.slice(0, 400)}`));
          }
          try { resolve(JSON.parse(chunks)); }
          catch (e) { reject(new Error('Invalid JSON from Apps Script: ' + chunks.slice(0, 400))); }
        });
      });
      req.on('error', reject);
      if (data) req.write(data);
      req.end();
    };

    const opts = { method };
    if (payload) {
      opts.headers = {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      };
    }
    dispatch(url.toString(), opts, payload, 0);
  });
}

/* GET /api/sheets?action=getData — small read, forwarded as GET */
app.get('/api/sheets', async (req, res) => {
  try {
    const data = await fetchSheets({ method: 'GET', params: req.query });
    res.json(data);
  } catch (err) {
    console.error('Sheets GET error:', err.message);
    res.status(502).json({ ok: false, error: 'sheets_unreachable', message: err.message });
  }
});

/* POST /api/sheets — body is forwarded to Apps Script as POST with JSON body.
 * `action` is also mirrored into the query string so the Apps Script doPost
 * can route via e.parameter.action without parsing the body if it prefers.
 */
app.post('/api/sheets', async (req, res) => {
  try {
    const body = req.body || {};
    const params = {};
    if (body.action) params.action = body.action;
    const data = await fetchSheets({ method: 'POST', params, body });
    res.json(data);
  } catch (err) {
    console.error('Sheets POST error:', err.message);
    res.status(502).json({ ok: false, error: 'sheets_unreachable', message: err.message });
  }
});

app.get('/healthz', (_, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`E-ZONE Dashboard running on port ${PORT}`);
});
