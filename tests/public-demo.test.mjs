import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryRepository } from '../src/outreach/memory.mjs';
import { runDemo, DemoProvider, demoEnv } from '../src/outreach/demo.mjs';
import { OutreachService } from '../src/outreach/service.mjs';
import { DashboardData } from '../src/operations/dashboard.mjs';
import { initializeDatabase } from '../scripts/init-appwrite.mjs';

test('public demo exercises the real service and dashboard without any provider or database network access', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('Demo must not access network'); };
  try {
    const repo = new MemoryRepository();
    const result = await runDemo(repo);
    assert.equal(result.emailsSentOverNetwork, 0);
    assert.equal(result.simulatedThisRun, 4);
    assert.equal((await repo.get('outreach_controls', 'default')).paused, true);
    assert.equal((await repo.list('companies')).length, 4);
    assert.ok((await repo.list('contacts')).every(contact => contact.email.endsWith('@example.invalid')));
    const service = new OutreachService({ repo, provider: new DemoProvider(), env: demoEnv });
    const dashboard = new DashboardData(service);
    assert.ok(await dashboard.inventory());
    assert.equal((await new MemoryRepository().list('companies')).length, 0);
  } finally { globalThis.fetch = originalFetch; }
});

test('database setup only creates missing schema and keeps existing controls paused', async () => {
  const repo = new MemoryRepository();
  repo.connect = async () => repo;
  const result = await initializeDatabase(repo);
  assert.equal(result.paused, true);
  assert.deepEqual(result.created, []);
  const originalCall = repo.call.bind(repo);
  repo.call = async (method, args, write) => {
    const value = await originalCall(method, args, write);
    if (method === 'list_tables') value.tables[0].$permissions = ['read("any")'];
    return value;
  };
  await assert.rejects(() => initializeDatabase(repo), /Tabellenrechte/);
});
