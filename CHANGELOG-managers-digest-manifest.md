# ManagersHouse: validate one complete publication before displaying a team

Part of Dashboard #331 and Coordinators #360 / draft #362. Work owns the
Coordinators browser/mapping/producer work; central owns this consumer companion.

The current reader can combine tables from different refreshes and retain that
combination in its five-minute cache. The opt-in reader verifies a stable ready
manifest plus all table dimensions/hashes and uses a separate cache tied to the
workbook and exact publication. Pending, changing, unreadable or corrupt data is
unavailable; a certified empty publication is valid. Freshness comes from the
publication timestamp. Existing house filtering, sanitized fields, optional
start dates and the default-off legacy path are preserved.

No dependencies, existing sheet headers, permissions, phone-handoff behavior,
production properties/data, deployments or activation are changed. Source edits
are kept in a separate commit. See the paired publication contract for required
producer work and isolated end-to-end acceptance before activation.

Validation results are recorded on the companion draft PR. Synthetic publication
fixtures exercise the actual Apps Script reader, including table interleavings
and cache races; they do not claim acceptance of the real Coordinators publisher.
