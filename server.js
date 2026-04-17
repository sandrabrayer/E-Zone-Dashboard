const express = require('express');
const path = require('path');
const https = require('https');
const { URL } = require('url');

const app = express();
const PORT = process.env.PORT || 3000;

const SHEETS_URL = 'https://script.google.com/macros/s/AKfycbyScn2vcaOb_YCiTIRw-I-NugkZ4Zbt0hY5LgrM5D-WroSy-iuNhb9ewxoGcyZW63fsBw/exec';

app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

/**
 * Build a GET URL against the Apps Script and return the parsed JSON.
 * Handles Google's 302 redirect to googleusercontent.com.
 */
function fetchSheets(params) {
  return new Promise((resolve, reject) => {
    const url = new URL(SHEETS_URL);
    Object.entries(params || {}).forEach(([k, v]) => {
      if (v === undefined || v === null) return;
      const str = typeof v === 'object' ? JSON.stringify(v) : String(v);
      url.searchParams.append(k, str);
    });

    const doRequest = (targetUrl, redirects = 0) => {
      if (redirects > 5) return reject(new Error('Too many redirects'));
      https
        .get(targetUrl, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            return doRequest(res.headers.location, redirects + 1);
          }
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => {
            if (res.statusCode < 200 || res.statusCode >= 300) {
              return reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
            }
            try {
              resolve(JSON.parse(data));
            } catch (e) {
              reject(new Error('Invalid JSON from Apps Script: ' + data.slice(0, 200)));
            }
          });
        })
        .on('error', reject);
    };

    doRequest(url.toString());
  });
}

/* GET /api/sheets?action=getData  — read-only pass-through */
app.get('/api/sheets', async (req, res) => {
  try {
    const data = await fetchSheets(req.query);
    res.json(data);
  } catch (err) {
    console.error('Sheets GET error:', err.message);
    res.status(502).json({ ok: false, error: 'sheets_unreachable', message: err.message });
  }
});

/* POST /api/sheets  — used for saveAll; body is converted into GET params */
app.post('/api/sheets', async (req, res) => {
  try {
    const body = req.body || {};
    const data = await fetchSheets(body);
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
