# WhatsApp share link: fix the encoded-length cap that ate the report

**Branch:** `claude/fervent-planck-145lts` → PR base `claude/build-ezone-dashboard-QOg5s`
(the Railway-deployed branch). Fixes a regression shipped in PR #127.

## The bug

On the manager form's confirmation screen, **«שלח לקבוצה»** produced a WhatsApp
message with the פירוט cut off mid-sentence and the **`דווח ע"י` line missing
entirely** — for any report longer than about 260 characters. A 400-character
report, an ordinary length for a meeting summary, lost three quarters of itself.

Before PR #127 the whole note always went through.

## Root cause: encoded length ≠ raw length (the 6× Hebrew factor)

PR #127 added a cap so a very long report could not produce an unusable deep
link. The cap was written as:

```js
var MR_WA_URL_MAX = 2000;   // counts characters of the ENCODED url
```

and compared against `('https://wa.me/?text=' + encodeURIComponent(message)).length`.

The number 2,000 was chosen as if it were a budget in **message** characters. It
is not — it is a budget in **percent-encoded URL** characters, and Hebrew is
expensive there:

| character | encodes to | cost |
|---|---|---|
| `א` | `%D7%90` | **6 chars** |
| `ש` | `%D7%A9` | **6 chars** |
| space | `%20` | 3 chars |
| newline | `%0A` | 3 chars |

So a 5,000-character Hebrew report is **~30,000** characters of URL, not 5,000 —
a 6× miss. With the five fixed lines of the template already costing 598 URL
characters, the 2,000 budget left **1,402 encoded characters ≈ 240–260 Hebrew
characters** for the note.

Measured on the pre-fix code, with a real Hebrew meeting summary:

| note | encoded url if untouched | url produced | note chars delivered | `דווח ע"י` line |
|---|---|---|---|---|
| 400 | 2,736 | 1,996 | **274** | **dropped** |
| 1,300 | 7,538 | 1,996 | **274** | **dropped** |
| 5,000 | 27,291 | 1,996 | **274** | **dropped** |

**The second half of the bug:** the truncation was applied to the **assembled
message**, so the cut always landed inside the note and everything after it —
the `דווח ע"י` footer — was thrown away with the tail of the report.

## What changed

`public/meeting-report.js` only (plus the SW cache version and tests).

1. **`MR_WA_URL_MAX = 2000` → `60000`** encoded URL characters. A full
   5,000-character Hebrew report encodes to ~30,000, so it fits with ~2× of
   headroom; wa.me deep links and the browser/OS handlers in front of them carry
   that comfortably. The constant now documents that it counts **encoded**
   characters and why the number must clear 6 × 5,000.
2. **Only the note segment can ever be shortened.** `mrWhatsAppShareMessage()`
   bisects over the **note's** length, re-assembling the whole message on each
   probe, so the four header lines (`דיווח פגישה` / `ליד` / `תוצאה` /
   `הגיע/ה עם`) and the `דווח ע"י` footer are fixed overhead on both sides of the
   cut and **always survive intact**. When a cut is needed the `…` goes on the
   note, and the footer still comes after it.
3. **`mrWhatsAppLink()` is a plain encoder again** — it encodes and nothing else,
   so "what goes in is what the recipient reads". The fitting logic lives in one
   named place instead of hiding inside the URL builder.
4. `mrWithNote(saved, note)` returns a copy with a different note and never
   mutates the caller's object. `mrSafeCut`'s surrogate-pair handling is
   unchanged and still used, so an emoji can never split and break the link.
5. The button's href now comes from `mrWhatsAppShareUrl(saved)`.
6. **The stored report is untouched**, exactly as before: this shortening exists
   only so the share button keeps working. The sheet always holds the full text.

After the fix, the same three cases:

| note | url produced | note delivered | `דווח ע"י` line | `…` |
|---|---|---|---|---|
| 400 | 2,736 | **400 (full)** | present | no |
| 1,300 | 7,538 | **1,300 (full)** | present | no |
| 5,000 | 27,291 | **5,000 (full)** | present | no |
| 60,000 (synthetic, past the cap) | 59,997 ≤ 60,000 | ~9,900 + `…` | **present** | on the note only |

## Files changed

| File | Change |
|---|---|
| `public/meeting-report.js` | the cap (2000 → 60000) + note-only shortening: `mrWhatsAppShareMessage`, `mrWhatsAppShareUrl`, `mrWithNote`; `mrWhatsAppLink` back to a pure encoder; button wiring |
| `public/sw.js` | `CACHE_VERSION` **v7 → v8** — no phone may keep serving the v7 bundle that still truncates |
| `test/manager-report-length.test.js` | section 7 rewritten (see below) |
| `CHANGELOG-whatsapp-report-cap.md` | this file |

No Apps Script change, no server change, no schema change. The field cap itself
(`MANAGER_REPORT_MAX_CHARS = 5000`) is untouched in all four layers.

## Tests

`node --test` — **1005 → 1010 (+5 net: 2 weak tests removed, 7 added), all green.**

Section 7 of `test/manager-report-length.test.js` was rewritten around **real
Hebrew** strings (a repeated realistic meeting summary with punctuation and line
breaks, not a repeated single letter and never Latin placeholders):

- **the encoded-cost assumption is asserted explicitly** —
  `encodeURIComponent('א').length === 6`, space and newline at 3, and
  `MR_WA_URL_MAX > 6 × MANAGER_REPORT_MAX_CHARS`;
- **400-char Hebrew report** — the note is delivered in full, the פירוט segment
  equals the note exactly, `דווח ע"י` is present, no `…`. *This is the case that
  passed silently before; run against the pre-fix builder it now fails on all
  four assertions (274 of 400 chars delivered, footer gone).*
- **1,300 and 5,000-char reports** — note in full, all four header lines intact,
  the footer is the **last** line, no `…`, url under the cap;
- **past the cap (60,000-char note)** — url fits and uses nearly all of the
  budget, headers intact, footer still the last line, exactly **one** `…` and it
  is inside the note, the surviving note is thousands of characters (not a few
  hundred) and is a real prefix of the report, and the stored report is untouched;
- the share message is **identical** to the plain message whenever it fits;
- `mrWhatsAppLink` never truncates — it only encodes;
- `mrWithNote` does not mutate the caller;
- `mrSafeCut` surrogate handling, end-to-end with an emoji report past the cap
  (footer intact, no U+FFFD).

**Removed:** the old assertion at `test/manager-report-length.test.js:463`, which
only checked `text.endsWith('…')` and `startsWith('דיווח פגישה')` — true of a
message that had lost 95% of its content, which is exactly why the regression
shipped green. The old "a short report produces the full, untouched wa.me
message" test was folded into the stronger segment assertions above.

Two stale guards in the same file were corrected: the source scan no longer
expects a surviving `2000` in the form bundle (there is none), and the guard
self-check's out-of-scope example now reads `MR_WA_URL_MAX = 60000`.

## Decisions made

1. **`mrWhatsAppLink` was reverted to a pure encoder** rather than keeping a
   second cap inside it. Two places enforcing the same budget is how the first
   version went wrong; now exactly one function decides what gets sent, and the
   encoder is trivially correct.
2. **Bisection kept** (over the note instead of the message) rather than
   estimating from a 6-chars-per-letter rule of thumb: mixed Hebrew/Latin/digits
   /emoji make any estimate wrong in one direction or the other, and the probe is
   exact for whatever the text actually is.
3. **A report that hits the cap still gets `…` and not a refusal.** The share
   button is a convenience; refusing to build a link would be worse than sending
   a marked-short message. The refusal behaviour stays where it belongs — on the
   field cap at submit time.
4. **The header-blows-the-budget case is documented, not coded around.** It is
   unreachable (the note is capped at 5,000 and the rest is a handful of names);
   if it ever happened the note would shrink to `…` and the structure would still
   be intact.
5. **`CHANGELOG-manager-report-length.md` was left as written.** It records what
   PR #127 shipped, including the cap as it then was; this file supersedes its
   WhatsApp section rather than rewriting history.

## Deploy notes

- **Railway** auto-deploys from `claude/build-ezone-dashboard-QOg5s` on merge.
- `public/sw.js` `CACHE_VERSION` **v7 → v8**, so returning phones evict the v7
  copy of `meeting-report.js` and stop truncating on the next visit.
- **No Apps Script change** — `apps-script/**` is untouched, so the clasp CI
  deploy workflow does not fire and nothing needs a manual paste.
- No new environment variables, Script Properties or sheet columns.
