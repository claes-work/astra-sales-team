import { validateProfile } from './icp.mjs';
import { dateNumber, qualifyLead } from './qualification.mjs';

export function qualificationPlan(profile) {
  return Object.entries(profile.facts).map(([id, fact]) => ({ id, ...fact }));
}

// Anbieter werden injiziert. Keiner dieser Schritte kennt Branchen oder Länder.
// Ohne Research-Adapter werden keine Fakten aus Discovery-Daten abgeleitet.
export async function runPipeline({ profile, discover, collectEvidence = async () => [], enrich, telemetry, asOf = new Date().toISOString().slice(0, 10) }) {
  validateProfile(profile);
  if (!Number.isFinite(dateNumber(asOf))) throw new Error('asOf muss ein gültiges Datum YYYY-MM-DD sein.');
  if (typeof discover !== 'function' || typeof collectEvidence !== 'function' || (enrich !== undefined && typeof enrich !== 'function')) throw new Error('Pipeline-Adapter müssen Funktionen sein.');
  const measure = (input, work, describe) => telemetry ? telemetry.measure(input, work, describe) : work();
  const key = candidate => telemetry?.candidateKey(candidate) ?? candidate.id;
  const candidates = await measure({ phase: 'search' }, () => discover({ profile }), rows => ({ candidateKeys: rows.map(key) }));
  if (!Array.isArray(candidates) || candidates.some(c => !c || typeof c.id !== 'string' || !c.id.trim()) || new Set(candidates.map(c => c.id)).size !== candidates.length) throw new Error('Discovery muss Leads mit eindeutigen IDs liefern.');
  const results = [];
  for (const candidate of candidates) {
    let evidence;
    let qualification;
    try {
      evidence = await measure({ phase: 'evidence', candidateKey: key(candidate) }, () => collectEvidence({ candidate, profile, researchPlan: qualificationPlan(profile) }), rows => ({ evidenceCount: rows.length, sourceUrls: [...new Set(rows.map(e => e.source?.url).filter(Boolean))] }));
      qualification = await measure({ phase: 'qualification', candidateKey: key(candidate) }, async () => qualifyLead({ profile, lead: candidate, evidence, asOf }), decision => ({ outcome: decision.status, reason: decision.gradeReason, decision }));
    } catch (error) {
      if(error.telemetryFailure)throw error;
      // Fremde Adapterfehler können API-Schlüssel enthalten. Niemals ungefiltert ausgeben.
      results.push({ leadId: candidate.id, qualification: null, enrichment: { status: 'skipped', reason: 'qualification_failed' } });
      continue;
    }
    let enrichment = { status: 'skipped', reason: 'not_eligible' };
    if (qualification.eligibleForEnrichment) {
      if (!enrich) enrichment = { status: 'pending', tasks: profile.enrichment.tasks };
      else {
        try {
          const data = await measure({ phase: 'enrichment', candidateKey: key(candidate) }, async () => {
            const value = await enrich({ candidate, profile, qualification, tasks: profile.enrichment.tasks });
            if (value === undefined) throw new Error('Enrichment lieferte kein Ergebnis.');
            return value;
          }, value => ({ kind: value.kind ?? 'adapter_result', newExternalResearch: typeof value.newExternalResearch==='boolean'?value.newExternalResearch:null, qualificationStatus: qualification.status }));
          if (data === undefined) throw new Error('Enrichment lieferte kein Ergebnis.');
          enrichment = { status: 'completed', data };
        } catch (error) { if(error.telemetryFailure)throw error; enrichment = { status: 'failed', reason: 'enrichment_failed' }; }
      }
    }
    results.push({ leadId: candidate.id, qualification, enrichment });
  }
  return results;
}

// Konkreter Offline-Adapter: konsolidiert vorhandene Belege für qualifizierte Leads.
// Er behauptet ausdrücklich keine neue externe Deep Research.
export async function buildEvidenceDossier({ candidate, profile, qualification, tasks }) {
  if (!qualification.eligibleForEnrichment) throw new Error('Enrichment benötigt einen qualifizierten Lead.');
  const hook = qualification.bestHook;
  return {
    kind: 'evidence_dossier', leadId: candidate.id, newExternalResearch: false,
    verifiedFacts: Object.entries(qualification.factFindings).filter(([, fact]) => fact.state === 'known').map(([id, fact]) => ({
      id, label: profile.facts[id].label, value: fact.value,
      sources: fact.evidenceIndexes.map(index => qualification.evidence[index]),
    })),
    hook: hook ? {
      ...hook, label: profile.signals.find(signal => signal.id === hook.signalId).label,
      hint: profile.signals.find(signal => signal.id === hook.signalId).outreachHint ?? null,
      sources: hook.evidenceIndexes.map(index => qualification.evidence[index]),
    } : null,
    nextResearchTasks: tasks,
    outreach: profile.outreach ?? null,
  };
}
