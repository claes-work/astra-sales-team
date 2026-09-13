// Additive integration tables. Existing recipient/contact rows are never changed.
const str = (key, size = 255) => ({ key, type: 'varchar', size, required: true });
const date = key => ({ key, type: 'datetime', required: true });
const idx = (key, attributes, type = 'key') => ({ key, attributes, type });
export const websiteQuizTables = [
  { id: 'website_quiz_submissions', name: 'Zugeordnete Website-Quiz-Abschlüsse', columns: [
    str('client_id', 36), str('company_id', 36), str('message_id', 36), str('source', 80),
    str('source_event_id', 36), str('source_submission_id', 36), str('payload_hash', 64),
    { key: 'is_test', type: 'boolean', required: true }, date('occurred_at'), date('recorded_at'),
    { key: 'payload_json', type: 'mediumtext', required: true },
  ], indexes: [idx('source_event', ['source', 'source_event_id'], 'unique'),
    idx('source_submission', ['source', 'source_submission_id'], 'unique'), idx('message_time', ['message_id', 'occurred_at'])] },
  { id: 'outreach_test_messages', name: 'Explizite nicht sendende Integrationstests', columns: [
    str('client_id', 36), str('company_id', 36),
    { key: 'purpose', type: 'enum', elements: ['website_quiz_e2e'], required: true }, date('created_at'),
  ], indexes: [idx('company', ['company_id'])] },
];
