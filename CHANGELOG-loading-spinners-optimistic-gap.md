# Optimistic triggers: the busy state that never reached a frame

A follow-up to PR #132 (`CHANGELOG-loading-spinners-rollout.md`), which is left
exactly as it shipped. #132 put `busyButton()` on every async user action in the
frontend. On four of them the busy state is real in the source and invisible in
the browser, and this closes that one gap. Nothing else changes.

## The gap

Four writes re-render **before** they await:

| Worker | Triggers | Re-renders at |
|---|---|---|
| `moveLead` | «← שלב הבא», «שלב קודם →» | `renderAll()` before `await saveAll()` |
| `deletePatient` | מחק לצמיתות ✕ | `renderAll()` before `await apiPost(…)` |
| `saveBillingOverride` | `.bill-amount-save` | `renderBilling()` before `await apiPost(…)` |
| `clearBillingOverride` | `.bill-amount-clear-btn` | `renderBilling()` before `await apiPost(…)` |

`busyButton` sets its class synchronously but runs `fn` on a microtask. So
class-set → worker entered → trigger detached all complete inside **one task**,
with no paint in between. The spinner is applied to a node that leaves the
document before the browser ever draws it.

This is not a new theory. It is the same failure #130 diagnosed for the renew
button, where the fix was to move the indicator onto a control the re-render
cannot touch. #132's comment at the stage buttons notes the node is destroyed
("busyButton's restore on a detached node is inert") and treats that as
sufficient; the measurement below says otherwise.

## Measured, not argued

`test/optimistic-gap-browser.test.js` boots the real app in Chromium against a
stubbed API, **parks the mutation request** so the in-flight window stays open
as long as it likes, and samples every animation frame. A `requestAnimationFrame`
callback runs immediately before that frame is painted, so "was a busy indicator
connected and non-zero-sized at any rAF between the click and the response" is
exactly "did any painted frame show one".

A **positive control** is what makes a zero mean anything: «סגירת ליד» opens a
modal whose אישור lives in `#modal-root`, which no list re-render touches. It is
asserted, not merely reported — if it ever reads NEVER, the harness is broken and
every other verdict is void.

| Trigger | Before | After |
|---|---|---|
| «← שלב הבא» → `moveLead` | **0 / 89 frames** | 88 / 89 |
| «שלב קודם →» → `moveLead` | **0 / 87 frames** | 87 / 87 |
| מחק לצמיתות ✕ → `deletePatient` | **0 / 87 frames** | 89 / 89 |
| billing שמור → `saveBillingOverride` | **0 / 92 frames** | 88 / 89 |
| billing ↩ → `clearBillingOverride` | **0 / 89 frames** | 89 / 90 |
| *control* — close-lead modal אישור | *43 / 43* | *43 / 43* |

Before, the indicator seen on all five was `(none)`. After, it is
`#loading-banner :: שומר נתונים…`.

## The fix

`#loading-banner` already exists, already carries `.loading-banner`, and already
sits outside every re-rendered region — it is a sibling of `#app` in
`index.html`, before it. That makes it the one indicator these four writes can
actually use.

```js
setLoading(on)  // «טוען נתונים…» — a whole-page READ (unchanged in meaning)
setSaving(on)   // «שומר נתונים…» — an optimistic WRITE whose trigger is detached
```

Each of the four workers raises it **after** its optimistic re-render and lowers
it in a `finally`. The order is load-bearing and is pinned by a test: raising it
before the re-render would report a window that has not begun.

`busyButton` stays on all four triggers exactly as #132 wired it. It is still a
real double-fire guard for that node — it just is not the feedback.

**Both counters are reference-counted.** `loadAll` awaits `getPayments` and
`getCredits` inside its own banner, and `reloadCredits` can run while another
read is in flight, so a plain boolean lets an inner operation's `false` hide the
banner while the outer one is still working. They floor at zero, so a stray
unwind is inert. A read outranks a write when both are up — a reload replaces
everything on screen, which is the bigger news.

### What this deliberately does NOT do

- **No second indicator.** No new helper, no new CSS class, no new keyframe —
  the banner and its style already shipped. A test asserts `.loading-banner`
  still has exactly one rule and no third spin keyframe exists.
- **Nothing #132 shipped is renamed, restructured or "improved".**
  `withFieldSaving` keeps its name. `busyButton` is untouched. The `send` kind,
  the retired `withBusyButton`, the inline autosave marker, the
  `/meeting-report` changes — all left alone.
- **`deletePatient` keeps its native `window.confirm`.** #132 chose it; the
  banner closes the feedback gap without touching that decision, so it stays.
- **`CHANGELOG-loading-spinners-rollout.md` is #132's file and is not modified.**

## Tests

| File | |
|---|---|
| `test/optimistic-gap.test.js` | 22 tests, always runs |
| `test/optimistic-gap-browser.test.js` | 1 test, skip-guarded like `spinner-glyph-browser.test.js` |

Suite: **1224 tests, all green** (`node --test --test-concurrency=1`).

The fast file pins the banner (reference counting, the floor at zero, read
outranking write), and for each of the four workers: the banner is up while the
write is in flight **after** the re-render has already run — which is what "the
feedback survives the synchronous re-render" means — down on success, down on
failure, with the rollback intact. Plus the structural guards: the banner
precedes `#app`, no renderer rebuilds it, `setSaving(true)` comes after the
re-render call in every worker, and the lower is inside a `finally`.

The browser file asserts the property literally, in a real browser: every
trigger must paint in more than zero frames, and what paints must be
`#loading-banner` saying «שומר נתונים…» — not the trigger, which would put us
back on a detached node.

### Mutation check — 14 of 14 caught

| Mutant | Caught by |
|---|---|
| `moveLead` loses its banner | its in-flight test |
| …and the **browser** test, independently | `the four optimistic triggers paint a busy indicator` |
| `deletePatient` loses its banner | its in-flight test |
| `saveBillingOverride` loses its banner | its in-flight test |
| `clearBillingOverride` loses its banner | its in-flight test |
| `moveLead` never lowers the banner | its in-flight test |
| `deletePatient` never lowers the banner | its in-flight test |
| the lower leaves the `finally` | the structural ordering guard |
| banner raised **before** the re-render | the structural ordering guard |
| reference counting → boolean (saving) | `it is REFERENCE-COUNTED …` |
| reference counting → boolean (loading) | `it is REFERENCE-COUNTED …` |
| read no longer outranks write | `a read outranks a write …` |
| `#loading-banner` moved inside `#app` | `sits outside every re-rendered container` |
| `moveLead` rollback removed | `a FAILED write … leaves the rollback intact` |

## Files

| File | Change |
|---|---|
| `public/app.js` | reference-counted `setLoading` + new `setSaving`; `setSaving` in the four workers |
| `public/sw.js` | `CACHE_VERSION` v12 → v13 |
| `test/optimistic-gap.test.js` | new — 22 tests |
| `test/optimistic-gap-browser.test.js` | new — the real-browser proof |

No CSS change, no markup change, no new dependency, no backend change, no
`Code.gs` change.
