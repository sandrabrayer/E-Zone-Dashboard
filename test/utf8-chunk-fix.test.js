/* Regression tests for the Hebrew-name UTF-8 corruption in server.js.
 *
 * Root cause: followingRequest read the upstream Apps Script response with
 *   let data = ''; res.on('data', (c) => (data += c));
 * where `c` is a raw Buffer, so `+=` decoded EACH CHUNK INDEPENDENTLY. When a
 * TCP/TLS chunk boundary fell between the two bytes of a Hebrew letter (e.g.
 * י = 0xD7 0x99), each orphaned half decoded to U+FFFD — the observed
 * אלמליח → אלמל��ח. The corrupted getData reached the client, and the next
 * full-state saveAll persisted the � to the sheet (progressive corruption,
 * plus duplicate rows under the name-keyed merge).
 *
 * Fix: res.setEncoding('utf8') before the data handler, so the stream's
 * StringDecoder buffers partial multibyte sequences across chunk boundaries.
 *
 * The first test exercises the REAL followingRequest (required from server.js,
 * which skips listen() under test) against a stubbed https.request whose
 * response is a real PassThrough stream — a genuine EventEmitter with genuine
 * setEncoding semantics — emitting the payload in two chunks split inside the
 * י of אלמליח. The second test is a source scan locking the invariant that
 * every hand-rolled response reader in server.js sets the encoding first. */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const { PassThrough } = require('node:stream');
const { followingRequest } = require('../server');

/* Split a UTF-8 buffer between the lead and continuation byte of the first
 * two-byte Hebrew letter whose second byte is `contByte` (e.g. 0x99 for י). */
function splitInsideLetter(buf, contByte) {
  for (let i = 0; i < buf.length - 1; i++) {
    if (buf[i] === 0xd7 && buf[i + 1] === contByte) {
      return [buf.slice(0, i + 1), buf.slice(i + 1)];
    }
  }
  throw new Error('letter not found in buffer');
}

test('followingRequest survives a chunk boundary inside a Hebrew letter (אלמליח repro)', async () => {
  const name = 'אלמליח';
  const payload = Buffer.from(JSON.stringify({ patients: [{ name }] }), 'utf8');
  const [chunk1, chunk2] = splitInsideLetter(payload, 0x99); // split the י

  const realRequest = https.request;
  https.request = (_url, _opts, onResponse) => {
    const res = new PassThrough();
    res.statusCode = 200;
    res.headers = {};
    // Deliver the response only after followingRequest has attached its
    // handlers (mirrors real socket timing).
    setImmediate(() => {
      onResponse(res);
      res.write(chunk1);
      res.write(chunk2);
      res.end();
    });
    return { on() {}, write() {}, end() {} };
  };

  try {
    const parsed = await new Promise((resolve, reject) => {
      followingRequest({ method: 'GET' }, 'https://example.invalid/exec', null, resolve, reject, 0);
    });
    assert.strictEqual(parsed.patients[0].name, name);
    assert.ok(!JSON.stringify(parsed).includes('�'), 'no replacement characters anywhere in the response');
  } finally {
    https.request = realRequest;
  }
});

test("every res.on('data') reader in server.js sets utf8 encoding first", () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const readers = [...src.matchAll(/\.on\(['"]data['"]/g)];
  assert.ok(readers.length >= 1, 'expected at least one response reader in server.js');
  for (const m of readers) {
    const preceding = src.slice(Math.max(0, m.index - 600), m.index);
    assert.ok(
      preceding.includes("setEncoding('utf8')"),
      `res.on('data') at offset ${m.index} is not preceded by setEncoding('utf8')`
    );
  }
});
