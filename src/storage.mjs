import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, relative, isAbsolute, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs, isDeepStrictEqual } from 'node:util';
import { loadProfile, profileIdentity } from './icp.mjs';
import { qualifyLead } from './qualification.mjs';
import { loadEvidenceFile } from './leads.mjs';
import { salesSchema } from '../infra/appwrite/schema.mjs';

export const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
export const stableId = (type, ...parts) => `${type}_${hash(parts).slice(0, 30)}`;
const instant = value => {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('Ungültiges Datum in der Recherche.');
  return date.toISOString();
};
const json = value => JSON.stringify(value);
const clean = data => Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined && value !== null));

// A generated reading view, never a second executable source of business rules.
export function profileMarkdown(profile, sourcePath) {
  return `# ${profile.name}\n\nVersion: ${profile.version}\n\n${profile.description ?? ''}\n\n` +
    `Bearbeitbare Quelle: ${sourcePath}\n\nDiese Ansicht wird aus der YAML-Datei erzeugt. Die vollständige Definition steht unten.\n\n` +
    `## Zielgruppe\n\n${profile.target.audience}\n\nRegion: ${profile.target.region.name}\n\n` +
    `## Pflichtkriterien\n\n${profile.qualification.required.map(r => `- ${r.label}`).join('\n')}\n\n` +
    `## Signale\n\n${profile.signals.map(s => `- Priorität ${s.priority}: ${s.label}. ${s.research}`).join('\n')}\n\n` +
    `## Bewertung\n\n${profile.grading.rules.map(r => `- ${r.grade}: ${r.description}`).join('\n')}\n` +
    `- ${profile.grading.fallback}: ${profile.grading.fallbackDescription}\n\n` +
    `## Ausschlüsse und Prüfhinweise\n\n${profile.exclusions.map(e => `- ${e.label} (${e.effect}; unbekannt: ${e.onUnknown})`).join('\n')}\n\n` +
    `## Vollständige maschinenlesbare Definition\n\n\`\`\`json\n${JSON.stringify(profile, null, 2)}\n\`\`\`\n`;
}

export function buildStorageBundle({ profile, profileSource, profilePath, leads, evaluation, client, campaign, runKey, engineHash }) {
  const identity = profileIdentity(profile);
  if (!isDeepStrictEqual(evaluation.profile, identity)) throw new Error('Recherche und ICP-Version passen nicht zusammen.');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,35}$/.test(client.id) || !campaign.id || !runKey) throw new Error('Auftraggeber, Kampagne und Recherchekennung fehlen oder sind ungültig.');
  if (isAbsolute(profilePath) || profilePath.split(/[\\/]/).includes('..')) throw new Error('ICP-Pfad muss relativ zum Projekt sein.');
  if (new Set(leads.map(l => l.id)).size !== leads.length || new Set(evaluation.results.map(r => r.leadId)).size !== evaluation.results.length || evaluation.results.length !== leads.length) throw new Error('Recherche enthält doppelte oder fehlende Lead-Ergebnisse.');
  const rows = [];
  const add = (table, id, data) => {
    if (rows.some(r => r.table === table && r.id === id)) throw new Error(`Doppelter Datensatz: ${table}. Firmenidentität prüfen.`);
    rows.push({ table, id, data: clean(data) });
    return id;
  };
  const clientId = client.id;
  add('clients', clientId, { name: client.name, status: 'active' });
  const profileId = add('icp_profiles', stableId('icp', clientId, identity.id), {
    client_id: clientId, profile_key: identity.id, name: profile.name, source_path: profilePath,
  });
  const versionId = add('icp_versions', stableId('ver', profileId, identity.sha256), {
    client_id: clientId, profile_id: profileId, version_label: identity.version, content_hash: identity.sha256,
    definition_json: json(profile), source_yaml: profileSource, readable_markdown: profileMarkdown(profile, profilePath),
  });
  const campaignId = add('campaigns', stableId('cam', clientId, campaign.id), {
    client_id: clientId, name: campaign.name, active_icp_version_id: versionId, status: 'active',
  });
  const { results, ...metadata } = evaluation;
  const runId = add('research_runs', stableId('run', campaignId, runKey), {
    client_id: clientId, campaign_id: campaignId, icp_version_id: versionId, run_key: runKey,
    as_of: instant(evaluation.asOf), payload_hash: hash({ leads, evaluation, engineHash }), engine_hash: engineHash, metadata_json: json(metadata),
  });
  for (const lead of leads) {
    const result = results.find(r => r.leadId === lead.id);
    if (!result) throw new Error('Rechercheergebnis fehlt.');
    const expected = qualifyLead({ profile, lead, evidence: lead.evidence, asOf: evaluation.asOf });
    const { evidence: ignored, ...decision } = expected;
    const { evidence: suppliedEvidence, ...suppliedDecision } = result.qualification;
    if (!isDeepStrictEqual(suppliedDecision, decision) || (suppliedEvidence && !isDeepStrictEqual(suppliedEvidence, lead.evidence))) throw new Error(`Bewertung für ${lead.id} ist nicht reproduzierbar.`);
    // This import accepts independent public-source research, never raw Places candidate payloads.
    if (!lead.name || !lead.website || lead.evidence.some(e => /google|places/i.test(e.source.type))) throw new Error('Firmenstammdaten und unabhängige Belege sind erforderlich.');
    const site = new URL(lead.website);
    if (!['https:', 'http:'].includes(site.protocol)) throw new Error('Website muss HTTP oder HTTPS verwenden.');
    const domain = site.hostname.toLowerCase().replace(/^www\./, '');
    const companyId = add('companies', stableId('co', clientId, domain), {
      client_id: clientId, identity_key: `domain:${domain}`, name: lead.name, domain, website: lead.website, do_not_contact: false,
    });
    const assessmentId = add('assessments', stableId('qa', runId, companyId), {
      client_id: clientId, run_id: runId, company_id: companyId, icp_version_id: versionId, source_lead_id: lead.id,
      status: expected.status, grade: expected.grade, eligible_for_enrichment: expected.eligibleForEnrichment,
      reason: expected.gradeReason ?? expected.status, decision_json: json(decision), company_snapshot_json: json({ id: lead.id, name: lead.name, website: lead.website }),
    });
    lead.evidence.forEach((e, i) => add('evidence', stableId('ev', assessmentId, i), {
      client_id: clientId, assessment_id: assessmentId, evidence_index: i, fact_key: e.fact, value_json: json(e.value),
      confidence: e.confidence, observed_at: instant(e.observedAt), event_date: e.eventDate ? instant(e.eventDate) : undefined,
      source_type: e.source.type, source_url: e.source.url, source_quote: e.source.quote,
    }));
    const enrichment = result.enrichment;
    if (!enrichment || !['pending', 'completed', 'skipped', 'failed'].includes(enrichment.status)) throw new Error('Ungültiger Anreicherungsstatus.');
    if (!expected.eligibleForEnrichment && (enrichment.status !== 'skipped' || enrichment.data)) throw new Error('Anreicherung für diesen Lead ist vom ICP nicht freigegeben.');
    if (enrichment.status === 'completed' && !enrichment.data) throw new Error('Abgeschlossene Anreicherung ohne Ergebnis.');
    const enrichmentId = add('enrichments', stableId('en', assessmentId), {
      client_id: clientId, assessment_id: assessmentId, status: enrichment.status, tasks_json: json(profile.enrichment.tasks),
      result_json: enrichment.data ? json(enrichment.data) : undefined, error_note: enrichment.error,
    });
    const contact = enrichment.status === 'completed' ? enrichment.data?.contact : undefined;
    if (contact) {
      if (!contact.name || !contact.source || !contact.checkedAt) throw new Error('Ansprechpartner benötigen Namen, Quelle und Prüfdatum.');
      add('contacts', stableId('ct', companyId, contact.name, contact.email?.toLowerCase() ?? ''), {
        client_id: clientId, company_id: companyId, source_enrichment_id: enrichmentId,
        name: contact.name, role: contact.role, email: contact.email, email_type: contact.emailType, phone: contact.phone,
        source_url: contact.source, checked_at: instant(contact.checkedAt), source_json: json(contact), do_not_contact: false,
      });
    }
  }
  return { formatVersion: 1, endpoint: 'http://127.0.0.1:8088/v1', projectId: 'lead-research', schema: salesSchema, rows };
}

async function main() {
  const { values } = parseArgs({ options: Object.fromEntries(['icp', 'evidence', 'evaluation', 'client-id', 'client-name', 'campaign-id', 'campaign-name', 'run-id', 'output'].map(key => [key, { type: 'string' }])) });
  for (const key of ['icp', 'evidence', 'evaluation', 'client-id', 'client-name', 'campaign-id', 'campaign-name', 'run-id']) if (!values[key]) throw new Error(`Argument --${key} fehlt.`);
  const root = fileURLToPath(new URL('../', import.meta.url));
  const profileFile = resolve(values.icp);
  const profile = await loadProfile(profileFile);
  const leads = await loadEvidenceFile(resolve(values.evidence), profile);
  const engineFiles = ['src/icp.mjs', 'src/qualification.mjs', 'src/pipeline.mjs', 'icp/schema.json', 'package-lock.json'];
  const engineHash = hash(await Promise.all(engineFiles.map(path => readFile(resolve(root, path), 'utf8'))));
  const bundle = buildStorageBundle({ profile, profileSource: await readFile(profileFile, 'utf8'), profilePath: relative(root, profileFile).replaceAll('\\', '/'),
    leads, evaluation: JSON.parse(await readFile(resolve(values.evaluation), 'utf8')), engineHash,
    client: { id: values['client-id'], name: values['client-name'] }, campaign: { id: values['campaign-id'], name: values['campaign-name'] }, runKey: values['run-id'],
  });
  const output = resolve(values.output ?? '.local/appwrite/import-bundle.json');
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(bundle, null, 2) + '\n');
  await writeFile(resolve(root, 'icp', `${profile.id}.md`), profileMarkdown(profile, bundle.rows.find(r => r.table === 'icp_profiles').data.source_path));
  console.log(JSON.stringify({ prepared: true, output, tables: bundle.schema.tables.length, rows: bundle.rows.length }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
