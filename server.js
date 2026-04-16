const express = require('express');
const path = require('path');
const https = require('https');
const { URL } = require('url');

const app = express();
const PORT = process.env.PORT || 3000;

const SHEETS_URL = 'https://script.google.com/macros/s/AKfycbyScn2vcaOb_YCiTIRw-I-NugkZ4Zbt0hY5LgrM5D-WroSy-iuNhb9ewxoGcyZW63fsBw/exec';

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function fetchSheets(query) {
  return new Promise((resolve, reject) => {
    const url = new URL(SHEETS_URL);
    Object.entries(query).forEach(([k, v]) => {
      if (v !== undefined && v !== null) url.searchParams.append(k, String(v));
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
            try {
              resolve(JSON.parse(data));
            } catch (e) {
              reject(new Error('Invalid JSON from Sheets: ' + data.slice(0, 200)));
            }
          });
        })
        .on('error', reject);
    };

    doRequest(url.toString());
  });
}

app.get('/api/sheets', async (req, res) => {
  try {
    const data = await fetchSheets(req.query);
    res.json(data);
  } catch (err) {
    console.error('Sheets error:', err.message);
    res.status(502).json({ error: 'sheets_unreachable', message: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`E-ZONE Dashboard running at http://localhost:${PORT}`);
});
