/* Tests for Vered's edit/delete of manager meeting reports (public/app.js —
 * PR 4):
 *
 *   - edit-modal pre-fill: preset companion → its chip selected; free-text
 *     companion → אחר selected + the raw text populated; outcome radio checked
 *     and note carried; rendered values escaped;
 *   - edit save: persists ONLY the three content fields through the REAL
 *     updateLead→saveAll path, preserving meetingReporter / meetingReportedAt /
 *     meetingSeen (original attribution + timestamp) and the whole row;
 *   - delete: clears exactly the six report fields, rest of the lead
 *     untouched; the unseen predicate is false afterward and the tab badge
 *     recomputes optimistically;
 *   - rollback on a failed save for both edit and delete;
 *   - client-side validation mirroring the PR-2 backend caps (outcome key,
 *     companion free text ≤ 100, note ≤ 2000);
 *   - edit-mode gating (same as mark-seen) + the action buttons rendering
 *     only in edit mode.
 *
 * Drives the real shipped functions in the repo's vm-sandbox (same load as
 * meeting-report-vered-view.test.js). saveAll is reassigned to capture what
 * would be persisted; renderAll/showError are stubbed where the rollback path
 * runs without a DOM. */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadApp() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const epilogue = `
    globalThis.__test = {
      validateMeetingReportEdit: (v) => validateMeetingReportEdit(v),
      meetingReportEditPrefill: (l) => meetingReportEditPrefill(l),
      meetingReportEditModalHTML: (l) => meetingReportEditModalHTML(l),
      meetingReportBlockHTML: (l) => meetingReportBlockHTML(l),
      saveMeetingReportEdit: (id, v) => saveMeetingReportEdit(id, v),
      deleteMeetingReport: (id) => deleteMeetingReport(id),
      meetingReportUnseen: (l) => meetingReportUnseen(l),
      countUnseenMeetingReports: (ls) => countUnseenMeetingReports(ls),
      renderMeetingsUnseenBadge: () => renderMeetingsUnseenBadge(),
      setLeads(ls) { state.leads = ls; },
      setMode(m) { state.mode = m; },
      getLead(id) { return state.leads.find(l => l.id === id); },
      meetingReportOutcomeBadgeClass: (k) => meetingReportOutcomeBadgeClass(k),
      /* Capture what saveAll would persist (deep copy of state.leads at call
       * time) — proves an edit carries the WHOLE row. Resolves the shape the
       * real saveAll_ now returns; conflicts simulates the merge guard
       * flagging leadIds (a raced manager resubmit/delete). */
      stubSaveAll(fail, conflicts) {
        const calls = [];
        saveAll = async () => {
          calls.push(JSON.parse(JSON.stringify(state.leads)));
          if (fail) throw new Error('save failed');
          return { ok: true, written: {}, reportConflicts: conflicts || [] };
        };
        return calls;
      },
      /* Capture apiPost bodies — the delete path's dedicated backend action. */
      stubApiPost(fail) {
        const calls = [];
        apiPost = async (body) => {
          calls.push(JSON.parse(JSON.stringify(body)));
          if (fail) throw new Error('action failed');
          return { ok: true };
        };
        return calls;
      },
      /* Capture loadAll calls — the edit-conflict path refreshes via loadAll. */
      stubLoadAll() {
        const calls = [];
        loadAll = async () => { calls.push(1); };
        return calls;
      },
      /* The rollback path calls renderAll + showError; neither has a DOM here. */
      stubRenderAll() { renderAll = () => {}; showError = () => {}; },
      /* Capture validation refusals surfaced via showError. */
      captureErrors() { const errs = []; showError = (m) => errs.push(m); return errs; },
    };
  `;
  const noop = () => {};
  const byId = {};
  function fakeEl() {
    return {
      textContent: '', hidden: null,
      classList: {
        _set: new Set(),
        add(c) { this._set.add(c); },
        remove(c) { this._set.delete(c); },
        toggle(c, on) {
          if (on === undefined) { this._set.has(c) ? this._set.delete(c) : this._set.add(c); }
          else if (on) this._set.add(c); else this._set.delete(c);
        },
        contains(c) { return this._set.has(c); },
      },
    };
  }
  const sandbox = {
    console: { log: noop, warn: noop, error: noop, info: noop },
    location: { origin: 'http://test', href: 'http://test/' },
    setTimeout: () => 0, clearTimeout: noop,
    document: {
      addEventListener: noop,
      getElementById: (id) =>
        (id === 'meetings-unseen-badge' || id === 'error-banner')
          ? (byId[id] || (byId[id] = fakeEl()))
          : null,
    },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    URLSearchParams, Math, Date, JSON, Number, String, Array, Object, RegExp, Promise,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src + epilogue, sandbox);
  return { app: sandbox.__test, byId };
}

const { app, byId } = loadApp();

function reportedLead(over) {
  return Object.assign({
    id: 'L1', name: 'דני', phone: '0501234567', house: 'ramot', stage: 'visit',
    visitDate: '2026-08-25', visitTime: '10:00', note: 'הערה פנימית',
    assignedTo: 'ורד', meetingWith: 'אורן', meetingOutcome: '',
    contactName: 'אבא של דני', contactPhone: '0521111111', contactRelation: 'אב',
    billingPhone: '', waitlistedAt: '', created: '2026-08-01',
    meetingReportOutcome: 'advancing', meetingCompanion: 'mother',
    meetingNote: 'שיחה טובה', meetingReporter: 'חנן',
    meetingReportedAt: '2026-08-29T10:15:00.000Z', meetingSeen: '1',
  }, over || {});
}

const REPORT_FIELDS = [
  'meetingReportOutcome', 'meetingCompanion', 'meetingNote',
  'meetingReporter', 'meetingReportedAt', 'meetingSeen',
];

/* ===== edit modal pre-fill ===== */

test('prefill: preset companion → its chip, no free text; outcome + note carried', () => {
  // Field-by-field (the object crosses the vm-context boundary, so
  // deepStrictEqual would trip on prototype identity).
  const pre = app.meetingReportEditPrefill(reportedLead());
  assert.strictEqual(pre.outcome, 'advancing');
  assert.strictEqual(pre.chip, 'mother');
  assert.strictEqual(pre.otherText, '');
  assert.strictEqual(pre.note, 'שיחה טובה');
});

test('prefill: free-text companion → אחר chip + the raw text; blank → no chip', () => {
  const free = app.meetingReportEditPrefill(reportedLead({ meetingCompanion: 'סבתא רבתא' }));
  assert.strictEqual(free.chip, 'other');
  assert.strictEqual(free.otherText, 'סבתא רבתא');

  const blank = app.meetingReportEditPrefill(reportedLead({ meetingCompanion: '' }));
  assert.strictEqual(blank.chip, '');
  assert.strictEqual(blank.otherText, '');
});

test('modal HTML: preset companion → chip selected, outcome radio checked, אחר row hidden', () => {
  const html = app.meetingReportEditModalHTML(reportedLead());
  assert.ok(html.includes('עריכת דיווח מנהל'));
  assert.ok(/value="advancing" checked/.test(html), 'current outcome pre-checked');
  assert.ok(!/value="no_show" checked/.test(html), 'other outcomes not checked');
  assert.ok(html.includes('class="mrv-chip selected" data-mrv-chip="mother"'),
    'preset chip carries .selected');
  assert.ok(!html.includes('selected" data-mrv-chip="other"'), 'אחר not selected');
  assert.ok(html.includes('mrv-other-wrap hidden'), 'free-text row starts hidden');
  assert.ok(html.includes('>שיחה טובה</textarea>'), 'note populated');
});

test('modal HTML: free-text companion → אחר selected with the text populated and escaped', () => {
  const html = app.meetingReportEditModalHTML(reportedLead({ meetingCompanion: '<b>סבתא</b>' }));
  assert.ok(html.includes('class="mrv-chip selected" data-mrv-chip="other"'),
    'אחר chip selected for a non-preset value');
  assert.ok(html.includes('value="&lt;b&gt;סבתא&lt;/b&gt;"'), 'raw text populated, escaped');
  assert.ok(!html.includes('mrv-other-wrap hidden'), 'free-text row visible');
  assert.ok(!html.includes('<b>סבתא</b>'));
});

test('modal HTML: the four outcome radios and every companion chip render', () => {
  const html = app.meetingReportEditModalHTML(reportedLead());
  ['advancing', 'undecided', 'not_fit', 'no_show'].forEach(k =>
    assert.ok(html.includes(`value="${k}"`), `outcome radio ${k}`));
  ['mother', 'father', 'parents', 'partner', 'sibling', 'friend', 'alone', 'other'].forEach(k =>
    assert.ok(html.includes(`data-mrv-chip="${k}"`), `companion chip ${k}`));
  assert.ok(html.includes('maxlength="100"'), 'companion input capped at 100');
  assert.ok(html.includes('maxlength="2000"'), 'note capped at 2000');
});

/* ===== edit save ===== */

test('edit save persists the three content fields, preserves attribution + seen + whole row', async () => {
  app.setMode('edit');
  app.setLeads([reportedLead({ id: 'L1' })]);
  const calls = app.stubSaveAll(false);

  const ok = await app.saveMeetingReportEdit('L1', {
    outcome: 'no_show', companion: 'father', note: 'תוקן ע"י ורד',
  });
  assert.strictEqual(ok, true);
  assert.strictEqual(calls.length, 1, 'exactly one save');

  const sent = calls[0].find(l => l.id === 'L1');
  // The three edited fields...
  assert.strictEqual(sent.meetingReportOutcome, 'no_show');
  assert.strictEqual(sent.meetingCompanion, 'father');
  assert.strictEqual(sent.meetingNote, 'תוקן ע"י ורד');
  // ...attribution/timestamp/seen untouched (correcting, not re-reporting)...
  assert.strictEqual(sent.meetingReporter, 'חנן');
  assert.strictEqual(sent.meetingReportedAt, '2026-08-29T10:15:00.000Z');
  assert.strictEqual(sent.meetingSeen, '1');
  // ...and the rest of the row rides through unchanged (no field drop).
  assert.strictEqual(sent.name, 'דני');
  assert.strictEqual(sent.phone, '0501234567');
  assert.strictEqual(sent.note, 'הערה פנימית');
  assert.strictEqual(sent.contactPhone, '0521111111');
  assert.strictEqual(sent.visitDate, '2026-08-25');
});

test('edit save accepts אחר free text as the stored companion value', async () => {
  app.setMode('edit');
  app.setLeads([reportedLead({ id: 'L1' })]);
  app.stubSaveAll(false);
  const ok = await app.saveMeetingReportEdit('L1', {
    outcome: 'undecided', companion: 'סבתא רבתא', note: '',
  });
  assert.strictEqual(ok, true);
  assert.strictEqual(app.getLead('L1').meetingCompanion, 'סבתא רבתא');
  assert.strictEqual(app.getLead('L1').meetingNote, '');
});

test('edit save rolls back on a failed save', async () => {
  app.setMode('edit');
  app.stubRenderAll();
  app.setLeads([reportedLead({ id: 'L1' })]);
  app.stubSaveAll(true);

  const ok = await app.saveMeetingReportEdit('L1', {
    outcome: 'no_show', companion: 'father', note: 'לא יישמר',
  });
  assert.strictEqual(ok, false);
  const lead = app.getLead('L1');
  assert.strictEqual(lead.meetingReportOutcome, 'advancing', 'outcome rolled back');
  assert.strictEqual(lead.meetingCompanion, 'mother', 'companion rolled back');
  assert.strictEqual(lead.meetingNote, 'שיחה טובה', 'note rolled back');
});

test('edit save is gated: viewers and report-less leads never write', async () => {
  app.setLeads([reportedLead({ id: 'L1' }), reportedLead({ id: 'L2', meetingReportedAt: '' })]);
  const calls = app.stubSaveAll(false);
  const edit = { outcome: 'no_show', companion: '', note: '' };

  app.setMode('view');
  assert.strictEqual(await app.saveMeetingReportEdit('L1', edit), false, 'viewer never writes');

  app.setMode('edit');
  assert.strictEqual(await app.saveMeetingReportEdit('L2', edit), false, 'no report → nothing to edit');
  assert.strictEqual(await app.saveMeetingReportEdit('nope', edit), false, 'unknown lead');
  assert.strictEqual(calls.length, 0, 'no saves fired');
});

/* ===== client-side validation (mirrors the PR-2 backend caps) ===== */

test('validateMeetingReportEdit: outcome must be one of the 4 report keys', () => {
  assert.strictEqual(app.validateMeetingReportEdit(
    { outcome: 'advancing', companion: 'mother', note: '' }), '');
  assert.notStrictEqual(app.validateMeetingReportEdit(
    { outcome: '', companion: '', note: '' }), '', 'missing outcome refused');
  assert.notStrictEqual(app.validateMeetingReportEdit(
    { outcome: 'entered', companion: '', note: '' }), '',
    'a meetings-board outcome key is NOT a report outcome key');
});

test('validateMeetingReportEdit: companion free text ≤ 100, note ≤ 2000 (presets exempt)', () => {
  const v = (companion, note) => app.validateMeetingReportEdit({ outcome: 'advancing', companion, note });
  assert.strictEqual(v('א'.repeat(100), ''), '', '100-char free text allowed');
  assert.notStrictEqual(v('א'.repeat(101), ''), '', '101 chars refused');
  assert.strictEqual(v('mother', 'ב'.repeat(2000)), '', '2000-char note allowed');
  assert.notStrictEqual(v('mother', 'ב'.repeat(2001)), '', '2001 chars refused');
  assert.strictEqual(v('', ''), '', 'blank companion allowed (form allows it)');
});

test('an invalid edit is refused before any save fires, surfacing a Hebrew error', async () => {
  app.setMode('edit');
  app.setLeads([reportedLead({ id: 'L1' })]);
  const calls = app.stubSaveAll(false);
  const errs = app.captureErrors();

  const ok = await app.saveMeetingReportEdit('L1', {
    outcome: 'advancing', companion: 'א'.repeat(101), note: '',
  });
  assert.strictEqual(ok, false);
  assert.strictEqual(calls.length, 0, 'no save fired');
  assert.strictEqual(errs.length, 1, 'error surfaced');
  assert.strictEqual(app.getLead('L1').meetingCompanion, 'mother', 'state untouched');
});

/* ===== delete ===== */

test('delete calls the dedicated backend action and clears the six local fields', async () => {
  app.setMode('edit');
  const original = reportedLead({ id: 'L1' });
  app.setLeads([JSON.parse(JSON.stringify(original))]);
  const saves = app.stubSaveAll(false);
  const actions = app.stubApiPost(false);

  const ok = await app.deleteMeetingReport('L1');
  assert.strictEqual(ok, true);

  // A dedicated action — NOT a saveAll field-clear (the merge guard would
  // resurrect the report from the sheet's newer timestamp).
  assert.strictEqual(saves.length, 0, 'no saveAll fired');
  assert.strictEqual(actions.length, 1, 'exactly one backend action');
  assert.strictEqual(actions[0].action, 'deleteMeetingReport');
  assert.strictEqual(actions[0].leadId, 'L1');

  // Local state cleared too, so this tab's next saveAll echoes the deletion
  // (empty timestamp on both sides → the guard is inert) instead of
  // re-sending the stale report values.
  const lead = app.getLead('L1');
  REPORT_FIELDS.forEach(f => assert.strictEqual(lead[f], '', `${f} cleared`));
  Object.keys(original).forEach(k => {
    if (REPORT_FIELDS.includes(k)) return;
    assert.strictEqual(lead[k], original[k], `${k} untouched`);
  });
});

test('after delete the lead can never count as unseen, and the badge recomputes optimistically', () => {
  app.setMode('edit');
  // An UNSEEN report — the strictest case: deleting it must drop the count.
  app.setLeads([reportedLead({ id: 'L1', meetingSeen: '' })]);
  app.stubApiPost(false);
  app.renderMeetingsUnseenBadge();
  const badge = byId['meetings-unseen-badge'];
  assert.strictEqual(badge.textContent, '1', 'unseen before delete');

  const p = app.deleteMeetingReport('L1');          // not awaited yet
  assert.strictEqual(app.meetingReportUnseen(app.getLead('L1')), false,
    'deleted report is not unseen');
  assert.strictEqual(badge.textContent, '0', 'badge recomputed before the action resolves');
  assert.strictEqual(badge.classList.contains('hidden'), true, 'badge hidden at zero');
  return p;
});

test('delete rolls back all six fields (and the badge) on a failed backend action', async () => {
  app.setMode('edit');
  app.stubRenderAll();
  const original = reportedLead({ id: 'L1', meetingSeen: '' }); // unseen → badge visible
  app.setLeads([JSON.parse(JSON.stringify(original))]);
  app.stubApiPost(true);
  app.renderMeetingsUnseenBadge();
  const badge = byId['meetings-unseen-badge'];

  const ok = await app.deleteMeetingReport('L1');
  assert.strictEqual(ok, false);
  const lead = app.getLead('L1');
  REPORT_FIELDS.forEach(f => assert.strictEqual(lead[f], original[f], `${f} restored`));
  assert.strictEqual(badge.textContent, '1', 'badge restored with the report');
});

test('delete is gated: viewers and report-less leads never call the backend', async () => {
  app.setLeads([reportedLead({ id: 'L1' }), reportedLead({ id: 'L2', meetingReportedAt: '' })]);
  const actions = app.stubApiPost(false);

  app.setMode('view');
  assert.strictEqual(await app.deleteMeetingReport('L1'), false, 'viewer never writes');

  app.setMode('edit');
  assert.strictEqual(await app.deleteMeetingReport('L2'), false, 'no report → nothing to delete');
  assert.strictEqual(await app.deleteMeetingReport('nope'), false, 'unknown lead');
  assert.strictEqual(actions.length, 0, 'no backend actions fired');
});

/* ===== the resubmit-during-edit race (merge-guard conflict) ===== */

test('edit save surfaces a conflict when the guard kept a newer report, and refreshes', async () => {
  app.setMode('edit');
  app.setLeads([reportedLead({ id: 'L1' })]);
  // The backend flags L1: its report timestamp no longer matches what the
  // edit carried (manager resubmitted or the report was deleted mid-edit).
  app.stubSaveAll(false, ['L1']);
  const loads = app.stubLoadAll();
  const errs = app.captureErrors();

  const res = await app.saveMeetingReportEdit('L1', {
    outcome: 'no_show', companion: 'father', note: 'לא יישמר',
  });
  assert.strictEqual(res, 'conflict');
  assert.strictEqual(errs.length, 1, 'a visible Hebrew message, not silent success');
  assert.ok(/דיווח/.test(errs[0]) && /לא נשמר/.test(errs[0]), 'message says the edit did not save');
  assert.strictEqual(loads.length, 1, 'data refreshed to show the newer report');
});

test('edit save ignores conflicts flagged for OTHER leads (routine stale echoes)', async () => {
  app.setMode('edit');
  app.setLeads([reportedLead({ id: 'L1' })]);
  app.stubSaveAll(false, ['L-other']);
  const loads = app.stubLoadAll();

  const res = await app.saveMeetingReportEdit('L1', {
    outcome: 'undecided', companion: 'mother', note: 'נשמר',
  });
  assert.strictEqual(res, true);
  assert.strictEqual(loads.length, 0, 'no refresh — this edit saved fine');
});

/* ===== outcome badge (PR 4 prominence) ===== */

test('meetingReportOutcomeBadgeClass: color per outcome key, neutral fallback', () => {
  assert.strictEqual(app.meetingReportOutcomeBadgeClass('advancing'), 'mrv-badge-advancing');
  assert.strictEqual(app.meetingReportOutcomeBadgeClass('undecided'), 'mrv-badge-undecided');
  assert.strictEqual(app.meetingReportOutcomeBadgeClass('not_fit'),   'mrv-badge-not_fit');
  assert.strictEqual(app.meetingReportOutcomeBadgeClass('no_show'),   'mrv-badge-no_show');
  assert.strictEqual(app.meetingReportOutcomeBadgeClass(''),          'mrv-badge-neutral');
  assert.strictEqual(app.meetingReportOutcomeBadgeClass('legacy???'), 'mrv-badge-neutral');
});

test('the block renders the outcome as a color-coded badge', () => {
  app.setMode('view');
  const html = app.meetingReportBlockHTML(reportedLead({ meetingReportOutcome: 'not_fit' }));
  assert.ok(html.includes('mrv-outcome-badge mrv-badge-not_fit'), 'badge class per outcome');
  assert.ok(html.includes('התקיימה — לא מתאים'), 'outcome label inside the badge');
});

/* ===== action buttons render in edit mode only ===== */

test('the block carries עריכה / מחיקת דיווח buttons only in edit mode', () => {
  app.setMode('edit');
  const editHtml = app.meetingReportBlockHTML(reportedLead());
  assert.ok(editHtml.includes('data-mrv-edit="L1"'), 'edit button carries the lead id');
  assert.ok(editHtml.includes('data-mrv-delete="L1"'), 'delete button carries the lead id');
  assert.ok(editHtml.includes('עריכה') && editHtml.includes('מחיקת דיווח'));

  app.setMode('view');
  const viewHtml = app.meetingReportBlockHTML(reportedLead());
  assert.ok(!viewHtml.includes('data-mrv-edit') && !viewHtml.includes('data-mrv-delete'),
    'no actions outside edit mode');
});
