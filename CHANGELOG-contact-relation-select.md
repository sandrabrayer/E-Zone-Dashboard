# «קשר למטופל» — free text → dropdown with a free-text escape

`contactRelation` (LEAD_COLUMNS index 17, sheet **column R**) was a plain text
input on all three surfaces. It is now a `<select>` with a fixed option list and
an «אחר» escape, following the pattern `MEETING_COMPANION_LABELS` /
`meetingCompanion` already uses in this app.

**No production data is touched.** No migration, no normalization, no mapping.
See §3 — that is the part of this change that actually needed care.

---

## 1. The option list

One exported constant, `CONTACT_RELATION_LABELS` (`public/app.js`), declared
beside `MEETING_COMPANION_LABELS` so the kinship is visible:

```
מטופל · אמא · אבא · אח/אחות · בן/בת · בן/בת זוג ·
סבא/סבתא · קרוב משפחה · חבר/חברה · עו"ס · אחר
```

Preceded by a blank placeholder `— ללא —`: **the field is optional today and
stays optional**, and an empty value round-trips as empty.

### One deliberate divergence from the companion pattern

`meetingCompanion` stores stable English **keys** (`mother`) and maps them to
Hebrew only for display. `contactRelation` cannot do that, and this is the
crux of the whole change: column R has held free Hebrew text since PR #67, so
the **stored value must stay the Hebrew string itself** — otherwise every
existing row would stop matching its own option and the first save would
rewrite it.

So the option's `value` **is** its label, which makes `CONTACT_RELATION_LABELS`
an ordered **array** rather than a key→label map. It carries its own order, so
no separate `*_ORDER` array is needed (the meeting-report page needs one because
its labels live in an object).

Everything else mirrors the companion flow exactly: a frozen constant, an «אחר»
escape whose **typed text is what gets stored** (never the literal `'אחר'`), and
a display rule that renders anything off-list verbatim.

---

## 2. The three surfaces

All three previously used `type: 'text'`:

| surface | before | after |
| --- | --- | --- |
| `leadContactEditHTML` — inline card block | `<input type="text" data-field="contactRelation">` | `<select class="lc-relation" data-field="contactRelation">` + hidden `.lc-relation-other` input |
| `openAddLeadModal` | `{ name:'contactRelation', type:'text' }` | `...contactRelationFields(null)` |
| `openEditLeadModal` | `{ name:'contactRelation', type:'text', value }` | `...contactRelationFields(lead)` |

- **`contactRelationFields(lead)`** is the modal pair — select + hidden «אחר»
  row — modelled directly on the existing `billingSelectorFields` (same
  `hidden` flag, same `onChange` row-toggling). Shared by both modals so the
  option list and the legacy handling cannot drift between them.
- **The inline block keeps its `[data-field]` autosave wiring.** The `<select>`
  carries `data-field="contactRelation"`, so the generic
  `updateLead(lead.id, { [dataset.field]: value })` handler already persists
  every ordinary choice with no new code. Only the «אחר» free input is
  compound, and it is wired separately with `addEventListener` — exactly how
  the billing pair next to it already works — so nothing clobbers the
  `data-field` `.onchange`.
  Picking «אחר» stores `'אחר'` via the generic handler, and the typed text
  replaces it on the next change. Both are values `resolveContactRelation`
  itself would produce, so no intermediate state is ever wrong.
- **Both save paths resolve the pair** rather than storing the raw selection:
  the add form does it before `normalizeLead` (exactly like `billingPhone`),
  the edit form in its `onSubmit`. `contactRelationOther` is a form control, not
  a lead field — `normalizeLead` builds an explicit object, so it never reaches
  the record or the sheet.

No CSS change was needed: `.lead-card .lc-contact-edit input, … select`
(`public/style.css:1044`) already styles both new elements.

---

## 3. Legacy value preservation — the critical part

Column R contains real free text entered since PR #67, including **אמא · אבא ·
אחות · חברה · אישתו · בעל · בת זוג · סבתא · המטופל · עו"ס**. Some of those are
on the new list; most are not.

**Rule: when a stored value is non-empty and not on the list, it is rendered as
an extra option pinned at the top of the select and already selected.** Opening
a legacy lead and saving it therefore round-trips the value byte for byte.

```
— ללא —
אישתו          ← the legacy value, pinned and selected
מטופל
אמא
…
```

- A legacy value is **never routed through the «אחר» flow** — that would put it
  in a free-text box and invite an accidental edit. It gets its own option.
- A stored value that **is** on the list (אמא, אבא, עו"ס) simply selects the
  existing option. No duplicate is added.
- **Nothing is mapped.** אישתו stays אישתו — not בן/בת זוג. סבתא stays סבתא —
  not סבא/סבתא. המטופל stays המטופל — not מטופל. חברה stays חברה — not
  חבר/חברה. The tests assert each of these refusals explicitly.
- A legacy row literally holding `'אחר'` also round-trips: it selects «אחר»,
  reveals an empty free-text row, and the empty-text fallback returns `'אחר'` —
  the same fallback `mrCompanionValue` uses in the meeting-report flow.

### What was deliberately NOT done

- **No sheet migration, backfill or cleanup job.** Existing values stay exactly
  as stored.
- **`corruptionScanTargets_` still classifies `contactRelation` as free text**
  (`Code.gs`, `leadText`) and it is **not** added to `leadEnums`. An enum pool
  would flag every legacy value above as corrupt. A test pins this.
- **`LEAD_COLUMNS` is untouched** — same order, same positions, `contactRelation`
  still index 17. `readSheet_` maps cells to keys by POSITION, so this is the
  one thing that must not move; a test pins index 17 and its two neighbours.

## 4. Apps Script

**No `apps-script/Code.gs` change, and none is needed.** This is a frontend-only
form change: the column already exists, already round-trips through
`readSheet_` / `objectToRow_` / `normalizeLead`, and the stored value stays a
Hebrew string exactly as before. There is nothing for the backend to learn
about a list that only governs what the form offers. `git diff` on
`apps-script/` is empty.

---

## 5. Tests — `test/contact-relation-select.test.js`, 39 new

**Full suite: `node --test` — 1133 pass, 0 fail** (1094 before; +39).

Driven through the REAL shipped functions: the inline markup from
`leadContactEditHTML`, and both modals by stubbing `showModal` to capture the
field spec and then firing the **real** `onSubmit` with the values a form would
produce — so the assertions run over the actual save path, not a paraphrase.

- **Surfaces**: all three render a select, not a text input; each pairs it with
  an «אחר» free-text row that starts hidden.
- **Option list**: blank placeholder first, then `CONTACT_RELATION_LABELS`
  exactly and in order — asserted against the constant, against both modals'
  `options`, and against the inline `<option>` markup.
- **Empty**: round-trips as empty through the resolver, the edit modal and the
  add modal.
- **Legacy, off-list** (אישתו · בעל · סבתא · המטופל · חברה — the real strings):
  each is pinned directly after the placeholder, rendered `selected`, not routed
  through «אחר», and survives open-then-save unchanged. Each test first asserts
  its own fixture really is off-list, so it cannot quietly stop meaning
  anything. A separate test spells out the four mapping temptations and refuses
  them.
- **Legacy, on-list** (אמא · אבא · עו"ס): selects the existing option, adds no
  duplicate (option count and per-value count both pinned), round-trips.
- **«אחר»**: typed text is stored and trimmed, never the literal `'אחר'`;
  empty text falls back to `'אחר'`; a plain selection ignores stale free text;
  `contactRelationOther` never reaches the lead record.
- **Schema guards**: `contactRelation` at LEAD_COLUMNS index 17 with
  `contactPhone` at 16 and `billingPhone` at 18; still in `textCols`, still
  absent from `enumCols`.

Each guard was mutation-checked — removing the legacy pinning (10 failures),
making «אחר» always store the literal (3), reverting the edit modal to a text
input (9), and shifting `contactRelation` in LEAD_COLUMNS (1) each turn the
suite red.

---

## 6. Files

| File | Change |
| --- | --- |
| `public/app.js` | `CONTACT_RELATION_LABELS` + pure helpers; `contactRelationFields`; all three surfaces; both save paths; inline «אחר» wiring |
| `public/sw.js` | `CACHE_VERSION` `v10` → `v11` + comment line |
| `test/contact-relation-select.test.js` | **new** — 39 tests |
| `CHANGELOG-contact-relation-select.md` | this file |

Frontend + tests only. No `apps-script/Code.gs`, no `server.js`, no
`public/style.css`, no `package.json`, no new dependency, no new Railway
variable or Script Property.
