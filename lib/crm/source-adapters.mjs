// CRM-02 v0.2: offline adapters only. No HTTP, credentials, storage or app writes.
// Access and source metadata are TRUSTED CALLER inputs in a future server;
// the accompanying tests supply synthetic stand-ins, not production authority.
import { isDate } from './date.mjs';

export const DATASET_IDS = Object.freeze([
  'dashboard.leads', 'outpatient.leads', 'outpatient.continuation',
]);
const D_STAGE = new Map([
  ...['new','ליד חדש','חדש','ליד'].map(x=>[x,'active']),
  ...['visit','ביקור נקבע','ביקור','נקבע ביקור','paid','מקדמה שולמה','בטיפול פעיל','מקדמה','שילם מקדמה','waitlist','רשימת המתנה','רשימת_המתנה'].map(x=>[x,'active']),
  ...['admitted','נקלט','אושפז','irrelevant','לא רלוונטי','לא_רלוונטי'].map(x=>[x,'resolved']),
]);
const O_STAGE = new Map([
  ...['פרטים אישיים','שיחת היכרות','תוכנית טיפול','הסכם נחתם'].map(x=>[x,'active']),
  ['לא רלוונטי','resolved'],
]);
const D_OUTCOME = new Set(['not_relevant','thinking','entered','postponed','cancelled']);
const D_REPORT = new Set(['advancing','undecided','not_fit','no_show']);
const C_OUTCOME = new Set(['','continuing','to_outpatient','stopping']);
const str = x => typeof x === 'string' ? x.trim() : '';
const own = (o,k) => Object.hasOwn(o,k);
const stamp = x => typeof x === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(x) && isDate(x.slice(0,10)) && +x.slice(11,13)<24 && +x.slice(14,16)<60 && +x.slice(17,19)<60 && Number.isFinite(Date.parse(x)) ? x : null;
function dateValue(x) {
  if (x == null || x === '') return null;
  return isDate(x) ? x : 'invalid';
}
// introDateTime is a datetime-local in the current outpatient UI. Zoned
// timestamps, if supplied by an approved future transport, use Jerusalem.
export function introDate(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') return 'invalid';
  const local = value.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (local) return isDate(local[1]) && +local[2]<24 && +local[3]<60 && +(local[4]||0)<60 ? local[1] : 'invalid';
  if (!stamp(value)) return 'invalid';
  const parts = new Intl.DateTimeFormat('en-US',{timeZone:'Asia/Jerusalem',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(value));
  const p=Object.fromEntries(parts.map(x=>[x.type,x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}
function grantFor(dataset, access) {
  if (access?.dataset !== dataset || !Array.isArray(access.allowedIds)) return null;
  return { ...access, ids:new Set(access.allowedIds.filter(x=>str(x))) };
}
function envelope(dataset, input, now, diagnostics) {
  const observedAt=stamp(input?.observedAt), checkedAt=stamp(now);
  let health=['fresh','stale','partial','unavailable'].includes(input?.health) ? input.health : 'unavailable';
  if (!observedAt || !checkedAt || Date.parse(observedAt)>Date.parse(checkedAt)) {
    health='unavailable'; diagnostics.add('invalid_observation_time');
  }
  if (!Array.isArray(input?.rows)) {health='unavailable';diagnostics.add('invalid_source_shape');}
  return { dataset,health,complete:health!=='unavailable' && input?.complete===true,
    observedAt:health==='unavailable'?null:observedAt,records:[] };
}
function finish(e,diagnostics) {
  if (diagnostics.size && e.health!=='unavailable') {
    if(e.health==='fresh')e.health='partial';
    e.complete=false;
  }
  return {envelope:e,diagnostics:[...diagnostics].sort()};
}
function denied() {return {envelope:null,diagnostics:[]};}
function visible(input,grant,idField,required,diagnostics) {
  const result=new Map(), duplicates=new Set();
  for (const row of input.rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    const id=str(row[idField]);
    if (!id || !grant.ids.has(id)) continue;
    if(result.has(id))duplicates.add(id);
    // Keep the ID in the map while validating so a malformed duplicate also
    // quarantines its valid twin instead of letting array order decide.
    result.set(id,row);
  }
  for (const id of duplicates)result.delete(id);
  if(duplicates.size)diagnostics.add('duplicate_authorized_id');
  for(const [id,row] of result) {
    if(required.some(k=>!own(row,k)||typeof row[k]!=='string')) {
      result.delete(id);diagnostics.add('missing_or_invalid_required_field');
    }
  }
  return result;
}
function candidate(row,id,grant,extra) {
  return {nativeRecordId:id,identityKind:'row',
    displayName:grant.showName===true?str(row.name)||null:null,
    assignee:grant.showAssignee===true?str(row.assignedTo)||null:null,
    dueBasis:'unknown',originalDueDate:null,nextActionDate:null,eventDate:null,
    sourceUpdatedAt:stamp(row.updatedAt),...extra};
}

export function adaptLeads({dataset,input,access,now,today}) {
  if(!['dashboard.leads','outpatient.leads'].includes(dataset))throw Error('unsupported_leads_dataset');
  const grant=grantFor(dataset,access);
  if(!grant || !grant.ids.size)return denied();
  if(!isDate(today))throw Error('today_must_be_Jerusalem_calendar_date');
  const diagnostics=new Set(),e=envelope(dataset,input,now,diagnostics);
  if(e.health==='unavailable')return finish(e,diagnostics);
  const dashboard=dataset==='dashboard.leads', stages=dashboard?D_STAGE:O_STAGE;
  for(const [id,row] of visible(input,grant,'id',['stage'],diagnostics)) {
    const raw=str(row.stage),known=stages.has(raw);
    // Do not echo an arbitrary unknown/free-text stage into the CRM output.
    const status=known?raw:'unrecognized';
    const eventDate=dashboard?dateValue(row.visitDate):introDate(row.introDateTime);
    e.records.push(candidate(row,id,grant,{reason:'lead_followup',state:stages.get(raw)||'unknown',sourceStatus:status,eventDate,
      // Dashboard Leads has no general updatedAt column at this source SHA.
      sourceUpdatedAt:dashboard?null:stamp(row.updatedAt)}));
    if(!dashboard)continue;
    // Two distinct source result vocabularies. One alone cannot prove that
    // both reporting tracks are complete. An admission closes the lead task,
    // never silently the meeting task or a destination-transfer task.
    const outcome=str(row.meetingOutcome),report=str(row.meetingReportOutcome);
    const both=D_OUTCOME.has(outcome)&&D_REPORT.has(report);
    const past=isDate(eventDate)&&eventDate<today;
    if(past || eventDate==='invalid' || outcome || report) {
      const unknown=(outcome&&!D_OUTCOME.has(outcome))||(report&&!D_REPORT.has(report))||eventDate==='invalid';
      e.records.push(candidate(row,id,grant,{reason:'meeting_result',state:unknown?'unknown':both?'resolved':'active',
        sourceStatus:unknown?'unrecognized':both?'both_results_recorded':'result_not_fully_recorded',
        eventDate,sourceUpdatedAt:null}));
    }
  }
  return finish(e,diagnostics);
}

// This reproduces ONLY the existing source lookup key, never a person ID or
// cross-app identity match. No fuzzy join, phone join or delimiter guessing.
export function continuationKey(row) {
  const values=[row?.name,row?.house,row?.entryDate];
  if(values.some(x=>typeof x!=='string') || !str(values[0]) || !str(values[1]))return null;
  if(values.some(x=>x.includes('|')))return null;
  return values.map(str).join('|');
}

export function adaptContinuation({workflow,roster,access,now}) {
  const dataset='outpatient.continuation',grant=grantFor(dataset,access);
  if(!grant || !grant.ids.size)return denied();
  const diagnostics=new Set(),e=envelope(dataset,workflow,now,diagnostics);
  const rosterDiagnostics=new Set(),r=envelope(dataset,roster,now,rosterDiagnostics);
  // A failed workflow load is not equivalent to all outcomes being blank.
  if(e.health==='unavailable')return finish(e,diagnostics);
  const states=visible(workflow,grant,'key',['outcome'],diagnostics);
  const availableRoster=r.health!=='unavailable';
  const rosterRows=availableRoster?roster.rows:[];
  const patients=new Map(),duplicates=new Set();
  for(const row of rosterRows) {
    const key=continuationKey(row);
    if(!key || !grant.ids.has(key))continue;
    if(patients.has(key))duplicates.add(key);
    patients.set(key,row);
  }
  for(const key of duplicates){patients.delete(key);states.delete(key);}
  if(duplicates.size)diagnostics.add('duplicate_authorized_roster_key');
  // Quarantined or malformed saved state MUST NOT be replaced by an invented
  // blank state from the roster. If state validation failed, omit all new
  // roster-only candidates; known valid workflow rows can still be shown.
  const mayInferBlank=e.health==='fresh'&&e.complete&&!diagnostics.size;
  if(!availableRoster){diagnostics.add('roster_unavailable');e.complete=false;}
  else {
    e.complete=e.complete&&r.complete;
    if(e.health==='fresh'&&r.health!=='fresh')e.health=r.health;
    if(Date.parse(r.observedAt)<Date.parse(e.observedAt))e.observedAt=r.observedAt;
  }
  for(const key of new Set([...patients.keys(),...states.keys()])) {
    const state=states.get(key),patient=patients.get(key);
    if(!state&&!mayInferBlank)continue;
    const row=state||{...patient,outcome:''};
    const outcome=str(row.outcome),valid=C_OUTCOME.has(outcome);
    const base={identityKind:'composite',eventDate:dateValue(row.meetingDate),
      sourceStatus:valid?outcome:'unrecognized',assignee:null};
    e.records.push(candidate(row,key,grant,{...base,reason:'continuation_decision',
      state:!valid?'unknown':outcome===''?'active':'resolved'}));
    if(outcome==='to_outpatient') {
      e.records.push(candidate(row,key,grant,{...base,reason:'destination_link_review',state:'active'}));
    }
    // continuing/stopping NEVER emit a resolved destination_link_review.
    // If such a task existed before, assemble() retains it for review.
  }
  return finish(e,diagnostics);
}
