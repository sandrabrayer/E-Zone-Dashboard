'use strict';

/* Meeting-report form (PR 2) — the standalone mobile page house managers use
 * to report what happened in a lead meeting. Served at /meeting-report behind
 * its own PIN; deliberately has NO dependency on app.js (managers must never
 * load the dashboard bundle), so the few shared constants are duplicated here
 * with keep-in-sync notes — test/meeting-report-form.test.js asserts the label
 * maps stay identical to app.js's. */

/* House id → Hebrew label. KEEP IN SYNC with HOUSES in public/app.js. */
var MR_HOUSE_LABELS = {
  arfoni: 'קיסריה עפרוני',
  rehab:  'קיסריה ריהאב',
  asher:  'רעננה אשר',
  pardes: 'רעננה הפרדס',
  ramot:  'רמות השבים',
  sde:    'שדה אליעזר',
};

/* מדווח/ת options — the real house managers, keyed by the house id (a house
 * with no reporting manager — e.g. sde — has no entry and that's fine: the
 * dropdown is a flat list of names, not filtered by house). The SELECTED
 * VALUE (the name) is what gets stored in the lead's meetingReporter column. */
var MEETING_REPORTERS = Object.freeze({
  arfoni: 'חנן',
  rehab:  'רנטה',
  asher:  'שחר/אורן',
  pardes: 'חן',
  ramot:  'אורן',
});

/* Outcome keys + Hebrew labels. KEEP IN SYNC with
 * MEETING_REPORT_OUTCOME_LABELS in public/app.js (PR 1). */
var MR_OUTCOME_LABELS = {
  advancing: 'התקיימה — מתקדם לכניסה',
  undecided: 'התקיימה — מתלבט',
  not_fit:   'התקיימה — לא מתאים',
  no_show:   'לא הגיע / בוטל',
};
var MR_OUTCOME_ORDER = ['advancing', 'undecided', 'not_fit', 'no_show'];

/* Companion keys + Hebrew labels. KEEP IN SYNC with
 * MEETING_COMPANION_LABELS in public/app.js (PR 1). */
var MR_COMPANION_LABELS = {
  mother:  'אמא',
  father:  'אבא',
  parents: 'הורים',
  partner: 'בן/בת זוג',
  sibling: 'אח/אחות',
  friend:  'חבר',
  alone:   'לבד',
  other:   'אחר',
};
var MR_COMPANION_ORDER =
  ['mother', 'father', 'parents', 'partner', 'sibling', 'friend', 'alone', 'other'];

/* The ONLY cap on the report's פירוט free text — raised 2000 → 5000 (Sandra,
 * Sep 2026: managers write a full meeting summary there). KEEP IN SYNC with
 * MANAGER_REPORT_MAX_CHARS in public/app.js, server.js and apps-script/Code.gs
 * (this page must never load the dashboard bundle, so the value is duplicated
 * rather than imported); test/manager-report-length.test.js fails if the four
 * drift apart or if any other numeric literal caps this field.
 * Over the cap REFUSES the submit — the text is never truncated. */
var MANAGER_REPORT_MAX_CHARS = 5000;

/* Where the live counter turns amber: derived from the cap (90% = 4500), so
 * raising the cap moves the warning with it and no second literal exists. */
var MANAGER_REPORT_WARN_CHARS = Math.round(MANAGER_REPORT_MAX_CHARS * 0.9);

/* ===== Pure helpers (unit-tested in test/meeting-report-form.test.js) ===== */

/* Today as YYYY-MM-DD from LOCAL date parts (never UTC — Israel rolls past
 * midnight ~2-3 hours before UTC; mirrors todayISO() in app.js). */
function mrTodayISO() {
  var d = new Date();
  var m = String(d.getMonth() + 1).padStart(2, '0');
  var day = String(d.getDate()).padStart(2, '0');
  return d.getFullYear() + '-' + m + '-' + day;
}

/* The picker list. Default view: leads whose visitDate is set and ≤ today
 * (the meeting should already have happened), newest visit first. The
 * "לא מוצא את הליד?" toggle (showAll) reveals ALL open leads — same sort,
 * blank visitDates last. Pure; bare YYYY-MM-DD string comparison. */
function mrLeadsForPicker(leads, todayISO, showAll) {
  var list = (Array.isArray(leads) ? leads : []).filter(function (l) {
    if (!l || !l.id) return false;
    if (showAll) return true;
    return !!l.visitDate && String(l.visitDate) <= String(todayISO);
  });
  return list.slice().sort(function (a, b) {
    var av = a.visitDate || '';
    var bv = b.visitDate || '';
    if (av === bv) return String(a.name || '').localeCompare(String(b.name || ''), 'he');
    if (!av) return 1;  // blanks last
    if (!bv) return -1;
    return av < bv ? 1 : -1; // desc
  });
}

/* Picker date: 'YYYY-MM-DD' → 'DD/MM', wrapped in a Unicode LTR isolate
 * (U+2066 LRI … U+2069 PDI) so the digit run cannot be bidi-reordered inside
 * the RTL option label. An ISO value renders as DD/MM; a non-empty legacy
 * value that isn't ISO is shown verbatim but still isolated; empty → ''
 * (the label omits the date segment entirely). */
function mrPickerDate(v) {
  var s = String(v == null ? '' : v);
  if (!s) return '';
  var m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  var text = m ? m[3] + '/' + m[2] : s;
  return '\u2066' + text + '\u2069';
}

/* The companion value to SUBMIT: the chip key, except אחר ('other') where the
 * free text becomes the value (trimmed). Empty free text falls back to the
 * 'other' key itself so the report still records that someone else came. */
function mrCompanionValue(selectedKey, freeText) {
  if (selectedKey !== 'other') return selectedKey || '';
  var t = String(freeText == null ? '' : freeText).trim();
  return t || 'other';
}

/* Display rule (PR 1): preset key → its label; anything else is raw free text
 * from the אחר flow, shown verbatim. */
function mrCompanionDisplay(value) {
  return MR_COMPANION_LABELS[value] || String(value == null ? '' : value);
}

function mrHouseLabel(houseId) {
  return MR_HOUSE_LABELS[houseId] || String(houseId == null ? '' : houseId);
}

/* Live counter text under the פירוט textarea: 'X / 5000', wrapped in a Unicode
 * LTR isolate (U+2066 LRI … U+2069 PDI) exactly like mrPickerDate — without it
 * the two digit runs around the slash are re-ordered by the RTL page and the
 * counter reads '5000 / 0'. Pure. */
function mrNoteCounterText(len) {
  var n = Number(len);
  if (!isFinite(n) || n < 0) n = 0;
  return '\u2066' + n + ' / ' + MANAGER_REPORT_MAX_CHARS + '\u2069';
}

/* true once the counter should go amber (strictly ABOVE the warn threshold).
 * Pure. */
function mrNoteCounterWarn(len) {
  return Number(len) > MANAGER_REPORT_WARN_CHARS;
}

/* '' when the פירוט is submittable, otherwise the Hebrew refusal. Mirrors
 * submitMeetingReport_'s cap (and server.js's pre-check) so an over-long note
 * is refused at the form instead of travelling to the sheet. Never truncates;
 * the message carries lengths only, never the text. Pure. */
function mrNoteError(note) {
  var len = String(note == null ? '' : note).length;
  return len > MANAGER_REPORT_MAX_CHARS
    ? 'הפירוט מוגבל ל-' + MANAGER_REPORT_MAX_CHARS + ' תווים (נכתבו ' + len + ')'
    : '';
}

/* The WhatsApp group message. `saved` carries what was actually submitted:
 * { name, house, outcome, companion, note, reporter }. */
function mrWhatsAppMessage(saved) {
  var s = saved || {};
  return [
    'דיווח פגישה — E-Zone',
    'ליד: ' + (s.name || '') + ' (' + mrHouseLabel(s.house) + ')',
    'תוצאה: ' + (MR_OUTCOME_LABELS[s.outcome] || s.outcome || ''),
    'הגיע/ה עם: ' + mrCompanionDisplay(s.companion),
    'פירוט: ' + (s.note || ''),
    'דווח ע"י: ' + (s.reporter || ''),
  ].join('\n');
}

/* wa.me chat-picker link — no phone number, the manager picks the group.
 *
 * WhatsApp (and the browsers/OS handlers in front of it) choke on very long
 * deep links, and a 5,000-char פירוט encodes to ~15,000 chars of %D7%.. — so
 * the MESSAGE (only the message) is cut to fit MR_WA_URL_MAX and marked with
 * '…'. The report ON THE SHEET is always the full text; this shortening exists
 * solely so the share button keeps working. */
var MR_WA_BASE = 'https://wa.me/?text=';
var MR_WA_URL_MAX = 2000;

/* Cut a string to `n` characters without splitting a surrogate pair (a lone
 * high surrogate would make encodeURIComponent throw). Pure. */
function mrSafeCut(s, n) {
  var out = String(s == null ? '' : s).slice(0, Math.max(0, n));
  var last = out.charCodeAt(out.length - 1);
  if (out.length && last >= 0xD800 && last <= 0xDBFF) out = out.slice(0, out.length - 1);
  return out;
}

function mrWhatsAppLink(text) {
  var s = String(text == null ? '' : text);
  var url = MR_WA_BASE + encodeURIComponent(s);
  if (url.length <= MR_WA_URL_MAX) return url;
  // Longest prefix whose encoded link still fits, found by bisection (encoded
  // length is monotonic in the prefix length).
  var lo = 0, hi = s.length;
  while (lo < hi) {
    var mid = Math.ceil((lo + hi) / 2);
    var candidate = MR_WA_BASE + encodeURIComponent(mrSafeCut(s, mid) + '…');
    if (candidate.length <= MR_WA_URL_MAX) lo = mid; else hi = mid - 1;
  }
  return MR_WA_BASE + encodeURIComponent(mrSafeCut(s, lo) + '…');
}

/* Hebrew error text for a failed submit, keyed by the backend's stable error
 * code (submitMeetingReport_ in Code.gs / the proxy routes). Surfacing the
 * specific reason — with the raw code appended for a phone screenshot — is
 * what keeps a backend-level refusal VISIBLE at the form: the confirmation
 * screen renders only on { ok: true }, never on a 200 that carries an error. */
var MR_SUBMIT_ERROR_TEXTS = {
  bad_lead:       'נא לבחור ליד',
  bad_outcome:    'לא נבחרה תוצאה תקינה',
  bad_companion:  'הטקסט בשדה "הגיע/ה עם" ארוך מדי (עד 100 תווים)',
  bad_note:       'הפירוט ארוך מדי (עד ' + MANAGER_REPORT_MAX_CHARS + ' תווים)',
  bad_reporter:   'נא לבחור מדווח/ת',
  lead_not_found: 'הליד כבר לא ברשימת הלידים הפתוחים — רעננו את הדף ונסו שוב',
  unauthorized:   'השרת דחה את הדיווח (בעיית הרשאה) — פנו לסנדרה',
  meeting_report_not_configured: 'השרת אינו מוגדר לדיווחי פגישות — פנו לסנדרה',
  sheets_unreachable:  'אין חיבור לגיליון — נסו שוב בעוד רגע',
  write_verify_failed: 'הדיווח לא נשמר בגיליון — נסו שוב, ואם זה חוזר פנו לסנדרה',
  exception:      'שגיאה בשרת הנתונים — נסו שוב, ואם זה חוזר פנו לסנדרה',
};

function mrSubmitErrorText(code) {
  var c = String(code == null ? '' : code);
  var known = MR_SUBMIT_ERROR_TEXTS[c];
  if (known) return known + ' (' + c + ')';
  if (c && c !== 'submit_failed') return 'השליחה נכשלה — הדיווח לא נשמר (' + c + ')';
  return 'השליחה נכשלה — הדיווח לא נשמר, נסו שוב';
}

function mrEscapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Expose for the test harness (Node vm sandbox) without affecting the browser.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    MR_HOUSE_LABELS: MR_HOUSE_LABELS,
    MEETING_REPORTERS: MEETING_REPORTERS,
    MR_OUTCOME_LABELS: MR_OUTCOME_LABELS,
    MR_COMPANION_LABELS: MR_COMPANION_LABELS,
    mrTodayISO: mrTodayISO,
    mrLeadsForPicker: mrLeadsForPicker,
    mrPickerDate: mrPickerDate,
    mrCompanionValue: mrCompanionValue,
    mrCompanionDisplay: mrCompanionDisplay,
    mrHouseLabel: mrHouseLabel,
    mrWhatsAppMessage: mrWhatsAppMessage,
    mrWhatsAppLink: mrWhatsAppLink,
    mrSafeCut: mrSafeCut,
    MR_WA_URL_MAX: MR_WA_URL_MAX,
    MANAGER_REPORT_MAX_CHARS: MANAGER_REPORT_MAX_CHARS,
    MANAGER_REPORT_WARN_CHARS: MANAGER_REPORT_WARN_CHARS,
    mrNoteCounterText: mrNoteCounterText,
    mrNoteCounterWarn: mrNoteCounterWarn,
    mrNoteError: mrNoteError,
    mrEscapeHtml: mrEscapeHtml,
    MR_SUBMIT_ERROR_TEXTS: MR_SUBMIT_ERROR_TEXTS,
    mrSubmitErrorText: mrSubmitErrorText,
  };
}

/* ===== DOM wiring (browser only) ===== */

(function () {
  if (typeof document === 'undefined' || !document.getElementById) return;
  var form = document.getElementById('mr-form');
  if (!form) return; // not the meeting-report page (e.g. test sandbox)

  var state = {
    leads: [],
    showAll: false,
    outcome: '',
    companion: '',
    busy: false,
  };

  var el = function (id) { return document.getElementById(id); };

  /* Local equivalent of app.js's withBusyButton: disable + label swap while an
   * async submit runs, so a double tap can never fire twice. */
  function withBusy(btn, busyLabel, fn) {
    if (state.busy) return Promise.resolve();
    state.busy = true;
    var prev = btn.textContent;
    btn.disabled = true;
    btn.textContent = busyLabel;
    return Promise.resolve()
      .then(fn)
      .finally(function () {
        state.busy = false;
        btn.disabled = false;
        btn.textContent = prev;
      });
  }

  function showError(msg) {
    var e = el('mr-error');
    e.textContent = msg;
    e.classList.remove('hidden');
  }
  function clearError() { el('mr-error').classList.add('hidden'); }

  function renderReporters() {
    var sel = el('mr-reporter');
    var opts = ['<option value="">בחר/י מדווח/ת…</option>'];
    Object.keys(MEETING_REPORTERS).forEach(function (k) {
      var name = MEETING_REPORTERS[k];
      opts.push('<option value="' + mrEscapeHtml(name) + '">' + mrEscapeHtml(name) + '</option>');
    });
    sel.innerHTML = opts.join('');
  }

  function renderLeads() {
    var sel = el('mr-lead');
    var list = mrLeadsForPicker(state.leads, mrTodayISO(), state.showAll);
    var opts = ['<option value="">בחר/י ליד…</option>'];
    list.forEach(function (l) {
      var d = mrPickerDate(l.visitDate);
      var label = l.name + ' — ' + mrHouseLabel(l.house) + (d ? ' — ' + d : '');
      opts.push('<option value="' + mrEscapeHtml(l.id) + '">' + mrEscapeHtml(label) + '</option>');
    });
    sel.innerHTML = opts.join('');
    el('mr-lead-toggle').textContent = state.showAll ? 'הצג רק לידים שביקרו' : 'לא מוצא את הליד?';
  }

  function renderOutcomes() {
    var box = el('mr-outcomes');
    box.innerHTML = MR_OUTCOME_ORDER.map(function (k) {
      var on = state.outcome === k ? ' selected' : '';
      return '<button type="button" class="mr-choice' + on + '" data-outcome="' + k + '">' +
        mrEscapeHtml(MR_OUTCOME_LABELS[k]) + '</button>';
    }).join('');
  }

  function renderCompanions() {
    var box = el('mr-companions');
    box.innerHTML = MR_COMPANION_ORDER.map(function (k) {
      var on = state.companion === k ? ' selected' : '';
      return '<button type="button" class="mr-chip' + on + '" data-companion="' + k + '">' +
        mrEscapeHtml(MR_COMPANION_LABELS[k]) + '</button>';
    }).join('');
    el('mr-companion-other-wrap').classList.toggle('hidden', state.companion !== 'other');
  }

  function loadLeads() {
    return fetch('/api/meeting-report/leads')
      .then(function (res) {
        if (res.status === 401) { location.reload(); throw new Error('unauthorized'); }
        return res.json();
      })
      .then(function (data) {
        if (!data || data.ok !== true) throw new Error('bad response');
        state.leads = data.leads || [];
        renderLeads();
      })
      .catch(function () {
        showError('טעינת הלידים נכשלה — נסו לרענן את הדף');
      });
  }

  function selectedLead() {
    var id = el('mr-lead').value;
    for (var i = 0; i < state.leads.length; i++) {
      if (String(state.leads[i].id) === id) return state.leads[i];
    }
    return null;
  }

  function submit() {
    clearError();
    var lead = selectedLead();
    var reporter = el('mr-reporter').value;
    var note = el('mr-note').value.trim();
    if (!reporter) return showError('נא לבחור מדווח/ת');
    if (!lead) return showError('נא לבחור ליד');
    if (!state.outcome) return showError('נא לבחור תוצאה');
    // maxlength already stops typing/pasting past the cap in every browser we
    // support; this is the belt-and-braces refusal (and the one a scripted or
    // autofilled value hits) — refuse, never trim.
    var noteErr = mrNoteError(note);
    if (noteErr) return showError(noteErr);
    var companion = mrCompanionValue(state.companion, el('mr-companion-other').value);
    var payload = {
      leadId: lead.id,
      outcome: state.outcome,
      companion: companion,
      note: note,
      reporter: reporter,
    };
    return withBusy(el('mr-submit'), 'שולח…', function () {
      return fetch('/api/meeting-report/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }).then(function (res) {
        if (res.status === 401) { location.reload(); throw new Error('unauthorized'); }
        return res.json();
      }).then(function (data) {
        if (!data || data.ok !== true) {
          throw new Error((data && data.error) || 'submit_failed');
        }
        showConfirmation({
          name: lead.name,
          house: lead.house,
          outcome: state.outcome,
          companion: companion,
          note: note,
          reporter: reporter,
        });
      }).catch(function (err) {
        showError(mrSubmitErrorText(err && err.message));
      });
    });
  }

  function showConfirmation(saved) {
    form.classList.add('hidden');
    var done = el('mr-done');
    done.classList.remove('hidden');
    el('mr-summary').innerHTML = [
      '<div><span>ליד:</span> ' + mrEscapeHtml(saved.name) + ' (' + mrEscapeHtml(mrHouseLabel(saved.house)) + ')</div>',
      '<div><span>תוצאה:</span> ' + mrEscapeHtml(MR_OUTCOME_LABELS[saved.outcome] || saved.outcome) + '</div>',
      '<div><span>הגיע/ה עם:</span> ' + mrEscapeHtml(mrCompanionDisplay(saved.companion)) + '</div>',
      // pre-wrap span (.mr-note-text): the manager's line breaks survive and a
      // 5,000-char summary wraps in full — never clipped, never scrolled away.
      saved.note ? '<div><span>פירוט:</span> <span class="mr-note-text">' + mrEscapeHtml(saved.note) + '</span></div>' : '',
      '<div><span>דווח ע"י:</span> ' + mrEscapeHtml(saved.reporter) + '</div>',
    ].join('');
    el('mr-whatsapp').href = mrWhatsAppLink(mrWhatsAppMessage(saved));
  }

  function resetForm() {
    state.outcome = '';
    state.companion = '';
    el('mr-lead').value = '';
    el('mr-note').value = '';
    el('mr-companion-other').value = '';
    syncNote();
    renderOutcomes();
    renderCompanions();
    el('mr-done').classList.add('hidden');
    form.classList.remove('hidden');
    clearError();
    loadLeads(); // refresh — the just-reported lead may have new state
  }

  /* The פירוט textarea: live 'X / 5000' counter (amber past the warn
   * threshold) and auto-grow, so a long report is written and re-read in one
   * box instead of a 3-row peephole. The counter never blocks anything — the
   * cap is enforced by maxlength + mrNoteError + the backend. */
  var MR_NOTE_MAX_HEIGHT = 520; // px — beyond this the textarea scrolls itself
  function syncNote() {
    var ta = el('mr-note');
    var counter = el('mr-note-count');
    if (!ta) return;
    var len = ta.value.length;
    if (counter) {
      counter.textContent = mrNoteCounterText(len);
      counter.classList.toggle('warn', mrNoteCounterWarn(len));
    }
    // Auto-grow: collapse to the content height, capped so the page stays usable.
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, MR_NOTE_MAX_HEIGHT) + 'px';
  }
  el('mr-note').addEventListener('input', syncNote);

  el('mr-outcomes').addEventListener('click', function (ev) {
    var b = ev.target.closest('[data-outcome]');
    if (!b) return;
    state.outcome = b.getAttribute('data-outcome');
    renderOutcomes();
  });
  el('mr-companions').addEventListener('click', function (ev) {
    var b = ev.target.closest('[data-companion]');
    if (!b) return;
    state.companion = b.getAttribute('data-companion');
    renderCompanions();
  });
  el('mr-lead-toggle').addEventListener('click', function () {
    state.showAll = !state.showAll;
    renderLeads();
  });
  el('mr-submit').addEventListener('click', submit);
  el('mr-again').addEventListener('click', resetForm);

  renderReporters();
  renderOutcomes();
  renderCompanions();
  syncNote();
  loadLeads();
})();
