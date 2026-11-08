'use strict';

/* An admitted lead is never reopened by a stale save
 * (CHANGELOG-admitted-lead-stays-closed.md). Reported: מתן כחלון admitted to
 * ריהאב on 01/11 (patient row, fromLead = his lead), then his lead was written
 * back to «בטיפול פעיל» by a save that carried an old copy of the leads.
 *
 * A. Code.gs (the REAL file, in-memory sheets): saveAll_ keeps the sheet's
 *    admitted stage when a not-released patient points at the lead; a real
 *    reopen (patient released) and ordinary lead edits are untouched.
 * B. app.js load-time heal: a board lead linked by fromLead to an in-house
 *    patient is retired to 'admitted' (link only, never by name).
 * C. CRM normalise: such a lead reads as admitted, not on the board.
 * Names are SYNTHETIC. */

process.env.TZ = 'Asia/Jerusalem';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { richSheet, loadGs } = require('./helpers/gs-sandbox');
const core = require('../public/crm/crm.js');

const arr = (x) => JSON.parse(JSON.stringify(x));

/* ================= A. Code.gs ================= */

function boot() {
  const g = loadGs({});
  g.sandbox.Session = { getScriptTimeZone: () => 'Asia/Jerusalem' };
  const lc = Array.from(g.run('LEAD_COLUMNS'));
  const pc = Array.from(g.run('PATIENT_COLUMNS'));
  const ls = richSheet('Leads', lc);
  const ps = richSheet('Patients', pc);
  g.sandbox.__sheets.Leads = ls;
  g.sandbox.__sheets.Patients = ps;
  const obj = (cols, r) => Object.fromEntries(cols.map((c, i) => [c, r[i]]));
  const live = (sh) => sh.grid.slice(1).filter((r) => r.some((v) => v !== '' && v != null));
  const row = (cols, o) => cols.map((c) => (o[c] === undefined ? '' : o[c]));
  return {
    g, ls, ps, lc, pc,
    addLead: (o) => ls.grid.push(row(lc, o)),
    addPatient: (o) => ps.grid.push(row(pc, o)),
    lead: (id) => live(ls).map((r) => obj(lc, r)).find((l) => l.id === id),
    save: (leads, patients) => arr(g.sandbox.saveAll_(leads, patients || {}, 'ורד')),
  };
}

const LEAD = (o) => Object.assign({ id: 'L1', name: 'אורי טל', phone: '0521234567', house: 'קיסריה ריהאב', stage: 'admitted', entryDate: '2026-11-01',
  visitDate: '2026-10-25', meetingOutcome: 'entered', created: '2026-10-18' }, o || {});
const PATIENT = (o) => Object.assign({ id: 'p1', houseId: 'rehab', name: 'אורי טל', date: '2026-11-01', pay: 33000, status: 'active', fromLead: 'L1', source: 'lead' }, o || {});

test('A: a stale save carrying the lead at «בטיפול פעיל» does NOT reopen an admitted lead whose patient is in a house', () => {
  const w = boot();
  w.addLead(LEAD());
  w.addPatient(PATIENT());
  const r = w.save([LEAD({ stage: 'paid', entryDate: '', meetingOutcome: '', note: 'עדכון הערה' })]);
  assert.equal(r.ok, true);
  const l = w.lead('L1');
  assert.equal(l.stage, 'admitted');
  assert.equal(l.entryDate, '2026-11-01');
  assert.equal(l.meetingOutcome, 'entered');
  assert.equal(l.note, 'עדכון הערה', 'the other fields of the save still land');
  assert.deepEqual(r.admittedKept, ['L1']);
});

test('A: a real reopen after a discharge (patient released) is NOT blocked', () => {
  const w = boot();
  w.addLead(LEAD());
  w.addPatient(PATIENT({ status: 'released', exitDate: '2026-11-10' }));
  const r = w.save([LEAD({ stage: 'new' })]);
  assert.equal(r.ok, true);
  assert.equal(w.lead('L1').stage, 'new');
  assert.equal(r.admittedKept, undefined);
});

test('A: an admitted lead with no linked patient follows the payload as before', () => {
  const w = boot();
  w.addLead(LEAD());
  const r = w.save([LEAD({ stage: 'paid' })]);
  assert.equal(r.ok, true);
  assert.equal(w.lead('L1').stage, 'paid');
});

test('A: ordinary moves of open leads are untouched; admitting still writes admitted', () => {
  const w = boot();
  w.addLead(LEAD({ stage: 'visit', entryDate: '', meetingOutcome: '' }));
  assert.equal(w.save([LEAD({ stage: 'paid', entryDate: '', meetingOutcome: '' })]).ok, true);
  assert.equal(w.lead('L1').stage, 'paid');
  const r = w.save([LEAD()], { rehab: [PATIENT()] });
  assert.equal(r.ok, true);
  assert.equal(w.lead('L1').stage, 'admitted');
});

/* ================= B. classic load-time heal ================= */

function loadApp() {
  const APP = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const noop = () => {};
  const sandbox = {
    console: { log: noop, warn: noop, error: noop, info: noop },
    location: { origin: 'http://test', href: 'http://test/' },
    document: { addEventListener: noop, getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    URLSearchParams, Math, Date, JSON, Number, String, Array, Object, RegExp, Map, Set,
    isNaN, isFinite, parseInt, parseFloat, Promise,
  };
  sandbox.window = sandbox; sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(APP + '\nglobalThis.__t = { state, retireAdmittedLeads };', sandbox);
  return sandbox.__t;
}
const app = loadApp();

test('B: a board lead linked by fromLead to an in-house patient is retired to admitted (with the entry date)', () => {
  app.state.leads = [{ id: 'L1', name: 'אורי טל', house: 'קיסריה ריהאב', stage: 'paid', entryDate: '' }];
  app.state.patients = [{ id: 'p1', houseId: 'rehab', name: 'אורי טל', date: '2026-11-01', status: 'active', fromLead: 'L1' }];
  const retired = app.retireAdmittedLeads();
  assert.equal(retired.length, 1);
  assert.equal(app.state.leads[0].stage, 'admitted');
  assert.equal(app.state.leads[0].entryDate, '2026-11-01');
});

test('B: no link → no change (never by name for board stages); a released patient → no change', () => {
  app.state.leads = [{ id: 'L2', name: 'אורי טל', house: 'קיסריה ריהאב', stage: 'paid' }, { id: 'L3', name: 'רז', house: 'קיסריה ריהאב', stage: 'visit' }];
  app.state.patients = [{ id: 'p1', houseId: 'rehab', name: 'אורי טל', date: '2026-11-01', status: 'active', fromLead: 'L9' },
    { id: 'p3', houseId: 'rehab', name: 'רז', date: '2026-09-01', status: 'released', fromLead: 'L3' }];
  assert.equal(app.retireAdmittedLeads().length, 0);
  assert.deepEqual(app.state.leads.map((l) => l.stage), ['paid', 'visit']);
});

/* ================= C. CRM ================= */

test('C: CRM — a reopened lead whose patient is in a house is not an open board lead', () => {
  const data = { ok: true, leads: [{ id: 'L1', name: 'אורי טל', house: 'קיסריה ריהאב', stage: 'paid', created: '2026-10-18' }, { id: 'L2', name: 'רז', house: 'רמות השבים', stage: 'paid', created: '2026-10-18' }],
    patients: { rehab: [{ id: 'p1', name: 'אורי טל', date: '2026-11-01', status: 'active', fromLead: 'L1' }] } };
  const c = core.compute(data, '2026-11-02');
  assert.equal(c.leads.find((l) => l.id === 'L1').stage, 'admitted');
  assert.equal(c.leads.find((l) => l.id === 'L1').entryDate, '2026-11-01');
  assert.equal(c.leads.find((l) => l.id === 'L2').stage, 'paid');
  assert.ok(!c.rows.some((r) => r.leadId === 'L1'), 'not in the work queue');
});
