'use strict';
/* CHANGELOG-crm-meeting-notify.md (Part A) — when a meeting is scheduled with a lead,
 * the CRM offers a ready WhatsApp «זימון» to the manager it was scheduled with, the same
 * tap-to-send pattern as the cancel/reschedule notice. Pure rules + wiring here. SYNTHETIC. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const core = require('../public/crm/crm.js');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'crm', 'crm.js'), 'utf8');

test('the «זימון» message names the lead, house, date/time and contact', () => {
  assert.equal(core.managerScheduledMessage({ name: 'נעמי ליגי', house: 'arfoni', visitDate: '2026-11-25', visitTime: '10:00', contactName: 'שירי', contactPhone: '0544668861' }),
    'זימון לפגישה — נעמי ליגי (קיסריה עפרוני): נקבעה פגישה איתך ל-25/11/2026 בשעה 10:00.\nאיש קשר: שירי · 0544668861');
  // no time, no contact
  assert.equal(core.managerScheduledMessage({ name: 'גל רון', house: 'ramot', visitDate: '2026-12-01' }),
    'זימון לפגישה — גל רון (רמות השבים): נקבעה פגישה איתך ל-01/12/2026.');
  // a note is appended
  assert.match(core.managerScheduledMessage({ name: 'ד', visitDate: '2026-12-01', note: 'דחוף' }), /\nהערה: דחוף$/);
});

test('the WhatsApp url carries the manager phone (digits) and the url-encoded message', () => {
  const url = core.managerWaUrl('054-123 4567', 'שלום מנהל');
  assert.ok(url.indexOf('https://wa.me/0541234567?text=') === 0);
  assert.equal(decodeURIComponent(url.split('text=')[1]), 'שלום מנהל');
  // no valid phone → the sender picks the chat (empty number), still a working wa.me link
  assert.ok(core.managerWaUrl('', 'x').indexOf('https://wa.me/?text=') === 0);
});

test('the link shows only for a dated meeting with a real manager; the meeting form renders it', () => {
  // the render guard + the link builder
  assert.match(SRC, /function managerScheduledLink\(l\) \{/);
  const fn = SRC.slice(SRC.indexOf('function managerScheduledLink'), SRC.indexOf('function setSaveState'));
  assert.match(fn, /s\(l\.stage\) !== 'visit' \|\| !s\(l\.visitDate\)\) return '';/);
  assert.match(fn, /who === MEETING_WITH_AMBULATORY\) return '';/, 'no invite for an ambulatory meeting');
  assert.match(fn, /managerWaUrl\(phones\[who\] \|\| '', managerScheduledMessage\(l\)\)/);
  // rendered inside «תיאום פגישה», tap-to-send
  assert.match(SRC, /data-manager-invite="' \+ esc\(l\.id\)[\s\S]*זימון ל' \+ esc\(l\.meetingWith\)[\s\S]*שליחה בוואטסאפ<\/a>/);
});
