# Make the visitTime repair function runnable: drop the trailing underscore

`repairLeadVisitTimes_` (added in the previous PR) carried a trailing underscore.
Apps Script treats underscore-suffixed functions as **private** and hides them
from the editor's **Run** dropdown — so the one function whose entire purpose is
to be run manually from the editor could never actually be selected and run.

## Fix — `apps-script/Code.gs`
- Renamed **`repairLeadVisitTimes_` → `repairLeadVisitTimes`** (no trailing
  underscore) so it appears in the editor Run dropdown. The two `Logger.log`
  prefixes were updated to match the new name.
- Updated the doc comment to state that it is **intentionally public** so it can
  be run from the editor, and that being public does **not** expose it over HTTP.

## Why public is still safe (verified)
- The web app only serves `doGet`/`doPost`. `handle_` dispatches on a **fixed
  allow-list** of `action` string literals (`getData`, `saveAll`, `moveLeadIrrelevant`,
  …), ending in `return jsonOut_({ ok: false, error: 'unknown_action' })`. There
  is **no** dynamic dispatch (no `this[action]()`, no `[action]()`, no `eval`), and
  the allow-list never names this function — so **no request can reach it**.
- It is **not** attached to any trigger. (The only trigger entry point,
  `rebuildActivePatientsDigest`, is unrelated; making a function public does not
  auto-wire it to anything.)

Removing the underscore therefore makes the function runnable from the editor
without making it callable from the web endpoint.

## References updated
- `test/visittime-text-columns-and-quarter-select.test.js` — the sandbox caller,
  the test title, and the header comment now use `repairLeadVisitTimes`. The
  log-message assertion (`blanked 1 visitTime`) is unaffected.
- `CHANGELOG-visittime-text-columns-and-quarter-select.md` — the run instruction
  and references now use the new name (with a note recording the original name).

Full suite: **263/263 passing** (no test count change — a rename).

## Deploy note
This is in `apps-script/Code.gs` (deployed separately). After the redeploy,
`repairLeadVisitTimes` will be selectable in the editor's Run dropdown — run it
**once** to blank the corrupted legacy times.
