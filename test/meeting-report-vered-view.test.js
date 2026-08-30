/* Tests for Vered's manager-report view (public/app.js — PR 3):
 *
 *   - the unseen predicate + count-badge logic;
 *   - the companion display rule (preset key → Hebrew label, free text
 *     verbatim, and ESCAPED when rendered);
 *   - meetingReportBlockHTML renders ONLY when meetingReportedAt is set,
 *     carries the outcome label / note / reporter / timestamp, and shows the
 *     unseen dot only while unseen;
 *   - the meetings-board bucketing carries the report fields so rows can
 *     render the block;
 *   - markMeetingReportSeen: optimistic write of meetingSeen='1' through the
 *     REAL updateLead→saveAll path (stubbed saveAll), rollback on failure,
 *     whole-row preservation, edit-mode gating, and no-op when already seen.
 *
 * Drives the real shipped functions in the repo's vm-sandbox (same load as
 * meetingwith-autosave.test.js). saveAll is reassigned to capture what would
 * be persisted; renderAll/showError are stubbed so the rollback path runs
 * without a DOM. */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadApp() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const epilogue = `
    globalThis.__test = {
      meetingReportUnseen: (l) => meetingReportUnseen(l),
      countUnseenMeetingReports: (ls) => countUnseenMeetingReports(ls),
      meetingReportCompanionDisplay: (v) => meetingReportCompanionDisplay(v),
      meetingReportWhenText: (iso) => meetingReportWhenText(iso),
      meetingReportBlockHTML: (l) => meetingReportBlockHTML(l),
      meetingsForWeek: (ls, wk) => meetingsForWeek(ls, wk),
      markMeetingReportSeen: (id) => markMeetingReportSeen(id),
      renderMeetingsUnseenBadge: () => renderMeetingsUnseenBadge(),
      setLeads(ls) { state.leads = ls; },
      setMode(m) { state.mode = m; },
      getLead(id) { return state.leads.find(l => l.id === id); },
      /* Capture what saveAll would persist (deep copy of state.leads at call
       * time) — proves the mark-seen write carries the WHOLE row. */
      stubSaveAll(fail) {
        const calls = [];
        saveAll = async () => {
          calls.push(JSON.parse(JSON.stringify(state.leads)));
          if (fail) throw new Error('save failed');
        };
        return calls;
      },
      /* The rollback path calls renderAll + showError; neither has a DOM here. */
      stubRenderAll() { renderAll = () => {}; showError = () => {}; },
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
    document: {
      addEventListener: noop,
      getElementById: (id) => (id === 'meetings-unseen-badge' ? (byId[id] || (byId[id] = fakeEl())) : null),
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
    meetingReportedAt: '2026-08-29T10:15:00.000Z', meetingSeen: '',
  }, over || {});
}

/* ===== unseen predicate ===== */

test('unseen: no report → false; report + seen="" → true; seen="1" → false', () => {
  assert.strictEqual(app.meetingReportUnseen(reportedLead({ meetingReportedAt: '' })), false,
    'empty reportedAt is never unseen');
  assert.strictEqual(app.meetingReportUnseen(reportedLead({ meetingSeen: '' })), true);
  assert.strictEqual(app.meetingReportUnseen(reportedLead({ meetingSeen: '1' })), false);
  assert.strictEqual(app.meetingReportUnseen(null), false);
  assert.strictEqual(app.meetingReportUnseen({}), false, 'legacy lead with no report fields');
});

test('a manager RESUBMISSION (meetingSeen reset to "") makes the lead unseen again', () => {
  // PR 2's submit resets meetingSeen to '' on every write — the cue must return.
  const l = reportedLead({ meetingSeen: '1' });
  assert.strictEqual(app.meetingReportUnseen(l), false);
  l.meetingSeen = '';                                  // manager resubmitted
  assert.strictEqual(app.meetingReportUnseen(l), true);
});

/* ===== count badge ===== */

test('countUnseenMeetingReports counts only unseen-report leads', () => {
  const leads = [
    reportedLead({ id: 'a' }),                             // unseen
    reportedLead({ id: 'b', meetingSeen: '1' }),           // seen
    reportedLead({ id: 'c', meetingReportedAt: '' }),      // no report
    reportedLead({ id: 'd' }),                             // unseen
  ];
  assert.strictEqual(app.countUnseenMeetingReports(leads), 2);
  assert.strictEqual(app.countUnseenMeetingReports([]), 0);
  assert.strictEqual(app.countUnseenMeetingReports(null), 0);
});

test('the tab badge hides at zero and shows the count otherwise', () => {
  app.setLeads([reportedLead({ id: 'a' }), reportedLead({ id: 'b' })]);
  app.renderMeetingsUnseenBadge();
  const badge = byId['meetings-unseen-badge'];
  assert.strictEqual(badge.textContent, '2');
  assert.strictEqual(badge.classList.contains('hidden'), false, 'visible when > 0');

  app.setLeads([reportedLead({ id: 'a', meetingSeen: '1' })]);
  app.renderMeetingsUnseenBadge();
  assert.strictEqual(badge.classList.contains('hidden'), true, 'hidden at zero');
});

/* ===== companion display ===== */

test('companion display: preset key → Hebrew label; free text verbatim; blank → em dash', () => {
  assert.strictEqual(app.meetingReportCompanionDisplay('mother'), 'אמא');
  assert.strictEqual(app.meetingReportCompanionDisplay('partner'), 'בן/בת זוג');
  assert.strictEqual(app.meetingReportCompanionDisplay('other'), 'אחר');
  assert.strictEqual(app.meetingReportCompanionDisplay('סבתא רבתא'), 'סבתא רבתא');
  assert.strictEqual(app.meetingReportCompanionDisplay(''), '—');
});

/* ===== report block rendering ===== */

test('the report block renders ONLY when meetingReportedAt is non-empty', () => {
  assert.strictEqual(app.meetingReportBlockHTML(reportedLead({ meetingReportedAt: '' })), '');
  assert.strictEqual(app.meetingReportBlockHTML({}), '');
  const html = app.meetingReportBlockHTML(reportedLead());
  assert.ok(html.includes('דיווח מנהל'));
});

test('the block carries the outcome label, companion label, note, reporter and lead id', () => {
  const html = app.meetingReportBlockHTML(reportedLead());
  assert.ok(html.includes('התקיימה — מתקדם לכניסה'), 'outcome label from MEETING_REPORT_OUTCOME_LABELS');
  assert.ok(html.includes('הגיע/ה עם:'));
  assert.ok(html.includes('אמא'), 'preset companion renders its label');
  assert.ok(html.includes('שיחה טובה'), 'note text');
  assert.ok(html.includes('חנן'), 'reporter name');
  assert.ok(html.includes('data-mrv-toggle="L1"'), 'toggle carries the lead id');
  assert.ok(html.includes('29/08/2026'), 'reported date formatted DD/MM/YYYY');
});

test('the unseen dot renders only while unseen', () => {
  const unseen = app.meetingReportBlockHTML(reportedLead());
  assert.ok(unseen.includes('mrv-dot') && unseen.includes('mrv-unseen'));
  const seen = app.meetingReportBlockHTML(reportedLead({ meetingSeen: '1' }));
  assert.ok(!seen.includes('mrv-dot') && !seen.includes('mrv-unseen'));
});

test('free-text companion and note are HTML-escaped in the block', () => {
  const html = app.meetingReportBlockHTML(reportedLead({
    meetingCompanion: '<b>סבתא</b>',
    meetingNote: '<script>x</script>',
  }));
  assert.ok(html.includes('&lt;b&gt;סבתא&lt;/b&gt;'), 'companion free text escaped');
  assert.ok(html.includes('&lt;script&gt;x&lt;/script&gt;'), 'note escaped');
  assert.ok(!html.includes('<b>סבתא</b>') && !html.includes('<script>'));
});

test('meetingReportWhenText: ISO timestamp → "DD/MM/YYYY HH:MM"; garbage falls back raw', () => {
  const txt = app.meetingReportWhenText('2026-08-29T10:15:00.000Z');
  assert.ok(/^29\/08\/2026 \d{2}:\d{2}$/.test(txt), 'got: ' + txt);
  assert.strictEqual(app.meetingReportWhenText(''), '');
  assert.strictEqual(app.meetingReportWhenText('not-a-date'), 'not-a-date');
});

/* ===== board bucketing carries the report fields ===== */

test('meetingsForWeek meeting objects carry the manager-report fields', () => {
  const wk = app.meetingsForWeek([reportedLead({ visitDate: '2026-08-25' })], '2026-08-25');
  const m = wk.days[0].timed[0];
  assert.strictEqual(m.meetingReportedAt, '2026-08-29T10:15:00.000Z');
  assert.strictEqual(m.meetingReportOutcome, 'advancing');
  assert.strictEqual(m.meetingCompanion, 'mother');
  assert.strictEqual(m.meetingNote, 'שיחה טובה');
  assert.strictEqual(m.meetingReporter, 'חנן');
  assert.strictEqual(m.meetingSeen, '');
});

/* ===== mark-seen: optimistic + rollback + whole-row preservation ===== */

test('mark-seen writes meetingSeen="1" once, preserving every other field on the row', async () => {
  app.setMode('edit');
  app.setLeads([reportedLead({ id: 'L1' }), reportedLead({ id: 'L2', meetingReportedAt: '' })]);
  const calls = app.stubSaveAll(false);

  const ok = await app.markMeetingReportSeen('L1');
  assert.strictEqual(ok, true);
  assert.strictEqual(app.getLead('L1').meetingSeen, '1');
  assert.strictEqual(calls.length, 1, 'exactly one save');

  // The persisted snapshot carries the WHOLE lead — no field drop.
  const sent = calls[0].find(l => l.id === 'L1');
  assert.strictEqual(sent.meetingSeen, '1');
  assert.strictEqual(sent.name, 'דני');
  assert.strictEqual(sent.phone, '0501234567');
  assert.strictEqual(sent.note, 'הערה פנימית');
  assert.strictEqual(sent.meetingReportOutcome, 'advancing');
  assert.strictEqual(sent.meetingNote, 'שיחה טובה');
  assert.strictEqual(sent.meetingReporter, 'חנן');
  assert.strictEqual(sent.meetingReportedAt, '2026-08-29T10:15:00.000Z');
  assert.strictEqual(sent.contactPhone, '0521111111');
});

test('mark-seen is optimistic: the badge clears BEFORE the save resolves', () => {
  app.setMode('edit');
  app.setLeads([reportedLead({ id: 'L1' })]);
  app.stubSaveAll(false);
  const p = app.markMeetingReportSeen('L1');            // not awaited yet
  assert.strictEqual(app.getLead('L1').meetingSeen, '1', 'state flips synchronously');
  const badge = byId['meetings-unseen-badge'];
  assert.strictEqual(badge.classList.contains('hidden'), true, 'badge already cleared');
  return p;
});

test('mark-seen rolls back on a failed save', async () => {
  app.setMode('edit');
  app.stubRenderAll();                                  // rollback path renders + errors
  app.setLeads([reportedLead({ id: 'L1' })]);
  app.stubSaveAll(true);                                // saveAll throws

  const ok = await app.markMeetingReportSeen('L1');
  assert.strictEqual(ok, false);
  assert.strictEqual(app.getLead('L1').meetingSeen, '', 'rolled back to unseen');
});

test('mark-seen no-ops for viewers, for already-seen reports, and for unknown leads', async () => {
  app.setLeads([reportedLead({ id: 'L1' })]);
  const calls = app.stubSaveAll(false);

  app.setMode('view');
  assert.strictEqual(await app.markMeetingReportSeen('L1'), false, 'viewer never writes');
  assert.strictEqual(app.getLead('L1').meetingSeen, '');

  app.setMode('edit');
  app.setLeads([reportedLead({ id: 'L1', meetingSeen: '1' })]);
  assert.strictEqual(await app.markMeetingReportSeen('L1'), false, 'already seen → no write');
  assert.strictEqual(await app.markMeetingReportSeen('nope'), false, 'unknown lead → no write');
  assert.strictEqual(calls.length, 0, 'no saves fired');
});
