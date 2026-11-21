'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { loadGs, richSheet } = require('./gs-sandbox');
const SOURCE = fs.readFileSync(path.join(__dirname, '../../apps-script/CommunicationEvents.gs'), 'utf8');
const PROXY = 'synthetic-proxy-contact-intake-for-tests';
const TOKEN = 'synthetic-separate-adapter-contact-token';
const PHONE = '0500000001';
const REF = '1'.repeat(32);
const AT = new Date(Date.now() + 3600000).toISOString();

function makeDesk() {
  const g = loadGs({ props: { PROXY_SECRET: PROXY, CONTACT_EVENT_INGEST_TOKEN: TOKEN, CONTACT_EVENT_BUSINESS_NUMBER: '0500000099', CONTACT_EVENT_PBX_NUMBERS: '03-2990001, 03-2990002' } });
  g.sandbox.SpreadsheetApp.flush = () => {};
  g.sandbox.Utilities.formatDate = (d, zone) => new Intl.DateTimeFormat('sv-SE', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(d));
  g.run(SOURCE);
  g.run(fs.readFileSync(path.join(__dirname, '../../apps-script/IntakeDesk.gs'), 'utf8'));
  function addLead(data = {}, name = 'Leads') {
    const schema = name === 'Leads' ? 'LEAD_COLUMNS' : name === 'לידים לא רלוונטיים' ? 'IRRELEVANT_LEAD_COLUMNS' : 'REMOVED_LEAD_COLUMNS';
    const cols = Array.from(g.run(schema));
    const sh = g.sandbox.__sheets[name] || (g.sandbox.__sheets[name] = richSheet(name, cols));
    const obj = Object.assign({ id: 'test-card-a', name: 'פניית דוגמה א', stage: 'new', assignedTo: 'ורד', phone: PHONE, created: '2026-11-01' }, data);
    sh.appendRow(cols.map((c) => obj[c] || ''));
  }
  function receive(overrides = {}) {
    const event = Object.assign({ businessNumber: overrides.channel === 'whatsapp' ? '+972500000099' : '+97232990001', connection: overrides.channel === 'whatsapp' ? 'official_whatsapp' : 'pbx', channel: 'phone', scope: 'call', direction: 'in', objectRef: REF, status: 'missed', final: true, occurredAt: AT, observedAt: AT, phone: PHONE }, overrides);
    return g.post({ action: 'ingestCommunicationEvent', ingestToken: TOKEN, event });
  }
  function staff(action, params = {}, id = 'vered') {
    return g.post(Object.assign({ action, proxySecret: PROXY, proxyUser: id === 'vered' ? 'ורד' : id, proxyAuth: 'personal', proxyUserId: id, proxyRoles: id === 'ortal' ? ['controller'] : ['staff'] }, params));
  }
  function link(params = {}) {
    return staff('resolveCommunicationEvent', Object.assign({ id: 'phone-' + REF, decision: 'link', leadId: 'test-card-a', verifiedContact: true }, params));
  }
  return { g, addLead, receive, staff, link, rows: () => g.sheetRows('CommunicationEvents', 'COMM_COLUMNS'), tasks: () => g.sheetRows('Tasks', 'TASK_COLUMNS') };
}
module.exports = { makeDesk, PROXY, TOKEN, PHONE, REF, AT };
