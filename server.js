const express = require('express');
const path = require('path');
const https = require('https');
const { URL } = require('url');

const app = express();
const PORT = process.env.PORT || 3000;

const SHEETS_URL = 'https://script.google.com/macros/s/AKfycbyScn2vcaOb_YCiTIRw-I-NugkZ4Zbt0hY5LgrM5D-WroSy-iuNhb9ewxoGcyZW63fsBw/exec';

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

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

/* GET /api/sheets?action=getData — forwarded as GET to Apps Script */
app.get('/api/sheets', async (req, res) => {
  try {
    const data = await sheetsGet(req.query);
    res.json(data);
  } catch (err) {
    console.error('Sheets GET error:', err.message);
    res.status(502).json({ ok: false, error: 'sheets_unreachable', message: err.message });
  }
});

/* POST /api/sheets — body is forwarded as POST application/json to Apps Script.
 * All save operations (saveAll, etc.) use POST so the data never hits the
 * querystring length limit. */
app.post('/api/sheets', async (req, res) => {
  try {
    const data = await sheetsPost(req.body || {});
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
