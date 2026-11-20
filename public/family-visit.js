/* The two dashboard views share one family-facing draft. All fields that can
 * leave the dashboard come from a fresh, authorized preview of the saved visit. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FamilyVisit = api;
})(typeof window !== 'undefined' ? window : this, function () {
  'use strict';

  function draftText(visit) {
    if (!visit || !visit.houseName || !visit.address ||
        !/^\d{4}-\d{2}-\d{2}$/.test(visit.date) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(visit.time)) return '';
    const day = new Date(visit.date + 'T12:00:00Z');
    if (!Number.isFinite(day.getTime()) || day.toISOString().slice(0, 10) !== visit.date) return '';
    const weekday = new Intl.DateTimeFormat('he-IL', { weekday: 'long', timeZone: 'UTC' }).format(day);
    const date = visit.date.split('-').reverse().join('/');
    return ['שלום, הביקור בבית ' + visit.houseName + ' נקבע ל' + weekday + ', ' + date + ', בשעה ' + visit.time + '.',
      'כתובת: ' + visit.address,
      'ניווט: https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(visit.address),
      visit.instructions && 'הנחיות הגעה: ' + visit.instructions,
      'לשינוי המועד אפשר לפנות אלינו.'].filter(Boolean).join('\n');
  }

  function draftRecipients(rows) {
    return (Array.isArray(rows) ? rows : []).filter(function (r) {
      return r && (r.role === 'patient' || r.role === 'contact') && /^[1-9]\d{7,14}$/.test(r.phone);
    });
  }

  function matchesSlot(visit, expected) {
    return !!visit && visit.houseId === expected.houseId && visit.date === expected.date && visit.time === expected.time;
  }

  async function readPreview(win, id) {
    let r, body;
    try {
      r = await win.fetch('/api/family-visit/' + encodeURIComponent(id) + '/preview', {
        credentials: 'same-origin', cache: 'no-store'
      });
      body = await r.json();
    } catch (_) {
      throw new Error('לא התקבלה תשובה מהדשבורד. פתחי שוב את הטיוטה כשהחיבור זמין.');
    }
    if (!r.ok || !body || body.ok !== true || !body.visit) {
      if (r.status === 403 || r.status === 401) throw new Error('נדרשת הרשאה לטיפול בפנייה.');
      if (r.status === 404 || r.status === 409) throw new Error('אין כרגע ביקור שמור שמתאים לשליחת פרטי הגעה. רענני את הכרטיס.');
      throw new Error('קריאת הביקור השמור נכשלה. אפשר לנסות שוב מהכרטיס.');
    }
    return body;
  }

  function open(win, expected) {
    const doc = win.document;
    const previous = doc.getElementById('family-visit-preview');
    if (previous) { previous.close(); previous.remove(); }
    const dialog = doc.createElement('dialog');
    dialog.id = 'family-visit-preview';
    dialog.dir = 'rtl';
    dialog.setAttribute('aria-labelledby', 'family-visit-title');
    dialog.innerHTML = '<form method="dialog"><h2 id="family-visit-title">פרטי ביקור למשפחה</h2>'
      + '<button type="submit" aria-label="סגירה">✕</button></form>'
      + '<p data-status role="status" aria-live="polite"></p><div data-body hidden>'
      + '<div data-text></div><label>למי אושר לשלוח את פרטי הביקור?<select data-recipient></select></label>'
      + '<button type="button" data-confirm disabled>אישור הנמען ופתיחת הטיוטה בוואטסאפ</button></div>';
    const status = dialog.querySelector('[data-status]');
    const body = dialog.querySelector('[data-body]');
    const preview = dialog.querySelector('[data-text]');
    const select = dialog.querySelector('[data-recipient]');
    const confirm = dialog.querySelector('[data-confirm]');
    const before = doc.activeElement;
    dialog.addEventListener('close', function () {
      dialog.remove();
      if (before && before.isConnected && !doc.querySelector('#family-visit-preview[open]')) before.focus();
    });
    doc.body.appendChild(dialog);
    dialog.showModal();
    status.textContent = 'טוען את הביקור שנשמר…';
    let recipients = [];
    let message = '';
    const active = function () { return dialog.open && dialog.isConnected; };
    const block = function (reason) {
      body.hidden = true;
      status.textContent = reason;
    };

    function display(data) {
      if (!matchesSlot(data.visit, expected)) return block('המועד או הבית השתנו. רענני את הכרטיס ובדקי את הביקור המעודכן.');
      message = draftText(data.visit);
      if (!message) return block('חסרים פרטי ביקור או כתובת הגעה מאושרת לבית.');
      recipients = draftRecipients(data.recipients);
      if (!recipients.length) return block('חסר מספר תקין של המטופל/ת או של איש הקשר לתיאום. עדכני את הכרטיס.');
      preview.textContent = message;
      select.replaceChildren(new win.Option('בחירת נמען', ''));
      recipients.forEach(function (r) {
        const role = r.role === 'contact' ? 'איש/אשת קשר' : 'המטופל/ת';
        select.add(new win.Option([role, r.name, '+' + r.phone].filter(Boolean).join(' · '), r.role));
      });
      select.disabled = false;
      confirm.disabled = true;
      body.hidden = false;
      status.textContent = 'הטיוטה מוכנה לפי הביקור השמור.';
    }

    readPreview(win, expected.id).then(function (data) {
      if (active()) display(data);
    }).catch(function (err) { if (active()) block(err.message || 'קריאת פרטי הביקור נכשלה.'); });

    select.addEventListener('change', function () {
      confirm.disabled = !select.value;
      status.textContent = 'בחרי בנמען שאישר קבלת פרטי ביקור בוואטסאפ.';
    });
    confirm.addEventListener('click', async function () {
      const chosen = recipients.find(function (r) { return r.role === select.value; });
      if (!chosen || confirm.disabled) return;
      select.disabled = true;
      confirm.disabled = true;
      try {
        const latest = await readPreview(win, expected.id);
        if (!active()) return;
        const recipient = draftRecipients(latest.recipients).find(function (r) { return r.role === chosen.role; });
        if (!matchesSlot(latest.visit, expected) || draftText(latest.visit) !== message ||
            !recipient || recipient.phone !== chosen.phone || recipient.name !== chosen.name) {
          display(latest);
          if (!body.hidden) status.textContent = 'פרטי הביקור או הנמען השתנו. בדקי ואשרי מחדש.';
          return;
        }
        // Same-tab HTTPS navigation also works in a standalone PWA; a popup
        // after the asynchronous read may be blocked. Opening is not a receipt.
        win.location.assign('https://wa.me/' + recipient.phone + '?text=' + encodeURIComponent(message));
        dialog.close();
      } catch (err) {
        if (active()) block(err.message || 'אימות הביקור נכשל. פתחי שוב את הטיוטה מהכרטיס.');
      }
    });
  }
  return { open: open, draftText: draftText, draftRecipients: draftRecipients, matchesSlot: matchesSlot };
});
