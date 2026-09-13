// Shared storage model only. Target groups, signals and scoring live in ICP files.
const varchar = (key, size = 255, required = true) => ({ key, type: 'varchar', size, required });
const text = (key, required = true) => ({ key, type: 'mediumtext', required });
const bool = (key, required = true) => ({ key, type: 'boolean', required });
const date = (key, required = true) => ({ key, type: 'datetime', required });
const enumeration = (key, elements, required = true) => ({ key, type: 'enum', elements, required });
const ref = key => varchar(key, 36);
const index = (key, attributes, type = 'key') => ({ key, type, attributes });
const table = (id, name, columns, indexes = [], references = {}, immutable = false) => ({
  id, name, columns, indexes, references, immutable,
});

export const salesSchema = {
  schemaVersion: 1,
  databaseId: 'lead-research',
  databaseName: 'Lead-Recherche',
  tables: [
    table('clients', 'Auftraggeber', [
      varchar('name'), enumeration('status', ['active', 'archived']), text('notes', false),
    ]),
    table('icp_profiles', 'ICP-Profile', [
      ref('client_id'), varchar('profile_key', 100), varchar('name', 512), varchar('source_path', 1024),
    ], [index('client_profile', ['client_id', 'profile_key'], 'unique')], { client_id: 'clients' }),
    table('icp_versions', 'ICP-Versionen', [
      ref('client_id'), ref('profile_id'), varchar('version_label', 100), varchar('content_hash', 64),
      text('definition_json'), text('source_yaml'), text('readable_markdown'),
    ], [index('profile_content', ['profile_id', 'content_hash'], 'unique')], { client_id: 'clients', profile_id: 'icp_profiles' }, true),
    table('campaigns', 'Kampagnen', [
      ref('client_id'), varchar('name'), ref('active_icp_version_id'),
      enumeration('status', ['active', 'paused', 'completed', 'archived']), text('notes', false),
    ], [index('client_status', ['client_id', 'status'])], { client_id: 'clients', active_icp_version_id: 'icp_versions' }),
    table('research_runs', 'Recherchen', [
      ref('client_id'), ref('campaign_id'), ref('icp_version_id'), varchar('run_key', 100),
      date('as_of'), varchar('payload_hash', 64), varchar('engine_hash', 64), text('metadata_json'),
    ], [index('campaign_run', ['campaign_id', 'run_key'], 'unique')], { client_id: 'clients', campaign_id: 'campaigns', icp_version_id: 'icp_versions' }, true),
    table('companies', 'Unternehmen', [
      ref('client_id'), varchar('identity_key', 300), varchar('name', 512), varchar('domain', 253),
      varchar('website', 2048), varchar('place_id', 255, false), bool('do_not_contact'), text('notes', false),
    ], [index('client_identity', ['client_id', 'identity_key'], 'unique'), index('client_domain', ['client_id', 'domain'])], { client_id: 'clients' }),
    table('assessments', 'Lead-Bewertungen', [
      ref('client_id'), ref('run_id'), ref('company_id'), ref('icp_version_id'), varchar('source_lead_id', 100),
      enumeration('status', ['qualified', 'needs_review', 'excluded', 'not_qualified']),
      varchar('grade', 32, false), bool('eligible_for_enrichment'), text('reason'), text('decision_json'), text('company_snapshot_json'),
    ], [index('run_company', ['run_id', 'company_id'], 'unique'), index('run_status', ['run_id', 'status']), index('company_history', ['company_id'])],
    { client_id: 'clients', run_id: 'research_runs', company_id: 'companies', icp_version_id: 'icp_versions' }, true),
    table('evidence', 'Recherche-Belege', [
      ref('client_id'), ref('assessment_id'), { key: 'evidence_index', type: 'integer', required: true, min: 0 },
      varchar('fact_key', 100), text('value_json'), enumeration('confidence', ['confirmed', 'inferred']),
      date('observed_at'), date('event_date', false), varchar('source_type', 100), varchar('source_url', 8192), text('source_quote'),
    ], [index('assessment_position', ['assessment_id', 'evidence_index'], 'unique'), index('assessment_fact', ['assessment_id', 'fact_key'])],
    { client_id: 'clients', assessment_id: 'assessments' }, true),
    table('enrichments', 'Anreicherungen', [
      ref('client_id'), ref('assessment_id'), enumeration('status', ['pending', 'completed', 'skipped', 'failed']),
      text('tasks_json'), text('result_json', false), text('error_note', false),
    ], [index('assessment', ['assessment_id'], 'unique'), index('client_status', ['client_id', 'status'])],
    { client_id: 'clients', assessment_id: 'assessments' }),
    table('contacts', 'Ansprechpartner', [
      ref('client_id'), ref('company_id'), ref('source_enrichment_id'), varchar('name', 512), varchar('role', 1024, false),
      varchar('email', 320, false), varchar('email_type', 512, false), varchar('phone', 100, false),
      varchar('source_url', 8192), date('checked_at'), text('source_json'), bool('do_not_contact'),
    ], [index('company_contacts', ['company_id']), index('client_email', ['client_id', 'email'])],
    { client_id: 'clients', company_id: 'companies', source_enrichment_id: 'enrichments' }),
    table('outreach_messages', 'Outreach-Nachrichten', [
      ref('client_id'), ref('campaign_id'), ref('company_id'), ref('contact_id'), ref('assessment_id'),
      varchar('channel', 40), varchar('sequence_step', 100), varchar('dedupe_key', 64), varchar('target_address', 1024),
      enumeration('status', ['draft', 'approved', 'sending', 'sent', 'failed', 'cancelled']),
      varchar('subject', 1024, false), text('body'), date('approved_at', false), varchar('approved_by', 255, false),
      date('sent_at', false), varchar('provider_message_id', 255, false),
    ], [index('dedupe', ['dedupe_key'], 'unique'), index('campaign_status', ['campaign_id', 'status']), index('contact', ['contact_id'])],
    { client_id: 'clients', campaign_id: 'campaigns', company_id: 'companies', contact_id: 'contacts', assessment_id: 'assessments' }),
    table('outreach_events', 'Outreach-Verlauf', [
      ref('client_id'), ref('message_id'), varchar('event_key', 64), varchar('event_type', 100), date('occurred_at'), text('details_json', false),
    ], [index('event_dedupe', ['event_key'], 'unique'), index('message_time', ['message_id', 'occurred_at'])],
    { client_id: 'clients', message_id: 'outreach_messages' }, true),
  ],
};
