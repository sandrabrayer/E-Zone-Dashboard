'use strict';
// Synthetic Sheets services for the real Dashboard backup helper. Not native
// Google proof. Model text-format/apostrophe input, types and interrupted RPCs.
const assert = require('node:assert/strict');
const { richSheet } = require('./gs-sandbox');
function backupWorkbook(faults = {}) {
  const sheets = Object.create(null), events = [];
  const book = {
    sheets, events, faults, getId: () => 'synthetic-backup',
    getSheets: () => Object.values(sheets),
    getSheetByName: name => sheets[name] || null,
    insertSheet(name) {
      assert.ok(!sheets[name], 'duplicate sheet name');
      const sh = richSheet(name, []), range = sh.getRange;
      let rows = 1000, cols = 50, formats = [], formulas = [];
      sh.getName = () => name;
      sh.getMaxRows = () => rows; sh.getMaxColumns = () => cols;
      sh.insertRowsAfter = (_, n) => { rows += n; }; sh.insertColumnsAfter = (_, n) => { cols += n; };
      sh.deleteRows = (_, n) => { rows -= n; }; sh.deleteColumns = (_, n) => { cols -= n; };
      sh.clear = () => { events.push(['clear', name]); sh.grid.length = 0; return sh; };
      sh.setName = next => {
        events.push(['rename', name, next]);
        if (faults.publish && name.startsWith('dashboard-pending-') && /^dashboard-(tasks|activity|patients|leads)-/.test(next)) throw Error('publish interrupted');
        assert.ok(!sheets[next], 'duplicate rename'); delete sheets[name]; name = next; sheets[name] = sh; return sh;
      };
      sh.getRange = (...args) => {
        const r = range(...args), write = r.setValues, read = r.getValues;
        r.setNumberFormats = values => { formats = values; return r; };
        r.setValues = values => {
          events.push(['write', name]);
          if (faults.write) throw Error('write interrupted');
          formulas = values.map(row => row.map(() => ''));
          const parsed = values.map((row, i) => row.map((v, j) => {
            if (typeof v !== 'string') return v;
            if (v.startsWith("'")) return v.slice(1);
            if (v.startsWith('=') && formats[i]?.[j] !== '@') { formulas[i][j] = v; return 2; }
            return v;
          }));
          write(parsed);
          if (faults.afterWrite) throw Error('write reply lost');
          return r;
        };
        r.getValues = () => { const out = read(); if (faults.corrupt && name.startsWith('dashboard-pending-')) out[0][0] = 'corrupted'; return out; };
        r.getFormulas = () => faults.formula ? [['=1+1']] : formulas;
        return r;
      };
      sh.getDataRange = () => sh.getRange(1, 1, sh.getLastRow(), sh.getLastColumn());
      sheets[name] = sh; events.push(['insert', name]); return sh;
    },
    deleteSheet(sh) { events.push(['delete', sh.getName()]); if (faults.cleanup) throw Error('cleanup failed'); delete sheets[sh.getName()]; }
  };
  return book;
}
function installBackupServices(g, book) {
  let held = false, uuid = 0;
  g.sandbox.Date = Date;
  g.sandbox.SpreadsheetApp.flush = () => {};
  g.sandbox.SpreadsheetApp.openById = () => book;
  g.sandbox.Utilities.getUuid = () => 'synthetic-' + (++uuid);
  g.sandbox.LockService.getUserLock = () => ({
    tryLock: () => book.faults.lock || held ? false : (held = true),
    releaseLock: () => { held = false; }
  });
  return () => held;
}
module.exports = { backupWorkbook, installBackupServices };
