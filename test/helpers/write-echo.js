/* What the REAL Apps Script answers for a successful write, built from the
 * request body — for test stubs that used to answer a bare {ok:true}.
 * Since CHANGELOG-write-path-hardening.md the page claims "saved" only when
 * the answer carries the persisted row's id (requireSaved in app.js), the way
 * Code.gs has always answered. Unknown actions keep {ok:true}. */
function writeEcho(body) {
  const b = body && typeof body === 'object' ? body : {};
  const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : v) || {};
  switch (b.action) {
    case 'savePayment':
    case 'updatePayment':
      return { ok: true, payment: parse(b.payment), updated: true };
    case 'upsertBillingOverride':
      return { ok: true, override: parse(b.override), created: true };
    case 'deleteBillingOverride':
      return { ok: true, deleted: true, id: parse(b.override).id };
    case 'editReceipt': {
      const e = parse(b.edit);
      return { ok: true, changed: true, fields: Object.keys(e.fields || {}), receipt: Object.assign({ id: e.id }, e.fields) };
    }
    case 'appendFunder':
      return { ok: true, row: parse(b.funder) };
    case 'confirmPayment': {
      const c = parse(b.confirm);
      return { ok: true, changed: (c.ids || []).map((id) => ({ id, confirmStatus: c.status })), unchanged: 0 };
    }
    default:
      return { ok: true };
  }
}

module.exports = { writeEcho };
