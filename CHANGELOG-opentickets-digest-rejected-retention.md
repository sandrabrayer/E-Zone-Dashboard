# OpenTickets digest — rejected tickets get the archive-retention window

Behavior change to the **OpenTickets digest inclusion rule** so a **rejected**
(`לא אושר`) request no longer disappears the instant it is rejected. It now stays
in the digest for `archive_after_days` days after the rejection — the **same
7-day window** already applied to `completed` / `closed` — carrying its **red**
status, and then drops out.

## Why

A coordinator must be able to **see that their request was denied**, not have it
silently vanish. Previously a rejected ticket dropped out immediately; a
coordinator who missed the moment of rejection had no way to tell whether the
request was denied or simply never processed.

## What changed

The inclusion rule (`apps-script/Code.gs`, "Coordinators digest: OpenTickets
feed — inclusion rule") now treats `rejected` as a **terminal state with the same
retention window as `completed`/`closed`**:

- **`open`** (`פתוח`) — always in the digest, regardless of age.
- **`completed`** (`הושלם`) / **`closed`** (`סגור`) — visible for
  `archive_after_days` days after reaching that state, then dropped.
- **`rejected`** (`לא אושר`) — **now** visible for the same
  `archive_after_days` window after rejection, then dropped (previously: dropped
  immediately).

`archive_after_days` is **7 days** (`DIGEST_TICKET_ARCHIVE_AFTER_DAYS`). The
window is half-open: visible while `now − terminalTimestamp < archive_after_days`,
dropped at/after that.

### Aging timestamp

A terminal ticket ages from its **dedicated per-state timestamp** when present —
`rejectedAt` (rejected), `completedAt`, `closedAt` (snake_case accepted) — falling
back to **`updated_at` / `updatedAt`** when no dedicated field exists, per the
task. A terminal ticket with **no parseable timestamp** is kept (fail-open to
visible) so a request can never silently vanish.

### Red status

The projection stamps a `statusColor` hint: `rejected` → **`red`** (a denied
request must read as denied); other states carry no override.

## Frozen column contract (append-only)

New `OpenTickets` tab contract:

| Column        | Meaning                                                            |
|---------------|-------------------------------------------------------------------|
| `house`       | Canonical house id or `` when the ticket is not house-scoped.      |
| `ticketId`    | Stable ticket key (`id`, or a `tk:`-derived key from the subject). |
| `subject`     | Ticket subject / title.                                            |
| `status`      | `open` \| `completed` \| `closed` \| `rejected`.                   |
| `statusColor` | `red` for `rejected`; `` otherwise.                                |
| `updatedAt`   | ISO 8601 **UTC** rebuild timestamp.                               |

The authoritative schema and rule live in [`DIGEST-CONTRACT.md`](DIGEST-CONTRACT.md)
("OpenTickets feed") at the repo root.

## Tests

`test/opentickets-digest-rejected-retention.test.js` evaluates the shipped
`Code.gs` in a vm sandbox and locks: status classification (Hebrew + english/id
aliases), `isDigestTicket` (open-only base), open-always-in, **rejected visible
within the window with its red status**, **rejected drops after the window**
(incl. the exact-7-days boundary), rejected/completed/closed sharing one window,
the `updated_at` fallback, the no-timestamp fail-open, unknown-status exclusion,
the frozen 6-column projection, and a configurable window override. 14 tests
green; full suite unaffected (the two pre-existing `api-auth` / `getpayments-502`
failures are unrelated to this change).
