/* Normalized, authenticated contact metadata for the intake desk. Provider
 * payloads, message bodies, recordings and media never enter this ledger. */
const COMM_SHEET = 'CommunicationEvents';
const COMM_COLUMNS = ['id', 'channel', 'direction', 'status', 'occurredAt', 'observedAt', 'phone',
  'attachment', 'agentKey', 'resolution', 'leadId', 'reviewer', 'reviewedAt', 'remember', 'grantId', 'forgottenBy', 'forgottenAt'];
const COMM_AGENT_NAMES = { vered: 'ורד', dana: 'דנה', yael: 'יעל', sandra: 'סנדרה' };
const COMM_STATES = {
  phone: { ringing: 1, missed: 2, answered: 3 },
  whatsapp: { received: 1, sent: 1, failed: 2, delivered: 3, read: 4 }
};

function commStaff_(actor) {
  return !!actor && actor.verified === true && actor.auth === 'personal' &&
    actor.roles.indexOf('staff') >= 0 && Object.prototype.hasOwnProperty.call(COMM_AGENT_NAMES, actor.id);
}

function commPhone_(raw) {
  let value = String(raw == null ? '' : raw).trim();
  if (!/^[+\d ()-]+$/.test(value)) return '';
  value = value.replace(/[ ()-]/g, '').replace(/^00/, '+');
  if (/^972[1-9]\d{7,8}$/.test(value)) value = '+' + value;
  if (/^0[2-9]\d{7,8}$/.test(value)) value = '+972' + value.slice(1);
  // A number cell in the legacy sheet may have lost its Israeli trunk zero.
  if (typeof raw === 'number' && /^[2-9]\d{7,8}$/.test(value)) value = '+972' + value;
  if (/^\+972/.test(value)) return /^\+972(?:[23489]\d{7}|[57]\d{8})$/.test(value) ? value : '';
  return /^\+[1-9]\d{7,14}$/.test(value) ? value : '';
}

function commIso_(raw) {
  if (typeof raw !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(raw)) return '';
  const dt = new Date(raw);
  if (!isFinite(dt.getTime())) return '';
  const iso = dt.toISOString();
  return iso === raw || iso === raw.replace('Z', '.000Z') ? iso : '';
}

function commClean_(e) {
  if (!e || typeof e !== 'object' || !['phone', 'whatsapp'].includes(e.channel)) return null;
  if ((e.channel === 'phone' && e.scope === 'leg') || (e.channel === 'whatsapp' && (e.scope === 'group' || e.status === 'draft'))) return { ignored: true };
  if (e.scope !== (e.channel === 'phone' ? 'call' : 'direct') || !['in', 'out'].includes(e.direction) ||
      typeof e.objectRef !== 'string' || !/^[a-f0-9]{32}$/.test(e.objectRef) ||
      typeof e.status !== 'string' || !Object.prototype.hasOwnProperty.call(COMM_STATES[e.channel], e.status)) return null;
  if (e.channel === 'whatsapp' && ((e.direction === 'in') !== (e.status === 'received'))) return null;
  if (e.channel === 'phone' && e.status === 'missed' && e.final !== true) return { ignored: true };
  const occurred = commIso_(e.occurredAt), observed = commIso_(e.observedAt);
  if (!occurred || !observed || observed < occurred) return null;
  const phone = commPhone_(e.phone);
  if (e.phone != null && e.phone !== '' && (!phone || typeof e.phone !== 'string')) return null;
  const agentKey = typeof e.agentKey === 'string' && Object.prototype.hasOwnProperty.call(COMM_AGENT_NAMES, e.agentKey) ? e.agentKey : '';
  return { id: e.channel + '-' + e.objectRef, channel: e.channel, direction: e.direction,
    status: e.status, occurredAt: occurred, observedAt: observed, phone: phone,
    attachment: e.channel === 'whatsapp' && e.attachment === true ? '1' : '', agentKey: agentKey,
    resolution: 'pending', leadId: '', reviewer: '', reviewedAt: '', remember: '' };
}

function commRows_(name, columns) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sh || sh.getLastRow() < 2) return [];
  // Keep raw numeric phone cells distinguishable from a caller-supplied string.
  return sh.getRange(2, 1, sh.getLastRow() - 1, columns.length).getValues().map(function (values) {
    const row = {}; columns.forEach(function (key, i) { row[key] = values[i]; }); return row;
  });
}

function commRoster_() {
  const active = [], other = [];
  [[LEADS_SHEET, LEAD_COLUMNS], [IRRELEVANT_LEADS_SHEET, IRRELEVANT_LEAD_COLUMNS],
    [REMOVED_LEADS_SHEET, REMOVED_LEAD_COLUMNS]].forEach(function (entry, index) {
    commRows_(entry[0], entry[1]).forEach(function (r) {
      if (!r.id && !r.phone && !r.contactPhone && !r.billingPhone) return;
      const lead = { id: String(r.id || ''), name: String(r.name || ''), assignee: String(r.assignedTo || ''),
        primary: commPhone_(r.phone), contact: commPhone_(r.contactPhone), billing: commPhone_(r.billingPhone) };
      const isOpen = index === 0 && lead.id && ['new', 'visit', 'waitlist', 'paid'].indexOf(String(r.stage || '').trim()) >= 0;
      (isOpen ? active : other).push(lead);
    });
  });
  commRows_(PATIENT_PHONES_SHEET, PATIENT_PHONES_COLUMNS).forEach(function (patient) {
    const phone = commPhone_(patient.phone);
    if (phone) other.push({ primary: phone });
  });
  return { active: active, other: other };
}

function commUniqueLead_(roster, phone) {
  if (!phone) return null;
  const matches = function (r) { return r.primary === phone || r.contact === phone || r.billing === phone; };
  if (roster.other.some(matches)) return null;
  const hits = roster.active.filter(matches);
  if (hits.length !== 1 || (hits[0].primary !== phone && hits[0].contact !== phone)) return null;
  return hits[0];
}

function commSave_(sh, r, row) {
  const target = row > 0 ? row : sh.getLastRow() + 1;
  sh.getRange(target, 1, 1, COMM_COLUMNS.length).setNumberFormat('@').setValues([objectToRow_(r, COMM_COLUMNS)]);
}

function commLocked_(work) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return { ok: false, error: 'busy' };
  try { return work(); }
  finally {
    try { SpreadsheetApp.flush(); } finally { lock.releaseLock(); }
  }
}

function commSummary_(e) {
  const channel = e.channel === 'phone' ? 'שיחה ' + (e.direction === 'in' ? 'נכנסת' : 'יוצאת') + ' דרך המרכזייה' :
    'הודעת וואטסאפ ' + (e.direction === 'in' ? 'נכנסת' : 'יוצאת');
  const status = { ringing: 'צלצלה', missed: 'לא נענתה', answered: 'נענתה', received: 'התקבלה', sent: 'נשלחה', delivered: 'נמסרה', read: 'נקראה', failed: 'השליחה נכשלה' };
  return channel + ' · ' + status[e.status] + (e.attachment === '1' ? ' · קובץ מצורף' : '');
}

function commReconcileCallback_(e, lead) {
  if (e.resolution !== 'linked' || e.channel !== 'phone' || e.direction !== 'in' || e.status === 'ringing') return;
  const sid = 'sub-' + e.id.slice(6), suffix = 'pbx', system = 'מרכזייה';
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = e.status === 'missed' ? getOrCreateSheet_(TASKS_SHEET, TASK_COLUMNS) : ss.getSheetByName(TASKS_SHEET);
  if (!sh) return;
  const existing = taskReadById_(sh, taskIdFromSubmission_(sid, suffix));
  if (existing.task) {
    const t = existing.task;
    if (e.status === 'answered' && t.leadId === e.leadId && t.source === 'system:pbx' &&
        t.status === 'open' && t.updatedBy === system && t.updatedAt === t.createdAt) {
      t.status = 'cancelled'; t.updatedBy = system; t.updatedAt = new Date().toISOString();
      t.cancelReason = 'המרכזייה אישרה שהשיחה נענתה'; taskWriteRow_(sh, existing.row, t);
    }
    return;
  }
  if (e.status !== 'missed' || !lead) return;
  const assignee = ['ורד', 'דנה', 'סנדרה'].indexOf(lead.assignee) >= 0 ? lead.assignee : 'ורד';
  const due = Utilities.formatDate(new Date(e.occurredAt), 'Asia/Jerusalem', 'yyyy-MM-dd');
  const build = taskClean_({ kind: 'call', title: 'לחזור לשיחה שלא נענתה', leadId: e.leadId,
    source: 'system:pbx', assignee: assignee, dueDate: due }, system, new Date().toISOString(), sid, suffix);
  if (!build.ok) throw new Error('callback_validation_failed');
  taskWriteRow_(sh, -1, build.task);
}

function ingestCommunicationEvent_(params) {
  const event = params.event;
  const business = commPhone_(PropertiesService.getScriptProperties().getProperty('CONTACT_EVENT_BUSINESS_NUMBER'));
  if (!business || !event || typeof event.businessNumber !== 'string' || commPhone_(event.businessNumber) !== business) return { ok: false, error: 'wrong_line' };
  if ((event.channel === 'whatsapp' && event.connection !== 'official_whatsapp') ||
      (event.channel === 'phone' && event.connection !== 'pbx')) return { ok: false, error: 'wrong_connection' };
  const incoming = commClean_(event);
  if (!incoming) return { ok: false, error: 'bad_event' };
  if (incoming.ignored) return { ok: true, ignored: true };
  return commLocked_(function () {
    const sh = getOrCreateSheet_(COMM_SHEET, COMM_COLUMNS);
    const rows = commRows_(COMM_SHEET, COMM_COLUMNS);
    const index = rows.findIndex(function (r) { return r.id === incoming.id; });
    const e = index < 0 ? incoming : rows[index];
    if (e.direction !== incoming.direction || (e.phone && incoming.phone && e.phone !== incoming.phone)) return { ok: false, error: 'identity_conflict' };
    const before = index < 0 ? '' : JSON.stringify(e);
    if (index >= 0) {
      const rank = COMM_STATES[e.channel];
      const newer = incoming.observedAt >= e.observedAt;
      if (rank[incoming.status] > rank[e.status]) e.status = incoming.status;
      if (incoming.occurredAt < e.occurredAt) e.occurredAt = incoming.occurredAt;
      if (newer) e.observedAt = incoming.observedAt;
      if (!e.phone) e.phone = incoming.phone;
      if (incoming.attachment) e.attachment = '1';
      if (incoming.agentKey && (!e.agentKey || newer)) e.agentKey = incoming.agentKey;
    }
    let roster, lead;
    if (e.resolution === 'pending' && e.phone) {
      const samePhone = rows.filter(function (r) { return r.resolution === 'linked' && r.phone === e.phone; });
      const revocations = new Map();
      samePhone.forEach(function (r) {
        if (r.forgottenAt && r.forgottenAt > (revocations.get(r.leadId) || '')) revocations.set(r.leadId, r.forgottenAt);
      });
      const proofs = samePhone.filter(function (r) {
        return r.remember === '1' && r.reviewedAt <= e.occurredAt && r.reviewedAt > (revocations.get(r.leadId) || '');
      });
      if (proofs.length) {
        roster = commRoster_(); lead = commUniqueLead_(roster, e.phone);
        if (lead && proofs.every(function (r) { return r.leadId === lead.id; })) {
          e.resolution = 'linked'; e.leadId = lead.id; e.grantId = proofs[0].id;
        }
      }
    }
    if (before !== JSON.stringify(e)) commSave_(sh, e, index < 0 ? -1 : index + 2);
    if (e.resolution === 'linked' && e.status === 'missed' && !lead) {
      roster = roster || commRoster_(); lead = roster.active.find(function (r) { return r.id === e.leadId; });
    }
    commReconcileCallback_(e, lead);
    return { ok: true, id: e.id };
  });
}

function commReview_() {
  const rows = commRows_(COMM_SHEET, COMM_COLUMNS).filter(function (r) { return r.resolution === 'pending'; });
  rows.sort(function (a, b) { return a.occurredAt.localeCompare(b.occurredAt) || a.id.localeCompare(b.id); });
  const roster = rows.length ? commRoster_() : { active: [] };
  return { ok: true, total: rows.length, events: rows.slice(0, 50).map(function (r) {
    const unique = commUniqueLead_(roster, r.phone);
    return { id: r.id, occurredAt: r.occurredAt, phone: r.phone, summary: commSummary_(r), rememberLead: unique ? unique.id : '',
      suggestions: r.phone ? roster.active.filter(function (l) { return l.primary === r.phone || l.contact === r.phone; }).map(function (l) { return l.id; }) : [] };
  }), leads: roster.active.map(function (l) { return { id: l.id, name: l.name }; }) };
}

function commResolve_(p, actor) {
  if (typeof p.id !== 'string' || !/^(phone|whatsapp)-[0-9a-f]{32}$/.test(p.id) ||
      !['link', 'dismiss', 'forget'].includes(p.decision) ||
      (p.decision === 'link' && (p.verifiedContact !== true || typeof p.leadId !== 'string' || !p.leadId || p.leadId.length > ACTIVITY_ID_MAX || /^[=+@-]/.test(p.leadId)))) return { ok: false, error: 'bad_review' };
  return commLocked_(function () {
    const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(COMM_SHEET);
    const rows = commRows_(COMM_SHEET, COMM_COLUMNS);
    const e = rows.find(function (r) { return r.id === p.id; });
    if (!e) return { ok: false, error: 'not_found' };
    if (p.decision === 'forget') {
      if (e.resolution !== 'linked' || !e.phone || e.leadId !== p.leadId || (!e.reviewedAt || (!e.remember && !e.forgottenAt))) return { ok: false, error: 'bad_review' };
      // Retry after a partial write also removes any remaining grants for this
      // number/card that predate the revocation. A newer explicit grant survives.
      const at = e.forgottenAt || new Date().toISOString();
      if (!e.forgottenAt) {
        e.forgottenAt = at; e.forgottenBy = actor.id; e.remember = '';
        commSave_(sh, e, taskFindRow_(sh, e.id));
      }
      rows.forEach(function (r, i) {
        if (r.phone === e.phone && r.leadId === e.leadId && r.remember === '1' && r.reviewedAt <= at) {
          r.remember = ''; r.forgottenBy = actor.id; r.forgottenAt = at; commSave_(sh, r, i + 2);
        }
      });
      return { ok: true, resolution: 'forgotten' };
    }
    const resolution = p.decision === 'link' ? 'linked' : 'dismissed';
    if (e.resolution !== 'pending' && (e.resolution !== resolution || (resolution === 'linked' && e.leadId !== p.leadId))) return { ok: false, error: 'already_resolved' };
    let lead;
    if (resolution === 'linked') {
      const roster = commRoster_();
      const matches = roster.active.filter(function (r) { return r.id === p.leadId; });
      if (e.resolution === 'pending' && matches.length !== 1) return { ok: false, error: 'closed_or_unknown_lead' };
      lead = matches[0];
      if (e.resolution === 'pending' && p.remember === true) {
        const unique = commUniqueLead_(roster, e.phone);
        if (!unique || unique.id !== p.leadId) return { ok: false, error: 'phone_not_unique' };
        e.remember = '1';
      }
    }
    if (e.resolution === 'pending') {
      e.resolution = resolution; e.leadId = lead ? lead.id : '';
      e.reviewer = actor.id; e.reviewedAt = new Date().toISOString();
      commSave_(sh, e, taskFindRow_(sh, e.id));
    }
    commReconcileCallback_(e, lead);
    return { ok: true, resolution: resolution };
  });
}

function commActivity_(leadId) {
  return commRows_(COMM_SHEET, COMM_COLUMNS).filter(function (e) {
    return e.resolution === 'linked' && e.leadId === leadId;
  }).map(function (e) {
    return { eventId: e.id, occurredAt: e.occurredAt, recordedAt: e.observedAt, leadId: leadId,
      kind: 'communication', source: 'system:' + e.channel, actorName: COMM_AGENT_NAMES[e.agentKey] || (e.channel === 'phone' ? 'מרכזייה' : 'וואטסאפ'),
      summary: commSummary_(e), detailsJson: e.remember === '1' ? JSON.stringify({ canForgetNumber: true }) : '' };
  });
}
