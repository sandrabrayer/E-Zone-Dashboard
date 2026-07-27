/* Regression guards for two frontend fixes:
 *
 *  1. Mobile top-nav tabs: at <=900px the tab bar must wrap onto its own
 *     full-width row (so all 9 tabs are visible) instead of being an
 *     internally-scrollable strip squeezed into the topbar (which showed only
 *     2 tabs at 390px with no scroll cue).
 *  2. Edit-mode label removal: the "מצב עריכה"/"מצב צפייה" indicator is gone,
 *     but the edit/viewer ACCESS CONTROL it labelled must remain intact.
 *
 * These are CSS/markup/source changes, so — like the PWA tests — they are
 * verified by reading the shipped source rather than executing a browser. */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const css = read('public/style.css');
const html = read('public/index.html');
const appjs = read('public/app.js');

/* ---------- Fix 1: mobile tabs wrap to a full-width row ---------- */

test('mobile (<=900px) media query exists', () => {
  assert.match(css, /@media \(max-width:\s*900px\)/);
});

test('.tabs wraps onto its own full-width row on mobile', () => {
  // A `.tabs { ... }` rule that wraps and takes a full-width flex row. [^}]*
  // keeps the match inside the single rule body.
  assert.match(css, /\.tabs\s*\{[^}]*flex-wrap:\s*wrap/,
    'expected .tabs to use flex-wrap: wrap on mobile');
  assert.match(css, /\.tabs\s*\{[^}]*flex:\s*1 0 100%/,
    'expected .tabs to take a full-width (flex: 1 0 100%) row');
});

test('.tabs is no longer an internally-scrollable strip', () => {
  // The previous approach (overflow-x:auto on .tabs) is what hid 6 of 8 tabs;
  // ensure it is not reintroduced on the .tabs rule.
  assert.doesNotMatch(css, /\.tabs\s*\{[^}]*overflow-x:\s*auto/,
    '.tabs must not scroll horizontally (that hid tabs in RTL)');
});

test('all 9 screen tabs are still present in the markup', () => {
  const tabs = html.match(/class="tab[ "]/g) || [];
  // one active + eight inactive = 9 buttons (meetings tab added after leads)
  const count = (html.match(/data-screen="/g) || []).length;
  assert.strictEqual(count, 9, 'expected 9 tab buttons');
  assert.ok(tabs.length >= 9);
});

/* ---------- Fix 2: label removed, access control preserved ---------- */

test('the "מצב עריכה" / "מצב צפייה" label indicator is fully removed', () => {
  assert.doesNotMatch(html, /id="mode-label"/, 'mode-label span must be gone');
  assert.ok(!appjs.includes('mode-label'), 'no getElementById(mode-label)');
  assert.ok(!appjs.includes('מצב עריכה'), 'edit-mode label text removed');
  assert.ok(!appjs.includes('מצב צפייה'), 'view-mode label text removed');
});

test('edit/viewer access control is still intact (Option A, not B)', () => {
  // viewer-mode is still applied to the body...
  assert.match(appjs, /classList\.toggle\('viewer-mode'/,
    'viewer-mode toggle must remain');
  // ...the PIN "viewer" entry path still exists...
  assert.match(appjs, /pin-viewer/, 'viewer entry path must remain');
  // ...edit-only UI hiding is still declared...
  assert.match(css, /body\.viewer-mode \.edit-only\s*\{\s*display:\s*none/,
    'edit-only hiding must remain');
  assert.match(html, /class="[^"]*edit-only/, 'edit-only buttons must remain');
  // ...and the runtime mode gates are still in place — both the early-return
  // guards (state.mode !== 'edit') and the conditional-enable checks
  // (state.mode === 'edit'). 18 total at time of writing; assert a floor so an
  // accidental mass-removal fails loudly.
  const guards = (appjs.match(/state\.mode (?:!==|===) 'edit'/g) || []).length;
  assert.ok(guards >= 15,
    `expected the ~18 edit-mode gates to remain, found ${guards}`);
});
