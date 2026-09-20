/* Tests for the spinner-glyph fix (CHANGELOG-spinner-glyph-fix.md).
 *
 * The bug PR #129 shipped: on the dashboard's עריכת דיווח מנהל modal the save
 * button went disabled and its label swapped to "שומר…", but no ring appeared.
 * The `::before` rule was present and correct — the defect was purely CASCADE.
 * busyButton() always sets `disabled` alongside the class, and both pages fade a
 * disabled control (`.btn:disabled` → .35, `.mr-submit:disabled` → .45). Those
 * are two-compound selectors; the block's `.is-busy { opacity: .7 }` was one, so
 * it lost and the fade hit the whole button — ring included.
 *
 * Every test the repo already had passed on that code, because they all READ the
 * stylesheet. These tests RESOLVE it: tools/css-cascade.js computes the winning
 * declarations for a busy button, per variant, per page, exactly as a browser's
 * cascade would, and asserts the ring lands visible. Run against the pre-fix
 * stylesheets the opacity assertions fail with the real values (.35 / .45), so
 * this file is a genuine guard and not a restatement of the source.
 *
 * test/spinner-glyph-browser.test.js cross-checks these same numbers in real
 * Chromium via getComputedStyle + a screenshot diff, when a browser is available.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const C = require('../tools/css-cascade.js');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');

const REDUCED = (q) => /prefers-reduced-motion:\s*reduce/.test(q);
const NO_MEDIA = () => false;

/* Every control the shared busy pattern lands on, or will land on when the
 * follow-up PR migrates the rest of the inventory. `behind` is the surface the
 * control sits on, used when its own background is transparent — the ring has to
 * contrast with what is ACTUALLY behind it, not with `transparent`. */
const SURFACE = [24, 33, 66];      // --bg  #182142, the page/modal backdrop
const VARIANTS = [
  { file: 'style.css', label: 'primary / blue (the reported save button)', classes: ['btn', 'primary'] },
  { file: 'style.css', label: 'secondary / surface',                      classes: ['btn'] },
  { file: 'style.css', label: 'danger / red',                             classes: ['btn', 'danger'] },
  { file: 'style.css', label: 'small / surface',                          classes: ['btn', 'small'] },
  { file: 'style.css', label: 'ghost / transparent',                      classes: ['btn', 'ghost'], behind: SURFACE },
  { file: 'style.css', label: 'ghost-sm / transparent',                   classes: ['btn', 'ghost-sm'], behind: SURFACE },
  { file: 'meeting-report.css', label: 'mr-submit / blue',                classes: ['mr-submit'] },
  { file: 'meeting-report.css', label: 'mr-again / surface',              classes: ['mr-again'] },
  /* The only GREEN surface in the product that a busy state could ever land on
   * (there is no green <button> variant — .toast-banner is the other green and
   * is not a control). Covered so the pattern is known-good on green ink too. */
  { file: 'meeting-report.css', label: 'mr-wa / GREEN',                   classes: ['mr-wa'] },
];

/* The minimum peak ring-vs-fill channel distance we accept. The bug shipped at
 * 66 on the primary button (measured in Chromium); the fix measures 133–219
 * across every variant. 120 sits clear of the broken band and below the worst
 * good case, so it fails loudly on a regression without being brittle. */
const MIN_RING_CONTRAST = 120;

/* A busy button as busyButton() leaves it: class + aria-busy + disabled. */
function busyEl(classes) {
  return {
    tag: 'button',
    classes: classes.concat(['is-busy']),
    attrs: { 'aria-busy': 'true' },
    states: ['disabled'],
    ancestors: [{ tag: 'div', classes: ['modal'] }, { tag: 'div', classes: ['form-actions'] }],
  };
}

/* Everything the assertions need about one variant, resolved from the real file. */
function resolve(variant, mediaAllows = NO_MEDIA) {
  const sheet = C.parseSheet(read(variant.file), mediaAllows);
  const vars = C.rootVars(sheet);
  const el = busyEl(variant.classes);
  const own = C.computeStyle(sheet, el);
  const before = C.computeStyle(sheet, el, 'before');
  const color = C.parseColor(C.resolveVars(own['color'], vars));
  const rawRing = before['border-top-color'];
  const ring = /currentcolor/i.test(String(rawRing))
    ? color
    : C.parseColor(C.resolveVars(rawRing, vars));
  const fill = C.backgroundColor(own, vars) || variant.behind || null;
  return { sheet, vars, el, own, before, color, ring, fill,
           opacityRule: C.winningRule(sheet, el, 'opacity') };
}

const px = (v) => parseFloat(String(v));

/* ===================================================================== */
/* 1. The regression itself: the busy button must not be faded            */
/* ===================================================================== */

VARIANTS.forEach((v) => {
  test(`[${v.file}] ${v.label}: a busy button resolves opacity 1, not a :disabled fade`, () => {
    const r = resolve(v);
    assert.strictEqual(r.own['opacity'], '1',
      `busy opacity resolved to ${r.own['opacity']} via "${r.opacityRule && r.opacityRule.selector}"`);
    // And it must be the busy-state rule that wins it — not a fade that merely
    // happens to be 1 today, and not source-order luck over an equal selector.
    assert.match(String(r.opacityRule.selector), /\[aria-busy="true"\]/,
      `opacity should be won by the busy-state rule, got "${r.opacityRule.selector}"`);
    // The exact broken values, named, so the original bug cannot return quietly.
    assert.ok(!['.35', '0.35', '.45', '0.45'].includes(r.own['opacity']),
      'the disabled fade is back on the busy button');
  });
});

/* ===================================================================== */
/* 2. The ring is a real, non-zero, visible box on every variant          */
/* ===================================================================== */

VARIANTS.forEach((v) => {
  test(`[${v.file}] ${v.label}: ::before is a non-zero ring`, () => {
    const b = resolve(v).before;
    assert.match(String(b['content']), /^['"]{2}$/, 'the ring needs generated content');
    assert.strictEqual(b['display'], 'inline-block');
    assert.ok(px(b['width']) > 0, `width was ${b['width']}`);
    assert.ok(px(b['height']) > 0, `height was ${b['height']}`);
    assert.ok(px(b['width']) >= 11 && px(b['height']) >= 11,
      `the ring must stay legible on a phone; got ${b['width']}x${b['height']}`);
    assert.ok(px(b['border-top-width']) >= 2,
      `stroke was ${b['border-top-width']}`);
    assert.strictEqual(b['border-top-style'], 'solid');
    assert.strictEqual(b['border-radius'], '50%');
  });
});

/* ===================================================================== */
/* 3. The ring contrasts with the fill it sits on — per variant           */
/* ===================================================================== */

VARIANTS.forEach((v) => {
  test(`[${v.file}] ${v.label}: ring colour is distinct from the button fill`, () => {
    const r = resolve(v);
    assert.ok(r.ring, 'ring colour did not resolve to a colour');
    assert.ok(r.fill, 'button fill did not resolve to a colour');
    const d = C.channelDistance(r.ring, r.fill);
    assert.notDeepStrictEqual(r.ring, r.fill, 'ring and fill are the same colour');
    assert.ok(d >= MIN_RING_CONTRAST,
      `ring rgb(${r.ring}) vs fill rgb(${r.fill}) is only ${d}; need >= ${MIN_RING_CONTRAST}`);
  });
});

test('every variant draws its ring in the button\'s own ink (currentColor)', () => {
  // currentColor is what makes the contrast above self-maintaining: a new variant
  // picks a `color` that reads on its own `background` and the ring follows.
  VARIANTS.forEach((v) => {
    const b = resolve(v).before;
    assert.match(String(b['border-top-color']), /currentcolor/i,
      `${v.label}: ring should inherit the button's ink`);
  });
});

/* ===================================================================== */
/* 4. The reset is scoped — an ordinarily-disabled button still fades     */
/* ===================================================================== */

test('a plain disabled button (not busy) still fades as designed', () => {
  const checks = [
    ['style.css', ['btn'], '.35'],
    ['style.css', ['btn', 'primary'], '.35'],
    ['meeting-report.css', ['mr-submit'], '.45'],
  ];
  checks.forEach(([file, classes, expected]) => {
    const sheet = C.parseSheet(read(file), NO_MEDIA);
    const el = { tag: 'button', classes, attrs: {}, states: ['disabled'] };
    assert.strictEqual(C.computeStyle(sheet, el)['opacity'], expected,
      `${file} ${classes.join('.')} should still fade when merely disabled`);
  });
});

test('the opacity reset needs BOTH the class and aria-busy — it cannot leak', () => {
  const sheet = C.parseSheet(read('style.css'), NO_MEDIA);
  // aria-busy present but the class gone (helper already restored it)
  const restored = { tag: 'button', classes: ['btn', 'primary'],
                     attrs: { 'aria-busy': 'true' }, states: ['disabled'] };
  assert.strictEqual(C.computeStyle(sheet, restored)['opacity'], '.35');
  // class present but aria-busy gone — the ring still draws, the fade returns;
  // the helper always sets both, so this is a defensive shape, not a live state.
  const classOnly = { tag: 'button', classes: ['btn', 'primary', 'is-busy'],
                      attrs: {}, states: ['disabled'] };
  assert.strictEqual(C.computeStyle(sheet, classOnly)['opacity'], '.35');
  assert.match(String(C.computeStyle(sheet, classOnly, 'before')['content']), /^['"]{2}$/);
});

/* ===================================================================== */
/* 5. Source order — the tie-break this fix depends on                    */
/* ===================================================================== */

test('the spinner block is declared after every :disabled opacity fade', () => {
  // `.is-busy[aria-busy="true"]` and `.btn:disabled` are BOTH (0,2,0), so the
  // later declaration wins. That makes position load-bearing; assert it rather
  // than trusting whoever next reorganises the stylesheet.
  ['style.css', 'meeting-report.css'].forEach((f) => {
    const css = read(f);
    const busyAt = css.indexOf('.is-busy[aria-busy="true"]');
    assert.ok(busyAt !== -1, `${f}: the busy-state opacity rule is missing`);
    const fades = [...css.matchAll(/^([^\n{]*:disabled[^\n{]*)\{([^}]*opacity[^}]*)\}/gm)];
    assert.ok(fades.length > 0, `${f}: expected at least one :disabled opacity rule`);
    fades.forEach((m) => {
      assert.ok(m.index < busyAt,
        `${f}: "${m[1].trim()}" is declared AFTER the busy reset and would win the tie`);
    });
  });
});

/* ===================================================================== */
/* 6. prefers-reduced-motion keeps a full, unfaded, static ring           */
/* ===================================================================== */

VARIANTS.forEach((v) => {
  test(`[${v.file}] ${v.label}: reduced motion gives a static ring, still unfaded`, () => {
    const r = resolve(v, REDUCED);
    assert.strictEqual(r.before['animation'], 'none', 'the spin must stop');
    assert.match(String(r.before['border-inline-start-color']), /currentcolor/i,
      'the ring should close into a complete circle');
    assert.strictEqual(r.own['opacity'], '1', 'reduced motion must not re-fade the button');
    // The block used to carry opacity: .55 here, halving the static ring on top
    // of the disabled fade. It must not come back.
    assert.ok(r.before['opacity'] === undefined || r.before['opacity'] === '1',
      `the static ring must not be dimmed; got ${r.before['opacity']}`);
    assert.ok(px(r.before['width']) > 0 && px(r.before['border-top-width']) >= 2);
  });
});

test('the animated ring has an open arc so the rotation reads', () => {
  const r = resolve(VARIANTS[0]);
  assert.strictEqual(r.before['border-inline-start-color'], 'transparent');
  assert.match(String(r.before['animation']), /ezone-busy-spin/);
});

/* ===================================================================== */
/* 7. The two copies stay identical, and the resolver stays honest        */
/* ===================================================================== */

test('the spinner CSS block is byte-identical in both stylesheets', () => {
  const S = '/* ===== BUSY-BUTTON SPINNER — START';
  const E = '/* ===== BUSY-BUTTON SPINNER — END ===== */';
  const cut = (css) => css.slice(css.indexOf(S), css.indexOf(E) + E.length);
  const a = cut(read('style.css'));
  const b = cut(read('meeting-report.css'));
  assert.ok(a.length > 0 && b.length > 0);
  assert.strictEqual(a, b, 'the two copies of the spinner CSS have drifted');
  assert.match(a, /\.is-busy\[aria-busy="true"\]/);
});

test('the resolver skips nothing that could decide the ring', () => {
  // Selectors the resolver cannot parse are inert for it, which would silently
  // weaken every assertion above. None of them may touch these controls.
  ['style.css', 'meeting-report.css'].forEach((f) => {
    const sheet = C.parseSheet(read(f), () => true);
    const unsupported = sheet.rules
      .filter((r) => C.selectorMatches(r.selector, busyEl(['btn', 'primary'])).unsupported)
      .filter((r) => /is-busy|\.btn\b|\.mr-submit|\.mr-again|\.mr-wa/.test(r.selector))
      .filter((r) => r.decls.some(([p]) => /^(opacity|content|display|width|height|border|color|background)/.test(p)));
    assert.deepStrictEqual(unsupported.map((r) => r.selector), [],
      `${f}: these selectors affect the busy button but the resolver cannot evaluate them`);
  });
});

test('the resolver computes specificity the way the cascade does', () => {
  const spec = (sel) => C.specificityOf(sel.trim().split(/\s+/).map(C.parseCompound));
  assert.deepStrictEqual(spec('.is-busy'), [0, 1, 0]);
  assert.deepStrictEqual(spec('.btn:disabled'), [0, 2, 0]);
  assert.deepStrictEqual(spec('.is-busy[aria-busy="true"]'), [0, 2, 0]);
  assert.deepStrictEqual(spec('.is-busy::before'), [0, 1, 1]);
  assert.deepStrictEqual(spec('button.btn.primary:disabled'), [0, 3, 1]);
  assert.deepStrictEqual(spec('#x .btn'), [1, 1, 0]);
  // The comparison that explains the whole bug: one class loses to two.
  assert.ok(C.cmpSpecificity(spec('.btn:disabled'), spec('.is-busy')) > 0);
  // ...and the fix ties it, which is why source order is asserted above.
  assert.strictEqual(C.cmpSpecificity(spec('.btn:disabled'), spec('.is-busy[aria-busy="true"]')), 0);
});

test('the resolver reproduces the ORIGINAL bug when fed the pre-fix rule set', () => {
  // A canary for the harness: if this ever stops reporting .35, the resolver has
  // gone blind to `:disabled` and section 1 above would pass on broken CSS.
  const prefix = `
    :root { --text: #f1f5ff; --surface-2: #1f2a52; --primary: #5b8bff; }
    .btn { background: var(--surface-2); color: var(--text); }
    .btn:disabled { opacity: .35; cursor: not-allowed; }
    .btn.primary { background: linear-gradient(180deg, var(--primary) 0%, #3a6dff 100%); color: #fff; }
    .is-busy { opacity: .7; cursor: progress; pointer-events: none; }
    .is-busy::before { content: ''; display: inline-block; width: 11px; height: 11px;
      border: 2px solid currentColor; border-inline-start-color: transparent; }
  `;
  const sheet = C.parseSheet(prefix, NO_MEDIA);
  const el = busyEl(['btn', 'primary']);
  assert.strictEqual(C.computeStyle(sheet, el)['opacity'], '.35',
    'the resolver must still see the disabled fade outrank a single-class .is-busy');
  assert.strictEqual(C.winningRule(sheet, el, 'opacity').selector, '.btn:disabled');
  // The ring box was fine all along — that is exactly why the bug was invisible
  // to source scans: only the resolved opacity was wrong.
  const b = C.computeStyle(sheet, el, 'before');
  assert.match(String(b['content']), /^['"]{2}$/);
  assert.strictEqual(b['width'], '11px');
});
