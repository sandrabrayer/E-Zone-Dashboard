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
    { id: 'today', label: 'היום שלי' }, { id: 'leads', label: 'לידים' }, { id: 'occupancy', label: 'תפוסה' },
    { id: 'clients', label: 'מטופלים' }, { id: 'calendar', label: 'יומן' }, { id: 'billing', label: 'גבייה' }, { id: 'control', label: 'בקרת עבודה' },
    { id: 'kpi', label: 'KPI' },   // CHANGELOG-crm-kpi-tab.md: slices, occupancy %, conversion, break-even
    { id: 'triage', label: 'רשומות שדורשות בירור' },   // Stage 3: reached from «פניות» / the «ללא מגע» card, not from the menu
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
    /* Nothing is saved with a field missing (Sandra 05/11/2026): a source, a house (unless the
     * meeting is with «אמבולטורי»), and the contact / billing details the form says it has. */
    if (!s(v && v.source)) out.source = 'יש לבחור מקור ליד';
    if (!s(v && v.house) && s(v && v.meetingWith) !== MEETING_WITH_AMBULATORY) out.house = 'יש לבחור בית (או «נפגש/ת עם: אמבולטורי»)';
    if (s(v && v.contactName) && !s(v && v.contactRelation)) out.contactRelation = 'יש לבחור קשר למטופל';
    if (s(v && v.contactRelation) === 'אחר' && !s(v && v.contactRelationOther)) out.contactRelationOther = 'יש לפרט את הקשר';
    if (s(v && v.billingMode) === 'contact' && !localPhone(v && v.contactPhone)) out.contactPhone = 'גבייה דרך הפונה — חסר טלפון פונה תקין';
    if (s(v && v.billingMode) === 'other' && !localPhone(v && v.billingOther)) out.billingOther = 'יש להזין טלפון תקין לגבייה';
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
  /* ---- CHANGELOG-crm-search-admit-funder.md ---- */
  /* A name as compared: spaces collapsed, lower case. Pure. */
  function nameKey(v) { return s(v).replace(/\s+/g, ' ').toLowerCase(); }
  const OPEN_STAGE_IDS = ['new', 'visit', 'waitlist', 'paid'];
  /* Candidate for an OPERATOR review only: a phone may belong to another family
   * member and a name is not a unique identity. NEVER authorize admission or
   * mark a lead admitted from this match alone. Prefer selecting the exact
   * lead in its own card; otherwise confirm an independent direct intake. */
  function openLeadOfPerson(leads, name, phone) {
    const nk = nameKey(name), ph = localPhone(phone);
    const open = (leads || []).filter(function (l) { return l && OPEN_STAGE_IDS.indexOf(s(l.stage)) >= 0; });
    let hits = ph ? open.filter(function (l) { return localPhone(l.phone) === ph; }) : [];
    if (!hits.length && nk.split(' ').length >= 2) hits = open.filter(function (l) { return nameKey(l.name) === nk; });
    if (hits.length === 1) return hits[0];
    return hits.length > 1 ? 'ambiguous' : null;
  }
  /* An open board lead whose person is ALREADY in a house (added there directly, so the
   * lead itself was never admitted): the in-house patient with the same full name, or
   * whose own lead has the same phone. → the patient, or null. Pure. */
  function leadAlreadyInHouse(lead, patients, leads) {
    if (!lead || OPEN_STAGE_IDS.indexOf(s(lead.stage)) < 0) return null;
    const nk = nameKey(lead.name), ph = localPhone(lead.phone);
    const phoneOf = {};
    (leads || []).forEach(function (l) { if (l && l.id) phoneOf[s(l.id)] = localPhone(l.phone); });
    const hits = (patients || []).filter(function (p) {
      if (!p || !inHouse(p) || s(p.fromLead) === s(lead.id)) return false;
      return (nk.split(' ').length >= 2 && nameKey(p.name) === nk) || (ph && phoneOf[s(p.fromLead)] === ph);
    });
    return hits.length === 1 ? hits[0] : null;
  }
  /* The top search box from any area: leads (every stage on Leads), patients (any status)
   * by name, phone digits (the lead's or the patient's lead's) or house. '' → null. Pure. */
  function globalSearch(c, q) {
    const t = nameKey(q);
    if (!t) return null;
    const digits = t.replace(/\D/g, '');
    const phoneHit = function (ph) { return digits.length >= 4 && s(ph).replace(/\D/g, '').indexOf(digits) >= 0; };
    const phoneOf = {};
    (c.leads || []).forEach(function (l) { phoneOf[s(l.id)] = s(l.phone); });
    const leads = (c.leads || []).filter(function (l) { return nameKey(l.name).indexOf(t) >= 0 || phoneHit(l.phone) || nameKey(houseName(l.house)).indexOf(t) >= 0; });
    const patients = (c.patients || []).filter(function (p) { return nameKey(p.name).indexOf(t) >= 0 || phoneHit(phoneOf[s(p.fromLead)]); })
      .map(function (p) { return Object.assign({ houseName: houseName(p.houseId) }, p); })
      .sort(function (a, b) { return (inHouse(a) ? 0 : 1) - (inHouse(b) ? 0 : 1) || a.name.localeCompare(b.name, 'he'); });
    return { q: s(q), leads: leads.slice(0, 50), patients: patients.slice(0, 50), total: leads.length + patients.length };
  }
  function directAddErrors(v, finance) {
    const out = admissionErrors(v, finance);
    if (s(v.name).split(/\s+/).filter(Boolean).length < 2) out.name = 'יש להזין שם מלא';
    if (!localPhone(v.phone)) out.phone = s(v.phone) ? 'טלפון אינו תקין' : 'יש להזין טלפון (נדרש למעקב ולהעברה לאמבולטורי)';
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
  /* A finance write is accepted only when the source acknowledges this request's
   * own idempotency key, not any successful-looking or unrelated row. */
  function funderWriteConfirmed(res, submissionId) {
    return !!(s(submissionId) && res && res.ok === true && res.row && s(res.row.submissionId) === s(submissionId));
  }
  /* getPayments omits submissionId in the deployed Apps Script projection.
   * Confirm the requested source STATE by unique stay/date/value, not an
   * acknowledgement that the read contract cannot supply. If a future source
   * exposes a submission key, a conflicting key still refuses confirmation. */
  function funderSourceConfirmed(data, patientId, submissionId, funder, effectiveFrom) {
    if (!data || data.ok !== true || !Array.isArray(data.funders) || !s(patientId) ||
        !s(submissionId) || FUNDERS.indexOf(s(funder)) < 0 || !isoDateOk(s(effectiveFrom))) return false;
    const exact = data.funders.filter(function (row) {
      return row && s(row.patientId) === s(patientId) && sheetDay(row.effectiveFrom) === s(effectiveFrom);
    });
    return exact.length === 1 && s(exact[0].funder) === s(funder) &&
      (!s(exact[0].submissionId) || s(exact[0].submissionId) === s(submissionId));
  }
  /* Admission write may have committed even if the browser never saw saveAll's
   * reply. Check only freshly read source IDs — never a name or shared phone.
   * 'confirmed' requires ONE exact patient/stay and the exact admitted lead;
   * a partial or unavailable read must NOT prompt a new admission with new IDs.
   * This is read-only proof, not a new transaction/ledger. */
  function admissionSourceProof(data, expected) {
    const e = expected || {};
    if (!data || data.ok !== true || !s(e.patientId) || !s(e.leadId) || !s(e.houseId) || !sheetDay(e.date)) return 'unavailable';
    const all = [];
    const byHouse = data.patients;
    if (Array.isArray(byHouse)) byHouse.forEach(function (p) { if (p) all.push({ row: p, sourceHouse: s(p.houseId) }); });
    else if (byHouse && typeof byHouse === 'object') {
      Object.keys(byHouse).forEach(function (key) {
        (Array.isArray(byHouse[key]) ? byHouse[key] : []).forEach(function (p) { if (p) all.push({ row: p, sourceHouse: key }); });
      });
    } else return 'unavailable';
    const exact = all.filter(function (x) { return s(x.row.id) === s(e.patientId); });
    if (exact.length > 1) return 'ambiguous';
    if (!exact.length) return 'missing';
    const x = exact[0], p = x.row;
    if (s(p.fromLead) !== s(e.leadId) || houseId(s(p.houseId) || x.sourceHouse) !== houseId(e.houseId) ||
        sheetDay(p.date) !== sheetDay(e.date) || s(p.status) === 'released') return 'mismatch';
    if (!Array.isArray(data.leads)) return 'patient_only';
    const leads = data.leads.filter(function (l) { return l && s(l.id) === s(e.leadId); });
    return leads.length === 1 && s(leads[0].stage) === 'admitted' ? 'confirmed' : 'patient_only';
  }

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
  /* A recorded «המשך טיפול» (one of the three keys; blank / 'unknown' = not recorded). Pure. */
  function continuityKnown(v) { return CONTINUITY_CHOICES.some(function (c) { return c.id === s(v); }); }
  /* Something WAS recorded: a key, or a legacy free-text value; only blank / 'unknown' is missing. Pure. */
  function continuityRecorded(v) { const t = s(v); return !!t && t !== 'unknown'; }
  function continuityLabel(v) { const c = CONTINUITY_CHOICES.filter(function (x) { return x.id === s(v); })[0]; return c ? c.label : s(v); }
  /* The POST body of «לעדכן המשך טיפול» — the same action the classic select sends. Pure. */
  function continuityBody(id, v) { return { action: 'setDischargeContinuity', id: s(id), continuity: s(v) }; }
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
    if (!s(v.dischargeDate)) out.dischargeDate = 'יש להזין תאריך שחרור';
    else if (!isoDateOk(v.dischargeDate)) out.dischargeDate = 'תאריך שחרור מחוץ לטווח';
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
    if (m.view === 'ops' || m.ops === true) return ['today', 'leads', 'occupancy', 'clients', 'calendar', 'control', 'kpi', 'triage'];
    if (!m.finance) return ['today', 'leads', 'occupancy', 'clients', 'calendar', 'control', 'kpi', 'triage'];
    return AREAS.map(function (a) { return a.id; });
  }

  /* The patient drawer's «חשבון» tab (CHANGELOG-crm-dana-default-switch-user.md):
   * only a session that may read billing — finance (Vered, Sandra) or the
   * controller's read access (Ortal). The operational view (Dana) and any
   * other session never get the tab or its pane. Display only: the server
   * refuses the money reads themselves (403). Pure. */
  function accountTabVisible(me) {
    const m = me || {};
    if (m.view === 'ops' || m.ops === true) return false;
    return m.finance === true || m.billingRead === true;
  }

  /* «החלפת משתמש»: delete the offline copies of `/` (they carry the previous
   * user's name and page) from the app's service-worker caches. Never throws;
   * resolves when done. `c` is the CacheStorage (window.caches) or absent. */
  function clearCachedPages(c) {
    try {
      if (!c || typeof c.keys !== 'function') return Promise.resolve();
      return c.keys().then(function (keys) {
        return Promise.all(keys.filter(function (k) { return String(k).indexOf('ezone-dashboard-') === 0; }).map(function (k) {
          return c.open(k).then(function (cache) {
            return cache.keys().then(function (reqs) {
              return Promise.all(reqs.filter(function (r) {
                try { const u = new URL(r.url); return u.pathname === '/' || u.pathname === '/index.html'; } catch (_) { return false; }
              }).map(function (r) { return cache.delete(r); }));
            });
          });
        }));
      }).catch(function () {});
    } catch (_) { return Promise.resolve(); }
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
  /* A billing DATE read from a sheet → 'YYYY-MM-DD' (CHANGELOG-crm-old-payment-dates.md).
   * Older Payments / Funders / Credits rows hold real Date cells, which reach the
   * browser as UTC timestamps — Israel's 1 April arrives as "2026-03-31T21:00:00.000Z".
   * Slicing that is the −1-day bug: the CRM pre-filled a coverage start one day
   * before the cycle and Code.gs refused the report (coverage_outside_cycle).
   * Same rule as app.js isoDate(): a bare day stays as is; a full timestamp is
   * read as its calendar day in Asia/Jerusalem; anything else → ''. Pure. */
  const JERUSALEM_DAY = typeof Intl === 'object' && Intl.DateTimeFormat
    ? new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit' }) : null;
  function sheetDay(v) {
    if (v instanceof Date) { if (isNaN(v.getTime())) return ''; v = v.toISOString(); }
    const t = s(v);
    if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(t)) return '';
    const ms = Date.parse(t);
    if (isNaN(ms) || !JERUSALEM_DAY) return t.slice(0, 10);
    const parts = {}; JERUSALEM_DAY.formatToParts(new Date(ms)).forEach(function (x) { parts[x.type] = x.value; });
    return parts.year + '-' + parts.month + '-' + parts.day;
  }
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
        advance: l.advance === '' || l.advance == null ? '' : Number(l.advance) || 0,
        // the house manager's meeting report (C14; classic MEETING_REPORT_* fields)
        meetingReportOutcome: s(l.meetingReportOutcome), meetingCompanion: s(l.meetingCompanion), meetingNote: s(l.meetingNote),
        meetingReporter: s(l.meetingReporter), meetingReportedAt: s(l.meetingReportedAt), meetingSeen: s(l.meetingSeen),
        entryDate: isoDay(l.entryDate) };
    });
    const discharges = (Array.isArray(d.dischargedPatients) ? d.dischargedPatients : []).map(function (r) {
      return { id: s(r.id), patientId: s(r.patientId), name: s(r.name), houseId: s(r.houseId), fromLead: s(r.fromLead), date: isoDay(r.date), exitDate: isoDay(r.exitDate),
        dischargedAt: s(r.dischargedAt), disposition: s(r.disposition), note: s(r.discharge_note), continuity: s(r.continuity), priorStatus: s(r.prior_status), restored: s(r.restored),
        deletedAt: s(r.deletedAt), source: s(r.dischargeSource), by: s(r.dischargedBy) };
    });
    const patients = [];
    const p = d.patients;
    if (Array.isArray(p)) p.forEach(function (x) { patients.push(x); });
    else if (p && typeof p === 'object') Object.keys(p).forEach(function (h) { (Array.isArray(p[h]) ? p[h] : []).forEach(function (x) { patients.push(Object.assign({ houseId: h }, x)); }); });
    const pts = patients.map(function (x) {
      return { id: s(x.id), houseId: s(x.houseId), name: s(x.name), date: isoDay(x.date), status: s(x.status) || 'active',
        exitDate: isoDay(x.exitDate), fromLead: s(x.fromLead), source: s(x.source), personId: s(x.personId), pay: Number(x.pay) || 0 };
    });
    /* A board lead whose patient is in a house by the exact fromLead link was
     * admitted (and reopened by a stale save) — shown as admitted, never as an
     * open «בטיפול פעיל» lead (CHANGELOG-admitted-lead-stays-closed.md). */
    const inHouse = {};
    pts.forEach(function (x) { if (x.fromLead && x.status !== 'released') inHouse[x.fromLead] = x; });
    leads.forEach(function (l) {
      const pt = inHouse[l.id];
      if (pt && STAGES.some(function (st) { return st.id === l.stage; })) { l.stage = 'admitted'; if (!l.entryDate) l.entryDate = pt.date; }
    });
    const sent = {};
    (Array.isArray(d.outpatientSentLeadIds) ? d.outpatientSentLeadIds : []).forEach(function (k) { sent[s(k)] = true; });
    return { leads: leads, patients: pts, discharges: discharges, outpatientSent: sent };
  }

  /* ---- C17: «משוחררים» in the CRM (CHANGELOG-crm-discharged.md) ----
   * The discharge audit rows (getData.dischargedPatients) that are still open:
   * not restored, not soft-deleted. Newest exit first; a days-back window. */
  function dischargedList(c, today, daysBack, f) {
    const house = s(f && f.house), q = s(f && f.q).toLowerCase();
    const since = daysBack ? addDays(today, -daysBack) : '';
    return (c.discharges || []).filter(function (r) {
      if (r.restored === '1' || r.restored === 'TRUE' || r.restored === 'true' || r.deletedAt) return false;
      if (since && r.exitDate && r.exitDate < since) return false;
      if (house && houseName(r.houseId) !== houseName(house)) return false;
      if (q && (r.name + ' ' + houseName(r.houseId)).toLowerCase().indexOf(q) < 0) return false;
      return true;
    }).map(function (r) {
      return Object.assign({ houseName: houseName(r.houseId), dispositionLabel: DISPOSITION_LABELS[r.disposition] || r.disposition,
        sentToOutpatient: !!(c.outpatientSent && c.outpatientSent['discharge:' + r.id]) }, r);
    }).sort(function (a, b) { return (b.exitDate || b.dischargedAt || '').localeCompare(a.exitDate || a.dischargedAt || '') || a.name.localeCompare(b.name, 'he'); });
  }
  function priorStatusOf(audit) { const st = s(audit && audit.priorStatus); return st === 'active' || st === 'trial' || st === 'wait' ? st : 'active'; }
  /* The released Patients row this audit row restores: by the audit's patientId, then the
   * classic triple (house, name, entry date), then the one released row of the house with
   * the same source lead. Null → the row is gone (restore in the classic dashboard). */
  function restoreTarget(audit, rawPatientsByHouse) {
    const byHouse = rawPatientsByHouse && typeof rawPatientsByHouse === 'object' && !Array.isArray(rawPatientsByHouse) ? rawPatientsByHouse : {};
    const hid = houseId(audit.houseId);
    const rows = Array.isArray(byHouse[hid]) ? byHouse[hid] : (Array.isArray(byHouse[s(audit.houseId)]) ? byHouse[s(audit.houseId)] : []);
    const key = s(hid) in byHouse ? hid : s(audit.houseId);
    const pid = s(audit.patientId);
    let idx = pid ? rows.findIndex(function (p) { return s(p && p.id) === pid; }) : -1;
    if (idx < 0) idx = rows.findIndex(function (p) { return p && s(p.name) === s(audit.name) && isoDay(p.date) === s(audit.date); });
    if (idx < 0 && s(audit.fromLead)) {
      const hits = rows.map(function (p, i) { return p && s(p.status) === 'released' && s(p.fromLead) === s(audit.fromLead) ? i : -1; }).filter(function (i) { return i >= 0; });
      if (hits.length === 1) idx = hits[0];
    }
    if (idx < 0) return null;
    return { hid: key, arr: rows, idx: idx, row: rows[idx] };
  }
  function restoredRow(row, audit) { return Object.assign({}, row, { status: priorStatusOf(audit), exitDate: '' }); }
  /* Every open audit row of the same stay (a stay discharged twice without a restore). */
  function openAuditsOf(audit, discharges) {
    return (discharges || []).filter(function (d) {
      if (d.restored === '1' || d.restored === 'TRUE' || d.deletedAt) return false;
      if (d.patientId && audit.patientId) return d.patientId === audit.patientId;
      return houseId(d.houseId) === houseId(audit.houseId) && d.name === audit.name && d.date === audit.date;
    });
  }
  function restoreFlagBody(raw) { return { action: 'restorePatientToActive', patient: Object.assign({}, raw, { restored: 'TRUE' }) }; }
  function restoreAsLeadBody(raw, newLeadId) { return { action: 'restorePatient', patient: Object.assign({}, raw, { newLeadId: s(newLeadId) }) }; }
  function outpatientBody(dischargeId, phone) { const b = { dischargeId: s(dischargeId), manual: true }; if (s(phone)) b.phone = s(phone); return b; }
  /* A phone typed for the Outpatient handoff (CHANGELOG-crm-followups-1104.md) — the
   * server rule: 9–10 digits starting with 0 (a mobile's lost leading zero restored). '' when invalid. Pure. */
  function handoffPhone(raw) {
    let d = s(raw).replace(/[\s\-().\u200e\u200f]/g, '');
    if (/^\+972/.test(d)) d = '0' + d.slice(4);
    if (/^5\d{8}$/.test(d)) d = '0' + d;
    return /^0\d{8,9}$/.test(d) ? d : '';
  }

  /* ---- C14: «פגישות ושירותים» over real data (CHANGELOG-crm-meetings-tab.md) ----
   * The lead's intake meeting (Vered's own outcome) + the house manager's
   * report from /meeting-report (read-only context, as in the classic card;
   * opening it marks it seen through the one-lead saveAll), and, for a
   * patient, the discharge record. Services (Therapists) are not connected. */
  const MEETING_REPORT_OUTCOME_LABELS = { advancing: 'התקיימה — מתקדם לכניסה', undecided: 'התקיימה — מתלבט', not_fit: 'התקיימה — לא מתאים', no_show: 'לא הגיע / בוטל' };
  const MEETING_COMPANION_LABELS = { mother: 'אמא', father: 'אבא', parents: 'הורים', partner: 'בן/בת זוג', sibling: 'אח/אחות', friend: 'חבר', alone: 'לבד', other: 'אחר' };
  const DISPOSITION_LABELS = { completed: 'סיים טיפול', stopped_early: 'הפסיק לפני הזמן', released_outpatient: 'משוחרר לטיפול חוץ', not_relevant: 'לא רלוונטי' };
  /* An ISO timestamp → 'DD/MM/YYYY HH:MM' in Asia/Jerusalem; a bare date → DD/MM/YYYY; junk → as is. */
  function whenLocal(iso) {
    const t = s(iso);
    const ms = Date.parse(t);
    if (!/T\d{2}:\d{2}/.test(t) || isNaN(ms)) return fmtDate(t.slice(0, 10)) || t;
    const parts = {};
    new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jerusalem', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(ms)).forEach(function (x) { parts[x.type] = x.value; });
    return parts.day + '/' + parts.month + '/' + parts.year + ' ' + parts.hour + ':' + parts.minute;
  }
  function reportUnseen(l) { return !!(l && s(l.meetingReportedAt)) && s(l.meetingSeen) !== '1'; }
  function unseenReports(leads) { return (Array.isArray(leads) ? leads : []).filter(reportUnseen).length; }
  function managerReport(l) {
    if (!l || !s(l.meetingReportedAt)) return null;
    const at = s(l.meetingReportedAt);
    return { outcome: MEETING_REPORT_OUTCOME_LABELS[l.meetingReportOutcome] || s(l.meetingReportOutcome), companion: MEETING_COMPANION_LABELS[l.meetingCompanion] || s(l.meetingCompanion),
      note: s(l.meetingNote), reporter: s(l.meetingReporter), at: at, when: whenLocal(at), unseen: reportUnseen(l) };
  }
  /* Everything the tab shows for a lead or a patient (via its lead). */
  function meetingsFor(subject, kind, data) {
    const d = data || { leads: [], patients: [], discharges: [] };
    const lead = kind === 'lead' ? subject : (d.leads || []).filter(function (l) { return l.id === s(subject && subject.fromLead); })[0] || null;
    const visit = lead && (lead.visitDate || lead.meetingOutcome || lead.meetingWith) ? { date: lead.visitDate, time: lead.visitTime, withWhom: lead.meetingWith, outcome: lead.meetingOutcome } : null;
    // The patient's discharge record: by the audit row's patientId (newer rows), else the
    // classic identity triple (house, name, entry date); soft-deleted / restored rows are not discharges.
    const sameStay = function (r) {
      if (r.deletedAt || isRestoredDischarge(r)) return false;
      if (r.patientId && r.patientId === s(subject.id)) return true;
      return !r.patientId && houseId(r.houseId) === houseId(subject.houseId) && r.name === s(subject.name) && r.date === s(subject.date);
    };
    const discharge = kind === 'patient' ? ((d.discharges || []).filter(sameStay).sort(function (a, b) { return a.dischargedAt < b.dischargedAt ? 1 : -1; })[0] || null) : null;
    return { lead: lead, visit: visit, report: managerReport(lead), discharge: discharge ? Object.assign({}, discharge, { dispositionLabel: DISPOSITION_LABELS[discharge.disposition] || discharge.disposition }) : null };
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
      if (reportUnseen(l) && STAGES.some(function (st) { return st.id === l.stage; })) {
        row = { kind: 'report_unseen', action: 'לקרוא את דיווח המנהל/ת על הפגישה', owner: l.assignedTo, due: s(l.meetingReportedAt).slice(0, 10), state: 'today',
          reason: 'דיווח מ-' + (l.meetingReporter || 'המנהל/ת') + (l.meetingReportOutcome ? ' · ' + (MEETING_REPORT_OUTCOME_LABELS[l.meetingReportOutcome] || l.meetingReportOutcome) : '') };
      } else if (l.stage === 'visit' && s(l.meetingOutcome) === 'cancelled') {
        row = { kind: 'meeting_cancelled', action: 'לתאם מועד חדש או לסגור', owner: l.assignedTo, due: '', state: 'today', reason: 'הפגישה בוטלה' };
      } else if (l.stage === 'visit' && l.visitDate && l.visitDate < today && !l.meetingOutcome) {
        const reported = !!s(l.meetingReportedAt);
        row = { kind: 'meeting_no_outcome', action: reported ? 'לעדכן תוצאת פגישה (יש דיווח מנהל/ת)' : 'לקבל דיווח מהמנהל/ת על הפגישה', owner: reported ? l.assignedTo : (l.meetingWith || l.assignedTo),
          due: l.visitDate, state: reported || reportOverdue(l, today) ? 'late' : 'wait', reason: 'תאריך הפגישה חלף לפני ' + daysBetween(l.visitDate, today) + ' ימים — קיום הביקור לא אומת' };
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
    return { kpi: kpi, rows: rows, leads: n.leads, patients: n.patients, discharges: n.discharges, outpatientSent: n.outpatientSent };
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
  function nextActionFor(l, today, fl) {
    if (reportUnseen(l)) return { text: 'דיווח מנהל/ת חדש', state: 'today' };
    const change = patientMeetingChange(l, fl);
    if (l.stage === 'visit' && s(l.meetingOutcome) === 'cancelled') return { text: change ? 'בוטלה ע״י המטופל/ת — לתאם מחדש' : 'הפגישה בוטלה — לתאם מחדש', state: 'late' };
    // The board/table must agree with Vered's Today: an existing manager
    // no-show report is NOT a missing report and has not proved attendance.
    if (l.stage === 'visit' && s(l.meetingReportedAt) && !s(l.meetingOutcome)) {
      return l.meetingReportOutcome === 'no_show'
        ? { text: 'לברר היעדרות / ביטול', state: 'wait' }
        : { text: 'להחליט אחרי דיווח מנהל/ת', state: 'wait' };
    }
    if (l.stage === 'visit' && l.visitDate && l.visitDate < today && !l.meetingOutcome) {
      return reportOverdue(l, today) ? { text: 'דיווח המנהל/ת באיחור', state: 'late' } : { text: 'ממתין לדיווח מנהל/ת', state: 'wait' };
    }
    const moved = change && change.change === 'rescheduled' ? ' · שונתה ע״י המטופל/ת' : '';
    if (l.stage === 'visit' && l.visitDate === today) return { text: 'פגישה היום' + moved, state: 'today' };
    if (l.stage === 'visit') return { text: l.visitDate ? 'פגישה ' + fmtDate(l.visitDate) + moved : 'לתאם פגישה', state: 'wait' };
    if (l.stage === 'new') return { text: 'ליצור קשר', state: 'wait' };   // never «late» by age (spec §1); «ללא מגע» is told by «היום שלי» / the triage
    if (l.stage === 'waitlist') return { text: waitReasonLabel(fl && fl.waitReason ? fl.waitReason.reason : ''), state: 'wait' };
    return { text: 'קליטה לבית', state: 'wait' };
  }

  /* ===== Vered's feedback 04/11/2026 (CHANGELOG-crm-vered-feedback-1104.md) =====
   * Lead flags live in Activity (Code.gs logLeadFlag_), served by contactIndex as
   * flags[leadId] = { waitReason?: { reason, at, actorName },
   *                   meetingChange?: { change, prevDate, prevTime, newDate, newTime, withWhom, note, at, actorName } }. */
  const WAIT_REASONS = [{ id: 'place', label: 'ממתין למקום' }, { id: 'funder', label: 'ממתין לאישור הקופה' }];
  /* The waitlist-reason chip text of a lead, or '' (not on the waitlist). Pure. */
  function waitChipText(l, fl) { return l && l.stage === 'waitlist' ? waitReasonLabel(fl && fl.waitReason ? fl.waitReason.reason : '') : ''; }
  /* '' / unknown → «ממתין למקום» (what every waitlist lead meant before this change). Pure. */
  function waitReasonLabel(id) { return s(id) === 'funder' ? 'ממתין לאישור הקופה' : 'ממתין למקום'; }
  function flagsOf(index, leadId) { return index && index.flags && typeof index.flags === 'object' && index.flags[s(leadId)] ? index.flags[s(leadId)] : null; }
  /* The patient-side change that still describes the lead's CURRENT meeting, or null:
   * a cancellation while meetingOutcome is still 'cancelled'; a reschedule while the
   * lead still carries that new date. An older event that no longer matches is history only. Pure. */
  function patientMeetingChange(l, fl) {
    const ch = fl && fl.meetingChange;
    if (!l || !ch) return null;
    if (ch.change === 'cancelled') return s(l.meetingOutcome) === 'cancelled' ? ch : null;
    if (ch.change === 'rescheduled') return s(ch.newDate) && s(ch.newDate) === s(l.visitDate) && !s(l.meetingOutcome) ? ch : null;
    return null;
  }
  /* A missing manager report is an exception only GRACE days after the meeting. Pure. */
  function reportOverdue(l, today) { return !!(l && l.visitDate && l.visitDate < today && daysBetween(l.visitDate, today) >= MANAGER_REPORT_GRACE_DAYS); }
  function meetingOutcomeLabel(id) { const o = MEETING_OUTCOMES.filter(function (x) { return x.id === s(id); })[0]; return o ? o.label : s(id); }
  /* The Hebrew WhatsApp text to the manager about a patient-side change. Pure. */
  function managerChangeMessage(l, ch) {
    const when = function (d, t) { return fmtDate(d) + (s(t) ? ' בשעה ' + s(t) : ''); };
    const head = 'עדכון פגישה — ' + s(l && l.name) + (houseName(l && l.house) ? ' (' + houseName(l.house) + ')' : '') + ': ';
    const note = s(ch && ch.note) ? '\nהערה: ' + s(ch.note) : '';
    if (ch && ch.change === 'cancelled') return head + 'הפגישה שנקבעה ל-' + when(ch.prevDate, ch.prevTime) + ' בוטלה ע״י המטופל/ת.' + note;
    return head + 'המטופל/ת שינה/תה את מועד הפגישה' + (s(ch && ch.prevDate) ? ' מ-' + when(ch.prevDate, ch.prevTime) : '') + ' ל-' + when(ch && ch.newDate, ch && ch.newTime) + '.' + note;
  }
  /* wa.me link to the manager's phone (digits only); no valid phone → the sender picks the chat. Pure. */
  function managerWaUrl(phone, text) {
    const digits = s(phone).replace(/\D/g, '');
    return 'https://wa.me/' + (/^\d{9,15}$/.test(digits) ? digits : '') + '?text=' + encodeURIComponent(s(text));
  }
  /* The logLeadFlag body. Pure. */
  function leadFlagBody(sid, flag) { return { action: 'logLeadFlag', submissionId: s(sid), flag: flag }; }
  /* A lost HTTP reply must not mint a SECOND operation for the same flag.
   * Keep the exact payload/id until source acknowledgement. Changed content
   * cannot silently reuse an uncertain id; full reload needs source check. */
  function leadFlagPendingPlan(previous, flag, mintId) {
    const signature = JSON.stringify(flag || {});
    if (previous) return previous.signature === signature
      ? { ok: true, pending: previous, retry: true }
      : { ok: false, error: 'unconfirmed_previous_flag' };
    return { ok: true, retry: false,
      pending: { signature: signature, body: leadFlagBody(mintId(), flag) } };
  }
  /* The patient-change form → { errors } or { errors: {}, patch, flag }. v = { change, newDate, newTime, note }. Pure. */
  function patientChangePlan(l, v, today) {
    const e = {};
    v = v || {};
    const change = s(v.change);
    if (change !== 'cancelled' && change !== 'rescheduled') e.change = 'בחרי: בוטלה או שונה מועד';
    if (change === 'rescheduled') {
      if (!isoDateOk(v.newDate) || v.newDate < today) e.newDate = 'תאריך חדש — מהיום והלאה';
      if (s(v.newTime) && !timeOk(v.newTime)) e.newTime = 'שעה HH:MM';
    }
    if (s(v.note).length > 200) e.note = 'עד 200 תווים';
    if (Object.keys(e).length) return { errors: e };
    const flag = { leadId: s(l.id), kind: 'meeting_patient_change', change: change, prevDate: s(l.visitDate), prevTime: s(l.visitTime), withWhom: s(l.meetingWith), note: s(v.note) };
    let patch;
    if (change === 'cancelled') patch = { meetingOutcome: 'cancelled' };
    else { patch = { visitDate: s(v.newDate), visitTime: s(v.newTime), meetingOutcome: '' }; flag.newDate = s(v.newDate); flag.newTime = s(v.newTime); }
    return { errors: {}, patch: patch, flag: flag };
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
  /* C15 (CHANGELOG-crm-calendar-picker.md): any day or week, past included.
   * Every lead with a visit date counts — whatever its stage today (an admitted
   * or closed lead still had its meeting), so a past day shows what happened. */
  const DAY_NAMES = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
  function weekdayOf(iso) { const ms = Date.parse(s(iso) + 'T00:00:00Z'); return isNaN(ms) ? -1 : new Date(ms).getUTCDay(); }
  function weekStart(iso) { const d = weekdayOf(iso); return d < 0 ? s(iso) : addDays(iso, -d); }
  function calendarRange(mode, anchor) {
    const a = isoDateOk(s(anchor).slice(0, 10)) ? s(anchor).slice(0, 10) : '';
    if (!a) return null;
    if (mode === 'week') { const from = weekStart(a); return { mode: 'week', from: from, to: addDays(from, 6) }; }
    return { mode: 'day', from: a, to: a };
  }
  function calendarRows(leads, range, today) {
    if (!range) return [];
    return (leads || []).filter(function (l) { return l.visitDate && l.visitDate >= range.from && l.visitDate <= range.to; })
      .sort(function (a, b) { return (a.visitDate + (a.visitTime || '')).localeCompare(b.visitDate + (b.visitTime || '')); })
      .map(function (l) {
        const past = l.visitDate < today, isToday = l.visitDate === today;
        const reported = !!s(l.meetingReportedAt);
        let status;
        if (s(l.meetingOutcome) === 'cancelled') status = { state: 'late', text: 'בוטלה' };
        else if (isToday) status = { state: 'today', text: 'היום' };
        else if (!past) status = { state: 'wait', text: 'מתוכנן' };
        else if (l.meetingOutcome) status = { state: 'ok', text: meetingOutcomeLabel(l.meetingOutcome) };
        else if (reported) status = { state: 'today', text: 'יש דיווח מנהל/ת' + (reportUnseen(l) ? ' · חדש' : '') };
        else status = { state: 'late', text: 'ללא תוצאה' };
        return { id: l.id, name: l.name, house: houseName(l.house), date: l.visitDate, time: l.visitTime || '', withWhom: l.meetingWith || l.assignedTo || '', stage: l.stage, status: status, reported: reported };
      });
  }
  /* «ביקור נקבע» leads with no date (CHANGELOG-undated-visit-leads.md): on no
   * calendar, on no board, in no managers' feed — listed by name so the date
   * gets entered. Pure. */
  function undatedVisits(leads) {
    return (leads || []).filter(function (l) { return l && l.stage === 'visit' && !l.visitDate; })
      .map(function (l) { return { id: l.id, name: l.name, house: houseName(l.house), withWhom: l.meetingWith || l.assignedTo || '', created: l.created }; })
      .sort(function (a, b) { return (a.created || '').localeCompare(b.created || '') || a.name.localeCompare(b.name, 'he'); });
  }
  function calendarTitle(range, today) {
    if (!range) return '';
    if (range.mode === 'day') return (range.from === today ? 'היום · ' : 'יום ' + DAY_NAMES[weekdayOf(range.from)] + ' · ') + fmtDate(range.from);
    return 'שבוע ' + fmtDate(range.from) + ' – ' + fmtDate(range.to);
  }

  /* «בקרה»: the action metrics of spec §10 — counts only. */
  function control(c, today) {
    const untouched = c.leads.filter(function (l) { return l.stage === 'new' && l.created && daysBetween(l.created, today) >= WAIT_DAYS; }).length;
    const noOutcome = c.leads.filter(function (l) { return l.stage === 'visit' && l.visitDate && l.visitDate < today && !l.meetingOutcome; }).length;
    const unscheduled = c.leads.filter(function (l) { return l.stage === 'visit' && !l.visitDate; }).length;
    const admitting = c.leads.filter(function (l) { return l.stage === 'paid'; }).length;
    return [
      { id: 'unseenReports', label: 'דיווחי מנהל/ת שלא נקראו', value: unseenReports(c.leads) },
      { id: 'untouched', label: 'לידים ללא טיפול (' + WAIT_DAYS + '+ ימים)', value: untouched },
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
        receivedDate: sheetDay(o.receivedDate), amount: Number(o.amount) || 0, method: s(o.method), payer: s(o.payer), funder: s(o.funder),
        confirmStatus: s(o.confirmStatus), cycleId: s(o.cycleId), reference: s(o.reference), status: s(o.status), dueDate: sheetDay(o.dueDate),
        coverageStart: sheetDay(o.coverageStart), coverageEnd: sheetDay(o.coverageEnd), invoiceWanted: s(o.invoiceWanted), invoiceTo: s(o.invoiceTo),
        flagNote: s(o.flagNote), recordedBy: s(o.recordedBy),
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

  /* «גבייה» search (CHANGELOG-billing-search-any-patient.md): the overview
   * narrowed to ONE name — the debtors with that name, the receipts with that
   * name, and the patients (any status, released included) whose name or house
   * matches, so a released patient with nothing owed is still FOUND and can be
   * opened on «חשבון». Name match: every typed word inside the name, order-free,
   * case-insensitive. Pure. */
  function billingSearch(b, q, patients) {
    const words = s(q).toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return null;
    const hit = function (name, house) {
      const t = (s(name) + ' ' + s(house)).toLowerCase();
      return words.every(function (w) { return t.indexOf(w) >= 0; });
    };
    const debtors = (b && Array.isArray(b.patients) ? b.patients : []).filter(function (p) { return hit(p.name, p.houseName); });
    const receipts = (b && Array.isArray(b.receipts) ? b.receipts : []).filter(function (r) { return hit(r.patientName, r.houseName); });
    const seen = {};
    debtors.forEach(function (p) { seen[p.id] = true; });
    const people = (Array.isArray(patients) ? patients : []).filter(function (p) { return p && hit(p.name, houseName(p.houseId)) && !seen[s(p.id)]; })
      .map(function (p) { return { id: s(p.id), name: s(p.name), houseName: houseName(p.houseId), status: s(p.status), date: s(p.date), exitDate: s(p.exitDate) }; })
      .sort(function (a, b2) { return a.name.localeCompare(b2.name, 'he'); });
    return { q: words.join(' '), debtors: debtors, receipts: receipts, people: people, total: debtors.length + receipts.length + people.length };
  }

  /* ---- «לגבייה בתאריך» in the CRM (CHANGELOG-crm-collect-on-date.md) ----
   * The classic גבייה daily list, inside the CRM: who starts a cycle on a
   * chosen date and what that cycle owes. The same rules as the classic list
   * and the server engine:
   *   - a cycle starts on the entry date + k months (month-end clamped, the
   *     Code.gs recCycleDueDates_ / stayCycles anchor);
   *   - never before entry; never ON or after the exit date (a patient who
   *     leaves on the billing day opens no new cycle —
   *     CHANGELOG-billing-exit-day-not-due.md); released with no exit date →
   *     not listed (the classic conservative reading);
   *   - pro-bono on the date → not owed, not listed;
   *   - the amount is lib/cycle-balance.js cycleState (override → agreed price
   *     → stamp, discount net, settled cycles stay settled) over the cycle's
   *     Payments row when there is one.
   * Pure: (getData answer, getPayments answer, 'YYYY-MM-DD', CycleBalance). */
  function cycleBalanceLib(win) {
    if (typeof module === 'object' && module && module.exports) { try { return require('../../lib/cycle-balance.js'); } catch (_) { /* browser bundle */ } }
    const g = win || (typeof window !== 'undefined' ? window : globalThis);
    return g.CycleBalance || null;
  }
  const FUNDER_UNSET_LABEL = 'לא הוגדר';
  const HEB_MONTHS = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];
  function monthsBetween(fromIso, toIso) {
    return (Number(toIso.slice(0, 4)) - Number(fromIso.slice(0, 4))) * 12 + (Number(toIso.slice(5, 7)) - Number(fromIso.slice(5, 7)));
  }
  /* A cycle window split by calendar month, the price allotted by days
   * (display only — the cycle owes ONE price; CHANGELOG-cycle-balance.md). */
  function monthSplit(start, end, amount) {
    const total = Math.round((Date.parse(end + 'T00:00:00Z') - Date.parse(start + 'T00:00:00Z')) / 86400000) + 1;
    if (!(total > 0)) return [];
    const out = [];
    let cur = start;
    while (cur <= end) {
      const y = Number(cur.slice(0, 4)), m = Number(cur.slice(5, 7));
      const monthEnd = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
      const to = monthEnd < end ? monthEnd : end;
      const days = Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(cur + 'T00:00:00Z')) / 86400000) + 1;
      out.push({ month: cur.slice(0, 7), days: days, amount: 0 });
      cur = new Date(Date.parse(to + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10);
    }
    let given = 0;
    out.forEach(function (x, i) {
      x.amount = i === out.length - 1 ? Math.round((amount - given) * 100) / 100 : Math.round(amount * x.days / total);
      given += x.amount;
    });
    return out;
  }
  function funderOnDay(funders, uid, key, day) {
    let best = null;
    (Array.isArray(funders) ? funders : []).forEach(function (f) {
      if (!rowIsPatient(f, uid, key)) return;
      const from = sheetDay(f.effectiveFrom);
      if (!from || from > day) return;
      if (!best || from >= best.from) best = { from: from, funder: s(f.funder) };
    });
    return best ? best.funder : '';
  }
  /* The shared reads of a cycle computation (getPayments + getData overrides). */
  function cycleCtx(payments, data, CB) {
    const p = payments && payments.ok !== false ? payments : null;
    const rules = reportRules();
    return { error: p ? '' : (s(payments && payments.error) || 'payments_missing'),
      cyclesAll: p && Array.isArray(p.payments) ? p.payments : [],
      funders: p && Array.isArray(p.funders) ? p.funders : [],
      overrides: data && Array.isArray(data.billingOverrides) ? data.billingOverrides : [],
      PROBONO: rules && rules.FUNDER_PROBONO ? rules.FUNDER_PROBONO : 'פרו-בונו',
      lib: CB || cycleBalanceLib() };
  }
  /* ONE cycle of a patient, the one that starts on `day` (= entry + k months):
   * its funder on the day, its Payments row, its open balance (cycleState).
   * → the row, or null when the day is pro-bono. The stay checks (entry,
   * exit, released) are the caller's. Pure. */
  function cycleOnDay(pt, day, k, ctx) {
    const entry = pt.date;
    const key = patientKeyOf(pt);
    const funder = funderOnDay(ctx.funders, pt.id, key, day);
    if (funder === ctx.PROBONO) return null;
    const row = ctx.cyclesAll.filter(function (r) { return rowIsPatient(r, pt.id, key) && sheetDay(r.dueDate) === day && s(r.status).toLowerCase() !== 'void'; })[0] || null;
    const month = day.slice(0, 7);
    const ovr = ctx.overrides.filter(function (o) { return o && s(o.patientId) === key && s(o.month) === month; })[0] || null;
    const ovrAmount = ovr && ovr.amount !== '' && ovr.amount !== null && ovr.amount !== undefined ? Number(ovr.amount) : null;
    const disc = ovr && Number(ovr.discountAmount) > 0 ? Number(ovr.discountAmount) : null;
    const stamped = row ? Number(row.amount) || 0 : pt.pay;
    const paidIn = row ? Number(row.amountPaid) || 0 : 0;
    const lib = ctx.lib;
    const st = lib ? lib.cycleState({ stampedAmount: stamped, amountPaid: paidIn, overrideAmount: ovrAmount, agreedPrice: pt.pay, status: row ? s(row.status) : 'unpaid', discountAmount: disc })
      : { expected: stamped, paid: paidIn, balance: Math.max(0, stamped - paidIn), status: paidIn <= 0 ? 'unpaid' : (paidIn >= stamped ? 'paid' : 'partial') };
    const w = cycleWindow(entry, k);
    const cs = row ? sheetDay(row.coverageStart) : '', ce = row ? sheetDay(row.coverageEnd) : '';
    const start = cs && ce && ce >= cs ? cs : w.start, end = cs && ce && ce >= cs ? ce : w.end;
    const cycle = row
      ? { id: s(row.id), patientId: s(row.patientId) || key, patientName: s(row.patientName) || pt.name, houseId: s(row.houseId) || s(houseId(pt.houseId)),
        dueDate: day, amount: stamped, coverageStart: start, coverageEnd: end }
      : { id: 'pay::' + key + '::' + day, patientId: key, patientName: pt.name, houseId: s(houseId(pt.houseId)), dueDate: day, amount: st.expected, coverageStart: start, coverageEnd: end };
    return { patientId: pt.id, name: pt.name, houseId: pt.houseId, houseName: houseName(pt.houseId), monthly: pt.pay, released: pt.status === 'released',
      start: start, end: end, split: monthSplit(start, end, st.expected), expected: st.expected, paid: st.paid, balance: st.balance, status: st.status,
      discount: st.discount || 0, funder: funder || FUNDER_UNSET_LABEL, recorded: !!row, cycle: cycle };
  }
  function dueOnDate(data, payments, dayIso, CB) {
    const day = s(dayIso);
    const out = { date: day, rows: [], count: 0, total: 0, collected: 0, error: '' };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) { out.error = 'bad_date'; return out; }
    const ctx = cycleCtx(payments, data, CB);
    if (ctx.error) out.error = ctx.error;
    normalise(data).patients.forEach(function (pt) {
      const entry = pt.date;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(entry) || entry > day) return;
      const exit = pt.exitDate;
      if (exit && exit <= day) return;
      if (pt.status === 'released' && !exit) return;
      const k = monthsBetween(entry, day);
      if (k < 0 || addMonthsIso(entry, k) !== day) return;
      const row = cycleOnDay(pt, day, k, ctx);
      if (row) out.rows.push(row);
    });
    out.rows.sort(function (a, b) { return (a.status === 'paid') - (b.status === 'paid') || a.houseName.localeCompare(b.houseName, 'he') || a.name.localeCompare(b.name, 'he'); });
    out.count = out.rows.length;
    out.total = Math.round(out.rows.reduce(function (t, r) { return t + r.expected; }, 0) * 100) / 100;
    out.collected = Math.round(out.rows.reduce(function (t, r) { return t + r.paid; }, 0) * 100) / 100;
    return out;
  }
  /* ---- «צפי תזרים» — the cash-flow forecast (CHANGELOG-cashflow-forecast.md) ----
   * What money the ACTIVE patients are expected to bring in a date range — no
   * past debt (Sandra, 08/11/2026: most old debts are unrecorded payments).
   *   - a cycle = the entry-anchored monthly cycle (the «לגבייה בתאריך» rule,
   *     cycleOnDay below); its amount = the OPEN balance of the cycle
   *     (cycleState: override → agreed price, minus discount, minus money
   *     already paid). A prepaid / discounted-to-zero cycle brings nothing.
   *   - private (and unset) money is expected ON the due date; only cycles due
   *     on or after today count — an older unpaid cycle is past debt.
   *   - institutional funders (ביטוח לאומי, מכבי, משרד הביטחון — the funder
   *     on the due date) pay «שוטף +30»: expected = due + FORECAST_TERMS_DAYS
   *     (= lib/funder-grace.js FUNDER_GRACE_DAYS, pinned by a test). A cycle
   *     whose expected date is still ahead counts even when it was due
   *     before today — it is within terms, not past debt.
   *   - released patients and pro-bono are never in the forecast; a patient
   *     with no funder on the due date is a separate «לא הוגדר» line, NOT in
   *     the total (a funder must be filled).
   * Pure: (getData answer, getPayments answer, from, to, today, CycleBalance). */
  const FORECAST_TERMS_DAYS = 30;
  const FORECAST_INSTITUTIONAL = ['ביטוח לאומי', 'מכבי', 'משרד הביטחון'];
  function monthEndIso(iso) {
    const y = Number(s(iso).slice(0, 4)), m = Number(s(iso).slice(5, 7));
    return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  }
  /* The range buttons: 'month' today → month end; 'next' next calendar month; '90' today → +90 days. Pure. */
  function forecastPreset(id, today) {
    if (id === 'next') { const first = addDays(monthEndIso(today), 1); return { from: first, to: monthEndIso(first) }; }
    if (id === '90') return { from: today, to: addDays(today, 90) };
    return { from: today, to: monthEndIso(today) };
  }
  function weekStartIso(iso) { const d = weekdayOf(iso); return d < 0 ? '' : addDays(iso, -d); }
  function cashForecast(data, payments, fromIso, toIso, todayIso, CB) {
    const today = s(todayIso);
    const out = { from: s(fromIso), to: s(toIso), today: today, rows: [], total: 0, count: 0,
      private: { count: 0, total: 0 }, institutional: { count: 0, total: 0 }, unset: { count: 0, total: 0 },
      byWeek: [], byHouse: [], error: '' };
    if (!isoDateOk(today) || !isoDateOk(out.from) || !isoDateOk(out.to)) { out.error = 'bad_date'; return out; }
    if (out.from < today) out.from = today;          // a forecast starts today
    if (out.to < out.from) { out.error = 'bad_range'; return out; }
    const ctx = cycleCtx(payments, data, CB);
    if (ctx.error) out.error = ctx.error;
    const earliestDue = addDays(out.from, -FORECAST_TERMS_DAYS);
    normalise(data).patients.forEach(function (pt) {
      if (pt.status === 'released') return;
      const entry = pt.date;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(entry)) return;
      const exit = pt.exitDate;
      for (let k = 0; k < 600; k++) {
        const due = addMonthsIso(entry, k);
        if (due > out.to) break;
        if (exit && due >= exit) break;
        if (due < earliestDue) continue;
        const row = cycleOnDay(pt, due, k, ctx);
        if (!row || !(row.balance > 0)) continue;
        const inst = FORECAST_INSTITUTIONAL.indexOf(row.funder) >= 0;
        const expectedDate = inst ? addDays(due, FORECAST_TERMS_DAYS) : due;
        if (expectedDate < out.from || expectedDate > out.to) continue;
        const kind = inst ? 'institutional' : row.funder === FUNDER_UNSET_LABEL ? 'unset' : 'private';
        out.rows.push({ patientId: row.patientId, name: row.name, houseId: row.houseId, houseName: row.houseName, funder: row.funder,
          kind: kind, dueDate: due, expectedDate: expectedDate, start: row.start, end: row.end, amount: row.balance, expected: row.expected, paid: row.paid });
      }
    });
    out.rows.sort(function (a, b) { return a.expectedDate < b.expectedDate ? -1 : a.expectedDate > b.expectedDate ? 1 : a.name.localeCompare(b.name, 'he'); });
    const r2 = function (n) { return Math.round(n * 100) / 100; };
    const weeks = {}, houses = {};
    out.rows.forEach(function (r) {
      out[r.kind].count++; out[r.kind].total = r2(out[r.kind].total + r.amount);
      if (r.kind === 'unset') return;
      const w = weekStartIso(r.expectedDate);
      const wk = weeks[w] || (weeks[w] = { weekStart: w, private: 0, institutional: 0, total: 0 });
      wk[r.kind] = r2(wk[r.kind] + r.amount); wk.total = r2(wk.total + r.amount);
      const h = houses[r.houseName] || (houses[r.houseName] = { name: r.houseName, private: 0, institutional: 0, total: 0 });
      h[r.kind] = r2(h[r.kind] + r.amount); h.total = r2(h.total + r.amount);
    });
    out.total = r2(out.private.total + out.institutional.total);
    out.count = out.private.count + out.institutional.count;
    out.byWeek = Object.keys(weeks).sort().map(function (k) { return weeks[k]; });
    out.byHouse = Object.keys(houses).map(function (k) { return houses[k]; }).sort(function (a, b) { return b.total - a.total; });
    return out;
  }
  /* ---- «ניקוי חובות היסטוריים» (CHANGELOG-historical-debt-cleanup.md) ----
   * Released patients' open cycles that are NOT real debt (Sandra, 08/11/2026:
   * most of them are payments that were never recorded in the app). A
   * finance user ticks cycles, picks WHY, types a note, and every ticked
   * cycle is closed by a discount for its whole open balance — the existing
   * setBillingDiscount action, one call per patient + month, audited by the
   * server. A discount is not revenue and not debt: money that DID arrive
   * and can be identified should be reported with «דווח תשלום» instead.
   * A real write-off (money that will never come) is NOT offered here: it
   * stays Sandra's own flow, so this tool cannot be used to dress one up.
   * Pure helpers; the UI is in the shell below. */
  const CLEANUP_REASONS = [
    { id: 'paid_unrecorded', label: 'שולם — לא נרשם באפליקציה' },
    { id: 'not_charged', label: 'לא חויב בפועל / טעות רישום' },
  ];
  const CLEANUP_PREFIX = 'ניקוי חוב היסטורי';
  /* The candidates: open cycles of patients who are NOT in a house today
   * (released / discharged), from debtAging.byPatient. → rows sorted by name. */
  function cleanupCandidates(debt) {
    const d = debt && debt.ok !== false ? debt : null;
    const out = [];
    (d && Array.isArray(d.byPatient) ? d.byPatient : []).forEach(function (p) {
      if (!p || p.inHouseAtAsOf === true || s(p.status) !== 'released') return;
      const key = s(p.patientKey);
      if (!key) return;
      (Array.isArray(p.cycles) ? p.cycles : []).forEach(function (c) {
        const bal = Math.round((Number(c.balance) || 0) * 100) / 100;
        const month = s(c.month) || s(c.start).slice(0, 7);
        if (!(bal > 0) || !monthOk(month)) return;
        out.push({ id: key + '|' + s(c.start), patientId: s(p.patientId), patientKey: key, name: s(p.name), houseId: s(p.houseId), houseName: houseName(p.houseId),
          start: sheetDay(c.start), end: sheetDay(c.end), month: month, balance: bal, expected: Number(c.expected) || 0, received: Number(c.received) || 0,
          discount: Number(c.discount) || 0, days: Number(c.days) || 0, kind: s(c.kind) });
      });
    });
    out.sort(function (a, b) { return a.name.localeCompare(b.name, 'he') || (a.start < b.start ? -1 : a.start > b.start ? 1 : 0); });
    return out;
  }
  /* The ticked cycles → one discount write per patient + month (setBillingDiscount
   * keeps ONE value per month: existing discount + every ticked balance in it).
   * → { ok:true, writes:[{patientKey, month, discountTotal, cycles, amount}], total } | { ok:false, errors }. Pure. */
  function cleanupPlan(rows, reasonId, note) {
    const errors = {};
    const reason = CLEANUP_REASONS.filter(function (r) { return r.id === reasonId; })[0];
    if (!reason) errors.reason = 'יש לבחור סיבה';
    const n = s(note);
    const text = reason ? CLEANUP_PREFIX + ' · ' + reason.label + (n ? ' · ' + n : '') : '';
    if (n.length > 60) errors.note = 'הערה — עד 60 תווים';
    if (reason && (text.length < 2 || text.length > 120)) errors.note = 'הסיבה ארוכה מדי';
    if (!Array.isArray(rows) || !rows.length) errors._form = 'לא נבחרו מחזורים';
    if (Object.keys(errors).length) return { ok: false, errors: errors };
    const groups = {};
    rows.forEach(function (r) {
      const k = r.patientKey + '|' + r.month;
      const g = groups[k] || (groups[k] = { patientKey: r.patientKey, name: r.name, month: r.month, existing: 0, amount: 0, cycles: 0 });
      g.existing = Math.max(g.existing, Math.round((Number(r.discount) || 0) * 100) / 100);
      g.amount = Math.round((g.amount + r.balance) * 100) / 100;
      g.cycles++;
    });
    const writes = Object.keys(groups).sort().map(function (k) {
      const g = groups[k];
      return { patientKey: g.patientKey, name: g.name, month: g.month, cycles: g.cycles, amount: g.amount, discountTotal: Math.round((g.existing + g.amount) * 100) / 100 };
    });
    const bad = writes.filter(function (w) { return w.discountTotal > 1000000; });
    if (bad.length) return { ok: false, errors: { _form: 'סכום גבוה מדי למחזור של ' + bad[0].name } };
    return { ok: true, writes: writes, reasonText: text, total: Math.round(writes.reduce(function (t, w) { return t + w.amount; }, 0) * 100) / 100,
      cycles: rows.length };
  }
  function cleanupBody(write, reasonText) {
    return { action: 'setBillingDiscount', discount: { patientId: s(write.patientKey), month: s(write.month), discountAmount: write.discountTotal, discountReason: s(reasonText) } };
  }
  /* The date list after the funder filter ('' = all) and the name search. Pure. */
  function filterDueRows(due, funder, q) {
    const words = s(q).toLowerCase().split(/\s+/).filter(Boolean);
    const rows = (due && due.rows || []).filter(function (r) {
      if (funder && r.funder !== funder) return false;
      const hay = (r.name + ' ' + r.houseName).toLowerCase();
      return words.every(function (w) { return hay.indexOf(w) >= 0; });
    });
    return { rows: rows, count: rows.length,
      total: Math.round(rows.reduce(function (t, r) { return t + r.expected; }, 0) * 100) / 100,
      collected: Math.round(rows.reduce(function (t, r) { return t + r.paid; }, 0) * 100) / 100 };
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
      return { start: sheetDay(c.start), end: sheetDay(c.end), expected: Number(c.expected) || 0, received: Number(c.received) || 0, balance: Number(c.balance) || 0,
        days: Number(c.days) || 0, kind: s(c.kind), grace: !!c.funderGrace, discount: Number(c.discount) || 0, paymentId: s(c.paymentId), month: s(c.month) };
    });
    const openTotal = Math.round(open.reduce(function (t, c) { return t + c.balance; }, 0) * 100) / 100;
    const cycles = (p && Array.isArray(p.payments) ? p.payments : []).filter(function (x) { return rowIsPatient(x, id, key); }).map(function (x) {
      return { id: s(x.id), dueDate: sheetDay(x.dueDate), amount: Number(x.amount) || 0, amountPaid: Number(x.amountPaid) || 0, balance: Number(x.balance) || 0, status: s(x.status),
        coverageStart: sheetDay(x.coverageStart), coverageEnd: sheetDay(x.coverageEnd), patientId: s(x.patientId), patientName: s(x.patientName), houseId: s(x.houseId) };
    }).sort(function (a, b) { return a.dueDate < b.dueDate ? 1 : a.dueDate > b.dueDate ? -1 : 0; });
    const receipts = receiptsOf(p).filter(function (r) { return rowIsPatient(r, id, key); }).sort(function (a, b) { return a.receivedDate < b.receivedDate ? 1 : a.receivedDate > b.receivedDate ? -1 : 0; });
    const receivedTotal = Math.round(receipts.reduce(function (t, r) { return t + r.amount; }, 0) * 100) / 100;
    const funders = (p && Array.isArray(p.funders) ? p.funders : []).filter(function (f) { return rowIsPatient(f, id, key); }).map(function (f) {
      return { funder: s(f.funder), effectiveFrom: sheetDay(f.effectiveFrom), setBy: s(f.setBy) };
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
      const amount = Number(o.amount) || 0;
      const requestedAt = s(o.payoutApprovalRequestedAt), approvedAt = s(o.payoutApprovedAt);
      const requestedBy = s(o.payoutApprovalRequestedBy), approvedBy = s(o.payoutApprovedBy);
      const approvedAmount = o.payoutApprovalAmount === '' || o.payoutApprovalAmount == null ? null : Number(o.payoutApprovalAmount);
      const requestCurrent = s(o.status) === 'pending' && requestedBy === 'vered' && !!requestedAt
        && approvedAmount !== null && Number.isFinite(approvedAmount) && approvedAmount === amount;
      const approvalValid = requestCurrent && approvedBy === 'sandra' && !!approvedAt && approvedAt >= requestedAt;
      return { id: s(o.id), patientId: s(o.patientId), patientKey: s(o.patientKey), patientName: s(o.patientName), houseId: s(o.houseId), houseName: houseName(o.houseId),
        creditType: s(o.creditType), allocationMonth: (sheetDay(o.allocationMonth) || s(o.allocationMonth)).slice(0, 7), amount: amount, status: s(o.status), reason: s(o.reason),
        decidedDate: sheetDay(o.decidedDate), payoutDate: sheetDay(o.payoutDate), paidDate: sheetDay(o.paidDate), method: s(o.method),
        payoutApprovalRequestedAt: requestedAt, payoutApprovalRequestedBy: requestedBy, payoutApprovalAmount: approvedAmount,
        payoutApprovedAt: approvedAt, payoutApprovedBy: approvedBy, payoutRequestCurrent: !!requestCurrent,
        payoutApprovalValid: !!approvalValid };
    });
  }
  function creditIsPatient(c, uid, key) { return (uid && c.patientId === uid) || (!!key && (c.patientKey === key || c.patientId === key)); }
  function patientCredits(patient, credits) {
    const pat = patient && typeof patient === 'object' ? patient : { id: patient };
    const uid = s(pat.id), key = pat.name ? patientKeyOf(pat) : '';
    return creditsOf(credits).filter(function (c) { return creditIsPatient(c, uid, key); })
      .sort(function (a, b) { return a.allocationMonth < b.allocationMonth ? 1 : a.allocationMonth > b.allocationMonth ? -1 : 0; });
  }
  /* Source-backed, three-person payout workflow: UI is a convenience only.
   * Express and Code.gs independently enforce verified personal IDs and
   * approve the exact stored amount. A computed policy amount is NOT approval. */
  function refundActionFor(credit, me) {
    if (!credit || credit.status !== 'pending' || !(credit.amount > 0) || !credit.id || !me) return '';
    if (me.user === 'ורד' && me.finance === true)
      return credit.payoutRequestCurrent ? '' : 'request';
    if (me.user === 'סנדרה' && me.approver === true)
      return credit.payoutRequestCurrent && !credit.payoutApprovalValid ? 'approve' : '';
    if (me.user === 'אורטל' && me.view === 'controller')
      return credit.payoutApprovalValid ? 'settle' : '';
    return '';
  }
  function refundStageText(credit) {
    if (credit.payoutApprovalValid) return 'אושר על ידי סנדרה — לביצוע אורטל';
    if (credit.payoutRequestCurrent) return 'הועבר לאישור סנדרה';
    return 'נדרשת בקשת אישור של ורד';
  }
  const REFUND_ACTION_LABELS = { request: 'בקשי אישור מסנדרה', approve: 'אשרי תשלום לאורטל', settle: 'סמני כשולם' };
  function refundActionButton(credit, me) {
    const kind = refundActionFor(credit, me);
    return kind ? '<button type="button" class="btn small' + (kind === 'settle' ? ' primary' : '') +
      '" data-refund-action="' + kind + '" data-refund-id="' + esc(credit.id) + '">' + esc(REFUND_ACTION_LABELS[kind]) + '</button>' : '';
  }


  /* ===== Manual credits / credit edit in the CRM (CHANGELOG-crm-manual-credits.md) =====
   * The classic credits modal's two writes, through the SAME `saveCredit` action:
   *   - edit a saved, unpaid credit: amount (+ reason when it differs from the policy
   *     figure), decision date, status pending ↔ cancelled, notes;
   *   - a manual «אחר» credit (Sandra only).
   * Code.gs upsertCredit_ stays the authority: it recalculates the policy figure,
   * refuses an amount change / a manual credit without Sandra's approver session
   * (override_requires_approver), refuses 'paid' (settleRefund only), refuses a
   * stale edit (updatedAt → conflict); Express gates cancel (deleter) and manual
   * create (approver) by role. The raw getCredits row is the base of an edit. Pure. */
  function creditRaw(credits, id) {
    const c = credits && credits.ok !== false ? credits : {};
    return (Array.isArray(c.credits) ? c.credits : []).filter(function (r) { return r && s(r.id) === s(id); })[0] || null;
  }
  function creditEditErrors(raw, v) {
    const out = {};
    const amount = moneyParse(v && v.amount);
    if (amount === null) out.amount = 'סכום לא תקין';
    const calc = Number(raw && raw.calculatedAmount);
    if (amount !== null && isFinite(calc) && Math.round(amount * 100) !== Math.round(calc * 100) && s(v && v.overrideReason).length < 2) out.overrideReason = 'הסכום שונה מהמחושב — יש לנמק';
    if (s(v && v.decidedDate) && !isoDateOk(v.decidedDate)) out.decidedDate = 'תאריך לא תקין';
    if (['pending', 'cancelled'].indexOf(s(v && v.status)) < 0) out.status = 'סטטוס לא תקין';
    if (s(v && v.status) === 'cancelled' && s(v && v.notes).length < 2) out.notes = 'ביטול זיכוי דורש הערה';
    if (s(raw && raw.status) === 'paid') out._form = 'זיכוי ששולם נעול לעריכה';
    return out;
  }
  function creditEditBody(raw, v) {
    const r = raw || {};
    const amount = moneyParse(v.amount);
    const calc = Number(r.calculatedAmount);
    return { action: 'saveCredit', credit: { id: s(r.id), updatedAt: s(r.updatedAt), patientId: s(r.patientId), patientKey: s(r.patientKey), patientName: s(r.patientName),
      houseId: s(r.houseId), creditType: s(r.creditType), allocationMonth: s(r.allocationMonth).slice(0, 7), calculatedAmount: isFinite(calc) ? calc : 0, amount: amount,
      overrideReason: isFinite(calc) && Math.round(amount * 100) !== Math.round(calc * 100) ? s(v.overrideReason) : '', reason: s(r.reason),
      decidedDate: s(v.decidedDate), status: s(v.status), notes: s(v.notes) } };
  }
  function creditNewErrors(v) {
    const out = {};
    if (!monthOk(v && v.allocationMonth)) out.allocationMonth = 'חודש חסר או לא תקין';
    if (!(moneyParse(v && v.amount) > 0)) out.amount = 'יש להזין סכום גדול מ-0';
    if (s(v && v.reason).length < 2) out.reason = 'זיכוי ידני דורש סיבה';
    return out;
  }
  function creditNewBody(patient, v, today) {
    const p = patient || {};
    return { action: 'saveCredit', credit: { id: '', patientId: s(p.id), patientKey: patientKeyOf(p), patientName: s(p.name), houseId: houseId(p.houseId) || s(p.houseId),
      creditType: 'other', allocationMonth: s(v.allocationMonth), calculatedAmount: 0, amount: moneyParse(v.amount), overrideReason: s(v.reason), reason: s(v.reason),
      approvedBy: '', decidedDate: s(today), status: 'pending', paidDate: '', method: '', notes: s(v.notes), basis: {} } };
  }
  function creditSaveRefusal(res, wantId) {
    const r = res || {};
    if (r.ok === true && r.credit && s(r.credit.id) && (!wantId || s(r.credit.id) === s(wantId))) return '';
    if (r.ok === true) return 'השינוי לא אושר על ידי השרת — רענני';
    if (r.error === 'conflict') return 'הזיכוי עודכן בינתיים על ידי משתמש/ת אחר/ת — רענני ונסי שוב';
    if (r.error === 'override_requires_approver') return 'שינוי סכום / זיכוי ידני — באישור סנדרה בלבד';
    if (r.error === 'override_reason_required') return 'הסכום שונה מהמחושב — יש לנמק';
    if (r.error === 'use_settleRefund' || r.error === 'paid_locked') return 'סימון כשולם נעשה רק דרך תהליך ההחזר (אורטל)';
    if (r.error === 'zero_amount_credit') return 'זיכוי בסכום 0 אינו נשמר';
    return writeRefusal(r, 'credit');
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
  /* «שולם עם הנחה» (CHANGELOG-paid-with-discount.md): the payment report and
   * the discount for the rest of the cycle, in ONE form. Offered only on an
   * OPEN cycle (the debt list / «לגבייה בתאריך»), whose `remaining` is already
   * net of the month's existing discount (cycleState). The discount written is
   * the month's TOTAL — existing + the new gap — because setBillingDiscount
   * replaces the month's value. Pure.
   * → { ok:true, amount, gap, month, discountTotal } | { ok:false, errors:{field: message} } */
  function paidWithDiscountPlan(amountText, remaining, ctx, reason) {
    const errors = {};
    const amount = moneyParse(amountText);
    const rem = Math.round((Number(remaining) || 0) * 100) / 100;
    const c = ctx || {};
    const month = s(c.month);
    const existing = Math.round((Number(c.discount) || 0) * 100) / 100;
    if (!monthOk(month)) errors._form = 'לא ניתן לתת הנחה למחזור הזה — דווחי את התשלום ואז «הנחה»';
    if (amount === null || !(amount > 0)) errors.amount = 'בתשלום עם הנחה יש להזין את הסכום שהתקבל בפועל';
    else if (!(amount < rem)) errors.amount = 'הסכום שהתקבל אינו נמוך מהיתרה (' + rem + ') — אין יתרה להנחה';
    const r = s(reason);
    if (r.length < 2 || r.length > 120) errors.discountReason = 'בהנחה חובה לפרט סיבה (2 עד 120 תווים)';
    if (Object.keys(errors).length) return { ok: false, errors: errors };
    const gap = Math.round((rem - amount) * 100) / 100;
    const discountTotal = Math.round((existing + gap) * 100) / 100;
    if (discountTotal > 1000000) return { ok: false, errors: { amount: 'סכום ההנחה גבוה מדי' } };
    return { ok: true, amount: amount, gap: gap, month: month, discountTotal: discountTotal };
  }
  /* The setBillingDiscount body of a plan: the month's total, the reason as typed. */
  function paidWithDiscountBody(patient, plan, reason) {
    return discountBody(patient, plan.month, String(plan.discountTotal), reason);
  }
  /* The report fields only — the discount fields never reach reportPayment. */
  function reportValuesOnly(vals) {
    const out = {};
    Object.keys(vals || {}).forEach(function (k) { if (k !== 'withDiscount' && k !== 'discountReason') out[k] = vals[k]; });
    return out;
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

  /* ---- C18: «שיוך תשלומים» (CHANGELOG-crm-payment-linking.md) ----
   * The detached rows come from debtAging (detachedPayments.rows, reason
   * 'unmatched': no current patient, no decision). A decision is the classic
   * savePayment of the row with its link fields — 'linked' + the patient's uid,
   * or 'not_a_patient' + a reason. The row itself (money, dates) is re-sent as
   * read from getPayments; the server stamps linkedBy / linkedAt. */
  function normName(v) { return s(v).replace(/[‎‏‪-‮﻿ ]/g, ' ').replace(/\s+/g, ' ').trim(); }
  function namesLookAlike(a, b) {
    const x = normName(a), y = normName(b);
    if (!x || !y) return false;
    if (x === y || x.indexOf(y) === 0 || y.indexOf(x) === 0) return true;
    const xw = x.split(' ').filter(Boolean), yw = y.split(' ').filter(Boolean);
    return xw.some(function (w) { return w.length > 1 && yw.indexOf(w) >= 0; });
  }
  function detachedRows(debt) {
    const d = debt && debt.ok !== false ? debt : null;
    const rows = d && d.detachedPayments && Array.isArray(d.detachedPayments.rows) ? d.detachedPayments.rows : [];
    return rows.filter(function (r) { return s(r.reason) !== 'not_a_patient'; }).map(function (r) {
      return { paymentId: s(r.paymentId), patientName: s(r.patientName), houseId: s(r.houseId), houseName: houseName(r.houseId), dueDate: sheetDay(r.dueDate),
        amount: Number(r.amount) || 0, received: Number(r.receivedByAsOf) || 0, reason: s(r.reason) };
    }).sort(function (a, b) { return b.dueDate.localeCompare(a.dueDate) || a.patientName.localeCompare(b.patientName, 'he'); });
  }
  /* Candidates for one detached row: the house's patients (released included) first, then
   * the rest; look-alike names first within each group. Each carries its reasons. */
  function linkCandidates(row, patients) {
    const hid = houseId(row.houseId);
    return (patients || []).map(function (p) {
      const reasons = [];
      if (houseId(p.houseId) === hid) reasons.push('אותו בית');
      if (namesLookAlike(p.name, row.patientName)) reasons.push('שם דומה');
      if (p.date && row.dueDate && p.date <= row.dueDate) reasons.push('נכנס/ה לפני התשלום');
      return { id: p.id, name: p.name, houseName: houseName(p.houseId), date: p.date, status: p.status, reasons: reasons,
        score: (houseId(p.houseId) === hid ? 2 : 0) + (namesLookAlike(p.name, row.patientName) ? 4 : 0) + (p.status !== 'released' ? 1 : 0) };
    }).sort(function (a, b) { return b.score - a.score || a.name.localeCompare(b.name, 'he'); });
  }
  function linkBody(rawRow, patientId) {
    return { action: 'savePayment', payment: Object.assign({}, rawRow, { linkPatientUid: s(patientId), linkStatus: 'linked', linkNote: '' }) };
  }
  function notPatientBody(rawRow, note) {
    return { action: 'savePayment', payment: Object.assign({}, rawRow, { linkPatientUid: '', linkStatus: 'not_a_patient', linkNote: s(note).slice(0, 120) }) };
  }
  function linkErrors(kind, v) {
    const e = {};
    if (kind === 'link' && !s(v.patientId)) e.patientId = 'יש לבחור מטופל/ת';
    if (kind === 'not' && (s(v.note).length < 2 || s(v.note).length > 120)) e.note = 'יש לציין סיבה (2 עד 120 תווים)';
    return e;
  }
  function linkAccepted(res, id, status) {
    const r = res || {};
    return r.ok === true && !!r.payment && s(r.payment.id) === s(id) && s(r.payment.linkStatus) === status;
  }

  const esc = function (v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };

  /* ================= DOM ================= */

  /* ---- Stage 1c: tasks + the contact log (CHANGELOG-crm-contact-panel.md) ----
   * Over the Stage 1a actions (Code.gs Tasks sheet, CONTACT_OUTCOMES,
   * logContact). Pure: a task row as the server returns it; `today` is the
   * Asia/Jerusalem day. */
  const CONTACT_OUTCOMES = [
    { id: 'spoke_follow_up', label: 'התקיימה שיחה ונדרש המשך' }, { id: 'no_answer', label: 'לא היה מענה' },
    { id: 'call_back_later', label: 'התבקשנו לחזור במועד' }, { id: 'awaiting_decision', label: 'ממתינים להחלטה או למידע' },
    { id: 'meeting_set', label: 'נקבעה פגישה' }, { id: 'no_interest_now', label: 'אין עניין כרגע' },
    { id: 'bad_contact_details', label: 'פרטי הקשר אינם תקינים' }, { id: 'stop_contact', label: 'התבקשה הפסקת פניות' }];
  const CONTACT_CHANNELS = [{ id: 'phone', label: 'טלפון' }, { id: 'whatsapp', label: 'וואטסאפ' }, { id: 'sms', label: 'SMS' }, { id: 'email', label: 'דוא״ל' }, { id: 'in_person', label: 'פנים אל פנים' }, { id: 'other', label: 'אחר' }];
  /* «קשר הבא»: no automatic default — the user picks (spec §8). */
  const NEXT_CHOICES = [{ id: 'd1', label: 'מחר', days: 1 }, { id: 'd3', label: 'בעוד 3 ימים', days: 3 }, { id: 'd7', label: 'בעוד שבוע', days: 7 }, { id: 'd14', label: 'בעוד שבועיים', days: 14 },
    { id: 'd30', label: 'בעוד חודש', days: 30 }, { id: 'days', label: 'בעוד X ימים' }, { id: 'date', label: 'תאריך ושעה' }, { id: 'week', label: 'במהלך שבוע נבחר' }, { id: 'none', label: 'ללא משימת המשך' }];
  const TASK_KINDS = [{ id: 'call', label: 'שיחה' }, { id: 'meeting', label: 'פגישה' }, { id: 'collection', label: 'גבייה', money: true }, { id: 'admission', label: 'קליטה' },
    { id: 'discharge', label: 'שחרור' }, { id: 'continuity', label: 'המשך טיפול' }, { id: 'review', label: 'בירור' }, { id: 'other', label: 'אחר' }];
  const TASK_KIND_LABELS = {}; TASK_KINDS.forEach(function (k) { TASK_KIND_LABELS[k.id] = k.label; });
  function contactOutcomeLabel(id) { const o = CONTACT_OUTCOMES.filter(function (x) { return x.id === id; })[0]; return o ? o.label : s(id); }
  function timeOk(v) { return /^([01]\d|2[0-3]):[0-5]\d$/.test(s(v)); }
  /* The follow-up the form describes. choice ∈ NEXT_CHOICES; v = { days, date, time, weekStart, explanation }.
   * → { none, explanation } | { dueDate, dueTime } | { windowStart, windowEnd }, always with `text` (the actual date shown). */
  function nextPlan(choice, v, today) {
    const c = NEXT_CHOICES.filter(function (x) { return x.id === choice; })[0];
    if (!c) return null;
    v = v || {};
    if (c.days) { const d = addDays(today, c.days); return { dueDate: d, dueTime: '', text: c.label + ' — ' + fmtDate(d) + ' (' + DAY_NAMES[weekdayOf(d)] + ')' }; }
    if (c.id === 'days') { const n = Number(v.days); if (!(n >= 1 && n <= 365 && n === Math.floor(n))) return null; const d = addDays(today, n); return { dueDate: d, dueTime: '', text: 'בעוד ' + n + ' ימים — ' + fmtDate(d) + ' (' + DAY_NAMES[weekdayOf(d)] + ')' }; }
    if (c.id === 'date') { if (!isoDateOk(v.date) || v.date < today) return null; const t = s(v.time); if (t && !timeOk(t)) return null; return { dueDate: v.date, dueTime: t, text: fmtDate(v.date) + (t ? ' ' + t : '') + ' (' + DAY_NAMES[weekdayOf(v.date)] + ')' }; }
    if (c.id === 'week') { if (!isoDateOk(v.weekStart)) return null; const ws = weekStart(v.weekStart), we = addDays(ws, 6); if (we < today) return null; return { windowStart: ws, windowEnd: we, text: 'במהלך השבוע ' + fmtDate(ws) + ' – ' + fmtDate(we) }; }
    const ex = s(v.explanation);
    return ex.length >= 2 ? { none: true, explanation: ex, text: 'ללא משימת המשך — ' + ex } : null;
  }
  /* The contact form → errors by field. v = { when, time, withWhom, channel, reason, outcome, summary, next, nextDays, nextDate, nextTime, nextWeek, nextExplanation }. */
  function contactErrors(v, today) {
    const e = {};
    v = v || {};
    if (!isoDateOk(v.when) || v.when > today) e.when = 'תאריך השיחה — היום או קודם';
    if (s(v.time) && !timeOk(v.time)) e.time = 'שעה בפורמט HH:MM';
    if (!CONTACT_CHANNELS.some(function (c) { return c.id === v.channel; })) e.channel = 'בחרי ערוץ';
    if (!CONTACT_OUTCOMES.some(function (o) { return o.id === v.outcome; })) e.outcome = 'בחרי תוצאה';
    if (s(v.summary).length > 1000) e.summary = 'עד 1000 תווים';
    if (s(v.withWhom).length > 80) e.withWhom = 'עד 80 תווים';
    if (!v.next) e.next = 'בחרי מה הלאה — אין ברירת מחדל';
    else if (!nextPlan(v.next, { days: v.nextDays, date: v.nextDate, time: v.nextTime, weekStart: v.nextWeek, explanation: v.nextExplanation }, today)) {
      e.next = v.next === 'none' ? 'ללא משימת המשך — חובה להסביר (2 תווים לפחות)' : v.next === 'days' ? 'מספר ימים בין 1 ל-365' : v.next === 'week' ? 'בחרי שבוע (מהיום והלאה)' : 'תאריך מהיום והלאה';
    }
    return e;
  }
  /* The logContact body (Stage 1a contract). subject = { leadId } | { patientId }. */
  function contactBody(subject, v, sid, taskId, today, assignee) {
    const plan = nextPlan(v.next, { days: v.nextDays, date: v.nextDate, time: v.nextTime, weekStart: v.nextWeek, explanation: v.nextExplanation }, today);
    // local wall-clock → the UTC instant the Activity sheet stores (no time → noon, so the day never shifts)
    const at = new Date(s(v.when) + 'T' + (timeOk(v.time) ? s(v.time) : '12:00') + ':00');
    const contact = Object.assign({}, subject, { occurredAt: isNaN(at.getTime()) ? '' : at.toISOString(), withWhom: s(v.withWhom), channel: s(v.channel), reason: s(v.reason), outcome: s(v.outcome), summary: s(v.summary) });
    if (taskId) contact.taskId = taskId;
    const next = plan.none ? { none: true, explanation: plan.explanation } : plan.windowStart ? { windowStart: plan.windowStart, windowEnd: plan.windowEnd } : { dueDate: plan.dueDate, dueTime: plan.dueTime || '' };
    if (!next.none) { next.title = s(v.nextTitle) || ('לחזור — ' + contactOutcomeLabel(v.outcome)); if (s(assignee)) next.assignee = s(assignee); if (s(v.summary)) next.reason = s(v.summary).slice(0, 300); }
    return { action: 'logContact', submissionId: sid, contact: contact, next: next };
  }
  /* The answer → '' (accepted) or the Hebrew reason. The event must be echoed; a saved contact is never assumed. */
  function contactAccepted(res) {
    const r = res || {};
    if (r.ok === true && r.event && s(r.event.eventId)) return '';
    return writeRefusal(r, 'event');
  }
  /* ---- the task list ---- */
  function taskDue(t) { return s(t && t.dueDate) || s(t && t.windowEnd) || ''; }
  function taskState(t, today) {
    if (!t) return 'undated';
    if (s(t.windowStart)) return s(t.windowEnd) < today ? 'late' : (s(t.windowStart) <= today ? 'today' : 'wait');
    const d = s(t.dueDate);
    if (!d) return 'undated';
    return d < today ? 'late' : d === today ? 'today' : 'wait';
  }
  function taskWhen(t) {
    if (!t) return '';
    if (s(t.windowStart)) return 'במהלך ' + fmtDate(t.windowStart) + ' – ' + fmtDate(t.windowEnd);
    return s(t.dueDate) ? fmtDate(t.dueDate) + (s(t.dueTime) ? ' ' + s(t.dueTime) : '') : 'ללא תאריך — קבעי תאריך';
  }
  function taskSubject(t, c) {
    const lead = c && s(t.leadId) ? c.leads.filter(function (l) { return l.id === s(t.leadId); })[0] : null;
    const pat = c && !lead && s(t.patientId) ? c.patients.filter(function (p) { return p.id === s(t.patientId); })[0] : null;
    if (lead) return { kind: 'lead', id: lead.id, name: lead.name, house: houseName(lead.house), phone: lead.phone, contact: lead.contactName ? lead.contactName + (lead.contactRelation ? ' (' + lead.contactRelation + ')' : '') : '' };
    if (pat) return { kind: 'patient', id: pat.id, name: pat.name, house: houseName(pat.houseId), phone: '', contact: '' };
    return { kind: s(t.leadId) ? 'lead' : 'patient', id: s(t.leadId) || s(t.patientId), name: s(t.leadId) ? 'ליד ' + s(t.leadId) : 'מטופל/ת ' + s(t.patientId), house: '', phone: '', contact: '' };
  }
  const STATE_ORDER = { late: 0, today: 1, wait: 2, undated: 3 };
  /* Open tasks of the actor's scope, ordered: overdue → today → upcoming → undated (spec §7); kinds filter optional. */
  function taskQueue(tasks, c, today, f) {
    f = f || {};
    return (Array.isArray(tasks) ? tasks : []).filter(function (t) { return t && s(t.status) === 'open' && (!f.kinds || f.kinds.indexOf(s(t.kind)) >= 0) && (!f.assignee || s(t.assignee) === f.assignee); })
      .map(function (t) { const sub = taskSubject(t, c); return { task: t, id: t.id, subject: sub, state: taskState(t, today), when: taskWhen(t), due: taskDue(t), kind: TASK_KIND_LABELS[s(t.kind)] || s(t.kind) }; })
      .filter(function (r) { return !f.house || r.subject.house === f.house; })
      .sort(function (a, b) {
        // state → date → a TIMED task before an untimed one (binding first, spec §7) → time
        const ta = s(a.task.dueTime), tb = s(b.task.dueTime);
        return (STATE_ORDER[a.state] - STATE_ORDER[b.state]) || (a.due < b.due ? -1 : a.due > b.due ? 1 : 0) || ((tb ? 1 : 0) - (ta ? 1 : 0)) || (ta < tb ? -1 : ta > tb ? 1 : 0);
      });
  }
  function tasksFor(subject, tasks) {
    return (Array.isArray(tasks) ? tasks : []).filter(function (t) { return t && s(t.status) === 'open' && ((subject.leadId && s(t.leadId) === subject.leadId) || (subject.patientId && s(t.patientId) === subject.patientId)); });
  }
  function taskCounts(rows) { const n = { late: 0, today: 0, wait: 0, undated: 0 }; rows.forEach(function (r) { n[r.state]++; }); return n; }
  /* New task form → errors / body. */
  function taskFormErrors(v, today) {
    const e = {};
    v = v || {};
    if (!TASK_KINDS.some(function (k) { return k.id === v.kind; })) e.kind = 'בחרי סוג';
    if (!s(v.title) || s(v.title).length > 120) e.title = 'כותרת (עד 120 תווים)';
    if (s(v.reason).length > 300) e.reason = 'עד 300 תווים';
    const mode = s(v.mode) || 'date';
    if (mode === 'date') { if (s(v.dueDate) && !isoDateOk(v.dueDate)) e.dueDate = 'תאריך לא תקין'; if (s(v.dueTime) && !timeOk(v.dueTime)) e.dueTime = 'שעה HH:MM'; }
    else if (!isoDateOk(v.weekStart)) e.weekStart = 'בחרי שבוע';
    return e;
  }
  /* «משימה חדשה» (Vered 05/11/2026, CHANGELOG-crm-task-date-time.md): only what to do, who, a DATE
   * (today or later) and a TIME — no «למה עכשיו», no «מועד» / week. Pure. */
  function newTaskErrors(v, today) {
    const e = {};
    v = v || {};
    if (!TASK_KINDS.some(function (k) { return k.id === v.kind; })) e.kind = 'בחרי סוג';
    if (!s(v.title) || s(v.title).length > 120) e.title = 'כותרת (עד 120 תווים)';
    if (!isoDateOk(v.dueDate) || s(v.dueDate) < s(today)) e.dueDate = 'בחרי תאריך — היום או אחריו';
    if (!timeOk(v.dueTime)) e.dueTime = 'בחרי שעה';
    return e;
  }
  /* The in-app reminder before a task is due (CHANGELOG-crm-task-date-time.md): open tasks of
   * `user` (or unassigned) due TODAY at a time between now and now + `lead` minutes, not yet
   * announced. `nowHm` = 'HH:MM' Israel time. → [{ task, minutes }]. Pure. */
  const TASK_REMIND_MINUTES = 30;
  function hmToMin(hm) { const m = /^(\d{2}):(\d{2})$/.exec(s(hm)); return m ? (+m[1]) * 60 + (+m[2]) : -1; }
  function dueSoonTasks(tasks, user, today, nowHm, lead, seen) {
    const now = hmToMin(nowHm), L = lead || TASK_REMIND_MINUTES, done = seen || {};
    if (now < 0) return [];
    return (Array.isArray(tasks) ? tasks : []).filter(function (t) {
      if (!t || s(t.status) !== 'open' || s(t.dueDate) !== s(today) || !timeOk(t.dueTime)) return false;
      if (s(t.assignee) && s(t.assignee) !== s(user)) return false;
      const d = hmToMin(t.dueTime) - now;
      return d >= 0 && d <= L && !done[s(t.id) + '@' + s(t.dueDate) + ' ' + s(t.dueTime)];
    }).map(function (t) { return { task: t, minutes: hmToMin(t.dueTime) - now, key: s(t.id) + '@' + s(t.dueDate) + ' ' + s(t.dueTime) }; })
      .sort(function (a, b) { return a.minutes - b.minutes; });
  }
  function taskCreateBody(subject, v, sid) {
    const t = Object.assign({}, subject, { kind: s(v.kind), title: s(v.title), reason: s(v.reason), assignee: s(v.assignee), source: 'manual' });
    if ((s(v.mode) || 'date') === 'week') { t.windowStart = weekStart(v.weekStart); t.windowEnd = addDays(t.windowStart, 6); }
    else if (s(v.dueDate)) { t.dueDate = s(v.dueDate); if (s(v.dueTime)) t.dueTime = s(v.dueTime); }
    return { action: 'createTask', submissionId: sid, task: t };
  }
  /* Reschedule: a date or a week; a reason is required when the task came from a contact (a date promised to the family). */
  function rescheduleErrors(v, task) {
    const e = {};
    v = v || {};
    if ((s(v.mode) || 'date') === 'week') { if (!isoDateOk(v.weekStart)) e.weekStart = 'בחרי שבוע'; }
    else { if (!isoDateOk(v.dueDate)) e.dueDate = 'בחרי תאריך'; if (s(v.dueTime) && !timeOk(v.dueTime)) e.dueTime = 'שעה HH:MM'; }
    if (task && s(task.source) === 'contact' && s(v.reason).length < 2) e.reason = 'מועד שהובטח למשפחה — חובה לציין סיבה';
    return e;
  }
  function rescheduleBody(id, v) {
    const b = { action: 'rescheduleTask', id: id, reason: s(v.reason) };
    if ((s(v.mode) || 'date') === 'week') { b.windowStart = weekStart(v.weekStart); b.windowEnd = addDays(b.windowStart, 6); } else { b.dueDate = s(v.dueDate); b.dueTime = s(v.dueTime); }
    return b;
  }
  function taskAccepted(res, id) { const r = res || {}; if (r.ok === true && r.task && s(r.task.id)) return id && s(r.task.id) !== id ? 'השינוי לא אושר על ידי השרת — רענני' : ''; return writeRefusal(r, 'task'); }


  /* ---- Stage 2: «היום שלי» (CHANGELOG-crm-my-day.md; spec §3–§7) ----
   * One pure model over getData (compute), the open tasks (getTasks), the last
   * contact per subject (contactIndex) and, for finance, debtAging. Every row
   * says what / why now / when / who / last contact, and opens its record.
   * Urgency is never the lead's age: a new lead without a DOCUMENTED contact
   * is «ללא מגע» (information), an overdue dated task is «באיחור». */
  const NAV_GROUPS = [
    { label: '', items: ['today', 'control'] }, { label: 'לידים ומטופלים', items: ['leads', 'clients'] }, { label: 'פגישות ויומן', items: ['calendar'] },
    { label: 'בתים והמשך טיפול', items: ['occupancy'] }, { label: 'כספים', items: ['billing'] }, { label: 'דוחות והגדרות', items: ['kpi'] }];
  const MY_DAY_VIEWS = [{ id: 'today', label: 'היום' }, { id: 'week', label: 'השבוע' }, { id: 'done', label: 'הושלמו' }];
  const DOMAINS = [
    { id: 'collection', label: 'גבייה לטיפול', money: true }, { id: 'calls', label: 'שיחות ומעקבים' }, { id: 'meetings', label: 'פגישות ותיאומים' },
    { id: 'followup', label: 'המשך טיפול לאחר פגישות' }, { id: 'newleads', label: 'לידים חדשים ללא מגע' },
    // Not «מה דחוף בבתים»: a discharge whose audit row exists but whose status save failed is a
    // data-integrity failure of Vered's own action — listed only while one exists, never a card.
    { id: 'integrity', label: 'שחרור שלא נשמר במלואו — לבדיקה', onlyIfAny: true }];
  /* Vered's feedback 04/11/2026 (CHANGELOG-crm-vered-feedback-1104.md):
   *  - a missing manager report is NOT an exception while the meeting is fresh — it
   *    becomes one only MANAGER_REPORT_GRACE_DAYS days after the meeting date;
   *  - follow-up rows dated before EXCEPTION_CUTOFF (May 2026 and earlier) are no
   *    longer listed in «היום שלי» (the source rows are untouched);
   *  - «מה דחוף בבתים» is no longer part of «היום שלי» (houseExceptions stays for «תפוסה»). */
  const MANAGER_REPORT_GRACE_DAYS = 3;
  const EXCEPTION_CUTOFF = '2026-06-01';
  const DOMAIN_LABELS = {}; DOMAINS.forEach(function (d) { DOMAIN_LABELS[d.id] = d.label; });
  const PRIORITY = { binding: 0, exception: 1, late: 2, today: 3, wait: 4, undated: 5 };
  function lastContactText(lc) {
    if (!lc || !lc.at) return 'אין מגע מתועד';
    return whenLocal(lc.at) + ' · ' + contactOutcomeLabel(lc.outcome) + (lc.summary ? ' · ' + lc.summary : '');
  }
  /* The meeting buckets of spec §6 «פגישות». A passed date proves nothing: it is «ממתין לדיווח» until the manager reports. */
  function meetingBuckets(leads, today) {
    const b = { today: [], toSchedule: [], awaitingReport: [], reportUnseen: [], awaitingDecision: [], cancelled: [] };
    (leads || []).forEach(function (l) {
      if (STAGES.every(function (st) { return st.id !== l.stage; })) return;
      if (reportUnseen(l)) { b.reportUnseen.push(l); return; }
      // A cancelled meeting is neither «today» nor «awaiting a report»: it needs a new date or a closure.
      if (l.stage === 'visit' && s(l.meetingOutcome) === 'cancelled') { b.cancelled.push(l); return; }
      if (s(l.meetingReportedAt) && !l.meetingOutcome) { b.awaitingDecision.push(l); return; }
      if (l.stage !== 'visit') return;
      if (!l.visitDate) b.toSchedule.push(l);
      else if (l.visitDate === today) b.today.push(l);
      else if (l.visitDate < today && !l.meetingOutcome) b.awaitingReport.push(l);
    });
    b.today.sort(function (a, c) { return (a.visitTime || '99').localeCompare(c.visitTime || '99'); });
    return b;
  }
  /* «פניות חדשות ללא מגע»: stage new, no documented contact, no open call task. Age is shown, never a lateness. */
  function newLeadsNoContact(leads, tasks, index, today) {
    const open = {};
    (tasks || []).forEach(function (t) { if (t && t.status === 'open' && (t.kind === 'call') && s(t.leadId)) open[s(t.leadId)] = true; });
    // Without a successful contact-index read, absence of a row is NOT evidence of no contact.
    // A missing tasks read is equally unsafe: an open callback may already cover this lead.
    if (!Array.isArray(tasks) || !index || index.ok === false || !index.leads) return [];
    const li = index.leads;
    return (leads || []).filter(function (l) { return l.stage === 'new' && !li[l.id] && !open[l.id]; })
      .map(function (l) { return { lead: l, age: l.created ? daysBetween(l.created, today) : null }; })
      .sort(function (a, c) { return (c.lead.created || '').localeCompare(a.lead.created || ''); });   // newest first — the family is still waiting
  }
  function rowOfLead(l, o) {
    return Object.assign({ subjectKind: 'lead', subjectId: l.id, name: l.name, house: houseName(l.house), owner: l.assignedTo, when: '', time: '', why: '', state: 'wait', priority: 'wait' }, o);
  }
  function rowOfTask(t, c, today) {
    const sub = taskSubject(t, c);
    const st = taskState(t, today);
    const binding = st === 'today' && !!s(t.dueTime);
    return { id: t.id, taskId: t.id, kind: 'task', subjectKind: sub.kind, subjectId: sub.id, name: sub.name, house: sub.house, contact: sub.contact, action: t.title, why: t.reason || (t.source === 'contact' ? 'נקבע בשיחה' : ''),
      when: taskDue(t), time: s(t.dueTime), whenText: taskWhen(t), owner: t.assignee, state: st, priority: binding ? 'binding' : st, task: t };
  }
  /* A discharge audit row is restored when the flag reads true in any of the
   * spellings the sheet holds ('TRUE' from Sheets, 'true', '1'). Pure. */
  function isRestoredDischarge(d) { const r = s(d && d.restored).toUpperCase(); return r === 'TRUE' || r === '1'; }
  /* Prevent a second fresh audit while an exact-ID source discharge already
   * exists and has not been restored or removed. No fuzzy identity match. */
  function pendingDischargeAudit(audits, patientId) {
    return !!s(patientId) && (Array.isArray(audits) ? audits : []).some(function (d) {
      return d && !d.deletedAt && !isRestoredDischarge(d) && s(d.patientId) === s(patientId);
    });
  }
  /* The Patients id a discharge audit row belongs to (CHANGELOG-crm-today-card-open.md).
   * Only CRM / coordinator discharges write `patientId`; the classic «שחרר» flow leaves
   * it blank, so the row is matched like restoreTarget does: patientId (when it is on
   * Patients), then the stay triple (house, name, entry date), then the ONE released
   * row of the house with the same source lead. Unresolved → the stored patientId ('' when blank). Pure. */
  function dischargePatientId(d, patients) {
    const list = Array.isArray(patients) ? patients : [];
    const pid = s(d && d.patientId);
    if (pid && list.some(function (p) { return p.id === pid; })) return pid;
    const hid = houseId(d && d.houseId);
    const nm = s(d && d.name).replace(/\s+/g, ' ');
    const sameHouse = list.filter(function (p) { return p.id && houseId(p.houseId) === hid; });
    const byTriple = sameHouse.filter(function (p) { return p.name.replace(/\s+/g, ' ') === nm && p.date === s(d && d.date); });
    if (byTriple.length === 1) return byTriple[0].id;
    if (s(d && d.fromLead)) {
      const byLead = sameHouse.filter(function (p) { return p.status === 'released' && p.fromLead === s(d.fromLead); });
      if (byLead.length === 1) return byLead[0].id;
    }
    return pid; // unresolved: the stored id (or ''); openDrawer then says so instead of doing nothing
  }
  /* «מה דחוף בבתים» (spec §6): exceptions with an owner and a reason. "Paid, not admitted" is an exception ONLY when the entry date passed. */
  function houseExceptions(c, today) {
    // (the manager-report exceptions live in «המשך טיפול» — one row per item, spec §5: never the same item twice)
    const rows = [];
    c.leads.forEach(function (l) {
      if (l.stage === 'paid' && l.entryDate && l.entryDate <= today) rows.push(rowOfLead(l, { id: 'ex:admit:' + l.id, kind: 'admission_due', action: 'קליטה לבית לא בוצעה', why: 'תאריך הכניסה ' + fmtDate(l.entryDate) + ' עבר', when: l.entryDate, state: 'late', priority: 'exception' }));
    });
    (c.discharges || []).forEach(function (d) {
      if (d.deletedAt || isRestoredDischarge(d) || !d.exitDate) return;
      // An acknowledged discharge audit is source-owned even if the second
      // Patients save was refused. Match by exact stay ID only: never name/phone.
      const linked = s(d.patientId) ? (c.patients || []).filter(function (p) { return s(p.id) === s(d.patientId); }) : [];
      if (linked.length === 1 && s(linked[0].status) !== 'released') {
        rows.push({ id: 'ex:discharge-state:' + d.id, kind: 'discharge_integrity', subjectKind: 'patient',
          subjectId: s(d.patientId), dischargeId: d.id, name: d.name, house: houseName(d.houseId),
          action: 'בדיקת שלמות שחרור', why: 'רישום שחרור קיים, אך סטטוס המטופל עדיין אינו משוחרר',
          when: d.exitDate, time: '', owner: 'ורד', state: 'wait', priority: 'exception', open: 'overview' });
        return; // do not create a second continuity row for the same incomplete discharge
      }
      if (continuityRecorded(d.continuity)) return;
      // Referral/disposition = sent/intended, NOT confirmed treatment start.
      // The status-return feed is still a draft. A derived exception stays
      // visible even after day 14 until a documented result is recorded.
      const sent = !!(c.outpatientSent && c.outpatientSent['discharge:' + d.id]);
      const expectingOutpatient = sent || d.disposition === 'released_outpatient';
      const action = expectingOutpatient ? 'לאמת המשך טיפול לאחר הפניה לאמבולטורי' : 'לעדכן המשך טיפול';
      const reason = expectingOutpatient
        ? (sent ? 'הפנייה נשלחה, אך לא התקבל אישור שהטיפול התחיל' : 'סומן מעבר לאמבולטורי, אך שליחת הפנייה והתחלת הטיפול לא אומתו')
        : 'שוחרר/ה ' + fmtDate(d.exitDate) + ' ללא תוצאת המשך טיפול';
      // One read-only exception per source discharge; no third writable task.
      rows.push({ id: 'ex:cont:' + d.id, kind: 'continuity', subjectKind: 'patient', subjectId: dischargePatientId(d, c.patients), dischargeId: d.id, name: d.name, house: houseName(d.houseId), action: action, why: reason, when: d.exitDate, time: '', owner: 'ורד', state: 'wait', priority: 'exception', open: 'meetings' });
    });
    return rows;
  }
  // Reuse Patients + Funders, never a local-only warning or a new task ledger.
  // A missing/unreadable funder is UNKNOWN, not proof that a write failed.
  // Rendered only for finance readers. Existing legacy identity reads are kept.
  function funderExceptions(c, payments, today) {
    if (!payments || payments.ok !== true || !Array.isArray(payments.funders)) return [];
    return (c.patients || []).filter(function (p) {
      return p.id && inHouse(p) && p.fromLead && p.date && p.date <= today && FUNDERS.indexOf(funderOnDay(payments.funders, p.id, patientKeyOf(p), p.date)) < 0;
    }).map(function (p) {
      return { id: 'ex:funder:' + p.id, kind: 'funder_unverified', subjectKind: 'patient', subjectId: p.id,
        name: p.name, house: houseName(p.houseId), action: 'גורם מממן לקליטה לא אומת',
        why: 'יש לבדוק את הגורם המממן מתאריך הכניסה בכרטיס החשבון; אין לקלוט שוב',
        when: p.date, time: '', owner: 'ורד', state: 'today', priority: 'exception', open: 'account' };
    });
  }
  function sortRows(rows) {
    return rows.sort(function (a, b) { return (PRIORITY[a.priority] - PRIORITY[b.priority]) || ((a.when || '9') < (b.when || '9') ? -1 : (a.when || '9') > (b.when || '9') ? 1 : 0) || ((b.time ? 1 : 0) - (a.time ? 1 : 0)) || (a.time < b.time ? -1 : a.time > b.time ? 1 : 0); });
  }
  function passes(r, f) {
    if (!f) return true;
    if (f.house && r.house !== houseName(f.house)) return false;
    if (f.owner && (r.owner || '') !== f.owner) return false;
    return true;
  }
  /* The whole page model. me.view: 'full' (finance) | 'ops' | 'restricted'. debt: the debtAging answer, null when not loaded, false when it failed. */
  function myDay(c, tasks, index, debt, today, me, f, payments) {
    const finance = !!(me && me.finance);
    const b = meetingBuckets(c.leads, today);
    const contactAvailable = !!(index && index.ok !== false && index.leads && index.patients);
    const tasksAvailable = Array.isArray(tasks);
    const li = contactAvailable ? index.leads : {}, pi = contactAvailable ? index.patients : {};
    const lastOf = function (r) { return r.subjectKind === 'lead' ? li[r.subjectId] : pi[r.subjectId]; };
    const tq = (tasks || []).filter(function (t) { return t && t.status === 'open'; }).map(function (t) { return rowOfTask(t, c, today); });
    const calls = tq.filter(function (r) { return r.task.kind === 'call'; });
    const collection = tq.filter(function (r) { return r.task.kind === 'collection'; });
    const otherTasks = tq.filter(function (r) { return r.task.kind !== 'call' && r.task.kind !== 'collection'; });
    const meetings = [];
    b.today.forEach(function (l) { meetings.push(rowOfLead(l, { id: 'm:today:' + l.id, kind: 'meeting_today', action: 'פגישת קבלה' + (l.visitTime ? ' ' + l.visitTime : ''), why: 'עם ' + (l.meetingWith || '—'), when: today, time: l.visitTime, owner: l.meetingWith || l.assignedTo, state: 'today', priority: l.visitTime ? 'binding' : 'today', open: 'meetings' })); });
    b.toSchedule.forEach(function (l) { meetings.push(rowOfLead(l, { id: 'm:sched:' + l.id, kind: 'meeting_unscheduled', action: 'לתאם פגישה', why: 'ביקור ללא תאריך', state: 'undated', priority: 'undated', focusMeeting: true })); });
    const followup = [];
    b.awaitingReport.forEach(function (l) {
      // A fresh meeting has no report yet by nature: «ממתין», not «חריג», until GRACE days have passed.
      const late = reportOverdue(l, today);
      followup.push(rowOfLead(l, { id: 'f:report:' + l.id, kind: 'awaiting_report', action: late ? 'דיווח המנהל/ת באיחור' : 'ממתין לדיווח המנהל/ת',
        why: 'הפגישה היתה ב-' + fmtDate(l.visitDate) + (late ? ' — ' + daysBetween(l.visitDate, today) + ' ימים ללא דיווח המנהל/ת' : ' — הדיווח צפוי עד ' + fmtDate(addDays(l.visitDate, MANAGER_REPORT_GRACE_DAYS))),
        when: l.visitDate, owner: l.meetingWith || '', waitingOn: l.meetingWith || 'המנהל/ת', state: late ? 'late' : 'wait', priority: late ? 'exception' : 'wait', open: 'meetings' }));
    });
    b.cancelled.forEach(function (l) {
      // Cancellation still needs a next step regardless of which form recorded it.
      // Reuse an existing callback/meeting task (including a deferred date), never
      // create another task just to make the cancelled visit visible.
      if (tq.some(function (r) { return s(r.task.leadId) === s(l.id) && (r.task.kind === 'call' || r.task.kind === 'meeting'); })) return;
      const ch = patientMeetingChange(l, flagsOf(index, l.id));
      followup.push(rowOfLead(l, { id: 'f:cancel:' + l.id, kind: 'meeting_cancelled', action: 'לתאם מועד חדש או לסגור את הליד',
        why: (ch ? 'הפגישה בוטלה ע״י המטופל/ת' : 'הפגישה בוטלה — טרם נקבע המשך') + (l.visitDate ? ' (נקבעה ל-' + fmtDate(l.visitDate) + ')' : ''),
        when: ch && ch.at ? s(ch.at).slice(0, 10) : l.visitDate, state: 'today', priority: 'today', open: 'meetings', contactable: true }));
    });
    b.reportUnseen.forEach(function (l) { followup.push(rowOfLead(l, { id: 'f:unseen:' + l.id, kind: 'report_unseen', action: 'לקרוא דיווח מנהל/ת', why: 'דיווח חדש מ-' + (l.meetingReporter || 'הבית') + (l.meetingReportOutcome === 'no_show' ? ' · לא הגיע / בוטל — הביקור לא התקיים' : ''), when: s(l.meetingReportedAt).slice(0, 10), state: 'today', priority: 'exception', open: 'meetings' })); });
    b.awaitingDecision.forEach(function (l) {
      // A manager's no_show means "לא הגיע / בוטל" (combined in the source).
      // Do NOT imply the meeting took place or close the lead automatically.
      // Keep the same source-derived row ID and real logContact navigation.
      const notHeld = l.meetingReportOutcome === 'no_show';
      followup.push(rowOfLead(l, {
        id: 'f:decide:' + l.id,
        kind: notHeld ? 'meeting_no_show_followup' : 'report_undecided',
        action: notHeld ? 'לברר היעדרות / ביטול ולתאם מועד חדש' : 'להחליט אחרי דיווח המנהל/ת',
        why: notHeld ? 'דיווח המנהל/ת: לא הגיע / בוטל — הביקור לא התקיים; נדרש ליצור קשר או לתעד סגירה מנומקת' : 'הדיווח נקרא, אין החלטה',
        when: s(l.meetingReportedAt).slice(0, 10),
        whenText: notHeld ? 'דיווח מ-' + fmtDate(s(l.meetingReportedAt).slice(0, 10)) + ' · מועד המשך טרם נקבע' : '',
        state: notHeld ? 'wait' : 'late', priority: 'exception', open: 'meetings', contactable: notHeld
      }));
    });
    // Rows from May 2026 and earlier are no longer listed (Vered 04/11/2026) — a cancellation is new work, never cut.
    for (let i = followup.length - 1; i >= 0; i--) if (followup[i].kind !== 'meeting_cancelled' && followup[i].when && followup[i].when < EXCEPTION_CUTOFF) followup.splice(i, 1);
    const fresh = newLeadsNoContact(c.leads, tasks, index, today).map(function (x) { return rowOfLead(x.lead, { id: 'n:' + x.lead.id, kind: 'lead_no_contact', action: 'יצירת קשר ראשון', why: x.age === null ? 'אין מגע מתועד' : 'ליד מ-' + fmtDate(x.lead.created) + ' · אין מגע מתועד', when: '', state: 'wait', priority: 'wait', contactable: true }); });
    // «מה דחוף בבתים» is no longer part of «היום שלי» (Vered 04/11/2026); «תפוסה» still reads houseExceptions.
    // Kept: the discharge-integrity check (an audit row whose Patients status did not save — P0 safety net).
    const houses = houseExceptions(c, today).filter(function (r) { return r.kind === 'discharge_integrity'; });
    // money: collection tasks + the recorded / unrecorded open cycles of debtAging (finance only)
    const money = [];
    let debtCount = null;
    if (finance) {
      collection.forEach(function (r) { money.push(r); });
      funderExceptions(c, payments, today).forEach(function (r) { money.push(r); });
      if (debt && debt.ok !== false && Array.isArray(debt.byPatient)) {
        debtCount = 0;
        debt.byPatient.forEach(function (p) {
          (p.cycles || []).forEach(function (cy) {
            if (!(Number(cy.balance) > 0)) return;
            debtCount++;
            if (money.length < 400) money.push({ id: 'd:' + p.patientId + ':' + cy.start, kind: cy.kind === 'recorded' ? 'debt_recorded' : 'cycle_unreported', subjectKind: 'patient', subjectId: p.patientId, name: p.name, house: houseName(p.houseId),
              action: cy.kind === 'recorded' ? 'חוב רשום — ' + fmtMoney(cy.balance) : 'מחזור ללא דיווח — ' + fmtMoney(cy.balance), why: (cy.kind === 'recorded' ? 'דווח ' + fmtMoney(cy.received) + ' מתוך ' + fmtMoney(cy.expected) : 'לא דווח תשלום למחזור') + ' · ' + fmtDate(cy.start) + ' – ' + fmtDate(cy.end),
              when: cy.end, time: '', owner: 'ורד', state: cy.end < today ? 'late' : 'wait', priority: cy.end < today ? 'late' : 'wait', open: 'account' });
          });
        });
      } else if (debt === null || debt === undefined) debtCount = null; else debtCount = false;
      if (payments && payments.ok !== false) verificationRows(payments, today).forEach(function (r) { money.push(r); });
    }
    const all = [].concat(money, calls, meetings, followup, fresh, houses, otherTasks).filter(function (r) { return passes(r, f); });
    all.forEach(function (r) { r.lastContact = contactAvailable ? lastContactText(lastOf(r)) : 'יומן הקשר אינו זמין'; r.domain = r.domain || (money.indexOf(r) >= 0 ? 'collection' : calls.indexOf(r) >= 0 ? 'calls' : meetings.indexOf(r) >= 0 ? 'meetings' : followup.indexOf(r) >= 0 ? 'followup' : fresh.indexOf(r) >= 0 ? 'newleads' : houses.indexOf(r) >= 0 ? 'integrity' : 'calls'); });
    const byDomain = {}; DOMAINS.forEach(function (d) { byDomain[d.id] = []; });
    all.forEach(function (r) { byDomain[r.domain].push(r); });
    Object.keys(byDomain).forEach(function (k) { sortRows(byDomain[k]); });
    const countOf = function (rows, pred) { return rows.filter(pred || function () { return true; }).length; };
    const dueNow = function (r) { return r.state === 'late' || r.state === 'today'; };
    const cards = [];
    if (finance) {
      // Two distinct counters (Sandra, 29/10, package §8): «גבייה לביצוע» = what Vered acts on (debt rows
      // due + collection tasks due + flagged receipts awaiting HER decision); «ממתין לאימות אורטל» = reported
      // receipts — not confirmed cash, not her task, never counted as collection work. Debt figures untouched.
      const waitingOrtal = countOf(byDomain.collection, function (r) { return r.kind === 'receipt_reported'; });
      const toCollect = countOf(byDomain.collection, function (r) { return r.kind !== 'receipt_reported' && dueNow(r); });
      // A count sourced from THREE independent reads is never a complete zero if even
      // one of debt, open Tasks or receipts has failed / has not arrived yet.
      const paymentsAvailable = !!(payments && payments.ok !== false && (Array.isArray(payments.receipts) || Array.isArray(payments.payments)));
      const collectionComplete = debtCount !== null && debtCount !== false && tasksAvailable && paymentsAvailable;
      const collectionLoading = debtCount === null || tasks === undefined || payments === undefined;
      cards.push({ id: 'collection', label: 'גבייה לביצוע', value: collectionComplete ? toCollect : null,
        second: payments === undefined ? { label: 'ממתין לאימות אורטל', value: '…' } : (paymentsAvailable ? { label: 'ממתין לאימות אורטל', value: waitingOrtal } : { label: 'ממתין לאימות אורטל', value: '—' }),
        hint: collectionComplete ? debtCount + ' מחזורים פתוחים · דיווח אינו כסף מאומת' : (collectionLoading ? 'טוען… · ספירת הגבייה עדיין אינה מלאה' : 'המידע חלקי — מקור חובות, משימות או תקבולים אינו זמין') });
    }
    cards.push({ id: 'calls', label: 'שיחות ומעקבים', value: tasks ? countOf(byDomain.calls, dueNow) : null, hint: tasks ? countOf(byDomain.calls, function (r) { return r.state === 'late'; }) + ' באיחור · ' + byDomain.calls.length + ' פתוחות' : (tasks === undefined ? 'טוען…' : 'המידע אינו זמין') });
    cards.push({ id: 'meetings', label: 'פגישות היום', value: countOf(byDomain.meetings, function (r) { return r.kind === 'meeting_today'; }), second: { label: 'תיאומים פתוחים', value: countOf(byDomain.meetings, function (r) { return r.kind === 'meeting_unscheduled'; }) } });
    cards.push({ id: 'followup', label: 'המשך טיפול לאחר פגישות', value: byDomain.followup.length, hint: countOf(byDomain.followup, function (r) { return r.kind === 'awaiting_report'; }) + ' ממתינות לדיווח מנהל/ת' });
    cards.push({ id: 'newleads', label: 'לידים חדשים ללא מגע', value: contactAvailable && tasksAvailable ? byDomain.newleads.length : null, hint: contactAvailable && tasksAvailable ? 'ללא ניסיון קשר מתועד' : (index === undefined || tasks === undefined ? 'טוען…' : 'לא ניתן לקבוע ללא יומן קשר ומשימות') });
    const urgent = sortRows(all.filter(function (r) { return r.priority === 'exception' || r.priority === 'binding'; }).slice());
    const waiting = all.filter(function (r) { return r.waitingOn; });
    const exceptions = all.filter(function (r) { return r.priority === 'exception'; });
    return { cards: cards, byDomain: byDomain, urgent: urgent, waiting: waiting, meetingsToday: byDomain.meetings.filter(function (r) { return r.kind === 'meeting_today'; }), exceptions: exceptions, total: all.length, buckets: b,
      sourceState: { contact: contactAvailable, tasks: tasksAvailable, collection: !finance ? 'hidden' : (cards[0].value === null ? (debt === null || debt === undefined || tasks === undefined || payments === undefined ? 'loading' : 'partial') : 'complete') } };
  }
  // Control cards and their drill-down use the SAME filtered work rows, including
  // the historic cutoff and permission scope already applied by myDay.
  const WORK_CONTROL = [
    { id: 'unseen', label: 'דיווחי מנהל/ת שלא נקראו', kinds: ['report_unseen'] },
    { id: 'undecided', label: 'דיווחים שנקראו ללא החלטה', kinds: ['report_undecided', 'meeting_no_show_followup'] },
    { id: 'awaitingReport', label: 'פגישות שעברו ללא דיווח', kinds: ['awaiting_report'] },
    { id: 'unscheduled', label: 'ביקורים ללא תאריך', kinds: ['meeting_unscheduled'] },
    { id: 'late', label: 'משימות באיחור', kinds: [] }
  ];
  function workControlQueues(m) {
    const all = [].concat.apply([], Object.keys(m.byDomain).map(function (k) { return m.byDomain[k]; }));
    const queues = {};
    WORK_CONTROL.forEach(function (q) {
      queues[q.id] = sortRows(all.filter(function (r) { return q.id === 'late' ? r.kind === 'task' && r.state === 'late' : q.kinds.indexOf(r.kind) >= 0; }));
    });
    return queues;
  }
  /* «השבוע»: the dated rows of a Sun–Sat week, grouped by day; a window task sits on every day it covers (one id). */
  function weekPlan(model, ws, c, filters, today) {
    const days = [];
    for (let i = 0; i < 7; i++) { const d = addDays(ws, i); days.push({ date: d, name: DAY_NAMES[i], rows: [] }); }
    const seen = {};
    Object.keys(model.byDomain).forEach(function (k) {
      model.byDomain[k].forEach(function (r) {
        if (seen[r.id]) return; seen[r.id] = true;
        const t = r.task;
        if (t && s(t.windowStart)) { days.forEach(function (d) { if (d.date >= s(t.windowStart) && d.date <= s(t.windowEnd)) d.rows.push(r); }); return; }
        if (!r.when) return;
        days.forEach(function (d) { if (d.date === r.when) d.rows.push(r); });
      });
    });
    // Reuse the existing calendar projection: My Day intentionally contains only TODAY's
    // meetings, so a week assembled solely from My Day silently omits future appointments.
    // This read-only projection does not create a meeting, task or second calendar.
    if (c && Array.isArray(c.leads)) calendarRows(c.leads, { mode: 'week', from: ws, to: addDays(ws, 6) }, today || ws).forEach(function (v) {
      const row = { id: 'week:meeting:' + v.id, kind: 'meeting_week', subjectKind: 'lead', subjectId: v.id, name: v.name, house: v.house,
        action: 'פגישת קבלה' + (v.time ? ' ' + v.time : ''), why: 'עם ' + (v.withWhom || '—') + ' · ' + v.status.text, owner: v.withWhom,
        when: v.date, time: v.time, state: v.status.state, priority: v.status.state === 'today' && v.time ? 'binding' : v.status.state, open: 'meetings' };
      if (!passes(row, filters)) return;
      const day = days.filter(function (d) { return d.date === v.date; })[0];
      // The same appointment already arrived in My Day as meeting_today.
      if (day && !day.rows.some(function (r) { return r.subjectKind === 'lead' && r.subjectId === v.id && r.kind === 'meeting_today'; })) day.rows.push(row);
    });
    days.forEach(function (d) { sortRows(d.rows); });
    return { start: ws, end: addDays(ws, 6), days: days, undated: Object.keys(model.byDomain).reduce(function (acc, k) { return acc.concat(model.byDomain[k].filter(function (r) { return r.task && !r.when; })); }, []) };
  }
  /* «הושלמו»: done / cancelled tasks whose doneAt (or updatedAt) falls in the week; who / when; opens the record. */
  function doneInWeek(tasks, ws, c) {
    const we = addDays(ws, 6);
    return (tasks || []).filter(function (t) { const d = isoDay(t.doneAt || t.updatedAt); return t && (t.status === 'done' || t.status === 'cancelled') && d >= ws && d <= we; })
      .map(function (t) { const sub = taskSubject(t, c); return { id: t.id, task: t, subjectKind: sub.kind, subjectId: sub.id, name: sub.name, house: sub.house, action: t.title, who: t.status === 'done' ? t.doneBy : t.updatedBy, at: t.status === 'done' ? t.doneAt : t.updatedAt, outcome: t.status === 'done' ? (t.outcome || 'הושלם') : 'בוטל' + (t.cancelReason ? ' — ' + t.cancelReason : ''), kind: TASK_KIND_LABELS[t.kind] || t.kind }; })
      .sort(function (a, b) { return a.at < b.at ? 1 : -1; });
  }
  function hebDate(iso) { const d = weekdayOf(iso); return (d >= 0 ? 'יום ' + DAY_NAMES[d] + ', ' : '') + fmtDate(iso); }


  /* ---- Stage 3: «רשומות שדורשות בירור» (CHANGELOG-crm-triage.md; spec §12) ----
   * One record at a time, one decision per click, every decision leaves a
   * record (a contact event, a task, a stage change, a closed lead) and the
   * queue is RECOMPUTED from the data — never a hard-coded 75, never a bulk
   * defer. A record leaves the queue only because something was decided. */
  const TRIAGE_OPTIONS = [
    { id: 'call', label: 'שיחה עכשיו', hint: 'פותח את טופס תיעוד השיחה' },
    { id: 'later', label: 'לחזור בתאריך', hint: 'משימת שיחה עם מועד' },
    { id: 'waitlist', label: 'רשימת המתנה', hint: 'סיבה, בית, אחראי ותאריך בדיקה' },
    { id: 'update', label: 'עדכון לפי מידע מאומת', hint: 'פותח את הכרטיס לעריכה' },
    { id: 'close', label: 'סגירה — לא רלוונטי', hint: 'עם סיבה; ניתן לשחזר מ«לידים סגורים»' },
    { id: 'check', label: 'לסמן לבדיקה נוספת', hint: 'משימת בירור עם מועד ואחראי' }];
  /* The queue: open leads with NO documented contact and NO open task, oldest first (the family waited longest). */
  function triageQueue(c, tasks, index, today) {
    if (!Array.isArray(tasks) || !index || index.ok === false || !index.leads) return [];
    const open = {};
    tasks.forEach(function (t) { if (t && t.status === 'open' && s(t.leadId)) open[s(t.leadId)] = t; });
    const li = index.leads;
    return (c.leads || []).filter(function (l) { return (l.stage === 'new' || (l.stage === 'visit' && !l.visitDate)) && !li[l.id] && !open[l.id]; })
      .map(function (l) { return { lead: l, age: l.created ? daysBetween(l.created, today) : null, reason: l.stage === 'visit' ? 'ביקור ללא תאריך ואין מגע מתועד' : 'אין מגע מתועד' }; })
      .sort(function (a, b) { return (a.lead.created || '9').localeCompare(b.lead.created || '9'); });
  }
  function waitlistErrors(v, today) {
    const e = {};
    v = v || {};
    if (!houseId(v.house) && !HOUSES.some(function (h) { return h.name === s(v.house); })) e.house = 'בחרי בית';
    if (ASSIGNEES.indexOf(s(v.assignee)) < 0) e.assignee = 'בחרי אחראי';
    if (s(v.reason).length < 2) e.reason = 'סיבה (2 תווים לפחות)';
    if (!isoDateOk(v.checkDate) || v.checkDate < today) e.checkDate = 'תאריך בדיקה מהיום והלאה';
    return e;
  }
  /* The lead patch of a waitlist decision (classic one-lead saveAll via applyLeadPatch) — the reason is appended to the note, never overwriting it. */
  function waitlistPatch(lead, v, today) {
    const line = '[' + fmtDate(today) + '] רשימת המתנה: ' + s(v.reason);
    return { stage: 'waitlist', house: houseName(v.house), assignedTo: s(v.assignee), note: s(lead.note) ? s(lead.note) + '\n' + line : line };
  }
  function laterErrors(v, today) {
    const e = {};
    v = v || {};
    if (!isoDateOk(v.dueDate) || v.dueDate < today) e.dueDate = 'תאריך מהיום והלאה';
    if (s(v.dueTime) && !timeOk(v.dueTime)) e.dueTime = 'שעה HH:MM';
    return e;
  }


  /* ---- Stage 2b: verification states on Vered's day + Ortal's day (CHANGELOG-crm-ortal-day.md; spec §5–§6) ----
   * «דווח» ≠ «אומת» ≠ «מסמך הונפק». A reported receipt waits on Ortal (owner shown,
   * not Vered's task); a flagged / partial one is an exception waiting for a decision.
   * Document issuance is not recorded in this system (חשבשבת is the source), so the
   * document card counts REQUESTED invoices on verified receipts — and says so. */
  const VERIFY_LABELS = { reported: 'דווח — ממתין לאימות', partial: 'אומת חלקית', flagged: 'סומן לבירור', confirmed: 'אומת' };
  function verifyStatus(r) { return s(r && (r.confirmStatus || r.status)) || 'reported'; }
  /* Vered's collection rows from getPayments receipts: reported (waiting on Ortal), flagged / partial (exception). */
  function verificationRows(payments, today) {
    const out = [];
    receiptsOf(payments).forEach(function (r) {
      if (r.isVoid) return;
      const st = verifyStatus(r);
      if (st === 'confirmed') return;
      const base = { id: 'v:' + r.id, subjectKind: 'patient', subjectId: r.patientUid || r.patientId, name: r.patientName, house: r.houseName, when: r.receivedDate, time: '', owner: st === 'reported' ? 'אורטל' : 'ורד', open: 'account', receipt: r,
        action: VERIFY_LABELS[st] + ' — ' + fmtMoney(r.amount), why: 'התקבל ' + fmtDate(r.receivedDate) + (r.method ? ' · ' + r.method : '') + (r.funder ? ' · ' + r.funder : '') };
      if (st === 'reported') out.push(Object.assign(base, { kind: 'receipt_reported', waitingOn: 'אורטל', state: 'wait', priority: 'wait' }));
      else out.push(Object.assign(base, { kind: 'receipt_flagged', state: 'late', priority: 'exception', why: base.why + (r.flagNote ? ' · ' + r.flagNote : '') }));
    });
    return out;
  }
  /* Ortal's day: the verification queue (billingControlQueue), her money tasks, the pending credits. */
  function ortalDay(queue, tasks, credits, today, f) {
    const list = queue && queue.ok !== false && Array.isArray(queue.receipts) ? queue.receipts : null;
    const rowOf = function (r, kind, state, priority) {
      const st = verifyStatus(r);
      return { id: 'o:' + r.id, kind: kind, subjectKind: 'patient', subjectId: s(r.patientUid || r.patientId), name: s(r.patientName), house: houseName(r.houseId), when: sheetDay(r.receivedDate), time: '', owner: 'אורטל',
        action: (VERIFY_LABELS[st] || st) + ' — ' + fmtMoney(r.amount), why: 'דווח ע״י ' + (s(r.recordedBy) || '—') + ' · ' + fmtDate(sheetDay(r.receivedDate)) + (r.method ? ' · ' + s(r.method) : '') + (st === 'flagged' && r.flagNote ? ' · ' + s(r.flagNote) : '') + (r.invoiceWanted === 'yes' ? ' · חשבונית מבוקשת' + (r.invoiceTo ? ' ל' + s(r.invoiceTo) : '') : ''),
        state: state, priority: priority, classic: true, lastContact: '' };
    };
    const toVerify = [], flagged = [], documents = [];
    (list || []).forEach(function (r) {
      const st = verifyStatus(r);
      if (st === 'reported') toVerify.push(rowOf(r, 'to_verify', daysBetween(sheetDay(r.receivedDate), today) > 3 ? 'late' : 'today', daysBetween(sheetDay(r.receivedDate), today) > 3 ? 'late' : 'today'));
      else if (st === 'flagged' || st === 'partial') flagged.push(rowOf(r, 'flagged', 'late', 'exception'));
      else if (st === 'confirmed' && r.invoiceWanted === 'yes' && daysBetween(sheetDay(r.receivedDate), today) <= 60) documents.push(rowOf(r, 'document', 'wait', 'wait'));
    });
    const moneyTasks = (tasks || []).filter(function (t) { return t && t.status === 'open'; }).map(function (t) { return rowOfTask(t, { leads: [], patients: [] }, today); });
    const pend = credits ? pendingCredits(credits).map(function (c) { return { id: 'c:' + c.id, kind: 'credit', subjectKind: 'patient', subjectId: c.patientId, name: c.patientName, house: houseName(c.houseId), when: c.payoutDate || '', time: '', owner: 'אורטל', action: 'זיכוי לתשלום — ' + fmtMoney(c.amount), why: (CREDIT_TYPE_LABELS[c.creditType] || c.creditType) + ' · ' + c.allocationMonth, state: c.payoutDate && c.payoutDate < today ? 'late' : 'wait', priority: c.payoutDate && c.payoutDate < today ? 'late' : 'wait', classic: true, lastContact: '' }; }) : null;
    const sets = { toVerify: sortRows(toVerify), flagged: sortRows(flagged), documents: sortRows(documents), tasks: sortRows(moneyTasks), credits: pend ? sortRows(pend) : [] };
    Object.keys(sets).forEach(function (k) { sets[k] = sets[k].filter(function (r) { return passes(r, f); }); });
    const dueNow = function (r) { return r.state === 'late' || r.state === 'today'; };
    const cards = [
      { id: 'toVerify', label: 'דיווחים לאימות', value: list ? sets.toVerify.length : null, hint: list ? sets.toVerify.filter(function (r) { return r.state === 'late'; }).length + ' מעל 3 ימים' : (queue === undefined || queue === null ? 'טוען…' : 'המידע אינו זמין') },
      { id: 'flagged', label: 'אימותים חלקיים / לבירור', value: list ? sets.flagged.length : null, hint: list ? 'ממתינים להחלטה' : (queue === undefined || queue === null ? 'טוען…' : 'המידע אינו זמין') },
      { id: 'documents', label: 'חשבוניות מבוקשות', value: list ? sets.documents.length : null, hint: list ? 'תקבולים מאומתים עם בקשה לחשבונית (60 יום) — ההנפקה אינה נרשמת כאן' : (queue === undefined || queue === null ? 'טוען…' : 'המידע אינו זמין') },
      { id: 'tasks', label: 'משימות כספיות שלך', value: tasks ? sets.tasks.filter(dueNow).length : null, hint: tasks ? sets.tasks.length + ' פתוחות' : (tasks === undefined ? 'טוען…' : 'המידע אינו זמין') },
      { id: 'credits', label: 'זיכויים לתשלום', value: credits ? sets.credits.length : null, hint: credits ? sets.credits.filter(function (r) { return r.state === 'late'; }).length + ' אחרי מועד התשלום' : (credits === undefined ? 'טוען…' : 'המידע אינו זמין') }];
    const urgent = sortRows([].concat(sets.flagged, sets.toVerify.filter(function (r) { return r.state === 'late'; }), sets.tasks.filter(function (r) { return r.priority === 'binding' || r.state === 'late'; }), sets.credits.filter(function (r) { return r.state === 'late'; })));
    return { cards: cards, sets: sets, urgent: urgent };
  }

  /* ===== «KPI» (CHANGELOG-crm-kpi-tab.md) =====
   * Read-only slices over getData (and, for finance, debtAging). Pure: no DOM,
   * no I/O. Every number is computed in the browser from data the session may
   * already read — no new endpoint, no Code.gs change. */
  const KPI_PERIODS = [
    { id: 'this_month', label: 'החודש' }, { id: 'last_month', label: 'החודש הקודם' },
    { id: 'last_3_months', label: '3 חודשים אחרונים' }, { id: 'this_year', label: 'מתחילת השנה' },
  ];
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  /* A preset → { from, to } (inclusive 'YYYY-MM-DD') around today. null for an unknown id / a bad today. Pure. */
  function kpiPeriod(id, today) {
    const t = s(today);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) return null;
    const y = +t.slice(0, 4), m = +t.slice(5, 7);
    const back = function (k) { let mm = m - k, yy = y; while (mm < 1) { mm += 12; yy--; } return { y: yy, m: mm }; };
    if (id === 'this_month') return { from: y + '-' + pad2(m) + '-01', to: t };
    if (id === 'last_month') { const p = back(1); return { from: p.y + '-' + pad2(p.m) + '-01', to: p.y + '-' + pad2(p.m) + '-' + pad2(new Date(Date.UTC(p.y, p.m, 0)).getUTCDate()) }; }
    if (id === 'last_3_months') { const p = back(2); return { from: p.y + '-' + pad2(p.m) + '-01', to: t }; }
    if (id === 'this_year') return { from: y + '-01-01', to: t };
    return null;
  }
  function pctOf(n, base) { return base > 0 ? Math.round(1000 * n / base) / 10 : null; }
  function fmtPct(p) { return p === null || p === undefined ? '—' : (Math.round(p * 10) / 10) + '%'; }
  /* «תפוסה היום»: the occupancy totals + the overall percentage. Pure. */
  function occupancyToday(patients) {
    const o = occupancy(patients);
    return Object.assign({}, o, { pct: o.totalCap ? Math.round(100 * o.totalIn / o.totalCap) : 0 });
  }
  /* The classic computeDisposition (app.js): explicit → legacy reason → 'not_relevant'. Pure. */
  function closedDisposition(l) {
    const d = s(l && l.disposition);
    if (d === 'not_relevant' || d === 'completed' || d === 'stopped_early' || d === 'released_outpatient') return d;
    const r = s(l && l.not_relevant_reason);
    if (r === 'stopped_from_house' || r === 'stopped_new') return 'stopped_early';
    return 'not_relevant';
  }
  const ENTERED_LEAD_STAGES = ['admitted', 'entered', 'entry'];
  /* Every real lead once (board first, then closed), with its fate.
   *   inpatient  — a Patients / discharge row links to it (fromLead), or its stage is admitted
   *   outpatient — handed to Outpatient (AuditLog send), closed «משוחרר לטיפול חוץ», or an
   *                «אמבולטורי» meeting with outcome «נכנסים לטיפול»
   *   notRelevant / otherClosed — a closed lead (by disposition)
   *   open       — still on the board
   * `source: 'direct_admin'` rows (phone records) are never leads; `direct_approach`
   * (a patient added directly) is flagged `direct` and kept OUT of the conversion base. Pure. */
  function leadFates(data, c) {
    const d = data && typeof data === 'object' ? data : {};
    const linked = {};
    (c.patients || []).forEach(function (p) { if (s(p.fromLead)) linked[s(p.fromLead)] = true; });
    (c.discharges || []).forEach(function (x) { if (s(x.fromLead)) linked[s(x.fromLead)] = true; });
    const sent = c.outpatientSent || {};
    const seen = {}, out = [];
    const add = function (l, closed) {
      if (!l || typeof l !== 'object') return;
      const id = s(l.id);
      if (id && seen[id]) return;
      if (id) seen[id] = true;
      if (s(l.source) === 'direct_admin') return;
      const stage = s(l.stage);
      const disp = closed ? closedDisposition(l) : '';
      let fate;
      if (linked[id] || ENTERED_LEAD_STAGES.indexOf(stage) >= 0) fate = 'inpatient';
      else if (sent[id] || disp === 'released_outpatient' || (s(l.meetingWith) === MEETING_WITH_AMBULATORY && s(l.meetingOutcome) === 'entered')) fate = 'outpatient';
      else if (closed) fate = disp === 'not_relevant' ? 'notRelevant' : 'otherClosed';
      else fate = 'open';
      out.push({ id: id, name: s(l.name), house: houseName(l.house), houseKnown: !!houseId(l.house), source: s(l.source), created: isoDay(l.created), visitDate: isoDay(l.visitDate),
        reportedAt: isoDay(l.meetingReportedAt), meetingWith: s(l.meetingWith), fate: fate, direct: s(l.source) === 'direct_approach', closed: !!closed });
    };
    (c.leads || []).forEach(function (l) { add(l, false); });
    (Array.isArray(d.irrelevantLeads) ? d.irrelevantLeads : []).forEach(function (l) { add(l, true); });
    return out;
  }
  const FATES = [
    { id: 'inpatient', label: 'נכנסו לאשפוז (בית)' }, { id: 'outpatient', label: 'עברו לאמבולטורי' },
    { id: 'open', label: 'עדיין פתוחים' }, { id: 'notRelevant', label: 'נסגרו — לא רלוונטי' }, { id: 'otherClosed', label: 'נסגרו — אחר' },
  ];
  /* «המרת לידים»: the leads CREATED in [from, to] → how many became patients. Pure. */
  function leadConversion(data, c, from, to) {
    const all = leadFates(data, c);
    const inRange = all.filter(function (l) { return l.created && l.created >= from && l.created <= to; });
    const base = inRange.filter(function (l) { return !l.direct; });
    const counts = {}; FATES.forEach(function (f) { counts[f.id] = 0; });
    base.forEach(function (l) { counts[l.fate]++; });
    const converted = counts.inpatient + counts.outpatient;
    const byHouse = {};
    // only real houses get a row: a blank or damaged house name (U+FFFD) is counted apart, never shown
    base.filter(function (l) { return l.houseKnown; }).forEach(function (l) {
      const k = l.house;
      const r = byHouse[k] || (byHouse[k] = { house: k, total: 0, inpatient: 0, outpatient: 0 });
      r.total++; if (l.fate === 'inpatient') r.inpatient++; if (l.fate === 'outpatient') r.outpatient++;
    });
    const houses = Object.keys(byHouse).map(function (k) { const r = byHouse[k]; return Object.assign(r, { pct: pctOf(r.inpatient + r.outpatient, r.total) }); })
      .sort(function (a, b) { return b.total - a.total || a.house.localeCompare(b.house, 'he'); });
    return {
      total: base.length, converted: converted, pct: pctOf(converted, base.length), counts: counts,
      pcts: FATES.reduce(function (o, f) { o[f.id] = pctOf(counts[f.id], base.length); return o; }, {}),
      direct: inRange.filter(function (l) { return l.direct; }).length,
      noCreated: all.filter(function (l) { return !l.created && !l.direct; }).length,
      noHouse: base.filter(function (l) { return !l.houseKnown; }).length,
      houses: houses, rows: base,
    };
  }
  /* A manager name as recorded in «נפגש/ת עם» is used only when it IS a name: Hebrew letters
   * (and spaces / quotes / hyphen), no digits, no damaged characters — never a timestamp, a stage
   * key or a blank (Sandra 05/11/2026: «אם אין לנו שם של מנהל אל תכניס את זה»). Pure. */
  /* Roles / placeholders that are not a person's name. */
  const MANAGER_PLACEHOLDERS = ['ממלא מקום', 'ממלא/ת מקום', 'ממלאת מקום', 'אמבולטורי', 'ללא', 'ללא מנהל', 'ללא מנהל/ת', 'אחר', 'לא ידוע'];
  function managerNameOk(v) {
    const t = s(v);
    if (!t || t.length > 40 || /[\uFFFD0-9]/.test(t)) return false;
    if (!/^[\u05D0-\u05EA\s"'\u05F3\u05F4.\-]+$/.test(t)) return false;
    if (MANAGER_PLACEHOLDERS.indexOf(t.replace(/\s+/g, ' ')) >= 0) return false;
    return (t.match(/[\u05D0-\u05EA]/g) || []).length >= 2;
  }
  /* «סגירה לפי מנהל/ת»: the intake meetings held in [from, to] (visit day passed, or a
   * manager report in the period when there is no visit day), grouped by «נפגש/ת עם».
   * closed = became a patient (house or outpatient); lost = closed without entering. Pure. */
  function managerCloseRates(data, c, from, to, today) {
    const by = {};
    let skipped = 0;
    leadFates(data, c).forEach(function (l) {
      if (l.direct) return;
      const day = l.visitDate || l.reportedAt;
      if (!day || day < from || day > to || day > s(today)) return;
      if (!managerNameOk(l.meetingWith)) { skipped++; return; }
      const k = l.meetingWith;
      const r = by[k] || (by[k] = { manager: k, meetings: 0, entered: 0, lost: 0, open: 0, leads: [] });
      r.meetings++;
      if (l.fate === 'inpatient' || l.fate === 'outpatient') r.entered++;
      else if (l.fate === 'open') r.open++;
      else r.lost++;
      r.leads.push(l);
    });
    const rows = Object.keys(by).map(function (k) { const r = by[k]; return Object.assign(r, { closePct: pctOf(r.entered, r.meetings), lostPct: pctOf(r.lost, r.meetings) }); })
      .sort(function (a, b) { return (b.closePct || 0) - (a.closePct || 0) || b.meetings - a.meetings || a.manager.localeCompare(b.manager, 'he'); });
    const tot = rows.reduce(function (t, r) { t.meetings += r.meetings; t.entered += r.entered; t.lost += r.lost; t.open += r.open; return t; }, { meetings: 0, entered: 0, lost: 0, open: 0 });
    tot.closePct = pctOf(tot.entered, tot.meetings); tot.lostPct = pctOf(tot.lost, tot.meetings);
    return { rows: rows, total: tot, skipped: skipped };
  }

  /* «נקודת איזון» — the classic tab's model (app.js BREAKEVEN_DEFAULTS /
   * computeHouseMetrics / computeNetworkMetrics, CHANGELOG-breakeven-ex-vat.md),
   * mirrored. The expenses are the SAME browser-stored figures the classic tab
   * edits (localStorage 'ezone-breakeven-v1', same origin), else the defaults of
   * the financial analysis. Revenue = the real monthly pay of every in-house
   * patient, ex-VAT. Finance sessions only (an ops session has no pay). */
  const BREAKEVEN_STORAGE_KEY = 'ezone-breakeven-v1';
  const VAT_RATE = 1.18;
  const BREAKEVEN_DEFAULTS = {
    hqCost: 300000,
    houses: {
      arfoni: { active: true, fixed: 147200, variable: 90000 }, rehab: { active: true, fixed: 130000, variable: 80000 },
      asher: { active: true, fixed: 170000, variable: 140000 }, pardes: { active: false, fixed: 0, variable: 0 },
      ramot: { active: true, fixed: 239000, variable: 217000 }, sde: { active: false, fixed: 147200, variable: 90000 },
    },
  };
  const PRICE_FALLBACKS = { arfoni: 30000, rehab: 30000, asher: 35000, pardes: 35000, ramot: 36000, sde: 30000 };
  /* Stored JSON (string or object) → a full config; anything unreadable → the defaults. Pure. */
  function breakevenConfig(stored) {
    let parsed = stored;
    if (typeof stored === 'string') { try { parsed = JSON.parse(stored); } catch (_) { parsed = null; } }
    const def = BREAKEVEN_DEFAULTS;
    const p = parsed && typeof parsed === 'object' ? parsed : null;
    const hq = p && p.hqCost != null && isFinite(Number(p.hqCost)) ? Number(p.hqCost) : def.hqCost;
    const houses = {};
    HOUSES.forEach(function (h) {
      const st = p && p.houses && typeof p.houses === 'object' ? p.houses[h.id] : null;
      const d0 = def.houses[h.id] || { active: false, fixed: 0, variable: 0 };
      houses[h.id] = st && typeof st === 'object'
        ? { active: !!st.active, fixed: Number(st.fixed) || 0, variable: Number(st.variable) || 0 }
        : { active: d0.active, fixed: d0.fixed, variable: d0.variable };
    });
    return { hqCost: hq, houses: houses, fromStorage: !!p };
  }
  /* The per-house and network break-even (same formulas as the classic tab). Pure. */
  function breakevenReport(patients, cfg) {
    const conf = cfg || breakevenConfig(null);
    const houses = HOUSES.map(function (h) {
      const be = conf.houses[h.id] || { active: false, fixed: 0, variable: 0 };
      const mine = (patients || []).filter(function (p) { return houseId(p.houseId) === h.id && inHouse(p); });
      const paying = mine.filter(function (p) { return (Number(p.pay) || 0) > 0; });
      const gross = paying.length ? Math.round(paying.reduce(function (t, p) { return t + (Number(p.pay) || 0); }, 0) / paying.length) : (PRICE_FALLBACKS[h.id] || 30000);
      const price = gross / VAT_RATE;
      const fixed = Number(be.fixed) || 0, variable = Number(be.variable) || 0, totalExpenses = fixed + variable;
      const capacity = h.capacity;
      const currentPatients = mine.length;
      const breakevenPoint = price > 0 ? Math.ceil(totalExpenses / price) : 0;
      const currentRevenue = mine.reduce(function (t, p) { return t + (Number(p.pay) || 0); }, 0) / VAT_RATE;
      const currentPL = currentRevenue - totalExpenses;
      return { id: h.id, name: h.name, active: !!be.active, closed: !!h.closed, fixed: fixed, variable: variable, totalExpenses: totalExpenses, price: price,
        capacity: capacity, currentPatients: currentPatients, breakevenPoint: breakevenPoint, currentRevenue: currentRevenue, currentPL: currentPL,
        marginPct: currentRevenue > 0 ? (currentPL / currentRevenue) * 100 : null, maxPL: capacity * price - totalExpenses,
        gap: Math.max(0, breakevenPoint - currentPatients), freeBeds: Math.max(0, capacity - currentPatients) };
    });
    const act = houses.filter(function (m) { return m.active; });
    const sum = function (k) { return act.reduce(function (t, m) { return t + m[k]; }, 0); };
    const totalHouseExpenses = sum('totalExpenses'), hqCost = Number(conf.hqCost) || 0, totalExpenses = totalHouseExpenses + hqCost;
    const totalRevenueCurrent = sum('currentRevenue'), totalCapacity = sum('capacity');
    const totalRevenueMax = act.reduce(function (t, m) { return t + m.capacity * m.price; }, 0);
    const avgPrice = totalCapacity > 0 ? totalRevenueMax / totalCapacity : 0;
    return {
      houses: houses,
      network: { hqCost: hqCost, totalHouseExpenses: totalHouseExpenses, totalExpenses: totalExpenses, totalRevenueCurrent: totalRevenueCurrent,
        housesPL: totalRevenueCurrent - totalHouseExpenses, networkPL: totalRevenueCurrent - totalExpenses, totalPatientsCurrent: sum('currentPatients'),
        totalCapacity: totalCapacity, networkBreakeven: avgPrice > 0 ? Math.ceil(totalExpenses / avgPrice) : 0 },
    };
  }

  /* ===== «חריגים לבדיקה» in «גבייה» (CHANGELOG-crm-kpi-tab.md) =====
   * Open things that cannot both be true. Read-only: every row opens the stays
   * it names; the fix is made on the record itself. Never a merge, never a write.
   *   stay_overlap      — two stays of the same person (same personId chain, or the
   *                       same full name) whose periods overlap: one person cannot be
   *                       in two houses (or twice in one house) at the same time
   *   exit_before_entry — a stay that ends before it starts
   *   released_no_exit  — a released stay with no exit date (the billing end is unknown)
   *   debt_after_exit   — an open debt cycle that starts after the stay's exit day
   *   zero_pay_in_house — in the house with a monthly price of 0 (nothing is charged) */
  const ANOMALY_LABELS = {
    stay_overlap: 'אותו אדם בשתי שהיות חופפות', exit_before_entry: 'תאריך יציאה לפני תאריך כניסה',
    released_no_exit: 'שוחרר/ה ללא תאריך יציאה', debt_after_exit: 'חוב על תקופה אחרי היציאה', zero_pay_in_house: 'בבית עם סכום חודשי 0',
  };
  function stayEnd(p, exitByPatient, today) {
    if (inHouse(p)) return s(today);
    return s(p.exitDate) || s(exitByPatient[s(p.id)]) || '';
  }
  function billingAnomalies(c, debt, today) {
    const pts = (c && c.patients) || [];
    const exitBy = {};
    ((c && c.discharges) || []).forEach(function (d) { if (!d.deletedAt && !isRestoredDischarge(d) && d.patientId && d.exitDate) exitBy[d.patientId] = d.exitDate; });
    const rows = [];
    const stay = function (p) { return { id: p.id, name: p.name, house: houseName(p.houseId), date: p.date, exitDate: stayEnd(p, exitBy, today), status: p.status }; };
    /* group by person: union of personId chains and full names (2+ words) */
    const parent = {};
    const find = function (x) { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
    const unite = function (a, b) { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };
    const keyOfName = {}, keyOfPerson = {};
    const placed = pts.filter(function (p) { return s(p.id) && s(p.date); });
    placed.forEach(function (p) { parent[p.id] = p.id; });
    placed.forEach(function (p) {
      const pk = s(p.personId) || '';
      if (pk) { if (parent[pk] !== undefined) unite(p.id, pk); if (keyOfPerson[pk]) unite(p.id, keyOfPerson[pk]); keyOfPerson[pk] = p.id; }
      const nk = nameKey(p.name);
      if (nk.split(' ').length >= 2) { if (keyOfName[nk]) unite(p.id, keyOfName[nk]); keyOfName[nk] = p.id; }
    });
    const groups = {};
    placed.forEach(function (p) { const r = find(p.id); (groups[r] || (groups[r] = [])).push(p); });
    Object.keys(groups).forEach(function (g) {
      const list = groups[g].slice().sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const a = list[i], b = list[j];
          const ae = stayEnd(a, exitBy, today), be = stayEnd(b, exitBy, today);
          if (!ae || !be) continue;
          // overlap: each starts before the other ends (a move on the exit day is not an overlap)
          if (!(a.date < be && b.date < ae)) continue;
          const from = a.date > b.date ? a.date : b.date, to = ae < be ? ae : be;
          const sameHouse = houseId(a.houseId) === houseId(b.houseId);
          const samePerson = !!s(a.personId) && (s(a.personId) === s(b.personId) || s(a.personId) === s(b.id)) || (!!s(b.personId) && s(b.personId) === s(a.id));
          rows.push({ id: 'an:overlap:' + a.id + ':' + b.id, kind: 'stay_overlap', name: a.name, house: sameHouse ? houseName(a.houseId) : houseName(a.houseId) + ' + ' + houseName(b.houseId),
            why: (sameHouse ? 'שתי שהיות חופפות באותו בית' : 'רשום/ה בשני בתים באותה תקופה') + ' · ' + fmtDate(from) + '–' + fmtDate(to) + ' (' + daysBetween(from, to) + ' ימים)'
              + (samePerson ? '' : ' · זוהה לפי שם מלא — לוודא שזה אותו אדם'),
            when: from, stays: [stay(a), stay(b)], basis: samePerson ? 'person' : 'name' });
        }
      }
    });
    pts.forEach(function (p) {
      if (!s(p.id)) return;
      const end = inHouse(p) ? '' : (s(p.exitDate) || s(exitBy[p.id]));
      if (!inHouse(p) && p.date && end && end < p.date) rows.push({ id: 'an:order:' + p.id, kind: 'exit_before_entry', name: p.name, house: houseName(p.houseId), why: 'כניסה ' + fmtDate(p.date) + ' · יציאה ' + fmtDate(end), when: p.date, stays: [stay(p)] });
      if (!inHouse(p) && !end) rows.push({ id: 'an:noexit:' + p.id, kind: 'released_no_exit', name: p.name, house: houseName(p.houseId), why: 'מועד סיום החיוב אינו ידוע', when: p.date, stays: [stay(p)] });
      if (inHouse(p) && p.pay === 0 && p.date && p.date <= s(today)) rows.push({ id: 'an:zero:' + p.id, kind: 'zero_pay_in_house', name: p.name, house: houseName(p.houseId), why: 'לא נוצר חיוב חודשי — לבדוק סכום / פרו-בונו', when: p.date, stays: [stay(p)] });
    });
    const d = debt && debt.ok !== false && Array.isArray(debt.byPatient) ? debt : null;
    if (d) {
      const byId = {};
      pts.forEach(function (p) { if (p.id) byId[p.id] = p; });
      d.byPatient.forEach(function (x) {
        const p = byId[s(x.patientId)];
        if (!p || inHouse(p)) return;
        const end = s(p.exitDate) || s(exitBy[p.id]);
        if (!end) return;
        const late = (Array.isArray(x.cycles) ? x.cycles : []).filter(function (cy) { const st = sheetDay(cy.start); return st && st > end && (Number(cy.balance) || 0) > 0; });
        if (!late.length) return;
        const amt = Math.round(late.reduce(function (t, cy) { return t + (Number(cy.balance) || 0); }, 0));
        rows.push({ id: 'an:afterexit:' + p.id, kind: 'debt_after_exit', name: p.name, house: houseName(p.houseId),
          why: late.length + ' מחזורים · ' + fmtMoney(amt) + ' אחרי יציאה ב-' + fmtDate(end), when: end, stays: [stay(p)], amount: amt });
      });
    }
    const order = { stay_overlap: 0, debt_after_exit: 1, exit_before_entry: 2, released_no_exit: 3, zero_pay_in_house: 4 };
    rows.sort(function (a, b) { return (order[a.kind] - order[b.kind]) || (a.when < b.when ? -1 : a.when > b.when ? 1 : 0); });
    return rows.map(function (r) { return Object.assign(r, { label: ANOMALY_LABELS[r.kind] }); });
  }

  /* «סגירת ליד»: a status AND a reason (Sandra 05/11/2026 — nothing closes with a field missing). Pure. */
  function closeLeadErrors(v) {
    const out = {};
    if (!DISPOSITIONS.some(function (d) { return d.id === s(v && v.disposition); })) out.disposition = 'יש לבחור סטטוס סגירה';
    if (s(v && v.note).length < 2) out.note = 'יש לפרט סיבה';
    return out;
  }

  /* The actions the CRM still sends to the classic dashboard (CHANGELOG-crm-kpi-tab.md) —
   * the decision list for what moves next. Static and documented. */
  const CLASSIC_ONLY = [
    { id: 'receipt_full_edit', label: 'עריכת קבלות מורחבת (מעבר לתיקון/ביטול בכרטיס)', where: 'גבייה' },
    { id: 'billing_control', label: 'בקרת גבייה — אימות דיווחים (אורטל)', where: 'גבייה' },
    { id: 'override_delete', label: 'מחיקת התאמת חיוב (override)', where: 'גבייה' },
    { id: 'released_edit', label: 'עריכת שהייה של מטופל/ת משוחרר/ת (תאריכים) — נדרש לפתרון חפיפות', where: 'מטופלים' },
    { id: 'patient_delete', label: 'מחיקת מטופל/ת', where: 'מטופלים' },
    { id: 'returning_match', label: 'זיהוי מטופל/ת חוזר/ת בקליטה', where: 'תפוסה' },
    { id: 'unknown_house', label: 'תיקון מטופלים ב«בית לא מזוהה»', where: 'תפוסה' },
    { id: 'excel_exports', label: 'ייצוא לאקסל (גבייה, חובות, החזרים, חתכים)', where: 'דוחות' },
    { id: 'revenue_growth', label: 'הכנסות חודשיות וגרף צמיחה', where: 'דוחות' },
  ];

  function boot(win, doc) {
    // This map is deliberately session-memory only; reload requires a source
    // read before any new write after an uncertain outcome.
    const pendingLeadFlags = Object.create(null);
    const state = { me: null, data: null, area: 'today', view: 'board', filters: { q: '', house: '', owner: '' }, kpiFilter: '', queue: null,
      today: new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date()), drawer: null, error: '', loading: true, sort: 'name',
      tasks: null, tasksError: '', contact: null, index: null, debt: null, payments: null, credits: null, dayView: 'today', week: '', domain: '', workControl: '', doneTasks: undefined, quick: '' };
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
      let m = null;
      try { m = c && state.me && state.me.view !== 'controller' ? model(c) : null; } catch (_) { m = null; }
      const item = function (a) {
        let n = '';
        if (c && a.id === 'today') n = state.me && state.me.view === 'controller' ? (state.queue && state.queue.ok !== false ? ortalDay(state.queue, state.tasks, state.credits, state.today, {}).cards[0].value : '') : (m ? m.urgent.length + m.byDomain.calls.filter(function (r) { return r.state === 'late' || r.state === 'today'; }).length : '');
        if (c && a.id === 'leads') n = filterLeads(c.leads, {}).length;
        return '<button type="button" data-area="' + a.id + '"' + (state.area === a.id ? ' aria-current="page"' : '') + '><span><i class="ic">' + (AREA_ICONS[a.id] || '•') + '</i>' + esc(a.label) + '</span>' + (n !== '' ? '<span class="n">' + esc(n) + '</span>' : '') + '</button>';
      };
      navEl.innerHTML = NAV_GROUPS.map(function (g) {
        const list = AREAS.filter(function (a) { return g.items.indexOf(a.id) >= 0 && areas.indexOf(a.id) >= 0; });
        if (!list.length) return '';
        return (g.label ? '<div class="nav-group">' + esc(g.label) + '</div>' : '') + list.map(item).join('');
      }).join('');
      const dateEl = $('#crm-date'); if (dateEl) dateEl.textContent = hebDate(state.today);
      remindTick();   // a task due within the reminder window is announced as soon as the tasks arrive
    }

    function chip(state_, text) { return '<span class="chip ' + esc(state_) + '">' + esc(text) + '</span>'; }
    /* Monday-style owner avatar: initial in a colour derived from the name (stable per person). */
    function avatar(name) {
      const n = s(name); if (!n) return '<span class="who none">—</span>';
      let h = 0; for (let i = 0; i < n.length; i++) h = (h * 31 + n.charCodeAt(i)) % 360;
      return '<span class="who"><i class="av" style="--h:' + h + '">' + esc(n.charAt(0)) + '</i>' + esc(n) + '</span>';
    }
    function patientStatusLabel(st) { if (s(st) === 'released') return 'שוחרר/ה'; const x = PATIENT_STATUSES.filter(function (p) { return p.id === s(st); })[0]; return x ? x.label : (s(st) || '—'); }
    function statusChip(st) { return '<span class="chip pst-' + esc(s(st) || 'active') + '">' + esc(patientStatusLabel(st)) + '</span>'; }
    function houseTag(idOrName) { const id = houseId(idOrName) || 'x'; return '<span class="chip house h-' + esc(id) + '">' + esc(houseName(idOrName) || '—') + '</span>'; }
    const AREA_ICONS = { today: '☀', leads: '✉', clients: '👤', calendar: '📅', occupancy: '🏠', billing: '₪', control: '✔', kpi: '📊', triage: '🔎' };
    function stateText(st) { return st === 'late' ? 'באיחור' : st === 'today' ? 'להיום' : 'ממתין'; }

    function renderToday(c) {
      if (state.me && state.me.view === 'controller') return renderControllerToday();
      return renderMyDay(c);
    }
    /* ---- Stage 2: «היום שלי» ---- */
    function model(c) { return myDay(c, state.tasks, state.index, state.debt, state.today, state.me, { house: state.filters.house, owner: state.filters.owner }, state.payments); }
    function rowButtons(r) {
      const b = [];
      const subj = r.subjectKind + ':' + r.subjectId;
      const openAttr = ' data-open-' + r.subjectKind + '="' + esc(r.subjectId) + '"' + (r.open ? ' data-open-tab="' + esc(r.open) + '"' : '') + (r.focusMeeting ? ' data-focus-meeting="1"' : '');
      if (r.task && (r.task.kind === 'call' || r.task.kind === 'collection')) b.push('<button type="button" class="btn small primary" data-contact-open="' + esc(subj) + '" data-task-id="' + esc(r.task.id) + '">תיעוד שיחה</button>');
      else if (r.task) b.push('<button type="button" class="btn small primary" data-task-done="' + esc(r.task.id) + '">סיום</button>');
      else if (r.contactable) b.push('<button type="button" class="btn small primary" data-contact-open="' + esc(subj) + '">תיעוד שיחה</button>');
      else if (r.focusMeeting) b.push('<button type="button" class="btn small primary"' + openAttr + '>קביעת תאריך</button>');
      else if (r.classic) b.push('<a class="btn small primary" href="/?view=classic">לבקרת גבייה</a>');
      else if (r.open) b.push('<button type="button" class="btn small primary"' + openAttr + '>' + (r.kind === 'continuity' ? 'לעדכון' : r.kind === 'meeting_today' ? 'פרטי הפגישה' : r.open === 'meetings' ? 'לדיווח' : r.open === 'account' ? 'לחשבון' : 'פתיחה') + '</button>');
      if (r.task) b.push('<button type="button" class="btn small" data-task-resched="' + esc(r.task.id) + '">שינוי מועד</button>');
      if (!r.classic || (state.me && state.me.view !== 'controller')) b.push('<button type="button" class="btn small" data-open-' + esc(r.subjectKind) + '="' + esc(r.subjectId) + '">כרטיס</button>');
      return b.join('');
    }
    function stateChip(r) {
      const st = r.state === 'undated' ? 'wait' : r.state;
      const txt = r.state === 'undated' ? 'ללא תאריך' : r.priority === 'exception' ? '⚠ חריג' : r.state === 'late' ? '⏰ באיחור' : r.state === 'today' ? '● להיום' : r.waitingOn ? '◷ ממתין ל' + r.waitingOn : '◷ ממתין';
      return chip(r.priority === 'exception' ? 'late' : st, txt);
    }
    function workRow(r) {
      return '<div class="row work' + (r.task ? ' task' : '') + '" data-row="' + esc(r.id) + '">'
        + '<span><button type="button" class="link name" data-open-' + esc(r.subjectKind) + '="' + esc(r.subjectId) + '">' + esc(r.name) + '</button><br><span class="sub">' + esc(r.house) + (r.contact ? ' · ' + esc(r.contact) : '') + '</span></span>'
        + '<span><strong>' + esc(r.action) + '</strong>' + (r.why ? '<br><span class="sub">' + esc(r.why) + '</span>' : '') + '</span>'
        + '<span>' + esc(r.whenText || (r.when ? fmtDate(r.when) + (r.time ? ' ' + r.time : '') : (r.task ? 'ללא תאריך — קבעי תאריך' : '—'))) + '<br>' + stateChip(r) + '</span>'
        + '<span>' + avatar(r.owner) + '</span>'
        + '<span class="sub">' + esc(r.lastContact || '') + '</span>'
        + '<span class="toolbar">' + rowButtons(r) + '</span></div>'
        + (r.task ? '<div class="task-form" data-task-form="' + esc(r.task.id) + '"></div>' : '');
    }
    function rowsBlock(rows, cap) {
      if (!rows.length) return '<p class="na">אין פריטים.</p>';
      const list = cap ? rows.slice(0, cap) : rows;
      return '<div class="rows"><div class="row work h"><span>לקוח</span><span>הפעולה ולמה עכשיו</span><span>מועד ומצב</span><span>אחראי</span><span>מגע אחרון</span><span></span></div>' + list.map(workRow).join('') + '</div>'
        + (cap && rows.length > cap ? '<p class="na">מוצגים ' + cap + ' מתוך ' + rows.length + ' · <button type="button" class="link" data-domain="' + esc(list[0].domain) + '">לרשימה המלאה</button></p>' : '');
    }
    function weekBar(ws, idPrefix) {
      const we = addDays(ws, 6);
      return '<div class="toolbar week-bar"><button type="button" class="btn small" data-week-step="-7">‹ שבוע קודם</button><strong>' + esc(fmtDate(ws) + ' – ' + fmtDate(we)) + '</strong><button type="button" class="btn small" data-week-step="7">שבוע הבא ›</button>'
        + '<input type="date" id="' + idPrefix + '-week" value="' + esc(ws) + '" aria-label="בחירת שבוע"><button type="button" class="btn small" data-week-today>השבוע הנוכחי</button></div>';
    }
    function renderMyDay(c) {
      const m = model(c);
      const view = state.dayView || 'today';
      let html = '<div class="day-head"><div class="day-date">' + esc(state.me && state.me.user ? state.me.user : '') + '</div>'
        + '<div class="seg" role="tablist">' + MY_DAY_VIEWS.map(function (v) { return '<button type="button" data-day-view="' + v.id + '" aria-pressed="' + (view === v.id) + '">' + esc(v.label) + '</button>'; }).join('') + '</div></div>';
      html += '<div class="toolbar filters">'
        + '<select id="f-owner" aria-label="אחראי"><option value="">כל האחראים</option>' + ASSIGNEES.map(function (a) { return '<option' + (state.filters.owner === a ? ' selected' : '') + '>' + esc(a) + '</option>'; }).join('') + '</select>'
        + '<select id="f-house" aria-label="בית"><option value="">כל הבתים</option>' + HOUSES.filter(function (h) { return !h.closed; }).map(function (h) { return '<option value="' + h.id + '"' + (houseName(state.filters.house) === h.name ? ' selected' : '') + '>' + esc(h.name) + '</option>'; }).join('') + '</select>'
        + '<span class="grow"></span><button type="button" class="btn primary" data-quick="contact">📞 תיעוד שיחה</button><button type="button" class="btn" data-quick="task">＋ משימה חדשה</button><button type="button" class="btn" data-quick="meeting">📅 פגישה</button></div>'
        + '<div id="crm-quick"></div>';
      if (view === 'week') return html + renderWeek(m);
      if (view === 'done') return html + renderDone(c);
      // summary strip
      html += '<div class="kpis cards">' + m.cards.map(function (k) {
        return '<button type="button" class="kpi acc-' + esc(k.id) + '" data-domain="' + k.id + '" aria-pressed="' + (state.domain === k.id) + '">'
          + (k.value === null ? '<span class="v na-v">—</span>' : '<span class="v">' + k.value + '</span>') + '<span class="l">' + esc(k.label) + '</span>'
          + (k.second ? '<span class="l2"><b>' + k.second.value + '</b> ' + esc(k.second.label) + '</span>' : '') + (k.hint ? '<span class="l2">' + esc(k.hint) + '</span>' : '') + '</button>';
      }).join('') + '</div>';
      // The urgent band on top of the day is gone (Vered 04/11/2026): it repeated rows that are
      // already in their domain below and in «פגישות היום» on the side.
      const drill = WORK_CONTROL.filter(function (q) { return q.id === state.workControl; })[0];
      if (drill) {
        const rows = workControlQueues(m)[drill.id];
        const unavailable = drill.id === 'late' && !m.sourceState.tasks;
        return html + '<section class="domain" data-control-section="' + drill.id + '"><div class="group-title"><strong>' + esc(drill.label) + '</strong> <span class="n chip">' + (unavailable ? '—' : rows.length) + '</span><span class="grow"></span><button type="button" class="link" data-domain="">חזרה לכל התחומים</button></div>'
          + (unavailable ? '<p class="na">המידע אינו זמין</p>' : rowsBlock(rows, 0)) + '</section>';
      }
      const domains = DOMAINS.filter(function (d) { return (state.domain ? d.id === state.domain : true) && !(d.money && !(state.me && state.me.finance)); });
      let main = '';
      domains.forEach(function (d) {
        const rows = m.byDomain[d.id] || [];
        if (d.onlyIfAny && !rows.length && state.domain !== d.id) return;
        main += '<section class="domain acc-' + d.id + '" data-domain-section="' + d.id + '"><div class="group-title"><strong>' + esc(d.label) + '</strong> <span class="n chip">' + rows.length + '</span>'
          + (d.id === 'collection' && m.sourceState.collection !== 'complete' ? ' <span class="chip ' + (m.sourceState.collection === 'loading' ? 'wait">טוען…' : 'late">מידע חלקי') + '</span>' : '') + (d.id === 'calls' && !state.tasks ? ' <span class="chip ' + (state.tasks === undefined ? 'wait">טוען…' : 'late">המידע אינו זמין') + '</span>' : '') + (d.id === 'newleads' && (!m.sourceState.contact || !m.sourceState.tasks) ? ' <span class="chip ' + (state.index === undefined || state.tasks === undefined ? 'wait">טוען…' : 'late">המידע אינו זמין') + '</span>' : '')
          + '<span class="grow"></span>' + (d.id === 'newleads' && rows.length ? '<button type="button" class="btn small" data-area="triage">סבב בירור — אחת אחרי השנייה</button>' : '') + (state.domain ? '<button type="button" class="link" data-domain="' + d.id + '">חזרה לכל התחומים</button>' : '') + '</div>'
          + rowsBlock(rows, state.domain ? 0 : 8) + '</section>';
      });
      if (!main) main = (m.sourceState.contact && m.sourceState.tasks && m.sourceState.collection !== 'loading' && m.sourceState.collection !== 'partial') ? '<div class="crm-state">אין משימות פתוחות היום 🎉</div>' : '<div class="crm-state">חלק ממקורות המידע חסרים — אין אפשרות לאשר שאין משימות פתוחות.</div>';
      const side = '<aside class="day-side">'
        + '<div class="side-box"><div class="group-title">פגישות היום <span class="n chip">' + m.meetingsToday.length + '</span></div>' + (m.meetingsToday.length ? '<ul class="mini">' + m.meetingsToday.map(function (r) { return '<li><button type="button" class="link" data-open-lead="' + esc(r.subjectId) + '" data-open-tab="meetings">' + esc((r.time || '—') + ' · ' + r.name) + '</button><span class="sub">' + esc(r.house + ' · ' + r.why) + '</span></li>'; }).join('') + '</ul>' : '<p class="na">אין פגישות היום.</p>') + '</div>'
        + '<div class="side-box"><div class="group-title">ממתין לגורם אחר <span class="n chip">' + m.waiting.length + '</span></div>' + (m.waiting.length ? '<ul class="mini">' + m.waiting.slice(0, 8).map(function (r) { return '<li><button type="button" class="link" data-open-' + esc(r.subjectKind) + '="' + esc(r.subjectId) + '"' + (r.open ? ' data-open-tab="' + esc(r.open) + '"' : '') + '>' + esc(r.name) + '</button><span class="sub">' + esc('ממתין ל' + r.waitingOn + ' · מאז ' + fmtDate(r.when)) + '</span></li>'; }).join('') + '</ul>' : '<p class="na">אין המתנות.</p>') + '</div>'
        + '</aside>';
      return html + '<div class="day-grid"><div class="day-main">' + main + '</div>' + side + '</div>';
    }
    function renderWeek(m) {
      const ws = weekStart(state.week || state.today);
      const w = weekPlan(m, ws, compute(state.data, state.today), state.filters, state.today);
      let html = weekBar(ws, 'crm-day');
      html += '<div class="week">' + w.days.map(function (d) {
        return '<section class="wday' + (d.date === state.today ? ' is-today' : '') + '"><div class="group-title"><strong>' + esc(d.name) + '</strong> ' + esc(fmtDate(d.date)) + ' <span class="n chip">' + d.rows.length + '</span></div>' + (d.rows.length ? rowsBlock(d.rows, 0) : '<p class="na">—</p>') + '</section>';
      }).join('') + '</div>';
      if (w.undated.length) html += '<section class="domain"><div class="group-title">משימות ללא תאריך — קבעי תאריך <span class="n chip">' + w.undated.length + '</span></div>' + rowsBlock(w.undated, 0) + '</section>';
      return html;
    }
    function renderDone(c) {
      const ws = weekStart(state.week || state.today);
      let html = weekBar(ws, 'crm-day');
      if (state.doneTasks === undefined) { loadDone(); return html + '<div class="crm-state">טוען…</div>'; }
      if (state.doneTasks === null) return html + '<div class="crm-state">המידע אינו זמין <button type="button" class="btn small" data-done-retry>נסי שוב</button></div>';
      const rows = doneInWeek(state.doneTasks, ws, c);
      if (!rows.length) return html + '<p class="na">לא הושלמו משימות בשבוע זה.</p>';
      return html + '<div class="rows"><div class="row done h"><span>לקוח</span><span>המשימה</span><span>מי</span><span>מתי</span><span>תוצאה</span><span></span></div>' + rows.map(function (r) {
        return '<div class="row done"><span><span class="name">' + esc(r.name) + '</span><br><span class="sub">' + esc(r.house) + '</span></span><span>' + esc(r.action) + '<br><span class="sub">' + esc(r.kind) + '</span></span><span>' + esc(r.who || '—') + '</span><span>' + esc(whenLocal(r.at)) + '</span><span>' + chip(r.task.status === 'done' ? 'ok' : 'wait', r.outcome) + '</span><span><button type="button" class="btn small" data-open-' + esc(r.subjectKind) + '="' + esc(r.subjectId) + '">כרטיס</button></span></div>';
      }).join('') + '</div>';
    }
    function loadDone() {
      api('getTasks', { status: 'done', limit: 500 }).then(function (r) {
        if (r && r.ok === true && Array.isArray(r.tasks)) state.doneTasks = r.tasks; else state.doneTasks = null;
        return api('getTasks', { status: 'cancelled', limit: 200 }).then(function (r2) { if (state.doneTasks && r2 && r2.ok === true && Array.isArray(r2.tasks)) state.doneTasks = state.doneTasks.concat(r2.tasks); });
      }).catch(function () { state.doneTasks = null; }).then(function () { if (state.area === 'today' && state.dayView === 'done') renderMain(); });
    }
    /* Quick actions: pick a subject, then the panel / the card. */
    function renderQuick(kind) {
      const el = $('#crm-quick'); if (!el) return;
      state.quick = kind;
      el.innerHTML = '<div class="quick"><label>' + esc(kind === 'contact' ? 'תיעוד שיחה — עם מי?' : kind === 'task' ? 'משימה חדשה — עבור מי?' : 'פגישה — איזה ליד?') + ' <input type="search" id="crm-quick-q" placeholder="שם / טלפון" autocomplete="off"></label><div id="crm-quick-list" class="quick-list"></div><button type="button" class="btn small" data-quick-cancel>סגור</button></div>';
      $('#crm-quick-q').focus();
      quickList('');
    }
    function quickList(q) {
      const el = $('#crm-quick-list'); if (!el) return;
      const c = compute(state.data, state.today);
      const needle = s(q).toLowerCase();
      const leads = c.leads.filter(function (l) { return STAGES.some(function (st) { return st.id === l.stage; }) && (!needle || (l.name + ' ' + l.phone).toLowerCase().indexOf(needle) >= 0); }).slice(0, 8);
      const pats = state.quick === 'meeting' ? [] : c.patients.filter(function (p) { return inHouse(p) && (!needle || p.name.toLowerCase().indexOf(needle) >= 0); }).slice(0, 6);
      if (!needle) { el.innerHTML = '<p class="na">הקלידי שם או טלפון.</p>'; return; }
      const pick = function (kind, id, name, sub) { return '<button type="button" class="pick" data-quick-pick="' + kind + ':' + esc(id) + '">' + esc(name) + ' <span class="sub">' + esc(sub) + '</span></button>'; };
      const items = leads.map(function (l) { return pick('lead', l.id, l.name, 'ליד · ' + houseName(l.house) + (s(l.phone) ? ' · ' + s(l.phone) : '')); })
        .concat(pats.map(function (p) { return pick('patient', p.id, p.name, 'מטופל/ת · ' + houseName(p.houseId)); }));
      el.innerHTML = items.length ? items.join('') : '<p class="na">לא נמצא.</p>';
    }
    function renderControllerToday() {
      const o = ortalDay(state.queue, state.tasks, state.credits, state.today, { house: state.filters.house });
      const sets = { toVerify: ['דיווחים לאימות', 'אימות בדשבורד הרגיל → בקרת גבייה'], flagged: ['אימותים חלקיים / לבירור', 'החלטה בדשבורד הרגיל'], documents: ['חשבוניות מבוקשות', 'ההנפקה בחשבשבת; כאן רק הבקשה'], tasks: ['משימות כספיות שלך', ''], credits: ['זיכויים לתשלום', '«סמן כשולם» ב«גבייה»'] };
      let html = '<div class="day-head"><div class="day-date">' + esc(state.me && state.me.user ? state.me.user : '') + '</div></div>'
        + '<div class="toolbar filters"><select id="f-house" aria-label="בית"><option value="">כל הבתים</option>' + HOUSES.filter(function (h) { return !h.closed; }).map(function (h) { return '<option value="' + h.id + '"' + (houseName(state.filters.house) === h.name ? ' selected' : '') + '>' + esc(h.name) + '</option>'; }).join('') + '</select><span class="grow"></span><a class="btn primary" href="/?view=classic">בקרת גבייה — העבודה המלאה</a></div>'
        + '<div class="kpis cards">' + o.cards.map(function (k) { return '<button type="button" class="kpi acc-' + esc(k.id) + '" data-domain="' + k.id + '" aria-pressed="' + (state.domain === k.id) + '">' + (k.value === null ? '<span class="v na-v">—</span>' : '<span class="v">' + k.value + '</span>') + '<span class="l">' + esc(k.label) + '</span>' + (k.hint ? '<span class="l2">' + esc(k.hint) + '</span>' : '') + '</button>'; }).join('') + '</div>';
      if (o.urgent.length && !state.domain) html += '<section class="urgent"><div class="group-title">⚠ דורש החלטה / באיחור <span class="n chip">' + o.urgent.length + '</span></div>' + rowsBlock(o.urgent, 8) + '</section>';
      Object.keys(sets).forEach(function (k) {
        if (state.domain && state.domain !== k) return;
        const rows = o.sets[k];
        if (!state.domain && !rows.length) return;
        html += '<section class="domain" data-domain-section="' + k + '"><div class="group-title"><strong>' + esc(sets[k][0]) + '</strong> <span class="n chip">' + rows.length + '</span>' + (sets[k][1] ? ' <span class="na">' + esc(sets[k][1]) + '</span>' : '') + '<span class="grow"></span>' + (state.domain ? '<button type="button" class="link" data-domain="' + k + '">חזרה לכל התחומים</button>' : '') + '</div>' + rowsBlock(rows, state.domain ? 0 : 8) + '</section>';
      });
      if (state.queue === null) html += '<div class="crm-state bad">תור האימות לא נטען <button type="button" class="btn small" id="crm-retry">נסי שוב</button></div>';
      return html;
    }

    function renderLeads(c) {
      const owners = {};
      c.leads.forEach(function (l) { if (l.assignedTo) owners[l.assignedTo] = true; });
      const f = state.filters;
      const toolbar = '<div class="toolbar"><div class="seg"><button type="button" data-view="board" aria-pressed="' + (state.view === 'board') + '">לוח</button><button type="button" data-view="table" aria-pressed="' + (state.view === 'table') + '">טבלה</button></div>'
        + '<select id="f-house"><option value="">כל הבתים</option>' + HOUSES.filter(function (h) { return h.id !== 'sde'; }).map(function (h) { return '<option value="' + esc(h.name) + '"' + (f.house === h.name ? ' selected' : '') + '>' + esc(h.name) + '</option>'; }).join('') + '</select>'
        + '<select id="f-owner"><option value="">כל האחראים</option>' + Object.keys(owners).map(function (o) { return '<option' + (f.owner === o ? ' selected' : '') + '>' + esc(o) + '</option>'; }).join('') + '</select>'
        + '<button type="button" class="btn primary" id="crm-new-lead">+ ליד חדש</button>'
        + '<button type="button" class="btn" data-view="closed" aria-pressed="' + (state.view === 'closed') + '">לידים סגורים</button>'
        + (state.tasks && state.index ? '<button type="button" class="btn" data-area="triage">רשומות שדורשות בירור <span class="n chip">' + triageQueue(c, state.tasks, state.index, state.today).length + '</span></button>' : '') + '</div>';
      if (state.view === 'closed') return toolbar + renderClosedLeads();
      // a search with no OPEN lead → the global results (admitted / patients / released), never an empty board
      if (s(f.q) && !filterLeads(c.leads, f).length) return toolbar + renderSearch(c);
      if (state.view === 'board') {
        return toolbar + '<div class="board">' + board(c.leads, f).map(function (col) {
          return '<div class="col" data-stage="' + esc(col.stage.id) + '"><h3><span>' + esc(col.stage.label) + '</span><span class="n">' + col.leads.length + '</span></h3>' + col.leads.map(function (l) {
            const na = nextActionFor(l, state.today, flagsOf(state.index, l.id));
            const inH = leadAlreadyInHouse(l, c.patients, c.leads);
            return '<div class="card" data-open-lead="' + esc(l.id) + '"><div class="name">' + esc(l.name) + (inH ? ' <span class="chip late">שם/טלפון דומה בבית ' + esc(houseName(inH.houseId)) + '</span>' : '') + '</div><div class="meta"><span>' + esc(houseName(l.house) || '—') + '</span>' + (l.source ? '<span class="chip src">' + esc(l.source) + '</span>' : '') + (l.assignedTo ? avatar(l.assignedTo) : '') + '</div>'
              + (l.created ? '<div class="meta"><span>נוצר ' + esc(fmtDate(l.created)) + '</span>' + (l.visitDate ? '<span>פגישה ' + esc(fmtDate(l.visitDate)) + (l.visitTime ? ' ' + esc(l.visitTime) : '') + '</span>' : '') + '</div>' : '')
              + '<div class="next">' + chip(na.state, na.text) + (waitChipText(l, flagsOf(state.index, l.id)) && waitChipText(l, flagsOf(state.index, l.id)) !== na.text ? ' ' + chip('wait', waitChipText(l, flagsOf(state.index, l.id))) : '') + (stageAfter(l.stage) ? ' <button type="button" class="btn small" data-stage-next="' + esc(l.id) + '">שלב הבא ←</button>' : '') + '</div></div>';
          }).join('') + '</div>';
        }).join('') + '</div>';
      }
      const list = filterLeads(c.leads, f).slice().sort(function (a, b) { return s(a[state.sort]).localeCompare(s(b[state.sort])); });
      const cols = [['name', 'שם'], ['house', 'בית'], ['source', 'מקור'], ['assignedTo', 'אחראי'], ['stage', 'שלב'], ['visitDate', 'פגישה'], ['created', 'נוצר']];
      return toolbar + '<div class="tbl-wrap"><table class="tbl"><thead><tr>' + cols.map(function (c2) { return '<th data-sort="' + c2[0] + '">' + esc(c2[1]) + (state.sort === c2[0] ? ' ▾' : '') + '</th>'; }).join('') + '<th>פעולה הבאה</th></tr></thead><tbody>'
        + list.map(function (l) { const na = nextActionFor(l, state.today, flagsOf(state.index, l.id)); return '<tr data-open-lead="' + esc(l.id) + '"><td>' + esc(l.name) + '</td><td>' + esc(houseName(l.house)) + '</td><td>' + esc(l.source) + '</td><td>' + avatar(l.assignedTo) + '</td><td><span class="chip stage-' + esc(l.stage) + '">' + esc(stageLabel(l.stage)) + '</span></td><td>' + esc(fmtDate(l.visitDate)) + '</td><td>' + esc(fmtDate(l.created)) + '</td><td>' + chip(na.state, na.text) + (waitChipText(l, flagsOf(state.index, l.id)) && waitChipText(l, flagsOf(state.index, l.id)) !== na.text ? ' ' + chip('wait', waitChipText(l, flagsOf(state.index, l.id))) : '') + '</td></tr>'; }).join('')
        + '</tbody></table></div>' + (list.length === 0 ? '<div class="crm-state">אין לידים התואמים לסינון</div>' : '');
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
        + '<label>קשר למטופל <select name="contactRelation"><option value="">— ללא —</option>' + CONTACT_RELATIONS.map(function (r) { return '<option>' + esc(r) + '</option>'; }).join('') + '</select><span class="err" data-err="contactRelation"></span></label>'
        + field('contactRelationOther', 'קשר אחר')
        + '<label>טלפון לגבייה ועדכונים <select name="billingMode"><option value="patient">מטופל</option><option value="contact">פונה</option><option value="other">אחר</option></select></label>'
        + field('billingOther', 'טלפון אחר לגבייה', 'tel')
        + '<h3>פרטים נוספים</h3>'
        + '<label>בית מועדף * <select name="house"><option value="">— בחר —</option>' + HOUSES.filter(function (h) { return !h.closed; }).map(function (h) { return '<option>' + esc(h.name) + '</option>'; }).join('') + '</select><span class="err" data-err="house"></span></label>'
        + '<label>מקור הליד * <input name="source" list="crm-sources"><datalist id="crm-sources">' + SOURCES.map(function (x) { return '<option value="' + esc(x) + '">'; }).join('') + '</datalist><span class="err" data-err="source"></span></label>'
        + '<label>משוייך ל * <select name="assignedTo" required><option value="">— בחר —</option>' + ASSIGNEES.map(function (a) { return '<option>' + esc(a) + '</option>'; }).join('') + '</select><span class="err" data-err="assignedTo"></span></label>'
        + '<label>נפגש/ת עם <select name="meetingWith"><option value="">—</option>' + managersOf('').concat([MEETING_WITH_AMBULATORY]).map(function (m) { return '<option>' + esc(m) + '</option>'; }).join('') + '</select></label>'
        + '<label class="wide">הערות <textarea name="note" rows="2"></textarea></label>'
        + '<div class="wide"><button type="submit" class="btn primary">הוסף ליד</button> <button type="button" class="btn" data-cancel-drawer="1">ביטול</button> <span class="na" id="crm-save-state"></span></div>'
        + '</form>';
    }
    function openNewLeadDrawer() {
      const dr = $('#crm-drawer');
      dr.innerHTML = '<div class="drawer-head"><div><h2>ליד חדש</h2><div class="meta">ליד חדש נכנס ללוח בשלב «ליד חדש»</div></div><button type="button" class="btn small" id="crm-drawer-close" aria-label="סגירה">✕</button></div>' + renderNewLeadForm();
      dr.setAttribute('aria-hidden', 'false'); $('#crm-scrim').setAttribute('data-open', 'true');
      state.drawer = { kind: 'new', id: '', tab: 'overview' };
      const first = dr.querySelector('[name="name"]'); if (first) first.focus();
    }
    /* A generic write through /api/sheets for the lifecycle actions; `apply`
     * mutates state optimistically, `undo` reverts it. */
    function postAction(body, okCheck, apply, undo, label, deferSuccess) {
      const payload = JSON.stringify(body);          // serialised BEFORE the optimistic apply (which may strip intent fields)
      // Only admissions supply source identity. Other action behavior stays unchanged.
      const identity = deferSuccess && typeof deferSuccess === 'object' ? deferSuccess : null;
      state.saving = true; markBusy(); apply(); renderNav(); renderMain(); setSaveState('שומר…');
      return win.fetch('/api/sheets', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: payload })
        .then(function (r) { return r.json().catch(function () { return null; }); })
        .then(function (res) {
          const why = okCheck(res);
          if (why) throw new Error(why);
          if (deferSuccess) setSaveState('הקליטה נשמרה — מאמת גורם מממן…');
          else { state.saving = false; clearBusy(); toast(label + ' — בוצע'); }
          return true;
        })
        .catch(function (e) {
          if (!identity) {
            undo(); state.saving = false; clearBusy(); renderNav(); renderMain();
            setSaveState(String(e && e.message || e), true); toast(String(e && e.message || e), true);
            return false;
          }
          // A lost saveAll answer is not proof that its Patients row was absent.
          // The proxy busts getData's read-cache both before and after writes.
          // A source read may prove this EXACT admission committed, in which
          // case continue the original funder write with the original stay ID.
          const originalError = String(e && e.message || e);
          const block = function (proof) {
            state.saving = false; clearBusy();
            const details = proof === 'patient_only'
              ? 'המטופל/ת נמצא/ה במקור אך סטטוס הליד לא אומת.'
              : proof === 'mismatch' || proof === 'ambiguous'
                ? 'נמצאה אי-התאמה ברשומות המקור של הקליטה.'
                : proof === 'missing'
                  ? 'לא נמצאה קליטה מזהה בקריאת המקור; עדיין אין לבצע קליטה חדשה לפני בירור.'
                  : 'לא ניתן לאמת את תוצאת השמירה במקור.';
            const warning = 'הקליטה לא אומתה במלואה — ' + details +
              ' אין לבצע קליטה חוזרת; יש לרענן ולבדוק לפני פעולה חדשה.';
            state.error = warning + ' (' + originalError + ')';
            renderNav(); renderMain(); setSaveState(warning, true); toast(warning, true);
            return false;
          };
          return api('getData').then(function (fresh) {
            const proof = admissionSourceProof(fresh, identity);
            if (fresh && fresh.ok === true) state.data = fresh; // read-only authoritative projection
            if (proof !== 'confirmed') return block(proof);
            state.error = ''; // exact patient and lead both exist in source
            renderNav(); renderMain();
            setSaveState('הקליטה אומתה בקריאה חוזרת — מאמת גורם מממן…');
            return true;
          }, function () { return block('unavailable'); });
        });
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
      if (f) Object.keys(errs).concat(['name', 'phone', 'assignedTo', 'contactPhone', 'source', 'house', 'contactRelation', 'contactRelationOther', 'billingOther']).forEach(function (k) { const el = f.querySelector('[data-err="' + k + '"]'); if (el) el.textContent = errs[k] || ''; });
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
    /* The admission already exists once this runs. Never advertise total success
     * or re-run admission if this second (finance) write is refused/uncertain. */
    function saveFunderBestEffort(pid, funder, effectiveFrom) {
      const finish = function (ok, message, warning) {
        state.saving = false; clearBusy();
        // Invalidate pre-admission account data before opening the new account.
        state.billing = null;
        renderNav(); renderMain();
        setSaveState(message, !!warning);
        toast(message, !!warning);
        return ok;
      };
      if (!(state.me && state.me.finance)) return Promise.resolve(finish(true, 'הקליטה נשמרה', false));
      if (FUNDERS.indexOf(s(funder)) < 0) {
        return Promise.resolve(finish(false, 'הקליטה נשמרה, אך חסר גורם מממן — אין לקלוט את המטופל שוב; יש לבדוק בכרטיס החשבון', true));
      }
      const submissionId = newSubmissionId();
      const unverified = 'הקליטה נשמרה, אך שמירת הגורם המממן לא אומתה — אין לקלוט שוב; יש לבדוק את כרטיס החשבון';
      // The source may have committed despite a lost reply. Read the same
      // authorised getPayments projection once; NEVER repeat appendFunder.
      const reconcile = function () {
        return api('getPayments').then(function (data) {
          state.payments = data && data.ok === true ? data : null;
          return funderSourceConfirmed(data, pid, submissionId, funder, effectiveFrom)
            ? finish(true, 'הקליטה והגורם המממן אומתו בקריאה חוזרת', false)
            : finish(false, unverified, true);
        }, function () {
          state.payments = null;
          return finish(false, unverified, true);
        });
      };
      const posted = win.fetch('/api/sheets', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'appendFunder', funder: { patientId: pid, funder: s(funder), effectiveFrom: effectiveFrom, submissionId: submissionId } }) })
        .then(function (r) { return r.json().catch(function () { return null; }); });
      return posted.then(function (res) {
        if (!funderWriteConfirmed(res, submissionId)) return reconcile();
        // Acknowledgment is confirmed, but still refresh the account so a
        // pre-save payment/funder view is not left on screen.
        return api('getPayments').then(function (p) {
          state.payments = p && p.ok === true ? p : null;
          return finish(true, state.payments ? 'הקליטה והגורם המממן נשמרו' : 'הגורם המממן אומת, אך החשבון לא נטען — יש לרענן לבדיקה', !state.payments);
        }, function () {
          state.payments = null;
          return finish(true, 'הגורם המממן אומת, אך החשבון לא נטען — יש לרענן לבדיקה', true);
        });
      }, function () { return reconcile(); });
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
        function () { leads[i] = raw; const k = rows.indexOf(patient); if (k >= 0) rows.splice(k, 1); }, 'הקליטה של «' + s(raw.name) + '»', { patientId: patient.id, leadId: leadNext.id, houseId: patient.houseId, date: patient.date })
        .then(function (ok) { return ok ? saveFunderBestEffort(patient.id, v.funder, patient.date) : false; });
    }
    function directAdd(v, f) {
      const errs = directAddErrors(v, !!(state.me && state.me.finance));
      if (f) showErrs(f, errs, ['name', 'phone', 'houseId', 'date', 'pay', 'funder']);
      if (Object.keys(errs).length) return Promise.resolve(false);
      // A match by phone/name is a search suggestion, NOT evidence of identity.
      // Explicit source-lead admission is available only from that lead's card.
      // A different person with a shared family phone may still be admitted
      // independently, but only after the operator explicitly confirms this.
      const open = openLeadOfPerson(state.data.leads, v.name, v.phone);
      if (open && s(v.independentCase) !== 'yes') {
        const message = open === 'ambiguous'
          ? 'נמצאו כמה לידים עם שם או טלפון דומים. לקליטה מליד קיים פתחי את הליד המדויק. אם זה אדם אחר, סמני אישור לקליטה עצמאית.'
          : 'נמצא ליד של «' + open.name + '» עם שם או טלפון דומים. לקליטה מאותו ליד פתחי את כרטיס הליד ואמתִי זהות. אם זה אדם אחר, סמני אישור לקליטה עצמאית.';
        if (f) {
          const warning = f.querySelector('#crm-independent-warning');
          if (warning) { warning.textContent = message; warning.style.display = ''; }
          showErrs(f, { name: 'נדרש אימות זהות לפני קליטה — לא בוצע שיוך לליד' }, ['name']);
        } else toast(message, true);
        return Promise.resolve(false);
      }
      const pair = directAddRows(v, randomId(), state.today, houseName);
      const rows = patientsOfHouse(pair.patient.houseId);
      const leads = state.data.leads;
      closeDrawer();
      return postAction(houseSaveBody(pair.patient.houseId, rows, pair.patient, pair.lead), function (res) { return houseSaveRefusal(res, pair.patient.id, pair.lead.id); },
        function () { rows.push(pair.patient); leads.unshift(pair.lead); },
        function () { const k = rows.indexOf(pair.patient); if (k >= 0) rows.splice(k, 1); const j = leads.indexOf(pair.lead); if (j >= 0) leads.splice(j, 1); }, 'הוספת «' + pair.patient.name + '»', { patientId: pair.patient.id, leadId: pair.lead.id, houseId: pair.patient.houseId, date: pair.patient.date })
        .then(function (ok) { return ok ? saveFunderBestEffort(pair.patient.id, v.funder, pair.patient.date) : false; });
    }
    function openDirectAddDrawer() {
      const dr = $('#crm-drawer');
      const hid = houseId(state.filters.house) || 'ramot';
      dr.innerHTML = '<div class="drawer-head"><div><h2>הוספת מטופל/ת ישירות</h2><div class="meta">פנייה ישירה — נוצר ליד «פנייה ישירה» שנקלט</div></div><button type="button" class="btn small" id="crm-drawer-close" aria-label="סגירה">✕</button></div>'
        + '<form data-form="direct-add" class="new-lead" novalidate>'
        + '<label>שם מלא * <input name="name" type="text"><span class="err" data-err="name"></span></label>'
        + '<label>טלפון המטופל/ת * <input name="phone" type="tel"><span class="err" data-err="phone"></span></label>'
        + '<label>בית * <select name="houseId">' + HOUSES.filter(function (h) { return !h.closed; }).map(function (h) { return '<option value="' + h.id + '"' + (h.id === hid ? ' selected' : '') + '>' + esc(h.name) + '</option>'; }).join('') + '</select><span class="err" data-err="houseId"></span></label>'
        + '<label>תאריך כניסה * <input type="date" name="date" value="' + esc(state.today) + '"><span class="err" data-err="date"></span></label>'
        + '<label>סכום חודשי (₪) * <input type="number" name="pay" min="0" step="1"><span class="err" data-err="pay"></span></label>'
        + '<label>סטטוס <select name="status">' + [{ id: 'active', label: 'פעיל' }, { id: 'trial', label: 'תקופת ניסיון' }, { id: 'wait', label: 'בהמתנה' }].map(function (st) { return '<option value="' + st.id + '">' + esc(st.label) + '</option>'; }).join('') + '</select></label>'
        + (state.me && state.me.finance ? '<label>גורם מממן * <select name="funder"><option value="">— בחרו —</option>' + FUNDERS.map(function (x) { return '<option>' + esc(x) + '</option>'; }).join('') + '</select><span class="err" data-err="funder"></span></label>' : '')
        + '<label class="wide" id="crm-independent-warning" role="alert" style="display:none"></label>'
        + '<label class="wide">אם קיים שם או טלפון דומה, יש לוודא האם זה אותו ליד. <span class="na">קליטה מליד קיים תבוצע דרך כרטיס הליד שלו בלבד.</span></label>'
        + '<label class="wide"><input type="checkbox" name="independentCase" value="yes"> בדקתי: מדובר בקליטה עצמאית של אדם אחר, ואין לשייך לליד קיים בעל שם או טלפון דומים.</label>'
        + '<label class="wide">הערות <textarea name="notes" rows="2"></textarea></label>'
        + '<div class="wide"><button type="submit" class="btn primary">הוסף מטופל/ת</button> <button type="button" class="btn" data-cancel-drawer="1">ביטול</button> <span class="na" id="crm-save-state"></span></div></form>';
      dr.setAttribute('aria-hidden', 'false'); $('#crm-scrim').setAttribute('data-open', 'true');
      state.drawer = { kind: 'direct', id: '', tab: 'overview' };
    }

    /* A released patient's card (CHANGELOG-crm-followups-1104.md): the Outpatient handoff right
     * here — phone optional (found from the lead / the phone book), asked when none is found. */
    function releasedPatientBlock(p) {
      const c = compute(state.data, state.today);
      const d = meetingsFor(p, 'patient', c).discharge;
      if (!d || !d.id) return '';
      if (c.outpatientSent && c.outpatientSent['discharge:' + d.id])
        return '<div class="notice ok">נשלח לאמבולטורי ✓ · מצב הטיפול טרם אומת</div>' + outpatientStatusButton(d.id, 'discharge');
      return '<div class="actions"><details class="act" open><summary>העברה לאמבולטורי</summary>'
        + '<form data-form="out-phone" data-discharge="' + esc(d.id) + '" data-optional="1" novalidate>'
        + '<label>טלפון (אם לא מופיע בליד) <input type="tel" name="phone" inputmode="tel" maxlength="20" autocomplete="off" placeholder="05XXXXXXXX"><span class="err" data-err="phone"></span></label>'
        + '<button type="submit" class="btn small primary">העבר לאמבולטורי</button>'
        + '<p class="na">השחרור כבר נשמר. טלפון שיוזן נשמר ברשימת הטלפונים של המטופלים — לא יידרש שוב.</p></form></details></div>';
    }
    function renderPatientActions(p) {
      if (p && !inHouse(p)) return releasedPatientBlock(p);
      if (!p) return '';
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
      if (pendingDischargeAudit(state.data && state.data.dischargedPatients, pid)) {
        toast('קיים רישום שחרור קודם שטרם הושלם — אין לבצע שוב שחרור; יש לאמת את הסטטוס מול הרשומה המקורית', true);
        return Promise.resolve(false);
      }
      const errs = dischargeErrors(v);
      if (f) showErrs(f, errs, ['disposition', 'dischargeDate']);
      if (Object.keys(errs).length) return Promise.resolve(false);
      const loc = findPatientRow(pid);
      if (!loc) return Promise.resolve(false);
      const before = loc.row;
      const audit = dischargeAuditRow(before, v, randomId(), new Date().toISOString());
      const released = Object.assign({}, before, { status: 'released', exitDate: audit.exitDate });
      closeDrawer();
      state.saving = true; markBusy(); loc.arr[loc.idx] = released; renderNav(); renderMain(); setSaveState('שומר…');
      const post = function (body) {
        return win.fetch('/api/sheets', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
          .then(function (r) { return r.json().catch(function () { return null; }); });
      };
      let auditRes = null;
      return post({ action: 'dischargePatient', patient: audit }).then(function (res) {
        auditRes = res;
        if (!res || res.ok === false) throw new Error((res && res.message) || 'שחרור המטופל נכשל — לא נשמר' + (res && res.error ? ' (' + res.error + ')' : ''));
        if (res.duplicate === true) throw new Error('נמצא רישום שחרור קודם ללא אימות patientId של אותו מטופל — אין לעדכן סטטוס לפני בדיקת מקור');
        else if (!(res.patient && s(res.patient.id) === audit.id)) throw new Error('השחרור לא אומת — רענני ובדקי');
        // b. the Patients row flips in the same way the classic flow does: the house as read, this row released.
        return post(houseSaveBody(loc.hid, loc.arr, released, null));
      }).then(function (res) {
        const why = houseSaveRefusal(res, pid, '');
        if (why) throw new Error('השחרור נרשם, אך עדכון הסטטוס נכשל — ' + why);
        const needsOutpatient = s(v.disposition) === 'released_outpatient';
        if (needsOutpatient) toast('השחרור נשמר — מאמת את ההעברה לאמבולטורי, הפעולה עדיין לא הושלמה');
        else { state.saving = false; clearBusy(); toast('«' + s(before.name) + '» שוחרר/ה'); }
        if (auditRes && auditRes.refund && Number(auditRes.refund.created) > 0) toast('נוצר זיכוי לפי הכלל — לטיפול אורטל');
        if (needsOutpatient) {
          return win.fetch('/api/outpatient-lead', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dischargeId: audit.id, manual: false }) })
            .then(function (r) { return r.json().catch(function () { return {}; }); })
            .then(function (d) { if (d && d.ok === true && (d.sent || d.alreadySent)) { if (!state.data.outpatientSentLeadIds) state.data.outpatientSentLeadIds = []; state.data.outpatientSentLeadIds.push('discharge:' + audit.id); renderMain(); }
              const accepted = d && d.ok === true && (d.sent || d.alreadySent);
              state.saving = false; clearBusy();
              if (!accepted && d && d.error === 'no_phone') state.outPhone = audit.id;   // the row in «משוחררים» opens with the phone field
              toast(accepted ? (d.alreadySent ? 'השחרור נשמר וההפניה כבר קיימת באמבולטורי' : 'השחרור נשמר ונוצרה הפניה לאמבולטורי')
                : (d && d.error === 'no_phone' ? 'השחרור נשמר. לא נשלח לאמבולטורי כי אין טלפון — הזיני טלפון ב«מטופלים» ← «משוחררים» ושלחי.' : 'השחרור נשמר, אך ההפניה לאמבולטורי לא אומתה — אין לשחרר שוב; יש לנסות העברה מתוך ״משוחררים״'), !accepted);
              return !!accepted; })
            .catch(function () { state.saving = false; clearBusy(); toast('השחרור נשמר, אך ההפניה לאמבולטורי לא אומתה — אין לשחרר שוב; יש לנסות העברה מתוך ״משוחררים״', true); return false; });
        }
        return true;
      }).catch(function (e) {
        // A lost reply can follow a committed source write. Do not falsely undo
        // the source in the UI or invite a second discharge with a fresh audit ID.
        state.saving = false; clearBusy();
        const message = 'מצב השחרור לא אומת במלואו — ייתכן שחלק מהפעולות נשמרו. אין לבצע שחרור נוסף עד בדיקה ורענון. ' + String(e && e.message || e);
        setSaveState(message, true); toast(message, true);
        return load().then(function () { toast(message, true); return false; });
      });
    }

    function renderDischarged(c) {
      const days = state.dischargedDays || 90;
      const list = dischargedList(c, state.today, days, state.filters);
      const ro = false;
      const toolbar = '<div class="toolbar"><div class="seg"><button type="button" data-clients-view="in" aria-pressed="false">בבית</button><button type="button" data-clients-view="out" aria-pressed="true">משוחררים</button></div>'
        + '<select id="f-house-c"><option value="">כל הבתים</option>' + HOUSES.map(function (h) { return '<option value="' + h.id + '"' + (state.filters.house === h.id ? ' selected' : '') + '>' + esc(h.name) + '</option>'; }).join('') + '</select>'
        + '<select id="f-dis-days">' + [[30, '30 יום'], [90, '90 יום'], [365, 'שנה'], [0, 'הכול']].map(function (o) { return '<option value="' + o[0] + '"' + (days === o[0] ? ' selected' : '') + '>' + esc(o[1]) + '</option>'; }).join('') + '</select>'
        + '<span class="na">' + list.length + ' שחרורים</span></div>';
      if (!list.length) return toolbar + '<div class="crm-state">אין שחרורים בטווח</div>';
      return toolbar + '<div class="tbl-wrap"><table class="tbl" id="crm-discharged"><thead><tr><th>שם</th><th>בית</th><th>כניסה</th><th>יציאה</th><th>סיבה</th><th>המשך טיפול</th><th>אמבולטורי</th><th></th></tr></thead><tbody>'
        + list.map(function (r) {
          const op = r.sentToOutpatient ? chip('ok', 'נשלח') : (r.disposition === 'released_outpatient' ? chip('late', 'לא נשלח') : '<span class="na">—</span>');
          return '<tr data-discharge="' + esc(r.id) + '"><td>' + esc(r.name) + '</td><td>' + esc(r.houseName) + '</td><td>' + esc(fmtDate(r.date)) + '</td><td>' + esc(fmtDate(r.exitDate)) + '</td><td>' + esc(r.dispositionLabel || '—') + '</td><td>' + esc(continuityKnown(r.continuity) ? continuityLabel(r.continuity) : (s(r.continuity) && r.continuity !== 'unknown' ? r.continuity : (r.disposition === 'released_outpatient' || r.sentToOutpatient ? 'נשלח/מיועד לאמבולטורי — התחלת טיפול לא אומתה' : 'לא ידוע'))) + '</td><td>' + op + '</td>'
            + '<td>' + (ro ? '' : '<button type="button" class="btn small" data-restore="' + esc(r.id) + '">שחזר</button>' + (!r.sentToOutpatient ? ' <button type="button" class="btn small" data-to-outpatient="' + esc(r.id) + '">העבר לאמבולטורי</button>' : '')) + '</td></tr>'
            + (!r.sentToOutpatient && state.outPhone === r.id ? '<tr class="out-phone-row"><td colspan="8"><form id="crm-out-phone" data-form="out-phone" data-discharge="' + esc(r.id) + '" novalidate><label>טלפון של ' + esc(r.name) + ' (או של איש הקשר) <input type="tel" name="phone" inputmode="tel" maxlength="20" autocomplete="off" placeholder="05XXXXXXXX"></label> <button type="submit" class="btn small primary">שמירת הטלפון ושליחה לאמבולטורי</button> <button type="button" class="btn small" data-out-phone-cancel>ביטול</button> <span class="err" data-err="phone"></span><p class="na">הטלפון נשמר ברשימת הטלפונים של המטופלים — לא יידרש שוב. השחרור עצמו כבר נשמר.</p></form></td></tr>' : '');
        }).join('') + '</tbody></table></div><div id="crm-restore"></div>';
    }
    /* C17: restore (to the previous status, or as a new lead) and the manual Outpatient handoff. */
    function openRestoreChoice(id) {
      const el = $('#crm-restore'); const c = compute(state.data, state.today);
      const r = dischargedList(c, state.today, 0, {}).filter(function (x) { return x.id === id; })[0];
      if (!el || !r) return;
      const target = restoreTarget(r, state.data.patients);
      const prior = { active: 'פעיל', trial: 'ניסיון', wait: 'בהמתנה' }[priorStatusOf(r)];
      el.innerHTML = '<form class="new-lead report" data-form="restore" data-discharge="' + esc(id) + '" novalidate><h3>שחזור · ' + esc(r.name) + ' · ' + esc(r.houseName) + ' · יצא/ה ' + esc(fmtDate(r.exitDate)) + '</h3>'
        + '<label class="wide"><input type="radio" name="how" value="active"' + (target ? ' checked' : ' disabled') + '> החזרה לבית לסטטוס הקודם (' + esc(prior) + ')' + (target ? '' : ' <span class="na">— השורה המקורית לא נמצאה; אפשר רק כליד חדש</span>') + (r.disposition === 'released_outpatient' ? ' <span class="na">· הליד באאוטפיישנט לא יימחק — להסיר ידנית</span>' : '') + '</label>'
        + '<label class="wide"><input type="radio" name="how" value="lead"' + (target ? '' : ' checked') + '> פתיחת ליד חדש (חוזר/ת למסלול הלידים)</label>'
        + '<div class="wide err" data-err="_form"></div><div class="wide toolbar"><button type="submit" class="btn primary">שחזור</button><button type="button" class="btn" data-restore-cancel>ביטול</button><span class="na" id="crm-restore-state"></span></div></form>';
      el.scrollIntoView({ block: 'nearest' });
    }
    function submitRestore(f) {
      if (state.saving) return Promise.resolve(false);
      const id = f.dataset.discharge; const how = (f.querySelector('input[name="how"]:checked') || {}).value;
      const c = compute(state.data, state.today);
      const r = dischargedList(c, state.today, 0, {}).filter(function (x) { return x.id === id; })[0];
      const raw = (state.data.dischargedPatients || []).filter(function (x) { return s(x && x.id) === id; })[0];
      if (!r || !raw || !how) return Promise.resolve(false);
      const post = function (path, body) {
        return win.fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(function (x) { return x.json().catch(function () { return null; }); });
      };
      const st = $('#crm-restore-state'); if (st) st.textContent = 'שומר…';
      state.saving = true; markBusy();
      let chain;
      if (how === 'lead') {
        const newId = randomId().replace(/^id-/, 'lead-');
        chain = post('/api/sheets', restoreAsLeadBody(raw, newId)).then(function (res) {
          if (!res || res.ok === false || !(res.lead && s(res.lead.id))) throw new Error((res && res.message) || 'השחזור נכשל' + (res && res.error ? ' (' + res.error + ')' : ''));
          return 'נפתח ליד חדש «' + s(r.name) + '»';
        });
      } else {
        const target = restoreTarget(r, state.data.patients);
        if (!target) { state.saving = false; clearBusy(); return Promise.resolve(false); }
        const next = restoredRow(target.row, r);
        const siblings = openAuditsOf(r, c.discharges);
        chain = post('/api/sheets', houseSaveBody(target.hid, target.arr, next, null)).then(function (res) {
          const why = houseSaveRefusal(res, s(next.id), '');
          if (why) throw new Error(why);
          // then every open audit row of the stay is flagged (sequential, idempotent upserts)
          return siblings.reduce(function (pr, d) {
            return pr.then(function () {
              const rawD = (state.data.dischargedPatients || []).filter(function (x) { return s(x && x.id) === d.id; })[0] || { id: d.id };
              return post('/api/sheets', restoreFlagBody(rawD)).then(function (res2) { if (!(res2 && res2.restoredToActive === true)) throw new Error('המטופל/ת חזר/ה לבית, אך סימון רשומת השחרור נכשל — רענני'); });
            });
          }, Promise.resolve()).then(function () { return '«' + s(r.name) + '» חזר/ה לבית'; });
        });
      }
      return chain.then(function (msg) { state.saving = false; clearBusy(); toast(msg); return load().then(function () { state.area = 'clients'; state.clientsView = 'out'; renderNav(); renderMain(); return true; }); })
        .catch(function (e) { state.saving = false; clearBusy(); if (st) st.textContent = ''; showReportIssues(f, [], String(e && e.message || e)); toast(String(e && e.message || e), true); return false; });
    }
    function sendToOutpatient(id, phone) {
      if (state.saving) return Promise.resolve(false);
      state.saving = true; markBusy();
      return win.fetch('/api/outpatient-lead', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(outpatientBody(id, phone)) })
        .then(function (r) { return r.json().catch(function () { return {}; }); })
        .then(function (d) {
          state.saving = false; clearBusy();
          const ok = d && d.ok === true && (d.sent || d.alreadySent);
          // No phone is not a reason to stop: the phone is asked for right in the row (CHANGELOG-crm-followups-1104.md).
          const needPhone = !ok && d && (d.error === 'no_phone' || d.error === 'bad_phone');
          toast(ok ? (d.alreadySent ? 'המטופל/ת כבר נשלח/ה לאמבולטורי' : 'נוצר ליד טיפול חוץ באאוטפיישנט') : needPhone ? s(d.message) || 'יש להזין טלפון' : ('יצירת ליד טיפול חוץ נכשלה — ' + s(d && (d.message || d.error) || 'שגיאה')), !ok);
          if (ok) { state.outPhone = ''; if (!state.data.outpatientSentLeadIds) state.data.outpatientSentLeadIds = []; state.data.outpatientSentLeadIds.push('discharge:' + id); renderMain(); if (state.drawer) openDrawer(state.drawer.kind, state.drawer.id, true); }
          else if (needPhone) {
            const inCard = $('#crm-drawer form[data-form="out-phone"]');
            if (inCard && state.drawer && $('#crm-drawer').getAttribute('aria-hidden') === 'false') {
              const e2 = inCard.querySelector('[data-err="phone"]'); if (e2) e2.textContent = 'לא נמצא טלפון — הזיני טלפון ולחצי שוב';
              const i2 = inCard.querySelector('input[name="phone"]'); if (i2) i2.focus();
            } else { state.outPhone = id; state.clientsView = 'out'; renderMain(); const inp = $('#crm-out-phone input[name="phone"]'); if (inp) inp.focus(); }
          }
          return !!ok;
        }).catch(function (e) { state.saving = false; clearBusy(); toast('יצירת ליד טיפול חוץ נכשלה — ' + String(e && e.message || e), true); return false; });
    }
    function renderClients(c) {
      if (state.clientsView === 'out') return renderDischarged(c);
      const list = clients(c.patients, state.today, state.filters);
      const toolbar = '<div class="toolbar"><div class="seg"><button type="button" data-clients-view="in" aria-pressed="true">בבית</button><button type="button" data-clients-view="out" aria-pressed="false">משוחררים</button></div><select id="f-house-c"><option value="">כל הבתים</option>' + HOUSES.map(function (h) { return '<option value="' + h.id + '"' + (state.filters.house === h.id ? ' selected' : '') + '>' + esc(h.name) + '</option>'; }).join('') + '</select><span class="na">' + list.length + ' בטיפול</span><button type="button" class="btn primary" id="crm-direct-add">+ הוספת מטופל/ת ישירות</button></div>';
      const openBy = {}; (state.tasks || []).forEach(function (t) { if (t && t.status === 'open' && s(t.patientId)) openBy[s(t.patientId)] = (openBy[s(t.patientId)] || 0) + 1; });
      const lastBy = state.index && state.index.patients ? state.index.patients : {};
      return toolbar + '<div class="tbl-wrap"><table class="tbl clients"><thead><tr><th>שם</th><th>בית</th><th>סטטוס</th><th>תאריך כניסה</th><th>ימים בבית</th><th>משימות פתוחות</th><th>מגע אחרון</th><th></th></tr></thead><tbody>'
        + list.map(function (p) {
          const lc = lastBy[p.id];
          return '<tr data-open-patient="' + esc(p.id) + '"><td class="name">' + esc(p.name) + '</td><td>' + houseTag(p.houseId) + '</td><td>' + statusChip(p.status) + '</td><td>' + esc(fmtDate(p.date)) + '</td><td>' + esc(p.days) + '</td>'
            + '<td>' + (openBy[p.id] ? '<span class="chip today">' + openBy[p.id] + '</span>' : '<span class="sub">—</span>') + '</td><td class="sub">' + esc(lc ? whenLocal(lc.at) + ' · ' + contactOutcomeLabel(lc.outcome) : 'אין מגע מתועד') + '</td>'
            + '<td><span class="toolbar"><button type="button" class="btn small primary" data-contact-open="patient:' + esc(p.id) + '">תיעוד שיחה</button><button type="button" class="btn small" data-open-patient="' + esc(p.id) + '">כרטיס</button></span></td></tr>';
        }).join('')
        + '</tbody></table></div>' + (list.length === 0 ? (s(state.filters.q) ? renderSearch(c) : '<div class="crm-state">אין מטופלים</div>') : '');
    }

    function renderCalendar(c) {
      if (!state.cal) state.cal = { mode: 'day', anchor: state.today };
      const range = calendarRange(state.cal.mode, state.cal.anchor) || calendarRange('day', state.today);
      const step = range.mode === 'week' ? 7 : 1;
      const rows = calendarRows(c.leads, range, state.today);
      const upcoming = calendar(c.leads, state.today, 14).length;
      let html = '<div class="toolbar" id="crm-cal-bar">'
        + '<div class="seg"><button type="button" data-cal-mode="day" aria-pressed="' + (range.mode === 'day') + '">יום</button><button type="button" data-cal-mode="week" aria-pressed="' + (range.mode === 'week') + '">שבוע</button></div>'
        + '<button type="button" class="btn small" data-cal-step="-' + step + '" aria-label="אחורה">‹</button>'
        + '<input type="date" id="crm-cal-date" value="' + esc(state.cal.anchor) + '" aria-label="תאריך">'
        + '<button type="button" class="btn small" data-cal-step="' + step + '" aria-label="קדימה">›</button>'
        + '<button type="button" class="btn small" data-cal-today>היום</button>'
        + '<span class="na">' + esc(calendarTitle(range, state.today)) + ' · ' + rows.length + ' פגישות</span></div>';
      const undated = undatedVisits(c.leads);
      if (undated.length) {
        html += '<div class="crm-state bad" id="crm-cal-undated"><strong>' + undated.length + (undated.length === 1 ? ' ליד ב«ביקור נקבע» ללא תאריך פגישה' : ' לידים ב«ביקור נקבע» ללא תאריך פגישה') + '</strong> — לא ביומן ולא אצל המנהלים. פתיחה → «תיאום פגישה».<div class="rows">'
          + undated.map(function (u) { return '<div class="row" data-open-lead="' + esc(u.id) + '" data-focus-meeting="1"><span><span class="name">' + esc(u.name) + '</span><br><span class="sub">' + esc(u.house) + '</span></span><span>' + esc(u.withWhom || '—') + '</span><span>' + chip('late', 'ללא תאריך') + '</span><span><button type="button" class="btn small" data-open-lead="' + esc(u.id) + '" data-focus-meeting="1">קביעת תאריך</button></span></div>'; }).join('')
          + '</div></div>';
      }
      if (!rows.length) return html + '<div class="crm-state">אין פגישות ב' + (range.mode === 'week' ? 'שבוע זה' : 'יום זה') + (upcoming ? ' · ' + upcoming + ' פגישות ב-14 הימים הקרובים' : '') + '</div>';
      let day = '';
      return html + '<div class="rows">' + rows.map(function (r) {
        const head = range.mode === 'week' && r.date !== day ? '<div class="group-title">' + esc('יום ' + DAY_NAMES[weekdayOf(r.date)] + ' · ' + fmtDate(r.date)) + '</div>' : '';
        day = r.date;
        return head + '<div class="row" data-open-lead="' + esc(r.id) + '"><span><span class="name">' + esc(r.name) + '</span><br><span class="sub">' + esc(r.house) + (r.stage !== 'visit' ? ' · ' + esc(stageLabel(r.stage)) : '') + '</span></span><span>פגישת קבלה' + (r.time ? ' · ' + esc(r.time) : '') + '</span><span>' + esc(r.withWhom || '—') + '</span><span>' + esc(fmtDate(r.date)) + '</span><span>' + chip(r.status.state, r.status.text) + '</span><span><button type="button" class="btn small" data-open-lead="' + esc(r.id) + '">כרטיס</button></span></div>';
      }).join('') + '</div>';
    }

    /* C8: read-only overview over debtAging + getPayments, fetched on first
     * open (never on boot: the two reads are heavier than getData). Every
     * ACTION («דווח תשלום», overrides, credits, Ortal's verification) stays in
     * the classic dashboard — the links at the bottom. */
    const billingWaiters = [];
    /* After a billing write (or a retry): both the area reads and the day card re-read. */
    function resetBilling() { state.billing = null; if (state.me && state.me.finance) { state.debt = null; state.payments = null; } }
    function loadBilling(then) {
      if (typeof then === 'function') billingWaiters.push(then);
      if (state.billing || state.billingLoading) return;
      state.billingLoading = true;
      // debtAging is read once at boot for the «גבייה לטיפול» card (finance); reuse it until a billing write resets it
      const debtP = state.debt && state.debt.ok === true ? Promise.resolve(state.debt) : api('debtAging');
      const payP = state.payments && state.payments.ok === true ? Promise.resolve(state.payments) : api('getPayments');
      Promise.all([debtP, payP, api('getCredits')]).then(function (res) {
        state.billing = { debt: res[0], payments: res[1], credits: res[2] };
        state.debt = res[0] && res[0].ok === true ? res[0] : false;
        state.payments = res[1] && res[1].ok === true ? res[1] : null;
      }).catch(function (e) {
        state.billing = { debt: { ok: false, error: String(e && e.message || e) }, payments: { ok: false, error: String(e && e.message || e) }, credits: { ok: false, error: String(e && e.message || e) } };
      }).then(function () {
        state.billingLoading = false; if (state.area === 'billing') renderMain();
        while (billingWaiters.length) { try { billingWaiters.shift()(); } catch (_) { /* a stale drawer */ } }
      });
    }
    /* C18: link / not-a-patient forms in the גבייה area. */
    function rawPaymentRow(id) {
      const p = state.billing && state.billing.payments && Array.isArray(state.billing.payments.payments) ? state.billing.payments.payments : [];
      return p.filter(function (x) { return s(x && x.id) === s(id); })[0] || null;
    }
    function openLinkForm(kind, id) {
      const el = $('#crm-link');
      const row = detachedRows(state.billing.debt).filter(function (r) { return r.paymentId === id; })[0];
      if (!el || !row) return;
      state.link = { kind: kind, row: row };
      const err = function (f) { return '<div class="err" data-err="' + f + '"></div>'; };
      let inner = '<h3>' + (kind === 'link' ? 'שיוך' : 'סימון «לא מטופל/ת»') + ' · ' + esc(row.patientName) + ' · ' + esc(row.houseName) + ' · ' + esc(fmtDate(row.dueDate)) + ' · ' + esc(fmtMoney(row.amount)) + '</h3>';
      if (kind === 'link') {
        const cands = linkCandidates(row, compute(state.data, state.today).patients);
        inner += '<label class="wide">מטופל/ת *<select name="patientId"><option value="">בחרי…</option>' + cands.map(function (c, i) {
          return '<option value="' + esc(c.id) + '"' + (i === 0 && c.score >= 6 ? ' selected' : '') + '>' + esc(c.name + ' · ' + c.houseName + (c.date ? ' · ' + fmtDate(c.date) : '') + (c.status === 'released' ? ' · שוחרר/ה' : '') + (c.reasons.length ? ' — ' + c.reasons.join(', ') : '')) + '</option>';
        }).join('') + '</select>' + err('patientId') + '</label>';
      } else {
        inner += '<label class="wide">סיבה * (החזר, ספק, שורת בדיקה…)<input type="text" name="note" maxlength="120" value="">' + err('note') + '</label>';
      }
      el.innerHTML = '<form class="new-lead report" data-form="link-' + kind + '" novalidate>' + inner + '<div class="wide err" data-err="_form"></div>'
        + '<div class="wide toolbar"><button type="submit" class="btn primary">שמירה</button><button type="button" class="btn" data-link-cancel>ביטול</button><span class="na" id="crm-link-state"></span></div></form>';
      el.scrollIntoView({ block: 'nearest' });
    }
    function submitLink(f) {
      if (!state.link || state.saving) return Promise.resolve(false);
      const vals = {}; Array.prototype.forEach.call(f.elements, function (el) { if (el.name) vals[el.name] = el.value; });
      const k = state.link.kind, row = state.link.row;
      const errs = linkErrors(k, vals);
      const issues = Object.keys(errs).map(function (x) { return { field: x, hebrewMessage: errs[x] }; });
      showReportIssues(f, issues, issues.length ? 'יש לתקן את השדות המסומנים' : '');
      if (issues.length) return Promise.resolve(false);
      const raw = rawPaymentRow(row.paymentId);
      if (!raw) { showReportIssues(f, [], 'השורה לא נמצאה בתשלומים — רענני'); return Promise.resolve(false); }
      const body = k === 'link' ? linkBody(raw, vals.patientId) : notPatientBody(raw, vals.note);
      const want = k === 'link' ? 'linked' : 'not_a_patient';
      const st = $('#crm-link-state'); if (st) st.textContent = 'שומר…';
      state.saving = true; markBusy();
      return win.fetch('/api/sheets', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
        .then(function (r) { return r.json().catch(function () { return { ok: false, error: 'bad_json' }; }); })
        .then(function (res) {
          state.saving = false; clearBusy();
          if (!linkAccepted(res, row.paymentId, want)) { const why = writeRefusal(res, res && res.ok === true ? 'nope' : '') || 'השיוך לא נשמר'; showReportIssues(f, [], why); if (st) st.textContent = ''; toast(why, true); return false; }
          toast(k === 'link' ? 'התשלום שויך ✓' : 'השורה סומנה «לא מטופל/ת» ✓'); state.link = null;
          resetBilling(); renderMain();
          return true;
        })
        .catch(function (e) { state.saving = false; clearBusy(); if (st) st.textContent = ''; showReportIssues(f, [], 'השיוך לא נשמר — נסי שוב'); toast(String(e && e.message || e), true); return false; });
    }
    /* «לגבייה בתאריך» (CHANGELOG-crm-collect-on-date.md): the classic daily list —
     * date picker (default today), funder filter, the top search; «דווח תשלום»
     * opens the patient's «חשבון» with the report form on that cycle. */
    function renderDueOnDate(isController) {
      const day = isoDateOk(state.dueDate) ? state.dueDate : state.today;
      const due = dueOnDate(state.data, state.billing.payments, day, cycleBalanceLib(win));
      const fu = state.dueFunder || '';
      const v = filterDueRows(due, fu, state.filters.q);
      const funders = FUNDERS.concat([FUNDER_UNSET_LABEL]);
      let html = '<div class="group-title" id="crm-due-title">לגבייה בתאריך</div>'
        + '<div class="toolbar filters" id="crm-due-tools"><label>תאריך <input type="date" id="crm-due-date" value="' + esc(day) + '"></label>'
        + '<select id="crm-due-funder" aria-label="גורם מממן"><option value="">כל הגורמים המממנים</option>' + funders.map(function (f) { return '<option value="' + esc(f) + '"' + (f === fu ? ' selected' : '') + '>' + esc(f) + '</option>'; }).join('') + '</select>'
        + (day !== state.today ? '<button type="button" class="btn small" data-due-today>היום</button>' : '') + '</div>';
      html += '<div class="kpis"><div class="kpi"><span class="v">' + v.count + '</span><span class="l">מטופלים לתשלום · ' + esc(fmtDate(day)) + '</span></div>'
        + '<div class="kpi"><span class="v">' + esc(fmtMoney(v.total)) + '</span><span class="l">סך לגבייה</span></div>'
        + '<div class="kpi"><span class="v">' + esc(fmtMoney(v.collected)) + '</span><span class="l">נגבה בתאריך הנבחר</span></div></div>';
      if (due.error && due.error !== 'bad_date') html += '<div class="crm-state bad">תשלומים לא נטענו — הסכומים לפי התעריף בכרטיס בלבד <button type="button" class="btn small" data-billing-retry>נסי שוב</button></div>';
      if (!v.rows.length) return html + '<p class="na">' + (due.rows.length ? 'לא נמצאו תוצאות' : 'אין תשלומים לגבייה בתאריך זה') + '</p>';
      state.dueRows = v.rows;
      return html + '<div class="tbl-wrap"><table class="tbl" id="crm-due"><thead><tr><th>מטופל/ת</th><th>בית</th><th>סכום חודשי</th><th>תקופת כיסוי</th><th>סטטוס</th><th>שולם</th><th>יתרה</th><th></th></tr></thead><tbody>'
        + v.rows.map(function (r, i) {
          const st = r.status === 'paid' ? 'ok' : r.status === 'partial' ? 'today' : 'late';
          const split = r.split.length > 1 ? '<br><small class="na">' + r.split.map(function (x) { return esc(HEB_MONTHS[Number(x.month.slice(5, 7)) - 1] + ' ' + x.month.slice(0, 4)) + ' · ' + x.days + ' ימים · ' + esc(fmtMoney(x.amount)); }).join(' | ') + '</small>' : '';
          return '<tr><td data-open-patient="' + esc(r.patientId) + '" class="link">' + esc(r.name) + (r.released ? ' ' + chip('wait', 'שוחרר/ה') : '') + '</td><td>' + esc(r.houseName) + '</td><td>' + esc(fmtMoney(r.monthly)) + '</td>'
            + '<td>' + esc(fmtDate(r.start)) + '–' + esc(fmtDate(r.end)) + split + '</td><td>' + chip(st, CYCLE_STATUS_LABELS[r.status] || r.status) + (r.discount ? ' <span class="na">הנחה ' + esc(fmtMoney(r.discount)) + '</span>' : '') + '</td>'
            + '<td>' + esc(fmtMoney(r.paid)) + '</td><td>' + esc(fmtMoney(r.balance)) + '</td>'
            + '<td>' + (!isController && r.balance > 0 ? '<button type="button" class="btn small primary" data-due-report="' + i + '">דווח תשלום</button>' : '') + '</td></tr>';
        }).join('') + '</tbody></table></div>';
    }
    /* «צפי תזרים» (CHANGELOG-cashflow-forecast.md): the money the active
     * patients are expected to bring between two dates — today → month end by
     * default; private on the due date, institutional «שוטף +30»; no past debt. */
    function renderCashForecast() {
      const from = isoDateOk(state.fcFrom) && state.fcFrom >= state.today ? state.fcFrom : state.today;
      const to = isoDateOk(state.fcTo) && state.fcTo >= from ? state.fcTo : monthEndIso(state.today);
      const fc = cashForecast(state.data, state.billing.payments, from, to, state.today, cycleBalanceLib(win));
      const kpi = function (v, l) { return '<div class="kpi"><span class="v">' + esc(v) + '</span><span class="l">' + esc(l) + '</span></div>'; };
      let html = '<div class="group-title" id="crm-fc-title">צפי תזרים — מטופלים פעילים</div>'
        + '<div class="toolbar filters" id="crm-fc-tools"><label>מתאריך <input type="date" id="crm-fc-from" min="' + esc(state.today) + '" value="' + esc(fc.from) + '"></label>'
        + '<label>עד תאריך <input type="date" id="crm-fc-to" min="' + esc(fc.from) + '" value="' + esc(fc.to) + '"></label>'
        + '<button type="button" class="btn small" data-fc-preset="month">עד סוף החודש</button><button type="button" class="btn small" data-fc-preset="next">החודש הבא</button><button type="button" class="btn small" data-fc-preset="90">90 יום</button></div>';
      if (fc.error === 'payments_missing' || (fc.error && fc.error !== 'bad_range')) html += '<div class="crm-state bad">תשלומים לא נטענו — הצפי לפי התעריף בכרטיס בלבד <button type="button" class="btn small" data-billing-retry>נסי שוב</button></div>';
      html += '<div class="kpis" id="crm-fc-kpis">' + kpi(fmtMoney(fc.total), 'סה"כ צפוי · ' + fmtDate(fc.from) + '–' + fmtDate(fc.to))
        + kpi(fmtMoney(fc.private.total), 'פרטיים (' + fc.private.count + ') · ביום החיוב')
        + kpi(fmtMoney(fc.institutional.total), 'מוסדיים — שוטף +30 (' + fc.institutional.count + ')')
        + (fc.unset.count ? kpi(fmtMoney(fc.unset.total), 'ללא גורם מממן (' + fc.unset.count + ') · לא בסה"כ') : '') + '</div>';
      html += '<p class="na">רק מחזורים שעוד לא שולמו, של מטופלים בבית. ללא חובות עבר. ביטוח לאומי / מכבי / משרד הביטחון — צפי קבלה 30 יום אחרי יום החיוב.'
        + (fc.unset.count ? ' מטופלים ללא גורם מממן אינם בסה"כ — יש להשלים גורם מממן.' : '') + '</p>';
      if (!fc.rows.length) return html + '<p class="na">אין תקבולים צפויים בטווח הזה.</p>';
      if (fc.byWeek.length) html += '<div class="tbl-wrap"><table class="tbl" id="crm-fc-weeks"><thead><tr><th>שבוע</th><th>פרטיים</th><th>מוסדיים (שוטף +30)</th><th>סה"כ</th></tr></thead><tbody>'
        + fc.byWeek.map(function (w) { return '<tr><td>' + esc('מ-' + fmtDate(w.weekStart < fc.from ? fc.from : w.weekStart)) + '</td><td>' + esc(fmtMoney(w.private)) + '</td><td>' + esc(fmtMoney(w.institutional)) + '</td><td>' + esc(fmtMoney(w.total)) + '</td></tr>'; }).join('') + '</tbody></table></div>';
      if (fc.byHouse.length) html += '<div class="tbl-wrap"><table class="tbl" id="crm-fc-houses"><thead><tr><th>בית</th><th>פרטיים</th><th>מוסדיים (שוטף +30)</th><th>סה"כ</th></tr></thead><tbody>'
        + fc.byHouse.map(function (h) { return '<tr><td>' + esc(h.name) + '</td><td>' + esc(fmtMoney(h.private)) + '</td><td>' + esc(fmtMoney(h.institutional)) + '</td><td>' + esc(fmtMoney(h.total)) + '</td></tr>'; }).join('') + '</tbody></table></div>';
      const kindLabel = { private: 'פרטי', institutional: 'שוטף +30', unset: 'לא הוגדר' };
      html += '<details id="crm-fc-detail"><summary>פירוט לפי מטופל/ת (' + fc.rows.length + ')</summary><div class="tbl-wrap"><table class="tbl" id="crm-fc-rows"><thead><tr><th>מטופל/ת</th><th>בית</th><th>גורם מממן</th><th>מחזור</th><th>יום חיוב</th><th>צפי קבלה</th><th>סכום</th></tr></thead><tbody>'
        + fc.rows.map(function (r) {
          const st = r.kind === 'institutional' ? 'wait' : r.kind === 'unset' ? 'late' : 'ok';
          return '<tr data-open-patient="' + esc(r.patientId) + '" data-open-tab="account"><td>' + esc(r.name) + '</td><td>' + esc(r.houseName) + '</td><td>' + esc(r.funder) + ' ' + chip(st, kindLabel[r.kind]) + '</td><td>' + esc(fmtDate(r.start)) + '–' + esc(fmtDate(r.end)) + '</td><td>' + esc(fmtDate(r.dueDate)) + '</td><td>' + esc(fmtDate(r.expectedDate)) + '</td><td>' + esc(fmtMoney(r.amount)) + (r.paid > 0 ? ' <span class="na">(שולם ' + esc(fmtMoney(r.paid)) + ')</span>' : '') + '</td></tr>';
        }).join('') + '</tbody></table></div></details>';
      return html;
    }
    /* «ניקוי חובות היסטוריים» (CHANGELOG-historical-debt-cleanup.md) — finance
     * only: tick released patients' open cycles, pick why, close them with a
     * discount for the whole balance (setBillingDiscount, one call per patient
     * + month, in sequence; the first refusal stops the run). */
    function renderCleanup() {
      const me = state.me || {};
      if (!me.canDiscount) return '';
      const rows = cleanupCandidates(state.billing.debt);
      state.cleanupRows = rows;
      const sel = state.cleanupSel || (state.cleanupSel = {});
      Object.keys(sel).forEach(function (k) { if (!rows.some(function (r) { return r.id === k; })) delete sel[k]; });
      const total = Math.round(rows.reduce(function (t, r) { return t + r.balance; }, 0) * 100) / 100;
      let html = '<details id="crm-cleanup"' + (state.cleanupOpen ? ' open' : '') + '><summary class="group-title">ניקוי חובות היסטוריים — מטופלים משוחררים' + (rows.length ? ' ' + chip('late', rows.length + ' מחזורים · ' + fmtMoney(total)) : '') + '</summary>';
      if (!rows.length) return html + '<p class="na">אין חובות פתוחים של מטופלים משוחררים.</p></details>';
      html += '<p class="na">למחזורים של מטופלים שכבר יצאו ושאינם חוב אמיתי (למשל שולמו ולא נרשמו). המחזורים שנבחרו נסגרים כהנחה בגובה היתרה, עם הסיבה ביומן. הנחה אינה הכנסה — אם ידוע שהכסף התקבל ומתי, עדיף «דווח תשלום» בכרטיס המטופל/ת.</p>'
        + '<div class="tbl-wrap"><table class="tbl" id="crm-cleanup-rows"><thead><tr><th><input type="checkbox" data-cleanup-all aria-label="בחירת הכל"' + (rows.every(function (r) { return sel[r.id]; }) ? ' checked' : '') + '></th><th>שם</th><th>בית</th><th>מחזור</th><th>יתרה</th><th>ימים</th></tr></thead><tbody>'
        + rows.map(function (r, i) {
          return '<tr><td><input type="checkbox" data-cleanup-row="' + i + '" aria-label="' + esc(r.name + ' ' + fmtDate(r.start)) + '"' + (sel[r.id] ? ' checked' : '') + '></td><td><button type="button" class="link" data-open-patient="' + esc(r.patientId) + '" data-open-tab="account">' + esc(r.name) + '</button></td><td>' + esc(r.houseName) + '</td><td>' + esc(fmtDate(r.start)) + (r.end ? '–' + esc(fmtDate(r.end)) : '') + (r.kind === 'unrecorded' ? ' <span class="na">ללא דיווח</span>' : '') + '</td><td>' + esc(fmtMoney(r.balance)) + '</td><td>' + r.days + '</td></tr>';
        }).join('') + '</tbody></table></div>'
        + '<form class="new-lead report" data-form="cleanup" novalidate>'
        + '<label>סיבה *<select name="reason"><option value="">בחרי…</option>' + CLEANUP_REASONS.map(function (x) { return '<option value="' + esc(x.id) + '">' + esc(x.label) + '</option>'; }).join('') + '</select><div class="err" data-err="reason"></div></label>'
        + '<label>הערה (לא חובה, עד 60 תווים)<input type="text" name="note" maxlength="60" value=""><div class="err" data-err="note"></div></label>'
        + '<div class="wide err" data-err="_form"></div>'
        + '<div class="wide toolbar"><button type="submit" class="btn primary">סגירת המחזורים שנבחרו</button><span class="na" id="crm-cleanup-sum">' + esc(cleanupSumText()) + '</span></div></form></details>';
      return html;
    }
    function cleanupSelected() {
      const sel = state.cleanupSel || {};
      return (state.cleanupRows || []).filter(function (r) { return sel[r.id]; });
    }
    function cleanupSumText() {
      const rows = cleanupSelected();
      if (!rows.length) return 'לא נבחרו מחזורים';
      const people = {}; rows.forEach(function (r) { people[r.patientKey] = true; });
      return 'נבחרו ' + rows.length + ' מחזורים של ' + Object.keys(people).length + ' מטופלים · ' + fmtMoney(rows.reduce(function (t, r) { return t + r.balance; }, 0));
    }
    function submitCleanup(f) {
      if (state.saving) return Promise.resolve(false);
      const plan = cleanupPlan(cleanupSelected(), f.elements.reason.value, f.elements.note.value);
      if (!plan.ok) { showReportIssues(f, Object.keys(plan.errors).map(function (k) { return { field: k, hebrewMessage: plan.errors[k] }; }), 'יש לתקן את השדות המסומנים'); return Promise.resolve(false); }
      showReportIssues(f, []);
      if (!win.confirm('לסגור ' + plan.cycles + ' מחזורים בסך ' + fmtMoney(plan.total) + '?\n' + plan.reasonText + '\nכל סגירה נרשמת ביומן.')) return Promise.resolve(false);
      const st = $('#crm-cleanup-sum');
      state.saving = true; markBusy();
      let done = 0;
      const step = function (i) {
        if (i >= plan.writes.length) return Promise.resolve('');
        if (st) st.textContent = 'סוגר… ' + (i + 1) + '/' + plan.writes.length;
        return win.fetch('/api/sheets', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cleanupBody(plan.writes[i], plan.reasonText)) })
          .then(function (r) { return r.json().catch(function () { return { ok: false, error: 'bad_json' }; }); })
          .then(function (res) {
            const why = writeRefusal(res, '');
            if (why) return plan.writes[i].name + ' ' + plan.writes[i].month + ': ' + why;
            done++; return step(i + 1);
          });
      };
      return step(0).catch(function (e) { return String(e && e.message || e); }).then(function (err) {
        state.saving = false; clearBusy();
        state.cleanupSel = {};
        if (err) toast('נסגרו ' + done + ' מתוך ' + plan.writes.length + '. נעצר: ' + err, true);
        else toast('נסגרו ' + plan.cycles + ' מחזורים ✓');
        state.cleanupOpen = true;
        resetBilling(); renderMain();
        return !err;
      });
    }
    function renderBilling() {
      if (!state.billing) { loadBilling(); return '<div class="crm-state">טוען נתוני גבייה…</div>'; }
      const b = billingOverview(state.billing.debt, state.billing.payments, state.today);
      const isController = !!(state.me && state.me.view === 'controller');
      const bf = state.billingFilter || '';
      const kpi = function (v, l, f) { return f ? '<button type="button" class="kpi' + (bf === f ? ' on' : '') + '" data-billing-filter="' + esc(f) + '" aria-pressed="' + (bf === f) + '"><span class="v">' + esc(v) + '</span><span class="l">' + esc(l) + '</span><span class="l2 go">סינון הרשימה ←</span></button>' : '<div class="kpi"><span class="v">' + esc(v) + '</span><span class="l">' + esc(l) + '</span></div>'; };
      let html = '';
      /* The top search box, while this area is open, looks the NAME up across
       * debtors, receipts and every patient (released included) — the date-
       * scoped overview below stays as it is (CHANGELOG-billing-search-any-patient.md). */
      const srch = billingSearch(b, state.filters.q, compute(state.data, state.today).patients);
      if (srch) {
        const stLabel = function (p) { return p.status === 'released' ? 'שוחרר/ה' : ((PATIENT_STATUSES.filter(function (x) { return x.id === p.status; })[0] || {}).label || p.status); };
        html += '<div class="group-title">תוצאות חיפוש «' + esc(srch.q) + '» <span class="na">' + srch.total + '</span></div>';
        if (!srch.total) html += '<div class="crm-state">לא נמצא מטופל/ת בשם «' + esc(srch.q) + '» — לא בבתים, לא בין המשוחררים ולא בתקבולים</div>';
        if (srch.debtors.length) html += '<div class="tbl-wrap"><table class="tbl" id="crm-search-debtors"><thead><tr><th>שם</th><th>בית</th><th>חוב</th><th>מחזורים</th><th>סטטוס</th></tr></thead><tbody>'
          + srch.debtors.map(function (p) { return '<tr data-open-patient="' + esc(p.id) + '"><td>' + esc(p.name) + '</td><td>' + esc(p.houseName) + '</td><td>' + esc(fmtMoney(p.balance)) + '</td><td>' + p.cycles + '</td><td>' + esc(p.inHouse ? 'בבית' : (p.status === 'released' ? 'שוחרר/ה' : p.status)) + '</td></tr>'; }).join('') + '</tbody></table></div>';
        if (srch.people.length) html += '<div class="tbl-wrap"><table class="tbl" id="crm-search-people"><thead><tr><th>שם</th><th>בית</th><th>סטטוס</th><th>כניסה</th><th>יציאה</th></tr></thead><tbody>'
          + srch.people.map(function (p) { return '<tr data-open-patient="' + esc(p.id) + '"><td>' + esc(p.name) + '</td><td>' + esc(p.houseName) + '</td><td>' + esc(stLabel(p)) + '</td><td>' + esc(fmtDate(p.date)) + '</td><td>' + esc(fmtDate(p.exitDate)) + '</td></tr>'; }).join('') + '</tbody></table></div>';
        if (srch.receipts.length) html += '<div class="tbl-wrap"><table class="tbl" id="crm-search-receipts"><thead><tr><th>תאריך</th><th>שם</th><th>בית</th><th>סכום</th><th>אמצעי</th></tr></thead><tbody>'
          + srch.receipts.map(function (r) { return '<tr data-receipt="' + esc(r.id) + '"><td>' + esc(fmtDate(r.receivedDate)) + '</td><td>' + esc(r.patientName) + '</td><td>' + esc(r.houseName) + '</td><td>' + esc(fmtMoney(r.amount)) + '</td><td>' + esc(r.method) + '</td></tr>'; }).join('') + '</tbody></table></div>';
        html += '<p class="na">פתיחת שורה → כרטיס המטופל/ת, לשונית «חשבון» — כל המחזורים והתקבולים.</p>';
      }
      if (b.errors.length) html += '<div class="crm-state bad">' + esc(b.errors.join(' · ')) + ' <button type="button" class="btn small" data-billing-retry>נסי שוב</button></div>';
      html += renderAnomalies(billingAnomalies(compute(state.data, state.today), state.billing.debt, state.today));
      html += renderDueOnDate(isController);
      html += renderCashForecast();
      html += '<div class="kpis">' + kpi(fmtMoney(b.openDebt), 'חוב פתוח (' + b.openCycles + ' מחזורים)', 'all') + kpi(fmtMoney(b.over60), 'מעל 60 יום', 'd61_plus')
        + kpi(b.debtors, 'מטופלים עם חוב', 'all') + kpi(fmtMoney(b.received30), 'התקבל ב-30 יום (' + b.received30Count + ')', 'received') + kpi(b.toVerify, 'דיווחים לאימות', 'toVerify') + '</div>';
      html += '<div class="group-title">גיול חוב נכון ל-' + esc(fmtDate(b.asOf)) + '</div><div class="kpis">' + b.buckets.map(function (x) { return kpi(fmtMoney(x.amount), x.label, x.key); }).join('') + '</div>';
      if (b.houses.length) {
        html += '<div class="group-title">חוב לפי בית</div><div class="tbl-wrap"><table class="tbl"><thead><tr><th>בית</th><th>חוב</th><th>מחזורים</th></tr></thead><tbody>'
          + b.houses.map(function (h) { return '<tr><td>' + esc(h.name) + '</td><td>' + esc(fmtMoney(h.total)) + '</td><td>' + h.count + '</td></tr>'; }).join('') + '</tbody></table></div>';
      }
      const debtFilter = ['d0_7', 'd8_30', 'd31_60', 'd61_plus'].indexOf(bf) >= 0 ? bf : '';
      const debtors = debtFilter ? b.patients.filter(function (p) { return p.bucket === debtFilter; }) : b.patients;
      const filterChip = bf && bf !== 'all' ? ' <button type="button" class="chip today" data-billing-filter="">סינון: ' + esc(bf === 'received' ? 'התקבל ב-30 יום' : bf === 'toVerify' ? 'דיווחים לאימות' : (DEBT_BUCKET_LABELS[bf] || bf)) + ' ✕</button>' : '';
      html += '<div class="group-title" id="crm-debtors-title">חובות פתוחים לפי מטופל/ת' + (b.funderGrace.count ? ' ' + chip('wait', b.funderGrace.count + ' בחלון גוף מממן') : '') + (debtFilter ? filterChip : '') + '</div>';
      if (!debtors.length) html += '<p class="na">' + (debtFilter ? 'אין חובות בטווח הזה.' : 'אין חובות פתוחים.') + '</p>';
      else html += '<div class="tbl-wrap"><table class="tbl" id="crm-debtors"><thead><tr><th>שם</th><th>בית</th><th>חוב</th><th>מחזורים</th><th>הוותיק ביותר</th><th>סטטוס</th></tr></thead><tbody>'
        + debtors.map(function (p) {
          const st = p.bucket === 'd61_plus' ? 'late' : p.bucket === 'd31_60' ? 'today' : 'ok';
          return '<tr data-open-patient="' + esc(p.id) + '"><td>' + esc(p.name) + '</td><td>' + esc(p.houseName) + '</td><td>' + esc(fmtMoney(p.balance)) + '</td><td>' + p.cycles + (p.unrecorded ? ' <span class="na">(' + p.unrecorded + ' ללא דיווח)</span>' : '') + '</td><td>'
            + chip(st, p.oldestDays + ' ימים') + (p.grace ? ' ' + chip('wait', 'גוף מממן') : '') + '</td><td>' + esc(p.inHouse ? 'בבית' : (p.status === 'released' ? 'שוחרר/ה' : p.status)) + '</td></tr>';
        }).join('') + '</tbody></table></div>';
      if (!isController) html += renderCleanup();
      const receipts = bf === 'toVerify' ? b.receipts.filter(function (r) { return r.confirmStatus !== 'confirmed'; }) : b.receipts;
      html += '<div class="group-title" id="crm-receipts-title">' + (bf === 'toVerify' ? 'תקבולים הממתינים לאימות' : 'תקבולים אחרונים') + ((bf === 'received' || bf === 'toVerify') ? filterChip : '') + '</div>';
      if (!receipts.length) html += '<p class="na">אין תקבולים.</p>';
      else html += '<div class="tbl-wrap"><table class="tbl" id="crm-receipts"><thead><tr><th>תאריך</th><th>שם</th><th>בית</th><th>סכום</th><th>אמצעי</th><th>אימות</th></tr></thead><tbody>'
        + receipts.map(function (r) {
          const cs = r.confirmStatus === 'confirmed' ? 'ok' : r.confirmStatus === 'flagged' ? 'late' : 'today';
          return '<tr data-receipt="' + esc(r.id) + '"><td>' + esc(fmtDate(r.receivedDate)) + '</td><td>' + esc(r.patientName) + '</td><td>' + esc(r.houseName) + '</td><td>' + esc(fmtMoney(r.amount)) + '</td><td>' + esc(r.method) + '</td><td>' + (r.confirmStatus ? chip(cs, CONFIRM_LABELS[r.confirmStatus] || r.confirmStatus) : '') + '</td></tr>';
        }).join('') + '</tbody></table></div>';
      const pend = pendingCredits(state.billing.credits);
      html += '<div class="group-title">זיכויים לתשלום' + (pend.length ? ' ' + chip('today', pend.length + ' · ' + fmtMoney(pend.reduce(function (t, c) { return t + c.amount; }, 0))) : '') + '</div>';
      if (!pend.length) html += '<p class="na">אין זיכויים ממתינים.</p>';
      else html += '<div class="tbl-wrap"><table class="tbl" id="crm-pending-credits"><thead><tr><th>שם</th><th>בית</th><th>סוג</th><th>חודש</th><th>לתשלום עד</th><th>סכום</th><th></th></tr></thead><tbody>'
        + pend.map(function (c) {
          return '<tr><td>' + esc(c.patientName) + '</td><td>' + esc(c.houseName) + '</td><td>' + esc(CREDIT_TYPE_LABELS[c.creditType] || c.creditType) + '</td><td>' + esc(c.allocationMonth) + '</td><td>' + esc(fmtDate(c.payoutDate)) + '</td><td>' + esc(fmtMoney(c.amount)) + '</td>'
            + '<td><span class="na">' + esc(refundStageText(c)) + '</span> ' + refundActionButton(c, state.me) + '</td></tr>';
        }).join('') + '</tbody></table></div>';
      html += '<div id="crm-refund-form"></div>';
      const det = detachedRows(state.billing.debt);
      html += '<div class="group-title">שיוך תשלומים' + (det.length ? ' ' + chip('late', det.length + ' ללא שיוך') : '') + '</div>';
      if (!det.length) html += '<p class="na">כל התשלומים משויכים.</p>';
      else html += '<p class="na">תשלומים שלא נמצא להם מטופל/ת נוכחי/ת (שם שונה, בית אחר, רשומה ישנה). שיוך מזיז את הכסף לחשבון של המטופל/ת.</p><div class="tbl-wrap"><table class="tbl" id="crm-detached"><thead><tr><th>שם בשורה</th><th>בית</th><th>לתשלום</th><th>סכום</th><th>התקבל</th><th></th></tr></thead><tbody>'
        + det.map(function (r) {
          return '<tr data-detached="' + esc(r.paymentId) + '"><td>' + esc(r.patientName) + '</td><td>' + esc(r.houseName) + '</td><td>' + esc(fmtDate(r.dueDate)) + '</td><td>' + esc(fmtMoney(r.amount)) + '</td><td>' + esc(fmtMoney(r.received)) + '</td>'
            + '<td>' + (!isController ? '<button type="button" class="btn small primary" data-link-open="' + esc(r.paymentId) + '">שייך</button> <button type="button" class="btn small" data-notpatient-open="' + esc(r.paymentId) + '">לא מטופל/ת</button>' : '') + '</td></tr>';
        }).join('') + '</tbody></table></div><div id="crm-link"></div>';
      html += '<div class="group-title">פעולות (בדשבורד הרגיל)</div><div class="links">'
        + (isController ? '<a href="/?view=classic">בקרת גבייה<small>אימות דיווחים</small></a>' : '<a href="/?view=classic">דשבורד רגיל<small>גיבוי בלבד — קבלות, זיכויים ושיוך נעשים כאן, בכרטיס המטופל/ת</small></a>')
        + '</div>';
      return html;
    }

    /* «חריגים לבדיקה» (CHANGELOG-crm-kpi-tab.md): open things that cannot both be true. Each row
     * opens the stays it names; the fix is made on the record. Read-only. */
    function renderAnomalies(rows) {
      let html = '<div class="group-title" id="crm-anomalies-title">חריגים לבדיקה' + (rows.length ? ' ' + chip('late', rows.length + ' לבדיקה') : '') + '</div>';
      if (!rows.length) return html + '<p class="na">לא נמצאו חריגים.</p>';
      return html + '<div class="tbl-wrap"><table class="tbl" id="crm-anomalies"><thead><tr><th>חריג</th><th>שם</th><th>בית</th><th>פירוט</th><th>שהיות</th></tr></thead><tbody>'
        + rows.map(function (r) {
          return '<tr data-anomaly="' + esc(r.kind) + '"><td>' + chip('late', r.label) + '</td><td>' + esc(r.name) + '</td><td>' + esc(r.house) + '</td><td>' + esc(r.why) + '</td><td>'
            + r.stays.map(function (st) { return '<button type="button" class="btn small" data-open-patient="' + esc(st.id) + '" data-open-tab="account">' + esc(st.house + ' · ' + fmtDate(st.date) + '–' + (st.exitDate ? fmtDate(st.exitDate) : '?')) + '</button>'; }).join(' ')
            + '</td></tr>';
        }).join('') + '</tbody></table></div><p class="na">כל חריג נשאר כאן עד שהרשומה מתוקנת (תאריכים, שחרור כפול, סכום). שתי שהיות חופפות של אותו אדם = חיוב כפול אפשרי.</p>';
    }
    function renderOccupancy(c) {
      const o = occupancyToday(c.patients);
      return '<div class="kpis">' + '<div class="kpi" id="crm-occ-today"><span class="v">' + o.pct + '%</span><span class="l">תפוסה היום</span><span class="l2">' + o.totalIn + ' מטופלים מתוך ' + o.totalCap + ' מיטות</span></div>'
        + [['מיטות פנויות', o.totalFree], ['קיבולת', o.totalCap]].map(function (x) { return '<div class="kpi"><span class="v">' + x[1] + '</span><span class="l">' + esc(x[0]) + '</span></div>'; }).join('') + '</div>'
        + '<div class="links">' + o.houses.map(function (h) {
          const state_ = h.closed ? 'wait' : (h.free === 0 ? 'late' : (h.free <= 2 ? 'today' : 'ok'));
          return '<a href="#" data-house-open="' + esc(h.name) + '"><strong>' + esc(h.name) + '</strong> ' + chip(state_, h.closed ? 'סגור' : h.free + ' פנויות') + '<small>' + h.inHouse + ' / ' + (h.capacity || '—') + (h.capacity ? ' · ' + h.pct + '%' : '') + '</small></a>';
        }).join('') + (o.unknown ? '<a href="/?view=classic"><strong>בית לא מזוהה</strong> ' + chip('late', o.unknown + ' מטופלים') + '<small>לתיקון בדשבורד</small></a>' : '') + '</div>'
        + '<p class="na">קליטה, יציאה והעברה בין בתים נעשות בדשבורד הרגיל (תפוסה).</p>';
    }

    /* «בקרה» (Stage 3b): the same rows as «היום שלי» / the triage, so every number opens its list. */
    function renderControl(c) {
      const m = model(c);
      const queues = workControlQueues(m);
      const tq = state.tasks && state.index ? triageQueue(c, state.tasks, state.index, state.today).length : null;
      const cards = [
        { id: 'unseen', label: 'דיווחי מנהל/ת שלא נקראו', value: queues.unseen.length, go: { area: 'today', workControl: 'unseen' } },
        { id: 'undecided', label: 'דיווחים שנקראו ללא החלטה', value: queues.undecided.length, go: { area: 'today', workControl: 'undecided' } },
        { id: 'noContact', label: 'רשומות שדורשות בירור', value: tq, hint: tq === null ? (state.tasks === undefined || state.index === undefined ? 'טוען…' : 'המידע אינו זמין') : 'ללא מגע מתועד וללא משימה', go: { area: 'triage' } },
        { id: 'late', label: 'משימות באיחור', value: state.tasks ? queues.late.length : null, hint: state.tasks ? '' : (state.tasks === undefined ? 'טוען…' : 'המידע אינו זמין'), go: { area: 'today', workControl: 'late' } },
        { id: 'awaitingReport', label: 'פגישות שעברו ללא דיווח', value: queues.awaitingReport.length, go: { area: 'today', workControl: 'awaitingReport' } },
        { id: 'unscheduled', label: 'ביקורים ללא תאריך', value: queues.unscheduled.length, go: { area: 'today', workControl: 'unscheduled' } },
        { id: 'admitting', label: 'מעברים פתוחים (קליטה)', value: c.leads.filter(function (l) { return l.stage === 'paid'; }).length, hint: houseExceptions(c, state.today).filter(function (r) { return r.kind === 'admission_due'; }).length + ' אחרי תאריך הכניסה', go: { area: 'leads', view: 'board' } },
      ];
      return '<p class="na" id="crm-control-about">«בקרת עבודה» = מה נתקע בעבודה השוטפת: דיווחים שלא נקראו, רשומות בלי מגע, משימות באיחור ופגישות בלי תוצאה. כל מספר נפתח לרשימה לטיפול. מדדים ואחוזים — בלשונית KPI.</p>'
        + '<div class="kpis cards">' + cards.map(function (k) {
        return '<button type="button" class="kpi acc-' + esc(k.id) + '" data-go="' + esc(JSON.stringify(k.go)) + '">' + (k.value === null ? '<span class="v na-v">—</span>' : '<span class="v">' + k.value + '</span>') + '<span class="l">' + esc(k.label) + '</span>' + (k.hint ? '<span class="l2">' + esc(k.hint) + '</span>' : '') + '<span class="l2 go">פתיחת הרשימה ←</span></button>';
      }).join('') + '</div><p class="na">כל מספר נפתח לרשימה שלו — אותם נתונים כמו ב«היום שלי»; מדדים עסקיים ייבנו ממקורות מוגדרים.</p>';
    }

    /* «KPI» (CHANGELOG-crm-kpi-tab.md): occupancy today, lead conversion, close rate per
     * manager, length of stay and — finance only — break-even. Read-only except the
     * break-even expenses, which live in this browser (the classic tab's own storage). */
    function signedMoney(n) { const v = Math.round(Number(n) || 0); return (v < 0 ? '-' : '') + fmtMoney(Math.abs(v)); }
    function readBreakevenConfig() {
      let raw = null;
      try { raw = win.localStorage ? win.localStorage.getItem(BREAKEVEN_STORAGE_KEY) : null; } catch (_) { raw = null; }
      return breakevenConfig(raw);
    }
    function flatRawPatients() {
      const p = state.data && state.data.patients, out = [];
      if (Array.isArray(p)) p.forEach(function (x) { out.push(x); });
      else if (p && typeof p === 'object') Object.keys(p).forEach(function (h) { (Array.isArray(p[h]) ? p[h] : []).forEach(function (x) { out.push(Object.assign({ houseId: h }, x)); }); });
      return out;
    }
    /* A number / amount / percentage kept left-to-right inside the RTL page (a minus sign stays in front). */
    function ltr(v) { return '<bdi dir="ltr">' + esc(v) + '</bdi>'; }
    function kpiCard(v, label, sub, id) {
      return '<div class="kpi"' + (id ? ' id="' + esc(id) + '"' : '') + '><span class="v">' + ltr(v) + '</span><span class="l">' + esc(label) + '</span>' + (sub ? '<span class="l2">' + esc(sub) + '</span>' : '') + '</div>';
    }
    function renderKpi(c) {
      const pid = KPI_PERIODS.some(function (x) { return x.id === state.kpiPeriod; }) ? state.kpiPeriod : 'last_3_months';
      const range = kpiPeriod(pid, state.today) || { from: state.today, to: state.today };
      let html = '<div class="toolbar filters" id="crm-kpi-periods">' + KPI_PERIODS.map(function (x) {
        return '<button type="button" class="btn small' + (x.id === pid ? ' primary' : '') + '" data-kpi-period="' + esc(x.id) + '" aria-pressed="' + (x.id === pid) + '">' + esc(x.label) + '</button>';
      }).join('') + '<span class="na">' + esc(fmtDate(range.from)) + ' – ' + esc(fmtDate(range.to)) + '</span></div>';

      // 1. occupancy today
      const o = occupancyToday(c.patients);
      html += '<div class="group-title">תפוסה היום</div><div class="kpis">' + kpiCard(o.pct + '%', 'תפוסה היום', o.totalIn + ' מתוך ' + o.totalCap + ' מיטות', 'crm-kpi-occ')
        + kpiCard(o.totalIn, 'בטיפול היום') + kpiCard(o.totalFree, 'מיטות פנויות') + '</div>'
        + '<div class="tbl-wrap"><table class="tbl" id="crm-kpi-occ-houses"><thead><tr><th>בית</th><th>בטיפול</th><th>קיבולת</th><th>תפוסה</th><th>פנויות</th></tr></thead><tbody>'
        + o.houses.map(function (h) { return '<tr><td>' + esc(h.name) + '</td><td>' + h.inHouse + '</td><td>' + (h.capacity || '—') + '</td><td>' + (h.capacity ? h.pct + '%' : '—') + '</td><td>' + h.free + '</td></tr>'; }).join('')
        + '</tbody></table></div>';

      // 2. lead conversion
      const lc = leadConversion(state.data, c, range.from, range.to);
      html += '<div class="group-title">המרת לידים למטופלים <span class="na">לידים שנפתחו בתקופה: ' + lc.total + '</span></div>'
        + '<div class="kpis">' + kpiCard(fmtPct(lc.pct), 'הפכו למטופלים', lc.converted + ' מתוך ' + lc.total + ' (אשפוז + אמבולטורי)', 'crm-kpi-conv')
        + FATES.map(function (f) { return kpiCard(lc.counts[f.id], f.label, fmtPct(lc.pcts[f.id])); }).join('') + '</div>';
      if (lc.houses.length) html += '<div class="tbl-wrap"><table class="tbl" id="crm-kpi-conv-houses"><thead><tr><th>בית (בליד)</th><th>לידים</th><th>אשפוז</th><th>אמבולטורי</th><th>% המרה</th></tr></thead><tbody>'
        + lc.houses.map(function (h) { return '<tr><td>' + esc(h.house) + '</td><td>' + h.total + '</td><td>' + h.inpatient + '</td><td>' + h.outpatient + '</td><td>' + esc(fmtPct(h.pct)) + '</td></tr>'; }).join('') + '</tbody></table></div>';
      html += '<p class="na">לפי תאריך פתיחת הליד. ' + (lc.direct ? lc.direct + ' מטופלים שנוספו ישירות (פנייה ישירה) אינם נספרים כלידים. ' : '') + (lc.noCreated ? lc.noCreated + ' לידים ללא תאריך פתיחה לא נספרו. ' : '') + (lc.noHouse ? lc.noHouse + ' לידים ללא בית מזוהה נספרו בסיכום אך אינם מוצגים בטבלה.' : '') + '</p>';

      // 3. close rate per manager
      const mc = managerCloseRates(state.data, c, range.from, range.to, state.today);
      html += '<div class="group-title">סגירה לאחר פגישה — לפי מנהל/ת <span class="na">פגישות בתקופה: ' + mc.total.meetings + '</span></div>';
      if (!mc.rows.length) html += '<p class="na">אין פגישות עם שם מנהל/ת בתקופה' + (mc.skipped ? ' (' + mc.skipped + ' ללא שם תקין)' : '') + '.</p>';
      else html += '<div class="tbl-wrap"><table class="tbl" id="crm-kpi-managers"><thead><tr><th>מנהל/ת</th><th>פגישות</th><th>נכנסו לטיפול</th><th>% סגירה</th><th>נסגרו ללא כניסה</th><th>%</th><th>עדיין פתוחים</th></tr></thead><tbody>'
        + mc.rows.map(function (r) {
          return '<tr><td>' + esc(r.manager) + '</td><td>' + r.meetings + '</td><td>' + r.entered + '</td><td><strong>' + esc(fmtPct(r.closePct)) + '</strong></td><td>' + r.lost + '</td><td>' + esc(fmtPct(r.lostPct)) + '</td><td>' + r.open + '</td></tr>';
        }).join('') + '</tbody><tfoot><tr><td>סה״כ</td><td>' + mc.total.meetings + '</td><td>' + mc.total.entered + '</td><td><strong>' + esc(fmtPct(mc.total.closePct)) + '</strong></td><td>' + mc.total.lost + '</td><td>' + esc(fmtPct(mc.total.lostPct)) + '</td><td>' + mc.total.open + '</td></tr></tfoot></table></div>'
        + '<p class="na">פגישה = תאריך ביקור שעבר (או דיווח מנהל/ת) בתקופה. «נכנסו» = הפכו למטופלים בבית או באמבולטורי.' + (mc.skipped ? ' ' + mc.skipped + ' פגישות ללא שם מנהל/ת תקין לא נכללו.' : '') + '</p>';

      // 4. length of stay + continuity (lib/patient-retention.js, the classic «חתכי מטופלים»)
      const R = win.PatientRetention && typeof win.PatientRetention.computeRetention === 'function' ? win.PatientRetention : null;
      if (R) {
        const rr = R.computeRetention({ patients: flatRawPatients(), discharged: state.data.dischargedPatients || [], from: range.from, to: range.to, customThreshold: null, today: state.today });
        if (rr && rr.ok) {
          const pf = function (f) { return f === null || f === undefined ? '—' : Math.round(f * 1000) / 10 + '%'; };
          html += '<div class="group-title">משך שהייה והמשך טיפול <span class="na">נכנסו בתקופה: ' + rr.cohortSize + '</span></div><div class="kpis" id="crm-kpi-stay">'
            + R.BUCKETS.map(function (b) { return kpiCard(rr.counts[b.key], b.label, pf(rr.percents[b.key])); }).join('')
            + kpiCard(rr.stillInTreatment.count, R.STILL_IN_TREATMENT_LABEL, pf(rr.percents.stillInTreatment))
            + R.CONTINUITY_KEYS.map(function (k) { return kpiCard(rr.continuity[k], R.CONTINUITY_LABELS[k], pf(rr.percents.continuity[k]) + ' מהמשוחררים'); }).join('') + '</div>'
            + (rr.missingCount ? '<p class="na">' + rr.missingCount + ' שהיות עם ' + esc(R.MISSING_LABEL) + ' — לא נספרו.</p>' : '');
        }
      }

      // 5. break-even (finance only — an ops session has no prices)
      if (state.me && state.me.finance) html += renderBreakeven(c);
      return '<div class="kpi-page">' + html + '</div>';   // bold section headings (CHANGELOG-crm-kpi-headings.md)
    }
    function renderBreakeven(c) {
      const cfg = readBreakevenConfig();
      const be = breakevenReport(c.patients, cfg);
      const n = be.network;
      const shown = be.houses.filter(function (m) { return m.active || (!m.closed && m.currentPatients > 0); });
      let html = '<div class="group-title">נקודת איזון לבית <span class="na">הכנסה ללא מע״מ · הוצאות ' + (cfg.fromStorage ? 'כפי שנשמרו בדפדפן זה' : 'לפי הדוח הפיננסי (ברירת מחדל)') + '</span></div>'
        + '<div class="kpis" id="crm-kpi-network">' + kpiCard(signedMoney(n.housesPL), 'רווח/הפסד בתים (חודשי)') + kpiCard(fmtMoney(n.hqCost), 'עלות מטה')
        + kpiCard(signedMoney(n.networkPL), 'רווח/הפסד רשת אחרי מטה') + kpiCard(n.totalPatientsCurrent + ' / ' + n.networkBreakeven, 'מטופלים היום / נקודת איזון רשת') + '</div>'
        + '<div class="tbl-wrap"><table class="tbl" id="crm-kpi-breakeven"><thead><tr><th>בית</th><th>מטופלים</th><th>נקודת איזון</th><th>מצב</th><th>מחיר ממוצע</th><th>הכנסה</th><th>הוצאות</th><th>רווח/הפסד</th><th>רווח גולמי</th></tr></thead><tbody>'
        + shown.map(function (m) {
          if (!m.active) return '<tr><td>' + esc(m.name) + '</td><td>' + m.currentPatients + '</td><td colspan="7" class="na">אין נתוני הוצאות לבית — לא נכלל בחישוב (להזין למטה)</td></tr>';
          const st = m.currentPatients >= m.breakevenPoint ? chip('ok', 'עבר (+' + (m.currentPatients - m.breakevenPoint) + ')') : chip('late', 'חסרים ' + m.gap);
          return '<tr><td>' + esc(m.name) + '</td><td>' + ltr(m.currentPatients + ' / ' + m.capacity) + '</td><td><strong>' + m.breakevenPoint + '</strong></td><td>' + st + '</td><td>' + ltr(fmtMoney(m.price)) + '</td><td>' + ltr(fmtMoney(m.currentRevenue)) + '</td><td>' + ltr(fmtMoney(m.totalExpenses)) + '</td><td>' + ltr(signedMoney(m.currentPL)) + '</td><td>' + (m.marginPct === null ? '—' : ltr((Math.round(m.marginPct * 10) / 10) + '%')) + '</td></tr>';
        }).join('') + '</tbody></table></div>'
        + '<details class="act" id="crm-be-edit"><summary>עדכון הוצאות (נשמר בדפדפן זה, משותף עם הדשבורד הרגיל)</summary><form data-form="breakeven" novalidate>'
        + '<label>עלות מטה (₪) <input type="number" name="hqCost" min="0" step="1" value="' + esc(cfg.hqCost) + '"><span class="err" data-err="hqCost"></span></label>'
        + HOUSES.filter(function (h) { return !h.closed; }).map(function (h) {
          const x = cfg.houses[h.id];
          return '<fieldset class="be-house"><legend>' + esc(h.name) + '</legend><label><input type="checkbox" name="active_' + h.id + '"' + (x.active ? ' checked' : '') + '> נכלל בחישוב</label>'
            + '<label>קבועות (₪) <input type="number" name="fixed_' + h.id + '" min="0" step="1" value="' + esc(x.fixed) + '"></label>'
            + '<label>משתנות (₪) <input type="number" name="variable_' + h.id + '" min="0" step="1" value="' + esc(x.variable) + '"></label>'
            + '<span class="err" data-err="' + h.id + '"></span></fieldset>';
        }).join('')
        + '<button type="submit" class="btn small primary">שמירה</button></form></details>';
      return html;
    }
    /* The break-even expense form → { cfg, errs }. A house counted in the calculation needs expenses > 0. */
    function breakevenFromForm(f) {
      const cur = readBreakevenConfig();
      const num = function (n) { const el = f.elements[n]; const t = el ? s(el.value) : ''; return t === '' ? NaN : Number(t); };
      const errs = {};
      const hq = num('hqCost');
      if (!(hq >= 0)) errs.hqCost = 'סכום לא תקין';
      const houses = {};
      HOUSES.forEach(function (h) {
        if (h.closed) { houses[h.id] = cur.houses[h.id]; return; }
        const act = !!(f.elements['active_' + h.id] && f.elements['active_' + h.id].checked);
        const fx = num('fixed_' + h.id), vr = num('variable_' + h.id);
        if (!(fx >= 0) || !(vr >= 0)) errs[h.id] = 'סכום לא תקין';
        else if (act && fx + vr <= 0) errs[h.id] = 'בית שנכלל בחישוב צריך הוצאות';
        houses[h.id] = { active: act, fixed: fx >= 0 ? fx : 0, variable: vr >= 0 ? vr : 0 };
      });
      return { cfg: { hqCost: hq >= 0 ? hq : 0, houses: houses }, errs: errs };
    }
    function renderMain() {
      const title = (AREAS.filter(function (a) { return a.id === state.area; })[0] || AREAS[0]).label;
      $('#crm-title').textContent = title;
      if (state.loading) { main.innerHTML = '<div class="crm-state">טוען…</div>'; return; }
      if (state.error) { main.innerHTML = '<div class="crm-state bad">' + esc(state.error) + ' <button type="button" class="btn small" id="crm-retry">נסי שוב</button></div>'; return; }
      const c = compute(state.data, state.today);
      if (state.area === 'search') $('#crm-title').textContent = 'חיפוש';
      const r = { search: renderSearch, today: renderToday, leads: renderLeads, occupancy: renderOccupancy, clients: renderClients, calendar: renderCalendar, billing: renderBilling, control: renderControl, kpi: renderKpi, triage: renderTriage }[state.area] || renderToday;
      main.innerHTML = r(c);
    }

    /* The top search box from any area (CHANGELOG-crm-search-admit-funder.md): every lead and
     * every patient (released included) whose name / phone / house matches. */
    function renderSearch(c) {
      const r = globalSearch(c, state.filters.q);
      if (!r) return '<div class="crm-state">הקלידו שם, טלפון או בית בתיבת החיפוש</div>';
      let html = '<div class="group-title">תוצאות חיפוש «' + esc(r.q) + '» <span class="n chip">' + r.total + '</span></div>';
      if (!r.total) return html + '<div class="crm-state">לא נמצאו לידים או מטופלים עבור «' + esc(r.q) + '»</div>';
      if (r.patients.length) html += '<div class="group-title">מטופלים</div><div class="tbl-wrap"><table class="tbl" id="crm-search-patients"><thead><tr><th>שם</th><th>בית</th><th>סטטוס</th><th>כניסה</th><th>יציאה</th></tr></thead><tbody>'
        + r.patients.map(function (p) { return '<tr data-open-patient="' + esc(p.id) + '"><td class="name">' + esc(p.name) + '</td><td>' + esc(p.houseName) + '</td><td>' + statusChip(p.status) + '</td><td>' + esc(fmtDate(p.date)) + '</td><td>' + esc(fmtDate(p.exitDate)) + '</td></tr>'; }).join('') + '</tbody></table></div>';
      if (r.leads.length) html += '<div class="group-title">לידים</div><div class="tbl-wrap"><table class="tbl" id="crm-search-leads"><thead><tr><th>שם</th><th>טלפון</th><th>בית</th><th>שלב</th><th>נוצר</th></tr></thead><tbody>'
        + r.leads.map(function (l) { return '<tr data-open-lead="' + esc(l.id) + '"><td class="name">' + esc(l.name) + '</td><td>' + esc(l.phone) + '</td><td>' + esc(houseName(l.house)) + '</td><td>' + esc(l.stage === 'admitted' ? 'נקלט/ה' : stageLabel(l.stage)) + '</td><td>' + esc(fmtDate(l.created)) + '</td></tr>'; }).join('') + '</tbody></table></div>';
      return html;
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
      // A matched name/phone is not proof that the stay belongs to this lead.
      // Show a caution, but never close the lead as admitted without a verified
      // explicit lead-to-stay link (ARCH-01). Existing source records stay intact.
      const cAll = compute(state.data, state.today);
      const inH = leadAlreadyInHouse(l, cAll.patients, cAll.leads);
      const already = inH ? '<div class="notice warn">קיימת קליטה בשם או בטלפון דומים בבית ' + esc(houseName(inH.houseId))
        + '. יש לבדוק אם מדובר באותו אדם. הליד אינו נסגר אוטומטית.</div>' : '';
      return already + renderLeadActionsBody(l);
    }
    function renderLeadActionsBody(l) {
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
      const waUrl = managerChangeLink(l);
      const waBlock = waUrl ? '<div class="notice warn patient-change">' + esc(nextActionFor(l, state.today, flagsOf(state.index, l.id)).text) + ' <a class="btn small primary" target="_blank" rel="noopener" data-wa-manager href="' + esc(waUrl) + '">📲 הודעה למנהל/ת בוואטסאפ</a></div>' : '';
      return '<div class="actions" data-lead-actions="' + esc(l.id) + '">' + waBlock + (l.stage === 'paid' ? admit : '')
        + '<div class="toolbar">'
        + (prev ? '<button type="button" class="btn small" data-stage-prev="' + esc(l.id) + '">→ ' + esc(stageLabel(prev)) + '</button>' : '')
        + (next ? '<button type="button" class="btn small primary" data-stage-next="' + esc(l.id) + '">' + esc(stageLabel(next)) + ' ←</button>' : '')
        + '<span class="na" id="crm-save-state"></span></div>'
        + (l.stage === 'waitlist' ? waitReasonBlock(l) : '')
        + '<details class="act"><summary>תיאום פגישה</summary><form data-form="meeting" data-lead="' + esc(l.id) + '"><label>תאריך <input type="date" name="visitDate" value="' + esc(l.visitDate) + '"></label>'
        + '<label>שעה <input type="time" name="visitTime" value="' + esc(l.visitTime) + '"></label>'
        + '<label>נפגש/ת עם <select name="meetingWith">' + opts(managers, l.meetingWith, true) + '</select></label>'
        + '<button type="submit" class="btn small primary">שמירה</button></form></details>'
        + (l.stage === 'visit' && s(l.visitDate) ? patientChangeBlock(l) : '')
        + '<details class="act"><summary>דיווח תוצאת פגישה</summary><form data-form="outcome" data-lead="' + esc(l.id) + '"><label>תוצאה <select name="meetingOutcome"><option value="">—</option>' + MEETING_OUTCOMES.map(function (o) { return '<option value="' + o.id + '"' + (l.meetingOutcome === o.id ? ' selected' : '') + '>' + esc(o.label) + '</option>'; }).join('') + '</select></label>'
        + '<button type="submit" class="btn small primary">שמירה</button></form></details>'
        + '<details class="act"><summary>סגירת ליד / הסרה</summary><form data-form="close" data-lead="' + esc(l.id) + '" novalidate><label>סטטוס סגירה * <select name="disposition">' + DISPOSITIONS.map(function (d) { return '<option value="' + d.id + '">' + esc(d.label) + '</option>'; }).join('') + '</select><span class="err" data-err="disposition"></span></label>'
        + '<label>סיבה * <input name="note" type="text" maxlength="500" required><span class="err" data-err="note"></span></label>'
        + '<button type="submit" class="btn small primary">סגירת ליד</button> <button type="button" class="btn small" data-remove-lead="' + esc(l.id) + '">הסר (טעות)</button></form></details>'
        + '<details class="act"><summary>הערה ואחראי</summary><form data-form="note" data-lead="' + esc(l.id) + '"><label>אחראי <select name="assignedTo">' + opts(ASSIGNEES, l.assignedTo, true) + '</select></label>'
        + '<label>הערות <textarea name="note" rows="3">' + esc(l.note) + '</textarea></label>'
        + '<button type="submit" class="btn small primary">שמירה</button></form></details>'
        + '</div>';
    }
    /* «סיבת המתנה» (Vered 04/11/2026): open by default on a waitlist lead. */
    function waitReasonBlock(l) {
      const cur = flagsOf(state.index, l.id), now = cur && cur.waitReason ? cur.waitReason.reason : '';
      return '<details class="act" open><summary>סיבת המתנה</summary><form data-form="wait-reason" data-lead="' + esc(l.id) + '">'
        + '<div class="radio-row" role="radiogroup" aria-label="סיבת המתנה">' + WAIT_REASONS.map(function (r) { return '<label class="radio"><input type="radio" name="reason" value="' + r.id + '"' + ((now || 'place') === r.id ? ' checked' : '') + '> ' + esc(r.label) + '</label>'; }).join('') + '</div>'
        + '<p class="na" data-wait-state>' + (cur && cur.waitReason ? 'נשמר ' + esc(whenLocal(cur.waitReason.at)) + (cur.waitReason.actorName ? ' · ' + esc(cur.waitReason.actorName) : '') : 'לא נבחרה סיבה — מוצג «ממתין למקום». בחירה נשמרת מיד.') + '</p>'
        + '</form></details>';
    }
    /* «שינוי / ביטול ע״י המטופל/ת» (Vered 04/11/2026): writes the lead, records who changed it, then offers the manager's WhatsApp. */
    function patientChangeBlock(l) {
      return '<details class="act"><summary>הפגישה בוטלה / שונתה ע״י המטופל/ת</summary><form data-form="patient-change" data-lead="' + esc(l.id) + '" novalidate>'
        + '<div class="radio-row" role="radiogroup" aria-label="מה השתנה"><label class="radio"><input type="radio" name="change" value="cancelled"> בוטלה</label><label class="radio"><input type="radio" name="change" value="rescheduled"> שונה מועד</label></div><span class="err" data-err="change"></span>'
        + '<label>תאריך חדש <input type="date" name="newDate" min="' + esc(state.today) + '"><span class="err" data-err="newDate"></span></label>'
        + '<label>שעה חדשה <input type="time" name="newTime"><span class="err" data-err="newTime"></span></label>'
        + '<label class="wide">הערה למנהל/ת (לא חובה) <input type="text" name="note" maxlength="200"><span class="err" data-err="note"></span></label>'
        + '<p class="na">נשלחת הודעת וואטסאפ מוכנה ל' + esc(l.meetingWith || 'מנהל/ת הבית') + ' — יש ללחוץ «שליחה» בוואטסאפ.</p>'
        + '<button type="submit" class="btn small primary">שמירה והודעה למנהל/ת</button></form></details>';
    }
    /* The manager's WhatsApp link for the lead's current patient-side change, or ''. */
    function managerChangeLink(l) {
      const ch = patientMeetingChange(l, flagsOf(state.index, l.id));
      if (!ch) return '';
      const phones = state.data && state.data.managerPhones && typeof state.data.managerPhones === 'object' ? state.data.managerPhones : {};
      return managerWaUrl(phones[s(ch.withWhom || l.meetingWith)] || '', managerChangeMessage(l, ch));
    }
    function setSaveState(text, bad) {
      const el = $('#crm-save-state'); if (el) { el.textContent = text; el.style.color = bad ? 'var(--bad)' : ''; }
      if (text === 'שומר…') markBusy(); else clearBusy();
    }
    /* The submit button of the form being saved shows a spinner and is disabled until the
     * answer (CHANGELOG-crm-followups-1104.md). Re-found after a re-render; 30 s safety stop. */
    function markBusy() {
      const b = state.busyForm;
      if (!b) return;
      let f = null;
      doc.querySelectorAll('form[data-form="' + b.form.replace(/[^a-z0-9-]/gi, '') + '"]').forEach(function (x) {
        if (!f && (!b.key || [x.dataset.lead, x.dataset.discharge, x.dataset.patient].indexOf(b.key) >= 0)) f = x;
      });
      const btn = f ? f.querySelector('button[type="submit"]') : null;
      if (btn) { btn.disabled = true; btn.setAttribute('aria-busy', 'true'); }
      win.clearTimeout(state.busyTimer); state.busyTimer = win.setTimeout(clearBusy, 30000);
    }
    function clearBusy() {
      state.busyForm = null; win.clearTimeout(state.busyTimer);
      doc.querySelectorAll('#crm-root form button[aria-busy="true"]').forEach(function (b) { b.removeAttribute('aria-busy'); b.disabled = false; });
    }
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
      state.saving = true; markBusy(); renderNav(); renderMain(); if (state.drawer && state.drawer.id === id) openDrawer('lead', id, true);
      setSaveState('שומר…');
      return win.fetch('/api/sheets', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(leadSaveBody(next)) })
        .then(function (r) { return r.json().catch(function () { return null; }); })
        .then(function (res) {
          const why = saveRefusal(res, id);
          if (why) throw new Error(why);
          state.saving = false; clearBusy(); setSaveState('נשמר ✓'); toast((label || 'השינוי') + ' נשמר');
          return true;
        })
        .catch(function (e) {
          list[idx] = before; state.saving = false; clearBusy();
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
      const needsDate = target === 'visit' && !l.visitDate;
      writeLead(id, { stage: target }, 'המעבר ל«' + stageLabel(target) + '»').then(function (ok) {
        /* «ביקור נקבע» without a date is on no calendar and at no manager —
         * ask for it right here (CHANGELOG-undated-visit-leads.md). */
        if (ok && needsDate) { openDrawer('lead', id, true); focusMeetingForm(); toast('השלב נשמר — עכשיו תאריך הפגישה, אחרת היא לא תופיע ביומן ולא אצל המנהל/ת', true); }
      });
    }
    /* logLeadFlag (CHANGELOG-crm-vered-feedback-1104.md): the flag is applied to the
     * in-memory contact index only after the server echoes it; never assumed. */
    function postLeadFlag(flag, label, afterLeadSaved) {
      if (state.saving) { toast('שמירה קודמת עדיין מתבצעת — רגע אחד ונסי שוב', true); return Promise.resolve(false); }
      const key = s(flag.leadId) + ':' + s(flag.kind);
      const plan = leadFlagPendingPlan(pendingLeadFlags[key], flag, newSubmissionId);
      if (!plan.ok) {
        toast('יש רישום קודם שלא אומת. בדקי את ההיסטוריה ונסי שוב עם אותם פרטים לפני שינוי נוסף.', true);
        return Promise.resolve(false);
      }
      const pending = plan.pending;
      pendingLeadFlags[key] = pending;
      state.saving = true; markBusy(); setSaveState('שומר…');
      return win.fetch('/api/sheets', { method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(pending.body) })
        .then(function (r) { return r.json().catch(function () { return null; }); })
        .then(function (res) {
          if (!res || res.ok !== true || !res.flag ||
              s(res.flag.leadId) !== s(flag.leadId) || s(res.flag.kind) !== s(flag.kind)) {
            throw new Error((res && res.message) || 'לא התקבל אישור מקור');
          }
          delete pendingLeadFlags[key];
          state.saving = false; clearBusy();
          if (state.index && state.index.ok !== false) {
            if (!state.index.flags || typeof state.index.flags !== 'object') state.index.flags = {};
            const cur = state.index.flags[res.flag.leadId] || (state.index.flags[res.flag.leadId] = {});
            cur[res.flag.kind === 'waitlist_reason' ? 'waitReason' : 'meetingChange'] = res.flag;
          }
          setSaveState('נשמר ✓'); toast(label + ' נשמר/ה');
          renderNav(); renderMain();
          if (state.drawer && state.drawer.id === flag.leadId) openDrawer('lead', flag.leadId, true);
          return true;
        })
        .catch(function (_) {
          // The source may already have appended the event before the reply was
          // lost. Keep the same ID and payload; do not report the lead as unsaved.
          state.saving = false; clearBusy();
          const warning = afterLeadSaved
            ? 'הפגישה נשמרה, אך רישום השינוי לא אומת. לחצי שוב כדי לאמת בלי לשמור את הפגישה מחדש.'
            : 'רישום השינוי לא אומת. בדקי את ההיסטוריה; ניסיון חוזר ישתמש באותה אסמכתא.';
          setSaveState(warning, true); toast(warning, true);
          return false;
        });
    }
    /* Open the drawer's «תיאום פגישה» block and put the caret in its date. */
    function focusMeetingForm() {
      const f = $('#crm-drawer form[data-form="meeting"]');
      if (!f) return;
      const d = f.closest('details'); if (d) d.open = true;
      const inp = f.elements.visitDate; if (inp) { try { inp.focus(); } catch (_) { /* no-op */ } }
    }

    /* A status is read from OUT on demand; never inferred from the send flag. */
    const OUTPATIENT_STAGE_LABELS = Object.freeze({
      referred: 'הפניה התקבלה באמבולטורי', contacted: 'נוצר קשר', intro_scheduled: 'נקבעה פגישת היכרות',
      intro_passed: 'פגישת ההיכרות חלפה — תוצאה לא אומתה', plan: 'שלב תוכנית טיפול',
      admitted: 'נקלט/ה לטיפול חוץ', active: 'טיפול חוץ פעיל', ended: 'טיפול חוץ הסתיים',
      not_relevant: 'לא רלוונטי לטיפול חוץ',
    });
    function outpatientStatusButton(id, kind) {
      return '<div class="act"><button type="button" class="btn small" data-check-outpatient-status data-' +
        (kind === 'discharge' ? 'discharge-id' : 'lead-id') + '="' + esc(id) +
        '">בדיקת המשך טיפול באמבולטורי</button><span class="na" data-outpatient-status-value>טרם נבדק</span></div>';
    }
    root.addEventListener('click', function (ev) {
      const btn = ev.target && ev.target.closest ? ev.target.closest('[data-check-outpatient-status]') : null;
      if (!btn) return;
      ev.preventDefault();
      const id = btn.dataset.leadId || btn.dataset.dischargeId || '';
      const q = btn.dataset.leadId ? 'leadId' : 'dischargeId';
      const value = btn.parentNode && btn.parentNode.querySelector('[data-outpatient-status-value]');
      if (!id || btn.disabled) return;
      btn.disabled = true;
      if (value) value.textContent = 'בודק במערכת האמבולטורית…';
      win.fetch('/api/outpatient-handoff-status?' + q + '=' + encodeURIComponent(id), { credentials: 'same-origin' })
        .then(function (response) { return response.json().catch(function () { return null; }); })
        .then(function (data) {
          if (!data || data.ok !== true || !data.verified || !OUTPATIENT_STAGE_LABELS[data.state]) {
            if (value) value.textContent = 'הסטטוס לא אומת — בדקי ישירות באמבולטורי; אין לסגור מעקב.';
            return;
          }
          if (value) value.textContent = OUTPATIENT_STAGE_LABELS[data.state] +
            (data.assignedTo ? ' · אחראי/ת: ' + data.assignedTo : '') +
            (data.nextActionDate ? ' · פעולה עד ' + fmtDate(data.nextActionDate) : '') +
            (data.nextAction ? ' · ' + data.nextAction : '') +
            ' (מקור: Outpatient)';
        })
        .catch(function () {
          if (value) value.textContent = 'אין אימות מהאמבולטורי כרגע — המעקב נשאר פתוח.';
        })
        .finally(function () { btn.disabled = false; });
    });

    /* The client drawer: existing fields + the timeline from getActivity (B3). */
    function openDrawer(kind, id, keepTab) {
      const c = compute(state.data, state.today);
      const lead = kind === 'lead' ? c.leads.filter(function (l) { return l.id === id; })[0] : null;
      const pat = kind === 'patient' ? c.patients.filter(function (p) { return p.id === id; })[0] : null;
      if (!lead && !pat) { toast(kind === 'lead' ? 'הליד לא נמצא — ייתכן שנסגר או הועבר. רענני את הדף.' : 'כרטיס המטופל/ת לא נמצא ברשימת המטופלים — פתחי דרך «מטופלים» או בדשבורד הקלאסי.', true); return; }
      if (!(keepTab && state.drawer && state.drawer.id === id)) { state.account = null; state.report = null; state.small = null; state.receiptForm = null; }
      const dr = $('#crm-drawer');
      const name = lead ? lead.name : pat.name;
      const subject = lead ? { leadId: lead.id } : { patientId: pat.id };
      const kv = lead ? [['טלפון', lead.phone], ['בית', houseName(lead.house)], ['מקור', lead.source], ['אחראי', lead.assignedTo], ['שלב', stageLabel(lead.stage)], ['פגישה', fmtDate(lead.visitDate) + (lead.visitTime ? ' ' + lead.visitTime : '')], ['נוצר', fmtDate(lead.created)], ['נפגש/ת עם', lead.meetingWith], ['תוצאת פגישה', meetingOutcomeLabel(lead.meetingOutcome)], ['איש קשר', lead.contactName + (lead.contactRelation ? ' (' + lead.contactRelation + ')' : '')], ['טלפון איש קשר', lead.contactPhone], ['הערות', lead.note]]
        : [['בית', houseName(pat.houseId)], ['תאריך כניסה', fmtDate(pat.date) + (pat.date && !s(pat.exitDate) ? ' · ' + daysBetween(pat.date, state.today) + ' ימים בבית' : '')], ['תאריך יציאה', s(pat.exitDate) ? fmtDate(pat.exitDate) + (pat.date ? ' · ' + daysBetween(pat.date, pat.exitDate) + ' ימים בבית' : '') : ''], ['סטטוס', patientStatusLabel(pat.status)], ['הגיע/ה', pat.source === 'lead' ? 'מליד' : pat.source === 'direct_admin' ? 'הוספה ישירה' : pat.source], ['ליד מקורי', pat.fromLead ? ((compute(state.data, state.today).leads.filter(function (l) { return l.id === pat.fromLead; })[0] || {}).name || 'נסגרה / הועברה') : '']];
      const na = lead ? nextActionFor(lead, state.today, flagsOf(state.index, lead.id)) : null;
      dr.innerHTML = '<div class="drawer-head"><div><h2>' + esc(name) + '</h2><div class="meta tags">' + (lead ? '<span class="chip stage-' + esc(lead.stage) + '">' + esc(stageLabel(lead.stage)) + '</span>' + houseTag(lead.house) + (lead.assignedTo ? avatar(lead.assignedTo) : '') : statusChip(pat.status) + houseTag(pat.houseId)) + (na ? chip(na.state, na.text) : '') + (lead && waitChipText(lead, flagsOf(state.index, lead.id)) && waitChipText(lead, flagsOf(state.index, lead.id)) !== na.text ? chip('wait', waitChipText(lead, flagsOf(state.index, lead.id))) : '') + '</div></div>'
        + '<span class="toolbar"><button type="button" class="btn small primary" data-contact-open="' + esc(kind + ':' + id) + '">📞 תיעוד שיחה</button><button type="button" class="btn small" id="crm-drawer-close" aria-label="סגירה">✕</button></span></div>'
        + '<div class="tabs" role="tablist">' + [['overview', 'סקירה'], ['tasks', 'משימות' + (tasksFor(subject, state.tasks).length ? ' (' + tasksFor(subject, state.tasks).length + ')' : '')], ['activity', 'פעילות'], ['meetings', 'פגישות ושירותים'], ['account', 'חשבון'], ['docs', 'מסמכים']].filter(function (t) { return t[0] !== 'account' || accountTabVisible(state.me); }).map(function (t, i) { return '<button type="button" role="tab" data-tab="' + t[0] + '" aria-selected="' + (i === 0) + '">' + esc(t[1]) + '</button>'; }).join('') + '</div>'
        + '<section data-pane="overview">' + (lead ? renderLeadActions(lead) : renderPatientActions(pat))
        + (lead && c.outpatientSent && c.outpatientSent[lead.id] ? outpatientStatusButton(lead.id, 'lead') : '') + '<dl class="kv">' + kv.filter(function (x) { return s(x[1]); }).map(function (x) { return '<dt>' + esc(x[0]) + '</dt><dd>' + esc(x[1]) + '</dd>'; }).join('') + '</dl><p><a class="btn" href="/?view=classic">עריכה מלאה בדשבורד</a></p></section>'
        + '<section data-pane="tasks" hidden id="crm-tasks">' + renderTasksPane(subject) + '</section>'
        + '<section data-pane="activity" hidden><ul class="tl" id="crm-tl"><li>טוען…</li></ul></section>'
        + '<section data-pane="meetings" hidden id="crm-meetings">' + renderMeetings(meetingsFor(lead || pat, lead ? 'lead' : 'patient', compute(state.data, state.today))) + '</section>'
        + (accountTabVisible(state.me) ? '<section data-pane="account" hidden id="crm-account">' + (pat && state.me && state.me.finance ? '<p class="na">טוען נתוני חשבון…</p>' : '<p class="na">' + (lead ? 'החשבון נפתח עם הקליטה לבית.' : 'אין הרשאה לנתוני גבייה.') + '</p>') + '</section>' : '')
        + '<section data-pane="docs" hidden><p class="na">מסמכים — חשבשבת נשארת המקור; עדיין לא מחובר.</p></section>';
      let prevTab = keepTab && state.drawer && state.drawer.tab ? state.drawer.tab : 'overview';
      if (prevTab === 'account' && !accountTabVisible(state.me)) prevTab = 'overview';
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
      html += '<div class="group-title">זיכויים' + (me.approver ? ' <button type="button" class="btn small" data-credit-new>+ זיכוי ידני</button>' : '') + '</div>';
      const credits = state.billing ? patientCredits(state.account ? state.account.patient : a.patientId, state.billing.credits) : [];
      if (!credits.length) html += '<p class="na">אין זיכויים.</p>';
      else html += '<div class="tbl-wrap"><table class="tbl" id="crm-account-credits"><thead><tr><th>סוג</th><th>חודש</th><th>סכום</th><th>סטטוס</th><th></th></tr></thead><tbody>'
        + credits.map(function (c) {
          const st = c.status === 'paid' ? 'ok' : c.status === 'cancelled' ? 'wait' : 'today';
          return '<tr><td>' + esc(CREDIT_TYPE_LABELS[c.creditType] || c.creditType) + (c.reason ? ' <span class="na">' + esc(c.reason) + '</span>' : '') + '</td><td>' + esc(c.allocationMonth) + '</td><td>' + esc(fmtMoney(c.amount)) + '</td><td>' + chip(st, (CREDIT_STATUS_LABELS[c.status] || c.status) + (c.paidDate ? ' ' + fmtDate(c.paidDate) : '')) + '</td>'
            + '<td>' + (c.status === 'pending' && c.amount > 0 ? '<span class="na">' + esc(refundStageText(c)) + '</span> ' + refundActionButton(c, me) : '')
            + (me.finance && c.status !== 'paid' ? ' <button type="button" class="btn small" data-credit-edit="' + esc(c.id) + '">עריכה</button>' : '') + '</td></tr>';
        }).join('') + '</tbody></table></div>';
      html += '<div id="crm-refund-form-account"></div>';
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
      html += '<p class="na">כל הפעולות על החשבון זמינות כאן. <a href="/?view=classic">הדשבורד הרגיל</a> נשאר לגיבוי.</p>';
      return html;
    }
    /* C10: the «דווח תשלום» form inside the account pane. */
    function openReportForm(cycle, remaining, discountCtx) {
      const el = $('#crm-report');
      if (!el || !state.account) return;
      const R = reportRules(win);
      const today = state.today;
      const d = reportDefaults(cycle, remaining, today, state.account.data.currentFunder);
      // «שולם עם הנחה» (CHANGELOG-paid-with-discount.md): an OPEN cycle, a user who may give a discount.
      const canPwd = !!(state.me && state.me.canDiscount && discountCtx && monthOk(discountCtx.month) && Number(remaining) > 0);
      state.report = { cycle: cycle, submissionId: newSubmissionId(), values: d, remaining: Number(remaining) || 0, discountCtx: canPwd ? { month: s(discountCtx.month), discount: Number(discountCtx.discount) || 0 } : null };
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
        + (canPwd ? '<label class="wide check"><input type="checkbox" name="withDiscount" value="yes" data-pwd-toggle> שולם עם הנחה — ההפרש בין היתרה לסכום שהתקבל יירשם כהנחה</label>'
          + '<div class="wide" data-pwd-box hidden><label>סיבת ההנחה *<input type="text" name="discountReason" maxlength="120" value="">' + err('discountReason') + '</label>'
          + '<p class="na" data-pwd-preview></p></div>' : '')
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
      const all = {};
      Array.prototype.forEach.call(f.elements, function (el) { if (el.name && el.type !== 'checkbox') all[el.name] = el.value; });
      const withDiscount = !!(state.report.discountCtx && f.elements.withDiscount && f.elements.withDiscount.checked);
      const vals = reportValuesOnly(all);
      state.report.values = vals;
      const issues = reportIssues(vals, state.today, !!(state.me && state.me.approver), reportRules(win));
      // «שולם עם הנחה»: the plan is checked BEFORE anything is written.
      const plan = withDiscount ? paidWithDiscountPlan(vals.amount, state.report.remaining, state.report.discountCtx, all.discountReason) : null;
      if (plan && !plan.ok) Object.keys(plan.errors).forEach(function (k) { issues.push({ field: k, hebrewMessage: plan.errors[k] }); });
      if (issues.length) { showReportIssues(f, issues); return Promise.resolve(false); }
      showReportIssues(f, []);
      const discountReason = s(all.discountReason);
      const body = reportBody(state.report.cycle, vals, state.report.submissionId, confirmDuplicate);
      const st = $('#crm-report-state'); if (st) st.textContent = 'שומר…';
      state.saving = true; markBusy();
      return win.fetch('/api/sheets', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
        .then(function (r) { return r.json().catch(function () { return { ok: false, error: 'bad_json' }; }); })
        .then(function (res) {
          state.saving = false; clearBusy();
          const out = reportOutcome(res);
          if (out.ok) {
            state.report = null;
            // re-read both answers: the money a row shows is always the server's
            const pid = state.drawer && state.drawer.id;
            const done = function (msg, bad) { toast(msg, bad); resetBilling(); if (pid) fillAccountPane(pid); return true; };
            if (!plan) return done('התשלום נשמר ✓');
            // The payment is saved; now the discount for the gap (the payment first —
            // a discount without its payment would hide money that never arrived).
            const pat = state.account && state.account.patient;
            if (!pat) return done('התשלום נשמר. ההנחה לא נשמרה — לחצי «הנחה» במחזור', true);
            if (st) st.textContent = 'שומר הנחה…';
            state.saving = true; markBusy();
            return win.fetch('/api/sheets', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(paidWithDiscountBody(pat, plan, discountReason)) })
              .then(function (r) { return r.json().catch(function () { return { ok: false, error: 'bad_json' }; }); })
              .then(function (dres) {
                state.saving = false; clearBusy();
                const why = writeRefusal(dres, '');
                return why ? done('התשלום נשמר. ההנחה לא נשמרה (' + why + ') — לחצי «הנחה» במחזור', true)
                  : done('התשלום נשמר ✓ · הנחה ' + fmtMoney(plan.gap) + ' נשמרה ✓');
              })
              .catch(function () { state.saving = false; clearBusy(); return done('התשלום נשמר. ההנחה לא נשמרה — לחצי «הנחה» במחזור', true); });
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
        .catch(function (e) { state.saving = false; clearBusy(); if (st) st.textContent = ''; showReportIssues(f, [], 'התשלום לא נשמר — נסי שוב'); toast(String(e && e.message || e), true); return false; });
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
      state.saving = true; markBusy();
      return win.fetch('/api/sheets', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
        .then(function (r) { return r.json().catch(function () { return { ok: false, error: 'bad_json' }; }); })
        .then(function (res) {
          state.saving = false; clearBusy();
          const why = writeRefusal(res, proof);
          if (why) { showReportIssues(f, [], why); if (st) st.textContent = ''; toast(why, true); return false; }
          toast(label + ' נשמר ✓'); state.small = null;
          const pid = state.drawer && state.drawer.id; resetBilling(); if (pid) fillAccountPane(pid);
          return true;
        })
        .catch(function (e) { state.saving = false; clearBusy(); if (st) st.textContent = ''; showReportIssues(f, [], 'השינוי לא נשמר — נסי שוב'); toast(String(e && e.message || e), true); return false; });
    }
    /* Credit edit / manual credit (CHANGELOG-crm-manual-credits.md) — the #crm-refund-form-account slot. */
    function openCreditForm(kind, id) {
      const el = $('#crm-drawer[aria-hidden="false"] #crm-refund-form-account');
      if (!el || !state.billing) return;
      const me = state.me || {};
      const err = function (n) { return '<span class="err" data-err="' + n + '"></span>'; };
      let html;
      if (kind === 'new') {
        if (!me.approver) return toast('זיכוי ידני — באישור סנדרה בלבד', true);
        state.creditForm = { kind: 'new' };
        html = '<h3>זיכוי ידני (אחר)</h3>'
          + '<label>חודש *<input type="month" name="allocationMonth" value="' + esc(s(state.today).slice(0, 7)) + '">' + err('allocationMonth') + '</label>'
          + '<label>סכום (₪, כולל מע״מ) *<input type="text" inputmode="decimal" name="amount">' + err('amount') + '</label>'
          + '<label class="wide">סיבה *<input type="text" name="reason" maxlength="300">' + err('reason') + '</label>'
          + '<label class="wide">הערות<input type="text" name="notes" maxlength="500"></label>';
      } else {
        const raw = creditRaw(state.billing.credits, id);
        if (!raw) return toast('הזיכוי לא נמצא — רענני', true);
        if (s(raw.status) === 'paid') return toast('זיכוי ששולם נעול לעריכה', true);
        state.creditForm = { kind: 'edit', id: s(raw.id) };
        const statuses = [['pending', 'ממתין']].concat(me.deleter || s(raw.status) === 'cancelled' ? [['cancelled', 'בוטל']] : []);
        html = '<h3>עריכת זיכוי · ' + esc(CREDIT_TYPE_LABELS[s(raw.creditType)] || raw.creditType) + ' ' + esc(s(raw.allocationMonth).slice(0, 7)) + '</h3>'
          + '<p class="na">מחושב לפי המדיניות: ' + esc(fmtMoney(raw.calculatedAmount)) + (me.approver ? '' : ' · שינוי סכום — באישור סנדרה בלבד') + '</p>'
          + '<label>סכום (₪, כולל מע״מ) *<input type="text" inputmode="decimal" name="amount" value="' + esc(Number(raw.amount) || 0) + '"' + (me.approver ? '' : ' readonly') + '>' + err('amount') + '</label>'
          + '<label>נימוק לשינוי הסכום<input type="text" name="overrideReason" maxlength="300" value="' + esc(raw.overrideReason) + '">' + err('overrideReason') + '</label>'
          + '<label>תאריך החלטה<input type="date" name="decidedDate" value="' + esc(sheetDay(raw.decidedDate)) + '">' + err('decidedDate') + '</label>'
          + '<label>סטטוס<select name="status">' + statuses.map(function (x) { return '<option value="' + x[0] + '"' + (s(raw.status) === x[0] ? ' selected' : '') + '>' + x[1] + '</option>'; }).join('') + '</select>' + err('status') + '</label>'
          + '<label class="wide">הערות<input type="text" name="notes" maxlength="500" value="' + esc(raw.notes) + '">' + err('notes') + '</label>';
      }
      el.innerHTML = '<form class="new-lead report" data-form="credit-' + kind + '" novalidate>' + html + '<div class="wide err" data-err="_form"></div>'
        + '<div class="wide toolbar"><button type="submit" class="btn primary">שמירה</button><button type="button" class="btn" data-credit-cancel>ביטול</button><span class="na" id="crm-credit-state"></span></div></form>';
      el.scrollIntoView({ block: 'nearest' });
    }
    function submitCredit(f) {
      if (!state.creditForm || !state.account || state.saving) return Promise.resolve(false);
      const vals = {}; Array.prototype.forEach.call(f.elements, function (el) { if (el.name) vals[el.name] = el.value; });
      const cf = state.creditForm;
      let errs, body, wantId = '';
      if (cf.kind === 'new') { errs = creditNewErrors(vals); body = creditNewBody(state.account.patient, vals, state.today); }
      else {
        const raw = creditRaw(state.billing && state.billing.credits, cf.id);
        if (!raw) { toast('הזיכוי לא נמצא — רענני', true); return Promise.resolve(false); }
        errs = creditEditErrors(raw, vals); body = creditEditBody(raw, vals); wantId = cf.id;
      }
      const issues = Object.keys(errs).map(function (k) { return { field: k, hebrewMessage: errs[k] }; });
      showReportIssues(f, issues, issues.length ? (errs._form || 'יש לתקן את השדות המסומנים') : '');
      if (issues.length) return Promise.resolve(false);
      const st = $('#crm-credit-state'); if (st) st.textContent = 'שומר…';
      state.saving = true; markBusy();
      return win.fetch('/api/sheets', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
        .then(function (r) { return r.json().catch(function () { return { ok: false, error: 'bad_json' }; }); })
        .then(function (res) {
          state.saving = false; clearBusy();
          const why = creditSaveRefusal(res, wantId);
          if (why) { showReportIssues(f, [], why); if (st) st.textContent = ''; toast(why, true); return false; }
          toast('הזיכוי נשמר ✓'); state.creditForm = null;
          const pid = state.drawer && state.drawer.id; resetBilling(); if (pid) fillAccountPane(pid);
          return true;
        })
        .catch(function (e) { state.saving = false; clearBusy(); if (st) st.textContent = ''; showReportIssues(f, [], 'הזיכוי לא נשמר — נסי שוב'); toast(String(e && e.message || e), true); return false; });
    }
    /* C11: use the same Credits authority as the classic dashboard; never
     * allow Vered/Sandra to settle or Ortal to approve by a stale CRM button. */
    function openRefundAction(kind, id) {
      const list = state.billing && state.billing.credits;
      const c = creditsOf(list).filter(function (r) { return r.id === id; })[0];
      if (!c || refundActionFor(c, state.me) !== kind) {
        return toast('הפעולה אינה זמינה — יש לרענן את נתוני ההחזר וההרשאות', true);
      }
      const el = $('#crm-drawer[aria-hidden="false"] #crm-refund-form-account') || $('#crm-refund-form');
      if (!el) return toast('נא לפתוח את מסך הגבייה ולנסות שוב', true);
      state.refundAction = { kind: kind, creditId: c.id, amount: c.amount };
      const err = function (name) { return '<span class="err" data-err="' + name + '"></span>'; };
      let html = '<h3>' + esc(REFUND_ACTION_LABELS[kind]) + ' · ' + esc(c.patientName) + '</h3>'
        + '<p class="na">סכום ההחזר המחושב: ' + esc(fmtMoney(c.amount)) + ' · ' + esc(refundStageText(c)) + '</p>';
      if (kind === 'settle') {
        html += '<label>תאריך ביצוע התשלום *<input type="date" name="paidDate" max="' + esc(state.today) +
          '" value="' + esc(state.today) + '">' + err('paidDate') + '</label>'
          + '<label>אמצעי תשלום *<select name="method"><option value="">בחרי…</option>' +
          SETTLE_METHODS.map(function (m) { return '<option value="' + esc(m) + '">' + esc(m) + '</option>'; }).join('') +
          '</select>' + err('method') + '</label>';
      } else {
        html += '<p class="na">האישור מתייחס לסכום זה בלבד. שינוי בסכום מחייב בקשה ואישור מחדש.</p>';
      }
      el.innerHTML = '<form class="new-lead report" data-form="refund-action" novalidate>' + html +
        '<div class="wide err" data-err="_form"></div><div class="wide toolbar">' +
        '<button type="submit" class="btn primary">' + esc(REFUND_ACTION_LABELS[kind]) + '</button>' +
        '<button type="button" class="btn" data-refund-cancel>ביטול</button><span class="na" id="crm-refund-state"></span></div></form>';
      el.scrollIntoView({ block: 'nearest' });
    }
    function submitRefundAction(form) {
      const task = state.refundAction;
      if (!task || state.saving) return Promise.resolve(false);
      const current = creditsOf(state.billing && state.billing.credits).filter(function (r) { return r.id === task.creditId; })[0];
      if (!current || current.amount !== task.amount || refundActionFor(current, state.me) !== task.kind) {
        showReportIssues(form, [], 'ההחזר השתנה — יש לטעון אותו מחדש'); return Promise.resolve(false);
      }
      const values = {};
      Array.prototype.forEach.call(form.elements, function (el) { if (el.name) values[el.name] = el.value; });
      const issues = task.kind === 'settle' ? settleErrors(values, state.today) : {};
      showReportIssues(form, Object.keys(issues).map(function (k) { return { field: k, hebrewMessage: issues[k] }; }), '');
      if (Object.keys(issues).length) return Promise.resolve(false);
      const body = task.kind === 'request'
        ? { action: 'requestRefundPayoutApproval', creditId: task.creditId }
        : task.kind === 'approve' ? { action: 'approveRefundPayout', creditId: task.creditId }
        : settleBody(task.creditId, values.paidDate, values.method);
      state.saving = true; markBusy();
      return win.fetch('/api/sheets', { method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
        .then(function (r) { return r.json().catch(function () { return { ok: false, error: 'bad_json' }; }); })
        .then(function (res) {
          state.saving = false; clearBusy();
          if (!res || res.ok !== true || !res.credit || s(res.credit.id) !== task.creditId) {
            const why = writeRefusal(res, 'credit') || 'לא התקבל אישור שמירה מזהה מהשרת';
            showReportIssues(form, [], why); toast(why, true); return false;
          }
          state.refundAction = null;
          toast((task.kind === 'request' ? 'בקשת האישור' : task.kind === 'approve' ? 'האישור לסכום ההחזר' : 'תשלום ההחזר') + ' נשמר ✓');
          const pid = state.drawer && state.drawer.id;
          resetBilling();
          if (pid && state.account) fillAccountPane(pid);
          if (state.area === 'billing') { renderMain(); loadBilling(); }
          else loadBilling(function () { if (pid && state.account) fillAccountPane(pid); });
          return true;
        })
        .catch(function (err) {
          state.saving = false; clearBusy(); const why = 'הפעולה לא נשמרה — ' + s(err && err.message || err);
          showReportIssues(form, [], why); toast(why, true); return false;
        });
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
      state.saving = true; markBusy();
      return win.fetch('/api/sheets', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
        .then(function (res) { return res.json().catch(function () { return { ok: false, error: 'bad_json' }; }); })
        .then(function (res) {
          state.saving = false; clearBusy();
          if (!accepted(res)) {
            const out = res && res.error === 'invalid_report' ? reportOutcome(res) : { message: writeRefusal(res, res && res.ok === true ? 'receipt' : ''), issues: [] };
            showReportIssues(f, out.issues || [], out.message || 'השינוי לא נשמר'); if (st) st.textContent = ''; toast(out.message || 'השינוי לא נשמר', true); return false;
          }
          toast(label + ' ✓'); state.receiptForm = null;
          const pid = state.drawer && state.drawer.id; resetBilling(); if (pid) fillAccountPane(pid);
          return true;
        })
        .catch(function (e) { state.saving = false; clearBusy(); if (st) st.textContent = ''; showReportIssues(f, [], 'השינוי לא נשמר — נסי שוב'); toast(String(e && e.message || e), true); return false; });
    }
    /* «לעדכן המשך טיפול»: one discharged row, one field (setDischargeContinuity — Code.gs validates the key and the row again under its lock). */
    function saveContinuity(dischargeId) {
      const sel = doc.querySelector('#crm-drawer [data-continuity-for="' + (win.CSS && win.CSS.escape ? win.CSS.escape(dischargeId) : dischargeId) + '"]');
      const v = s(sel && sel.value);
      if (!continuityKnown(v)) { toast('בחרי המשך טיפול', true); return; }
      if (state.saving) return;
      state.saving = true; markBusy();
      return win.fetch('/api/sheets', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(continuityBody(dischargeId, v)) })
        .then(function (r) { return r.json().catch(function () { return { ok: false, error: 'bad_json' }; }); })
        .then(function (res) {
          state.saving = false; clearBusy();
          if (!res || res.ok !== true) { toast((res && (res.hebrewMessage || res.message)) || 'המשך הטיפול לא נשמר — נסי שוב', true); return; }
          (state.data && Array.isArray(state.data.dischargedPatients) ? state.data.dischargedPatients : []).forEach(function (r) { if (s(r.id) === dischargeId) r.continuity = v; });
          toast('המשך הטיפול נשמר ✓');
          renderNav(); renderMain();
          if (state.drawer) openDrawer(state.drawer.kind, state.drawer.id, true);
        })
        .catch(function (e) { state.saving = false; clearBusy(); toast(String(e && e.message || e) || 'המשך הטיפול לא נשמר', true); });
    }
    /* C14: the «פגישות ושירותים» pane. */
    function renderMeetings(m) {
      let html = '';
      html += '<div class="group-title">פגישת קבלה</div>';
      if (!m.visit) html += '<p class="na">אין פגישה רשומה.</p>';
      else html += '<dl class="kv"><dt>תאריך</dt><dd>' + esc(fmtDate(m.visit.date) || '—') + (m.visit.time ? ' ' + esc(m.visit.time) : '') + '</dd><dt>נפגש/ת עם</dt><dd>' + esc(m.visit.withWhom || '—') + '</dd><dt>תוצאה (ורד)</dt><dd>' + esc(m.visit.outcome ? meetingOutcomeLabel(m.visit.outcome) : 'ללא תוצאה') + '</dd></dl>';
      if (m.lead) {
        const ch = patientMeetingChange(m.lead, flagsOf(state.index, m.lead.id));
        if (ch) html += '<p class="notice warn patient-change">' + esc(ch.change === 'cancelled' ? 'הפגישה בוטלה ע״י המטופל/ת' : 'מועד הפגישה שונה ע״י המטופל/ת (היה ' + fmtDate(ch.prevDate) + (ch.prevTime ? ' ' + ch.prevTime : '') + ')')
          + ' · ' + esc(whenLocal(ch.at)) + (ch.actorName ? ' · ' + esc(ch.actorName) : '') + (ch.note ? '<br>' + esc(ch.note) : '') + '</p>'
          + '<p><a class="btn small primary" target="_blank" rel="noopener" data-wa-manager href="' + esc(managerChangeLink(m.lead)) + '">📲 הודעה למנהל/ת בוואטסאפ</a></p>';
      }
      html += '<div class="group-title">דיווח המנהל/ת' + (m.report && m.report.unseen ? ' ' + chip('today', 'חדש') : '') + '</div>';
      if (!m.report) html += '<p class="na">אין דיווח מהבית עדיין.</p>';
      else html += '<dl class="kv" data-report-lead="' + esc(m.lead ? m.lead.id : '') + '"><dt>תוצאה</dt><dd>' + esc(m.report.outcome || '—') + '</dd><dt>הגיע/ה עם</dt><dd>' + esc(m.report.companion || '—') + '</dd>'
        + (m.report.note ? '<dt>הערות</dt><dd>' + esc(m.report.note) + '</dd>' : '') + '<dt>דווח ע"י</dt><dd>' + esc(m.report.reporter || '—') + ' · ' + esc(m.report.when) + '</dd></dl>'
        + (m.lead && m.lead.meetingReportOutcome === 'no_show' && !s(m.lead.meetingOutcome)
          ? '<p class="notice warn">לפי דיווח המנהל/ת: לא הגיע / בוטל. אין אישור שהביקור התקיים. יש לברר, לתאם מחדש או לתעד החלטה. הדיווח אינו סוגר את הליד.</p>' : '');
      if (m.discharge) {
        const dch = m.discharge;
        html += '<div class="group-title">שחרור</div><dl class="kv"><dt>תאריך יציאה</dt><dd>' + esc(fmtDate(dch.exitDate) || '—') + '</dd><dt>סיבה</dt><dd>' + esc(dch.dispositionLabel || '—') + '</dd>'
          + (continuityRecorded(dch.continuity) ? '<dt>המשך טיפול</dt><dd>' + esc(continuityLabel(dch.continuity)) + '</dd>' : '') + (dch.note ? '<dt>הערה</dt><dd>' + esc(dch.note) + '</dd>' : '') + '</dl>';
        // «לעדכן המשך טיפול» (CHANGELOG-crm-today-card-open.md): the existing setDischargeContinuity action, same as the classic «חתכי מטופלים» select.
        if (!continuityRecorded(dch.continuity) && dch.id) html += '<div class="continuity-set"><label>המשך טיפול <select data-continuity-for="' + esc(dch.id) + '"><option value="">— בחרי —</option>'
          + CONTINUITY_CHOICES.map(function (c2) { return '<option value="' + esc(c2.id) + '">' + esc(c2.label) + '</option>'; }).join('') + '</select></label>'
          + '<button type="button" class="btn small primary" data-continuity-save="' + esc(dch.id) + '">שמירה</button></div>';
      }
      html += '<div class="group-title">שירותים</div><p class="na">שירותי המשך טיפול (Therapists) עדיין לא מחוברים לדשבורד.</p>';
      return html;
    }
    /* Opening the pane marks the manager's report seen — the classic rule — through the one-lead save (no other field touched). */
    function markReportSeen() {
      const el = $('#crm-meetings [data-report-lead]');
      const id = el && el.dataset.reportLead;
      if (!id || state.saving || !state.me) return;
      const l = compute(state.data, state.today).leads.filter(function (x) { return x.id === id; })[0];
      if (!l || !reportUnseen(l)) return;
      writeLead(id, { meetingSeen: '1' }, 'הדיווח סומן כנקרא');
    }
    /* ---- Stage 3: the triage round ---- */
    function renderTriage(c) {
      if (state.tasks === undefined || state.index === undefined) return '<div class="crm-state">טוען…</div>';
      if (!state.tasks || !state.index) return '<div class="crm-state">המידע אינו זמין — הרשימה נבנית מהמשימות ומהיסטוריית הקשר <button type="button" class="btn small" data-tasks-retry>נסי שוב</button></div>';
      const q = triageQueue(c, state.tasks, state.index, state.today);
      if (!state.triage) state.triage = { decided: 0, skipped: [] };
      const pending = q.filter(function (x) { return state.triage.skipped.indexOf(x.lead.id) < 0; });
      const cur = pending[0] || q[0];
      const total = q.length + state.triage.decided;
      let html = '<div class="day-head"><div class="day-date">' + esc(state.triage.decided + ' / ' + total + ' הוחלט') + '</div><div class="toolbar"><button type="button" class="btn small" data-area="leads">חזרה ל«לידים»</button></div></div>'
        + '<p class="na">ליד אחד בכל פעם — החלטה אחת בלחיצה. כל החלטה נרשמת (שיחה, משימה, שלב או סגירה) והרשימה מחושבת מחדש מהנתונים; אין דחייה גורפת.</p>';
      if (!cur) return html + '<div class="crm-state">אין רשומות שדורשות בירור 🎉</div>';
      const l = cur.lead;
      const nxt = pending[1] || null;
      const err = function (f) { return '<span class="err" data-err="' + f + '"></span>'; };
      html += '<section class="triage-card" data-triage="' + esc(l.id) + '">'
        + '<div class="drawer-head"><div><h2>' + esc(l.name) + '</h2><div class="meta">' + esc(houseName(l.house) || 'ללא בית') + ' · ' + esc(stageLabel(l.stage)) + (l.created ? ' · נוצר ' + esc(fmtDate(l.created)) + (cur.age !== null ? ' · ' + cur.age + ' ימים' : '') : '') + (l.assignedTo ? ' · אחראי/ת ' + esc(l.assignedTo) : '') + (l.source ? ' · מקור ' + esc(l.source) : '') + '</div>'
        + (l.phone ? '<div class="meta">טלפון <a href="tel:' + esc(l.phone) + '">' + esc(l.phone) + '</a>' + (l.contactName ? ' · איש קשר ' + esc(l.contactName) + (l.contactRelation ? ' (' + esc(l.contactRelation) + ')' : '') : '') + '</div>' : '') + '</div>'
        + chip('late', cur.reason) + '</div>'
        + (l.note ? '<p class="note">«' + esc(l.note) + '»</p>' : '<p class="na">אין הערה בליד.</p>')
        + '<div class="triage-options">' + TRIAGE_OPTIONS.map(function (o) { return '<button type="button" class="opt' + (state.triage.open === o.id ? ' on' : '') + '" data-triage-opt="' + o.id + '"><strong>' + esc(o.label) + '</strong><span class="sub">' + esc(o.hint) + '</span></button>'; }).join('') + '</div>'
        + '<div class="triage-form" id="crm-triage-form">';
      const op = state.triage.open;
      if (op === 'later') html += '<form data-form="triage-later" data-lead="' + esc(l.id) + '" novalidate class="inline"><label>תאריך *<input type="date" name="dueDate" min="' + esc(state.today) + '">' + err('dueDate') + '</label><label>שעה <input type="time" name="dueTime">' + err('dueTime') + '</label><label>אחראי <select name="assignee">' + opts(ASSIGNEES, l.assignedTo || (state.me && state.me.user), true) + '</select></label><label class="wide">למה <input type="text" name="reason" maxlength="300"></label><div class="err" data-err="_form"></div><button type="submit" class="btn small primary">קביעת שיחה</button></form>';
      else if (op === 'waitlist') html += '<form data-form="triage-waitlist" data-lead="' + esc(l.id) + '" novalidate class="inline"><label>בית *<select name="house">' + HOUSES.filter(function (h) { return !h.closed; }).map(function (h) { return '<option value="' + h.id + '"' + (houseName(l.house) === h.name ? ' selected' : '') + '>' + esc(h.name) + '</option>'; }).join('') + '</select>' + err('house') + '</label><label>אחראי *<select name="assignee">' + opts(ASSIGNEES, l.assignedTo || (state.me && state.me.user), true) + '</select>' + err('assignee') + '</label><label>תאריך בדיקה *<input type="date" name="checkDate" min="' + esc(state.today) + '">' + err('checkDate') + '</label><label class="wide">סיבה *<input type="text" name="reason" maxlength="300">' + err('reason') + '</label><div class="err" data-err="_form"></div><button type="submit" class="btn small primary">לרשימת ההמתנה</button></form>';
      else if (op === 'close') html += '<form data-form="triage-close" data-lead="' + esc(l.id) + '" novalidate class="inline"><label class="wide">סיבה *<input type="text" name="reason" maxlength="500">' + err('reason') + '</label><div class="err" data-err="_form"></div><button type="submit" class="btn small">סגירה — לא רלוונטי</button></form>';
      else if (op === 'check') html += '<form data-form="triage-check" data-lead="' + esc(l.id) + '" novalidate class="inline"><label>מה לבדוק *<input type="text" name="title" maxlength="120">' + err('title') + '</label><label>עד תאריך <input type="date" name="dueDate" min="' + esc(state.today) + '">' + err('dueDate') + '</label><label>אחראי <select name="assignee">' + opts(ASSIGNEES, state.me && state.me.user, true) + '</select></label><div class="err" data-err="_form"></div><button type="submit" class="btn small primary">סימון לבדיקה</button></form>';
      html += '</div><div class="toolbar"><button type="button" class="btn small" data-triage-skip="' + esc(l.id) + '">דלג</button><span class="na">' + (nxt ? 'הבאה: ' + esc(nxt.lead.name) + ' · ' + esc(houseName(nxt.lead.house) || '—') + (nxt.age !== null ? ' · ' + nxt.age + ' ימים' : '') : 'זו האחרונה') + '</span></div></section>';
      return html;
    }
    function triageDecided() { if (state.triage) { state.triage.decided++; state.triage.open = ''; } }
    /* A triage decision that is a task: POST, then the lists re-read (the record leaves the queue because it now has a task). */
    function triageTask(f, body, errs) {
      return postTask(f, body, errs, '', 'נרשם').then(function (ok) { if (ok) { triageDecided(); renderMain(); } return ok; });
    }
    function triageWaitlist(f, id, vals) {
      const errs = waitlistErrors(vals, state.today);
      const issues = Object.keys(errs).map(function (k) { return { field: k, hebrewMessage: errs[k] }; });
      showReportIssues(f, issues, issues.length ? 'יש לתקן את השדות המסומנים' : '');
      if (issues.length) return Promise.resolve(false);
      const l = compute(state.data, state.today).leads.filter(function (x) { return x.id === id; })[0];
      if (!l) return Promise.resolve(false);
      return writeLead(id, waitlistPatch(l, vals, state.today), 'רשימת ההמתנה').then(function (ok) {
        if (!ok) return false;
        // the check date = a review task (one record, in «היום שלי» on its day)
        return postTask(f, taskCreateBody({ leadId: id }, { kind: 'review', title: 'לבדוק מקום פנוי — ' + houseName(vals.house), reason: s(vals.reason), assignee: s(vals.assignee), dueDate: s(vals.checkDate) }, newSubmissionId()), {}, '', 'תאריך הבדיקה נרשם')
          .then(function (ok2) { triageDecided(); renderMain(); return ok2; });
      });
    }
    function closeDrawer() { $('#crm-drawer').setAttribute('aria-hidden', 'true'); $('#crm-scrim').removeAttribute('data-open'); state.drawer = null; state.account = null; state.report = null; state.small = null; state.contact = null; }

    /* ---- Stage 1c: tasks + the contact log ---- */
    function applyTasks(r) {
      if (r && r.ok === true && Array.isArray(r.tasks)) { state.tasks = r.tasks; state.tasksError = ''; }
      else { state.tasks = null; state.tasksError = (r && r.error) || 'network'; }
    }
    function reloadTasks() {
      if (!state.me || state.me.view === 'controller') return Promise.resolve();
      state.doneTasks = undefined;
      return Promise.all([api('getTasks', { status: 'open' }).then(applyTasks, function () { applyTasks(null); }), api('contactIndex').then(function (r) { state.index = r && r.ok === true ? r : state.index; }, function () {})]).then(function () {
        renderNav(); renderMain();
        if (state.drawer && !state.contact) openDrawer(state.drawer.kind, state.drawer.id, true);
      });
    }
    function taskRowHtml(r, inCard) {
      const t = r.task;
      const isCall = s(t.kind) === 'call' || s(t.kind) === 'collection';
      return '<div class="row task" data-task="' + esc(t.id) + '">'
        + (inCard ? '<span><span class="name">' + esc(t.title) + '</span><br><span class="sub">' + esc(r.kind) + (t.source === 'contact' ? ' · נקבע בשיחה' : '') + '</span></span>'
          : '<span><button type="button" class="link name" data-open-' + esc(r.subject.kind) + '="' + esc(r.subject.id) + '">' + esc(r.subject.name) + '</button><br><span class="sub">' + esc(r.subject.house) + (r.subject.contact ? ' · ' + esc(r.subject.contact) : '') + '</span></span>')
        + '<span>' + (inCard ? esc(t.reason || '—') : esc(t.title) + (t.reason ? '<br><span class="sub">' + esc(t.reason) + '</span>' : '')) + '</span>'
        + '<span>' + esc(t.assignee || '—') + '</span><span>' + esc(r.when) + '</span>'
        + '<span>' + chip(r.state === 'undated' ? 'wait' : r.state, r.state === 'undated' ? 'ללא תאריך' : stateText(r.state)) + '</span>'
        + '<span class="toolbar">' + (isCall ? '<button type="button" class="btn small primary" data-contact-open="' + esc(r.subject.kind + ':' + r.subject.id) + '" data-task-id="' + esc(t.id) + '">תיעוד שיחה</button>' : '<button type="button" class="btn small primary" data-task-done="' + esc(t.id) + '">סיום</button>')
        + '<button type="button" class="btn small" data-task-resched="' + esc(t.id) + '">שינוי מועד</button>'
        + (inCard ? '<button type="button" class="btn small" data-task-more="' + esc(t.id) + '">עוד…</button>' : '') + '</span></div>'
        + '<div class="task-form" data-task-form="' + esc(t.id) + '"></div>';
    }
    function renderTasksPane(subject) {
      const c = compute(state.data, state.today);
      const rows = state.tasks ? taskQueue(tasksFor(subject, state.tasks), c, state.today) : [];
      let html = state.tasks ? (rows.length ? '<div class="rows">' + rows.map(function (r) { return taskRowHtml(r, true); }).join('') + '</div>' : '<p class="na">אין משימות פתוחות.</p>')
        : (state.tasks === undefined ? '<p class="na">טוען…</p>' : '<p class="na">המידע אינו זמין <button type="button" class="btn small" data-tasks-retry>נסי שוב</button></p>');
      const err = function (f) { return '<span class="err" data-err="' + f + '"></span>'; };
      html += '<details class="act"><summary>משימה חדשה</summary><form data-form="task-new" novalidate>'
        + '<label>סוג <select name="kind">' + TASK_KINDS.filter(function (k) { return !k.money || (state.me && state.me.finance); }).map(function (k) { return '<option value="' + k.id + '">' + esc(k.label) + '</option>'; }).join('') + '</select>' + err('kind') + '</label>'
        + '<label>מה לעשות *<input type="text" name="title" maxlength="120">' + err('title') + '</label>'
        + '<label>אחראי <select name="assignee">' + opts(ASSIGNEES, state.me && state.me.user, true) + '</select></label>'
        + '<label>תאריך *<input type="date" name="dueDate" min="' + esc(state.today) + '" value="' + esc(state.today) + '">' + err('dueDate') + '</label><label>שעה *<input type="time" name="dueTime">' + err('dueTime') + '</label>'
        + '<p class="na wide">התרעה תוצג ' + TASK_REMIND_MINUTES + ' דקות לפני המועד, והמשימה תופיע ב«היום שלי» ביום שלה.</p>'
        + '<div class="err" data-err="_form"></div><button type="submit" class="btn small primary">יצירת משימה</button></form></details>';
      return html;
    }
    function taskById(id) { return (state.tasks || []).filter(function (t) { return t && t.id === id; })[0] || null; }
    function openTaskForm(id, kind, from) {
      // the same task may be drawn in the queue AND in the card: the form opens next to the button that was clicked
      const row = from && from.closest ? from.closest('.row.task') : null;
      const el = row && row.nextElementSibling && row.nextElementSibling.dataset.taskForm === id ? row.nextElementSibling : doc.querySelector('[data-task-form="' + id + '"]');
      const t = taskById(id);
      if (!el || !t) return;
      const err = function (f) { return '<span class="err" data-err="' + f + '"></span>'; };
      if (kind === 'resched') {
        el.innerHTML = '<form data-form="task-resched" data-task="' + esc(id) + '" novalidate class="inline">'
          + '<label>תאריך <input type="date" name="dueDate" value="' + esc(s(t.dueDate)) + '">' + err('dueDate') + '</label><label>שעה <input type="time" name="dueTime" value="' + esc(s(t.dueTime)) + '">' + err('dueTime') + '</label>'
          + '<label class="wide">סיבה' + (t.source === 'contact' ? ' * (מועד שהובטח למשפחה)' : '') + ' <input type="text" name="reason" maxlength="300">' + err('reason') + '</label>'
          + '<div class="err" data-err="_form"></div><button type="submit" class="btn small primary">שמירת המועד</button> <button type="button" class="btn small" data-task-cancel-form="' + esc(id) + '">ביטול</button></form>';
      } else if (kind === 'done') {
        el.innerHTML = '<form data-form="task-done" data-task="' + esc(id) + '" novalidate class="inline"><label class="wide">מה נעשה <input type="text" name="outcome" maxlength="300"></label>'
          + '<div class="err" data-err="_form"></div><button type="submit" class="btn small primary">סימון כהושלם</button> <button type="button" class="btn small" data-task-cancel-form="' + esc(id) + '">ביטול</button></form>';
      } else {
        el.innerHTML = '<form data-form="task-reassign" data-task="' + esc(id) + '" novalidate class="inline"><label>אחראי <select name="assignee">' + opts(ASSIGNEES, t.assignee, true) + '</select></label><button type="submit" class="btn small primary">שיוך</button></form>'
          + '<form data-form="task-withdraw" data-task="' + esc(id) + '" novalidate class="inline"><label class="wide">ביטול המשימה — סיבה * <input type="text" name="reason" maxlength="300"></label>' + err('reason') + '<div class="err" data-err="_form"></div><button type="submit" class="btn small">ביטול המשימה</button> <button type="button" class="btn small" data-task-cancel-form="' + esc(id) + '">סגור</button></form>';
      }
    }
    /* One task write: client errors first, then POST; the task echo is the proof; the lists re-read from the server. */
    function postTask(f, body, errs, okId, label) {
      const issues = Object.keys(errs).map(function (k) { return { field: k, hebrewMessage: errs[k] }; });
      showReportIssues(f, issues, issues.length ? 'יש לתקן את השדות המסומנים' : '');
      if (issues.length) return Promise.resolve(false);
      state.saving = true; markBusy();
      return win.fetch('/api/sheets', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
        .then(function (r) { return r.json().catch(function () { return { ok: false, error: 'bad_json' }; }); })
        .then(function (res) {
          state.saving = false; clearBusy();
          const why = taskAccepted(res, okId);
          if (why) { showReportIssues(f, [], why); toast(why, true); return false; }
          toast(label + ' ✓');
          return reloadTasks().then(function () { return true; });
        })
        .catch(function (e) { state.saving = false; clearBusy(); showReportIssues(f, [], 'לא נשמר — נסי שוב'); toast(String(e && e.message || e), true); return false; });
    }
    /* The contact panel (spec §8): the subject, the contact person and phone, the history, the form. Rendered in the drawer; «ביטול» returns to the card. */
    function openContactPanel(kind, id, taskId) {
      const c = compute(state.data, state.today);
      const lead = kind === 'lead' ? c.leads.filter(function (l) { return l.id === id; })[0] : null;
      const pat = kind === 'patient' ? c.patients.filter(function (p) { return p.id === id; })[0] : null;
      if (!lead && !pat) { toast('לא נמצא/ה ברשימה — רענני את הדף.', true); return; }
      const subject = lead ? { leadId: lead.id } : { patientId: pat.id };
      const task = taskId ? taskById(taskId) : null;
      state.contact = { kind: kind, id: id, taskId: task ? task.id : '', sid: newSubmissionId() };
      const dr = $('#crm-drawer');
      const phone = lead ? lead.phone : '';
      const err = function (f) { return '<span class="err" data-err="' + f + '"></span>'; };
      dr.innerHTML = '<div class="drawer-head"><div><h2>תיעוד שיחה · ' + esc(lead ? lead.name : pat.name) + '</h2><div class="meta">' + esc(lead ? stageLabel(lead.stage) + ' · ' + houseName(lead.house) : 'מטופל/ת · ' + houseName(pat.houseId)) + (lead && lead.contactName ? ' · איש קשר: ' + esc(lead.contactName) + (lead.contactRelation ? ' (' + esc(lead.contactRelation) + ')' : '') : '') + '</div>'
        + (phone ? '<div class="meta">טלפון: <a href="tel:' + esc(phone) + '">' + esc(phone) + '</a> · <a href="https://wa.me/' + esc(localPhone(phone)) + '" target="_blank" rel="noopener">וואטסאפ</a> <span class="sub">(קישור חיוג אינו תיעוד)</span></div>' : '')
        + (lead && lead.contactPhone ? '<div class="meta">טלפון איש קשר: <a href="tel:' + esc(lead.contactPhone) + '">' + esc(lead.contactPhone) + '</a></div>' : '')
        + '</div><button type="button" class="btn small" data-contact-cancel aria-label="חזרה לכרטיס">✕</button></div>'
        + (task ? '<p class="na">המשימה: <strong>' + esc(task.title) + '</strong> · ' + esc(taskWhen(task)) + (task.reason ? ' · ' + esc(task.reason) : '') + '</p>' : '')
        + '<div class="group-title">היסטוריית קשר</div><ul class="tl" id="crm-tl"><li>טוען…</li></ul>'
        + '<form class="new-lead report contact" data-form="contact" novalidate>'
        + '<h3>השיחה</h3>'
        + '<label>תאריך *<input type="date" name="when" value="' + esc(state.today) + '" max="' + esc(state.today) + '">' + err('when') + '</label>'
        + '<label>שעה <input type="time" name="time">' + err('time') + '</label>'
        + '<label>מי ביצע <input type="text" name="who" value="' + esc(state.me && state.me.user) + '" readonly></label>'
        + '<label>עם מי <input type="text" name="withWhom" maxlength="80" value="' + esc(lead && lead.contactName ? lead.contactName : '') + '">' + err('withWhom') + '</label>'
        + '<label>ערוץ *<select name="channel">' + CONTACT_CHANNELS.map(function (ch) { return '<option value="' + ch.id + '"' + (ch.id === 'phone' ? ' selected' : '') + '>' + esc(ch.label) + '</option>'; }).join('') + '</select>' + err('channel') + '</label>'
        + '<label>סיבת הפנייה <input type="text" name="reason" maxlength="200" value="' + esc(task ? task.title : '') + '"></label>'
        + '<label class="wide">תוצאה *<select name="outcome"><option value="">בחרי…</option>' + CONTACT_OUTCOMES.map(function (o) { return '<option value="' + o.id + '">' + esc(o.label) + '</option>'; }).join('') + '</select>' + err('outcome') + '</label>'
        + '<label class="wide">תקציר <textarea name="summary" rows="3" maxlength="1000"></textarea>' + err('summary') + '</label>'
        + '<fieldset class="wide next"><legend>קשר הבא *</legend>'
        + NEXT_CHOICES.map(function (n) { return '<label class="radio"><input type="radio" name="next" value="' + n.id + '"> ' + esc(n.label) + '</label>'; }).join('')
        + '<div class="next-extra"><label data-next-for="days">מספר ימים <input type="number" name="nextDays" min="1" max="365"></label>'
        + '<label data-next-for="date">תאריך <input type="date" name="nextDate" min="' + esc(state.today) + '"></label><label data-next-for="date">שעה <input type="time" name="nextTime"></label>'
        + '<label data-next-for="week">יום בשבוע המבוקש <input type="date" name="nextWeek" min="' + esc(state.today) + '"></label>'
        + '<label data-next-for="none" class="wide">למה אין המשך *<input type="text" name="nextExplanation" maxlength="300"></label>'
        + '<label data-next-for="task" class="wide">כותרת המשימה <input type="text" name="nextTitle" maxlength="120" placeholder="לחזור — (ברירת מחדל לפי התוצאה)"></label>'
        + '<label data-next-for="task">אחראי <select name="nextAssignee">' + opts(ASSIGNEES, task && task.assignee ? task.assignee : (state.me && state.me.user), true) + '</select></label></div>'
        + '<p class="na" id="crm-next-preview">בחרי מועד — התאריך בפועל יוצג כאן.</p><span class="err" data-err="next"></span></fieldset>'
        + '<div class="wide err" data-err="_form"></div>'
        + '<div class="wide toolbar"><button type="submit" class="btn primary">שמירת השיחה</button><button type="button" class="btn" data-contact-cancel>ביטול</button><span class="na" id="crm-report-state"></span></div></form>';
      dr.setAttribute('aria-hidden', 'false');
      $('#crm-scrim').setAttribute('data-open', 'true');
      api('getActivity', Object.assign({ limit: 30 }, subject)).then(function (r) {
        const tl = $('#crm-tl');
        if (!tl || !state.contact) return;
        if (!r || r.ok === false) { tl.innerHTML = '<li class="na">ההיסטוריה אינה זמינה (' + esc((r && r.error) || 'שגיאה') + ')</li>'; return; }
        if (!r.events || !r.events.length) { tl.innerHTML = '<li class="na">אין מגע מתועד עדיין</li>'; return; }
        tl.innerHTML = r.events.map(function (e) { return '<li><div class="t">' + esc(fmtDate(String(e.occurredAt || '').slice(0, 10)) + ' ' + String(e.occurredAt || '').slice(11, 16)) + ' · ' + esc(e.actorName || e.source || '') + '</div><div>' + esc(e.summary || e.kind) + '</div></li>'; }).join('');
      });
    }
    function contactValues(f) { const v = {}; Array.prototype.forEach.call(f.elements, function (el) { if (!el.name) return; if (el.type === 'radio') { if (el.checked) v[el.name] = el.value; else if (!(el.name in v)) v[el.name] = v[el.name] || ''; } else v[el.name] = el.value; }); return v; }
    function refreshNextPreview(f) {
      const v = contactValues(f);
      const plan = v.next ? nextPlan(v.next, { days: v.nextDays, date: v.nextDate, time: v.nextTime, weekStart: v.nextWeek, explanation: v.nextExplanation }, state.today) : null;
      doc.querySelectorAll('#crm-drawer [data-next-for]').forEach(function (el) { const k = el.dataset.nextFor; el.hidden = !(k === v.next || (k === 'task' && v.next && v.next !== 'none')); });
      const p = $('#crm-next-preview'); if (p) p.textContent = plan ? plan.text : (v.next ? 'השלימי את הפרטים' : 'בחרי מועד — התאריך בפועל יוצג כאן.');
    }
    /* Save = ONE logContact. A failure keeps the text and allows a retry with the SAME submission id (idempotent server-side); nothing is marked done before the server confirms. */
    function submitContact(f) {
      if (!state.contact || state.saving) return Promise.resolve(false);
      const v = contactValues(f);
      const errs = contactErrors(v, state.today);
      const issues = Object.keys(errs).map(function (k) { return { field: k, hebrewMessage: errs[k] }; });
      showReportIssues(f, issues, issues.length ? 'יש לתקן את השדות המסומנים' : '');
      if (issues.length) return Promise.resolve(false);
      const subject = state.contact.kind === 'lead' ? { leadId: state.contact.id } : { patientId: state.contact.id };
      const body = contactBody(subject, v, state.contact.sid, state.contact.taskId, state.today, v.nextAssignee);
      const st = $('#crm-report-state'); if (st) st.textContent = 'שומר…';
      state.saving = true; markBusy();
      return win.fetch('/api/sheets', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
        .then(function (r) { return r.json().catch(function () { return { ok: false, error: 'bad_json' }; }); })
        .then(function (res) {
          state.saving = false; clearBusy();
          const why = contactAccepted(res);
          if (why) { showReportIssues(f, [], why); if (st) st.textContent = ''; toast(why, true); return false; }
          const back = state.contact; state.contact = null;
          toast('השיחה נשמרה ✓' + (res.created ? ' · משימת המשך ' + taskWhen(res.created) : ''));
          if (state.area === 'triage') { triageDecided(); closeDrawer(); return reloadTasks().then(function () { return true; }); }
          state.drawer = { kind: back.kind, id: back.id, tab: 'tasks' };
          return reloadTasks().then(function () { openDrawer(back.kind, back.id, true); return true; });
        })
        .catch(function (e) { state.saving = false; clearBusy(); if (st) st.textContent = ''; showReportIssues(f, [], 'השיחה לא נשמרה — הטקסט נשמר, נסי שוב'); toast(String(e && e.message || e), true); return false; });
    }

    /* events (delegated; filters, sort and scroll survive opening a card) */
    root.addEventListener('click', function (ev) {
      const cs = ev.target.closest ? ev.target.closest('[data-continuity-save]') : null;
      if (cs) return saveContinuity(cs.dataset.continuitySave);
      // The manager's WhatsApp (CHANGELOG-crm-vered-feedback-1104.md): a standalone PWA drops
      // <a target=_blank> to another origin, so open it from the click (never blocked), else navigate.
      const wa = ev.target.closest ? ev.target.closest('a[data-wa-manager]') : null;
      if (wa) { ev.preventDefault(); const w = win.open ? win.open(wa.href, '_blank', 'noopener') : null; if (!w) win.location.href = wa.href; return; }
      const t = ev.target.closest ? ev.target.closest('#crm-new-lead,#crm-direct-add,[data-cancel-drawer],[data-remove-lead],[data-restore-lead],[data-stage-next],[data-stage-prev],[data-area],[data-kpi],[data-domain],[data-triage-opt],[data-triage-skip],[data-go],[data-billing-filter],[data-day-view],[data-week-step],[data-week-today],[data-done-retry],[data-quick],[data-quick-cancel],[data-quick-pick],[data-view],[data-sort],[data-open-lead],[data-open-patient],[data-house-open],[data-tab],[data-kpi-period],#crm-drawer-close,#crm-burger,#crm-scrim,#crm-retry') : null;
      if (!t) return;
      if (t.dataset.kpiPeriod) { state.kpiPeriod = t.dataset.kpiPeriod; return renderMain(); }
      if (t.dataset.houseOpen) { ev.preventDefault(); state.filters.house = t.dataset.houseOpen; return setArea('clients'); }
      if (t.dataset.area) { state.workControl = ''; return setArea(t.dataset.area); }
      if (t.dataset.kpi) { state.kpiFilter = state.kpiFilter === t.dataset.kpi ? '' : t.dataset.kpi; return renderMain(); }
      if (t.dataset.domain !== undefined) { state.workControl = ''; state.domain = state.domain === t.dataset.domain ? '' : t.dataset.domain; return renderMain(); }
      if (t.dataset.dayView) { state.workControl = ''; state.dayView = t.dataset.dayView; state.domain = ''; return renderMain(); }
      if (t.dataset.weekStep) { state.week = addDays(weekStart(state.week || state.today), Number(t.dataset.weekStep)); return renderMain(); }
      if (t.dataset.weekToday !== undefined) { state.week = ''; return renderMain(); }
      if (t.dataset.doneRetry !== undefined) { state.doneTasks = undefined; return renderMain(); }
      if (t.dataset.quick) return renderQuick(t.dataset.quick);
      if (t.dataset.go) {
        let g = {}; try { g = JSON.parse(t.dataset.go); } catch (_) { g = {}; }
        if (g.view) state.view = g.view;
        state.workControl = WORK_CONTROL.some(function (q) { return q.id === g.workControl; }) ? g.workControl : '';
        state.domain = g.domain || ''; state.dayView = 'today';
        return setArea(g.area || 'today');
      }
      if (t.dataset.billingFilter !== undefined) {
        state.billingFilter = state.billingFilter === t.dataset.billingFilter ? '' : t.dataset.billingFilter;
        renderMain();
        const target = $(state.billingFilter === 'received' || state.billingFilter === 'toVerify' ? '#crm-receipts-title' : '#crm-debtors-title');
        if (target && state.billingFilter) target.scrollIntoView({ block: 'start', behavior: 'smooth' });
        return;
      }
      if (t.dataset.triageOpt) {
        const id = t.closest('[data-triage]').dataset.triage; const o = t.dataset.triageOpt;
        if (!state.triage) state.triage = { decided: 0, skipped: [] };
        if (o === 'call') return openContactPanel('lead', id, '');
        if (o === 'update') return openDrawer('lead', id);
        state.triage.open = state.triage.open === o ? '' : o; return renderMain();
      }
      if (t.dataset.triageSkip) { if (!state.triage) state.triage = { decided: 0, skipped: [] }; state.triage.skipped.push(t.dataset.triageSkip); state.triage.open = ''; return renderMain(); }
      if (t.dataset.quickCancel !== undefined) { state.quick = ''; const q = $('#crm-quick'); if (q) q.innerHTML = ''; return; }
      if (t.dataset.quickPick) {
        const p = t.dataset.quickPick.split(':'); const kind = state.quick; state.quick = ''; const q = $('#crm-quick'); if (q) q.innerHTML = '';
        if (kind === 'contact') return openContactPanel(p[0], p.slice(1).join(':'), '');
        openDrawer(p[0], p.slice(1).join(':'));
        if (kind === 'task') { const tab = doc.querySelector('#crm-drawer [data-tab="tasks"]'); if (tab) tab.click(); const d = doc.querySelector('#crm-tasks details'); if (d) d.open = true; }
        else focusMeetingForm();
        return;
      }
      if (t.dataset.view) { state.view = t.dataset.view; return renderMain(); }
      if (t.dataset.sort) { state.sort = t.dataset.sort; return renderMain(); }
      if (t.hasAttribute('data-open-lead') || t.hasAttribute('data-open-patient')) {
        const isLead = t.hasAttribute('data-open-lead');
        openDrawer(isLead ? 'lead' : 'patient', isLead ? t.dataset.openLead : t.dataset.openPatient);
        if (!state.drawer || state.drawer.id !== (isLead ? t.dataset.openLead : t.dataset.openPatient)) return;
        if (t.dataset.openTab) { const tab = doc.querySelector('#crm-drawer [data-tab="' + t.dataset.openTab + '"]'); if (tab) tab.click(); }
        if (t.dataset.focusMeeting) focusMeetingForm();
        return;
      }
      if (t.dataset.tab) {
        doc.querySelectorAll('#crm-drawer [role="tab"]').forEach(function (b) { b.setAttribute('aria-selected', String(b === t)); });
        doc.querySelectorAll('#crm-drawer [data-pane]').forEach(function (p) { p.hidden = p.dataset.pane !== t.dataset.tab; });
        if (state.drawer) state.drawer.tab = t.dataset.tab;
        if (t.dataset.tab === 'meetings') markReportSeen();
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
    /* «סיבת המתנה» saves on the radio change (CHANGELOG-crm-followups-1104.md): a choice that only
     * LOOKED selected was never sent before (the «שמירה» click was easy to miss). */
    function saveWaitReason(f, tries) {
      const checked = f.querySelector('input[name="reason"]:checked');
      if (!checked) return;
      const st = f.querySelector('[data-wait-state]');
      f.querySelectorAll('input[name="reason"]').forEach(function (r) { r.disabled = true; });
      f.setAttribute('aria-busy', 'true');
      if (st) st.innerHTML = '<span class="spin" aria-hidden="true"></span> שומר…';
      // Chosen right after another save of this card (e.g. the move to «רשימת המתנה»): wait for it
      // instead of dropping the choice — that drop was the «סומן אך לא נשמר» of 04/11/2026.
      if (state.saving) {
        const lead = f.dataset.lead, reason = checked.value, n = (tries || 0) + 1;
        if (n > 60) { if (st) { st.textContent = 'לא נשמר — נסי שוב'; st.style.color = 'var(--bad)'; } f.removeAttribute('aria-busy'); f.querySelectorAll('input[name="reason"]').forEach(function (r) { r.disabled = false; }); return; }
        win.setTimeout(function () {
          const again = doc.querySelector('#crm-drawer form[data-form="wait-reason"][data-lead="' + lead.replace(/[^A-Za-z0-9_\-]/g, '') + '"]') || f;
          const pick = again.querySelector('input[name="reason"][value="' + (reason === 'funder' ? 'funder' : 'place') + '"]');
          if (pick) pick.checked = true;
          saveWaitReason(again, n);
        }, 300);
        return;
      }
      postLeadFlag({ leadId: f.dataset.lead, kind: 'waitlist_reason', reason: checked.value }, 'סיבת ההמתנה').then(function (ok) {
        // success re-renders the card from the server echo; a refusal re-enables the choice and says so
        if (ok) return;
        f.removeAttribute('aria-busy');
        f.querySelectorAll('input[name="reason"]').forEach(function (r) { r.disabled = false; });
        if (st) { st.textContent = 'לא נשמר — נסי שוב'; st.style.color = 'var(--bad)'; }
      });
    }
    root.addEventListener('change', function (ev) {
      const r = ev.target;
      if (r && r.name === 'reason' && r.form && r.form.dataset && r.form.dataset.form === 'wait-reason') saveWaitReason(r.form);
    });
    root.addEventListener('submit', function (ev) {
      const fp = ev.target;
      // A spinner on the button of every CRM save (CHANGELOG-crm-followups-1104.md).
      if (fp && fp.dataset && fp.dataset.form) {
        if (state.saving) { ev.preventDefault(); ev.stopImmediatePropagation(); toast('שמירה קודמת עדיין מתבצעת — רגע אחד ונסי שוב', true); return; }
        // recorded only; the spinner starts when the save really starts (setSaveState('שומר…') /
        // the send), so a form refused by its own validation never shows a stuck spinner
        state.busyForm = { form: fp.dataset.form, key: fp.dataset.lead || fp.dataset.discharge || fp.dataset.patient || '' };
      }
      if (fp && fp.dataset && fp.dataset.form === 'out-phone') {
        ev.preventDefault();
        const raw = fp.elements.phone ? fp.elements.phone.value : '';
        const err = fp.querySelector('[data-err="phone"]');
        const ph = handoffPhone(raw);
        // in the patient card the phone is optional (the server finds it); in the «משוחררים» row it was asked for
        if (!ph && !(fp.dataset.optional === '1' && !s(raw))) { if (err) err.textContent = 'טלפון לא תקין — 9 או 10 ספרות, מתחיל ב-0'; return; }
        if (err) err.textContent = '';
        sendToOutpatient(fp.dataset.discharge, ph);
        return;
      }
    });
    root.addEventListener('submit', function (ev) {
      const f = ev.target;
      if (!f || !f.dataset || !f.dataset.form) return;
      ev.preventDefault();
      if (state.saving) return;
      const id = f.dataset.lead;
      const v = function (n) { const el = f.elements[n]; return el ? s(el.value) : ''; };
      if (f.dataset.form === 'breakeven') {
        const r = breakevenFromForm(f);
        showErrs(f, r.errs, ['hqCost'].concat(HOUSES.map(function (h) { return h.id; })));
        if (Object.keys(r.errs).length) return;
        try { win.localStorage.setItem(BREAKEVEN_STORAGE_KEY, JSON.stringify(r.cfg)); } catch (_) { toast('השמירה בדפדפן נכשלה', true); return; }
        toast('ההוצאות עודכנו');
        return renderMain();
      }
      if (f.dataset.form === 'meeting') {
        const patch = { visitDate: v('visitDate'), visitTime: v('visitTime'), meetingWith: v('meetingWith') };
        const cur = compute(state.data, state.today).leads.filter(function (x) { return x.id === id; })[0];
        if (cur && cur.stage === 'new' && patch.visitDate) patch.stage = 'visit';   // a dated meeting moves a new lead to ביקור נקבע
        writeLead(id, patch, 'הפגישה');
      } else if (f.dataset.form === 'outcome') {
        writeLead(id, { meetingOutcome: v('meetingOutcome') }, 'תוצאת הפגישה');
      } else if (f.dataset.form === 'wait-reason') {
        saveWaitReason(f);
      } else if (f.dataset.form === 'patient-change') {
        // A first-stage lead save may have succeeded even when the SECOND
        // (Activity) acknowledgement was lost. Retry only that frozen second
        // stage; do not write the lead again or replace the original prior slot.
        const prior = pendingLeadFlags[s(id) + ':meeting_patient_change'];
        if (prior) {
          postLeadFlag(prior.body.flag, 'השינוי ע״י המטופל/ת', true).then(function (flagged) {
            const a = flagged ? $('#crm-drawer [data-wa-manager]') : null;
            if (a) { a.focus(); toast('התיעוד אומת — לחצי «הודעה למנהל/ת בוואטסאפ» לעדכון המנהל/ת'); }
          });
          return;
        }
        const lead = compute(state.data, state.today).leads.filter(function (x) { return x.id === id; })[0];
        const checked = f.querySelector('input[name="change"]:checked');
        const plan = lead ? patientChangePlan(lead, { change: checked ? checked.value : '', newDate: v('newDate'), newTime: v('newTime'), note: v('note') }, state.today) : { errors: { change: 'הליד לא נמצא' } };
        f.querySelectorAll('[data-err]').forEach(function (el) { el.textContent = plan.errors[el.dataset.err] || ''; });
        if (Object.keys(plan.errors).length) return;
        // 1) the lead row (normal saveAll path); 2) who changed it (Activity); 3) the manager's WhatsApp, prefilled.
        writeLead(id, plan.patch, plan.flag.change === 'cancelled' ? 'ביטול הפגישה' : 'המועד החדש').then(function (ok) {
          if (!ok) return;
          // A popup opened after two awaits is blocked by browsers, so the prefilled link is a
          // button at the top of the card (one tap) — never an automatic navigation away.
          return postLeadFlag(plan.flag, 'השינוי ע״י המטופל/ת', true).then(function (flagged) {
            const a = flagged ? $('#crm-drawer [data-wa-manager]') : null;
            if (a) { a.focus(); toast('נשמר — לחצי «הודעה למנהל/ת בוואטסאפ» כדי לעדכן את ' + (plan.flag.withWhom || 'המנהל/ת')); }
          });
        });
      } else if (f.dataset.form === 'note') {
        writeLead(id, { assignedTo: v('assignedTo'), note: v('note') }, 'ההערה');
      } else if (f.dataset.form === 'close') {
        const ce = closeLeadErrors({ disposition: v('disposition'), note: v('note') });
        showErrs(f, ce, ['disposition', 'note']);
        if (Object.keys(ce).length) return;
        closeLeadAction(id, v('disposition'), v('note'));
      } else if (f.dataset.form === 'admit') {
        const vals = {}; Array.prototype.forEach.call(f.elements, function (el) { if (el.name) vals[el.name] = el.value; });
        admitLead(id, vals, f);
      } else if (f.dataset.form === 'direct-add') {
        const vals = {}; Array.prototype.forEach.call(f.elements, function (el) { if (el.name) vals[el.name] = el.type === 'checkbox' ? (el.checked ? 'yes' : '') : el.value; });
        directAdd(vals, f);
      } else if (f.dataset.form === 'patient-edit') {
        const vals = {}; Array.prototype.forEach.call(f.elements, function (el) { if (el.name) vals[el.name] = el.value; });
        editPatient(f.dataset.patient, vals, f);
      } else if (f.dataset.form === 'patient-move') {
        if (win.confirm('להעביר את המטופל/ת לבית ' + houseName(v('toHouseId')) + '?')) movePatient(f.dataset.patient, v('toHouseId'));
      } else if (f.dataset.form === 'discharge') {
        const vals = {}; Array.prototype.forEach.call(f.elements, function (el) { if (el.name) vals[el.name] = el.value; });
        dischargePatient(f.dataset.patient, vals, f);
      } else if (f.dataset.form === 'restore') {
        submitRestore(f);
      } else if (f.dataset.form.indexOf('link-') === 0) {
        submitLink(f);
      } else if (f.dataset.form === 'payment-report') {
        submitReport(f, false);
      } else if (f.dataset.form === 'cleanup') {
        submitCleanup(f);
      } else if (f.dataset.form.indexOf('small-') === 0) {
        submitSmall(f);
      } else if (f.dataset.form === 'refund-action') {
        submitRefundAction(f);
      } else if (f.dataset.form === 'credit-new' || f.dataset.form === 'credit-edit') {
        submitCredit(f);
      } else if (f.dataset.form.indexOf('receipt-') === 0) {
        submitReceiptForm(f);
      } else if (f.dataset.form === 'contact') {
        submitContact(f);
      } else if (f.dataset.form === 'task-new') {
        const vals = contactValues(f);
        const subj = state.drawer ? (state.drawer.kind === 'lead' ? { leadId: state.drawer.id } : { patientId: state.drawer.id }) : null;
        if (subj) {
          const tv = { kind: vals.kind, title: vals.title, assignee: vals.assignee, dueDate: vals.dueDate, dueTime: vals.dueTime };
          askNotifyPermission();
          postTask(f, taskCreateBody(subj, tv, newSubmissionId()), newTaskErrors(tv, state.today), '', 'המשימה נוצרה');
        }
      } else if (f.dataset.form === 'task-resched') {
        const vals = contactValues(f); const tk = taskById(f.dataset.task);
        postTask(f, rescheduleBody(f.dataset.task, vals), rescheduleErrors(vals, tk), f.dataset.task, 'המועד עודכן');
      } else if (f.dataset.form === 'task-done') {
        postTask(f, { action: 'completeTask', id: f.dataset.task, outcome: v('outcome') }, {}, f.dataset.task, 'המשימה הושלמה');
      } else if (f.dataset.form === 'task-reassign') {
        postTask(f, { action: 'reassignTask', id: f.dataset.task, assignee: v('assignee') }, v('assignee') ? {} : { _form: 'בחרי אחראי' }, f.dataset.task, 'האחראי עודכן');
      } else if (f.dataset.form === 'task-withdraw') {
        postTask(f, { action: 'withdrawTask', id: f.dataset.task, reason: v('reason') }, v('reason').length >= 2 ? {} : { reason: 'סיבה (2 תווים לפחות)' }, f.dataset.task, 'המשימה בוטלה');
      } else if (f.dataset.form === 'triage-later') {
        const vals = contactValues(f);
        triageTask(f, taskCreateBody({ leadId: f.dataset.lead }, { kind: 'call', title: 'לחזור — ' + (vals.reason || 'בירור'), reason: vals.reason, assignee: vals.assignee, dueDate: vals.dueDate, dueTime: vals.dueTime }, newSubmissionId()), laterErrors(vals, state.today));
      } else if (f.dataset.form === 'triage-check') {
        const vals = contactValues(f);
        triageTask(f, taskCreateBody({ leadId: f.dataset.lead }, { kind: 'review', title: vals.title, reason: 'סומן לבדיקה נוספת בסבב הבירור', assignee: vals.assignee, dueDate: vals.dueDate }, newSubmissionId()), taskFormErrors(Object.assign({ kind: 'review' }, vals), state.today));
      } else if (f.dataset.form === 'triage-waitlist') {
        triageWaitlist(f, f.dataset.lead, contactValues(f));
      } else if (f.dataset.form === 'triage-close') {
        if (v('reason').length < 2) { showReportIssues(f, [{ field: 'reason', hebrewMessage: 'סיבה (2 תווים לפחות)' }], ''); return; }
        closeLeadAction(f.dataset.lead, 'not_relevant', v('reason')).then(function (ok) { if (ok) { triageDecided(); renderMain(); } });
      } else if (f.dataset.form === 'new-lead') {
        const vals = {};
        Array.prototype.forEach.call(f.elements, function (el) { if (el.name) vals[el.name] = el.value; });
        createLead(vals);
      }
    });
    root.addEventListener('click', function (ev) {
      const t = ev.target && ev.target.closest ? ev.target.closest('[data-billing-retry],[data-fc-preset],[data-due-today],[data-due-report],[data-report-open],[data-report-row],[data-report-cancel],[data-discount-open],[data-amount-open],[data-refund-action],[data-refund-cancel],[data-report-other],[data-receipt-edit],[data-receipt-void],[data-receipt-cancel],[data-credit-edit],[data-credit-new],[data-credit-cancel]') : null;
      if (!t) return;
      if (t.dataset.creditCancel !== undefined) { state.creditForm = null; const box = t.closest('form'); if (box) box.remove(); return; }
      if (t.dataset.creditEdit) return openCreditForm('edit', t.dataset.creditEdit);
      if (t.dataset.creditNew !== undefined) return openCreditForm('new', '');
      if (t.dataset.billingRetry !== undefined) { resetBilling(); return renderMain(); }
      if (t.dataset.reportCancel !== undefined) { state.report = null; state.small = null; const el = $('#crm-report'); if (el) el.innerHTML = ''; return; }
      if (t.dataset.dueToday !== undefined) { state.dueDate = state.today; return renderMain(); }
      if (t.dataset.fcPreset) { const r = forecastPreset(t.dataset.fcPreset, state.today); state.fcFrom = r.from; state.fcTo = r.to; return renderMain(); }
      if (t.dataset.dueReport !== undefined) {
        // «לגבייה בתאריך» → the patient's «חשבון», then the report form on THAT cycle
        const r = (state.dueRows || [])[Number(t.dataset.dueReport)];
        const pat = r && compute(state.data, state.today).patients.filter(function (p) { return p.id === r.patientId; })[0];
        if (!pat) return toast('המטופל/ת לא נמצא/ה ברשימה — דיווח בדשבורד הרגיל', true);
        const go = function () { if (state.account && state.drawer && state.drawer.id === pat.id) openReportForm(r.cycle, r.balance, { month: s(r.cycle && r.cycle.dueDate).slice(0, 7), discount: r.discount }); };
        openDrawer('patient', pat.id); const tab = doc.querySelector('#crm-drawer [data-tab="account"]'); if (tab) tab.click();
        if (state.billing) go(); else loadBilling(go);
        return;
      }
      if (t.dataset.refundCancel !== undefined) {
        state.refundAction = null;
        const box = t.closest('form'); if (box) box.remove();
        return;
      }
      if (t.dataset.refundAction) return openRefundAction(t.dataset.refundAction, t.dataset.refundId);
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
      if (t.dataset.reportOpen !== undefined) {
        const c = state.account.data.openCycles[Number(t.dataset.reportOpen)];
        if (c) openReportForm(reportCycleFor(state.account.patient, c, state.account.data), c.balance, { month: c.month, discount: c.discount });
        return;
      }
      if (t.dataset.reportRow) {
        const row = state.account.data.cycles.filter(function (x) { return x.id === t.dataset.reportRow; })[0];
        if (row) openReportForm(reportCycleForRow(state.account.patient, row), Math.max(0, row.amount - row.amountPaid));
      }
    });
    root.addEventListener('click', function (ev) {
      const t = ev.target && ev.target.closest ? ev.target.closest('[data-clients-view],[data-restore],[data-to-outpatient],[data-out-phone-cancel],[data-restore-cancel],[data-link-open],[data-notpatient-open],[data-link-cancel]') : null;
      if (!t) return;
      if (t.dataset.clientsView) { state.clientsView = t.dataset.clientsView; return renderMain(); }
      if (t.dataset.linkCancel !== undefined) { state.link = null; const el = $('#crm-link'); if (el) el.innerHTML = ''; return; }
      if (t.dataset.linkOpen) return openLinkForm('link', t.dataset.linkOpen);
      if (t.dataset.notpatientOpen) return openLinkForm('not', t.dataset.notpatientOpen);
      if (t.dataset.restoreCancel !== undefined) { const el = $('#crm-restore'); if (el) el.innerHTML = ''; return; }
      if (t.dataset.restore) return openRestoreChoice(t.dataset.restore);
      if (t.dataset.outPhoneCancel !== undefined) { state.outPhone = ''; return renderMain(); }
      if (t.dataset.toOutpatient) { if (win.confirm('להעביר לאמבולטורי (ליד טיפול חוץ באאוטפיישנט)?')) sendToOutpatient(t.dataset.toOutpatient); }
    });
    root.addEventListener('click', function (ev) {
      const t = ev.target && ev.target.closest ? ev.target.closest('[data-contact-open],[data-contact-cancel],[data-task-resched],[data-task-done],[data-task-more],[data-task-cancel-form],[data-tasks-retry]') : null;
      if (!t) return;
      if (t.dataset.tasksRetry !== undefined) { reloadTasks(); return; }
      if (t.dataset.contactOpen) { const p = t.dataset.contactOpen.split(':'); return openContactPanel(p[0], p.slice(1).join(':'), t.dataset.taskId || ''); }
      if (t.dataset.contactCancel !== undefined) { const b = state.contact; state.contact = null; if (b) { state.drawer = state.drawer || { kind: b.kind, id: b.id, tab: 'overview' }; openDrawer(b.kind, b.id, true); } else closeDrawer(); return; }
      if (t.dataset.taskCancelForm) { const el = t.closest('.task-form'); if (el) el.innerHTML = ''; return; }
      if (t.dataset.taskResched) return openTaskForm(t.dataset.taskResched, 'resched', t);
      if (t.dataset.taskDone) return openTaskForm(t.dataset.taskDone, 'done', t);
      if (t.dataset.taskMore) return openTaskForm(t.dataset.taskMore, 'more', t);
    });
    root.addEventListener('change', function (ev) {
      const f = ev.target && ev.target.closest ? ev.target.closest('form[data-form="contact"]') : null;
      if (f) refreshNextPreview(f);
      const rf = ev.target && ev.target.closest ? ev.target.closest('form[data-form="payment-report"]') : null;
      if (rf) refreshPwdPreview(rf);
    });
    /* «שולם עם הנחה»: show the reason field and the discount the form will write. */
    function refreshPwdPreview(f) {
      const box = f.querySelector('[data-pwd-box]');
      const on = !!(f.elements.withDiscount && f.elements.withDiscount.checked);
      if (!box || !state.report) return;
      box.hidden = !on;
      const pv = box.querySelector('[data-pwd-preview]');
      if (!pv) return;
      const amount = moneyParse(f.elements.amount && f.elements.amount.value);
      const rem = state.report.remaining;
      pv.textContent = on && amount !== null && amount > 0 && amount < rem
        ? 'יירשם: תשלום ' + fmtMoney(amount) + ' + הנחה ' + fmtMoney(Math.round((rem - amount) * 100) / 100) + ' = ' + fmtMoney(rem) + ' · המחזור ייסגר'
        : (on ? 'הזיני סכום נמוך מהיתרה (' + fmtMoney(rem) + ')' : '');
    }
    root.addEventListener('input', function (ev) {
      if (ev.target && ev.target.id === 'crm-quick-q') return quickList(ev.target.value);
      const rf = ev.target && ev.target.closest ? ev.target.closest('form[data-form="payment-report"]') : null;
      if (rf && ev.target.name === 'amount') refreshPwdPreview(rf);
      const f = ev.target && ev.target.closest ? ev.target.closest('form[data-form="contact"]') : null;
      if (f && /^next/.test(ev.target.name || '')) refreshNextPreview(f);
    });
    root.addEventListener('click', function (ev) {
      const t = ev.target && ev.target.closest ? ev.target.closest('[data-cal-mode],[data-cal-step],[data-cal-today]') : null;
      if (!t) return;
      if (!state.cal) state.cal = { mode: 'day', anchor: state.today };
      if (t.dataset.calMode) state.cal.mode = t.dataset.calMode;
      else if (t.dataset.calStep) state.cal.anchor = addDays(state.cal.anchor, Number(t.dataset.calStep));
      else state.cal.anchor = state.today;
      renderMain();
    });
    root.addEventListener('toggle', function (ev) { if (ev.target && ev.target.id === 'crm-cleanup') state.cleanupOpen = ev.target.open; }, true);
    root.addEventListener('change', function (ev) {
      const t = ev.target;
      // «ניקוי חובות היסטוריים»: ticking never re-renders (the reason / note stay typed)
      if (t.dataset && (t.dataset.cleanupRow !== undefined || t.dataset.cleanupAll !== undefined)) {
        const rows = state.cleanupRows || [];
        state.cleanupSel = state.cleanupSel || {};
        if (t.dataset.cleanupAll !== undefined) {
          rows.forEach(function (r) { if (t.checked) state.cleanupSel[r.id] = true; else delete state.cleanupSel[r.id]; });
          Array.prototype.forEach.call(doc.querySelectorAll('[data-cleanup-row]'), function (el) { el.checked = t.checked; });
        } else {
          const r = rows[Number(t.dataset.cleanupRow)];
          if (r) { if (t.checked) state.cleanupSel[r.id] = true; else delete state.cleanupSel[r.id]; }
        }
        const sum = $('#crm-cleanup-sum'); if (sum) sum.textContent = cleanupSumText();
        return;
      }
      // a field inside a form (report, restore, …) is the form's business — re-rendering would wipe it
      if (t.id === 'crm-day-week') { if (isoDateOk(t.value)) state.week = t.value; return renderMain(); }
      if (t.id === 'crm-due-date') { if (isoDateOk(t.value)) state.dueDate = t.value; return renderMain(); }
      if (t.id === 'crm-due-funder') { state.dueFunder = t.value; return renderMain(); }
      if (t.id === 'crm-fc-from') { if (isoDateOk(t.value)) state.fcFrom = t.value; return renderMain(); }
      if (t.id === 'crm-fc-to') { if (isoDateOk(t.value)) state.fcTo = t.value; return renderMain(); }
      if (['f-dis-days', 'crm-cal-date', 'f-house', 'f-house-c', 'f-owner'].indexOf(t.id) < 0) return;
      if (t.id === 'f-dis-days') state.dischargedDays = Number(t.value) || 0;
      if (t.id === 'crm-cal-date') { if (!state.cal) state.cal = { mode: 'day', anchor: state.today }; if (isoDateOk(t.value)) state.cal.anchor = t.value; }
      if (t.id === 'f-house' || t.id === 'f-house-c') state.filters.house = t.value;
      if (t.id === 'f-owner') state.filters.owner = t.value;
      renderMain();
    });
    /* «החלפת משתמש» (CHANGELOG-crm-dana-default-switch-user.md): the server ends the
     * session (POST /api/logout revokes the token), then nothing of this user stays:
     * in-memory state, the rendered areas and drawer, the remembered login name and
     * the offline copies of `/`. Then `/` — the server's PIN screen; the next login
     * lands on that user's own default view. */
    function switchUser(btn) {
      if (btn) { btn.disabled = true; btn.setAttribute('aria-busy', 'true'); }
      const done = function () {
        Object.keys(state).forEach(function (k) { if (['area', 'view', 'filters', 'today', 'loading'].indexOf(k) < 0) state[k] = null; });
        state.filters = { q: '', house: '', owner: '' };
        main.innerHTML = '';
        const dr = $('#crm-drawer'); if (dr) { dr.innerHTML = ''; dr.setAttribute('aria-hidden', 'true'); }
        ['#crm-user', '#crm-who'].forEach(function (sel) { const el = $(sel); if (el) el.textContent = ''; });
        const q = $('#crm-search'); if (q) q.value = '';
        try { win.localStorage.removeItem('ezone.lastLoginUser'); } catch (_) { /* private mode */ }
        return clearCachedPages(win.caches).then(function () { win.location.replace('/'); });
      };
      return win.fetch('/api/logout', { method: 'POST', credentials: 'same-origin' }).then(done, done);
    }
    const switchBtn = $('#crm-switch-user');
    if (switchBtn) switchBtn.addEventListener('click', function () { switchUser(switchBtn); });
    /* The top search (CHANGELOG-crm-search-admit-funder.md): «פניות» / «מטופלים» / «גבייה» filter
     * their own list as before; from any other area the results are a global list (leads +
     * patients, released included) instead of a jump to «פניות». Debounced, with a spinner
     * while it runs; Enter or 🔍 searches at once; clearing returns to the previous area. */
    const searchBox = $('#crm-search'), searchBtn = $('#crm-search-go');
    let searchTimer = 0;
    function runSearch() {
      win.clearTimeout(searchTimer);
      const q = s(searchBox.value);
      state.filters.q = q;
      if (q && ['leads', 'clients', 'billing', 'search'].indexOf(state.area) < 0) { state.searchBack = state.area; state.area = 'search'; }
      if (!q && state.area === 'search') state.area = state.searchBack || 'today';
      renderNav(); renderMain();
      if (searchBtn) { searchBtn.removeAttribute('aria-busy'); searchBtn.disabled = false; }
    }
    function searchSoon(delay) {
      if (searchBtn) { searchBtn.setAttribute('aria-busy', 'true'); searchBtn.disabled = true; }
      win.clearTimeout(searchTimer);
      // let the spinner paint before the (synchronous) render
      searchTimer = win.setTimeout(runSearch, delay);
    }
    searchBox.addEventListener('input', function () { searchSoon(300); });
    searchBox.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') { ev.preventDefault(); searchSoon(30); } });
    if (searchBtn) searchBtn.addEventListener('click', function () { searchSoon(30); });
    doc.addEventListener('keydown', function (ev) { if (ev.key === 'Escape') closeDrawer(); });

    /* Boot (perf, CHANGELOG-crm-triage.md): /api/me and getData are requested AT ONCE (the
     * classic page fires getData immediately); the page renders as soon as getData is in,
     * and the other sources (tasks, contact index, debt / the controller queue) fill in as
     * they arrive — each card says «טוען…» until then and «המידע אינו זמין» if it failed. */
    function load() {
      state.loading = true; state.error = ''; state.tasks = undefined; state.index = undefined; state.debt = null; state.payments = null; state.tasksError = ''; renderMain();
      const meP = win.fetch('/api/me', { credentials: 'same-origin' }).then(function (r) { return r.json(); });
      const dataP = api('getData');
      return Promise.all([meP, dataP]).then(function (res) {
        const me = res[0], data = res[1];
        if (!me || me.ok === false) throw new Error('אין התחברות');
        state.me = me;
        $('#crm-user').textContent = me.user || '';
        if ($('#crm-who')) $('#crm-who').textContent = me.user || '';
        if (areasFor(me).indexOf(state.area) < 0) state.area = 'today';
        if (!data || data.ok === false) throw new Error('הנתונים לא נטענו' + (data && data.error ? ' (' + data.error + ')' : ''));
        state.data = data; state.loading = false;
        renderNav(); renderMain();
        const later = function (p, apply) { return p.then(apply, function () { apply(null); }).then(function () { renderNav(); renderMain(); }); };
        if (me.view === 'controller') {
          state.queue = undefined; state.credits = undefined; state.tasks = undefined;
          return Promise.all([later(api('billingControlQueue'), function (q) { state.queue = q || null; }), later(api('getTasks', { status: 'open' }), applyTasks), later(api('getCredits'), function (r) { state.credits = r && r.ok === true ? r : null; })]);
        }
        const reads = [
          later(api('getTasks', { status: 'open' }), applyTasks),
          later(api('contactIndex'), function (r) { state.index = r && r.ok === true ? r : null; }),
        ];
        if (me.finance) { state.payments = undefined; reads.push(later(api('debtAging'), function (r) { state.debt = r && r.ok === true ? r : false; })); reads.push(later(api('getPayments'), function (r) { state.payments = r && r.ok === true ? r : null; })); }
        return Promise.all(reads);
      }).catch(function (e) { state.loading = false; state.error = String(e && e.message || e); renderNav(); renderMain(); });
    }
    /* Task reminders (CHANGELOG-crm-task-date-time.md): every minute, a toast + a system
     * notification (when allowed) for each of MY tasks due today within TASK_REMIND_MINUTES.
     * The page must be open; Vered's morning mail already lists today's tasks. */
    var announced = {};   // var: renderNav may run first
    function nowHm() { return new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date()); }
    function askNotifyPermission() {
      try { if (win.Notification && win.Notification.permission === 'default') win.Notification.requestPermission(); } catch (_) { /* unsupported */ }
    }
    function remindTick() {
      if (!announced || !state.me || !Array.isArray(state.tasks)) return;
      const c = state.data ? compute(state.data, state.today) : null;
      dueSoonTasks(state.tasks, state.me.user, state.today, nowHm(), TASK_REMIND_MINUTES, announced).forEach(function (r) {
        announced[r.key] = true;
        const who = c ? taskSubject(r.task, c).name : '';
        const text = '⏰ בעוד ' + r.minutes + ' דק׳ (' + s(r.task.dueTime) + '): ' + s(r.task.title) + (who ? ' — ' + who : '');
        toast(text);
        try { if (win.Notification && win.Notification.permission === 'granted') new win.Notification('E-ZONE · משימה', { body: text, tag: r.key }); } catch (_) { /* unsupported */ }
      });
    }
    if (typeof win.setInterval === 'function') win.setInterval(remindTick, 60000);
    renderNav(); renderMain();
    load();
    return { state: state, load: load, setArea: setArea, switchUser: switchUser, remindTick: remindTick };
  }

  return { HOUSES: HOUSES, STAGES: STAGES, AREAS: AREAS, WAIT_DAYS: WAIT_DAYS, areasFor: areasFor, normalise: normalise, compute: compute, filterLeads: filterLeads,
    board: board, nextActionFor: nextActionFor, clients: clients, calendar: calendar, control: control, controllerDay: controllerDay, houseName: houseName, houseId: houseId,
    occupancy: occupancy, inHouse: inHouse, fmtDate: fmtDate, esc: esc, boot: boot, accountTabVisible: accountTabVisible, clearCachedPages: clearCachedPages,
    MEETING_OUTCOMES: MEETING_OUTCOMES, MEETING_WITH_AMBULATORY: MEETING_WITH_AMBULATORY, ASSIGNEES: ASSIGNEES,
    stageAfter: stageAfter, stageBefore: stageBefore, applyLeadPatch: applyLeadPatch, leadSaveBody: leadSaveBody, saveRefusal: saveRefusal,
    DISPOSITIONS: DISPOSITIONS, CONTACT_RELATIONS: CONTACT_RELATIONS, localPhone: localPhone, leadFormErrors: leadFormErrors, newLeadRow: newLeadRow,
    duplicateByPhone: duplicateByPhone, closeRecord: closeRecord, randomId: randomId,
    FUNDERS: FUNDERS, PATIENT_STATUSES: PATIENT_STATUSES, admissionRow: admissionRow, admissionErrors: admissionErrors, directAddRows: directAddRows,
    directAddErrors: directAddErrors, houseSaveBody: houseSaveBody, houseSaveRefusal: houseSaveRefusal, isoDateOk: isoDateOk,
    DISCHARGE_DISPOSITIONS: DISCHARGE_DISPOSITIONS, CONTINUITY_CHOICES: CONTINUITY_CHOICES, dischargeAuditRow: dischargeAuditRow, dischargeErrors: dischargeErrors,
    movedRow: movedRow, patientEditErrors: patientEditErrors, meetingsFor: meetingsFor, managerReport: managerReport, whenLocal: whenLocal,
    detachedRows: detachedRows, linkCandidates: linkCandidates, namesLookAlike: namesLookAlike, linkBody: linkBody, notPatientBody: notPatientBody, linkErrors: linkErrors, linkAccepted: linkAccepted,
    dischargedList: dischargedList, priorStatusOf: priorStatusOf, restoreTarget: restoreTarget, restoredRow: restoredRow, openAuditsOf: openAuditsOf, restoreFlagBody: restoreFlagBody, restoreAsLeadBody: restoreAsLeadBody, outpatientBody: outpatientBody, handoffPhone: handoffPhone, calendarRange: calendarRange, calendarRows: calendarRows, undatedVisits: undatedVisits, calendarTitle: calendarTitle, weekStart: weekStart, DAY_NAMES: DAY_NAMES, reportUnseen: reportUnseen, unseenReports: unseenReports,
    MEETING_REPORT_OUTCOME_LABELS: MEETING_REPORT_OUTCOME_LABELS, MEETING_COMPANION_LABELS: MEETING_COMPANION_LABELS, DISPOSITION_LABELS: DISPOSITION_LABELS, billingOverview: billingOverview, billingSearch: billingSearch, fmtMoney: fmtMoney, DEBT_BUCKET_LABELS: DEBT_BUCKET_LABELS, patientAccount: patientAccount, sheetDay: sheetDay, CYCLE_STATUS_LABELS: CYCLE_STATUS_LABELS,
    patientKeyOf: patientKeyOf, reportCycleFor: reportCycleFor, reportCycleForRow: reportCycleForRow, reportDefaults: reportDefaults, reportIssues: reportIssues, reportBody: reportBody,
    newSubmissionId: newSubmissionId, funderWriteConfirmed: funderWriteConfirmed, funderSourceConfirmed: funderSourceConfirmed, funderExceptions: funderExceptions, admissionSourceProof: admissionSourceProof, reportOutcome: reportOutcome, duplicateText: duplicateText, reportRules: reportRules,
    CREDIT_TYPE_LABELS: CREDIT_TYPE_LABELS, CREDIT_STATUS_LABELS: CREDIT_STATUS_LABELS, SETTLE_METHODS: SETTLE_METHODS, creditsOf: creditsOf, patientCredits: patientCredits, pendingCredits: pendingCredits,
    refundActionFor: refundActionFor, refundStageText: refundStageText, refundActionButton: refundActionButton,
    RECEIPT_EDIT_FIELDS: RECEIPT_EDIT_FIELDS, receiptEditFields: receiptEditFields, receiptEditIssues: receiptEditIssues, receiptEditBody: receiptEditBody, receiptVoidErrors: receiptVoidErrors, receiptVoidBody: receiptVoidBody, receiptVoidAccepted: receiptVoidAccepted,
    addMonthsIso: addMonthsIso, dueOnDate: dueOnDate, filterDueRows: filterDueRows, monthSplit: monthSplit, cycleBalanceLib: cycleBalanceLib, FUNDER_UNSET_LABEL: FUNDER_UNSET_LABEL, stayCycles: stayCycles, reportableCycles: reportableCycles, defaultReportable: defaultReportable, reportCycleForWindow: reportCycleForWindow,
    CONTACT_OUTCOMES: CONTACT_OUTCOMES, CONTACT_CHANNELS: CONTACT_CHANNELS, NEXT_CHOICES: NEXT_CHOICES, TASK_KINDS: TASK_KINDS, TASK_KIND_LABELS: TASK_KIND_LABELS, contactOutcomeLabel: contactOutcomeLabel, nextPlan: nextPlan, contactErrors: contactErrors, contactBody: contactBody, contactAccepted: contactAccepted,
    taskDue: taskDue, taskState: taskState, taskWhen: taskWhen, taskSubject: taskSubject, taskQueue: taskQueue, tasksFor: tasksFor, taskCounts: taskCounts, taskFormErrors: taskFormErrors, taskCreateBody: taskCreateBody, rescheduleErrors: rescheduleErrors, rescheduleBody: rescheduleBody, taskAccepted: taskAccepted,
    VERIFY_LABELS: VERIFY_LABELS, verifyStatus: verifyStatus, verificationRows: verificationRows, ortalDay: ortalDay,
    TRIAGE_OPTIONS: TRIAGE_OPTIONS, triageQueue: triageQueue, waitlistErrors: waitlistErrors, waitlistPatch: waitlistPatch, laterErrors: laterErrors,
    NAV_GROUPS: NAV_GROUPS, MY_DAY_VIEWS: MY_DAY_VIEWS, DOMAINS: DOMAINS, DOMAIN_LABELS: DOMAIN_LABELS, meetingBuckets: meetingBuckets, newLeadsNoContact: newLeadsNoContact, houseExceptions: houseExceptions, openLeadOfPerson: openLeadOfPerson, leadAlreadyInHouse: leadAlreadyInHouse, globalSearch: globalSearch, nameKey: nameKey, dischargePatientId: dischargePatientId, isRestoredDischarge: isRestoredDischarge, pendingDischargeAudit: pendingDischargeAudit, continuityKnown: continuityKnown, continuityRecorded: continuityRecorded, continuityBody: continuityBody, myDay: myDay, weekPlan: weekPlan, WAIT_REASONS: WAIT_REASONS, waitReasonLabel: waitReasonLabel, waitChipText: waitChipText, flagsOf: flagsOf, patientMeetingChange: patientMeetingChange, reportOverdue: reportOverdue, meetingOutcomeLabel: meetingOutcomeLabel, managerChangeMessage: managerChangeMessage, managerWaUrl: managerWaUrl, leadFlagBody: leadFlagBody, leadFlagPendingPlan: leadFlagPendingPlan, patientChangePlan: patientChangePlan, MANAGER_REPORT_GRACE_DAYS: MANAGER_REPORT_GRACE_DAYS, EXCEPTION_CUTOFF: EXCEPTION_CUTOFF, doneInWeek: doneInWeek, lastContactText: lastContactText, hebDate: hebDate,
    KPI_PERIODS: KPI_PERIODS, kpiPeriod: kpiPeriod, occupancyToday: occupancyToday, closedDisposition: closedDisposition, leadFates: leadFates, FATES: FATES, leadConversion: leadConversion,
    managerCloseRates: managerCloseRates, managerNameOk: managerNameOk, BREAKEVEN_STORAGE_KEY: BREAKEVEN_STORAGE_KEY, BREAKEVEN_DEFAULTS: BREAKEVEN_DEFAULTS, VAT_RATE: VAT_RATE, breakevenConfig: breakevenConfig,
    breakevenReport: breakevenReport, ANOMALY_LABELS: ANOMALY_LABELS, billingAnomalies: billingAnomalies, closeLeadErrors: closeLeadErrors, CLASSIC_ONLY: CLASSIC_ONLY, fmtPct: fmtPct,
    creditRaw: creditRaw, creditEditErrors: creditEditErrors, creditEditBody: creditEditBody, creditNewErrors: creditNewErrors, creditNewBody: creditNewBody, creditSaveRefusal: creditSaveRefusal,
    newTaskErrors: newTaskErrors, dueSoonTasks: dueSoonTasks, TASK_REMIND_MINUTES: TASK_REMIND_MINUTES, WORK_CONTROL: WORK_CONTROL, workControlQueues: workControlQueues,
    moneyParse: moneyParse, discountErrors: discountErrors, discountBody: discountBody, cleanupCandidates: cleanupCandidates, cleanupPlan: cleanupPlan, cleanupBody: cleanupBody, CLEANUP_REASONS: CLEANUP_REASONS, paidWithDiscountPlan: paidWithDiscountPlan, paidWithDiscountBody: paidWithDiscountBody, reportValuesOnly: reportValuesOnly, cashForecast: cashForecast, cycleOnDay: cycleOnDay, cycleCtx: cycleCtx, forecastPreset: forecastPreset, monthEndIso: monthEndIso, FORECAST_TERMS_DAYS: FORECAST_TERMS_DAYS, FORECAST_INSTITUTIONAL: FORECAST_INSTITUTIONAL, overrideErrors: overrideErrors, overrideBody: overrideBody, settleErrors: settleErrors, settleBody: settleBody, writeRefusal: writeRefusal };
}));
