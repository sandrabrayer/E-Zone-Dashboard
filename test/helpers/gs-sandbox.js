'use strict';

/* Test helper (not a test): the REAL apps-script/Code.gs in a vm sandbox with
 * an in-memory spreadsheet — the same harness test/restricted-view.test.js
 * uses, shared for test/personal-pins-cleanup.test.js. node --test also loads
 * this file; it defines no test. */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const GS_SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'apps-script', 'Code.gs'), 'utf8');

function richSheet(name, headerRow) {
  const grid = headerRow && headerRow.length ? [headerRow.slice()] : [];
  let hidden = false;
  const sh = {
    grid,
    getName: () => name,
    getLastRow() {
      let n = grid.length;
      while (n > 0 && (grid[n - 1] || []).every((v) => v === '' || v === undefined || v === null)) n--;
      return n;
    },
    getLastColumn() { return grid[0] ? grid[0].length : 0; },
    getMaxRows() { return Math.max(grid.length, 1000); },
    getMaxColumns() { return 50; },
    setFrozenRows() {},
    hideSheet() { hidden = true; },
    isSheetHidden() { return hidden; },
    appendRow(row) { grid.splice(sh.getLastRow(), 0, row.slice()); },
    getRange(r, c, nr, nc) {
      nr = nr || 1; nc = nc || 1;
      return {
        setNumberFormat() { return this; },
        getValues() {
          const out = [];
          for (let i = 0; i < nr; i++) {
            const row = [];
            for (let j = 0; j < nc; j++) { const g = grid[r - 1 + i]; const v = g ? g[c - 1 + j] : ''; row.push(v === undefined ? '' : v); }
            out.push(row);
          }
          return out;
        },
        getValue() { const g = grid[r - 1]; return g && g[c - 1] !== undefined ? g[c - 1] : ''; },
        setValue(v) { if (!grid[r - 1]) grid[r - 1] = []; grid[r - 1][c - 1] = v; return this; },
        setValues(vals) {
          for (let i = 0; i < vals.length; i++) {
            if (!grid[r - 1 + i]) grid[r - 1 + i] = [];
            for (let j = 0; j < vals[i].length; j++) grid[r - 1 + i][c - 1 + j] = vals[i][j];
          }
          return this;
        },
        clearContent() {
          for (let i = 0; i < nr; i++) {
            const g = grid[r - 1 + i];
            if (g) for (let j = 0; j < nc; j++) g[c - 1 + j] = '';
          }
          return this;
        },
      };
    },
  };
  return sh;
}

function loadGs(opts) {
  const o = opts || {};
  const logs = [];
  const capture = (...a) => logs.push(a.map(String).join(' '));
  const sandbox = {
    console: { log: capture, warn: capture, error: capture, info: capture },
    Logger: { log: capture },
    __sheets: {},
    __props: Object.assign({}, o.props || {}),
    __cache: {},
  };
  sandbox.SpreadsheetApp = {
    getActiveSpreadsheet: () => ({
      getSheetByName: (n) => sandbox.__sheets[n] || null,
      insertSheet: (n) => (sandbox.__sheets[n] = richSheet(n, [])),
      getSpreadsheetTimeZone: () => 'Asia/Jerusalem',
      getId: () => 'ss',
    }),
  };
  sandbox.PropertiesService = {
    getScriptProperties: () => ({
      getProperty: (k) => (k in sandbox.__props ? sandbox.__props[k] : null),
      setProperty: (k, v) => { sandbox.__props[k] = String(v); },
      deleteProperty: (k) => { delete sandbox.__props[k]; },
    }),
  };
  sandbox.CacheService = {
    getScriptCache: () => ({
      get: (k) => (k in sandbox.__cache ? sandbox.__cache[k] : null),
      put: (k, v) => { sandbox.__cache[k] = v; },
      remove: (k) => { delete sandbox.__cache[k]; },
    }),
  };
  sandbox.LockService = { getScriptLock: () => ({ tryLock: () => true, waitLock: () => {}, releaseLock: () => {} }) };
  sandbox.ContentService = {
    createTextOutput: (s) => ({ setMimeType: () => ({ json: JSON.parse(s), raw: s }) }),
    MimeType: { JSON: 'json' },
  };
  sandbox.Utilities = {
    getUuid: () => 'uuid-' + crypto.randomBytes(6).toString('hex'),
    formatDate: (d) => new Date(d).toISOString().slice(0, 10),
    computeDigest: () => [],
    DigestAlgorithm: {},
    Charset: {},
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(GS_SRC, sandbox);
  const calls = [];
  if (o.spyHandle) {
    sandbox.handle_ = (params) => {
      calls.push(params);
      return sandbox.jsonOut_({ ok: true, served: params.action });
    };
  }
  const post = (body) => sandbox.doPost({ parameter: {}, postData: { contents: JSON.stringify(body || {}) } }).json;
  const postQ = (body, query) => sandbox.doPost({ parameter: query || {}, postData: { contents: JSON.stringify(body || {}) } }).json;
  const run = (expr) => vm.runInContext(expr, sandbox);
  const sheetRows = (name, colsExpr) => {
    const sh = sandbox.__sheets[name];
    if (!sh) return [];
    const cols = Array.from(run(colsExpr));
    return sh.grid.slice(1).filter((r) => r.some((v) => v !== '' && v !== undefined)).map((r) => {
      const o2 = {};
      cols.forEach((c, i) => { o2[c] = r[i] === undefined ? '' : r[i]; });
      return o2;
    });
  };
  return { sandbox, calls, logs, post, postQ, run, sheetRows };
}

module.exports = { GS_SRC, richSheet, loadGs };
