import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { MemoryRepo } from './helpers/outreach-content.mjs';
import { WebsiteQuizIngest, WEBSITE_QUIZ_PATH } from '../src/integrations/website-quiz.mjs';
import { DashboardData } from '../src/operations/dashboard.mjs';
import { createApi } from '../src/outreach/http.mjs';

const now = new Date('2026-09-12T16:00:00Z');
const mid = 'msg_0123456789abcdef0123456789ab';
const testMid = 'msg_abcdefabcdef0123456789abcdef';
const env = { WEBSITE_QUIZ_BEARER_TOKEN: 'w'.repeat(48), WEBSITE_QUIZ_CLIENT_ID: 'own' };
const payload = () => ({ schema_version: 1, event_type: 'quiz_completed', event_id: '87ec67e7-22b6-44be-bd9d-6cd42a5c8432',
  source_submission_id: '01b7b2b1-d1c9-4a62-9433-d15144974b60', occurred_at: '2026-09-12T15:00:00Z', outreach_id: mid, is_test: false,
  contact: { first_name: 'Andere', last_name: 'Person', email: 'forwarded@example.org', company: 'Andere Firma', phone: null,
    provenance: 'quiz_form', captured_at: '2026-09-12T15:00:00Z', source_submission_id: '01b7b2b1-d1c9-4a62-9433-d15144974b60' },
  result: { quiz_id: 'sales-roadmap', quiz_version: 'v4-2026-09-09', stage: 3 } });
async function fixture() {
  const repo = new MemoryRepo();
  const service = { repo, env, now: () => now, lock: work => work(), ramp: { snapshot: async () => ({ configured: false }) } };
  await repo.create('companies', 'real-company', { client_id: 'own', name: 'Originalfirma', domain: 'example.org' });
  await repo.create('outreach_messages', mid, { client_id: 'own', company_id: 'real-company', contact_id: 'original-contact',
    target_address: 'original@example.org', subject: 'Original', body: 'Original text', status: 'sent' });
  await repo.create('contacts', 'original-contact', { client_id: 'own', company_id: 'real-company', email: 'original@example.org', name: 'Originalperson' });
  await repo.create('outreach_attempts', 'attempt', { client_id: 'own', message_id: mid, status: 'accepted', attempted_at: '2026-09-11T10:00:00Z' });
  await repo.create('outreach_events', 'sent', { client_id: 'own', message_id: mid, event_type: 'provider_sent', occurred_at: '2026-09-11T10:00:01Z', details_json: '{}' });
  return { repo, service, ingest: new WebsiteQuizIngest(service), dashboard: new DashboardData(service) };
}
const errorCode = code => error => error.code === code;

test('durable completion is atomic, immutable and separately attributed to a forwarded-link contact', async () => {
  const f = await fixture(), before = await f.repo.get('outreach_messages', mid), original = await f.repo.get('contacts', 'original-contact');
  const result = await f.ingest.ingest(payload()); assert.equal(result.statusCode, 201); assert.equal(result.body.status, 'accepted');
  assert.deepEqual(await f.repo.get('outreach_messages', mid), before); assert.deepEqual(await f.repo.get('contacts', 'original-contact'), original);
  const rows = await f.repo.list('website_quiz_submissions'); assert.equal(rows.length, 1);
  assert.equal(JSON.parse(rows[0].payload_json).contact.email, 'forwarded@example.org');
  assert.equal(JSON.parse(rows[0].payload_json).contact.provenance, 'quiz_form');
  assert.equal((await f.ingest.ingest(payload())).body.status, 'duplicate');
  assert.equal((await f.repo.list('website_quiz_submissions')).length, 1);
  assert.equal((await f.repo.list('outreach_events')).filter(e => e.event_type === 'quiz_completed').length, 1);
});

test('changed event ID, submission ID or payload with an existing identity is a conflict', async () => {
  const f = await fixture(); await f.ingest.ingest(payload());
  const changed = payload(); changed.contact.email = 'changed@example.org'; await assert.rejects(f.ingest.ingest(changed), errorCode('conflict'));
  const event = payload(); event.event_id = '8dec67e7-22b6-44be-bd9d-6cd42a5c8432'; await assert.rejects(f.ingest.ingest(event), errorCode('conflict'));
  const submission = payload(); submission.source_submission_id = submission.contact.source_submission_id = '81b7b2b1-d1c9-4a62-9433-d15144974b60';
  await assert.rejects(f.ingest.ingest(submission), errorCode('conflict'));
  assert.equal((await f.repo.list('website_quiz_submissions')).length, 1);
});

test('missing, unknown, cross-client and unsent non-test IDs persist no form PII', async () => {
  for (const scenario of ['missing', 'unknown', 'cross-client', 'unsent']) {
    const f = await fixture(), p = payload(), before = structuredClone(f.repo.rows);
    if (scenario === 'missing') p.outreach_id = null;
    if (scenario === 'unknown') p.outreach_id = testMid;
    if (scenario === 'cross-client') f.ingest.env = { ...env, WEBSITE_QUIZ_CLIENT_ID: 'other' };
    if (scenario === 'unsent') { await f.repo.update('outreach_messages', mid, { status: 'draft' }); f.repo.rows.delete('outreach_attempts/attempt'); }
    const state = structuredClone(f.repo.rows), r = await f.ingest.ingest(p);
    assert.equal(r.body.status, 'ignored'); assert.equal(r.body.reason, scenario === 'missing' ? 'missing_outreach_id' : 'unknown_outreach_id');
    assert.deepEqual(f.repo.rows, state); assert.equal((await f.repo.list('website_quiz_submissions')).length, 0);
    if (scenario !== 'unsent') assert.deepEqual(f.repo.rows, before);
  }
});

test('invalid shape, stage, provenance, time and identity are rejected without persistence', async () => {
  const edits = [p => { p.result.stage = 7; }, p => { p.result.stage = -1; }, p => { p.result.stage = 2.5; },
    p => { p.answers = { private: 'never copy' }; }, p => { p.outreach_id = 'arbitrary'; }, p => { p.is_test = 'false'; },
    p => { p.contact.provenance = 'outreach_recipient'; }, p => { p.contact.source_submission_id = p.event_id; },
    p => { p.contact.captured_at = '2026-09-12T14:00:00Z'; }, p => { p.contact.email = 'bad\n@example.org'; },
    p => { p.occurred_at = p.contact.captured_at = '2026-09-13T15:00:00Z'; }, p => { p.contact.first_name = '  '; },
    p => { p.occurred_at = p.contact.captured_at = '2026-02-30T15:00:00Z'; }];
  for (const edit of edits) { const f = await fixture(), p = payload(), before = structuredClone(f.repo.rows); edit(p);
    await assert.rejects(f.ingest.ingest(p), errorCode('invalid_payload')); assert.deepEqual(f.repo.rows, before); }
});

test('transaction outage is retryable and a commit followed by timeout is recognized without duplicate writes', async () => {
  const f = await fixture(); const originalTransaction = f.repo.transaction.bind(f.repo); let calls = 0;
  f.repo.transaction = async () => { calls++; throw new Error('private secret in database diagnostics'); };
  await assert.rejects(f.ingest.ingest(payload()), errorCode('persistence_unavailable')); assert.equal((await f.repo.list('website_quiz_submissions')).length, 0);
  f.repo.transaction = async ops => { calls++; await originalTransaction(ops); throw new Error('response lost after commit'); };
  assert.equal((await f.ingest.ingest(payload())).body.status, 'duplicate'); assert.equal(calls, 2);
  assert.equal((await f.ingest.ingest(payload())).body.status, 'duplicate'); assert.equal(calls, 2);
});

test('concurrent retries and competing submission identities rely on unique constraints and preserve one atomic result', async () => {
  for(const conflicting of [false,true]){
    const f=await fixture();let queue=Promise.resolve();const transaction=f.repo.transaction.bind(f.repo);
    // Simulate database transactions serialized at unique-index commit, while
    // both independent requests may have observed the row as absent beforehand.
    f.repo.transaction=ops=>{
      const work=queue.then(async()=>{
        const saved=await f.repo.list('website_quiz_submissions');
        for(const op of ops.filter(op=>op.table==='website_quiz_submissions')){
          if(saved.some(r=>r.source===op.data.source&&(r.source_event_id===op.data.source_event_id||r.source_submission_id===op.data.source_submission_id)))throw new Error('unique index conflict');
        }
        return transaction(ops);
      });queue=work.catch(()=>{});return work;
    };
    const a=payload(),b=payload();if(conflicting)b.event_id='8dec67e7-22b6-44be-bd9d-6cd42a5c8432';
    const outcomes=await Promise.allSettled([f.ingest.ingest(a),f.ingest.ingest(b)]);
    assert.equal(outcomes.filter(r=>r.status==='fulfilled'&&r.value.statusCode===201).length,1);
    if(conflicting)assert.equal(outcomes.filter(r=>r.status==='rejected'&&r.reason.code==='conflict').length,1);
    else assert.equal(outcomes.filter(r=>r.status==='fulfilled'&&r.value.body.status==='duplicate').length,1);
    assert.equal((await f.repo.list('website_quiz_submissions')).length,1);
    assert.equal((await f.repo.list('outreach_events')).filter(e=>e.event_type==='quiz_completed').length,1);
  }
});

async function addTest(f) {
  await f.repo.create('companies', 'test-company', { client_id: 'own', name: 'E2E Test', domain: 'example.invalid' });
  await f.repo.create('outreach_messages', testMid, { client_id: 'own', company_id: 'test-company', contact_id: 'test-contact',
    target_address: 'test@example.invalid', subject: 'Never send', body: 'Never send', status: 'draft' });
  await f.repo.create('outreach_test_messages', testMid, { client_id: 'own', company_id: 'test-company', purpose: 'website_quiz_e2e', created_at: now.toISOString() });
  const p = payload(); p.outreach_id = testMid; p.is_test = true; p.contact.email = 'form@example.invalid'; return p;
}
test('explicit saved no-send test completes, appears in direct detail, never inflates production metrics or lead totals', async () => {
  const f = await fixture(), initial = await f.dashboard.overview(), p = await addTest(f);
  assert.equal((await f.ingest.ingest(p)).body.status, 'accepted');
  const summary = await f.dashboard.overview(); assert.deepEqual(summary.totals, initial.totals);
  assert.equal(summary.success.completedQuizzes.recordedCount, 0); assert.equal(summary.success.completedQuizzes.value, null);
  assert.equal((await f.dashboard.leads()).total, 1);
  const dayDetail=await f.dashboard.day('2026-09-12');
  assert.equal(dayDetail.quizSubmissions.length,1);assert.equal(dayDetail.quizSubmissions[0].details.website_quiz.is_test,true);
  assert.deepEqual(dayDetail.counts,initial.today.counts);assert.equal(dayDetail.events.some(e=>e.messageId===testMid),false);
  assert.equal(summary.today.quizSubmissions.length,0);assert.deepEqual(summary.today.counts,initial.today.counts);
  assert.deepEqual((await f.dashboard.days()).items,initial.days);
  const detail = await f.dashboard.message(testMid); assert.equal(detail.isTest, true); assert.equal(detail.to, 'test@example.invalid');
  assert.equal(detail.timeline.filter(e => e.type === 'quiz_completed').length, 1);
  assert.equal(detail.quizSubmissions[0].details.website_quiz.is_test, true);
  assert.equal((await f.dashboard.lead('test-company')).quizSubmissions.length, 1);
  assert.equal((await f.repo.list('outreach_attempts')).some(a => a.message_id === testMid), false);
});

test('test flag alone cannot register a test or disguise production as a test', async () => {
  const f = await fixture(), p = payload(); p.is_test = true; p.contact.email = 'test@example.invalid';
  await assert.rejects(f.ingest.ingest(p), errorCode('invalid_test_identity'));
  const registered = await addTest(f); registered.is_test = false; await assert.rejects(f.ingest.ingest(registered), errorCode('invalid_test_identity'));
  registered.is_test = true; registered.contact.email = 'real@example.org'; await assert.rejects(f.ingest.ingest(registered), errorCode('invalid_test_identity'));
  assert.equal((await f.repo.list('website_quiz_submissions')).length, 0);
});

test('production KPI deduplicates validated submissions and completion day is independent of mail day', async () => {
  const f = await fixture(); await f.ingest.ingest(payload()); await f.ingest.ingest(payload());
  await f.repo.create('outreach_events', 'manual-quiz', { client_id: 'own', message_id: mid, event_type: 'quiz_completed', occurred_at: '2026-09-12T15:30:00Z', details_json: '{}' });
  const summary = await f.dashboard.overview(); assert.equal(summary.success.completedQuizzes.value, 1);
  assert.equal(summary.success.completedQuizzes.unit, 'submissions'); assert.equal(summary.success.completedQuizzes.coverage, 'partial');
  assert.equal((await f.dashboard.day('2026-09-11')).quizSubmissions.length, 0);
  const day = await f.dashboard.day('2026-09-12'); assert.equal(day.quizSubmissions.length, 1); assert.equal(day.counts.sentMessages, 0);
  assert.equal(day.quizSubmissions[0].messageId, mid); assert.equal(day.quizSubmissions[0].companyName, 'Originalfirma');
  const detail = await f.dashboard.message(mid); assert.equal(detail.to, 'original@example.org');
  assert.equal(detail.timeline.filter(e => e.type === 'quiz_completed').length, 1);
  assert.equal(detail.timeline.find(e => e.type === 'quiz_completed').details.website_quiz.contact.email, 'forwarded@example.org');
});

test('HTTP uses a distinct integration bearer, no browser CORS, safe retry/error codes and host validation', async t => {
  const f = await fixture(), token = 'o'.repeat(48), server = createApi({ service: f.service, repo: f.repo, env, token });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => { server.close(); server.closeAllConnections(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (path, auth, p = payload(), headers = {}) => fetch(base + path, { method: 'POST', headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/json', ...headers }, body: JSON.stringify(p) });
  assert.equal((await request(WEBSITE_QUIZ_PATH, token)).status, 401);
  assert.equal((await request('/v1/controls', env.WEBSITE_QUIZ_BEARER_TOKEN)).status, 401);
  assert.equal((await request(WEBSITE_QUIZ_PATH, env.WEBSITE_QUIZ_BEARER_TOKEN, payload(), { origin: 'https://evil.invalid' })).status, 403);
  const ok = await request(WEBSITE_QUIZ_PATH, env.WEBSITE_QUIZ_BEARER_TOKEN); assert.equal(ok.status, 201); assert.equal(ok.headers.get('access-control-allow-origin'), null);
  assert.equal((await request(WEBSITE_QUIZ_PATH, env.WEBSITE_QUIZ_BEARER_TOKEN)).status, 200);
  const changed = payload(); changed.contact.email = 'secret-value@example.org'; const conflict = await request(WEBSITE_QUIZ_PATH, env.WEBSITE_QUIZ_BEARER_TOKEN, changed);
  assert.equal(conflict.status, 409); assert.deepEqual(await conflict.json(), { status: 'conflict' });
  assert.throws(() => createApi({ service: f.service, repo: f.repo, env, token: env.WEBSITE_QUIZ_BEARER_TOKEN }), /getrennte/);
});

test('production API permits only configured Host and HTTPS Origins, with auth still required', async t => {
  const f = await fixture(), productionEnv = { ...env, NODE_ENV: 'production', OUTREACH_API_HOST: '0.0.0.0', OUTREACH_API_ALLOWED_HOSTS: 'sales-api.example.org', OUTREACH_API_ALLOWED_ORIGINS: 'https://sales.example.org' };
  const server = createApi({ service: f.service, repo: f.repo, env: productionEnv, token: 'o'.repeat(48) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => { server.close(); server.closeAllConnections(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const status = headers => new Promise((resolve,reject)=>{const req=httpRequest(base+'/v1/status',{headers},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);req.end();});
  assert.equal(await status({}), 403);
  assert.equal(await status({ host: 'sales-api.example.org' }), 401);
  assert.equal(await status({ host: 'sales-api.example.org', authorization: `Bearer ${'o'.repeat(48)}`, origin: 'https://other.example.org' }), 403);
  assert.throws(() => createApi({ service: f.service, repo: f.repo, env: { ...productionEnv, OUTREACH_API_ALLOWED_HOSTS: '' }, token: 'o'.repeat(48) }), /Hostnamen/);
});

test('HTTP rejects NUL, DEL and other control characters in any email segment before all PII writes', async t => {
  const f=await fixture(),server=createApi({service:f.service,repo:f.repo,env,token:'o'.repeat(48)});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.close();server.closeAllConnections();});
  const before=structuredClone(f.repo.rows),url=`http://127.0.0.1:${server.address().port}${WEBSITE_QUIZ_PATH}`;
  for(const control of ['\u0000','\u001f','\u007f'])for(const address of [`bad${control}@example.org`,`bad@ex${control}ample.org`,`bad@example.o${control}rg`]){
    const p=payload();p.contact.email=address;
    const result=await fetch(url,{method:'POST',headers:{authorization:`Bearer ${env.WEBSITE_QUIZ_BEARER_TOKEN}`,'content-type':'application/json'},body:JSON.stringify(p)});
    assert.equal(result.status,400);assert.deepEqual(await result.json(),{status:'invalid_payload'});assert.deepEqual(f.repo.rows,before);
  }
});
