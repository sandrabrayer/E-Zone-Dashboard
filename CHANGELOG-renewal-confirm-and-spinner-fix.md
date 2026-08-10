# Renewal: confirmation step + the spinner that never painted

Fixes the live bug report: חידוש תשלום wrote a payment **immediately, with no
confirmation** (Sandra accidentally renewed a real patient), and the R3 busy
spinner never appeared on the button even under Slow-3G.

## Root cause (investigated before fixing)

**Not CSS, not caching.** The spinner rules are on deploy HEAD
(`style.css:266-273`) and `style.css` is served **network-first** since SW v5
(`sw.js:72`) — no cache-version bump needed, clients get fresh CSS.

**The frozen button was destroyed synchronously, before the browser ever
painted it:**

1. Click → `withBusyButton` froze the row button (`app.js:1887`).
2. `renewPatient` → `savePayment` applies its optimistic upsert to
   `state.payments` **synchronously**, then `renderDashboard()` runs
   **synchronously** (`app.js:1922-1924`).
3. `renderDashboard` → `renderRenewalAlert` (`app.js:1844`) →
   `patientsNeedingRenewal` sees the cycle now covered (paid suppresses the
   row) → `listEl.innerHTML = ''` (`app.js:1867`) destroys the frozen button —
   spinner lifetime: zero frames. Network throttling changes nothing; the
   destruction is synchronous, not network-bound.

### Audit — the other `withBusyButton` surfaces

| Surface | Verdict |
| --- | --- |
| Billing status select / paid input | ✅ unaffected — `savePayment`'s success path re-renders only the monthly summary, never the rows; the frozen controls survive |
| `showConfirm` / all modal flows | ✅ unaffected — `#modal-root` is outside every list re-render |
| Discharge button | ✅ n/a — opens a modal (sync) |
| Delete ✕ (תפוסה) | shares the mechanism (optimistic `renderAll` destroys the row) but the row vanishing **is** the feedback and a native confirm gates it — left unchanged per "no other behavior changes" |

## The fix — one change solves both reports

`confirmRenewPatient` (new): the renew button now opens the standard
`showConfirm` dialog —

> **"לחדש תשלום עבור \<name\> — \<amount\> ₪ לתאריך \<date\>?"** — אישור / ביטול

- **No write on the initial click.** Only אישור fires `renewPatient`; ביטול
  writes nothing.
- **The spinner now survives by construction**: `showConfirm`'s R3 busy
  discipline lives on the dialog's confirm button inside `#modal-root`, which
  no list re-render touches. `renewPatient` returns its settle promise, so the
  dialog stays open + frozen + spinning for the entire round-trip, then closes.
- `renewalAmount` (new, pure) computes the charged amount — existing payment
  record's amount, else base pay — shared by the dialog text and the write so
  they can never disagree.
- `renewPatient` itself is unchanged in behavior (optimistic + reconcile +
  survival-checked toast).

Hebrew, RTL-safe (reuses the existing confirm dialog wholesale).

## Tests — `test/renewal-confirm-and-spinner-fix.test.js` (5 new)

- Root cause pinned: on אישור, while the write is still pending **and the
  optimistic dashboard re-render has already run**, the dialog is still open
  with the confirm button disabled + `.busy` — the busy state lives on a node
  the re-render cannot destroy; the dialog closes after settle.
- The initial click creates the dialog and writes **no** payment; the prompt
  carries the patient name and the amount.
- אישור → exactly one `paid` write; ביטול → dialog closes, zero writes.
- `renewalAmount`: existing record amount wins, base-pay fallback.
- Edit-mode gate.

Full suite: `npm test` — **406 pass, 0 fail** (zero regressions; R3's
`renewPatient returns a thenable` test passes unchanged).

## Deploy

Frontend-only (`app.js`). No Code.gs, no server change. Railway redeploys on
merge; `app.js` is network-first so clients pick it up on next load.
