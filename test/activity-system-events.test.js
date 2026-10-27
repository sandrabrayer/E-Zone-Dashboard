'use strict';

/* B2 — system events dual-written from the existing writers, behind the
 * ACTIVITY_WRITES kill switch (CHANGELOG-crm-activity-system-events.md,
 * docs/crm/ROLLOUT.md §B2).
 *
 * The REAL Code.gs in a vm with in-memory sheets. The hook lives in
 * logAudit_, so every writer that audits itself gets its event for free.
 * Names are SYNTHETIC. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { GS_SRC, richSheet, loadGs } = require('./helpers/gs-sandbox');

const COORD_SECRET = 'coord-secret-CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';
const TODAY = new Date().toISOString().slice(0, 10);

function patientRow(o) {
  return [o.houseId, o.name, o.date || '2026-09-01', 29000, 0, o.status || 'active',
    o.fromLead || '', o.exitDate || '', 'direct_admin', '', o.id, '', ''];
}

function load(opts) {
  const o = opts || {};
  const props = Object.assign({ COORDINATORS_PATIENTS_SECRET: COORD_SECRET }, o.on === false ? {} : { ACTIVITY_WRITES: 'on' });
  const g = loadGs({ props });
  const cols = Array.from(g.run('PATIENT_COLUMNS'));
  const sh = richSheet('Patients', cols);
  sh.grid.push(patientRow({ houseId: 'ramot', name: 'דנה כהן', id: 'id-dana', fromLead: 'L-1' }));
  sh.grid.push(patientRow({ houseId: 'rehab', name: 'אבי', id: 'id-avi' }));
  g.sandbox.__sheets.Patients = sh;
  g.sandbox.Session = { getScriptTimeZone: () => 'Asia/Jerusalem' };
  return g;
}
const activity = (g) => g.sheetRows('Activity', 'ACTIVITY_COLUMNS');
const audit = (g) => g.sheetRows('AuditLog', 'AUDIT_LOG_COLUMNS');
const coordDischarge = (g, id, house) => g.post({ action: 'recordDischargeFromCoordinators', secret: COORD_SECRET,
  id: id, dischargeDate: TODAY, by: 'רכזת', actor: 'rakaz:' + house, house: house });

/* ===== the switch ===== */

test('DEFAULT OFF: with ACTIVITY_WRITES unset a real writer audits as before and writes ZERO Activity rows', () => {
  const g = load({ on: false });
  const r = coordDischarge(g, 'id-dana', 'ramot');
  assert.equal(r.discharged, true);
  assert.ok(audit(g).some((a) => a.action === 'patient_discharged_by_coordinators'), 'the audit row is there');
  assert.equal(g.sandbox.__sheets.Activity, undefined, 'no Activity sheet, no row');
});

test('only the exact value "on" enables writes', () => {
  for (const v of ['ON', 'true', '1', 'yes', ' on ']) {
    const g = load({ on: false });
    g.sandbox.__props.ACTIVITY_WRITES = v;
    coordDischarge(g, 'id-dana', 'ramot');
    const wrote = g.sandbox.__sheets.Activity !== undefined;
    assert.equal(wrote, v.trim() === 'on', JSON.stringify(v));
  }
});

/* ===== one event per writer, stable ids ===== */

test('coordinators discharge → ONE patient_discharged event: app:coordinators, actor, patient + lead + house + discharge links, eventId by patient+date', () => {
  const g = load();
  const r = coordDischarge(g, 'id-dana', 'ramot');
  assert.equal(r.discharged, true);
  const rows = activity(g);
  assert.equal(rows.length, 1);
  const e = rows[0];
  assert.equal(e.kind, 'patient_discharged');
  assert.equal(e.source, 'app:coordinators');
  assert.equal(e.actorId, 'rakaz:ramot');
  assert.equal(e.patientId, 'id-dana');
  assert.equal(e.leadId, 'L-1', 'the audit arg (fromLead) becomes the lead link');
  assert.equal(e.houseId, 'ramot');
  assert.equal(e.dischargeId, 'coord-id-dana-' + TODAY);
  assert.equal(e.eventId, 'patient_discharged:id-dana:' + TODAY);
  assert.equal(e.summary, 'שוחרר/ה מהבית (רכזים)');
  const d = JSON.parse(e.detailsJson);
  assert.equal(d.dischargeDate, TODAY);
  assert.ok(!('by' in d) && !('name' in d), 'no names in details');
  assert.equal(audit(g).filter((a) => a.action === 'patient_discharged_by_coordinators').length, 1, 'the audit row is unchanged');
});

test('IDEMPOTENT: replaying the same discharge adds no second event', () => {
  const g = load();
  coordDischarge(g, 'id-dana', 'ramot');
  const again = coordDischarge(g, 'id-dana', 'ramot');
  assert.equal(again.alreadyDischarged, true);
  assert.equal(activity(g).length, 1);
  // the same eventId through the public writer dedupes too
  const r = g.sandbox.appendActivity_({ eventId: 'patient_discharged:id-dana:' + TODAY, kind: 'patient_discharged', source: 'app:coordinators' });
  assert.equal(r.duplicate, true);
  assert.equal(activity(g).length, 1);
});

test('a refused write produces NO event (refusals audit, but are not mapped)', () => {
  const g = load();
  const r = coordDischarge(g, 'id-avi', 'ramot');     // other house → forbidden_house
  assert.equal(r.error, 'forbidden_house');
  assert.ok(audit(g).some((a) => a.action === 'coord_discharge_refused'));
  assert.equal(g.sandbox.__sheets.Activity, undefined);
});

test('every mapped audit action yields a valid event with a stable eventId (pure activityFromAudit_)', () => {
  const g = load();
  const map = JSON.parse(JSON.stringify(g.run('ACTIVITY_AUDIT_MAP')));
  const now = '2026-10-27T10:00:00.000Z';
  const details = { id: 'id-p', disposition: 'completed', dischargeDate: '2026-10-27', newLeadId: 'L-9', fromHouseId: 'ramot',
    toHouseId: 'asher', receiptId: 'r-1', paymentId: 'pay-1', paymentUid: 'pu-1', ids: 'c1,c2', auditId: 'aud-1', updatedBy: 'ורד' };
  for (const action of Object.keys(map)) {
    const ev = JSON.parse(JSON.stringify(g.sandbox.activityFromAudit_(action, 'someWriter_', 'L-1', 'שם', details, 'ורד', now)));
    assert.ok(ev, action);
    assert.equal(ev.kind, map[action].kind);
    assert.ok(ev.eventId.startsWith(map[action].kind + ':'), action + ' eventId=' + ev.eventId);
    const v = JSON.parse(JSON.stringify(g.sandbox.activityRow_(ev, now)));
    assert.equal(v.ok, true, action + ': ' + v.error);
    assert.equal(v.row.actorName, 'ורד');
    assert.ok(!ev.summary.includes('שם'), 'the summary never carries the name');
    // the same inputs → the same eventId (a retry dedupes)
    const ev2 = g.sandbox.activityFromAudit_(action, 'someWriter_', 'L-1', 'שם', details, 'ורד', now);
    assert.equal(ev2.eventId, ev.eventId);
  }
  assert.equal(g.sandbox.activityFromAudit_('patient_edited', 'x', 'id', 'n', {}, 'a', now), null, 'unmapped → nothing');
  assert.equal(g.sandbox.activityFromAudit_('coord_discharge_refused', 'x', 'id', 'n', {}, 'a', now), null);
});

test('links: lead actions link leadId; payment actions link paymentUid + patient; a discharge links patient, lead and dischargeId', () => {
  const g = load();
  const now = '2026-10-27T10:00:00.000Z';
  const lead = g.sandbox.activityFromAudit_('lead_removed', 'removeLead_', 'L-5', 'x', {}, 'ורד', now);
  assert.equal(lead.leadId, 'L-5'); assert.equal(lead.patientId, '');
  const pay = g.sandbox.activityFromAudit_('payment_reported', 'reportPayment_', 'pu-patient', 'x', { receiptId: 'r-7', paymentUid: 'pu-7' }, 'ורד', now);
  assert.equal(pay.paymentUid, 'pu-7'); assert.equal(pay.patientId, 'pu-patient'); assert.equal(pay.eventId, 'payment_reported:r-7');
  const dis = g.sandbox.activityFromAudit_('patient_discharged', 'dischargePatient_', 'L-1', 'x', { id: 'id-p', houseId: 'ramot', disposition: 'completed' }, 'ורד', now);
  assert.equal(dis.patientId, 'id-p'); assert.equal(dis.leadId, 'L-1'); assert.equal(dis.houseId, 'ramot');
  assert.equal(dis.source, 'system:dischargePatient_');
});

/* ===== best-effort ===== */

test('an injected Activity failure leaves the primary write, its audit row and its answer unchanged', () => {
  const g = load();
  g.run("activityAppendRow_ = function () { throw new Error('quota'); };");
  const r = coordDischarge(g, 'id-dana', 'ramot');
  assert.deepEqual(r, { ok: true, discharged: true, id: 'id-dana', dischargeDate: TODAY });
  assert.ok(audit(g).some((a) => a.action === 'patient_discharged_by_coordinators'));
  assert.ok(g.logs.some((l) => /\[activity\] write failed/.test(l)), 'logged, not silent');
});

test('the hook never throws even when PropertiesService itself fails', () => {
  const g = load();
  g.run("PropertiesService.getScriptProperties = function () { throw new Error('down'); };");
  assert.doesNotThrow(() => g.sandbox.logAudit_('lead_removed', 'removeLead_', 'L-1', 'x', {}, 'ורד'));
});

/* ===== source guards ===== */

test('guard: the hook is the LAST statement of logAudit_, after the audit write, outside its try', () => {
  const fn = GS_SRC.slice(GS_SRC.indexOf('function logAudit_('));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  const hookAt = body.indexOf('activityFromAuditBestEffort_(');
  const auditWriteAt = body.indexOf('setValues([row])');
  assert.ok(auditWriteAt > 0 && hookAt > auditWriteAt);
  assert.ok(body.indexOf('} catch (err) {') < hookAt, 'after the catch');
  const map = GS_SRC.slice(GS_SRC.indexOf('const ACTIVITY_AUDIT_MAP'), GS_SRC.indexOf('function activityWritesOn_'));
  assert.doesNotMatch(map, /name|phone|note/, 'the map carries no PII fields');
});
