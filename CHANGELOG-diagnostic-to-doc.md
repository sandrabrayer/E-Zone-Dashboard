# The ramot diagnostic as a Google Doc — `diagnoseRamotPatientsToDocNow`

**Branch:** `feat/diagnostic-to-doc` · **Base:** `claude/build-ezone-dashboard-QOg5s`
**Files:** `apps-script/Code.gs`, `apps-script/appsscript.json`, `DEPLOY.md`,
`test/diagnostic-to-doc.test.js` (new). Nothing under `public/` changes, so the
service worker is not bumped.

## Why

`diagnoseRamotPatientsNow()` (#147) writes its findings only to the Apps Script
Executions log. That log is awkward to read and to copy out of the editor. This
adds an editor-run wrapper that puts the same lines into a Google Doc.

## What it does

`diagnoseRamotPatientsToDocNow()` does four things:

1. It runs `diagnoseRamotPatientsNow()` exactly as it is. The diagnostic itself
   is unchanged and still writes nothing.
2. It creates **one** new Google Doc with `DocumentApp.create`, named
   **`E-Zone ramot diagnostic YYYY-MM-DD HH:mm`**. The time is Israel time,
   taken from the spreadsheet's time zone (`Asia/Jerusalem` if that can't be
   read).
3. It appends `report.lines` to the Doc's body, **one paragraph per line**, in
   order, with `body.appendParagraph`.
4. It logs the Doc's URL as the last line of the Executions log, right after
   the diagnostic's own `(d) SUMMARY`. It also returns
   `{ name, url, paragraphs }`.

A new Google Doc always starts with one empty paragraph. That empty first line
is left in place, because removing it would need a write other than
`appendParagraph`.

## What it never does

- **It never writes to the spreadsheet.** Its only writes are
  `DocumentApp.create` (once) and `body.appendParagraph` on that new Doc.
- **It never shares, moves or publishes the Doc.** It makes no DriveApp call,
  no Drive advanced service call, and no add-editor or add-viewer call.
  - The Doc lands in the My Drive of whoever runs the function.
  - It gets that Drive's default access for new files. For a normal account
    that means only you can open it.
  - If a Google Workspace admin set a domain-wide link-sharing default, check
    the Doc's **Share** button once.
- **It is not reachable over HTTP.** `handle_`'s fixed action allow-list never
  names it. `doGet` and `doPost` answer `unknown_action`, and no Doc gets
  created. The function is public (no trailing `_`) only so that it appears in
  the editor's **Run** dropdown, the same way the diagnostic does.

**Privacy.** The Doc contains patient names, as the log does. Keep it to
yourself and delete it when the investigation is done.

## Failure behaviour

- **If the Doc can't be created** (for example, the new permission hasn't been
  approved yet), the error is shown. The diagnostic's lines are already in the
  Executions log, because the Doc is attempted only after the diagnostic
  finishes.
- **If filling the Doc fails part-way** (for example, a Docs quota), the log
  first records `FAILED while filling the new Doc …` with the partial Doc's
  URL, so you can find and delete it. Then the error is re-thrown. It is never
  swallowed.

## `appsscript.json` — the Docs scope (⚠️ one-time re-authorization)

The manifest has an explicit `oauthScopes` list, so
`https://www.googleapis.com/auth/documents` was added to it. `DocumentApp`
can't run without that scope, and the existing `drive` scope does not cover
it. Nothing else in the manifest changes: `webapp` still runs as the
deploying user with anonymous access, the time zone is still Asia/Jerusalem,
and the runtime is still V8. The test pins the full scope list, so any future
scope change has to be a reviewed change.

**After this deploys, the owner must approve the new scope once.**

1. Merge this at a time when you can act right away.
2. As soon as the **Deploy Apps Script** workflow run finishes, open the Apps
   Script editor.
3. Pick `diagnoseRamotPatientsToDocNow` in the Run dropdown and press **Run**.
4. Approve Google's permission screen. It asks to see, edit, create and delete
   your Google Docs.

The web app executes as the deploying user. Until that user approves the new
scope, `/exec` requests from the Dashboard, Managers and Therapists **may fail
with «Authorization is required»**. Reload the Dashboard afterwards to confirm
it loads normally.

## How to use it

1. Apps Script editor → Run dropdown → `diagnoseRamotPatientsToDocNow` → **Run**.
2. Open **Executions**. The last log line is
   `diagnoseRamotPatientsToDocNow — N line(s) written to a new private Doc "E-Zone ramot diagnostic …": <URL>`.
3. Open the URL. What each section of the report means is in
   `CHANGELOG-ramot-diagnostic-reland.md`.

`DEPLOY.md` → "Missing-patient diagnostic" has the same steps.

## Tests

`test/diagnostic-to-doc.test.js` has 13 tests. They run the real `Code.gs` in
a vm, against fakes that **refuse and record** every method not explicitly
allowed:

- On the spreadsheet: every mutator.
- On the Doc: everything except `getBody` and `getUrl`.
- On the body: everything except `appendParagraph`.
- Whole services that must not be touched: DriveApp, Drive, MailApp,
  GmailApp, UrlFetchApp, ScriptApp, LockService, PropertiesService and
  CacheService.

What the tests check:

- **Content:** the Doc holds `report.lines`, one paragraph per line, in order,
  and nothing else. The returned `{ name, url, paragraphs }` matches.
- **Writes:** the only writes are `DocumentApp.create` (exactly once) and
  `Body.appendParagraph` (once per line). No refused call of any kind is
  recorded.
- **No spreadsheet writes:** the spreadsheet fakes record no attempt. A source
  scan also finds no mutator, `getOrCreateSheet_`, `logAudit_`, lock or
  property in the wrapper.
- **Source allow-list:** every member call in the wrapper is on a fixed
  allow-list. The only `Code.gs` function it calls is
  `diagnoseRamotPatientsNow`, whose own read-only proof
  (`test/missing-patient-diagnostic.test.js`) covers everything it reaches.
  The diagnostic's source never mentions `DocumentApp`.
- **No sharing, moving or publishing:** no Drive, sharing, mail or fetch call,
  checked both at runtime and in source.
- **The name:** `E-Zone ramot diagnostic YYYY-MM-DD HH:mm` in Israel time.
  Checked in summer (UTC+3) and in winter (UTC+2, across midnight), with real
  time-zone conversion.
- **The URL is logged,** right after the diagnostic's SUMMARY.
- **Filling fails part-way:** the partial Doc's URL is logged and the error is
  re-thrown.
- **The Doc can't be created:** the diagnostic's findings are already in the
  log.
- **Not reachable over HTTP:** `handle_` never names it or `DocumentApp`, and
  `handle_`, `doGet` and `doPost` all answer `unknown_action` with no Doc
  created.
- **Public and declared once.**
- **Manifest:** the pinned scope list includes `documents`, and `webapp`, time
  zone and runtime are unchanged.

**Mutation-checked:** each of 16 deliberate regressions fails at least one
test. They were:

- a spreadsheet `appendRow`;
- DriveApp `setSharing`;
- `doc.addViewer`;
- `saveAndClose`;
- `body.clear`;
- a second `DocumentApp.create`;
- all lines in one paragraph;
- a UTC name;
- a date-only name;
- no URL log;
- a swallowed fill error;
- no partial-URL log;
- an HTTP route in `handle_`;
- a private (`_`) name;
- the scope removed;
- an extra scope.

The existing diagnostic tests (`test/missing-patient-diagnostic.test.js`,
including its read-only closure and additive-only checks) and the
invisible-character guard (`test/code-gs-invisible-chars.test.js`) pass
unchanged. The full suite is green.
