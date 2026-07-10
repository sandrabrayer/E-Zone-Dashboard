/* Regression guards for the two mobile-display fixes:
 *
 *  1. Renewal-alert cards ("חידושי תפוסה" on the dashboard) clipped off the
 *     LEFT viewport edge on mobile. Root cause: .renewal-row kept its desktop
 *     `grid-template-columns: 1.6fr 1fr auto` on phones — the `auto` actions
 *     column (חידוש תשלום / שחרור buttons) couldn't shrink and overflowed,
 *     clipped left by the RTL html/body overflow-x guard. The retention list
 *     (.irrelevant-row) already had a <=900px override; renewal-row was missing
 *     one. Fix: add a .renewal-row single-column override in the 900px query.
 *
 *  2. The `build: <hash>` debug string rendered as a fixed bottom-left overlay
 *     on every tab. Fix: keep the build id inspectable (a <meta name="build">
 *     in <head> and a `hidden` #build-marker element) but remove it from the
 *     visible UI on all viewports.
 *
 * These are CSS/markup changes, so — like the PWA and mobile-tabs tests — they
 * are verified by reading the shipped source rather than driving a browser. */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const css = read('public/style.css');
const html = read('public/index.html');

/* Extract the body of the @media (max-width: 900px) block so assertions about
 * the mobile override can't be satisfied by an unrelated desktop rule. */
function mediaBlock900(source) {
  const start = source.search(/@media \(max-width:\s*900px\)\s*\{/);
  assert.ok(start !== -1, 'expected a @media (max-width: 900px) block');
  let i = source.indexOf('{', start);
  let depth = 0;
  for (let j = i; j < source.length; j++) {
    if (source[j] === '{') depth++;
    else if (source[j] === '}') { depth--; if (depth === 0) return source.slice(i + 1, j); }
  }
  throw new Error('unterminated @media (max-width: 900px) block');
}

/* ---------- Fix 1: renewal cards no longer clip on mobile ---------- */

test('renewal-row gets a single-column grid override at <=900px', () => {
  const mobile = mediaBlock900(css);
  assert.match(mobile, /\.renewal-row\s*\{[^}]*grid-template-columns:\s*1fr\s*;?/,
    'expected .renewal-row to collapse to a single column on mobile');
});

test('the desktop renewal-row grid (with an unshrinkable auto column) is unchanged', () => {
  // The desktop rule is what's correct on wide screens; only the mobile query
  // should override it. Assert the desktop 3-column grid still ships.
  assert.match(css, /\.renewal-row\s*\{[^}]*grid-template-columns:\s*1\.6fr\s+1fr\s+auto/,
    'desktop .renewal-row grid must remain 1.6fr 1fr auto');
});

test('retention (.irrelevant-row) mobile override is untouched — scoped fix', () => {
  // Guard against a regression to the tab that already renders correctly.
  const mobile = mediaBlock900(css);
  assert.match(mobile, /\.irrelevant-row\s*\{[^}]*grid-template-columns:\s*1fr\s+1fr/,
    'the retention list must keep its own 1fr 1fr mobile layout');
});

/* ---------- Fix 2: build string removed from the visible UI ---------- */

test('the build id is still inspectable via a <meta name="build">', () => {
  assert.match(html, /<meta\s+name="build"\s+content="__BUILD__"\s*\/?>/,
    'expected a <meta name="build" content="__BUILD__"> in <head> for deploy verification');
});

test('the build marker no longer renders as a visible fixed overlay', () => {
  // The old marker was a position:fixed div printed over the cards. It must now
  // be `hidden`, and must NOT carry the fixed-overlay positioning styles.
  const marker = html.match(/<div id="build-marker"[^>]*>/);
  assert.ok(marker, 'build-marker element should still exist (hidden, for inspection)');
  assert.match(marker[0], /\bhidden\b/, 'build-marker must carry the hidden attribute');
  assert.doesNotMatch(marker[0], /position:\s*fixed/,
    'build-marker must not use position:fixed (that was the visible overlay)');
});
