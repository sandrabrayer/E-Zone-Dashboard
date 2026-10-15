'use strict';
(() => {
  const el = id => document.getElementById(id);
  const reasons = { lead_followup: 'מעקב אחר פנייה', meeting_result: 'השלמת תוצאת מפגש' };
  const uncertainties = {
    source_unavailable: 'המקור אינו זמין. המשימה נשמרה מהאיסוף הקודם.',
    missing_in_source: 'הרשומה לא התקבלה באיסוף האחרון. נדרשת בדיקה במקור.',
    unconfirmed_source: 'המידע שהתקבל חלקי. נדרשת בדיקה במקור.',
    unknown_status: 'הסטטוס במקור אינו מוכר. נדרשת בדיקה.',
  };
  let queue = null, generation = 0, controller;
  function node(tag, text, className) {
    const n = document.createElement(tag); n.textContent = text;
    if (className) n.className = className;
    return n;
  }
  function date(value) {
    if (!value || value === 'invalid') return value === 'invalid' ? 'מועד לא תקין במקור' : 'לא נמסר';
    const parts = value.split('-'); return `${parts[2]}.${parts[1]}.${parts[0]}`;
  }
  function stamp(value) {
    return value ? new Intl.DateTimeFormat('he-IL', { timeZone: 'Asia/Jerusalem', dateStyle: 'short', timeStyle: 'short' }).format(new Date(value)) : 'לא ידוע';
  }
  function status(text, level = '') { el('status').textContent = text; el('status').dataset.level = level; }
  function clear() {
    queue = null; el('tasks').replaceChildren(); el('summary').replaceChildren();
    el('work').hidden = true; el('summary').hidden = true; el('observed').textContent = ''; el('count').textContent = '';
  }
  function field(list, title, text) {
    const group = document.createElement('div'); group.append(node('dt', title), node('dd', text)); list.append(group);
  }
  function render() {
    if (!queue) return;
    el('summary').replaceChildren(); el('summary').hidden = false; el('work').hidden = false;
    for (const [value, label] of [[queue.rows.length, 'משימות פתוחות'], [queue.rows.filter(r => r.uncertainty).length, 'נדרשת בדיקה'], [queue.rows.filter(r => r.dueState === 'missing').length, 'ללא מועד מקורי']]) {
      const item = node('div', '', 'metric'); item.append(node('strong', String(value)), node('span', label)); el('summary').append(item);
    }
    const filter = el('filter').value;
    const rows = queue.rows.filter(r => filter === 'all' || (filter === 'uncertain' ? !!r.uncertainty : r.dueState === filter));
    el('count').textContent = `${rows.length} מתוך ${queue.rows.length} משימות`; el('tasks').replaceChildren();
    for (const r of rows) {
      const card = node('article', '', 'task'); card.append(node('h2', r.displayName || 'שם לא זמין'), node('p', reasons[r.reason] || 'נדרשת בדיקה', 'reason'));
      const details = document.createElement('dl');
      field(details, 'מבצעת נוכחית', r.assignee || 'לא הוגדרה'); field(details, 'אחריות כוללת', 'ורד');
      field(details, 'מועד מקורי', r.originalDueDate ? date(r.originalDueDate) + (r.dueState === 'overdue' ? ' · באיחור' : r.dueState === 'today' ? ' · היום' : '') : 'חסר — יש לברר');
      field(details, 'מועד מפגש במקור', date(r.eventDate)); field(details, 'נצפתה לאחרונה', stamp(r.lastSeenAt));
      field(details, 'עדכון הרשומה במקור', stamp(r.sourceUpdatedAt)); card.append(details);
      if (r.uncertainty) card.append(node('p', uncertainties[r.uncertainty] || 'המידע דורש בדיקה במקור.', 'warning'));
      const link = node('a', r.reason === 'meeting_result' ? 'למסך המפגשים' : 'לרשימת הפניות');
      // Fixed existing app screens, never native IDs/names in a URL.
      link.href = r.reason === 'meeting_result' ? '/#meetings' : '/#leads'; card.append(link); el('tasks').append(card);
    }
    el('empty').hidden = rows.length !== 0;
    el('empty').textContent = queue.rows.length ? 'אין משימות שמתאימות לסינון.' : !queue.historyAvailable ? 'טרם נשמר איסוף. לחצו על „עדכון מהמקור”.' : queue.source?.health !== 'fresh' || !queue.source?.complete ? 'אין משימות זמינות להצגה. המידע חלקי או חסר; אין בכך אישור שכל הטיפול הושלם.' : 'אין משימות פתוחות בתור לפי האיסוף האחרון.';
  }
  async function load(refresh = false) {
    const current = ++generation; controller?.abort(); controller = new AbortController();
    // No local/session storage or offline cache. Recheck authority on every load;
    // a failed response must not keep sensitive data from a former session.
    clear(); el('refresh').disabled = true;
    status(refresh ? 'אוסף מידע מהמקור ושומר את התור…' : 'טוען את התור השמור…');
    try {
      const response = await fetch(refresh ? '/api/crm/queue/refresh' : '/api/crm/queue', {
        method: refresh ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
        ...(refresh ? { headers: { 'Content-Type': 'application/json', 'X-CRM-Refresh': '1' }, body: '{}' } : {}),
      });
      if (current !== generation) return;
      if (!response.ok) {
        status(response.status === 401 || response.status === 403 ? 'הגישה אינה זמינה. יש להתחבר מחדש לדאשבורד עם הרשאה מתאימה.' : response.status === 409 ? 'האיסוף לא הושלם במופע הזה. טענו מחדש את המסך כדי לקרוא את התור השמור.' : 'לא ניתן לקרוא את התור השמור כרגע. אין בכך אישור שהמשימות הושלמו.', 'error');
        return;
      }
      const data = await response.json();
      if (current !== generation) return;
      if (data.contract !== 'crm-queue-v1' || !data.ok || !Array.isArray(data.queue?.rows)) throw Error('invalid_queue');
      queue = data.queue;
      const source = queue.source;
      status(!queue.historyAvailable ? 'טרם נשמר איסוף מהמקור.' : source?.health === 'unavailable' ? 'המקור אינו זמין. המשימות השמורות נשארות פתוחות ודורשות בדיקה.' : source?.health !== 'fresh' || !source?.complete ? 'המקור החזיר מידע חלקי. משימות שלא הוכרעו נשארות פתוחות.' : 'מוצג התור השמור לפי האיסוף האחרון. לעדכון המידע לחצו על „עדכון מהמקור”.', !queue.historyAvailable || source?.health !== 'fresh' || !source?.complete ? 'warning' : '');
      el('observed').textContent = source?.observedAt ? `מועד האיסוף מהמקור: ${stamp(source.observedAt)} · שעון ישראל` : 'מועד איסוף תקין אינו זמין.';
      render();
    } catch (_) { if (current === generation) { clear(); status('החיבור לתור אינו זמין. המשימות השמורות לא נמחקו; נסו לטעון שוב.', 'error'); } }
    finally { if (current === generation) el('refresh').disabled = false; }
  }
  function suspend() { ++generation; controller?.abort(); clear(); el('refresh').disabled = true; }
  el('refresh').addEventListener('click', () => load(true)); el('filter').addEventListener('change', render);
  window.addEventListener('pagehide', suspend);
  window.addEventListener('pageshow', e => { if (e.persisted) load(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) suspend(); else load(); });
  load();
})();
