/* FIN-01.3 reminder delivery — OFF until separately approved/configured.
 * Editor/trigger only; never reachable through handle_. No sheet writes.
 * MailApp has no idempotency key: persist ATTEMPTING before invoking it. A
 * thrown send or failed success-record is UNCERTAIN, never auto-retried that
 * day. SENT means MailApp returned, not proof of inbox delivery. */
function billingReminderProperties_() {
  const props = PropertiesService.getScriptProperties(), values = {};
  ['BILLING_REMINDER_ENABLED', 'BILLING_REMINDER_REPLACES_DIGEST', 'BILLING_REMINDER_HOUR',
    'BILLING_REMINDER_POLICY', 'BILLING_REMINDER_MIN_DAYS', 'BILLING_ALERT_EMAIL_VERED',
    'BILLING_ALERT_EMAIL_ORTAL'].forEach(function (key) { values[key] = props.getProperty(key); });
  return { props: props, values: values };
}

function billingReminderClock_(now) {
  return { day: Utilities.formatDate(now, 'Asia/Jerusalem', 'yyyy-MM-dd'),
    hour: Number(Utilities.formatDate(now, 'Asia/Jerusalem', 'HH')) };
}

function billingReminderRun_(nowArg, previewOnly) {
  const now = nowArg instanceof Date ? nowArg : new Date();
  const state = billingReminderProperties_();
  if (!previewOnly && state.values.BILLING_REMINDER_ENABLED !== 'true') return { ok: true, sent: 0, skipped: 'disabled' };
  let parsed = BillingReminderCore.configFromProperties(state.values);
  if (!parsed.ok) return { ok: false, sent: 0, error: parsed.error };
  const clock = billingReminderClock_(now);
  if (!previewOnly && clock.hour !== parsed.config.hour) return { ok: true, sent: 0, skipped: 'outside_hour' };
  if (previewOnly) { parsed.config.enabled = true; clock.hour = parsed.config.hour; }
  const lock = previewOnly ? null : LockService.getScriptLock();
  if (lock && lock.tryLock(5000) !== true) return { ok: false, sent: 0, error: 'lock_busy' };
  try {
    // Recheck the complete configuration under the lock, including recipients.
    if (!previewOnly) {
      const fresh = billingReminderProperties_();
      if (fresh.values.BILLING_REMINDER_ENABLED !== 'true') return { ok: true, sent: 0, skipped: 'disabled' };
      parsed = BillingReminderCore.configFromProperties(fresh.values);
      if (!parsed.ok) return { ok: false, sent: 0, error: parsed.error };
      if (clock.hour !== parsed.config.hour) return { ok: true, sent: 0, skipped: 'outside_hour' };
    }
    // CRM Stage 4a (spec §9): Vered's follow-ups ride the same mail as aggregate counts (reminderExtras_ in Code.gs).
    const extras = typeof reminderExtras_ === 'function' ? reminderExtras_(clock.day) : null;
    const plan = BillingReminderCore.plan(billingControlQueue_({ approver: false }), parsed.config, clock, extras);
    if (!plan.ok) return { ok: false, sent: 0, error: plan.error };
    if (previewOnly) return { ok: true, sent: 0, previewOnly: true, skipped: plan.skipped, messages: plan.messages };
    const results = [];
    for (const message of plan.messages) {
      const key = 'BILLING_REMINDER_STATE_' + message.owner.toUpperCase();
      let prior;
      const raw = state.props.getProperty(key) || '';
      try { prior = raw ? JSON.parse(raw) : null; }
      catch (_) { results.push({ owner: message.owner, status: 'blocked_corrupt_state' }); continue; }
      if (raw && (!prior || typeof prior !== 'object' || Array.isArray(prior) ||
        BillingReminderCore.calendar.isBusinessDay(prior.day, message.owner) === null || !['attempting', 'sent', 'uncertain'].includes(prior.status))) {
        results.push({ owner: message.owner, status: 'blocked_corrupt_state' }); continue;
      }
      if (prior && prior.day > message.day) { results.push({ owner: message.owner, status: 'blocked_future_state' }); continue; }
      if (prior && prior.day === message.day) {
        results.push({ owner: message.owner, status: prior.status === 'sent' ? 'already_sent' : 'uncertain' }); continue;
      }
      if (MailApp.getRemainingDailyQuota() < 1) { results.push({ owner: message.owner, status: 'quota_exhausted' }); continue; }
      const attempt = { day: message.day, status: 'attempting', at: now.toISOString() };
      // A failed write aborts BEFORE sending. A failed commit after sending
      // leaves this durable marker, so neither trigger can duplicate it.
      try { state.props.setProperty(key, JSON.stringify(attempt)); }
      catch (_) { results.push({ owner: message.owner, status: 'state_write_failed' }); continue; }
      let status = 'sent';
      try { MailApp.sendEmail(Object.assign({ to: message.to }, message.mail)); }
      catch (_) { status = 'uncertain'; }
      attempt.status = status;
      try { state.props.setProperty(key, JSON.stringify(attempt)); }
      catch (_) { status = 'uncertain'; }
      results.push({ owner: message.owner, status: status });
    }
    const failed = results.some(r => !['sent', 'already_sent'].includes(r.status));
    // Only bounded outcome codes: never source data, raw provider errors or addresses.
    Logger.log('BILLING_REMINDER ' + JSON.stringify(results));
    return { ok: !failed, sent: results.filter(r => r.status === 'sent').length, results: results, skipped: plan.skipped };
  } catch (_) {
    return { ok: false, sent: 0, error: 'runtime_failed' };
  } finally { if (lock) lock.releaseLock(); }
}

function billingRemindersJob() {
  const result = billingReminderRun_();
  if (!result.ok) throw new Error('Billing reminder failed; inspect the bounded sender state.');
  return result;
}

// Preview does not write properties, acquire a lock, send or install triggers.
function previewBillingRemindersNow() { return billingReminderRun_(new Date(), true); }

// Installation is a separate, explicitly authorized editor operation. A new
// trigger is created before old ones are removed; daily state handles overlap.
function installBillingReminderTriggerNow() {
  const state = billingReminderProperties_();
  const parsed = BillingReminderCore.configFromProperties(state.values);
  if (!parsed.ok || !parsed.config.enabled) throw new Error('Reminder configuration is incomplete or disabled.');
  ScriptApp.requireAllScopes(ScriptApp.AuthMode.FULL);
  const created = ScriptApp.newTrigger('billingRemindersJob').timeBased().everyDays(1)
    .atHour(parsed.config.hour).inTimezone('Asia/Jerusalem').create();
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getUniqueId() !== created.getUniqueId() && ['billingRemindersJob', 'paymentsDigestJob'].includes(trigger.getHandlerFunction())) ScriptApp.deleteTrigger(trigger);
  });
  return { ok: true, hour: parsed.config.hour, timezone: 'Asia/Jerusalem' };
}
