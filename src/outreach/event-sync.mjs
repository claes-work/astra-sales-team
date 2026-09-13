import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { LocalAppwrite, LIVE_DB } from './appwrite.mjs';
import { BrevoProvider, loadOutreachEnv } from './brevo.mjs';
import { OutreachService } from './service.mjs';
import { withProcessLock } from './process-lock.mjs';

const statuses = new Set(['reserved', 'accepted', 'unknown']);
const iso = value => new Date(value).toISOString();
const timestamp = value => Number.isFinite(Date.parse(value)) ? Date.parse(value) : 0;
const root = fileURLToPath(new URL('../../', import.meta.url));

export class BrevoEventSource extends BrevoProvider {
  async request(path, options = {}) {
    // Even a programming error or OUTREACH_SEND_ENABLED=true cannot send mail
    // with this adapter. This process has no provider mutation capability.
    if ((options.method ?? 'GET') !== 'GET' || !path.startsWith('/smtp/statistics/events?'))
      throw new Error('Ereignisimport erlaubt ausschließlich lesende Ereignisabfragen.');
    return super.request(path, options);
  }
}

function integer(env, key, fallback, min, max) {
  const value = env[key] === undefined ? fallback : Number(env[key]);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Ungültige Einstellung ${key}.`);
  return value;
}

export function eventSyncConfig(env = process.env) {
  return {
    stateDir: resolve(env.OUTREACH_EVENT_SYNC_STATE_DIR || join(root, '.local/event-sync')),
    intervalSeconds: integer(env, 'OUTREACH_EVENT_SYNC_INTERVAL_SECONDS', 180, 30, 3600),
    batchSize: integer(env, 'OUTREACH_EVENT_SYNC_BATCH_SIZE', 50, 1, 100),
    retryMaxSeconds: integer(env, 'OUTREACH_EVENT_SYNC_RETRY_MAX_SECONDS', 3600, 60, 86400),
    staleSeconds: integer(env, 'OUTREACH_EVENT_SYNC_STALE_SECONDS', 7200, 60, 172800),
    heartbeatSeconds: 15,
    target: createHash('sha256').update(JSON.stringify([env.APPWRITE_ENDPOINT || 'http://127.0.0.1:8088/v1',
      env.APPWRITE_PROJECT_ID || 'lead-research', LIVE_DB])).digest('hex'),
  };
}

export function safeSyncError(error, now = Date.now()) {
  const status = Number.isInteger(error?.status) ? error.status : null;
  return { code: status === 429 ? 'provider_rate_limit' : [401, 403].includes(status) ? 'provider_authentication'
    : status ? 'provider_http_failure' : 'sync_failed', ...(status ? { status } : {}), at: iso(now) };
}

export class EventSyncStore {
  constructor(directory) { this.directory = directory; this.path = join(directory, 'state.json'); this.queue = Promise.resolve(); }
  async load(target) {
    let state;
    try { state = JSON.parse(await readFile(this.path, 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw new Error('Ereignisimport-Zustand nicht lesbar; keine automatische Rücksetzung.');
      return { schemaVersion: 1, target, attempts: {}, cycleCount: 0, totalChecked: 0, totalInserted: 0, consecutiveFailures: 0 };
    }
    if (state.schemaVersion !== 1 || state.target !== target || !state.attempts || typeof state.attempts !== 'object' || Array.isArray(state.attempts)
      || ['cycleCount', 'totalChecked', 'totalInserted', 'consecutiveFailures'].some(key => !Number.isSafeInteger(state[key]) || state[key] < 0)
      || Object.entries(state.attempts).some(([id, value]) => !/^[\w.-]{1,36}$/.test(id) || !value || typeof value !== 'object'
        || !Number.isSafeInteger(value.failures) || value.failures < 0
        || ['lastCheckedAt', 'lastSuccessAt', 'nextAttemptAt'].some(key => value[key] !== undefined && !timestamp(value[key]))))
      throw new Error('Ereignisimport-Zustand passt nicht zum Datenbankziel.');
    return state;
  }
  save(state) {
    const payload = JSON.stringify(state, null, 2) + '\n';
    // Serialize heartbeat/checkpoint writes. fsync and same-volume rename prevent
    // readers seeing a partial cursor; any write failure is fatal to this worker.
    this.queue = this.queue.then(async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const temporary = join(this.directory, `state.${process.pid}.tmp`);
      const handle = await open(temporary, 'w', 0o600);
      try { await handle.writeFile(payload); await handle.sync(); } finally { await handle.close(); }
      await rename(temporary, this.path);
      if (process.platform !== 'win32') {
        const folder = await open(this.directory, 'r');
        try { await folder.sync(); } finally { await folder.close(); }
      }
    });
    return this.queue;
  }
}

export function eventSyncHealth(state, config, now = Date.now()) {
  const heartbeatAge = Math.max(0, now - timestamp(state?.heartbeatAt));
  const successfulAge = Math.max(0, now - timestamp(state?.lastSuccessfulScanAt));
  const failedAttempts = Object.values(state?.attempts || {}).filter(a => a.failures > 0).length;
  const status = !state?.lastSuccessfulScanAt ? 'starting' : ['stopped', 'fatal'].includes(state.status) ? state.status
    : heartbeatAge > Math.max(60, config.intervalSeconds * 2) * 1000 ? 'stale_heartbeat'
    : successfulAge > config.staleSeconds * 1000 ? 'stale_sync'
    : failedAttempts || state.consecutiveFailures ? 'degraded' : 'healthy';
  return { ok: status === 'healthy', mode: 'sync_only', status, lastSuccessfulScanAt: state?.lastSuccessfulScanAt ?? null,
    lastCompleteSweepAt: state?.lastCompleteSweepAt ?? null, heartbeatAt: state?.heartbeatAt ?? null,
    failedAttempts, eligibleAttempts: state?.eligibleAttempts ?? null, remainingInSweep: state?.remainingInSweep ?? null,
    checked: state?.totalChecked ?? 0, inserted: state?.totalInserted ?? 0,
    lastError: state?.lastError ?? null, nextCycleAt: state?.nextCycleAt ?? null };
}

export class EventSynchronizer {
  constructor({ store, state, config, connect, now = () => Date.now(), log = value => console.log(JSON.stringify(value)) }) {
    Object.assign(this, { store, state, config, connect, now, log });
  }
  async checkpoint() { this.state.heartbeatAt = iso(this.now()); await this.store.save(this.state); }
  retryDelay(failures) { return Math.min(this.config.retryMaxSeconds, this.config.intervalSeconds * 2 ** Math.min(12, failures - 1)); }
  async cycle(signal) {
    const started = this.now();
    this.state.status = 'running'; this.state.lastCycleStartedAt = iso(started);
    await this.checkpoint();
    let connection, cycleFailure = null, checked = 0, inserted = 0, failed = 0;
    try {
      connection = await this.connect();
      const attempts = (await connection.service.repo.list('outreach_attempts')).filter(a => statuses.has(a.status));
      this.state.eligibleAttempts = attempts.length;
      const eligible = new Set(attempts.map(a => a.$id));
      for (const id of Object.keys(this.state.attempts)) if (!eligible.has(id)) delete this.state.attempts[id];
      // No offset cursor: new rows cannot shift a page and permanently skip an
      // attempt. Durable local retry metadata defines oldest-first order; loss
      // of this metadata causes a safe replay, never a skipped DB event.
      const due = attempts.filter(a => timestamp(this.state.attempts[a.$id]?.nextAttemptAt) <= started)
        .sort((a, b) => {
          const last = row => timestamp(this.state.attempts[row.$id]?.lastCheckedAt);
          return last(a) - last(b) || a.$id.localeCompare(b.$id);
        }).slice(0, this.config.batchSize);
      for (const attempt of due) {
        if (signal?.aborted) break;
        const old = this.state.attempts[attempt.$id] || {};
        try {
          const result = await connection.service.syncProvider({ maxMessages: 1, attemptIds: [attempt.$id] });
          if (result.checked !== 1) throw new Error('Versandversuch wurde nicht vollständig abgeglichen.');
          const time = iso(this.now());
          // Only reached after events, suppression and DB lastSyncAt are durable.
          this.state.attempts[attempt.$id] = { lastCheckedAt: time, lastSuccessAt: time,
            nextAttemptAt: iso(this.now() + this.config.intervalSeconds * 1000), failures: 0 };
          checked++; inserted += result.inserted;
          this.state.totalChecked++; this.state.totalInserted += result.inserted;
        } catch (error) {
          const failures = (old.failures || 0) + 1;
          const safe = safeSyncError(error, this.now());
          this.state.attempts[attempt.$id] = { ...old, lastCheckedAt: iso(this.now()), failures,
            nextAttemptAt: iso(this.now() + this.retryDelay(failures) * 1000), lastError: safe };
          this.state.lastError = safe;
          failed++;
          if ([401, 403, 429].includes(error?.status)) cycleFailure = safe;
        }
        await this.checkpoint();
        if (cycleFailure) break;
      }
      const sweepStart = timestamp(this.state.sweepStartedAt) || started;
      this.state.sweepStartedAt ||= iso(sweepStart);
      this.state.remainingInSweep = attempts.filter(a => timestamp(this.state.attempts[a.$id]?.lastSuccessAt) < sweepStart).length;
      if (!this.state.remainingInSweep) { this.state.lastCompleteSweepAt = iso(this.now()); this.state.sweepStartedAt = iso(this.now()); }
      if (!failed && !cycleFailure) this.state.lastSuccessfulScanAt = iso(this.now());
    } catch (error) { cycleFailure = safeSyncError(error, this.now()); }
    finally { await Promise.resolve(connection?.close?.()).catch(() => {}); }
    this.state.cycleCount++;
    this.state.lastCycleCompletedAt = iso(this.now());
    this.state.consecutiveFailures = cycleFailure ? this.state.consecutiveFailures + 1 : 0;
    if (cycleFailure) { this.state.lastError = cycleFailure; this.state.status = 'backoff'; }
    else if (!failed && !Object.values(this.state.attempts).some(a => a.failures)) this.state.lastError = null;
    const seconds = cycleFailure ? this.retryDelay(this.state.consecutiveFailures) : this.config.intervalSeconds;
    this.state.nextCycleAt = iso(this.now() + seconds * 1000);
    await this.checkpoint();
    const result = { mode: 'sync_only', cycle: this.state.cycleCount, checked, inserted, failed,
      eligibleAttempts: this.state.eligibleAttempts ?? null, nextCycleAt: this.state.nextCycleAt,
      ...(cycleFailure ? { error: cycleFailure } : {}) };
    this.log(result);
    return result;
  }
  async run({ once = false, signal } = {}) {
    this.state.instanceId = randomUUID(); this.state.startedAt = iso(this.now()); this.state.status = 'starting';
    await this.checkpoint();
    let heartbeatError;
    const heartbeatAbort = new AbortController();
    const combined = AbortSignal.any([heartbeatAbort.signal, ...(signal ? [signal] : [])]);
    const timer = setInterval(() => this.checkpoint().catch(error => { heartbeatError = error; heartbeatAbort.abort(); }), this.config.heartbeatSeconds * 1000);
    const waitUntilDue = () => delay(Math.max(0, timestamp(this.state.nextCycleAt) - this.now()), undefined, { signal: combined })
      .catch(error => { if (error.name !== 'AbortError') throw error; });
    try {
      // A restart must respect persisted provider rate-limit/auth backoff.
      if (this.state.consecutiveFailures) await waitUntilDue();
      do {
        if (heartbeatError) throw heartbeatError;
        if (combined.aborted) break;
        await this.cycle(combined);
        if (once || combined.aborted) break;
        await waitUntilDue();
      } while (!combined.aborted);
      if (heartbeatError) throw heartbeatError;
    } finally {
      clearInterval(timer);
      this.state.status = heartbeatError ? 'fatal' : 'stopped';
      await this.checkpoint();
    }
  }
}

export async function eventSyncMain(args = process.argv.slice(2)) {
  const [command = 'help'] = args;
  if (args.length > 1 || !['help', 'run', 'once', 'health'].includes(command)) throw new Error('Ereignisimport: run | once | health. Keine Versandoption.');
  if (command === 'help') { console.log('node src/outreach/event-sync.mjs run|once|health — ausschließlich Ereignisimport; docs/setup.md'); return; }
  const env = loadOutreachEnv();
  const config = eventSyncConfig(env);
  const store = new EventSyncStore(config.stateDir);
  if (command === 'health') {
    const health = eventSyncHealth(await store.load(config.target), config);
    console.log(JSON.stringify(health)); process.exitCode = health.ok ? 0 : 1; return;
  }
  if (!env.BREVO_API_KEY?.trim()) throw new Error('BREVO_API_KEY fehlt.');
  if (process.platform !== 'linux' || env.OUTREACH_LOCK_MODE !== 'flock' || !env.OUTREACH_LOCK_DIR)
    throw new Error('Dauerhafter Ereignisimport braucht Linux/flock und das gemeinsame OUTREACH_LOCK_DIR.');
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    await withProcessLock(async () => {
      const state = await store.load(config.target);
      const runner = new EventSynchronizer({ store, state, config, connect: async () => {
        const repo = await new LocalAppwrite(LIVE_DB).connect();
        return { service: new OutreachService({ repo, provider: new BrevoEventSource({ env }), env: { ...env, OUTREACH_SEND_ENABLED: 'false' } }),
          close: () => repo.close() };
      } });
      await runner.run({ once: command === 'once', signal: controller.signal });
      if (Object.values(state.attempts).some(a => a.failures) || state.consecutiveFailures) process.exitCode = 1;
    }, join(config.stateDir, 'worker.flock'), { timeoutSeconds: 0 });
  } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  eventSyncMain().catch(() => { console.error(JSON.stringify({ mode: 'sync_only', status: 'fatal', code: 'event_sync_start_or_storage_failure' })); process.exitCode = 1; });
}
