# Re-land the read-only ramot diagnostic (+ section (e), + invisible-character guard)

**Branch:** `reland/ramot-diagnostic` · **Base:** `claude/build-ezone-dashboard-QOg5s`

## Why

PR #145 shipped two things: a client fix in `public/app.js` / `public/sw.js`
(re-activated patients vanishing), and a read-only, editor-run diagnostic in
`apps-script/Code.gs`. After it merged, the live Dashboard stopped loading data,
and #146 reverted all of it.

This PR brings back **only the diagnostic**. Nothing under `public/` changes
here. The reactivation fix, the `v17` service-worker bump, the reactivation
tests and the investigation doc from #145 all stay out.

## What is re-landed (restored from #145, merge commit `efcbfb9`)

| File | What |
|---|---|
| `apps-script/Code.gs` | The `diagnoseRamotPatientsNow` section, appended at the end of the file. It is byte-identical to #145's hunk, then extended with section (e) (below). |
| `test/missing-patient-diagnostic.test.js` | #145's 20 tests, unchanged, plus 8 new ones for section (e) and for the additive-only guarantee. |
| `DEPLOY.md` | The "Missing-patient diagnostic (read-only)" section. Its links now point to this changelog, because #145's changelog and investigation doc are not re-landed. |

### What was checked before re-landing the Code.gs part

- **It is additive only.** The section contains nothing but `function`
  declarations, so no code runs when the script loads. Every one of its names
  is declared exactly once in `Code.gs`, which is now guarded by a test: in Apps
  Script a second declaration would silently replace the first. No existing
  function, constant or sheet header changes.
- **It has zero writes.** Tabs are opened with `getSheetByName` only (never
  `getOrCreateSheet_`) and read with `getValues`. It takes no lock and touches
  no property. Two tests prove this: a source scan over the function and every
  helper it reaches, and a run against a spreadsheet whose every mutator throws.
- **It is not reachable over HTTP.** `handle_` never names it.
- **The file is clean.** #145's `Code.gs` parses, and it has no raw
  invisible or control character anywhere. I did not find the cause of the
  outage in the `Code.gs` half of #145, so this PR doesn't claim to know it.
  The new guard test below closes one way a backend change like this *could*
  take the whole script down.

## New: section (e), for any house (not only ramot)

Section (e) is printed after (c) and **before** the (d) SUMMARY, so the summary
stays the last line of the log. It has two parts.

1. **Rows no house tab can show.** This lists every `Patients` and
   `PatientsTombstones` row whose house doesn't resolve to a known id (`arfoni`,
   `rehab`, `asher`, `pardes`, `ramot`, `sde`). "Resolve" uses the Dashboard's
   own rule, `app.js resolveHouseId`: trim, then exact id, exact Hebrew label,
   or case-insensitive id. Blank houses are included. Each line gives the raw
   house with invisible characters printed as `\uXXXX`, what it resolves to, a
   **"looks like &lt;house&gt;"** hint when exactly one house fits (never a guess
   when two do), id, name, status, entry date, exit date and fromLead. Tombstone
   lines also give reason, droppedAt and savedByAction. Patients lines end with
   the Dashboard's verdict: `INVISIBLE — no house tab shows house …`, or for a
   blank house, `DROPPED by getData_`. The many `saveAll-omitted-preserved`
   audit copies are grouped as one line per house + name, with every row
   number on it.
2. **Permanent deletes in the last 60 days.** This lists every
   `PatientsTombstones` row with reason `user-delete` (the recovery copy the ✕
   delete writes before it removes a row) whose `droppedAt` falls in the last
   60 days. Each line gives the date and how many days ago it was, house, id,
   name, entry date, status, fromLead, **who deleted it and when** (a
   user-delete tombstone stores the deleter in `updatedBy`/`updatedAt`), and
   **whether the patient is back on Patients**, matched by the same id or by the
   same house + name + entry date. A `droppedAt` that can't be read is still
   listed, marked `UNREADABLE date`, so nothing is hidden. Older user-deletes
   are counted in one line.

The SUMMARY line gains:
`(e) any house resolving to no known id: Patients N, PatientsTombstones M; user-deletes in the last 60 days: K`.
The returned report object gains `unresolvedHouseRows`, `recentUserDeletes`
and `summary.{unresolvedHouse, recentUserDeletes, olderUserDeletes, userDeleteWindowDays}`.

### How to run it

1. Merge. The existing **Deploy Apps Script** workflow runs on its own
   (`apps-script/**` changed). Wait for it to go green.
2. Open the Apps Script editor → pick `diagnoseRamotPatientsNow` → **Run** →
   **View → Executions log**.
3. Read the log in this order: (0) header check → (a) ramot rows → (b) U+FFFD
   names → (c) duplicates → (e) any house → (d) summary.

Example (e) lines (synthetic):

```
(e) Patients row 8 | house "arfoni\u200f" → "arfoni\u200f" [no such house; looks like arfoni] | id "id-…" | name "…" | status "active" | … || DASHBOARD: INVISIBLE — no house tab shows house "arfoni\u200f"
(e) user-delete PatientsTombstones row 2 | droppedAt "2026-09-20T…Z" (9 day(s) ago) | house "ramot" [ramot] | id "id-…" | name "…" | … | deleted by "ורד" at "2026-09-20T…Z" || now: not on Patients
```

## New: a guard against raw invisible or control characters in Code.gs

`test/code-gs-invisible-chars.test.js` fails when any `apps-script/*.gs` file
has a **raw** invisible or control character **outside a string literal**:
in code, in a comment, in a regex literal, or in a `${…}` template
expression. The failure names the file, line, column and code point. Why this
matters:

- between tokens (U+200B, U+200E, U+200F …) such a character is a SyntaxError,
  and the whole backend stops answering, `getData` included;
- inside a name (U+200C/U+200D are legal identifier characters) it makes a
  *different* function (`getData` + U+200D + `_` is not `getData_`);
- in a comment or regex it is a Trojan-Source hazard: what a reviewer reads is
  not what runs.

Inside a string literal the character is data (the integrity-alert subject
line legitimately has U+FE0F), so strings are exempt. Write any such
character as a `\uXXXX` escape. The character set covers Unicode categories
Cc (except TAB/LF/CR), Cf, Co, Cs, Cn, Zl, Zp, every Zs except the plain space,
and the default-ignorable letters and marks that render as nothing (Hangul
fillers, variation selectors and similar).

The scanner is a small tokenizer. It is proven on synthetic sources:
detection in each region; strings exempt; escapes not mistaken for raw
characters; a quote inside a regex, `//` inside a string, division vs regex
and nested templates all handled; unterminated constructs reported. On the
real file it must end cleanly and cover every byte, so a tokenizer mistake
can't quietly exempt code. A companion check requires any raw U+FFFD to sit
only inside a string or regex literal.

Writing this test surfaced a real hazard in how these edits are made: an
escape typed as `\u05be` in an editing tool can land in the file as the raw
character. Two such spots in this PR's own drafts were caught and written
back as escapes. That is exactly what the guard is for.

## Tests

- `test/missing-patient-diagnostic.test.js`: **28** (20 from #145 + 8 new: (e)
  listing and lookalikes, (e) user-deletes over a frozen clock, including the
  exact 60-day edge, a Date-typed cell, an unreadable date, and back-by-id /
  back-by-stay; (e) read-only with SUMMARY last; (e) "none" and missing tabs;
  `diagKnownHouseIds_` pinned to `app.js HOUSES`; `diagHouseLookalike_`;
  `diagTimeMs_`; additive-only).
- `test/code-gs-invisible-chars.test.js`: **9**.
- Mutation checks run while writing this PR: the window edge moved to
  exclusive, the lookalike guessing on ambiguity, the user-delete filter
  dropped, blank houses skipped, and a raw U+200F injected into `Code.gs` code,
  a comment, and before a regex statement. Each one made a test fail. The same
  U+200F inside a string literal passed, as intended.
- Full suite: green (see the PR for the count).

## Not changed

- No file under `public/`, so no service-worker bump. `CACHE_VERSION` stays
  `v16` on the base branch. The next PR that changes `public/` goes straight
  to **`v18`**, never `v17`, which #145 used and phones have cached.
- No new endpoint, Script Property, sheet or column. No change to any existing
  function's behavior.

## Rollback

Revert this PR. The diagnostic only does anything when someone runs it from
the editor, so nothing depends on it.
