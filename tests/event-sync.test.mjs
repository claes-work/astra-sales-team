import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep, basename } from 'node:path';
import { BrevoEventSource, EventSynchronizer, EventSyncStore, eventSyncConfig, eventSyncHealth } from '../src/outreach/event-sync.mjs';
import { OutreachService } from '../src/outreach/service.mjs';
import { ProviderError } from '../src/outreach/brevo.mjs';

class MemoryRepo {
  constructor() { this.database = 'lead-research-demo'; this.rows = new Map(); }
  async list(table) { return [...this.rows].filter(([k]) => k.startsWith(table + '/')).map(([, row]) => structuredClone(row)); }
  async get(table, id) { return structuredClone(this.rows.get(`${table}/${id}`) ?? null); }
  async create(table, id, data) {
    if (this.rows.has(`${table}/${id}`)) throw new Error('Duplicate');
    this.rows.set(`${table}/${id}`, { $id: id, ...structuredClone(data) }); return this.get(table, id);
  }
  async update(table, id, data) {
    const row = await this.get(table, id); if (!row) throw new Error('Missing');
    this.rows.set(`${table}/${id}`, { ...row, ...structuredClone(data) }); return this.get(table, id);
  }
  async transaction(ops) { for (const op of ops) await this[op.action](op.table, op.id, op.data); }
}

async function fixture(t, count = 1) {
  const directory = await mkdtemp(join(tmpdir(), 'sales-event-sync-'));
  t.after(async () => {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep) && basename(directory).startsWith('sales-event-sync-'));
    await rm(directory, { recursive: true, force: true });
  });
  const config = { ...eventSyncConfig({}), stateDir: directory, batchSize: 2, intervalSeconds: 30 };
  const store = new EventSyncStore(directory);
  const state = await store.load(config.target);
  const repo = new MemoryRepo();
  let now = Date.parse('2026-09-12T10:00:00Z');
  const seen = [], logs = [], events = [];
  const provider = { name: 'brevo', events: async ({ tag }) => { seen.push(tag); return events.filter(e => e.tag === tag); },
    send: () => { throw new Error('SENDING IS FORBIDDEN'); } };
  await repo.create('outreach_controls', 'default', { paused: false });
  for (let i = 0; i < count; i++) {
    await repo.create('contacts', `ct${i}`, { do_not_contact: false });
    await repo.create('outreach_messages', `msg${i}`, { client_id: 'own', contact_id: `ct${i}`, target_address: `test${i}@example.invalid`, status: 'sent' });
    await repo.create('outreach_attempts', `att${i}`, { message_id: `msg${i}`, attempted_at: '2026-01-01T10:00:00Z', status: 'accepted',
      provider_message_id: `<${i}@example.invalid>`, details_json: '{}' });
  }
  const service = new OutreachService({ repo, provider, env: { OUTREACH_SEND_ENABLED: 'true' }, now: () => new Date(now), lock: work => work() });
  const connect = async () => ({ service, close: async () => {} });
  const runner = new EventSynchronizer({ store, state, config, connect, now: () => now, log: value => logs.push(value) });
  return { directory, config, store, state, repo, service, provider, runner, seen, logs, events,
    time: () => now, advance: (seconds = 30) => { now += seconds * 1000; },
    event: (index, event = 'delivered') => ({ messageId: `<${index}@example.invalid>`, email: `test${index}@example.invalid`, tag: `att${index}`, date: new Date(now).toISOString(), event }) };
}

test('sync-only adapter rejects send and all non-event paths before fetch, even with send flag', async () => {
  let calls = 0;
  const provider = new BrevoEventSource({ env: { BREVO_API_KEY: 'not-a-real-key', OUTREACH_SEND_ENABLED: 'true' },
    fetchImpl: async () => { calls++; return { ok: true, json: async () => ({ events: [] }) }; } });
  await assert.rejects(() => provider.request('/smtp/email', { method: 'POST' }), /ausschließlich/);
  await assert.rejects(() => provider.request('/senders'), /ausschließlich/);
  await assert.rejects(() => provider.send({ sender: {}, to: 'x@example.invalid', subject: 'x', body: 'x' }, 'attempt'), /ausschließlich/);
  assert.equal(calls, 0);
  assert.deepEqual(await provider.events({ messageId: '<known@example.invalid>', days: 90 }), []);
  assert.equal(calls, 1);
});

test('targeted import sees late events for old messages, deduplicates and applies complaint suppression', async t => {
  const f = await fixture(t);
  f.events.push(f.event(0, 'spam'));
  // Historical single-shot default remains unchanged for the live pilot.
  assert.equal((await f.service.syncProvider()).outsideApiWindow, 1);
  assert.equal((await f.runner.cycle()).inserted, 1);
  assert.equal((await f.repo.get('contacts', 'ct0')).do_not_contact, true);
  assert.equal((await f.repo.get('outreach_controls', 'default')).paused, true);
  f.advance();
  assert.equal((await f.runner.cycle()).inserted, 0);
  assert.equal((await f.repo.list('outreach_events')).length, 1);
  assert.equal((await f.repo.list('outreach_suppressions')).length, 1);
  assert.equal((await f.repo.list('outreach_attempts')).length, 1);
});

test('batches cover every attempt; poison row does not starve newer rows; restart resumes persisted scheduling', async t => {
  const f = await fixture(t, 5);
  const original = f.provider.events;
  f.provider.events = async input => { if (input.tag === 'att0') { f.seen.push(input.tag); throw new Error('secret/customer@example.invalid'); } return original(input); };
  const first = await f.runner.cycle(); assert.equal(first.failed, 1);
  f.advance(); await f.runner.cycle();
  const persisted = await f.store.load(f.config.target);
  const restarted = new EventSynchronizer({ store: new EventSyncStore(f.directory), state: persisted, config: f.config,
    connect: f.runner.connect, now: f.time, log: value => f.logs.push(value) });
  f.advance(); await restarted.cycle();
  assert.deepEqual([...new Set(f.seen)].sort(), ['att0', 'att1', 'att2', 'att3', 'att4']);
  assert.equal(persisted.attempts.att0.failures, 2);
  assert.equal(eventSyncHealth(persisted, f.config, f.time()).status, 'degraded');
  assert.ok(!JSON.stringify(f.logs).includes('customer@') && !JSON.stringify(persisted).includes('secret'));
});

test('missing cursor replays safely and recovers durable history without duplicate events', async t => {
  const f = await fixture(t); f.events.push(f.event(0, 'clicks'));
  await f.runner.cycle();
  const blank = { schemaVersion: 1, target: f.config.target, attempts: {}, cycleCount: 0, totalChecked: 0, totalInserted: 0, consecutiveFailures: 0 };
  const restarted = new EventSynchronizer({ store: f.store, state: blank, config: f.config, connect: f.runner.connect, now: f.time, log: () => {} });
  assert.equal((await restarted.cycle()).inserted, 0);
  assert.equal((await f.repo.list('outreach_events')).length, 1);
});

test('failure after durable event but before suppression completion does not advance successful cursor; retry completes suppression', async t => {
  const f = await fixture(t); f.events.push(f.event(0, 'hardBounce'));
  const original = f.repo.update.bind(f.repo);
  let fail = true;
  f.repo.update = async (table, id, data) => { if (table === 'contacts' && fail) throw new Error('Database outage'); return original(table, id, data); };
  assert.equal((await f.runner.cycle()).failed, 1);
  assert.equal((await f.repo.list('outreach_events')).length, 1);
  assert.equal(f.state.attempts.att0.lastSuccessAt, undefined);
  assert.equal(JSON.parse((await f.repo.get('outreach_attempts', 'att0')).details_json).lastSyncAt, undefined);
  fail = false; f.advance();
  assert.equal((await f.runner.cycle()).checked, 1);
  assert.equal((await f.repo.get('contacts', 'ct0')).do_not_contact, true);
  assert.equal((await f.repo.list('outreach_events')).length, 1);
  assert.equal(f.state.attempts.att0.failures, 0);
});

test('provider 429 stops extra requests in cycle and persists bounded exponential backoff', async t => {
  const f = await fixture(t, 3);
  let calls = 0;
  f.provider.events = async () => { calls++; throw new ProviderError('raw forbidden body', false, 429); };
  await f.runner.cycle(); assert.equal(calls, 1);
  assert.equal(f.state.lastError.code, 'provider_rate_limit');
  assert.equal(Date.parse(f.state.nextCycleAt) - f.time(), 30000);
  f.advance(); await f.runner.cycle(); assert.equal(calls, 2);
  assert.equal(Date.parse(f.state.nextCycleAt) - f.time(), 60000);
  assert.equal(f.runner.retryDelay(99), f.config.retryMaxSeconds);
});

test('database connection failure is retried with fresh connection and successful empty scan is healthy', async t => {
  const f = await fixture(t, 0); let calls = 0;
  f.runner.connect = async () => { calls++; if (calls === 1) throw new Error('DB unavailable'); return { service: f.service, close: async () => {} }; };
  await f.runner.cycle(); assert.equal(f.state.lastSuccessfulScanAt, undefined);
  f.advance(); await f.runner.cycle();
  assert.equal(calls, 2);
  assert.equal(eventSyncHealth(f.state, f.config, f.time()).status, 'healthy');
});

test('invalid pagination never reports full success or advances Appwrite cursor', async t => {
  const f = await fixture(t);
  let calls = 0;
  f.service.provider = new BrevoEventSource({ env: { BREVO_API_KEY: 'test' }, fetchImpl: async () => {
    calls++; return { ok: true, json: async () => calls === 1 ? { events: Array.from({ length: 100 }, () => f.event(0)) } : { events: null } };
  } });
  assert.equal((await f.runner.cycle()).failed, 1);
  assert.equal(calls, 2);
  assert.equal((await f.repo.list('outreach_events')).length, 0);
  assert.equal(f.state.attempts.att0.lastSuccessAt, undefined);
});

test('event pagination follows offsets until complete before import', async () => {
  const offsets = [];
  const provider = new BrevoEventSource({ env: { BREVO_API_KEY: 'test' }, fetchImpl: async url => {
    const offset = Number(new URL(url).searchParams.get('offset')); offsets.push(offset);
    return { ok: true, json: async () => ({ events: Array.from({ length: offset === 0 ? 100 : 2 }, (_, i) => ({ id: offset + i })) }) };
  } });
  assert.equal((await provider.events({ messageId: 'known', days: 90 })).length, 102);
  assert.deepEqual(offsets, [0, 100]);
});

test('health marks missing, stopped and stale processes; successful partial work cannot hide a failed attempt', async t => {
  const f = await fixture(t);
  assert.equal(eventSyncHealth(f.state, f.config, f.time()).status, 'starting');
  await f.runner.cycle(); assert.equal(eventSyncHealth(f.state, f.config, f.time()).ok, true);
  f.advance(1000); assert.equal(eventSyncHealth(f.state, f.config, f.time()).status, 'stale_heartbeat');
  f.state.heartbeatAt = new Date(f.time()).toISOString(); f.advance(9000); f.state.heartbeatAt = new Date(f.time()).toISOString();
  assert.equal(eventSyncHealth(f.state, f.config, f.time()).status, 'stale_sync');
  f.state.status = 'stopped'; assert.equal(eventSyncHealth(f.state, f.config, f.time()).status, 'stopped');
});

test('atomic store serializes writes, binds target and rejects corrupt state instead of silently resetting', async t => {
  const f = await fixture(t);
  await Promise.all([f.store.save({ ...f.state, marker: 1 }), f.store.save({ ...f.state, marker: 2 })]);
  assert.equal((await f.store.load(f.config.target)).marker, 2);
  await assert.rejects(() => f.store.load('wrong-target'), /Datenbankziel/);
  await writeFile(f.store.path, '{broken');
  await assert.rejects(() => f.store.load(f.config.target), /Rücksetzung/);
});

test('storage failure stops process; no progress is acknowledged after failed checkpoint', async t => {
  const f = await fixture(t);
  f.store.save = async () => { throw new Error('disk full'); };
  await assert.rejects(() => f.runner.cycle(), /disk full/);
  assert.deepEqual(f.seen, []);
});

test('explicit attempt selection rejects invalid IDs and does not silently scan other attempts', async t => {
  const f = await fixture(t, 2);
  await assert.rejects(() => f.service.syncProvider({ attemptIds: ['att0', 'att0'] }), /eindeutige/);
  await assert.rejects(() => f.service.syncProvider({ attemptIds: ['../escape'] }), /eindeutige/);
  await f.service.syncProvider({ attemptIds: ['att1'], maxMessages: 1 });
  assert.deepEqual(f.seen, ['att1']);
});

test('run once finishes with stopped status, unchanged sending controls and no attempts created', async t => {
  const f = await fixture(t);
  await f.runner.run({ once: true });
  const state = JSON.parse(await readFile(f.store.path, 'utf8'));
  assert.equal(state.status, 'stopped'); assert.equal(state.totalChecked, 1);
  assert.equal((await f.repo.get('outreach_controls', 'default')).paused, false);
  assert.equal((await f.repo.list('outreach_attempts')).length, 1);
});

test('supervised run heartbeats, stops on signal, and restarts without a second event or send', async t => {
  const f = await fixture(t); f.events.push(f.event(0));
  const controller = new AbortController();
  f.runner.log = () => controller.abort();
  await f.runner.run({ signal: controller.signal });
  const first = await f.store.load(f.config.target);
  assert.equal(first.status, 'stopped'); assert.equal(first.totalChecked, 1);
  f.advance();
  const restored = await new EventSyncStore(f.directory).load(f.config.target);
  const next = new EventSynchronizer({ store: f.store, state: restored, config: f.config, connect: f.runner.connect, now: f.time, log: () => {} });
  await next.run({ once: true });
  assert.notEqual(restored.instanceId, first.instanceId);
  assert.equal(restored.totalChecked, 2);
  assert.equal((await f.repo.list('outreach_events')).length, 1);
  assert.equal((await f.repo.list('outreach_attempts')).length, 1);
});

test('a failure followed by recovery clears degraded health and keeps previous success history', async t => {
  const f = await fixture(t);
  await f.runner.cycle(); const success = f.state.attempts.att0.lastSuccessAt;
  const original = f.provider.events;
  f.provider.events = async () => { throw new Error('outage'); };
  f.advance(); await f.runner.cycle();
  assert.equal(f.state.attempts.att0.lastSuccessAt, success);
  assert.equal(eventSyncHealth(f.state, f.config, f.time()).status, 'degraded');
  f.provider.events = original; f.advance(); await f.runner.cycle();
  assert.equal(eventSyncHealth(f.state, f.config, f.time()).status, 'healthy');
  assert.equal(f.state.lastError, null);
});
