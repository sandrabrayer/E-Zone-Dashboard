// CRM-02 draft reference. Synthetic normalized DTOs only; no I/O or source adapters.
// Access arguments model decisions a real server must supply after authentication.
import { createHash } from 'node:crypto';

export const DATASETS = Object.freeze({
  'dashboard.leads': ['leads', 'dashboard', ['lead_followup', 'meeting_result']],
  'outpatient.leads': ['leads', 'outpatient', ['lead_followup', 'meeting_result']],
  'outpatient.continuation': ['continuation', 'outpatient', ['continuation_decision', 'destination_link_review']],
  'therapists.schedule': ['meetings', 'therapists', ['meeting_result', 'coordination_review', 'ingestion_review']],
  'outpatient.session_log': ['meetings', 'outpatient', ['session_match_review']],
  'dashboard.cycles': ['finance', 'dashboard', ['balance_followup', 'pricing_exception']],
  'dashboard.receipts': ['finance', 'dashboard', ['receipt_verification', 'receipt_link_review']],
  'outpatient.payments': ['finance', 'outpatient', ['balance_followup']],
});
export const ACTIONS = Object.freeze({
  lead_followup: 'לבדוק את השלב והפעולה הבאה במקור',
  meeting_result: 'לבדוק אם נקלטה תוצאת המפגש',
  continuation_decision: 'להשלים החלטה במסלול ההמשך הקיים',
  destination_link_review: 'לברר קבלה וקישור לרשומת היעד',
  coordination_review: 'לבדוק צורך בתיאום חוזר במקור',
  ingestion_review: 'לוודא קליטת תוצאה וקישור ברשומת היעד',
  session_match_review: 'לברר שיוך מפגש לרשומת לקוח',
  balance_followup: 'לבדוק יתרה ופעולה במערכת הגבייה המקורית',
  pricing_exception: 'לבדוק חריגת מחיר; אין לפתוח חוב אוטומטית',
  receipt_verification: 'להפנות לאימות תקבול במקור לפי סמכות',
  receipt_link_review: 'לבדוק שיוך תקבול במקור',
});
export function isDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(value + 'T00:00:00.000Z');
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === value;
}
function dateState(value, today) {
  if (value === null || value === undefined || value === '') return 'missing';
  if (!isDate(value)) return 'invalid';
  return value < today ? 'overdue' : value === today ? 'today' : 'future';
}
function rawKey(dataset, r) { return JSON.stringify([dataset, r.nativeRecordId, r.reason]); }
export function taskKey(dataset, r) {
  return 'crm02:' + createHash('sha256').update(rawKey(dataset, r)).digest('hex');
}
function validRecord(r, dataset) {
  return r && typeof r.nativeRecordId === 'string' && r.nativeRecordId.trim() !== '' &&
    ['row', 'session', 'composite'].includes(r.identityKind) &&
    DATASETS[dataset][2].includes(r.reason) &&
    ['active', 'resolved', 'unknown'].includes(r.state) &&
    ['source', 'unknown'].includes(r.dueBasis);
}
function visibleRecords(envelope, grant, diagnostics, dataset) {
  const index = new Map(), duplicates = new Set();
  for (const r of envelope?.records || []) {
    // Filter before validation, counts, cache reconciliation and rendering.
    if (!grant.allowedIds.includes(r?.nativeRecordId)) continue;
    if (!validRecord(r, dataset)) {
      diagnostics.add('invalid_authorized_record'); continue;
    }
    const key = rawKey(dataset, r);
    if (index.has(key)) duplicates.add(key);
    else index.set(key, r);
  }
  for (const key of duplicates) index.delete(key);
  if (duplicates.size) diagnostics.add('duplicate_authorized_record');
  return index;
}
function envelopeIndex(envelopes) {
  const out = new Map();
  for (const e of envelopes) {
    if (!e || !DATASETS[e.dataset]) continue;
    if (out.has(e.dataset)) throw new Error('duplicate dataset envelope');
    out.set(e.dataset, e);
  }
  return out;
}
function effectiveEnvelope(e) {
  const timestampValid = typeof e?.observedAt === 'string' &&
    /(?:Z|[+-]\d{2}:\d{2})$/.test(e.observedAt) && Number.isFinite(Date.parse(e.observedAt));
  const health = ['fresh', 'stale', 'partial', 'unavailable'].includes(e?.health) && timestampValid
    ? e.health : 'unavailable';
  return { ...e, health, complete: e?.complete === true, observedAt: timestampValid ? e.observedAt : null };
}

export function assemble({ today, current = [], previous = [], access = [] }) {
  if (!isDate(today)) throw new Error('today must be a real YYYY-MM-DD date in Asia/Jerusalem');
  const allowedDatasets = new Set(access.filter(g => DATASETS[g?.dataset] && Array.isArray(g.allowedIds) && g.allowedIds.length).map(g => g.dataset));
  const cur = envelopeIndex(current.filter(e => allowedDatasets.has(e?.dataset)));
  const prev = envelopeIndex(previous.filter(e => allowedDatasets.has(e?.dataset)));
  const rows = [], sources = [];
  const seenGrants = new Set();
  for (const grant of access) {
    const dataset = grant?.dataset;
    if (!DATASETS[dataset] || !Array.isArray(grant.allowedIds) || grant.allowedIds.length === 0) continue;
    if (seenGrants.has(dataset)) throw new Error('duplicate grant');
    seenGrants.add(dataset);
    const diag = new Set();
    const e = effectiveEnvelope(cur.get(dataset));
    const p = effectiveEnvelope(prev.get(dataset));
    // An unavailable envelope never contributes response rows.
    const now = visibleRecords(e.health === 'unavailable' ? null : e, grant, diag, dataset);
    const old = visibleRecords(p.health === 'unavailable' ? null : p, grant, diag, dataset);
    const keys = new Set([...old.keys(), ...now.keys()]);
    for (const key of keys) {
      const n = now.get(key), o = old.get(key), r = n || o;
      const authoritative = !!n && e.health === 'fresh' && e.complete;
      if (r.state === 'resolved' && authoritative) continue;
      // A historical explicit resolution is not resurrected by source outage.
      if (!n && o?.state === 'resolved' && p.health === 'fresh' && p.complete) continue;
      const retained = !n;
      const uncertainty = retained ? 'not_seen_in_current_snapshot' : !authoritative ? e.health === 'fresh' ? 'partial' : e.health : r.state === 'unknown' ? 'unknown_status' : r.state === 'resolved' ? 'unconfirmed_resolution' : 'none';
      // The original deadline survives reassignment and later rescheduling.
      const original = o?.dueBasis === 'source' && o.originalDueDate ? o.originalDueDate
        : r.dueBasis === 'source' ? (r.originalDueDate ?? null) : null;
      const dueState = dateState(original, today);
      const eventState = !r.eventDate ? 'missing' : !isDate(r.eventDate) ? 'invalid'
        : r.eventDate < today ? 'past' : r.eventDate === today ? 'today' : 'future';
      const [lane, app] = DATASETS[dataset];
      const monetary = r.sourceFinancialProjection;
      const moneyAllowed = lane === 'finance' && grant.showMoney === true;
      // Copy only source-computed values; never calculate or reinterpret balance.
      const financial = moneyAllowed && monetary && monetary.provenance === 'source_computed'
        ? { balance: Number.isFinite(monetary.balance) ? monetary.balance : null,
            currency: monetary.currency === 'ILS' ? 'ILS' : null,
            underStamped: typeof monetary.underStamped === 'boolean' ? monetary.underStamped : null,
            verificationState: typeof monetary.verificationState === 'string' ? monetary.verificationState : null }
        : null;
      rows.push({
        taskKey: taskKey(dataset, r), lane, dataset, reason: r.reason,
        sourceRef: { nativeRecordId: r.identityKind === 'composite' && grant.showName !== true ? null : r.nativeRecordId, identityKind: r.identityKind },
        displayName: grant.showName === true && typeof r.displayName === 'string' ? r.displayName : 'רשומה מורשית',
        accountable: 'Vered',
        assignee: grant.showAssignee === true && typeof r.assignee === 'string' ? r.assignee : null,
        nextAction: uncertainty === 'unknown_status' ? 'לברר מצב לא מוכר במקור' : ACTIONS[r.reason],
        originalDueDate: original, nextActionDate: r.nextActionDate ?? null,
        dueState, eventDate: r.eventDate ?? null, eventState,
        sourceStatus: typeof r.sourceStatus === 'string' ? r.sourceStatus : null,
        sourceUpdatedAt: r.sourceUpdatedAt ?? null,
        observedAt: retained ? p.observedAt : e.observedAt,
        uncertainty, identityCertainty: r.identityKind === 'composite' ? 'unstable_source_key' : 'source_record_only',
        personLink: 'unknown', contactPermission: 'unknown', financial,
        navigation: { sourceApp: app, section: dataset.split('.')[1], mode: 'section_only' },
      });
    }
    sources.push({ dataset, health: e.health, complete: e.complete,
      observedAt: e.observedAt, diagnostics: [...diag].sort() });
  }
  const rank = { overdue: 0, invalid: 1, missing: 2, today: 3, future: 4 };
  rows.sort((a, b) => rank[a.dueState] - rank[b.dueState] ||
    String(a.originalDueDate || '').localeCompare(String(b.originalDueDate || '')) || a.taskKey.localeCompare(b.taskKey));
  const byLane = Object.fromEntries(['leads', 'continuation', 'meetings', 'finance'].map(k => [k, rows.filter(r => r.lane === k).length]));
  return { contractVersion: '0.1-proposed', today, timeZone: 'Asia/Jerusalem',
    totals: { tasks: rows.length, byLane, incomplete: sources.some(s => s.health !== 'fresh' || !s.complete || s.diagnostics.length > 0) || rows.some(r => r.uncertainty !== 'none') },
    rows, sources };
}
