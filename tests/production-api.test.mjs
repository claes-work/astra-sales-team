import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { createApi } from '../src/outreach/http.mjs';
import { checkApiHealth } from '../infra/production/api-health.mjs';
import { WebsiteQuizIngest, WEBSITE_QUIZ_PATH } from '../src/integrations/website-quiz.mjs';
import { MemoryRepo } from './helpers/outreach-content.mjs';

const env = { NODE_ENV: 'production', OUTREACH_API_HOST: '0.0.0.0', OUTREACH_API_ALLOWED_HOSTS: 'sales-api.example.invalid',
  OUTREACH_API_ALLOWED_ORIGINS: 'https://sales.example.invalid', OUTREACH_API_TOKEN: 'operator'.repeat(8),
  WEBSITE_QUIZ_BEARER_TOKEN: 'website'.repeat(8), WEBSITE_QUIZ_CLIENT_ID: 'own' };
const now = new Date('2026-09-12T19:00:00Z');
const mid = 'msg_0123456789abcdef0123456789ab';
const payload = () => ({ schema_version: 1, event_type: 'quiz_completed', event_id: '87ec67e7-22b6-44be-bd9d-6cd42a5c8432',
  source_submission_id: '01b7b2b1-d1c9-4a62-9433-d15144974b60', occurred_at: '2026-09-12T15:00:00Z', outreach_id: mid, is_test: false,
  contact: { first_name: 'Test', last_name: 'Person', email: 'person@example.org', company: 'Company', phone: null,
    provenance: 'quiz_form', captured_at: '2026-09-12T15:00:00Z', source_submission_id: '01b7b2b1-d1c9-4a62-9433-d15144974b60' },
  result: { quiz_id: 'sales-roadmap', quiz_version: 'v4', stage: 3 } });
async function fixture(t) {
  const repo = new MemoryRepo(); repo.database = 'lead-research';
  await repo.create('outreach_controls', 'default', { paused: true });
  await repo.create('companies', 'company', { client_id: 'own', name: 'Original' });
  await repo.create('outreach_messages', mid, { client_id: 'own', company_id: 'company', target_address: 'original@example.org', status: 'sent', sent_at: '2026-09-12T16:00:00Z' });
  const service = { repo, env, now: () => now, lock: work => work(), ramp: {} };
  const server = createApi({ service, repo, env, token: env.OUTREACH_API_TOKEN });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.close(); server.closeAllConnections(); });
  return { repo, service, server, ingest: new WebsiteQuizIngest(service), port: server.address().port };
}
function call(port, path, { headers = {}, method = 'GET', body } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, method,
      headers: { host: env.OUTREACH_API_ALLOWED_HOSTS, authorization: `Bearer ${env.OUTREACH_API_TOKEN}`, ...headers } }, res => {
      let text = ''; res.on('data', chunk => { text += chunk; }); res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', reject); req.end(body);
  });
}

test('authenticated container health uses allowed Host, verifies controls/database and never accepts wrong auth', async t => {
  const f = await fixture(t);
  const config = { ...env, OUTREACH_API_PORT: String(f.port), APPWRITE_DATABASE_ID: 'lead-research' };
  assert.equal(await checkApiHealth(config), true);
  assert.equal(await checkApiHealth({ ...config, OUTREACH_API_TOKEN: 'bad'.repeat(16) }), false);
  assert.equal(await checkApiHealth({ ...config, OUTREACH_API_HEALTH_HOST: 'evil.invalid' }), false);
  assert.equal(await checkApiHealth({ ...config, APPWRITE_DATABASE_ID: 'another' }), false);
  assert.equal((await call(f.port, '/v1/status', { headers: { authorization: '' } })).status, 401);
});

test('production errors do not reflect arbitrary SDK/parser secrets or submitted data', async t => {
  const f = await fixture(t);
  const secret = 'PRIVATE-API-KEY customer-private@example.org';
  f.service.controls = async () => { const error = new Error(secret); error.status = 503; throw error; };
  const failure = await call(f.port, '/v1/controls', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(failure.status, 503); assert.ok(!failure.text.includes(secret));
  assert.deepEqual(JSON.parse(failure.text), { error: 'Anfrage konnte nicht verarbeitet werden.', code: 'request_failed' });
  const invalid = await call(f.port, '/v1/controls', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: '{"private-secret":bad}' });
  assert.equal(invalid.status, 400); assert.ok(!invalid.text.includes('private-secret'));
});

test('production origin, Host and split credentials cannot be bypassed by forwarded headers', async t => {
  const f = await fixture(t);
  assert.equal((await call(f.port, '/v1/status', { headers: { host: 'evil.invalid', 'x-forwarded-host': env.OUTREACH_API_ALLOWED_HOSTS } })).status, 403);
  assert.equal((await call(f.port, '/v1/status', { headers: { origin: 'https://evil.invalid', 'x-forwarded-proto': 'https' } })).status, 403);
  assert.equal((await call(f.port, '/v1/status', { headers: { authorization: `Bearer ${env.WEBSITE_QUIZ_BEARER_TOKEN}` } })).status, 401);
  assert.equal((await call(f.port, WEBSITE_QUIZ_PATH, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401);
});

test('quiz payload above 64KiB cannot persist and does not echo body content', async t => {
  const f = await fixture(t);
  const before = structuredClone(f.repo.rows);
  // Depending on Node stream shutdown timing, the oversized request receives
  // a safe 400 or the socket is closed. Neither path may run the ingest.
  try {
    const result = await call(f.port, WEBSITE_QUIZ_PATH, { method: 'POST',
      headers: { authorization: `Bearer ${env.WEBSITE_QUIZ_BEARER_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ sensitive: 'x'.repeat(70000) }) });
    assert.equal(result.status, 400); assert.ok(!result.text.includes('sensitive'));
  } catch (error) { assert.equal(error.code, 'ECONNRESET'); }
  assert.deepEqual(f.repo.rows, before);
});

test('sent status never overrides contradictory accepted evidence; fallback needs an explicit valid sent_at', async t => {
  const f = await fixture(t);
  await f.repo.create('outreach_attempts', 'attempt', { client_id: 'own', message_id: mid, status: 'accepted', attempted_at: '2026-09-12T16:00:00Z' });
  await f.repo.update('outreach_messages', mid, { sent_at: '2026-09-12T14:00:00Z' });
  assert.equal((await f.ingest.ingest(payload())).body.status, 'ignored');
  assert.equal((await f.repo.list('website_quiz_submissions')).length, 0);
  f.repo.rows.delete('outreach_attempts/attempt');
  await f.repo.update('outreach_messages', mid, { sent_at: null });
  assert.equal((await f.ingest.ingest(payload())).body.status, 'ignored');
  await f.repo.update('outreach_messages', mid, { sent_at: '2026-09-12T14:00:00Z' });
  assert.equal((await f.ingest.ingest(payload())).statusCode, 201);
});
