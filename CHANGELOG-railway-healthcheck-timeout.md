# Railway healthcheck window 30 s → 300 s

October 28, 2026. `railway.json` only — no `public/`, no Code.gs, no SW bump,
no Railway UI change (Railway reads `railway.json` from the commit it deploys).

## Why

Since this morning every deploy of the deployed branch after #303 **failed at
«Network › Healthcheck»** — #308 (`ed88474`), #310 (`e0dde39`) and others —
while **Initialization, Build (≈21 s) and Deploy (≈6 s) all passed**. Live
stayed on `2a2a251` (#303, 08:48). Railway's own banner reads "Recovery after
October 21 incident".

`GET /healthz` is synchronous (`healthzBody()` — no Apps Script call) and
`app.listen` binds immediately, so the 30-second window was not spent in our
process; it was spent on Railway attaching the network. A 30 s window that
fails a healthy build is the wrong trade: the healthcheck's job is to keep a
broken build off the line, not to race the platform.

## What

- `railway.json` → `deploy.healthcheckTimeout`: **30 → 300**. Path (`/healthz`),
  start command and restart policy unchanged.
- `test/railway-healthcheck.test.js` (new): the path, a window ≥ 300 s, and
  that `/healthz` never touches Apps Script.

## Manual

None once merged — the next deploy uses the new window. If a deploy still
fails at the healthcheck with this window, it is a Railway-side outage:
Railway → `web` → Deployments → the failed row → «Redeploy».
