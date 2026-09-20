# Loading feedback — the rollout (PR 3 of 3)

PR #129 built the shared `busyButton()` helper and applied it to **two** buttons.
PR #130 fixed its ring (a `:disabled` fade was outranking it). This PR applies it
to **everything else**, and adds the one thing it could not cover: inline
autosave on `<input>`/`<select>`, which has no label to swap.

The inventory in §1 was re-derived from the current source, not copied from #129.

---

## 1. Inventory — every async user action

`✅ new` = feedback added by this PR · `✓ had` = already had it · `n/a` = no async work.

### `public/app.js` — buttons

| file:line | Trigger | What it does | Before → after |
| --- | --- | --- | --- |
| `:587` | `#pin-submit` «כניסה» | `POST /api/verify-pin` → cookie → `loadAll` | disabled only → **✅ `busyButton` «טוען…»** |
| `:662` | name-picker buttons | `POST /api/verify-pin` with the name | none → **✅ «טוען…»** |
| `:703` | header «החלף» | `POST /api/logout` → reload | none → **✅ «טוען…»** |
| `:739` | `#logout` «יציאה» | `POST /api/logout` → reload | none → **✅ «טוען…»** |
| `:2462` | עריכת דיווח מנהל «שמירה» | `saveMeetingReportEdit` → `saveAll` | ✓ had (PR #129) |
| `:2761` | לוח פגישות ✏️ submit | `updateLead` → `saveAll` | hand-rolled flag → **✅ `busyButton`** |
| `:3275` | lead card «שלב הבא» | `advanceLead` → `saveAll` | **none** → **✅ «שומר…»** |
| `:3277` | lead card «שלב קודם →» | `moveLead` → `saveAll` | **none** → **✅ «שומר…»** |
| `:4135` | restore-choice modal submit | `doRestorePatientAsNewLead` / `…ToActive` | hand-rolled flag → **✅ `busyButton`** |
| `:4366` | **`showConfirm` action button** | remove lead · restore lead · renew · delete report | `.busy` class → **✅ `busyButton`, «מוחק…» when `danger`** |
| `:4472` | **`showCloseLeadModal` submit** | `closeLead` **and** `dischargePatient` | hand-rolled flag → **✅ `busyButton`** |
| `:4967` | patient row ✕ «מחק לצמיתות» | `deletePatient` | `withBusyButton` → **✅ `busyButton` «מוחק…»** |
| `:5742` | credits modal submit | `saveCredit` ×N | `withBusyButton` → **✅ `busyButton`** |
| `:5861` | «סמן כשולם» submit | `saveCredit` | `withBusyButton` → **✅ `busyButton`** |
| `:6102` | **`showModal` submit** | add/edit lead · admit · add/edit patient | hand-rolled flag → **✅ `busyButton`** |
| `:6784` | גבייה 💾 amount save | `saveBillingOverride` | `withBusyButton` → **✅ `busyButton`** |
| `:6796` | גבייה ✕ clear override | `clearBillingOverride` | `withBusyButton` → **✅ `busyButton` «מוחק…»** |

Modal **openers** (`:2947` שחרור · `:3278` סגירת ליד · `:3287` ✏️ lead · `:3284` הסר · `:3664` שחזר ליד · `:4958` ✏️ patient · `:4960` שחרור · `:2948` חידוש תשלום · `:3902` שחזר · `:2158` 🗑 report) do no async work themselves — they open a dialog, and **the dialog's own button carries the busy state**. That is deliberate: an optimistic worker re-renders the list and destroys the row button mid-flight, while `#modal-root` is untouched by any re-render (the bug PR #129 already fixed for renewals).

### `public/app.js` — inline autosave (no button to put a label on)

| file:line | Trigger | What it does | Before → after |
| --- | --- | --- | --- |
| `:3301` | lead card `[data-field]` change | `updateLead` → `saveAll` | **none** → **✅ `withFieldSaving`** |
| `:3319` | contactRelation «אחר» free input | `updateLead` → `saveAll` | **none** → **✅ `withFieldSaving`** |
| `:3338` | billing-phone selector pair | `updateLead` → `saveAll` | **none** → **✅ `withFieldSaving`** |
| `:2671` | לוח פגישות outcome `<select>` | `updateLead` → `saveAll` | **none** → **✅ `withFieldSaving`** |
| `:2143` | manager-report block, first expand | `markMeetingReportSeen` → `saveAll` | **none** → **✅ `withFieldSaving`** |
| `:6741` | גבייה row status / «שולם בפועל» | `savePayment` | row freeze only → **✅ row freeze **+** `withFieldSaving`** |

### `public/app.js` — whole-page loads

| file:line | Path | Before → after |
| --- | --- | --- |
| `:866`/`:1040` | `loadAll` — initial load, visibility resync, stale-save resync, post-conflict reload | ✓ had `#loading-banner`, already cleared in a `finally` |
| `:5514`/`:5524` | **`reloadCredits`** | **reloaded in complete silence** → **✅ raises the banner, cleared in a `finally`** |

**There is no manual-refresh control in this app.** Every reload is either startup, the `visibilitychange` resync, or a post-mutation reload — all of which go through `loadAll`. Nothing to wire; stated here rather than invented.

**The outpatient handoff** (`createOutpatientLead`) POSTs `/api/outpatient-lead` from **inside** `dischargePatient`'s modal submit, so it is covered by that modal's busy state for its whole duration — and it is non-fatal by contract, reporting via toast. No separate spinner.

### `public/meeting-report.js`

| file:line | Trigger | Before → after |
| --- | --- | --- |
| `:494` | `#mr-submit` «שליחת דיווח» | ✓ had — **label changed `save` → `send`**, «שולח…» |
| `:611` | `#mr-again` «דיווח נוסף» | **none** → **✅ `busyButton` «טוען…»** (it re-fetches the lead list) |
| `:451` | initial lead-picker load | **none — the picker sat blank** → **✅ a disabled «טוען…» option** |

### Deliberately unchanged

- `public/meeting-report-pin.html` — the PIN gate is a standalone page with an **inline** script and loads no JS file. It already disables its button. Giving it the shared helper would mean a **third** copy of the block, which the duplication guard does not cover and which would drift. Left as-is, called out rather than quietly forked.
- Synchronous controls: tabs, house tabs, week arrows, search inputs, the billing month picker, «הצג משוחררים», section headings, נקודת איזון (localStorage only), the WhatsApp links. No request, nothing to report.

---

## 2. What was added

### `busyButton` gains a fourth kind

`send` → **«שולח…»**, added to `BUSY_LABELS` in **both** copies (still byte-identical, still guarded). `/meeting-report`'s submit now uses it: the button says «שליחת דיווח», so «שולח…» is the honest word where #129 had «שומר…».

### `withFieldSaving(el, kind, fn)` — new, `public/app.js` only

Browsers do not render `::before`/`::after` on form controls, and an `<input>`
has no label to swap, so an inline autosave needs its own attachment. **It is not
a second spinner**: it inserts a marker carrying the very same `is-busy` class,
so it renders the identical ring from the identical CSS rule, followed by the
identical word out of `BUSY_LABELS`. One vocabulary, one stylesheet rule; only
the attachment differs. `public/style.css` gains 8 lines of sizing — no new
spinner, no new keyframes, no change to #130's opacity/specificity fix.

Same contract as `busyButton`: aria-busy re-entry guard (so a second change
cannot double-write), removal in a `finally` on success **and** failure, falsy
element passthrough — plus tolerance for a **detached** node, because an
optimistic re-render can replace the field mid-flight.

**"Never left looking saved when the request failed"** is satisfied end to end:
the marker clears in the `finally`, and the worker's own rollback (`updateLead`,
`savePayment`) restores the previous value and raises the Hebrew error banner.
That rollback logic is untouched by this PR.

### `withBusyButton` is retired

All five callers moved to `busyButton`; the helper and its now-dead `.btn.busy`
CSS + `@keyframes btn-busy-spin` are deleted. The cascade lesson from #130 that
cited it is kept in the shared comment, rewritten in the past tense (identically
in both stylesheets). Four hand-rolled `submitting` flags are gone too — the
DOM-based guard replaces them.

### One behavioural fix found while migrating

`busyButton` runs its worker on a microtask, so anything the worker froze
(`showConfirm`'s ביטול, the billing row) lagged the click by a tick. Both now
freeze **synchronously at the tap**, before `busyButton` is called. The billing
row additionally needed a re-entry guard *before* the freeze — without it a
second change would fall through to the `finally` and unfreeze the row while the
first save was still in flight.

---

## 3. Tests

**Full suite: `node --test` — 1156 pass, 0 fail** (1130 before; **+26** new in
`test/loading-feedback-rollout.test.js`, plus updates to five existing files).

- **`withFieldSaving`** — marker inserted with the shared class and word; cleared
  after success; cleared after failure **and the rejection re-thrown**; a second
  change while saving does nothing; detached and falsy elements tolerated; the
  word for all four kinds comes from `BUSY_LABELS`.
- **The five modal choke points** — `showModal`, `showCloseLeadModal`,
  `showConfirm`, restore-choice, meeting-edit: busy applied at the tap, second
  submit blocked, restored after success, after a rejection, and after a refusal
  (`onSubmit` returned `false`); ביטול frozen synchronously; «מוחק…» on a
  `danger` confirm and «שומר…** otherwise.
- **Loading banner** — raised and cleared by `loadAll` on success **and** on
  failure; same for `reloadCredits`, which used to be silent.
- **Rollback unchanged** — `closeLead` still rolls the lead back into the
  pipeline on a failed write and keeps the modal open, and still moves it on
  success. Both assert the write was actually attempted, so neither can pass
  vacuously (the first draft of these two did exactly that — the modal captures
  its radio list at build time, so a stub applied afterwards was too late).
- **Structural guards** — `withBusyButton` and `.btn.busy` cannot return; no
  hand-rolled `submitting` flag or `'שומר...'` literal survives; every Hebrew
  busy word appears **only** in `BUSY_LABELS` (comments stripped first, so prose
  naming a word is not counted); `/meeting-report` still does not load the
  dashboard bundle and still has no `withFieldSaving`.

### The coverage guard, and what it honestly does

`COVERAGE GUARD: no click/change handler does async work without feedback` walks
every `.onclick` / `.onchange` / `.onsubmit` / `addEventListener('click'|'change')`
in `app.js`, brace-matching the **full** handler source (including concise arrow
bodies), resolves **one level** of indirection into named workers, and fails if
the reachable text touches a transport or write call with no feedback marker.

**Its limits, stated rather than papered over:** it is a source scan. A *second*
level of indirection, a write reached through a variable or a dynamically built
handler would slip past it. It is a tripwire for the common case — a new button
wired straight to `apiPost`/`saveAll`/a named worker — not a proof. A companion
test asserts the guard itself is not vacuous by running the same scan over a
deliberately stripped handler.

### Mutation checks

Each key guard was broken and restored; failures in brackets:

| Mutation | Result |
| --- | --- |
| inline `[data-field]` autosave loses its indicator | **caught (1)** |
| meetings outcome select loses its indicator | **caught (1)** |
| `withFieldSaving` stops clearing on failure | **caught (1)** |
| `reloadCredits` goes silent again | **caught (1)** |
| `loadAll` never clears the banner | **caught (2)** |
| `withBusyButton` reintroduced | **caught (1)** |
| a stray hard-coded «שומר…» literal | **caught (4)** |
| `/meeting-report` submit reverts to `save` | **caught (1)** |
| `showConfirm` loses the synchronous cancel freeze | **caught (1)** |
| a stage button loses its busy state | **caught (1)** |

Two of these initially did **not** bite, and both were defects in my own
harness, not in the code: the guard's extractor stopped at the arrow's `()` and
read an empty body, and the first `loadAll` mutation was semantically a no-op
because `loadAll` swallows its own error. Both were fixed and re-run.

---

## 4. Files

| File | Change |
| --- | --- |
| `public/app.js` | `send` label; `withFieldSaving`; 17 button sites; 6 inline-autosave sites; `reloadCredits` banner; `withBusyButton` + 4 `submitting` flags removed; synchronous freeze fixes |
| `public/meeting-report.js` | `send` label (byte-identical block); submit → `send`; «דיווח נוסף» → `busyButton`; picker loading state |
| `public/style.css` | `.field-saving` sizing (8 lines); dead `.btn.busy` rules removed; shared comment updated |
| `public/meeting-report.css` | the same shared-comment update (byte-identical) |
| `public/sw.js` | `CACHE_VERSION` `v11` → `v12` + comment line |
| `test/loading-feedback-rollout.test.js` | **new** — 26 tests |
| `test/loading-spinners.test.js` | `send` label + `/meeting-report` says «שולח…» |
| `test/async-button-busy-states.test.js` | `withBusyButton` unit tests dropped with the helper; `is-busy` class |
| `test/renewal-confirm-and-spinner-fix.test.js` · `test/restore-choice-modal.test.js` · `test/name-picker-conflicts.test.js` · `test/billing-override-carry-edit.test.js` | fake buttons gained the attribute API a real `<button>` has |
| `CHANGELOG-loading-spinners-rollout.md` | this file |

Frontend + tests only. No `apps-script/Code.gs`, no `server.js`, no
`package.json`, no new dependency, no markup framework change.
