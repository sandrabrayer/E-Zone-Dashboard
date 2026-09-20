# Spinner glyph fix — the busy ring was drawn, then faded to nothing

Bug reported against PR #129 (`CHANGELOG-loading-spinners.md`): on the dashboard's
**עריכת דיווח מנהל** modal the save button correctly goes `disabled`, correctly
takes `aria-busy="true"`, and correctly swaps its label to «שומר…» — but no
spinner appears.

The report was exactly right about where the fault was not: the JS is fine. The
`::before` rule was fine too. The defect was entirely in the **cascade**.

---

## 1. Root cause

`busyButton()` always sets `disabled` alongside the busy class. Both pages fade a
disabled control:

| rule | file | specificity | opacity |
| --- | --- | --- | --- |
| `.btn:disabled` | `public/style.css:96` | **(0,2,0)** | `.35` |
| `.mr-submit:disabled` | `public/meeting-report.css:157` | **(0,2,0)** | `.45` |
| `.is-busy` *(as shipped in #129)* | both | **(0,1,0)** | `.7` |

One compound loses to two. So the fade won, and it applied to the **whole
button** — label and ring together. The ring was still there in every respect
that a source scan can check:

```
::before content="" display=inline-block 11px x 11px
        border=2px rgb(255,255,255) animation=ezone-busy-spin 0.7s
button  opacity=0.35          ← the bug, and the only thing wrong
```

A 2px white arc at 35% opacity over the blue primary fill measures **66/255**
peak contrast. The label survived that fade well enough to read because it is a
much heavier mark; the hairline ring did not. Hence "the label swaps but no
spinner appears" — a precise description of a ring that is present and
invisible.

### Why the OLDER spinner never showed this

Worth recording, because it is the whole shape of the regression and it invites a
wrong "simplification" later. The legacy `withBusyButton` ring is styled by
`.btn.busy` — **two** compounds. It *ties* `.btn:disabled` and wins on source
order (it is declared later), landing `.65`: dimmed, but plainly visible
(measured 121/255). `.is-busy` is **one** compound, so it does not tie — it
simply loses. That single-compound-versus-two difference is the entire bug.

`.btn.busy` is therefore **not** defective and is left untouched by this PR.

### Ruled out

Checked and cleared, so nobody re-treads them: no competing `::before` on `.btn`
(the only `::before` rules in `style.css` are `.card.stat`, `.pipe`,
`.renewal-alert` and the spinner itself); no `display`/`overflow` interference;
`content` is never overridden; the ring's `currentColor` resolves to `#fff` on
the primary fill, i.e. maximum contrast — it was never a colour-collision
problem. And the class does reach the element: `class="btn primary is-busy"`,
confirmed in the live modal.

---

## 2. The fix

In the shared spinner block, duplicated byte-identically into `public/style.css`
and `public/meeting-report.css`:

```css
.is-busy { cursor: progress; pointer-events: none; }
.is-busy[aria-busy="true"] { opacity: 1; }       /* ← the fix */
.is-busy::before { … width: 13px; height: 13px; … }
@media (prefers-reduced-motion: reduce) {
  .is-busy::before { animation: none; border-inline-start-color: currentColor; }
}
```

- **`opacity: 1` while busy.** `[aria-busy="true"]` is the exact state the helper
  sets, so the reset cannot leak onto an ordinarily-disabled button — a plain
  disabled `.btn` still fades to `.35`, asserted in the tests. The dim was
  redundant regardless: the spinner, the Hebrew busy label and `cursor: progress`
  already say the control is not clickable.
- **`.is-busy { opacity: .7 }` removed.** It never won anywhere it mattered, and
  where it *did* win (`.mr-again`, `.mr-wa` — no `:disabled` rule) it was
  needlessly dimming a working spinner.
- **Ring 11px → 13px.** A more legible mark on a phone; stroke stays 2px.
- **`opacity: .55` dropped from the reduced-motion block.** It halved the static
  ring on top of the disabled fade — the worst case in the whole file.
- **`currentColor` kept, deliberately.** Every variant sets its own `color` to
  contrast its own `background`, so the ring inherits contrasting ink for free
  and keeps doing so when a variant is added. The tests assert that invariant per
  variant rather than trusting it.

`.is-busy[aria-busy="true"]` is (0,2,0) — it *ties* `.btn:disabled` and wins on
source order, the same way `.btn.busy` always did. That makes position
load-bearing, so `test/spinner-glyph.test.js` asserts the block is declared after
every `:disabled` opacity rule in its file.

No JS changed. No markup changed. `busyButton()` already set everything needed.

---

## 3. Every variant, measured in Chromium

Peak per-channel contrast between the ring and the fill it sits on, from a
screenshot diff (the button shot twice — once as shipped, once with the ring's
border forced transparent — so only true ring pixels count):

| control | busy `opacity` before → after | ring contrast before → after |
| --- | --- | --- |
| `.btn.primary` — **the reported button** | 0.35 → **1** | 66 → **188** |
| `.btn` (secondary) | 0.35 → **1** | 74 → **210** |
| `.btn.danger` (red) | 0.35 → **1** | 68 → **193** |
| `.btn.small` | 0.35 → **1** | 74 → **210** |
| `.btn.ghost` | 0.35 → **1** | — → **181** |
| `.btn.ghost-sm` | 0.35 → **1** | 46 → **126** |
| `.mr-submit` (manager form) | 0.45 → **1** | 84 → **185** |
| `.mr-again` | 0.70 → **1** | 148 → **210** |
| `.mr-wa` (**green**) | 0.70 → **1** | 154 → **219** |

Note the control group: `.mr-again` and `.mr-wa` are the only two with **no
`:disabled` rule**, so they kept `.is-busy`'s `.7` and already measured roughly
double everything else. That correlation is the root cause, quantified.

On **green**: there is no green `<button>` variant in the product. The green
surfaces are `.mr-wa` (the WhatsApp share control on the manager form) and
`.toast-banner` (not a control). `.mr-wa` is covered above so the pattern is
known-good on green ink; it is a plain `wa.me` link and is not itself a
`busyButton()` target.

The two buttons the helper is actually wired to today are `.btn.primary` (the
dashboard edit-report save) and `.mr-submit` (the manager form submit) — rows 1
and 7. The rest are covered because the follow-up PR will wire them up.

---

## 4. Tests

**Full suite: `node --test` — 1094 pass, 0 fail** with a browser available;
**1092 pass, 0 fail, 2 skipped** under CI conditions (no `playwright`), which is
what the Tests workflow will report. 1047 before this PR; +47.

The reason none of PR #129's 37 tests caught this: they all **read** the
stylesheet. Every one of them still passes on the broken CSS, because the
`::before` rule really was correct. So this PR adds tests that **resolve** it.

### `tools/css-cascade.js` (new, test support — in `tools/` so `node --test` does not treat it as a test file)

A small dependency-free cascade resolver: selector lists, descendant
combinators, class / type / id / attribute / pseudo-class compounds,
`::before`/`::after` subjects, `@media` gating, `var()` against `:root`, and the
`border` shorthand. It computes the winning declarations for a described element
the way a browser would, and reports which rule won a given property.

### `test/spinner-glyph.test.js` (new, 45 tests — the CI guard)

Per variant, per page: busy `opacity` resolves to `1` **and is won by the
`[aria-busy="true"]` rule** (not by a fade that merely happens to be 1); the
`::before` is a non-zero ring (`content`, `inline-block`, ≥11px, ≥2px solid,
50%); the ring colour is distinct from the resolved fill by ≥120 channels;
reduced motion gives a static full ring that is still unfaded. Plus: a plain
disabled button *still* fades (the reset does not leak); the reset needs both the
class and the attribute; the block is declared after every `:disabled` fade; the
two CSS copies are byte-identical; specificity maths; and a canary that feeds the
resolver the pre-fix rule set and asserts it still reports `.35` won by
`.btn:disabled` — so the harness cannot go blind and pass on broken CSS.

**Verified to fail on the bug: run against the pre-fix stylesheets, 20 of the 45
fail**, including all nine `opacity` assertions.

### `test/spinner-glyph-browser.test.js` (new, 2 tests — real Chromium)

`getComputedStyle(el, '::before')` plus the screenshot diff described in §3,
asserting box size, `opacity: 1`, ring ≠ background, and ≥110 measured contrast
for all nine variants, and a static unfaded ring under `prefers-reduced-motion`.

**Skipped unless `playwright` resolves and a Chromium binary is present**, so it
is inert in CI — the repo has one dependency (express) and adding a browser to
`npm ci` would cost minutes per run for a check the cascade test already covers.
It runs wherever a browser exists:

```
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install --no-save playwright
node --test test/spinner-glyph-browser.test.js
```

`package.json` is deliberately unchanged.

### End-to-end

The real `index.html` was served over HTTP with the API stubbed, the real
`showMeetingReportEditModal` opened through the app's own code path, and the real
form submitted. Mid-save the actual button reports:

```
label "שומר…"  disabled true  aria-busy "true"  class "btn primary is-busy"
::before 13x13  rgb(255,255,255)  animation ezone-busy-spin   opacity 1
```

and the screenshot shows the ring clearly, with ביטול beside it still correctly
faded — the scoping working as designed. The same run against the pre-fix
stylesheet reproduces `opacity: 0.35` and a washed-out button.

All 37 of PR #129's spinner tests are kept and still pass — with one assertion
rewritten. `test/loading-spinners.test.js` pinned the literal `CACHE_VERSION ===
'v9'`, so it failed on the very next bump (this one). It now asserts the repo's
actual discipline — the version is a `vN` string and carries its `vN-1 → vN:`
comment line — which holds at every version instead of exactly one.

---

## 5. Cache — can a phone still be serving the broken CSS?

Asked explicitly, so answered explicitly.

**`public/sw.js` `CACHE_VERSION` was `v9`, and PR #129 did bump it** (`v8 → v9`,
with its comment line). This PR bumps **`v9 → v10`**.

**An online device cannot be served a stale stylesheet:**

- `server.js` sends `Cache-Control: no-store, no-cache, must-revalidate,
  max-age=0` (plus `Surrogate-Control`/`CDN-Cache-Control: no-store`) on every
  response and calls `app.disable('etag')`, so there is no HTTP- or CDN-level
  copy to go stale.
- `/style.css` is **network-first** in the service worker (`cacheStrategy`), so
  the cache is an offline-only fallback.
- `/meeting-report.css` is not cached by the worker at all (it falls through to
  plain `'network'`), and `meeting-report.html` additionally requests it with
  `?v=__BUILD__`.

**The one stale copy that did exist** is the `/style.css` in the **v9 precache**
— which contains PR #129's faded ring and would be served to a device that is
*offline*. Bumping to v10 deletes the v9 cache on `activate`, so it cannot
outlive this deploy.

One observation, not changed here: `public/index.html:25` links `style.css`
**without** the `?v=__BUILD__` cache-bust that `app.js` and
`meeting-report.css` both carry. It is harmless today given the `no-store`
headers and the network-first strategy, but it is an inconsistency worth closing
in a follow-up rather than widening this fix.

---

## 6. Files

| File | Change |
| --- | --- |
| `public/style.css` | shared spinner block: `opacity: 1` while busy, ring 13px, reduced-motion dim removed, root-cause comment |
| `public/meeting-report.css` | the identical block (byte-for-byte) |
| `public/sw.js` | `CACHE_VERSION` `v9` → `v10` + comment line |
| `tools/css-cascade.js` | **new** — dependency-free cascade resolver (test support) |
| `test/spinner-glyph.test.js` | **new** — 45 cascade-resolution tests |
| `test/spinner-glyph-browser.test.js` | **new** — 2 real-Chromium tests, skip-guarded |
| `test/loading-spinners.test.js` | one assertion de-brittled: the cache-version test no longer pins the literal `v9` |
| `CHANGELOG-spinner-glyph-fix.md` | this file |

Frontend + tests only. No JS, no markup, no `server.js`, no `apps-script/Code.gs`,
no `package.json`, no new dependency, no new Railway variable or Script Property.
