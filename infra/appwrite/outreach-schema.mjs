// Additive extension: existing research tables and ICP profiles stay unchanged.
import { websiteQuizTables } from './website-quiz-schema.mjs';
const str = (key, size = 255, required = true) => ({ key, type: 'varchar', size, required });
const ref = key => str(key, 36);
const text = key => ({ key, type: 'mediumtext', required: true });
const date = key => ({ key, type: 'datetime', required: true });
const bool = key => ({ key, type: 'boolean', required: true });
const num = (key, max) => ({ key, type: 'integer', min: 0, max, required: true });
const choice = (key, elements) => ({ key, type: 'enum', elements, required: true });
const idx = (key, attributes, type = 'key') => ({ key, type, attributes });

export const outreachTables = [
  ...websiteQuizTables,
  { id: 'lead_activities', name: 'Manuelle Lead-Rückmeldungen', columns: [ref('client_id'), ref('company_id'), str('message_id',36,false), str('event_key',64),
    choice('type',['note','conversation_positive','do_not_contact']), choice('channel',['phone','email','other']), date('occurred_at'), date('recorded_at'), text('details_json')],
    indexes:[idx('event_key',['event_key'],'unique'),idx('company_time',['company_id','occurred_at'])] },
  { id: 'pipeline_runs', name: 'Gemessene Pipeline-Läufe', columns: [ref('client_id'), str('run_key', 100), str('kind', 100), date('started_at'),
    { ...date('finished_at'), required: false }, choice('status', ['running', 'completed', 'failed', 'cancelled']), text('context_json')],
    indexes: [idx('client_run', ['client_id', 'run_key'], 'unique'), idx('started', ['started_at'])] },
  { id: 'pipeline_steps', name: 'Pipeline-Schritte und Versuche', columns: [ref('client_id'), ref('run_id'), str('step_key', 150), str('phase', 50),
    str('candidate_key', 512, false), date('started_at'), { ...date('finished_at'), required: false },
    choice('status', ['running', 'completed', 'failed', 'skipped']), text('details_json')],
    indexes: [idx('run_step', ['run_id', 'step_key'], 'unique'), idx('started', ['started_at'])] },
  { id: 'outreach_ramp', name: 'Kontrollierter Versandaufbau', columns: [text('policy_json'), text('state_json'), str('revision', 64), date('updated_at')], indexes: [] },
  { id: 'outreach_ramp_events', name: 'Entscheidungen zum Versandaufbau', columns: [str('revision', 64), str('action', 50), date('occurred_at'), text('details_json')], indexes: [idx('revision', ['revision'], 'unique')] },
  { id: 'outreach_drafts', name: 'Bearbeitbare Outreach-Entwürfe', columns: [ref('client_id'), choice('kind', ['strategy', 'experiment', 'personalization']),
    str('profile_key', 80), str('version_label', 40), str('name', 512), str('content_hash', 64), text('definition_json'), date('updated_at')],
    indexes: [idx('client_kind_key', ['client_id', 'kind', 'profile_key'], 'unique')] },
  { id: 'outreach_versions', name: 'Eingefrorene Outreach-Versionen', columns: [ref('client_id'), choice('kind', ['strategy', 'experiment', 'personalization']),
    str('profile_key', 80), str('version_label', 40), str('name', 512), str('content_hash', 64), text('definition_json'), text('dependencies_json'), date('created_at')],
    indexes: [idx('client_kind_version', ['client_id', 'kind', 'profile_key', 'version_label'], 'unique')] },
  { id: 'outreach_experiments', name: 'Outreach-Experimente', columns: [ref('client_id'), ref('campaign_id'), str('name', 512), str('definition_hash', 64), text('definition_json'),
    choice('status', ['draft', 'active', 'paused', 'completed'])], indexes: [idx('campaign', ['campaign_id'])] },
  { id: 'outreach_enrollments', name: 'Experiment-Teilnahmen', columns: [ref('client_id'), ref('experiment_id'), ref('company_id'), ref('contact_id'), ref('assessment_id'), ref('message_id'),
    str('variant_id', 50), str('content_hash', 64), text('snapshot_json')], indexes: [idx('experiment_company', ['experiment_id', 'company_id'], 'unique'), idx('message', ['message_id'], 'unique')] },
  { id: 'outreach_permissions', name: 'Kontaktfreigaben', columns: [ref('client_id'), ref('contact_id'), choice('status', ['unknown', 'verified', 'revoked']),
    choice('basis', ['unknown', 'consent', 'existing_customer', 'internal_test']), bool('provider_allowed'), text('evidence'), str('checked_by'), date('checked_at')],
    indexes: [idx('client_contact', ['client_id', 'contact_id'], 'unique')] },
  { id: 'outreach_controls', name: 'Versandsteuerung', columns: [bool('paused'), num('daily_limit', 100), num('min_interval_seconds', 86400), str('timezone', 100),
    num('start_hour', 23), num('end_hour', 24), bool('weekdays_only')], indexes: [] },
  { id: 'outreach_attempts', name: 'Versandversuche', columns: [ref('client_id'), ref('message_id'), str('day_key', 10), date('attempted_at'),
    choice('status', ['reserved', 'accepted', 'rejected', 'unknown']), str('provider_message_id', 255, false), text('details_json')],
    indexes: [idx('message', ['message_id'], 'unique'), idx('day', ['day_key'])] },
  { id: 'outreach_suppressions', name: 'Versandsperren', columns: [ref('client_id'), str('email', 320), str('reason', 100), date('created_at'), str('source', 512)],
    indexes: [idx('client_email', ['client_id', 'email'], 'unique')] },
  { id: 'outreach_sync_state', name: 'Abgleich-Stand', columns: [str('provider'), text('state_json'), date('updated_at')], indexes: [] },
];

export const defaultControls = { paused: true, daily_limit: 10, min_interval_seconds: 180, timezone: 'Europe/Berlin', start_hour: 9, end_hour: 17, weekdays_only: true };
