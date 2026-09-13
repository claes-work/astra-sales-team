import { OutreachService } from '../../src/outreach/service.mjs';
import { loadContentFile, reviewContentHash } from '../../src/outreach/profiles.mjs';
import { DemoProvider, demoEnv } from '../../src/outreach/demo.mjs';
import { DEMO_DB } from '../../src/outreach/appwrite.mjs';
import { defaultControls } from '../../infra/appwrite/outreach-schema.mjs';

export class MemoryRepo {
  constructor() { this.database = DEMO_DB; this.rows = new Map(); }
  async list(table) { return [...this.rows].filter(([key]) => key.startsWith(table + '/')).map(([, v]) => structuredClone(v)); }
  async get(table, id) { return structuredClone(this.rows.get(table + '/' + id) ?? null); }
  async create(table, id, data) { if (this.rows.has(table + '/' + id)) throw new Error('Duplicate'); const r = { ...structuredClone(data), $id: id }; this.rows.set(table + '/' + id, r); return structuredClone(r); }
  async update(table, id, data) { const r = await this.get(table, id); if (!r) throw new Error('Missing'); this.rows.set(table + '/' + id, { ...r, ...structuredClone(data) }); return this.get(table, id); }
  async transaction(ops) { const before = structuredClone(this.rows); try { for (const op of ops) await this[op.action](op.table, op.id, op.data); } catch (e) { this.rows = before; throw e; } }
}
export async function contentFixture() {
  const repo = new MemoryRepo(); const provider = new DemoProvider(); let now = new Date('2026-09-12T10:00:00Z');
  const service = new OutreachService({ repo, provider, env: demoEnv, now: () => now, lock: work => work() });
  await repo.create('clients', 'own', { name: 'Test' });
  await repo.create('campaigns', 'camp', { client_id: 'own', active_icp_version_id: 'icp', status: 'active' });
  await repo.create('research_runs', 'run', { client_id: 'own', campaign_id: 'camp' });
  await repo.create('outreach_controls', 'default', { ...defaultControls, paused: false, min_interval_seconds: 0, weekdays_only: false });
  const strategy = await loadContentFile('outreach/strategies/consulting-gespraech.yaml'); strategy.readiness = 'ready';
  const experiment = await loadContentFile('outreach/experiments/geschaeftsthema-gegen-frage.yaml');
  const publish = async (kind, definition) => {
    const current = (await service.listContent({ clientId: 'own', kind })).find(d => d.key === definition.key);
    const draft = await service.saveDraft({ clientId: 'own', kind, definition, ...(current ? { expectedHash: current.contentHash } : {}) });
    return service.publishDraft({ draftId: draft.id, expectedHash: draft.contentHash });
  };
  await publish('strategy', strategy); const version = await publish('experiment', experiment);
  const applied = await service.applyExperimentVersion({ clientId: 'own', campaignId: 'camp', versionId: version.id });
  const personalizations = [];
  for (let i = 1; i <= 2; i++) {
    await repo.create('companies', 'co' + i, { client_id: 'own', name: 'Fiktive Firma ' + i, do_not_contact: false });
    await repo.create('assessments', 'as' + i, { client_id: 'own', company_id: 'co' + i, run_id: 'run', icp_version_id: 'icp', status: 'qualified', eligible_for_enrichment: true });
    await repo.create('contacts', 'ct' + i, { client_id: 'own', company_id: 'co' + i, name: 'Testperson ' + i, email: `test${i}@example.invalid`, do_not_contact: false });
    await repo.create('enrichments', 'en' + i, { client_id: 'own', assessment_id: 'as' + i, status: 'completed' });
    await repo.create('evidence', 'ev' + i, { client_id: 'own', assessment_id: 'as' + i, confidence: 'confirmed', observed_at: '2026-09-10T08:00:00Z',
      fact_key: 'service', value_json: '"Prozessberatung"', source_url: 'https://example.invalid/research', source_quote: 'Fiktives Beispiel zur Softwareprüfung.', source_type: 'website' });
    const p = await loadContentFile('outreach/personalizations/fictional-process-consulting.yaml');
    p.key = 'test-' + i; p.assessmentId = 'as' + i; p.contactId = 'ct' + i; p.recipientName = 'Testperson ' + i;
    p.salutation = 'Guten Tag Testperson ' + i + ','; p.recipientSourceUrl = 'https://example.invalid/team'; p.checkedAt = '2026-09-10T16:00:00Z';
    p.observation = { text: 'Fiktive Beobachtung ' + i, evidenceIds: ['ev' + i] };
    p.body = p.salutation + '\n\n' + (i === 1 ? 'Ein eigens formulierter erster Aufbau.' : 'Ein anderer Aufbau mit eigener Formulierung und Reihenfolge.') + '\n\n' + p.action.text;
    p.subjects = { a: 'Beispiel ' + i, b: 'Frage zu Beispiel ' + i + '?' };
    p.authorship = { author: 'Fiktiver Testautor', methodVersion: 'test-v1', model: null };
    p.review = { status: 'approved', by: 'Simulierter Prüfer', checkedAt: '2026-09-11T10:00:00Z', checks: strategy.humanChecks.map(c => c.id), note: 'Softwaretest, keine echte Freigabe.', approvedContentHash: reviewContentHash(p) };
    personalizations.push(p);
  }
  async function enroll(i = 0) {
    const p = personalizations[i]; const frozen = await publish('personalization', p);
    const enrollment = await service.enroll({ experimentId: applied.$id, assessmentId: p.assessmentId, contactId: p.contactId, personalizationVersionId: frozen.id });
    return { frozen, enrollment, preview: await service.preview(enrollment.message_id) };
  }
  async function send(i = 0) {
    const result = await enroll(i); const id = result.enrollment.message_id;
    await service.permission({ clientId: 'own', contactId: personalizations[i].contactId, status: 'verified', basis: 'internal_test', providerAllowed: true, evidence: 'Fiktiver Test', checkedBy: 'Test' });
    await service.approve({ messageId: id, contentHash: result.preview.contentHash, approvedBy: 'Test' });
    await service.experimentStatus({ experimentId: applied.$id, status: 'active' });
    await service.sendOne({ messageId: id, execute: true });
    return id;
  }
  return { repo, provider, service, strategy, experiment, version, applied, personalizations, publish, enroll, send, time: value => { now = new Date(value); } };
}
