'use strict';

/* «לא נכנס» on «ממתינים לקליטה» (CHANGELOG-waiting-not-entered.md): the
 * EXISTING soft close (closeLead → moveLeadIrrelevant) with the lead
 * dispositions and a required reason. Nothing is hard-deleted. app.js and
 * Code.gs are REAL; names are SYNTHETIC. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadPage, tick } = require('./helpers/app-sandbox');
const { richSheet, loadGs } = require('./helpers/gs-sandbox');
const { serverEcho } = require('./helpers/server-echo');

const plain = (v) => JSON.parse(JSON.stringify(v));
const APP_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const WAIT = { id: 'W-1', name: 'ממתין לקליטה', phone: '0521234567', house: 'רמות השבים', stage: 'paid', entryDate: '2026-10-15' };

function page(answerPost) {
  const pg = loadPage({ answerPost: answerPost || ((b) => serverEcho(b, { ok: true })) });
  pg.run('showCloseLeadModal = (o) => { globalThis.__closeOpts = o; };');
  pg.set({ leads: [plain(WAIT)], irrelevantLeads: [] });
  return pg;
}

test('the waiting card offers «לא נכנס» in edit mode only, next to «קלוט כמטופל»', () => {
  const pg = loadPage();
  const html = (edit) => pg.run(`pendingAdmissionRowHtml({ lead: normalizeLead(${JSON.stringify(WAIT)}), days: 4, chipDays: 4 }, ${edit})`);
  assert.match(html(true), /plist-admit-btn">קלוט כמטופל<\/button><button type="button" class="btn small plist-not-entered-btn"[^>]*>לא נכנס<\/button>/);
  assert.ok(!html(false).includes('plist-not-entered-btn'));
  assert.match(APP_SRC, /if \(notIn\) notIn\.onclick = \(\) => closeWaitingNotEntered\(r\.lead\);/);
});

test('«לא נכנס» opens the EXISTING close modal with lead dispositions and a required reason', () => {
  const pg = page();
  pg.run('closeWaitingNotEntered(state.leads[0])');
  const o = pg.sandbox.__closeOpts;
  assert.deepEqual(plain(o.dispositions), ['not_relevant', 'stopped_early']);
  assert.equal(o.requireNote, true);
  assert.match(o.title, /^לא נכנס — ממתין לקליטה$/);
});

test('confirm: optimistic move to the closed list («שימור לידים»), soft move only, server re-checks the reason', async () => {
  const pg = page();
  pg.run('closeWaitingNotEntered(state.leads[0])');
  const p = pg.sandbox.__closeOpts.onConfirm({ disposition: 'stopped_early', note: 'בחר מסגרת אחרת' });
  assert.equal(pg.state().leads.length, 0, 'gone from the waiting list at once');
  assert.equal(pg.state().irrelevantLeads[0].id, 'W-1');
  await p;
  const post = pg.posts.find((b) => b.action === 'moveLeadIrrelevant');
  assert.ok(post);
  assert.equal(post.requireReason, true);
  assert.equal(post.lead.disposition, 'stopped_early');
  assert.equal(post.lead.not_relevant_note, 'בחר מסגרת אחרת');
  assert.equal(post.lead.originSheet, 'paid');
  assert.ok(!pg.posts.some((b) => /remove|delete/i.test(b.action)), 'never a delete');
});

test('failure: rolled back to the waiting list and the modal stays open (throws)', async () => {
  const pg = page((b) => (b.action === 'moveLeadIrrelevant' ? { ok: false, error: 'reason_required' } : { ok: true }));
  pg.run('closeWaitingNotEntered(state.leads[0])');
  await assert.rejects(pg.sandbox.__closeOpts.onConfirm({ disposition: 'not_relevant', note: '' }));
  assert.equal(pg.state().leads.length, 1);
  assert.equal(pg.state().irrelevantLeads.length, 0);
  assert.ok(pg.errors.some((e) => e.includes('סגירת הליד נכשלה')));
});

test('the board\'s «סגירת ליד» is unchanged: all dispositions, optional note, no requireReason', async () => {
  const pg = page();
  pg.run('closeLead(state.leads[0])');
  const o = pg.sandbox.__closeOpts;
  assert.equal(o.dispositions, undefined);
  assert.equal(o.requireNote, false);
  await o.onConfirm({ disposition: 'not_relevant', note: '' });
  assert.equal(pg.posts.find((b) => b.action === 'moveLeadIrrelevant').requireReason, undefined);
});

test('showCloseLeadModal: requireNote marks the reason required and gates submit on it', () => {
  const fn = APP_SRC.slice(APP_SRC.indexOf('function showCloseLeadModal('), APP_SRC.indexOf('function showToast('));
  assert.match(fn, /\$\{requireNote \? 'סיבה \*' : 'פירוט'\}/);
  assert.match(fn, /const noteOk = \(\) => !requireNote \|\| !!String\(\(noteEl && noteEl\.value\) \|\| ''\)\.trim\(\);/);
  assert.match(fn, /submitBtn\.disabled = !Array\.from\(radios\)\.some\(x => x\.checked\) \|\| !noteOk\(\);/);
  assert.match(fn, /if \(!picked \|\| !noteOk\(\)\) return;/);
});

/* ---------------- Code.gs ---------------- */

function world() {
  const g = loadGs({ props: { PROXY_SECRET_MODE: 'enforce', PROXY_SECRET: 'proxy-secret-TEST-not-entered-00000000000' } });
  const lc = Array.from(g.run('LEAD_COLUMNS'));
  const ic = Array.from(g.run('IRRELEVANT_LEAD_COLUMNS'));
  const ls = richSheet('Leads', lc);
  ls.grid.push(lc.map((c) => WAIT[c] ?? ''));
  g.sandbox.__sheets.Leads = ls;
  const irrName = g.run('IRRELEVANT_LEADS_SHEET');
  g.sandbox.__sheets[irrName] = richSheet(irrName, ic);
  const move = (lead, extra) => plain(g.post(Object.assign({ action: 'moveLeadIrrelevant', proxySecret: 'proxy-secret-TEST-not-entered-00000000000', lead: JSON.stringify(lead) }, extra || {})));
  const leadsLeft = () => ls.grid.slice(1).filter((r) => r[0]).length;
  const closed = () => g.sandbox.__sheets[irrName].grid.slice(1).filter((r) => r[0]).map((r) => Object.fromEntries(ic.map((c, i) => [c, r[i]])));
  return { move, leadsLeft, closed };
}

test('server: requireReason without a note / disposition is refused — nothing moved', () => {
  const w = world();
  assert.equal(w.move(Object.assign({}, WAIT, { disposition: 'not_relevant', not_relevant_note: '  ' }), { requireReason: true }).error, 'reason_required');
  assert.equal(w.move(Object.assign({}, WAIT, { disposition: '', not_relevant_note: 'סיבה' }), { requireReason: 'true' }).error, 'reason_required');
  assert.equal(w.leadsLeft(), 1);
  assert.equal(w.closed().length, 0);
});

test('server: with a reason the row MOVES to the closed sheet (soft close, kept), formula-safe note', () => {
  const w = world();
  const r = w.move(Object.assign({}, WAIT, { disposition: 'stopped_early', not_relevant_note: '=HYPERLINK("x")\nשורה 2' }), { requireReason: true });
  assert.equal(r.ok, true);
  assert.equal(w.leadsLeft(), 0);
  const row = w.closed()[0];
  assert.equal(row.id, 'W-1');
  assert.equal(row.disposition, 'stopped_early');
  assert.equal(row.not_relevant_note, 'HYPERLINK("x")\nשורה 2', 'leading = stripped, newline kept');
});

test('server: an unknown disposition is refused; the legacy blank still defaults to not_relevant', () => {
  const w = world();
  assert.equal(w.move(Object.assign({}, WAIT, { disposition: 'deleted' })).error, 'bad_disposition');
  assert.equal(w.leadsLeft(), 1);
  assert.equal(w.move(Object.assign({}, WAIT, { disposition: '' })).ok, true);
  assert.equal(w.closed()[0].disposition, 'not_relevant');
});
