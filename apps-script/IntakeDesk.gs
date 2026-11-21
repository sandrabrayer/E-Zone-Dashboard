/* Internal intake desk. Automatic signals come only from the authenticated
 * communications ledger. Family correspondence stays in the private chat. */
const FAMILY_DESK_SHEET = 'FamilyRequests';
const FAMILY_DESK_COLUMNS = ['id', 'kind', 'channel', 'phone', 'owner', 'dueDate', 'state', 'revision',
  'createdAt', 'createdBy', 'patientId', 'house', 'routedAt', 'routedBy', 'closedAt', 'closedBy', 'permissionCheckedAt'];
const DESK_CHANNELS = { phone: 'טלפון', whatsapp: 'הודעת וואטסאפ', whatsapp_call: 'שיחת וואטסאפ',
  email: 'דוא״ל', sms: 'מסרון', in_person: 'פגישה', other: 'קשר מתועד' };

function intakeDesk_(p, actor) {
  if (!commStaff_(actor)) return { ok: false, error: 'forbidden' };
  switch (p.op) {
    case 'signals': return { ok: true, ids: deskSignals_() };
    case 'lookup': return deskCaller_(p);
    case 'families': return { ok: true, requests: commRows_(FAMILY_DESK_SHEET, FAMILY_DESK_COLUMNS).map(familyDeskView_) };
    case 'residents': return { ok: true, residents: familyDeskResidents_() };
    case 'create': return familyDeskCreate_(p, actor);
    case 'advance': return familyDeskAdvance_(p, actor);
    default: return { ok: false, error: 'bad_input' };
  }
}

function deskSignals_() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(COMM_SHEET);
  if (!sheet || sheet.getLastRow() < 2) return [];
  const now = Date.now(), start = new Date(now - 3 * 60000).toISOString(), end = new Date(now).toISOString();
  // Read only metadata (id through occurredAt). A late receipt about an old
  // interaction must not look like a new caller. Never return phone numbers here.
  return sheet.getRange(2, 1, sheet.getLastRow() - 1, 5).getValues().filter(function (r) {
    return r[2] === 'in' && r[4] >= start && r[4] <= end;
  }).map(function (r) { return r[0]; });
}

function deskPrevious_(lead, phone, before, rows) {
  let last = null;
  function take(at, by, channel, outcome) {
    const time = at instanceof Date ? at.toISOString() : commIso_(String(at || ''));
    if (time && time < before && (!last || time > last.at)) last = { at: time, by: by, channel: channel, outcome: outcome };
  }
  // Historical manual logs refer to the card. They do not establish which
  // relative was speaking. Use only the outcome and never copy the free text.
  commRows_(ACTIVITY_SHEET, ACTIVITY_COLUMNS).forEach(function (r) {
    if (r.kind !== 'contact_logged' || r.leadId !== lead.id) return;
    let info;
    try { info = JSON.parse(r.detailsJson || '{}'); } catch (_) { return; }
    if (!info || !CONTACT_OUTCOMES.includes(info.outcome) || !Object.prototype.hasOwnProperty.call(DESK_CHANNELS, info.channel)) return;
    take(r.occurredAt, String(r.actorName || ''), info.channel, contactOutcomeLabel_(info.outcome));
  });
  rows.forEach(function (r) {
    if (r.phone !== phone || r.leadId !== lead.id || r.resolution !== 'linked') return;
    if (r.channel === 'phone' && r.status === 'answered') take(r.occurredAt, COMM_AGENT_NAMES[r.agentKey] || '', 'phone', 'שיחה שנענתה');
    if (r.channel === 'whatsapp' && r.direction === 'out' && r.agentKey && ['sent','delivered','read'].includes(r.status))
      take(r.occurredAt, COMM_AGENT_NAMES[r.agentKey] || '', 'whatsapp', 'נשלחה הודעה');
  });
  return last;
}

function deskCaller_(p) {
  const rows = commRows_(COMM_SHEET, COMM_COLUMNS);
  const event = p.eventId ? rows.find(function (r) { return r.id === p.eventId; }) : null;
  if (p.eventId && (!event || event.resolution === 'dismissed' || event.direction !== 'in')) return { ok: true, match: 'none' };
  const phone = event ? event.phone : commPhone_(typeof p.phone === 'string' ? p.phone : '');
  if (!phone) return { ok: true, match: 'unidentified' };
  const roster = commRoster_();
  const lead = commUniqueLead_(roster, phone);
  if (!lead) {
    const known = roster.active.concat(roster.other).some(function (x) { return x.primary === phone || x.contact === phone || x.billing === phone; });
    return { ok: true, match: known ? 'review' : 'none' };
  }
  if (event && event.resolution === 'linked' && event.leadId !== lead.id) return { ok: true, match: 'review' };
  const before = event ? event.occurredAt : new Date(Date.now() + 1).toISOString();
  const prior = deskPrevious_(lead, phone, before, rows);
  if (!prior) return { ok: true, match: 'no_history' };
  const proof = event && event.resolution === 'linked' && rows.some(function (r) {
    return r.id === (event.grantId || event.id) && r.phone === phone && r.leadId === lead.id && r.remember === '1' && !r.forgottenAt;
  });
  if (!proof && p.verified !== true) return { ok: true, match: 'verify' };
  const tasks = tasksSheetRead_().map(taskOut_).filter(function (t) {
    return t.status === 'open' && t.leadId === lead.id && t.money !== '1';
  }).sort(function (a, b) { return (a.dueDate || a.windowStart || '9999').localeCompare(b.dueDate || b.windowStart || '9999') || a.id.localeCompare(b.id); });
  const t = tasks[0];
  let taskLabel = 'משימת המשך בכרטיס';
  if (t && t.source === 'contact') {
    const code = Object.keys(INTAKE_PROMISES).find(function (key) { return t.id.endsWith('-' + key); });
    if (code && t.title === INTAKE_PROMISES[code].title) taskLabel = INTAKE_PROMISES[code].title;
  } else if (t && t.source === 'system:pbx' && t.kind === 'call') taskLabel = 'לחזור לשיחה שלא נענתה';
  return { ok: true, match: 'history', leadId: lead.id, prior: prior, openCount: tasks.length,
    next: t ? { title: taskLabel, owner: t.assignee, due: t.dueDate || t.windowStart } : null };
}

function familyDeskDate_(v) {
  if (typeof v !== 'string' || !/^\d{4}-\d\d-\d\d$/.test(v)) return false;
  const d = new Date(v + 'T12:00:00Z');
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

function familyDeskResidents_() {
  const today = Utilities.formatDate(new Date(), 'Asia/Jerusalem', 'yyyy-MM-dd');
  const rows = commRows_(PATIENTS_SHEET, PATIENT_COLUMNS), counts = new Map();
  rows.forEach(function (r) { if (r.id) counts.set(r.id, 1 + (counts.get(r.id) || 0)); });
  return rows.filter(function (r) {
    const status = String(r.status || '').trim().toLowerCase();
    return r.id && counts.get(r.id) === 1 && r.name && r.houseId && ['active','trial'].includes(status) && recStayCovers_(r, today);
  }).map(function (r) { return { id: String(r.id), name: String(r.name), house: String(r.houseId) }; });
}

function familyDeskView_(r) {
  const out = {};
  FAMILY_DESK_COLUMNS.forEach(function (key) { out[key] = r[key] == null ? '' : String(r[key]); });
  out.revision = Number(r.revision);
  return out;
}

function familyDeskSave_(sheet, position, r) {
  sheet.getRange(position, 1, 1, FAMILY_DESK_COLUMNS.length).setNumberFormat('@').setValues([objectToRow_(r, FAMILY_DESK_COLUMNS)]);
  return { ok: true, request: familyDeskView_(r) };
}

function familyDeskCreate_(p, actor) {
  const id = taskSubmissionId_(p.requestId);
  const phone = commPhone_(typeof p.phone === 'string' ? p.phone : '');
  if (!id || !phone || !['message','information'].includes(p.kind) || !['phone','whatsapp','whatsapp_call'].includes(p.channel) ||
      !Object.prototype.hasOwnProperty.call(COMM_AGENT_NAMES, p.owner) || !familyDeskDate_(p.dueDate)) return { ok: false, error: 'bad_input' };
  return commLocked_(function () {
    const sh = getOrCreateSheet_(FAMILY_DESK_SHEET, FAMILY_DESK_COLUMNS);
    const row = taskFindRow_(sh, id);
    if (row > 0) {
      const prior = familyDeskRead_(sh, row);
      if (prior.phone !== phone || prior.kind !== p.kind || prior.owner !== p.owner || prior.channel !== p.channel || prior.dueDate !== p.dueDate)
        return { ok: false, error: 'changed_request' };
      return { ok: true, request: prior };
    }
    return familyDeskSave_(sh, sh.getLastRow() + 1, { id: id, kind: p.kind, channel: p.channel, phone: phone,
      owner: p.owner, dueDate: p.dueDate, state: 'new', revision: 1, createdBy: actor.id, createdAt: new Date().toISOString() });
  });
}

function familyDeskRead_(sh, row) {
  const cells = sh.getRange(row, 1, 1, FAMILY_DESK_COLUMNS.length).getValues()[0];
  const value = {};
  FAMILY_DESK_COLUMNS.forEach(function (key, i) { value[key] = cells[i]; });
  return familyDeskView_(value);
}

function familyDeskAdvance_(p, actor) {
  if (!taskSubmissionId_(p.requestId) || !Number.isSafeInteger(p.revision) || p.confirmed !== true ||
      !['routed','delivered','answered','closed'].includes(p.to)) return { ok: false, error: 'bad_input' };
  return commLocked_(function () {
    const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(FAMILY_DESK_SHEET);
    const row = sh ? taskFindRow_(sh, p.requestId) : -1;
    if (row < 2) return { ok: false, error: 'not_found' };
    const r = familyDeskRead_(sh, row);
    if (r.revision !== p.revision || !['new','routed'].includes(r.state)) return { ok: false, error: 'changed_request' };
    const now = new Date().toISOString();
    if (p.to === 'routed') {
      const patient = familyDeskResidents_().find(function (x) { return x.id === p.patientId; });
      if (!patient || patient.house !== p.house || (r.patientId && r.patientId !== patient.id)) return { ok: false, error: 'check_resident' };
      if (r.state === 'routed' && r.house === patient.house) return { ok: false, error: 'changed_request' };
      r.patientId = patient.id; r.house = patient.house; r.routedBy = actor.id; r.routedAt = now;
    } else {
      if (p.to !== 'closed') {
        if (r.state !== 'routed' || p.to !== (r.kind === 'message' ? 'delivered' : 'answered')) return { ok: false, error: 'bad_input' };
        const patient = familyDeskResidents_().find(function (x) { return x.id === r.patientId; });
        if (!patient || patient.house !== r.house) return { ok: false, error: 'check_resident' };
        if (p.to === 'answered') {
          if (p.permissionVerified !== true) return { ok: false, error: 'check_permission' };
          r.permissionCheckedAt = now;
        }
      }
      r.closedBy = actor.id; r.closedAt = now;
    }
    r.state = p.to; r.revision++;
    return familyDeskSave_(sh, row, r);
  });
}
