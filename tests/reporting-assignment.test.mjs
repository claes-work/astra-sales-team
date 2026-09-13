import test from 'node:test';
import assert from 'node:assert/strict';
import {MemoryRepo} from './helpers/outreach-content.mjs';
import {DashboardData} from '../src/operations/dashboard.mjs';
import {pipelineReport} from '../src/operations/ledger.mjs';
import {assignReportingDay} from '../src/operations/reporting.mjs';

async function fixture(){
  const repo=new MemoryRepo(),now=new Date('2026-09-12T15:00:00Z');
  await repo.create('clients','own',{});
  for(const [id,domain] of [['new','new.example'],['old','old.example']])await repo.create('companies',id,{client_id:'own',name:id,domain});
  for(const [id,kind] of [['main','public_web_research'],['replay','qualification_replay']])await repo.create('pipeline_runs',id,{client_id:'own',run_key:id,kind,status:'completed',started_at:'2026-09-10T12:00:00Z',finished_at:'2026-09-10T12:10:00Z',context_json:'{}'});
  const step=async(id,run,phase,key,details)=>repo.create('pipeline_steps',id,{client_id:'own',run_id:run,phase,step_key:id,candidate_key:key,status:'completed',started_at:'2026-09-10T12:00:00Z',finished_at:'2026-09-10T12:05:00Z',details_json:JSON.stringify(details)});
  await step('search','main','search',null,{candidateKeys:['new.example','new.example']});
  await step('qn','main','qualification','new.example',{outcome:'qualified'});
  await step('qo','main','qualification','old.example',{outcome:'qualified',companyId:'old'});
  await step('qr','replay','qualification','input:old',{outcome:'qualified',companyId:'old'});
  const dashboard=new DashboardData({repo,now:()=>now,lock:fn=>fn()});
  const assignment={repo,clientId:'own',key:'group',targetDay:'2026-09-12',primaryRunIds:['main'],supplementalRunIds:['replay'],reason:'User assigned this pilot to the send day.',source:'local user source',now};
  return {repo,now,dashboard,assignment};
}

test('Reporting-Zuordnung ist idempotent, lässt Rohhistorie stehen und führt echten Funnel zusammen',async()=>{
  const f=await fixture(),oldRuns=await f.repo.list('pipeline_runs'),oldSteps=await f.repo.list('pipeline_steps');
  assert.equal((await assignReportingDay(f.assignment)).inserted,true);
  assert.equal((await assignReportingDay(f.assignment)).inserted,false);
  for(const r of oldRuns)assert.deepEqual(await f.repo.get('pipeline_runs',r.$id),r);
  assert.deepEqual(await f.repo.list('pipeline_steps'),oldSteps);
  const list=await f.dashboard.days();assert.deepEqual(list.items.map(r=>r.day),['2026-09-12']);
  const d=await f.dashboard.day('2026-09-12');
  assert.equal(d.counts.searchedCandidates,1);assert.equal(d.counts.carriedCandidates,1);assert.equal(d.counts.consideredCandidates,2);assert.equal(d.counts.qualifiedCandidates,2);
  assert.equal(d.counts.sentMessages,0);assert.equal(d.counts.acceptedMessages,0);
  assert.deepEqual(d.counts.pipelineOriginalDays,['2026-09-10']);
  assert.equal(d.pipeline.runs[0].startedAt,'2026-09-10T12:00:00Z');assert.equal(d.pipeline.elapsedWallClockMs,600000);
  assert.equal(d.reporting.supplementalRuns[0].checkedCandidates,1);
  const old=await f.dashboard.day('2026-09-10');assert.deepEqual(old.reporting.reassignedTo,['2026-09-12']);assert.equal(old.reporting.originalPipeline.checkedCandidates,3);
  const raw=pipelineReport({runs:await f.repo.list('pipeline_runs'),steps:oldSteps,day:'2026-09-10',now:f.now});
  assert.equal(raw.runs.length,2);assert.equal(raw.checkedCandidates,3);assert.equal(raw.decisions.qualified,3);
});

test('Reporting verschiebt keine Mailereignisse und verbirgt keine unabhängige Tätigkeit am alten Tag',async()=>{
  const f=await fixture();await assignReportingDay(f.assignment);
  await f.repo.create('outreach_messages','m',{client_id:'own',company_id:'old',subject:'Test',status:'sent'});
  await f.repo.create('outreach_attempts','a',{client_id:'own',message_id:'m',attempted_at:'2026-09-10T12:00:00Z',status:'accepted'});
  await f.repo.create('outreach_events','e',{client_id:'own',message_id:'m',event_type:'delivered',occurred_at:'2026-09-10T12:00:10Z'});
  const old=await f.dashboard.day('2026-09-10');assert.equal(old.counts.sentMessages,1);assert.equal(old.counts.sentTimeProxyMessages,1);
  assert.equal((await f.dashboard.day('2026-09-12')).counts.sentMessages,0);
  assert.deepEqual((await f.dashboard.days()).items.map(r=>r.day),['2026-09-12','2026-09-10']);
});

test('Zuordnung lehnt fremde, offene, doppelte und nachträglich veränderte Bezüge ab',async()=>{
  const f=await fixture();
  await assert.rejects(assignReportingDay({...f.assignment,primaryRunIds:['missing']}),/Referenz/);
  await f.repo.create('pipeline_runs','other',{client_id:'else',kind:'test',status:'completed',finished_at:f.now.toISOString()});
  await assert.rejects(assignReportingDay({...f.assignment,primaryRunIds:['other']}),/Referenz/);
  await assert.rejects(assignReportingDay({...f.assignment,supplementalRunIds:['main']}),/doppelt/);
  await assignReportingDay(f.assignment);
  await assert.rejects(assignReportingDay({...f.assignment,targetDay:'2026-09-13'}),/anders/);
  await assert.rejects(assignReportingDay({...f.assignment,key:'second'}),/zugeordnet/);
});

test('Eindeutige Firmenreferenz dedupliziert Alias; letzte Entscheidung und Auftraggeber bleiben getrennt',async()=>{
  const f=await fixture();
  let before=await f.dashboard.day('2026-09-10');assert.equal(before.counts.consideredCandidates,2);assert.equal(before.counts.qualifiedCandidates,2);
  await f.repo.create('pipeline_steps','later',{$id:'later',client_id:'own',run_id:'main',phase:'qualification',candidate_key:'new.example',status:'completed',started_at:'2026-09-10T12:06:00Z',finished_at:'2026-09-10T12:07:00Z',details_json:JSON.stringify({outcome:'excluded'})});
  before=await f.dashboard.day('2026-09-10');assert.equal(before.counts.qualifiedCandidates,1);assert.equal(before.funnel.candidates.find(c=>c.companyId==='new').outcome,'excluded');
});
