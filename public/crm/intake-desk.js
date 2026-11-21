/* The private staff desk for repeat contacts and relatives' requests. */
(function (win, doc) {
  'use strict';
  const owners = { sandra: 'סנדרה', vered: 'ורד', dana: 'דנה', yael: 'יעל' };
  const channels = { whatsapp: 'הודעת וואטסאפ', phone: 'טלפון', whatsapp_call: 'שיחת וואטסאפ' };
  const historyChannels = Object.assign({ email: 'דוא״ל', sms: 'מסרון', in_person: 'פגישה', other: 'קשר' }, channels);
  const kinds = { message: 'מסר למטופל/ת', information: 'בקשת מידע' };
  const states = { new: 'התקבלה', routed: 'הועברה לצוות הבית', delivered: 'מסירת המסר למטופל/ת אושרה', answered: 'נמסר מענה מורשה', closed: 'נסגרה ללא מסירת מידע' };
  const reasons = { changed_request: 'הפנייה טופלה בעמדה אחרת. רענני את הרשימה.', check_resident: 'השהייה או הבית השתנו. בדקי מחדש את היעד לפני המשך הטיפול.',
    check_permission: 'יש לבדוק את ההרשאה הנוכחית למידע המבוקש.', bad_input: 'יש לבדוק את המספר ואת השדות שנבחרו.',
    forbidden: 'אין הרשאה לעמדת הקשר.', unavailable: 'הנתונים אינם זמינים כרגע. אפשר לנסות שוב.' };
  let context, user, timer, polling = false, generation = 0, dialog, panel, seen = new Set();
  function el(tag, text) { const node = doc.createElement(tag); if (text != null) node.textContent = text; return node; }
  function button(title, action, primary) {
    const b = el('button', title); b.type = 'button'; b.className = 'btn small' + (primary ? ' primary' : ''); b.onclick = action; return b;
  }
  function field(title, control) { const label = el('label', title); label.append(control); return label; }
  function select(labels, prompt) {
    const s = el('select'); if (prompt) s.add(new win.Option(prompt, ''));
    Object.entries(labels).forEach(function (pair) { s.add(new win.Option(pair[1], pair[0])); }); return s;
  }
  function input(type) { const i = el('input'); i.type = type; return i; }
  function check(title) { const i = input('checkbox'); const l = field('', i); l.append(doc.createTextNode(title)); l.className = 'desk-check'; return l; }
  function status() { const p = el('p'); p.setAttribute('role', 'status'); return p; }
  async function request(body) {
    const response = await win.fetch('/api/communications/desk', { method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(reasons[data.error] || reasons.unavailable);
    return data;
  }
  function startDialog(title) {
    if (dialog) dialog.close();
    const d = el('dialog'); d.className = 'intake-dialog'; d.dir = 'rtl'; d.setAttribute('aria-labelledby', 'intake-dialog-heading');
    const heading = el('h2', title); heading.id = 'intake-dialog-heading';
    const top = el('div'); top.className = 'desk-actions';
    const body = el('section');
    top.append(heading, button('סגירה', function () { d.close(); }));
    d.append(top, body); doc.body.append(d); dialog = d; panel = body;
    d.addEventListener('close', function () { if (dialog === d) { dialog = null; panel = null; } d.remove(); });
    d.showModal(); return body;
  }
  function actionForm(title, action, notice) {
    const form = el('form'), submit = button(title, null, true); submit.type = 'submit';
    form.addEventListener('submit', async function (ev) {
      ev.preventDefault(); if (submit.disabled) return; submit.disabled = true; notice.textContent = '';
      try { await action(); } catch (err) { notice.textContent = err.message || reasons.unavailable; }
      finally { submit.disabled = false; }
    });
    return { form: form, submit: submit };
  }
  function showHistory(box, record, query) {
    box.replaceChildren();
    const last = record.prior;
    if (['history','number_history'].includes(record.match) && last) {
      box.append(el('strong', record.match === 'history' ? 'פנייה חוזרת · קשר קודם בכרטיס' : 'קשר קודם עם המספר הזה'));
      box.append(el('p', [last.by || 'איש צוות לא מזוהה', context.when(last.at), historyChannels[last.channel], last.outcome].filter(Boolean).join(' · ')));
      if (record.match === 'number_history') {
        box.append(el('p', 'הקשר הקודם עדיין דורש שיוך לכרטיס פנייה.')); return;
      }
      if (record.next) box.append(el('p', 'משימת ההמשך: ' + [record.next.title, record.next.owner, context.when(record.next.due)].filter(Boolean).join(' · ')));
      else box.append(el('p', 'אין משימת המשך פתוחה בכרטיס.'));
      box.append(button('פתיחת כרטיס הפנייה', function () { if (dialog) dialog.close(); context.openLead(record.leadId); }));
    } else if (record.match === 'verify' || record.match === 'number_verify') {
      box.append(el('strong', record.match === 'verify' ? 'ייתכן שזו פנייה חוזרת. יש קשר קודם בכרטיס תואם.' : 'יש קשר קודם של הצוות עם המספר הזה.'));
      const problem = status();
      const b = button('בדקתי מי הפונה · הצגת הקשר הקודם', async function () {
        b.disabled = true;
        try { const next = await request(Object.assign({}, query, {verified:true})); if (box.isConnected) showHistory(box, next, query); }
        catch (err) { problem.textContent = err.message || reasons.unavailable; b.disabled = false; }
      }); box.append(b, problem);
    } else {
      const copy = { unidentified:'חסר מספר מלא לזיהוי.', review:'המספר דורש בירור ידני. יש לאמת עם הפונה לאיזה כרטיס שייכת הפנייה.',
        none:'לא נמצא כרטיס פנייה מזוהה למספר הזה.', no_history:'נמצא כרטיס מתאים. עדיין אין בו קשר קודם מתועד.' };
      box.append(el('p', copy[record.match] || reasons.unavailable));
    }
  }
  function lookup() {
    const box = startDialog('בדיקת מספר פונה'), phone = input('tel'), result = el('div'), notice = status(); phone.required = true; phone.dir = 'ltr';
    const f = actionForm('בדיקת קשר קודם', async function () {
      result.replaceChildren(); const query = { op:'lookup', phone:phone.value }, data = await request(query);
      if (phone.value === query.phone && box.isConnected) showHistory(result, data, query);
    }, notice);
    phone.oninput = function () { result.replaceChildren(); notice.textContent = ''; };
    f.form.append(field('מספר הטלפון של הפונה', phone), f.submit, notice);
    box.append(f.form, result); phone.focus();
  }
  function remember(id) {
    seen.add(id); if (seen.size > 200) seen.delete(seen.values().next().value);
    try { win.sessionStorage.setItem('desk-signals-' + user, JSON.stringify(Array.from(seen))); } catch (_) { /* optional */ }
  }
  async function poll() {
    if (!user || polling || doc.hidden) return;
    const current = generation;
    polling = true;
    try {
      const data = await request({op:'signals'});
      for (const id of data.ids || []) {
        if (current !== generation || doc.hidden) break;
        if (seen.has(id)) continue;
        const query = {op:'lookup', eventId:id};
        const record = await request(query);
        if (current !== generation || doc.hidden) break;
        remember(id);
        if (!['history','verify','number_verify'].includes(record.match)) continue;
        const alert = el('article'); alert.className = 'desk-alert';
        const box = el('div'); showHistory(box, record, query);
        alert.append(box, button('סגירת ההתראה', function () { alert.remove(); }));
        doc.querySelector('[data-desk-alerts]').prepend(alert);
      }
    } catch (_) { /* A failed refresh is retried while this staff desk is open. */ }
    finally { polling = false; }
  }
  function familyLink() {
    return 'https://wa.me/972505225529?text=' + encodeURIComponent('שלום לצוות המשפחות של איזון, אשמח שתחזרו אליי.');
  }
  async function families() {
    const box = startDialog('פניות משפחות'), notice = status();
    const bar = el('div'); bar.className = 'desk-actions';
    bar.append(button('רישום פנייה מהמשפחה', createFamily, true), button('רענון', families),
      button('העתקת קישור פרטי לפנייה', async function () {
        const link = familyLink();
        try { await win.navigator.clipboard.writeText(link); notice.textContent = 'קישור לפנייה אישית בוואטסאפ הועתק.'; }
        catch (_) { const field = input('text'); field.readOnly = true; field.dir = 'ltr'; field.value = link; field.setAttribute('aria-label','קישור לפניות משפחות'); notice.replaceChildren(field); field.select(); }
      }));
    box.append(bar, notice); notice.textContent = 'טוען את הפניות…';
    try {
      const data = await request({op:'families'}); if (!box.isConnected) return;
      const active = data.requests.filter(r => r.state === 'new' || r.state === 'routed')
        .sort((a,b) => a.dueDate.localeCompare(b.dueDate) || a.createdAt.localeCompare(b.createdAt));
      const closed = data.requests.filter(r => !['new','routed'].includes(r.state)).sort((a,b)=>b.closedAt.localeCompare(a.closedAt));
      notice.textContent = active.length ? 'פניות פתוחות · ' + active.length : 'אין פניות משפחות פתוחות.';
      function row(r) {
        const a = el('article'); a.className = 'desk-case';
        a.append(el('h3', kinds[r.kind]), el('small', 'התקבלה ' + context.when(r.createdAt) + ' · ' + r.id.slice(-8)),
          el('p', [r.phone, channels[r.channel], states[r.state]].join(' · ')),
          el('p', 'אחריות · ' + owners[r.owner] + ' | חזרה עד ' + context.when(r.dueDate)));
        if (r.routedAt) a.append(el('small', 'העברה לצוות · ' + context.houseName(r.house) + ' · ' + owners[r.routedBy] + ' · ' + context.when(r.routedAt)));
        if (r.closedAt) a.append(el('small', 'סגירה · ' + owners[r.closedBy] + ' · ' + context.when(r.closedAt)));
        if (r.state === 'new' || r.state === 'routed') a.append(button('טיפול בפנייה', function () { updateFamily(r); }));
        return a;
      }
      active.forEach(r => box.append(row(r)));
      if (closed.length) { const past = el('details'); past.append(el('summary','פניות שטופלו · ' + closed.length)); closed.forEach(r => past.append(row(r))); box.append(past); }
    } catch (err) { notice.textContent = err.message || reasons.unavailable; }
  }
  function createFamily() {
    const box = startDialog('רישום פנייה מהמשפחה'), notice = status(), phone = input('tel'), due = input('date'), key = context.newId();
    const kind = select(kinds,'בחירת בקשה'), channel = select(channels), owner = select(owners,'בחירת אחראי/ת');
    owner.value = Object.keys(owners).find(k => owners[k] === user) || '';
    [phone,due,kind,owner].forEach(i => { i.required = true; }); phone.dir = 'ltr';
    const f = actionForm('שמירת הפנייה', async function () {
      await request({op:'create',requestId:key,phone:phone.value,kind:kind.value,channel:channel.value,owner:owner.value,dueDate:due.value});
      if (box.isConnected) await families();
    }, notice);
    box.append(el('p','תוכן המסר נשאר בהתכתבות הפרטית או מועבר ישירות לצוות הבית. כאן עוקבים אחרי הבקשה והמענה.'));
    f.form.append(field('סוג הפנייה',kind),field('ערוץ',channel),field('מספר לחזרה',phone),field('אחראי/ת לחזרה',owner),field('מועד לחזרה',due),f.submit,notice);
    box.append(f.form);
  }
  async function updateFamily(r) {
    const box = startDialog(kinds[r.kind]), notice = status();
    const targets = select({},'בחירת מטופל/ת ובית'), choice = select({},'בחירת פעולה');
    choice.add(new win.Option(r.state === 'routed' ? 'עדכון העברה לאחר מעבר בית' : 'תיעוד העברה לצוות הבית','routed'));
    if (r.state === 'routed') choice.add(new win.Option(r.kind === 'message' ? states.delivered : states.answered, r.kind === 'message' ? 'delivered' : 'answered'));
    choice.add(new win.Option('סגירה ללא מסירת מידע','closed'));
    const targetLabel = field('יעד להעברה',targets), verified = check('בדקתי כעת את זהות הפונה ואת ההרשאה התקפה למסירת המידע המבוקש');
    const confirmation = check('אני מאשרת שביצעתי את הפעולה'), tick = confirmation.querySelector('input'), auth = verified.querySelector('input');
    choice.required = true;
    choice.onchange = function () {
      targetLabel.hidden = choice.value !== 'routed'; targets.required = !targetLabel.hidden;
      verified.hidden = choice.value !== 'answered'; auth.required = !verified.hidden; auth.checked = tick.checked = false;
      tick.required = true; const label = confirmation.lastChild;
      label.textContent = ({routed:'אימתתי את היעד והעברתי את הפנייה לצוות הבית',delivered:'הצוות אישר שהמסר נמסר למטופל/ת',
        answered:'המענה נמסר לפונה המורשה',closed:'יש לסגור את הפנייה ללא מסירת מידע'})[choice.value] || 'אני מאשרת שביצעתי את הפעולה';
    };
    choice.onchange(); targets.onchange = function () { tick.checked = false; };
    const f = actionForm('שמירת העדכון', async function () {
      const selected = targets.options[targets.selectedIndex];
      await request({op:'advance',requestId:r.id,revision:r.revision,to:choice.value,confirmed:tick.checked,permissionVerified:auth.checked,
        patientId:targets.value,house:selected && selected.dataset.house});
      if (box.isConnected) await families();
    }, notice);
    f.form.append(field('פעולה',choice),targetLabel,verified,confirmation,f.submit,notice);
    box.append(el('p', [r.phone,states[r.state],owners[r.owner]].join(' · ')),f.form,button('חזרה לפניות המשפחות',families));
    try {
      const data = await request({op:'residents'}); if (!box.isConnected) return;
      data.residents.filter(p=>!r.patientId || r.patientId===p.id).forEach(function (p) {
        const o = new win.Option(p.name + ' · ' + context.houseName(p.house),p.id); o.dataset.house = p.house; targets.add(o);
      });
    } catch (err) { notice.textContent = err.message || reasons.unavailable; }
  }
  function mount(options) {
    const tools = doc.getElementById('crm-intake-tools'); if (!tools) return;
    const nextUser = options.me.contactDesk ? options.me.user : '';
    context = options; tools.hidden = !nextUser;
    if (user === nextUser) return;
    user = nextUser; generation++; seen = new Set();
    if (timer) win.clearInterval(timer);
    if (dialog) dialog.close();
    tools.querySelector('[data-desk-alerts]').replaceChildren();
    if (!user) return;
    try { const ids = JSON.parse(win.sessionStorage.getItem('desk-signals-' + user) || '[]'); if (Array.isArray(ids)) seen = new Set(ids); } catch (_) { /* optional */ }
    tools.querySelector('[data-desk-lookup]').onclick = lookup; tools.querySelector('[data-desk-families]').onclick = families;
    doc.addEventListener('visibilitychange', poll); win.addEventListener('focus', poll);
    timer = win.setInterval(poll,15000); poll();
  }
  win.IntakeDesk = { mount:mount };
})(window, document);
