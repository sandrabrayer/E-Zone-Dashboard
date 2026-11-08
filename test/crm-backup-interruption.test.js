'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadGs, richSheet } = require('./helpers/gs-sandbox');
const { backupWorkbook, installBackupServices } = require('./helpers/backup-sandbox');
const name = 'dashboard-tasks-2026-11-03';
const original = [['id','note'],['kept','old backup']];
function fixture() {
  const g = loadGs(), backup = backupWorkbook(), held = installBackupServices(g, backup);
  const old = backup.insertSheet(name); old.getRange(1,1,2,2).setValues(original);
  return { g, backup, held, old };
}
for (const fault of ['write','afterWrite','corrupt','formula','publish']) {
  test('backup interruption: ' + fault + ' preserves the previous good snapshot', () => {
    const f = fixture(); f.backup.faults[fault] = true;
    assert.throws(() => f.g.sandbox.integrityWriteSnapshot_(f.backup, name, [['id','note'],['new','replacement']]));
    assert.equal(f.backup.getSheetByName(name), f.old);
    assert.deepEqual(f.old.grid, original);
    assert.equal(f.held(), false);
  });
}
test('backup snapshot preserves formula-like text, apostrophe, leading zero, boolean, number and Date', () => {
  const f = fixture();
  const grid = [['id','text','quote','phone','flag','amount','instant'],
    ['typed','=1+1',"'literal",'000123',true,123.45,new Date('2026-11-03T01:02:03.000Z')]];
  f.g.sandbox.integrityWriteSnapshot_(f.backup, name, grid);
  assert.deepEqual(f.backup.getSheetByName(name).grid, grid);
  assert.equal(f.held(), false);
});
test('backup busy lock and foreign app names refuse without touching either snapshot', () => {
  const f = fixture(), before = f.backup.events.length;
  f.backup.faults.lock = true;
  assert.throws(() => f.g.sandbox.integrityWriteSnapshot_(f.backup, name, original));
  f.backup.faults.lock = false;
  assert.throws(() => f.g.sandbox.integrityWriteSnapshot_(f.backup, 'outpatient-2026-11-03', original));
  assert.equal(f.backup.events.length, before);
});
test('backup cleanup failure retains the new verified copy and old recovery remnant', () => {
  const f = fixture(); f.backup.faults.cleanup = true;
  assert.throws(() => f.g.sandbox.integrityWriteSnapshot_(f.backup, name, [['id'],['new']]));
  assert.deepEqual(f.backup.getSheetByName(name).grid, [['id'],['new']]);
  assert.deepEqual(f.backup.getSheets().find(sh => sh.getName().startsWith('dashboard-previous-')).grid, original);
});
for (const failed of ['Tasks', 'Activity', 'Patients', 'Leads']) {
  test('nightly backup: ' + failed + ' read failure cannot publish partial snapshots or expire previous backup', () => {
    const g = loadGs({ props: { INTEGRITY_BACKUP_SSID: 'synthetic-backup' } }), backup = backupWorkbook();
    installBackupServices(g, backup);
    for (const [tab, cols] of [['Patients','PATIENT_COLUMNS'],['Leads','LEAD_COLUMNS'],['Tasks','TASK_COLUMNS'],['Activity','ACTIVITY_COLUMNS']]) {
      const sh = richSheet(tab, Array.from(g.run(cols))); sh.getDataRange = () => sh.getRange(1,1,sh.getLastRow(),sh.getLastColumn());
      if (tab === failed) sh.getDataRange = () => { throw Error('synthetic read refusal'); };
      g.sandbox.__sheets[tab] = sh;
    }
    backup.insertSheet('dashboard-tasks-2020-01-01').getRange(1,1,2,2).setValues(original);
    const before = backup.events.length;
    g.sandbox.nightlyIntegrityJob();
    assert.equal(backup.events.length, before, 'no backup publication or retention after failed source read');
    assert.ok(g.logs.some(l => l.includes('synthetic read refusal')));
  });
}

for (const missing of [null, 'Tasks']) {
  test('nightly retention: ' + (missing ? 'missing source preserves old proof' : 'complete verified capture expires only dated Dashboard tabs'), () => {
    const g = loadGs({ props: { INTEGRITY_BACKUP_SSID: 'synthetic-backup' } }), backup = backupWorkbook();
    installBackupServices(g, backup);
    for (const [tab, cols] of [['Patients','PATIENT_COLUMNS'],['Leads','LEAD_COLUMNS'],['Tasks','TASK_COLUMNS'],['Activity','ACTIVITY_COLUMNS']]) {
      if (tab === missing) continue;
      const sh = richSheet(tab, Array.from(g.run(cols)));
      sh.getDataRange = () => sh.getRange(1,1,sh.getLastRow(),sh.getLastColumn());
      g.sandbox.__sheets[tab] = sh;
    }
    const protectedNames = ['dashboard-pending-old', 'dashboard-previous-old', 'outpatient-2020-01-01', 'manual-notes'];
    for (const tab of ['dashboard-tasks-2020-01-01', ...protectedNames]) backup.insertSheet(tab).getRange(1,1,2,2).setValues(original);
    g.sandbox.nightlyIntegrityJob();
    assert.equal(!!backup.getSheetByName('dashboard-tasks-2020-01-01'), !!missing);
    for (const tab of protectedNames) assert.deepEqual(backup.getSheetByName(tab).grid, original);
    assert.ok(backup.events.some(e => e[0] === 'rename' && /^dashboard-patients-/.test(e[2])), 'successful capture is actually published');
  });
}
