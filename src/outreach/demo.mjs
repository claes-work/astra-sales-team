import { loadExperiment } from './experiment.mjs';
import { DEMO_DB } from './appwrite.mjs';
import { provision } from './provision.mjs';
import { OutreachService } from './service.mjs';
import { fileURLToPath } from 'node:url';

export const demoEnv = { OUTREACH_SENDER_EMAIL: 'demo@example.invalid', OUTREACH_SENDER_NAME: 'Interner Softwaretest', OUTREACH_REPLY_TO_EMAIL: 'reply@example.invalid' };
export class DemoProvider {
  constructor() { this.name = 'demo'; this.sent = []; }
  async send(message, attemptId) { this.sent.push({ message, attemptId }); return { messageId: `<${attemptId}@demo.invalid>` }; }
  async events() { return []; }
}

export async function runDemo(repo) {
  if (repo.database !== DEMO_DB) throw new Error('Demo nur in isolierter Demo-Datenbank.');
  await provision(repo);
  const existing = await repo.get('clients', 'demo');
  if (!existing) {
    const rows = [
      ['clients', 'demo', { name: 'Fiktive Software-Demo', status: 'active', notes: 'Keine echten Firmen oder Versandadressen.' }],
      ['icp_profiles', 'demo_profile', { client_id: 'demo', profile_key: 'software-demo', name: 'Fiktives Testprofil', source_path: 'examples' }],
      ['icp_versions', 'demo_version', { client_id: 'demo', profile_id: 'demo_profile', version_label: '1', content_hash: '0'.repeat(64), definition_json: '{}', source_yaml: '# Test', readable_markdown: 'Fiktiver Test' }],
      ['campaigns', 'demo_campaign', { client_id: 'demo', name: 'Softwareprüfung ohne E-Mail-Versand', active_icp_version_id: 'demo_version', status: 'active' }],
      ['research_runs', 'demo_run', { client_id: 'demo', campaign_id: 'demo_campaign', icp_version_id: 'demo_version', run_key: 'demo', as_of: '2026-09-10T00:00:00Z', payload_hash: '0'.repeat(64), engine_hash: '0'.repeat(64), metadata_json: '{}' }],
    ];
    for (let i = 1; i <= 4; i++) {
      rows.push(['companies', `demo_company_${i}`, { client_id: 'demo', identity_key: `demo-${i}.invalid`, name: `Beispielfirma ${i}`, domain: `demo-${i}.invalid`, website: `https://demo-${i}.invalid`, do_not_contact: false }]);
      rows.push(['assessments', `demo_assessment_${i}`, { client_id: 'demo', run_id: 'demo_run', company_id: `demo_company_${i}`, icp_version_id: 'demo_version', source_lead_id: `demo-${i}`, status: 'qualified', grade: 'B', eligible_for_enrichment: true, reason: 'Fiktive Testfreigabe', decision_json: '{}', company_snapshot_json: '{}' }]);
      rows.push(['enrichments', `demo_enrichment_${i}`, { client_id: 'demo', assessment_id: `demo_assessment_${i}`, status: 'completed', tasks_json: '[]', result_json: '{}' }]);
      rows.push(['contacts', `demo_contact_${i}`, { client_id: 'demo', company_id: `demo_company_${i}`, source_enrichment_id: `demo_enrichment_${i}`, name: `Testkontakt ${i}`, email: `test${i}@example.invalid`, source_url: 'https://example.invalid', checked_at: '2026-09-10T00:00:00Z', source_json: '{"fictional":true}', do_not_contact: false }]);
    }
    await repo.transaction(rows.map(([table, id, data]) => ({ action: 'create', table, id, data })));
  }
  const provider = new DemoProvider();
  const service = new OutreachService({ repo, provider, env: demoEnv });
  const definition = await loadExperiment(fileURLToPath(new URL('../../examples/outreach-demo.yaml', import.meta.url)));
  const experiment = await service.createExperiment({ clientId: 'demo', campaignId: 'demo_campaign', definition });
  if (experiment.status === 'completed') await service.experimentStatus({ experimentId: experiment.$id, status: 'active' });
  const enrollments = [];
  for (let i = 1; i <= 4; i++) {
    const enrollment = await service.enroll({ experimentId: experiment.$id, assessmentId: `demo_assessment_${i}`, contactId: `demo_contact_${i}` });
    await service.permission({ clientId: 'demo', contactId: `demo_contact_${i}`, status: 'verified', basis: 'internal_test', providerAllowed: true,
      evidence: 'Isolierter Test ohne Netzwerk-Versand; Adressen unter .invalid.', checkedBy: 'Software-Demo' });
    const preview = await service.preview(enrollment.message_id);
    if (preview.status === 'draft') await service.approve({ messageId: enrollment.message_id, contentHash: preview.contentHash, approvedBy: 'Software-Demo' });
    enrollments.push(enrollment);
  }
  await service.experimentStatus({ experimentId: experiment.$id, status: 'active' });
  const controls = await repo.get('outreach_controls', 'default');
  await service.controls({ paused: false, min_interval_seconds: 0, daily_limit: 10, start_hour: 0, end_hour: 24, weekdays_only: false });
  try {
    for (const enrollment of enrollments) {
      const message = await repo.get('outreach_messages', enrollment.message_id);
      if (message.status === 'approved') await service.sendOne({ messageId: message.$id, execute: true });
    }
    const outcomes = ['reply_positive', 'reply_negative', 'meeting_booked', 'unsubscribed'];
    for (let i = 0; i < enrollments.length; i++) {
      const message = await repo.get('outreach_messages', enrollments[i].message_id);
      await service.recordOutcome({ messageId: message.$id, type: outcomes[i], occurredAt: message.sent_at,
        sourceId: `demo-outcome-${i}`, source: 'Fiktive Software-Demo', note: 'Simuliertes Ergebnis, keine echte Antwort.' });
    }
  } finally {
    await service.controls({ paused: true, min_interval_seconds: controls.min_interval_seconds, daily_limit: controls.daily_limit,
      start_hour: controls.start_hour, end_hour: controls.end_hour, weekdays_only: controls.weekdays_only });
  }
  return { database: DEMO_DB, emailsSentOverNetwork: 0, simulatedThisRun: provider.sent.length, report: await service.report(experiment.$id) };
}
