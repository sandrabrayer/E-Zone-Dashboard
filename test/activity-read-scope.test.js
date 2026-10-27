'use strict';

/* B3 — permission-filtered Activity read `getActivity` (CHANGELOG-crm-activity-read.md,
 * docs/crm/ROLLOUT.md §B3).
 *
 * The REAL Code.gs in a vm with in-memory sheets, PROXY_SECRET in enforce mode.
 * Per-role matrix: Vered / Sandra (finance) → everything; Ortal (controller) →
 * money kinds only, no lead ids; Dana (no caps) → everything but money; an
 * unverified caller, a non-personal session and the healthcheck path. Names
 * are SYNTHETIC. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { richSheet, loadGs } = require('./helpers/gs-sandbox');
const scope = require('../lib/finance-scope');
const roleScope = require('../lib/role-scope');

const PROXY_SECRET = 'proxy-secret-TEST-activity-read-0123456789abcdef';
const plain = (x) => JSON.parse(JSON.stringify(x));
const gsActor = (id, user, roles, caps, auth) => ({
  proxySecret: PROXY_SECRET, proxyUser: user, user, proxyAuth: auth || 'personal', proxyUserId: id, proxyRoles: roles, proxyCaps: caps,
});
const VERED = () => gsActor('vered', 'ורד', ['staff', 'reporter', 'deleter'], ['finance', 'billingControl']);
const SANDRA = () => gsActor('sandra', 'סנדרה', ['staff', 'deleter', 'approver', 'viewer'], ['finance', 'billingControl']);
const ORTAL = () => gsActor('ortal', 'אורטל', ['controller'], ['billingControl']);
const DANA = () => gsActor('dana', 'דנה', ['staff'], []);
const SHARED = () => gsActor('', '', ['staff'], ['finance'], 'shared');

const ROWS = [
  { eventId: 'patient_discharged:id-p:2026-10-20', occurredAt: '2026-10-20T09:00:00.000Z', recordedAt: '2026-10-20T09:00:00.000Z', kind: 'patient_discharged', source: 'app:coordinators', actorId: 'rakaz:ramot', actorName: 'רכזת', leadId: 'L-1', patientId: 'id-p', personId: '', paymentUid: '', dischargeId: 'coord-id-p-2026-10-20', houseId: 'ramot', summary: 'שוחרר/ה מהבית', detailsJson: '{"dischargeDate":"2026-10-20"}', supersedesEventId: '' },
  { eventId: 'payment_reported:r-1', occurredAt: '2026-10-21T09:00:00.000Z', recordedAt: '2026-10-21T09:00:00.000Z', kind: 'payment_reported', source: 'system:reportPayment_', actorId: '', actorName: 'ורד', leadId: 'L-1', patientId: 'id-p', personId: '', paymentUid: 'pu-1', dischargeId: '', houseId: 'ramot', summary: 'דווח תשלום', detailsJson: '{"receiptId":"r-1"}', supersedesEventId: '' },
  { eventId: 'refund_paid:id-p:c-1', occurredAt: '2026-10-22T09:00:00.000Z', recordedAt: '2026-10-22T09:00:00.000Z', kind: 'refund_paid', source: 'system:settleRefund_', actorId: '', actorName: 'אורטל', leadId: '', patientId: 'id-p', personId: '', paymentUid: '', dischargeId: '', houseId: '', summary: 'הזיכוי שולם', detailsJson: '{"id":"c-1"}', supersedesEventId: '' },
  { eventId: 'lead_closed:L-1:not_relevant:x', occurredAt: '2026-10-19T09:00:00.000Z', recordedAt: '2026-10-19T09:00:00.000Z', kind: 'lead_closed', source: 'system:moveLeadIrrelevant_', actorId: '', actorName: 'ורד', leadId: 'L-1', patientId: '', personId: '', paymentUid: '', dischargeId: '', houseId: '', summary: 'הליד נסגר', detailsJson: 'not json', supersedesEventId: '' },
  { eventId: 'patient_discharged:id-other:2026-10-20', occurredAt: '2026-10-20T10:00:00.000Z', recordedAt: '2026-10-20T10:00:00.000Z', kind: 'patient_discharged', source: 'system:dischargePatient_', actorId: '', actorName: 'ורד', leadId: 'L-9', patientId: 'id-other', personId: '', paymentUid: '', dischargeId: '', houseId: 'asher', summary: 'x', detailsJson: '', supersedesEventId: '' },
];

function world(opts) {
  const o = opts || {};
  const g = loadGs({ props: { PROXY_SECRET, PROXY_SECRET_MODE: o.mode || 'enforce' } });
  const cols = Array.from(g.run('ACTIVITY_COLUMNS'));
  if (!o.noSheet) {
    const sh = richSheet('Activity', cols);
    ROWS.forEach((r) => sh.grid.push(cols.map((c) => r[c])));
    g.sandbox.__sheets.Activity = sh;
  }
  const call = (body, who) => plain(g.post(Object.assign({}, body, (who || VERED)())));
  return { g, call };
}
const kinds = (r) => r.events.map((e) => e.kind);

/* ===== lists ===== */

test('lists: getActivity is a known action, on CONTROLLER_ACTIONS (Code.gs = lib) and on ALL_USERS_READ_ACTIONS; never open', () => {
  const { g } = world();
  const known = Array.from(g.run('PROXY_KNOWN_ACTIONS'));
  assert.ok(known.includes('getActivity'));
  assert.ok(!Array.from(g.run('OPEN_ACTIONS')).includes('getActivity'), 'PROXY_SECRET-gated');
  assert.deepEqual(Array.from(g.run('CONTROLLER_ACTIONS')), [...scope.CONTROLLER_ACTIONS]);
  assert.ok(scope.CONTROLLER_ACTIONS.includes('getActivity'));
  assert.ok(roleScope.ALL_USERS_READ_ACTIONS.includes('getActivity'));
  assert.equal(roleScope.GET_ACTIVITY_ACTION, 'getActivity');
});

/* ===== gate ===== */

test('unverified caller → unauthorized, even in log mode; a non-personal verified session → forbidden', () => {
  for (const mode of ['enforce', 'log']) {
    const { g } = world({ mode });
    const none = plain(g.post({ action: 'getActivity', patientId: 'id-p' }));
    assert.equal(none.error, 'unauthorized', mode);
    const shared = plain(g.post(Object.assign({ action: 'getActivity', patientId: 'id-p' }, SHARED())));
    assert.equal(shared.error, 'forbidden', mode);
  }
});

test('a subject id is required — never the whole sheet', () => {
  const { call } = world();
  assert.equal(call({ action: 'getActivity' }).error, 'missing_subject');
  assert.equal(call({ action: 'getActivity', patientId: '  ' }).error, 'missing_subject');
});

/* ===== per-role matrix ===== */

test('Vered / Sandra (finance): every kind, every public field, newest first, details parsed; actorId never served', () => {
  const { call } = world();
  for (const who of [VERED, SANDRA]) {
    const r = call({ action: 'getActivity', patientId: 'id-p' }, who);
    assert.equal(r.ok, true);
    assert.equal(r.scope, 'full');
    assert.deepEqual(kinds(r), ['refund_paid', 'payment_reported', 'patient_discharged']);
    assert.equal(r.total, 3);
    const e = r.events[2];
    assert.deepEqual(Object.keys(e).sort(), ['actorName', 'details', 'dischargeId', 'eventId', 'houseId', 'kind', 'leadId',
      'occurredAt', 'patientId', 'paymentUid', 'personId', 'recordedAt', 'source', 'summary', 'supersedesEventId']);
    assert.ok(!('actorId' in e) && !('detailsJson' in e));
    assert.deepEqual(e.details, { dischargeDate: '2026-10-20' });
    assert.equal(e.leadId, 'L-1');
  }
});

test('Ortal (controller): money kinds ONLY and leadId ABSENT — the field is not in the object, not just empty', () => {
  const { call } = world();
  const r = call({ action: 'getActivity', patientId: 'id-p' }, ORTAL);
  assert.equal(r.ok, true);
  assert.equal(r.scope, 'money');
  assert.deepEqual(kinds(r), ['refund_paid', 'payment_reported']);
  for (const e of r.events) {
    assert.ok(!('leadId' in e), 'no lead data for the controller view');
    assert.ok(!('actorId' in e));
  }
  // by lead: a lead subject gives her nothing (she holds no lead id and the lead kinds are filtered)
  const byLead = call({ action: 'getActivity', leadId: 'L-1' }, ORTAL);
  assert.deepEqual(kinds(byLead), ['payment_reported'], 'only the money event that carries the lead id');
  assert.ok(!('leadId' in byLead.events[0]));
});

test('Dana (no caps): everything EXCEPT the money kinds', () => {
  const { call } = world();
  const r = call({ action: 'getActivity', patientId: 'id-p' }, DANA);
  assert.equal(r.scope, 'no_money');
  assert.deepEqual(kinds(r), ['patient_discharged']);
  const byLead = call({ action: 'getActivity', leadId: 'L-1' }, DANA);
  assert.deepEqual(kinds(byLead), ['patient_discharged', 'lead_closed']);
  assert.deepEqual(byLead.events[1].details, {}, 'unparseable detailsJson → {}');
});

test('subject matching: any of leadId / patientId / personId / paymentUid; other subjects are never returned', () => {
  const { call } = world();
  const byPay = call({ action: 'getActivity', paymentUid: 'pu-1' });
  assert.deepEqual(byPay.events.map((e) => e.eventId), ['payment_reported:r-1']);
  const other = call({ action: 'getActivity', patientId: 'id-other' });
  assert.deepEqual(other.events.map((e) => e.patientId), ['id-other']);
  const none = call({ action: 'getActivity', personId: 'nobody' });
  assert.deepEqual(none, { ok: true, scope: 'full', total: 0, events: [] });
});

test('limit: default 200, capped at 500, total reports the unlimited count', () => {
  const { call, g } = world();
  assert.equal(g.run('ACTIVITY_READ_DEFAULT'), 200);
  assert.equal(g.run('ACTIVITY_READ_MAX'), 500);
  const r = call({ action: 'getActivity', patientId: 'id-p', limit: 1 });
  assert.equal(r.events.length, 1);
  assert.equal(r.total, 3);
  assert.equal(r.events[0].kind, 'refund_paid', 'newest first');
  assert.equal(call({ action: 'getActivity', patientId: 'id-p', limit: 'x' }).events.length, 3);
});

/* ===== read-only ===== */

test('a read never creates the Activity sheet and writes nothing', () => {
  const { call, g } = world({ noSheet: true });
  const r = call({ action: 'getActivity', patientId: 'id-p' });
  assert.deepEqual(r, { ok: true, scope: 'full', total: 0, events: [] });
  assert.equal(g.sandbox.__sheets.Activity, undefined);
  const w = world();
  const before = JSON.stringify(w.g.sandbox.__sheets.Activity.grid);
  w.call({ action: 'getActivity', patientId: 'id-p' }, ORTAL);
  assert.equal(JSON.stringify(w.g.sandbox.__sheets.Activity.grid), before);
});

test('pure projection: activityProject_ drops rows by scope and omits fields — never blanks them', () => {
  const { g } = world();
  const rows = ROWS.map((r) => Object.assign({}, r));
  const money = plain(g.sandbox.activityProject_(rows, { patientId: 'id-p' }, 'money', 10));
  assert.ok(money.events.every((e) => /^(payment_|refund_)/.test(e.kind) && !('leadId' in e)));
  const noMoney = plain(g.sandbox.activityProject_(rows, { patientId: 'id-p' }, 'no_money', 10));
  assert.ok(noMoney.events.every((e) => !/^(payment_|refund_)/.test(e.kind) && 'leadId' in e));
  assert.equal(g.sandbox.activityScope_({ caps: ['finance'] }), 'full');
  assert.equal(g.sandbox.activityScope_({ caps: ['billingControl'] }), 'money');
  assert.equal(g.sandbox.activityScope_({ caps: [] }), 'no_money');
  assert.equal(g.sandbox.activityScope_(null), 'no_money');
});
