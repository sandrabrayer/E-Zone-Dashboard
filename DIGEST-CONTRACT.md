# DIGEST-CONTRACT — ActivePatients feed (E-Zone Dashboard → Coordinators)

The E-Zone Dashboard publishes a small, read-only **digest** spreadsheet that
the coordinators app consumes. This file is the authoritative, verbatim copy of
the schema. The producing code lives in
[`apps-script/Code.gs`](apps-script/Code.gs) (the "Coordinators digest" section)
and the contract is locked by
[`test/coordinators-patients-digest.test.js`](test/coordinators-patients-digest.test.js).

## Ownership

- The digest lives in its **own dedicated spreadsheet**, separate from the main
  dashboard spreadsheet.
- The Dashboard Apps Script is the **sole writer**. Consumers (coordinators)
  read only. The spreadsheet is shared **read-only** with `brayersandra@gmail.com`.
- The spreadsheet id is stored in the Script Property `DIGEST_SPREADSHEET_ID`.

## Tab

- Tab name: **`ActivePatients`** (row 1 is a frozen header).

## Contents

- One row per **patient currently in active treatment in a house** — a
  `Patients`-sheet resident whose status is **`active`** (בטיפול פעיל / פעיל).
  This is the same population the dashboard's per-house occupancy board shows,
  so the digest's per-house row counts match the board.
- The digest is **rebuilt in full** on every rebuild — never incremental. A rows
  set that no longer qualifies simply disappears on the next rebuild.

> **History.** The digest originally sourced from the pre-admission `paid`
> kanban leads — the column labelled "בטיפול פעיל". That was wrong: that column
> holds a handful of leads who have paid an advance but are **not yet in a
> house** (most with no house set), so the feed was near-empty and skewed to a
> single house. The patients coordinators need — "in active treatment, in every
> house" — are the admitted residents, which is what the digest now exports.

## Columns (FROZEN CONTRACT — append-only; never reorder or remove)

| # | Column        | Description                                                        |
|---|---------------|--------------------------------------------------------------------|
| 1 | `house`       | Canonical house id: `ramot` \| `raanana` \| `efroni` \| `rehab`.   |
| 2 | `patientName` | Patient display name.                                              |
| 3 | `patientId`   | Stable per-patient key. The `Patients` sheet has **no** persisted id column, so this is derived deterministically from the patient's identifying fields (`houseId` + name + entry date) — the same patient yields the same id across rebuilds. |
| 4 | `updatedAt`   | ISO 8601 **UTC** timestamp of the rebuild that produced the row.   |

**Append-only rule:** new columns may only be added to the right of column 4.
Existing columns are never renamed, reordered, or removed, so consumers can map
by position or by header safely.

### HARD RULE — no financial fields

The digest carries **no** financial data of any kind: no billing, debt, rates,
advance, or payment fields. Each row is projected from exactly the four columns
above and nothing else.

## House encoding

A patient's house comes from the `Patients` sheet `houseId` (a dashboard
internal id). It is encoded as a canonical id. Only these four houses are
exported; any house outside them (e.g. `pardes`, `sde`, or an unknown/blank
value) is **excluded**, not renamed. A Hebrew display name is also accepted so
mixed/legacy rows still resolve.

| Dashboard internal id | Hebrew display name | Canonical digest id |
|-----------------------|---------------------|---------------------|
| `asher`               | רעננה אשר            | `raanana`           |
| `ramot`               | רמות השבים          | `ramot`             |
| `arfoni`              | קיסריה עפרוני        | `efroni`            |
| `rehab`               | קיסריה ריהאב         | `rehab`             |
| `pardes`              | רעננה הפרדס          | *(excluded)*        |
| `sde`                 | שדה אליעזר           | *(excluded)*        |

## Rebuild cadence

- **On change:** rebuilt (best-effort, fail-soft) at the end of every request
  that can change the active-resident population — `saveAll` (admissions and
  patient status/house changes ride this), `dischargePatient`, `restorePatient`,
  `restorePatientToActive`, plus the lead paths (`moveLeadIrrelevant`,
  `restoreLead`, `removeLead`). A digest failure can never break the primary
  read/write path.
- **Backstop:** an hourly time-based trigger (`rebuildActivePatientsDigest`)
  rebuilds the digest even if a mutation path is ever missed.
- **Diagnostics:** run **`diagnoseActivePatientsDigest`** from the editor to see,
  read-only, the resident count per status and — among active residents — the
  per-house kept count plus every dropped row with its exclusion reason (so a
  missing/unknown house is visible, never silently dropped).

## One-time setup

Run **`setupActivePatientsDigest`** once from the Apps Script editor. It:

1. Creates the digest spreadsheet (or reuses the recorded one) and stores its id
   in the `DIGEST_SPREADSHEET_ID` script property.
2. Creates the `ActivePatients` tab with the frozen header row.
3. Shares the spreadsheet read-only with `brayersandra@gmail.com`.
4. Installs the hourly backstop trigger.
5. Does an initial rebuild.
6. Prints the spreadsheet id, URL, tab name, and column schema to the execution
   log (`View → Logs`).

> The setup function and the rebuild use `SpreadsheetApp` (open-by-id),
> `DriveApp` (share), and `ScriptApp` (trigger), which require broader OAuth
> scopes than the base dashboard. Running `setupActivePatientsDigest` from the
> editor triggers the consent prompt for the deploying account; the web-app
> deployment must be re-authorized once so its request-path rebuilds succeed
> (until then they are silently skipped by the fail-soft guard).

---

# OpenTickets feed — inclusion rule (E-Zone Dashboard → Coordinators)

A second coordinators-facing digest population: the **open requests
("tickets")** a coordinator raises against the dashboard, plus a short archive
tail of the ones that were just resolved so the coordinator can still see the
outcome. This section is the authoritative copy of the **inclusion rule** — which
tickets belong in the feed at a given moment. The producing code lives in
[`apps-script/Code.gs`](apps-script/Code.gs) ("Coordinators digest: OpenTickets
feed — inclusion rule") and the contract is locked by
[`test/opentickets-digest-rejected-retention.test.js`](test/opentickets-digest-rejected-retention.test.js).

> **Scope of this section.** It defines the inclusion rule and the row
> projection (`isDigestTicket` / `digestIncludeTicket_` / `buildOpenTicketsRows_`)
> as pure, deterministic helpers — the same pure/IO split the ActivePatients
> digest uses. Wiring the rows to a source sheet and an output tab follows the
> ActivePatients I/O pattern (`ensureDigestTab_` / `writeDigestRows_`).

## Tab

- Tab name: **`OpenTickets`** (row 1 is a frozen header).

## Columns (FROZEN CONTRACT — append-only; never reorder or remove)

| # | Column        | Description                                                             |
|---|---------------|-------------------------------------------------------------------------|
| 1 | `house`       | Canonical house id (`ramot` \| `raanana` \| `efroni` \| `rehab`) or `` when the ticket is not house-scoped. Uses the same house encoding as the ActivePatients feed. |
| 2 | `ticketId`    | Stable ticket key (the ticket's `id`; falls back to a `tk:`-prefixed key derived from the subject when no id is stored). |
| 3 | `subject`     | Ticket subject / title.                                                 |
| 4 | `status`      | Canonical status class: `open` \| `completed` \| `closed` \| `rejected`. |
| 5 | `statusColor` | Consumer UI hint. `rejected` → **`red`** (a denied request must read as denied); other states → `` (no override). |
| 6 | `updatedAt`   | ISO 8601 **UTC** timestamp of the rebuild that produced the row.        |

## Inclusion rule

A ticket appears in the `OpenTickets` feed when it is:

- **`open`** (`פתוח`) — **always**, regardless of age. This is the base
  population the feed is named for.
- **`completed`** (`הושלם`) / **`closed`** (`סגור`) — for **`archive_after_days`**
  days after it reached that terminal state, **then it drops out**.
- **`rejected`** (`לא אושר`) — for the **same `archive_after_days` window** as
  completed/closed, **then it drops out**.

`archive_after_days` is **7 days** (`DIGEST_TICKET_ARCHIVE_AFTER_DAYS`). The
window is half-open: a ticket is visible while `now − terminalTimestamp <
archive_after_days`, and drops at/after exactly that many days.

### Rejected retention (behavior)

A rejected request **does not vanish the instant it is rejected**. It remains in
the digest for the 7-day archive window — carrying its **red** `rejected` status
— so a coordinator can **see that their request was denied** rather than have it
silently disappear. After the window it ages out, exactly like completed/closed.

### Aging timestamp

A terminal ticket ages from its **dedicated per-state timestamp** when present —
`rejectedAt` (rejected), `completedAt` (completed), `closedAt` (closed);
snake_case variants (`rejected_at`, …) are accepted too — falling back to
**`updated_at` / `updatedAt`** when there is no dedicated field. A terminal
ticket with **no parseable timestamp** is **kept** (fail-open to visible) so a
request can never silently vanish, and a future-dated stamp (clock skew) is
treated as fresh.

## Status encoding

Status is matched case-insensitively against Hebrew labels and English/id
aliases, then reduced to a canonical class. Any status outside the set below is
**not a digest ticket** and is excluded (never renamed).

| Canonical class | Accepted tokens                     |
|-----------------|-------------------------------------|
| `open`          | `open`, `פתוח`                       |
| `completed`     | `completed`, `הושלם`, `בוצע`         |
| `closed`        | `closed`, `סגור`                     |
| `rejected`      | `rejected`, `לא אושר`, `נדחה`        |
