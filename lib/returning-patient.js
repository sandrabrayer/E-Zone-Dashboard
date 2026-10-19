/* «מטופל חוזר» — returning-patient matching (CHANGELOG-returning-patient.md).
 *
 * PURE: no DOM, no I/O, no logging. The page loads it before app.js
 * (window.ReturningPatient); node --test requires it.
 *
 * THE PERSON. A person is every record that belongs to one human, joined by
 * ids only (never guessed):
 *   - Patients rows: one person per `personId || id` — a returning stay
 *     carries the root patient id of its first stay in `personId`;
 *   - discharged-audit rows: joined to the Patients row they discharged
 *     (`patientId`, else the stay key houseId + name + entry date);
 *     otherwise their own person, one per stay;
 *   - closed leads (לידים לא רלוונטיים): joined to the person whose stay has
 *     `fromLead` = the lead id; otherwise their own person.
 * A person with an ACTIVE stay (any Patients row not released) cannot
 * "return" and is never offered.
 *
 * THE MATCH (fail closed):
 *   - by phone first: a person any of whose phones (discharge row, linked
 *     lead, closed lead) normalizes to the typed phone. With a typed name
 *     that matches none of that person's names, the match is a CONFLICT
 *     (same phone, different name — a family member?) → manual pick.
 *   - else by name: the full name, whitespace-collapsed, case-folded.
 *   - exactly one → 'unique'; none → 'none'; several → 'multiple'.
 *   Only 'unique' may be linked without a manual pick; 'none' / 'multiple' /
 *   'conflict' offer candidates to pick from, never an automatic link. */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ReturningPatient = api;
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SUGGESTION_CAP = 10;
  const text = (v) => String(v == null ? '' : v).trim();
  const nameKey = (v) => text(v).replace(/\s+/g, ' ').toLowerCase();
  const day = (v) => { const s = text(v).slice(0, 10); return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : ''; };
  const restoredFlag = (v) => v === true || text(v).toUpperCase() === 'TRUE';

  /* Any phone → local '0XXXXXXXX(X)' (9–10 digits; a 9-digit mobile that
   * lost its leading zero is restored), '' when not a phone. */
  function phoneKey(raw) {
    let d = String(raw == null ? '' : raw).replace(/\D/g, '');
    if (d.indexOf('00972') === 0) d = d.slice(2);
    if (d.indexOf('972') === 0) d = '0' + d.slice(3);
    if (/^5\d{8}$/.test(d)) d = '0' + d;
    return /^0\d{8,9}$/.test(d) ? d : '';
  }
  function stayKey(houseId, name, date) {
    const h = text(houseId), n = nameKey(name);
    return h && n ? h + '::' + n + '::' + day(date) : '';
  }

  /* All persons from the page's lists. → [person], each:
   *   { key, rootId, names: [..], phones: [..], active,
   *     patientIds: [..], stays: [..], discharges: [..], closedLeads: [..] } */
  function buildPersons(opts) {
    const o = opts || {};
    const patients = (Array.isArray(o.patients) ? o.patients : []).filter((p) => p && typeof p === 'object');
    const discharged = (Array.isArray(o.dischargedPatients) ? o.dischargedPatients : []).filter((d) => d && typeof d === 'object' && !text(d.deletedAt));
    const closed = (Array.isArray(o.irrelevantLeads) ? o.irrelevantLeads : []).filter((l) => l && typeof l === 'object');
    const leadsById = {};
    [].concat(Array.isArray(o.leads) ? o.leads : [], closed, Array.isArray(o.removedLeads) ? o.removedLeads : [])
      .forEach((l) => { const id = text(l && l.id); if (id && !leadsById[id]) leadsById[id] = l; });

    const persons = {};
    const order = [];
    const get = (key) => {
      if (!persons[key]) {
        persons[key] = { key, rootId: '', names: [], phones: [], active: false, patientIds: [], stays: [], discharges: [], closedLeads: [], leadIds: [] };
        order.push(key);
      }
      return persons[key];
    };
    const addName = (P, n) => { const k = nameKey(n); if (k && P.names.indexOf(k) < 0) P.names.push(k); };
    const addPhone = (P, ph) => { const k = phoneKey(ph); if (k && P.phones.indexOf(k) < 0) P.phones.push(k); };
    const addLeadLink = (P, leadId) => {
      const id = text(leadId);
      if (!id) return;
      if (P.leadIds.indexOf(id) < 0) P.leadIds.push(id);
      if (leadsById[id]) addPhone(P, leadsById[id].phone);
    };

    const byId = {};
    const byStay = {};
    const personOfLead = {};
    patients.forEach((p) => {
      const id = text(p.id);
      const rootId = text(p.personId) || id;
      if (!rootId) return;
      const P = get('p:' + rootId);
      P.rootId = rootId;
      if (id) { byId[id] = P; if (P.patientIds.indexOf(id) < 0) P.patientIds.push(id); }
      const sk = stayKey(p.houseId, p.name, p.date);
      if (sk && !byStay[sk]) byStay[sk] = P;
      if (text(p.status) !== 'released') P.active = true;
      addName(P, p.name);
      addLeadLink(P, p.fromLead);
      if (text(p.fromLead)) personOfLead[text(p.fromLead)] = P;
      P.stays.push({ patientId: id, houseId: text(p.houseId), name: text(p.name), date: day(p.date),
        exitDate: day(p.exitDate), status: text(p.status), pay: Number(p.pay) || 0, notes: text(p.notes), fromLead: text(p.fromLead) });
    });
    discharged.forEach((d) => {
      const sk = stayKey(d.houseId, d.name, d.date);
      const P = byId[text(d.patientId)] || (sk && byStay[sk]) || get('d:' + (sk || text(d.id)));
      if (sk && !byStay[sk]) byStay[sk] = P;
      addName(P, d.name);
      addPhone(P, d.phone);
      addLeadLink(P, d.fromLead);
      if (text(d.fromLead) && !personOfLead[text(d.fromLead)]) personOfLead[text(d.fromLead)] = P;
      P.discharges.push({ id: text(d.id), houseId: text(d.houseId), name: text(d.name), date: day(d.date),
        exitDate: day(d.exitDate), dischargedAt: text(d.dischargedAt), disposition: text(d.disposition),
        note: text(d.discharge_note) || text(d.dischargeReason), patientId: text(d.patientId),
        pay: Number(d.pay) || 0, open: !restoredFlag(d.restored) });
    });
    closed.forEach((l) => {
      const id = text(l.id);
      const P = (id && personOfLead[id]) || get('l:' + (id || nameKey(l.name)));
      addName(P, l.name);
      addPhone(P, l.phone);
      if (id && P.leadIds.indexOf(id) < 0) P.leadIds.push(id);
      P.closedLeads.push({ id, name: text(l.name), phone: text(l.phone), house: text(l.house),
        disposition: text(l.disposition), note: text(l.not_relevant_note), movedAt: text(l.movedAt), created: day(l.created) });
    });
    return order.map((k) => persons[k]).filter((P) => P.stays.length || P.discharges.length || P.closedLeads.length);
  }

  /* The match for a typed { name, phone } → { status, via, persons, suggestions }.
   * status: 'unique' | 'none' | 'multiple' | 'conflict'. Only 'unique' carries
   * persons[0] as THE match; the others list `suggestions` for a manual pick. */
  function findMatches(persons, query) {
    const q = query || {};
    const eligible = (Array.isArray(persons) ? persons : []).filter((P) => P && !P.active);
    const qp = phoneKey(q.phone);
    const qn = nameKey(q.name);
    const out = (status, via, list, suggestions) => ({ status, via, persons: list, suggestions: suggestions || list });
    if (qp) {
      const byPhone = eligible.filter((P) => P.phones.indexOf(qp) >= 0);
      if (byPhone.length === 1) {
        const P = byPhone[0];
        if (qn && P.names.indexOf(qn) < 0) return out('conflict', 'phone', [], byPhone);
        return out('unique', 'phone', byPhone);
      }
      if (byPhone.length > 1) return out('multiple', 'phone', [], byPhone);
    }
    if (qn) {
      const byName = eligible.filter((P) => P.names.indexOf(qn) >= 0);
      if (byName.length === 1) return out('unique', 'name', byName);
      if (byName.length > 1) return out('multiple', 'name', [], byName);
    }
    return out('none', '', [], suggest(eligible, qn, qp));
  }

  /* Loose candidates for a manual pick when nothing matched: any name token
   * in common, or the same last 7 phone digits. Capped. */
  function suggest(eligible, qn, qp) {
    const tokens = qn ? qn.split(' ').filter((t) => t.length >= 2) : [];
    const tail = qp ? qp.slice(-7) : '';
    if (!tokens.length && !tail) return [];
    return eligible.filter((P) =>
      (tail && P.phones.some((ph) => ph.slice(-7) === tail)) ||
      (tokens.length && P.names.some((n) => n.split(' ').some((t) => tokens.indexOf(t) >= 0)))).slice(0, SUGGESTION_CAP);
  }

  /* The person's history, newest first: one entry per stay (a Patients row
   * and its discharge rows merged by stay key), then the closed leads. */
  function history(P) {
    if (!P) return { stays: [], closedLeads: [] };
    const stays = {};
    const keyOf = (s) => stayKey(s.houseId, s.name, s.date) || ('id:' + (s.patientId || s.id));
    P.stays.forEach((s) => { stays[keyOf(s)] = Object.assign({ discharges: [] }, s); });
    P.discharges.forEach((d) => {
      const k = keyOf(d);
      if (!stays[k]) stays[k] = { patientId: d.patientId, houseId: d.houseId, name: d.name, date: d.date, exitDate: d.exitDate, status: 'released', pay: d.pay, notes: '', fromLead: '', discharges: [] };
      stays[k].discharges.push(d);
      if (!stays[k].exitDate && d.exitDate) stays[k].exitDate = d.exitDate;
    });
    const list = Object.keys(stays).map((k) => stays[k]).map((s) => {
      const last = s.discharges.slice().sort((a, b) => String(b.dischargedAt).localeCompare(String(a.dischargedAt)))[0];
      return Object.assign(s, { disposition: last ? last.disposition : '', dischargeNote: last ? last.note : '' });
    });
    list.sort((a, b) => String(b.date).localeCompare(String(a.date)));
    const closedLeads = P.closedLeads.slice().sort((a, b) => String(b.movedAt).localeCompare(String(a.movedAt)));
    return { stays: list, closedLeads };
  }

  /* What the add form opens with, from the person's latest stay. `fromLead`
   * is offered only for a person with no Patients row at all (a closed lead
   * only): a stay's lead must never be re-used by a second stay. */
  function prefill(P) {
    const h = history(P);
    const last = h.stays[0] || null;
    const lead = h.closedLeads[0] || null;
    return {
      name: last ? last.name : (lead ? lead.name : ''),
      phone: P && P.phones.length ? P.phones[0] : '',
      houseId: last ? last.houseId : '',
      pay: last && last.pay ? last.pay : '',
      personId: P ? P.rootId : '',
      fromLead: P && !P.rootId && lead ? lead.id : '',
      openDischargeIds: P ? P.discharges.filter((d) => d.open && d.id).map((d) => d.id) : [],
    };
  }

  return Object.freeze({ buildPersons, findMatches, history, prefill, phoneKey, nameKey, stayKey });
}));
