/* CRM shell (C2, CHANGELOG-crm-shell-areas.md; docs/crm/SPEC.md §4–§7).
 *
 * Loaded ONLY by /?view=crm (CRM_ENABLED). Read-only over the EXISTING
 * actions (/api/me, getData, billingControlQueue, getActivity): no new write
 * path — every action button links to the classic dashboard. The pure core
 * (CrmCore) is exported for node tests; the DOM part runs in the browser. */
(function (root, factory) {
  const core = factory();
  if (typeof module === 'object' && module.exports) module.exports = core;
  root.CrmCore = core;
  if (typeof document !== 'undefined' && document.getElementById('crm-root')) core.boot(root, document);
}(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  /* Mirrors public/app.js HOUSES / STAGES (ids are the stable keys). */
  const HOUSES = [
    { id: 'arfoni', name: 'קיסריה עפרוני', capacity: 13 }, { id: 'rehab', name: 'קיסריה ריהאב', capacity: 13 },
    { id: 'asher', name: 'רעננה אשר', capacity: 14 }, { id: 'pardes', name: 'רעננה הפרדס', capacity: 13 },
    { id: 'ramot', name: 'רמות השבים', capacity: 20 }, { id: 'sde', name: 'שדה אליעזר', capacity: 16, closed: true },
  ];
  /* Sibling-app / legacy house ids (app.js resolveHouseId). */
  const HOUSE_ALIASES = { hapardes: 'pardes', ofroni: 'arfoni', efroni: 'arfoni', raanana: 'asher' };
  const STAGES = [
    { id: 'new', label: 'ליד חדש' }, { id: 'visit', label: 'ביקור נקבע' },
    { id: 'waitlist', label: 'רשימת המתנה' }, { id: 'paid', label: 'בטיפול פעיל' },
  ];
  const AREAS = [
    { id: 'today', label: 'היום שלי' }, { id: 'leads', label: 'פניות' }, { id: 'occupancy', label: 'תפוסה' },
    { id: 'clients', label: 'מטופלים' }, { id: 'calendar', label: 'יומן' }, { id: 'billing', label: 'גבייה' }, { id: 'control', label: 'בקרה' },
  ];
  const WAIT_DAYS = 3;
  /* Mirrors app.js MEETING_OUTCOME_LABELS / MEETING_WITH_AMBULATORY (stable keys). */
  const MEETING_OUTCOMES = [
    { id: 'entered', label: 'נכנסים לטיפול' }, { id: 'thinking', label: 'חושבים על זה' }, { id: 'postponed', label: 'נדחה' },
    { id: 'cancelled', label: 'התבטל' }, { id: 'not_relevant', label: 'לא רלוונטי' },
  ];
  const MEETING_WITH_AMBULATORY = 'אמבולטורי';
  const ASSIGNEES = ['ורד', 'דנה', 'סנדרה'];

  /* ===== Lead writes (C4, CHANGELOG-crm-lead-actions.md) =====
   * The classic app's write is `saveAll` with EVERY lead and every patient.
   * Code.gs mergeLeads_ upserts by id and KEEPS leads absent from the payload,
   * and a `patients: {}` payload touches no house — so the CRM sends ONE full
   * lead row (the raw getData object, patched) and nothing else. The answer's
   * `proven.leads` must name the id (R3) or the write is treated as failed. */
  const STAGE_ORDER = STAGES.map(function (st) { return st.id; });
  function stageAfter(id) { const i = STAGE_ORDER.indexOf(id); return i >= 0 && i < STAGE_ORDER.length - 1 ? STAGE_ORDER[i + 1] : ''; }
  function stageBefore(id) { const i = STAGE_ORDER.indexOf(id); return i > 0 ? STAGE_ORDER[i - 1] : ''; }

  /* The next raw lead row for one patch — the SAME stamp rules as app.js
   * moveLead (waitlistedAt set on entering רשימת המתנה, cleared on leaving).
   * Pure: never mutates `raw`. */
  function applyLeadPatch(raw, patch, nowIso) {
    const next = Object.assign({}, raw || {}, patch || {});
    const prev = s(raw && raw.stage), stage = s(next.stage);
    if (patch && 'stage' in patch && stage !== prev) {
      if (stage === 'waitlist') next.waitlistedAt = nowIso || new Date().toISOString();
      else if (prev === 'waitlist') next.waitlistedAt = '';
    }
    return next;
  }

  /* The saveAll body for one lead. Pure. */
  function leadSaveBody(lead) {
    return { action: 'saveAll', leads: [lead], patients: {}, prove: { leads: [s(lead.id)] } };
  }

  /* ===== Lead lifecycle (C5, CHANGELOG-crm-lead-lifecycle.md) ===== */
  const DISPOSITIONS = [
    { id: 'not_relevant', label: 'לא רלוונטי' }, { id: 'completed', label: 'סיים טיפול' },
    { id: 'stopped_early', label: 'הפסיק לפני הזמן' }, { id: 'released_outpatient', label: 'משוחרר לטיפול חוץ' },
  ];
  const CONTACT_RELATIONS = ['מטופל', 'אמא', 'אבא', 'אח/אחות', 'בן/בת', 'בן/בת זוג', 'סבא/סבתא', 'קרוב משפחה', 'חבר/חברה', 'עו"ס', 'אחר'];
  const SOURCES = ['פייסבוק', 'גוגל', 'אינסטגרם', 'המלצה', 'עו"ס', 'קופת חולים', 'בית חולים', 'אחר'];

  /* The classic rules (app.js leadFullNameOk / leadLocalPhone): two words, a
   * 10-digit local phone. Pure. */
  function localPhone(raw) {
    let t = s(raw).replace(/[\s\-()]/g, '').replace(/^\+/, '').replace(/^00/, '');
    if (/^972\d+$/.test(t)) t = '0' + t.slice(3);
    return /^0\d{9}$/.test(t) ? t : '';
  }
  function leadFormErrors(v) {
    const out = {};
    if (s(v && v.name).split(/\s+/).filter(Boolean).length < 2) out.name = 'יש להזין שם מלא (שם פרטי ושם משפחה)';
    if (!localPhone(v && v.phone)) out.phone = 'יש להזין טלפון ישראלי תקין (10 ספרות)';
    if (!s(v && v.assignedTo)) out.assignedTo = 'יש לבחור משוייך ל';
    if (s(v && v.contactPhone) && !localPhone(v.contactPhone)) out.contactPhone = 'טלפון הפונה אינו תקין';
    return out;
  }
  /* A new lead row (every LEAD_COLUMNS key the classic form writes). Pure. */
  function newLeadRow(v, id, today) {
    const phone = localPhone(v.phone), contactPhone = localPhone(v.contactPhone);
    const mode = s(v.billingMode) || 'patient';
    const billingPhone = mode === 'contact' ? contactPhone : (mode === 'other' ? localPhone(v.billingOther) : phone);
    const rel = s(v.contactRelation) === 'אחר' ? s(v.contactRelationOther) || 'אחר' : s(v.contactRelation);
    return { id: id, name: s(v.name).replace(/\s+/g, ' '), phone: phone, house: s(v.house), source: s(v.source), note: s(v.note),
      stage: 'new', visitDate: '', visitTime: '', entryDate: '', advance: '', created: today, assignedTo: s(v.assignedTo),
      meetingWith: s(v.meetingWith), meetingOutcome: '', contactName: s(v.contactName), contactPhone: contactPhone,
      contactRelation: rel, billingPhone: billingPhone };
  }
  /* A lead already carrying this phone (the classic duplicate warning). Pure. */
  function duplicateByPhone(leads, phone) {
    const p = localPhone(phone);
    if (!p) return null;
    return (leads || []).filter(function (l) { return localPhone(l.phone) === p; })[0] || null;
  }
  /* The closed record the classic closeLead sends (moveLeadIrrelevant). Pure. */
  function closeRecord(raw, disposition, note, nowIso) {
    return Object.assign({}, raw, { stage: 'irrelevant', originSheet: s(raw && raw.stage) || 'new', movedAt: nowIso,
      disposition: s(disposition) || 'not_relevant', not_relevant_note: s(note) });
  }
  function randomId() {
    const c = typeof crypto !== 'undefined' && crypto && typeof crypto.getRandomValues === 'function' ? crypto : null;
    let rnd = '';
    if (c) { const b = new Uint8Array(8); c.getRandomValues(b); rnd = Array.prototype.map.call(b, function (x) { return (x < 16 ? '0' : '') + x.toString(16); }).join(''); }
    else rnd = Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
    return 'id-' + rnd;
  }

  /* ===== Admission + direct add (C6, CHANGELOG-crm-admission.md) =====
   * Patients save through saveAll's house payload. replaceHousePatients_ matches
   * by id / identity key and KEEPS sheet rows absent from the payload, yet it
   * copies every kept row to the tombstone audit — so the CRM sends the
   * WHOLE house as read (the raw getData rows, stamps included) plus the new
   * row, exactly what the classic tab sends for that house. */
  const PATIENT_STATUSES = [{ id: 'trial', label: 'תקופת ניסיון' }, { id: 'active', label: 'פעיל' }, { id: 'wait', label: 'בהמתנה' }];
  const FUNDERS = ['פרטי', 'ביטוח לאומי', 'משרד הביטחון', 'מכבי', 'פרו-בונו'];   // lib/payment-report-rules.js PAYMENT_FUNDERS
  function isoDateOk(v) { const t = s(v); if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) return false; const y = +t.slice(0, 4); return y >= 2024 && y <= new Date().getFullYear() + 2; }
  /* The patient row of an admission from a lead (classic openEntryModal). Pure. */
  function admissionRow(lead, v, id) {
    return { id: id, houseId: s(v.houseId), name: s(lead.name), date: s(v.date), pay: Number(v.pay) || 0, adv: Number(v.adv) || 0,
      status: s(v.status) || 'trial', fromLead: s(lead.id), exitDate: '', source: 'lead', notes: '', updatedAt: '', updatedBy: '', personId: '' };
  }
  function admissionErrors(v, finance) {
    const out = {};
    if (!s(v.houseId)) out.houseId = 'יש לבחור בית';
    if (!isoDateOk(v.date)) out.date = 'תאריך כניסה חסר או מחוץ לטווח';
    if (!(Number(v.pay) > 0)) out.pay = 'יש להזין סכום חודשי';
    if (finance && FUNDERS.indexOf(s(v.funder)) < 0) out.funder = 'יש לבחור גורם מממן';
    return out;
  }
  /* The direct-add pair (classic openDirectAddPatientModal + buildDirectApproachLead):
   * the patient (source direct_admin) and its admitted «פנייה ישירה» lead. Pure. */
  function directAddRows(v, pid, today, houseNameOf) {
    const leadId = 'dl-' + pid;
    const lead = { id: leadId, name: s(v.name).replace(/\s+/g, ' '), phone: localPhone(v.phone), house: houseNameOf(v.houseId), source: 'direct_approach',
      note: 'פנייה ישירה (נוסף בתפוסה)', stage: 'admitted', visitDate: '', visitTime: '', entryDate: s(v.date), advance: '', created: today,
      assignedTo: '', meetingWith: '', meetingOutcome: '', contactName: '', contactPhone: '', contactRelation: '', billingPhone: '' };
    const patient = { id: pid, houseId: s(v.houseId), name: lead.name, date: s(v.date), pay: Number(v.pay) || 0, adv: 0, status: s(v.status) || 'active',
      fromLead: leadId, exitDate: '', source: 'direct_admin', notes: s(v.notes), updatedAt: '', updatedBy: '', personId: '' };
    return { lead: lead, patient: patient };
  }
  function directAddErrors(v, finance) {
    const out = admissionErrors(v, finance);
    if (s(v.name).split(/\s+/).filter(Boolean).length < 2) out.name = 'יש להזין שם מלא';
    if (s(v.phone) && !localPhone(v.phone)) out.phone = 'טלפון אינו תקין';
    return out;
  }
  /* The saveAll body for one house: the house as read + the new row (+ the lead). Pure. */
  function houseSaveBody(houseId, houseRows, patient, lead) {
    const rows = (Array.isArray(houseRows) ? houseRows : []).filter(function (p) { return s(p && p.id) !== s(patient.id); }).concat([patient]);
    const patients = {}; patients[houseId] = rows;
    const body = { action: 'saveAll', leads: lead ? [lead] : [], patients: patients, prove: { patients: [s(patient.id)] } };
    if (lead) body.prove.leads = [s(lead.id)];
    return body;
  }
  /* '' when the patient (and lead) are proven, else the reason. Pure. */
  function houseSaveRefusal(res, pid, leadId) {
    if (!res || typeof res !== 'object') return 'אין תשובה מהשרת';
    if (res.ok === false) {
      if (Array.isArray(res.invalidLeads) && res.invalidLeads.length) return 'לא נשמר: הליד חייב שם וטלפון תקין';
      return res.message || ('השמירה נדחתה' + (res.error ? ' (' + res.error + ')' : ''));
    }
    if (Array.isArray(res.skippedPromotes) && res.skippedPromotes.some(function (x) { return s(x && x.fromLead) === s(leadId) || s(x && x.id) === s(pid); })) return 'לא נשמר: למטופל/ת כבר קיימת רשומה (כפילות)';
    if (Array.isArray(res.conflicts) && res.conflicts.length) return 'לא נשמר: הנתונים השתנו בינתיים — רענני ונסי שוב';
    const pp = res.proven && Array.isArray(res.proven.patients) ? res.proven.patients.map(s) : [];
    if (pp.indexOf(s(pid)) < 0) return 'הקליטה לא אומתה — רענני ובדקי';
    if (leadId) { const pl = res.proven && Array.isArray(res.proven.leads) ? res.proven.leads.map(s) : []; if (pl.indexOf(s(leadId)) < 0) return 'הליד לא אומת — רענני ובדקי'; }
    return '';
  }

  /* ===== Patient actions (C7, CHANGELOG-crm-patient-actions.md): edit, move, discharge ===== */
  const DISCHARGE_DISPOSITIONS = [{ id: 'completed', label: 'סיים טיפול' }, { id: 'stopped_early', label: 'הפסיק לפני הזמן' }, { id: 'released_outpatient', label: 'משוחרר לטיפול חוץ' }];
  const CONTINUITY_CHOICES = [{ id: 'continued_outpatient', label: 'המשיך באמבולטורי (E-ZONE)' }, { id: 'continued_other', label: 'המשיך במסגרת טיפולית אחרת' }, { id: 'none', label: 'לא המשיך' }];
  /* The discharged-audit row the classic dischargePatient sends (app.js
   * dischargeAuditRow): the patient as read + its own fresh id, patientId,
   * released, prior_status, exitDate, dischargedAt, disposition, note, continuity. Pure. */
  function dischargeAuditRow(patient, v, auditId, nowIso) {
    const exitDate = isoDateOk(v.dischargeDate) ? s(v.dischargeDate) : nowIso.slice(0, 10);
    return Object.assign({}, patient, { id: auditId, patientId: s(patient.id), status: 'released', prior_status: s(patient.status), exitDate: exitDate,
      dischargedAt: nowIso, disposition: s(v.disposition), discharge_note: s(v.note),
      continuity: CONTINUITY_CHOICES.some(function (c) { return c.id === s(v.continuity); }) ? s(v.continuity) : 'unknown' });
  }
  function dischargeErrors(v) {
    const out = {};
    if (!DISCHARGE_DISPOSITIONS.some(function (d) { return d.id === s(v.disposition); })) out.disposition = 'יש לבחור סטטוס שחרור';
    if (s(v.dischargeDate) && !isoDateOk(v.dischargeDate)) out.dischargeDate = 'תאריך שחרור מחוץ לטווח';
    return out;
  }
  /* The moved row: the patient as read, in the target house, with the classic
   * ✏-modal intent (`movedFrom`) that replaceHousePatients_ resolves. Pure. */
  function movedRow(patient, toHouseId) {
    return Object.assign({}, patient, { houseId: s(toHouseId), movedFrom: s(patient.houseId) });
  }
  function patientEditErrors(v) {
    const out = {};
    if (!isoDateOk(v.date)) out.date = 'תאריך כניסה חסר או מחוץ לטווח';
    if (!(Number(v.pay) >= 0)) out.pay = 'סכום חודשי לא תקין';
    if (!PATIENT_STATUSES.some(function (st) { return st.id === s(v.status); })) out.status = 'סטטוס לא תקין';
    return out;
  }

  /* '' when the answer proves the lead landed, else the Hebrew reason (mirrors
   * app.js promoteSkippedMessage / conflictsMessage / requireProven). Pure. */
  function saveRefusal(res, id) {
    if (!res || typeof res !== 'object') return 'השמירה נכשלה — אין תשובה מהשרת';
    if (res.ok === false) {
      if (res.error === 'lock_busy') return res.message || 'המערכת עסוקה, נסי שוב בעוד רגע';
      if (Array.isArray(res.invalidLeads) && res.invalidLeads.length) return 'לא נשמר: ליד חייב שם וטלפון תקין';
      if (Array.isArray(res.badLeadDates) && res.badLeadDates.length) return 'לא נשמר: תאריך מחוץ לטווח המותר';
      return res.message || ('השמירה נדחתה' + (res.error ? ' (' + res.error + ')' : ''));
    }
    if (Array.isArray(res.closedSuppressed) && res.closedSuppressed.indexOf(s(id)) >= 0) return 'הליד נסגר או הוסר בינתיים — רענני את המסך';
    const proven = res.proven && Array.isArray(res.proven.leads) ? res.proven.leads.map(s) : [];
    if (proven.indexOf(s(id)) < 0) return 'השמירה לא אומתה — רענני ובדקי';
    return '';
  }

  /* The areas a session may see — the SERVER's gates, mirrored for display
   * (the server refuses the data itself): the controller view (Ortal) sees
   * היום שלי / גבייה / בקרה; a session without finance (Dana) never sees גבייה. */
  function areasFor(me) {
    const m = me || {};
    if (m.view === 'controller') return ['today', 'billing', 'control'];
    if (!m.finance) return ['today', 'leads', 'occupancy', 'clients', 'calendar', 'control'];
    return AREAS.map(function (a) { return a.id; });
  }

  const s = function (v) { return String(v == null ? '' : v).trim(); };
  function houseId(idOrName) {
    const k = HOUSE_ALIASES[s(idOrName)] || s(idOrName);
    for (let i = 0; i < HOUSES.length; i++) if (HOUSES[i].id === k || HOUSES[i].name === k) return HOUSES[i].id;
    return '';
  }
  function houseName(idOrName) {
    const id = houseId(idOrName);
    for (let i = 0; i < HOUSES.length; i++) if (HOUSES[i].id === id) return HOUSES[i].name;
    return s(idOrName);
  }
  /* In the house now — the SAME rule as app.js houseOccupancyCount (status only). */
  function inHouse(p) { return s(p && p.status) !== 'released'; }

  /* «תפוסה»: per house, occupied / capacity / free; closed houses only when occupied;
   * patients whose house resolves to none are counted apart («בית לא מזוהה»). */
  function occupancy(patients) {
    const rows = [];
    let unknown = 0, totalIn = 0, totalCap = 0;
    const by = {};
    (patients || []).forEach(function (p) {
      if (!inHouse(p)) return;
      const id = houseId(p.houseId);
      if (!id) { unknown++; return; }
      by[id] = (by[id] || 0) + 1;
    });
    HOUSES.forEach(function (h) {
      const n = by[h.id] || 0;
      if (h.closed && n === 0) return;
      const cap = h.closed ? 0 : h.capacity;
      rows.push({ id: h.id, name: h.name, capacity: cap, inHouse: n, free: Math.max(0, cap - n), pct: cap ? Math.round(100 * n / cap) : 0, closed: !!h.closed });
      totalIn += n; totalCap += cap;
    });
    return { houses: rows, unknown: unknown, totalIn: totalIn, totalCap: totalCap, totalFree: Math.max(0, totalCap - totalIn) };
  }
  function isoDay(v) { const t = s(v); return /^\d{4}-\d{2}-\d{2}/.test(t) ? t.slice(0, 10) : ''; }
  function daysBetween(a, b) {
    const da = Date.parse(a + 'T00:00:00Z'), db = Date.parse(b + 'T00:00:00Z');
    if (isNaN(da) || isNaN(db)) return 0;
    return Math.round((db - da) / 86400000);
  }
  function addDays(iso, n) { return new Date(Date.parse(iso + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10); }
  /* ISO 'YYYY-MM-DD' → the dashboard's DD/MM/YYYY; anything else as is. Pure. */
  function fmtDate(iso) { const t = s(iso); const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(t); return m ? m[3] + '/' + m[2] + '/' + m[1] : t; }
  function stageLabel(id) { for (let i = 0; i < STAGES.length; i++) if (STAGES[i].id === id) return STAGES[i].label; return s(id); }

  /* getData → flat, normalised lists. Patients arrive keyed by house. */
  function normalise(data) {
    const d = data && typeof data === 'object' ? data : {};
    const leads = (Array.isArray(d.leads) ? d.leads : []).map(function (l) {
      return { id: s(l.id), name: s(l.name), phone: s(l.phone), house: s(l.house), source: s(l.source), stage: s(l.stage) || 'new',
        assignedTo: s(l.assignedTo), created: isoDay(l.created), visitDate: isoDay(l.visitDate), visitTime: s(l.visitTime),
        meetingWith: s(l.meetingWith), meetingOutcome: s(l.meetingOutcome), note: s(l.note),
        contactName: s(l.contactName), contactPhone: s(l.contactPhone), contactRelation: s(l.contactRelation),
        advance: l.advance === '' || l.advance == null ? '' : Number(l.advance) || 0 };
    });
    const patients = [];
    const p = d.patients;
    if (Array.isArray(p)) p.forEach(function (x) { patients.push(x); });
    else if (p && typeof p === 'object') Object.keys(p).forEach(function (h) { (Array.isArray(p[h]) ? p[h] : []).forEach(function (x) { patients.push(Object.assign({ houseId: h }, x)); }); });
    const pts = patients.map(function (x) {
      return { id: s(x.id), houseId: s(x.houseId), name: s(x.name), date: isoDay(x.date), status: s(x.status) || 'active',
        exitDate: isoDay(x.exitDate), fromLead: s(x.fromLead), source: s(x.source), personId: s(x.personId) };
    });
    return { leads: leads, patients: pts };
  }

  /* The work queue and the KPIs of «היום שלי» (Vered). Next action / due
   * date are COMPUTED from existing fields; a real task record is a later
   * track (spec §14) — rows say so with `derived: true`. */
  function compute(data, today) {
    const n = normalise(data);
    const rows = [];
    const kpi = { late: 0, today: 0, newLeads: 0, meetingsToday: 0 };
    n.leads.forEach(function (l) {
      if (STAGES.every(function (st) { return st.id !== l.stage; })) return;   // only open board leads
      if (l.created === today) kpi.newLeads++;
      if (l.stage === 'visit' && l.visitDate === today) kpi.meetingsToday++;
      let row = null;
      if (l.stage === 'visit' && l.visitDate && l.visitDate < today && !l.meetingOutcome) {
        row = { kind: 'meeting_no_outcome', action: 'לקבל דיווח מהמנהל/ת על הפגישה', owner: l.meetingWith || l.assignedTo,
          due: l.visitDate, state: 'late', reason: 'הפגישה התקיימה לפני ' + daysBetween(l.visitDate, today) + ' ימים' };
      } else if (l.stage === 'visit' && l.visitDate === today) {
        row = { kind: 'meeting_today', action: 'פגישת קבלה היום' + (l.visitTime ? ' · ' + l.visitTime : ''), owner: l.meetingWith || l.assignedTo, due: today, state: 'today', reason: '' };
      } else if (l.stage === 'visit' && !l.visitDate) {
        row = { kind: 'meeting_unscheduled', action: 'לתאם פגישה', owner: l.assignedTo, due: '', state: 'wait', reason: 'ביקור ללא תאריך' };
      } else if (l.stage === 'new' && l.created && daysBetween(l.created, today) >= WAIT_DAYS) {
        row = { kind: 'lead_waiting', action: 'לחזור למשפחה', owner: l.assignedTo, due: addDays(l.created, WAIT_DAYS), state: 'late',
          reason: 'ממתין ' + daysBetween(l.created, today) + ' ימים' };
      } else if (l.stage === 'new') {
        row = { kind: 'lead_new', action: 'ליצור קשר ראשון', owner: l.assignedTo, due: addDays(l.created || today, WAIT_DAYS), state: 'wait', reason: '' };
      } else if (l.stage === 'waitlist') {
        row = { kind: 'waitlist', action: 'לעדכן על מקום פנוי', owner: l.assignedTo, due: '', state: 'wait', reason: 'ממתין למקום · ' + houseName(l.house) };
      } else if (l.stage === 'paid') {
        row = { kind: 'admit', action: 'קליטה לבית', owner: l.assignedTo, due: '', state: 'wait', reason: 'בטיפול פעיל · ' + houseName(l.house) };
      }
      if (row) {
        row.leadId = l.id; row.client = l.name; row.house = houseName(l.house); row.derived = true;
        rows.push(row);
        if (row.state === 'late') kpi.late++; else if (row.state === 'today') kpi.today++;
      }
    });
    const order = { late: 0, today: 1, wait: 2 };
    rows.sort(function (a, b) { return (order[a.state] - order[b.state]) || (a.due || '9').localeCompare(b.due || '9'); });
    return { kpi: kpi, rows: rows, leads: n.leads, patients: n.patients };
  }

  /* «פניות»: the board columns and the table rows share one filter. */
  function filterLeads(leads, f) {
    const q = s(f && f.q).toLowerCase(), house = s(f && f.house), owner = s(f && f.owner);
    return leads.filter(function (l) {
      if (STAGES.every(function (st) { return st.id !== l.stage; })) return false;
      if (house && houseName(l.house) !== houseName(house)) return false;
      if (owner && l.assignedTo !== owner) return false;
      if (q && (l.name + ' ' + l.phone + ' ' + houseName(l.house)).toLowerCase().indexOf(q) < 0) return false;
      return true;
    });
  }
  function board(leads, f) {
    const list = filterLeads(leads, f);
    return STAGES.map(function (st) { return { stage: st, leads: list.filter(function (l) { return l.stage === st.id; }) }; });
  }
  function nextActionFor(l, today) {
    if (l.stage === 'visit' && l.visitDate && l.visitDate < today && !l.meetingOutcome) return { text: 'דיווח מהמנהל/ת', state: 'late' };
    if (l.stage === 'visit' && l.visitDate === today) return { text: 'פגישה היום', state: 'today' };
    if (l.stage === 'visit') return { text: l.visitDate ? 'פגישה ' + fmtDate(l.visitDate) : 'לתאם פגישה', state: 'wait' };
    if (l.stage === 'new') return { text: 'ליצור קשר', state: l.created && daysBetween(l.created, today) >= WAIT_DAYS ? 'late' : 'wait' };
    if (l.stage === 'waitlist') return { text: 'ממתין למקום', state: 'wait' };
    return { text: 'קליטה לבית', state: 'wait' };
  }

  /* «לקוחות»: patients in a house today, days in house. */
  function clients(patients, today, f) {
    const q = s(f && f.q).toLowerCase(), house = s(f && f.house);
    return patients.filter(function (p) {
      if (!inHouse(p)) return false;                                        // the dashboard's own count rule
      if (house && houseName(p.houseId) !== houseName(house)) return false;   // id or Hebrew name, shared with the leads filter
      if (q && (p.name + ' ' + houseName(p.houseId)).toLowerCase().indexOf(q) < 0) return false;
      return true;
    }).map(function (p) { return Object.assign({ houseName: houseName(p.houseId), days: p.date ? daysBetween(p.date, today) : '' }, p); })
      .sort(function (a, b) { return a.houseName.localeCompare(b.houseName) || a.name.localeCompare(b.name); });
  }

  /* «יומן»: meetings from today onward (14 days), earliest first. */
  function calendar(leads, today, days) {
    const last = addDays(today, days || 14);
    return leads.filter(function (l) { return l.stage === 'visit' && l.visitDate && l.visitDate >= today && l.visitDate <= last; })
      .sort(function (a, b) { return (a.visitDate + a.visitTime).localeCompare(b.visitDate + b.visitTime); });
  }

  /* «בקרה»: the action metrics of spec §10 — counts only. */
  function control(c, today) {
    const untouched = c.leads.filter(function (l) { return l.stage === 'new' && l.created && daysBetween(l.created, today) >= WAIT_DAYS; }).length;
    const noOutcome = c.leads.filter(function (l) { return l.stage === 'visit' && l.visitDate && l.visitDate < today && !l.meetingOutcome; }).length;
    const unscheduled = c.leads.filter(function (l) { return l.stage === 'visit' && !l.visitDate; }).length;
    const admitting = c.leads.filter(function (l) { return l.stage === 'paid'; }).length;
    return [
      { id: 'untouched', label: 'פניות ללא טיפול (' + WAIT_DAYS + '+ ימים)', value: untouched },
      { id: 'late', label: 'משימות באיחור', value: c.kpi.late },
      { id: 'noOutcome', label: 'פגישות ללא תוצאה', value: noOutcome },
      { id: 'unscheduled', label: 'ביקורים ללא תאריך', value: unscheduled },
      { id: 'admitting', label: 'מעברים פתוחים (קליטה)', value: admitting },
    ];
  }

  /* Ortal's day from billingControlQueue: counts by status. */
  function controllerDay(queue) {
    const list = queue && Array.isArray(queue.receipts) ? queue.receipts : [];
    const by = { reported: 0, flagged: 0, confirmed: 0 };
    list.forEach(function (r) { const st = s(r.status); if (by[st] !== undefined) by[st]++; });
    return { toVerify: by.reported, flagged: by.flagged, confirmed: by.confirmed, total: list.length };
  }

  const esc = function (v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };

  /* ================= DOM ================= */
  function boot(win, doc) {
    const state = { me: null, data: null, area: 'today', view: 'board', filters: { q: '', house: '', owner: '' }, kpiFilter: '', queue: null,
      today: new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date()), drawer: null, error: '', loading: true, sort: 'name' };
    const $ = function (sel) { return doc.querySelector(sel); };
    const root = $('#crm-root');
    const main = $('#crm-main');
    const navEl = $('#crm-nav');
    const menuEl = $('#crm-menu');

    function api(action, extra) {
      const q = Object.assign({ action: action }, extra || {});
      const qs = Object.keys(q).map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(q[k]); }).join('&');
      return win.fetch('/api/sheets?' + qs, { credentials: 'same-origin' }).then(function (r) {
        return r.json().catch(function () { return { ok: false, error: 'bad_json' }; }).then(function (j) { if (!r.ok && j && j.ok !== false) j = { ok: false, error: 'http_' + r.status }; return j; });
      });
    }

    function setArea(id) { state.area = id; state.kpiFilter = ''; renderNav(); renderMain(); menuEl.removeAttribute('data-open'); $('#crm-scrim').removeAttribute('data-open'); }

    function renderNav() {
      const areas = areasFor(state.me);
      const c = state.data ? compute(state.data, state.today) : null;
      navEl.innerHTML = AREAS.filter(function (a) { return areas.indexOf(a.id) >= 0; }).map(function (a) {
        let n = '';
        if (c && a.id === 'today') n = state.me && state.me.view === 'controller' ? (state.queue ? controllerDay(state.queue).toVerify : '') : c.kpi.late + c.kpi.today;
        if (c && a.id === 'leads') n = filterLeads(c.leads, {}).length;
        return '<button type="button" data-area="' + a.id + '"' + (state.area === a.id ? ' aria-current="page"' : '') + '><span>' + esc(a.label) + '</span>' + (n !== '' ? '<span class="n">' + esc(n) + '</span>' : '') + '</button>';
      }).join('');
    }

    function chip(state_, text) { return '<span class="chip ' + esc(state_) + '">' + esc(text) + '</span>'; }
    function stateText(st) { return st === 'late' ? 'באיחור' : st === 'today' ? 'להיום' : 'ממתין'; }

    function renderToday(c) {
      if (state.me && state.me.view === 'controller') return renderControllerToday();
      const k = c.kpi;
      const kp = [['late', 'משימות באיחור', k.late], ['today', 'לטיפול היום', k.today], ['new', 'פניות חדשות', k.newLeads], ['meetings', 'פגישות היום', k.meetingsToday]];
      let rows = c.rows;
      if (state.kpiFilter === 'late') rows = rows.filter(function (r) { return r.state === 'late'; });
      if (state.kpiFilter === 'today') rows = rows.filter(function (r) { return r.state === 'today'; });
      if (state.kpiFilter === 'meetings') rows = rows.filter(function (r) { return r.kind === 'meeting_today'; });
      if (state.kpiFilter === 'new') rows = rows.filter(function (r) { return r.kind === 'lead_new' || r.kind === 'lead_waiting'; });
      const groups = [['late', 'באיחור'], ['today', 'להיום'], ['wait', 'ממתין לגורם אחר / בתהליך']];
      return '<div class="kpis">' + kp.map(function (x) { return '<button type="button" class="kpi" data-kpi="' + x[0] + '" aria-pressed="' + (state.kpiFilter === x[0]) + '"><span class="v">' + x[2] + '</span><span class="l">' + esc(x[1]) + '</span></button>'; }).join('') + '</div>'
        + '<p class="na">הפעולה הבאה ומועד היעד מחושבים מהשדות הקיימים (ליד, פגישה, שלב). רשומת משימה עם תאריך יעד ואחראי — בשלב הבא.</p>'
        + (rows.length === 0 ? '<div class="crm-state">אין משימות פתוחות</div>' : '')
        + groups.map(function (g) {
          const list = rows.filter(function (r) { return r.state === g[0]; });
          if (!list.length) return '';
          return '<div class="group-title">' + esc(g[1]) + ' <span class="n chip">' + list.length + '</span></div><div class="rows">'
            + '<div class="row h"><span>לקוח</span><span>הפעולה הנדרשת</span><span>אחראי</span><span>מועד יעד</span><span>מצב</span><span></span></div>'
            + list.map(function (r) {
              return '<div class="row" data-lead="' + esc(r.leadId) + '"><span><span class="name">' + esc(r.client) + '</span><br><span class="sub">' + esc(r.house) + '</span></span>'
                + '<span>' + esc(r.action) + '</span><span>' + esc(r.owner || '—') + '</span><span>' + esc(r.due ? fmtDate(r.due) : '—') + '</span>'
                + '<span>' + chip(r.state, stateText(r.state)) + (r.reason ? '<br><span class="sub">' + esc(r.reason) + '</span>' : '') + '</span>'
                + '<span><button type="button" class="btn small" data-open-lead="' + esc(r.leadId) + '">כרטיס</button></span></div>';
            }).join('') + '</div>';
        }).join('');
    }

    function renderControllerToday() {
      if (!state.queue) return '<div class="crm-state">טוען את תור האימות…</div>';
      if (state.queue.ok === false) return '<div class="crm-state bad">תור האימות לא נטען (' + esc(state.queue.error || '') + ')</div>';
      const d = controllerDay(state.queue);
      return '<div class="kpis">' + [['toVerify', 'דיווחים לאימות', d.toVerify], ['flagged', 'אימותים חלקיים / לבירור', d.flagged], ['confirmed', 'אומתו', d.confirmed]].map(function (x) {
        return '<div class="kpi"><span class="v">' + x[2] + '</span><span class="l">' + esc(x[1]) + '</span></div>';
      }).join('') + '</div><div class="links"><a href="/">בקרת גבייה — העבודה המלאה בדשבורד<small>אימות, סימון לבירור, ייצוא</small></a></div>';
    }

    function renderLeads(c) {
      const owners = {};
      c.leads.forEach(function (l) { if (l.assignedTo) owners[l.assignedTo] = true; });
      const f = state.filters;
      const toolbar = '<div class="toolbar"><div class="seg"><button type="button" data-view="board" aria-pressed="' + (state.view === 'board') + '">לוח</button><button type="button" data-view="table" aria-pressed="' + (state.view === 'table') + '">טבלה</button></div>'
        + '<select id="f-house"><option value="">כל הבתים</option>' + HOUSES.filter(function (h) { return h.id !== 'sde'; }).map(function (h) { return '<option value="' + esc(h.name) + '"' + (f.house === h.name ? ' selected' : '') + '>' + esc(h.name) + '</option>'; }).join('') + '</select>'
        + '<select id="f-owner"><option value="">כל האחראים</option>' + Object.keys(owners).map(function (o) { return '<option' + (f.owner === o ? ' selected' : '') + '>' + esc(o) + '</option>'; }).join('') + '</select>'
        + '<button type="button" class="btn primary" id="crm-new-lead">+ פנייה חדשה</button>'
        + '<button type="button" class="btn" data-view="closed" aria-pressed="' + (state.view === 'closed') + '">לידים סגורים</button></div>';
      if (state.view === 'closed') return toolbar + renderClosedLeads();
      if (state.view === 'board') {
        return toolbar + '<div class="board">' + board(c.leads, f).map(function (col) {
          return '<div class="col"><h3><span>' + esc(col.stage.label) + '</span><span class="n">' + col.leads.length + '</span></h3>' + col.leads.map(function (l) {
            const na = nextActionFor(l, state.today);
            return '<div class="card" data-open-lead="' + esc(l.id) + '"><div class="name">' + esc(l.name) + '</div><div class="meta"><span>' + esc(houseName(l.house) || '—') + '</span>' + (l.source ? '<span class="chip">' + esc(l.source) + '</span>' : '') + (l.assignedTo ? '<span>' + esc(l.assignedTo) + '</span>' : '') + '</div>'
              + (l.created ? '<div class="meta"><span>נוצר ' + esc(fmtDate(l.created)) + '</span>' + (l.visitDate ? '<span>פגישה ' + esc(fmtDate(l.visitDate)) + (l.visitTime ? ' ' + esc(l.visitTime) : '') + '</span>' : '') + '</div>' : '')
              + '<div class="next">' + chip(na.state, na.text) + (stageAfter(l.stage) ? ' <button type="button" class="btn small" data-stage-next="' + esc(l.id) + '">שלב הבא ←</button>' : '') + '</div></div>';
          }).join('') + '</div>';
        }).join('') + '</div>';
      }
      const list = filterLeads(c.leads, f).slice().sort(function (a, b) { return s(a[state.sort]).localeCompare(s(b[state.sort])); });
      const cols = [['name', 'שם'], ['house', 'בית'], ['source', 'מקור'], ['assignedTo', 'אחראי'], ['stage', 'שלב'], ['visitDate', 'פגישה'], ['created', 'נוצר']];
      return toolbar + '<div class="tbl-wrap"><table class="tbl"><thead><tr>' + cols.map(function (c2) { return '<th data-sort="' + c2[0] + '">' + esc(c2[1]) + (state.sort === c2[0] ? ' ▾' : '') + '</th>'; }).join('') + '<th>פעולה הבאה</th></tr></thead><tbody>'
        + list.map(function (l) { const na = nextActionFor(l, state.today); return '<tr data-open-lead="' + esc(l.id) + '"><td>' + esc(l.name) + '</td><td>' + esc(houseName(l.house)) + '</td><td>' + esc(l.source) + '</td><td>' + esc(l.assignedTo) + '</td><td>' + esc(stageLabel(l.stage)) + '</td><td>' + esc(fmtDate(l.visitDate)) + '</td><td>' + esc(fmtDate(l.created)) + '</td><td>' + chip(na.state, na.text) + '</td></tr>'; }).join('')
        + '</tbody></table></div>' + (list.length === 0 ? '<div class="crm-state">אין פניות התואמות לסינון</div>' : '');
    }

    function renderClosedLeads() {
      const list = (state.data && Array.isArray(state.data.irrelevantLeads) ? state.data.irrelevantLeads : []).slice()
        .sort(function (a, b) { return s(b.movedAt).localeCompare(s(a.movedAt)); });
      const label = function (d) { return (DISPOSITIONS.filter(function (x) { return x.id === s(d); })[0] || { label: s(d) || 'לא רלוונטי' }).label; };
      if (!list.length) return '<div class="crm-state">אין לידים סגורים</div>';
      return '<div class="tbl-wrap"><table class="tbl"><thead><tr><th>שם</th><th>בית</th><th>סטטוס סגירה</th><th>סיבה</th><th>נסגר</th><th></th></tr></thead><tbody>'
        + list.slice(0, 300).map(function (l) {
          return '<tr><td>' + esc(l.name) + '</td><td>' + esc(houseName(l.house)) + '</td><td>' + esc(label(l.disposition)) + '</td><td>' + esc(l.not_relevant_note) + '</td><td>' + esc(fmtDate(s(l.movedAt).slice(0, 10))) + '</td>'
            + '<td><button type="button" class="btn small" data-restore-lead="' + esc(l.id) + '">שחזור ל«' + esc(stageLabel(s(l.originSheet) || 'new')) + '»</button></td></tr>';
        }).join('') + '</tbody></table></div>';
    }
    function renderNewLeadForm() {
      const field = function (name, label, type, extra) { return '<label>' + esc(label) + ' <input name="' + name + '" type="' + (type || 'text') + '"' + (extra || '') + '><span class="err" data-err="' + name + '"></span></label>'; };
      return '<form data-form="new-lead" class="new-lead" novalidate>'
        + '<h3>פרטי המטופל</h3>' + field('name', 'שם מלא *', 'text', ' required') + field('phone', 'טלפון *', 'tel', ' required')
        + '<h3>פרטי הפונה</h3>' + field('contactName', 'שם') + field('contactPhone', 'טלפון', 'tel')
        + '<label>קשר למטופל <select name="contactRelation"><option value="">— ללא —</option>' + CONTACT_RELATIONS.map(function (r) { return '<option>' + esc(r) + '</option>'; }).join('') + '</select></label>'
        + field('contactRelationOther', 'קשר אחר')
        + '<label>טלפון לגבייה ועדכונים <select name="billingMode"><option value="patient">מטופל</option><option value="contact">פונה</option><option value="other">אחר</option></select></label>'
        + field('billingOther', 'טלפון אחר לגבייה', 'tel')
        + '<h3>פרטים נוספים</h3>'
        + '<label>בית מועדף <select name="house"><option value="">— ללא —</option>' + HOUSES.filter(function (h) { return !h.closed; }).map(function (h) { return '<option>' + esc(h.name) + '</option>'; }).join('') + '</select></label>'
        + '<label>מקור הפנייה <input name="source" list="crm-sources"><datalist id="crm-sources">' + SOURCES.map(function (x) { return '<option value="' + esc(x) + '">'; }).join('') + '</datalist></label>'
        + '<label>משוייך ל * <select name="assignedTo" required><option value="">— בחר —</option>' + ASSIGNEES.map(function (a) { return '<option>' + esc(a) + '</option>'; }).join('') + '</select><span class="err" data-err="assignedTo"></span></label>'
        + '<label>נפגש/ת עם <select name="meetingWith"><option value="">—</option>' + managersOf('').concat([MEETING_WITH_AMBULATORY]).map(function (m) { return '<option>' + esc(m) + '</option>'; }).join('') + '</select></label>'
        + '<label class="wide">הערות <textarea name="note" rows="2"></textarea></label>'
        + '<div class="wide"><button type="submit" class="btn primary">הוסף ליד</button> <button type="button" class="btn" data-cancel-drawer="1">ביטול</button> <span class="na" id="crm-save-state"></span></div>'
        + '</form>';
    }
    function openNewLeadDrawer() {
      const dr = $('#crm-drawer');
      dr.innerHTML = '<div class="drawer-head"><div><h2>פנייה חדשה</h2><div class="meta">ליד חדש נכנס ללוח בשלב «ליד חדש»</div></div><button type="button" class="btn small" id="crm-drawer-close" aria-label="סגירה">✕</button></div>' + renderNewLeadForm();
      dr.setAttribute('aria-hidden', 'false'); $('#crm-scrim').setAttribute('data-open', 'true');
      state.drawer = { kind: 'new', id: '', tab: 'overview' };
      const first = dr.querySelector('[name="name"]'); if (first) first.focus();
    }
    /* A generic write through /api/sheets for the lifecycle actions; `apply`
     * mutates state optimistically, `undo` reverts it. */
    function postAction(body, okCheck, apply, undo, label) {
      const payload = JSON.stringify(body);          // serialised BEFORE the optimistic apply (which may strip intent fields)
      state.saving = true; apply(); renderNav(); renderMain(); setSaveState('שומר…');
      return win.fetch('/api/sheets', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: payload })
        .then(function (r) { return r.json().catch(function () { return null; }); })
        .then(function (res) {
          const why = okCheck(res);
          if (why) throw new Error(why);
          state.saving = false; toast(label + ' — בוצע'); return true;
        })
        .catch(function (e) { undo(); state.saving = false; renderNav(); renderMain(); setSaveState(String(e && e.message || e), true); toast(String(e && e.message || e), true); return false; });
    }
    function genericRefusal(res, idKey) {
      if (!res || typeof res !== 'object') return 'אין תשובה מהשרת';
      if (res.ok === false) return res.message || ('הפעולה נדחתה' + (res.error ? ' (' + res.error + ')' : ''));
      if (idKey && !(res.lead && s(res.lead.id))) return 'הפעולה לא אומתה — רענני ובדקי';
      return '';
    }
    function createLead(values) {
      const errs = leadFormErrors(values);
      const f = $('#crm-drawer form[data-form="new-lead"]');
      if (f) Object.keys(errs).concat(['name', 'phone', 'assignedTo', 'contactPhone']).forEach(function (k) { const el = f.querySelector('[data-err="' + k + '"]'); if (el) el.textContent = errs[k] || ''; });
      if (Object.keys(errs).length) return Promise.resolve(false);
      const dup = duplicateByPhone(state.data.leads, values.phone);
      if (dup && !win.confirm('כבר קיים ליד «' + dup.name + '» עם הטלפון הזה. להוסיף בכל זאת?')) return Promise.resolve(false);
      const row = newLeadRow(values, randomId(), state.today);
      const list = state.data.leads;
      closeDrawer();
      return postAction(leadSaveBody(row), function (res) { return saveRefusal(res, row.id); },
        function () { list.unshift(row); }, function () { const i = list.indexOf(row); if (i >= 0) list.splice(i, 1); }, 'הליד «' + row.name + '» נוסף');
    }
    function closeLeadAction(id, disposition, note) {
      const list = state.data.leads, i = list.findIndex(function (l) { return s(l.id) === s(id); });
      if (i < 0) return Promise.resolve(false);
      const raw = list[i];
      const rec = closeRecord(raw, disposition, note, new Date().toISOString());
      if (!Array.isArray(state.data.irrelevantLeads)) state.data.irrelevantLeads = [];
      closeDrawer();
      return postAction({ action: 'moveLeadIrrelevant', lead: rec }, function (res) { return genericRefusal(res, true); },
        function () { list.splice(i, 1); state.data.irrelevantLeads.unshift(rec); },
        function () { state.data.irrelevantLeads = state.data.irrelevantLeads.filter(function (l) { return l !== rec; }); list.splice(i, 0, raw); }, 'הליד נסגר');
    }
    function removeLeadAction(id) {
      const list = state.data.leads, i = list.findIndex(function (l) { return s(l.id) === s(id); });
      if (i < 0) return Promise.resolve(false);
      const raw = list[i];
      if (!win.confirm('להסיר את הליד «' + s(raw.name) + '»? הליד יעבור לרשימת הלידים שהוסרו.')) return Promise.resolve(false);
      closeDrawer();
      return postAction({ action: 'removeLead', lead: raw }, function (res) { return genericRefusal(res, true); },
        function () { list.splice(i, 1); }, function () { list.splice(i, 0, raw); }, 'הליד הוסר');
    }
    function restoreLeadAction(id) {
      const closed = state.data.irrelevantLeads || [], i = closed.findIndex(function (l) { return s(l.id) === s(id); });
      if (i < 0) return Promise.resolve(false);
      const rec = closed[i];
      const back = Object.assign({}, rec, { stage: s(rec.originSheet) || 'new' });
      return postAction({ action: 'restoreLead', lead: rec }, function (res) { return genericRefusal(res, true); },
        function () { closed.splice(i, 1); state.data.leads.unshift(back); },
        function () { state.data.leads = state.data.leads.filter(function (l) { return l !== back; }); closed.splice(i, 0, rec); }, 'הליד שוחזר');
    }

    function patientsOfHouse(hid) {
      const p = state.data && state.data.patients;
      if (!p || typeof p !== 'object' || Array.isArray(p)) return [];
      if (!Array.isArray(p[hid])) p[hid] = [];
      return p[hid];
    }
    function showErrs(f, errs, keys) {
      keys.forEach(function (k) { const el = f.querySelector('[data-err="' + k + '"]'); if (el) el.textContent = errs[k] || ''; });
    }
    function saveFunderBestEffort(pid, funder, effectiveFrom) {
      if (!(state.me && state.me.finance) || FUNDERS.indexOf(s(funder)) < 0) return Promise.resolve();
      return win.fetch('/api/sheets', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'appendFunder', funder: { patientId: pid, funder: s(funder), effectiveFrom: effectiveFrom, submissionId: randomId().slice(3) + randomId().slice(3) } }) })
        .then(function (r) { return r.json().catch(function () { return null; }); })
        .then(function (res) { if (!res || res.ok === false || !(res.row && res.row.submissionId)) toast('המטופל נשמר, אך שמירת הגורם המממן נכשלה — יש להשלים בדשבורד', true); })
        .catch(function () { toast('המטופל נשמר, אך שמירת הגורם המממן נכשלה — יש להשלים בדשבורד', true); });
    }
    function admitLead(id, v, f) {
      const errs = admissionErrors(v, !!(state.me && state.me.finance));
      if (f) showErrs(f, errs, ['houseId', 'date', 'pay', 'funder']);
      if (Object.keys(errs).length) return Promise.resolve(false);
      const leads = state.data.leads, i = leads.findIndex(function (l) { return s(l.id) === s(id); });
      if (i < 0) return Promise.resolve(false);
      const raw = leads[i];
      const patient = admissionRow(raw, v, randomId());
      const leadNext = Object.assign({}, raw, { stage: 'admitted', entryDate: s(v.date) }, s(raw.visitDate) ? { meetingOutcome: 'entered' } : {});
      const rows = patientsOfHouse(patient.houseId);
      closeDrawer();
      return postAction(houseSaveBody(patient.houseId, rows, patient, leadNext), function (res) { return houseSaveRefusal(res, patient.id, leadNext.id); },
        function () { leads[i] = leadNext; rows.push(patient); },
        function () { leads[i] = raw; const k = rows.indexOf(patient); if (k >= 0) rows.splice(k, 1); }, 'הקליטה של «' + s(raw.name) + '»')
        .then(function (ok) { if (ok) return saveFunderBestEffort(patient.id, v.funder, patient.date).then(function () { return true; }); return ok; });
    }
    function directAdd(v, f) {
      const errs = directAddErrors(v, !!(state.me && state.me.finance));
      if (f) showErrs(f, errs, ['name', 'phone', 'houseId', 'date', 'pay', 'funder']);
      if (Object.keys(errs).length) return Promise.resolve(false);
      const pair = directAddRows(v, randomId(), state.today, houseName);
      const rows = patientsOfHouse(pair.patient.houseId);
      const leads = state.data.leads;
      closeDrawer();
      return postAction(houseSaveBody(pair.patient.houseId, rows, pair.patient, pair.lead), function (res) { return houseSaveRefusal(res, pair.patient.id, pair.lead.id); },
        function () { rows.push(pair.patient); leads.unshift(pair.lead); },
        function () { const k = rows.indexOf(pair.patient); if (k >= 0) rows.splice(k, 1); const j = leads.indexOf(pair.lead); if (j >= 0) leads.splice(j, 1); }, 'הוספת «' + pair.patient.name + '»')
        .then(function (ok) { if (ok) return saveFunderBestEffort(pair.patient.id, v.funder, pair.patient.date).then(function () { return true; }); return ok; });
    }
    function openDirectAddDrawer() {
      const dr = $('#crm-drawer');
      const hid = houseId(state.filters.house) || 'ramot';
      dr.innerHTML = '<div class="drawer-head"><div><h2>הוספת מטופל/ת ישירות</h2><div class="meta">פנייה ישירה — נוצר ליד «פנייה ישירה» שנקלט</div></div><button type="button" class="btn small" id="crm-drawer-close" aria-label="סגירה">✕</button></div>'
        + '<form data-form="direct-add" class="new-lead" novalidate>'
        + '<label>שם מלא * <input name="name" type="text"><span class="err" data-err="name"></span></label>'
        + '<label>טלפון המטופל/ת <input name="phone" type="tel"><span class="err" data-err="phone"></span></label>'
        + '<label>בית * <select name="houseId">' + HOUSES.filter(function (h) { return !h.closed; }).map(function (h) { return '<option value="' + h.id + '"' + (h.id === hid ? ' selected' : '') + '>' + esc(h.name) + '</option>'; }).join('') + '</select><span class="err" data-err="houseId"></span></label>'
        + '<label>תאריך כניסה * <input type="date" name="date" value="' + esc(state.today) + '"><span class="err" data-err="date"></span></label>'
        + '<label>סכום חודשי (₪) * <input type="number" name="pay" min="0" step="1"><span class="err" data-err="pay"></span></label>'
        + '<label>סטטוס <select name="status">' + [{ id: 'active', label: 'פעיל' }, { id: 'trial', label: 'תקופת ניסיון' }, { id: 'wait', label: 'בהמתנה' }].map(function (st) { return '<option value="' + st.id + '">' + esc(st.label) + '</option>'; }).join('') + '</select></label>'
        + (state.me && state.me.finance ? '<label>גורם מממן * <select name="funder"><option value="">— בחרו —</option>' + FUNDERS.map(function (x) { return '<option>' + esc(x) + '</option>'; }).join('') + '</select><span class="err" data-err="funder"></span></label>' : '')
        + '<label class="wide">הערות <textarea name="notes" rows="2"></textarea></label>'
        + '<div class="wide"><button type="submit" class="btn primary">הוסף מטופל/ת</button> <button type="button" class="btn" data-cancel-drawer="1">ביטול</button> <span class="na" id="crm-save-state"></span></div></form>';
      dr.setAttribute('aria-hidden', 'false'); $('#crm-scrim').setAttribute('data-open', 'true');
      state.drawer = { kind: 'direct', id: '', tab: 'overview' };
    }

    function renderPatientActions(p) {
      if (!p || !inHouse(p)) return '';
      const raw = (patientsOfHouse(p.houseId) || []).filter(function (x) { return s(x.id) === s(p.id); })[0] || p;
      return '<div class="actions" data-patient-actions="' + esc(p.id) + '"><div class="toolbar"><span class="na" id="crm-save-state"></span></div>'
        + '<details class="act"><summary>עריכה</summary><form data-form="patient-edit" data-patient="' + esc(p.id) + '" novalidate>'
        + '<label>תאריך כניסה <input type="date" name="date" value="' + esc(s(raw.date).slice(0, 10)) + '"><span class="err" data-err="date"></span></label>'
        + '<label>סכום חודשי (₪) <input type="number" name="pay" min="0" step="1" value="' + esc(Number(raw.pay) || 0) + '"><span class="err" data-err="pay"></span></label>'
        + '<label>מקדמה (₪) <input type="number" name="adv" min="0" step="1" value="' + esc(Number(raw.adv) || 0) + '"></label>'
        + '<label>סטטוס <select name="status">' + PATIENT_STATUSES.map(function (st) { return '<option value="' + st.id + '"' + (s(raw.status) === st.id ? ' selected' : '') + '>' + esc(st.label) + '</option>'; }).join('') + '</select><span class="err" data-err="status"></span></label>'
        + '<label>הערות <textarea name="notes" rows="2">' + esc(raw.notes) + '</textarea></label>'
        + '<button type="submit" class="btn small primary">שמירה</button></form></details>'
        + '<details class="act"><summary>העברה לבית אחר</summary><form data-form="patient-move" data-patient="' + esc(p.id) + '" novalidate>'
        + '<label>לבית <select name="toHouseId">' + HOUSES.filter(function (h) { return !h.closed && h.id !== houseId(p.houseId); }).map(function (h) { return '<option value="' + h.id + '">' + esc(h.name) + '</option>'; }).join('') + '</select></label>'
        + '<button type="submit" class="btn small primary">העברה</button></form></details>'
        + '<details class="act"><summary>שחרור</summary><form data-form="discharge" data-patient="' + esc(p.id) + '" novalidate>'
        + '<label>סטטוס שחרור <select name="disposition"><option value="">— בחרו —</option>' + DISCHARGE_DISPOSITIONS.map(function (d) { return '<option value="' + d.id + '">' + esc(d.label) + '</option>'; }).join('') + '</select><span class="err" data-err="disposition"></span></label>'
        + '<label>תאריך שחרור <input type="date" name="dischargeDate" value="' + esc(state.today) + '"><span class="err" data-err="dischargeDate"></span></label>'
        + '<label>המשך טיפול <select name="continuity"><option value="">לא ידוע</option>' + CONTINUITY_CHOICES.map(function (c2) { return '<option value="' + c2.id + '">' + esc(c2.label) + '</option>'; }).join('') + '</select></label>'
        + '<label>הערה <input type="text" name="note" maxlength="500"></label>'
        + '<button type="submit" class="btn small primary">שחרור</button></form></details></div>';
    }
    function findPatientRow(pid) {
      const p = state.data && state.data.patients;
      if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
      const keys = Object.keys(p);
      for (let i = 0; i < keys.length; i++) {
        const arr = Array.isArray(p[keys[i]]) ? p[keys[i]] : [];
        for (let j = 0; j < arr.length; j++) if (s(arr[j] && arr[j].id) === s(pid)) return { hid: keys[i], arr: arr, idx: j, row: arr[j] };
      }
      return null;
    }
    function editPatient(pid, v, f) {
      const errs = patientEditErrors(v);
      if (f) showErrs(f, errs, ['date', 'pay', 'status']);
      if (Object.keys(errs).length) return Promise.resolve(false);
      const loc = findPatientRow(pid);
      if (!loc) return Promise.resolve(false);
      const before = loc.row;
      const next = Object.assign({}, before, { date: s(v.date), pay: Number(v.pay) || 0, adv: Number(v.adv) || 0, status: s(v.status), notes: s(v.notes) });
      closeDrawer();
      return postAction(houseSaveBody(loc.hid, loc.arr, next, null), function (res) { return houseSaveRefusal(res, pid, ''); },
        function () { loc.arr[loc.idx] = next; }, function () { loc.arr[loc.idx] = before; }, 'העריכה של «' + s(before.name) + '»');
    }
    function movePatient(pid, toHouseId) {
      const loc = findPatientRow(pid);
      if (!loc || !toHouseId || houseId(toHouseId) === houseId(loc.hid)) return Promise.resolve(false);
      const before = loc.row;
      // getData rows are keyed by house and need not carry houseId themselves: the key is the truth.
      const next = movedRow(Object.assign({}, before, { houseId: s(before.houseId) || loc.hid }), toHouseId);
      const target = patientsOfHouse(toHouseId);
      closeDrawer();
      return postAction(houseSaveBody(toHouseId, target, next, null), function (res) {
        if (res && Array.isArray(res.conflicts) && res.conflicts.some(function (c2) { return c2 && c2.move && s(c2.id) === s(pid); })) return 'ההעברה נדחתה — המטופל/ת עודכן/ה בינתיים, רענני ונסי שוב';
        return houseSaveRefusal(res, pid, '');
      },
        function () { loc.arr.splice(loc.idx, 1); delete next.movedFrom; target.push(next); },
        function () { const k = target.indexOf(next); if (k >= 0) target.splice(k, 1); loc.arr.splice(loc.idx, 0, before); },
        'ההעברה של «' + s(before.name) + '» ל' + houseName(toHouseId));
    }
    function dischargePatient(pid, v, f) {
      const errs = dischargeErrors(v);
      if (f) showErrs(f, errs, ['disposition', 'dischargeDate']);
      if (Object.keys(errs).length) return Promise.resolve(false);
      const loc = findPatientRow(pid);
      if (!loc) return Promise.resolve(false);
      const before = loc.row;
      const audit = dischargeAuditRow(before, v, randomId(), new Date().toISOString());
      const released = Object.assign({}, before, { status: 'released', exitDate: audit.exitDate });
      closeDrawer();
      state.saving = true; loc.arr[loc.idx] = released; renderNav(); renderMain(); setSaveState('שומר…');
      const post = function (body) {
        return win.fetch('/api/sheets', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
          .then(function (r) { return r.json().catch(function () { return null; }); });
      };
      let auditRes = null;
      return post({ action: 'dischargePatient', patient: audit }).then(function (res) {
        auditRes = res;
        if (!res || res.ok === false) throw new Error((res && res.message) || 'שחרור המטופל נכשל — לא נשמר' + (res && res.error ? ' (' + res.error + ')' : ''));
        if (res.duplicate === true) { if (res.exitDate) released.exitDate = s(res.exitDate).slice(0, 10); toast('השחרור כבר נרשם'); }
        else if (!(res.patient && s(res.patient.id) === audit.id)) throw new Error('השחרור לא אומת — רענני ובדקי');
        // b. the Patients row flips in the same way the classic flow does: the house as read, this row released.
        return post(houseSaveBody(loc.hid, loc.arr, released, null));
      }).then(function (res) {
        const why = houseSaveRefusal(res, pid, '');
        if (why) throw new Error('השחרור נרשם, אך עדכון הסטטוס נכשל — ' + why);
        state.saving = false; toast('«' + s(before.name) + '» שוחרר/ה');
        if (auditRes && auditRes.refund && Number(auditRes.refund.created) > 0) toast('נוצר זיכוי לפי הכלל — לטיפול אורטל');
        if (s(v.disposition) === 'released_outpatient') {
          return win.fetch('/api/outpatient-lead', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dischargeId: audit.id, manual: false }) })
            .then(function (r) { return r.json().catch(function () { return {}; }); })
            .then(function (d) { toast(d && d.ok === true && (d.sent || d.alreadySent) ? (d.alreadySent ? 'המטופל כבר נשלח לאמבולטורי' : 'נוצר ליד טיפול חוץ באאוטפיישנט') : 'יצירת ליד טיפול חוץ נכשלה — אפשר לנסות שוב בדשבורד', !(d && d.ok === true)); return true; })
            .catch(function () { toast('יצירת ליד טיפול חוץ נכשלה — אפשר לנסות שוב בדשבורד', true); return true; });
        }
        return true;
      }).catch(function (e) {
        loc.arr[loc.idx] = before; state.saving = false; renderNav(); renderMain();
        setSaveState(String(e && e.message || e), true); toast(String(e && e.message || e), true); return false;
      });
    }

    function renderClients(c) {
      const list = clients(c.patients, state.today, state.filters);
      const toolbar = '<div class="toolbar"><select id="f-house-c"><option value="">כל הבתים</option>' + HOUSES.map(function (h) { return '<option value="' + h.id + '"' + (state.filters.house === h.id ? ' selected' : '') + '>' + esc(h.name) + '</option>'; }).join('') + '</select><span class="na">' + list.length + ' בטיפול</span><button type="button" class="btn primary" id="crm-direct-add">+ הוספת מטופל/ת ישירות</button></div>';
      return toolbar + '<div class="tbl-wrap"><table class="tbl"><thead><tr><th>שם</th><th>בית</th><th>תאריך כניסה</th><th>ימים בבית</th><th>סטטוס</th></tr></thead><tbody>'
        + list.map(function (p) { return '<tr data-open-patient="' + esc(p.id) + '"><td>' + esc(p.name) + '</td><td>' + esc(p.houseName) + '</td><td>' + esc(fmtDate(p.date)) + '</td><td>' + esc(p.days) + '</td><td>' + esc(p.status) + '</td></tr>'; }).join('')
        + '</tbody></table></div>' + (list.length === 0 ? '<div class="crm-state">אין מטופלים</div>' : '');
    }

    function renderCalendar(c) {
      const list = calendar(c.leads, state.today, 14);
      if (!list.length) return '<div class="crm-state">אין פגישות ב-14 הימים הקרובים</div>';
      let day = '';
      return '<div class="rows">' + list.map(function (l) {
        const head = l.visitDate !== day ? '<div class="group-title">' + esc(l.visitDate === state.today ? 'היום · ' + fmtDate(l.visitDate) : fmtDate(l.visitDate)) + '</div>' : '';
        day = l.visitDate;
        return head + '<div class="row" data-open-lead="' + esc(l.id) + '"><span><span class="name">' + esc(l.name) + '</span><br><span class="sub">' + esc(houseName(l.house)) + '</span></span><span>פגישת קבלה' + (l.visitTime ? ' · ' + esc(l.visitTime) : '') + '</span><span>' + esc(l.meetingWith || l.assignedTo || '—') + '</span><span>' + esc(fmtDate(l.visitDate)) + '</span><span>' + chip(l.visitDate === state.today ? 'today' : 'wait', l.visitDate === state.today ? 'היום' : 'מתוכנן') + '</span><span><button type="button" class="btn small" data-open-lead="' + esc(l.id) + '">כרטיס</button></span></div>';
      }).join('') + '</div>';
    }

    function renderBilling() {
      return '<p class="na">הגבייה נשארת בדשבורד הרגיל בשלב זה; כאן הקישורים לתתי-המסכים.</p><div class="links">'
        + '<a href="/">גבייה<small>תשלומים, חובות, זיכויים</small></a><a href="/">בקרת גבייה<small>אימות דיווחים (אורטל)</small></a><a href="/">שיוך תשלומים<small>תשלומים ללא שיוך</small></a><a href="/">מסמכים<small>חשבוניות וקבלות</small></a></div>';
    }

    function renderOccupancy(c) {
      const o = occupancy(c.patients);
      return '<div class="kpis">' + [['בטיפול היום', o.totalIn], ['מיטות פנויות', o.totalFree], ['קיבולת', o.totalCap]].map(function (x) { return '<div class="kpi"><span class="v">' + x[1] + '</span><span class="l">' + esc(x[0]) + '</span></div>'; }).join('') + '</div>'
        + '<div class="links">' + o.houses.map(function (h) {
          const state_ = h.closed ? 'wait' : (h.free === 0 ? 'late' : (h.free <= 2 ? 'today' : 'ok'));
          return '<a href="#" data-house-open="' + esc(h.name) + '"><strong>' + esc(h.name) + '</strong> ' + chip(state_, h.closed ? 'סגור' : h.free + ' פנויות') + '<small>' + h.inHouse + ' / ' + (h.capacity || '—') + (h.capacity ? ' · ' + h.pct + '%' : '') + '</small></a>';
        }).join('') + (o.unknown ? '<a href="/"><strong>בית לא מזוהה</strong> ' + chip('late', o.unknown + ' מטופלים') + '<small>לתיקון בדשבורד</small></a>' : '') + '</div>'
        + '<p class="na">קליטה, יציאה והעברה בין בתים נעשות בדשבורד הרגיל (תפוסה).</p>';
    }

    function renderControl(c) {
      return '<div class="kpis">' + control(c, state.today).map(function (m) { return '<div class="kpi"><span class="v">' + m.value + '</span><span class="l">' + esc(m.label) + '</span></div>'; }).join('') + '</div><p class="na">מדדים תפעוליים בלבד; מדדים עסקיים ייבנו ממקורות מוגדרים.</p>';
    }

    function renderMain() {
      const title = (AREAS.filter(function (a) { return a.id === state.area; })[0] || AREAS[0]).label;
      $('#crm-title').textContent = title;
      if (state.loading) { main.innerHTML = '<div class="crm-state">טוען…</div>'; return; }
      if (state.error) { main.innerHTML = '<div class="crm-state bad">' + esc(state.error) + ' <button type="button" class="btn small" id="crm-retry">נסי שוב</button></div>'; return; }
      const c = compute(state.data, state.today);
      const r = { today: renderToday, leads: renderLeads, occupancy: renderOccupancy, clients: renderClients, calendar: renderCalendar, billing: renderBilling, control: renderControl }[state.area] || renderToday;
      main.innerHTML = r(c);
    }

    /* ---- lead actions (C4): stage move, meeting, outcome, note, owner ---- */
    function managersOf(houseIdOrName) {
      const list = state.data && Array.isArray(state.data.currentManagers) ? state.data.currentManagers : [];
      const hid = houseId(houseIdOrName);
      const names = [];
      list.forEach(function (m) { const n = s(m && m.name); if (n && names.indexOf(n) < 0 && (!hid || houseId(m.house) === hid)) names.push(n); });
      if (!names.length) list.forEach(function (m) { const n = s(m && m.name); if (n && names.indexOf(n) < 0) names.push(n); });
      return names;
    }
    function opts(list, current, withBlank) {
      const all = list.slice();
      if (current && all.indexOf(current) < 0) all.unshift(current);
      return (withBlank ? '<option value="">—</option>' : '') + all.map(function (v) { return '<option value="' + esc(v) + '"' + (v === current ? ' selected' : '') + '>' + esc(v) + '</option>'; }).join('');
    }
    function renderLeadActions(l) {
      const next = stageAfter(l.stage), prev = stageBefore(l.stage);
      const managers = managersOf(l.house).concat([MEETING_WITH_AMBULATORY]);
      const hid = houseId(l.house);
      const admit = '<details class="act" open><summary>קליטה לבית</summary><form data-form="admit" data-lead="' + esc(l.id) + '" novalidate>'
        + '<label>בית <select name="houseId">' + HOUSES.filter(function (h) { return !h.closed; }).map(function (h) { return '<option value="' + h.id + '"' + (h.id === hid ? ' selected' : '') + '>' + esc(h.name) + '</option>'; }).join('') + '</select><span class="err" data-err="houseId"></span></label>'
        + '<label>תאריך כניסה <input type="date" name="date" value="' + esc(l.entryDate || state.today) + '"><span class="err" data-err="date"></span></label>'
        + '<label>תשלום חודשי כולל מע"מ (₪) <input type="number" name="pay" min="0" step="1"><span class="err" data-err="pay"></span></label>'
        + '<label>מקדמה ששולמה (₪) <input type="number" name="adv" min="0" step="1" value="' + esc(l.advance === '' ? 0 : l.advance) + '"></label>'
        + '<label>סטטוס <select name="status">' + PATIENT_STATUSES.map(function (st) { return '<option value="' + st.id + '">' + esc(st.label) + '</option>'; }).join('') + '</select></label>'
        + (state.me && state.me.finance ? '<label>גורם מממן <select name="funder"><option value="">— בחרו —</option>' + FUNDERS.map(function (f) { return '<option>' + esc(f) + '</option>'; }).join('') + '</select><span class="err" data-err="funder"></span></label>' : '')
        + '<button type="submit" class="btn small primary">אשר כניסה</button></form></details>';
      return '<div class="actions" data-lead-actions="' + esc(l.id) + '">' + (l.stage === 'paid' ? admit : '')
        + '<div class="toolbar">'
        + (prev ? '<button type="button" class="btn small" data-stage-prev="' + esc(l.id) + '">→ ' + esc(stageLabel(prev)) + '</button>' : '')
        + (next ? '<button type="button" class="btn small primary" data-stage-next="' + esc(l.id) + '">' + esc(stageLabel(next)) + ' ←</button>' : '')
        + '<span class="na" id="crm-save-state"></span></div>'
        + '<details class="act"><summary>תיאום פגישה</summary><form data-form="meeting" data-lead="' + esc(l.id) + '"><label>תאריך <input type="date" name="visitDate" value="' + esc(l.visitDate) + '"></label>'
        + '<label>שעה <input type="time" name="visitTime" value="' + esc(l.visitTime) + '"></label>'
        + '<label>נפגש/ת עם <select name="meetingWith">' + opts(managers, l.meetingWith, true) + '</select></label>'
        + '<button type="submit" class="btn small primary">שמירה</button></form></details>'
        + '<details class="act"><summary>דיווח תוצאת פגישה</summary><form data-form="outcome" data-lead="' + esc(l.id) + '"><label>תוצאה <select name="meetingOutcome"><option value="">—</option>' + MEETING_OUTCOMES.map(function (o) { return '<option value="' + o.id + '"' + (l.meetingOutcome === o.id ? ' selected' : '') + '>' + esc(o.label) + '</option>'; }).join('') + '</select></label>'
        + '<button type="submit" class="btn small primary">שמירה</button></form></details>'
        + '<details class="act"><summary>סגירת ליד / הסרה</summary><form data-form="close" data-lead="' + esc(l.id) + '"><label>סטטוס סגירה <select name="disposition">' + DISPOSITIONS.map(function (d) { return '<option value="' + d.id + '">' + esc(d.label) + '</option>'; }).join('') + '</select></label>'
        + '<label>סיבה <input name="note" type="text" maxlength="500"></label>'
        + '<button type="submit" class="btn small primary">סגירת ליד</button> <button type="button" class="btn small" data-remove-lead="' + esc(l.id) + '">הסר (טעות)</button></form></details>'
        + '<details class="act"><summary>הערה ואחראי</summary><form data-form="note" data-lead="' + esc(l.id) + '"><label>אחראי <select name="assignedTo">' + opts(ASSIGNEES, l.assignedTo, true) + '</select></label>'
        + '<label>הערות <textarea name="note" rows="3">' + esc(l.note) + '</textarea></label>'
        + '<button type="submit" class="btn small primary">שמירה</button></form></details>'
        + '</div>';
    }
    function setSaveState(text, bad) { const el = $('#crm-save-state'); if (el) { el.textContent = text; el.style.color = bad ? 'var(--bad)' : ''; } }
    function toast(text, bad) {
      let el = $('#crm-toast');
      if (!el) { el = doc.createElement('div'); el.id = 'crm-toast'; el.className = 'toast'; root.appendChild(el); }
      el.textContent = text; el.classList.toggle('bad', !!bad); el.setAttribute('data-show', 'true');
      win.clearTimeout(el._t); el._t = win.setTimeout(function () { el.removeAttribute('data-show'); }, bad ? 6000 : 2500);
    }
    /* Optimistic write of ONE lead; rolled back on refusal. */
    function writeLead(id, patch, label) {
      const list = state.data && Array.isArray(state.data.leads) ? state.data.leads : [];
      const idx = list.findIndex(function (l) { return s(l && l.id) === s(id); });
      if (idx < 0) return Promise.resolve(false);
      const before = list[idx];
      const next = applyLeadPatch(before, patch, new Date().toISOString());
      list[idx] = next;
      state.saving = true; renderNav(); renderMain(); if (state.drawer && state.drawer.id === id) openDrawer('lead', id, true);
      setSaveState('שומר…');
      return win.fetch('/api/sheets', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(leadSaveBody(next)) })
        .then(function (r) { return r.json().catch(function () { return null; }); })
        .then(function (res) {
          const why = saveRefusal(res, id);
          if (why) throw new Error(why);
          state.saving = false; setSaveState('נשמר ✓'); toast((label || 'השינוי') + ' נשמר');
          return true;
        })
        .catch(function (e) {
          list[idx] = before; state.saving = false;
          renderNav(); renderMain(); if (state.drawer && state.drawer.id === id) openDrawer('lead', id, true);
          setSaveState(String(e && e.message || e), true); toast(String(e && e.message || e), true);
          return false;
        });
    }
    function moveStage(id, dir) {
      const l = compute(state.data, state.today).leads.filter(function (x) { return x.id === id; })[0];
      if (!l) return;
      const target = dir > 0 ? stageAfter(l.stage) : stageBefore(l.stage);
      if (!target) return;
      writeLead(id, { stage: target }, 'המעבר ל«' + stageLabel(target) + '»');
    }

    /* The client drawer: existing fields + the timeline from getActivity (B3). */
    function openDrawer(kind, id, keepTab) {
      const c = compute(state.data, state.today);
      const lead = kind === 'lead' ? c.leads.filter(function (l) { return l.id === id; })[0] : null;
      const pat = kind === 'patient' ? c.patients.filter(function (p) { return p.id === id; })[0] : null;
      if (!lead && !pat) return;
      const dr = $('#crm-drawer');
      const name = lead ? lead.name : pat.name;
      const subject = lead ? { leadId: lead.id } : { patientId: pat.id };
      const kv = lead ? [['טלפון', lead.phone], ['בית', houseName(lead.house)], ['מקור', lead.source], ['אחראי', lead.assignedTo], ['שלב', stageLabel(lead.stage)], ['פגישה', fmtDate(lead.visitDate) + (lead.visitTime ? ' ' + lead.visitTime : '')], ['נוצר', fmtDate(lead.created)], ['נפגש/ת עם', lead.meetingWith], ['תוצאת פגישה', lead.meetingOutcome], ['איש קשר', lead.contactName + (lead.contactRelation ? ' (' + lead.contactRelation + ')' : '')], ['טלפון איש קשר', lead.contactPhone], ['הערות', lead.note]]
        : [['בית', houseName(pat.houseId)], ['תאריך כניסה', fmtDate(pat.date)], ['סטטוס', pat.status], ['ליד', pat.fromLead], ['מקור', pat.source]];
      const na = lead ? nextActionFor(lead, state.today) : null;
      dr.innerHTML = '<div class="drawer-head"><div><h2>' + esc(name) + '</h2><div class="meta">' + esc(lead ? stageLabel(lead.stage) + ' · ' + houseName(lead.house) : 'מטופל/ת · ' + houseName(pat.houseId)) + (na ? ' · ' + esc(na.text) : '') + '</div></div><button type="button" class="btn small" id="crm-drawer-close" aria-label="סגירה">✕</button></div>'
        + '<div class="tabs" role="tablist">' + [['overview', 'סקירה'], ['activity', 'פעילות'], ['meetings', 'פגישות ושירותים'], ['account', 'חשבון'], ['docs', 'מסמכים']].map(function (t, i) { return '<button type="button" role="tab" data-tab="' + t[0] + '" aria-selected="' + (i === 0) + '">' + esc(t[1]) + '</button>'; }).join('') + '</div>'
        + '<section data-pane="overview">' + (lead ? renderLeadActions(lead) : renderPatientActions(pat)) + '<dl class="kv">' + kv.filter(function (x) { return s(x[1]); }).map(function (x) { return '<dt>' + esc(x[0]) + '</dt><dd>' + esc(x[1]) + '</dd>'; }).join('') + '</dl><p><a class="btn" href="/">עריכה מלאה בדשבורד</a></p></section>'
        + '<section data-pane="activity" hidden><ul class="tl" id="crm-tl"><li>טוען…</li></ul></section>'
        + '<section data-pane="meetings" hidden><p class="na">' + (lead && lead.visitDate ? 'פגישת קבלה ' + esc(fmtDate(lead.visitDate)) + (lead.meetingOutcome ? ' · ' + esc(lead.meetingOutcome) : ' · ללא תוצאה') : 'אין פגישות רשומות') + '</p></section>'
        + '<section data-pane="account" hidden><p class="na">' + (state.me && state.me.finance ? 'החשבון מנוהל בדשבורד הרגיל (גבייה).' : 'אין הרשאה לנתוני גבייה.') + '</p></section>'
        + '<section data-pane="docs" hidden><p class="na">מסמכים — חשבשבת נשארת המקור; עדיין לא מחובר.</p></section>';
      const prevTab = keepTab && state.drawer && state.drawer.tab ? state.drawer.tab : 'overview';
      if (prevTab !== 'overview') {
        doc.querySelectorAll('#crm-drawer [role="tab"]').forEach(function (b) { b.setAttribute('aria-selected', String(b.dataset.tab === prevTab)); });
        doc.querySelectorAll('#crm-drawer [data-pane]').forEach(function (p) { p.hidden = p.dataset.pane !== prevTab; });
      }
      dr.setAttribute('aria-hidden', 'false');
      $('#crm-scrim').setAttribute('data-open', 'true');
      state.drawer = { kind: kind, id: id, tab: prevTab };
      api('getActivity', Object.assign({ limit: 50 }, subject)).then(function (r) {
        const tl = $('#crm-tl');
        if (!tl) return;
        if (!r || r.ok === false) { tl.innerHTML = '<li class="na">ציר הפעילות לא זמין (' + esc((r && r.error) || 'שגיאה') + ')</li>'; return; }
        if (!r.events || !r.events.length) { tl.innerHTML = '<li class="na">אין אירועים עדיין</li>'; return; }
        tl.innerHTML = r.events.map(function (e) { return '<li><div class="t">' + esc(fmtDate(String(e.occurredAt || '').slice(0, 10)) + ' ' + String(e.occurredAt || '').slice(11, 16)) + ' · ' + esc(e.actorName || e.source || '') + (String(e.source || '').indexOf('manual') === 0 ? ' · ידני' : ' · מערכת') + '</div><div>' + esc(e.summary || e.kind) + '</div></li>'; }).join('');
      });
    }
    function closeDrawer() { $('#crm-drawer').setAttribute('aria-hidden', 'true'); $('#crm-scrim').removeAttribute('data-open'); state.drawer = null; }

    /* events (delegated; filters, sort and scroll survive opening a card) */
    root.addEventListener('click', function (ev) {
      const t = ev.target.closest ? ev.target.closest('#crm-new-lead,#crm-direct-add,[data-cancel-drawer],[data-remove-lead],[data-restore-lead],[data-stage-next],[data-stage-prev],[data-area],[data-kpi],[data-view],[data-sort],[data-open-lead],[data-open-patient],[data-house-open],[data-tab],#crm-drawer-close,#crm-burger,#crm-scrim,#crm-retry') : null;
      if (!t) return;
      if (t.dataset.houseOpen) { ev.preventDefault(); state.filters.house = t.dataset.houseOpen; return setArea('clients'); }
      if (t.dataset.area) return setArea(t.dataset.area);
      if (t.dataset.kpi) { state.kpiFilter = state.kpiFilter === t.dataset.kpi ? '' : t.dataset.kpi; return renderMain(); }
      if (t.dataset.view) { state.view = t.dataset.view; return renderMain(); }
      if (t.dataset.sort) { state.sort = t.dataset.sort; return renderMain(); }
      if (t.dataset.openLead) return openDrawer('lead', t.dataset.openLead);
      if (t.dataset.openPatient) return openDrawer('patient', t.dataset.openPatient);
      if (t.dataset.tab) {
        doc.querySelectorAll('#crm-drawer [role="tab"]').forEach(function (b) { b.setAttribute('aria-selected', String(b === t)); });
        doc.querySelectorAll('#crm-drawer [data-pane]').forEach(function (p) { p.hidden = p.dataset.pane !== t.dataset.tab; });
        if (state.drawer) state.drawer.tab = t.dataset.tab;
        return;
      }
      if (t.id === 'crm-new-lead') return openNewLeadDrawer();
      if (t.id === 'crm-direct-add') return openDirectAddDrawer();
      if (t.dataset.removeLead) { ev.preventDefault(); if (!state.saving) removeLeadAction(t.dataset.removeLead); return; }
      if (t.dataset.restoreLead) { ev.preventDefault(); if (!state.saving) restoreLeadAction(t.dataset.restoreLead); return; }
      if (t.dataset.stageNext) { ev.preventDefault(); ev.stopPropagation(); if (!state.saving) moveStage(t.dataset.stageNext, 1); return; }
      if (t.dataset.stagePrev) { ev.preventDefault(); ev.stopPropagation(); if (!state.saving) moveStage(t.dataset.stagePrev, -1); return; }
      if (t.id === 'crm-drawer-close' || t.id === 'crm-scrim' || t.dataset.cancelDrawer) { closeDrawer(); menuEl.removeAttribute('data-open'); $('#crm-scrim').removeAttribute('data-open'); return; }
      if (t.id === 'crm-burger') { const open = menuEl.getAttribute('data-open') === 'true'; menuEl.setAttribute('data-open', String(!open)); $('#crm-scrim').setAttribute('data-open', String(!open)); return; }
      if (t.id === 'crm-retry') return load();
    });
    root.addEventListener('submit', function (ev) {
      const f = ev.target;
      if (!f || !f.dataset || !f.dataset.form) return;
      ev.preventDefault();
      if (state.saving) return;
      const id = f.dataset.lead;
      const v = function (n) { const el = f.elements[n]; return el ? s(el.value) : ''; };
      if (f.dataset.form === 'meeting') {
        const patch = { visitDate: v('visitDate'), visitTime: v('visitTime'), meetingWith: v('meetingWith') };
        const cur = compute(state.data, state.today).leads.filter(function (x) { return x.id === id; })[0];
        if (cur && cur.stage === 'new' && patch.visitDate) patch.stage = 'visit';   // a dated meeting moves a new lead to ביקור נקבע
        writeLead(id, patch, 'הפגישה');
      } else if (f.dataset.form === 'outcome') {
        writeLead(id, { meetingOutcome: v('meetingOutcome') }, 'תוצאת הפגישה');
      } else if (f.dataset.form === 'note') {
        writeLead(id, { assignedTo: v('assignedTo'), note: v('note') }, 'ההערה');
      } else if (f.dataset.form === 'close') {
        closeLeadAction(id, v('disposition'), v('note'));
      } else if (f.dataset.form === 'admit') {
        const vals = {}; Array.prototype.forEach.call(f.elements, function (el) { if (el.name) vals[el.name] = el.value; });
        admitLead(id, vals, f);
      } else if (f.dataset.form === 'direct-add') {
        const vals = {}; Array.prototype.forEach.call(f.elements, function (el) { if (el.name) vals[el.name] = el.value; });
        directAdd(vals, f);
      } else if (f.dataset.form === 'patient-edit') {
        const vals = {}; Array.prototype.forEach.call(f.elements, function (el) { if (el.name) vals[el.name] = el.value; });
        editPatient(f.dataset.patient, vals, f);
      } else if (f.dataset.form === 'patient-move') {
        if (win.confirm('להעביר את המטופל/ת לבית ' + houseName(v('toHouseId')) + '?')) movePatient(f.dataset.patient, v('toHouseId'));
      } else if (f.dataset.form === 'discharge') {
        const vals = {}; Array.prototype.forEach.call(f.elements, function (el) { if (el.name) vals[el.name] = el.value; });
        dischargePatient(f.dataset.patient, vals, f);
      } else if (f.dataset.form === 'new-lead') {
        const vals = {};
        Array.prototype.forEach.call(f.elements, function (el) { if (el.name) vals[el.name] = el.value; });
        createLead(vals);
      }
    });
    root.addEventListener('change', function (ev) {
      const t = ev.target;
      if (t.id === 'f-house' || t.id === 'f-house-c') state.filters.house = t.value;
      if (t.id === 'f-owner') state.filters.owner = t.value;
      renderMain();
    });
    $('#crm-search').addEventListener('input', function (ev) { state.filters.q = ev.target.value; if (state.area !== 'leads' && state.area !== 'clients') state.area = 'leads'; renderNav(); renderMain(); });
    doc.addEventListener('keydown', function (ev) { if (ev.key === 'Escape') closeDrawer(); });

    function load() {
      state.loading = true; state.error = ''; renderMain();
      return win.fetch('/api/me', { credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (me) {
        if (!me || me.ok === false) throw new Error('אין התחברות');
        state.me = me;
        $('#crm-user').textContent = me.user || '';
        if (areasFor(me).indexOf(state.area) < 0) state.area = 'today';
        const reads = [api('getData')];
        if (me.view === 'controller') reads.push(api('billingControlQueue'));
        return Promise.all(reads);
      }).then(function (res) {
        if (!res[0] || res[0].ok === false) throw new Error('הנתונים לא נטענו' + (res[0] && res[0].error ? ' (' + res[0].error + ')' : ''));
        state.data = res[0]; state.queue = res[1] || null; state.loading = false;
        renderNav(); renderMain();
      }).catch(function (e) { state.loading = false; state.error = String(e && e.message || e); renderNav(); renderMain(); });
    }
    renderNav(); renderMain();
    load();
    return { state: state, load: load, setArea: setArea };
  }

  return { HOUSES: HOUSES, STAGES: STAGES, AREAS: AREAS, WAIT_DAYS: WAIT_DAYS, areasFor: areasFor, normalise: normalise, compute: compute, filterLeads: filterLeads,
    board: board, nextActionFor: nextActionFor, clients: clients, calendar: calendar, control: control, controllerDay: controllerDay, houseName: houseName, houseId: houseId,
    occupancy: occupancy, inHouse: inHouse, fmtDate: fmtDate, esc: esc, boot: boot,
    MEETING_OUTCOMES: MEETING_OUTCOMES, MEETING_WITH_AMBULATORY: MEETING_WITH_AMBULATORY, ASSIGNEES: ASSIGNEES,
    stageAfter: stageAfter, stageBefore: stageBefore, applyLeadPatch: applyLeadPatch, leadSaveBody: leadSaveBody, saveRefusal: saveRefusal,
    DISPOSITIONS: DISPOSITIONS, CONTACT_RELATIONS: CONTACT_RELATIONS, localPhone: localPhone, leadFormErrors: leadFormErrors, newLeadRow: newLeadRow,
    duplicateByPhone: duplicateByPhone, closeRecord: closeRecord, randomId: randomId,
    FUNDERS: FUNDERS, PATIENT_STATUSES: PATIENT_STATUSES, admissionRow: admissionRow, admissionErrors: admissionErrors, directAddRows: directAddRows,
    directAddErrors: directAddErrors, houseSaveBody: houseSaveBody, houseSaveRefusal: houseSaveRefusal, isoDateOk: isoDateOk,
    DISCHARGE_DISPOSITIONS: DISCHARGE_DISPOSITIONS, CONTINUITY_CHOICES: CONTINUITY_CHOICES, dischargeAuditRow: dischargeAuditRow, dischargeErrors: dischargeErrors,
    movedRow: movedRow, patientEditErrors: patientEditErrors };
}));
