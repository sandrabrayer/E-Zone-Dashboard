const express = require('express');
const path = require('path');
const https = require('https');
const { URL } = require('url');

const app = express();
const PORT = process.env.PORT || 3000;

const SHEETS_URL = 'https://script.google.com/macros/s/AKfycbyScn2vcaOb_YCiTIRw-I-NugkZ4Zbt0hY5LgrM5D-WroSy-iuNhb9ewxoGcyZW63fsBw/exec';

/* Google Apps Script web-app URL length limit is roughly 8 KB.
 * Budget everything past the base URL at this many chars for the
 * querystring portion; we split saveAll into multiple requests if we
 * exceed it. */
const MAX_QS_CHARS = 6000;

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

/* Build an encoded querystring from a params object; objects get JSON.stringify'd. */
function toQueryString(params) {
  const p = new URLSearchParams();
  Object.entries(params || {}).forEach(([k, v]) => {
    if (v === undefined || v === null) return;
    const str = typeof v === 'object' ? JSON.stringify(v) : String(v);
    p.append(k, str);
  });
  return p.toString();
}

/* GET against Apps Script; follows the 302 → googleusercontent.com redirect. */
function fetchSheetsGet(params) {
  return new Promise((resolve, reject) => {
    const url = new URL(SHEETS_URL);
    url.search = toQueryString(params);

    const get = (targetUrl, redirects = 0) => {
      if (redirects > 5) return reject(new Error('Too many redirects'));
      https
        .get(targetUrl, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume();
            return get(res.headers.location, redirects + 1);
          }
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => {
            if (res.statusCode < 200 || res.statusCode >= 300) {
              return reject(new Error(`Apps Script HTTP ${res.statusCode}: ${data.slice(0, 300)}`));
            }
            try {
              resolve(JSON.parse(data));
            } catch (_) {
              reject(new Error('Invalid JSON from Apps Script: ' + data.slice(0, 300)));
            }
          });
        })
        .on('error', reject);
    };

    get(url.toString());
  });
}

/* Save the full dataset. If the single GET would overflow the URL limit,
 * split into: one call for leads (empty patients), then one call per house
 * for that house's patients. Each call still uses action=saveAll so the
 * Apps Script's existing handler can upsert per-section without clobbering
 * other sections. */
async function saveSplit(leads, patients) {
  const safeLeads = Array.isArray(leads) ? leads : [];
  const safePatients = patients && typeof patients === 'object' ? patients : {};

  const singleParams = { action: 'saveAll', leads: safeLeads, patients: safePatients };
  if (toQueryString(singleParams).length <= MAX_QS_CHARS) {
    return fetchSheetsGet(singleParams);
  }

  // 1) Leads only
  const leadsParams = { action: 'saveAll', leads: safeLeads, patients: {} };
  if (toQueryString(leadsParams).length > MAX_QS_CHARS) {
    throw new Error('Leads payload exceeds URL limit; further splitting not implemented');
  }
  await fetchSheetsGet(leadsParams);

  // 2) Each house's patients in its own call (empty leads so we don't overwrite)
  const houseIds = Object.keys(safePatients);
  for (const houseId of houseIds) {
    const chunk = { [houseId]: safePatients[houseId] || [] };
    const houseParams = { action: 'saveAll', leads: [], patients: chunk };
    if (toQueryString(houseParams).length > MAX_QS_CHARS) {
      throw new Error(`Patients for house "${houseId}" exceed URL limit; further splitting not implemented`);
    }
    await fetchSheetsGet(houseParams);
  }

  return { ok: true, split: true, chunks: houseIds.length + 1 };
}

/* GET /api/sheets?action=getData — direct pass-through */
app.get('/api/sheets', async (req, res) => {
  try {
    const data = await fetchSheetsGet(req.query);
    res.json(data);
  } catch (err) {
    console.error('Sheets GET error:', err.message);
    res.status(502).json({ ok: false, error: 'sheets_unreachable', message: err.message });
  }
});

/* POST /api/sheets — body is {action, leads, patients}; forwarded as one
 * or more GETs to Apps Script so Google's HTML-error issue with POST is
 * avoided entirely. */
app.post('/api/sheets', async (req, res) => {
  try {
    const { action, leads, patients, ...rest } = req.body || {};
    if (action === 'saveAll') {
      const data = await saveSplit(leads, patients);
      return res.json(data);
    }
    const data = await fetchSheetsGet({ action, ...rest });
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
