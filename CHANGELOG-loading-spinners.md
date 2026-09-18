# Loading spinners — the shared busy-button pattern (PR 1 of 2)

Goal for the pair of PRs: **every action that loads or changes data shows a
spinner.** This PR builds the one pattern and applies it to **two save paths
only**; the follow-up PR applies it everywhere else in the inventory below.

Nothing else changes behaviour. No new dependency, no backend change, no
endpoint change.

---

## 1. Inventory — every async user action in the app

Compiled by reading every trigger wiring in `public/app.js`,
`public/meeting-report.js` and `public/meeting-report-pin.html`. Line numbers
are against this PR's tree. "Feedback today" describes the state **before** this
PR.

### Legend for "feedback today"

| Mark | Meaning |
| --- | --- |
| **none** | the control does nothing visible; the user only learns it worked when the screen changes |
| **page banner** | the page-wide `#loading-banner` (`setLoading`) — not tied to the control the user pressed |
| **disabled only** | the button greys out; no spinner, no wording change, no `aria-busy` |
| **modal-local** | `submitting` flag + `disabled` + label → `'שומר...'`; no spinner, no `aria-busy` |
| **withBusyButton** | `disabled` + `.btn.busy` (dim + `::after` spinner); no `aria-busy`, no label swap |
| **row freeze** | the row's controls disable and `.billing-row.saving` dims the row; no spinner |

### `public/app.js` — dashboard

| # | file:line | Trigger | What it does | Feedback today |
| --- | --- | --- | --- | --- |
| 1 | `public/app.js:662` | `#pin-submit` «כניסה» | `tryPin` (`:512`) → `POST /api/verify-pin` → cookie → `loadAll` | disabled only |
| 2 | `public/app.js:589` | name-picker buttons (מי מתחבר/ת) | `POST /api/verify-pin` with the name — re-issues the cookie | none |
| 3 | `public/app.js:666` | `#logout` «יציאה» | `POST /api/logout` → reload | none |
| 4 | `public/app.js:630` | header «החלף» | `POST /api/logout` → reload | none |
| 5 | `public/app.js:680` | app entry (`enterApp`) | **initial data load** — `loadAll` (`:791`): `getData` + `getPayments` + `getCredits` | page banner |
| 6 | `public/app.js:786` | tab becomes visible again | background `loadAll` resync | page banner |
| 7 | `public/app.js:397` | stale-save detected | `maybeResyncPreservedPatients` → `loadAll` | toast only |
| 8 | `public/app.js:745` | `#add-lead-btn` «+ ליד חדש» | `openAddLeadModal` (`:4326`) → modal «הוסף ליד» → `saveAll` (`:407`) | modal-local |
| 9 | `public/app.js:3175` | lead card ✏️ | `openEditLeadModal` (`:4432`) → modal «שמור שינויים» → `saveAll` | modal-local |
| 10 | `public/app.js:3164` | lead card «שלב הבא» | `advanceLead` (`:3242`) → `saveAll` (paid→entry opens `openEntryModal`, `:4493`) | **none** |
| 11 | `public/app.js:3165` | lead card «שלב קודם →» | `moveLead` (`:3263`) → `saveAll` | **none** |
| 12 | `public/app.js:3184` | lead card inline `[data-field]` change | `updateLead` (`:3288`) → `saveAll` | **none** |
| 13 | `public/app.js:3204`, `:3205` | lead card billing-phone selector change | `updateLead` → `saveAll` | **none** |
| 14 | `public/app.js:3166` | lead card «סגירת ליד» | `closeLead` (`:3330`) → closure modal (`:4284`) → `apiPost moveLeadIrrelevant` | modal-local |
| 15 | `public/app.js:3167` | lead card «הסר» | `showConfirm` «כן, מחק» → `removeLead` (`:3584`) → `apiPost removeLead` | `showConfirm` busy (`:4185`) |
| 16 | `public/app.js:3528` | שימור לידים «שחזר ליד» | `restoreIrrelevantLead` (`:3363`) → `showConfirm` → `apiPost restoreLead` | `showConfirm` busy |
| 17 | `public/app.js:2557` | לוח פגישות ✏️ | `openMeetingEditModal` submit (`:2659`) → `updateLead` → `saveAll` | modal-local |
| 18 | `public/app.js:2570` | לוח פגישות outcome `<select>` | `updateLead` → `saveAll` | **none** |
| 19 | `public/app.js:2032` | manager-report block first open | `markMeetingReportSeen` (`:2005`) → `updateLead` → `saveAll` | **none** |
| **20** | **`public/app.js:2359`** | **עריכת דיווח מנהל modal «שמירה»** | **`saveMeetingReportEdit` (`:2215`) → `saveAll`, `loadAll` on conflict** | **modal-local → ✅ fixed in this PR** |
| 21 | `public/app.js:2061` | manager-report block 🗑 | `showConfirm` «כן, מחק» → `deleteMeetingReport` (`:2258`) → `apiPost deleteMeetingReport` | `showConfirm` busy |
| 22 | `public/app.js:746` | `#add-patient-btn` «+ הוסף מטופל ישירות» | `openDirectAddPatientModal` (`:4561`) → `saveAll` | modal-local |
| 23 | `public/app.js:4771` | patient row ✏️ | `openEditPatientModal` (`:4621`) → `saveAll` | modal-local |
| 24 | `public/app.js:4773`, `:2853` | «שחרור» (patient row / renewal alert) | `dischargePatient` (`:4828`) → closure modal → `apiPost dischargePatient` + `saveAll` + `createOutpatientLead` | modal-local |
| 25 | `public/app.js:4779` | patient row ✕ «מחק לצמיתות» | `deletePatient` (`:5801`) → `apiPost deletePatientRow` | withBusyButton |
| 26 | `public/app.js:4777`, `:3766` | «שחזר» (released row / discharged tab) | choice modal (`:3998`) → `doRestorePatientAsNewLead` (`:3789`) / `doRestorePatientToActive` (`:4026`) → `apiPost` + `saveAll` | modal-local |
| 27 | `public/app.js:2851` | renewal alert «חידוש תשלום» | `confirmRenewPatient` → `showConfirm` → `renewPatient` (`:2895`) → `savePayment` (`:6648`) | `showConfirm` busy |
| 28 | `public/app.js:3776`, `:5728` | «זיכויים» | credits modal submit (`:5545`) → `saveCredit` (`:5340`) ×N → `apiPost saveCredit` (+ `reloadCredits` `:5322` on conflict) | withBusyButton |
| 29 | `public/app.js:5660` | «סמן כשולם» modal submit | `saveCredit` → `apiPost saveCredit` | withBusyButton |
| 30 | `public/app.js:6543` | גבייה row status `<select>` | `savePayment` → `apiPost savePayment` | row freeze |
| 31 | `public/app.js:6548` | גבייה row «שולם בפועל» input | `savePayment` → `apiPost savePayment` | row freeze |
| 32 | `public/app.js:6581` | גבייה 💾 per-month amount save | `saveBillingOverride` (`:6679`) → `apiPost upsertBillingOverride` | withBusyButton |
| 33 | `public/app.js:6593` | גבייה ✕ clear override | `clearBillingOverride` (`:6712`) → `apiPost deleteBillingOverride` | withBusyButton |
| 34 | `public/app.js:1354` | *(no trigger — fires on render)* | `autosaveMeetingWithDefaults` → `saveAll` | none (background) |
| 35 | `public/app.js:5774` | *(no trigger — inside discharge)* | `createOutpatientLead` → `POST /api/outpatient-lead` | toast on settle |

### `public/meeting-report.js` — the manager form (`/meeting-report`)

| # | file:line | Trigger | What it does | Feedback today |
| --- | --- | --- | --- | --- |
| 36 | `public/meeting-report.js:451` | page boot, and «דיווח נוסף» | `loadLeads` → `GET /api/meeting-report/leads` | **none** — the picker is simply empty until it fills |
| **37** | **`public/meeting-report.js:593`** | **`#mr-submit` «שליחת דיווח»** | **`POST /api/meeting-report/submit`** | **page-local `withBusy` (disabled + `'שולח…'`, no spinner) → ✅ fixed in this PR** |
| 38 | `public/meeting-report.js:594` | `#mr-again` «דיווח נוסף» | `resetForm` (`:542`) → `loadLeads` | **none** |

### `public/meeting-report-pin.html` — the manager form's PIN gate

| # | file:line | Trigger | What it does | Feedback today |
| --- | --- | --- | --- | --- |
| 39 | `public/meeting-report-pin.html:66` | `#pin-submit` «כניסה» | `POST /api/meeting-report/verify-pin` → reload | disabled only |

### Synchronous — deliberately NOT in scope

No network, no data change; nothing to spin. Listed so the follow-up PR does not
"fix" them by mistake: the top tabs (`public/app.js:690`), the house tabs
(`:4705`), the meetings-board week arrows (`:2525`–`:2533`), the לוח פגישות
WhatsApp links (`:2543`), the billing month picker (`:763`), the תפוסה
«הצג משוחררים» toggle (`:712`), the overdue strip (`:753`), the שימור לידים
section headings (`:3480`), the credits modal's «הוסף שורה» (`:5508`) and every
נקודת איזון control (`:7091`, `:7265`) — all local recompute or `localStorage`.

---

## 2. What this PR builds — `busyButton`

One pattern, one name, **duplicated into both pages rather than imported**.

`/meeting-report` must never load the dashboard bundle (house managers get a
small standalone page, not the 350 KB app — a rule that already governs the
label maps and `MANAGER_REPORT_MAX_CHARS`). So the helper lives byte-identically
in `public/app.js` and `public/meeting-report.js`, between two marker comments,
and `test/loading-spinners.test.js` extracts both and fails the build on a
one-character drift.

```js
busyButton(btn, kind, fn)   // kind: 'save' | 'load' | 'delete'
```

- **Busy state**: `disabled` + `aria-busy="true"` + class `is-busy` (the CSS
  spinner) + the label swapped to the Hebrew busy word —
  `'save' → שומר…`, `'load' → טוען…`, `'delete' → מוחק…`. An unknown kind falls
  back to the save wording rather than blanking the label.
- **Double-submit is blocked**: the guard reads `aria-busy` **off the DOM**, not
  a closure flag, so a second click — from the same handler, another handler, or
  a script — never reaches `fn`. It resolves to `undefined` and does nothing.
- **Always restored**, in a `finally`: success, a rejected `fetch`, a thrown
  validation error and an early `return` all end with the original label, the
  original `disabled` state and no `aria-busy`. A rejection still propagates to
  the caller after the restore.
- A falsy button is a **passthrough** — `fn` still runs, so a caller whose
  trigger was re-rendered away never silently loses its action.
- Written in ES5 (`var`/`function`) because the two copies must be identical and
  `meeting-report.js` is ES5 throughout.

### The spinner — pure CSS, RTL-safe, reduced-motion aware

Also duplicated byte-identically, into `public/style.css` and
`public/meeting-report.css`, under the same markers and the same drift test.

- `::before`, **not** `::after`, so the spinner sits **before the label** in the
  inline direction — to the right of the text on these RTL pages.
- Logical properties only (`margin-inline-end`, `border-inline-start-color`); the
  test fails the build on any `margin/padding/border-left|right` in the block.
- No `url()`, no image, no font, no new dependency — a `currentColor` ring and
  one `@keyframes`.
- `@media (prefers-reduced-motion: reduce)` drops the rotation entirely and
  closes the ring into a **complete static circle**, so the control still reads
  as "working" for a vestibular user.

### Security

No new input, no new sink, nothing rendered from user data: the helper writes
only a fixed literal label and fixed attribute/class names onto a button the app
already owns. The Hebrew labels are constants, never interpolated. The
double-submit guard is itself a hardening step — it closes the double-write
window on a slow phone on both save paths. No endpoint, payload, auth or cookie
handling is touched, and the manager form's isolation from the dashboard bundle
(a deliberate exposure boundary) is now enforced by a test instead of a comment.

---

## 3. Applied to two save paths only

| Path | Before | After |
| --- | --- | --- |
| `/meeting-report` «שליחת דיווח» (`public/meeting-report.js:479`) | page-local `withBusy` — `disabled` + label `'שולח…'`, no spinner, no `aria-busy`; validation ran **outside** it, so a refused submit gave no feedback loop at all | `busyButton(el('mr-submit'), 'save', …)` wrapping the **whole** submit, validation included — so the button is frozen from the tap and restored by the same `finally` whether the report saved, the network failed, or a missing field refused it before any request left the phone. The page-local `withBusy` and `state.busy` are gone. |
| Dashboard עריכת דיווח מנהל «שמירה» (`public/app.js:2359`) | local `submitting` flag + `disabled` + `'שומר...'`, restored by hand on each of the three exits | `busyButton(submitBtn, 'save', …)`; the local flag is gone (the DOM guard replaces it) and ביטול is frozen alongside — and thawed in the same `finally` — so the modal cannot be dismissed out from under an in-flight write. |

Every other row in the inventory is **untouched** in this PR, including the
existing `withBusyButton` / `showConfirm` / `showModal` busy paths, which keep
their current `.btn.busy` styling until the follow-up migrates them.

---

## 4. Tests — `test/loading-spinners.test.js`, 37 new

Full suite: **1047 pass, 0 fail** (`node --test`) — 1010 before, +37 here, zero
regressions.

**The helper, run twice** — once against the copy shipped in `public/app.js`
(vm-sandbox) and once against the copy in `public/meeting-report.js` (plain
`require`), so a regression in either file fails here. 9 assertions × 2 copies:
busy state applied at the tap (disabled, `aria-busy`, `is-busy`, label swapped);
the Hebrew word per kind plus the fallback; a second and third click while busy
never reach the worker; restore after success; restore after a rejected promise
(and the rejection propagates); restore after a thrown validation error **and**
after an early-return refusal; re-usable after every exit; a pre-disabled button
restored to **disabled**, not enabled; a falsy button is a passthrough.

**`/meeting-report` wiring**, driving the real page through a fake `document` so
its DOM-wiring IIFE actually runs: a click puts the button in the busy state and
fires exactly one `/submit`; a double tap still fires exactly one; the button is
restored after a success (and the confirmation screen renders); restored after a
rejected request with the Hebrew error shown and the form still on screen;
restored after a validation error **with no request sent at all**, and the button
works on the retry.

**Dashboard edit-report wiring**: submitting freezes «שמירה» *and* ביטול and
calls the save exactly once; a second submit while busy does not write twice;
success restores the button and closes the modal; a rejected save restores it and
keeps the modal open; a refusal (`false`) restores it and a retry goes through; a
`'conflict'` closes without the in-place refresh callback.

**Source scans (the guards):** the helper block is byte-identical in `app.js` and
`meeting-report.js`; the spinner block is byte-identical in `style.css` and
`meeting-report.css`; the spinner is `::before` with logical properties only and
no physical `left`/`right`; `prefers-reduced-motion` drops the animation and
keeps a static indicator; the spinner loads nothing (`url()` forbidden);
**`meeting-report.html` references neither `app.js` nor `style.css`, and
`meeting-report.js` neither requires nor imports the dashboard bundle**; both
save paths actually route through `busyButton`; `sw.js` carries `v9`.

Each guard was mutation-checked: removing the double-submit guard, making
`meeting-report.html` pull `app.js`, and drifting one label between the two
copies each turn the suite red.

---

## 5. Files

| File | Change |
| --- | --- |
| `public/app.js` | `busyButton` block added next to the existing `withBusyButton`; the edit-report modal's save rewired |
| `public/meeting-report.js` | the identical `busyButton` block added (and exported for the tests); page-local `withBusy` + `state.busy` removed; submit rewired with validation moved inside |
| `public/style.css` | `.is-busy` spinner block |
| `public/meeting-report.css` | the identical `.is-busy` spinner block |
| `public/sw.js` | `CACHE_VERSION` `v8` → `v9` — all four assets changed, so no phone may keep serving a v8 copy |
| `test/loading-spinners.test.js` | new, 37 tests |
| `CHANGELOG-loading-spinners.md` | this file |

Frontend only. No `server.js`, no `apps-script/Code.gs`, no new Railway variable,
no new Script Property.

## 6. Follow-up PR

Apply `busyButton` to rows 1–19, 21–36 and 38–39 of the inventory, and retire
`withBusyButton` / `.btn.busy` and the three hand-rolled `submitting` flags
(`showModal`, `showCloseLeadModal`, `showRestorePatientChoiceModal`,
`openMeetingEditModal`) in favour of the one pattern.
