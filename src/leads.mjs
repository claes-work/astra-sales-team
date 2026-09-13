import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadProfile, profileIdentity } from './icp.mjs';
import { qualifyLead, validateEvidence } from './qualification.mjs';
import { buildEvidenceDossier, qualificationPlan, runPipeline } from './pipeline.mjs';
import { discoverWithPlaces } from './discovery.mjs';
import { loadKey } from './places.mjs';
import { PipelineLedger } from './operations/ledger.mjs';
import { LocalAppwrite, LIVE_DB } from './outreach/appwrite.mjs';
import { contentHash } from './outreach/profiles.mjs';

export async function loadEvidenceFile(path, profile) {
  let data;
  try { data = JSON.parse(await readFile(path, 'utf8')); }
  catch { throw new Error('Belegdatei konnte nicht als JSON gelesen werden.'); }
  if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).some(k => k !== 'leads') || !Array.isArray(data.leads)) throw new Error('Belegdatei benötigt ein Objekt mit leads-Liste.');
  const ids = new Set();
  data.leads.forEach((lead, index) => {
    if (!lead || typeof lead !== 'object' || Array.isArray(lead) || Object.keys(lead).some(k => !['id', 'name', 'website', 'evidence'].includes(k)) || typeof lead.id !== 'string' || !lead.id.trim() || ids.has(lead.id)) throw new Error(`Lead ${index + 1}: eindeutige id und gültige Felder erforderlich.`);
    if (['name', 'website'].some(k => lead[k] !== undefined && typeof lead[k] !== 'string')) throw new Error(`Lead ${index + 1}: name/website müssen Text sein.`);
    ids.add(lead.id);
    validateEvidence(profile, lead.evidence);
  });
  return data.leads;
}

export async function main(args = process.argv.slice(2)) {
  const [command, ...options] = args;
  if (!command || command === '--help') {
    console.log(`Aufrufe:
  npm run icp:check -- [--icp Datei.yaml]
  npm run leads:plan -- [--icp Datei.yaml]
  npm run leads:qualify -- --input Belege.json [--icp Datei.yaml] [--as-of YYYY-MM-DD]
  npm run leads:research -- --input Belege.json [--icp Datei.yaml] [--as-of YYYY-MM-DD]
  npm run leads:research -- --places [--input Belege.json] [--city Stadt] [--country Ländercode] [--query-index 0] [--websites] [--icp Datei.yaml]
Für qualify/research: --track-client own --track-key EINDEUTIGE-LAUFKENNUNG speichert aktuelle Messung in lokalem Appwrite.
Research erstellt ein Belegdossier. Externe Deep Research wird über den enrich-Adapter angebunden.`);
    return;
  }
  if (!['check', 'plan', 'qualify', 'research'].includes(command)) throw new Error('Unbekannter Befehl. --help zeigt die Aufrufe.');
  const values = {};
  const flags = new Set();
  for (let i = 0; i < options.length; i++) {
    const option = options[i];
    if (['--places', '--websites'].includes(option) && command === 'research') {
      if (flags.has(option)) throw new Error('Doppelte Option.');
      flags.add(option);
    } else if (['--icp', '--input', '--as-of', '--city', '--country', '--query-index', '--track-client', '--track-key'].includes(option) && options[i + 1] && !options[i + 1].startsWith('--')) {
      if (Object.hasOwn(values, option)) throw new Error('Doppelte Option.');
      values[option] = options[++i];
    } else throw new Error('Ungültige Option. --help zeigt die Aufrufe.');
  }
  if (['check', 'plan'].includes(command) && Object.keys(values).some(k => k !== '--icp')) throw new Error('check/plan unterstützt nur --icp.');
  if (!flags.has('--places') && (flags.has('--websites') || ['--city', '--country', '--query-index'].some(k => k in values))) throw new Error('Discovery-Optionen benötigen research --places.');
  const profile = await loadProfile(values['--icp'] ?? process.env.ICP_PROFILE);
  if (command === 'check') {
    console.log(JSON.stringify({ valid: true, profile: profileIdentity(profile) }, null, 2));
    return;
  }
  if (command === 'plan') {
    console.log(JSON.stringify({ profile: profileIdentity(profile), target: profile.target, facts: qualificationPlan(profile), signals: profile.signals, outreach: profile.outreach }, null, 2));
    return;
  }
  if (!values['--input'] && !flags.has('--places')) throw new Error('--input Belege.json fehlt.');
  const leads = values['--input'] ? await loadEvidenceFile(values['--input'], profile) : [];
  const asOf = values['--as-of'] ?? new Date().toISOString().slice(0, 10);
  // Datum auch bei leerem Input vor einem möglichen Google-Aufruf prüfen.
  qualifyLead({ profile, lead: { id: 'validation' }, asOf });
  if (Boolean(values['--track-client']) !== Boolean(values['--track-key'])) throw new Error('Messung braucht --track-client und neue --track-key.');
  let repo, ledger, run, telemetry;
  if (values['--track-client']) {
    repo = await new LocalAppwrite(LIVE_DB).connect(); ledger = new PipelineLedger({repo});
    try {
      run = await ledger.start({clientId:values['--track-client'],key:values['--track-key'],kind:flags.has('--places')?'places_discovery':command==='qualify'?'qualification_replay':'evidence_dossier_replay',
        context:{capture:'instrumented',source:'src/leads.mjs',icp:profileIdentity(profile),asOf,inputEvidence:values['--input']?{path:values['--input'],sha256:contentHash(leads)}:null,usesExistingEvidence:Boolean(values['--input']),newAutonomousResearch:false}});
      const tracker=ledger.tracker(run.$id,flags.has('--places')?'google_places':'evidence_input');
      const companies=(await repo.list('companies')).filter(c=>c.client_id===values['--track-client']);
      const references=new Map();
      for(const lead of leads){
        let domain;try{domain=new URL(lead.website).hostname.toLowerCase().replace(/^www\./,'');}catch{continue;}
        const matches=companies.filter(c=>c.domain?.toLowerCase().replace(/^www\./,'')===domain);
        if(matches.length===1)references.set(tracker.candidateKey(lead),matches[0].$id);
      }
      telemetry={...tracker,measure:(input,work,describe)=>tracker.measure({...input,details:{...(references.has(input.candidateKey)?{companyId:references.get(input.candidateKey)}:{}),...input.details}},work,describe)};
    } catch(error) {await repo.close();throw error;}
  }
  try {
  let results;
  if (command === 'qualify') {
    results=[];
    for(const lead of leads) results.push(telemetry ? await telemetry.measure({phase:'qualification',candidateKey:telemetry.candidateKey(lead)},
      async()=>qualifyLead({profile,lead,evidence:lead.evidence,asOf}),d=>({outcome:d.status,reason:d.gradeReason,decision:d})) : qualifyLead({profile,lead,evidence:lead.evidence,asOf}));
  }
  else {
    const byId = new Map(leads.map(lead => [lead.id, lead.evidence]));
    const queryIndex = values['--query-index'] === undefined ? 0 : /^\d+$/.test(values['--query-index']) ? Number(values['--query-index']) : NaN;
    results = await runPipeline({
      profile, asOf, telemetry,
      discover: flags.has('--places') ? () => discoverWithPlaces({
        profile, key: loadKey(), city: values['--city'], country: values['--country'], queryIndex, websites: flags.has('--websites'),
      }) : async () => leads.map(({ evidence, ...lead }) => lead),
      collectEvidence: async ({ candidate }) => byId.get(candidate.id) ?? [],
      enrich: buildEvidenceDossier,
    });
  }
  // Kein Export von Places-Name/Adresse/Website/Attribution; nur IDs und eigene Belege.
  if(run) await ledger.finish({runId:run.$id,status:'completed'});
  console.log(JSON.stringify({ profile: profileIdentity(profile), asOf, ...(run?{measuredRunId:run.$id}:{}),results }, null, 2));
  } catch(error) {
    if(run) await ledger.finish({runId:run.$id,status:'failed'}).catch(()=>{});
    throw error;
  } finally { await repo?.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
