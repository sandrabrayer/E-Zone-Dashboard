'use strict';

const { HOUSE_NAMES } = require('./refund-forecast-xlsx');
const { israelToday, isRealIso } = require('./discharge-alerts');

function internationalPhone(raw) {
  const value = String(raw || '').trim().replace(/[\s()\-]/g, '');
  if (/^0(?:[23489]\d{7}|[57]\d{8})$/.test(value)) return '972' + value.slice(1);
  if (/^(?:\+|00)?972(?:[23489]\d{7}|[57]\d{8})$/.test(value)) return value.replace(/^(?:\+|00)/, '');
  if (/^(?:\+|00)(?!972)[1-9]\d{7,14}$/.test(value)) return value.replace(/^(?:\+|00)/, '');
  return '';
}

function configuredDirections(source, id) {
  let houses;
  try { houses = JSON.parse(source || '{}'); } catch (_) { return {}; }
  if (!houses || !Object.hasOwn(houses, id)) return {};
  const entry = houses[id];
  if (!entry || typeof entry.address !== 'string' || entry.address.length > 250 ||
      (entry.instructions != null && (typeof entry.instructions !== 'string' || entry.instructions.length > 500))) return {};
  return { address: entry.address.trim(), instructions: (entry.instructions || '').trim() };
}

function preview(lead, directions, now) {
  const id = lead.house;
  if (lead.stage !== 'visit' || lead.meetingOutcome || lead.meetingReportOutcome || lead.meetingWith === 'אמבולטורי' ||
      !Object.hasOwn(HOUSE_NAMES, id) || !isRealIso(lead.visitDate) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(lead.visitTime)) return null;
  const date = israelToday(now);
  const time = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).format(now);
  if (lead.visitDate < date || (lead.visitDate === date && lead.visitTime < time)) return null;
  const place = configuredDirections(directions, id);
  const recipients = [
    { role: 'contact', name: lead.contactName || '', phone: internationalPhone(lead.contactPhone) },
    { role: 'patient', name: lead.name || '', phone: internationalPhone(lead.phone) }
  ].filter(r => r.phone);
  return { ok: true, visit: { houseId: id, houseName: HOUSE_NAMES[id], date: lead.visitDate, time: lead.visitTime,
    address: place.address || '', instructions: place.instructions || '' }, recipients };
}

module.exports = { preview, internationalPhone };
