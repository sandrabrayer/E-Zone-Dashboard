'use strict';

// Consumer-only contract tests. The synthetic publisher below is intentionally
// independent of the production reader/hash helpers; it is not the real
// Coordinators publisher or a claim of paired production acceptance.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { loadGs, richSheet } = require('./helpers/gs-sandbox');

const COLS = {
  ManagersShifts: ['house', 'date', 'shift', 'guideName', 'scheduleStatus', 'updatedAt'],
  ManagersStaff: ['house', 'name', 'kind', 'role', 'phone', 'onLeave', 'workdays', 'updatedAt', 'startDate'],
  ManagersTherapistWeek: ['house', 'dayOfWeek', 'time', 'therapistName', 'patientName', 'updatedAt'],
};
const TABLES = { shifts: 'ManagersShifts', staff: 'ManagersStaff', therapistWeek: 'ManagersTherapistWeek' };
const NOW = new Date().toISOString();
const TOKEN = 'ab'.repeat(32);
const clone = (v) => JSON.parse(JSON.stringify(v));

function digestGrid(grid) {
  const tagged = grid.map((row) => row.map((cell) => {
    if (cell == null) return ['s', ''];
    if (Object.prototype.toString.call(cell) === '[object Date]') {
      if (!Number.isFinite(cell.getTime())) throw new Error('invalid date fixture');
      return ['d', cell.toISOString()];
    }
    if (typeof cell === 'string') return ['s', cell];
    if (typeof cell === 'boolean') return ['b', cell];
    if (typeof cell === 'number' && Number.isFinite(cell)) return ['n', String(cell)];
    throw new Error('unsupported fixture cell');
  }));
  return crypto.createHash('sha256').update(JSON.stringify(tagged), 'utf8').digest('hex');
}

function workbook({ empty = false, optional = true } = {}) {
  const b = {};
  const rows = {
    ManagersShifts: [
      ['ramot-hashavim', '2026-11-20', 'בוקר', 'אבי', 'published', NOW],
      ['caesarea-ofroni', '2026-11-20', 'לילה', 'OTHER-HOUSE', 'draft', NOW],
    ],
    ManagersStaff: [
      ['ramot-hashavim', 'אבי', 'guide', 'מדריך', '0501234567', '', '0,2', NOW, '2026-10-01'],
      ['caesarea-ofroni', 'OTHER-HOUSE', 'guide', 'מדריך', '0521234567', '', '1', NOW, ''],
    ],
    ManagersTherapistWeek: [
      ['ramot-hashavim', '2', '10:00', 'דוקטור', 'מטופלת', NOW],
      ['caesarea-ofroni', '1', '11:00', 'OTHER-HOUSE', 'OTHER-PATIENT', NOW],
    ],
  };
  for (const [tab, cols] of Object.entries(COLS)) {
    b[tab] = richSheet(tab, optional ? cols : cols.filter((x) => x !== 'startDate'));
    if (!empty) b[tab].grid.push(...rows[tab].map((r) => r.slice(0, b[tab].grid[0].length)));
  }
  b.ManagersPublication = richSheet('ManagersPublication', []);
  return b;
}

function certify(b, changes = {}) {
  const manifest = {
    schema: 'managers-house-v1', state: 'ready',
    publicationId: 'publication_00000001', publishedAt: NOW,
    source: { revision: 2, token: TOKEN }, tables: {},
  };
  for (const [key, tab] of Object.entries(TABLES)) {
    const sh = b[tab];
    const grid = sh.getRange(1, 1, sh.getLastRow(), sh.getLastColumn()).getValues();
    manifest.tables[key] = { rows: grid.length - 1, columns: grid[0].length, sha256: digestGrid(grid) };
  }
  Object.assign(manifest, changes);
  b.ManagersPublication.grid[0] = [JSON.stringify(manifest)];
  return manifest;
}

function fixture(options = {}) {
  const b = workbook(options);
  const manifest = certify(b);
  const g = loadGs({ props: { MANAGERS_DIGEST_SHEET_ID: 'book-1', MANAGERS_DIGEST_REQUIRE_MANIFEST: 'true' } });
  const t = { g, book: b, manifest, books: { 'book-1': b }, manifestReads: 0, tableReads: [], opened: [], cacheWrites: [], afterTable: null, onManifest: null, onCacheGet: null };
  g.sandbox.Utilities.DigestAlgorithm.SHA_256 = 'SHA_256';
  g.sandbox.Utilities.Charset.UTF_8 = 'UTF_8';
  g.sandbox.Utilities.computeDigest = (alg, content, charset) => {
    assert.equal(alg, 'SHA_256');
    assert.equal(charset, 'UTF_8');
    return Array.from(crypto.createHash('sha256').update(content, 'utf8').digest(), (v) => v > 127 ? v - 256 : v);
  };
  g.sandbox.Session = { getScriptTimeZone: () => 'Asia/Jerusalem' };
  function instrument(book) {
    for (const [name, sh] of Object.entries(book)) {
      const original = sh.getRange.bind(sh);
      sh.getRange = (...args) => {
        const range = original(...args);
        if (name === 'ManagersPublication') {
          const getValue = range.getValue;
          const getValues = range.getValues;
          const read = () => { t.manifestReads++; if (t.onManifest) t.onManifest(t.manifestReads); };
          range.getValue = () => { read(); return getValue(); };
          range.getValues = () => { read(); return getValues(); };
        } else {
          const getValues = range.getValues;
          range.getValues = () => {
            const result = getValues();
            t.tableReads.push(name);
            if (t.afterTable) t.afterTable(name);
            return result;
          };
        }
        return range;
      };
    }
  }
  instrument(b);
  t.instrument = instrument;
  g.sandbox.SpreadsheetApp.openById = (id) => {
    t.opened.push(id);
    const selected = t.books[id];
    if (!selected) throw new Error('no workbook access');
    return { getSheetByName: (name) => selected[name] || null };
  };
  g.sandbox.CacheService.getScriptCache = () => ({
    get: (key) => { if (t.onCacheGet) t.onCacheGet(key); return g.sandbox.__cache[key] ?? null; },
    put: (key, value, ttl) => { t.cacheWrites.push({ key, ttl }); g.sandbox.__cache[key] = value; },
    remove: (key) => { delete g.sandbox.__cache[key]; },
  });
  t.read = () => clone(g.run('mwReadTeamDigest_()'));
  t.team = (house = 'ramot') => clone(g.run(`mwTeam_(${JSON.stringify(house)}, '2026-11-20')`));
  t.writeManifest = (value) => { b.ManagersPublication.grid[0] = [typeof value === 'string' ? value : JSON.stringify(value)]; };
  t.pending = () => t.writeManifest({ schema: 'managers-house-v1', state: 'pending', publicationId: 'publication_00000002' });
  return t;
}

function unavailable(t, reason) {
  const result = t.read();
  assert.equal(result.available, false, JSON.stringify(result));
  assert.deepEqual(Object.keys(result).sort(), ['available', 'reason']);
  if (reason) assert.equal(result.reason, reason);
  assert.equal(t.cacheWrites.length, 0, 'a failed publication is never cached as successful');
  return result;
}

test('manifest: one complete publication returns existing house-scoped fields without internal metadata', () => {
  const t = fixture();
  const team = t.team();
  assert.equal(team.available, true);
  assert.equal(team.stale, false);
  assert.equal(team.updatedAt, NOW);
  assert.equal(team.today.length, 1);
  assert.equal(team.staff[0].phone, '0501234567');
  assert.deepEqual(team.staff[0].workdays, [0, 2]);
  assert.equal(team.staff[0].startDate, '2026-10-01');
  assert.equal(team.therapistWeek.length, 1);
  assert.ok(!JSON.stringify(team).includes('OTHER-'));
  for (const field of ['publicationId', 'source', 'token', 'sha256', 'tables']) assert.ok(!JSON.stringify(team).includes(`"${field}"`));
  assert.equal(t.manifestReads, 2);
  assert.deepEqual(t.tableReads, Object.values(TABLES));
  assert.equal(t.cacheWrites.length, 1);
  assert.equal(t.cacheWrites[0].ttl, 300);
});

for (const value of [undefined, '', 'false', 'TRUE', '1']) {
  test(`manifest: strict mode remains off for ${String(value)} and preserves legacy cached reads`, () => {
    const t = fixture();
    if (value === undefined) delete t.g.sandbox.__props.MANAGERS_DIGEST_REQUIRE_MANIFEST;
    else t.g.sandbox.__props.MANAGERS_DIGEST_REQUIRE_MANIFEST = value;
    t.pending();
    const legacy = { available: true, updatedAt: 'legacy', shifts: [], staff: [], therapistWeek: [] };
    t.g.sandbox.__cache['mw:team-digest:v1'] = JSON.stringify(legacy);
    assert.deepEqual(t.read(), legacy);
    assert.equal(t.opened.length, 0);
  });
}

test('manifest: trimmed true enables strict mode and rejects the legacy success cache', () => {
  const t = fixture();
  t.g.sandbox.__props.MANAGERS_DIGEST_REQUIRE_MANIFEST = ' true ';
  t.g.sandbox.__cache['mw:team-digest:v1'] = JSON.stringify({ available: true, staff: [{ name: 'unsafe-old' }] });
  t.pending();
  unavailable(t, 'pending');
  assert.equal(t.tableReads.length, 0);
});

test('manifest: no workbook configured or no read access returns unavailable', () => {
  const t = fixture();
  delete t.g.sandbox.__props.MANAGERS_DIGEST_SHEET_ID;
  unavailable(t, 'not_configured');
  t.g.sandbox.__props.MANAGERS_DIGEST_SHEET_ID = 'denied';
  unavailable(t, 'unreadable');
});

test('manifest: missing, empty and pending manifest never looks like an empty team', () => {
  const t = fixture();
  const original = t.book.ManagersPublication;
  delete t.book.ManagersPublication;
  unavailable(t, 'pending');
  t.book.ManagersPublication = original;
  t.writeManifest('');
  unavailable(t, 'pending');
  t.pending();
  unavailable(t, 'pending');
  assert.equal(t.tableReads.length, 0);
});

const BAD_MANIFESTS = [
  ['invalid JSON', () => '{'],
  ['array', () => '[]'],
  ['oversize', () => ' '.repeat(12001)],
  ['unknown schema', (m) => { m.schema = 'managers-house-v2'; }],
  ['unknown state', (m) => { m.state = 'complete'; }],
  ['extra root key', (m) => { m.extra = true; }],
  ['missing root key', (m) => { delete m.source; }],
  ['short publication id', (m) => { m.publicationId = 'short'; }],
  ['invalid publication id', (m) => { m.publicationId = 'invalid publication id'; }],
  ['noncanonical timestamp', (m) => { m.publishedAt = '2026-11-20'; }],
  ['invalid calendar timestamp', (m) => { m.publishedAt = '2026-02-30T08:00:00.000Z'; }],
  ['future timestamp', (m) => { m.publishedAt = new Date(Date.now() + 600000).toISOString(); }],
  ['odd source revision', (m) => { m.source.revision = 3; }],
  ['negative source revision', (m) => { m.source.revision = -2; }],
  ['fractional source revision', (m) => { m.source.revision = 2.5; }],
  ['unsafe source revision', (m) => { m.source.revision = Number.MAX_SAFE_INTEGER + 1; }],
  ['string source revision', (m) => { m.source.revision = '2'; }],
  ['invalid source token', (m) => { m.source.token = 'AB'.repeat(32); }],
  ['extra source key', (m) => { m.source.pending = false; }],
  ['missing table', (m) => { delete m.tables.staff; }],
  ['extra table', (m) => { m.tables.finance = m.tables.staff; }],
  ['negative row count', (m) => { m.tables.staff.rows = -1; }],
  ['excess row count', (m) => { m.tables.staff.rows = 50001; }],
  ['fractional row count', (m) => { m.tables.staff.rows = 0.5; }],
  ['string row count', (m) => { m.tables.staff.rows = '2'; }],
  ['zero columns', (m) => { m.tables.staff.columns = 0; }],
  ['excess columns', (m) => { m.tables.staff.columns = 65; }],
  ['invalid hash', (m) => { m.tables.staff.sha256 = 'x'.repeat(64); }],
  ['extra table metadata', (m) => { m.tables.staff.extra = true; }],
];
for (const [name, change] of BAD_MANIFESTS) {
  test(`manifest: rejects ${name} before reading tables`, () => {
    const t = fixture();
    const manifest = clone(t.manifest);
    const raw = change(manifest);
    t.writeManifest(typeof raw === 'string' ? raw : manifest);
    unavailable(t, 'contract_mismatch');
    assert.equal(t.tableReads.length, 0);
  });
}

test('manifest: certified header-only tables are valid empty data with manifest freshness', () => {
  const t = fixture({ empty: true });
  const team = t.team();
  assert.equal(team.available, true);
  assert.equal(team.stale, false);
  assert.equal(team.updatedAt, NOW);
  assert.deepEqual(team.staff, []);
  assert.deepEqual(team.shifts, []);
  assert.deepEqual(team.therapistWeek, []);
});

for (const tab of Object.values(TABLES)) {
  test(`manifest: missing or cleared ${tab} cannot satisfy a certified empty publication`, () => {
    const t = fixture({ empty: true });
    const sh = t.book[tab];
    delete t.book[tab];
    unavailable(t);
    t.book[tab] = sh;
    sh.grid.length = 0;
    unavailable(t);
  });

  test(`manifest: ${tab} data mutation cannot pass the prior ready hash`, () => {
    const t = fixture();
    t.book[tab].grid[1][0] = 'changed-house';
    unavailable(t, 'contract_mismatch');
  });

  test(`manifest: publishing starts after reading ${tab}; mixed/changed results never escape`, () => {
    const t = fixture();
    t.afterTable = (name) => {
      if (name !== tab) return;
      t.pending();
      t.book.ManagersStaff.grid[1][1] = 'NEW-GENERATION';
    };
    unavailable(t);
  });
}

for (const [name, modify] of [
  ['wrong row count', (m) => { m.tables.staff.rows++; }],
  ['wrong column count', (m) => { m.tables.staff.columns++; }],
  ['well-formed wrong hash', (m) => { m.tables.staff.sha256 = '0'.repeat(64); }],
]) {
  test(`manifest: ${name} rejects even unchanged table contents`, () => {
    const t = fixture();
    const m = clone(t.manifest); modify(m); t.writeManifest(m);
    unavailable(t, 'contract_mismatch');
  });
}

for (const [name, value] of [['duplicate', 'house'], ['blank', ''], ['number', 42]]) {
  test(`manifest: certified ${name} header is still a contract error`, () => {
    const t = fixture();
    t.book.ManagersStaff.grid[0][1] = value;
    certify(t.book);
    t.tableReads.length = 0;
    unavailable(t, 'contract_mismatch');
  });
}

test('manifest: missing required header fails; reordered columns and optional startDate absence read by name', () => {
  const bad = fixture();
  bad.book.ManagersStaff.grid[0][1] = 'differentName';
  certify(bad.book);
  unavailable(bad, 'contract_mismatch');
  const t = fixture({ optional: false });
  for (const row of t.book.ManagersStaff.grid) row.reverse();
  certify(t.book);
  t.tableReads.length = 0;
  const team = t.team();
  assert.equal(team.available, true);
  assert.equal(team.staff[0].name, 'אבי');
  assert.equal(team.staff[0].phone, '0501234567');
  assert.equal(team.staff[0].startDate, '');
});

test('manifest: typed hash preserves native dates, numbers, booleans, Hebrew and literal formula guards', () => {
  const t = fixture();
  const sh = t.book.ManagersStaff;
  sh.grid[0].push('nativeDate', 'number', 'boolean', 'empty', 'literal');
  sh.grid[1].push(t.g.run('new Date("2026-11-20T07:05:00.000Z")'), 0, false, null, "'=SUM(1,2) שלום");
  sh.grid[2].push('', 2, true, undefined, '');
  certify(t.book);
  const team = t.team();
  assert.equal(team.available, true);
  assert.equal(team.staff[0].phone, '0501234567');
  assert.ok(!JSON.stringify(team).includes('nativeDate'));
  assert.ok(!JSON.stringify(team).includes('SUM'));
});

for (const [name, initial, changed] of [
  ['number versus string', 2, '2'],
  ['boolean versus string', true, 'true'],
  ['leading zero versus numeric phone', '0501234567', 501234567],
  ['literal apostrophe', "'=1+1", '=1+1'],
  ['untrimmed text', ' אבי ', 'אבי'],
]) {
  test(`manifest: canonical hash distinguishes ${name}`, () => {
    const t = fixture();
    const sh = t.book.ManagersStaff;
    sh.grid[0].push('extra');
    sh.grid[1].push(initial); sh.grid[2].push('');
    certify(t.book);
    sh.grid[1][sh.grid[0].length - 1] = changed;
    unavailable(t, 'contract_mismatch');
  });
}

test('manifest: cache hit still opens workbook and reads live manifest twice, but skips table reads', () => {
  const t = fixture();
  const first = t.read();
  const reads = t.tableReads.length;
  const manifestReads = t.manifestReads;
  assert.deepEqual(t.read(), first);
  assert.equal(t.opened.length, 2);
  assert.equal(t.manifestReads - manifestReads, 2);
  assert.equal(t.tableReads.length, reads);
});

test('manifest: pending or removed publication invalidates a prior success cache immediately', () => {
  const t = fixture();
  assert.equal(t.read().available, true);
  t.cacheWrites.length = 0;
  t.pending();
  unavailable(t, 'pending');
  delete t.book.ManagersPublication;
  unavailable(t, 'pending');
});

test('manifest: a cached publication cannot bypass current workbook access failure', () => {
  const t = fixture();
  assert.equal(t.read().available, true);
  t.cacheWrites.length = 0;
  delete t.books['book-1'];
  unavailable(t, 'unreadable');
});

test('manifest: publication changes while retrieving a cache hit fail closed', () => {
  const t = fixture();
  assert.equal(t.read().available, true);
  t.cacheWrites.length = 0;
  t.onCacheGet = () => t.pending();
  unavailable(t);
});

test('manifest: new complete publication replaces cache and uses its published time', () => {
  const t = fixture();
  assert.equal(t.read().available, true);
  t.book.ManagersStaff.grid[1][1] = 'NEXT-GENERATION';
  const publishedAt = new Date(Date.now() - 10000).toISOString();
  certify(t.book, { publicationId: 'publication_00000002', publishedAt });
  const next = t.read();
  assert.equal(next.available, true);
  assert.equal(next.staff[0].name, 'NEXT-GENERATION');
  assert.equal(next.updatedAt, publishedAt);
});

test('manifest: same publication JSON in another workbook cannot reuse this workbook cache', () => {
  const t = fixture();
  assert.equal(t.read().available, true);
  const second = workbook();
  second.ManagersPublication.grid[0] = [JSON.stringify(t.manifest)];
  second.ManagersStaff.grid[1][1] = 'CORRUPT-SECOND-BOOK';
  t.instrument(second);
  t.books['book-2'] = second;
  t.g.sandbox.__props.MANAGERS_DIGEST_SHEET_ID = 'book-2';
  t.cacheWrites.length = 0;
  unavailable(t, 'contract_mismatch');
});

test('manifest: final read must match exact manifest JSON, even equivalent content reordered', () => {
  const t = fixture();
  t.onManifest = (n) => {
    if (n === 2) t.writeManifest(JSON.stringify(t.manifest, null, 1));
  };
  unavailable(t, 'publication_changed');
});

test('manifest: publication timestamp controls stale display even with fresh individual rows', () => {
  const t = fixture();
  const old = new Date(Date.now() - 3 * 3600000).toISOString();
  t.writeManifest({ ...t.manifest, publishedAt: old });
  const team = t.team();
  assert.equal(team.available, true);
  assert.equal(team.updatedAt, old);
  assert.equal(team.stale, true);
});

test('manifest: sheet and hash failures return unavailable without partial rows', () => {
  const t = fixture();
  t.book.ManagersStaff.getLastRow = () => { throw new Error('read failed'); };
  unavailable(t, 'unreadable');
  const hash = fixture();
  hash.g.sandbox.Utilities.computeDigest = () => { throw new Error('hash unavailable'); };
  unavailable(hash, 'unreadable');
});
