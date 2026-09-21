/* Tests for the date/month picker icon contrast fix
 * (CHANGELOG-date-picker-icon-contrast.md).
 *
 * The bug: on הכנסות חודשיות the month field's native calendar icon was all but
 * invisible. Nothing in the app drew that icon — Chromium did, for the UA's
 * colour scheme, and with no `color-scheme` declared anywhere in style.css that
 * scheme is LIGHT. So the glyph was painted in black (#000000, measured) on a
 * #182142 field: a peak channel distance of 66, against the 189 the fix lands.
 * Every other <input type="date"|"month"> in the app had the same defect.
 *
 * These tests RESOLVE the stylesheet rather than grepping it. tools/css-cascade.js
 * computes the winning declarations for each input type and for the WebKit picker
 * pseudo-element exactly as a browser's cascade would, so a later rule that
 * out-specifies this block (or a token edit that pushes --primary back toward the
 * field colour) fails here instead of shipping. Run against the pre-fix
 * stylesheet every contrast assertion below fails, so this file is a genuine
 * guard and not a restatement of the source.
 *
 * test/date-picker-icon-browser.test.js cross-checks the same numbers in real
 * Chromium, by screenshotting the control and diffing the glyph away.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const C = require('../tools/css-cascade.js');

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const read = (f) => fs.readFileSync(path.join(PUBLIC, f), 'utf8');

const NO_MEDIA = () => false;

/* The WebKit pseudo-element that IS the icon. */
const INDICATOR = '-webkit-calendar-picker-indicator';

/* Both native picker types the app uses. `type="month"` is the one Sandra
 * reported; `type="date"` is the other ten fields. */
const TYPES = ['date', 'month'];

/* The field colour the icon has to survive against: --surface, the background
 * the shared `input` rule gives every one of these controls. */
const FIELD = [24, 33, 66]; // #182142

/* The minimum peak channel distance we accept between the glyph and the field.
 * The bug shipped at 66 (black on #182142) and the fix measures 189. 120 sits
 * clear of the broken band and well under the good case, so it fails loudly on a
 * regression without being brittle — the same threshold shape the spinner-glyph
 * tests use. */
const MIN_ICON_CONTRAST = 120;

function inputEl(type, states = []) {
  return { tag: 'input', classes: [], attrs: { type }, states };
}

function sheet() {
  return C.parseSheet(read('style.css'), NO_MEDIA);
}

/* Everything the assertions need about one picker type, resolved from the file. */
function resolve(type, states = []) {
  const s = sheet();
  const vars = C.rootVars(s);
  const el = inputEl(type, states);
  const own = C.computeStyle(s, el);
  const ind = C.computeStyle(s, el, INDICATOR);
  return {
    sheet: s,
    vars,
    el,
    own,
    ind,
    fieldBg: C.backgroundColor(own, vars),
    iconPaint: C.parseColor(C.resolveVars(ind['background-color'], vars)),
  };
}

/* ===================================================================== */
/* The defect itself: the icon has to contrast with the field it sits on. */

for (const type of TYPES) {
  test(`input[type="${type}"]: the picker icon contrasts with the field`, () => {
    const r = resolve(type);

    assert.deepStrictEqual(
      r.fieldBg, FIELD,
      `the shared input rule should still put type="${type}" on --surface #182142; ` +
      'if that moved, the contrast floor below was measured against the wrong colour'
    );
    assert.ok(r.iconPaint, `type="${type}" picker icon resolves to no colour at all`);

    const d = C.channelDistance(r.iconPaint, r.fieldBg);
    assert.ok(
      d >= MIN_ICON_CONTRAST,
      `type="${type}" picker icon is ${d} away from the field (need >= ${MIN_ICON_CONTRAST}). ` +
      `icon rgb(${r.iconPaint}) vs field rgb(${r.fieldBg}) — this is the reported bug.`
    );
  });
}

/* ===================================================================== */
/* The two mechanisms, each asserted for what it actually covers. */

for (const type of TYPES) {
  test(`input[type="${type}"]: declares color-scheme dark`, () => {
    /* This is what fixes Firefox and — on every engine — the dropdown calendar
     * PANEL, which is UA-rendered and cannot be styled at all. Without it the
     * panel opens white-on-white-ish beside a dark app. */
    const r = resolve(type);
    assert.strictEqual(
      String(r.own['color-scheme'] || '').trim(), 'dark',
      `type="${type}" must declare color-scheme: dark — it is the only handle on ` +
      'the UA-rendered calendar panel and the fallback for engines with no ' +
      '::-webkit-calendar-picker-indicator'
    );
  });

  test(`input[type="${type}"]: the UA glyph is replaced, not merely tinted`, () => {
    const r = resolve(type);

    assert.strictEqual(
      String(r.ind['background-image'] || '').trim(), 'none',
      'the UA paints its glyph as the indicator background-image; leaving it in ' +
      'place would show the black glyph on top of our accent fill'
    );

    /* Masked, not filtered: the glyph's paint is a real background-color, so it
     * resolves through var(--primary) and keeps following the token. A
     * filter-matrix recolour would freeze today's hex into the stylesheet. */
    for (const prop of ['mask-image', '-webkit-mask-image']) {
      const v = String(r.ind[prop] || '');
      assert.ok(v.includes('data:image/svg+xml'), `indicator is missing ${prop}`);
      assert.ok(
        !/var\(/.test(v),
        `${prop} must not try to interpolate a custom property into a data URI — ` +
        'CSS does not substitute vars inside url() tokens'
      );
    }
    assert.ok(
      !('filter' in r.ind),
      'the icon must not be recoloured with a filter — use the mask so the paint ' +
      'stays var(--primary)'
    );

    assert.strictEqual(
      String(r.ind['background-color'] || '').trim(), 'var(--primary)',
      'the icon should be painted in the screen accent token, not a literal hex'
    );

    /* The UA fades its own indicator; ours is a deliberate colour already, and a
     * leftover fade is exactly how the spinner-glyph bug shipped. */
    assert.strictEqual(parseFloat(r.ind['opacity']), 1, 'the icon must not be faded');
  });

  test(`input[type="${type}"]: the mask is fully described`, () => {
    /* A mask with no size/repeat/position is at the mercy of UA defaults for a
     * pseudo-element that has none worth trusting — the glyph tiles or clips. */
    const r = resolve(type);
    for (const base of ['mask-repeat', 'mask-position', 'mask-size']) {
      for (const prop of [base, '-webkit-' + base]) {
        assert.ok(r.ind[prop], `indicator is missing ${prop}`);
      }
      assert.strictEqual(
        String(r.ind[base]).trim(), String(r.ind['-webkit-' + base]).trim(),
        `${base} and its -webkit- twin disagree`
      );
    }
    assert.strictEqual(String(r.ind['mask-repeat']).trim(), 'no-repeat');
  });
}

/* ===================================================================== */
/* Geometry: the fix is CSS-only and must not move the layout. */

for (const type of TYPES) {
  test(`input[type="${type}"]: the indicator box keeps Chromium's own width`, () => {
    /* 18px is the width Chromium's stock indicator occupies. Sizing our box to
     * the glyph (16px) instead narrowed the גבייה date field from 156px to 152px
     * and the הכנסות חודשיות month field from 176px to 172px — measured. The fix
     * is a repaint, so it should cost the layout nothing. */
    const r = resolve(type);
    assert.strictEqual(String(r.ind['width']).trim(), '18px');
    assert.strictEqual(String(r.ind['height']).trim(), '18px');
    assert.strictEqual(parseFloat(r.ind['padding']), 0, 'indicator padding must be 0');
  });
}

/* ===================================================================== */
/* Interaction states. */

for (const type of TYPES) {
  test(`input[type="${type}"]: hover and focus lift the icon, and stay legible`, () => {
    const base = resolve(type);
    for (const state of ['hover', 'focus']) {
      const r = resolve(type, [state]);
      assert.ok(r.iconPaint, `no icon colour resolves on :${state}`);
      assert.notDeepStrictEqual(
        r.iconPaint, base.iconPaint,
        `:${state} should visibly lift the icon off its resting accent`
      );
      const d = C.channelDistance(r.iconPaint, base.fieldBg);
      assert.ok(
        d >= MIN_ICON_CONTRAST,
        `:${state} icon is only ${d} from the field (need >= ${MIN_ICON_CONTRAST})`
      );
      /* Brighter, not darker — the lift these screens already use elsewhere
       * (.bill-cov-edit-btn:hover → --text). */
      const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
      assert.ok(
        lum(r.iconPaint) > lum(base.iconPaint),
        `:${state} should brighten the icon, not darken it`
      );
    }
  });

  test(`input[type="${type}"]: the icon reads as clickable`, () => {
    assert.strictEqual(String(resolve(type).ind['cursor']).trim(), 'pointer');
  });
}

/* ===================================================================== */
/* Scope: the rule must not leak onto controls it was never meant for. */

test('the fix is scoped to date/month, not to every picker indicator', () => {
  const s = sheet();
  /* ::-webkit-calendar-picker-indicator also exists on <input list> (datalist),
   * where it is a dropdown arrow. Repainting that as a calendar would be a
   * regression, so no bare/unscoped form of the selector may exist. */
  for (const r of s.rules || s) {
    for (const sel of (r.selectors || [])) {
      if (!sel.includes(INDICATOR)) continue;
      assert.ok(
        /input\[type\s*=\s*["'](date|month)["']\]/.test(sel),
        `unscoped picker-indicator selector would hit datalist inputs too: ${sel}`
      );
    }
  }
});

test('color-scheme: dark is not declared globally', () => {
  /* Scoped to the two input types on purpose. A root-level `color-scheme: dark`
   * would also repaint scrollbars and every other UA widget on the page — a far
   * wider change than the reported one-icon bug asked for. */
  const s = sheet();
  const html = C.computeStyle(s, { tag: 'html', classes: [], attrs: {}, states: [] });
  const body = C.computeStyle(s, { tag: 'body', classes: [], attrs: {}, states: [] });
  assert.ok(!html['color-scheme'], 'color-scheme must not be set on html');
  assert.ok(!body['color-scheme'], 'color-scheme must not be set on body');
});

/* ===================================================================== */
/* Coverage: EVERY date/month input in the app, not just the reported one. */

test('every date/month input in the app is covered by the fix', () => {
  /* The brief was explicitly "search for every input of type date and month
   * rather than fixing only the ones named". The rules are type-selectors, so
   * coverage is automatic — this test is here to catch a future field that
   * arrives with a type these rules do not name (time, datetime-local, week),
   * which would ship with the very bug this changelog closes. */
  const sources = ['app.js', 'index.html'].map((f) => [f, read(f)]);
  const COVERED = new Set(TYPES);
  const found = new Map();
  let total = 0;

  for (const [file, src] of sources) {
    /* Only real elements: skip the `<input type="date">` mentions inside the
     * block comments that explain these fields. */
    const withoutComments = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '');
    const re = /<input\b[^>]*\btype=["'](date|month|time|datetime-local|week)["']/g;
    let m;
    while ((m = re.exec(withoutComments)) !== null) {
      total++;
      const t = m[1];
      if (!found.has(t)) found.set(t, []);
      found.get(t).push(file);
    }
  }

  assert.ok(total >= 12, `expected the app's full picker inventory, found ${total}`);
  for (const [type, files] of found) {
    assert.ok(
      COVERED.has(type),
      `<input type="${type}"> in ${[...new Set(files)].join(', ')} draws a native ` +
      'picker icon that style.css does not repaint — add it to the rule block'
    );
  }
  /* Both reported screens are present: the month field is הכנסות חודשיות
   * (index.html) and the date fields include גבייה and the תקופת כיסוי pair. */
  assert.ok(found.get('month').includes('index.html'), 'הכנסות חודשיות month field missing');
  assert.ok(found.get('date').includes('index.html'), 'גבייה date field missing');
  assert.ok(found.get('date').includes('app.js'), 'the rendered date fields are missing');
});

/* ===================================================================== */
/* The service worker must evict the stale stylesheet. */

test('sw.js CACHE_VERSION was bumped for this stylesheet change', () => {
  /* style.css is the OFFLINE fallback for any device that installed v13; without
   * a bump those devices keep serving the copy with the invisible icon. */
  const sw = fs.readFileSync(path.join(PUBLIC, 'sw.js'), 'utf8');
  const m = sw.match(/var CACHE_VERSION = 'v(\d+)'/);
  assert.ok(m, 'CACHE_VERSION not found in sw.js');
  assert.ok(Number(m[1]) >= 14, `CACHE_VERSION is v${m[1]}; the picker-icon change needs >= v14`);
});
