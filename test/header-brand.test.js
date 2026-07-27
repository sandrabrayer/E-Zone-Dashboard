/* Regression guards for the header (topbar) brand change:
 *
 *   The old header showed the plain Latin wordmark "E-ZONE". It now shows the
 *   app's existing emblem (the PWA icon) next to the Hebrew app name
 *   "דשבורד בתים" — no recolor, no new icon set. The emblem is ~30px on desktop
 *   and ~28px on phones, the brand never wraps and never crowds the nav.
 *
 * Like the PWA / mobile-tabs tests, these are markup/CSS changes verified by
 * reading the shipped source rather than executing a browser. */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const html = read('public/index.html');
const css = read('public/style.css');

/* ---------- markup: emblem + Hebrew name, no "E-ZONE" wordmark ---------- */

test('the topbar brand no longer renders the "E-ZONE" wordmark', () => {
  // Isolate the .brand container in the app header and assert the old text is
  // gone from it. (The PIN gate <h1> and <title> are intentionally untouched.)
  const brand = html.match(/<div class="brand">[\s\S]*?<\/div>/);
  assert.ok(brand, 'expected a .brand container in the topbar');
  assert.doesNotMatch(brand[0], /E-ZONE/,
    'the "E-ZONE" wordmark must be removed from the header brand');
});

test('the header brand shows the app emblem image', () => {
  assert.match(html, /<img class="brand-logo"[^>]*src="\/icons\/icon-192\.png"/,
    'expected the existing PWA icon as the header emblem');
});

test('the emblem is decorative (empty alt) since the name is beside it', () => {
  assert.match(html, /<img class="brand-logo"[^>]*alt=""/,
    'emblem should have alt="" so the adjacent name is not announced twice');
});

test('the header brand shows the Hebrew app name', () => {
  assert.match(html, /<span class="brand-name">דשבורד בתים<\/span>/,
    'expected the Hebrew app name next to the emblem');
});

/* ---------- CSS: layout, sizing, no-wrap, colors unchanged ---------- */

test('.brand is a no-wrap flex row that does not crowd the nav', () => {
  assert.match(css, /\.brand\s*\{[^}]*display:\s*flex/,
    '.brand must lay out the emblem and name in a flex row');
  assert.match(css, /\.brand\s*\{[^}]*align-items:\s*center/,
    'emblem and name must be vertically centered');
  assert.match(css, /\.brand\s*\{[^}]*white-space:\s*nowrap/,
    '.brand must never wrap');
  assert.match(css, /\.brand\s*\{[^}]*flex:\s*0 0 auto/,
    '.brand must not grow/shrink into the nav');
});

test('the emblem is ~30px on desktop', () => {
  assert.match(css, /\.brand-logo\s*\{[^}]*width:\s*30px/,
    'desktop emblem width should be 30px');
  assert.match(css, /\.brand-logo\s*\{[^}]*height:\s*30px/,
    'desktop emblem height should be 30px');
});

test('the emblem shrinks to ~28px on phones (inside the mobile media query)', () => {
  // Grab the <=900px media block and assert the 28px override lives inside it.
  const mq = css.match(/@media \(max-width:\s*900px\)\s*\{[\s\S]*?\n\}/);
  assert.ok(mq, 'expected the <=900px mobile media query');
  assert.match(mq[0], /\.brand-logo\s*\{[^}]*width:\s*28px/,
    'phone emblem width should be 28px');
  assert.match(mq[0], /\.brand-logo\s*\{[^}]*height:\s*28px/,
    'phone emblem height should be 28px');
});

test('the wordmark colors are kept exactly (no recolor)', () => {
  // The gradient/weight/size that styled the old "E-ZONE" text now styles the
  // Hebrew name — same values, so the brand color is unchanged.
  assert.match(css, /\.brand-name\s*\{[^}]*linear-gradient\(90deg,\s*#5b8bff,\s*#a779ff\)/,
    'brand name must keep the original #5b8bff→#a779ff gradient');
  assert.match(css, /\.brand-name\s*\{[^}]*color:\s*transparent/,
    'brand name must keep the gradient text fill (transparent color)');
});
