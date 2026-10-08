'use strict';
/* Static-asset delivery: per-file content hashes + compression.
 *
 * Why (CHANGELOG-dashboard-perf.md): every page load re-downloaded ~770 KB of
 * UNCOMPRESSED JS/CSS (app.js alone is 628 KB) because every response is
 * `no-store` and nothing was compressed. This module gives each file:
 *   - `hash`  — the first 12 hex chars of its sha256. index.html references
 *               `app.js?v=<hash>`, so the URL changes exactly when the bytes
 *               do (a new deploy that leaves style.css alone keeps its URL);
 *   - `br` / `gzip` — compressed once per content version, not per request.
 *
 * A request whose `v` equals the CURRENT hash may be cached forever
 * (`immutable`): those bytes can never change under that URL. Any other
 * request (no `v`, an old hash, the old BUILD_ID) keeps the no-store
 * headers it always had — an old hash never pins old bytes, it just gets the
 * current file uncached.
 *
 * No new dependency: node:zlib + node:crypto only. */

const fs = require('fs');
const crypto = require('crypto');
const zlib = require('zlib');

const HASH_LEN = 12;
const HASH_RE = /^[0-9a-f]{12}$/;
/* Below this, compression costs more than it saves. */
const MIN_COMPRESS_BYTES = 1024;

function contentHash(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex').slice(0, HASH_LEN);
}

/* 'br' | 'gzip' | null from an Accept-Encoding header. Honors an explicit
 * q=0 refusal; otherwise prefers br. Pure. */
function negotiateEncoding(header) {
  const accepted = {};
  String(header || '').split(',').forEach((part) => {
    const [name, ...params] = part.trim().toLowerCase().split(';');
    if (!name) return;
    let q = 1;
    params.forEach((p) => {
      const m = /^\s*q=([0-9.]+)\s*$/.exec(p);
      if (m) q = Number(m[1]);
    });
    accepted[name] = q > 0;
  });
  if (accepted.br) return 'br';
  if (accepted.gzip) return 'gzip';
  return null;
}

/* A store over a fixed table { urlPath: { file, mime } }. `get(urlPath)`
 * re-stats the file on every call (cheap) and rebuilds the entry only when
 * size or mtime changed — the same "a hot redeploy is picked up at once"
 * guarantee the old readFileSync-per-request serving gave. */
function createAssetStore(table) {
  const memo = new Map();
  function get(urlPath) {
    const spec = table[urlPath];
    if (!spec) return null;
    let st;
    try { st = fs.statSync(spec.file); } catch (_) { return null; }
    const stamp = st.size + ':' + st.mtimeMs;
    const hit = memo.get(urlPath);
    if (hit && hit.stamp === stamp) return hit;
    const body = fs.readFileSync(spec.file);
    const big = body.length >= MIN_COMPRESS_BYTES;
    const entry = {
      stamp,
      mime: spec.mime,
      body,
      hash: contentHash(body),
      // Once per content version. br q9: ~65 ms for app.js, within 9% of q11
      // (which costs ~1.1 s of blocked event loop).
      gzip: big ? zlib.gzipSync(body, { level: 9 }) : null,
      br: big ? zlib.brotliCompressSync(body, {
        params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: body.length },
      }) : null,
    };
    memo.set(urlPath, entry);
    return entry;
  }
  return { get, paths: () => Object.keys(table) };
}

/* index.html → every known asset reference carries its own content hash:
 *   src="app.js?v=__BUILD__"  → src="app.js?v=<hash>"
 *   href="style.css"          → href="style.css?v=<hash>"
 * Run BEFORE the global __BUILD__ substitution, so the <meta name="build">
 * marker keeps the BUILD_ID. An asset the store cannot read keeps the old
 * BUILD_ID cache-bust (never a broken URL). Pure apart from store.get. */
function versionAssetRefs(html, store) {
  let out = html;
  store.paths().forEach((urlPath) => {
    const entry = store.get(urlPath);
    if (!entry) return;
    const name = urlPath.replace(/^\//, '');
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp('((?:src|href)=")/?(' + esc + ')(?:\\?v=__BUILD__)?(")', 'g');
    out = out.replace(re, (_m, pre, file, post) => pre + file + '?v=' + entry.hash + post);
  });
  return out;
}

/* True when the request names the file's CURRENT hash. */
function isCurrentVersion(v, entry) {
  return typeof v === 'string' && HASH_RE.test(v) && !!entry && v === entry.hash;
}

/* Long-lived caching for a hashed URL. Replaces every no-store header the
 * global middleware set (removing them, not adding conflicting ones). */
function immutableHeaders(res) {
  ['Pragma', 'Expires', 'Surrogate-Control', 'CDN-Cache-Control', 'Cloudflare-CDN-Cache-Control']
    .forEach((h) => res.removeHeader(h));
  res.set('Cache-Control', 'public, max-age=31536000, immutable');
}

/* Send a precompressed asset entry, choosing the encoding from the request. */
function sendAsset(req, res, entry) {
  res.type(entry.mime);
  res.append('Vary', 'Accept-Encoding');
  const enc = negotiateEncoding(req.headers['accept-encoding']);
  const buf = enc && entry[enc];
  if (buf) {
    res.set('Content-Encoding', enc);
    return res.send(buf);
  }
  return res.send(entry.body);
}

/* Compress a per-request body. br q4 / gzip 6: ~15 ms for 600 KB. */
function compressText(buf, enc) {
  if (enc === 'br') {
    return zlib.brotliCompressSync(buf, {
      params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buf.length },
    });
  }
  return zlib.gzipSync(buf, { level: 6 });
}

/* Send a per-request body (index.html, an Apps Script JSON answer)
 * compressed when the client accepts it and it is worth it. The caller sets
 * the Content-Type first. */
function sendCompressedText(req, res, text) {
  res.append('Vary', 'Accept-Encoding');
  const buf = Buffer.from(String(text), 'utf8');
  const enc = buf.length >= MIN_COMPRESS_BYTES ? negotiateEncoding(req && req.headers && req.headers['accept-encoding']) : null;
  if (enc) {
    res.set('Content-Encoding', enc);
    return res.send(compressText(buf, enc));
  }
  return res.send(buf);
}

module.exports = {
  HASH_LEN, MIN_COMPRESS_BYTES,
  contentHash, negotiateEncoding, createAssetStore, versionAssetRefs,
  isCurrentVersion, immutableHeaders, sendAsset, sendCompressedText,
};
