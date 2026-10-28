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
        exitDate: isoDay(x.exitDate), fromLead: s(x.fromLead), source: s(x.source), personId: s(x.personId), pay: Number(x.pay) || 0 };
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

  /* ---- C8: «גבייה» read-only overview (CHANGELOG-crm-billing-readonly.md) ----
   * Built from TWO existing finance reads — debtAging (open debt as of today,
   * the same engine as «חובות פתוחים») and getPayments (cycles + receipts).
   * Pure: no write, no new Code.gs action. A missing / refused answer yields
   * zeros and an `error`, never a throw, so the area renders for Ortal and
   * Vered alike. Money is ₪, VAT-inclusive, rounded to whole shekels on screen. */
  const DEBT_BUCKET_LABELS = { d0_7: 'עד 7 ימים', d8_30: '8–30 ימים', d31_60: '31–60 ימים', d61_plus: '61+ ימים' };
  const CONFIRM_LABELS = { reported: 'דווח', confirmed: 'אומת', flagged: 'סומן' };
  function fmtMoney(n) { const v = Math.round(Number(n) || 0); return '₪' + String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  function receiptsOf(payments) {
    const p = payments && payments.ok !== false ? payments : {};
    return (Array.isArray(p.receipts) ? p.receipts : []).map(function (r) {
      const o = r || {};
      return { id: s(o.id), patientId: s(o.patientId), patientUid: s(o.patientUid), patientName: s(o.patientName), houseId: s(o.houseId), houseName: houseName(o.houseId),
        receivedDate: s(o.receivedDate).slice(0, 10), amount: Number(o.amount) || 0, method: s(o.method), payer: s(o.payer), funder: s(o.funder),
        confirmStatus: s(o.confirmStatus), cycleId: s(o.cycleId), reference: s(o.reference), status: s(o.status), dueDate: s(o.dueDate).slice(0, 10),
        coverageStart: s(o.coverageStart).slice(0, 10), coverageEnd: s(o.coverageEnd).slice(0, 10), invoiceWanted: s(o.invoiceWanted), invoiceTo: s(o.invoiceTo),
        isVoid: /^(void|מבוטל)$/i.test(s(o.status)) };
    });
  }
  function billingOverview(debt, payments, today) {
    const d = debt && debt.ok !== false ? debt : null;
    const empty = { count: 0, total: 0, d0_7: 0, d8_30: 0, d31_60: 0, d61_plus: 0 };
    const rec = (d && d.totals && d.totals.recorded_debt) || empty;
    const unrec = (d && d.totals && d.totals.unrecorded_cycles) || empty;
    const sum = function (k) { return Math.round(((Number(rec[k]) || 0) + (Number(unrec[k]) || 0)) * 100) / 100; };
    const buckets = ['d0_7', 'd8_30', 'd31_60', 'd61_plus'].map(function (k) { return { key: k, label: DEBT_BUCKET_LABELS[k], amount: sum(k) }; });
    const patients = (d && Array.isArray(d.byPatient) ? d.byPatient : []).map(function (p) {
      const cycles = Array.isArray(p.cycles) ? p.cycles : [];
      let balance = 0, oldest = 0, grace = false, unrecorded = 0;
      cycles.forEach(function (c) { balance += Number(c.balance) || 0; if ((Number(c.days) || 0) > oldest) oldest = Number(c.days) || 0; if (c.funderGrace) grace = true; if (c.kind === 'unrecorded') unrecorded++; });
      return { id: s(p.patientId), name: s(p.name), houseId: s(p.houseId), houseName: houseName(p.houseId), status: s(p.status), inHouse: !!p.inHouseAtAsOf,
        balance: Math.round(balance * 100) / 100, cycles: cycles.length, unrecorded: unrecorded, oldestDays: oldest, grace: grace,
        bucket: oldest <= 7 ? 'd0_7' : oldest <= 30 ? 'd8_30' : oldest <= 60 ? 'd31_60' : 'd61_plus' };
    }).sort(function (a, b) { return b.balance - a.balance || a.name.localeCompare(b.name, 'he'); });
    const houses = (d && Array.isArray(d.byHouse) ? d.byHouse : []).map(function (h) {
      const r = h.recorded_debt || empty, u = h.unrecorded_cycles || empty;
      return { houseId: s(h.houseId), name: houseName(h.houseId), total: Math.round(((Number(r.total) || 0) + (Number(u.total) || 0)) * 100) / 100, count: (Number(r.count) || 0) + (Number(u.count) || 0) };
    }).sort(function (a, b) { return b.total - a.total; });
    const receipts = receiptsOf(payments).sort(function (a, b) { return a.receivedDate < b.receivedDate ? 1 : a.receivedDate > b.receivedDate ? -1 : 0; });
    const since = today ? new Date(Date.parse(today + 'T00:00:00Z') - 30 * 86400000).toISOString().slice(0, 10) : '';
    let received30 = 0, received30Count = 0, toVerify = 0;
    receipts.forEach(function (r) { if (r.receivedDate && r.receivedDate >= since && r.receivedDate <= (today || r.receivedDate)) { received30 += r.amount; received30Count++; } if (r.confirmStatus === 'reported') toVerify++; });
    const errors = [];
    if (!d) errors.push('חובות: ' + s(debt && debt.error || 'לא נטען'));
    if (!(payments && payments.ok !== false)) errors.push('תשלומים: ' + s(payments && payments.error || 'לא נטען'));
    return {
      asOf: s(d && d.asOf) || s(today), openDebt: sum('total'), openCycles: sum('count'), over60: sum('d61_plus'), debtors: patients.length,
      received30: Math.round(received30 * 100) / 100, received30Count: received30Count, toVerify: toVerify,
      detached: d && d.detachedPayments ? (Number(d.detachedPayments.count) || 0) : 0,
      pendingCredits: d && d.pendingCredits ? { count: Number(d.pendingCredits.count) || 0, total: Number(d.pendingCredits.total) || 0 } : { count: 0, total: 0 },
      funderGrace: d && d.funderGrace ? { count: Number(d.funderGrace.count) || 0, amount: Number(d.funderGrace.amount) || 0 } : { count: 0, amount: 0 },
      buckets: buckets, patients: patients, houses: houses, receipts: receipts.slice(0, 25), errors: errors,
    };
  }

  /* ---- C9: the «חשבון» tab of a patient (CHANGELOG-crm-account-tab.md) ----
   * Same two reads as the גבייה area, filtered to ONE patient: open cycles
   * (debtAging.byPatient), the stamped cycles and receipts (getPayments),
   * the funder history (getPayments.funders). Pure, read-only. */
  const CYCLE_STATUS_LABELS = { paid: 'שולם', partial: 'חלקי', unpaid: 'לא שולם', void: 'בוטל' };
  /* The legacy billing identity of a patient — 'houseId::name::entryDate' (the
   * classic app's patientKey / Code.gs patientKey_). Every Payments, Funders and
   * Overrides row is keyed on it; the per-row uid rides ALONGSIDE in
   * `patientUid` (C10). The name is trimmed, as both sides have always done. */
  function patientKeyOf(p) {
    const o = p || {};
    return s(houseId(o.houseId)) + '::' + s(o.name) + '::' + s(o.date).slice(0, 10);
  }
  /* Does a money row belong to this patient? uid first (patientUid, or an id
   * cell that already holds the uid), else the legacy triple. */
  function rowIsPatient(row, uid, key) {
    const r = row || {};
    const ru = s(r.patientUid), rid = s(r.patientId);
    if (uid && (ru === uid || rid === uid)) return true;
    return !!key && rid === key;
  }
  function patientAccount(patientOrId, debt, payments) {
    const pat = patientOrId && typeof patientOrId === 'object' ? patientOrId : { id: patientOrId };
    const id = s(pat.id);
    const key = pat.name ? patientKeyOf(pat) : '';
    const d = debt && debt.ok !== false ? debt : null;
    const p = payments && payments.ok !== false ? payments : null;
    const mine = (d && Array.isArray(d.byPatient) ? d.byPatient : []).filter(function (x) { return s(x.patientId) === id || (key && s(x.patientKey) === key); })[0] || null;
    const open = (mine && Array.isArray(mine.cycles) ? mine.cycles : []).map(function (c) {
      return { start: s(c.start).slice(0, 10), end: s(c.end).slice(0, 10), expected: Number(c.expected) || 0, received: Number(c.received) || 0, balance: Number(c.balance) || 0,
        days: Number(c.days) || 0, kind: s(c.kind), grace: !!c.funderGrace, discount: Number(c.discount) || 0, paymentId: s(c.paymentId), month: s(c.month) };
    });
    const openTotal = Math.round(open.reduce(function (t, c) { return t + c.balance; }, 0) * 100) / 100;
    const cycles = (p && Array.isArray(p.payments) ? p.payments : []).filter(function (x) { return rowIsPatient(x, id, key); }).map(function (x) {
      return { id: s(x.id), dueDate: s(x.dueDate).slice(0, 10), amount: Number(x.amount) || 0, amountPaid: Number(x.amountPaid) || 0, balance: Number(x.balance) || 0, status: s(x.status),
        coverageStart: s(x.coverageStart).slice(0, 10), coverageEnd: s(x.coverageEnd).slice(0, 10), patientId: s(x.patientId), patientName: s(x.patientName), houseId: s(x.houseId) };
    }).sort(function (a, b) { return a.dueDate < b.dueDate ? 1 : a.dueDate > b.dueDate ? -1 : 0; });
    const receipts = receiptsOf(p).filter(function (r) { return rowIsPatient(r, id, key); }).sort(function (a, b) { return a.receivedDate < b.receivedDate ? 1 : a.receivedDate > b.receivedDate ? -1 : 0; });
    const receivedTotal = Math.round(receipts.reduce(function (t, r) { return t + r.amount; }, 0) * 100) / 100;
    const funders = (p && Array.isArray(p.funders) ? p.funders : []).filter(function (f) { return rowIsPatient(f, id, key); }).map(function (f) {
      return { funder: s(f.funder), effectiveFrom: s(f.effectiveFrom).slice(0, 10), setBy: s(f.setBy) };
    }).sort(function (a, b) { return a.effectiveFrom < b.effectiveFrom ? 1 : a.effectiveFrom > b.effectiveFrom ? -1 : 0; });
    const errors = [];
    if (!d) errors.push('חובות: ' + s(debt && debt.error || 'לא נטען'));
    if (!p) errors.push('תשלומים: ' + s(payments && payments.error || 'לא נטען'));
    return { patientId: id, patientKey: key, openTotal: openTotal, openCycles: open, settledCycles: mine ? (Number(mine.settledCycles) || 0) : 0, cycles: cycles, receipts: receipts,
      receivedTotal: receivedTotal, currentFunder: funders.length ? funders[0].funder : '', funders: funders, errors: errors };
  }

  /* ---- C10: «דווח תשלום» inside the CRM (CHANGELOG-crm-payment-report.md) ----
   * The SAME strict report as the classic modal: the rules come from
   * lib/payment-report-rules.js (served to the page as window.PaymentReportRules,
   * required here under node), the server contract is reportPayment
   * { cycle, report, submissionId, confirmDuplicate? } and Code.gs
   * validatePaymentReport_ stays the authority. */
  function reportRules(win) {
    if (typeof module === 'object' && module && module.exports) { try { return require('../../lib/payment-report-rules.js'); } catch (_) { /* browser bundle */ } }
    const g = win || (typeof window !== 'undefined' ? window : globalThis);
    return g.PaymentReportRules || null;
  }
  /* The cycle body for an account row. A recorded cycle re-sends its Payments
   * row (id, legacy patientId, name, house, due, stamped amount, coverage); an
   * unrecorded one is minted the way the classic app does — 'pay::<key>::<due>'
   * born from debtAging's window and expected amount. */
  function reportCycleFor(patient, openCycle, account) {
    const c = openCycle || {};
    const rows = account && Array.isArray(account.cycles) ? account.cycles : [];
    const row = c.paymentId ? rows.filter(function (r) { return r.id === c.paymentId; })[0] : null;
    const key = patientKeyOf(patient);
    if (row) {
      return { id: row.id, patientId: row.patientId || key, patientName: row.patientName || s(patient.name), houseId: row.houseId || s(houseId(patient.houseId)),
        dueDate: row.dueDate, amount: row.amount, coverageStart: row.coverageStart || c.start, coverageEnd: row.coverageEnd || c.end };
    }
    return { id: 'pay::' + key + '::' + s(c.start), patientId: key, patientName: s(patient.name), houseId: s(houseId(patient.houseId)),
      dueDate: s(c.start), amount: Number(c.expected) || 0, coverageStart: s(c.start), coverageEnd: s(c.end) };
  }
  /* A stamped Payments row (the «תשלומים» table) as a cycle body. */
  /* C13 (CHANGELOG-crm-report-any-cycle.md): «דווח תשלום» for ANY cycle of the
   * stay — an advance for a cycle not yet due, or a cycle the debt view does
   * not list. Cycles are entry-anchored (Code.gs recCycleDueDates_ /
   * recOccurrence_: the entry day of each month, clamped to the month's end),
   * from the entry date up to `ahead` months after today, within the stay. */
  function addMonthsIso(iso, n) {
    const p = s(iso).split('-'); const y = Number(p[0]), m0 = Number(p[1]) - 1 + n, d = Number(p[2]);
    const ty = y + Math.floor(m0 / 12), tm = ((m0 % 12) + 12) % 12;
    const last = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
    return ty + '-' + String(tm + 1).padStart(2, '0') + '-' + String(Math.min(d, last)).padStart(2, '0');
  }
  function cycleWindow(entryIso, k) {
    const start = addMonthsIso(entryIso, k);
    const nextStart = addMonthsIso(entryIso, k + 1);
    const end = new Date(Date.parse(nextStart + 'T00:00:00Z') - 86400000).toISOString().slice(0, 10);
    return { start: start, end: end };
  }
  function stayCycles(patient, today, ahead) {
    const entry = s(patient && patient.date).slice(0, 10);
    if (!isoDateOk(entry)) return [];
    const exit = s(patient && patient.exitDate).slice(0, 10);
    const limit = addMonthsIso(s(today), ahead == null ? 3 : ahead);
    const out = [];
    for (let k = 0; k < 600; k++) {
      const w = cycleWindow(entry, k);
      if (w.start > limit) break;
      if (exit && w.start >= exit) break;
      out.push(w);
    }
    return out;
  }
  /* The cycles she can still report on from the «מחזור אחר» picker: every
   * stay cycle not already offered by an open / unpaid row, newest first. */
  function reportableCycles(patient, account, today) {
    const a = account || {};
    const taken = {};
    (a.openCycles || []).forEach(function (c) { taken[c.start] = true; });
    (a.cycles || []).forEach(function (c) { if (c.status === 'unpaid' || c.status === 'partial') taken[c.dueDate] = true; });
    const rows = {}; (a.cycles || []).forEach(function (c) { rows[c.dueDate] = c; });
    return stayCycles(patient, today).filter(function (w) { return !taken[w.start]; }).map(function (w) {
      const row = rows[w.start] || null;
      return { start: w.start, end: w.end, paymentId: row ? row.id : '', status: row ? row.status : '', expected: row ? row.amount : (Number(patient.pay) || 0), received: row ? row.amountPaid : 0 };
    });
  }
  /* The picker's default: the first cycle that starts after today (an advance), else the last. */
  function defaultReportable(list, today) {
    for (let i = 0; i < list.length; i++) if (list[i].start >= s(today)) return i;
    return list.length ? list.length - 1 : -1;
  }
  function reportCycleForWindow(patient, w, account) {
    const rows = account && Array.isArray(account.cycles) ? account.cycles : [];
    const row = w.paymentId ? rows.filter(function (r) { return r.id === w.paymentId; })[0] : null;
    if (row) return reportCycleForRow(patient, row);
    const key = patientKeyOf(patient);
    return { id: 'pay::' + key + '::' + s(w.start), patientId: key, patientName: s(patient.name), houseId: s(houseId(patient.houseId)),
      dueDate: s(w.start), amount: Number(w.expected) || 0, coverageStart: s(w.start), coverageEnd: s(w.end) };
  }
  /* C13: fixing a receipt. The classic rules: the NON-money fields are edited
   * in place (editReceipt — method, payer, reference, invoice, coverage; the
   * server re-validates and keeps the receipt on its cycle); amount, received
   * date and status are NOT editable — a wrong amount is VOIDED (savePayment
   * with status 'void' + a reason, the `deleter` role) and reported again. */
  const RECEIPT_EDIT_FIELDS = ['reference', 'method', 'payer', 'invoiceWanted', 'invoiceTo', 'coverageStart', 'coverageEnd'];
  function receiptEditFields(receipt, values) {
    const out = {};
    RECEIPT_EDIT_FIELDS.forEach(function (k) { const v = s(values[k]); if (v !== s(receipt[k])) out[k] = v; });
    return out;
  }
  function receiptEditIssues(receipt, values, today, rules) {
    const R = rules || reportRules();
    const fields = receiptEditFields(receipt, values);
    if (!Object.keys(fields).length) return [{ field: '_form', code: 'nothing_changed', hebrewMessage: 'לא שונה דבר' }];
    if (!R || typeof R.validatePaymentInvoice !== 'function') return [{ field: '_form', code: 'rules_missing', hebrewMessage: 'טעינת כללי הדיווח נכשלה — רענני את הדף' }];
    const merged = { receivedDate: receipt.receivedDate, amount: String(receipt.amount), method: values.method, payer: values.payer, reference: values.reference, funder: receipt.funder || R.PAYMENT_FUNDERS[0],
      coverageStart: values.coverageStart, coverageEnd: values.coverageEnd, invoiceWanted: values.invoiceWanted, invoiceTo: values.invoiceTo };
    const touched = {}; Object.keys(fields).forEach(function (k) { touched[k] = true; });
    if (touched.method) touched.reference = true;
    if (touched.invoiceWanted) touched.invoiceTo = true;
    const issues = R.validatePaymentReport(merged, { todayIso: today }).concat(R.validatePaymentInvoice(merged)).filter(function (i) { return touched[i.field]; });
    const reason = s(values.reason);
    if (reason.length > 300) issues.push({ field: 'reason', code: 'reason_invalid', hebrewMessage: 'סיבה — טקסט עד 300 תווים' });
    return issues;
  }
  function receiptEditBody(receipt, values) {
    const edit = { id: s(receipt.id), fields: receiptEditFields(receipt, values) };
    const reason = s(values.reason);
    if (reason) edit.reason = reason;
    return { action: 'editReceipt', edit: edit };
  }
  function receiptVoidErrors(values) {
    const e = {}; const n = s(values.note);
    if (n.length < 2 || n.length > 120) e.note = 'יש לציין סיבה (2 עד 120 תווים)';
    return e;
  }
  function receiptVoidBody(receipt, note, nowIso) {
    return { action: 'savePayment', payment: { id: s(receipt.id), patientId: s(receipt.patientId), patientName: s(receipt.patientName), houseId: s(receipt.houseId),
      dueDate: s(receipt.dueDate), status: 'void', linkPatientUid: '', linkStatus: 'duplicate', linkNote: s(note).slice(0, 120), timestamp: s(nowIso) } };
  }
  function receiptVoidAccepted(res, id) {
    const r = res || {};
    return r.ok === true && !!r.payment && s(r.payment.id) === s(id) && /^(void|מבוטל)$/i.test(s(r.payment.status));
  }
  function reportCycleForRow(patient, row) {
    const key = patientKeyOf(patient);
    return { id: row.id, patientId: row.patientId || key, patientName: row.patientName || s(patient.name), houseId: row.houseId || s(houseId(patient.houseId)),
      dueDate: row.dueDate, amount: row.amount, coverageStart: row.coverageStart, coverageEnd: row.coverageEnd };
  }
  function reportDefaults(cycle, remaining, today, currentFunder) {
    const rules = reportRules();
    const funder = s(currentFunder);
    return { receivedDate: s(today), amount: remaining > 0 ? String(Math.round(remaining * 100) / 100) : '', method: '', payer: '', reference: '',
      funder: rules && funder && funder !== rules.FUNDER_UNSET && funder !== rules.FUNDER_PROBONO && rules.PAYMENT_FUNDERS.indexOf(funder) >= 0 ? funder : '',
      coverageStart: s(cycle.coverageStart), coverageEnd: s(cycle.coverageEnd), invoiceWanted: '', invoiceTo: '' };
  }
  /* The issues for the form's values — the shared rules, staff age limit unless approver. */
  function reportIssues(values, today, approver, rules) {
    const R = rules || reportRules();
    if (!R || typeof R.validatePaymentInvoice !== 'function') return [{ field: 'receivedDate', code: 'rules_missing', hebrewMessage: 'טעינת כללי הדיווח נכשלה — רענני את הדף' }];
    return R.validatePaymentReport(values, { todayIso: today, maxDaysBack: approver === true ? 0 : R.RECEIVED_DATE_STAFF_MAX_DAYS }).concat(R.validatePaymentInvoice(values));
  }
  function reportBody(cycle, values, submissionId, confirmDuplicate) {
    const report = { cycle: cycle, report: Object.assign({}, values), submissionId: s(submissionId) };
    if (confirmDuplicate === true) report.confirmDuplicate = true;
    return { action: 'reportPayment', report: report };
  }
  /* 'sub-' + 32 hex: one per opened form; every send of that form carries it. */
  function newSubmissionId() {
    const c = typeof crypto !== 'undefined' && crypto && typeof crypto.getRandomValues === 'function' ? crypto : null;
    const bytes = new Uint8Array(16);
    if (c) c.getRandomValues(bytes); else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
    return 'sub-' + Array.prototype.map.call(bytes, function (b) { return (b < 16 ? '0' : '') + b.toString(16); }).join('');
  }
  /* The server's answer → { ok, receiptId, cycle } | { duplicate: existing } | { message, issues } */
  function reportOutcome(res) {
    const r = res || {};
    if (r.ok === true && r.receipt && s(r.receipt.id)) return { ok: true, receiptId: s(r.receipt.id), cycle: r.cycle || null };
    if (r.error === 'possible_duplicate') return { ok: false, duplicate: r.existing || {} };
    if (r.error === 'invalid_report') return { ok: false, message: s(r.message) || 'הדיווח לא נשמר — יש להשלים את השדות המסומנים', issues: Array.isArray(r.issues) ? r.issues : [] };
    if (r.error === 'lock_busy') return { ok: false, message: 'המערכת עסוקה — נסי שוב בעוד רגע', issues: [] };
    if (r.error === 'forbidden' || r.error === 'forbidden_role') return { ok: false, message: 'אין הרשאה לדווח תשלום', issues: [] };
    return { ok: false, message: 'התשלום לא נשמר — נסי שוב' + (r.error ? ' (' + s(r.error) + ')' : ''), issues: [] };
  }
  function duplicateText(existing) {
    const e = existing || {};
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s(e.receivedDate));
    return 'קיימת כבר קבלה דומה (' + (m ? m[3] + '/' + m[2] : '—') + ', ' + (s(e.reference) ? 'אסמכתא ' + s(e.reference) : 'ללא אסמכתא') + '). האם זו קבלה נוספת?';
  }

  /* ---- C11: credits, discount, amount override (CHANGELOG-crm-credits-overrides.md) ----
   * Reads: getCredits (the ledger). Writes (classic contracts, unchanged):
   *   setBillingDiscount   { discount: { patientId: <legacy key>, month, discountAmount, discountReason } }   finance
   *   upsertBillingOverride{ override: { id, patientId: <legacy key>, month, amount, created } }             canAmount
   *   settleRefund         { creditId, paidDate, method }                                                     finance / controller */
  const CREDIT_TYPE_LABELS = { days_unused: 'ימים שלא נוצלו', prepaid_return: 'החזר תשלום מראש', other: 'זיכוי אחר' };
  const CREDIT_STATUS_LABELS = { pending: 'ממתין', paid: 'שולם', cancelled: 'בוטל' };
  const SETTLE_METHODS = ['העברה בנקאית', 'ביט', 'מזומן', "צ'ק", 'קיזוז', 'אחר'];
  function creditsOf(credits) {
    const c = credits && credits.ok !== false ? credits : {};
    return (Array.isArray(c.credits) ? c.credits : []).map(function (r) {
      const o = r || {};
      return { id: s(o.id), patientId: s(o.patientId), patientKey: s(o.patientKey), patientName: s(o.patientName), houseId: s(o.houseId), houseName: houseName(o.houseId),
        creditType: s(o.creditType), allocationMonth: s(o.allocationMonth).slice(0, 7), amount: Number(o.amount) || 0, status: s(o.status), reason: s(o.reason),
        decidedDate: s(o.decidedDate).slice(0, 10), payoutDate: s(o.payoutDate).slice(0, 10), paidDate: s(o.paidDate).slice(0, 10), method: s(o.method) };
    });
  }
  function creditIsPatient(c, uid, key) { return (uid && c.patientId === uid) || (!!key && (c.patientKey === key || c.patientId === key)); }
  function patientCredits(patient, credits) {
    const pat = patient && typeof patient === 'object' ? patient : { id: patient };
    const uid = s(pat.id), key = pat.name ? patientKeyOf(pat) : '';
    return creditsOf(credits).filter(function (c) { return creditIsPatient(c, uid, key); })
      .sort(function (a, b) { return a.allocationMonth < b.allocationMonth ? 1 : a.allocationMonth > b.allocationMonth ? -1 : 0; });
  }
  /* «זיכויים לתשלום»: pending credits with money, oldest payout first. */
  function pendingCredits(credits) {
    return creditsOf(credits).filter(function (c) { return c.status === 'pending' && c.amount > 0; })
      .sort(function (a, b) { return (a.payoutDate || a.allocationMonth) < (b.payoutDate || b.allocationMonth) ? -1 : 1; });
  }
  function monthOk(m) { return /^\d{4}-(0[1-9]|1[0-2])$/.test(s(m)); }
  function moneyParse(v) {
    const t = s(v).replace(/[,₪\s]/g, '');
    if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
    const n = Number(t);
    return n >= 0 && n <= 1000000 ? n : null;
  }
  function discountErrors(v) {
    const e = {};
    if (!monthOk(v.month)) e.month = 'חודש לא תקין';
    if (moneyParse(v.discountAmount) === null) e.discountAmount = 'סכום הנחה לא תקין — מספר בין 0 ל-1,000,000, עד שתי ספרות אחרי הנקודה';
    const r = s(v.discountReason);
    if (r.length < 2 || r.length > 120) e.discountReason = 'בהנחה חובה לפרט סיבה (2 עד 120 תווים)';
    return e;
  }
  function discountBody(patient, month, amount, reason) {
    return { action: 'setBillingDiscount', discount: { patientId: patientKeyOf(patient), month: s(month), discountAmount: moneyParse(amount), discountReason: s(reason) } };
  }
  function overrideErrors(v) {
    const e = {};
    if (!monthOk(v.month)) e.month = 'חודש לא תקין';
    if (moneyParse(v.amount) === null) e.amount = 'סכום לא תקין';
    return e;
  }
  function overrideBody(patient, month, amount, today) {
    const key = patientKeyOf(patient);
    return { action: 'upsertBillingOverride', override: { id: 'ovr::' + key + '::' + s(month), patientId: key, month: s(month), amount: moneyParse(amount), created: s(today) } };
  }
  function settleErrors(v, today) {
    const e = {};
    const d = s(v.paidDate).slice(0, 10);
    if (!isoDateOk(d)) e.paidDate = 'תאריך לא תקין';
    else if (today && d > today) e.paidDate = 'התאריך לא יכול להיות בעתיד';
    const m = s(v.method);
    if (m.length < 1 || m.length > 40) e.method = 'חסר: אמצעי תשלום';
    return e;
  }
  function settleBody(creditId, paidDate, method) { return { action: 'settleRefund', creditId: s(creditId), paidDate: s(paidDate).slice(0, 10), method: s(method) }; }
  /* A write answer → '' when accepted, else a Hebrew reason. `proof` names the
   * key the answer must carry (an echo without it is not a save). */
  function writeRefusal(res, proof) {
    const r = res || {};
    if (r.ok === true && (!proof || r[proof])) return '';
    if (r.ok === true) return 'השינוי לא אושר על ידי השרת — רענני';
    if (r.message) return s(r.message);
    if (r.error === 'lock_busy') return 'המערכת עסוקה — נסי שוב בעוד רגע';
    if (r.error === 'forbidden' || r.error === 'forbidden_role') return 'אין הרשאה לפעולה זו';
    if (r.error === 'not_pending') return 'הזיכוי כבר לא ממתין — רענני';
    return 'השינוי לא נשמר' + (r.error ? ' (' + s(r.error) + ')' : '');
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
      }).join('') + '</div><div class="links"><a href="/?view=classic">בקרת גבייה — העבודה המלאה בדשבורד<small>אימות, סימון לבירור, ייצוא</small></a></div>';
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

    /* C8: read-only overview over debtAging + getPayments, fetched on first
     * open (never on boot: the two reads are heavier than getData). Every
     * ACTION («דווח תשלום», overrides, credits, Ortal's verification) stays in
     * the classic dashboard — the links at the bottom. */
    const billingWaiters = [];
    function loadBilling(then) {
      if (typeof then === 'function') billingWaiters.push(then);
      if (state.billing || state.billingLoading) return;
      state.billingLoading = true;
      Promise.all([api('debtAging'), api('getPayments'), api('getCredits')]).then(function (res) {
        state.billing = { debt: res[0], payments: res[1], credits: res[2] };
      }).catch(function (e) {
        state.billing = { debt: { ok: false, error: String(e && e.message || e) }, payments: { ok: false, error: String(e && e.message || e) }, credits: { ok: false, error: String(e && e.message || e) } };
      }).then(function () {
        state.billingLoading = false; if (state.area === 'billing') renderMain();
        while (billingWaiters.length) { try { billingWaiters.shift()(); } catch (_) { /* a stale drawer */ } }
      });
    }
    function renderBilling() {
      if (!state.billing) { loadBilling(); return '<div class="crm-state">טוען נתוני גבייה…</div>'; }
      const b = billingOverview(state.billing.debt, state.billing.payments, state.today);
      const isController = !!(state.me && state.me.view === 'controller');
      const kpi = function (v, l) { return '<div class="kpi"><span class="v">' + esc(v) + '</span><span class="l">' + esc(l) + '</span></div>'; };
      let html = '';
      if (b.errors.length) html += '<div class="crm-state bad">' + esc(b.errors.join(' · ')) + ' <button type="button" class="btn small" data-billing-retry>נסי שוב</button></div>';
      html += '<div class="kpis">' + kpi(fmtMoney(b.openDebt), 'חוב פתוח (' + b.openCycles + ' מחזורים)') + kpi(fmtMoney(b.over60), 'מעל 60 יום')
        + kpi(b.debtors, 'מטופלים עם חוב') + kpi(fmtMoney(b.received30), 'התקבל ב-30 יום (' + b.received30Count + ')') + kpi(b.toVerify, 'דיווחים לאימות') + '</div>';
      html += '<div class="group-title">גיול חוב נכון ל-' + esc(fmtDate(b.asOf)) + '</div><div class="kpis">' + b.buckets.map(function (x) { return kpi(fmtMoney(x.amount), x.label); }).join('') + '</div>';
      if (b.houses.length) {
        html += '<div class="group-title">חוב לפי בית</div><div class="tbl-wrap"><table class="tbl"><thead><tr><th>בית</th><th>חוב</th><th>מחזורים</th></tr></thead><tbody>'
          + b.houses.map(function (h) { return '<tr><td>' + esc(h.name) + '</td><td>' + esc(fmtMoney(h.total)) + '</td><td>' + h.count + '</td></tr>'; }).join('') + '</tbody></table></div>';
      }
      html += '<div class="group-title">חובות פתוחים לפי מטופל/ת' + (b.funderGrace.count ? ' ' + chip('wait', b.funderGrace.count + ' בחלון גוף מממן') : '') + '</div>';
      if (!b.patients.length) html += '<p class="na">אין חובות פתוחים.</p>';
      else html += '<div class="tbl-wrap"><table class="tbl" id="crm-debtors"><thead><tr><th>שם</th><th>בית</th><th>חוב</th><th>מחזורים</th><th>הוותיק ביותר</th><th>סטטוס</th></tr></thead><tbody>'
        + b.patients.map(function (p) {
          const st = p.bucket === 'd61_plus' ? 'late' : p.bucket === 'd31_60' ? 'today' : 'ok';
          return '<tr data-open-patient="' + esc(p.id) + '"><td>' + esc(p.name) + '</td><td>' + esc(p.houseName) + '</td><td>' + esc(fmtMoney(p.balance)) + '</td><td>' + p.cycles + (p.unrecorded ? ' <span class="na">(' + p.unrecorded + ' ללא דיווח)</span>' : '') + '</td><td>'
            + chip(st, p.oldestDays + ' ימים') + (p.grace ? ' ' + chip('wait', 'גוף מממן') : '') + '</td><td>' + esc(p.inHouse ? 'בבית' : (p.status === 'released' ? 'שוחרר/ה' : p.status)) + '</td></tr>';
        }).join('') + '</tbody></table></div>';
      html += '<div class="group-title">תקבולים אחרונים</div>';
      if (!b.receipts.length) html += '<p class="na">אין תקבולים.</p>';
      else html += '<div class="tbl-wrap"><table class="tbl" id="crm-receipts"><thead><tr><th>תאריך</th><th>שם</th><th>בית</th><th>סכום</th><th>אמצעי</th><th>אימות</th></tr></thead><tbody>'
        + b.receipts.map(function (r) {
          const cs = r.confirmStatus === 'confirmed' ? 'ok' : r.confirmStatus === 'flagged' ? 'late' : 'today';
          return '<tr data-receipt="' + esc(r.id) + '"><td>' + esc(fmtDate(r.receivedDate)) + '</td><td>' + esc(r.patientName) + '</td><td>' + esc(r.houseName) + '</td><td>' + esc(fmtMoney(r.amount)) + '</td><td>' + esc(r.method) + '</td><td>' + (r.confirmStatus ? chip(cs, CONFIRM_LABELS[r.confirmStatus] || r.confirmStatus) : '') + '</td></tr>';
        }).join('') + '</tbody></table></div>';
      const pend = pendingCredits(state.billing.credits);
      html += '<div class="group-title">זיכויים לתשלום' + (pend.length ? ' ' + chip('today', pend.length + ' · ' + fmtMoney(pend.reduce(function (t, c) { return t + c.amount; }, 0))) : '') + '</div>';
      if (!pend.length) html += '<p class="na">אין זיכויים ממתינים.</p>';
      else html += '<div class="tbl-wrap"><table class="tbl" id="crm-pending-credits"><thead><tr><th>שם</th><th>בית</th><th>סוג</th><th>חודש</th><th>לתשלום עד</th><th>סכום</th><th></th></tr></thead><tbody>'
        + pend.map(function (c) {
          return '<tr><td>' + esc(c.patientName) + '</td><td>' + esc(c.houseName) + '</td><td>' + esc(CREDIT_TYPE_LABELS[c.creditType] || c.creditType) + '</td><td>' + esc(c.allocationMonth) + '</td><td>' + esc(fmtDate(c.payoutDate)) + '</td><td>' + esc(fmtMoney(c.amount)) + '</td>'
            + '<td>' + (!isController ? '<button type="button" class="btn small" data-settle-open="' + esc(c.id) + '">סמן כשולם</button>' : '') + '</td></tr>';
        }).join('') + '</tbody></table></div>';
      html += '<div class="group-title">פעולות (בדשבורד הרגיל)</div><div class="links">'
        + (isController ? '<a href="/?view=classic">בקרת גבייה<small>אימות דיווחים</small></a>' : '<a href="/?view=classic">עריכת קבלות<small>תיקון / ביטול קבלה</small></a><a href="/?view=classic">זיכויים ידניים<small>יצירה ועריכה של זיכוי</small></a><a href="/?view=classic">שיוך תשלומים<small>' + b.detached + ' ללא שיוך</small></a>')
        + '</div>';
      return html;
    }

    function renderOccupancy(c) {
      const o = occupancy(c.patients);
      return '<div class="kpis">' + [['בטיפול היום', o.totalIn], ['מיטות פנויות', o.totalFree], ['קיבולת', o.totalCap]].map(function (x) { return '<div class="kpi"><span class="v">' + x[1] + '</span><span class="l">' + esc(x[0]) + '</span></div>'; }).join('') + '</div>'
        + '<div class="links">' + o.houses.map(function (h) {
          const state_ = h.closed ? 'wait' : (h.free === 0 ? 'late' : (h.free <= 2 ? 'today' : 'ok'));
          return '<a href="#" data-house-open="' + esc(h.name) + '"><strong>' + esc(h.name) + '</strong> ' + chip(state_, h.closed ? 'סגור' : h.free + ' פנויות') + '<small>' + h.inHouse + ' / ' + (h.capacity || '—') + (h.capacity ? ' · ' + h.pct + '%' : '') + '</small></a>';
        }).join('') + (o.unknown ? '<a href="/?view=classic"><strong>בית לא מזוהה</strong> ' + chip('late', o.unknown + ' מטופלים') + '<small>לתיקון בדשבורד</small></a>' : '') + '</div>'
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
      if (!(keepTab && state.drawer && state.drawer.id === id)) { state.account = null; state.report = null; state.small = null; state.receiptForm = null; }
      const dr = $('#crm-drawer');
      const name = lead ? lead.name : pat.name;
      const subject = lead ? { leadId: lead.id } : { patientId: pat.id };
      const kv = lead ? [['טלפון', lead.phone], ['בית', houseName(lead.house)], ['מקור', lead.source], ['אחראי', lead.assignedTo], ['שלב', stageLabel(lead.stage)], ['פגישה', fmtDate(lead.visitDate) + (lead.visitTime ? ' ' + lead.visitTime : '')], ['נוצר', fmtDate(lead.created)], ['נפגש/ת עם', lead.meetingWith], ['תוצאת פגישה', lead.meetingOutcome], ['איש קשר', lead.contactName + (lead.contactRelation ? ' (' + lead.contactRelation + ')' : '')], ['טלפון איש קשר', lead.contactPhone], ['הערות', lead.note]]
        : [['בית', houseName(pat.houseId)], ['תאריך כניסה', fmtDate(pat.date)], ['סטטוס', pat.status], ['ליד', pat.fromLead], ['מקור', pat.source]];
      const na = lead ? nextActionFor(lead, state.today) : null;
      dr.innerHTML = '<div class="drawer-head"><div><h2>' + esc(name) + '</h2><div class="meta">' + esc(lead ? stageLabel(lead.stage) + ' · ' + houseName(lead.house) : 'מטופל/ת · ' + houseName(pat.houseId)) + (na ? ' · ' + esc(na.text) : '') + '</div></div><button type="button" class="btn small" id="crm-drawer-close" aria-label="סגירה">✕</button></div>'
        + '<div class="tabs" role="tablist">' + [['overview', 'סקירה'], ['activity', 'פעילות'], ['meetings', 'פגישות ושירותים'], ['account', 'חשבון'], ['docs', 'מסמכים']].map(function (t, i) { return '<button type="button" role="tab" data-tab="' + t[0] + '" aria-selected="' + (i === 0) + '">' + esc(t[1]) + '</button>'; }).join('') + '</div>'
        + '<section data-pane="overview">' + (lead ? renderLeadActions(lead) : renderPatientActions(pat)) + '<dl class="kv">' + kv.filter(function (x) { return s(x[1]); }).map(function (x) { return '<dt>' + esc(x[0]) + '</dt><dd>' + esc(x[1]) + '</dd>'; }).join('') + '</dl><p><a class="btn" href="/?view=classic">עריכה מלאה בדשבורד</a></p></section>'
        + '<section data-pane="activity" hidden><ul class="tl" id="crm-tl"><li>טוען…</li></ul></section>'
        + '<section data-pane="meetings" hidden><p class="na">' + (lead && lead.visitDate ? 'פגישת קבלה ' + esc(fmtDate(lead.visitDate)) + (lead.meetingOutcome ? ' · ' + esc(lead.meetingOutcome) : ' · ללא תוצאה') : 'אין פגישות רשומות') + '</p></section>'
        + '<section data-pane="account" hidden id="crm-account">' + (pat && state.me && state.me.finance ? '<p class="na">טוען נתוני חשבון…</p>' : '<p class="na">' + (lead ? 'החשבון נפתח עם הקליטה לבית.' : 'אין הרשאה לנתוני גבייה.') + '</p>') + '</section>'
        + '<section data-pane="docs" hidden><p class="na">מסמכים — חשבשבת נשארת המקור; עדיין לא מחובר.</p></section>';
      const prevTab = keepTab && state.drawer && state.drawer.tab ? state.drawer.tab : 'overview';
      if (prevTab !== 'overview') {
        doc.querySelectorAll('#crm-drawer [role="tab"]').forEach(function (b) { b.setAttribute('aria-selected', String(b.dataset.tab === prevTab)); });
        doc.querySelectorAll('#crm-drawer [data-pane]').forEach(function (p) { p.hidden = p.dataset.pane !== prevTab; });
      }
      dr.setAttribute('aria-hidden', 'false');
      $('#crm-scrim').setAttribute('data-open', 'true');
      state.drawer = { kind: kind, id: id, tab: prevTab };
      if (pat && state.me && state.me.finance) fillAccountPane(pat.id);
      api('getActivity', Object.assign({ limit: 50 }, subject)).then(function (r) {
        const tl = $('#crm-tl');
        if (!tl) return;
        if (!r || r.ok === false) { tl.innerHTML = '<li class="na">ציר הפעילות לא זמין (' + esc((r && r.error) || 'שגיאה') + ')</li>'; return; }
        if (!r.events || !r.events.length) { tl.innerHTML = '<li class="na">אין אירועים עדיין</li>'; return; }
        tl.innerHTML = r.events.map(function (e) { return '<li><div class="t">' + esc(fmtDate(String(e.occurredAt || '').slice(0, 10)) + ' ' + String(e.occurredAt || '').slice(11, 16)) + ' · ' + esc(e.actorName || e.source || '') + (String(e.source || '').indexOf('manual') === 0 ? ' · ידני' : ' · מערכת') + '</div><div>' + esc(e.summary || e.kind) + '</div></li>'; }).join('');
      });
    }
    /* C9: the «חשבון» pane — the area's two reads (loaded once, shared), one patient. */
    function fillAccountPane(patientId) {
      const paint = function () {
        const el = $('#crm-account');
        if (!el || !state.drawer || state.drawer.id !== patientId) return;
        const pat = compute(state.data, state.today).patients.filter(function (x) { return x.id === patientId; })[0];
        if (!pat) return;
        state.account = { patient: pat, data: patientAccount(pat, state.billing.debt, state.billing.payments) };
        el.innerHTML = renderAccount(state.account.data);
      };
      if (state.billing) return paint();
      loadBilling(paint);
    }
    function renderAccount(a) {
      const me = state.me || {};
      let html = '';
      if (a.errors.length) html += '<p class="na">' + esc(a.errors.join(' · ')) + '</p>';
      html += '<dl class="kv"><dt>חוב פתוח</dt><dd>' + esc(fmtMoney(a.openTotal)) + (a.openCycles.length ? ' (' + a.openCycles.length + ' מחזורים)' : '') + '</dd>'
        + '<dt>התקבל סה"כ</dt><dd>' + esc(fmtMoney(a.receivedTotal)) + (a.receipts.length ? ' (' + a.receipts.length + ' תקבולים)' : '') + '</dd>'
        + '<dt>גוף מממן</dt><dd>' + esc(a.currentFunder || '—') + (a.funders.length > 1 ? ' <span class="na">(' + a.funders.map(function (f) { return f.funder + ' מ-' + fmtDate(f.effectiveFrom); }).join(', ') + ')</span>' : '') + '</dd></dl>';
      html += '<div class="group-title">מחזורים פתוחים</div>';
      if (!a.openCycles.length) html += '<p class="na">אין חוב פתוח' + (a.settledCycles ? ' · ' + a.settledCycles + ' מחזורים סגורים' : '') + '.</p>';
      else html += '<div class="tbl-wrap"><table class="tbl" id="crm-account-open"><thead><tr><th>מחזור</th><th>צפוי</th><th>התקבל</th><th>יתרה</th><th>ימים</th><th></th></tr></thead><tbody>'
        + a.openCycles.map(function (c, i) {
          const st = c.days > 60 ? 'late' : c.days > 30 ? 'today' : 'ok';
          return '<tr><td>' + esc(fmtDate(c.start)) + (c.end ? '–' + esc(fmtDate(c.end)) : '') + (c.kind === 'unrecorded' ? ' <span class="na">ללא דיווח</span>' : '') + (c.grace ? ' ' + chip('wait', 'גוף מממן') : '') + '</td><td>' + esc(fmtMoney(c.expected)) + '</td><td>' + esc(fmtMoney(c.received)) + '</td><td>' + esc(fmtMoney(c.balance)) + '</td><td>' + chip(st, c.days + '') + '</td>'
            + '<td><button type="button" class="btn small primary" data-report-open="' + i + '">דווח תשלום</button>'
            + (me.canDiscount && c.month ? ' <button type="button" class="btn small" data-discount-open="' + i + '">הנחה</button>' : '')
            + (me.canAmount && c.month ? ' <button type="button" class="btn small" data-amount-open="' + i + '">שנה סכום</button>' : '') + '</td></tr>';
        }).join('') + '</tbody></table></div>';
      const others = state.account ? reportableCycles(state.account.patient, a, state.today) : [];
      const defIdx = defaultReportable(others, state.today);
      if (others.length) html += '<p><label class="na">דווח תשלום למחזור אחר (מקדמה / מחזור שלא ברשימה) <select id="crm-other-cycle">' + others.map(function (w, i) { return '<option value="' + i + '"' + (i === defIdx ? ' selected' : '') + '>' + esc(fmtDate(w.start) + '–' + fmtDate(w.end) + ' · ' + fmtMoney(w.expected) + (w.status ? ' · ' + (CYCLE_STATUS_LABELS[w.status] || w.status) : '')) + '</option>'; }).join('') + '</select></label> <button type="button" class="btn small" data-report-other>דווח תשלום</button></p>';
      html += '<div id="crm-report"></div>';
      html += '<div class="group-title">זיכויים</div>';
      const credits = state.billing ? patientCredits(state.account ? state.account.patient : a.patientId, state.billing.credits) : [];
      if (!credits.length) html += '<p class="na">אין זיכויים.</p>';
      else html += '<div class="tbl-wrap"><table class="tbl" id="crm-account-credits"><thead><tr><th>סוג</th><th>חודש</th><th>סכום</th><th>סטטוס</th><th></th></tr></thead><tbody>'
        + credits.map(function (c) {
          const st = c.status === 'paid' ? 'ok' : c.status === 'cancelled' ? 'wait' : 'today';
          return '<tr><td>' + esc(CREDIT_TYPE_LABELS[c.creditType] || c.creditType) + (c.reason ? ' <span class="na">' + esc(c.reason) + '</span>' : '') + '</td><td>' + esc(c.allocationMonth) + '</td><td>' + esc(fmtMoney(c.amount)) + '</td><td>' + chip(st, (CREDIT_STATUS_LABELS[c.status] || c.status) + (c.paidDate ? ' ' + fmtDate(c.paidDate) : '')) + '</td>'
            + '<td>' + (c.status === 'pending' && c.amount > 0 && me.finance ? '<button type="button" class="btn small" data-settle-open="' + esc(c.id) + '">סמן כשולם</button>' : '') + '</td></tr>';
        }).join('') + '</tbody></table></div>';
      html += '<div class="group-title">תשלומים</div>';
      if (!a.cycles.length) html += '<p class="na">אין תשלומים רשומים.</p>';
      else html += '<div class="tbl-wrap"><table class="tbl" id="crm-account-cycles"><thead><tr><th>לתשלום</th><th>סכום</th><th>שולם</th><th>סטטוס</th></tr></thead><tbody>'
        + a.cycles.map(function (c) {
          const st = c.status === 'paid' ? 'ok' : c.status === 'partial' ? 'today' : c.status === 'void' ? 'wait' : 'late';
          const open = (c.status === 'unpaid' || c.status === 'partial') && !a.openCycles.some(function (o) { return o.paymentId === c.id; });
          return '<tr><td>' + esc(fmtDate(c.dueDate)) + '</td><td>' + esc(fmtMoney(c.amount)) + '</td><td>' + esc(fmtMoney(c.amountPaid)) + '</td><td>' + chip(st, CYCLE_STATUS_LABELS[c.status] || c.status || '—') + (open ? ' <button type="button" class="btn small" data-report-row="' + esc(c.id) + '">דווח</button>' : '') + '</td></tr>';
        }).join('') + '</tbody></table></div>';
      html += '<div class="group-title">תקבולים</div>';
      if (!a.receipts.length) html += '<p class="na">אין תקבולים.</p>';
      else html += '<div class="tbl-wrap"><table class="tbl" id="crm-account-receipts"><thead><tr><th>תאריך</th><th>סכום</th><th>אמצעי</th><th>משלם</th><th>אימות</th><th></th></tr></thead><tbody>'
        + a.receipts.map(function (r) {
          const cs = r.confirmStatus === 'confirmed' ? 'ok' : r.confirmStatus === 'flagged' ? 'late' : 'today';
          return '<tr><td>' + esc(fmtDate(r.receivedDate)) + '</td><td>' + esc(fmtMoney(r.amount)) + '</td><td>' + esc(r.method) + '</td><td>' + esc(r.payer) + '</td><td>' + (r.isVoid ? chip('wait', 'בוטלה') : (r.confirmStatus ? chip(cs, CONFIRM_LABELS[r.confirmStatus] || r.confirmStatus) : '')) + '</td>'
            + '<td>' + (r.isVoid ? '' : '<button type="button" class="btn small" data-receipt-edit="' + esc(r.id) + '">עריכה</button>' + (me.deleter ? ' <button type="button" class="btn small" data-receipt-void="' + esc(r.id) + '">ביטול</button>' : '')) + '</td></tr>';
        }).join('') + '</tbody></table></div><div id="crm-receipt-form"></div>';
      html += '<p><a class="btn" href="/?view=classic">עריכת קבלות, שיוך תשלומים וזיכויים ידניים בדשבורד</a></p>';
      return html;
    }
    /* C10: the «דווח תשלום» form inside the account pane. */
    function openReportForm(cycle, remaining) {
      const el = $('#crm-report');
      if (!el || !state.account) return;
      const R = reportRules(win);
      const today = state.today;
      const d = reportDefaults(cycle, remaining, today, state.account.data.currentFunder);
      state.report = { cycle: cycle, submissionId: newSubmissionId(), values: d };
      const opt = function (list, sel) { return '<option value="">בחרי…</option>' + list.map(function (v) { return '<option value="' + esc(v) + '"' + (v === sel ? ' selected' : '') + '>' + esc(v) + '</option>'; }).join(''); };
      const err = function (f) { return '<div class="err" data-err="' + f + '"></div>'; };
      el.innerHTML = '<form class="new-lead report" data-form="payment-report" novalidate>'
        + '<h3>דווח תשלום · מחזור ' + esc(fmtDate(cycle.coverageStart)) + '–' + esc(fmtDate(cycle.coverageEnd)) + ' · צפוי ' + esc(fmtMoney(cycle.amount)) + (remaining !== Number(cycle.amount) ? ' · יתרה ' + esc(fmtMoney(remaining)) : '') + '</h3>'
        + '<label>תאריך קבלת התשלום *<input type="date" name="receivedDate" max="' + esc(today) + '" value="' + esc(d.receivedDate) + '">' + err('receivedDate') + '</label>'
        + '<label>סכום שהתקבל (₪, כולל מע״מ) *<input type="text" inputmode="decimal" name="amount" value="' + esc(d.amount) + '">' + err('amount') + '</label>'
        + '<label>אמצעי תשלום *<select name="method">' + opt(R ? R.PAYMENT_METHODS : [], d.method) + '</select>' + err('method') + '</label>'
        + '<label>אסמכתא / מספר עסקה<input type="text" name="reference" value="">' + err('reference') + '</label>'
        + '<label>שם משלם *<input type="text" name="payer" value="">' + err('payer') + '</label>'
        + '<label>גוף מממן *<select name="funder">' + opt(R ? R.PAYMENT_FUNDERS : [], d.funder) + '</select>' + err('funder') + '</label>'
        + '<label>תחילת תקופת הכיסוי *<input type="date" name="coverageStart" value="' + esc(d.coverageStart) + '">' + err('coverageStart') + '</label>'
        + '<label>סוף תקופת הכיסוי *<input type="date" name="coverageEnd" value="' + esc(d.coverageEnd) + '">' + err('coverageEnd') + '</label>'
        + '<label>חשבונית? *<select name="invoiceWanted"><option value="">בחרי…</option><option value="yes">כן</option><option value="no">לא</option></select>' + err('invoiceWanted') + '</label>'
        + '<label>על שם<input type="text" name="invoiceTo" value="">' + err('invoiceTo') + '</label>'
        + '<div class="wide err" data-err="_form"></div>'
        + '<div class="wide toolbar"><button type="submit" class="btn primary">שמירת הדיווח</button><button type="button" class="btn" data-report-cancel>ביטול</button><span class="na" id="crm-report-state"></span></div>'
        + '</form>';
      el.scrollIntoView({ block: 'nearest' });
    }
    function showReportIssues(f, issues, message) {
      Array.prototype.forEach.call(f.querySelectorAll('.err'), function (e) { e.textContent = ''; });
      issues.forEach(function (i) { const e = f.querySelector('.err[data-err="' + i.field + '"]'); if (e) e.textContent = i.hebrewMessage || i.code; });
      const fe = f.querySelector('.err[data-err="_form"]');
      if (fe && !issues.some(function (i) { return i.field === '_form'; })) fe.textContent = message || (issues.length ? 'הדיווח לא נשמר — יש להשלים את השדות המסומנים' : '');
    }
    function submitReport(f, confirmDuplicate) {
      if (!state.report || state.saving) return Promise.resolve(false);
      const vals = {};
      Array.prototype.forEach.call(f.elements, function (el) { if (el.name) vals[el.name] = el.value; });
      state.report.values = vals;
      const issues = reportIssues(vals, state.today, !!(state.me && state.me.approver), reportRules(win));
      if (issues.length) { showReportIssues(f, issues); return Promise.resolve(false); }
      showReportIssues(f, []);
      const body = reportBody(state.report.cycle, vals, state.report.submissionId, confirmDuplicate);
      const st = $('#crm-report-state'); if (st) st.textContent = 'שומר…';
      state.saving = true;
      return win.fetch('/api/sheets', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
        .then(function (r) { return r.json().catch(function () { return { ok: false, error: 'bad_json' }; }); })
        .then(function (res) {
          state.saving = false;
          const out = reportOutcome(res);
          if (out.ok) {
            toast('התשלום נשמר ✓');
            state.report = null;
            // re-read both answers: the money a row shows is always the server's
            const pid = state.drawer && state.drawer.id;
            state.billing = null;
            if (pid) fillAccountPane(pid);
            return true;
          }
          if (out.duplicate) {
            if (st) st.textContent = '';
            if (win.confirm(duplicateText(out.duplicate))) return submitReport(f, true);
            return false;
          }
          showReportIssues(f, out.issues, out.message); if (st) st.textContent = '';
          toast(out.message, true);
          return false;
        })
        .catch(function (e) { state.saving = false; if (st) st.textContent = ''; showReportIssues(f, [], 'התשלום לא נשמר — נסי שוב'); toast(String(e && e.message || e), true); return false; });
    }
    /* C11: discount / amount / settle forms share the #crm-report slot. */
    function openSmallForm(kind, ctx) {
      const el = $('#crm-report');
      if (!el) return;
      state.report = null;
      state.small = { kind: kind, ctx: ctx };
      const err = function (f) { return '<div class="err" data-err="' + f + '"></div>'; };
      let inner = '';
      if (kind === 'discount') {
        inner = '<h3>הנחה לחודש ' + esc(ctx.month) + ' · צפוי ' + esc(fmtMoney(ctx.expected)) + (ctx.discount ? ' · הנחה קיימת ' + esc(fmtMoney(ctx.discount)) : '') + '</h3>'
          + '<label>סכום ההנחה (₪) *<input type="text" inputmode="decimal" name="discountAmount" value="' + esc(ctx.discount || '') + '">' + err('discountAmount') + '</label>'
          + '<label class="wide">סיבה *<input type="text" name="discountReason" maxlength="120" value="">' + err('discountReason') + '</label>';
      } else if (kind === 'amount') {
        inner = '<h3>שינוי סכום לחודש ' + esc(ctx.month) + ' · כרגע ' + esc(fmtMoney(ctx.expected)) + '</h3>'
          + '<label>הסכום החדש (₪, כולל מע״מ) *<input type="text" inputmode="decimal" name="amount" value="' + esc(ctx.expected) + '">' + err('amount') + '</label>';
      } else {
        inner = '<h3>סימון זיכוי כשולם · ' + esc(fmtMoney(ctx.amount)) + ' · ' + esc(CREDIT_TYPE_LABELS[ctx.creditType] || ctx.creditType) + ' ' + esc(ctx.allocationMonth) + '</h3>'
          + '<label>תאריך התשלום *<input type="date" name="paidDate" max="' + esc(state.today) + '" value="' + esc(state.today) + '">' + err('paidDate') + '</label>'
          + '<label>אמצעי *<select name="method"><option value="">בחרי…</option>' + SETTLE_METHODS.map(function (m) { return '<option value="' + esc(m) + '">' + esc(m) + '</option>'; }).join('') + '</select>' + err('method') + '</label>';
      }
      el.innerHTML = '<form class="new-lead report" data-form="small-' + kind + '" novalidate>' + inner + '<div class="wide err" data-err="_form"></div>'
        + '<div class="wide toolbar"><button type="submit" class="btn primary">שמירה</button><button type="button" class="btn" data-report-cancel>ביטול</button><span class="na" id="crm-report-state"></span></div></form>';
      el.scrollIntoView({ block: 'nearest' });
    }
    function submitSmall(f) {
      if (!state.small || !state.account || state.saving) return Promise.resolve(false);
      const vals = {}; Array.prototype.forEach.call(f.elements, function (el) { if (el.name) vals[el.name] = el.value; });
      const k = state.small.kind, ctx = state.small.ctx, pat = state.account.patient;
      let errs, body, proof, label;
      if (k === 'discount') { vals.month = ctx.month; errs = discountErrors(vals); body = discountBody(pat, ctx.month, vals.discountAmount, vals.discountReason); proof = ''; label = 'ההנחה'; }
      else if (k === 'amount') { vals.month = ctx.month; errs = overrideErrors(vals); body = overrideBody(pat, ctx.month, vals.amount, state.today); proof = 'override'; label = 'הסכום'; }
      else { errs = settleErrors(vals, state.today); body = settleBody(ctx.id, vals.paidDate, vals.method); proof = ''; label = 'הזיכוי'; }
      const issues = Object.keys(errs).map(function (f_) { return { field: f_, hebrewMessage: errs[f_] }; });
      showReportIssues(f, issues, issues.length ? 'יש לתקן את השדות המסומנים' : '');
      if (issues.length) return Promise.resolve(false);
      const st = $('#crm-report-state'); if (st) st.textContent = 'שומר…';
      state.saving = true;
      return win.fetch('/api/sheets', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
        .then(function (r) { return r.json().catch(function () { return { ok: false, error: 'bad_json' }; }); })
        .then(function (res) {
          state.saving = false;
          const why = writeRefusal(res, proof);
          if (why) { showReportIssues(f, [], why); if (st) st.textContent = ''; toast(why, true); return false; }
          toast(label + ' נשמר ✓'); state.small = null;
          const pid = state.drawer && state.drawer.id; state.billing = null; if (pid) fillAccountPane(pid);
          return true;
        })
        .catch(function (e) { state.saving = false; if (st) st.textContent = ''; showReportIssues(f, [], 'השינוי לא נשמר — נסי שוב'); toast(String(e && e.message || e), true); return false; });
    }
    /* C13: receipt edit / void forms. */
    function openReceiptForm(kind, r) {
      const el = $('#crm-receipt-form');
      if (!el) return;
      state.receiptForm = { kind: kind, receipt: r };
      const R = reportRules(win);
      const err = function (f) { return '<div class="err" data-err="' + f + '"></div>'; };
      const opt = function (list, sel) { return '<option value="">בחרי…</option>' + list.map(function (v) { return '<option value="' + esc(v) + '"' + (v === sel ? ' selected' : '') + '>' + esc(v) + '</option>'; }).join(''); };
      let inner;
      if (kind === 'edit') {
        inner = '<h3>עריכת קבלה · ' + esc(fmtDate(r.receivedDate)) + ' · ' + esc(fmtMoney(r.amount)) + '</h3>'
          + '<p class="wide na">סכום ותאריך קבלה אינם ניתנים לעריכה — אם הם שגויים, בטלי את הקבלה ודווחי מחדש.</p>'
          + '<label>אמצעי תשלום *<select name="method">' + opt(R ? R.PAYMENT_METHODS : [], r.method) + '</select>' + err('method') + '</label>'
          + '<label>אסמכתא / מספר עסקה<input type="text" name="reference" value="' + esc(r.reference) + '">' + err('reference') + '</label>'
          + '<label>שם משלם *<input type="text" name="payer" value="' + esc(r.payer) + '">' + err('payer') + '</label>'
          + '<label>חשבונית?<select name="invoiceWanted"><option value=""' + (!r.invoiceWanted ? ' selected' : '') + '>—</option><option value="yes"' + (r.invoiceWanted === 'yes' ? ' selected' : '') + '>כן</option><option value="no"' + (r.invoiceWanted === 'no' ? ' selected' : '') + '>לא</option></select>' + err('invoiceWanted') + '</label>'
          + '<label>על שם<input type="text" name="invoiceTo" value="' + esc(r.invoiceTo) + '">' + err('invoiceTo') + '</label>'
          + '<label>תחילת תקופת הכיסוי<input type="date" name="coverageStart" value="' + esc(r.coverageStart) + '">' + err('coverageStart') + '</label>'
          + '<label>סוף תקופת הכיסוי<input type="date" name="coverageEnd" value="' + esc(r.coverageEnd) + '">' + err('coverageEnd') + '</label>'
          + '<label class="wide">סיבת התיקון (לא חובה)<input type="text" name="reason" maxlength="300" value="">' + err('reason') + '</label>';
      } else {
        inner = '<h3>ביטול קבלה · ' + esc(fmtDate(r.receivedDate)) + ' · ' + esc(fmtMoney(r.amount)) + '</h3>'
          + '<p class="wide na">הקבלה תסומן כמבוטלת (לא נמחקת) והמחזור יחושב מחדש. לאחר מכן דווחי את התשלום הנכון.</p>'
          + '<label class="wide">סיבה *<input type="text" name="note" maxlength="120" value="">' + err('note') + '</label>';
      }
      el.innerHTML = '<form class="new-lead report" data-form="receipt-' + kind + '" novalidate>' + inner + '<div class="wide err" data-err="_form"></div>'
        + '<div class="wide toolbar"><button type="submit" class="btn ' + (kind === 'void' ? '' : 'primary') + '">' + (kind === 'void' ? 'ביטול הקבלה' : 'שמירה') + '</button><button type="button" class="btn" data-receipt-cancel>סגירה</button><span class="na" id="crm-receipt-state"></span></div></form>';
      el.scrollIntoView({ block: 'nearest' });
    }
    function submitReceiptForm(f) {
      if (!state.receiptForm || state.saving) return Promise.resolve(false);
      const vals = {}; Array.prototype.forEach.call(f.elements, function (el) { if (el.name) vals[el.name] = el.value; });
      const k = state.receiptForm.kind, r = state.receiptForm.receipt;
      let issues, body, accepted, label;
      if (k === 'edit') {
        issues = receiptEditIssues(r, vals, state.today, reportRules(win)); body = receiptEditBody(r, vals);
        accepted = function (res) { return res && res.ok === true && res.receipt && s(res.receipt.id) === r.id; }; label = 'הקבלה עודכנה';
      } else {
        const e = receiptVoidErrors(vals); issues = Object.keys(e).map(function (x) { return { field: x, hebrewMessage: e[x] }; });
        body = receiptVoidBody(r, vals.note, new Date().toISOString()); accepted = function (res) { return receiptVoidAccepted(res, r.id); }; label = 'הקבלה בוטלה';
      }
      showReportIssues(f, issues, issues.length ? 'יש לתקן את השדות המסומנים' : '');
      if (issues.length) return Promise.resolve(false);
      if (k === 'void' && !win.confirm('לבטל את הקבלה על ' + fmtMoney(r.amount) + ' מ-' + fmtDate(r.receivedDate) + '?')) return Promise.resolve(false);
      const st = $('#crm-receipt-state'); if (st) st.textContent = 'שומר…';
      state.saving = true;
      return win.fetch('/api/sheets', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
        .then(function (res) { return res.json().catch(function () { return { ok: false, error: 'bad_json' }; }); })
        .then(function (res) {
          state.saving = false;
          if (!accepted(res)) {
            const out = res && res.error === 'invalid_report' ? reportOutcome(res) : { message: writeRefusal(res, res && res.ok === true ? 'receipt' : ''), issues: [] };
            showReportIssues(f, out.issues || [], out.message || 'השינוי לא נשמר'); if (st) st.textContent = ''; toast(out.message || 'השינוי לא נשמר', true); return false;
          }
          toast(label + ' ✓'); state.receiptForm = null;
          const pid = state.drawer && state.drawer.id; state.billing = null; if (pid) fillAccountPane(pid);
          return true;
        })
        .catch(function (e) { state.saving = false; if (st) st.textContent = ''; showReportIssues(f, [], 'השינוי לא נשמר — נסי שוב'); toast(String(e && e.message || e), true); return false; });
    }
    function closeDrawer() { $('#crm-drawer').setAttribute('aria-hidden', 'true'); $('#crm-scrim').removeAttribute('data-open'); state.drawer = null; state.account = null; state.report = null; state.small = null; }

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
      } else if (f.dataset.form === 'payment-report') {
        submitReport(f, false);
      } else if (f.dataset.form.indexOf('small-') === 0) {
        submitSmall(f);
      } else if (f.dataset.form.indexOf('receipt-') === 0) {
        submitReceiptForm(f);
      } else if (f.dataset.form === 'new-lead') {
        const vals = {};
        Array.prototype.forEach.call(f.elements, function (el) { if (el.name) vals[el.name] = el.value; });
        createLead(vals);
      }
    });
    root.addEventListener('click', function (ev) {
      const t = ev.target && ev.target.closest ? ev.target.closest('[data-billing-retry],[data-report-open],[data-report-row],[data-report-cancel],[data-discount-open],[data-amount-open],[data-settle-open],[data-report-other],[data-receipt-edit],[data-receipt-void],[data-receipt-cancel]') : null;
      if (!t) return;
      if (t.dataset.billingRetry !== undefined) { state.billing = null; return renderMain(); }
      if (t.dataset.reportCancel !== undefined) { state.report = null; state.small = null; const el = $('#crm-report'); if (el) el.innerHTML = ''; return; }
      if (t.dataset.settleOpen && !(state.drawer && state.account)) {
        // from the גבייה area: open the patient's drawer on «חשבון», then the form
        const cr = pendingCredits(state.billing && state.billing.credits).filter(function (c) { return c.id === t.dataset.settleOpen; })[0];
        const pat = cr && compute(state.data, state.today).patients.filter(function (p) { return p.id === cr.patientId || patientKeyOf(p) === cr.patientKey; })[0];
        if (!pat) return toast('המטופל/ת לא נמצא/ה ברשימה — סימון בדשבורד הרגיל', true);
        openDrawer('patient', pat.id); const tab = doc.querySelector('#crm-drawer [data-tab="account"]'); if (tab) tab.click();
        loadBilling(function () { if (state.account) openSmallForm('settle', cr); });
        if (state.billing) openSmallForm('settle', cr);
        return;
      }
      if (!state.account) return;
      if (t.dataset.receiptCancel !== undefined) { state.receiptForm = null; const el = $('#crm-receipt-form'); if (el) el.innerHTML = ''; return; }
      if (t.dataset.receiptEdit || t.dataset.receiptVoid) {
        const id = t.dataset.receiptEdit || t.dataset.receiptVoid;
        const r = state.account.data.receipts.filter(function (x) { return x.id === id; })[0];
        if (r) openReceiptForm(t.dataset.receiptEdit ? 'edit' : 'void', r);
        return;
      }
      if (t.dataset.reportOther !== undefined) {
        const sel = $('#crm-other-cycle'); const list = reportableCycles(state.account.patient, state.account.data, state.today);
        const w = list[Number(sel && sel.value)];
        if (w) openReportForm(reportCycleForWindow(state.account.patient, w, state.account.data), Math.max(0, (Number(w.expected) || 0) - (Number(w.received) || 0)));
        return;
      }
      if (t.dataset.discountOpen !== undefined) { const c = state.account.data.openCycles[Number(t.dataset.discountOpen)]; if (c) openSmallForm('discount', c); return; }
      if (t.dataset.amountOpen !== undefined) { const c = state.account.data.openCycles[Number(t.dataset.amountOpen)]; if (c) openSmallForm('amount', c); return; }
      if (t.dataset.settleOpen) { const cr = patientCredits(state.account.patient, state.billing.credits).filter(function (c) { return c.id === t.dataset.settleOpen; })[0]; if (cr) openSmallForm('settle', cr); return; }
      if (t.dataset.reportOpen !== undefined) {
        const c = state.account.data.openCycles[Number(t.dataset.reportOpen)];
        if (c) openReportForm(reportCycleFor(state.account.patient, c, state.account.data), c.balance);
        return;
      }
      if (t.dataset.reportRow) {
        const row = state.account.data.cycles.filter(function (x) { return x.id === t.dataset.reportRow; })[0];
        if (row) openReportForm(reportCycleForRow(state.account.patient, row), Math.max(0, row.amount - row.amountPaid));
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
    movedRow: movedRow, patientEditErrors: patientEditErrors, billingOverview: billingOverview, fmtMoney: fmtMoney, DEBT_BUCKET_LABELS: DEBT_BUCKET_LABELS, patientAccount: patientAccount, CYCLE_STATUS_LABELS: CYCLE_STATUS_LABELS,
    patientKeyOf: patientKeyOf, reportCycleFor: reportCycleFor, reportCycleForRow: reportCycleForRow, reportDefaults: reportDefaults, reportIssues: reportIssues, reportBody: reportBody,
    newSubmissionId: newSubmissionId, reportOutcome: reportOutcome, duplicateText: duplicateText, reportRules: reportRules,
    CREDIT_TYPE_LABELS: CREDIT_TYPE_LABELS, CREDIT_STATUS_LABELS: CREDIT_STATUS_LABELS, SETTLE_METHODS: SETTLE_METHODS, creditsOf: creditsOf, patientCredits: patientCredits, pendingCredits: pendingCredits,
    RECEIPT_EDIT_FIELDS: RECEIPT_EDIT_FIELDS, receiptEditFields: receiptEditFields, receiptEditIssues: receiptEditIssues, receiptEditBody: receiptEditBody, receiptVoidErrors: receiptVoidErrors, receiptVoidBody: receiptVoidBody, receiptVoidAccepted: receiptVoidAccepted,
    addMonthsIso: addMonthsIso, stayCycles: stayCycles, reportableCycles: reportableCycles, defaultReportable: defaultReportable, reportCycleForWindow: reportCycleForWindow,
    moneyParse: moneyParse, discountErrors: discountErrors, discountBody: discountBody, overrideErrors: overrideErrors, overrideBody: overrideBody, settleErrors: settleErrors, settleBody: settleBody, writeRefusal: writeRefusal };
}));
