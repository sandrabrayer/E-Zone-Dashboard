# Renew button — success confirmation toast

Clicking **חידוש תשלום** (renew) in the dashboard renewal alert (חידושי תפוסה)
looked like it did nothing. It didn't: the payment was written, the optimistic
update fired, and the renewed patient correctly dropped off the alert. But the
*only* feedback was that one row silently vanishing from the list — easy to miss
(especially with several rows, or if the operator wasn't watching that exact
row). Every other write path in the app confirms with a toast; renew did not.

Frontend-only. No `Code.gs` change, no Apps Script redeploy.

## What changed

`renewPatient` (`public/app.js`) now shows a success toast after the save
round-trip resolves — `showToast(`חידוש נרשם — ${patient.name}`)` — mirroring the
plain-string `showToast(...)` calls the leads/restore paths already use.

The toast fires **only when the paid record actually survived**. `savePayment`
swallows its own errors (it rolls back `state.payments` and shows an error banner
on failure), so its promise resolves either way. Before confirming, `renewPatient`
checks that the paid payment is still in `state.payments`:

```js
Promise.resolve(saved).then(() => {
  renderDashboard();
  if (state.payments.some(x => x.id === payment.id && x.status === 'paid')) {
    showToast(`חידוש נרשם — ${patient.name}`);
  }
});
```

On a failed save the record is rolled back out, the check is false, and no
success toast fires — the existing error banner from `savePayment` is the only
feedback, as before.

## Not a functional change

The renewal write, optimistic update, and alert refresh were already correct and
are untouched. This adds a confirmation only.

## Files

- `public/app.js` — `renewPatient`: success toast gated on the paid record
  surviving the round-trip.
- `test/renewal-alert.test.js` — two new tests exercising the real
  `renewPatient` + `savePayment` path in a second vm sandbox (renders/`apiPost`
  stubbed, `showToast` spied): the toast fires on a successful save, and does
  NOT fire when the save fails and the optimistic payment is rolled back.

## Commits

- _(pending)_ fix(dashboard): confirm renew with a success toast
