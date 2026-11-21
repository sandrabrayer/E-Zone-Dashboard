'use strict';

/* An INCOMING contact is documented like an outgoing call, and the lead card shows
 * its details first (CHANGELOG-crm-incoming-contact.md).
 *   - server: the REAL Code.gs in a vm with in-memory sheets (PROXY_SECRET enforced);
 *   - client: the pure core of public/crm/crm.js, plus source pins for the markup. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const core = require('../public/crm/crm.js');
const { loadGs } = require('./helpers/gs-sandbox');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'crm', 'crm.js'), 'utf8');
const CSS = fs.readFileSync(path.join(__dirname, '..', 'public', 'crm', 'crm.css'), 'utf8');
const PROXY_SECRET = 'proxy-secret-TEST-incoming-0123456789abcdef01';
const TODAY = '2026-11-21';
const plain = (x) => JSON.parse(JSON.stringify(x));
const actor = (id, user, roles, caps) => ({ proxySecret: PROXY_SECRET, proxyUser: user, user, proxyAuth: 'personal', proxyUserId: id, proxyRoles: roles, proxyCaps: caps });
const VERED = () => actor('vered', 'ורד', ['staff', 'reporter', 'deleter'], ['finance', 'billingControl']);
const SID = (n) => 'sub-' + String(n).padStart(32, '0');

function world() {
  const g = loadGs({ props: { PROXY_SECRET, PROXY_SECRET_MODE: 'enforce' } });
  const call = (body, who) => plain(g.post(Object.assign({}, body, (who || VERED)())));
  const activity = () => g.sheetRows('Activity', 'ACTIVITY_COLUMNS');
  const tasks = () => g.sheetRows('Tasks', 'TASK_COLUMNS');
  return { g, call, activity, tasks };
}
const detailsOf = (row) => JSON.parse(row.detailsJson);

/* ---------------- server ---------------- */

test('Code.gs lists: directions are out / in; the new outcome sits in CONTACT_OUTCOMES and has a Hebrew label; the client mirrors both (ids and order)', () => {
  const g = loadGs({ props: {} });
  assert.deepEqual(Array.from(g.run('CONTACT_DIRECTIONS')), ['out', 'in']);
  assert.ok(Array.from(g.run('CONTACT_OUTCOMES')).includes('spoke_no_follow_up'));
  assert.deepEqual(core.CONTACT_DIRECTIONS.map((d) => d.id), Array.from(g.run('CONTACT_DIRECTIONS')));
  assert.deepEqual(core.CONTACT_OUTCOMES.map((o) => o.id), Array.from(g.run('CONTACT_OUTCOMES')));
  assert.equal(core.contactOutcomeLabel('spoke_no_follow_up'), 'התקיימה שיחה — לא נדרש המשך');
  assert.equal(core.NO_FOLLOW_UP_TEXT, g.run('CONTACT_NO_FOLLOW_UP_TEXT'), 'one default explanation on both sides');
});

test('logContact direction "in": saved in the event details, the timeline summary says «פנייה נכנסת», the audit row carries it; nothing else about the event changes', () => {
  const w = world();
  const r = w.call({ action: 'logContact', submissionId: SID(1), contact: { leadId: 'L1', direction: 'in', channel: 'phone', withWhom: 'המטופל', outcome: 'spoke_follow_up', summary: 'שאל על עלויות' }, next: { days: 3 } });
  assert.equal(r.ok, true);
  assert.equal(r.event.kind, 'contact_logged');
  assert.equal(r.event.summary, 'פנייה נכנסת · התקיימה שיחה ונדרש המשך · שאל על עלויות');
  const rows = w.activity().filter((x) => x.kind === 'contact_logged');
  assert.equal(rows.length, 1);
  assert.equal(detailsOf(rows[0]).direction, 'in');
  assert.equal(detailsOf(rows[0]).withWhom, 'המטופל');
  assert.equal(rows[0].source, 'manual');
  assert.equal(r.created.kind, 'call', 'the follow-up is created exactly as for an outgoing call');
  const read = w.call({ action: 'getActivity', leadId: 'L1' });
  assert.equal(read.events[0].details.direction, 'in', 'the card reads the direction back');
});

test('logContact without a direction (an older client) is an outgoing call: details.direction "out", no prefix', () => {
  const w = world();
  const r = w.call({ action: 'logContact', submissionId: SID(2), contact: { leadId: 'L1', outcome: 'no_answer' }, next: { days: 1 } });
  assert.equal(r.ok, true);
  assert.equal(r.event.summary, 'לא היה מענה');
  assert.equal(detailsOf(w.activity().filter((x) => x.kind === 'contact_logged')[0]).direction, 'out');
});

test('logContact refuses an unknown direction (fail closed) and writes nothing', () => {
  const w = world();
  for (const bad of ['both', 'IN', '<script>', 7]) {
    const r = w.call({ action: 'logContact', submissionId: SID(3), contact: { leadId: 'L1', direction: bad, outcome: 'no_answer' }, next: { days: 1 } });
    assert.equal(r.ok, false, String(bad));
    assert.equal(r.error, 'bad_direction');
    assert.equal(r.message, 'כיוון הפנייה לא מוכר');
  }
  assert.equal(w.activity().filter((x) => x.kind === 'contact_logged').length, 0);
  assert.equal(w.tasks().length, 0);
});

test('«לא נדרש המשך»: with next.none the explanation may be empty (the default text is stored); every OTHER outcome still must explain why there is no follow-up', () => {
  const w = world();
  const ok = w.call({ action: 'logContact', submissionId: SID(4), contact: { leadId: 'L1', direction: 'in', outcome: 'spoke_no_follow_up', summary: 'שאל שאלה כללית' }, next: { none: true, explanation: '' } });
  assert.equal(ok.ok, true);
  assert.equal(ok.created, null, 'no follow-up task');
  assert.equal(detailsOf(w.activity().filter((x) => x.kind === 'contact_logged')[0]).noNext, 'לא נדרש המשך');
  const typed = w.call({ action: 'logContact', submissionId: SID(5), contact: { leadId: 'L1', outcome: 'spoke_no_follow_up' }, next: { none: true, explanation: 'המשפחה תחזור אלינו' } });
  assert.equal(typed.ok, true);
  assert.equal(detailsOf(w.activity().filter((x) => x.eventId === 'contact:' + SID(5))[0]).noNext, 'המשפחה תחזור אלינו', 'a typed explanation wins');
  const refused = w.call({ action: 'logContact', submissionId: SID(6), contact: { leadId: 'L1', direction: 'in', outcome: 'spoke_follow_up' }, next: { none: true, explanation: '' } });
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'missing_next_explanation');
});

/* ---------------- client: the pure core ---------------- */

test('contactOutcomesFor: an incoming contact does not offer «לא היה מענה» / «פרטי הקשר אינם תקינים»; an outgoing call offers the full list', () => {
  const inIds = core.contactOutcomesFor('in').map((o) => o.id);
  assert.ok(!inIds.includes('no_answer')); assert.ok(!inIds.includes('bad_contact_details'));
  assert.ok(inIds.includes('spoke_no_follow_up') && inIds.includes('meeting_set') && inIds.includes('spoke_follow_up'));
  assert.deepEqual(core.contactOutcomesFor('out').map((o) => o.id), core.CONTACT_OUTCOMES.map((o) => o.id));
  assert.equal(core.contactDirection({ direction: 'in' }), 'in');
  assert.equal(core.contactDirection({}), 'out'); assert.equal(core.contactDirection({ direction: 'zzz' }), 'out'); assert.equal(core.contactDirection(null), 'out');
});

test('contactErrors: a direction outside the list is an error; an outgoing-only outcome is refused for an incoming contact; «לא נדרש המשך» + «ללא משימת המשך» needs no explanation, any other outcome does', () => {
  const base = { direction: 'in', when: TODAY, channel: 'phone', outcome: 'spoke_follow_up', next: 'd3' };
  assert.deepEqual(core.contactErrors(base, TODAY), {});
  assert.ok(core.contactErrors(Object.assign({}, base, { direction: 'sideways' }), TODAY).direction);
  assert.ok(core.contactErrors(Object.assign({}, base, { outcome: 'no_answer' }), TODAY).outcome, 'not an incoming outcome');
  assert.deepEqual(core.contactErrors(Object.assign({}, base, { direction: 'out', outcome: 'no_answer' }), TODAY), {});
  assert.deepEqual(core.contactErrors(Object.assign({}, base, { outcome: 'spoke_no_follow_up', next: 'none' }), TODAY), {});
  assert.match(core.contactErrors(Object.assign({}, base, { next: 'none' }), TODAY).next, /חובה להסביר/);
  assert.deepEqual(core.contactErrors({ when: TODAY, channel: 'phone', outcome: 'no_answer', next: 'd1' }, TODAY), {}, 'no direction = an outgoing call, as before');
});

test('contactBody: the direction is sent; «לא נדרש המשך» sends none with the default explanation, a typed one wins; the follow-up of an incoming contact is built like any other', () => {
  const sid = core.newSubmissionId();
  const none = core.contactBody({ leadId: 'L1' }, { direction: 'in', when: TODAY, channel: 'phone', outcome: 'spoke_no_follow_up', summary: 'בירור', next: 'none' }, sid, '', TODAY, 'ורד');
  assert.equal(none.action, 'logContact');
  assert.equal(none.contact.direction, 'in');
  assert.deepEqual(none.next, { none: true, explanation: 'לא נדרש המשך' });
  const typed = core.contactBody({ leadId: 'L1' }, { direction: 'in', when: TODAY, channel: 'phone', outcome: 'spoke_no_follow_up', next: 'none', nextExplanation: 'יחזור אלינו' }, sid, '', TODAY, 'ורד');
  assert.equal(typed.next.explanation, 'יחזור אלינו');
  const follow = core.contactBody({ leadId: 'L1' }, { direction: 'in', when: TODAY, channel: 'whatsapp', outcome: 'call_back_later', next: 'd1' }, sid, '', TODAY, 'דנה');
  assert.equal(follow.next.dueDate, '2026-11-22'); assert.equal(follow.next.assignee, 'דנה');
  assert.equal(core.contactBody({ patientId: 'p1' }, { when: TODAY, channel: 'phone', outcome: 'no_answer', next: 'd1' }, sid, '', TODAY, '').contact.direction, 'out');
});

test('recentContacts: only contact_logged events, newest first, capped; the direction comes from the details (missing = outgoing); hostile text is carried as text, never interpreted', () => {
  const events = [
    { kind: 'lead_stage_changed', occurredAt: '2026-11-21T10:00:00.000Z', summary: 'שלב' },
    { kind: 'contact_logged', occurredAt: '2026-11-18T08:00:00.000Z', actorName: 'ורד', summary: 'לא היה מענה', details: { outcome: 'no_answer' } },
    { kind: 'contact_logged', occurredAt: '2026-11-21T09:00:00.000Z', actorName: 'סנדרה', summary: 'x', details: { direction: 'in', outcome: 'spoke_no_follow_up', summary: '<img src=x onerror=1>' } },
    { kind: 'contact_logged', occurredAt: '2026-11-19T09:00:00.000Z', actorName: 'ורד', summary: 'ישן · ללא פרטים' },
    null,
  ];
  const r = core.recentContacts(events, 2);
  assert.equal(r.total, 3);
  assert.deepEqual(r.items.map((x) => x.at), ['2026-11-21T09:00:00.000Z', '2026-11-19T09:00:00.000Z']);
  assert.deepEqual(r.items[0], { at: '2026-11-21T09:00:00.000Z', actorName: 'סנדרה', direction: 'in', outcome: 'spoke_no_follow_up', text: 'התקיימה שיחה — לא נדרש המשך · <img src=x onerror=1>' });
  assert.equal(r.items[1].direction, 'out'); assert.equal(r.items[1].text, 'ישן · ללא פרטים', 'an event without details falls back to its summary');
  assert.equal(core.recentContacts(events).items.length, 3, 'default cap is 3');
  assert.deepEqual(core.recentContacts(null, 3), { total: 0, items: [] });
  assert.match(SRC, /'<div>' \+ esc\(x\.text\) \+ '<\/div><\/li>'/, 'the recent-contact text is escaped on render');
});

test('meetingWithLabel: «נפגש/ת עם» only after an outcome of a meeting that was HELD; a manager picked at lead creation reads «פגישה מיועדת עם»', () => {
  assert.equal(core.meetingWithLabel({ meetingWith: 'רנטה' }), 'פגישה מיועדת עם');
  assert.equal(core.meetingWithLabel({ meetingWith: 'רנטה', visitDate: '2026-11-25' }), 'פגישה מיועדת עם', 'a date alone is not a held meeting');
  for (const o of ['postponed', 'cancelled', 'not_relevant']) assert.equal(core.meetingWithLabel({ meetingOutcome: o }), 'פגישה מיועדת עם', o);
  for (const o of ['entered', 'thinking']) assert.equal(core.meetingWithLabel({ meetingOutcome: o }), 'נפגש/ת עם', o);
  assert.equal(core.meetingWithLabel(null), 'פגישה מיועדת עם');
});

test('leadOverviewGroups: contact → status → meeting → notes; empty values and empty groups are dropped; no visit date and no outcome = «לא נקבעה»', () => {
  const lead = { id: 'L1', name: 'פלוני', phone: '0501234567', house: 'rehab', source: 'גוגל', assignedTo: 'ורד', stage: 'new', created: '2026-11-18', meetingWith: 'רנטה', contactName: 'פלוני', contactRelation: 'מטופל', note: 'הערה' };
  const g = core.leadOverviewGroups(lead);
  assert.deepEqual(g.map((x) => x.title), ['פרטי קשר', 'סטטוס', 'פגישה', 'הערות']);
  assert.deepEqual(g[0].rows, [['טלפון', '0501234567'], ['איש קשר', 'פלוני (מטופל)']]);
  assert.deepEqual(g[1].rows.map((r) => r[0]), ['שלב', 'בית', 'אחראי', 'מקור', 'נוצר']);
  assert.deepEqual(g[1].rows[5 - 1], ['נוצר', '18/11/2026']);
  assert.deepEqual(g[2].rows, [['פגישה', 'לא נקבעה'], ['פגישה מיועדת עם', 'רנטה']], 'a chosen manager no longer reads as a meeting that took place');
  assert.deepEqual(g[3].rows, [['הערות', 'הערה']]);

  const set = core.leadOverviewGroups(Object.assign({}, lead, { visitDate: '2026-11-25', visitTime: '10:30' }));
  assert.deepEqual(set[2].rows[0], ['פגישה', '25/11/2026 10:30']);
  const held = core.leadOverviewGroups(Object.assign({}, lead, { visitDate: '2026-11-25', meetingOutcome: 'entered' }));
  assert.deepEqual(held[2].rows.map((r) => r[0]), ['פגישה', 'נפגש/ת עם', 'תוצאת פגישה']);
  const bare = core.leadOverviewGroups({ id: 'L2', phone: '050', stage: 'new' });
  assert.deepEqual(bare.map((x) => x.title), ['פרטי קשר', 'סטטוס', 'פגישה'], 'no notes group without a note');
  assert.deepEqual(core.leadOverviewGroups(null), [{ title: 'פגישה', rows: [['פגישה', 'לא נקבעה']] }], 'a missing lead never throws');
});

/* ---------------- client: the markup ---------------- */

test('the card: details render before the actions, every value escaped; «פנו אלינו» sits next to «תיעוד שיחה» and is hidden from the controller view with it', () => {
  const overview = SRC.slice(SRC.indexOf("'<section data-pane=\"overview\">"), SRC.indexOf("'<section data-pane=\"tasks\""));
  assert.ok(overview.indexOf('leadOverviewGroups(lead)') > 0);
  assert.ok(overview.indexOf('leadOverviewGroups(lead)') < overview.indexOf('renderLeadActions(lead)'), 'details first');
  assert.ok(overview.indexOf('id="crm-recent"') < overview.indexOf('renderLeadActions(lead)'), 'then the documented contacts, then the actions');
  assert.match(overview, /'<dt class="kv-h">' \+ esc\(g\.title\)/);
  assert.match(overview, /'<dt>' \+ esc\(x\[0\]\) \+ '<\/dt><dd>' \+ esc\(x\[1\]\) \+ '<\/dd>'/);
  assert.match(overview, /state\.me\.view === 'controller' \? '' : '<div class="group-title">שיחות ופניות אחרונות/, 'the controller view (money-only activity) gets no contact block');
  assert.match(SRC, /state\.me\.view === 'controller' \? '' : '<button type="button" class="btn small primary" data-contact-open="' \+ esc\(kind \+ ':' \+ id\) \+ '">📞 תיעוד שיחה<\/button><button type="button" class="btn small" data-contact-open="' \+ esc\(kind \+ ':' \+ id\) \+ '" data-contact-dir="in">📥 פנו אלינו<\/button>'/);
  assert.match(SRC, /openContactPanel\(p\[0\], p\.slice\(1\)\.join\(':'\), t\.dataset\.taskId \|\| '', t\.dataset\.contactDir \|\| ''\)/);
});

test('the panel: a direction radio (outgoing pre-chosen — the old behaviour), wording per direction, the outcome list rebuilt on a switch; «קשר הבא» still has no pre-checked radio', () => {
  assert.match(SRC, /name="direction" value="' \+ d\.id \+ '"' \+ \(d\.id === dir \? ' checked' : ''\)/);
  assert.match(SRC, /const dir = direction === 'in' \? 'in' : 'out';/, 'anything but "in" opens as an outgoing call');
  assert.deepEqual(core.CONTACT_DIR_TEXT.title, { out: 'תיעוד שיחה', in: 'תיעוד פנייה נכנסת' });
  assert.deepEqual(core.CONTACT_DIR_TEXT.withWhom, { out: 'עם מי', in: 'מי פנה' });
  assert.match(SRC, /if \(f && ev\.target\.name === 'direction'\) applyContactDirection\(f\);/);
  assert.match(SRC, /sel\.innerHTML = contactOutcomeOptions\(dir, sel\.value\)/);
  assert.match(SRC, /contactOutcomesFor\(dir\)\.map\(function \(o\) \{ return '<option value="' \+ o\.id \+ '"'[^;]*esc\(o\.label\)/, 'option labels escaped');
  assert.ok(!/name="next"[^>]*checked/.test(SRC), 'no «קשר הבא» radio is pre-checked in the markup (spec §8)');
  assert.match(SRC, /ev\.target\.value === NO_FOLLOW_UP_OUTCOME && f\.elements\.next\) f\.elements\.next\.value = 'none'/, 'choosing «לא נדרש המשך» answers «קשר הבא»');
  assert.match(SRC, /state\.drawer = \{ kind: back\.kind, id: back\.id, tab: back\.taskId \|\| res\.created \? 'tasks' : 'overview' \}/, 'a save with no task and no follow-up returns to the overview, where the record shows; otherwise to «משימות» as before');
});

test('in-card jumps: only known tabs can be opened by data-tab-go; the meetings pane offers «תיאום פגישה» on a lead card only and labels the manager by the held-meeting rule', () => {
  assert.match(SRC, /const TAB_GO_ALLOWED = \['overview', 'tasks', 'activity', 'meetings'\];/);
  assert.match(SRC, /TAB_GO_ALLOWED\.indexOf\(want\) >= 0 \? doc\.querySelector/);
  assert.match(SRC, /if \(canSchedule\) html \+= '<p><button type="button" class="btn small primary" data-meeting-go>'/);
  assert.match(SRC, /renderMeetings\(meetingsFor\([^;]*\), !!lead && !\(state\.me && state\.me\.view === 'controller'\)\)/);
  assert.match(SRC, /esc\(meetingWithLabel\(\{ meetingOutcome: m\.visit\.outcome \}\)\)/);
  assert.match(CSS, /\.kv dt\.kv-h \{[^}]*grid-column: 1 \/ -1/);
  assert.match(CSS, /\.drawer-head \.toolbar \{ flex-wrap: wrap;/, 'two buttons wrap on a phone instead of overflowing');
});
