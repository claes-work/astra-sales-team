import { contentHash } from '../outreach/profiles.mjs';
import { identity } from '../outreach/experiment.mjs';
import { pipelineReport } from './ledger.mjs';
import { dateKey, dayKey, intervalDays } from './time.mjs';

const parse=value=>JSON.parse(value||'{}');
const unique=values=>[...new Set(values)];
const sourceDays=(runs,now)=>unique(runs.flatMap(r=>intervalDays(r.started_at,r.finished_at??now))).sort();

export function reportingAssignments(runs,now) {
  const claimed=new Set();
  return runs.filter(r=>r.kind==='reporting_assignment'&&r.status==='completed'&&Date.parse(r.finished_at)<=now.getTime()).map(row=>{
    const context=parse(row.context_json),a=context.assignment;
    if(!a||a.schemaVersion!==1||!Array.isArray(a.primaryRunIds)||!a.primaryRunIds.length||!Array.isArray(a.supplementalRunIds)
      ||!a.reason?.trim()||!context.source?.trim())throw new Error('Ungültige Reporting-Zuordnung.');
    dateKey(a.targetDay);
    const ids=[...a.primaryRunIds,...a.supplementalRunIds];
    if(unique(ids).length!==ids.length)throw new Error('Lauf doppelt zugeordnet.');
    const selected=ids.map(id=>runs.find(r=>r.$id===id));
    for(const r of selected){
      if(!r||r.client_id!==row.client_id||r.kind==='reporting_assignment'||r.status!=='completed'||Date.parse(r.finished_at)>now.getTime()||claimed.has(r.$id))throw new Error('Reporting-Referenz fehlt, ist fremd, offen oder schon zugeordnet.');
      claimed.add(r.$id);
    }
    return {...a,id:row.$id,clientId:row.client_id,source:context.source,sourceRunIds:ids,originalDays:sourceDays(selected,now)};
  });
}

// One append-only metadata row; historical runs, steps and mail records stay
// byte-for-byte unchanged. Repeating the same migration is a read-only no-op.
export async function assignReportingDay({repo,clientId,key,targetDay,primaryRunIds,supplementalRunIds=[],reason,source,now=new Date()}) {
  const assignment={schemaVersion:1,targetDay,primaryRunIds,supplementalRunIds,reason};
  const context={capture:'reported',source,assignment};
  const id=identity('plr',clientId,key),existing=await repo.get('pipeline_runs',id);
  if(existing){
    if(existing.kind!=='reporting_assignment'||existing.client_id!==clientId||contentHash(parse(existing.context_json))!==contentHash(context))throw new Error('Zuordnungskennung bereits anders belegt.');
    return {id,inserted:false};
  }
  if(!await repo.get('clients',clientId))throw new Error('Auftraggeber fehlt.');
  const at=now.toISOString(),row={$id:id,client_id:clientId,run_key:key,kind:'reporting_assignment',status:'completed',started_at:at,finished_at:at,context_json:JSON.stringify(context)};
  reportingAssignments([...(await repo.list('pipeline_runs')),row],now);
  const {$id,...data}=row;
  await repo.create('pipeline_runs',id,data);
  return {id,inserted:true};
}

export function pipelineProjection(d,day,now) {
  const assignments=reportingAssignments(d.pipeline_runs,now);
  const supplementalIds=new Set(assignments.flatMap(a=>a.supplementalRunIds));
  const reportingDayByRun=Object.fromEntries(assignments.flatMap(a=>a.primaryRunIds.map(id=>[id,a.targetDay])));
  const mainRuns=d.pipeline_runs.filter(r=>r.kind!=='reporting_assignment'&&!supplementalIds.has(r.$id));
  const pipeline=pipelineReport({runs:mainRuns,steps:d.pipeline_steps,day,now,reportingDayByRun});
  const here=assignments.filter(a=>a.targetDay===day);
  const supplementalRuns=here.flatMap(a=>a.supplementalRunIds.map(id=>{
    const run=d.pipeline_runs.find(r=>r.$id===id);
    const report=pipelineReport({runs:[run],steps:d.pipeline_steps,day,now,reportingDayByRun:{[id]:day}});
    return {...report.runs[0],checkedCandidates:report.checkedCandidates,qualifiedCandidates:report.decisions.qualified};
  }));
  const moved=assignments.filter(a=>a.targetDay!==day&&a.originalDays.includes(day));
  return {pipeline,reporting:{assignments:here,supplementalRuns,reassignedTo:unique(moved.map(a=>a.targetDay)),
    note:here.length?'Recherche dem gemeinsamen Arbeitstag zugeordnet; Originalzeitpunkte bleiben erhalten. Technische Wiederholungen stehen separat und erhöhen die Firmenzahlen nicht.':'Ohne Zuordnung gelten die ursprünglichen Recherche- und Ereignistage.',
    ...(moved.length?{originalPipeline:pipelineReport({runs:d.pipeline_runs,steps:d.pipeline_steps,day,now})}:{})},mainRuns,reportingDayByRun};
}

export function candidateFunnel(pipeline,companies) {
  const rows=new Map();
  const companyFor=(client,key,explicit)=>{
    if(explicit)return companies.find(c=>c.client_id===client&&c.$id===explicit)??null;
    const matches=companies.filter(c=>c.client_id===client&&c.domain?.toLowerCase().replace(/^www\./,'')===key.toLowerCase().replace(/^www\./,''));
    return matches.length===1?matches[0]:null;
  };
  const refs=new Map(pipeline.steps.filter(s=>s.details.companyId).map(s=>[`${s.client_id}:${s.candidate_key}`,s.details.companyId]));
  const candidate=(s,key)=>{
    const company=companyFor(s.client_id,key,refs.get(`${s.client_id}:${key}`));
    const id=`${s.client_id}:${company?company.$id:key}`;
    if(!rows.has(id))rows.set(id,{id,companyId:company?.$id??null,companyName:company?.name??key,candidateKeys:[],origin:company?'existing':'unknown',outcome:null,runIds:[],decidedAt:null});
    const row=rows.get(id);row.candidateKeys=unique([...row.candidateKeys,key]);row.runIds=unique([...row.runIds,s.run_id]);return row;
  };
  for(const s of pipeline.steps.filter(s=>s.phase==='search'&&s.status==='completed'))for(const key of s.details.candidateKeys??[])candidate(s,key).origin='discovered';
  for(const s of pipeline.steps.filter(s=>s.phase==='qualification'&&s.status==='completed').sort((a,b)=>Date.parse(a.finished_at)-Date.parse(b.finished_at)||a.id.localeCompare(b.id))){
    const row=candidate(s,s.candidate_key);row.outcome=s.details.outcome;row.decidedAt=s.finished_at;
  }
  const candidates=[...rows.values()].sort((a,b)=>a.companyName.localeCompare(b.companyName,'de'));
  return {candidates,note:'Identität über belegte Firmenreferenz oder eindeutige vorhandene Firmendomain; andere Quellenkennungen bleiben getrennt. Pro Identität zählt die jüngste abgeschlossene Entscheidung im zugeordneten Recherchebestand.',
    considered:candidates.length,discovered:candidates.filter(c=>c.origin==='discovered').length,carried:candidates.filter(c=>c.origin==='existing').length,
    checked:candidates.filter(c=>c.outcome).length,qualified:candidates.filter(c=>c.outcome==='qualified').length};
}
