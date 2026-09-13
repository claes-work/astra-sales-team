import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import YAML from 'yaml';
import { MemoryRepo,contentFixture } from './helpers/outreach-content.mjs';
import { PipelineLedger } from '../src/operations/ledger.mjs';
import { DashboardData } from '../src/operations/dashboard.mjs';
import { dayKey,overlapMs,intervalDays } from '../src/operations/time.mjs';
import { assessRamp,validateRamp } from '../src/outreach/ramp.mjs';
import { runPipeline,buildEvidenceDossier } from '../src/pipeline.mjs';
import { loadProfile } from '../src/icp.mjs';
import {createApi} from '../src/outreach/http.mjs';
const pilot=YAML.parse(await readFile('outreach/ramp-pilot.yaml','utf8'));
const context={capture:'instrumented',source:'automated local test'};
async function ledgerFixture(){
  const repo=new MemoryRepo();await repo.create('clients','own',{});
  let now=new Date('2026-09-10T12:00:00Z');
  const ledger=new PipelineLedger({repo,now:()=>now,lock:work=>work()});
  const run=await ledger.start({clientId:'own',key:'test',kind:'test',startedAt:'2026-09-10T10:00:00Z',context});
  return{repo,ledger,run,now:()=>now,time:at=>now=new Date(at)};
}
test('Messledger dedupliziert Kandidaten und Replays, zählt Retry separat und addiert parallele Zeit',async()=>{
  const f=await ledgerFixture();const runId=f.run.$id;
  const search={runId,key:'s',phase:'search',startedAt:'2026-09-10T10:00:00Z',finishedAt:'2026-09-10T10:01:00Z',status:'completed',details:{candidateKeys:['source:a','source:a','source:b']}};
  await f.ledger.step(search);await f.ledger.step(search);
  const step={runId,key:'qfail',phase:'qualification',candidateKey:'source:a',startedAt:'2026-09-10T10:01:00Z',finishedAt:'2026-09-10T10:02:00Z',status:'failed',details:{errorCode:'timeout'}};
  await f.ledger.step(step);
  await f.ledger.step({...step,key:'qretry',startedAt:step.finishedAt,finishedAt:'2026-09-10T10:04:00Z',status:'completed',details:{retryOf:'qfail',outcome:'qualified',reason:'Evidence passes',tokens:120,costAmount:0.02,currency:'EUR',measurementSource:'fixture usage receipt'}});
  await f.ledger.step({...step,key:'qb',candidateKey:'source:b',finishedAt:'2026-09-10T10:04:00Z',status:'completed',details:{outcome:'excluded',reason:'Explicit exclusion'}});
  await f.ledger.finish({runId,status:'completed',finishedAt:'2026-09-10T10:04:00Z'});
  const report=await f.ledger.report({day:'2026-09-10'});
  assert.equal(report.searchAttempts,1);assert.equal(report.uniqueCandidatesFound,2);assert.equal(report.duplicateOccurrences,1);
  assert.equal(report.checkedCandidates,2);assert.equal(report.decisions.qualified,1);assert.equal(report.decisions.excluded,1);
  assert.equal(report.retryAttempts,1);assert.equal(report.failures,1);
  assert.equal(report.elapsedWallClockMs,4*60000);assert.equal(report.summedStepDurationMs,7*60000);
  assert.equal(report.tokens,null);assert.equal(report.knownTokensSubtotal,120);assert.deepEqual(report.costsByCurrency,{EUR:{knownSubtotal:0.02}});
  assert.equal(report.stepsWithUnknownCost,2);
  await assert.rejects(f.ledger.step({...search,details:{candidateKeys:[]}}),/unverändert/);
});
test('Ledger verhindert falsche Referenzen, erfundene Messwerte und Abschluss offener Schritte',async()=>{
  const f=await ledgerFixture();await f.repo.create('companies','other',{client_id:'different'});
  const base={runId:f.run.$id,key:'step',phase:'authoring',candidateKey:'source:a',startedAt:'2026-09-10T10:10:00Z'};
  await assert.rejects(f.ledger.step({...base,details:{companyId:'other'}}),/Auftraggeber/);
  await assert.rejects(f.ledger.step({...base,details:{costAmount:0,currency:'EUR'}}),/Erfassungsquelle/);
  await assert.rejects(f.ledger.step({...base,details:{tokens:-1,measurementSource:'test'}}),/nichtnegativ/);
  await f.ledger.step(base);
  await assert.rejects(f.ledger.finish({runId:f.run.$id,status:'completed'}),/offene/);
});
test('Berliner Sommer-/Wintertage dauern 23/25 Stunden; Zwischentage und unbekannte Historie werden ehrlich berichtet',async()=>{
  assert.equal(overlapMs('2026-03-28T23:00:00Z','2026-03-29T22:00:00Z','2026-03-29'),23*3600000);
  assert.equal(overlapMs('2026-10-24T22:00:00Z','2026-10-25T23:00:00Z','2026-10-25'),25*3600000);
  assert.deepEqual(intervalDays('2026-09-08T12:00:00Z','2026-09-10T12:00:00Z'),['2026-09-08','2026-09-09','2026-09-10']);
  const f=await ledgerFixture(),dashboard=new DashboardData({repo:f.repo,now:f.now,lock:work=>work()});
  const day=await dashboard.day('2026-09-09');assert.equal(day.counts.checkedCandidates,null);assert.equal(day.counts.searchedCandidates,null);assert.equal(day.variableCosts.complete,false);
});
test('Echte Pipeline instrumentiert vorhandene Evidenz, KI-/Kostenwerte bleiben unbekannt und neue externe Recherche wird nicht behauptet',async()=>{
  const f=await ledgerFixture(),profile=await loadProfile();
  const {leads}=JSON.parse(await readFile('examples/consulting-evidence.json','utf8'));
  const selected=leads.slice(0,1);
  const results=await runPipeline({profile,asOf:'2026-09-10',telemetry:f.ledger.tracker(f.run.$id,'fixture'),discover:async()=>selected,
    collectEvidence:async({candidate})=>candidate.evidence,enrich:buildEvidenceDossier});
  await f.ledger.finish({runId:f.run.$id,status:'completed'});
  const report=await f.ledger.report({day:'2026-09-10'});
  assert.equal(report.checkedCandidates,1);assert.equal(report.uniqueCandidatesFound,1);assert.equal(report.tokens,null);
  assert.equal(report.externalEnrichmentCandidates,0);assert.equal(results.length,1);
});
test('Fehlende Messspeicherung stoppt Pipeline statt als normale Qualifikationslücke verschluckt zu werden',async()=>{
  const f=await ledgerFixture(),profile=await loadProfile();
  const original=f.repo.create.bind(f.repo);f.repo.create=async(table,id,row)=>{if(table==='pipeline_steps'&&row.phase==='evidence')throw new Error('storage unavailable');return original(table,id,row);};
  await assert.rejects(runPipeline({profile,asOf:'2026-09-10',telemetry:f.ledger.tracker(f.run.$id),discover:async()=>[{id:'a'}]}),e=>e.telemetryFailure===true);
});
function rampFixture(){
  const policy={...pilot,domain:'example.invalid'};
  const state={limit:5,paused:false,acknowledged:[],usedDays:[],epochStartedAt:'2026-09-01T00:00:00Z'};
  const now=new Date('2026-09-10T12:00:00Z');const attempts=[],events=[];
  for(const day of ['05','06','07'])for(let i=0;i<5;i++){
    const id=`${day}-${i}`,at=`2026-09-${day}T10:00:00Z`;
    attempts.push({$id:id,client_id:'own',message_id:id,status:'accepted',attempted_at:at,details_json:JSON.stringify({lastSyncAt:now.toISOString()})});
    events.push({$id:'event'+id,client_id:'own',message_id:id,event_type:'delivered',occurred_at:at});
  }
  return{policy,state,now,attempts,events};
}
test('Zeit allein oder API-Annahme erhöht keine Grenze; drei echte beobachtete Zustelltage können eine Prüfung ermöglichen',()=>{
  const f=rampFixture();
  assert.equal(assessRamp({...f,attempts:[],events:[]}).eligibleToRequestIncrease,false);
  assert.equal(assessRamp({...f,events:[]}).eligibleToRequestIncrease,false);
  const good=assessRamp(f);assert.equal(good.eligibleToRequestIncrease,true);assert.equal(good.proposedLimit,10);assert.equal(good.safeLimit,5);
  const unsynced=f.attempts.map(a=>({...a,details_json:'{}'}));assert.equal(assessRamp({...f,attempts:unsynced}).blocked,true);
  const futureSync=f.attempts.map(a=>({...a,details_json:JSON.stringify({lastSyncAt:'2026-09-11T12:00:00Z'})}));assert.equal(assessRamp({...f,attempts:futureSync}).eligibleToRequestIncrease,false);
  assert.throws(()=>validateRamp({...pilot,startLimit:101}));
});
test('Probleme, unbekannte Ausgänge und fehlende Beobachtungszeit halten oder reduzieren; unbekannte Reputation reicht nicht',async()=>{
  const f=rampFixture();
  assert.equal(assessRamp({...f,events:[...f.events,{...f.events[0],$id:'soft',event_type:'soft_bounce'}]}).safeLimit,2);
  assert.equal(assessRamp({...f,events:[...f.events,{...f.events[0],$id:'critical',event_type:'complaint'}]}).blocked,true);
  assert.equal(assessRamp({...f,events:[...f.events,{...f.events[0],$id:'optout',event_type:'unsubscribed'}]}).eligibleToRequestIncrease,false);
  const content=await contentFixture();content.time(f.now);await content.service.ramp.configure({policy:f.policy,by:'test',reason:'test'});
  const view=await content.service.ramp.snapshot();
  await assert.rejects(content.service.ramp.decide({expectedRevision:view.revision,action:'increase',by:'test',evidence:'unknown',observedAt:f.now.toISOString(),domainStatus:'unknown'}),/unbekannt/);
});
test('Erhöhung benötigt expliziten aktuellen Beleg und verbraucht Beobachtungstage; globale Controls bleiben unverändert',async()=>{
  const f=rampFixture(),c=await contentFixture();c.time('2026-09-01T00:00:00Z');
  await c.service.ramp.configure({policy:f.policy,by:'test',reason:'test'});
  for(const a of f.attempts)await c.repo.create('outreach_attempts',a.$id,a);
  for(const e of f.events)await c.repo.create('outreach_events',e.$id,e);
  c.time(f.now);const before=await c.repo.get('outreach_controls','default'),view=await c.service.ramp.snapshot();
  const result=await c.service.ramp.decide({expectedRevision:view.revision,action:'increase',by:'test',evidence:'Simulated current operator report',observedAt:f.now.toISOString(),domainStatus:'acceptable'});
  assert.equal(result.state.limit,10);assert.equal(result.state.usedDays.length,3);
  assert.equal((await c.service.ramp.snapshot()).eligibleToRequestIncrease,false);
  assert.deepEqual(await c.repo.get('outreach_controls','default'),before);
  await assert.rejects(c.service.ramp.decide({expectedRevision:view.revision,action:'increase',by:'test',evidence:'test',observedAt:f.now.toISOString(),domainStatus:'acceptable'}),/Revision/);
});
test('Idle-Neustart persistiert niedrige Grenze; erste neue Reservierung stellt alte hohe Grenze nicht wieder her',async()=>{
  const c=await contentFixture();await c.service.ramp.configure({policy:{...pilot,domain:'example.invalid'},by:'test',reason:'test'});
  const row=await c.service.ramp.row();const state=JSON.parse(row.state_json);state.limit=50;state.epochStartedAt='2026-08-01T00:00:00Z';
  await c.repo.update('outreach_ramp','default',{state_json:JSON.stringify(state)});
  await c.repo.create('outreach_attempts','old',{client_id:'own',message_id:'old',attempted_at:'2026-08-15T10:00:00Z',status:'accepted',details_json:JSON.stringify({lastSyncAt:'2026-08-18T10:00:00Z'})});
  await c.repo.create('outreach_events','old-delivery',{client_id:'own',message_id:'old',event_type:'delivered',occurred_at:'2026-08-15T10:01:00Z'});
  assert.equal((await c.service.ramp.guard('x@example.invalid')).limit,5);
  await c.repo.create('outreach_attempts','new',{client_id:'other',message_id:'new',attempted_at:'2026-09-12T10:00:00Z',status:'reserved',details_json:'{}'});
  assert.equal((await c.service.ramp.snapshot()).safeLimit,5);
  assert.equal(JSON.parse((await c.service.ramp.row()).state_json).limit,5);
});
test('Dauerhafte globale Reservierungen begrenzen weitere Firmen und neues Datum; Domainwechsel hebt Grenze nicht auf',async()=>{
  const c=await contentFixture();await c.service.ramp.configure({policy:{...pilot,domain:'example.invalid',startLimit:1,minDeliveredPerDay:1},by:'test',reason:'test'});
  await c.send(0);await assert.rejects(c.send(1),/Versandaufbau-Limit/);
  assert.equal((await c.repo.list('outreach_attempts')).length,1);
  c.time('2026-09-13T09:00:00Z');
  await assert.rejects(c.service.ramp.guard('x@example.invalid'),/Limit/);
  await assert.rejects(c.service.ramp.guard('x@elsewhere.invalid'),/Absenderdomain/);
});
test('Neue Störung pausiert den Aufbau dauerhaft und reduziert bei Soft Bounce; weitere Wiederholung reduziert nicht erneut',async()=>{
  const c=await contentFixture();await c.service.ramp.configure({policy:{...pilot,domain:'example.invalid'},by:'test',reason:'test'});
  const id=await c.send();await c.repo.create('outreach_events','soft',{client_id:'own',message_id:id,event_type:'soft_bounce',occurred_at:c.service.now().toISOString()});
  await assert.rejects(c.service.ramp.guard('x@example.invalid'),/Problemereignisse/);
  const row=await c.service.ramp.row();assert.equal(JSON.parse(row.state_json).paused,true);assert.equal(JSON.parse(row.state_json).limit,2);
  await assert.rejects(c.service.ramp.guard('x@example.invalid'),/pausiert/);
  assert.equal(JSON.parse((await c.service.ramp.row()).state_json).limit,2);
  assert.equal((await c.service.ramp.snapshot()).safeLimit,2);
});
test('Manuelle Rückmeldungen deduplizieren und sperren Firma ohne Mail-Ereignisse; passende Inhaltsentwürfe bleiben sichtbar',async()=>{
  const c=await contentFixture(),dashboard=new DashboardData(c.service);await c.publish('personalization',c.personalizations[0]);
  const value={companyId:'co1',type:'conversation_positive',channel:'phone',occurredAt:c.service.now().toISOString(),sourceId:'call-1',source:'phone note',note:'Testnotiz',by:'Tester'};
  await dashboard.activity(value);assert.equal((await dashboard.activity(value)).inserted,false);
  await assert.rejects(dashboard.activity({...value,note:'changed'}),/anders/);
  assert.equal((await dashboard.leads({positive:'true'})).total,1);
  let detail=await dashboard.lead('co1');assert.equal(detail.drafts.length,1);assert.equal(detail.messages.length,0);assert.equal(detail.company.positiveResponse,true);
  await dashboard.activity({...value,type:'do_not_contact',sourceId:'call-2'});
  detail=await dashboard.lead('co1');assert.equal(detail.company.blocked,true);assert.equal(detail.company.blockReason,'Testnotiz');
  assert.equal((await c.repo.list('outreach_events')).length,0);assert.equal((await c.repo.list('outreach_attempts')).length,0);
  await assert.rejects(c.send(),/gesperrt|Sperre|Kontakt|contact/i);
});
test('Neue HTTP-Routen sind authentifiziert, liefern gefilterte Seiten und erfassen echte manuelle Notizen',async()=>{
  const c=await contentFixture(),token='local-test-token-'.repeat(3),server=createApi({service:c.service,repo:c.repo,env:{},token});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  try{
    assert.equal((await fetch(base+'/v1/dashboard/overview')).status,401);
    const headers={authorization:`Bearer ${token}`,'content-type':'application/json'};
    const list=await(await fetch(base+'/v1/dashboard/leads?pageSize=1&sort=name_desc&research=reviewed',{headers})).json();
    assert.equal(list.total,2);assert.equal(list.items[0].$id,'co2');
    const res=await fetch(base+'/v1/lead-activities',{method:'POST',headers,body:JSON.stringify({companyId:'co1',type:'note',channel:'other',occurredAt:c.service.now().toISOString(),sourceId:'http-1',source:'local test',note:'Testnotiz',by:'test'})});
    assert.equal(res.status,200);assert.equal((await c.repo.list('lead_activities')).length,1);
  }finally{await new Promise(resolve=>server.close(resolve));}
});
test('Nur ausdrücklich mailverknüpfte Aktivitäten erscheinen als manuell in der Timeline, ohne Providerkennzahlen zu verändern',async()=>{
  const c=await contentFixture(),dashboard=new DashboardData(c.service),{enrollment}=await c.enroll();
  const base={companyId:'co1',type:'conversation_positive',channel:'email',occurredAt:c.service.now().toISOString(),source:'Manual test',note:'Fiktive Rückmeldung',by:'Tester'};
  await dashboard.activity({...base,sourceId:'company-only'});
  await dashboard.activity({...base,sourceId:'mail-linked',messageId:enrollment.message_id});
  const detail=await dashboard.message(enrollment.message_id);
  const manual=detail.timeline.filter(e=>e.origin==='lead_activity');assert.equal(manual.length,1);
  assert.equal(manual[0].type,'conversation_positive');assert.equal(manual[0].channel,'email');assert.equal(manual[0].source,'Manual test');
  assert.equal(detail.sentAt,null);assert.equal(detail.acceptedAt,null);
  assert.equal((await c.repo.list('outreach_events')).filter(e=>e.event_type==='reply_positive').length,0);
});
