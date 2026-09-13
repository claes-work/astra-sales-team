import { contentHash } from '../outreach/profiles.mjs';
import { identity } from '../outreach/experiment.mjs';
import { query } from '../outreach/appwrite.mjs';
import { PipelineLedger } from './ledger.mjs';
import { dayKey, dateKey, instant, intervalDays, BERLIN } from './time.mjs';
import { overviewSuccess,overviewUsage,recentActivity } from './overview.mjs';
import { pipelineProjection,candidateFunnel } from './reporting.mjs';
import { quizSubmissions } from '../integrations/website-quiz.mjs';
const json = text => { try { return JSON.parse(text || '{}'); } catch { return {}; } };
const first = values => values.filter(Boolean).sort((a,b)=>Date.parse(a)-Date.parse(b))[0]??null;
const sentTimeNote = 'Versandereignis bestimmt den Tag. Fehlt es, zählt der Zustelltag ausdrücklich als Ersatz; der tatsächliche Versandtag ist dann unbekannt. Später importierte Versandereignisse können die Tageszuordnung korrigieren.';
function productionData(source){
  const d={...source},testMessages=new Set(d.outreach_test_messages.map(m=>m.$id)),testCompanies=new Set(d.outreach_test_messages.map(m=>m.company_id));
  d.companies=d.companies.filter(c=>!testCompanies.has(c.$id));
  for(const table of ['assessments','contacts','outreach_messages','outreach_enrollments','lead_activities','website_quiz_submissions'])
    d[table]=d[table].filter(r=>!testCompanies.has(r.company_id)&&!testMessages.has(r.message_id??r.$id)&&r.is_test!==true);
  for(const table of ['outreach_events','outreach_attempts'])d[table]=d[table].filter(r=>!testMessages.has(r.message_id));
  if(d.facts){const allowed=new Set(d.outreach_messages.map(m=>m.$id));d.facts=new Map([...d.facts].filter(([id])=>allowed.has(id)));}
  return d;
}
export function mailFacts(m, events, attempts, now = new Date()) {
  const eligible = attempts.filter(a=>a.message_id===m.$id&&a.client_id===m.client_id&&Date.parse(a.attempted_at)<=now.getTime());
  const earliest = Math.min(...eligible.map(a=>Date.parse(a.attempted_at)));
  const es=events.filter(e=>e.message_id===m.$id&&e.client_id===m.client_id&&Date.parse(e.occurred_at)>=earliest&&Date.parse(e.occurred_at)<=now.getTime());
  const providerSentAt=first(es.filter(e=>e.event_type==='provider_sent').map(e=>e.occurred_at));
  const deliveredAt=first(es.filter(e=>e.event_type==='delivered').map(e=>e.occurred_at));
  return {id:m.$id,subject:m.subject??'',status:m.status,
    sentAt:providerSentAt??deliveredAt,
    sentAtSource:providerSentAt?'provider_sent':deliveredAt?'delivered':null,
    sentAtIsProxy:providerSentAt?false:deliveredAt?true:null,
    acceptedAt:first([...eligible.filter(a=>a.status==='accepted').map(a=>a.attempted_at),...es.filter(e=>e.event_type==='provider_accepted').map(e=>e.occurred_at)]),
    deliveredAt};
}
export class DashboardData {
  constructor(service) {this.s=service;this.repo=service.repo;this.ledger=new PipelineLedger({repo:this.repo,now:service.now,lock:service.lock});}
  async inventory({includeTests=false}={}) {
    const tables=['assessments','contacts','research_runs','enrichments','outreach_messages','outreach_events','outreach_attempts','outreach_enrollments','lead_activities','pipeline_runs','pipeline_steps','website_quiz_submissions','outreach_test_messages'];
    const values=await Promise.all(tables.map(t=>this.repo.list(t)));
    let d=Object.fromEntries(tables.map((t,i)=>[t,values[i]]));
    // Only identity/search/status fields for server-side joins; full company rows are paged separately.
    d.companies=await this.repo.list('companies',[query('select',['$id','$createdAt','client_id','name','domain','do_not_contact'])]);
    if(!includeTests)d=productionData(d);
    d.facts=new Map(d.outreach_messages.map(m=>[m.$id,mailFacts(m,d.outreach_events,d.outreach_attempts,this.s.now())]));
    return d;
  }
  company(row,d) {
    const assessments=d.assessments.filter(a=>a.company_id===row.$id).sort((a,b)=>{
      const runTime=x=>Date.parse(d.research_runs.find(r=>r.$id===x.run_id)?.as_of??x.$createdAt??0);
      return runTime(b)-runTime(a)||String(b.$createdAt??'').localeCompare(a.$createdAt??'');
    });
    const latest=assessments[0],contacts=d.contacts.filter(c=>c.company_id===row.$id);
    const messages=d.outreach_messages.filter(m=>m.company_id===row.$id);
    const blocked=Boolean(row.do_not_contact||contacts.some(c=>c.do_not_contact));
    const activity=d.lead_activities.filter(a=>a.company_id===row.$id&&a.type==='do_not_contact').sort((a,b)=>Date.parse(b.occurred_at)-Date.parse(a.occurred_at))[0];
    const enrichment=latest&&d.enrichments.find(e=>e.assessment_id===latest.$id);
    return {...row,fit:latest?.status??'unreviewed',grade:latest?.grade??null,reason:latest?.reason??'Noch keine gespeicherte Bewertung.',
      researchStatus:enrichment?.status??(latest?'assessed':'unreviewed'),
      outreachStatus:messages.some(m=>d.facts.get(m.$id).sentAt)?'sent':messages.some(m=>['draft','approved'].includes(m.status))?'draft':messages.some(m=>d.facts.get(m.$id).acceptedAt)?'accepted':'unsent',
      blocked,blockReason:activity?json(activity.details_json).note:blocked?'Firma oder mindestens ein Kontakt gesperrt; Quelle in Detailansicht prüfen.':null,
      positiveResponse:d.lead_activities.some(a=>a.company_id===row.$id&&a.type==='conversation_positive')||d.outreach_events.some(e=>e.event_type==='reply_positive'&&messages.some(m=>m.$id===e.message_id)),
      isNew:!latest,createdAt:row.$createdAt??null,lastResearchAt:latest?(d.research_runs.find(r=>r.$id===latest.run_id)?.as_of??null):null};
  }
  async leads({page=1,pageSize=20,q='',fit='',outreach='',blocked='',sort='name_asc',research='',positive=''}={}) {
    page=Number(page);pageSize=Number(pageSize);
    if(!Number.isInteger(page)||page<1||!Number.isInteger(pageSize)||pageSize<1||pageSize>100||typeof q!=='string'||q.length>200
      ||!['','qualified','excluded','not_qualified','needs_review','unreviewed'].includes(fit)||!['','sent','draft','unsent','accepted'].includes(outreach)||!['','true','false'].includes(blocked)
      ||!['name_asc','name_desc','research_desc','created_desc'].includes(sort)||!['','unreviewed','reviewed','enriched'].includes(research)||!['','true','false'].includes(positive))throw new Error('Ungültige Lead-Filter.');
    const d=await this.inventory(),term=q.trim().toLocaleLowerCase('de');
    const matches=d.companies.map(c=>this.company(c,d)).filter(c=>(!term||`${c.name} ${c.domain}`.toLocaleLowerCase('de').includes(term))&&(!fit||c.fit===fit)&&(!outreach||c.outreachStatus===outreach)&&(!blocked||c.blocked===(blocked==='true'))
      &&(!positive||c.positiveResponse===(positive==='true'))&&(!research||(research==='unreviewed'?c.isNew:research==='reviewed'?!c.isNew:c.researchStatus==='completed')))
      .sort((a,b)=>(sort==='name_asc'?a.name.localeCompare(b.name,'de'):sort==='name_desc'?b.name.localeCompare(a.name,'de'):String(sort==='created_desc'?b.createdAt??'':b.lastResearchAt??'').localeCompare(String(sort==='created_desc'?a.createdAt??'':a.lastResearchAt??'')))||a.$id.localeCompare(b.$id));
    const selected=matches.slice((page-1)*pageSize,page*pageSize);
    const full=selected.length ? this.repo.page ? (await this.repo.page('companies',{pageSize,filters:[query('equal',selected.map(c=>c.$id),'$id')]})).rows : d.companies : [];
    return {page,pageSize,total:matches.length,items:selected.map(c=>({...full.find(r=>r.$id===c.$id),...c}))};
  }
  async lead(id) {
    const d=await this.inventory({includeTests:true}),row=await this.repo.get('companies',id);if(!row)throw new Error('Firma fehlt.');
    const assessmentIds=new Set(d.assessments.filter(a=>a.company_id===id&&a.client_id===row.client_id).map(a=>a.$id));
    const drafts=(await this.repo.list('outreach_drafts')).filter(r=>r.client_id===row.client_id&&r.kind==='personalization'&&assessmentIds.has(json(r.definition_json).assessmentId))
      .map(r=>{const p=json(r.definition_json);return{id:r.$id,title:r.name,key:r.profile_key,version:r.version_label,reviewStatus:p.review?.status??'unknown',contentHash:r.content_hash};});
    return {company:this.company(row,d),assessments:d.assessments.filter(a=>a.company_id===id),contacts:d.contacts.filter(c=>c.company_id===id),
      isTest:d.outreach_test_messages.some(m=>m.company_id===id),
      quizSubmissions:quizSubmissions(d,this.s.now(),{includeTests:true}).filter(q=>q.companyId===id),
      drafts,messages:d.outreach_messages.filter(m=>m.company_id===id).map(m=>d.facts.get(m.$id)),activities:d.lead_activities.filter(a=>a.company_id===id).sort((a,b)=>Date.parse(b.occurred_at)-Date.parse(a.occurred_at)).map(a=>({...a,details:json(a.details_json)}))};
  }
  async message(id) {
    const d=await this.inventory({includeTests:true}),m=d.outreach_messages.find(m=>m.$id===id);if(!m)throw new Error('Nachricht fehlt.');
    const quizzes=quizSubmissions(d,this.s.now(),{includeTests:true}).filter(q=>q.messageId===id);
    const enrollment=d.outreach_enrollments.find(e=>e.message_id===id);const snapshot=json(enrollment?.snapshot_json);
    const timeline=[
      ...d.outreach_events.filter(e=>e.message_id===id&&e.client_id===m.client_id&&e.event_type!=='quiz_completed').map(e=>({id:e.$id,type:e.event_type,at:e.occurred_at,origin:'outreach_event',source:json(e.details_json).source??json(e.details_json).provider??null,details:json(e.details_json)})),
      ...quizzes,
      ...d.lead_activities.filter(a=>a.message_id===id&&a.client_id===m.client_id&&a.company_id===m.company_id).map(a=>({id:a.$id,type:a.type,at:a.occurred_at,origin:'lead_activity',source:json(a.details_json).source??null,channel:a.channel,details:json(a.details_json)})),
    ].filter(e=>Date.parse(e.at)<=this.s.now().getTime()).sort((a,b)=>Date.parse(a.at)-Date.parse(b.at)||a.id.localeCompare(b.id));
    let verified=false;
    if(enrollment){try{await this.s.context(id);verified=true;}catch{}}
    return {...d.facts.get(id),companyId:m.company_id,companyName:d.companies.find(c=>c.$id===m.company_id)?.name??'Unbekannte Firma',
      body:m.body,to:m.target_address,sender:snapshot.sender??null,replyTo:snapshot.replyTo??null,snapshotVerified:verified,
      isTest:d.outreach_test_messages.some(t=>t.$id===id),quizSubmissions:quizzes,
      frozen:{experimentId:enrollment?.experiment_id??null,variant:enrollment?.variant_id??null,contentHash:enrollment?.content_hash??null,
        strategy:snapshot.personalization?.dependencies?.strategy?{key:snapshot.personalization.dependencies.strategy.key,version:snapshot.personalization.dependencies.strategy.version}:null,
        personalizationVersion:snapshot.personalization?.version??null,experiment:snapshot.personalization?.dependencies?.experiment??null},
      timeline,
      tracking:{openClickNote:'Gemeldete Öffnungen/Klicks können automatische Abrufe sein; fehlende Events bedeuten unbekannt.',website:quizzes.length?'Validierte Quiz-Abschlüsse erfasst; Formularidentität ist vom ursprünglichen Empfänger getrennt.':'Keine zugeordneten Quiz-Abschlüsse erfasst.',bookings:'Nur eindeutig erfasste manuelle Ergebnisse; automatischer Buchungsimport noch nicht verbunden'}};
  }
  relevantDays(d) {
    const now=this.s.now(),{mainRuns,reportingDayByRun}=pipelineProjection(d,dayKey(now),now),ids=new Set(mainRuns.map(r=>r.$id));
    const days=(start,end,id)=>reportingDayByRun[id]?[reportingDayByRun[id]]:intervalDays(start,end??now);
    return [...new Set([dayKey(now),...d.pipeline_steps.filter(s=>ids.has(s.run_id)).flatMap(s=>days(s.started_at,s.finished_at,s.run_id)),...mainRuns.flatMap(r=>days(r.started_at,r.finished_at,r.$id)),
      ...d.outreach_attempts.map(a=>dayKey(a.attempted_at)),...d.outreach_events.map(e=>dayKey(e.occurred_at)),...d.lead_activities.map(a=>dayKey(a.occurred_at))])].sort().reverse();
  }
  daily(d,day) {
    dateKey(day);
    const {pipeline,reporting}=pipelineProjection(d,day,this.s.now());
    const funnel=candidateFunnel(pipeline,d.companies);
    const quizzes=quizSubmissions(d,this.s.now()).filter(q=>dayKey(q.at)===day);
    const quizIds=new Set(quizzes.map(q=>q.id));
    const eventRows=d.outreach_events.filter(e=>dayKey(e.occurred_at)===day&&Date.parse(e.occurred_at)<=this.s.now().getTime()&&(e.event_type!=='quiz_completed'||quizIds.has(e.$id)));
    const count=types=>new Set(eventRows.filter(e=>types.includes(e.event_type)).map(e=>e.message_id)).size;
    const mail=[...d.facts.values()];
    const sent=mail.filter(m=>m.sentAt&&dayKey(m.sentAt)===day).map(f=>{const m=d.outreach_messages.find(m=>m.$id===f.id);return{messageId:f.id,companyId:m.company_id,companyName:d.companies.find(c=>c.$id===m.company_id)?.name??'Unbekannt',subject:f.subject,sentAt:f.sentAt,sentAtSource:f.sentAtSource,sentAtIsProxy:f.sentAtIsProxy};});
    const hasTracking=pipeline.runs.length>0;
    const counts={day,sentMessages:sent.length,acceptedMessages:mail.filter(m=>m.acceptedAt&&dayKey(m.acceptedAt)===day).length,
      sentTimeKnownMessages:sent.filter(m=>m.sentAtIsProxy===false).length,sentTimeProxyMessages:sent.filter(m=>m.sentAtIsProxy===true).length,sentTimeNote,
      deliveredMessages:mail.filter(m=>m.deliveredAt&&dayKey(m.deliveredAt)===day).length,
      searchedCandidates:pipeline.coverage.search?funnel.discovered:null,checkedCandidates:pipeline.coverage.qualification?funnel.checked:null,
      qualifiedCandidates:pipeline.coverage.qualification?funnel.qualified:null,pipelineRunCount:pipeline.runs.length,
      consideredCandidates:pipeline.coverage.search||pipeline.coverage.qualification?funnel.considered:null,carriedCandidates:funnel.carried,
      reportedPipelineDayAssigned:reporting.assignments.length>0,pipelineOriginalDays:[...new Set(reporting.assignments.flatMap(a=>a.originalDays))].sort(),
      bounces:count(['soft_bounce','hard_bounce','invalid_email']),deferrals:count(['deferred']),complaints:count(['complaint']),optOuts:count(['unsubscribed'])};
    return {day,timezone:BERLIN,counts,pipeline,reporting,funnel,sent,quizSubmissions:quizzes,events:eventRows.map(e=>({id:e.$id,messageId:e.message_id,type:e.event_type,at:e.occurred_at})),
      variableCosts:{knownByCurrency:pipeline.costsByCurrency,unknownSteps:pipeline.stepsWithUnknownCost,complete:hasTracking&&pipeline.steps.length>0&&pipeline.openSteps===0&&pipeline.stepsWithUnknownCost===0,subscriptions:'Nicht angebunden; geplanter zweiter Schritt'}};
  }
  async days(){const d=await this.inventory();return{timezone:BERLIN,items:this.relevantDays(d).map(day=>this.daily(d,day).counts)};}
  async day(day){
    dateKey(day);
    const all=await this.inventory({includeTests:true});
    // Explicit detail route keeps marked integration evidence visible. Counts,
    // ordinary events and all overview/day-list aggregates remain production-only.
    return{...this.daily(productionData(all),day),
      quizSubmissions:quizSubmissions(all,this.s.now(),{includeTests:true}).filter(q=>dayKey(q.at)===day)};
  }
  async overview(){const d=await this.inventory(),companies=d.companies.map(c=>this.company(c,d)),facts=[...d.facts.values()];
    const now=this.s.now(),controls=await this.repo.get('outreach_controls','default'),ramp=await this.s.ramp.snapshot();return{
    asOf:this.s.now().toISOString(),timezone:BERLIN,totals:{companies:companies.length,checkedCompanies:companies.filter(c=>!c.isNew).length,
      qualifiedCompanies:companies.filter(c=>c.fit==='qualified').length,excludedCompanies:companies.filter(c=>['excluded','not_qualified'].includes(c.fit)).length,
      sentMessages:facts.filter(f=>f.sentAt).length,acceptedMessages:facts.filter(f=>f.acceptedAt).length,deliveredMessages:facts.filter(f=>f.deliveredAt).length,
      sentTimeKnownMessages:facts.filter(f=>f.sentAtIsProxy===false).length,sentTimeProxyMessages:facts.filter(f=>f.sentAtIsProxy===true).length,sentTimeNote,
      draftMessages:facts.filter(f=>['draft','approved'].includes(f.status)).length},
    today:this.daily(d,dayKey(this.s.now())),days:this.relevantDays(d).map(day=>this.daily(d,day).counts),controls,ramp,
    success:overviewSuccess(d,now),usage:overviewUsage(d,{controls,ramp,env:this.s.env},now),recentActivity:recentActivity(d,now),
    limitations:['Recherchebestand enthält historische ungeinstrumentierte Daten; Tagesleistung und Zeiten dafür unbekannt.',
      'Belegter Versand basiert auf provider_sent oder delivered, API-Annahme separat. Bei delivered allein ist der Zustelltag nur Ersatz für den unbekannten Versandtag. Externe Einrichtungstestmails sind nicht in dieser Kampagnendatenbank.',
      'Abokosten und Umlagen sind noch nicht erfasst. Quiz-Abschlüsse werden separat mit Formularprovenienz erfasst; kein automatischer Buchungsimport.']};}
  async activity({companyId,type,channel,occurredAt,sourceId,source,note,by,messageId}) {
    return this.s.lock(async()=>{
      const company=await this.repo.get('companies',companyId),at=instant(occurredAt);
      if(!company||!['note','conversation_positive','do_not_contact'].includes(type)||!['phone','email','other'].includes(channel)||[sourceId,source,note,by].some(x=>typeof x!=='string'||!x.trim()||x.length>4000)||Date.parse(at)>this.s.now().getTime())throw new Error('Rückmeldung braucht Firma, Typ, Kanal, tatsächliches Datum, Quelle, Notiz und Bearbeiter.');
      if(messageId){const m=await this.repo.get('outreach_messages',messageId);if(!m||m.company_id!==companyId||m.client_id!==company.client_id)throw new Error('Nachricht gehört nicht zur Firma.');}
      const eventKey=contentHash([company.client_id,companyId,source,sourceId]),id=identity('act',eventKey);
      const details={sourceId,source,note,by};const row={client_id:company.client_id,company_id:companyId,...(messageId?{message_id:messageId}:{}),event_key:eventKey,type,channel,occurred_at:at,recorded_at:this.s.now().toISOString(),details_json:JSON.stringify(details)};
      const old=await this.repo.get('lead_activities',id);
      if(old){if(old.type!==type||old.channel!==channel||Date.parse(old.occurred_at)!==Date.parse(at)||old.details_json!==row.details_json||(old.message_id??null)!==(messageId??null))throw new Error('Quellkennung bereits anders belegt.');return{...old,inserted:false};}
      await this.repo.transaction([{action:'create',table:'lead_activities',id,data:row},...(type==='do_not_contact'?[{action:'update',table:'companies',id:companyId,data:{do_not_contact:true}}]:[])]);
      return{$id:id,...row,inserted:true};
    });
  }
}
