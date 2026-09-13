import { identity } from '../outreach/experiment.mjs';
import { contentHash } from '../outreach/profiles.mjs';
import { withOutreachLock } from '../outreach/lock.mjs';
import { dayKey, dateKey, instant, overlapMs, intervalDays, BERLIN } from './time.mjs';

const phases = new Set(['search','qualification','evidence','enrichment','authoring']);
const outcomes = new Set(['qualified','excluded','not_qualified','needs_review']);
const clean = row => Object.fromEntries(Object.entries(row).filter(([key]) => !key.startsWith('$')));
const text = (x, limit = 512) => typeof x === 'string' && Boolean(x.trim()) && x.length <= limit;
class TelemetryError extends Error { constructor(){super('Messprotokoll konnte nicht zuverlässig gespeichert werden. Lauf prüfen, bevor er fortgesetzt wird.');this.telemetryFailure=true;} }
function object(value) { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Objekt erforderlich.'); }
function size(value) { if (Buffer.byteLength(JSON.stringify(value)) > 60000) throw new Error('Messdatensatz zu groß.'); }
function metrics(details) {
  for (const key of ['tokens','costAmount']) if (details[key] != null && (!Number.isFinite(details[key]) || details[key] < 0)) throw new Error('Messwert muss tatsächlich erfasst und nichtnegativ sein.');
  if ((details.tokens != null || details.costAmount != null) && !text(details.measurementSource)) throw new Error('Messwerte brauchen eine Erfassungsquelle.');
  if (details.costAmount != null && !/^[A-Z]{3}$/.test(details.currency ?? '')) throw new Error('Kosten brauchen eine Währung.');
}
export class PipelineLedger {
  constructor({ repo, now = () => new Date(), lock = withOutreachLock }) { this.repo = repo; this.now = now; this.lock = lock; }
  async start({ clientId, key, kind, context, startedAt = this.now().toISOString() }) {
    return this.lock(async () => {
      if (!await this.repo.get('clients', clientId) || !text(key,100) || !text(kind,100)) throw new Error('Auftraggeber, Laufkennung und Art erforderlich.');
      object(context); size(context);
      if (!['instrumented','reported'].includes(context.capture) || !text(context.source)) throw new Error('Messung braucht Herkunft und Erfassungsart.');
      await this.references(clientId, context);
      const started = instant(startedAt); if (Date.parse(started) > this.now().getTime() || this.now()-Date.parse(started)>366*86400000) throw new Error('Laufstart liegt außerhalb des unterstützten Zeitfensters (maximal 366 Tage).');
      const row = { client_id: clientId, run_key: key, kind, status: 'running', started_at: started, context_json: JSON.stringify(context) };
      const id = identity('plr',clientId,key), old = await this.repo.get('pipeline_runs',id);
      if (old) {
        if (old.kind !== kind || contentHash(JSON.parse(old.context_json)) !== contentHash(context) || Date.parse(old.started_at) !== Date.parse(started)) throw new Error('Laufkennung bereits mit anderem Inhalt belegt.');
        return old;
      }
      return this.repo.create('pipeline_runs',id,row);
    });
  }
  async references(clientId, details) {
    const rows={};
    for (const [field,table] of [['companyId','companies'],['assessmentId','assessments'],['researchRunId','research_runs'],['icpVersionId','icp_versions'],['strategyVersionId','outreach_versions'],['experimentVersionId','outreach_versions'],['experimentId','outreach_experiments']]) {
      if (details[field] != null) { const row = await this.repo.get(table,details[field]); if (!row || row.client_id !== clientId) throw new Error('Messreferenz gehört nicht zum Auftraggeber.'); rows[field]=row; }
    }
    if ((rows.strategyVersionId&&rows.strategyVersionId.kind!=='strategy')||(rows.experimentVersionId&&rows.experimentVersionId.kind!=='experiment')
      ||(rows.assessmentId&&details.companyId&&rows.assessmentId.company_id!==details.companyId)
      ||(rows.assessmentId&&details.researchRunId&&rows.assessmentId.run_id!==details.researchRunId)
      ||(rows.assessmentId&&details.icpVersionId&&rows.assessmentId.icp_version_id!==details.icpVersionId))throw new Error('Messreferenzen passen fachlich nicht zusammen.');
  }
  async step({ runId, key, phase, candidateKey = null, startedAt, finishedAt = null, status = 'running', details = {} }) {
    return this.lock(async () => {
      const run = await this.repo.get('pipeline_runs',runId);
      if (!run || !text(key,150) || !phases.has(phase) || (candidateKey != null && !text(candidateKey))) throw new Error('Ungültiger Schritt.');
      if (!['running','completed','failed','skipped'].includes(status) || (phase !== 'search' && candidateKey == null)) throw new Error('Schritt braucht Status und eindeutige Kandidatenkennung.');
      object(details); size(details); metrics(details); await this.references(run.client_id,details);
      if (details.outcome && (!outcomes.has(details.outcome) || phase !== 'qualification' || !text(details.reason,10000))) throw new Error('Bewertung braucht gültigen Ausgang und Begründung.');
      if (status === 'completed' && phase === 'qualification' && !details.outcome) throw new Error('Qualifikationsentscheidung fehlt.');
      if (status === 'failed' && !text(details.errorCode)) throw new Error('Fehlercode fehlt.');
      if (details.candidateKeys !== undefined && (phase !== 'search' || !Array.isArray(details.candidateKeys) || details.candidateKeys.some(k => !text(k)))) throw new Error('Suchergebnis braucht Kandidatenkennungen.');
      if (status === 'completed' && phase === 'search' && !Array.isArray(details.candidateKeys)) throw new Error('Suchergebnis fehlt.');
      const started = instant(startedAt), finished = finishedAt == null ? null : instant(finishedAt);
      if ((status === 'running') !== (finished === null) || Date.parse(started) < Date.parse(run.started_at)
        || Date.parse(started) > this.now().getTime() || (finished && (Date.parse(finished) < Date.parse(started) || Date.parse(finished) > this.now().getTime()))) throw new Error('Schrittzeitpunkte passen nicht.');
      if (finished && Date.parse(finished)-Date.parse(started)>366*86400000) throw new Error('Schrittintervall zu groß.');
      const id = identity('pls',runId,key), old = await this.repo.get('pipeline_steps',id);
      const row = { client_id: run.client_id, run_id: runId, step_key: key, phase, candidate_key: candidateKey, started_at: started,
        ...(finished ? { finished_at: finished } : {}), status, details_json: JSON.stringify(details) };
      if (old) {
        const same = old.phase === phase && old.candidate_key === candidateKey && Date.parse(old.started_at) === Date.parse(started);
        if (!same) throw new Error('Schrittkennung bereits mit anderem Versuch belegt.');
        if (old.status !== 'running') {
          if (old.status !== status || Date.parse(old.finished_at) !== Date.parse(finished) || contentHash(JSON.parse(old.details_json)) !== contentHash(details)) throw new Error('Abgeschlossener Schritt bleibt unverändert.');
          return old;
        }
      }
      if (run.status !== 'running') throw new Error('Lauf ist abgeschlossen.');
      if (details.retryOf) {
        const prior = await this.repo.get('pipeline_steps',identity('pls',runId,details.retryOf));
        if (!prior || prior.phase !== phase || prior.candidate_key !== candidateKey || prior.status !== 'failed') throw new Error('Retry braucht einen fehlgeschlagenen passenden Versuch.');
      }
      return old ? this.repo.update('pipeline_steps',id,row) : this.repo.create('pipeline_steps',id,row);
    });
  }
  async finish({ runId, status, finishedAt = this.now().toISOString() }) {
    return this.lock(async () => {
      const run = await this.repo.get('pipeline_runs',runId); const at = instant(finishedAt);
      if (!run || !['completed','failed','cancelled'].includes(status) || Date.parse(at)<Date.parse(run.started_at) || Date.parse(at)>this.now().getTime() || Date.parse(at)-Date.parse(run.started_at)>366*86400000) throw new Error('Ungültiger Laufabschluss.');
      if (run.status !== 'running') { if (run.status===status && Date.parse(run.finished_at)===Date.parse(at)) return run; throw new Error('Lauf bereits abgeschlossen.'); }
      const steps = (await this.repo.list('pipeline_steps')).filter(s=>s.run_id===runId);
      if (steps.some(s=>s.status==='running' || Date.parse(s.finished_at)>Date.parse(at))) throw new Error('Zuerst offene Schritte abschließen.');
      return this.repo.update('pipeline_runs',runId,{status,finished_at:at});
    });
  }
  tracker(runId, namespace = 'lead') {
    let sequence = 0;
    return { candidateKey: candidate => `${namespace}:${candidate.id}`,
      measure: async (input, work, describe = () => ({})) => {
        const key = `${++sequence}-${input.phase}`, startedAt = this.now().toISOString();
        const record=async value=>{try{return await this.step(value);}catch{throw new TelemetryError();}};
        await record({ runId,key,...input,startedAt });
        let result,details;
        try { result = await work(); details={...input.details,...describe(result)}; }
        catch (error) { await record({runId,key,...input,startedAt,finishedAt:this.now().toISOString(),status:'failed',details:{...input.details,errorCode:`${input.phase}_failed`}}); throw error; }
        await record({runId,key,...input,startedAt,finishedAt:this.now().toISOString(),status:'completed',details});
        return result;
      } };
  }
  async report({ day = dayKey(this.now()), clientId, runId }) {
    dateKey(day);
    const runs = (await this.repo.list('pipeline_runs')).filter(r=>(!clientId || r.client_id===clientId)&&(!runId || r.$id===runId));
    const runIds = new Set(runs.map(r=>r.$id));
    const all = (await this.repo.list('pipeline_steps')).filter(s=>runIds.has(s.run_id));
    return pipelineReport({runs,steps:all,day,now:this.now()});
  }
}
export function pipelineReport({runs,steps,day,now,reportingDayByRun={}}) {
  // Reporting assignments are metadata, never research work. The raw ledger
  // remains on its original dates unless this read-side projection is requested.
  runs=runs.filter(r=>r.kind!=='reporting_assignment');
  const runIds=new Set(runs.map(r=>r.$id));
  steps=steps.filter(s=>runIds.has(s.run_id));
  const reportDay=s=>reportingDayByRun[s.run_id]??dayKey(s.finished_at);
  const duration=(start,end,runId)=>reportingDayByRun[runId]
    ?(reportingDayByRun[runId]===day?Math.max(0,Date.parse(end)-Date.parse(start)):0)
    :overlapMs(start,end,day);
  const details = s=>JSON.parse(s.details_json);
  const done = steps.filter(s=>s.status!=='running' && reportDay(s)===day);
  const searches = done.filter(s=>s.phase==='search');
  const hits = searches.flatMap(s=>details(s).candidateKeys??[]);
  const unique = list=>new Set(list.map(s=>`${s.client_id}:${s.candidate_key}`)).size;
  const q=done.filter(s=>s.phase==='qualification'&&s.status==='completed');
  const decisions=Object.fromEntries([...outcomes].map(outcome=>[outcome,unique(q.filter(s=>details(s).outcome===outcome))]));
  const measured=done.filter(s=>s.status==='completed');
  const covered=Object.fromEntries([...phases].map(phase=>[phase,measured.some(s=>s.phase===phase)]));
  const knownTokens=measured.filter(s=>details(s).tokens!=null);
  const costGroups=Map.groupBy(measured.filter(s=>details(s).costAmount!=null),s=>details(s).currency);
  // Sum only measured intervals; parallel operations can exceed elapsed wall-clock time.
  const processing=steps.reduce((n,s)=>n+duration(s.started_at,s.finished_at??now.toISOString(),s.run_id),0);
  const activeRuns=runs.filter(r=>duration(r.started_at,r.finished_at??now.toISOString(),r.$id)>0 || (reportingDayByRun[r.$id]??dayKey(r.started_at))===day);
  const intervals=activeRuns.flatMap(r=>{
    const start=Date.parse(r.started_at),end=Date.parse(r.finished_at??now);
    if(reportingDayByRun[r.$id])return [[start,end]];
    const slices=[];
    for(let at=start;at<end;){const next=Math.min(end,Math.floor(at/3600000)*3600000+3600000);if(dayKey(at)===day)slices.push([at,next]);at=next;}
    return slices;
  }).sort((a,b)=>a[0]-b[0]);
  const merged=[]; for(const [a,b] of intervals){const prev=merged.at(-1);if(prev&&a<=prev[1])prev[1]=Math.max(prev[1],b);else merged.push([a,b]);}
  return {day,timezone:BERLIN,runs:activeRuns.map(r=>({id:r.$id,key:r.run_key,kind:r.kind,status:r.status,context:JSON.parse(r.context_json),
    startedAt:r.started_at,finishedAt:r.finished_at??null,wallClockMsInDay:duration(r.started_at,r.finished_at??now.toISOString(),r.$id),
    ...(reportingDayByRun[r.$id]?{reportingDay:day,originalDays:intervalDays(r.started_at,r.finished_at??now)}:{})})),
    coverage:covered,searchAttempts:searches.length,searchFailures:searches.filter(s=>s.status==='failed').length,
    uniqueCandidatesFound:new Set(searches.flatMap(s=>(details(s).candidateKeys??[]).map(k=>s.client_id+':'+k))).size,
    candidateOccurrences:hits.length,duplicateOccurrences:hits.length-new Set(searches.flatMap(s=>(details(s).candidateKeys??[]).map(k=>s.client_id+':'+k))).size,
    qualificationAttempts:done.filter(s=>s.phase==='qualification').length,checkedCandidates:unique(q),decisions,
    enrichmentCandidates:unique(done.filter(s=>s.phase==='enrichment'&&s.status==='completed')),
    externalEnrichmentCandidates:unique(done.filter(s=>s.phase==='enrichment'&&s.status==='completed'&&details(s).newExternalResearch===true)),
    authoredCandidates:unique(done.filter(s=>s.phase==='authoring'&&s.status==='completed')),
    retryAttempts:done.filter(s=>details(s).retryOf).length,failures:done.filter(s=>s.status==='failed').length,
    elapsedWallClockMs:merged.reduce((n,[a,b])=>n+b-a,0),
    summedStepDurationMs:processing,openSteps:steps.filter(s=>s.status==='running'&&(duration(s.started_at,now.toISOString(),s.run_id)>0||(reportingDayByRun[s.run_id]??dayKey(s.started_at))===day)).length,
    tokens:knownTokens.length===measured.length&&measured.length?knownTokens.reduce((n,s)=>n+details(s).tokens,0):null,
    knownTokensSubtotal:knownTokens.reduce((n,s)=>n+details(s).tokens,0),stepsWithUnknownTokens:measured.length-knownTokens.length,
    costsByCurrency:Object.fromEntries([...costGroups].map(([currency,rows])=>[currency,{knownSubtotal:rows.reduce((n,s)=>n+details(s).costAmount,0)}])),
    stepsWithUnknownCost:measured.filter(s=>details(s).costAmount==null).length,
    steps:done.map(s=>({...clean(s),id:s.$id,details:details(s)})),
    notes:[Object.keys(reportingDayByRun).length?'Explizit zugeordnete Läufe zählen am Reportingtag; ihre Zeitstempel und der ursprüngliche Aufwand bleiben erhalten. Zugeordnete Dauer ist keine heute gemessene Arbeitszeit.':'Abschlüsse zählen am tatsächlichen Berliner Abschlusstag; Dauer wird über Tagesgrenzen aufgeteilt.',
      'Kandidatenkennungen sind quellenbezogen; mehrere Kennungen derselben Firma brauchen spätere Identitätsauflösung.',
      'Entscheidungen sind Ereignisse; eine Firma kann nach erneuter Prüfung mehrere Ausgänge haben. Kein exklusiver Bestandsfunnel.',
      'Historische ungeinstrumentierte Recherche fehlt bewusst. Laufzeiten umfassen gemessene Schritte, keine nachträglich geschätzte Recherchezeit.']};
}
