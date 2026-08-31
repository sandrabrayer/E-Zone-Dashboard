# UTF-8 chunk-boundary fix: Hebrew names corrupted to ��

## Symptom

Hebrew patient names progressively turned into replacement characters across
save cycles (`אלמליח` → `אלמל��ח` → `אלמל�����`), and under the name-keyed
merge (PR #96) each corrupted variant became a new duplicate row. The same
corruption showed up in ezone-outpatient (`ענאן א��גמל`).

## Root cause

`followingRequest` in `server.js` — the single reader for every Apps Script
response (`sheetsGet` / `sheetsPost` / `outpatientPost`) — accumulated the
response body with:

```js
let data = '';
res.on('data', (c) => (data += c));
```

`c` is a raw `Buffer`, so `+=` decoded **each chunk independently**. When a
TCP/TLS chunk boundary (Node emits roughly one `data` event per ~16KB TLS
record from `script.googleusercontent.com`) fell between the two UTF-8 bytes
of a Hebrew letter (e.g. `י` = `0xD7 0x99`), each orphaned half decoded to
`U+FFFD` — hence exactly two `�` per lost letter.

- **Read-path corruption, persisted by writes.** getData corrupted a
  character in transit; the client held that state; the next full-state
  `saveAll` wrote the `�` into the sheet permanently.
- **Progressive on the same name.** The getData byte stream is deterministic,
  so the split landed at a stable offset — the same patient was hit
  repeatedly. Each persisted `U+FFFD` (3 bytes replacing a 2-byte letter)
  shifted later offsets, walking the boundary onto adjacent characters.
- **Outpatient corruption is inherited, not shared code.** ezone-outpatient's
  proxy uses `fetch` + `await r.text()` (whole-body decode, safe); it
  received names already corrupted by the dashboard via the discharge →
  `/api/outpatient-lead` handoff and the `getAdmittedRoster` feed.

Present since the commit that introduced `server.js` (PR #49 merge,
2026-07-27) — not a recent regression; frequency grew with getData response
size crossing chunk boundaries.

## Fix

`res.setEncoding('utf8')` before the `data` handler in `followingRequest`.
The stream then decodes through a `StringDecoder`, which buffers a partial
multibyte sequence at a chunk boundary and completes it with the next chunk.
This was the only `res.on('data')` reader in the repo (healthcheck and tools
scripts scanned clean).

## Tests

`test/utf8-chunk-fix.test.js`:

- Feeds the real `followingRequest` (stubbed `https.request`, response as a
  real `PassThrough` stream) a JSON payload split between the two bytes of
  the `י` in `אלמליח`, and asserts the parsed name round-trips intact with no
  `U+FFFD` anywhere in the response.
- Source scan: every `res.on('data')` in `server.js` must be preceded by
  `setEncoding('utf8')`, so a future hand-rolled reader can't reintroduce the
  bug silently.

## Follow-up (not in this change)

Rows already corrupted in the sheet contain literal `U+FFFD` characters and
duplicate name-variants; they will not self-heal and need a one-time manual
cleanup after this fix deploys.
