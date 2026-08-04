# Lead Contact Fields — UI

Builds on foundation PR #66 (which added `contactName`, `contactPhone`,
`contactRelation`, `billingPhone` to `LEAD_COLUMNS` and `normalizeLead`, verified
live in getData). This PR surfaces those fields in the UI.

**Frontend-only.** `Code.gs` already carries the columns — Railway auto-deploys
on merge; no Apps Script steps.

## Semantics
- Existing `name` + `phone` = **פרטי המטופל** (the patient). Unchanged — existing
  leads and the duplicate-phone check keep working.
- **פרטי הפונה** (referrer): `contactName` (שם), `contactPhone` (טלפון),
  `contactRelation` (קשר למטופל — free text). All optional.
- `billingPhone` = **טלפון לגבייה ועדכונים**, the default number for outgoing
  communication. Vered sets it per lead; stored as a resolved phone **string**.
- All new fields optional — a lead with only patient name+phone stays fully valid.

## What changed — `public/app.js`

### A. New-lead form (`openAddLeadModal`)
- Two labeled sections (**פרטי המטופל** / **פרטי הפונה**) plus a **פרטים נוספים**
  group, using a new `showModal` `type:'section'` divider (additive; existing
  modals unaffected).
- `contactName` / `contactPhone` / `contactRelation` inputs, all optional.
- **Billing selector** (`מטופל` / `פונה` / `אחר`, default `מטופל`): `אחר` reveals a
  free phone input (a new optional `hidden` row flag on `showModal`). On submit
  the choice is resolved to the actual phone **string** via `resolveBillingPhone`
  and stored in `billingPhone` — not a reference.

### B. Lead card (`buildLeadCard`)
- **View mode:** patient name+phone as before. When the referrer has a name or
  phone, one compact line — `פונה: [name] · [phone] ([relation])` — with empty
  parts omitted. When `billingPhone` differs from the patient phone, a subtle
  `גבייה` tag marks the relevant number (next to the contact phone, or on its own
  line for an `אחר` number).
- **Edit mode:** an inline פרטי הפונה block + the same billing selector. The
  contact inputs use the existing `[data-field] → updateLead` autosave path; the
  billing mode select + free input are wired separately (they resolve to one
  `billingPhone` string) and persist through `updateLead → saveAll`. On success
  the card is **not** re-rendered, so the `meetingWith` autosave busy-flag guard
  is never perturbed, and the meeting fields are untouched.

### C. Outgoing communication default
- New pure `leadBillingPhone(lead)` → `billingPhone` if set, else the patient
  phone. Both invite paths — the lead card's **שלח הזמנה** and the board edit
  modal's **שלח עדכון** — now target `leadBillingPhone(lead)` instead of the
  patient phone directly.

### D. Search
- New pure `leadMatchesQuery(lead, q)` extends the filter to also match
  `contactName` (lowercased substring) and `contactPhone` / `billingPhone`. Phone
  matching keeps today's raw-substring behavior **and** adds normalized-digit
  matching, so `050-12` and `+97250 12` find the same lead. Patient-phone
  behavior is unchanged (regression-free).

## Pure helpers (directly testable, reused by the UI)
`leadBillingPhone`, `resolveBillingPhone` (selector choice → stored string),
`billingModeForLead` (stored value → selector init, matched by normalized phone),
`leadMatchesQuery`, `leadBillingDiffersFromPatient`.

## Styling — `public/style.css`
`.lc-contact` / `.lc-billing` / `.lc-bill-tag` (view line + billing tag),
`.lc-contact-edit` / `.lc-section-head` (edit block), and `.form-section-head`
(modal section divider). Consistent with the card/modal look; RTL-safe.

## Tests — `test/lead-contact-fields-ui.test.js`
Existing `node:test` + vm-sandbox pattern (not Jest), no `app.js` changes needed
for testability:
- `leadBillingPhone` — set → returned; empty → patient fallback; safe on nullish.
- `resolveBillingPhone` — מטופל/פונה/אחר → correct stored string; default + trim.
- `billingModeForLead` — unset → patient; matches patient / contact by normalized
  phone; else other with the raw value; round-trips through `resolveBillingPhone`.
- `leadMatchesQuery` — contactName; normalized contactPhone/billingPhone; patient
  phone unchanged.
- Invite URL uses `billingPhone` when set, patient phone when not.

Full suite: `npm test` → **316 passed, 0 failed** (299 prior + 17 new), zero
regressions.

## Deploy
- Frontend-only; Railway auto-deploys on merge — no Apps Script steps.
- **Post-merge verification:** the new-lead form shows the two sections + billing
  selector; the lead card shows the `פונה` line when filled; **שלח הזמנה** opens
  WhatsApp to the billing phone; search finds leads by contact name/phone.
