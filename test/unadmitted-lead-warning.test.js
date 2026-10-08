/* «לא נקלט כמטופל · N ימים» — a paid / entering lead with no patient record.
 * CHANGELOG-unadmitted-lead-warning.md.
 *
 * Locked here:
 *   1. The rule: paid (stage, advance or a recorded payment) or entering
 *      treatment (meetingOutcome «נכנסים לטיפול»), entryDate 3+ days ago in
 *      Asia/Jerusalem, and no matching Patients row. No entryDate, closed,
 *      irrelevant, removed and admitted leads are never flagged.
 *   2. PARITY: the lead → patient match is reconciliationReportNow's §A rule.
 *      unadmittedLeadPatient (app.js) and recLeadPatient_ (Code.gs) run side
 *      by side on the same fixtures and must agree on every one.
 *   3. Ambiguous → not flagged, logged once.
 *   4. The chip is escaped; the tab badge counts board leads only.
 *   5. Display only: Code.gs is untouched and no new action is sent.
 *   6. Mutation checks: each deliberate break of the helper is caught.
 * All names, ids and phone numbers are SYNTHETIC. */

// The device clock is UTC on purpose: "today" must come from Asia/Jerusalem,
// never from the device's zone.
process.env.TZ = 'UTC';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const APP_SRC = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const GS_SRC = fs.readFileSync(path.join(ROOT, 'apps-script', 'Code.gs'), 'utf8');
const INDEX_SRC = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const CSS_SRC = fs.readFileSync(path.join(ROOT, 'public', 'style.css'), 'utf8');
const SW_SRC = fs.readFileSync(path.join(ROOT, 'public', 'sw.js'), 'utf8');

function loadApp(src) {
  const noop = () => {};
  const warns = [];
  const sandbox = {
    console: { log: noop, warn: (...a) => warns.push(a), error: noop, info: noop },
    location: { origin: 'http://test', href: 'http://test/' },
    document: { addEventListener: noop, getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    URLSearchParams, Intl, Math, Date, JSON, Number, String, Array, Object, RegExp, Set, Map,
    isNaN, isFinite, parseInt, parseFloat, Promise,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext((src || APP_SRC) + `
    globalThis.__app = {
      unadmittedLeadDays, unadmittedLeadPatient, unadmittedLeadEligible, unadmittedPhoneKey,
      unadmittedHouseId, unadmittedChipHTML, countUnadmittedLeads, renderUnadmittedLeadsBadge,
      debtAgingTodayIso, normalizeLead, normalizePatient, normalizePayment, UNADMITTED_AFTER_DAYS,
      setState: (s) => { Object.assign(state, s); },
      setDocument: (d) => { document = d; },
    };`, sandbox);
  sandbox.__app.warns = warns;
  return sandbox.__app;
}

function loadGs() {
  const sandbox = {
    console: { log() {}, warn() {}, error() {}, info() {} },
    JSON, Math, Date, Number, String, Array, Object, RegExp, isFinite, isNaN,
    Logger: { log() {} },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(GS_SRC + `
    globalThis.__gs = { recLeadPatient_, recLead_, recPatient_, diagPhoneKey_, diagClientHouseId_ };`, sandbox);
  return sandbox.__gs;
}

const app = loadApp();
const plain = (v) => JSON.parse(JSON.stringify(v));
const TODAY = '2026-10-07';
const RLM = String.fromCharCode(0x200f);
const NBSP = String.fromCharCode(0x00a0);

const lead = (f) => app.normalizeLead(Object.assign({ id: 'L-1', name: 'דנה ישראלי', phone: '050-1234567',
  house: 'רמות השבים', stage: 'paid', entryDate: '2026-10-04' }, f));
const patient = (f) => app.normalizePatient(Object.assign({ id: 'P-1', houseId: 'ramot', name: 'אחר כלשהו',
  date: '2026-10-04', status: 'active', fromLead: '' }, f));
const days = (l, pats, pays, today, all) => app.unadmittedLeadDays(l, pats || [], pays || [], today || TODAY, all);

/* ---------- 1. the rule ---------- */

test('paid vs stage: a paid lead, an advance, a recorded payment and «נכנסים לטיפול» are flagged; a plain visit lead is not', () => {
  assert.equal(days(lead({ stage: 'paid' })), 3, 'stage בטיפול פעיל (paid)');
  assert.equal(days(lead({ stage: 'מקדמה שולמה' })), 3, 'the Hebrew alias normalizes to paid');
  assert.equal(days(lead({ stage: 'visit', advance: 2000 })), 3, 'an advance on a visit-stage lead');
  assert.equal(days(lead({ stage: 'visit', meetingOutcome: 'entered' })), 3, 'meetingOutcome entered');
  assert.equal(days(lead({ stage: 'waitlist', meetingOutcome: 'נכנסים לטיפול' })), 3, 'the label as stored text');
  assert.equal(days(lead({ stage: 'visit' })), null, 'neither paid nor entering');
  assert.equal(days(lead({ stage: 'new', advance: 0 })), null, 'a zero advance is not a payment');
  assert.equal(days(lead({ stage: 'visit', meetingOutcome: 'thinking' })), null, 'another outcome');

  // A payment recorded under the lead's own house::name::entryDate counts…
  const pay = (f) => app.normalizePayment(Object.assign({ id: 'pay-1', patientId: 'ramot::דנה ישראלי::2026-10-04',
    houseId: 'ramot', patientName: 'דנה ישראלי', dueDate: '2026-10-04', amount: 9000, amountPaid: 9000, status: 'paid' }, f));
  assert.equal(days(lead({ stage: 'visit' }), [], [pay()]), 3, 'a paid payment row');
  assert.equal(days(lead({ stage: 'visit' }), [], [pay({ patientId: 'ramot::דנה' + NBSP + 'ישראלי ::2026-10-04' })]), 3,
    'through the same name reduction the payment matcher uses');
  // …but not a void one, an unpaid one, or one for somebody else.
  assert.equal(days(lead({ stage: 'visit' }), [], [pay({ status: 'void' })]), null, 'a voided duplicate');
  assert.equal(days(lead({ stage: 'visit' }), [], [pay({ amountPaid: 0, status: 'unpaid' })]), null, 'nothing paid');
  assert.equal(days(lead({ stage: 'visit' }), [], [pay({ patientId: 'ramot::מישהו אחר::2026-10-04' })]), null, 'another person');
});

test('day 2 vs day 3: flagged from the 3rd day after entryDate, by the Asia/Jerusalem calendar', () => {
  assert.equal(app.UNADMITTED_AFTER_DAYS, 3);
  const l = lead({ entryDate: '2026-10-04' });
  assert.equal(days(l, [], [], '2026-10-05'), null, 'day 1');
  assert.equal(days(l, [], [], '2026-10-06'), null, 'day 2 — not yet');
  assert.equal(days(l, [], [], '2026-10-07'), 3, 'day 3 — flagged');
  assert.equal(days(l, [], [], '2026-10-20'), 16);
  assert.equal(days(l, [], [], '2026-10-04'), null, 'the entry day itself');
  assert.equal(days(lead({ entryDate: '2026-10-10' })), null, 'a future entry date');

  // The device clock here is UTC. 20:59Z on Oct 6 is 23:59 in Israel (day 2);
  // 21:00Z is already 00:00 on Oct 7 in Israel (day 3), still Oct 6 in UTC.
  const before = app.debtAgingTodayIso(new Date('2026-10-06T20:59:00Z'));
  const after = app.debtAgingTodayIso(new Date('2026-10-06T21:00:00Z'));
  assert.equal(before, '2026-10-06');
  assert.equal(after, '2026-10-07');
  assert.equal(new Date('2026-10-06T21:00:00Z').getDate(), 6, 'the device (UTC) still says the 6th');
  assert.equal(days(l, [], [], before), null);
  assert.equal(days(l, [], [], after), 3);
  // Across the end of DST (Oct 25, 2026) the count stays whole days.
  assert.equal(days(lead({ entryDate: '2026-10-24' }), [], [], '2026-10-27'), 3);
});

test('no entryDate is never flagged', () => {
  assert.equal(days(lead({ entryDate: '' })), null);
  assert.equal(days(lead({ entryDate: undefined })), null);
  assert.equal(days(lead({ entryDate: 'לא ידוע' })), null, 'unparseable text');
});

test('excluded: irrelevant, closed (disposition), removed and admitted leads', () => {
  assert.equal(days(lead({ stage: 'irrelevant' })), null);
  assert.equal(days(Object.assign(lead(), { disposition: 'released_outpatient' })), null, 'released to outpatient');
  assert.equal(days(Object.assign(lead(), { disposition: 'completed' })), null, 'closed');
  assert.equal(days(Object.assign(lead(), { removedAt: '2026-10-05' })), null, 'removed');
  assert.equal(days(lead({ stage: 'admitted' })), null, 'admitted — not on the board');
  assert.equal(days(Object.assign(lead(), { stage: 'irrelevant', meetingOutcome: 'entered' })), null,
    'an outcome does not bring a closed lead back');
});

test('matched vs unmatched: fromLead, then phone, then name + house', () => {
  const l = lead();
  assert.equal(days(l, []), 3, 'no patients at all → flagged');
  assert.equal(days(l, [patient({ name: 'אחר כלשהו' })]), 3, 'unrelated patient → flagged');
  assert.equal(days(l, [patient({ fromLead: 'L-1', name: 'שם אחר לגמרי', houseId: 'asher' })]), null,
    'fromLead wins whatever the name or house');
  assert.equal(days(l, [patient({ status: 'released', fromLead: 'L-1' })]), null, 'a released patient still counts');

  // Phone: the patient's phone is the phone of the lead it came from.
  const src = lead({ id: 'L-old', phone: '+972 50 123 4567', stage: 'admitted' });
  const p = patient({ fromLead: 'L-old', name: 'שם אחר', houseId: 'asher' });
  assert.equal(days(l, [p], [], TODAY, [l, src]), null, '050-1234567 ≡ +972 50 123 4567');
  assert.equal(days(l, [p], [], TODAY, [l]), 3, 'source lead unknown → no phone to compare');
  assert.equal(days(lead({ phone: '123' }), [p], [], TODAY, [src]), 3, 'too short to be a phone');

  // Name + house, through the matching reduction.
  assert.equal(days(l, [patient({ name: ' דנה' + NBSP + 'ישראלי' + RLM })]), null, 'same name, NBSP / RLM / padding');
  assert.equal(days(lead({ house: 'ramot' }), [patient({ name: 'דנה ישראלי' })]), null, 'the house id on the lead');
  assert.equal(days(l, [patient({ name: 'דנה ישראלי', houseId: 'asher' })]), 3, 'same name, another house');
  assert.equal(days(lead({ house: '' }), [patient({ name: 'דנה ישראלי' })]), 3, 'no house → no name tier (as §A)');
});

test('ambiguous: two rows in the deciding tier → not flagged, logged once', () => {
  const fresh = loadApp();
  const l = fresh.normalizeLead({ id: 'L-9', name: 'רון כהן', phone: '', house: 'רמות השבים', stage: 'paid', entryDate: '2026-10-01' });
  const twins = [
    fresh.normalizePatient({ id: 'P-a', houseId: 'ramot', name: 'רון כהן', date: '2026-10-01' }),
    fresh.normalizePatient({ id: 'P-b', houseId: 'ramot', name: 'רון כהן', date: '2026-09-01' }),
  ];
  const m = fresh.unadmittedLeadPatient(l, twins, [l]);
  assert.equal(m.ambiguous, true);
  assert.equal(m.via, 'name_house');
  assert.equal(fresh.unadmittedLeadDays(l, twins, [], TODAY, [l]), null);
  assert.equal(fresh.unadmittedLeadDays(l, twins, [], TODAY, [l]), null);
  const lines = fresh.warns.filter((w) => /ambiguous/.test(String(w[0])));
  assert.equal(lines.length, 1, 'once per lead, not once per render');
  assert.deepEqual(plain(lines[0][1]), { leadId: 'L-9', via: 'name_house' });
  // A single match is not ambiguous and logs nothing.
  assert.equal(fresh.unadmittedLeadPatient(l, [twins[0]], [l]).ambiguous, false);
});

test('never fail open: patients not loaded → not flagged', () => {
  assert.equal(app.unadmittedLeadDays(lead(), undefined, [], TODAY, []), null);
  assert.equal(app.unadmittedLeadDays(lead(), null, [], TODAY, []), null);
  assert.equal(app.unadmittedLeadDays(lead(), [], [], '', []), null, 'no today');
  assert.equal(app.unadmittedLeadDays(null, [], [], TODAY, []), null);
});

/* ---------- 2. parity with Code.gs recLeadPatient_ (report §A) ---------- */

test('PARITY: the phone key and house id are Code.gs diagPhoneKey_ / diagClientHouseId_', () => {
  const gs = loadGs();
  ['050-1234567', '0501234567', '+972-50-123-4567', '972501234567', '501234567', '02-6234567', '26234567',
    '123', '', null, undefined, 'abc', '00972501234567', '050 123 45 67', '0501234567890']
    .forEach((v) => assert.equal(app.unadmittedPhoneKey(v), gs.diagPhoneKey_(v), JSON.stringify(v)));
  ['ramot', 'רמות השבים', 'RAMOT', ' asher ', 'רעננה אשר', 'בית לא קיים', '', null, undefined, 'Sde']
    .forEach((v) => assert.equal(app.unadmittedHouseId(v), gs.diagClientHouseId_(v), JSON.stringify(v)));
});

test('PARITY: unadmittedLeadPatient and recLeadPatient_ agree on every fixture', () => {
  const gs = loadGs();
  const leads = [
    { id: 'A', name: 'אבי כהן', phone: '050-111-0001', house: 'רמות השבים' },
    { id: 'B', name: 'בני לוי', phone: '0501110002', house: 'רעננה אשר' },
    { id: 'C', name: 'גילה  מור' + RLM, phone: '', house: 'asher' },
    { id: 'D', name: 'דוד שקד', phone: '+972 50 111 0004', house: '' },
    { id: 'E', name: 'הדר', phone: '501110005', house: 'בית לא קיים' },
    { id: 'F', name: 'ורד', phone: '12', house: 'sde' },
    { id: 'G', name: 'זיו', phone: '050-111-0007', house: 'pardes' },
    { id: '', name: 'ללא מזהה', phone: '', house: 'rehab' },
  ];
  const oldLeads = [
    { id: 'old-1', name: 'מקור', phone: '972501110002', house: 'asher' },
    { id: 'old-2', name: 'מקור 2', phone: '050-111-0007', house: 'pardes' },
    { id: 'old-3', name: 'מקור 3', phone: '050-111-0007', house: 'pardes' },
  ];
  const patients = [
    { id: 'p1', houseId: 'ramot', name: 'שם אחר', fromLead: 'A' },
    { id: 'p2', houseId: 'arfoni', name: 'ב.ל.', fromLead: 'old-1' },
    { id: 'p3', houseId: 'asher', name: 'גילה מור', fromLead: '' },
    { id: 'p4', houseId: 'sde', name: 'ורד', fromLead: ' ' },
    { id: 'p5', houseId: 'pardes', name: 'x', fromLead: 'old-2' },
    { id: 'p6', houseId: 'pardes', name: 'y', fromLead: 'old-3' },
    { id: 'p7', houseId: 'rehab', name: 'ללא מזהה', fromLead: '' },
    { id: 'p8', houseId: 'ramot', name: 'שם אחר 2', fromLead: 'A' },
  ];
  const allLeads = leads.concat(oldLeads);
  // Code.gs side: the report's own row builders and model shape.
  const row = (obj, i) => ({ obj, rowNumber: i + 2 });
  const gsLeads = allLeads.map((l, i) => gs.recLead_(row(l, i), 'Leads'));
  const leadById = {};
  gsLeads.forEach((l) => { if (l.id && !(l.id in leadById)) leadById[l.id] = l; });
  const m = { patients: patients.map((p, i) => gs.recPatient_(row(p, i), 'Patients')), leadById };
  // app.js side: the same rows through the app's normalizers.
  const appLeads = allLeads.map((l) => app.normalizeLead(l));
  appLeads.forEach((l, i) => { if (!allLeads[i].id) l.id = ''; });   // normalizeLead mints an id for a blank one
  const appPatients = patients.map((p) => app.normalizePatient(p));

  const outcomes = [];
  leads.forEach((l, i) => {
    const g = gs.recLeadPatient_(gsLeads[i], m);
    const a = app.unadmittedLeadPatient(appLeads[i], appPatients, appLeads);
    const gv = g ? { id: g.patient.id, via: g.via } : null;
    const av = a ? { id: a.patient.id, via: a.via } : null;
    assert.deepEqual(av, gv, 'lead ' + JSON.stringify(l.name));
    outcomes.push(av ? av.via : 'none');
  });
  // The fixtures exercise every tier, a miss, and a multi-row tier.
  assert.deepEqual(outcomes, ['fromLead', 'phone', 'name_house', 'none', 'none', 'name_house', 'phone', 'name_house']);
  assert.equal(app.unadmittedLeadPatient(appLeads[0], appPatients, appLeads).ambiguous, true, 'A: two fromLead rows');
  assert.equal(app.unadmittedLeadPatient(appLeads[6], appPatients, appLeads).ambiguous, true, 'G: two rows by phone');
});

/* ---------- 3. the chip and the badge ---------- */

test('the chip text, and it is escaped', () => {
  assert.equal(app.unadmittedChipHTML(null), '');
  assert.equal(app.unadmittedChipHTML(undefined), '');
  assert.equal(app.unadmittedChipHTML(5), '<div class="lc-unadmitted">לא נקלט כמטופל · 5 ימים</div>');
  const evil = app.unadmittedChipHTML('<img src=x onerror=alert(1)>"\'&');
  assert.ok(!evil.includes('<img'), evil);
  assert.ok(evil.includes('&lt;img src=x onerror=alert(1)&gt;&quot;&#39;&amp;'), evil);
});

test('the badge counts board leads only, whatever the search box says', () => {
  // Each lead its own phone: a shared one would (rightly) match them all by
  // the phone tier through L-matched's patient.
  const pats = [patient({ fromLead: 'L-matched' })];
  let n = 0;
  const lead = (f) => app.normalizeLead(Object.assign({ name: 'ליד ' + n, phone: '05011100' + String(10 + n++),
    house: 'רמות השבים', stage: 'paid', entryDate: '2026-10-04' }, f));
  const board = [
    lead({ id: 'L-1' }),                                                   // flagged
    lead({ id: 'L-2', stage: 'waitlist', advance: 1000 }),                // flagged
    lead({ id: 'L-3', stage: 'visit', meetingOutcome: 'entered' }),       // flagged
    lead({ id: 'L-matched' }),                                            // has a patient
    lead({ id: 'L-day2', entryDate: '2026-10-05' }),                      // only day 2
    lead({ id: 'L-nodate', entryDate: '' }),                              // no entryDate
    lead({ id: 'L-admitted', stage: 'admitted' }),                        // not on the board
    lead({ id: 'L-new', stage: 'new' }),                                  // not paid
  ];
  assert.equal(app.countUnadmittedLeads(board, pats, [], TODAY, board), 3);
  assert.equal(app.countUnadmittedLeads([], pats, [], TODAY, []), 0);
  assert.equal(app.countUnadmittedLeads(undefined, pats, [], TODAY, []), 0);
  assert.equal(app.countUnadmittedLeads(board, undefined, [], TODAY, board), 0, 'patients not loaded → 0');

  // renderUnadmittedLeadsBadge writes the number and hides itself at zero.
  const fresh = loadApp();
  const el = { textContent: '', hidden: true, classList: { toggle(c, on) { if (c === 'hidden') el.hidden = on; } } };
  fresh.setDocument({ getElementById: (id) => (id === 'leads-unadmitted-badge' ? el : null), addEventListener() {}, querySelector: () => null, querySelectorAll: () => [] });
  fresh.setState({ leads: [fresh.normalizeLead({ id: 'x', name: 'א', stage: 'paid', entryDate: '2000-01-01', house: 'ramot' })],
    patients: [], payments: [], irrelevantLeads: [], removedLeads: [] });
  fresh.renderUnadmittedLeadsBadge();
  assert.equal(el.textContent, '1');
  assert.equal(el.hidden, false);
  fresh.setState({ patients: [fresh.normalizePatient({ houseId: 'ramot', name: 'א', fromLead: 'x' })] });
  fresh.renderUnadmittedLeadsBadge();
  assert.equal(el.textContent, '0');
  assert.equal(el.hidden, true);
});

/* ---------- 4. wiring and scope ---------- */

test('wiring: card chip, tab badge, CSS, SW v42 — and nothing new on the server side', () => {
  assert.match(APP_SRC, /\$\{unadmittedChipHTML\(unadmittedDaysForLead\(lead\)\)\}/, 'buildLeadCard renders the chip');
  assert.match(APP_SRC, /kanban\.appendChild\(col\);\n  \}\);\n  renderUnadmittedLeadsBadge\(\);\n\}/, 'renderKanban updates the badge');
  assert.match(APP_SRC, /unadmittedLeadDays\(lead, state\.patients, state\.payments \|\| \[\], debtAgingTodayIso\(\), allLeads\)/,
    'the card uses Asia/Jerusalem today');
  assert.match(INDEX_SRC, /data-screen="leads">לידים<span id="leads-unadmitted-badge" class="tab-badge tab-badge-danger hidden"/);
  assert.match(CSS_SRC, /\.lead-card \.lc-unadmitted \{[^}]*color: var\(--danger\)/);
  assert.match(CSS_SRC, /\.tab-badge\.tab-badge-danger \{/);
  const v = Number(/var CACHE_VERSION = 'v(\d+)';/.exec(SW_SRC)[1]);
  assert.ok(v >= 42 && v !== 17, 'v' + v);
  // Display only: Code.gs never heard of it, and the helper block sends nothing.
  assert.ok(!/unadmitted/i.test(GS_SRC), 'no Code.gs change');
  const block = APP_SRC.slice(APP_SRC.indexOf('const UNADMITTED_AFTER_DAYS'), APP_SRC.indexOf('function buildLeadCard('));
  assert.ok(block.length > 1000);
  assert.ok(!/apiPost|fetch\(|saveAll|updateLead|localStorage/.test(block), 'no write, no fetch');
  // The controller view (Ortal) returns before renderKanban — left untouched.
  const renderAll = APP_SRC.slice(APP_SRC.indexOf('function renderAll() {'), APP_SRC.indexOf('renderKanban();', APP_SRC.indexOf('function renderAll() {')));
  assert.match(renderAll, /if \(controllerView\(\)\) \{[\s\S]*?return;\n  \}/);
});

/* ---------- 5. mutation checks ---------- */

/* The core assertions as one function returning failures, so a mutated
 * app.js can be shown to FAIL them. */
function coreFailures(a) {
  const fails = [];
  const L = (f) => a.normalizeLead(Object.assign({ id: 'L-1', name: 'דנה ישראלי', phone: '050-1234567',
    house: 'רמות השבים', stage: 'paid', entryDate: '2026-10-04' }, f));
  const P = (f) => a.normalizePatient(Object.assign({ houseId: 'ramot', name: 'אחר', date: '2026-10-04' }, f));
  const d = (l, pats, today) => a.unadmittedLeadDays(l, pats || [], [], today || TODAY, [l]);
  const check = (cond, label) => { if (!cond) fails.push(label); };
  check(d(L(), [], '2026-10-06') === null, 'day 2 is not flagged');
  check(d(L(), [], '2026-10-07') === 3, 'day 3 is flagged');
  check(d(L({ phone: '' }), [P({ fromLead: 'L-1', name: 'x', houseId: 'asher' })]) === null, 'fromLead match');
  check(d(L(), [P({ name: 'דנה ישראלי' })]) === null, 'name + house match');
  check(d(L({ stage: 'irrelevant', advance: 500 })) === null, 'irrelevant excluded');
  check(d(L({ entryDate: '' })) === null, 'no entryDate');
  check(d(L({ stage: 'visit' })) === null, 'a plain visit lead');
  check(d(L(), [P({ name: 'דנה ישראלי' }), P({ name: 'דנה ישראלי', date: '2026-01-01' })]) === null, 'ambiguous');
  check(!a.unadmittedChipHTML('<b>').includes('<b>'), 'chip escaped');
  return fails;
}

const MUTANTS = [
  ['threshold 3 → 2', 'const UNADMITTED_AFTER_DAYS = 3;', 'const UNADMITTED_AFTER_DAYS = 2;'],
  ['fromLead tier removed', "if (byLead.length) return found(byLead, 'fromLead');", ''],
  ['name + house tier removed', "if (byName.length) return found(byName, 'name_house');", ''],
  ['ambiguous fails open', "if (match) {\n    if (match.ambiguous", "if (match && !match.ambiguous) {\n    if (match.ambiguous"],
  ['irrelevant not excluded', "if (lead.stage === 'irrelevant' || lead.stage === 'admitted') return false;", "if (lead.stage === 'admitted') return false;"],
  ['no-entryDate guard removed', "if (!entry || !today) return null;", "if (!today) return null;\n  if (!entry) return 999;"],
  ['visit leads become eligible', "if (lead.stage === 'paid') return true;", "if (lead.stage === 'paid' || lead.stage === 'visit') return true;"],
  ['chip not escaped', "return `<div class=\"lc-unadmitted\">${escapeHtml(`לא נקלט כמטופל · ${days} ימים`)}</div>`;",
    "return `<div class=\"lc-unadmitted\">לא נקלט כמטופל · ${days} ימים</div>`;"],
];

test('the unmutated helper passes every core check', () => {
  assert.deepEqual(coreFailures(app), []);
});

MUTANTS.forEach(([name, from, to]) => {
  test('mutation is caught: ' + name, () => {
    assert.ok(APP_SRC.includes(from), 'the mutation target still exists: ' + from);
    const mutated = loadApp(APP_SRC.replace(from, to));
    assert.ok(coreFailures(mutated).length > 0, 'the mutant "' + name + '" survived');
  });
});
