'use strict';

/* «לא רלוונטי» column + «לא רלוונטי ✕» card action on the CRM leads board
 * (CHANGELOG-crm-not-relevant-column.md).
 *
 * A. pure: notRelevantColumn — 30-day window, not_relevant only (legacy rows via
 *    closedDisposition), the board's house / owner / search filter, newest first,
 *    defensive input.
 * B. source guards: the card button, the drawer reuses data-form="close" (→
 *    closeLeadAction), the reason stays required, the column is fed from
 *    irrelevantLeads only (never counted), every value escaped, SW bumped.
 * Names / phones are SYNTHETIC. The real-browser flow is in crm-shell-browser.test.js. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const core = require('../public/crm/crm.js');

const ROOT = path.join(__dirname, '..');
const CRM_SRC = fs.readFileSync(path.join(ROOT, 'public', 'crm', 'crm.js'), 'utf8');
const CRM_CSS = fs.readFileSync(path.join(ROOT, 'public', 'crm', 'crm.css'), 'utf8');
const SW_SRC = fs.readFileSync(path.join(ROOT, 'public', 'sw.js'), 'utf8');
const TODAY = '2026-11-19';
const closed = (o) => Object.assign({ id: 'X', name: 'בדיקה אחת', house: 'רמות השבים', stage: 'irrelevant', originSheet: 'new', movedAt: '2026-11-18T09:00:00.000Z', disposition: 'not_relevant', not_relevant_note: 'לא עונה', assignedTo: 'ורד', phone: '0501234567' }, o);

/* ================= A. pure ================= */

test('A: 30 days by default; only «לא רלוונטי»; newest first', () => {
  assert.equal(core.NOT_RELEVANT_DAYS, 30);
  const rows = [
    closed({ id: 'old', movedAt: '2026-10-19T08:00:00.000Z' }),     // 31 days — out
    closed({ id: 'edge', movedAt: '2026-10-20T08:00:00.000Z' }),    // exactly 30 days — in
    closed({ id: 'new', movedAt: '2026-11-19T06:00:00.000Z' }),
    closed({ id: 'mid', movedAt: '2026-11-01T06:00:00.000Z' }),
    closed({ id: 'done', disposition: 'completed' }),
    closed({ id: 'early', disposition: 'stopped_early' }),
    closed({ id: 'out', disposition: 'released_outpatient' }),
  ];
  assert.deepEqual(core.notRelevantColumn(rows, {}, TODAY).map((l) => l.id), ['new', 'mid', 'edge']);
  assert.deepEqual(core.notRelevantColumn(rows, {}, TODAY, 7).map((l) => l.id), ['new'], 'the window is a parameter');
});

test('A: legacy rows (no disposition) follow the classic computeDisposition mapping', () => {
  const rows = [
    closed({ id: 'legacy-nr', disposition: '', not_relevant_reason: 'never_relevant' }),
    closed({ id: 'legacy-blank', disposition: '', not_relevant_reason: '' }),
    closed({ id: 'legacy-stopped', disposition: '', not_relevant_reason: 'stopped_from_house' }),
  ];
  assert.deepEqual(core.notRelevantColumn(rows, {}, TODAY).map((l) => l.id).sort(), ['legacy-blank', 'legacy-nr']);
});

test('A: the board filter applies (house by name or id, owner, search on name / phone / house)', () => {
  const rows = [
    closed({ id: 'r', house: 'ramot', assignedTo: 'ורד', name: 'אבי לוי', phone: '0501111111' }),
    closed({ id: 'p', house: 'רעננה הפרדס', assignedTo: 'דנה', name: 'גלי כהן', phone: '0502222222' }),
  ];
  assert.deepEqual(core.notRelevantColumn(rows, { house: 'רמות השבים' }, TODAY).map((l) => l.id), ['r']);
  assert.deepEqual(core.notRelevantColumn(rows, { owner: 'דנה' }, TODAY).map((l) => l.id), ['p']);
  assert.deepEqual(core.notRelevantColumn(rows, { q: 'גלי' }, TODAY).map((l) => l.id), ['p']);
  assert.deepEqual(core.notRelevantColumn(rows, { q: '0501111111' }, TODAY).map((l) => l.id), ['r']);
  assert.deepEqual(core.notRelevantColumn(rows, { q: 'הפרדס' }, TODAY).map((l) => l.id), ['p']);
});

test('A: defensive — bad input never throws and never lists a row without id / date', () => {
  assert.deepEqual(core.notRelevantColumn(null, {}, TODAY), []);
  assert.deepEqual(core.notRelevantColumn('x', {}, TODAY), []);
  assert.deepEqual(core.notRelevantColumn([closed({})], {}, 'not-a-date'), []);
  assert.deepEqual(core.notRelevantColumn([null, 7, closed({ id: '' }), closed({ id: 'nodate', movedAt: '' }), closed({ id: 'bad', movedAt: 'garbage' })], null, TODAY), []);
});

test('A: the column never feeds a count — board(), compute() and filterLeads ignore closed leads', () => {
  const data = { ok: true, leads: [{ id: 'L1', name: 'אבי לוי', house: 'ramot', stage: 'new', created: TODAY }], patients: {}, irrelevantLeads: [closed({ id: 'C1' })] };
  const c = core.compute(data, TODAY);
  assert.deepEqual(c.leads.map((l) => l.id), ['L1']);
  assert.equal(core.board(c.leads, {}).length, core.STAGES.length, 'the stage columns are unchanged');
  assert.equal(core.board(c.leads, {}).reduce((n, col) => n + col.leads.length, 0), 1);
  assert.ok(!c.rows.some((r) => r.leadId === 'C1'), 'not on the work queue');
  assert.equal(core.notRelevantColumn(data.irrelevantLeads, {}, TODAY).length, 1);
});

test('A: the quick-close rule is the existing one — a status AND a reason', () => {
  assert.deepEqual(core.closeLeadErrors({ disposition: 'not_relevant', note: 'לא עונה' }), {});
  assert.ok(core.closeLeadErrors({ disposition: 'not_relevant', note: '' }).note, 'no reason → refused');
  assert.ok(core.closeLeadErrors({ disposition: 'x', note: 'לא עונה' }).disposition);
  const rec = core.closeRecord({ id: 'L1', stage: 'visit' }, 'not_relevant', 'לא עונה', '2026-11-19T08:00:00.000Z');
  assert.deepEqual([rec.stage, rec.originSheet, rec.disposition, rec.not_relevant_note], ['irrelevant', 'visit', 'not_relevant', 'לא עונה']);
  assert.ok(Array.isArray(core.NOT_RELEVANT_REASONS) && core.NOT_RELEVANT_REASONS.length >= 3);
});

/* ================= B. source guards ================= */

const fnBody = (name) => {
  const i = CRM_SRC.indexOf('function ' + name + '(');
  assert.ok(i >= 0, name + ' exists');
  return CRM_SRC.slice(i, CRM_SRC.indexOf('\n    }\n', i));
};

test('B: every board card carries «לא רלוונטי ✕»; its click opens the quick-close drawer and never the card', () => {
  assert.match(CRM_SRC, /data-quick-close="' \+ esc\(l\.id\) \+ '"[^>]*>לא רלוונטי ✕<\/button>/);
  assert.match(CRM_SRC, /\[data-restore-lead\],\[data-quick-close\],\[data-stage-next\]/, 'in the click delegate, before the card');
  assert.match(CRM_SRC, /if \(t\.dataset\.quickClose\) \{ ev\.preventDefault\(\); ev\.stopPropagation\(\); if \(!state\.saving\) openQuickCloseDrawer\(t\.dataset\.quickClose\); return; \}/);
});

test('B: the drawer submits the SAME data-form="close" (closeLeadAction, optimistic + rollback) with not_relevant fixed and a required reason', () => {
  const body = fnBody('openQuickCloseDrawer');
  assert.match(body, /data-form="close" data-lead="' \+ esc\(l\.id\) \+ '"/);
  assert.match(body, /<input type="hidden" name="disposition" value="not_relevant">/);
  assert.match(body, /name="note" type="text" maxlength="500" required/);
  assert.match(body, /data-err="note"/);
  assert.doesNotMatch(body, /postAction|fetch\(/, 'no new write path');
  assert.match(CRM_SRC, /f\.dataset\.form === 'close'\) \{\s*const ce = closeLeadErrors/, 'the existing handler validates');
});

test('B: the column reads irrelevantLeads only, escapes every value, restores through data-restore-lead', () => {
  const body = fnBody('notRelevantColHtml');
  assert.match(body, /notRelevantColumn\(state\.data && state\.data\.irrelevantLeads, f, state\.today\)/);
  assert.doesNotMatch(body, /state\.data\.leads/);
  assert.match(body, /data-restore-lead="' \+ esc\(l\.id\) \+ '"/);
  assert.match(body, /esc\(leadLabel\(l\)\)/); assert.match(body, /esc\(note/); assert.match(body, /title="' \+ esc\(note\) \+ '"/);
  assert.doesNotMatch(body, /data-open-lead/, 'a closed card does not open the (missing) lead');
  assert.match(CRM_SRC, /\}\)\.join\(''\) \+ notRelevantColHtml\(f\) \+ '<\/div>';/, 'rendered as the last board column');
});

test('B: CSS has five board columns (desktop + mobile) and a readable column header; SW bumped to v147', () => {
  assert.match(CRM_CSS, /\.board \{ display: grid; grid-template-columns: repeat\(5, minmax\(220px, 1fr\)\)/);
  assert.match(CRM_CSS, /\.board \{ grid-template-columns: repeat\(5, 80vw\); \}/);
  assert.match(CRM_CSS, /\.col\[data-stage="not_relevant"\] h3 \{ background: #55636F; color: #fff; \}/);
  // v147 here; later PRs bump on (monotonic) — v148: CHANGELOG-meeting-report-in-managers.md.
  assert.ok(Number(/var CACHE_VERSION = 'v(\d+)';/.exec(SW_SRC)[1]) >= 147);
});
