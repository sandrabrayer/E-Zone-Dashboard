/* Upcoming committees — the Dashboard card «ועדות קרובות» (15 Oct 2026).
 * CHANGELOG-dashboard-committees.md.
 *
 * READ-ONLY. The committee («ועדה») dates are set by the house managers in
 * the Managers app (ezone-managers «מטופלים בבית»); the Dashboard only shows
 * them. Data comes from the Apps Script action `upcomingCommittees` — the
 * SAME ManagersCommittee sheet and "last row of a stay wins" reader that
 * Managers' houseData uses, so there is one source of truth.
 *
 * THE RULE — shared with ezone-managers public/committee-alerts.js. The two
 * apps are separate repos and cannot require each other, so the core below
 * (COMMITTEE_LEAD_DAYS, israelToday, dayDiff, whenText, classify) is a COPY of
 * the Managers module, and BOTH repos run the identical fixture
 * test/fixtures/committee-alert-cases.json (sha256 pinned on both sides):
 *   - committee today                                → «היום» (first);
 *   - today+1 .. today+COMMITTEE_LEAD_DAYS (7, incl.) → the next 7 days;
 *   - more than 7 days ahead, or already passed      → not shown.
 * "Today" is the calendar day in Asia/Jerusalem, whatever the device clock.
 *
 * Rendering is TEXT-ONLY: createElement + textContent, never innerHTML with
 * data. Nothing here logs. Display-only. Loaded by the page at
 * /committee-alerts.js (window.CommitteeAlerts). */
(function (root) {
  'use strict';

  var COMMITTEE_LEAD_DAYS = 7;
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
    return 'בעוד ' + days + ' ימים';
  }

  /* The alert of one committee date, or null: { days, kind: 'today' | 'week', whenText }. */
  function classify(date, today) {
    if (!isRealIso(date) || !isRealIso(today)) return null;
    var days = dayDiff(today, date);
    if (days < 0 || days > COMMITTEE_LEAD_DAYS) return null;
    return { days: days, kind: days === 0 ? 'today' : 'week', whenText: whenText(days) };
  }

  /* ── Dashboard view model ── */

  /* «נקבע ע״י <manager> ב-<date>» from the audit fields (editedAt is an ISO
   * timestamp; its calendar day is taken in Israel). */
  function setByText(c) {
    var who = String(c && c.editedBy != null ? c.editedBy : '').trim();
    var at = c && c.editedAt ? new Date(String(c.editedAt)) : null;
    var when = at && !isNaN(at.getTime()) ? fmtDate(israelToday(at)) : '';
    var out = 'נקבע';
    if (who) out += ' ע״י ' + who;
    if (when) out += ' ב-' + when;
    return out === 'נקבע' ? '' : out;
  }

  function byDateThenName(a, b) {
    return a.date < b.date ? -1 : a.date > b.date ? 1 : (a.houseLabel < b.houseLabel ? -1 : a.houseLabel > b.houseLabel ? 1 : (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  /* The card's model from the `upcomingCommittees` feed:
   *   { supported, today: [...], week: [...], count } — plus, for a supported
   *   feed, `available` (false when the coordinators feed is down, 20 Oct 2026)
   *   and then `reason` and no rows: the card says «לא זמין», never "none". 
   * Each row: { house, houseLabel, name, date, dateText, label, days, kind, whenText, setBy }.
   * Sorted by date, then house, then name. `labels` (optional) overrides house labels. */
  function dashboardModel(feed, today, labels) {
    var f = feed || {};
    var out = { supported: f.committeeSupported === true, today: [], week: [], count: 0 };
    if (!out.supported) return out;
    out.available = f.available !== false;
    if (!out.available) { out.reason = String(f.reason == null ? '' : f.reason); return out; }
    var t = isRealIso(today) ? today : israelToday();
    (Array.isArray(f.houses) ? f.houses : []).forEach(function (h) {
      if (!h || typeof h !== 'object') return;
      var key = String(h.house || '');
      var houseLabel = String((labels && labels[key]) || h.label || key);
      (Array.isArray(h.patients) ? h.patients : []).forEach(function (p) {
        if (!p || typeof p !== 'object' || !p.committee || typeof p.committee !== 'object') return;
        var c = classify(p.committee.date, t);
        if (!c) return;
        (c.kind === 'today' ? out.today : out.week).push({
          house: key, houseLabel: houseLabel, name: String(p.name == null ? '' : p.name),
          date: p.committee.date, dateText: fmtDate(p.committee.date),
          label: String(p.committee.label == null ? '' : p.committee.label),
          days: c.days, kind: c.kind, whenText: c.whenText, setBy: setByText(p.committee)
        });
      });
    });
    out.today.sort(byDateThenName);
    out.week.sort(byDateThenName);
    out.count = out.today.length + out.week.length;
    return out;
  }

  /* ── text-only DOM ── */
  function node(doc, tag, cls, text) {
    var e = doc.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = String(text);
    return e;
  }

  function row(doc, a) {
    var li = node(doc, 'li', 'cmt-row ' + (a.kind === 'today' ? 'is-today' : 'is-week'));
    var main = node(doc, 'div', 'cmt-main');
    main.appendChild(node(doc, 'span', 'cmt-name', a.name));
    main.appendChild(node(doc, 'span', 'cmt-house', a.houseLabel));
    if (a.kind === 'today') main.appendChild(node(doc, 'span', 'cmt-tag', 'ועדה היום'));
    li.appendChild(main);
    li.appendChild(node(doc, 'div', 'cmt-when', 'ועדה: ' + a.dateText + (a.label ? ' · ' + a.label : '') + ' · ' + a.whenText));
    if (a.setBy) li.appendChild(node(doc, 'div', 'cmt-setby', a.setBy));
    return li;
  }

  /* Fill `card` (an existing element) with the model, or a state:
   * opts.state = 'loading' | 'error' | undefined. Clears the card first.
   * Empty and error states are always visible — the card never hides. */
  function renderCard(doc, card, model, opts) {
    opts = opts || {};
    while (card.firstChild) card.removeChild(card.firstChild);
    var head = node(doc, 'div', 'cmt-head');
    head.appendChild(node(doc, 'span', 'cmt-title', 'ועדות קרובות'));
    head.appendChild(node(doc, 'span', 'renewal-alert-count cmt-count', model && model.count ? String(model.count) : '0'));
    card.appendChild(head);
    card.appendChild(node(doc, 'div', 'cmt-hint', 'לקריאה בלבד · הוועדות נקבעות באפליקציית הרכזים'));

    if (opts.state === 'loading') { card.appendChild(node(doc, 'div', 'cmt-empty', 'טוען ועדות קרובות…')); return card; }
    if (opts.state === 'error') {
      card.appendChild(node(doc, 'div', 'cmt-empty cmt-error', 'לא ניתן לטעון את הוועדות הקרובות כרגע'));
      var retry = node(doc, 'button', 'btn small cmt-retry', 'ניסיון חוזר');
      retry.type = 'button';
      retry.setAttribute('data-cmt-retry', '');
      card.appendChild(retry);
      return card;
    }
    if (!model || !model.supported) { card.appendChild(node(doc, 'div', 'cmt-empty', 'הוועדות יופיעו אחרי עדכון השרת')); return card; }
    if (model.available === false) { card.appendChild(node(doc, 'div', 'cmt-empty cmt-error', 'הוועדות לא זמינות כרגע — הנתון מאפליקציית הרכזים לא התקבל')); return card; }

    if (model.today.length) {
      var red = node(doc, 'div', 'cmt-section cmt-today');
      red.appendChild(node(doc, 'div', 'cmt-section-title', 'היום (' + model.today.length + ')'));
      var ul1 = node(doc, 'ul', 'cmt-list');
      model.today.forEach(function (a) { ul1.appendChild(row(doc, a)); });
      red.appendChild(ul1);
      card.appendChild(red);
    }
    var wk = node(doc, 'div', 'cmt-section cmt-week');
    wk.appendChild(node(doc, 'div', 'cmt-section-title', COMMITTEE_LEAD_DAYS + ' הימים הקרובים (' + model.week.length + ')'));
    if (model.week.length) {
      var ul2 = node(doc, 'ul', 'cmt-list');
      model.week.forEach(function (a) { ul2.appendChild(row(doc, a)); });
      wk.appendChild(ul2);
    } else {
      wk.appendChild(node(doc, 'div', 'cmt-empty', model.today.length ? 'אין ועדות נוספות ב-' + COMMITTEE_LEAD_DAYS + ' הימים הקרובים' : 'אין ועדות היום וב-' + COMMITTEE_LEAD_DAYS + ' הימים הקרובים'));
    }
    card.appendChild(wk);
    return card;
  }

  var CommitteeAlerts = {
    COMMITTEE_LEAD_DAYS: COMMITTEE_LEAD_DAYS, TIME_ZONE: TIME_ZONE,
    isRealIso: isRealIso, israelToday: israelToday, dayDiff: dayDiff, fmtDate: fmtDate,
    whenText: whenText, classify: classify, setByText: setByText,
    dashboardModel: dashboardModel, renderCard: renderCard
  };
  root.CommitteeAlerts = CommitteeAlerts;
  if (typeof module === 'object' && module.exports) module.exports = CommitteeAlerts;
}(typeof self !== 'undefined' ? self : this));
