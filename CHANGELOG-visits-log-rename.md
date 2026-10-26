# Visits log rename — «יומן ביקורים ודיווח סטטוס» (October 26, 2026)

The house managers' report feature (`/meeting-report`) is now called
**«יומן ביקורים ודיווח סטטוס»**. User-facing Hebrew strings only.

## Changed

| Where | Before | After |
|---|---|---|
| `public/meeting-report.html` `<title>` | `דיווח פגישה — E-Zone` | `יומן ביקורים ודיווח סטטוס — E-Zone` |
| `public/meeting-report.html` `<h1>` | `דיווח פגישה` | `יומן ביקורים ודיווח סטטוס` |
| `public/meeting-report-pin.html` `<title>` / `<h1>` | `דיווח פגישה` | `יומן ביקורים ודיווח סטטוס` |
| WhatsApp share message, line 1 (`mrWhatsAppMessage`) | `דיווח פגישה — E-Zone` | `יומן ביקורים ודיווח סטטוס — E-Zone` |

The subtitle stays `E-Zone — דיווח מנהלי הבתים`.

## Not changed (on purpose)

- No keys, schema, routes, action names, CSS classes, element ids or stored values.
  The route is still `/meeting-report`, the actions still `meetingReportLeads` /
  `submitMeetingReport`.
- The main-app per-lead block «דיווח מנהל/ת» stays — it is the per-lead block, not
  the feature name. No doc hardcoded the old feature name.
- No Code.gs change → no Apps Script deploy.
- No service-worker bump: the meeting-report page, JS and CSS are `network`
  (never cached) in `sw.js`, already pinned by `test/meeting-report-form.test.js`.

## Tests

- `test/visits-log-rename.test.js` (new): the new title/heading on both pages, the
  kept subtitle, the WhatsApp header line, no leftover old name, and that ids,
  asset links, the route and the «דיווח מנהל/ת» block are untouched.
- `test/meeting-report-form.test.js`, `test/manager-report-length.test.js`: the
  WhatsApp header assertions now expect the new name.

## Security

Strings only — no auth, data or network surface changed.
