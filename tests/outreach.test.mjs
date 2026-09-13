import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep, basename } from 'node:path';
import { OutreachService } from '../src/outreach/service.mjs';
import { BrevoProvider, ProviderError } from '../src/outreach/brevo.mjs';
import { DemoProvider, demoEnv } from '../src/outreach/demo.mjs';
import { DEMO_DB } from '../src/outreach/appwrite.mjs';
import { defaultControls } from '../infra/appwrite/outreach-schema.mjs';
import { withOutreachLock } from '../src/outreach/lock.mjs';
import { importReply, syncReplies } from '../src/outreach/inbound.mjs';
import { createApi } from '../src/outreach/http.mjs';
import { identity } from '../src/outreach/experiment.mjs';
import { workerCycle } from '../src/outreach/worker.mjs';

class MemoryRepo {
  constructor() { this.database = DEMO_DB; this.rows = new Map(); }
  async list(table) { return [...this.rows].filter(([key]) => key.startsWith(table + '/')).map(([, value]) => structuredClone(value)); }
  async get(table, id) { return structuredClone(this.rows.get(table + '/' + id) ?? null); }
  async create(table, id, data) {
    if (this.rows.has(table + '/' + id)) throw new Error('Duplicate identity');
    const value = { ...structuredClone(data), $id: id }; this.rows.set(table + '/' + id, value); return structuredClone(value);
  }
  async update(table, id, data) {
    const current = await this.get(table, id); if (!current) throw new Error('Missing row');
    const value = { ...current, ...structuredClone(data) }; this.rows.set(table + '/' + id, value); return structuredClone(value);
  }
  async transaction(operations) {
    const before = structuredClone(this.rows);
    try { for (const op of operations) await this[op.action](op.table, op.id, op.data); }
    catch (error) { this.rows = before; throw error; }
  }
}
const spec = () => ({ schemaVersion: 1, key: 'test', version: '1', name: 'Betreff-Test', variable: 'subject', landingUrl: 'https://example.org/roadmap',
  responseWindowDays: 7, variants: [{ id: 'a', subject: 'KI für {{company}}' }, { id: 'b', subject: '{{company}}: nächster Schritt' }],
  body: 'Guten Tag {{company}},\n{{landingUrl}}\n{{senderName}}' });
async function fixture() {
  const repo = new MemoryRepo();
  let now = new Date('2026-09-10T10:00:00Z');
  const provider = new DemoProvider();
  const service = new OutreachService({ repo, provider, env: demoEnv, now: () => now, lock: work => work() });
  await repo.create('outreach_controls', 'default', { ...defaultControls, paused: false, min_interval_seconds: 0 });
  await repo.create('campaigns', 'camp', { client_id: 'own', active_icp_version_id: 'version', status: 'active' });
  await repo.create('research_runs', 'run', { client_id: 'own', campaign_id: 'camp' });
  for (let i = 1; i <= 2; i++) {
    await repo.create('companies', `co${i}`, { client_id: 'own', name: `Firma ${i}`, do_not_contact: false });
    await repo.create('contacts', `ct${i}`, { client_id: 'own', company_id: `co${i}`, email: `person${i}@example.invalid`, do_not_contact: false });
    await repo.create('assessments', `as${i}`, { client_id: 'own', company_id: `co${i}`, run_id: 'run', icp_version_id: 'version', status: 'qualified', eligible_for_enrichment: true });
  }
  const experiment = await service.createExperiment({ clientId: 'own', campaignId: 'camp', definition: spec() });
  const enrollments = [];
  for (let i = 1; i <= 2; i++) enrollments.push(await service.enroll({ experimentId: experiment.$id, assessmentId: `as${i}`, contactId: `ct${i}` }));
  async function ready(index = 0) {
    const enrollment = enrollments[index];
    await service.permission({ clientId: 'own', contactId: enrollment.contact_id, status: 'verified', basis: 'internal_test', providerAllowed: true, evidence: 'Fiktiver Test', checkedBy: 'Test' });
    const preview = await service.preview(enrollment.message_id);
    await service.approve({ messageId: enrollment.message_id, contentHash: preview.contentHash, approvedBy: 'Test' });
    await service.experimentStatus({ experimentId: experiment.$id, status: 'active' });
    return enrollment.message_id;
  }
  return { repo, provider, service, experiment, enrollments, ready, time: value => { now = new Date(value); } };
}

test('experiment is frozen; reimport preserves assignment; another version has another identity', async () => {
  const f = await fixture();
  const again = await f.service.createExperiment({ clientId: 'own', campaignId: 'camp', definition: spec() });
  assert.equal(again.$id, f.experiment.$id);
  const enrollment = await f.service.enroll({ experimentId: again.$id, assessmentId: 'as1', contactId: 'ct1' });
  assert.deepEqual(enrollment, f.enrollments[0]);
  const changed = spec(); changed.version = '2'; changed.variants[0].subject = 'Anderer Betreff';
  const next = await f.service.createExperiment({ clientId: 'own', campaignId: 'camp', definition: changed });
  assert.notEqual(next.$id, again.$id);
  assert.equal((await f.repo.list('outreach_messages')).length, 2);
});
test('unqualified, cross-client and wrong-profile enrollments fail', async () => {
  const f = await fixture(); const params = { experimentId: f.experiment.$id, assessmentId: 'as1', contactId: 'ct1' };
  await f.repo.update('assessments', 'as1', { status: 'needs_review' }); await assert.rejects(() => f.service.enroll(params), /Lead/);
  await f.repo.update('assessments', 'as1', { status: 'qualified', client_id: 'other' }); await assert.rejects(() => f.service.enroll(params), /Auftraggeber/);
  await f.repo.update('assessments', 'as1', { client_id: 'own', icp_version_id: 'wrong' }); await assert.rejects(() => f.service.enroll(params), /Profilversion/);
});
test('unknown permission blocks approval; reviewed exact content is required', async () => {
  const f = await fixture(); const enrollment = f.enrollments[0];
  await assert.rejects(() => f.service.approve({ messageId: enrollment.message_id, contentHash: enrollment.content_hash, approvedBy: 'Test' }), /Kontakt/);
  assert.equal(f.provider.sent.length, 0);
  await f.ready();
  await f.repo.update('outreach_messages', enrollment.message_id, { subject: 'Nachträglich geändert' });
  await assert.rejects(() => f.service.sendOne({ messageId: enrollment.message_id, execute: true }), /verändert/);
});
test('dry run never creates an attempt; replay never sends twice', async () => {
  const f = await fixture(); const id = await f.ready();
  await assert.rejects(() => f.service.sendOne({ messageId: id, execute: 'false' }), /ausdrücklich/);
  assert.equal((await f.service.sendOne({ messageId: id })).dryRun, true);
  assert.equal((await f.repo.list('outreach_attempts')).length, 0);
  await f.service.sendOne({ messageId: id, execute: true });
  await assert.rejects(() => f.service.sendOne({ messageId: id, execute: true }));
  assert.equal(f.provider.sent.length, 1);
});
test('paused, daily limit, time window and revoked contact are enforced immediately', async () => {
  const f = await fixture(); const first = await f.ready(); const second = await f.ready(1);
  await f.service.controls({ paused: true }); await assert.rejects(() => f.service.sendOne({ messageId: first, execute: true }), /pausiert/);
  await f.service.controls({ paused: false, daily_limit: 1 });
  f.time('2026-09-10T20:00:00Z'); await assert.rejects(() => f.service.sendOne({ messageId: first, execute: true }), /Versandfenster/);
  f.time('2026-09-10T10:00:00Z'); await f.service.sendOne({ messageId: first, execute: true });
  await assert.rejects(() => f.service.sendOne({ messageId: second, execute: true }), /Tageslimit/);
  f.time('2026-09-11T10:00:00Z'); await f.repo.update('contacts', 'ct2', { do_not_contact: true });
  await assert.rejects(() => f.service.sendOne({ messageId: second, execute: true }), /Kontaktsperre/);
  assert.equal(f.provider.sent.length, 1);
});
test('minimum interval applies across contacts and clients', async () => {
  const f = await fixture(); const first = await f.ready(); const second = await f.ready(1);
  await f.service.controls({ min_interval_seconds: 180 });
  await f.service.sendOne({ messageId: first, execute: true });
  await assert.rejects(() => f.service.sendOne({ messageId: second, execute: true }), /Mindestabstand/);
  f.time('2026-09-10T10:03:00Z'); await f.service.sendOne({ messageId: second, execute: true });
});
test('uncertain provider outcome remains reserved against duplicate sending and uses tag recovery', async () => {
  const f = await fixture(); const id = await f.ready();
  let calls = 0;
  f.provider.send = async () => { calls++; throw new ProviderError('Timeout', true); };
  await assert.rejects(() => f.service.sendOne({ messageId: id, execute: true }), /unklar/);
  const attempt = (await f.repo.list('outreach_attempts'))[0]; assert.equal(attempt.status, 'unknown');
  await assert.rejects(() => f.service.sendOne({ messageId: id, execute: true })); assert.equal(calls, 1);
  f.provider.events = async ({ tag }) => [{ messageId: '<recovered@test.invalid>', email: 'person1@example.invalid', tag, date: '2026-09-10T10:00:00Z', event: 'delivered' }];
  const first = await f.service.syncProvider(); assert.equal(first.inserted, 1);
  assert.equal((await f.repo.get('outreach_messages', id)).status, 'sent');
  assert.equal((await f.service.syncProvider()).inserted, 0);
});
test('unrelated provider event cannot attach to an uncertain attempt; hard bounce suppresses address', async () => {
  const f = await fixture(); const id = await f.ready(); await f.service.sendOne({ messageId: id, execute: true });
  const message = await f.repo.get('outreach_messages', id);
  f.provider.events = async () => [
    { messageId: '<other@test.invalid>', email: message.target_address, date: '2026-09-10T10:00:00Z', event: 'opened' },
    { messageId: message.provider_message_id, email: message.target_address, date: '2026-09-10T10:00:00Z', event: 'hardBounce' },
  ];
  assert.equal((await f.service.syncProvider()).inserted, 1);
  assert.equal((await f.repo.get('contacts', 'ct1')).do_not_contact, true);
  assert.equal((await f.repo.list('outreach_suppressions')).length, 1);
});
test('subject reports keep response windows comparable and dedupe outcomes', async () => {
  const f = await fixture(); const id = await f.ready(); await f.service.sendOne({ messageId: id, execute: true });
  const outcome = { messageId: id, type: 'reply_positive', occurredAt: '2026-09-10T10:00:00Z', sourceId: 'reply-1', source: 'manual', note: 'Interesse' };
  assert.equal((await f.service.recordOutcome(outcome)).inserted, true);
  assert.equal((await f.service.recordOutcome(outcome)).inserted, false);
  let group = (await f.service.report(f.experiment.$id)).variants.find(v => v.providerAccepted);
  assert.equal(group.positiveRate, null); assert.equal(group.pendingResponseWindow, 1);
  f.time('2026-09-18T10:00:00Z'); group = (await f.service.report(f.experiment.$id)).variants.find(v => v.providerAccepted);
  assert.equal(group.matureCompanies, 1); assert.equal(group.positiveWithinWindow, 1); assert.equal(group.positiveRate, 1);
});
test('reply import needs exact message references plus matching parties; auto reply is separate', async () => {
  const f = await fixture(); const id = await f.ready(); await f.service.sendOne({ messageId: id, execute: true });
  const message = await f.repo.get('outreach_messages', id);
  const eml = (from, auto = '') => Buffer.from(`From: ${from}\r\nTo: reply@example.invalid\r\nDate: Thu, 10 Sep 2026 10:00:00 +0000\r\nMessage-ID: <reply-${auto ? 'auto' : 'human'}@example.invalid>\r\nIn-Reply-To: ${message.provider_message_id}\r\n${auto}Subject: Re: Test\r\n\r\nHallo, bitte mehr Informationen.`);
  assert.equal((await importReply({ service: f.service, source: eml('someone@example.invalid'), origin: 'manual' })).matched, false);
  assert.equal((await importReply({ service: f.service, source: eml(message.target_address), origin: 'manual' })).type, 'reply_received');
  assert.equal((await importReply({ service: f.service, source: eml(message.target_address, 'Auto-Submitted: auto-replied\r\n'), origin: 'manual' })).type, 'auto_reply');
  const report = await f.service.report(f.experiment.$id); assert.equal(report.variants.reduce((n, v) => n + v.replies, 0), 1);
});
test('IMAP missing credentials does not connect; UIDVALIDITY change stops without cursor loss', async () => {
  const f = await fixture(); let connected = false;
  await assert.rejects(() => syncReplies({ service: f.service, env: {}, clientFactory: () => { connected = true; } })); assert.equal(connected, false);
  const stateId = identity('syn', 'imap.hostinger.com', 'reply@example.invalid', 'INBOX');
  await f.repo.create('outreach_sync_state', stateId, { state_json: JSON.stringify({ lastUid: 80, uidValidity: 'old' }) });
  let readOnly = false;
  const fake = { connect: async () => {}, getMailboxLock: async (folder, options) => { readOnly = options.readOnly; return { release() {} }; },
    mailbox: { uidValidity: 'new' }, logout: async () => {} };
  await assert.rejects(() => syncReplies({ service: f.service, env: { OUTREACH_IMAP_HOST: 'imap.hostinger.com', OUTREACH_IMAP_USER: 'reply@example.invalid', OUTREACH_IMAP_PASSWORD: 'test' }, clientFactory: () => fake }), /UIDVALIDITY/);
  assert.equal(readOnly, true); assert.equal(JSON.parse((await f.repo.get('outreach_sync_state', stateId)).state_json).lastUid, 80);
});
test('Brevo adapter pins origin, prevents redirect/retry and sanitizes provider errors', async () => {
  const calls = []; const secret = 'private-test-key';
  const provider = new BrevoProvider({ env: { BREVO_API_KEY: secret }, fetchImpl: async (url, options) => { calls.push({ url, options }); return { ok: false, status: 503, json: async () => ({ secret }) }; } });
  await assert.rejects(() => provider.send({ sender: { email: 'from@example.org', name: 'Test' }, to: 'to@example.org', replyTo: 'reply@example.org', subject: 'Test', body: 'Test' }, 'attempt'), error => error.uncertain === true && !error.message.includes(secret));
  assert.equal(calls.length, 1); assert.equal(calls[0].url, 'https://api.brevo.com/v3/smtp/email'); assert.equal(calls[0].options.redirect, 'error');
});
test('shared filesystem lock prevents simultaneous send workers', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'outreach-lock-')); let release;
  try {
    const first = withOutreachLock(() => new Promise(resolve => { release = resolve; }), folder);
    while (!release) await new Promise(resolve => setImmediate(resolve));
    await assert.rejects(() => withOutreachLock(async () => {}, folder), /Operation/);
    release(); await first; assert.equal(await withOutreachLock(async () => 'ready', folder), 'ready');
  } finally {
    assert.ok(resolve(folder).startsWith(resolve(tmpdir()) + sep) && basename(folder).startsWith('outreach-lock-'));
    await rm(folder, { recursive: true, force: true });
  }
});
test('local HTTP API requires bearer authentication and rejects foreign browser origins', async () => {
  const f = await fixture(); const token = 'a'.repeat(64); const server = createApi({ service: f.service, repo: f.repo, env: {}, token });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(base + '/v1/status')).status, 401);
    assert.equal((await fetch(base + '/v1/status', { headers: { authorization: `Bearer ${token}`, origin: 'https://unrelated.example' } })).status, 403);
    const response = await fetch(base + '/v1/status', { headers: { authorization: `Bearer ${token}` } }); assert.equal(response.status, 200);
    assert.equal((await response.json()).config.sendEnabled, false);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('another experiment cannot start a second first contact for an already approved company', async () => {
  const f = await fixture(); await f.ready();
  const definition = spec(); definition.version = '2';
  const next = await f.service.createExperiment({ clientId: 'own', campaignId: 'camp', definition });
  const enrollment = await f.service.enroll({ experimentId: next.$id, assessmentId: 'as1', contactId: 'ct1' });
  await assert.rejects(() => f.service.approve({ messageId: enrollment.message_id, contentHash: enrollment.content_hash, approvedBy: 'Test' }), /Erstansprache/);
  assert.equal(f.provider.sent.length, 0);
});

test('withdrawn qualification prevents sending even after content approval', async () => {
  const f = await fixture(); const messageId = await f.ready();
  await f.repo.update('assessments', 'as1', { status: 'needs_review' });
  await assert.rejects(() => f.service.sendOne({ messageId, execute: true }), /nicht mehr qualifiziert/);
  assert.equal((await f.repo.list('outreach_attempts')).length, 0); assert.equal(f.provider.sent.length, 0);
});

test('lost database acknowledgement after provider acceptance still prevents another send', async () => {
  const f = await fixture(); const messageId = await f.ready();
  const transaction = f.repo.transaction.bind(f.repo);
  f.repo.transaction = async ops => {
    if (ops.some(op => op.table === 'outreach_attempts' && op.data.status === 'accepted')) throw new Error('Database unavailable');
    return transaction(ops);
  };
  await assert.rejects(() => f.service.sendOne({ messageId, execute: true }), /Database/);
  assert.equal((await f.repo.list('outreach_attempts'))[0].status, 'reserved');
  await assert.rejects(() => f.service.sendOne({ messageId, execute: true }));
  assert.equal(f.provider.sent.length, 1);
});

test('late replies do not improve the fixed-window test and conflicting replay cannot change history', async () => {
  const f = await fixture(); const messageId = await f.ready(); await f.service.sendOne({ messageId, execute: true });
  f.time('2026-09-18T10:00:00Z');
  const outcome = { messageId, type: 'reply_positive', occurredAt: '2026-09-18T10:00:00Z', sourceId: 'late', source: 'manual', note: 'Interesse' };
  await f.service.recordOutcome(outcome);
  await assert.rejects(() => f.service.recordOutcome({ ...outcome, note: 'Changed' }), /Historie/);
  const group = (await f.service.report(f.experiment.$id)).variants.find(v => v.providerAccepted);
  assert.equal(group.positiveWithinWindow, 0); assert.equal(group.replies, 1);
});

test('IMAP fetches only matched reply bodies, persists oversized review and replays after failure', async () => {
  const f = await fixture(); const messageId = await f.ready(); await f.service.sendOne({ messageId, execute: true });
  const message = await f.repo.get('outreach_messages', messageId);
  const header = (uid, from = message.target_address) => Buffer.from(`From: ${from}\r\nTo: reply@example.invalid\r\nDate: Thu, 10 Sep 2026 10:00:00 +0000\r\nMessage-ID: <imap-${uid}@example.invalid>\r\nIn-Reply-To: ${message.provider_message_id}\r\nSubject: Antwort\r\n\r\n`);
  const fetchedBodies = []; let fail = true; let readOnly = false;
  const fake = { mailbox: { uidValidity: 7n, uidNext: 4 }, connect: async () => {}, logout: async () => {},
    getMailboxLock: async (folder, options) => { readOnly = options.readOnly; return { release() {} }; },
    search: async () => [1, 2, 3], fetchOne: async (uid, query) => {
      if (query.source) {
        fetchedBodies.push(Number(uid)); if (fail) throw new Error('disconnected');
        return { source: Buffer.concat([header(uid), Buffer.from('Gerne sprechen wir.')]) };
      }
      return { headers: header(uid, uid === '1' ? 'unrelated@example.invalid' : message.target_address), size: uid === '3' ? 500000 : 500, internalDate: new Date('2026-09-10T10:00:00Z') };
    } };
  const env = { OUTREACH_IMAP_HOST: 'imap.hostinger.com', OUTREACH_IMAP_USER: 'reply@example.invalid', OUTREACH_IMAP_PASSWORD: 'test' };
  const args = { service: f.service, env, clientFactory: () => fake };
  const stateId = identity('syn', 'imap.hostinger.com', env.OUTREACH_IMAP_USER, 'INBOX');
  await assert.rejects(() => syncReplies(args), /nicht abgeschlossen/);
  assert.equal(await f.repo.get('outreach_sync_state', stateId), null);
  fail = false; const result = await syncReplies(args);
  assert.equal(readOnly, true); assert.equal(result.matched, 1); assert.equal(result.oversized, 1);
  assert.deepEqual(fetchedBodies, [2, 2]);
  assert.equal(JSON.parse((await f.repo.get('outreach_sync_state', stateId)).state_json).lastUid, 3);
  assert.equal((await f.repo.list('outreach_events')).filter(e => e.event_type === 'review_note').length, 1);
  assert.equal((await syncReplies(args)).scanned, 0);
});

test('worker synchronizes first, stops before sending on sync failure, and respects ordinary time windows', async () => {
  const f = await fixture(); await f.ready(); let sent = 0;
  f.service.sendOne = async () => { sent++; return {}; };
  const env = { ...demoEnv, BREVO_API_KEY: 'test', OUTREACH_SEND_ENABLED: 'true', OUTREACH_IMAP_USER: 'reply@example.invalid', OUTREACH_IMAP_PASSWORD: 'test' };
  await assert.rejects(() => workerCycle({ service: f.service, env, execute: true, replySync: async () => { throw new Error('Inbox unavailable'); } }), /Inbox/);
  assert.equal(sent, 0);
  f.time('2026-09-10T22:00:00Z');
  const result = await workerCycle({ service: f.service, env, execute: true, replySync: async () => ({ matched: 0 }) });
  assert.match(result.send.skipped, /Versandfenster/); assert.equal(sent, 0);
  f.time('2026-09-11T10:00:00Z');
  await workerCycle({ service: f.service, env, execute: true, replySync: async () => ({ matched: 0 }) }); assert.equal(sent, 1);
});

test('demo rejects live transport; Brevo event filters encode tags and accept an empty report', async () => {
  const f = await fixture(); const messageId = await f.ready();
  f.service.provider = { name: 'brevo', send: () => { throw new Error('Must never reach transport'); } };
  await assert.rejects(() => f.service.sendOne({ messageId, execute: true }), /Demo-Datenbank/);
  let requested;
  const provider = new BrevoProvider({ env: { BREVO_API_KEY: 'test' }, fetchImpl: async url => { requested = new URL(url); return { ok: true, json: async () => ({}) }; } });
  assert.deepEqual(await provider.events({ tag: 'attempt', days: 90 }), []);
  assert.deepEqual(JSON.parse(requested.searchParams.get('tags')), ['attempt']);
  assert.equal(requested.searchParams.get('days'), '90');
});
