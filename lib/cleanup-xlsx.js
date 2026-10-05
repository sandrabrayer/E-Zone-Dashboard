/* «ייצוא רשימת תיקונים» — the cleanupReport response (apps-script/Code.gs
 * cleanupReport_) as an .xlsx spec for lib/xlsx-report.js.
 * Pure: no I/O, no clock (the caller passes `now`), nothing logged.
 *
 * NO NEW CHECKS here. Code.gs decides which rows exist and gives each one a
 * `kind`; this file only turns a kind into words — the problem, who fixes it
 * and how — and lays the rows out, one tab per kind of problem.
 *
 * Who fixes what follows docs/billing-control-plan.md:
 *   §9  opening-balance owners — A, B, C, D (patient data) → ורד;
 *       E, F, I, K (payments) → אורטל; G, H (debt) → ורד reports, אורטל
 *       confirms; J (credits) → אורטל;
 *   §7.4 a credit awaiting a decision → אורטל; an exception to the refund
 *       policy is approved by סנדרה only (§7.3, §8.5).
 * סנדרה's three approver actions (a refund exception, writing off an opening
 * item, un-voiding a duplicate) are decisions, not data gaps, so no row kind
 * is hers today; the label exists for when one is.
 *
 * Every row has the same last five columns: פרטים, הבעיה, מי מתקן, איך
 * מתקנים and «טופל» (a ☐ to tick by hand). No tab has a total row: the gaps
 * tab mixes «חוב רשום» and «מחזורים ללא רישום», which are never summed. */

const { HOUSE_NAMES, RULE_LABELS, ERROR_LABELS } = require('./refund-forecast-xlsx');

const OWNER_LABELS = { vered: 'ורד', ortal: 'אורטל', sandra: 'סנדרה' };
const DONE_BOX = '☐';

/* kind → { problem, owner, how }. `problem` may be a function of the row. */
const KINDS = {
  fffd: {
    owner: 'vered',
    problem: 'שם עם תו פגום',
    how: 'לתקן את השם בכל הלשוניות לפי הצעת התיקון — לבדוק את ההצעה מול רמת הביטחון',
  },
  spelling: {
    owner: 'vered',
    problem: (r) => ({
      payments: 'השם בשורת התשלום שונה מהשם בכרטיס המטופל',
      credits: 'השם בזיכוי שונה מהשם בכרטיס המטופל',
      leads: 'השם בליד שונה מהשם בכרטיס המטופל',
    }[r.source] || 'אותו מטופל נרשם באיות שונה'),
    how: 'לבחור את האיות הנכון ולתקן את הרשומה השנייה; אם השם בכרטיס המטופל שגוי — לתקן אותו',
  },
  near_duplicate: {
    owner: 'vered',
    problem: 'שני מטופלים באותו בית עם שמות דומים',
    how: 'לבדוק אם זה אותו אדם; אם כן — לאחד לרשומה אחת בשם המוצע ולשייך אליה את התשלומים',
  },
  recorded_debt: {
    owner: 'vered',
    problem: 'חוב רשום — שורת תשלום שלא שולמה במלואה',
    how: 'אם הכסף התקבל — לעדכן את שורת התשלום (אורטל מאשרת מול הבנק); אם לא — לברר עם המשפחה',
  },
  unrecorded_cycle: {
    owner: 'vered',
    problem: 'מחזור ללא רישום — לא שולם, או ששולם ולא הוזן',
    how: 'אם שולם — לרשום את התשלום (אורטל מאשרת מול הבנק); אם המטופל עזב — להזין תאריך יציאה; אחרת לברר עם המשפחה',
  },
  detached: {
    owner: 'ortal',
    problem: 'תשלום שלא משויך לאף מטופל',
    how: 'בטאב שיוך תשלומים: לשייך למטופל הנכון (ראו הצעת השיוך), או לסמן «לא מטופל» עם הערה',
  },
  after_exit: {
    owner: 'ortal',
    problem: 'תשלום על מחזור שמתחיל אחרי תאריך היציאה',
    how: 'לבדוק שתאריך היציאה נכון; אם כן — לבדוק אם זה כפל או החזר, ולתקן את השורה או לבטל כפילות',
  },
  before_entry: {
    owner: 'ortal',
    problem: 'תשלום על מחזור שמתחיל לפני תאריך הכניסה',
    how: 'להשוות את תאריך הכניסה לתאריך המחזור בשורת התשלום ולתקן את השגוי',
  },
  released_no_exit: {
    owner: 'vered',
    problem: 'מטופל משוחרר ללא תאריך יציאה',
    how: 'להזין תאריך יציאה בכרטיס המטופל — בלעדיו אין חישוב מחזורים ואין זיכוי',
  },
  no_entry_date: {
    owner: 'vered',
    problem: 'מטופל עם תשלומים וללא תאריך כניסה',
    how: 'להזין תאריך כניסה בכרטיס המטופל',
  },
  zero_amount: {
    owner: 'vered',
    problem: 'מטופל עם סכום חודשי אפס',
    how: 'להזין סכום חודשי בכרטיס המטופל, או לבדוק «סכום חודשי» של ₪0 בגבייה',
  },
  lead_no_patient: {
    owner: 'vered',
    problem: 'ליד ששילם או נקלט, ואין לו רשומת מטופל',
    how: 'לקלוט את המטופל מהליד; אם לא נכנס — לעדכן את שלב הליד',
  },
  paid_not_admitted: {
    owner: 'ortal',
    problem: 'תשלום לא משויך שתואם לליד בלי רשומת מטופל — שולם ולא נקלט',
    how: 'לוודא עם ורד שהמטופל נקלט, ואז לשייך את התשלום בטאב שיוך תשלומים',
  },
  duplicate: {
    owner: 'ortal',
    problem: 'אותו מטופל, אותו סכום, אותו מחזור — פעמיים',
    how: 'לבדוק בבנק; אם נרשם פעמיים — «בטל כפילות» בטאב שיוך תשלומים (השורה לא נמחקת)',
  },
  duplicate_detached: {
    owner: 'ortal',
    problem: 'שורה לא משויכת זהה לתשלום של מטופל — כנראה אותו תשלום אחרי שינוי שם',
    how: 'לבדוק בבנק; אם נרשם פעמיים — «בטל כפילות» בטאב שיוך תשלומים (השורה לא נמחקת)',
  },
  credit_awaiting: {
    owner: 'ortal',
    problem: 'שחרור שממתין להחלטת זיכוי',
    how: 'להחליט על הזיכוי (מטופלים משוחררים ← זיכויים); חריגה מהמדיניות — באישור סנדרה בלבד',
  },
  credit_unresolved: {
    owner: 'vered',
    problem: 'לא ניתן לחשב זיכוי',
    how: 'לתקן את הנתון החסר (תאריך כניסה, תאריך יציאה או בית) ואז להחליט על הזיכוי',
  },
  no_funder: {
    owner: 'vered',
    problem: 'חסר גורם מממן',
    how: 'לקבוע גורם מממן בגבייה ← «השלמת גורם מממן» (או בכרטיס המטופל) ומאיזה תאריך; עד אז הגורם המממן «לא הוגדר»',
  },
};

const NEAR_DUP_WHY = {
  same_name: 'אותו שם פעמיים',
  spacing: 'הבדל ברווחים או בתווים נסתרים',
  partial: 'שם חלקי',
  word_order: 'סדר מילים שונה',
  one_letter: 'הבדל של אות אחת',
};
/* reconciliation §D's `via` codes ('id', 'fromLead', 'phone', joined by '+'), in Hebrew. */
const VIA_LABELS = { id: 'מזהה', fromLead: 'ליד מקור', phone: 'טלפון' };
function viaText(via) {
  return String(via || '').replace(/\b(id|fromLead|phone)\b/g, (m) => VIA_LABELS[m]).replace(/\+/g, ' + ');
}
const DUP_RULE_LABELS = { same_month: 'אותו חודש', within_7_days: 'עד 7 ימים בין התאריכים' };
const KIND_SHORT = { recorded_debt: 'חוב רשום', unrecorded_cycle: 'ללא רישום' };
const STAGE_LABELS = { paid: 'מקדמה שולמה', admitted: 'נקלט', 'נכנסים לטיפול': 'נכנסים לטיפול' };

/* The tabs, in order. `key` is the response section. lib/report-colors.js keys. */
const TABS = [
  { key: 'names',          name: 'שמות לא תואמים',           color: 'awaiting' },
  { key: 'gaps',           name: 'פערי גבייה לבדיקה',        color: 'unrecorded' },
  { key: 'detached',       name: 'תשלומים לא משויכים',       color: 'open' },
  { key: 'outsideStay',    name: 'תשלומים אחרי יציאה',       color: 'debt' },
  { key: 'releasedNoExit', name: 'משוחררים ללא תאריך יציאה', color: 'unresolved' },
  { key: 'noEntryDate',    name: 'ללא תאריך כניסה',          color: 'unresolved' },
  { key: 'zeroAmount',     name: 'מטופלים בסכום אפס',        color: 'unresolved' },
  { key: 'leads',          name: 'לידים ששולמו ולא נקלטו',   color: 'due' },
  { key: 'duplicates',     name: 'כפילויות חשודות',          color: 'debt' },
  { key: 'credits',        name: 'זיכויים לבדיקה',           color: 'credits' },
  { key: 'noFunder',       name: 'חסר גורם מממן',            color: 'unresolved' },
];
const SUMMARY_NAME = 'סיכום';
const SECTION_KEYS = TABS.map((t) => t.key);
const EMPTY_TEXT = 'אין פריטים לתיקון בלשונית זו';
const ENTRY_ERROR_RULE = 'כנראה טעות רישום = המחזור מתחיל לפני 01/07/2026, או שאין למטופל שום פעילות מאוחרת יותר ' +
  '(שורת תשלום שמועדה או דיווח התשלום שלה אחרי תחילת המחזור) והמחזור בן יותר מ־30 יום';

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
const arr = (v) => (Array.isArray(v) ? v : []);

/* Sections a Code.gs deployed before them does not send yet (Railway and the
 * clasp CI deploy separately): absent = an empty tab, present = an array. */
const OPTIONAL_SECTION_KEYS = ['noFunder'];

/* True when `data` has the shape cleanupReport returns on success. */
function isCleanupResponse(data) {
  return !!(data && data.ok === true && typeof data.today === 'string' && ISO_RE.test(data.today) &&
    data.sections && typeof data.sections === 'object' &&
    SECTION_KEYS.every((k) => Array.isArray(data.sections[k]) ||
      (OPTIONAL_SECTION_KEYS.includes(k) && data.sections[k] === undefined)));
}

function houseName(id) { return HOUSE_NAMES[id] || id || '—'; }
function statusLabel(s) { return s === 'released' ? 'משוחרר' : (s ? 'פעיל' : ''); }
/* 'YYYY-MM-DD' → 'DD/MM/YYYY' for text cells; anything else as is. */
function heDate(iso) {
  const s = String(iso == null ? '' : iso);
  return ISO_RE.test(s) ? `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)}` : s;
}
const join = (parts) => parts.filter((p) => p !== undefined && p !== null && String(p) !== '').join(' · ');

/* The five closing columns of a row, from its kind. */
function closing(row, details) {
  const k = KINDS[row.kind] || { owner: '', problem: String(row.kind || ''), how: '' };
  return {
    details,
    problem: typeof k.problem === 'function' ? k.problem(row) : k.problem,
    owner: OWNER_LABELS[k.owner] || '',
    how: k.how,
    done: DONE_BOX,
  };
}
const HEAD = [{ header: 'בית', key: 'house' }, { header: 'מטופל', key: 'name' }];
const TAIL = [
  { header: 'פרטים', key: 'details' },
  { header: 'הבעיה', key: 'problem' },
  { header: 'מי מתקן', key: 'owner' },
  { header: 'איך מתקנים', key: 'how' },
  { header: 'טופל', key: 'done' },
];
const base = (r) => ({ house: houseName(r.houseId), name: r.name || '' });

/* Per tab: the extra columns between מטופל and פרטים, and the row mapper. */
const LAYOUT = {
  names: {
    columns: [{ header: 'שם שונה', key: 'other' }, { header: 'הצעת תיקון', key: 'proposal' }],
    row: (r) => {
      const refs = arr(r.refs);
      let details;
      if (r.kind === 'fffd') details = join([refs.join(', '), r.confidence ? 'ביטחון: ' + r.confidence : '', viaText(r.via)]);
      else if (r.kind === 'near_duplicate') {
        details = join([NEAR_DUP_WHY[r.why] || r.why, 'כניסה: ' + (heDate(r.entryDate) || '—') + ' / ' + (heDate(r.otherEntryDate) || '—'), refs.join(', ')]);
      } else details = join([refs.length > 1 ? refs.length + ' רשומות' : '', refs.join(', ')]);
      const other = r.kind === 'spelling' ? r.recordedName : (r.kind === 'near_duplicate' ? r.otherName : '');
      return Object.assign(base(r), { other: other || '', proposal: r.proposal || '' }, closing(r, details));
    },
  },
  gaps: {
    columns: [
      { header: 'סוג', key: 'type' },
      { header: 'תחילת מחזור', key: 'start', type: 'date' },
      { header: 'סוף מחזור', key: 'end', type: 'date' },
      { header: 'צפוי', key: 'expected', type: 'money' },
      { header: 'התקבל', key: 'received', type: 'money' },
      { header: 'יתרה', key: 'balance', type: 'money' },
      { header: 'ימים', key: 'days', type: 'int' },
      { header: 'כנראה טעות רישום', key: 'entryError' },
    ],
    row: (r) => Object.assign(base(r), {
      type: KIND_SHORT[r.kind] || r.kind, start: r.start, end: r.end, expected: r.expected,
      received: r.received, balance: r.balance, days: r.days, entryError: r.probablyEntryError === true ? 'כן' : 'לא',
    }, closing(r, join([statusLabel(r.status), r.entryDate ? 'כניסה ' + heDate(r.entryDate) : '',
      r.exitDate ? 'יציאה ' + heDate(r.exitDate) : '',
      r.laterActivity ? 'יש פעילות מאוחרת יותר' : 'אין פעילות מאוחרת יותר']))),
  },
  detached: {
    columns: [
      { header: 'תאריך', key: 'dueDate', type: 'date' },
      { header: 'סכום', key: 'amount', type: 'money' },
      { header: 'התקבל', key: 'received', type: 'money' },
      { header: 'הצעת שיוך', key: 'candidate' },
    ],
    row: (r) => Object.assign(base(r), {
      dueDate: r.dueDate, amount: r.amount, received: r.receivedByAsOf, candidate: r.candidate || '',
    }, closing(r, join([arr(r.refs).join(', '), r.candidateReason]))),
  },
  outsideStay: {
    columns: [
      { header: 'תחילת מחזור', key: 'start', type: 'date' },
      { header: 'כניסה', key: 'entryDate', type: 'date' },
      { header: 'יציאה', key: 'exitDate', type: 'date' },
      { header: 'סכום', key: 'amount', type: 'money' },
    ],
    row: (r) => Object.assign(base(r), { start: r.start, entryDate: r.entryDate, exitDate: r.exitDate, amount: r.amount },
      closing(r, join([statusLabel(r.status), arr(r.refs).join(', ')]))),
  },
  releasedNoExit: {
    columns: [{ header: 'כניסה', key: 'entryDate', type: 'date' }],
    row: (r) => Object.assign(base(r), { entryDate: r.entryDate }, closing(r, 'משוחרר')),
  },
  noEntryDate: {
    columns: [{ header: 'שורות תשלום', key: 'paymentRows', type: 'int' }],
    row: (r) => Object.assign(base(r), { paymentRows: r.paymentRows }, closing(r, statusLabel(r.status))),
  },
  zeroAmount: {
    columns: [
      { header: 'כניסה', key: 'entryDate', type: 'date' },
      { header: 'יציאה', key: 'exitDate', type: 'date' },
      { header: 'מחזורים', key: 'cycles', type: 'int' },
    ],
    row: (r) => Object.assign(base(r), { entryDate: r.entryDate, exitDate: r.exitDate, cycles: r.cycles },
      closing(r, statusLabel(r.status))),
  },
  leads: {
    columns: [
      { header: 'טלפון', key: 'phone' },
      { header: 'שלב', key: 'stage' },
      { header: 'תאריך', key: 'date', type: 'date' },
      { header: 'סכום', key: 'amount', type: 'money' },
    ],
    row: (r) => {
      const lead = r.kind === 'lead_no_patient';
      return Object.assign(base(r), {
        phone: r.phone || '',
        stage: lead ? (STAGE_LABELS[r.stage] || r.stage || '') : 'תשלום לא משויך',
        date: lead ? (r.entryDate || r.created) : r.dueDate,
        amount: lead ? r.advance : r.amount,
      }, closing(r, lead
        ? join([arr(r.refs).join(', '), arr(r.notes).join(', ')])
        : join(['שם בתשלום: ' + (r.paymentName || '—'), r.reason, arr(r.refs).join(', ')])));
    },
  },
  duplicates: {
    columns: [
      { header: 'סכום', key: 'amount', type: 'money' },
      { header: 'תאריך ראשון', key: 'dueDate', type: 'date' },
      { header: 'תאריך שני', key: 'otherDueDate', type: 'date' },
    ],
    row: (r) => {
      const names = arr(r.names);
      return Object.assign(base(r), { amount: r.amount, dueDate: r.dueDate, otherDueDate: r.otherDueDate },
        closing(r, join([DUP_RULE_LABELS[r.rule] || r.rule, arr(r.refs).join(', '),
          names.length === 2 && names[0] !== names[1] ? 'שמות בשורות: ' + names.join(' / ') : ''])));
    },
  },
  credits: {
    columns: [
      { header: 'כניסה', key: 'entryDate', type: 'date' },
      { header: 'יציאה', key: 'exitDate', type: 'date' },
      { header: 'סכום מוצע', key: 'amount', type: 'money' },
      { header: 'תשלום אם יוחלט היום', key: 'payoutDate', type: 'date' },
    ],
    row: (r) => Object.assign(base(r), { entryDate: r.entryDate, exitDate: r.exitDate, amount: r.amount, payoutDate: r.payoutDate },
      closing(r, r.kind === 'credit_unresolved'
        ? (ERROR_LABELS[r.error] || r.error || '')
        : String(r.rule || '').split(',').filter(Boolean).map((x) => RULE_LABELS[x] || x).join(', '))),
  },
  noFunder: {
    columns: [{ header: 'כניסה', key: 'entryDate', type: 'date' }],
    row: (r) => Object.assign(base(r), { entryDate: r.entryDate }, closing(r, 'נחשב כעת: לא הוגדר')),
  },
};

const NOTES = {
  names: 'כל שורה היא רשומה או צמד רשומות; השם בכרטיס המטופל הוא ההצעה, אלא אם צוין אחרת',
  gaps: ['נכון להיום, ממוין מהישן לחדש · «חוב רשום» ו«מחזורים ללא רישום» אינם מסתכמים יחד', ENTRY_ERROR_RULE],
  detached: 'שורות שסומנו «לא מטופל» עם הערה אינן ברשימה — הן כבר הוחלטו',
  outsideStay: 'לא נספרות כחוב',
  duplicates: 'שורות שבוטלו כבר («בטל כפילות») אינן ברשימה',
  credits: 'ממתין להחלטה — הצעה בלבד, לא לתשלום',
  noFunder: 'מטופלים שאינם משוחררים ואין להם שורה בלשונית Funders',
};

/* The spec. `now` is the generated-at time. Pure. */
function buildCleanupSpec(data, now) {
  const sections = data.sections || {};
  const ownerCounts = (rows) => {
    const c = { vered: 0, ortal: 0, sandra: 0 };
    rows.forEach((r) => { const k = KINDS[r.kind]; if (k && k.owner in c) c[k.owner]++; });
    return c;
  };
  const summaryRows = TABS.map((t) => {
    const rows = arr(sections[t.key]);
    const c = ownerCounts(rows);
    return { tab: t.name, count: rows.length, vered: c.vered, ortal: c.ortal, sandra: c.sandra };
  });
  const summaryNote = ['נכון ל־' + heDate(data.today) + ' · עמודת «טופל» לסימון ידני בכל לשונית'];
  if (arr(data.missingTabs).length) summaryNote.push('לשוניות חסרות בגיליון: ' + arr(data.missingTabs).join(', '));
  if (Number(data.notAPatientExcluded) > 0) summaryNote.push(`תשלומים שסומנו «לא מטופל» ולא נכללו (כבר הוחלטו): ${Number(data.notAPatientExcluded)}`);

  const sheets = [{
    name: SUMMARY_NAME,
    title: 'רשימת תיקונים — סיכום',
    note: summaryNote,
    color: 'due',
    columns: [
      { header: 'לשונית', key: 'tab' },
      { header: 'שורות', key: 'count', type: 'int' },
      { header: OWNER_LABELS.vered, key: 'vered', type: 'int' },
      { header: OWNER_LABELS.ortal, key: 'ortal', type: 'int' },
      { header: OWNER_LABELS.sandra, key: 'sandra', type: 'int' },
    ],
    rows: summaryRows,
  }];
  TABS.forEach((t) => {
    const layout = LAYOUT[t.key];
    sheets.push({
      name: t.name,
      title: t.name,
      note: NOTES[t.key],
      color: t.color,
      columns: HEAD.concat(layout.columns, TAIL),
      rows: arr(sections[t.key]).map(layout.row),
      emptyText: EMPTY_TEXT,
    });
  });
  return { generatedAt: now instanceof Date ? now : new Date(), sheets };
}

/* Content-Disposition for the download, named after the report's day. The day
 * is re-validated, so nothing else can reach the header. */
function cleanupContentDisposition(isoDay) {
  const day = ISO_RE.test(String(isoDay)) ? String(isoDay) : 'unknown-date';
  const utf8Name = `רשימת-תיקונים-${day}.xlsx`;
  const encoded = encodeURIComponent(utf8Name).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return `attachment; filename="cleanup-${day}.xlsx"; filename*=UTF-8''${encoded}`;
}

module.exports = {
  buildCleanupSpec,
  isCleanupResponse,
  cleanupContentDisposition,
  KINDS,
  OWNER_LABELS,
  TABS,
  SUMMARY_NAME,
  SECTION_KEYS,
  NEAR_DUP_WHY,
  ENTRY_ERROR_RULE,
  DONE_BOX,
};
