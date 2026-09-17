# דיווח מנהל — the פירוט field goes from 2,000 to 5,000 characters

**Branch:** `claude/fervent-planck-145lts` → PR base `claude/build-ezone-dashboard-QOg5s`
(the Railway-deployed branch, NOT the repo default).

## What

The manager's meeting report on a lead ("דיווח מנהל" — the block with
**הגיע/ה עם**, **פירוט**, **דווח ע"י** and an outcome such as
"התקיימה — מתקדם לכניסה") capped **פירוט** at 2,000 characters. The cap is now
**5,000** characters, carried by a single named constant in every layer, and it
**refuses** over-long text instead of silently trimming it.

## Why

House managers write the whole meeting summary into פירוט — what was discussed,
the family's questions, the clinical impression. 2,000 characters cut that short,
and the cut was invisible at the form: the browser's `maxlength` simply stopped
accepting keystrokes, with no counter and no message. A report that reaches Vered
half-written is worse than one that is refused out loud, so the new cap is
enforced as a **rejection with a Hebrew message** at every layer, and the UI now
shows how much room is left.

## Findings — every limit on this text (file:line as of `73dddbc`, the base)

| # | Where | Old limit | Verdict |
|---|---|---|---|
| 1 | `public/app.js:2096` | `const MEETING_REPORT_NOTE_MAX = 2000;` | renamed → `MANAGER_REPORT_MAX_CHARS = 5000` |
| 2 | `public/app.js:2094` | doc comment "note capped at 2000" | rewritten to name the constant |
| 3 | `public/app.js:2105-2106` | `if (String(note).length > MEETING_REPORT_NOTE_MAX)` → Hebrew error | uses the constant; message now names the length sent |
| 4 | `public/app.js:2162` | `<textarea name="mrvNote" rows="3" maxlength="${MEETING_REPORT_NOTE_MAX}">` | `maxlength="${MANAGER_REPORT_MAX_CHARS}"`, `rows="6"`, auto-grow + counter |
| 5 | `public/app.js:1988` | saved report rendered in a bare `<div>` — **newlines collapsed** | wrapped in `<span class="mrv-note">` with `white-space: pre-wrap` |
| 6 | `public/meeting-report.html:44` | `<textarea id="mr-note" maxlength="2000">` | `maxlength="5000"` + a live counter element |
| 7 | `public/meeting-report.js:148` | `bad_note: 'הפירוט ארוך מדי (עד 2000 תווים)'` | built from the constant |
| 8 | `public/meeting-report.js:135-137` | `mrWhatsAppLink` — **no cap at all** on the wa.me URL | message-only shortening at `MR_WA_URL_MAX = 2000` encoded chars |
| 9 | `apps-script/Code.gs:4218-4219` | `if (note.length > 2000)` + English `'note is limited to 2000 chars'` | constant + Hebrew refusal, still `error: 'bad_note'` |
| 10 | `apps-script/Code.gs:4194` | doc comment "note over 2000 chars" | rewritten to name the constant |
| 11 | `server.js:925-959` (`POST /api/meeting-report/submit`) | **no validation** — the note was forwarded verbatim | added a pre-check that refuses >5,000 with a Hebrew message (see "Decisions made") |

### Checked and found NOT to limit this field

* `server.js:298` `responsePreview(data, max)` — caps the **upstream response
  preview** written to the diagnostics log, not the report. Untouched.
* `server.js:721, 736` — 2,000-char debug previews of the *outpatient* response.
  Unrelated.
* `apps-script/Code.gs:4393` `creditStr_(v, max)` — credits-ledger field caps.
  Unrelated.
* `apps-script/Code.gs:720` `requestUser_` — 40-char cap on the session user name.
  Unrelated.
* **getData / read path**: `readSheet_` + `LEAD_COLUMNS` (`meetingNote` at
  `Code.gs:263`, `1275`) read the cell verbatim — no truncation anywhere on the
  read path.
* **saveAll / mergeLeads_ path** (Vered's edit): no length check existed and none
  was added beyond the client-side `validateMeetingReportEdit` mirror — the write
  authority for the manager form stays `submitMeetingReport_`.
* `Code.gs:2704` `corruptionScanTargets_` lists `meetingNote` as free text that
  the enum/roster repair tiers must never touch. Correct as-is.
* `public/app.js` WhatsApp builders (`meetingWhatsappMessage`,
  `leadWhatsAppLink`, the meeting-invite messages) never carry `meetingNote` —
  only the manager form's `mrWhatsAppMessage` does.

### ezone-managers follow-up: **none**

The דיווח מנהל report is **entered in THIS repo**, not in `ezone-managers`: the
form is `public/meeting-report.html` + `public/meeting-report.js`, served by
`server.js` at `/meeting-report` behind its own PIN (`MEETING_REPORT_PIN`,
`server.js:829-852`) and written by `submitMeetingReport_` in this repo's
`apps-script/Code.gs`. `ezone-managers` is the bonus / occupancy app and owns no
part of this field. **No other repository was touched and none needs the same
change.**

## Files changed

| File | Change |
|---|---|
| `apps-script/Code.gs` | `MANAGER_REPORT_MAX_CHARS = 5000`; `submitMeetingReport_` refuses over-cap with a Hebrew `bad_note` message (own commit) |
| `server.js` | `MANAGER_REPORT_MAX_CHARS` + `meetingReportNoteError()`; the submit route refuses >5,000 with HTTP 400 before the Apps Script round trip; both exported for tests |
| `public/meeting-report.js` | constant + derived warn threshold; `mrNoteError`, `mrNoteCounterText`, `mrNoteCounterWarn`, `mrSafeCut`; wa.me message shortening; submit-time refusal; counter + auto-grow wiring; confirmation note in a `pre-wrap` span |
| `public/meeting-report.html` | textarea `maxlength="5000"` + `#mr-note-count` counter element |
| `public/meeting-report.css` | `--warning`, `.mr-count` (+`.warn`), `.mr-note-text` (pre-wrap), `#mr-note` wrapping |
| `public/app.js` | constant (replacing `MEETING_REPORT_NOTE_MAX`), counter helpers, edit-modal textarea + counter + auto-grow, saved report in a `pre-wrap` span |
| `public/style.css` | `.mrv-note` (pre-wrap, no clipping), `.modal .mrv-note-input`, `.modal .mrv-note-count` (+`.warn`) |
| `public/sw.js` | `CACHE_VERSION` **v6 → v7** (app.js, style.css and the meeting-report assets all changed) |
| `test/manager-report-length.test.js` | **new** — 22 tests (see below) |
| `test/meeting-report-backend.test.js` | over-cap case 2001 → 5001 chars |
| `test/meeting-report-edit-delete.test.js` | modal `maxlength` and validator boundaries moved to 5,000 |
| `CHANGELOG-manager-report-length.md` | this file |

## Behaviour after the change

* **Form (`/meeting-report`)** — the textarea accepts 5,000 chars, grows with the
  text (up to 520px, then scrolls itself), and a counter reads `X / 5000` under
  it, turning amber past 4,500. The page stays `dir="rtl"`; the counter's digits
  are wrapped in a Unicode LTR isolate (U+2066…U+2069) so the RTL page cannot
  re-order them into `5000 / 0` — the same trick `mrPickerDate` already used.
* **Over the cap** — refused, never trimmed, at three independent layers: the
  form (`mrNoteError`), the proxy (`meetingReportNoteError`, HTTP 400) and Apps
  Script (`submitMeetingReport_`, `bad_note`). Nothing partial is written to the
  sheet. Every message is Hebrew and names lengths only.
* **Saved report** — renders escaped (`escapeHtml` unchanged) inside
  `white-space: pre-wrap`, so the manager's own line breaks survive and the full
  text is visible: no `max-height`, no `overflow: hidden`.
* **WhatsApp** — the stored report is always the full text. Only the share
  message is shortened, and only when the encoded `wa.me/?text=…` URL would
  exceed 2,000 characters; the cut is marked with `…` and never splits a
  surrogate pair (an emoji can't break the link).
* **Logging** — no layer logs report text. `server.js` records only
  `noteLength` on a refusal; the write log still stores a redacted preview of the
  *backend response*, which carries no note.

## Tests

`node --test` — **983 → 1005 (+22), all green.**

`test/manager-report-length.test.js` (22 tests):

1. `MANAGER_REPORT_MAX_CHARS` is 5000 in all four layers.
2. The amber threshold is derived (`round(5000 × 0.9) = 4500`), not a second literal.
3. **Source-scan guard** — no numeric literal caps this field anywhere: every
   code line (comments stripped) that names the field *and* a length word must
   carry no bare 3+-digit number except the constant's own declaration.
4. Guard self-check — the scan provably catches `maxlength="2000"`,
   `note.length > 2000`, `note.slice(0, 2000)` and `'עד 2000 תווים'`, and provably
   ignores `res.status(400)`, `MR_NOTE_MAX_HEIGHT` and `MR_WA_URL_MAX`.
5. Each layer declares the constant exactly once, as 5000.
6. The old 2,000 cap is gone from every פירוט path.
7. The textarea `maxlength` mirrors the constant in both UIs.
8. Code.gs: **4,999 and 5,000** Hebrew chars accepted and stored in full.
9. Code.gs: **5,001** rejected (`bad_note`, Hebrew message), sheet untouched — no
   truncated write, no `meetingReportedAt` stamp, and the refusal never echoes the text.
10. server.js: 4,999/5,000 pass, 5,001 gets the Hebrew refusal.
11. The form refuses 5,001 before any network call.
12. Vered's edit modal validates against the same cap.
13. The `bad_note` error text quotes the raised cap.
14. **Round trip**: a 5,000-char Hebrew string (punctuation, line breaks, niqqud)
    survives write → read-back → JSON hop → UTF-8 round trip with **no U+FFFD**.
15. **Render**: a long multi-line report is escaped (`<script>` neutralised, `&`
    and quotes escaped), keeps its newlines, and its full 4,000-char run is present.
16. `.mrv-note` / `.mrv-detail` / `.mr-note-text` carry `pre-wrap` and no
    `max-height` / `overflow: hidden` that could clip the report.
17. Counter text is LTR-isolated and reads `X / 5000`; amber strictly above 4,500.
18. The form page carries the textarea and the counter element and stays RTL.
19. A short report yields the full, untouched wa.me message.
20. A 5,000-char report shortens **only** the WhatsApp message (marked `…`, header
    intact, near the full budget) while the saved report stays 5,000 chars.
21. `mrSafeCut` never splits a surrogate pair; an emoji-laden 5,000-char report
    still builds a valid link.
22. The SW cache version is declared once and is ≥ v7.

## Decisions made

1. **Two frontend constants, not one shared module.** The brief asked for "one
   constant on the frontend", but `public/meeting-report.js` deliberately has
   **no dependency on app.js** (managers must never load the dashboard bundle —
   an existing, security-relevant rule with its own keep-in-sync tests). So the
   constant is declared once per bundle under the *same name*, and the source-scan
   guard fails the build if any of the four declarations drifts. Safest option:
   it preserves the isolation rule instead of introducing a shared import.
2. **`server.js` now validates, although it previously did not.** The brief said
   "and server.js if it validates". It did not validate at all — it forwarded the
   note verbatim. A pre-check was added anyway (defence in depth, and it saves a
   pointless Apps Script round trip), using the **existing** `bad_note` error code
   so the client's error map and the user-visible Hebrew text are unchanged.
   Apps Script remains the authority.
3. **HTTP 400 for the new refusal.** The route's other failures already use
   status codes (503 not-configured, 502 unreachable) and the client only
   special-cases 401, reading `data.ok` otherwise — so a 400 carrying
   `{ ok:false, error:'bad_note' }` is consistent and changes nothing for the
   browser.
4. **Warn threshold derived, not configured.** Amber at >4,500 is
   `round(MANAGER_REPORT_MAX_CHARS × 0.9)`, so the next cap change moves it
   automatically and the "no second literal" guard stays true.
5. **`MR_WA_URL_MAX = 2000` was kept as its own named constant.** It is the
   WhatsApp *link* budget ("~2000 chars" in the brief), a different thing from the
   field cap; the guard test explicitly proves it is out of scope.
6. **The old `MEETING_REPORT_NOTE_MAX` name was retired rather than kept as an
   alias**, so exactly one name exists for this cap. `MEETING_REPORT_COMPANION_MAX`
   (100, the "הגיע/ה עם" free text) is a different field and was left alone.
7. **Auto-grow is capped** (520px on the form, 420px in the modal) and then the
   textarea scrolls itself — an uncapped 5,000-char box would push the submit
   button off a phone screen.
8. **No sheet-side migration.** Existing reports are unaffected; the column is
   plain text and Google Sheets' own cell limit (50,000 chars) is far above the
   new cap.

## Deploy notes

* **Railway (frontend + proxy)** — auto-deploys from
  `claude/build-ezone-dashboard-QOg5s` on merge. `public/sw.js` `CACHE_VERSION`
  was bumped **v6 → v7**, so returning phones evict the old `app.js` / `style.css`
  / meeting-report assets on the next visit instead of running the 2,000-char UI
  against the 5,000-char backend.
* **Apps Script (`apps-script/Code.gs`)** — **deploys automatically via the clasp
  CI workflow** (`.github/workflows/deploy-apps-script.yml`) when this PR merges
  to the deployed branch, because the diff touches `apps-script/**`. It republishes
  the **existing** deployment, so the `/exec` URL does not change. **No manual
  paste into the Apps Script editor.** The `Code.gs` change is in its own commit
  to keep that trigger clean.
* **Order of effect** — the backend accepts 5,000 chars as soon as the clasp job
  finishes; until then the old backend would refuse a >2,000-char report with the
  existing `bad_note` error, which the form already surfaces in Hebrew. Nothing
  can be silently lost in the gap.
* **No new environment variables, Script Properties or sheet columns.**
