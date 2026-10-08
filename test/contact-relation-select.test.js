/* Tests for «קשר למטופל» (contactRelation) becoming a dropdown with a
 * free-text escape — see CHANGELOG-contact-relation-select.md.
 *
 * The whole point of this change is that it must NOT cost any production data.
 * Column R has held free Hebrew text since PR #67, so the tests below use the
 * REAL strings observed there — אישתו · בעל · סבתא · המטופל · חברה for values
 * that are off the new list, and אמא · אבא · עו"ס for ones that are on it —
 * and assert that opening and saving a lead round-trips each of them byte for
 * byte. No migration, no normalization, no mapping of אישתו → בן/בת זוג.
 *
 * All three surfaces are driven through the REAL shipped functions:
 *   - leadContactEditHTML  — the inline card block (markup asserted directly)
 *   - openAddLeadModal     — showModal is stubbed to capture the field spec and
 *   - openEditLeadModal      to fire the real onSubmit with the values a form
 *                            would produce, so the save path is the real one.
 *
 * vm-sandbox conventions per the repo (see lead-contact-fields-foundation.test.js).
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const noop = () => {};

/* Values built inside the vm sandbox carry ITS Object/Array prototypes, so
 * deepStrictEqual rejects them as "same structure but not reference-equal".
 * Re-hydrate them into this realm before comparing. */
const plain = (v) => JSON.parse(JSON.stringify(v));

/* The option markup escapes its values, and one real option contains a double
 * quote (עו"ס → value="עו&quot;ס"), so a raw regex capture has to be decoded
 * before it can be compared with the constant. */
const decodeEntities = (s) => String(s)
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/* The real strings production column R is known to hold that are NOT on the new
 * list — each must survive as a pinned extra option. */
const LEGACY_OFF_LIST = ['אישתו', 'בעל', 'סבתא', 'המטופל', 'חברה'];
/* ...and ones that ARE on the list, which must select the existing option
 * instead of adding a duplicate. */
const LEGACY_ON_LIST = ['אמא', 'אבא', 'עו"ס'];

const EXPECTED_LABELS = [
  'מטופל', 'אמא', 'אבא', 'אח/אחות', 'בן/בת', 'בן/בת זוג',
  'סבא/סבתא', 'קרוב משפחה', 'חבר/חברה', 'עו"ס', 'אחר',
];

/* ---------- apps-script/Code.gs (schema guard) ---------- */
function loadCode() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8');
  const epilogue = `globalThis.__test = {
    LEAD_COLUMNS: LEAD_COLUMNS,
    corruptionScanTargets_: (typeof corruptionScanTargets_ === 'function') ? corruptionScanTargets_ : null,
  };`;
  const sandbox = {
    console: { log: noop, warn: noop, error: noop, info: noop },
    JSON, Math, Date, Number, String, Array, Object, RegExp,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src + epilogue, sandbox);
  return sandbox.__test;
}

/* ---------- public/app.js ---------- */
function loadApp() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const epilogue = `
    globalThis.__test = {
      CONTACT_RELATION_LABELS: CONTACT_RELATION_LABELS,
      CONTACT_RELATION_OTHER: CONTACT_RELATION_OTHER,
      isContactRelationPreset: (v) => isContactRelationPreset(v),
      contactRelationOptions: (v) => contactRelationOptions(v),
      contactRelationOptionsHTML: (v) => contactRelationOptionsHTML(v),
      contactRelationFields: (l) => contactRelationFields(l),
      resolveContactRelation: (a, b) => resolveContactRelation(a, b),
      contactRelationDisplay: (v) => contactRelationDisplay(v),
      leadContactEditHTML: (l) => leadContactEditHTML(l),
      normalizeLead: (l) => normalizeLead(l),

      /* Capture what a modal builder hands showModal, and expose its real
       * onSubmit so a test can submit the values a form would produce. */
      captureModal(open) {
        let spec = null;
        showModal = (s) => { spec = s; };
        open();
        return spec;
      },
      openAddLeadModal:  () => openAddLeadModal(),
      openEditLeadModal: (l) => openEditLeadModal(l),

      setState(s) { Object.assign(state, s); },
      getLeads() { return state.leads; },
      /* Silence the save/render side of the real onSubmit paths. */
      stubIO() {
        saveAll = async () => ({ ok: true });
        renderAll = () => {};
        showError = () => {};
        showToast = () => {};
      },
    };
  `;
  const sandbox = {
    console: { log: noop, warn: noop, error: noop, info: noop },
    location: { origin: 'http://test', href: 'http://test/' },
    setTimeout: () => 0, clearTimeout: noop,
    document: {
      addEventListener: noop,
      getElementById: () => null,
      querySelectorAll: () => [],
      createElement: () => ({ classList: { add: noop, remove: noop, toggle: noop, contains: () => false } }),
    },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    URLSearchParams, Math, Date, JSON, Number, String, Array, Object, RegExp, Promise, Set, Map,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src + epilogue, sandbox);
  return sandbox.__test;
}

const code = loadCode();

/* A fresh app sandbox per test — the modal paths mutate state.leads. */
function freshApp() {
  const app = loadApp();
  app.stubIO();
  app.setState({ mode: 'edit', leads: [], houseManagers: {} });
  return app;
}

/* The values a real form would submit for a captured field spec, i.e. what
 * showModal's `fd.get(f.name) || ''` collects when the user touches nothing. */
function untouchedValues(spec, overrides) {
  const values = {};
  spec.fields.forEach((f) => {
    if (!f.name) return;                       // section dividers carry no value
    values[f.name] = String(f.value === undefined || f.value === null ? '' : f.value);
  });
  return Object.assign(values, overrides || {});
}

const fieldNamed = (spec, name) => spec.fields.find((f) => f.name === name);

function leadWith(relation) {
  return {
    id: 'L1', name: 'דני', phone: '', house: 'ramot', stage: 'visit',
    visitDate: '2026-09-01', visitTime: '10:00', note: '', assignedTo: 'ורד',
    meetingWith: 'אורן', created: '2026-08-01',
    contactName: 'רותי', contactPhone: '0521111111',
    contactRelation: relation, billingPhone: '',
  };
}

/* ===================================================================== */
/* 1. The constant                                                        */
/* ===================================================================== */

test('CONTACT_RELATION_LABELS is the agreed list, in order, frozen', () => {
  const app = freshApp();
  assert.deepStrictEqual(Array.from(app.CONTACT_RELATION_LABELS), EXPECTED_LABELS);
  assert.strictEqual(app.CONTACT_RELATION_OTHER, 'אחר');
  assert.strictEqual(
    app.CONTACT_RELATION_LABELS[app.CONTACT_RELATION_LABELS.length - 1], 'אחר',
    'אחר must be last — it is the free-text escape');
  assert.ok(Object.isFrozen(app.CONTACT_RELATION_LABELS));
});

/* ===================================================================== */
/* 2. All three surfaces render a SELECT, not a text input                */
/* ===================================================================== */

test('inline card block renders a select for contactRelation, not a text input', () => {
  const app = freshApp();
  const html = app.leadContactEditHTML(leadWith(''));
  assert.match(html, /<select[^>]*data-field="contactRelation"/,
    'the inline field must be a select carrying data-field');
  assert.ok(!/<input[^>]*type="text"[^>]*data-field="contactRelation"/.test(html),
    'the old free-text input must be gone');
  // The data-field autosave wiring is what persists it — it must stay on the select.
  assert.match(html, /class="lc-relation"[^>]*data-field="contactRelation"|data-field="contactRelation"[^>]*class="lc-relation"/);
});

test('the add-lead modal renders contactRelation as a select', () => {
  const app = freshApp();
  const spec = app.captureModal(() => app.openAddLeadModal());
  const f = fieldNamed(spec, 'contactRelation');
  assert.ok(f, 'the add form must still carry a contactRelation field');
  assert.strictEqual(f.type, 'select');
  assert.strictEqual(f.label, 'קשר למטופל');
});

test('the edit-lead modal renders contactRelation as a select', () => {
  const app = freshApp();
  const spec = app.captureModal(() => app.openEditLeadModal(leadWith('')));
  const f = fieldNamed(spec, 'contactRelation');
  assert.ok(f);
  assert.strictEqual(f.type, 'select');
  assert.strictEqual(f.label, 'קשר למטופל');
});

test('every surface pairs the select with a hidden אחר free-text row', () => {
  const app = freshApp();
  ['add', 'edit'].forEach((which) => {
    const spec = app.captureModal(() => (which === 'add'
      ? app.openAddLeadModal()
      : app.openEditLeadModal(leadWith(''))));
    const other = fieldNamed(spec, 'contactRelationOther');
    assert.ok(other, `${which}: the אחר free-text field must exist`);
    assert.strictEqual(other.type, 'text');
    assert.strictEqual(other.hidden, true, `${which}: it starts hidden`);
  });
  const html = app.leadContactEditHTML(leadWith(''));
  assert.match(html, /class="lc-relation-other"[^>]*style="display:none"/,
    'the inline free-text input starts hidden too');
});

/* ===================================================================== */
/* 3. The option list                                                     */
/* ===================================================================== */

test('options are the blank placeholder followed by CONTACT_RELATION_LABELS in order', () => {
  const app = freshApp();
  const opts = app.contactRelationOptions('');
  assert.strictEqual(opts[0].value, '', 'the first option is the empty placeholder');
  assert.deepStrictEqual(plain(opts.slice(1).map((o) => o.value)), EXPECTED_LABELS);
  assert.deepStrictEqual(plain(opts.slice(1).map((o) => o.label)), EXPECTED_LABELS,
    'value and label are the same Hebrew string — that is what keeps legacy rows matching');
  assert.strictEqual(opts.length, EXPECTED_LABELS.length + 1);
});

test('both modals expose exactly that option list', () => {
  const app = freshApp();
  [['add', () => app.openAddLeadModal()],
   ['edit', () => app.openEditLeadModal(leadWith(''))]].forEach(([which, open]) => {
    const spec = app.captureModal(open);
    const f = fieldNamed(spec, 'contactRelation');
    assert.strictEqual(f.options[0].value, '', `${which}: blank first`);
    assert.deepStrictEqual(plain(f.options.slice(1).map((o) => o.value)), EXPECTED_LABELS,
      `${which}: option values must match the constant exactly and in order`);
  });
});

test('the inline select renders the same options as markup', () => {
  const app = freshApp();
  const html = app.contactRelationOptionsHTML('');
  const values = [...html.matchAll(/<option value="([^"]*)"/g)]
    .map((m) => decodeEntities(m[1]));
  assert.strictEqual(values[0], '');
  assert.deepStrictEqual(values.slice(1), EXPECTED_LABELS);
});

/* ===================================================================== */
/* 4. Empty stays empty — the field is optional                           */
/* ===================================================================== */

test('empty round-trips as empty through the resolver', () => {
  const app = freshApp();
  assert.strictEqual(app.resolveContactRelation('', ''), '');
  assert.strictEqual(app.resolveContactRelation('', 'ignored'), '',
    'free text is only consulted under אחר');
  assert.strictEqual(app.resolveContactRelation(undefined, undefined), '');
  assert.strictEqual(app.resolveContactRelation(null, null), '');
});

test('empty round-trips as empty through the edit modal', () => {
  const app = freshApp();
  const lead = leadWith('');
  const spec = app.captureModal(() => app.openEditLeadModal(lead));
  assert.strictEqual(fieldNamed(spec, 'contactRelation').value, '');
  return Promise.resolve(spec.onSubmit(untouchedValues(spec))).then(() => {
    assert.strictEqual(lead.contactRelation, '', 'an untouched empty field must stay empty');
  });
});

test('empty round-trips as empty through the add modal', async () => {
  const app = freshApp();
  const spec = app.captureModal(() => app.openAddLeadModal());
  await spec.onSubmit(untouchedValues(spec, { name: 'ליד חדש', assignedTo: 'ורד' }));
  const created = app.getLeads()[0];
  assert.ok(created, 'the lead must have been created');
  assert.strictEqual(created.contactRelation, '');
});

/* ===================================================================== */
/* 5. LEGACY off-list values survive byte for byte                        */
/* ===================================================================== */

LEGACY_OFF_LIST.forEach((legacy) => {
  test(`legacy «${legacy}» is pinned as a selected extra option`, () => {
    const app = freshApp();
    // Guard the fixture itself: this really is off the new list.
    assert.ok(!app.isContactRelationPreset(legacy),
      `${legacy} must be off-list for this test to mean anything`);

    const opts = app.contactRelationOptions(legacy);
    assert.strictEqual(opts[0].value, '', 'blank placeholder stays first');
    assert.deepStrictEqual(plain(opts[1]), { value: legacy, label: legacy },
      'the legacy value is pinned directly after the placeholder');
    assert.deepStrictEqual(plain(opts.slice(2).map((o) => o.value)), EXPECTED_LABELS,
      'the fixed list follows it, unchanged');
    assert.strictEqual(opts.filter((o) => o.value === legacy).length, 1);

    const html = app.contactRelationOptionsHTML(legacy);
    assert.ok(html.includes(`<option value="${legacy}" selected>`),
      'the pinned option is the selected one, so opening the form cannot rewrite it');
  });

  test(`legacy «${legacy}» survives open-then-save unchanged (edit modal)`, async () => {
    const app = freshApp();
    const lead = leadWith(legacy);
    const spec = app.captureModal(() => app.openEditLeadModal(lead));
    assert.strictEqual(fieldNamed(spec, 'contactRelation').value, legacy,
      'the modal opens on the stored value');
    assert.strictEqual(fieldNamed(spec, 'contactRelationOther').hidden, true,
      'a legacy value must NOT be routed through the אחר flow');

    await spec.onSubmit(untouchedValues(spec));
    assert.strictEqual(lead.contactRelation, legacy,
      'saving without touching the field must not alter it');
  });

  test(`legacy «${legacy}» survives the inline card block unchanged`, () => {
    const app = freshApp();
    const html = app.leadContactEditHTML(leadWith(legacy));
    assert.ok(html.includes(`<option value="${legacy}" selected>${legacy}</option>`),
      'the inline select carries the legacy value as its selected option');
    assert.ok(!/class="lc-relation-other"[^>]*style="display:none"[^>]*value="[^"]+"/.test(html),
      'the free-text input stays empty and hidden for a legacy value');
  });
});

test('legacy values are never mapped or normalized onto the new list', () => {
  const app = freshApp();
  // The mapping temptations, explicitly refused.
  assert.strictEqual(app.resolveContactRelation('אישתו', ''), 'אישתו');
  assert.notStrictEqual(app.resolveContactRelation('אישתו', ''), 'בן/בת זוג');
  assert.strictEqual(app.resolveContactRelation('סבתא', ''), 'סבתא');
  assert.notStrictEqual(app.resolveContactRelation('סבתא', ''), 'סבא/סבתא');
  assert.strictEqual(app.resolveContactRelation('המטופל', ''), 'המטופל');
  assert.notStrictEqual(app.resolveContactRelation('המטופל', ''), 'מטופל');
  assert.strictEqual(app.resolveContactRelation('חברה', ''), 'חברה');
  assert.notStrictEqual(app.resolveContactRelation('חברה', ''), 'חבר/חברה');
});

test('normalizeLead still passes a legacy value straight through', () => {
  const app = freshApp();
  LEGACY_OFF_LIST.forEach((legacy) => {
    const out = app.normalizeLead({ id: 'L9', name: 'x', stage: 'new', contactRelation: legacy });
    assert.strictEqual(out.contactRelation, legacy);
  });
});

/* ===================================================================== */
/* 6. On-list legacy values select the existing option — no duplicate     */
/* ===================================================================== */

LEGACY_ON_LIST.forEach((value) => {
  test(`on-list «${value}» selects the existing option without duplicating it`, async () => {
    const app = freshApp();
    assert.ok(app.isContactRelationPreset(value), `${value} must be on the list`);

    const opts = app.contactRelationOptions(value);
    assert.strictEqual(opts.length, EXPECTED_LABELS.length + 1,
      'no extra option is added for a value already on the list');
    assert.strictEqual(opts.filter((o) => o.value === value).length, 1,
      'exactly one option carries this value');
    assert.deepStrictEqual(plain(opts.slice(1).map((o) => o.value)), EXPECTED_LABELS);

    const html = app.contactRelationOptionsHTML(value);
    assert.strictEqual((html.match(new RegExp(`<option value="${value.replace(/"/g, '&quot;')}"`, 'g')) || []).length, 1);

    const lead = leadWith(value);
    const spec = app.captureModal(() => app.openEditLeadModal(lead));
    assert.strictEqual(fieldNamed(spec, 'contactRelation').value, value);
    await spec.onSubmit(untouchedValues(spec));
    assert.strictEqual(lead.contactRelation, value, 'and it round-trips unchanged');
  });
});

/* ===================================================================== */
/* 7. אחר stores the TYPED text, never the literal 'אחר'                  */
/* ===================================================================== */

test('אחר + typed text resolves to the typed text', () => {
  const app = freshApp();
  assert.strictEqual(app.resolveContactRelation('אחר', 'בת דודה'), 'בת דודה');
  assert.strictEqual(app.resolveContactRelation('אחר', '  בת דודה  '), 'בת דודה',
    'the typed text is trimmed');
  assert.notStrictEqual(app.resolveContactRelation('אחר', 'בת דודה'), 'אחר');
});

test('אחר with no typed text falls back to אחר, so a legacy literal round-trips', () => {
  const app = freshApp();
  assert.strictEqual(app.resolveContactRelation('אחר', ''), 'אחר');
  assert.strictEqual(app.resolveContactRelation('אחר', '   '), 'אחר');
  // ...and the form opens on it with the free-text row revealed.
  const spec = app.captureModal(() => app.openEditLeadModal(leadWith('אחר')));
  assert.strictEqual(fieldNamed(spec, 'contactRelation').value, 'אחר');
  assert.strictEqual(fieldNamed(spec, 'contactRelationOther').hidden, false,
    'a stored literal אחר reveals the free-text row');
});

test('אחר + typed text stores the typed text through the edit modal', async () => {
  const app = freshApp();
  const lead = leadWith('');
  const spec = app.captureModal(() => app.openEditLeadModal(lead));
  await spec.onSubmit(untouchedValues(spec, {
    contactRelation: 'אחר', contactRelationOther: 'בת דודה',
  }));
  assert.strictEqual(lead.contactRelation, 'בת דודה');
  assert.notStrictEqual(lead.contactRelation, 'אחר');
});

test('אחר + typed text stores the typed text through the add modal', async () => {
  const app = freshApp();
  const spec = app.captureModal(() => app.openAddLeadModal());
  await spec.onSubmit(untouchedValues(spec, {
    name: 'ליד חדש', assignedTo: 'ורד',
    contactRelation: 'אחר', contactRelationOther: '  שכנה  ',
  }));
  const created = app.getLeads()[0];
  assert.strictEqual(created.contactRelation, 'שכנה', 'trimmed typed text, not אחר');
});

test('the selector-only contactRelationOther never reaches the lead record', async () => {
  const app = freshApp();
  const spec = app.captureModal(() => app.openAddLeadModal());
  await spec.onSubmit(untouchedValues(spec, {
    name: 'ליד חדש', assignedTo: 'ורד',
    contactRelation: 'אחר', contactRelationOther: 'שכנה',
  }));
  const created = app.getLeads()[0];
  assert.strictEqual(created.contactRelationOther, undefined,
    'it is a form control, not a lead field — normalizeLead must drop it');
});

test('picking a plain option ignores any stale free text', () => {
  const app = freshApp();
  assert.strictEqual(app.resolveContactRelation('אמא', 'leftover'), 'אמא');
  assert.strictEqual(app.resolveContactRelation('עו"ס', 'leftover'), 'עו"ס');
});

/* ===================================================================== */
/* 8. Schema guard — nothing about the sheet moved                        */
/* ===================================================================== */

test('contactRelation stays at LEAD_COLUMNS index 17', () => {
  const cols = Array.from(code.LEAD_COLUMNS);
  assert.strictEqual(cols.indexOf('contactRelation'), 17,
    'readSheet_ maps cells to keys BY POSITION — index 17 is sheet column R');
  assert.strictEqual(cols[17], 'contactRelation');
  // Neighbours pinned too, so a shift cannot hide behind a matching index.
  assert.strictEqual(cols[16], 'contactPhone');
  assert.strictEqual(cols[18], 'billingPhone');
  assert.strictEqual(cols.filter((c) => c === 'contactRelation').length, 1);
});

test('contactRelation is still classified as FREE TEXT, never an enum', () => {
  // Legacy values are legitimate data, so the corrupted-rows repair must keep
  // treating this column as free text — an enum pool would flag every one of
  // אישתו / בעל / סבתא / המטופל / חברה as corrupt.
  assert.ok(typeof code.corruptionScanTargets_ === 'function',
    'corruptionScanTargets_ must still exist');
  const leads = code.corruptionScanTargets_().find((t) => Array.isArray(t.textCols) &&
    t.textCols.indexOf('contactRelation') !== -1);
  assert.ok(leads, 'contactRelation must remain in a textCols list');
  assert.ok(!Object.prototype.hasOwnProperty.call(leads.enumCols || {}, 'contactRelation'),
    'contactRelation must NOT be added to enumCols');
});
