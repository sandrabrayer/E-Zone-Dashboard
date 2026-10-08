# Personal PINs — PR B: the live login, with a 7-day dual-accept window

Plan: `docs/billing-control-plan.md` §11.2, §11.5 (decisions locked
2026-10-01/02). Builds on PR A (#162, `CHANGELOG-personal-pins-foundation.md`).
Branch `feat/personal-pins-login` → base `claude/build-ezone-dashboard-QOg5s`.
`apps-script/Code.gs` is **not changed** (no Apps Script deploy is needed).
Service worker `CACHE_VERSION` v25 → **v26**.

**What users see after this PR:** a new login screen. They tap their name, then
type their own 6-digit code. For 7 days a small link «כניסה עם הקוד המשותף»
still opens the old 4-digit field. Whoever uses it sees an amber banner until
they switch.

> ⚠️ **Set `APP_PIN_UNTIL` in Railway BEFORE you merge** (step 2 below). Without
> it, the shared code stops working the moment this PR deploys, and everyone
> who has no personal code yet is locked out.

## Read-only investigation (2026-10-02)

| Claim | Verified |
|---|---|
| PR A is merged into the deploy branch and its pieces are in place | ✅ `lib/pin-hash.js`, `lib/users.js`, `lib/rate-limit.js` (`PinLockout`, built and not wired), `lib/session.js` (the 4-part personal cookie), `POST /api/bootstrap-pin`. |
| A personal cookie whose `pinVersion` changed, or whose record is revoked, already gets 401 | ✅ `sessionAuthStatus` → `resolvePrincipal`. This PR adds an end-to-end test: log in → Railway redeploys with the reset or revoked record → the old cookie gets 401 on `/api/me`, GET and POST `/api/sheets`. |
| Un-void is Sandra-only in `Code.gs` and needs a valid `PROXY_SECRET` | ✅ `upsertPayment_`: the session name must be `סנדרה` **and** the request must pass `proxyGate_`. A shared session can never carry `סנדרה`: the picker list is `ורד/שירן/יעל`. A personal session carries the record's name. So the rule works from Sandra's personal session with **no `Code.gs` change**. This is tested end to end: server → the exact forwarded body → `Code.gs`, in log and in enforce mode. |
| The service worker never caches `/api/*` | ✅ `cacheStrategy()` → `network-only` for any `/api/` path. Tested for every login route. |
| The meeting-report PIN is separate | ✅ It has its own `MEETING_REPORT_PIN`, its own counter (`mrPinAttempts`) and its own cookie scope. Not touched. |
| **The weekly healthcheck logs in with `APP_PIN`** | ⚠️ `scripts/healthcheck.js` posts `{ pin: APP_PIN }`. After `APP_PIN_UNTIL` it gets `403 shared_pin_closed`, so **the Saturday healthcheck will fail and email you** until PR C gives it its own credential. That needs a decision, so it is not changed here (see "Known items"). |

## What changed

### Server (`server.js`)

- **`POST /api/verify-pin` has two shapes.**
  - **`{ userId, pin }` — personal.**
    - The PIN is checked against that user's `USER_PIN_HASHES` record:
      scrypt + `PIN_PEPPER`, constant-time.
    - It always costs **one** derivation. A user who is unknown, inactive or
      revoked gets the same `401 invalid_pin`, in the same time.
    - Success mints the personal cookie, which carries the id and the
      `pinVersion`.
  - **`{ pin [, user] }` — the shared `APP_PIN`.** Only while the dual
    window is open.
    - Success mints the shared cookie, the same format as before PR B,
      `auth:'shared'`, **staff only**.
    - Window closed → `403 shared_pin_closed`. The PIN is **not** checked, so
      a retired secret cannot be tested.
- **Limits (PinLockout, now wired).** Every limit is checked **before** any PIN
  work. A locked user costs no scrypt.
  - **5 failures per user → that user is locked for 15 minutes.** The fifth
    wrong code already answers `429 locked`, and so does the right code
    during the lock, from any IP.
  - **10 per IP per 15 minutes** and **30 in total per 15 minutes** →
    `429 rate_limited`.
  - The personal and the shared logins **share** the IP counter and the total
    counter, so neither can be used to get around the other's limit.
  - The IP is `req.ip` (Railway's single hop), so a fake `X-Forwarded-For`
    cannot get around the limits (tested).
  - A success clears that user's counter and that IP's counter, never the
    total counter.
- **`APP_PIN_UNTIL`** (new Railway variable): `YYYY-MM-DD`, the **last** day
  the shared code works. It counts in Israel time (`Asia/Jerusalem`), and the
  day itself is included.
  - Unset, invalid, already past, or more than 14 days ahead → the shared code
    is refused.
  - When the window is closed, **every existing shared cookie also gets
    401**. A shared cookie minted on the last day cannot outlive the window.
  - The window is checked on every request, so it closes at midnight without
    a redeploy.
  - The startup log prints one line, for example:
    `[config] APP_PIN dual-accept window: OPEN until 2026-10-09 (inclusive, Asia/Jerusalem)`
    or `… CLOSED (APP_PIN_UNTIL is not set) …`. It never prints a PIN, a hash
    or the pepper.
- **`GET /api/login-users`** (open): the names for step 1.
  - It lists **only** users with an **active** record, as `{ id, name }`. No
    role, hash or version.
  - Ortal (inactive in the model) and revoked users are never listed.
  - It also returns whether the shared link may be shown, and until when.
- **`GET /api/me`** now also returns:
  - `auth` (`personal` / `shared`)
  - `approver` (true only for Sandra's personal session)
  - `sharedUntil` (`DD/MM/YYYY`, for the banner)

  `user` is unchanged.
- **«קוד אישי חדש» (Sandra only).**
  - **The routes:**
    - `GET /api/pin-admin/users` → the model users, each with `hasRecord` and
      `status` (Ortal is not offered).
    - `POST /api/pin-admin/record { userId, pin, pin2 }` →
      `{ ok, record:'<one JSON line>' }` and **nothing else**.
  - **Who may use them:** only a **current personal session of Sandra with the
    approver role**. A shared session, or anyone else → `403`. No session →
    `401`.
  - **The record line:**
    - **New user:** `pinVersion` 1 and the model roles.
    - **Reset** (an existing record): `pinVersion` = current + 1, and the
      record's own roles are kept, so a narrowed user stays narrowed. A reset
      also makes a revoked user active again.
  - **Refusals:**
    - weak PIN (`000000`, `123456`, all the same digit, a run up or down,
      anything that is not 6 digits) → `400 weak_pin`
    - the two entries differ → `400 pin_mismatch`
  - **Rate limit:** 10 calls per 15 minutes per IP, and 10 in total. Every
    call counts.
  - **The PIN** is never stored, logged or echoed (tested).
- **Logout** clears the cookie (`Max-Age=0`), as before. Verified end to end.

### Client (`public/index.html`, `public/app.js`, `public/style.css`)

- **The login screen**, RTL:
  - **Step 1:** one big button per name, at least 56 px tall.
  - **Step 2:** the 6-digit field (`inputmode="numeric"`, `maxlength="6"`,
    `autocomplete="off"`), plus «זה לא אני — החלפת שם».
  - **The remembered name:** the last name chosen is kept on the device
    (`localStorage`, wrapped in try/catch), and the next login opens straight
    at step 2. The login also works when the browser blocks storage.
  - **The shared link:** during the window, «כניסה עם הקוד המשותף» opens the
    old field (`#pin-input`, still `maxlength="4"`). After the code, the old
    «מי מתחבר/ת?» picker appears, exactly as before.
  - **Hebrew errors:**

    | Response | Message |
    |---|---|
    | wrong code | «קוד שגוי» |
    | user locked | «נעול ל־15 דקות — יותר מדי ניסיונות שגויים» |
    | rate limited | «יותר מדי ניסיונות — נסו שוב בעוד כמה דקות» |
    | not configured | «הכניסה עוד לא הוגדרה בשרת — פנו לסנדרה» |
    | shared code closed | «הקוד המשותף כבר לא בתוקף — היכנסו עם קוד אישי» |

  - **Names are escaped:** every name goes through `escapeHtml`.
- **The shared-session banner:** amber, always shown, no close button:
  «נכנסת עם הקוד המשותף — עד DD/MM/YYYY יש לעבור לקוד אישי».
- **«קוד אישי חדש»** button in the header, shown only when `/api/me` says
  `approver`.
  - It opens a dialog: pick the user, type the code twice, then «יצירת שורה».
  - It shows the line, a «העתקה» button and 5 short Hebrew steps. A reset gets
    different steps from a new user.
  - The PIN fields are cleared the moment the request is sent.
- **The «unauthorized» toast:** every load without a session used to show it
  for 6 seconds, behind the login screen, and it was still visible after a
  fast login. A 401 now shows only the login screen.
- **Service worker** v25 → v26, so no phone keeps the old 4-digit-only login.

### `lib/`

- **New: `lib/shared-pin-window.js`** handles the window: parsing, Israel day,
  the 14-day cap, `DD/MM/YYYY`, and the startup line.
- **`lib/rate-limit.js`:** `PinLockout` accepts `userId: null` for the shared
  login. That skips the per-user counter and keeps the IP and total counters.
- **`lib/users.js`:**
  - `loginUsers(registry)` builds the name list.
  - `recordLine(id, hash, v, roles)` takes optional roles, which can only
    narrow, never widen.

## Tests

- **New: `test/personal-pins-login.test.js`**, 23 tests:
  - the name list holds active records only (no revoked user, no Ortal, no
    hash or role)
  - a personal success: the cookie has the id and the version, `/api/me` says
    personal, the PIN is not in the log
  - a wrong PIN, and the same 401 with exactly one derivation for unknown,
    revoked, `constructor` and other junk ids
  - **the per-user lock at 5**, during the lock even with the right PIN and
    from another IP, and **unlocked after the window**
  - per-IP 10 and total 30 across personal + shared, with
    **`X-Forwarded-For` spoofing**
  - no pepper → 503
  - **the window, before / on / after `APP_PIN_UNTIL`**: pure, including 23:30
    and 00:30 Israel time, and over HTTP. Unset, invalid and too far are
    refused, the PIN is not checked, and an existing shared cookie gets 401
    once the window is closed.
  - **a shared session is staff only, and the banner shows**
  - **the new-code page:**
    - 401 with no session
    - **403** for shared, Vered, Shiran, and a stale Sandra cookie
    - returns **only** a line, and that line validates and verifies the PIN
    - new → v1; **reset → current + 1**, keeping narrowed roles; Sandra's own
      code is a reset; a revoked user becomes active again; Ortal is refused
    - **the PIN is never logged or echoed**
    - **a weak PIN is rejected**, and so is a mismatch
    - 429 after 10
  - **a reset or revoked user is logged out** (401 everywhere), and logout
    clears the cookie
  - **un-void from Sandra's personal session works; from Vered's personal
    session or a shared one it is refused.** Tested end to end, log and
    enforce mode.
  - **`getData` keeps its keys**
  - the meeting-report PIN is unchanged
  - the Hebrew error messages
  - **`escapeHtml` on names**
  - the remembered name, and no storage
  - the admin steps and labels
  - the `index.html` fields
  - SW v26, with the login and API routes never cached
- **New: `test/personal-pins-login-browser.test.js`** runs in **real Chromium at
  360px**. It covers:
  - step 1 (names, at least 48 px tall, RTL, no horizontal scroll)
  - step 2 (a wrong code shows «קוד שגוי», the field is cleared)
  - entering the app
  - «קוד אישי חדש» (weak code refused, a line made, the fields cleared)
  - logout keeps the name
  - the shared link and code, the picker and the amber banner
  - no leftover error toast and no page errors

  Screenshots are in `docs/screenshots/personal-pins-login/`.
- **Updated** (each one pinned a behavior this PR changes on purpose):
  - **Opening the window in setup.** A shared cookie now needs the window
    open, so each of these sets `APP_PIN_UNTIL` to 7 days from today:
    - `test/api-auth.test.js`
    - `test/patient-who-when.test.js`
    - `test/name-picker-conflicts.test.js`
    - `test/xlsx-export.test.js`
    - `test/debt-aging-ui.test.js`
    - `test/meeting-report-server.test.js`
    - `test/proxy-secret-transition.test.js`
  - **`test/personal-pins-foundation.test.js`:**
    - the window is open in `BASE_ENV`
    - `/api/me` has more keys
    - `PinLockout` is now wired
    - the shared field is still 4, plus the new 6-digit field
  - **`test/patient-who-when.test.js`:** the source scan now reads
    `validateSessionUser(b.user)`.
  - **`test/billing-tab-section-colors.test.js`:** the SW version is "v25 or
    later".
- **Full suite: 1894 / 1894** (1870 on the base `a5e2a9b` + 24 new). The run
  includes every browser test (Playwright + Chromium present), with 0 skipped.

## Choices I made (ambiguous points — the safest reasonable option)

1. **Existing shared cookies die with the window.** Once `APP_PIN_UNTIL` has
   passed, or is unset, every shared cookie gets 401, not only new APP_PIN
   logins. Otherwise a cookie minted on the last day would keep the shared code
   alive for 7 more days.
2. **`APP_PIN_UNTIL` more than 14 days ahead is refused** (`too_far`). The
   decision is 7 days, and a typo such as `2027-10-09` must not keep the shared
   code for a year.
3. **The fifth wrong code already answers «נעול ל־15 דקות»**, not one more
   «קוד שגוי», so the person knows to stop.
4. **The shared login shares the per-IP (10) and total (30) counters** with
   the personal login, and has no per-user counter. A "shared" user bucket
   would let anyone lock the shared code for everybody with 5 tries.
5. **Ids of the wrong shape share one lock bucket (`?`)**, so junk ids cannot
   fill the per-user map or get around the lock.
6. **A closed window answers `403 shared_pin_closed` without checking the
   PIN**: the same answer for a right and a wrong code.
7. **«קוד אישי חדש»:**
   - A reset keeps the record's own roles. A narrowed user stays narrowed.
   - A reset of a revoked user makes them active again. That is the documented
     way to give a code back.
   - Ortal is not offered until Phase 4.
   - Sandra appears only as «איפוס הקוד שלי».
   - Every call counts against the limit, not only failures.
8. **`Code.gs` is unchanged.** The existing un-void rule (the name `סנדרה` +
   a valid `PROXY_SECRET`) already works from her personal session, and a
   shared session cannot carry her name. Approver enforcement through
   `hasRole_` belongs to PR C.
9. **A 401 on load no longer shows the «unauthorized» toast.** The login
   screen is the message.
10. **The old name picker stays** for the shared path during the window, so
    `APP_PIN` users keep their name stamps. PR C removes it together with
    `APP_PIN`.

## Known items for PR C (not changed here)

- **The weekly healthcheck** (`scripts/healthcheck.js`, GitHub secret
  `APP_PIN`) logs in with the shared code. After `APP_PIN_UNTIL` it gets
  `403 shared_pin_closed`, and the Saturday run fails and emails you. PR C
  needs a decision, for example a dedicated read-only healthcheck credential.
  Until then, ignore that one email or disable the workflow after the window.
- **Not yet enforced:** the delete and approver roles (`roleAllowed_`).
  `APP_PIN`, `/api/bootstrap-pin` and the old name picker are still there; PR C
  removes them.

## For Sandra — setup, in order

Do **steps 1–5 before you merge this PR**. They work on the current site,
because PR A already added the bootstrap. Then merge, and do **step 6**.

> Keep `PIN_PEPPER`, `BOOTSTRAP_TOKEN` and every PIN only in Railway and in your
> password manager. Never put them in WhatsApp, email, GitHub or a chat with
> Claude.

### 1. Make two random values, and add them in Railway

**Make them (Chrome, your computer):**

1. Open any page. Press **F12** (Mac: **⌥⌘J**) and click the **Console** tab.
2. Paste this line and press **Enter**:

   ```js
   btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(48)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
   ```

   It prints 64 letters and digits (48 random bytes, base64url).
3. Copy the value **without the quotes**. Run the line a second time for the
   second value.
   - **First value = `PIN_PEPPER`.** It must **never change** after the first
     code is made. Changing it stops every personal code.
   - **Second value = `BOOTSTRAP_TOKEN`.** It is temporary.

> If you already added `PIN_PEPPER` after PR A, **keep it**, don't make a new
> one. You only need a `BOOTSTRAP_TOKEN` if your own record does not exist yet.

**Add them in Railway:**

1. **railway.app** → project **E-Zone Dashboard** → click the **web service**
   (the dashboard) → **Variables** tab.
2. **+ New Variable**:
   - Name `PIN_PEPPER`, Value = the first value → **Add**.
3. **+ New Variable**:
   - Name `BOOTSTRAP_TOKEN`, Value = the second value → **Add**.
4. If Railway shows **Deploy** or **Apply changes**, click it. The deploy log
   then shows `BOOTSTRAP_TOKEN is still set …`. That warning is expected.

### 2. Set the 7-day window — `APP_PIN_UNTIL`

1. Same screen: **+ New Variable**.
2. Name `APP_PIN_UNTIL`. Value = **the date 7 days after the day you will
   merge**, written `YYYY-MM-DD`.
   - Example: merge on Sunday 04/10/2026 → `2026-10-11`.
3. **Add**, then **Deploy** / **Apply changes**.

How it works:

- The shared code works **through the end of that day**, Israel time.
- From 00:00 the next day, it and every shared login stop working.
- The date may be at most 14 days ahead. A later date is refused, so a typo
  cannot keep it alive.
- After the merge, the deploy log says
  `APP_PIN dual-accept window: OPEN until 2026-10-11 …`.

### 3. Make your own record (once)

1. Open the dashboard in Chrome, at its normal address.
2. Press **F12** → **Console**.
3. Paste this and press **Enter**:

   ```js
   (async () => { const token = prompt('BOOTSTRAP_TOKEN'); const pin = prompt('הקוד האישי החדש — 6 ספרות'); const r = await fetch('/api/bootstrap-pin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, pin }) }); const d = await r.json(); console.log(d.ok ? d.record : 'ERROR ' + r.status + ': ' + d.error + (d.reason ? ' (' + d.reason + ')' : '')); })()
   ```

4. Two boxes open:
   - First box: paste the **`BOOTSTRAP_TOKEN`**.
   - Second box: type **your new 6-digit code**. Not `000000`, not `123456`,
     not one digit repeated, not a run up or down.
5. The console prints **one line** that starts with `{"id":"sandra"` and ends
   with `}`. Copy that whole line.
   - `ERROR 400: weak_pin` → choose another code and run it again.
   - `ERROR 404: bootstrap_disabled` → your record already exists (skip to
     step 5), or the token or pepper is missing in Railway.
6. Close the tab.

### 4. Put it in `USER_PIN_HASHES`

1. Railway → **Variables**. Open `USER_PIN_HASHES` if it exists, or click
   **+ New Variable** and name it `USER_PIN_HASHES`.
2. Its value is your line inside square brackets:

   ```
   [ {"id":"sandra", … your whole line … } ]
   ```

3. **Add** / **Update** → **Deploy**.
   - If the deploy **fails** with `[config] USER_PIN_HASHES is invalid …`, the
     paste is broken: a bracket, a quote or a comma is missing. Fix the value
     and deploy again.

### 5. Delete `BOOTSTRAP_TOKEN`

Railway → **Variables** → `BOOTSTRAP_TOKEN` → the **⋮** menu → **Remove** →
**Deploy**. The warning disappears from the log.

**Now merge this PR.** Railway deploys it. Then open the dashboard:

- You see the new login: tap **סנדרה** and type your code.
- The header shows **«קוד אישי חדש»**.

### 6. Make the codes for Vered, Shiran and Yael

Do this for each person:

1. In the dashboard header, click **«קוד אישי חדש»**.
2. **למי?** → pick the person. It says «(חדש)» for a new one.
3. Type their new 6-digit code twice → **«יצירת שורה»**.
4. Click **«העתקה»**.
5. Railway → **Variables** → `USER_PIN_HASHES` → edit. Before the final `]`,
   type a **comma**, then paste the line. With all four people it looks like
   this:

   ```
   [ {"id":"sandra",…}, {"id":"vered",…}, {"id":"shiran",…}, {"id":"yael",…} ]
   ```

6. **Update** → **Deploy**.
   - You can add all three lines, then deploy once.
   - The new person can log in when the deploy finishes.
7. Give each person their code **face to face or by phone**, not on WhatsApp.

Once everyone has logged in with their own code, nobody needs the shared one.
It stops by itself after `APP_PIN_UNTIL`.

### 7. Reset or revoke someone later

**Reset** (a forgotten or leaked code):

1. «קוד אישי חדש» → pick the person. It says «(איפוס)».
2. Type the new code twice → «יצירת שורה» → «העתקה».
3. In `USER_PIN_HASHES`, **replace** that person's whole record, from `{"id"`
   to its `}`, with the new line.
4. **Deploy.** The new line has the next `pinVersion`, so the old code and
   every device logged in as that person stop working.

**Revoke** (someone leaves):

1. In `USER_PIN_HASHES`, find that person's record.
2. Change `"status":"active"` to `"status":"revoked"`.
3. **Deploy.** They are logged out at once, and their name disappears from
   the login screen.
4. To give them a code again later, do a **reset**: it makes the record
   active again.

**Your own code:** «קוד אישי חדש» → «סנדרה — איפוס הקוד שלי». Same steps.
After the deploy, log in again with the new code.
