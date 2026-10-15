/* Expected-discharge alerts — the Dashboard card «שחרורים צפויים» (Task F,
 * 15 Oct 2026). CHANGELOG-dashboard-expected-discharges.md.
 *
 * READ-ONLY. The dates are set by the house managers in the Managers app
 * (ezone-managers «מטופלים בבית»); the Dashboard only shows them. Data comes
 * from the Apps Script action `expectedDischarges` — the SAME sheet and the
 * same "last row of a stay wins" reader that Managers' houseData uses, so
 * there is one source of truth.
 *
 * THE RULE — shared with ezone-managers public/discharge-alerts.js (Task E).
 * The two apps are separate repos and cannot require each other, so the
 * core below (ALERT_LEAD_DAYS, israelToday, dayDiff, whenText, noDateText,
 * the alert window) is a COPY of the Managers module, and BOTH repos run the
 * identical fixture test/fixtures/discharge-alert-cases.json against their
 * own copy: any drift fails CI on the side that drifted.
 *   - expected date today .. +ALERT_LEAD_DAYS (inclusive) → «שחרור צפוי»;
 *   - expected date passed, patient still in the house → red «דורש עדכון»;
 *   - more than ALERT_LEAD_DAYS away → nothing;
 *   - no date → counted in ONE quiet line per house;
 *   - «אין צפי לשחרור» (expectedDischarge.none, 15 Oct 2026) → neither an
 *     alert nor counted as «ללא תאריך» (dischargeState).
 * "Today" is the calendar day in Asia/Jerusalem, whatever the device clock.
 *
 * Rendering is TEXT-ONLY: createElement + textContent, never innerHTML with
 * data. Nothing here logs. Display-only — no bonus or occupancy figure reads
 * it. Loaded by the page at /discharge-alerts.js (window.DischargeAlerts). */
(function (root) {
  'use strict';

  var ALERT_LEAD_DAYS = 14;
  var TIME_ZONE = 'Asia/Jerusalem';
  var ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

  /* ── shared core (identical behaviour to ezone-managers) ── */
  function isRealIso(s) {
    if (!ISO_RE.test(String(s || ''))) return false;
    var d = new Date(s + 'T00:00:00Z');
    return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }

  /* 'yyyy-MM-dd' of `now` (Date | ms; default: the current time) in Israel. */
  function israelToday(now) {
    var d = now instanceof Date ? now : new Date(now == null ? Date.now() : now);
    var parts = new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
    var get = function (t) { for (var i = 0; i < parts.length; i++) if (parts[i].type === t) return parts[i].value; return ''; };
    return get('year') + '-' + get('month') + '-' + get('day');
  }

  /* Whole calendar days from ISO date a to ISO date b. */
  function dayDiff(a, b) {
    return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
  }

  function fmtDate(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
    return m ? (parseInt(m[3], 10) + '/' + parseInt(m[2], 10) + '/' + m[1].slice(2)) : '';
  }

  function whenText(days) {
    if (days === 0) return 'היום';
    if (days === 1) return 'מחר';
    if (days > 1) return 'בעוד ' + days + ' ימים';
    if (days === -1) return 'התאריך עבר אתמול';
    return 'התאריך עבר לפני ' + (-days) + ' ימים';
  }

  function noDateText(n) {
    return n === 1 ? 'מטופל/ת אחד/ת ללא תאריך שחרור משוער' : n + ' מטופלים ללא תאריך שחרור משוער';
  }

  /* The alert of one expected date, or null when it is outside the window.
   * { days, kind: 'soon' | 'overdue', whenText } — the shared boundary rule. */
  function classify(date, today) {
    if (!isRealIso(date) || !isRealIso(today)) return null;
    var days = dayDiff(today, date);
    if (days > ALERT_LEAD_DAYS) return null;
    return { days: days, kind: days < 0 ? 'overdue' : 'soon', whenText: whenText(days) };
  }

  /* The state of one patient's expectedDischarge value (shared rule):
   *   'none'   — marked «אין צפי לשחרור»: no alert, not counted as no-date;
   *   'date'   — a real date: classify() decides the alert;
   *   'noDate' — nothing set (null, cleared, or no real date). */
  function dischargeState(ed) {
    if (ed && typeof ed === 'object' && ed.none === true) return 'none';
    return ed && typeof ed === 'object' && isRealIso(ed.date) ? 'date' : 'noDate';
  }

  /* ── Dashboard view model ── */

  /* «נקבע ע״י <manager> ב-<date>» from the audit fields (editedAt is an ISO
   * timestamp; its calendar day is taken in Israel). */
  function setByText(ed) {
    var who = String(ed && ed.editedBy != null ? ed.editedBy : '').trim();
    var at = ed && ed.editedAt ? new Date(String(ed.editedAt)) : null;
    var when = at && !isNaN(at.getTime()) ? fmtDate(israelToday(at)) : '';
    var out = 'נקבע';
    if (who) out += ' ע״י ' + who;
    if (when) out += ' ב-' + when;
    return out === 'נקבע' ? '' : out;
  }

  function byDateThenName(a, b) {
    return a.date < b.date ? -1 : a.date > b.date ? 1 : (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  }

  /* The card's model from the `expectedDischarges` feed:
   *   { supported, soon: [...], overdue: [...], noDate: [{ house, label, count }], noExpected, count }
   * noExpected = patients marked «אין צפי לשחרור» (never an alert or a no-date line).
   * Each alert: { house, houseLabel, name, date, dateText, days, kind, whenText, setBy }.
   * Lists sorted by date, then name. `labels` (optional) overrides house labels. */
  function dashboardModel(feed, today, labels) {
    var f = feed || {};
    var out = { supported: f.expectedDischargeSupported === true, soon: [], overdue: [], noDate: [], noExpected: 0, count: 0 };
    if (!out.supported) return out;
    var t = isRealIso(today) ? today : israelToday();
    (Array.isArray(f.houses) ? f.houses : []).forEach(function (h) {
      if (!h || typeof h !== 'object') return;
      var key = String(h.house || '');
      var label = String((labels && labels[key]) || h.label || key);
      var missing = 0;
      (Array.isArray(h.patients) ? h.patients : []).forEach(function (p) {
        if (!p || typeof p !== 'object') return;
        var ed = p.expectedDischarge;
        var st = dischargeState(ed);
        if (st === 'none') { out.noExpected++; return; }
        if (st === 'noDate') { missing++; return; }
        var date = ed.date;
        var c = classify(date, t);
        if (!c) return;
        (c.kind === 'overdue' ? out.overdue : out.soon).push({
          house: key, houseLabel: label, name: String(p.name == null ? '' : p.name),
          date: date, dateText: fmtDate(date), days: c.days, kind: c.kind, whenText: c.whenText,
          setBy: setByText(ed)
        });
      });
      if (missing > 0) out.noDate.push({ house: key, label: label, count: missing });
    });
    out.soon.sort(byDateThenName);
    out.overdue.sort(byDateThenName);
    out.count = out.soon.length + out.overdue.length;
    return out;
  }

  /* ── text-only DOM ── */
  function node(doc, tag, cls, text) {
    var e = doc.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = String(text);
    return e;
  }

  function alertRow(doc, a) {
    var li = node(doc, 'li', 'xd-row ' + (a.kind === 'overdue' ? 'is-overdue' : 'is-soon'));
    var main = node(doc, 'div', 'xd-main');
    main.appendChild(node(doc, 'span', 'xd-name', a.name));
    main.appendChild(node(doc, 'span', 'xd-house', a.houseLabel));
    if (a.kind === 'overdue') main.appendChild(node(doc, 'span', 'xd-tag', 'דורש עדכון'));
    li.appendChild(main);
    li.appendChild(node(doc, 'div', 'xd-when', 'שחרור משוער: ' + a.dateText + ' · ' + a.whenText));
    if (a.setBy) li.appendChild(node(doc, 'div', 'xd-setby', a.setBy));
    return li;
  }

  /* Fill `card` (an existing element) with the model, or a state:
   * opts.state = 'loading' | 'error' | undefined. Clears the card first. */
  function renderCard(doc, card, model, opts) {
    opts = opts || {};
    while (card.firstChild) card.removeChild(card.firstChild);
    var head = node(doc, 'div', 'xd-head');
    head.appendChild(node(doc, 'span', 'xd-title', 'שחרורים צפויים'));
    var count = node(doc, 'span', 'renewal-alert-count xd-count', model && model.count ? String(model.count) : '0');
    head.appendChild(count);
    card.appendChild(head);
    card.appendChild(node(doc, 'div', 'xd-hint', 'לקריאה בלבד · התאריכים נקבעים ומשתנים באפליקציית המנהלים'));

    if (opts.state === 'loading') { card.appendChild(node(doc, 'div', 'xd-empty', 'טוען שחרורים צפויים…')); return card; }
    if (opts.state === 'error') {
      card.appendChild(node(doc, 'div', 'xd-empty xd-error', 'לא ניתן לטעון את השחרורים הצפויים כרגע'));
      var retry = node(doc, 'button', 'btn small xd-retry', 'ניסיון חוזר');
      retry.type = 'button';
      retry.setAttribute('data-xd-retry', '');
      card.appendChild(retry);
      return card;
    }
    if (!model || !model.supported) { card.appendChild(node(doc, 'div', 'xd-empty', 'השחרורים הצפויים יופיעו אחרי עדכון השרת')); return card; }

    if (model.overdue.length) {
      var red = node(doc, 'div', 'xd-section xd-overdue');
      red.appendChild(node(doc, 'div', 'xd-section-title', 'דורש עדכון (' + model.overdue.length + ')'));
      var ul1 = node(doc, 'ul', 'xd-list');
      model.overdue.forEach(function (a) { ul1.appendChild(alertRow(doc, a)); });
      red.appendChild(ul1);
      card.appendChild(red);
    }
    if (model.soon.length) {
      var ul2 = node(doc, 'ul', 'xd-list');
      model.soon.forEach(function (a) { ul2.appendChild(alertRow(doc, a)); });
      card.appendChild(ul2);
    } else {
      card.appendChild(node(doc, 'div', 'xd-empty', 'אין שחרורים צפויים ב-' + ALERT_LEAD_DAYS + ' הימים הקרובים'));
    }
    model.noDate.forEach(function (h) {
      card.appendChild(node(doc, 'div', 'xd-nodate', h.label + ': ' + noDateText(h.count)));
    });
    return card;
  }

  var DischargeAlerts = {
    ALERT_LEAD_DAYS: ALERT_LEAD_DAYS, TIME_ZONE: TIME_ZONE,
    isRealIso: isRealIso, israelToday: israelToday, dayDiff: dayDiff, fmtDate: fmtDate,
    whenText: whenText, noDateText: noDateText, classify: classify, dischargeState: dischargeState, setByText: setByText,
    dashboardModel: dashboardModel, renderCard: renderCard
  };
  root.DischargeAlerts = DischargeAlerts;
  if (typeof module === 'object' && module.exports) module.exports = DischargeAlerts;
}(typeof self !== 'undefined' ? self : this));
