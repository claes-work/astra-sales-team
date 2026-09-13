import Ajv from 'ajv';
import { timingSafeEqual } from 'node:crypto';
import { contentHash } from '../outreach/profiles.mjs';
import { identity } from '../outreach/experiment.mjs';
import { query } from '../outreach/appwrite.mjs';

export const WEBSITE_QUIZ_SOURCE = 'sales-website';
export const WEBSITE_QUIZ_PATH = '/v1/integrations/website/quiz-completions';
const uuid = { type: 'string', pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' };
const timestamp = { type: 'string', maxLength: 40, pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,3})?(?:Z|[+-]\\d{2}:\\d{2})$' };
const line = maxLength => ({ type: 'string', minLength: 1, maxLength, pattern: '^[^\\x00-\\x1f\\x7f]+$' });
const object = properties => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });
export const websiteQuizSchema = object({
  schema_version: { const: 1 }, event_type: { const: 'quiz_completed' }, event_id: uuid, source_submission_id: uuid,
  occurred_at: timestamp, outreach_id: { anyOf: [{ type: 'string', pattern: '^msg_[a-f0-9]{28}$' }, { type: 'null' }] },
  is_test: { type: 'boolean' },
  contact: object({ first_name: line(200), last_name: line(200),
    email: { ...line(320), pattern: '^[^\\x00-\\x1f\\x7f\\s@<>]+@[^\\x00-\\x1f\\x7f\\s@<>]+\\.[^\\x00-\\x1f\\x7f\\s@<>]+$' }, company: line(512),
    phone: { anyOf: [line(100), { type: 'null' }] }, provenance: { const: 'quiz_form' },
    captured_at: timestamp, source_submission_id: uuid }),
  result: object({ quiz_id: { const: 'sales-roadmap' }, quiz_version: line(80), stage: { type: 'integer', minimum: 0, maximum: 6 } }),
});
const validate = new Ajv({ allErrors: true }).compile(websiteQuizSchema);
const parse = value => { try { return JSON.parse(value); } catch { return null; } };
const testEmail = value => typeof value === 'string' && /^[^\s@]+@example\.invalid$/i.test(value);
const table = 'website_quiz_submissions';
const rowId = eventId => identity('wqc', WEBSITE_QUIZ_SOURCE, eventId);
const eventKey = eventId => contentHash([WEBSITE_QUIZ_SOURCE, 'quiz_completed', eventId]);
const eventRowId = eventId => identity('evt', eventKey(eventId));
const eventDetails = payload => ({ source: WEBSITE_QUIZ_SOURCE, website_quiz: { event_id: payload.event_id,
  source_submission_id: payload.source_submission_id, is_test: payload.is_test, contact: payload.contact, result: payload.result } });
function validTimestamp(value) {
  const m=typeof value==='string'&&value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-](\d{2}):(\d{2}))$/);
  if(!m||!Number.isFinite(Date.parse(value)))return false;
  const [year,month,day,hour,minute,second,offsetHour=0,offsetMinute=0]=m.slice(1).map(Number);
  const calendar=new Date(Date.UTC(year,month-1,day));
  return year>=2000&&calendar.getUTCFullYear()===year&&calendar.getUTCMonth()===month-1&&calendar.getUTCDate()===day
    &&hour<24&&minute<60&&second<60&&(!m[7]||offsetHour<24)&&(!m[8]||offsetMinute<60);
}

export class QuizIngestError extends Error {
  constructor(statusCode, code) { super(code); this.statusCode = statusCode; this.code = code; }
}
export function quizIntegrationConfigured(env) {
  return typeof env?.WEBSITE_QUIZ_BEARER_TOKEN === 'string' && env.WEBSITE_QUIZ_BEARER_TOKEN.length >= 32
    && typeof env.WEBSITE_QUIZ_CLIENT_ID === 'string' && /^[\w-]{1,36}$/.test(env.WEBSITE_QUIZ_CLIENT_ID);
}
export function quizAuthorized(header, env) {
  if (!quizIntegrationConfigured(env)) return false;
  const got = Buffer.from(header ?? ''), expected = Buffer.from(`Bearer ${env.WEBSITE_QUIZ_BEARER_TOKEN}`);
  return got.length === expected.length && timingSafeEqual(got, expected);
}
export function validateQuizPayload(input, now) {
  if (!validate(input) || input.contact.source_submission_id !== input.source_submission_id
    || !validTimestamp(input.occurred_at) || !validTimestamp(input.contact.captured_at)
    || Date.parse(input.occurred_at) !== Date.parse(input.contact.captured_at)
    || Date.parse(input.occurred_at) > now.getTime() + 300000
    || [input.contact.first_name, input.contact.last_name, input.contact.company, input.result.quiz_version].some(x => !x.trim())) {
    // Do not echo submitted PII, secrets or parser details into responses/logs.
    throw new QuizIngestError(400, 'invalid_payload');
  }
  return structuredClone(input);
}

export class WebsiteQuizIngest {
  constructor({ repo, env, now = () => new Date(), lock = work => work() }) { Object.assign(this, { repo, env, now, lock }); }
  async ingest(input) {
    if (!quizIntegrationConfigured(this.env)) throw new QuizIngestError(503, 'integration_unavailable');
    const payload = validateQuizPayload(input, this.now());
    const response = status => ({ status, event_id: payload.event_id, source_submission_id: payload.source_submission_id });
    const payloadHash = contentHash(payload);
    const existing = async () => {
      const byEvent = await this.repo.get(table, rowId(payload.event_id));
      const bySubmission = (await this.repo.list(table, [query('equal', [WEBSITE_QUIZ_SOURCE], 'source'), query('equal', [payload.source_submission_id], 'source_submission_id')]))
        .filter(r => r.source === WEBSITE_QUIZ_SOURCE && r.source_submission_id === payload.source_submission_id);
      const rows = [...new Map([byEvent, ...bySubmission].filter(Boolean).map(r => [r.$id, r])).values()];
      if (!rows.length) return null;
      if (rows.length !== 1 || rows[0].client_id !== this.env.WEBSITE_QUIZ_CLIENT_ID || rows[0].payload_hash !== payloadHash
        || rows[0].source_event_id !== payload.event_id || rows[0].source_submission_id !== payload.source_submission_id) {
        throw new QuizIngestError(409, 'conflict');
      }
      const event = await this.repo.get('outreach_events', eventRowId(payload.event_id));
      if (!event || event.message_id !== rows[0].message_id || event.client_id !== rows[0].client_id
        || event.event_key !== eventKey(payload.event_id) || event.event_type !== 'quiz_completed'
        || Date.parse(event.occurred_at) !== Date.parse(payload.occurred_at)
        || contentHash(parse(event.details_json)) !== contentHash(eventDetails(payload))
        || contentHash(parse(rows[0].payload_json)) !== payloadHash) {
        throw new QuizIngestError(503, 'incomplete_persistence');
      }
      return { statusCode: 200, body: response('duplicate') };
    };
    try {
      return await this.lock(async () => {
        const duplicate = await existing(); if (duplicate) return duplicate;
        if (!payload.outreach_id) return { statusCode: 200, body: { ...response('ignored'), reason: 'missing_outreach_id' } };
        const message = await this.repo.get('outreach_messages', payload.outreach_id);
        const company = message && await this.repo.get('companies', message.company_id);
        if (!message || message.client_id !== this.env.WEBSITE_QUIZ_CLIENT_ID || company?.client_id !== message.client_id) {
          return { statusCode: 200, body: { ...response('ignored'), reason: 'unknown_outreach_id' } };
        }
        const marker = await this.repo.get('outreach_test_messages', message.$id);
        if (payload.is_test || marker) {
          if (!payload.is_test || marker?.purpose !== 'website_quiz_e2e' || marker.client_id !== message.client_id
            || marker.company_id !== message.company_id || !testEmail(message.target_address) || !testEmail(payload.contact.email)) {
            throw new QuizIngestError(400, 'invalid_test_identity');
          }
        } else {
          const attempts = (await this.repo.list('outreach_attempts', [query('equal', [message.$id], 'message_id')]))
            .filter(a => a.message_id === message.$id && a.client_id === message.client_id && a.status === 'accepted');
          // A sent label alone cannot overrule a contradictory or missing time.
          // Prefer accepted-attempt evidence; older imported messages may use a
          // valid explicit sent_at only when no accepted attempt exists.
          const sentAt = attempts.length ? Math.min(...attempts.map(a => Date.parse(a.attempted_at)))
            : message.status === 'sent' ? Date.parse(message.sent_at) : NaN;
          if (!Number.isFinite(sentAt) || sentAt > Date.parse(payload.occurred_at))
            return { statusCode: 200, body: { ...response('ignored'), reason: 'unknown_outreach_id' } };
        }
        const row = { client_id: message.client_id, company_id: message.company_id, message_id: message.$id,
          source: WEBSITE_QUIZ_SOURCE, source_event_id: payload.event_id, source_submission_id: payload.source_submission_id,
          payload_hash: payloadHash, is_test: payload.is_test, occurred_at: payload.occurred_at,
          recorded_at: this.now().toISOString(), payload_json: JSON.stringify(payload) };
        const event = { client_id: message.client_id, message_id: message.$id, event_key: eventKey(payload.event_id),
          event_type: 'quiz_completed', occurred_at: payload.occurred_at,
          details_json: JSON.stringify(eventDetails(payload)) };
        try {
          await this.repo.transaction([{ action: 'create', table, id: rowId(payload.event_id), data: row },
            { action: 'create', table: 'outreach_events', id: eventRowId(payload.event_id), data: event }]);
        } catch {
          // A timeout can follow a committed transaction. Read first; never blindly retry a write.
          const committed = await existing(); if (committed) return committed;
          throw new QuizIngestError(503, 'persistence_unavailable');
        }
        if (!await existing()) throw new QuizIngestError(503, 'persistence_unconfirmed');
        return { statusCode: 201, body: response('accepted') };
      });
    } catch (error) {
      if (error instanceof QuizIngestError) throw error;
      throw new QuizIngestError(503, 'persistence_unavailable');
    }
  }
}

// One authoritative submission + its atomically stored event, never a manually
// entered quiz_completed event alone. The join also defends against cross-client rows.
export function quizSubmissions(d, now, { includeTests = false } = {}) {
  const messages = new Map(d.outreach_messages.map(m => [m.$id, m]));
  const companies = new Map(d.companies.map(c => [c.$id, c]));
  const result = [];
  for (const row of d.website_quiz_submissions ?? []) {
    const m = messages.get(row.message_id), company = companies.get(row.company_id), payload = parse(row.payload_json);
    if (!m || m.client_id !== row.client_id || company?.client_id !== row.client_id || m.company_id !== row.company_id
      || row.source !== WEBSITE_QUIZ_SOURCE || !payload || !validate(payload) || payload.outreach_id !== m.$id
      || payload.event_id !== row.source_event_id || payload.source_submission_id !== row.source_submission_id
      || payload.is_test !== row.is_test || payload.contact.source_submission_id !== row.source_submission_id
      || contentHash(payload) !== row.payload_hash || !Number.isFinite(Date.parse(row.occurred_at))
      || Date.parse(row.occurred_at) !== Date.parse(payload.occurred_at) || Date.parse(row.occurred_at) > now.getTime()
      || (row.is_test && !includeTests)) continue;
    const event = d.outreach_events.find(e => e.$id === eventRowId(row.source_event_id) && e.client_id === row.client_id
      && e.message_id === m.$id && e.event_type === 'quiz_completed' && e.event_key === eventKey(row.source_event_id));
    if (!event || Date.parse(event.occurred_at)!==Date.parse(row.occurred_at)
      || contentHash(parse(event.details_json))!==contentHash(eventDetails(payload))) continue;
    result.push({ id: event.$id, type: 'quiz_completed', at: row.occurred_at, messageId: m.$id, companyId: m.company_id,
      companyName: company.name, origin: 'outreach_event', source: row.source, details: parse(event.details_json) });
  }
  return [...new Map(result.map(e => [JSON.stringify([e.source, e.details.website_quiz.source_submission_id]), e])).values()]
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || a.id.localeCompare(b.id));
}
